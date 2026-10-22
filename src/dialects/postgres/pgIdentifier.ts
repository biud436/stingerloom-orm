/**
 * The identifiers the PostgreSQL connector accepts — among them the tenant
 * schema it switches to with `SET LOCAL search_path`, which it skips (with a
 * warning) for any other tenant id.
 */
const PG_IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_$-]*$/;

export function isValidPgIdentifier(name: string): boolean {
  return PG_IDENTIFIER_PATTERN.test(name);
}
