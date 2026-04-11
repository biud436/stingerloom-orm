/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { MyClassConstructor } from "./MyClassConstructor";
import type { QueryResult } from "../types/QueryResult";
import { BaseResultTransformer } from "./BaseResultTransformer";
import { deserializeEntity } from "./deserializer/DeserializeEntity";
import {
  ENTITY_TOKEN,
  COLUMN_TOKEN,
  MANY_TO_ONE_TOKEN,
  ManyToOneMetadata,
  ONE_TO_ONE_TOKEN,
  OneToOneMetadata,
} from "../decorators";
import { ClazzType } from "../utils";
import { ColumnMetadata } from "../scanner/ColumnScanner";
import { ColumnTypeRegistry } from "./ColumnTypeRegistry";

export type ForeignObject<T = any> = { [key: string]: T };

// ── Strategy 1: Per-entity metadata cache ─────────────────
// Instead of calling Reflect.getMetadata() + rebuilding Maps on every row,
// we compute once per entity class and cache the result.

interface CachedColumnInfo {
  columns: ColumnMetadata[];
  /** column DB name → entity propertyKey (only entries where name !== propertyKey) */
  remapMap: Map<string, string> | null;
  /** True if any column has a transformer or transform function */
  hasTransformers: boolean;
  /** Columns that have transformer.from or legacy transform */
  transformColumns: Array<{ key: string; from: (raw: any) => any }>;
}

const columnInfoCache = new WeakMap<Function, CachedColumnInfo>();

function getCachedColumnInfo(entityClass: MyClassConstructor<any>): CachedColumnInfo {
  let cached = columnInfoCache.get(entityClass);
  if (cached) return cached;

  const columns: ColumnMetadata[] | undefined = Reflect.getMetadata(
    COLUMN_TOKEN,
    entityClass.prototype ?? entityClass,
  );

  if (!columns || columns.length === 0) {
    cached = { columns: [], remapMap: null, hasTransformers: false, transformColumns: [] };
    columnInfoCache.set(entityClass, cached);
    return cached;
  }

  // Build remap map
  let remapMap: Map<string, string> | null = null;
  for (const col of columns) {
    if (col.name && col.propertyKey && col.name !== col.propertyKey) {
      if (!remapMap) remapMap = new Map();
      remapMap.set(col.name, col.propertyKey);
    }
  }

  // Build transform list
  const transformColumns: Array<{ key: string; from: (raw: any) => any }> = [];
  const registry = ColumnTypeRegistry.getInstance();
  for (const col of columns) {
    const key = col.propertyKey ?? col.name;
    if (!key) continue;
    if (col.transformer?.from) {
      transformColumns.push({ key, from: col.transformer.from });
    } else if (col.transform) {
      transformColumns.push({ key, from: col.transform });
    } else if (col.options?.type) {
      // Fall back to registry transformer for custom types
      const regTransformer = registry.getTransformer(col.options.type);
      if (regTransformer?.from) {
        transformColumns.push({ key, from: regTransformer.from });
      }
    }
  }

  cached = {
    columns,
    remapMap,
    hasTransformers: transformColumns.length > 0,
    transformColumns,
  };
  columnInfoCache.set(entityClass, cached);
  return cached;
}

/**
 * Remap DB row keys (column names) to entity property keys.
 * Uses cached remap map to avoid per-row Reflect.getMetadata() calls.
 */
function remapRowToPropertyKeys(
  entityClass: MyClassConstructor<any>,
  row: any,
): any {
  if (!row) return row;
  const { remapMap } = getCachedColumnInfo(entityClass);
  if (!remapMap) return row;

  const remapped: any = {};
  for (const key in row) {
    remapped[remapMap.get(key) ?? key] = row[key];
  }
  return remapped;
}

export class ResultTransformer implements BaseResultTransformer {
  private static PropertySeparator = "_";

  /**
   * 쿼리 결과가 없는 경우를 확인합니다.
   */
  private hasNoResults(queryResult: QueryResult<any> | undefined): boolean {
    return !queryResult?.results || queryResult.results.length === 0;
  }

