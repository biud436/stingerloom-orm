/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { SchemaGenerator } from "../../src/core/generators/SchemaGenerator";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { ComputedColumn, COMPUTED_COLUMN_TOKEN } from "../../src/decorators/ComputedColumn";

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
