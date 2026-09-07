/* eslint-disable @typescript-eslint/no-explicit-any */
import type Database from "better-sqlite3";

/**
 * Lossless 64-bit integer reads for better-sqlite3.
 *
 * better-sqlite3 converts every INTEGER to a JS number unless a statement
 * opts into `safeIntegers()`, which then returns *all* integers as BigInt —
 * ids and counters alike. Enabling it globally would push a BigInt→number
 * pass onto every row of every query, so it is scoped per statement:
 *
 * - `stmt.columns()` exposes each result column's declared type. Columns the
 *   ORM created for `type: "bigint"` are declared `BIGINT`; expression
 *   columns (`MAX(x)`, `SUM(x)`, `x + 1`) have no declared type (`null`).
 * - A statement projecting at least one such column runs with safeIntegers
 *   and its rows are normalized: BigInts within ±2^53 become numbers, the
 *   rest become decimal strings — the same shape mysql2 (`supportBigNumbers`)
 *   and pg deliver for out-of-range integers.
 * - Statements whose columns all carry a non-BIGINT declared type keep the
 *   default number path and pay nothing.
 */
export interface SafeIntegerPlan {
  /** Result column names in projection order. */
  keys: string[];
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = -MAX_SAFE;

const plans = new WeakMap<Database.Statement, SafeIntegerPlan | null>();

function needsSafeIntegers(declaredType: string | null): boolean {
  if (declaredType === null) return true;
  const upper = declaredType.toUpperCase();
  return upper.includes("BIGINT") || upper === "INT8";
}

/**
 * Decides once per prepared statement whether it must read integers
 * losslessly, enables `safeIntegers` on it when so, and returns the
 * normalization plan (or `null` when the statement can stay on the fast
 * number path). Non-reader statements never get a plan.
 */
export function planSafeIntegers(
  stmt: Database.Statement,
): SafeIntegerPlan | null {
  const cached = plans.get(stmt);
  if (cached !== undefined) return cached;

  let plan: SafeIntegerPlan | null = null;
  if (stmt.reader) {
    const columns = stmt.columns();
    if (columns.some((c) => needsSafeIntegers(c.type))) {
      stmt.safeIntegers(true);
      plan = { keys: columns.map((c) => c.name) };
    }
  }
  plans.set(stmt, plan);
  return plan;
}

function normalizeCell(value: unknown): unknown {
  if (typeof value !== "bigint") return value;
  return value <= MAX_SAFE && value >= MIN_SAFE ? Number(value) : value.toString();
}

/**
 * Rewrites BigInt cells produced by `safeIntegers` in place: numbers inside
 * the safe range, decimal strings outside it. Handles both object rows and
 * `raw(true)` array rows.
 */
export function normalizeSafeIntegerRows<T>(rows: T[], plan: SafeIntegerPlan): T[] {
  const keys = plan.keys;
  const keyCount = keys.length;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as any;
    if (Array.isArray(row)) {
      for (let j = 0; j < row.length; j++) row[j] = normalizeCell(row[j]);
      continue;
    }
    for (let j = 0; j < keyCount; j++) {
      const key = keys[j];
      const value = row[key];
      if (typeof value === "bigint") row[key] = normalizeCell(value);
    }
  }
  return rows;
}
