/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../utils";
import { ISqlDriver } from "../../dialects/SqlDriver";
import { EntityEventEmitter } from "../EntityEventEmitter";
import { EntitySubscriber } from "../EntitySubscriber";
import { TransactionSessionManager } from "../../dialects/TransactionSessionManager";
import type { EntityManager } from "../EntityManager";

/**
 * Curated API surface exposed to plugins during installation.
 *
 * This provides controlled access to EntityManager internals
 * without exposing raw `_ctx` (EntityManagerInternals).
 *
 * Plugins should use `context.em.save()` / `context.em.find()` etc.
 * for data operations to ensure hooks/events fire correctly.
 */
export interface PluginContext {
  /** The EntityManager instance this plugin is installed on */
  readonly em: EntityManager;

  /** The current SQL driver (undefined before connect()) */
  readonly driver: ISqlDriver | undefined;

  /** The entity event emitter for subscribing to lifecycle events */
  readonly events: EntityEventEmitter;

  /** The connection name of this EntityManager */
  readonly connectionName: string;

  /** Register an EntitySubscriber */
  addSubscriber(subscriber: EntitySubscriber<any>): void;

  /** Remove a previously registered EntitySubscriber */
  removeSubscriber(subscriber: EntitySubscriber<any>): void;

  /** Get all registered entity classes */
  getEntities(): ClazzType<any>[];

  /** Get another plugin's API by name */
  getPlugin<T = unknown>(name: string): T | undefined;

  /** Check if the current driver is MySQL/MariaDB */
  isMySqlFamily(): boolean;

  /** Check if the current driver is PostgreSQL */
  isPostgres(): boolean;

  /** Check if the current driver is SQLite */
  isSqlite(): boolean;

  /** Wrap an identifier with the driver's quoting style */
  wrap(identifier: string): string;

  /** Wrap a table name (with optional schema prefix) */
  wrapTable(tableName: string): string;

  /** Execute a callback within a transaction */
  executeInTransaction<R>(
    fn: (session: TransactionSessionManager) => Promise<R>,
  ): Promise<R>;

  /** Execute a callback within a read-only transaction */
  executeReadOnly<R>(
    fn: (session: TransactionSessionManager) => Promise<R>,
  ): Promise<R>;

  /** Get structured metadata for an entity class */
  getEntityMetadata<T>(entity: ClazzType<T>): any | null;

  /** Register a method name as a plugin placeholder */
  registerPlaceholder(name: string): void;
}
