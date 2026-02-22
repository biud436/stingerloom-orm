import { OrmError } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

/**
 * 잘못된 쿼리가 실행되려 할 때 발생하는 에러입니다.
 */
export class InvalidQueryError extends OrmError {
  constructor(message: string) {
    super(OrmErrorCode.INVALID_QUERY, message);
    this.name = "InvalidQueryError";
  }
}
