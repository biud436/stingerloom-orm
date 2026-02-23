import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SchemaDiffResult, ColumnChange } from "./SchemaDiff";
import { SchemaGenerator, SchemaDialect } from "./SchemaGenerator";

/**
 * SchemaDiffResult를 받아 Migration TypeScript 파일을 생성합니다.
 */
export class SchemaDiffMigrationGenerator {
  /**
   * diff 결과를 받아 Migration TypeScript 파일 내용을 생성합니다.
   */
  generate(diff: SchemaDiffResult, dialect: SchemaDialect): string {
    const timestamp = Date.now();
    const className = `AutoMigration_${timestamp}`;
    const upStatements = this.buildUpStatements(diff, dialect);
    const downStatements = this.buildDownStatements(diff, dialect);

    return [
      `import { Migration, MigrationContext } from "stingerloom-orm";`,
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
   * Migration 파일을 디스크에 저장합니다.
   * 파일명: {outputDir}/{timestamp}_auto_migration.ts
   */
  async save(content: string, outputDir: string): Promise<string> {
    await mkdir(outputDir, { recursive: true });
    const timestamp = Date.now();
    const fileName = `${timestamp}_auto_migration.ts`;
    const filePath = join(outputDir, fileName);
    await writeFile(filePath, content, "utf-8");
    return filePath;
  }

  private buildUpStatements(
    diff: SchemaDiffResult,
    dialect: SchemaDialect,
  ): string[] {
    const stmts: string[] = [];

    // New tables — generate full DDL when entity class is available
    for (const table of diff.addTables) {
      const entityClass = diff.addTableEntityMap?.[table];
      if (entityClass) {
        const sg = new SchemaGenerator({ dialect });
        const ddl = sg.generateCreateTableDDL(entityClass);
        // escape single quotes in DDL for embedding in string literal
        const escaped = ddl.replace(/'/g, "\\'");
        stmts.push(`await query('${escaped}');`);
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
      const nullability = col.nullable ? "NULL" : "NOT NULL";
      stmts.push(
        `await query('ALTER TABLE ${this.escapeId(col.tableName, dialect)} ADD COLUMN ${this.escapeId(col.columnName, dialect)} ${typeStr} ${nullability}');`,
      );
    }

    // Alter columns (type change)
    for (const col of diff.alterColumns) {
      const typeStr = col.columnType ?? "VARCHAR(255)";
      if (dialect === "mysql") {
        stmts.push(
          `await query('ALTER TABLE ${this.escapeId(col.tableName, dialect)} MODIFY COLUMN ${this.escapeId(col.columnName, dialect)} ${typeStr}');`,
        );
      } else {
        stmts.push(
          `await query('ALTER TABLE ${this.escapeId(col.tableName, dialect)} ALTER COLUMN ${this.escapeId(col.columnName, dialect)} TYPE ${typeStr}');`,
        );
      }
    }

    // Drop columns (dangerous — commented out)
    for (const col of diff.dropColumns) {
      stmts.push(
        `// await query('ALTER TABLE ${this.escapeId(col.tableName, dialect)} DROP COLUMN ${this.escapeId(col.columnName, dialect)}'); // DANGEROUS: uncomment if sure`,
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

    // Reverse of add columns — drop them
    for (const col of diff.addColumns) {
      stmts.push(
        `await query('ALTER TABLE ${this.escapeId(col.tableName, dialect)} DROP COLUMN ${this.escapeId(col.columnName, dialect)}');`,
      );
    }

    // Reverse of alter columns — restore old type
    for (const col of diff.alterColumns) {
      const typeStr = col.currentType ?? "VARCHAR(255)";
      if (dialect === "mysql") {
        stmts.push(
          `await query('ALTER TABLE ${this.escapeId(col.tableName, dialect)} MODIFY COLUMN ${this.escapeId(col.columnName, dialect)} ${typeStr}');`,
        );
      } else {
        stmts.push(
          `await query('ALTER TABLE ${this.escapeId(col.tableName, dialect)} ALTER COLUMN ${this.escapeId(col.columnName, dialect)} TYPE ${typeStr}');`,
        );
      }
    }

    // Reverse of new tables — drop them
    for (const table of diff.addTables) {
      stmts.push(
        `await query('DROP TABLE IF EXISTS ${this.escapeId(table, dialect)}');`,
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

  private escapeId(name: string, dialect: SchemaDialect): string {
    if (dialect === "postgres") {
      return `"${name.replace(/"/g, '""')}"`;
    }
    return `\`${name.replace(/`/g, "``")}\``;
  }

  private renderColumnType(col: ColumnChange, _dialect: SchemaDialect): string {
    return col.columnType ?? "VARCHAR(255)";
  }
}
