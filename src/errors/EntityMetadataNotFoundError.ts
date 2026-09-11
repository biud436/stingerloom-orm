import { OrmError } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

/** Names listed in the suggestion before the list is cut with a count. */
const MAX_LISTED_ENTITIES = 12;

/** Optional context that sharpens the message and the suggestion. */
export interface EntityMetadataNotFoundDetail {
  /**
   * Set when a scoped EntityManager (non-empty `entities` array) rejects an
   * entity that carries metadata but is missing from that connection's scope.
   */
  connectionName?: string;
  /**
   * Entity classes the connection serves (scoped) or knows (unscoped).
   * Appended to the suggestion when non-empty so the caller sees what would
   * have been accepted.
   */
  registeredEntities?: readonly string[];
  /**
   * Diagnosis of a misused first argument (an instance, `undefined`, a
   * thunk, a table-name string, an undecorated class). Its text replaces
   * the generated message and suggestion.
   */
  argument?: { message: string; suggestion: string };
}

function formatRegistered(detail?: EntityMetadataNotFoundDetail): string {
  const names = detail?.registeredEntities ?? [];
  if (names.length === 0) return "";
  const shown = names.slice(0, MAX_LISTED_ENTITIES).join(", ");
  const rest = names.length - MAX_LISTED_ENTITIES;
  const list = rest > 0 ? `${shown} … (+${rest} more)` : shown;
  return detail?.connectionName
    ? ` Registered on connection "${detail.connectionName}": ${list}.`
    : ` Registered entities: ${list}.`;
}

/**
 * Thrown when the class passed to an EntityManager / repository entry point
 * resolves to no entity metadata.
 *
 * The message names the actual mistake: an instance passed instead of its
 * class, a class that was never decorated (or whose module was not imported),
 * `undefined` from a circular import, a thunk or an uncalled factory, a
 * table name string, or — on a scoped EntityManager — a decorated class that
 * is missing from the connection's `entities` array.
 */
export class EntityMetadataNotFoundError extends OrmError {
  constructor(entityName: string, detail?: EntityMetadataNotFoundDetail) {
    const registered = formatRegistered(detail);
    let message: string;
    let suggestion: string;

    if (detail?.argument) {
      message = detail.argument.message;
      suggestion = detail.argument.suggestion + registered;
    } else if (detail?.connectionName) {
      message =
        `Entity "${entityName}" is not registered on connection "${detail.connectionName}": ` +
        `its metadata exists, but the class is missing from that connection's "entities" array.`;
      suggestion =
        `Add ${entityName} to the "entities" array of the DatabaseClientOptions registered under ` +
        `"${detail.connectionName}", or query it through the EntityManager that registered it.` +
        registered;
    } else {
      message = `Entity metadata for "${entityName}" does not exist.`;
      suggestion =
        `Ensure the class is decorated with @Entity() and included in the "entities" array of your DatabaseClientOptions.` +
        registered;
    }

    super(OrmErrorCode.ENTITY_METADATA_NOT_FOUND, message, suggestion);
    this.name = "EntityMetadataNotFoundError";
  }
}
