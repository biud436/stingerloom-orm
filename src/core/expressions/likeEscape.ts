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
