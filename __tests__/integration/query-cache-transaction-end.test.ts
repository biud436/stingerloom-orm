/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Query cache invalidation at transaction end on a real PostgreSQL / MySQL
 * (MariaDB). A reader on another pooled connection does not see an open
 * transaction's writes, so while the transaction is open it reads — and
 * caches — the state the transaction is replacing. Invalidating at the
 * write left that entry alive after COMMIT until its TTL ran out; the
 * invalidation now runs when the transaction ends.
 *
 * SQLite (one shared connection, the reader sees uncommitted rows):
 * __tests__/integration/sqlite/query-cache-transaction-end.test.ts
 */
import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import {
  createTestConnection,
  dropTestTable,
  rawQuery,
  type TestConnectionResult,
} from "./helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";
import { qi } from "./helpers/driver-helpers";
import { Entity, Column, PrimaryGeneratedColumn } from "../../src";

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (e) {
    return e;
  }
}

describe.each(getTestDrivers())(
  "[Integration] $label: query cache invalidation at transaction end",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let Counter: new () => any;
    let id: number;
    const table = `qcte_${String(Date.now()).slice(-7)}`;

    beforeAll(async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          @Entity({ name: table })
          class QcteCounter {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) name!: string;
            @Column({ type: "int" }) score!: number;
          }
          Counter = QcteCounter;
          return { entities: [QcteCounter] };
        },
      );
      em = conn.em;
    }, 60000);

    beforeEach(async () => {
      await rawQuery(`DELETE FROM ${qi(type, table)}`);
      id = (await em.save(Counter, { name: "a", score: 10 })).id;
      await em.queryCache?.clear();
    });

    afterAll(async () => {
      try {
        await dropTestTable(table);
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 30000);

    const cachedScore = async () =>
      (await em.findOne(Counter, { where: { id }, cache: 60_000 }))?.score;

    it("does not keep the pre-commit value a reader cached while the transaction was open", async () => {
      const written = gate();
      const release = gate();
      const tx = em.transaction(async (t) => {
        await t.update(Counter, { id }, { score: 555 });
        written.open();
        await release.promise;
      });

      await written.promise;
      try {
        // Another connection: the uncommitted 555 is invisible to it.
        expect(await cachedScore()).toBe(10);
      } finally {
        release.open();
      }
      await tx;

      expect(await cachedScore()).toBe(555);
    });

    it("keeps serving the committed value after a rollback", async () => {
      const written = gate();
      const release = gate();
      const tx = em.transaction(async (t) => {
        await t.update(Counter, { id }, { score: 999 });
        written.open();
        await release.promise;
        throw new Error("abort");
      });

      await written.promise;
      try {
        expect(await cachedScore()).toBe(10);
      } finally {
        release.open();
      }
      expect(String(await errorOf(tx))).toMatch(/abort/);

      expect(await cachedScore()).toBe(10);
    });
  },
);
