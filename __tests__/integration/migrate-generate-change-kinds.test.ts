/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `migrate:generate` writes a migration for renames, generated columns and
 * PostgreSQL enum values against real servers (MySQL/MariaDB + PostgreSQL).
 *
 * Mirrors __tests__/integration/sqlite/migrate-generate-change-kinds.test.ts,
 * plus the PostgreSQL enum case: adding a value to an existing enum type is an
 * `enumChanges` entry, which the CLI never counted as a change.
 *
 * Every generated statement is applied, so the migration is shown to work,
 * not only to be written.
 *
 * Runs only under INTEGRATION_TEST=true; individual drivers can be disabled
 * with INTEGRATION_TEST_MYSQL=false / INTEGRATION_TEST_POSTGRES=false.
 */
import "reflect-metadata";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Column, ComputedColumn, Entity, PrimaryGeneratedColumn } from "../../src";
import { MigrationCli } from "../../src/migration/MigrationCli";
import {
  createTestConnection,
  resetMetadata,
  TestConnectionResult,
} from "./helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";

const INTEGRATION = process.env.INTEGRATION_TEST === "true";
const drivers = INTEGRATION ? getTestDrivers() : [];

const TABLES = ["mgck_d_rename", "mgck_d_computed", "mgck_d_enum"];

describe.each(drivers)(
  "[Integration][$label] migrate:generate covers renames, computed columns and enum values",
  ({ type, options }: TestDriverConfig) => {
    let dir: string;
    const q = (name: string) => (type === "mysql" ? `\`${name}\`` : `"${name}"`);

    async function dropAll(conn: TestConnectionResult): Promise<void> {
      for (const table of TABLES) {
        await conn.em.query(
          type === "postgres"
            ? `DROP TABLE IF EXISTS ${q(table)} CASCADE`
            : `DROP TABLE IF EXISTS ${q(table)}`,
        );
      }
      if (type === "postgres") {
        await conn.em.query(`DROP TYPE IF EXISTS "mgck_d_enum_status_enum" CASCADE`);
      }
    }

    beforeEach(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "stg-mgck-"));
      const conn = await createTestConnection(
        { ...options, synchronize: false, logging: false },
        () => ({ entities: [] }),
      );
      await dropAll(conn);
      await conn.cleanup();
    }, 30000);

    afterEach(async () => {
      fs.rmSync(dir, { recursive: true, force: true });
      const conn = await createTestConnection(
        { ...options, synchronize: false, logging: false },
        () => ({ entities: [] }),
      );
      await dropAll(conn);
      await conn.cleanup();
    }, 30000);

    /** Boots `v1` with synchronize, then diffs `v2` against it through the CLI. */
    async function generate(
      v1: () => any[],
      v2: () => any[],
    ): Promise<{ up: string[]; filePath: string }> {
      const booted = await createTestConnection(
        { ...options, synchronize: true, logging: false },
        () => ({ entities: v1() }),
      );
      await booted.cleanup();

      resetMetadata();
      const cli = new MigrationCli([], {
        ...options,
        entities: v2(),
        synchronize: false,
        logging: false,
      } as any);
      await cli.connect();
      cli.setGenerateOptions({ outputDir: path.join(dir, "migrations") });
      try {
        const result = (await cli.execute("migrate:generate")) as any;
        return { up: result.sql.up, filePath: result.filePath };
      } finally {
        await cli.close();
      }
    }

    /** Applies the statements, then runs `read` on the same connection. */
    async function apply<R>(
      up: string[],
      entities: () => any[],
      read: (conn: TestConnectionResult) => Promise<R>,
    ): Promise<R> {
      const conn = await createTestConnection(
        { ...options, synchronize: false, logging: false },
        () => ({ entities: entities() }),
      );
      try {
        for (const statement of up) await conn.em.query(statement);
        return await read(conn);
      } finally {
        await conn.cleanup();
      }
    }

    async function columnNames(
      conn: TestConnectionResult,
      table: string,
    ): Promise<string[]> {
      const rows = (await conn.em.query(
        type === "postgres"
          ? `SELECT column_name AS name FROM information_schema.columns WHERE table_name = '${table}' AND table_schema = current_schema() ORDER BY ordinal_position`
          : `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' ORDER BY ORDINAL_POSITION`,
      )) as unknown as Array<{ name: string }>;
      return rows.map((r) => r.name);
    }

    it("writes a migration for a renamedFrom rename alone", async () => {
      const v2 = () => {
        @Entity({ name: "mgck_d_rename" })
        class Profile {
          @PrimaryGeneratedColumn() id!: number;
          @Column({ type: "varchar", length: 40, renamedFrom: "handle" })
          nickname!: string;
        }
        return [Profile];
      };

      const { up, filePath } = await generate(() => {
        @Entity({ name: "mgck_d_rename" })
        class Profile {
          @PrimaryGeneratedColumn() id!: number;
          @Column({ type: "varchar", length: 40 }) handle!: string;
        }
        return [Profile];
      }, v2);

      expect(filePath).not.toBe("");
      expect(up).toHaveLength(1);
      expect(
        await apply(up, v2, (conn) => columnNames(conn, "mgck_d_rename")),
      ).toEqual(["id", "nickname"]);
    }, 60000);

    it("writes a migration for an added computed column alone", async () => {
      const v2 = () => {
        @Entity({ name: "mgck_d_computed" })
        class Line {
          @PrimaryGeneratedColumn() id!: number;
          @Column({ type: "int" }) qty!: number;
          @ComputedColumn({ expression: "qty * 10", type: "int", stored: true })
          total!: number;
        }
        return [Line];
      };

      const { up, filePath } = await generate(() => {
        @Entity({ name: "mgck_d_computed" })
        class Line {
          @PrimaryGeneratedColumn() id!: number;
          @Column({ type: "int" }) qty!: number;
        }
        return [Line];
      }, v2);

      expect(filePath).not.toBe("");
      expect(up).toHaveLength(1);
      expect(
        await apply(up, v2, (conn) => columnNames(conn, "mgck_d_computed")),
      ).toEqual(["id", "qty", "total"]);
    }, 60000);

    if (type === "postgres") {
      it("writes a migration for a value added to an existing enum type", async () => {
        const v2 = () => {
          @Entity({ name: "mgck_d_enum" })
          class Ticket {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "enum", enumValues: ["open", "closed", "archived"] })
            status!: string;
          }
          return [Ticket];
        };

        const { up, filePath } = await generate(() => {
          @Entity({ name: "mgck_d_enum" })
          class Ticket {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "enum", enumValues: ["open", "closed"] })
            status!: string;
          }
          return [Ticket];
        }, v2);

        expect(filePath).not.toBe("");
        expect(up).toEqual([
          `ALTER TYPE "mgck_d_enum_status_enum" ADD VALUE IF NOT EXISTS E'archived'`,
        ]);
        const labels = await apply(up, v2, async (conn) => {
          const rows = (await conn.em.query(
            `SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'mgck_d_enum_status_enum' ORDER BY e.enumsortorder`,
          )) as unknown as Array<{ label: string }>;
          return rows.map((r) => r.label);
        });
        expect(labels).toEqual(["open", "closed", "archived"]);
      }, 60000);
    }
  },
);
