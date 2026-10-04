import { ISelectOption } from "./ISelectOption";
import { IOrderBy } from "./IOrderBy";
import { Sql } from "../utils/sqlTag";

/**
 * Pessimistic lock modes for SELECT queries.
 *
 * - PESSIMISTIC_READ:  SELECT ... FOR SHARE (PostgreSQL) / LOCK IN SHARE MODE (MySQL)
 * - PESSIMISTIC_WRITE: SELECT ... FOR UPDATE
 * - PESSIMISTIC_WRITE_NOWAIT: SELECT ... FOR UPDATE NOWAIT (MySQL 8.0+, PostgreSQL 9.5+)
 * - PESSIMISTIC_READ_NOWAIT: SELECT ... FOR SHARE NOWAIT (MySQL 8.0+, PostgreSQL 9.5+)
 * - PESSIMISTIC_WRITE_SKIP_LOCKED: SELECT ... FOR UPDATE SKIP LOCKED (MySQL 8.0+, PostgreSQL 9.5+)
 * - PESSIMISTIC_READ_SKIP_LOCKED: SELECT ... FOR SHARE SKIP LOCKED (MySQL 8.0+, PostgreSQL 9.5+)
 */
export enum LockMode {
  PESSIMISTIC_READ = "PESSIMISTIC_READ",
  PESSIMISTIC_WRITE = "PESSIMISTIC_WRITE",
  PESSIMISTIC_WRITE_NOWAIT = "PESSIMISTIC_WRITE_NOWAIT",
  PESSIMISTIC_READ_NOWAIT = "PESSIMISTIC_READ_NOWAIT",
  PESSIMISTIC_WRITE_SKIP_LOCKED = "PESSIMISTIC_WRITE_SKIP_LOCKED",
  PESSIMISTIC_READ_SKIP_LOCKED = "PESSIMISTIC_READ_SKIP_LOCKED",
}

/**
 * Type-safe relations type. Accepts entity property keys, keeping an escape
 * hatch for entities whose type is not statically known (EntitySchema-defined
 * or `any`-typed classes). Names that no relation matches are rejected at
 * query time, so the escape hatch cannot silently swallow a typo.
 */
export type RelationKeys<T> = Array<(keyof T & string) | (string & {})>;

/**
 * The entity a relation property holds: the element of a collection, the
 * value of a single-valued (or lazy, Promise-typed) relation, without
 * `null` / `undefined`.
 */
export type RelationTarget<V> =
  NonNullable<V> extends Promise<infer U>
    ? RelationTarget<U>
    : NonNullable<V> extends ReadonlyArray<infer E>
      ? NonNullable<E>
      : NonNullable<V>;

type NonRelationValue =
  | string
  | number
  | bigint
  | boolean
  | symbol
  | Date
  | Uint8Array
  | ((...args: never[]) => unknown);

/**
 * Property names of `T` that can hold a related entity. Anything typed as a
 * scalar is left out; an object-typed column (a `json` column) is not told
 * apart from a relation by type alone, so the read rejects it by name.
 */
export type RelationPropertyKeys<T> = {
  [K in keyof T & string]-?: RelationTarget<T[K]> extends NonRelationValue
    ? never
    : RelationTarget<T[K]> extends object
      ? K
      : never;
}[keyof T & string];

/**
 * Property names of `T` that hold a collection of related entities — the
 * `@OneToMany` and `@ManyToMany` properties.
 */
export type CollectionRelationKeys<T> = {
  [K in RelationPropertyKeys<T>]-?: NonNullable<Awaited<T[K]>> extends ReadonlyArray<unknown>
    ? K
    : never;
}[RelationPropertyKeys<T>];

/**
 * Property names of `T` typed as a number — the properties `withCount` can
 * write a count to.
 */
