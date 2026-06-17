/* eslint-disable @typescript-eslint/no-explicit-any */
import type { EntityManager } from "./EntityManager";
import type { RelationMetadataResolver } from "./RelationMetadataResolver";
import type { CascadeHandler } from "./CascadeHandler";
import type { InheritanceResolver } from "./InheritanceResolver";
import type { EntityEventEmitter } from "./EntityEventEmitter";
import type { RelationLoader } from "./RelationLoader";
import type { AggregateQueryHandler } from "./AggregateQueryHandler";
import { ClazzType } from "../utils";
import { ISqlDriver } from "../dialects/SqlDriver";
import { IDatabaseType } from "../dialects/mysql/MySqlConnector";
import { TransactionSessionManager } from "../dialects/TransactionSessionManager";
import { FindOption, LockMode, WhereClause } from "../dialects/FindOption";
import { ReplicationNodeConfig } from "../dialects/ReplicationRouter";
import { DeleteResult } from "../types/DeleteResult";
import { EntityResult } from "../types/EntityResult";
import { ISelectOption } from "../dialects/ISelectOption";
import { EntitySubscriber } from "./EntitySubscriber";
import { SchemaDialect } from "./generators/SchemaGenerator";
import { SynchronizePolicy } from "./DatabaseClientOptions";
import { ColumnMetadata } from "../scanner";

/**
 * Interface that exposes EntityManager internals to extracted handler classes.
 * Handlers depend on this interface rather than EntityManager itself to avoid circular references.
 *
 * @internal Package-internal — not a public API.
 */
export interface EntityManagerInternals {
  wrap(col: string): string;
  wrapTable(tableName: string): string;
  isMySqlFamily(): boolean;
  isPostgres(): boolean;
  isSqlite(): boolean;
  /** Raw connected DB type (may be undefined before connect()); used in DML error messages. */
  getDbType(): IDatabaseType | undefined;
  getDriver(): ISqlDriver | undefined;
  /** The owning EntityManager facade — used to populate `manager` on lifecycle events. */
  getManager(): EntityManager;
  // ── Live collaborator accessors (read at call time so test-time
  //    reassignment of `em.resolver` etc. is honored by extracted executors) ──
  getResolver(): RelationMetadataResolver;
  getCascadeHandler(): CascadeHandler;
  getInheritanceResolver(): InheritanceResolver;
  getEventEmitter(): EntityEventEmitter;
  getRelationLoader(): RelationLoader;
  getAggregateHandler(): AggregateQueryHandler;
  getDefaultQueryTimeout(): number | undefined;
  /** Warns once (per entity) when cursor pagination runs on a non-sortable PK. */
  warnIfNonSortablePk(entityName: string, pk: ColumnMetadata): void;
  /** Dialect-specific row-lock suffix (FOR UPDATE / FOR SHARE / NOWAIT / SKIP LOCKED). */
  resolveLockSuffix(lock: LockMode): string;
  getSynchronize(): boolean | "safe" | "dry-run";
  /**
   * Normalized synchronize policy. Always reflects the final, defaults-applied
   * shape regardless of whether the user passed a bare value or an options
   * object. Returns mode=false for an attached EM (#294) or unset config.
   */
  getSynchronizePolicy(): SynchronizePolicy;
  getDialect(): SchemaDialect;
  getSchema(): string | undefined;
  getConnection(): { query: (sql: any) => Promise<any> } | undefined;
  executeInTransaction<R>(
    fn: (session: TransactionSessionManager) => Promise<R>,
    existingSession?: TransactionSessionManager,
    readNodeOverride?: ReplicationNodeConfig | null,
  ): Promise<R>;
  executeReadOnly<R>(
    fn: (session: TransactionSessionManager) => Promise<R>,
    options?: {
      existingSession?: TransactionSessionManager;
      readNodeOverride?: ReplicationNodeConfig | null;
      timeout?: number;
    },
  ): Promise<R>;
  beginTrackQuery(): void;
  trackQuery(entityName: string, sql: string, ms: number): void;
  getReadNode(useMaster?: boolean): ReplicationNodeConfig | null;
  getEntities(): ClazzType<any>[];
  getNameStrategy<T>(clazz: ClazzType<T>): string;
  resolveSelectColumns<T>(select: ISelectOption<T>): string[];
  markDirty(entity: any): void;

