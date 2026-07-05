/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../utils";
import type { EntitySubscriber } from "../EntitySubscriber";

/**
 * Owns the `EntitySubscriber` list and its notification dispatch, extracted
 * from EntityManager.
 *
 * The facade keeps thin delegators (`addSubscriber` / `notifySubscribers` /
 * `emitAfterLoad` / ...) plus a live `em.subscribers` accessor, because tests
 * assert on the array directly and reassign `em.notifySubscribers` on the
 * instance — executors must keep routing through the facade for those
 * interceptions to take effect.
 *
 * @internal Package-internal — not a public API.
 */
export class SubscriberRegistry {
  /** The registered subscribers. Exposed as the same array instance via `em.subscribers`. */
  readonly subscribers: EntitySubscriber<any>[] = [];

  add(subscriber: EntitySubscriber<any>): void {
    // Idempotent registration: the same subscriber instance must not fire
    // twice. NestJS subscribers self-register in onModuleInit against the
    // singleton EntityManager, so a module re-init (test re-bootstrap, HMR,
    // or sharing one connection across modules) would otherwise double-register
    // and emit duplicate notifications/audit rows.
    if (this.subscribers.includes(subscriber)) return;
    this.subscribers.push(subscriber);
  }

  remove(subscriber: EntitySubscriber<any>): void {
    const idx = this.subscribers.indexOf(subscriber);
    if (idx !== -1) {
      this.subscribers.splice(idx, 1);
    }
  }

  /** Removes every registered subscriber (propagateShutdown path). */
  clear(): void {
    this.subscribers.length = 0;
  }

  async notify<T>(
    entityClass: new (...args: any[]) => T,
    method: keyof EntitySubscriber<T>,
    arg?: any,
  ): Promise<void> {
    for (const sub of this.subscribers) {
      if (sub.listenTo() === entityClass && typeof sub[method] === "function") {
        await (sub[method] as Function)(arg);
      }
    }
  }

  /**
   * True iff any registered subscriber for `entityClass` implements `method`.
   * Used to skip the `databaseEntity` pre-read on entities where no
   * subscriber actually wants the snapshot.
   */
  hasSubscriberFor<T>(
    entityClass: new (...args: any[]) => T,
    method: keyof EntitySubscriber<T>,
  ): boolean {
    for (const sub of this.subscribers) {
      if (sub.listenTo() === entityClass && typeof sub[method] === "function") {
        return true;
      }
    }
    return false;
  }

  async notifyTransaction(method: keyof EntitySubscriber<any>): Promise<void> {
    for (const sub of this.subscribers) {
      if (typeof sub[method] === "function") {
        await (sub[method] as Function)();
      }
    }
  }

  /**
   * #371: fires `afterLoad` subscribers for entities loaded outside the
   * find/findOne paths (SelectQueryBuilder getMany/getOne entity results).
   * Mirrors the find-path notification: one call per entity, keyed by the
   * requested entity class. Raw/partial reads must not call this.
   *
   * `notify` is injected so the dispatch keeps routing through the facade's
   * `notifySubscribers` — tests reassign that method on the EM instance.
   */
  async emitAfterLoad<T>(
    entityClass: ClazzType<T>,
    entities: T | T[] | null | undefined,
    notify: (
      entityClass: new (...args: any[]) => T,
      method: keyof EntitySubscriber<T>,
      arg?: any,
    ) => Promise<void>,
  ): Promise<void> {
    if (!entities) return;
    const list = Array.isArray(entities) ? entities : [entities];
    for (const loadedEntity of list) {
      if (loadedEntity == null) continue;
      await notify(entityClass as any, "afterLoad", loadedEntity);
    }
  }
}
