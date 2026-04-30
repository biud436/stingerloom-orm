/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Regression coverage for `EntityManager.transaction()`'s combined-error path
 * when both the user callback AND the rollback throw (#299).
 *
 * Pre-#299 the only mention of `TRANSACTION_ROLLBACK_FAILED` in the test suite
 * was a string-equality check against the enum value (`type-safety.test.ts`).
 * The runtime contract — combined `OrmError` carrying both `cause` (original)
 * and `rollbackError` (rollback failure) — was never asserted, so a refactor
 * that swallowed the original error or dropped the cause chain would have
 * shipped silently.
 */

jest.mock("../../src/dialects/TransactionSessionManager");

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { TransactionSessionManager } from "../../src/dialects/TransactionSessionManager";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";

const MockedTSM = TransactionSessionManager as jest.MockedClass<
  typeof TransactionSessionManager
>;

type Mocks = {
  connect: jest.Mock;
  startTransaction: jest.Mock;
  commit: jest.Mock;
  rollback: jest.Mock;
  close: jest.Mock;
};

function installSessionMock(overrides?: Partial<Mocks>): Mocks {
  const mocks: Mocks = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  MockedTSM.mockImplementation(() => {
    return {
      connect: mocks.connect,
      startTransaction: mocks.startTransaction,
      commit: mocks.commit,
      rollback: mocks.rollback,
      close: mocks.close,
      query: jest.fn(),
      savepoint: jest.fn(),
      rollbackTo: jest.fn(),
      connectToNode: jest.fn().mockResolvedValue(undefined),
    } as any;
  });
  return mocks;
}

describe("EntityManager.transaction() — combined error on rollback failure (#299)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("wraps callback + rollback failures into a single TRANSACTION_ROLLBACK_FAILED OrmError with both errors preserved", async () => {
    const callbackError = new Error("user callback exploded");
    const rollbackError = new Error("connection lost mid-rollback");

    installSessionMock({
      rollback: jest.fn().mockRejectedValue(rollbackError),
    });

    const em = new EntityManager();

    let caught: unknown;
    try {
      await em.transaction(async () => {
        throw callbackError;
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(OrmError);
    expect((caught as OrmError).code).toBe(
      OrmErrorCode.TRANSACTION_ROLLBACK_FAILED,
    );

    // Original error must be preserved on `.cause` so debuggers (and Node's
    // built-in error chaining) can walk back to the root cause.
    const cause = (caught as any).cause as Error;
    expect(cause).toBeDefined();
    expect(cause.message).toBe("user callback exploded");

    // Rollback failure preserved separately so users can distinguish
    // "transaction failed" from "transaction failed AND rollback failed".
    const rollbackErr = (caught as any).rollbackError as Error;
    expect(rollbackErr).toBeDefined();
    expect(rollbackErr.message).toBe("connection lost mid-rollback");

    // The combined message should at least surface the original error so the
    // user sees the root cause without having to inspect `.cause`.
    expect((caught as OrmError).message).toContain("user callback exploded");
  });

  it("rethrows the original error unchanged when rollback succeeds", async () => {
    // Negative test: the wrapping ONLY happens on rollback failure. If the
    // catch block ever wraps the original error unconditionally, this fails.
    const original = new Error("plain old user error");
    installSessionMock({
      // rollback succeeds (default)
    });

    const em = new EntityManager();

    let caught: unknown;
    try {
      await em.transaction(async () => {
        throw original;
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBe(original);
    expect(caught).not.toBeInstanceOf(OrmError);
  });

  it("still calls session.close() in the finally even when both errors fire", async () => {
    const mocks = installSessionMock({
      rollback: jest.fn().mockRejectedValue(new Error("rollback boom")),
    });

    const em = new EntityManager();

    await expect(
      em.transaction(async () => {
        throw new Error("callback boom");
      }),
    ).rejects.toBeInstanceOf(OrmError);

    // The finally branch runs regardless — without it the connection would
    // leak even on the worst-case path.
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
});
