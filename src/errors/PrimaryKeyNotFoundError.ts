import { OrmError } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

/**
 * 엔티티에 Primary Key 컬럼이 정의되지 않았을 때 발생하는 에러입니다.
 */
export class PrimaryKeyNotFoundError extends OrmError {
  constructor(entityName: string) {
    super(
      OrmErrorCode.PRIMARY_KEY_NOT_FOUND,
      `Primary key column not found for entity "${entityName}".`,
    );
    this.name = "PrimaryKeyNotFoundError";
  }
}
