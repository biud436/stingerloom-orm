/**
 * 통합 테스트용 데이터베이스 연결 유틸리티
 *
 * examples/nestjs-cats/.env 파일의 환경 변수를 기본값으로 사용하며,
 * 테스트별로 연결 옵션을 오버라이드할 수 있습니다.
 *
 * @example
 * ```ts
 * const { em, cleanup } = await createTestConnection();
 * // ... 테스트 수행
 * await cleanup();
 * ```
 */

import "reflect-metadata";
import * as path from "path";
import * as fs from "fs";
import Container from "typedi";
import { EntityManager } from "../../../src/core/EntityManager";
import { DatabaseClientOptions } from "../../../src/core/DatabaseClientOptions";
import { DatabaseClient } from "../../../src/DatabaseClient";
import { MetadataLayerRegistry } from "../../../src/scanner/MetadataScanner";

/**
 * .env 파일을 파싱하여 key=value 객체로 반환합니다.
 * dotenv 의존성 없이 가볍게 파싱합니다.
 */
function parseEnvFile(envPath: string): Record<string, string> {
  const result: Record<string, string> = {};

  if (!fs.existsSync(envPath)) {
    return result;
  }

  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    result[key] = value;
  }

  return result;
}

/**
 * examples/nestjs-cats/.env에서 기본 DB 연결 정보를 로드합니다.
 */
function loadDefaultEnv(): Record<string, string> {
  const envPath = path.resolve(__dirname, "../../../examples/nestjs-cats/.env");
  return parseEnvFile(envPath);
}

/**
 * 기본 DB 연결 옵션을 생성합니다.
 * .env 파일이 없으면 하드코딩된 기본값을 사용합니다.
 */
export function getDefaultConnectionOptions(): DatabaseClientOptions {
  const env = loadDefaultEnv();

  return {
    type: (env.DB_TYPE as DatabaseClientOptions["type"]) || "mysql",
    host: env.DB_HOST || "localhost",
    port: parseInt(env.DB_PORT || "3306", 10),
    username: env.DB_USER || "root",
    password: env.DB_PASSWORD || "password",
    database: env.DB_NAME || "stingerloom_test",
    synchronize: true,
    logging: false,
    entities: [],
  };
}

export interface TestConnectionResult {
  /** EntityManager 인스턴스 */
  em: EntityManager;
  /** 테스트 종료 시 호출하여 연결 해제 및 메타데이터 정리 */
  cleanup: () => Promise<void>;
  /** 연결 옵션 (참조용) */
  options: DatabaseClientOptions;
}

/**
 * 통합 테스트용 DB 연결을 생성합니다.
 *
 * - EntityManager를 초기화하고 DB에 연결합니다.
 * - `synchronize: true`이므로 엔티티 테이블이 자동으로 생성됩니다.
 * - `cleanup()`을 호출하면 연결을 종료하고 메타데이터를 리셋합니다.
 *
 * **주의:** 동적 엔티티를 사용하는 경우, `entityFactory`를 전달하여
 * 메타데이터 리셋 이후에 엔티티가 생성되도록 해야 합니다.
 *
 * @param overrides 기본 옵션을 오버라이드할 부분 옵션
 * @param entityFactory 메타데이터 리셋 후 호출되는 엔티티 생성 콜백. 반환된 엔티티 클래스 배열이 옵션에 추가됩니다.
 */
export async function createTestConnection(
  overrides?: Partial<DatabaseClientOptions>,
  entityFactory?: () => { entities: any[]; [key: string]: any },
): Promise<TestConnectionResult> {
  // 이전 상태 클린업 (싱글톤 재사용 대비)
  MetadataLayerRegistry.reset();
  Container.reset();

  // 리셋 이후에 엔티티 생성 (메타데이터가 초기화된 깨끗한 상태에서)
  let factoryResult: { entities: any[]; [key: string]: any } | undefined;
  if (entityFactory) {
    factoryResult = entityFactory();
  }

  const defaultOptions = getDefaultConnectionOptions();
  const options: DatabaseClientOptions = {
    ...defaultOptions,
    ...overrides,
    entities: [
      ...(overrides?.entities || []),
      ...(factoryResult?.entities || []),
    ],
  };

  const em = new EntityManager();
  await em.register(options);

  const cleanup = async () => {
    try {
      await DatabaseClient.getInstance().close();
    } catch {
      // 이미 닫혀있으면 무시
    }
    MetadataLayerRegistry.reset();
    Container.reset();
  };

  return { em, cleanup, options };
}

/**
 * 메타데이터를 수동으로 리셋합니다.
 * entityFactory 패턴 대신 직접 제어가 필요할 때 사용합니다.
 */
export function resetMetadata(): void {
  MetadataLayerRegistry.reset();
  Container.reset();
}

/**
 * 테스트 테이블을 DROP합니다.
 * afterAll에서 사용하여 테스트 테이블을 정리합니다.
 */
export async function dropTestTable(tableName: string): Promise<void> {
  const connector = DatabaseClient.getInstance().getConnection();

  try {
    await connector.query(`DROP TABLE IF EXISTS \`${tableName}\``);
  } catch {
    // 테이블이 없으면 무시
  }
}

/**
 * 테스트 테이블의 모든 데이터를 삭제합니다.
 * beforeEach에서 사용하여 테스트 간 데이터를 격리합니다.
 */
export async function truncateTestTable(tableName: string): Promise<void> {
  const connector = DatabaseClient.getInstance().getConnection();

  try {
    await connector.query(`DELETE FROM \`${tableName}\``);
    // AUTO_INCREMENT 리셋 (MySQL)
    await connector.query(`ALTER TABLE \`${tableName}\` AUTO_INCREMENT = 1`);
  } catch {
    // 테이블이 없으면 무시
  }
}

/**
 * 원시 SQL 쿼리를 실행합니다.
 * 테이블 생성, 삭제 등 드라이버를 통하지 않는 직접 쿼리에 사용합니다.
 */
export async function rawQuery(sql: string): Promise<any> {
  const connector = DatabaseClient.getInstance().getConnection();
  return connector.query(sql);
}
