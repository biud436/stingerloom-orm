/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * QueryResultCache 유닛 테스트
 *
 * 인메모리 스토어(LRU/TTL/태그 무효화)와 캐시 매니저(정책 정규화, SELECT
 * 가드, 히트/미스, 스냅샷 격리, 스토어 장애 fail-open, 쓰기 클로저 태그)를
 * DB 없이 검증한다.
 */
import "reflect-metadata";
import {
  InMemoryQueryCacheStore,
  QueryResultCache,
} from "../../src/core/cache/QueryResultCache";
import { transactionStorage } from "../../src/decorators/Transactional";

describe("InMemoryQueryCacheStore", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("expires entries after their TTL", () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const store = new InMemoryQueryCacheStore(10);
    store.set("k", { rows: 1 }, 100, ["t:a"]);
    expect(store.get("k")).toEqual({ rows: 1 });

    jest.advanceTimersByTime(101);
    expect(store.get("k")).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it("evicts the least recently used entry at capacity", () => {
    const store = new InMemoryQueryCacheStore(2);
    store.set("a", "A", 60_000, []);
    store.set("b", "B", 60_000, []);
    // Touch "a" so "b" becomes the LRU.
    expect(store.get("a")).toBe("A");
    store.set("c", "C", 60_000, []);

    expect(store.get("b")).toBeUndefined();
    expect(store.get("a")).toBe("A");
    expect(store.get("c")).toBe("C");
  });

  it("invalidates every entry sharing a tag and leaves others", () => {
    const store = new InMemoryQueryCacheStore(10);
    store.set("u1", 1, 60_000, ["t:users"]);
    store.set("u2", 2, 60_000, ["t:users", "t:posts"]);
    store.set("p1", 3, 60_000, ["t:posts"]);
    store.set("x", 4, 60_000, ["t:other"]);

    store.invalidateTags(["t:users"]);
    expect(store.get("u1")).toBeUndefined();
    expect(store.get("u2")).toBeUndefined();
    expect(store.get("p1")).toBe(3);
    expect(store.get("x")).toBe(4);

    store.invalidateTags(["t:posts"]);
    expect(store.get("p1")).toBeUndefined();
    expect(store.size()).toBe(1);
  });

  it("clear() drops everything including the tag index", () => {
    const store = new InMemoryQueryCacheStore(10);
    store.set("a", 1, 60_000, ["t:users"]);
    store.clear();
    expect(store.size()).toBe(0);
    // A stale tag index must not resurrect or throw.
    store.invalidateTags(["t:users"]);
    expect(store.size()).toBe(0);
  });
});

// ── Manager fixtures ───────────────────────────────────────

function makeResolver(overrides: Partial<Record<string, any>> = {}) {
  return {
    resolveEntityMetadata: (cls: any) => ({ name: cls.tableName ?? cls.name }),
    resolveManyToOneMetadata: () => [],
    resolveOneToManyMetadata: () => [],
    resolveOneToOneMetadata: () => [],
    resolveManyToManyMetadata: () => [],
    resolveManyToManyJoinTable: () => null,
    ...overrides,
  };
}

function makeCtx(resolver = makeResolver()) {
  const logger = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
  return {
    ctx: {
      getDbType: () => "sqlite",
      getConnectionName: () => "default",
      getSchema: () => undefined,
      getLogger: () => logger,
      getResolver: () => resolver,
      getInheritanceResolver: () => ({ getStrategy: () => undefined }),
    } as any,
    logger,
  };
}

class FakeUser {
  static tableName = "users";
}
class FakePost {
  static tableName = "posts";
}
class FakeTag {
  static tableName = "tags";
}

const SELECT_SQL = 'SELECT * FROM "users" WHERE "id" = ?';

