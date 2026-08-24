/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../utils";
import { Sql } from "../../utils/sqlTag";
import { TransactionSessionManager } from "../../dialects/TransactionSessionManager";
import { MetadataContext } from "../../metadata/MetadataContext";
import { transactionStorage } from "../../decorators/Transactional";
import type { EntityManagerInternals } from "../EntityManagerInternals";

/**
 * Per-query cache request, accepted by `FindOption.cache` and
 * `SelectQueryBuilder.cache()`.
 *
 * - `true`     → cache with the connection-level default TTL
 * - `number`   → cache with that TTL in milliseconds
 * - `{ ttl, tag }` → TTL override plus a user tag for manual invalidation
 *   via `em.queryCache?.invalidate(tag)`
 */
export type QueryCacheOption =
  | boolean
  | number
  | { ttl?: number; tag?: string };

/**
 * Pluggable storage backend for the query result cache.
 *
 * Implementations may be synchronous (the built-in in-memory store) or
 * asynchronous (e.g. Redis). Values are opaque row snapshots produced by the
 * ORM — a store must return exactly what was passed to `set()`.
 *
 * Store failures must be thrown to the caller; the ORM catches them, logs a
 * warning once, and falls through to the database (fail-open).
 */
export interface QueryCacheStore {
  /** Returns the stored value, or `undefined` on miss/expiry. */
  get(key: string): unknown | undefined | Promise<unknown | undefined>;
  /** Stores `value` under `key` for `ttlMs`, indexed by `tags`. */
  set(
    key: string,
    value: unknown,
    ttlMs: number,
    tags: readonly string[],
  ): void | Promise<void>;
  /** Drops every entry indexed under any of `tags`. */
  invalidateTags(tags: readonly string[]): void | Promise<void>;
  /** Drops every entry. */
  clear(): void | Promise<void>;
  /** Optional: current entry count (surfaced via `QueryResultCache.stats`). */
  size?(): number;
}

/** Connection-level cache configuration (`register({ cache: {...} })`). */
export interface QueryCacheOptions {
  /** Default TTL in milliseconds for `cache: true` queries. Default: 1000. */
  ttl?: number;
  /** Max entries held by the built-in in-memory store. Default: 1000. */
  maxEntries?: number;
  /** Custom storage backend. Defaults to the in-memory LRU store. */
  store?: QueryCacheStore;
}

/** Hit/miss counters and (when the store reports it) the entry count. */
export interface QueryCacheStats {
  hits: number;
  misses: number;
  entries?: number;
}

export const DEFAULT_QUERY_CACHE_TTL = 1000;
export const DEFAULT_QUERY_CACHE_MAX_ENTRIES = 1000;

const TABLE_TAG_PREFIX = "t:";
const USER_TAG_PREFIX = "u:";

interface InMemoryEntry {
  value: unknown;
  expiresAt: number;
  tags: readonly string[];
}

/**
 * Default `QueryCacheStore`: a per-EntityManager in-memory LRU with lazy TTL
 * expiry and tag-indexed invalidation. Entry count is bounded by
 * `maxEntries`; there is no byte-size accounting.
 */
export class InMemoryQueryCacheStore implements QueryCacheStore {
  private readonly entries = new Map<string, InMemoryEntry>();
  private readonly tagIndex = new Map<string, Set<string>>();

  constructor(
    private readonly maxEntries: number = DEFAULT_QUERY_CACHE_MAX_ENTRIES,
  ) {}

  get(key: string): unknown | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.remove(key, entry);
      return undefined;
    }
    // Refresh recency: Map preserves insertion order, so re-inserting moves
    // the entry to the tail and eviction always takes the head (the LRU).
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(
    key: string,
    value: unknown,
    ttlMs: number,
    tags: readonly string[],
  ): void {
    const prev = this.entries.get(key);
    if (prev) this.remove(key, prev);
    while (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.remove(oldestKey, this.entries.get(oldestKey)!);
    }
    const entry: InMemoryEntry = {
      value,
      expiresAt: Date.now() + ttlMs,
      tags: [...tags],
    };
    this.entries.set(key, entry);
    for (const tag of entry.tags) {
      let keys = this.tagIndex.get(tag);
      if (!keys) this.tagIndex.set(tag, (keys = new Set()));
      keys.add(key);
    }
  }

  invalidateTags(tags: readonly string[]): void {
    for (const tag of tags) {
      const keys = this.tagIndex.get(tag);
      if (!keys) continue;
      for (const key of [...keys]) {
        const entry = this.entries.get(key);
        if (entry) this.remove(key, entry);
      }
    }
  }

  clear(): void {
    this.entries.clear();
    this.tagIndex.clear();
  }

  size(): number {
    return this.entries.size;
  }

  private remove(key: string, entry: InMemoryEntry): void {
    this.entries.delete(key);
    for (const tag of entry.tags) {
      const keys = this.tagIndex.get(tag);
      if (!keys) continue;
      keys.delete(key);
      if (keys.size === 0) this.tagIndex.delete(tag);
    }
  }
}

