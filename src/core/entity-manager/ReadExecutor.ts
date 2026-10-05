/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType, Logger, resolveEntityGlobs, generateUUIDv7 } from "../../utils";
import { ColumnMetadata, EntityScannerMetadata, MetadataLayerRegistry } from "../../scanner";
import type { ManyToOneMetadata, OneToOneMetadata } from "../../decorators";
import { ISqlDriver } from "../../dialects/SqlDriver";
import { TransactionSessionManager } from "../../dialects/TransactionSessionManager";
import { FindOption, LockMode, UpdateData, UpdateManyOptions, WhereClause } from "../../dialects/FindOption";
import { resolveWhereClause } from "../WhereResolver";
import sql, { Sql, join, raw } from "../../utils/sqlTag";
import { QueryResult } from "../../types/QueryResult";
import { EntityResult } from "../../types/EntityResult";
import { RawQueryBuilderFactory } from "../RawQueryBuilderFactory";
import type { BaseRawQueryBuilder } from "../BaseRawQueryBuilder";
import { Conditions } from "../Conditions";
import { ResultTransformerFactory } from "../ResultTransformerFactory";
import {
  joinedColumnAlias,
  type JoinedRelations,
  type ResultTransformer,
  type RowClassifier,
} from "../ResultTransformer";
import { injectLazyProxy } from "../LazyLoader";
import { MetadataContext } from "../../metadata/MetadataContext";
import { EntityMetadataNotFoundError } from "../../errors/EntityMetadataNotFoundError";
import { InvalidQueryError } from "../../errors/InvalidQueryError";
import { EntityNotFoundError } from "../../errors/EntityNotFoundError";
import {
  CursorPaginationOption,
  CursorPaginationResult,
  decodeCursorKey,
  type DecodedCursorKey,
  normalizePageSize,
} from "../CursorPagination";
import {
  buildKeysetOrderBy,
  buildKeysetPredicate,
  encodeNextCursor,
  sliceCursorPage,
  type KeysetPlan,
} from "./CursorKeyset";
import {
  PagePaginationOption,
  PagePaginationResult,
  normalizePage,
} from "../PagePagination";
import { EntityManagerInternals } from "../EntityManagerInternals";
import { RelationMetadataResolver } from "../RelationMetadataResolver";
import {
  requestedRelationNames,
  resolveRelationTree,
  type RelationTree,
} from "../RelationTree";
import {
  assertWhereNotVacuous,
  buildEntityColumnScope,
  validateReadIdentifiers,
} from "../ColumnNameValidator";
import { RelationLoader } from "../RelationLoader";
import {
  RelationWhereFilterBuilder,
  relationAwareScope,
  validateRelationCountIdentifiers,
  validateRelationOptionIdentifiers,
} from "../RelationWhereFilter";
import { resolveRelationCounts, type RelationCountSpec } from "../RelationCount";
import { AggregateQueryHandler } from "../AggregateQueryHandler";
import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";
import { InheritanceResolver } from "../InheritanceResolver";
import {
  buildTpcUnionSource,
  isTpcPolymorphicRoot,
  pruneTpcSiblingColumns,
  TPC_UNION_ALIAS,
  tpcSourceContextOf,
  type TpcSourceContext,
} from "../TpcUnionSource";
import {
  buildJoinedChildSelect,
  buildJoinedRootSelect,
  isJoinedChild,
  isJoinedPolymorphicRoot,
  JOINED_CHILD_ALIAS,
  joinedRootColumns,
  joinedSubclassColumns,
  joinedSubclassPrefixes,
} from "../JoinedChildSource";
import { polymorphicRowClassifier } from "../PolymorphicRows";
import { createDialectExpression } from "../../dialects/DialectExpression";
import { singleTableRowShape, type RowShape } from "../SingleTableRows";

/**
 * Per-entity read-path column plan: the physical SELECT list (plain and
 * table-qualified wrapped forms), relation metadata, and driver-specific
 * derived lists that findInternal would otherwise rebuild on every query.
 */
interface ReadColumnPlan {
  /** Dialect the wrapped identifier strings were produced for. */
  dialect: string | undefined;
  /** @Column names + @RelationColumn-derived FK columns without a matching @Column. */
  allColNames: string[];
  /** allColNames wrapped: `"col"`. */
  selectPlain: string[];
  /** allColNames qualified + wrapped: `"table"."col"`. */
  selectQualified: string[];
  /** Column names of boolean columns (SQLite INTEGER 0/1 → boolean read fix-up). */
  boolColumns: string[];
  /** Resolved ManyToOne relation metadata (joinColumn already resolved). */
  manyToOne: ManyToOneMetadata<any>[];
  /** Resolved OneToOne relation metadata. */
  oneToOne: OneToOneMetadata<any>[];
  /** manyToOne entries with `eager: true` (the no-`relations`-option filter result). */
  eagerM2O: ManyToOneMetadata<any>[];
  /** Owning-side oneToOne entries with `eager: true`. */
  eagerO2O: OneToOneMetadata<any>[];
}

/**
 * Everything {@link ReadExecutor.findInternal} resolves once up front and
 * every clause builder below then reads: the entity's metadata view, its
 * cached column plan, the inheritance shape of the query, and the eager
 * relations that turn the read into a JOIN.
 *
 * Assembled by {@link ReadExecutor.prepareFindOperation}; treated as
 * read-only by the helpers that receive it.
 */
interface FindOperation<T> {
  entity: ClazzType<T>;
  findOption: FindOption<T>;
  metadata: EntityScannerMetadata;
  /**
   * Name the read's FROM source is addressed by: the physical table of
   * `entity` (the child table for a TPT child), or the UNION ALL alias for a
   * TPC polymorphic root.
   */
  tableName: string;
  plan: ReadColumnPlan;
  /** Entity property name → DB column name, built once per call. */
  propToCol: Map<string, string>;
  inheritanceStrategy: ReturnType<InheritanceResolver["getStrategy"]>;
  /** JOINED strategy, querying a child: its own table INNER JOINs the root. */
  isTPTChild: boolean;
  /** JOINED strategy, querying the root polymorphically: LEFT JOIN every child. */
  isTPTPolymorphic: boolean;
  /** TABLE_PER_CLASS root query: FROM is a UNION ALL over the hierarchy. */
  isTPCPolymorphic: boolean;
  /** ManyToOne relations JOINed into this read. */
  eagerM2O: ManyToOneMetadata<any>[];
  /** Owning-side OneToOne relations JOINed into this read. */
  eagerO2O: OneToOneMetadata<any>[];
  /** True when the statement carries any JOIN, so columns must be qualified. */
  hasEagerJoins: boolean;
  /**
   * TPT child only: qualifies a DB column with the table that physically
   * holds it (parent for inherited columns, child otherwise). Undefined for
   * every other shape, where {@link ReadExecutor.qualifyColumn} falls back to
   * the plain `hasEagerJoins` rule.
   */
  tptQualifyColumn?: (dbCol: string) => string;
  /**
   * Primary-key DB columns the SELECT list adds to the caller's `select`
   * because a requested relation is matched to each parent by them — see
   * {@link ReadExecutor.resolveAddedKeyColumns}. Empty for every other shape.
   */
  addedKeyColumns: string[];
  /** The read's `relations`, normalized; undefined when it named none. */
  relationTree: RelationTree | undefined;
  /** The read's `withCount`, normalized; undefined when it counts nothing. */
  relationCounts: RelationCountSpec[] | undefined;
}

/**
 * The page order {@link ReadExecutor.findWithCursor} resolves up front from
 * the entity metadata and the caller's option — see
 * {@link ReadExecutor.resolveCursorOrder}.
 */
interface CursorOrder<T> {
  /** PK column: default order key and the keyset tiebreaker. Undefined when the entity has none. */
  pk: ColumnMetadata | undefined;
  /** Property (or, by default, PK column) name the page is ordered by. */
  orderByColumn: keyof T & string;
  direction: "ASC" | "DESC";
  pageSize: number;
  /** Decoded cursor of the previous page; null on the first page. */
  cursorKey: DecodedCursorKey | null;
}

/**
 * Executes all read operations (find / findOne / pagination / pluck /
 * exists / findByPK*) for EntityManager. Stateless beyond the services it
 * reads from {@link EntityManagerInternals}.
 *
 * @internal Package-internal — not a public API.
 */
export class ReadExecutor {
  constructor(private readonly ctx: EntityManagerInternals) {}

  /**
   * Column-plan cache keyed on (merged metadata view, entity metadata)
   * identity — the same invalidation scheme as EntityManager.
   * buildPropertyToColumnMap(): any layer change mints a new merged view,
   * so tenant overrides never share entries with public. The dialect is
   * re-checked on hit because the wrapped identifier strings depend on the
   * active driver (test-time driver swaps must not serve stale quoting).
   */
  private readonly columnPlanCache = new WeakMap<
    object,
    WeakMap<object, ReadColumnPlan>
  >();

  private getColumnPlan(
    entity: ClazzType<any>,
    metadata: { name: string; columns: ColumnMetadata[] },
  ): ReadColumnPlan {
    const mergedView = MetadataLayerRegistry.getInstance().resolveAll();
    let byMetadata = this.columnPlanCache.get(mergedView);
    if (!byMetadata) {
      byMetadata = new WeakMap();
      this.columnPlanCache.set(mergedView, byMetadata);
    }
    const dialect = this.ctx.getDbType();
    const hit = byMetadata.get(metadata);
    if (hit && hit.dialect === dialect) return hit;

    const manyToOne = this.resolver.resolveManyToOneMetadata(entity);
    const oneToOne = this.resolver.resolveOneToOneMetadata(entity);

    // Full physical column set: @Column items + @RelationColumn-derived FK
    // columns (joinColumn) that have no matching @Column. Without the FK
    // columns the entity's shadow `${rel}Id` accessor stays undefined after
    // findOne, even though INSERT/UPDATE persist them.
    const allColNames = metadata.columns
      .map((c) => c.name as string | undefined)
      .filter((n): n is string => !!n);
    const seen = new Set<string>(allColNames);
    for (const rel of manyToOne) {
      if (rel.joinColumn && !seen.has(rel.joinColumn)) {
        allColNames.push(rel.joinColumn);
        seen.add(rel.joinColumn);
      }
    }
    for (const rel of oneToOne) {
      if (rel.joinColumn && !seen.has(rel.joinColumn)) {
        allColNames.push(rel.joinColumn);
        seen.add(rel.joinColumn);
      }
    }
    // @ComputedColumn values: the SELECT list is enumerated from
    // metadata.columns, so generated columns must be merged explicitly —
    // without this, find/findOne silently returned undefined for them even
    // when the DB column existed.
    for (const name of this.ctx.getComputedColumnNames(entity)) {
      if (!seen.has(name)) {
        allColNames.push(name);
        seen.add(name);
      }
    }

    const wrappedTable = this.ctx.wrap(metadata.name);
    const plan: ReadColumnPlan = {
      dialect,
      allColNames,
      selectPlain: allColNames.map((n) => this.ctx.wrap(n)),
      selectQualified: allColNames.map(
        (n) => `${wrappedTable}.${this.ctx.wrap(n)}`,
      ),
      boolColumns: metadata.columns
        .filter((c) => c.options?.type === "boolean")
        .map((c) => c.name),
      manyToOne,
      oneToOne,
      eagerM2O: manyToOne.filter((rel) => rel.option?.eager === true),
      eagerO2O: oneToOne.filter(
        (rel) => !!rel.joinColumn && rel.option?.eager === true,
      ),
    };
    byMetadata.set(metadata, plan);
    return plan;
  }

