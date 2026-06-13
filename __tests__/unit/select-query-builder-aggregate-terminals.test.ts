/**
 * SelectQueryBuilder aggregate / plan terminals: getSum/getAvg/getMin/getMax,
 * getExists and explain().
 *
 * These close the asymmetry with EntityManager's aggregate helpers
 * (count/sum/avg/min/max/exists) and explain(). The scalar aggregates must:
 *
 *  - emit `<FN>(<qualified, escaped column>) AS result` over the builder's
 *    current FROM / JOIN / WHERE source (reusing applyCountSource),
 *  - honor the soft-delete auto-filter and `withDeleted()`,
 *  - coerce driver-native numeric strings (PostgreSQL NUMERIC) to a number,
 *  - return 0 (never null) when no rows match — matching EntityManager.
 *
 * getExists is the `get`-prefixed alias of exists() (SELECT 1 ... LIMIT 1).
 * explain() returns the dialect-parsed ExplainResult for the built query.
 *
 * SQL text is asserted directly via a mock EM that records every query() call,
 * mirroring the existing SelectQueryBuilder unit-test harness.
 */
import "reflect-metadata";
import { SelectQueryBuilder } from "../../src/core/SelectQueryBuilder";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  DeletedAt,
  OneToMany,
  ManyToOne,
} from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";

@Entity()
class AggOrder {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "int" })
  amount!: number;

  @Column({ type: "varchar", length: 32 })
  status!: string;
}

@Entity()
class AggSoft {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "int" })
  amount!: number;

  @DeletedAt()
  deletedAt!: Date | null;
}

@Entity()
class AggParent {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "int" })
  amount!: number;

  @OneToMany(() => AggChild, { mappedBy: "parent" })
  children!: AggChild[];
}

@Entity()
class AggChild {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "int", nullable: true })
  parentId!: number | null;

  @ManyToOne(
    () => AggParent,
    (e: any) => e.parent,
  )
  parent!: AggParent | null;
}

interface MockOptions {
  dbType?: "mysql" | "postgresql";
  rows?: Record<string, unknown>[];
  driver?: unknown;
}

/**
 * Mock EM that records the SQL text of every query() call and returns a
 * configurable result set. `_ctx.getDriver()` is wired for explain().
 */
function createMockEm(opts: MockOptions = {}) {
  const dbType = opts.dbType ?? "mysql";
  const resolver = new RelationMetadataResolver();
  const wrap = (col: string) =>
    dbType === "mysql"
      ? `\`${col.replace(/`/g, "``")}\``
      : `"${col.replace(/"/g, '""')}"`;
  const calls: string[] = [];
  let rows: Record<string, unknown>[] = opts.rows ?? [];
  const em = {
    wrap,
    wrapTable: (t: string) => wrap(t),
    resolver,
    _ctx: {
      isMySqlFamily: () => dbType === "mysql",
      isPostgres: () => dbType === "postgresql",
      isSqlite: () => false,
      getDialect: () => (dbType === "mysql" ? "mysql" : "postgres"),
      getDriver: () => opts.driver,
    },
    async query<T>(built: any): Promise<T[]> {
      calls.push(String(built?.sql ?? built?.text ?? built));
      return rows as unknown as T[];
    },
    __calls: calls,
    __setRows(next: Record<string, unknown>[]) {
      rows = next;
    },
  } as unknown as EntityManager & {
    __calls: string[];
    __setRows: (next: Record<string, unknown>[]) => void;
  };
  return em;
}

