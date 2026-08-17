/* eslint-disable @typescript-eslint/no-explicit-any */
import sql from "../../utils/sqlTag";
import { ClazzType } from "../../utils";
import {
  COLUMN_TOKEN,
  ColumnOption,
  ColumnType,
} from "../../decorators/Column";
import { ENTITY_TOKEN, EntityMetadata } from "../../decorators/Entity";
import { ColumnMetadata } from "../../scanner/ColumnScanner";
import {
  RELATION_COLUMN_TOKEN,
  RelationColumnMetadata,
} from "../../decorators/RelationColumn";
import { SchemaDialect } from "./SchemaGenerator";
import { inferRelatedPkType } from "./RelatedPkTypeResolver";
import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";

export interface ColumnChange {
  tableName: string;
  columnName: string;
  columnType?: string;
  currentType?: string;
  nullable?: boolean;
  /**
   * The DB column's current nullability (`is_nullable = "YES"`). Set on
   * alterColumns so the ALTER generators can (a) emit a PostgreSQL
   * `SET/DROP NOT NULL` action and (b) reverse it in a `down` migration.
   * Undefined on add/drop paths and on hand-built diffs (backward compatible).
   */
  currentNullable?: boolean;
  /**
   * `false` when the alter carries ONLY a nullability change (type and length
   * are unchanged) — generators then skip the `TYPE` rewrite, which on
   * PostgreSQL would force an unnecessary, possibly expensive, table rewrite.
   * Treated as a type/length alter when omitted (backward compatible).
   */
  typeChanged?: boolean;
  expectedLength?: number | null;
  actualLength?: number | null;
  expectedPrecision?: number | null;
  actualPrecision?: number | null;
  expectedScale?: number | null;
  actualScale?: number | null;
  enumValues?: string[];
}

export interface RenamedColumn {
  tableName: string;
  oldColumnName: string;
  newColumnName: string;
  columnType: string;
}

export interface EnumChange {
  enumName: string;
  addValues: string[];
  removeValues: string[];
  isNew: boolean;
}

export interface SchemaDiffResult {
  addTables: string[];
  dropTables: string[];
  addColumns: ColumnChange[];
  dropColumns: ColumnChange[];
  alterColumns: ColumnChange[];
  renamedColumns?: RenamedColumn[];
  addTableEntityMap?: Record<string, ClazzType<any>>;
  enumChanges?: EnumChange[];
}

/**
 * Creates a SchemaDiffResult with defaults for optional fields.
 */
export function createSchemaDiffResult(
  partial?: Partial<SchemaDiffResult>,
): SchemaDiffResult {
  return {
    addTables: [],
    dropTables: [],
    addColumns: [],
    dropColumns: [],
    alterColumns: [],
    renamedColumns: [],
    enumChanges: [],
    ...partial,
  };
}

interface DbColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: string;
  character_maximum_length?: number | null;
  numeric_precision?: number | null;
  numeric_scale?: number | null;
}

export interface SchemaDiffOptions {
  /**
   * If true, detect tables in DB that are not in the entity list and add them to dropTables.
   * Default: false (backward compatible — only detects add/alter/drop columns)
   *
   * No product path turns this on: `synchronize` never drops a table, and
   * `migrate:generate` never proposes one. It exists for callers that drive
   * `SchemaDiff` directly and can judge for themselves whether a table with no
   * entity is obsolete rather than merely owned by someone else.
   */
  detectDroppedTables?: boolean;
}

interface QueryRunner {
  query: (sql: string | import("sql-template-tag").Sql) => Promise<any>;
}

/**
 * Compares entity metadata with the database's INFORMATION_SCHEMA to produce a schema diff.
 */
