/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Proxy 기반 지연 로딩 유틸리티.
 *
 * ManyToOne 관계에서 `lazy: true` 옵션이 설정된 필드에 대해,
 * 실제 프로퍼티에 접근할 때까지 DB 쿼리를 지연시킵니다.
 *
 * 내부적으로 ES Proxy를 사용하여 프로퍼티 접근을 가로채고,
 * 첫 번째 접근 시 `loadFn`을 호출하여 관계 엔티티를 로드합니다.
 */

export type LazyLoadFn<T> = () => Promise<T | undefined>;

const LAZY_MARKER = Symbol.for("STG_LAZY_PROXY");

/**
 * 지연 로딩 Proxy를 생성합니다.
 *
 * @param loadFn 관계 엔티티를 로드하는 비동기 함수
 * @returns 프로퍼티 접근 시 자동으로 로드되는 Proxy 객체
 */
export function createLazyProxy<T extends object>(
  loadFn: LazyLoadFn<T>,
): T {
  let loaded = false;
  let cachedValue: T | undefined;
  let loadPromise: Promise<T | undefined> | null = null;

  const handler: ProxyHandler<object> = {
    get(_target, prop, receiver) {
      // 마커 심볼로 lazy proxy 여부 확인
      if (prop === LAZY_MARKER) {
        return true;
      }

      // then/catch 접근은 트랩하지 않음 (await 시 thenable로 인식되는 것을 방지)
      if (prop === "then" || prop === "catch" || prop === "finally") {
        return undefined;
      }

      // 이미 로드되었으면 캐시된 값에서 반환
      if (loaded && cachedValue !== undefined) {
        return Reflect.get(cachedValue as object, prop, receiver);
      }

      // 로드 중이면 기존 프로미스 반환을 위한 프로미스 체인
      if (!loadPromise) {
        loadPromise = loadFn().then((result) => {
          loaded = true;
          cachedValue = result;
          loadPromise = null;
          return result;
        });
      }

      // 동기적 접근 시에는 undefined 반환 (비동기 로드가 완료되기 전)
      // 비동기적으로 사용하려면 load() 호출 후 접근해야 함
      return undefined;
    },

    has(_target, prop) {
      if (prop === LAZY_MARKER) return true;
      if (loaded && cachedValue !== undefined) {
        return prop in (cachedValue as object);
      }
      return false;
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Proxy({} as any, handler) as T;
}

/**
 * 지연 로딩 Proxy를 로드하고 실제 엔티티를 반환합니다.
 *
 * @param proxy createLazyProxy로 생성된 Proxy 객체
 * @param loadFn 관계 엔티티를 로드하는 비동기 함수
 * @returns 로드된 관계 엔티티
 */
export async function loadLazy<T extends object>(
  loadFn: LazyLoadFn<T>,
): Promise<T | undefined> {
  return loadFn();
}

/**
 * 주어진 객체가 LazyLoader Proxy인지 확인합니다.
 */
export function isLazyProxy(obj: unknown): boolean {
  if (obj === null || obj === undefined) return false;
  if (typeof obj !== "object") return false;
  try {
    return (obj as any)[LAZY_MARKER] === true;
  } catch {
    return false;
  }
}

/**
 * 엔티티의 특정 프로퍼티에 lazy proxy를 주입합니다.
 *
 * @param entity 대상 엔티티 인스턴스
 * @param propertyName lazy proxy를 설정할 프로퍼티명
 * @param loadFn 관계 엔티티를 로드하는 비동기 함수
 */
export function injectLazyProxy<T extends object, R extends object>(
  entity: T,
  propertyName: string,
  loadFn: LazyLoadFn<R>,
): void {
  let loaded = false;
  let cachedValue: R | undefined;

  Object.defineProperty(entity, propertyName, {
    configurable: true,
    enumerable: true,
    get(): R | Promise<R | undefined> | undefined {
      if (loaded) {
        return cachedValue;
      }
      // 비동기로 로드 후 캐시
      const promise = loadFn().then((result) => {
        loaded = true;
        cachedValue = result;
        // getter를 실제 값으로 교체
        Object.defineProperty(entity, propertyName, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: result,
        });
        return result;
      });
      return promise;
    },
    set(value: R) {
      loaded = true;
      cachedValue = value;
      // setter 호출 시 일반 프로퍼티로 전환
      Object.defineProperty(entity, propertyName, {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
      });
    },
  });
}