describe("QueryResultCache", () => {
  it("normalizes the per-query option: true/number/object, zero TTL disables", () => {
    const { ctx } = makeCtx();
    const cache = new QueryResultCache(ctx, { ttl: 5_000 });

    expect(cache.policyForFind(FakeUser as any, { cache: true })?.ttl).toBe(5_000);
    expect(cache.policyForFind(FakeUser as any, { cache: 250 })?.ttl).toBe(250);
    expect(
      cache.policyForFind(FakeUser as any, { cache: { ttl: 42 } })?.ttl,
    ).toBe(42);
    expect(cache.policyForFind(FakeUser as any, { cache: 0 })).toBeUndefined();
    expect(
      cache.policyForFind(FakeUser as any, { cache: { ttl: 0 } }),
    ).toBeUndefined();
    expect(cache.policyForFind(FakeUser as any, {})).toBeUndefined();
  });

  it("refuses to build a policy inside an ambient transaction", () => {
    const { ctx } = makeCtx();
    const cache = new QueryResultCache(ctx);
    const inTx = transactionStorage.run({} as any, () =>
      cache.policyForFind(FakeUser as any, { cache: true }),
    );
    expect(inTx).toBeUndefined();
    expect(cache.policyForFind(FakeUser as any, { cache: true })).toBeDefined();
  });

  it("serves the second identical SELECT from the cache and isolates snapshots", async () => {
    const { ctx } = makeCtx();
    const cache = new QueryResultCache(ctx);
    const policy = cache.policyForFind(FakeUser as any, { cache: true })!;

    const exec = jest
      .fn()
      .mockImplementation(async () => ({ results: [{ id: 1, name: "kim" }] }));

    const first = await cache.runQuery(policy, SELECT_SQL, exec);
    // The caller may mutate its rows (boolean coercion etc.) — the stored
    // snapshot must not see it.
    first.results[0].name = "MUTATED";

    const second = await cache.runQuery(policy, SELECT_SQL, exec);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(second.results[0].name).toBe("kim");
    // Each hit hands out its own clone.
    second.results[0].name = "ALSO MUTATED";
    const third = await cache.runQuery(policy, SELECT_SQL, exec);
    expect(third.results[0].name).toBe("kim");

    expect(cache.stats).toEqual({ hits: 2, misses: 1, entries: 1 });
  });

  it("passes non-SELECT statements straight through", async () => {
    const { ctx } = makeCtx();
    const cache = new QueryResultCache(ctx);
    const policy = cache.policyForFind(FakeUser as any, { cache: true })!;

    const exec = jest.fn().mockResolvedValue({ results: [] });
    await cache.runQuery(policy, "SET statement_timeout = 100", exec);
    await cache.runQuery(policy, "SET statement_timeout = 100", exec);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(cache.stats.hits).toBe(0);
    expect(cache.stats.misses).toBe(0);
  });

  it("keys on bind values, not just SQL text", async () => {
    const { ctx } = makeCtx();
    const cache = new QueryResultCache(ctx);
    const policy = cache.policyForFind(FakeUser as any, { cache: true })!;

    const exec = jest.fn().mockResolvedValue({ results: [{ id: 1 }] });
    const asSql = (values: unknown[]) =>
      ({ sql: SELECT_SQL, values }) as any;

    await cache.runQuery(policy, asSql([1]), exec);
    await cache.runQuery(policy, asSql([2]), exec);
    expect(exec).toHaveBeenCalledTimes(2);
    await cache.runQuery(policy, asSql([1]), exec);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("falls back to the database when the store throws, warning once", async () => {
    const { ctx, logger } = makeCtx();
    const store = {
      get: jest.fn(() => {
        throw new Error("redis down");
      }),
      set: jest.fn(() => {
        throw new Error("redis down");
      }),
      invalidateTags: jest.fn(),
      clear: jest.fn(),
    };
    const cache = new QueryResultCache(ctx, { store });
    const policy = cache.policyForFind(FakeUser as any, { cache: true })!;

    const exec = jest.fn().mockResolvedValue({ results: [{ id: 1 }] });
    await expect(cache.runQuery(policy, SELECT_SQL, exec)).resolves.toEqual({
      results: [{ id: 1 }],
    });
    await cache.runQuery(policy, SELECT_SQL, exec);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("skips caching results that cannot be snapshotted", async () => {
    const { ctx } = makeCtx();
    const cache = new QueryResultCache(ctx);
    const policy = cache.policyForFind(FakeUser as any, { cache: true })!;

    const exec = jest
      .fn()
      .mockImplementation(async () => ({ results: [{ fn: () => 1 }] }));
    await cache.runQuery(policy, SELECT_SQL, exec);
    await cache.runQuery(policy, SELECT_SQL, exec);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("tags reads with the relation closure and invalidates by write closure", async () => {
    const resolver = makeResolver({
      resolveOneToManyMetadata: (cls: any) =>
        cls === FakeUser
          ? [{ propertyKey: "posts", getRelatedEntity: () => FakePost }]
          : [],
      resolveManyToManyMetadata: (cls: any) =>
        cls === FakePost
          ? [
              {
                propertyKey: "tags",
                getRelatedEntity: () => FakeTag,
                joinTable: {
                  name: "post_tags",
                  joinColumn: "postId",
                  inverseJoinColumn: "tagId",
                },
              },
            ]
          : [],
      resolveManyToManyJoinTable: (rel: any) => rel.joinTable ?? null,
    });
    const { ctx } = makeCtx(resolver);
    const cache = new QueryResultCache(ctx);

    // Read of users + posts relation → tagged with both tables.
    const policy = cache.policyForFind(FakeUser as any, {
      cache: true,
      relations: ["posts"],
    })!;
    expect([...policy.tags].sort()).toEqual(["t:posts", "t:users"]);

    const exec = jest.fn().mockResolvedValue({ results: [{ id: 1 }] });
    await cache.runQuery(policy, SELECT_SQL, exec);

    // A write to FakePost reaches posts + its M2M join table + tags; the
    // cached users-with-posts entry must fall with it.
    await cache.invalidateEntity(FakePost as any);
    await cache.runQuery(policy, SELECT_SQL, exec);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("invalidate() accepts entity classes and string tags", async () => {
    const { ctx } = makeCtx();
    const cache = new QueryResultCache(ctx);
    const policy = cache.policyForFind(FakeUser as any, {
      cache: { tag: "dashboard" },
    })!;
    const exec = jest.fn().mockResolvedValue({ results: [{ id: 1 }] });

    await cache.runQuery(policy, SELECT_SQL, exec);
    await cache.invalidate("dashboard");
    await cache.runQuery(policy, SELECT_SQL, exec);
    expect(exec).toHaveBeenCalledTimes(2);

    await cache.invalidate(FakeUser as any);
    await cache.runQuery(policy, SELECT_SQL, exec);
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it("namespaces keys by tenant so identical SQL never crosses tenants", async () => {
    const { ctx } = makeCtx();
    const cache = new QueryResultCache(ctx);
    const policy = cache.policyForFind(FakeUser as any, { cache: true })!;

    const { MetadataContext } = await import(
      "../../src/metadata/MetadataContext"
    );
    const execA = jest.fn().mockResolvedValue({ results: [{ tenant: "a" }] });
    const execB = jest.fn().mockResolvedValue({ results: [{ tenant: "b" }] });

    const a = await MetadataContext.run("tenant_a", () =>
      cache.runQuery(policy, SELECT_SQL, execA),
    );
    const b = await MetadataContext.run("tenant_b", () =>
      cache.runQuery(policy, SELECT_SQL, execB),
    );
    expect(a.results[0].tenant).toBe("a");
    expect(b.results[0].tenant).toBe("b");
    expect(execB).toHaveBeenCalledTimes(1);

    // Same tenant again → hit, still tenant-correct.
    const aAgain = await MetadataContext.run("tenant_a", () =>
      cache.runQuery(policy, SELECT_SQL, execA),
    );
    expect(aAgain.results[0].tenant).toBe("a");
    expect(execA).toHaveBeenCalledTimes(1);
  });

  it("wrapSession() intercepts query() and delegates everything else", async () => {
    const { ctx } = makeCtx();
    const cache = new QueryResultCache(ctx);
    const policy = cache.policyForFind(FakeUser as any, { cache: true })!;

    const inner = {
      query: jest.fn().mockResolvedValue({ results: [{ id: 7 }] }),
      close: jest.fn().mockResolvedValue(undefined),
    } as any;
    const wrapped = policy.wrapSession(inner);

    await wrapped.query(SELECT_SQL);
    await wrapped.query(SELECT_SQL);
    expect(inner.query).toHaveBeenCalledTimes(1);

    await wrapped.close();
    expect(inner.close).toHaveBeenCalledTimes(1);
  });
});
