/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * EntityManager event type.
 * Events emitted according to the entity lifecycle.
 */
export type EntityEventType =
  | "beforeInsert"
  | "afterInsert"
  | "beforeUpdate"
  | "afterUpdate"
  | "beforeDelete"
  | "afterDelete"
  | "beforeSoftDelete"
  | "afterSoftDelete"
  | "beforeRestore"
  | "afterRestore";

/**
 * Payload passed to event listeners.
 */
export interface EntityEventPayload<T = any> {
  entity: new (...args: any[]) => T;
  data: Partial<T> | Record<string, unknown>;
}

export type EntityEventListener<T = any> = (
  payload: EntityEventPayload<T>,
) => void | Promise<void>;

/**
 * EventEmitter that lets callers subscribe to EntityManager events.
 *
 * Example:
 * ```ts
 * em.on("beforeInsert", (payload) => {
 *   console.log("Inserting:", payload.entity.name, payload.data);
 * });
 * ```
 */
export class EntityEventEmitter {
  private listeners = new Map<EntityEventType, Set<EntityEventListener>>();

  /**
   * Register a listener for the given event.
   */
  on(event: EntityEventType, listener: EntityEventListener): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  /**
   * Remove a listener from the given event.
   */
  off(event: EntityEventType, listener: EntityEventListener): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(listener);
    }
  }

  /**
   * Emit the given event and invoke every registered listener.
   * Async listeners are awaited sequentially.
   */
  async emit<T = any>(
    event: EntityEventType,
    payload: EntityEventPayload<T>,
  ): Promise<void> {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;

    for (const listener of set) {
      await listener(payload);
    }
  }

  /**
   * Remove every registered event listener.
   */
  removeAllListeners(): void {
    this.listeners.clear();
  }
}
