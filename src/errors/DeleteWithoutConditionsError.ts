import { OrmError } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

/**
 * 조건 없이 삭제 작업을 시도할 때 발생하는 에러입니다.
 */
export class DeleteWithoutConditionsError extends OrmError {
  constructor(operation: string = "Delete") {
    super(
      OrmErrorCode.DELETE_WITHOUT_CONDITIONS,
      `${operation} without conditions is not allowed. Provide at least one criterion.`,
    );
    this.name = "DeleteWithoutConditionsError";
  }
}
