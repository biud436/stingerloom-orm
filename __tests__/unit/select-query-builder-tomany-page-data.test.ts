/**
 * Two-phase root pagination for to-many *AndSelect joins.
 *
 * When `leftJoinRelationAndSelect("comments", ...)` is combined with
 * LIMIT/OFFSET, applying the window to the JOIN-multiplied rows truncates a
 * root's children at the page boundary. paginate()/getMany() must instead:
 *   - Phase 1: select the page of distinct root PKs (DISTINCT + LIMIT/OFFSET).
 *   - Phase 2: re-run the full *AndSelect query filtered by `root.pk IN (...)`
 *     WITHOUT LIMIT/OFFSET, returning full child arrays in page order.
 *
 * These tests drive a mock EM whose query() routes by SQL shape (COUNT vs
 * phase-1 DISTINCT vs phase-2 IN) and assert both the generated SQL and the
 * hydrated page data.
 */
import "reflect-metadata";
import { SelectQueryBuilder } from "../../src/core/SelectQueryBuilder";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToMany,
} from "../../src/decorators";
import { EntityManager } from "../../src/core/EntityManager";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";

@Entity()
class PgUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  username!: string;

  @OneToMany(() => PgComment, { mappedBy: "user" })
  comments!: PgComment[];
}

@Entity()
class PgComment {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "text" })
  content!: string;

  @Column({ type: "int", nullable: true })
  userId!: number | null;

  @ManyToOne(
    () => PgUser,
    (e: any) => e.user,
  )
  user!: PgUser | null;
}

/**
 * Mock EM that routes query() by SQL shape:
 *  - COUNT(*)        -> { count: total }
 *  - SELECT DISTINCT -> phase-1 page of root PK rows
 *  - otherwise       -> phase-2 joined rows for the page's roots
 */
function createMockEm(opts: {
  total: number;
  phase1: any[];
  phase2: any[];
}) {
  const resolver = new RelationMetadataResolver();
  const wrap = (col: string) => `\`${col.replace(/`/g, "``")}\``;
  const calls: { sql: string }[] = [];
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
      calls.push({ sql: text });
      if (text.toUpperCase().includes("COUNT(*)")) {
        return [{ count: opts.total }] as unknown as T[];
      }
      if (text.toUpperCase().includes("SELECT DISTINCT")) {
        return opts.phase1 as T[];
      }
      return opts.phase2 as T[];
    },
    __calls: calls,
  } as unknown as EntityManager & { __calls: { sql: string }[] };
  return em;
}

const PHASE2_ROWS = [
  { u_id: 1, u_username: "alice", c_id: 10, c_content: "a1", c_userId: 1 },
  { u_id: 1, u_username: "alice", c_id: 11, c_content: "a2", c_userId: 1 },
  { u_id: 1, u_username: "alice", c_id: 12, c_content: "a3", c_userId: 1 },
  { u_id: 2, u_username: "bob", c_id: 20, c_content: "b1", c_userId: 2 },
  { u_id: 2, u_username: "bob", c_id: 21, c_content: "b2", c_userId: 2 },
];

