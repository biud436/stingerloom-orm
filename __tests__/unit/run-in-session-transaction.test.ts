/* eslint-disable @typescript-eslint/no-explicit-any */
import { runInSessionTransaction } from "../../src/dialects/runInSessionTransaction";
import { currentTransactionFlow } from "../../src/dialects/TransactionFlow";
import { IConnector } from "../../src/core/IConnector";
import { IDataSource } from "../../src/dialects/IDataSource";
import { DbVersion } from "../../src/dialects/DbVersion";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";

function setup(fail: Partial<Record<"startTransaction" | "commit" | "rollback", Error>> = {}) {
  const calls: string[] = [];
  const session: IDataSource = {
    createConnection: jest.fn(async () => {
      calls.push("createConnection");
    }),
    startTransaction: jest.fn(async () => {
      calls.push("startTransaction");
      if (fail.startTransaction) throw fail.startTransaction;
    }),
    commit: jest.fn(async () => {
      calls.push("commit");
      if (fail.commit) throw fail.commit;
    }),
    rollback: jest.fn(async () => {
      calls.push("rollback");
      if (fail.rollback) throw fail.rollback;
    }),
    close: jest.fn(async () => {
      calls.push("close");
    }),
    query: jest.fn(async (sql: any) => {
      calls.push(`query:${typeof sql === "string" ? sql : sql.sql}`);
      return { results: [{ n: 1 }], fields: [], rowCount: 1 };
    }),
    savepoint: jest.fn(),
    rollbackTo: jest.fn(),
  };
  const version = new DbVersion(16, 2, 0, "16.2");
  const base = {
    query: jest.fn(async () => "base"),
    getVersion: () => version,
  } as unknown as IConnector;
  return { calls, session, base, version };
}

describe("runInSessionTransaction", () => {
  it("runs the work between BEGIN and COMMIT and returns its result", async () => {
    const { calls, session, base } = setup();

    const result = await runInSessionTransaction(base, session, async (connector) => {
      calls.push("work");
      return connector.query("SELECT 1");
    });

    expect(result).toEqual([{ n: 1 }]);
    expect(calls).toEqual(["createConnection", "startTransaction", "work", "query:SELECT 1", "commit", "close"]);
  });

  it("rolls back and rethrows when the work fails", async () => {
    const { calls, session, base } = setup();
    const error = new Error("boom");

    await expect(
      runInSessionTransaction(base, session, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(calls).toEqual(["createConnection", "startTransaction", "rollback", "close"]);
  });

  it("rolls back when BEGIN fails", async () => {
    const error = new Error("begin failed");
    const { calls, session, base } = setup({ startTransaction: error });
    const work = jest.fn();

    await expect(runInSessionTransaction(base, session, work)).rejects.toBe(error);
    expect(work).not.toHaveBeenCalled();
    expect(calls).toEqual(["createConnection", "startTransaction", "rollback", "close"]);
  });

  it("does not roll back after a failed COMMIT, which the connector already rolled back", async () => {
    const error = new Error("commit failed");
    const { calls, session, base } = setup({ commit: error });

    await expect(runInSessionTransaction(base, session, async () => "done")).rejects.toBe(error);
    expect(calls).toEqual(["createConnection", "startTransaction", "commit", "close"]);
  });

  it("reports a failed ROLLBACK together with the error that caused it", async () => {
    const rollbackError = new Error("connection lost");
    const { session, base } = setup({ rollback: rollbackError });
    const error = new Error("boom");

    const thrown = await runInSessionTransaction(base, session, async () => {
      throw error;
    }).catch((e) => e);

    expect(thrown).toBeInstanceOf(OrmError);
    expect(thrown.code).toBe(OrmErrorCode.TRANSACTION_ROLLBACK_FAILED);
    expect(thrown.message).toContain("boom");
    expect(thrown.cause).toBe(error);
    expect(thrown.rollbackError).toBe(rollbackError);
  });

  it("runs the work in a transaction flow of its own", async () => {
    const { session, base } = setup();
    const outside = currentTransactionFlow();

    const inside = await runInSessionTransaction(base, session, async () => currentTransactionFlow());

    expect(outside).toBeUndefined();
    expect(inside).toBeDefined();
  });

  describe("the connector the work gets", () => {
    it("runs statements on the session and returns their rows as a pool query does", async () => {
      const { session, base } = setup();
      (session.query as jest.Mock).mockResolvedValueOnce({ results: [{ id: 7 }], fields: [] });
      (session.query as jest.Mock).mockResolvedValueOnce(undefined);

      const rows = await runInSessionTransaction(base, session, async (connector) => [
        await connector.query("SELECT id FROM t"),
        await connector.query("SELECT nothing"),
      ]);

      expect(rows).toEqual([[{ id: 7 }], undefined]);
      expect(base.query).not.toHaveBeenCalled();
    });

    it("passes a statement for an explicit connection to the pool's connector", async () => {
      const { session, base } = setup();

      const result = await runInSessionTransaction(base, session, (connector) =>
        connector.query("SELECT 1", { explicit: true }),
      );

      expect(result).toBe("base");
      expect(base.query).toHaveBeenCalledWith("SELECT 1", { explicit: true });
    });

    it("reports the pool's server version and a pool of one", async () => {
      const { session, base, version } = setup();

      const [seen, size] = await runInSessionTransaction(base, session, async (connector) => [
        connector.getVersion(),
        connector.getPoolSize(),
      ]);

      expect(seen).toBe(version);
      expect(size).toBe(1);
    });

    it.each([
      ["getConnection", (c: IConnector) => c.getConnection()],
      ["acquireConnection", (c: IConnector) => c.acquireConnection()],
      ["startTransaction", (c: IConnector) => c.startTransaction({})],
      ["commit", (c: IConnector) => c.commit({})],
      ["rollback", (c: IConnector) => c.rollback({})],
      ["close", (c: IConnector) => c.close()],
    ])("refuses %s, which would leave the transaction's connection", async (_name, call) => {
      const { session, base } = setup();

      const thrown = await runInSessionTransaction(base, session, async (connector) =>
        call(connector).then(
          () => null,
          (e) => e,
        ),
      );

      expect(thrown).toBeInstanceOf(OrmError);
      expect(thrown.code).toBe(OrmErrorCode.UNSUPPORTED_OPERATION);
    });
  });
});
