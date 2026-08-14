/* eslint-disable @typescript-eslint/no-explicit-any */
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
import {
  JSON_INDEX_TOKEN,
  JsonIndexMetadata,
} from "../../decorators/JsonIndex";
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
import { escapeSqlLiteral } from "../../utils/escapeSqlLiteral";
import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";
import {
  RELATION_COLUMN_TOKEN,
  RelationColumnMetadata,
} from "../../decorators/RelationColumn";
import { NamingStrategy, DefaultNamingStrategy } from "./NamingStrategy";
import { RelationMetadataResolver } from "../RelationMetadataResolver";
import { buildPropertyToColumnMap as buildSharedPropertyToColumnMap } from "../PropertyColumnMap";
import { inferRelatedPkType } from "./RelatedPkTypeResolver";
import { PrimaryKeyNotFoundError } from "../../errors/PrimaryKeyNotFoundError";
import { COMPUTED_COLUMN_TOKEN, ComputedColumnMetadata } from "../../decorators/ComputedColumn";
import { renderComputedColumnExpression } from "../expressions/ComputedColumnExpression";
import type { ColumnResolver } from "../expressions/ConditionLike";
import {
  ColumnDefinitionBuilder,
  createColumnDefinitionBuilder,
} from "../../dialects/ColumnDefinitionBuilder";
import type { CommonCapabilities } from "../../dialects/DialectCapabilities";
import type { DbVersion } from "../../dialects/DbVersion";

/**
 * Shared stateless strategy backing the deprecated static
 * {@link SchemaGenerator.generateForeignKeyName} forwarder, so the SHA1 FK
 * naming algorithm lives in exactly one place.
 */
const DEFAULT_NAMING_STRATEGY = new DefaultNamingStrategy();

export type SchemaDialect = "mysql" | "postgres" | "sqlite";

export interface SchemaGeneratorOptions {
  dialect: SchemaDialect;
  schema?: string; // PostgreSQL schema (default: "public")
  namingStrategy?: NamingStrategy;
  /** Feature capabilities of the connected database version. */
  capabilities?: CommonCapabilities;
  /** Database version (used for error messages). */
  version?: DbVersion;
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
 * DDL generator. Reads entity metadata and produces CREATE TABLE / DROP TABLE DDL strings.
 * It only generates DDL strings without requiring a real DB connection, so it can be unit-tested.
 */
export class SchemaGenerator {
  private readonly dialect: SchemaDialect;
  private readonly pgSchema: string;
  private readonly namingStrategy: NamingStrategy;
  private readonly columnDefBuilder: ColumnDefinitionBuilder;
  private readonly capabilities?: CommonCapabilities;
  private readonly version?: DbVersion;
  /** Lazily created FK shadow-property mapping source for index DDL resolution. */
  private relationResolver?: RelationMetadataResolver;

  constructor(options: SchemaGeneratorOptions) {
    this.dialect = options.dialect;
    this.pgSchema = options.schema ?? "public";
    this.namingStrategy = options.namingStrategy ?? new DefaultNamingStrategy();
    this.capabilities = options.capabilities;
    this.version = options.version;
    this.columnDefBuilder = createColumnDefinitionBuilder(
      this.dialect,
      this.pgSchema,
      options.capabilities,
    );
  }

  /**
   * Generates the CREATE TABLE DDL for a single entity.
   */
  generateCreateTableDDL<T>(entity: ClazzType<T>): string {
    const tableName = this.getTableName(entity);
    const columns = this.getColumns(entity);

    // Composite PK detection: two or more primary columns means a composite PK.
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
      const expression = this.resolveComputedExpression(cc);
      columnDefs.push(
        `${this.wrapId(cc.name)} ${colType}${length}${nullable} GENERATED ALWAYS AS (${expression}) ${storedOrVirtual}`,
      );
    }

    // For a composite PK, append the PRIMARY KEY (col1, col2, ...) constraint.
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
   * Generates the array of CREATE INDEX DDL statements for a single entity.
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
   * Generates the array of ALTER TABLE ... ADD FOREIGN KEY DDL statements for a single entity.
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
   * Generates the array of CREATE UNIQUE INDEX DDL statements for a single entity.
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
   * Generates the array of CREATE INDEX DDL statements for a single entity (class-level composite indexes).
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

