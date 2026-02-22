/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { ClazzType } from "../utils";
import { COLUMN_TOKEN, ColumnOption, ColumnType } from "../decorators/Column";
import { ENTITY_TOKEN, EntityMetadata } from "../decorators/Entity";
import { INDEX_TOKEN, IndexMetadata } from "../decorators/Indexer";
import {
  MANY_TO_ONE_TOKEN,
  ManyToOneMetadata,
} from "../decorators/ManyToOne";
import {
  ONE_TO_ONE_TOKEN,
  OneToOneMetadata,
} from "../decorators/OneToOne";
import { ColumnMetadata } from "../scanner/ColumnScanner";

export type SchemaDialect = "mysql" | "postgres";

export interface SchemaGeneratorOptions {
  dialect: SchemaDialect;
  schema?: string; // PostgreSQL schema (default: "public")
}

interface ColumnDef {
  name: string;
  options: ColumnOption;
}

interface ForeignKeyDef {
  column: string;
  referencedTable: string;
  referencedColumn: string;
}

/**
 * DDL 생성기입니다. 엔티티 메타데이터를 읽어 CREATE TABLE / DROP TABLE DDL 문자열을 생성합니다.
 * 실제 DB 연결 없이 DDL 문자열만 생성하므로 unit test가 가능합니다.
 */
export class SchemaGenerator {
  private readonly dialect: SchemaDialect;
  private readonly pgSchema: string;

  constructor(options: SchemaGeneratorOptions) {
    this.dialect = options.dialect;
    this.pgSchema = options.schema ?? "public";
  }

  /**
   * 단일 엔티티에 대한 CREATE TABLE DDL을 생성합니다.
   */
  generateCreateTableDDL<T>(entity: ClazzType<T>): string {
    const tableName = this.getTableName(entity);
    const columns = this.getColumns(entity);
    const columnDefs = columns.map((col) => this.renderColumnDef(col, tableName));

    const ddl = `CREATE TABLE IF NOT EXISTS ${this.wrapTable(tableName)} (${columnDefs.join(", ")})`;

    if (this.dialect === "mysql") {
      return ddl + " ENGINE=InnoDB";
    }

    return ddl;
  }

  /**
   * 단일 엔티티에 대한 CREATE INDEX DDL 배열을 생성합니다.
   */
  generateCreateIndexDDL<T>(entity: ClazzType<T>): string[] {
    const tableName = this.getTableName(entity);
    const indexes = this.getIndexes(entity);
    return indexes.map((idx) => {
      const indexName = `INDEX_${tableName}_${idx.name}`;
      if (this.dialect === "postgres") {
        return `CREATE INDEX IF NOT EXISTS ${this.wrapId(indexName)} ON ${this.wrapTable(tableName)} (${this.wrapId(idx.name)})`;
      }
      return `CREATE INDEX ${this.wrapId(indexName)} ON ${this.wrapTable(tableName)} (${this.wrapId(idx.name)})`;
    });
  }

  /**
   * 단일 엔티티에 대한 ALTER TABLE ... ADD FOREIGN KEY DDL 배열을 생성합니다.
   */
  generateForeignKeyDDL<T>(entity: ClazzType<T>): string[] {
    const tableName = this.getTableName(entity);
    const fks = this.getForeignKeys(entity);
    return fks.map((fk) => {
      const fkName = `fk_${tableName}_${fk.referencedTable}_${fk.column}`;
      return `ALTER TABLE ${this.wrapTable(tableName)} ADD CONSTRAINT ${fkName} FOREIGN KEY (${this.wrapId(fk.column)}) REFERENCES ${this.wrapTable(fk.referencedTable)}(${this.wrapId(fk.referencedColumn)}) ON DELETE NO ACTION ON UPDATE NO ACTION`;
    });
  }

  /**
   * DROP TABLE DDL을 생성합니다.
   */
  generateDropTableDDL<T>(entity: ClazzType<T>): string {
    const tableName = this.getTableName(entity);
    return `DROP TABLE IF EXISTS ${this.wrapTable(tableName)}`;
  }

  /**
   * 여러 엔티티에 대한 CREATE TABLE + INDEX + FK DDL을 생성합니다.
   */
  generateSchemaDDL(entities: ClazzType<any>[]): string[] {
    const ddls: string[] = [];

    // 1. CREATE TABLE (순서대로)
    for (const entity of entities) {
      ddls.push(this.generateCreateTableDDL(entity));
    }

    // 2. CREATE INDEX
    for (const entity of entities) {
      ddls.push(...this.generateCreateIndexDDL(entity));
    }

    // 3. ADD FOREIGN KEY (테이블 생성 후)
    for (const entity of entities) {
      ddls.push(...this.generateForeignKeyDDL(entity));
    }

    return ddls;
  }

  /**
   * 여러 엔티티에 대한 DROP TABLE DDL을 역순으로 생성합니다 (FK 의존성).
   */
  generateDropSchemaDDL(entities: ClazzType<any>[]): string[] {
    return [...entities].reverse().map((e) => this.generateDropTableDDL(e));
  }

  // ─────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────

  private getTableName<T>(entity: ClazzType<T>): string {
    const meta = Reflect.getMetadata(ENTITY_TOKEN, entity) as
      | EntityMetadata
      | undefined;
    return meta?.name ?? entity.name;
  }

