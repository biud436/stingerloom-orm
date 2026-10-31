/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Composite primary keys on real servers (MySQL/MariaDB + PostgreSQL).
 *
 * deleteMany() keyed its DELETE on the first key column only, so a scalar
 * id removed every row sharing it; it now takes full key objects. Keyset
 * paging (findWithCursor, getCursor, pipe keyset) broke ties by that column alone and
 * skipped the rows sharing a page's boundary value; it now carries the key.
 *
 * SQLite mirrors: __tests__/integration/sqlite/delete-many-composite-pk.test.ts,
 * __tests__/integration/sqlite/cursor-keyset-composite-pk.test.ts
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { Entity, Column, PrimaryColumn } from "../../src";
import { InvalidQueryError } from "../../src/errors/InvalidQueryError";
import { rawPipelinePlugin } from "../../src/core/plugin/raw-pipeline/rawPipelinePlugin";
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
            @Column({ type: "int" }) qty!: number;
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
        await em.save(Line, { orderId, lineNo, sku: `o${orderId}l${lineNo}`, qty: lineNo % 2 });
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

    describe("keyset paging", () => {
      // Out of key order, so insertion order does not hide a skipped row.
      const KEYS: Array<[number, number]> = [3, 1, 2].flatMap((o) =>
        [2, 3, 1].map((l): [number, number] => [o, l]),
      );
      const ALL = ["o1l1", "o1l2", "o1l3", "o2l1", "o2l2", "o2l3", "o3l1", "o3l2", "o3l3"];

      async function walk(option: Record<string, unknown>): Promise<string[]> {
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 20; guard++) {
          const page: any = await em.findWithCursor(Line, { ...option, take: 2, cursor } as any);
          seen.push(...page.data.map((row: any) => row.sku));
          if (!page.hasNextPage) return seen;
          cursor = page.nextCursor;
        }
        throw new Error("cursor walk did not terminate");
      }

      it("findWithCursor() pages every row by the key, both directions", async () => {
        await seed(KEYS);

        expect(await walk({})).toEqual(ALL);
        expect(await walk({ orderBy: "orderId", direction: "DESC" })).toEqual([...ALL].reverse());
      });

      it("findWithCursor() breaks ties of a repeated value by the whole key", async () => {
        await seed(KEYS);

        expect(await walk({ orderBy: "qty" })).toEqual([
          "o1l2", "o2l2", "o3l2",
          "o1l1", "o1l3", "o2l1", "o2l3", "o3l1", "o3l3",
        ]);
      });

      it("query builder getCursor() pages every row by the key", async () => {
        await seed(KEYS);

        const seen: string[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 20; guard++) {
          const page: any = await em
            .createQueryBuilder(Line, "l")
            .getCursor({ take: 2, cursor } as any);
          seen.push(...page.data.map((row: any) => row.sku));
          if (!page.hasNextPage) break;
          cursor = page.nextCursor;
        }

        expect(seen).toEqual(ALL);
      });

      it("pipe keyset reads every row by the first key column", async () => {
        await seed(KEYS);
        const piped: any = em.extend(rawPipelinePlugin());

        const rows: any[] = [];
        for await (const batch of piped
          .pipe(Line, { orderBy: { orderId: "ASC" }, keyset: true, batchSize: 2 })
          .raw()) {
          rows.push(...batch);
        }

        expect(rows.map((row) => row.sku)).toEqual(ALL);
      });
    });
  },
);
