/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import sql from "sql-template-tag";
import { ClazzType } from "../utils";
import { COLUMN_TOKEN, ColumnOption, ColumnType } from "../decorators/Column";
import { ENTITY_TOKEN, EntityMetadata } from "../decorators/Entity";
import { ColumnMetadata } from "../scanner/ColumnScanner";
import { SchemaDialect } from "./SchemaGenerator";

export interface ColumnChange {
  tableName: string;
  columnName: string;
  columnType?: string;
  currentType?: string;
  nullable?: boolean;
}

export interface SchemaDiffResult {
  addTables: string[];
  dropTables: string[];
  addColumns: ColumnChange[];
  dropColumns: ColumnChange[];
  alterColumns: ColumnChange[];
  addTableEntityMap?: Record<string, ClazzType<any>>;
}

interface DbColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: string;
}

interface QueryRunner {
  query: (sql: string | import("sql-template-tag").Sql) => Promise<any>;
}

/**
 * 엔티티 메타데이터와 DB INFORMATION_SCHEMA를 비교하여 스키마 diff를 생성합니다.
 */
export class SchemaDiff {
  /**
   * 엔티티 메타데이터에서 원하는 스키마를 추출하고
   * DB INFORMATION_SCHEMA와 비교하여 diff를 반환합니다.
   */
  async diff(
    entities: ClazzType<any>[],
    queryRunner: QueryRunner,
    dialect: SchemaDialect,
    schema?: string,
  ): Promise<SchemaDiffResult> {
    const result: SchemaDiffResult = {
      addTables: [],
      dropTables: [],
      addColumns: [],
      dropColumns: [],
      alterColumns: [],
    };

    for (const entity of entities) {
      const tableName = this.getTableName(entity);
      const entityColumns = this.getEntityColumns(entity);
      const dbColumns = await this.getDbColumns(
        queryRunner,
        tableName,
        dialect,
        schema,
      );

      if (dbColumns.length === 0) {
        // Table does not exist in DB — needs to be created
        result.addTables.push(tableName);
        if (!result.addTableEntityMap) result.addTableEntityMap = {};
        result.addTableEntityMap[tableName] = entity;
        continue;
      }

      const dbColumnMap = new Map<string, DbColumnInfo>();
      for (const col of dbColumns) {
        dbColumnMap.set(col.column_name.toLowerCase(), col);
      }

      const entityColumnNames = new Set<string>();

      for (const col of entityColumns) {
        const colName = col.name ?? "unknown";
        entityColumnNames.add(colName.toLowerCase());
        const dbCol = dbColumnMap.get(colName.toLowerCase());

        if (!dbCol) {
          // Column exists in entity but not in DB — needs to be added
          const castTypeName = this.castType(
            col.options?.type ?? "varchar",
            dialect,
          );
          result.addColumns.push({
            tableName,
            columnName: colName,
            columnType: castTypeName,
            nullable: col.options?.nullable ?? false,
          });
        } else {
          // Column exists in both — check for type changes
          const expectedType = this.castType(
            col.options?.type ?? "varchar",
            dialect,
          );
          const actualType = dbCol.data_type.toUpperCase();

          if (!this.typesMatch(expectedType, actualType, dialect)) {
            result.alterColumns.push({
              tableName,
              columnName: colName,
              columnType: expectedType,
              currentType: dbCol.data_type,
            });
          }
        }
      }

      // Check for columns in DB that are not in entity — candidates for drop
      for (const [dbColName, dbCol] of dbColumnMap) {
        if (!entityColumnNames.has(dbColName)) {
          result.dropColumns.push({
            tableName,
            columnName: dbCol.column_name,
            currentType: dbCol.data_type,
          });
        }
      }
    }

    return result;
  }

  private getTableName<T>(entity: ClazzType<T>): string {
    const meta = Reflect.getMetadata(ENTITY_TOKEN, entity) as
      | EntityMetadata
      | undefined;
    return meta?.name ?? entity.name;
  }

  private getEntityColumns<T>(
    entity: ClazzType<T>,
  ): Array<{ name: string; options: ColumnOption }> {
    const columns = (Reflect.getMetadata(COLUMN_TOKEN, entity.prototype) ??
      []) as ColumnMetadata[];
    return columns.map((col) => ({
      name: col.name ?? "unknown",
      options: (col.options ?? {
        type: "varchar" as ColumnType,
        length: 255,
        nullable: false,
      }) as ColumnOption,
    }));
  }

