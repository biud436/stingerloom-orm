/**
 * Nested relation loading through `relations` — dotted paths and the object
 * form, to any depth, on every read that takes the option.
 *
 * The read keeps loading the top level the way it always has (to-one
 * relations JOINed, collections batched); each level below is loaded once
 * the rows are hydrated, with one batched query per relation per level. The
 * cases pin:
 *
 * - every relation kind at a nested level (ManyToOne, OneToMany, ManyToMany,
 *   both OneToOne sides), three levels deep, and cycles back to the root
 * - the query count: a level costs one query per relation, not one per parent
 * - soft-delete, `withDeleted` and tenant scoping applied on nested levels
 * - findOne / findAndCount / findWithPage / findWithCursor / explain
 * - query-cache invalidation by a write to a nested level's table
 * - an entity reached through a relation carrying the same properties find()
 *   gives it (its foreign keys and computed columns), and a JOINed
 *   relation's own relation no longer reading a same-named JOIN of the row
 *
 * PG / MariaDB: __tests__/integration/find-nested-relations.test.ts
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { ComputedColumn } from "../../../src/decorators/ComputedColumn";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../../src/decorators/ManyToOne";
import { OneToMany } from "../../../src/decorators/OneToMany";
import { ManyToMany } from "../../../src/decorators/ManyToMany";
import { OneToOne } from "../../../src/decorators/OneToOne";
import { RelationColumn } from "../../../src/decorators/RelationColumn";
import { DeletedAt } from "../../../src/decorators/DeletedAt";
import { Relation } from "../../../src/types/Relation";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";
import { DatabaseClient } from "../../../src/DatabaseClient";
import { MetadataContext } from "../../../src/metadata/MetadataContext";
import { InvalidQueryError } from "../../../src/errors/InvalidQueryError";

@Entity({ name: "fnr_teams" })
class FnrTeam {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  title!: string;

  @OneToMany(() => FnrUser, { mappedBy: "team" })
  members!: FnrUser[];
}

@Entity({ name: "fnr_users" })
class FnrUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  name!: string;

  @ComputedColumn({ expression: "upper(name)", type: "varchar" })
  shout!: string;

  @ManyToOne(() => FnrTeam, (t: FnrTeam) => t.members)
  @RelationColumn({ name: "team_id" })
  team!: Relation<FnrTeam> | null;

  @OneToMany(() => FnrPost, { mappedBy: "author" })
  posts!: FnrPost[];

  @OneToOne(() => FnrProfile, { inverseSide: "owner" })
  profile!: Relation<FnrProfile> | null;
}

@Entity({ name: "fnr_profiles" })
class FnrProfile {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  bio!: string;

  @OneToOne(() => FnrUser)
  @RelationColumn({ name: "owner_id" })
  owner!: Relation<FnrUser>;
}

@Entity({ name: "fnr_tags" })
class FnrTag {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  label!: string;

  @ManyToMany(() => FnrPost, { mappedBy: "tags" })
  posts!: FnrPost[];
}

@Entity({ name: "fnr_posts" })
class FnrPost {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  title!: string;

  @ManyToOne(() => FnrUser, (u: FnrUser) => u.posts)
  @RelationColumn({ name: "author_id" })
  author!: Relation<FnrUser>;

  // Same property name as FnrUser.team, pointing at a different row.
  @ManyToOne(() => FnrTeam, (t: FnrTeam) => t.id)
  @RelationColumn({ name: "team_id", nullable: true })
  team!: Relation<FnrTeam> | null;

  @OneToMany(() => FnrComment, { mappedBy: "post" })
  comments!: FnrComment[];

  @ManyToMany(() => FnrTag, {
    joinTable: { name: "fnr_post_tags", joinColumn: "post_id", inverseJoinColumn: "tag_id" },
  })
  tags!: FnrTag[];
}

@Entity({ name: "fnr_comments" })
class FnrComment {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 40 })
  body!: string;

  @ManyToOne(() => FnrPost, (p: FnrPost) => p.comments)
  @RelationColumn({ name: "post_id" })
  post!: Relation<FnrPost>;

  @ManyToOne(() => FnrUser, (u: FnrUser) => u.id)
  @RelationColumn({ name: "author_id" })
  author!: Relation<FnrUser>;

  @DeletedAt()
  deletedAt!: Date | null;
}

const ENTITIES = [FnrTeam, FnrUser, FnrProfile, FnrTag, FnrPost, FnrComment];

/** Statements the connection runs while `run` executes. */
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

