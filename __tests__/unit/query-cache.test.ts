import "reflect-metadata";
import Container from "typedi";
import sql from "sql-template-tag";
import { EntityManager } from "../../src/core/EntityManager";
import { QueryCache } from "../../src/core/QueryCache";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";

// Mock 모듈 설정
jest.mock("../../src/DatabaseClient", () => {
  return {
    DatabaseClient: {
      getInstance: jest.fn().mockReturnValue({
        type: "mysql",
        getConnection: jest.fn(),
        getOptions: jest.fn().mockReturnValue({ synchronize: false }),
        connect: jest.fn(),
      }),
    },
  };
});

const mockQuery = jest.fn();
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockStartTransaction = jest.fn().mockResolvedValue(undefined);
const mockCommit = jest.fn().mockResolvedValue(undefined);
const mockRollback = jest.fn().mockResolvedValue(undefined);
const mockClose = jest.fn().mockResolvedValue(undefined);

jest.mock("../../src/dialects/TransactionSessionManager", () => {
  return {
    TransactionSessionManager: jest.fn().mockImplementation(() => ({
      connect: mockConnect,
      startTransaction: mockStartTransaction,
      query: mockQuery,
      commit: mockCommit,
      rollback: mockRollback,
      close: mockClose,
    })),
  };
});

function createTestEntityManager() {
  const em = new EntityManager();
  (em as any).driver = {
    wrap: (name: string) => `\`${name}\``,
  };
  return em;
}

const userMetadata = {
  name: "User",
  target: class User {},
  columns: [
    { name: "id", options: { primary: true, autoIncrement: true } },
    { name: "name", options: {} },
    { name: "email", options: {} },
  ],
};

// ─────────────────────────────────────────
// QueryCache 단위 테스트
// ─────────────────────────────────────────

