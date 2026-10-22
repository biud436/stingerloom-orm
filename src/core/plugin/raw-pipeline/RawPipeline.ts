/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql, raw, join } from "../../../utils/sqlTag";
import type { PluginContext } from "../PluginContext";
import type { ClazzType } from "../../../utils/types";
import type { FindOption, WhereClause } from "../../../dialects/FindOption";
import type { DriverQueryOptions } from "../../../types/DriverQueryOptions";
import { ENTITY_TOKEN, type EntityMetadata } from "../../../decorators/Entity";
import { COLUMN_TOKEN } from "../../../decorators/Column";
import { resolveWhereClause, type WhereResolverOptions } from "../../WhereResolver";
import type { ColumnMetadata } from "../../../scanner/ColumnScanner";
import { attachWhereValueTransform } from "../../WhereValueTransform";
import { MetadataContext } from "../../../metadata/MetadataContext";
import { isValidPgIdentifier } from "../../../dialects/postgres/pgIdentifier";
import { runInternalQuery } from "../../entity-manager/internal-query";

/**
 * Options for creating a RawPipeline.
 */
export interface RawPipelineOptions<T> extends FindOption<T> {
  /** Number of rows per batch (default: 1000) */
  batchSize?: number;
  /**
   * Use keyset (cursor) pagination instead of LIMIT/OFFSET.
   * Requires `orderBy` to be set with exactly one column.
   * Much faster for large offsets because the DB can use an index seek.
   */
  keyset?: boolean;
}

/**
 * A mapped pipeline that yields transformed batches.
 */
export class MappedPipeline<U> {
  constructor(
    private readonly source: RawPipeline<any>,
    private readonly mapFn: (row: Record<string, unknown>) => U,
  ) {}

  async *raw(): AsyncGenerator<U[], void, undefined> {
    for await (const batch of this.source.raw()) {
      yield batch.map(this.mapFn);
    }
  }

  map<V>(fn: (row: U) => V): MappedPipeline<V> {
    const combined = (row: Record<string, unknown>) => fn(this.mapFn(row));
    return new MappedPipeline<V>(this.source, combined);
  }

  filter(predicate: (row: U) => boolean): FilteredMappedPipeline<U> {
    return new FilteredMappedPipeline(this.source, this.mapFn, predicate);
  }

  async collect(): Promise<U[]> {
    const all: U[] = [];
    for await (const batch of this.raw()) {
      all.push(...batch);
    }
    return all;
  }
}

/**
 * A filtered + mapped pipeline.
 */
export class FilteredMappedPipeline<U> {
  constructor(
    private readonly source: RawPipeline<any>,
    private readonly mapFn: (row: Record<string, unknown>) => U,
    private readonly predicate: (row: U) => boolean,
  ) {}

  async *raw(): AsyncGenerator<U[], void, undefined> {
    for await (const batch of this.source.raw()) {
      const mapped = batch.map(this.mapFn).filter(this.predicate);
      if (mapped.length > 0) yield mapped;
    }
  }

  async collect(): Promise<U[]> {
    const all: U[] = [];
    for await (const batch of this.raw()) {
      all.push(...batch);
    }
    return all;
  }
}

// ── Cached entity info ──────────────────────────────────────

interface EntityInfo {
  tableName: string;
  columns: ColumnMetadata[];
  propToCol: Map<string, string>;
  primaryKey: string | null;
}

const entityInfoCache = new WeakMap<Function, EntityInfo>();

/** The table and WHERE conditions every statement of one traversal shares. */
interface PipelineScope {
  table: string;
  where: Sql[];
}

function getEntityInfo(entity: ClazzType<any>, wrap: (s: string) => string): EntityInfo {
  let cached = entityInfoCache.get(entity);
  if (cached) return cached;

  const meta = Reflect.getMetadata(ENTITY_TOKEN, entity) as EntityMetadata | undefined;
  const tableName = meta?.name ?? entity.name;

  const columns: ColumnMetadata[] =
    Reflect.getMetadata(COLUMN_TOKEN, entity.prototype ?? entity) ?? [];

  const propToCol = new Map<string, string>();
  let primaryKey: string | null = null;
  for (const col of columns) {
    const prop = col.propertyKey ?? col.name;
    propToCol.set(prop, col.name);
    if (col.options?.primary || col.options?.autoIncrement) {
      primaryKey = col.name;
    }
  }

  attachWhereValueTransform(propToCol, columns);
  cached = { tableName, columns, propToCol, primaryKey };
  entityInfoCache.set(entity, cached);
  return cached;
}

