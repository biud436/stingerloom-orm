/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import Container from "typedi";
import { EntityManager } from "../../src/core/EntityManager";
import { TransactionSessionManager } from "../../src/dialects/TransactionSessionManager";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";
import { MetadataContext } from "../../src/metadata/MetadataContext";
import { SchemaQualifiedStrategy } from "../../src/core/TenantQueryStrategy";

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
 * - 테넌트 (PG, tenant≠"public") → 트랜잭션 fallback (SET LOCAL search_path)
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
  tenantStrategy?: "schema_qualified";
}) {
  const em = new EntityManager();
  const isMySql = opts?.isMySql ?? true;
  const isPg = opts?.isPostgres ?? false;

  if (opts?.tenantStrategy === "schema_qualified") {
    (em as any).tenantStrategy = new SchemaQualifiedStrategy();
  }

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

    it("7. findAndCount() should use read-only path (no transaction)", async () => {
      mockQuery
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
      expect(mockStartTransaction).not.toHaveBeenCalled();
      expect(mockCommit).not.toHaveBeenCalled();
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

    it("14. findAndCount() should share session between findInternal and aggregate (read-only)", async () => {
      mockQuery
        .mockResolvedValueOnce({
          results: [{ id: 1, name: "Alice" }],
          fields: [],
        })
        .mockResolvedValueOnce({
          results: [{ result: 1 }],
          fields: [],
        });

      await em.findAndCount(User);

      // Only 1 session for both find + count, no transaction
      expect(sessionInstanceCount).toBe(1);
      expect(mockStartTransaction).not.toHaveBeenCalled();
      expect(mockCommit).not.toHaveBeenCalled();
    });
  });

  // ── D. Multi-tenancy safety (PostgreSQL) ────────────────────

  describe("D. Multi-tenancy search_path (PostgreSQL)", () => {
    let em: EntityManager;

    beforeEach(() => {
      em = createTestEntityManager({ isMySql: false, isPostgres: true });
    });

    it("15. find() with tenant context should fallback to transaction (SET LOCAL safety)", async () => {
      // PG transaction path: connect → startTransaction → fn(session) → commit
      // startTransaction is its own mock, no query call needed for it
      mockQuery.mockResolvedValueOnce({
        results: [{ id: 1, name: "Alice" }],
        fields: [],
      });

      await MetadataContext.run("tenant_a", async () => {
        await em.find(User, {});
      });

      // Tenant reads must go through executeInTransaction for SET LOCAL search_path
      expect(mockStartTransaction).toHaveBeenCalledTimes(1);
      expect(mockCommit).toHaveBeenCalledTimes(1);
    });

    it("16. find() with tenant context should use transaction even on error", async () => {
      // PG transaction path: connect → startTransaction → fn(session) throws → rollback
      mockQuery.mockRejectedValueOnce(new Error("PG error"));

      await MetadataContext.run("tenant_c", async () => {
        await expect(em.find(User, {})).rejects.toThrow("PG error");
      });

      // Transaction path handles rollback on error
      expect(mockStartTransaction).toHaveBeenCalledTimes(1);
      expect(mockRollback).toHaveBeenCalledTimes(1);
      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it("17. find() without tenant (public) should NOT start a transaction", async () => {
      mockQuery.mockResolvedValueOnce({
        results: [{ id: 1, name: "Alice" }],
        fields: [],
      });

      // No MetadataContext.run → tenant = "public"
      await em.find(User, {});

      // No SET search_path, no transaction
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockStartTransaction).not.toHaveBeenCalled();
    });

    it("18. MySQL find() with tenant context should NOT start a transaction (no search_path)", async () => {
      const mysqlEm = createTestEntityManager({ isMySql: true, isPostgres: false });
      mockQuery.mockResolvedValueOnce({
        results: [{ id: 1, name: "Alice" }],
        fields: [],
      });

      await MetadataContext.run("tenant_a", async () => {
        await mysqlEm.find(User, {});
      });

      // MySQL has no search_path concept — lightweight path
      expect(mockStartTransaction).not.toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalledTimes(1);
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

    it("23. PG tenant read uses transaction path — close on commit", async () => {
      const pgEm = createTestEntityManager({ isMySql: false, isPostgres: true });
      mockQuery.mockResolvedValueOnce({
        results: [{ id: 1, name: "Alice" }],
        fields: [],
      });

      await MetadataContext.run("tenant_x", async () => {
        const result = await pgEm.find(User, {});
        expect(result).toHaveLength(1);
      });

      // Transaction path: startTransaction → commit → close
      expect(mockStartTransaction).toHaveBeenCalledTimes(1);
      expect(mockCommit).toHaveBeenCalledTimes(1);
      expect(mockClose).toHaveBeenCalledTimes(1);
    });
  });

  // ── G. SchemaQualified tenant strategy ──────────────────────

  describe("G. SchemaQualified tenant strategy (PostgreSQL)", () => {
    let em: EntityManager;

    beforeEach(() => {
      em = createTestEntityManager({
        isMySql: false,
        isPostgres: true,
        tenantStrategy: "schema_qualified",
      });
    });

    it("24. find() with tenant context should NOT start a transaction (schema-qualified)", async () => {
      mockQuery.mockResolvedValueOnce({
        results: [{ id: 1, name: "Alice", email: "a@test.com" }],
        fields: [],
      });

      await MetadataContext.run("tenant_a", async () => {
        await em.find(User, {});
      });

      // SchemaQualified strategy skips transaction for tenant reads
      expect(mockStartTransaction).not.toHaveBeenCalled();
      expect(mockCommit).not.toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it("25. find() query should contain schema-qualified table name", async () => {
      mockQuery.mockResolvedValueOnce({
        results: [{ id: 1, name: "Alice", email: "a@test.com" }],
        fields: [],
      });

      await MetadataContext.run("tenant_a", async () => {
        await em.find(User, {});
      });

      // The query should contain "tenant_a"."User"
      const queryCalls = mockQuery.mock.calls;
      const sqlText = String(queryCalls[0][0]?.text ?? queryCalls[0][0]);
      expect(sqlText).toContain('"tenant_a"."User"');
    });

    it("26. find() without tenant (public) should NOT schema-qualify", async () => {
      mockQuery.mockResolvedValueOnce({
        results: [{ id: 1, name: "Alice", email: "a@test.com" }],
        fields: [],
      });

      // No MetadataContext.run → tenant = "public"
      await em.find(User, {});

      const queryCalls = mockQuery.mock.calls;
      const sqlText = String(queryCalls[0][0]?.text ?? queryCalls[0][0]);
      // Should NOT contain "tenant_a" — just plain "User"
      expect(sqlText).not.toContain('"tenant_a"');
      expect(sqlText).toContain('"User"');
    });

    it("27. save() query should contain schema-qualified table name", async () => {
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

      await MetadataContext.run("tenant_a", async () => {
        await em.save(User, { name: "Alice", email: "a@test.com" });
      });

      const allSql = mockQuery.mock.calls.map(
        (c) => String(c[0]?.text ?? c[0]),
      );
      const insertSql = allSql.find((s) => s.includes("INSERT INTO"));
      expect(insertSql).toBeDefined();
      expect(insertSql).toContain('"tenant_a"."User"');
    });

    it("28. delete() query should contain schema-qualified table name", async () => {
      mockQuery
        .mockResolvedValueOnce(undefined) // SET autocommit = 0
        .mockResolvedValueOnce({
          results: { affectedRows: 1 },
          fields: [],
        });

      await MetadataContext.run("tenant_b", async () => {
        await em.delete(User, { id: 1 } as any);
      });

      const allSql = mockQuery.mock.calls.map(
        (c) => String(c[0]?.text ?? c[0]),
      );
      const deleteSql = allSql.find((s) => s.includes("DELETE FROM"));
      expect(deleteSql).toBeDefined();
      expect(deleteSql).toContain('"tenant_b"."User"');
    });

    it("29. count() query should contain schema-qualified table name", async () => {
      mockQuery.mockResolvedValueOnce({
        results: [{ result: 5 }],
        fields: [],
      });

      await MetadataContext.run("tenant_a", async () => {
        await em.count(User);
      });

      const sqlText = String(mockQuery.mock.calls[0][0]?.text ?? mockQuery.mock.calls[0][0]);
      expect(sqlText).toContain('"tenant_a"."User"');
    });

    it("30. SearchPath strategy: find() with tenant should NOT schema-qualify table name", async () => {
      // Create a default-strategy (SearchPath) PG EntityManager
      const spEm = createTestEntityManager({ isMySql: false, isPostgres: true });
      // Do NOT set schema_qualified — default is SearchPathStrategy

      mockQuery.mockResolvedValueOnce({
        results: [{ id: 1, name: "Alice", email: "a@test.com" }],
        fields: [],
      });

      await MetadataContext.run("tenant_a", async () => {
        await spEm.find(User, {});
      });

      // SearchPath strategy uses transaction (tested in D.15),
      // but more importantly, the SQL should NOT contain schema prefix
      const allSql = mockQuery.mock.calls.map(
        (c) => String(c[0]?.text ?? c[0]),
      );
      const selectSql = allSql.find((s) => s.includes("SELECT"));
      expect(selectSql).toBeDefined();
      expect(selectSql).not.toContain('"tenant_a"."User"');
      expect(selectSql).toContain('"User"');
    });

    it("31. PG + timeout should still fallback to transaction even with schema_qualified", async () => {
      mockQuery
        .mockResolvedValueOnce(undefined) // SET LOCAL statement_timeout
        .mockResolvedValueOnce({
          results: [{ id: 1, name: "Alice" }],
          fields: [],
        });

      await em.find(User, { timeout: 5000 });

      // Timeout always requires transaction for SET LOCAL
      expect(mockStartTransaction).toHaveBeenCalledTimes(1);
      expect(mockCommit).toHaveBeenCalledTimes(1);
    });
  });
});