/**
 * A resolved decision to cache one read operation: the TTL, the table tags
 * the stored row sets are indexed under, and the session wrapper that
 * intercepts `session.query()` for the duration of the operation.
 */
export class QueryCachePolicy {
  constructor(
    private readonly cache: QueryResultCache,
    readonly ttl: number,
    readonly tags: readonly string[],
  ) {}

  /**
   * Returns a session whose `query()` serves SELECT row sets from the cache
   * and stores misses. All other statements (SET, transaction control) pass
   * through untouched, as does every non-`query` method — the wrapper
   * delegates via the prototype chain, so it is accepted anywhere a
   * `TransactionSessionManager` is.
   */
  wrapSession(session: TransactionSessionManager): TransactionSessionManager {
    const wrapped = Object.create(session) as TransactionSessionManager;
    (wrapped as any).query = (sqlArg: any) =>
      this.cache.runQuery(this, sqlArg, () => session.query(sqlArg));
    return wrapped;
  }

  /** Row-level cache wrapper for builder-issued queries (`em.query` path). */
  fetchRows<R>(sqlArg: string | Sql, exec: () => Promise<R>): Promise<R> {
    return this.cache.runQuery(this, sqlArg, exec) as Promise<R>;
  }
}

/**
 * Opt-in query result cache.
 *
 * Caches the **raw row sets** a read operation produces — never entity
 * instances. A cache hit replays the stored rows through the normal
 * hydration pipeline, so each call returns fresh entity instances and
 * `afterLoad` subscribers, column transformers, and lazy proxies behave
 * exactly as they do on a database read.
 *
 * Every stored row set is indexed under the tables the operation could read
 * (root entity, inheritance family, eager/requested relations, M2M join
 * tables). Writes issued through the same EntityManager invalidate those
 * tags; writes from other processes are only bounded by the TTL.
 *
 * Reads inside an active transaction always bypass the cache — a
 * transaction must observe its own uncommitted writes.
 */
export class QueryResultCache {
  private readonly store: QueryCacheStore;
  private readonly defaultTtl: number;
  private hitCount = 0;
  private missCount = 0;
  private storeErrorWarned = false;
  /** Per-entity memo of read/write tag closures, keyed by tenant + relations. */
  private readonly readTagsMemo = new WeakMap<object, Map<string, string[]>>();
  private readonly writeTagsMemo = new WeakMap<object, Map<string, string[]>>();

  constructor(
    private readonly ctx: EntityManagerInternals,
    options?: QueryCacheOptions,
  ) {
    this.defaultTtl = options?.ttl ?? DEFAULT_QUERY_CACHE_TTL;
    this.store =
      options?.store ??
      new InMemoryQueryCacheStore(
        options?.maxEntries ?? DEFAULT_QUERY_CACHE_MAX_ENTRIES,
      );
  }

  /** Hit/miss counters since this EntityManager was created. */
  get stats(): QueryCacheStats {
    const entries = this.store.size?.();
    return entries === undefined
      ? { hits: this.hitCount, misses: this.missCount }
      : { hits: this.hitCount, misses: this.missCount, entries };
  }

  /**
   * Resolves a `FindOption.cache` request into a policy, or `undefined` when
   * the operation must not be cached (no request, zero TTL, or an ambient
   * transaction is active).
   */
  policyForFind(
    entity: ClazzType<any>,
    option: {
      cache?: QueryCacheOption;
      relations?: readonly string[];
    },
  ): QueryCachePolicy | undefined {
    const normalized = this.normalizeOption(option.cache);
    if (!normalized) return undefined;
    if (transactionStorage.getStore()) return undefined;
    const tags = this.collectReadTags(entity, option.relations);
    if (normalized.tag) tags.push(USER_TAG_PREFIX + normalized.tag);
    return new QueryCachePolicy(this, normalized.ttl, tags);
  }

