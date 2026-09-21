/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { SchemaDiff } from "../../src/core/generators/SchemaDiff";
import { SchemaGenerator } from "../../src/core/generators/SchemaGenerator";
import { Entity } from "../../src/decorators/Entity";
import { Column, COLUMN_TOKEN, ColumnType } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { MySqlColumnDefinitionBuilder } from "../../src/dialects/mysql/MySqlColumnDefinitionBuilder";
import { SqliteColumnDefinitionBuilder } from "../../src/dialects/sqlite/SqliteColumnDefinitionBuilder";
import { PostgresColumnDefinitionBuilder } from "../../src/dialects/postgres/PostgresColumnDefinitionBuilder";
import { ALL_MYSQL } from "../../src/dialects/DialectCapabilities";
import { createColumnDefinitionBuilder } from "../../src/dialects/ColumnDefinitionBuilder";

/**
 * The declared type SchemaDiff proposes must be the one the dialect's column
 * builder renders — the type CREATE TABLE would have given the column on the
 * connected server version.
 *
 * Before this was wired up, SchemaDiff kept its own three type tables: MySQL's
 * `uuid` was created as `CHAR(36)` but *added* as a bare `CHAR`, which MySQL
 * reads as `CHAR(1)` (later INSERTs fail under strict mode, or truncate to one
 * character without it), and a MariaDB 10.7 column created as native `UUID`
 * was reported as drifted on every single boot.
 */