export type CountPropertyKeys<T> = {
  [K in keyof T & string]-?: [NonNullable<T[K]>] extends [never]
    ? never
    : [NonNullable<T[K]>] extends [number]
      ? K
      : never;
}[keyof T & string];

/**
 * One relation count of `withCount` that counts only some of the related
 * rows.
 *
 * @template T - The entity the count is attached to.
 * @template K - The collection relation counted.
 */
export interface RelationCountOptions<T, K extends CollectionRelationKeys<T>> {
  /** The `@OneToMany` / `@ManyToMany` relation whose rows are counted. */
  relation: K;
  /** Counts only the related rows that match — the related entity's where. */
  where?: WhereClause<RelationTarget<T[K]>> | WhereClause<RelationTarget<T[K]>>[];
  /** Counts soft-deleted related rows too, whatever the read's `withDeleted` says. */
  withDeleted?: boolean;
}

/**
 * Counts written onto each entity a read returns: keyed by the property the
 * count is written to (a `number` property the entity declares besides its
 * columns), each value names the collection relation to count — or gives
 * {@link RelationCountOptions} to count only some of its rows. An entity
 * with no related rows gets 0.
 *
 * @example
 * ```ts
 * class Post {
 *   @OneToMany(() => Comment, (c) => c.post) comments!: Comment[];
 *   commentCount?: number;
 *   approvedCount?: number;
 * }
 *
 * em.find(Post, {
 *   withCount: {
 *     commentCount: "comments",
 *     approvedCount: { relation: "comments", where: { approved: true } },
 *   },
 * })
 * ```
 */
export type WithCountOption<T> = {
  [P in CountPropertyKeys<T>]?:
    | CollectionRelationKeys<T>
    | { [K in CollectionRelationKeys<T>]: RelationCountOptions<T, K> }[CollectionRelationKeys<T>];
};

/**
 * What to load together with one relation in the object form of
 * `relations`.
 *
 * @template R - The related entity.
 */
export interface RelationLoadOptions<R> {
  /**
   * Relations of the related entity to load on it, in any form `relations`
   * accepts — names, dotted paths or another object.
   *
   * @example
   * ```ts
   * em.find(Post, {
   *   relations: { comments: { relations: { author: true } } },
   * })
   * ```
   */
  relations?: RelationsOption<R>;

  /**
   * Loads only the related rows that match — the same operators as the
   * read's own `where`. Collection relations (`@OneToMany`, `@ManyToMany`)
   * only; it filters the relation, not the parents.
   *
   * @example
   * ```ts
   * em.find(Post, { relations: { comments: { where: { approved: true } } } })
   * ```
   */
  where?: WhereClause<R> | WhereClause<R>[];

  /**
   * Orders each parent's related rows. Collection relations only.
   */
  orderBy?: IOrderBy<Partial<R>>;

  /**
   * Loads at most this many related rows per parent, in `orderBy` order
   * (the related primary key when no `orderBy` is given). Collection
   * relations only. Needs window functions: MySQL 8.0+, MariaDB 10.2+,
   * SQLite 3.25+.
   *
   * @example
   * ```ts
   * // Each post with its three newest comments
   * em.find(Post, {
   *   relations: { comments: { orderBy: { createdAt: "DESC" }, take: 3 } },
   * })
   * ```
   */
  take?: number;

  /**
   * Skips this many related rows per parent before `take` applies.
   * Collection relations only.
   */
  skip?: number;

  /**
   * Includes soft-deleted related rows for this relation, whatever the
   * read's own `withDeleted` says. Relations nested under it follow their
   * own setting, or the read's.
   */
  withDeleted?: boolean;

  /**
   * Counts written onto each related entity the relation loads — see
   * {@link WithCountOption}.
   *
   * @example
   * ```ts
   * // Each post's comments, each with its like count
   * em.find(Post, {
   *   relations: { comments: { withCount: { likeCount: "likes" } } },
   * })
   * ```
   */
  withCount?: WithCountOption<R>;
}