  /**
   * The name a cursor page's FROM source is addressed by — see
   * {@link findWithCursor}: the UNION ALL alias for a TABLE_PER_CLASS root,
   * the derived table for a JOINED child or root, the table otherwise.
   */
  private cursorSourceName(entity: ClazzType<any>): string {
    if (isTpcPolymorphicRoot(this.inheritanceResolver, entity)) return TPC_UNION_ALIAS;
    if (isJoinedChild(this.inheritanceResolver, entity) || this.isTptPolymorphicRoot(entity)) {
      return JOINED_CHILD_ALIAS;
    }
    return this.resolver.resolveEntityMetadata(entity)?.name ?? entity.name;
  }

  /**
   * Rejects a `where` / `orderBy` key in a relation's options that names no
   * column of the related entity — the guard the read's own options get —
   * before any statement runs, at every level of the tree.
   */
  private validateRelationOptionIdentifiers(
    entity: ClazzType<any>,
    tree: RelationTree | undefined,
  ): void {
    validateRelationOptionIdentifiers(this.ctx, this.resolver, entity, tree);
  }

  /**
   * Normalizes and validates a read's `withCount` — the relations, the
   * properties the counts are written to and the columns each count's
   * where names — before any statement runs.
   */
  private resolveRelationCounts(
    entity: ClazzType<any>,
    withCount: unknown,
  ): RelationCountSpec[] | undefined {
    const counts = resolveRelationCounts(entity, withCount, this.resolver);
    validateRelationCountIdentifiers(this.ctx, this.resolver, entity, counts);
    return counts;
  }

  /**
   * The physical column names a read of `entity` selects — the column plan's
   * `allColNames`. Relation loaders read related entities through it so they
   * hydrate with the same properties `find()` gives them.
   */
  readColumnNames(
    entity: ClazzType<any>,
    metadata: { name: string; columns: ColumnMetadata[] },
  ): readonly string[] {
    return this.getColumnPlan(entity, metadata).allColNames;
  }

  /**
   * The ManyToOne and owning-side OneToOne relations a read attaches: every
   * `eager: true` relation plus those `relations` names. `find()` JOINs
   * them; a cursor page batch-loads them — same set either way.
   */
  private resolveToOneRelations(
    plan: ReadColumnPlan,
    relations: readonly string[] | undefined,
  ): { eagerM2O: ManyToOneMetadata<any>[]; eagerO2O: OneToOneMetadata<any>[] } {
    if (!relations) return { eagerM2O: plan.eagerM2O, eagerO2O: plan.eagerO2O };
    return {
      eagerM2O: plan.manyToOne.filter(
        (rel) => rel.option?.eager === true || relations.includes(rel.columnName),
      ),
      // Owning side only — the side with the joinColumn.
      eagerO2O: plan.oneToOne.filter(
        (rel) =>
          !!rel.joinColumn &&
          (rel.option?.eager === true || relations.includes(rel.propertyKey)),
      ),
    };
  }

  // Narrowable driver view + live collaborators (read at call time so test-time
  // reassignment on EntityManager is honored).
  private get driver(): ISqlDriver | undefined { return this.ctx.getDriver(); }
  private get resolver(): RelationMetadataResolver { return this.ctx.getResolver(); }

  /** The resolvers and identifier wrappers a TPC UNION ALL source is built with. */
  private tpcSourceContext(): TpcSourceContext {
    return tpcSourceContextOf(this.ctx, this.resolver);
  }
  private get inheritanceResolver(): InheritanceResolver { return this.ctx.getInheritanceResolver(); }
  private get relationLoader(): RelationLoader { return this.ctx.getRelationLoader(); }
  private get aggregateHandler(): AggregateQueryHandler { return this.ctx.getAggregateHandler(); }
  private get defaultQueryTimeout(): number | undefined { return this.ctx.getDefaultQueryTimeout(); }

  /**
   * The rows of a TPC root read with each row limited to its own table's
   * columns — see {@link pruneTpcSiblingColumns}.
   */
  /** How a row of `entity` is built as its subclass — see {@link polymorphicRowClassifier}. */
  private rowClassifier(entity: ClazzType<any>): RowClassifier | undefined {
    return polymorphicRowClassifier(
      { inheritanceResolver: this.inheritanceResolver, resolver: this.resolver },
      entity,
    );
  }

  /** The SINGLE_TABLE row shape of `entity` — see {@link singleTableRowShape}. */
  private singleTableShape(entity: ClazzType<any>): RowShape | undefined {
    return singleTableRowShape(
      { inheritanceResolver: this.inheritanceResolver, resolver: this.resolver },
      entity,
    );
  }

  private pruneTpcRows(
    root: ClazzType<any>,
    queryResult: QueryResult,
    discriminatorColumnName: string,
  ): QueryResult {
    const results = pruneTpcSiblingColumns(
      this.tpcSourceContext(),
      root,
      queryResult.results,
      discriminatorColumnName,
    );
    return results === queryResult.results
      ? queryResult
      : { ...queryResult, results };
  }

  /**
   * The timeout a read should run under: the per-query option when given,
   * otherwise the connection-level `queryTimeout`.
   *
   * Every read entry point resolves it the same way. Passing only the
   * per-query value (as findAndCount did) left the connection-level default to
   * be applied deeper in the call stack, on a session PostgreSQL had already
   * decided not to wrap in a transaction — where `SET LOCAL` does nothing.
   */
  private resolveTimeout(option?: { timeout?: number }): number | undefined {
    return option?.timeout ?? this.defaultQueryTimeout;
  }

