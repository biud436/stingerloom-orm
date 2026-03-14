import { ISelectOption } from "./ISelectOption";
import { IOrderBy } from "./IOrderBy";
import { Sql } from "sql-template-tag";

/**
 * Type-safe relations type. Accepts entity property keys or arbitrary strings
 * (for nested relations like "author.profile").
 */
export type RelationKeys<T> = Array<(keyof T & string) | (string & {})>;

/**
 * WHERE 조건 타입. 엔티티 필드 기반 자동완성과 타입 체크를 제공합니다.
 * 값에 `Sql` 객체(Conditions.* 결과)도 허용합니다.
 */
export type WhereClause<T> = {
  [K in keyof T]?: T[K] | Sql | null;
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
   * Each key corresponds to a field in the entity, and the value is the value to match.
   */
  where?: WhereClause<T>;

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
   * Replication 환경에서 강제로 master 노드를 사용하여 읽기 쿼리를 실행합니다.
   * 쓰기 직후 최신 데이터를 읽어야 하는 경우 등에 사용합니다.
   */
  useMaster?: boolean;
};
