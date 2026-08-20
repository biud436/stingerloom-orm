/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType, Logger, resolveEntityGlobs, generateUUIDv7 } from "../../utils";
import { ColumnMetadata, MetadataLayerRegistry } from "../../scanner";
import type { ManyToOneMetadata, OneToOneMetadata } from "../../decorators";
import { ISqlDriver } from "../../dialects/SqlDriver";
import { TransactionSessionManager } from "../../dialects/TransactionSessionManager";
import { FindOption, LockMode, UpdateData, UpdateManyOptions, WhereClause } from "../../dialects/FindOption";
import { resolveWhereClause } from "../WhereResolver";
import sql, { Sql, join, raw } from "../../utils/sqlTag";
import { QueryResult } from "../../types/QueryResult";
import { EntityResult } from "../../types/EntityResult";
import { RawQueryBuilderFactory } from "../RawQueryBuilderFactory";
import { Conditions } from "../Conditions";
import { ResultTransformerFactory } from "../ResultTransformerFactory";
import { injectLazyProxy } from "../LazyLoader";
import { EntityMetadataNotFoundError } from "../../errors/EntityMetadataNotFoundError";
import { InvalidQueryError } from "../../errors/InvalidQueryError";
import { EntityNotFoundError } from "../../errors/EntityNotFoundError";
import {
  CursorPaginationOption,
  CursorPaginationResult,
  encodeCursor,
  decodeCursor,
  normalizePageSize,
} from "../CursorPagination";
import {
  PagePaginationOption,
  PagePaginationResult,
  normalizePage,
} from "../PagePagination";
import { EntityManagerInternals } from "../EntityManagerInternals";
import { RelationMetadataResolver } from "../RelationMetadataResolver";
import { validateRelationNames } from "../RelationNameValidator";
import { buildEntityColumnScope, validateReadIdentifiers } from "../ColumnNameValidator";
import { RelationLoader } from "../RelationLoader";
import { AggregateQueryHandler } from "../AggregateQueryHandler";
import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";
import { InheritanceResolver } from "../InheritanceResolver";
import { createDialectExpression } from "../../dialects/DialectExpression";

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

  // Narrowable driver view + live collaborators (read at call time so test-time
  // reassignment on EntityManager is honored).
  private get driver(): ISqlDriver | undefined { return this.ctx.getDriver(); }
  private get resolver(): RelationMetadataResolver { return this.ctx.getResolver(); }
  private get inheritanceResolver(): InheritanceResolver { return this.ctx.getInheritanceResolver(); }
  private get relationLoader(): RelationLoader { return this.ctx.getRelationLoader(); }
  private get aggregateHandler(): AggregateQueryHandler { return this.ctx.getAggregateHandler(); }
  private get defaultQueryTimeout(): number | undefined { return this.ctx.getDefaultQueryTimeout(); }

  async findOne<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T>,
  ): Promise<T | null> {
    return this.ctx.findOneInternal(entity, findOption);
  }

  async findOneBy<T>(
    entity: ClazzType<T>,
    where: WhereClause<T> | WhereClause<T>[],
  ): Promise<T | null> {
    return this.ctx.findOne(entity, { where });
  }

  async findOneInternal<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T>,
    existingSession?: TransactionSessionManager,
  ): Promise<T | null> {
    const result = await this.ctx.findInternal<T>(entity, { ...findOption, limit: 1 }, existingSession);
    if (result === undefined || result === null) {
      return null;
    }
    if (Array.isArray(result)) {
      return (result[0] as T) ?? null;
    }
    return result as T;
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

  async findInternal<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T> = {},
    existingSession?: TransactionSessionManager,
  ): Promise<EntityResult<T>> {
    const { select, orderBy, where, take, skip, groupBy, having } = findOption;
    const { limit } = findOption;

    // Validate pagination values
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

    // Reject relation names no loader can resolve. Every loader filters with
    // `relations.includes(...)`, so without this an unmatched name produced a
    // successful query whose relation property stayed undefined.
    validateRelationNames(entity, findOption.relations, this.resolver);

    const readNode = this.ctx.getReadNode(findOption.useMaster);
    const effectiveTimeout = findOption.timeout ?? this.defaultQueryTimeout;

    return this.ctx.executeReadOnly(async (session) => {
      const resultTransformer = ResultTransformerFactory.create();

      const metadata = this.resolver.resolveEntityMetadata(entity);

      if (!metadata) {
        throw new EntityMetadataNotFoundError(entity.name);
      }

      // ── Detect the inheritance strategy early ──
      const inheritanceStrategy = this.inheritanceResolver.getStrategy(entity);
      const isTPTChild = inheritanceStrategy === "JOINED" && this.inheritanceResolver.isChildEntity(entity);
      const isTPTPolymorphic = inheritanceStrategy === "JOINED" && this.inheritanceResolver.isPolymorphicQuery(entity);
      const isTPCPolymorphic = inheritanceStrategy === "TABLE_PER_CLASS" && this.inheritanceResolver.isPolymorphicQuery(entity);

      const qb = RawQueryBuilderFactory.create();

      const selectMap: string[] = [];
      const whereMap: Sql[] = [];
      const orderByMap: Array<{ column: string; direction: "ASC" | "DESC" }> =
        [];

      const plan = this.getColumnPlan(entity, metadata);

      // Collect ManyToOne relations to eager-load
      const manyToOneRelations = plan.manyToOne;
      const eagerRelations = findOption.relations
        ? manyToOneRelations.filter(
            (rel) =>
              rel.option?.eager === true ||
              findOption.relations!.includes(rel.columnName),
          )
        : plan.eagerM2O;

      // Collect OneToOne relations to eager-load (owning side — the side with joinColumn)
      const oneToOneRelations = plan.oneToOne;
      const eagerOneToOneRelations = findOption.relations
        ? oneToOneRelations.filter(
            (rel) =>
              !!rel.joinColumn &&
              (rel.option?.eager === true ||
                findOption.relations!.includes(rel.propertyKey)),
          )
        : plan.eagerO2O;

      const hasEagerJoins =
        eagerRelations.length > 0 || eagerOneToOneRelations.length > 0
        || isTPTChild || isTPTPolymorphic;

      const tableName = metadata.name;

      // Build property-to-column map once and reuse throughout findInternal
    const propToCol = this.ctx.buildPropertyToColumnMap(metadata);

      // Reject column identifiers no builder can resolve. `where` / `orderBy`
      // / `select` fall back to the raw key when it is not in the property
      // map, so a typo used to travel to the driver and come back as a
      // dialect-specific "no such column" that never named the alternatives.
      validateReadIdentifiers(
        findOption,
        select ? this.ctx.resolveSelectColumns<T>(select) : undefined,
        buildEntityColumnScope({
          entity,
          metadata,
          propertyToColumn: propToCol,
          computedColumns: this.ctx.getComputedColumnNames(entity),
          inheritanceResolver: this.inheritanceResolver,
        }),
      );

    // TPT child: build SELECT by separating child-table columns (PK + own) from parent columns
      if (isTPTChild) {
        const root = this.inheritanceResolver.getRoot(entity)!;
        const rootMeta = this.resolver.resolveEntityMetadata(root);
        if (rootMeta) {
          const rootTableName = rootMeta.name;
          const rootColNames = new Set(
            rootMeta.columns.map((c: any) => c.name),
          );
          const pkColNames = new Set(
            metadata.columns
              .filter((c: any) => c.options?.primary)
              .map((c: any) => c.name),
          );

          // Columns that physically exist on the child table: PK + own (excluding parent-only columns)
          for (const col of metadata.columns) {
            const isPk = pkColNames.has(col.name);
            const isRootOnly = rootColNames.has(col.name) && !isPk;
            if (!isRootOnly) {
              selectMap.push(
                `${this.ctx.wrap(tableName)}.${this.ctx.wrap(col.name)}`,
              );
            }
          }

          // Non-PK columns from the parent table
          for (const col of rootMeta.columns) {
            if (pkColNames.has(col.name)) continue;
            selectMap.push(
              `${this.ctx.wrap(rootTableName)}.${this.ctx.wrap(col.name)}`,
            );
          }
        }
      } else if (select) {
        const selectedColumns = this.ctx.resolveSelectColumns<T>(select)
          .map((prop) => propToCol.get(prop) ?? prop);
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

      // TPT polymorphic: add each child table's unique columns to SELECT (with a prefix alias)
      if (isTPTPolymorphic) {
        const pk = metadata.columns.find((c: any) => c.options?.primary);
        const children = this.inheritanceResolver
          .getConcreteEntities(entity)
          .filter((c) => c !== entity);
        for (const ChildEntity of children) {
          const childMeta = this.resolver.resolveEntityMetadata(ChildEntity);
          if (!childMeta || !pk) continue;
          const childTableName = childMeta.name;
          const ownCols = this.inheritanceResolver.getOwnColumns(ChildEntity);
          for (const col of ownCols) {
            selectMap.push(
              `${this.ctx.wrap(childTableName)}.${this.ctx.wrap(col.name)} AS ${this.ctx.wrap(`${childTableName}_${col.name}`)}`,
            );
          }
        }
      }

      // Add eager ManyToOne relation columns to SELECT.
      //
      // Each relation gets its own table alias (`rel.columnName` — the
      // property name like "assignee" / "reporter") so that two relations
      // pointing at the same entity (e.g. Issue → assignee + reporter, both
      // → User) emit `LEFT JOIN user AS assignee` and `LEFT JOIN user AS
      // reporter` instead of two `LEFT JOIN user AS user`. The latter
      // tripped MariaDB's "Not unique table/alias" error.
      for (const rel of eagerRelations) {
        const RelatedEntity = rel.getMappingEntity() as ClazzType<any>;
        const relatedMetadata = this.resolver.resolveEntityMetadata(RelatedEntity);
        if (!relatedMetadata) continue;

        const relAlias = rel.columnName;
        for (const col of relatedMetadata.columns) {
          const alias = `${rel.columnName}_${col.name}`;
          selectMap.push(
            `${this.ctx.wrap(relAlias)}.${this.ctx.wrap(col.name)} AS ${this.ctx.wrap(alias)}`,
          );
        }
      }

      // Add eager OneToOne relation columns to SELECT — same per-property alias.
      for (const rel of eagerOneToOneRelations) {
        const RelatedEntity = rel.getRelatedEntity() as ClazzType<any>;
        const relatedMetadata = this.resolver.resolveEntityMetadata(RelatedEntity);
        if (!relatedMetadata) continue;

        const relAlias = rel.propertyKey;
        for (const col of relatedMetadata.columns) {
          const alias = `${rel.propertyKey}_${col.name}`;
          selectMap.push(
            `${this.ctx.wrap(relAlias)}.${this.ctx.wrap(col.name)} AS ${this.ctx.wrap(alias)}`,
          );
        }
      }

      // TPT child: qualify a column with the parent table if it belongs to the parent, else with the child table
      let tptQualifyColumn: ((dbCol: string) => string) | undefined;
      if (isTPTChild) {
        const tptRoot = this.inheritanceResolver.getRoot(entity)!;
        const tptRootMeta = this.resolver.resolveEntityMetadata(tptRoot);
        if (tptRootMeta) {
          const tptRootTableName = tptRootMeta.name;
          const tptPkNames = new Set(
            metadata.columns
              .filter((c: any) => c.options?.primary)
              .map((c: any) => c.name),
          );
          const tptRootOnlyCols = new Set(
            tptRootMeta.columns
              .filter((c: any) => !tptPkNames.has(c.name))
              .map((c: any) => c.name),
          );
          tptQualifyColumn = (dbCol: string) => {
            if (tptRootOnlyCols.has(dbCol)) {
              return `${this.ctx.wrap(tptRootTableName)}.${this.ctx.wrap(dbCol)}`;
            }
            return `${this.ctx.wrap(tableName)}.${this.ctx.wrap(dbCol)}`;
          };
        }
      }

      whereMap.push(
        ...resolveWhereClause(where, {
          wrapColumn: (n) => this.ctx.wrap(n),
          qualified: hasEagerJoins,
          tableName: hasEagerJoins ? tableName : undefined,
          dialect: this.ctx.getDialect(),
          dialectExpression: createDialectExpression(this.ctx.getDialect()),
          propertyToColumn: propToCol,
          qualifyColumn: tptQualifyColumn,
        }),
      );

      // STI: when querying a child entity, add a discriminator WHERE condition
      if (inheritanceStrategy === "SINGLE_TABLE" && this.inheritanceResolver.isChildEntity(entity)) {
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
      // The column is resolved + escaped via the same wrap()/Conditions helpers
      // the default IS NULL injection uses; for entities without a @DeletedAt
      // column this whole block is skipped (onlyDeleted is a silent no-op).
      const deletedAtColumn = this.resolver.getDeletedAtColumn(entity);
      if (deletedAtColumn) {
        const deletedAtRef = hasEagerJoins
          ? `${this.ctx.wrap(tableName)}.${this.ctx.wrap(deletedAtColumn)}`
          : this.ctx.wrap(deletedAtColumn);
        if (findOption.onlyDeleted) {
          whereMap.push(Conditions.isNotNull(deletedAtRef));
        } else if (!findOption.withDeleted) {
          whereMap.push(Conditions.isNull(deletedAtRef));
        }
      }

      // Tenant scoping under the "tenant_column" strategy. Skipped when the
      // caller explicitly opts out via `findOption.withoutTenantScope`.
      if (!findOption.withoutTenantScope) {
        const tenantPredicate = this.ctx.buildTenantWhereClause(
          entity,
          hasEagerJoins ? tableName : undefined,
        );
        if (tenantPredicate) {
          whereMap.push(tenantPredicate);
        }
      }

      // Qualify orderBy references the same way select/where/groupBy are —
      // with eager joins present, a shared column name (id, createdAt, ...)
      // is otherwise ambiguous. TPT children route through tptQualifyColumn
      // so parent-only columns are qualified with the parent table.
      for (const key in orderBy) {
        const value = orderBy[key];
        if (value) {
          const dbCol = propToCol.get(key) ?? key;
          const column = tptQualifyColumn
            ? tptQualifyColumn(dbCol)
            : hasEagerJoins
              ? `${this.ctx.wrap(tableName)}.${this.ctx.wrap(dbCol)}`
              : this.ctx.wrap(dbCol);
          orderByMap.push({ column, direction: value });
        }
      }

      // TPC polymorphic: build the FROM clause from a UNION ALL subquery
      if (isTPCPolymorphic) {
        const allEntities = this.inheritanceResolver.getConcreteEntities(entity);
        const allHierarchyCols = this.inheritanceResolver
          .getAllHierarchyColumns(entity)
          .map((c) => c.name);
        const discCol = this.inheritanceResolver.getDiscriminatorColumn(entity);
        const discColName = discCol?.name ?? "dtype";

        const subQueries: Sql[] = [];
        for (const ent of allEntities) {
          const entMeta = this.resolver.resolveEntityMetadata(ent);
          if (!entMeta) continue;
          const entTableName = entMeta.name;
          const entColNames = new Set(
            entMeta.columns.map((c: any) => c.name),
          );
          const discVal =
            this.inheritanceResolver.getDiscriminatorValue(ent) ?? ent.name;

          const colExprs: Sql[] = allHierarchyCols.map((colName) =>
            entColNames.has(colName)
              ? sql`${raw(this.ctx.wrap(colName))}`
              : sql`NULL AS ${raw(this.ctx.wrap(colName))}`,
          );
          colExprs.push(sql`${discVal} AS ${raw(this.ctx.wrap(discColName))}`);

          const subSql = sql`SELECT ${join(colExprs, ", ")} FROM ${raw(this.ctx.wrapTable(entTableName))}`;
          subQueries.push(subSql);
        }

        const unionSql = join(subQueries, " UNION ALL ");
        qb.select(["*"]).from(sql`(${unionSql})`, this.ctx.wrap("_tpc"));
      } else if (findOption.distinct) {
        qb.selectDistinct(selectMap).from(this.ctx.wrapTable(tableName));
      } else {
        qb.select(selectMap).from(this.ctx.wrapTable(tableName));
      }

      // TPT child: INNER JOIN the parent table
      if (isTPTChild) {
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
      if (isTPTPolymorphic) {
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

      // Eager ManyToOne LEFT JOIN
      for (const rel of eagerRelations) {
        const RelatedEntity = rel.getMappingEntity() as ClazzType<any>;
        const relatedMetadata = this.resolver.resolveEntityMetadata(RelatedEntity);
        if (!relatedMetadata) continue;

        const relatedTableName = relatedMetadata.name || RelatedEntity.name;
        const joinColumn = rel.joinColumn ?? rel.columnName;

        const relatedPk = relatedMetadata.columns.find(
          (col: any) => col.options?.primary,
        );
        if (!relatedPk) continue;

        // TPT child: if the FK column lives on the parent table, qualify it with the parent table
        let fkTableName = tableName;
        if (isTPTChild) {
          const root = this.inheritanceResolver.getRoot(entity)!;
          const rootMeta = this.resolver.resolveEntityMetadata(root);
          if (rootMeta) {
            const rootColNames = new Set(rootMeta.columns.map((c: any) => c.name));
            if (rootColNames.has(joinColumn)) {
              fkTableName = rootMeta.name;
            }
          }
        }

        // Use the property name as the JOIN alias so multiple relations to
        // the same target entity (e.g. assignee + reporter → User) get
        // distinct aliases.
        const relAlias = rel.columnName;
        let joinCondition = sql`${raw(this.ctx.wrap(fkTableName))}.${raw(this.ctx.wrap(joinColumn))} = ${raw(this.ctx.wrap(relAlias))}.${raw(this.ctx.wrap(relatedPk.name))}`;

        // Keep eager and lazy soft-delete semantics in sync: a soft-deleted
        // target should surface as a null relation, not silently leak in.
        // Putting the predicate in the ON clause (not WHERE) preserves the
        // parent row. Skipped under `withDeleted` so trashed rows are included.
        const relatedDeletedAt = this.resolver.getDeletedAtColumn(RelatedEntity);
        if (relatedDeletedAt && !(findOption as any).withDeleted) {
          joinCondition = sql`${joinCondition} AND ${raw(this.ctx.wrap(relAlias))}.${raw(this.ctx.wrap(relatedDeletedAt))} IS NULL`;
        }

        qb.leftJoin(
          this.ctx.wrapTable(relatedTableName),
          this.ctx.wrap(relAlias),
          joinCondition,
        );
      }

      // OneToOne Eager LEFT JOIN
      for (const rel of eagerOneToOneRelations) {
        const RelatedEntity = rel.getRelatedEntity() as ClazzType<any>;
        const relatedMetadata = this.resolver.resolveEntityMetadata(RelatedEntity);
        if (!relatedMetadata) continue;

        const relatedTableName = relatedMetadata.name || RelatedEntity.name;
        const joinColumn = rel.joinColumn!;

        const relatedPk = relatedMetadata.columns.find(
          (col: any) => col.options?.primary,
        );
        if (!relatedPk) continue;

        const relAlias = rel.propertyKey;
        let joinCondition = sql`${raw(this.ctx.wrap(tableName))}.${raw(this.ctx.wrap(joinColumn))} = ${raw(this.ctx.wrap(relAlias))}.${raw(this.ctx.wrap(relatedPk.name))}`;

        // Mirror the ManyToOne eager join: filter soft-deleted counterparts in
        // the ON clause so the parent row survives, unless `withDeleted` is set.
        const relatedDeletedAt = this.resolver.getDeletedAtColumn(RelatedEntity);
        if (relatedDeletedAt && !(findOption as any).withDeleted) {
          joinCondition = sql`${joinCondition} AND ${raw(this.ctx.wrap(relAlias))}.${raw(this.ctx.wrap(relatedDeletedAt))} IS NULL`;
        }

        qb.leftJoin(
          this.ctx.wrapTable(relatedTableName),
          this.ctx.wrap(relAlias),
          joinCondition,
        );
      }

      qb.where(whereMap);

      // GROUP BY / HAVING
      if (groupBy && groupBy.length > 0) {
        const groupByColumns = (groupBy as string[]).map((col) =>
          hasEagerJoins
            ? `${this.ctx.wrap(tableName)}.${this.ctx.wrap(col)}`
            : this.ctx.wrap(col),
        );
        qb.groupBy(groupByColumns);
      }

      if (having && having.length > 0) {
        qb.having(having);
      }

      qb.orderBy(orderByMap);

      // LIMIT tuple syntax is dialect-specific (mirrors ExplainQueryHandler,
      // #145): the builder defaults to MySQL's `LIMIT off, cnt`, which
      // PostgreSQL rejects — so the dialect must be set for every driver,
      // not just the MySQL family.
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
      if (findOption.lock) {
        const lockSuffix = this.ctx.resolveLockSuffix(findOption.lock);
        qb.appendSql(raw(lockSuffix));
      }

      const resultQuery = qb.build();

      // Apply per-query or connection-level timeout
      const effectiveTimeout = findOption.timeout ?? this.defaultQueryTimeout;
      if (effectiveTimeout && effectiveTimeout > 0 && this.driver) {
        const timeoutSql = this.driver.setQueryTimeout(effectiveTimeout);
        await session.query(timeoutSql);
      }

      const queryStartTime = Date.now();
      this.ctx.beginTrackQuery();
      const queryResult = (await session.query<T>(
        resultQuery,
      )) as QueryResult;
      this.ctx.trackQuery(
        entity.name,
        resultQuery.text ?? String(resultQuery),
        Date.now() - queryStartTime,
      );

      const { results } = queryResult;
      if (!results || results.length === 0) {
        return undefined;
      }

      // SQLite: convert INTEGER 0/1 back to boolean
      if (this.ctx.isSqlite() && results.length > 0) {
        const boolColumns = plan.boolColumns;
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

      const isEntityArray = results.length > 1;
      let entityResult: EntityResult<T>;

      // STI/TPC: polymorphic query on the root entity — instantiate the correct subclass via the discriminator
      if (
        (inheritanceStrategy === "SINGLE_TABLE" || isTPCPolymorphic) &&
        this.inheritanceResolver.isPolymorphicQuery(entity) &&
        !(hasEagerJoins && !isTPCPolymorphic)
      ) {
        const discCol = this.inheritanceResolver.getDiscriminatorColumn(entity);
        const discColName = discCol?.name ?? "dtype";
        const discMap = this.inheritanceResolver.buildDiscriminatorMap(entity);
        if (discMap.size > 0) {
          entityResult = resultTransformer.toPolymorphicEntities(
            entity,
            queryResult,
            discMap,
            discColName,
          ) as EntityResult<T>;
        } else if (isEntityArray) {
          entityResult = resultTransformer.toEntities(entity, queryResult);
        } else {
          entityResult = resultTransformer.toEntity(entity, queryResult);
        }
      } else if (isTPTPolymorphic) {
        // TPT polymorphic: resolve child columns via their prefixes
        const discCol = this.inheritanceResolver.getDiscriminatorColumn(entity);
        const discMap = this.inheritanceResolver.buildDiscriminatorMap(entity);
        if (discCol && discMap.size > 0) {
          const childPrefixMap = new Map<string, string>();
          const children = this.inheritanceResolver
            .getConcreteEntities(entity)
            .filter((c) => c !== entity);
          for (const child of children) {
            const childMeta = this.resolver.resolveEntityMetadata(child);
            const dv = this.inheritanceResolver.getDiscriminatorValue(child);
            if (childMeta && dv) {
              childPrefixMap.set(dv, childMeta.name);
            }
          }
          entityResult = resultTransformer.toTPTPolymorphicEntities(
            entity,
            queryResult,
            discMap,
            discCol.name,
            childPrefixMap,
          ) as EntityResult<T>;
        } else if (isEntityArray) {
          entityResult = resultTransformer.toEntities(entity, queryResult);
        } else {
          entityResult = resultTransformer.toEntity(entity, queryResult);
        }
      } else if (hasEagerJoins && !isTPTChild) {
        entityResult = resultTransformer.transformNested(
          entity,
          queryResult,
        ) as EntityResult<T>;
      } else if (isTPTChild && eagerRelations.length > 0) {
        // TPT child + eager ManyToOne: deserialize the relation through transformNested
        entityResult = resultTransformer.transformNested(
          entity,
          queryResult,
        ) as EntityResult<T>;
      } else if (isEntityArray) {
        entityResult = resultTransformer.toEntities(entity, queryResult);
      } else {
        entityResult = resultTransformer.toEntity(entity, queryResult);
      }

      // Load OneToMany / ManyToMany / OneToOne(inverse) relations
      if (
        findOption.relations &&
        findOption.relations.length > 0 &&
        entityResult
      ) {
        await this.relationLoader.loadOneToManyRelations(
          entity,
          entityResult as T | T[],
          findOption.relations,
          session,
          findOption.withDeleted,
        );
        await this.relationLoader.loadManyToManyRelations(
          entity,
          entityResult as T | T[],
          findOption.relations,
          session,
          findOption.withDeleted,
        );
        await this.relationLoader.loadOneToOneRelations(
          entity,
          entityResult as T | T[],
          findOption.relations,
          session,
          findOption.withDeleted,
        );
      }

      // Inject a Proxy for each lazy ManyToOne relation
      const lazyRelations = manyToOneRelations.filter((rel) => {
        return rel.option?.lazy === true && rel.option?.eager !== true;
      });

      if (lazyRelations.length > 0 && entityResult) {
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
            injectLazyProxy(item as any, rel.columnName, async () => {
              const result = await em.findOne(RelatedEntity, {
                where: { [this.ctx.propKey(relatedPk)]: fkValue } as any,
                withDeleted: proxyWithDeleted,
              });
              return result as any;
            });
          }
        }
      }

      // Notify subscribers of the afterLoad event
      if (entityResult) {
        const loadedEntities = Array.isArray(entityResult) ? entityResult : [entityResult];
        for (const loadedEntity of loadedEntities) {
          await this.ctx.notifySubscribers(entity, "afterLoad", loadedEntity);
        }
      }

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

    let cursorValue: unknown = null;
    if (option.cursor) {
      cursorValue = decodeCursor(option.cursor);
      if (cursorValue === null) {
        throw new InvalidQueryError(
          "Invalid cursor value.",
          "Ensure the cursor string was returned from a previous findWithCursor() call.",
        );
      }
    }

    const where: any = { ...(option.where ?? {}) };
    const readNode = this.ctx.getReadNode(option.useMaster);

    return this.ctx.executeReadOnly(async (session) => {
      const resultTransformer = ResultTransformerFactory.create();

      const tableName = metadata.name;
      const qb = RawQueryBuilderFactory.create();

      // Same FK-column merge as findInternal: include @RelationColumn-derived
      // FK columns that have no matching @Column, otherwise the cursor result
      // rows lack `${rel}Id` accessors after deserialization.
      const allColNames = metadata.columns
        .map((c: any) => c.name as string | undefined)
        .filter((n): n is string => !!n);
      const seenCols = new Set<string>(allColNames);
      const cursorManyToOnes = this.resolver.resolveManyToOneMetadata(entity);
      const cursorOneToOnes = this.resolver.resolveOneToOneMetadata(entity);
      for (const rel of cursorManyToOnes) {
        if (rel.joinColumn && !seenCols.has(rel.joinColumn)) {
          allColNames.push(rel.joinColumn);
          seenCols.add(rel.joinColumn);
        }
      }
      for (const rel of cursorOneToOnes) {
        if (rel.joinColumn && !seenCols.has(rel.joinColumn)) {
          allColNames.push(rel.joinColumn);
          seenCols.add(rel.joinColumn);
        }
      }
      const selectMap = allColNames.map((name) => this.ctx.wrap(name));

      // Map the orderBy property key to its DB column name so cursor pagination
      // honors the naming strategy (e.g. SnakeNamingStrategy maps `createdAt`
      // -> `created_at`). Mirrors the find() orderBy mapping. The default value
      // is already a column name (pk.name), so it passes through unchanged.
      const propToCol = this.ctx.buildPropertyToColumnMap(metadata);

      // Same identifier guard as findInternal, so a cursor query rejects a
      // typo'd where key or sort column with the valid list instead of a raw
      // driver error.
      validateReadIdentifiers(
        { where, orderBy: { [orderByColumn]: direction } },
        undefined,
        buildEntityColumnScope({
          entity,
          metadata,
          propertyToColumn: propToCol,
          computedColumns: this.ctx.getComputedColumnNames(entity),
          inheritanceResolver: this.inheritanceResolver,
        }),
      );

      const dbOrderByColumn = propToCol.get(orderByColumn) ?? orderByColumn;

      const whereMap: Sql[] = resolveWhereClause(where, {
        wrapColumn: (n) => this.ctx.wrap(n),
        dialect: this.ctx.getDialect(),
        dialectExpression: createDialectExpression(this.ctx.getDialect()),
        propertyToColumn: propToCol,
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

      if (cursorValue !== null) {
        if (direction === "ASC") {
          // Include NULL rows that haven't been seen yet (NULLs sort last in ASC)
          whereMap.push(Conditions.or([
            Conditions.gt(this.ctx.wrap(dbOrderByColumn), cursorValue),
            Conditions.isNull(this.ctx.wrap(dbOrderByColumn)),
          ]));
        } else {
          // Include NULL rows that haven't been seen yet (NULLs sort first in DESC)
          whereMap.push(Conditions.or([
            Conditions.lt(this.ctx.wrap(dbOrderByColumn), cursorValue),
            Conditions.isNull(this.ctx.wrap(dbOrderByColumn)),
          ]));
        }
      }

      qb.select(selectMap)
        .from(this.ctx.wrapTable(tableName))
        .where(whereMap)
        .orderBy([{ column: this.ctx.wrap(dbOrderByColumn), direction }]);

      qb.limit(pageSize + 1);

      const resultQuery = qb.build();

      const queryResult = (await session.query<T>(
        resultQuery,
      )) as QueryResult;

      const { results } = queryResult;
      if (!results || results.length === 0) {
        return {
          data: [],
          hasNextPage: false,
          nextCursor: null,
          count: 0,
        };
      }

      const hasNextPage = results.length > pageSize;
      const pageResults = hasNextPage ? results.slice(0, pageSize) : results;

      const entities = resultTransformer.toEntities(entity, {
        results: pageResults,
        fields: queryResult.fields,
      });

      // Notify subscribers of the afterLoad event
      for (const loadedEntity of entities) {
        await this.ctx.notifySubscribers(entity, "afterLoad", loadedEntity);
      }

      let nextCursor: string | null = null;
      if (hasNextPage && pageResults.length > 0) {
        const lastItem = pageResults[pageResults.length - 1];
        // Raw rows are keyed by DB column name, so read with the mapped column.
        const lastValue = lastItem[dbOrderByColumn];
        nextCursor = encodeCursor(lastValue);
      }

      return {
        data: entities,
        hasNextPage,
        nextCursor,
        count: entities.length,
      };
    }, { readNodeOverride: readNode });
  }

  async findAndCount<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T> = {},
  ): Promise<[T[], number]> {
    const readNode = this.ctx.getReadNode(findOption.useMaster);
    return this.ctx.executeReadOnly(async (session) => {
      const result = await this.ctx.findInternal<T>(entity, findOption, session);
      const totalCount = await this.aggregateHandler.aggregate<T>(entity, "COUNT", "*", findOption.where, session, findOption.withDeleted, findOption.onlyDeleted);

      // findInternal returns a single entity (not an array) when exactly one
      // row matches, so normalize before handing back a [T[], number] tuple.
      const entities =
        result == null ? [] : Array.isArray(result) ? result : [result];
      return [entities as T[], totalCount];
    }, { readNodeOverride: readNode, timeout: findOption.timeout });
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
      withDeleted: option.withDeleted,
      timeout: option.timeout,
      useMaster: option.useMaster,
      groupBy: option.groupBy,
      having: option.having,
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
      where = { [this.ctx.propKey(pkColumns[0])]: id } as WhereClause<T>;
    } else {
      where = id as WhereClause<T>;
    }

    return this.ctx.findOne<T>(entity, { where });
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
      const where = { [this.ctx.propKey(pkColumns[0])]: { in: ids } } as WhereClause<T>;
      return this.ctx.find<T>(entity, { where });
    }

    // Composite PK: use OR conditions
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
