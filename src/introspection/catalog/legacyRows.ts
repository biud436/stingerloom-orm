import type { IntrospectionDialect } from "../TypeMapper";
import {
  CanonicalType,
  ColumnIR,
  DefaultValue,
  ForeignKeyIR,
  IndexIR,
  TableIR,
} from "../SchemaIR";
import { dialectTypes } from "./index";
import { parseMySqlDefault } from "./mysql";
import { parsePostgresDefault } from "./postgres";
import { parseSqliteDefault } from "./sqlite";

/**
 * A column in the INFORMATION_SCHEMA-like row shape of the original
 * introspection API. Kept for {@link EntityCodeBuilder.build} and the
 * deprecated `IntrospectionGenerator.getColumns()`; the generator itself reads
 * catalogs into {@link ColumnIR}.
 */
export interface DbColumn {
  column_name: string;
  data_type: string;
  is_nullable: string;
  character_maximum_length?: number | null;
  numeric_precision?: number | null;
  numeric_scale?: number | null;
  column_default?: string | null;
  extra?: string | null;
  /**
   * Full column type with width/length (MySQL `COLUMN_TYPE`), e.g.
   * `tinyint(1)`, `varchar(255)`, `decimal(10,2)`. Used to refine TINYINT(1)
   * → boolean detection on MySQL.
   */
  column_type?: string | null;
  /**
   * PostgreSQL `information_schema.columns.is_identity` ("YES"/"NO"). Set
   * for `GENERATED { ALWAYS | BY DEFAULT } AS IDENTITY` columns (PG 10+).
   */
  is_identity?: string | null;
  /**
   * Enum labels: PostgreSQL `pg_enum` labels for a `USER-DEFINED` column, or
   * the MySQL `ENUM(...)` values.
   */
  enum_values?: string[] | null;
  /** PostgreSQL `udt_name` — the enum type name, or `_int4` for `integer[]`. */
  udt_name?: string | null;
}

/** A foreign key column in the original introspection API's row shape. */
export interface DbForeignKey {
  column_name: string;
  referenced_table: string;
  referenced_column: string;
  /** Rows sharing a constraint name form one (composite) foreign key. */
  constraint_name?: string;
}

/** An index in the original introspection API's row shape. */
export interface DbIndex {
  name: string;
  column_names: string[];
  is_unique: boolean;
}

/**
 * Reads the original row shapes into a {@link TableIR}, interpreting each
 * field the way the named dialect's catalog means it.
 */
export function tableFromLegacyRows(
  dialect: IntrospectionDialect,
  tableName: string,
  columns: DbColumn[],
  pks: string[],
  fks: DbForeignKey[],
  indexes: DbIndex[] = [],
): TableIR {
  return {
    name: tableName,
    columns: columns.map((col) => legacyColumn(dialect, col, pks)),
    primaryKey: [...pks],
    foreignKeys: legacyForeignKeys(fks),
    indexes: indexes.map(
      (idx): IndexIR => ({
        name: idx.name,
        unique: idx.is_unique,
        columns: [...idx.column_names],
        unsupported: [],
      }),
    ),
  };
}

function legacyColumn(
  dialect: IntrospectionDialect,
  col: DbColumn,
  pks: string[],
): ColumnIR {
  const dataType = (col.data_type ?? "").trim();
  const lower = dataType.toLowerCase();
  const type = legacyType(dialect, col);
  const nullable = col.is_nullable === "YES";

  let defaultValue: DefaultValue | undefined;
  switch (dialect) {
    case "postgres":
      defaultValue = parsePostgresDefault(col.column_default);
      break;
    case "mysql":
      defaultValue = parseMySqlDefault(col.column_default, type, col.extra ?? "", "unknown");
      break;
    case "sqlite":
      defaultValue = parseSqliteDefault(col.column_default);
      break;
  }
  if (defaultValue?.kind === "null" && nullable) defaultValue = undefined;
  if (
    defaultValue?.kind === "expression" &&
    /auto_increment/i.test(defaultValue.sql)
  ) {
    defaultValue = { kind: "sequence" };
  }

  const identity =
    (col.is_identity ?? "").toUpperCase() === "YES" ||
    lower === "serial" ||
    lower === "bigserial" ||
    defaultValue?.kind === "sequence" ||
    /auto_increment/i.test(col.extra ?? "") ||
    (dialect === "sqlite" &&
      pks.length === 1 &&
      pks[0] === col.column_name &&
      lower === "integer");

  const column: ColumnIR = {
    name: col.column_name,
    type,
    nullable,
    identity,
    nativeType: col.column_type ?? dataType,
    rawDefault: col.column_default ?? null,
  };
  if (defaultValue) column.default = defaultValue;
  return column;
}

