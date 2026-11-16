import { OrmError } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

/**
 * Thrown when a query or transaction cannot get a database connection: the
 * server went away, refused the connection, or the pool had no connection
 * to hand out in time. Code
 * {@link OrmErrorCode.CONNECTION_FAILED}; the driver's error is kept as
 * {@link cause}.
 */
export class DatabaseConnectionFailedError extends OrmError {
  /** HTTP-style status, kept from the time this class extended `Exception`. */
  public readonly status = 500;

  constructor(originalError?: unknown) {
    const detail =
      originalError instanceof Error
        ? originalError.message
        : originalError != null
          ? String(originalError)
          : undefined;
    super(
      OrmErrorCode.CONNECTION_FAILED,
      detail
        ? `Failed to connect to the database: ${detail}`
        : "Failed to connect to the database.",
      "Check that the database server is running and reachable. A pool that ran out of connections fails the same way: raise pool.max, or hold connections for less time.",
      originalError === undefined ? undefined : { cause: originalError },
    );
    this.name = "DatabaseConnectionFailedError";
  }
}
