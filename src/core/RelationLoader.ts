/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../utils";
import { ColumnMetadata } from "../scanner";
import { TransactionSessionManager } from "../dialects/TransactionSessionManager";
import sql, { Sql, raw } from "../utils/sqlTag";
import { RawQueryBuilderFactory } from "./RawQueryBuilderFactory";
import { ResultTransformerFactory } from "./ResultTransformerFactory";
import { QueryResult } from "../types/QueryResult";
import { RelationMetadataResolver } from "./RelationMetadataResolver";
import { EntityManagerInternals } from "./EntityManagerInternals";
import { Conditions } from "./Conditions";
import {
  buildTpcUnionSource,
  isTpcPolymorphicRoot,
  pruneTpcSiblingColumns,
  TPC_UNION_ALIAS,
  tpcSourceContextOf,
} from "./TpcUnionSource";
import type {
  ManyToManyMetadata,
  ManyToOneMetadata,
  OneToManyMetadata,
  OneToOneMetadata,
} from "../decorators";
import type { RelationQueryOptions, RelationTree } from "./RelationTree";
import { relationTargetOf } from "./RelationNameValidator";
import { resolveWhereClause } from "./WhereResolver";
import { RelationWhereFilterBuilder } from "./RelationWhereFilter";
import { createDialectExpression } from "../dialects/DialectExpression";
import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";

/** Alias of the per-parent row number a paged collection read ranks by. */
const ROW_NUMBER_ALIAS = "__stg_rn";
/** Alias of the derived table a paged collection read filters by row number. */
const PAGED_ALIAS = "__stg_paged";

/**
 * A loaded entity instance viewed as a property-indexable record. Relation
 * loading reads parent PKs and writes loaded relations by property key onto
 * instances the caller typed as `T`; this alias names that dynamic access.
 */
type EntityRecord = Record<string, unknown>;

/**
 * Handler for relation sub-query loading (OneToMany, ManyToMany, OneToOne).
 * Invoked on behalf of EntityManager.
 *
 * Every relation load uses a batched IN query to avoid N+1 problems.
 */
export class RelationLoader {
  constructor(
    private readonly resolver: RelationMetadataResolver,
    private readonly ctx: EntityManagerInternals,
  ) {}

  /**
   * Normalizes the caller's parent result(s) into an array of indexable
   * records — the single widening point for the dynamic property access
   * every loader below performs.
   */
  private toParentRecords<T>(parentResults: T | T[]): EntityRecord[] {
    const parents = Array.isArray(parentResults)
      ? parentResults
      : [parentResults];
    return parents as unknown as EntityRecord[];
  }

  /**
   * Where a batched read of `RelatedEntity` rows comes from, and how its rows
   * become entities.
   *
   * A TABLE_PER_CLASS root keeps only its own instances in its table; its
   * subclasses' rows live in theirs. A relation targeting the root is read
   * from the UNION ALL over every concrete table and each row instantiated
   * as its subclass, as find() on the root reads them — reading the root's
   * table alone left out every subclass row.
   */
  private relatedRowSource(
    RelatedEntity: ClazzType<any>,
    relatedMetadata: { name?: string; columns: ColumnMetadata[] },
  ): {
    columns: string[];
    from: Sql | string;
    alias?: string;
    toEntities: (rows: any[]) => any[];
  } {
    const transformer = ResultTransformerFactory.create();
    const inheritanceResolver = this.ctx.getInheritanceResolver();
    if (isTpcPolymorphicRoot(inheritanceResolver, RelatedEntity)) {
      const tpcContext = tpcSourceContextOf(this.ctx, this.resolver);
      const discColumn =
        inheritanceResolver.getDiscriminatorColumn(RelatedEntity)?.name ?? "dtype";
      const discMap = inheritanceResolver.buildDiscriminatorMap(RelatedEntity);
      return {
        columns: [`${this.ctx.wrap(TPC_UNION_ALIAS)}.*`],
        from: sql`(${buildTpcUnionSource(tpcContext, RelatedEntity)})`,
        alias: this.ctx.wrap(TPC_UNION_ALIAS),
        toEntities: (rows) =>
          transformer.toPolymorphicEntities(
            RelatedEntity,
            {
              results: pruneTpcSiblingColumns(tpcContext, RelatedEntity, rows, discColumn),
            } as QueryResult,
            discMap,
            discColumn,
          ),
      };
    }
    return {
      columns: this.readColumns(RelatedEntity, relatedMetadata).map((name) => this.ctx.wrap(name)),
      from: this.ctx.wrapTable(relatedMetadata.name ?? RelatedEntity.name),
      toEntities: (rows) =>
        transformer.toEntities(RelatedEntity, { results: rows } as QueryResult),
    };
  }

  /**
   * The columns a relation read selects for `RelatedEntity`: the same set
   * `find()` reads for it — every @Column, the join column of each of its
   * own ManyToOne / owning OneToOne relations and its @ComputedColumns — so
   * an entity reached through a relation carries the same properties, and
   * the keys its own nested relations are loaded by.
   */
  private readColumns(
    RelatedEntity: ClazzType<any>,
    relatedMetadata: { name?: string; columns: ColumnMetadata[] },
  ): readonly string[] {
    return this.ctx.getReadColumnNames(RelatedEntity, {
      name: relatedMetadata.name ?? RelatedEntity.name,
      columns: relatedMetadata.columns,
    });
  }

