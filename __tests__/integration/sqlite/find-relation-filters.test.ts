/**
 * Per-relation options in the object form of `relations`: `where`,
 * `orderBy`, `take` / `skip` per parent and `withDeleted`.
 *
 * - `where` / `orderBy` shape the batched collection read; property names
 *   resolve through the column mapping (`@Column({ name })`).
 * - `take` / `skip` page each parent's rows (a window function partitioned
 *   by the parent key), not the whole batch.
 * - `withDeleted` overrides the read's for one relation — to-one JOINs and
 *   batched reads alike.
 * - Options work at a nested level, apply before that level's own nested
 *   relations are loaded, and are checked before any statement runs.
 *
 * PG / MariaDB: __tests__/integration/find-relation-filters.test.ts
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../../src/decorators/ManyToOne";
import { OneToMany } from "../../../src/decorators/OneToMany";
import { ManyToMany } from "../../../src/decorators/ManyToMany";
import { RelationColumn } from "../../../src/decorators/RelationColumn";
import { DeletedAt } from "../../../src/decorators/DeletedAt";
import { Relation } from "../../../src/types/Relation";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";
import { DatabaseClient } from "../../../src/DatabaseClient";
import { InvalidQueryError } from "../../../src/errors/InvalidQueryError";
import { OrmError } from "../../../src/errors/OrmError";
import { OrmErrorCode } from "../../../src/errors/OrmErrorCode";

@Entity({ name: "frf_users" })
class FrfUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  name!: string;

  @OneToMany(() => FrfPost, { mappedBy: "author" })
  posts!: FrfPost[];

  @DeletedAt()
  deletedAt!: Date | null;
}

@Entity({ name: "frf_tags" })
class FrfTag {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  label!: string;
}

@Entity({ name: "frf_posts" })
class FrfPost {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  title!: string;

  @ManyToOne(() => FrfUser, (u: FrfUser) => u.posts)
  @RelationColumn({ name: "author_id" })
  author!: Relation<FrfUser> | null;

  @OneToMany(() => FrfComment, { mappedBy: "post" })
  comments!: FrfComment[];

  @ManyToMany(() => FrfTag, {
    joinTable: { name: "frf_post_tags", joinColumn: "post_id", inverseJoinColumn: "tag_id" },
  })
  tags!: FrfTag[];
}

@Entity({ name: "frf_comments" })
class FrfComment {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  body!: string;

  @Column({ type: "int", name: "score_points" })
  score!: number;

  @Column({ type: "boolean" })
  approved!: boolean;

  @ManyToOne(() => FrfPost, (p: FrfPost) => p.comments)
  @RelationColumn({ name: "post_id" })
  post!: Relation<FrfPost>;

  @ManyToOne(() => FrfUser, (u: FrfUser) => u.id)
  @RelationColumn({ name: "author_id" })
  author!: Relation<FrfUser> | null;

  @DeletedAt()
  deletedAt!: Date | null;
}

async function countQueries(run: () => Promise<unknown>): Promise<number> {
  const connector = DatabaseClient.getInstance().getConnection("test");
  const spy = jest.spyOn(connector, "query");
  try {
    await run();
    return spy.mock.calls.length;
  } finally {
    spy.mockRestore();
  }
}

describe("[Integration] SQLite: per-relation options in relations", () => {
  let em: EntityManager;
  let ids: Record<string, number>;

  beforeAll(async () => {
    em = await createTestEntityManager({ entities: [FrfUser, FrfTag, FrfPost, FrfComment] });

    const alice = await em.save(FrfUser, { name: "alice" });
    const bob = await em.save(FrfUser, { name: "bob" });
    const gone = await em.save(FrfUser, { name: "gone" });
    const tags = [];
    for (const label of ["c", "a", "b"]) tags.push(await em.save(FrfTag, { label }));

    const p1 = await em.save(FrfPost, { title: "p1", author: alice });
    const p2 = await em.save(FrfPost, { title: "p2", author: bob });
    const p3 = await em.save(FrfPost, { title: "p3", author: gone });
    await em.query(
      `INSERT INTO frf_post_tags (post_id, tag_id) VALUES ` +
        `(${p1.id}, ${tags[0].id}), (${p1.id}, ${tags[1].id}), (${p1.id}, ${tags[2].id}), (${p2.id}, ${tags[2].id})`,
    );

    // p1: five comments with distinct scores; p2: two.
    const seed: Array<[FrfPost, string, number, boolean, FrfUser]> = [
      [p1, "p1-a", 10, true, bob],
      [p1, "p1-b", 50, false, bob],
      [p1, "p1-c", 30, true, alice],
      [p1, "p1-d", 40, true, bob],
      [p1, "p1-e", 20, true, alice],
      [p2, "p2-a", 5, true, alice],
      [p2, "p2-b", 15, false, alice],
    ];
    for (const [post, body, score, approved, author] of seed) {
      await em.save(FrfComment, { post, body, score, approved, author });
    }
    const trashed = await em.save(FrfComment, { post: p1, body: "p1-trashed", score: 99, approved: true, author: alice });
    await em.softDelete(FrfComment, { id: trashed.id });
    await em.softDelete(FrfUser, { id: gone.id });

    ids = { alice: alice.id, bob: bob.id, gone: gone.id, p1: p1.id, p2: p2.id, p3: p3.id };
  });

  afterAll(async () => {
    await em.propagateShutdown();
  });

  const findPosts = (relations: any, extra: Record<string, unknown> = {}) =>
    em.find(FrfPost, { orderBy: { id: "ASC" }, relations, ...extra });
  const bodies = (post: FrfPost) => post.comments.map((c) => c.body);

  describe("where", () => {
    it("loads only the matching related rows and keeps every parent", async () => {
      const posts = await findPosts({ comments: { where: { approved: false } } });
      expect(posts.map((p) => [p.title, bodies(p)])).toEqual([
        ["p1", ["p1-b"]],
        ["p2", ["p2-b"]],
        ["p3", []],
      ]);
    });

    it("takes the read's operators, mapped columns and OR arrays", async () => {
      const [p1] = await findPosts({
        comments: { where: [{ score: { gte: 40 } }, { body: { endsWith: "-a" } }], orderBy: { score: "ASC" } },
      });
      expect(bodies(p1)).toEqual(["p1-a", "p1-d", "p1-b"]);
    });

    it("filters a ManyToMany through its join table", async () => {
      const [p1, p2] = await findPosts({ tags: { where: { label: { in: ["a", "b"] } }, orderBy: { label: "ASC" } } });
      expect(p1.tags.map((t) => t.label)).toEqual(["a", "b"]);
      expect(p2.tags.map((t) => t.label)).toEqual(["b"]);
    });
  });

  describe("orderBy", () => {
    it("orders each parent's related rows", async () => {
      const [p1, p2] = await findPosts({ comments: { orderBy: { score: "DESC" } } });
      expect(bodies(p1)).toEqual(["p1-b", "p1-d", "p1-c", "p1-e", "p1-a"]);
      expect(bodies(p2)).toEqual(["p2-b", "p2-a"]);
    });
  });

  describe("take / skip per parent", () => {
    it("keeps the first rows of each parent, not of the whole batch", async () => {
      const [p1, p2, p3] = await findPosts({ comments: { orderBy: { score: "DESC" }, take: 2 } });
      expect(bodies(p1)).toEqual(["p1-b", "p1-d"]);
      expect(bodies(p2)).toEqual(["p2-b", "p2-a"]);
      expect(bodies(p3)).toEqual([]);
    });

    it("pages with skip, and combines with where", async () => {
      const [p1] = await findPosts({
        comments: { where: { approved: true }, orderBy: { score: "DESC" }, skip: 1, take: 2 },
      });
      expect(bodies(p1)).toEqual(["p1-c", "p1-e"]);

      const [rest] = await findPosts({ comments: { orderBy: { score: "DESC" }, skip: 3 } });
      expect(bodies(rest)).toEqual(["p1-e", "p1-a"]);
    });

    it("ranks by the related primary key when no orderBy is given", async () => {
      const [p1] = await findPosts({ comments: { take: 2 } });
      expect(bodies(p1)).toEqual(["p1-a", "p1-b"]);
    });

    it("pages a ManyToMany per parent", async () => {
      const [p1, p2] = await findPosts({ tags: { orderBy: { label: "ASC" }, take: 1 } });
      expect(p1.tags.map((t) => t.label)).toEqual(["a"]);
      expect(p2.tags.map((t) => t.label)).toEqual(["b"]);
    });

    it("take: 0 assigns empty collections without a query", async () => {
      const plain = await countQueries(() => findPosts([]));
      let posts: FrfPost[] = [];
      const zero = await countQueries(async () => {
        posts = await findPosts({ comments: { take: 0 } });
      });
      expect(zero).toBe(plain);
      expect(posts.every((p) => Array.isArray(p.comments) && p.comments.length === 0)).toBe(true);
    });

    it("reports a database without window functions instead of loading every row", async () => {
      const driver = em.getDriver() as any;
      const real = driver.getCapabilities();
      const spy = jest
        .spyOn(driver, "getCapabilities")
        .mockReturnValue({ ...real, supportsWindowFunctions: false });
      try {
        const error = await findPosts({ comments: { take: 1 } }).catch((e) => e);
        expect(error).toBeInstanceOf(OrmError);
        expect(error.code).toBe(OrmErrorCode.UNSUPPORTED_OPERATION);
        expect(error.message).toContain('"take" / "skip" on relation "comments" need window functions');
        await expect(findPosts({ comments: { orderBy: { score: "ASC" } } })).resolves.toHaveLength(3);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("withDeleted per relation", () => {
    it("shows a relation's soft-deleted rows when the read hides them, and the reverse", async () => {
      const [shown] = await findPosts({ comments: { withDeleted: true, where: { score: 99 } } });
      expect(bodies(shown)).toEqual(["p1-trashed"]);

      const [hidden] = await findPosts({ comments: { withDeleted: false, where: { score: 99 } } }, { withDeleted: true });
      expect(bodies(hidden)).toEqual([]);
    });

    it("applies to a JOINed ManyToOne", async () => {
      const posts = await findPosts({ author: true });
      expect(posts[2].author).toBeNull();
      const withAuthor = await findPosts({ author: { withDeleted: true } });
      expect(withAuthor[2].author?.name).toBe("gone");
    });

    it("applies to a nested to-one level", async () => {
      const [p1] = await findPosts({
        comments: { where: { score: 99 }, withDeleted: true, relations: { author: { withDeleted: true } } },
      });
      expect(p1.comments[0].author?.name).toBe("alice");
    });
  });

  describe("nested levels", () => {
    it("applies options at a nested level and loads the next level for the kept rows only", async () => {
      const alice = await em.findOne(FrfUser, {
        where: { id: ids.alice },
        relations: {
          posts: {
            relations: {
              comments: { orderBy: { score: "DESC" }, take: 1, relations: { author: true } },
            },
          },
        },
      });
      const [p1] = alice!.posts;
      expect(p1.comments.map((c) => [c.body, c.author?.name])).toEqual([["p1-b", "bob"]]);
    });

    it("adds no query for the options themselves", async () => {
      const plain = await countQueries(() => findPosts(["comments", "tags"]));
      const shaped = await countQueries(() =>
        findPosts({ comments: { where: { approved: true }, take: 2 }, tags: { orderBy: { label: "ASC" } } }),
      );
      expect(shaped).toBe(plain);
    });

    it("works on cursor pages", async () => {
      const page = await em.findWithCursor(FrfPost, {
        take: 2,
        relations: { comments: { orderBy: { score: "ASC" }, take: 1 } },
      });
      expect(page.data.map((p) => bodies(p))).toEqual([["p1-a"], ["p2-a"]]);
    });
  });

  describe("validation", () => {
    it("rejects where / orderBy / take / skip on a single-valued relation", async () => {
      await expect(findPosts({ author: { where: { name: "alice" } } })).rejects.toThrow(
        /"where" cannot be set on relation "author" in "relations": it is a ManyToOne of "FrfPost"/,
      );
      await expect(
        findPosts({ comments: { relations: { post: { take: 1, orderBy: { id: "ASC" } } } } }),
      ).rejects.toThrow(/"orderBy", "take" cannot be set on relation "comments\.post"/);
    });

    it("rejects an unknown column in a relation's where or orderBy before any query", async () => {
      let error: unknown;
      const queries = await countQueries(async () => {
        error = await findPosts({ comments: { where: { scor: 1 } } }).catch((e) => e);
      });
      expect(error).toBeInstanceOf(InvalidQueryError);
      expect((error as Error).message).toMatch(/scor/);
      expect((error as Error).message).toMatch(/FrfComment/);
      expect(queries).toBe(0);

      await expect(
        findPosts({ comments: { orderBy: { nope: "ASC" } } } as any),
      ).rejects.toThrow(InvalidQueryError);
    });
  });
});
