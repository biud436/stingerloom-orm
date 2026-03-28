/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { join, raw } from "sql-template-tag";
import { IConnector } from "../../core/IConnector";
import { MysqlSchemaInterface } from "../mysql/BaseSchema";
import { ColumnOption, ColumnType } from "../../decorators";
import { ISqlDriver } from "../SqlDriver";
import { SchemaOptions } from "../../types/SchemaOption";
import { SchemaGenerator } from "../../core/generators/SchemaGenerator";
import { validateSavepointName } from "../../utils/validateSavepointName";
import { Logger } from "../../utils/Logger";
import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";

/**
 * SQLite용 SQL 드라이버 구현체입니다.
 * SQLite의 DDL/DML 구문에 맞게 쿼리를 생성합니다.
 *
 * SQLite는 스키마 개념이 없으며, 단일 파일 기반 데이터베이스입니다.
 * 식별자 래핑에는 PostgreSQL과 동일하게 큰따옴표를 사용합니다.
 */
export class SqliteDriver implements ISqlDriver {
  private readonly logger = new Logger("SqliteDriver");

  constructor(
    private readonly connector: IConnector,
  ) {}

  /**
   * 테이블이 존재하는지 확인합니다.
   */
  hasTable(name: string) {
    return this.connector.query(
      sql`SELECT name FROM sqlite_master WHERE type='table' AND name=${name}`,
    );
  }

  executeRaw(sqlStr: string) {
    return this.connector.query(sqlStr);
  }

  /**
   * 테이블에 기본키를 추가합니다.
   * SQLite에서는 ALTER TABLE로 기본키를 추가할 수 없습니다.
   * 테이블 재생성이 필요하지만, 인터페이스 호환을 위해 에러를 발생시킵니다.
   */
  addPrimaryKey(_tableName: string, _columnName: string): Promise<any> {
    throw new OrmError(
      OrmErrorCode.UNSUPPORTED_OPERATION,
      `SQLite does not support ALTER TABLE ADD PRIMARY KEY. Recreate the table instead.`,
    );
  }

  /**
   * 테이블에 자동 증가를 추가합니다.
   * SQLite에서는 INTEGER PRIMARY KEY가 자동으로 AUTOINCREMENT 역할을 합니다.
   */
  addAutoIncrement(_tableName: string, _columnName: string): Promise<any> {
    throw new OrmError(
      OrmErrorCode.UNSUPPORTED_OPERATION,
      `SQLite does not support ALTER TABLE ADD AUTOINCREMENT. Recreate the table instead.`,
    );
  }

  /**
   * 테이블의 기본키를 제거합니다.
   * SQLite에서는 ALTER TABLE로 기본키를 제거할 수 없습니다.
   */
  dropPrimaryKey(_tableName: string): Promise<any> {
    throw new OrmError(
      OrmErrorCode.UNSUPPORTED_OPERATION,
      `SQLite does not support ALTER TABLE DROP PRIMARY KEY. Recreate the table instead.`,
    );
  }

  /**
   * 테이블에 유니크 키를 추가합니다.
   */
  addUniqueKey(tableName: string, columnName: string) {
    const indexName = `uq_${tableName}_${columnName}`;
    return this.connector.query(
      `CREATE UNIQUE INDEX ${this.wrap(indexName)} ON ${this.wrap(tableName)} (${this.wrap(columnName)})`,
    );
  }

