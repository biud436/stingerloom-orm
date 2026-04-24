/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../utils";
import { ISqlDriver } from "../dialects/SqlDriver";
import { TransactionSessionManager } from "../dialects/TransactionSessionManager";
import { FindOption, WhereClause } from "../dialects/FindOption";
import { ReplicationNodeConfig } from "../dialects/ReplicationRouter";
import { DeleteResult } from "../types/DeleteResult";
import { EntityResult } from "../types/EntityResult";
import { ISelectOption } from "../dialects/ISelectOption";
import { SchemaDialect } from "./generators/SchemaGenerator";

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
  isSqlite?(): boolean;
  getDriver(): ISqlDriver | undefined;
  getSynchronize(): boolean | "safe" | "dry-run";
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
  delete<T>(
    entity: ClazzType<T>,
    criteria: WhereClause<T>,
  ): Promise<DeleteResult>;
}
