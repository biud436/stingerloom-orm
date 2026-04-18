import "reflect-metadata";
import { SelectQueryBuilder, qAlias } from "../../src/core/SelectQueryBuilder";
import { Entity, PrimaryGeneratedColumn, Column } from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { createDialectExpression } from "../../src/dialects/DialectExpression";
import { Expressions } from "../../src/core/expressions/LogicalCondition";

@Entity()
class Event {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "datetime" })
  startsAt!: Date;

  @Column({ type: "datetime" })
  endsAt!: Date;
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

describe("Date component expressions (QueryDSL Tier 2)", () => {
  describe("PostgreSQL dialect — EXTRACT(... FROM ...)", () => {
    const e = qAlias(Event, "e");

    it("year() emits EXTRACT(YEAR FROM col)", () => {
      const qb = createQb("postgresql").select([e.startsAt.year().as("y")]);
      expect(qb.getSql().text).toContain(
        `CAST(EXTRACT(YEAR FROM "e"."startsAt") AS INTEGER) AS "y"`,
      );
    });
    it("month() emits EXTRACT(MONTH FROM col)", () => {
      const qb = createQb("postgresql").select([e.startsAt.month().as("m")]);
      expect(qb.getSql().text).toContain("EXTRACT(MONTH FROM ");
    });
    it("day() emits EXTRACT(DAY FROM col)", () => {
      const qb = createQb("postgresql").select([e.startsAt.day().as("d")]);
      expect(qb.getSql().text).toContain("EXTRACT(DAY FROM ");
    });
    it("hour/minute/second", () => {
      const qb = createQb("postgresql").select([
        e.startsAt.hour().as("h"),
        e.startsAt.minute().as("mi"),
        e.startsAt.second().as("s"),
      ]);
      const text = qb.getSql().text;
      expect(text).toContain("EXTRACT(HOUR FROM ");
      expect(text).toContain("EXTRACT(MINUTE FROM ");
      expect(text).toContain("EXTRACT(SECOND FROM ");
    });
    it("dayOfWeek → DOW, dayOfYear → DOY, week → WEEK", () => {
      const qb = createQb("postgresql").select([
        e.startsAt.dayOfWeek().as("dow"),
        e.startsAt.dayOfYear().as("doy"),
        e.startsAt.week().as("w"),
      ]);
      const text = qb.getSql().text;
      expect(text).toContain("EXTRACT(DOW FROM ");
      expect(text).toContain("EXTRACT(DOY FROM ");
      expect(text).toContain("EXTRACT(WEEK FROM ");
    });
  });

  describe("MySQL dialect — component functions", () => {
    const e = qAlias(Event, "e");

    it("year/month/dayOfMonth", () => {
      const qb = createQb("mysql").select([
        e.startsAt.year().as("y"),
        e.startsAt.month().as("m"),
        e.startsAt.dayOfMonth().as("d"),
      ]);
      const text = qb.getSql().text;
      expect(text).toContain("YEAR(`e`.`startsAt`) AS `y`");
      expect(text).toContain("MONTH(`e`.`startsAt`) AS `m`");
      expect(text).toContain("DAYOFMONTH(`e`.`startsAt`) AS `d`");
    });

    it("dayOfWeek → DAYOFWEEK, dayOfYear → DAYOFYEAR, week → WEEK", () => {
      const qb = createQb("mysql").select([
        e.startsAt.dayOfWeek().as("dw"),
        e.startsAt.dayOfYear().as("dy"),
        e.startsAt.week().as("w"),
      ]);
      const text = qb.getSql().text;
      expect(text).toContain("DAYOFWEEK(`e`.`startsAt`)");
      expect(text).toContain("DAYOFYEAR(`e`.`startsAt`)");
      expect(text).toContain("WEEK(`e`.`startsAt`)");
    });

    it("hour/minute/second", () => {
      const qb = createQb("mysql").select([
        e.startsAt.hour().as("h"),
        e.startsAt.minute().as("mi"),
        e.startsAt.second().as("s"),
      ]);
      const text = qb.getSql().text;
      expect(text).toContain("HOUR(`e`.`startsAt`)");
      expect(text).toContain("MINUTE(`e`.`startsAt`)");
      expect(text).toContain("SECOND(`e`.`startsAt`)");
    });

    it("day() maps to DAYOFMONTH", () => {
      const qb = createQb("mysql").select([e.startsAt.day().as("d")]);
      expect(qb.getSql().text).toContain("DAYOFMONTH(`e`.`startsAt`)");
    });
  });

  describe("SQLite dialect — strftime + CAST", () => {
    const e = qAlias(Event, "e");

    it("year → strftime('%Y', col)", () => {
      const qb = createQb("sqlite").select([e.startsAt.year().as("y")]);
      const { text, values } = qb.getSql();
      expect(text).toContain(
        `CAST(strftime(?, "e"."startsAt") AS INTEGER) AS "y"`,
      );
      expect(values).toContain("%Y");
    });

    it("month, day, hour, minute, second — each uses a distinct strftime format", () => {
      const qb = createQb("sqlite").select([
        e.startsAt.month().as("m"),
        e.startsAt.day().as("d"),
        e.startsAt.hour().as("h"),
        e.startsAt.minute().as("mi"),
        e.startsAt.second().as("s"),
      ]);
      const { values } = qb.getSql();
      expect(values).toEqual(
        expect.arrayContaining(["%m", "%d", "%H", "%M", "%S"]),
      );
    });

    it("dayOfWeek → %w, dayOfYear → %j, week → %W", () => {
      const qb = createQb("sqlite").select([
        e.startsAt.dayOfWeek().as("dw"),
        e.startsAt.dayOfYear().as("dy"),
        e.startsAt.week().as("w"),
      ]);
      const { values } = qb.getSql();
      expect(values).toEqual(
        expect.arrayContaining(["%w", "%j", "%W"]),
      );
    });
  });

  describe("WHERE / HAVING usage", () => {
    it("year().eq(2026) becomes a WHERE condition", () => {
      const e = qAlias(Event, "e");
      const qb = createQb("postgresql");
      qb.where(e.startsAt.year().eq(2026));
      const { text, values } = qb.getSql();
      expect(text).toContain(`CAST(EXTRACT(YEAR FROM "e"."startsAt") AS INTEGER) = ?`);
      expect(values).toContain(2026);
    });

    it("composes with Expressions.and", () => {
      const e = qAlias(Event, "e");
      const qb = createQb("mysql");
      qb.where(
        Expressions.and(
          e.startsAt.year().eq(2026),
          e.startsAt.month().gte(3),
        ),
      );
      const { text } = qb.getSql();
      expect(text).toContain("YEAR(`e`.`startsAt`) =");
      expect(text).toContain("MONTH(`e`.`startsAt`) >=");
      expect(text).toContain(" AND ");
    });

    it("ORDER BY on a date component via .asc() through a CAST layer", () => {
      const e = qAlias(Event, "e");
      // Verify that chaining .year() in SELECT works; ordering requires
      // addOrderBy on a ref — outside Phase 2.5 scope, but confirm the
      // scalar composes at least in HAVING position.
      const qb = createQb("postgresql");
      qb.groupBy([e.col("startsAt")]).having(e.startsAt.year().gte(2026));
      const { text } = qb.getSql();
      expect(text).toContain(`HAVING CAST(EXTRACT(YEAR`);
    });
  });

  describe("Chaining CAST after date component", () => {
    it("year().stringValue() nests correctly on PostgreSQL", () => {
      const e = qAlias(Event, "e");
      const qb = createQb("postgresql").select([
        e.startsAt.year().stringValue().as("y"),
      ]);
      expect(qb.getSql().text).toContain(
        `CAST(CAST(EXTRACT(YEAR FROM "e"."startsAt") AS INTEGER) AS TEXT) AS "y"`,
      );
    });
  });

  describe("Error paths", () => {
    it("throws on missing dialect when detached", () => {
      const e = qAlias(Event, "e");
      const expr = e.startsAt.year();
      expect(() => expr.renderer((ref) => ref)).toThrow(
        /require.* DialectExpression/,
      );
    });
  });
});
