/**
 * Names what an invalid field value actually is, for the `defineEntity` /
 * `defineRow` "not a field builder" errors.
 *
 * @internal Package-internal — not a public API.
 */
export function describeInvalidBuilder(value: unknown): string {
  if (typeof value === "function") {
    return (
      "got an uncalled builder factory (a function). " +
      "Did you forget the parentheses, e.g. t.varchar() instead of t.varchar?"
    );
  }
  if (value === undefined) {
    return (
      "got undefined. Check the referenced variable — an import cycle can " +
      "leave a builder undefined at definition time."
    );
  }
  if (value === null) return "got null.";
  return `got ${typeof value}.`;
}
