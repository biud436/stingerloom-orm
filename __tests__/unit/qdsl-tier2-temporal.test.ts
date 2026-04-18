import "reflect-metadata";
import { SelectQueryBuilder, qAlias } from "../../src/core/SelectQueryBuilder";
import { Entity, PrimaryGeneratedColumn, Column } from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { createDialectExpression } from "../../src/dialects/DialectExpression";
import {
  currentDate,
  currentTime,
  currentTimestamp,
} from "../../src/core/expressions/TemporalExpression";
import {
  ScalarExpression,
  isScalarExpression,
} from "../../src/core/expressions/ScalarExpression";
import { Expressions } from "../../src/core/expressions/LogicalCondition";

@Entity()
class Session {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "datetime" })
  createdAt!: Date;

  @Column({ type: "datetime" })
  expiresAt!: Date;
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
  const qb = new SelectQueryBuilder<Session>(Session, "s", em);
  const resolver = (em as any).resolver as RelationMetadataResolver;
  const meta = resolver.resolveEntityMetadata(Session);
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

describe("Temporal helpers — currentDate / currentTime / currentTimestamp (QueryDSL Tier 2)", () => {
  describe("factories", () => {
    it("currentDate() returns a ScalarExpression", () => {
      const expr = currentDate();
      expect(isScalarExpression(expr)).toBe(true);
      expect(expr).toBeInstanceOf(ScalarExpression);
    });

    it("currentTime() returns a ScalarExpression", () => {
      expect(isScalarExpression(currentTime())).toBe(true);
    });

    it("currentTimestamp() returns a ScalarExpression", () => {
      expect(isScalarExpression(currentTimestamp())).toBe(true);
    });
  });

  describe("SQL rendering — dialect-independent", () => {
    const check = (dbType: DbType) => {
      const qb = createQb(dbType);
      qb.select([
        currentDate().as("today"),
        currentTime().as("now_t"),
        currentTimestamp().as("now_ts"),
      ]);
      return qb.getSql().text;
    };

    it("emits CURRENT_DATE / CURRENT_TIME / CURRENT_TIMESTAMP on PostgreSQL", () => {
      const text = check("postgresql");
      expect(text).toContain("CURRENT_DATE");
      expect(text).toContain("CURRENT_TIME");
      expect(text).toContain("CURRENT_TIMESTAMP");
    });

    it("emits the same literals on MySQL", () => {
      const text = check("mysql");
      expect(text).toContain("CURRENT_DATE");
      expect(text).toContain("CURRENT_TIME");
      expect(text).toContain("CURRENT_TIMESTAMP");
    });

    it("emits the same literals on SQLite", () => {
      const text = check("sqlite");
      expect(text).toContain("CURRENT_DATE");
      expect(text).toContain("CURRENT_TIME");
      expect(text).toContain("CURRENT_TIMESTAMP");
    });
  });

  describe("WHERE / HAVING usage", () => {
    it("supports currentTimestamp() as a comparison operand via ColumnExpression", () => {
      const s = qAlias(Session, "s");
      const qb = createQb();
      qb.where(s.expiresAt.gte(currentTimestamp()));
      const { text } = qb.getSql();
      // Current-value operand is sent inline (no binding for CURRENT_TIMESTAMP itself);
      // the column reference qualifies through the alias registry.
      expect(text).toContain(`"s"."expiresAt" >= `);
      // CURRENT_TIMESTAMP literal may end up serialized through a
      // placeholder if the dialect treats ScalarExpression as a value —
      // assert its presence either in SQL text or in the bound values
      // array.
      const { values } = qb.getSql();
      const hasLiteral =
        text.includes("CURRENT_TIMESTAMP") ||
        (values as unknown[]).some(
          (v) =>
            typeof v === "object" &&
            v !== null &&
            (v as { sql?: unknown }).sql === "CURRENT_TIMESTAMP",
        );
      expect(hasLiteral).toBe(true);
    });
  });

  describe("composition with ScalarCondition", () => {
    it("currentDate().eq(x) builds a ScalarCondition", () => {
      const qb = createQb();
      qb.where(currentDate().eq("2026-04-18"));
      const { text, values } = qb.getSql();
      expect(text).toContain("CURRENT_DATE = ");
      expect(values).toContain("2026-04-18");
    });
  });

  describe("Expressions namespace", () => {
    it("Expressions.currentDate() delegates to currentDate()", () => {
      const qb = createQb();
      qb.select([Expressions.currentDate().as("d")]);
      expect(qb.getSql().text).toContain(`CURRENT_DATE AS "d"`);
    });

    it("Expressions.currentTime() delegates", () => {
      const qb = createQb();
      qb.select([Expressions.currentTime().as("t")]);
      expect(qb.getSql().text).toContain(`CURRENT_TIME AS "t"`);
    });

    it("Expressions.currentTimestamp() delegates", () => {
      const qb = createQb();
      qb.select([Expressions.currentTimestamp().as("ts")]);
      expect(qb.getSql().text).toContain(`CURRENT_TIMESTAMP AS "ts"`);
    });
  });
});