describe("[Integration] SQLite: nested relations in find()", () => {
  let em: EntityManager;
  let ids: Record<string, number>;

  beforeAll(async () => {
    em = await createTestEntityManager({ entities: ENTITIES });

    const core = await em.save(FnrTeam, { title: "core" });
    const infra = await em.save(FnrTeam, { title: "infra" });
    const alice = await em.save(FnrUser, { name: "alice", team: core });
    const bob = await em.save(FnrUser, { name: "bob", team: infra });
    const carol = await em.save(FnrUser, { name: "carol", team: core });
    await em.save(FnrProfile, { bio: "alice's", owner: alice });
    const orm = await em.save(FnrTag, { label: "orm" });
    const sql = await em.save(FnrTag, { label: "sql" });

    const p1 = await em.save(FnrPost, { title: "p1", author: alice, team: infra });
    const p2 = await em.save(FnrPost, { title: "p2", author: bob, team: null });
    const p3 = await em.save(FnrPost, { title: "p3", author: alice, team: core });
    await em.query(`INSERT INTO fnr_post_tags (post_id, tag_id) VALUES (${p1.id}, ${orm.id}), (${p1.id}, ${sql.id}), (${p3.id}, ${sql.id})`);

    await em.save(FnrComment, { body: "c1", post: p1, author: bob });
    await em.save(FnrComment, { body: "c2", post: p1, author: carol });
    await em.save(FnrComment, { body: "c3", post: p2, author: alice });
    const trashed = await em.save(FnrComment, { body: "c4-trashed", post: p1, author: alice });
    await em.softDelete(FnrComment, { id: trashed.id });

    ids = { core: core.id, infra: infra.id, alice: alice.id, bob: bob.id, carol: carol.id, p1: p1.id, p2: p2.id, p3: p3.id };
  });

  afterAll(async () => {
    await em.propagateShutdown();
  });

  const byId = <T extends { id: number }>(rows: T[]) => [...rows].sort((a, b) => a.id - b.id);
  const titles = (rows: { title: string }[]) => rows.map((r) => r.title).sort();
  const bodies = (rows: { body: string }[]) => rows.map((r) => r.body).sort();

  describe("relation kinds at a nested level", () => {
    it("loads a ManyToOne under a OneToMany (comments.author)", async () => {
      const [p1] = await em.find(FnrPost, { where: { id: ids.p1 }, relations: ["comments.author"] });
      const authors = byId(p1.comments).map((c) => [c.body, c.author.name]);
      expect(authors).toEqual([
        ["c1", "bob"],
        ["c2", "carol"],
      ]);
    });

    it("loads a OneToMany under a JOINed ManyToOne (author.posts)", async () => {
      const [p2] = await em.find(FnrPost, { where: { id: ids.p2 }, relations: ["author.posts"] });
      expect(p2.author.name).toBe("bob");
      expect(titles(p2.author.posts)).toEqual(["p2"]);
    });

    it("loads a ManyToMany under a OneToMany (posts.tags)", async () => {
      const alice = await em.findOne(FnrUser, {
        where: { id: ids.alice },
        relations: { posts: { relations: { tags: true } } },
      });
      const tags = byId(alice!.posts).map((p) => [p.title, p.tags.map((t) => t.label).sort()]);
      expect(tags).toEqual([
        ["p1", ["orm", "sql"]],
        ["p3", ["sql"]],
      ]);
    });

    it("loads the inverse side of a OneToOne under a ManyToOne (author.profile)", async () => {
      const posts = byId(await em.find(FnrPost, { relations: ["author.profile"] }));
      expect(posts.map((p) => [p.title, p.author.profile?.bio ?? null])).toEqual([
        ["p1", "alice's"],
        ["p2", null],
        ["p3", "alice's"],
      ]);
    });

    it("loads a ManyToOne under the owning side of a OneToOne (owner.team)", async () => {
      const [profile] = await em.find(FnrProfile, { relations: ["owner.team"] });
      expect(profile.owner.name).toBe("alice");
      expect(profile.owner.team?.title).toBe("core");
    });

    it("loads three levels (members.posts.comments) and cycles back to the root type", async () => {
      const core = await em.findOne(FnrTeam, {
        where: { id: ids.core },
        relations: ["members.posts.comments.author.team"],
      });
      const alice = core!.members.find((m) => m.name === "alice")!;
      const p1 = alice.posts.find((p) => p.title === "p1")!;
      expect(bodies(p1.comments)).toEqual(["c1", "c2"]);
      expect(p1.comments.find((c) => c.body === "c1")!.author.team?.title).toBe("infra");
    });
  });

  describe("forms", () => {
    it("treats a dotted path and the object form alike, and merges overlapping entries", async () => {
      const dotted = await em.find(FnrPost, {
        where: { id: ids.p1 },
        relations: ["comments", "comments.author", "comments.author.team", "tags"],
      });
      const object = await em.find(FnrPost, {
        where: { id: ids.p1 },
        relations: {
          comments: { relations: { author: { relations: ["team"] } } },
          tags: true,
        },
      });
      expect(JSON.parse(JSON.stringify(object))).toEqual(JSON.parse(JSON.stringify(dotted)));
      expect(byId(dotted[0].comments)[0].author.team?.title).toBe("infra");
    });

    it("leaves a relation set to false unloaded", async () => {
      const [p1] = await em.find(FnrPost, {
        where: { id: ids.p1 },
        relations: { comments: true, tags: false },
      });
      expect(p1.comments).toHaveLength(2);
      expect(p1.tags).toBeUndefined();
    });
  });

  describe("query count", () => {
    it("costs one batched query per relation per level, whatever the number of parents", async () => {
      const flat = await countQueries(() => em.find(FnrPost, { relations: ["comments"] }));
      const nested = await countQueries(() =>
        em.find(FnrPost, { relations: ["comments.author.team", "author.posts"] }),
      );
      // + comments.author, comments.author.team, author (JOINed — no query), author.posts
      expect(nested - flat).toBe(3);
    });

    it("issues no nested query when the level above loaded nothing", async () => {
      const flat = await countQueries(() => em.find(FnrPost, { where: { id: ids.p3 }, relations: ["comments"] }));
      const nested = await countQueries(() =>
        em.find(FnrPost, { where: { id: ids.p3 }, relations: ["comments.author"] }),
      );
      expect(nested).toBe(flat);
    });
  });

  describe("scoping on nested levels", () => {
    it("hides a soft-deleted entity at a nested level, and withDeleted shows it", async () => {
      const [live] = await em.find(FnrUser, { where: { id: ids.alice }, relations: ["posts.comments"] });
      const p1 = live.posts.find((p) => p.title === "p1")!;
      expect(bodies(p1.comments)).toEqual(["c1", "c2"]);

      const [all] = await em.find(FnrUser, {
        where: { id: ids.alice },
        relations: ["posts.comments"],
        withDeleted: true,
      });
      expect(bodies(all.posts.find((p) => p.title === "p1")!.comments)).toEqual(["c1", "c2", "c4-trashed"]);
    });
  });

  describe("every read that takes relations", () => {
    it("findAndCount and findWithPage load nested relations", async () => {
      const [rows, total] = await em.findAndCount(FnrPost, {
        where: { id: ids.p1 },
        relations: ["comments.author"],
      });
      expect(total).toBe(1);
      expect(byId(rows[0].comments)[0].author.name).toBe("bob");

      const page = await em.findWithPage(FnrPost, {
        page: 1,
        pageSize: 10,
        orderBy: { id: "ASC" },
        relations: { author: { relations: ["team"] } },
      });
      expect(page.data.map((p) => [p.title, p.author.team?.title])).toEqual([
        ["p1", "core"],
        ["p2", "infra"],
        ["p3", "core"],
      ]);
    });

    it("findWithCursor loads nested relations on every page", async () => {
      const first = await em.findWithCursor(FnrPost, { take: 2, relations: ["comments.author", "author.team"] });
      const second = await em.findWithCursor(FnrPost, {
        take: 2,
        cursor: first.nextCursor!,
        relations: ["comments.author", "author.team"],
      });
      const rows = [...first.data, ...second.data];
      expect(rows.map((p) => p.author.team?.title)).toEqual(["core", "infra", "core"]);
      expect(byId(rows[0].comments).map((c) => c.author.name)).toEqual(["bob", "carol"]);
    });

    it("stream loads nested relations batch by batch", async () => {
      const rows: FnrPost[] = [];
      for await (const post of em.stream(FnrPost, { orderBy: { id: "ASC" }, relations: ["comments.author"] }, 2)) {
        rows.push(post);
      }
      expect(rows.map((p) => p.title)).toEqual(["p1", "p2", "p3"]);
      expect(rows[1].comments.map((c) => c.author.name)).toEqual(["alice"]);
    });

    it("explain accepts the nested forms", async () => {
      await expect(
        em.explain(FnrPost, { relations: { author: { relations: ["team"] }, comments: true } }),
      ).resolves.toBeDefined();
    });
  });

  describe("query cache", () => {
    it("invalidates a cached nested read when a nested level's table is written", async () => {
      const read = () =>
        em.find(FnrPost, { where: { id: ids.p1 }, relations: ["comments.author.team"], cache: 60_000 });
      const before = await read();
      expect(byId(before[0].comments)[0].author.team?.title).toBe("infra");

      await em.save(FnrTeam, { id: ids.infra, title: "platform" });
      const after = await read();
      expect(byId(after[0].comments)[0].author.team?.title).toBe("platform");
      await em.save(FnrTeam, { id: ids.infra, title: "infra" });
    });
  });

  describe("an entity reached through a relation is hydrated like find() hydrates it", () => {
    it("carries its foreign keys and computed columns, JOINed or batched", async () => {
      const [p2] = await em.find(FnrPost, { where: { id: ids.p2 }, relations: ["author", "comments"] });
      expect(p2.author).toMatchObject({ name: "bob", shout: "BOB", teamId: ids.infra });
      expect(p2.comments[0]).toMatchObject({ body: "c3", authorId: ids.alice, postId: ids.p2 });

      const [direct] = await em.find(FnrUser, { where: { id: ids.bob } });
      expect(Object.keys(p2.author).sort()).toEqual(
        expect.arrayContaining(Object.keys(direct).sort()),
      );
    });

    it("does not fill a JOINed relation's own relation from a same-named JOIN of the row", async () => {
      // p1.team is "infra", its author alice's team is "core".
      const [p1] = await em.find(FnrPost, { where: { id: ids.p1 }, relations: ["author", "team"] });
      expect(p1.team?.title).toBe("infra");
      expect(p1.author.team).toBeNull();

      const [nested] = await em.find(FnrPost, { where: { id: ids.p1 }, relations: ["author.team", "team"] });
      expect(nested.team?.title).toBe("infra");
      expect(nested.author.team?.title).toBe("core");
    });
  });

  describe("validation", () => {
    it("rejects a misspelled nested name with the path that reached it", async () => {
      await expect(em.find(FnrPost, { relations: ["comments.autor"] })).rejects.toThrow(
        /Unknown relation "autor" in "relations" for entity "FnrComment" \(requested as "comments\.autor"\).*Did you mean "author"\?/,
      );
    });

    it("rejects an unknown option key in the object form", async () => {
      await expect(
        em.find(FnrPost, { relations: { comments: { where: { body: "c1" } } } as any }),
      ).rejects.toThrow(InvalidQueryError);
    });

    it("rejects a column named as a nested relation", async () => {
      await expect(
        em.find(FnrPost, { relations: { author: { relations: ["name"] } } as any }),
      ).rejects.toThrow(/Unknown relation "name".*for entity "FnrUser"/);
    });
  });
});

