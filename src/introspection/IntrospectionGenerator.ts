/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  CatalogReader,
  createCatalogReader,
  DialectTypes,
  dialectTypes,
} from "./catalog";
import {
  DbColumn,
  DbForeignKey,
  DbIndex,
  legacyColumnRow,
  legacyForeignKeyRows,
} from "./catalog/legacyRows";
import {
  EntityCodeBuilder,
  EntityCodeBuilderOptions,
} from "./EntityCodeBuilder";
import type { EntityModel } from "./EntityModel";
import { lowerTable } from "./lowering/lowerTable";
import { classNameToFileName, SchemaNaming } from "./lowering/Naming";
import { TypeOracle } from "./lowering/TypeSelection";
import type { SchemaIR, TableIR } from "./SchemaIR";
import { IntrospectionDialect } from "./TypeMapper";

/**
 * Represents a generated entity file.
 */
export interface GeneratedEntity {
  tableName: string;
  className: string;
  code: string;
  fileName: string;
  /**
   * Everything the generated file flags with a `// NOTE:` comment — each
   * place the entity would not recreate the table exactly.
   */
  notes: string[];
}

/**
 * Options for IntrospectionGenerator.
 */
export interface IntrospectionGeneratorOptions {
  /**
   * PostgreSQL schema to introspect. Default: "public"
   */
  schema?: string;

  /**
   * Tables to exclude from generation.
   */
  excludeTables?: string[];

  /**
   * Tables to include (if set, only these tables are generated).
   */
  includeTables?: string[];

  /**
   * EntityCodeBuilder options (import path etc.)
   */
  codeBuilderOptions?: EntityCodeBuilderOptions;
}

/**
 * Query function interface for introspection.
 * Accepts both plain SQL strings and sql-template-tag Sql objects.
 */
export interface IntrospectionQueryFn {
  (sql: string | import("sql-template-tag").Sql): Promise<any>;
}

/**
 * Generates TypeScript entity files from an existing database schema.
 *
 * The generation runs as a small compiler:
 *
 * 1. **Read** — the dialect's catalog reader turns the database's own
 *    description of each table into the dialect-neutral {@link SchemaIR}.
 *    All knowledge of how PostgreSQL, MySQL/MariaDB or SQLite spell types,
 *    defaults, identity columns and keys lives in that one reader.
 * 2. **Lower** — each table becomes an {@link EntityModel}: names, relations,
 *    indexes, and an ORM column type chosen by rendering candidates through
 *    the ORM's own column definition builder and parsing the DDL back, so the
 *    fidelity of every mapping is checked rather than assumed.
 * 3. **Emit** — the model is spelled out as decorated classes or
 *    `defineEntity` builders.
 *
 * Anything the entity cannot reproduce exactly is written into the file as a
 * `// NOTE:` comment and returned in {@link GeneratedEntity.notes}.
 *
 * @example
 * ```ts
 * const generator = new IntrospectionGenerator(
 *   (q) => driver.query(q),
 *   "postgres",
 *   { schema: "public" },
 * );
 * const entities = await generator.generate();
 * for (const entity of entities) {
 *   fs.writeFileSync(`./entities/${entity.fileName}`, entity.code);
 * }
 * ```
 */
export class IntrospectionGenerator {
  private readonly dialect: IntrospectionDialect;
  private readonly schema: string;
  private readonly excludeTables: Set<string>;
  private readonly includeTables: Set<string> | null;
  private readonly codeBuilder: EntityCodeBuilder;
  private readonly reader: CatalogReader;
  private readonly types: DialectTypes;

  constructor(
    queryFn: IntrospectionQueryFn,
    dialect: IntrospectionDialect,
    options?: IntrospectionGeneratorOptions,
  ) {
    this.dialect = dialect;
    this.schema = options?.schema ?? "public";
    this.excludeTables = new Set(options?.excludeTables ?? []);
    this.includeTables = options?.includeTables
      ? new Set(options.includeTables)
      : null;
    this.codeBuilder = new EntityCodeBuilder(options?.codeBuilderOptions);
    this.reader = createCatalogReader(dialect, queryFn, { schema: this.schema });
    this.types = dialectTypes(dialect);
  }

