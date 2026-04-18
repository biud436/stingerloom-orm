import "reflect-metadata";
import { SelectQueryBuilder, qAlias } from "../../src/core/SelectQueryBuilder";
import { Entity, PrimaryGeneratedColumn, Column } from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { createDialectExpression } from "../../src/dialects/DialectExpression";
import { Expressions } from "../../src/core/expressions/LogicalCondition";
import {
  dateDiff,
  random,
} from "../../src/core/expressions/DateArithmeticExpression";
import { WindowBuilder } from "../../src/core/expressions/WindowExpression";
import { isScalarExpression } from "../../src/core/expressions/ScalarExpression";

@Entity()
class Event {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "datetime" })
  startsAt!: Date;

  @Column({ type: "datetime" })
  endsAt!: Date;

  @Column({ type: "int" })
  score!: number;

  @Column({ type: "int" })
  teamId!: number;

  @Column({ type: "datetime" })
  createdAt!: Date;
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
  const qb = new SelectQueryBuilder<Event>(Event, "e", em);
  const resolver = (em as any).resolver as RelationMetadataResolver;
  const meta = resolver.resolveEntityMetadata(Event);
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

describe("Date arithmetic / window / random (QueryDSL Tier 3, Phase 3.2)", () => {
  describe("addDays / addMonths / addYears — PostgreSQL", () => {
    it("addDays(7) → (col + (7 * INTERVAL '1 day'))", () => {
      const e = qAlias(Event, "e");
      const { text, values } = createQb("postgresql")
        .select([e.startsAt.addDays(7).as("future")])
        .getSql();
      expect(text).toContain(
        `("e"."startsAt" + (? * INTERVAL '1 day')) AS "future"`,
      );
      expect(values).toContain(7);
    });

    it("addMonths + addYears", () => {
      const e = qAlias(Event, "e");
      const { text } = createQb("postgresql")
        .select([
          e.startsAt.addMonths(3).as("q"),
          e.startsAt.addYears(1).as("next_year"),
        ])
        .getSql();
      expect(text).toContain("INTERVAL '1 month'");
      expect(text).toContain("INTERVAL '1 year'");
    });

    it("negative n subtracts", () => {
      const e = qAlias(Event, "e");
      const { text, values } = createQb("postgresql")
        .select([e.startsAt.addDays(-7).as("week_ago")])
        .getSql();
      expect(text).toContain("INTERVAL '1 day'");
      expect(values).toContain(-7);
    });
  });

  describe("addDays — MySQL", () => {
    it("addDays(7) → DATE_ADD(col, INTERVAL 7 DAY)", () => {
      const e = qAlias(Event, "e");
      const { text, values } = createQb("mysql")
        .select([e.startsAt.addDays(7).as("future")])
        .getSql();
      expect(text).toContain("DATE_ADD(`e`.`startsAt`, INTERVAL ? DAY)");
      expect(values).toContain(7);
    });

    it("addHours / addMinutes / addSeconds — MySQL", () => {
      const e = qAlias(Event, "e");
      const { text } = createQb("mysql")
        .select([
          e.startsAt.addHours(1).as("h"),
          e.startsAt.addMinutes(30).as("m"),
          e.startsAt.addSeconds(10).as("s"),
        ])
        .getSql();
      expect(text).toContain("INTERVAL ? HOUR");
      expect(text).toContain("INTERVAL ? MINUTE");
      expect(text).toContain("INTERVAL ? SECOND");
    });
  });

  describe("addDays — SQLite", () => {
    it("addDays(7) → datetime(col, '+7 days')", () => {
      const e = qAlias(Event, "e");
      const { text, values } = createQb("sqlite")
        .select([e.startsAt.addDays(7).as("future")])
        .getSql();
      expect(text).toContain(`datetime("e"."startsAt", ?) AS "future"`);
      expect(values).toContain("+7 days");
    });

    it("negative n — SQLite uses -N days", () => {
      const e = qAlias(Event, "e");
      const { values } = createQb("sqlite")
        .select([e.startsAt.addDays(-3).as("past")])
        .getSql();
      expect(values).toContain("-3 days");
    });
  });

  describe("dateDiff", () => {
    it("PostgreSQL day diff → epoch / 86400", () => {
      const e = qAlias(Event, "e");
      const expr = dateDiff(e.endsAt, e.startsAt, "day");
      const { text } = createQb("postgresql").select([expr.as("d")]).getSql();
      expect(text).toContain("EXTRACT(EPOCH FROM");
      expect(text).toContain("/ ?");
    });

    it("PostgreSQL year diff → age()", () => {
      const e = qAlias(Event, "e");
      const expr = dateDiff(e.endsAt, e.startsAt, "year");
      const { text } = createQb("postgresql").select([expr.as("y")]).getSql();
      expect(text).toContain("age(");
      expect(text).toContain("EXTRACT(YEAR FROM age(");
    });

    it("PostgreSQL month diff → year*12 + month", () => {
      const e = qAlias(Event, "e");
      const expr = dateDiff(e.endsAt, e.startsAt, "month");
      const { text } = createQb("postgresql").select([expr.as("m")]).getSql();
      expect(text).toContain("EXTRACT(YEAR FROM age(");
      expect(text).toContain("* 12");
      expect(text).toContain("EXTRACT(MONTH FROM age(");
    });

    it("MySQL → TIMESTAMPDIFF(UNIT, b, a)", () => {
      const e = qAlias(Event, "e");
      const expr = dateDiff(e.endsAt, e.startsAt, "day");
      const { text } = createQb("mysql").select([expr.as("d")]).getSql();
      expect(text).toContain(
        "TIMESTAMPDIFF(DAY, `e`.`startsAt`, `e`.`endsAt`)",
      );
    });

    it("SQLite → julianday difference with factor", () => {
      const e = qAlias(Event, "e");
      const expr = dateDiff(e.endsAt, e.startsAt, "hour");
      const { text, values } = createQb("sqlite").select([expr.as("h")]).getSql();
      expect(text).toContain(
        `CAST((julianday("e"."endsAt") - julianday("e"."startsAt")) * ? AS INTEGER)`,
      );
      expect(values).toContain(24); // hour factor
    });

    it("SQLite year/month uses 365.25 / 30.4375 approximation", () => {
      const e = qAlias(Event, "e");
      const yearExpr = dateDiff(e.endsAt, e.startsAt, "year");
      const monthExpr = dateDiff(e.endsAt, e.startsAt, "month");
      expect(createQb("sqlite").select([yearExpr.as("y")]).getSql().text).toContain(
        "/ 365.25",
      );
      expect(createQb("sqlite").select([monthExpr.as("m")]).getSql().text).toContain(
        "/ 30.4375",
      );
    });

    it("accepts primitive dates as operands", () => {
      const e = qAlias(Event, "e");
      const expr = dateDiff("2026-01-01", e.startsAt, "day");
      const { values } = createQb("postgresql").select([expr.as("d")]).getSql();
      expect(values).toContain("2026-01-01");
    });

    it("Expressions.dateDiff delegates", () => {
      const e = qAlias(Event, "e");
      const expr = Expressions.dateDiff(e.endsAt, e.startsAt, "day");
      expect(isScalarExpression(expr)).toBe(true);
    });
  });

  describe("Expressions.random()", () => {
    it("PostgreSQL emits RANDOM()", () => {
      const qb = createQb("postgresql").select([random().as("r")]);
      expect(qb.getSql().text).toContain(`RANDOM() AS "r"`);
    });

    it("MySQL emits RAND()", () => {
      const qb = createQb("mysql").select([random().as("r")]);
      expect(qb.getSql().text).toContain("RAND() AS `r`");
    });

    it("SQLite emits RANDOM()", () => {
      const qb = createQb("sqlite").select([random().as("r")]);
      expect(qb.getSql().text).toContain(`RANDOM() AS "r"`);
    });

    it("Expressions.random() delegates", () => {
      expect(isScalarExpression(Expressions.random())).toBe(true);
    });
  });

  describe("WindowBuilder — aggregate.over()", () => {
    it("empty window: COUNT(*) OVER ()", () => {
      const e = qAlias(Event, "e");
      const qb = createQb("postgresql");
      const agg = e.id.count();
      const w = agg.over().as("total");
      qb.select([w]);
      const { text } = qb.getSql();
      expect(text).toContain(`COUNT("e"."id") OVER () AS "total"`);
    });

    it("partitionBy + orderBy + rowsBetween", () => {
      const e = qAlias(Event, "e");
      const qb = createQb("postgresql");
      const w = e.score
        .sum()
        .over()
        .partitionBy(e.teamId)
        .orderBy(e.createdAt.desc())
        .rowsBetween("UNBOUNDED PRECEDING", "CURRENT ROW")
        .as("running_total");
      qb.select([w]);
      const { text } = qb.getSql();
      expect(text).toContain(`SUM("e"."score") OVER (`);
      expect(text).toContain(`PARTITION BY "e"."teamId"`);
      expect(text).toContain(`ORDER BY "e"."createdAt" DESC`);
      expect(text).toContain(`ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`);
      expect(text).toContain(`AS "running_total"`);
    });

    it("rangeBetween emits RANGE BETWEEN", () => {
      const e = qAlias(Event, "e");
      const qb = createQb("postgresql");
      const w = e.score
        .sum()
        .over()
        .rangeBetween("UNBOUNDED PRECEDING", "CURRENT ROW")
        .as("running_range");
      qb.select([w]);
      expect(qb.getSql().text).toContain(
        "RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW",
      );
    });

    it("MySQL emits window with backticks", () => {
      const e = qAlias(Event, "e");
      const qb = createQb("mysql");
      const w = e.score
        .sum()
        .over()
        .partitionBy(e.teamId)
        .as("running_total");
      qb.select([w]);
      expect(qb.getSql().text).toContain(
        "SUM(`e`.`score`) OVER (PARTITION BY `e`.`teamId`) AS `running_total`",
      );
    });

    it("toScalar() allows nesting as a comparison operand", () => {
      const e = qAlias(Event, "e");
      const avg = e.score.avg().over().partitionBy(e.teamId).toScalar();
      const qb = createQb("postgresql");
      qb.where(e.score.gt(avg));
      const { text } = qb.getSql();
      expect(text).toContain(
        `"e"."score" > AVG("e"."score") OVER (PARTITION BY "e"."teamId")`,
      );
    });

    it("WindowBuilder is chainable; returned instance is the same type", () => {
      const e = qAlias(Event, "e");
      const builder = e.score.sum().over();
      expect(builder).toBeInstanceOf(WindowBuilder);
      const after = builder.partitionBy(e.teamId);
      expect(after).toBe(builder); // .partitionBy returns this
    });

    it("rank() use via e.id.count().over() partial example", () => {
      // Tier 3 Phase 3.2 doesn't introduce RANK/DENSE_RANK explicitly,
      // but the builder infrastructure is in place; verify it survives
      // a chained orderBy + partitionBy for typical ranking patterns.
      const e = qAlias(Event, "e");
      const qb = createQb("postgresql").select([
        e.id.count().over().partitionBy(e.teamId).orderBy(e.score.desc()).as("rnk"),
      ]);
      expect(qb.getSql().text).toContain(
        `COUNT("e"."id") OVER (PARTITION BY "e"."teamId" ORDER BY "e"."score" DESC) AS "rnk"`,
      );
    });
  });

  describe("Error paths", () => {
    it("addDays throws without dialect (detached)", () => {
      const e = qAlias(Event, "e");
      const expr = e.startsAt.addDays(1);
      expect(() => expr.renderer((ref) => ref)).toThrow(
        /require.* DialectExpression/,
      );
    });

    it("dateDiff throws without dialect (detached)", () => {
      const e = qAlias(Event, "e");
      const expr = dateDiff(e.endsAt, e.startsAt, "day");
      expect(() => expr.renderer((ref) => ref)).toThrow(
        /require.* DialectExpression/,
      );
    });

    it("random throws without dialect (detached)", () => {
      expect(() => random().renderer((ref) => ref)).toThrow(
        /require.* DialectExpression/,
      );
    });
  });
});
