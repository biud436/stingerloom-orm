/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { SchemaGenerator } from "../../src/core/generators/SchemaGenerator";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";

describe("SchemaGenerator renderDefaultClause (#122)", () => {
  const dialects = ["mysql", "postgres", "sqlite"] as const;

  for (const dialect of dialects) {
    describe(`[${dialect}]`, () => {
      let generator: SchemaGenerator;

      beforeEach(() => {
        generator = new SchemaGenerator({ dialect });
      });

      it("should preserve parentheses for function calls like (UUID())", () => {
        @Entity()
        class TestUuid {
          @PrimaryGeneratedColumn()
          id!: number;

          @Column({ type: "varchar", length: 36, default: "(UUID())" })
          uuid!: string;
        }

        const ddl = generator.generateCreateTableDDL(TestUuid);
        expect(ddl).toContain("DEFAULT (UUID())");
        expect(ddl).not.toMatch(/DEFAULT UUID[^(]/);
      });

      it("should preserve parentheses for (NOW())", () => {
        @Entity()
        class TestNow {
          @PrimaryGeneratedColumn()
          id!: number;

          @Column({ type: "timestamp", default: "(NOW())" })
          createdAt!: Date;
        }

        const ddl = generator.generateCreateTableDDL(TestNow);
        expect(ddl).toContain("DEFAULT (NOW())");
      });

      it("should preserve parentheses for (CURRENT_TIMESTAMP)", () => {
        @Entity()
        class TestTs {
          @PrimaryGeneratedColumn()
          id!: number;

          @Column({ type: "timestamp", default: "(CURRENT_TIMESTAMP)" })
          createdAt!: Date;
        }

        const ddl = generator.generateCreateTableDDL(TestTs);
        expect(ddl).toContain("DEFAULT (CURRENT_TIMESTAMP)");
      });

      it("should preserve parentheses for (gen_random_uuid())", () => {
        @Entity()
        class TestGenUuid {
          @PrimaryGeneratedColumn()
          id!: number;

          @Column({ type: "varchar", length: 36, default: "(gen_random_uuid())" })
          uuid!: string;
        }

        const ddl = generator.generateCreateTableDDL(TestGenUuid);
        expect(ddl).toContain("DEFAULT (gen_random_uuid())");
      });

      it("should quote plain string defaults", () => {
        @Entity()
        class TestStr {
          @PrimaryGeneratedColumn()
          id!: number;

          @Column({ type: "varchar", length: 50, default: "hello" })
          greeting!: string;
        }

        const ddl = generator.generateCreateTableDDL(TestStr);
        expect(ddl).toContain("DEFAULT 'hello'");
      });

      it("should handle numeric defaults", () => {
        @Entity()
        class TestNum {
          @PrimaryGeneratedColumn()
          id!: number;

          @Column({ type: "int", default: 42 })
          count!: number;
        }

        const ddl = generator.generateCreateTableDDL(TestNum);
        expect(ddl).toContain("DEFAULT 42");
      });
    });
  }
});