export class SchemaDiff {
  /**
   * Extracts the desired schema from the entity metadata,
   * compares it against the database's INFORMATION_SCHEMA, and returns the diff.
   */
  async diff(
    entities: ClazzType<any>[],
    queryRunner: QueryRunner,
    dialect: SchemaDialect,
    schema?: string,
    options?: SchemaDiffOptions,
  ): Promise<SchemaDiffResult> {
    const result: SchemaDiffResult = {
      addTables: [],
      dropTables: [],
      addColumns: [],
      dropColumns: [],
      alterColumns: [],
      renamedColumns: [],
      enumChanges: [],
    };

    const entityTableNames = new Set<string>();

    for (const entity of entities) {
      const tableName = this.getTableName(entity);
      entityTableNames.add(tableName.toLowerCase());
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
          let castTypeName = this.castType(
            col.options?.type ?? "varchar",
            dialect,
          );
          const isPgArray =
            dialect === "postgres" && col.options?.type === "array";
          if (isPgArray) {
            // castTypePostgres keeps "ARRAY" for information_schema
            // comparison, but bare ARRAY is not valid ADD COLUMN DDL —
            // resolve to `element[]` like the CREATE TABLE path does.
            castTypeName = `${this.castType(
              col.options?.arrayElementType ?? "text",
              dialect,
            )}[]`;
          }
          const isPgEnum =
            dialect === "postgres" && col.options?.type === "enum";
          if (isPgEnum) {
            // Same shape as the array case: castTypePostgres reports the
            // information_schema token "USER-DEFINED" so the comparison branch
            // does not churn, but ADD COLUMN has to name the type itself
            // (`ADD COLUMN "status" USER-DEFINED` is a syntax error). The type
            // is provisioned by SchemaRegistrar.syncEnumTypes before this runs.
            castTypeName = this.quoteEnumType(
              col.options?.enumName ?? `${tableName}_${colName}_enum`,
              schema,
            );
          }
          const isPgNamedType = isPgArray || isPgEnum;
          result.addColumns.push({
            tableName,
            columnName: colName,
            columnType: castTypeName,
            nullable: col.options?.nullable ?? false,
            // Length/precision must not be appended after `[]` or after a
            // named enum type ("TEXT[](255)" / `"public"."x_enum"(255)` are
            // both invalid), so those columns drop them.
            expectedLength: isPgNamedType ? null : (col.options?.length ?? null),
            expectedPrecision: isPgNamedType
              ? null
              : (col.options?.precision ?? null),
            expectedScale: isPgNamedType ? null : (col.options?.scale ?? null),
            enumValues: col.options?.enumValues,
          });
        } else {
          // Column exists in both — check for type changes
          const expectedType = this.castType(
            col.options?.type ?? "varchar",
            dialect,
          );
          const actualType = dbCol.data_type.toUpperCase();

          // Expected nullability mirrors the CREATE path exactly
          // (BaseColumnDefinitionBuilder: `option.nullable ? NULL : NOT NULL`),
          // so a schema freshly created by this ORM never reports a spurious
          // nullability diff. `is_nullable` is normalized to "YES"/"NO" across
          // all three dialects by getDbColumns().
          const expectedNullable = col.options?.nullable ?? false;
          const dbNullable =
            (dbCol.is_nullable ?? "").toString().toUpperCase() === "YES";

          if (!this.typesMatch(expectedType, actualType, dialect)) {
            result.alterColumns.push({
              tableName,
              columnName: colName,
              columnType: expectedType,
              currentType: dbCol.data_type,
              // Carry the declared nullability — MySQL's MODIFY COLUMN restates
              // the whole definition, so omitting this silently drops NOT NULL.
              nullable: expectedNullable,
              currentNullable: dbNullable,
              // Carry length/precision/scale too: castType emits a bare type
              // (e.g. "VARCHAR", "DECIMAL"), so without these the generated
              // ALTER becomes "MODIFY ... VARCHAR" — a MySQL 1064 syntax error
              // — and DECIMAL would silently lose its precision/scale.
              expectedLength: col.options?.length ?? null,
              actualLength: dbCol.character_maximum_length ?? null,
              expectedPrecision: col.options?.precision ?? null,
              actualPrecision: dbCol.numeric_precision ?? null,
              expectedScale: col.options?.scale ?? null,
              actualScale: dbCol.numeric_scale ?? null,
              enumValues: col.options?.enumValues,
            });
          } else if (!this.lengthsMatch(col.options, dbCol)) {
            // Types match but length/precision differs
            result.alterColumns.push({
              tableName,
              columnName: colName,
              columnType: expectedType,
              currentType: dbCol.data_type,
              nullable: expectedNullable,
              currentNullable: dbNullable,
              expectedLength: col.options?.length ?? null,
              actualLength: dbCol.character_maximum_length ?? null,
              expectedPrecision: col.options?.precision ?? null,
              actualPrecision: dbCol.numeric_precision ?? null,
              expectedScale: col.options?.scale ?? null,
              actualScale: dbCol.numeric_scale ?? null,
              enumValues: col.options?.enumValues,
            });
          } else if (
            expectedNullable !== dbNullable &&
            !col.options?.primary
          ) {
            // Type and length match, but nullability drifted — emit a
            // nullability-only alter. Primary-key columns are skipped: their
            // nullability is structurally fixed and dialect-quirky (SQLite's
            // `INTEGER PRIMARY KEY` reports notnull=0 / is_nullable="YES").
            // `typeChanged: false` tells the generators to skip the TYPE rewrite
            // and emit only `SET/DROP NOT NULL` (Postgres) or restate the column
            // via `MODIFY COLUMN` (MySQL).
            result.alterColumns.push({
              tableName,
              columnName: colName,
              columnType: expectedType,
              currentType: dbCol.data_type,
              nullable: expectedNullable,
              currentNullable: dbNullable,
              typeChanged: false,
              expectedLength: col.options?.length ?? null,
              actualLength: dbCol.character_maximum_length ?? null,
              expectedPrecision: col.options?.precision ?? null,
              actualPrecision: dbCol.numeric_precision ?? null,
              expectedScale: col.options?.scale ?? null,
              actualScale: dbCol.numeric_scale ?? null,
              enumValues: col.options?.enumValues,
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
            actualLength: dbCol.character_maximum_length ?? null,
            actualPrecision: dbCol.numeric_precision ?? null,
            actualScale: dbCol.numeric_scale ?? null,
          });
        }
      }
    }