  /**
   * Generate entity files for all discovered tables.
   */
  async generate(): Promise<GeneratedEntity[]> {
    const schema = await this.readSchema();
    const { capabilities } = await this.reader.readServerInfo();
    const oracle = new TypeOracle(this.types, { schema: this.schema, capabilities });
    const tables = new Map(schema.tables.map((table) => [table.name, table]));
    const naming = new SchemaNaming([...tables.keys()]);

    return schema.tables.map((table) => {
      const model = lowerTable(table, {
        types: this.types,
        oracle,
        naming,
        generatedTables: new Set(tables.keys()),
        tables,
      });
      return {
        tableName: table.name,
        className: model.className,
        code: this.codeBuilder.emit(model),
        fileName: classNameToFileName(model.className),
        notes: collectNotes(model),
      };
    });
  }

  /**
   * Reads the selected tables (after `includeTables` / `excludeTables`) into
   * the dialect-neutral schema IR — the input the entity generation compiles
   * from, and a structural description of the schema in its own right.
   */
  async readSchema(): Promise<SchemaIR> {
    const names = (await this.discoverTables()).filter(
      (table) =>
        !this.excludeTables.has(table) &&
        (!this.includeTables || this.includeTables.has(table)),
    );
    const tables: TableIR[] = [];
    for (const name of names) tables.push(await this.reader.readTable(name));
    return {
      dialect: this.dialect,
      ...(this.dialect === "postgres" ? { schema: this.schema } : {}),
      tables,
    };
  }

  /** Reads one table into the schema IR. */
  readTable(table: string): Promise<TableIR> {
    return this.reader.readTable(table);
  }

  /**
   * Discover all user tables in the database (no views), sorted by name.
   */
  discoverTables(): Promise<string[]> {
    return this.reader.listTables();
  }

  /**
   * Get column metadata for a specific table.
   *
   * @deprecated Use {@link readTable}, whose columns carry the parsed type,
   * default and identity instead of the catalog's raw strings.
   */
  async getColumns(table: string): Promise<DbColumn[]> {
    const ir = await this.reader.readTable(table);
    return ir.columns.map((column) => legacyColumnRow(this.dialect, column));
  }

  /**
   * Get primary key column names for a specific table, in key order.
   *
   * @deprecated Use {@link readTable} (`primaryKey`).
   */
  async getPrimaryKeys(table: string): Promise<string[]> {
    return (await this.reader.readTable(table)).primaryKey;
  }

  /**
   * Get foreign key columns for a specific table — one row per column, rows
   * of a composite key sharing its `constraint_name`.
   *
   * @deprecated Use {@link readTable} (`foreignKeys`), which also carries the
   * referential actions.
   */
  async getForeignKeys(table: string): Promise<DbForeignKey[]> {
    return legacyForeignKeyRows(await this.reader.readTable(table));
  }

  /**
   * Get non-PK indexes (unique and non-unique) for a specific table.
   * Single-column indexes that exactly cover a FK column are left out.
   *
   * @deprecated Use {@link readTable} (`indexes`), which keeps every index
   * and says what an index has beyond plain columns.
   */
  async getIndexes(table: string): Promise<DbIndex[]> {
    const ir = await this.reader.readTable(table);
    const fkColumns = new Set(
      ir.foreignKeys.filter((fk) => fk.columns.length === 1).map((fk) => fk.columns[0]),
    );
    return ir.indexes
      .filter((idx) => !(idx.columns.length === 1 && fkColumns.has(idx.columns[0])))
      .map((idx) => ({
        name: idx.name,
        column_names: idx.columns,
        is_unique: idx.unique,
      }));
  }
}

/** Every note of a model, field notes prefixed with their property. */
function collectNotes(model: EntityModel): string[] {
  return [
    ...model.notes,
    ...model.fields.flatMap((field) =>
      (field.warnings ?? []).map((note) => `${field.propertyName}: ${note}`),
    ),
  ];
}
