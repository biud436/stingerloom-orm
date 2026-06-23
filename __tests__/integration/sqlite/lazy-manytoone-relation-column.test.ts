/**
 * SQLite In-Memory: lazy @ManyToOne backed by a snake_cased @RelationColumn FK.
 *
 * Regression: ReadExecutor injected the lazy proxy only when it could read the
 * FK from the hydrated entity by the DB column name (`author_id`). But
 * ResultTransformer remaps that column onto the shadow property (`authorId`),
 * so the read returned undefined and the proxy was never injected — accessing
 * `post.author` resolved to undefined even though the FK was present.
 *
 * The loader must read the shadow first (`authorId`) and fall back to the raw
 * join column for plain @ManyToOne entities.
 *
 * SQLite has no ALTER TABLE ADD FOREIGN KEY → synchronize:false + manual DDL.
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
  RelationColumn,
} from "../../../src";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import {
  ColumnScanner,
  ManyToOneScanner,
  OneToManyScanner,
} from "../../../src/scanner";
import { DatabaseClient } from "../../../src/DatabaseClient";

function shortName(prefix: string): string {
  return `${prefix}_${String(Date.now()).slice(-7)}`;
}

function clearScanners(): void {
  getScannerInstance(ColumnScanner).clear();
  getScannerInstance(ManyToOneScanner).clear();
  getScannerInstance(OneToManyScanner).clear();
}

describe("[Integration] SQLite: lazy @ManyToOne via snake_cased @RelationColumn", () => {
  let conn: TestConnectionResult;
  let PostClass: new () => any;
  let usersTable: string;
  let postsTable: string;

  beforeAll(async () => {
    usersTable = shortName("lz_users");
    postsTable = shortName("lz_posts");

    let UC: any;

    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: false,
        logging: false,
      },
      () => {
        clearScanners();

        UC = class {} as any;
        Object.defineProperty(UC, "name", { value: usersTable });
        Reflect.defineMetadata("design:type", Number, UC.prototype, "id");
        PrimaryGeneratedColumn()(UC.prototype, "id");
        Reflect.defineMetadata("design:type", String, UC.prototype, "name");
        Column()(UC.prototype, "name");
        Entity()(UC);

        const PC = class {} as any;
        Object.defineProperty(PC, "name", { value: postsTable });
        Reflect.defineMetadata("design:type", Number, PC.prototype, "id");
        PrimaryGeneratedColumn()(PC.prototype, "id");
        Reflect.defineMetadata("design:type", String, PC.prototype, "title");
        Column()(PC.prototype, "title");
        // FK declared via @RelationColumn → the hydrated entity stores it under
        // the `authorId` shadow, not `author_id`. The relation is lazy.
        Reflect.defineMetadata("design:type", UC, PC.prototype, "author");
        ManyToOne(() => UC, (u: any) => u.posts, { lazy: true })(
          PC.prototype,
          "author",
        );
        RelationColumn({ name: "author_id" })(PC.prototype, "author");
        Entity()(PC);

        PostClass = PC;
        return { entities: [UC, PC] };
      },
    );

    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(`
      CREATE TABLE IF NOT EXISTS "${usersTable}" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "name" TEXT NOT NULL DEFAULT ''
      )
    `);
    await connector.query(`
      CREATE TABLE IF NOT EXISTS "${postsTable}" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "title" TEXT NOT NULL DEFAULT '',
        "author_id" INTEGER
      )
    `);

    await connector.query(`INSERT INTO "${usersTable}" ("id","name") VALUES (1,'Alice')`);
    await connector.query(`INSERT INTO "${postsTable}" ("id","title","author_id") VALUES (10,'A1',1)`);
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("injects a lazy proxy that resolves the parent via the FK shadow", async () => {
    const { em } = conn;

    const post = await em.findOne(PostClass, { where: { id: 10 } as any });
    expect(post).toBeDefined();
    // The FK is hydrated under the shadow property, not the raw column name.
    expect((post as any).authorId).toBe(1);

    // Accessing the lazy relation returns a promise that resolves the parent.
    const author = await (post as any).author;
    expect(author).toBeDefined();
    expect(author.name).toBe("Alice");
  });

  it("leaves the relation unresolved (undefined) when the FK is null", async () => {
    const { em } = conn;
    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(
      `INSERT INTO "${postsTable}" ("id","title","author_id") VALUES (11,'orphan',NULL)`,
    );

    const post = await em.findOne(PostClass, { where: { id: 11 } as any });
    expect(post).toBeDefined();
    const author = await (post as any).author;
    expect(author).toBeUndefined();
  });
});
