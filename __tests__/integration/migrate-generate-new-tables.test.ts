/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `migrate:generate` creates a new table with everything `synchronize`
 * creates it with, against real servers (MySQL/MariaDB + PostgreSQL): the
 * foreign key column of every relation, the indexes, the foreign key
 * constraints and the `@ManyToMany` join tables.
 *
 * Mirrors __tests__/integration/sqlite/migrate-generate-new-tables.test.ts.
 * The generated statements are applied to the database, its tables are read
 * back, the `down` statements are applied, and `synchronize` then builds the
 * same entities — the two readings have to agree.
 *
 * Runs only under INTEGRATION_TEST=true; individual drivers can be disabled
 * with INTEGRATION_TEST_MYSQL=false / INTEGRATION_TEST_POSTGRES=false.
 */
import "reflect-metadata";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  Column,
  Entity,
  Index,
  ManyToMany,
  ManyToOne,
  OneToOne,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  RelationColumn,
  UniqueIndex,
} from "../../src";
import { MigrationCli } from "../../src/migration/MigrationCli";
import {
  createTestConnection,
  resetMetadata,
  TestConnectionResult,
} from "./helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";

const INTEGRATION = process.env.INTEGRATION_TEST === "true";
const drivers = INTEGRATION ? getTestDrivers() : [];

// Dependents first, so the tables can be dropped in this order.
const TABLES = [
  "mgnt_d_book_tags",
  "mgnt_d_cover",
  "mgnt_d_book",
  "mgnt_d_author",
  "mgnt_d_tag",
  "mgnt_d_depot",
];

interface TableShape {
  columns: string[];
  foreignKeys: string[];
  indexes: string[];
}