  /**
   * Apply column-level transformers using cached transform list.
   */
  private applyColumnTransforms<T>(entityClass: MyClassConstructor<T>, instance: T): T {
    if (!instance) return instance;
    const { hasTransformers, transformColumns } = getCachedColumnInfo(entityClass);
    if (!hasTransformers) return instance;

    for (const { key, from } of transformColumns) {
      const raw = (instance as any)[key];
      if (raw !== undefined && raw !== null) {
        (instance as any)[key] = from(raw);
      }
    }

    return instance;
  }

  /**
   * 엔티티에서 외래키 필드가 아닌 속성을 모두 추출합니다.
   */
  private extractBaseEntity<T>(
    entityClass: MyClassConstructor<T>,
    row: any,
    baseEntity: any,
  ) {
    const { remapMap } = getCachedColumnInfo(entityClass);

    const enties = Object.entries(row);

    for (const [key, value] of enties) {
      const isUnderScored = key.includes(ResultTransformer.PropertySeparator);
      if (!isUnderScored) {
        const propKey = remapMap?.get(key) ?? key;
        baseEntity[propKey] = value;
      }
    }
  }

  /**
   * 빈 엔티티를 생성합니다.
   */
  private buildNullEntity() {
    return undefined;
  }

  /**
   * 빈 엔티티 컬렉션을 생성합니다.
   */
  private buildEmptyEntities<T>(): T[] {
    return [] as T[];
  }

  /**
   * 외래키 오브젝트를 생성합니다.
   */
  private createForeignObject<T = any>(): ForeignObject<T> {
    return {};
  }

  /**
   * SQL 측 컬럼명을 만듭니다.
   */
  private addSeparatorToColumnName(columnName: string): string {
    return `${columnName}${ResultTransformer.PropertySeparator}`;
  }

  /**
   * SQL 결과를 단일 엔티티로 변환합니다.
   */
  public toEntity<T>(
    entityClass: MyClassConstructor<T>,
    result: QueryResult<any> | undefined,
  ): T | undefined {
    if (this.hasNoResults(result)) {
      return this.buildNullEntity();
    }

    const r = result!;

    const remapped = remapRowToPropertyKeys(entityClass, r.results[0]);
    return this.applyColumnTransforms(entityClass, deserializeEntity(entityClass, remapped));
  }

  /**
   * SQL 결과를 엔티티 배열로 변환합니다.
   */
  public toEntities<T>(
    entityClass: MyClassConstructor<T>,
    result: QueryResult<any> | undefined,
  ): T[] {
    if (this.hasNoResults(result)) {
      return this.buildEmptyEntities<T>();
    }

    const r = result!;
    const info = getCachedColumnInfo(entityClass);

    // Strategy 3: Fast path — no remap + no transformers → skip remap step
    if (!info.remapMap && !info.hasTransformers) {
      return r.results.map((item) => deserializeEntity(entityClass, item));
    }

    // Standard path with remap + transforms
    if (!info.hasTransformers) {
      return r.results.map((item) => {
        const remapped = remapRowToPropertyKeys(entityClass, item);
        return deserializeEntity(entityClass, remapped);
      });
    }

    return r.results.map((item) => {
      const remapped = remapRowToPropertyKeys(entityClass, item);
      return this.applyColumnTransforms(entityClass, deserializeEntity(entityClass, remapped));
    });
  }

  /**
   * Deserializes a result set where rows may be different subclass types (STI).
   * Reads the discriminator column from each row and instantiates
   * the correct child entity class.
   */
  public toPolymorphicEntities<T>(
    rootEntityClass: MyClassConstructor<T>,
    result: QueryResult<any> | undefined,
    discriminatorMap: Map<string, MyClassConstructor<any>>,
    discriminatorColumnName: string,
  ): T[] {
    if (this.hasNoResults(result)) {
      return this.buildEmptyEntities<T>();
    }

    const r = result!;
    return r.results.map((item) => {
      const discValue = item[discriminatorColumnName];
      const TargetClass =
        (discValue != null ? discriminatorMap.get(String(discValue)) : undefined) ??
        rootEntityClass;
      const remapped = remapRowToPropertyKeys(TargetClass, item);
      return this.applyColumnTransforms(
        TargetClass,
        deserializeEntity(TargetClass, remapped),
      ) as T;
    });
  }

