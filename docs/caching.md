# Query Result Cache

An ORM adds overhead to every query, but the fastest query is the one that never reaches the database. The query result cache lets you opt individual reads into a short-lived cache: repeated identical reads skip the database round trip entirely, and writes issued through the same `EntityManager` invalidate the affected entries automatically.

Caching is **opt-in per query** and off by default. Nothing changes for queries that do not ask for it.

## Quick Start

```typescript
// Cache with the default TTL (1 second)
const featured = await em.find(Product, {
  where: { featured: true },
  cache: true,
});

// Cache for 30 seconds
const stats = await em.findAndCount(Order, {
  where: { status: "paid" },
  cache: 30_000,
});

// Query builder terminals work the same way
const top = await em
  .createQueryBuilder(Product, "p")
  .where("featured", true)
  .orderBy({ score: "DESC" })
  .limit(10)
  .cache(30_000)
  .getMany();
```

The `cache` option accepts three forms:

| Form | Meaning |
|------|---------|
| `true` | Cache with the connection-level default TTL (1000 ms unless configured) |
| `number` | Cache with that TTL in milliseconds |
| `{ ttl?, tag? }` | TTL override, plus a user tag for manual invalidation |

It is available on `find`, `findOne`, `findBy`, `findOneBy`, `findOneOrFail`, `findAndCount`, `findWithPage`, `findWithCursor`, and on `SelectQueryBuilder` via `.cache()` (covering `getMany`, `getOne`, `getRawMany`, `getPartialMany`, `getCount`, aggregate scalars, and `exists`).

## What Exactly Is Cached

The cache stores **raw row sets**, never entity instances. A cache hit replays the stored rows through the normal hydration pipeline, so every call — hit or miss — returns fresh entity instances, runs column transformers, fires `afterLoad` subscribers, and installs lazy-loading proxies exactly as a database read would. Mutating a returned entity never corrupts the cache.

A single `find` may issue several SQL statements (the root query plus relation-loader queries for `relations: [...]`). Each statement's row set is cached individually under the same policy, so a fully cached `find` with relations resolves without touching the database at all.

## Invalidation

Every cached row set is indexed under the tables the read could have touched: the entity's own table, its inheritance family (STI/TPT/TPC), the targets of eager and requested relations, and many-to-many join tables.

Writes issued through the same `EntityManager` — `save`, `update`, `updateMany`, `delete`, `softDelete`, `restore`, `upsert`, `insertMany`, `increment`, and the rest — invalidate every entry tagged with a table the write can reach. That includes child tables reachable through `ON DELETE CASCADE` foreign keys, so a cached "authors with posts" result falls when a post is updated.

What the cache **cannot see**:

- **Writes from other processes** (another server instance, a manual SQL session). These are bounded only by the TTL — which is why the default is one second. Pick TTLs by how stale each read may be, not by how often it runs.
- **Raw SQL writes** through `em.query(...)`. Raw statements are not parsed for table names. Invalidate manually after them.

Manual control is always available:

```typescript
await em.queryCache?.invalidate(Product);        // by entity (write closure)
await em.queryCache?.invalidate("dashboard");    // by user tag
await em.queryCache?.clear();                     // everything
em.queryCache?.stats;                             // { hits, misses, entries }
```

User tags name a group of queries you want to drop together:

```typescript
await em.find(Product, { where: { featured: true }, cache: { ttl: 60_000, tag: "storefront" } });
await em.find(Banner, { cache: { ttl: 60_000, tag: "storefront" } });

// After a CMS publish:
await em.queryCache?.invalidate("storefront");
```

## Consistency Rules

The cache never changes the semantics of a query that must be current:

- **Reads inside a transaction bypass the cache** — a transaction must observe its own uncommitted writes. This applies to `@Transactional`, `em.transaction()`, and any read running on an explicit session.
- **Locking reads bypass the cache** — `lock: PESSIMISTIC_WRITE` (and the query builder's locking clauses) always reach the database; a lock that does not lock anything would be a correctness bug.
- **Uncached reads never read or populate the cache.**

One caveat to know about: a write inside a transaction invalidates immediately (not at commit). Between the invalidation and the commit, a concurrent cached read can re-populate the entry from the pre-commit state; the TTL bounds how long that entry can live.

## Configuration

Per-query opt-in works with zero configuration. The connection options tune the defaults:

```typescript
await em.register({
  type: "postgres",
  // ...
  cache: {
    ttl: 5_000,        // default TTL for `cache: true` (default: 1000)
    maxEntries: 5_000, // in-memory store capacity (default: 1000 entries)
  },
});
```

`cache: false` is a kill switch: every per-query `cache` request is silently ignored. Useful for turning caching off in a test environment without touching call sites.

### Custom Stores

The default store is an in-memory LRU with per-entry TTL, private to the `EntityManager`. For a shared cache (multiple processes, one Redis), implement `QueryCacheStore`:

```typescript
import { QueryCacheStore } from "@stingerloom/orm";

class RedisQueryCacheStore implements QueryCacheStore {
  async get(key: string) { /* ... */ }
  async set(key: string, value: unknown, ttlMs: number, tags: readonly string[]) { /* ... */ }
  async invalidateTags(tags: readonly string[]) { /* ... */ }
  async clear() { /* ... */ }
}

await em.register({
  // ...
  cache: { store: new RedisQueryCacheStore() },
});
```

Notes for store authors:

- Keys are plain strings (namespace + SQL text + bind values). Hash them on your side if your backend prefers short keys.
- `value` is an opaque snapshot; return exactly what `set` received.
- Tag-indexed invalidation must drop every entry stored under any of the given tags.
- Throw on failure. The ORM logs one warning and falls through to the database — a broken cache degrades to no cache, never to an error.

When a store is configured at `register` time, it is created eagerly, so a process that only writes still pushes its invalidations into the shared backend.

## Multi-Tenancy

Cache keys are namespaced by connection name, schema, and the current tenant (`MetadataContext`). Two tenants issuing byte-identical SQL — as happens under `search_path`-based schema tenancy — can never read each other's rows from the cache.

Invalidation is deliberately broader: a write invalidates the affected tables across all tenants of the connection. That is over-eager (tenant A's write also drops tenant B's entries for the same table) but always safe.

## When To Use It

Good fits:

- Hot, read-mostly queries: navigation trees, settings, feature flags, product listings, dashboard counters.
- Expensive aggregates recomputed on every request (`findAndCount` pairs, `getCount`).
- Endpoints where "up to N seconds stale" is an acceptable contract.

Poor fits:

- Anything read right after an out-of-band write (queue consumers writing raw SQL, other services sharing the database) — unless the TTL is small enough to absorb it.
- Queries whose parameters never repeat (search with free-text input) — every call is a miss plus a snapshot cost.

For repeated queries that must always be **current**, use [compiled queries](/query-builder-execution) instead — they skip the SQL-building overhead while still hitting the database every time. The two compose: a compiled query saves CPU, a cached query saves the round trip.