describe("[Integration] SQLite: nested relations under a lazy ManyToOne", () => {
  @Entity({ name: "fnrl_teams" })
  class LTeam {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "varchar", length: 40 }) title!: string;
  }

  @Entity({ name: "fnrl_users" })
  class LUser {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "varchar", length: 40 }) name!: string;
    @ManyToOne(() => LTeam, (t: LTeam) => t.id)
    @RelationColumn({ name: "team_id" })
    team!: Relation<LTeam>;
  }

  @Entity({ name: "fnrl_posts" })
  class LPost {
    @PrimaryGeneratedColumn() id!: number;
    @ManyToOne(() => LUser, (u: LUser) => u.id, { lazy: true })
    @RelationColumn({ name: "author_id" })
    author!: Relation<LUser>;
  }

  let em: EntityManager;

  beforeAll(async () => {
    em = await createTestEntityManager({ entities: [LTeam, LUser, LPost], connectionName: "fnr_lazy" });
    const team = await em.save(LTeam, { title: "core" });
    const author = await em.save(LUser, { name: "alice", team });
    await em.save(LPost, { author });
  });

  afterAll(async () => {
    await em.propagateShutdown();
  });

  it("keeps a requested lazy relation loaded, with its nested relations", async () => {
    const [post] = await em.find(LPost, { relations: ["author.team"] });
    expect(Object.getOwnPropertyDescriptor(post, "author")?.get).toBeUndefined();
    expect(post.author.team.title).toBe("core");
    expect((await post.author).name).toBe("alice");
  });

  it("still defers a lazy relation the read does not name", async () => {
    const [post] = await em.find(LPost, {});
    expect(Object.getOwnPropertyDescriptor(post, "author")?.get).toBeDefined();
    expect((await post.author).name).toBe("alice");
  });
});

