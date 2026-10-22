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
import { InheritanceResolver } from "../../InheritanceResolver";
import { RelationMetadataResolver } from "../../RelationMetadataResolver";
import { buildJoinedChildFromSource, isJoinedChild } from "../../JoinedChildSource";
import {
  buildTpcFromSource,
  isTpcPolymorphicRoot,
  type TpcSourceContext,
} from "../../TpcUnionSource";

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

/** Reads inheritance metadata off the classes; holds no state of its own. */
const inheritance = new InheritanceResolver();

/** The source and WHERE conditions every statement of one traversal shares. */
interface PipelineScope {
  /** The table, or the derived table an inheritance hierarchy is read from. */
  from: Sql;
  where: Sql[];
  /**
   * A second keyset column for a source whose ordering column repeats: the
   * discriminator of a TABLE_PER_CLASS root's UNION, whose tables number
   * their keys independently.
   */
  tiebreak?: string;
}

/** Where a keyset traversal resumes: the last row's ordering values. */
interface KeysetCursor {
  value: unknown;
  tie: unknown;
}

/**
 * A TABLE_PER_CLASS root reads every concrete table, so it resolves names
 * through its subclasses' columns as well — a read of the root filters and
 * orders by a subclass property as a read of that subclass does.
 */
function withSubclassColumns(entity: ClazzType<any>, info: EntityInfo): EntityInfo {
  const columns = [...info.columns];
  const propToCol = new Map(info.propToCol);
  for (const subclass of inheritance.getConcreteEntities(entity)) {
    if (subclass === entity) continue;
    for (const col of getEntityInfo(subclass).columns) {
      const prop = col.propertyKey ?? col.name;
      if (propToCol.has(prop)) continue;
      propToCol.set(prop, col.name);
      columns.push(col);
    }
  }
  attachWhereValueTransform(propToCol, columns);
  return { ...info, columns, propToCol };
}

