import { OrmError } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

/**
 * Thrown when entity metadata cannot be found — or, when `connectionName` is
 * given, when the metadata exists globally but the class is not part of that
 * connection's `entities` array (out-of-scope use on a scoped connection).
 */
export class EntityMetadataNotFoundError extends OrmError {
  constructor(entityName: string, detail?: { connectionName?: string }) {
    if (detail?.connectionName) {
      super(
        OrmErrorCode.ENTITY_METADATA_NOT_FOUND,
        `Entity "${entityName}" is not registered on connection "${detail.connectionName}": ` +
          `its metadata exists, but the class is missing from that connection's "entities" array.`,
        `Add ${entityName} to the "entities" array of the DatabaseClientOptions registered under ` +
          `"${detail.connectionName}", or query it through the EntityManager that registered it.`,
      );
    } else {
      super(
        OrmErrorCode.ENTITY_METADATA_NOT_FOUND,
        `Entity metadata for "${entityName}" does not exist.`,
        `Ensure the class is decorated with @Entity() and included in the "entities" array of your DatabaseClientOptions.`,
      );
    }
    this.name = "EntityMetadataNotFoundError";
  }
}
