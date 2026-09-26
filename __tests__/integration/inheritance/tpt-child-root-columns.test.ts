/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * MySQL / PostgreSQL: a JOINED (TPT) child's inherited columns outside
 * find() and save().
 *
 * Mirrors the SQLite suites tpt-child-soft-delete-reads,
 * tpt-child-aggregates-cursor and tpt-child-criteria-update. What is
 * dialect-specific here:
 *
 * - aggregates and cursor pages read the child as a derived table,
 *   `(SELECT ... FROM child INNER JOIN root ...) AS "_tpt"`;
 * - criteria writes read the matching keys first with
 *   `SELECT ... FROM child AS tpt_child INNER JOIN root AS tpt_root ...
 *   [ORDER BY ...] [LIMIT n] FOR UPDATE`, then write each table by key.
 */
import "reflect-metadata";
import {
  createTestConnection,
  dropTestTable,
  rawQuery,
  type TestConnectionResult,
} from "../helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "../helpers/driver-config";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Inheritance,
  DiscriminatorColumn,
  DiscriminatorValue,
  DeletedAt,
  Version,
} from "../../../src";

const INTEGRATION = process.env.INTEGRATION_TEST === "true";
const drivers = INTEGRATION ? getTestDrivers() : [];

const suffix = Date.now().toString().slice(-6);
const TABLES = {
  root: `tptc_doc_${suffix}`,
  review: `tptc_rev_${suffix}`,
  memo: `tptc_memo_${suffix}`,
};

describe.each(drivers)(
  "[Integration][$label] TPT child inherited columns",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let Doc: any;
    let Review: any;
    let Memo: any;
    const q = (name: string) => (type === "mysql" ? `\`${name}\`` : `"${name}"`);

    beforeAll(async () => {
      conn = await createTestConnection(
        { ...options, synchronize: true, logging: false },
        () => {
          @Entity({ name: TABLES.root })
          @Inheritance({ strategy: "JOINED" })
          @DiscriminatorColumn({ name: "doc_type", type: "varchar", length: 50 })
          class DocEntity {
            @PrimaryGeneratedColumn() id!: number;
            @Column() title!: string;
            @Column({ type: "int" }) score!: number;
            @Version() version!: number;
            @DeletedAt() deletedAt!: Date | null;
          }

          @Entity({ name: TABLES.review })
          @DiscriminatorValue("review")
          class ReviewEntity extends DocEntity {
            @Column() reviewer!: string;
            @Column({ type: "int" }) stars!: number;
          }

          @Entity({ name: TABLES.memo })
          @DiscriminatorValue("memo")
          class MemoEntity extends DocEntity {
            @Column() note!: string;
          }

          Doc = DocEntity;
          Review = ReviewEntity;
          Memo = MemoEntity;
          return { entities: [DocEntity, ReviewEntity, MemoEntity] };
        },
      );
    }, 30000);

    afterAll(async () => {
      if (!conn) return;
      for (const table of [TABLES.review, TABLES.memo, TABLES.root]) {
        try { await dropTestTable(table); } catch { /* ignore */ }
      }
      await conn.cleanup();
    }, 15000);

    let ids: { bob: number; amy: number; cat: number; memo: number };

    beforeEach(async () => {
      await rawQuery(`DELETE FROM ${q(TABLES.review)}`);
      await rawQuery(`DELETE FROM ${q(TABLES.memo)}`);
      await rawQuery(`DELETE FROM ${q(TABLES.root)}`);
      const em: any = conn.em;
      const bob = await em.save(Review, { title: "shared", score: 10, reviewer: "bob", stars: 1 });
      const amy = await em.save(Review, { title: "r2", score: 20, reviewer: "amy", stars: 2 });
      const cat = await em.save(Review, { title: "r3", score: 30, reviewer: "cat", stars: 3 });
      const memo = await em.save(Memo, { title: "shared", score: 10, note: "n" });
      ids = { bob: bob.id, amy: amy.id, cat: cat.id, memo: memo.id };
    });

    const reviewById = async (id: number) =>
      (conn.em as any).findOne(Review, { where: { id }, withDeleted: true } as any) as Promise<any>;

    it("save() and find() work with a root @DeletedAt; softDelete/restore go by child columns", async () => {
      const em: any = conn.em;
      expect((await em.softDelete(Review, { reviewer: "amy" })).affected).toBe(1);
      const live = await em.find(Review, { orderBy: { id: "ASC" } } as any);
      expect(live.map((r: any) => r.reviewer)).toEqual(["bob", "cat"]);
      expect((await reviewById(ids.amy)).deletedAt).toBeInstanceOf(Date);

      expect((await em.restore(Review, { reviewer: "amy" })).affected).toBe(1);
      expect((await reviewById(ids.amy)).deletedAt).toBeNull();
    });

    it("softDelete() by a root column keeps a sibling sharing the value live", async () => {
      expect((await (conn.em as any).softDelete(Review, { title: "shared" })).affected).toBe(1);
      const memo: any = await (conn.em as any).findOne(Memo, { where: { id: ids.memo } } as any);
      expect(memo?.deletedAt).toBeNull();
    });

    it("aggregates filter and total by root columns", async () => {
      const em: any = conn.em;
      await em.softDelete(Review, { reviewer: "cat" });
      expect(await em.count(Review, { title: "shared" })).toBe(1);
      expect(await em.count(Review, {})).toBe(2);
      expect(await em.sum(Review, "score", {})).toBe(30);
      expect(await em.max(Review, "stars", { score: { gte: 10 } } as any)).toBe(2);
      const [rows, total] = await em.findAndCount(Review, { where: { score: { gt: 10 } } } as any);
      expect(rows.map((r: any) => r.reviewer)).toEqual(["amy"]);
      expect(total).toBe(1);
    });

    it("findWithCursor() pages by a root column", async () => {
      const opts = { take: 2, orderBy: "score", direction: "DESC" } as any;
      const first = await (conn.em as any).findWithCursor(Review, opts);
      expect(first.data.map((r: any) => r.reviewer)).toEqual(["cat", "amy"]);
      const second = await (conn.em as any).findWithCursor(Review, { ...opts, cursor: first.nextCursor });
      expect(second.data.map((r: any) => r.reviewer)).toEqual(["bob"]);
      expect(second.hasNextPage).toBe(false);
    });

    it("updateMany() writes both tables, ordered and limited by a root column", async () => {
      const result = await (conn.em as any).updateMany(
        Review,
        { title: "top", stars: 9 },
        { where: { score: { gte: 10 } }, orderBy: { score: "DESC" }, limit: 2 },
      );
      expect(result.affected).toBe(2);
      const cat = await reviewById(ids.cat);
      expect(cat).toMatchObject({ title: "top", stars: 9 });
      expect(Number(cat.version)).toBe(2);
      expect(await reviewById(ids.amy)).toMatchObject({ title: "top", stars: 9 });
      expect(await reviewById(ids.bob)).toMatchObject({ title: "shared", stars: 1 });
    });

    it("increment() reaches a root column by a child-column criteria", async () => {
      await (conn.em as any).increment(Review, { reviewer: "bob" }, "score", 5);
      expect((await reviewById(ids.bob)).score).toBe(15);
    });

    it("delete() by a root column removes this class's rows only", async () => {
      expect((await (conn.em as any).delete(Review, { title: "shared" })).affected).toBe(1);
      expect(await reviewById(ids.bob)).toBeNull();
      expect(await (conn.em as any).findOne(Doc, { where: { id: ids.memo } } as any)).not.toBeNull();
    });
  },
);
