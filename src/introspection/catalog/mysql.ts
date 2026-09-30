/* eslint-disable @typescript-eslint/no-explicit-any */
import sql from "../../utils/sqlTag";
import { DbVersion } from "../../dialects/DbVersion";
import { resolveMySqlCapabilities } from "../../dialects/resolveCapabilities";
import type { ReferentialAction } from "../../types/ReferentialAction";
import {
  CanonicalType,
  ColumnIR,
  DefaultValue,
  ForeignKeyIR,
  IndexIR,
  sameType,
  stripOuterParens,
  TableIR,
  TextSize,
} from "../SchemaIR";
import {
  CatalogQueryFn,
  CatalogReader,
  CatalogServerInfo,
  DialectTypes,
  field,
  normalizeRows,
  num,
  text,
  TypeFidelity,
} from "./DialectCatalog";
import { isNumberLiteral, parseSqlDefault, readQuotedLiteral } from "./sqlLiterals";

const TEXT_SIZES: Record<string, TextSize> = {
  tinytext: "tiny",
  text: "normal",
  mediumtext: "medium",
  longtext: "long",
};

const BLOB_SIZES: Record<string, TextSize> = {
  tinyblob: "tiny",
  blob: "normal",
  mediumblob: "medium",
  longblob: "long",
};

/**
 * Parses a MySQL / MariaDB type spelling — `COLUMN_TYPE` (`int(10) unsigned`,
 * `varchar(255)`, `enum('a','b')`, `datetime(3)`) and this ORM's DDL
 * (`INT(11)`, `TINYINT(1)`, `DECIMAL(10, 2)`, `ENUM('a','b')`) alike.
 */