  private getColumns<T>(entity: ClazzType<T>): ColumnDef[] {
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

  private getIndexes<T>(entity: ClazzType<T>): IndexMetadata[] {
    return (
      (Reflect.getMetadata(INDEX_TOKEN, entity.prototype) as
        | IndexMetadata[]
        | undefined) ?? []
    );
  }

  private getForeignKeys<T>(entity: ClazzType<T>): ForeignKeyDef[] {
    const fks: ForeignKeyDef[] = [];

    // ManyToOne
    const manyToOnes = (Reflect.getMetadata(MANY_TO_ONE_TOKEN, entity) ??
      Reflect.getMetadata(MANY_TO_ONE_TOKEN, entity.prototype) ??
      []) as ManyToOneMetadata<any>[];

    for (const rel of manyToOnes) {
      if (!rel.joinColumn) continue;
      const relatedEntity = rel.getMappingEntity();
      const relatedTable = this.getTableName(relatedEntity as ClazzType<any>);
      const relatedPk = this.findPrimaryKeyColumn(
        relatedEntity as ClazzType<any>,
      );
      if (relatedPk) {
        fks.push({
          column: rel.joinColumn,
          referencedTable: relatedTable,
          referencedColumn: relatedPk,
        });
      }
    }

    // OneToOne (소유측 — joinColumn이 있는 경우)
    const oneToOnes = (Reflect.getMetadata(ONE_TO_ONE_TOKEN, entity) ??
      []) as OneToOneMetadata<any>[];

    for (const rel of oneToOnes) {
      if (!rel.joinColumn) continue;
      const relatedEntity = rel.getRelatedEntity();
      const relatedTable = this.getTableName(relatedEntity);
      const relatedPk = this.findPrimaryKeyColumn(relatedEntity);
      if (relatedPk) {
        fks.push({
          column: rel.joinColumn,
          referencedTable: relatedTable,
          referencedColumn: relatedPk,
        });
      }
    }

    return fks;
  }

  private findPrimaryKeyColumn<T>(entity: ClazzType<T>): string | null {
    const columns = this.getColumns(entity);
    const pk = columns.find((col) => col.options.primary);
    return pk?.name ?? null;
  }

  private renderColumnDef(col: ColumnDef, tableName: string): string {
    const { name, options } = col;
    let type = this.castType(options.type ?? "varchar");

    // Boolean 처리
    if (options.type === "boolean" && this.dialect === "mysql") {
      type = type.replace("$n", options.length?.toString() ?? "1");
    }

    // DECIMAL / NUMERIC 처리
    if (type.includes("$precision")) {
      type = type.replace("$precision", options.precision?.toString() ?? "10");
      type = type.replace("$scale", options.scale?.toString() ?? "2");
    }

    // ENUM (PostgreSQL)
    if (options.type === "enum" && this.dialect === "postgres") {
      const enumName = options.enumName ?? `${tableName}_${name}_enum`;
      type = this.wrapTable(enumName);
    }

    // auto increment
    if (options.autoIncrement && this.dialect === "postgres") {
      const nullable = options.nullable ? "NULL" : "NOT NULL";
      const pk = options.primary ? " PRIMARY KEY" : "";
      return `${this.wrapId(name)} SERIAL ${nullable}${pk}`;
    }

    // 길이 처리
    const alreadyHasParens = type.includes("(");
    const needsLength =
      !alreadyHasParens && options.length && options.length > 0;
    const typeWithLength = needsLength ? `${type}(${options.length})` : type;

    const nullable = options.nullable ? "NULL" : "NOT NULL";
    const pk = options.primary ? " PRIMARY KEY" : "";
    const autoInc =
      options.autoIncrement && this.dialect === "mysql"
        ? " AUTO_INCREMENT"
        : "";

    return `${this.wrapId(name)} ${typeWithLength} ${nullable}${pk}${autoInc}`;
  }

  private castType(type: ColumnType): string {
    if (this.dialect === "postgres") {
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
        return "TINYINT($n)";
      case "datetime":
        return "DATETIME";
      case "date":
        return "DATE";
      case "timestamp":
        return "TIMESTAMP";
      case "float":
        return "FLOAT";
      case "double":
        return "DECIMAL($precision, $scale)";
      case "blob":
        return "BLOB";
      case "text":
        return "TEXT";
      case "longtext":
        return "LONGTEXT";
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
        return type as string;
    }
  }

  private castTypePostgres(type: ColumnType): string {
    switch (type) {
      case "varchar":
        return "VARCHAR";
      case "int":
      case "number":
        return "INTEGER";
      case "boolean":
        return "BOOLEAN";
      case "datetime":
      case "timestamp":
        return "TIMESTAMP";
      case "date":
        return "DATE";
      case "float":
        return "REAL";
      case "double":
        return "NUMERIC($precision, $scale)";
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
        return "CHAR";
      case "enum":
        return "TEXT";
      case "array":
        return "ARRAY";
      default:
        return type as string;
    }
  }

  private wrapId(name: string): string {
    if (this.dialect === "postgres") {
      return `"${name.replace(/"/g, '""')}"`;
    }
    return `\`${name.replace(/`/g, "``")}\``;
  }

  private wrapTable(name: string): string {
    if (this.dialect === "postgres") {
      return `"${this.pgSchema}"."${name.replace(/"/g, '""')}"`;
    }
    return `\`${name.replace(/`/g, "``")}\``;
  }
}