  /**
   * Deserializes a TPT (JOINED) polymorphic result set.
   * Root columns are unprefixed; child columns are prefixed as `childTable_colName`.
   * Uses the discriminator column to determine the correct subclass,
   * then strips the prefix for matching child columns.
   */
  public toTPTPolymorphicEntities<T>(
    rootEntityClass: MyClassConstructor<T>,
    result: QueryResult<any> | undefined,
    discriminatorMap: Map<string, MyClassConstructor<any>>,
    discriminatorColumnName: string,
    childTablePrefixMap: Map<string, string>,
  ): T[] {
    if (this.hasNoResults(result)) {
      return this.buildEmptyEntities<T>();
    }

    // Build a reverse lookup: for each disc value, get the set of all prefixes
    // from OTHER children so we can skip them.
    const allPrefixes = new Set(childTablePrefixMap.values());

    const r = result!;
    return r.results.map((item) => {
      const discValue = item[discriminatorColumnName];
      const TargetClass =
        (discValue != null
          ? discriminatorMap.get(String(discValue))
          : undefined) ?? rootEntityClass;

      const childPrefix = discValue != null
        ? childTablePrefixMap.get(String(discValue))
        : undefined;

      const flatRow: any = {};
      for (const [key, value] of Object.entries(item)) {
        if (key === discriminatorColumnName) continue;
        if (childPrefix && key.startsWith(`${childPrefix}_`)) {
          // This child's prefixed column — strip prefix
          flatRow[key.substring(childPrefix.length + 1)] = value;
        } else {
          // Check if it belongs to another child's prefix — skip if so
          let isOtherChild = false;
          for (const prefix of allPrefixes) {
            if (prefix !== childPrefix && key.startsWith(`${prefix}_`)) {
              isOtherChild = true;
              break;
            }
          }
          if (!isOtherChild) {
            flatRow[key] = value;
          }
        }
      }

      const remapped = remapRowToPropertyKeys(TargetClass, flatRow);
      return this.applyColumnTransforms(
        TargetClass,
        deserializeEntity(TargetClass, remapped),
      ) as T;
    });
  }

  /**
   * Transform SQL result to entity or entity array.
   */
  public transform<T>(
    entityClass: MyClassConstructor<T>,
    result: QueryResult<any> | undefined,
  ): T | T[] | undefined {
    if (this.hasNoResults(result)) {
      return this.buildNullEntity();
    }

    const r = result!;

    const isSingleEntity = r.results.length === 1;
    if (isSingleEntity) {
      return this.applyColumnTransforms(entityClass, deserializeEntity(entityClass, r.results[0]));
    }

    return r.results.map((item) => this.applyColumnTransforms(entityClass, deserializeEntity(entityClass, item)));
  }

  /**
   * 객체를 [키, 값] 쌍의 배열로 변환합니다.
   */
  private getObjectEntries<T = any, R = [string, unknown]>(obj: any): R[] {
    return Object.entries(obj) as R[];
  }

