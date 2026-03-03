import { OrmError } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

/**
 * Advisory lock 획득 실패 시 발생하는 에러입니다.
 */
export class AdvisoryLockError extends OrmError {
  constructor(message: string) {
    super(OrmErrorCode.ADVISORY_LOCK_FAILED, message);
    this.name = "AdvisoryLockError";
  }
}