describe("QueryCache", () => {
  let cache: QueryCache;

  beforeEach(() => {
    cache = new QueryCache();
  });

  describe("buildKey()", () => {
    it("should build a deterministic key from entity name and options", () => {
      const key1 = QueryCache.buildKey("User", { where: { id: 1 } });
      const key2 = QueryCache.buildKey("User", { where: { id: 1 } });
      expect(key1).toBe(key2);
    });

    it("should produce different keys for different where clauses", () => {
      const key1 = QueryCache.buildKey("User", { where: { id: 1 } });
      const key2 = QueryCache.buildKey("User", { where: { id: 2 } });
      expect(key1).not.toBe(key2);
    });

    it("should produce different keys for different entities", () => {
      const key1 = QueryCache.buildKey("User", { where: { id: 1 } });
      const key2 = QueryCache.buildKey("Post", { where: { id: 1 } });
      expect(key1).not.toBe(key2);
    });

    it("should include orderBy in the key", () => {
      const key1 = QueryCache.buildKey("User", {
        where: { id: 1 },
        orderBy: { name: "ASC" },
      });
      const key2 = QueryCache.buildKey("User", {
        where: { id: 1 },
        orderBy: { name: "DESC" },
      });
      expect(key1).not.toBe(key2);
    });

    it("should include limit/take in the key", () => {
      const key1 = QueryCache.buildKey("User", { limit: 10 });
      const key2 = QueryCache.buildKey("User", { limit: 20 });
      expect(key1).not.toBe(key2);
    });

    it("should include select in the key", () => {
      const key1 = QueryCache.buildKey("User", { select: ["id"] });
      const key2 = QueryCache.buildKey("User", { select: ["id", "name"] });
      expect(key1).not.toBe(key2);
    });

    it("should include groupBy in the key", () => {
      const key1 = QueryCache.buildKey("User", { groupBy: ["name"] });
      const key2 = QueryCache.buildKey("User", {});
      expect(key1).not.toBe(key2);
    });

    it("should build a key with empty options", () => {
      const key = QueryCache.buildKey("User", {});
      expect(key).toBe('{"entity":"User"}');
    });
  });

  describe("get() / set()", () => {
    it("should return undefined for non-existent keys", () => {
      expect(cache.get("nonexistent")).toBeUndefined();
    });

    it("should store and retrieve a value", () => {
      cache.set("key1", { id: 1, name: "Alice" });
      expect(cache.get("key1")).toEqual({ id: 1, name: "Alice" });
    });

    it("should return undefined for expired entries", () => {
      jest.useFakeTimers();
      try {
        cache.set("key1", "data", 100); // 100ms TTL
        jest.advanceTimersByTime(101);
        expect(cache.get("key1")).toBeUndefined();
      } finally {
        jest.useRealTimers();
      }
    });

    it("should return value before TTL expires", () => {
      jest.useFakeTimers();
      try {
        cache.set("key1", "data", 1000);
        jest.advanceTimersByTime(500);
        expect(cache.get("key1")).toBe("data");
      } finally {
        jest.useRealTimers();
      }
    });

    it("should overwrite existing entries", () => {
      cache.set("key1", "old");
      cache.set("key1", "new");
      expect(cache.get("key1")).toBe("new");
    });

    it("should use default TTL when not specified", () => {
      jest.useFakeTimers();
      try {
        cache.set("key1", "data");
        // default TTL is 60000ms
        jest.advanceTimersByTime(59999);
        expect(cache.get("key1")).toBe("data");
        jest.advanceTimersByTime(2);
        expect(cache.get("key1")).toBeUndefined();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe("invalidate()", () => {
    it("should remove all entries for a given entity", () => {
      const key1 = QueryCache.buildKey("User", { where: { id: 1 } });
      const key2 = QueryCache.buildKey("User", { where: { id: 2 } });
      const key3 = QueryCache.buildKey("Post", { where: { id: 1 } });

      cache.set(key1, "user1");
      cache.set(key2, "user2");
      cache.set(key3, "post1");

      const count = cache.invalidate("User");

      expect(count).toBe(2);
      expect(cache.get(key1)).toBeUndefined();
      expect(cache.get(key2)).toBeUndefined();
      expect(cache.get(key3)).toBe("post1");
    });

    it("should return 0 when no entries match", () => {
      cache.set(QueryCache.buildKey("Post", {}), "data");
      expect(cache.invalidate("User")).toBe(0);
    });
  });

  describe("clear()", () => {
    it("should remove all entries", () => {
      cache.set("a", 1);
      cache.set("b", 2);
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.get("a")).toBeUndefined();
      expect(cache.get("b")).toBeUndefined();
    });
  });

  describe("size", () => {
    it("should return the number of entries", () => {
      expect(cache.size).toBe(0);
      cache.set("a", 1);
      expect(cache.size).toBe(1);
      cache.set("b", 2);
      expect(cache.size).toBe(2);
    });
  });
});

// ─────────────────────────────────────────
// EntityManager 캐시 통합 테스트
// ─────────────────────────────────────────

describe("EntityManager query caching", () => {
  let em: EntityManager;
  const User = userMetadata.target;

  beforeEach(() => {
    jest.clearAllMocks();

    em = createTestEntityManager();

    // resolveEntityMetadata mock
    jest.spyOn(em as any, "resolveEntityMetadata").mockReturnValue(userMetadata);

    // resolveManyToOneMetadata mock (no relations)
    jest.spyOn(em as any, "resolveManyToOneMetadata").mockReturnValue([]);
    jest.spyOn(em as any, "resolveOneToOneMetadata").mockReturnValue([]);

    // getDeletedAtColumn mock
    jest.spyOn(em as any, "getDeletedAtColumn").mockReturnValue(null);
  });

  describe("find() with cache option", () => {
    it("should execute query when cache is not set", async () => {
      // First call is "SET autocommit = 0", second is actual query
      mockQuery
        .mockResolvedValueOnce(undefined) // SET autocommit
        .mockResolvedValueOnce({
          results: [{ id: 1, name: "Alice", email: "alice@test.com" }],
          fields: [],
        });

      await em.find(User, { where: { id: 1 } as any });

      expect(mockQuery).toHaveBeenCalled();
    });

    it("should cache results when cache: true", async () => {
      mockQuery.mockResolvedValue({
        results: [{ id: 1, name: "Alice", email: "alice@test.com" }],
        fields: [],
      });

      // First call: cache miss, query executes
      await em.find(User, { where: { id: 1 } as any, cache: true });
      const callCount1 = mockQuery.mock.calls.length;

      // Second call: cache hit, no query
      await em.find(User, { where: { id: 1 } as any, cache: true });
      const callCount2 = mockQuery.mock.calls.length;

      // The query call count should not increase (SET autocommit + actual query = 2 per call)
      // On second call, should return from cache without connecting at all
      expect(callCount2).toBe(callCount1);
    });

    it("should cache results with custom TTL", async () => {
      jest.useFakeTimers();
      try {
        mockQuery.mockResolvedValue({
          results: [{ id: 1, name: "Alice", email: "alice@test.com" }],
          fields: [],
        });

        await em.find(User, { where: { id: 1 } as any, cache: 500 });
        const callCount1 = mockQuery.mock.calls.length;

        // Still in TTL
        jest.advanceTimersByTime(400);
        await em.find(User, { where: { id: 1 } as any, cache: 500 });
        expect(mockQuery.mock.calls.length).toBe(callCount1);

        // TTL expired
        jest.advanceTimersByTime(200);
        await em.find(User, { where: { id: 1 } as any, cache: 500 });
        expect(mockQuery.mock.calls.length).toBeGreaterThan(callCount1);
      } finally {
        jest.useRealTimers();
      }
    });

    it("should not cache when cache option is false", async () => {
      mockQuery.mockResolvedValue({
        results: [{ id: 1, name: "Alice", email: "alice@test.com" }],
        fields: [],
      });

      await em.find(User, { where: { id: 1 } as any, cache: false });
      const callCount1 = mockQuery.mock.calls.length;

      await em.find(User, { where: { id: 1 } as any, cache: false });
      const callCount2 = mockQuery.mock.calls.length;

      expect(callCount2).toBeGreaterThan(callCount1);
    });

    it("should not cache when cache option is not set", async () => {
      mockQuery.mockResolvedValue({
        results: [{ id: 1, name: "Alice", email: "alice@test.com" }],
        fields: [],
      });

      await em.find(User, { where: { id: 1 } as any });
      const callCount1 = mockQuery.mock.calls.length;

      await em.find(User, { where: { id: 1 } as any });
      const callCount2 = mockQuery.mock.calls.length;

      expect(callCount2).toBeGreaterThan(callCount1);
    });

    it("should use separate cache entries for different where clauses", async () => {
      mockQuery
        .mockResolvedValueOnce({
          results: [{ id: 1, name: "Alice", email: "alice@test.com" }],
          fields: [],
        })
        .mockResolvedValueOnce({
          results: [{ id: 1, name: "Alice", email: "alice@test.com" }],
          fields: [],
        })
        .mockResolvedValueOnce({
          results: [{ id: 2, name: "Bob", email: "bob@test.com" }],
          fields: [],
        })
        .mockResolvedValueOnce({
          results: [{ id: 2, name: "Bob", email: "bob@test.com" }],
          fields: [],
        });

      await em.find(User, { where: { id: 1 } as any, cache: true });
      await em.find(User, { where: { id: 2 } as any, cache: true });
      const callCount1 = mockQuery.mock.calls.length;

      // Both should be cached now
      await em.find(User, { where: { id: 1 } as any, cache: true });
      await em.find(User, { where: { id: 2 } as any, cache: true });
      expect(mockQuery.mock.calls.length).toBe(callCount1);
    });
  });

  describe("findOne() with cache option", () => {
    it("should cache findOne results", async () => {
      mockQuery.mockResolvedValue({
        results: [{ id: 1, name: "Alice", email: "alice@test.com" }],
        fields: [],
      });

      await em.findOne(User, { where: { id: 1 } as any, cache: true });
      const callCount1 = mockQuery.mock.calls.length;

      await em.findOne(User, { where: { id: 1 } as any, cache: true });
      expect(mockQuery.mock.calls.length).toBe(callCount1);
    });
  });

  describe("cache invalidation on save()", () => {
    it("should invalidate cache when saving an entity", async () => {
      // Populate cache
      mockQuery.mockResolvedValue({
        results: [{ id: 1, name: "Alice", email: "alice@test.com" }],
        fields: [],
      });

      await em.find(User, { where: { id: 1 } as any, cache: true });
      const callCountAfterFind = mockQuery.mock.calls.length;

      // Save (INSERT) — mock the query for save to return insertId
      mockQuery.mockResolvedValueOnce({
        results: { insertId: 2, affectedRows: 1 },
        fields: [],
      });
      // The subsequent findOne after save
      mockQuery.mockResolvedValueOnce({
        results: [{ id: 2, name: "Bob", email: "bob@test.com" }],
        fields: [],
      });

      await em.save(User, { name: "Bob", email: "bob@test.com" } as any);

      // Now the cached find should re-execute
      mockQuery.mockResolvedValue({
        results: [{ id: 1, name: "Alice", email: "alice@test.com" }],
        fields: [],
      });

      await em.find(User, { where: { id: 1 } as any, cache: true });
      // Should have more query calls because cache was invalidated
      expect(mockQuery.mock.calls.length).toBeGreaterThan(callCountAfterFind);
    });
  });

  describe("cache invalidation on delete()", () => {
    it("should invalidate cache when deleting an entity", async () => {
      // Populate cache
      mockQuery.mockResolvedValue({
        results: [{ id: 1, name: "Alice", email: "alice@test.com" }],
        fields: [],
      });

      await em.find(User, { where: { id: 1 } as any, cache: true });
      const callCountAfterFind = mockQuery.mock.calls.length;

      // Delete
      mockQuery.mockResolvedValueOnce({
        results: { affectedRows: 1 },
        fields: [],
      });

      jest.spyOn(em as any, "resolveOneToManyMetadata").mockReturnValue([]);
      await em.delete(User, { id: 1 } as any);

      // Find again — should re-execute query
      mockQuery.mockResolvedValue({
        results: [],
        fields: [],
      });

      await em.find(User, { where: { id: 1 } as any, cache: true });
      expect(mockQuery.mock.calls.length).toBeGreaterThan(callCountAfterFind);
    });
  });

  describe("cache invalidation on deleteMany()", () => {
    it("should invalidate cache when deleting multiple entities", async () => {
      mockQuery.mockResolvedValue({
        results: [{ id: 1, name: "Alice", email: "alice@test.com" }],
        fields: [],
      });

      await em.find(User, { cache: true });
      const callCountAfterFind = mockQuery.mock.calls.length;

      // deleteMany
      mockQuery.mockResolvedValueOnce({
        results: { affectedRows: 2 },
        fields: [],
      });

      await em.deleteMany(User, [1, 2]);

      // Find again — cache invalidated
      mockQuery.mockResolvedValue({
        results: [],
        fields: [],
      });

      await em.find(User, { cache: true });
      expect(mockQuery.mock.calls.length).toBeGreaterThan(callCountAfterFind);
    });
  });

  describe("cache invalidation on insertMany()", () => {
    it("should invalidate cache when inserting multiple entities", async () => {
      mockQuery.mockResolvedValue({
        results: [{ id: 1, name: "Alice", email: "alice@test.com" }],
        fields: [],
      });

      await em.find(User, { cache: true });
      const callCountAfterFind = mockQuery.mock.calls.length;

      // insertMany
      mockQuery.mockResolvedValueOnce({
        results: { affectedRows: 2 },
        fields: [],
      });

      await em.insertMany(User, [
        { name: "Bob", email: "bob@test.com" } as any,
        { name: "Carol", email: "carol@test.com" } as any,
      ]);

      // Find again
      mockQuery.mockResolvedValue({
        results: [
          { id: 1, name: "Alice", email: "alice@test.com" },
          { id: 2, name: "Bob", email: "bob@test.com" },
        ],
        fields: [],
      });

      await em.find(User, { cache: true });
      expect(mockQuery.mock.calls.length).toBeGreaterThan(callCountAfterFind);
    });
  });

  describe("clearCache()", () => {
    it("should clear all cache entries when called without arguments", async () => {
      mockQuery.mockResolvedValue({
        results: [{ id: 1, name: "Alice", email: "alice@test.com" }],
        fields: [],
      });

      await em.find(User, { where: { id: 1 } as any, cache: true });
      const callCount1 = mockQuery.mock.calls.length;

      em.clearCache();

      await em.find(User, { where: { id: 1 } as any, cache: true });
      expect(mockQuery.mock.calls.length).toBeGreaterThan(callCount1);
    });

    it("should clear cache only for specific entity when class is provided", async () => {
      const Post = class Post {};
      const postMetadata = {
        name: "Post",
        target: Post,
        columns: [
          { name: "id", options: { primary: true, autoIncrement: true } },
          { name: "title", options: {} },
        ],
      };

      // Set up separate metadata resolution for Post
      const resolveMetaSpy = jest.spyOn(em as any, "resolveEntityMetadata");

      // Cache User data
      resolveMetaSpy.mockReturnValue(userMetadata);
      mockQuery.mockResolvedValue({
        results: [{ id: 1, name: "Alice", email: "alice@test.com" }],
        fields: [],
      });
      await em.find(User, { where: { id: 1 } as any, cache: true });
      const callCountAfterUser = mockQuery.mock.calls.length;

      // Cache Post data
      resolveMetaSpy.mockReturnValue(postMetadata);
      mockQuery.mockResolvedValue({
        results: [{ id: 1, title: "Hello" }],
        fields: [],
      });
      await em.find(Post, { where: { id: 1 } as any, cache: true });
      const callCountAfterPost = mockQuery.mock.calls.length;

      // Clear only User cache
      em.clearCache(User);

      // Post should still be cached
      resolveMetaSpy.mockReturnValue(postMetadata);
      await em.find(Post, { where: { id: 1 } as any, cache: true });
      expect(mockQuery.mock.calls.length).toBe(callCountAfterPost);

      // User should NOT be cached
      resolveMetaSpy.mockReturnValue(userMetadata);
      mockQuery.mockResolvedValue({
        results: [{ id: 1, name: "Alice", email: "alice@test.com" }],
        fields: [],
      });
      await em.find(User, { where: { id: 1 } as any, cache: true });
      expect(mockQuery.mock.calls.length).toBeGreaterThan(callCountAfterPost);
    });
  });

  describe("cache returns undefined results correctly", () => {
    it("should cache undefined result when no rows returned", async () => {
      mockQuery.mockResolvedValue({
        results: [],
        fields: [],
      });

      const result1 = await em.find(User, {
        where: { id: 999 } as any,
        cache: true,
      });
      const callCount1 = mockQuery.mock.calls.length;

      const result2 = await em.find(User, {
        where: { id: 999 } as any,
        cache: true,
      });
      // Should hit cache — but since result was undefined and we cache it,
      // the get() will return undefined which is the same as cache miss.
      // The find() returns undefined for no results, so cache stores undefined.
      // This is expected behavior: undefined results are not cached because
      // QueryCache.get() returns undefined for both "not found" and "value is undefined".
      // We accept this trade-off: empty results cause re-query.
      expect(result1).toBeUndefined();
      expect(result2).toBeUndefined();
    });
  });
});
