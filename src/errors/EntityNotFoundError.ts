import { OrmError } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

/**
 * Thrown when an entity cannot be found.
 */
export class EntityNotFoundError extends OrmError {
  constructor(entityName: string, detail?: string) {
    super(
      OrmErrorCode.ENTITY_NOT_FOUND,
      detail
        ? `Entity "${entityName}" not found. ${detail}`
        : `Entity "${entityName}" not found.`,
      `Check that the entity exists in the database and the query conditions are correct.`,
    );
    this.name = "EntityNotFoundError";
  }
}
