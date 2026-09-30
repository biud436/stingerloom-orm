import { IntrospectionDialect } from "./TypeMapper";
import { CodeFirstEmitter } from "./CodeFirstEmitter";
import { DecoratorEmitter } from "./DecoratorEmitter";
import {
  buildEntityModel,
  EntityModel,
  EntityModelContext,
} from "./EntityModel";
import { classNameToFileName, tableNameToClassName } from "./lowering/Naming";
import type { DbColumn, DbForeignKey, DbIndex } from "./catalog/legacyRows";

export type { DbColumn, DbForeignKey, DbIndex } from "./catalog/legacyRows";

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
 * The rows are read into the dialect-neutral schema IR, lowered to an
 * {@link EntityModel}, and spelled out by the selected emitter — the same
 * pipeline `IntrospectionGenerator` runs, so the two styles describe exactly
 * the same schema.
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
   * @param fks - Foreign keys (rows sharing a `constraint_name` form one key)
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
    return this.emit(
      buildEntityModel(tableName, columns, pks, fks, dialect, indexes, context),
    );
  }

  /** Spells out an already-lowered model in this builder's style. */
  emit(model: EntityModel): string {
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
