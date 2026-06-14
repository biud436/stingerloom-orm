/**
 * SQLite In-Memory: @RelationColumn-backed OneToMany / OneToOne loading.
 *
 * Regression for the RelationLoader FK bug: when the FK is declared via
 * @RelationColumn WITHOUT a backing @Column (the documented nestjs-blog
 * pattern), the loader previously (a) failed to SELECT the FK and (b) read it
 * from the hydrated entity by DB column name — so every parent received an
 * empty relation. The loader must SELECT the FK under a stable alias and group
 * from the raw row.
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
  OneToMany,
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

describe("[Integration] SQLite: @RelationColumn OneToMany load (no backing @Column)", () => {
  let conn: TestConnectionResult;
  let UserClass: new () => any;
  let usersTable: string;
  let postsTable: string;

  beforeAll(async () => {
    usersTable = shortName("rc_users");
    postsTable = shortName("rc_posts");

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
        Reflect.defineMetadata("design:type", Array, UC.prototype, "posts");
        OneToMany(() => PC, { mappedBy: "author" })(UC.prototype, "posts");
        Entity()(UC);

        const PC = class {} as any;
        Object.defineProperty(PC, "name", { value: postsTable });
        Reflect.defineMetadata("design:type", Number, PC.prototype, "id");
        PrimaryGeneratedColumn()(PC.prototype, "id");
        Reflect.defineMetadata("design:type", String, PC.prototype, "title");
        Column()(PC.prototype, "title");
        // FK declared ONLY via @RelationColumn — there is no @Column("author_id").
        Reflect.defineMetadata("design:type", UC, PC.prototype, "author");
        ManyToOne(() => UC, (u: any) => u.posts)(PC.prototype, "author");
        RelationColumn({ name: "author_id" })(PC.prototype, "author");
        Entity()(PC);

        UserClass = UC;
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

    // Seed: Alice(1) has 2 posts, Bob(2) has 1, Carol(3) has none.
    await connector.query(`INSERT INTO "${usersTable}" ("id","name") VALUES (1,'Alice'),(2,'Bob'),(3,'Carol')`);
    await connector.query(`INSERT INTO "${postsTable}" ("id","title","author_id") VALUES (10,'A1',1),(11,'A2',1),(12,'B1',2)`);
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("populates posts grouped by the @RelationColumn FK for each parent", async () => {
    const { em } = conn;

    const users = await em.find(UserClass, {
      relations: ["posts"] as any,
      orderBy: { id: "ASC" } as any,
    });

    expect(users).toHaveLength(3);

    const byName = Object.fromEntries(users.map((u: any) => [u.name, u]));
    expect(byName.Alice.posts.map((p: any) => p.title).sort()).toEqual([
      "A1",
      "A2",
    ]);
    expect(byName.Bob.posts.map((p: any) => p.title)).toEqual(["B1"]);
    expect(byName.Carol.posts).toEqual([]);
  });

  it("loads posts for a single parent fetched by PK", async () => {
    const { em } = conn;

    const alice = await em.findOne(UserClass, {
      where: { id: 1 } as any,
      relations: ["posts"] as any,
    });

    expect(alice).toBeDefined();
    expect(alice!.posts).toHaveLength(2);
  });
});
