import { OrmError } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

/**
 * Thrown when an invalid query is about to be executed.
 */
export class InvalidQueryError extends OrmError {
  constructor(message: string, suggestion?: string) {
    super(OrmErrorCode.INVALID_QUERY, message, suggestion);
    this.name = "InvalidQueryError";
  }
}
