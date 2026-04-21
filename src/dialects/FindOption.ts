import { ISelectOption } from "./ISelectOption";
import { IOrderBy } from "./IOrderBy";
import { Sql } from "sql-template-tag";

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
 * Type-safe relations type. Accepts entity property keys or arbitrary strings
 * (for nested relations like "author.profile").
 */
export type RelationKeys<T> = Array<(keyof T & string) | (string & {})>;

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
  [K in keyof T]?: T[K] | FieldFilter<T[K]> | Sql | null;
} & {
  OR?: WhereClause<T>[];
  AND?: WhereClause<T>[];
  NOT?: WhereClause<T>;
};

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
   * Accepts entity property keys for type-safe usage, or string literals for nested paths.
   *
   * @example
   * ```ts
   * // Type-safe — typos are caught at compile time
   * em.find(Post, { relations: ["author", "tags"] })
   *
   * // Nested relation (string literal)
   * em.find(Post, { relations: ["author", "author.profile"] })
   * ```
   */
  relations?: RelationKeys<T>;

  /**
   * If true, includes soft-deleted entities (@DeletedAt) in the results.
   * By default, soft-deleted entities are excluded from find/findOne queries.
   */
  withDeleted?: boolean;

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
};
