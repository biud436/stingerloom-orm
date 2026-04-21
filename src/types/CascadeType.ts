/**
 * Cascade operation types.
 *
 * - "insert": persist child entities when the parent is saved
 * - "update": update child entities when the parent is updated
 * - "delete": delete child entities when the parent is deleted
 * - "remove": alias for "delete" (backward compatibility)
 */
export type CascadeType = "insert" | "update" | "delete" | "remove";

/**
 * Cascade option: true applies all cascade types, an array applies selected types.
 */
export type CascadeOption = boolean | CascadeType[];

/**
 * Normalizes a CascadeOption into a CascadeType array.
 * - true → ["insert", "update", "delete"]
 * - false / undefined → []
 * - array → returned as-is ("remove" is normalized to "delete")
 */
export function normalizeCascade(
  cascade: CascadeOption | undefined,
): CascadeType[] {
  if (cascade === undefined || cascade === false) return [];
  if (cascade === true) return ["insert", "update", "delete"];
  return cascade.map((c) => (c === "remove" ? "delete" : c));
}

/**
 * Checks whether the given cascade option includes a specific operation.
 * Treats "remove" and "delete" as equivalent.
 */
export function hasCascade(
  cascade: CascadeOption | undefined,
  type: CascadeType,
): boolean {
  const normalized = normalizeCascade(cascade);
  if (type === "delete" || type === "remove") {
    return normalized.includes("delete") || normalized.includes("remove");
  }
  return normalized.includes(type);
}
