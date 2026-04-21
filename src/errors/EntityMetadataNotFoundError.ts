import { OrmError } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

/**
 * Thrown when entity metadata cannot be found.
 */
export class EntityMetadataNotFoundError extends OrmError {
  constructor(entityName: string) {
    super(
      OrmErrorCode.ENTITY_METADATA_NOT_FOUND,
      `Entity metadata for "${entityName}" does not exist.`,
      `Ensure the class is decorated with @Entity() and included in the "entities" array of your DatabaseClientOptions.`,
    );
    this.name = "EntityMetadataNotFoundError";
  }
}
