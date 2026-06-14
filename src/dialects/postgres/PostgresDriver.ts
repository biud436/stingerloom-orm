/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { join, raw, Sql } from "sql-template-tag";
import { IConnector } from "../../core/IConnector";
import { MysqlSchemaInterface } from "../mysql/BaseSchema";
import { ColumnOption, ColumnType } from "../../decorators";
import { ISqlDriver } from "../SqlDriver";
import { Exception } from "../../errors";
import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";
import { Logger } from "../../utils";
import { SchemaOptions } from "../../types/SchemaOption";
import { SchemaGenerator } from "../../core/generators/SchemaGenerator";
import { validateSavepointName } from "../../utils/validateSavepointName";
import { PostgresColumnDefinitionBuilder } from "./PostgresColumnDefinitionBuilder";
import type { DriverQueryOptions } from "../../types/DriverQueryOptions";
import type { PostgresConnector } from "./PostgresConnector";
import { DbVersion } from "../DbVersion";
import { PostgresCapabilities } from "../DialectCapabilities";
import { resolvePostgresCapabilities } from "../resolveCapabilities";
import { UnsupportedFeatureError } from "../../errors/UnsupportedFeatureError";
import { escapeSqlLiteral } from "../../utils/escapeSqlLiteral";

// Backwards-compatible alias — now delegates to the shared helper used by
// SchemaRegistrar (#286) and SchemaGenerator (#285).
const escapeEnumValue = escapeSqlLiteral;

/**
 * SQL driver implementation for PostgreSQL.
 * Generates queries compatible with PostgreSQL's DDL/DML syntax.
 *
 * PostgreSQL has a three-level structure: database → schema → table.
 * Unlike MySQL/MariaDB, a single database can contain multiple schemas,
 * and each schema acts as an independent namespace.
 */
export class PostgresDriver implements ISqlDriver {
  private readonly schema: string;
  private readonly logger = new Logger("PostgresDriver");
  private readonly columnDefBuilder: PostgresColumnDefinitionBuilder;
  private readonly version: DbVersion;
  private readonly capabilities: PostgresCapabilities;

  constructor(
    private readonly connector: IConnector,
    private readonly clientType: string = "postgres",
    schema?: string,
    version?: DbVersion,
  ) {
    this.schema = schema ?? "public";
    this.version = version ?? connector?.getVersion?.() ?? DbVersion.UNKNOWN;
    this.capabilities = resolvePostgresCapabilities(this.version);
    this.columnDefBuilder = new PostgresColumnDefinitionBuilder(
      this.schema,
      this.capabilities,
    );
  }

  getVersion(): DbVersion {
    return this.version;
  }

  getCapabilities(): PostgresCapabilities {
    return this.capabilities;
  }

  // ──────────────────────────────────────────────
  // Schema management methods (PostgreSQL only)
  // ──────────────────────────────────────────────

  /**
   * Returns the name of the schema currently in use.
   */
  getSchema(): string {
    return this.schema;
  }

  /**
   * Checks whether the given schema exists.
   *
   * @param schemaName - name of the schema to check
   * @returns result indicating whether the schema exists
   */
  hasSchema(schemaName?: string): Promise<any> {
    const name = schemaName ?? this.schema;
    return this.connector.query(
      sql`SELECT schema_name FROM information_schema.schemata WHERE schema_name = ${name}`,
    );
  }

  /**
   * Creates a new schema.
   * Uses IF NOT EXISTS to skip creation when the schema already exists.
   *
   * @param schemaName - name of the schema to create
   */
  createSchema(schemaName?: string): Promise<any> {
    const name = schemaName ?? this.schema;
    return this.connector.query(
      `CREATE SCHEMA IF NOT EXISTS ${this.wrap(name)}`,
    );
  }