  /** The query options `tree` gives the relation `name`, if any. */
  private static optionsOf(
    tree: RelationTree | undefined,
    name: string,
  ): RelationQueryOptions | undefined {
    return tree?.nodes.get(name)?.options;
  }

  /**
   * The relation's own `where`, resolved against the related entity's
   * columns. `table` qualifies the columns when the statement reads a second
   * table (the ManyToMany join table).
   */
  private relationWhere(
    RelatedEntity: ClazzType<any>,
    relatedMetadata: { name?: string; columns: ColumnMetadata[] },
    options: RelationQueryOptions | undefined,
    withDeleted: boolean | undefined,
    source: string,
    table?: string,
  ): Sql[] {
    if (options?.where === undefined) return [];
    const dialect = this.ctx.getDialect();
    return resolveWhereClause(options.where as any, {
      wrapColumn: (n) => this.ctx.wrap(n),
      qualified: table !== undefined,
      tableName: table,
      dialect,
      dialectExpression: createDialectExpression(dialect),
      propertyToColumn: this.ctx.buildPropertyToColumnMap(relatedMetadata as any),
      relationFilter: new RelationWhereFilterBuilder(this.ctx, this.resolver, withDeleted).hookFor(
        RelatedEntity,
        (column) => `${this.ctx.wrap(source)}.${this.ctx.wrap(column)}`,
      ),
    });
  }

  /**
   * The ORDER BY of a relation read: the relation's `orderBy`, mapped from
   * property names to columns. `qualify` turns a column into the expression
   * the statement reads it by.
   */
  private relationOrder(
    relatedMetadata: { columns: ColumnMetadata[] },
    options: RelationQueryOptions | undefined,
    qualify: (column: string) => string,
  ): Array<{ column: string; direction: "ASC" | "DESC" }> {
    if (!options?.orderBy) return [];
    const propToCol = this.ctx.buildPropertyToColumnMap(relatedMetadata as any);
    return Object.entries(options.orderBy).map(([property, direction]) => ({
      column: qualify(propToCol.get(property) ?? property),
      direction,
    }));
  }

  /** Whether the relation pages each parent's rows. */
  private static pagesRows(options: RelationQueryOptions | undefined): boolean {
    return options?.take !== undefined || (options?.skip ?? 0) > 0;
  }

  /**
   * `ROW_NUMBER() OVER (PARTITION BY <parent key> ORDER BY ...)` — ranks the
   * related rows within each parent in the relation's order, the related
   * primary key breaking ties (and ordering alone when no `orderBy` is set),
   * so a page of each parent's rows is stable.
   */
  private rowNumberColumn(
    relationName: string,
    partitionBy: string,
    order: Array<{ column: string; direction: "ASC" | "DESC" }>,
    tiebreaker: string,
  ): string {
    const capabilities = this.ctx.getDriver()?.getCapabilities?.();
    if (capabilities && capabilities.supportsWindowFunctions === false) {
      throw new OrmError(
        OrmErrorCode.UNSUPPORTED_OPERATION,
        `"take" / "skip" on relation "${relationName}" need window functions, which this database version does not support.`,
        "Use MySQL 8.0+, MariaDB 10.2+ or SQLite 3.25+, or drop take/skip and slice each parent's rows in code.",
      );
    }
    const orderSql = [...order, { column: tiebreaker, direction: "ASC" as const }]
      .map((entry) => `${entry.column} ${entry.direction}`)
      .join(", ");
    return `ROW_NUMBER() OVER (PARTITION BY ${partitionBy} ORDER BY ${orderSql}) AS ${this.ctx.wrap(ROW_NUMBER_ALIAS)}`;
  }

  /**
   * Keeps the rows of each parent's page from a statement that selected
   * {@link rowNumberColumn}, ordered by parent then rank so grouping keeps
   * the relation's order.
   */
  private pageEachParent(inner: Sql, parentKeyAlias: string, options: RelationQueryOptions): Sql {
    const rn = raw(`${this.ctx.wrap(PAGED_ALIAS)}.${this.ctx.wrap(ROW_NUMBER_ALIAS)}`);
    const skip = options.skip ?? 0;
    const upper = options.take !== undefined ? sql` AND ${rn} <= ${skip + options.take}` : sql``;
    return sql`SELECT * FROM (${inner}) AS ${raw(this.ctx.wrap(PAGED_ALIAS))} WHERE ${rn} > ${skip}${upper} ORDER BY ${raw(`${this.ctx.wrap(PAGED_ALIAS)}.${this.ctx.wrap(parentKeyAlias)}`)}, ${rn}`;
  }

  /** A raw row with the loader's bookkeeping aliases removed, ready to hydrate. */
  private static withoutAliases(row: Record<string, unknown>, aliases: readonly string[]): Record<string, unknown> {
    const copy = { ...row };
    for (const alias of aliases) delete copy[alias];
    return copy;
  }

