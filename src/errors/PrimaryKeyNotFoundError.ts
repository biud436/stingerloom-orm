import { OrmError } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

/**
 * Thrown when an entity has no Primary Key column defined.
 */
export class PrimaryKeyNotFoundError extends OrmError {
  constructor(entityName: string) {
    super(
      OrmErrorCode.PRIMARY_KEY_NOT_FOUND,
      `Primary key column not found for entity "${entityName}".`,
      `Add @PrimaryGeneratedColumn() or @PrimaryColumn() decorator to one of the entity's properties.`,
    );
    this.name = "PrimaryKeyNotFoundError";
  }
}
