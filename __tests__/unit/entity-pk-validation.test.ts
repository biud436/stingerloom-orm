import "reflect-metadata";
import { SchemaGenerator } from "../../src/core/generators/SchemaGenerator";
import { PrimaryKeyNotFoundError } from "../../src/errors/PrimaryKeyNotFoundError";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { PrimaryColumn } from "../../src/decorators/PrimaryColumn";

describe("Entity PK validation", () => {
  it("should throw PrimaryKeyNotFoundError for entity without PK", () => {
    @Entity({ name: "no_pk_table" })
    class NoPkEntity {
      @Column({ type: "varchar", length: 255 })
      name!: string;
    }

    const generator = new SchemaGenerator({ dialect: "mysql" });
    expect(() => generator.generateCreateTableDDL(NoPkEntity)).toThrow(
      PrimaryKeyNotFoundError,
    );
  });

  it("should not throw for entity with @PrimaryGeneratedColumn", () => {
    @Entity({ name: "with_auto_pk" })
    class WithAutoPk {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: "varchar", length: 255 })
      name!: string;
    }

    const generator = new SchemaGenerator({ dialect: "mysql" });
    expect(() => generator.generateCreateTableDDL(WithAutoPk)).not.toThrow();
  });

  it("should not throw for entity with @PrimaryColumn", () => {
    @Entity({ name: "with_pk_col" })
    class WithPkCol {
      @PrimaryColumn({ type: "varchar", length: 36 })
      uuid!: string;

      @Column({ type: "varchar", length: 255 })
      name!: string;
    }

    const generator = new SchemaGenerator({ dialect: "postgres" });
    expect(() => generator.generateCreateTableDDL(WithPkCol)).not.toThrow();
  });

  it("should not throw for entity with composite PK", () => {
    @Entity({ name: "composite_pk" })
    class CompositePk {
      @PrimaryColumn({ type: "int" })
      tenantId!: number;

      @PrimaryColumn({ type: "int" })
      userId!: number;
    }

    const generator = new SchemaGenerator({ dialect: "postgres" });
    expect(() => generator.generateCreateTableDDL(CompositePk)).not.toThrow();
  });

  it("should include actionable message in the error", () => {
    @Entity({ name: "bad_entity" })
    class BadEntity {
      @Column({ type: "text" })
      content!: string;
    }

    const generator = new SchemaGenerator({ dialect: "sqlite" });
    try {
      generator.generateCreateTableDDL(BadEntity);
      fail("Should have thrown");
    } catch (err: any) {
      expect(err.message).toContain("bad_entity");
      expect(err.suggestion).toContain("@PrimaryGeneratedColumn");
    }
  });
});
