/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Introspection echo on PostgreSQL and MySQL / MariaDB: table → entity → table.
 *
 * A schema is created with plain DDL, read into the schema IR, and turned into
 * entities (both notations). The generated files are type checked, the tables
 * dropped, and `synchronize` recreates them from the loaded entities. The
 * recreated schema is read into the IR again and must equal the first reading
 * — types, nullability, defaults, identity, keys, referential actions and
 * indexes — and generating from it must reproduce the first files byte for
 * byte.
 *
 * Every catalog statement the readers run is exercised against a real server
 * here; the unit tests only pin how their answers are read.
 *
 * Runs only under INTEGRATION_TEST=true; individual drivers can be disabled
 * with INTEGRATION_TEST_MYSQL=false / INTEGRATION_TEST_POSTGRES=false.
 */
import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseClient } from "../../src/DatabaseClient";
import type { EntityCodeStyle } from "../../src/introspection/EntityCodeBuilder";
import {
  GeneratedEntity,
  IntrospectionGenerator,
} from "../../src/introspection/IntrospectionGenerator";
import type { SchemaIR, TableIR } from "../../src/introspection/SchemaIR";
import {
  loadGenerated,
  SRC_INDEX,
  typeCheck,
  writeGenerated,
} from "../helpers/generatedEntities";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";
import { createTestConnection } from "./helpers/test-connection";

const INTEGRATION = process.env.INTEGRATION_TEST === "true";
const drivers = INTEGRATION ? getTestDrivers() : [];

const P = `ie${Date.now().toString().slice(-6)}_`;
const TABLES = [`${P}users`, `${P}posts`, `${P}post_tags`];

function sourceDdl(type: TestDriverConfig["type"]): string[] {
  if (type === "postgres") {
    return [
      `CREATE TYPE "${P}status" AS ENUM ('draft', 'live', 'it''s')`,
      `CREATE TABLE "${P}users" (
         id SERIAL PRIMARY KEY,
         email VARCHAR(255) NOT NULL,
         nickname VARCHAR(50),
         age INTEGER NOT NULL DEFAULT 0,
         balance NUMERIC(12,2) NOT NULL DEFAULT 0,
         score REAL,
         bio TEXT,
         avatar BYTEA,
         is_admin BOOLEAN NOT NULL DEFAULT false,
         meta JSONB NOT NULL DEFAULT '{}',
         scores INTEGER[] NOT NULL,
         labels VARCHAR(20)[],
         status "${P}status" NOT NULL DEFAULT 'draft',
         uid UUID,
         code CHAR(8),
         label VARCHAR(20) NOT NULL DEFAULT 'it''s n/a',
         born_on DATE,
         seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
         created_at TIMESTAMPTZ NOT NULL,
         deleted_at TIMESTAMP
       )`,
      `CREATE UNIQUE INDEX "${P}uq_users_email" ON "${P}users" (email)`,
      `CREATE INDEX "${P}idx_users_nick" ON "${P}users" (nickname)`,
      `CREATE TABLE "${P}posts" (
         id BIGSERIAL PRIMARY KEY,
         author_id INTEGER NOT NULL REFERENCES "${P}users"(id) ON DELETE CASCADE,
         reviewer_id INTEGER REFERENCES "${P}users"(id) ON DELETE SET NULL ON UPDATE CASCADE,
         title VARCHAR(200) NOT NULL,
         views INTEGER NOT NULL DEFAULT 0
       )`,
      // PostgreSQL does not index a foreign key by itself: this one is the schema's.
      `CREATE INDEX "${P}idx_posts_author" ON "${P}posts" (author_id)`,
      `CREATE UNIQUE INDEX "${P}uq_posts_author_title" ON "${P}posts" (author_id, title)`,
      `CREATE TABLE "${P}post_tags" (
         post_id BIGINT NOT NULL REFERENCES "${P}posts"(id),
         tag VARCHAR(30) NOT NULL,
         PRIMARY KEY (post_id, tag)
       )`,
    ];
  }
  return [
    `CREATE TABLE \`${P}users\` (
       id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
       email VARCHAR(255) NOT NULL,
       nickname VARCHAR(50) NULL,
       age INT NOT NULL DEFAULT 0,
       balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
       score FLOAT NULL,
       bio TEXT NULL,
       avatar BLOB NULL,
       is_admin TINYINT(1) NOT NULL DEFAULT 0,
       meta JSON NULL,
       status ENUM('draft','live','it''s') NOT NULL DEFAULT 'draft',
       code CHAR(8) NULL,
       label VARCHAR(20) NOT NULL DEFAULT 'it''s n/a',
       born_on DATE NULL,
       seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       created_at DATETIME NOT NULL,
       deleted_at DATETIME NULL,
       UNIQUE KEY \`${P}uq_users_email\` (email),
       KEY \`${P}idx_users_nick\` (nickname)
     ) ENGINE=InnoDB`,
    `CREATE TABLE \`${P}posts\` (
       id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
       author_id INT NOT NULL,
       reviewer_id INT NULL,
       title VARCHAR(200) NOT NULL,
       views INT NOT NULL DEFAULT 0,
       UNIQUE KEY \`${P}uq_posts_author_title\` (author_id, title),
       CONSTRAINT \`${P}fk_posts_author\` FOREIGN KEY (author_id) REFERENCES \`${P}users\` (id) ON DELETE CASCADE,
       CONSTRAINT \`${P}fk_posts_reviewer\` FOREIGN KEY (reviewer_id) REFERENCES \`${P}users\` (id) ON DELETE SET NULL ON UPDATE CASCADE
     ) ENGINE=InnoDB`,
    `CREATE TABLE \`${P}post_tags\` (
       post_id BIGINT NOT NULL,
       tag VARCHAR(30) NOT NULL,
       PRIMARY KEY (post_id, tag),
       CONSTRAINT \`${P}fk_tags_post\` FOREIGN KEY (post_id) REFERENCES \`${P}posts\` (id)
     ) ENGINE=InnoDB`,
  ];
}

