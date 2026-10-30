import "reflect-metadata";
import { SelectQueryBuilder } from "../../src/core/SelectQueryBuilder";
import { Entity, PrimaryGeneratedColumn, Column, DeletedAt } from "../../src/decorators";
import { createMockEm as sharedMockEm } from "./helpers/mock-em";

@Entity()
class Item {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  name!: string;
}

@Entity()
class SoftItem {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  name!: string;

  @DeletedAt()
  deletedAt!: Date | null;
}

function createMockEm(dbType: "mysql" | "postgresql" = "mysql") {
  let queryResult: any[] = [];
  return sharedMockEm(dbType, {
    async query() {
      return queryResult;
    },
    __setQueryResult(rows: any[]) {
      queryResult = rows;
    },
  });
}

describe("SelectQueryBuilder.exists()", () => {
  it("should generate SELECT 1 ... LIMIT 1 instead of COUNT(*)", async () => {
    // Previously this asserted `expect(qb.exists()).resolves...` without
    // awaiting, so neither the promise nor the assertion ever ran. Capture the
    // emitted SQL and pin the actual shape instead.
    const em = createMockEm("mysql");
    let capturedSql = "";
    let capturedValues: unknown[] = [];
    (em as any).query = async (built: any) => {
      capturedSql = built.sql || built.text || String(built);
      capturedValues = built.values ?? [];
      return [];
    };

    const qb = new SelectQueryBuilder(Item, "i", em);
    await expect(qb.exists()).resolves.toBe(false);

    expect(capturedSql).toContain("SELECT 1");
    expect(capturedSql).not.toContain("COUNT(");
    // The row cap is bound, not inlined.
    expect(capturedSql).toMatch(/LIMIT\s+[?$]/);
    expect(capturedValues).toContain(1);
  });

  it("should return true when rows exist", async () => {
    const em = createMockEm("mysql");
    em.__setQueryResult([{ "1": 1 }]);
    const qb = new SelectQueryBuilder(Item, "i", em);
    const result = await qb.exists();
    expect(result).toBe(true);
  });

  it("should return false when no rows exist", async () => {
    const em = createMockEm("mysql");
    em.__setQueryResult([]);
    const qb = new SelectQueryBuilder(Item, "i", em);
    const result = await qb.exists();
    expect(result).toBe(false);
  });

  it("should include soft-delete filter for entities with @DeletedAt", async () => {
    const em = createMockEm("postgresql");
    let capturedSql = "";
    (em as any).query = async (built: any) => {
      capturedSql = built.sql || built.text || String(built);
      return [];
    };
    const qb = new SelectQueryBuilder(SoftItem, "s", em);
    await qb.exists();
    expect(capturedSql).toContain("IS NULL");
  });

  it("should not include soft-delete filter when withDeleted() is called", async () => {
    const em = createMockEm("postgresql");
    let capturedSql = "";
    (em as any).query = async (built: any) => {
      capturedSql = built.sql || built.text || String(built);
      return [];
    };
    const qb = new SelectQueryBuilder(SoftItem, "s", em);
    qb.withDeleted();
    await qb.exists();
    expect(capturedSql).not.toContain("IS NULL");
  });

  it("should not mutate whereClauses", async () => {
    const em = createMockEm("mysql");
    const qb = new SelectQueryBuilder(SoftItem, "s", em);
    qb.where("name", "test");
    const beforeCount = (qb as any).whereClauses.length;
    await qb.exists();
    const afterCount = (qb as any).whereClauses.length;
    expect(afterCount).toBe(beforeCount);
  });

  it("should preserve WHERE conditions from the builder", async () => {
    const em = createMockEm("mysql");
    let capturedSql = "";
    (em as any).query = async (built: any) => {
      capturedSql = built.sql || built.text || String(built);
      return [];
    };
    const qb = new SelectQueryBuilder(Item, "i", em);
    qb.where("name", "test");
    await qb.exists();
    expect(capturedSql).toContain("LIMIT");
  });
});
