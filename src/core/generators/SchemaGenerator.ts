/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import crypto from "crypto";
import { ClazzType } from "../../utils";
import { COLUMN_TOKEN, ColumnOption, ColumnType } from "../../decorators/Column";
import { ENTITY_TOKEN, EntityMetadata } from "../../decorators/Entity";
import { INDEX_TOKEN, IndexMetadata } from "../../decorators/Indexer";
import {
  UNIQUE_INDEX_TOKEN,
  UniqueIndexMetadata,
} from "../../decorators/UniqueIndex";
import {
  MANY_TO_ONE_TOKEN,
  ManyToOneMetadata,
} from "../../decorators/ManyToOne";
import {
  ONE_TO_ONE_TOKEN,
  OneToOneMetadata,
} from "../../decorators/OneToOne";
import {
  MANY_TO_MANY_TOKEN,
  ManyToManyMetadata,
} from "../../decorators/ManyToMany";
import { ColumnMetadata } from "../../scanner/ColumnScanner";
import { NamingStrategy, DefaultNamingStrategy } from "./NamingStrategy";

export type SchemaDialect = "mysql" | "postgres" | "sqlite";

export interface SchemaGeneratorOptions {
  dialect: SchemaDialect;
  schema?: string; // PostgreSQL schema (default: "public")
  namingStrategy?: NamingStrategy;
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
  private readonly namingStrategy: NamingStrategy;

  constructor(options: SchemaGeneratorOptions) {
    this.dialect = options.dialect;
    this.pgSchema = options.schema ?? "public";
    this.namingStrategy = options.namingStrategy ?? new DefaultNamingStrategy();
  }

