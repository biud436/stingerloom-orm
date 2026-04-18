import "reflect-metadata";
import { SelectQueryBuilder, qAlias } from "../../src/core/SelectQueryBuilder";
import { Entity, PrimaryGeneratedColumn, Column } from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { createDialectExpression } from "../../src/dialects/DialectExpression";
import {
  coalesce,
  nullif,
} from "../../src/core/expressions/NullishExpression";
import {
  ScalarExpression,
  isScalarExpression,
  isScalarCondition,
} from "../../src/core/expressions/ScalarExpression";
import { Expressions } from "../../src/core/expressions/LogicalCondition";

@Entity()
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255, nullable: true })
  nickname!: string;

  @Column({ type: "varchar", length: 255 })
  name!: string;

  @Column({ type: "varchar", length: 255, nullable: true })
  email!: string;

  @Column({ type: "int", nullable: true })
  score!: number;

  @Column({ type: "json" })
  metadata!: { profile?: { tier?: string } };
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

function createQb(dbType: DbType = "postgresql") {
  const em = createMockEm(dbType);
  const qb = new SelectQueryBuilder<User>(User, "u", em);
  const resolver = (em as any).resolver as RelationMetadataResolver;
  const meta = resolver.resolveEntityMetadata(User);
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

describe("NullishExpression — coalesce / nullif (QueryDSL Tier 2)", () => {
  describe("coalesce()", () => {
    it("throws on fewer than 2 arguments", () => {
      expect(() => coalesce(42)).toThrow(/at least 2/);
    });

    it("returns a ScalarExpression instance", () => {
      const u = qAlias(User, "u");
      const result = coalesce(u.nickname, u.name);
      expect(isScalarExpression(result)).toBe(true);
      expect(result).toBeInstanceOf(ScalarExpression);
    });

    it("renders COALESCE with multiple column refs", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      qb.select([coalesce(u.nickname, u.name).as("display")]);
      const { text } = qb.getSql();
      expect(text).toContain(
        `COALESCE("u"."nickname", "u"."name") AS "display"`,
      );
    });

    it("binds plain values as parameters", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      qb.select([coalesce(u.nickname, "anon").as("display")]);
      const { text, values } = qb.getSql();
      expect(text).toContain(`COALESCE("u"."nickname", ?)`);
      expect(values).toContain("anon");
    });

    it("nests inside another coalesce", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      const inner = coalesce(u.nickname, u.name);
      qb.select([coalesce(inner, "fallback").as("display")]);
      const { text, values } = qb.getSql();
      expect(text).toContain(
        `COALESCE(COALESCE("u"."nickname", "u"."name"), ?)`,
      );
      expect(values).toContain("fallback");
    });

    it("supports JSON path extract as an argument (PostgreSQL)", () => {
      const u = qAlias(User, "u");
      const qb = createQb("postgresql");
      qb.select([
        coalesce(u.metadata.profile.tier, "free").as("tier"),
      ]);
      const { text } = qb.getSql();
      expect(text).toContain("#>>");
      expect(text).toContain("COALESCE(");
      expect(text).toContain(`AS "tier"`);
    });

    it("accepts an aggregate as an argument", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      qb.select([coalesce(u.score.sum(), 0).as("total")]);
      const { text, values } = qb.getSql();
      expect(text).toContain(`COALESCE(SUM("u"."score"), ?)`);
      expect(values).toContain(0);
    });
  });

  describe("nullif()", () => {
    it("returns a ScalarExpression", () => {
      const u = qAlias(User, "u");
      expect(isScalarExpression(nullif(u.email, ""))).toBe(true);
    });

    it("renders NULLIF(col, value)", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      qb.select([nullif(u.email, "").as("email_or_null")]);
      const { text, values } = qb.getSql();
      expect(text).toContain(`NULLIF("u"."email", ?) AS "email_or_null"`);
      expect(values).toContain("");
    });

    it("renders NULLIF(col, col)", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      qb.select([nullif(u.nickname, u.name).as("override")]);
      const { text } = qb.getSql();
      expect(text).toContain(
        `NULLIF("u"."nickname", "u"."name") AS "override"`,
      );
    });
  });

  describe("ColumnExpression.coalesce()", () => {
    it("is shorthand for the free-standing coalesce()", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      qb.select([u.nickname.coalesce(u.name, "anon").as("display")]);
      const { text } = qb.getSql();
      expect(text).toContain(
        `COALESCE("u"."nickname", "u"."name", ?) AS "display"`,
      );
    });

    it("throws without any fallback", () => {
      const u = qAlias(User, "u");
      expect(() => (u.nickname as any).coalesce()).toThrow(
        /at least one fallback/,
      );
    });
  });

  describe("ScalarCondition — WHERE / HAVING usage", () => {
    it("eq() produces a WHERE condition from a coalesce expression", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      qb.where(coalesce(u.nickname, u.name).eq("admin"));
      const { text, values } = qb.getSql();
      expect(text).toContain(`COALESCE("u"."nickname", "u"."name") = ?`);
      expect(values).toContain("admin");
    });

    it("gt() works on a numeric coalesce", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      qb.where(coalesce(u.score, 0).gt(100));
      const { text } = qb.getSql();
      expect(text).toContain(`COALESCE("u"."score", ?) > ?`);
    });

    it("between() produces BETWEEN clause", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      qb.where(coalesce(u.score, 0).between(10, 20));
      const { text } = qb.getSql();
      expect(text).toMatch(/COALESCE\([^)]+\) BETWEEN \? AND \?/);
    });

    it("isNull() works", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      qb.where(nullif(u.email, "").isNull());
      const { text } = qb.getSql();
      expect(text).toMatch(/NULLIF\([^)]+\) IS NULL/);
    });

    it("composes with .and() / .or()", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      qb.where(
        coalesce(u.nickname, u.name)
          .eq("admin")
          .or(u.score.gt(90)),
      );
      const { text } = qb.getSql();
      expect(text).toContain("COALESCE");
      expect(text).toContain(" OR ");
    });

    it("works inside Expressions.and()", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      const cond = Expressions.and(
        coalesce(u.score, 0).gte(50),
        u.name.eq("Alice"),
      );
      qb.where(cond);
      const { text } = qb.getSql();
      expect(text).toContain(
        `(COALESCE("u"."score", ?) >= ? AND "u"."name" = ?)`,
      );
    });

    it("isScalarCondition guard identifies the condition type", () => {
      const u = qAlias(User, "u");
      const cond = coalesce(u.nickname, u.name).eq("admin");
      expect(isScalarCondition(cond)).toBe(true);
    });
  });

  describe("Expressions.coalesce / Expressions.nullif — static surface", () => {
    it("Expressions.coalesce delegates to coalesce()", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      qb.select([Expressions.coalesce(u.nickname, "anon").as("d")]);
      const { text } = qb.getSql();
      expect(text).toContain(`COALESCE("u"."nickname", ?) AS "d"`);
    });

    it("Expressions.nullif delegates to nullif()", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      qb.select([Expressions.nullif(u.email, "").as("x")]);
      const { text } = qb.getSql();
      expect(text).toContain(`NULLIF("u"."email", ?) AS "x"`);
    });
  });
});
