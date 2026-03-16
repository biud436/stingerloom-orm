/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../src/decorators/ManyToOne";
import { OneToOne } from "../../src/decorators/OneToOne";
import { SchemaGenerator } from "../../src/core/generators/SchemaGenerator";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";

describe("Referential Actions — onDelete/onUpdate (#84)", () => {
  beforeEach(() => {
    MetadataLayerRegistry.reset();
  });

  @Entity()
  class Department {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: "varchar", length: 100 })
    name!: string;
  }

  @Entity()
  class Employee {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: "varchar", length: 100 })
    name!: string;

    @ManyToOne(() => Department, (e) => (e as any).department, {
      joinColumn: "department_id",
      onDelete: "CASCADE",
      onUpdate: "SET NULL",
    })
    department!: Department;
  }

  @Entity()
  class Profile {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: "text" })
    bio!: string;
  }

  @Entity()
  class UserWithProfile {
    @PrimaryGeneratedColumn()
    id!: number;

    @OneToOne(() => Profile, {
      joinColumn: "profile_id",
      onDelete: "SET NULL",
      onUpdate: "CASCADE",
    })
    profile!: Profile;
  }

  it("generates FK DDL with ON DELETE CASCADE ON UPDATE SET NULL (ManyToOne)", () => {
    const gen = new SchemaGenerator({ dialect: "postgres" });
    const ddls = gen.generateForeignKeyDDL(Employee);
    expect(ddls).toHaveLength(1);
    expect(ddls[0]).toContain("ON DELETE CASCADE");
    expect(ddls[0]).toContain("ON UPDATE SET NULL");
  });

  it("generates FK DDL with ON DELETE SET NULL ON UPDATE CASCADE (OneToOne)", () => {
    const gen = new SchemaGenerator({ dialect: "postgres" });
    const ddls = gen.generateForeignKeyDDL(UserWithProfile);
    expect(ddls).toHaveLength(1);
    expect(ddls[0]).toContain("ON DELETE SET NULL");
    expect(ddls[0]).toContain("ON UPDATE CASCADE");
  });

  it("defaults to NO ACTION when onDelete/onUpdate not specified", () => {
    @Entity()
    class DefaultFK {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToOne(() => Department, (e) => (e as any).department, {
        joinColumn: "dept_id",
      })
      dept!: Department;
    }

    const gen = new SchemaGenerator({ dialect: "mysql" });
    const ddls = gen.generateForeignKeyDDL(DefaultFK);
    expect(ddls).toHaveLength(1);
    expect(ddls[0]).toContain("ON DELETE NO ACTION");
    expect(ddls[0]).toContain("ON UPDATE NO ACTION");
  });

  it("works with MySQL dialect", () => {
    const gen = new SchemaGenerator({ dialect: "mysql" });
    const ddls = gen.generateForeignKeyDDL(Employee);
    expect(ddls).toHaveLength(1);
    expect(ddls[0]).toContain("ON DELETE CASCADE");
    expect(ddls[0]).toContain("ON UPDATE SET NULL");
    expect(ddls[0]).toContain("ALTER TABLE");
  });
});

describe("createForeignKeyConstraints: false (#83)", () => {
  beforeEach(() => {
    MetadataLayerRegistry.reset();
  });

  @Entity()
  class Category {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: "varchar", length: 100 })
    name!: string;
  }

  @Entity()
  class ProductNoFK {
    @PrimaryGeneratedColumn()
    id!: number;

    @ManyToOne(() => Category, (e) => (e as any).category, {
      joinColumn: "category_id",
      createForeignKeyConstraints: false,
    })
    category!: Category;
  }

  @Entity()
  class ProductWithFK {
    @PrimaryGeneratedColumn()
    id!: number;

    @ManyToOne(() => Category, (e) => (e as any).category, {
      joinColumn: "category_id",
    })
    category!: Category;
  }

  it("skips FK DDL when createForeignKeyConstraints is false (ManyToOne)", () => {
    const gen = new SchemaGenerator({ dialect: "postgres" });
    const ddls = gen.generateForeignKeyDDL(ProductNoFK);
    expect(ddls).toHaveLength(0);
  });

  it("generates FK DDL when createForeignKeyConstraints is not set", () => {
    const gen = new SchemaGenerator({ dialect: "postgres" });
    const ddls = gen.generateForeignKeyDDL(ProductWithFK);
    expect(ddls).toHaveLength(1);
  });

  it("skips FK DDL for OneToOne when createForeignKeyConstraints is false", () => {
    @Entity()
    class Passport {
      @PrimaryGeneratedColumn()
      id!: number;
    }

    @Entity()
    class PersonNoFK {
      @PrimaryGeneratedColumn()
      id!: number;

      @OneToOne(() => Passport, {
        joinColumn: "passport_id",
        createForeignKeyConstraints: false,
      })
      passport!: Passport;
    }

    const gen = new SchemaGenerator({ dialect: "mysql" });
    const ddls = gen.generateForeignKeyDDL(PersonNoFK);
    expect(ddls).toHaveLength(0);
  });

  it("still creates the column even when FK is skipped", () => {
    const gen = new SchemaGenerator({ dialect: "postgres" });
    const createDDL = gen.generateCreateTableDDL(ProductNoFK);
    // The table should still be created (no FK constraint check needed here)
    expect(createDDL).toContain("CREATE TABLE");
    // But FK DDL should be empty
    const fkDDLs = gen.generateForeignKeyDDL(ProductNoFK);
    expect(fkDDLs).toHaveLength(0);
  });
});
