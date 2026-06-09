import "reflect-metadata";
import { SelectQueryBuilder } from "../../src/core/SelectQueryBuilder";
import { Entity, PrimaryGeneratedColumn, Column, DeletedAt } from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";

@Entity()
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  name!: string;

  @Column({ type: "int" })
  age!: number;

  @Column({ type: "varchar", length: 50 })
  role!: string;

  @Column({ type: "varchar", length: 50 })
  status!: string;

  @DeletedAt()
  deletedAt!: Date | null;
}

function createMockEm(dbType: "mysql" | "postgresql" = "mysql") {
  const resolver = new RelationMetadataResolver();
  function wrap(col: string) {
    return dbType === "mysql"
      ? `\`${col.replace(/`/g, "``")}\``
      : `"${col.replace(/"/g, '""')}"`;
  }
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
      return [] as T[];
    },
    createQueryBuilder(entity: any, alias: string) {
      const qb = new SelectQueryBuilder(entity, alias, em as any);
      const meta = resolver.resolveEntityMetadata(entity);
      if (meta) {
        const map = new Map<string, string>();
        for (const col of meta.columns) {
          map.set((col as any).propertyKey ?? col.name!, col.name!);
        }
        qb.setPropertyToColumnMap(map);
      }
      return qb;
    },
  } as unknown as EntityManager;
  return em;
}

describe("SelectQueryBuilder.where() — WhereClause filter object", () => {
  it("treats a plain object as implicit equality, qualified by the alias", () => {
    const em = createMockEm("mysql");
    const { text, values } = em
      .createQueryBuilder(User, "u")
      .where({ status: "active" })
      .getSql();

    expect(text).toContain("`u`.`status` = ?");
    expect(values).toContain("active");
  });

  it("AND-s multiple keys in a single object", () => {
    const em = createMockEm("mysql");
    const { text, values } = em
      .createQueryBuilder(User, "u")
      .where({ status: "active", role: "admin" })
      .getSql();

    expect(text).toContain("`u`.`status` = ?");
    expect(text).toContain("`u`.`role` = ?");
    expect(text).toContain("AND");
    expect(values).toEqual(expect.arrayContaining(["active", "admin"]));
  });

  it("expands comparison operators ({ gte, lt })", () => {
    const em = createMockEm("mysql");
    const { text, values } = em
      .createQueryBuilder(User, "u")
      .where({ age: { gte: 18, lt: 65 } })
      .getSql();

    expect(text).toContain("`u`.`age` >= ?");
    expect(text).toContain("`u`.`age` < ?");
    expect(values).toEqual(expect.arrayContaining([18, 65]));
  });

  it("expands { in: [...] } to an IN list", () => {
    const em = createMockEm("mysql");
    const { text, values } = em
      .createQueryBuilder(User, "u")
      .where({ role: { in: ["admin", "editor"] } })
      .getSql();

    expect(text).toContain("`u`.`role` IN");
    expect(values).toEqual(expect.arrayContaining(["admin", "editor"]));
  });

  it("escapes wildcards for { contains } and wraps with %", () => {
    const em = createMockEm("mysql");
    const { text, values } = em
      .createQueryBuilder(User, "u")
      .where({ name: { contains: "50%" } })
      .getSql();

    expect(text).toContain("`u`.`name` LIKE ?");
    // % inside the term is escaped; surrounding % are the wildcards.
    expect(values).toContain("%50\\%%");
  });

  it("maps a bare array value to IN", () => {
    const em = createMockEm("mysql");
    const { text, values } = em
      .createQueryBuilder(User, "u")
      .where({ id: [1, 2, 3] })
      .getSql();

    expect(text).toContain("`u`.`id` IN");
    expect(values).toEqual(expect.arrayContaining([1, 2, 3]));
  });

  it("maps null to IS NULL", () => {
    const em = createMockEm("mysql");
    const { text } = em
      .createQueryBuilder(User, "u")
      .where({ deletedAt: null })
      .getSql();

    expect(text).toContain("`u`.`deletedAt` IS NULL");
  });

  it("supports the OR combinator", () => {
    const em = createMockEm("mysql");
    const { text, values } = em
      .createQueryBuilder(User, "u")
      .where({ OR: [{ role: "admin" }, { age: { gte: 90 } }] })
      .getSql();

    expect(text).toContain("OR");
    expect(text).toContain("`u`.`role` = ?");
    expect(text).toContain("`u`.`age` >= ?");
    expect(values).toEqual(expect.arrayContaining(["admin", 90]));
  });

  it("supports the NOT combinator", () => {
    const em = createMockEm("mysql");
    const { text } = em
      .createQueryBuilder(User, "u")
      .where({ NOT: { status: "deleted" } })
      .getSql();

    expect(text).toContain("NOT");
    expect(text).toContain("`u`.`status` = ?");
  });

  it("OR-s the groups when given an array of clauses", () => {
    const em = createMockEm("postgresql");
    const { text, values } = em
      .createQueryBuilder(User, "u")
      .where([
        { status: "active", role: "admin" },
        { age: { gte: 30 } },
      ])
      .getSql();

    // ((status = ? AND role = ?) OR age >= ?)
    expect(text).toContain("OR");
    expect(text).toContain('("u"."status" = ? AND "u"."role" = ?)');
    expect(text).toContain('"u"."age" >= ?');
    expect(values).toEqual(expect.arrayContaining(["active", "admin", 30]));
  });

  it("ignores an empty clause object (adds no condition)", () => {
    const em = createMockEm("mysql");
    // Soft-delete (@DeletedAt) always appends its own predicate, so compare
    // against the no-where baseline rather than asserting WHERE is absent.
    const baseline = em.createQueryBuilder(User, "u").getSql();
    const withEmpty = em.createQueryBuilder(User, "u").where({}).getSql();
    expect(withEmpty.text).toBe(baseline.text);
    expect(withEmpty.values).toEqual(baseline.values);
  });

  it("composes a filter object with chained condition calls", () => {
    const em = createMockEm("mysql");
    const { text, values } = em
      .createQueryBuilder(User, "u")
      .where({ status: "active" })
      .andWhere("age", ">", 21)
      .getSql();

    expect(text).toContain("`u`.`status` = ?");
    expect(text).toContain("`u`.`age` > ?");
    expect(values).toEqual(expect.arrayContaining(["active", 21]));
  });

  it("still accepts a raw Sql condition (no regression)", () => {
    const em = createMockEm("mysql");
    const { Conditions } = require("../../src/core/Conditions");
    const { text } = em
      .createQueryBuilder(User, "u")
      .where(Conditions.equals("`u`.`role`", "admin"))
      .getSql();
    expect(text).toContain("`u`.`role` = ?");
  });
});