    // Detect ENUM changes (PostgreSQL only)
    if (dialect === "postgres") {
      await this.detectEnumChanges(result, entities, queryRunner, schema);
    }

    // Detect column renames: match 1:1 add/drop pairs with same type per table
    this.detectRenames(result, dialect);

    // Detect dropped tables (opt-in)
    if (options?.detectDroppedTables) {
      const dbTables = await this.getDbTables(queryRunner, dialect, schema);
      for (const dbTable of dbTables) {
        if (!entityTableNames.has(dbTable.toLowerCase())) {
          result.dropTables.push(dbTable);
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
      if (existingNames.has(fkName)) continue;

      const fkType: ColumnType =
        rc.type ?? inferRelatedPkType(entity, rc.propertyKey) ?? "int";

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

  private async getDbColumns(
    queryRunner: QueryRunner,
    tableName: string,
    dialect: SchemaDialect,
    schema?: string,
  ): Promise<DbColumnInfo[]> {
    let rawResult: any;

    if (dialect === "sqlite") {
      // SQLite PRAGMA does not support parameterized queries, so validate the identifier strictly
      if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(tableName)) {
        throw new OrmError(OrmErrorCode.SCHEMA_ERROR, `Invalid table name: ${tableName}`);
      }
      const escaped = tableName.replace(/"/g, '""');
      rawResult = await queryRunner.query(`PRAGMA table_info("${escaped}")`);
      const rows = this.normalizeRows(rawResult);
      return rows.map((row: any) => {
        const parsed = this.parseSqliteTypeLength(row.type || "TEXT");
        return {
          column_name: row.name,
          data_type: parsed.type,
          is_nullable: row.notnull === 0 ? "YES" : "NO",
          character_maximum_length: parsed.length ?? null,
        };
      });
    }

    if (dialect === "mysql") {
      rawResult = await queryRunner.query(
        sql`SELECT COLUMN_NAME as column_name, DATA_TYPE as data_type, IS_NULLABLE as is_nullable, CHARACTER_MAXIMUM_LENGTH as character_maximum_length, NUMERIC_PRECISION as numeric_precision, NUMERIC_SCALE as numeric_scale FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${tableName}`,
      );
    } else {
      const pgSchema = schema ?? "public";
      rawResult = await queryRunner.query(
        sql`SELECT column_name, data_type, is_nullable, character_maximum_length, numeric_precision, numeric_scale FROM information_schema.columns WHERE table_schema = ${pgSchema} AND table_name = ${tableName}`,
      );
    }

    return this.normalizeRows(rawResult);
  }

  private async getDbTables(
    queryRunner: QueryRunner,
    dialect: SchemaDialect,
    schema?: string,
  ): Promise<string[]> {
    let rawResult: any;

    if (dialect === "sqlite") {
      rawResult = await queryRunner.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      );
    } else if (dialect === "mysql") {
      rawResult = await queryRunner.query(
        "SELECT TABLE_NAME as name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()",
      );
    } else {
      const pgSchema = schema ?? "public";
      rawResult = await queryRunner.query(
        sql`SELECT tablename as name FROM pg_tables WHERE schemaname = ${pgSchema}`,
      );
    }

    const rows = this.normalizeRows(rawResult);
    return rows.map((row: any) => row.name ?? row.TABLE_NAME ?? row.tablename);
  }

  /**
   * Parse SQLite type string to extract type and length.
   * e.g. "VARCHAR(255)" → { type: "VARCHAR", length: 255 }
   */
  private parseSqliteTypeLength(typeStr: string): {
    type: string;
    length?: number;
  } {
    const match = typeStr.match(/^(\w+)\((\d+)\)$/);
    if (match) {
      return { type: match[1], length: parseInt(match[2], 10) };
    }
    return { type: typeStr };
  }

  private castType(type: ColumnType, dialect: SchemaDialect): string {
    if (dialect === "sqlite") {
      return this.castTypeSqlite(type);
    }
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
      case "timestamptz":
        // MySQL has no TZ-aware type; the column builder maps it to DATETIME,
        // so the diff must compare against DATETIME (not the invalid TIMESTAMPTZ).
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
      case "uuid":
        return "CHAR";
      default:
        return (type as string).toUpperCase();
    }
  }

  /**
   * Schema-qualified, quoted enum type name. Mirrors
   * `PostgresColumnDefinitionBuilder.resolveEnumType` so an ADD COLUMN names
   * exactly the type a CREATE TABLE would have named.
   */
  private quoteEnumType(enumName: string, schema?: string): string {
    const quote = (id: string) => `"${id.replace(/"/g, '""')}"`;
    return `${quote(schema ?? "public")}.${quote(enumName)}`;
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
      case "timestamptz":
        // information_schema reports a TIMESTAMPTZ column as this canonical form;
        // match it so the diff doesn't emit a spurious ALTER on every sync.
        return "TIMESTAMP WITH TIME ZONE";
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
      case "uuid":
        return "UUID";
      default:
        return (type as string).toUpperCase();
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
      case "uuid":
        return "TEXT";
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
    dialect: SchemaDialect,
  ): boolean {
    const e = expected.toUpperCase().trim();
    const a = actual.toUpperCase().trim();

    if (e === a) return true;

    // SQLite type affinity: broad matching since SQLite only has 5 storage classes
    if (dialect === "sqlite") {
      const sqliteAffinity: Record<string, string[]> = {
        TEXT: ["TEXT", "VARCHAR", "LONGTEXT", "CHAR", "UUID"],
        INTEGER: ["INTEGER", "INT", "TINYINT", "BIGINT", "BOOLEAN"],
        REAL: ["REAL", "FLOAT", "DOUBLE"],
        BLOB: ["BLOB", "BYTEA"],
      };
      const eAliases = sqliteAffinity[e];
      if (eAliases && eAliases.includes(a)) return true;
      return false;
    }

    // Handle common aliases for MySQL / PostgreSQL
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
      "TIMESTAMP WITH TIME ZONE": ["TIMESTAMP WITH TIME ZONE", "TIMESTAMPTZ"],
      TIMESTAMPTZ: ["TIMESTAMPTZ", "TIMESTAMP WITH TIME ZONE"],
      DECIMAL: ["DECIMAL", "NUMERIC"],
      NUMERIC: ["NUMERIC", "DECIMAL"],
      BLOB: ["BLOB", "BYTEA"],
      BYTEA: ["BYTEA", "BLOB"],
      DATETIME: ["DATETIME", "TIMESTAMP"],
      JSON: ["JSON"],
      JSONB: ["JSONB"],
      CHARACTER: ["CHARACTER", "CHAR", "BPCHAR"],
      CHAR: ["CHAR", "CHARACTER", "BPCHAR"],
      UUID: ["UUID"],
    };

    const expectedAliases = aliases[e];
    if (expectedAliases && expectedAliases.includes(a)) return true;

    return false;
  }

