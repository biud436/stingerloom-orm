/**
 * getCount() distinct-root counting under to-many *AndSelect joins.
 *
 * When a `one-to-many` joined selection is present (e.g.
 * `leftJoinRelationAndSelect("comments", "c")`), the JOIN multiplies root
 * rows, so a plain `COUNT(*)` over the joined row set overcounts. getCount()
 * must instead count distinct root entities via a
 * `COUNT(*) FROM (SELECT DISTINCT <root pk> ...) ` wrapper. These tests assert
 * the generated COUNT SQL for each relevant scenario:
 *
 *  - to-many joined selection  -> COUNT(*) over SELECT DISTINCT root pk(s)
 *  - many-to-one joined selection -> plain COUNT(*) (rows are not multiplied)
 *  - plain leftJoin (no selection) -> plain COUNT(*) (unchanged)
 *  - GROUP BY present -> COUNT(*) over a `SELECT 1 ... GROUP BY` derived
 *    table (number of groups), never the distinct-root wrapper
 *  - composite PK root -> SELECT DISTINCT lists every PK column
 */
import "reflect-metadata";
import { SelectQueryBuilder } from "../../src/core/SelectQueryBuilder";
import {
  Entity,
  PrimaryGeneratedColumn,
  PrimaryColumn,
  Column,
  ManyToOne,
  OneToMany,
} from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";
import { sql } from "../../src/utils/sqlTag";

@Entity()
class CntUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  username!: string;

  @OneToMany(() => CntComment, { mappedBy: "user" })
  comments!: CntComment[];
}

@Entity()
class CntComment {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "text" })
  content!: string;

  @Column({ type: "int", nullable: true })
  userId!: number | null;

  @ManyToOne(
    () => CntUser,
    (e: any) => e.user,
  )
  user!: CntUser | null;
}

@Entity()
class CntPair {
  @PrimaryColumn({ type: "int" })
  tenantId!: number;

  @PrimaryColumn({ type: "int" })
  localId!: number;

  @Column({ type: "varchar", length: 255 })
  label!: string;

  @OneToMany(() => CntChild, { mappedBy: "pair" })
  children!: CntChild[];
}

@Entity()
class CntChild {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "int" })
  pairTenantId!: number;

  @Column({ type: "int" })
  pairLocalId!: number;

  @ManyToOne(
    () => CntPair,
    (e: any) => e.pair,
    { joinColumn: "pairLocalId" },
  )
  pair!: CntPair | null;
}

/**
 * Mock EM that records the SQL text of every query() call. COUNT(*) queries
 * resolve to the configured total; other queries resolve to an empty list.
 */
function createMockEm(total = 0) {
  const resolver = new RelationMetadataResolver();
  const wrap = (col: string) => `\`${col.replace(/`/g, "``")}\``;
  const calls: string[] = [];
  const em = {
    wrap,
    wrapTable: (t: string) => wrap(t),
    resolver,
    _ctx: {
      isMySqlFamily: () => true,
      isPostgres: () => false,
      isSqlite: () => false,
      getDialect: () => "mysql",
    },
    async query<T>(built: any): Promise<T[]> {
      const text = String(built?.sql ?? built?.text ?? "");
      calls.push(text);
      if (text.toUpperCase().includes("COUNT(*)")) {
        return [{ count: total }] as unknown as T[];
      }
      return [] as unknown as T[];
    },
    __calls: calls,
  } as unknown as EntityManager & { __calls: string[] };
  return em;
}

