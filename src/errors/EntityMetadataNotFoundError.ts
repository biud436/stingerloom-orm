import { OrmError } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

/**
 * 엔티티 메타데이터를 찾을 수 없을 때 발생하는 에러입니다.
 */
export class EntityMetadataNotFoundError extends OrmError {
  constructor(entityName: string) {
    super(
      OrmErrorCode.ENTITY_METADATA_NOT_FOUND,
      `Entity metadata for "${entityName}" does not exist.`,
    );
    this.name = "EntityMetadataNotFoundError";
  }
}