/**
 * RawPipeline bypasses ORM entity transformation for large-data scenarios.
 *
 * Uses the same WHERE resolver as `em.find()` for query compatibility,
 * and supports keyset pagination for efficient large-offset traversal.
 * Every statement reads as the active tenant, as `em.find()` does.
 *
 * @example
 * ```ts
 * em.extend(rawPipelinePlugin());
 *
 * // Batched streaming (no entity transformation)
 * for await (const batch of em.pipe(User, { where: { active: true }, batchSize: 5000 }).raw()) {
 *   sendToGrpc(batch);
 * }
 *
 * // Keyset pagination for large datasets
 * for await (const batch of em.pipe(User, { orderBy: { id: "ASC" }, keyset: true }).raw()) {
 *   process(batch);
 * }
 * ```
 */
export class RawPipeline<T> {
  private readonly batchSize: number;
  private readonly info: EntityInfo;
  private readonly useKeyset: boolean;
  private readonly dialect: "mysql" | "postgres" | "sqlite" | undefined;

  constructor(
    private readonly ctx: PluginContext,
    private readonly entity: ClazzType<T>,
    private readonly options: RawPipelineOptions<T>,
  ) {
    this.batchSize = Math.max(options.batchSize ?? 1000, 1);
    this.info = getEntityInfo(entity, (s) => ctx.wrap(s));
    this.useKeyset = !!options.keyset && !!options.orderBy;

    // Detect dialect once at construction time
    if (ctx.isMySqlFamily()) this.dialect = "mysql";
    else if (ctx.isPostgres()) this.dialect = "postgres";
    else if (ctx.isSqlite()) this.dialect = "sqlite";
  }

  /**
   * Execute a query using the fastest available path.
   *
   * Prefers driver.queryWithOptions() (direct pool query, no transaction wrapper)
   * over em.query() (wraps each call in BEGIN/COMMIT) to avoid per-batch
   * transaction overhead on remote databases.
   */
  private async executeQuery(query: Sql): Promise<Record<string, unknown>[]> {
    const driver = this.ctx.driver;
    if (driver?.queryWithOptions) {
      return driver.queryWithOptions(query, {}) as Promise<Record<string, unknown>[]>;
    }
    // Fallback for drivers without queryWithOptions. Tenant-scoped like every
    // batch, so not raw SQL bypassing the tenant predicate.
    return runInternalQuery(() => this.ctx.em.query<Record<string, unknown>>(query));
  }

  /**
   * Yield batches of plain objects (no entity instantiation).
   */
  async *raw(): AsyncGenerator<Record<string, unknown>[], void, undefined> {
    const scope = this.resolveScope();
    if (this.useKeyset) {
      yield* this.rawKeyset(scope);
    } else {
      yield* this.rawOffset(scope);
    }
  }

  /**
   * LIMIT/OFFSET pagination.
   */
  private async *rawOffset(
    scope: PipelineScope,
  ): AsyncGenerator<Record<string, unknown>[], void, undefined> {
    let offset = 0;

    while (true) {
      const query = this.buildQuery(scope, offset);
      const rows = await this.executeQuery(query);

      if (rows.length === 0) break;
      yield rows;
      if (rows.length < this.batchSize) break;
      offset += this.batchSize;
    }
  }

  /**
   * Keyset (cursor) pagination — uses WHERE col > lastValue instead of OFFSET.
   * Requires orderBy with exactly one column.
   */
  private async *rawKeyset(
    scope: PipelineScope,
  ): AsyncGenerator<Record<string, unknown>[], void, undefined> {
    const orderEntries = Object.entries(this.options.orderBy ?? {});
    if (orderEntries.length === 0) {
      yield* this.rawOffset(scope);
      return;
    }

    const [orderProp, orderDir] = orderEntries[0];
    const orderCol = this.info.propToCol.get(orderProp) ?? orderProp;
    const isAsc = orderDir !== "DESC";

    let lastValue: unknown = null;
    let isFirst = true;

    while (true) {
      const query = this.buildKeysetQuery(scope, orderCol, isAsc, lastValue, isFirst);
      const rows = await this.executeQuery(query);

      if (rows.length === 0) break;
      yield rows;

      // Update cursor from last row
      const lastRow = rows[rows.length - 1];
      lastValue = lastRow[orderCol] ?? lastRow[orderProp];
      isFirst = false;

      if (rows.length < this.batchSize) break;
    }
  }

