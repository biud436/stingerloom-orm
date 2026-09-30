/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLUMN_TOKEN } from "../../src/decorators/Column";
import { ENTITY_TOKEN } from "../../src/decorators/Entity";
import { COMPOSITE_INDEX_TOKEN } from "../../src/decorators/Indexer";
import { MANY_TO_ONE_TOKEN } from "../../src/decorators/ManyToOne";
import { RELATION_COLUMN_TOKEN } from "../../src/decorators/RelationColumn";
import { UNIQUE_INDEX_TOKEN } from "../../src/decorators/UniqueIndex";
import { createColumnDefinitionBuilder } from "../../src/dialects/ColumnDefinitionBuilder";
import { dialectTypes } from "../../src/introspection/catalog";
import { EntityCodeBuilder, EntityCodeStyle } from "../../src/introspection/EntityCodeBuilder";
import type { EntityModel, ModelColumnField } from "../../src/introspection/EntityModel";
import { lowerTable } from "../../src/introspection/lowering/lowerTable";
import { classNameToFileName, SchemaNaming } from "../../src/introspection/lowering/Naming";
import { TypeOracle } from "../../src/introspection/lowering/TypeSelection";
import type { ColumnIR, TableIR } from "../../src/introspection/SchemaIR";
import type { IntrospectionDialect } from "../../src/introspection/TypeMapper";
import {
  loadGenerated,
  SRC_INDEX,
  typeCheck,
  writeGenerated,
} from "../helpers/generatedEntities";

/**
 * Emitter conformance: what the generated code declares is what the model
 * says.
 *
 * Both emitters' output is type checked under `strict`, loaded, and read back
 * from the ORM's own metadata. Every column's declared type is rendered
 * through the dialect's column definition builder and compared with the type
 * the model chose; nullability, keys, generation, defaults, relation columns,
 * referential actions and indexes are compared field by field. A string-level
 * test cannot see an option the ORM ignores (an `enum:` key the Column
 * decorator does not read) or one it infers differently per notation (a
 * primary key whose type came from `design:type`); this does.
 */

function column(
  dialect: IntrospectionDialect,
  name: string,
  nativeType: string,
  extra: Partial<ColumnIR> = {},
): ColumnIR {
  const enumLabels = ["draft", "it's \"quoted\"", "live"];
  const resolve = (n: string) =>
    n === "post_status" ? ({ kind: "enum", values: enumLabels, name: "post_status" } as const) : undefined;
  return {
    name,
    type: dialectTypes(dialect).parseType(nativeType, resolve),
    nullable: false,
    identity: false,
    nativeType,
    ...extra,
  };
}

