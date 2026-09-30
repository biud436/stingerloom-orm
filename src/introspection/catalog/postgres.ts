/* eslint-disable @typescript-eslint/no-explicit-any */
import sql from "../../utils/sqlTag";
import type { ReferentialAction } from "../../types/ReferentialAction";
import {
  CanonicalType,
  ColumnIR,
  DefaultValue,
  ForeignKeyIR,
  IndexIR,
  sameType,
  TableIR,
} from "../SchemaIR";
import {
  bool,
  CatalogQueryFn,
  CatalogReader,
  CatalogServerInfo,
  DialectTypes,
  field,
  normalizeRows,
  text,
  TypeFidelity,
} from "./DialectCatalog";
import { isNumberLiteral, parseSqlDefault } from "./sqlLiterals";

/** PostgreSQL's default fractional-second precision (`timestamp` = `timestamp(6)`). */
const PG_DEFAULT_TIME_PRECISION = 6;

/**
 * Parses a PostgreSQL type spelling — `format_type()` output
 * (`character varying(80)`, `timestamp(3) with time zone`, `integer[]`) and
 * this ORM's DDL (`VARCHAR(80)`, `TIMESTAMPTZ`, `NUMERIC(10, 2)`, `TEXT[]`,
 * `"public"."post_status_enum"`) alike.
 */
function parsePostgresType(
  nativeType: string,
  resolveNamedType?: (name: string) => CanonicalType | undefined,
): CanonicalType {
  const native = nativeType.trim();

  const array = /^(.*?)((?:\s*\[\s*\d*\s*\])+)$/s.exec(native);
  if (array) {
    return {
      kind: "array",
      element: parsePostgresType(array[1], resolveNamedType),
    };
  }

  const builtin = parseBuiltin(native.replace(/^pg_catalog\./i, ""));
  if (builtin) return builtin;

  const name = unqualifiedName(native);
  return resolveNamedType?.(name) ?? { kind: "other", native };
}

function parseBuiltin(spelling: string): CanonicalType | undefined {
  const match =
    /^([a-z][a-z0-9_]*(?: [a-z][a-z0-9_]*)*?)\s*(?:\(\s*([0-9\s,]*)\))?\s*(with time zone|without time zone)?$/i.exec(
      spelling.replace(/\s+/g, " ").trim(),
    );
  if (!match) return undefined;
  const name = match[1].toLowerCase();
  const args = (match[2] ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a !== "")
    .map(Number);
  const zone = (match[3] ?? "").toLowerCase();

  switch (name) {
    case "smallint":
    case "int2":
    case "smallserial":
    case "serial2":
      return { kind: "integer", bytes: 2, unsigned: false };
    case "integer":
    case "int":
    case "int4":
    case "serial":
    case "serial4":
      return { kind: "integer", bytes: 4, unsigned: false };
    case "bigint":
    case "int8":
    case "bigserial":
    case "serial8":
      return { kind: "integer", bytes: 8, unsigned: false };
    case "real":
    case "float4":
      return { kind: "float", bytes: 4 };
    case "double precision":
    case "float8":
      return { kind: "float", bytes: 8 };
    case "float":
      // float(p): 1–24 is real, 25–53 double precision; bare float is double.
      return { kind: "float", bytes: args.length > 0 && args[0] <= 24 ? 4 : 8 };
    case "numeric":
    case "decimal":
      return {
        kind: "decimal",
        precision: args[0] ?? null,
        // numeric(p) is numeric(p, 0).
        scale: args.length > 0 ? (args[1] ?? 0) : null,
      };
    case "boolean":
    case "bool":
      return { kind: "boolean" };
    case "character varying":
    case "varchar":
      return { kind: "string", fixed: false, length: args[0] ?? null };
    case "character":
    case "char":
      // `character` without a length is character(1).
      return { kind: "string", fixed: true, length: args[0] ?? 1 };
    case "bpchar":
      // Unconstrained bpchar has no length limit.
      return args.length > 0
        ? { kind: "string", fixed: true, length: args[0] }
        : { kind: "text", size: "unbounded" };
    case "text":
      return { kind: "text", size: "unbounded" };
    case "bytea":
      return { kind: "blob", size: "unbounded" };
    case "uuid":
      return { kind: "uuid" };
    case "json":
      return { kind: "json", binary: false };
    case "jsonb":
      return { kind: "json", binary: true };
    case "date":
      return { kind: "date" };
    case "time":
      return {
        kind: "time",
        withTimeZone: zone === "with time zone",
        precision: timePrecision(args[0]),
      };
    case "timetz":
      return { kind: "time", withTimeZone: true, precision: timePrecision(args[0]) };
    case "timestamp":
      return {
        kind: "timestamp",
        zone: zone === "with time zone" ? "instant" : "local",
        precision: timePrecision(args[0]),
      };
    case "timestamptz":
      return { kind: "timestamp", zone: "instant", precision: timePrecision(args[0]) };
    default:
      return undefined;
  }
}