  /**
   * Resolves a `SelectQueryBuilder.cache()` request. Tags cover the root
   * entity and the entity-aware joins the builder knows about; raw
   * table-name joins are bounded by the TTL (add a user `tag` to invalidate
   * them manually).
   */
  policyForBuilder(
    root: ClazzType<any>,
    joined: readonly ClazzType<any>[],
    option: QueryCacheOption | undefined,
  ): QueryCachePolicy | undefined {
    const normalized = this.normalizeOption(option);
    if (!normalized) return undefined;
    if (transactionStorage.getStore()) return undefined;
    const tags = new Set<string>(this.collectReadTags(root, undefined));
    for (const entity of joined) {
      for (const tag of this.collectReadTags(entity, undefined)) {
        tags.add(tag);
      }
    }
    const list = [...tags];
    if (normalized.tag) list.push(USER_TAG_PREFIX + normalized.tag);
    return new QueryCachePolicy(this, normalized.ttl, list);
  }

  /**
   * Serves one SQL statement through the cache: SELECT/WITH row sets are
   * looked up and stored; everything else executes directly. Store failures
   * are logged once and fall through to the database.
   */
  async runQuery(
    policy: QueryCachePolicy,
    sqlArg: string | Sql,
    exec: () => Promise<any>,
  ): Promise<any> {
    const text = typeof sqlArg === "string" ? sqlArg : sqlArg.sql;
    if (!/^\s*(select|with)\b/i.test(text)) return exec();
    const values = typeof sqlArg === "string" ? [] : sqlArg.values;
    const key = this.buildKey(text, values);

    try {
      const hit = await this.store.get(key);
      if (hit !== undefined) {
        this.hitCount++;
        // Clone on the way out: the pipeline mutates rows in place (boolean
        // coercion, NamingStrategy remapping), so shared snapshots would rot.
        return cloneSnapshot(hit);
      }
    } catch (e) {
      this.warnStoreError(e);
    }

    this.missCount++;
    const result = await exec();
    const snapshot = this.snapshotRows(result);
    if (snapshot !== undefined) {
      try {
        await this.store.set(key, snapshot, policy.ttl, policy.tags);
      } catch (e) {
        this.warnStoreError(e);
      }
    }
    return result;
  }

  /**
   * Drops every cached row set that could contain rows from tables the
   * given entity's writes can reach (its own tables, inheritance family,
   * child tables via one-to-many/one-to-one, and M2M join tables). Called
   * by every EntityManager write path after it completes.
   */
  async invalidateEntity(entity: ClazzType<any>): Promise<void> {
    try {
      await this.store.invalidateTags(this.collectWriteTags(entity));
    } catch (e) {
      this.warnStoreError(e);
    }
  }

  /**
   * Manual invalidation. Accepts entity classes (invalidates their write
   * closure) and strings (invalidates both the table tag and the user tag
   * of that name).
   */
  async invalidate(
    ...targets: Array<ClazzType<any> | string>
  ): Promise<void> {
    const tags: string[] = [];
    for (const target of targets) {
      if (typeof target === "string") {
        tags.push(TABLE_TAG_PREFIX + target, USER_TAG_PREFIX + target);
      } else {
        tags.push(...this.collectWriteTags(target));
      }
    }
    if (tags.length === 0) return;
    try {
      await this.store.invalidateTags(tags);
    } catch (e) {
      this.warnStoreError(e);
    }
  }

  /** Drops every cached row set. */
  async clear(): Promise<void> {
    try {
      await this.store.clear();
    } catch (e) {
      this.warnStoreError(e);
    }
  }

  // ── Internals ────────────────────────────────────────────────

  private normalizeOption(
    option: QueryCacheOption | undefined,
  ): { ttl: number; tag?: string } | undefined {
    if (!option) return undefined;
    if (option === true) return { ttl: this.defaultTtl };
    if (typeof option === "number") {
      return option > 0 ? { ttl: option } : undefined;
    }
    const ttl = option.ttl ?? this.defaultTtl;
    return ttl > 0 ? { ttl, tag: option.tag } : undefined;
  }

  /**
   * Cache-key namespace: everything that changes which physical rows the
   * same SQL text can see. The tenant component is what keeps
   * search_path-based schema tenancy from ever serving one tenant's rows
   * to another — the SQL text is identical across tenants there.
   */
  private namespace(): string {
    const tenant = MetadataContext.getCurrentTenant();
    return `${this.ctx.getDbType() ?? ""}|${this.ctx.getConnectionName()}|${
      this.ctx.getSchema() ?? ""
    }|${tenant}`;
  }

