/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * WriteBuffer writes the foreign key of a `@ManyToOne` / owning `@OneToOne`
 * from the relation (SQLite :memory:).
 *
 * The buffer writes a row from its columns only, and a join column declared
 * through `@RelationColumn` is no `@Column`. So a key set through the
 * relation — a related instance, a bare key, `null`, or the `authorId` FK
 * property itself — was never written: a persisted post was inserted
 * without its author, and reassigning a tracked post's author was not even
 * seen as a change.
 *
 * Runs only under INTEGRATION_TEST=true (see jest.config.js).
 */
import "reflect-metadata";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  OneToMany,
  OneToOne,
  RelationColumn,
} from "../../../src";
import type { Relation } from "../../../src";
import { bufferPlugin } from "../../../src/core/plugin/buffer/bufferPlugin";
import type { WriteBuffer } from "../../../src/core/plugin/buffer/WriteBuffer";
import { EntityManager } from "../../../src/core/EntityManager";
import { InvalidQueryError } from "../../../src/errors/InvalidQueryError";

@Entity({ name: "brfk_author" })
class Author {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) name!: string;
  @OneToMany(() => Post, { mappedBy: "author", cascade: ["insert", "update"] } as any)
  posts!: Relation<Post>[];
}

@Entity({ name: "brfk_topic" })
class Topic {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) label!: string;
}

@Entity({ name: "brfk_post" })
class Post {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) title!: string;

  @ManyToOne(() => Author, (a: Author) => a.posts, { lazy: true } as any)
  @RelationColumn({ name: "author_id", type: "int", nullable: true } as any)
  author!: Relation<Author> | null;

  @ManyToOne(() => Topic, () => undefined as any)
  @RelationColumn({ name: "topic_id", type: "int", nullable: true } as any)
  topic!: Relation<Topic> | null;
}

/** The join column is also a declared @Column. */
@Entity({ name: "brfk_note" })
class Note {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) body!: string;
  @Column({ type: "int", name: "writer_id", nullable: true } as any) writerId!: number | null;
  @ManyToOne(() => Author, () => undefined as any)
  @RelationColumn({ name: "writer_id" } as any)
  writer!: Relation<Author> | null;
}

@Entity({ name: "brfk_badge" })
class Badge {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) label!: string;
  @OneToOne(() => Author)
  @RelationColumn({ name: "holder_id", type: "int", nullable: true } as any)
  holder!: Relation<Author> | null;
}

@Entity({ name: "brfk_category" })
class Category {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) name!: string;
  @ManyToOne(() => Category, () => undefined as any)
  @RelationColumn({ name: "parent_id", type: "int", nullable: true } as any)
  parent!: Relation<Category> | null;
}

const ENTITIES = [Author, Topic, Post, Note, Badge, Category];

