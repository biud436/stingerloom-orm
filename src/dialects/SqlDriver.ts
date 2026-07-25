/* eslint-disable @typescript-eslint/no-explicit-any */
import { ColumnType } from "../decorators/Column";
import { ColumnMetadata } from "../scanner/ColumnScanner";
import { MysqlSchemaInterface } from "./mysql/BaseSchema";
import type { DriverQueryOptions } from "../types/DriverQueryOptions";
import type { Sql } from "../utils/sqlTag";
import type { DbVersion } from "./DbVersion";
import type { CommonCapabilities } from "./DialectCapabilities";
import type { ReferentialAction } from "../types/ReferentialAction";

/**
 * An inline FOREIGN KEY definition for `createTable()`.
 *
 * Used by dialects that cannot add FK constraints after table creation
 * (SQLite — `supportsAlterAddForeignKey: false`), where the constraint must
 * be part of the CREATE TABLE statement itself.
 */
export interface CreateTableForeignKey {
  /** FK column on the table being created. */
  columnName: string;
  /** Referenced (parent) table name. */
  referencedTable: string;
  /** Referenced column, usually the parent table's PK. */
  referencedColumn: string;
  /** Optional constraint name (`CONSTRAINT <name> FOREIGN KEY ...`). */
  constraintName?: string;
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
}

export interface ISqlDriver<T = any> {
  /**
   * Checks if the specified table exists in the database.
   *
   * @param name - The name of the table to check.
   * @returns A promise that resolves to a result indicating the existence of the table.
   */
  hasTable(name: string): Promise<T>;

  executeRaw(sql: string): Promise<any>;

  /**
   * Adds a primary key to the specified table.
   *
   * @param tableName - The name of the table to modify.
   * @param columnName - The name of the column to set as the primary key.
   * @returns A promise that resolves when the operation is complete.
   */
  addPrimaryKey(tableName: string, columnName: string): Promise<T>;

  /**
   * Adds an auto increment constraint to the specified column in the table.
   *
   * @param tableName - The name of the table to modify.
   * @param columnName - The name of the column to set as auto increment.
   * @returns A promise that resolves when the operation is complete.
   */
  addAutoIncrement(tableName: string, columnName: string): Promise<T>;

  /**
   * Removes the primary key from the specified table.
   *
   * @param tableName - The name of the table to modify.
   * @returns A promise that resolves when the operation is complete.
   */
  dropPrimaryKey(tableName: string): Promise<T>;

  /**
   * Adds a unique key to the specified column in the table.
   *
   * @param tableName - The name of the table to modify.
   * @param columnName - The name of the column to set as unique.
   * @returns A promise that resolves when the operation is complete.
   */
  addUniqueKey(tableName: string, columnName: string): Promise<T>;

  /**
   * Removes the unique key from the specified column in the table.
   *
   * @param tableName - The name of the table to modify.
   * @param columnName - The name of the column to remove the unique constraint from.
   * @returns A promise that resolves when the operation is complete.
   */
  dropUniqueKey(tableName: string, columnName: string): Promise<T>;

  /**
   * Adds a new column to the specified table.
   *
   * @param tableName - The name of the table to modify.
   * @param columnName - The name of the new column.
   * @param columnType - The data type of the new column.
   * @returns A promise that resolves when the operation is complete.
   */
  addColumn(
    tableName: string,
    columnName: string,
    columnType: string,
  ): Promise<T>;

  /**
   * Removes a column from the specified table.
   *
   * @param tableName - The name of the table to modify.
   * @param columnName - The name of the column to remove.
   * @returns A promise that resolves when the operation is complete.
   */
  dropColumn(tableName: string, columnName: string): Promise<T>;

  /**
   * Adds a foreign key constraint to the specified column in the table.
   *
   * @param tableName - The name of the table to modify.
   * @param columnName - The name of the column to set as a foreign key.
   * @param foreignTableName - The name of the referenced table.
   * @param foreignColumnName - The name of the referenced column.
   * @param constraintName - Optional constraint name (e.g. from
   *   `NamingStrategy.foreignKeyName()`); when omitted the driver falls back
   *   to its hash-based `generateForeignKeyName()`.
   * @returns A promise that resolves when the operation is complete.
   */
  addForeignKey(
    tableName: string,
    columnName: string,
    foreignTableName: string,
    foreignColumnName: string,
    constraintName?: string,
  ): Promise<T>;

  /**
   * Checks whether a foreign key constraint already exists on a table.
   */
  hasForeignKey(tableName: string, constraintName: string): Promise<boolean>;