describe("SchemaDiff — declared types come from the dialect column builder", () => {
  function runnerFor(columns: any[]): { query: jest.Mock } {
    return {
      query: jest.fn(async () => columns),
    };
  }

  @Entity({ name: "dt_doc" })
  class DtDoc {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: "uuid" })
    publicId!: string;
  }

  const existingIdOnly = [
    { column_name: "id", data_type: "int", is_nullable: "NO" },
  ];

  describe("MySQL uuid", () => {
    it("adds the column as CHAR(36), not a bare CHAR (which MySQL reads as CHAR(1))", async () => {
      const result = await new SchemaDiff().diff(
        [DtDoc],
        runnerFor(existingIdOnly),
        "mysql",
      );

      const added = result.addColumns.find((c) => c.columnName === "publicId");
      expect(added!.columnType).toBe("CHAR(36)");
      expect(added!.comparisonType).toBe("CHAR");
      expect(added!.expectedLength).toBe(36);
    });

    it("repairs a column left at CHAR(1) by the old ADD COLUMN path", async () => {
      const result = await new SchemaDiff().diff(
        [DtDoc],
        runnerFor([
          ...existingIdOnly,
          {
            column_name: "publicId",
            data_type: "char",
            is_nullable: "NO",
            character_maximum_length: 1,
          },
        ]),
        "mysql",
      );

      const alter = result.alterColumns.find((c) => c.columnName === "publicId");
      expect(alter).toBeDefined();
      expect(alter!.columnType).toBe("CHAR(36)");
      expect(alter!.actualLength).toBe(1);
    });

    it("does not churn a healthy CHAR(36) column", async () => {
      const result = await new SchemaDiff().diff(
        [DtDoc],
        runnerFor([
          ...existingIdOnly,
          {
            column_name: "publicId",
            data_type: "char",
            is_nullable: "NO",
            character_maximum_length: 36,
          },
        ]),
        "mysql",
      );

      expect(result.alterColumns).toHaveLength(0);
    });
  });

  describe("MariaDB 10.7+ native uuid", () => {
    const mariaBuilder = new MySqlColumnDefinitionBuilder({
      ...ALL_MYSQL,
      supportsNativeUuidType: true,
    });

    it("adds the column as UUID", async () => {
      const result = await new SchemaDiff().diff(
        [DtDoc],
        runnerFor(existingIdOnly),
        "mysql",
        undefined,
        { columnBuilder: mariaBuilder },
      );

      expect(
        result.addColumns.find((c) => c.columnName === "publicId")!.columnType,
      ).toBe("UUID");
    });

    it("reports no drift on the second boot of a native UUID column", async () => {
      const result = await new SchemaDiff().diff(
        [DtDoc],
        runnerFor([
          ...existingIdOnly,
          {
            column_name: "publicId",
            data_type: "uuid",
            is_nullable: "NO",
            character_maximum_length: null,
          },
        ]),
        "mysql",
        undefined,
        { columnBuilder: mariaBuilder },
      );

      expect(result.alterColumns).toHaveLength(0);
      expect(result.addColumns).toHaveLength(0);
    });
  });

  describe("server versions without a JSON column type", () => {
    @Entity({ name: "dt_payload" })
    class DtPayload {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: "json", nullable: true })
      body!: unknown;
    }

    it("adds LONGTEXT and does not churn it afterwards (MySQL 5.6)", async () => {
      const legacy = new MySqlColumnDefinitionBuilder({
        ...ALL_MYSQL,
        supportsJsonColumnType: false,
      });

      const added = await new SchemaDiff().diff(
        [DtPayload],
        runnerFor(existingIdOnly),
        "mysql",
        undefined,
        { columnBuilder: legacy },
      );
      expect(
        added.addColumns.find((c) => c.columnName === "body")!.columnType,
      ).toBe("LONGTEXT");

      const second = await new SchemaDiff().diff(
        [DtPayload],
        runnerFor([
          ...existingIdOnly,
          { column_name: "body", data_type: "longtext", is_nullable: "YES" },
        ]),
        "mysql",
        undefined,
        { columnBuilder: legacy },
      );
      expect(second.alterColumns).toHaveLength(0);
    });
  });

  describe("PostgreSQL and SQLite uuid", () => {
    it("PostgreSQL adds UUID and does not churn it", async () => {
      const added = await new SchemaDiff().diff(
        [DtDoc],
        runnerFor([{ column_name: "id", data_type: "integer", is_nullable: "NO" }]),
        "postgres",
      );
      expect(
        added.addColumns.find((c) => c.columnName === "publicId")!.columnType,
      ).toBe("UUID");

      const second = await new SchemaDiff().diff(
        [DtDoc],
        runnerFor([
          { column_name: "id", data_type: "integer", is_nullable: "NO" },
          { column_name: "publicId", data_type: "uuid", is_nullable: "NO" },
        ]),
        "postgres",
      );
      expect(second.alterColumns).toHaveLength(0);
    });

    it("SQLite adds VARCHAR(36) and does not churn it", async () => {
      const added = await new SchemaDiff().diff(
        [DtDoc],
        {
          query: jest.fn(async () => [
            { name: "id", type: "INTEGER", notnull: 1 },
          ]),
        },
        "sqlite",
      );
      expect(
        added.addColumns.find((c) => c.columnName === "publicId")!.columnType,
      ).toBe("VARCHAR(36)");

      const second = await new SchemaDiff().diff(
        [DtDoc],
        {
          query: jest.fn(async () => [
            { name: "id", type: "INTEGER", notnull: 1 },
            { name: "publicId", type: "VARCHAR(36)", notnull: 1 },
          ]),
        },
        "sqlite",
      );
      expect(second.alterColumns).toHaveLength(0);
    });
  });

  describe("no drift between CREATE TABLE and ADD COLUMN", () => {
    const SCALARS: ColumnType[] = [
      "varchar",
      "int",
      "number",
      "float",
      "double",
      "bigint",
      "boolean",
      "datetime",
      "timestamp",
      "timestamptz",
      "date",
      "text",
      "longtext",
      "blob",
      "char",
      "json",
      "jsonb",
      "uuid",
    ];

    it.each(["mysql", "postgres", "sqlite"] as const)(
      "%s: every scalar type is added exactly as CREATE TABLE declares it",
      async (dialect) => {
        const builder = createColumnDefinitionBuilder(dialect as any);
        const generator = new SchemaGenerator({ dialect });

        for (const type of SCALARS) {
          const Dyn = class {} as any;
          Object.defineProperty(Dyn, "name", { value: `dt_${type}` });
          Reflect.defineMetadata("design:type", String, Dyn.prototype, "id");
          PrimaryGeneratedColumn()(Dyn.prototype, "id");
          Reflect.defineMetadata("design:type", String, Dyn.prototype, "value");
          Column({ type, nullable: true })(Dyn.prototype, "value");
          Entity({ name: `dt_${type}` })(Dyn);

          const diff = await new SchemaDiff().diff(
            [Dyn],
            {
              query: jest.fn(async () =>
                dialect === "sqlite"
                  ? [{ name: "id", type: "INTEGER", notnull: 1 }]
                  : [{ column_name: "id", data_type: "int", is_nullable: "NO" }],
              ),
            },
            dialect,
          );

          const added = diff.addColumns.find((c) => c.columnName === "value");
          expect(added).toBeDefined();

          const createTable = generator.generateCreateTableDDL(Dyn);
          // The type as it appears in CREATE TABLE, rendered from the same
          // resolved column options the entity carries.
          const options = (
            Reflect.getMetadata(COLUMN_TOKEN, Dyn.prototype) as any[]
          ).find((c) => c.name === "value").options;
          const declared = builder.buildColumnTypeExpr(options, {
            columnName: "value",
            tableName: `dt_${type}`,
          });
          expect(createTable).toContain(declared);
          expect(added!.columnType).toBe(declared);
        }
      },
    );

    it("keeps the builders reachable for direct rendering", () => {
      expect(
        new SqliteColumnDefinitionBuilder().buildColumnTypeExpr(
          { type: "uuid" } as any,
          { columnName: "x", tableName: "t" },
        ),
      ).toBe("VARCHAR(36)");
      expect(
        new PostgresColumnDefinitionBuilder().buildColumnTypeExpr(
          { type: "double", precision: 12, scale: 4 } as any,
          { columnName: "x", tableName: "t" },
        ),
      ).toBe("NUMERIC(12, 4)");
    });
  });
});
