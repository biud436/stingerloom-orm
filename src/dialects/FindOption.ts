import { ISelectOption } from "./ISelectOption";
import { IOrderBy } from "./IOrderBy";
import { Sql } from "sql-template-tag";

/**
 * WHERE 조건 타입. 엔티티 필드 기반 자동완성을 제공하면서
 * 임의의 문자열 키(FK 컬럼 등)도 허용합니다.
 */
export type WhereClause<T> = {
  [K in keyof T]?: T[K];
} & Record<string, any>;

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
  relations?: string[];

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
