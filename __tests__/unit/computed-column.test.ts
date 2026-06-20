/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { SchemaGenerator } from "../../src/core/generators/SchemaGenerator";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { ComputedColumn, COMPUTED_COLUMN_TOKEN } from "../../src/decorators/ComputedColumn";
import { Logger } from "../../src/utils/Logger";

describe("@ComputedColumn (#131)", () => {
  describe("decorator metadata", () => {
    it("should store computed column metadata", () => {
      class Test {
        @ComputedColumn({ expression: "a + b", stored: true })
        sum!: number;
      }

      const meta = Reflect.getMetadata(COMPUTED_COLUMN_TOKEN, Test.prototype);
      expect(meta).toHaveLength(1);
      expect(meta[0].name).toBe("sum");
      expect(meta[0].options.expression).toBe("a + b");
      expect(meta[0].options.stored).toBe(true);
    });

    it("should support multiple computed columns", () => {
      class Multi {
        @ComputedColumn({ expression: "a + b" })
        sum!: number;

        @ComputedColumn({ expression: "a * b", stored: true })
        product!: number;
      }

      const meta = Reflect.getMetadata(COMPUTED_COLUMN_TOKEN, Multi.prototype);
      expect(meta).toHaveLength(2);
    });
  });

  describe("DDL generation", () => {
    const dialects = ["mysql", "postgres", "sqlite"] as const;

    for (const dialect of dialects) {
      describe(`[${dialect}]`, () => {
        let generator: SchemaGenerator;

        beforeEach(() => {
          generator = new SchemaGenerator({ dialect });
        });

        it("should generate STORED computed column DDL", () => {
          @Entity()
          class UserStored {
            @PrimaryGeneratedColumn()
            id!: number;

            @Column({ type: "varchar", length: 50 })
            firstName!: string;

            @Column({ type: "varchar", length: 50 })
            lastName!: string;

            @ComputedColumn({
              expression: "first_name || ' ' || last_name",
              stored: true,
              type: "varchar",
              length: 100,
            })
            fullName!: string;
          }

          const ddl = generator.generateCreateTableDDL(UserStored);
          expect(ddl).toContain("GENERATED ALWAYS AS (first_name || ' ' || last_name) STORED");
          // SQLite maps VARCHAR→TEXT, others keep VARCHAR
          expect(ddl).toMatch(/(?:VARCHAR|TEXT)\(100\)/);
        });

        it("should generate VIRTUAL computed column DDL", () => {
          @Entity()
          class UserVirtual {
            @PrimaryGeneratedColumn()
            id!: number;

            @Column({ type: "int" })
            price!: number;

            @Column({ type: "int" })
            quantity!: number;

            @ComputedColumn({
              expression: "price * quantity",
              stored: false,
              type: "int",
            })
            total!: number;
          }

          const ddl = generator.generateCreateTableDDL(UserVirtual);
          expect(ddl).toContain("GENERATED ALWAYS AS (price * quantity) VIRTUAL");
        });

        it("should default to VIRTUAL when stored is omitted", () => {
          @Entity()
          class DefaultVirtual {
            @PrimaryGeneratedColumn()
            id!: number;

            @ComputedColumn({ expression: "1 + 1", type: "int" })
            computed!: number;
          }

          const ddl = generator.generateCreateTableDDL(DefaultVirtual);
          expect(ddl).toContain("VIRTUAL");
          expect(ddl).not.toContain("STORED");
        });
      });
    }
  });

  describe("EntityManager INSERT/UPDATE exclusion", () => {
    it("should have COMPUTED_COLUMN_TOKEN accessible from entity prototype", () => {
      class TestEntity {
        @ComputedColumn({ expression: "a + b", stored: true })
        sum!: number;
      }

      const meta = Reflect.getMetadata(COMPUTED_COLUMN_TOKEN, TestEntity.prototype);
      expect(meta).toBeDefined();
      expect(meta[0].name).toBe("sum");
    });
  });
});

/**
 * Builder-form `@ComputedColumn` (#336) — a dialect-portable expression
 * builder replaces hand-written, `process.env`-branched SQL strings. One
 * entity definition must render dialect-correct DDL on every driver.
 */
