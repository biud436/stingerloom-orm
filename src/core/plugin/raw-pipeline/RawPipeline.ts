/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql, raw, join } from "../../../utils/sqlTag";
import type { PluginContext } from "../PluginContext";
import type { ClazzType } from "../../../utils/types";
import type { WhereClause } from "../../../dialects/FindOption";
import type { IOrderBy } from "../../../dialects/IOrderBy";
import type { DriverQueryOptions } from "../../../types/DriverQueryOptions";
import { ENTITY_TOKEN, type EntityMetadata } from "../../../decorators/Entity";
import { COLUMN_TOKEN } from "../../../decorators/Column";
import { resolveWhereClause, type WhereResolverOptions } from "../../WhereResolver";
import type { ColumnMetadata } from "../../../scanner/ColumnScanner";
import { attachWhereValueTransform } from "../../WhereValueTransform";
import { buildPropertyToColumnMap } from "../../PropertyColumnMap";
import { validateReadOptionShape } from "../../QueryOptionShape";
import {
  buildEntityColumnScope,
  validateReadIdentifiers,
  type ColumnNameScope,
} from "../../ColumnNameValidator";
import {
  collectTableComputedColumns,
  declaredComputedColumns,
} from "../../generators/entityColumns";
import {
  buildKeysetOrderBy,
  buildKeysetPredicate,
  cursorKeyOf,
  type KeysetPlan,
} from "../../entity-manager/CursorKeyset";
import type { DecodedCursorKey } from "../../CursorPagination";
import { InvalidQueryError } from "../../../errors";
import { MetadataContext } from "../../../metadata/MetadataContext";
import { isValidPgIdentifier } from "../../../dialects/postgres/pgIdentifier";
import { runInternalQuery } from "../../entity-manager/internal-query";
import { transactionStorage } from "../../../decorators/Transactional";
import { InheritanceResolver } from "../../InheritanceResolver";
import { RelationMetadataResolver } from "../../RelationMetadataResolver";
import { buildJoinedChildFromSource, isJoinedChild } from "../../JoinedChildSource";
import {
  buildTpcFromSource,
  isTpcPolymorphicRoot,
  type TpcSourceContext,
} from "../../TpcUnionSource";

/**
 * Options for creating a RawPipeline. `em.pipe()` rejects any other key,
 * and checks the property names in `where`, `orderBy` and `select` the way
 * `em.find()` does.
 */
export interface RawPipelineOptions<T> {
  /** Filter conditions, in the same syntax as `em.find()`. */
  where?: WhereClause<T> | WhereClause<T>[];
  /** Sort order by property, `"ASC"` or `"DESC"`. */
  orderBy?: IOrderBy<Partial<T>>;
  /** Properties to read. Default: every column. */
  select?: (keyof T)[];
  /** Number of rows per batch, a positive integer (default: 1000). */
  batchSize?: number;
  /**
   * Use keyset (cursor) pagination instead of LIMIT/OFFSET.
   * Requires `orderBy` with exactly one property, and a primary key, which
   * breaks ties between rows with the same ordering value.
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
  /** PK columns in declared order (the auto-increment column without a PK flag); empty without one. */
  primaryKeys: string[];
}

const entityInfoCache = new WeakMap<Function, EntityInfo>();

/** Reads inheritance metadata off the classes; holds no state of its own. */
const inheritance = new InheritanceResolver();

/** Reads relation metadata off the classes, for FK properties and sources. */
const relations = new RelationMetadataResolver();

/** The source and WHERE conditions every statement of one traversal shares. */
interface PipelineScope {
  /** The table, or the derived table an inheritance hierarchy is read from. */
  from: Sql;
  where: Sql[];
}

/** Runs one statement of a traversal and returns its rows. */
type BatchRunner = (query: Sql) => Promise<any[]>;

/** One `orderBy` entry: the property, its DB column and its direction. */
interface OrderKey {
  property: string;
  column: string;
  direction: "ASC" | "DESC";
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

