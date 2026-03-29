/**
 * Options passed through to the underlying database driver for controlling
 * result format at the wire/protocol level.
 *
 * Used by the RawPipeline plugin to bypass ORM entity transformation
 * and access driver-level data formats directly.
 */
export interface DriverQueryOptions {
  /**
   * Request binary-format results from the driver.
   *
   * - **pg**: Sets `binary: true` on the query config — PostgreSQL returns
   *   column values as raw `Buffer` objects instead of parsed strings.
   * - **mysql2**: Sets `typeCast: false` — all columns returned as raw `Buffer`.
   * - **better-sqlite3**: No effect (BLOB columns are already returned as Buffer).
   */
  binary?: boolean;

  /**
   * Return rows as arrays instead of keyed objects.
   *
   * - **pg**: Sets `rowMode: 'array'` — rows are `any[]` in column order.
   * - **mysql2**: Sets `rowsAsArray: true`.
   * - **better-sqlite3**: Uses `stmt.raw().all()`.
   */
  arrayMode?: boolean;
}