  /**
   * Reads a parent's PK value by property name (falling back to the DB
   * column name for metadata without a propertyKey).
   */
  private parentIdOf(parent: EntityRecord, pk: ColumnMetadata): unknown {
    return parent[pk.propertyKey ?? pk.name];
  }

  /**
   * The OneToMany relations of `entity` that `relations` names — exactly the
   * set {@link loadOneToManyRelations} loads.
   */
  private requestedOneToMany<T>(
    entity: ClazzType<T>,
    relations: readonly string[],
  ): OneToManyMetadata<any>[] {
    return this.resolver
      .resolveOneToManyMetadata(entity)
      .filter((rel) => relations.includes(rel.propertyKey));
  }

  /** The ManyToMany relations (either side) {@link loadManyToManyRelations} loads. */
  private requestedManyToMany<T>(
    entity: ClazzType<T>,
    relations: readonly string[],
  ): ManyToManyMetadata<any>[] {
    return this.resolver
      .resolveManyToManyMetadata(entity)
      .filter((rel) => relations.includes(rel.propertyKey));
  }

  /** The OneToOne relations {@link loadOneToOneRelations} visits, both sides. */
  private requestedOneToOne<T>(
    entity: ClazzType<T>,
    relations: readonly string[],
  ): OneToOneMetadata<any>[] {
    return this.resolver
      .resolveOneToOneMetadata(entity)
      .filter((rel) => relations.includes(rel.propertyKey));
  }

  /**
   * Whether {@link loadOneToOneRelations} matches a OneToOne to its parent by
   * the parent's primary key: the inverse side. The owning side is JOINed by
   * the main read instead.
   */
  private static matchesByParentKey(rel: OneToOneMetadata<unknown>): boolean {
    return !rel.joinColumn && !!rel.inverseSide;
  }

  /**
   * Names of the requested relations the loaders match to each parent by its
   * primary key: every OneToMany, every ManyToMany (either side) and the
   * inverse side of OneToOne.
   */
  relationsMatchedByParentKey<T>(
    entity: ClazzType<T>,
    relations: readonly string[],
  ): string[] {
    const names: string[] = [];
    for (const rel of this.requestedOneToMany(entity, relations)) {
      names.push(rel.propertyKey);
    }
    for (const rel of this.requestedManyToMany(entity, relations)) {
      names.push(rel.propertyKey);
    }
    for (const rel of this.requestedOneToOne(entity, relations)) {
      if (RelationLoader.matchesByParentKey(rel)) names.push(rel.propertyKey);
    }
    return names;
  }

  /**
   * The parent columns the loaders read from every hydrated parent: all
   * primary-key columns when `relations` names a relation matched by the
   * parent key, otherwise none.
   *
   * A read whose `select` leaves one of these out hydrates parents without
   * the key, so each loader would find no parent ids, skip its query and
   * assign `[]` / `null`. The read path adds the missing columns to its
   * SELECT list. This is built on the loaders' own relation selectors so the
   * two cannot disagree about which relations need the key.
   */
  parentKeyColumns<T>(
    entity: ClazzType<T>,
    relations: readonly string[],
  ): ColumnMetadata[] {
    if (this.relationsMatchedByParentKey(entity, relations).length === 0) {
      return [];
    }
    const parentMetadata = this.resolver.resolveEntityMetadata(entity);
    if (!parentMetadata) return [];
    return parentMetadata.columns.filter(
      (column: ColumnMetadata) => column.options?.primary,
    );
  }

  /** Collects the non-null PK value of every parent. */
  private collectParentIds(
    parents: EntityRecord[],
    pk: ColumnMetadata,
  ): unknown[] {
    const ids: unknown[] = [];
    for (const parent of parents) {
      const id = this.parentIdOf(parent, pk);
      if (id !== undefined && id !== null) ids.push(id);
    }
    return ids;
  }