function timePrecision(value: number | undefined): number | null {
  return value === undefined || value === PG_DEFAULT_TIME_PRECISION ? null : value;
}

/** `"public"."Status"` → `Status`, `public.status` → `status`. */
function unqualifiedName(spelling: string): string {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < spelling.length; i++) {
    const ch = spelling[i];
    if (quoted) {
      if (ch === '"') {
        if (spelling[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ".") {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts[parts.length - 1].trim();
}

function comparePostgresTypes(
  declared: CanonicalType,
  created: CanonicalType,
): TypeFidelity {
  if (sameType(declared, created)) return "exact";
  // An unconstrained varchar is text under another name.
  const unboundedVarchar = (t: CanonicalType) =>
    t.kind === "string" && !t.fixed && t.length === null;
  const text = (t: CanonicalType) => t.kind === "text";
  if (
    (unboundedVarchar(declared) && text(created)) ||
    (text(declared) && unboundedVarchar(created))
  ) {
    return "equivalent";
  }
  return "different";
}

export const postgresTypes: DialectTypes = {
  dialect: "postgres",
  parseType: parsePostgresType,
  compareTypes: comparePostgresTypes,
  foreignKeysCreateIndexes: false,
};

/** A trailing chain of PostgreSQL casts: `::character varying`, `::"Status"[]`. */
const PG_CASTS =
  /^(\s*::\s*(?:"(?:[^"]|"")*"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"(?:[^"]|"")*"|[A-Za-z_][\w$]*))*(?:\s+[A-Za-z_][\w$]*)*(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?(?:\s+(?:with|without)\s+time\s+zone)?(?:\s*\[\s*\])*)+$/i;

/**
 * Parses a default as `pg_get_expr()` prints it: literals carry casts
 * (`'active'::character varying`, `'-1'::integer`, `NULL::text`), serial
 * columns read `nextval('…'::regclass)`.
 */
export function parsePostgresDefault(
  raw: string | null | undefined,
): DefaultValue | undefined {
  if (raw === null || raw === undefined || raw.trim() === "") return undefined;
  const trimmed = raw.trim();
  if (/^nextval\s*\(/i.test(trimmed)) return { kind: "sequence" };

  // `NULL::text`, `0::bigint`, `(-1)::integer` — a bare literal with a cast.
  const castAt = trimmed.indexOf("::");
  if (castAt > 0 && !trimmed.startsWith("'")) {
    const head = trimmed.slice(0, castAt).trim();
    const unparenthesized = head.replace(/^\((.*)\)$/s, "$1").trim();
    if (PG_CASTS.test(trimmed.slice(castAt))) {
      if (/^null$/i.test(head)) return { kind: "null" };
      if (isNumberLiteral(unparenthesized)) {
        return { kind: "number", value: unparenthesized };
      }
    }
  }
  return parseSqlDefault(trimmed, { trailing: PG_CASTS });
}

const PG_ACTIONS: Record<string, ReferentialAction> = {
  a: "NO ACTION",
  r: "RESTRICT",
  c: "CASCADE",
  n: "SET NULL",
  d: "SET DEFAULT",
};

/** Reads a PostgreSQL schema through `pg_catalog`. */
export class PostgresCatalogReader implements CatalogReader {
  readonly types = postgresTypes;

  constructor(
    private readonly query: CatalogQueryFn,
    private readonly schema: string = "public",
  ) {}

  async listTables(): Promise<string[]> {
    // relkind r = ordinary table, p = partitioned table (what pg_tables lists).
    const rows = normalizeRows(
      await this.query(
        sql`SELECT c.relname AS table_name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${this.schema} AND c.relkind IN ('r', 'p') ORDER BY c.relname`,
      ),
    );
    return rows.map((row) => String(field(row, "table_name")));
  }

  async readServerInfo(): Promise<CatalogServerInfo> {
    // Column types this ORM declares on PostgreSQL do not vary by version.
    return {};
  }

  async readTable(name: string): Promise<TableIR> {
    const columns = await this.readColumns(name);
    return {
      name,
      columns,
      primaryKey: await this.readPrimaryKey(name),
      foreignKeys: await this.readForeignKeys(name),
      indexes: await this.readIndexes(name),
    };
  }

  private async readColumns(table: string): Promise<ColumnIR[]> {
    // format_type() spells the declared type with its modifiers; the enum
    // labels are collected for the column's type or its array element type.
    // is_identity / is_generated come from information_schema, which has them
    // on every PostgreSQL version (attidentity / attgenerated do not).
    const rows = normalizeRows(
      await this.query(
        sql`SELECT a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS type_text, a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS default_expr, t.typname AS type_name, t.typtype AS type_kind, et.typname AS element_type_name, et.typtype AS element_type_kind, (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = COALESCE(et.oid, t.oid)) AS enum_labels, ic.is_identity AS is_identity, ic.is_generated AS is_generated FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_type t ON t.oid = a.atttypid LEFT JOIN pg_type et ON et.oid = t.typelem AND t.typcategory = 'A' LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum LEFT JOIN information_schema.columns ic ON ic.table_schema = n.nspname AND ic.table_name = c.relname AND ic.column_name = a.attname WHERE n.nspname = ${this.schema} AND c.relname = ${table} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
      ),
    );

    return rows.map((row): ColumnIR => {
      const name = String(field(row, "column_name"));
      const nativeType = String(field(row, "type_text"));
      const labels = enumLabels(field(row, "enum_labels"));
      const enumOf = (typeName: unknown, kind: unknown) =>
        text(kind) === "e" && labels
          ? (candidate: string): CanonicalType | undefined =>
              candidate === text(typeName)
                ? { kind: "enum", values: labels, name: text(typeName) }
                : undefined
          : undefined;
      const resolve =
        enumOf(field(row, "type_name"), field(row, "type_kind")) ??
        enumOf(field(row, "element_type_name"), field(row, "element_type_kind"));

      const rawDefault = text(field(row, "default_expr"));
      const generated = text(field(row, "is_generated")) === "ALWAYS";
      const defaultValue = generated ? undefined : parsePostgresDefault(rawDefault);
      const column: ColumnIR = {
        name,
        type: parsePostgresType(nativeType, resolve),
        nullable: !bool(field(row, "not_null")),
        identity:
          text(field(row, "is_identity")) === "YES" ||
          defaultValue?.kind === "sequence",
        nativeType,
        rawDefault,
      };
      if (defaultValue) column.default = defaultValue;
      if (generated) column.generatedExpression = rawDefault ?? "";
      return column;
    });
  }

  private async readPrimaryKey(table: string): Promise<string[]> {
    const rows = normalizeRows(
      await this.query(
        sql`SELECT a.attname AS column_name FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord) ON true JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum WHERE n.nspname = ${this.schema} AND c.relname = ${table} AND i.indisprimary ORDER BY k.ord`,
      ),
    );
    return rows.map((row) => String(field(row, "column_name")));
  }

  private async readForeignKeys(table: string): Promise<ForeignKeyIR[]> {
    // conkey / confkey are unnested together so each local column is paired
    // with its own referenced column — information_schema's
    // constraint_column_usage cannot pair them for a composite key.
    const rows = normalizeRows(
      await this.query(
        sql`SELECT con.conname AS constraint_name, a.attname AS column_name, rn.nspname AS referenced_schema, rc.relname AS referenced_table, ra.attname AS referenced_column, con.confupdtype AS update_action, con.confdeltype AS delete_action FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_class rc ON rc.oid = con.confrelid JOIN pg_namespace rn ON rn.oid = rc.relnamespace JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(attnum, refattnum, ord) ON true JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.refattnum WHERE con.contype = 'f' AND n.nspname = ${this.schema} AND c.relname = ${table} ORDER BY con.conname, k.ord`,
      ),
    );

    const byName = new Map<string, ForeignKeyIR>();
    for (const row of rows) {
      const name = String(field(row, "constraint_name"));
      let fk = byName.get(name);
      if (!fk) {
        const referencedSchema = String(field(row, "referenced_schema"));
        fk = {
          name,
          columns: [],
          referencedTable: String(field(row, "referenced_table")),
          referencedColumns: [],
          onDelete: PG_ACTIONS[String(field(row, "delete_action"))] ?? "NO ACTION",
          onUpdate: PG_ACTIONS[String(field(row, "update_action"))] ?? "NO ACTION",
        };
        if (referencedSchema !== this.schema) fk.referencedSchema = referencedSchema;
        byName.set(name, fk);
      }
      fk.columns.push(String(field(row, "column_name")));
      fk.referencedColumns.push(String(field(row, "referenced_column")));
    }
    return [...byName.values()];
  }

  private async readIndexes(table: string): Promise<IndexIR[]> {
    // One row per index key part. `part_definition` is that part as the
    // server would write it in CREATE INDEX — a plain column reads as its
    // quoted name, anything else (an expression, DESC, an operator class, a
    // collation) differs from it.
    const rows = normalizeRows(
      await this.query(
        sql`SELECT ic.relname AS index_name, ix.indisunique AS is_unique, am.amname AS method, pg_get_expr(ix.indpred, ix.indrelid) AS predicate, pg_get_indexdef(ix.indexrelid) AS definition, a.attname AS column_name, quote_ident(a.attname) AS quoted_name, pg_get_indexdef(ix.indexrelid, k.ord::int, true) AS part_definition FROM pg_index ix JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_class ic ON ic.oid = ix.indexrelid JOIN pg_am am ON am.oid = ic.relam JOIN LATERAL unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord) ON true LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum AND k.attnum > 0 WHERE n.nspname = ${this.schema} AND t.relname = ${table} AND NOT ix.indisprimary ORDER BY ic.relname, k.ord`,
      ),
    );

    const byName = new Map<string, IndexIR>();
    for (const row of rows) {
      const name = String(field(row, "index_name"));
      let index = byName.get(name);
      if (!index) {
        index = {
          name,
          unique: bool(field(row, "is_unique")),
          columns: [],
          unsupported: [],
        };
        const method = text(field(row, "method"));
        if (method && method !== "btree") index.unsupported.push(`USING ${method}`);
        const predicate = text(field(row, "predicate"));
        if (predicate) index.unsupported.push(`partial index WHERE ${predicate}`);
        const definition = text(field(row, "definition")) ?? "";
        const include = /\sINCLUDE\s*\((.*)\)/i.exec(definition);
        if (include) index.unsupported.push(`INCLUDE (${include[1]})`);
        byName.set(name, index);
      }

      const column = text(field(row, "column_name"));
      const part = text(field(row, "part_definition")) ?? "";
      if (column === null) {
        index.unsupported.push(`expression ${part}`);
      } else if (part !== text(field(row, "quoted_name"))) {
        index.unsupported.push(`key part ${part}`);
      } else {
        index.columns.push(column);
      }
    }
    return [...byName.values()];
  }
}

/** `array_agg` comes back as a JS array from pg, or as `{a,b}` text. */
function enumLabels(value: unknown): string[] | null {
  if (Array.isArray(value)) return value.map(String);
  const raw = text(value);
  if (!raw) return null;
  const inner = raw.replace(/^\{/, "").replace(/\}$/, "");
  if (inner === "") return [];
  const labels: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quoted) {
      if (ch === "\\") current += inner[++i] ?? "";
      else if (ch === '"') quoted = false;
      else current += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      labels.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  labels.push(current);
  return labels;
}