  /**
   * Plain string key: namespace, SQL text, and serialized binds joined with
   * NUL separators. Deliberately not hashed — hashing costs more than the
   * Map lookup it would save, and a custom store that needs short keys
   * (e.g. Redis) can hash on its own side.
   */
  private buildKey(text: string, values: readonly unknown[]): string {
    return (
      this.namespace() + "\u0000" + text + "\u0000" + serializeBindValues(values)
    );
  }

  /**
   * Immutable snapshot of a query result. Only the row arrays are kept:
   * driver-specific extras (`fields`, insert metadata) may carry
   * non-cloneable values and are never read by the SELECT pipeline.
   * Returns `undefined` when the result is not cacheable.
   */
  private snapshotRows(result: unknown): unknown {
    try {
      if (Array.isArray(result)) return cloneRows(result);
      if (
        result !== null &&
        typeof result === "object" &&
        Array.isArray((result as any).results)
      ) {
        return { results: cloneRows((result as any).results) };
      }
    } catch {
      // Rows carried values no clone can take (e.g. functions) — skip
      // caching this one.
    }
    return undefined;
  }

  private collectReadTags(
    entity: ClazzType<any>,
    relations: readonly string[] | undefined,
  ): string[] {
    const memoKey = `${this.namespace()}|${(relations ?? []).join(",")}`;
    let perEntity = this.readTagsMemo.get(entity);
    if (perEntity?.has(memoKey)) return [...perEntity.get(memoKey)!];

    const tables = new Set<string>();
    const visited = new Set<ClazzType<any>>();
    this.visitReadClosure(entity, relations, tables, visited);
    const tags = [...tables].map((t) => TABLE_TAG_PREFIX + t);

    if (!perEntity) this.readTagsMemo.set(entity, (perEntity = new Map()));
    perEntity.set(memoKey, tags);
    return [...tags];
  }

  /**
   * Tables a find over `entity` can read: its own tables (including the
   * inheritance family), targets of eager relations (recursively — loaders
   * hydrate related entities through the same eager machinery), targets of
   * the explicitly requested top-level `relations`, and the join tables of
   * any traversed many-to-many relation.
   */
  private visitReadClosure(
    entity: ClazzType<any>,
    relations: readonly string[] | undefined,
    tables: Set<string>,
    visited: Set<ClazzType<any>>,
  ): void {
    if (visited.has(entity)) return;
    visited.add(entity);
    this.addEntityTables(entity, tables);

    const resolver = this.ctx.getResolver();
    const follow = (target: ClazzType<any> | undefined) => {
      if (target) this.visitReadClosure(target, undefined, tables, visited);
    };

    for (const rel of safeCall(() => resolver.resolveManyToOneMetadata(entity)) ?? []) {
      if (rel.option?.eager === true || relations?.includes(rel.columnName)) {
        follow(safeCall(() => rel.getMappingEntity() as ClazzType<any>));
      }
    }
    for (const rel of safeCall(() => resolver.resolveOneToOneMetadata(entity)) ?? []) {
      if (rel.option?.eager === true || relations?.includes(rel.propertyKey)) {
        follow(safeCall(() => rel.getRelatedEntity() as ClazzType<any>));
      }
    }
    for (const rel of safeCall(() => resolver.resolveOneToManyMetadata(entity)) ?? []) {
      if (relations?.includes(rel.propertyKey)) {
        follow(safeCall(() => rel.getRelatedEntity() as ClazzType<any>));
      }
    }
    for (const rel of safeCall(() => resolver.resolveManyToManyMetadata(entity)) ?? []) {
      if (relations?.includes(rel.propertyKey)) {
        const joinInfo = safeCall(() => resolver.resolveManyToManyJoinTable(rel));
        if (joinInfo?.joinTableName) tables.add(joinInfo.joinTableName);
        follow(safeCall(() => rel.getRelatedEntity() as ClazzType<any>));
      }
    }
  }

  private collectWriteTags(entity: ClazzType<any>): string[] {
    const memoKey = this.namespace();
    let perEntity = this.writeTagsMemo.get(entity);
    if (perEntity?.has(memoKey)) return [...perEntity.get(memoKey)!];

    const tables = new Set<string>();
    const visited = new Set<ClazzType<any>>();
    this.visitWriteClosure(entity, tables, visited);
    const tags = [...tables].map((t) => TABLE_TAG_PREFIX + t);

    if (!perEntity) this.writeTagsMemo.set(entity, (perEntity = new Map()));
    perEntity.set(memoKey, tags);
    return [...tags];
  }

