/* eslint-disable @typescript-eslint/no-explicit-any */
import { PostgresConnector } from "../../src/dialects/postgres/PostgresConnector";
import { PostgresDataSource } from "../../src/dialects/postgres/PostgresDataSource";

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

type ClientStub = {
  query: jest.Mock;
  release: jest.Mock;
};

function makeClient(queryImpl: (sql: string) => Promise<unknown>): ClientStub {
  return {
    query: jest.fn(queryImpl),
    release: jest.fn(),
  };
}

// ──────────────────────────────────────────────
// PostgresConnector.rollback — Issue #283
// ──────────────────────────────────────────────

describe("PostgresConnector — pool client leak on commit/rollback errors (#283)", () => {
  describe("rollback()", () => {
    it("releases the client normally when ROLLBACK succeeds", async () => {
      const connector = new PostgresConnector();
      const client = makeClient(async () => ({ rows: [] }));

      await connector.rollback(client);

      expect(client.query).toHaveBeenCalledWith("ROLLBACK");
      expect(client.release).toHaveBeenCalledTimes(1);
      // non-destructive release (no truthy arg)
      expect(client.release.mock.calls[0][0]).toBeFalsy();
    });

    it("destructively releases the client exactly once when ROLLBACK throws", async () => {
      const connector = new PostgresConnector();
      const rollbackErr = new Error("connection lost");
      const client = makeClient(async (sql) => {
        if (sql === "ROLLBACK") throw rollbackErr;
        return { rows: [] };
      });

      await expect(connector.rollback(client)).rejects.toBe(rollbackErr);

      expect(client.release).toHaveBeenCalledTimes(1);
      expect(client.release).toHaveBeenCalledWith(true);
    });
  });

  describe("commit()", () => {
    it("releases the client normally when COMMIT succeeds", async () => {
      const connector = new PostgresConnector();
      const client = makeClient(async () => ({ rows: [] }));

      await connector.commit(client);

      expect(client.query).toHaveBeenCalledWith("COMMIT");
      expect(client.release).toHaveBeenCalledTimes(1);
      expect(client.release.mock.calls[0][0]).toBeFalsy();
    });

    it("rolls back and releases when COMMIT throws but recovery ROLLBACK succeeds", async () => {
      const connector = new PostgresConnector();
      const commitErr = new Error("commit failed");
      const client = makeClient(async (sql) => {
        if (sql === "COMMIT") throw commitErr;
        return { rows: [] };
      });

      await expect(connector.commit(client)).rejects.toBe(commitErr);

      const sqls = client.query.mock.calls.map((c) => c[0]);
      expect(sqls).toEqual(["COMMIT", "ROLLBACK"]);
      expect(client.release).toHaveBeenCalledTimes(1);
      expect(client.release.mock.calls[0][0]).toBeFalsy();
    });

    it("destructively releases exactly once when both COMMIT and recovery ROLLBACK throw, and propagates the original commit error", async () => {
      const connector = new PostgresConnector();
      const commitErr = new Error("commit failed");
      const rollbackErr = new Error("rollback also failed");
      const client = makeClient(async (sql) => {
        if (sql === "COMMIT") throw commitErr;
        if (sql === "ROLLBACK") throw rollbackErr;
        return { rows: [] };
      });

      await expect(connector.commit(client)).rejects.toBe(commitErr);

      expect(client.release).toHaveBeenCalledTimes(1);
      expect(client.release).toHaveBeenCalledWith(true);
    });
  });
});

// ──────────────────────────────────────────────
// PostgresDataSource — connection ref hygiene
// ──────────────────────────────────────────────

describe("PostgresDataSource — connection ref cleared on connector errors (#283)", () => {
  function makeStubConnector(behavior: {
    commit?: () => Promise<void>;
    rollback?: () => Promise<void>;
  }) {
    return {
      getConnection: jest.fn(async () => ({ id: "client" })),
      acquireConnection: jest.fn(),
      runTestSql: jest.fn(),
      close: jest.fn(),
      query: jest.fn(),
      startTransaction: jest.fn(),
      setTransactionIsolationLevel: jest.fn(),
      commit: jest.fn(behavior.commit ?? (async () => undefined)),
      rollback: jest.fn(behavior.rollback ?? (async () => undefined)),
      getVersion: jest.fn(),
    } as any;
  }

  it("clears connection ref after a successful rollback", async () => {
    const connector = makeStubConnector({});
    const ds = new PostgresDataSource(connector);
    await ds.createConnection();

    await ds.rollback();

    expect((ds as any).connection).toBeUndefined();
  });

  it("clears connection ref even when connector.rollback throws", async () => {
    const connector = makeStubConnector({
      rollback: async () => {
        throw new Error("rollback failed");
      },
    });
    const ds = new PostgresDataSource(connector);
    await ds.createConnection();

    await expect(ds.rollback()).rejects.toThrow("rollback failed");
    expect((ds as any).connection).toBeUndefined();
  });

  it("clears connection ref after a successful commit", async () => {
    const connector = makeStubConnector({});
    const ds = new PostgresDataSource(connector);
    await ds.createConnection();

    await ds.commit();

    expect((ds as any).connection).toBeUndefined();
  });

  it("clears connection ref even when connector.commit throws", async () => {
    const connector = makeStubConnector({
      commit: async () => {
        throw new Error("commit failed");
      },
    });
    const ds = new PostgresDataSource(connector);
    await ds.createConnection();

    await expect(ds.commit()).rejects.toThrow("commit failed");
    expect((ds as any).connection).toBeUndefined();
  });

  it("close() after a thrown commit does not double-release", async () => {
    const connector = makeStubConnector({
      commit: async () => {
        throw new Error("commit failed");
      },
    });
    const ds = new PostgresDataSource(connector);
    await ds.createConnection();

    await expect(ds.commit()).rejects.toThrow();

    // close() should be a no-op since connection has been cleared.
    await ds.close();
    // No assertion target is needed beyond not throwing — the connector's
    // commit/rollback already released the client; if connection were still
    // set, close() would call release() again on a destroyed client.
    expect((ds as any).connection).toBeUndefined();
  });
});
