import "reflect-metadata";
import { SelectQueryBuilder, qAlias } from "../../src/core/SelectQueryBuilder";
import { Entity, PrimaryGeneratedColumn, Column } from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { createDialectExpression } from "../../src/dialects/DialectExpression";
import { Expressions } from "../../src/core/expressions/LogicalCondition";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";

@Entity()
class Issue {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "int" })
  projectId!: number;

  @Column({ type: "varchar", length: 32 })
  status!: string;

  @Column({ type: "datetime", nullable: true })
  completedAt!: Date | null;

  @Column({ type: "datetime" })
  createdAt!: Date;

  @Column({ type: "datetime", nullable: true })
  deletedAt!: Date | null;
}

type DbType = "mysql" | "postgresql" | "sqlite";

function createMockEm(dbType: DbType = "postgresql"): EntityManager {
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
        dbType === "mysql"
          ? "mysql"
          : dbType === "sqlite"
            ? "sqlite"
            : "postgresql",
    },
  } as unknown as EntityManager;
}

function createQb(dbType: DbType = "postgresql") {
  const em = createMockEm(dbType);
  const qb = new SelectQueryBuilder<Issue>(Issue, "i", em);
  const resolver = (em as any).resolver as RelationMetadataResolver;
  const meta = resolver.resolveEntityMetadata(Issue);
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

describe("OrderedSetAggregate × SelectQueryBuilder integration", () => {
  it("renders percentile_cont in SELECT against an entity (PostgreSQL)", () => {
    const qb = createQb("postgresql");
    const i = qAlias(Issue, "i");
    qb.select([Expressions.percentileCont(0.5, i.id).as("p50")]);
    const { text, values } = qb.getSql();
    expect(text).toContain(
      `percentile_cont(?) WITHIN GROUP (ORDER BY "i"."id") AS "p50"`,
    );
    expect(values).toEqual([0.5]);
  });

  it("renders multiple percentiles and a count together", () => {
    const qb = createQb("postgresql");
    const i = qAlias(Issue, "i");
    qb.select([
      Expressions.percentileCont(0.5, i.id).as("p50"),
      Expressions.percentileCont(0.95, i.id).as("p95"),
      i.id.count().as("sampleSize"),
    ]);
    const { text, values } = qb.getSql();
    expect(text).toContain(
      `percentile_cont(?) WITHIN GROUP (ORDER BY "i"."id") AS "p50"`,
    );
    expect(text).toContain(
      `percentile_cont(?) WITHIN GROUP (ORDER BY "i"."id") AS "p95"`,
    );
    expect(text).toContain(`COUNT("i"."id") AS "sampleSize"`);
    expect(values).toEqual([0.5, 0.95]);
  });

  it("composes with a ScalarExpression cycle-time order target", () => {
    const qb = createQb("postgresql");
    const i = qAlias(Issue, "i");
    const cycleHours = Expressions.dateDiff(
      i.completedAt,
      i.createdAt,
      "second",
    )
      .floatValue()
      .div(3600);

    qb.select([Expressions.percentileCont(0.5, cycleHours).as("p50")]);
    const { text, values } = qb.getSql();
    // PG uses EXTRACT(EPOCH FROM (a - b)) for second-level dateDiff
    expect(text).toContain("percentile_cont(");
    expect(text).toContain("WITHIN GROUP (ORDER BY");
    expect(text).toContain("EXTRACT");
    expect(text).toContain(`AS "p50"`);
    // Fraction + the float-cast divisor 3600 are bound parameters
    expect(values).toEqual(expect.arrayContaining([0.5, 3600]));
  });

  it("rejects the same builder shape on MySQL with UNSUPPORTED_OPERATION", () => {
    const qb = createQb("mysql");
    const i = qAlias(Issue, "i");
    // The AliasedExpression renderer runs eagerly inside select() so the
    // dialect guard fires at projection-binding time, not at build time.
    try {
      qb.select([Expressions.percentileCont(0.5, i.id).as("p50")]);
      fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(OrmError);
      expect((e as OrmError).code).toBe(OrmErrorCode.UNSUPPORTED_OPERATION);
      expect((e as OrmError).message).toMatch(/PostgreSQL/);
    }
  });

  it("addSelect(AliasedExpression) accepts a percentile aggregate", () => {
    const qb = createQb("postgresql");
    const i = qAlias(Issue, "i");
    qb.select(["id"]);
    qb.addSelect(Expressions.percentileCont(0.5, i.id).as("p50"));
    const { text } = qb.getSql();
    expect(text).toContain(`"i"."id"`);
    expect(text).toContain(
      `percentile_cont(?) WITHIN GROUP (ORDER BY "i"."id") AS "p50"`,
    );
  });

  it("mode() renders without a fraction", () => {
    const qb = createQb("postgresql");
    const i = qAlias(Issue, "i");
    qb.select([Expressions.mode(i.status).as("most_common_status")]);
    const { text, values } = qb.getSql();
    expect(text).toContain(
      `mode() WITHIN GROUP (ORDER BY "i"."status") AS "most_common_status"`,
    );
    expect(values).toEqual([]);
  });

  it("WHERE chain alongside percentile aggregate composes correctly", () => {
    const qb = createQb("postgresql");
    const i = qAlias(Issue, "i");
    qb.select([
      Expressions.percentileCont(0.95, i.id).as("p95"),
      i.id.count().as("sampleSize"),
    ])
      .where(i.projectId.eq(42))
      .andWhere(i.status.eq("DONE"))
      .andWhere(i.deletedAt.isNull());
    const { text, values } = qb.getSql();
    expect(text).toContain(`WHERE "i"."projectId" = ?`);
    expect(text).toContain(`AND "i"."status" = ?`);
    expect(text).toContain(`AND "i"."deletedAt" IS NULL`);
    expect(text).toContain(
      `percentile_cont(?) WITHIN GROUP (ORDER BY "i"."id") AS "p95"`,
    );
    // 0.95 first (SELECT list), then where values
    expect(values[0]).toBe(0.95);
    expect(values).toContain(42);
    expect(values).toContain("DONE");
  });
});
