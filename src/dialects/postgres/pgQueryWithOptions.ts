/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Sql } from "../../utils/sqlTag";
import type { DriverQueryOptions } from "../../types/DriverQueryOptions";

/** A `pg` pool, or one client checked out of it. */
interface PgQueryable {
  query(config: any): Promise<any>;
}

/**
 * Runs `query` on `client` with the result format `options` asks for: the
 * pool for a standalone read, a transaction's own client inside one.
 */
export async function pgQueryWithOptions(
  client: PgQueryable,
  query: Sql,
  options: DriverQueryOptions,
): Promise<any[]> {
  let paramIndex = 0;
  const pgSql = query.sql.replace(/\?/g, () => `$${++paramIndex}`);

  const queryConfig: any = {
    text: pgSql,
    values: query.values,
  };
  if (options.binary) queryConfig.binary = true;
  if (options.arrayMode) queryConfig.rowMode = "array";

  const result: any = await client.query(queryConfig);
  return result.rows;
}
