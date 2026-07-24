/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { join, raw } from "../utils/sqlTag";
import { IntrospectionDialect, IntrospectionTypeMapper } from "./TypeMapper";

/**
 * Escape a SQLite identifier for use in a `PRAGMA <name>(<ident>)` call.
 * SQLite uses double quotes and escapes internal quotes by doubling them.
 * PRAGMA statements can't be parameterized, so we have to interpolate the
 * identifier directly — this function is the *only* sanctioned way to do
 * that.
 */
function escapeSqliteIdentifier(identifier: string): string {
  if (/[\x00\x1a]/.test(identifier)) {
    throw new Error(
      `SQLite identifier '${identifier}' contains a NUL or substitute character`,
    );
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}
import {
  DbColumn,
  DbForeignKey,
  DbIndex,
  EntityCodeBuilder,
  EntityCodeBuilderOptions,
} from "./EntityCodeBuilder";

/**
 * Parse the value list out of a MySQL ENUM column type string.
 *
 * Example: `"enum('active','inactive','banned')"` → `["active", "inactive", "banned"]`.
 * Returns `null` when the input is empty or doesn't look like an ENUM clause.
 */
function parseMysqlEnumValues(
  columnType: string | null | undefined,
): string[] | null {
  if (!columnType) return null;
  const lower = columnType.toLowerCase();
  const idx = lower.indexOf("enum(");
  if (idx === -1) return null;
  const start = idx + "enum(".length;
  const end = columnType.lastIndexOf(")");
  if (end <= start) return null;

  const body = columnType.slice(start, end);
  const values: string[] = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] !== "'") {
      i++;
      continue;
    }
    // Consume a single-quoted string with MySQL's doubled-quote escape.
    i++;
    let buf = "";
    while (i < body.length) {
      const ch = body[i];
      if (ch === "'") {
        if (body[i + 1] === "'") {
          buf += "'";
          i += 2;
          continue;
        }
        i++;
        break;
      }
      buf += ch;
      i++;
    }
    values.push(buf);
  }
  return values.length > 0 ? values : null;
}

/**
 * Represents a generated entity file.
 */
export interface GeneratedEntity {
  tableName: string;
  className: string;
  code: string;
  fileName: string;
}

/**
 * Options for IntrospectionGenerator.
 */
export interface IntrospectionGeneratorOptions {
  /**
   * PostgreSQL schema to introspect. Default: "public"
   */
  schema?: string;

  /**
   * Tables to exclude from generation.
   */
  excludeTables?: string[];

  /**
   * Tables to include (if set, only these tables are generated).
   */
  includeTables?: string[];

  /**
   * EntityCodeBuilder options (import path etc.)
   */
  codeBuilderOptions?: EntityCodeBuilderOptions;
}

/**
 * Query function interface for introspection.
 * Accepts both plain SQL strings and sql-template-tag Sql objects.
 */
export interface IntrospectionQueryFn {
  (sql: string | import("sql-template-tag").Sql): Promise<any>;
}

/**
 * Generates TypeScript entity files from an existing database schema.
 *
 * Uses INFORMATION_SCHEMA queries to discover tables, columns, primary keys,
 * and foreign keys, then uses EntityCodeBuilder to produce entity source code.
 *
 * @example
 * ```ts
 * const generator = new IntrospectionGenerator(
 *   (q) => driver.query(q),
 *   "postgres",
 *   { schema: "public" },
 * );
 * const entities = await generator.generate();
 * for (const entity of entities) {
 *   fs.writeFileSync(`./entities/${entity.fileName}`, entity.code);
 * }
 * ```
 */
export class IntrospectionGenerator {
  private readonly queryFn: IntrospectionQueryFn;
  private readonly dialect: IntrospectionDialect;
  private readonly schema: string;
  private readonly excludeTables: Set<string>;
  private readonly includeTables: Set<string> | null;
  private readonly codeBuilder: EntityCodeBuilder;

  constructor(
    queryFn: IntrospectionQueryFn,
    dialect: IntrospectionDialect,
    options?: IntrospectionGeneratorOptions,
  ) {
    this.queryFn = queryFn;
    this.dialect = dialect;
    this.schema = options?.schema ?? "public";
    this.excludeTables = new Set(options?.excludeTables ?? []);
    this.includeTables = options?.includeTables
      ? new Set(options.includeTables)
      : null;
    this.codeBuilder = new EntityCodeBuilder(options?.codeBuilderOptions);
  }

