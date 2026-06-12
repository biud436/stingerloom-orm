/**
 * SQLite integration test for getCount() / getManyAndCount() under a to-many
 * `*AndSelect` join.
 *
 * A `leftJoinRelationAndSelect("books", ...)` join multiplies author rows by
 * the number of joined books. getCount() must count distinct root authors, not
 * the multiplied joined rows, so getManyAndCount() reports the real root total.
 *
 * Guarded like its siblings: only runs under INTEGRATION_TEST=true (the suite
 * is excluded from the default unit run by jest config).
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

describe("[Integration] SQLite In-Memory: getCount() distinct roots (to-many *AndSelect)", () => {
  let conn: TestConnectionResult;
  let Author: new () => any;
  let Book: new () => any;

  beforeAll(async () => {
    const authorTable = shortTableName("cnt_author");
    const bookTable = shortTableName("cnt_book");

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

    // 3 authors with 2/3/2 books = 7 joined rows total.
    const { em } = conn;
    const a1 = await em.save(Author, { name: "Author 1" });
    const a2 = await em.save(Author, { name: "Author 2" });
    const a3 = await em.save(Author, { name: "Author 3" });
    const counts: Array<[any, number]> = [
      [a1, 2],
      [a2, 3],
      [a3, 2],
    ];
    for (const [author, n] of counts) {
      for (let i = 1; i <= n; i++) {
        await em.save(Book, { title: `${author.name} - book ${i}`, authorFk: author.id });
      }
    }
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("getCount() returns the distinct root count, not the multiplied join row count", async () => {
    const total = await conn.em
      .createQueryBuilder(Author, "a")
      .leftJoinRelationAndSelect("books", "b")
      .getCount();

    // 3 authors, not 7 books.
    expect(total).toBe(3);
  });

  it("getCount() agrees with the grouped-root result of an unpaged getMany()", async () => {
    // SQLite's single connection cannot hold two concurrent transactions, so
    // run the count and the data query sequentially rather than via
    // getManyAndCount()'s Promise.all.
    const total = await conn.em
      .createQueryBuilder(Author, "a")
      .leftJoinRelationAndSelect("books", "b")
      .getCount();
    const rows = await conn.em
      .createQueryBuilder(Author, "a")
      .leftJoinRelationAndSelect("books", "b")
      .orderBy({ id: "ASC" })
      .getMany();

    expect(total).toBe(3);
    expect(rows).toHaveLength(3);
    // Child arrays are fully populated for an unpaged query.
    expect(rows.map((r) => (r.books as any[]).length)).toEqual([2, 3, 2]);
  });

  it("plain leftJoinRelation (no *AndSelect) keeps the multiplied row count", async () => {
    const total = await conn.em
      .createQueryBuilder(Author, "a")
      .leftJoinRelation("books", "b")
      .getCount();

    // No joined selection -> caller-visible row count (7 joined rows).
    expect(total).toBe(7);
  });
});
