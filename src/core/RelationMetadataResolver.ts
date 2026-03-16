/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { ClazzType, Logger } from "../utils";
import {
  ColumnMetadata,
  EntityScannerMetadata,
  EntityScanner,
  ManyToOneScanner,
  OneToManyScanner,
  ManyToManyScanner,
  OneToOneScanner,
} from "../scanner";
import Container from "typedi";
import {
  ENTITY_TOKEN,
  MANY_TO_ONE_TOKEN,
  ManyToOneMetadata,
  ONE_TO_MANY_TOKEN,
  OneToManyMetadata,
  MANY_TO_MANY_TOKEN,
  ManyToManyMetadata,
  DELETED_AT_TOKEN,
  CREATE_TIMESTAMP_TOKEN,
  UPDATE_TIMESTAMP_TOKEN,
  ONE_TO_ONE_TOKEN,
  OneToOneMetadata,
  COLUMN_TOKEN,
  VERSION_TOKEN,
} from "../decorators";
import { MetadataContext } from "../metadata/MetadataContext";

/**
 * 순수 메타데이터 조회 레이어. DB 호출 없음, 부작용 없음.
 * 엔티티/관계 메타데이터를 레이어 시스템 또는 Reflect fallback으로 해석합니다.
 */
export class RelationMetadataResolver {
  private readonly logger = new Logger(RelationMetadataResolver.name);

  /**
   * 엔티티 메타데이터를 레이어 시스템을 통해 조회합니다.
   *
   * 조회 우선순위:
   * 1. EntityScanner.scan() — MetadataLayerRegistry 경유 (멀티테넌트 레이어 지원)
   * 2. Reflect.getMetadata() — 데코레이터가 클래스에 직접 부착한 정적 메타데이터 (fallback)
   */
  resolveEntityMetadata<T>(
    entity: ClazzType<T>,
  ): EntityScannerMetadata | null {
    const context = MetadataContext.isActive()
      ? MetadataContext.getCurrentTenant()
      : "public";

    // 1. 레이어 시스템을 통한 조회 (멀티테넌트 지원)
    const entityScanner = Container.get(EntityScanner);
    const layeredMetadata = entityScanner.scan(entity);
    if (layeredMetadata) {
      return layeredMetadata;
    }

    // 2. Reflect fallback (데코레이터 직접 부착 — 단일 테넌트 호환)
    const reflectMetadata = Reflect.getMetadata(ENTITY_TOKEN, entity) as
      | EntityScannerMetadata
      | undefined;

    if (reflectMetadata) {
      this.logger.warn(
        `[resolveEntityMetadata] "${entity.name}" resolved via Reflect.getMetadata fallback (context: "${context}"). ` +
          `This entity was not found in the layered store.`,
      );
    } else {
      this.logger.error(
        `[resolveEntityMetadata] "${entity.name}" not found in any metadata source (context: "${context}")`,
      );
    }

    return reflectMetadata ?? null;
  }

  /**
   * @DeletedAt 데코레이터가 적용된 컬럼 이름을 반환합니다.
   * 없으면 null을 반환합니다.
   */
  getDeletedAtColumn<T>(entity: ClazzType<T>): string | null {
    const column = Reflect.getMetadata(DELETED_AT_TOKEN, entity) as
      | string
      | undefined;
    return column ?? null;
  }

  /**
   * @CreateTimestamp 데코레이터가 적용된 컬럼 이름을 반환합니다.
   */
  getCreateTimestampColumn<T>(entity: ClazzType<T>): string | null {
    const column = Reflect.getMetadata(CREATE_TIMESTAMP_TOKEN, entity) as
      | string
      | undefined;
    return column ?? null;
  }

  /**
   * @UpdateTimestamp 데코레이터가 적용된 컬럼 이름을 반환합니다.
   */
  getUpdateTimestampColumn<T>(entity: ClazzType<T>): string | null {
    const column = Reflect.getMetadata(UPDATE_TIMESTAMP_TOKEN, entity) as
      | string
      | undefined;
    return column ?? null;
  }

  /**
   * @Version 데코레이터가 적용된 컬럼 이름을 반환합니다.
   * 없으면 null을 반환합니다.
   */
  getVersionColumn<T>(entity: ClazzType<T>): string | null {
    const column = Reflect.getMetadata(VERSION_TOKEN, entity) as
      | string
      | undefined;
    return column ?? null;
  }

