/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { PostgresColumnDefinitionBuilder } from "../../src/dialects/postgres/PostgresColumnDefinitionBuilder";
import { MySqlColumnDefinitionBuilder } from "../../src/dialects/mysql/MySqlColumnDefinitionBuilder";
import { SqliteColumnDefinitionBuilder } from "../../src/dialects/sqlite/SqliteColumnDefinitionBuilder";
import { ColumnOption } from "../../src/decorators/Column";
import { SchemaGenerator } from "../../src/core/generators/SchemaGenerator";
import { SchemaDiff } from "../../src/core/generators/SchemaDiff";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";

// ─────────────────────────────────────────────────
// PG `type: "array"` used to emit the bare `ARRAY` placeholder verbatim in
// CREATE TABLE / ADD COLUMN DDL — a PostgreSQL syntax error (42601) that
// continueOnError then swallowed. Arrays must resolve to `element[]`.
// ─────────────────────────────────────────────────

const ctx = { tableName: "test_table", columnName: "test_col" };

describe("PostgresColumnDefinitionBuilder — array columns", () => {
  const builder = new PostgresColumnDefinitionBuilder();

  it("type array → TEXT[] (기본 요소 타입 text)", () => {
    const option: ColumnOption = { type: "array", nullable: true };
    expect(builder.buildColumnDef(option, ctx)).toBe('"test_col" TEXT[] NULL');
  });

  it("arrayElementType int → INTEGER[]", () => {
    const option: ColumnOption = {
      type: "array",
      arrayElementType: "int",
      nullable: false,
    };
    expect(builder.buildColumnDef(option, ctx)).toBe(
      '"test_col" INTEGER[] NOT NULL',
    );
  });

  it("arrayElementType varchar + length → VARCHAR(100)[]", () => {
    const option: ColumnOption = {
      type: "array",
      arrayElementType: "varchar",
      length: 100,
      nullable: true,
    };
    expect(builder.buildColumnDef(option, ctx)).toBe(
      '"test_col" VARCHAR(100)[] NULL',
    );
  });

  it("arrayElementType double + precision/scale → NUMERIC(10,2)[]", () => {
    const option: ColumnOption = {
      type: "array",
      arrayElementType: "double",
      precision: 10,
      scale: 2,
      nullable: true,
    };
    expect(builder.buildColumnDef(option, ctx)).toBe(
      '"test_col" NUMERIC(10, 2)[] NULL',
    );
  });

  it("arrayElementType uuid → UUID[]", () => {
    const option: ColumnOption = {
      type: "array",
      arrayElementType: "uuid",
      nullable: true,
    };
    expect(builder.buildColumnDef(option, ctx)).toBe('"test_col" UUID[] NULL');
  });

  it("지원 불가 요소 타입(enum/array)은 명확히 throw해야 함", () => {
    expect(() =>
      builder.buildColumnDef(
        { type: "array", arrayElementType: "enum", nullable: true },
        ctx,
      ),
    ).toThrow(/element type/);
    expect(() =>
      builder.buildColumnDef(
        { type: "array", arrayElementType: "array", nullable: true },
        ctx,
      ),
    ).toThrow(/element type/);
  });

  it("castType 자체는 information_schema 표기(ARRAY)를 유지해야 함 (diff 비교용)", () => {
    expect(builder.castType("array")).toBe("ARRAY");
  });
});

describe("MySQL/SQLite — array columns (기존 폴백 유지)", () => {
  it("MySQL은 JSON으로 저장 (arrayElementType 무시)", () => {
    const builder = new MySqlColumnDefinitionBuilder();
    const option: ColumnOption = {
      type: "array",
      arrayElementType: "int",
      nullable: true,
    };
    expect(builder.buildColumnDef(option, ctx)).toBe("`test_col` JSON NULL");
  });

  it("SQLite는 TEXT로 저장 (arrayElementType 무시)", () => {
    const builder = new SqliteColumnDefinitionBuilder();
    const option: ColumnOption = {
      type: "array",
      arrayElementType: "int",
      nullable: true,
    };
    expect(builder.buildColumnDef(option, ctx)).toBe('"test_col" TEXT NULL');
  });
});

// ─────────────────────────────────────────────────
// CREATE TABLE + ADD COLUMN paths
// ─────────────────────────────────────────────────

@Entity()
class ArrayDdlPost {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "array", nullable: true })
  tags!: string[];

  @Column({ type: "array", arrayElementType: "int", nullable: true })
  scores!: number[];
}

describe("SchemaGenerator — PG array CREATE TABLE", () => {
  it("CREATE TABLE이 유효한 element[] 타입을 방출해야 함", () => {
    const gen = new SchemaGenerator({ dialect: "postgres" });
    const ddl = gen.generateCreateTableDDL(ArrayDdlPost);
    expect(ddl).toContain('"tags" TEXT[] NULL');
    expect(ddl).toContain('"scores" INTEGER[] NULL');
    expect(ddl).not.toMatch(/\bARRAY\b/);
  });
});

describe("SchemaDiff — PG array ADD COLUMN", () => {
  function createMockQueryRunner(
    responseMap: Record<string, any[]>,
  ): { query: jest.Mock } {
    const mockQuery = jest.fn((sqlInput: any) => {
      const sqlText =
        typeof sqlInput === "string"
          ? sqlInput
          : (sqlInput.text ?? sqlInput.sql ?? "");
      const values =
        typeof sqlInput === "object" && sqlInput !== null
          ? (sqlInput.values ?? [])
          : [];
      for (const [key, value] of Object.entries(responseMap)) {
        if (
          sqlText.includes(key) ||
          values.some((v: any) => String(v).includes(key))
        ) {
          return Promise.resolve(value);
        }
      }
      return Promise.resolve([]);
    });
    return { query: mockQuery };
  }

  it("누락 array 컬럼의 ADD DDL 타입이 element[]여야 함", async () => {
    const runner = createMockQueryRunner({
      array_ddl_post: [
        { column_name: "id", data_type: "integer", is_nullable: "NO" },
        // tags / scores missing from DB
      ],
    });
    const diff = await new SchemaDiff().diff([ArrayDdlPost], runner, "postgres");

    const tags = diff.addColumns.find((c) => c.columnName === "tags");
    const scores = diff.addColumns.find((c) => c.columnName === "scores");
    expect(tags?.columnType).toBe("TEXT[]");
    expect(scores?.columnType).toBe("INTEGER[]");
  });

  it("기존 array 컬럼(data_type ARRAY)은 spurious ALTER를 내지 않아야 함", async () => {
    const runner = createMockQueryRunner({
      array_ddl_post: [
        { column_name: "id", data_type: "integer", is_nullable: "NO" },
        { column_name: "tags", data_type: "ARRAY", is_nullable: "YES" },
        { column_name: "scores", data_type: "ARRAY", is_nullable: "YES" },
      ],
    });
    const diff = await new SchemaDiff().diff([ArrayDdlPost], runner, "postgres");

    expect(diff.addColumns).toHaveLength(0);
    expect(diff.alterColumns).toHaveLength(0);
  });
});
