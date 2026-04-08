/**
 * 테넌트 프로비저닝 시 복제할 테이블을 필터링하는 옵션.
 *
 * 필터 적용 순서:
 * 1. `include`가 지정되면 해당 테이블만 후보로 선정 (미지정 시 전체)
 * 2. `includePrefix` / `includeSuffix`가 지정되면 추가로 좁힘
 * 3. `exclude`로 제외할 테이블 제거
 * 4. `excludePrefix` / `excludeSuffix`로 추가 제거
 */
export interface TenantTableFilterOptions {
  /**
   * 복제할 테이블 목록. 엔티티 클래스 또는 테이블명 문자열.
   * 지정하지 않으면 원본 스키마의 모든 테이블이 후보입니다.
   */
  include?: (string | Function)[];

  /**
   * 제외할 테이블 목록. 엔티티 클래스 또는 테이블명 문자열.
   */
  exclude?: (string | Function)[];

  /** 이 접두사로 시작하는 테이블만 포함 */
  includePrefix?: string[];

  /** 이 접미사로 끝나는 테이블만 포함 */
  includeSuffix?: string[];

  /** 이 접두사로 시작하는 테이블 제외 */
  excludePrefix?: string[];

  /** 이 접미사로 끝나는 테이블 제외 */
  excludeSuffix?: string[];
}

/**
 * 테넌트 마이그레이션 러너 옵션.
 */
export interface TenantMigrationRunnerOptions {
  /**
   * 테이블 구조를 복제할 원본 스키마/데이터베이스.
   * PostgreSQL: 기본값 "public"
   */
  sourceSchema?: string;

  /**
   * 복제할 테이블 필터링 옵션.
   * 지정하지 않으면 원본 스키마의 모든 테이블을 복제합니다.
   */
  tables?: TenantTableFilterOptions;
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