    // INCLUDE clause (PostgreSQL 11+ only)
    let includeClause = "";
    if (opts?.include && opts.include.length > 0 && this.dialect === "postgres") {
      const caps = this.capabilities as Record<string, boolean> | undefined;
      if (!caps || caps.supportsIndexInclude !== false) {
        const includeCols = opts.include.map((col) => this.wrapId(col)).join(", ");
        includeClause = ` INCLUDE (${includeCols})`;
      }
      // Silently skip INCLUDE for PG < 11
    }

    // WHERE clause (partial index — PostgreSQL and SQLite only)
    let whereClause = "";
    if (opts?.where && this.dialect !== "mysql") {
      whereClause = ` WHERE ${opts.where}`;
    }

    return `CREATE INDEX ${ifNotExists}${this.wrapId(indexName)} ON ${this.wrapTable(tableName)}${usingClause} ${columnExpr}${includeClause}${whereClause}`;
  }

  /**
   * Generates the array of FULLTEXT / GIN index DDL statements for a single entity.
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
        // #285: validate + escape the text-search configuration name so it
        // can't break out of the SQL literal. Postgres `regconfig` values
        // are identifier-shaped (letters/digits/underscore), so reject
        // anything outside that grammar before applying defense-in-depth
        // escaping.
        const lang = sanitizeFullTextLanguage(ft.language ?? "english");
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
   * Emit CREATE INDEX DDL for `@JsonIndex()` declarations.
   *
   * - PostgreSQL: `CREATE INDEX ... USING gin ((col -> 'path') [opclass])`
   *   (or `USING gin (col [opclass])` when no path is supplied; `USING btree
   *   ((col #>> '{path}'))` when `using: "btree"` is requested).
   * - MySQL/SQLite: returns an empty array. Functional JSON indexing on
   *   MySQL requires virtual generated columns which must be declared on
   *   the table itself, not inferred from an index-only decorator; SQLite
   *   has no GIN equivalent at all.
   */
  generateJsonIndexDDL<T>(entity: ClazzType<T>): string[] {
    if (this.dialect !== "postgres") {
      // Stay silent here. Users who adopt @JsonIndex for MySQL / SQLite
      // portability should be told once at startup (handled outside this
      // pure DDL-string generator), not per entity per sync.
      return [];
    }

    const tableName = this.getTableName(entity);
    const jsonIndexes = this.getJsonIndexes(entity);
    if (jsonIndexes.length === 0) return [];

    const propertyToColumnMap = this.buildPropertyToColumnMap(entity);

    return jsonIndexes.map((ji) => {
      const columnName =
        propertyToColumnMap.get(ji.propertyKey) ?? ji.propertyKey;
      const wrappedCol = this.wrapId(columnName);

      const using = ji.options.using ?? "gin";
      const indexName =
        ji.options.name ??
        this.namingStrategy.jsonIndexName(tableName, columnName, ji.pathSegments, using);

      // Expression for the index column list
      let columnExpr: string;
      if (ji.pathSegments.length === 0) {
        // Whole-column index
        columnExpr = wrappedCol;
      } else if (using === "btree") {
        // Leaf text extraction for ordering / equality scans.
        const pathLit = this.pgPathArrayLiteral(ji.pathSegments);
        columnExpr = `(${wrappedCol} #>> ${pathLit})`;
      } else {
        // GIN on a jsonb subtree — chain `->` so the expression matches
        // `jsonb_ops` / `jsonb_path_ops` opclasses.
        columnExpr = `(${this.pgNavigateExpression(wrappedCol, ji.pathSegments)})`;
      }

      // Append opclass when meaningful (PG GIN on jsonb).
      const opclass =
        using === "gin" && ji.options.opclass ? ` ${ji.options.opclass}` : "";

      const whereClause = ji.options.where ? ` WHERE ${ji.options.where}` : "";

      return `CREATE INDEX IF NOT EXISTS ${this.wrapId(indexName)} ON ${this.wrapTable(tableName)} USING ${using} (${columnExpr}${opclass})${whereClause}`;
    });
  }

