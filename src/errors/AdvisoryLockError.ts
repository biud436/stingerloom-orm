import { OrmError } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

/**
 * Thrown when acquiring an advisory lock fails.
 */
export class AdvisoryLockError extends OrmError {
  constructor(message: string) {
    super(OrmErrorCode.ADVISORY_LOCK_FAILED, message);
    this.name = "AdvisoryLockError";
  }
}
