import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";

/**
 * Escape a string value for safe interpolation into a SQL literal in DDL.
 *
 * Two characters need to be escaped to keep the literal closed:
 *   - `'` (SQL single-quote) → `''`
 *   - `\` (backslash) → `\\`  — required because MySQL's default
 *     `NO_BACKSLASH_ESCAPES = OFF` mode treats backslashes as escape characters,
 *     so a trailing `\` will swallow the closing quote and let the next value
 *     continue as raw DDL.
 *
 * Null bytes are rejected outright — they break parsers and have no legitimate
 * place in identifiers, ENUM values, or text-search configuration names.
 *
 * Used by:
 *   - `PostgresDriver` (ENUM creation / alteration)
 *   - `SchemaRegistrar.buildColumnTypeExpr` (MySQL `ENUM(...)` literal list, #286)
 *   - `SchemaGenerator.generateFullTextIndexDDL` (PostgreSQL `to_tsvector('lang', ...)`, #285)
 */
export function escapeSqlLiteral(value: string): string {
  if (value.includes("\0")) {
    throw new OrmError(
      OrmErrorCode.VALIDATION_ERROR,
      `Value contains a null byte and cannot be safely interpolated into SQL`,
    );
  }
  return value.replace(/\\/g, "\\\\").replace(/'/g, "''");
}
