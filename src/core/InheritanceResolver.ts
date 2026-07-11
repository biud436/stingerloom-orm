/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../utils";
import {
  ENTITY_TOKEN,
  EntityMetadata,
  INHERITANCE_TOKEN,
  DISCRIMINATOR_COLUMN_TOKEN,
  DISCRIMINATOR_VALUE_TOKEN,
  InheritanceStrategy,
} from "../decorators";
import { KnownColumnType } from "../decorators/Column";
import { ColumnMetadata } from "../scanner/ColumnScanner";

/**
 * Stateless service for resolving inheritance hierarchy metadata.
 * Analogous to RelationMetadataResolver but for inheritance concerns.
 */
export class InheritanceResolver {
  /**
   * Returns the inheritance strategy for an entity, or null if not in a hierarchy.
   */
  getStrategy(entity: ClazzType<any>): InheritanceStrategy | null {
    const meta = Reflect.getMetadata(ENTITY_TOKEN, entity) as
      | EntityMetadata
      | undefined;
    return meta?.inheritanceStrategy ?? null;
  }

  /**
   * Returns the root entity of the inheritance hierarchy, or null.
   * If the entity IS the root, returns itself.
   */
  getRoot(entity: ClazzType<any>): ClazzType<any> | null {
    const meta = Reflect.getMetadata(ENTITY_TOKEN, entity) as
      | EntityMetadata
      | undefined;
    if (!meta?.inheritanceStrategy) return null;
    return meta.inheritanceRoot ?? entity;
  }

  /**
   * Returns all concrete child entity classes (including root if it is concrete).
   */
  getConcreteEntities(rootEntity: ClazzType<any>): ClazzType<any>[] {
    const meta = Reflect.getMetadata(ENTITY_TOKEN, rootEntity) as
      | EntityMetadata
      | undefined;
    if (!meta?.childEntities) return [rootEntity];
    return [rootEntity, ...meta.childEntities];
  }

  /**
   * Returns the discriminator column definition from the root entity.
   */
  getDiscriminatorColumn(
    entity: ClazzType<any>,
  ): { name: string; type: KnownColumnType; length: number } | null {
    const root = this.getRoot(entity);
    if (!root) return null;

    const meta = Reflect.getMetadata(ENTITY_TOKEN, root) as
      | EntityMetadata
      | undefined;
    return meta?.discriminatorColumn ?? null;
  }

  /**
   * Returns the discriminator value for a specific entity class.
   */
  getDiscriminatorValue(entity: ClazzType<any>): string | null {
    const meta = Reflect.getMetadata(ENTITY_TOKEN, entity) as
      | EntityMetadata
      | undefined;
    return meta?.discriminatorValue ?? null;
  }

  /**
   * Builds a Map<discriminatorValue, entityClass> for the given root hierarchy.
   */
  buildDiscriminatorMap(
    rootEntity: ClazzType<any>,
  ): Map<string, ClazzType<any>> {
    const map = new Map<string, ClazzType<any>>();
    const entities = this.getConcreteEntities(rootEntity);
    for (const e of entities) {
      const value = this.getDiscriminatorValue(e);
      if (value) {
        map.set(value, e);
      }
    }
    return map;
  }

  /**
   * Returns only the columns that are OWN to an entity (not inherited from parent).
   * Used for TPT where child tables only contain their own columns.
   */
  getOwnColumns(entity: ClazzType<any>): ColumnMetadata[] {
    const meta = Reflect.getMetadata(ENTITY_TOKEN, entity) as
      | EntityMetadata
      | undefined;
    if (!meta) return [];

    const root = this.getRoot(entity);
    if (!root || root === entity) {
      // This IS the root, all columns are "own"
      return meta.columns as ColumnMetadata[];
    }

    const rootMeta = Reflect.getMetadata(ENTITY_TOKEN, root) as
      | EntityMetadata
      | undefined;
    if (!rootMeta) return meta.columns as ColumnMetadata[];

    const rootColumnNames = new Set(
      rootMeta.columns.map((c: any) => c.propertyKey ?? c.name),
    );
    return (meta.columns as ColumnMetadata[]).filter(
      (c) => !rootColumnNames.has(c.propertyKey ?? c.name),
    );
  }

  /**
   * Returns true if the entity is a child in an inheritance hierarchy (not the root).
   */
  isChildEntity(entity: ClazzType<any>): boolean {
    const meta = Reflect.getMetadata(ENTITY_TOKEN, entity) as
      | EntityMetadata
      | undefined;
    return !!meta?.inheritanceRoot;
  }

  /**
   * Returns the discriminator predicate parts for a Single-Table-Inheritance
   * *child* entity, or `null` when no predicate is needed (entity is not STI,
   * is the root, or lacks a discriminator column/value).
   *
   * Bulk write/read paths that hit the STI table directly (updateMany,
   * softDelete, restore, findWithCursor, aggregates) must AND this predicate
   * into their WHERE so they only touch/count rows of the requested subtype —
   * exactly like `find()` and `delete()` already do. The caller wraps
   * `columnName` and binds `value` through its own escaping helpers.
   */
  getSingleTableChildDiscriminator(
    entity: ClazzType<any>,
  ): { columnName: string; value: string } | null {
    if (this.getStrategy(entity) !== "SINGLE_TABLE") return null;
    if (!this.isChildEntity(entity)) return null;
    const discCol = this.getDiscriminatorColumn(entity);
    const discVal = this.getDiscriminatorValue(entity);
    if (!discCol || !discVal) return null;
    return { columnName: discCol.name, value: discVal };
  }

  /**
   * Returns true if the entity is the root of an inheritance hierarchy.
   */
  isRootEntity(entity: ClazzType<any>): boolean {
    const meta = Reflect.getMetadata(ENTITY_TOKEN, entity) as
      | EntityMetadata
      | undefined;
    return (
      !!meta?.inheritanceStrategy &&
      !meta.inheritanceRoot &&
      !!meta.childEntities
    );
  }

  /**
   * Returns true if querying this entity should return polymorphic results.
   * (Root entity with children registered)
   */
  isPolymorphicQuery(entity: ClazzType<any>): boolean {
    return (
      this.isRootEntity(entity) &&
      (this.getConcreteEntities(entity).length > 1)
    );
  }

  /**
   * Returns the superset of all columns across the entire inheritance hierarchy.
   * Used for TPC UNION ALL queries to determine NULL-padding columns.
   */
  getAllHierarchyColumns(rootEntity: ClazzType<any>): ColumnMetadata[] {
    const entities = this.getConcreteEntities(rootEntity);
    const allCols = new Map<string, ColumnMetadata>();
    for (const ent of entities) {
      const entMeta = Reflect.getMetadata(ENTITY_TOKEN, ent) as
        | EntityMetadata
        | undefined;
      if (entMeta) {
        for (const col of entMeta.columns as ColumnMetadata[]) {
          const key = col.name ?? col.propertyKey;
          if (key && !allCols.has(key)) {
            allCols.set(key, col);
          }
        }
      }
    }
    return [...allCols.values()];
  }
}
