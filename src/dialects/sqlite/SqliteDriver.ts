/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { join, raw, Sql } from "../../utils/sqlTag";
import { IConnector } from "../../core/IConnector";
import { MysqlSchemaInterface } from "../mysql/BaseSchema";
import { ColumnOption, ColumnType } from "../../decorators";
import { ISqlDriver, CreateTableForeignKey } from "../SqlDriver";
import type { ComputedColumnMetadata } from "../../decorators/ComputedColumn";
import { VALID_REFERENTIAL_ACTIONS } from "../../types/ReferentialAction";
import { SchemaOptions } from "../../types/SchemaOption";
import { SchemaGenerator } from "../../core/generators/SchemaGenerator";
import { validateSavepointName } from "../../utils/validateSavepointName";
import { Logger } from "../../utils/Logger";
import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";
import { SqliteColumnDefinitionBuilder } from "./SqliteColumnDefinitionBuilder";
import type { DriverQueryOptions } from "../../types/DriverQueryOptions";
import type { SqliteConnector } from "./SqliteConnector";
import { DbVersion } from "../DbVersion";
import { SqliteCapabilities } from "../DialectCapabilities";
import { resolveSqliteCapabilities } from "../resolveCapabilities";
import { UnsupportedFeatureError } from "../../errors/UnsupportedFeatureError";

/**
 * SQL driver implementation for SQLite.
 * Generates queries compatible with SQLite's DDL/DML syntax.
 *
 * SQLite has no schema concept and is a single-file database.
 * Identifier wrapping uses double quotes, matching PostgreSQL.
 */
export class SqliteDriver implements ISqlDriver {
  private readonly logger = new Logger("SqliteDriver");
  private readonly columnDefBuilder: SqliteColumnDefinitionBuilder;
  private readonly version: DbVersion;
  private readonly capabilities: SqliteCapabilities;

  constructor(
    private readonly connector: IConnector,
    version?: DbVersion,
  ) {
    this.version = version ?? connector?.getVersion?.() ?? DbVersion.UNKNOWN;
    this.capabilities = resolveSqliteCapabilities(this.version);
    this.columnDefBuilder = new SqliteColumnDefinitionBuilder(this.capabilities);
  }

  getVersion(): DbVersion {
    return this.version;
  }

  getCapabilities(): SqliteCapabilities {
    return this.capabilities;
  }

  /**
   * Checks whether the table exists.
   */
  hasTable(name: string) {
    return this.connector.query(
      sql`SELECT name FROM sqlite_master WHERE type='table' AND name=${name}`,
    );
  }

  executeRaw(sqlStr: string) {
    return this.connector.query(sqlStr);
  }

  async queryWithOptions(query: Sql, options: DriverQueryOptions): Promise<any[]> {
    const sqliteConnector = this.connector as SqliteConnector;
    const db = await sqliteConnector.getConnection();

    const sanitized = this.sanitizeValuesForOptions(query.values);
    const stmt = db.prepare(query.sql);

    if (options.arrayMode) {
      stmt.raw(true);
    }

    // better-sqlite3 throws if stmt.all() is called on a non-row-returning
    // statement (e.g. CTE-prefixed UPDATE/DELETE without RETURNING). Branch
    // on stmt.reader so writes route to stmt.run() (#287).
    if (!stmt.reader) {
      const result =
        sanitized && sanitized.length > 0
          ? stmt.run(...sanitized)
          : stmt.run();
      return [result] as any;
    }

    return sanitized && sanitized.length > 0
      ? stmt.all(...sanitized)
      : stmt.all();
  }

  private sanitizeValuesForOptions(values?: any[]): any[] | undefined {
    if (!values) return values;
    return values.map((v) => {
      if (typeof v === "boolean") return v ? 1 : 0;
      if (v instanceof Date) return v.toISOString();
      if (v === undefined) return null;
      return v;
    });
  }

  /**
   * Adds a primary key to the table.
   * SQLite does not support adding a primary key via ALTER TABLE.
   * The table must be recreated; an error is thrown here for interface compatibility.
   */
  addPrimaryKey(_tableName: string, _columnName: string): Promise<any> {
    throw new OrmError(
      OrmErrorCode.UNSUPPORTED_OPERATION,
      `SQLite does not support ALTER TABLE ADD PRIMARY KEY. Recreate the table instead.`,
    );
  }