  /**
   * Loads ManyToOne and owning-side OneToOne relations with one batched
   * query per relation and assigns the target (or null) to each parent.
   *
   * `find()` JOINs these relations into its main statement; a read that
   * cannot JOIN — a keyset cursor page, whose ORDER BY and cursor encoding
   * are bound to the root table's columns — loads them here instead. The
   * result is shaped the same way: the target hydrated as its class, a
   * soft-deleted target as null (unless `withDeleted`), a target outside the
   * caller's tenant as null, and no nested eager fan-out (the JOIN reads one
   * level deep as well).
   *
   * @param manyToOne  ManyToOne relations to load (resolved metadata)
   * @param oneToOne   Owning-side OneToOne relations to load (those with a joinColumn)
   * @param withDeleted When true, include a soft-deleted target.
   */
  async loadToOneRelations<T>(
    entity: ClazzType<T>,
    parentResults: T | T[],
    manyToOne: ManyToOneMetadata<any>[],
    oneToOne: OneToOneMetadata<any>[],
    existingSession?: TransactionSessionManager,
    withDeleted?: boolean,
    tree?: RelationTree,
  ): Promise<void> {
    if (manyToOne.length === 0 && oneToOne.length === 0) return;
    const parents = this.toParentRecords(parentResults);
    if (parents.length === 0) return;

    const targets: Array<{
      propertyKey: string;
      fkKeys: string[];
      RelatedEntity: ClazzType<any>;
    }> = [];
    for (const rel of manyToOne) {
      const joinColumn = rel.joinColumn ?? rel.columnName;
      // ResultTransformer remaps the FK column onto its shadow property
      // (e.g. author_id -> authorId); a plain @ManyToOne keeps it under
      // the DB column name. Read the shadow first, then the join column.
      const fkShadow = rel.option?.fkProperty ?? `${rel.columnName}Id`;
      targets.push({
        propertyKey: rel.columnName,
        fkKeys: [fkShadow, joinColumn],
        RelatedEntity: rel.getMappingEntity() as ClazzType<any>,
      });
    }
    for (const rel of oneToOne) {
      if (!rel.joinColumn) continue;
      const fkShadow = rel.option?.fkProperty ?? `${rel.propertyKey}Id`;
      targets.push({
        propertyKey: rel.propertyKey,
        fkKeys: [fkShadow, rel.joinColumn],
        RelatedEntity: rel.getRelatedEntity() as ClazzType<any>,
      });
    }

    for (const target of targets) {
      const { RelatedEntity, propertyKey, fkKeys } = target;
      const relationWithDeleted =
        RelationLoader.optionsOf(tree, propertyKey)?.withDeleted ?? withDeleted;
      const relatedMetadata = this.resolver.resolveEntityMetadata(RelatedEntity);
      if (!relatedMetadata) continue;
      const relatedPk = relatedMetadata.columns.find(
        (col: ColumnMetadata) => col.options?.primary,
      );
      if (!relatedPk) continue;

      const fkOf = (parent: EntityRecord): unknown => {
        for (const key of fkKeys) {
          const value = parent[key];
          if (value !== undefined && value !== null) return value;
        }
        return null;
      };

      // 1. Collect the distinct FK values this page references.
      const fkValues = Array.from(
        new Set(parents.map(fkOf).filter((v) => v !== null)),
      );
      if (fkValues.length === 0) {
        for (const parent of parents) parent[propertyKey] = null;
        continue;
      }

      // 2. One batched query: WHERE pk IN (...) plus the predicates the
      //    eager JOIN puts in its ON clause.
      const relatedTableName = relatedMetadata.name ?? RelatedEntity.name;
      const executeQuery = async (session: TransactionSessionManager) => {
        const qb = RawQueryBuilderFactory.create();
        const selectCols = this.readColumns(RelatedEntity, relatedMetadata).map(
          (name) => this.ctx.wrap(name),
        );
        const whereConditions: Sql[] = [
          Conditions.in(this.ctx.wrap(relatedPk.name), fkValues),
        ];
        const deletedAtColumn = this.resolver.getDeletedAtColumn(RelatedEntity);
        if (deletedAtColumn && !relationWithDeleted) {
          whereConditions.push(Conditions.isNull(this.ctx.wrap(deletedAtColumn)));
        }
        const tenantPredicate = this.ctx.buildTenantWhereClause(RelatedEntity);
        if (tenantPredicate) {
          whereConditions.push(tenantPredicate);
        }
        qb.select(selectCols)
          .from(this.ctx.wrapTable(relatedTableName))
          .where(whereConditions);

        const resultQuery = qb.build();
        const subQueryStart = Date.now();
        this.ctx.beginTrackQuery();
        const queryResult = (await session.query(resultQuery)) as QueryResult;
        this.ctx.trackQuery(
          relatedTableName,
          resultQuery.text ?? String(resultQuery),
          Date.now() - subQueryStart,
        );
        return queryResult;
      };

      const queryResult = await this.ctx.executeInTransaction(executeQuery, existingSession);

      // 3. Index the targets by PK, reading the PK from the raw row so the
      //    lookup key matches the FK value the parent row carries.
      const relatedByPk = new Map<unknown, unknown>();
      const rows = queryResult.results ?? [];
      if (rows.length > 0) {
        const related = ResultTransformerFactory.create().toEntities(RelatedEntity, queryResult);
        for (let i = 0; i < related.length; i++) {
          relatedByPk.set(rows[i][relatedPk.name], related[i]);
        }
      }

      // 4. Assign — a missing, soft-deleted or foreign-tenant target is null.
      for (const parent of parents) {
        const fk = fkOf(parent);
        parent[propertyKey] = fk === null ? null : (relatedByPk.get(fk) ?? null);
      }
    }
  }

