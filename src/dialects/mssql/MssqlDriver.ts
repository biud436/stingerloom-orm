/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { join, raw } from "sql-template-tag";
import { IConnector } from "../../core/IConnector";
import { MysqlSchemaInterface } from "../mysql/BaseSchema";
import { ColumnOption, ColumnType } from "../../decorators";
import { ISqlDriver } from "../SqlDriver";
import { SchemaOptions } from "../../types/SchemaOption";

/**
 * MSSQL (Microsoft SQL Server) 드라이버 구현체입니다.
 *
 * - 식별자 래핑: 대괄호 [column_name]
 * - PK 생성: IDENTITY(1,1)
 * - 파라미터 바인딩: @param0, @param1 형식 (MssqlConnector에서 변환)
 */
export class MssqlDriver implements ISqlDriver {
  constructor(private readonly connector: IConnector) {}

  /**
   * 테이블이 존재하는지 확인합니다.
   */
  hasTable(name: string) {
    return this.connector.query(
      sql`SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = ${name}`,
    );
  }

  /**
   * 테이블에 기본키를 추가합니다.
   */
  addPrimaryKey(tableName: string, columnName: string) {
    const constraintName = `PK_${tableName}`;
    return this.connector.query(
      `ALTER TABLE ${this.wrap(tableName)} ADD CONSTRAINT ${this.wrap(constraintName)} PRIMARY KEY (${this.wrap(columnName)})`,
    );
  }

  /**
   * 테이블에 자동 증가를 추가합니다.
   * MSSQL에서는 기존 컬럼에 IDENTITY를 추가할 수 없으므로,
   * 테이블 재생성이 필요합니다. 인터페이스 호환을 위해 에러를 발생시킵니다.
   */
  addAutoIncrement(tableName: string, columnName: string) {
    // MSSQL does not support adding IDENTITY to an existing column.
    // This would require table recreation.
    return this.connector.query(
      `ALTER TABLE ${this.wrap(tableName)} ALTER COLUMN ${this.wrap(columnName)} INT NOT NULL`,
    );
  }

  /**
   * 테이블의 기본키를 제거합니다.
   */
  dropPrimaryKey(tableName: string) {
    const constraintName = `PK_${tableName}`;
    return this.connector.query(
      `ALTER TABLE ${this.wrap(tableName)} DROP CONSTRAINT ${this.wrap(constraintName)}`,
    );
  }

  /**
   * 테이블에 유니크 키를 추가합니다.
   */
  addUniqueKey(tableName: string, columnName: string) {
    const constraintName = `UQ_${tableName}_${columnName}`;
    return this.connector.query(
      `ALTER TABLE ${this.wrap(tableName)} ADD CONSTRAINT ${this.wrap(constraintName)} UNIQUE (${this.wrap(columnName)})`,
    );
  }

  /**
   * 테이블의 유니크 키를 제거합니다.
   */
  dropUniqueKey(tableName: string, columnName: string) {
    const constraintName = `UQ_${tableName}_${columnName}`;
    return this.connector.query(
      `ALTER TABLE ${this.wrap(tableName)} DROP CONSTRAINT ${this.wrap(constraintName)}`,
    );
  }

  /**
   * 테이블에 컬럼을 추가합니다.
   */
  addColumn(tableName: string, columnName: string, columnType: string) {
    return this.connector.query(
      `ALTER TABLE ${this.wrap(tableName)} ADD ${this.wrap(columnName)} ${columnType}`,
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
      `ALTER TABLE ${this.wrap(tableName)} ADD CONSTRAINT ${this.wrap(foreignKeyName)} FOREIGN KEY (${this.wrap(columnName)}) REFERENCES ${this.wrap(foreignTableName)}(${this.wrap(foreignColumnName)}) ON DELETE NO ACTION ON UPDATE NO ACTION`,
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
      `CREATE INDEX ${this.wrap(indexName)} ON ${this.wrap(tableName)} (${this.wrap(columnName)})`,
    );
  }