  private async getDbColumns(
    queryRunner: QueryRunner,
    tableName: string,
    dialect: SchemaDialect,
    schema?: string,
  ): Promise<DbColumnInfo[]> {
    let rawResult: any;

    if (dialect === "mysql") {
      rawResult = await queryRunner.query(
        sql`SELECT COLUMN_NAME as column_name, DATA_TYPE as data_type, IS_NULLABLE as is_nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${tableName}`,
      );
    } else {
      const pgSchema = schema ?? "public";
      rawResult = await queryRunner.query(
        sql`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = ${pgSchema} AND table_name = ${tableName}`,
      );
    }

    return this.normalizeRows(rawResult);
  }

  private castType(type: ColumnType, dialect: SchemaDialect): string {
    if (dialect === "postgres") {
      return this.castTypePostgres(type);
    }
    return this.castTypeMysql(type);
  }

  private castTypeMysql(type: ColumnType): string {
    switch (type) {
      case "varchar":
        return "VARCHAR";
      case "int":
      case "number":
        return "INT";
      case "boolean":
        return "TINYINT";
      case "datetime":
        return "DATETIME";
      case "date":
        return "DATE";
      case "timestamp":
        return "TIMESTAMP";
      case "float":
        return "FLOAT";
      case "double":
        return "DECIMAL";
      case "blob":
        return "BLOB";
      case "text":
      case "longtext":
        return "TEXT";
      case "bigint":
        return "BIGINT";
      case "json":
      case "jsonb":
      case "array":
        return "JSON";
      case "char":
        return "CHAR";
      case "enum":
        return "ENUM";
      default:
        return (type as string).toUpperCase();
    }
  }

  private castTypePostgres(type: ColumnType): string {
    switch (type) {
      case "varchar":
        return "CHARACTER VARYING";
      case "int":
      case "number":
        return "INTEGER";
      case "boolean":
        return "BOOLEAN";
      case "datetime":
      case "timestamp":
        return "TIMESTAMP WITHOUT TIME ZONE";
      case "date":
        return "DATE";
      case "float":
        return "REAL";
      case "double":
        return "NUMERIC";
      case "blob":
        return "BYTEA";
      case "text":
      case "longtext":
        return "TEXT";
      case "bigint":
        return "BIGINT";
      case "json":
        return "JSON";
      case "jsonb":
        return "JSONB";
      case "char":
        return "CHARACTER";
      case "enum":
        return "USER-DEFINED";
      case "array":
        return "ARRAY";
      default:
        return (type as string).toUpperCase();
    }
  }

  /**
   * Compare expected type (from entity metadata) with actual DB type.
   * Uses a simplified comparison since DB types can vary in detail.
   */
  private typesMatch(
    expected: string,
    actual: string,
    _dialect: SchemaDialect,
  ): boolean {
    const e = expected.toUpperCase().trim();
    const a = actual.toUpperCase().trim();

    if (e === a) return true;

    // Handle common aliases
    const aliases: Record<string, string[]> = {
      INT: ["INT", "INTEGER", "INT4"],
      VARCHAR: ["VARCHAR", "CHARACTER VARYING"],
      "CHARACTER VARYING": ["VARCHAR", "CHARACTER VARYING"],
      BOOLEAN: ["BOOLEAN", "BOOL"],
      TINYINT: ["TINYINT"],
      TEXT: ["TEXT", "LONGTEXT"],
      FLOAT: ["FLOAT", "REAL", "FLOAT4"],
      REAL: ["REAL", "FLOAT", "FLOAT4"],
      BIGINT: ["BIGINT", "INT8"],
      "TIMESTAMP WITHOUT TIME ZONE": [
        "TIMESTAMP WITHOUT TIME ZONE",
        "TIMESTAMP",
      ],
      TIMESTAMP: ["TIMESTAMP", "TIMESTAMP WITHOUT TIME ZONE"],
      DECIMAL: ["DECIMAL", "NUMERIC"],
      NUMERIC: ["NUMERIC", "DECIMAL"],
      BLOB: ["BLOB", "BYTEA"],
      BYTEA: ["BYTEA", "BLOB"],
      DATETIME: ["DATETIME", "TIMESTAMP"],
      JSON: ["JSON", "JSONB"],
      CHARACTER: ["CHARACTER", "CHAR", "BPCHAR"],
      CHAR: ["CHAR", "CHARACTER", "BPCHAR"],
    };

    const expectedAliases = aliases[e];
    if (expectedAliases && expectedAliases.includes(a)) return true;

    return false;
  }

  private normalizeRows(result: any): DbColumnInfo[] {
    if (!result) return [];
    if (Array.isArray(result)) return result;
    if (result.results && Array.isArray(result.results)) return result.results;
    if (result.rows && Array.isArray(result.rows)) return result.rows;
    return [];
  }
}
