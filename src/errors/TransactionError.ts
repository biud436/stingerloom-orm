import { OrmError } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

/**
 * Thrown when an error occurs during transaction handling.
 */
export class TransactionError extends OrmError {
  constructor(message: string) {
    super(OrmErrorCode.TRANSACTION_FAILED, message);
    this.name = "TransactionError";
  }
}
