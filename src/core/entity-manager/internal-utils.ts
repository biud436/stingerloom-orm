/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Checks if an error is a deadlock error based on dialect-specific error codes.
 * - MySQL: errno 1213 (ER_LOCK_DEADLOCK)
 * - PostgreSQL: code 40P01 (deadlock_detected)
 * - SQLite: code SQLITE_BUSY / "database is locked"
 */
export function isDeadlockError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const err = e as any;
  // MySQL: errno 1213
  if (err.errno === 1213 || err.code === "ER_LOCK_DEADLOCK") return true;
  // PostgreSQL: code 40P01
  if (err.code === "40P01") return true;
  // SQLite: SQLITE_BUSY
  if (err.code === "SQLITE_BUSY" || err.message?.includes("database is locked")) return true;
  return false;
}

/**
 * Checks whether an error is the database reporting that it cancelled a
 * statement because a timeout elapsed.
 *
 * - PostgreSQL: SQLSTATE `57014` (query_canceled) — the code `statement_timeout`
 *   cancellations arrive with.
 * - MySQL 5.7+: errno `3024` (ER_QUERY_TIMEOUT), from `max_execution_time`.
 * - MariaDB: errno `1969` (ER_STATEMENT_TIMEOUT), from `max_statement_time`.
 *
 * SQLite has no statement timeout — `PRAGMA busy_timeout` only bounds lock
 * waits, and those surface as SQLITE_BUSY — so nothing is matched for it.
 */
export function isStatementTimeoutError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const err = e as any;
  if (err.code === "57014") return true;
  if (err.errno === 3024 || err.code === "ER_QUERY_TIMEOUT") return true;
  if (err.errno === 1969 || err.code === "ER_STATEMENT_TIMEOUT") return true;
  return false;
}

/**
 * Distinguishes a tagged-template invocation from a plain string / array
 * argument. The runtime hands tag functions a frozen array with a `raw`
 * sibling array — that's the contract we test for.
 */
export function isTemplateStringsArray(v: unknown): v is TemplateStringsArray {
  if (!Array.isArray(v)) return false;
  const raw = (v as unknown as { raw?: unknown }).raw;
  return Array.isArray(raw);
}

/**
 * Converts a Date to the MySQL/MariaDB-compatible 'YYYY-MM-DD HH:MM:SS' format.
 * ISO 8601 formatting can be rejected by MariaDB strict mode.
 */
export function formatDateTimeForSQL(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