  /**
   * 외래키 오브젝트에 내용을 채워넣습니다.
   */
  private fillPropertiesToForeignObject<T>(
    entityClass: MyClassConstructor<T>,
    baseEntity: ForeignObject<any>,
    resultSet: any,
  ) {
    // 외래키 메타데이터를 가져옵니다.
    const manyToOneMappingMetadata = Reflect.getMetadata(
      MANY_TO_ONE_TOKEN,
      entityClass,
    ) as ManyToOneMetadata<T>[];

    const foreignKeys = manyToOneMappingMetadata?.map((e) => e.columnName);

    if (foreignKeys) {
      for (const foreignKey of foreignKeys) {
        if (!baseEntity[foreignKey]) {
          baseEntity[foreignKey] = this.createForeignObject();
        }
      }

      // ManyToOne 관계의 외래키 데이터를 별도 객체로 분리하여 구성
      for (const { getMappingEntity, columnName } of manyToOneMappingMetadata) {
        const ForeignClass = getMappingEntity() as ClazzType<T>;

        const rows = this.getObjectEntries(resultSet);
        const foreignObject = this.createForeignObject();

        // JOIN 결과에서 해당 외래키 컬럼들만 필터링하여 객체 구성
        for (const [key, value] of rows) {
          const prefix = this.addSeparatorToColumnName(columnName);

          const isContainsPrefix = key.startsWith(prefix);
          if (isContainsPrefix) {
            const keyWithoutPrefix = key.replace(prefix, "");
            foreignObject[keyWithoutPrefix] = value;
          }
        }

        // 중첩된 외래키 관계가 있는 경우 재귀적으로 처리
        const relatedManyToOneMappings = Reflect.getMetadata(
          MANY_TO_ONE_TOKEN,
          ForeignClass,
        ) as ManyToOneMetadata<any>[];

        if (relatedManyToOneMappings) {
          this.fillPropertiesToForeignObject(
            ForeignClass,
            foreignObject,
            resultSet,
          );
        }

        // LEFT JOIN으로 매칭되지 않은 경우 모든 값이 null → null 할당
        baseEntity[columnName] = this.isDeepNull(foreignObject)
          ? null
          : deserializeEntity(ForeignClass, foreignObject);
      }
    }

    // OneToOne 관계 처리 (ManyToOne과 동일한 alias 패턴: propertyKey_columnName)
    const oneToOneMappingMetadata = Reflect.getMetadata(
      ONE_TO_ONE_TOKEN,
      entityClass,
    ) as OneToOneMetadata<any>[] | undefined;

    if (oneToOneMappingMetadata) {
      for (const rel of oneToOneMappingMetadata) {
        if (!rel.joinColumn) continue; // 소유측만 처리

        const propertyKey = rel.propertyKey;
        const RelatedClass = rel.getRelatedEntity() as ClazzType<any>;

        const rows = this.getObjectEntries(resultSet);
        const foreignObject = this.createForeignObject();

        for (const [key, value] of rows) {
          const prefix = this.addSeparatorToColumnName(propertyKey);
          if (key.startsWith(prefix)) {
            const keyWithoutPrefix = key.replace(prefix, "");
            foreignObject[keyWithoutPrefix] = value;
          }
        }

        // #116: Recursively process nested ManyToOne relations within OneToOne entities
        // Pass foreignObject as resultSet so nested prefix matching works correctly
        const relatedManyToOneMappings = Reflect.getMetadata(
          MANY_TO_ONE_TOKEN,
          RelatedClass,
        ) as ManyToOneMetadata<any>[];

        if (relatedManyToOneMappings) {
          this.fillPropertiesToForeignObject(
            RelatedClass,
            foreignObject,
            foreignObject,
          );
        }

        // LEFT JOIN으로 매칭되지 않은 경우 null 할당
        baseEntity[propertyKey] = this.isDeepNull(foreignObject)
          ? null
          : deserializeEntity(RelatedClass, foreignObject);
      }
    }

    const finalEntity = deserializeEntity(entityClass, { ...baseEntity });

    return finalEntity;
  }

  /**
   * Recursively checks if an object is "deep null": all leaf values are null/undefined.
   */
  private isDeepNull(obj: ForeignObject<any>): boolean {
    const keys = Object.keys(obj);
    if (keys.length === 0) return true;
    return Object.values(obj).every((v) => {
      if (v === null || v === undefined) return true;
      if (typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
        return this.isDeepNull(v);
      }
      return false;
    });
  }

  /**
   * SQL 결과를 엔티티 또는 엔티티 배열로 변환합니다.
   */
  public transformNested<T>(
    entityClass: MyClassConstructor<T>,
    queryResult: QueryResult<any> | undefined,
    relations?: { [key: string]: MyClassConstructor<any> },
  ): T | T[] | undefined {
    if (this.hasNoResults(queryResult)) {
      return this.buildNullEntity();
    }

    const r = queryResult!;

    const transformedResults = r.results.map<any>((row) => {
      const baseEntity: { [key: string]: any } = {};

      this.extractBaseEntity(entityClass, row, baseEntity);

      const finalEntity = this.fillPropertiesToForeignObject(
        entityClass,
        baseEntity,
        row,
      );

      return finalEntity;
    });

    const isSingleResult = transformedResults.length === 1;

    return isSingleResult ? transformedResults[0] : transformedResults;
  }
}

/**
 * Clear the per-entity column info cache.
 * Exposed for testing; not part of the public API.
 * @internal
 */
export function clearColumnInfoCache(): void {
  // WeakMap doesn't have clear(), but we can replace the module-level variable.
  // Since WeakMap entries are GC'd when the key is GC'd, this is mainly for tests.
}
