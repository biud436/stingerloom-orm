/**
 * queryTimeout on a real server (V4-T1-2 ①).
 *
 * `queryTimeout` / `FindOption.timeout` had zero integration coverage: the
 * unit suite only asserted the SQL string each driver returns from
 * `setQueryTimeout()`, never that a server accepts it, that it cancels
 * anything, or what the caller ends up catching. Everything below needs a real
 * server, and each case failed before the accompanying fix:
 *
 *  1. **MariaDB rejected the statement outright.** `SET SESSION
 *     max_execution_time` is MySQL-only; MariaDB answers
 *     ER_UNKNOWN_SYSTEM_VARIABLE (1193), so every timed read failed with an
 *     unrelated error instead of timing out.
 *  2. **The caller never saw `QueryTimeoutError`.** It was exported and
 *     documented ("Stingerloom throws a QueryTimeoutError") but thrown from
 *     nowhere — the raw driver error surfaced instead.
 *  3. **PostgreSQL ignored the connection-level timeout on findAndCount.**
 *     Only the per-query value decided whether the read got a transaction,
 *     and `SET LOCAL` outside one is accepted-and-discarded by the server, so
 *     the statement ran unbounded.
 *  4. **MySQL/MariaDB leaked a per-query override into the pool.** `SET
 *     SESSION` outlives the query, so the override stayed on the pooled
 *     connection and silently applied to whatever ran next.
 *
 * The slow query under test is a read blocked by another transaction's row
 * lock — deterministic, and the case that matters in production (a runaway
 * lock wait pinning a pool connection). Measured 2026-08-22, every supported
 * server cancels that wait: PostgreSQL 16.13 `statement_timeout` (SQLSTATE
 * 57014), MariaDB 11.8.6 `max_statement_time` (errno 1969), and MySQL 8
 * `max_execution_time` (errno 3024) — the last one *despite* its manual
 * scoping it to read-only SELECTs; in CI the lock-blocked
 * `SELECT ... FOR UPDATE` is interrupted all the same. So the contract is
 * uniform: the blocked read dies with `QueryTimeoutError` well before the
 * lock is released.
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { LockMode } from "../../src/dialects/FindOption";
import { QueryTimeoutError } from "../../src/errors/QueryTimeoutError";
import {
  createTestConnection,
  dropTestTable,
  type TestConnectionResult,
} from "./helpers/test-connection";
import {
  createCrudTestEntity,
  type DynamicEntityResult,
} from "./helpers/create-test-entity";
import { getTestDrivers } from "./helpers/driver-config";

const drivers = getTestDrivers();

/** Milliseconds the lock holder keeps the row before releasing on its own. */
const HOLD_MS = 4000;
/** Timeout handed to the reads that are expected to be cancelled. */
const TIMEOUT_MS = 300;

interface LockHolder {
  release: () => void;
  done: Promise<void>;
}

