import "reflect-metadata";
import { SelectQueryBuilder, qAlias } from "../../src/core/SelectQueryBuilder";
import { Entity, PrimaryGeneratedColumn, Column } from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { createDialectExpression } from "../../src/dialects/DialectExpression";
import {
  exists,
  notExists,
  isSubqueryLike,
  isExistsCondition,
  ExistsCondition,
} from "../../src/core/expressions/SubqueryExpression";
import { Expressions } from "../../src/core/expressions/LogicalCondition";

@Entity()
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 50 })
  status!: string;

  @Column({ type: "int" })
  departmentId!: number;
}

@Entity()
class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "int" })
  authorId!: number;

  @Column({ type: "varchar", length: 50 })
  status!: string;

  @Column({ type: "int" })
  views!: number;
}

type DbType = "mysql" | "postgresql" | "sqlite";

function createMockEm(dbType: DbType = "postgresql") {
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
      isSqlite: () => dbType === "sqlite",
      getDialect: () =>
        dbType === "mysql" ? "mysql" : dbType === "sqlite" ? "sqlite" : "postgresql",
    },
  } as unknown as EntityManager;
}

function setupQb<E extends object>(
  entity: new () => E,
  alias: string,
  dbType: DbType = "postgresql",
): SelectQueryBuilder<E> {
  const em = createMockEm(dbType);
  const qb = new SelectQueryBuilder<E>(entity as any, alias, em);
  const resolver = (em as any).resolver as RelationMetadataResolver;
  const meta = resolver.resolveEntityMetadata(entity as any);
  if (meta) {
    const map = new Map<string, string>();
    for (const c of meta.columns) {
      map.set((c as any).propertyKey ?? c.name!, c.name!);
    }
    qb.setPropertyToColumnMap(map);
  }
  const dialectName = dbType === "postgresql" ? "postgres" : dbType;
  qb.setDialectExpression(createDialectExpression(dialectName));
  return qb;
}