  /**
   * Loads OneToMany relations with a batched query and assigns them to each parent entity.
   * Collects every parent ID, issues a single IN query to fetch all children,
   * and distributes them to each parent based on the FK value.
   *
   * @param entity Parent entity class
   * @param parentResults Parent query result (single entity or array)
   * @param relations Names of the relation fields to load
   * @param existingSession Existing session to reuse (to save connection-pool usage)
   * @param withDeleted When true, include soft-deleted children (skip the
   *        `deletedAt IS NULL` predicate) so relation loads match the top-level
   *        `withDeleted` query.
   */
  async loadOneToManyRelations<T>(
    entity: ClazzType<T>,
    parentResults: T | T[],
    relations: readonly string[],
    existingSession?: TransactionSessionManager,
    withDeleted?: boolean,
    tree?: RelationTree,
  ): Promise<void> {
    const oneToManyMeta = this.requestedOneToMany(entity, relations);
    if (oneToManyMeta.length === 0) return;

    const parentMetadata = this.resolver.resolveEntityMetadata(entity);
    if (!parentMetadata) return;

    const pk = parentMetadata.columns.find(
      (column: ColumnMetadata) => column.options?.primary,
    );
    if (!pk) return;

    const parents = this.toParentRecords(parentResults);

    for (const rel of oneToManyMeta) {
      const RelatedEntity = rel.getRelatedEntity();
      const relatedMetadata = this.resolver.resolveEntityMetadata(RelatedEntity);
      if (!relatedMetadata) continue;

      const manyToOneItems = this.resolver.resolveManyToOneMetadata(RelatedEntity);
      const matchingRelation = manyToOneItems.find(
        (m) => m.columnName === rel.mappedBy,
      );
      const fkColumn = matchingRelation?.joinColumn ?? rel.mappedBy;
      // The FK may be declared via @RelationColumn only (no backing @Column),
      // so it is not guaranteed to appear in relatedMetadata.columns. Select it
      // under a stable alias and read it from the RAW row when grouping — the
      // hydrated entity is keyed by property names, not DB column names.
      const fkAlias = "__stg_o2m_fk";
      const options = RelationLoader.optionsOf(tree, rel.propertyKey);
      const relationWithDeleted = options?.withDeleted ?? withDeleted;

      // 1. Collect every parent ID (skipping null/undefined)
      const parentIds = this.collectParentIds(parents, pk);

      if (parentIds.length === 0 || options?.take === 0) {
        for (const parent of parents) {
          parent[rel.propertyKey] = [];
        }
        continue;
      }

      // 2. Batched query: WHERE fkColumn IN (...parentIds)
      const relatedTableName = relatedMetadata.name ?? RelatedEntity.name;
      const source = this.relatedRowSource(RelatedEntity, relatedMetadata);

      const executeQuery = async (session: TransactionSessionManager) => {
        const qb = RawQueryBuilderFactory.create();
        const selectCols = [...source.columns];
        selectCols.push(
          `${this.ctx.wrap(fkColumn)} AS ${this.ctx.wrap(fkAlias)}`,
        );
        const order = this.relationOrder(relatedMetadata, options, (col) => this.ctx.wrap(col));
        const paged = RelationLoader.pagesRows(options);
        if (paged) {
          const relatedPk = relatedMetadata.columns.find((col: ColumnMetadata) => col.options?.primary);
          selectCols.push(
            this.rowNumberColumn(
              rel.propertyKey,
              this.ctx.wrap(fkColumn),
              order,
              this.ctx.wrap(relatedPk?.name ?? fkColumn),
            ),
          );
        }

        const whereConditions: Sql[] = [
          Conditions.in(this.ctx.wrap(fkColumn), parentIds),
          ...this.relationWhere(
            RelatedEntity,
            relatedMetadata,
            options,
            relationWithDeleted,
            source.alias !== undefined ? TPC_UNION_ALIAS : relatedTableName,
          ),
        ];

        const deletedAtColumn = this.resolver.getDeletedAtColumn(RelatedEntity);
        if (deletedAtColumn && !relationWithDeleted) {
          whereConditions.push(Conditions.isNull(this.ctx.wrap(deletedAtColumn)));
        }

        // Tenant scoping under the "tenant_column" strategy. The batched child
        // query is a bare SELECT with no JOINs, so the predicate is unqualified.
        const tenantPredicate = this.ctx.buildTenantWhereClause(RelatedEntity);
        if (tenantPredicate) {
          whereConditions.push(tenantPredicate);
        }

        qb.select(selectCols)
          .from(source.from, source.alias)
          .where(whereConditions);
        if (!paged && order.length > 0) qb.orderBy(order);

        const resultQuery = paged
          ? this.pageEachParent(qb.build(), fkAlias, options!)
          : qb.build();
        const subQueryStart = Date.now();
        this.ctx.beginTrackQuery();
        const queryResult = (await session.query(resultQuery)) as QueryResult;
        this.ctx.trackQuery(
          relatedTableName,
          resultQuery.text ?? String(resultQuery),
          Date.now() - subQueryStart,
        );
        return queryResult;
      };

      const queryResult = await this.ctx.executeInTransaction(executeQuery, existingSession);

      // 3. Group the results into a Map keyed by FK value
      const childrenByParentId = new Map<any, any[]>();

      if (queryResult.results && queryResult.results.length > 0) {
        const rows = queryResult.results;
        // Strip the FK alias before hydration, then bulk-deserialize. The query
        // has no JOINs, so toEntities() is 1:1 and order-preserving with rows —
        // letting us read each child's FK from the raw row by index.
        const entityRows = rows.map((row) =>
          RelationLoader.withoutAliases(row, [fkAlias, ROW_NUMBER_ALIAS]),
        );
        const allChildren = source.toEntities(entityRows);

        for (let i = 0; i < allChildren.length; i++) {
          const fkValue = rows[i][fkAlias];
          if (fkValue === undefined || fkValue === null) continue;
          let group = childrenByParentId.get(fkValue);
          if (!group) {
            group = [];
            childrenByParentId.set(fkValue, group);
          }
          group.push(allChildren[i]);
        }
      }

      // 4. Assign the matching child array to each parent
      for (const parent of parents) {
        const parentId = this.parentIdOf(parent, pk);
        parent[rel.propertyKey] = childrenByParentId.get(parentId) ?? [];
      }
    }
  }

