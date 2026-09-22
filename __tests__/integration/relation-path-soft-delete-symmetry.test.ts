/**
 * 관계 경로 대칭 통합 테스트 (MySQL / PostgreSQL 공통, backlog V6-T1-5)
 *
 * `find(Entity, { relations })`가 지키는 계약을 다른 세 경로도 똑같이 지키는지
 * 실제 드라이버에서 확인합니다.
 *
 * - SelectQueryBuilder 관계 JOIN(`leftJoinRelationAndSelect` / `innerJoinRelation`)과
 *   `whereHas` / `withCount` 서브쿼리가 soft-deleted 자식·부모를 숨긴다
 * - `findWithCursor()`가 eager ManyToOne을 로드하고 `relations` 옵션을 받는다
 * - `softDelete()` / `restore()`가 `cascade: ["remove"]` 자식(@DeletedAt 보유)에
 *   연쇄된다
 * - `deleteMany()`가 delete()와 같이 cascade + before/afterDelete 이벤트를 낸다
 *
 * SQLite 판: __tests__/integration/sqlite/relation-path-soft-delete-symmetry.test.ts
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import {
  createTestConnection,
  dropTestTable,
  truncateTestTable,
  rawQuery,
  type TestConnectionResult,
} from "./helpers/test-connection";
import {
  getTestDrivers,
  type TestDriverConfig,
} from "./helpers/driver-config";
import { disableFkChecksSql, enableFkChecksSql } from "./helpers/driver-helpers";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  OneToMany,
  DeletedAt,
} from "../../src";
import { getScannerInstance } from "../../src/scanner/ScannerContainer";
import {
  ColumnScanner,
  ManyToOneScanner,
  OneToManyScanner,
  ManyToManyScanner,
  OneToOneScanner,
} from "../../src/scanner";
import type { EntitySubscriber } from "../../src/core/EntitySubscriber";

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

describe.each(getTestDrivers())(
  "[Integration] $label: relation paths mirror find()/relations (V6-T1-5)",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let Author: new () => any;
    let Book: new () => any;
    // FK 이름 길이 제한(64자) 때문에 짧은 prefix
    const authorTable = shortName("rpa");
    const bookTable = shortName("rpb");

    beforeAll(async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
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
      em = conn.em;
    }, 30000);

    afterAll(async () => {
      try {
        await rawQuery(disableFkChecksSql(type));
        await dropTestTable(bookTable);
        await dropTestTable(authorTable);
        await rawQuery(enableFkChecksSql(type));
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 15000);

    beforeEach(async () => {
      await truncateTestTable(bookTable);
      await truncateTestTable(authorTable);
    });

    /**
     * A1 → B1(trashed), B2 / A2 → B3(trashed) / A3(trashed) → B4(live).
     * B4는 부모 softDelete 뒤에 저장해 cascade가 닿지 않게 한다.
     */
    async function seed() {
      const a1 = await em.save(Author, { name: "A1" });
      const a2 = await em.save(Author, { name: "A2" });
      const a3 = await em.save(Author, { name: "A3" });
      const b1 = await em.save(Book, { title: "B1", authorId: a1.id });
      const b2 = await em.save(Book, { title: "B2", authorId: a1.id });
      const b3 = await em.save(Book, { title: "B3", authorId: a2.id });
      await em.softDelete(Book, { id: b1.id });
      await em.softDelete(Book, { id: b3.id });
      await em.softDelete(Author, { id: a3.id });
      const b4 = await em.save(Book, { title: "B4", authorId: a3.id });
      return { a1, a2, a3, b1, b2, b3, b4 };
    }

    describe("SelectQueryBuilder relation JOIN / subquery soft-delete", () => {
      it("leftJoinRelationAndSelect hides a soft-deleted child; withDeleted() shows it", async () => {
        const { a1 } = await seed();
        const qb = em
          .createQueryBuilder(Author, "a")
          .leftJoinRelationAndSelect("books", "b")
          .where("a.id", a1.id);
        const filtered = await qb.clone().getOne();
        expect(filtered.books.map((b: any) => b.title)).toEqual(["B2"]);
        const lifted = await qb.clone().withDeleted().getOne();
        expect(lifted.books.map((b: any) => b.title).sort()).toEqual(["B1", "B2"]);
      });

      it("innerJoinRelation drops a parent whose only child is soft-deleted (getMany / getCount / exists)", async () => {
        await seed();
        const qb = em
          .createQueryBuilder(Author, "a")
          .innerJoinRelation("books", "b")
          .orderBy({ name: "ASC" } as any);
        expect((await qb.clone().getMany()).map((r: any) => r.name)).toEqual(["A1"]);
        expect(await qb.clone().getCount()).toBe(1);
        expect(await qb.clone().exists()).toBe(true);
      });

      it("leftJoinRelationAndSelect hydrates a soft-deleted parent as null", async () => {
        const { b4 } = await seed();
        const row = await em
          .createQueryBuilder(Book, "bk")
          .leftJoinRelationAndSelect("author", "au")
          .where("bk.id", b4.id)
          .getOne();
        expect(row.author).toBeNull();
      });

      it("whereHas / whereNotHas / withCount exclude soft-deleted children", async () => {
        await seed();
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
    });

    describe("findWithCursor eager / relations", () => {
      it("loads eager ManyToOne on the page like find(); withDeleted lifts it", async () => {
        await seed();
        const page = await em.findWithCursor(Book, { take: 10, orderBy: "id" });
        expect(page.data.map((b: any) => [b.title, b.author?.name ?? null])).toEqual([
          ["B2", "A1"],
          ["B4", null],
        ]);
        const all = await em.findWithCursor(Book, { take: 10, orderBy: "id", withDeleted: true });
        expect(all.data.map((b: any) => [b.title, b.author?.name ?? null])).toEqual([
          ["B1", "A1"],
          ["B2", "A1"],
          ["B3", "A2"],
          ["B4", "A3"],
        ]);
      });

      it("relations: ['books'] loads the OneToMany side per page, across pages", async () => {
        await seed();
        const first = await em.findWithCursor(Author, { take: 1, orderBy: "id", relations: ["books"] });
        expect(first.data.map((a: any) => [a.name, a.books.map((b: any) => b.title)])).toEqual([
          ["A1", ["B2"]],
        ]);
        expect(first.hasNextPage).toBe(true);
        const second = await em.findWithCursor(Author, {
          take: 1,
          orderBy: "id",
          relations: ["books"],
          cursor: first.nextCursor!,
        });
        expect(second.data.map((a: any) => [a.name, a.books.map((b: any) => b.title)])).toEqual([
          ["A2", []],
        ]);
      });
    });

    describe("softDelete / restore / deleteMany cascade", () => {
      it("softDelete(parent) trashes the children, restore(parent) brings them back", async () => {
        const a = await em.save(Author, { name: "P" });
        await em.save(Book, { title: "C1", authorId: a.id });
        const c2 = await em.save(Book, { title: "C2", authorId: a.id });
        await em.softDelete(Book, { id: c2.id });
        const c2Before = await em.findOne(Book, { where: { id: c2.id }, withDeleted: true });

        expect((await em.softDelete(Author, { id: a.id })).affected).toBe(1);
        expect(await em.find(Book, { where: { authorId: a.id } })).toEqual([]);
        const trashed = await em.find(Book, {
          where: { authorId: a.id },
          withDeleted: true,
          orderBy: { id: "ASC" },
        });
        expect(trashed.map((b: any) => [b.title, b.deletedAt !== null])).toEqual([
          ["C1", true],
          ["C2", true],
        ]);
        // 이미 trashed였던 자식의 원래 stamp는 덮어쓰지 않는다.
        expect(new Date(trashed[1].deletedAt).getTime()).toBe(
          new Date(c2Before.deletedAt).getTime(),
        );

        expect((await em.restore(Author, { id: a.id })).affected).toBe(1);
        const live = await em.find(Book, { where: { authorId: a.id }, orderBy: { id: "ASC" } });
        expect(live.map((b: any) => b.title)).toEqual(["C1", "C2"]);
      });

      it("deleteMany(parent ids) removes the children first and fires delete events", async () => {
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
        const books = await em.find(Book, { withDeleted: true });
        expect(books.map((bk: any) => bk.title)).toEqual(["D3-1"]);
      });
    });
  },
);
