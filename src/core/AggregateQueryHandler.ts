/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../utils";
import { WhereClause } from "../dialects/FindOption";
import { TransactionSessionManager } from "../dialects/TransactionSessionManager";
import sql, { Sql, join, raw } from "../utils/sqlTag";
import { Conditions } from "./Conditions";
import { resolveWhereClause } from "./WhereResolver";
import {
  assertKnownColumn,
  buildEntityColumnScope,
  validateWhereIdentifiers,
} from "./ColumnNameValidator";
import { createDialectExpression } from "../dialects/DialectExpression";
import { QueryResult } from "../types/QueryResult";
import { EntityMetadataNotFoundError } from "../errors/EntityMetadataNotFoundError";
import { RelationMetadataResolver } from "./RelationMetadataResolver";
import { EntityManagerInternals } from "./EntityManagerInternals";

/**
 * Handler for aggregate functions (count/sum/avg/min/max).
 * Invoked by EntityManager via delegation.
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
    where?: WhereClause<T> | WhereClause<T>[],
    existingSession?: TransactionSessionManager,
    withDeleted?: boolean,
    onlyDeleted?: boolean,
  ): Promise<number> {
    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    const executor = existingSession
      ? (fn2: (s: TransactionSessionManager) => Promise<number>) =>
          this.ctx.executeInTransaction(fn2, existingSession)
      : (fn2: (s: TransactionSessionManager) => Promise<number>) =>
          // count()/sum()/avg()/min()/max() take no per-query timeout, but the
          // connection-level `queryTimeout` covers every read the ORM issues —
          // an aggregate over a huge table is exactly the runaway query it is
          // meant to bound. When a session is passed in, the caller's read
          // already runs under the resolved timeout.
          this.ctx.executeReadOnly(fn2, {
            timeout: this.ctx.getDefaultQueryTimeout(),
          });

    return executor(async (session) => {
      const tableName = metadata.name;

      // Resolve property names to DB columns exactly like findInternal so the
      // aggregate field and WHERE honor a NamingStrategy and FK shadow props.
      const propToCol = this.ctx.buildPropertyToColumnMap(metadata);
      const mappedField =
        field === "*" ? "*" : this.ctx.wrap(propToCol.get(field) ?? field);
      const selectExpr = raw(`${fn}(${mappedField})`);

      // Same identifier guard as findInternal — count()/sum()/avg()/min()/max()
      // must accept exactly the columns find() accepts, and reject the rest
      // with the valid list instead of a raw driver error.
      const scope = buildEntityColumnScope({
        entity,
        metadata,
        propertyToColumn: propToCol,
        computedColumns: this.ctx.getComputedColumnNames(entity),
        inheritanceResolver: this.ctx.getInheritanceResolver(),
      });
      validateWhereIdentifiers(where, scope);
      if (field !== "*") assertKnownColumn(field, "select", scope);

      const whereMap: Sql[] = resolveWhereClause(where, {
        wrapColumn: (n) => this.ctx.wrap(n),
        dialect: this.ctx.getDialect(),
        dialectExpression: createDialectExpression(this.ctx.getDialect()),
        propertyToColumn: propToCol,
      });

      // If an @DeletedAt column exists, exclude soft-deleted rows by default,
      // mirroring findInternal so count()/exists()/sum()/avg()/min()/max() —
      // and therefore findAndCount() — never count trashed rows. Callers opt
      // back in via `withDeleted: true`, or restrict to the trash via
      // `onlyDeleted: true` (which appends IS NOT NULL and takes precedence over
      // withDeleted, keeping the count consistent with findInternal's data set).
      // The aggregate query is never joined, so the unqualified column form is
      // correct.
      const deletedAtColumn = this.resolver.getDeletedAtColumn(entity);
      if (deletedAtColumn) {
        if (onlyDeleted) {
          whereMap.push(Conditions.isNotNull(this.ctx.wrap(deletedAtColumn)));
        } else if (!withDeleted) {
          whereMap.push(Conditions.isNull(this.ctx.wrap(deletedAtColumn)));
        }
      }

      // STI: count/sum/avg/min/max over a child class must aggregate only that
      // subtype's rows. find() already filters by the discriminator, so an
      // unfiltered aggregate would contradict the data set findAndCount() pairs
      // it with (count included siblings while the rows did not).
      const aggregateSti = this.ctx
        .getInheritanceResolver()
        .getSingleTableChildDiscriminator(entity);
      if (aggregateSti) {
        whereMap.push(
          Conditions.equals(
            this.ctx.wrap(aggregateSti.columnName),
            aggregateSti.value,
          ),
        );
      }

      // Tenant scoping under the "tenant_column" strategy. Kept consistent
      // with findInternal so exists()/count()/sum()/avg()/min()/max() never
      // leak rows across tenants.
      const tenantPredicate = this.ctx.buildTenantWhereClause(entity);
      if (tenantPredicate) {
        whereMap.push(tenantPredicate);
      }

      let queryStr: Sql;
      if (whereMap.length > 0) {
        const whereSql = join(whereMap, " AND ");
        queryStr = sql`SELECT ${selectExpr} AS ${raw(this.ctx.wrap("result"))} FROM ${raw(this.ctx.wrapTable(tableName))} WHERE ${whereSql}`;
      } else {
        queryStr = sql`SELECT ${selectExpr} AS ${raw(this.ctx.wrap("result"))} FROM ${raw(this.ctx.wrapTable(tableName))}`;
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

  /**
   * When `onlyDeleted` is true, counts ONLY soft-deleted rows (@DeletedAt
   * IS NOT NULL). It takes precedence over `withDeleted` and is a silent no-op
   * for entities without an @DeletedAt column.
   */
  async count<T>(
    entity: ClazzType<T>,
    where?: WhereClause<T>,
    withDeleted?: boolean,
    onlyDeleted?: boolean,
  ): Promise<number> {
    return this.aggregate(
      entity,
      "COUNT",
      "*",
      where,
      undefined,
      withDeleted,
      onlyDeleted,
    );
  }

  /**
   * When `onlyDeleted` is true, sums over ONLY soft-deleted rows (@DeletedAt
   * IS NOT NULL). It takes precedence over `withDeleted` and is a silent no-op
   * for entities without an @DeletedAt column.
   */
  async sum<T>(
    entity: ClazzType<T>,
    field: keyof T & string,
    where?: WhereClause<T>,
    withDeleted?: boolean,
    onlyDeleted?: boolean,
  ): Promise<number> {
    return this.aggregate(
      entity,
      "SUM",
      field,
      where,
      undefined,
      withDeleted,
      onlyDeleted,
    );
  }

  /**
   * When `onlyDeleted` is true, averages over ONLY soft-deleted rows (@DeletedAt
   * IS NOT NULL). It takes precedence over `withDeleted` and is a silent no-op
   * for entities without an @DeletedAt column.
   */
  async avg<T>(
    entity: ClazzType<T>,
    field: keyof T & string,
    where?: WhereClause<T>,
    withDeleted?: boolean,
    onlyDeleted?: boolean,
  ): Promise<number> {
    return this.aggregate(
      entity,
      "AVG",
      field,
      where,
      undefined,
      withDeleted,
      onlyDeleted,
    );
  }

  /**
   * When `onlyDeleted` is true, takes the minimum over ONLY soft-deleted rows
   * (@DeletedAt IS NOT NULL). It takes precedence over `withDeleted` and is a
   * silent no-op for entities without an @DeletedAt column.
   */
  async min<T>(
    entity: ClazzType<T>,
    field: keyof T & string,
    where?: WhereClause<T>,
    withDeleted?: boolean,
    onlyDeleted?: boolean,
  ): Promise<number> {
    return this.aggregate(
      entity,
      "MIN",
      field,
      where,
      undefined,
      withDeleted,
      onlyDeleted,
    );
  }

  /**
   * When `onlyDeleted` is true, takes the maximum over ONLY soft-deleted rows
   * (@DeletedAt IS NOT NULL). It takes precedence over `withDeleted` and is a
   * silent no-op for entities without an @DeletedAt column.
   */
  async max<T>(
    entity: ClazzType<T>,
    field: keyof T & string,
    where?: WhereClause<T>,
    withDeleted?: boolean,
    onlyDeleted?: boolean,
  ): Promise<number> {
    return this.aggregate(
      entity,
      "MAX",
      field,
      where,
      undefined,
      withDeleted,
      onlyDeleted,
    );
  }
}