describe("getCount() — distinct root counting under to-many *AndSelect", () => {
  it("wraps a SELECT DISTINCT root-pk subquery for one-to-many selections", async () => {
    const em = createMockEm(3);
    const qb = new SelectQueryBuilder<CntUser>(CntUser, "u", em);
    qb.leftJoinRelationAndSelect("comments", "c");

    const count = await qb.getCount();

    expect(count).toBe(3);
    const countSql = em.__calls.find((c) => c.toUpperCase().includes("COUNT(*)"))!;
    expect(countSql).toBeDefined();
    // Outer wrapper counts the distinct-root subquery rows.
    expect(countSql).toContain("SELECT COUNT(*) AS count");
    expect(countSql).toContain("SELECT DISTINCT `u`.`id`");
    expect(countSql).toMatch(/FROM \(SELECT DISTINCT/);
    // The join is preserved inside the subquery.
    expect(countSql).toContain("LEFT JOIN");
  });

  it("counts distinct roots for the loadRelation shorthand join", async () => {
    const em = createMockEm(5);
    const qb = new SelectQueryBuilder<CntUser>(CntUser, "u", em);
    // loadRelation is shorthand for leftJoinRelationAndSelect.
    qb.loadRelation("comments", "c");

    const count = await qb.getCount();

    expect(count).toBe(5);
    const countSql = em.__calls.find((c) => c.toUpperCase().includes("COUNT(*)"))!;
    expect(countSql).toContain("SELECT DISTINCT `u`.`id`");
  });

  it("uses a plain COUNT(*) for many-to-one joined selections (no row multiplication)", async () => {
    const em = createMockEm(7);
    const qb = new SelectQueryBuilder<CntComment>(CntComment, "c", em);
    qb.leftJoinRelationAndSelect("user", "u");

    const count = await qb.getCount();

    expect(count).toBe(7);
    const countSql = em.__calls.find((c) => c.toUpperCase().includes("COUNT(*)"))!;
    expect(countSql).toContain("SELECT COUNT(*) AS count");
    // No distinct-root wrapper for to-one selections.
    expect(countSql).not.toContain("SELECT DISTINCT");
    expect(countSql).not.toMatch(/FROM \(SELECT DISTINCT/);
  });

  it("uses a plain COUNT(*) for hand-written leftJoin without a joined selection", async () => {
    const em = createMockEm(11);
    const qb = new SelectQueryBuilder<CntUser>(CntUser, "u", em);
    // Plain relation join (no *AndSelect) — caller may want the row count.
    qb.leftJoinRelation("comments", "c");

    const count = await qb.getCount();

    expect(count).toBe(11);
    const countSql = em.__calls.find((c) => c.toUpperCase().includes("COUNT(*)"))!;
    expect(countSql).toContain("LEFT JOIN");
    expect(countSql).not.toContain("SELECT DISTINCT");
  });

  it("counts groups through a derived table when GROUP BY is present", async () => {
    const em = createMockEm(2);
    const qb = new SelectQueryBuilder<CntUser>(CntUser, "u", em);
    qb.leftJoinRelationAndSelect("comments", "c").groupBy(["id"]);

    const count = await qb.getCount();

    // The mock returns a single { count: 2 } row: that is the outer COUNT(*)
    // over the grouped derived table, i.e. the number of groups.
    expect(count).toBe(2);
    const countSql = em.__calls.find((c) => c.toUpperCase().includes("COUNT(*)"))!;
    // Outer aggregate wraps an inner constant projection grouped by the
    // GROUP BY entries; the to-many join is applied inside the derived table.
    expect(countSql).toMatch(
      /^SELECT COUNT\(\*\) AS count FROM \(SELECT 1 FROM .* GROUP BY .*\) AS `grouped_src`$/s,
    );
    expect(countSql).toContain("LEFT JOIN");
    expect(countSql).not.toContain("SELECT DISTINCT");
  });

  it("keeps HAVING inside the grouped derived table", async () => {
    const em = createMockEm(1);
    const qb = new SelectQueryBuilder<CntUser>(CntUser, "u", em);
    qb.groupBy(["username"]).having(sql`COUNT(*) > ${1}`);

    await qb.getCount();

    const countSql = em.__calls.find((c) => c.toUpperCase().includes("COUNT(*)"))!;
    expect(countSql).toMatch(/GROUP BY .* HAVING COUNT\(\*\) > \?\) AS `grouped_src`$/s);
  });

  it("applies HAVING without GROUP BY to the single COUNT(*) row", async () => {
    const em = createMockEm(3);
    const qb = new SelectQueryBuilder<CntUser>(CntUser, "u", em);
    qb.having(sql`COUNT(*) > ${1}`);

    await qb.getCount();

    const countSql = em.__calls.find((c) => c.toUpperCase().includes("COUNT(*)"))!;
    expect(countSql).not.toContain("grouped_src");
    expect(countSql).toMatch(/^SELECT COUNT\(\*\) AS count FROM .* HAVING COUNT\(\*\) > \?$/s);
  });

  it("lists every PK column in the DISTINCT subquery for composite-PK roots", async () => {
    const em = createMockEm(4);
    const qb = new SelectQueryBuilder<CntPair>(CntPair, "p", em);
    qb.leftJoinRelationAndSelect("children", "c");

    const count = await qb.getCount();

    expect(count).toBe(4);
    const countSql = em.__calls.find((c) => c.toUpperCase().includes("COUNT(*)"))!;
    expect(countSql).toContain("SELECT DISTINCT `p`.`tenantId`, `p`.`localId`");
  });
});
