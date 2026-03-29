/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql, raw, join } from "sql-template-tag";
import type { PluginContext } from "../PluginContext";
import type { ClazzType } from "../../../utils/types";
import type { FindOption, WhereClause } from "../../../dialects/FindOption";
import type { DriverQueryOptions } from "../../../types/DriverQueryOptions";
import { ENTITY_TOKEN, type EntityMetadata } from "../../../decorators/Entity";
import { COLUMN_TOKEN } from "../../../decorators/Column";
import { resolveWhereClause, type WhereResolverOptions } from "../../WhereResolver";
import type { ColumnMetadata } from "../../../scanner/ColumnScanner";

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
    const prop = col.propertyKey ?? col.name!;
    propToCol.set(prop, col.name!);
    if (col.options?.primary || col.options?.autoIncrement) {
      primaryKey = col.name!;
    }
  }

  cached = { tableName, columns, propToCol, primaryKey };
  entityInfoCache.set(entity, cached);
  return cached;
}

/**
 * RawPipeline bypasses ORM entity transformation for large-data scenarios.
 *
 * Uses the same WHERE resolver as `em.find()` for query compatibility,
 * and supports keyset pagination for efficient large-offset traversal.
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

  constructor(
    private readonly ctx: PluginContext,
    private readonly entity: ClazzType<T>,
    private readonly options: RawPipelineOptions<T>,
  ) {
    this.batchSize = Math.max(options.batchSize ?? 1000, 1);
    this.info = getEntityInfo(entity, (s) => ctx.wrap(s));
    this.useKeyset = !!options.keyset && !!options.orderBy;
  }

  /**
   * Yield batches of plain objects (no entity instantiation).
   */
  async *raw(): AsyncGenerator<Record<string, unknown>[], void, undefined> {
    if (this.useKeyset) {
      yield* this.rawKeyset();
    } else {
      yield* this.rawOffset();
    }
  }

  /**
   * LIMIT/OFFSET pagination.
   */
  private async *rawOffset(): AsyncGenerator<Record<string, unknown>[], void, undefined> {
    let offset = 0;

    while (true) {
      const query = this.buildQuery(offset);
      const rows = await this.ctx.em.query<Record<string, unknown>>(query);

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
  private async *rawKeyset(): AsyncGenerator<Record<string, unknown>[], void, undefined> {
    const orderEntries = Object.entries(this.options.orderBy ?? {});
    if (orderEntries.length === 0) {
      yield* this.rawOffset();
      return;
    }

    const [orderProp, orderDir] = orderEntries[0];
    const orderCol = this.info.propToCol.get(orderProp) ?? orderProp;
    const isAsc = orderDir !== "DESC";

    let lastValue: unknown = null;
    let isFirst = true;

    while (true) {
      const query = this.buildKeysetQuery(orderCol, isAsc, lastValue, isFirst);
      const rows = await this.ctx.em.query<Record<string, unknown>>(query);

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

    if (this.useKeyset) {
      yield* this.binaryKeyset(driver, driverOptions);
    } else {
      yield* this.binaryOffset(driver, driverOptions);
    }
  }

  private async *binaryOffset(driver: any, driverOptions: DriverQueryOptions): AsyncGenerator<any[], void, undefined> {
    let offset = 0;

    while (true) {
      const query = this.buildQuery(offset);
      const rows = await driver.queryWithOptions(query, driverOptions);

      if (!rows || rows.length === 0) break;
      yield rows;
      if (rows.length < this.batchSize) break;
      offset += this.batchSize;
    }
  }

  private async *binaryKeyset(driver: any, driverOptions: DriverQueryOptions): AsyncGenerator<any[], void, undefined> {
    const orderEntries = Object.entries(this.options.orderBy ?? {});
    if (orderEntries.length === 0) {
      yield* this.binaryOffset(driver, driverOptions);
      return;
    }

    const [orderProp, orderDir] = orderEntries[0];
    const orderCol = this.info.propToCol.get(orderProp) ?? orderProp;
    const isAsc = orderDir !== "DESC";

    let lastValue: unknown = null;
    let isFirst = true;

    while (true) {
      const query = this.buildKeysetQuery(orderCol, isAsc, lastValue, isFirst);
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
    const wrappedTable = this.ctx.wrapTable(this.info.tableName);
    const whereClauses = this.resolveWhere();

    let countSql: Sql;
    if (whereClauses.length > 0) {
      countSql = sql`SELECT COUNT(*) as cnt FROM ${raw(wrappedTable)} WHERE ${join(whereClauses, " AND ")}`;
    } else {
      countSql = sql`SELECT COUNT(*) as cnt FROM ${raw(wrappedTable)}`;
    }

    const result = await this.ctx.em.query<{ cnt: number | string }>(countSql);
    return Number(result[0]?.cnt ?? 0);
  }

  // ── SQL Building (reuses core WhereResolver) ─────────────

  /**
   * Build SELECT with LIMIT/OFFSET pagination.
   */
  private buildQuery(offset: number): Sql {
    const wrappedTable = this.ctx.wrapTable(this.info.tableName);
    const columns = this.resolveColumns();
    const whereClauses = this.resolveWhere();
    const orderByClause = this.resolveOrderBy();

    const parts: Sql[] = [sql`SELECT ${raw(columns)} FROM ${raw(wrappedTable)}`];

    if (whereClauses.length > 0) {
      parts.push(sql`WHERE ${join(whereClauses, " AND ")}`);
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
    orderCol: string,
    isAsc: boolean,
    lastValue: unknown,
    isFirst: boolean,
  ): Sql {
    const wrappedTable = this.ctx.wrapTable(this.info.tableName);
    const columns = this.resolveColumns();
    const whereClauses = this.resolveWhere();
    const wrappedCol = this.ctx.wrap(orderCol);

    // Add keyset condition
    if (!isFirst && lastValue !== null && lastValue !== undefined) {
      const cursorCondition = isAsc
        ? sql`${raw(wrappedCol)} > ${lastValue as any}`
        : sql`${raw(wrappedCol)} < ${lastValue as any}`;
      whereClauses.push(cursorCondition);
    }

    const dir = isAsc ? "ASC" : "DESC";
    const parts: Sql[] = [sql`SELECT ${raw(columns)} FROM ${raw(wrappedTable)}`];

    if (whereClauses.length > 0) {
      parts.push(sql`WHERE ${join(whereClauses, " AND ")}`);
    }

    parts.push(sql`ORDER BY ${raw(wrappedCol)} ${raw(dir)}`);
    parts.push(sql`LIMIT ${this.batchSize}`);

    return join(parts, " ");
  }

  /**
   * Resolve WHERE clause using the same WhereResolver as em.find().
   */
  private resolveWhere(): Sql[] {
    if (!this.options.where) return [];

    const opts: WhereResolverOptions = {
      wrapColumn: (n) => this.ctx.wrap(n),
      propertyToColumn: this.info.propToCol,
    };

    // Detect dialect
    if (this.ctx.isMySqlFamily()) opts.dialect = "mysql";
    else if (this.ctx.isPostgres()) opts.dialect = "postgres";
    else if (this.ctx.isSqlite()) opts.dialect = "sqlite";

    return [...resolveWhereClause(this.options.where as WhereClause<T>, opts)];
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