  /**
   * Yield batches using driver-level options (binary mode, array mode).
   */
  async *binary(
    driverOptions: DriverQueryOptions = { binary: true },
  ): AsyncGenerator<any[], void, undefined> {
    const driver = this.ctx.driver;
    if (!driver?.queryWithOptions) {
      yield* this.raw();
      return;
    }

    const scope = this.resolveScope();
    if (this.useKeyset) {
      yield* this.binaryKeyset(driver, driverOptions, scope);
    } else {
      yield* this.binaryOffset(driver, driverOptions, scope);
    }
  }

  private async *binaryOffset(
    driver: any,
    driverOptions: DriverQueryOptions,
    scope: PipelineScope,
  ): AsyncGenerator<any[], void, undefined> {
    let offset = 0;

    while (true) {
      const query = this.buildQuery(scope, offset);
      const rows = await driver.queryWithOptions(query, driverOptions);

      if (!rows || rows.length === 0) break;
      yield rows;
      if (rows.length < this.batchSize) break;
      offset += this.batchSize;
    }
  }

  private async *binaryKeyset(
    driver: any,
    driverOptions: DriverQueryOptions,
    scope: PipelineScope,
  ): AsyncGenerator<any[], void, undefined> {
    // arrayMode returns rows as arrays — cannot extract cursor by column name.
    // Fall back to offset pagination for arrayMode + keyset.
    if (driverOptions.arrayMode) {
      yield* this.binaryOffset(driver, driverOptions, scope);
      return;
    }

    const orderEntries = Object.entries(this.options.orderBy ?? {});
    if (orderEntries.length === 0) {
      yield* this.binaryOffset(driver, driverOptions, scope);
      return;
    }

    const [orderProp, orderDir] = orderEntries[0];
    const orderCol = this.info.propToCol.get(orderProp) ?? orderProp;
    const isAsc = orderDir !== "DESC";

    let lastValue: unknown = null;
    let isFirst = true;

    while (true) {
      const query = this.buildKeysetQuery(scope, orderCol, isAsc, lastValue, isFirst);
      const rows = await driver.queryWithOptions(query, driverOptions);

      if (!rows || rows.length === 0) break;
      yield rows;

      const lastRow = rows[rows.length - 1];
      lastValue = lastRow[orderCol] ?? lastRow[orderProp];
      isFirst = false;

      if (rows.length < this.batchSize) break;
    }
  }

  map<U>(fn: (row: Record<string, unknown>) => U): MappedPipeline<U> {
    return new MappedPipeline(this, fn);
  }

  filter(
    predicate: (row: Record<string, unknown>) => boolean,
  ): MappedPipeline<Record<string, unknown>> {
    const self = this;
    return new MappedPipeline<Record<string, unknown>>(
      {
        raw: async function* () {
          for await (const batch of self.raw()) {
            const filtered = batch.filter(predicate);
            if (filtered.length > 0) yield filtered;
          }
        },
      } as any,
      (r) => r,
    );
  }

  async collect(): Promise<Record<string, unknown>[]> {
    const all: Record<string, unknown>[] = [];
    for await (const batch of this.raw()) {
      all.push(...batch);
    }
    return all;
  }

  /**
   * Count rows matching the pipeline's WHERE clause.
   */
  async count(): Promise<number> {
    const { table, where } = this.resolveScope();

    let countSql: Sql;
    if (where.length > 0) {
      countSql = sql`SELECT COUNT(*) as cnt FROM ${raw(table)} WHERE ${join(where, " AND ")}`;
    } else {
      countSql = sql`SELECT COUNT(*) as cnt FROM ${raw(table)}`;
    }

    // Tenant-scoped like the batches, so not raw SQL bypassing the predicate.
    const result = await runInternalQuery(() =>
      this.ctx.em.query<{ cnt: number | string }>(countSql),
    );
    return Number(result[0]?.cnt ?? 0);
  }

  // ── SQL Building (reuses core WhereResolver) ─────────────

