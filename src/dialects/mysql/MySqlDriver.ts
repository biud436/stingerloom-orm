/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { join, raw, Sql } from "../../utils/sqlTag";
import { IConnector } from "../../core/IConnector";
import { MysqlSchemaInterface } from "./BaseSchema";
import { ColumnOption, ColumnType } from "../../decorators";
import { ISqlDriver } from "../SqlDriver";
import { Exception } from "../../errors";
import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";
import { SchemaOptions } from "../../types/SchemaOption";
import { SchemaGenerator } from "../../core/generators/SchemaGenerator";
import { validateSavepointName } from "../../utils/validateSavepointName";
import { MySqlColumnDefinitionBuilder } from "./MySqlColumnDefinitionBuilder";
import type { DriverQueryOptions } from "../../types/DriverQueryOptions";
import type { MySqlConnector } from "./MySqlConnector";
import { DbVersion } from "../DbVersion";
import { MySqlCapabilities, ALL_MYSQL } from "../DialectCapabilities";
import { resolveMySqlCapabilities } from "../resolveCapabilities";
import { UnsupportedFeatureError } from "../../errors/UnsupportedFeatureError";

export class MySqlDriver implements ISqlDriver {
  private readonly columnDefBuilder: MySqlColumnDefinitionBuilder;
  private readonly version: DbVersion;
  private readonly capabilities: MySqlCapabilities;

  constructor(
    private readonly connector: IConnector,
    private readonly clientType: string = "mysql",
    version?: DbVersion,
  ) {
    this.version = version ?? connector?.getVersion?.() ?? DbVersion.UNKNOWN;
    this.capabilities = resolveMySqlCapabilities(
      this.version,
      clientType === "mariadb",
    );
    this.columnDefBuilder = new MySqlColumnDefinitionBuilder(this.capabilities);
  }

  getVersion(): DbVersion {
    return this.version;
  }

  getCapabilities(): MySqlCapabilities {
    return this.capabilities;
  }

  /**
   * Checks whether the table exists.
   */
  hasTable(name: string) {
    return this.connector.query(sql`SHOW TABLES LIKE ${name}`);
  }

  executeRaw(sqlStr: string) {
    return this.connector.query(sqlStr);
  }

  /**
   * Binary type names in mysql2 that should remain as Buffer.
   */
  private static readonly BINARY_TYPES = new Set([
    "BLOB", "TINY_BLOB", "MEDIUM_BLOB", "LONG_BLOB",
    "BINARY", "VARBINARY",
  ]);

  async queryWithOptions(query: Sql, options: DriverQueryOptions): Promise<any[]> {
    const mysqlConnector = this.connector as MySqlConnector;
    if (!mysqlConnector.pool) {
      throw new OrmError(
        OrmErrorCode.CONNECTION_FAILED,
        "No pool available for queryWithOptions",
        "Ensure the database is connected before using the raw pipeline",
      );
    }

    const queryOpts: any = {
      sql: query.sql,
      values: query.values,
    };

    if (options.binary) {
      // Custom typeCast: BLOB/BINARY → Buffer, everything else → string.
      // Avoids the ~96 byte per-value Buffer object overhead that
      // typeCast=false creates for ALL columns including numbers and booleans.
      queryOpts.typeCast = (field: any, next: () => any) => {
        if (MySqlDriver.BINARY_TYPES.has(field.type)) {
          return field.buffer();
        }
        return field.string();
      };
    }

    if (options.arrayMode) queryOpts.rowsAsArray = true;

    return new Promise((resolve, reject) => {
      (mysqlConnector.pool as any).query(queryOpts, (error: any, results: any) => {
        if (error) return reject(error);
        resolve(Array.isArray(results) ? results : []);
      });
    });
  }

  /**
   * Adds a primary key to the table.
   *
   * @param tableName
   * @param columnName
   */
  addPrimaryKey(tableName: string, columnName: string) {
    return this.connector.query(
      `ALTER TABLE ${this.wrap(tableName)} ADD PRIMARY KEY (${this.wrap(columnName)})`,
    );
  }

  /**
   * Adds auto-increment to the table.
   *
   * @param tableName
   * @param columnName
   */
  addAutoIncrement(tableName: string, columnName: string) {
    return this.connector.query(
      `ALTER TABLE ${this.wrap(tableName)} MODIFY ${this.wrap(columnName)} INT AUTO_INCREMENT`,
    );
  }

  /**
   * Drops the primary key from the table.
   *
   * @param tableName
   */
  dropPrimaryKey(tableName: string) {
    return this.connector.query(
      `ALTER TABLE ${this.wrap(tableName)} DROP PRIMARY KEY`,
    );
  }

