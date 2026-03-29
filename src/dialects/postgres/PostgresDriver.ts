/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { join, raw, Sql } from "sql-template-tag";
import { IConnector } from "../../core/IConnector";
import { MysqlSchemaInterface } from "../mysql/BaseSchema";
import { ColumnOption, ColumnType } from "../../decorators";
import { ISqlDriver } from "../SqlDriver";
import { Exception } from "../../errors";
import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";
import { Logger } from "../../utils";
import { SchemaOptions } from "../../types/SchemaOption";
import { SchemaGenerator } from "../../core/generators/SchemaGenerator";
import { validateSavepointName } from "../../utils/validateSavepointName";
import { PostgresColumnDefinitionBuilder } from "./PostgresColumnDefinitionBuilder";
import type { DriverQueryOptions } from "../../types/DriverQueryOptions";
import type { PostgresConnector } from "./PostgresConnector";

/**
 * Escape an enum value for safe interpolation into DDL strings.
 * Rejects null bytes and escapes backslashes + single quotes.
 */
function escapeEnumValue(val: string): string {
  if (val.includes('\0')) {
    throw new OrmError(OrmErrorCode.VALIDATION_ERROR, `Enum value contains null byte`);
  }
  return val.replace(/\\/g, '\\\\').replace(/'/g, "''");
}

/**
 * PostgreSQL용 SQL 드라이버 구현체입니다.
 * PostgreSQL의 DDL/DML 구문에 맞게 쿼리를 생성합니다.
 *
 * PostgreSQL은 database → schema → table 3계층 구조를 가집니다.
 * MySQL/MariaDB와 달리 하나의 데이터베이스 안에 여러 스키마를 가질 수 있으며,
 * 각 스키마는 독립된 네임스페이스로 동작합니다.
 */
export class PostgresDriver implements ISqlDriver {
  private readonly schema: string;
  private readonly logger = new Logger("PostgresDriver");
  private readonly columnDefBuilder: PostgresColumnDefinitionBuilder;

  constructor(
    private readonly connector: IConnector,
    private readonly clientType: string = "postgres",
    schema?: string,
  ) {
    this.schema = schema ?? "public";
    this.columnDefBuilder = new PostgresColumnDefinitionBuilder(this.schema);
  }

  // ──────────────────────────────────────────────
  // Schema 관리 메서드 (PostgreSQL 전용)
  // ──────────────────────────────────────────────

  /**
   * 현재 사용 중인 스키마 이름을 반환합니다.
   */
  getSchema(): string {
    return this.schema;
  }

  /**
   * 지정된 스키마가 존재하는지 확인합니다.
   *
   * @param schemaName - 확인할 스키마 이름
   * @returns 스키마 존재 여부 결과
   */
  hasSchema(schemaName?: string): Promise<any> {
    const name = schemaName ?? this.schema;
    return this.connector.query(
      sql`SELECT schema_name FROM information_schema.schemata WHERE schema_name = ${name}`,
    );
  }

  /**
   * 새로운 스키마를 생성합니다.
   * IF NOT EXISTS를 사용하여 이미 존재하는 경우에는 무시합니다.
   *
   * @param schemaName - 생성할 스키마 이름
   */
  createSchema(schemaName?: string): Promise<any> {
    const name = schemaName ?? this.schema;
    return this.connector.query(
      `CREATE SCHEMA IF NOT EXISTS ${this.wrap(name)}`,
    );
  }

  /**
   * 스키마를 삭제합니다.
   * CASCADE 옵션을 사용하여 스키마 내의 모든 오브젝트도 함께 삭제합니다.
   *
   * @param schemaName - 삭제할 스키마 이름
   * @param cascade - true이면 스키마 내 모든 오브젝트도 함께 삭제 (기본값: false)
   */
  dropSchema(schemaName: string, cascade: boolean = false): Promise<any> {
    const suffix = cascade ? " CASCADE" : "";
    return this.connector.query(
      `DROP SCHEMA IF EXISTS ${this.wrap(schemaName)}${suffix}`,
    );
  }

  /**
   * 데이터베이스에 존재하는 모든 사용자 정의 스키마 목록을 반환합니다.
   * 시스템 스키마(pg_*, information_schema)는 제외됩니다.
   */
  listSchemas(): Promise<any> {
    return this.connector.query(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT LIKE 'pg_%'
         AND schema_name != 'information_schema'
       ORDER BY schema_name`,
    );
  }

  /**
   * 현재 커넥션의 search_path를 변경합니다.
   *
   * @param schemaName - 설정할 스키마 이름
   */
  setSearchPath(schemaName?: string): Promise<any> {
    const name = schemaName ?? this.schema;
    return this.connector.query(`SET search_path TO ${this.wrap(name)}`);
  }

  /**
   * 스키마 내 모든 테이블 목록을 반환합니다.
   *
   * @param schemaName - 조회할 스키마 이름 (기본값: 현재 스키마)
   */
  listTables(schemaName?: string): Promise<any> {
    const name = schemaName ?? this.schema;
    return this.connector.query(
      sql`SELECT tablename FROM pg_tables WHERE schemaname = ${name} ORDER BY tablename`,
    );
  }

  /**
   * 테이블을 다른 스키마로 이동합니다.
   *
   * @param tableName - 이동할 테이블 이름
   * @param targetSchema - 이동할 대상 스키마 이름
   */
  moveTableToSchema(tableName: string, targetSchema: string): Promise<any> {
    return this.connector.query(
      `ALTER TABLE ${this.wrapQualified(tableName)} SET SCHEMA ${this.wrap(targetSchema)}`,
    );
  }

  /**
   * 테이블이 존재하는지 확인합니다.
   */
  hasTable(name: string) {
    return this.connector.query(
      sql`SELECT tablename FROM pg_tables WHERE schemaname = ${this.schema} AND tablename = ${name}`,
    );
  }

  executeRaw(sqlStr: string) {
    return this.connector.query(sqlStr);
  }

  async queryWithOptions(query: Sql, options: DriverQueryOptions): Promise<any[]> {
    const pgConnector = this.connector as PostgresConnector;
    if (!pgConnector.pool) {
      throw new OrmError(
        OrmErrorCode.CONNECTION_FAILED,
        "No pool available for queryWithOptions",
        "Ensure the database is connected before using the raw pipeline",
      );
    }

    let paramIndex = 0;
    const pgSql = query.sql.replace(/\?/g, () => `$${++paramIndex}`);

    const queryConfig: any = {
      text: pgSql,
      values: query.values,
    };
    if (options.binary) queryConfig.binary = true;
    if (options.arrayMode) queryConfig.rowMode = "array";

    const result: any = await pgConnector.pool.query(queryConfig);
    return result.rows;
  }

  /**
   * 테이블에 기본키를 추가합니다.
   */
  addPrimaryKey(tableName: string, columnName: string) {
    return this.connector.query(
      `ALTER TABLE ${this.wrapQualified(tableName)} ADD PRIMARY KEY (${this.wrap(columnName)})`,
    );
  }

  /**
   * 테이블에 자동 증가를 추가합니다.
   * PostgreSQL에서는 SERIAL 타입 또는 GENERATED ALWAYS AS IDENTITY를 사용합니다.
   */
  addAutoIncrement(tableName: string, columnName: string) {
    return this.connector.query(
      `ALTER TABLE ${this.wrapQualified(tableName)} ALTER COLUMN ${this.wrap(columnName)} ADD GENERATED ALWAYS AS IDENTITY`,
    );
  }

  /**
   * 테이블의 기본키를 제거합니다.
   *
   * pg_constraint 카탈로그에서 실제 제약조건 이름을 조회한 뒤 제거합니다.
   * 기본 명명규칙(table_pkey)에 의존하지 않으므로 마이그레이션·명명전략에 안전합니다.
   */
  async dropPrimaryKey(tableName: string): Promise<any> {
    const rows: Array<{ conname: string }> = await this.connector.query(
      sql`SELECT c.conname
          FROM pg_constraint c
          JOIN pg_class t      ON c.conrelid      = t.oid
          JOIN pg_namespace n  ON t.relnamespace  = n.oid
          WHERE c.contype = 'p'
            AND t.relname  = ${tableName}
            AND n.nspname  = ${this.schema}`,
    );

    if (!rows || rows.length === 0) {
      throw new Exception(
        `테이블 "${tableName}"에서 PRIMARY KEY 제약조건을 찾을 수 없습니다.`,
        404,
      );
    }

    const constraintName = rows[0].conname;
    return this.connector.query(
      `ALTER TABLE ${this.wrapQualified(tableName)} DROP CONSTRAINT ${this.wrap(constraintName)}`,
    );
  }

  /**
   * 테이블에 유니크 키를 추가합니다.
   */
  addUniqueKey(tableName: string, columnName: string) {
    return this.connector.query(
      `ALTER TABLE ${this.wrapQualified(tableName)} ADD UNIQUE (${this.wrap(columnName)})`,
    );
  }

  /**
   * 테이블의 유니크 키를 제거합니다.
   *
   * pg_constraint 카탈로그에서 해당 컬럼을 포함하는 UNIQUE 제약조건의 실제 이름을
   * 조회한 뒤 제거합니다. 복합 UNIQUE·커스텀 명명전략에도 올바르게 동작합니다.
   */
  async dropUniqueKey(tableName: string, columnName: string): Promise<any> {
    const rows: Array<{ conname: string }> = await this.connector.query(
      sql`SELECT c.conname
          FROM pg_constraint c
          JOIN pg_class t      ON c.conrelid      = t.oid
          JOIN pg_namespace n  ON t.relnamespace  = n.oid
          JOIN pg_attribute a  ON a.attrelid = t.oid
                              AND a.attnum   = ANY(c.conkey)
          WHERE c.contype = 'u'
            AND t.relname  = ${tableName}
            AND n.nspname  = ${this.schema}
            AND a.attname  = ${columnName}`,
    );

    if (!rows || rows.length === 0) {
      throw new Exception(
        `테이블 "${tableName}"의 컬럼 "${columnName}"에 대한 UNIQUE 제약조건을 찾을 수 없습니다.`,
        404,
      );
    }

    const constraintName = rows[0].conname;
    return this.connector.query(
      `ALTER TABLE ${this.wrapQualified(tableName)} DROP CONSTRAINT ${this.wrap(constraintName)}`,
    );
  }

  /**
   * 테이블에 컬럼을 추가합니다.
   */
  addColumn(tableName: string, columnName: string, columnType: string) {
    return this.connector.query(
      `ALTER TABLE ${this.wrapQualified(tableName)} ADD COLUMN ${this.wrap(columnName)} ${columnType}`,
    );
  }

  /**
   * 테이블의 컬럼을 제거합니다.
   */
  dropColumn(tableName: string, columnName: string) {
    return this.connector.query(
      `ALTER TABLE ${this.wrapQualified(tableName)} DROP COLUMN ${this.wrap(columnName)}`,
    );
  }

  /**
   * 외래키를 추가합니다.
   */
  addForeignKey(
    tableName: string,
    columnName: string,
    foreignTableName: string,
    foreignColumnName: string,
  ) {
    const foreignKeyName = this.generateForeignKeyName(
      tableName,
      foreignTableName,
      columnName,
    );

    return this.connector.query(
      `ALTER TABLE ${this.wrapQualified(tableName)} ADD CONSTRAINT ${foreignKeyName} FOREIGN KEY (${this.wrap(columnName)}) REFERENCES ${this.wrapQualified(foreignTableName)}(${this.wrap(foreignColumnName)}) ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  /**
   * 외래키 이름을 생성합니다.
   * SHA1 해시 기반으로 고유한 이름을 생성하여 이름 충돌과 길이 제한을 방지합니다.
   */
  generateForeignKeyName(
    sourceTable: string,
    targetTable: string,
    sourceColumn: string,
  ): string {
    return SchemaGenerator.generateForeignKeyName(sourceTable, sourceColumn, targetTable);
  }

  /**
   * 외래키를 제거합니다.
   *
   * pg_constraint 카탈로그에서 해당 컬럼을 참조하는 FOREIGN KEY 제약조건의 실제 이름을
   * 조회한 뒤 제거합니다. FK 제약조건 이름은 컬럼명이 아니므로 카탈로그 조회가 필수입니다.
   */
  async dropForeignKey(tableName: string, columnName: string): Promise<any> {
    const rows: Array<{ conname: string }> = await this.connector.query(
      sql`SELECT c.conname
          FROM pg_constraint c
          JOIN pg_class t      ON c.conrelid      = t.oid
          JOIN pg_namespace n  ON t.relnamespace  = n.oid
          JOIN pg_attribute a  ON a.attrelid = t.oid
                              AND a.attnum   = ANY(c.conkey)
          WHERE c.contype = 'f'
            AND t.relname  = ${tableName}
            AND n.nspname  = ${this.schema}
            AND a.attname  = ${columnName}`,
    );

    if (!rows || rows.length === 0) {
      throw new Exception(
        `테이블 "${tableName}"의 컬럼 "${columnName}"에 대한 FOREIGN KEY 제약조건을 찾을 수 없습니다.`,
        404,
      );
    }

    const constraintName = rows[0].conname;
    return this.connector.query(
      `ALTER TABLE ${this.wrapQualified(tableName)} DROP CONSTRAINT ${this.wrap(constraintName)}`,
    );
  }

  /**
   * 인덱스를 추가합니다.
   */
  addIndex(tableName: string, columnName: string, indexName: string) {
    return this.connector.query(
      `CREATE INDEX ${this.wrap(indexName)} ON ${this.wrapQualified(tableName)} (${this.wrap(columnName)})`,
    );
  }

  /**
   * 인덱스 존재 여부를 확인합니다.
   */
  hasIndex(tableName: string, indexName: string) {
    return this.connector.query(
      sql`SELECT COUNT(*) as count FROM pg_indexes WHERE tablename = ${tableName} AND indexname = ${indexName}`,
    );
  }

  /**
   * 인덱스를 제거합니다.
   */
  dropIndex(tableName: string, indexName: string) {
    // PostgreSQL 인덱스는 스키마에 속합니다. schema-qualified 형식으로 명시합니다.
    return this.connector.query(
      `DROP INDEX IF EXISTS ${this.wrapQualified(indexName)}`,
    );
  }

  // ──────────────────────────────────────────────
  // Enum 타입 관리 메서드 (PostgreSQL 전용)
  // ──────────────────────────────────────────────

  /**
   * 사용자 정의 ENUM 타입이 존재하는지 확인합니다.
   *
   * @param enumName - 확인할 ENUM 타입 이름
   */
  hasEnumType(enumName: string): Promise<any> {
    // pg_namespace join으로 현재 스키마 범위 내에서만 조회합니다.
    return this.connector.query(
      sql`SELECT pg_type.typname
          FROM pg_type
          JOIN pg_namespace ON pg_type.typnamespace = pg_namespace.oid
          WHERE pg_type.typname = ${enumName}
            AND pg_type.typtype = 'e'
            AND pg_namespace.nspname = ${this.schema}`,
    );
  }

  /**
   * 새로운 사용자 정의 ENUM 타입을 생성합니다.
   * 이미 존재하는 경우에는 생성을 건너뜁니다.
   *
   * @param enumName - 생성할 ENUM 타입 이름
   * @param values   - ENUM에 포함될 값 목록
   *
   * @example
   * await driver.createEnumType("user_role", ["admin", "user", "guest"]);
   * // → CREATE TYPE "user_role" AS ENUM ('admin', 'user', 'guest')
   */
  async createEnumType(enumName: string, values: string[]): Promise<any> {
    const rows: any[] = await this.hasEnumType(enumName);
    if (rows && rows.length > 0) {
      // Enum already exists — check for missing values and add them
      const existingRows: any[] = await this.connector.query(
        sql`SELECT e.enumlabel
            FROM pg_enum e
            JOIN pg_type t ON e.enumtypid = t.oid
            JOIN pg_namespace n ON t.typnamespace = n.oid
            WHERE t.typname = ${enumName}
              AND n.nspname = ${this.schema}`,
      );
      const existingValues = new Set(existingRows.map((r) => r.enumlabel));

      for (const val of values) {
        if (!existingValues.has(val)) {
          const escaped = escapeEnumValue(val);
          await this.connector.query(
            `ALTER TYPE ${this.wrapQualified(enumName)} ADD VALUE IF NOT EXISTS '${escaped}'`,
          );
        }
      }

      // Warn about values in DB but not in entity definition
      for (const existing of existingValues) {
        if (!values.includes(existing)) {
          this.logger.warn(
            `Enum "${enumName}" has DB value "${existing}" not present in entity definition`,
          );
        }
      }

      return;
    }

    const escapedValues = values
      .map((v) => `'${escapeEnumValue(v)}'`)
      .join(", ");

    return this.connector.query(
      `CREATE TYPE ${this.wrapQualified(enumName)} AS ENUM (${escapedValues})`,
    );
  }

  /**
   * 사용자 정의 ENUM 타입을 삭제합니다.
   *
   * @param enumName - 삭제할 ENUM 타입 이름
   * @param cascade  - true이면 해당 ENUM 타입을 참조하는 컬럼도 함께 삭제 (기본값: false)
   */
  dropEnumType(enumName: string, cascade: boolean = false): Promise<any> {
    const suffix = cascade ? " CASCADE" : "";
    return this.connector.query(
      `DROP TYPE IF EXISTS ${this.wrapQualified(enumName)}${suffix}`,
    );
  }

  /**
   * 기존 ENUM 타입에 새 값을 추가합니다.
   * PostgreSQL 9.1 이상에서 지원됩니다.
   *
   * @param enumName  - 대상 ENUM 타입 이름
   * @param value     - 추가할 값
   * @param placement - 삽입 위치 옵션 (선택)
   *
   * @example
   * // 마지막에 추가
   * await driver.addEnumValue("user_role", "moderator");
   *
   * // 특정 값 앞에 삽입
   * await driver.addEnumValue("user_role", "moderator", { before: "guest" });
   *
   * // 특정 값 뒤에 삽입
   * await driver.addEnumValue("user_role", "moderator", { after: "user" });
   */
  addEnumValue(
    enumName: string,
    value: string,
    placement?: { before?: string; after?: string },
  ): Promise<any> {
    const escaped = `'${escapeEnumValue(value)}'`;
    let suffix = "";

    if (placement?.before) {
      suffix = ` BEFORE '${escapeEnumValue(placement.before)}'`;
    } else if (placement?.after) {
      suffix = ` AFTER '${escapeEnumValue(placement.after)}'`;
    }

    return this.connector.query(
      `ALTER TYPE ${this.wrapQualified(enumName)} ADD VALUE IF NOT EXISTS ${escaped}${suffix}`,
    );
  }

  /**
   * ENUM 타입의 기존 값을 다른 이름으로 변경합니다.
   * PostgreSQL 10 이상에서 지원됩니다.
   *
   * @param enumName - 대상 ENUM 타입 이름
   * @param oldValue - 변경할 현재 값
   * @param newValue - 새로운 값
   */
  renameEnumValue(
    enumName: string,
    oldValue: string,
    newValue: string,
  ): Promise<any> {
    return this.connector.query(
      `ALTER TYPE ${this.wrapQualified(enumName)} RENAME VALUE '${escapeEnumValue(oldValue)}' TO '${escapeEnumValue(newValue)}'`,
    );
  }

  /**
   * ENUM 타입에 속한 모든 값 목록을 반환합니다.
   *
   * @param enumName - 조회할 ENUM 타입 이름
   * @returns `{ enumlabel: string }` 배열
   */
  listEnumValues(enumName: string): Promise<{ enumlabel: string }[]> {
    return this.connector.query(
      sql`SELECT e.enumlabel
       FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = ${enumName}
       ORDER BY e.enumsortorder`,
    );
  }

  /**
   * 스키마를 가져옵니다 (information_schema 기반).
   * MySQL 호환 형식(MysqlSchemaInterface)으로 반환합니다.
   */
  getSchemas(tableName: string): Promise<MysqlSchemaInterface[]> {
    return this.connector.query(
      sql`SELECT
        column_name AS "Field",
        data_type AS "Type",
        is_nullable AS "Null",
        CASE
          WHEN column_name IN (
            SELECT kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
            WHERE tc.table_name = ${tableName} AND tc.constraint_type = 'PRIMARY KEY'
          ) THEN 'PRI'
          ELSE ''
        END AS "Key",
        column_default AS "Default",
        CASE
          WHEN column_default LIKE 'nextval%' THEN 'auto_increment'
          ELSE ''
        END AS "Extra"
      FROM information_schema.columns
      WHERE table_schema = ${this.schema} AND table_name = ${tableName}
      ORDER BY ordinal_position`,
    );
  }

  /**
   * 인덱스를 가져옵니다.
   */
  getIndexes(tableName: string): Promise<MysqlSchemaInterface[]> {
    return this.connector.query(
      sql`SELECT indexname AS "Field", indexdef AS "Type", '' AS "Null", 'MUL' AS "Key", NULL AS "Default", '' AS "Extra"
       FROM pg_indexes WHERE schemaname = ${this.schema} AND tablename = ${tableName}`,
    );
  }

  /**
   * 외래키를 가져옵니다.
   */
  getForeignKeys(tableName: string): Promise<MysqlSchemaInterface[]> {
    return this.connector.query(
      sql`SELECT
        kcu.column_name AS "COLUMN_NAME",
        ccu.table_name AS "REFERENCED_TABLE_NAME",
        ccu.column_name AS "REFERENCED_COLUMN_NAME"
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = ${this.schema}
        AND tc.table_name = ${tableName}`,
    );
  }

  /**
   * 기본키를 가져옵니다.
   */
  getPrimaryKeys(tableName: string): Promise<MysqlSchemaInterface[]> {
    return this.connector.query(
      sql`SELECT kcu.column_name AS "COLUMN_NAME"
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
       WHERE tc.constraint_type = 'PRIMARY KEY'
         AND tc.table_schema = ${this.schema}
         AND tc.table_name = ${tableName}`,
    );
  }

  /**
   * 테이블을 생성합니다.
   */
  createTable(tableName: string, columns: SchemaOptions[]) {
    const columnsMap = columns.map((column) => {
      const option = (column.options ?? this.columnDefBuilder.defaultColumnOption) as ColumnOption;
      return raw(
        this.columnDefBuilder.buildColumnDef(option, {
          columnName: column.name!,
          tableName,
        }),
      );
    });

    const result = sql`CREATE TABLE IF NOT EXISTS ${raw(this.wrapQualified(tableName))} (${join(
      columnsMap,
      ",",
    )})`;

    return this.connector.query(result);
  }

  /**
   * 식별자를 큰따옴표로 감싸서 반환합니다 (PostgreSQL 표준).
   * 내부에 포함된 `"` 문자는 PostgreSQL 표준인 `""` 으로 이스케이프합니다.
   */
  wrap(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  /**
   * 식별자를 `"schema"."name"` 형식으로 반환합니다.
   * search_path에 의존하지 않고 항상 스키마를 명시하므로
   * 커넥션 풀 재사용·멀티테넌트 환경에서도 안전합니다.
   */
  wrapQualified(name: string): string {
    return `${this.wrap(this.schema)}.${this.wrap(name)}`;
  }

  /**
   * TS 타입으로부터 데이터베이스 컬럼 타입을 추론합니다.
   */
  getColumnType(type: any): string {
    switch (type) {
      case String:
        return "VARCHAR";
      case Number:
        return "INTEGER";
      case Boolean:
        return "BOOLEAN";
      case Date:
        return "TIMESTAMP";
      case Buffer:
        return "BYTEA";
      default:
        return "TEXT";
    }
  }

  /**
   * ColumnType을 데이터베이스 컬럼 타입으로 변환합니다.
   *
   * ## PostgreSQL 타입 매핑
   * | ColumnType | PostgreSQL Type                |
   * |------------|--------------------------------|
   * | varchar    | VARCHAR                        |
   * | int        | INTEGER                        |
   * | number     | INTEGER                        |
   * | boolean    | BOOLEAN (네이티브)              |
   * | datetime   | TIMESTAMP                      |
   * | date       | DATE                           |
   * | timestamp  | TIMESTAMP                      |
   * | float      | REAL                           |
   * | double     | NUMERIC(precision, scale)      |
   * | blob       | BYTEA                          |
   * | text       | TEXT                           |
   * | longtext   | TEXT                           |
   * | bigint     | BIGINT                         |
   * | json       | JSON                           |
   * | jsonb      | JSONB                          |
   * | array      | ARRAY                          |
   * | enum       | 사용자 정의 ENUM 타입           |
   *              | (enumName 옵션 → `"enumName"`) |
   *              | enumName 없을 때 폴백 → TEXT   |
   */
  castType(type: ColumnType): string {
    return this.columnDefBuilder.castType(type);
  }

  public isMySqlFamily() {
    return false;
  }

  setQueryTimeout(ms: number): string {
    return `SET LOCAL statement_timeout = '${Math.max(0, Math.floor(ms))}ms'`;
  }

  supportsExplain(): boolean {
    return true;
  }

  buildExplainSql(selectSql: string): string {
    return `EXPLAIN (FORMAT JSON) ${selectSql}`;
  }

  buildUpsertSql(
    tableName: string,
    columns: string[],
    conflictColumns: string[],
    updateColumns: string[],
  ): string {
    const columnList = columns.map((c) => this.wrap(c)).join(", ");
    const valuePlaceholders = columns
      .map((_, i) => `$${i + 1}`)
      .join(", ");
    const conflictList = conflictColumns.map((c) => this.wrap(c)).join(", ");
    const updateSet = updateColumns
      .map((col) => `${this.wrap(col)} = EXCLUDED.${this.wrap(col)}`)
      .join(", ");

    return `INSERT INTO ${this.wrap(tableName)} (${columnList}) VALUES (${valuePlaceholders}) ON CONFLICT (${conflictList}) DO UPDATE SET ${updateSet}`;
  }

  async hasColumn(tableName: string, columnName: string): Promise<boolean> {
    const rows: any[] = await this.connector.query(
      sql`SELECT column_name FROM information_schema.columns WHERE table_schema = ${this.schema} AND table_name = ${tableName} AND column_name = ${columnName}`,
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  async hasForeignKey(tableName: string, constraintName: string): Promise<boolean> {
    const rows: any[] = await this.connector.query(
      sql`SELECT constraint_name FROM information_schema.table_constraints WHERE table_schema = ${this.schema} AND table_name = ${tableName} AND constraint_name = ${constraintName} AND constraint_type = 'FOREIGN KEY'`,
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  addCompositeUniqueIndex(
    tableName: string,
    columns: string[],
    indexName: string,
  ) {
    const columnList = columns.map((col) => this.wrap(col)).join(", ");
    return this.connector.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${this.wrap(indexName)} ON ${this.wrapQualified(tableName)} (${columnList})`,
    );
  }

  async acquireAdvisoryLock(lockId: string, timeoutMs: number = 0): Promise<boolean> {
    // Convert string lockId to a numeric hash for pg_advisory_lock
    const hash = this.hashLockId(lockId);

    if (timeoutMs <= 0) {
      // Try to acquire without waiting
      const result: any = await this.connector.query(
        sql`SELECT pg_try_advisory_lock(${hash}) AS lock_result`,
      );
      const rows = Array.isArray(result) ? result : result?.rows ?? [];
      if (rows.length === 0) return false;
      return rows[0]?.lock_result === true;
    }

    // Use a single dedicated connection so SET and the lock query share the same session
    const client = await this.connector.getConnection();
    try {
      const savedTimeout = await this.connector.query(
        `SHOW statement_timeout`,
        client,
      );

      const timeoutValue = `${Math.floor(timeoutMs)}ms`;
      await this.connector.query(
        sql`SET statement_timeout = ${timeoutValue}`,
        client,
      );

      try {
        await this.connector.query(
          sql`SELECT pg_advisory_lock(${hash})`,
          client,
        );
        return true;
      } catch {
        return false;
      } finally {
        // Restore original timeout on the same connection
        const rows = Array.isArray(savedTimeout) ? savedTimeout : savedTimeout?.rows ?? [];
        const original = rows.length > 0 ? rows[0]?.statement_timeout ?? "0" : "0";
        await this.connector.query(
          sql`SET statement_timeout = ${original}`,
          client,
        );
      }
    } finally {
      client.release();
    }
  }

  async releaseAdvisoryLock(lockId: string): Promise<void> {
    const hash = this.hashLockId(lockId);
    await this.connector.query(
      sql`SELECT pg_advisory_unlock(${hash})`,
    );
  }

  private hashLockId(lockId: string): number {
    let hash = 0;
    for (let i = 0; i < lockId.length; i++) {
      const char = lockId.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return hash;
  }

  createSavepointSql(name: string): string {
    validateSavepointName(name);
    return `SAVEPOINT ${this.wrap(name)}`;
  }

  rollbackToSavepointSql(name: string): string {
    validateSavepointName(name);
    return `ROLLBACK TO SAVEPOINT ${this.wrap(name)}`;
  }

  releaseSavepointSql(name: string): string {
    validateSavepointName(name);
    return `RELEASE SAVEPOINT ${this.wrap(name)}`;
  }

  /**
   * 테이블의 모든 데이터를 제거합니다 (TRUNCATE ... RESTART IDENTITY CASCADE).
   * CASCADE: FK 참조 테이블도 함께 truncate합니다.
   * RESTART IDENTITY: 시퀀스를 초기화합니다.
   */
  clear(tableName: string) {
    return this.connector.query(
      `TRUNCATE TABLE ${this.wrapQualified(tableName)} RESTART IDENTITY CASCADE`,
    );
  }

  /**
   * 비관적 잠금을 위한 SQL을 반환합니다.
   *
   * PostgreSQL은 FOR UPDATE NOWAIT를 지원합니다.
   */
  getForUpdateNoWait(): string {
    return " FOR UPDATE NOWAIT";
  }

  supportsReturning(): boolean {
    return true;
  }
}
