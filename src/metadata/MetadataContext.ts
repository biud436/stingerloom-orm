import { AsyncLocalStorage } from "async_hooks";

/**
 * 요청 스코프 메타데이터 컨텍스트
 *
 * AsyncLocalStorage를 사용하여 각 요청(또는 비동기 실행 단위)마다
 * 독립적인 tenantId를 유지합니다.
 *
 * NestJS Middleware, Express middleware, 또는 수동 호출을 통해
 * 컨텍스트를 설정할 수 있습니다.
 *
 * @example
 * ```ts
 * // Middleware에서 자동 설정
 * MetadataContext.run("tenant_1", async () => {
 *   // 이 블록 안의 모든 메타데이터 조회는 tenant_1 컨텍스트
 *   await entityManager.find(User, { where: { id: 1 } });
 * });
 *
 * // 현재 컨텍스트 조회 (없으면 "public" 반환)
 * const tenant = MetadataContext.getCurrentTenant();
 * ```
 */
export class MetadataContext {
  private static storage = new AsyncLocalStorage<MetadataContextStore>();

  /**
   * 주어진 tenantId 컨텍스트 내에서 콜백을 실행합니다.
   * 콜백 내부의 모든 비동기 호출에서 동일한 tenantId가 유지됩니다.
   *
   * @param tenantId 테넌트 식별자 (예: "tenant_1")
   * @param callback 실행할 비동기 작업
   * @returns 콜백의 반환값
   */
  static run<T>(
    tenantId: string,
    callback: () => T | Promise<T>,
  ): T | Promise<T> {
    const store: MetadataContextStore = { tenantId };
    return this.storage.run(store, callback);
  }

  /**
   * 현재 비동기 컨텍스트의 tenantId를 반환합니다.
   * AsyncLocalStorage에 컨텍스트가 없으면 "public"을 반환합니다.
   */
  static getCurrentTenant(): string {
    const store = this.storage.getStore();
    return store?.tenantId ?? "public";
  }

  /**
   * AsyncLocalStorage 컨텍스트가 활성화되어 있는지 확인합니다.
   */
  static isActive(): boolean {
    const store = this.storage.getStore();
    const isActive = store !== undefined;
    return isActive;
  }

  /**
   * 테스트 등에서 내부 storage를 재생성합니다.
   */
  static reset(): void {
    this.storage = new AsyncLocalStorage<MetadataContextStore>();
  }
}

/**
 * AsyncLocalStorage에 저장되는 컨텍스트 데이터
 */
export interface MetadataContextStore {
  tenantId: string;
}
