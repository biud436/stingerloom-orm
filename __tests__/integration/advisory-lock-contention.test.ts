/**
 * The migration / seeder advisory lock on a real PostgreSQL / MySQL
 * (MariaDB): a lock another session holds makes a timed acquire return
 * false once the timeout elapses — the only failure reported that way —
 * and the lock is acquirable once that session releases it.
 */
import "reflect-metadata";
import sql from "../../src/utils/sqlTag";
import { createTestConnection, type TestConnectionResult } from "./helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";

describe.each(getTestDrivers())(
  "[Integration] $label: advisory lock contention",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    const lockId = `advisory_contention_${String(Date.now()).slice(-7)}`;

    beforeAll(async () => {
      conn = await createTestConnection({ synchronize: false, logging: false, ...options });
    }, 60000);

    afterAll(async () => {
      if (conn) await conn.cleanup();
    }, 30000);

    it("returns false after the timeout while another session holds the lock, true once it is released", async () => {
      const driver = conn.em.getDriver()!;
      const key = type === "postgres" ? (driver as any).hashLockId(lockId) : lockId;
      const [take, give] =
        type === "postgres"
          ? [sql`SELECT pg_advisory_lock(${key})`, sql`SELECT pg_advisory_unlock(${key})`]
          : [sql`SELECT GET_LOCK(${key}, 0)`, sql`SELECT RELEASE_LOCK(${key})`];

      // The transaction's connection is the other session holding the lock.
      await conn.em.transaction(async (tx) => {
        await tx.query(take);
        try {
          expect(await driver.acquireAdvisoryLock(lockId, 1000)).toBe(false);
        } finally {
          await tx.query(give);
        }
      });

      expect(await driver.acquireAdvisoryLock(lockId, 1000)).toBe(true);
      await driver.releaseAdvisoryLock(lockId);
    }, 30000);
  },
);
