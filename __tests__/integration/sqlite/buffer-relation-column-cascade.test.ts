/**
 * SQLite In-Memory: WriteBuffer cascade with @RelationColumn-declared FKs.
 *
 * The buffer's cascade paths resolve the child FK via `resolveFkColumn`, which
 * only knows the deprecated `@ManyToOne({ joinColumn })` option and otherwise
 * falls back to the relation property name (`mappedBy`). When the FK is declared
 * with `@RelationColumn({ name })` and NO backing `@Column` (the documented
 * nestjs-blog pattern), that fallback is the relation property itself — not the
 * shadow accessor (`${prop}Id`) the save/where path actually reads. Two audited
 * data-loss defects follow:
 *
 *  1. Cascade INSERT leaves the child FK NULL. The buffer writes only
 *     `child["author"] = parentPk` (a scalar on the relation prop); the save
 *     path ignores it (not an object, no `authorId` shadow) so author_id stays
 *     NULL in the DB.
 *
 *  2. Cascade DELETE fails the whole flush. collectCascadeDeletes builds the
 *     child criteria as `{ author: parentPk }` and runs it through
 *     txEm.find/delete, which cannot resolve the relation property to a real
 *     column — the flush throws.
 *
 * SQLite does not support ALTER TABLE ADD CONSTRAINT, so synchronize:false and
 * every table is created by hand.
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
import { bufferPlugin } from "../../../src/core/plugin/buffer/bufferPlugin";
import type { WriteBuffer } from "../../../src/core/plugin/buffer/WriteBuffer";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import {
  ColumnScanner,
  ManyToOneScanner,
  OneToManyScanner,
  ManyToManyScanner,
  OneToOneScanner,
} from "../../../src/scanner";
import { DatabaseClient } from "../../../src/DatabaseClient";

function shortName(prefix: string): string {
  return `${prefix}_${String(Date.now()).slice(-7)}`;
}

describe("[Integration] SQLite: WriteBuffer @RelationColumn cascade", () => {
  let conn: TestConnectionResult;
  let Author: new () => any;
  let Post: new () => any;

  const authorName = shortName("rcauthor");
  const postName = shortName("rcpost");

  beforeAll(async () => {
    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: false,
        logging: false,
        plugins: [bufferPlugin()],
      },
      () => {
        getScannerInstance(ColumnScanner).clear();
        getScannerInstance(ManyToOneScanner).clear();
        getScannerInstance(OneToManyScanner).clear();
        getScannerInstance(ManyToManyScanner).clear();
        getScannerInstance(OneToOneScanner).clear();

        // ── Author (O2M → Post, cascade insert+delete) ──
        const AuthorC = class {} as any;
        Object.defineProperty(AuthorC, "name", { value: authorName });
        Reflect.defineMetadata("design:type", Number, AuthorC.prototype, "id");
        PrimaryGeneratedColumn()(AuthorC.prototype, "id");
        Reflect.defineMetadata("design:type", String, AuthorC.prototype, "name");
        Column()(AuthorC.prototype, "name");
        Reflect.defineMetadata("design:type", Array, AuthorC.prototype, "posts");

        // ── Post (M2O → Author via @RelationColumn, no backing @Column) ──
        const PostC = class {} as any;
        Object.defineProperty(PostC, "name", { value: postName });
        Reflect.defineMetadata("design:type", Number, PostC.prototype, "id");
        PrimaryGeneratedColumn()(PostC.prototype, "id");
        Reflect.defineMetadata("design:type", String, PostC.prototype, "title");
        Column()(PostC.prototype, "title");
        Reflect.defineMetadata("design:type", AuthorC, PostC.prototype, "author");
        ManyToOne(
          () => AuthorC,
          (a: any) => a.posts,
        )(PostC.prototype, "author");
        RelationColumn({ name: "author_id" })(PostC.prototype, "author");
        Entity()(PostC);
        Post = PostC;

        OneToMany(() => PostC, {
          mappedBy: "author",
          cascade: true,
        })(AuthorC.prototype, "posts");
        Entity()(AuthorC);
        Author = AuthorC;

        return { entities: [AuthorC, PostC] };
      },
    );

    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${authorName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT)`,
    );
    await connector.query(
      `CREATE TABLE IF NOT EXISTS "${postName}" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "title" TEXT, "author_id" INTEGER)`,
    );
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

  beforeEach(async () => {
    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(`DELETE FROM "${postName}"`);
    await connector.query(`DELETE FROM "${authorName}"`);
  });

  it("persists the child FK on O2M cascade insert (no backing @Column)", async () => {
    const buf: WriteBuffer = (conn.em as any).buffer();
    const author = new Author();
    (author as any).name = "kim";
    const post = new Post();
    (post as any).title = "hello";
    (author as any).posts = [post];

    buf.persist(author);
    await buf.flush();

    expect((author as any).id).toBeDefined();
    expect((post as any).id).toBeDefined();

    const rows: any[] = await conn.em.query(
      `SELECT author_id FROM "${postName}" WHERE id = ?`,
      [(post as any).id],
    );
    expect(rows).toHaveLength(1);
    // The regression: author_id stayed NULL because the buffer wrote the FK to
    // the relation property ("author") rather than the shadow ("authorId").
    expect(rows[0].author_id).toBe((author as any).id);
  });

  it("cascade-deletes children through a @RelationColumn FK without throwing", async () => {
    const author: any = await conn.em.save(Author, { name: "kim" } as any);
    await conn.em.save(Post, { title: "p1", author } as any);
    await conn.em.save(Post, { title: "p2", author } as any);

    // Sanity: both children were seeded with the FK set.
    const seeded: any[] = await conn.em.query(
      `SELECT COUNT(*) AS c FROM "${postName}" WHERE author_id = ?`,
      [author.id],
    );
    expect(Number(seeded[0].c)).toBe(2);

    const buf: WriteBuffer = (conn.em as any).buffer();
    buf.remove(author);
    await buf.flush();

    const remaining: any[] = await conn.em.query(
      `SELECT COUNT(*) AS c FROM "${postName}" WHERE author_id = ?`,
      [author.id],
    );
    expect(Number(remaining[0].c)).toBe(0);

    const parent: any[] = await conn.em.query(
      `SELECT COUNT(*) AS c FROM "${authorName}" WHERE id = ?`,
      [author.id],
    );
    expect(Number(parent[0].c)).toBe(0);
  });
});
