/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `double` is a binary float and `decimal` an exact number on real servers
 * (MySQL/MariaDB + PostgreSQL).
 *
 * `double` used to be created as DECIMAL(10, 2) / NUMERIC(10, 2): every value
 * was rounded to two places, anything above 99,999,999.99 was rejected, and
 * the property held a string. It is now DOUBLE / DOUBLE PRECISION, and an
 * exact column is declared with `decimal`, which reads as a number unless a
 * value would lose digits and as text with `decimalMode: "string"`.
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
import { Column, Entity, PrimaryGeneratedColumn } from "../../src";
import { DatabaseClient } from "../../src/DatabaseClient";
import { SchemaDiff } from "../../src/core/generators/SchemaDiff";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";

const rowsOf = (result: any): any[] =>
  Array.isArray(result) ? result : (result?.rows ?? result?.results ?? []);

describe.each(getTestDrivers())(
  "[Integration] $label: double and decimal columns",
  ({ type, options }: TestDriverConfig) => {
    const suffix = String(Date.now()).slice(-7);
    const table = `ddcd_measure_${suffix}`;
    const legacy = `ddcd_legacy_${suffix}`;
    let conn: TestConnectionResult | undefined;
    let Measure: any;

    async function boot(synchronize: any, declare: () => { entities: any[] }) {
      if (conn) await conn.cleanup();
      conn = undefined;
      conn = await createTestConnection(
        { logging: false, ...options, synchronize } as any,
        declare,
      );
    }

    const measure = () => {
      @Entity({ name: table })
      class DdcdMeasure {
        @PrimaryGeneratedColumn() id!: number;
        @Column({ type: "double" }) ratio!: number;
        @Column({ type: "decimal" }) price!: number;
        @Column({ type: "decimal", precision: 20, scale: 2, decimalMode: "string" }) exact!: string;
        @Column({ type: "decimal", precision: 20, scale: 2, nullable: true }) wide!: number | null;
      }
      Measure = DdcdMeasure;
      return { entities: [DdcdMeasure] };
    };

    const legacyAs = (declared: "double" | "decimal") => () => {
      @Entity({ name: legacy })
      class DdcdLegacy {
        @PrimaryGeneratedColumn() id!: number;
        @Column({ type: declared }) amount!: number;
      }
      return { entities: [DdcdLegacy] };
    };

    const columnsOf = async (name: string) => {
      const cols = rowsOf(
        await rawQuery(
          type === "postgres"
            ? `SELECT column_name, data_type, numeric_precision, numeric_scale FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${name}'`
            : `SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type, NUMERIC_PRECISION AS numeric_precision, NUMERIC_SCALE AS numeric_scale FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${name}'`,
        ),
      );
      return Object.fromEntries(
        cols.map((c) => [
          c.column_name,
          { type: String(c.data_type).toLowerCase(), precision: c.numeric_precision == null ? null : Number(c.numeric_precision), scale: c.numeric_scale == null ? null : Number(c.numeric_scale) },
        ]),
      );
    };

    beforeAll(async () => {
      await boot({ mode: true, continueOnError: false }, measure);
    }, 60000);

    afterAll(async () => {
      for (const name of [table, legacy]) {
        try {
          await dropTestTable(name);
        } catch {
          // ignore
        }
      }
      if (conn) await conn.cleanup();
    });

    it("creates a binary float for double and an exact decimal for decimal", async () => {
      const cols = await columnsOf(table);
      expect(cols.ratio.type).toBe(type === "postgres" ? "double precision" : "double");
      expect(cols.price).toEqual({
        type: type === "postgres" ? "numeric" : "decimal",
        precision: 10,
        scale: 2,
      });
      expect(cols.exact).toMatchObject({ precision: 20, scale: 2 });
    });

    it("keeps every digit of a double and reads both as numbers", async () => {
      const saved: any = await conn!.em.save(Measure, {
        ratio: 1234.56789,
        price: 19.9,
        exact: "123456789012345678.90",
        wide: 1000000000.5,
      });

      const row: any = await conn!.em.findOne(Measure, { where: { id: saved.id } });
      expect(row).toMatchObject({
        ratio: 1234.56789,
        price: 19.9,
        exact: "123456789012345678.90",
        wide: 1000000000.5,
      });
      expect(typeof row.ratio).toBe("number");
      expect(typeof row.price).toBe("number");
    });

    it("refuses to round a decimal a number cannot hold, and reads it exactly in string mode", async () => {
      const saved: any = await conn!.em.save(Measure, {
        ratio: 0,
        price: 0,
        exact: "0",
        wide: null,
      });
      await rawQuery(
        `UPDATE ${qi(type, table)} SET ${qi(type, "wide")} = 123456789012345678.90, ${qi(type, "exact")} = 123456789012345678.90 WHERE ${qi(type, "id")} = ${saved.id}`,
      );

      await expect(
        conn!.em.findOne(Measure, { where: { id: saved.id } }),
      ).rejects.toMatchObject({ code: OrmErrorCode.DECIMAL_PRECISION_LOSS });
      const [exact]: any[] = await conn!.em.find(Measure, {
        select: ["id", "exact"],
        where: { id: saved.id },
      } as any);
      expect(exact.exact).toBe("123456789012345678.90");
    });

    it("reports no drift once synchronize created the columns", async () => {
      const queryRunner = {
        query: async (statement: any) => {
          const connection = await DatabaseClient.getInstance().getConnection();
          const result = await connection.query(statement);
          return (result as any)?.results ?? result;
        },
      };
      const diff = await new SchemaDiff().diff([Measure], queryRunner, type);
      expect(diff.alterColumns).toEqual([]);
      expect(diff.addColumns).toEqual([]);
    });

    it("converts an existing DECIMAL column declared double, unless destructive changes are refused", async () => {
      await rawQuery(
        type === "postgres"
          ? `CREATE TABLE "${legacy}" ("id" SERIAL PRIMARY KEY, "amount" NUMERIC(10, 2) NOT NULL)`
          : `CREATE TABLE \`${legacy}\` (\`id\` INT AUTO_INCREMENT PRIMARY KEY, \`amount\` DECIMAL(10, 2) NOT NULL)`,
      );
      await rawQuery(`INSERT INTO ${qi(type, legacy)} (${qi(type, "amount")}) VALUES (19.90)`);

      // The same column declared decimal: nothing to change.
      await boot({ mode: true, continueOnError: false, failOnDestructiveChange: true }, legacyAs("decimal"));
      expect((await columnsOf(legacy)).amount.type).toBe(type === "postgres" ? "numeric" : "decimal");

      // Declared double: an exact column would become a float.
      let refused: any;
      try {
        await boot({ mode: true, continueOnError: false, failOnDestructiveChange: true }, legacyAs("double"));
      } catch (e) {
        refused = e;
      }
      expect(refused?.code).toBe(OrmErrorCode.SCHEMA_SYNC_DESTRUCTIVE_CHANGE);
      await boot(false, legacyAs("decimal"));
      expect((await columnsOf(legacy)).amount.type).toBe(type === "postgres" ? "numeric" : "decimal");

      await boot({ mode: true, continueOnError: false }, legacyAs("double"));
      expect((await columnsOf(legacy)).amount.type).toBe(type === "postgres" ? "double precision" : "double");
      const rows = rowsOf(await rawQuery(`SELECT ${qi(type, "amount")} AS amount FROM ${qi(type, legacy)}`));
      expect(Number(rows[0].amount)).toBe(19.9);
    }, 60000);
  },
);
