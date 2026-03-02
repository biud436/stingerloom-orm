/**
 * 듀얼 드라이버 테스트 설정
 *
 * MySQL과 PostgreSQL 양쪽에서 통합 테스트를 실행하기 위한
 * 드라이버별 연결 옵션을 제공합니다.
 *
 * 환경 변수로 특정 드라이버를 비활성화할 수 있습니다:
 *   INTEGRATION_TEST_MYSQL=false    → MySQL 테스트 비활성화
 *   INTEGRATION_TEST_POSTGRES=false → PostgreSQL 테스트 비활성화
 */

import { DatabaseClientOptions } from "../../../src/core/DatabaseClientOptions";

export type TestDriverType = "mysql" | "postgres";

export interface TestDriverConfig {
  /** 테스트 출력용 레이블 ("MySQL" | "PostgreSQL") */
  label: string;
  /** 드라이버 타입 */
  type: TestDriverType;
  /** createTestConnection에 전달할 연결 옵션 */
  options: Partial<DatabaseClientOptions>;
}

/**
 * 활성화된 테스트 드라이버 목록을 반환합니다.
 *
 * 기본적으로 MySQL과 PostgreSQL 모두 포함됩니다.
 * INTEGRATION_TEST_MYSQL=false 또는 INTEGRATION_TEST_POSTGRES=false로
 * 개별 드라이버를 비활성화할 수 있습니다.
 */
export function getTestDrivers(): TestDriverConfig[] {
  const drivers: TestDriverConfig[] = [];

  if (process.env.INTEGRATION_TEST_MYSQL !== "false") {
    drivers.push({
      label: "MySQL",
      type: "mysql",
      options: getMySqlConfig(),
    });
  }

  if (process.env.INTEGRATION_TEST_POSTGRES !== "false") {
    drivers.push({
      label: "PostgreSQL",
      type: "postgres",
      options: getPostgresConfig(),
    });
  }

  return drivers;
}

/**
 * MySQL 연결 옵션을 반환합니다.
 * 환경 변수 또는 기본값을 사용합니다.
 */
export function getMySqlConfig(): Partial<DatabaseClientOptions> {
  return {
    type: "mysql",
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "3306", 10),
    username: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "password",
    database: process.env.DB_NAME || "stingerloom_test",
  };
}

/**
 * PostgreSQL 연결 옵션을 반환합니다.
 * 환경 변수 또는 기본값을 사용합니다.
 */
export function getPostgresConfig(): Partial<DatabaseClientOptions> {
  return {
    type: "postgres",
    host: process.env.PG_HOST || "localhost",
    port: parseInt(process.env.PG_PORT || "5432", 10),
    username: process.env.PG_USER || "postgres",
    password: process.env.PG_PASSWORD || "postgres",
    database: process.env.PG_DATABASE || "multi_tenancy_db",
  };
}
