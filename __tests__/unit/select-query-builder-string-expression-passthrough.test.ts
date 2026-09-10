/**
 * One string rule for every expression-capable string slot on
 * SelectQueryBuilder — `selectRaw()`, `addSelect()`, `groupBy()`,
 * `addOrderBy()` — and the window `partitionBy()`:
 *
 *  - a bare `prop` / `alias.prop` is resolved through the alias registry
 *    (property → DB column, identifier quoting);
 *  - anything carrying SQL syntax (`UPPER(x)`, `x + 1`, `COUNT(*)`) passes
 *    through verbatim.
 *
 * Until this fix only `selectRaw()` applied the rule. The other slots routed
 * every string through the column resolver, so `groupBy(["UPPER(grp)"])`
 * rendered as `` `r`.`UPPER(grp)` `` and surfaced as a driver "no such
 * column" error. The rule now lives in one place (`bareColumnRef.ts`) so the
 * slots cannot drift apart again.
 */
import "reflect-metadata";
import {
  SelectQueryBuilder,
  ColumnExpression,
} from "../../src/core/SelectQueryBuilder";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
} from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { rowNumber } from "../../src/core/expressions/WindowFunctions";
import { createDialectExpression } from "../../src/dialects/DialectExpression";
import {
  isBareColumnRef,
  resolveColumnOrExpression,
} from "../../src/core/expressions/bareColumnRef";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";
import sql from "../../src/utils/sqlTag";

@Entity({ name: "category" })
class Cat {
  @PrimaryGeneratedColumn({ name: "CTGR_SQ" })
  id!: number;
  @Column({ type: "varchar", length: 255, name: "CTGR_NM" })
  name!: string;
  @Column({ type: "int", name: "LFT_NO" })
  left!: number;
}

function createMockEm() {
  const resolver = new RelationMetadataResolver();
  const wrap = (col: string) => `\`${col.replace(/`/g, "``")}\``;
  return {
    wrap,
    wrapTable: (t: string) => wrap(t),
    resolver,
    _ctx: {
      isMySqlFamily: () => true,
      isPostgres: () => false,
      isSqlite: () => false,
      getDialect: () => "mysql",
    },
  } as unknown as EntityManager;
}

function newQb() {
  const qb = new SelectQueryBuilder<Cat>(Cat, "node", createMockEm());
  // Custom DB names make the bare-reference path observable: a resolved
  // token reads `node`.`CTGR_NM`, a verbatim one keeps whatever was typed.
  qb.setPropertyToColumnMap(
    new Map([
      ["id", "CTGR_SQ"],
      ["name", "CTGR_NM"],
      ["left", "LFT_NO"],
    ]),
  );
  return qb;
}

function expectInvalidQuery(fn: () => unknown, clause: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(OrmError);
  expect((caught as OrmError).code).toBe(OrmErrorCode.INVALID_QUERY);
  expect((caught as Error).message).toContain(`${clause}: empty string entry`);
}

describe("groupBy() string entries", () => {
  it("emits a function-call expression verbatim instead of quoting it as one identifier", () => {
    const { text } = newQb().groupBy(["UPPER(CTGR_NM)"]).getSql();
    expect(text).toContain("GROUP BY UPPER(CTGR_NM)");
    expect(text).not.toContain("`node`.`UPPER(CTGR_NM)`");
  });

  it("passes DATE(), arithmetic and CASE expressions through untouched", () => {
    const { text } = newQb()
      .groupBy([
        "DATE(CRTD_AT)",
        "LFT_NO + 1",
        "CASE WHEN LFT_NO > 1 THEN 'x' ELSE 'y' END",
      ])
      .getSql();
    expect(text).toMatch(
      /GROUP BY DATE\(CRTD_AT\),\s*LFT_NO \+ 1,\s*CASE WHEN LFT_NO > 1 THEN 'x' ELSE 'y' END/,
    );
    expect(text).not.toContain("`node`.`DATE");
  });

  it("still resolves bare property and alias.property references next to an expression", () => {
    const { text } = newQb()
      .innerJoin(Cat, "parent", (j) => j.on("node.left", "=", "parent.left"))
      .groupBy(["name", "parent.name", "UPPER(CTGR_NM)"])
      .getSql();
    expect(text).toMatch(
      /GROUP BY `node`\.`CTGR_NM`,\s*`parent`\.`CTGR_NM`,\s*UPPER\(CTGR_NM\)/,
    );
  });

  it("trims padding: a padded bare ref resolves, a padded expression is emitted trimmed", () => {
    const { text } = newQb().groupBy(["  name  ", "  LFT_NO + 1  "]).getSql();
    expect(text).toMatch(/GROUP BY `node`\.`CTGR_NM`,\s*LFT_NO \+ 1(\s|$)/);
    expect(text).not.toContain("` name `");
  });

  it("keeps the bindings of a Sql fragment listed next to a verbatim expression", () => {
    const { text, values } = newQb()
      .groupBy(["UPPER(CTGR_NM)", sql`LFT_NO % ${2}`])
      .getSql();
    expect(text).toMatch(/GROUP BY UPPER\(CTGR_NM\),\s*LFT_NO % \?/);
    expect(values).toEqual([2]);
  });

  it("treats a bare SELECT-list alias as a column reference; a Sql fragment is the route for an alias", () => {
    // Contract pin: a bare identifier is always a column of the FROM alias
    // (or `alias.prop`) — the builder cannot tell a select alias from a DB
    // column name, so it never guesses.
    const asColumn = newQb()
      .selectRaw(["UPPER(CTGR_NM) AS ug"])
      .groupBy(["ug"])
      .getSql().text;
    expect(asColumn).toContain("GROUP BY `node`.`ug`");

    const asFragment = newQb()
      .selectRaw(["UPPER(CTGR_NM) AS ug"])
      .groupBy([sql`ug`])
      .getSql().text;
    expect(asFragment).toContain("GROUP BY ug");
  });

  it("rejects an empty or blank string entry up front with INVALID_QUERY", () => {
    expectInvalidQuery(() => newQb().groupBy([""]), "groupBy");
    expectInvalidQuery(() => newQb().groupBy(["   "]), "groupBy");
  });
});

