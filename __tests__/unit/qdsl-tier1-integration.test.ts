import "reflect-metadata";
import { SelectQueryBuilder, qAlias } from "../../src/core/SelectQueryBuilder";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
} from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { createDialectExpression } from "../../src/dialects/DialectExpression";
import { Expressions } from "../../src/core/expressions/LogicalCondition";

@Entity()
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  name!: string;

  @Column({ type: "varchar", length: 50 })
  status!: string;

  @Column({ type: "int" })
  age!: number;

  @Column({ type: "int" })
  departmentId!: number;

  @Column({ type: "varchar", length: 50 })
  role!: string;

  @Column({ type: "datetime", nullable: true })
  deletedAt!: Date | null;

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

describe("SelectQueryBuilder ORDER BY with OrderExpression (Tier 1)", () => {
  it("orderBy(u.col.desc()) replaces prior ordering", () => {
    const qb = createQb();
    const u = qAlias(User, "u");
    qb.addOrderBy("u.name", "ASC"); // seed
    qb.orderBy(u.createdAt.desc());
    const { text } = qb.getSql();
    expect(text).toMatch(/ORDER BY "u"\."createdAt" DESC/);
    // Should not still contain the name ordering
    expect(text).not.toContain(`"u"."name" ASC`);
  });

  it("addOrderBy(u.col.asc()) appends without replacing", () => {
    const qb = createQb();
    const u = qAlias(User, "u");
    qb.addOrderBy(u.createdAt.desc()).addOrderBy(u.name.asc());
    const { text } = qb.getSql();
    expect(text).toMatch(/"u"\."createdAt" DESC, "u"\."name" ASC/);
  });

  describe("NULLS FIRST / NULLS LAST — PostgreSQL native", () => {
    it("emits NULLS LAST natively", () => {
      const qb = createQb("postgresql");
      const u = qAlias(User, "u");
      qb.orderBy(u.deletedAt.desc().nullsLast());
      const { text } = qb.getSql();
      expect(text).toContain(`NULLS LAST`);
    });

    it("emits NULLS FIRST natively", () => {
      const qb = createQb("postgresql");
      const u = qAlias(User, "u");
      qb.orderBy(u.deletedAt.asc().nullsFirst());
      const { text } = qb.getSql();
      expect(text).toContain(`NULLS FIRST`);
    });
  });

  describe("NULLS FIRST / NULLS LAST — SQLite native", () => {
    it("emits NULLS LAST natively", () => {
      const qb = createQb("sqlite");
      const u = qAlias(User, "u");
      qb.orderBy(u.deletedAt.desc().nullsLast());
      const { text } = qb.getSql();
      expect(text).toContain(`NULLS LAST`);
    });
  });

  describe("MySQL NULLS emulation", () => {
    it("ASC + NULLS LAST emulates with IS NULL ordering prefix", () => {
      // MySQL default on ASC: NULLs first. User wants LAST → need prefix.
      const qb = createQb("mysql");
      const u = qAlias(User, "u");
      qb.orderBy(u.deletedAt.asc().nullsLast());
      const { text } = qb.getSql();
      expect(text).toContain("IS NULL");
      expect(text).not.toContain("NULLS");
    });

    it("DESC + NULLS LAST uses default (no emulation needed)", () => {
      // MySQL default on DESC: NULLs last. User wants LAST → already satisfied.
      const qb = createQb("mysql");
      const u = qAlias(User, "u");
      qb.orderBy(u.deletedAt.desc().nullsLast());
      const { text } = qb.getSql();
      expect(text).not.toContain("IS NULL");
      expect(text).toMatch(/ORDER BY `u`\.`deletedAt` DESC/);
    });

    it("DESC + NULLS FIRST emulates with IS NULL ordering prefix", () => {
      // MySQL default on DESC: NULLs last. User wants FIRST → need prefix.
      const qb = createQb("mysql");
      const u = qAlias(User, "u");
      qb.orderBy(u.deletedAt.desc().nullsFirst());
      const { text } = qb.getSql();
      expect(text).toContain("IS NULL");
    });

    it("ASC + NULLS FIRST uses default (no emulation needed)", () => {
      const qb = createQb("mysql");
      const u = qAlias(User, "u");
      qb.orderBy(u.deletedAt.asc().nullsFirst());
      const { text } = qb.getSql();
      expect(text).not.toContain("IS NULL");
    });
  });

  it("preserves existing orderBy({ prop: 'ASC' }) object form", () => {
    const qb = createQb();
    qb.orderBy({ name: "DESC" });
    const { text } = qb.getSql();
    expect(text).toMatch(/ORDER BY "u"\."name" DESC/);
  });
});

