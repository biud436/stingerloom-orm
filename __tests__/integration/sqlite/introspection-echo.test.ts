/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Introspection echo: table → entity → table.
 *
 * Generates entities from a real SQLite schema (both output styles), type
 * checks the generated files, loads them, recreates the schema from them in a
 * second database, and compares the two schemas. Then it introspects the
 * recreated database and re-runs the whole loop, asserting the generator
 * reaches a fixed point — generation N and N+1 must be byte-identical, which
 * is what makes "generate entities, then let synchronize own the schema" safe
 * to repeat.
 *
 * SQLite erases some declared types (DATETIME and BOOLEAN both come back as
 * the affinity this ORM emits: TEXT / INTEGER), so the first generation is
 * compared by storage affinity and the byte-identity claim starts at the
 * second generation. See docs/introspection.md.
 */
import "reflect-metadata";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as ts from "typescript";
import { DatabaseClient } from "../../../src/DatabaseClient";
import { EntityManager } from "../../../src/core/EntityManager";
import { runIntrospect } from "../../../src/introspection/IntrospectionCli";
import type { EntityCodeStyle } from "../../../src/introspection/EntityCodeBuilder";

const SRC_INDEX = resolve(__dirname, "../../../src/index");

const SOURCE_DDL = [
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY,
     email VARCHAR(255) NOT NULL,
     nickname VARCHAR(50),
     age INTEGER NOT NULL DEFAULT 0,
     score REAL,
     bio TEXT,
     avatar BLOB
   )`,
  `CREATE UNIQUE INDEX uq_users_email ON users(email)`,
  `CREATE INDEX idx_users_nickname ON users(nickname)`,
  `CREATE TABLE posts (
     id INTEGER PRIMARY KEY,
     title VARCHAR(200) NOT NULL,
     views INTEGER NOT NULL DEFAULT 0,
     author_id INTEGER NOT NULL,
     reviewer_id INTEGER,
     FOREIGN KEY (author_id) REFERENCES users(id),
     FOREIGN KEY (reviewer_id) REFERENCES users(id)
   )`,
  `CREATE INDEX idx_posts_title_views ON posts(title, views)`,
  `CREATE TABLE comments (
     id INTEGER PRIMARY KEY,
     body TEXT NOT NULL,
     parent_id INTEGER,
     FOREIGN KEY (parent_id) REFERENCES comments(id)
   )`,
];

interface TableSnapshot {
  columns: Array<{
    name: string;
    affinity: string;
    notnull: boolean;
    pk: number;
    dflt: string | null;
  }>;
  fks: Array<{ from: string; table: string; to: string }>;
  indexes: Array<{ unique: boolean; columns: string[] }>;
}

/**
 * SQLite's declared-type → storage-affinity rules. The echo can only be held
 * to the affinity, because that is all SQLite itself preserves.
 */
function affinityOf(declaredType: string): string {
  const t = (declaredType || "").toUpperCase();
  if (t.includes("INT")) return "INTEGER";
  if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT")) return "TEXT";
  if (t.includes("BLOB") || t === "") return "BLOB";
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB")) return "REAL";
  return "NUMERIC";
}

/** Normalizes the handful of literal spellings SQLite accepts for a default. */
function normalizeDefault(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim().replace(/^'(.*)'$/s, "$1");
  const upper = raw.toUpperCase();
  if (upper === "TRUE") return "1";
  if (upper === "FALSE") return "0";
  return raw;
}

async function snapshot(dbFile: string): Promise<Record<string, TableSnapshot>> {
  const client = DatabaseClient.getInstance();
  const connector = await client.connect({
    type: "sqlite",
    database: dbFile,
    logging: false,
  } as any);
  const tables = (await connector.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )) as any[];

  const out: Record<string, TableSnapshot> = {};
  for (const { name } of tables) {
    const cols = (await connector.query(`PRAGMA table_info("${name}")`)) as any[];
    const fks = (await connector.query(`PRAGMA foreign_key_list("${name}")`)) as any[];
    const indexList = (await connector.query(`PRAGMA index_list("${name}")`)) as any[];

    const indexes: TableSnapshot["indexes"] = [];
    for (const idx of indexList) {
      if ((idx.origin ?? "") === "pk") continue;
      const info = (await connector.query(
        `PRAGMA index_info("${idx.name}")`,
      )) as any[];
      indexes.push({
        unique: Number(idx.unique) === 1,
        columns: info
          .sort((a, b) => Number(a.seqno) - Number(b.seqno))
          .map((r) => r.name),
      });
    }

    out[name] = {
      columns: cols.map((c) => ({
        name: c.name,
        affinity: affinityOf(c.type),
        // A rowid-alias PK is implicitly NOT NULL whatever the pragma says.
        notnull: !!c.notnull || Number(c.pk) > 0,
        pk: Number(c.pk),
        dflt: normalizeDefault(c.dflt_value),
      })),
      fks: fks
        .map((f) => ({ from: f.from, table: f.table, to: f.to }))
        .sort((a, b) => a.from.localeCompare(b.from)),
      indexes: indexes.sort((a, b) =>
        a.columns.join().localeCompare(b.columns.join()),
      ),
    };
  }
  await client.close();
  return out;
}

/** Type checks the generated files; returns the (file-local) diagnostics. */
function typeCheck(files: string[]): string[] {
  const program = ts.createProgram(files, {
    strict: true,
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    esModuleInterop: true,
    skipLibCheck: true,
    noEmit: true,
    strictPropertyInitialization: false,
  });
  const own = new Set(files.map((f) => resolve(f)));
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file && own.has(resolve(d.file.fileName)))
    .map(
      (d) =>
        `${d.file?.fileName}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`,
    );
}

/** Compiles and evaluates the generated modules, returning every export. */
function loadGenerated(dir: string, files: string[]): any[] {
  const cache = new Map<string, any>();
  const load = (absolutePath: string): any => {
    const abs = resolve(absolutePath);
    if (cache.has(abs)) return cache.get(abs);
    const js = ts.transpileModule(readFileSync(abs, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        esModuleInterop: true,
      },
    }).outputText;

    const mod = { exports: {} as any };
    // Seeded before evaluation so a circular import resolves to the
    // partially-filled module instead of recursing forever.
    cache.set(abs, mod.exports);
    const requireShim = (id: string) => {
      if (id === SRC_INDEX) return require(SRC_INDEX);
      if (id.startsWith(".")) {
        return load(resolve(dirname(abs), id.replace(/\.js$/, ".ts")));
      }
      return require(id);
    };
    // eslint-disable-next-line no-new-func
    new Function("exports", "require", "module", "__filename", "__dirname", js)(
      mod.exports,
      requireShim,
      mod,
      abs,
      dirname(abs),
    );
    cache.set(abs, mod.exports);
    return mod.exports;
  };

  const entities: any[] = [];
  for (const file of files) {
    for (const value of Object.values(load(join(dir, file)))) {
      if (typeof value === "function") entities.push(value);
    }
  }
  return entities;
}

describe("[Integration] SQLite: introspection echo (table → entity → table)", () => {
  let tempDir: string;
  let counter = 0;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "stg-echo-"));
  });

  afterAll(async () => {
    await DatabaseClient.getInstance().close().catch(() => {});
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await DatabaseClient.getInstance().close().catch(() => {});
  });

  /** Introspects `dbFile` and recreates its schema in a fresh database. */
  async function echo(
    dbFile: string,
    style: EntityCodeStyle,
  ): Promise<{ code: Map<string, string>; dbFile: string }> {
    const round = counter++;
    const genDir = join(tempDir, `gen-${style}-${round}`);
    await mkdir(genDir, { recursive: true });

    const result = await runIntrospect(
      { type: "sqlite", database: dbFile, logging: false } as any,
      { dryRun: true, codeBuilderOptions: { importPath: SRC_INDEX, style } },
    );
    const code = new Map(result.entities.map((e) => [e.fileName, e.code]));
    for (const entity of result.entities) {
      await writeFile(join(genDir, entity.fileName), entity.code, "utf8");
    }

    const files = [...code.keys()];
    expect(typeCheck(files.map((f) => join(genDir, f)))).toEqual([]);

    const entities = loadGenerated(genDir, files);
    expect(entities.length).toBe(files.length);

    const target = join(tempDir, `echo-${style}-${round}.sqlite`);
    const em = new EntityManager();
    await em.register(
      {
        type: "sqlite",
        database: target,
        entities,
        synchronize: true,
        logging: false,
      } as any,
      `echo-${style}-${round}`,
    );
    await (em as unknown as { destroy?: () => Promise<void> }).destroy?.();
    await DatabaseClient.getInstance().close().catch(() => {});

    return { code, dbFile: target };
  }

  async function seedSource(): Promise<string> {
    const dbFile = join(tempDir, `source-${counter++}.sqlite`);
    const client = DatabaseClient.getInstance();
    const connector = await client.connect({
      type: "sqlite",
      database: dbFile,
      logging: false,
    } as any);
    for (const ddl of SOURCE_DDL) await connector.query(ddl);
    await client.close();
    return dbFile;
  }

  describe.each<EntityCodeStyle>(["decorator", "code-first"])(
    "%s style",
    (style) => {
      it("recreates an equivalent schema and then generates a fixed point", async () => {
        const source = await seedSource();
        const before = await snapshot(source);

        const first = await echo(source, style);
        const after = await snapshot(first.dbFile);

        // Same tables, same columns, same keys.
        expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
        for (const table of Object.keys(before)) {
          expect({ table, ...after[table] }).toEqual({ table, ...before[table] });
        }

        // Generations 2 and 3 must be identical: once the schema has been
        // through the ORM's own DDL, the loop has to stop moving.
        const second = await echo(first.dbFile, style);
        const third = await echo(second.dbFile, style);
        expect([...third.code.entries()].sort()).toEqual(
          [...second.code.entries()].sort(),
        );
        expect(await snapshot(third.dbFile)).toEqual(
          await snapshot(second.dbFile),
        );
      }, 120000);
    },
  );
});