  /**
   * Generate entity files for all discovered tables.
   */
  async generate(): Promise<GeneratedEntity[]> {
    const tables = await this.discoverTables();
    const results: GeneratedEntity[] = [];

    for (const table of tables) {
      if (this.excludeTables.has(table)) continue;
      if (this.includeTables && !this.includeTables.has(table)) continue;

      const columns = await this.getColumns(table);
      const pks = await this.getPrimaryKeys(table);
      const fks = await this.getForeignKeys(table);
      const indexes = await this.getIndexes(table);

      // Stabilize FK order so the round-trip is deterministic regardless of
      // how INFORMATION_SCHEMA happens to enumerate them on a given engine.
      // Sort by the FK column's position in `columns`, falling back to
      // alphabetical column name so unknown columns still sort consistently.
      const columnPosition = new Map<string, number>();
      columns.forEach((col, idx) => columnPosition.set(col.column_name, idx));
      fks.sort((a, b) => {
        const aPos = columnPosition.get(a.column_name) ?? Number.MAX_SAFE_INTEGER;
        const bPos = columnPosition.get(b.column_name) ?? Number.MAX_SAFE_INTEGER;
        if (aPos !== bPos) return aPos - bPos;
        return a.column_name.localeCompare(b.column_name);
      });

      const className = this.codeBuilder.tableNameToClassName(table);
      const code = this.codeBuilder.build(
        table,
        columns,
        pks,
        fks,
        this.dialect,
        indexes,
      );
      const fileName = this.codeBuilder.classNameToFileName(className);

      results.push({ tableName: table, className, code, fileName });
    }

    return results;
  }

  /**
   * Discover all user tables in the database.
   */
  async discoverTables(): Promise<string[]> {
    let rawResult: any;

    if (this.dialect === "mysql") {
      rawResult = await this.queryFn(
        "SELECT TABLE_NAME as table_name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME",
      );
    } else if (this.dialect === "sqlite") {
      rawResult = await this.queryFn(
        "SELECT name as table_name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      );
    } else {
      rawResult = await this.queryFn(
        sql`SELECT tablename as table_name FROM pg_tables WHERE schemaname = ${this.schema} ORDER BY tablename`,
      );
    }

    const rows = this.normalizeRows(rawResult);
    return rows.map((row: any) => row.table_name ?? row.TABLE_NAME ?? row.tablename ?? row.name);
  }

  /**
   * Get column metadata for a specific table.
   */
  async getColumns(table: string): Promise<DbColumn[]> {
    let rawResult: any;

    if (this.dialect === "mysql") {
      rawResult = await this.queryFn(
        sql`SELECT COLUMN_NAME as column_name, DATA_TYPE as data_type, COLUMN_TYPE as column_type, IS_NULLABLE as is_nullable, CHARACTER_MAXIMUM_LENGTH as character_maximum_length, NUMERIC_PRECISION as numeric_precision, NUMERIC_SCALE as numeric_scale, COLUMN_DEFAULT as column_default, EXTRA as extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table} ORDER BY ORDINAL_POSITION`,
      );

      const rows = this.normalizeRows(rawResult);
      // Parse MySQL ENUM('a','b',...) values out of COLUMN_TYPE.
      for (const row of rows) {
        if ((row.data_type ?? "").toString().toLowerCase() === "enum") {
          row.enum_values = parseMysqlEnumValues(row.column_type);
        }
      }
      return rows;
    }

    if (this.dialect === "sqlite") {
      const ident = escapeSqliteIdentifier(table);
      rawResult = await this.queryFn(sql`PRAGMA table_info(${raw(ident)})`);
      const rows = this.normalizeRows(rawResult);
      return rows.map((row: any) => {
        const declaredType: string = row.type ?? row.TYPE ?? "";
        const baseType = declaredType.replace(/\s*\([^)]*\)/, "").trim();
        const length = IntrospectionTypeMapper.parseSqliteWidth(declaredType);
        const precScale = IntrospectionTypeMapper.parseSqlitePrecisionScale(declaredType);
        return {
          column_name: row.name ?? row.NAME,
          data_type: baseType || declaredType,
          column_type: declaredType,
          is_nullable: (row.notnull ?? row.NOTNULL) ? "NO" : "YES",
          character_maximum_length: length,
          numeric_precision: precScale?.precision ?? null,
          numeric_scale: precScale?.scale ?? null,
          column_default:
            row.dflt_value === undefined ? null : row.dflt_value,
          extra: null,
        } as DbColumn;
      });
    }

    rawResult = await this.queryFn(
      sql`SELECT column_name, data_type, udt_name, is_nullable, character_maximum_length, numeric_precision, numeric_scale, column_default, is_identity FROM information_schema.columns WHERE table_schema = ${this.schema} AND table_name = ${table} ORDER BY ordinal_position`,
    );

    const rows = this.normalizeRows(rawResult);

    // Backfill PostgreSQL enum labels for USER-DEFINED columns.
    const enumColumns = rows.filter(
      (row: any) =>
        (row.data_type ?? "").toString().toUpperCase() === "USER-DEFINED" &&
        typeof row.udt_name === "string",
    );

    if (enumColumns.length > 0) {
      const enumNames = Array.from(
        new Set(enumColumns.map((r: any) => r.udt_name as string)),
      );
      const enumLabels = await this.getPostgresEnumLabels(enumNames);
      for (const row of rows) {
        const udt = (row as any).udt_name;
        if (typeof udt === "string" && enumLabels.has(udt)) {
          (row as any).enum_values = enumLabels.get(udt);
        }
      }
    }

    return rows;
  }