  /**
   * Drops a schema.
   * The CASCADE option also drops every object contained in the schema.
   *
   * @param schemaName - name of the schema to drop
   * @param cascade - if true, drops every object inside the schema as well (default: false)
   */
  dropSchema(schemaName: string, cascade: boolean = false): Promise<any> {
    const suffix = cascade ? " CASCADE" : "";
    return this.connector.query(
      `DROP SCHEMA IF EXISTS ${this.wrap(schemaName)}${suffix}`,
    );
  }

  /**
   * Returns every user-defined schema that exists in the database.
   * System schemas (pg_*, information_schema) are excluded.
   */
  listSchemas(): Promise<any> {
    return this.connector.query(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT LIKE 'pg_%'
         AND schema_name != 'information_schema'
       ORDER BY schema_name`,
    );
  }

  /**
   * Changes the current connection's search_path.
   *
   * @param schemaName - name of the schema to set
   */
  setSearchPath(schemaName?: string): Promise<any> {
    const name = schemaName ?? this.schema;
    return this.connector.query(`SET search_path TO ${this.wrap(name)}`);
  }

  /**
   * Returns every table in the schema.
   *
   * @param schemaName - name of the schema to query (default: current schema)
   */
  listTables(schemaName?: string): Promise<any> {
    const name = schemaName ?? this.schema;
    return this.connector.query(
      sql`SELECT tablename FROM pg_tables WHERE schemaname = ${name} ORDER BY tablename`,
    );
  }

  /**
   * Moves a table to a different schema.
   *
   * @param tableName - name of the table to move
   * @param targetSchema - name of the destination schema
   */
  moveTableToSchema(tableName: string, targetSchema: string): Promise<any> {
    return this.connector.query(
      `ALTER TABLE ${this.wrapQualified(tableName)} SET SCHEMA ${this.wrap(targetSchema)}`,
    );
  }

  /**
   * Checks whether the table exists.
   */
  hasTable(name: string) {
    return this.connector.query(
      sql`SELECT tablename FROM pg_tables WHERE schemaname = ${this.schema} AND tablename = ${name}`,
    );
  }

  executeRaw(sqlStr: string) {
    return this.connector.query(sqlStr);
  }

  async queryWithOptions(query: Sql, options: DriverQueryOptions): Promise<any[]> {
    const pgConnector = this.connector as PostgresConnector;
    if (!pgConnector.pool) {
      throw new OrmError(
        OrmErrorCode.CONNECTION_FAILED,
        "No pool available for queryWithOptions",
        "Ensure the database is connected before using the raw pipeline",
      );
    }

    let paramIndex = 0;
    const pgSql = query.sql.replace(/\?/g, () => `$${++paramIndex}`);

    const queryConfig: any = {
      text: pgSql,
      values: query.values,
    };
    if (options.binary) queryConfig.binary = true;
    if (options.arrayMode) queryConfig.rowMode = "array";

    const result: any = await pgConnector.pool.query(queryConfig);
    return result.rows;
  }

  /**
   * Adds a primary key to the table.
   */
  addPrimaryKey(tableName: string, columnName: string) {
    return this.connector.query(
      `ALTER TABLE ${this.wrapQualified(tableName)} ADD PRIMARY KEY (${this.wrap(columnName)})`,
    );
  }

  /**
   * Adds auto-increment to the table.
   * PostgreSQL 10+: GENERATED ALWAYS AS IDENTITY
   * PostgreSQL < 10: sequence + DEFAULT nextval() fallback
   */
  addAutoIncrement(tableName: string, columnName: string) {
    if (this.capabilities.supportsGeneratedIdentity) {
      return this.connector.query(
        `ALTER TABLE ${this.wrapQualified(tableName)} ALTER COLUMN ${this.wrap(columnName)} ADD GENERATED ALWAYS AS IDENTITY`,
      );
    }
    // Fallback for PG < 10: create a sequence and set DEFAULT
    const seqName = `${tableName}_${columnName}_seq`;
    return this.connector.query(
      `CREATE SEQUENCE IF NOT EXISTS ${this.wrapQualified(seqName)}; ` +
      `ALTER TABLE ${this.wrapQualified(tableName)} ALTER COLUMN ${this.wrap(columnName)} SET DEFAULT nextval('${this.schema}.${seqName}')`,
    );
  }

  /**
   * Drops the primary key from the table.
   *
   * Looks up the actual constraint name in the pg_constraint catalog and then drops it.
   * Does not rely on the default naming convention (table_pkey), so it is safe across
   * migrations and custom naming strategies.
   */
  async dropPrimaryKey(tableName: string): Promise<any> {
    const rows: Array<{ conname: string }> = await this.connector.query(
      sql`SELECT c.conname
          FROM pg_constraint c
          JOIN pg_class t      ON c.conrelid      = t.oid
          JOIN pg_namespace n  ON t.relnamespace  = n.oid
          WHERE c.contype = 'p'
            AND t.relname  = ${tableName}
            AND n.nspname  = ${this.schema}`,
    );

    if (!rows || rows.length === 0) {
      throw new Exception(
        `테이블 "${tableName}"에서 PRIMARY KEY 제약조건을 찾을 수 없습니다.`,
        404,
      );
    }

    const constraintName = rows[0].conname;
    return this.connector.query(
      `ALTER TABLE ${this.wrapQualified(tableName)} DROP CONSTRAINT ${this.wrap(constraintName)}`,
    );
  }

  /**
   * Adds a unique key to the table.
   */
  addUniqueKey(tableName: string, columnName: string) {
    return this.connector.query(
      `ALTER TABLE ${this.wrapQualified(tableName)} ADD UNIQUE (${this.wrap(columnName)})`,
    );
  }

  /**
   * Drops the unique key from the table.
   *
   * Looks up the actual name of the UNIQUE constraint covering the given column in
   * the pg_constraint catalog and then drops it. Works correctly with composite
   * UNIQUE constraints and custom naming strategies.
   */
  async dropUniqueKey(tableName: string, columnName: string): Promise<any> {
    const rows: Array<{ conname: string }> = await this.connector.query(
      sql`SELECT c.conname
          FROM pg_constraint c
          JOIN pg_class t      ON c.conrelid      = t.oid
          JOIN pg_namespace n  ON t.relnamespace  = n.oid
          JOIN pg_attribute a  ON a.attrelid = t.oid
                              AND a.attnum   = ANY(c.conkey)
          WHERE c.contype = 'u'
            AND t.relname  = ${tableName}
            AND n.nspname  = ${this.schema}
            AND a.attname  = ${columnName}`,
    );

    if (!rows || rows.length === 0) {
      throw new Exception(
        `테이블 "${tableName}"의 컬럼 "${columnName}"에 대한 UNIQUE 제약조건을 찾을 수 없습니다.`,
        404,
      );
    }

    const constraintName = rows[0].conname;
    return this.connector.query(
      `ALTER TABLE ${this.wrapQualified(tableName)} DROP CONSTRAINT ${this.wrap(constraintName)}`,
    );
  }

  /**
   * Adds a column to the table.
   */
  addColumn(tableName: string, columnName: string, columnType: string) {
    return this.connector.query(
      `ALTER TABLE ${this.wrapQualified(tableName)} ADD COLUMN ${this.wrap(columnName)} ${columnType}`,
    );
  }

  /**
   * Drops a column from the table.
   */
  dropColumn(tableName: string, columnName: string) {
    return this.connector.query(
      `ALTER TABLE ${this.wrapQualified(tableName)} DROP COLUMN ${this.wrap(columnName)}`,
    );
  }

  /**
   * Adds a foreign key.
   */
  addForeignKey(
    tableName: string,
    columnName: string,
    foreignTableName: string,
    foreignColumnName: string,
  ) {
    const foreignKeyName = this.generateForeignKeyName(
      tableName,
      foreignTableName,
      columnName,
    );

    return this.connector.query(
      `ALTER TABLE ${this.wrapQualified(tableName)} ADD CONSTRAINT ${foreignKeyName} FOREIGN KEY (${this.wrap(columnName)}) REFERENCES ${this.wrapQualified(foreignTableName)}(${this.wrap(foreignColumnName)}) ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  /**
   * Generates a foreign key name.
   * Produces a unique name based on a SHA1 hash to avoid name collisions and length limits.
   */
  generateForeignKeyName(
    sourceTable: string,
    targetTable: string,
    sourceColumn: string,
  ): string {
    return SchemaGenerator.generateForeignKeyName(sourceTable, sourceColumn, targetTable);
  }

  /**
   * Drops a foreign key.
   *
   * Looks up the actual name of the FOREIGN KEY constraint referencing the given column in
   * the pg_constraint catalog and then drops it. Because the FK constraint name is not the
   * column name, the catalog lookup is required.
   */
  async dropForeignKey(tableName: string, columnName: string): Promise<any> {
    const rows: Array<{ conname: string }> = await this.connector.query(
      sql`SELECT c.conname
          FROM pg_constraint c
          JOIN pg_class t      ON c.conrelid      = t.oid
          JOIN pg_namespace n  ON t.relnamespace  = n.oid
          JOIN pg_attribute a  ON a.attrelid = t.oid
                              AND a.attnum   = ANY(c.conkey)
          WHERE c.contype = 'f'
            AND t.relname  = ${tableName}
            AND n.nspname  = ${this.schema}
            AND a.attname  = ${columnName}`,
    );

    if (!rows || rows.length === 0) {
      throw new Exception(
        `테이블 "${tableName}"의 컬럼 "${columnName}"에 대한 FOREIGN KEY 제약조건을 찾을 수 없습니다.`,
        404,
      );
    }

    const constraintName = rows[0].conname;
    return this.connector.query(
      `ALTER TABLE ${this.wrapQualified(tableName)} DROP CONSTRAINT ${this.wrap(constraintName)}`,
    );
  }

  /**
   * Adds an index.
   */
  addIndex(tableName: string, columnName: string, indexName: string) {
    return this.connector.query(
      `CREATE INDEX ${this.wrap(indexName)} ON ${this.wrapQualified(tableName)} (${this.wrap(columnName)})`,
    );
  }

  /**
   * Checks whether the index exists.
   */
  hasIndex(tableName: string, indexName: string) {
    return this.connector.query(
      sql`SELECT COUNT(*) as count FROM pg_indexes WHERE tablename = ${tableName} AND indexname = ${indexName}`,
    );
  }

  /**
   * Drops an index.
   */
  dropIndex(tableName: string, indexName: string) {
    // PostgreSQL indexes belong to a schema, so use the schema-qualified form.
    return this.connector.query(
      `DROP INDEX IF EXISTS ${this.wrapQualified(indexName)}`,
    );
  }

  // ──────────────────────────────────────────────
  // Enum type management methods (PostgreSQL only)
  // ──────────────────────────────────────────────

  /**
   * Checks whether a user-defined ENUM type exists.
   *
   * @param enumName - name of the ENUM type to check
   */
  hasEnumType(enumName: string): Promise<any> {
    // Restrict the lookup to the current schema by joining pg_namespace.
    return this.connector.query(
      sql`SELECT pg_type.typname
          FROM pg_type
          JOIN pg_namespace ON pg_type.typnamespace = pg_namespace.oid
          WHERE pg_type.typname = ${enumName}
            AND pg_type.typtype = 'e'
            AND pg_namespace.nspname = ${this.schema}`,
    );
  }

  /**
   * Creates a new user-defined ENUM type.
   * Skips creation when the type already exists.
   *
   * @param enumName - name of the ENUM type to create
   * @param values   - list of values that belong to the ENUM
   *
   * @example
   * await driver.createEnumType("user_role", ["admin", "user", "guest"]);
   * // → CREATE TYPE "user_role" AS ENUM ('admin', 'user', 'guest')
   */
  async createEnumType(enumName: string, values: string[]): Promise<any> {
    const rows: any[] = await this.hasEnumType(enumName);
    if (rows && rows.length > 0) {
      // Enum already exists — check for missing values and add them
      const existingRows: any[] = await this.connector.query(
        sql`SELECT e.enumlabel
            FROM pg_enum e
            JOIN pg_type t ON e.enumtypid = t.oid
            JOIN pg_namespace n ON t.typnamespace = n.oid
            WHERE t.typname = ${enumName}
              AND n.nspname = ${this.schema}`,
      );
      const existingValues = new Set(existingRows.map((r) => r.enumlabel));

      for (const val of values) {
        if (!existingValues.has(val)) {
          const escaped = escapeEnumValue(val);
          await this.connector.query(
            `ALTER TYPE ${this.wrapQualified(enumName)} ADD VALUE IF NOT EXISTS '${escaped}'`,
          );
        }
      }

      // Warn about values in DB but not in entity definition
      for (const existing of existingValues) {
        if (!values.includes(existing)) {
          this.logger.warn(
            `Enum "${enumName}" has DB value "${existing}" not present in entity definition`,
          );
        }
      }

      return;
    }

    const escapedValues = values
      .map((v) => `'${escapeEnumValue(v)}'`)
      .join(", ");

    return this.connector.query(
      `CREATE TYPE ${this.wrapQualified(enumName)} AS ENUM (${escapedValues})`,
    );
  }

  /**
   * Drops a user-defined ENUM type.
   *
   * @param enumName - name of the ENUM type to drop
   * @param cascade  - if true, also drops any columns that reference the ENUM type (default: false)
   */
  dropEnumType(enumName: string, cascade: boolean = false): Promise<any> {
    const suffix = cascade ? " CASCADE" : "";
    return this.connector.query(
      `DROP TYPE IF EXISTS ${this.wrapQualified(enumName)}${suffix}`,
    );
  }

  /**
   * Adds a new value to an existing ENUM type.
   * Supported on PostgreSQL 9.1 and later.
   *
   * @param enumName  - target ENUM type name
   * @param value     - value to add
   * @param placement - optional placement option
   *
   * @example
   * // Append at the end
   * await driver.addEnumValue("user_role", "moderator");
   *
   * // Insert before a specific value
   * await driver.addEnumValue("user_role", "moderator", { before: "guest" });
   *
   * // Insert after a specific value
   * await driver.addEnumValue("user_role", "moderator", { after: "user" });
   */
  addEnumValue(
    enumName: string,
    value: string,
    placement?: { before?: string; after?: string },
  ): Promise<any> {
    const escaped = `'${escapeEnumValue(value)}'`;
    let suffix = "";

    if (placement?.before) {
      suffix = ` BEFORE '${escapeEnumValue(placement.before)}'`;
    } else if (placement?.after) {
      suffix = ` AFTER '${escapeEnumValue(placement.after)}'`;
    }

    return this.connector.query(
      `ALTER TYPE ${this.wrapQualified(enumName)} ADD VALUE IF NOT EXISTS ${escaped}${suffix}`,
    );
  }

  /**
   * Renames an existing value of an ENUM type.
   * Supported on PostgreSQL 10 and later.
   *
   * @param enumName - target ENUM type name
   * @param oldValue - current value to rename
   * @param newValue - new value
   */
  renameEnumValue(
    enumName: string,
    oldValue: string,
    newValue: string,
  ): Promise<any> {
    if (!this.capabilities.supportsRenameEnumValue) {
      throw new UnsupportedFeatureError(
        "ALTER TYPE RENAME VALUE",
        "PostgreSQL 10+",
        this.version.toString(),
      );
    }
    return this.connector.query(
      `ALTER TYPE ${this.wrapQualified(enumName)} RENAME VALUE '${escapeEnumValue(oldValue)}' TO '${escapeEnumValue(newValue)}'`,
    );
  }

  /**
   * Returns every value that belongs to an ENUM type.
   *
   * @param enumName - name of the ENUM type to query
   * @returns array of `{ enumlabel: string }`
   */
  listEnumValues(enumName: string): Promise<{ enumlabel: string }[]> {
    return this.connector.query(
      sql`SELECT e.enumlabel
       FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = ${enumName}
       ORDER BY e.enumsortorder`,
    );
  }

  /**
   * Retrieves the schema (based on information_schema).
   * Returns a MySQL-compatible shape (MysqlSchemaInterface).
   */
  getSchemas(tableName: string): Promise<MysqlSchemaInterface[]> {
    return this.connector.query(
      sql`SELECT
        column_name AS "Field",
        data_type AS "Type",
        is_nullable AS "Null",
        CASE
          WHEN column_name IN (
            SELECT kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
            WHERE tc.table_name = ${tableName} AND tc.constraint_type = 'PRIMARY KEY'
          ) THEN 'PRI'
          ELSE ''
        END AS "Key",
        column_default AS "Default",
        CASE
          WHEN column_default LIKE 'nextval%' THEN 'auto_increment'
          ELSE ''
        END AS "Extra"
      FROM information_schema.columns
      WHERE table_schema = ${this.schema} AND table_name = ${tableName}
      ORDER BY ordinal_position`,
    );
  }

  /**
   * Retrieves the indexes.
   */
  getIndexes(tableName: string): Promise<MysqlSchemaInterface[]> {
    return this.connector.query(
      sql`SELECT indexname AS "Field", indexdef AS "Type", '' AS "Null", 'MUL' AS "Key", NULL AS "Default", '' AS "Extra"
       FROM pg_indexes WHERE schemaname = ${this.schema} AND tablename = ${tableName}`,
    );
  }

  /**
   * Retrieves the foreign keys.
   */
  getForeignKeys(tableName: string): Promise<MysqlSchemaInterface[]> {
    return this.connector.query(
      sql`SELECT
        kcu.column_name AS "COLUMN_NAME",
        ccu.table_name AS "REFERENCED_TABLE_NAME",
        ccu.column_name AS "REFERENCED_COLUMN_NAME"
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = ${this.schema}
        AND tc.table_name = ${tableName}`,
    );
  }

  /**
   * Retrieves the primary keys.
   */
  getPrimaryKeys(tableName: string): Promise<MysqlSchemaInterface[]> {
    return this.connector.query(
      sql`SELECT kcu.column_name AS "COLUMN_NAME"
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
       WHERE tc.constraint_type = 'PRIMARY KEY'
         AND tc.table_schema = ${this.schema}
         AND tc.table_name = ${tableName}`,
    );
  }

  /**
   * Creates the table.
   */
  createTable(tableName: string, columns: SchemaOptions[]) {
    const pkColumns = columns.filter(
      (c) => (c.options as ColumnOption | undefined)?.primary,
    );
    const isCompositePk = pkColumns.length > 1;

    const columnsMap = columns.map((column) => {
      const option = (column.options ?? this.columnDefBuilder.defaultColumnOption) as ColumnOption;
      return raw(
        this.columnDefBuilder.buildColumnDef(option, {
          columnName: column.name!,
          tableName,
          isCompositePk,
        }),
      );
    });

    if (isCompositePk) {
      const pkList = pkColumns.map((c) => this.wrap(c.name!)).join(", ");
      columnsMap.push(raw(`PRIMARY KEY (${pkList})`));
    }

    const result = sql`CREATE TABLE IF NOT EXISTS ${raw(this.wrapQualified(tableName))} (${join(
      columnsMap,
      ",",
    )})`;

    return this.connector.query(result);
  }

  /**
   * Wraps the identifier in double quotes and returns it (PostgreSQL standard).
   * Any embedded `"` character is escaped as `""`, following the PostgreSQL standard.
   */
  wrap(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  /**
   * Returns the identifier in `"schema"."name"` form.
   * The schema is always specified explicitly instead of relying on search_path,
   * making it safe with connection pool reuse and multi-tenant setups.
   */
  wrapQualified(name: string): string {
    return `${this.wrap(this.schema)}.${this.wrap(name)}`;
  }

  /**
   * Infers the database column type from the TypeScript type.
   */
  getColumnType(type: any): string {
    switch (type) {
      case String:
        return "VARCHAR";
      case Number:
        return "INTEGER";
      case Boolean:
        return "BOOLEAN";
      case Date:
        return "TIMESTAMP";
      case Buffer:
        return "BYTEA";
      default:
        return "TEXT";
    }
  }

  /**
   * Converts a ColumnType to the corresponding database column type.
   *
   * ## PostgreSQL type mapping
   * | ColumnType | PostgreSQL Type                |
   * |------------|--------------------------------|
   * | varchar    | VARCHAR                        |
   * | int        | INTEGER                        |
   * | number     | INTEGER                        |
   * | boolean    | BOOLEAN (native)               |
   * | datetime   | TIMESTAMP                      |
   * | date       | DATE                           |
   * | timestamp  | TIMESTAMP                      |
   * | float      | REAL                           |
   * | double     | NUMERIC(precision, scale)      |
   * | blob       | BYTEA                          |
   * | text       | TEXT                           |
   * | longtext   | TEXT                           |
   * | bigint     | BIGINT                         |
   * | json       | JSON                           |
   * | jsonb      | JSONB                          |
   * | array      | ARRAY                          |
   * | enum       | user-defined ENUM type         |
   *              | (enumName option → `"enumName"`) |
   *              | fallback → TEXT when enumName is missing |
   */
  castType(type: ColumnType): string {
    return this.columnDefBuilder.castType(type);
  }

  public isMySqlFamily() {
    return false;
  }

  setQueryTimeout(ms: number): string {
    return `SET LOCAL statement_timeout = '${Math.max(0, Math.floor(ms))}ms'`;
  }

  supportsExplain(): boolean {
    return true;
  }

  buildExplainSql(selectSql: string): string {
    return `EXPLAIN (FORMAT JSON) ${selectSql}`;
  }

  buildUpsertSql(
    tableName: string,
    columns: string[],
    conflictColumns: string[],
    updateColumns: string[],
  ): string {
    const columnList = columns.map((c) => this.wrap(c)).join(", ");
    const valuePlaceholders = columns
      .map((_, i) => `$${i + 1}`)
      .join(", ");
    const conflictList = conflictColumns.map((c) => this.wrap(c)).join(", ");
    const updateSet = updateColumns
      .map((col) => `${this.wrap(col)} = EXCLUDED.${this.wrap(col)}`)
      .join(", ");

    return `INSERT INTO ${this.wrap(tableName)} (${columnList}) VALUES (${valuePlaceholders}) ON CONFLICT (${conflictList}) DO UPDATE SET ${updateSet}`;
  }

  async hasColumn(tableName: string, columnName: string): Promise<boolean> {
    const rows: any[] = await this.connector.query(
      sql`SELECT column_name FROM information_schema.columns WHERE table_schema = ${this.schema} AND table_name = ${tableName} AND column_name = ${columnName}`,
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  async hasForeignKey(tableName: string, constraintName: string): Promise<boolean> {
    const rows: any[] = await this.connector.query(
      sql`SELECT constraint_name FROM information_schema.table_constraints WHERE table_schema = ${this.schema} AND table_name = ${tableName} AND constraint_name = ${constraintName} AND constraint_type = 'FOREIGN KEY'`,
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  addCompositeUniqueIndex(
    tableName: string,
    columns: string[],
    indexName: string,
  ) {
    const columnList = columns.map((col) => this.wrap(col)).join(", ");
    return this.connector.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${this.wrap(indexName)} ON ${this.wrapQualified(tableName)} (${columnList})`,
    );
  }

  async acquireAdvisoryLock(lockId: string, timeoutMs: number = 0): Promise<boolean> {
    // Convert string lockId to a numeric hash for pg_advisory_lock
    const hash = this.hashLockId(lockId);

    if (timeoutMs <= 0) {
      // Try to acquire without waiting
      const result: any = await this.connector.query(
        sql`SELECT pg_try_advisory_lock(${hash}) AS lock_result`,
      );
      const rows = Array.isArray(result) ? result : result?.rows ?? [];
      if (rows.length === 0) return false;
      return rows[0]?.lock_result === true;
    }

    // Use a single dedicated connection so SET and the lock query share the same session
    const client = await this.connector.getConnection();
    try {
      const savedTimeout = await this.connector.query(
        `SHOW statement_timeout`,
        client,
      );

      // PostgreSQL does not accept bind parameters in SET, so the timeout must
      // be interpolated as a literal (mirrors setQueryTimeout()).
      const timeoutValue = `${Math.max(0, Math.floor(timeoutMs))}ms`;
      await this.connector.query(
        `SET statement_timeout = '${timeoutValue}'`,
        client,
      );

      try {
        await this.connector.query(
          sql`SELECT pg_advisory_lock(${hash})`,
          client,
        );
        return true;
      } catch {
        return false;
      } finally {
        // Restore original timeout on the same connection. The value comes from
        // SHOW statement_timeout (Postgres-controlled), but escape quotes
        // defensively before interpolating it as a literal.
        const rows = Array.isArray(savedTimeout) ? savedTimeout : savedTimeout?.rows ?? [];
        const original = String(
          rows.length > 0 ? rows[0]?.statement_timeout ?? "0" : "0",
        ).replace(/'/g, "''");
        await this.connector.query(
          `SET statement_timeout = '${original}'`,
          client,
        );
      }
    } finally {
      client.release();
    }
  }

  async releaseAdvisoryLock(lockId: string): Promise<void> {
    const hash = this.hashLockId(lockId);
    await this.connector.query(
      sql`SELECT pg_advisory_unlock(${hash})`,
    );
  }

  private hashLockId(lockId: string): number {
    let hash = 0;
    for (let i = 0; i < lockId.length; i++) {
      const char = lockId.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return hash;
  }

  createSavepointSql(name: string): string {
    validateSavepointName(name);
    return `SAVEPOINT ${this.wrap(name)}`;
  }

  rollbackToSavepointSql(name: string): string {
    validateSavepointName(name);
    return `ROLLBACK TO SAVEPOINT ${this.wrap(name)}`;
  }

  releaseSavepointSql(name: string): string {
    validateSavepointName(name);
    return `RELEASE SAVEPOINT ${this.wrap(name)}`;
  }

  /**
   * Removes all data from the table (TRUNCATE ... RESTART IDENTITY CASCADE).
   * CASCADE: also truncates tables that reference this one via FKs.
   * RESTART IDENTITY: resets sequences.
   */
  clear(tableName: string) {
    return this.connector.query(
      `TRUNCATE TABLE ${this.wrapQualified(tableName)} RESTART IDENTITY CASCADE`,
    );
  }

  /**
   * Returns the SQL fragment for pessimistic locking.
   *
   * PostgreSQL supports FOR UPDATE NOWAIT.
   */
  getForUpdateNoWait(): string {
    return " FOR UPDATE NOWAIT";
  }

  supportsReturning(): boolean {
    return true;
  }

  supportsInsertReturning(): boolean {
    return true;
  }
}
