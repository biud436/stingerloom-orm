import { OrmError } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

/**
 * Thrown when a delete/update is attempted without conditions.
 */
export class DeleteWithoutConditionsError extends OrmError {
  constructor(operation: string = "Delete") {
    super(
      OrmErrorCode.DELETE_WITHOUT_CONDITIONS,
      `${operation} without conditions is not allowed. Provide at least one criterion.`,
      `Pass a "where" clause with at least one condition. To affect all rows, use clear() instead.`,
    );
    this.name = "DeleteWithoutConditionsError";
  }
}