  async findOne<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T>,
  ): Promise<T | null> {
    // Public entry only: save()'s readbacks call findOneInternal directly.
    assertWhereNotVacuous(findOption?.where, "findOne", entity.name);
    return this.ctx.findOneInternal(entity, findOption);
  }

  async findOneBy<T>(
    entity: ClazzType<T>,
    where: WhereClause<T> | WhereClause<T>[],
  ): Promise<T | null> {
    assertWhereNotVacuous(where, "findOneBy", entity.name);
    return this.ctx.findOne(entity, { where });
  }

  async findOneInternal<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T>,
    existingSession?: TransactionSessionManager,
  ): Promise<T | null> {
    // A TPC root looked up by PK reads one extra row: the concrete tables
    // number their own PKs, so the same value can name a row per subtype and
    // the first one would win silently. See warnIfTpcPkAmbiguous.
    const probeAmbiguity = this.isTpcPkLookup(entity, findOption.where);
    const result = await this.ctx.findInternal<T>(
      entity,
      { ...findOption, limit: probeAmbiguity ? 2 : 1 },
      existingSession,
    );
    if (result === undefined || result === null) {
      return null;
    }
    if (Array.isArray(result)) {
      if (probeAmbiguity && result.length > 1) {
        this.warnIfTpcPkAmbiguous(entity);
      }
      return (result[0] as T) ?? null;
    }
    return result as T;
  }

  /** Entities already warned about a PK matching several TPC subtypes. */
  private readonly tpcPkAmbiguityWarned = new Set<string>();

  /**
   * True for a findOne on a TABLE_PER_CLASS root whose `where` names the
   * primary key (by property or DB column) at the top level of any branch.
   */
  private isTpcPkLookup<T>(
    entity: ClazzType<T>,
    where: FindOption<T>["where"],
  ): boolean {
    if (!where || !isTpcPolymorphicRoot(this.inheritanceResolver, entity)) {
      return false;
    }
    const metadata = this.resolver.resolveEntityMetadata(entity);
    const pk = metadata?.columns.find(
      (column: ColumnMetadata) => column.options?.primary,
    );
    if (!pk) return false;
    const pkKeys = new Set<string>([pk.name, String(pk.propertyKey ?? pk.name)]);
    const branches = Array.isArray(where) ? where : [where];
    return branches.some(
      (branch) =>
        branch !== null &&
        typeof branch === "object" &&
        Object.keys(branch).some((key) => pkKeys.has(key)),
    );
  }

  /**
   * Once per root: a PK lookup matched rows in more than one concrete
   * table. TPC does not make PKs unique across subtypes (each table
   * generates its own), so the caller got the first subtype's row.
   */
  private warnIfTpcPkAmbiguous<T>(entity: ClazzType<T>): void {
    if (this.tpcPkAmbiguityWarned.has(entity.name)) return;
    this.tpcPkAmbiguityWarned.add(entity.name);
    this.ctx.getLogger().warn(
      `[Inheritance] findOne(${entity.name}) by primary key matched rows in more than one ` +
        `TABLE_PER_CLASS subtype and returned the first. TPC does not guarantee PK uniqueness ` +
        `across subtypes (each concrete table generates its own keys). Use a shared sequence or ` +
        `UUID primary keys, or query the concrete subclass instead.`,
    );
  }

  async find<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T> = {},
  ): Promise<T[]> {
    const result = await this.ctx.findInternal(entity, findOption);
    if (result === undefined || result === null) return [];
    if (Array.isArray(result)) return result as T[];
    return [result as T];
  }

  async findBy<T>(
    entity: ClazzType<T>,
    where: WhereClause<T> | WhereClause<T>[],
  ): Promise<T[]> {
    return this.ctx.find(entity, { where });
  }

  async pluck<T, K extends keyof T & string>(
    entity: ClazzType<T>,
    column: K,
    where?: WhereClause<T> | WhereClause<T>[],
  ): Promise<T[K][]> {
    const findOption: FindOption<T> = { select: [column] };
    if (where !== undefined) {
      findOption.where = where;
    }
    const rows = await this.ctx.find(entity, findOption);
    return rows.map((row) => row[column]);
  }

  /**
   * Rejects negative pagination inputs before any metadata or SQL work.
   *
   * `take`/`skip`/`limit` reach the builder as raw numbers, so a negative
   * value would otherwise become a dialect-specific syntax error naming the
   * generated SQL rather than the option the caller passed.
   */
  private validatePaginationOptions<T>(findOption: FindOption<T>): void {
    const { take, skip, limit } = findOption;

    if (skip !== undefined && skip < 0) {
      throw new InvalidQueryError(
        `"skip" must be a non-negative integer, but received ${skip}`,
        "Ensure skip is >= 0",
      );
    }
    if (take !== undefined && take < 0) {
      throw new InvalidQueryError(
        `"take" must be a non-negative integer, but received ${take}`,
        "Ensure take is >= 0",
      );
    }
    if (limit !== undefined) {
      if (Array.isArray(limit)) {
        const [off, cnt] = limit;
        if (off < 0) {
          throw new InvalidQueryError(
            `"limit" offset must be non-negative, but received ${off}`,
            "Ensure the first element of the limit tuple is >= 0",
          );
        }
        if (cnt < 0) {
          throw new InvalidQueryError(
            `"limit" count must be non-negative, but received ${cnt}`,
            "Ensure the second element of the limit tuple is >= 0",
          );
        }
      } else if (typeof limit === "number" && limit < 0) {
        throw new InvalidQueryError(
          `"limit" must be non-negative, but received ${limit}`,
          "Ensure limit is >= 0",
        );
      }
    }
  }

  /**
   * Resolves everything the clause builders share: metadata, column plan,
   * inheritance shape, eager relation sets and the property→column map, then
   * rejects unresolvable `select`/`where`/`orderBy`/`groupBy` identifiers.
   *
   * @throws EntityMetadataNotFoundError when `entity` carries no metadata.
   */
  private prepareFindOperation<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T>,
    relationTree?: RelationTree,
    relationCounts?: RelationCountSpec[],
  ): FindOperation<T> {
    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    // ── Detect the inheritance strategy early ──
    const inheritanceStrategy = this.inheritanceResolver.getStrategy(entity);
    const isTPTChild = inheritanceStrategy === "JOINED" && this.inheritanceResolver.isChildEntity(entity);
    const isTPTPolymorphic = inheritanceStrategy === "JOINED" && this.inheritanceResolver.isPolymorphicQuery(entity);
    const isTPCPolymorphic = inheritanceStrategy === "TABLE_PER_CLASS" && this.inheritanceResolver.isPolymorphicQuery(entity);

    const plan = this.getColumnPlan(entity, metadata);

    const { eagerM2O, eagerO2O } = this.resolveToOneRelations(
      plan,
      requestedRelationNames(findOption.relations),
    );

    const hasEagerJoins =
      eagerM2O.length > 0 || eagerO2O.length > 0
      || isTPTChild || isTPTPolymorphic;

    // Build property-to-column map once and reuse throughout findInternal
    const propToCol = this.ctx.buildPropertyToColumnMap(metadata);

    const op: FindOperation<T> = {
      entity,
      findOption,
      metadata,
      tableName: isTPCPolymorphic ? TPC_UNION_ALIAS : metadata.name,
      plan,
      propToCol,
      inheritanceStrategy,
      isTPTChild,
      isTPTPolymorphic,
      isTPCPolymorphic,
      eagerM2O,
      eagerO2O,
      hasEagerJoins,
      tptQualifyColumn: undefined,
      addedKeyColumns: [],
      relationTree,
      relationCounts,
    };
    op.tptQualifyColumn = this.createTptColumnQualifier(op);

    const selectColumns = findOption.select
      ? this.ctx.resolveSelectColumns<T>(findOption.select)
      : undefined;

    // Reject column identifiers no builder can resolve. `where` / `orderBy`
    // / `select` fall back to the raw key when it is not in the property
    // map, so a typo used to travel to the driver and come back as a
    // dialect-specific "no such column" that never named the alternatives.
    validateReadIdentifiers(
      findOption,
      selectColumns,
      relationAwareScope(this.ctx, this.resolver, entity, metadata),
    );

    op.addedKeyColumns = this.resolveAddedKeyColumns(op, selectColumns);

    return op;
  }

  /**
   * The primary-key columns a partial `select` is missing for the requested
   * relations to load.
   *
   * OneToMany, ManyToMany and the inverse side of OneToOne are not JOINed:
   * {@link RelationLoader} matches their rows to each hydrated parent by its
   * primary key. A `select` that left the key out hydrated parents without
   * it, so every loader skipped its query and assigned `[]` / `null` to
   * parents that had related rows. The key is now added to the SELECT list
   * (never to the caller's `findOption`) and stays on the hydrated entity.
   *
   * Reads that collapse rows are rejected instead:
   *
   * - a `groupBy` that does not name every key column, whatever `select` says
   *   — a grouped row carries the key of one arbitrary member, so the loader
   *   would attach that member's rows to the whole group;
   * - `distinct` on a `select` that omits the key — adding the key would
   *   change which rows DISTINCT removes. (`distinct` over the full column
   *   set already emits the key, so it needs no rejection.)
   *
   * A TPT child and a TPC polymorphic root read every column whatever
   * `select` says, so they never need the addition — but their grouped reads
   * collapse rows just the same and are rejected like any other.
   *
   * An empty resolved `select` adds nothing: the read keeps failing on the
   * empty SELECT list instead of silently answering with the key alone.
   *
   * @throws InvalidQueryError for the `groupBy` / `distinct` shapes above.
   */
  private resolveAddedKeyColumns<T>(
    op: FindOperation<T>,
    selectColumns: readonly string[] | undefined,
  ): string[] {
    const { entity, findOption, propToCol } = op;
    const relations = this.keyMatchedRelationNames(op);
    if (relations.length === 0) return [];

    const keyColumns = this.relationLoader.parentKeyColumns(entity, relations);
    if (keyColumns.length === 0) return [];

    // Keyed off the grouping alone: naming the key in `select` does not make
    // a collapsed row point at one parent.
    const groupBy = findOption.groupBy;
    if (groupBy && groupBy.length > 0) {
      const grouped = new Set(
        groupBy.map((col) => propToCol.get(String(col)) ?? String(col)),
      );
      const ungrouped = keyColumns.filter((col) => !grouped.has(col.name));
      if (ungrouped.length > 0) {
        this.rejectKeylessCollapsedRead(op, ungrouped, "groupBy");
      }
    }

    if (op.isTPTChild || op.isTPCPolymorphic) return [];
    if (!selectColumns || selectColumns.length === 0) return [];

    const selected = new Set(
      selectColumns.map((prop) => propToCol.get(prop) ?? prop),
    );
    const missing = keyColumns.filter((col) => !selected.has(col.name));
    if (missing.length === 0) return [];

    if (findOption.distinct) {
      this.rejectKeylessCollapsedRead(op, missing, "distinct");
    }

    return missing.map((col) => col.name);
  }

  /**
   * The relations a read loads or counts by each parent's primary key
   * candidates: the requested `relations` and the relations `withCount`
   * counts.
   */
  private keyMatchedRelationNames<T>(op: FindOperation<T>): string[] {
    const names = [...(requestedRelationNames(op.findOption.relations) ?? [])];
    for (const count of op.relationCounts ?? []) {
      if (!names.includes(count.relation)) names.push(count.relation);
    }
    return names;
  }

  /**
   * Rejects a `distinct` / `groupBy` read that asks for relations matched by
   * a primary key the collapsed result cannot stand for.
   *
   * Both forms collapse rows, so the read cannot be answered the way
   * {@link resolveAddedKeyColumns} answers a plain read: under `distinct`
   * adding the key would change which rows survive, and a grouped row has no
   * single key value to match related rows to — whether or not the key is in
   * the SELECT list. The message names the relations and the key by the
   * property names the caller wrote, not the DB columns.
   *
   * @param keyColumns - The key columns the read cannot carry.
   * @param form - The collapsing option that caused the rejection.
   * @throws InvalidQueryError always.
   */
  private rejectKeylessCollapsedRead<T>(
    op: FindOperation<T>,
    keyColumns: ColumnMetadata[],
    form: "distinct" | "groupBy",
  ): never {
    const quote = (names: string[]) => names.map((n) => `"${n}"`).join(", ");
    const keys = quote(keyColumns.map((col) => col.propertyKey ?? col.name));
    const keyList = `primary key column${keyColumns.length > 1 ? "s" : ""} ${keys}`;
    const relationNames = this.relationLoader.relationsMatchedByParentKey(
      op.entity,
      this.keyMatchedRelationNames(op),
    );
    const relations = quote(relationNames);
    const are = relationNames.length > 1 ? "are" : "is";
    const they = relationNames.length > 1 ? "they" : "it";

    if (form === "distinct") {
      throw new InvalidQueryError(
        `Cannot load ${relations} for entity "${op.entity.name}" in a "distinct" read whose "select" omits ${keyList}. ` +
          `${relations} ${are} matched to each row by that key, and adding the key to the SELECT list would change which rows DISTINCT removes.`,
        `Add ${keys} to "select", drop "distinct", or load ${relations} with a separate find().`,
      );
    }

    throw new InvalidQueryError(
      `Cannot load ${relations} for entity "${op.entity.name}" in a "groupBy" read whose grouping omits ${keyList}. ` +
        `${relations} ${are} matched to each row by that key, and a grouped row carries the key of one arbitrary member, so ${they} would be attached to the whole group.`,
      `Add ${keys} to "groupBy", or load ${relations} with a separate find().`,
    );
  }

  /**
   * TPT child: qualify a column with the parent table if it belongs to the
   * parent — a column or relation join column the root declares — else with
   * the child table. Undefined for every other shape.
   */
  private createTptColumnQualifier<T>(
    op: FindOperation<T>,
  ): ((dbCol: string) => string) | undefined {
    if (!op.isTPTChild) return undefined;

    const tptRoot = this.inheritanceResolver.getRoot(op.entity)!;
    const tptRootMeta = this.resolver.resolveEntityMetadata(tptRoot);
    if (!tptRootMeta) return undefined;

    const tptRootTableName = tptRootMeta.name;
    const tptRootOnlyCols = joinedRootColumns(this.resolver, tptRoot);
    return (dbCol: string) => {
      if (tptRootOnlyCols.has(dbCol)) {
        return `${this.ctx.wrap(tptRootTableName)}.${this.ctx.wrap(dbCol)}`;
      }
      return `${this.ctx.wrap(op.tableName)}.${this.ctx.wrap(dbCol)}`;
    };
  }

  /** Root table of a JOINED child read, which is JOINed under its own name. */
  private tptRootTableName<T>(op: FindOperation<T>): string | undefined {
    if (!op.isTPTChild) return undefined;
    const root = this.inheritanceResolver.getRoot(op.entity);
    return root ? this.resolver.resolveEntityMetadata(root)?.name : undefined;
  }

  /**
   * Renders a DB column for a clause that must survive JOINs: the TPT-child
   * qualifier when one exists, else table-qualified while any JOIN is
   * present, else bare. Shared by ORDER BY and GROUP BY, which pick the same
   * table for the same column.
   */
  private qualifyColumn<T>(op: FindOperation<T>, dbCol: string): string {
    if (op.tptQualifyColumn) return op.tptQualifyColumn(dbCol);
    return op.hasEagerJoins
      ? `${this.ctx.wrap(op.tableName)}.${this.ctx.wrap(dbCol)}`
      : this.ctx.wrap(dbCol);
  }

  /**
   * Physical SELECT list for the read: the entity's own columns (or the
   * caller's `select`), the extra columns polymorphic and eager shapes need,
   * each aliased so {@link ResultTransformerFactory} can route it back.
   */
  private buildSelectList<T>(op: FindOperation<T>): string[] {
    const selectMap: string[] = [];
    const { entity, metadata, tableName, plan, propToCol, hasEagerJoins } = op;
    const select = op.findOption.select;

    // TPT child: every column of both tables, each read from the table that
    // holds it — the child's key, own columns, own join columns and own
    // generated columns, then the root's (see joinedRootColumns).
    if (op.isTPTChild && op.tptQualifyColumn) {
      const root = this.inheritanceResolver.getRoot(entity)!;
      const rootColumns = joinedRootColumns(this.resolver, root);
      const childColumns = new Set(plan.allColNames);
      for (const name of childColumns) {
        if (!rootColumns.has(name)) selectMap.push(op.tptQualifyColumn(name));
      }
      for (const name of rootColumns) selectMap.push(op.tptQualifyColumn(name));
    } else if (op.isTPCPolymorphic) {
      // Every column of the UNION ALL, whatever `select` says; qualified
      // when relations are JOINed onto it.
      selectMap.push(hasEagerJoins ? `${this.ctx.wrap(tableName)}.*` : "*");
    } else if (select) {
      const selectedColumns = this.ctx.resolveSelectColumns<T>(select)
        .map((prop) => propToCol.get(prop) ?? prop);
      // Key columns a deferred relation loader matches parents by.
      selectedColumns.push(...op.addedKeyColumns);
      if (hasEagerJoins) {
        selectMap.push(
          ...selectedColumns.map(
            (col) => `${this.ctx.wrap(tableName)}.${this.ctx.wrap(col)}`,
          ),
        );
      } else {
        selectMap.push(...selectedColumns.map((col) => this.ctx.wrap(col)));
      }
    } else {
      // Full physical column set (incl. FK-only columns) — precomputed and
      // wrapped once per entity metadata in getColumnPlan().
      selectMap.push(
        ...(hasEagerJoins ? plan.selectQualified : plan.selectPlain),
      );
    }

    if (op.isTPTPolymorphic) {
      this.appendPolymorphicChildColumns(op, selectMap);
    }
    this.appendEagerRelationColumns(op, selectMap);

    return selectMap;
  }

  /**
   * TPT polymorphic: add each child table's unique columns to SELECT, aliased
   * `<childTable>_<column>` so the transformer can group them per subclass.
   */
  private appendPolymorphicChildColumns<T>(
    op: FindOperation<T>,
    selectMap: string[],
  ): void {
    selectMap.push(
      ...joinedSubclassColumns(this.tpcSourceContext(), op.entity).map((col) => col.select),
    );
  }

  /**
   * Discriminator value → child table name, the prefix a polymorphic JOINED
   * read gives each subclass's columns.
   */
  private tptChildPrefixMap(root: ClazzType<any>): Map<string, string> {
    return joinedSubclassPrefixes(this.tpcSourceContext(), root);
  }

  /**
   * Columns of the eagerly JOINed relations.
   *
   * Each relation gets its own table alias (the property name like
   * "assignee" / "reporter") so that two relations pointing at the same
   * entity (e.g. Issue → assignee + reporter, both → User) emit `LEFT JOIN
   * user AS assignee` and `LEFT JOIN user AS reporter` instead of two `LEFT
   * JOIN user AS user`. The latter tripped MariaDB's "Not unique
   * table/alias" error. {@link appendEagerJoins} reuses the same aliases.
   */
  private appendEagerRelationColumns<T>(
    op: FindOperation<T>,
    selectMap: string[],
  ): void {
    for (const rel of op.eagerM2O) {
      const RelatedEntity = rel.getMappingEntity() as ClazzType<any>;
      const relatedMetadata = this.resolver.resolveEntityMetadata(RelatedEntity);
      if (!relatedMetadata) continue;

      const relAlias = rel.columnName;
      for (const name of this.relationColumnNames(RelatedEntity, relatedMetadata)) {
        const alias = joinedColumnAlias(rel.columnName, name);
        selectMap.push(
          `${this.ctx.wrap(relAlias)}.${this.ctx.wrap(name)} AS ${this.ctx.wrap(alias)}`,
        );
      }
    }

    // Owning-side OneToOne — same per-property alias.
    for (const rel of op.eagerO2O) {
      const RelatedEntity = rel.getRelatedEntity() as ClazzType<any>;
      const relatedMetadata = this.resolver.resolveEntityMetadata(RelatedEntity);
      if (!relatedMetadata) continue;

      const relAlias = rel.propertyKey;
      for (const name of this.relationColumnNames(RelatedEntity, relatedMetadata)) {
        const alias = joinedColumnAlias(rel.propertyKey, name);
        selectMap.push(
          `${this.ctx.wrap(relAlias)}.${this.ctx.wrap(name)} AS ${this.ctx.wrap(alias)}`,
        );
      }
    }
  }

  /**
   * The columns a JOINed relation reads of `RelatedEntity`: those find()
   * reads of it, plus — for the root of a JOINED hierarchy — each
   * subclass's own columns, under the names {@link relationJoinSource}
   * gives them, so the row can be built as its subclass.
   */
  private relationColumnNames(
    RelatedEntity: ClazzType<any>,
    relatedMetadata: { name: string; columns: ColumnMetadata[] },
  ): readonly string[] {
    const names = this.readColumnNames(RelatedEntity, relatedMetadata);
    if (!isJoinedPolymorphicRoot(this.inheritanceResolver, RelatedEntity)) return names;
    return [
      ...names,
      ...joinedSubclassColumns(this.tpcSourceContext(), RelatedEntity).map((col) => col.alias),
    ];
  }

  /**
   * Every predicate the read must AND together: the caller's `where`, the STI
   * discriminator, the soft-delete rule and the tenant scope. All four are
   * qualified the same way, so a JOINed read never leaves a bare column
   * ambiguous.
   */
  private buildWhereClauses<T>(op: FindOperation<T>): Sql[] {
    const { entity, findOption, tableName, propToCol, hasEagerJoins } = op;
    const whereMap: Sql[] = [];

    // A relation filter's subquery reads the current row by qualified name
    // whether or not the statement JOINs: an unqualified column would bind
    // to the subquery's own table.
    const outerColumn = (column: string) =>
      op.tptQualifyColumn
        ? op.tptQualifyColumn(column)
        : `${this.ctx.wrap(tableName)}.${this.ctx.wrap(column)}`;
    whereMap.push(
      ...resolveWhereClause(findOption.where, {
        wrapColumn: (n) => this.ctx.wrap(n),
        qualified: hasEagerJoins,
        tableName: hasEagerJoins ? tableName : undefined,
        dialect: this.ctx.getDialect(),
        dialectExpression: createDialectExpression(this.ctx.getDialect()),
        propertyToColumn: propToCol,
        qualifyColumn: op.tptQualifyColumn,
        relationFilter: new RelationWhereFilterBuilder(this.ctx, this.resolver, findOption.withDeleted).hookFor(
          entity,
          outerColumn,
        ),
      }),
    );

    // STI: when querying a child entity, add a discriminator WHERE condition
    if (op.inheritanceStrategy === "SINGLE_TABLE" && this.inheritanceResolver.isChildEntity(entity)) {
      const discCol = this.inheritanceResolver.getDiscriminatorColumn(entity);
      const discVal = this.inheritanceResolver.getDiscriminatorValue(entity);
      if (discCol && discVal) {
        const col = hasEagerJoins
          ? `${this.ctx.wrap(tableName)}.${this.ctx.wrap(discCol.name)}`
          : this.ctx.wrap(discCol.name);
        whereMap.push(Conditions.equals(col, discVal));
      }
    }

    // Soft-delete predicate injection for entities carrying a @DeletedAt column.
    // - onlyDeleted: emit `<col> IS NOT NULL` so the read returns exclusively
    //   trashed rows. Takes precedence over withDeleted when both are set.
    // - withDeleted: emit no soft-delete predicate (live + trashed rows).
    // - default: emit `<col> IS NULL` so trashed rows are hidden.
    // The column is qualified like ORDER BY / GROUP BY — a JOINED child's
    // inherited @DeletedAt lives on the root table, not its own. For entities
    // without a @DeletedAt column this whole block is skipped (onlyDeleted is
    // a silent no-op).
    const deletedAtColumn = this.resolver.getDeletedAtColumn(entity);
    if (deletedAtColumn) {
      const deletedAtRef = this.qualifyColumn(op, deletedAtColumn);
      if (findOption.onlyDeleted) {
        whereMap.push(Conditions.isNotNull(deletedAtRef));
      } else if (!findOption.withDeleted) {
        whereMap.push(Conditions.isNull(deletedAtRef));
      }
    }

    // Tenant scoping under the "tenant_column" strategy. Skipped when the
    // caller explicitly opts out via `findOption.withoutTenantScope`.
    if (!findOption.withoutTenantScope) {
      // A JOINED child keeps the tenant column on the root table only, which
      // the read JOINs under its own name.
      const tptRoot = this.tptRootTableName(op);
      const tenantPredicate = tptRoot
        ? this.ctx.buildTenantWhereClause(entity, tptRoot, "root")
        : this.ctx.buildTenantWhereClause(
            entity,
            hasEagerJoins ? tableName : undefined,
          );
      if (tenantPredicate) {
        whereMap.push(tenantPredicate);
      }
    }

    return whereMap;
  }

  /**
   * ORDER BY entries, qualified the same way select/where/groupBy are — with
   * eager joins present, a shared column name (id, createdAt, ...) is
   * otherwise ambiguous. TPT children route through the parent-table
   * qualifier so inherited columns land on the table that holds them.
   */
  private buildOrderByList<T>(
    op: FindOperation<T>,
  ): Array<{ column: string; direction: "ASC" | "DESC" }> {
    const orderByMap: Array<{ column: string; direction: "ASC" | "DESC" }> = [];
    const orderBy = op.findOption.orderBy;
    for (const key in orderBy) {
      const value = orderBy[key];
      if (value) {
        const dbCol = op.propToCol.get(key) ?? key;
        orderByMap.push({ column: this.qualifyColumn(op, dbCol), direction: value });
      }
    }
    return orderByMap;
  }

  /**
   * SELECT ... FROM for the read. A TABLE_PER_CLASS root query has no single
   * table to read from, so its FROM is a UNION ALL over every concrete table
   * with the missing columns padded to NULL and the discriminator projected
   * as a literal.
   */
  private applyFromClause<T>(
    op: FindOperation<T>,
    qb: BaseRawQueryBuilder,
    selectMap: string[],
  ): void {
    const { entity, tableName } = op;

    if (op.isTPCPolymorphic) {
      const unionSql = buildTpcUnionSource(this.tpcSourceContext(), entity);
      qb.select(selectMap).from(sql`(${unionSql})`, this.ctx.wrap(TPC_UNION_ALIAS));
    } else if (op.findOption.distinct) {
      qb.selectDistinct(selectMap).from(this.ctx.wrapTable(tableName));
    } else {
      qb.select(selectMap).from(this.ctx.wrapTable(tableName));
    }
  }

  /**
   * JOINs the JOINED (TPT) strategy needs: a child reads its inherited
   * columns from the root table, a polymorphic root reads each subclass's own
   * columns from that subclass's table. Both join on the shared PK.
   */
  private appendInheritanceJoins<T>(
    op: FindOperation<T>,
    qb: BaseRawQueryBuilder,
  ): void {
    const { entity, metadata, tableName } = op;

    // TPT child: INNER JOIN the parent table
    if (op.isTPTChild) {
      const root = this.inheritanceResolver.getRoot(entity)!;
      const rootMeta = this.resolver.resolveEntityMetadata(root);
      if (rootMeta) {
        const pk = metadata.columns.find((c: any) => c.options?.primary);
        if (pk) {
          const rootTableName = rootMeta.name;
          const joinCond = sql`${raw(this.ctx.wrap(tableName))}.${raw(this.ctx.wrap(pk.name))} = ${raw(this.ctx.wrap(rootTableName))}.${raw(this.ctx.wrap(pk.name))}`;
          qb.innerJoin(
            this.ctx.wrapTable(rootTableName),
            this.ctx.wrap(rootTableName),
            joinCond,
          );
        }
      }
    }

    // TPT polymorphic: LEFT JOIN every child table
    if (op.isTPTPolymorphic) {
      const pk = metadata.columns.find((c: any) => c.options?.primary);
      const children = this.inheritanceResolver
        .getConcreteEntities(entity)
        .filter((c) => c !== entity);
      for (const ChildEntity of children) {
        const childMeta = this.resolver.resolveEntityMetadata(ChildEntity);
        if (!childMeta || !pk) continue;
        const childTableName = childMeta.name;
        const joinCond = sql`${raw(this.ctx.wrap(tableName))}.${raw(this.ctx.wrap(pk.name))} = ${raw(this.ctx.wrap(childTableName))}.${raw(this.ctx.wrap(pk.name))}`;
        qb.leftJoin(
          this.ctx.wrapTable(childTableName),
          this.ctx.wrap(childTableName),
          joinCond,
        );
      }
    }
  }

  /**
   * LEFT JOINs for the eagerly loaded ManyToOne / owning-side OneToOne
   * relations, under the aliases {@link appendEagerRelationColumns} selected
   * from. Soft-delete and tenant predicates go in the ON clause, not WHERE,
   * so a filtered-out target hydrates as null instead of dropping the parent
   * row — the semantics the batched and lazy loaders already have.
   */
  private appendEagerJoins<T>(
    op: FindOperation<T>,
    qb: BaseRawQueryBuilder,
  ): void {
    const { entity, tableName } = op;

    // Eager ManyToOne LEFT JOIN
    for (const rel of op.eagerM2O) {
      const RelatedEntity = rel.getMappingEntity() as ClazzType<any>;
      const relatedMetadata = this.resolver.resolveEntityMetadata(RelatedEntity);
      if (!relatedMetadata) continue;

      const relatedTableName = relatedMetadata.name || RelatedEntity.name;
      const joinColumn = rel.joinColumn ?? rel.columnName;

      const relatedPk = relatedMetadata.columns.find(
        (col: any) => col.options?.primary,
      );
      if (!relatedPk) continue;

      // A TPT child reads the join column from the table that holds it:
      // the root's for a relation the root declares.
      const fkColumn = op.tptQualifyColumn
        ? op.tptQualifyColumn(joinColumn)
        : `${this.ctx.wrap(tableName)}.${this.ctx.wrap(joinColumn)}`;

      const relAlias = rel.columnName;
      let joinCondition = sql`${raw(fkColumn)} = ${raw(this.ctx.wrap(relAlias))}.${raw(this.ctx.wrap(relatedPk.name))}`;
      joinCondition = this.appendRelationJoinFilters(
        op,
        RelatedEntity,
        relAlias,
        joinCondition,
      );

      qb.leftJoin(
        this.relationJoinSource(RelatedEntity, relatedTableName, relAlias),
        this.ctx.wrap(relAlias),
        joinCondition,
      );
    }

    // OneToOne Eager LEFT JOIN
    for (const rel of op.eagerO2O) {
      const RelatedEntity = rel.getRelatedEntity() as ClazzType<any>;
      const relatedMetadata = this.resolver.resolveEntityMetadata(RelatedEntity);
      if (!relatedMetadata) continue;

      const relatedTableName = relatedMetadata.name || RelatedEntity.name;
      const joinColumn = rel.joinColumn!;

      const relatedPk = relatedMetadata.columns.find(
        (col: any) => col.options?.primary,
      );
      if (!relatedPk) continue;

      const fkColumn = op.tptQualifyColumn
        ? op.tptQualifyColumn(joinColumn)
        : `${this.ctx.wrap(tableName)}.${this.ctx.wrap(joinColumn)}`;

      const relAlias = rel.propertyKey;
      let joinCondition = sql`${raw(fkColumn)} = ${raw(this.ctx.wrap(relAlias))}.${raw(this.ctx.wrap(relatedPk.name))}`;
      joinCondition = this.appendRelationJoinFilters(
        op,
        RelatedEntity,
        relAlias,
        joinCondition,
      );

      qb.leftJoin(
        this.relationJoinSource(RelatedEntity, relatedTableName, relAlias),
        this.ctx.wrap(relAlias),
        joinCondition,
      );
    }
  }

  /**
   * What a to-one relation is JOINed from: the related table, or a derived
   * table under the relation's alias when the target spans tables of a
   * JOINED hierarchy —
   *
   * - a child, whose inherited columns live on the root's table: the child's
   *   table joined to the root's, so `alias.column` reads every column of
   *   the child;
   * - the root, whose rows may be any subclass's: the root's table joined to
   *   every subclass table, each subclass's columns named
   *   `<childTable>_<column>`, as find() on the root reads it.
   */
  private relationJoinSource(
    RelatedEntity: ClazzType<any>,
    relatedTableName: string,
    relAlias: string,
  ): string | Sql {
    let select: Sql | null = null;
    if (isJoinedChild(this.inheritanceResolver, RelatedEntity)) {
      select = buildJoinedChildSelect(this.tpcSourceContext(), RelatedEntity);
    } else if (isJoinedPolymorphicRoot(this.inheritanceResolver, RelatedEntity)) {
      const metadata = this.resolver.resolveEntityMetadata(RelatedEntity);
      select = metadata
        ? buildJoinedRootSelect(
            this.tpcSourceContext(),
            RelatedEntity,
            this.readColumnNames(RelatedEntity, metadata),
          )
        : null;
    }
    if (select) return sql`(${select}) AS ${raw(this.ctx.wrap(relAlias))}`;
    return this.ctx.wrapTable(relatedTableName);
  }

  /**
   * Extends an eager JOIN's ON clause with the two predicates the joined side
   * always carries: hide soft-deleted targets (unless `withDeleted`), and
   * keep the target inside the caller's tenant — an FK is user-supplied, so
   * it can point at another tenant's row.
   */
  private appendRelationJoinFilters<T>(
    op: FindOperation<T>,
    RelatedEntity: ClazzType<any>,
    relAlias: string,
    joinCondition: Sql,
  ): Sql {
    const relatedDeletedAt = this.resolver.getDeletedAtColumn(RelatedEntity);
    const withDeleted =
      op.relationTree?.nodes.get(relAlias)?.options?.withDeleted ?? op.findOption.withDeleted;
    if (relatedDeletedAt && !withDeleted) {
      joinCondition = sql`${joinCondition} AND ${raw(this.ctx.wrap(relAlias))}.${raw(this.ctx.wrap(relatedDeletedAt))} IS NULL`;
    }

    // A SINGLE_TABLE child shares its table with its siblings: a key that
    // points at a sibling's row is no row of this relation.
    const subtype = this.inheritanceResolver.getSingleTableChildDiscriminator(RelatedEntity);
    if (subtype) {
      joinCondition = sql`${joinCondition} AND ${Conditions.equals(
        `${this.ctx.wrap(relAlias)}.${this.ctx.wrap(subtype.columnName)}`,
        subtype.value,
      )}`;
    }

    if (!op.findOption.withoutTenantScope) {
      const relTenantPredicate = this.ctx.buildTenantWhereClause(
        RelatedEntity,
        relAlias,
      );
      if (relTenantPredicate) {
        joinCondition = sql`${joinCondition} AND ${relTenantPredicate}`;
      }
    }

    return joinCondition;
  }

  /**
   * GROUP BY / HAVING. Group keys resolve property names to DB columns
   * exactly like select/orderBy: without the mapping, a renamed column
   * (@Column({ name }) or a NamingStrategy) grouped by a column that does not
   * exist while SELECT used the mapped name.
   */
  private appendGroupByHaving<T>(
    op: FindOperation<T>,
    qb: BaseRawQueryBuilder,
  ): void {
    const { groupBy, having } = op.findOption;

    if (groupBy && groupBy.length > 0) {
      const groupByColumns = (groupBy as string[]).map((col) =>
        this.qualifyColumn(op, op.propToCol.get(col) ?? col),
      );
      qb.groupBy(groupByColumns);
    }

    if (having && having.length > 0) {
      qb.having(having);
    }
  }

  /**
   * Row window (`limit` tuple or `skip`/`take`) plus the pessimistic lock
   * suffix.
   *
   * LIMIT tuple syntax is dialect-specific (mirrors ExplainQueryHandler,
   * #145): the builder defaults to MySQL's `LIMIT off, cnt`, which
   * PostgreSQL rejects — so the dialect must be set for every driver, not
   * just the MySQL family.
   */
  private applyLimitAndLock<T>(
    op: FindOperation<T>,
    qb: BaseRawQueryBuilder,
  ): void {
    const { take, skip, limit } = op.findOption;

    if (this.ctx.isMySqlFamily()) qb.setDatabaseType("mysql");
    else if (this.ctx.isSqlite()) qb.setDatabaseType("sqlite");
    else qb.setDatabaseType("postgresql");

    if (Array.isArray(limit)) {
      const [offset, count] = limit;
      // An explicit count of 0 means "no rows" (LIMIT 0); the validator
      // permits it. Only a positive `take` overrides the tuple's count.
      const effectiveCount = (take && take > 0) ? take : count;
      qb.limit([offset, effectiveCount]);
    } else if (skip !== undefined || (take !== undefined && limit === undefined)) {
      // skip/take pagination → convert to limit tuple. An explicit
      // `take: 0` means LIMIT 0 (the validator allows it), so only
      // `undefined` may drop the cap — a falsy check would silently
      // return the whole table.
      const offset = skip ?? 0;
      if (take !== undefined) {
        qb.limit([offset, take]);
      } else if (offset > 0) {
        // skip without take: no real cap — use a very large count so the
        // OFFSET still applies on drivers that require one (MySQL).
        qb.limit([offset, 2147483647]);
      }
    } else {
      if (limit !== undefined) {
        qb.limit(limit as number);
      }
    }

    // Pessimistic lock suffix
    if (op.findOption.lock) {
      const lockSuffix = this.ctx.resolveLockSuffix(op.findOption.lock);
      qb.appendSql(raw(lockSuffix));
    }
  }

  /**
   * Runs the assembled statement on `session` and hands back the raw rows,
   * or undefined when the read matched nothing.
   *
   * The timeout statement is issued by executeReadOnly (see
   * `withQueryTimeout`), which owns the session this runs on — issuing it
   * here as well left the PostgreSQL `SET LOCAL` outside any transaction on
   * the paths that route around it.
   */
  private async executeFindQuery<T>(
    op: FindOperation<T>,
    session: TransactionSessionManager,
    qb: BaseRawQueryBuilder,
  ): Promise<QueryResult | undefined> {
    const resultQuery = qb.build();

    const queryStartTime = Date.now();
    this.ctx.beginTrackQuery();
    const queryResult = (await session.query<T>(
      resultQuery,
    )) as QueryResult;
    this.ctx.trackQuery(
      op.entity.name,
      resultQuery.text ?? String(resultQuery),
      Date.now() - queryStartTime,
    );

    const { results } = queryResult;
    if (!results || results.length === 0) {
      return undefined;
    }

    // SQLite: convert INTEGER 0/1 back to boolean
    if (this.ctx.isSqlite()) {
      const boolColumns = op.plan.boolColumns;
      if (boolColumns.length > 0) {
        for (const row of results) {
          for (const col of boolColumns) {
            if (col in row) {
              row[col] = !!row[col];
            }
          }
        }
      }
    }

    return queryResult;
  }

  /**
   * Turns the driver rows into entity instances, picking the deserialization
   * shape the query's inheritance and JOIN layout produced: a discriminator
   * map for polymorphic reads, prefix-grouped child columns for TPT, nested
   * objects when eager relations were JOINed in, plain rows otherwise.
   */
  private hydrateRows<T>(
    op: FindOperation<T>,
    queryResult: QueryResult,
    resultTransformer: ResultTransformer,
  ): EntityResult<T> {
    const { entity, hasEagerJoins } = op;
    const isEntityArray = queryResult.results.length > 1;
    // The relations JOINed into the rows — `hasEagerJoins` also covers the
    // JOINs of an inheritance hierarchy's tables. A relation targeting the
    // root of a hierarchy builds its row as the subclass the row names.
    const joined: JoinedRelations = new Map([
      ...op.eagerM2O.map((rel) => [rel.columnName, this.rowClassifier(rel.getMappingEntity())] as const),
      ...op.eagerO2O.map((rel) => [rel.propertyKey, this.rowClassifier(rel.getRelatedEntity())] as const),
    ]);

    // STI/TPC: polymorphic query on the root entity — instantiate the correct subclass via the discriminator
    if (
      (op.inheritanceStrategy === "SINGLE_TABLE" || op.isTPCPolymorphic) &&
      this.inheritanceResolver.isPolymorphicQuery(entity)
    ) {
      const discCol = this.inheritanceResolver.getDiscriminatorColumn(entity);
      const discColName = discCol?.name ?? "dtype";
      const discMap = this.inheritanceResolver.buildDiscriminatorMap(entity);
      if (discMap.size > 0) {
        return resultTransformer.toPolymorphicEntities(
          entity,
          op.isTPCPolymorphic
            ? this.pruneTpcRows(entity, queryResult, discColName)
            : queryResult,
          discMap,
          discColName,
          joined,
          op.isTPCPolymorphic ? undefined : this.singleTableShape(entity),
        ) as EntityResult<T>;
      }
    } else if (op.isTPTPolymorphic) {
      // TPT polymorphic: resolve child columns via their prefixes
      const discCol = this.inheritanceResolver.getDiscriminatorColumn(entity);
      const discMap = this.inheritanceResolver.buildDiscriminatorMap(entity);
      if (discCol && discMap.size > 0) {
        return resultTransformer.toTPTPolymorphicEntities(
          entity,
          queryResult,
          discMap,
          discCol.name,
          this.tptChildPrefixMap(entity),
          joined,
        ) as EntityResult<T>;
      }
    } else if (
      (hasEagerJoins && !op.isTPTChild) ||
      // TPT child + an eager to-one relation: deserialize it through transformNested
      (op.isTPTChild && joined.size > 0)
    ) {
      return resultTransformer.transformNested(
        entity,
        queryResult,
        undefined,
        joined,
      ) as EntityResult<T>;
    }

    return isEntityArray
      ? resultTransformer.toEntities(entity, queryResult)
      : resultTransformer.toEntity(entity, queryResult);
  }

  /**
   * Loads the relations that cannot ride along on the main statement —
   * OneToMany, ManyToMany and the inverse side of OneToOne — on the same
   * session, so they share the caller's transaction and cache entry.
   */
  private async loadDeferredRelations<T>(
    op: FindOperation<T>,
    entityResult: EntityResult<T>,
    session: TransactionSessionManager,
  ): Promise<void> {
    const { entity, findOption } = op;
    const relations = requestedRelationNames(findOption.relations);
    if (!relations || relations.length === 0 || !entityResult) {
      return;
    }

    await this.relationLoader.loadOneToManyRelations(
      entity,
      entityResult as T | T[],
      relations,
      session,
      findOption.withDeleted,
      op.relationTree,
    );
    await this.relationLoader.loadManyToManyRelations(
      entity,
      entityResult as T | T[],
      relations,
      session,
      findOption.withDeleted,
      op.relationTree,
    );
    await this.relationLoader.loadOneToOneRelations(
      entity,
      entityResult as T | T[],
      relations,
      session,
      findOption.withDeleted,
      op.relationTree,
    );
  }

  /**
   * Replaces each lazy ManyToOne property the read did not name in
   * `relations` with a Proxy that reads the target on first access.
   *
   * The load fires at property-access time, possibly under another tenant's
   * context (or none), so the hydration-time context is captured and replayed
   * — the lazy mirror of eager loading, which reads the relation while that
   * context is still active. Without it, tenant_column silently loads null
   * and schema-based strategies can resolve the table to ANOTHER tenant's
   * schema and hydrate a same-id foreign row.
   */
  private injectLazyRelationProxies<T>(
    op: FindOperation<T>,
    entityResult: EntityResult<T>,
  ): void {
    const { findOption } = op;
    // A lazy relation the read names in `relations` was JOINed and hydrated
    // like any requested relation (nested levels included); a proxy would
    // throw that away and re-read it on access.
    const requested = requestedRelationNames(findOption.relations) ?? [];
    const lazyRelations = op.plan.manyToOne.filter((rel) => {
      return (
        rel.option?.lazy === true &&
        rel.option?.eager !== true &&
        !requested.includes(rel.columnName)
      );
    });
    if (lazyRelations.length === 0 || !entityResult) return;

    const entities = Array.isArray(entityResult)
      ? entityResult
      : [entityResult];

    for (const rel of lazyRelations) {
      const joinColumn = rel.joinColumn ?? rel.columnName;
      // ResultTransformer remaps an @RelationColumn / snake_case FK column
      // onto its shadow property (e.g. user_id -> userId), so the hydrated
      // entity carries the FK value under the shadow, not under joinColumn.
      // Read the shadow first, then fall back to the raw join column for
      // plain @ManyToOne entities whose FK stays under the DB column name.
      const fkShadow = rel.option?.fkProperty ?? `${rel.columnName}Id`;
      const RelatedEntity = rel.getMappingEntity() as ClazzType<any>;

      for (const item of entities) {
        const fkValue =
          (item as any)[fkShadow] ?? (item as any)[joinColumn];
        if (fkValue === undefined || fkValue === null) continue;

        const relatedMetadata = this.resolver.resolveEntityMetadata(RelatedEntity);
        if (!relatedMetadata) continue;

        const relatedPk = relatedMetadata.columns.find(
          (col: any) => col.options?.primary,
        );
        if (!relatedPk) continue;

        const em = this;
        const proxyWithDeleted = findOption.withDeleted;
        const hydrationContext = MetadataContext.capture();
        injectLazyProxy(item as any, rel.columnName, async () => {
          const result = await MetadataContext.runCaptured(
            hydrationContext,
            () =>
              em.findOne(RelatedEntity, {
                where: { [this.ctx.propKey(relatedPk)]: fkValue } as any,
                withDeleted: proxyWithDeleted,
              }),
          );
          return result as any;
        });
      }
    }
  }

  /** Notifies subscribers of the afterLoad event, once per hydrated entity. */
  private async emitAfterLoad<T>(
    op: FindOperation<T>,
    entityResult: EntityResult<T>,
  ): Promise<void> {
    if (!entityResult) return;
    const loadedEntities = Array.isArray(entityResult) ? entityResult : [entityResult];
    for (const loadedEntity of loadedEntities) {
      await this.ctx.notifySubscribers(op.entity, "afterLoad", loadedEntity);
    }
  }

  /**
   * The engine behind find / findOne and everything that funnels into them.
   *
   * Runs one read as a fixed pipeline: validate the options, resolve the
   * query shape into a {@link FindOperation}, assemble the clauses in the
   * order the builders above document, execute, hydrate, then load the
   * relations that could not ride along on the statement. Every step is a
   * helper on this class; this method only sequences them.
   *
   * The clause values are built before they are handed to the builder so that
   * predicate assembly keeps its original order relative to the JOINs — both
   * paths can emit tenant-scope warnings.
   */
  async findInternal<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T> = {},
    existingSession?: TransactionSessionManager,
  ): Promise<EntityResult<T>> {
    this.validatePaginationOptions(findOption);

    // Normalize `relations` — names, dotted paths, the object form — into one
    // tree, rejecting a name no loader can resolve at any level. Every loader
    // filters with `relations.includes(...)`, so without the check an
    // unmatched name produced a successful query whose relation property
    // stayed undefined. The read below sees the top-level names only; the
    // levels under them are loaded once it has hydrated its rows.
    const relationTree = resolveRelationTree(entity, findOption.relations, this.resolver);
    this.validateRelationOptionIdentifiers(entity, relationTree);
    if (relationTree) findOption = { ...findOption, relations: relationTree.names };
    const relationCounts = this.resolveRelationCounts(entity, findOption.withCount);

    const readNode = this.ctx.getReadNode(findOption.useMaster);
    const effectiveTimeout = this.resolveTimeout(findOption);

    // Query result cache: only a top-level read may cache (a caller-supplied
    // session means we are inside another operation's — possibly wrapped —
    // session, and a locking read must always reach the database). The
    // ambient-transaction bypass lives in policyForFind.
    const cachePolicy =
      findOption.cache && !existingSession && !findOption.lock
        ? this.ctx.getQueryCache()?.policyForFind(entity, {
            cache: findOption.cache,
            relations: relationTree,
            where: findOption.where,
            counts: relationCounts,
          })
        : undefined;

    return this.ctx.executeReadOnly(async (rawSession) => {
      // The wrapped session serves repeated SELECT row sets from the cache;
      // relation loaders receive it too, so their queries share the entry's
      // TTL and table tags.
      const session = cachePolicy
        ? cachePolicy.wrapSession(rawSession)
        : rawSession;
      const resultTransformer = ResultTransformerFactory.create();

      const op = this.prepareFindOperation(entity, findOption, relationTree, relationCounts);

      const qb = RawQueryBuilderFactory.create();

      const selectMap = this.buildSelectList(op);
      const whereMap = this.buildWhereClauses(op);
      const orderByMap = this.buildOrderByList(op);

      this.applyFromClause(op, qb, selectMap);
      this.appendInheritanceJoins(op, qb);
      this.appendEagerJoins(op, qb);

      qb.where(whereMap);
      this.appendGroupByHaving(op, qb);
      qb.orderBy(orderByMap);
      this.applyLimitAndLock(op, qb);

      const queryResult = await this.executeFindQuery(op, session, qb);
      if (!queryResult) {
        return undefined;
      }
      const entityResult = this.hydrateRows(op, queryResult, resultTransformer);

      await this.loadDeferredRelations(op, entityResult, session);
      if (entityResult) {
        await this.relationLoader.loadNestedRelations(
          entity,
          entityResult as T | T[],
          relationTree,
          session,
          findOption.withDeleted,
        );
        if (relationCounts) {
          await this.relationLoader.loadRelationCounts(
            entity,
            entityResult as T | T[],
            relationCounts,
            session,
            findOption.withDeleted,
          );
        }
      }
      this.injectLazyRelationProxies(op, entityResult);
      await this.emitAfterLoad(op, entityResult);

      return entityResult;
    }, { existingSession, readNodeOverride: readNode, timeout: effectiveTimeout });
  }

  async findWithCursor<T>(
    entity: ClazzType<T>,
    option: CursorPaginationOption<T> = {},
  ): Promise<CursorPaginationResult<T>> {
    const metadata = this.resolver.resolveEntityMetadata(entity);

    if (!metadata) {
      throw new EntityMetadataNotFoundError(entity.name);
    }

    const order = this.resolveCursorOrder(entity, metadata, option);
    const relationTree = resolveRelationTree(entity, option.relations, this.resolver);
    this.validateRelationOptionIdentifiers(entity, relationTree);
    if (relationTree) option = { ...option, relations: relationTree.names };
    const relationCounts = this.resolveRelationCounts(entity, option.withCount);

    const where: any = { ...(option.where ?? {}) };
    const readNode = this.ctx.getReadNode(option.useMaster);

    const cachePolicy = option.cache
      ? this.ctx.getQueryCache()?.policyForFind(entity, {
          cache: option.cache,
          relations: relationTree,
          where: option.where,
          counts: relationCounts,
        })
      : undefined;

    return this.ctx.executeReadOnly(async (rawSession) => {
      const session = cachePolicy
        ? cachePolicy.wrapSession(rawSession)
        : rawSession;
      const { selectList, keyset, whereMap } = this.prepareCursorQuery(
        entity,
        metadata,
        where,
        order,
        option,
      );

      // A TABLE_PER_CLASS root pages over the same UNION ALL find() reads:
      // every concrete table, every hierarchy column, the discriminator as
      // a literal. The discriminator also rides in the keyset (see
      // prepareCursorQuery) because the concrete tables number their own PKs.
      // A JOINED child pages over its table joined to the root's, which
      // holds the inherited columns the where and the keyset may name; a
      // JOINED root over itself joined to every child table, so each row
      // carries its subclass's columns as find() reads them.
      const qb = RawQueryBuilderFactory.create();
      const joinedSelect = isJoinedChild(this.inheritanceResolver, entity)
        ? buildJoinedChildSelect(this.tpcSourceContext(), entity)
        : this.isTptPolymorphicRoot(entity)
          ? buildJoinedRootSelect(
              this.tpcSourceContext(),
              entity,
              this.getColumnPlan(entity, metadata).allColNames,
            )
          : null;
      if (keyset.subKeyColumn !== undefined) {
        const unionSql = buildTpcUnionSource(this.tpcSourceContext(), entity);
        qb.select(["*"]).from(sql`(${unionSql})`, this.ctx.wrap(TPC_UNION_ALIAS)).where(whereMap);
      } else if (joinedSelect) {
        qb.select(["*"]).from(sql`(${joinedSelect})`, this.ctx.wrap(JOINED_CHILD_ALIAS)).where(whereMap);
      } else {
        qb.select(selectList).from(this.ctx.wrapTable(metadata.name)).where(whereMap);
      }
      qb.orderBy(buildKeysetOrderBy(keyset, (n) => this.ctx.wrap(n)));
      qb.limit(keyset.pageSize + 1);

      const queryResult = (await session.query<T>(qb.build())) as QueryResult;

      return this.hydrateCursorPage(
        entity,
        metadata,
        option,
        keyset,
        queryResult,
        session,
        relationTree,
        relationCounts,
      );
    }, { readNodeOverride: readNode, timeout: this.resolveTimeout(option) });
  }

  /**
   * The page order `findWithCursor` runs under: the PK (for the default
   * order and the keyset tiebreaker), the order property, direction, page
   * size and the decoded cursor of the previous page. Rejects an entity
   * with neither an `orderBy` nor a PK and a cursor that does not decode.
   */
  private resolveCursorOrder<T>(
    entity: ClazzType<T>,
    metadata: EntityScannerMetadata,
    option: CursorPaginationOption<T>,
  ): CursorOrder<T> {
    const pk = metadata.columns.find(
      (column: ColumnMetadata) => column.options?.primary,
    );

    const orderByColumn = option.orderBy ?? (pk?.name as keyof T & string);
    if (!orderByColumn) {
      throw new InvalidQueryError(
        "Cursor pagination requires an orderBy column or a primary key.",
        "Add @PrimaryGeneratedColumn() to your entity or pass orderBy in FindOption.",
      );
    }

    // When orderBy is not provided, inspect the PK type and warn if it is non-numeric
    if (!option.orderBy && pk) {
      this.ctx.warnIfNonSortablePk(entity.name, pk);
    }

    const direction = option.direction ?? "ASC";
    const pageSize = normalizePageSize(option.take);

    let cursorKey: DecodedCursorKey | null = null;
    if (option.cursor) {
      cursorKey = decodeCursorKey(option.cursor);
      if (cursorKey === null) {
        throw new InvalidQueryError(
          "Invalid cursor value.",
          "Ensure the cursor string was returned from a previous findWithCursor() call.",
        );
      }
    }

    return { pk, orderByColumn, direction, pageSize, cursorKey };
  }

  /**
   * The SELECT list, keyset plan and WHERE predicates of a cursor page.
   *
   * The SELECT list is the entity's cached read column plan — the same
   * @Column + FK-shadow + @ComputedColumn set `findInternal` reads, so a
   * cursor row hydrates with the same accessors. Identifiers are validated
   * here, as `prepareFindOperation` does for `find()`, so a typo'd where key
   * or sort column is reported with the valid list instead of a raw driver
   * error.
   */
  private prepareCursorQuery<T>(
    entity: ClazzType<T>,
    metadata: EntityScannerMetadata,
    where: WhereClause<T>,
    order: CursorOrder<T>,
    option: CursorPaginationOption<T>,
  ): { selectList: string[]; keyset: KeysetPlan; whereMap: Sql[] } {
    const plan = this.getColumnPlan(entity, metadata);

    // Map the orderBy property key to its DB column name so cursor pagination
    // honors the naming strategy (e.g. SnakeNamingStrategy maps `createdAt`
    // -> `created_at`). Mirrors the find() orderBy mapping. The default value
    // is already a column name (pk.name), so it passes through unchanged.
    const propToCol = this.ctx.buildPropertyToColumnMap(metadata);

    validateReadIdentifiers(
      { where, orderBy: { [order.orderByColumn]: order.direction } },
      undefined,
      relationAwareScope(this.ctx, this.resolver, entity, metadata),
    );

    const dbOrderByColumn = propToCol.get(order.orderByColumn) ?? order.orderByColumn;
    const dbPkColumn = order.pk?.name as string | undefined;
    const keyset: KeysetPlan = {
      orderColumn: dbOrderByColumn,
      pkColumn: dbPkColumn,
      isPkOrder: !dbPkColumn || dbOrderByColumn === dbPkColumn,
      direction: order.direction,
      pageSize: order.pageSize,
      cursor: order.cursorKey,
    };
    // TPC root: each concrete table numbers its own PKs, so (order, pk) is
    // not unique across the UNION — the discriminator literal breaks the tie.
    if (isTpcPolymorphicRoot(this.inheritanceResolver, entity)) {
      keyset.subKeyColumn =
        this.inheritanceResolver.getDiscriminatorColumn(entity)?.name ?? "dtype";
    }

    const whereMap = this.buildCursorWhereClauses(entity, where, propToCol, option);
    const keysetPredicate = buildKeysetPredicate(keyset, (n) => this.ctx.wrap(n));
    if (keysetPredicate) {
      whereMap.push(keysetPredicate);
    }

    return { selectList: plan.selectPlain, keyset, whereMap };
  }

  /**
   * Turns the `pageSize + 1` probe rows into the page result: hydrates the
   * entities, attaches their relations, fires `afterLoad`, and encodes the
   * next cursor from the last raw row when a further page exists.
   */
  private async hydrateCursorPage<T>(
    entity: ClazzType<T>,
    metadata: EntityScannerMetadata,
    option: CursorPaginationOption<T>,
    keyset: KeysetPlan,
    queryResult: QueryResult,
    session: TransactionSessionManager,
    relationTree: RelationTree | undefined,
    relationCounts: RelationCountSpec[] | undefined,
  ): Promise<CursorPaginationResult<T>> {
    const { results } = queryResult;
    if (!results || results.length === 0) {
      return {
        data: [],
        hasNextPage: false,
        nextCursor: null,
        count: 0,
      };
    }

    const { pageRows: pageResults, hasNextPage } = sliceCursorPage(results, keyset.pageSize);

    const entities = this.hydrateCursorRows(entity, keyset, {
      results: pageResults,
      fields: queryResult.fields,
    });

    // Relations before afterLoad, as findInternal orders them, so a
    // subscriber sees the same shape on a cursor page as on find().
    await this.loadCursorPageRelations(entity, metadata, option, entities, session, relationTree);
    await this.relationLoader.loadNestedRelations(
      entity,
      entities,
      relationTree,
      session,
      option.withDeleted,
    );
    if (relationCounts) {
      await this.relationLoader.loadRelationCounts(
        entity,
        entities,
        relationCounts,
        session,
        option.withDeleted,
      );
    }

    // Notify subscribers of the afterLoad event
    for (const loadedEntity of entities) {
      await this.ctx.notifySubscribers(entity, "afterLoad", loadedEntity);
    }

    const nextCursor =
      hasNextPage && pageResults.length > 0
        ? encodeNextCursor(keyset, pageResults[pageResults.length - 1])
        : null;

    return {
      data: entities,
      hasNextPage,
      nextCursor,
      count: entities.length,
    };
  }

  /**
   * The relations of a cursor page: the eager ManyToOne / owning OneToOne
   * set `find()` would JOIN (batch-loaded here — the keyset ORDER BY and
   * cursor encoding are bound to the root table, so the page statement
   * never JOINs), then the OneToMany / ManyToMany / inverse OneToOne
   * relations the caller listed. One query per relation per page.
   */
  private async loadCursorPageRelations<T>(
    entity: ClazzType<T>,
    metadata: EntityScannerMetadata,
    option: CursorPaginationOption<T>,
    entities: T[],
    session: TransactionSessionManager,
    relationTree: RelationTree | undefined,
  ): Promise<void> {
    if (entities.length === 0) return;
    const plan = this.getColumnPlan(entity, metadata);
    const relations = requestedRelationNames(option.relations);
    const { eagerM2O, eagerO2O } = this.resolveToOneRelations(plan, relations);
    await this.relationLoader.loadToOneRelations(
      entity,
      entities,
      eagerM2O,
      eagerO2O,
      session,
      option.withDeleted,
      relationTree,
    );
    if (!relations || relations.length === 0) return;
    await this.relationLoader.loadOneToManyRelations(
      entity,
      entities,
      relations,
      session,
      option.withDeleted,
      relationTree,
    );
    await this.relationLoader.loadManyToManyRelations(
      entity,
      entities,
      relations,
      session,
      option.withDeleted,
      relationTree,
    );
    await this.relationLoader.loadOneToOneRelations(
      entity,
      entities,
      relations,
      session,
      option.withDeleted,
      relationTree,
    );
  }

  /**
   * Entity instances of a cursor page: a TABLE_PER_CLASS root page (the one
   * carrying a sub key) and a JOINED root page instantiate each row's
   * subtype via the discriminator exactly like find(); every other page
   * hydrates the queried class.
   */
  private hydrateCursorRows<T>(
    entity: ClazzType<T>,
    keyset: KeysetPlan,
    page: QueryResult,
  ): T[] {
    const transformer = ResultTransformerFactory.create();
    if (keyset.subKeyColumn !== undefined) {
      const discMap = this.inheritanceResolver.buildDiscriminatorMap(entity);
      if (discMap.size > 0) {
        return transformer.toPolymorphicEntities(
          entity,
          this.pruneTpcRows(entity, page, keyset.subKeyColumn),
          discMap,
          keyset.subKeyColumn,
        );
      }
    }
    // A SINGLE_TABLE root page reads the whole table row; each row becomes
    // its subtype, holding that class's columns, as find() builds it.
    if (
      this.inheritanceResolver.getStrategy(entity) === "SINGLE_TABLE" &&
      this.inheritanceResolver.isPolymorphicQuery(entity)
    ) {
      const discMap = this.inheritanceResolver.buildDiscriminatorMap(entity);
      const discColumn = this.inheritanceResolver.getDiscriminatorColumn(entity)?.name;
      if (discMap.size > 0 && discColumn) {
        return transformer.toPolymorphicEntities(
          entity,
          page,
          discMap,
          discColumn,
          undefined,
          this.singleTableShape(entity),
        );
      }
    }
    if (this.isTptPolymorphicRoot(entity)) {
      const discCol = this.inheritanceResolver.getDiscriminatorColumn(entity);
      const discMap = this.inheritanceResolver.buildDiscriminatorMap(entity);
      if (discCol && discMap.size > 0) {
        return transformer.toTPTPolymorphicEntities(
          entity,
          page,
          discMap,
          discCol.name,
          this.tptChildPrefixMap(entity),
        );
      }
    }
    return transformer.toEntities(entity, page);
  }

  /** A JOINED root whose reads are polymorphic: it has subclasses. */
  private isTptPolymorphicRoot(entity: ClazzType<any>): boolean {
    return isJoinedPolymorphicRoot(this.inheritanceResolver, entity);
  }

  /**
   * WHERE predicates of a cursor page before the keyset clause: the caller's
   * `where`, the soft-delete filter, the STI discriminator and the tenant
   * column. Unqualified — the cursor read never JOINs.
   */
  private buildCursorWhereClauses<T>(
    entity: ClazzType<T>,
    where: WhereClause<T>,
    propToCol: Map<string, string>,
    option: CursorPaginationOption<T>,
  ): Sql[] {
    const source = this.cursorSourceName(entity);
    const whereMap: Sql[] = resolveWhereClause(where, {
      wrapColumn: (n) => this.ctx.wrap(n),
      dialect: this.ctx.getDialect(),
      dialectExpression: createDialectExpression(this.ctx.getDialect()),
      propertyToColumn: propToCol,
      relationFilter: new RelationWhereFilterBuilder(this.ctx, this.resolver, option.withDeleted).hookFor(
        entity,
        (column) => `${this.ctx.wrap(source)}.${this.ctx.wrap(column)}`,
      ),
    });

    const deletedAtColumn = this.resolver.getDeletedAtColumn(entity);
    if (deletedAtColumn && !option.withDeleted) {
      whereMap.push(Conditions.isNull(this.ctx.wrap(deletedAtColumn)));
    }

    // STI: cursor pagination on a child class must page only that subtype's
    // rows — findInternal already applies this discriminator filter, and
    // findWithCursor hits the single table directly, so mirror it here.
    const cursorSti =
      this.inheritanceResolver.getSingleTableChildDiscriminator(entity);
    if (cursorSti) {
      whereMap.push(
        Conditions.equals(this.ctx.wrap(cursorSti.columnName), cursorSti.value),
      );
    }

    // Tenant scoping under the "tenant_column" strategy. Applied before the
    // cursor clause so the final WHERE is `tenant = ? AND cursor_col > ?`.
    if (!option.withoutTenantScope) {
      const tenantPredicate = this.ctx.buildTenantWhereClause(entity);
      if (tenantPredicate) {
        whereMap.push(tenantPredicate);
      }
    }

    return whereMap;
  }

  async findAndCount<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T> = {},
  ): Promise<[T[], number]> {
    const readNode = this.ctx.getReadNode(findOption.useMaster);
    // Both the data query and the count query run on this session, so
    // wrapping it caches the pair under one policy. findInternal receives
    // the wrapped session as an existing one and never double-wraps.
    const cachePolicy =
      findOption.cache && !findOption.lock
        ? this.ctx.getQueryCache()?.policyForFind(entity, {
            cache: findOption.cache,
            relations: resolveRelationTree(entity, findOption.relations, this.resolver),
            where: findOption.where,
            counts: resolveRelationCounts(entity, findOption.withCount, this.resolver),
          })
        : undefined;
    return this.ctx.executeReadOnly(async (rawSession) => {
      const session = cachePolicy
        ? cachePolicy.wrapSession(rawSession)
        : rawSession;
      const result = await this.ctx.findInternal<T>(entity, findOption, session);
      // With groupBy the data rows are groups, so `total` must count groups
      // (honoring HAVING) — a where-only COUNT(*) counted raw rows and broke
      // findWithPage's totalPages/hasNextPage.
      const totalCount = await this.aggregateHandler.aggregate<T>(
        entity,
        "COUNT",
        "*",
        findOption.where,
        session,
        findOption.withDeleted,
        findOption.onlyDeleted,
        findOption.groupBy && findOption.groupBy.length > 0
          ? {
              groupBy: findOption.groupBy as string[],
              having: findOption.having,
            }
          : undefined,
      );

      // findInternal returns a single entity (not an array) when exactly one
      // row matches, so normalize before handing back a [T[], number] tuple.
      const entities =
        result == null ? [] : Array.isArray(result) ? result : [result];
      return [entities as T[], totalCount];
    }, { readNodeOverride: readNode, timeout: this.resolveTimeout(findOption) });
  }

  async findWithPage<T>(
    entity: ClazzType<T>,
    option: PagePaginationOption<T> = {},
  ): Promise<PagePaginationResult<T>> {
    const page = normalizePage(option.page);
    const pageSize = normalizePageSize(option.pageSize);
    const offset = (page - 1) * pageSize;

    const [rawData, total] = await this.ctx.findAndCount<T>(entity, {
      where: option.where,
      orderBy: option.orderBy,
      select: option.select,
      relations: option.relations,
      withCount: option.withCount,
      withDeleted: option.withDeleted,
      timeout: option.timeout,
      useMaster: option.useMaster,
      groupBy: option.groupBy,
      having: option.having,
      cache: option.cache,
      limit: [offset, pageSize],
    });

    const data = (rawData ?? []) as T[];
    const totalPages = Math.ceil(total / pageSize);

    return {
      data,
      total,
      page,
      pageSize,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1,
    };
  }

  async exists<T>(
    entity: ClazzType<T>,
    where?: WhereClause<T>,
    withDeleted?: boolean,
    onlyDeleted?: boolean,
  ): Promise<boolean> {
    assertWhereNotVacuous(where, "exists", entity.name);
    const c = await this.aggregateHandler.count(
      entity,
      where,
      withDeleted,
      onlyDeleted,
    );
    return c > 0;
  }

  async findByPK<T>(
    entity: ClazzType<T>,
    id: unknown,
  ): Promise<T | null> {
    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) throw new EntityMetadataNotFoundError(entity.name);
    const pkColumns = metadata.columns.filter(
      (col: ColumnMetadata) => col.options?.primary,
    );
    if (pkColumns.length === 0) {
      throw new InvalidQueryError(
        `Entity "${metadata.name}" has no primary key.`,
        "Add @PrimaryGeneratedColumn() or @PrimaryColumn() to your entity.",
      );
    }

    let where: WhereClause<T>;
    if (pkColumns.length === 1) {
      // `undefined` would drop the only condition and read an arbitrary row;
      // `null` stays a legal IS NULL lookup.
      if (id === undefined) {
        throw new InvalidQueryError(
          `findByPK() received undefined as the primary key of "${entity.name}".`,
          "An undefined key drops the only condition, so the lookup would read an arbitrary row. Check the value before calling findByPK().",
        );
      }
      where = { [this.ctx.propKey(pkColumns[0])]: id } as WhereClause<T>;
    } else {
      this.assertCompositePrimaryKey("findByPK", entity, pkColumns, id);
      where = id as WhereClause<T>;
    }

    return this.ctx.findOne<T>(entity, { where });
  }

  /**
   * A composite-key lookup needs an object that gives every key column a
   * value. The object is used as the where clause, so the resolver skips a
   * column set to `undefined`. The lookup then matches rows with any value in
   * that column, or any row at all when the whole key is missing. `null` stays
   * legal and matches IS NULL. Extra non-key properties keep filtering as
   * before.
   *
   * A key column counts as given under either spelling, because the where
   * resolver falls back to the raw key: an entity whose `tenantKey` property
   * maps to a `tenant_key` column accepts `{ tenant_key: "t1", user_id: 1 }`
   * the same way `where` does.
   */
  private assertCompositePrimaryKey<T>(
    method: "findByPK" | "findByPKs",
    entity: ClazzType<T>,
    pkColumns: ColumnMetadata[],
    id: unknown,
    index?: number,
  ): void {
    const props = pkColumns.map((col) => this.ctx.propKey(col));
    const at = index === undefined ? "" : ` at index ${index}`;

    if (id === null || typeof id !== "object") {
      throw new InvalidQueryError(
        `${method}() received ${id === null ? "null" : typeof id}${at} as the primary key of "${entity.name}", which has a composite key (${props.join(", ")}).`,
        `Pass an object with every key column, e.g. { ${props.map((p) => `${p}: ...`).join(", ")} }.`,
      );
    }

    const key = id as Record<string, unknown>;
    const missing = props.filter(
      (prop, i) =>
        key[prop] === undefined && key[pkColumns[i].name] === undefined,
    );
    if (missing.length > 0) {
      throw new InvalidQueryError(
        `${method}() received no value for primary key column${missing.length > 1 ? "s" : ""} ${missing.map((p) => `"${p}"`).join(", ")}${at} of "${entity.name}".`,
        "An undefined key column drops its condition, so the lookup would match rows with any value there. Pass every key column (null matches IS NULL).",
      );
    }
  }

  async findByPKs<T>(
    entity: ClazzType<T>,
    ids: unknown[],
  ): Promise<T[]> {
    if (ids.length === 0) return [];

    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) throw new EntityMetadataNotFoundError(entity.name);
    const pkColumns = metadata.columns.filter(
      (col: ColumnMetadata) => col.options?.primary,
    );
    if (pkColumns.length === 0) {
      throw new InvalidQueryError(
        `Entity "${metadata.name}" has no primary key.`,
        "Add @PrimaryGeneratedColumn() or @PrimaryColumn() to your entity.",
      );
    }

    if (pkColumns.length === 1) {
      // An undefined id binds as NULL inside IN and matches nothing, so its
      // row would be missing from the result without an error.
      for (let i = 0; i < ids.length; i++) {
        if (ids[i] === undefined) {
          throw new InvalidQueryError(
            `findByPKs() received undefined at index ${i} as a primary key of "${entity.name}".`,
            "An undefined id matches nothing, so its row would be missing from the result without an error. Filter the ids before calling findByPKs().",
          );
        }
      }
      const where = { [this.ctx.propKey(pkColumns[0])]: { in: ids } } as WhereClause<T>;
      return this.ctx.find<T>(entity, { where });
    }

    // Composite PK: use OR conditions
    for (let i = 0; i < ids.length; i++) {
      this.assertCompositePrimaryKey("findByPKs", entity, pkColumns, ids[i], i);
    }
    const where = { OR: ids } as WhereClause<T>;
    return this.ctx.find<T>(entity, { where });
  }

  async findByPKsMap<T>(
    entity: ClazzType<T>,
    ids: unknown[],
  ): Promise<Map<string | number | bigint, T>> {
    const metadata = this.resolver.resolveEntityMetadata(entity);
    if (!metadata) throw new EntityMetadataNotFoundError(entity.name);
    const pkColumns = metadata.columns.filter(
      (col: ColumnMetadata) => col.options?.primary,
    );
    if (pkColumns.length === 0) {
      throw new InvalidQueryError(
        `Entity "${metadata.name}" has no primary key.`,
        "Add @PrimaryGeneratedColumn() or @PrimaryColumn() to your entity.",
      );
    }

    const rows = await this.findByPKs<T>(entity, ids);
    const result = new Map<string | number | bigint, T>();

    if (pkColumns.length === 1) {
      const prop = this.ctx.propKey(pkColumns[0]);
      for (const row of rows) {
        const key = (row as any)[prop] as string | number | bigint;
        result.set(key, row);
      }
      return result;
    }

    // Composite PK: build a stable string key from the PK columns in declared
    // order, matching IdentityMapManager.buildIdentityKey's "prop=value" form.
    const props = pkColumns.map((col) => this.ctx.propKey(col));
    for (const row of rows) {
      const key = props
        .map((prop) => `${prop}=${(row as any)[prop]}`)
        .join(",");
      result.set(key, row);
    }
    return result;
  }


}
