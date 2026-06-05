/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Coverage for the decorator-free transaction options on `em.transaction()`.
 *
 * These bring the programmatic API to parity with `@Transactional` so the
 * decorator is never the *only* way to set isolation level, propagation, or
 * the target connection.
 */

jest.mock("../../src/dialects/TransactionSessionManager");

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { TransactionSessionManager } from "../../src/dialects/TransactionSessionManager";
import { TransactionPropagation } from "../../src/decorators/Transactional";

const MockedTSM = TransactionSessionManager as jest.MockedClass<
  typeof TransactionSessionManager
>;

type Mocks = {
  connect: jest.Mock;
  startTransaction: jest.Mock;
  commit: jest.Mock;
  rollback: jest.Mock;
  close: jest.Mock;
  savepoint: jest.Mock;
  rollbackTo: jest.Mock;
};

function installSessionMock(): Mocks {
  const mocks: Mocks = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    savepoint: jest.fn().mockResolvedValue(undefined),
    rollbackTo: jest.fn().mockResolvedValue(undefined),
  };
  MockedTSM.mockImplementation(
    () =>
      ({
        connect: mocks.connect,
        startTransaction: mocks.startTransaction,
        commit: mocks.commit,
        rollback: mocks.rollback,
        close: mocks.close,
        savepoint: mocks.savepoint,
        rollbackTo: mocks.rollbackTo,
        query: jest.fn(),
        connectToNode: jest.fn().mockResolvedValue(undefined),
      }) as any,
  );
  return mocks;
}

describe("EntityManager.transaction() — decorator-free options", () => {
  let mocks: Mocks;

  beforeEach(() => {
    jest.clearAllMocks();
    mocks = installSessionMock();
  });

  describe("isolationLevel", () => {
    it("forwards the isolation level to startTransaction()", async () => {
      const em = new EntityManager();
      await em.transaction(async () => "ok", { isolationLevel: "SERIALIZABLE" });
      expect(mocks.startTransaction).toHaveBeenCalledWith("SERIALIZABLE");
    });

    it("starts with the driver default when no isolation level is given", async () => {
      const em = new EntityManager();
      await em.transaction(async () => "ok");
      expect(mocks.startTransaction).toHaveBeenCalledWith(undefined);
    });
  });

  describe("connectionName", () => {
    it("connects on the named connection", async () => {
      const em = new EntityManager();
      await em.transaction(async () => "ok", { connectionName: "replica" });
      expect(mocks.connect).toHaveBeenCalledWith("replica");
    });
  });

  describe("propagation: REQUIRED (default)", () => {
    it("reuses the ambient transaction for a nested call", async () => {
      const em = new EntityManager();
      await em.transaction(async (outer) => {
        await outer.transaction(async () => "inner");
        return "outer";
      });

      // Only the outer transaction opens a session.
      expect(MockedTSM).toHaveBeenCalledTimes(1);
      expect(mocks.startTransaction).toHaveBeenCalledTimes(1);
      expect(mocks.commit).toHaveBeenCalledTimes(1);
    });
  });

  describe("propagation: REQUIRES_NEW", () => {
    it("opens a fresh session even inside an ambient transaction", async () => {
      const em = new EntityManager();
      await em.transaction(async (outer) => {
        await outer.transaction(async () => "inner", {
          propagation: TransactionPropagation.REQUIRES_NEW,
        });
        return "outer";
      });

      // Outer + inner each open their own session.
      expect(MockedTSM).toHaveBeenCalledTimes(2);
      expect(mocks.startTransaction).toHaveBeenCalledTimes(2);
      expect(mocks.commit).toHaveBeenCalledTimes(2);
    });

    it("opens a session even when there is no ambient transaction", async () => {
      const em = new EntityManager();
      await em.transaction(async () => "fresh", {
        propagation: TransactionPropagation.REQUIRES_NEW,
      });
      expect(MockedTSM).toHaveBeenCalledTimes(1);
      expect(mocks.commit).toHaveBeenCalledTimes(1);
    });
  });

  describe("propagation: NESTED", () => {
    it("creates a savepoint within the ambient transaction", async () => {
      const em = new EntityManager();
      await em.transaction(async (outer) => {
        await outer.transaction(async () => "nested", {
          propagation: TransactionPropagation.NESTED,
        });
        return "outer";
      });

      // No second session — the nested block runs on a savepoint.
      expect(MockedTSM).toHaveBeenCalledTimes(1);
      expect(mocks.savepoint).toHaveBeenCalledTimes(1);
      expect(mocks.savepoint).toHaveBeenCalledWith(
        expect.stringMatching(/^sp_em_\d+$/),
      );
      expect(mocks.commit).toHaveBeenCalledTimes(1);
    });

    it("rolls back to the savepoint on inner error, leaving the outer tx intact", async () => {
      const em = new EntityManager();
      const result = await em.transaction(async (outer) => {
        try {
          await outer.transaction(
            async () => {
              throw new Error("inner failed");
            },
            { propagation: TransactionPropagation.NESTED },
          );
        } catch {
          // swallow so the outer can commit
        }
        return "outer-ok";
      });

      expect(result).toBe("outer-ok");
      expect(mocks.savepoint).toHaveBeenCalledTimes(1);
      expect(mocks.rollbackTo).toHaveBeenCalledTimes(1);
      expect(mocks.commit).toHaveBeenCalledTimes(1);
      expect(mocks.rollback).not.toHaveBeenCalled();
    });

    it("falls back to opening a transaction when there is no ambient session", async () => {
      const em = new EntityManager();
      await em.transaction(async () => "no-parent", {
        propagation: TransactionPropagation.NESTED,
      });

      expect(MockedTSM).toHaveBeenCalledTimes(1);
      expect(mocks.startTransaction).toHaveBeenCalledTimes(1);
      expect(mocks.savepoint).not.toHaveBeenCalled();
    });
  });
});