  /**
   * Adds a unique key to the table.
   *
   * @param tableName
   * @param columnName
   */
  addUniqueKey(tableName: string, columnName: string) {
    return this.connector.query(
      `ALTER TABLE ${this.wrap(tableName)} ADD UNIQUE (${this.wrap(columnName)})`,
    );
  }

  /**
   * Drops the unique key from the table.
   *
   * @param tableName
   * @param columnName
   */
  dropUniqueKey(tableName: string, columnName: string) {
    return this.connector.query(
      `ALTER TABLE ${this.wrap(tableName)} DROP INDEX ${this.wrap(columnName)}`,
    );
  }

  /**
   * Adds a column to the table.
   * @param tableName
   * @param columnName
   * @param columnType
   */
  addColumn(tableName: string, columnName: string, columnType: string) {
    return this.connector.query(
      `ALTER TABLE ${this.wrap(tableName)} ADD ${this.wrap(columnName)} ${columnType}`,
    );
  }

  /**
   * Drops a column from the table.
   *
   * @param tableName
   * @param columnName
   */
  dropColumn(tableName: string, columnName: string) {
    return this.connector.query(
      `ALTER TABLE ${this.wrap(tableName)} DROP COLUMN ${this.wrap(columnName)}`,
    );
  }

  /**
   * Adds a foreign key.
   *
   * @param tableName
   * @param columnName
   * @param foreignTableName
   * @param foreignColumnName
   * @param constraintName Optional user/NamingStrategy-defined constraint
   *   name; defaults to the hash-based framework convention.
   */
  addForeignKey(
    tableName: string,
    columnName: string,
    foreignTableName: string,
    foreignColumnName: string,
    constraintName?: string,
  ) {
    const foreignKeyName =
      constraintName ??
      this.generateForeignKeyName(tableName, foreignTableName, columnName);

    // We should allow ON DELETE and ON UPDATE options to be specified later.
    // For now it is set to NO ACTION.
    return this.connector.query(
      `ALTER TABLE ${this.wrap(tableName)} ADD CONSTRAINT ${this.wrap(foreignKeyName)} FOREIGN KEY (${this.wrap(columnName)}) REFERENCES ${this.wrap(foreignTableName)}(${this.wrap(foreignColumnName)}) ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  /**
   * Generates a foreign key name.
   * Produces a unique name based on a SHA1 hash to avoid name collisions and length limits.
   *
   * @param sourceTable
   * @param targetTable
   * @param sourceColumn
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
   * @param tableName
   * @param columnName
   */
  async dropForeignKey(tableName: string, columnName: string) {
    const rows: any[] = await this.connector.query(
      sql`SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = ${tableName}
            AND COLUMN_NAME = ${columnName}
            AND REFERENCED_TABLE_NAME IS NOT NULL`,
    );

    if (!rows || rows.length === 0) {
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        `No foreign key constraint found for column "${columnName}" on table "${tableName}"`,
      );
    }

    const constraintName = rows[0].CONSTRAINT_NAME;
    return this.connector.query(
      `ALTER TABLE ${this.wrap(tableName)} DROP FOREIGN KEY ${this.wrap(constraintName)}`,
    );
  }

  /**
   * Adds an index.
   *
   * @param tableName
   * @param columnName
   * @param indexName
   */
  addIndex(tableName: string, columnName: string, indexName: string) {
    return this.connector.query(
      `ALTER TABLE ${this.wrap(tableName)} ADD INDEX ${this.wrap(indexName)} (${this.wrap(columnName)})`,
    );
  }

  hasIndex(tableName: string, indexName: string) {
    return this.connector.query(
      sql`SELECT COUNT(*) as count FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${tableName} AND INDEX_NAME = ${indexName}`,
    );
  }

  /**
   * Drops an index.
   *
   * @param tableName
   * @param indexName
   */
  dropIndex(tableName: string, indexName: string) {
    return this.connector.query(
      `ALTER TABLE ${this.wrap(tableName)} DROP INDEX ${this.wrap(indexName)}`,
    );
  }

  /**
   * Retrieves the schema.
   *
   * @param tableName
   */
  getSchemas(tableName: string): Promise<MysqlSchemaInterface[]> {
    return this.connector.query(`SHOW COLUMNS FROM ${this.wrap(tableName)}`);
  }

  /**
   * Retrieves the indexes.
   *
   * @param tableName
   */
  getIndexes(tableName: string): Promise<MysqlSchemaInterface[]> {
    return this.connector.query(`SHOW INDEXES FROM ${this.wrap(tableName)}`);
  }

  /**
   * Retrieves the foreign keys.
   *
   * @param tableName
   */
  getForeignKeys(tableName: string): Promise<MysqlSchemaInterface[]> {
    return this.connector.query(
      sql`SELECT COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${tableName} AND REFERENCED_TABLE_NAME IS NOT NULL`,
    );
  }

  /**
   * Retrieves the primary keys.
   *
   * @param tableName
   */
  getPrimaryKeys(tableName: string): Promise<MysqlSchemaInterface[]> {
    return this.connector.query(
      sql`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${tableName} AND CONSTRAINT_NAME = 'PRIMARY'`,
    );
  }

  /**
   * Creates the table.
   *
   * @param tableName
   * @param columns
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

    const result = sql`CREATE TABLE IF NOT EXISTS ${raw(this.wrap(tableName))} (${join(
      columnsMap,
      ",",
    )})`;

    return this.connector.query(result.text);
  }

  /**
   * Returns the column name wrapped in backticks if it is not already.
   */
  wrap(columnName: string) {
    return `\`${columnName.replace(/`/g, "``")}\``;
  }

  /**
   * Infers the database column type from the TypeScript type.
   */
  getColumnType(type: any): string {
    switch (type) {
      case String:
        return "VARCHAR";
      case Number:
        return "INT";
      case Boolean:
        return "BOOLEAN";
      case Date:
        return "DATETIME";
      case Buffer:
        return "BLOB";
      default:
        return "TEXT";
    }
  }

  /**
   * Converts a ColumnType to the corresponding database column type.
   *
   * ## MySQL/MariaDB type mapping
   * | ColumnType | MySQL Type                      |
   * |------------|--------------------------------|
   * | varchar    | VARCHAR                        |
   * | int        | INT                            |
   * | number     | INT                            |
   * | boolean    | TINYINT(1)                     |
   * | datetime   | DATETIME                       |
   * | date       | DATE                           |
   * | timestamp  | TIMESTAMP                      |
   * | float      | FLOAT                          |
   * | double     | DECIMAL(precision, scale)      |
   * | blob       | BLOB                           |
   * | text       | TEXT                           |
   * | longtext   | LONGTEXT                       |
   * | bigint     | BIGINT                         |
   * | json       | JSON                           |
   */
  castType(type: ColumnType): string {
    return this.columnDefBuilder.castType(type);
  }

  public isMySqlFamily() {
    return ["mysql", "mariadb"].includes(this.clientType);
  }

  setQueryTimeout(ms: number): string {
    return `SET SESSION max_execution_time = ${Math.max(0, Math.floor(ms))}`;
  }

  supportsExplain(): boolean {
    return true;
  }

  buildExplainSql(selectSql: string): string {
    return `EXPLAIN ${selectSql}`;
  }

  buildUpsertSql(
    tableName: string,
    columns: string[],
    conflictColumns: string[],
    updateColumns: string[],
  ): string {
    const columnList = columns.map((c) => this.wrap(c)).join(", ");
    const valuePlaceholders = columns.map(() => "?").join(", ");
    const updateSet = updateColumns
      .map((col) => `${this.wrap(col)} = VALUES(${this.wrap(col)})`)
      .join(", ");

    return `INSERT INTO ${this.wrap(tableName)} (${columnList}) VALUES (${valuePlaceholders}) ON DUPLICATE KEY UPDATE ${updateSet}`;
  }

  async hasColumn(tableName: string, columnName: string): Promise<boolean> {
    const rows: any[] = await this.connector.query(
      sql`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${tableName} AND COLUMN_NAME = ${columnName}`,
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  async hasForeignKey(tableName: string, constraintName: string): Promise<boolean> {
    const rows: any[] = await this.connector.query(
      sql`SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${tableName} AND CONSTRAINT_NAME = ${constraintName} AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
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
      `CREATE UNIQUE INDEX ${this.wrap(indexName)} ON ${this.wrap(tableName)} (${columnList})`,
    );
  }

  async acquireAdvisoryLock(lockId: string, timeoutMs: number = 0): Promise<boolean> {
    const timeoutSec = Math.max(0, Math.floor(timeoutMs / 1000));
    const result: any = await this.connector.query(
      sql`SELECT GET_LOCK(${lockId}, ${timeoutSec}) AS lock_result`,
    );
    const rows = Array.isArray(result) ? result : result?.results ?? result?.rows ?? [];
    if (rows.length === 0) return false;
    return rows[0]?.lock_result === 1;
  }

  async releaseAdvisoryLock(lockId: string): Promise<void> {
    await this.connector.query(
      sql`SELECT RELEASE_LOCK(${lockId})`,
    );
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
   * Removes all data from the table (TRUNCATE TABLE).
   * Disables and restores FOREIGN_KEY_CHECKS on a single connection to guarantee connection isolation.
   */
  async clear(tableName: string) {
    const conn = await this.connector.getConnection();
    try {
      await this.connector.query(`SET FOREIGN_KEY_CHECKS = 0`, conn);
      return await this.connector.query(
        `TRUNCATE TABLE ${this.wrap(tableName)}`,
        conn,
      );
    } finally {
      try {
        await this.connector.query(`SET FOREIGN_KEY_CHECKS = 1`, conn);
      } finally {
        conn.release();
      }
    }
  }

  /**
   * Returns the SQL fragment for pessimistic locking.
   *
   * Locking Reads - https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html
   *
   * ## InnoDB locking reads
   *
   * In InnoDB, a SELECT statement can set various kinds of locks when reading. By default SELECT
   * reads data without acquiring a shared lock, but in certain situations locks must be set
   * explicitly so that transactions can read and modify data safely. The main types of InnoDB
   * locking reads are:
   *
   * 1. SELECT ... FOR UPDATE
   * This statement sets an exclusive lock on the rows it reads. It is used to prevent other
   * transactions from modifying or deleting those rows. FOR UPDATE is commonly used together with
   * UPDATE or DELETE, and other transactions cannot change the rows until the current transaction
   * completes.
   *
   * Example:
   *
   * ```sql
   * SELECT * FROM employees WHERE employee_id = 1 FOR UPDATE;
   * ```
   *
   * This statement guarantees that no other transaction can modify or delete the row until the
   * transaction ends.
   *
   * 2. SELECT ... LOCK IN SHARE MODE
   * This statement places a shared lock on the rows, preventing other transactions from modifying
   * or deleting them, while still allowing other transactions to acquire a shared lock and read
   * the same rows. Shared locks are mainly used to preserve referential integrity.
   *
   * Example:
   *
   * ```sql
   * SELECT * FROM employees WHERE employee_id = 1 LOCK IN SHARE MODE;
   * ```
   *
   * This statement lets other transactions read the rows via a shared lock, but blocks any
   * modification or deletion of those rows.
   *
   * Summary of the difference:
   * FOR UPDATE: acquires an exclusive lock on the selected rows and prevents other transactions
   * from modifying or deleting them.
   * LOCK IN SHARE MODE: acquires a shared lock on the selected rows, blocking modification and
   * deletion by other transactions while still allowing reads.
   *
   * These locking reads are an important tool for guaranteeing transactional consistency and
   * integrity. InnoDB handles locking efficiently, allowing safe concurrent access to data.
   *
   * ## NOWAIT
   * A locking read with `NOWAIT` never waits to acquire a row lock. The query is executed
   * immediately, and fails with an error if any requested row is locked.
   *
   * ## SKIP LOCKED
   * A locking read with `SKIP LOCKED` also never waits to acquire a row lock. The query is
   * executed immediately and simply excludes locked rows from the result set.
   *
   * If the transaction isolation level is set to SERIALIZABLE and autocommit is disabled,
   * InnoDB implicitly converts every plain SELECT into `SELECT ... FOR SHARE` (a shared lock,
   * useful for read-only transactions).
   * SELECT ... FOR SHARE is primarily used to preserve data integrity while processing
   * transactions. It guarantees that no other transaction can change the same rows until the
   * current transaction completes.
   *
   * If autocommit is enabled, a plain SELECT is treated as its own transaction.
   *
   */
  getForUpdateNoWait(): string {
    /**
        FOR SHARE:
        Used primarily for reference/lookup reads.
        Protects the rows from being modified or deleted by other transactions while reading.
        Used to read data safely in situations where no modification is required.

        FOR UPDATE:
        Used when you plan to modify data.
        After reading the rows, FOR UPDATE prevents other transactions from modifying or deleting
        them, so that a subsequent UPDATE or DELETE can be performed safely.
        It is the mechanism for preventing conflicts when other transactions try to modify the same data.

        FOR SHARE: blocks modification/deletion while reading, but still allows other transactions
        to read the rows.
        FOR UPDATE: used when there is an intent to modify the rows after reading, blocking both
        reads and modifications by other transactions.
        * */

    if (!this.isMySqlFamily()) {
      return " FOR UPDATE";
    }

    return " FOR UPDATE NOWAIT";
  }

  supportsReturning(): boolean {
    return false;
  }

  /**
   * MariaDB 10.5+ supports `INSERT ... RETURNING` and `DELETE ... RETURNING`
   * (but not UPDATE RETURNING). MySQL does not support any form of RETURNING.
   */
  supportsInsertReturning(): boolean {
    return this.capabilities.supportsInsertReturning;
  }
}
