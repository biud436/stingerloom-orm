/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { getScannerInstance, resetScannerContainer } from "../../src/scanner/ScannerContainer";
import { EntityManager } from "../../src/core/EntityManager";
import { TransactionSessionManager } from "../../src/dialects/TransactionSessionManager";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";

/**
 * Connection reuse tests (GitHub Issue #30).
 *
 * Verifies that exactly one TransactionSessionManager is created per public method call.
 * - find() + relation loading → 1 session
 * - saveMany() → 1 session
 * - save() (INSERT) + findOneInternal re-read → same session
 * - findAndCount() → 1 session
 * - Rollback behavior verified on error
 */

// Mock DatabaseClient
jest.mock("../../src/DatabaseClient", () => ({
  DatabaseClient: {
    getInstance: jest.fn().mockReturnValue({
      type: "mysql",
      getConnection: jest.fn(),
      getOptions: jest.fn().mockReturnValue({ synchronize: false }),
      connect: jest.fn(),
    }),
  },
}));

// Mock TransactionSessionManager — tracks the number of instances created.
const mockQuery = jest.fn();
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockStartTransaction = jest.fn().mockResolvedValue(undefined);
const mockCommit = jest.fn().mockResolvedValue(undefined);
const mockRollback = jest.fn().mockResolvedValue(undefined);
const mockClose = jest.fn().mockResolvedValue(undefined);

let sessionInstanceCount = 0;

jest.mock("../../src/dialects/TransactionSessionManager", () => {
  return {
    TransactionSessionManager: jest.fn().mockImplementation(() => {
      sessionInstanceCount++;
      return {
        connect: mockConnect,
        startTransaction: mockStartTransaction,
        query: mockQuery,
        commit: mockCommit,
        rollback: mockRollback,
        close: mockClose,
      };
    }),
  };
});

// Test entities and metadata
class User {
  id!: number;
  name!: string;
  email!: string;
}

class Post {
  id!: number;
  title!: string;
  userId!: number;
}

const userMetadata = {
  name: "User",
  target: User,
  columns: [
    { name: "id", options: { primary: true, autoIncrement: true } },
    { name: "name", options: {} },
    { name: "email", options: {} },
  ],
};

const postMetadata = {
  name: "Post",
  target: Post,
  columns: [
    { name: "id", options: { primary: true, autoIncrement: true } },
    { name: "title", options: {} },
    { name: "userId", options: {} },
  ],
};

function createTestEntityManager() {
  const em = new EntityManager();

  (em as any).driver = {
    wrap: (name: string) => `\`${name}\``,
    supportsExplain: () => false,
  };

  jest.spyOn((em as any).resolver, "resolveEntityMetadata").mockImplementation(
    (entity: any) => {
      if (entity === User) return userMetadata;
      if (entity === Post) return postMetadata;
      return null;
    },
  );

  jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);
  jest.spyOn(em as any, "isPostgres").mockReturnValue(false);
  jest.spyOn(em as any, "wrap").mockImplementation(
    (...args: any[]) => `\`${args[0]}\``,
  );
  jest.spyOn((em as any).resolver, "resolveOneToOneMetadata").mockReturnValue([]);
  jest.spyOn((em as any).resolver, "resolveManyToOneMetadata").mockReturnValue([]);
  jest.spyOn((em as any).resolver, "resolveOneToManyMetadata").mockReturnValue([]);
  jest.spyOn((em as any).cascadeHandler, "runHooks").mockResolvedValue(undefined);
  jest.spyOn((em as any).cascadeHandler, "cascadeSaveOneToMany").mockResolvedValue(undefined);
  jest.spyOn((em as any).cascadeHandler, "cascadeSaveManyToOne").mockResolvedValue(undefined);
  jest.spyOn((em as any).resolver, "getDeletedAtColumn").mockReturnValue(null);
  jest.spyOn((em as any).resolver, "getCreateTimestampColumn").mockReturnValue(null);
  jest.spyOn((em as any).resolver, "getUpdateTimestampColumn").mockReturnValue(null);
  return em;
}

