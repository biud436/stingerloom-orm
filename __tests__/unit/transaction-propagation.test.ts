/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import {
  Transactional,
  TransactionPropagation,
  transactionStorage,
} from "../../src/decorators/Transactional";
import { TransactionSessionManager } from "../../src/dialects/TransactionSessionManager";

// Mock TransactionSessionManager
jest.mock("../../src/dialects/TransactionSessionManager");

const MockedTSM = TransactionSessionManager as jest.MockedClass<
  typeof TransactionSessionManager
>;

describe("TransactionPropagation", () => {
  let mockConnect: jest.Mock;
  let mockStartTransaction: jest.Mock;
  let mockCommit: jest.Mock;
  let mockRollback: jest.Mock;
  let mockClose: jest.Mock;
  let mockSavepoint: jest.Mock;
  let mockRollbackTo: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    mockConnect = jest.fn().mockResolvedValue(undefined);
    mockStartTransaction = jest.fn().mockResolvedValue(undefined);
    mockCommit = jest.fn().mockResolvedValue(undefined);
    mockRollback = jest.fn().mockResolvedValue(undefined);
    mockClose = jest.fn().mockResolvedValue(undefined);
    mockSavepoint = jest.fn().mockResolvedValue(undefined);
    mockRollbackTo = jest.fn().mockResolvedValue(undefined);

    MockedTSM.mockImplementation(() => {
      return {
        connect: mockConnect,
        startTransaction: mockStartTransaction,
        commit: mockCommit,
        rollback: mockRollback,
        close: mockClose,
        query: jest.fn(),
        savepoint: mockSavepoint,
        rollbackTo: mockRollbackTo,
        connectToNode: jest.fn(),
      } as any;
    });
  });

  describe("REQUIRED (default)", () => {
    it("should create a new transaction when no existing session", async () => {
      class TestService {
        @Transactional()
        async doWork() {
          return "done";
        }
      }

      const service = new TestService();
      const result = await service.doWork();

      expect(result).toBe("done");
      expect(MockedTSM).toHaveBeenCalledTimes(1);
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockStartTransaction).toHaveBeenCalledTimes(1);
      expect(mockCommit).toHaveBeenCalledTimes(1);
      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it("should reuse existing session for nested REQUIRED calls", async () => {
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
      expect(MockedTSM).toHaveBeenCalledTimes(1);
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockStartTransaction).toHaveBeenCalledTimes(1);
      expect(mockCommit).toHaveBeenCalledTimes(1);
    });

    it("should accept options object format", async () => {
      class TestService {
        @Transactional({ isolationLevel: "SERIALIZABLE" })
        async doWork() {
          return "done";
        }
      }

      const service = new TestService();
      await service.doWork();

      expect(mockStartTransaction).toHaveBeenCalledWith("SERIALIZABLE");
    });

    it("should accept string isolation level (backward compatible)", async () => {
      class TestService {
        @Transactional("REPEATABLE READ")
        async doWork() {
          return "done";
        }
      }

      const service = new TestService();
      await service.doWork();

      expect(mockStartTransaction).toHaveBeenCalledWith("REPEATABLE READ");
    });
  });

  describe("REQUIRES_NEW", () => {
    it("should always create a new session even when inside existing transaction", async () => {
      class TestService {
        @Transactional()
        async outer() {
          return this.inner();
        }

        @Transactional({ propagation: TransactionPropagation.REQUIRES_NEW })
        async inner() {
          return "new-tx";
        }
      }

      const service = new TestService();
      const result = await service.outer();

      expect(result).toBe("new-tx");
      // Two sessions should be created (outer + inner)
      expect(MockedTSM).toHaveBeenCalledTimes(2);
      expect(mockConnect).toHaveBeenCalledTimes(2);
      expect(mockStartTransaction).toHaveBeenCalledTimes(2);
      expect(mockCommit).toHaveBeenCalledTimes(2);
      expect(mockClose).toHaveBeenCalledTimes(2);
    });

    it("should create new session even without existing transaction", async () => {
      class TestService {
        @Transactional({ propagation: TransactionPropagation.REQUIRES_NEW })
        async doWork() {
          return "fresh";
        }
      }

      const service = new TestService();
      const result = await service.doWork();

      expect(result).toBe("fresh");
      expect(MockedTSM).toHaveBeenCalledTimes(1);
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockCommit).toHaveBeenCalledTimes(1);
    });

    it("should rollback only the new session on inner error", async () => {
      const outerCommit = jest.fn().mockResolvedValue(undefined);
      const innerRollback = jest.fn().mockResolvedValue(undefined);

      let callIdx = 0;
      MockedTSM.mockImplementation(() => {
        callIdx++;
        if (callIdx === 1) {
          return {
            connect: jest.fn().mockResolvedValue(undefined),
            startTransaction: jest.fn().mockResolvedValue(undefined),
            commit: outerCommit,
            rollback: jest.fn().mockResolvedValue(undefined),
            close: jest.fn().mockResolvedValue(undefined),
            query: jest.fn(),
            savepoint: jest.fn(),
            rollbackTo: jest.fn(),
          } as any;
        }
        return {
          connect: jest.fn().mockResolvedValue(undefined),
          startTransaction: jest.fn().mockResolvedValue(undefined),
          commit: jest.fn().mockResolvedValue(undefined),
          rollback: innerRollback,
          close: jest.fn().mockResolvedValue(undefined),
          query: jest.fn(),
          savepoint: jest.fn(),
          rollbackTo: jest.fn(),
        } as any;
      });

      class TestService {
        @Transactional()
        async outer() {
          try {
            await this.inner();
          } catch {
            // catch inner error to allow outer to commit
          }
          return "outer-done";
        }

        @Transactional({ propagation: TransactionPropagation.REQUIRES_NEW })
        async inner() {
          throw new Error("inner failed");
        }
      }

      const service = new TestService();
      const result = await service.outer();

      expect(result).toBe("outer-done");
      expect(innerRollback).toHaveBeenCalledTimes(1);
      expect(outerCommit).toHaveBeenCalledTimes(1);
    });

    it("should use specified isolation level for the new session", async () => {
      class TestService {
        @Transactional({
          propagation: TransactionPropagation.REQUIRES_NEW,
          isolationLevel: "SERIALIZABLE",
        })
        async doWork() {
          return "done";
        }
      }

      const service = new TestService();
      await service.doWork();

      expect(mockStartTransaction).toHaveBeenCalledWith("SERIALIZABLE");
    });
  });

  describe("NESTED", () => {
    it("should create savepoint within existing transaction", async () => {
      class TestService {
        @Transactional()
        async outer() {
          return this.inner();
        }

        @Transactional({ propagation: TransactionPropagation.NESTED })
        async inner() {
          return "nested-savepoint";
        }
      }

      const service = new TestService();
      const result = await service.outer();

      expect(result).toBe("nested-savepoint");
      // Only one session should be created (outer)
      expect(MockedTSM).toHaveBeenCalledTimes(1);
      // Savepoint should be created
      expect(mockSavepoint).toHaveBeenCalledTimes(1);
      expect(mockSavepoint).toHaveBeenCalledWith(expect.stringMatching(/^sp_\d+$/));
    });

    it("should rollback to savepoint on inner error without rolling back outer", async () => {
      class TestService {
        @Transactional()
        async outer() {
          try {
            await this.inner();
          } catch {
            // catch inner error, outer should continue
          }
          return "outer-ok";
        }

        @Transactional({ propagation: TransactionPropagation.NESTED })
        async inner() {
          throw new Error("inner failed");
        }
      }

      const service = new TestService();
      const result = await service.outer();

      expect(result).toBe("outer-ok");
      // Savepoint should have been created and rolled back to
      expect(mockSavepoint).toHaveBeenCalledTimes(1);
      expect(mockRollbackTo).toHaveBeenCalledTimes(1);
      // …and to THAT savepoint: call counts alone would accept a rollback to
      // some other marker, which would undo the outer transaction's own work.
      expect(mockRollbackTo).toHaveBeenCalledWith(
        mockSavepoint.mock.calls[0][0],
      );
      // Outer should commit, not rollback
      expect(mockCommit).toHaveBeenCalledTimes(1);
      expect(mockRollback).not.toHaveBeenCalled();
    });

    it("should propagate inner error when not caught", async () => {
      class TestService {
        @Transactional()
        async outer() {
          return this.inner();
        }

        @Transactional({ propagation: TransactionPropagation.NESTED })
        async inner() {
          throw new Error("nested failure");
        }
      }

      const service = new TestService();
      await expect(service.outer()).rejects.toThrow("nested failure");

      expect(mockSavepoint).toHaveBeenCalledTimes(1);
      expect(mockRollbackTo).toHaveBeenCalledTimes(1);
      expect(mockRollbackTo).toHaveBeenCalledWith(
        mockSavepoint.mock.calls[0][0],
      );
      // Since inner error propagates to outer, outer should also rollback
      expect(mockRollback).toHaveBeenCalledTimes(1);
    });

    it("should behave like REQUIRED when no existing session", async () => {
      class TestService {
        @Transactional({ propagation: TransactionPropagation.NESTED })
        async doWork() {
          return "no-parent";
        }
      }

      const service = new TestService();
      const result = await service.doWork();

      expect(result).toBe("no-parent");
      // Should create a new session since there's no parent
      expect(MockedTSM).toHaveBeenCalledTimes(1);
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockStartTransaction).toHaveBeenCalledTimes(1);
      expect(mockCommit).toHaveBeenCalledTimes(1);
      // No savepoint created since it fell through to REQUIRED behavior
      expect(mockSavepoint).not.toHaveBeenCalled();
    });

    it("should support deeply nested savepoints", async () => {
      class TestService {
        @Transactional()
        async level0() {
          return this.level1();
        }

        @Transactional({ propagation: TransactionPropagation.NESTED })
        async level1() {
          return this.level2();
        }

        @Transactional({ propagation: TransactionPropagation.NESTED })
        async level2() {
          return "deep";
        }
      }

      const service = new TestService();
      const result = await service.level0();

      expect(result).toBe("deep");
      expect(MockedTSM).toHaveBeenCalledTimes(1);
      expect(mockSavepoint).toHaveBeenCalledTimes(2);
      expect(mockCommit).toHaveBeenCalledTimes(1);
    });

    it("should generate unique savepoint names", async () => {
      const savepointNames: string[] = [];
      mockSavepoint.mockImplementation(async (name: string) => {
        savepointNames.push(name);
      });

      class TestService {
        @Transactional()
        async outer() {
          await this.inner1();
          await this.inner2();
          return "both-done";
        }

        @Transactional({ propagation: TransactionPropagation.NESTED })
        async inner1() {
          return "a";
        }

        @Transactional({ propagation: TransactionPropagation.NESTED })
        async inner2() {
          return "b";
        }
      }

      const service = new TestService();
      await service.outer();

      expect(savepointNames).toHaveLength(2);
      // Each savepoint should have a unique name
      expect(savepointNames[0]).not.toBe(savepointNames[1]);
    });
  });

  describe("TransactionPropagation enum", () => {
    it("should export REQUIRED", () => {
      expect(TransactionPropagation.REQUIRED).toBe("REQUIRED");
    });

    it("should export REQUIRES_NEW", () => {
      expect(TransactionPropagation.REQUIRES_NEW).toBe("REQUIRES_NEW");
    });

    it("should export NESTED", () => {
      expect(TransactionPropagation.NESTED).toBe("NESTED");
    });
  });

  describe("backward compatibility", () => {
    it("@Transactional() with no args should still work (REQUIRED)", async () => {
      class TestService {
        @Transactional()
        async doWork() {
          return "ok";
        }
      }

      const service = new TestService();
      const result = await service.doWork();

      expect(result).toBe("ok");
      expect(mockCommit).toHaveBeenCalledTimes(1);
    });

    it("@Transactional('SERIALIZABLE') with string arg should still work", async () => {
      class TestService {
        @Transactional("SERIALIZABLE")
        async doWork() {
          return "ok";
        }
      }

      const service = new TestService();
      await service.doWork();

      expect(mockStartTransaction).toHaveBeenCalledWith("SERIALIZABLE");
    });

    it("transactionStorage should still be accessible", async () => {
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
    });
  });
});
