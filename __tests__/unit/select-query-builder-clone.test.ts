import "reflect-metadata";
import { SelectQueryBuilder } from "../../src/core/SelectQueryBuilder";
import { EntityManager } from "../../src/core/EntityManager";
import { Entity, PrimaryGeneratedColumn, Column } from "../../src/decorators";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { Conditions } from "../../src/core/Conditions";

@Entity()
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "int" })
  age!: number;
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

describe("SelectQueryBuilder.clone()", () => {
  it("should produce a new instance", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder(User, "u", em);
    const cloned = qb.clone();
    expect(cloned).not.toBe(qb);
    expect(cloned).toBeInstanceOf(SelectQueryBuilder);
  });

  it("should generate identical SQL for an unmodified clone", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder(User, "u", em);
    qb.where("name", "Alice");
    qb.addOrderBy("id", "ASC");
    qb.limit(10);

    const cloned = qb.clone();
    expect(cloned.getSql().text).toBe(qb.getSql().text);
  });

  it("should not affect original when clone is modified", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder(User, "u", em);
    qb.where("name", "Alice");

    const originalSql = qb.getSql().text;

    const cloned = qb.clone();
    cloned.where("age", ">", 30);
    cloned.limit(5);

    // Original should be unchanged
    expect(qb.getSql().text).toBe(originalSql);
    // Clone should have extra conditions
    expect(cloned.getSql().text).not.toBe(originalSql);
  });

  it("should not affect clone when original is modified", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder(User, "u", em);
    qb.where("name", "Bob");

    const cloned = qb.clone();
    const clonedSql = cloned.getSql().text;

    qb.where("age", "<", 25);

    // Clone should be unchanged
    expect(cloned.getSql().text).toBe(clonedSql);
  });

  it("should copy select columns independently", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder(User, "u", em);
    qb.select(["id", "name"]);

    const cloned = qb.clone();
    // Verify cloned has same select
    const clonedSql = cloned.getSql().text;
    expect(clonedSql).toContain("`id`");
    expect(clonedSql).toContain("`name`");
  });

  it("should copy distinct flag", () => {
    const em = createMockEm("postgresql");
    const qb = new SelectQueryBuilder(User, "u", em);
    (qb as any).distinct = true;
    const cloned = qb.clone();
    expect(cloned.getSql().text).toContain("SELECT DISTINCT");
  });

  it("should copy withDeleted flag", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder(User, "u", em);
    qb.withDeleted();
    const cloned = qb.clone();
    expect((cloned as any).withDeletedFlag).toBe(true);
  });

  it("should copy limit and offset", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder(User, "u", em);
    qb.limit(10);
    qb.offset(20);

    const cloned = qb.clone();
    expect((cloned as any).limitValue).toBe(10);
    expect((cloned as any).offsetValue).toBe(20);
  });

  it("should independently copy aliasRegistry", () => {
    const em = createMockEm();
    const qb = new SelectQueryBuilder(User, "u", em);
    const cloned = qb.clone();

    // Modifying clone's registry should not affect original
    (cloned as any).aliasRegistry.set("test", { entity: User, tableName: "test", propertyToColumnMap: new Map() });
    expect((qb as any).aliasRegistry.has("test")).toBe(false);
  });
});