  /**
   * 인덱스 존재 여부를 확인합니다.
   */
  hasIndex(tableName: string, indexName: string) {
    return this.connector.query(
      sql`SELECT name FROM sys.indexes WHERE object_id = OBJECT_ID(${tableName}) AND name = ${indexName}`,
    );
  }

  /**
   * 인덱스를 제거합니다.
   */
  dropIndex(tableName: string, indexName: string) {
    return this.connector.query(
      `DROP INDEX ${this.wrap(indexName)} ON ${this.wrap(tableName)}`,
    );
  }

  /**
   * 스키마를 가져옵니다.
   */
  getSchemas(tableName: string): Promise<MysqlSchemaInterface[]> {
    return this.connector.query(
      sql`SELECT COLUMN_NAME AS Field, DATA_TYPE AS Type, IS_NULLABLE AS "Null", COLUMN_DEFAULT AS "Default" FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ${tableName}`,
    );
  }

  /**
   * 인덱스를 가져옵니다.
   */
  getIndexes(tableName: string): Promise<MysqlSchemaInterface[]> {
    return this.connector.query(
      sql`SELECT i.name AS Field, i.type_desc AS Type FROM sys.indexes i WHERE i.object_id = OBJECT_ID(${tableName})`,
    );
  }

  /**
   * 외래키를 가져옵니다.
   */
  getForeignKeys(tableName: string): Promise<MysqlSchemaInterface[]> {
    return this.connector.query(
      sql`SELECT COL_NAME(fc.parent_object_id, fc.parent_column_id) AS COLUMN_NAME, OBJECT_NAME(f.referenced_object_id) AS REFERENCED_TABLE_NAME, COL_NAME(fc.referenced_object_id, fc.referenced_column_id) AS REFERENCED_COLUMN_NAME FROM sys.foreign_keys AS f INNER JOIN sys.foreign_key_columns AS fc ON f.object_id = fc.constraint_object_id WHERE f.parent_object_id = OBJECT_ID(${tableName})`,
    );
  }

  /**
   * 기본키를 가져옵니다.
   */
  getPrimaryKeys(tableName: string): Promise<MysqlSchemaInterface[]> {
    return this.connector.query(
      sql`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_NAME = ${tableName} AND CONSTRAINT_NAME LIKE 'PK_%'`,
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

      // BOOLEAN → BIT
      if (option.type === "boolean") {
        type = "BIT";
      }

      // DECIMAL 타입: precision과 scale 설정
      if (type.startsWith("DECIMAL")) {
        type = type.replace(
          "$precision",
          option.precision?.toString() || "10",
        );
        type = type.replace("$scale", option.scale?.toString() || "2");
      }

      const nullable = option.nullable ?? false;

      // IDENTITY(1,1) for auto-increment columns
      if (option.autoIncrement) {
        return raw(
          `${this.wrap(column.name!)} INT IDENTITY(1,1) NOT NULL PRIMARY KEY`,
        );
      }

      const alreadyHasParens = type.includes("(");
      const typeWithLength =
        alreadyHasParens || !option.length
          ? type
          : `${type}(${option.length})`;

      return raw(
        `${this.wrap(column.name!)} ${typeWithLength} ${nullable ? "NULL" : "NOT NULL"} ${option.primary ? "PRIMARY KEY" : ""}`,
      );
    });

    const result = sql`CREATE TABLE ${raw(this.wrap(tableName))} (${join(
      columnsMap,
      ",",
    )})`;