describe("paginate() — two-phase root pagination (to-many *AndSelect)", () => {
  it("returns whole roots with full child arrays and the distinct-root total", async () => {
    const em = createMockEm({
      total: 3,
      phase1: [{ id: 1 }, { id: 2 }],
      phase2: PHASE2_ROWS,
    });
    const result = await new SelectQueryBuilder<PgUser>(PgUser, "u", em)
      .leftJoinRelationAndSelect("comments", "c")
      .orderBy({ id: "ASC" })
      .paginate({ page: 1, pageSize: 2 });

    // Distinct-root total (3 users), not the multiplied row count (5).
    expect(result.total).toBe(3);
    expect(result.totalPages).toBe(2);
    expect(result.hasNextPage).toBe(true);

    // Page has exactly 2 roots (pageSize), each fully hydrated.
    expect(result.data).toHaveLength(2);
    expect(result.data.map((u) => u.id)).toEqual([1, 2]);
    expect(result.data[0]).toBeInstanceOf(PgUser);
    expect(result.data[0].comments.map((c) => c.id)).toEqual([10, 11, 12]);
    expect(result.data[1].comments.map((c) => c.id)).toEqual([20, 21]);
  });

  it("issues a phase-1 DISTINCT pk page query and a phase-2 IN query without LIMIT", async () => {
    const em = createMockEm({
      total: 3,
      phase1: [{ id: 1 }, { id: 2 }],
      phase2: PHASE2_ROWS,
    });
    await new SelectQueryBuilder<PgUser>(PgUser, "u", em)
      .leftJoinRelationAndSelect("comments", "c")
      .orderBy({ id: "ASC" })
      .paginate({ page: 1, pageSize: 2 });

    const phase1 = em.__calls.find(
      (c) =>
        c.sql.toUpperCase().includes("SELECT DISTINCT") &&
        !c.sql.toUpperCase().includes("COUNT(*)"),
    )!;
    expect(phase1).toBeDefined();
    expect(phase1.sql).toContain("SELECT DISTINCT `u`.`id`");
    expect(phase1.sql).toContain("LEFT JOIN");
    expect(phase1.sql).toContain("LIMIT");

    // Phase-2: the full *AndSelect query, filtered by root.pk IN, unpaged.
    const phase2 = em.__calls.find(
      (c) =>
        c.sql.includes("`u`.`id` IN (") &&
        !c.sql.toUpperCase().includes("SELECT DISTINCT"),
    )!;
    expect(phase2).toBeDefined();
    expect(phase2.sql).toContain("`u`.`id` AS `u_id`");
    expect(phase2.sql).toContain("`c`.`id` AS `c_id`");
    expect(phase2.sql).not.toContain("LIMIT");
  });

  it("computes a partial last page over distinct roots", async () => {
    const em = createMockEm({
      total: 3,
      phase1: [{ id: 3 }],
      phase2: [
        { u_id: 3, u_username: "carol", c_id: 30, c_content: "c1", c_userId: 3 },
      ],
    });
    const result = await new SelectQueryBuilder<PgUser>(PgUser, "u", em)
      .leftJoinRelationAndSelect("comments", "c")
      .orderBy({ id: "ASC" })
      .paginate({ page: 2, pageSize: 2 });

    expect(result.total).toBe(3);
    expect(result.totalPages).toBe(2);
    expect(result.hasNextPage).toBe(false);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].id).toBe(3);
    expect(result.data[0].comments.map((c) => c.id)).toEqual([30]);
  });

  it("returns an empty page when phase 1 yields no roots", async () => {
    const em = createMockEm({ total: 3, phase1: [], phase2: PHASE2_ROWS });
    const result = await new SelectQueryBuilder<PgUser>(PgUser, "u", em)
      .leftJoinRelationAndSelect("comments", "c")
      .orderBy({ id: "ASC" })
      .paginate({ page: 99, pageSize: 2 });

    expect(result.total).toBe(3);
    expect(result.data).toHaveLength(0);
    // Phase 2 must be skipped when there are no page roots.
    const phase2Issued = em.__calls.some((c) => c.sql.includes("IN ("));
    expect(phase2Issued).toBe(false);
  });
});

describe("getMany() — two-phase root pagination with explicit limit/offset", () => {
  it("applies root windowing for .limit().offset() + to-many *AndSelect", async () => {
    const em = createMockEm({
      total: 3,
      phase1: [{ id: 2 }],
      phase2: [
        { u_id: 2, u_username: "bob", c_id: 20, c_content: "b1", c_userId: 2 },
        { u_id: 2, u_username: "bob", c_id: 21, c_content: "b2", c_userId: 2 },
      ],
    });
    const data = await new SelectQueryBuilder<PgUser>(PgUser, "u", em)
      .leftJoinRelationAndSelect("comments", "c")
      .orderBy({ id: "ASC" })
      .offset(1)
      .limit(1)
      .getMany();

    expect(data).toHaveLength(1);
    expect(data[0].id).toBe(2);
    expect(data[0].comments.map((c) => c.id)).toEqual([20, 21]);

    const phase1 = em.__calls.find((c) =>
      c.sql.toUpperCase().includes("SELECT DISTINCT"),
    )!;
    expect(phase1.sql).toContain("LIMIT");
  });

  it("does NOT two-phase an unpaged getMany() (groups multiplied rows directly)", async () => {
    const em = createMockEm({ total: 3, phase1: [], phase2: PHASE2_ROWS });
    const data = await new SelectQueryBuilder<PgUser>(PgUser, "u", em)
      .leftJoinRelationAndSelect("comments", "c")
      .orderBy({ id: "ASC" })
      .getMany();

    // No DISTINCT pk page query — the single SELECT is grouped in memory.
    const distinctIssued = em.__calls.some((c) =>
      c.sql.toUpperCase().includes("SELECT DISTINCT"),
    );
    expect(distinctIssued).toBe(false);
    expect(data.map((u) => u.id)).toEqual([1, 2]);
    expect(data[0].comments.map((c) => c.id)).toEqual([10, 11, 12]);
  });
});

describe("paginatePartial() — two-phase root pagination (to-many *AndSelect)", () => {
  it("returns the page's roots' flat rows in page order with distinct-root total", async () => {
    const em = createMockEm({
      total: 3,
      phase1: [{ id: 1 }, { id: 2 }],
      phase2: PHASE2_ROWS,
    });
    const result = await new SelectQueryBuilder<PgUser>(PgUser, "u", em)
      .leftJoinRelationAndSelect("comments", "c")
      .orderBy({ id: "ASC" })
      .paginatePartial({ page: 1, pageSize: 2 });

    expect(result.total).toBe(3);
    expect(result.totalPages).toBe(2);
    // All flat rows for the 2 page roots (no truncation at the boundary).
    expect(result.data).toHaveLength(5);
    const distinctRoots = new Set(result.data.map((r: any) => r.u_id));
    expect(distinctRoots).toEqual(new Set([1, 2]));
  });
});