describe("SelectQueryBuilder scalar aggregate terminals", () => {
  it("getSum emits SUM(<qualified column>) AS result and coerces the value", async () => {
    const em = createMockEm({ rows: [{ result: "42" }] });
    const qb = new SelectQueryBuilder<AggOrder>(AggOrder, "o", em);

    const total = await qb.getSum("amount");

    expect(total).toBe(42);
    const sqlText = em.__calls[0];
    expect(sqlText).toContain("SUM(`o`.`amount`)");
    expect(sqlText).toContain("AS `result`");
  });

  it("getAvg emits AVG(...)", async () => {
    const em = createMockEm({ rows: [{ result: 10 }] });
    const qb = new SelectQueryBuilder<AggOrder>(AggOrder, "o", em);

    const avg = await qb.getAvg("amount");

    expect(avg).toBe(10);
    expect(em.__calls[0]).toContain("AVG(`o`.`amount`)");
  });

  it("getMin emits MIN(...)", async () => {
    const em = createMockEm({ rows: [{ result: 3 }] });
    const qb = new SelectQueryBuilder<AggOrder>(AggOrder, "o", em);

    const min = await qb.getMin("amount");

    expect(min).toBe(3);
    expect(em.__calls[0]).toContain("MIN(`o`.`amount`)");
  });

  it("getMax emits MAX(...)", async () => {
    const em = createMockEm({ rows: [{ result: 99 }] });
    const qb = new SelectQueryBuilder<AggOrder>(AggOrder, "o", em);

    const max = await qb.getMax("amount");

    expect(max).toBe(99);
    expect(em.__calls[0]).toContain("MAX(`o`.`amount`)");
  });

  it("returns 0 (not null) when no rows match — matching EntityManager", async () => {
    const em = createMockEm({ rows: [] });
    const qb = new SelectQueryBuilder<AggOrder>(AggOrder, "o", em);

    expect(await qb.getSum("amount")).toBe(0);
  });

  it("returns 0 when the aggregate evaluates to NULL", async () => {
    const em = createMockEm({ rows: [{ result: null }] });
    const qb = new SelectQueryBuilder<AggOrder>(AggOrder, "o", em);

    expect(await qb.getMin("amount")).toBe(0);
  });

  it("coerces PostgreSQL NUMERIC strings to a JS number", async () => {
    const em = createMockEm({ dbType: "postgresql", rows: [{ result: "123.45" }] });
    const qb = new SelectQueryBuilder<AggOrder>(AggOrder, "o", em);

    const avg = await qb.getAvg("amount");

    expect(avg).toBeCloseTo(123.45);
    expect(typeof avg).toBe("number");
    // PostgreSQL identifiers are double-quoted.
    expect(em.__calls[0]).toContain('AVG("o"."amount")');
  });

  it("respects the builder's WHERE conditions", async () => {
    const em = createMockEm({ rows: [{ result: 7 }] });
    const qb = new SelectQueryBuilder<AggOrder>(AggOrder, "o", em);
    qb.where("status", "paid");

    await qb.getSum("amount");

    const sqlText = em.__calls[0];
    expect(sqlText).toContain("WHERE");
    expect(sqlText).toContain("`o`.`status`");
  });

  it("applies the soft-delete auto-filter for @DeletedAt entities", async () => {
    const em = createMockEm({ rows: [{ result: 0 }] });
    const qb = new SelectQueryBuilder<AggSoft>(AggSoft, "s", em);

    await qb.getSum("amount");

    expect(em.__calls[0]).toContain("IS NULL");
  });

  it("drops the soft-delete filter when withDeleted() is set", async () => {
    const em = createMockEm({ rows: [{ result: 0 }] });
    const qb = new SelectQueryBuilder<AggSoft>(AggSoft, "s", em);
    qb.withDeleted();

    await qb.getSum("amount");

    expect(em.__calls[0]).not.toContain("IS NULL");
  });

  it("does not mutate the builder's whereClauses", async () => {
    const em = createMockEm({ rows: [{ result: 1 }] });
    const qb = new SelectQueryBuilder<AggSoft>(AggSoft, "s", em);
    const before = (qb as any).whereClauses.length;

    await qb.getSum("amount");

    expect((qb as any).whereClauses.length).toBe(before);
  });
});

