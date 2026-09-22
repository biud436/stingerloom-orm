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
   * If true, includes soft-deleted entities (@DeletedAt) in the results.
   * By default, soft-deleted entities are excluded from cursor pagination,
   * matching the behavior of find() and findWithPage(). Also lifts the
   * soft-delete filter on the relations the page loads.
   */
  withDeleted?: boolean;

  /**
   * Relations to load for every entity on the page, by property name —
   * the same names `FindOption.relations` accepts. Each relation is one
   * batched query per page (never one per row); `eager: true` relations are
   * loaded without being listed, exactly as `find()` does.
   */
  relations?: string[];

  /**
   * In a replication setup, forces read queries to use the master node.
   */
  useMaster?: boolean;

  /**
   * Per-query timeout in milliseconds, overriding the connection-level
   * `queryTimeout`. Mirrors `FindOption.timeout`.
   */
  timeout?: number;

  /**
   * Skip tenant-column scoping under the `"tenant_column"` strategy.
   * See `FindOption.withoutTenantScope` for details.
   */
  withoutTenantScope?: boolean;

  /**
   * Opt-in query result caching for this page read.
   * See `FindOption.cache` for semantics — the cursor value participates in
   * the cache key, so each page caches independently.
   */
  cache?: boolean | number | { ttl?: number; tag?: string };
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
 * JSON has no BigInt literal, so a `bigintMode: "bigint"` order/PK value is
 * carried as a tagged object and revived on decode. Plain cursors (numbers,
 * strings, dates) are unaffected.
 */
const BIGINT_TAG = "$bigint";

function cursorReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? { [BIGINT_TAG]: value.toString() } : value;
}

function cursorReviver(_key: string, value: unknown): unknown {
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>)[BIGINT_TAG] === "string"
  ) {
    return BigInt((value as Record<string, string>)[BIGINT_TAG]);
  }
  return value;
}

/**
 * Encode a cursor value as Base64.
 */
export function encodeCursor(value: unknown): string {
  const payload = JSON.stringify({ v: value }, cursorReplacer);
  return Buffer.from(payload, "utf-8").toString("base64");
}

/**
 * Decode a Base64 cursor into its original value.
 * Returns null on invalid input.
 */
export function decodeCursor(cursor: string): unknown | null {
  try {
    const json = Buffer.from(cursor, "base64").toString("utf-8");
    const parsed = JSON.parse(json, cursorReviver);
    return parsed.v;
  } catch {
    return null;
  }
}

/**
 * Keyset cursor payload for lossless pagination on non-unique order columns.
 *
 * `v` is the order-column value of the page's last row (`null` when that row
 * sorts in the NULL region) and `p` is its primary-key value — the tiebreaker
 * that keeps rows sharing the same order value from being skipped at page
 * boundaries. Reuses the legacy `v` key so pre-keyset cursors (`{v}` only)
 * still decode (`pk` comes back `undefined` and the caller falls back to the
 * strict-compare transition behavior for that one page).
 */
export function encodeCursorKey(
  order: unknown,
  pk: unknown,
  subKey?: unknown,
): string {
  const payload = JSON.stringify(
    subKey === undefined
      ? { v: order ?? null, p: pk }
      : { v: order ?? null, p: pk, d: subKey },
    cursorReplacer,
  );
  return Buffer.from(payload, "utf-8").toString("base64");
}

export type DecodedCursorKey = {
  /** Order-column value of the last row; null inside the NULL region. */
  order: unknown;
  /** PK tiebreaker; undefined for legacy scalar cursors. */
  pk: unknown | undefined;
  /**
   * Second tiebreaker after the PK — the discriminator of a TABLE_PER_CLASS
   * root page, whose concrete tables may share PK values. Undefined for
   * single-table cursors.
   */
  subKey?: unknown;
};

/**
 * Decode a Base64 keyset cursor. Returns null only on genuinely invalid
 * input (bad Base64 / JSON) — a `{v: null, p}` NULL-region cursor is valid.
 */
export function decodeCursorKey(cursor: string): DecodedCursorKey | null {
  try {
    const json = Buffer.from(cursor, "base64").toString("utf-8");
    const parsed = JSON.parse(json, cursorReviver);
    if (parsed === null || typeof parsed !== "object") return null;
    return { order: parsed.v ?? null, pk: parsed.p, subKey: parsed.d };
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