  // The map find() resolves names with: @Column properties plus the FK
  // properties of @ManyToOne / @OneToOne relations (`authorId` → `author_id`).
  const propToCol = buildPropertyToColumnMap({ target: entity, columns }, relations);
  const pkColumns = columns.filter((col) => col.options?.primary);
  const primaryKeys = (
    pkColumns.length > 0 ? pkColumns : columns.filter((col) => col.options?.autoIncrement).slice(0, 1)
  ).map((col) => col.name);

  attachWhereValueTransform(propToCol, columns);
  cached = { tableName, columns, propToCol, primaryKeys };
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
  /** The `orderBy` keys, in order, with DB column names. */
  private readonly order: OrderKey[];
  /** Everything a keyset traversal pages by except the cursor; null for LIMIT/OFFSET. */
  private readonly keyset: Omit<KeysetPlan, "cursor"> | null;
  private readonly dialect: "mysql" | "postgres" | "sqlite" | undefined;

  /**
   * @throws InvalidQueryError when an option is unknown or malformed, when
   *   `where`, `orderBy` or `select` names something the entity does not
   *   have, or when `keyset` cannot page by the given `orderBy`.
   */
  constructor(
    private readonly ctx: PluginContext,
    private readonly entity: ClazzType<T>,
    private readonly options: RawPipelineOptions<T>,
  ) {
    validateReadOptionShape(options, "pipe", entity.name, "pipe");
    this.batchSize = options.batchSize ?? 1000;
    const info = getEntityInfo(entity);
    this.info = isTpcPolymorphicRoot(inheritance, entity)
      ? withSubclassColumns(entity, info)
      : info;
    validateReadIdentifiers(
      { where: options.where, orderBy: options.orderBy },
      options.select as string[] | undefined,
      this.columnScope(),
    );
    this.order = this.resolveOrder();
    this.keyset = options.keyset ? this.planKeyset() : null;

    // Detect dialect once at construction time
    if (ctx.isMySqlFamily()) this.dialect = "mysql";
    else if (ctx.isPostgres()) this.dialect = "postgres";
    else if (ctx.isSqlite()) this.dialect = "sqlite";
  }

  /**
   * The names a `find()` of the entity accepts: its columns and their
   * properties, FK properties, computed columns and, in a hierarchy, the
   * columns of the classes sharing its rows and the discriminator.
   */
  private columnScope(): ColumnNameScope {
    const computed = collectTableComputedColumns(this.entity).map((c) => c.name);
    if (isTpcPolymorphicRoot(inheritance, this.entity)) {
      for (const subclass of inheritance.getConcreteEntities(this.entity)) {
        computed.push(...declaredComputedColumns(subclass).map((c) => c.name));
      }
    }
    return buildEntityColumnScope({
      entity: this.entity,
      metadata: { columns: this.info.columns },
      propertyToColumn: this.info.propToCol,
      computedColumns: computed,
      inheritanceResolver: inheritance,
    });
  }

  /**
   * The `orderBy` keys with DB column names. A falsy direction leaves the
   * property out, and a direction reads in either case, as in `find()`.
   */
  private resolveOrder(): OrderKey[] {
    const keys: OrderKey[] = [];
    for (const [prop, direction] of Object.entries(this.options.orderBy ?? {})) {
      if (!direction) continue;
      keys.push({
        property: prop,
        column: this.info.propToCol.get(prop) ?? prop,
        direction: String(direction).toUpperCase() === "DESC" ? "DESC" : "ASC",
      });
    }
    return keys;
  }

