/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `em.pipe({ keyset: true })` on a real PostgreSQL / MySQL (MariaDB): every
 * row comes back exactly once when the ordering column repeats values or
 * holds NULLs, in the order `findWithCursor` pages.
 *
 * The dialects sort NULLs differently — PostgreSQL last in ascending order,
 * MySQL first — so a keyset that compared the ordering value alone looped on
 * one and dropped the NULL rows on the other.
 */
import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { rawPipelinePlugin } from "../../src/core/plugin/raw-pipeline";
import {
  createTestConnection,
  dropTestTable,
  type TestConnectionResult,
} from "./helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";
import { Entity, Column, PrimaryGeneratedColumn } from "../../src";

const GROUPS = [1, 1, 1, 1, 2, 2, 2];
const SCORES = [null, 5, null, 7, 5, null, 9];

async function drain(gen: AsyncGenerator<any[]>, maxBatches = 50): Promise<any[]> {
  const rows: any[] = [];
  let batches = 0;
  for await (const batch of gen) {
    rows.push(...batch);
    // A keyset that cannot advance repeats a batch forever.
    if (++batches > maxBatches) throw new Error("the pipeline did not terminate");
  }
  return rows;
}

// mysql2 returns every value of a binary({ binary: true }) row as a Buffer.
const ids = (rows: any[]) =>
  rows.map((row) => Number(Buffer.isBuffer(row.id) ? row.id.toString() : row.id));

describe.each(getTestDrivers())(
  "[Integration] $label: em.pipe() keyset batches",
  ({ options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let base: EntityManager;
    let em: any;
    let Item: new () => any;
    const table = `rpks_${String(Date.now()).slice(-7)}`;

    beforeAll(async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          @Entity({ name: table })
          class I {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "int" }) grp!: number;
            @Column({ type: "int", nullable: true }) score!: number | null;
            @Column({ type: "varchar", length: 40 }) label!: string;
          }
          Item = I;
          return { entities: [I] };
        },
      );
      base = conn.em;
      em = base.extend(rawPipelinePlugin());
      for (let i = 0; i < GROUPS.length; i++) {
        await base.save(Item, { grp: GROUPS[i], score: SCORES[i], label: `item${i + 1}` });
      }
    }, 60000);

    afterAll(async () => {
      await dropTestTable(table);
      if (conn) await conn.cleanup();
    }, 30000);

    it("pages a column with repeated values without skipping or repeating a row", async () => {
      for (const direction of ["ASC", "DESC"] as const) {
        const expected = (
          await base.find(Item, { orderBy: { grp: direction, id: direction } } as any)
        ).map((row: any) => Number(row.id));
        for (const batchSize of [1, 2, 3, 4]) {
          const pipe = em.pipe(Item, { orderBy: { grp: direction }, keyset: true, batchSize });
          expect(ids(await drain(pipe.raw()))).toEqual(expected);
          expect(ids(await drain(pipe.binary({})))).toEqual(expected);
          expect(ids(await drain(pipe.binary({ binary: true })))).toEqual(expected);
        }
      }
    });

    it("pages a nullable column in the order findWithCursor does", async () => {
      for (const direction of ["ASC", "DESC"] as const) {
        const viaCursor: number[] = [];
        let cursor: string | undefined;
        do {
          const page: any = await base.findWithCursor(Item, {
            orderBy: "score",
            direction,
            take: 2,
            cursor,
          } as any);
          viaCursor.push(...page.data.map((row: any) => Number(row.id)));
          cursor = page.nextCursor ?? undefined;
        } while (cursor);

        const viaPipe = ids(
          await drain(
            em.pipe(Item, { orderBy: { score: direction }, keyset: true, batchSize: 2 }).raw(),
          ),
        );
        expect(viaPipe).toEqual(viaCursor);
      }
      expect(
        ids(await drain(em.pipe(Item, { orderBy: { score: "ASC" }, keyset: true, batchSize: 2 }).raw())),
      ).toEqual([2, 5, 4, 7, 1, 3, 6]);
      expect(
        ids(await drain(em.pipe(Item, { orderBy: { score: "DESC" }, keyset: true, batchSize: 2 }).raw())),
      ).toEqual([6, 3, 1, 7, 4, 5, 2]);
    });
  },
);
