/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { join, raw } from "sql-template-tag";
import { IConnector } from "../../core/IConnector";
import { MysqlSchemaInterface } from "../mysql/BaseSchema";
import { ColumnOption, ColumnType } from "../../decorators";
import { ISqlDriver } from "../SqlDriver";
import { Exception } from "../../errors";
import { SchemaOptions } from "../../types/SchemaOption";

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

  constructor(
    private readonly connector: IConnector,
    private readonly clientType: string = "postgres",
    schema?: string,
  ) {
    this.schema = schema ?? "public";
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
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name = '${name}'`,
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
      `SELECT tablename FROM pg_tables WHERE schemaname = '${name}' ORDER BY tablename`,
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
      `ALTER TABLE ${this.wrap(tableName)} SET SCHEMA ${this.wrap(targetSchema)}`,
    );
  }

  /**
   * 테이블이 존재하는지 확인합니다.
   */
  hasTable(name: string) {
    return this.connector.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = '${this.schema}' AND tablename = '${name}'`,
    );
  }

  /**
   * 테이블에 기본키를 추가합니다.
   */
  addPrimaryKey(tableName: string, columnName: string) {
    return this.connector.query(
      `ALTER TABLE ${this.wrap(tableName)} ADD PRIMARY KEY (${this.wrap(columnName)})`,
    );
  }

  /**
   * 테이블에 자동 증가를 추가합니다.
   * PostgreSQL에서는 SERIAL 타입 또는 GENERATED ALWAYS AS IDENTITY를 사용합니다.
   */
  addAutoIncrement(tableName: string, columnName: string) {
    return this.connector.query(
      `ALTER TABLE ${this.wrap(tableName)} ALTER COLUMN ${this.wrap(columnName)} ADD GENERATED ALWAYS AS IDENTITY`,
    );
  }

  /**
   * 테이블의 기본키를 제거합니다.
   */
  dropPrimaryKey(tableName: string) {
    return this.connector.query(
      `ALTER TABLE ${this.wrap(tableName)} DROP CONSTRAINT ${tableName}_pkey`,
    );
  }

  /**
   * 테이블에 유니크 키를 추가합니다.
   */
  addUniqueKey(tableName: string, columnName: string) {
    return this.connector.query(
      `ALTER TABLE ${this.wrap(tableName)} ADD UNIQUE (${this.wrap(columnName)})`,
    );
  }

  /**
   * 테이블의 유니크 키를 제거합니다.
   */
  dropUniqueKey(tableName: string, columnName: string) {
    const constraintName = `${tableName}_${columnName}_key`;
    return this.connector.query(
      `ALTER TABLE ${this.wrap(tableName)} DROP CONSTRAINT ${constraintName}`,
    );
  }

  /**
   * 테이블에 컬럼을 추가합니다.
   */
  addColumn(tableName: string, columnName: string, columnType: string) {
    return this.connector.query(
      `ALTER TABLE ${this.wrap(tableName)} ADD COLUMN ${this.wrap(columnName)} ${columnType}`,
    );
  }

  /**
   * 테이블의 컬럼을 제거합니다.
   */
  dropColumn(tableName: string, columnName: string) {
    return this.connector.query(
      `ALTER TABLE ${this.wrap(tableName)} DROP COLUMN ${this.wrap(columnName)}`,
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
      `ALTER TABLE ${this.wrap(tableName)} ADD CONSTRAINT ${foreignKeyName} FOREIGN KEY (${this.wrap(columnName)}) REFERENCES ${this.wrap(foreignTableName)}(${this.wrap(foreignColumnName)}) ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  /**
   * 외래키 이름을 생성합니다.
   */
  generateForeignKeyName(
    sourceTable: string,
    targetTable: string,
    sourceColumn: string,
  ): string {
    return `fk_${sourceTable}_${targetTable}_${sourceColumn}`;
  }

  /**
   * 외래키를 제거합니다.
   */
  dropForeignKey(tableName: string, columnName: string) {
    return this.connector.query(
      `ALTER TABLE ${this.wrap(tableName)} DROP CONSTRAINT ${this.wrap(columnName)}`,
    );
  }

  /**
   * 인덱스를 추가합니다.
   */
  addIndex(tableName: string, columnName: string, indexName: string) {
    return this.connector.query(
      `CREATE INDEX ${indexName} ON ${this.wrap(tableName)} (${this.wrap(columnName)})`,
    );
  }

  /**
   * 인덱스 존재 여부를 확인합니다.
   */
  hasIndex(tableName: string, indexName: string) {
    return this.connector.query(
      `SELECT COUNT(*) as count FROM pg_indexes WHERE tablename = '${tableName}' AND indexname = '${indexName}'`,
    );
  }

  /**
   * 인덱스를 제거합니다.
   */
  dropIndex(tableName: string, indexName: string) {
    return this.connector.query(`DROP INDEX IF EXISTS ${indexName}`);
  }

  /**
   * 스키마를 가져옵니다 (information_schema 기반).
   * MySQL 호환 형식(MysqlSchemaInterface)으로 반환합니다.
   */
  getSchemas(tableName: string): Promise<MysqlSchemaInterface[]> {
    return this.connector.query(
      `SELECT
        column_name AS "Field",
        data_type AS "Type",
        is_nullable AS "Null",
        CASE
          WHEN column_name IN (
            SELECT kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
            WHERE tc.table_name = '${tableName}' AND tc.constraint_type = 'PRIMARY KEY'
          ) THEN 'PRI'
          ELSE ''
        END AS "Key",
        column_default AS "Default",
        CASE
          WHEN column_default LIKE 'nextval%' THEN 'auto_increment'
          ELSE ''
        END AS "Extra"
      FROM information_schema.columns
      WHERE table_schema = '${this.schema}' AND table_name = '${tableName}'
      ORDER BY ordinal_position`,
    );
  }

  /**
   * 인덱스를 가져옵니다.
   */
  getIndexes(tableName: string): Promise<MysqlSchemaInterface[]> {
    return this.connector.query(
      `SELECT indexname AS "Field", indexdef AS "Type", '' AS "Null", 'MUL' AS "Key", NULL AS "Default", '' AS "Extra"
       FROM pg_indexes WHERE tablename = '${tableName}'`,
    );
  }

  /**
   * 외래키를 가져옵니다.
   */
  getForeignKeys(tableName: string): Promise<MysqlSchemaInterface[]> {
    return this.connector.query(
      `SELECT
        kcu.column_name AS "COLUMN_NAME",
        ccu.table_name AS "REFERENCED_TABLE_NAME",
        ccu.column_name AS "REFERENCED_COLUMN_NAME"
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name = '${tableName}'`,
    );
  }

  /**
   * 기본키를 가져옵니다.
   */
  getPrimaryKeys(tableName: string): Promise<MysqlSchemaInterface[]> {
    return this.connector.query(
      `SELECT kcu.column_name AS "COLUMN_NAME"
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
       WHERE tc.constraint_type = 'PRIMARY KEY'
         AND tc.table_name = '${tableName}'`,
    );
  }

  /**
   * 테이블을 생성합니다.
   */
  createTable(tableName: string, columns: SchemaOptions[]) {
    const columnsMap = columns.map((column) => {
      // column.options가 없을 경우 기본값 제공
      const option = (column.options ?? {
        type: "varchar",
        length: 255,
        nullable: false,
      }) as ColumnOption;

      let type = this.castType(option.type ?? "varchar");

      // BOOLEAN 타입은 PostgreSQL 네이티브 BOOLEAN 사용
      if (option.type === "boolean") {
        type = "BOOLEAN";
      }

      // DECIMAL 타입의 경우, precision과 scale을 설정합니다.
      if (type.startsWith("NUMERIC")) {
        if (option.precision !== undefined && option.precision > 1000) {
          throw new Exception(
            "PostgreSQL에서 지원하는 NUMERIC 타입의 precision은 1000 이하입니다.",
            400,
          );
        }

        type = type.replace("$precision", option.precision?.toString() || "10");
        type = type.replace("$scale", option.scale?.toString() || "2");
      }

      const nullable = option.nullable ?? false;

      // auto_increment → SERIAL (PRIMARY KEY와 함께)
      if (option.autoIncrement) {
        return raw(
          `"${column.name}" SERIAL ${nullable ? "NULL" : "NOT NULL"} ${option.primary ? "PRIMARY KEY" : ""}`,
        );
      }

      // 길이가 있는 타입 (VARCHAR 등)
      const needsLength = ["VARCHAR", "CHAR"].some((t) =>
        type.toUpperCase().startsWith(t),
      );

      const typeWithLength =
        needsLength && option.length ? `${type}(${option.length})` : type;

      return raw(
        `"${column.name}" ${typeWithLength} ${nullable ? "NULL" : "NOT NULL"} ${option.primary ? "PRIMARY KEY" : ""}`,
      );
    });

    const result = sql`CREATE TABLE IF NOT EXISTS ${raw(this.wrap(tableName))} (${join(
      columnsMap,
      ",",
    )})`;

    return this.connector.query(result.text);
  }

  /**
   * 식별자를 큰따옴표로 감싸서 반환합니다 (PostgreSQL 표준).
   */
  wrap(columnName: string) {
    return `"${columnName}"`;
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
   */
  castType(type: ColumnType): string {
    switch (type) {
      case "varchar":
        return "VARCHAR";
      case "int":
      case "number":
        return "INTEGER";
      case "boolean":
        return "BOOLEAN";
      case "datetime":
        return "TIMESTAMP";
      case "date":
        return "DATE";
      case "timestamp":
        return "TIMESTAMP";
      case "float":
        return "REAL";
      case "double":
        return "NUMERIC($precision, $scale)";
      case "blob":
        return "BYTEA";
      case "text":
      case "longtext": // PostgreSQL에서는 TEXT로 통합
        return "TEXT";
      case "bigint":
        return "BIGINT";
      case "json":
        return "JSON";
      case "jsonb":
        return "JSONB";
      case "char":
        return "CHAR";
      case "enum":
        return "TEXT"; // PostgreSQL은 ENUM 타입이 별도를 요구하므록c TEXT 사용
      case "array":
        return "ARRAY";
      default:
        return type as string;
    }
  }

  public isMySqlFamily() {
    return false;
  }

  /**
   * 비관적 잠금을 위한 SQL을 반환합니다.
   *
   * PostgreSQL은 FOR UPDATE NOWAIT를 지원합니다.
   */
  getForUpdateNoWait(): string {
    return " FOR UPDATE NOWAIT";
  }
}