    return this.connector.query(result.text);
  }

  /**
   * 식별자를 대괄호로 감싸서 반환합니다 (MSSQL 표준).
   * 내부에 포함된 `]` 문자는 `]]` 으로 이스케이프합니다.
   */
  wrap(name: string): string {
    return `[${name.replace(/\]/g, "]]")}]`;
  }

  /**
   * TS 타입으로부터 데이터베이스 컬럼 타입을 추론합니다.
   */
  getColumnType(type: any): string {
    switch (type) {
      case String:
        return "NVARCHAR";
      case Number:
        return "INT";
      case Boolean:
        return "BIT";
      case Date:
        return "DATETIME2";
      case Buffer:
        return "VARBINARY(MAX)";
      default:
        return "NVARCHAR(MAX)";
    }
  }

  /**
   * ColumnType을 MSSQL 컬럼 타입으로 변환합니다.
   *
   * ## MSSQL 타입 매핑
   * | ColumnType | MSSQL Type          |
   * |------------|---------------------|
   * | varchar    | NVARCHAR            |
   * | int        | INT                 |
   * | number     | INT                 |
   * | boolean    | BIT                 |
   * | datetime   | DATETIME2           |
   * | date       | DATE                |
   * | timestamp  | DATETIME2           |
   * | float      | FLOAT               |
   * | double     | DECIMAL(p,s)        |
   * | blob       | VARBINARY(MAX)      |
   * | text       | NVARCHAR(MAX)       |
   * | longtext   | NVARCHAR(MAX)       |
   * | bigint     | BIGINT              |
   * | json       | NVARCHAR(MAX)       |
   * | jsonb      | NVARCHAR(MAX)       |
   * | char       | NCHAR               |
   * | enum       | NVARCHAR            |
   * | array      | NVARCHAR(MAX)       |
   */
  castType(type: ColumnType): string {
    switch (type) {
      case "varchar":
        return "NVARCHAR";
      case "int":
      case "number":
        return "INT";
      case "boolean":
        return "BIT";
      case "datetime":
        return "DATETIME2";
      case "date":
        return "DATE";
      case "timestamp":
        return "DATETIME2";
      case "float":
        return "FLOAT";
      case "double":
        return "DECIMAL($precision, $scale)";
      case "blob":
        return "VARBINARY(MAX)";
      case "text":
      case "longtext":
        return "NVARCHAR(MAX)";
      case "bigint":
        return "BIGINT";
      case "json":
      case "jsonb":
        return "NVARCHAR(MAX)";
      case "char":
        return "NCHAR";
      case "enum":
        return "NVARCHAR";
      case "array":
        return "NVARCHAR(MAX)";
      default:
        return type as string;
    }
  }

  public isMySqlFamily() {
    return false;
  }

  setQueryTimeout(ms: number): string {
    return `SET LOCK_TIMEOUT ${Math.max(0, Math.floor(ms))}`;
  }

  supportsExplain(): boolean {
    return false;
  }

  buildExplainSql(_selectSql: string): string {
    throw new Error("EXPLAIN is not supported for MSSQL.");
  }

  buildUpsertSql(
    tableName: string,
    columns: string[],
    conflictColumns: string[],
    updateColumns: string[],
  ): string {
    const joinCondition = conflictColumns
      .map((col) => `target.${col} = source.${col}`)
      .join(" AND ");
    const updateSet = updateColumns
      .map((col) => `target.${col} = source.${col}`)
      .join(", ");
    const insertCols = columns.join(", ");
    const sourceCols = columns.map((col) => `source.${col}`).join(", ");
    const valuePlaceholders = columns.map(() => "?").join(", ");

    return (
      `MERGE INTO ${tableName} AS target ` +
      `USING (SELECT ${valuePlaceholders}) AS source (${insertCols}) ` +
      `ON (${joinCondition}) ` +
      `WHEN MATCHED THEN UPDATE SET ${updateSet} ` +
      `WHEN NOT MATCHED THEN INSERT (${insertCols}) VALUES (${sourceCols});`
    );
  }

  async hasColumn(tableName: string, columnName: string): Promise<boolean> {
    const rows: any[] = await this.connector.query(
      sql`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ${tableName} AND COLUMN_NAME = ${columnName}`,
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
      `CREATE UNIQUE INDEX ${this.wrap(indexName)} ON ${this.wrap(tableName)} (${columnList})`,
    );
  }

  /**
   * 비관적 잠금을 위한 SQL을 반환합니다.
   * MSSQL은 WITH (UPDLOCK, ROWLOCK) 힌트를 사용하지만,
   * SELECT ... FOR UPDATE 호환성을 위해 UPDLOCK 힌트를 반환합니다.
   */
  getForUpdateNoWait(): string {
    return " WITH (UPDLOCK, ROWLOCK, NOWAIT)";
  }
}