describe("SelectQueryBuilder aggregates in SELECT/HAVING (Tier 1)", () => {
  describe("select(aggregate.as(...))", () => {
    it("renders SELECT COUNT(col) AS alias", () => {
      const qb = createQb();
      const u = qAlias(User, "u");
      qb.select(u.id.count().as("total"));
      const { text } = qb.getSql();
      expect(text).toContain(`COUNT("u"."id") AS "total"`);
    });

    it("renders SUM/AVG/MIN/MAX", () => {
      const qb = createQb();
      const u = qAlias(User, "u");
      qb.select([
        u.age.sum().as("total_age"),
        u.age.avg().as("avg_age"),
        u.age.min().as("min_age"),
        u.age.max().as("max_age"),
      ]);
      const { text } = qb.getSql();
      expect(text).toContain(`SUM("u"."age") AS "total_age"`);
      expect(text).toContain(`AVG("u"."age") AS "avg_age"`);
      expect(text).toContain(`MIN("u"."age") AS "min_age"`);
      expect(text).toContain(`MAX("u"."age") AS "max_age"`);
    });

    it("COUNT(DISTINCT col) via countDistinct()", () => {
      const qb = createQb();
      const u = qAlias(User, "u");
      qb.select(u.role.countDistinct().as("distinct_roles"));
      const { text } = qb.getSql();
      expect(text).toContain(`COUNT(DISTINCT "u"."role") AS "distinct_roles"`);
    });

    it("uses deterministic default alias when .as() omitted", () => {
      const qb = createQb();
      const u = qAlias(User, "u");
      qb.select(u.id.count());
      const { text } = qb.getSql();
      expect(text).toContain(`COUNT("u"."id") AS "agg_count_id"`);
    });

    it("addSelect(aggregate) appends to existing columns", () => {
      const qb = createQb();
      const u = qAlias(User, "u");
      qb.select(["id", "name"]).addSelect(u.id.count().as("total"));
      const { text } = qb.getSql();
      expect(text).toContain(`"u"."id"`);
      expect(text).toContain(`"u"."name"`);
      expect(text).toContain(`COUNT("u"."id") AS "total"`);
    });
  });

  describe("having(aggregate.op(value))", () => {
    it("emits HAVING COUNT(col) > value with parameter binding", () => {
      const qb = createQb();
      const u = qAlias(User, "u");
      qb.select(u.id.count().as("total"))
        .groupBy(["u.departmentId"])
        .having(u.id.count().gt(10));
      const { text, values } = qb.getSql();
      expect(text).toContain(`GROUP BY "u"."departmentId"`);
      expect(text).toContain(`HAVING COUNT("u"."id") > ?`);
      expect(values).toEqual([10]);
    });

    it("accepts AggregateCondition chain .and()", () => {
      const qb = createQb();
      const u = qAlias(User, "u");
      const cnt = u.id.count();
      qb.select(cnt.as("total"))
        .groupBy(["u.departmentId"])
        .having(cnt.gt(10).and(cnt.lt(1000)));
      const { text, values } = qb.getSql();
      expect(text).toContain("HAVING");
      expect(text).toContain(`COUNT("u"."id") > ?`);
      expect(text).toContain(`COUNT("u"."id") < ?`);
      expect(values).toEqual([10, 1000]);
    });

    it("still accepts raw Sql in having() (back-compat)", () => {
      const qb = createQb();
      const u = qAlias(User, "u");
      qb.select(u.id.count().as("total"))
        .groupBy(["u.departmentId"])
        .having(u.id.count().gt(10).resolve((ref) => {
          const [a, c] = ref.split(".");
          return `"${a}"."${c}"`;
        }));
      const { text, values } = qb.getSql();
      expect(text).toContain("HAVING");
      expect(values).toEqual([10]);
    });
  });
});