  /**
   * Generates a name for a foreign key constraint based on the source and target tables and columns.
   *
   * @deprecated Removal target: 2.0, once every `addForeignKey` caller passes
   * an explicit `constraintName` from `NamingStrategy.foreignKeyName()`. Until
   * then this stays part of the interface contract — all three built-in
   * drivers implement it and call it as their fallback, so custom drivers must
   * keep providing it.
   *
   * @param sourceTable - The name of the source table.
   * @param targetTable - The name of the target table.
   * @param sourceColumn - The name of the source column.
   * @returns The generated foreign key name.
   */
  generateForeignKeyName(
    sourceTable: string,
    targetTable: string,
    sourceColumn: string,
  ): string;

  /**
   * Removes a foreign key constraint from the specified column in the table.
   *
   * @param tableName - The name of the table to modify.
   * @param columnName - The name of the column to remove the foreign key constraint from.
   * @returns A promise that resolves when the operation is complete.
   */
  dropForeignKey(tableName: string, columnName: string): Promise<T>;

  /**
   * Adds an index to the specified column in the table.
   *
   * @param tableName - The name of the table to modify.
   * @param columnName - The name of the column to index.
   * @param indexName - The name of the index.
   * @returns A promise that resolves when the operation is complete.
   */
  addIndex(
    tableName: string,
    columnName: string,
    indexName: string,
  ): Promise<T>;

  /**
   * Checks if the specified index exists in the table.
   *
   * @param tableName - The name of the table to check.
   * @param indexName - The name of the index to check.
   * @returns A promise that resolves to a result indicating the existence of the index.
   */
  hasIndex(tableName: string, indexName: string): Promise<T>;

  /**
   * Removes an index from the specified table.
   *
   * @param tableName - The name of the table to modify.
   * @param indexName - The name of the index to remove.
   * @returns A promise that resolves when the operation is complete.
   */
  dropIndex(tableName: string, indexName: string): Promise<T>;

  /**
   * Retrieves the schema information for the specified table.
   *
   * @param tableName - The name of the table to retrieve the schema for.
   * @returns A promise that resolves to an array of schema information.
   */
  getSchemas(tableName: string): Promise<MysqlSchemaInterface[]>;

  /**
   * Retrieves the indexes for the specified table.
   *
   * @param tableName - The name of the table to retrieve the indexes for.
   * @returns A promise that resolves to an array of index information.
   */
  getIndexes(tableName: string): Promise<MysqlSchemaInterface[]>;

  /**
   * Retrieves the foreign keys for the specified table.
   *
   * @param tableName - The name of the table to retrieve the foreign keys for.
   * @returns A promise that resolves to an array of foreign key information.
   */
  getForeignKeys(tableName: string): Promise<MysqlSchemaInterface[]>;

  /**
   * Retrieves the primary keys for the specified table.
   *
   * @param tableName - The name of the table to retrieve the primary keys for.
   * @returns A promise that resolves to an array of primary key information.
   */
  getPrimaryKeys(tableName: string): Promise<MysqlSchemaInterface[]>;

  /**
   * Creates a new table with the specified columns.
   *
   * @param tableName - The name of the new table.
   * @param columns - An array of column metadata for the new table.
   * @param foreignKeys - Optional inline FOREIGN KEY definitions. Only used by
   *   dialects that cannot add FKs after creation (`supportsAlterAddForeignKey`
   *   is false, i.e. SQLite); other dialects may ignore this and keep using
   *   ALTER TABLE ADD FOREIGN KEY in the schema-sync FK pass.
   * @returns A promise that resolves when the operation is complete.
   */
  createTable(
    tableName: string,
    columns: Omit<ColumnMetadata, "target" | "type">[],
    foreignKeys?: CreateTableForeignKey[],
  ): Promise<T>;

  /**
   * Infers the database column type from the TypeScript type.
   *
   * @param type - The TypeScript type to infer from.
   * @returns The inferred database column type.
   */
  getColumnType(type: any): string;

  /**
   * Converts a ColumnType to a database column type.
   *
   * @param type - The ColumnType to convert.
   * @returns The corresponding database column type.
   */
  castType(type: ColumnType): string;

  /**
   * Returns the SQL statement for pessimistic locking with no wait.
   *
   * @returns The SQL statement for pessimistic locking.
   */
  getForUpdateNoWait(): string;

  /**
   * Checks if the driver is for a MySQL family database.
   *
   * @returns True if the driver is for a MySQL family database, otherwise false.
   */
  isMySqlFamily(): boolean;

  /**
   * Returns the SQL statement to set a query execution timeout.
   *
   * @param ms - Timeout in milliseconds.
   * @returns The SQL SET statement for the specific dialect.
   */
  setQueryTimeout(ms: number): string;

