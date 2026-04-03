/* eslint-disable @typescript-eslint/no-explicit-any */
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SchemaDiffResult, ColumnChange, RenamedColumn, EnumChange } from "./SchemaDiff";
import { SchemaGenerator, SchemaDialect } from "./SchemaGenerator";
import { MANY_TO_ONE_TOKEN, ManyToOneMetadata } from "../../decorators/ManyToOne";
import { ONE_TO_ONE_TOKEN, OneToOneMetadata } from "../../decorators/OneToOne";
import { ENTITY_TOKEN, EntityMetadata } from "../../decorators/Entity";
import { ClazzType } from "../../utils";
import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";
import type { CommonCapabilities } from "../../dialects/DialectCapabilities";
import { UnsupportedFeatureError } from "../../errors/UnsupportedFeatureError";

/**
 * Escapes an enum value for safe embedding in DDL strings.
 * Rejects null bytes and escapes backslashes and single quotes.
 */
function escapeEnumValue(val: string): string {
  if (val.includes("\0")) {
    throw new OrmError(
      OrmErrorCode.VALIDATION_ERROR,
      `Enum value contains null byte`,
    );
  }
  return val.replace(/\\/g, "\\\\").replace(/'/g, "''");
}

/**
 * SchemaDiffResult를 받아 Migration TypeScript 파일을 생성합니다.
 */
export class SchemaDiffMigrationGenerator {
  private readonly capabilities?: CommonCapabilities;
  private readonly versionString?: string;

  constructor(capabilities?: CommonCapabilities, versionString?: string) {
    this.capabilities = capabilities;
    this.versionString = versionString;
  }

  /**
   * diff 결과를 받아 Migration TypeScript 파일 내용을 생성합니다.
   */
  generate(diff: SchemaDiffResult, dialect: SchemaDialect): string {
    const timestamp = Date.now();
    const className = `AutoMigration_${timestamp}`;
    const upStatements = this.buildUpStatements(diff, dialect);
    const downStatements = this.buildDownStatements(diff, dialect);

    return [
      `import { Migration, MigrationContext } from "@stingerloom/orm";`,
      ``,
      `export class ${className} extends Migration {`,
      `  async up({ query }: MigrationContext): Promise<void> {`,
      ...upStatements.map((s) => `    ${s}`),
      `  }`,
      ``,
      `  async down({ query }: MigrationContext): Promise<void> {`,
      ...downStatements.map((s) => `    ${s}`),
      `  }`,
      `}`,
      ``,
    ].join("\n");
  }

  /**
   * Returns pure SQL statements (up and down) without wrapping in `await query(...)`.
   * Useful for previewing what the migration would do without generating code.
   */
  dryRun(
    diff: SchemaDiffResult,
    dialect: SchemaDialect,
  ): { up: string[]; down: string[] } {
    return {
      up: this.buildUpSql(diff, dialect),
      down: this.buildDownSql(diff, dialect),
    };
  }

  /**
   * Migration 파일을 디스크에 저장합니다.
   * 파일명: {outputDir}/{timestamp}_{name}.ts
   */
  async save(content: string, outputDir: string, name?: string): Promise<string> {
    await mkdir(outputDir, { recursive: true });
    const timestamp = Date.now();
    const suffix = name ? name.replace(/\s+/g, "_") : "auto_migration";
    const fileName = `${timestamp}_${suffix}.ts`;
    const filePath = join(outputDir, fileName);
    await writeFile(filePath, content, "utf-8");
    return filePath;
  }

  // ─────────────────────────────────────────────────
  // Pure SQL generation (used by both generate and dryRun)
  // ─────────────────────────────────────────────────

  private buildUpSql(
    diff: SchemaDiffResult,
    dialect: SchemaDialect,
  ): string[] {
    const sqls: string[] = [];

    // ENUM type changes (PostgreSQL only — must come before CREATE TABLE)
    for (const ec of diff.enumChanges ?? []) {
      sqls.push(...this.buildEnumUpSql(ec, dialect));
    }

    // Sort addTables by FK dependency order
    const orderedTables = this.sortTablesByDependency(diff);

    // New tables
    for (const table of orderedTables) {
      const entityClass = diff.addTableEntityMap?.[table];
      if (entityClass) {
        const sg = new SchemaGenerator({ dialect, capabilities: this.capabilities });
        sqls.push(sg.generateCreateTableDDL(entityClass));
      }
    }

    // Add columns
    for (const col of diff.addColumns) {
      const typeStr = this.renderColumnType(col, dialect);
      const nullability = col.nullable === false ? "NOT NULL" : "NULL";
      sqls.push(
        `ALTER TABLE ${this.escapeId(col.tableName, dialect)} ADD COLUMN ${this.escapeId(col.columnName, dialect)} ${typeStr} ${nullability}`,
      );
    }

    // Alter columns
    for (const col of diff.alterColumns) {
      const typeStr = col.columnType ?? "VARCHAR(255)";
      if (dialect === "sqlite") {
        // SQLite cannot alter column types — skip in SQL
      } else if (dialect === "mysql") {
        sqls.push(
          `ALTER TABLE ${this.escapeId(col.tableName, dialect)} MODIFY COLUMN ${this.escapeId(col.columnName, dialect)} ${typeStr}`,
        );
      } else {
        sqls.push(
          `ALTER TABLE ${this.escapeId(col.tableName, dialect)} ALTER COLUMN ${this.escapeId(col.columnName, dialect)} TYPE ${typeStr}`,
        );
      }
    }

    // Rename columns
    for (const rename of diff.renamedColumns ?? []) {
      sqls.push(this.buildRenameColumnSql(rename, dialect));
    }

    // Drop tables
    for (const table of diff.dropTables) {
      sqls.push(`DROP TABLE IF EXISTS ${this.escapeId(table, dialect)}`);
    }

    return sqls;
  }

  private buildDownSql(
    diff: SchemaDiffResult,
    dialect: SchemaDialect,
  ): string[] {
    const sqls: string[] = [];

    // Reverse of enum changes
    for (const ec of diff.enumChanges ?? []) {
      sqls.push(...this.buildEnumDownSql(ec, dialect));
    }

    // Reverse of add columns
    for (const col of diff.addColumns) {
      sqls.push(
        `ALTER TABLE ${this.escapeId(col.tableName, dialect)} DROP COLUMN ${this.escapeId(col.columnName, dialect)}`,
      );
    }

    // Reverse of alter columns
    for (const col of diff.alterColumns) {
      const typeStr = col.currentType ?? "VARCHAR(255)";
      if (dialect === "mysql") {
        sqls.push(
          `ALTER TABLE ${this.escapeId(col.tableName, dialect)} MODIFY COLUMN ${this.escapeId(col.columnName, dialect)} ${typeStr}`,
        );
      } else if (dialect !== "sqlite") {
        sqls.push(
          `ALTER TABLE ${this.escapeId(col.tableName, dialect)} ALTER COLUMN ${this.escapeId(col.columnName, dialect)} TYPE ${typeStr}`,
        );
      }
    }

    // Reverse of renames
    for (const rename of diff.renamedColumns ?? []) {
      sqls.push(
        this.buildRenameColumnSql(
          { ...rename, oldColumnName: rename.newColumnName, newColumnName: rename.oldColumnName },
          dialect,
        ),
      );
    }

    // Reverse of add tables
    for (const table of diff.addTables) {
      sqls.push(`DROP TABLE IF EXISTS ${this.escapeId(table, dialect)}`);
    }

    return sqls;
  }

  // ─────────────────────────────────────────────────
  // Statement generation (wraps SQL in await query(...))
  // ─────────────────────────────────────────────────

  private buildUpStatements(
    diff: SchemaDiffResult,
    dialect: SchemaDialect,
  ): string[] {
    const stmts: string[] = [];

    // ENUM type changes (PostgreSQL only — must come before CREATE TABLE)
    for (const ec of diff.enumChanges ?? []) {
      for (const sqlStr of this.buildEnumUpSql(ec, dialect)) {
        stmts.push(this.wrapSqlInQuery(sqlStr));
      }
    }

    // Sort addTables by FK dependency order
    const orderedTables = this.sortTablesByDependency(diff);

    // New tables — generate full DDL when entity class is available
    for (const table of orderedTables) {
      const entityClass = diff.addTableEntityMap?.[table];
      if (entityClass) {
        const sg = new SchemaGenerator({ dialect, capabilities: this.capabilities });
        const ddl = sg.generateCreateTableDDL(entityClass);
        stmts.push(this.wrapSqlInQuery(ddl));
      } else {
        // fallback: entity class not available, generate a comment stub
        stmts.push(
          `// TODO: CREATE TABLE ${this.escapeId(table, dialect)} (/* define columns */); -- entity class not available`,
        );
      }
    }

    // Add columns
    for (const col of diff.addColumns) {
      const typeStr = this.renderColumnType(col, dialect);
      const nullability = col.nullable === false ? "NOT NULL" : "NULL";
      stmts.push(
        this.wrapSqlInQuery(
          `ALTER TABLE ${this.escapeId(col.tableName, dialect)} ADD COLUMN ${this.escapeId(col.columnName, dialect)} ${typeStr} ${nullability}`,
        ),
      );
    }

    // Alter columns (type change)
    for (const col of diff.alterColumns) {
      const typeStr = col.columnType ?? "VARCHAR(255)";
      if (dialect === "sqlite") {
        stmts.push(
          `// TODO: SQLite does not support ALTER COLUMN TYPE for ${this.escapeId(col.tableName, dialect)}.${this.escapeId(col.columnName, dialect)} (${col.currentType} -> ${typeStr}). Recreate the table instead.`,
        );
      } else if (dialect === "mysql") {
        stmts.push(
          this.wrapSqlInQuery(
            `ALTER TABLE ${this.escapeId(col.tableName, dialect)} MODIFY COLUMN ${this.escapeId(col.columnName, dialect)} ${typeStr}`,
          ),
        );
      } else {
        stmts.push(
          this.wrapSqlInQuery(
            `ALTER TABLE ${this.escapeId(col.tableName, dialect)} ALTER COLUMN ${this.escapeId(col.columnName, dialect)} TYPE ${typeStr}`,
          ),
        );
      }
    }

    // Rename columns
    for (const rename of diff.renamedColumns ?? []) {
      stmts.push(this.wrapSqlInQuery(this.buildRenameColumnSql(rename, dialect)));
    }

    // Drop columns (dangerous — commented out)
    for (const col of diff.dropColumns) {
      stmts.push(
        `// ${this.wrapSqlInQuery(`ALTER TABLE ${this.escapeId(col.tableName, dialect)} DROP COLUMN ${this.escapeId(col.columnName, dialect)}`)} // DANGEROUS: uncomment if sure`,
      );
    }

    // Drop tables
    for (const table of diff.dropTables) {
      stmts.push(
        `// ${this.wrapSqlInQuery(`DROP TABLE IF EXISTS ${this.escapeId(table, dialect)}`)} // DANGEROUS: uncomment if sure`,
      );
    }

    if (stmts.length === 0) {
      stmts.push("// No changes detected");
    }

    return stmts;
  }

  private buildDownStatements(
    diff: SchemaDiffResult,
    dialect: SchemaDialect,
  ): string[] {
    const stmts: string[] = [];

    // Reverse of enum changes
    for (const ec of diff.enumChanges ?? []) {
      for (const sqlStr of this.buildEnumDownSql(ec, dialect)) {
        stmts.push(this.wrapSqlInQuery(sqlStr));
      }
    }

    // Reverse of add columns — drop them
    for (const col of diff.addColumns) {
      stmts.push(
        this.wrapSqlInQuery(
          `ALTER TABLE ${this.escapeId(col.tableName, dialect)} DROP COLUMN ${this.escapeId(col.columnName, dialect)}`,
        ),
      );
    }

    // Reverse of alter columns — restore old type
    for (const col of diff.alterColumns) {
      const typeStr = col.currentType ?? "VARCHAR(255)";
      if (dialect === "mysql") {
        stmts.push(
          this.wrapSqlInQuery(
            `ALTER TABLE ${this.escapeId(col.tableName, dialect)} MODIFY COLUMN ${this.escapeId(col.columnName, dialect)} ${typeStr}`,
          ),
        );
      } else if (dialect !== "sqlite") {
        stmts.push(
          this.wrapSqlInQuery(
            `ALTER TABLE ${this.escapeId(col.tableName, dialect)} ALTER COLUMN ${this.escapeId(col.columnName, dialect)} TYPE ${typeStr}`,
          ),
        );
      }
    }

    // Reverse of renames
    for (const rename of diff.renamedColumns ?? []) {
      stmts.push(
        this.wrapSqlInQuery(
          this.buildRenameColumnSql(
            { ...rename, oldColumnName: rename.newColumnName, newColumnName: rename.oldColumnName },
            dialect,
          ),
        ),
      );
    }

    // Reverse of new tables — drop them
    for (const table of diff.addTables) {
      stmts.push(
        this.wrapSqlInQuery(
          `DROP TABLE IF EXISTS ${this.escapeId(table, dialect)}`,
        ),
      );
    }

    // Reverse of drop columns — cannot restore automatically
    if (diff.dropColumns.length > 0) {
      stmts.push("// Cannot restore previously dropped columns automatically");
    }

    if (stmts.length === 0) {
      stmts.push("// No changes to revert");
    }

    return stmts;
  }

  // ─────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────

  /**
   * Generates ALTER TYPE / CREATE TYPE SQL for enum changes (PostgreSQL).
   */
  private buildEnumUpSql(ec: EnumChange, dialect: SchemaDialect): string[] {
    if (dialect !== "postgres") return [];
    const sqls: string[] = [];
    const escapedName = this.escapeId(ec.enumName, dialect);

    if (ec.isNew) {
      const valuesList = ec.addValues
        .map((v) => `'${escapeEnumValue(v)}'`)
        .join(", ");
      sqls.push(`CREATE TYPE ${escapedName} AS ENUM (${valuesList})`);
    } else {
      // Add new values with IF NOT EXISTS
      for (const val of ec.addValues) {
        const escapedVal = escapeEnumValue(val);
        sqls.push(
          `ALTER TYPE ${escapedName} ADD VALUE IF NOT EXISTS '${escapedVal}'`,
        );
      }
      // Removed values: PostgreSQL cannot remove enum values — emit a warning comment
      if (ec.removeValues.length > 0) {
        sqls.push(
          `-- WARNING: Cannot remove enum values from ${escapedName}: ${ec.removeValues.join(", ")}. Recreate the type manually if needed.`,
        );
      }
    }

    return sqls;
  }

  /**
   * Generates down-migration SQL for enum changes.
   */
  private buildEnumDownSql(ec: EnumChange, dialect: SchemaDialect): string[] {
    if (dialect !== "postgres") return [];
    const sqls: string[] = [];
    const escapedName = this.escapeId(ec.enumName, dialect);

    if (ec.isNew) {
      // Reverse of CREATE TYPE — drop it
      sqls.push(`DROP TYPE IF EXISTS ${escapedName}`);
    } else {
      // Cannot reverse ALTER TYPE ADD VALUE in PostgreSQL — emit comment
      if (ec.addValues.length > 0) {
        sqls.push(
          `-- WARNING: Cannot reverse ALTER TYPE ADD VALUE for ${escapedName}. Recreate the type manually if needed.`,
        );
      }
    }

    return sqls;
  }

  /**
   * Wraps a SQL string in a template literal `await query(...)` call.
   * Uses backtick template literals to avoid issues with single/double quote escaping.
   */
  private wrapSqlInQuery(sqlStr: string): string {
    const escaped = sqlStr.replace(/`/g, "\\`").replace(/\$/g, "\\$");
    return `await query(\`${escaped}\`);`;
  }

  private escapeId(name: string, dialect: SchemaDialect): string {
    if (dialect === "mysql") {
      return `\`${name.replace(/`/g, "``")}\``;
    }
    return `"${name.replace(/"/g, '""')}"`;
  }

  private buildRenameColumnSql(rename: RenamedColumn, dialect: SchemaDialect): string {
    const table = this.escapeId(rename.tableName, dialect);
    const oldCol = this.escapeId(rename.oldColumnName, dialect);
    const newCol = this.escapeId(rename.newColumnName, dialect);

    if (dialect === "mysql" && this.capabilities && !this.capabilities.supportsRenameColumn) {
      // MySQL < 8.0: RENAME COLUMN not supported, use CHANGE COLUMN
      const colType = rename.columnType ?? "VARCHAR(255)";
      return `ALTER TABLE ${table} CHANGE COLUMN ${oldCol} ${newCol} ${colType}`;
    }

    const caps = this.capabilities as Record<string, boolean> | undefined;
    if (dialect === "sqlite" && caps && caps.supportsSqliteRenameColumn === false) {
      throw new UnsupportedFeatureError(
        "ALTER TABLE RENAME COLUMN",
        "SQLite 3.25.0+",
        this.versionString ?? "unknown",
      );
    }

    return `ALTER TABLE ${table} RENAME COLUMN ${oldCol} TO ${newCol}`;
  }

  private renderColumnType(col: ColumnChange, _dialect: SchemaDialect): string {
    return col.columnType ?? "VARCHAR(255)";
  }

  /**
   * Sort addTables by FK dependency order using topological sort (Kahn's algorithm).
   * Tables that are referenced by other tables are created first.
   */
  private sortTablesByDependency(diff: SchemaDiffResult): string[] {
    const addTables = diff.addTables;
    if (addTables.length <= 1 || !diff.addTableEntityMap) {
      return addTables;
    }

    const entityMap = diff.addTableEntityMap;
    const addTableSet = new Set(addTables.map((t) => t.toLowerCase()));

    // Build dependency graph: table -> set of tables it depends on
    const deps = new Map<string, Set<string>>();
    for (const table of addTables) {
      deps.set(table, new Set());
    }

    for (const table of addTables) {
      const entity = entityMap[table];
      if (!entity) continue;

      const referencedTables = this.getEntityDependencies(entity);
      for (const ref of referencedTables) {
        if (addTableSet.has(ref.toLowerCase()) && ref.toLowerCase() !== table.toLowerCase()) {
          deps.get(table)!.add(ref);
        }
      }
    }

    // Kahn's algorithm: in-degree = number of dependencies (tables that must be created first)
    const inDegree = new Map<string, number>();
    for (const table of addTables) {
      inDegree.set(table, deps.get(table)!.size);
    }

    const queue: string[] = [];
    for (const table of addTables) {
      if (inDegree.get(table) === 0) {
        queue.push(table);
      }
    }

    const sorted: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      sorted.push(current);

      // For each table that depends on current, decrease its in-degree
      for (const [table, depSet] of deps) {
        if (depSet.has(current)) {
          depSet.delete(current);
          const newDegree = (inDegree.get(table) ?? 1) - 1;
          inDegree.set(table, newDegree);
          if (newDegree === 0) {
            queue.push(table);
          }
        }
      }
    }

    // Circular dependencies — append remaining tables in original order
    if (sorted.length < addTables.length) {
      for (const table of addTables) {
        if (!sorted.includes(table)) {
          sorted.push(table);
        }
      }
    }

    return sorted;
  }

  /**
   * Get table names that an entity depends on (via ManyToOne and OneToOne relations).
   */
  private getEntityDependencies(entity: ClazzType<any>): string[] {
    const deps: string[] = [];

    const m2o = (Reflect.getMetadata(MANY_TO_ONE_TOKEN, entity) ??
      Reflect.getMetadata(MANY_TO_ONE_TOKEN, entity.prototype) ??
      []) as ManyToOneMetadata<any>[];
    for (const rel of m2o) {
      const related = rel.getMappingEntity();
      if (related) {
        const meta = Reflect.getMetadata(ENTITY_TOKEN, related) as
          | EntityMetadata
          | undefined;
        deps.push(meta?.name ?? (related as any).name);
      }
    }

    const o2o = (Reflect.getMetadata(ONE_TO_ONE_TOKEN, entity) ??
      []) as OneToOneMetadata<any>[];
    for (const rel of o2o) {
      if (!rel.joinColumn) continue;
      const related = rel.getRelatedEntity();
      if (related) {
        const meta = Reflect.getMetadata(ENTITY_TOKEN, related) as
          | EntityMetadata
          | undefined;
        deps.push(meta?.name ?? (related as any).name);
      }
    }

    return deps;
  }
}
