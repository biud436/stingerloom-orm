import { OrmError } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

/**
 * 트랜잭션 처리 중 발생하는 에러입니다.
 */
export class TransactionError extends OrmError {
  constructor(message: string) {
    super(OrmErrorCode.TRANSACTION_FAILED, message);
    this.name = "TransactionError";
  }
}
