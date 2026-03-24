/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { ClazzType } from "../utils";
import { WhereClause } from "../dialects/FindOption";
import { HOOK_TOKEN, HookEvent, HookMetadata } from "../decorators";
import { hasCascade } from "../types/CascadeType";
import { RelationMetadataResolver } from "./RelationMetadataResolver";
import { EntityManagerInternals } from "./EntityManagerInternals";
import { EntityMetadataNotFoundError } from "../errors/EntityMetadataNotFoundError";
import { TransactionSessionManager } from "../dialects/TransactionSessionManager";

/**
 * 캐스케이드 저장/삭제 + 라이프사이클 훅 핸들러.
 * EntityManager에서 위임받아 처리합니다.
 */
export class CascadeHandler {
  constructor(
    private readonly resolver: RelationMetadataResolver,
    private readonly ctx: EntityManagerInternals,
  ) {}

  /**
   * 엔티티 인스턴스에서 지정된 이벤트의 생명주기 훅을 실행합니다.
   * @HOOK_TOKEN 메타데이터를 읽어 해당 이벤트의 메서드를 호출합니다.
   */
  async runHooks<T>(
    entity: ClazzType<T>,
    item: Partial<T> | WhereClause<T>,
    event: HookEvent,
  ): Promise<void> {
    const hooks = Reflect.getMetadata(HOOK_TOKEN, entity) as
      | HookMetadata[]
      | undefined;
    if (!hooks || hooks.length === 0) return;

    for (const hook of hooks) {
      if (hook.event !== event) continue;
      const method = (item as any)[hook.methodName];
      if (typeof method === "function") {
        await method.call(item);
      }
    }
  }

  /**
   * 변경 감지를 위한 프록시 객체를 생성합니다.
   */
  createProxy<T>(entity: T): T {
    return new Proxy(entity as any, {
      set: (target: any, prop: string, value: any) => {
        target[prop] = value;

        // Set 자료구조에 변경된 엔티티를 추가합니다.
        this.ctx.markDirty(target);
        return true;
      },
    });
  }

  /**
   * save 시 cascade: "insert" | "update" 가 설정된 OneToMany 관계의 자식 엔티티를 재귀적으로 저장합니다.
   */
  async cascadeSaveOneToMany<T>(
    entity: ClazzType<T>,
    item: Partial<T>,
    savedParentId: any,
    session?: TransactionSessionManager,
  ): Promise<void> {
    const oneToManyMeta = this.resolver.resolveOneToManyMetadata(entity);

    for (const rel of oneToManyMeta) {
      const children = (item as any)[rel.propertyKey];
      if (!children || !Array.isArray(children) || children.length === 0)
        continue;

      const RelatedEntity = rel.getRelatedEntity();

      // cascade: "insert" 또는 "update" 가 포함된 경우에만 처리
      if (
        !hasCascade(rel.cascade, "insert") &&
        !hasCascade(rel.cascade, "update")
      )
        continue;

      // ManyToOne 측의 joinColumn 찾기
      const manyToOneItems = this.resolver.resolveManyToOneMetadata(RelatedEntity);
      const matchingRelation = manyToOneItems.find(
        (m) => m.columnName === rel.mappedBy,
      );
      const fkColumn = matchingRelation?.joinColumn ?? rel.mappedBy;

      for (const child of children) {
        // FK를 부모의 PK로 설정
        (child as any)[fkColumn] = savedParentId;
        if (session) {
          await this.ctx.saveWithSession(RelatedEntity, child, session);
        } else {
          await this.ctx.save(RelatedEntity, child);
        }
      }
    }
  }

  /**
   * save 시 cascade: "insert" | "update" 가 설정된 ManyToOne 관계의 부모 엔티티를 먼저 저장합니다.
   */
  async cascadeSaveManyToOne<T>(
    entity: ClazzType<T>,
    item: Partial<T>,
  ): Promise<void> {
    const manyToOneRelations = this.resolver.resolveManyToOneMetadata(entity);

    for (const rel of manyToOneRelations) {
      const relatedValue = (item as any)[rel.columnName];
      if (!relatedValue || typeof relatedValue !== "object") continue;

      if (
        !hasCascade(rel.option?.cascade, "insert") &&
        !hasCascade(rel.option?.cascade, "update")
      )
        continue;

      const RelatedEntity = rel.getMappingEntity() as ClazzType<any>;
      const saved = await this.ctx.save(RelatedEntity, relatedValue);

      // 저장된 부모의 PK를 FK 컬럼에 설정
      const relatedMetadata = this.resolver.resolveEntityMetadata(RelatedEntity);
      if (!relatedMetadata) {
        throw new EntityMetadataNotFoundError(RelatedEntity.name);
      }
      const relatedPk = relatedMetadata.columns.find(
        (col: any) => col.options?.primary,
      );
      if (relatedPk && rel.joinColumn) {
        (item as any)[rel.joinColumn] = (saved as any)[relatedPk.name!];
      }
    }
  }

  /**
   * delete 시 cascade: "delete" (또는 "remove") 가 설정된 OneToMany 관계의 자식 엔티티를 먼저 삭제합니다.
   * PK만 SELECT + IN 절 배치 DELETE로 메모리 및 쿼리 최적화.
   */
  async cascadeDeleteOneToMany<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
  ): Promise<void> {
    const oneToManyMeta = this.resolver.resolveOneToManyMetadata(entity);

    for (const rel of oneToManyMeta) {
      if (!hasCascade(rel.cascade, "delete")) continue;

      const RelatedEntity = rel.getRelatedEntity();

      // 삭제 대상 부모를 조회하여 PK를 획득
      const parentMetadata = this.resolver.resolveEntityMetadata(entity);
      if (!parentMetadata) continue;

      const pk = parentMetadata.columns.find(
        (col: any) => col.options?.primary,
      );
      if (!pk) continue;

      // PK만 SELECT하여 메모리 절약
      const parents = await this.ctx.find(entity, {
        where: criteria,
        select: { [pk.name!]: true },
      } as any);

      if (!parents) continue;

      const parentArray = Array.isArray(parents) ? parents : [parents];

      // 부모 PK를 수집
      const parentIds = parentArray
        .map((p: any) => p[pk.name!])
        .filter((id: any) => id !== undefined && id !== null);

      if (parentIds.length === 0) continue;

      // ManyToOne 측의 FK 컬럼 찾기
      const manyToOneItems = this.resolver.resolveManyToOneMetadata(RelatedEntity);
      const matchingRelation = manyToOneItems.find(
        (m) => m.columnName === rel.mappedBy,
      );
      const fkColumn = matchingRelation?.joinColumn ?? rel.mappedBy;

      // IN 절로 한 번에 자식 삭제
      if (parentIds.length === 1) {
        await this.ctx.delete(RelatedEntity, {
          [fkColumn]: parentIds[0],
        } as any);
      } else {
        await this.ctx.delete(RelatedEntity, {
          [fkColumn]: parentIds,
        } as any);
      }
    }
  }
}
