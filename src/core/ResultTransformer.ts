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
import {
  RELATION_COLUMN_TOKEN,
  RelationColumnMetadata,
} from "../decorators/RelationColumn";
import { ClazzType } from "../utils";
import { ColumnMetadata } from "../scanner/ColumnScanner";
import { ColumnTypeRegistry } from "./ColumnTypeRegistry";
import { isJsonColumnType, makeDefaultJsonColumnRead } from "./JsonColumnTransformer";
import {
  isTemporalColumnType,
  defaultTemporalColumnRead,
} from "./TemporalColumnTransformer";

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

let columnInfoCache = new WeakMap<Function, CachedColumnInfo>();

// ── Strategy 2: Per-entity relation metadata cache ────────
// transformNested() runs fillPropertiesToForeignObject() once per row, and
// each call re-read MANY_TO_ONE_TOKEN / ONE_TO_ONE_TOKEN via Reflect — plus
// one more lookup per relation for the nested fan-out. Relation metadata is
// attached at class-definition / registration time (decorators and
// EntitySchemaRegistrar both run before the first query on a class), so a
// per-class cache is safe. Classes with no relation metadata yet are not
// cached, so a class queried before its relations are registered (unusual,
// but possible with incremental EntitySchema registration) is re-read.

interface CachedRelationInfo {
  manyToOne: ManyToOneMetadata<any>[] | undefined;
  oneToOne: OneToOneMetadata<any>[] | undefined;
}

let relationInfoCache = new WeakMap<Function, CachedRelationInfo>();

