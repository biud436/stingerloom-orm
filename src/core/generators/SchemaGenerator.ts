/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import crypto from "crypto";
import { ClazzType } from "../../utils";
import { COLUMN_TOKEN, ColumnOption, ColumnType } from "../../decorators/Column";
import { ENTITY_TOKEN, EntityMetadata } from "../../decorators/Entity";
import {
  INDEX_TOKEN,
  IndexMetadata,
  COMPOSITE_INDEX_TOKEN,
  CompositeIndexMetadata,
  AdvancedIndexOptions,
} from "../../decorators/Indexer";
import {
  UNIQUE_INDEX_TOKEN,
  UniqueIndexMetadata,
} from "../../decorators/UniqueIndex";
import {
  FULLTEXT_INDEX_TOKEN,
  FullTextIndexMetadata,
} from "../../decorators/FullTextIndex";
import { ReferentialAction } from "../../types/ReferentialAction";
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
import { PrimaryKeyNotFoundError } from "../../errors/PrimaryKeyNotFoundError";
import { COMPUTED_COLUMN_TOKEN, ComputedColumnMetadata } from "../../decorators/ComputedColumn";

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
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
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
    if (pkColumns.length === 0) {
      throw new PrimaryKeyNotFoundError(tableName);
    }
    const isCompositePk = pkColumns.length > 1;

    const columnDefs = columns.map((col) =>
      this.renderColumnDef(col, tableName, isCompositePk),
    );

    // Computed/generated columns
    const computedMeta: ComputedColumnMetadata[] =
      Reflect.getMetadata(COMPUTED_COLUMN_TOKEN, entity.prototype) ?? [];
    for (const cc of computedMeta) {
      const colType = cc.options.type ? this.castType(cc.options.type) : "TEXT";
      const length = cc.options.length ? `(${cc.options.length})` : "";
      const nullable = cc.options.nullable === false ? " NOT NULL" : "";
      const storedOrVirtual = cc.options.stored ? "STORED" : "VIRTUAL";
      columnDefs.push(
        `${this.wrapId(cc.name)} ${colType}${length}${nullable} GENERATED ALWAYS AS (${cc.options.expression}) ${storedOrVirtual}`,
      );
    }

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
   * @Index() property decorator stores the TypeScript property key;
   * this method resolves it to the actual DB column name via @Column({ name }) (#176).
   */
  generateCreateIndexDDL<T>(entity: ClazzType<T>): string[] {
    const tableName = this.getTableName(entity);
    const indexes = this.getIndexes(entity);
    const propColMap = this.buildPropertyToColumnMap(entity);
    return indexes.map((idx) => {
      // idx.name is the property key; resolve to actual DB column name
      const columnName = propColMap.get(idx.name) ?? idx.name;
      const indexName = this.namingStrategy.indexName(tableName, columnName);
      if (this.dialect === "postgres" || this.dialect === "sqlite") {
        return `CREATE INDEX IF NOT EXISTS ${this.wrapId(indexName)} ON ${this.wrapTable(tableName)} (${this.wrapId(columnName)})`;
      }
      return `CREATE INDEX ${this.wrapId(indexName)} ON ${this.wrapTable(tableName)} (${this.wrapId(columnName)})`;
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
      const onDelete = fk.onDelete ?? "NO ACTION";
      const onUpdate = fk.onUpdate ?? "NO ACTION";
      return `ALTER TABLE ${this.wrapTable(tableName)} ADD CONSTRAINT ${fkName} FOREIGN KEY (${this.wrapId(fk.column)}) REFERENCES ${this.wrapTable(fk.referencedTable)}(${this.wrapId(fk.referencedColumn)}) ON DELETE ${onDelete} ON UPDATE ${onUpdate}`;
    });
  }

  /**
   * 단일 엔티티에 대한 CREATE UNIQUE INDEX DDL 배열을 생성합니다.
   */
  generateUniqueIndexDDL<T>(entity: ClazzType<T>): string[] {
    const tableName = this.getTableName(entity);
    const uniqueIndexes = this.getUniqueIndexes(entity);
    const propColMap = this.buildPropertyToColumnMap(entity);
    return uniqueIndexes.map((uq) => {
      // Resolve property keys to actual DB column names (#176)
      const resolvedColumns = uq.columns.map((col) => propColMap.get(col) ?? col);
      const indexName = uq.name ?? this.namingStrategy.uniqueIndexName(tableName, resolvedColumns);
      const columnList = resolvedColumns
        .map((col) => this.wrapId(col))
        .join(", ");
      if (this.dialect === "postgres" || this.dialect === "sqlite") {
        return `CREATE UNIQUE INDEX IF NOT EXISTS ${this.wrapId(indexName)} ON ${this.wrapTable(tableName)} (${columnList})`;
      }
      return `CREATE UNIQUE INDEX ${this.wrapId(indexName)} ON ${this.wrapTable(tableName)} (${columnList})`;
    });
  }

  /**
   * 단일 엔티티에 대한 CREATE INDEX DDL 배열을 생성합니다 (class-level composite indexes).
   * Supports advanced options: USING, WHERE, expression, INCLUDE.
   */
  generateCompositeIndexDDL<T>(entity: ClazzType<T>): string[] {
    const tableName = this.getTableName(entity);
    const compositeIndexes = this.getCompositeIndexes(entity);
    return compositeIndexes.map((ci) => {
      const opts = ci.options;
      const indexName =
        ci.name ?? opts?.name ?? this.namingStrategy.compositeIndexName(tableName, ci.columns);

      return this.buildAdvancedIndexDDL(tableName, indexName, ci.columns, opts);
    });
  }

  /**
   * Builds a CREATE INDEX DDL with optional advanced features.
   * Unsupported features for a given dialect are silently skipped.
   */
  private buildAdvancedIndexDDL(
    tableName: string,
    indexName: string,
    columns: string[],
    opts?: AdvancedIndexOptions,
  ): string {
    const ifNotExists = (this.dialect === "postgres" || this.dialect === "sqlite")
      ? "IF NOT EXISTS " : "";

    // USING clause
    let usingClause = "";
    if (opts?.using) {
      const method = opts.using.toLowerCase();
      if (this.dialect === "mysql") {
        // MySQL only supports btree and hash
        if (method === "btree" || method === "hash") {
          usingClause = ` USING ${method.toUpperCase()}`;
        }
        // Other methods silently skipped for MySQL
      } else {
        // PostgreSQL/SQLite support all methods
        usingClause = ` USING ${method}`;
      }
    }

    // Column list or expression
    let columnExpr: string;
    if (opts?.expression) {
      columnExpr = `(${opts.expression})`;
    } else {
      columnExpr = `(${columns.map((col) => this.wrapId(col)).join(", ")})`;
    }

    // INCLUDE clause (PostgreSQL only)
    let includeClause = "";
    if (opts?.include && opts.include.length > 0 && this.dialect === "postgres") {
      const includeCols = opts.include.map((col) => this.wrapId(col)).join(", ");
      includeClause = ` INCLUDE (${includeCols})`;
    }

    // WHERE clause (partial index — PostgreSQL and SQLite only)
    let whereClause = "";
    if (opts?.where && this.dialect !== "mysql") {
      whereClause = ` WHERE ${opts.where}`;
    }

    return `CREATE INDEX ${ifNotExists}${this.wrapId(indexName)} ON ${this.wrapTable(tableName)}${usingClause} ${columnExpr}${includeClause}${whereClause}`;
  }

  /**
   * 단일 엔티티에 대한 FULLTEXT / GIN 인덱스 DDL 배열을 생성합니다.
   *
   * - PostgreSQL: `CREATE INDEX ... USING gin (to_tsvector('lang', col1 || ' ' || col2))`
   * - MySQL: `CREATE FULLTEXT INDEX ... ON table (col1, col2)`
   * - SQLite: not supported (returns empty array).
   */
  generateFullTextIndexDDL<T>(entity: ClazzType<T>): string[] {
    if (this.dialect === "sqlite") return [];

    const tableName = this.getTableName(entity);
    const ftIndexes = this.getFullTextIndexes(entity);
    return ftIndexes.map((ft) => {
      const indexName =
        ft.name ?? `fts_${tableName}_${ft.columns.join("_")}`;

      if (this.dialect === "postgres") {
        const lang = ft.language ?? "english";
        const expr = ft.columns.length === 1
          ? `to_tsvector('${lang}', ${this.wrapId(ft.columns[0])})`
          : `to_tsvector('${lang}', ${ft.columns.map((c) => this.wrapId(c)).join(" || ' ' || ")})`;
        return `CREATE INDEX IF NOT EXISTS ${this.wrapId(indexName)} ON ${this.wrapTable(tableName)} USING gin (${expr})`;
      }

      // MySQL: FULLTEXT INDEX
      const columnList = ft.columns
        .map((c) => this.wrapId(c))
        .join(", ");
      return `CREATE FULLTEXT INDEX ${this.wrapId(indexName)} ON ${this.wrapTable(tableName)} (${columnList})`;
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
   * Join column types are derived from the actual PK types of the referenced entities (#178).
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

        // Derive join column types from the actual PK types (#178)
        const ownerPkType = this.findPrimaryKeyColumnType(entity);
        const relatedEntity = rel.getRelatedEntity() as ClazzType<any>;
        const relatedPkType = this.findPrimaryKeyColumnType(relatedEntity);

        const columnDefs = [
          `${wrappedJoinCol} ${ownerPkType} NOT NULL`,
          `${wrappedInverseCol} ${relatedPkType} NOT NULL`,
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

    // 2. CREATE INDEX (single-column)
    for (const entity of entities) {
      ddls.push(...this.generateCreateIndexDDL(entity));
    }

    // 2b. CREATE INDEX (composite)
    for (const entity of entities) {
      ddls.push(...this.generateCompositeIndexDDL(entity));
    }

    // 2c. CREATE FULLTEXT/GIN INDEX
    for (const entity of entities) {
      ddls.push(...this.generateFullTextIndexDDL(entity));
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

  /**
   * Builds a map from TypeScript property keys to actual DB column names.
   * Used to resolve @Index() property decorator names to the correct column (#176).
   */
  private buildPropertyToColumnMap<T>(entity: ClazzType<T>): Map<string, string> {
    const columns = (Reflect.getMetadata(COLUMN_TOKEN, entity.prototype) ??
      []) as ColumnMetadata[];
    const map = new Map<string, string>();
    for (const col of columns) {
      if (col.propertyKey && col.name) {
        map.set(col.propertyKey, col.name);
      }
    }
    return map;
  }

  private getIndexes<T>(entity: ClazzType<T>): IndexMetadata[] {
    return (
      (Reflect.getMetadata(INDEX_TOKEN, entity.prototype) as
        | IndexMetadata[]
        | undefined) ?? []
    );
  }

  private getCompositeIndexes<T>(entity: ClazzType<T>): CompositeIndexMetadata[] {
    return (
      (Reflect.getMetadata(COMPOSITE_INDEX_TOKEN, entity) as
        | CompositeIndexMetadata[]
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

  private getFullTextIndexes<T>(entity: ClazzType<T>): FullTextIndexMetadata[] {
    return (
      (Reflect.getMetadata(FULLTEXT_INDEX_TOKEN, entity) as
        | FullTextIndexMetadata[]
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
      if (rel.option?.createForeignKeyConstraints === false) continue;
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
          onDelete: rel.option?.onDelete,
          onUpdate: rel.option?.onUpdate,
        });
      }
    }

    // OneToOne (소유측 — joinColumn이 있는 경우)
    const oneToOnes = (Reflect.getMetadata(ONE_TO_ONE_TOKEN, entity) ??
      []) as OneToOneMetadata<any>[];

    for (const rel of oneToOnes) {
      if (!rel.joinColumn) continue;
      if (rel.option?.createForeignKeyConstraints === false) continue;
      const relatedEntity = rel.getRelatedEntity();
      const relatedTable = this.getTableName(relatedEntity);
      const relatedPk = this.findPrimaryKeyColumn(relatedEntity);
      if (relatedPk) {
        fks.push({
          column: rel.joinColumn,
          referencedTable: relatedTable,
          referencedColumn: relatedPk,
          onDelete: rel.option?.onDelete,
          onUpdate: rel.option?.onUpdate,
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
   * Finds the first PK column's SQL type string for the given entity.
   * Used by ManyToMany join table DDL to derive the correct column type
   * instead of hard-coding INT (#178).
   */
  private findPrimaryKeyColumnType<T>(entity: ClazzType<T>): string {
    const columns = this.getColumns(entity);
    const pk = columns.find((col) => col.options.primary);
    if (!pk) return this.castType("int"); // fallback

    const colType = pk.options.type ?? "int";
    let sqlType = this.castType(colType);

    // Handle length for varchar/char types
    if (pk.options.length && pk.options.length > 0 && !sqlType.includes("(")
        && (colType === "varchar" || colType === "char")) {
      sqlType = `${sqlType}(${pk.options.length})`;
    }

    // Handle precision/scale (e.g., DECIMAL)
    if (sqlType.includes("$precision")) {
      sqlType = sqlType.replace("$precision", (pk.options.precision ?? 10).toString());
      sqlType = sqlType.replace("$scale", (pk.options.scale ?? 2).toString());
    }

    // Handle boolean MySQL placeholder
    if (colType === "boolean" && this.dialect === "mysql") {
      sqlType = sqlType.replace("$n", (pk.options.length ?? 1).toString());
    }

    return sqlType;
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
      return ` DEFAULT ${value}`;
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
