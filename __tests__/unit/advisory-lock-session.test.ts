/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Session advisory locks (PostgreSQL `pg_advisory_lock`, MySQL `GET_LOCK`)
 * belong to the connection that took them. The drivers keep that connection
 * out of the pool until the lock is released, and release it on that same
 * connection. Real-server coverage: integration/migration-runner-real.
 */
import { PostgresDriver } from "../../src/dialects/postgres/PostgresDriver";
import { MySqlDriver } from "../../src/dialects/mysql/MySqlDriver";
import type { IConnector } from "../../src/core/IConnector";

interface FakeConnection {
  name: string;
  release: jest.Mock;
  destroy: jest.Mock;
}

function fakeConnector(lockResult: unknown, poolSize?: number) {
  const sent: Array<{ text: string; on: string }> = [];
  let n = 0;
  const handedOut: FakeConnection[] = [];
  const connector = {
    getVersion: () => undefined,
    getPoolSize: () => poolSize,
    getConnection: jest.fn(async () => {
      const conn: FakeConnection = { name: `c${++n}`, release: jest.fn(), destroy: jest.fn() };
      handedOut.push(conn);
      return conn;
    }),
    query: jest.fn(async (q: any, conn?: FakeConnection) => {
      const text = typeof q === "string" ? q : (q?.text ?? q?.sql ?? "");
      sent.push({ text, on: conn?.name ?? "pool" });
      if (/SHOW statement_timeout/.test(text)) return { results: [{ statement_timeout: "0" }] };
      if (/pg_try_advisory_lock|GET_LOCK/.test(text)) {
        const rows = [{ lock_result: lockResult }];
        return conn ? { results: rows } : rows;
      }
      return conn ? { results: [] } : [];
    }),
  };
  return { connector: connector as unknown as IConnector, raw: connector, sent, handedOut };
}

const drivers = [
  ["PostgresDriver", (c: IConnector) => new PostgresDriver(c), true, /pg_advisory_unlock/],
  ["MySqlDriver", (c: IConnector) => new MySqlDriver(c), 1, /RELEASE_LOCK/],
] as const;

describe.each(drivers)("%s advisory lock session", (_name, make, acquired, unlockPattern) => {
  it.each([0, 5000])(
    "keeps the locking connection until the release, and releases on it (timeout %i)",
    async (timeout) => {
      const { connector, sent, handedOut } = fakeConnector(acquired);
      const driver = make(connector);

      await expect(driver.acquireAdvisoryLock("m", timeout)).resolves.toBe(true);
      expect(handedOut).toHaveLength(1);
      expect(handedOut[0].release).not.toHaveBeenCalled();

      await driver.releaseAdvisoryLock("m");
      const unlock = sent.find((s) => unlockPattern.test(s.text));
      expect(unlock?.on).toBe(handedOut[0].name);
      expect(handedOut[0].release).toHaveBeenCalledTimes(1);
    },
  );

  it("returns the connection at once when the lock is not taken", async () => {
    const notAcquired = acquired === true ? false : 0;
    const { connector, handedOut } = fakeConnector(notAcquired);
    await expect(make(connector).acquireAdvisoryLock("m", 0)).resolves.toBe(false);
    expect(handedOut[0].release).toHaveBeenCalledTimes(1);
  });

  it("discards the connection when the release fails on it", async () => {
    const { connector, raw, handedOut } = fakeConnector(acquired);
    const driver = make(connector);
    await driver.acquireAdvisoryLock("m", 0);
    raw.query.mockRejectedValueOnce(new Error("connection lost"));

    await expect(driver.releaseAdvisoryLock("m")).rejects.toThrow("connection lost");
    const conn = handedOut[0];
    // PostgreSQL destroys a client released with `true`; mysql2 with destroy().
    expect(conn.release.mock.calls.some((c) => c[0] === true) || conn.destroy.mock.calls.length > 0).toBe(
      true,
    );
  });

  it("uses the pool's only connection when the pool has one", async () => {
    const { connector, raw, sent } = fakeConnector(acquired, 1);
    const driver = make(connector);

    await expect(driver.acquireAdvisoryLock("m", 0)).resolves.toBe(true);
    await driver.releaseAdvisoryLock("m");

    expect(raw.getConnection).not.toHaveBeenCalled();
    expect(sent.every((s) => s.on === "pool")).toBe(true);
  });
});