  /**
   * ManyToOne 관계 메타데이터를 레이어 시스템을 통해 조회합니다.
   *
   * 조회 우선순위:
   * 1. ManyToOneScanner — MetadataLayerRegistry 경유 (멀티테넌트 레이어 지원)
   * 2. Reflect.getMetadata() — 데코레이터가 직접 부착한 정적 메타데이터 (fallback)
   */
  resolveManyToOneMetadata<T>(
    entity: ClazzType<T>,
  ): ManyToOneMetadata<any>[] {
    // 1. 레이어 시스템을 통한 조회 (멀티테넌트 지원)
    const manyToOneScanner = Container.get(ManyToOneScanner);
    const allRelations = manyToOneScanner.getByTarget<ManyToOneMetadata<any>>(entity);

    if (allRelations.length > 0) {
      return this.resolveJoinColumnsFromColumnMeta(entity, allRelations);
    }

    // 2. Reflect fallback (데코레이터 직접 부착 — 단일 테넌트 호환)
    const reflectMetadata =
      (Reflect.getMetadata(MANY_TO_ONE_TOKEN, entity) as
        | ManyToOneMetadata<any>[]
        | undefined) ??
      (Reflect.getMetadata(MANY_TO_ONE_TOKEN, entity.prototype) as
        | ManyToOneMetadata<any>[]
        | undefined);

    if (reflectMetadata && reflectMetadata.length > 0) {
      this.logger.warn(
        `[resolveManyToOneMetadata] "${entity.name}" ManyToOne resolved via Reflect.getMetadata fallback.`,
      );
      return this.resolveJoinColumnsFromColumnMeta(entity, reflectMetadata);
    }

    return [];
  }

  /**
   * ManyToOne 관계의 joinColumn을 자동 해석합니다.
   *
   * 해석 우선순위:
   * 1. @ManyToOne option의 joinColumn이 명시적으로 지정된 경우 → 그대로 사용
   * 2. 같은 엔티티에 @Column으로 선언된 `{propertyName}Id` 프로퍼티가 있으면
   *    → 해당 @Column의 실제 DB 컬럼명(name)을 FK 컬럼으로 사용
   * 3. 둘 다 없으면 → joinColumn 미설정 (기존 {propertyName}Id 컨벤션 fallback)
   */
  resolveJoinColumnsFromColumnMeta(
    entity: ClazzType<any>,
    relations: ManyToOneMetadata<any>[],
  ): ManyToOneMetadata<any>[] {
    // @Column 메타데이터 조회 (property key → column metadata)
    const columnsMeta: ColumnMetadata[] =
      Reflect.getMetadata(COLUMN_TOKEN, entity) ??
      Reflect.getMetadata(COLUMN_TOKEN, entity.prototype) ??
      [];

    if (columnsMeta.length === 0) {
      return relations;
    }

    return relations.map((rel) => {
      // 이미 joinColumn이 명시된 경우 → 그대로
      if (rel.joinColumn) return rel;

      // {propertyName}Id 패턴의 @Column 탐색
      const fkPropertyName = `${rel.columnName}Id`;
      const matchingColumn = columnsMeta.find(
        (col: ColumnMetadata) => col.propertyKey === fkPropertyName,
      );

      if (!matchingColumn) return rel;

      // @Column의 실제 DB 이름 사용 (name이 있으면 name, 없으면 propertyKey)
      const resolvedJoinColumn = matchingColumn.name ?? fkPropertyName;

      return {
        ...rel,
        joinColumn: resolvedJoinColumn,
      };
    });
  }

  /**
   * OneToMany 관계 메타데이터를 레이어 시스템을 통해 조회합니다.
   *
   * 조회 우선순위:
   * 1. OneToManyScanner — MetadataLayerRegistry 경유 (멀티테넌트 레이어 지원)
   * 2. Reflect.getMetadata() — 데코레이터가 직접 부착한 정적 메타데이터 (fallback)
   */
  resolveOneToManyMetadata<T>(
    entity: ClazzType<T>,
  ): OneToManyMetadata<any>[] {
    // 1. 레이어 시스템을 통한 조회 (멀티테넌트 지원)
    const oneToManyScanner = Container.get(OneToManyScanner);
    const allRelations = oneToManyScanner.getByTarget<OneToManyMetadata<any>>(entity);

    if (allRelations.length > 0) {
      return allRelations;
    }

    // 2. Reflect fallback (데코레이터 직접 부착 — 단일 테넌트 호환)
    const reflectMetadata =
      (Reflect.getMetadata(ONE_TO_MANY_TOKEN, entity) as
        | OneToManyMetadata<any>[]
        | undefined) ??
      (Reflect.getMetadata(ONE_TO_MANY_TOKEN, entity.prototype) as
        | OneToManyMetadata<any>[]
        | undefined);

    if (reflectMetadata && reflectMetadata.length > 0) {
      this.logger.warn(
        `[resolveOneToManyMetadata] "${entity.name}" OneToMany resolved via Reflect.getMetadata fallback.`,
      );
      return reflectMetadata;
    }

    return [];
  }

  /**
   * ManyToMany 관계 메타데이터를 레이어 시스템을 통해 조회합니다.
   *
   * 조회 우선순위:
   * 1. ManyToManyScanner — MetadataLayerRegistry 경유 (멀티테넌트 레이어 지원)
   * 2. Reflect.getMetadata() — 데코레이터가 직접 부착한 정적 메타데이터 (fallback)
   */
  resolveManyToManyMetadata<T>(
    entity: ClazzType<T>,
  ): ManyToManyMetadata<any>[] {
    // 1. 레이어 시스템을 통한 조회 (멀티테넌트 지원)
    const manyToManyScanner = Container.get(ManyToManyScanner);
    const allRelations = manyToManyScanner.getByTarget<ManyToManyMetadata<any>>(entity);

    if (allRelations.length > 0) {
      return allRelations;
    }

    // 2. Reflect fallback (데코레이터 직접 부착 — 단일 테넌트 호환)
    const reflectMetadata =
      (Reflect.getMetadata(MANY_TO_MANY_TOKEN, entity) as
        | ManyToManyMetadata<any>[]
        | undefined) ??
      (Reflect.getMetadata(MANY_TO_MANY_TOKEN, entity.prototype) as
        | ManyToManyMetadata<any>[]
        | undefined);

    if (reflectMetadata && reflectMetadata.length > 0) {
      this.logger.warn(
        `[resolveManyToManyMetadata] "${entity.name}" ManyToMany resolved via Reflect.getMetadata fallback.`,
      );
      return reflectMetadata;
    }

    return [];
  }