describe("SelectQueryBuilder scalar aggregates under a to-many *AndSelect join", () => {
  it("uses the plain direct form when no to-many joined selection is present (regression)", async () => {
    const em = createMockEm({ rows: [{ result: 100 }] });
    const qb = new SelectQueryBuilder<AggParent>(AggParent, "p", em);

    const total = await qb.getSum("amount");

    expect(total).toBe(100);
    const sqlText = em.__calls[0];
    // Direct path: plain SUM over the root, no distinct-root subquery wrapper.
    expect(sqlText).toContain("SUM(`p`.`amount`)");
    expect(sqlText).toContain("AS `result`");
    expect(sqlText).not.toContain("SELECT DISTINCT");
    expect(sqlText).not.toMatch(/FROM \(SELECT DISTINCT/);
  });

  it("wraps a SELECT DISTINCT root subquery so getSum is not inflated by joined children", async () => {
    // The to-many join multiplies root rows; the mock returns the de-inflated
    // result (100) the distinct-root subquery is meant to produce.
    const em = createMockEm({ rows: [{ result: 100 }] });
    const qb = new SelectQueryBuilder<AggParent>(AggParent, "p", em);
    qb.leftJoinRelationAndSelect("children", "c");

    const total = await qb.getSum("amount");

    expect(total).toBe(100);
    const sqlText = em.__calls[0];
    // Outer aggregate wraps the distinct-root subquery.
    expect(sqlText).toContain("SUM(`agg_val`)");
    expect(sqlText).toContain("AS `result`");
    expect(sqlText).toMatch(/FROM \(SELECT DISTINCT/);
    // Inner subquery selects DISTINCT root pk plus the aggregated column.
    expect(sqlText).toContain("SELECT DISTINCT `p`.`id`");
    expect(sqlText).toContain("`p`.`amount` AS `agg_val`");
    // The join is preserved inside the subquery.
    expect(sqlText).toContain("LEFT JOIN");
    // Outer source alias.
    expect(sqlText).toContain("AS `agg_src`");
  });

  it("applies the distinct-root wrapper to getMin/getMax/getAvg as well", async () => {
    for (const [method, fn] of [
      ["getMin", "MIN"],
      ["getMax", "MAX"],
      ["getAvg", "AVG"],
    ] as const) {
      const em = createMockEm({ rows: [{ result: 5 }] });
      const qb = new SelectQueryBuilder<AggParent>(AggParent, "p", em);
      qb.leftJoinRelationAndSelect("children", "c");

      const value = await (qb as any)[method]("amount");

      expect(value).toBe(5);
      const sqlText = em.__calls[0];
      expect(sqlText).toContain(`${fn}(\`agg_val\`)`);
      expect(sqlText).toMatch(/FROM \(SELECT DISTINCT/);
    }
  });
});

describe("SelectQueryBuilder.getExists()", () => {
  it("returns true when rows exist and emits SELECT 1 ... LIMIT 1", async () => {
    const em = createMockEm({ rows: [{ "1": 1 }] });
    const qb = new SelectQueryBuilder<AggOrder>(AggOrder, "o", em);

    const result = await qb.getExists();

    expect(result).toBe(true);
    const sqlText = em.__calls[0];
    expect(sqlText).toContain("SELECT 1");
    // The LIMIT value is parameterized (bound), so it renders as a placeholder.
    expect(sqlText).toContain("LIMIT ?");
  });

  it("returns false when no rows match", async () => {
    const em = createMockEm({ rows: [] });
    const qb = new SelectQueryBuilder<AggOrder>(AggOrder, "o", em);

    expect(await qb.getExists()).toBe(false);
  });
});

describe("SelectQueryBuilder.explain()", () => {
  it("prefixes the built query with EXPLAIN and returns a parsed plan (MySQL)", async () => {
    const driver = {
      supportsExplain: () => true,
      buildExplainSql: () => "EXPLAIN ",
    };
    const em = createMockEm({
      driver,
      rows: [
        {
          id: 1,
          select_type: "SIMPLE",
          table: "AggOrder",
          type: "ALL",
          possible_keys: null,
          key: null,
          rows: 5,
          filtered: 100,
        },
      ],
    });
    const qb = new SelectQueryBuilder<AggOrder>(AggOrder, "o", em);

    const plan = await qb.explain();

    expect(em.__calls[0].startsWith("EXPLAIN ")).toBe(true);
    expect(em.__calls[0]).toContain("SELECT");
    expect(plan.type).toBe("ALL");
    expect(plan.rows).toBe(5);
    expect(plan.cost).toBe(100);
    expect(plan.raw.length).toBe(1);
  });

  it("throws InvalidQueryError when the driver does not support EXPLAIN", async () => {
    const driver = {
      supportsExplain: () => false,
      buildExplainSql: () => "EXPLAIN ",
    };
    const em = createMockEm({ driver });
    const qb = new SelectQueryBuilder<AggOrder>(AggOrder, "o", em);

    await expect(qb.explain()).rejects.toThrow(/EXPLAIN is not supported/);
  });

  it("throws InvalidQueryError when no driver is available", async () => {
    const em = createMockEm({});
    const qb = new SelectQueryBuilder<AggOrder>(AggOrder, "o", em);

    await expect(qb.explain()).rejects.toThrow(/EXPLAIN is not supported/);
  });
});
