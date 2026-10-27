/**
 * How an upsert on MySQL 8.0.19+ reads the row it proposed: through a row
 * alias the statement declares, instead of the `VALUES(col)` function that
 * 8.0.20 deprecated.
 *
 * ```sql
 * INSERT INTO `t` (`a`, `b`) VALUES (?, ?) AS `new` (`__a`, `__b`)
 *   ON DUPLICATE KEY UPDATE `b` = `new`.`__b`
 * ```
 *
 * The alias renames its columns rather than reusing the table's names. A
 * row alias whose columns share the table's names makes every bare column
 * reference in the update clause ambiguous (ER 1052), and a bare name there
 * has always meant the stored row, raw `sql` fragments included. Renamed,
 * a bare name keeps that meaning.
 *
 * The alias exposes only the columns the INSERT lists — unlike `VALUES(col)`,
 * which reads a column the INSERT left out as its default — so a statement
 * that reads such a column lists it with `DEFAULT`.
 */

/**
 * The row alias: `new`, unless the target table is itself named `new`
 * (it stays in scope for the stored row, so the two must differ) — then
 * `new_row`. The comparison ignores case because table aliases do on some
 * platforms.
 *
 * @param targetTable - The INSERT's target as the statement writes it,
 *   already wrapped (and possibly qualified).
 * @param wrap - The driver's identifier quoting.
 */
export function mySqlRowAlias(
  targetTable: string,
  wrap: (identifier: string) => string,
): string {
  const alias = wrap("new");
  return targetTable.toLowerCase().endsWith(alias.toLowerCase())
    ? wrap("new_row")
    : alias;
}

/**
 * The alias's name for one column: the column's own name behind `__`,
 * spliced inside the quotes so any escaping in it is kept.
 *
 * @param wrappedColumn - The column identifier, already wrapped.
 */
export function mySqlRowAliasColumn(wrappedColumn: string): string {
  return `${wrappedColumn[0]}__${wrappedColumn.slice(1)}`;
}

/** `new`.`__col` — one column of the proposed row. */
export function mySqlProposedColumn(
  alias: string,
  wrappedColumn: string,
): string {
  return `${alias}.${mySqlRowAliasColumn(wrappedColumn)}`;
}

/**
 * ` AS new (__a, __b)` — the clause that follows the VALUES list.
 *
 * @param wrappedColumns - The INSERT's column list, in order, already wrapped.
 */
export function mySqlRowAliasClause(
  alias: string,
  wrappedColumns: string[],
): string {
  return ` AS ${alias} (${wrappedColumns.map(mySqlRowAliasColumn).join(", ")})`;
}
