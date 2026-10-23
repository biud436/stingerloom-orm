/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Sql } from "../../utils/sqlTag";
import type { DriverQueryOptions } from "../../types/DriverQueryOptions";

/** A mysql2 pool, or one connection checked out of it (callback API). */
interface MySqlQueryable {
  query(options: any, callback: (error: any, results: any) => void): unknown;
}

/**
 * Binary type names in mysql2 that should remain as Buffer.
 */
const BINARY_TYPES = new Set([
  "BLOB", "TINY_BLOB", "MEDIUM_BLOB", "LONG_BLOB",
  "BINARY", "VARBINARY",
]);

/**
 * Runs `query` on `target` with the result format `options` asks for: the
 * pool for a standalone read, a transaction's own connection inside one.
 */
export function mysqlQueryWithOptions(
  target: MySqlQueryable,
  query: Sql,
  options: DriverQueryOptions,
): Promise<any[]> {
  const queryOpts: any = {
    sql: query.sql,
    values: query.values,
  };

  if (options.binary) {
    // Custom typeCast: BLOB/BINARY → Buffer, everything else → string.
    // Avoids the ~96 byte per-value Buffer object overhead that
    // typeCast=false creates for ALL columns including numbers and booleans.
    queryOpts.typeCast = (field: any, next: () => any) => {
      if (BINARY_TYPES.has(field.type)) {
        return field.buffer();
      }
      return field.string();
    };
  }

  if (options.arrayMode) queryOpts.rowsAsArray = true;

  return new Promise((resolve, reject) => {
    target.query(queryOpts, (error: any, results: any) => {
      if (error) return reject(error);
      resolve(Array.isArray(results) ? results : []);
    });
  });
}
