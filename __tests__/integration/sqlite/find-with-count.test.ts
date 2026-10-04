/**
 * `withCount`: the number of rows a collection relation holds, written onto
 * each entity a read returns.
 *
 * - One batched `GROUP BY` statement per count, whatever the number of
 *   parents (sliced under SQLite's bind-parameter cap), and 0 for none.
 * - The rows counted are the ones loading the relation would attach: the
 *   count's own where (relation filters included), soft-deleted rows left
 *   out unless the count's or the read's `withDeleted` says otherwise, the
 *   tenant scope, and a single-table child's subtype.
 * - Every read path takes it, `relations` takes it per relation at any
 *   depth, a cached read is invalidated by a write to a counted table, and
 *   a count no batched read can answer is rejected before any statement.
 *
 * PG / MariaDB: __tests__/integration/find-with-count.test.ts
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { PrimaryColumn } from "../../../src/decorators/PrimaryColumn";
import { ManyToOne } from "../../../src/decorators/ManyToOne";
import { OneToMany } from "../../../src/decorators/OneToMany";
import { ManyToMany } from "../../../src/decorators/ManyToMany";
import { RelationColumn } from "../../../src/decorators/RelationColumn";
import { DeletedAt } from "../../../src/decorators/DeletedAt";
import { Inheritance } from "../../../src/decorators/Inheritance";
import { DiscriminatorColumn } from "../../../src/decorators/DiscriminatorColumn";
import { DiscriminatorValue } from "../../../src/decorators/DiscriminatorValue";
import { Relation } from "../../../src/types/Relation";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";
import { DatabaseClient } from "../../../src/DatabaseClient";
import { MetadataContext } from "../../../src/metadata/MetadataContext";
import { SnakeNamingStrategy } from "../../../src/core/generators/SnakeNamingStrategy";

@Entity({ name: "fwc_users" })
class FwcUser {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) name!: string;
  @OneToMany(() => FwcPost, { mappedBy: "author" }) posts!: FwcPost[];
  postCount?: number;
}

@Entity({ name: "fwc_tags" })
class FwcTag {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) label!: string;
  @DeletedAt() deletedAt?: Date | null;
}

@Entity({ name: "fwc_posts" })
class FwcPost {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) title!: string;
  @ManyToOne(() => FwcUser, (u: FwcUser) => u.posts)
  @RelationColumn({ name: "author_id", nullable: true })
  author!: Relation<FwcUser> | null;
  @OneToMany(() => FwcComment, { mappedBy: "post" }) comments!: FwcComment[];
  @ManyToMany(() => FwcTag, {
    joinTable: { name: "fwc_post_tags", joinColumn: "post_id", inverseJoinColumn: "tag_id" },
  })
  tags!: FwcTag[];
  commentCount?: number;
  approvedCount?: number;
  likedCount?: number;
  tagCount?: number;
}

@Entity({ name: "fwc_comments" })
class FwcComment {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) body!: string;
  @Column({ type: "boolean" }) approved!: boolean;
  @ManyToOne(() => FwcPost, (p: FwcPost) => p.comments)
  @RelationColumn({ name: "post_id", nullable: true })
  post!: Relation<FwcPost> | null;
  @OneToMany(() => FwcLike, { mappedBy: "comment" }) likes!: FwcLike[];
  @DeletedAt() deletedAt?: Date | null;
  likeCount?: number;
}

@Entity({ name: "fwc_likes" })
class FwcLike {
  @PrimaryGeneratedColumn() id!: number;
  @ManyToOne(() => FwcComment, (c: FwcComment) => c.likes)
  @RelationColumn({ name: "comment_id" })
  comment!: Relation<FwcComment>;
}

async function countQueries(connection: string, run: () => Promise<unknown>): Promise<number> {
  const connector = DatabaseClient.getInstance().getConnection(connection);
  const spy = jest.spyOn(connector, "query");
  try {
    await run();
    return spy.mock.calls.length;
  } finally {
    spy.mockRestore();
  }
}

describe("[Integration] SQLite: withCount", () => {
  let em: EntityManager;
  let ids: Record<string, number>;

  beforeAll(async () => {
    em = await createTestEntityManager({
      entities: [FwcUser, FwcTag, FwcPost, FwcComment, FwcLike],
      connectionName: "fwc",
    });
    const alice = await em.save(FwcUser, { name: "alice" });
    const bob = await em.save(FwcUser, { name: "bob" });
    const orm = await em.save(FwcTag, { label: "orm" });
    const sql = await em.save(FwcTag, { label: "sql" });
    const old = await em.save(FwcTag, { label: "old" });
    await em.softDelete(FwcTag, { id: old.id });

    // p1 (alice): c1 approved (2 likes), c2 pending, c3 approved but trashed
    //             (1 like); tags orm, sql and the trashed old
    // p2 (alice): c4 approved (1 like); tag sql
    // p3 (bob):   nothing
    // p4 (none):  c5 pending
    const p1 = await em.save(FwcPost, { title: "p1", author: alice });
    const p2 = await em.save(FwcPost, { title: "p2", author: alice });
    const p3 = await em.save(FwcPost, { title: "p3", author: bob });
    const p4 = await em.save(FwcPost, { title: "p4", author: null });
    await em.query(
      `INSERT INTO fwc_post_tags (post_id, tag_id) VALUES ` +
        `(${p1.id}, ${orm.id}), (${p1.id}, ${sql.id}), (${p1.id}, ${old.id}), (${p2.id}, ${sql.id})`,
    );
    const c1 = await em.save(FwcComment, { body: "c1", approved: true, post: p1 });
    const c2 = await em.save(FwcComment, { body: "c2", approved: false, post: p1 });
    const c3 = await em.save(FwcComment, { body: "c3", approved: true, post: p1 });
    const c4 = await em.save(FwcComment, { body: "c4", approved: true, post: p2 });
    await em.save(FwcComment, { body: "c5", approved: false, post: p4 });
    for (const comment of [c1, c1, c3, c4]) await em.save(FwcLike, { comment });
    await em.softDelete(FwcComment, { id: c3.id });

    ids = { alice: alice.id, bob: bob.id, p1: p1.id, p2: p2.id, p3: p3.id, p4: p4.id, c1: c1.id, c2: c2.id, c4: c4.id };
  });

  afterAll(async () => {
    await em.propagateShutdown();
  });

  const counts = (rows: any[], ...properties: string[]) =>
    rows.map((row) => [row.title ?? row.name ?? row.body, ...properties.map((p) => row[p])]);

  describe("counts", () => {
    it("writes each count onto every entity, 0 when there are no related rows", async () => {
      const posts = await em.find(FwcPost, {
        orderBy: { id: "ASC" },
        withCount: {
          commentCount: "comments",
          approvedCount: { relation: "comments", where: { approved: true } },
          tagCount: "tags",
        },
      });
      expect(counts(posts, "commentCount", "approvedCount", "tagCount")).toEqual([
        ["p1", 2, 1, 2],
        ["p2", 1, 1, 1],
        ["p3", 0, 0, 0],
        ["p4", 1, 0, 0],
      ]);
      expect(posts[0]).toBeInstanceOf(FwcPost);
      expect(posts[0].comments).toBeUndefined();
    });

    it("takes relation filters in a count's where", async () => {
      const posts = await em.find(FwcPost, {
        orderBy: { id: "ASC" },
        withCount: { likedCount: { relation: "comments", where: { likes: { some: {} } } } },
      });
      expect(counts(posts, "likedCount")).toEqual([["p1", 1], ["p2", 1], ["p3", 0], ["p4", 0]]);
    });

    it("counts soft-deleted rows when the read or the count says withDeleted", async () => {
      const read = await em.find(FwcPost, {
        where: { id: ids.p1 },
        withDeleted: true,
        withCount: {
          commentCount: "comments",
          approvedCount: { relation: "comments", where: { approved: true }, withDeleted: false },
          tagCount: "tags",
        },
      });
      expect(counts(read, "commentCount", "approvedCount", "tagCount")).toEqual([["p1", 3, 1, 3]]);

      const own = await em.find(FwcPost, {
        where: { id: ids.p1 },
        withCount: { commentCount: { relation: "comments", withDeleted: true } },
      });
      expect(own[0].commentCount).toBe(3);
    });

    it("loads alongside the relation it counts", async () => {
      const [post] = await em.find(FwcPost, {
        where: { id: ids.p1 },
        relations: { comments: { where: { approved: true } } },
        withCount: { commentCount: "comments" },
      });
      expect(post.comments.map((c) => c.body)).toEqual(["c1"]);
      expect(post.commentCount).toBe(2);
    });

    it("runs one statement per count, whatever the number of parents", async () => {
      const plain = await countQueries("fwc", () => em.find(FwcPost, {}));
      const counted = await countQueries("fwc", () =>
        em.find(FwcPost, { withCount: { commentCount: "comments", tagCount: "tags" } }),
      );
      expect(counted - plain).toBe(2);

      const none = await countQueries("fwc", () =>
        em.find(FwcPost, { where: { title: "missing" }, withCount: { commentCount: "comments" } }),
      );
      expect(none).toBe(plain);
    });
  });

  describe("under relations", () => {
    it("counts on the related entities at every level", async () => {
      const [alice] = await em.find(FwcUser, {
        where: { id: ids.alice },
        withCount: { postCount: "posts" },
        relations: {
          posts: {
            orderBy: { id: "ASC" },
            withCount: { commentCount: "comments" },
            relations: { comments: { orderBy: { id: "ASC" }, withCount: { likeCount: "likes" } } },
          },
        },
      });
      expect(alice.postCount).toBe(2);
      expect(counts(alice.posts, "commentCount")).toEqual([["p1", 2], ["p2", 1]]);
      expect(counts(alice.posts[0].comments, "likeCount")).toEqual([["c1", 2], ["c2", 0]]);
    });

    it("counts on a JOINed single-valued relation", async () => {
      const [comment] = await em.find(FwcComment, {
        where: { id: ids.c4 },
        relations: { post: { withCount: { commentCount: "comments" } } },
      });
      expect(comment.post?.commentCount).toBe(1);
    });
  });

  describe("every read path", () => {
    const withCount = { commentCount: "comments" } as const;

    it("findOne, findAndCount, findWithPage and stream", async () => {
      expect((await em.findOne(FwcPost, { where: { id: ids.p1 }, withCount }))?.commentCount).toBe(2);

      const [rows, total] = await em.findAndCount(FwcPost, { orderBy: { id: "ASC" }, withCount });
      expect(total).toBe(4);
      expect(rows.map((p) => p.commentCount)).toEqual([2, 1, 0, 1]);

      const page = await em.findWithPage(FwcPost, { page: 1, pageSize: 2, orderBy: { id: "ASC" }, withCount });
      expect(page.data.map((p) => p.commentCount)).toEqual([2, 1]);

      const streamed: number[] = [];
      for await (const post of em.stream(FwcPost, { orderBy: { id: "ASC" }, withCount }, 3)) {
        streamed.push(post.commentCount!);
      }
      expect(streamed).toEqual([2, 1, 0, 1]);
    });

    it("cursor pages", async () => {
      const first = await em.findWithCursor(FwcPost, { take: 2, withCount });
      expect(first.data.map((p) => p.commentCount)).toEqual([2, 1]);
      const second = await em.findWithCursor(FwcPost, { take: 2, cursor: first.nextCursor!, withCount });
      expect(second.data.map((p) => p.commentCount)).toEqual([0, 1]);
    });

    it("adds the primary key to a select that leaves it out", async () => {
      const posts = await em.find(FwcPost, { select: ["title"], orderBy: { id: "ASC" }, withCount });
      expect(counts(posts, "commentCount")).toEqual([["p1", 2], ["p2", 1], ["p3", 0], ["p4", 1]]);
    });

    it("refuses a distinct read whose select drops the key", async () => {
      await expect(
        em.find(FwcPost, { select: ["title"], distinct: true, withCount }),
      ).rejects.toThrow(/"comments" .*matched to each row by that key/);
    });
  });

  describe("query cache", () => {
    it("a cached read is invalidated by a write to a counted table", async () => {
      const cache = em.queryCache!;
      await cache.clear();
      const option = { where: { id: ids.p3 }, withCount: { commentCount: "comments" }, cache: true } as const;

      expect((await em.find(FwcPost, option))[0].commentCount).toBe(0);
      // The count statement shares the read's cache entry policy: both hit.
      const hits = cache.stats.hits;
      await em.find(FwcPost, option);
      expect(cache.stats.hits).toBe(hits + 2);

      const fresh = await em.save(FwcComment, { body: "fresh", approved: true, post: { id: ids.p3 } as FwcPost });
      try {
        expect((await em.find(FwcPost, option))[0].commentCount).toBe(1);
      } finally {
        await em.delete(FwcComment, { id: fresh.id });
        await cache.clear();
      }
    });
  });

  describe("validation", () => {
    it.each([
      [{ title: "comments" }, /"withCount\.title" would overwrite "title", a column of "FwcPost"/],
      [{ commentCount: "author" }, /counts "author", a ManyToOne of "FwcPost"; only collection relations/],
      [{ commentCount: "coments" }, /Unknown relation "coments" in "withCount\.commentCount" for entity "FwcPost"/],
      [{ comments: "comments" }, /would overwrite "comments", a relation of "FwcPost"/],
      [{ commentCount: { relation: "comments", where: { aproved: true } } }, /Unknown column "aproved".*"FwcComment"/],
    ])("rejects %j before any statement", async (withCount, message) => {
      const queries = await countQueries("fwc", async () => {
        await expect(em.find(FwcPost, { withCount } as any)).rejects.toThrow(message);
      });
      expect(queries).toBe(0);
    });

    it("rejects a nested count with the relation path", async () => {
      await expect(
        em.find(FwcUser, { relations: { posts: { withCount: { commentCount: "tagz" } } } } as any),
      ).rejects.toThrow(/Unknown relation "tagz" in "withCount\.commentCount" of relation "posts" in "relations" for entity "FwcPost"/);
    });

    it("explain() checks the counts the way find() does", async () => {
      await expect(
        em.explain(FwcPost, { withCount: { commentCount: "author" } } as any),
      ).rejects.toThrow(/only collection relations/);
    });
  });

  it("slices the parent keys under the driver's bind-parameter cap", async () => {
    await em.query(
      `INSERT INTO fwc_posts (title) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000) SELECT 'bulk' FROM n`,
    );
    const [last] = await em.find(FwcPost, { where: { title: "bulk" }, orderBy: { id: "DESC" }, take: 1 });
    await em.save(FwcComment, { body: "late", approved: true, post: last });

    let posts: FwcPost[] = [];
    const queries = await countQueries("fwc", async () => {
      posts = await em.find(FwcPost, { where: { title: "bulk" }, withCount: { commentCount: "comments" } });
    });
    expect(posts).toHaveLength(1000);
    expect(posts.filter((p) => p.commentCount === 1).map((p) => p.id)).toEqual([last.id]);
    expect(posts.every((p) => p.commentCount === (p.id === last.id ? 1 : 0))).toBe(true);
    const plain = await countQueries("fwc", () => em.find(FwcPost, { where: { title: "bulk" } }));
    expect(queries - plain).toBe(2);
  });
});

describe("[Integration] SQLite: withCount on inheritance targets", () => {
  @Entity({ name: "fwci_owners" })
  class IOwner {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "varchar", length: 40 }) name!: string;
    @OneToMany(() => IReview, { mappedBy: "owner" }) reviews!: IReview[];
    @OneToMany(() => IMachine, { mappedBy: "operator" }) machines!: IMachine[];
    @OneToMany(() => IAsset, { mappedBy: "owner" }) assets!: IAsset[];
    reviewCount?: number;
    latheCount?: number;
    assetCount?: number;
  }

  // SINGLE_TABLE: reviews and memos share the docs table.
  @Entity({ name: "fwci_docs" })
  @Inheritance({ strategy: "SINGLE_TABLE" })
  @DiscriminatorColumn({ name: "dtype", type: "varchar", length: 20 })
  class IDoc {
    @PrimaryGeneratedColumn() id!: number;
    @ManyToOne(() => IOwner, (o: IOwner) => o.reviews)
    @RelationColumn({ name: "owner_id" })
    owner!: Relation<IOwner>;
  }

  @Entity()
  @DiscriminatorValue("review")
  class IReview extends IDoc {
    @Column({ type: "int", nullable: true }) stars!: number;
  }

  @Entity()
  @DiscriminatorValue("memo")
  class IMemo extends IDoc {
    @Column({ type: "varchar", length: 40, nullable: true }) note!: string;
  }

  // JOINED: a machine's inherited `name` lives on the equipment table.
  @Entity({ name: "fwci_equipment" })
  @Inheritance({ strategy: "JOINED" })
  class IEquipment {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "varchar", length: 40 }) name!: string;
  }

  @Entity({ name: "fwci_machines" })
  @DiscriminatorValue("machine")
  class IMachine extends IEquipment {
    @Column({ type: "int" }) power!: number;
    @ManyToOne(() => IOwner, (o: IOwner) => o.machines)
    @RelationColumn({ name: "operator_id" })
    operator!: Relation<IOwner>;
  }

  // TABLE_PER_CLASS: a vehicle's row lives in its own table, not the root's.
  @Entity({ name: "fwci_assets" })
  @Inheritance({ strategy: "TABLE_PER_CLASS" })
  class IAsset {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "varchar", length: 40 }) label!: string;
    @ManyToOne(() => IOwner, (o: IOwner) => o.assets)
    @RelationColumn({ name: "owner_id" })
    owner!: Relation<IOwner>;
  }

  @Entity({ name: "fwci_vehicles" })
  @DiscriminatorValue("vehicle")
  class IVehicle extends IAsset {
    @Column({ type: "int" }) wheels!: number;
  }

  let em: EntityManager;

  beforeAll(async () => {
    em = await createTestEntityManager({
      entities: [IOwner, IDoc, IReview, IMemo, IEquipment, IMachine, IAsset, IVehicle],
      connectionName: "fwc_inheritance",
    });
    const alice = await em.save(IOwner, { name: "alice" });
    await em.save(IReview, { stars: 5, owner: alice } as any);
    await em.save(IMemo, { note: "n", owner: alice } as any);
    await em.save(IMemo, { note: "m", owner: alice } as any);
    await em.save(IMachine, { name: "lathe", power: 3, operator: alice } as any);
    await em.save(IMachine, { name: "drill", power: 1, operator: alice } as any);
    await em.save(IVehicle, { label: "truck", wheels: 6, owner: alice } as any);
    await em.save(IAsset, { label: "desk", owner: alice } as any);
  });

  afterAll(async () => {
    await em.propagateShutdown();
  });

  it("counts a single-table child's own subtype, a JOINED child by an inherited column and a TABLE_PER_CLASS root's subclass rows", async () => {
    const [alice] = await em.find(IOwner, {
      withCount: {
        reviewCount: "reviews",
        latheCount: { relation: "machines", where: { name: "lathe" } },
        assetCount: "assets",
      },
    });
    expect([alice.reviewCount, alice.latheCount, alice.assetCount]).toEqual([1, 1, 2]);
  });
});

describe("[Integration] SQLite: withCount under tenant_column", () => {
  @Entity({ name: "fwct_users" })
  class TUser {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "varchar", length: 40 }) name!: string;
    @OneToMany(() => TPost, { mappedBy: "author" }) posts!: TPost[];
    postCount?: number;
  }

  @Entity({ name: "fwct_posts" })
  class TPost {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "varchar", length: 40 }) title!: string;
    @ManyToOne(() => TUser, (u: TUser) => u.posts, { createForeignKeyConstraints: false })
    @RelationColumn({ name: "author_id" })
    author!: Relation<TUser> | null;
  }

  let em: EntityManager;

  beforeAll(async () => {
    MetadataContext.reset();
    em = new EntityManager();
    await em.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities: [TUser, TPost],
        synchronize: true,
        tenantStrategy: "tenant_column",
        logging: false,
      },
      "fwc_tenant",
    );
  });

  afterAll(async () => {
    await em.propagateShutdown({ closeConnections: true });
    MetadataContext.reset();
  });

  it("does not count a related row of another tenant", async () => {
    const user = await MetadataContext.run("acme", () => em.save(TUser, { name: "alice" }));
    await MetadataContext.run("acme", () => em.save(TPost, { title: "mine", authorId: user.id } as any));
    await MetadataContext.run("globex", () => em.save(TPost, { title: "theirs", authorId: user.id } as any));
    await MetadataContext.run("acme", async () => {
      const [alice] = await em.find(TUser, { withCount: { postCount: "posts" } });
      expect(alice.postCount).toBe(1);
    });
  });
});

describe("[Integration] SQLite: withCount under SnakeNamingStrategy", () => {
  @Entity({ name: "fwcs_authors" })
  class SAuthor {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "varchar", length: 40 }) displayName!: string;
    @OneToMany(() => SArticle, { mappedBy: "writtenBy" }) articles!: SArticle[];
    articleCount?: number;
  }

  @Entity({ name: "fwcs_articles" })
  class SArticle {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "boolean" }) isPublished!: boolean;
    @ManyToOne(() => SAuthor, (a: SAuthor) => a.articles)
    @RelationColumn()
    writtenBy!: Relation<SAuthor>;
  }

  let em: EntityManager;

  beforeAll(async () => {
    em = new EntityManager();
    await em.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities: [SAuthor, SArticle],
        synchronize: true,
        namingStrategy: new SnakeNamingStrategy(),
        logging: false,
      },
      "fwc_snake",
    );
    const author = await em.save(SAuthor, { displayName: "a" });
    await em.save(SArticle, { isPublished: true, writtenBy: author });
    await em.save(SArticle, { isPublished: false, writtenBy: author });
  });

  afterAll(async () => {
    await em.propagateShutdown();
  });

  it("maps the where's property names to the strategy's columns", async () => {
    const columns = ((await em.query(`PRAGMA table_info("fwcs_articles")`)) as any[]).map((c) => c.name);
    expect(columns).toContain("is_published");
    const [author] = await em.find(SAuthor, {
      withCount: { articleCount: { relation: "articles", where: { isPublished: true } } },
    });
    expect(author.articleCount).toBe(1);
  });
});

// A parent keyed by two columns: a count is matched to its parent by one
// key value, so the count is refused.
@Entity({ name: "fwc_orders" })
class FwcOrder {
  @PrimaryColumn({ type: "varchar", length: 10 }) tenantCode!: string;
  @PrimaryColumn({ type: "int" }) orderNo!: number;
  @OneToMany(() => FwcLine, { mappedBy: "order" }) lines!: FwcLine[];
  lineCount?: number;
}

@Entity({ name: "fwc_lines" })
class FwcLine {
  @PrimaryGeneratedColumn() id!: number;
  @ManyToOne(() => FwcOrder, (o: FwcOrder) => o.lines)
  @RelationColumn({ name: "order_no" })
  order!: Relation<FwcOrder>;
}

describe("[Integration] SQLite: withCount on a composite key", () => {
  let em: EntityManager;

  beforeAll(async () => {
    em = await createTestEntityManager({ entities: [FwcOrder, FwcLine], connectionName: "fwc_composite" });
  });

  afterAll(async () => {
    await em.propagateShutdown();
  });

  it("rejects counting per entity whose primary key has two columns", async () => {
    await expect(em.find(FwcOrder, { withCount: { lineCount: "lines" } })).rejects.toThrow(
      /per "FwcOrder", whose primary key has 2 columns/,
    );
  });
});