function getEntityInfo(entity: ClazzType<any>): EntityInfo {
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
 * Every statement reads the rows `em.find()` reads: the active tenant's, and
 * for an inheritance hierarchy the entity's subtype — a single-table child's
 * rows only, a joined child's columns from both its tables, a
 * table-per-class root's rows from every concrete table.
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
  private relationResolver?: RelationMetadataResolver;

  constructor(
    private readonly ctx: PluginContext,
    private readonly entity: ClazzType<T>,
    private readonly options: RawPipelineOptions<T>,
  ) {
    this.batchSize = Math.max(options.batchSize ?? 1000, 1);
    const info = getEntityInfo(entity);
    this.info = isTpcPolymorphicRoot(inheritance, entity)
      ? withSubclassColumns(entity, info)
      : info;
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

    let cursor: KeysetCursor | null = null;

    while (true) {
      const query = this.buildKeysetQuery(scope, orderCol, isAsc, cursor);
      const rows = await this.executeQuery(query);

      if (rows.length === 0) break;
      yield rows;

      // Update cursor from last row
      cursor = this.cursorAfter(rows[rows.length - 1], scope, orderCol, orderProp);

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

    let cursor: KeysetCursor | null = null;

    while (true) {
      const query = this.buildKeysetQuery(scope, orderCol, isAsc, cursor);
      const rows = await driver.queryWithOptions(query, driverOptions);

      if (!rows || rows.length === 0) break;
      yield rows;

      cursor = this.cursorAfter(rows[rows.length - 1], scope, orderCol, orderProp);

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
    const { from, where } = this.resolveScope();

    let countSql: Sql;
    if (where.length > 0) {
      countSql = sql`SELECT COUNT(*) as cnt FROM ${from} WHERE ${join(where, " AND ")}`;
    } else {
      countSql = sql`SELECT COUNT(*) as cnt FROM ${from}`;
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

    const parts: Sql[] = [sql`SELECT ${raw(columns)} FROM ${scope.from}`];

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
    cursor: KeysetCursor | null,
  ): Sql {
    const columns = this.resolveColumns();
    const whereClauses = [...scope.where];
    const wrappedCol = this.ctx.wrap(orderCol);
    const wrappedTie = scope.tiebreak ? this.ctx.wrap(scope.tiebreak) : null;
    const op = raw(isAsc ? ">" : "<");

    // Add keyset condition
    if (cursor && cursor.value !== null && cursor.value !== undefined) {
      const value = cursor.value as any;
      whereClauses.push(
        wrappedTie
          ? sql`(${raw(wrappedCol)} ${op} ${value} OR (${raw(wrappedCol)} = ${value} AND ${raw(wrappedTie)} ${op} ${cursor.tie as any}))`
          : sql`${raw(wrappedCol)} ${op} ${value}`,
      );
    }

    const dir = isAsc ? "ASC" : "DESC";
    const parts: Sql[] = [sql`SELECT ${raw(columns)} FROM ${scope.from}`];

    if (whereClauses.length > 0) {
      parts.push(sql`WHERE ${join(whereClauses, " AND ")}`);
    }

    const order = wrappedTie
      ? `${wrappedCol} ${dir}, ${wrappedTie} ${dir}`
      : `${wrappedCol} ${dir}`;
    parts.push(sql`ORDER BY ${raw(order)}`);
    parts.push(sql`LIMIT ${this.batchSize}`);

    return join(parts, " ");
  }

  /** The cursor the next keyset batch resumes after. */
  private cursorAfter(
    lastRow: Record<string, unknown>,
    scope: PipelineScope,
    orderCol: string,
    orderProp: string,
  ): KeysetCursor {
    return {
      value: lastRow[orderCol] ?? lastRow[orderProp],
      tie: scope.tiebreak ? lastRow[scope.tiebreak] : undefined,
    };
  }

  /**
   * The source and WHERE conditions of one traversal or one `count()`,
   * resolved once so every batch reads as the same tenant.
   */
  private resolveScope(): PipelineScope {
    const tenantSchema = this.tenantSchema();
    const wrapTable = (name: string) => this.wrapTable(name, tenantSchema);
    const where = this.resolveWhere();

    if (isTpcPolymorphicRoot(inheritance, this.entity)) {
      return {
        from: buildTpcFromSource(this.sourceContext(wrapTable), this.entity),
        where,
        tiebreak: inheritance.getDiscriminatorColumn(this.entity)?.name ?? "dtype",
      };
    }
    const joined = isJoinedChild(inheritance, this.entity)
      ? buildJoinedChildFromSource(this.sourceContext(wrapTable), this.entity)
      : null;
    return { from: joined ?? raw(wrapTable(this.info.tableName)), where };
  }

  /** What the shared inheritance source builders read metadata and names through. */
  private sourceContext(wrapTable: (name: string) => string): TpcSourceContext {
    this.relationResolver ??= new RelationMetadataResolver();
    return {
      inheritanceResolver: inheritance,
      resolver: this.relationResolver,
      wrap: (n) => this.ctx.wrap(n),
      wrapTable,
      typedNullPadding: this.dialect === "postgres",
    };
  }

  /**
   * The schema the statements name for the active tenant, or null when the
   * connection's own setup already reads the right one. Under the
   * `search_path` strategy the ORM selects a tenant's schema with `SET LOCAL
   * search_path` inside the transaction it reads in, and the batches run on a
   * pooled connection with no such transaction — so they name the tenant's
   * schema themselves. A tenant id the connector would not switch to (not a
   * valid identifier) is left out the same way.
   */
  private tenantSchema(): string | null {
    if (this.dialect !== "postgres") return null;
    const tenant = MetadataContext.getCurrentTenant();
    if (
      tenant === "public" ||
      !this.ctx.em.getTenantStrategy().needsTransactionForTenantRead() ||
      !isValidPgIdentifier(tenant)
    ) {
      return null;
    }
    return tenant;
  }

  /**
   * A table as the statements name it: in the tenant's schema (see
   * {@link tenantSchema}), unless `wrapTable()` already names a schema — a
   * table pinned with `@Entity({ schema })` keeps its pin.
   */
  private wrapTable(tableName: string, tenantSchema: string | null): string {
    const wrapped = this.ctx.wrapTable(tableName);
    if (!tenantSchema || wrapped !== this.ctx.wrap(tableName)) return wrapped;
    return `${this.ctx.wrap(tenantSchema)}.${wrapped}`;
  }

  /**
   * The caller's `where`, resolved by the same WhereResolver as em.find(),
   * and the predicates em.find() adds: a single-table child's discriminator
   * and the tenant predicate under `"tenant_column"`.
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
    const subtype = inheritance.getSingleTableChildDiscriminator(this.entity);
    if (subtype) {
      clauses.push(sql`${raw(this.ctx.wrap(subtype.columnName))} = ${subtype.value}`);
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