describe.each([
  ["row by row", {}],
  ["batchInsert + batchUpdate", { batchInsert: true, batchUpdate: true }],
] as const)("[Integration] SQLite: WriteBuffer relation foreign keys (%s)", (_label, options) => {
  let em: EntityManager;
  let alice: Author;
  let bob: Author;

  beforeEach(async () => {
    em = new EntityManager();
    await em.register({
      type: "sqlite",
      database: ":memory:",
      entities: ENTITIES,
      synchronize: true,
      logging: false,
      plugins: [bufferPlugin(options)],
    } as any);
    // Author ids 2 and 3, so a key never matches by accident.
    await em.save(Author, { name: "filler" } as any);
    alice = await em.save(Author, { name: "alice" } as any);
    bob = await em.save(Author, { name: "bob" } as any);
  });

  afterEach(async () => {
    await em.propagateShutdown({ closeConnections: true } as any);
  });

  const buffer = (): WriteBuffer => (em as any).buffer();
  const posts = () =>
    em.query(`SELECT title, author_id, topic_id FROM brfk_post ORDER BY id`) as Promise<any[]>;
  const post = (data: Partial<Post> & Record<string, unknown>) =>
    Object.assign(new Post(), data);

  describe("persist()", () => {
    it("writes the key of a loaded related instance", async () => {
      const buf = buffer();
      const author = await buf.findOne(Author, { where: { name: "alice" } } as any);
      buf.persist(post({ title: "a", author }));
      await buf.flush();
      expect(await posts()).toEqual([{ title: "a", author_id: alice.id, topic_id: null }]);
    });

    it("writes the key of a related row persisted in the same flush", async () => {
      const buf = buffer();
      const carol = Object.assign(new Author(), { name: "carol" });
      // Queued before its author: the flush inserts authors first.
      buf.persist(post({ title: "a", author: carol }));
      buf.persist(carol);
      await buf.flush();
      expect(carol.id).toBeGreaterThan(bob.id);
      expect(await posts()).toEqual([{ title: "a", author_id: carol.id, topic_id: null }]);
    });

    it("writes a bare key and the FK property", async () => {
      const buf = buffer();
      buf.persist(post({ title: "a", author: alice.id as any }));
      buf.persist(post({ title: "b", authorId: bob.id }));
      await buf.flush();
      expect(await posts()).toEqual([
        { title: "a", author_id: alice.id, topic_id: null },
        { title: "b", author_id: bob.id, topic_id: null },
      ]);
    });

    it("writes the declared @Column of the join column from the relation", async () => {
      const buf = buffer();
      buf.persist(Object.assign(new Note(), { body: "n", writer: bob }));
      await buf.flush();
      const rows = (await em.query(`SELECT body, writer_id FROM brfk_note`)) as any[];
      expect(rows).toEqual([{ body: "n", writer_id: bob.id }]);
    });

    it("writes an owning OneToOne key", async () => {
      const buf = buffer();
      buf.persist(Object.assign(new Badge(), { label: "gold", holder: alice }));
      await buf.flush();
      const rows = (await em.query(`SELECT label, holder_id FROM brfk_badge`)) as any[];
      expect(rows).toEqual([{ label: "gold", holder_id: alice.id }]);
    });

    it("writes a self-reference whose target is queued after the row", async () => {
      const buf = buffer();
      const root = Object.assign(new Category(), { name: "root" });
      const leaf = Object.assign(new Category(), { name: "leaf", parent: root });
      buf.persist(leaf);
      buf.persist(root);
      await buf.flush();
      const rows = (await em.query(
        `SELECT name, parent_id FROM brfk_category ORDER BY name`,
      )) as any[];
      expect(rows).toEqual([
        { name: "leaf", parent_id: root.id },
        { name: "root", parent_id: null },
      ]);
    });

    it("writes the other relations of a cascaded child", async () => {
      const topic = await em.save(Topic, { label: "news" } as any);
      const buf = buffer();
      buf.persist(
        Object.assign(new Author(), { name: "dave", posts: [post({ title: "a", topic })] }),
      );
      await buf.flush();
      const [row] = await posts();
      expect(row.topic_id).toBe(topic.id);
      expect(row.author_id).toBeGreaterThan(bob.id);
    });

    it("fails the flush when the related row is never written, and writes nothing", async () => {
      const buf = buffer();
      const stranger = Object.assign(new Author(), { name: "stranger" });
      buf.persist(post({ title: "a", author: stranger }));

      await expect(buf.flush()).rejects.toBeInstanceOf(InvalidQueryError);
      expect(await posts()).toEqual([]);

      // The queue is kept: persisting the author lets the retry succeed.
      buf.persist(stranger);
      await buf.flush();
      expect(await posts()).toEqual([{ title: "a", author_id: stranger.id, topic_id: null }]);
    });

    it("lists the key in preview()", () => {
      const buf = buffer();
      buf.persist(post({ title: "a", author: alice }));
      expect(buf.preview()).toEqual([
        { action: "insert", entity: "Post", data: { title: "a", authorId: alice.id } },
      ]);
    });
  });

  describe("tracked rows", () => {
    let first: number;
    let second: number;

    beforeEach(async () => {
      first = (await em.save(Post, { title: "first", author: alice.id } as any)).id;
      second = (await em.save(Post, { title: "second", author: alice.id } as any)).id;
    });

    it("writes a reassigned relation", async () => {
      const buf = buffer();
      const [a, b] = await Promise.all([
        buf.findOne(Post, { where: { id: first } } as any),
        buf.findOne(Post, { where: { id: second } } as any),
      ]);
      const target = await buf.findOne(Author, { where: { name: "bob" } } as any);
      (a as any).author = target;
      (b as any).author = bob.id;

      expect(buf.dirty()).toHaveLength(2);
      const result = await buf.flush();

      expect(result.updates).toBe(2);
      expect((await posts()).map((r) => r.author_id)).toEqual([bob.id, bob.id]);
    });

    it("clears the key when the relation is set to null", async () => {
      const buf = buffer();
      const a: any = await buf.findOne(Post, { where: { id: first } } as any);
      a.author = null;
      await buf.flush();
      expect((await posts()).map((r) => r.author_id)).toEqual([null, alice.id]);
    });

    it("writes a relation to a row persisted in the same flush", async () => {
      const buf = buffer();
      const a: any = await buf.findOne(Post, { where: { id: first } } as any);
      const carol = Object.assign(new Author(), { name: "carol" });
      a.author = carol;
      buf.persist(carol);
      await buf.flush();
      expect((await posts()).map((r) => r.author_id)).toEqual([carol.id, alice.id]);
    });

    it("leaves the key alone when the relation was never loaded", async () => {
      const buf = buffer();
      const a: any = await buf.findOne(Post, { where: { id: first } } as any);
      a.title = "renamed";
      const result = await buf.flush();
      expect(result.updates).toBe(1);
      expect(await posts()).toEqual([
        { title: "renamed", author_id: alice.id, topic_id: null },
        { title: "second", author_id: alice.id, topic_id: null },
      ]);
    });

    it("is clean when the relation still points at the same row", async () => {
      const buf = buffer();
      const a: any = await buf.findOne(Post, { where: { id: first } } as any);
      a.author = await buf.findOne(Author, { where: { name: "alice" } } as any);
      expect(buf.dirty()).toEqual([]);
      expect(await buf.flush()).toMatchObject({ updates: 0 });
    });
  });
});