  /**
   * Loads ManyToMany relations with a batched query and assigns them to each parent entity.
   *
   * Fetches the target entities by JOIN-ing the join table:
   * SELECT target.*, join_table.joinColumn AS __m2m_fk
   * FROM target
   * INNER JOIN join_table ON target.pk = join_table.inverseJoinColumn
   * WHERE join_table.joinColumn IN (:parentId1, :parentId2, ...)
   *
   * @param existingSession Existing session to reuse (to save connection-pool usage)
   * @param withDeleted When true, include soft-deleted targets (skip the
   *        `deletedAt IS NULL` predicate).
   */
  async loadManyToManyRelations<T>(
    entity: ClazzType<T>,
    parentResults: T | T[],
    relations: readonly string[],
    existingSession?: TransactionSessionManager,
    withDeleted?: boolean,
    tree?: RelationTree,
  ): Promise<void> {
    const manyToManyMeta = this.requestedManyToMany(entity, relations);
    if (manyToManyMeta.length === 0) return;

    const parentMetadata = this.resolver.resolveEntityMetadata(entity);
    if (!parentMetadata) return;

    const pk = parentMetadata.columns.find(
      (column: ColumnMetadata) => column.options?.primary,
    );
    if (!pk) return;

    const parents = this.toParentRecords(parentResults);

    for (const rel of manyToManyMeta) {
      const joinInfo = this.resolver.resolveManyToManyJoinTable(rel);
      if (!joinInfo) continue;

      const RelatedEntity = rel.getRelatedEntity();
      const relatedMetadata = this.resolver.resolveEntityMetadata(RelatedEntity);
      if (!relatedMetadata) continue;

      const relatedPk = relatedMetadata.columns.find(
        (col: any) => col.options?.primary,
      );
      if (!relatedPk) continue;

      const relatedTableName = relatedMetadata.name ?? RelatedEntity.name;
      const options = RelationLoader.optionsOf(tree, rel.propertyKey);
      const relationWithDeleted = options?.withDeleted ?? withDeleted;

      // 1. Collect every parent ID (skipping null/undefined)
      const parentIds = this.collectParentIds(parents, pk);

      if (parentIds.length === 0 || options?.take === 0) {
        for (const parent of parents) {
          parent[rel.propertyKey] = [];
        }
        continue;
      }

      // 2. Batched query: SELECT the joinColumn as well to map parents to children
      const fkAlias = "__m2m_fk";

      const executeQuery = async (session: TransactionSessionManager) => {
        const qb = RawQueryBuilderFactory.create();
        const selectCols = this.readColumns(RelatedEntity, relatedMetadata).map(
          (name) => `${this.ctx.wrap(relatedTableName)}.${this.ctx.wrap(name)}`,
        );
        const parentKey = `${this.ctx.wrap(joinInfo.joinTableName)}.${this.ctx.wrap(joinInfo.joinColumn)}`;
        selectCols.push(`${parentKey} AS ${this.ctx.wrap(fkAlias)}`);
        const qualify = (col: string) =>
          `${this.ctx.wrap(relatedTableName)}.${this.ctx.wrap(col)}`;
        const order = this.relationOrder(relatedMetadata, options, qualify);
        const paged = RelationLoader.pagesRows(options);
        if (paged) {
          selectCols.push(
            this.rowNumberColumn(rel.propertyKey, parentKey, order, qualify(relatedPk.name)),
          );
        }

        const joinCondition = sql`${raw(this.ctx.wrap(relatedTableName))}.${raw(this.ctx.wrap(relatedPk.name))} = ${raw(this.ctx.wrap(joinInfo.joinTableName))}.${raw(this.ctx.wrap(joinInfo.inverseJoinColumn))}`;

        const whereConditions: Sql[] = [
          Conditions.in(parentKey, parentIds),
          ...this.relationWhere(
            RelatedEntity,
            relatedMetadata,
            options,
            relationWithDeleted,
            relatedTableName,
            relatedTableName,
          ),
        ];

        // Soft-delete scoping for the target entity. Qualify by the related
        // table name because the query JOINs a second table (the join table) —
        // an unqualified predicate would be ambiguous.
        const deletedAtColumn = this.resolver.getDeletedAtColumn(RelatedEntity);
        if (deletedAtColumn && !relationWithDeleted) {
          whereConditions.push(
            Conditions.isNull(
              `${this.ctx.wrap(relatedTableName)}.${this.ctx.wrap(deletedAtColumn)}`,
            ),
          );
        }

        // Tenant scoping for the related entity. Qualify by the related table
        // name because the query JOINs a second table (the join table) — an
        // unqualified predicate would be ambiguous.
        const tenantPredicate = this.ctx.buildTenantWhereClause(
          RelatedEntity,
          relatedTableName,
        );
        if (tenantPredicate) {
          whereConditions.push(tenantPredicate);
        }

        qb.select(selectCols)
          .from(this.ctx.wrapTable(relatedTableName))
          .innerJoin(
            this.ctx.wrapTable(joinInfo.joinTableName),
            this.ctx.wrap(joinInfo.joinTableName),
            joinCondition,
          )
          .where(whereConditions);
        if (!paged && order.length > 0) qb.orderBy(order);

        const resultQuery = paged
          ? this.pageEachParent(qb.build(), fkAlias, options!)
          : qb.build();
        const subQueryStart = Date.now();
        this.ctx.beginTrackQuery();
        const queryResult = (await session.query(resultQuery)) as QueryResult;
        this.ctx.trackQuery(
          relatedTableName,
          resultQuery.text ?? String(resultQuery),
          Date.now() - subQueryStart,
        );
        return queryResult;
      };

      const queryResult = await this.ctx.executeInTransaction(executeQuery, existingSession);

      // 3. Group the results into a Map keyed by FK value
      const childrenByParentId = new Map<any, any[]>();
      const resultTransformer = ResultTransformerFactory.create();

      if (queryResult.results && queryResult.results.length > 0) {
        for (const row of queryResult.results) {
          const fkValue = row[fkAlias];
          const entityRow = RelationLoader.withoutAliases(row, [fkAlias, ROW_NUMBER_ALIAS]);

          const entities = resultTransformer.toEntities(RelatedEntity, {
            results: [entityRow],
          } as QueryResult);

          let group = childrenByParentId.get(fkValue);
          if (!group) {
            group = [];
            childrenByParentId.set(fkValue, group);
          }
          group.push(...entities);
        }
      }

      // 4. Assign the matching child array to each parent
      for (const parent of parents) {
        const parentId = this.parentIdOf(parent, pk);
        parent[rel.propertyKey] = childrenByParentId.get(parentId) ?? [];
      }
    }
  }

