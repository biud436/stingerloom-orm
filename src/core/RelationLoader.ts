/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../utils";
import { ColumnMetadata } from "../scanner";
import { TransactionSessionManager } from "../dialects/TransactionSessionManager";
import sql, { Sql, raw } from "sql-template-tag";
import { RawQueryBuilderFactory } from "./RawQueryBuilderFactory";
import { ResultTransformerFactory } from "./ResultTransformerFactory";
import { QueryResult } from "../types/QueryResult";
import { RelationMetadataResolver } from "./RelationMetadataResolver";
import { EntityManagerInternals } from "./EntityManagerInternals";
import { Conditions } from "./Conditions";

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
    relations: string[],
    existingSession?: TransactionSessionManager,
    withDeleted?: boolean,
  ): Promise<void> {
    const oneToManyMeta = this.resolver.resolveOneToManyMetadata(entity);
    if (oneToManyMeta.length === 0) return;

    const parentMetadata = this.resolver.resolveEntityMetadata(entity);
    if (!parentMetadata) return;

    const pk = parentMetadata.columns.find(
      (column: ColumnMetadata) => column.options?.primary,
    );
    if (!pk) return;

    const parents = Array.isArray(parentResults)
      ? parentResults
      : [parentResults];

    for (const rel of oneToManyMeta) {
      if (!relations.includes(rel.propertyKey)) continue;

      const RelatedEntity = rel.getRelatedEntity();
      const relatedMetadata = this.resolver.resolveEntityMetadata(RelatedEntity);
      if (!relatedMetadata) continue;

      const manyToOneItems = this.resolver.resolveManyToOneMetadata(RelatedEntity);
      const matchingRelation = manyToOneItems.find(
        (m) => m.columnName === rel.mappedBy,
      );
      const fkColumn = matchingRelation?.joinColumn ?? rel.mappedBy;

      // 1. Collect every parent ID (skipping null/undefined)
      const parentIds: any[] = [];
      for (const parent of parents) {
        const parentId = (parent as any)[pk.propertyKey ?? pk.name!];
        if (parentId !== undefined && parentId !== null) {
          parentIds.push(parentId);
        }
      }

      if (parentIds.length === 0) {
        for (const parent of parents) {
          (parent as any)[rel.propertyKey] = [];
        }
        continue;
      }

      // 2. Batched query: WHERE fkColumn IN (...parentIds)
      const relatedTableName = relatedMetadata.name ?? RelatedEntity.name;

      const executeQuery = async (session: TransactionSessionManager) => {
        const qb = RawQueryBuilderFactory.create();
        const selectCols = relatedMetadata.columns.map((col: any) =>
          this.ctx.wrap(col.name!),
        );

        const whereConditions: Sql[] = [
          Conditions.in(this.ctx.wrap(fkColumn), parentIds),
        ];

        const deletedAtColumn = this.resolver.getDeletedAtColumn(RelatedEntity);
        if (deletedAtColumn && !withDeleted) {
          whereConditions.push(Conditions.isNull(this.ctx.wrap(deletedAtColumn)));
        }

        // Tenant scoping under the "tenant_column" strategy. The batched child
        // query is a bare SELECT with no JOINs, so the predicate is unqualified.
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

      // 3. Group the results into a Map keyed by FK value
      const childrenByParentId = new Map<any, any[]>();
      const resultTransformer = ResultTransformerFactory.create();

      if (queryResult.results && queryResult.results.length > 0) {
        const allChildren = resultTransformer.toEntities(RelatedEntity, queryResult);
        for (const child of allChildren) {
          const fkValue = (child as any)[fkColumn];
          if (fkValue === undefined || fkValue === null) continue;
          let group = childrenByParentId.get(fkValue);
          if (!group) {
            group = [];
            childrenByParentId.set(fkValue, group);
          }
          group.push(child);
        }
      }

      // 4. Assign the matching child array to each parent
      for (const parent of parents) {
        const parentId = (parent as any)[pk.propertyKey ?? pk.name!];
        (parent as any)[rel.propertyKey] = childrenByParentId.get(parentId) ?? [];
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
    relations: string[],
    existingSession?: TransactionSessionManager,
    withDeleted?: boolean,
  ): Promise<void> {
    const manyToManyMeta = this.resolver.resolveManyToManyMetadata(entity);
    if (manyToManyMeta.length === 0) return;

    const parentMetadata = this.resolver.resolveEntityMetadata(entity);
    if (!parentMetadata) return;

    const pk = parentMetadata.columns.find(
      (column: ColumnMetadata) => column.options?.primary,
    );
    if (!pk) return;

    const parents = Array.isArray(parentResults)
      ? parentResults
      : [parentResults];

    for (const rel of manyToManyMeta) {
      if (!relations.includes(rel.propertyKey)) continue;

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

      // 1. Collect every parent ID (skipping null/undefined)
      const parentIds: any[] = [];
      for (const parent of parents) {
        const parentId = (parent as any)[pk.propertyKey ?? pk.name!];
        if (parentId !== undefined && parentId !== null) {
          parentIds.push(parentId);
        }
      }

      if (parentIds.length === 0) {
        for (const parent of parents) {
          (parent as any)[rel.propertyKey] = [];
        }
        continue;
      }

      // 2. Batched query: SELECT the joinColumn as well to map parents to children
      const fkAlias = "__m2m_fk";

      const executeQuery = async (session: TransactionSessionManager) => {
        const qb = RawQueryBuilderFactory.create();
        const selectCols = relatedMetadata.columns.map(
          (col: any) =>
            `${this.ctx.wrap(relatedTableName)}.${this.ctx.wrap(col.name!)}`,
        );
        selectCols.push(
          `${this.ctx.wrap(joinInfo.joinTableName)}.${this.ctx.wrap(joinInfo.joinColumn)} AS ${this.ctx.wrap(fkAlias)}`,
        );

        const joinCondition = sql`${raw(this.ctx.wrap(relatedTableName))}.${raw(this.ctx.wrap(relatedPk.name!))} = ${raw(this.ctx.wrap(joinInfo.joinTableName))}.${raw(this.ctx.wrap(joinInfo.inverseJoinColumn))}`;

        const whereConditions: Sql[] = [
          Conditions.in(
            `${this.ctx.wrap(joinInfo.joinTableName)}.${this.ctx.wrap(joinInfo.joinColumn)}`,
            parentIds,
          ),
        ];

        // Soft-delete scoping for the target entity. Qualify by the related
        // table name because the query JOINs a second table (the join table) —
        // an unqualified predicate would be ambiguous.
        const deletedAtColumn = this.resolver.getDeletedAtColumn(RelatedEntity);
        if (deletedAtColumn && !withDeleted) {
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

      // 3. Group the results into a Map keyed by FK value
      const childrenByParentId = new Map<any, any[]>();
      const resultTransformer = ResultTransformerFactory.create();

      if (queryResult.results && queryResult.results.length > 0) {
        for (const row of queryResult.results) {
          const fkValue = row[fkAlias];
          const entityRow = { ...row };
          delete entityRow[fkAlias];

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
        const parentId = (parent as any)[pk.propertyKey ?? pk.name!];
        (parent as any)[rel.propertyKey] = childrenByParentId.get(parentId) ?? [];
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
    relations: string[],
    existingSession?: TransactionSessionManager,
    withDeleted?: boolean,
  ): Promise<void> {
    const oneToOneMeta = this.resolver.resolveOneToOneMetadata(entity);
    if (oneToOneMeta.length === 0) return;

    const parentMetadata = this.resolver.resolveEntityMetadata(entity);
    if (!parentMetadata) return;

    const pk = parentMetadata.columns.find(
      (column: ColumnMetadata) => column.options?.primary,
    );
    if (!pk) return;

    const parents = Array.isArray(parentResults)
      ? parentResults
      : [parentResults];

    for (const rel of oneToOneMeta) {
      if (!relations.includes(rel.propertyKey)) continue;

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

      if (rel.inverseSide) {
        // Inverse side: search for the parent PK via the other side's joinColumn (batched)
        const relatedOneToOne = this.resolver.resolveOneToOneMetadata(RelatedEntity);
        const ownerRel = relatedOneToOne.find(
          (r) => r.propertyKey === rel.inverseSide && r.joinColumn,
        );

        if (!ownerRel?.joinColumn) {
          for (const parent of parents) {
            (parent as any)[rel.propertyKey] = null;
          }
          continue;
        }

        const fkColumn = ownerRel.joinColumn;

        // 1. Collect every parent ID (skipping null/undefined)
        const parentIds: any[] = [];
        for (const parent of parents) {
          const parentId = (parent as any)[pk.propertyKey ?? pk.name!];
          if (parentId !== undefined && parentId !== null) {
            parentIds.push(parentId);
          }
        }

        if (parentIds.length === 0) {
          for (const parent of parents) {
            (parent as any)[rel.propertyKey] = null;
          }
          continue;
        }

        // 2. Batched query: WHERE fkColumn IN (...parentIds)
        const relatedTableName = relatedMetadata.name ?? RelatedEntity.name;

        const executeQuery = async (session: TransactionSessionManager) => {
          const qb = RawQueryBuilderFactory.create();
          const selectCols = relatedMetadata.columns.map((col: any) =>
            this.ctx.wrap(col.name!),
          );

          const whereConditions: Sql[] = [
            Conditions.in(this.ctx.wrap(fkColumn), parentIds),
          ];

          const deletedAtColumn = this.resolver.getDeletedAtColumn(RelatedEntity);
          if (deletedAtColumn && !withDeleted) {
            whereConditions.push(Conditions.isNull(this.ctx.wrap(deletedAtColumn)));
          }

          // Tenant scoping under the "tenant_column" strategy.
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

        // 3. Group the results into a Map keyed by FK value (1:1 mapping for OneToOne)
        const relatedByParentId = new Map<any, any>();
        const resultTransformer = ResultTransformerFactory.create();

        if (queryResult.results && queryResult.results.length > 0) {
          const allRelated = resultTransformer.toEntities(RelatedEntity, queryResult);
          for (const related of allRelated) {
            const fkValue = (related as any)[fkColumn];
            if (fkValue !== undefined && fkValue !== null) {
              relatedByParentId.set(fkValue, related);
            }
          }
        }

        // 4. Assign the matching related entity to each parent
        for (const parent of parents) {
          const parentId = (parent as any)[pk.propertyKey ?? pk.name!];
          (parent as any)[rel.propertyKey] = relatedByParentId.get(parentId) ?? null;
        }
      } else {
        for (const parent of parents) {
          (parent as any)[rel.propertyKey] = null;
        }
      }
    }
  }
}
