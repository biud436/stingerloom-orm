/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `synchronize` adds a column to an existing table with its declared
 * `@Column({ default })`, on real servers (MySQL/MariaDB + PostgreSQL).
 *
 * The ADD COLUMN used a type placeholder (`DEFAULT ''`, `DEFAULT 0`), and an
 * enum or datetime column was added nullable with no default, so an existing
 * table got different values than a new one. On PostgreSQL an `int` or
 * `boolean` column was not added at all: the statement read `INTEGER(11)` /
 * `BOOLEAN(1)`, which PostgreSQL rejects, and synchronize logged a warning.
 *
 * SQLite mirror: __tests__/integration/sqlite/add-column-default.test.ts
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
import { Entity, Column, PrimaryGeneratedColumn } from "../../src";

describe.each(getTestDrivers())(
  "[Integration] $label: ADD COLUMN keeps the declared default",
  ({ type, options }: TestDriverConfig) => {
    const table = `acdd_user_${String(Date.now()).slice(-7)}`;
    let conn: TestConnectionResult | undefined;
    let User: any;

    async function boot(declare: () => { entities: any[] }) {
      if (conn) await conn.cleanup();
      conn = await createTestConnection({ logging: false, ...options, synchronize: true } as any, declare);
    }

    const v1 = () => {
      @Entity({ name: table })
      class AcddUser {
        @PrimaryGeneratedColumn() id!: number;
        @Column() name!: string;
      }
      return { entities: [AcddUser] };
    };
    const v2 = () => {
      @Entity({ name: table })
      class AcddUser {
        @PrimaryGeneratedColumn() id!: number;
        @Column() name!: string;
        @Column({ type: "varchar", length: 20, default: "active" }) status!: string;
        @Column({ type: "int", default: 5 }) level!: number;
        @Column({ type: "boolean", default: true }) enabled!: boolean;
        @Column({ type: "varchar", length: 20, nullable: true, default: "n/a" }) note!: string | null;
        @Column({ type: "enum", enumValues: ["basic", "pro"], enumName: `${table}_plan`, default: "basic" } as any)
        plan!: string;
        @Column({ type: "datetime", default: "(CURRENT_TIMESTAMP)" }) seenAt!: Date;
        @Column() visits!: number;
        @Column() verified!: boolean;
      }
      User = AcddUser;
      return { entities: [AcddUser] };
    };

    beforeAll(async () => {
      await boot(v1);
      await rawQuery(`INSERT INTO ${qi(type, table)} (${qi(type, "name")}) VALUES ('old')`);
      await boot(v2);
      await conn!.em.save(User, { name: "new", visits: 3, verified: true });
    }, 60000);

    afterAll(async () => {
      try {
        await dropTestTable(table);
      } catch {
        // ignore
      }
      if (type === "postgres") {
        try {
          await rawQuery(`DROP TYPE IF EXISTS "${table}_plan"`);
        } catch {
          // ignore
        }
      }
      if (conn) await conn.cleanup();
    }, 30000);

    it("fills existing rows and rows saved without the properties", async () => {
      const rows: any[] = await conn!.em.find(User, { orderBy: { id: "ASC" } } as any);

      expect(rows.map((row) => row.name)).toEqual(["old", "new"]);
      for (const row of rows) {
        expect(row).toMatchObject({ status: "active", level: 5, enabled: true, note: "n/a", plan: "basic" });
        expect(row.seenAt).toBeInstanceOf(Date);
      }
    });

    it("adds int and boolean columns that declare no default", async () => {
      const rows: any[] = await conn!.em.find(User, { orderBy: { id: "ASC" } } as any);

      expect(rows.map((row) => [row.visits, row.verified])).toEqual([
        [0, false],
        [3, true],
      ]);
    });

    it("leaves the declared defaults on the columns", async () => {
      const cols = (await rawQuery(
        type === "postgres"
          ? `SELECT column_name, column_default, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table}'`
          : `SELECT column_name, column_default, is_nullable FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = '${table}'`,
      )) as any[];
      const byName = Object.fromEntries(
        cols.map((c) => [c.column_name ?? c.COLUMN_NAME, c]),
      );

      for (const name of ["status", "level", "enabled", "plan", "seenAt"]) {
        const col = byName[name];
        expect(col.column_default ?? col.COLUMN_DEFAULT).not.toBeNull();
        expect(col.is_nullable ?? col.IS_NULLABLE).toBe("NO");
      }
    });
  },
);
