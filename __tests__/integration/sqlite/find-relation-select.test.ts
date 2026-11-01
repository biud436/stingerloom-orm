/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `select` in a relation's entry of `relations`: the related entity reads
 * only the columns named, on every path a relation is loaded by — the
 * JOINed to-one read, the batched OneToMany / ManyToMany / inverse
 * OneToOne reads, a nested level and a cursor page's batched to-one read.
 *
 * The related entity's primary key, the join column of each to-one relation
 * nested under it and a hierarchy's discriminator are read whatever
 * `select` says, so its own relations still load and its rows are still
 * built as their subclass.
 *
 * PG / MariaDB: __tests__/integration/find-relation-select.test.ts
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../../src/decorators/ManyToOne";
import { OneToMany } from "../../../src/decorators/OneToMany";
import { ManyToMany } from "../../../src/decorators/ManyToMany";
import { OneToOne } from "../../../src/decorators/OneToOne";
import { RelationColumn } from "../../../src/decorators/RelationColumn";
import { Inheritance } from "../../../src/decorators/Inheritance";
import { DiscriminatorColumn } from "../../../src/decorators/DiscriminatorColumn";
import { DiscriminatorValue } from "../../../src/decorators/DiscriminatorValue";
import { Relation } from "../../../src/types/Relation";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";
import { DatabaseClient } from "../../../src/DatabaseClient";
import { InvalidQueryError } from "../../../src/errors/InvalidQueryError";

@Entity({ name: "frs_teams" })
class FrsTeam {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) name!: string;
  @Column({ type: "varchar", length: 40 }) motto!: string;
}

@Entity({ name: "frs_users" })
class FrsUser {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) name!: string;
  @Column({ type: "varchar", length: 60 }) email!: string;

  @ManyToOne(() => FrsTeam, (t: FrsTeam) => t.id)
  @RelationColumn({ name: "team_id" })
  team!: Relation<FrsTeam> | null;

  @OneToOne(() => FrsProfile, { inverseSide: "user" })
  profile!: Relation<FrsProfile> | null;

  @OneToMany(() => FrsPost, { mappedBy: "author" })
  posts!: FrsPost[];
}

@Entity({ name: "frs_profiles" })
class FrsProfile {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) avatar!: string;
  @Column({ type: "varchar", length: 60 }) about!: string;

  @OneToOne(() => FrsUser)
  @RelationColumn({ name: "user_id" })
  user!: Relation<FrsUser>;
}

@Entity({ name: "frs_assets" })
@Inheritance({ strategy: "SINGLE_TABLE" })
@DiscriminatorColumn({ name: "kind", type: "varchar", length: 20 })
class FrsAsset {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 60 }) url!: string;
}

@Entity()
@DiscriminatorValue("image")
class FrsImage extends FrsAsset {
  @Column({ type: "int", nullable: true }) width!: number;
}

@Entity({ name: "frs_tags" })
class FrsTag {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) label!: string;
  @Column({ type: "varchar", length: 40 }) color!: string;
}

@Entity({ name: "frs_posts" })
class FrsPost {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) title!: string;
  @Column({ type: "varchar", length: 60 }) body!: string;

  @ManyToOne(() => FrsUser, (u: FrsUser) => u.posts)
  @RelationColumn({ name: "author_id" })
  author!: Relation<FrsUser> | null;

  @ManyToOne(() => FrsAsset, (a: FrsAsset) => a.id)
  @RelationColumn({ name: "cover_id" })
  cover!: Relation<FrsAsset> | null;

  @OneToMany(() => FrsComment, { mappedBy: "post" })
  comments!: FrsComment[];

  @ManyToMany(() => FrsTag, {
    joinTable: { name: "frs_post_tags", joinColumn: "post_id", inverseJoinColumn: "tag_id" },
  })
  tags!: FrsTag[];
}

@Entity({ name: "frs_comments" })
class FrsComment {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) body!: string;
  @Column({ type: "int", name: "score_points" }) score!: number;

  @ManyToOne(() => FrsPost, (p: FrsPost) => p.comments)
  @RelationColumn({ name: "post_id" })
  post!: Relation<FrsPost>;

  @ManyToOne(() => FrsUser, (u: FrsUser) => u.id)
  @RelationColumn({ name: "author_id" })
  author!: Relation<FrsUser> | null;
}

