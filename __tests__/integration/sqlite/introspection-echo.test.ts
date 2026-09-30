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
 * SQLite keeps a declared type only as its affinity (BOOLEAN comes back as the
 * INTEGER this ORM declares), so the first generation is compared by affinity
 * and the byte-identity claim starts at the second generation. A declaration
 * whose affinity the ORM changes — DATETIME is NUMERIC, the ORM's TEXT is not —
 * is flagged instead; see the second test. See docs/introspection.md.
 */
import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseClient } from "../../../src/DatabaseClient";
import { EntityManager } from "../../../src/core/EntityManager";
import { runIntrospect } from "../../../src/introspection/IntrospectionCli";
import type { EntityCodeStyle } from "../../../src/introspection/EntityCodeBuilder";
import type { GeneratedEntity } from "../../../src/introspection/IntrospectionGenerator";
import { stripOuterParens } from "../../../src/introspection/SchemaIR";
import {
  loadGenerated,
  SRC_INDEX,
  typeCheck,
  writeGenerated,
} from "../../helpers/generatedEntities";

/** A schema every part of which the ORM can recreate. */
const FAITHFUL_DDL = [
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY,
     email VARCHAR(255) NOT NULL,
     nickname VARCHAR(50),
     age INTEGER NOT NULL DEFAULT 0,
     score REAL,
     bio TEXT,
     avatar BLOB,
     is_admin BOOLEAN NOT NULL DEFAULT FALSE,
     joined_on TEXT NOT NULL DEFAULT (datetime('now')),
     "order-ref" VARCHAR(20) DEFAULT 'n/a'
   )`,
  `CREATE UNIQUE INDEX uq_users_email ON users(email)`,
  `CREATE INDEX idx_users_nickname ON users(nickname)`,
  `CREATE TABLE posts (
     id INTEGER PRIMARY KEY,
     title VARCHAR(200) NOT NULL,
     views INTEGER NOT NULL DEFAULT 0,
     author_id INTEGER NOT NULL,
     reviewer_id INTEGER,
     FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE,
     FOREIGN KEY (reviewer_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE
   )`,
  `CREATE INDEX idx_posts_title_views ON posts(title, views)`,
  // SQLite does not index a foreign key by itself, so these are the schema's.
  `CREATE INDEX idx_posts_author ON posts(author_id)`,
  `CREATE UNIQUE INDEX uq_posts_author_title ON posts(author_id, title)`,
  `CREATE TABLE comments (
     id INTEGER PRIMARY KEY,
     body TEXT NOT NULL,
     parent_id INTEGER,
     FOREIGN KEY (parent_id) REFERENCES comments(id)
   )`,
  // Would be class `Error`, which shadows the global the metadata refers to.
  `CREATE TABLE errors (
     id INTEGER PRIMARY KEY,
     message TEXT NOT NULL
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
  fks: Array<{ from: string; table: string; to: string; onDelete: string; onUpdate: string }>;
  indexes: Array<{ unique: boolean; columns: string[] }>;
}

/**
 * SQLite's declared-type → storage-affinity rules. The echo can only be held
 * to the affinity, because that is all SQLite itself preserves. INTEGER and
 * NUMERIC are one class: they behave the same except in a CAST.
 */
function affinityOf(declaredType: string): string {
  const t = (declaredType || "").toUpperCase();
  if (t.includes("INT")) return "NUMERIC";
  if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT")) return "TEXT";
  if (t.includes("BLOB") || t === "") return "BLOB";
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB")) return "REAL";
  return "NUMERIC";
}

/** Normalizes the handful of literal spellings SQLite accepts for a default. */
function normalizeDefault(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const raw = stripOuterParens(String(value)).replace(/^'(.*)'$/s, "$1");
  const upper = raw.toUpperCase();
  if (upper === "TRUE") return "1";
  if (upper === "FALSE") return "0";
  return raw;
}

/**
 * The schema as SQLite's PRAGMAs report it — read here directly rather than
 * through the introspection reader, so the echo is checked independently of
 * the code under test.
 */
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
        .map((f) => ({
          from: f.from,
          table: f.table,
          to: f.to,
          onDelete: f.on_delete,
          onUpdate: f.on_update,
        }))
        .sort((a, b) => a.from.localeCompare(b.from)),
      indexes: indexes.sort((a, b) =>
        a.columns.join().localeCompare(b.columns.join()),
      ),
    };
  }
  await client.close();
  return out;
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
  ): Promise<{ code: Map<string, string>; entities: GeneratedEntity[]; dbFile: string }> {
    const round = counter++;

    const result = await runIntrospect(
      { type: "sqlite", database: dbFile, logging: false } as any,
      { dryRun: true, codeBuilderOptions: { importPath: SRC_INDEX, style } },
    );
    const code = new Map(result.entities.map((e) => [e.fileName, e.code]));
    const paths = await writeGenerated(join(tempDir, `gen-${style}-${round}`), code);
    expect(typeCheck(paths)).toEqual([]);

    const entities = loadGenerated(paths);
    expect(entities.length).toBe(paths.length);

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

    return { code, entities: result.entities, dbFile: target };
  }

  async function seed(ddl: string[]): Promise<string> {
    const dbFile = join(tempDir, `source-${counter++}.sqlite`);
    const client = DatabaseClient.getInstance();
    const connector = await client.connect({
      type: "sqlite",
      database: dbFile,
      logging: false,
    } as any);
    for (const statement of ddl) await connector.query(statement);
    await client.close();
    return dbFile;
  }

  describe.each<EntityCodeStyle>(["decorator", "code-first"])(
    "%s style",
    (style) => {
      it("recreates an equivalent schema and then generates a fixed point", async () => {
        const source = await seed(FAITHFUL_DDL);
        const before = await snapshot(source);

        const first = await echo(source, style);
        // Nothing in this schema is beyond the ORM, so nothing is flagged.
        expect(first.entities.flatMap((e) => e.notes)).toEqual([]);
        expect(first.entities.find((e) => e.tableName === "errors")?.className).toBe(
          "ErrorEntity",
        );
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

      it("flags exactly what it cannot recreate, and recreates everything else", async () => {
        const source = await seed([
          `CREATE TABLE teams (
             org_id INTEGER NOT NULL,
             team_no INTEGER NOT NULL,
             name TEXT NOT NULL,
             PRIMARY KEY (org_id, team_no)
           )`,
          `CREATE TABLE players (
             id INTEGER PRIMARY KEY,
             org_id INTEGER NOT NULL,
             team_no INTEGER NOT NULL,
             name TEXT NOT NULL,
             name_key TEXT GENERATED ALWAYS AS (lower(name)) VIRTUAL,
             signed_on DATETIME,
             FOREIGN KEY (org_id, team_no) REFERENCES teams(org_id, team_no)
           )`,
          `CREATE INDEX idx_players_named ON players(name) WHERE org_id > 0`,
          `CREATE INDEX idx_players_lower ON players(lower(name))`,
          `CREATE INDEX idx_players_name ON players(name)`,
        ]);
        const before = await snapshot(source);

        const { entities, dbFile } = await echo(source, style);
        const players = entities.find((e) => e.tableName === "players")!;
        expect(players.notes).toEqual([
          "Composite foreign key (org_id, team_no) → teams(org_id, team_no) is not declared: a relation joins on a single column. Its columns are kept as plain columns; recreate the constraint in a migration.",
          'Index "idx_players_lower" is not declared: expression key part cannot be expressed with the ORM\'s index options. Recreate it in a migration.',
          'Index "idx_players_named" is not declared: partial index (WHERE clause) cannot be expressed with the ORM\'s index options. Recreate it in a migration.',
          "nameKey: This is a generated column, emitted as a plain column. Declare it as a computed column to keep the database computing it.",
          'signedOn: The database declares "DATETIME", but this entity creates "TEXT" — synchronizing it would change the column.',
        ]);

        // Everything not flagged came back.
        const after = await snapshot(dbFile);
        expect(after.teams).toEqual(before.teams);
        const beforeColumns = before.players.columns;
        const signedOn = beforeColumns.findIndex((c) => c.name === "signed_on");
        expect(after.players.columns).toEqual([
          ...beforeColumns.slice(0, signedOn),
          // table_info hides the generated column; its plain copy shows up.
          expect.objectContaining({ name: "name_key" }),
          { ...beforeColumns[signedOn], affinity: "TEXT" },
        ]);
        expect(after.players.fks).toEqual([]);
        expect(after.players.indexes).toEqual([{ unique: false, columns: ["name"] }]);
      }, 120000);
    },
  );
});
