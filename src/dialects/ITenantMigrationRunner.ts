/**
 * 테넌트 마이그레이션 러너 옵션.
 */
export interface TenantMigrationRunnerOptions {
  /**
   * 테이블 구조를 복제할 원본 스키마/데이터베이스.
   * PostgreSQL: 기본값 "public"
   */
  sourceSchema?: string;
}

/**
 * syncTenantSchemas()의 반환 결과.
 */
export interface TenantSyncResult {
  /** 새로 생성된 테넌트 목록 */
  created: string[];
  /** 이미 존재하여 건너뛴 테넌트 목록 */
  skipped: string[];
}

/**
 * ITenantMigrationRunner
 *
 * 멀티테넌시 환경에서 테넌트별 스키마/데이터베이스를 프로비저닝하기 위한
 * 공통 인터페이스입니다.
 *
 * - PostgreSQL: 스키마 기반 격리 (CREATE SCHEMA + LIKE ... INCLUDING ALL)
 * - MySQL/SQLite: 미지원 (UnsupportedError throw)
 */
export interface ITenantMigrationRunner {
  /**
   * 데이터베이스에 존재하는 모든 테넌트(스키마/데이터베이스) 목록을 반환합니다.
   */
  discoverSchemas(): Promise<string[]>;

  /**
   * 단일 테넌트를 프로비저닝합니다.
   * 이미 프로비저닝된 경우 no-op입니다.
   */
  ensureSchema(tenantId: string): Promise<void>;

  /**
   * 주어진 테넌트 ID 목록에 대해 일괄 프로비저닝합니다.
   * 이미 존재하는 테넌트는 건너뜁니다.
   */
  syncTenantSchemas(tenantIds: string[]): Promise<TenantSyncResult>;

  /**
   * 특정 테넌트가 프로비저닝되었는지 확인합니다.
   */
  isProvisioned(tenantId: string): boolean;

  /**
   * 프로비저닝된 모든 테넌트 이름을 반환합니다.
   */
  getProvisionedSchemas(): string[];

  /**
   * 내부 프로비저닝 상태를 초기화합니다.
   */
  reset(): void;
}