function parseMySqlType(nativeType: string): CanonicalType {
  const native = nativeType.trim();
  const enumMatch = /^(enum|set)\s*\((.*)\)$/is.exec(native);
  if (enumMatch) {
    return enumMatch[1].toLowerCase() === "enum"
      ? { kind: "enum", values: parseEnumValues(enumMatch[2]), name: null }
      : { kind: "other", native };
  }

  const lower = native.toLowerCase().replace(/\s+/g, " ");
  const unsigned = /\bunsigned\b/.test(lower);
  const base = lower
    .replace(/\b(unsigned|signed|zerofill)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const match = /^([a-z][a-z0-9_]*(?: precision)?)\s*(?:\(\s*([0-9\s,]*)\))?$/.exec(base);
  if (!match) return { kind: "other", native };
  const name = match[1];
  const args = (match[2] ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a !== "")
    .map(Number);

  switch (name) {
    case "tinyint":
      // TINYINT(1) is MySQL's boolean — BOOLEAN is an alias that creates it.
      return args[0] === 1
        ? { kind: "boolean" }
        : { kind: "integer", bytes: 1, unsigned };
    case "bool":
    case "boolean":
      return { kind: "boolean" };
    case "smallint":
      return { kind: "integer", bytes: 2, unsigned };
    case "mediumint":
      return { kind: "integer", bytes: 3, unsigned };
    case "int":
    case "integer":
      return { kind: "integer", bytes: 4, unsigned };
    case "bigint":
      return { kind: "integer", bytes: 8, unsigned };
    case "decimal":
    case "numeric":
    case "dec":
    case "fixed":
      // DECIMAL = DECIMAL(10, 0); DECIMAL(p) = DECIMAL(p, 0).
      return { kind: "decimal", precision: args[0] ?? 10, scale: args[1] ?? 0 };
    case "float":
      if (args.length === 2) {
        return { kind: "float", bytes: 4, digits: { precision: args[0], scale: args[1] } };
      }
      // FLOAT(p): 0–24 is single precision, 25–53 double.
      return { kind: "float", bytes: args.length === 1 && args[0] > 24 ? 8 : 4 };
    case "double":
    case "double precision":
    case "real":
      return args.length === 2
        ? { kind: "float", bytes: 8, digits: { precision: args[0], scale: args[1] } }
        : { kind: "float", bytes: 8 };
    case "char":
      return { kind: "string", fixed: true, length: args[0] ?? 1 };
    case "varchar":
      return { kind: "string", fixed: false, length: args[0] ?? null };
    case "binary":
      return { kind: "binary", fixed: true, length: args[0] ?? 1 };
    case "varbinary":
      return { kind: "binary", fixed: false, length: args[0] ?? null };
    case "tinytext":
    case "text":
    case "mediumtext":
    case "longtext":
      return { kind: "text", size: TEXT_SIZES[name] };
    case "tinyblob":
    case "blob":
    case "mediumblob":
    case "longblob":
      return { kind: "blob", size: BLOB_SIZES[name] };
    case "json":
      return { kind: "json", binary: false };
    case "uuid":
      return { kind: "uuid" };
    case "date":
      return { kind: "date" };
    case "datetime":
      return { kind: "timestamp", zone: "local", precision: fraction(args[0]) };
    case "timestamp":
      // TIMESTAMP stores UTC and converts through the session time zone.
      return { kind: "timestamp", zone: "instant", precision: fraction(args[0]) };
    case "time":
      return { kind: "time", withTimeZone: false, precision: fraction(args[0]) };
    default:
      return { kind: "other", native };
  }
}

/** MySQL's default fractional-second precision is 0. */
function fraction(value: number | undefined): number | null {
  return value === undefined || value === 0 ? null : value;
}

/**
 * The value list of `enum('a','b')`: quoted literals with `''` and backslash
 * escapes — the escaping this ORM's DDL uses as well as the catalog's.
 */
function parseEnumValues(body: string): string[] {
  const values: string[] = [];
  let rest = body.trim();
  while (rest.length > 0) {
    const literal = readQuotedLiteral(rest, "'", true);
    if (!literal) break;
    values.push(literal.value);
    rest = rest.slice(literal.end).replace(/^\s*,\s*/, "");
  }
  return values;
}

function compareMySqlTypes(
  declared: CanonicalType,
  created: CanonicalType,
): TypeFidelity {
  return sameType(declared, created) ? "exact" : "different";
}

export const mysqlTypes: DialectTypes = {
  dialect: "mysql",
  parseType: parseMySqlType,
  compareTypes: compareMySqlTypes,
  // InnoDB creates an index for a foreign key that has none to use.
  foreignKeysCreateIndexes: true,
};

/**
 * Whose `COLUMN_DEFAULT` spelling to read: MariaDB (10.2.7+) prints SQL —
 * `'text'`, `NULL`, `current_timestamp()` — while MySQL prints a literal's
 * bare value (`text`) and flags an expression with `DEFAULT_GENERATED`.
 * `unknown` guesses from the text, for rows that did not come from a server.
 */
export type MySqlFlavor = "mysql" | "mariadb" | "unknown";

const TEMPORAL_EXPRESSION =
  /^(current_timestamp|now|localtime|localtimestamp|current_date|curdate|current_time|curtime|utc_timestamp|sysdate)\s*(\(\s*\d*\s*\))?$/i;

/**
 * MySQL spells the current-time functions several ways — `CURRENT_TIMESTAMP`,
 * `now()`, and MariaDB's `current_timestamp()` — and rewrites one into another
 * (a parenthesized `DEFAULT (CURRENT_TIMESTAMP)` comes back as `now()`). They
 * are one function, so the IR has one spelling for each.
 */
export function canonicalTemporalFunction(sql: string): string {
  const match =
    /^(current_timestamp|now|localtime|localtimestamp|current_date|curdate|current_time|curtime)\s*(?:\(\s*(\d*)\s*\))?$/i.exec(
      sql.trim(),
    );
  if (!match) return sql;
  const fn = match[1].toLowerCase();
  const precision = match[2] ? `(${match[2]})` : "";
  if (fn === "current_date" || fn === "curdate") return "CURRENT_DATE";
  if (fn === "current_time" || fn === "curtime") return `CURRENT_TIME${precision}`;
  return `CURRENT_TIMESTAMP${precision}`;
}

/** Parses `COLUMN_DEFAULT` for a column of the given type. */
export function parseMySqlDefault(
  raw: string | null | undefined,
  type: CanonicalType,
  extra: string,
  flavor: MySqlFlavor,
): DefaultValue | undefined {
  if (raw === null || raw === undefined) return undefined;
  const value = raw;
  const extraLower = extra.toLowerCase();

  if (flavor === "mariadb") {
    return canonicalDefault(
      coerceBooleanDefault(parseSqlDefault(value, { backslashEscapes: true }), type),
    );
  }
  if (flavor === "unknown") {
    const trimmed = value.trim();
    if (trimmed.startsWith("'") || /^null$/i.test(trimmed)) {
      return canonicalDefault(
        coerceBooleanDefault(parseSqlDefault(trimmed, { backslashEscapes: true }), type),
      );
    }
  }

  // DEFAULT_GENERATED marks an expression default (8.0.13+); before that the
  // only expression a column could have was CURRENT_TIMESTAMP on a temporal one.
  const temporal =
    type.kind === "timestamp" || type.kind === "date" || type.kind === "time";
  if (
    extraLower.includes("default_generated") ||
    (temporal && TEMPORAL_EXPRESSION.test(value.trim()))
  ) {
    // A TEXT / BLOB / JSON column can only take a literal as an expression,
    // `DEFAULT ('[]')`, which MySQL prints with a charset introducer:
    // `_utf8mb4\'[]\'`. It stays an expression — MySQL refuses the bare
    // literal on those types — but as plain SQL the server reads back the same.
    const introduced = /^_[a-z0-9]+(\\?)'(.*)\1'$/is.exec(value.trim());
    if (introduced) {
      const inner = introduced[1]
        ? introduced[2].replace(/\\(.)/g, "$1").replace(/'/g, "''")
        : introduced[2];
      return { kind: "expression", sql: `'${inner}'` };
    }
    return { kind: "expression", sql: canonicalTemporalFunction(stripOuterParens(value)) };
  }
  if (/^b'[01]*'$/i.test(value.trim())) {
    return { kind: "expression", sql: value.trim() };
  }

  // MySQL: the literal's value, unquoted.
  switch (type.kind) {
    case "boolean":
    case "integer":
    case "decimal":
    case "float":
      if (isNumberLiteral(value)) {
        return coerceBooleanDefault({ kind: "number", value: value.trim() }, type);
      }
      return { kind: "expression", sql: stripOuterParens(value) };
    default:
      return { kind: "string", value };
  }
}

function canonicalDefault(value: DefaultValue): DefaultValue {
  return value.kind === "expression"
    ? { kind: "expression", sql: canonicalTemporalFunction(value.sql) }
    : value;
}

/** `0` / `1` on a TINYINT(1) column is `false` / `true`. */
function coerceBooleanDefault(value: DefaultValue, type: CanonicalType): DefaultValue {
  if (type.kind !== "boolean") return value;
  if (value.kind === "number" && (value.value === "0" || value.value === "1")) {
    return { kind: "boolean", value: value.value === "1" };
  }
  if (value.kind === "string" && (value.value === "0" || value.value === "1")) {
    return { kind: "boolean", value: value.value === "1" };
  }
  return value;
}

/**
 * RESTRICT and NO ACTION are the same action in InnoDB (both are checked
 * immediately), and MariaDB reports RESTRICT for a key declared with neither,
 * so the two are read as the default.
 */
function mysqlAction(value: unknown): ReferentialAction {
  const action = (text(value) ?? "").toUpperCase();
  switch (action) {
    case "CASCADE":
    case "SET NULL":
    case "SET DEFAULT":
      return action;
    default:
      return "NO ACTION";
  }
}

/** Reads a MySQL / MariaDB database through `information_schema`. */
export class MySqlCatalogReader implements CatalogReader {
  readonly types = mysqlTypes;
  private flavor: Promise<{ flavor: MySqlFlavor; version: string }> | null = null;

  constructor(private readonly query: CatalogQueryFn) {}

  private server(): Promise<{ flavor: MySqlFlavor; version: string }> {
    this.flavor ??= (async () => {
      const rows = normalizeRows(await this.query("SELECT VERSION() AS version"));
      const version = text(field(rows[0], "version")) ?? "";
      if (version === "") return { flavor: "unknown" as const, version };
      return {
        flavor: DbVersion.isMariaDb(version) ? ("mariadb" as const) : ("mysql" as const),
        version,
      };
    })();
    return this.flavor;
  }

  async readServerInfo(): Promise<CatalogServerInfo> {
    const { flavor, version } = await this.server();
    if (flavor === "unknown") return {};
    return {
      capabilities: resolveMySqlCapabilities(
        DbVersion.parse(version),
        flavor === "mariadb",
      ),
    };
  }

  async listTables(): Promise<string[]> {
    const rows = normalizeRows(
      await this.query(
        "SELECT TABLE_NAME AS table_name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
      ),
    );
    return rows.map((row) => String(field(row, "table_name")));
  }

  async readTable(name: string): Promise<TableIR> {
    return {
      name,
      columns: await this.readColumns(name),
      primaryKey: await this.readPrimaryKey(name),
      foreignKeys: await this.readForeignKeys(name),
      indexes: await this.readIndexes(name),
    };
  }

  private async readColumns(table: string): Promise<ColumnIR[]> {
    const { flavor } = await this.server();
    // SELECT * rather than a column list: GENERATION_EXPRESSION and
    // DATETIME_PRECISION do not exist on every supported server version.
    const rows = normalizeRows(
      await this.query(
        sql`SELECT * FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table} ORDER BY ORDINAL_POSITION`,
      ),
    );
    const jsonColumns = flavor === "mariadb" ? await this.readMariaDbJsonColumns(table) : new Set<string>();

    return rows.map((row): ColumnIR => {
      const name = String(field(row, "COLUMN_NAME"));
      const nativeType = String(field(row, "COLUMN_TYPE") ?? field(row, "DATA_TYPE"));
      const extra = text(field(row, "EXTRA")) ?? "";
      const extraLower = extra.toLowerCase();
      // MariaDB's JSON is LONGTEXT with a json_valid() CHECK constraint.
      const type: CanonicalType = jsonColumns.has(name)
        ? { kind: "json", binary: false }
        : parseMySqlType(nativeType);
      const generated = /\b(virtual|stored) generated\b|\bpersistent\b/.test(extraLower);
      const rawDefault = text(field(row, "COLUMN_DEFAULT"));

      const column: ColumnIR = {
        name,
        type,
        nullable: text(field(row, "IS_NULLABLE")) === "YES",
        identity: extraLower.includes("auto_increment"),
        nativeType,
        rawDefault,
      };
      if (generated) {
        column.generatedExpression = text(field(row, "GENERATION_EXPRESSION")) ?? "";
      } else {
        const value = parseMySqlDefault(rawDefault, type, extra, flavor);
        // MariaDB prints NULL for a nullable column with no default.
        if (value && !(value.kind === "null" && column.nullable)) column.default = value;
      }
      const onUpdate = /on update ([^\s].*)$/i.exec(extra);
      if (onUpdate) column.onUpdate = canonicalTemporalFunction(onUpdate[1]);
      return column;
    });
  }

  /** Columns MariaDB constrains with `json_valid()` — its JSON columns. */
  private async readMariaDbJsonColumns(table: string): Promise<Set<string>> {
    let rows: any[];
    try {
      rows = normalizeRows(
        await this.query(
          sql`SELECT CHECK_CLAUSE AS check_clause FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ${table}`,
        ),
      );
    } catch {
      // Servers before 10.2.22 have no CHECK_CONSTRAINTS view.
      return new Set();
    }
    const columns = new Set<string>();
    for (const row of rows) {
      const clause = text(field(row, "check_clause")) ?? "";
      const match = /^\s*json_valid\s*\(\s*`((?:[^`]|``)+)`\s*\)\s*$/i.exec(clause);
      if (match) columns.add(match[1].replace(/``/g, "`"));
    }
    return columns;
  }

  private async readPrimaryKey(table: string): Promise<string[]> {
    const rows = normalizeRows(
      await this.query(
        sql`SELECT COLUMN_NAME AS column_name FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table} AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION`,
      ),
    );
    return rows.map((row) => String(field(row, "column_name")));
  }

  private async readForeignKeys(table: string): Promise<ForeignKeyIR[]> {
    const rows = normalizeRows(
      await this.query(
        sql`SELECT k.CONSTRAINT_NAME AS constraint_name, k.COLUMN_NAME AS column_name, k.REFERENCED_TABLE_SCHEMA AS referenced_schema, k.REFERENCED_TABLE_NAME AS referenced_table, k.REFERENCED_COLUMN_NAME AS referenced_column, r.UPDATE_RULE AS update_rule, r.DELETE_RULE AS delete_rule, DATABASE() AS current_schema FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME = ${table} AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      ),
    );

    const byName = new Map<string, ForeignKeyIR>();
    for (const row of rows) {
      const name = String(field(row, "constraint_name"));
      let fk = byName.get(name);
      if (!fk) {
        fk = {
          name,
          columns: [],
          referencedTable: String(field(row, "referenced_table")),
          referencedColumns: [],
          onDelete: mysqlAction(field(row, "delete_rule")),
          onUpdate: mysqlAction(field(row, "update_rule")),
        };
        const referencedSchema = text(field(row, "referenced_schema"));
        if (referencedSchema && referencedSchema !== text(field(row, "current_schema"))) {
          fk.referencedSchema = referencedSchema;
        }
        byName.set(name, fk);
      }
      fk.columns.push(String(field(row, "column_name")));
      fk.referencedColumns.push(String(field(row, "referenced_column")));
    }
    return [...byName.values()];
  }

  private async readIndexes(table: string): Promise<IndexIR[]> {
    // SELECT *: EXPRESSION (functional key parts) exists on MySQL 8.0.13+ only.
    const rows = normalizeRows(
      await this.query(
        sql`SELECT * FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table} AND INDEX_NAME <> 'PRIMARY' ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      ),
    );

    const byName = new Map<string, IndexIR>();
    for (const row of rows) {
      const name = String(field(row, "INDEX_NAME"));
      let index = byName.get(name);
      if (!index) {
        index = {
          name,
          unique: Number(field(row, "NON_UNIQUE")) === 0,
          columns: [],
          unsupported: [],
        };
        const indexType = (text(field(row, "INDEX_TYPE")) ?? "BTREE").toUpperCase();
        if (indexType !== "BTREE") index.unsupported.push(indexType);
        byName.set(name, index);
      }

      const column = text(field(row, "COLUMN_NAME"));
      const subPart = num(field(row, "SUB_PART"));
      const collation = text(field(row, "COLLATION"));
      if (column === null) {
        index.unsupported.push(`expression ${text(field(row, "EXPRESSION")) ?? "(unknown)"}`);
      } else {
        index.columns.push(column);
        if (subPart !== null) index.unsupported.push(`prefix length ${subPart} on ${column}`);
        if (collation === "D") index.unsupported.push(`descending key ${column}`);
      }
    }
    return [...byName.values()];
  }
}