describe("addOrderBy() string entries", () => {
  it("emits an expression verbatim with its direction", () => {
    const { text } = newQb().addOrderBy("UPPER(CTGR_NM)", "DESC").getSql();
    expect(text).toContain("ORDER BY UPPER(CTGR_NM) DESC");
    expect(text).not.toContain("`node`.`UPPER");
  });

  it("still resolves bare property and alias.property references", () => {
    const { text } = newQb()
      .innerJoin(Cat, "parent", (j) => j.on("node.left", "=", "parent.left"))
      .addOrderBy("name", "ASC")
      .addOrderBy("parent.left", "DESC")
      .getSql();
    expect(text).toMatch(
      /ORDER BY `node`\.`CTGR_NM` ASC,\s*`parent`\.`LFT_NO` DESC/,
    );
  });

  it("rejects an empty string entry up front with INVALID_QUERY", () => {
    expectInvalidQuery(() => newQb().addOrderBy("", "ASC"), "addOrderBy");
  });
});

describe("addSelect() string entries", () => {
  it("emits an expression verbatim under its alias", () => {
    const { text } = newQb().addSelect("COUNT(*)", "total").getSql();
    expect(text).toContain("COUNT(*) AS `total`");
    expect(text).not.toContain("`node`.`COUNT");
  });

  it("still resolves a bare property reference", () => {
    const { text } = newQb().addSelect("name", "n").getSql();
    expect(text).toContain("`node`.`CTGR_NM` AS `n`");
  });

  it("rejects an empty string entry up front with INVALID_QUERY", () => {
    expectInvalidQuery(() => newQb().addSelect("", "x"), "addSelect");
  });
});

describe("selectRaw() keeps its rule and shares the implementation", () => {
  it("resolves a padded bare reference instead of quoting the padding", () => {
    const { text } = newQb().selectRaw(["  name  "]).getSql();
    expect(text).toContain("`node`.`CTGR_NM`");
    expect(text).not.toContain("` name `");
  });

  it("renders every token identically in SELECT and GROUP BY", () => {
    const tokens = [
      "name",
      "node.left",
      "UPPER(CTGR_NM)",
      "LFT_NO + 1",
      "COUNT(*)",
    ];
    for (const token of tokens) {
      const selected = newQb()
        .selectRaw([token])
        .getSql()
        .text.match(/^SELECT (.*?) FROM /)?.[1];
      const grouped = newQb()
        .groupBy([token])
        .getSql()
        .text.match(/GROUP BY (.*)$/)?.[1]
        ?.trim();
      expect(selected).toBeDefined();
      expect(grouped).toBe(selected);
    }
  });

  it("rejects an empty string entry up front with INVALID_QUERY", () => {
    expectInvalidQuery(() => newQb().selectRaw([""]), "selectRaw");
  });
});

describe("window partitionBy() string entries", () => {
  const pg = createDialectExpression("postgres");
  const resolvePg = (ref: string): string => {
    if (!ref.includes(".")) return `"${ref}"`;
    const [alias, col] = ref.split(".");
    return `"${alias}"."${col}"`;
  };

  it("emits an expression verbatim", () => {
    const built = rowNumber()
      .partitionBy("UPPER(grp_code)")
      .orderBy(new ColumnExpression("r.val").asc())
      .as("rn");
    const rendered = built.renderer(resolvePg, pg);
    expect(rendered.sql).toContain(
      `ROW_NUMBER() OVER (PARTITION BY UPPER(grp_code) ORDER BY "r"."val" ASC)`,
    );
  });

  it("still resolves a bare alias.prop string", () => {
    const built = rowNumber().partitionBy("r.grp").as("rn");
    expect(built.renderer(resolvePg, pg).sql).toContain(
      `PARTITION BY "r"."grp"`,
    );
  });

  it("rejects an empty string entry with INVALID_QUERY", () => {
    expectInvalidQuery(
      () => rowNumber().partitionBy("").as("rn").renderer(resolvePg, pg),
      "partitionBy",
    );
  });
});

describe("bareColumnRef helper", () => {
  it.each([
    ["name", true],
    ["u.firstName", true],
    ["_private1", true],
    ["  padded  ", true],
    ["COUNT(*)", false],
    ["UPPER(name)", false],
    ["a + 1", false],
    ["a.b.c", false],
    ['"quoted"', false],
    ["role WITH ROLLUP", false],
    ["1abc", false],
    ["*", false],
    ["", false],
  ])("isBareColumnRef(%p) → %p", (token, expected) => {
    expect(isBareColumnRef(token)).toBe(expected);
  });

  it("routes a bare ref through the resolver and emits an expression trimmed", () => {
    const resolve = (ref: string) => `<${ref}>`;
    expect(resolveColumnOrExpression("name", resolve, "x")).toBe("<name>");
    expect(resolveColumnOrExpression("  u.name ", resolve, "x")).toBe(
      "<u.name>",
    );
    expect(resolveColumnOrExpression(" UPPER(name) ", resolve, "x")).toBe(
      "UPPER(name)",
    );
  });
});
