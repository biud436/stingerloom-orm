/**
 * SQLite In-Memory: relation paths agree with find()/relations on soft-delete,
 * eager loading and cascade (backlog V6-T1-5).
 *
 * Four paths diverged from `find(Entity, { relations })`:
 *
 *  1. SelectQueryBuilder relation JOINs (`leftJoinRelation*` /
 *     `innerJoinRelation*`) and the `whereHas` / `withCount` subqueries put
 *     only the tenant predicate on the joined side — a soft-deleted child was
 *     hydrated, matched an INNER JOIN, and counted; a soft-deleted parent was
 *     hydrated where `find()` gives null.
 *  2. `findWithCursor()` ignored `eager: true` and had no `relations` option,
 *     so a cursor page hydrated the relation as null / missing.
 *  3. `softDelete()` / `restore()` did not cascade to `cascade: ["remove"]`
 *     children even when the child carries `@DeletedAt`.
 *  4. `deleteMany()` was a bare `DELETE ... WHERE pk IN (...)` — no cascade and
 *     no before/afterDelete events — so with FK constraints on it failed, and
 *     with them off it orphaned the children.
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
  ManyToOne,
  OneToMany,
  DeletedAt,
} from "../../../src";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import {
  ColumnScanner,
  ManyToOneScanner,
  OneToManyScanner,
  ManyToManyScanner,
  OneToOneScanner,
} from "../../../src/scanner";
import type { EntitySubscriber } from "../../../src/core/EntitySubscriber";

function shortName(prefix: string): string {
  return `${prefix}_${String(Date.now()).slice(-7)}`;
}

function clearScanners(): void {
  getScannerInstance(ColumnScanner).clear();
  getScannerInstance(ManyToOneScanner).clear();
  getScannerInstance(OneToManyScanner).clear();
  getScannerInstance(ManyToManyScanner).clear();
  getScannerInstance(OneToOneScanner).clear();
}

describe("[Integration] SQLite: relation paths mirror find()/relations (V6-T1-5)", () => {
  let conn: TestConnectionResult;
  let Author: new () => any;
  let Book: new () => any;
  const authorTable = shortName("rps_author");
  const bookTable = shortName("rps_book");

  beforeAll(async () => {
    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
      },
      () => {
        clearScanners();

        @Entity({ name: authorTable })
        class AuthorEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() name!: string;
          @DeletedAt() deletedAt!: Date | null;
          @OneToMany(() => BookEntity, { mappedBy: "author", cascade: ["remove"] })
          books!: any[];
        }

        @Entity({ name: bookTable })
        class BookEntity {
          @PrimaryGeneratedColumn() id!: number;
          @Column() title!: string;
          @Column({ type: "int", nullable: true }) authorId!: number | null;
          @DeletedAt() deletedAt!: Date | null;
          @ManyToOne(() => AuthorEntity, (a: any) => a.books, {
            joinColumn: "authorId",
            eager: true,
          })
          author!: any;
        }

        Author = AuthorEntity;
        Book = BookEntity;
        return { entities: [AuthorEntity, BookEntity] };
      },
    );
  }, 30000);

  afterAll(async () => {
    await conn?.cleanup();
  });

  beforeEach(async () => {
    await conn.em.query(`DELETE FROM "${bookTable}"`);
    await conn.em.query(`DELETE FROM "${authorTable}"`);
  });

  async function seed() {
    const em = conn.em;
    const a1 = await em.save(Author, { name: "A1" });
    const a2 = await em.save(Author, { name: "A2" });
    const a3 = await em.save(Author, { name: "A3" });
    const b1 = await em.save(Book, { title: "B1", authorId: a1.id });
    const b2 = await em.save(Book, { title: "B2", authorId: a1.id });
    const b3 = await em.save(Book, { title: "B3", authorId: a2.id });
    await em.softDelete(Book, { id: b1.id }); // A1 keeps one live child
    await em.softDelete(Book, { id: b3.id }); // A2's only child is trashed
    await em.softDelete(Author, { id: a3.id }); // B4's parent is trashed...
    // ...but B4 itself stays live: saved after the parent's softDelete so
    // the cascade (exercised separately below) does not reach it.
    const b4 = await em.save(Book, { title: "B4", authorId: a3.id });
    return { a1, a2, a3, b1, b2, b3, b4 };
  }

  // ── 1. SelectQueryBuilder relation JOINs / subqueries ───────────────────

  describe("SelectQueryBuilder relation JOIN soft-delete", () => {
    it("leftJoinRelationAndSelect hides a soft-deleted child like relations does", async () => {
      const { a1 } = await seed();
      const em = conn.em;

      const viaFind = await em.findOne(Author, { where: { id: a1.id }, relations: ["books"] });
      expect(viaFind.books.map((b: any) => b.title)).toEqual(["B2"]);

      const viaQb = await em
        .createQueryBuilder(Author, "a")
        .leftJoinRelationAndSelect("books", "b")
        .where("a.id", a1.id)
        .getOne();
      expect(viaQb.books.map((b: any) => b.title)).toEqual(["B2"]);
    });

    it("innerJoinRelation does not match a parent whose only child is soft-deleted, and getCount agrees", async () => {
      await seed();
      const qb = conn.em
        .createQueryBuilder(Author, "a")
        .innerJoinRelation("books", "b")
        .orderBy({ name: "ASC" } as any);
      const rows = await qb.clone().getMany();
      expect(rows.map((r: any) => r.name)).toEqual(["A1"]);
      expect(await qb.clone().getCount()).toBe(1);
      expect(await qb.clone().exists()).toBe(true);
    });

    it("leftJoinRelationAndSelect hydrates a soft-deleted parent as null (ManyToOne direction)", async () => {
      const { b4 } = await seed();
      const em = conn.em;
      const viaFind = await em.findOne(Book, { where: { id: b4.id } });
      expect(viaFind.author).toBeNull();

      const viaQb = await em
        .createQueryBuilder(Book, "bk")
        .leftJoinRelationAndSelect("author", "au")
        .where("bk.id", b4.id)
        .getOne();
      expect(viaQb.author).toBeNull();
    });

    it("withDeleted() lifts the JOIN filter too", async () => {
      const { a1 } = await seed();
      const viaQb = await conn.em
        .createQueryBuilder(Author, "a")
        .leftJoinRelationAndSelect("books", "b")
        .withDeleted()
        .where("a.id", a1.id)
        .getOne();
      expect(viaQb.books.map((b: any) => b.title).sort()).toEqual(["B1", "B2"]);
    });

    it("an explicit entity leftJoin() is left untouched (user owns the ON clause)", async () => {
      const { a2 } = await seed();
      // Audit query: parents with a soft-deleted child — the inverse of the
      // relation join contract, which must stay expressible.
      const rows = await conn.em
        .createQueryBuilder(Author, "a")
        .innerJoin(Book, "b", (j: any) => j.on("a.id", "=", "b.authorId").onNotNull("b.deletedAt"))
        .where("a.id", a2.id)
        .getMany();
      expect(rows.map((r: any) => r.name)).toEqual(["A2"]);
    });

    it("whereHas / whereNotHas / withCount ignore soft-deleted children", async () => {
      await seed();
      const em = conn.em;
      const has = await em
        .createQueryBuilder(Author, "a")
        .whereHas("books")
        .orderBy({ name: "ASC" } as any)
        .getMany();
      expect(has.map((r: any) => r.name)).toEqual(["A1"]);

      const hasNot = await em
        .createQueryBuilder(Author, "a")
        .whereNotHas("books")
        .orderBy({ name: "ASC" } as any)
        .getMany();
      expect(hasNot.map((r: any) => r.name)).toEqual(["A2"]);

      const counts = await em
        .createQueryBuilder(Author, "a")
        .withCount("books", "bookCount")
        .orderBy({ name: "ASC" } as any)
        .getRawMany();
      expect(counts.map((r: any) => [r.name, Number(r.bookCount)])).toEqual([
        ["A1", 1],
        ["A2", 0],
      ]);
    });

    it("whereHas counts soft-deleted children again under withDeleted() or sub.withDeleted()", async () => {
      await seed();
      const em = conn.em;
      const outer = await em
        .createQueryBuilder(Author, "a")
        .withDeleted()
        .whereHas("books")
        .orderBy({ name: "ASC" } as any)
        .getMany();
      expect(outer.map((r: any) => r.name)).toEqual(["A1", "A2", "A3"]);

      const inner = await em
        .createQueryBuilder(Author, "a")
        .whereHas("books", (sub: any) => sub.withDeleted())
        .orderBy({ name: "ASC" } as any)
        .getMany();
      expect(inner.map((r: any) => r.name)).toEqual(["A1", "A2"]);
    });
  });

  // ── 2. findWithCursor eager / relations ─────────────────────────────────

  describe("findWithCursor eager and relations", () => {
    it("loads eager ManyToOne on a cursor page exactly like find()", async () => {
      await seed();
      const em = conn.em;
      const viaFind = await em.find(Book, { orderBy: { id: "ASC" } });
      expect(viaFind.map((b: any) => [b.title, b.author?.name ?? null])).toEqual([
        ["B2", "A1"],
        ["B4", null],
      ]);

      const page = await em.findWithCursor(Book, { take: 10, orderBy: "id" });
      expect(page.data.map((b: any) => [b.title, b.author?.name ?? null])).toEqual([
        ["B2", "A1"],
        ["B4", null],
      ]);
    });

    it("loads the eager parent with withDeleted: true, including a trashed one", async () => {
      await seed();
      const page = await conn.em.findWithCursor(Book, {
        take: 10,
        orderBy: "id",
        withDeleted: true,
      });
      expect(page.data.map((b: any) => [b.title, b.author?.name ?? null])).toEqual([
        ["B1", "A1"],
        ["B2", "A1"],
        ["B3", "A2"],
        ["B4", "A3"],
      ]);
    });

    it("accepts relations: [...] and loads OneToMany children per page", async () => {
      await seed();
      const page = await conn.em.findWithCursor(Author, {
        take: 10,
        orderBy: "id",
        relations: ["books"],
      } as any);
      expect(page.data.map((a: any) => [a.name, a.books.map((b: any) => b.title)])).toEqual([
        ["A1", ["B2"]],
        ["A2", []],
      ]);
    });

    it("afterLoad subscribers see the eager relation attached", async () => {
      await seed();
      const seen: Array<string | null> = [];
      const subscriber: EntitySubscriber<any> = {
        listenTo: () => Book,
        afterLoad: (entity: any) => {
          seen.push(entity.author?.name ?? null);
        },
      };
      conn.em.addSubscriber(subscriber);
      try {
        await conn.em.findWithCursor(Book, { take: 10, orderBy: "id" });
      } finally {
        conn.em.removeSubscriber(subscriber);
      }
      expect(seen).toEqual(["A1", null]);
    });
  });

  // ── 3. softDelete / restore cascade ─────────────────────────────────────

  describe("softDelete / restore cascade", () => {
    it("softDelete(parent) trashes cascade children that carry @DeletedAt", async () => {
      const em = conn.em;
      const a = await em.save(Author, { name: "P" });
      await em.save(Book, { title: "C1", authorId: a.id });
      const c2 = await em.save(Book, { title: "C2", authorId: a.id });
      await em.softDelete(Book, { id: c2.id });
      const c2Before = await em.findOne(Book, { where: { id: c2.id }, withDeleted: true });

      const result = await em.softDelete(Author, { id: a.id });
      expect(result.affected).toBe(1);

      const live = await em.find(Book, { where: { authorId: a.id } });
      expect(live).toEqual([]);
      const all = await em.find(Book, { where: { authorId: a.id }, withDeleted: true, orderBy: { id: "ASC" } });
      expect(all.map((b: any) => [b.title, b.deletedAt !== null])).toEqual([
        ["C1", true],
        ["C2", true],
      ]);
      // A child that was already trashed keeps its original stamp.
      expect(all[1].deletedAt.getTime()).toBe(c2Before.deletedAt.getTime());
    });

    it("restore(parent) revives the children that were trashed with it", async () => {
      const em = conn.em;
      const a = await em.save(Author, { name: "R" });
      await em.save(Book, { title: "K1", authorId: a.id });
      await em.save(Book, { title: "K2", authorId: a.id });
      await em.softDelete(Author, { id: a.id });
      expect(await em.find(Book, { where: { authorId: a.id } })).toEqual([]);

      const result = await em.restore(Author, { id: a.id });
      expect(result.affected).toBe(1);
      const live = await em.find(Book, { where: { authorId: a.id }, orderBy: { id: "ASC" } });
      expect(live.map((b: any) => b.title)).toEqual(["K1", "K2"]);
    });

    it("softDelete on an unrelated parent leaves other parents' children alone", async () => {
      const em = conn.em;
      const a = await em.save(Author, { name: "X" });
      const other = await em.save(Author, { name: "Y" });
      await em.save(Book, { title: "X1", authorId: a.id });
      await em.save(Book, { title: "Y1", authorId: other.id });
      await em.softDelete(Author, { id: a.id });
      const live = await em.find(Book, { orderBy: { id: "ASC" } });
      expect(live.map((b: any) => b.title)).toEqual(["Y1"]);
    });

    it("parent softDelete events fire once (children fire their own)", async () => {
      const em = conn.em;
      const a = await em.save(Author, { name: "E" });
      await em.save(Book, { title: "E1", authorId: a.id });
      const events: string[] = [];
      const sub: EntitySubscriber<any> = {
        listenTo: () => Author,
        afterSoftDelete: async () => {
          events.push("author");
        },
      };
      em.addSubscriber(sub);
      try {
        await em.softDelete(Author, { id: a.id });
      } finally {
        em.removeSubscriber(sub);
      }
      expect(events).toEqual(["author"]);
    });
  });

  // ── 4. deleteMany cascade ───────────────────────────────────────────────

  describe("deleteMany cascade", () => {
    it("deleteMany(parent ids) cascades to children and fires delete events", async () => {
      const em = conn.em;
      const a = await em.save(Author, { name: "D1" });
      const b = await em.save(Author, { name: "D2" });
      const keep = await em.save(Author, { name: "D3" });
      await em.save(Book, { title: "D1-1", authorId: a.id });
      await em.save(Book, { title: "D2-1", authorId: b.id });
      await em.save(Book, { title: "D3-1", authorId: keep.id });

      const events: string[] = [];
      const sub: EntitySubscriber<any> = {
        listenTo: () => Author,
        beforeDelete: async () => {
          events.push("before");
        },
        afterDelete: async () => {
          events.push("after");
        },
      };
      em.addSubscriber(sub);
      let result;
      try {
        result = await em.deleteMany(Author, [a.id, b.id]);
      } finally {
        em.removeSubscriber(sub);
      }
      expect(result.affected).toBe(2);
      expect(events).toEqual(["before", "after"]);

      const books = await em.find(Book, { withDeleted: true, orderBy: { id: "ASC" } });
      expect(books.map((bk: any) => bk.title)).toEqual(["D3-1"]);
      const authors = await em.find(Author, { withDeleted: true });
      expect(authors.map((x: any) => x.name)).toEqual(["D3"]);
    });
  });
});
