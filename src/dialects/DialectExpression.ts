import type { Sql } from "sql-template-tag";
import type { DialectName } from "../core/ColumnTypeRegistry";
import { PostgresExpression } from "./expression/PostgresExpression";
import { MySqlExpression } from "./expression/MySqlExpression";
import { SqliteExpression } from "./expression/SqliteExpression";

/**
 * Strategy interface for dialect-specific SQL expression generation.
 *
 * Each method takes already-qualified column identifiers (e.g. `"u"."name"`)
 * and user-supplied values, returning a parameterized `Sql` object.
 *
 * Implementations live in `src/dialects/expression/`.
 */
export interface DialectExpression {
  /** The dialect this expression generator targets. */
  readonly dialect: DialectName;

  /**
   * Case-insensitive LIKE.
   *
   * - PostgreSQL: native `ILIKE`
   * - MySQL: `LIKE` (case-insensitive by default with utf8mb4_general_ci)
   * - SQLite: `LIKE` (case-insensitive for ASCII)
   */
  ilike(column: string, value: string): Sql;

  /**
   * Full-text search condition.
   *
   * - PostgreSQL: `to_tsvector('lang', column) @@ plainto_tsquery('lang', query)`
   * - MySQL: `MATCH(column) AGAINST(query IN BOOLEAN MODE)`
   * - SQLite: throws (unsupported)
   *
   * @param language - Text search config (PostgreSQL only, default: "english").
   */
  fullTextSearch(column: string, query: string, language?: string): Sql;
}

/** Singleton cache — implementations are stateless. */
const cache = new Map<DialectName, DialectExpression>();

/**
 * Creates or retrieves a cached {@link DialectExpression} for the given dialect.
 *
 * Follows the same factory pattern as `createColumnDefinitionBuilder()`.
 */
export function createDialectExpression(dialect: DialectName): DialectExpression {
  let expr = cache.get(dialect);
  if (!expr) {
    switch (dialect) {
      case "postgres":
        expr = new PostgresExpression();
        break;
      case "mysql":
        expr = new MySqlExpression();
        break;
      case "sqlite":
        expr = new SqliteExpression();
        break;
    }
    cache.set(dialect, expr);
  }
  return expr;
}

/** @internal Reset cache. For testing only. */
export function resetDialectExpressionCache(): void {
  cache.clear();
}
