/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { raw } from "../../utils/sqlTag";
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
  num,
  text,
  TypeFidelity,
} from "./DialectCatalog";
import { parseSqlDefault } from "./sqlLiterals";

/**
 * Escapes an identifier for `PRAGMA <name>(<ident>)`. PRAGMA arguments cannot
 * be bound, so this is the only sanctioned way to put a name into one.
 */
export function escapeSqliteIdentifier(identifier: string): string {
  if (/[\x00\x1a]/.test(identifier)) {
    throw new Error(
      `SQLite identifier '${identifier}' contains a NUL or substitute character`,
    );
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * Parses a SQLite declared type. SQLite keeps whatever the CREATE TABLE said,
 * so the declared name carries the author's intent (`BOOLEAN`, `DATETIME`);
 * a name it does not know is read by SQLite's own affinity rules.
 *
 * `TEXT(n)` is this ORM's spelling for a varchar on SQLite, so it reads as a
 * bounded string — otherwise a database the ORM created would come back with
 * every varchar turned into unbounded text.
 */
function parseSqliteType(nativeType: string): CanonicalType {
  const native = nativeType.trim();
  const match = /^([a-z][a-z0-9_ ]*?)\s*(?:\(\s*([0-9\s,]*)\))?$/i.exec(native);
  if (!match) return byAffinity(native);
  const name = match[1].toUpperCase().replace(/\s+/g, " ");
  const args = (match[2] ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a !== "")
    .map(Number);

  switch (name) {
    case "INTEGER":
    case "INT":
    case "INT4":
    case "MEDIUMINT":
      return { kind: "integer", bytes: 4, unsigned: false };
    case "TINYINT":
      return { kind: "integer", bytes: 1, unsigned: false };
    case "SMALLINT":
    case "INT2":
      return { kind: "integer", bytes: 2, unsigned: false };
    case "BIGINT":
    case "INT8":
    case "UNSIGNED BIG INT":
      return { kind: "integer", bytes: 8, unsigned: false };
    case "BOOLEAN":
    case "BOOL":
      return { kind: "boolean" };
    case "REAL":
    case "DOUBLE":
    case "DOUBLE PRECISION":
    case "FLOAT":
      return { kind: "float", bytes: 8 };
    case "NUMERIC":
    case "DECIMAL":
      return { kind: "decimal", precision: args[0] ?? null, scale: args[1] ?? null };
    case "VARCHAR":
    case "VARYING CHARACTER":
    case "NVARCHAR":
    case "NATIVE CHARACTER VARYING":
      return { kind: "string", fixed: false, length: args[0] ?? null };
    case "CHAR":
    case "CHARACTER":
    case "NCHAR":
    case "NATIVE CHARACTER":
      return args.length > 0
        ? { kind: "string", fixed: true, length: args[0] }
        : { kind: "text", size: "unbounded" };
    case "TEXT":
      return args.length > 0
        ? { kind: "string", fixed: false, length: args[0] }
        : { kind: "text", size: "unbounded" };
    case "CLOB":
      return { kind: "text", size: "unbounded" };
    case "BLOB":
      return { kind: "blob", size: "unbounded" };
    case "UUID":
      return { kind: "uuid" };
    case "JSON":
      return { kind: "json", binary: false };
    case "JSONB":
      return { kind: "json", binary: true };
    case "DATE":
      return { kind: "date" };
    case "DATETIME":
    case "TIMESTAMP":
      return { kind: "timestamp", zone: "local", precision: null };
    case "TIMESTAMPTZ":
      return { kind: "timestamp", zone: "instant", precision: null };
    case "TIME":
      return { kind: "time", withTimeZone: false, precision: null };
    default:
      return byAffinity(native);
  }
}

/** SQLite's type-affinity rules (datatype3.html §3.1), in their order. */
function byAffinity(native: string): CanonicalType {
  const upper = native.toUpperCase();
  if (upper.includes("INT")) return { kind: "integer", bytes: 8, unsigned: false };
  if (upper.includes("CHAR") || upper.includes("CLOB") || upper.includes("TEXT")) {
    return { kind: "text", size: "unbounded" };
  }
  if (upper.includes("BLOB")) return { kind: "blob", size: "unbounded" };
  if (upper.includes("REAL") || upper.includes("FLOA") || upper.includes("DOUB")) {
    return { kind: "float", bytes: 8 };
  }
  return { kind: "other", native };
}

/**
 * The column affinity (datatype3.html §3.1) of the declared types this parser
 * reads into each canonical type — what SQLite actually does with a value.
 * INTEGER and NUMERIC are one class here: the two behave the same except in a
 * CAST expression.
 */
function affinity(t: CanonicalType): string {
  switch (t.kind) {
    case "integer":
    case "boolean":
    case "decimal":
    case "uuid":
    case "json":
    case "date":
    case "time":
    case "timestamp":
    case "enum":
      // INTEGER / INT, and names without a keyword (BOOLEAN, DATETIME, JSON, …).
      return "NUMERIC";
    case "float":
      return "REAL";
    case "string":
    case "text":
      return "TEXT";
    case "blob":
    case "binary":
      return "BLOB";
    case "array":
      return "OTHER";
    case "other":
      return affinityOfName(t.native);
  }
}

function affinityOfName(native: string): string {
  const upper = native.toUpperCase();
  if (upper.includes("INT")) return "NUMERIC";
  if (upper.includes("CHAR") || upper.includes("CLOB") || upper.includes("TEXT")) return "TEXT";
  if (upper.includes("BLOB") || upper.trim() === "") return "BLOB";
  if (upper.includes("REAL") || upper.includes("FLOA") || upper.includes("DOUB")) return "REAL";
  return "NUMERIC";
}

/**
 * SQLite keeps only a column's affinity, so a different declaration with the
 * same affinity stores and compares every value the same way. A different
 * affinity does not — `'123'` stays text under TEXT but becomes an integer
 * under the NUMERIC affinity of a declared `DATETIME` or `JSON`.
 */
function compareSqliteTypes(
  declared: CanonicalType,
  created: CanonicalType,
): TypeFidelity {
  if (sameType(declared, created)) return "exact";
  return affinity(declared) === affinity(created) ? "equivalent" : "different";
}

export const sqliteTypes: DialectTypes = {
  dialect: "sqlite",
  parseType: parseSqliteType,
  compareTypes: compareSqliteTypes,
  foreignKeysCreateIndexes: false,
};

/** Parses `PRAGMA table_xinfo(...).dflt_value` — the default's SQL text as declared. */
export function parseSqliteDefault(
  raw: string | null | undefined,
): DefaultValue | undefined {
  if (raw === null || raw === undefined || raw.trim() === "") return undefined;
  return parseSqlDefault(raw, { doubleQuotedStrings: true });
}

function sqliteAction(value: unknown): ReferentialAction {
  const action = (text(value) ?? "").toUpperCase();
  switch (action) {
    case "CASCADE":
    case "SET NULL":
    case "SET DEFAULT":
    case "RESTRICT":
      return action;
    default:
      return "NO ACTION";
  }
}

/** Reads a SQLite database through `sqlite_master` and the table PRAGMAs. */
export class SqliteCatalogReader implements CatalogReader {
  readonly types = sqliteTypes;

  constructor(private readonly query: CatalogQueryFn) {}

  async readServerInfo(): Promise<CatalogServerInfo> {
    return {};
  }

  async listTables(): Promise<string[]> {
    const rows = normalizeRows(
      await this.query(
        "SELECT name AS table_name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ),
    );
    return rows.map((row) => String(field(row, "table_name")));
  }

  private pragma(name: string, target: string): Promise<any[]> {
    return this.query(
      sql`PRAGMA ${raw(name)}(${raw(escapeSqliteIdentifier(target))})`,
    ).then(normalizeRows);
  }

  async readTable(name: string): Promise<TableIR> {
    // table_xinfo, not table_info: generated columns are hidden from table_info.
    const columnRows = (await this.pragma("table_xinfo", name)).filter(
      // hidden = 1 marks a virtual table's hidden columns — not data.
      (row) => Number(field(row, "hidden") ?? 0) !== 1,
    );
    const primaryKey = columnRows
      .filter((row) => Number(field(row, "pk")) > 0)
      .sort((a, b) => Number(field(a, "pk")) - Number(field(b, "pk")))
      .map((row) => String(field(row, "name")));
    const withoutRowid = await this.isWithoutRowid(name);

    const columns = columnRows.map((row): ColumnIR => {
      const columnName = String(field(row, "name"));
      const nativeType = text(field(row, "type")) ?? "";
      const hidden = Number(field(row, "hidden") ?? 0);
      const rawDefault = text(field(row, "dflt_value"));
      // Exactly `INTEGER PRIMARY KEY` aliases the rowid, which SQLite fills in
      // itself and which can never be NULL (the pragma still says notnull = 0);
      // `INT PRIMARY KEY` or a WITHOUT ROWID table has no such alias.
      const rowid =
        !withoutRowid &&
        primaryKey.length === 1 &&
        primaryKey[0] === columnName &&
        nativeType.trim().toUpperCase() === "INTEGER";
      const column: ColumnIR = {
        name: columnName,
        type: parseSqliteType(nativeType),
        nullable: !rowid && !bool(field(row, "notnull")),
        identity: rowid,
        nativeType,
        rawDefault,
      };
      if (hidden === 2 || hidden === 3) {
        column.generatedExpression = "";
      } else {
        const value = parseSqliteDefault(rawDefault);
        if (value) column.default = value;
      }
      return column;
    });

    return {
      name,
      columns,
      primaryKey,
      foreignKeys: await this.readForeignKeys(name, primaryKey),
      indexes: await this.readIndexes(name),
    };
  }

  private async isWithoutRowid(table: string): Promise<boolean> {
    const rows = normalizeRows(
      await this.query(
        sql`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${table}`,
      ),
    );
    return /\bWITHOUT\s+ROWID\b/i.test(text(field(rows[0], "sql")) ?? "");
  }

  private async readForeignKeys(
    table: string,
    ownPrimaryKey: string[],
  ): Promise<ForeignKeyIR[]> {
    const rows = await this.pragma("foreign_key_list", table);
    const byId = new Map<number, { fk: ForeignKeyIR; parts: Array<{ seq: number; from: string; to: string | null }> }>();
    for (const row of rows) {
      const id = Number(field(row, "id"));
      let entry = byId.get(id);
      if (!entry) {
        entry = {
          fk: {
            columns: [],
            referencedTable: String(field(row, "table")),
            referencedColumns: [],
            onDelete: sqliteAction(field(row, "on_delete")),
            onUpdate: sqliteAction(field(row, "on_update")),
          },
          parts: [],
        };
        byId.set(id, entry);
      }
      entry.parts.push({
        seq: Number(field(row, "seq")),
        from: String(field(row, "from")),
        to: text(field(row, "to")),
      });
    }

    const result: ForeignKeyIR[] = [];
    for (const { fk, parts } of byId.values()) {
      parts.sort((a, b) => a.seq - b.seq);
      // `REFERENCES parent` without a column list points at parent's key.
      const implicit = parts.some((p) => p.to === null)
        ? fk.referencedTable === table
          ? ownPrimaryKey
          : await this.primaryKeyOf(fk.referencedTable)
        : [];
      parts.forEach((part, i) => {
        fk.columns.push(part.from);
        fk.referencedColumns.push(part.to ?? implicit[i] ?? "");
      });
      result.push(fk);
    }
    return result;
  }

  private async primaryKeyOf(table: string): Promise<string[]> {
    return (await this.pragma("table_info", table))
      .filter((row) => Number(field(row, "pk")) > 0)
      .sort((a, b) => Number(field(a, "pk")) - Number(field(b, "pk")))
      .map((row) => String(field(row, "name")));
  }

  private async readIndexes(table: string): Promise<IndexIR[]> {
    const list = await this.pragma("index_list", table);
    const result: IndexIR[] = [];
    for (const row of list) {
      const name = text(field(row, "name"));
      if (!name || text(field(row, "origin")) === "pk") continue;

      const index: IndexIR = {
        name,
        unique: Number(field(row, "unique")) === 1,
        columns: [],
        unsupported: [],
      };
      if (Number(field(row, "partial") ?? 0) === 1) {
        index.unsupported.push("partial index (WHERE clause)");
      }
      const parts = (await this.pragma("index_xinfo", name))
        .filter((part) => Number(field(part, "key") ?? 1) === 1)
        .sort((a, b) => Number(field(a, "seqno")) - Number(field(b, "seqno")));
      for (const part of parts) {
        const cid = num(field(part, "cid"));
        const column = text(field(part, "name"));
        const collation = (text(field(part, "coll")) ?? "BINARY").toUpperCase();
        if (cid === -2 || column === null) {
          index.unsupported.push("expression key part");
          continue;
        }
        index.columns.push(column);
        if (Number(field(part, "desc") ?? 0) === 1) {
          index.unsupported.push(`descending key ${column}`);
        }
        if (collation !== "BINARY") {
          index.unsupported.push(`COLLATE ${collation} on ${column}`);
        }
      }
      result.push(index);
    }
    // index_list runs newest first; name order keeps the output stable.
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }
}
