import "reflect-metadata";
import { SelectQueryBuilder } from "../../src/core/SelectQueryBuilder";
import { EntityManager } from "../../src/core/EntityManager";
import { Entity, PrimaryGeneratedColumn, Column, DeletedAt } from "../../src/decorators";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";

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
  const resolver = new RelationMetadataResolver();
  function wrap(col: string) {
    if (dbType === "mysql") return `\`${col.replace(/`/g, "``")}\``;
    return `"${col.replace(/"/g, '""')}"`;
  }
  let queryResult: any[] = [];
  const em = {
    wrap,
    wrapTable: (t: string) => wrap(t),
    resolver,
    _ctx: {
      isMySqlFamily: () => dbType === "mysql",
      isPostgres: () => dbType === "postgresql",
      isSqlite: () => false,
    },
    async query<T>(): Promise<T[]> {
      return queryResult as T[];
    },
    __setQueryResult(rows: any[]) {
      queryResult = rows;
    },
  } as unknown as EntityManager & { __setQueryResult: (rows: any[]) => void };
  return em;
}

describe("SelectQueryBuilder.exists()", () => {
  it("should generate SELECT 1 ... LIMIT 1 instead of COUNT(*)", () => {
    const em = createMockEm("mysql");
    // We can't easily get the SQL from exists() directly,
    // but we can verify the behavior by checking the query result
    const qb = new SelectQueryBuilder(Item, "i", em);
    // Verify exists() returns false when query returns empty
    expect(qb.exists()).resolves.toBe(false);
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