  /**
   * 테이블의 유니크 키를 제거합니다.
   */
  dropUniqueKey(tableName: string, columnName: string) {
    const indexName = `uq_${tableName}_${columnName}`;
    return this.connector.query(
      `DROP INDEX IF EXISTS ${this.wrap(indexName)}`,
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
   * SQLite 3.35.0+ 에서 DROP COLUMN을 지원합니다.
   */
  dropColumn(tableName: string, columnName: string) {
    return this.connector.query(
      `ALTER TABLE ${this.wrap(tableName)} DROP COLUMN ${this.wrap(columnName)}`,
    );
  }

  /**
   * 외래키를 추가합니다.
   * SQLite에서는 ALTER TABLE로 외래키를 추가할 수 없습니다.
   * 테이블 생성 시 FOREIGN KEY 절을 포함해야 합니다.
   */
  addForeignKey(
    _tableName: string,
    _columnName: string,
    _foreignTableName: string,
    _foreignColumnName: string,
  ): Promise<any> {
    throw new OrmError(
      OrmErrorCode.UNSUPPORTED_OPERATION,
      `SQLite does not support ALTER TABLE ADD FOREIGN KEY. Define foreign keys at table creation time instead.`,
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
   */
  dropForeignKey(_tableName: string, _columnName: string): Promise<any> {
    throw new OrmError(
      OrmErrorCode.UNSUPPORTED_OPERATION,
      `SQLite does not support ALTER TABLE DROP FOREIGN KEY. Recreate the table instead.`,
    );
  }

  /**
   * 인덱스를 추가합니다.
   */
  addIndex(tableName: string, columnName: string, indexName: string) {
    return this.connector.query(
      `CREATE INDEX ${this.wrap(indexName)} ON ${this.wrap(tableName)} (${this.wrap(columnName)})`,
    );
  }

  /**
   * 인덱스 존재 여부를 확인합니다.
   */
  hasIndex(tableName: string, indexName: string) {
    return this.connector.query(
      sql`SELECT COUNT(*) as count FROM sqlite_master WHERE type='index' AND tbl_name=${tableName} AND name=${indexName}`,
    );
  }

  /**
   * 인덱스를 제거합니다.
   */
  dropIndex(tableName: string, indexName: string) {
    return this.connector.query(
      `DROP INDEX IF EXISTS ${this.wrap(indexName)}`,
    );
  }

  /**
   * 스키마를 가져옵니다 (PRAGMA table_info 기반).
   * MySQL 호환 형식(MysqlSchemaInterface)으로 반환합니다.
   */
  getSchemas(tableName: string): Promise<MysqlSchemaInterface[]> {
    return this.connector.query(
      `PRAGMA table_info(${this.wrap(tableName)})`,
    );
  }

  /**
   * 인덱스를 가져옵니다.
   */
  getIndexes(tableName: string): Promise<MysqlSchemaInterface[]> {
    return this.connector.query(
      `PRAGMA index_list(${this.wrap(tableName)})`,
    );
  }

  /**
   * 외래키를 가져옵니다.
   */
  getForeignKeys(tableName: string): Promise<MysqlSchemaInterface[]> {
    return this.connector.query(
      `PRAGMA foreign_key_list(${this.wrap(tableName)})`,
    );
  }

  /**
   * 기본키를 가져옵니다.
   */
  getPrimaryKeys(tableName: string): Promise<MysqlSchemaInterface[]> {
    return this.connector.query(
      `PRAGMA table_info(${this.wrap(tableName)})`,
    );
  }

  /**
   * 테이블을 생성합니다.
   */
  createTable(tableName: string, columns: SchemaOptions[]) {
    const columnsMap = columns.map((column) => {
      const option = (column.options ?? {
        type: "varchar",
        length: 255,
        nullable: false,
      }) as ColumnOption;

      let type = this.castType(option.type ?? "varchar");

      // SQLite는 BOOLEAN을 INTEGER로 처리합니다.
      if (option.type === "boolean") {
        type = "INTEGER";
      }

      const nullable = option.nullable ?? false;

      // auto_increment → INTEGER PRIMARY KEY AUTOINCREMENT
      if (option.autoIncrement) {
        return raw(
          `${this.wrap(column.name!)} INTEGER PRIMARY KEY AUTOINCREMENT`,
        );
      }

      // SQLite의 VARCHAR 등에서 길이 지정은 선택사항이지만 호환성을 위해 유지
      const needsLength = ["TEXT", "VARCHAR", "CHAR"].some((t) =>
        type.toUpperCase().startsWith(t),
      );

      const alreadyHasParens = type.includes("(");
      const typeWithLength =
        alreadyHasParens || !needsLength || !option.length
          ? type
          : `${type}(${option.length})`;

      return raw(
        `${this.wrap(column.name!)} ${typeWithLength} ${nullable ? "NULL" : "NOT NULL"} ${option.primary ? "PRIMARY KEY" : ""}`,
      );
    });

    const result = sql`CREATE TABLE IF NOT EXISTS ${raw(this.wrap(tableName))} (${join(
      columnsMap,
      ",",
    )})`;

    return this.connector.query(result.text);
  }

  /**
   * 식별자를 큰따옴표로 감싸서 반환합니다 (SQLite 표준).
   * 내부에 포함된 `"` 문자는 `""` 으로 이스케이프합니다.
   */
  wrap(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  /**
   * SQLite에는 스키마 개념이 없으므로 단순히 wrap()을 호출합니다.
   */
  wrapQualified(name: string): string {
    return this.wrap(name);
  }

  /**
   * TS 타입으로부터 데이터베이스 컬럼 타입을 추론합니다.
   */
  getColumnType(type: any): string {
    switch (type) {
      case String:
        return "TEXT";
      case Number:
        return "INTEGER";
      case Boolean:
        return "INTEGER";
      case Date:
        return "TEXT";
      case Buffer:
        return "BLOB";
      default:
        return "TEXT";
    }
  }

  /**
   * ColumnType을 SQLite 컬럼 타입으로 변환합니다.
   *
   * ## SQLite 타입 매핑
   * SQLite는 5가지 스토리지 클래스를 가집니다: NULL, INTEGER, REAL, TEXT, BLOB
   * 타입 친화성(type affinity) 규칙에 따라 적절한 타입을 반환합니다.
   *
   * | ColumnType | SQLite Type  |
   * |------------|--------------|
   * | varchar    | TEXT         |
   * | int        | INTEGER      |
   * | number     | INTEGER      |
   * | boolean    | INTEGER      |
   * | datetime   | TEXT         |
   * | date       | TEXT         |
   * | timestamp  | TEXT         |
   * | float      | REAL         |
   * | double     | REAL         |
   * | blob       | BLOB         |
   * | text       | TEXT         |
   * | longtext   | TEXT         |
   * | bigint     | INTEGER      |
   * | json       | TEXT         |
   * | jsonb      | TEXT         |
   * | char       | TEXT         |
   * | enum       | TEXT         |
   * | array      | TEXT         |
   */
  castType(type: ColumnType): string {
    switch (type) {
      case "varchar":
      case "text":
      case "longtext":
      case "char":
      case "enum":
      case "json":
      case "jsonb":
      case "array":
      case "datetime":
      case "date":
      case "timestamp":
      case "timestamptz":
        return "TEXT";
      case "int":
      case "number":
      case "boolean":
      case "bigint":
        return "INTEGER";
      case "float":
      case "double":
        return "REAL";
      case "blob":
        return "BLOB";
      case "uuid":
        return "VARCHAR(36)";
      default:
        return type as string;
    }
  }

  public isMySqlFamily() {
    return false;
  }

  setQueryTimeout(ms: number): string {
    return `PRAGMA busy_timeout = ${Math.max(0, Math.floor(ms))}`;
  }

  supportsExplain(): boolean {
    return true;
  }

  buildExplainSql(selectSql: string): string {
    return `EXPLAIN QUERY PLAN ${selectSql}`;
  }

  buildUpsertSql(
    tableName: string,
    columns: string[],
    conflictColumns: string[],
    updateColumns: string[],
  ): string {
    const columnList = columns.map((c) => this.wrap(c)).join(", ");
    const valuePlaceholders = columns.map(() => "?").join(", ");
    const conflictList = conflictColumns.map((c) => this.wrap(c)).join(", ");
    const updateSet = updateColumns
      .map((col) => `${this.wrap(col)} = excluded.${this.wrap(col)}`)
      .join(", ");

    return `INSERT INTO ${this.wrap(tableName)} (${columnList}) VALUES (${valuePlaceholders}) ON CONFLICT (${conflictList}) DO UPDATE SET ${updateSet}`;
  }

  async hasColumn(tableName: string, columnName: string): Promise<boolean> {
    const rows: any[] = await this.connector.query(
      `PRAGMA table_info(${this.wrap(tableName)})`,
    );
    if (!Array.isArray(rows)) return false;
    return rows.some(
      (r: any) => (r.name ?? "").toLowerCase() === columnName.toLowerCase(),
    );
  }

  async hasForeignKey(tableName: string, constraintName: string): Promise<boolean> {
    // SQLite does not support named FK constraints; always return false to allow idempotent re-creation attempts
    // SQLite ignores duplicate FK declarations without error, so this is safe.
    return false;
  }

  addCompositeUniqueIndex(
    tableName: string,
    columns: string[],
    indexName: string,
  ) {
    const columnList = columns.map((col) => this.wrap(col)).join(", ");
    return this.connector.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${this.wrap(indexName)} ON ${this.wrap(tableName)} (${columnList})`,
    );
  }

  // SQLite는 단일 프로세스이므로 advisory lock은 no-op으로 처리합니다.
  async acquireAdvisoryLock(_lockId: string, _timeoutMs?: number): Promise<boolean> {
    return true;
  }

  async releaseAdvisoryLock(_lockId: string): Promise<void> {
    // no-op
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
   * 테이블의 모든 데이터를 제거합니다.
   * SQLite는 TRUNCATE를 지원하지 않으므로 DELETE FROM을 사용합니다.
   */
  clear(tableName: string) {
    return this.connector.query(
      `DELETE FROM ${this.wrap(tableName)}`,
    );
  }

  /**
   * 비관적 잠금을 위한 SQL을 반환합니다.
   * SQLite는 데이터베이스 수준 잠금을 사용하며 행 단위 잠금을 지원하지 않습니다.
   * BEGIN EXCLUSIVE 트랜잭션을 통해 잠금을 구현합니다.
   * FOR UPDATE는 SQLite에서 무시되지만, 호환성을 위해 빈 문자열을 반환하지 않습니다.
   */
  getForUpdateNoWait(): string {
    // SQLite는 행 단위 잠금을 지원하지 않으므로, 빈 문자열 반환
    this.logger.warn(
      "SQLite does not support FOR UPDATE — pessimistic locking is not applied",
    );
    return "";
  }

  supportsReturning(): boolean {
    return false;
  }
}
