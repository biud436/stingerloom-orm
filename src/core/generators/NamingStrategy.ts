import crypto from "crypto";

/**
 * Strategy interface for generating database constraint and index names.
 * Implement this interface to customize how FK, index, and unique index names are generated.
 */
export interface NamingStrategy {
  /**
   * Generates a foreign key constraint name.
   *
   * @param tableName - The source table name
   * @param columnName - The FK column name
   * @param referencedTableName - The referenced (target) table name
   * @returns A constraint name (max 63 characters for cross-DB compatibility)
   */
  foreignKeyName(
    tableName: string,
    columnName: string,
    referencedTableName: string,
  ): string;

  /**
   * Generates a unique index name.
   *
   * @param tableName - The table name
   * @param columns - The column names included in the unique index
   * @returns A unique index name
   */
  uniqueIndexName(tableName: string, columns: string[]): string;

  /**
   * Generates an index name.
   *
   * @param tableName - The table name
   * @param columnName - The indexed column name
   * @returns An index name
   */
  indexName(tableName: string, columnName: string): string;

  /**
   * Generates a composite index name.
   *
   * @param tableName - The table name
   * @param columns - The column names included in the index
   * @returns A composite index name
   */
  compositeIndexName(tableName: string, columns: string[]): string;
}

/**
 * Default naming strategy using SHA1 hash for FK names
 * and convention-based names for indexes.
 */
export class DefaultNamingStrategy implements NamingStrategy {
  /**
   * Generates a FK name using SHA1 hash for uniqueness.
   * Format: `fk_{tableName}_{hash8}` (truncated to 63 chars max).
   */
  foreignKeyName(
    tableName: string,
    columnName: string,
    referencedTableName: string,
  ): string {
    const raw = `${tableName}_${columnName}_${referencedTableName}`;
    const hash = crypto
      .createHash("sha1")
      .update(raw)
      .digest("hex")
      .slice(0, 8);
    const base = `fk_${tableName}_${hash}`;
    // MySQL max 64, PostgreSQL max 63 → use 63 for cross-DB compat
    return base.length > 63 ? `fk_${hash}` : base;
  }

  /**
   * Generates a unique index name.
   * Format: `uq_{tableName}_{col1}_{col2}_...`
   */
  uniqueIndexName(tableName: string, columns: string[]): string {
    return `uq_${tableName}_${columns.join("_")}`;
  }

  /**
   * Generates an index name.
   * Format: `INDEX_{tableName}_{columnName}`
   */
  indexName(tableName: string, columnName: string): string {
    return `INDEX_${tableName}_${columnName}`;
  }

  /**
   * Generates a composite index name.
   * Format: `idx_{tableName}_{col1}_{col2}_...`
   */
  compositeIndexName(tableName: string, columns: string[]): string {
    return `idx_${tableName}_${columns.join("_")}`;
  }
}
