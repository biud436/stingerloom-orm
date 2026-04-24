/* eslint-disable @typescript-eslint/no-explicit-any */
import { WhereClause } from "../dialects/FindOption";

/**
 * Cursor-based pagination option.
 *
 * Uses the last value of the order-by column as the cursor instead of offsets,
 * delivering consistent performance even on very large datasets.
 *
 * @template T - the entity type
 */
export type CursorPaginationOption<T> = {
  /**
   * Page size (default: 20).
   */
  take?: number;

  /**
   * Last cursor from the previous page (Base64-encoded).
   * Omit when fetching the first page.
   */
  cursor?: string;

  /**
   * Order-by column (defaults to the entity's primary key).
   */
  orderBy?: keyof T & string;

  /**
   * Sort direction (defaults to "ASC").
   */
  direction?: "ASC" | "DESC";

  /**
   * Extra WHERE conditions.
   */
  where?: WhereClause<T>;

  /**
   * In a replication setup, forces read queries to use the master node.
   */
  useMaster?: boolean;

  /**
   * Skip tenant-column scoping under the `"tenant_column"` strategy.
   * See `FindOption.withoutTenantScope` for details.
   */
  withoutTenantScope?: boolean;
};

/**
 * Cursor-based pagination result.
 *
 * @template T - the entity type
 */
export type CursorPaginationResult<T> = {
  /**
   * Data array for the current page.
   */
  data: T[];

  /**
   * Whether a next page exists.
   */
  hasNextPage: boolean;

  /**
   * Cursor for the next page (Base64-encoded).
   * null when hasNextPage is false.
   */
  nextCursor: string | null;

  /**
   * Number of items on the current page.
   */
  count: number;
};

const DEFAULT_PAGE_SIZE = 20;

/**
 * Encode a cursor value as Base64.
 */
export function encodeCursor(value: unknown): string {
  const payload = JSON.stringify({ v: value });
  return Buffer.from(payload, "utf-8").toString("base64");
}

/**
 * Decode a Base64 cursor into its original value.
 * Returns null on invalid input.
 */
export function decodeCursor(cursor: string): unknown | null {
  try {
    const json = Buffer.from(cursor, "base64").toString("utf-8");
    const parsed = JSON.parse(json);
    return parsed.v;
  } catch {
    return null;
  }
}

/**
 * Normalize the `take` value of CursorPaginationOption.
 */
export function normalizePageSize(take?: number): number {
  if (take === undefined || take === null || take <= 0) {
    return DEFAULT_PAGE_SIZE;
  }
  return take;
}