  /**
   * How a keyset traversal pages, the way `findWithCursor` does: by the
   * ordering column, then the primary key (every column of a composite
   * one), so rows that share an ordering value are neither skipped nor
   * repeated at a batch boundary, with NULLs
   * kept together at the end (ASC) or the start (DESC) on every dialect. A
   * table-per-class root adds its discriminator, since its tables number
   * their keys independently.
   */
  private planKeyset(): Omit<KeysetPlan, "cursor"> {
    if (this.order.length !== 1) {
      throw new InvalidQueryError(
        this.order.length === 0
          ? `keyset: true needs an orderBy to page by, for entity "${this.entity.name}".`
          : `keyset: true pages by one column, but the orderBy for entity "${this.entity.name}" names ${this.order.length} (${this.order.map((key) => key.property).join(", ")}).`,
        this.order.length === 0
          ? `Write { orderBy: { id: "ASC" }, keyset: true }.`
          : `Order by one property, or drop keyset to sort by several (LIMIT/OFFSET batches).`,
      );
    }
    const pkColumns = this.info.primaryKeys;
    if (pkColumns.length === 0) {
      throw new InvalidQueryError(
        `keyset: true needs a primary key on "${this.entity.name}" to tell apart rows with the same ordering value.`,
        "Drop keyset to read in LIMIT/OFFSET batches.",
      );
    }
    const [{ column, direction }] = this.order;
    return {
      orderColumn: column,
      pkColumns,
      isPkOrder: column === pkColumns[0],
      subKeyColumn: isTpcPolymorphicRoot(inheritance, this.entity)
        ? (inheritance.getDiscriminatorColumn(this.entity)?.name ?? "dtype")
        : undefined,
      direction,
      pageSize: this.batchSize,
    };
  }

  /**
   * How one traversal runs its statements, chosen once so every batch runs on
   * the same connection. Inside a transaction (`em.transaction()`,
   * `@Transactional`) that is the transaction's own connection, so the
   * batches read its uncommitted writes and its snapshot, as `count()` and
   * `find()` there do. Otherwise each batch is a direct pool query, without
   * the BEGIN/COMMIT that would add two round-trips per batch on a remote
   * database. Null when the driver cannot run a query with driver-level
   * options.
   */
  private batchRunner(driverOptions: DriverQueryOptions): BatchRunner | null {
    const session = transactionStorage.getStore();
    if (session) return (query) => session.queryWithOptions(query, driverOptions);
    const driver = this.ctx.driver;
    if (driver?.queryWithOptions) {
      return (query) => driver.queryWithOptions!(query, driverOptions);
    }
    return null;
  }

  /**
   * Yield batches of plain objects (no entity instantiation).
   */
  async *raw(): AsyncGenerator<Record<string, unknown>[], void, undefined> {
    const scope = this.resolveScope();
    // A driver without queryWithOptions runs the batches through em.query().
    // Tenant-scoped like every batch, so not raw SQL bypassing the predicate.
    const run =
      this.batchRunner({}) ??
      ((query: Sql) => runInternalQuery(() => this.ctx.em.query<Record<string, unknown>>(query)));
    yield* this.batches(scope, run, true);
  }

  /**
   * Yield batches using driver-level options (binary mode, array mode).
   */
  async *binary(
    driverOptions: DriverQueryOptions = { binary: true },
  ): AsyncGenerator<any[], void, undefined> {
    const run = this.batchRunner(driverOptions);
    if (!run) {
      yield* this.raw();
      return;
    }
    // arrayMode returns rows as arrays — cannot extract cursor by column name.
    // Fall back to offset pagination for arrayMode + keyset.
    yield* this.batches(this.resolveScope(), run, !driverOptions.arrayMode);
  }

  /**
   * Keyset pagination when it was asked for and the rows can carry the
   * cursor (rows keyed by column name), LIMIT/OFFSET otherwise.
   */
  private batches(
    scope: PipelineScope,
    run: BatchRunner,
    rowsByName: boolean,
  ): AsyncGenerator<any[], void, undefined> {
    return this.keyset && rowsByName
      ? this.keysetBatches(scope, run, this.keyset)
      : this.offsetBatches(scope, run);
  }

