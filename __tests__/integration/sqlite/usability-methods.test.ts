/**
 * SQLite In-Memory: end-to-end coverage for a batch of EntityManager /
 * SelectQueryBuilder usability methods that previously had only mock-SQL unit
 * coverage. Every test here runs against the real `better-sqlite3` driver
 * (`:memory:`) so the methods are proven to work end-to-end, not just to emit
 * the expected SQL string.
 *
 * Covered methods, grouped by `describe`:
 *  - SelectQueryBuilder scalar terminals: getSum / getAvg / getMin / getMax /
 *    getExists / explain
 *  - JoinOnBuilder helpers: onNull / onNotNull / onIn (via .leftJoin)
 *  - EntityManager.upsert / batchUpsert ({ affected } shape + persisted effect)
 *  - FindOption.onlyDeleted (find + findAndCount)
 *  - EntityManager.findByPKsMap
 *  - EntityManager.increment / decrement (+ @Version bump)
 *  - EntityManager.pluck
 *  - SelectQueryBuilder.getMap / pluck
 *  - SelectQueryBuilder.getCursor (keyset pagination — page-union property)
 *
 * Gating: like every sibling file under __tests__/integration/, the whole
 * directory is excluded by jest.config.js unless INTEGRATION_TEST=true, so this
 * file is skipped (0 tests run) in the normal unit run.
 *
 * Note: the upsert/batchUpsert/increment/decrement affected-count tests below
 * also guard against a regression where SQLite write paths reported
 * `{ affected: 0 }`. SqliteConnector now maps better-sqlite3's run().changes
 * onto the top-level rowCount that EntityManager's affected extraction reads.
 */

import "reflect-metadata";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Version,
  DeletedAt,
} from "../../../src";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";

