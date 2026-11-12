/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A string column default that holds a backslash is stored as declared, on
 * real servers (MySQL/MariaDB + PostgreSQL), from both CREATE TABLE and
 * ADD COLUMN.
 *
 * The DEFAULT literal doubled single quotes only. MySQL and MariaDB read a
 * backslash inside a quoted literal as an escape character, so a default
 * ending in one swallowed the closing quote and the statement failed, and
 * `a\nb` was stored with a line break.
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

const TRAILING = "C:\\";
const SEQUENCE = "a\\nb";
const QUOTED = "it's \\'x";

describe.each(getTestDrivers())(
  "[Integration] $label: a backslash in a column default",
  ({ type, options }: TestDriverConfig) => {
    const table = `dbsd_doc_${String(Date.now()).slice(-7)}`;
    let conn: TestConnectionResult | undefined;
    let Doc: any;

    async function boot(declare: () => { entities: any[] }) {
      if (conn) await conn.cleanup();
      conn = await createTestConnection(
        { logging: false, ...options, synchronize: { mode: true, continueOnError: false } } as any,
        declare,
      );
    }

    const v1 = () => {
      @Entity({ name: table })
      class DbsdDoc {
        @PrimaryGeneratedColumn() id!: number;
        @Column() name!: string;
        @Column({ type: "varchar", length: 20, default: TRAILING }) root!: string;
        @Column({ type: "varchar", length: 20, default: SEQUENCE }) sequence!: string;
      }
      return { entities: [DbsdDoc] };
    };
    const v2 = () => {
      @Entity({ name: table })
      class DbsdDoc {
        @PrimaryGeneratedColumn() id!: number;
        @Column() name!: string;
        @Column({ type: "varchar", length: 20, default: TRAILING }) root!: string;
        @Column({ type: "varchar", length: 20, default: SEQUENCE }) sequence!: string;
        @Column({ type: "varchar", length: 20, default: TRAILING }) addedRoot!: string;
        @Column({ type: "varchar", length: 20, default: QUOTED }) addedQuoted!: string;
      }
      Doc = DbsdDoc;
      return { entities: [DbsdDoc] };
    };

    beforeAll(async () => {
      await boot(v1);
      await rawQuery(`INSERT INTO ${qi(type, table)} (${qi(type, "name")}) VALUES ('old')`);
      await boot(v2);
      await rawQuery(`INSERT INTO ${qi(type, table)} (${qi(type, "name")}) VALUES ('new')`);
    }, 60000);

    afterAll(async () => {
      try {
        await dropTestTable(table);
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    });

    it("stores the default CREATE TABLE declared", async () => {
      const rows = await conn!.em.find(Doc, { orderBy: { id: "ASC" } });
      expect(rows.map((r: any) => r.root)).toEqual([TRAILING, TRAILING]);
      expect(rows.map((r: any) => r.sequence)).toEqual([SEQUENCE, SEQUENCE]);
    });

    it("stores the default ADD COLUMN declared, for old and new rows", async () => {
      const rows = await conn!.em.find(Doc, { orderBy: { id: "ASC" } });
      expect(rows.map((r: any) => r.addedRoot)).toEqual([TRAILING, TRAILING]);
      expect(rows.map((r: any) => r.addedQuoted)).toEqual([QUOTED, QUOTED]);
    });
  },
);
