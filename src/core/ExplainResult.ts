/**
 * Standardized result from EXPLAIN queries across all database dialects.
 */
export interface ExplainResult {
  /** Raw result rows from the database EXPLAIN output */
  raw: Record<string, unknown>[];

  /** Estimated number of rows to be examined */
  rows: number | null;

  /** Access type / node type (e.g., ALL, index, ref for MySQL; Seq Scan, Index Scan for PostgreSQL) */
  type: string | null;

  /** Possible indexes that could be used */
  possibleKeys: string[] | null;

  /** The index actually chosen by the optimizer */
  key: string | null;

  /** Estimated cost of the query (MySQL: filtered percentage, PostgreSQL: total_cost) */
  cost: number | null;
}
