import { OrmError } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

/**
 * 조건 없이 삭제/업데이트 작업을 시도할 때 발생하는 에러입니다.
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
