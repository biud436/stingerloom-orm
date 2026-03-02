/**
 * 드라이버별 SQL 추상화 헬퍼
 *
 * MySQL과 PostgreSQL의 SQL 문법 차이를 추상화하여
 * 동일한 테스트 코드가 양쪽 드라이버에서 동작할 수 있도록 합니다.
 */

import type { TestDriverType } from "./driver-config";

// ─────────────────────────────────────────────────────────────────────────────
// 식별자 래핑
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 드라이버에 맞는 식별자 래핑을 반환합니다.
 * - MySQL: `name`
 * - PostgreSQL: "name"
 */
export function qi(driver: TestDriverType, name: string): string {
  return driver === "mysql" ? `\`${name}\`` : `"${name}"`;
}

// ─────────────────────────────────────────────────────────────────────────────
// DDL 헬퍼
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DROP TABLE IF EXISTS SQL을 반환합니다.
 * PostgreSQL은 CASCADE를 추가합니다.
 */
export function dropTableSql(
  driver: TestDriverType,
  tableName: string,
): string {
  if (driver === "postgres") {
    return `DROP TABLE IF EXISTS "${tableName}" CASCADE`;
  }
  return `DROP TABLE IF EXISTS \`${tableName}\``;
}

/**
 * FK 제약을 비활성화하는 SQL을 반환합니다.
 * - MySQL: SET FOREIGN_KEY_CHECKS = 0
 * - PostgreSQL: SET session_replication_role = 'replica'
 */
export function disableFkChecksSql(driver: TestDriverType): string {
  if (driver === "postgres") {
    return "SET session_replication_role = 'replica'";
  }
  return "SET FOREIGN_KEY_CHECKS = 0";
}

/**
 * FK 제약을 다시 활성화하는 SQL을 반환합니다.
 * - MySQL: SET FOREIGN_KEY_CHECKS = 1
 * - PostgreSQL: SET session_replication_role = 'origin'
 */
export function enableFkChecksSql(driver: TestDriverType): string {
  if (driver === "postgres") {
    return "SET session_replication_role = 'origin'";
  }
  return "SET FOREIGN_KEY_CHECKS = 1";
}

/**
 * M2M 중간 테이블 생성 DDL을 반환합니다.
 */
export function createJoinTableSql(
  driver: TestDriverType,
  joinTableName: string,
  col1: string,
  col2: string,
  ref1Table: string,
  ref1Col: string,
  ref2Table: string,
  ref2Col: string,
): string {
  const q = (name: string) => qi(driver, name);
  const intType = driver === "postgres" ? "INTEGER" : "INT";

  return `
    CREATE TABLE IF NOT EXISTS ${q(joinTableName)} (
      ${q(col1)} ${intType} NOT NULL,
      ${q(col2)} ${intType} NOT NULL,
      PRIMARY KEY (${q(col1)}, ${q(col2)}),
      FOREIGN KEY (${q(col1)}) REFERENCES ${q(ref1Table)}(${q(ref1Col)}) ON DELETE CASCADE,
      FOREIGN KEY (${q(col2)}) REFERENCES ${q(ref2Table)}(${q(ref2Col)}) ON DELETE CASCADE
    )
  `;
}

/**
 * UNIQUE INDEX 생성 DDL을 반환합니다.
 */
export function createUniqueIndexSql(
  driver: TestDriverType,
  indexName: string,
  tableName: string,
  columnName: string,
): string {
  const q = (name: string) => qi(driver, name);
  return `CREATE UNIQUE INDEX ${q(indexName)} ON ${q(tableName)} (${q(columnName)})`;
}

/**
 * SET autocommit SQL을 반환합니다.
 * - MySQL: SET autocommit = <value>
 * - PostgreSQL: null (불필요)
 */
export function setAutocommitSql(
  driver: TestDriverType,
  value: number,
): string | null {
  if (driver === "postgres") {
    return null;
  }
  return `SET autocommit = ${value}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 스키마 조회 헬퍼
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 테이블 존재 여부 확인 SQL을 반환합니다.
 * - MySQL: SHOW TABLES LIKE '...'
 * - PostgreSQL: pg_tables 쿼리
 */
export function hasTableSql(
  driver: TestDriverType,
  tableName: string,
): string {
  if (driver === "postgres") {
    return `SELECT tablename FROM pg_tables WHERE tablename = '${tableName}' AND schemaname = 'public'`;
  }
  return `SHOW TABLES LIKE '${tableName}'`;
}

/**
 * 테이블 컬럼 목록 조회 SQL을 반환합니다.
 * - MySQL: SHOW COLUMNS FROM `table`
 * - PostgreSQL: information_schema.columns 쿼리
 */
export function getColumnsSql(
  driver: TestDriverType,
  tableName: string,
): string {
  if (driver === "postgres") {
    return `SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_name = '${tableName}' AND table_schema = 'public'
            ORDER BY ordinal_position`;
  }
  return `SHOW COLUMNS FROM \`${tableName}\``;
}