describe("@ComputedColumn expression builder (#336)", () => {
  // Mirrors examples/nestjs-linear-clone Issue.cycleTimeHours — the exact
  // shape the issue calls out: a CASE guarding a cross-dialect dateDiff.
  @Entity()
  class CycleIssue {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: "datetime", nullable: true })
    createdAt!: Date;

    @Column({ type: "datetime", nullable: true })
    completedAt!: Date | null;

    @Column({ type: "datetime", nullable: true })
    deletedAt!: Date | null;

    @ComputedColumn({
      expression: (e) =>
        e.iff(
          e.col("deleted_at").isNull().and(e.col("completed_at").isNotNull()),
          e.dateDiff(e.col("completed_at"), e.col("created_at"), "hour"),
          null,
        ),
      type: "int",
      nullable: true,
    })
    cycleTimeHours?: number;
  }

  it("renders MySQL TIMESTAMPDIFF from the builder form", () => {
    const ddl = new SchemaGenerator({ dialect: "mysql" }).generateCreateTableDDL(
      CycleIssue,
    );
    expect(ddl).toContain("GENERATED ALWAYS AS");
    expect(ddl).toContain("TIMESTAMPDIFF");
    expect(ddl).not.toContain("EXTRACT");
    // null result of the ELSE branch is inlined as a SQL literal, not a `?`.
    expect(ddl).toContain("ELSE NULL END");
    expect(ddl).not.toContain("?");
  });

  it("renders PostgreSQL EXTRACT from the SAME entity definition", () => {
    const ddl = new SchemaGenerator({
      dialect: "postgres",
    }).generateCreateTableDDL(CycleIssue);
    expect(ddl).toContain("GENERATED ALWAYS AS");
    expect(ddl).toContain("EXTRACT");
    expect(ddl).not.toContain("TIMESTAMPDIFF");
    expect(ddl).not.toContain("?");
  });

  it("wraps e.col() references in dialect-correct identifier quotes", () => {
    const mysql = new SchemaGenerator({ dialect: "mysql" }).generateCreateTableDDL(
      CycleIssue,
    );
    const postgres = new SchemaGenerator({
      dialect: "postgres",
    }).generateCreateTableDDL(CycleIssue);
    expect(mysql).toContain("`completed_at`");
    expect(postgres).toContain('"completed_at"');
  });

  it("keeps the literal-string form working unchanged (backward compatible)", () => {
    @Entity()
    class LiteralForm {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: "int" })
      price!: number;

      @ComputedColumn({ expression: "price * 2", type: "int" })
      doubled!: number;
    }

    const ddl = new SchemaGenerator({ dialect: "mysql" }).generateCreateTableDDL(
      LiteralForm,
    );
    expect(ddl).toContain("GENERATED ALWAYS AS (price * 2) VIRTUAL");
  });

  it("inlines string and numeric constants as SQL literals", () => {
    @Entity()
    class Labelled {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: "int" })
      score!: number;

      @ComputedColumn({
        expression: (e) =>
          e.iff(e.col("score").gte(50), "pass", "fail"),
        type: "varchar",
        length: 8,
      })
      grade!: string;
    }

    const ddl = new SchemaGenerator({ dialect: "postgres" }).generateCreateTableDDL(
      Labelled,
    );
    expect(ddl).toContain("THEN 'pass'");
    expect(ddl).toContain("ELSE 'fail'");
    expect(ddl).toContain("50");
  });

  it("accepts a builder that returns a boolean ConditionLike", () => {
    @Entity()
    class FlagRow {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: "int" })
      stock!: number;

      @ComputedColumn({
        expression: (e) => e.col("stock").gt(0),
        type: "boolean",
      })
      inStock!: boolean;
    }

    const ddl = new SchemaGenerator({ dialect: "postgres" }).generateCreateTableDDL(
      FlagRow,
    );
    expect(ddl).toContain('"stock" > 0');
  });

  it("warns when a literal string mixes MySQL and PostgreSQL functions", () => {
    const messages: string[] = [];
    Logger.setOutput((msg) => messages.push(msg));
    try {
      class Mixed {
        @ComputedColumn({
          expression:
            "CASE WHEN x THEN TIMESTAMPDIFF(HOUR, a, b) ELSE EXTRACT(EPOCH FROM c) END",
          type: "int",
        })
        bad!: number;
      }
      void Mixed;
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("builder form");
    } finally {
      Logger.reset();
    }
  });

  it("does not warn for a single-dialect literal string", () => {
    const messages: string[] = [];
    Logger.setOutput((msg) => messages.push(msg));
    try {
      class Fine {
        @ComputedColumn({ expression: "a + b", type: "int" })
        ok!: number;
      }
      void Fine;
      expect(messages).toHaveLength(0);
    } finally {
      Logger.reset();
    }
  });
});
