/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * TransactionSessionManager.onRollback: undo actions run when the work they
 * cover is rolled back — on ROLLBACK, or on ROLLBACK TO a savepoint taken
 * before they were registered — and are dropped on COMMIT.
 */
import "reflect-metadata";
import { TransactionSessionManager } from "../../src/dialects/TransactionSessionManager";

function okDataSource() {
  return {
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
    savepoint: jest.fn().mockResolvedValue(undefined),
    rollbackTo: jest.fn().mockResolvedValue(undefined),
  };
}

function sessionWith(dataSource = okDataSource()): TransactionSessionManager {
  const session = new TransactionSessionManager();
  (session as any).connection = {};
  (session as any).dataSource = dataSource;
  return session;
}

describe("TransactionSessionManager rollback undo actions", () => {
  it("runs the undo actions newest first on rollback, once", async () => {
    const session = sessionWith();
    await session.startTransaction();
    const order: string[] = [];
    session.onRollback(() => order.push("first"));
    session.onRollback(() => order.push("second"));

    await session.rollback();
    await session.startTransaction();
    await session.rollback();

    expect(order).toEqual(["second", "first"]);
  });

  it("drops the undo actions on commit", async () => {
    const session = sessionWith();
    await session.startTransaction();
    const undo = jest.fn();
    session.onRollback(undo);

    await session.commit();
    await session.startTransaction();
    await session.rollback();

    expect(undo).not.toHaveBeenCalled();
  });

  it("ignores an undo action registered outside a transaction", async () => {
    const session = sessionWith();
    const undo = jest.fn();
    session.onRollback(undo);

    await session.startTransaction();
    await session.rollback();

    expect(undo).not.toHaveBeenCalled();
  });

  it("runs the undo actions before the transaction-end callbacks", async () => {
    const session = sessionWith();
    await session.startTransaction();
    const order: string[] = [];
    session.onTransactionEnd(() => {
      order.push("end");
    });
    session.onRollback(() => order.push("undo"));

    await session.rollback();

    expect(order).toEqual(["undo", "end"]);
  });

  it("still runs the undo actions when the ROLLBACK statement fails", async () => {
    const dataSource = okDataSource();
    dataSource.rollback.mockRejectedValue(new Error("connection lost"));
    const session = sessionWith(dataSource);
    await session.startTransaction();
    const undo = jest.fn();
    session.onRollback(undo);

    await expect(session.rollback()).rejects.toThrow("connection lost");

    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("keeps the undo actions for the ROLLBACK that follows a failed COMMIT", async () => {
    const dataSource = okDataSource();
    dataSource.commit.mockRejectedValue(new Error("serialization failure"));
    const session = sessionWith(dataSource);
    await session.startTransaction();
    const undo = jest.fn();
    session.onRollback(undo);

    await expect(session.commit()).rejects.toThrow("serialization failure");
    expect(undo).not.toHaveBeenCalled();

    await session.rollback();
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("logs a failing undo action and runs the rest", async () => {
    const session = sessionWith();
    await session.startTransaction();
    const warn = jest.spyOn((session as any).logger, "warn").mockImplementation(() => {});
    const earlier = jest.fn();
    session.onRollback(earlier);
    session.onRollback(() => {
      throw new Error("frozen object");
    });

    await expect(session.rollback()).resolves.toBeUndefined();

    expect(earlier).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("frozen object"));
  });

  describe("savepoints", () => {
    it("runs only the undo actions registered after the savepoint on rollbackTo()", async () => {
      const session = sessionWith();
      await session.startTransaction();
      const order: string[] = [];
      session.onRollback(() => order.push("before savepoint"));
      await session.savepoint("sp_1");
      session.onRollback(() => order.push("after savepoint 1"));
      session.onRollback(() => order.push("after savepoint 2"));

      await session.rollbackTo("sp_1");
      expect(order).toEqual(["after savepoint 2", "after savepoint 1"]);

      await session.rollback();
      expect(order).toEqual(["after savepoint 2", "after savepoint 1", "before savepoint"]);
    });

    it("keeps the savepoint after rollbackTo(), for work registered after it", async () => {
      const session = sessionWith();
      await session.startTransaction();
      const undo = jest.fn();
      await session.savepoint("sp_1");
      await session.rollbackTo("sp_1");
      session.onRollback(undo);

      await session.rollbackTo("sp_1");

      expect(undo).toHaveBeenCalledTimes(1);
    });

    it("rolls back through a nested savepoint taken after the target", async () => {
      const session = sessionWith();
      await session.startTransaction();
      const order: string[] = [];
      await session.savepoint("outer");
      session.onRollback(() => order.push("in outer"));
      await session.savepoint("inner");
      session.onRollback(() => order.push("in inner"));

      await session.rollbackTo("outer");
      expect(order).toEqual(["in inner", "in outer"]);

      // "inner" no longer exists: rolling back to it undoes nothing more.
      session.onRollback(() => order.push("after"));
      await session.rollbackTo("inner");
      expect(order).toEqual(["in inner", "in outer"]);
    });

    it("keeps the undo actions after the savepoint when ROLLBACK TO fails", async () => {
      const dataSource = okDataSource();
      dataSource.rollbackTo.mockRejectedValue(new Error("no such savepoint"));
      const session = sessionWith(dataSource);
      await session.startTransaction();
      const undo = jest.fn();
      await session.savepoint("sp_1");
      session.onRollback(undo);

      await expect(session.rollbackTo("sp_1")).rejects.toThrow("no such savepoint");
      expect(undo).not.toHaveBeenCalled();

      await session.rollback();
      expect(undo).toHaveBeenCalledTimes(1);
    });
  });
});