/**
 * What to load together with a single-valued relation (`@ManyToOne`,
 * `@OneToOne`) in the object form of `relations`: the relations nested
 * under it, its own `withDeleted` and counts on the related entity.
 * `where`, `orderBy`, `take` and `skip` page a collection and are not
 * offered here.
 *
 * @template R - The related entity.
 */
export type SingleRelationLoadOptions<R> = Pick<
  RelationLoadOptions<R>,
  "relations" | "withDeleted" | "withCount"
>;

/**
 * The object form of `relations`: one key per relation, `true` to load it,
 * or the relation's options to also load relations nested under it —
 * {@link RelationLoadOptions} for a collection property,
 * {@link SingleRelationLoadOptions} for a single-valued one.
 */
export type RelationsObject<T> = {
  [K in RelationPropertyKeys<T>]?:
    | boolean
    | (NonNullable<Awaited<T[K]>> extends ReadonlyArray<unknown>
        ? RelationLoadOptions<RelationTarget<T[K]>>
        : SingleRelationLoadOptions<RelationTarget<T[K]>>);
};

/**
 * The relations a read loads with each entity.
 *
 * - An array of relation names, where a dotted path (`"comments.author"`)
 *   loads a relation of the related entity.
 * - An object keyed by relation name (see {@link RelationsObject}).
 */
export type RelationsOption<T> = RelationKeys<T> | RelationsObject<T>;

// ── Filter Types (Prisma-style) ─────────────────────────────

/**
 * Base filter operators available for all field types.
 */
export interface BaseFilter<T> {
  eq?: T;
  ne?: T;
  in?: T[];
  notIn?: T[];
  not?: T | FieldFilter<T>;
  isNull?: boolean;
}

/**
 * Filter operators for comparable types (number, Date, string, bigint).
 * Adds gt/gte/lt/lte/between on top of BaseFilter.
 */
export interface ComparableFilter<T> extends BaseFilter<T> {
  gt?: T;
  gte?: T;
  lt?: T;
  lte?: T;
  between?: [T, T];
}

/**
 * Filter operators for string fields.
 * Adds like/ilike/contains/startsWith/endsWith on top of ComparableFilter.
 *
 * - `like` / `notLike`: raw LIKE pattern (user provides `%` wildcards)
 * - `ilike`: case-insensitive LIKE (PostgreSQL only)
 * - `contains`: LIKE '%value%' (wildcards auto-escaped)
 * - `startsWith`: LIKE 'value%' (wildcards auto-escaped)
 * - `endsWith`: LIKE '%value' (wildcards auto-escaped)
 */
export interface StringFilter extends ComparableFilter<string> {
  like?: string;
  notLike?: string;
  ilike?: string;
  contains?: string;
  startsWith?: string;
  endsWith?: string;
  /** Full-text search query. Uses MATCH...AGAINST on MySQL, to_tsvector/plainto_tsquery on PostgreSQL. */
  search?: string;
}

/**
 * Maps a field type to its allowed filter operators.
 *
 * - `string` → StringFilter (includes like, contains, startsWith, endsWith)
 * - `number | Date | bigint` → ComparableFilter (includes gt, lt, between)
 * - everything else → BaseFilter (eq, ne, in, notIn, isNull)
 */
export type FieldFilter<T> = T extends string
  ? StringFilter
  : T extends number | Date | bigint
    ? ComparableFilter<T>
    : BaseFilter<T>;

// ── Where Clause ────────────────────────────────────────────

/**
 * Set of operator keys used to distinguish filter objects from plain values
 * at runtime.
 */
export const FILTER_OPERATOR_KEYS = new Set([
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "notIn",
  "like",
  "notLike",
  "ilike",
  "between",
  "isNull",
  "not",
  "contains",
  "startsWith",
  "endsWith",
  "search",
]);