  /**
   * Compare entity column length/precision with DB column metadata.
   * Returns true if they match (or if comparison is not applicable).
   */
  private lengthsMatch(
    entityOptions: ColumnOption | undefined,
    dbCol: DbColumnInfo,
  ): boolean {
    if (!entityOptions) return true;

    // Check character_maximum_length (varchar, char, etc.)
    if (
      entityOptions.length !== undefined &&
      entityOptions.length !== null &&
      entityOptions.length > 0 &&
      dbCol.character_maximum_length !== undefined &&
      dbCol.character_maximum_length !== null
    ) {
      if (entityOptions.length !== dbCol.character_maximum_length) {
        return false;
      }
    }

    // Check numeric precision
    if (
      entityOptions.precision !== undefined &&
      entityOptions.precision !== null &&
      dbCol.numeric_precision !== undefined &&
      dbCol.numeric_precision !== null
    ) {
      if (entityOptions.precision !== dbCol.numeric_precision) {
        return false;
      }
    }

    // Check numeric scale
    if (
      entityOptions.scale !== undefined &&
      entityOptions.scale !== null &&
      dbCol.numeric_scale !== undefined &&
      dbCol.numeric_scale !== null
    ) {
      if (entityOptions.scale !== dbCol.numeric_scale) {
        return false;
      }
    }

    return true;
  }

