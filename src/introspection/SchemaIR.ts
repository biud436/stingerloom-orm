import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";
import type { ReferentialAction } from "../types/ReferentialAction";
import type { IntrospectionDialect } from "./TypeMapper";

/**
 * Schema IR — the dialect-neutral description of a database schema that
 * introspection compiles through.
 *
 * ```
 *  catalog ──read──▶ SchemaIR ──lower──▶ EntityModel ──emit──▶ TypeScript
 *                       ▲                    │
 *                       └──────verify────────┘
 *        (the ORM's own DDL for the entity, parsed back by the same dialect)
 * ```
 *
 * Every dialect quirk — how a catalog spells a type, quotes a default or marks
 * an identity column — is resolved while *reading*, by that dialect's catalog
 * module (`catalog/`), and never crosses this boundary. Everything after it —
 * naming, relation inference, ORM type selection and both code emitters — sees
 * only these types, so it cannot misread one database's spelling as another's.
 *
 * The types describe meaning, not spelling: MySQL `TIMESTAMP` and PostgreSQL
 * `timestamptz` are both an instant, MySQL `DATETIME` and PostgreSQL
 * `timestamp` both a wall-clock time. Parsing this ORM's own DDL output into
 * the same types is what lets the lowering check each mapping against what the
 * generated entity would really create (see `lowering/TypeSelection.ts`).
 */
export interface SchemaIR {
  dialect: IntrospectionDialect;
  /** PostgreSQL schema the tables were read from. */
  schema?: string;
  tables: TableIR[];
}

export interface TableIR {
  name: string;
  /** In the table's column order. */
  columns: ColumnIR[];
  /** Primary key column names, in key order (empty when the table has none). */
  primaryKey: string[];
  foreignKeys: ForeignKeyIR[];
  /** Every index except the primary key's. */
  indexes: IndexIR[];
}

export interface ColumnIR {
  name: string;
  type: CanonicalType;
  nullable: boolean;
  /** Absent when the column has no default. */
  default?: DefaultValue;
  /**
   * The database generates the value on insert: an identity column, a
   * `serial`, `AUTO_INCREMENT`, or SQLite's rowid alias.
   */
  identity: boolean;
  /**
   * `GENERATED ALWAYS AS (…)` expression of a computed column, in the source
   * dialect's SQL. `""` when the column is generated but the catalog does not
   * expose the expression (SQLite).
   */
  generatedExpression?: string;
  /** `ON UPDATE` expression (MySQL / MariaDB `ON UPDATE CURRENT_TIMESTAMP`). */
  onUpdate?: string;
  /** The type as the catalog spells it, for messages (`character varying(80)`). */
  nativeType: string;
  /** The default as the catalog printed it, for messages. */
  rawDefault?: string | null;
}

/**
 * A column type by meaning. Parameters that only one dialect has (MySQL
 * `unsigned`, fractional-second precision) are carried so a mapping that drops
 * them is reported rather than passed off as exact.
 */
export type CanonicalType =
  | { kind: "integer"; bytes: 1 | 2 | 3 | 4 | 8; unsigned: boolean }
  | { kind: "boolean" }
  | { kind: "decimal"; precision: number | null; scale: number | null }
  | {
      kind: "float";
      bytes: 4 | 8;
      /** MySQL's deprecated `FLOAT(M,D)` / `DOUBLE(M,D)` rounding. */
      digits?: { precision: number; scale: number };
    }
  | { kind: "string"; fixed: boolean; length: number | null }
  | { kind: "text"; size: TextSize }
  | { kind: "binary"; fixed: boolean; length: number | null }
  | { kind: "blob"; size: TextSize }
  | { kind: "uuid" }
  | { kind: "json"; binary: boolean }
  | { kind: "date" }
  | { kind: "time"; withTimeZone: boolean; precision: number | null }
  | {
      kind: "timestamp";
      /** `local`: a wall-clock date-time. `instant`: a point in time. */
      zone: "local" | "instant";
      /** Fractional-second digits; `null` for the dialect's default. */
      precision: number | null;
    }
  | {
      kind: "enum";
      values: string[];
      /** PostgreSQL enum type name; `null` where enums are inline (MySQL). */
      name: string | null;
    }
  | { kind: "array"; element: CanonicalType }
  /** A type with no ORM counterpart (`inet`, `interval`, `geometry`, …). */
  | { kind: "other"; native: string };

/** MySQL's text/blob capacity classes; `unbounded` elsewhere. */
export type TextSize = "tiny" | "normal" | "medium" | "long" | "unbounded";

