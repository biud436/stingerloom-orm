/**
 * retryOnDeadlock against a real deadlock (V4-T1-2 ②).
 *
 * The deadlock-retry loop had no behavioral coverage at all: the only unit
 * tests were type-level (`opts.retryOnDeadlock` is assignable) plus
 * `isDeadlockError()` on hand-built error objects. Nothing anywhere proved
 * that a *server-produced* deadlock error matches the codes the classifier
 * looks for — the single fact the retry feature hangs on — nor that the loop
 * re-runs the callback and lands the work.
 *
 * The deadlock is the classic cross-lock: two transactions update row A then
 * row B in opposite orders, synchronized with barriers so the cycle always
 * forms. Which side the server kills is the server's choice (InnoDB picks by
 * rollback weight, PostgreSQL by whose deadlock_timeout fires first), so the
 * assertions hold for either victim.
 *
 * The retry-exhaustion test pins the victim deterministically instead: the
 * designated victim only takes SELECT ... FOR UPDATE locks (no undo weight →
 * InnoDB kills the lighter transaction) and is always the first to block
 * (PostgreSQL's self-detection: the waiter whose deadlock_timeout elapses
 * first aborts itself). A fresh partner transaction re-creates the deadlock
 * for every attempt, so the retry budget genuinely runs dry.
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { LockMode } from "../../src/dialects/FindOption";
import {
  createTestConnection,
  truncateTestTable,
  dropTestTable,
  type TestConnectionResult,
} from "./helpers/test-connection";
import {
  createCrudTestEntity,
  type DynamicEntityResult,
} from "./helpers/create-test-entity";
import { getTestDrivers } from "./helpers/driver-config";

const drivers = getTestDrivers();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** True when the error is the driver's native deadlock report. */
function isServerDeadlock(type: string, e: any): boolean {
  if (type === "postgres") return e?.code === "40P01";
  return e?.errno === 1213 || e?.code === "ER_LOCK_DEADLOCK";
}