  /**
   * Detect ENUM type changes for PostgreSQL.
   * For new tables, marks enums as isNew. For existing tables, queries pg_enum/pg_type
   * to compare current vs expected values.
   */
  private async detectEnumChanges(
    result: SchemaDiffResult,
    entities: ClazzType<any>[],
    queryRunner: QueryRunner,
    schema?: string,
  ): Promise<void> {
    const processedEnums = new Set<string>();

    for (const entity of entities) {
      const tableName = this.getTableName(entity);
      const entityColumns = this.getEntityColumns(entity);
      const isNewTable = result.addTables.includes(tableName);

      for (const col of entityColumns) {
        if (col.options?.type !== "enum") continue;
        const enumValues = col.options.enumValues;
        if (!enumValues || enumValues.length === 0) continue;

        const colName = col.name ?? "unknown";
        const enumName = col.options.enumName ?? `${tableName}_${colName}_enum`;

        if (processedEnums.has(enumName)) continue;
        processedEnums.add(enumName);

        if (isNewTable) {
          // New table — enum type needs to be created
          result.enumChanges!.push({
            enumName,
            addValues: [...enumValues],
            removeValues: [],
            isNew: true,
          });
        } else {
          // Existing table — query current enum values from pg_enum + pg_type
          const currentValues = await this.getPostgresEnumValues(
            queryRunner,
            enumName,
            schema,
          );

          if (currentValues.length === 0) {
            // Enum type does not exist yet (new column on existing table)
            result.enumChanges!.push({
              enumName,
              addValues: [...enumValues],
              removeValues: [],
              isNew: true,
            });
          } else {
            // Compare current vs expected
            const currentSet = new Set(currentValues);
            const expectedSet = new Set(enumValues);
            const addValues = enumValues.filter((v) => !currentSet.has(v));
            const removeValues = currentValues.filter(
              (v) => !expectedSet.has(v),
            );

            if (addValues.length > 0 || removeValues.length > 0) {
              result.enumChanges!.push({
                enumName,
                addValues,
                removeValues,
                isNew: false,
              });
            }
          }
        }
      }
    }
  }