/**
 * WHERE clause type with Prisma-style nested filter operators.
 *
 * Each field accepts:
 * - A literal value (implicit equality)
 * - A filter object with named operators (`{ gt: 18, lte: 65 }`)
 * - A raw `Sql` object (for advanced/custom conditions)
 * - `null` (IS NULL)
 *
 * Logical combinators are available as special keys:
 * - `OR`: array of WhereClause — conditions joined with OR
 * - `AND`: array of WhereClause — conditions joined with AND
 * - `NOT`: a single WhereClause — negated with NOT
 *
 * @example
 * ```ts
 * em.find(User, {
 *   where: {
 *     age: { gt: 18, lte: 65 },
 *     name: { contains: "alice" },
 *     role: { in: ["admin", "editor"] },
 *     status: { ne: "deleted" },
 *     OR: [
 *       { role: "admin" },
 *       { score: { gte: 90 } },
 *     ],
 *   }
 * })
 * ```
 */
export type WhereClause<T> = {
  // T[K][] is the bare-array shorthand for `IN (…)` — the runtime
  // resolver, plus softDelete/restore's bespoke iterator, both
  // accept it. Document the typed `{ in: [...] }` form via FieldFilter
  // for full find()/findOne() coverage.
  [K in keyof T]?:
    | T[K]
    | T[K][]
    | FieldFilter<T[K]>
    | Sql
    | null
    | (K extends RelationPropertyKeys<T> ? RelationFilter<T[K]> : never);
} & {
  OR?: WhereClause<T>[];
  AND?: WhereClause<T>[];
  NOT?: WhereClause<T>;
};

/**
 * Filters rows by their related rows through a collection relation
 * (`@OneToMany`, `@ManyToMany`). Each key takes a where clause of the
 * related entity — an array ORs its elements, as the read's `where` does.
 *
 * - `some`: at least one related row matches (`some: {}` — has any)
 * - `none`: no related row matches (`none: {}` — has none)
 * - `every`: no related row fails to match (true when there are none)
 */
export type CollectionRelationFilter<E> = {
  some?: WhereClause<E> | WhereClause<E>[];
  none?: WhereClause<E> | WhereClause<E>[];
  every?: WhereClause<E> | WhereClause<E>[];
};

/**
 * Filters rows by the row a single-valued relation (`@ManyToOne`,
 * `@OneToOne`) points at.
 *
 * - `is`: the related row exists and matches; `is: null` — there is none
 * - `isNot`: no related row matches (a missing one included); `isNot: null`
 *   — there is one
 */
export type SingleRelationFilter<E> = {
  is?: WhereClause<E> | WhereClause<E>[] | null;
  isNot?: WhereClause<E> | WhereClause<E>[] | null;
};

/** The relation filter a relation property of type `V` accepts in `where`. */
export type RelationFilter<V> =
  NonNullable<Awaited<V>> extends ReadonlyArray<unknown>
    ? CollectionRelationFilter<RelationTarget<V>>
    : SingleRelationFilter<RelationTarget<V>>;

/**
 * Data type for the `updateMany` SET clause.
 * Each value can be a literal entity field value or a raw `Sql` expression.
 *
 * @example
 * ```ts
 * em.updateMany(Post, { viewCount: sql`view_count + 1` }, { where: { id: 1 } });
 * ```
 */
export type UpdateData<T> = {
  [K in keyof T]?: T[K] | Sql;
};