describe("SelectQueryBuilder logical composition in WHERE (Tier 1)", () => {
  it("where(a.and(b)) emits parenthesized AND", () => {
    const qb = createQb();
    const u = qAlias(User, "u");
    qb.where(u.age.gte(18).and(u.status.eq("active")));
    const { text, values } = qb.getSql();
    expect(text).toMatch(/WHERE \("u"\."age" >= \?\s+AND\s+"u"\."status" = \?\)/);
    expect(values).toEqual([18, "active"]);
  });

  it("where(a.or(b)) emits parenthesized OR", () => {
    const qb = createQb();
    const u = qAlias(User, "u");
    qb.where(u.role.eq("admin").or(u.role.eq("owner")));
    const { text } = qb.getSql();
    expect(text).toMatch(/\("u"\."role" = \? OR "u"\."role" = \?\)/);
  });

  it("where(.not()) wraps in NOT", () => {
    const qb = createQb();
    const u = qAlias(User, "u");
    qb.where(u.deletedAt.isNull().not());
    const { text } = qb.getSql();
    expect(text).toContain(`NOT ("u"."deletedAt" IS NULL)`);
  });

  it("Expressions.and(a, b, c) works in where()", () => {
    const qb = createQb();
    const u = qAlias(User, "u");
    qb.where(
      Expressions.and(
        u.age.gte(18),
        u.status.eq("active"),
        u.role.neq("guest"),
      ),
    );
    const { text, values } = qb.getSql();
    expect(text).toMatch(/AND.*AND/);
    expect(values).toEqual([18, "active", "guest"]);
  });

  it("Expressions.or(and(a, b), c) preserves explicit grouping", () => {
    const qb = createQb();
    const u = qAlias(User, "u");
    qb.where(
      Expressions.or(
        Expressions.and(u.age.gte(18), u.status.eq("active")),
        u.role.eq("admin"),
      ),
    );
    const { text, values } = qb.getSql();
    expect(text).toContain("OR");
    expect(text).toContain("AND");
    expect(values).toEqual([18, "active", "admin"]);
  });

  it("andWhere chains LogicalCondition", () => {
    const qb = createQb();
    const u = qAlias(User, "u");
    qb.where(u.status.eq("active")).andWhere(u.role.eq("admin").or(u.role.eq("owner")));
    const { text } = qb.getSql();
    expect(text).toContain(`"u"."status" = ?`);
    expect(text).toContain(`("u"."role" = ? OR "u"."role" = ?)`);
  });

  it("WhereGroupBuilder accepts a LogicalCondition", () => {
    const qb = createQb();
    const u = qAlias(User, "u");
    qb.andWhereGroup((g) =>
      g.where(u.age.gte(18).and(u.status.eq("active"))),
    );
    const { text, values } = qb.getSql();
    expect(text).toContain("WHERE");
    expect(values).toEqual([18, "active"]);
  });
});

describe("Regression — existing ColumnCondition paths still work", () => {
  it("u.col.eq(value) still resolves without explicit dialect", () => {
    const qb = createQb();
    const u = qAlias(User, "u");
    qb.where(u.name.eq("Alice"));
    const { text, values } = qb.getSql();
    expect(text).toContain(`"u"."name" = ?`);
    expect(values).toEqual(["Alice"]);
  });

  it("u.col.in([...]) still resolves", () => {
    const qb = createQb();
    const u = qAlias(User, "u");
    qb.where(u.status.in(["active", "pending"]));
    const { text, values } = qb.getSql();
    expect(text).toContain(`"u"."status" IN`);
    expect(values).toEqual(["active", "pending"]);
  });
});
