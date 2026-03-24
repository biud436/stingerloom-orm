import { ColumnType } from "../decorators/Column";
import { IntrospectionTypeMapper, IntrospectionDialect } from "./TypeMapper";

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
 * Options for the EntityCodeBuilder.
 */
export interface EntityCodeBuilderOptions {
  /**
   * Import path for the ORM package. Default: "@stingerloom/orm"
   */
  importPath?: string;
}

/**
 * Builds TypeScript entity source code from database table metadata.
 *
 * Given column info, primary keys, and foreign keys, produces a complete
 * entity file string with proper decorators and imports.
 */
export class EntityCodeBuilder {
  private readonly importPath: string;

  constructor(options?: EntityCodeBuilderOptions) {
    this.importPath = options?.importPath ?? "@stingerloom/orm";
  }

  /**
   * Generate TypeScript entity source code for a single table.
   *
   * @param tableName - The database table name
   * @param columns - Column metadata from INFORMATION_SCHEMA
   * @param pks - Primary key column names
   * @param fks - Foreign key relationships
   * @param dialect - Database dialect for type mapping
   * @returns TypeScript source code string
   */
  build(
    tableName: string,
    columns: DbColumn[],
    pks: string[],
    fks: DbForeignKey[],
    dialect: IntrospectionDialect,
  ): string {
    const className = this.tableNameToClassName(tableName);
    const fkColumnSet = new Set(fks.map((fk) => fk.column_name));

    // Collect which decorators are needed
    const usedDecorators = new Set<string>(["Entity"]);
    const lines: string[] = [];

    // Build property lines first to know which decorators we need
    const propertyBlocks: string[] = [];

    for (const col of columns) {
      // Skip FK columns — they will be represented as @ManyToOne relations
      if (fkColumnSet.has(col.column_name)) continue;

      const isPk = pks.includes(col.column_name);
      const columnType = IntrospectionTypeMapper.toColumnType(col.data_type, dialect);
      const tsType = IntrospectionTypeMapper.toTsType(columnType);

      if (isPk) {
        usedDecorators.add("PrimaryGeneratedColumn");
        const block = [
          "  @PrimaryGeneratedColumn()",
          `  ${this.columnNameToPropertyName(col.column_name)}!: ${tsType};`,
        ];
        propertyBlocks.push(block.join("\n"));
      } else {
        usedDecorators.add("Column");
        const opts = this.buildColumnOptions(col, columnType);
        const block = [
          `  @Column(${opts})`,
          `  ${this.columnNameToPropertyName(col.column_name)}!: ${tsType};`,
        ];
        propertyBlocks.push(block.join("\n"));
      }
    }

    // Add ManyToOne relations for FK columns
    for (const fk of fks) {
      usedDecorators.add("ManyToOne");
      const refClassName = this.tableNameToClassName(fk.referenced_table);
      const propertyName = this.fkToPropertyName(fk.column_name);
      const block = [
        `  @ManyToOne(() => ${refClassName}, { joinColumn: "${fk.column_name}" })`,
        `  ${propertyName}!: ${refClassName};`,
      ];
      propertyBlocks.push(block.join("\n"));
    }

    // Build import line
    const sortedDecorators = Array.from(usedDecorators).sort();
    lines.push(
      `import { ${sortedDecorators.join(", ")} } from "${this.importPath}";`,
    );
    lines.push("");

    // Class declaration
    lines.push("@Entity()");
    lines.push(`export class ${className} {`);
    lines.push(propertyBlocks.join("\n\n"));
    lines.push("}");
    lines.push("");

    return lines.join("\n");
  }

  /**
   * Convert a snake_case table name to PascalCase class name.
   * e.g. "user_profiles" -> "UserProfile"
   *
   * Handles plurals by removing trailing "s" if appropriate.
   */
  tableNameToClassName(tableName: string): string {
    // Remove trailing 's' for simple plurals (but not 'ss' like 'address')
    let singular = tableName;
    if (singular.endsWith("ies")) {
      singular = singular.slice(0, -3) + "y";
    } else if (singular.endsWith("ses") || singular.endsWith("xes") || singular.endsWith("zes")) {
      singular = singular.slice(0, -2);
    } else if (singular.endsWith("s") && !singular.endsWith("ss")) {
      singular = singular.slice(0, -1);
    }

    return singular
      .split(/[_\-\s]+/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join("");
  }

  /**
   * Convert a snake_case column name to camelCase property name.
   */
  private columnNameToPropertyName(columnName: string): string {
    const parts = columnName.split("_");
    return parts
      .map((part, i) =>
        i === 0 ? part.toLowerCase() : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase(),
      )
      .join("");
  }

  /**
   * Convert a FK column name to a relation property name.
   * e.g. "post_id" -> "post", "author_id" -> "author"
   */
  private fkToPropertyName(columnName: string): string {
    const name = columnName.replace(/_id$/i, "");
    return this.columnNameToPropertyName(name);
  }

  /**
   * Build the @Column() decorator options string.
   */
  private buildColumnOptions(col: DbColumn, columnType: ColumnType): string {
    const opts: string[] = [];
    opts.push(`type: "${columnType}"`);

    if (
      columnType === "varchar" &&
      col.character_maximum_length !== undefined &&
      col.character_maximum_length !== null
    ) {
      opts.push(`length: ${col.character_maximum_length}`);
    }

    if (col.is_nullable === "YES") {
      opts.push("nullable: true");
    }

    return `{ ${opts.join(", ")} }`;
  }
}
