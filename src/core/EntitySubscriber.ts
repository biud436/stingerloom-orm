/* eslint-disable @typescript-eslint/no-explicit-any */

import type { WhereClause } from "../dialects/FindOption";
import type { EntityManager } from "./EntityManager";

/**
 * Insert 이벤트에 전달되는 객체입니다.
 */
export interface InsertEvent<T> {
  entity: Partial<T>;
  manager: EntityManager;
}

/**
 * Update 이벤트에 전달되는 객체입니다.
 */
export interface UpdateEvent<T> {
  entity: Partial<T>;
  manager: EntityManager;
}

/**
 * Delete 이벤트에 전달되는 객체입니다.
 */
export interface DeleteEvent<T> {
  entityClass: new (...args: any[]) => T;
  criteria: WhereClause<T>;
  manager: EntityManager;
}

/**
 * 엔티티 생명주기 이벤트를 구독할 수 있는 Subscriber 인터페이스입니다.
 *
 * `listenTo()`가 반환하는 엔티티 클래스에 해당하는 이벤트만 전달됩니다.
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
