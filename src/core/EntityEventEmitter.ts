/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * EntityManager 이벤트 타입.
 * 엔티티 생명주기에 따라 발행되는 이벤트입니다.
 */
export type EntityEventType =
  | "beforeInsert"
  | "afterInsert"
  | "beforeUpdate"
  | "afterUpdate"
  | "beforeDelete"
  | "afterDelete";

/**
 * 이벤트 리스너에 전달되는 페이로드.
 */
export interface EntityEventPayload<T = any> {
  entity: new (...args: any[]) => T;
  data: Partial<T> | Record<string, unknown>;
}

export type EntityEventListener<T = any> = (
  payload: EntityEventPayload<T>,
) => void | Promise<void>;

/**
 * EntityManager에서 발행하는 이벤트를 구독할 수 있는 EventEmitter.
 *
 * 사용 예시:
 * ```ts
 * em.on("beforeInsert", (payload) => {
 *   console.log("Inserting:", payload.entity.name, payload.data);
 * });
 * ```
 */
export class EntityEventEmitter {
  private listeners = new Map<EntityEventType, Set<EntityEventListener>>();

  /**
   * 지정된 이벤트에 리스너를 등록합니다.
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
   * 지정된 이벤트에서 리스너를 제거합니다.
   */
  off(event: EntityEventType, listener: EntityEventListener): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(listener);
    }
  }

  /**
   * 지정된 이벤트를 발행하여 등록된 모든 리스너를 호출합니다.
   * 비동기 리스너는 순차적으로 await됩니다.
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
   * 모든 이벤트 리스너를 제거합니다.
   */
  removeAllListeners(): void {
    this.listeners.clear();
  }
}