/** A column default by meaning. */
export type DefaultValue =
  | { kind: "string"; value: string }
  /** Kept as the literal text so `0.10` stays `0.10`. */
  | { kind: "number"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" }
  /** SQL in the source dialect, outer parentheses removed. */
  | { kind: "expression"; sql: string }
  /** The identity generator's own default (`nextval(…)`). */
  | { kind: "sequence" };

export interface ForeignKeyIR {
  name?: string;
  /** Local columns, pairwise with {@link referencedColumns}. */
  columns: string[];
  referencedTable: string;
  /** Set when the referenced table lives in another schema / database. */
  referencedSchema?: string;
  referencedColumns: string[];
  onDelete: ReferentialAction;
  onUpdate: ReferentialAction;
}

export interface IndexIR {
  name: string;
  unique: boolean;
  /** The plain column parts, in key order. */
  columns: string[];
  /**
   * What the index has beyond an ordered list of plain columns — expression
   * parts, a partial-index predicate, a non-default method, sort order,
   * operator class, prefix length, `INCLUDE`, full-text. Each entry is a
   * readable description. An index with any of these cannot be declared with
   * the ORM's index options, so it is reported instead of being recreated as a
   * different index.
   */
  unsupported: string[];
}

// ─── Type helpers ───────────────────────────────────────────────────────────

/** Structural equality of two canonical types. */
export function sameType(a: CanonicalType, b: CanonicalType): boolean {
  return typeKey(a, true) === typeKey(b, true);
}

/**
 * Equality of the *shape* of two types: the kind plus the parameters that tell
 * ORM column types apart (integer width, float width, fixed vs. varying
 * strings, time zone, array element). Parameters the ORM's column options do
 * not choose between — lengths, precision, text size, enum values, unsigned —
 * are left out; they decide fidelity, not which ORM type to use.
 */
export function sameShape(a: CanonicalType, b: CanonicalType): boolean {
  return typeKey(a, false) === typeKey(b, false);
}

function typeKey(t: CanonicalType, full: boolean): string {
  const opt = (value: unknown) => (full ? `:${String(value)}` : "");
  switch (t.kind) {
    case "integer":
      return `integer:${t.bytes}${opt(t.unsigned)}`;
    case "boolean":
    case "uuid":
    case "date":
      return t.kind;
    case "decimal":
      return `decimal${opt(t.precision)}${opt(t.scale)}`;
    case "float":
      return `float:${t.bytes}${opt(t.digits ? `${t.digits.precision},${t.digits.scale}` : "-")}`;
    case "string":
      return `string:${t.fixed}${opt(t.length)}`;
    case "text":
      return `text${opt(t.size)}`;
    case "binary":
      return `binary:${t.fixed}${opt(t.length)}`;
    case "blob":
      return `blob${opt(t.size)}`;
    case "json":
      return `json:${t.binary}`;
    case "time":
      return `time:${t.withTimeZone}${opt(t.precision)}`;
    case "timestamp":
      return `timestamp:${t.zone}${opt(t.precision)}`;
    case "enum":
      return `enum${opt(t.name)}${opt(JSON.stringify(t.values))}`;
    case "array":
      return `array<${typeKey(t.element, full)}>`;
    case "other":
      return `other:${t.native.toLowerCase()}`;
  }
}

/**
 * Removes parentheses that enclose the whole expression, repeatedly:
 * `((now()))` → `now()`, while `(a) + (b)` is left alone. Catalogs disagree on
 * whether they keep the parentheses a default was declared with, so the IR
 * stores expressions without them.
 */
export function stripOuterParens(sql: string): string {
  let text = sql.trim();
  while (text.startsWith("(") && text.endsWith(")") && enclosesAll(text)) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

/** Whether the opening parenthesis at 0 closes at the last character. */
function enclosesAll(text: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        // A doubled quote is an escaped quote, not the end of the literal.
        if (text[i + 1] === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0 && i < text.length - 1) return false;
    }
  }
  return depth === 0;
}

/**
 * Checks the invariants every reader must uphold — each key, foreign key and
 * index names columns the table has. A violation is a reader bug; failing
 * here keeps it from turning into generated code that looks plausible.
 */
export function validateTableIR(table: TableIR): void {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const col of table.columns) {
    if (names.has(col.name)) problems.push(`column "${col.name}" appears twice`);
    names.add(col.name);
  }
  const missing = (what: string, cols: string[]) => {
    for (const c of cols) {
      if (!names.has(c)) problems.push(`${what} names unknown column "${c}"`);
    }
  };
  missing("the primary key", table.primaryKey);
  for (const fk of table.foreignKeys) {
    const label = `foreign key ${fk.name ?? `(${fk.columns.join(", ")})`}`;
    if (fk.columns.length === 0 || fk.columns.length !== fk.referencedColumns.length) {
      problems.push(`${label} pairs ${fk.columns.length} column(s) with ${fk.referencedColumns.length}`);
    }
    missing(label, fk.columns);
  }
  for (const idx of table.indexes) missing(`index "${idx.name}"`, idx.columns);

  if (problems.length > 0) {
    throw new OrmError(
      OrmErrorCode.SCHEMA_ERROR,
      `Introspected table "${table.name}" is inconsistent: ${problems.join("; ")}.`,
    );
  }
}