describe("[Integration] SQLite: nested relations under tenant_column", () => {
  @Entity({ name: "fnrt_users" })
  class TUser {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "varchar", length: 40 }) name!: string;
  }

  @Entity({ name: "fnrt_posts" })
  class TPost {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "varchar", length: 40 }) title!: string;
    @OneToMany(() => TComment, { mappedBy: "post" }) comments!: TComment[];
  }

  @Entity({ name: "fnrt_comments" })
  class TComment {
    @PrimaryGeneratedColumn() id!: number;
    @Column({ type: "varchar", length: 40 }) body!: string;
    @ManyToOne(() => TPost, (p: TPost) => p.comments)
    @RelationColumn({ name: "post_id" })
    post!: Relation<TPost>;
    @ManyToOne(() => TUser, (u: TUser) => u.id, { createForeignKeyConstraints: false })
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
        entities: [TUser, TPost, TComment],
        synchronize: true,
        tenantStrategy: "tenant_column",
        logging: false,
      },
      "fnr_tenant",
    );
  });

  afterAll(async () => {
    await em.propagateShutdown({ closeConnections: true });
    MetadataContext.reset();
  });

  it("scopes each nested level to the caller's tenant", async () => {
    const foreignAuthor = await MetadataContext.run("globex", () => em.save(TUser, { name: "mallory" }));
    await MetadataContext.run("acme", async () => {
      const own = await em.save(TUser, { name: "alice" });
      const post = await em.save(TPost, { title: "acme post" });
      await em.save(TComment, { body: "own", post, author: own });
      await em.save(TComment, { body: "foreign", post, authorId: foreignAuthor.id } as any);

      const [read] = await em.find(TPost, { relations: ["comments.author"] });
      const authors = read.comments
        .map((c) => [c.body, c.author?.name ?? null])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      expect(authors).toEqual([
        ["foreign", null],
        ["own", "alice"],
      ]);
    });
  });
});