  /**
   * Loads OneToOne relations with a batched query and assigns them to each parent entity.
   * Loads OneToOne relations that were not handled by the eager JOIN (e.g. inverseSide) via the relations option.
   *
   * For the inverse side, uses a batched IN query to avoid N+1 problems.
   *
   * @param existingSession Existing session to reuse (to save connection-pool usage)
   * @param withDeleted When true, include a soft-deleted counterpart (skip the
   *        `deletedAt IS NULL` predicate).
   */
  async loadOneToOneRelations<T>(
    entity: ClazzType<T>,
    parentResults: T | T[],
    relations: readonly string[],
    existingSession?: TransactionSessionManager,
    withDeleted?: boolean,
    tree?: RelationTree,
  ): Promise<void> {
    const oneToOneMeta = this.requestedOneToOne(entity, relations);
    if (oneToOneMeta.length === 0) return;

    const parentMetadata = this.resolver.resolveEntityMetadata(entity);
    if (!parentMetadata) return;

    const pk = parentMetadata.columns.find(
      (column: ColumnMetadata) => column.options?.primary,
    );
    if (!pk) return;

    const parents = this.toParentRecords(parentResults);

    for (const rel of oneToOneMeta) {
      // The owning side is already mapped by the eager JOIN + transformNested → skip
      if (rel.joinColumn) {
        continue;
      }

      const RelatedEntity = rel.getRelatedEntity();
      const relatedMetadata = this.resolver.resolveEntityMetadata(RelatedEntity);
      if (!relatedMetadata) continue;

      const relatedPk = relatedMetadata.columns.find(
        (col: any) => col.options?.primary,
      );
      if (!relatedPk) continue;

      if (RelationLoader.matchesByParentKey(rel)) {
        // Inverse side: search for the parent PK via the other side's joinColumn (batched)
        const relatedOneToOne = this.resolver.resolveOneToOneMetadata(RelatedEntity);
        const ownerRel = relatedOneToOne.find(
          (r) => r.propertyKey === rel.inverseSide && r.joinColumn,
        );

        if (!ownerRel?.joinColumn) {
          for (const parent of parents) {
            parent[rel.propertyKey] = null;
          }
          continue;
        }

        const fkColumn = ownerRel.joinColumn;
        // The owning side's FK may be declared via @RelationColumn only, so it
        // is not guaranteed to be in relatedMetadata.columns. Select it under a
        // stable alias and read it from the RAW row (the hydrated entity is
        // keyed by property names, not DB column names).
        const fkAlias = "__stg_o2o_fk";

        // 1. Collect every parent ID (skipping null/undefined)
        const parentIds = this.collectParentIds(parents, pk);

        if (parentIds.length === 0) {
          for (const parent of parents) {
            parent[rel.propertyKey] = null;
          }
          continue;
        }

        // 2. Batched query: WHERE fkColumn IN (...parentIds)
        const relatedTableName = relatedMetadata.name ?? RelatedEntity.name;
        const source = this.relatedRowSource(RelatedEntity, relatedMetadata);

        const executeQuery = async (session: TransactionSessionManager) => {
          const qb = RawQueryBuilderFactory.create();
          const selectCols = [...source.columns];
          selectCols.push(
            `${this.ctx.wrap(fkColumn)} AS ${this.ctx.wrap(fkAlias)}`,
          );

          const whereConditions: Sql[] = [
            Conditions.in(this.ctx.wrap(fkColumn), parentIds),
          ];

          const deletedAtColumn = this.resolver.getDeletedAtColumn(RelatedEntity);
          const relationWithDeleted =
            RelationLoader.optionsOf(tree, rel.propertyKey)?.withDeleted ?? withDeleted;
          if (deletedAtColumn && !relationWithDeleted) {
            whereConditions.push(Conditions.isNull(this.ctx.wrap(deletedAtColumn)));
          }

          // Tenant scoping under the "tenant_column" strategy.
          const tenantPredicate = this.ctx.buildTenantWhereClause(RelatedEntity);
          if (tenantPredicate) {
            whereConditions.push(tenantPredicate);
          }

          qb.select(selectCols)
            .from(source.from, source.alias)
            .where(whereConditions);

          const resultQuery = qb.build();
          const subQueryStart = Date.now();
          this.ctx.beginTrackQuery();
          const queryResult = (await session.query(resultQuery)) as QueryResult;
          this.ctx.trackQuery(
            relatedTableName,
            resultQuery.text ?? String(resultQuery),
            Date.now() - subQueryStart,
          );
          return queryResult;
        };

        const queryResult = await this.ctx.executeInTransaction(executeQuery, existingSession);

        // 3. Group the results into a Map keyed by FK value (1:1 mapping for OneToOne)
        const relatedByParentId = new Map<any, any>();

        if (queryResult.results && queryResult.results.length > 0) {
          for (const row of queryResult.results) {
            const fkValue = row[fkAlias];
            if (fkValue === undefined || fkValue === null) continue;

            const entityRow = { ...row };
            delete entityRow[fkAlias];
            const [related] = source.toEntities([entityRow]);

            if (related !== undefined) {
              relatedByParentId.set(fkValue, related);
            }
          }
        }

        // 4. Assign the matching related entity to each parent
        for (const parent of parents) {
          const parentId = this.parentIdOf(parent, pk);
          parent[rel.propertyKey] = relatedByParentId.get(parentId) ?? null;
        }
      } else {
        for (const parent of parents) {
          parent[rel.propertyKey] = null;
        }
      }
    }
  }