describe("Subquery expressions (QueryDSL Tier 2)", () => {
  describe("isSubqueryLike guard", () => {
    it("returns true for a SelectQueryBuilder", () => {
      const sub = setupQb(Post, "p").select(["id"]);
      expect(isSubqueryLike(sub)).toBe(true);
    });

    it("returns false for plain objects", () => {
      expect(isSubqueryLike({})).toBe(false);
      expect(isSubqueryLike(42)).toBe(false);
      expect(isSubqueryLike(null)).toBe(false);
      expect(isSubqueryLike({ toSql: () => null })).toBe(false); // missing getSql
    });
  });

  describe("ColumnExpression.in / notIn with subquery", () => {
    it("col.in(subquery) renders col IN (SELECT ...)", () => {
      const p = qAlias(Post, "p");
      const u = qAlias(User, "u");
      const outer = setupQb(User, "u");
      const activeAuthors = setupQb(Post, "p")
        .select(["authorId"])
        .where(p.status.eq("published"));

      outer.where(u.id.in(activeAuthors));
      const { text } = outer.getSql();
      expect(text).toContain(`"u"."id" IN (`);
      expect(text).toContain(`SELECT "p"."authorId"`);
      expect(text).toContain(`WHERE "p"."status" = ?`);
    });

    it("col.notIn(subquery) renders col NOT IN (SELECT ...)", () => {
      const u = qAlias(User, "u");
      const outer = setupQb(User, "u");
      const inactive = setupQb(Post, "p")
        .select(["authorId"])
        .where(qAlias(Post, "p").status.eq("archived"));

      outer.where(u.id.notIn(inactive));
      const { text } = outer.getSql();
      expect(text).toContain(`"u"."id" NOT IN (`);
    });

    it("col.in() still works with value list (backward compatible)", () => {
      const u = qAlias(User, "u");
      const qb = setupQb(User, "u");
      qb.where(u.status.in(["active", "pending"]));
      const { text, values } = qb.getSql();
      expect(text).toContain(`"u"."status" IN (?, ?)`);
      expect(values).toEqual(expect.arrayContaining(["active", "pending"]));
    });
  });

  describe("ColumnExpression scalar comparison with subquery", () => {
    it("col.eq(subquery) renders col = (SELECT ...)", () => {
      const u = qAlias(User, "u");
      const outer = setupQb(User, "u");
      const maxId = setupQb(User, "u2").selectRaw(["MAX(u2.id)"]);

      outer.where(u.id.eq(maxId));
      const { text } = outer.getSql();
      expect(text).toMatch(/"u"\."id" = \(SELECT/);
    });

    it("col.gt(subquery) renders col > (SELECT ...)", () => {
      const p = qAlias(Post, "p");
      const outer = setupQb(Post, "p");
      const avgViews = setupQb(Post, "p2").selectRaw(["AVG(p2.views)"]);

      outer.where(p.views.gt(avgViews));
      const { text } = outer.getSql();
      expect(text).toMatch(/"p"\."views" > \(SELECT/);
    });
  });

  describe("Expressions.exists / notExists", () => {
    it("exists() returns an ExistsCondition", () => {
      const sub = setupQb(Post, "p").select(["id"]);
      const cond = exists(sub);
      expect(isExistsCondition(cond)).toBe(true);
      expect(cond).toBeInstanceOf(ExistsCondition);
      expect(cond.negated).toBe(false);
    });

    it("notExists() returns a negated ExistsCondition", () => {
      const sub = setupQb(Post, "p").select(["id"]);
      const cond = notExists(sub);
      expect(cond.negated).toBe(true);
    });

    it("EXISTS subquery renders in WHERE", () => {
      const outer = setupQb(User, "u");
      const subAuthors = setupQb(Post, "p").select(["id"]);
      outer.where(Expressions.exists(subAuthors));
      const { text } = outer.getSql();
      expect(text).toMatch(/WHERE EXISTS \(/);
    });

    it("NOT EXISTS subquery renders in WHERE", () => {
      const outer = setupQb(User, "u");
      const subAuthors = setupQb(Post, "p").select(["id"]);
      outer.where(Expressions.notExists(subAuthors));
      const { text } = outer.getSql();
      expect(text).toMatch(/WHERE NOT EXISTS \(/);
    });

    it(".not() on ExistsCondition toggles negation (no double wrap)", () => {
      const sub = setupQb(Post, "p").select(["id"]);
      const c1 = exists(sub);
      const c2 = c1.not();
      expect(c2).toBeInstanceOf(ExistsCondition);
      expect((c2 as ExistsCondition).negated).toBe(true);
      // Second negation flips back.
      const c3 = (c2 as ExistsCondition).not();
      expect((c3 as ExistsCondition).negated).toBe(false);
    });

    it("exists condition composes with Expressions.and", () => {
      const u = qAlias(User, "u");
      const outer = setupQb(User, "u");
      const sub = setupQb(Post, "p").select(["id"]);
      outer.where(
        Expressions.and(u.status.eq("active"), Expressions.exists(sub)),
      );
      const { text } = outer.getSql();
      expect(text).toContain(`"u"."status" =`);
      expect(text).toContain("EXISTS (");
      expect(text).toContain(" AND ");
    });

    it("exists() throws on non-subquery argument", () => {
      expect(() => exists({} as any)).toThrow(
        /SelectQueryBuilder-like/,
      );
    });

    it("preserves subquery parameter bindings", () => {
      const outer = setupQb(User, "u");
      const p = qAlias(Post, "p");
      const sub = setupQb(Post, "p")
        .select(["id"])
        .where(p.status.eq("published"))
        .where(p.views.gte(100));

      outer.where(Expressions.exists(sub));
      const { values } = outer.getSql();
      expect(values).toContain("published");
      expect(values).toContain(100);
    });
  });
});