function dropDdl(type: TestDriverConfig["type"]): string[] {
  const tables = [...TABLES].reverse();
  return type === "postgres"
    ? [
        ...tables.map((t) => `DROP TABLE IF EXISTS "${t}" CASCADE`),
        `DROP TYPE IF EXISTS "${P}status"`,
      ]
    : tables.map((t) => `DROP TABLE IF EXISTS \`${t}\``);
}

/**
 * The IR without what the schema author does not choose: constraint and index
 * names, and the catalog's raw spellings. On MySQL an index InnoDB made for a
 * foreign key by itself is the engine's, whichever order the keys were created in.
 *
 * Column order is not compared: this ORM creates a relation's join column
 * after the table's other columns, wherever the entity declares it.
 */
function comparable(ir: SchemaIR, engineIndexesForForeignKeys: boolean) {
  const sameList = (a: string[], b: string[]) =>
    a.length === b.length && a.every((v, i) => v === b[i]);
  return ir.tables.map((table: TableIR) => ({
    name: table.name,
    primaryKey: table.primaryKey,
    columns: table.columns
      .map((c) => ({
        name: c.name,
        type: c.type,
        nullable: table.primaryKey.includes(c.name) ? false : c.nullable,
        default: c.default?.kind === "null" ? undefined : c.default,
        identity: c.identity,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    foreignKeys: table.foreignKeys
      .map((fk) => ({
        columns: fk.columns,
        referencedTable: fk.referencedTable,
        referencedColumns: fk.referencedColumns,
        onDelete: fk.onDelete,
        onUpdate: fk.onUpdate,
      }))
      .sort((a, b) => a.columns.join().localeCompare(b.columns.join())),
    indexes: table.indexes
      .filter(
        (idx) =>
          !(
            engineIndexesForForeignKeys &&
            !idx.unique &&
            table.foreignKeys.some((fk) => sameList(fk.columns, idx.columns))
          ),
      )
      .map((idx) => ({ unique: idx.unique, columns: idx.columns, unsupported: idx.unsupported }))
      .sort((a, b) => a.columns.join().localeCompare(b.columns.join())),
  }));
}

describe.each(drivers)(
  "[Integration][$label] introspection echo (table → entity → table)",
  ({ type, options }: TestDriverConfig) => {
    let tempDir: string;

    beforeAll(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "stg-echo-dual-"));
    });

    afterAll(async () => {
      await withConnection(async (query) => {
        for (const statement of dropDdl(type)) await query(statement);
      }).catch(() => {});
      if (tempDir) await rm(tempDir, { recursive: true, force: true });
    }, 60000);

    /** Runs `fn` on a fresh connection, synchronizing `entities` first when given. */
    async function withConnection<T>(
      fn: (query: (q: any) => Promise<any>) => Promise<T>,
      entities?: () => any[],
    ): Promise<T> {
      const conn = await createTestConnection(
        { ...options, synchronize: !!entities, logging: false },
        () => ({ entities: entities ? entities() : [] }),
      );
      try {
        const connector = DatabaseClient.getInstance().getConnection();
        return await fn((q) => connector.query(q));
      } finally {
        await conn.cleanup();
      }
    }

    async function introspect(
      style: EntityCodeStyle,
    ): Promise<{ ir: SchemaIR; entities: GeneratedEntity[] }> {
      return withConnection(async (query) => {
        const generator = new IntrospectionGenerator(query, type, {
          includeTables: TABLES,
          codeBuilderOptions: { importPath: SRC_INDEX, style },
        });
        return { ir: await generator.readSchema(), entities: await generator.generate() };
      });
    }

    it.each<EntityCodeStyle>(["decorator", "code-first"])(
      "%s: recreates the schema it read, then stops moving",
      async (style) => {
        await withConnection(async (query) => {
          for (const statement of dropDdl(type)) await query(statement);
          for (const statement of sourceDdl(type)) await query(statement);
        });

        const first = await introspect(style);
        expect(first.ir.tables.map((t) => t.name).sort()).toEqual([...TABLES].sort());

        // The comparison below would pass if both readings were equally
        // wrong, so the first one is pinned where the dialects differ most.
        const table = (name: string) => first.ir.tables.find((t) => t.name === `${P}${name}`)!;
        const col = (name: string) => table("users").columns.find((c) => c.name === name)!;
        expect(col("meta").type).toEqual({ kind: "json", binary: type === "postgres" });
        expect(col("is_admin").type).toEqual({ kind: "boolean" });
        expect(col("status").type).toMatchObject({ kind: "enum", values: ["draft", "live", "it's"] });
        expect(col("label").default).toEqual({ kind: "string", value: "it's n/a" });
        expect(col("seen_at").default).toEqual({ kind: "expression", sql: "CURRENT_TIMESTAMP" });
        expect(col("id").identity).toBe(true);
        expect(table("posts").foreignKeys.map((fk) => [fk.columns, fk.onDelete, fk.onUpdate]).sort()).toEqual([
          [["author_id"], "CASCADE", "NO ACTION"],
          [["reviewer_id"], "SET NULL", "CASCADE"],
        ]);
        expect(table("post_tags").primaryKey).toEqual(["post_id", "tag"]);
        // Nothing in this schema is beyond the ORM, so nothing is flagged.
        expect(first.entities.flatMap((e) => e.notes)).toEqual([]);

        const files = new Map(first.entities.map((e) => [e.fileName, e.code]));
        const paths = await writeGenerated(join(tempDir, `${type}-${style}`), files);
        expect(typeCheck(paths)).toEqual([]);

        await withConnection(async (query) => {
          for (const statement of dropDdl(type)) await query(statement);
        });
        await withConnection(async () => undefined, () => loadGenerated(paths));

        const second = await introspect(style);
        const innoDb = type === "mysql";
        expect(comparable(second.ir, innoDb)).toEqual(comparable(first.ir, innoDb));
        expect(new Map(second.entities.map((e) => [e.fileName, e.code]))).toEqual(files);
      },
      180000,
    );
  },
);
