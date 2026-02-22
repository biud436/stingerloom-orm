/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { Transactional, transactionStorage } from "../../src/decorators/Transactional";
import { TransactionSessionManager } from "../../src/dialects/TransactionSessionManager";

// Mock TransactionSessionManager
jest.mock("../../src/dialects/TransactionSessionManager");

const MockedTSM = TransactionSessionManager as jest.MockedClass<
  typeof TransactionSessionManager
>;

describe("@Transactional decorator", () => {
  let mockConnect: jest.Mock;
  let mockStartTransaction: jest.Mock;
  let mockCommit: jest.Mock;
  let mockRollback: jest.Mock;
  let mockClose: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    mockConnect = jest.fn().mockResolvedValue(undefined);
    mockStartTransaction = jest.fn().mockResolvedValue(undefined);
    mockCommit = jest.fn().mockResolvedValue(undefined);
    mockRollback = jest.fn().mockResolvedValue(undefined);
    mockClose = jest.fn().mockResolvedValue(undefined);

    MockedTSM.mockImplementation(() => {
      return {
        connect: mockConnect,
        startTransaction: mockStartTransaction,
        commit: mockCommit,
        rollback: mockRollback,
        close: mockClose,
        query: jest.fn(),
        savepoint: jest.fn(),
        rollbackTo: jest.fn(),
      } as any;
    });
  });

  it("should COMMIT on successful execution", async () => {
    class TestService {
      @Transactional()
      async doWork() {
        return "done";
      }
    }

    const service = new TestService();
    const result = await service.doWork();

    expect(result).toBe("done");
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockStartTransaction).toHaveBeenCalledTimes(1);
    expect(mockCommit).toHaveBeenCalledTimes(1);
    expect(mockRollback).not.toHaveBeenCalled();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("should ROLLBACK on exception and rethrow the error", async () => {
    const testError = new Error("Something went wrong");

    class TestService {
      @Transactional()
      async doWork() {
        throw testError;
      }
    }

    const service = new TestService();
    await expect(service.doWork()).rejects.toThrow("Something went wrong");

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockStartTransaction).toHaveBeenCalledTimes(1);
    expect(mockRollback).toHaveBeenCalledTimes(1);
    expect(mockCommit).not.toHaveBeenCalled();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("should apply the specified isolation level", async () => {
    class TestService {
      @Transactional("SERIALIZABLE")
      async doWork() {
        return "serialized";
      }
    }

    const service = new TestService();
    await service.doWork();

    expect(mockStartTransaction).toHaveBeenCalledWith("SERIALIZABLE");
  });

  it("should use default isolation level when none is specified", async () => {
    class TestService {
      @Transactional()
      async doWork() {
        return "default";
      }
    }

    const service = new TestService();
    await service.doWork();

    expect(mockStartTransaction).toHaveBeenCalledWith(undefined);
  });

  it("should preserve the return value of the original method", async () => {
    class TestService {
      @Transactional()
      async fetchData() {
        return { id: 1, name: "test" };
      }
    }

    const service = new TestService();
    const result = await service.fetchData();

    expect(result).toEqual({ id: 1, name: "test" });
  });

  it("should preserve the 'this' context of the method", async () => {
    class TestService {
      public value = 42;

      @Transactional()
      async getValue() {
        return this.value;
      }
    }

    const service = new TestService();
    const result = await service.getValue();

    expect(result).toBe(42);
  });

  it("should pass arguments to the original method", async () => {
    class TestService {
      @Transactional()
      async add(a: number, b: number) {
        return a + b;
      }
    }

    const service = new TestService();
    const result = await service.add(3, 5);

    expect(result).toBe(8);
  });

  it("should make the session available via AsyncLocalStorage", async () => {
    let capturedSession: TransactionSessionManager | undefined;

    class TestService {
      @Transactional()
      async doWork() {
        capturedSession = transactionStorage.getStore();
        return "ok";
      }
    }

    const service = new TestService();
    await service.doWork();

    expect(capturedSession).toBeDefined();
    expect(capturedSession!.connect).toBeDefined();
    expect(capturedSession!.commit).toBeDefined();
    expect(capturedSession!.rollback).toBeDefined();
  });

  it("should reuse the existing session for nested @Transactional calls", async () => {
    class TestService {
      @Transactional()
      async outer() {
        return this.inner();
      }

      @Transactional()
      async inner() {
        return "nested";
      }
    }

    const service = new TestService();
    const result = await service.outer();

    expect(result).toBe("nested");
    // Only one session should be created (the outer one)
    expect(MockedTSM).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockStartTransaction).toHaveBeenCalledTimes(1);
    expect(mockCommit).toHaveBeenCalledTimes(1);
  });

  it("should close the session even if commit fails", async () => {
    mockCommit.mockRejectedValueOnce(new Error("commit failed"));

    class TestService {
      @Transactional()
      async doWork() {
        return "done";
      }
    }

    const service = new TestService();
    await expect(service.doWork()).rejects.toThrow("commit failed");

    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("should support READ UNCOMMITTED isolation level", async () => {
    class TestService {
      @Transactional("READ UNCOMMITTED")
      async doWork() {
        return "dirty read";
      }
    }

    const service = new TestService();
    await service.doWork();

    expect(mockStartTransaction).toHaveBeenCalledWith("READ UNCOMMITTED");
  });

  it("should support REPEATABLE READ isolation level", async () => {
    class TestService {
      @Transactional("REPEATABLE READ")
      async doWork() {
        return "repeatable";
      }
    }

    const service = new TestService();
    await service.doWork();

    expect(mockStartTransaction).toHaveBeenCalledWith("REPEATABLE READ");
  });
});
