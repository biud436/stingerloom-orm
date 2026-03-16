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
 * 관계 서브쿼리 로딩 (OneToMany, ManyToMany, OneToOne) 핸들러.
 * EntityManager에서 위임받아 처리합니다.
 *
 * 모든 관계 로딩은 배치 쿼리(IN 절)를 사용하여 N+1 문제를 방지합니다.
 */
export class RelationLoader {
  constructor(
    private readonly resolver: RelationMetadataResolver,
    private readonly ctx: EntityManagerInternals,
  ) {}

  /**
   * OneToMany 관계를 배치 쿼리로 로드하여 부모 엔티티에 할당합니다.
   * 모든 부모 ID를 수집하여 단일 IN 쿼리로 자식 엔티티를 가져온 뒤,
   * FK 값을 기준으로 각 부모에게 분배합니다.
   *
   * @param entity 부모 엔티티 클래스
   * @param parentResults 부모 쿼리 결과 (단일 또는 배열)
   * @param relations 로드할 관계 필드명 배열
   * @param existingSession 재사용할 기존 세션 (커넥션 풀 절약)
   */
  async loadOneToManyRelations<T>(
    entity: ClazzType<T>,
    parentResults: T | T[],
    relations: string[],
    existingSession?: TransactionSessionManager,
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

      // 1. 모든 부모 ID를 수집 (null/undefined 제외)
      const parentIds: any[] = [];
      for (const parent of parents) {
        const parentId = (parent as any)[pk.name!];
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

      // 2. 배치 쿼리: WHERE fkColumn IN (...parentIds)
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
        if (deletedAtColumn) {
          whereConditions.push(Conditions.isNull(this.ctx.wrap(deletedAtColumn)));
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

      // 3. 결과를 FK 값 기준으로 Map에 분류
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

      // 4. 각 부모에게 해당하는 자식 배열을 할당
      for (const parent of parents) {
        const parentId = (parent as any)[pk.name!];
        (parent as any)[rel.propertyKey] = childrenByParentId.get(parentId) ?? [];
      }
    }
  }

  /**
   * ManyToMany 관계를 배치 쿼리로 로드하여 부모 엔티티에 할당합니다.
   *
   * 중간 테이블을 JOIN하여 대상 엔티티를 가져옵니다:
   * SELECT target.*, join_table.joinColumn AS __m2m_fk
   * FROM target
   * INNER JOIN join_table ON target.pk = join_table.inverseJoinColumn
   * WHERE join_table.joinColumn IN (:parentId1, :parentId2, ...)
   *
   * @param existingSession 재사용할 기존 세션 (커넥션 풀 절약)
   */
  async loadManyToManyRelations<T>(
    entity: ClazzType<T>,
    parentResults: T | T[],
    relations: string[],
    existingSession?: TransactionSessionManager,
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

      // 1. 모든 부모 ID를 수집 (null/undefined 제외)
      const parentIds: any[] = [];
      for (const parent of parents) {
        const parentId = (parent as any)[pk.name!];
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

      // 2. 배치 쿼리: joinColumn을 함께 SELECT하여 부모-자식 매핑
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

        const whereCondition = Conditions.in(
          `${this.ctx.wrap(joinInfo.joinTableName)}.${this.ctx.wrap(joinInfo.joinColumn)}`,
          parentIds,
        );

        qb.select(selectCols)
          .from(this.ctx.wrapTable(relatedTableName))
          .innerJoin(
            this.ctx.wrapTable(joinInfo.joinTableName),
            this.ctx.wrap(joinInfo.joinTableName),
            joinCondition,
          )
          .where([whereCondition]);

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

      // 3. 결과를 FK 값 기준으로 Map에 분류
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

      // 4. 각 부모에게 해당하는 자식 배열을 할당
      for (const parent of parents) {
        const parentId = (parent as any)[pk.name!];
        (parent as any)[rel.propertyKey] = childrenByParentId.get(parentId) ?? [];
      }
    }
  }

  /**
   * OneToOne 관계를 배치 쿼리로 로드하여 부모 엔티티에 할당합니다.
   * Eager JOIN으로 처리되지 않은 OneToOne 관계(inverseSide 등)를 relations 옵션으로 로드합니다.
   *
   * inverseSide의 경우 배치 IN 쿼리를 사용하여 N+1을 방지합니다.
   *
   * @param existingSession 재사용할 기존 세션 (커넥션 풀 절약)
   */
  async loadOneToOneRelations<T>(
    entity: ClazzType<T>,
    parentResults: T | T[],
    relations: string[],
    existingSession?: TransactionSessionManager,
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

      // 소유측은 eager JOIN + transformNested에서 이미 매핑됨 → 스킵
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
        // 역방향: 상대측의 joinColumn으로 부모 PK를 검색 (배치)
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

        // 1. 모든 부모 ID를 수집 (null/undefined 제외)
        const parentIds: any[] = [];
        for (const parent of parents) {
          const parentId = (parent as any)[pk.name!];
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

        // 2. 배치 쿼리: WHERE fkColumn IN (...parentIds)
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
          if (deletedAtColumn) {
            whereConditions.push(Conditions.isNull(this.ctx.wrap(deletedAtColumn)));
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

        // 3. 결과를 FK 값 기준으로 Map에 분류 (OneToOne이므로 1:1 매핑)
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

        // 4. 각 부모에게 해당하는 관련 엔티티를 할당
        for (const parent of parents) {
          const parentId = (parent as any)[pk.name!];
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
