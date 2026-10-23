/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Sql } from "../../utils/sqlTag";
import type { DriverQueryOptions } from "../../types/DriverQueryOptions";
import { planSafeIntegers, normalizeSafeIntegerRows } from "./SqliteSafeIntegers";
import { sanitizeSqliteBindValues } from "./SqliteBindValues";

/**
 * Runs `query` on the better-sqlite3 database `db` with the result format
 * `options` asks for, binding values the way the connector's own query path
 * does.
 */
export function sqliteQueryWithOptions(
  db: any,
  query: Sql,
  options: DriverQueryOptions,
): any[] {
  const sanitized = sanitizeSqliteBindValues(query.values);
  const stmt = db.prepare(query.sql);

  if (options.arrayMode) {
    stmt.raw(true);
  }

  // better-sqlite3 throws if stmt.all() is called on a non-row-returning
  // statement (e.g. CTE-prefixed UPDATE/DELETE without RETURNING). Branch
  // on stmt.reader so writes route to stmt.run() (#287).
  if (!stmt.reader) {
    const result =
      sanitized && sanitized.length > 0
        ? stmt.run(...sanitized)
        : stmt.run();
    return [result] as any;
  }

  const plan = planSafeIntegers(stmt);
  const rows =
    sanitized && sanitized.length > 0
      ? stmt.all(...sanitized)
      : stmt.all();
  return plan ? normalizeSafeIntegerRows(rows, plan) : rows;
}
