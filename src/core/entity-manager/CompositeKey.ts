import { ColumnMetadata } from "../../scanner";
import { InvalidQueryError } from "../../errors/InvalidQueryError";

/** How a key column reads in a message: its property name. */
type PropKey = (col: ColumnMetadata) => string;

/**
 * A composite-key argument needs an object that gives every key column a
 * value. The object is used as a where clause, so the resolver skips a
 * column set to `undefined`. The call then matches rows with any value in
 * that column, or any row at all when the whole key is missing. `null` stays
 * legal and matches IS NULL.
 *
 * A key column counts as given under either spelling, because the where
 * resolver falls back to the raw key: an entity whose `tenantKey` property
 * maps to a `tenant_key` column accepts `{ tenant_key: "t1", user_id: 1 }`
 * the same way `where` does.
 *
 * @param effect What a missing column would do, for the message
 *   ("the lookup would match rows", "the delete would remove rows").
 */
export function assertCompositeKey(
  method: string,
  entityName: string,
  pkColumns: ColumnMetadata[],
  propKey: PropKey,
  id: unknown,
  effect: string,
  index?: number,
): void {
  const props = pkColumns.map(propKey);
  const at = index === undefined ? "" : ` at index ${index}`;

  if (id === null || typeof id !== "object") {
    throw new InvalidQueryError(
      `${method}() received ${id === null ? "null" : typeof id}${at} as the primary key of "${entityName}", which has a composite key (${props.join(", ")}).`,
      `Pass an object with every key column, e.g. { ${props.map((p) => `${p}: ...`).join(", ")} }.`,
    );
  }

  const key = id as Record<string, unknown>;
  const missing = props.filter(
    (prop, i) => key[prop] === undefined && key[pkColumns[i].name] === undefined,
  );
  if (missing.length > 0) {
    throw new InvalidQueryError(
      `${method}() received no value for primary key column${missing.length > 1 ? "s" : ""} ${missing.map((p) => `"${p}"`).join(", ")}${at} of "${entityName}".`,
      `An undefined key column drops its condition, so ${effect} with any value there. Pass every key column (null matches IS NULL).`,
    );
  }
}

/**
 * The key columns of a composite-key object, by property name — read under
 * either spelling, as {@link assertCompositeKey} accepts them. Every other
 * property is left out, so a loaded entity passes as its own key.
 */
export function pickCompositeKey(
  pkColumns: ColumnMetadata[],
  propKey: PropKey,
  id: Record<string, unknown>,
): Record<string, unknown> {
  const key: Record<string, unknown> = {};
  for (const col of pkColumns) {
    const prop = propKey(col);
    key[prop] = id[prop] !== undefined ? id[prop] : id[col.name];
  }
  return key;
}