function schema(dialect: IntrospectionDialect): TableIR[] {
  const c = (name: string, type: string, extra: Partial<ColumnIR> = {}) =>
    column(dialect, name, type, extra);
  const pg = dialect === "postgres";
  const mysql = dialect === "mysql";

  const authors: TableIR = {
    name: "authors",
    columns: [
      c("id", pg ? "bigint" : mysql ? "bigint" : "INTEGER", { identity: true }),
      c("email", pg ? "character varying(120)" : mysql ? "varchar(120)" : "VARCHAR(120)"),
      c("display_name", pg ? "character varying(80)" : mysql ? "varchar(80)" : "VARCHAR(80)", {
        nullable: true,
        default: { kind: "string", value: "anon \\ \"x\" 'y'" },
      }),
      c("order-ref", pg ? "character(8)" : mysql ? "char(8)" : "CHAR(8)", { nullable: true }),
      c("bio", pg ? "text" : mysql ? "text" : "TEXT", { nullable: true }),
      c("meta", pg ? "jsonb" : mysql ? "json" : "JSON"),
      c("avatar", pg ? "bytea" : mysql ? "blob" : "BLOB"),
      c("is_active", pg ? "boolean" : mysql ? "tinyint(1)" : "BOOLEAN", {
        default: { kind: "boolean", value: true },
      }),
      c("rating", pg ? "numeric(5,2)" : mysql ? "decimal(5,2)" : "DECIMAL(5,2)", {
        nullable: true,
        default: { kind: "number", value: "0.50" },
      }),
      c("status", pg ? "post_status" : mysql ? "enum('draft','it''s \"quoted\"','live')" : "TEXT", {
        default: pg || mysql ? { kind: "string", value: "draft" } : undefined,
      }),
      ...(pg ? [c("tags", "integer[]"), c("labels", "character varying(20)[]", { nullable: true })] : []),
      c("uuid", pg ? "uuid" : mysql ? "char(36)" : "VARCHAR(36)"),
      c("born_on", pg ? "date" : mysql ? "date" : "DATE", { nullable: true }),
      c("created_at", pg ? "timestamp with time zone" : mysql ? "timestamp" : "DATETIME"),
      c("deleted_at", pg ? "timestamp without time zone" : mysql ? "datetime" : "DATETIME", {
        nullable: true,
      }),
      c("seen_at", pg ? "timestamp without time zone" : mysql ? "datetime" : "DATETIME", {
        default: { kind: "expression", sql: "CURRENT_TIMESTAMP" },
      }),
    ],
    primaryKey: ["id"],
    foreignKeys: [],
    indexes: [
      { name: "uq_authors_email", unique: true, columns: ["email"], unsupported: [] },
      { name: "idx_authors_bio", unique: false, columns: ["is_active", "created_at"], unsupported: [] },
    ],
  };

  const posts: TableIR = {
    name: "posts",
    columns: [
      c("code", pg ? "character(8)" : mysql ? "char(8)" : "CHAR(8)"),
      c("author_id", pg ? "bigint" : mysql ? "bigint" : "INTEGER"),
      c("editor_id", pg ? "bigint" : mysql ? "bigint" : "INTEGER", { nullable: true }),
      c("title", pg ? "character varying(200)" : mysql ? "varchar(200)" : "VARCHAR(200)"),
    ],
    primaryKey: ["code"],
    foreignKeys: [
      { columns: ["author_id"], referencedTable: "authors", referencedColumns: ["id"], onDelete: "CASCADE", onUpdate: "NO ACTION" },
      { columns: ["editor_id"], referencedTable: "authors", referencedColumns: ["id"], onDelete: "SET NULL", onUpdate: "CASCADE" },
    ],
    indexes: [
      { name: "uq_posts_author_title", unique: true, columns: ["author_id", "title"], unsupported: [] },
    ],
  };

  // A closure table: both key columns are foreign keys.
  const closures: TableIR = {
    name: "author_closures",
    columns: [
      c("ancestor_id", pg ? "bigint" : mysql ? "bigint" : "INTEGER"),
      c("descendant_id", pg ? "bigint" : mysql ? "bigint" : "INTEGER"),
      c("depth", pg ? "integer" : mysql ? "int" : "INTEGER"),
    ],
    primaryKey: ["ancestor_id", "descendant_id"],
    foreignKeys: [
      { columns: ["ancestor_id"], referencedTable: "authors", referencedColumns: ["id"], onDelete: "NO ACTION", onUpdate: "NO ACTION" },
      { columns: ["descendant_id"], referencedTable: "authors", referencedColumns: ["id"], onDelete: "NO ACTION", onUpdate: "NO ACTION" },
    ],
    indexes: [],
  };

  return [authors, posts, closures];
}

function lower(dialect: IntrospectionDialect, tables: TableIR[]): EntityModel[] {
  const types = dialectTypes(dialect);
  const byName = new Map(tables.map((t) => [t.name, t]));
  const naming = new SchemaNaming([...byName.keys()]);
  return tables.map((table) =>
    lowerTable(table, {
      types,
      oracle: new TypeOracle(types),
      naming,
      generatedTables: new Set(byName.keys()),
      tables: byName,
    }),
  );
}

/** Evaluates a TypeScript literal the emitters wrote for a default. */
function valueOf(literal: string): unknown {
  // eslint-disable-next-line no-new-func
  return new Function(`return (${literal});`)();
}