  // ── Shared write-path helpers (used by WriteExecutor) ──────
  /** Resolves an entity property key from column metadata (propertyKey ?? name). */
  propKey(col: { propertyKey?: string; name?: string }): string;
  /** Applies the column's write transformer / JSON serialization to a raw value. */
  applyWriteTransform(col: ColumnMetadata, rawValue: any): any;
  /** Auto-injects the tenant-column value on INSERT under the "tenant_column" strategy. */
  applyTenantColumnOnInsert<T>(entity: ClazzType<T>, item: Partial<T>): void;
  /** Returns the set of @ComputedColumn names for an entity. */
  getComputedColumnNames<T>(entity: ClazzType<T>): Set<string>;
  /** Validates WHERE-criteria keys against the entity's known property/column set. */
  validateCriteriaKeys<T>(
    metadata: { target?: ClazzType<any>; columns: ColumnMetadata[] },
    criteria: WhereClause<T>,
    entityName: string,
  ): void;
  /** True if the entity has any eager-loaded @ManyToOne/@OneToOne relation. */
  hasEagerRelations<T>(entity: ClazzType<T>): boolean;
  /** True if a registered EntitySubscriber implements the given lifecycle method for the entity. */
  hasSubscriberFor<T>(
    entityClass: new (...args: any[]) => T,
    method: keyof EntitySubscriber<T>,
  ): boolean;
  /** Dispatches a lifecycle event to all registered EntitySubscriber instances. */
  notifySubscribers<T>(
    entityClass: new (...args: any[]) => T,
    method: keyof EntitySubscriber<T>,
    arg?: any,
  ): Promise<void>;

  /**
   * Builds the TypeScript-property → DB-column map for an entity, including
   * `@ManyToOne`/`@OneToOne` FK shadow properties (e.g. `workspaceId` →
   * `workspace_id`). Extracted handlers use this so their WHERE/field
   * resolution matches `findInternal` under a `NamingStrategy`; without it,
   * aggregate()/explain() emit raw camelCase property names verbatim.
   */
  buildPropertyToColumnMap(metadata: {
    target?: ClazzType<any>;
    columns: ColumnMetadata[];
  }): Map<string, string>;

  /**
   * Tenant-column strategy configuration. Returns null when strategy is not
   * `"tenant_column"`. Used by SchemaRegistrar to auto-inject the tenant column
   * into DDL and by query-building paths to inject WHERE predicates.
   */
  getTenantColumnConfig(): {
    name: string;
    type: "varchar" | "uuid" | "int" | "bigint";
    length?: number;
  } | null;

  /**
   * Builds a `tenant_id = ?` WHERE predicate for the given entity under the
   * `"tenant_column"` strategy, or null when no filter should be applied
   * (strategy inactive, `@NonTenantEntity`, unscoped context, or "public"
   * tenant). Extracted handlers call this to keep read/write paths tenant-
   * symmetric without re-implementing the resolution rules.
   *
   * @param entity             Entity class
   * @param tableAliasOrName   When provided, qualifies the column (for JOINs).
   */
  buildTenantWhereClause<T>(
    entity: ClazzType<T>,
    tableAliasOrName?: string,
  ): import("sql-template-tag").Sql | null;

  // For RelationLoader
  findInternal<T>(
    entity: ClazzType<T>,
    opt: FindOption<T>,
    session?: TransactionSessionManager,
  ): Promise<EntityResult<T>>;
  findOneInternal<T>(
    entity: ClazzType<T>,
    opt: FindOption<T>,
    session?: TransactionSessionManager,
  ): Promise<T | null>;

  // For CascadeHandler
  save<T>(
    entity: ClazzType<T>,
    item: Partial<T>,
  ): Promise<InstanceType<ClazzType<T>>>;
  saveWithSession<T>(
    entity: ClazzType<T>,
    item: Partial<T>,
    session: TransactionSessionManager,
  ): Promise<InstanceType<ClazzType<T>>>;
  find<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T>,
  ): Promise<T[]>;
  findOne<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T>,
  ): Promise<T | null>;
  findAndCount<T>(
    entity: ClazzType<T>,
    findOption: FindOption<T>,
  ): Promise<[T[], number]>;
  delete<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
  ): Promise<DeleteResult>;
}
