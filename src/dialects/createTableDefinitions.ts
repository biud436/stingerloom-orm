import type { ColumnOption } from "../decorators/Column";
import type { ComputedColumnMetadata } from "../decorators/ComputedColumn";
import type { ColumnDefinitionBuilder } from "./ColumnDefinitionBuilder";

/**
 * The definitions inside a `CREATE TABLE ... (...)`: each column, each
 * computed column, then a table-level `PRIMARY KEY (...)` when the key spans
 * several columns — a single-column key is declared on the column itself.
 *
 * The drivers' `createTable()` (runtime synchronize) and SchemaGenerator
 * (migrate:generate) both build their column list here, so the two cannot
 * drift. Each wraps the list in its own CREATE TABLE and adds what only it
 * emits, such as SQLite's inline FOREIGN KEY clauses.
 */
export function buildCreateTableDefinitions(
  builder: ColumnDefinitionBuilder,
  tableName: string,
  columns: ReadonlyArray<{ name: string; options?: ColumnOption }>,
  computedColumns: readonly ComputedColumnMetadata[] = [],
): string[] {
  const pkColumns = columns.filter((column) => column.options?.primary);
  const isCompositePk = pkColumns.length > 1;

  const definitions = columns.map((column) =>
    builder.buildColumnDef(column.options ?? builder.defaultColumnOption, {
      columnName: column.name,
      tableName,
      isCompositePk,
    }),
  );

  for (const cc of computedColumns) {
    definitions.push(
      builder.buildComputedColumnDef(cc, {
        columnName: cc.name,
        tableName,
      }),
    );
  }

  if (isCompositePk) {
    const pkList = pkColumns.map((column) => builder.wrapIdentifier(column.name)).join(", ");
    definitions.push(`PRIMARY KEY (${pkList})`);
  }

  return definitions;
}
