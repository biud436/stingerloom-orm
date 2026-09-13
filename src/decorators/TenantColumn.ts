/* eslint-disable @typescript-eslint/no-explicit-any */
import { Column, KnownColumnType } from "./Column";

export const TENANT_COLUMN_TOKEN = Symbol.for("STG_TENANT_COLUMN");
export const NON_TENANT_ENTITY_TOKEN = Symbol.for("STG_NON_TENANT_ENTITY");

export interface TenantColumnOptions {
  /** Database column name. Defaults to the configured `tenantColumnName` (usually "tenant_id"). */
  name?: string;
  /** Column type. Defaults to "varchar". */
  type?: KnownColumnType;
  /** Max length for varchar. Defaults to 64. */
  length?: number;
}

export interface TenantColumnMetadata {
  propertyKey: string;
  name?: string;
  type: KnownColumnType;
  length?: number;
}

/**
 * Marks a property as the tenant discriminator column.
 *
 * Declaring this is **optional**. When the global `tenantStrategy` is set to
 * `"tenant_column"`, the ORM already (a) adds a tenant column to every entity's
 * DDL, (b) auto-fills it on INSERT from the current `MetadataContext`, and
 * (c) auto-appends `WHERE tenant = ?` to reads/updates/deletes — without any
 * per-entity code.
 *
 * Use `@TenantColumn()` only when you need to **read** the tenant value from
 * entity instances (e.g., audit logs, admin dashboards, cross-tenant exports).
 * While a tenant context is active, writing to this property never moves a row
 * between tenants: an INSERT takes the value from the context, an UPDATE leaves
 * the column out of its SET list, and either branch rejects a value that
 * disagrees with the active tenant with `OrmError(OrmErrorCode.TENANT_MISMATCH)`.
 * Under `MetadataContext.runUnscoped()` or `run("public", ...)` no predicate is
 * applied and the value is written as given — that is the deliberate admin path.
 *
 * @example
 * ```ts
 * @Entity()
 * class AuditLog {
 *   @PrimaryGeneratedColumn() id!: number;
 *   @Column() action!: string;
 *   @TenantColumn() tenantId!: string;   // now readable as log.tenantId
 * }
 * ```
 */
export function TenantColumn(options?: TenantColumnOptions): PropertyDecorator {
  return (target, propertyKey) => {
    const metadata: TenantColumnMetadata = {
      propertyKey: propertyKey.toString(),
      name: options?.name,
      type: options?.type ?? "varchar",
      length: options?.length ?? (options?.type == null ? 64 : undefined),
    };

    Reflect.defineMetadata(TENANT_COLUMN_TOKEN, metadata, target.constructor);

    return Column({
      type: metadata.type,
      length: metadata.length,
      name: metadata.name,
      nullable: false,
    })(target, propertyKey);
  };
}

/**
 * Excludes an entity from the `"tenant_column"` strategy.
 *
 * Use this for entities that are **inherently global** — the tenants table
 * itself, system configuration, shared reference data. These entities get no
 * tenant column, no WHERE injection, no INSERT validation.
 *
 * @example
 * ```ts
 * @Entity()
 * @NonTenantEntity()
 * class Tenant {
 *   @PrimaryColumn() id!: string;
 *   @Column() name!: string;
 * }
 * ```
 */
export function NonTenantEntity(): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(NON_TENANT_ENTITY_TOKEN, true, target);
  };
}

/** Reads `@TenantColumn()` metadata from an entity class, if declared. */
export function getTenantColumnMetadata(
  target: Function,
): TenantColumnMetadata | undefined {
  return Reflect.getMetadata(TENANT_COLUMN_TOKEN, target) as
    | TenantColumnMetadata
    | undefined;
}

/** Returns true if the entity is marked `@NonTenantEntity()`. */
export function isNonTenantEntity(target: Function): boolean {
  return Reflect.getMetadata(NON_TENANT_ENTITY_TOKEN, target) === true;
}
