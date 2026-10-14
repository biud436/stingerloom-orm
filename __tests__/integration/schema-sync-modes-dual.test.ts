/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Schema synchronization against a real PostgreSQL / MySQL (MariaDB): what
 * `synchronize: "safe"` and `"dry-run"` leave alone on a table that already
 * exists, and `@FullTextIndex` — a FULLTEXT index on MySQL, a GIN index over
 * `to_tsvector` on PostgreSQL. Both read the live catalog
 * (information_schema, SHOW INDEX, pg_indexes), so only a real server can
 * say whether the change detection and the DDL hold up.
 *
 * Each boot is a fresh EntityManager over the same table, declaring the
 * entity the way the next release of the application would.
 */
import "reflect-metadata";
import {
  createTestConnection,
  dropTestTable,
  rawQuery,
  type TestConnectionResult,
} from "./helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";
import { qi } from "./helpers/driver-helpers";
import { Entity, Column, PrimaryGeneratedColumn, FullTextIndex } from "../../src";
import { Logger } from "../../src/utils/Logger";

describe.each(getTestDrivers())(
  "[Integration] $label: synchronize modes and full-text indexes",
  ({ type, options }: TestDriverConfig) => {
    const sfx = String(Date.now()).slice(-7);
    let conn: TestConnectionResult | undefined;
    let logs: string[] = [];

    const t = (name: string) => qi(type, name);

    async function boot(synchronize: unknown, declare: () => { entities: any[] }) {
      if (conn) await conn.cleanup();
      logs = [];
      Logger.setOutput((msg: string) => {
        logs.push(msg);
      });
      conn = await createTestConnection({ logging: false, ...options, synchronize } as any, declare);
    }

    afterEach(() => {
      Logger.reset();
    });

    afterAll(async () => {
      Logger.reset();
      if (conn) await conn.cleanup();
    }, 30000);

    async function columns(table: string): Promise<Record<string, { type: string; length: number | null }>> {
      const rows = (await rawQuery(
        type === "postgres"
          ? `SELECT column_name, data_type, character_maximum_length FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table}'`
          : `SELECT column_name, data_type, character_maximum_length FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = '${table}'`,
      )) as any[];
      const out: Record<string, { type: string; length: number | null }> = {};
      for (const r of rows) {
        const name = r.column_name ?? r.COLUMN_NAME;
        const len = r.character_maximum_length ?? r.CHARACTER_MAXIMUM_LENGTH;
        out[name] = {
          type: String(r.data_type ?? r.DATA_TYPE).toLowerCase(),
          length: len === null || len === undefined ? null : Number(len),
        };
      }
      return out;
    }

    describe("synchronize on an existing table", () => {
      const table = `ssm_note_${sfx}`;

      /** v1 is the deployed table; v2 widens `note`, drops `legacy`, adds `extra`. */
      const v1 = () => {
        @Entity({ name: table })
        class SsmNote {
          @PrimaryGeneratedColumn() id!: number;
          @Column({ type: "varchar", length: 20 }) note!: string;
          @Column({ type: "varchar", length: 30, nullable: true }) legacy!: string | null;
        }
        return { entities: [SsmNote] };
      };
      const v2 = () => {
        @Entity({ name: table })
        class SsmNote {
          @PrimaryGeneratedColumn() id!: number;
          @Column({ type: "varchar", length: 100 }) note!: string;
          @Column({ type: "int", nullable: true }) extra!: number | null;
        }
        return { entities: [SsmNote] };
      };

      beforeAll(async () => {
        await boot(true, v1);
        await rawQuery(
          `INSERT INTO ${t(table)} (${t("note")}, ${t("legacy")}) VALUES ('kept', 'old value')`,
        );
      }, 60000);

      afterAll(async () => {
        await dropTestTable(table);
      });

      it('"dry-run" applies nothing and logs what it would do', async () => {
        await boot("dry-run", v2);

        const cols = await columns(table);
        expect(Object.keys(cols).sort()).toEqual(["id", "legacy", "note"]);
        expect(cols.note.length).toBe(20);
        const dryRun = logs.filter((l) => l.includes("[dry-run]"));
        expect(dryRun.some((l) => /ADD COLUMN.*extra/i.test(l))).toBe(true);
        expect(dryRun.some((l) => /note/i.test(l) && /ALTER|MODIFY/i.test(l))).toBe(true);
        expect(dryRun.some((l) => /DROP COLUMN.*legacy/i.test(l))).toBe(true);
      });

      it('"safe" adds the new column but leaves the widening and the drop, with a summary warning', async () => {
        await boot("safe", v2);

        const cols = await columns(table);
        expect(Object.keys(cols).sort()).toEqual(["extra", "id", "legacy", "note"]);
        expect(cols.note.length).toBe(20);
        expect(logs.some((l) => /safe mode skipped 2 schema change/.test(l))).toBe(true);
        const rows = (await rawQuery(`SELECT ${t("note")}, ${t("legacy")} FROM ${t(table)}`)) as any[];
        expect(rows).toEqual([{ note: "kept", legacy: "old value" }]);
      });

      it("true then applies the widening and the drop", async () => {
        await boot(true, v2);

        const cols = await columns(table);
        expect(Object.keys(cols).sort()).toEqual(["extra", "id", "note"]);
        expect(cols.note.length).toBe(100);
        const rows = (await rawQuery(`SELECT ${t("note")} FROM ${t(table)}`)) as any[];
        expect(rows).toEqual([{ note: "kept" }]);
      });
    });

    describe("@FullTextIndex", () => {
      const table = `ssm_article_${sfx}`;
      const indexName = `ssm_fts_${sfx}`;

      const article = () => {
        @Entity({ name: table })
        @FullTextIndex(["title", "body"], { name: indexName })
        class SsmArticle {
          @PrimaryGeneratedColumn() id!: number;
          @Column({ type: "varchar", length: 200 }) title!: string;
          @Column({ type: "text" }) body!: string;
        }
        return { entities: [SsmArticle] };
      };

      afterAll(async () => {
        await dropTestTable(table);
      });

      it("creates the index the dialect searches with, and a reboot leaves it in place", async () => {
        await boot({ mode: true, continueOnError: false }, article);

        if (type === "postgres") {
          const rows = (await rawQuery(
            `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = '${table}' AND indexname = '${indexName}'`,
          )) as any[];
          expect(rows).toHaveLength(1);
          expect(rows[0].indexdef).toMatch(/USING gin/i);
          expect(rows[0].indexdef).toMatch(/to_tsvector/i);
        } else {
          const rows = (await rawQuery(`SHOW INDEX FROM ${t(table)} WHERE Key_name = '${indexName}'`)) as any[];
          expect(rows.map((r) => r.Column_name).sort()).toEqual(["body", "title"]);
          expect(rows.every((r) => r.Index_type === "FULLTEXT")).toBe(true);
        }

        // A second boot finds the index and does not try to create it again —
        // with continueOnError: false, a failed CREATE would stop the boot.
        await boot({ mode: true, continueOnError: false }, article);
      });

      it("finds rows by their words", async () => {
        await rawQuery(
          `INSERT INTO ${t(table)} (${t("title")}, ${t("body")}) VALUES ` +
            `('Layered metadata', 'Copy on write tenants'), ('Advisory locks', 'Sessions hold them')`,
        );
        const rows = (await rawQuery(
          type === "postgres"
            ? `SELECT ${t("title")} FROM ${t(table)} WHERE to_tsvector('english', ${t("title")} || ' ' || ${t("body")}) @@ to_tsquery('english', 'tenants')`
            : `SELECT ${t("title")} FROM ${t(table)} WHERE MATCH(${t("title")}, ${t("body")}) AGAINST ('+tenants' IN BOOLEAN MODE)`,
        )) as any[];
        expect(rows.map((r) => r.title)).toEqual(["Layered metadata"]);
      });
    });
  },
);
