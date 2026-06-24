/**
 * Deferred aliased-projection rendering + selectRaw expression passthrough.
 *
 * Two QB fixes motivated by porting a nested-set tree (self-join + custom
 * column names) off raw SQL:
 *
 * 1. `select([alias.col.as(...)])` projections are rendered at BUILD time,
 *    not eagerly at select() call time — so a projection may reference a
 *    JOIN alias registered AFTER the select() call (forward reference).
 *    Eager resolution left such columns unqualified/unmapped.
 *
 * 2. `selectRaw([...])` only alias-qualifies BARE column refs (`prop` /
 *    `alias.prop`); raw SQL expressions (`COUNT(*)`, `MAX(p.views)`) pass
 *    through untouched instead of being mangled into `"alias"."COUNT(*)"`.
 */
import "reflect-metadata";
import { SelectQueryBuilder } from "../../src/core/SelectQueryBuilder";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
} from "../../src/decorators";
import { qAlias } from "../../src/core/SelectQueryBuilder";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";

@Entity({ name: "category" })
class TreeCat {
  @PrimaryGeneratedColumn({ name: "CTGR_SQ" })
  id!: number;
  @Column({ type: "varchar", length: 255, name: "CTGR_NM" })
  name!: string;
  @Column({ type: "int", name: "LFT_NO" })
  left!: number;
  @Column({ type: "int", name: "RGT_NO" })
  right!: number;
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
  const em = createMockEm();
  const qb = new SelectQueryBuilder<TreeCat>(TreeCat, "node", em);
  // Wire the root alias's property→column map (as EntityManager.createQueryBuilder does).
  qb.setPropertyToColumnMap(
    new Map([
      ["id", "CTGR_SQ"],
      ["name", "CTGR_NM"],
      ["left", "LFT_NO"],
      ["right", "RGT_NO"],
    ]),
  );
  return qb;
}

describe("deferred aliased projection (forward reference to JOIN alias)", () => {
  it("resolves a joined alias's custom column when select() PRECEDES innerJoin()", () => {
    const node = qAlias(TreeCat, "node");
    const parent = qAlias(TreeCat, "parent");

    const qb = newQb()
      .select([parent.name.as("name")]) // referenced before "parent" is registered
      .innerJoin(TreeCat, "parent", (j) =>
        j.onBetween("node.left", "parent.left", "parent.right"),
      )
      .where(node.name.eq("A1"));

    const { text } = qb.getSql();
    // The forward-referenced column must be mapped + qualified, not left raw.
    expect(text).toContain("`parent`.`CTGR_NM` AS `name`");
    expect(text).not.toContain("`parent`.`name`");
  });

  it("produces identical SQL whether select() comes before or after the join", () => {
    const parent = qAlias(TreeCat, "parent");

    const before = newQb()
      .select([parent.name.as("name")])
      .innerJoin(TreeCat, "parent", (j) =>
        j.onBetween("node.left", "parent.left", "parent.right"),
      )
      .getSql().text;

    const after = newQb()
      .innerJoin(TreeCat, "parent", (j) =>
        j.onBetween("node.left", "parent.left", "parent.right"),
      )
      .select([parent.name.as("name")])
      .getSql().text;

    expect(before).toBe(after);
  });

  it("still maps the root alias's own custom columns + aggregate arithmetic", () => {
    const node = qAlias(TreeCat, "node");
    const qb = newQb()
      .select([
        node.id.as("id"),
        node.name.count().sub(1).as("depth"),
      ])
      .innerJoin(TreeCat, "parent", (j) =>
        j.onBetween("node.left", "parent.left", "parent.right"),
      )
      .groupBy(["node.left"]);

    const { text } = qb.getSql();
    expect(text).toContain("`node`.`CTGR_SQ` AS `id`");
    expect(text).toMatch(/COUNT\(`node`\.`CTGR_NM`\)\s*-\s*\?\)?\s*AS `depth`/);
    expect(text).toContain("GROUP BY `node`.`LFT_NO`");
  });
});

describe("selectRaw expression passthrough", () => {
  it("passes a COUNT(*) expression through raw (not alias-qualified)", () => {
    const qb = newQb().selectRaw(["COUNT(*)"]);
    const { text } = qb.getSql();
    expect(text).toContain("COUNT(*)");
    expect(text).not.toContain("`COUNT(*)`");
    expect(text).not.toContain("`node`.`COUNT");
  });

  it("passes a function expression with a qualified arg through raw", () => {
    const qb = newQb().selectRaw(["MAX(parent.RGT_NO)"]);
    const { text } = qb.getSql();
    expect(text).toContain("MAX(parent.RGT_NO)");
    expect(text).not.toContain("`MAX(");
  });

  it("still resolves a bare alias.property reference to its mapped column", () => {
    const qb = newQb().selectRaw(["node.name"]);
    const { text } = qb.getSql();
    expect(text).toContain("`node`.`CTGR_NM`");
  });

  it("still resolves a bare property reference on the root entity", () => {
    const qb = newQb().selectRaw(["right"]);
    const { text } = qb.getSql();
    expect(text).toContain("`node`.`RGT_NO`");
  });
});
