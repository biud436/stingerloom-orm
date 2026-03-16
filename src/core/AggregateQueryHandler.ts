/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../utils";
import { WhereClause } from "../dialects/FindOption";
import { TransactionSessionManager } from "../dialects/TransactionSessionManager";
import sql, { Sql, join, raw } from "sql-template-tag";
import { Conditions } from "./Conditions";
import { QueryResult } from "../types/QueryResult";
import { EntityMetadataNotFoundError } from "../errors/EntityMetadataNotFoundError";
import { RelationMetadataResolver } from "./RelationMetadataResolver";
import { EntityManagerInternals } from "./EntityManagerInternals";

/**
 * 집계 함수 (count/sum/avg/min/max) 핸들러.
 * EntityManager에서 위임받아 처리합니다.
 */
export class AggregateQueryHandler {
  constructor(
    private readonly resolver: RelationMetadataResolver,
    private readonly ctx: EntityManagerInternals,
  ) {}

  async aggregate<T>(
    entity: ClazzType<T>,
    fn: string,
    field: string,
    where?: WhereClause<T>,
    existingSession?: TransactionSessionManager,
  ): Promise<number> {
    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    const executor = existingSession
      ? (fn2: (s: TransactionSessionManager) => Promise<number>) =>
          this.ctx.executeInTransaction(fn2, existingSession)
      : (fn2: (s: TransactionSessionManager) => Promise<number>) =>
          this.ctx.executeReadOnly(fn2, {});

    return executor(async (session) => {
      const tableName = metadata.name!;
      const selectExpr = raw(
        `${fn}(${field === "*" ? "*" : this.ctx.wrap(field)})`,
      );

      const whereMap: Sql[] = [];
      if (where) {
        for (const key in where) {
          const value = (where as any)[key];
          if (value !== undefined && value !== null) {
            whereMap.push(Conditions.equals(this.ctx.wrap(key), value));
          }
        }
      }

      let queryStr: Sql;
      if (whereMap.length > 0) {
        const whereSql = join(whereMap, " AND ");
        queryStr = sql`SELECT ${selectExpr} AS ${raw(this.ctx.wrap("result"))} FROM ${raw(this.ctx.wrap(tableName))} WHERE ${whereSql}`;
      } else {
        queryStr = sql`SELECT ${selectExpr} AS ${raw(this.ctx.wrap("result"))} FROM ${raw(this.ctx.wrap(tableName))}`;
      }

      const queryResult = (await session.query(
        queryStr,
      )) as QueryResult;

      const { results } = queryResult;
      if (!results || results.length === 0) return 0;

      const row = results[0];
      const value = row.result ?? row["result"];
      return value === null || value === undefined ? 0 : Number(value);
    });
  }

  async count<T>(
    entity: ClazzType<T>,
    where?: WhereClause<T>,
  ): Promise<number> {
    return this.aggregate(entity, "COUNT", "*", where);
  }

  async sum<T>(
    entity: ClazzType<T>,
    field: keyof T & string,
    where?: WhereClause<T>,
  ): Promise<number> {
    return this.aggregate(entity, "SUM", field, where);
  }

  async avg<T>(
    entity: ClazzType<T>,
    field: keyof T & string,
    where?: WhereClause<T>,
  ): Promise<number> {
    return this.aggregate(entity, "AVG", field, where);
  }

  async min<T>(
    entity: ClazzType<T>,
    field: keyof T & string,
    where?: WhereClause<T>,
  ): Promise<number> {
    return this.aggregate(entity, "MIN", field, where);
  }

  async max<T>(
    entity: ClazzType<T>,
    field: keyof T & string,
    where?: WhereClause<T>,
  ): Promise<number> {
    return this.aggregate(entity, "MAX", field, where);
  }
}
