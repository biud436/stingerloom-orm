/* eslint-disable @typescript-eslint/no-explicit-any */

import type { WhereClause } from "../dialects/FindOption";
import type { EntityManager } from "./EntityManager";

/**
 * Object passed to Insert events.
 */
export interface InsertEvent<T> {
  entity: Partial<T>;
  manager: EntityManager;
}

/**
 * Object passed to Update events.
 */
export interface UpdateEvent<T> {
  entity: Partial<T>;
  manager: EntityManager;
}

/**
 * Object passed to Delete events.
 */
export interface DeleteEvent<T> {
  entityClass: new (...args: any[]) => T;
  criteria: WhereClause<T>;
  manager: EntityManager;
}

/**
 * Subscriber interface for entity lifecycle events.
 *
 * Only events for the entity class returned by `listenTo()` are delivered.
 *
 * @example
 * ```ts
 * class UserSubscriber implements EntitySubscriber<User> {
 *   listenTo() { return User; }
 *   afterInsert(event: InsertEvent<User>) {
 *     console.log("User inserted:", event.entity);
 *   }
 * }
 *
 * em.addSubscriber(new UserSubscriber());
 * ```
 */
export interface EntitySubscriber<T = any> {
  listenTo(): new (...args: any[]) => T;

  afterLoad?(entity: T): void | Promise<void>;

  beforeInsert?(event: InsertEvent<T>): void | Promise<void>;
  afterInsert?(event: InsertEvent<T>): void | Promise<void>;

  beforeUpdate?(event: UpdateEvent<T>): void | Promise<void>;
  afterUpdate?(event: UpdateEvent<T>): void | Promise<void>;

  beforeDelete?(event: DeleteEvent<T>): void | Promise<void>;
  afterDelete?(event: DeleteEvent<T>): void | Promise<void>;

  beforeTransactionStart?(): void | Promise<void>;
  afterTransactionStart?(): void | Promise<void>;

  beforeTransactionCommit?(): void | Promise<void>;
  afterTransactionCommit?(): void | Promise<void>;

  beforeTransactionRollback?(): void | Promise<void>;
  afterTransactionRollback?(): void | Promise<void>;
}
