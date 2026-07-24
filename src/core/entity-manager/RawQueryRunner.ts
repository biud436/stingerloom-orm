/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql } from "../../utils/sqlTag";
import { ClazzType } from "../../utils";
import { ENTITY_TOKEN } from "../../decorators/Entity";
import { isTemplateStringsArray } from "./internal-utils";
import type { EntityManagerInternals } from "../EntityManagerInternals";

/**
 * Raw-SQL execution engine extracted from EntityManager: the `em.query()`
 * overload resolution (tagged template / prebuilt Sql / string + positional
 * binds), entity-class interpolation via `em.ref()`, and the transactional
 * raw-query execution path.
 *
 * The facade keeps the public `query()` delegator (tests reassign
 * `em.query` on the instance) and routes execution back through `ctx` so
 * spies on `executeInTransaction` and the tenant bypass warning keep
 * behaving identically.
 *
 * @internal Package-internal — not a public API.
 */
export class RawQueryRunner {
  constructor(private readonly ctx: EntityManagerInternals) {}

  async query<T = Record<string, unknown>>(
    sqlOrStrings: string | Sql | TemplateStringsArray,
    rest: unknown[],
  ): Promise<T[]> {
    if (isTemplateStringsArray(sqlOrStrings)) {
      const fragment = this.composeTaggedSql(sqlOrStrings, rest);
      return this.runRawQuery<T>(fragment);
    }
    const params = rest[0] as unknown[] | undefined;
    if (typeof sqlOrStrings === "string" && params && params.length > 0) {
      const parameterizedSql = {
        text: sqlOrStrings,
        sql: sqlOrStrings,
        values: params,
        strings: [sqlOrStrings],
      } as unknown as Sql;
      return this.runRawQuery<T>(parameterizedSql);
    }
    return this.runRawQuery<T>(sqlOrStrings);
  }

  private async runRawQuery<T>(sqlQuery: string | Sql): Promise<T[]> {
    this.ctx.warnIfRawQueryBypassesTenant();
    return this.ctx.executeInTransaction(async (session) => {
      const queryResult: any =
        typeof sqlQuery === "string"
          ? await session.query(sqlQuery)
          : await session.query(sqlQuery);
      if (queryResult?.results) {
        return (queryResult.results as T[]) ?? [];
      }
      if (Array.isArray(queryResult)) {
        return queryResult as T[];
      }
      return [];
    });
  }

  private composeTaggedSql(
    strings: TemplateStringsArray,
    values: unknown[],
  ): Sql {
    const converted = values.map((v) => {
      if (
        typeof v === "function" &&
        Reflect.getMetadata(ENTITY_TOKEN, v) !== undefined
      ) {
        return this.ctx.getManager().ref(v as ClazzType<unknown>);
      }
      return v;
    });
    return sql(strings, ...(converted as Parameters<typeof sql>[1][]));
  }
}