/**
 * 특정 컬럼 정보 조회 SQL을 반환합니다.
 */
export function getColumnSql(
  driver: TestDriverType,
  tableName: string,
  columnName: string,
): string {
  if (driver === "postgres") {
    return `SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_name = '${tableName}' AND column_name = '${columnName}' AND table_schema = 'public'`;
  }
  return `SHOW COLUMNS FROM \`${tableName}\` WHERE Field = '${columnName}'`;
}

/**
 * 인덱스 목록 조회 SQL을 반환합니다.
 * - MySQL: SHOW INDEX FROM `table`
 * - PostgreSQL: pg_indexes 쿼리
 */
export function getIndexesSql(
  driver: TestDriverType,
  tableName: string,
): string {
  if (driver === "postgres") {
    return `SELECT indexname, indexdef FROM pg_indexes
            WHERE tablename = '${tableName}' AND schemaname = 'public'`;
  }
  return `SHOW INDEX FROM \`${tableName}\``;
}

/**
 * FK 제약 조회 SQL을 반환합니다.
 */
export function getForeignKeysSql(
  driver: TestDriverType,
  tableName: string,
): string {
  if (driver === "postgres") {
    return `
      SELECT
        kcu.constraint_name AS "CONSTRAINT_NAME",
        kcu.column_name AS "COLUMN_NAME",
        ccu.table_name AS "REFERENCED_TABLE_NAME",
        ccu.column_name AS "REFERENCED_COLUMN_NAME"
      FROM information_schema.key_column_usage kcu
      JOIN information_schema.table_constraints tc
        ON kcu.constraint_name = tc.constraint_name
        AND kcu.table_schema = tc.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE kcu.table_name = '${tableName}'
        AND tc.constraint_type = 'FOREIGN KEY'
        AND kcu.table_schema = 'public'
    `;
  }
  return `
    SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE TABLE_NAME = '${tableName}'
      AND REFERENCED_TABLE_NAME IS NOT NULL
      AND TABLE_SCHEMA = DATABASE()
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// 결과 정규화
// ─────────────────────────────────────────────────────────────────────────────

export interface NormalizedColumn {
  name: string;
  type: string;
  nullable: boolean;
  isPrimary: boolean;
  isAutoIncrement: boolean;
}

/**
 * 컬럼 조회 결과를 정규화합니다.
 */
export function normalizeColumns(
  driver: TestDriverType,
  rows: any[],
): NormalizedColumn[] {
  if (driver === "postgres") {
    return rows.map((r) => ({
      name: r.column_name,
      type: r.data_type,
      nullable: r.is_nullable === "YES",
      isPrimary: false, // PG에서는 별도 쿼리로 확인 필요
      isAutoIncrement: (r.column_default || "").includes("nextval"),
    }));
  }
  // MySQL
  return rows.map((r) => ({
    name: r.Field,
    type: r.Type,
    nullable: r.Null === "YES",
    isPrimary: r.Key === "PRI",
    isAutoIncrement: (r.Extra || "").includes("auto_increment"),
  }));
}

export interface NormalizedIndex {
  name: string;
  columnName?: string;
}

/**
 * 인덱스 조회 결과를 정규화합니다.
 */
export function normalizeIndexes(
  driver: TestDriverType,
  rows: any[],
): NormalizedIndex[] {
  if (driver === "postgres") {
    return rows.map((r) => ({
      name: r.indexname,
      columnName: undefined, // PG는 indexdef에서 파싱 가능하지만 필요하면 별도 처리
    }));
  }
  // MySQL
  return rows.map((r) => ({
    name: r.Key_name,
    columnName: r.Column_name,
  }));
}

export interface NormalizedForeignKey {
  constraintName: string;
  columnName: string;
  referencedTableName: string;
  referencedColumnName: string;
}

/**
 * FK 조회 결과를 정규화합니다.
 */
export function normalizeForeignKeys(
  _driver: TestDriverType,
  rows: any[],
): NormalizedForeignKey[] {
  // 양쪽 모두 같은 alias를 사용하도록 SQL을 작성했으므로 공통 처리
  return rows.map((r) => ({
    constraintName: r.CONSTRAINT_NAME,
    columnName: r.COLUMN_NAME,
    referencedTableName: r.REFERENCED_TABLE_NAME,
    referencedColumnName: r.REFERENCED_COLUMN_NAME,
  }));
}

/**
 * PG에서 PK 컬럼 목록을 조회하는 SQL을 반환합니다.
 * MySQL은 SHOW COLUMNS의 Key 필드로 확인 가능하므로 PG 전용.
 */
export function getPrimaryKeyColumnsSql(tableName: string): string {
  return `
    SELECT kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    WHERE tc.table_name = '${tableName}'
      AND tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_schema = 'public'
  `;
}