describe("[Integration] SQLite In-Memory: usability methods", () => {
  let conn: TestConnectionResult;

  // Entity classes resolved from the factory below. They are typed with their
  // concrete shapes so the column-name generics on getSum/getMap/pluck/etc.
  // resolve per-entity (rather than collapsing to `never` when typed `any`).
  let AggOrder: new () => {
    id: number;
    amount: number | null;
    status: string;
  };
  let CursorRow: new () => { id: number; label: string };
  let UpsertTarget: new () => { id: number; sku: string; qty: number };
  let Counter: new () => { id: number; hits: number; version: number };
  let Article: new () => { id: number; title: string; deletedAt: Date | null };
  let Author: new () => {
    id: number;
    name: string;
    role: string;
    verifiedAt: number | null;
  };
  let Book: new () => { id: number; title: string; authorId: number };
  let BatchReturn: new () => { id: number; label: string; seq: number };

  beforeAll(async () => {
    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
      },
      () => {
        getScannerInstance(ColumnScanner).clear();

        @Entity({ name: "um_agg_order" })
        class AggOrderEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column({ type: "int", nullable: true }) amount!: number | null;
          @Column() status!: string;
        }

        @Entity({ name: "um_cursor_row" })
        class CursorRowEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() label!: string;
        }

        @Entity({ name: "um_upsert_target" })
        class UpsertTargetEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() sku!: string;
          @Column({ type: "int" }) qty!: number;
        }

        @Entity({ name: "um_counter" })
        class CounterEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column({ type: "int" }) hits!: number;
          @Version() version!: number;
        }

        @Entity({ name: "um_article" })
        class ArticleEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() title!: string;
          @DeletedAt() deletedAt!: Date | null;
        }

        @Entity({ name: "um_author" })
        class AuthorEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() name!: string;
          @Column() role!: string;
          @Column({ type: "int", nullable: true })
          verifiedAt!: number | null;
        }

        @Entity({ name: "um_book" })
        class BookEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() title!: string;
          @Column({ type: "int" }) authorId!: number;
        }

        // Dedicated write target for insertManyAndReturn: auto-increment PK +
        // two distinguishing non-PK columns (label / seq) so input order can be
        // asserted independently of the generated id.
        @Entity({ name: "um_batch_return" })
        class BatchReturnEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() label!: string;
          @Column({ type: "int" }) seq!: number;
        }

        AggOrder = AggOrderEntity;
        CursorRow = CursorRowEntity;
        UpsertTarget = UpsertTargetEntity;
        Counter = CounterEntity;
        Article = ArticleEntity;
        Author = AuthorEntity;
        Book = BookEntity;
        BatchReturn = BatchReturnEntity;

        return {
          entities: [
            AggOrderEntity,
            CursorRowEntity,
            UpsertTargetEntity,
            CounterEntity,
            ArticleEntity,
            AuthorEntity,
            BookEntity,
            BatchReturnEntity,
          ],
        };
      },
    );

    const { em } = conn;

    // ── AggOrder seed (read-only): ids 1..5, one NULL amount ──────────────
    // amounts: 10, 20, 30, 40, NULL ; statuses: open/open/closed/closed/open
    await em.save(AggOrder, { amount: 10, status: "open" });
    await em.save(AggOrder, { amount: 20, status: "open" });
    await em.save(AggOrder, { amount: 30, status: "closed" });
    await em.save(AggOrder, { amount: 40, status: "closed" });
    await em.save(AggOrder, { amount: null, status: "open" } as any);

    // ── CursorRow seed (read-only): ids 1..7 ─────────────────────────────
    for (let i = 1; i <= 7; i++) {
      await em.save(CursorRow, { label: `row-${i}` });
    }

    // ── Article seed: 4 rows, soft-delete 2 of them ──────────────────────
    await em.save(Article, { title: "live-1" });
    await em.save(Article, { title: "trash-1" });
    await em.save(Article, { title: "live-2" });
    await em.save(Article, { title: "trash-2" });
    await em.softDelete(Article, { title: "trash-1" } as any);
    await em.softDelete(Article, { title: "trash-2" } as any);

    // ── Author / Book seed for join-ON tests ─────────────────────────────
    // a1 admin verified, a2 editor NOT verified, a3 viewer verified
    const a1: any = await em.save(Author, {
      name: "Ann",
      role: "admin",
      verifiedAt: 1000,
    });
    const a2: any = await em.save(Author, {
      name: "Bob",
      role: "editor",
      verifiedAt: null,
    } as any);
    const a3: any = await em.save(Author, {
      name: "Cy",
      role: "viewer",
      verifiedAt: 2000,
    });
    await em.save(Book, { title: "b1", authorId: a1.id }); // admin / verified
    await em.save(Book, { title: "b2", authorId: a2.id }); // editor / unverified
    await em.save(Book, { title: "b3", authorId: a3.id }); // viewer / verified
    await em.save(Book, { title: "b4", authorId: a1.id }); // admin / verified
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  // ───────────────────────────────────────────────────────────────────────
  // SelectQueryBuilder scalar aggregate terminals + explain
  // ───────────────────────────────────────────────────────────────────────
  describe("SelectQueryBuilder scalar terminals (getSum/getAvg/getMin/getMax/getExists/explain)", () => {
    it("getSum() sums non-NULL values across all rows", async () => {
      const total = await conn.em
        .createQueryBuilder(AggOrder, "o")
        .getSum("amount");
      expect(total).toBe(100); // 10+20+30+40 (NULL excluded)
    });

    it("getSum() honors the builder's WHERE predicate", async () => {
      const total = await conn.em
        .createQueryBuilder(AggOrder, "o")
        .where("status", "open")
        .getSum("amount");
      expect(total).toBe(30); // open rows: 10 + 20 (+ NULL)
    });

    it("getAvg() averages non-NULL values", async () => {
      const avg = await conn.em
        .createQueryBuilder(AggOrder, "o")
        .getAvg("amount");
      expect(avg).toBeCloseTo(25, 5); // 100 / 4
    });

    it("getMin() / getMax() return the extremes", async () => {
      const qb = () => conn.em.createQueryBuilder(AggOrder, "o");
      expect(await qb().getMin("amount")).toBe(10);
      expect(await qb().getMax("amount")).toBe(40);
    });

    it("getExists() returns true when a row matches and false otherwise", async () => {
      const matches = await conn.em
        .createQueryBuilder(AggOrder, "o")
        .where("status", "open")
        .getExists();
      expect(matches).toBe(true);

      const none = await conn.em
        .createQueryBuilder(AggOrder, "o")
        .where("status", "no-such-status")
        .getExists();
      expect(none).toBe(false);
    });

    it("explain() resolves to a non-empty query plan", async () => {
      const plan = await conn.em
        .createQueryBuilder(AggOrder, "o")
        .where("status", "open")
        .explain();

      // Don't pin the plan's contents — only prove EXPLAIN ran and returned rows.
      expect(plan).toBeDefined();
      expect(Array.isArray(plan.raw)).toBe(true);
      expect(plan.raw.length).toBeGreaterThan(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // JoinOnBuilder: onNull / onNotNull / onIn (via leftJoin)
  // ───────────────────────────────────────────────────────────────────────
  describe("JoinOnBuilder join-ON helpers (onNull/onNotNull/onIn)", () => {
    // For a LEFT JOIN, a left row only matches the right row when the FULL ON
    // (including the helper predicate) holds; otherwise the projected
    // right-side column comes back NULL. We read it via getRawMany().
    async function joinedAuthorByBook(
      build: (j: any) => any,
    ): Promise<Map<string, string | null>> {
      const rows = await conn.em
        .createQueryBuilder(Book, "b")
        .leftJoin(Author, "a", build)
        .selectRaw(["b.title", "a.name"])
        .orderBy({ id: "ASC" })
        .getRawMany();

      const map = new Map<string, string | null>();
      for (const r of rows) {
        map.set(
          (r.title as string) ?? (r["b.title"] as string),
          ((r.name as string) ?? (r["a.name"] as string) ?? null) as
            | string
            | null,
        );
      }
      return map;
    }

    it("onNotNull() matches only rows whose joined column is NOT NULL", async () => {
      const byBook = await joinedAuthorByBook((j) =>
        j.on("b.authorId", "=", "a.id").onNotNull("a.verifiedAt"),
      );

      // b2's author (Bob) has verifiedAt = NULL → no match → author name NULL.
      expect(byBook.get("b1")).toBe("Ann");
      expect(byBook.get("b2")).toBeNull();
      expect(byBook.get("b3")).toBe("Cy");
      expect(byBook.get("b4")).toBe("Ann");
    });

    it("onNull() matches only rows whose joined column IS NULL", async () => {
      const byBook = await joinedAuthorByBook((j) =>
        j.on("b.authorId", "=", "a.id").onNull("a.verifiedAt"),
      );

      // Only Bob (a2) has verifiedAt NULL, so only b2 matches.
      expect(byBook.get("b1")).toBeNull();
      expect(byBook.get("b2")).toBe("Bob");
      expect(byBook.get("b3")).toBeNull();
      expect(byBook.get("b4")).toBeNull();
    });

    it("onIn() matches only rows whose joined column is IN the value set", async () => {
      const byBook = await joinedAuthorByBook((j) =>
        j
          .on("b.authorId", "=", "a.id")
          .onIn("a.role", ["admin", "editor"]),
      );

      // viewer (Cy / b3) is excluded; admin & editor match.
      expect(byBook.get("b1")).toBe("Ann"); // admin
      expect(byBook.get("b2")).toBe("Bob"); // editor
      expect(byBook.get("b3")).toBeNull(); // viewer — excluded
      expect(byBook.get("b4")).toBe("Ann"); // admin
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // EntityManager.upsert / batchUpsert
  // ───────────────────────────────────────────────────────────────────────
  describe("EntityManager.upsert / batchUpsert", () => {
    it("upsert() inserts a new row and returns the { affected } shape", async () => {
      const result = await conn.em.upsert(UpsertTarget, {
        id: 1,
        sku: "A",
        qty: 5,
      });

      expect(result).toEqual({ affected: expect.any(Number) });

      const row: any = await conn.em.findByPK(UpsertTarget, 1);
      expect(row).not.toBeNull();
      expect(row.sku).toBe("A");
      expect(row.qty).toBe(5);
    });

    it("upsert() updates on PK conflict and persists the new values", async () => {
      // Row id=1 already exists from the previous test → conflict-update path.
      const result = await conn.em.upsert(UpsertTarget, {
        id: 1,
        sku: "A",
        qty: 50,
      });

      expect(result).toEqual({ affected: expect.any(Number) });

      const row: any = await conn.em.findByPK(UpsertTarget, 1);
      expect(row.qty).toBe(50); // conflict-update reflected
    });

    it("upsert() accepts explicit conflictColumns", async () => {
      const result = await conn.em.upsert(
        UpsertTarget,
        { id: 1, sku: "A", qty: 77 },
        ["id"],
      );
      expect(result).toEqual({ affected: expect.any(Number) });

      const row: any = await conn.em.findByPK(UpsertTarget, 1);
      expect(row.qty).toBe(77);
    });

    it("batchUpsert() mixes insert + conflict-update and returns { affected }", async () => {
      const result = await conn.em.batchUpsert(UpsertTarget, [
        { id: 1, sku: "A", qty: 7 }, // existing → update
        { id: 2, sku: "B", qty: 3 }, // new → insert
      ]);

      expect(result).toEqual({ affected: expect.any(Number) });

      const r1: any = await conn.em.findByPK(UpsertTarget, 1);
      const r2: any = await conn.em.findByPK(UpsertTarget, 2);
      expect(r1.qty).toBe(7); // updated
      expect(r2).not.toBeNull();
      expect(r2.qty).toBe(3); // inserted
    });

    // SqliteConnector now maps better-sqlite3's run().changes onto the top-level
    // rowCount that EntityManager's affected-rows extraction reads, so upsert /
    // batchUpsert report a real affected count on SQLite (regression guard for
    // the connector rowCount normalization).
    it("upsert()/batchUpsert() affected count reflects rows changed", async () => {
      const insert = await conn.em.upsert(UpsertTarget, {
        id: 9,
        sku: "Z",
        qty: 1,
      });
      expect(insert.affected).toBe(1);

      const update = await conn.em.upsert(UpsertTarget, {
        id: 9,
        sku: "Z",
        qty: 2,
      });
      expect(update.affected).toBeGreaterThanOrEqual(1);

      const batch = await conn.em.batchUpsert(UpsertTarget, [
        { id: 9, sku: "Z", qty: 3 },
        { id: 10, sku: "Y", qty: 4 },
      ]);
      expect(batch.affected).toBe(2);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // FindOption.onlyDeleted
  // ───────────────────────────────────────────────────────────────────────
  describe("FindOption.onlyDeleted", () => {
    it("find({ onlyDeleted: true }) returns ONLY the soft-deleted rows", async () => {
      const trashed = await conn.em.find(Article, {
        onlyDeleted: true,
        orderBy: { id: "ASC" } as any,
      });

      expect(trashed).toHaveLength(2);
      expect(trashed.map((a: any) => a.title)).toEqual(["trash-1", "trash-2"]);
    });

    it("find() (default) returns only the live rows", async () => {
      const live = await conn.em.find(Article, {
        orderBy: { id: "ASC" } as any,
      });
      expect(live.map((a: any) => a.title)).toEqual(["live-1", "live-2"]);
    });

    it("findAndCount({ onlyDeleted: true }) count matches the trashed data array", async () => {
      const [rows, count] = await conn.em.findAndCount(Article, {
        onlyDeleted: true,
      });

      // Count must reflect the trashed rows, NOT the live ones.
      expect(count).toBe(2);
      expect(rows).toHaveLength(2);
      expect(count).toBe(rows.length);
      expect(rows.map((a: any) => a.title).sort()).toEqual([
        "trash-1",
        "trash-2",
      ]);
    });

    it("findAndCount() (default) counts only the live rows", async () => {
      const [rows, count] = await conn.em.findAndCount(Article, {});
      expect(count).toBe(2);
      expect(rows).toHaveLength(2);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // EntityManager.findByPKsMap
  // ───────────────────────────────────────────────────────────────────────
  describe("EntityManager.findByPKsMap", () => {
    it("returns a Map keyed by PK; missing ids absent; size == found rows", async () => {
      const map = await conn.em.findByPKsMap(AggOrder, [1, 3, 999]);

      expect(map.size).toBe(2); // 999 does not exist
      expect(map.has(1)).toBe(true);
      expect(map.has(3)).toBe(true);
      expect(map.has(999)).toBe(false);

      expect((map.get(1) as any).status).toBe("open");
      expect((map.get(3) as any).amount).toBe(30);
    });

    it("returns an empty Map when no ids match", async () => {
      const map = await conn.em.findByPKsMap(AggOrder, [9001, 9002]);
      expect(map.size).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // EntityManager.increment / decrement (+ @Version bump)
  // ───────────────────────────────────────────────────────────────────────
  describe("EntityManager.increment / decrement", () => {
    it("increment() with explicit `by` changes the stored value and bumps @Version", async () => {
      const c: any = await conn.em.save(Counter, { hits: 0 });
      expect(c.version).toBe(1);

      const result = await conn.em.increment(Counter, { id: c.id }, "hits", 5);
      expect(result).toEqual({ affected: expect.any(Number) });

      const after: any = await conn.em.findByPK(Counter, c.id);
      expect(after.hits).toBe(5); // value actually changed
      expect(after.version).toBe(2); // @Version incremented
    });

    it("increment() defaults `by` to 1", async () => {
      const c: any = await conn.em.save(Counter, { hits: 10 });

      await conn.em.increment(Counter, { id: c.id }, "hits");

      const after: any = await conn.em.findByPK(Counter, c.id);
      expect(after.hits).toBe(11);
      expect(after.version).toBe(2);
    });

    it("decrement() subtracts atomically and bumps @Version", async () => {
      const c: any = await conn.em.save(Counter, { hits: 20 });

      const result = await conn.em.decrement(Counter, { id: c.id }, "hits", 3);
      expect(result).toEqual({ affected: expect.any(Number) });

      const after: any = await conn.em.findByPK(Counter, c.id);
      expect(after.hits).toBe(17);
      expect(after.version).toBe(2);
    });

    // increment()/decrement() delegate to update(); with the connector rowCount
    // normalization they now report a real affected count on SQLite.
    it("increment()/decrement() affected count reflects rows changed", async () => {
      const c: any = await conn.em.save(Counter, { hits: 0 });
      const inc = await conn.em.increment(Counter, { id: c.id }, "hits", 1);
      expect(inc.affected).toBe(1);
      const dec = await conn.em.decrement(Counter, { id: c.id }, "hits", 1);
      expect(dec.affected).toBe(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // EntityManager.pluck
  // ───────────────────────────────────────────────────────────────────────
  describe("EntityManager.pluck", () => {
    it("returns a flat array of one column's values", async () => {
      const statuses = await conn.em.pluck(AggOrder, "status");
      expect(Array.isArray(statuses)).toBe(true);
      expect(statuses).toHaveLength(5);
      // multiset (order is DB-default without an orderBy)
      expect([...statuses].sort()).toEqual([
        "closed",
        "closed",
        "open",
        "open",
        "open",
      ]);
    });

    it("applies the WHERE filter", async () => {
      const openStatuses = await conn.em.pluck(AggOrder, "status", {
        status: "open",
      } as any);
      expect(openStatuses).toEqual(["open", "open", "open"]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // SelectQueryBuilder.getMap / pluck
  // ───────────────────────────────────────────────────────────────────────
  describe("SelectQueryBuilder.getMap / pluck", () => {
    it("getMap(pk) keys every row uniquely", async () => {
      const byId = await conn.em
        .createQueryBuilder(AggOrder, "o")
        .getMap("id");

      expect(byId.size).toBe(5);
      expect((byId.get(1) as any).amount).toBe(10);
      expect((byId.get(3) as any).status).toBe("closed");
    });

    it("getMap(non-unique) is last-wins in result order", async () => {
      const byStatus = await conn.em
        .createQueryBuilder(AggOrder, "o")
        .orderBy({ id: "ASC" })
        .getMap("status");

      // open rows: ids 1,2,5 → last wins = id 5 ; closed rows: ids 3,4 → id 4
      expect(byStatus.size).toBe(2);
      expect((byStatus.get("open") as any).id).toBe(5);
      expect((byStatus.get("closed") as any).id).toBe(4);
    });

    it("pluck(column) returns a flat array preserving ORDER BY", async () => {
      const ids = await conn.em
        .createQueryBuilder(AggOrder, "o")
        .orderBy({ id: "ASC" })
        .pluck("id");
      expect(ids).toEqual([1, 2, 3, 4, 5]);

      const statuses = await conn.em
        .createQueryBuilder(AggOrder, "o")
        .orderBy({ id: "ASC" })
        .pluck("status");
      expect(statuses).toEqual(["open", "open", "closed", "closed", "open"]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // SelectQueryBuilder.getCursor — keyset pagination
  // ───────────────────────────────────────────────────────────────────────
  describe("SelectQueryBuilder.getCursor (keyset pagination)", () => {
    it("pages through all rows with no overlap and no gap", async () => {
      // 7 rows, page size 4.
      const page1 = await conn.em
        .createQueryBuilder(CursorRow, "c")
        .getCursor({ take: 4, orderBy: "id", direction: "ASC" });

      expect(page1.data).toHaveLength(4);
      expect(page1.hasNextPage).toBe(true);
      expect(page1.nextCursor).toBeTruthy();

      const page2 = await conn.em
        .createQueryBuilder(CursorRow, "c")
        .getCursor({ take: 4, cursor: page1.nextCursor!, orderBy: "id" });

      expect(page2.data).toHaveLength(3);
      expect(page2.hasNextPage).toBe(false); // last page
      expect(page2.nextCursor).toBeNull();

      // ── The real proof: union of pages == all rows, no overlap, no gap ──
      const ids = [
        ...page1.data.map((r: any) => r.id),
        ...page2.data.map((r: any) => r.id),
      ];
      expect(ids).toHaveLength(7); // no overlap (would exceed 7) and no short page
      expect(new Set(ids).size).toBe(7); // no duplicate id across pages
      expect([...ids].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]); // no gap
    });

    it("defaults the sort column to the primary key", async () => {
      const page = await conn.em
        .createQueryBuilder(CursorRow, "c")
        .getCursor({ take: 3 });

      expect(page.data).toHaveLength(3);
      expect(page.data.map((r: any) => r.id)).toEqual([1, 2, 3]);
      expect(page.hasNextPage).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // EntityManager.insertManyAndReturn — multi-row INSERT ... RETURNING *
  // On SQLite (3.35+, via better-sqlite3) RETURNING brings the generated PKs
  // back without a re-read; this proves real PKs are populated, in input order.
  // ───────────────────────────────────────────────────────────────────────
  describe("EntityManager.insertManyAndReturn", () => {
    it("returns inserted entities with real generated PKs, in input order, persisted", async () => {
      const items = [
        { label: "alpha", seq: 100 },
        { label: "beta", seq: 200 },
        { label: "gamma", seq: 300 },
      ];

      const inserted: any[] = await conn.em.insertManyAndReturn(
        BatchReturn,
        items,
      );

      // 1) length matches input
      expect(inserted).toHaveLength(3);

      // 2) every element carries a real, defined, integer PK > 0
      for (const row of inserted) {
        expect(row.id).toBeDefined();
        expect(typeof row.id).toBe("number");
        expect(Number.isInteger(row.id)).toBe(true);
        expect(row.id).toBeGreaterThan(0);
      }

      // 3) PKs are unique AND strictly increasing across the batch
      const ids = inserted.map((r) => r.id as number);
      expect(new Set(ids).size).toBe(3);
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i]).toBeGreaterThan(ids[i - 1]);
      }

      // 4) input ORDER preserved — element i corresponds to input i, asserted on
      //    the distinguishing non-PK columns (label + seq), not the PK.
      expect(inserted.map((r) => r.label)).toEqual(["alpha", "beta", "gamma"]);
      expect(inserted.map((r) => r.seq)).toEqual([100, 200, 300]);

      // 5) rows are actually persisted — findByPK round-trips each one with the
      //    same generated PK and column values.
      for (const row of inserted) {
        const found: any = await conn.em.findByPK(BatchReturn, row.id);
        expect(found).not.toBeNull();
        expect(found.id).toBe(row.id);
        expect(found.label).toBe(row.label);
        expect(found.seq).toBe(row.seq);
      }

      // 6) cross-check via find(): the same three ids exist and map to labels.
      const all: any[] = await conn.em.find(BatchReturn, {
        orderBy: { id: "ASC" } as any,
      });
      const byId = new Map(all.map((r) => [r.id, r.label]));
      for (const row of inserted) {
        expect(byId.get(row.id)).toBe(row.label);
      }
    });

    it("returns an empty array for an empty input (no SQL executed)", async () => {
      const inserted = await conn.em.insertManyAndReturn(BatchReturn, []);
      expect(inserted).toEqual([]);
    });
  });
});