/**
 * Options for `updateMany`.
 *
 * - `where`: required filter — empty WHERE is rejected to prevent table-wide updates.
 * - `orderBy`: optional sort applied before `limit`. Required when `limit` is set.
 * - `limit`: optional row cap. On MySQL/MariaDB it emits native
 *   `UPDATE … ORDER BY … LIMIT n`; on PostgreSQL / SQLite it rewrites to
 *   `UPDATE … WHERE pk IN (SELECT pk FROM … ORDER BY … LIMIT n)`. Composite-PK
 *   entities are not supported by the rewrite path and throw a typed error.
 * - `withDeleted`: opt back into updating soft-deleted rows. By default
 *   `updateMany` (and the `update`/`increment`/`decrement` helpers that route
 *   through it) skip rows whose `@DeletedAt` column is set, mirroring `find()`.
 *   Set `true` to also touch trashed rows. No effect on entities without a
 *   `@DeletedAt` column.
 *
 * @example
 * ```ts
 * em.updateMany(
 *   Issue,
 *   { claimedBy: workerId, claimedAt: sql`NOW()` },
 *   {
 *     where: { projectId, status: { in: [BACKLOG, TODO] } },
 *     orderBy: { priority: "ASC", number: "ASC" },
 *     limit: 1,
 *   },
 * );
 * ```
 */
export type UpdateManyOptions<T> = {
  where: WhereClause<T>;
  orderBy?: IOrderBy<Partial<T>>;
  limit?: number;
  withDeleted?: boolean;
};

/**
 * Represents the options that can be used to find entities in the ORM.
 *
 * @template T - The type of the entity.
 */