  /**
   * Adds auto-increment to the table.
   * In SQLite, INTEGER PRIMARY KEY automatically acts as AUTOINCREMENT.
   */
  addAutoIncrement(_tableName: string, _columnName: string): Promise<any> {
    throw new OrmError(
      OrmErrorCode.UNSUPPORTED_OPERATION,
      `SQLite does not support ALTER TABLE ADD AUTOINCREMENT. Recreate the table instead.`,
    );
  }

  /**
   * Drops the primary key from the table.
   * SQLite does not support dropping a primary key via ALTER TABLE.
   */
  dropPrimaryKey(_tableName: string): Promise<any> {
    throw new OrmError(
      OrmErrorCode.UNSUPPORTED_OPERATION,
      `SQLite does not support ALTER TABLE DROP PRIMARY KEY. Recreate the table instead.`,
    );
  }

  /**
   * Adds a unique key to the table.
   */
  addUniqueKey(tableName: string, columnName: string) {
    const indexName = `uq_${tableName}_${columnName}`;
    return this.connector.query(
      `CREATE UNIQUE INDEX ${this.wrap(indexName)} ON ${this.wrap(tableName)} (${this.wrap(columnName)})`,
    );
  }

  /**
   * Drops the unique key from the table.
   */
  dropUniqueKey(tableName: string, columnName: string) {
    const indexName = `uq_${tableName}_${columnName}`;
    return this.connector.query(
      `DROP INDEX IF EXISTS ${this.wrap(indexName)}`,
    );
  }

  /**
   * Adds a column to the table.
   */
  addColumn(tableName: string, columnName: string, columnType: string) {
    return this.connector.query(
      `ALTER TABLE ${this.wrap(tableName)} ADD COLUMN ${this.wrap(columnName)} ${columnType}`,
    );
  }

  /**
   * Drops a column from the table.
   * DROP COLUMN is supported on SQLite 3.35.0+.
   */
  dropColumn(tableName: string, columnName: string) {
    if (!this.capabilities.supportsDropColumn) {
      throw new UnsupportedFeatureError(
        "ALTER TABLE DROP COLUMN",
        "SQLite 3.35.0+",
        this.version.toString(),
      );
    }
    return this.connector.query(
      `ALTER TABLE ${this.wrap(tableName)} DROP COLUMN ${this.wrap(columnName)}`,
    );
  }

