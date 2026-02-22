import {
  LayeredMetadataStore,
  LayeredEntityScanner,
  LayeredColumnScanner,
} from "../metadata";

/**
 * 멀티테넌트 메타데이터 매니저
 *
 * 멀티테넌트 환경에서 각 테넌트별로 독립적인 스키마를 관리할 수 있도록 지원
 */
export class MultiTenantMetadataManager {
  private store: LayeredMetadataStore;
  private entityScanner: LayeredEntityScanner;
  private columnScanner: LayeredColumnScanner;
  private currentTenant: string = "public";

  constructor() {
    this.store = new LayeredMetadataStore();
    this.entityScanner = new LayeredEntityScanner(this.store);
    this.columnScanner = new LayeredColumnScanner(this.store);
  }

  /**
   * 테넌트 전환
   */
  switchTenant(tenantId: string): void {
    this.currentTenant = tenantId;
    this.store.setContext(tenantId);
  }

  /**
   * 새 테넌트 생성 (public 스키마 복사)
   */
  createTenant(tenantId: string, copyFrom: string = "public"): void {
    try {
      this.store.copyLayer(copyFrom, tenantId);
      console.log(`Tenant "${tenantId}" created from "${copyFrom}"`);
    } catch (error) {
      console.error(`Failed to create tenant "${tenantId}":`, error);
      throw error;
    }
  }

  /**
   * 테넌트별 엔티티 메타데이터 등록
   */
  registerEntity(entityMetadata: any): void {
    const key = this.entityScanner.createUniqueKey();
    this.entityScanner.set(key, entityMetadata);
    console.log(
      `Entity registered in context "${this.currentTenant}": ${entityMetadata.name}`,
    );
  }

  /**
   * 테넌트별 컬럼 메타데이터 등록
   */
  registerColumn(columnMetadata: any): void {
    const key = this.columnScanner.createUniqueKey();
    this.columnScanner.set(key, columnMetadata);
  }

  /**
   * 현재 테넌트의 모든 엔티티 조회
   */
  getAllEntities(): any[] {
    return this.entityScanner.allMetadata();
  }

  /**
   * 특정 엔티티 조회 (병합된 뷰)
   */
  getEntity(target: any): any | null {
    return this.entityScanner.scan(target);
  }

  /**
   * 테넌트 스키마 병합 (테넌트의 변경사항을 public으로 승격)
   */
  promoteTenantSchemaToPublic(tenantId: string): void {
    this.store.mergeLayer(tenantId, "public");
    console.log(`Tenant "${tenantId}" schema promoted to public`);
  }

  /**
   * 테넌트 삭제
   */
  removeTenant(tenantId: string): void {
    if (tenantId === "public") {
      throw new Error('Cannot remove "public" tenant');
    }
    this.store.removeLayer(tenantId);
    console.log(`Tenant "${tenantId}" removed`);
  }

  /**
   * 모든 레이어 정보 조회
   */
  getLayersInfo() {
    return this.store.getLayersInfo();
  }

  /**
   * 현재 테넌트 정보
   */
  getCurrentTenant(): string {
    return this.currentTenant;
  }

  /**
   * EntityScanner 가져오기 (기존 코드 호환)
   */
  getEntityScanner(): LayeredEntityScanner {
    return this.entityScanner;
  }

  /**
   * ColumnScanner 가져오기 (기존 코드 호환)
   */
  getColumnScanner(): LayeredColumnScanner {
    return this.columnScanner;
  }

  /**
   * 내부 스토어 가져오기
   */
  getStore(): LayeredMetadataStore {
    return this.store;
  }
}

// ──────────────────────────────────────────────────────────────
// 전역 싱글톤 (deprecated)
//
// 레이어드 메타데이터 원칙에 따르면 전역 싱글톤이 아닌
// 레이어 기반으로 격리되어야 합니다.
// 새 코드에서는 MultiTenantMetadataManager를 직접 인스턴스화하거나,
// MetadataContext + EntityManager.withTenant()를 사용하세요.
// ──────────────────────────────────────────────────────────────

let globalMetadataManager: MultiTenantMetadataManager | null = null;

/**
 * 전역 메타데이터 매니저 가져오기
 *
 * @deprecated 전역 싱글톤 사용은 레이어드 메타데이터 원칙에 위배됩니다.
 * 대신 MultiTenantMetadataManager를 직접 생성하거나,
 * MetadataContext + EntityManager.withTenant()를 사용하세요.
 */
export function getGlobalMetadataManager(): MultiTenantMetadataManager {
  if (!globalMetadataManager) {
    globalMetadataManager = new MultiTenantMetadataManager();
  }
  return globalMetadataManager;
}

/**
 * 전역 메타데이터 매니저 재설정 (테스트용)
 *
 * @deprecated getGlobalMetadataManager()와 함께 제거 예정
 */
export function resetGlobalMetadataManager(): void {
  globalMetadataManager = null;
}
