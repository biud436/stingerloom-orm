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
   * @param indexes - Optional non-PK indexes for the table
   * @returns TypeScript source code string
   */
  build(
    tableName: string,
    columns: DbColumn[],
    pks: string[],
    fks: DbForeignKey[],
    dialect: IntrospectionDialect,
    indexes: DbIndex[] = [],
  ): string {
    const className = this.tableNameToClassName(tableName);
    const fkColumnSet = new Set(fks.map((fk) => fk.column_name));

    // Collect which decorators are needed
    const usedDecorators = new Set<string>(["Entity"]);
    const lines: string[] = [];

    // Track referenced class names for FK imports
    const referencedClasses = new Set<string>();

    // Build property lines first to know which decorators we need
    const propertyBlocks: string[] = [];

    // Track the set of property names already emitted so FK relations can
    // disambiguate when they would otherwise collide with a plain column
    // (e.g. an entity with both `user_id` FK and a `user` text column).
    const usedPropertyNames = new Set<string>();

    // Classify indexes: single-column non-unique → property-level @Index;
    // everything else (multi-column, or any unique) → class-level decorator.
    // Drop indexes that exactly cover the primary key.
    const pkColumnSet = new Set(pks);
    const propertyLevelIndexCols = new Set<string>();
    const classLevelIndexes: DbIndex[] = [];
    for (const idx of indexes) {
      if (
        idx.column_names.length === pks.length &&
        idx.column_names.every((c) => pkColumnSet.has(c))
      ) {
        continue;
      }
      if (idx.column_names.length === 1 && !idx.is_unique) {
        propertyLevelIndexCols.add(idx.column_names[0]);
      } else {
        classLevelIndexes.push(idx);
      }
    }

    // Columns that are BOTH a FK and a PK (closure tables, join tables with
    // composite PKs) need a `@PrimaryColumn` declaration in addition to the
    // FK relation — otherwise the entity has no primary key at all. Track
    // those here so the column loop emits them as PK columns rather than
    // skipping them outright.
    const fkPkColumnSet = new Set(
      fks.filter((fk) => pks.includes(fk.column_name)).map((fk) => fk.column_name),
    );

    for (const col of columns) {
      // Skip pure FK columns — they will be represented as @ManyToOne relations
      // only. Composite-PK FK columns are NOT skipped (see fkPkColumnSet).
      if (fkColumnSet.has(col.column_name) && !fkPkColumnSet.has(col.column_name)) {
        continue;
      }

      const isPk = pks.includes(col.column_name);
      const isFkPk = fkPkColumnSet.has(col.column_name);
      const columnType = IntrospectionTypeMapper.toColumnType(
        col.data_type,
        dialect,
        col.column_type ?? undefined,
      );
      const tsType = IntrospectionTypeMapper.toTsType(columnType);
      const propertyName = this.columnNameToPropertyName(col.column_name);
      usedPropertyNames.add(propertyName);

      const decoratorLines: string[] = [];
      const timestampKind = this.detectTimestampDecorator(
        propertyName,
        col,
        columnType,
      );

      // Whether the DB column name differs from the JS property name and
      // therefore needs an explicit `name:` option to preserve round-trip
      // stability under the default identity NamingStrategy.
      const needsNameOption = col.column_name !== propertyName;

      if (isPk) {
        const isGenerated = this.isGeneratedPrimaryKey(col, {
          dialect,
          singlePk: pks.length === 1,
        });
        if (isGenerated) {
          usedDecorators.add("PrimaryGeneratedColumn");
          if (needsNameOption) {
            decoratorLines.push(
              `  @PrimaryGeneratedColumn({ name: "${col.column_name}" })`,
            );
          } else {
            decoratorLines.push("  @PrimaryGeneratedColumn()");
          }
        } else if (isFkPk) {
          // Pin the column name explicitly so we can keep the original
          // (possibly snake_case) name while the property is camelCased.
          usedDecorators.add("PrimaryColumn");
          decoratorLines.push(
            `  @PrimaryColumn({ type: "${columnType}", name: "${col.column_name}" })`,
          );
        } else {
          usedDecorators.add("PrimaryColumn");
          if (needsNameOption) {
            decoratorLines.push(
              `  @PrimaryColumn({ name: "${col.column_name}" })`,
            );
          } else {
            decoratorLines.push("  @PrimaryColumn()");
          }
        }
      } else if (timestampKind) {
        usedDecorators.add(timestampKind.decorator);
        decoratorLines.push(`  ${timestampKind.line}`);
      } else {
        usedDecorators.add("Column");
        const opts = this.buildColumnOptions(col, columnType, needsNameOption);
        decoratorLines.push(`  @Column(${opts})`);
      }

      if (propertyLevelIndexCols.has(col.column_name)) {
        usedDecorators.add("Index");
        decoratorLines.push("  @Index()");
      }

      const propTsType = timestampKind ? "Date" : tsType;
      decoratorLines.push(`  ${propertyName}!: ${propTsType};`);
      propertyBlocks.push(decoratorLines.join("\n"));
    }

    // Add ManyToOne relations for FK columns
    for (const fk of fks) {
      usedDecorators.add("ManyToOne");
      usedDecorators.add("RelationColumn");
      const refClassName = this.tableNameToClassName(fk.referenced_table);
      referencedClasses.add(refClassName);

      // Default: strip `_id` suffix (e.g., `author_id` → `author`). When
      // that collides with an existing column or another FK relation, fall
      // back to the camelCased FK column name itself (e.g., `authorId`),
      // and finally to a numeric suffix as a last resort.
      const base = this.fkToPropertyName(fk.column_name);
      const fallback = this.columnNameToPropertyName(fk.column_name);
      let propertyName = base;
      if (usedPropertyNames.has(propertyName) && fallback !== propertyName) {
        propertyName = fallback;
      }
      let suffix = 2;
      while (usedPropertyNames.has(propertyName)) {
        propertyName = `${base}${suffix++}`;
      }
      usedPropertyNames.add(propertyName);

      // Inverse-side accessor is unknown without reading the referenced
      // entity; emit `any` placeholder so the generated code compiles. The
      // user can rename to the actual inverse property once both sides are
      // generated.
      const block = [
        `  @ManyToOne(() => ${refClassName}, (entity: any) => entity.${propertyName})`,
        `  @RelationColumn({ name: "${fk.column_name}" })`,
        `  ${propertyName}!: ${refClassName};`,
      ];
      propertyBlocks.push(block.join("\n"));
    }

    // Build import line
    const sortedDecorators = Array.from(usedDecorators).sort();
    lines.push(
      `import { ${sortedDecorators.join(", ")} } from "${this.importPath}";`,
    );

    // Emit imports for referenced entity classes (FK targets). Skip
    // self-references — `@ManyToOne(() => Department, ...)` inside the
    // Department class itself doesn't need a Department import (and an
    // explicit one would conflict with the class declaration).
    // The explicit `.js` extension keeps the generated code loadable from ESM
    // projects (NodeNext requires it); TypeScript maps `./x.js` back to
    // `./x.ts` under every module resolution mode, so CJS projects compile
    // unchanged.
    for (const refClass of Array.from(referencedClasses).sort()) {
      if (refClass === className) continue;
      const refFileName = this.classNameToFileName(refClass);
      lines.push(
        `import { ${refClass} } from "./${refFileName.replace(/\.ts$/, "")}.js";`,
      );
    }

    lines.push("");

    // Build a column-name → property-name map so class-level @Index /
    // @UniqueIndex can reference the property keys (the ORM resolves them
    // back to DB column names via the entity's metadata).
    const colToProperty = new Map<string, string>();
    for (const col of columns) {
      colToProperty.set(col.column_name, this.columnNameToPropertyName(col.column_name));
    }

    // Class declaration
    lines.push(`@Entity({ name: "${tableName}" })`);
    for (const idx of classLevelIndexes) {
      const cols = idx.column_names
        .map((c) => JSON.stringify(colToProperty.get(c) ?? c))
        .join(", ");
      const nameArg = idx.name ? `, ${JSON.stringify(idx.name)}` : "";
      if (idx.is_unique) {
        usedDecorators.add("UniqueIndex");
        lines.push(`@UniqueIndex([${cols}]${nameArg})`);
      } else {
        usedDecorators.add("Index");
        lines.push(`@Index([${cols}]${nameArg})`);
      }
    }
    lines.push(`export class ${className} {`);
    lines.push(propertyBlocks.join("\n\n"));
    lines.push("}");
    lines.push("");

    // Re-build the import line if class-level decorators were added after
    // we wrote the imports above (they share `usedDecorators`). The import
    // statement is always at line 0.
    const sortedDecoratorsFinal = Array.from(usedDecorators).sort();
    lines[0] = `import { ${sortedDecoratorsFinal.join(", ")} } from "${this.importPath}";`;

    return lines.join("\n");
  }

  /**
   * Detect whether a column should be emitted as `@CreateTimestamp`,
   * `@UpdateTimestamp`, or `@DeletedAt` based on its property name, type,
   * and nullability. Returns `null` when no timestamp decorator applies.
   */
  private detectTimestampDecorator(
    propertyName: string,
    col: DbColumn,
    columnType: ColumnType,
  ): { decorator: "CreateTimestamp" | "UpdateTimestamp" | "DeletedAt"; line: string } | null {
    const isTimestampType =
      columnType === "datetime" ||
      columnType === "timestamp" ||
      columnType === "timestamptz" ||
      columnType === "date";
    if (!isTimestampType) return null;

    const opts: string[] = [];
    if (columnType !== "datetime") opts.push(`type: "${columnType}"`);
    if (col.column_name !== propertyName) {
      opts.push(`name: "${col.column_name}"`);
    }
    const typeArg = opts.length > 0 ? `{ ${opts.join(", ")} }` : "";
    const nullable = col.is_nullable === "YES";

    if (propertyName === "createdAt" && !nullable) {
      return {
        decorator: "CreateTimestamp",
        line: `@CreateTimestamp(${typeArg})`,
      };
    }
    if (propertyName === "updatedAt" && !nullable) {
      return {
        decorator: "UpdateTimestamp",
        line: `@UpdateTimestamp(${typeArg})`,
      };
    }
    if (propertyName === "deletedAt" && nullable) {
      return {
        decorator: "DeletedAt",
        line: `@DeletedAt(${typeArg})`,
      };
    }
    return null;
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
    } else if (
      singular.endsWith("ses") ||
      singular.endsWith("xes") ||
      singular.endsWith("zes")
    ) {
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
   * Convert a snake_case column name to camelCase property name. Column
   * names that contain no underscore (already camelCase or PascalCase) are
   * normalized by lowercasing only the first character, so e.g. `updatedAt`
   * → `updatedAt`, `IsValid` → `isValid`. Underscored names get the
   * traditional snake → camel transform.
   */
  private columnNameToPropertyName(columnName: string): string {
    if (!columnName.includes("_")) {
      return columnName.charAt(0).toLowerCase() + columnName.slice(1);
    }
    const parts = columnName.split("_");
    return parts
      .map((part, i) =>
        i === 0
          ? part.toLowerCase()
          : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase(),
      )
      .join("");
  }

  /**
   * Convert a FK column name to a relation property name.
   * Strips both `_id` suffix (e.g., "post_id" → "post") and `id_` prefix
   * (e.g., "id_ancestor" → "ancestor"). Falls through to camelCase if
   * neither suffix nor prefix applies.
   */
  private fkToPropertyName(columnName: string): string {
    let name = columnName;
    if (/_id$/i.test(name)) {
      name = name.slice(0, -3);
    } else if (/^id_/i.test(name)) {
      name = name.slice(3);
    }
    return this.columnNameToPropertyName(name);
  }

  /**
   * Determine whether a PK column is auto-generated.
   * Checks:
   * - PostgreSQL `is_identity = 'YES'` (GENERATED { ALWAYS | BY DEFAULT } AS IDENTITY, PG 10+)
   * - PostgreSQL legacy SERIAL (`data_type = 'serial'/'bigserial'` or `nextval(...)` default)
   * - MySQL `EXTRA` containing `auto_increment`
   * - SQLite: a single `INTEGER PRIMARY KEY` is a rowid alias and auto-generates
   */
  private isGeneratedPrimaryKey(
    col: DbColumn,
    context?: { dialect?: IntrospectionDialect; singlePk?: boolean },
  ): boolean {
    if ((col.is_identity ?? "").toUpperCase() === "YES") {
      return true;
    }

    const dataTypeLower = col.data_type.toLowerCase();
    if (dataTypeLower === "serial" || dataTypeLower === "bigserial") {
      return true;
    }

    const defaultVal = (col.column_default ?? "").toLowerCase();
    if (
      defaultVal.includes("nextval") ||
      defaultVal.includes("auto_increment")
    ) {
      return true;
    }

    const extra = (col.extra ?? "").toLowerCase();
    if (extra.includes("auto_increment")) {
      return true;
    }

    if (
      context?.dialect === "sqlite" &&
      context.singlePk === true &&
      dataTypeLower === "integer"
    ) {
      return true;
    }

    return false;
  }

  /**
   * Convert PascalCase class name to kebab-case file name.
   * e.g. "UserProfile" -> "user-profile.entity.ts"
   */
  classNameToFileName(className: string): string {
    const kebab = className
      .replace(/([a-z])([A-Z])/g, "$1-$2")
      .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
      .toLowerCase();
    return `${kebab}.entity.ts`;
  }

  /**
   * Build the @Column() decorator options string.
   */
  private buildColumnOptions(
    col: DbColumn,
    columnType: ColumnType,
    includeName: boolean = false,
  ): string {
    const opts: string[] = [];
    opts.push(`type: "${columnType}"`);
    if (includeName) {
      opts.push(`name: "${col.column_name}"`);
    }

    if (
      (columnType === "varchar" || columnType === "char") &&
      col.character_maximum_length !== undefined &&
      col.character_maximum_length !== null
    ) {
      opts.push(`length: ${col.character_maximum_length}`);
    }

    if (
      (columnType === "float" || columnType === "double") &&
      col.numeric_precision !== undefined &&
      col.numeric_precision !== null
    ) {
      opts.push(`precision: ${col.numeric_precision}`);
      if (col.numeric_scale !== undefined && col.numeric_scale !== null) {
        opts.push(`scale: ${col.numeric_scale}`);
      }
    }

    if (
      columnType === "enum" &&
      Array.isArray(col.enum_values) &&
      col.enum_values.length > 0
    ) {
      const literal = col.enum_values
        .map((v) => JSON.stringify(v))
        .join(", ");
      opts.push(`enum: [${literal}]`);
    }

    if (col.is_nullable === "YES") {
      opts.push("nullable: true");
    }

    const defaultLiteral = this.formatDefault(col.column_default, columnType);
    if (defaultLiteral !== null) {
      opts.push(`default: ${defaultLiteral}`);
    }

    return `{ ${opts.join(", ")} }`;
  }

  /**
   * Convert a raw `column_default` string from INFORMATION_SCHEMA into a
   * TypeScript literal suitable for `@Column({ default: ... })`.
   *
   * Returns `null` to omit the option entirely (no default, or a default
   * that the ORM handles itself such as PK sequence / auto_increment).
   */
  private formatDefault(
    rawDefault: string | null | undefined,
    columnType: ColumnType,
  ): string | null {
    if (rawDefault === undefined || rawDefault === null) return null;
    const raw = rawDefault.trim();
    if (raw === "") return null;

    const lower = raw.toLowerCase();

    // Auto-generated PK defaults are owned by @PrimaryGeneratedColumn — skip.
    if (lower.startsWith("nextval(") || lower.includes("auto_increment")) {
      return null;
    }

    // MariaDB 10.2+ returns the literal string `NULL` from INFORMATION_SCHEMA
    // when a nullable column has no explicit default. Treat that — and any
    // other bare-NULL expression — as "no default" so we don't emit a noisy
    // `default: "(NULL)"` option.
    if (lower === "null") {
      return null;
    }

    // Strip PostgreSQL `::type` casts (e.g., `'foo'::character varying`).
    let stripped = raw;
    const castIdx = stripped.indexOf("::");
    if (castIdx !== -1) stripped = stripped.slice(0, castIdx).trim();

    // Boolean literals (Postgres: true/false; MySQL: 0/1 for tinyint(1)).
    if (columnType === "boolean") {
      const v = stripped.toLowerCase();
      if (v === "true" || v === "'t'" || v === "t" || v === "1") return "true";
      if (v === "false" || v === "'f'" || v === "f" || v === "0") return "false";
    }

    // Quoted string literal: `'value'` → keep as JS string.
    if (stripped.startsWith("'") && stripped.endsWith("'") && stripped.length >= 2) {
      const inner = stripped.slice(1, -1).replace(/''/g, "'");
      return JSON.stringify(inner);
    }

    // Numeric literal — only safe for numeric column types so we don't
    // accidentally re-classify a SQL function call (e.g., `1` vs identifier).
    if (
      (columnType === "int" ||
        columnType === "bigint" ||
        columnType === "float" ||
        columnType === "double") &&
      /^-?\d+(\.\d+)?$/.test(stripped)
    ) {
      return stripped;
    }

    // Anything else (CURRENT_TIMESTAMP, now(), uuid_generate_v4(), …) is a
    // raw SQL expression. Wrap in parentheses so the driver passes it
    // through as a function default rather than a quoted literal.
    return JSON.stringify(`(${stripped})`);
  }
}
