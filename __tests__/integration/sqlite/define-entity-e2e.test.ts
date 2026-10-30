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

  it("fires a decorator-free lifecycle hook on a saved instance", async () => {
    const Article = defineEntity(
      "dee_articles",
      {
        id: t.int().primary().generated(),
        title: t.varchar(200),
        slug: t.varchar(200).nullable(),
      },
      {
        hooks: {
          beforeInsert(e) {
            if (!e.slug) {
              e.slug = e.title.toLowerCase().replace(/\s+/g, "-");
            }
          },
        },
      },
    );
    const artEm = await createTestEntityManager({ entities: [Article] });
    try {
      // The constructor accepts a partial → the instance carries the hook.
      const saved = await artEm.save(Article, new Article({ title: "Hello World" }));
      expect(saved.slug).toBe("hello-world");

      const found = await artEm.findOne(Article, { where: { id: saved.id } });
      expect(found!.slug).toBe("hello-world");
    } finally {
      await (artEm as unknown as { destroy?: () => Promise<void> }).destroy?.();
    }
  });

  it("excludes a t.computed() column from the INSERT column list", async () => {
    // Computed columns are rendered into DDL by the migration generator
    // (SchemaGenerator), not the runtime `synchronize` path — same as the
    // decorator `@ComputedColumn`. Here we verify the write-path contract:
    // `save()` never writes the computed column (doing so would error), so a
    // plain table standing in for the generated one accepts the INSERT.
    const Person = defineEntity("dee_people", {
      id: t.int().primary().generated(),
      firstName: t.varchar(80).name("first_name"),
      lastName: t.varchar(80).name("last_name"),
      fullName: t.computed<string>("first_name || ' ' || last_name", {
        stored: true,
        type: "varchar",
        nullable: true,
      }),
    });
    const pplEm = await createTestEntityManager({ entities: [Person] });
    try {
      const saved = await pplEm.save(Person, {
        firstName: "Ada",
        lastName: "Lovelace",
      } as Partial<InferEntity<typeof Person>>);
      expect(saved.id).toBeGreaterThan(0);

      // The computed column is not a stored column, so it is absent from DDL
      // here, and the INSERT succeeded precisely because it was excluded.
      const rows = (await pplEm.query(
        "SELECT first_name, last_name FROM dee_people WHERE id = ?",
        [saved.id],
      )) as Array<{ first_name: string; last_name: string }>;
      expect(rows[0]).toEqual({ first_name: "Ada", last_name: "Lovelace" });
    } finally {
      await (pplEm as unknown as { destroy?: () => Promise<void> }).destroy?.();
    }
  });

  it("round-trips a value object through a typed transformer()", async () => {
    class Cents {
      constructor(readonly amount: number) {}
    }
    class Instant {
      constructor(readonly date: Date) {}
    }
    const Invoice = defineEntity("dee_invoices", {
      id: t.int().primary().generated(),
      // A temporal column reads as Date or as text depending on the driver.
      issuedAt: t.datetime().transformer({
        to: (value: Instant) => value.date,
        from: (raw: Date | string) => new Instant(new Date(raw)),
      }),
      total: t.varchar(32).transformer({
        to: (value: Cents) => String(value.amount),
        from: (raw: string) => new Cents(Number(raw)),
      }),
      refund: t
        .varchar(32)
        .nullable()
        .transformer({
          to: (value: Cents | null) => (value === null ? null : String(value.amount)),
          from: (raw: string) => new Cents(Number(raw)),
        }),
    });
    const invEm = await createTestEntityManager({ entities: [Invoice] });
    try {
      // The payload is typed with the value object, no cast.
      const issuedAt = new Date("2026-10-30T09:15:00.000Z");
      const saved = await invEm.save(Invoice, {
        issuedAt: new Instant(issuedAt),
        total: new Cents(250),
        refund: null,
      });

      const stored = (await invEm.query(
        "SELECT total, refund FROM dee_invoices WHERE id = ?",
        [saved.id],
      )) as Array<{ total: string; refund: string | null }>;
      expect(stored[0]).toEqual({ total: "250", refund: null });

      const found = await invEm.findOne(Invoice, { where: { id: saved.id } });
      expect(found!.total).toBeInstanceOf(Cents);
      // `.amount` compiles only because the field is typed `Cents`.
      expect(found!.total.amount).toBe(250);
      expect(found!.refund).toBeNull();
      expect(found!.issuedAt.date.getTime()).toBe(issuedAt.getTime());

      // A where operand is the value object too; `to` maps it to the stored form.
      const matched = await invEm.find(Invoice, {
        where: { total: new Cents(250) },
      });
      expect(matched.map((row) => row.id)).toEqual([saved.id]);
    } finally {
      await (invEm as unknown as { destroy?: () => Promise<void> }).destroy?.();
    }
  });
});