  /**
   * LIMIT/OFFSET pagination.
   */
  private async *offsetBatches(
    scope: PipelineScope,
    run: BatchRunner,
  ): AsyncGenerator<any[], void, undefined> {
    let offset = 0;

    while (true) {
      const rows = await run(this.buildQuery(scope, offset));

      if (!rows || rows.length === 0) break;
      yield rows;
      if (rows.length < this.batchSize) break;
      offset += this.batchSize;
    }
  }

  /**
   * Keyset (cursor) pagination — each batch starts after the previous
   * batch's last row instead of at an OFFSET.
   */
  private async *keysetBatches(
    scope: PipelineScope,
    run: BatchRunner,
    plan: Omit<KeysetPlan, "cursor">,
  ): AsyncGenerator<any[], void, undefined> {
    let cursor: DecodedCursorKey | null = null;

    while (true) {
      const rows = await run(this.buildKeysetQuery(scope, { ...plan, cursor }));

      if (!rows || rows.length === 0) break;
      yield rows;

      cursor = cursorKeyOf(plan, rows[rows.length - 1]);

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
  private buildKeysetQuery(scope: PipelineScope, plan: KeysetPlan): Sql {
    const wrap = (n: string) => this.ctx.wrap(n);
    const whereClauses = [...scope.where];
    const after = buildKeysetPredicate(plan, wrap);
    if (after) whereClauses.push(after);

    const parts: Sql[] = [sql`SELECT ${raw(this.resolveColumns())} FROM ${scope.from}`];

    if (whereClauses.length > 0) {
      parts.push(sql`WHERE ${join(whereClauses, " AND ")}`);
    }

    const order = buildKeysetOrderBy(plan, wrap)
      .map((key) => `${key.column} ${key.direction}`)
      .join(", ");
    parts.push(sql`ORDER BY ${raw(order)}`);
    parts.push(sql`LIMIT ${this.batchSize}`);

    return join(parts, " ");
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
      };
    }
    const joined = isJoinedChild(inheritance, this.entity)
      ? buildJoinedChildFromSource(this.sourceContext(wrapTable), this.entity)
      : null;
    return { from: joined ?? raw(wrapTable(this.info.tableName)), where };
  }

  /** What the shared inheritance source builders read metadata and names through. */
  private sourceContext(wrapTable: (name: string) => string): TpcSourceContext {
    return {
      inheritanceResolver: inheritance,
      resolver: relations,
      wrap: (n) => this.ctx.wrap(n),
      wrapTable,
      typedNullPadding: this.dialect === "postgres",
    };
  }

  /**
   * The schema the statements name for the active tenant, or null when the
   * connection's own setup already reads the right one. Under the
   * `search_path` strategy the ORM selects a tenant's schema with `SET LOCAL
   * search_path` inside the transaction it reads in, and outside a transaction
   * the batches run on a pooled connection with no such setting — so they
   * name the tenant's schema themselves. A tenant id the connector would not
   * switch to (not a valid identifier) is left out the same way.
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

  /**
   * The SELECT list. A keyset traversal also reads the columns it pages by
   * when `select` leaves them out: it resumes from the last row's values.
   */
  private resolveColumns(): string {
    if (!this.options.select) return "*";
    const columns = (this.options.select as string[]).map(
      (prop) => this.info.propToCol.get(prop) ?? prop,
    );
    if (this.keyset) {
      const { orderColumn, pkColumns, subKeyColumn } = this.keyset;
      for (const key of [orderColumn, ...pkColumns, subKeyColumn]) {
        if (key && !columns.includes(key)) columns.push(key);
      }
    }
    return columns.map((column) => this.ctx.wrap(column)).join(", ");
  }

  private resolveOrderBy(): string | null {
    if (this.order.length === 0) return null;
    return this.order
      .map((key) => `${this.ctx.wrap(key.column)} ${key.direction}`)
      .join(", ");
  }
}
