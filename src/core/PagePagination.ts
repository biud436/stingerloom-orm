/* eslint-disable @typescript-eslint/no-explicit-any */
import { WhereClause, RelationKeys } from "../dialects/FindOption";
import { ISelectOption } from "../dialects/ISelectOption";
import { IOrderBy } from "../dialects/IOrderBy";
import { Sql } from "../utils/sqlTag";
import { normalizePageSize } from "./CursorPagination";

/**
 * Options for offset-based page pagination.
 *
 * @template T - Entity type
 */
export type PagePaginationOption<T> = {
  /** 1-based page number (default: 1) */
  page?: number;

  /** Number of items per page (default: 20) */
  pageSize?: number;

  /** WHERE conditions */
  where?: WhereClause<T>;

  /** Sort order */
  orderBy?: IOrderBy<Partial<T>>;

  /** Fields to select */
  select?: ISelectOption<T>;

  /** Relations to load */
  relations?: RelationKeys<T>;

  /** Include soft-deleted entities */
  withDeleted?: boolean;

  /** Per-query timeout in milliseconds */
  timeout?: number;

  /** Force master node in replication setup */
  useMaster?: boolean;

  /** GROUP BY fields */
  groupBy?: (keyof T)[];

  /** HAVING conditions for GROUP BY */
  having?: Sql[];
};

/**
 * Result of offset-based page pagination.
 *
 * @template T - Entity type
 */
export type PagePaginationResult<T> = {
  /** Current page data */
  data: T[];

  /** Total number of matching entities */
  total: number;

  /** Current page number (1-based) */
  page: number;

  /** Number of items per page */
  pageSize: number;

  /** Total number of pages */
  totalPages: number;

  /** Whether a next page exists */
  hasNextPage: boolean;

  /** Whether a previous page exists */
  hasPreviousPage: boolean;
};

/**
 * Normalizes the page number.
 * undefined/null/0/negative → 1, decimal → floor.
 */
export function normalizePage(page?: number): number {
  if (page === undefined || page === null || page <= 0) {
    return 1;
  }
  return Math.floor(page);
}

export { normalizePageSize };