export type FindOption<T> = {
  /**
   * Specifies the fields to select in the query.
   */
  select?: ISelectOption<T>;

  /**
   * Specifies the conditions to filter the entities.
   *
   * Accepts a single WhereClause (all conditions AND-ed),
   * or an array of WhereClauses (each element AND-ed internally, elements OR-ed together).
   *
   * @example
   * ```ts
   * // Single where (AND)
   * em.find(User, { where: { name: "Alice", age: { gt: 18 } } })
   *
   * // Array where (OR between groups)
   * em.find(User, {
   *   where: [
   *     { name: "Alice", status: "active" },
   *     { age: { gt: 30 }, role: "admin" },
   *   ]
   * })
   * ```
   */
  where?: WhereClause<T> | WhereClause<T>[];

  /**
   * Specifies the limit for the number of entities to retrieve.
   * Can be a tuple representing the offset and limit, or a single number representing the limit.
   *
   * For standard pagination, prefer using `skip` and `take` instead.
   */
  limit?: [number, number] | number;

  /**
   * Number of entities to skip (offset). Used with `take` for pagination.
   *
   * @example
   * ```ts
   * // Skip 10 rows, take 5
   * em.find(User, { skip: 10, take: 5 })
   * ```
   */
  skip?: number;

  /**
   * Maximum number of entities to retrieve. Used with `skip` for pagination.
   *
   * @example
   * ```ts
   * // Take the first 10
   * em.find(User, { take: 10 })
   * ```
   */
  take?: number;

  /**
   * Specifies the order in which to sort the entities.
   */
  orderBy?: IOrderBy<Partial<T>>;

  /**
   * Specifies the fields to group the entities by.
   */
  groupBy?: (keyof T)[];

  /**
   * Specifies HAVING conditions for GROUP BY queries.
   * Accepts an array of sql-template-tag Sql conditions joined with AND.
   */
  having?: Sql[];

  /**
   * Specifies the relations to include in the query.
   *
   * Each name must be a relation property declared on the entity with
   * `@ManyToOne` / `@OneToMany` / `@ManyToMany` / `@OneToOne`; a name no
   * relation matches is rejected at query time with the list of valid ones.
   * A dotted path (`"comments.author"`) or the object form loads relations
   * of the related entities as well, to any depth.
   *
   * @example
   * ```ts
   * // Type-safe — typos are caught at compile time
   * em.find(Post, { relations: ["author", "tags"] })
   *
   * // Nested: each comment with its author
   * em.find(Post, { relations: ["comments.author"] })
   * em.find(Post, { relations: { comments: { relations: { author: true } } } })
   *
   * // Throws InvalidQueryError: Unknown relation "autor" ... Did you mean "author"?
   * em.find(Post, { relations: ["autor"] })
   * ```
   */
  relations?: RelationsOption<T>;

  /**
   * Counts the rows of collection relations and writes each count onto
   * every entity the read returns — one batched statement per count — see
   * {@link WithCountOption}. The rows counted are the ones loading the
   * relation would attach (soft-deleted rows left out unless
   * `withDeleted`). Use `relations: { x: { withCount } }` to count on
   * related entities.
   *
   * @example
   * ```ts
   * em.find(Post, { withCount: { commentCount: "comments" } })
   * ```
   */
  withCount?: WithCountOption<T>;

  /**
   * If true, includes soft-deleted entities (@DeletedAt) in the results.
   * By default, soft-deleted entities are excluded from find/findOne queries.
   */
  withDeleted?: boolean;

  /**
   * If true, returns ONLY soft-deleted entities (@DeletedAt) — i.e. rows where
   * the deleted-at column IS NOT NULL. Useful for "trash"/recovery and audit
   * views that need to list exclusively the soft-deleted records.
   *
   * Notes:
   * - Takes precedence over `withDeleted` when both are set: `onlyDeleted: true`
   *   restricts the result to trashed rows regardless of `withDeleted`.
   * - If the entity has no @DeletedAt column this is a silent no-op (no extra
   *   predicate is emitted), matching the behavior of `withDeleted`.
   * - Combines with the caller's own `where` via AND, so it filters the trash
   *   within the provided conditions (e.g. a specific tenant).
   */
  onlyDeleted?: boolean;

  /**
   * Per-query timeout in milliseconds.
   * Overrides the connection-level queryTimeout from DatabaseClientOptions.
   * Uses driver-specific SET statements before executing the query.
   */
  timeout?: number;

  /**
   * Forces the read query to use the master node in a replication setup.
   * Useful when you need to read the latest data immediately after a write.
   */
  useMaster?: boolean;

  /**
   * Pessimistic lock mode. When set, the generated SELECT query includes
   * a locking clause (FOR UPDATE / FOR SHARE / LOCK IN SHARE MODE).
   *
   * - `PESSIMISTIC_WRITE`: `SELECT ... FOR UPDATE`
   * - `PESSIMISTIC_READ`: `SELECT ... FOR SHARE` (PostgreSQL) / `LOCK IN SHARE MODE` (MySQL)
   */
  lock?: LockMode;

  /**
   * If true, generates SELECT DISTINCT instead of SELECT.
   * Removes duplicate rows from the result set.
   */
  distinct?: boolean;

  /**
   * Under the `"tenant_column"` multi-tenancy strategy, this query skips the
   * automatic `tenant_id = <currentTenant>` predicate injection. Use for
   * admin / cross-tenant reads. Equivalent to wrapping the call in
   * `MetadataContext.runUnscoped()` but scoped to a single call.
   *
   * Does **not** affect eager-loaded relations — those still scope by tenant.
   * For context-wide opt-out use `MetadataContext.runUnscoped`.
   */
  withoutTenantScope?: boolean;

  /**
   * Opt-in query result caching for this read.
   *
   * - `true`     → cache with the connection-level default TTL (1s unless
   *   configured via `register({ cache: { ttl } })`)
   * - `number`   → cache with that TTL in milliseconds
   * - `{ ttl, tag }` → TTL override plus a user tag for manual invalidation
   *   via `em.queryCache?.invalidate(tag)`
   *
   * The cache stores raw row sets, not entity instances — every call (hit or
   * miss) hydrates fresh entities and fires `afterLoad`. Writes issued
   * through the same EntityManager invalidate affected tables automatically;
   * writes from other processes are only bounded by the TTL. Reads inside an
   * active transaction and locking reads (`lock`) always bypass the cache.
   *
   * @example
   * ```ts
   * em.find(Product, { where: { featured: true }, cache: 30_000 })
   * ```
   */
  cache?: boolean | number | { ttl?: number; tag?: string };
};
