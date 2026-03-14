/* eslint-disable @typescript-eslint/no-explicit-any */
import { ColumnType } from "../decorators/Column";
import { ColumnMetadata } from "../scanner/ColumnScanner";
import { MysqlSchemaInterface } from "./mysql/BaseSchema";

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
   * @returns A promise that resolves when the operation is complete.
   */
  addForeignKey(
    tableName: string,
    columnName: string,
    foreignTableName: string,
    foreignColumnName: string,
  ): Promise<T>;

  /**
   * Checks whether a foreign key constraint already exists on a table.
   */
  hasForeignKey(tableName: string, constraintName: string): Promise<boolean>;

  /**
   * Generates a name for a foreign key constraint based on the source and target tables and columns.
   *
   * @deprecated Use `NamingStrategy.foreignKeyName()` instead.
   * This method is kept for backward compatibility with existing driver code.
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
   * @returns A promise that resolves when the operation is complete.
   */
  createTable(
    tableName: string,
    columns: Omit<ColumnMetadata, "target" | "type">[],
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
   * @param tableName - The escaped table name.
   * @param columns - The escaped column names.
   * @param conflictColumns - The escaped conflict/key column names.
   * @param updateColumns - The escaped column names to update on conflict.
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
}
