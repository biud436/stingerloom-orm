import "reflect-metadata";
import { SelectQueryBuilder, qAlias } from "../../src/core/SelectQueryBuilder";
import { Entity, PrimaryGeneratedColumn, Column } from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { createDialectExpression } from "../../src/dialects/DialectExpression";
import { Expressions } from "../../src/core/expressions/LogicalCondition";
import { isScalarExpression } from "../../src/core/expressions/ScalarExpression";
import { buckets, iff, mapValues } from "../../src/core/expressions/CaseExpression";

@Entity()
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 50 })
  status!: string;

  @Column({ type: "int" })
  score!: number;

  @Column({ type: "int" })
  age!: number;

  @Column({ type: "datetime", nullable: true })
  deletedAt!: Date | null;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resolver = (em as any).resolver as RelationMetadataResolver;
  const meta = resolver.resolveEntityMetadata(User);
  if (meta) {
    const map = new Map<string, string>();
    for (const c of meta.columns) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      map.set((c as any).propertyKey ?? c.name!, c.name!);
    }
    qb.setPropertyToColumnMap(map);
  }
  const dialectName = dbType === "postgresql" ? "postgres" : dbType;
  qb.setDialectExpression(createDialectExpression(dialectName));
  return qb;
}

describe("CASE shortcuts — Expressions.iff / mapValues / buckets", () => {
  describe("iff(condition, whenTrue, whenFalse)", () => {
    it("renders CASE WHEN cond THEN a ELSE b END", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      const flag = Expressions.iff(u.deletedAt.isNull(), "active", "deleted");
      qb.select([flag.as("flag")]);
      const { text, values } = qb.getSql();
      expect(text).toContain(
        `CASE WHEN "u"."deletedAt" IS NULL THEN ? ELSE ? END AS "flag"`,
      );
      expect(values).toEqual(
        expect.arrayContaining(["active", "deleted"]),
      );
    });

    it("returns a ScalarExpression", () => {
      const u = qAlias(User, "u");
      expect(isScalarExpression(iff(u.score.gt(0), 1, 0))).toBe(true);
    });

    it("composes with .as() + .eq() for WHERE", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      const flag = Expressions.iff(u.score.gte(50), "pass", "fail");
      qb.where(flag.eq("pass"));
      const { text, values } = qb.getSql();
      expect(text).toMatch(/CASE WHEN .+ THEN \? ELSE \? END = \?/);
      expect(values).toEqual(expect.arrayContaining([50, "pass", "fail", "pass"]));
    });

    it("accepts a column/scalar expression as a result value", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      const picked = Expressions.iff(
        u.deletedAt.isNotNull(),
        u.status,
        "n/a",
      );
      qb.select([picked.as("picked")]);
      const { text } = qb.getSql();
      expect(text).toContain(`THEN "u"."status" ELSE ?`);
    });

    it("renders identically on MySQL with backtick identifiers", () => {
      const u = qAlias(User, "u");
      const qb = createQb("mysql");
      const flag = Expressions.iff(u.score.gt(0), 1, 0);
      qb.select([flag.as("flag")]);
      const { text } = qb.getSql();
      expect(text).toContain("CASE WHEN `u`.`score` > ? THEN ? ELSE ? END");
    });
  });

  describe("mapValues(subject, mapping, default?)", () => {
    it("renders simple CASE with WHEN/THEN pairs and ELSE", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      const weight = Expressions.mapValues(
        u.status,
        { active: 1, pending: 0 },
        -1,
      );
      qb.select([weight.as("w")]);
      const { text, values } = qb.getSql();
      expect(text).toContain(
        `CASE "u"."status" WHEN ? THEN ? WHEN ? THEN ? ELSE ? END AS "w"`,
      );
      expect(values).toEqual(
        expect.arrayContaining(["active", 1, "pending", 0, -1]),
      );
    });

    it("preserves insertion order of object keys", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      const weight = Expressions.mapValues(u.status, {
        first: 10,
        second: 20,
        third: 30,
      });
      qb.select([weight.as("w")]);
      const { values } = qb.getSql();
      const firstIdx = values.indexOf("first");
      const secondIdx = values.indexOf("second");
      const thirdIdx = values.indexOf("third");
      expect(firstIdx).toBeLessThan(secondIdx);
      expect(secondIdx).toBeLessThan(thirdIdx);
    });

    it("omits ELSE when no default is supplied", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      const weight = Expressions.mapValues(u.status, { active: 1 });
      qb.select([weight.as("w")]);
      const { text } = qb.getSql();
      expect(text).toContain(`CASE "u"."status" WHEN ? THEN ? END AS "w"`);
      expect(text).not.toContain(" ELSE ");
    });

    it("throws when mapping is empty", () => {
      const u = qAlias(User, "u");
      expect(() => mapValues(u.status, {})).toThrow(/at least one entry/);
    });

    it("returns a ScalarExpression that composes with .eq()", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      const weight = Expressions.mapValues(u.status, { active: 1 }, 0);
      qb.where(weight.eq(1));
      const { text } = qb.getSql();
      expect(text).toMatch(/CASE "u"\."status" WHEN .+ END = \?/);
    });

    it("supports column expression as a result value", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      const picked = Expressions.mapValues(
        u.status,
        { promoted: u.score },
        0,
      );
      qb.select([picked.as("v")]);
      const { text } = qb.getSql();
      expect(text).toContain(`THEN "u"."score"`);
    });
  });

  describe("buckets(subject, thresholds, default?, { op })", () => {
    it("defaults to `>=` with descending thresholds", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      const tier = Expressions.buckets(
        u.score,
        [
          [90, "gold"],
          [70, "silver"],
        ],
        "bronze",
      );
      qb.select([tier.as("tier")]);
      const { text, values } = qb.getSql();
      expect(text).toContain(
        `CASE WHEN "u"."score" >= ? THEN ? WHEN "u"."score" >= ? THEN ? ELSE ? END AS "tier"`,
      );
      expect(values).toEqual(
        expect.arrayContaining([90, "gold", 70, "silver", "bronze"]),
      );
    });

    it("omits ELSE when no default is supplied", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      const tier = Expressions.buckets(u.score, [[90, "gold"]]);
      qb.select([tier.as("tier")]);
      const { text } = qb.getSql();
      expect(text).toContain(
        `CASE WHEN "u"."score" >= ? THEN ? END AS "tier"`,
      );
      expect(text).not.toContain(" ELSE ");
    });

    it("supports ascending with op: '<'", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      const cohort = Expressions.buckets(
        u.age,
        [
          [18, "child"],
          [65, "adult"],
        ],
        "senior",
        { op: "<" },
      );
      qb.select([cohort.as("cohort")]);
      const { text } = qb.getSql();
      expect(text).toContain(
        `CASE WHEN "u"."age" < ? THEN ? WHEN "u"."age" < ? THEN ? ELSE ? END AS "cohort"`,
      );
    });

    it("supports '>' operator", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      const tier = Expressions.buckets(
        u.score,
        [[90, "excellent"]],
        "other",
        { op: ">" },
      );
      qb.select([tier.as("tier")]);
      const { text } = qb.getSql();
      expect(text).toContain(`CASE WHEN "u"."score" > ? THEN ? ELSE ? END`);
    });

    it("supports '<=' operator", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      const tier = Expressions.buckets(
        u.score,
        [[10, "low"]],
        undefined,
        { op: "<=" },
      );
      qb.select([tier.as("tier")]);
      const { text } = qb.getSql();
      expect(text).toContain(`CASE WHEN "u"."score" <= ? THEN ? END`);
    });

    it("accepts a ScalarExpression subject (chained arithmetic)", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      const shifted = u.score.add(10);
      const tier = Expressions.buckets(
        shifted,
        [[100, "top"]],
        "other",
      );
      qb.select([tier.as("tier")]);
      const { text } = qb.getSql();
      expect(text).toMatch(/CASE WHEN \("u"\."score" \+ \?\) >= \? THEN \? ELSE \? END/);
    });

    it("throws when thresholds array is empty", () => {
      const u = qAlias(User, "u");
      expect(() => buckets(u.score, [], "x")).toThrow(/at least one entry/);
    });

    it("throws when subject lacks comparison methods", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => buckets({} as any, [[1, "a"]], "x")).toThrow(
        /ColumnExpression or ScalarExpression/,
      );
    });

    it("returns a ScalarExpression composable with .eq()", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      const tier = Expressions.buckets(
        u.score,
        [[90, "gold"]],
        "other",
      );
      qb.where(tier.eq("gold"));
      const { text } = qb.getSql();
      expect(text).toMatch(/CASE WHEN .+ END = \?/);
    });
  });

  describe("integration with other Expressions", () => {
    it("iff composes inside coalesce()", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      const pick = Expressions.iff(u.score.gt(0), "positive", "non-positive");
      qb.select([Expressions.coalesce(pick, "unknown").as("v")]);
      const { text } = qb.getSql();
      expect(text).toContain("COALESCE(CASE WHEN ");
    });

    it("buckets composes with Expressions.and()", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      const tier = Expressions.buckets(u.score, [[90, "gold"]], "other");
      qb.where(Expressions.and(tier.eq("gold"), u.status.eq("active")));
      const { text } = qb.getSql();
      expect(text).toContain(" AND ");
      expect(text).toMatch(/CASE WHEN .+ END = \?/);
    });

    it("mapValues result chains through .stringValue() cast", () => {
      const u = qAlias(User, "u");
      const qb = createQb();
      const labeled = Expressions.mapValues(u.status, { active: 1 }, 0)
        .stringValue()
        .as("label");
      qb.select([labeled]);
      const { text } = qb.getSql();
      expect(text).toMatch(/CAST\(CASE "u"\."status" WHEN .+ END AS TEXT\) AS "label"/);
    });
  });
});
