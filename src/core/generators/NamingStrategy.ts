import crypto from "crypto";
import { camelToSnakeCase } from "../../utils/camelToSnakeCase";

/**
 * Strategy interface for naming database objects (tables, columns, constraints, indexes).
 * Implement this interface to customize how names are generated.
 */
export interface NamingStrategy {
  /**
   * Converts an entity class name to a database table name.
   * Called during entity registration for entities without explicit `@Entity({ name })`.
   *
   * @param className - The entity class name (e.g. "UserProfile")
   * @returns The database table name (e.g. "user_profile")
   */
  tableName(className: string): string;

  /**
   * Converts a TypeScript property name to a database column name.
   * Called during entity registration for columns without explicit `@Column({ name })`.
   *
   * @param propertyName - The property name (e.g. "firstName")
   * @returns The database column name (e.g. "first_name")
   */
  columnName(propertyName: string): string;

  /**
   * Generates a foreign key column name for a relation.
   * Called for `@ManyToOne`/`@OneToOne` without explicit `joinColumn`.
   *
   * @param propertyName - The relation property name (e.g. "author")
   * @param referencedColumnName - The referenced PK column name (e.g. "id")
   * @returns The FK column name (e.g. "author_id")
   */
  joinColumnName(propertyName: string, referencedColumnName: string): string;

  /**
   * Generates a foreign key constraint name.
   */
  foreignKeyName(
    tableName: string,
    columnName: string,
    referencedTableName: string,
  ): string;

  /**
   * Generates a unique index name.
   */
  uniqueIndexName(tableName: string, columns: string[]): string;

  /**
   * Generates an index name.
   */
  indexName(tableName: string, columnName: string): string;

  /**
   * Generates a composite index name.
   */
  compositeIndexName(tableName: string, columns: string[]): string;
}

/**
 * Default naming strategy using SHA1 hash for FK names
 * and convention-based names for indexes.
 */
export class DefaultNamingStrategy implements NamingStrategy {
  tableName(className: string): string {
    return camelToSnakeCase(className);
  }

  columnName(propertyName: string): string {
    return propertyName;
  }

  joinColumnName(propertyName: string, referencedColumnName: string): string {
    return `${propertyName}${referencedColumnName.charAt(0).toUpperCase()}${referencedColumnName.slice(1)}`;
  }

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
