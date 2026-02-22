import { OrmError } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

/**
 * 쿼리 실행 시간이 제한을 초과했을 때 발생하는 에러입니다.
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