  /**
   * Adds a foreign key.
   * SQLite does not support adding a foreign key via ALTER TABLE.
   * Foreign keys must be declared in the FOREIGN KEY clause when the table is created.
   */
  addForeignKey(
    _tableName: string,
    _columnName: string,
    _foreignTableName: string,
    _foreignColumnName: string,
    _constraintName?: string,
  ): Promise<any> {
    throw new OrmError(
      OrmErrorCode.UNSUPPORTED_OPERATION,
      `SQLite does not support ALTER TABLE ADD FOREIGN KEY. Define foreign keys at table creation time instead.`,
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
   */
  dropForeignKey(_tableName: string, _columnName: string): Promise<any> {
    throw new OrmError(
      OrmErrorCode.UNSUPPORTED_OPERATION,
      `SQLite does not support ALTER TABLE DROP FOREIGN KEY. Recreate the table instead.`,
    );
  }

  /**
   * Adds an index.
   */
  addIndex(tableName: string, columnName: string, indexName: string) {
    return this.connector.query(
      `CREATE INDEX ${this.wrap(indexName)} ON ${this.wrap(tableName)} (${this.wrap(columnName)})`,
    );
  }

  /**
   * Checks whether the index exists.
   */
  hasIndex(tableName: string, indexName: string) {
    return this.connector.query(
      sql`SELECT COUNT(*) as count FROM sqlite_master WHERE type='index' AND tbl_name=${tableName} AND name=${indexName}`,
    );
  }

  /**
   * Drops an index.
   */
  dropIndex(tableName: string, indexName: string) {
    return this.connector.query(
      `DROP INDEX IF EXISTS ${this.wrap(indexName)}`,
    );
  }

  /**
   * Retrieves the schema (based on PRAGMA table_info).
   * Returns a MySQL-compatible shape (MysqlSchemaInterface).
   */
  getSchemas(tableName: string): Promise<MysqlSchemaInterface[]> {
    return this.connector.query(
      `PRAGMA table_info(${this.wrap(tableName)})`,
    );
  }

  /**
   * Retrieves the indexes.
   */
  getIndexes(tableName: string): Promise<MysqlSchemaInterface[]> {
    return this.connector.query(
      `PRAGMA index_list(${this.wrap(tableName)})`,
    );
  }

  /**
   * Retrieves the foreign keys.
   */
  getForeignKeys(tableName: string): Promise<MysqlSchemaInterface[]> {
    return this.connector.query(
      `PRAGMA foreign_key_list(${this.wrap(tableName)})`,
    );
  }

  /**
   * Retrieves the primary keys.
   */
  getPrimaryKeys(tableName: string): Promise<MysqlSchemaInterface[]> {
    return this.connector.query(
      `PRAGMA table_info(${this.wrap(tableName)})`,
    );
  }

  /**
   * Creates the table.
   */
  createTable(
    tableName: string,
    columns: SchemaOptions[],
    foreignKeys?: CreateTableForeignKey[],
    computedColumns?: ComputedColumnMetadata[],
  ) {
    const pkColumns = columns.filter(
      (c) => (c.options as ColumnOption | undefined)?.primary,
    );
    const isCompositePk = pkColumns.length > 1;

    const columnsMap = columns.map((column) => {
      const option = (column.options ?? this.columnDefBuilder.defaultColumnOption) as ColumnOption;
      return raw(
        this.columnDefBuilder.buildColumnDef(option, {
          columnName: column.name,
          tableName,
          isCompositePk,
        }),
      );
    });

    for (const cc of computedColumns ?? []) {
      columnsMap.push(
        raw(
          this.columnDefBuilder.buildComputedColumnDef(cc, {
            columnName: cc.name,
            tableName,
          }),
        ),
      );
    }

    if (isCompositePk) {
      const pkList = pkColumns.map((c) => this.wrap(c.name)).join(", ");
      columnsMap.push(raw(`PRIMARY KEY (${pkList})`));
    }

    // SQLite cannot ALTER TABLE ADD FOREIGN KEY, so FK constraints must be
    // part of the CREATE TABLE statement. Referencing a table that is created
    // later in the same sync pass is fine — SQLite resolves parent tables at
    // DML time, not at CREATE time.
    for (const fk of foreignKeys ?? []) {
      columnsMap.push(raw(this.buildForeignKeyClause(fk)));
    }

    const result = sql`CREATE TABLE IF NOT EXISTS ${raw(this.wrap(tableName))} (${join(
      columnsMap,
      ",",
    )})`;

    return this.connector.query(result.text);
  }

  /**
   * Builds an inline `FOREIGN KEY (...) REFERENCES ...` clause.
   * Identifiers are wrapped; referential actions are validated against the
   * ReferentialAction whitelist before being interpolated.
   */
  private buildForeignKeyClause(fk: CreateTableForeignKey): string {
    let clause = "";
    if (fk.constraintName) {
      clause += `CONSTRAINT ${this.wrap(fk.constraintName)} `;
    }
    clause += `FOREIGN KEY (${this.wrap(fk.columnName)}) REFERENCES ${this.wrap(
      fk.referencedTable,
    )} (${this.wrap(fk.referencedColumn)})`;
    if (fk.onDelete && VALID_REFERENTIAL_ACTIONS.includes(fk.onDelete)) {
      clause += ` ON DELETE ${fk.onDelete}`;
    }
    if (fk.onUpdate && VALID_REFERENTIAL_ACTIONS.includes(fk.onUpdate)) {
      clause += ` ON UPDATE ${fk.onUpdate}`;
    }
    return clause;
  }

  /**
   * Wraps the identifier in double quotes and returns it (SQLite standard).
   * Any embedded `"` character is escaped as `""`.
   */
  wrap(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  /**
   * ISqlDriver entry point for identifier quoting (see `wrap`).
   */
  escapeIdentifier(name: string): string {
    return this.wrap(name);
  }

  /**
   * SQLite has no schema concept, so this simply calls wrap().
   */
  wrapQualified(name: string): string {
    return this.wrap(name);
  }

  /**
   * Infers the database column type from the TypeScript type.
   */
  getColumnType(type: any): string {
    switch (type) {
      case String:
        return "TEXT";
      case Number:
        return "INTEGER";
      case Boolean:
        return "INTEGER";
      case Date:
        return "TEXT";
      case Buffer:
        return "BLOB";
      default:
        return "TEXT";
    }
  }

  /**
   * Converts a ColumnType to the corresponding SQLite column type.
   *
   * ## SQLite type mapping
   * SQLite has five storage classes: NULL, INTEGER, REAL, TEXT, BLOB.
   * The appropriate type is returned following SQLite's type affinity rules.
   *
   * | ColumnType | SQLite Type  |
   * |------------|--------------|
   * | varchar    | TEXT         |
   * | int        | INTEGER      |
   * | number     | INTEGER      |
   * | boolean    | INTEGER      |
   * | datetime   | TEXT         |
   * | date       | TEXT         |
   * | timestamp  | TEXT         |
   * | float      | REAL         |
   * | double     | REAL         |
   * | blob       | BLOB         |
   * | text       | TEXT         |
   * | longtext   | TEXT         |
   * | bigint     | INTEGER      |
   * | json       | TEXT         |
   * | jsonb      | TEXT         |
   * | char       | TEXT         |
   * | enum       | TEXT         |
   * | array      | TEXT         |
   */
  castType(type: ColumnType): string {
    return this.columnDefBuilder.castType(type);
  }

  public isMySqlFamily() {
    return false;
  }

  setQueryTimeout(ms: number): string {
    return `PRAGMA busy_timeout = ${Math.max(0, Math.floor(ms))}`;
  }

  supportsExplain(): boolean {
    return true;
  }

  buildExplainSql(selectSql: string): string {
    return `EXPLAIN QUERY PLAN ${selectSql}`;
  }

  buildUpsertSql(
    tableName: string,
    columns: string[],
    conflictColumns: string[],
    updateColumns: string[],
  ): string {
    if (!this.capabilities.supportsUpsert) {
      throw new UnsupportedFeatureError(
        "INSERT ... ON CONFLICT (upsert)",
        "SQLite 3.24.0+",
        this.version.toString(),
      );
    }
    const columnList = columns.map((c) => this.wrap(c)).join(", ");
    const valuePlaceholders = columns.map(() => "?").join(", ");
    const conflictList = conflictColumns.map((c) => this.wrap(c)).join(", ");
    const updateSet = updateColumns
      .map((col) => `${this.wrap(col)} = excluded.${this.wrap(col)}`)
      .join(", ");

    return `INSERT INTO ${this.wrap(tableName)} (${columnList}) VALUES (${valuePlaceholders}) ON CONFLICT (${conflictList}) DO UPDATE SET ${updateSet}`;
  }

  async hasColumn(tableName: string, columnName: string): Promise<boolean> {
    // table_xinfo, not table_info: generated columns are hidden from
    // table_info (hidden=2 VIRTUAL / hidden=3 STORED rows only appear in the
    // extended pragma), and hasColumn must see them.
    const rows: any[] = await this.connector.query(
      `PRAGMA table_xinfo(${this.wrap(tableName)})`,
    );
    if (!Array.isArray(rows)) return false;
    return rows.some(
      (r: any) => (r.name ?? "").toLowerCase() === columnName.toLowerCase(),
    );
  }

  async hasForeignKey(tableName: string, constraintName: string): Promise<boolean> {
    // SQLite does not support named FK constraints; always return false to allow idempotent re-creation attempts
    // SQLite ignores duplicate FK declarations without error, so this is safe.
    return false;
  }

  addCompositeUniqueIndex(
    tableName: string,
    columns: string[],
    indexName: string,
  ) {
    const columnList = columns.map((col) => this.wrap(col)).join(", ");
    return this.connector.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${this.wrap(indexName)} ON ${this.wrap(tableName)} (${columnList})`,
    );
  }

  // SQLite runs in a single process, so advisory locks are treated as no-op.
  async acquireAdvisoryLock(_lockId: string, _timeoutMs?: number): Promise<boolean> {
    return true;
  }

  async releaseAdvisoryLock(_lockId: string): Promise<void> {
    // no-op
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
   * Removes all data from the table.
   * SQLite does not support TRUNCATE, so DELETE FROM is used instead.
   */
  clear(tableName: string) {
    return this.connector.query(
      `DELETE FROM ${this.wrap(tableName)}`,
    );
  }

  /**
   * Returns the SQL fragment for pessimistic locking.
   * SQLite uses database-level locking and does not support row-level locks.
   * Locking is implemented via BEGIN EXCLUSIVE transactions.
   * FOR UPDATE is ignored by SQLite, but this method does not return an empty string for compatibility.
   */
  getForUpdateNoWait(): string {
    // SQLite does not support row-level locking, so return an empty string.
    this.logger.warn(
      "SQLite does not support FOR UPDATE — pessimistic locking is not applied",
    );
    return "";
  }

  supportsReturning(): boolean {
    return false;
  }

  supportsInsertReturning(): boolean {
    return this.capabilities.supportsReturning;
  }
}