describe("Connection Reuse (Issue #30)", () => {
  let em: EntityManager;

  beforeEach(() => {
    MetadataLayerRegistry.reset();
    resetScannerContainer();
    // Use mockReset to ensure mockQuery's once-queue is fully cleared
    mockQuery.mockReset();
    mockConnect.mockReset().mockResolvedValue(undefined);
    mockStartTransaction.mockReset().mockResolvedValue(undefined);
    mockCommit.mockReset().mockResolvedValue(undefined);
    mockRollback.mockReset().mockResolvedValue(undefined);
    mockClose.mockReset().mockResolvedValue(undefined);
    sessionInstanceCount = 0;
    em = createTestEntityManager();
  });

  describe("find() with relation loading", () => {
    it("should use exactly 1 TransactionSessionManager when loading relations (no transaction)", async () => {
      // Set up OneToMany relation metadata
      jest.spyOn((em as any).resolver, "resolveOneToManyMetadata").mockReturnValue([
        {
          propertyName: "posts",
          getMappingEntity: () => Post,
          joinColumn: "userId",
        },
      ]);

      mockQuery
        .mockResolvedValueOnce({
          results: [{ id: 1, name: "Alice", email: "alice@test.com" }],
          fields: [],
        }) // SELECT users
        .mockResolvedValueOnce({
          results: [
            { id: 10, title: "Post 1", userId: 1 },
            { id: 11, title: "Post 2", userId: 1 },
          ],
          fields: [],
        }); // SELECT posts (relation loading)

      await em.find(User, { relations: ["posts"] });

      // Only one connection should be created
      expect(sessionInstanceCount).toBe(1);
      expect(mockConnect).toHaveBeenCalledTimes(1);
      // Read-only: no transaction
      expect(mockStartTransaction).not.toHaveBeenCalled();
      expect(mockCommit).not.toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("saveMany()", () => {
    it("should use exactly 1 TransactionSessionManager for multiple saves", async () => {
      // #214 batch path: single multi-row INSERT + single SELECT WHERE pk IN (...)
      mockQuery
        // batch INSERT (insertId = first row's auto_increment)
        .mockResolvedValueOnce({
          results: { insertId: 1, affectedRows: 3 },
          fields: [],
        })
        // bulk re-read SELECT WHERE id IN (1,2,3)
        .mockResolvedValueOnce({
          results: [
            { id: 1, name: "Alice", email: "a@test.com" },
            { id: 2, name: "Bob", email: "b@test.com" },
            { id: 3, name: "Charlie", email: "c@test.com" },
          ],
          fields: [],
        });

      const result = await em.saveMany(User, [
        { name: "Alice", email: "a@test.com" },
        { name: "Bob", email: "b@test.com" },
        { name: "Charlie", email: "c@test.com" },
      ]);

      // Only one session should be created
      expect(sessionInstanceCount).toBe(1);
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockStartTransaction).toHaveBeenCalledTimes(1);
      expect(mockCommit).toHaveBeenCalledTimes(1);
      expect(mockClose).toHaveBeenCalledTimes(1);

      // Batch: 1 INSERT + 1 SELECT = 2 queries
      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(3);
    });
  });

  describe("save() INSERT with findOneInternal re-read", () => {
    it("should use same session for INSERT and re-read findOneInternal", async () => {
      mockQuery
        .mockResolvedValueOnce({
          results: { insertId: 1, affectedRows: 1 },
          fields: [],
        }) // INSERT
        .mockResolvedValueOnce({
          results: [{ id: 1, name: "Alice", email: "alice@test.com" }],
          fields: [],
        }); // findOneInternal → findInternal SELECT

      const result = await em.save(User, {
        name: "Alice",
        email: "alice@test.com",
      });

      // save() should perform INSERT + re-read in a single session
      expect(sessionInstanceCount).toBe(1);
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockStartTransaction).toHaveBeenCalledTimes(1);
      expect(mockCommit).toHaveBeenCalledTimes(1);
      expect(mockClose).toHaveBeenCalledTimes(1);

      // Both INSERT and SELECT queries must be executed
      // INSERT(1) + SELECT(1) = 2
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });
  });

  describe("findAndCount()", () => {
    it("should use exactly 1 TransactionSessionManager for find + count (read-only, no transaction)", async () => {
      mockQuery
        .mockResolvedValueOnce({
          results: [
            { id: 1, name: "Alice", email: "alice@test.com" },
            { id: 2, name: "Bob", email: "bob@test.com" },
          ],
          fields: [],
        }) // SELECT (find)
        .mockResolvedValueOnce({
          results: [{ result: 10 }],
          fields: [],
        }); // SELECT COUNT (aggregate)

      const [entities, count] = await em.findAndCount(User);

      // Run both find + count in one session, without a transaction
      expect(sessionInstanceCount).toBe(1);
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockStartTransaction).not.toHaveBeenCalled();
      expect(mockCommit).not.toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalledTimes(1);

      expect(entities).toHaveLength(2);
      expect(count).toBe(10);
    });
  });

  describe("error rollback", () => {
    it("should close session when a read-only query error occurs (no rollback)", async () => {
      mockQuery
        .mockRejectedValueOnce(new Error("Query failed")); // SELECT throws

      await expect(em.find(User, {})).rejects.toThrow("Query failed");

      // Read-only: no transaction, no rollback — just close
      expect(sessionInstanceCount).toBe(1);
      expect(mockStartTransaction).not.toHaveBeenCalled();
      expect(mockRollback).not.toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(mockCommit).not.toHaveBeenCalled();
    });

    it("should rollback on saveMany error without leaking connections", async () => {
      // #214 batch path: rollback the transaction when INSERT fails
      mockQuery
        .mockRejectedValueOnce(new Error("Constraint violation")); // batch INSERT fails

      await expect(
        em.saveMany(User, [{ name: "Ok" }, { name: "Fail" }]),
      ).rejects.toThrow("Constraint violation");

      // One session only; rollback + close should be called
      expect(sessionInstanceCount).toBe(1);
      expect(mockRollback).toHaveBeenCalledTimes(1);
      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(mockCommit).not.toHaveBeenCalled();
    });
  });

  describe("executeInTransaction session reuse", () => {
    it("should not create new session when existingSession is provided", async () => {
      const existingSession = {
        query: jest.fn().mockResolvedValue({
          results: [{ id: 1, name: "Alice" }],
          fields: [],
        }),
        connect: jest.fn(),
        startTransaction: jest.fn(),
        commit: jest.fn(),
        rollback: jest.fn(),
        close: jest.fn(),
      };

      // Call findInternal directly to test passing existingSession
      const result = await (em as any).findInternal(User, {}, existingSession);

      // No new session should be created
      expect(sessionInstanceCount).toBe(0);
      // The existing session's commit/rollback/close must not be called
      expect(existingSession.commit).not.toHaveBeenCalled();
      expect(existingSession.rollback).not.toHaveBeenCalled();
      expect(existingSession.close).not.toHaveBeenCalled();
    });
  });

  describe("delete()", () => {
    it("should use exactly 1 TransactionSessionManager", async () => {
      mockQuery
        .mockResolvedValueOnce({
          results: { affectedRows: 1 },
          fields: [],
        }); // DELETE

      await em.delete(User, { id: 1 } as any);

      expect(sessionInstanceCount).toBe(1);
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockCommit).toHaveBeenCalledTimes(1);
      expect(mockClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("insertMany()", () => {
    it("should use exactly 1 TransactionSessionManager", async () => {
      mockQuery
        .mockResolvedValueOnce({
          results: { affectedRows: 3 },
          fields: [],
        }); // INSERT

      const result = await em.insertMany(User, [
        { name: "A", email: "a@test.com" },
        { name: "B", email: "b@test.com" },
        { name: "C", email: "c@test.com" },
      ]);

      expect(sessionInstanceCount).toBe(1);
      expect(result.affected).toBe(3);
    });
  });

  describe("deleteMany()", () => {
    it("should use exactly 1 TransactionSessionManager", async () => {
      mockQuery
        .mockResolvedValueOnce({
          results: { affectedRows: 3 },
          fields: [],
        }); // DELETE

      const result = await em.deleteMany(User, [1, 2, 3]);

      expect(sessionInstanceCount).toBe(1);
      expect(result.affected).toBe(3);
    });
  });

  describe("@Transactional integration", () => {
    it("should reuse session from transactionStorage when @Transactional is active", async () => {
      // Simulate the session that @Transactional stores in AsyncLocalStorage
      const { transactionStorage } = require("../../src/decorators/Transactional");
      const externalSession = {
        query: jest.fn().mockResolvedValue({
          results: [{ id: 1, name: "Alice", email: "alice@test.com" }],
          fields: [],
        }),
        connect: jest.fn(),
        connectToNode: jest.fn(),
        startTransaction: jest.fn(),
        commit: jest.fn(),
        rollback: jest.fn(),
        close: jest.fn(),
      };

      // Call find() while the session is stored in AsyncLocalStorage via transactionStorage.run()
      await transactionStorage.run(externalSession, async () => {
        await em.find(User, {});
      });

      // No new TransactionSessionManager should be created
      expect(sessionInstanceCount).toBe(0);
      // Queries must be executed via the @Transactional session
      expect(externalSession.query).toHaveBeenCalled();
      // The session lifecycle is owned by @Transactional, so commit/close must not be called
      expect(externalSession.commit).not.toHaveBeenCalled();
      expect(externalSession.close).not.toHaveBeenCalled();
    });

    it("should reuse @Transactional session across multiple EntityManager calls", async () => {
      const { transactionStorage } = require("../../src/decorators/Transactional");
      const externalSession = {
        query: jest.fn()
          // First save: INSERT
          .mockResolvedValueOnce({
            results: { insertId: 1, affectedRows: 1 },
            fields: [],
          })
          // First save: findOneInternal re-read
          .mockResolvedValueOnce({
            results: [{ id: 1, name: "Alice", email: "a@test.com" }],
            fields: [],
          })
          // Second save: INSERT
          .mockResolvedValueOnce({
            results: { insertId: 2, affectedRows: 1 },
            fields: [],
          })
          // Second save: findOneInternal re-read
          .mockResolvedValueOnce({
            results: [{ id: 2, name: "Bob", email: "b@test.com" }],
            fields: [],
          }),
        connect: jest.fn(),
        connectToNode: jest.fn(),
        startTransaction: jest.fn(),
        commit: jest.fn(),
        rollback: jest.fn(),
        close: jest.fn(),
      };

      await transactionStorage.run(externalSession, async () => {
        await em.save(User, { name: "Alice", email: "a@test.com" });
        await em.save(User, { name: "Bob", email: "b@test.com" });
      });

      // No new session is created; the @Transactional session is reused
      expect(sessionInstanceCount).toBe(0);
      expect(externalSession.query).toHaveBeenCalledTimes(4); // INSERT + SELECT × 2
      expect(externalSession.commit).not.toHaveBeenCalled();
      expect(externalSession.close).not.toHaveBeenCalled();
    });

    it("should create new session when no @Transactional and no existingSession (read-only, no tx)", async () => {
      // No session in transactionStorage
      mockQuery
        .mockResolvedValueOnce({
          results: [{ id: 1, name: "Alice" }],
          fields: [],
        });

      await em.find(User, {});

      // Without @Transactional, a new session is created (read-only: no tx)
      expect(sessionInstanceCount).toBe(1);
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockStartTransaction).not.toHaveBeenCalled();
      expect(mockCommit).not.toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("dirtyEntities cleanup after transaction (Issue #97)", () => {
    it("should clear dirtyEntities after successful commit", async () => {
      mockQuery
        .mockResolvedValueOnce({
          results: { insertId: 1, affectedRows: 1 },
          fields: [],
        }) // INSERT
        .mockResolvedValueOnce({
          results: [{ id: 1, name: "Alice", email: "a@test.com" }],
          fields: [],
        }); // re-read

      const dirtyEntities = (em as any).dirtyEntities as Set<any>;
      // Simulate entities marked dirty during cascade
      dirtyEntities.add({ id: 99 });
      dirtyEntities.add({ id: 100 });
      expect(dirtyEntities.size).toBe(2);

      await em.save(User, { name: "Alice", email: "a@test.com" });

      // dirtyEntities should be cleared after transaction completes
      expect(dirtyEntities.size).toBe(0);
    });

    it("should clear dirtyEntities after rollback on error", async () => {
      mockQuery
        .mockRejectedValueOnce(new Error("Constraint violation")); // INSERT fails

      const dirtyEntities = (em as any).dirtyEntities as Set<any>;
      dirtyEntities.add({ id: 99 });
      expect(dirtyEntities.size).toBe(1);

      await expect(
        em.save(User, { name: "Fail", email: "fail@test.com" }),
      ).rejects.toThrow("Constraint violation");

      // dirtyEntities should still be cleared even on rollback
      expect(dirtyEntities.size).toBe(0);
    });

    it("should not clear dirtyEntities for reused session (nested transaction)", async () => {
      const { transactionStorage } = require("../../src/decorators/Transactional");
      const externalSession = {
        query: jest.fn()
          .mockResolvedValueOnce({
            results: { insertId: 1, affectedRows: 1 },
            fields: [],
          })
          .mockResolvedValueOnce({
            results: [{ id: 1, name: "Alice", email: "a@test.com" }],
            fields: [],
          }),
        connect: jest.fn(),
        connectToNode: jest.fn(),
        startTransaction: jest.fn(),
        commit: jest.fn(),
        rollback: jest.fn(),
        close: jest.fn(),
      };

      const dirtyEntities = (em as any).dirtyEntities as Set<any>;
      dirtyEntities.add({ id: 99 });

      await transactionStorage.run(externalSession, async () => {
        await em.save(User, { name: "Alice", email: "a@test.com" });
      });

      // Reused session: dirtyEntities should NOT be cleared
      // (the outer transaction owner is responsible for cleanup)
      expect(dirtyEntities.size).toBe(1);
    });
  });
});
