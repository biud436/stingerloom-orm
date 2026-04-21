import { OrmError } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

/**
 * Thrown when query execution exceeds the configured timeout.
 */
export class QueryTimeoutError extends OrmError {
  constructor(timeoutMs: number) {
    super(
      OrmErrorCode.QUERY_TIMEOUT,
      `Query execution exceeded the timeout of ${timeoutMs}ms.`,
    );
    this.name = "QueryTimeoutError";
  }
}
