/**
 * SQLite integration test for two-phase root pagination under a to-many
 * `*AndSelect` join.
 *
 * With `leftJoinRelationAndSelect("books", ...)`, a naive LIMIT/OFFSET applies
 * to the JOIN-multiplied rows, so a page can hold fewer roots than pageSize and
 * a root's child array can be truncated at the page boundary. paginate() now
 * resolves the page of distinct roots first (phase 1) and re-runs the full
 * query filtered to those roots (phase 2), so each page holds exactly pageSize
 * roots with complete child arrays.
 *
 * Guarded like its siblings: only runs under INTEGRATION_TEST=true.
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
} from "../../../src";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import {
  ColumnScanner,
  ManyToOneScanner,
  OneToManyScanner,
} from "../../../src/scanner";
import { DatabaseClient } from "../../../src/DatabaseClient";

function shortTableName(prefix: string): string {
  const ts = String(Date.now()).slice(-7);
  return `${prefix}_${ts}`;
}

function clearScanners(): void {
  getScannerInstance(ColumnScanner).clear();
  getScannerInstance(ManyToOneScanner).clear();
  getScannerInstance(OneToManyScanner).clear();
}

describe("[Integration] SQLite In-Memory: paginate() root pages (to-many *AndSelect)", () => {
  let conn: TestConnectionResult;
  let Author: new () => any;
  let Book: new () => any;

  beforeAll(async () => {
    const authorTable = shortTableName("pg_author");
    const bookTable = shortTableName("pg_book");

    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: false,
        logging: false,
      },
      () => {
        clearScanners();

        const AC = class {} as any;
        Object.defineProperty(AC, "name", { value: authorTable, writable: false });
        Reflect.defineMetadata("design:type", Number, AC.prototype, "id");
        PrimaryGeneratedColumn()(AC.prototype, "id");
        Reflect.defineMetadata("design:type", String, AC.prototype, "name");
        Column()(AC.prototype, "name");
        Reflect.defineMetadata("design:type", Array, AC.prototype, "books");
        OneToMany(() => BC, { mappedBy: "author" })(AC.prototype, "books");
        Entity()(AC);

        const BC = class {} as any;
        Object.defineProperty(BC, "name", { value: bookTable, writable: false });
        Reflect.defineMetadata("design:type", Number, BC.prototype, "id");
        PrimaryGeneratedColumn()(BC.prototype, "id");
        Reflect.defineMetadata("design:type", String, BC.prototype, "title");
        Column()(BC.prototype, "title");
        Reflect.defineMetadata("design:type", Number, BC.prototype, "authorFk");
        Column({ type: "int", nullable: true })(BC.prototype, "authorFk");
        Reflect.defineMetadata("design:type", AC, BC.prototype, "author");
        ManyToOne(() => AC, (e: any) => e.author, { joinColumn: "authorFk" })(
          BC.prototype,
          "author",
        );
        Entity()(BC);

        Author = AC;
        Book = BC;
        return { entities: [AC, BC] };
      },
    );

    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(`
      CREATE TABLE IF NOT EXISTS "${authorTable}" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "name" TEXT NOT NULL DEFAULT ''
      )
    `);
    await connector.query(`
      CREATE TABLE IF NOT EXISTS "${bookTable}" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "title" TEXT NOT NULL DEFAULT '',
        "authorFk" INTEGER
      )
    `);

    // 3 authors with 2 / 3 / 2 books respectively (7 joined rows).
    const { em } = conn;
    const a1 = await em.save(Author, { name: "Author 1" });
    const a2 = await em.save(Author, { name: "Author 2" });
    const a3 = await em.save(Author, { name: "Author 3" });
    const plan: Array<[any, number]> = [
      [a1, 2],
      [a2, 3],
      [a3, 2],
    ];
    for (const [author, n] of plan) {
      for (let i = 1; i <= n; i++) {
        await em.save(Book, { title: `${author.name} - book ${i}`, authorFk: author.id });
      }
    }
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("page 1 (pageSize 2) holds exactly 2 roots with FULL child arrays", async () => {
    const page1 = await conn.em
      .createQueryBuilder(Author, "a")
      .leftJoinRelationAndSelect("books", "b")
      .orderBy({ id: "ASC" })
      .paginate({ page: 1, pageSize: 2 });

    // Distinct-root metadata: 3 authors total across 2 pages.
    expect(page1.total).toBe(3);
    expect(page1.totalPages).toBe(2);
    expect(page1.hasNextPage).toBe(true);
    expect(page1.hasPreviousPage).toBe(false);

    // Exactly 2 roots, each with its complete (untruncated) child array.
    expect(page1.data).toHaveLength(2);
    expect(page1.data.map((a) => a.id)).toEqual([1, 2]);
    expect(page1.data[0].books).toHaveLength(2);
    expect(page1.data[1].books).toHaveLength(3);
  });

  it("page 2 (pageSize 2) holds the remaining root with full children", async () => {
    const page2 = await conn.em
      .createQueryBuilder(Author, "a")
      .leftJoinRelationAndSelect("books", "b")
      .orderBy({ id: "ASC" })
      .paginate({ page: 2, pageSize: 2 });

    expect(page2.total).toBe(3);
    expect(page2.totalPages).toBe(2);
    expect(page2.hasNextPage).toBe(false);
    expect(page2.hasPreviousPage).toBe(true);

    expect(page2.data).toHaveLength(1);
    expect(page2.data[0].id).toBe(3);
    expect(page2.data[0].books).toHaveLength(2);
  });

  it("getMany() with explicit limit/offset windows whole roots", async () => {
    const rows = await conn.em
      .createQueryBuilder(Author, "a")
      .leftJoinRelationAndSelect("books", "b")
      .orderBy({ id: "ASC" })
      .offset(1)
      .limit(1)
      .getMany();

    // One whole root (the 2nd author) with all 3 of its books.
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(2);
    expect(rows[0].books).toHaveLength(3);
  });

  it("respects DESC ordering of roots across the page", async () => {
    const page1 = await conn.em
      .createQueryBuilder(Author, "a")
      .leftJoinRelationAndSelect("books", "b")
      .orderBy({ id: "DESC" })
      .paginate({ page: 1, pageSize: 2 });

    expect(page1.data.map((a) => a.id)).toEqual([3, 2]);
    expect(page1.data[0].books).toHaveLength(2); // author 3
    expect(page1.data[1].books).toHaveLength(3); // author 2
  });
});
