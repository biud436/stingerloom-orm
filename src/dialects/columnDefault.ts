/** A `@Column({ default })` value. */
export type ColumnDefaultValue = string | number | boolean | null | undefined;

/**
 * Whether a declared default is a raw SQL expression rather than a literal:
 * a string wrapped in parentheses, e.g. `"(CURRENT_TIMESTAMP)"`.
 */
export function isExpressionDefault(value: ColumnDefaultValue): boolean {
  return typeof value === "string" && value.startsWith("(") && value.endsWith(")");
}

/**
 * The ` DEFAULT …` clause of a column definition, or `""` when no default is
 * declared. A parenthesized string is emitted as a raw SQL expression; any
 * other string is a quoted literal. `renderBoolean` spells a boolean default
 * the dialect's way (TRUE/FALSE, or 1/0 on MySQL).
 *
 * The one rendering CREATE TABLE and ADD COLUMN share, so a column added to an
 * existing table gets the default the same declaration gives a new table.
 */
export function renderDefaultClause(
  value: ColumnDefaultValue,
  renderBoolean: (value: boolean) => string = (v) => ` DEFAULT ${v ? "TRUE" : "FALSE"}`,
): string {
  if (value === undefined) return "";
  if (typeof value === "boolean") return renderBoolean(value);
  return ` DEFAULT ${renderDefaultValue(value)}`;
}

/**
 * A declared default as a SQL value: the expression of a parenthesized
 * string, a quoted literal for any other string, `TRUE` / `FALSE` for a
 * boolean. Used where the value itself is written, such as a VALUES row on
 * SQLite, which has no DEFAULT keyword there.
 */
export function renderDefaultValue(value: Exclude<ColumnDefaultValue, undefined>): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (isExpressionDefault(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The DEFAULT clause an `ALTER TABLE … ADD COLUMN` carries for a declared
 * default, or `""` when there is none to add. A `null` default adds nothing
 * (it is the column's default anyway). SQLite rejects an expression default
 * on ADD COLUMN ("Cannot add a column with non-constant default"), so there
 * it adds nothing either — check {@link isExpressionDefault} to report that.
 */
export function addColumnDefaultClause(
  value: ColumnDefaultValue,
  dialect: "mysql" | "postgres" | "sqlite",
): string {
  if (value === undefined || value === null) return "";
  if (dialect === "sqlite" && isExpressionDefault(value)) return "";
  return renderDefaultClause(
    value,
    dialect === "mysql" ? (v) => ` DEFAULT ${v ? "1" : "0"}` : undefined,
  );
}