  /**
   * 단일 엔티티에 대한 CREATE TABLE DDL을 생성합니다.
   */
  generateCreateTableDDL<T>(entity: ClazzType<T>): string {
    const tableName = this.getTableName(entity);
    const columns = this.getColumns(entity);

    // 복합 PK 감지: primary 컬럼이 2개 이상이면 복합 PK
    const pkColumns = columns.filter((col) => col.options.primary);
    const isCompositePk = pkColumns.length > 1;

    const columnDefs = columns.map((col) =>
      this.renderColumnDef(col, tableName, isCompositePk),
    );

    // 복합 PK인 경우 PRIMARY KEY (col1, col2, ...) 제약 조건 추가
    if (isCompositePk) {
      const pkDef = `PRIMARY KEY (${pkColumns.map((col) => this.wrapId(col.name)).join(", ")})`;
      columnDefs.push(pkDef);
    }

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
      const indexName = this.namingStrategy.indexName(tableName, idx.name);
      if (this.dialect === "postgres" || this.dialect === "sqlite") {
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
      const fkName = this.namingStrategy.foreignKeyName(tableName, fk.column, fk.referencedTable);
      return `ALTER TABLE ${this.wrapTable(tableName)} ADD CONSTRAINT ${fkName} FOREIGN KEY (${this.wrapId(fk.column)}) REFERENCES ${this.wrapTable(fk.referencedTable)}(${this.wrapId(fk.referencedColumn)}) ON DELETE NO ACTION ON UPDATE NO ACTION`;
    });
  }

  /**
   * 단일 엔티티에 대한 CREATE UNIQUE INDEX DDL 배열을 생성합니다.
   */
  generateUniqueIndexDDL<T>(entity: ClazzType<T>): string[] {
    const tableName = this.getTableName(entity);
    const uniqueIndexes = this.getUniqueIndexes(entity);
    return uniqueIndexes.map((uq) => {
      const indexName = uq.name ?? this.namingStrategy.uniqueIndexName(tableName, uq.columns);
      const columnList = uq.columns
        .map((col) => this.wrapId(col))
        .join(", ");
      if (this.dialect === "postgres" || this.dialect === "sqlite") {
        return `CREATE UNIQUE INDEX IF NOT EXISTS ${this.wrapId(indexName)} ON ${this.wrapTable(tableName)} (${columnList})`;
      }
      return `CREATE UNIQUE INDEX ${this.wrapId(indexName)} ON ${this.wrapTable(tableName)} (${columnList})`;
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
   * ManyToMany 관계의 중간 테이블 CREATE TABLE DDL을 생성합니다.
   * 소유측(joinTable이 있는 측)만 처리하며, 중복 테이블 이름은 건너뜁니다.
   */
  generateManyToManyJoinTableDDL(entities: ClazzType<any>[]): string[] {
    const ddls: string[] = [];
    const processedTables = new Set<string>();

    for (const entity of entities) {
      const m2mMeta = (Reflect.getMetadata(MANY_TO_MANY_TOKEN, entity) ??
        []) as ManyToManyMetadata<any>[];

      for (const rel of m2mMeta) {
        if (!rel.joinTable) continue;

        const { name, joinColumn, inverseJoinColumn } = rel.joinTable;
        if (processedTables.has(name)) continue;
        processedTables.add(name);

        const wrappedTable = this.wrapTable(name);
        const wrappedJoinCol = this.wrapId(joinColumn);
        const wrappedInverseCol = this.wrapId(inverseJoinColumn);

        const columnDefs = [
          `${wrappedJoinCol} INT NOT NULL`,
          `${wrappedInverseCol} INT NOT NULL`,
          `PRIMARY KEY (${wrappedJoinCol}, ${wrappedInverseCol})`,
        ];

        let ddl = `CREATE TABLE IF NOT EXISTS ${wrappedTable} (${columnDefs.join(", ")})`;
        if (this.dialect === "mysql") {
          ddl += " ENGINE=InnoDB";
        }
        ddls.push(ddl);
      }
    }

    return ddls;
  }

  /**
   * ManyToMany 관계의 중간 테이블에 대한 FOREIGN KEY DDL을 생성합니다.
   */
  generateManyToManyForeignKeyDDL(entities: ClazzType<any>[]): string[] {
    const ddls: string[] = [];
    const processedTables = new Set<string>();

    for (const entity of entities) {
      const m2mMeta = (Reflect.getMetadata(MANY_TO_MANY_TOKEN, entity) ??
        []) as ManyToManyMetadata<any>[];

      for (const rel of m2mMeta) {
        if (!rel.joinTable) continue;

        const { name, joinColumn, inverseJoinColumn } = rel.joinTable;
        if (processedTables.has(name)) continue;
        processedTables.add(name);

        const ownerTable = this.getTableName(entity);
        const relatedEntity = rel.getRelatedEntity() as ClazzType<any>;
        const relatedTable = this.getTableName(relatedEntity);

        const ownerPk = this.findPrimaryKeyColumn(entity);
        const relatedPk = this.findPrimaryKeyColumn(relatedEntity);

        if (ownerPk) {
          const fkName = this.namingStrategy.foreignKeyName(name, joinColumn, ownerTable);
          ddls.push(
            `ALTER TABLE ${this.wrapTable(name)} ADD CONSTRAINT ${fkName} FOREIGN KEY (${this.wrapId(joinColumn)}) REFERENCES ${this.wrapTable(ownerTable)}(${this.wrapId(ownerPk)}) ON DELETE CASCADE ON UPDATE CASCADE`,
          );
        }

        if (relatedPk) {
          const fkName = this.namingStrategy.foreignKeyName(name, inverseJoinColumn, relatedTable);
          ddls.push(
            `ALTER TABLE ${this.wrapTable(name)} ADD CONSTRAINT ${fkName} FOREIGN KEY (${this.wrapId(inverseJoinColumn)}) REFERENCES ${this.wrapTable(relatedTable)}(${this.wrapId(relatedPk)}) ON DELETE CASCADE ON UPDATE CASCADE`,
          );
        }
      }
    }

    return ddls;
  }

  /**
   * ManyToMany 관계의 중간 테이블 DROP TABLE DDL을 생성합니다.
   */
  generateManyToManyDropDDL(entities: ClazzType<any>[]): string[] {
    const ddls: string[] = [];
    const processedTables = new Set<string>();

    for (const entity of entities) {
      const m2mMeta = (Reflect.getMetadata(MANY_TO_MANY_TOKEN, entity) ??
        []) as ManyToManyMetadata<any>[];

      for (const rel of m2mMeta) {
        if (!rel.joinTable) continue;

        const { name } = rel.joinTable;
        if (processedTables.has(name)) continue;
        processedTables.add(name);

        ddls.push(`DROP TABLE IF EXISTS ${this.wrapTable(name)}`);
      }
    }

    return ddls;
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

    // 3. CREATE UNIQUE INDEX
    for (const entity of entities) {
      ddls.push(...this.generateUniqueIndexDDL(entity));
    }

    // 4. ADD FOREIGN KEY (테이블 생성 후)
    for (const entity of entities) {
      ddls.push(...this.generateForeignKeyDDL(entity));
    }

    // 5. ManyToMany 중간 테이블
    ddls.push(...this.generateManyToManyJoinTableDDL(entities));

    // 6. ManyToMany 중간 테이블 FK
    ddls.push(...this.generateManyToManyForeignKeyDDL(entities));

    return ddls;
  }

  /**
   * 여러 엔티티에 대한 DROP TABLE DDL을 역순으로 생성합니다 (FK 의존성).
   */
  generateDropSchemaDDL(entities: ClazzType<any>[]): string[] {
    const ddls: string[] = [];

    // 중간 테이블을 먼저 DROP (FK 의존성)
    ddls.push(...this.generateManyToManyDropDDL(entities));

    // 엔티티 테이블을 역순으로 DROP
    ddls.push(...[...entities].reverse().map((e) => this.generateDropTableDDL(e)));

    return ddls;
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

  private getUniqueIndexes<T>(entity: ClazzType<T>): UniqueIndexMetadata[] {
    return (
      (Reflect.getMetadata(UNIQUE_INDEX_TOKEN, entity) as
        | UniqueIndexMetadata[]
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

  /**
   * 엔티티의 모든 PK 컬럼 이름을 반환합니다.
   */
  findPrimaryKeyColumns<T>(entity: ClazzType<T>): string[] {
    const columns = this.getColumns(entity);
    return columns
      .filter((col) => col.options.primary)
      .map((col) => col.name);
  }

  private renderColumnDef(
    col: ColumnDef,
    tableName: string,
    isCompositePk = false,
  ): string {
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
      const pk = options.primary && !isCompositePk ? " PRIMARY KEY" : "";
      return `${this.wrapId(name)} SERIAL ${nullable}${pk}`;
    }

    // SQLite: INTEGER PRIMARY KEY AUTOINCREMENT
    if (options.autoIncrement && this.dialect === "sqlite") {
      return `${this.wrapId(name)} INTEGER PRIMARY KEY AUTOINCREMENT`;
    }

    // 길이 처리
    const alreadyHasParens = type.includes("(");
    const needsLength =
      !alreadyHasParens && options.length && options.length > 0;
    const typeWithLength = needsLength ? `${type}(${options.length})` : type;

    const nullable = options.nullable ? "NULL" : "NOT NULL";
    // 복합 PK일 때는 인라인 PRIMARY KEY를 생략 (테이블 레벨에서 추가)
    const pk = options.primary && !isCompositePk ? " PRIMARY KEY" : "";
    const autoInc =
      options.autoIncrement && this.dialect === "mysql"
        ? " AUTO_INCREMENT"
        : "";

    // DEFAULT clause
    const defaultClause = this.renderDefaultClause(options.default);

    return `${this.wrapId(name)} ${typeWithLength} ${nullable}${defaultClause}${pk}${autoInc}`;
  }

  /**
   * Renders the DEFAULT clause for a column definition.
   * Parenthesized values like "(CURRENT_TIMESTAMP)" are treated as raw SQL expressions.
   */
  private renderDefaultClause(value: string | number | boolean | null | undefined): string {
    if (value === undefined) return "";
    if (value === null) return " DEFAULT NULL";
    if (typeof value === "number") return ` DEFAULT ${value}`;
    if (typeof value === "boolean") {
      if (this.dialect === "mysql") return ` DEFAULT ${value ? "1" : "0"}`;
      return ` DEFAULT ${value ? "TRUE" : "FALSE"}`;
    }
    // Parenthesized strings → raw SQL expression
    if (typeof value === "string" && value.startsWith("(") && value.endsWith(")")) {
      return ` DEFAULT ${value.slice(1, -1)}`;
    }
    // String literal — escape single quotes
    return ` DEFAULT '${value.replace(/'/g, "''")}'`;
  }

  private castType(type: ColumnType): string {
    if (this.dialect === "sqlite") {
      return this.castTypeSqlite(type);
    }
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
      case "timestamptz":
        return "DATETIME";
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
      case "timestamptz":
        return "TIMESTAMPTZ";
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

  private castTypeSqlite(type: ColumnType): string {
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
      default:
        return type as string;
    }
  }

  private wrapId(name: string): string {
    if (this.dialect === "postgres" || this.dialect === "sqlite") {
      return `"${name.replace(/"/g, '""')}"`;
    }
    return `\`${name.replace(/`/g, "``")}\``;
  }

  private wrapTable(name: string): string {
    if (this.dialect === "postgres") {
      return `"${this.pgSchema}"."${name.replace(/"/g, '""')}"`;
    }
    if (this.dialect === "sqlite") {
      return `"${name.replace(/"/g, '""')}"`;
    }
    return `\`${name.replace(/`/g, "``")}\``;
  }

  /**
   * FK 제약 조건 이름을 해시 기반으로 생성합니다.
   * SHA1 해시의 앞 8자를 사용하여 고유성을 보장하며,
   * MySQL 64자 / PostgreSQL 63자 제한을 준수합니다.
   *
   * @deprecated Use `NamingStrategy.foreignKeyName()` instead.
   * This static method is kept for backward compatibility with existing driver code.
   *
   * @param tableName - 소스 테이블 이름
   * @param column - FK 컬럼 이름
   * @param refTable - 참조 대상 테이블 이름
   * @returns 63자 이하의 고유 FK 이름
   */
  static generateForeignKeyName(tableName: string, column: string, refTable: string): string {
    const raw = `${tableName}_${column}_${refTable}`;
    const hash = crypto.createHash("sha1").update(raw).digest("hex").slice(0, 8);
    const base = `fk_${tableName}_${hash}`;
    // MySQL 최대 64자, PostgreSQL 최대 63자 → 63자로 통일
    return base.length > 63 ? `fk_${hash}` : base;
  }
}
