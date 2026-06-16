import "reflect-metadata";
import {
  AggregateExpression,
  isAggregateExpression,
} from "../../src/core/expressions/AggregateExpression";
import {
  ColumnExpression,
  SelectQueryBuilder,
  qAlias,
} from "../../src/core/SelectQueryBuilder";
import { Entity, PrimaryGeneratedColumn, Column } from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { createDialectExpression } from "../../src/dialects/DialectExpression";

/**
 * QueryDSL Tier 5.3 / 5.4 — Aggregate `FILTER (WHERE …)` and the
 * `countIf` / `sumIf` shorthands.
 *
 * Exact cross-dialect SQL is pinned in the golden-SQL suite
 * (`golden-sql/aggregate-expressions.golden.test.ts`); this file covers the
 * API contract: immutability, alias/distinct threading, the no-dialect
 * fallback, and HAVING-comparison composition.
 */

// Identifier resolvers mirroring each driver's escapeIdentifier().
const resolvePg = (ref: string): string => {
  if (ref === "*") return "*";
  if (!ref.includes(".")) return `"${ref}"`;
  const [alias, col] = ref.split(".");
  return `"${alias}"."${col}"`;
};
const resolveMy = (ref: string): string => {
  if (ref === "*") return "*";
  if (!ref.includes(".")) return `\`${ref}\``;
  const [alias, col] = ref.split(".");
  return `\`${alias}\`.\`${col}\``;
};

const pg = createDialectExpression("postgres");
const mysql = createDialectExpression("mysql");
const sqlite = createDialectExpression("sqlite");

const activeStatus = () => new ColumnExpression("u.status").eq("active");

describe("AggregateExpression.filter() (QueryDSL Tier 5.3)", () => {
  describe("immutability + field threading", () => {
    it("returns a new instance and leaves the original unfiltered", () => {
      const base = new ColumnExpression("u.id").count();
      const filtered = base.filter(activeStatus());

      expect(filtered).not.toBe(base);
      expect(base.filterCondition).toBeUndefined();
      expect(filtered.filterCondition).toBeDefined();
    });

    it("preserves func, ref, and distinct through filter()", () => {
      const filtered = new ColumnExpression("u.email")
        .countDistinct()
        .filter(activeStatus());

      expect(filtered.func).toBe("COUNT");
      expect(filtered.ref).toBe("u.email");
      expect(filtered.distinct).toBe(true);
    });

    it("threads filterCondition through .as() in both orders", () => {
      const afterAs = new ColumnExpression("u.id")
        .count()
        .as("active")
        .filter(activeStatus());
      expect(afterAs.alias).toBe("active");
      expect(afterAs.filterCondition).toBeDefined();

      const beforeAs = new ColumnExpression("u.id")
        .count()
        .filter(activeStatus())
        .as("active");
      expect(beforeAs.alias).toBe("active");
      expect(beforeAs.filterCondition).toBeDefined();
    });

    it("is still recognized as an AggregateExpression", () => {
      const filtered = new ColumnExpression("u.id").count().filter(activeStatus());
      expect(isAggregateExpression(filtered)).toBe(true);
    });

    it("keeps the deterministic default alias", () => {
      const filtered = new ColumnExpression("u.id").count().filter(activeStatus());
      expect(filtered.getAlias()).toBe("agg_count_id");
    });
  });

  describe("rendering across dialects", () => {
    it("renders native FILTER on PostgreSQL", () => {
      const out = new ColumnExpression("u.id")
        .count()
        .filter(activeStatus())
        .renderFunction(resolvePg, pg);
      expect(out.sql).toBe('COUNT("u"."id") FILTER (WHERE "u"."status" = ?)');
      expect(out.values).toEqual(["active"]);
    });

    it("renders native FILTER on SQLite", () => {
      const out = new ColumnExpression("u.id")
        .count()
        .filter(activeStatus())
        .renderFunction(resolvePg, sqlite);
      expect(out.sql).toBe('COUNT("u"."id") FILTER (WHERE "u"."status" = ?)');
      expect(out.values).toEqual(["active"]);
    });

    it("rewrites to a conditional CASE aggregate on MySQL", () => {
      const out = new ColumnExpression("u.id")
        .count()
        .filter(activeStatus())
        .renderFunction(resolveMy, mysql);
      expect(out.sql).toBe(
        "COUNT(CASE WHEN `u`.`status` = ? THEN `u`.`id` END)",
      );
      expect(out.values).toEqual(["active"]);
    });

    it("substitutes 1 for COUNT(*) inside the MySQL CASE", () => {
      const out = new ColumnExpression("*")
        .count()
        .filter(activeStatus())
        .renderFunction(resolveMy, mysql);
      expect(out.sql).toBe("COUNT(CASE WHEN `u`.`status` = ? THEN 1 END)");
      expect(out.values).toEqual(["active"]);
    });

    it("falls back to the ANSI FILTER form when no dialect is supplied", () => {
      const out = new ColumnExpression("u.id")
        .count()
        .filter(activeStatus())
        .renderFunction(resolvePg);
      expect(out.sql).toBe('COUNT("u"."id") FILTER (WHERE "u"."status" = ?)');
      expect(out.values).toEqual(["active"]);
    });

    it("renders DISTINCT inside the MySQL CASE rewrite", () => {
      const out = new ColumnExpression("u.email")
        .countDistinct()
        .filter(activeStatus())
        .renderFunction(resolveMy, mysql);
      expect(out.sql).toBe(
        "COUNT(DISTINCT CASE WHEN `u`.`status` = ? THEN `u`.`email` END)",
      );
    });
  });

  describe("HAVING comparison threads the dialect", () => {
    it("renders the MySQL CASE rewrite inside a HAVING comparison", () => {
      const cond = new ColumnExpression("u.id")
        .count()
        .filter(activeStatus())
        .gt(5);
      const out = cond.resolve(resolveMy, mysql);
      expect(out.sql).toBe(
        "COUNT(CASE WHEN `u`.`status` = ? THEN `u`.`id` END) > ?",
      );
      expect(out.values).toEqual(["active", 5]);
    });

    it("renders native FILTER inside a HAVING comparison on PostgreSQL", () => {
      const cond = new ColumnExpression("u.id")
        .count()
        .filter(activeStatus())
        .gt(5);
      const out = cond.resolve(resolvePg, pg);
      expect(out.sql).toBe(
        'COUNT("u"."id") FILTER (WHERE "u"."status" = ?) > ?',
      );
      expect(out.values).toEqual(["active", 5]);
    });
  });
});

