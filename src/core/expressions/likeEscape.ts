import sql, { Sql, raw } from "../../utils/sqlTag";

/**
 * Escape character prepended to LIKE metacharacters. Backslash matches the
 * default SQL `ESCAPE '\'` clause and works identically across PostgreSQL,
 * MySQL (with `NO_BACKSLASH_ESCAPES` disabled, which is the default), and
 * SQLite.
 */
export const LIKE_ESCAPE_CHAR = "\\";

/**
 * Escape `%`, `_`, and `\` inside a user-supplied string so it can be
 * embedded literally inside a LIKE pattern without being interpreted as
 * a wildcard.
 *
 * Callers still need to emit `ESCAPE '\'` in the SQL clause itself —
 * this helper only mangles the value.
 *
 * Example:
 * ```
 * escapeLikeValue("50% off_today") // => "50\\% off\\_today"
 * ```
 */
export function escapeLikeValue(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `${LIKE_ESCAPE_CHAR}${m}`);
}

/**
 * `column LIKE pattern ESCAPE '\'` — the LIKE for a pattern built with
 * {@link escapeLikeValue}. The clause is required, not decorative: SQLite's
 * LIKE has no escape character unless one is named, so without it `\_`
 * matches a literal backslash and an escaped term finds nothing there, while
 * PostgreSQL and MySQL default to backslash and match.
 *
 * @param column Already-escaped column identifier (e.g. `"u"."name"`).
 */
export function likeEscaped(column: string, pattern: string): Sql {
  return sql`${raw(column)} LIKE ${pattern} ESCAPE ${LIKE_ESCAPE_CHAR}`;
}