  /**
   * Tables a write to `entity` can touch beyond its own: child tables via
   * one-to-many / one-to-one (ORM cascades re-enter the public write APIs
   * and invalidate themselves, but DB-level ON DELETE CASCADE does not),
   * and M2M join tables plus their targets. Many-to-one parents are not
   * followed — writing a child never mutates its parent row.
   */
  private visitWriteClosure(
    entity: ClazzType<any>,
    tables: Set<string>,
    visited: Set<ClazzType<any>>,
  ): void {
    if (visited.has(entity)) return;
    visited.add(entity);
    this.addEntityTables(entity, tables);

    const resolver = this.ctx.getResolver();
    const follow = (target: ClazzType<any> | undefined) => {
      if (target) this.visitWriteClosure(target, tables, visited);
    };

    for (const rel of safeCall(() => resolver.resolveOneToManyMetadata(entity)) ?? []) {
      follow(safeCall(() => rel.getRelatedEntity() as ClazzType<any>));
    }
    for (const rel of safeCall(() => resolver.resolveOneToOneMetadata(entity)) ?? []) {
      follow(safeCall(() => rel.getRelatedEntity() as ClazzType<any>));
    }
    for (const rel of safeCall(() => resolver.resolveManyToManyMetadata(entity)) ?? []) {
      const joinInfo = safeCall(() => resolver.resolveManyToManyJoinTable(rel));
      if (joinInfo?.joinTableName) tables.add(joinInfo.joinTableName);
      follow(safeCall(() => rel.getRelatedEntity() as ClazzType<any>));
    }
  }

  /** The entity's own table plus its inheritance family's tables. */
  private addEntityTables(
    entity: ClazzType<any>,
    tables: Set<string>,
  ): void {
    const resolver = this.ctx.getResolver();
    const inheritance = this.ctx.getInheritanceResolver();
    const addTableOf = (cls: ClazzType<any>) => {
      const meta = safeCall(() => resolver.resolveEntityMetadata(cls));
      if (meta?.name) tables.add(meta.name);
    };
    addTableOf(entity);

    if (safeCall(() => inheritance.getStrategy(entity))) {
      const root =
        safeCall(() => inheritance.getRoot(entity) as ClazzType<any> | null) ??
        entity;
      addTableOf(root);
      for (const concrete of safeCall(
        () => inheritance.getConcreteEntities(root) as ClazzType<any>[],
      ) ?? []) {
        addTableOf(concrete);
      }
    }
  }

  private warnStoreError(e: unknown): void {
    if (this.storeErrorWarned) return;
    this.storeErrorWarned = true;
    this.ctx
      .getLogger()
      .warn(
        `Query cache store error — falling back to the database (further store errors are suppressed): ${e}`,
      );
  }
}

function safeCall<R>(fn: () => R): R | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/**
 * Deterministic serialization of bind values for the cache key. JSON with
 * explicit handling for the value kinds SQL binds can carry that JSON
 * cannot round-trip on its own.
 */
function serializeBindValues(values: readonly unknown[]): string {
  return JSON.stringify(values, (_key, value) => {
    if (typeof value === "bigint") return `bi:${value.toString()}`;
    if (typeof value === "undefined") return "undef";
    return value;
  });
}

/**
 * Fast snapshot clone for driver row sets. Rows are overwhelmingly flat
 * objects of primitives with the occasional Date/Buffer; hand-rolling those
 * cases is several times cheaper than `structuredClone`, which matters
 * because the clone runs on every cache hit. Nested objects (e.g. a parsed
 * PostgreSQL json column) fall back to `structuredClone`; a value neither
 * path can take throws to the caller, which then skips caching.
 */
function cloneRows(rows: readonly any[]): any[] {
  const out = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row === null || typeof row !== "object") {
      out[i] = row;
      continue;
    }
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(row)) {
      const value = row[key];
      const kind = typeof value;
      if (value === null || (kind !== "object" && kind !== "function")) {
        copy[key] = value;
      } else if (kind === "function") {
        // Sharing a function (and its closure) between the snapshot and
        // every hit is not a snapshot — treat the row set as uncacheable,
        // matching structuredClone's contract.
        throw new TypeError("Cannot snapshot a row containing a function");
      } else if (value instanceof Date) {
        copy[key] = new Date(value.getTime());
      } else if (Buffer.isBuffer(value)) {
        copy[key] = Buffer.from(value);
      } else {
        copy[key] = structuredClone(value);
      }
    }
    out[i] = copy;
  }
  return out;
}

/** Clone a stored snapshot (array or `{ results }`) for one cache hit. */
function cloneSnapshot(snapshot: unknown): unknown {
  if (Array.isArray(snapshot)) return cloneRows(snapshot);
  return { results: cloneRows((snapshot as { results: any[] }).results) };
}
