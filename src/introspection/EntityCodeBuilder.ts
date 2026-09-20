import { IntrospectionDialect } from "./TypeMapper";
import { CodeFirstEmitter } from "./CodeFirstEmitter";
import { DecoratorEmitter } from "./DecoratorEmitter";
import {
  buildEntityModel,
  classNameToFileName,
  EntityModelContext,
  tableNameToClassName,
} from "./EntityModel";

/**
 * Represents a database column discovered via introspection.
 */
export interface DbColumn {
  column_name: string;
  data_type: string;
  is_nullable: string;
  character_maximum_length?: number | null;
  numeric_precision?: number | null;
  numeric_scale?: number | null;
  column_default?: string | null;
  extra?: string | null;
  /**
   * Full column type with width/length (MySQL `COLUMN_TYPE`), e.g.
   * `tinyint(1)`, `varchar(255)`, `decimal(10,2)`. Used to refine TINYINT(1)
   * → boolean detection on MySQL.
   */
  column_type?: string | null;
  /**
   * PostgreSQL `information_schema.columns.is_identity` ("YES"/"NO"). Set
   * for `GENERATED { ALWAYS | BY DEFAULT } AS IDENTITY` columns (PG 10+).
   */
  is_identity?: string | null;
  /**
   * PostgreSQL user-defined enum labels. Populated by IntrospectionGenerator
   * when the column's `data_type` is `USER-DEFINED` and its underlying
   * `udt_name` resolves to a `pg_type` of `typtype = 'e'` (enum).
   *
   * MySQL ENUM values are also stored here (parsed out of `COLUMN_TYPE`).
   */
  enum_values?: string[] | null;
}

/**
 * Represents a foreign key relationship discovered via introspection.
 */
export interface DbForeignKey {
  column_name: string;
  referenced_table: string;
  referenced_column: string;
  constraint_name?: string;
}

/**
 * Represents an index discovered via introspection.
 *
 * Always excludes the table's primary key constraint (that's handled by
 * `@PrimaryColumn` / `@PrimaryGeneratedColumn`). Foreign-key-implied
 * indexes are kept — callers can decide whether to emit them.
 */
export interface DbIndex {
  name: string;
  column_names: string[];
  is_unique: boolean;
}

/**
 * Output style for generated entity files.
 *
 * - `"decorator"` — classes with `@Entity` / `@Column` / `@ManyToOne` (default)
 * - `"code-first"` — `defineEntity` + the `t` field builders, no decorators
 */
export type EntityCodeStyle = "decorator" | "code-first";

/**
 * Options for the EntityCodeBuilder.
 */
export interface EntityCodeBuilderOptions {
  /**
   * Import path for the ORM package. Default: "@stingerloom/orm"
   */
  importPath?: string;
  /**
   * Which of the ORM's two entity notations to emit. Default: `"decorator"`.
   */
  style?: EntityCodeStyle;
}

/**
 * Builds TypeScript entity source code from database table metadata.
 *
 * Column info, primary keys, foreign keys, and indexes are first reduced to a
 * dialect-neutral {@link EntityModel}; the selected emitter then spells that
 * model out as either decorated classes or `defineEntity` builders, so the two
 * styles describe exactly the same schema.
 */
export class EntityCodeBuilder {
  private readonly importPath: string;
  private readonly style: EntityCodeStyle;

  constructor(options?: EntityCodeBuilderOptions) {
    this.importPath = options?.importPath ?? "@stingerloom/orm";
    this.style = options?.style ?? "decorator";
  }

  /**
   * Generate TypeScript entity source code for a single table.
   *
   * @param tableName - The database table name
   * @param columns - Column metadata from INFORMATION_SCHEMA
   * @param pks - Primary key column names
   * @param fks - Foreign key relationships
   * @param dialect - Database dialect for type mapping
   * @param indexes - Optional non-PK indexes for the table
   * @param context - Optional whole-schema context (primary keys per table)
   * @returns TypeScript source code string
   */
  build(
    tableName: string,
    columns: DbColumn[],
    pks: string[],
    fks: DbForeignKey[],
    dialect: IntrospectionDialect,
    indexes: DbIndex[] = [],
    context: EntityModelContext = {},
  ): string {
    const model = buildEntityModel(
      tableName,
      columns,
      pks,
      fks,
      dialect,
      indexes,
      context,
    );
    return this.style === "code-first"
      ? new CodeFirstEmitter(this.importPath).emit(model)
      : new DecoratorEmitter(this.importPath).emit(model);
  }

  /**
   * Convert a snake_case table name to PascalCase class name.
   * e.g. "user_profiles" -> "UserProfile"
   */
  tableNameToClassName(tableName: string): string {
    return tableNameToClassName(tableName);
  }

  /**
   * Convert PascalCase class name to kebab-case file name.
   * e.g. "UserProfile" -> "user-profile.entity.ts"
   */
  classNameToFileName(className: string): string {
    return classNameToFileName(className);
  }
}
