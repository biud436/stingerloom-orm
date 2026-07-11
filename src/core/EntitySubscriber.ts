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
 *
 * `databaseEntity` is the snapshot of the row as it exists in the database
 * BEFORE the pending UPDATE is applied. Subscribers can diff it against
 * `entity` to compute column-level before/after deltas without issuing an
 * extra SELECT — the typical use case is a diff-based audit log.
 *
 * The pre-read is only performed when at least one subscriber for this
 * entity class implements `beforeUpdate` or `afterUpdate`, so saves on
 * entities without subscribers pay no extra cost. `databaseEntity` is
 * `null` when:
 *   - no subscriber requested it (no pre-read happened),
 *   - the row could not be located by primary key (e.g. concurrent delete),
 *   - the save was issued through a code path that does not support pre-reads
 *     (currently only `EntityManager.save()` populates this; raw
 *     `UpdateQueryBuilder.execute()` does not).
 */
export interface UpdateEvent<T> {
  entity: Partial<T>;
  databaseEntity: T | null;
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

  /**
   * Soft-delete / restore events. Like {@link beforeDelete}/{@link afterDelete}
   * these are criteria-based bulk operations, so they carry a
   * {@link DeleteEvent} (the target `entityClass` + `criteria`) rather than a
   * hydrated entity instance. They fire on `EntityManager.softDelete()` /
   * `restore()` only — the per-row `@DeletedAt` stamp applied by a plain
   * `save()`/`delete()` still goes through the insert/update/delete events.
   */
  beforeSoftDelete?(event: DeleteEvent<T>): void | Promise<void>;
  afterSoftDelete?(event: DeleteEvent<T>): void | Promise<void>;

  beforeRestore?(event: DeleteEvent<T>): void | Promise<void>;
  afterRestore?(event: DeleteEvent<T>): void | Promise<void>;

  beforeTransactionStart?(): void | Promise<void>;
  afterTransactionStart?(): void | Promise<void>;

  beforeTransactionCommit?(): void | Promise<void>;
  afterTransactionCommit?(): void | Promise<void>;

  beforeTransactionRollback?(): void | Promise<void>;
  afterTransactionRollback?(): void | Promise<void>;
}