  /**
   * OneToOne 관계 메타데이터를 레이어 시스템을 통해 조회합니다.
   *
   * 조회 우선순위:
   * 1. OneToOneScanner — MetadataLayerRegistry 경유 (멀티테넌트 레이어 지원)
   * 2. Reflect.getMetadata() — 데코레이터가 직접 부착한 정적 메타데이터 (fallback)
   */
  resolveOneToOneMetadata<T>(
    entity: ClazzType<T>,
  ): OneToOneMetadata<any>[] {
    // 1. 레이어 시스템을 통한 조회 (멀티테넌트 지원)
    const oneToOneScanner = Container.get(OneToOneScanner);
    const allRelations = oneToOneScanner.getByTarget<OneToOneMetadata<any>>(entity);

    if (allRelations.length > 0) {
      return this.resolveJoinColumnsFromColumnMetaForOneToOne(
        entity,
        allRelations,
      );
    }

    // 2. Reflect fallback (데코레이터 직접 부착 — 단일 테넌트 호환)
    const reflectMetadata =
      (Reflect.getMetadata(ONE_TO_ONE_TOKEN, entity) as
        | OneToOneMetadata<any>[]
        | undefined) ??
      (Reflect.getMetadata(ONE_TO_ONE_TOKEN, entity.prototype) as
        | OneToOneMetadata<any>[]
        | undefined);

    if (reflectMetadata && reflectMetadata.length > 0) {
      this.logger.warn(
        `[resolveOneToOneMetadata] "${entity.name}" OneToOne resolved via Reflect.getMetadata fallback.`,
      );
      return this.resolveJoinColumnsFromColumnMetaForOneToOne(
        entity,
        reflectMetadata,
      );
    }

    return [];
  }

  /**
   * OneToOne 관계의 joinColumn을 @Column 메타데이터에서 자동 해석합니다.
   * 해석 우선순위는 ManyToOne과 동일합니다.
   */
  resolveJoinColumnsFromColumnMetaForOneToOne(
    entity: ClazzType<any>,
    relations: OneToOneMetadata<any>[],
  ): OneToOneMetadata<any>[] {
    const columnsMeta: ColumnMetadata[] =
      Reflect.getMetadata(COLUMN_TOKEN, entity) ??
      Reflect.getMetadata(COLUMN_TOKEN, entity.prototype) ??
      [];

    if (columnsMeta.length === 0) {
      return relations;
    }

    return relations.map((rel) => {
      if (rel.joinColumn) return rel;

      const fkPropertyName = `${rel.propertyKey}Id`;
      const matchingColumn = columnsMeta.find(
        (col: ColumnMetadata) => col.propertyKey === fkPropertyName,
      );

      if (!matchingColumn) return rel;

      const resolvedJoinColumn = matchingColumn.name ?? fkPropertyName;

      return {
        ...rel,
        joinColumn: resolvedJoinColumn,
      };
    });
  }

  /**
   * ManyToMany 관계의 joinTable 정보를 확정합니다.
   * 소유측(joinTable 있음)이면 그대로, 역방향(mappedBy)이면 상대측에서 joinTable을 가져옵니다.
   */
  resolveManyToManyJoinTable<T>(rel: ManyToManyMetadata<any>): {
    joinTableName: string;
    joinColumn: string;
    inverseJoinColumn: string;
  } | null {
    if (rel.joinTable) {
      return {
        joinTableName: rel.joinTable.name,
        joinColumn: rel.joinTable.joinColumn,
        inverseJoinColumn: rel.joinTable.inverseJoinColumn,
      };
    }

    // 역방향: mappedBy가 가리키는 소유측에서 joinTable을 가져온다
    if (rel.mappedBy) {
      const RelatedEntity = rel.getRelatedEntity();
      const relatedManyToMany = this.resolveManyToManyMetadata(RelatedEntity);
      const ownerRel = relatedManyToMany.find(
        (r) => r.propertyKey === rel.mappedBy && r.joinTable,
      );
      if (ownerRel?.joinTable) {
        // 역방향이므로 joinColumn과 inverseJoinColumn을 뒤집는다
        return {
          joinTableName: ownerRel.joinTable.name,
          joinColumn: ownerRel.joinTable.inverseJoinColumn,
          inverseJoinColumn: ownerRel.joinTable.joinColumn,
        };
      }
    }

    return null;
  }
}