  /**
   * Build a PG text[] path literal (`'{a,b,0,c}'::text[]`) suitable for the
   * `#>>` operator. Segments are escaped for the PG array syntax. Numeric
   * segments are emitted bare (PG coerces during `#>>`).
   */
  private pgPathArrayLiteral(
    path: ReadonlyArray<string | number>,
  ): string {
    const escaped = path.map((s) => {
      if (typeof s === "number") return String(s);
      // Quote segments containing special characters for PG array syntax;
      // escape embedded quotes and backslashes.
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)) return s;
      return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    });
    return `'{${escaped.join(",")}}'::text[]`;
  }

  /**
   * Build a chained `-> ` / `-> N` navigation expression
   * (`"col" -> 'a' -> 0 -> 'b'`). Used inside the GIN index expression.
   */
  private pgNavigateExpression(
    wrappedColumn: string,
    path: ReadonlyArray<string | number>,
  ): string {
    let acc = wrappedColumn;
    for (const seg of path) {
      if (typeof seg === "number") {
        acc = `${acc} -> ${seg}`;
      } else {
        const literal = `'${seg.replace(/'/g, "''")}'`;
        acc = `${acc} -> ${literal}`;
      }
    }
    return acc;
  }

  /**
   * Generates a DROP TABLE DDL.
   */
  generateDropTableDDL<T>(entity: ClazzType<T>): string {
    const tableName = this.getTableName(entity);
    return `DROP TABLE IF EXISTS ${this.wrapTable(tableName)}`;
  }

  /**
   * Generates CREATE TABLE DDL for ManyToMany join tables.
   * Only processes the owning side (the side that declares joinTable); duplicate table names are skipped.
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
   * Generates FOREIGN KEY DDL for ManyToMany join tables.
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
   * Generates DROP TABLE DDL for ManyToMany join tables.
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
   * Generates CREATE TABLE + INDEX + FK DDL for multiple entities.
   */
  generateSchemaDDL(entities: ClazzType<any>[]): string[] {
    const ddls: string[] = [];

    // 1. CREATE TABLE (in order)
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

    // 2d. CREATE JSON-PATH INDEX (PG only; no-op elsewhere)
    for (const entity of entities) {
      ddls.push(...this.generateJsonIndexDDL(entity));
    }

    // 3. CREATE UNIQUE INDEX
    for (const entity of entities) {
      ddls.push(...this.generateUniqueIndexDDL(entity));
    }

    // 4. ADD FOREIGN KEY (after tables are created)
    for (const entity of entities) {
      ddls.push(...this.generateForeignKeyDDL(entity));
    }

    // 5. ManyToMany join tables
    ddls.push(...this.generateManyToManyJoinTableDDL(entities));

    // 6. ManyToMany join table FKs
    ddls.push(...this.generateManyToManyForeignKeyDDL(entities));

    return ddls;
  }

  /**
   * Generates DROP TABLE DDL for multiple entities in reverse order (due to FK dependencies).
   */
  generateDropSchemaDDL(entities: ClazzType<any>[]): string[] {
    const ddls: string[] = [];

    // Drop join tables first (FK dependencies)
    ddls.push(...this.generateManyToManyDropDDL(entities));

    // Drop entity tables in reverse order
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
    const result = columns.map((col) => ({
      name: col.name ?? "unknown",
      options: (col.options ?? {
        type: "varchar" as ColumnType,
        length: 255,
        nullable: false,
      }) as ColumnOption,
    }));

    // Add @RelationColumn virtual columns (when there is no matching @Column)
    const relationColumns: RelationColumnMetadata[] =
      Reflect.getMetadata(RELATION_COLUMN_TOKEN, entity) ??
      Reflect.getMetadata(RELATION_COLUMN_TOKEN, entity.prototype) ??
      [];
    const existingNames = new Set(result.map((c) => c.name));

    for (const rc of relationColumns) {
      const fkName = rc.name ?? `${rc.propertyKey}Id`;
      if (existingNames.has(fkName)) continue; // @Column already declared

      // Determine the FK column type: option.type → inferred target PK type → fallback "int"
      const fkType: ColumnType = rc.type ?? inferRelatedPkType(entity, rc.propertyKey) ?? "int";

      result.push({
        name: fkName,
        options: {
          type: fkType,
          nullable: rc.nullable ?? true,
        } as ColumnOption,
      });
    }

    return result;
  }

  /**
   * Resolve a computed column's expression to a literal SQL string.
   *
   * The literal-string form is embedded verbatim. The builder form is
   * invoked with this generator's dialect, so one definition yields
   * dialect-correct DDL on every driver — and because the builder runs per
   * generator (each connection has its own), it is multi-DB safe: nothing is
   * cached back onto the shared decorator metadata.
   */
  private resolveComputedExpression(cc: ComputedColumnMetadata): string {
    const expression = cc.options.expression;
    if (typeof expression === "string") {
      return expression;
    }
    const resolveColumn: ColumnResolver = (name) => this.wrapId(name);
    return renderComputedColumnExpression(
      expression,
      this.dialect,
      resolveColumn,
    );
  }

  /**
   * Builds a map from TypeScript property keys to actual DB column names.
   * Used to resolve @Index() / @UniqueIndex() / @JsonIndex() property names
   * to the correct column (#176).
   *
   * Delegates to the shared {@link buildSharedPropertyToColumnMap} helper so
   * `@RelationColumn` FK shadow properties (e.g. `workspaceId` backing a
   * `workspace` relation with FK column `workspace_id`) resolve to the FK
   * column this generator actually emits in CREATE TABLE. Previously only
   * `@Column` metadata was consulted, so an `@Index()` on a shadow property
   * produced DDL against the nonexistent camelCase column — which
   * `continueOnError` then swallowed, silently dropping the index.
   */
  private buildPropertyToColumnMap<T>(entity: ClazzType<T>): Map<string, string> {
    const columns = (Reflect.getMetadata(COLUMN_TOKEN, entity.prototype) ??
      []) as ColumnMetadata[];
    this.relationResolver ??= new RelationMetadataResolver();
    return buildSharedPropertyToColumnMap(
      { target: entity, columns },
      this.relationResolver,
    );
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

  private getJsonIndexes<T>(entity: ClazzType<T>): JsonIndexMetadata[] {
    return (
      (Reflect.getMetadata(JSON_INDEX_TOKEN, entity) as
        | JsonIndexMetadata[]
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

    // OneToOne (owning side — when joinColumn is present)
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
   * Returns the names of all PK columns on the given entity.
   */
  findPrimaryKeyColumns<T>(entity: ClazzType<T>): string[] {
    const columns = this.getColumns(entity);
    return columns
      .filter((col) => col.options.primary)
      .map((col) => col.name);
  }

  private renderColumnDef(
    col: ColumnDef,
    _tableName: string,
    isCompositePk = false,
  ): string {
    return this.columnDefBuilder.buildColumnDef(col.options, {
      columnName: col.name,
      tableName: _tableName,
      isCompositePk,
    });
  }

  private castType(type: ColumnType): string {
    return this.columnDefBuilder.castType(type);
  }

  private wrapId(name: string): string {
    return this.columnDefBuilder.wrapIdentifier(name);
  }

  private wrapTable(name: string): string {
    if (this.dialect === "postgres") {
      return `"${this.pgSchema.replace(/"/g, '""')}"."${name.replace(/"/g, '""')}"`;

    }
    if (this.dialect === "sqlite") {
      return `"${name.replace(/"/g, '""')}"`;
    }
    return `\`${name.replace(/`/g, "``")}\``;
  }

  /**
   * Generates a hash-based FK constraint name.
   * Uses the first 8 characters of a SHA1 hash to guarantee uniqueness
   * while fitting within MySQL's 64-char and PostgreSQL's 63-char identifier limits.
   *
   * @deprecated Use `NamingStrategy.foreignKeyName()` instead. Removal target: 2.0.
   * This static method is kept for backward compatibility with existing driver
   * code and now forwards to {@link DefaultNamingStrategy.foreignKeyName} so a
   * single hash implementation backs both entry points.
   *
   * @param tableName - Source table name
   * @param column - FK column name
   * @param refTable - Referenced table name
   * @returns A unique FK name no longer than 63 characters
   */
  static generateForeignKeyName(tableName: string, column: string, refTable: string): string {
    return DEFAULT_NAMING_STRATEGY.foreignKeyName(tableName, column, refTable);
  }
}

// #285: PostgreSQL regconfig identifiers are letters/digits/underscore. Reject
// anything outside that grammar so a malicious `language` option cannot break
// out of the to_tsvector literal at startup. Defense-in-depth escape applied
// even on the validated path, since the value is interpolated into a literal.
const FULLTEXT_LANGUAGE_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function sanitizeFullTextLanguage(value: string): string {
  if (!FULLTEXT_LANGUAGE_PATTERN.test(value)) {
    throw new OrmError(
      OrmErrorCode.VALIDATION_ERROR,
      `Invalid @FullTextIndex language: "${value}". Expected a PostgreSQL ` +
        `text-search configuration identifier (letters, digits, underscore).`,
      "Use a valid regconfig name such as 'english', 'simple', 'korean'.",
    );
  }
  return escapeSqlLiteral(value);
}
