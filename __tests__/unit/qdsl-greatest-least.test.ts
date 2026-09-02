/**
 * Unit tests for the row-wise `greatest()` / `least()` scalar expressions.
 *
 * The interesting part is dialect divergence: SQLite spells the row-wise
 * maximum `MAX(a, b)` — the multi-argument scalar function, not the aggregate
 * — while PostgreSQL and MySQL spell it `GREATEST(a, b)`.
 */

import "reflect-metadata";
import { SelectQueryBuilder, qAlias } from "../../src/core/SelectQueryBuilder";
import { Entity, PrimaryGeneratedColumn, Column } from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { createDialectExpression } from "../../src/dialects/DialectExpression";
import {
  greatest,
  least,
} from "../../src/core/expressions/ComparisonExpression";
import { coalesce } from "../../src/core/expressions/NullishExpression";
import {
  ScalarExpression,
  isScalarExpression,
} from "../../src/core/expressions/ScalarExpression";

@Entity()
class Reading {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "int" })
  listPrice!: number;

  @Column({ type: "int", nullable: true })
  promoPrice!: number;

  @Column({ type: "int" })
  floorPrice!: number;
}

type DbType = "mysql" | "postgresql" | "sqlite";

function createMockEm(dbType: DbType) {
  const resolver = new RelationMetadataResolver();
  const wrap = (col: string) =>
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
        dbType === "mysql" ? "mysql" : dbType === "sqlite" ? "sqlite" : "postgresql",
    },
  } as unknown as EntityManager;
}

function createQb(dbType: DbType) {
  const em = createMockEm(dbType);
  const qb = new SelectQueryBuilder<Reading>(Reading, "r", em);
  const resolver = (em as any).resolver as RelationMetadataResolver;
  const meta = resolver.resolveEntityMetadata(Reading);
  if (meta) {
    const map = new Map<string, string>();
    for (const c of meta.columns) {
      map.set((c as any).propertyKey ?? c.name!, c.name!);
    }
    qb.setPropertyToColumnMap(map);
  }
  qb.setDialectExpression(
    createDialectExpression(dbType === "postgresql" ? "postgres" : dbType),
  );
  return qb;
}

describe("greatest() / least()", () => {
  it("returns a ScalarExpression", () => {
    const r = qAlias(Reading, "r");
    const expr = greatest(r.listPrice, r.promoPrice);
    expect(isScalarExpression(expr)).toBe(true);
    expect(expr).toBeInstanceOf(ScalarExpression);
  });

  it("requires at least two arguments", () => {
    const r = qAlias(Reading, "r");
    expect(() => greatest(r.listPrice)).toThrow(/at least 2 arguments/);
    expect(() => least(r.listPrice)).toThrow(/at least 2 arguments/);
  });

  it.each([
    ["postgresql", 'GREATEST("r"."listPrice", "r"."promoPrice")'],
    ["mysql", "GREATEST(`r`.`listPrice`, `r`.`promoPrice`)"],
    ["sqlite", 'MAX("r"."listPrice", "r"."promoPrice")'],
  ] as const)("renders greatest() for %s", (dbType, expected) => {
    const r = qAlias(Reading, "r");
    const qb = createQb(dbType);
    qb.select([greatest(r.listPrice, r.promoPrice).as("top")]);
    expect(qb.getSql().text).toContain(expected);
  });

  it.each([
    ["postgresql", 'LEAST("r"."listPrice", "r"."promoPrice")'],
    ["mysql", "LEAST(`r`.`listPrice`, `r`.`promoPrice`)"],
    ["sqlite", 'MIN("r"."listPrice", "r"."promoPrice")'],
  ] as const)("renders least() for %s", (dbType, expected) => {
    const r = qAlias(Reading, "r");
    const qb = createQb(dbType);
    qb.select([least(r.listPrice, r.promoPrice).as("bottom")]);
    expect(qb.getSql().text).toContain(expected);
  });

  it("binds plain values as parameters", () => {
    const r = qAlias(Reading, "r");
    const qb = createQb("postgresql");
    qb.select([greatest(r.listPrice, 100).as("top")]);
    const { text, values } = qb.getSql();
    expect(text).toContain('GREATEST("r"."listPrice", ?)');
    expect(values).toContain(100);
  });

  it("takes more than two arguments", () => {
    const r = qAlias(Reading, "r");
    const qb = createQb("postgresql");
    qb.select([
      greatest(r.listPrice, r.promoPrice, r.floorPrice).as("top"),
    ]);
    expect(qb.getSql().text).toContain(
      'GREATEST("r"."listPrice", "r"."promoPrice", "r"."floorPrice")',
    );
  });

  it("nests inside and around other scalar expressions", () => {
    const r = qAlias(Reading, "r");
    const qb = createQb("postgresql");
    qb.select([
      greatest(coalesce(r.promoPrice, 0), r.floorPrice).mul(2).as("doubled"),
    ]);
    expect(qb.getSql().text).toContain(
      'GREATEST(COALESCE("r"."promoPrice", ?), "r"."floorPrice")',
    );
  });

  it("is comparable, so it can filter a query", () => {
    const r = qAlias(Reading, "r");
    const qb = createQb("postgresql");
    qb.where(greatest(r.listPrice, r.promoPrice).gt(500));
    const { text, values } = qb.getSql();
    expect(text).toContain('GREATEST("r"."listPrice", "r"."promoPrice") >');
    expect(values).toContain(500);
  });

  it("needs a dialect to render", () => {
    const r = qAlias(Reading, "r");
    const expr = greatest(r.listPrice, r.promoPrice);
    expect(() => expr.renderer((ref) => ref, undefined)).toThrow(
      /requires a DialectExpression/,
    );
  });
});
