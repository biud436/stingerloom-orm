import { OrmError } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

/**
 * An error class for transaction failures that the ORM itself never throws.
 *
 * @deprecated Nothing in the ORM throws it, so `instanceof TransactionError`
 * never matches an ORM error. A rollback that fails is an {@link OrmError}
 * with {@link OrmErrorCode.TRANSACTION_ROLLBACK_FAILED}; a COMMIT that fails
 * rejects with its own error (a `UniqueConstraintViolationError` for a
 * deferred unique key, the driver's error otherwise).
 */
export class TransactionError extends OrmError {
  constructor(message: string) {
    super(OrmErrorCode.TRANSACTION_FAILED, message);
    this.name = "TransactionError";
  }
}
