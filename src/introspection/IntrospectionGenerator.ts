/* eslint-disable @typescript-eslint/no-explicit-any */
import sql from "sql-template-tag";
import { IntrospectionDialect } from "./TypeMapper";
import {
  DbColumn,
  DbForeignKey,
  EntityCodeBuilder,
  EntityCodeBuilderOptions,
} from "./EntityCodeBuilder";

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

      const className = this.codeBuilder.tableNameToClassName(table);
      const code = this.codeBuilder.build(table, columns, pks, fks, this.dialect);
      const fileName = this.classNameToFileName(className);

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
    } else {
      rawResult = await this.queryFn(
        sql`SELECT tablename as table_name FROM pg_tables WHERE schemaname = ${this.schema} ORDER BY tablename`,
      );
    }

    const rows = this.normalizeRows(rawResult);
    return rows.map((row: any) => row.table_name ?? row.TABLE_NAME ?? row.tablename);
  }

  /**
   * Get column metadata for a specific table.
   */
  async getColumns(table: string): Promise<DbColumn[]> {
    let rawResult: any;

    if (this.dialect === "mysql") {
      rawResult = await this.queryFn(
        sql`SELECT COLUMN_NAME as column_name, DATA_TYPE as data_type, IS_NULLABLE as is_nullable, CHARACTER_MAXIMUM_LENGTH as character_maximum_length, NUMERIC_PRECISION as numeric_precision, NUMERIC_SCALE as numeric_scale, COLUMN_DEFAULT as column_default, EXTRA as extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table} ORDER BY ORDINAL_POSITION`,
      );
    } else {
      rawResult = await this.queryFn(
        sql`SELECT column_name, data_type, is_nullable, character_maximum_length, numeric_precision, numeric_scale, column_default FROM information_schema.columns WHERE table_schema = ${this.schema} AND table_name = ${table} ORDER BY ordinal_position`,
      );
    }

    return this.normalizeRows(rawResult);
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
   * Convert PascalCase class name to kebab-case file name.
   * e.g. "UserProfile" -> "user-profile.entity.ts"
   */
  private classNameToFileName(className: string): string {
    const kebab = className
      .replace(/([a-z])([A-Z])/g, "$1-$2")
      .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
      .toLowerCase();
    return `${kebab}.entity.ts`;
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
