import "reflect-metadata";
import {
  TupleExpression,
  TupleCondition,
  tuple,
  isTupleCondition,
} from "../../src/core/expressions/TupleExpression";
import { Expressions } from "../../src/core/expressions/LogicalCondition";
import {
  SelectQueryBuilder,
  qAlias,
} from "../../src/core/SelectQueryBuilder";
import { Entity, PrimaryColumn, Column } from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { createDialectExpression } from "../../src/dialects/DialectExpression";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";

/**
 * QueryDSL Tier 5.5 — `Expressions.tuple(...)` row-value comparison.
 *
 * Exact cross-dialect SQL is pinned in the golden-SQL suite; this file
 * covers the API contract (factory wiring, guards, type guard) and the
 * end-to-end WHERE integration through SelectQueryBuilder.
 */

const resolvePg = (ref: string): string => {
  if (!ref.includes(".")) return `"${ref}"`;
  const [alias, col] = ref.split(".");
  return `"${alias}"."${col}"`;
};

describe("Expressions.tuple() (QueryDSL Tier 5.5)", () => {
  describe("factory + type guard", () => {
    it("Expressions.tuple delegates to the tuple() factory", () => {
      const t = Expressions.tuple("u.a", "u.b");
      expect(t).toBeInstanceOf(TupleExpression);
      expect(t.columns).toEqual(["u.a", "u.b"]);
    });

    it("standalone tuple() builds a TupleExpression", () => {
      expect(tuple("u.a")).toBeInstanceOf(TupleExpression);
    });

    it(".in() / .notIn() / .eq() produce TupleConditions", () => {
      const t = Expressions.tuple("u.a", "u.b");
      expect(isTupleCondition(t.in([[1, 2]]))).toBe(true);
      expect(isTupleCondition(t.notIn([[1, 2]]))).toBe(true);
      expect(isTupleCondition(t.eq([1, 2]))).toBe(true);
    });

    it("isTupleCondition rejects non-conditions", () => {
      expect(isTupleCondition(null)).toBe(false);
      expect(isTupleCondition({})).toBe(false);
      expect(isTupleCondition(Expressions.tuple("u.a"))).toBe(false);
    });
  });

  describe("guards", () => {
    it("throws INVALID_QUERY on zero columns", () => {
      let caught: unknown;
      try {
        new TupleExpression([]);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(OrmError);
      expect((caught as OrmError).code).toBe(OrmErrorCode.INVALID_QUERY);
    });

    it("throws INVALID_QUERY on an arity mismatch", () => {
      expect(() =>
        Expressions.tuple("u.a", "u.b").in([[1, 2], [3]]),
      ).toThrow(OrmError);
    });

    it("throws when .eq() receives anything but one row", () => {
      // .eq() always wraps a single row, so a wrong-arity row trips arity.
      expect(() => Expressions.tuple("u.a", "u.b").eq([1])).toThrow(OrmError);
    });
  });

  describe("rendering", () => {
    it("renders IN with bound value rows", () => {
      const out = Expressions.tuple("u.tenantId", "u.userId")
        .in([
          [1, "alice"],
          [2, "bob"],
        ])
        .resolve(resolvePg);
      expect(out.sql).toBe(
        '("u"."tenantId", "u"."userId") IN ((?, ?), (?, ?))',
      );
      expect(out.values).toEqual([1, "alice", 2, "bob"]);
    });

    it("renders equality against a single row", () => {
      const out = Expressions.tuple("u.a", "u.b").eq([1, 2]).resolve(resolvePg);
      expect(out.sql).toBe('("u"."a", "u"."b") = (?, ?)');
      expect(out.values).toEqual([1, 2]);
    });
  });
});

// ── End-to-end WHERE integration through SelectQueryBuilder ──

@Entity()
class Membership {
  @PrimaryColumn({ type: "int" })
  tenantId!: number;

  @PrimaryColumn({ type: "int" })
  userId!: number;

  @Column({ type: "varchar", length: 50 })
  role!: string;
}

function createMockEm(): EntityManager {
  const resolver = new RelationMetadataResolver();
  const wrap = (col: string): string => `"${col.replace(/"/g, '""')}"`;
  return {
    wrap,
    wrapTable: (t: string) => wrap(t),
    resolver,
    _ctx: {
      isMySqlFamily: () => false,
      isPostgres: () => true,
      isSqlite: () => false,
      getDialect: () => "postgresql",
    },
  } as unknown as EntityManager;
}

function createQb(): SelectQueryBuilder<Membership> {
  const em = createMockEm();
  const qb = new SelectQueryBuilder<Membership>(Membership, "u", em);
  const resolver = (em as unknown as { resolver: RelationMetadataResolver })
    .resolver;
  const meta = resolver.resolveEntityMetadata(Membership);
  if (meta) {
    const map = new Map<string, string>();
    for (const c of meta.columns) {
      const key = (c as { propertyKey?: string }).propertyKey ?? c.name!;
      map.set(key, c.name!);
    }
    qb.setPropertyToColumnMap(map);
  }
  qb.setDialectExpression(createDialectExpression("postgres"));
  return qb;
}

describe("tuple IN through SelectQueryBuilder.where()", () => {
  it("filters composite PKs with a single row-value predicate", () => {
    const qb = createQb();
    const u = qAlias(Membership, "u");
    qb.where(
      Expressions.tuple(u.tenantId, u.userId).in([
        [1, 10],
        [2, 20],
      ]),
    );
    const { text, values } = qb.getSql();
    expect(text).toContain(
      '("u"."tenantId", "u"."userId") IN ((?, ?), (?, ?))',
    );
    expect(values).toEqual([1, 10, 2, 20]);
  });
});
