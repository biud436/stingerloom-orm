/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { Index, COMPOSITE_INDEX_TOKEN, CompositeIndexMetadata } from "../../src/decorators/Indexer";
import { SchemaGenerator } from "../../src/core/generators/SchemaGenerator";

describe("@Index(columns) — class-level composite index (#85)", () => {
  @Entity()
  @Index(["tenantId", "status"])
  @Index(["createdAt", "status"], "idx_custom_name")
  class Order {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: "int" })
    tenantId!: number;

    @Column({ type: "varchar", length: 50 })
    status!: string;

    @Column({ type: "datetime" })
    createdAt!: Date;
  }

  it("stores composite index metadata on the class", () => {
    const meta: CompositeIndexMetadata[] =
      Reflect.getMetadata(COMPOSITE_INDEX_TOKEN, Order) ?? [];
    expect(meta).toHaveLength(2);
    // Decorators apply bottom-up: @Index(["createdAt","status"],"idx_custom_name") first
    expect(meta[0].columns).toEqual(["createdAt", "status"]);
    expect(meta[0].name).toBe("idx_custom_name");
    expect(meta[1].columns).toEqual(["tenantId", "status"]);
    expect(meta[1].name).toBeUndefined();
  });

  it("generates composite index DDL for PostgreSQL", () => {
    const gen = new SchemaGenerator({ dialect: "postgres" });
    const ddls = gen.generateCompositeIndexDDL(Order);
    expect(ddls).toHaveLength(2);
    // ddls[0] = custom-named index, ddls[1] = auto-named index
    expect(ddls[0]).toContain("CREATE INDEX IF NOT EXISTS");
    expect(ddls[0]).toContain('"idx_custom_name"');
    expect(ddls[1]).toContain('"tenantId"');
    expect(ddls[1]).toContain('"status"');
  });

  it("generates composite index DDL for MySQL", () => {
    const gen = new SchemaGenerator({ dialect: "mysql" });
    const ddls = gen.generateCompositeIndexDDL(Order);
    expect(ddls).toHaveLength(2);
    // ddls[1] is the auto-named tenantId+status index
    expect(ddls[1]).not.toContain("IF NOT EXISTS");
    expect(ddls[1]).toContain("`tenantId`");
    expect(ddls[1]).toContain("`status`");
  });

  it("generates auto-named composite index", () => {
    const gen = new SchemaGenerator({ dialect: "postgres" });
    const ddls = gen.generateCompositeIndexDDL(Order);
    // Second DDL is auto-named: idx_order_tenantId_status
    const autoNamedDdl = ddls.find((d) => d.includes("tenantId"));
    expect(autoNamedDdl).toContain('"idx_order_tenantId_status"');
  });

  it("includes composite indexes in generateSchemaDDL", () => {
    const gen = new SchemaGenerator({ dialect: "postgres" });
    const ddls = gen.generateSchemaDDL([Order]);
    const compositeIndexDdls = ddls.filter((d) => d.includes("idx_"));
    expect(compositeIndexDdls.length).toBeGreaterThanOrEqual(2);
  });

  it("property-level @Index() still works", () => {
    @Entity()
    class Item {
      @PrimaryGeneratedColumn()
      id!: number;

      @Index()
      @Column({ type: "varchar", length: 100 })
      name!: string;
    }

    const gen = new SchemaGenerator({ dialect: "postgres" });
    const ddls = gen.generateCreateIndexDDL(Item);
    expect(ddls).toHaveLength(1);
    expect(ddls[0]).toContain('"name"');
  });

  it("generates composite index DDL for SQLite", () => {
    const gen = new SchemaGenerator({ dialect: "sqlite" });
    const ddls = gen.generateCompositeIndexDDL(Order);
    expect(ddls).toHaveLength(2);
    expect(ddls[0]).toContain("CREATE INDEX IF NOT EXISTS");
  });
});
