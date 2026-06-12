/**
 * SQLite integration test for NESTED *AndSelect joins.
 *
 * `leftJoinRelationAndSelect("author", "u")` followed by
 * `leftJoinRelationAndSelect("u.profile", "up")` joins a relation OF a joined
 * relation. transformJoinedEntityRows() must attach the deepest entity to the
 * intermediate joined entity (via `sourceAlias` on each joinedSelection and
 * the per-row `aliasInstances` registry), NOT onto the root.
 *
 * End-to-end truth: real rows come back from SQLite with the alias-prefixed
 * columns (`p_*`, `u_*`, `up_*`) and we assert the hydrated object graph.
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
} from "../../../src";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner, ManyToOneScanner } from "../../../src/scanner";
import { DatabaseClient } from "../../../src/DatabaseClient";

function shortTableName(prefix: string): string {
  const ts = String(Date.now()).slice(-7);
  return `${prefix}_${ts}`;
}

function clearScanners(): void {
  getScannerInstance(ColumnScanner).clear();
  getScannerInstance(ManyToOneScanner).clear();
}

describe("[Integration] SQLite In-Memory: nested *AndSelect hydration", () => {
  let conn: TestConnectionResult;
  let Post: new () => any;
  let User: new () => any;
  let Profile: new () => any;

  beforeAll(async () => {
    const profileTable = shortTableName("na_profile");
    const userTable = shortTableName("na_user");
    const postTable = shortTableName("na_post");

    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: false,
        logging: false,
      },
      () => {
        clearScanners();

        const PR = class {} as any;
        Object.defineProperty(PR, "name", { value: profileTable, writable: false });
        Reflect.defineMetadata("design:type", Number, PR.prototype, "id");
        PrimaryGeneratedColumn()(PR.prototype, "id");
        Reflect.defineMetadata("design:type", String, PR.prototype, "bio");
        Column()(PR.prototype, "bio");
        Entity()(PR);

        const UC = class {} as any;
        Object.defineProperty(UC, "name", { value: userTable, writable: false });
        Reflect.defineMetadata("design:type", Number, UC.prototype, "id");
        PrimaryGeneratedColumn()(UC.prototype, "id");
        Reflect.defineMetadata("design:type", String, UC.prototype, "username");
        Column()(UC.prototype, "username");
        Reflect.defineMetadata("design:type", Number, UC.prototype, "profileFk");
        Column({ type: "int", nullable: true })(UC.prototype, "profileFk");
        Reflect.defineMetadata("design:type", PR, UC.prototype, "profile");
        ManyToOne(() => PR, (e: any) => e.profile, { joinColumn: "profileFk" })(
          UC.prototype,
          "profile",
        );
        Entity()(UC);

        const PC = class {} as any;
        Object.defineProperty(PC, "name", { value: postTable, writable: false });
        Reflect.defineMetadata("design:type", Number, PC.prototype, "id");
        PrimaryGeneratedColumn()(PC.prototype, "id");
        Reflect.defineMetadata("design:type", String, PC.prototype, "title");
        Column()(PC.prototype, "title");
        Reflect.defineMetadata("design:type", Number, PC.prototype, "authorFk");
        Column({ type: "int", nullable: true })(PC.prototype, "authorFk");
        Reflect.defineMetadata("design:type", UC, PC.prototype, "author");
        ManyToOne(() => UC, (e: any) => e.author, { joinColumn: "authorFk" })(
          PC.prototype,
          "author",
        );
        Entity()(PC);

        Profile = PR;
        User = UC;
        Post = PC;
        return { entities: [PR, UC, PC] };
      },
    );

    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(`
      CREATE TABLE IF NOT EXISTS "${profileTable}" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "bio" TEXT NOT NULL DEFAULT ''
      )
    `);
    await connector.query(`
      CREATE TABLE IF NOT EXISTS "${userTable}" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "username" TEXT NOT NULL DEFAULT '',
        "profileFk" INTEGER
      )
    `);
    await connector.query(`
      CREATE TABLE IF NOT EXISTS "${postTable}" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "title" TEXT NOT NULL DEFAULT '',
        "authorFk" INTEGER
      )
    `);

    const { em } = conn;
    const prof1 = await em.save(Profile, { bio: "bio-of-alice" });
    const prof2 = await em.save(Profile, { bio: "bio-of-bob" });
    const alice = await em.save(User, {
      username: "alice",
      profileFk: prof1.id,
    });
    const bob = await em.save(User, { username: "bob", profileFk: prof2.id });
    await em.save(Post, { title: "hello", authorFk: alice.id });
    await em.save(Post, { title: "world", authorFk: bob.id });
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  it("hydrates the nested relation onto the joined entity, not onto the root", async () => {
    const posts = await conn.em
      .createQueryBuilder(Post, "p")
      .leftJoinRelationAndSelect("author", "u")
      .leftJoinRelationAndSelect("u.profile", "up")
      .orderBy({ id: "ASC" })
      .getMany();

    expect(posts).toHaveLength(2);

    // Root -> author (intermediate join).
    expect(posts[0]).toBeInstanceOf(Post);
    expect(posts[0].author).toBeInstanceOf(User);
    expect(posts[0].author.username).toBe("alice");

    // author -> profile (deepest join) attaches to the AUTHOR instance.
    expect(posts[0].author.profile).toBeInstanceOf(Profile);
    expect(posts[0].author.profile.bio).toBe("bio-of-alice");

    // The nested entity must NOT leak onto the root post.
    expect((posts[0] as any).profile).toBeUndefined();
    expect((posts[0] as any).bio).toBeUndefined();

    // Second root nests independently.
    expect(posts[1].author.username).toBe("bob");
    expect(posts[1].author.profile.bio).toBe("bio-of-bob");
    expect((posts[1] as any).profile).toBeUndefined();
  });
});