let tempDir: string;
beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "stg-conformance-"));
});
afterAll(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe.each<IntrospectionDialect>(["postgres", "mysql", "sqlite"])("%s", (dialect) => {
  const types = dialectTypes(dialect);
  const builder = createColumnDefinitionBuilder(dialect);
  const oracle = new TypeOracle(types);
  const models = lower(dialect, schema(dialect));

  describe.each<EntityCodeStyle>(["decorator", "code-first"])("%s style", (style) => {
    let classes: any[];

    beforeAll(async () => {
      const emitter = new EntityCodeBuilder({ importPath: SRC_INDEX, style });
      const files = new Map(
        models.map((m) => [classNameToFileName(m.className), emitter.emit(m)]),
      );
      const paths = await writeGenerated(join(tempDir, `${dialect}-${style}`), files);
      expect(typeCheck(paths)).toEqual([]);
      classes = loadGenerated(paths);
    }, 60000);

    const classOf = (model: EntityModel) =>
      classes.find((cls) => Reflect.getMetadata(ENTITY_TOKEN, cls)?.name === model.tableName);

    it.each(models.map((m) => [m.tableName, m] as const))(
      "%s declares every column the way the model does",
      (_name, model) => {
        const cls = classOf(model);
        expect(cls).toBeDefined();
        const metadata: any[] = Reflect.getMetadata(COLUMN_TOKEN, cls.prototype) ?? [];

        for (const field of model.fields) {
          if (field.kind !== "column") continue;
          const meta = metadata.find((m) => m.name === field.columnName);
          expect({ column: field.columnName, found: !!meta }).toEqual({
            column: field.columnName,
            found: true,
          });
          const at = { tableName: model.tableName, columnName: field.columnName };
          const declared = builder.buildColumnTypeExpr(meta.options, at);
          const intended = oracle.render(ormOf(field), at).ddl;
          const parse = (ddl: string) => types.parseType(ddl, (n) =>
            n === (field.enumName ?? `${model.tableName}_${field.columnName}_enum`)
              ? { kind: "enum", values: field.enumValues ?? [], name: n }
              : undefined,
          );

          const codeFirstBlob = style === "code-first" && field.columnType === "blob" && !field.nullable;
          expect({
            column: field.columnName,
            type: parse(declared),
            nullable: codeFirstBlob ? field.nullable : !!meta.options.nullable,
            primary: !!meta.options.primary,
            generated: !!meta.options.autoIncrement,
            enumName: meta.options.enumName,
            default: meta.options.default,
          }).toEqual({
            column: field.columnName,
            type: parse(intended),
            nullable: field.nullable,
            primary: field.primary,
            generated: field.generated,
            enumName: field.enumName,
            default: field.defaultLiteral === undefined ? undefined : valueOf(field.defaultLiteral),
          });
          if (codeFirstBlob) {
            // The note says what the builder cannot.
            expect(meta.options.nullable).toBe(true);
          }
        }
      },
    );

    it.each(models.map((m) => [m.tableName, m] as const))(
      "%s declares every relation the way the model does",
      (_name, model) => {
        const cls = classOf(model);
        const relationColumns: any[] =
          Reflect.getMetadata(RELATION_COLUMN_TOKEN, cls) ??
          Reflect.getMetadata(RELATION_COLUMN_TOKEN, cls.prototype) ??
          [];
        const manyToOnes: any[] = Reflect.getMetadata(MANY_TO_ONE_TOKEN, cls) ?? [];

        for (const field of model.fields) {
          if (field.kind !== "manyToOne") continue;
          const rc = relationColumns.find((r) => r.propertyKey === field.propertyName);
          const m2o = manyToOnes.find((r) => r.columnName === field.propertyName);
          expect({
            name: rc?.name,
            type: rc?.type,
            nullable: rc?.nullable,
            referencedColumn: rc?.referencedColumn,
            onDelete: m2o?.option?.onDelete,
            onUpdate: m2o?.option?.onUpdate,
          }).toEqual({
            name: field.fkColumn,
            type: field.fkType,
            nullable: field.fkNullable,
            referencedColumn: field.referencedColumn,
            onDelete: field.onDelete,
            onUpdate: field.onUpdate,
          });
        }
      },
    );

    it.each(models.map((m) => [m.tableName, m] as const))(
      "%s declares its class-level indexes",
      (_name, model) => {
        const cls = classOf(model);
        const unique: any[] = Reflect.getMetadata(UNIQUE_INDEX_TOKEN, cls) ?? [];
        const plain: any[] = Reflect.getMetadata(COMPOSITE_INDEX_TOKEN, cls) ?? [];
        const declared = [
          ...unique.map((u) => ({ columns: u.columns, name: u.name, unique: true })),
          ...plain.map((p) => ({ columns: p.columns, name: p.name ?? p.options?.name, unique: false })),
        ];
        expect(declared).toEqual(
          model.classIndexes.map((i) => ({ columns: i.columns, name: i.name, unique: i.unique })),
        );
      },
    );
  });
});

function ormOf(field: ModelColumnField) {
  return {
    type: field.columnType,
    ...(field.length !== undefined ? { length: field.length } : {}),
    ...(field.precision !== undefined ? { precision: field.precision, scale: field.scale } : {}),
    ...(field.enumValues ? { enumValues: field.enumValues } : {}),
    ...(field.enumName ? { enumName: field.enumName } : {}),
    ...(field.arrayElementType ? { arrayElementType: field.arrayElementType } : {}),
  };
}