describe.each(drivers)(
  "[Integration][$label] migrate:generate creates new tables in full",
  ({ type, options }: TestDriverConfig) => {
    let dir: string;
    const q = (name: string) => (type === "mysql" ? `\`${name}\`` : `"${name}"`);

    async function connect(entities: () => any[] = () => []) {
      resetMetadata();
      return createTestConnection(
        { ...options, synchronize: false, logging: false },
        () => ({ entities: entities() }),
      );
    }

    async function dropAll(): Promise<void> {
      const conn = await connect();
      try {
        for (const table of TABLES) {
          await conn.em.query(
            type === "postgres"
              ? `DROP TABLE IF EXISTS ${q(table)} CASCADE`
              : `DROP TABLE IF EXISTS ${q(table)}`,
          );
        }
      } finally {
        await conn.cleanup();
      }
    }

    beforeEach(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "stg-mgnt-"));
      await dropAll();
    }, 30000);

    afterEach(async () => {
      fs.rmSync(dir, { recursive: true, force: true });
      await dropAll();
      resetMetadata();
    }, 30000);

    async function generate(
      entities: () => any[],
    ): Promise<{ up: string[]; down: string[]; filePath: string }> {
      resetMetadata();
      const cli = new MigrationCli([], {
        ...options,
        entities: entities(),
        synchronize: false,
        logging: false,
      } as any);
      await cli.connect();
      cli.setGenerateOptions({ outputDir: path.join(dir, "migrations") });
      try {
        const result = (await cli.execute("migrate:generate")) as any;
        return { ...result.sql, filePath: result.filePath };
      } finally {
        await cli.close();
      }
    }

    async function run(statements: string[]): Promise<void> {
      const conn = await connect();
      try {
        for (const statement of statements) await conn.em.query(statement);
      } finally {
        await conn.cleanup();
      }
    }

    async function synchronize(entities: () => any[]): Promise<void> {
      resetMetadata();
      const booted = await createTestConnection(
        { ...options, synchronize: true, logging: false },
        () => ({ entities: entities() }),
      );
      await booted.cleanup();
    }

    const rows = async (conn: TestConnectionResult, statement: string) =>
      (await conn.em.query(statement)) as unknown as any[];

    /** The test tables that exist, with columns, foreign keys and indexes. */
    async function shape(): Promise<Record<string, TableShape>> {
      const conn = await connect();
      const inList = TABLES.map((t) => `'${t}'`).join(", ");
      const result: Record<string, TableShape> = {};
      const table = (name: string) =>
        (result[name] ??= { columns: [], foreignKeys: [], indexes: [] });
      try {
        const columns = await rows(
          conn,
          type === "postgres"
            ? `SELECT table_name AS t, column_name AS c, data_type AS d, character_maximum_length AS l, is_nullable AS n FROM information_schema.columns WHERE table_schema = current_schema() AND table_name IN (${inList})`
            : `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS d, CHARACTER_MAXIMUM_LENGTH AS l, IS_NULLABLE AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${inList})`,
        );
        for (const r of columns) {
          table(r.t).columns.push(`${r.c} ${r.d} length=${r.l} nullable=${r.n}`);
        }

        const foreignKeys = await rows(
          conn,
          type === "postgres"
            ? `SELECT tc.table_name AS t, tc.constraint_name AS name, kcu.column_name AS c, ccu.table_name AS rt, ccu.column_name AS rc, rc.delete_rule AS del, rc.update_rule AS upd
                 FROM information_schema.table_constraints tc
                 JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
                 JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
                 JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
                WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = current_schema() AND tc.table_name IN (${inList})`
            : `SELECT kcu.TABLE_NAME AS t, kcu.CONSTRAINT_NAME AS name, kcu.COLUMN_NAME AS c, kcu.REFERENCED_TABLE_NAME AS rt, kcu.REFERENCED_COLUMN_NAME AS rc, rc.DELETE_RULE AS del, rc.UPDATE_RULE AS upd
                 FROM information_schema.KEY_COLUMN_USAGE kcu
                 JOIN information_schema.REFERENTIAL_CONSTRAINTS rc ON rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND rc.CONSTRAINT_SCHEMA = kcu.TABLE_SCHEMA
                WHERE kcu.TABLE_SCHEMA = DATABASE() AND kcu.REFERENCED_TABLE_NAME IS NOT NULL AND kcu.TABLE_NAME IN (${inList})`,
        );
        for (const r of foreignKeys) {
          table(r.t).foreignKeys.push(
            `${r.name}: ${r.c} -> ${r.rt}.${r.rc} delete=${r.del} update=${r.upd}`,
          );
        }

        const indexes = await rows(
          conn,
          type === "postgres"
            ? `SELECT tablename AS t, indexdef AS def FROM pg_indexes WHERE schemaname = current_schema() AND tablename IN (${inList})`
            : `SELECT TABLE_NAME AS t, CONCAT(INDEX_NAME, ' unique=', 1 - NON_UNIQUE, ' (', GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX), ')') AS def FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${inList}) GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE`,
        );
        for (const r of indexes) table(r.t).indexes.push(String(r.def));
      } finally {
        await conn.cleanup();
      }
      for (const entry of Object.values(result)) {
        entry.columns.sort();
        entry.foreignKeys.sort();
        entry.indexes.sort();
      }
      return result;
    }

    const library = () => {
      @Entity({ name: "mgnt_d_depot" })
      class Depot {
        @PrimaryColumn({ type: "varchar", length: 36 }) code!: string;
      }

      @Entity({ name: "mgnt_d_tag" })
      class Tag {
        @PrimaryGeneratedColumn() id!: number;
        @Column({ type: "varchar", length: 40 }) label!: string;
      }

      @Entity({ name: "mgnt_d_author" })
      @UniqueIndex(["name"], "uq_mgnt_d_author_name")
      @Index(["name", "email"])
      class Author {
        @PrimaryGeneratedColumn() id!: number;
        @Column({ type: "varchar", length: 40 }) name!: string;
        @Index() @Column({ type: "varchar", length: 40 }) email!: string;
      }

      @Entity({ name: "mgnt_d_book" })
      class Book {
        @PrimaryGeneratedColumn() id!: number;
        @Column({ type: "varchar", length: 40 }) title!: string;

        @ManyToOne(() => Author, undefined as any, {
          joinColumn: "author_id",
          onDelete: "CASCADE",
        })
        author!: Author;

        @ManyToOne(() => Author, undefined as any)
        @RelationColumn({ name: "editor_id", nullable: false })
        editor!: Author;

        @ManyToOne(() => Author, undefined as any, {
          joinColumn: "reviewer_id",
          createForeignKeyConstraints: false,
        })
        reviewer!: Author;

        @ManyToOne(() => Depot, undefined as any)
        @RelationColumn({ name: "depot_code" })
        depot!: Depot;

        @ManyToMany(() => Tag, {
          joinTable: {
            name: "mgnt_d_book_tags",
            joinColumn: "book_id",
            inverseJoinColumn: "tag_id",
          },
        } as any)
        tags!: Tag[];
      }

      @Entity({ name: "mgnt_d_cover" })
      class Cover {
        @PrimaryGeneratedColumn() id!: number;
        @OneToOne(() => Book, { joinColumn: "book_id" } as any)
        book!: Book;
      }

      return [Depot, Tag, Author, Book, Cover];
    };

    it("creates the same schema synchronize creates, and reverts it", async () => {
      const first = await generate(library);
      expect(first.filePath).not.toBe("");
      await run(first.up);
      const migrated = await shape();

      // Nothing is left for a second run to find.
      const second = await generate(library);
      expect(second.up).toEqual([]);

      await run(first.down);
      expect(await shape()).toEqual({});

      await synchronize(library);
      const synced = await shape();

      expect(migrated).toEqual(synced);
      // Spelled out, so the comparison cannot pass on two empty schemas.
      expect(Object.keys(migrated).sort()).toEqual([...TABLES].sort());
      expect(migrated.mgnt_d_book.foreignKeys).toHaveLength(3);
      expect(migrated.mgnt_d_book.columns.map((c) => c.split(" ")[0])).toEqual([
        "author_id",
        "depot_code",
        "editor_id",
        "id",
        "reviewer_id",
        "title",
      ]);
      expect(migrated.mgnt_d_book_tags.foreignKeys).toHaveLength(2);
      expect(migrated.mgnt_d_cover.foreignKeys).toHaveLength(1);
    }, 60000);

    it("does not propose dropping the column of a joinColumn relation", async () => {
      await synchronize(library);

      const result = await generate(library);

      expect(result.up).toEqual([]);
      expect(result.filePath).toBe("");
    }, 60000);
  },
);
