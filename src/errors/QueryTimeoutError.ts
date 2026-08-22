import { OrmError } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

/**
 * Thrown when query execution exceeds the configured timeout.
 *
 * Raised by the read path when the database cancels a statement that ran past
 * the connection-level `queryTimeout` or a per-query `timeout`. The driver
 * error that reported the cancellation is kept in {@link cause} — Postgres
 * `57014`, MySQL errno `3024`, MariaDB errno `1969`.
 */
export class QueryTimeoutError extends OrmError {
  /** The driver error that reported the cancellation, when available. */
  public readonly cause?: unknown;

  constructor(timeoutMs: number, cause?: unknown) {
    super(
      OrmErrorCode.QUERY_TIMEOUT,
      `Query execution exceeded the timeout of ${timeoutMs}ms.`,
      "Raise the per-query `timeout` (or the connection-level `queryTimeout`), or make the query cheaper — an index, a narrower filter, or a smaller lock scope.",
    );
    this.name = "QueryTimeoutError";
    this.cause = cause;
  }
}