function getCachedRelationInfo(entityClass: Function): CachedRelationInfo {
  let cached = relationInfoCache.get(entityClass);
  if (cached) return cached;

  cached = {
    manyToOne: Reflect.getMetadata(MANY_TO_ONE_TOKEN, entityClass) as
      | ManyToOneMetadata<any>[]
      | undefined,
    oneToOne: Reflect.getMetadata(ONE_TO_ONE_TOKEN, entityClass) as
      | OneToOneMetadata<any>[]
      | undefined,
  };
  if (cached.manyToOne || cached.oneToOne) {
    relationInfoCache.set(entityClass, cached);
  }
  return cached;
}

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

  // Also remap RelationColumn-managed FK columns (e.g. `user_id` →
  // `userId`). The default shadow is `${relationProperty}Id`; entities
  // that don't follow that convention can override via `@ManyToOne(...,
  // { fkProperty })` / `@OneToOne(..., { fkProperty })`. Without this,
  // responses built from saved entities under SnakeNamingStrategy leak
  // the raw `user_id` key out to the API.
  const relationColumns: RelationColumnMetadata[] | undefined =
    Reflect.getMetadata(RELATION_COLUMN_TOKEN, entityClass) ??
    Reflect.getMetadata(RELATION_COLUMN_TOKEN, entityClass.prototype);
  if (relationColumns) {
    const m2oRelations: ManyToOneMetadata<any>[] | undefined =
      Reflect.getMetadata(MANY_TO_ONE_TOKEN, entityClass) ??
      Reflect.getMetadata(MANY_TO_ONE_TOKEN, entityClass.prototype);
    const o2oRelations: OneToOneMetadata<any>[] | undefined =
      Reflect.getMetadata(ONE_TO_ONE_TOKEN, entityClass) ??
      Reflect.getMetadata(ONE_TO_ONE_TOKEN, entityClass.prototype);

    const fkPropertyByRelationProp = new Map<string, string>();
    if (m2oRelations) {
      for (const r of m2oRelations) {
        const fk = r.option?.fkProperty;
        if (fk) fkPropertyByRelationProp.set(r.columnName, fk);
      }
    }
    if (o2oRelations) {
      for (const r of o2oRelations) {
        const fk = r.option?.fkProperty;
        if (fk) fkPropertyByRelationProp.set(r.propertyKey, fk);
      }
    }

    for (const rel of relationColumns) {
      if (!rel.name || !rel.propertyKey) continue;
      const shadow =
        fkPropertyByRelationProp.get(rel.propertyKey) ??
        `${rel.propertyKey}Id`;
      if (rel.name === shadow) continue;
      if (!remapMap) remapMap = new Map();
      // Don't clobber an explicit @Column remap entry.
      if (!remapMap.has(rel.name)) {
        remapMap.set(rel.name, shadow);
      }
    }
  }

  // Build transform list
  const transformColumns: Array<{ key: string; from: (raw: any) => any }> = [];
  const registry = ColumnTypeRegistry.getInstance();
  const entityName = (entityClass as { name?: string }).name ?? "Entity";
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
      } else if (isJsonColumnType(col.options.type)) {
        // Default JSON round-trip: parse string payloads on read.
        // mysql2 / better-sqlite3 surface JSON columns as strings, while pg
        // jsonb already returns parsed values; the helper short-circuits the
        // non-string branch so it is a no-op for pg.
        transformColumns.push({
          key,
          from: makeDefaultJsonColumnRead(entityName, key),
        });
      } else if (col.options.type === "boolean") {
        // MySQL/SQLite store booleans as 0/1 TINYINT; normalize to a real
        // JS boolean on read. PostgreSQL returns true/false already, in
        // which case Boolean() is the identity.
        transformColumns.push({ key, from: (raw) => Boolean(raw) });
      } else if (isTemporalColumnType(col.options.type)) {
        // better-sqlite3 returns temporal columns as the stored TEXT while
        // pg/mysql2 return Date; normalize on read so the entity's declared
        // Date type holds on every driver. Date values pass through, so this
        // is a cheap instanceof check on PostgreSQL/MySQL.
        transformColumns.push({ key, from: defaultTemporalColumnRead });
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
   * Returns true when the query result is empty.
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
   * Extracts all non-foreign-key properties from an entity.
   */
  private extractBaseEntity<T>(
    entityClass: MyClassConstructor<T>,
    row: any,
    baseEntity: any,
  ) {
    const { remapMap } = getCachedColumnInfo(entityClass);

    const enties = Object.entries(row);

    for (const [key, value] of enties) {
      // A row key with a remap entry is a base column on this entity (e.g.
      // snake_case @Column like `created_at` → `createdAt`, or
      // @RelationColumn FK like `project_id` → `projectId`). Underscore
      // does not imply "joined relation column" in that case — only keys
      // with no remap entry are candidates for the foreign-object handler.
      const remapped = remapMap?.get(key);
      if (remapped !== undefined) {
        baseEntity[remapped] = value;
        continue;
      }
      const isUnderScored = key.includes(ResultTransformer.PropertySeparator);
      if (!isUnderScored) {
        baseEntity[key] = value;
      }
    }
  }

  /**
   * Creates an empty entity.
   */
  private buildNullEntity() {
    return undefined;
  }

  /**
   * Creates an empty entity collection.
   */
  private buildEmptyEntities<T>(): T[] {
    return [] as T[];
  }

  /**
   * Creates a foreign-key object.
   */
  private createForeignObject<T = any>(): ForeignObject<T> {
    return {};
  }

  /**
   * Builds the SQL-side column name.
   */
  private addSeparatorToColumnName(columnName: string): string {
    return `${columnName}${ResultTransformer.PropertySeparator}`;
  }

  /**
   * Converts a SQL result into a single entity.
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
   * Converts a SQL result into an array of entities.
   *
   * Batches the deserializer invocation: `class-transformer` (and other
   * `Deserializer` impls) natively accept an array and amortize per-row
   * function-call / option-merging / internal-scan overhead. For large
   * result sets this is materially cheaper than one call per row.
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

    // Fast path — no remap + no transformers → batch-deserialize the raw rows.
    if (!info.remapMap && !info.hasTransformers) {
      return deserializeEntity(entityClass, r.results) as unknown as T[];
    }

    // Standard path with remap: build a single array of remapped rows, then
    // deserialize in one call. The `for`-loop + preallocated result array
    // avoids the closure allocation of `.map(...)` on hot paths.
    const remappedRows = new Array(r.results.length);
    for (let i = 0; i < r.results.length; i++) {
      remappedRows[i] = remapRowToPropertyKeys(entityClass, r.results[i]);
    }
    const entities = deserializeEntity(entityClass, remappedRows) as unknown as T[];

    if (!info.hasTransformers) return entities;

    for (let i = 0; i < entities.length; i++) {
      this.applyColumnTransforms(entityClass, entities[i]);
    }
    return entities;
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
   * Converts an object into an array of [key, value] pairs.
   */
  private getObjectEntries<T = any, R = [string, unknown]>(obj: any): R[] {
    return Object.entries(obj) as R[];
  }

  /**
   * Populates a foreign-key object with its contents.
   *
   * `visited` tracks entity classes already in the current recursion chain
   * so self-referencing relations (e.g. `Issue.parent → Issue`) and cycles
   * (`A → B → A`) terminate. The relation is still attached, but its nested
   * ManyToOne/OneToOne fan-out stops at the cycle boundary — the SELECT
   * only joins one level deep anyway, so deeper expansion would yield empty
   * objects regardless.
   */
  private fillPropertiesToForeignObject<T>(
    entityClass: MyClassConstructor<T>,
    baseEntity: ForeignObject<any>,
    resultSet: any,
    visited: Set<Function> = new Set(),
  ) {
    visited.add(entityClass as unknown as Function);

    // Fetch the foreign-key metadata (cached per class — this runs per row).
    const manyToOneMappingMetadata = getCachedRelationInfo(entityClass)
      .manyToOne as ManyToOneMetadata<T>[] | undefined;

    const foreignKeys = manyToOneMappingMetadata?.map((e) => e.columnName);

    if (manyToOneMappingMetadata && foreignKeys) {
      for (const foreignKey of foreignKeys) {
        if (!baseEntity[foreignKey]) {
          baseEntity[foreignKey] = this.createForeignObject();
        }
      }

      // Build a separate object for the foreign-key data of each ManyToOne relation.
      for (const { getMappingEntity, columnName } of manyToOneMappingMetadata) {
        const ForeignClass = getMappingEntity() as ClazzType<T>;

        const rows = this.getObjectEntries(resultSet);
        const foreignObject = this.createForeignObject();

        // Filter the foreign-key columns out of the JOIN result to build the object.
        for (const [key, value] of rows) {
          const prefix = this.addSeparatorToColumnName(columnName);

          const isContainsPrefix = key.startsWith(prefix);
          if (isContainsPrefix) {
            const keyWithoutPrefix = key.replace(prefix, "");
            foreignObject[keyWithoutPrefix] = value;
          }
        }

        // Recursively handle nested foreign-key relations.
        const relatedManyToOneMappings =
          getCachedRelationInfo(ForeignClass).manyToOne;

        if (
          relatedManyToOneMappings &&
          !visited.has(ForeignClass as unknown as Function)
        ) {
          this.fillPropertiesToForeignObject(
            ForeignClass,
            foreignObject,
            resultSet,
            visited,
          );
        }

        // If the LEFT JOIN produced no match, all values are null → assign null.
        // Reverse-map the prefix-stripped DB column names to the related
        // entity's property keys (so a NamingStrategy / @Column({name}) on the
        // FK side hydrates correctly), then apply that entity's read transforms
        // (boolean/json/custom) — the eager-join path skipped both before.
        baseEntity[columnName] = this.isDeepNull(foreignObject)
          ? null
          : this.applyColumnTransforms(
              ForeignClass,
              deserializeEntity(
                ForeignClass,
                remapRowToPropertyKeys(ForeignClass, foreignObject),
              ),
            );
      }
    }

    // Handle OneToOne relations (using the same alias pattern as ManyToOne: propertyKey_columnName).
    const oneToOneMappingMetadata = getCachedRelationInfo(entityClass).oneToOne;

    if (oneToOneMappingMetadata) {
      for (const rel of oneToOneMappingMetadata) {
        if (!rel.joinColumn) continue; // Owning side only

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
        const relatedManyToOneMappings =
          getCachedRelationInfo(RelatedClass).manyToOne;

        if (
          relatedManyToOneMappings &&
          !visited.has(RelatedClass as unknown as Function)
        ) {
          this.fillPropertiesToForeignObject(
            RelatedClass,
            foreignObject,
            foreignObject,
            visited,
          );
        }

        // Assign null when the LEFT JOIN did not match. Reverse-map + apply
        // read transforms for the related entity (see the ManyToOne branch).
        baseEntity[propertyKey] = this.isDeepNull(foreignObject)
          ? null
          : this.applyColumnTransforms(
              RelatedClass,
              deserializeEntity(
                RelatedClass,
                remapRowToPropertyKeys(RelatedClass, foreignObject),
              ),
            );
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
   * Converts a SQL result into either a single entity or an array of entities.
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

      // The eager-join path must apply the root entity's read transforms too —
      // the non-eager toEntity/toEntities paths already do this.
      return this.applyColumnTransforms(entityClass, finalEntity);
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
  // WeakMap doesn't have clear(), so replace the module-level variables.
  // Since WeakMap entries are GC'd when the key is GC'd, this is mainly for tests.
  columnInfoCache = new WeakMap();
  relationInfoCache = new WeakMap();
}
