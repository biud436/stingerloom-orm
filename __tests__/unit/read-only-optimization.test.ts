/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import Container from "typedi";
import { EntityManager } from "../../src/core/EntityManager";
import { TransactionSessionManager } from "../../src/dialects/TransactionSessionManager";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";
import { MetadataContext } from "../../src/metadata/MetadataContext";

/**
 * Read-only query optimization tests (Issue #78).
 *
 * 읽기 전용 쿼리(find, findOne, findWithCursor, count, sum, avg, min, max, explain)가
 * 트랜잭션 없이 실행되는지 검증합니다.
 *
 * Decision Matrix:
 * - 비테넌트, 비타임아웃 → 트랜잭션 스킵 (80% 왕복 감소)
 * - PostgreSQL + timeout → 트랜잭션 fallback (SET LOCAL 필요)
 * - MySQL + timeout → 트랜잭션 스킵 (SET SESSION은 트랜잭션 불필요)
 * - 테넌트 (PG, tenant≠"public") → SET search_path + 리셋
 * - findAndCount → 트랜잭션 유지 (스냅샷 일관성)
 * - 기존 세션 (@Transactional) → 세션 재사용
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

// Mock TransactionSessionManager
const mockQuery = jest.fn();
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockConnectToNode = jest.fn().mockResolvedValue(undefined);
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
        connectToNode: mockConnectToNode,
        startTransaction: mockStartTransaction,
        query: mockQuery,
        commit: mockCommit,
        rollback: mockRollback,
        close: mockClose,
      };
    }),
  };
});

// Test entities
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

function createTestEntityManager(opts?: {
  isMySql?: boolean;
  isPostgres?: boolean;
}) {
  const em = new EntityManager();
  const isMySql = opts?.isMySql ?? true;
  const isPg = opts?.isPostgres ?? false;

  (em as any).driver = {
    wrap: (name: string) => isMySql ? `\`${name}\`` : `"${name}"`,
    supportsExplain: () => true,
    buildExplainSql: () => "EXPLAIN ",
    setQueryTimeout: (ms: number) =>
      isMySql
        ? `SET SESSION max_execution_time = ${ms}`
        : `SET LOCAL statement_timeout = '${ms}'`,
  };

  jest.spyOn((em as any).resolver, "resolveEntityMetadata").mockImplementation(
    (entity: any) => {
      if (entity === User) return userMetadata;
      if (entity === Post) return postMetadata;
      return null;
    },
  );

  jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(isMySql);
  jest.spyOn(em as any, "isPostgres").mockReturnValue(isPg);
  jest.spyOn(em as any, "wrap").mockImplementation(
    (...args: any[]) => isMySql ? `\`${args[0]}\`` : `"${args[0]}"`,
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

function resetMocks() {
  mockQuery.mockReset();
  mockConnect.mockReset().mockResolvedValue(undefined);
  mockConnectToNode.mockReset().mockResolvedValue(undefined);
  mockStartTransaction.mockReset().mockResolvedValue(undefined);
  mockCommit.mockReset().mockResolvedValue(undefined);
  mockRollback.mockReset().mockResolvedValue(undefined);
  mockClose.mockReset().mockResolvedValue(undefined);
  sessionInstanceCount = 0;
}

describe("Read-only Query Optimization (Issue #78)", () => {
  beforeEach(() => {
    MetadataLayerRegistry.reset();
    Container.reset();
    resetMocks();
  });

  // ── A. Transaction skip verification (core) ──────────────────

  describe("A. Transaction skip for read-only queries", () => {
    let em: EntityManager;

    beforeEach(() => {
      em = createTestEntityManager({ isMySql: true });
    });

    it("1. find() without tenant/timeout should NOT start a transaction", async () => {
      mockQuery.mockResolvedValueOnce({
        results: [{ id: 1, name: "Alice", email: "a@test.com" }],
        fields: [],
      });

      await em.find(User, {});

      expect(sessionInstanceCount).toBe(1);
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockStartTransaction).not.toHaveBeenCalled();
      expect(mockCommit).not.toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it("2. findOne() without tenant/timeout should NOT start a transaction", async () => {
      mockQuery.mockResolvedValueOnce({
        results: [{ id: 1, name: "Alice", email: "a@test.com" }],
        fields: [],
      });

      const result = await em.findOne(User, { where: { id: 1 } as any });

      expect(result).toBeDefined();
      expect(mockStartTransaction).not.toHaveBeenCalled();
      expect(mockCommit).not.toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it("3. findWithCursor() should NOT start a transaction", async () => {
      mockQuery.mockResolvedValueOnce({
        results: [{ id: 1, name: "Alice", email: "a@test.com" }],
        fields: [],
      });

      await em.findWithCursor(User, { take: 10 });

      expect(mockStartTransaction).not.toHaveBeenCalled();
      expect(mockCommit).not.toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it("4. count() standalone should NOT start a transaction", async () => {
      mockQuery.mockResolvedValueOnce({
        results: [{ result: 42 }],
        fields: [],
      });

      const count = await em.count(User);

      expect(count).toBe(42);
      expect(mockStartTransaction).not.toHaveBeenCalled();
      expect(mockCommit).not.toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it("5. sum()/avg()/min()/max() standalone should NOT start a transaction", async () => {
      for (const method of ["sum", "avg", "min", "max"] as const) {
        resetMocks();
        const localEm = createTestEntityManager({ isMySql: true });
        mockQuery.mockResolvedValueOnce({
          results: [{ result: 100 }],
          fields: [],
        });

        const result = await (localEm as any)[method](User, "id");

        expect(result).toBe(100);
        expect(mockStartTransaction).not.toHaveBeenCalled();
        expect(mockCommit).not.toHaveBeenCalled();
        expect(mockClose).toHaveBeenCalledTimes(1);
      }
    });

    it("6. explain() should NOT start a transaction", async () => {
      mockQuery.mockResolvedValueOnce({
        results: [{ type: "ALL", rows: 10, possible_keys: null, key: null }],
        fields: [],
      });

      await em.explain(User, {});

      expect(mockStartTransaction).not.toHaveBeenCalled();
      expect(mockCommit).not.toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalledTimes(1);
    });
  });

  // ── B. Transaction retained for write ops (regression) ───────

  describe("B. Transaction retained for write operations", () => {
    let em: EntityManager;

    beforeEach(() => {
      em = createTestEntityManager({ isMySql: true });
    });

    it("7. findAndCount() should still use a transaction (snapshot consistency)", async () => {
      mockQuery
        .mockResolvedValueOnce(undefined) // SET autocommit = 0
        .mockResolvedValueOnce({
          results: [
            { id: 1, name: "Alice", email: "a@test.com" },
            { id: 2, name: "Bob", email: "b@test.com" },
          ],
          fields: [],
        })
        .mockResolvedValueOnce({
          results: [{ result: 5 }],
          fields: [],
        });

      const [entities, count] = await em.findAndCount(User);

      expect(entities).toHaveLength(2);
      expect(count).toBe(5);
      expect(mockStartTransaction).toHaveBeenCalledTimes(1);
      expect(mockCommit).toHaveBeenCalledTimes(1);
    });

    it("8. save() should still use a transaction", async () => {
      mockQuery
        .mockResolvedValueOnce(undefined) // SET autocommit = 0
        .mockResolvedValueOnce({
          results: { insertId: 1, affectedRows: 1 },
          fields: [],
        })
        .mockResolvedValueOnce({
          results: [{ id: 1, name: "Alice", email: "a@test.com" }],
          fields: [],
        });

      await em.save(User, { name: "Alice", email: "a@test.com" });

      expect(mockStartTransaction).toHaveBeenCalledTimes(1);
      expect(mockCommit).toHaveBeenCalledTimes(1);
    });

    it("9. delete() should still use a transaction", async () => {
      mockQuery
        .mockResolvedValueOnce(undefined) // SET autocommit = 0
        .mockResolvedValueOnce({
          results: { affectedRows: 1 },
          fields: [],
        });

      await em.delete(User, { id: 1 } as any);

      expect(mockStartTransaction).toHaveBeenCalledTimes(1);
      expect(mockCommit).toHaveBeenCalledTimes(1);
    });

    it("10. saveMany() should still use a transaction", async () => {
      mockQuery
        .mockResolvedValueOnce(undefined) // SET autocommit = 0
        .mockResolvedValueOnce({
          results: { insertId: 1, affectedRows: 1 },
          fields: [],
        })
        .mockResolvedValueOnce({
          results: [{ id: 1, name: "A" }],
          fields: [],
        })
        .mockResolvedValueOnce({
          results: { insertId: 2, affectedRows: 1 },
          fields: [],
        })
        .mockResolvedValueOnce({
          results: [{ id: 2, name: "B" }],
          fields: [],
        });

      await em.saveMany(User, [
        { name: "A", email: "a@t.com" },
        { name: "B", email: "b@t.com" },
      ]);

      expect(mockStartTransaction).toHaveBeenCalledTimes(1);
      expect(mockCommit).toHaveBeenCalledTimes(1);
    });

    it("11. query() (raw) should still use a transaction", async () => {
      mockQuery
        .mockResolvedValueOnce(undefined) // SET autocommit = 0
        .mockResolvedValueOnce({
          results: [{ id: 1 }],
          fields: [],
        });

      await em.query("SELECT 1");

      expect(mockStartTransaction).toHaveBeenCalledTimes(1);
      expect(mockCommit).toHaveBeenCalledTimes(1);
    });
  });

  // ── C. Existing session reuse (@Transactional compatibility) ──

  describe("C. Existing session reuse (@Transactional)", () => {
    let em: EntityManager;

    beforeEach(() => {
      em = createTestEntityManager({ isMySql: true });
    });

    it("12. find() inside @Transactional should reuse existing session", async () => {
      const { transactionStorage } = require("../../src/decorators/Transactional");
      const externalSession = {
        query: jest.fn().mockResolvedValue({
          results: [{ id: 1, name: "Alice" }],
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
        await em.find(User, {});
      });

      // No new session created
      expect(sessionInstanceCount).toBe(0);
      expect(externalSession.query).toHaveBeenCalled();
      expect(externalSession.commit).not.toHaveBeenCalled();
      expect(externalSession.close).not.toHaveBeenCalled();
    });

    it("13. count() inside @Transactional should reuse existing session", async () => {
      const { transactionStorage } = require("../../src/decorators/Transactional");
      const externalSession = {
        query: jest.fn().mockResolvedValue({
          results: [{ result: 10 }],
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
        const count = await em.count(User);
        expect(count).toBe(10);
      });

      expect(sessionInstanceCount).toBe(0);
      expect(externalSession.query).toHaveBeenCalled();
    });

    it("14. findAndCount() should share session between findInternal and aggregate", async () => {
      mockQuery
        .mockResolvedValueOnce(undefined) // SET autocommit = 0
        .mockResolvedValueOnce({
          results: [{ id: 1, name: "Alice" }],
          fields: [],
        })
        .mockResolvedValueOnce({
          results: [{ result: 1 }],
          fields: [],
        });

      await em.findAndCount(User);

      // Only 1 session for both find + count
      expect(sessionInstanceCount).toBe(1);
      expect(mockStartTransaction).toHaveBeenCalledTimes(1);
      expect(mockCommit).toHaveBeenCalledTimes(1);
    });
  });

  // ── D. Multi-tenancy safety (PostgreSQL) ────────────────────

  describe("D. Multi-tenancy search_path (PostgreSQL)", () => {
    let em: EntityManager;

    beforeEach(() => {
      em = createTestEntityManager({ isMySql: false, isPostgres: true });
    });

    it("15. find() with tenant context should SET search_path", async () => {
      mockQuery
        .mockResolvedValueOnce(undefined) // SET search_path
        .mockResolvedValueOnce({
          results: [{ id: 1, name: "Alice" }],
          fields: [],
        })
        .mockResolvedValueOnce(undefined); // RESET search_path

      await MetadataContext.run("tenant_a", async () => {
        await em.find(User, {});
      });

      expect(mockStartTransaction).not.toHaveBeenCalled();
      // First query: SET search_path TO "tenant_a"
      const firstCall = mockQuery.mock.calls[0][0];
      expect(firstCall).toContain("SET search_path");
      expect(firstCall).toContain("tenant_a");
    });

    it("16. find() with tenant context should RESET search_path after query", async () => {
      mockQuery
        .mockResolvedValueOnce(undefined) // SET search_path
        .mockResolvedValueOnce({
          results: [{ id: 1, name: "Alice" }],
          fields: [],
        })
        .mockResolvedValueOnce(undefined); // RESET search_path

      await MetadataContext.run("tenant_b", async () => {
        await em.find(User, {});
      });

      // Last query before close should reset search_path
      const lastQueryCall = mockQuery.mock.calls[mockQuery.mock.calls.length - 1][0];
      expect(lastQueryCall).toContain("SET search_path");
      expect(lastQueryCall).toContain("public");
    });

    it("17. find() with tenant context should reset search_path and close even on error", async () => {
      mockQuery
        .mockResolvedValueOnce(undefined) // SET search_path
        .mockRejectedValueOnce(new Error("PG error")) // SELECT throws
        .mockResolvedValueOnce(undefined); // RESET search_path (in finally)

      await MetadataContext.run("tenant_c", async () => {
        await expect(em.find(User, {})).rejects.toThrow("PG error");
      });

      // search_path should still be reset
      expect(mockQuery).toHaveBeenCalledTimes(3);
      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it("18. find() without tenant (public) should NOT SET search_path", async () => {
      mockQuery.mockResolvedValueOnce({
        results: [{ id: 1, name: "Alice" }],
        fields: [],
      });

      // No MetadataContext.run → tenant = "public"
      await em.find(User, {});

      // No SET search_path calls
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockStartTransaction).not.toHaveBeenCalled();
    });
  });

  // ── E. Timeout paths ──────────────────────────────────────────

  describe("E. Timeout handling", () => {
    it("19. PostgreSQL + timeout should fallback to executeInTransaction", async () => {
      const em = createTestEntityManager({ isMySql: false, isPostgres: true });
      mockQuery
        .mockResolvedValueOnce(undefined) // SET LOCAL statement_timeout (within findInternal)
        .mockResolvedValueOnce({
          results: [{ id: 1, name: "Alice" }],
          fields: [],
        });

      await em.find(User, { timeout: 5000 });

      // Falls back to transaction path
      expect(mockStartTransaction).toHaveBeenCalledTimes(1);
      expect(mockCommit).toHaveBeenCalledTimes(1);
    });

    it("20. MySQL + timeout should NOT start a transaction, but SET SESSION", async () => {
      const em = createTestEntityManager({ isMySql: true });
      mockQuery
        .mockResolvedValueOnce(undefined) // SET SESSION max_execution_time (from executeReadOnly)
        .mockResolvedValueOnce(undefined) // SET SESSION max_execution_time (from findInternal inline)
        .mockResolvedValueOnce({
          results: [{ id: 1, name: "Alice" }],
          fields: [],
        });

      await em.find(User, { timeout: 3000 });

      expect(mockStartTransaction).not.toHaveBeenCalled();
      expect(mockCommit).not.toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalledTimes(1);
    });
  });

  // ── F. Connection management ──────────────────────────────────

  describe("F. Connection lifecycle", () => {
    let em: EntityManager;

    beforeEach(() => {
      em = createTestEntityManager({ isMySql: true });
    });

    it("21. read-only query error should still close session (no leak)", async () => {
      mockQuery.mockRejectedValueOnce(new Error("Connection lost"));

      await expect(em.find(User, {})).rejects.toThrow("Connection lost");

      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(mockRollback).not.toHaveBeenCalled();
    });

    it("22. successful read-only query should close session", async () => {
      mockQuery.mockResolvedValueOnce({
        results: [{ id: 1, name: "Alice" }],
        fields: [],
      });

      await em.find(User, {});

      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it("23. search_path reset failure should still close session", async () => {
      const pgEm = createTestEntityManager({ isMySql: false, isPostgres: true });
      mockQuery
        .mockResolvedValueOnce(undefined) // SET search_path
        .mockResolvedValueOnce({
          results: [{ id: 1, name: "Alice" }],
          fields: [],
        })
        .mockRejectedValueOnce(new Error("Reset failed")); // RESET search_path fails

      await MetadataContext.run("tenant_x", async () => {
        // Should NOT throw — reset failure is swallowed with warning
        const result = await pgEm.find(User, {});
        expect(result).toHaveLength(1);
      });

      expect(mockClose).toHaveBeenCalledTimes(1);
    });
  });
});
