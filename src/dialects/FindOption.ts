import { ISelectOption } from "./ISelectOption";
import { IOrderBy } from "./IOrderBy";
import { Sql } from "sql-template-tag";

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
  where?: {
    [K in keyof T]?: T[K];
  };

  /**
   * Specifies the limit for the number of entities to retrieve.
   * Can be a tuple representing the offset and limit, or a single number representing the limit.
   */
  limit?: [number, number] | number;

  /**
   * Specifies the number of entities to take.
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
   */
  relations?: (keyof T)[];

  /**
   * If true, includes soft-deleted entities (@DeletedAt) in the results.
   * By default, soft-deleted entities are excluded from find/findOne queries.
   */
  withDeleted?: boolean;

  /**
   * Enables query result caching.
   * - `true`: cache with default TTL (30 seconds)
   * - `number`: cache with specified TTL in milliseconds
   * - `false` or omitted: no caching
   */
  cache?: boolean | number;

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