async function captureSql(run: () => Promise<unknown>): Promise<string[]> {
  const connector = DatabaseClient.getInstance().getConnection("frs");
  const spy = jest.spyOn(connector, "query");
  try {
    await run();
    return spy.mock.calls.map(([query]: any[]) => String(query?.text ?? query?.sql ?? query));
  } finally {
    spy.mockRestore();
  }
}

async function rejection(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the read to reject");
}

describe("[Integration] SQLite: select in a relation's entry", () => {
  let em: EntityManager;

  beforeAll(async () => {
    em = await createTestEntityManager({
      entities: [FrsTeam, FrsUser, FrsProfile, FrsAsset, FrsImage, FrsTag, FrsPost, FrsComment],
      connectionName: "frs",
    });

    const team = await em.save(FrsTeam, { name: "core", motto: "ship it" });
    const alice = await em.save(FrsUser, { name: "alice", email: "a@x.io", team } as any);
    const bob = await em.save(FrsUser, { name: "bob", email: "b@x.io", team: null } as any);
    await em.save(FrsProfile, { avatar: "a.png", about: "about alice", user: alice } as any);
    const cover = await em.save(FrsImage, { url: "c.png", width: 640 } as any);
    const red = await em.save(FrsTag, { label: "red", color: "#f00" });

    const p1 = await em.save(FrsPost, { title: "p1", body: "body 1", author: alice, cover } as any);
    await em.save(FrsPost, { title: "p2", body: "body 2", author: bob, cover: null } as any);
    await em.query(`INSERT INTO frs_post_tags (post_id, tag_id) VALUES (${p1.id}, ${red.id})`);
    await em.save(FrsComment, { body: "nice", score: 3, post: p1, author: bob } as any);
    await em.save(FrsComment, { body: "thanks", score: 5, post: p1, author: alice } as any);
  });

  afterAll(async () => {
    await em.propagateShutdown();
  });

  it("reads only the named columns of a JOINed ManyToOne, keeping its key", async () => {
    let posts: any[] = [];
    const sql = await captureSql(async () => {
      posts = await em.find(FrsPost, {
        relations: { author: { select: ["name"] } },
        orderBy: { id: "ASC" },
      });
    });

    expect(posts.map((p) => [typeof p.author.id, p.author.name, p.author.email])).toEqual([
      ["number", "alice", undefined],
      ["number", "bob", undefined],
    ]);
    expect(posts[0].author).toBeInstanceOf(FrsUser);
    expect(sql[0]).toContain('"author"."name"');
    expect(sql[0]).not.toContain('"author"."email"');
  });

  it("narrows the batched OneToMany, ManyToMany and inverse OneToOne reads", async () => {
    const [post]: any[] = await em.find(FrsPost, {
      where: { title: "p1" },
      relations: {
        comments: { select: ["body", "score"], orderBy: { id: "ASC" } },
        tags: { select: { label: true, color: false } },
      },
    });
    const [user]: any[] = await em.find(FrsUser, {
      where: { name: "alice" },
      relations: { profile: { select: ["avatar"] } },
    });

    expect(post.comments.map((c: any) => ({ ...c }))).toEqual([
      { id: expect.any(Number), body: "nice", score: 3 },
      { id: expect.any(Number), body: "thanks", score: 5 },
    ]);
    expect(post.tags.map((t: any) => ({ ...t }))).toEqual([{ id: expect.any(Number), label: "red" }]);
    expect({ ...user.profile }).toEqual({ id: expect.any(Number), avatar: "a.png" });
  });

  it("narrows a JOINed owning OneToOne", async () => {
    const [profile]: any[] = await em.find(FrsProfile, { relations: { user: { select: ["email"] } } });

    expect([typeof profile.user.id, profile.user.email, profile.user.name]).toEqual([
      "number",
      "a@x.io",
      undefined,
    ]);
  });

  it("keeps the join column a nested to-one relation is loaded by", async () => {
    const [post]: any[] = await em.find(FrsPost, {
      where: { title: "p1" },
      relations: {
        author: { select: ["name"], relations: { team: { select: ["name"] } } },
        comments: {
          select: ["body"],
          orderBy: { id: "ASC" },
          relations: { author: { select: ["name"] } },
        },
      },
    });

    expect(post.author.name).toBe("alice");
    expect({ ...post.author.team }).toEqual({ id: expect.any(Number), name: "core" });
    expect(post.author.email).toBeUndefined();
    expect(post.comments.map((c: any) => [c.body, c.author.name, c.author.email])).toEqual([
      ["nice", "bob", undefined],
      ["thanks", "alice", undefined],
    ]);
  });

  it("keeps the key a nested collection is matched by", async () => {
    const [post]: any[] = await em.find(FrsPost, {
      where: { title: "p1" },
      relations: { author: { select: ["name"], relations: { posts: { select: ["title"] } } } },
    });

    expect(post.author.posts.map((p: any) => ({ ...p }))).toEqual([{ id: post.id, title: "p1" }]);
  });

  it("combines with the read's own select", async () => {
    const [post]: any[] = await em.find(FrsPost, {
      select: ["title"],
      where: { title: "p1" },
      relations: { comments: { select: ["body"], orderBy: { id: "ASC" } } },
    });

    expect(post.title).toBe("p1");
    expect(post.body).toBeUndefined();
    expect(post.comments.map((c: any) => c.body)).toEqual(["nice", "thanks"]);
  });

  it("narrows the batched to-one read of a cursor page", async () => {
    const page = await em.findWithCursor(FrsPost, {
      take: 10,
      relations: { author: { select: ["name"] } },
    });

    expect(page.data.map((p: any) => ({ ...p.author }))).toEqual([
      { id: expect.any(Number), name: "alice" },
      { id: expect.any(Number), name: "bob" },
    ]);
  });

  it("reads the discriminator of a hierarchy root, so the row is built as its subclass", async () => {
    const [post]: any[] = await em.find(FrsPost, {
      where: { title: "p1" },
      relations: { cover: { select: ["url"] } },
    });

    expect(post.cover).toBeInstanceOf(FrsImage);
    expect(post.cover.url).toBe("c.png");
    expect(post.cover.width).toBeUndefined();
  });

  it("leaves a missing to-one null", async () => {
    const [post]: any[] = await em.find(FrsPost, {
      where: { title: "p2" },
      relations: { cover: { select: ["url"] }, author: { select: ["name"], relations: { team: { select: ["name"] } } } },
    });

    expect(post.cover).toBeNull();
    expect(post.author.team).toBeNull();
  });

  it("rejects a column the related entity lacks, naming the closest one", async () => {
    const error = await rejection(
      em.find(FrsPost, { relations: { comments: { select: ["bdy"] as any } } }),
    );

    expect(error).toBeInstanceOf(InvalidQueryError);
    expect(error.message).toContain('Unknown column "bdy" in "select" for entity "FrsComment"');
    expect(error.message).toContain('Did you mean "body"?');
  });

  it("rejects a select that names nothing or nests options", async () => {
    const empty = await rejection(em.find(FrsPost, { relations: { comments: { select: [] } } }));
    const nested = await rejection(
      em.find(FrsPost, { relations: { comments: { select: { author: { name: true } } as any } } }),
    );

    expect(empty).toBeInstanceOf(InvalidQueryError);
    expect(empty.message).toContain('"select" of relation "comments" in "relations" names no property');
    expect(nested).toBeInstanceOf(InvalidQueryError);
    expect(nested.message).toContain('"select.author" of relation "comments" in "relations" must be true or false');
  });

  it("rejects a nested options object in the read's own select", async () => {
    const error = await rejection(
      em.find(FrsPost, { select: { title: true, author: { select: ["name"] } } as any }),
    );

    expect(error).toBeInstanceOf(InvalidQueryError);
    expect(error.message).toContain("'select.author' must be true or false, got an object");
    expect(error.message).toContain("relations: { author: { select: [...] } }");
  });
});
