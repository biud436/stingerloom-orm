/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../utils";
import { ColumnMetadata } from "../scanner";
import { TransactionSessionManager } from "../dialects/TransactionSessionManager";
import sql, { raw } from "sql-template-tag";
import { RawQueryBuilderFactory } from "./RawQueryBuilderFactory";
import { ResultTransformerFactory } from "./ResultTransformerFactory";
import { QueryResult } from "../types/QueryResult";
import { RelationMetadataResolver } from "./RelationMetadataResolver";
import { EntityManagerInternals } from "./EntityManagerInternals";

/**
 * 관계 서브쿼리 로딩 (OneToMany, ManyToMany, OneToOne) 핸들러.
 * EntityManager에서 위임받아 처리합니다.
 */
export class RelationLoader {
  constructor(
    private readonly resolver: RelationMetadataResolver,
    private readonly ctx: EntityManagerInternals,
  ) {}

  /**
   * OneToMany 관계를 별도 쿼리로 로드하여 부모 엔티티에 할당합니다.
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
      // relations 배열에 해당 propertyKey가 포함된 경우에만 로드
      if (!relations.includes(rel.propertyKey)) continue;

      const RelatedEntity = rel.getRelatedEntity();
      const relatedMetadata = this.resolver.resolveEntityMetadata(RelatedEntity);
      if (!relatedMetadata) continue;

      // mappedBy가 가리키는 ManyToOne 측의 joinColumn 찾기
      const manyToOneItems = this.resolver.resolveManyToOneMetadata(RelatedEntity);
      const matchingRelation = manyToOneItems.find(
        (m) => m.columnName === rel.mappedBy,
      );

      // joinColumn이 있으면 그것을 FK 컬럼으로, 없으면 mappedBy 자체를 FK 컬럼으로 사용
      const fkColumn = matchingRelation?.joinColumn ?? rel.mappedBy;

      for (const parent of parents) {
        const parentId = (parent as any)[pk.name!];
        if (parentId === undefined || parentId === null) continue;

        const children = await this.ctx.findInternal(RelatedEntity, {
          where: { [fkColumn]: parentId } as any,
        }, existingSession);

        // 결과를 배열로 정규화하여 할당
        if (children === undefined) {
          (parent as any)[rel.propertyKey] = [];
        } else if (Array.isArray(children)) {
          (parent as any)[rel.propertyKey] = children;
        } else {
          (parent as any)[rel.propertyKey] = [children];
        }
      }
    }
  }

  /**
   * ManyToMany 관계를 별도 쿼리로 로드하여 부모 엔티티에 할당합니다.
   *
   * 중간 테이블을 JOIN하여 대상 엔티티를 가져옵니다:
   * SELECT target.* FROM target
   * INNER JOIN join_table ON target.pk = join_table.inverseJoinColumn
   * WHERE join_table.joinColumn = :parentId
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

      for (const parent of parents) {
        const parentId = (parent as any)[pk.name!];
        if (parentId === undefined || parentId === null) continue;

        // 중간 테이블 JOIN 쿼리를 직접 구성
        const qb = RawQueryBuilderFactory.create();

        const selectCols = relatedMetadata.columns.map(
          (col: any) =>
            `${this.ctx.wrap(relatedTableName)}.${this.ctx.wrap(col.name!)}`,
        );

        const joinCondition = sql`${raw(this.ctx.wrap(relatedTableName))}.${raw(this.ctx.wrap(relatedPk.name!))} = ${raw(this.ctx.wrap(joinInfo.joinTableName))}.${raw(this.ctx.wrap(joinInfo.inverseJoinColumn))}`;

        const whereCondition = sql`${raw(this.ctx.wrap(joinInfo.joinTableName))}.${raw(this.ctx.wrap(joinInfo.joinColumn))} = ${parentId}`;

        qb.select(selectCols)
          .from(this.ctx.wrap(relatedTableName))
          .innerJoin(
            this.ctx.wrap(joinInfo.joinTableName),
            this.ctx.wrap(joinInfo.joinTableName),
            joinCondition,
          )
          .where([whereCondition]);

        const executeQuery = async (session: TransactionSessionManager) => {
          const resultQuery = qb.build();
          const subQueryStart = Date.now();
          this.ctx.beginTrackQuery();
          const queryResult = (await session.query(
            resultQuery,
          )) as QueryResult;
          this.ctx.trackQuery(
            relatedTableName,
            resultQuery.text ?? String(resultQuery),
            Date.now() - subQueryStart,
          );

          const resultTransformer = ResultTransformerFactory.create();
          const { results } = queryResult;

          if (!results || results.length === 0) {
            (parent as any)[rel.propertyKey] = [];
          } else {
            (parent as any)[rel.propertyKey] = resultTransformer.toEntities(
              RelatedEntity,
              queryResult,
            );
          }
        };

        await this.ctx.executeInTransaction(executeQuery, existingSession);
      }
    }
  }

  /**
   * OneToOne 관계를 별도 쿼리로 로드하여 부모 엔티티에 할당합니다.
   * Eager JOIN으로 처리되지 않은 OneToOne 관계(inverseSide 등)를 relations 옵션으로 로드합니다.
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

      for (const parent of parents) {
        if (rel.joinColumn) {
          // 소유측: FK 값으로 관련 엔티티를 조회
          const fkValue = (parent as any)[rel.joinColumn];
          if (fkValue === undefined || fkValue === null) {
            (parent as any)[rel.propertyKey] = null;
            continue;
          }

          const related = await this.ctx.findOneInternal(RelatedEntity, {
            where: { [relatedPk.name!]: fkValue } as any,
          }, existingSession);
          (parent as any)[rel.propertyKey] = related ?? null;
        } else if (rel.inverseSide) {
          // 역방향: 상대측의 joinColumn으로 부모 PK를 검색
          const parentId = (parent as any)[pk.name!];
          if (parentId === undefined || parentId === null) {
            (parent as any)[rel.propertyKey] = null;
            continue;
          }

          // 상대측(소유측)의 OneToOne 메타데이터에서 joinColumn을 찾음
          const relatedOneToOne = this.resolver.resolveOneToOneMetadata(RelatedEntity);
          const ownerRel = relatedOneToOne.find(
            (r) => r.propertyKey === rel.inverseSide && r.joinColumn,
          );

          if (ownerRel?.joinColumn) {
            const related = await this.ctx.findOneInternal(RelatedEntity, {
              where: { [ownerRel.joinColumn]: parentId } as any,
            }, existingSession);
            (parent as any)[rel.propertyKey] = related ?? null;
          } else {
            (parent as any)[rel.propertyKey] = null;
          }
        }
      }
    }
  }
}
