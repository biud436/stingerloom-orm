/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Composite primary keys on real servers (MySQL/MariaDB + PostgreSQL).
 *
 * deleteMany() keyed its DELETE on the first key column only, so a scalar
 * id removed every row sharing it; it now takes full key objects.
 *
 * SQLite mirror: __tests__/integration/sqlite/delete-many-composite-pk.test.ts
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { Entity, Column, PrimaryColumn } from "../../src";
import { InvalidQueryError } from "../../src/errors/InvalidQueryError";
import {
  createTestConnection,
  dropTestTable,
  truncateTestTable,
  TestConnectionResult,
} from "./helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";

const drivers = getTestDrivers();

const TABLE = "cpk_dual_line";

describe.each(drivers)(
  "[Integration] $label: composite primary keys",
  ({ options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let Line: any;

    beforeAll(async () => {
      conn = await createTestConnection(
        { ...options, synchronize: true, logging: false },
        () => {
          @Entity({ name: TABLE })
          class CpkLine {
            @PrimaryColumn({ type: "int" }) orderId!: number;
            @PrimaryColumn({ type: "int", name: "line_no" }) lineNo!: number;
            @Column() sku!: string;
          }
          Line = CpkLine;
          return { entities: [CpkLine] };
        },
      );
      em = conn.em;
    }, 30000);

    afterAll(async () => {
      try {
        await dropTestTable(TABLE);
      } catch {
        // ignore
      }
      await conn.cleanup();
    }, 15000);

    beforeEach(async () => {
      await truncateTestTable(TABLE);
    });

    async function seed(keys: Array<[number, number]>): Promise<void> {
      for (const [orderId, lineNo] of keys) {
        await em.save(Line, { orderId, lineNo, sku: `o${orderId}l${lineNo}` });
      }
    }

    async function skus(): Promise<string[]> {
      const rows: any[] = await em.find(Line, { orderBy: { orderId: "ASC", lineNo: "ASC" } });
      return rows.map((row) => row.sku);
    }

    describe("deleteMany()", () => {
      it("deletes exactly the rows the keys name, not their siblings", async () => {
        await seed([[1, 1], [1, 2], [2, 1], [2, 2]]);

        const result = await em.deleteMany(Line, [
          { orderId: 1, lineNo: 2 },
          { orderId: 2, line_no: 1 },
        ]);

        expect(result.affected).toBe(2);
        expect(await skus()).toEqual(["o1l1", "o2l2"]);
      });

      it("rejects a scalar id and deletes nothing", async () => {
        await seed([[1, 1], [1, 2]]);

        let error: unknown;
        try {
          await em.deleteMany(Line, [1]);
        } catch (e) {
          error = e;
        }

        expect(error).toBeInstanceOf(InvalidQueryError);
        expect(await skus()).toEqual(["o1l1", "o1l2"]);
      });
    });
  },
);