  /**
   * Query PostgreSQL pg_enum + pg_type to get current enum values for a given type name.
   */
  private async getPostgresEnumValues(
    queryRunner: QueryRunner,
    enumName: string,
    schema?: string,
  ): Promise<string[]> {
    const pgSchema = schema ?? "public";
    const rawResult = await queryRunner.query(
      sql`SELECT e.enumlabel
          FROM pg_type t
          JOIN pg_enum e ON t.oid = e.enumtypid
          JOIN pg_namespace n ON t.typnamespace = n.oid
          WHERE t.typname = ${enumName}
            AND n.nspname = ${pgSchema}
          ORDER BY e.enumsortorder`,
    );
    const rows = this.normalizeRows(rawResult);
    return rows.map((row: any) => row.enumlabel);
  }

  /**
   * Detect column renames by matching addColumns and dropColumns on the same table
   * with compatible types. Matched pairs are moved to renamedColumns.
   */
  private detectRenames(
    result: SchemaDiffResult,
    dialect: SchemaDialect,
  ): void {
    const tables = new Set([
      ...result.addColumns.map((c) => c.tableName),
      ...result.dropColumns.map((c) => c.tableName),
    ]);

    for (const table of tables) {
      const adds = result.addColumns.filter((c) => c.tableName === table);
      const drops = result.dropColumns.filter((c) => c.tableName === table);

      const matchedAddIdx = new Set<number>();
      const matchedDropIdx = new Set<number>();

      for (let di = 0; di < drops.length; di++) {
        if (matchedDropIdx.has(di)) continue;
        const drop = drops[di];
        const dropType = (drop.currentType ?? "").toUpperCase();

        for (let ai = 0; ai < adds.length; ai++) {
          if (matchedAddIdx.has(ai)) continue;
          const add = adds[ai];
          const addType = (add.columnType ?? "").toUpperCase();

          if (this.typesMatch(addType, dropType, dialect)) {
            // Also verify length/precision match to avoid false renames,
            // but only when both sides have length/precision info
            const hasLengthInfo = drop.actualLength != null || drop.actualPrecision != null;
            const lengthMatch = !hasLengthInfo || (
              (add.expectedLength ?? null) === (drop.actualLength ?? null) &&
              (add.expectedPrecision ?? null) === (drop.actualPrecision ?? null) &&
              (add.expectedScale ?? null) === (drop.actualScale ?? null)
            );

            if (lengthMatch) {
              result.renamedColumns!.push({
                tableName: table,
                oldColumnName: drop.columnName,
                newColumnName: add.columnName,
                columnType: add.columnType ?? dropType,
              });
              matchedAddIdx.add(ai);
              matchedDropIdx.add(di);
              break;
            }
          }
        }
      }

      // Remove matched items from addColumns and dropColumns
      result.addColumns = result.addColumns.filter(
        (c) => c.tableName !== table || !matchedAddIdx.has(adds.indexOf(c)),
      );
      result.dropColumns = result.dropColumns.filter(
        (c) => c.tableName !== table || !matchedDropIdx.has(drops.indexOf(c)),
      );
    }
  }

  private normalizeRows(result: any): DbColumnInfo[] {
    if (!result) return [];
    if (Array.isArray(result)) return result;
    if (result.results && Array.isArray(result.results)) return result.results;
    if (result.rows && Array.isArray(result.rows)) return result.rows;
    return [];
  }
}
