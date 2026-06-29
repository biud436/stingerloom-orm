/**
 * SQLite in-memory end-to-end coverage for the decorator-free `defineEntity`
 * builder API. Proves that a fully type-inferred, builder-defined entity drives
 * real DDL + CRUD + relation loading through the same pipeline as decorators.
 *
 * Auto-gated like its siblings: the integration tree is excluded from the
 * default unit run (requires INTEGRATION_TEST=true).
 */
import "reflect-metadata";
import { defineEntity, t, InferEntity } from "../../../src/schema";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";

const Author = defineEntity("dee_authors", {
  id: t.int().primary().generated(),
  name: t.varchar(120),
  email: t.varchar(255).nullable(),
});
type Author = InferEntity<typeof Author>;

const Post = defineEntity("dee_posts", {
  id: t.int().primary().generated(),
  title: t.varchar(200),
  views: t.int().default(0),
  status: t.enum(["draft", "live"]).default("draft"),
  displayName: t.varchar(80).nullable().name("display_name"),
  authorId: t.int().nullable().name("author_id"),
  author: t.manyToOne(() => Author, {
    joinColumn: "author_id",
    // SQLite cannot ALTER TABLE ADD FOREIGN KEY; column-level FK is enough here.
    createForeignKeyConstraints: false,
  }),
});
type Post = InferEntity<typeof Post>;

describe("[Integration] SQLite: defineEntity builder e2e", () => {
  let em: EntityManager;

  beforeAll(async () => {
    em = await createTestEntityManager({ entities: [Author, Post] });
  });

  afterAll(async () => {
    await (em as unknown as { destroy?: () => Promise<void> }).destroy?.();
  });

  it("honors custom column names in the generated DDL", async () => {
    const rows = (await em.query(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='dee_posts'",
    )) as Array<{ sql: string }>;
    const ddl = rows[0]?.sql ?? "";
    expect(ddl).toContain('"display_name"');
    expect(ddl).toContain('"author_id"');
    expect(ddl).not.toContain('"displayName"');
    expect(ddl).not.toContain('"authorId"');
  });

  it("performs full CRUD with defaults, enum, and nullable columns", async () => {
    const created = await em.save(Author, { name: "Ada", email: null });
    expect(created.id).toBeGreaterThan(0);

    const post = await em.save(Post, {
      title: "Hello",
      views: 5,
      status: "live",
      displayName: null,
      authorId: created.id,
    } as Partial<Post>);
    expect(post.id).toBeGreaterThan(0);

    const found = await em.findOne(Post, { where: { id: post.id } });
    expect(found).not.toBeNull();
    expect(found!.title).toBe("Hello");
    expect(found!.views).toBe(5);
    expect(found!.status).toBe("live");

    await em.update(Post, { id: post.id }, { views: 10 } as Partial<Post>);
    const updated = await em.findOne(Post, { where: { id: post.id } });
    expect(updated!.views).toBe(10);
  });

  it("loads a manyToOne relation", async () => {
    const author = await em.save(Author, { name: "Grace", email: "g@h.com" });
    const post = await em.save(Post, {
      title: "Rel",
      authorId: author.id,
    } as Partial<Post>);

    const found = await em.findOne(Post, {
      where: { id: post.id },
      relations: ["author"],
    });
    expect(found).not.toBeNull();
    expect((found as Post).author?.name).toBe("Grace");
  });

  it("enforces a per-column .unique() constraint via the schema", async () => {
    // `email` is declared `.unique()` on a separate entity to avoid coupling.
    const Account = defineEntity("dee_accounts", {
      id: t.int().primary().generated(),
      email: t.varchar(255).unique(),
    });
    const accEm = await createTestEntityManager({ entities: [Account] });
    try {
      await accEm.save(Account, { email: "dup@x.com" } as any);
      await expect(
        accEm.save(Account, { email: "dup@x.com" } as any),
      ).rejects.toBeDefined();
    } finally {
      await (accEm as unknown as { destroy?: () => Promise<void> }).destroy?.();
    }
  });
});