function legacyType(dialect: IntrospectionDialect, col: DbColumn): CanonicalType {
  const dataType = (col.data_type ?? "").trim();
  const lower = dataType.toLowerCase();
  const enumValues = Array.isArray(col.enum_values) ? col.enum_values : null;
  const types = dialectTypes(dialect);

  if (dialect === "postgres") {
    if (lower === "user-defined") {
      return { kind: "enum", values: enumValues ?? [], name: col.udt_name ?? null };
    }
    if (lower === "array") {
      const element = col.udt_name?.startsWith("_") ? col.udt_name.slice(1) : null;
      return {
        kind: "array",
        element: element
          ? types.parseType(element)
          : { kind: "other", native: "(unknown element type)" },
      };
    }
    return types.parseType(withModifiers(dataType, col));
  }

  if (dialect === "mysql") {
    // Without COLUMN_TYPE a bare TINYINT has always been read as TINYINT(1).
    const native =
      col.column_type ?? (lower === "tinyint" ? "tinyint(1)" : withModifiers(dataType, col));
    const parsed = types.parseType(native);
    if (parsed.kind === "enum" && parsed.values.length === 0 && enumValues) {
      return { ...parsed, values: enumValues };
    }
    if (lower === "enum" && parsed.kind !== "enum") {
      return { kind: "enum", values: enumValues ?? [], name: null };
    }
    return parsed;
  }

  return types.parseType(col.column_type ?? dataType);
}

/** `character varying` + length 80 → `character varying(80)`. */
function withModifiers(dataType: string, col: DbColumn): string {
  if (dataType.includes("(")) return dataType;
  const lower = dataType.toLowerCase();
  if (
    col.character_maximum_length !== undefined &&
    col.character_maximum_length !== null &&
    /char|binary/.test(lower)
  ) {
    return `${dataType}(${col.character_maximum_length})`;
  }
  if (
    /^(numeric|decimal)$/.test(lower) &&
    col.numeric_precision !== undefined &&
    col.numeric_precision !== null
  ) {
    return `${dataType}(${col.numeric_precision},${col.numeric_scale ?? 0})`;
  }
  return dataType;
}

function legacyForeignKeys(fks: DbForeignKey[]): ForeignKeyIR[] {
  const result: ForeignKeyIR[] = [];
  const byConstraint = new Map<string, ForeignKeyIR>();
  for (const row of fks) {
    const existing =
      row.constraint_name !== undefined ? byConstraint.get(row.constraint_name) : undefined;
    if (existing) {
      existing.columns.push(row.column_name);
      existing.referencedColumns.push(row.referenced_column);
      continue;
    }
    const fk: ForeignKeyIR = {
      columns: [row.column_name],
      referencedTable: row.referenced_table,
      referencedColumns: [row.referenced_column],
      onDelete: "NO ACTION",
      onUpdate: "NO ACTION",
    };
    if (row.constraint_name !== undefined) {
      fk.name = row.constraint_name;
      byConstraint.set(row.constraint_name, fk);
    }
    result.push(fk);
  }
  return result;
}

// ─── IR → legacy rows (deprecated IntrospectionGenerator accessors) ────────

export function legacyColumnRow(
  dialect: IntrospectionDialect,
  column: ColumnIR,
): DbColumn {
  const t = column.type;
  const row: DbColumn = {
    column_name: column.name,
    data_type: legacyDataType(dialect, column),
    is_nullable: column.nullable ? "YES" : "NO",
    character_maximum_length:
      t.kind === "string" || t.kind === "binary" ? t.length : null,
    numeric_precision: t.kind === "decimal" ? t.precision : null,
    numeric_scale: t.kind === "decimal" ? t.scale : null,
    column_default: column.rawDefault ?? null,
    column_type: column.nativeType,
    extra: dialect === "mysql" && column.identity ? "auto_increment" : null,
    is_identity: dialect === "postgres" ? (column.identity ? "YES" : "NO") : null,
  };
  const enumType = t.kind === "enum" ? t : t.kind === "array" && t.element.kind === "enum" ? t.element : null;
  if (enumType) {
    row.enum_values = enumType.values;
    if (enumType.name) row.udt_name = enumType.name;
  }
  return row;
}

function legacyDataType(dialect: IntrospectionDialect, column: ColumnIR): string {
  if (dialect === "postgres") {
    if (column.type.kind === "enum") return "USER-DEFINED";
    if (column.type.kind === "array") return "ARRAY";
  }
  // The native spelling without its modifiers: `character varying(80)` →
  // `character varying`, `int(10) unsigned` → `int`.
  return column.nativeType
    .replace(/\(.*\)/s, "")
    .replace(/\b(unsigned|signed|zerofill)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function legacyForeignKeyRows(table: TableIR): DbForeignKey[] {
  return table.foreignKeys.flatMap((fk) =>
    fk.columns.map((column, i) => ({
      column_name: column,
      referenced_table: fk.referencedTable,
      referenced_column: fk.referencedColumns[i],
      constraint_name: fk.name,
    })),
  );
}