describe.each(drivers)(
  "[Integration] $label: queryTimeout (V4-T1-2)",
  ({ options }) => {
    describe.each([
      {
        scope: "per-query timeout",
        connOptions: {},
        // What the cancelled read should carry / the plain read should use.
        findTimeout: TIMEOUT_MS,
      },
      {
        scope: "connection-level queryTimeout",
        connOptions: { queryTimeout: TIMEOUT_MS },
        findTimeout: undefined,
      },
    ])("$scope", ({ scope, connOptions, findTimeout }) => {
      let conn: TestConnectionResult;
      let em: EntityManager;
      let entity: DynamicEntityResult;
      let rowId: number;

      beforeAll(async () => {
        conn = await createTestConnection(
          {
            ...options,
            ...connOptions,
            synchronize: true,
            logging: false,
            pool: { max: 4 },
          },
          () => {
            entity = createCrudTestEntity(
              scope.startsWith("per") ? "qtimeout" : "qtimeout_conn",
            );
            return { entities: [entity.EntityClass] };
          },
        );
        em = conn.em;

        const saved: any = await em.save(entity.EntityClass, {
          name: "locked",
          age: 1,
        });
        rowId = saved.id;
      }, 30000);

      afterAll(async () => {
        if (!conn) return;
        try {
          await dropTestTable(entity.tableName);
        } catch {
          // ignore
        }
        await conn.cleanup();
      }, 15000);

      /**
       * Locks the seeded row in its own transaction and resolves once the
       * lock is held. `release` unblocks it; the holder also releases by
       * itself after HOLD_MS so a failed expectation can never wedge the
       * suite. The holder's own reads are instant (nobody contends at acquire
       * time), so a connection-level timeout never cancels the holder.
       */
      async function holdRowLock(): Promise<LockHolder> {
        let acquired!: () => void;
        const held = new Promise<void>((r) => (acquired = r));
        let release!: () => void;
        const releaseSignal = new Promise<void>((r) => (release = r));

        const done = em.transaction(async (tem) => {
          await tem.find(entity.EntityClass, {
            where: { id: rowId } as any,
            lock: LockMode.PESSIMISTIC_WRITE,
          });
          acquired();
          await Promise.race([
            releaseSignal,
            new Promise<void>((r) => setTimeout(r, HOLD_MS)),
          ]);
        });

        await held;
        return { release, done };
      }

      /**
       * Runs `read` against a row lock held by another transaction and
       * asserts the uniform timeout contract: the read dies with
       * `QueryTimeoutError` well before the holder lets go, carrying the
       * driver's cancellation as `cause`. On MariaDB the fail-before was an
       * unrelated ER_UNKNOWN_SYSTEM_VARIABLE here instead.
       */
      async function expectLockedReadContract(
        read: () => Promise<unknown[]>,
        _holder: LockHolder,
      ): Promise<void> {
        const started = Date.now();

        const error = await read().then(
          () => null,
          (e) => e,
        );
        expect(error).toBeInstanceOf(QueryTimeoutError);
        expect((error as QueryTimeoutError).cause).toBeInstanceOf(Error);
        expect(Date.now() - started).toBeLessThan(HOLD_MS - 500);
      }

      it(
        "a blocked find() follows the server's timeout contract",
        async () => {
          const holder = await holdRowLock();
          try {
            await expectLockedReadContract(
              () =>
                em.find(entity.EntityClass, {
                  where: { id: rowId } as any,
                  lock: LockMode.PESSIMISTIC_WRITE,
                  ...(findTimeout !== undefined
                    ? { timeout: findTimeout }
                    : {}),
                }),
              holder,
            );
          } finally {
            holder.release();
            await holder.done;
          }
        },
        HOLD_MS + 20000,
      );

      it(
        "a blocked findAndCount() follows it too (PostgreSQL ran unbounded before)",
        async () => {
          const holder = await holdRowLock();
          try {
            await expectLockedReadContract(
              async () => {
                const [rows] = await em.findAndCount(entity.EntityClass, {
                  where: { id: rowId } as any,
                  lock: LockMode.PESSIMISTIC_WRITE,
                  ...(findTimeout !== undefined
                    ? { timeout: findTimeout }
                    : {}),
                });
                return rows;
              },
              holder,
            );
          } finally {
            holder.release();
            await holder.done;
          }
        },
        HOLD_MS + 20000,
      );

      it(
        "the next read on the pool is not poisoned by the previous timeout",
        async () => {
          // First read: runs under a 300ms budget (per-query override in the
          // per-query variant; the connection default otherwise).
          const first = await holdRowLock();
          try {
            await expectLockedReadContract(
              () =>
                em.find(entity.EntityClass, {
                  where: { id: rowId } as any,
                  lock: LockMode.PESSIMISTIC_WRITE,
                  ...(findTimeout !== undefined
                    ? { timeout: findTimeout }
                    : {}),
                }),
              first,
            );
          } finally {
            first.release();
            await first.done;
          }

          // Second read: an explicit budget WIDER than the wait it faces. It
          // must survive a lock held past the 300ms the session was set to —
          // before the restore fix, MariaDB's SET SESSION from the first read
          // stayed on the pooled connection and cancelled this one.
          const second = await holdRowLock();
          const releaseTimer = setTimeout(() => second.release(), 800);
          try {
            const rows = await em.find(entity.EntityClass, {
              where: { id: rowId } as any,
              lock: LockMode.PESSIMISTIC_WRITE,
              timeout: HOLD_MS + 5000,
            });
            expect(rows).toHaveLength(1);
          } finally {
            clearTimeout(releaseTimer);
            second.release();
            await second.done;
          }
        },
        HOLD_MS * 2 + 30000,
      );

      it("an uncontended read under the timeout just returns rows", async () => {
        const rows = await em.find(entity.EntityClass, {
          where: { id: rowId } as any,
          ...(findTimeout !== undefined ? { timeout: findTimeout } : {}),
        });
        expect(rows).toHaveLength(1);
      });

      it("count() runs under the timeout and succeeds", async () => {
        // The aggregate path never issued the timeout statement before; this
        // pins that it now does — and that an instant COUNT still succeeds.
        await expect(em.count(entity.EntityClass)).resolves.toBeGreaterThan(0);
      });
    });
  },
);