  /**
   * Fetch enum labels for the given PostgreSQL enum type names.
   * Returns a map keyed by `pg_type.typname` containing the ordered labels.
   */
  private async getPostgresEnumLabels(
    enumTypeNames: string[],
  ): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (enumTypeNames.length === 0) return result;

    const nameSqls = enumTypeNames.map((n) => sql`${n}`);
    const rawResult = await this.queryFn(
      sql`SELECT t.typname as type_name, e.enumlabel as label FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname IN (${join(nameSqls, ", ")}) AND n.nspname = ${this.schema} ORDER BY t.typname, e.enumsortorder`,
    );

    const rows = this.normalizeRows(rawResult);
    for (const row of rows) {
      const name = row.type_name ?? row.TYPE_NAME;
      const label = row.label ?? row.LABEL;
      if (typeof name !== "string" || typeof label !== "string") continue;
      const list = result.get(name) ?? [];
      list.push(label);
      result.set(name, list);
    }
    return result;
  }

  /**
   * Get primary key column names for a specific table.
   */
  async getPrimaryKeys(table: string): Promise<string[]> {
    let rawResult: any;

    if (this.dialect === "mysql") {
      rawResult = await this.queryFn(
        sql`SELECT COLUMN_NAME as column_name FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table} AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION`,
      );
    } else if (this.dialect === "sqlite") {
      const ident = escapeSqliteIdentifier(table);
      rawResult = await this.queryFn(sql`PRAGMA table_info(${raw(ident)})`);
      const rows = this.normalizeRows(rawResult);
      return rows
        .filter((row: any) => Number(row.pk ?? row.PK) > 0)
        .sort((a: any, b: any) => Number(a.pk ?? a.PK) - Number(b.pk ?? b.PK))
        .map((row: any) => row.name ?? row.NAME);
    } else {
      rawResult = await this.queryFn(
        sql`SELECT a.attname as column_name FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = ${this.schema + "." + table}::regclass AND i.indisprimary ORDER BY a.attnum`,
      );
    }

    const rows = this.normalizeRows(rawResult);
    return rows.map((row: any) => row.column_name ?? row.COLUMN_NAME);
  }

  /**
   * Get foreign key relationships for a specific table.
   */
  async getForeignKeys(table: string): Promise<DbForeignKey[]> {
    let rawResult: any;

    if (this.dialect === "mysql") {
      rawResult = await this.queryFn(
        sql`SELECT kcu.COLUMN_NAME as column_name, kcu.REFERENCED_TABLE_NAME as referenced_table, kcu.REFERENCED_COLUMN_NAME as referenced_column, kcu.CONSTRAINT_NAME as constraint_name FROM information_schema.KEY_COLUMN_USAGE kcu WHERE kcu.TABLE_SCHEMA = DATABASE() AND kcu.TABLE_NAME = ${table} AND kcu.REFERENCED_TABLE_NAME IS NOT NULL`,
      );
    } else if (this.dialect === "sqlite") {
      const ident = escapeSqliteIdentifier(table);
      rawResult = await this.queryFn(sql`PRAGMA foreign_key_list(${raw(ident)})`);
      const rows = this.normalizeRows(rawResult);
      return rows.map((row: any) => ({
        column_name: row.from ?? row.FROM,
        referenced_table: row.table ?? row.TABLE,
        referenced_column: row.to ?? row.TO,
        constraint_name: undefined,
      }));
    } else {
      rawResult = await this.queryFn(
        sql`SELECT kcu.column_name, ccu.table_name as referenced_table, ccu.column_name as referenced_column, tc.constraint_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = ${this.schema} AND tc.table_name = ${table}`,
      );
    }

    const rows = this.normalizeRows(rawResult);
    return rows.map((row: any) => ({
      column_name: row.column_name ?? row.COLUMN_NAME,
      referenced_table: row.referenced_table ?? row.REFERENCED_TABLE_NAME,
      referenced_column: row.referenced_column ?? row.REFERENCED_COLUMN_NAME,
      constraint_name: row.constraint_name ?? row.CONSTRAINT_NAME,
    }));
  }

  /**
   * Get non-PK indexes (unique and non-unique) for a specific table.
   *
   * PK indexes are excluded (handled by @PrimaryColumn / @PrimaryGeneratedColumn).
   * FK-implied indexes that exactly cover a single FK column are filtered
   * out as well — most engines create those automatically when needed.
   */
  async getIndexes(table: string): Promise<DbIndex[]> {
    if (this.dialect === "mysql") {
      const rawResult = await this.queryFn(
        sql`SELECT INDEX_NAME as index_name, COLUMN_NAME as column_name, NON_UNIQUE as non_unique, SEQ_IN_INDEX as seq_in_index FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table} AND INDEX_NAME <> 'PRIMARY' ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      );
      const rows = this.normalizeRows(rawResult);
      return this.collapseIndexRows(
        rows.map((row: any) => ({
          name: row.index_name ?? row.INDEX_NAME,
          column: row.column_name ?? row.COLUMN_NAME,
          unique: Number(row.non_unique ?? row.NON_UNIQUE) === 0,
        })),
        await this.getForeignKeyColumns(table),
      );
    }

    if (this.dialect === "sqlite") {
      const tableIdent = escapeSqliteIdentifier(table);
      const list = await this.queryFn(
        sql`PRAGMA index_list(${raw(tableIdent)})`,
      );
      const listRows = this.normalizeRows(list);

      const result: DbIndex[] = [];
      const fkColumns = await this.getForeignKeyColumns(table);

      for (const row of listRows) {
        const indexName = row.name ?? row.NAME;
        const origin = (row.origin ?? row.ORIGIN ?? "").toString();
        if (origin === "pk") continue; // skip PK index
        if (!indexName) continue;
        const isUnique = Number(row.unique ?? row.UNIQUE) === 1;

        const infoIdent = escapeSqliteIdentifier(indexName);
        const infoRaw = await this.queryFn(
          sql`PRAGMA index_info(${raw(infoIdent)})`,
        );
        const infoRows = this.normalizeRows(infoRaw);
        const columnNames = infoRows
          .sort(
            (a: any, b: any) =>
              Number(a.seqno ?? a.SEQNO) - Number(b.seqno ?? b.SEQNO),
          )
          .map((r: any) => r.name ?? r.NAME)
          .filter((n: any) => typeof n === "string");

        if (columnNames.length === 0) continue;
        if (this.isImplicitFkIndex(columnNames, fkColumns)) continue;

        result.push({
          name: indexName,
          column_names: columnNames,
          is_unique: isUnique,
        });
      }
      return result;
    }

    // PostgreSQL
    const rawResult = await this.queryFn(
      sql`SELECT i.relname as index_name, ix.indisunique as is_unique, a.attname as column_name, array_position(ix.indkey, a.attnum) as col_position FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_index ix ON t.oid = ix.indrelid JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey) WHERE t.relkind = 'r' AND n.nspname = ${this.schema} AND t.relname = ${table} AND NOT ix.indisprimary ORDER BY i.relname, col_position`,
    );
    const rows = this.normalizeRows(rawResult);
    return this.collapseIndexRows(
      rows.map((row: any) => ({
        name: row.index_name,
        column: row.column_name,
        unique: row.is_unique === true || row.is_unique === "t" || row.is_unique === 1,
      })),
      await this.getForeignKeyColumns(table),
    );
  }

  /**
   * Collapse per-column index rows (one row per (index, column)) into one
   * `DbIndex` per index, preserving column order and dropping indexes that
   * are merely FK-implied single-column lookups.
   */
  private collapseIndexRows(
    rows: Array<{ name: string; column: string; unique: boolean }>,
    fkColumns: Set<string>,
  ): DbIndex[] {
    const map = new Map<string, DbIndex>();
    for (const row of rows) {
      if (!row.name || !row.column) continue;
      let entry = map.get(row.name);
      if (!entry) {
        entry = { name: row.name, column_names: [], is_unique: row.unique };
        map.set(row.name, entry);
      }
      entry.column_names.push(row.column);
    }
    const result: DbIndex[] = [];
    for (const idx of map.values()) {
      if (this.isImplicitFkIndex(idx.column_names, fkColumns)) continue;
      result.push(idx);
    }
    return result;
  }

  private isImplicitFkIndex(
    columnNames: string[],
    fkColumns: Set<string>,
  ): boolean {
    return columnNames.length === 1 && fkColumns.has(columnNames[0]);
  }

  private async getForeignKeyColumns(table: string): Promise<Set<string>> {
    const fks = await this.getForeignKeys(table);
    return new Set(fks.map((fk) => fk.column_name));
  }

  /**
   * Normalize driver-specific query results to a plain array of rows.
   */
  private normalizeRows(result: any): any[] {
    if (!result) return [];
    if (Array.isArray(result)) return result;
    if (result.results && Array.isArray(result.results)) return result.results;
    if (result.rows && Array.isArray(result.rows)) return result.rows;
    return [];
  }
}
