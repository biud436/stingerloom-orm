import "reflect-metadata";
import { SelectQueryBuilder } from "../../src/core/SelectQueryBuilder";
import { EntityManager } from "../../src/core/EntityManager";
import { Entity, PrimaryGeneratedColumn, Column, DeletedAt } from "../../src/decorators";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";

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
  return {
    wrap,
    wrapTable: (t: string) => wrap(t),
    resolver,
    _ctx: {
      isMySqlFamily: () => dbType === "mysql",
      isPostgres: () => dbType === "postgresql",
      isSqlite: () => false,
    },
    async query<T>(): Promise<T[]> {
      return [] as T[];
    },
  } as unknown as EntityManager;
}

describe("SelectQueryBuilder.toSql() immutability", () => {
  it("should not grow whereClauses after multiple toSql() calls on soft-delete entity", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder(SoftItem, "s", em);
    qb.where("name", "test");

    const initialLength = (qb as any).whereClauses.length;

    // Call toSql() multiple times
    qb.toSql();
    qb.toSql();
    qb.toSql();

    expect((qb as any).whereClauses.length).toBe(initialLength);
  });

  it("should produce identical SQL on repeated toSql() calls", () => {
    const em = createMockEm("postgresql");
    const qb = new SelectQueryBuilder(SoftItem, "s", em);
    qb.where("name", "Alice");

    const sql1 = qb.getSql().text;
    const sql2 = qb.getSql().text;
    const sql3 = qb.getSql().text;

    expect(sql1).toBe(sql2);
    expect(sql2).toBe(sql3);
  });

  it("should include soft-delete filter in SQL despite not mutating whereClauses", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder(SoftItem, "s", em);
    const { text } = qb.getSql();

    expect(text).toContain("IS NULL");
  });

  it("should be safe for getManyAndCount parallel execution", async () => {
    const em = createMockEm();
    (em as any).query = async () => [];
    const qb = new SelectQueryBuilder(SoftItem, "s", em);
    qb.where("name", "test");

    const initialLength = (qb as any).whereClauses.length;

    // Simulate getManyAndCount pattern: parallel toSql() + getCount()
    await Promise.all([
      (async () => { qb.toSql(); })(),
      (async () => { await qb.getCount(); })(),
    ]);

    // whereClauses should not have grown
    expect((qb as any).whereClauses.length).toBe(initialLength);
  });

  it("getCount() should not mutate whereClauses either", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder(SoftItem, "s", em);
    qb.where("name", "test");

    const initialLength = (qb as any).whereClauses.length;

    // getCount already uses local copy — verify it stays that way
    qb.getCount();

    expect((qb as any).whereClauses.length).toBe(initialLength);
  });
});
