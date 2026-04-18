import "reflect-metadata";
import { SelectQueryBuilder, qAlias } from "../../src/core/SelectQueryBuilder";
import { Entity, PrimaryGeneratedColumn, Column } from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { createDialectExpression } from "../../src/dialects/DialectExpression";
import { Expressions } from "../../src/core/expressions/LogicalCondition";
import {
  CaseBuilder,
  CaseValueBuilder,
  caseBuilder,
  cases,
} from "../../src/core/expressions/CaseExpression";
import { isScalarExpression } from "../../src/core/expressions/ScalarExpression";

@Entity()
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 50 })
  status!: string;

  @Column({ type: "int" })
  score!: number;

  @Column({ type: "varchar", length: 50 })
  role!: string;
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

describe("CaseBuilder (QueryDSL Tier 2)", () => {
  describe("searched CASE — caseBuilder()", () => {
    it("factory returns a CaseBuilder", () => {
      expect(caseBuilder()).toBeInstanceOf(CaseBuilder);
    });

    it("single WHEN/THEN + ELSE renders CASE WHEN cond THEN v ELSE d END", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      const tier = Expressions.caseBuilder()
        .when(u.score.gte(90))
        .then("gold")
        .otherwise("bronze")
        .end();
      qb.select([tier.as("tier")]);
      const { text, values } = qb.getSql();
      expect(text).toContain(
        `CASE WHEN "u"."score" >= ? THEN ? ELSE ? END AS "tier"`,
      );
      expect(values).toEqual(expect.arrayContaining([90, "gold", "bronze"]));
    });

    it("multiple WHENs preserve order and emit one CASE block", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      const tier = Expressions.caseBuilder()
        .when(u.score.gte(90)).then("gold")
        .when(u.score.gte(70)).then("silver")
        .otherwise("bronze")
        .end();
      qb.select([tier.as("tier")]);
      const { text } = qb.getSql();
      expect(text).toMatch(
        /CASE WHEN .+ THEN .+ WHEN .+ THEN .+ ELSE .+ END AS "tier"/,
      );
    });

    it("omitting otherwise() is valid — renders without ELSE", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      const tier = Expressions.caseBuilder()
        .when(u.score.gte(90)).then("gold")
        .end();
      qb.select([tier.as("tier")]);
      const { text } = qb.getSql();
      expect(text).toContain(`CASE WHEN "u"."score" >= ? THEN ? END`);
      expect(text).not.toContain(" ELSE ");
    });

    it("supports column expression as the THEN value", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      const tier = Expressions.caseBuilder()
        .when(u.score.gte(90)).then(u.status)
        .otherwise("default")
        .end();
      qb.select([tier.as("tier")]);
      const { text } = qb.getSql();
      expect(text).toContain(`THEN "u"."status"`);
    });

    it("result returned by end() is a ScalarExpression", () => {
      const u = qAlias(User, "u");
      const scalar = Expressions.caseBuilder()
        .when(u.score.gt(0)).then(1)
        .end();
      expect(isScalarExpression(scalar)).toBe(true);
    });

    it("CaseExpression composes with .as() and cast", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      const tier = Expressions.caseBuilder()
        .when(u.score.gte(90)).then("gold")
        .otherwise("bronze")
        .end()
        .stringValue()
        .as("tier");
      qb.select([tier]);
      const { text } = qb.getSql();
      expect(text).toMatch(/CAST\(CASE WHEN .+ END AS TEXT\) AS "tier"/);
    });

    it("CaseExpression composes with .eq() to form a WHERE condition", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      const tier = Expressions.caseBuilder()
        .when(u.score.gte(90)).then("gold")
        .otherwise("bronze")
        .end();
      qb.where(tier.eq("gold"));
      const { text, values } = qb.getSql();
      expect(text).toMatch(/CASE WHEN .+ END = \?/);
      expect(values).toContain("gold");
    });

    it("throws on end() without any WHEN", () => {
      expect(() => caseBuilder().end()).toThrow(/at least one WHEN/);
    });

    it("throws on when() after otherwise()", () => {
      const u = qAlias(User, "u");
      expect(() =>
        Expressions.caseBuilder()
          .when(u.score.gt(0))
          .then("a")
          .otherwise("b")
          .when(u.score.gt(10)),
      ).toThrow(/cannot add .when/);
    });

    it("throws on duplicate otherwise()", () => {
      const u = qAlias(User, "u");
      expect(() =>
        Expressions.caseBuilder()
          .when(u.score.gt(0))
          .then("a")
          .otherwise("b")
          .otherwise("c"),
      ).toThrow(/already set/);
    });

    it("throws on when() with non-condition argument", () => {
      expect(() => caseBuilder().when({} as any)).toThrow(
        /ConditionLike/,
      );
    });
  });

  describe("simple CASE — cases(subject)", () => {
    it("factory returns a CaseValueBuilder", () => {
      expect(cases(1)).toBeInstanceOf(CaseValueBuilder);
    });

    it("cases(col).when(val, result).otherwise().end()", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      const weight = Expressions.cases(u.status)
        .when("active", 1)
        .when("pending", 0)
        .otherwise(-1)
        .end();
      qb.select([weight.as("w")]);
      const { text, values } = qb.getSql();
      expect(text).toContain(
        `CASE "u"."status" WHEN ? THEN ? WHEN ? THEN ? ELSE ? END AS "w"`,
      );
      expect(values).toEqual(
        expect.arrayContaining(["active", 1, "pending", 0, -1]),
      );
    });

    it("end() result is a ScalarExpression suitable for comparison", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      const weight = Expressions.cases(u.status)
        .when("active", 1)
        .otherwise(0)
        .end();
      qb.where(weight.eq(1));
      const { text } = qb.getSql();
      expect(text).toMatch(/CASE "u"\."status" WHEN .+ THEN .+ ELSE .+ END = \?/);
    });

    it("simple CASE without otherwise() is valid", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      const w = Expressions.cases(u.status).when("active", 1).end();
      qb.select([w.as("x")]);
      expect(qb.getSql().text).toContain(
        `CASE "u"."status" WHEN ? THEN ? END AS "x"`,
      );
    });

    it("throws on end() without any WHEN", () => {
      const u = qAlias(User, "u");
      expect(() => cases(u.status).end()).toThrow(/at least one WHEN/);
    });

    it("throws on duplicate otherwise()", () => {
      const u = qAlias(User, "u");
      expect(() =>
        cases(u.status)
          .when("a", 1)
          .otherwise(0)
          .otherwise(-1),
      ).toThrow(/already set/);
    });
  });

  describe("integration with other expression types", () => {
    it("CASE result feeds into coalesce()", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      const ranked = Expressions.caseBuilder()
        .when(u.score.gte(90)).then("gold")
        .end();
      qb.select([
        Expressions.coalesce(ranked, u.status, "unknown").as("tier"),
      ]);
      const { text } = qb.getSql();
      expect(text).toContain("COALESCE(CASE WHEN ");
      expect(text).toContain(`"u"."status"`);
    });

    it("CASE composes inside Expressions.and() via .eq() result", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      const band = Expressions.caseBuilder()
        .when(u.score.gte(90)).then("gold")
        .otherwise("other")
        .end();
      qb.where(Expressions.and(band.eq("gold"), u.role.eq("member")));
      const { text } = qb.getSql();
      expect(text).toContain(" AND ");
      expect(text).toMatch(/CASE WHEN .+ END = \?/);
    });
  });
});