describe("countIf / sumIf shorthands (QueryDSL Tier 5.4)", () => {
  it("countIf delegates to count().filter()", () => {
    const agg = new ColumnExpression("u.id").countIf(activeStatus());
    expect(agg.func).toBe("COUNT");
    expect(agg.ref).toBe("u.id");
    expect(agg.filterCondition).toBeDefined();
    expect(agg.renderFunction(resolvePg, pg).sql).toBe(
      'COUNT("u"."id") FILTER (WHERE "u"."status" = ?)',
    );
  });

  it("sumIf delegates to sum().filter()", () => {
    const agg = new ColumnExpression("o.amount").sumIf(
      new ColumnExpression("o.type").eq("refund"),
    );
    expect(agg.func).toBe("SUM");
    expect(agg.ref).toBe("o.amount");
    expect(agg.filterCondition).toBeDefined();
    expect(agg.renderFunction(resolveMy, mysql).sql).toBe(
      "SUM(CASE WHEN `o`.`type` = ? THEN `o`.`amount` END)",
    );
  });

  it("countIf / sumIf accept .as() for predictable result keys", () => {
    const agg = new ColumnExpression("u.id")
      .countIf(activeStatus())
      .as("active_users");
    expect(agg.getAlias()).toBe("active_users");
  });
});

// ── End-to-end SELECT integration through SelectQueryBuilder ──

@Entity()
class FilterUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 50 })
  status!: string;
}

type DbType = "mysql" | "postgresql" | "sqlite";

function createMockEm(dbType: DbType): EntityManager {
  const resolver = new RelationMetadataResolver();
  const wrap = (col: string): string =>
    dbType === "mysql"
      ? `\`${col.replace(/`/g, "``")}\``
      : `"${col.replace(/"/g, '""')}"`;
  return {
    wrap,
    wrapTable: (t: string) => wrap(t),
    resolver,
    _ctx: {
      isMySqlFamily: () => dbType === "mysql",
      isPostgres: () => dbType === "postgresql",
      isSqlite: () => dbType === "sqlite",
      getDialect: () =>
        dbType === "mysql"
          ? "mysql"
          : dbType === "sqlite"
            ? "sqlite"
            : "postgresql",
    },
  } as unknown as EntityManager;
}

function createQb(dbType: DbType): SelectQueryBuilder<FilterUser> {
  const em = createMockEm(dbType);
  const qb = new SelectQueryBuilder<FilterUser>(FilterUser, "u", em);
  const resolver = (em as unknown as { resolver: RelationMetadataResolver })
    .resolver;
  const meta = resolver.resolveEntityMetadata(FilterUser);
  if (meta) {
    const map = new Map<string, string>();
    for (const c of meta.columns) {
      const key = (c as { propertyKey?: string }).propertyKey ?? c.name!;
      map.set(key, c.name!);
    }
    qb.setPropertyToColumnMap(map);
  }
  const dialectName = dbType === "postgresql" ? "postgres" : dbType;
  qb.setDialectExpression(createDialectExpression(dialectName));
  return qb;
}

describe("Aggregate FILTER in SELECT via SelectQueryBuilder", () => {
  it("emits native FILTER + alias on PostgreSQL", () => {
    const qb = createQb("postgresql");
    const u = qAlias(FilterUser, "u");
    qb.select([
      u.id.count().filter(u.status.eq("active")).as("active"),
      u.id.count().filter(u.status.eq("churned")).as("churned"),
    ]);
    const { text, values } = qb.getSql();
    expect(text).toContain(
      'COUNT("u"."id") FILTER (WHERE "u"."status" = ?) AS "active"',
    );
    expect(text).toContain(
      'COUNT("u"."id") FILTER (WHERE "u"."status" = ?) AS "churned"',
    );
    expect(values).toEqual(["active", "churned"]);
  });

  it("emits the CASE rewrite + alias on MySQL", () => {
    const qb = createQb("mysql");
    const u = qAlias(FilterUser, "u");
    qb.select([u.id.countIf(u.status.eq("active")).as("active")]);
    const { text, values } = qb.getSql();
    expect(text).toContain(
      "COUNT(CASE WHEN `u`.`status` = ? THEN `u`.`id` END) AS `active`",
    );
    expect(values).toEqual(["active"]);
  });

  it("preserves filter bindings through addSelect()", () => {
    const qb = createQb("postgresql");
    const u = qAlias(FilterUser, "u");
    qb.select(["id"]).addSelect(
      u.id.count().filter(u.status.eq("active")).as("active"),
    );
    const { text, values } = qb.getSql();
    expect(text).toContain(
      'COUNT("u"."id") FILTER (WHERE "u"."status" = ?) AS "active"',
    );
    expect(values).toEqual(["active"]);
  });
});