  /**
   * Checks if the driver supports EXPLAIN queries.
   *
   * @returns True if EXPLAIN is supported, otherwise false.
   */
  supportsExplain(): boolean;

  /**
   * Wraps a SELECT SQL string with the dialect-specific EXPLAIN prefix.
   *
   * @param selectSql - The SELECT SQL text to explain.
   * @returns The EXPLAIN SQL string.
   */
  buildExplainSql(selectSql: string): string;

  /**
   * Builds an upsert SQL string for the specific dialect.
   *
   * @param tableName - The raw (unescaped) table name. Escaped internally via wrap().
   * @param columns - The raw (unescaped) column names. Escaped internally via wrap().
   * @param conflictColumns - The raw (unescaped) conflict/key column names. Escaped internally via wrap().
   * @param updateColumns - The raw (unescaped) column names to update on conflict. Escaped internally via wrap().
   * @returns The dialect-specific upsert SQL template string.
   */
  buildUpsertSql(
    tableName: string,
    columns: string[],
    conflictColumns: string[],
    updateColumns: string[],
  ): string;

  /**
   * Adds a composite unique index to the specified table.
   *
   * @param tableName - The name of the table to modify.
   * @param columns - The column names to include in the unique index.
   * @param indexName - The name of the unique index.
   * @returns A promise that resolves when the operation is complete.
   */
  addCompositeUniqueIndex(
    tableName: string,
    columns: string[],
    indexName: string,
  ): Promise<T>;

  /**
   * Checks if the specified column exists in the table.
   *
   * @param tableName - The name of the table to check.
   * @param columnName - The name of the column to check.
   * @returns A promise that resolves to true if the column exists, false otherwise.
   */
  hasColumn(tableName: string, columnName: string): Promise<boolean>;

  /**
   * Acquires an advisory lock with the given lock ID.
   * Used to prevent concurrent migration execution across multiple instances.
   *
   * @param lockId - A string identifier for the lock.
   * @param timeoutMs - Optional timeout in milliseconds. 0 = try once without waiting.
   * @returns A promise that resolves to true if the lock was acquired, false otherwise.
   */
  acquireAdvisoryLock(lockId: string, timeoutMs?: number): Promise<boolean>;

  /**
   * Releases a previously acquired advisory lock.
   *
   * @param lockId - The string identifier of the lock to release.
   */
  releaseAdvisoryLock(lockId: string): Promise<void>;

  /**
   * Creates a savepoint within the current transaction.
   *
   * @param name - The savepoint name.
   * @returns The SQL string to create the savepoint.
   */
  createSavepointSql(name: string): string;

  /**
   * Rolls back to a previously created savepoint.
   *
   * @param name - The savepoint name.
   * @returns The SQL string to rollback to the savepoint.
   */
  rollbackToSavepointSql(name: string): string;

  /**
   * Releases a previously created savepoint.
   *
   * @param name - The savepoint name.
   * @returns The SQL string to release the savepoint.
   */
  releaseSavepointSql(name: string): string;

  /**
   * Removes all rows from the specified table.
   * Uses TRUNCATE where supported, or DELETE FROM as fallback.
   *
   * @param tableName - The name of the table to clear.
   * @returns A promise that resolves when the operation is complete.
   */
  clear(tableName: string): Promise<T>;

  /**
   * Whether the database supports the RETURNING clause on INSERT/UPDATE.
   * PostgreSQL supports it; MySQL and SQLite (via better-sqlite3) do not.
   */
  supportsReturning(): boolean;

  /**
   * Whether the database supports `INSERT ... RETURNING`.
   * PostgreSQL: always. SQLite: 3.35+. MariaDB: 10.5+. MySQL: never.
   * Defaults to `supportsReturning()` for drivers that don't distinguish.
   */
  supportsInsertReturning?(): boolean;

  /**
   * Execute a query with driver-level options that control result format.
   * Used by the RawPipeline plugin to bypass ORM entity transformation.
   *
   * Optional — drivers that do not implement this will fall back to
   * the standard `executeRaw()` path.
   */
  queryWithOptions?(sql: Sql, options: DriverQueryOptions): Promise<any[]>;

  /**
   * Returns the detected database server version.
   * Returns DbVersion.UNKNOWN if version detection was not performed.
   */
  getVersion?(): DbVersion;

  /**
   * Returns the feature capabilities of the connected database version.
   * Used by DDL methods to branch on version-specific syntax.
   */
  getCapabilities?(): CommonCapabilities;
}