describe.each(drivers)(
  "[Integration] $label: retryOnDeadlock (V4-T1-2)",
  ({ type, options }) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let entity: DynamicEntityResult;
    let rowA: number;
    let rowB: number;

    beforeAll(async () => {
      conn = await createTestConnection(
        { ...options, synchronize: true, logging: false, pool: { max: 6 } },
        () => {
          entity = createCrudTestEntity("deadlock");
          return { entities: [entity.EntityClass] };
        },
      );
      em = conn.em;
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

    beforeEach(async () => {
      await truncateTestTable(entity.tableName);
      const a: any = await em.save(entity.EntityClass, { name: "a", age: 0 });
      const b: any = await em.save(entity.EntityClass, { name: "b", age: 0 });
      rowA = a.id;
      rowB = b.id;
    }, 20000);

    /**
     * Builds the two cross-locking writers. Each updates its first row,
     * meets the other at the barrier, then updates the row the other holds —
     * the guaranteed cycle. `label` is written into both rows so the test can
     * tell whose commit survived.
     */
    function crossWriters(txOptions: {
      retryOnDeadlock?: boolean;
      maxRetries?: number;
    }) {
      let firstLocked!: () => void;
      const firstReady = new Promise<void>((r) => (firstLocked = r));
      let secondLocked!: () => void;
      const secondReady = new Promise<void>((r) => (secondLocked = r));

      const attempts = { first: 0, second: 0 };

      const first = em.transaction(async (tem) => {
        attempts.first++;
        await tem.save(entity.EntityClass, { id: rowA, name: "first", age: attempts.first });
        firstLocked();
        await secondReady;
        await tem.save(entity.EntityClass, { id: rowB, name: "first", age: attempts.first });
      }, txOptions);

      const second = em.transaction(async (tem) => {
        attempts.second++;
        await tem.save(entity.EntityClass, { id: rowB, name: "second", age: attempts.second });
        secondLocked();
        await firstReady;
        await tem.save(entity.EntityClass, { id: rowA, name: "second", age: attempts.second });
      }, txOptions);

      return { first, second, attempts };
    }

    it(
      "without retryOnDeadlock the server's deadlock error propagates and the victim's writes roll back",
      async () => {
        const { first, second } = crossWriters({});

        const [r1, r2] = await Promise.allSettled([first, second]);
        const outcomes = [r1, r2];

        // The server kills exactly one of the two.
        const rejected = outcomes.filter((o) => o.status === "rejected");
        expect(rejected).toHaveLength(1);

        // The propagated error is the driver's native deadlock report — the
        // exact shape isDeadlockError() classifies, which is what makes
        // retryOnDeadlock able to fire at all.
        const error = (rejected[0] as PromiseRejectedResult).reason;
        expect(isServerDeadlock(type, error)).toBe(true);

        // Atomicity: the survivor's commit covers both rows; nothing of the
        // victim's first update remains.
        const survivor =
          outcomes[0].status === "fulfilled" ? "first" : "second";
        const rows: any[] = await em.find(entity.EntityClass, {
          orderBy: { id: "ASC" } as any,
        });
        expect(rows.map((r) => r.name)).toEqual([survivor, survivor]);
      },
      30000,
    );

    it(
      "with retryOnDeadlock the victim re-runs and both transactions land",
      async () => {
        const warnSpy = jest.spyOn((em as any).logger, "warn");
        try {
          const { first, second, attempts } = crossWriters({
            retryOnDeadlock: true,
            maxRetries: 3,
          });

          // Both must succeed — the victim through a retry.
          await Promise.all([first, second]);

          // One side ran twice, the other once.
          expect(attempts.first + attempts.second).toBe(3);

          // The retry was announced.
          const retryWarns = warnSpy.mock.calls.filter((c) =>
            /Deadlock detected/.test(String(c[0])),
          );
          expect(retryWarns.length).toBeGreaterThanOrEqual(1);

          // The retried transaction ran last, so its name is on both rows —
          // and both its statements committed.
          const retried = attempts.first === 2 ? "first" : "second";
          const rows: any[] = await em.find(entity.EntityClass, {
            orderBy: { id: "ASC" } as any,
          });
          expect(rows.map((r) => r.name)).toEqual([retried, retried]);
        } finally {
          warnSpy.mockRestore();
        }
      },
      30000,
    );

    it(
      "when every retry deadlocks again, the budget runs out and the last error propagates",
      async () => {
        // maxRetries: 1 → two attempts. A fresh partner re-creates the
        // deadlock for each one. The victim is pinned to the retrying side:
        // it holds only SELECT ... FOR UPDATE locks (lightest for InnoDB's
        // victim choice) and is always the first to block (PostgreSQL's
        // self-detecting waiter).
        const ATTEMPTS = 2;
        const partnerHolds: Array<() => void> = [];
        const partnerHoldsReady = Array.from(
          { length: ATTEMPTS },
          (_, i) => new Promise<void>((r) => (partnerHolds[i] = r)),
        );
        const victimBlocking: Array<() => void> = [];
        const victimBlockingReady = Array.from(
          { length: ATTEMPTS },
          (_, i) => new Promise<void>((r) => (victimBlocking[i] = r)),
        );

        let victimAttempts = 0;

        async function runPartner(round: number): Promise<void> {
          await em.transaction(async (tem) => {
            // UPDATE gives this side undo weight → not InnoDB's victim.
            await tem.save(entity.EntityClass, {
              id: rowB,
              name: `partner${round}`,
              age: round,
            });
            partnerHolds[round]();
            await victimBlockingReady[round];
            // Let the victim be the longer-waiting side before closing the
            // cycle (PostgreSQL's victim is the first to hit deadlock_timeout).
            await sleep(300);
            await tem.find(entity.EntityClass, {
              where: { id: rowA } as any,
              lock: LockMode.PESSIMISTIC_WRITE,
            });
          });
        }

        const partners = (async () => {
          for (let round = 0; round < ATTEMPTS; round++) {
            await runPartner(round);
          }
        })();

        const victim = em.transaction(
          async (tem) => {
            const round = victimAttempts++;
            await tem.find(entity.EntityClass, {
              where: { id: rowA } as any,
              lock: LockMode.PESSIMISTIC_WRITE,
            });
            await partnerHoldsReady[round];
            victimBlocking[round]();
            await tem.find(entity.EntityClass, {
              where: { id: rowB } as any,
              lock: LockMode.PESSIMISTIC_WRITE,
            });
          },
          { retryOnDeadlock: true, maxRetries: ATTEMPTS - 1, retryDelayMs: 100 },
        );

        const error = await victim.then(
          () => null,
          (e) => e,
        );

        expect(victimAttempts).toBe(ATTEMPTS);
        expect(error).not.toBeNull();
        expect(isServerDeadlock(type, error)).toBe(true);

        await partners;
      },
      60000,
    );
  },
);
