/**
 * SQLite In-Memory: cascade insert of a OneToMany whose child FK is declared
 * via @RelationColumn WITHOUT a backing @Column (the documented nestjs-blog
 * pattern).
 *
 * Regression for the CascadeHandler FK bug: cascadeSaveOneToMany wrote the
 * parent PK onto the child under the raw joinColumn DB name (e.g.
 * `child["author_id"]`), but the child's INSERT path only reads the FK from the
 * relation object, the `${prop}Id` shadow, or `option.fkProperty`. With a pure
 * @RelationColumn FK (no backing @Column named "author_id"), the FK was never
 * written — cascade-inserted children landed with author_id = NULL.
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

describe("[Integration] SQLite: cascade insert OneToMany via @RelationColumn FK", () => {
  let conn: TestConnectionResult;
  let UserClass: new () => any;
  let usersTable: string;
  let postsTable: string;

  beforeAll(async () => {
    usersTable = shortName("cc_users");
    postsTable = shortName("cc_posts");

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
        // cascade insert: children are persisted together with the parent.
        OneToMany(() => PC, { mappedBy: "author", cascade: ["insert"] })(
          UC.prototype,
          "posts",
        );
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
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  beforeEach(async () => {
    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(`DELETE FROM "${postsTable}"`);
    await connector.query(`DELETE FROM "${usersTable}"`);
  });

  it("writes the parent PK to the child's @RelationColumn FK on cascade insert", async () => {
    const { em } = conn;

    const saved = await em.save(UserClass, {
      name: "Alice",
      posts: [{ title: "A1" }, { title: "A2" }],
    } as any);

    expect(saved.id).toBeDefined();

    // The cascade-inserted children must carry the parent's PK in author_id —
    // assert directly against the DB row, not the in-memory object.
    const connector = DatabaseClient.getInstance().getConnection();
    const rows = await connector.query(
      `SELECT "title", "author_id" FROM "${postsTable}" ORDER BY "title" ASC`,
    );

    expect(rows).toHaveLength(2);
    for (const row of rows as Array<{ title: string; author_id: number }>) {
      expect(row.author_id).toBe(saved.id);
    }
  });

  it("loads the cascade-inserted children back grouped under the parent", async () => {
    const { em } = conn;

    const saved = await em.save(UserClass, {
      name: "Bob",
      posts: [{ title: "B1" }],
    } as any);

    const reloaded = await em.findOne(UserClass, {
      where: { id: saved.id } as any,
      relations: ["posts"] as any,
    });

    expect(reloaded).toBeDefined();
    expect(reloaded!.posts).toHaveLength(1);
    expect(reloaded!.posts[0].title).toBe("B1");
  });
});
