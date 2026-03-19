/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../../utils";
import { COLUMN_TOKEN } from "../../../decorators/Column";
import { ColumnMetadata } from "../../../scanner/ColumnScanner";
import { PluginContext } from "../PluginContext";

/**
 * Semantic type alias for entity instances crossing module boundaries.
 * Unavoidable `any` in a generic ORM — this alias provides clarity.
 */
export type EntityInstance = any;

/**
 * Column name → value mapping extracted from an entity instance.
 */
export type ColumnValueMap = Record<string, any>;

/**
 * Manages the Identity Map and entity metadata helpers for WriteBuffer.
 *
 * The Identity Map ensures that the same database row (identified by
 * entity class + PK) is always represented by the same object reference.
 */
export class IdentityMapManager {
  readonly identityMap = new Map<string, EntityInstance>();
  readonly stateMap = new Map<EntityInstance, string>();
  private readonly ctx: PluginContext;

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
  }

  /**
   * Validate that an entity class is registered with the EntityManager.
   */
  validateEntity(entityClass: ClazzType<any>): void {
    const entities = this.ctx.getEntities();
    if (!entities.includes(entityClass)) {
      throw new Error(
        `Cannot track instance of "${entityClass.name}": not a registered entity. ` +
        `Make sure the class is decorated with @Entity() and registered with the EntityManager.`,
      );
    }
  }

  /**
   * Get column names and PK column names for an entity class.
   */
  getColumnInfo(entityClass: ClazzType<any>): {
    columnNames: string[];
    pkColumns: string[];
  } {
    const columns: ColumnMetadata[] =
      Reflect.getMetadata(COLUMN_TOKEN, entityClass.prototype) ?? [];

    const columnNames = columns.map((c) => c.name ?? c.propertyKey!);
    const pkColumns = columns
      .filter((c) => c.options?.primary)
      .map((c) => c.name ?? c.propertyKey!);

    return { columnNames, pkColumns };
  }

  /**
   * Build a unique identity key for an entity instance based on class name + PK values.
   * Throws if any PK column is null/undefined.
   */
  buildIdentityKey(
    entityClass: ClazzType<any>,
    instance: EntityInstance,
    pkColumns: string[],
  ): string {
    const pkParts = pkColumns.map((pk) => {
      const value = instance[pk];
      if (value === undefined || value === null) {
        throw new Error(
          `Cannot track instance of "${entityClass.name}": PK column "${pk}" is ${value}. ` +
          `Only persisted entities with assigned PK values can be tracked. ` +
          `Use save() to queue new entities for insertion instead.`,
        );
      }
      return `${pk}=${value}`;
    }).join(",");
    return `${entityClass.name}:${pkParts}`;
  }

  /**
   * Build a WHERE clause from PK columns of a tracked entry.
   */
  buildPkWhere(instance: EntityInstance, pkColumns: string[]): ColumnValueMap {
    const where: ColumnValueMap = {};
    for (const pk of pkColumns) {
      where[pk] = instance[pk];
    }
    return where;
  }

  /**
   * Get the PK value(s) of an entity instance.
   * Returns scalar for single-column PK, object for composite PK.
   */
  getParentPkValue(
    instance: EntityInstance,
    entityClass: ClazzType<any>,
  ): any {
    const { pkColumns } = this.getColumnInfo(entityClass);
    if (pkColumns.length === 1) return instance[pkColumns[0]];
    const pk: ColumnValueMap = {};
    for (const col of pkColumns) pk[col] = instance[col];
    return pk;
  }

  /**
   * Extract only column values from an instance (no relation properties).
   * This ensures CascadeHandler in em.save() won't fire — WriteBuffer
   * handles cascade directly.
   */
  extractColumnData(
    instance: EntityInstance,
    columnNames: string[],
  ): ColumnValueMap {
    const data: ColumnValueMap = {};
    for (const col of columnNames) {
      if (instance[col] !== undefined) data[col] = instance[col];
    }
    return data;
  }

  /**
   * Check if an entity instance matches a simple WHERE clause (equality check).
   */
  matchesWhere(instance: EntityInstance, where: ColumnValueMap): boolean {
    for (const [col, val] of Object.entries(where)) {
      if (instance[col] !== val) return false;
    }
    return true;
  }
}