  /**
   * Build SELECT with LIMIT/OFFSET pagination.
   */
  private buildQuery(scope: PipelineScope, offset: number): Sql {
    const columns = this.resolveColumns();
    const orderByClause = this.resolveOrderBy();

    const parts: Sql[] = [sql`SELECT ${raw(columns)} FROM ${raw(scope.table)}`];

    if (scope.where.length > 0) {
      parts.push(sql`WHERE ${join(scope.where, " AND ")}`);
    }
    if (orderByClause) {
      parts.push(sql`ORDER BY ${raw(orderByClause)}`);
    }

    parts.push(sql`LIMIT ${this.batchSize}`);
    if (offset > 0) {
      parts.push(sql`OFFSET ${offset}`);
    }

    return join(parts, " ");
  }

  /**
   * Build SELECT with keyset (cursor) pagination.
   */
  private buildKeysetQuery(
    scope: PipelineScope,
    orderCol: string,
    isAsc: boolean,
    lastValue: unknown,
    isFirst: boolean,
  ): Sql {
    const columns = this.resolveColumns();
    const whereClauses = [...scope.where];
    const wrappedCol = this.ctx.wrap(orderCol);

    // Add keyset condition
    if (!isFirst && lastValue !== null && lastValue !== undefined) {
      const cursorCondition = isAsc
        ? sql`${raw(wrappedCol)} > ${lastValue as any}`
        : sql`${raw(wrappedCol)} < ${lastValue as any}`;
      whereClauses.push(cursorCondition);
    }

    const dir = isAsc ? "ASC" : "DESC";
    const parts: Sql[] = [sql`SELECT ${raw(columns)} FROM ${raw(scope.table)}`];

    if (whereClauses.length > 0) {
      parts.push(sql`WHERE ${join(whereClauses, " AND ")}`);
    }

    parts.push(sql`ORDER BY ${raw(wrappedCol)} ${raw(dir)}`);
    parts.push(sql`LIMIT ${this.batchSize}`);

    return join(parts, " ");
  }

  /**
   * The table and WHERE conditions of one traversal or one `count()`,
   * resolved once so every batch reads as the same tenant.
   */
  private resolveScope(): PipelineScope {
    return { table: this.resolveTable(), where: this.resolveWhere() };
  }

  /**
   * The table every statement names. Under the `search_path` strategy the ORM
   * selects a tenant's schema with `SET LOCAL search_path` inside the
   * transaction it reads in, and the batches run on a pooled connection with
   * no such transaction — so they name the tenant's schema themselves. A
   * tenant id the connector would not switch to (not a valid identifier) is
   * left out the same way, and a table pinned to a schema keeps its pin.
   */
  private resolveTable(): string {
    const table = this.info.tableName;
    if (this.dialect === "postgres") {
      const tenant = MetadataContext.getCurrentTenant();
      if (
        tenant !== "public" &&
        this.ctx.em.getTenantStrategy().needsTransactionForTenantRead() &&
        this.ctx.em.resolveEntitySchema(this.entity) === undefined &&
        isValidPgIdentifier(tenant)
      ) {
        return `${this.ctx.wrap(tenant)}.${this.ctx.wrap(table)}`;
      }
    }
    return this.ctx.wrapTable(table);
  }

  /**
   * The caller's `where`, resolved by the same WhereResolver as em.find(),
   * and the tenant predicate em.find() adds under `"tenant_column"`.
   */
  private resolveWhere(): Sql[] {
    const clauses: Sql[] = [];
    if (this.options.where) {
      const opts: WhereResolverOptions = {
        wrapColumn: (n) => this.ctx.wrap(n),
        propertyToColumn: this.info.propToCol,
        dialect: this.dialect,
      };
      clauses.push(...resolveWhereClause(this.options.where as WhereClause<T>, opts));
    }
    const tenant = this.ctx.tenantPredicate(this.entity);
    if (tenant) clauses.push(tenant);
    return clauses;
  }

  private resolveColumns(): string {
    if (this.options.select && Array.isArray(this.options.select)) {
      return (this.options.select as string[])
        .map((prop) => {
          const dbCol = this.info.propToCol.get(prop) ?? prop;
          return this.ctx.wrap(dbCol);
        })
        .join(", ");
    }
    return "*";
  }

  private resolveOrderBy(): string | null {
    if (!this.options.orderBy) return null;

    const parts: string[] = [];
    for (const [key, dir] of Object.entries(this.options.orderBy)) {
      const dbCol = this.info.propToCol.get(key) ?? key;
      const safeDir = dir === "DESC" ? "DESC" : "ASC";
      parts.push(`${this.ctx.wrap(dbCol)} ${safeDir}`);
    }
    return parts.length > 0 ? parts.join(", ") : null;
  }
}
