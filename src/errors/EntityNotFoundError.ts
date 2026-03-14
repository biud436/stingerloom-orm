import { OrmError } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

/**
 * 엔티티를 찾을 수 없을 때 발생하는 에러입니다.
 */
export class EntityNotFoundError extends OrmError {
  constructor(entityName: string) {
    super(
      OrmErrorCode.ENTITY_NOT_FOUND,
      `Entity "${entityName}" not found.`,
      `Check that the entity exists in the database and the query conditions are correct.`,
    );
    this.name = "EntityNotFoundError";
  }
}
