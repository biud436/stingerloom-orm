/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * TransactionSessionManager transaction-end callbacks: they fire once per
 * transaction, after COMMIT or ROLLBACK, are awaited before commit() /
 * rollback() resolves, and still fire when the ROLLBACK statement fails.
 */
import "reflect-metadata";
import { TransactionSessionManager } from "../../src/dialects/TransactionSessionManager";

function sessionWith(dataSource: Record<string, jest.Mock>): TransactionSessionManager {
  const session = new TransactionSessionManager();
  (session as any).connection = {};
  (session as any).dataSource = dataSource;
  return session;
}

function okDataSource() {
  return {
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
  };
}

describe("TransactionSessionManager transaction-end callbacks", () => {
  it("reports whether a transaction is open", async () => {
    const session = sessionWith(okDataSource());
    expect(session.isTransactionActive).toBe(false);

    await session.startTransaction();
    expect(session.isTransactionActive).toBe(true);
    await session.commit();
    expect(session.isTransactionActive).toBe(false);

    await session.startTransaction();
    await session.rollback();
    expect(session.isTransactionActive).toBe(false);
  });

  it("awaits an async callback before commit() resolves", async () => {
    const session = sessionWith(okDataSource());
    await session.startTransaction();
    const seen: string[] = [];
    session.onTransactionEnd(async (committed) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(`end:${committed}`);
    });

    await session.commit();
    seen.push("commit returned");

    expect(seen).toEqual(["end:true", "commit returned"]);
  });

  it("fires the callbacks once, newest first", async () => {
    const session = sessionWith(okDataSource());
    await session.startTransaction();
    const order: number[] = [];
    session.onTransactionEnd(() => {
      order.push(1);
    });
    session.onTransactionEnd(async () => {
      order.push(2);
    });

    await session.rollback();
    await session.startTransaction();
    await session.commit();

    expect(order).toEqual([2, 1]);
  });

  it("fires the callbacks as rolled back when the ROLLBACK statement fails, and rethrows", async () => {
    const dataSource = okDataSource();
    dataSource.rollback.mockRejectedValue(new Error("connection lost"));
    const session = sessionWith(dataSource);
    await session.startTransaction();
    const outcomes: boolean[] = [];
    session.onTransactionEnd((committed) => {
      outcomes.push(committed);
    });

    await expect(session.rollback()).rejects.toThrow("connection lost");

    expect(outcomes).toEqual([false]);
    expect(session.isTransactionActive).toBe(false);
  });

  it("keeps the callbacks for the ROLLBACK that follows a failed COMMIT", async () => {
    const dataSource = okDataSource();
    dataSource.commit.mockRejectedValue(new Error("serialization failure"));
    const session = sessionWith(dataSource);
    await session.startTransaction();
    const outcomes: boolean[] = [];
    session.onTransactionEnd((committed) => {
      outcomes.push(committed);
    });

    await expect(session.commit()).rejects.toThrow("serialization failure");
    expect(outcomes).toEqual([]);
    expect(session.isTransactionActive).toBe(true);

    await session.rollback();
    expect(outcomes).toEqual([false]);
  });

  it("logs a failing callback instead of failing the commit", async () => {
    const session = sessionWith(okDataSource());
    await session.startTransaction();
    const warn = jest.spyOn((session as any).logger, "warn").mockImplementation(() => {});
    const after = jest.fn();
    session.onTransactionEnd(after);
    session.onTransactionEnd(async () => {
      throw new Error("store down");
    });

    await expect(session.commit()).resolves.toBeUndefined();

    expect(after).toHaveBeenCalledWith(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("store down"));
  });
});