  /**
   * Loads the relations nested under the ones a read already attached.
   *
   * The read itself attaches the top level of `tree` — JOINed or batched,
   * as it always has. For every node that asks for more, the related
   * entities it attached are collected across all parents and their own
   * relations loaded the batched way: one query per relation per level,
   * whatever the number of parents, then the next level down.
   *
   * Nested levels follow the read's `withDeleted` like the top level does,
   * and each related entity is scoped by its own tenant predicate. They load
   * only the relations asked for — `eager: true` applies to the entity a read
   * queries, not to every entity it reaches.
   */
  async loadNestedRelations<T>(
    entity: ClazzType<T>,
    parentResults: T | T[],
    tree: RelationTree | undefined,
    existingSession?: TransactionSessionManager,
    withDeleted?: boolean,
  ): Promise<void> {
    if (!tree) return;
    const parents = this.toParentRecords(parentResults);
    if (parents.length === 0) return;

    for (const node of tree.nodes.values()) {
      const children = node.children;
      if (!children || children.names.length === 0) continue;
      const target = relationTargetOf(entity, node.name, this.resolver);
      if (!target) continue;
      const related = RelationLoader.collectRelated(parents, node.name);
      if (related.length === 0) continue;
      await this.loadRelationLevel(target, related, children, existingSession, withDeleted);
    }
  }

  /**
   * Loads one level of `tree` onto `instances` of `entity`, then the levels
   * below it.
   */
  private async loadRelationLevel(
    entity: ClazzType<any>,
    instances: EntityRecord[],
    tree: RelationTree,
    existingSession: TransactionSessionManager | undefined,
    withDeleted: boolean | undefined,
  ): Promise<void> {
    const names = tree.names;
    const manyToOne = this.resolver
      .resolveManyToOneMetadata(entity)
      .filter((rel) => names.includes(rel.columnName));
    const owningOneToOne = this.resolver
      .resolveOneToOneMetadata(entity)
      .filter((rel) => !!rel.joinColumn && names.includes(rel.propertyKey));

    await this.loadToOneRelations(entity, instances, manyToOne, owningOneToOne, existingSession, withDeleted, tree);
    await this.loadOneToManyRelations(entity, instances, names, existingSession, withDeleted, tree);
    await this.loadManyToManyRelations(entity, instances, names, existingSession, withDeleted, tree);
    await this.loadOneToOneRelations(entity, instances, names, existingSession, withDeleted, tree);
    await this.loadNestedRelations(entity, instances, tree, existingSession, withDeleted);
  }

  /**
   * Every distinct entity the parents hold under `property` — the elements
   * of a collection relation, the value of a single-valued one.
   */
  private static collectRelated(parents: EntityRecord[], property: string): EntityRecord[] {
    const seen = new Set<object>();
    const related: EntityRecord[] = [];
    const add = (value: unknown) => {
      if (value === null || typeof value !== "object" || seen.has(value)) return;
      seen.add(value);
      related.push(value as EntityRecord);
    };
    for (const parent of parents) {
      const value = parent[property];
      if (Array.isArray(value)) value.forEach(add);
      else add(value);
    }
    return related;
  }
}
