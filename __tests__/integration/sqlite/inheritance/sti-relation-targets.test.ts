/**
 * Relations whose target is in a SINGLE_TABLE hierarchy.
 *
 * - A relation targeting a child loads that subtype's rows only: the
 *   batched OneToMany / ManyToMany / inverse OneToOne reads, the to-one
 *   JOIN of find(), the to-one read of a cursor page, nested levels and
 *   per-parent paging all add the discriminator predicate find(Child) adds.
 * - A relation targeting the root builds each row as its subclass, cut to
 *   that class's columns, as find(Root) does.
 */
import "reflect-metadata";
import { Entity } from "../../../../src/decorators/Entity";
import { Column } from "../../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../../../src/decorators/ManyToOne";
import { OneToMany } from "../../../../src/decorators/OneToMany";
import { ManyToMany } from "../../../../src/decorators/ManyToMany";
import { OneToOne } from "../../../../src/decorators/OneToOne";
import { RelationColumn } from "../../../../src/decorators/RelationColumn";
import { Inheritance } from "../../../../src/decorators/Inheritance";
import { DiscriminatorColumn } from "../../../../src/decorators/DiscriminatorColumn";
import { DiscriminatorValue } from "../../../../src/decorators/DiscriminatorValue";
import { Relation } from "../../../../src/types/Relation";
import { createTestEntityManager } from "../../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../../src/core/EntityManager";

@Entity({ name: "srt_authors" })
class SrtAuthor {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) name!: string;
  @OneToMany(() => SrtPost, { mappedBy: "author" }) posts!: SrtPost[];
  /** Inverse side of the root's `author`; the target is the premium subtype. */
  @OneToOne(() => SrtPremium, { inverseSide: "author" }) premiumNote!: Relation<SrtPremium> | null;
}

@Entity({ name: "srt_posts" })
class SrtPost {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) title!: string;
  @ManyToOne(() => SrtAuthor, (a: SrtAuthor) => a.posts)
  @RelationColumn({ name: "author_id", nullable: true })
  author!: Relation<SrtAuthor> | null;
  /** The whole hierarchy. */
  @OneToMany(() => SrtComment, { mappedBy: "post" }) comments!: SrtComment[];
  /** One subtype of the same table. */
  @OneToMany(() => SrtPremium, { mappedBy: "post" }) premiumComments!: SrtPremium[];
  @ManyToMany(() => SrtPremium, {
    joinTable: { name: "srt_post_pins", joinColumn: "post_id", inverseJoinColumn: "comment_id" },
  })
  pinned!: SrtPremium[];
  @ManyToOne(() => SrtPremium, (c: SrtPremium) => c.id)
  @RelationColumn({ name: "featured_id", nullable: true })
  featured!: Relation<SrtPremium> | null;
}

@Entity({ name: "srt_comments" })
@Inheritance({ strategy: "SINGLE_TABLE" })
@DiscriminatorColumn({ name: "kind" })
class SrtComment {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) body!: string;
  @ManyToOne(() => SrtPost, (p: SrtPost) => p.comments)
  @RelationColumn({ name: "post_id", nullable: true })
  post!: Relation<SrtPost> | null;
  @OneToOne(() => SrtAuthor)
  @RelationColumn({ name: "author_id", nullable: true })
  author!: Relation<SrtAuthor> | null;
}

@Entity()
@DiscriminatorValue("premium")
class SrtPremium extends SrtComment {
  @Column({ type: "int", nullable: true }) tier!: number | null;
}

@Entity()
@DiscriminatorValue("plain")
class SrtPlain extends SrtComment {
  @Column({ type: "varchar", length: 10, nullable: true }) mood!: string | null;
}

describe("[Integration] SQLite: relations targeting a SINGLE_TABLE hierarchy", () => {
  let em: EntityManager;
  let postId: number;
  let plainId: number;
  let premiumId: number;
  let aliceId: number;
  let bobId: number;

  beforeAll(async () => {
    em = await createTestEntityManager({
      entities: [SrtAuthor, SrtPost, SrtComment, SrtPremium, SrtPlain],
      connectionName: "srt",
    });
    const alice = await em.save(SrtAuthor, { name: "alice" });
    const bob = await em.save(SrtAuthor, { name: "bob" });
    aliceId = alice.id;
    bobId = bob.id;
    const post = await em.save(SrtPost, { title: "p1", author: alice });
    postId = post.id;
    // alice's note is plain, bob's is premium — both through the root's column.
    const plain = await em.save(SrtPlain, { body: "plain", mood: "ok", post, author: alice });
    const premium = await em.save(SrtPremium, { body: "premium", tier: 2, post, author: bob });
    await em.save(SrtPremium, { body: "premium-2", tier: 1, post, author: null });
    plainId = plain.id;
    premiumId = premium.id;
    await em.query(
      `INSERT INTO srt_post_pins (post_id, comment_id) VALUES (${postId}, ${plainId}), (${postId}, ${premiumId})`,
    );
  });

  afterAll(async () => {
    await em.propagateShutdown();
  });

  const bodies = (rows: Array<{ body: string }>) => rows.map((r) => r.body).sort();

  it("a OneToMany targeting a child loads that subtype's rows only", async () => {
    const post = (await em.findOne(SrtPost, { where: { id: postId }, relations: ["premiumComments"] }))!;
    expect(bodies(post.premiumComments)).toEqual(["premium", "premium-2"]);
    expect(post.premiumComments.every((c) => c instanceof SrtPremium)).toBe(true);
  });

  it("a OneToMany targeting the root builds each row as its subclass", async () => {
    const post = (await em.findOne(SrtPost, { where: { id: postId }, relations: ["comments"] }))!;
    expect(bodies(post.comments)).toEqual(["plain", "premium", "premium-2"]);
    const plain = post.comments.find((c) => c.body === "plain")!;
    const premium = post.comments.find((c) => c.body === "premium")!;
    expect(plain).toBeInstanceOf(SrtPlain);
    expect(premium).toBeInstanceOf(SrtPremium);
    expect((premium as SrtPremium).tier).toBe(2);
    expect("mood" in premium).toBe(false);
    expect("tier" in plain).toBe(false);
    expect("kind" in plain).toBe(false);
  });

  it("a ManyToMany targeting a child skips join rows that point at a sibling", async () => {
    const post = (await em.findOne(SrtPost, { where: { id: postId }, relations: ["pinned"] }))!;
    expect(bodies(post.pinned)).toEqual(["premium"]);
  });

  it("a JOINed ManyToOne targeting a child is null when the key points at a sibling", async () => {
    await em.updateMany(SrtPost, { featuredId: plainId } as any, { where: { id: postId } });
    let post = (await em.findOne(SrtPost, { where: { id: postId }, relations: ["featured"] }))!;
    expect(post.featured).toBeNull();

    await em.updateMany(SrtPost, { featuredId: premiumId } as any, { where: { id: postId } });
    post = (await em.findOne(SrtPost, { where: { id: postId }, relations: ["featured"] }))!;
    expect(post.featured?.body).toBe("premium");
    expect(post.featured).toBeInstanceOf(SrtPremium);
  });

  it("the to-one read of a cursor page applies the same predicate", async () => {
    await em.updateMany(SrtPost, { featuredId: plainId } as any, { where: { id: postId } });
    let page = await em.findWithCursor(SrtPost, { take: 5, relations: ["featured"] });
    expect(page.data[0].featured).toBeNull();

    await em.updateMany(SrtPost, { featuredId: premiumId } as any, { where: { id: postId } });
    page = await em.findWithCursor(SrtPost, { take: 5, relations: ["featured"] });
    expect(page.data[0].featured?.body).toBe("premium");
  });

  it("an inverse OneToOne targeting a child ignores a sibling's row", async () => {
    const authors = await em.find(SrtAuthor, { relations: ["premiumNote"], orderBy: { id: "ASC" } });
    const alice = authors.find((a) => a.id === aliceId)!;
    const bob = authors.find((a) => a.id === bobId)!;
    expect(alice.premiumNote).toBeNull();
    expect(bob.premiumNote?.body).toBe("premium");
  });

  it("applies at a nested level and under per-parent paging", async () => {
    const authors = await em.find(SrtAuthor, {
      where: { id: aliceId },
      relations: { posts: { relations: { premiumComments: { orderBy: { tier: "ASC" }, take: 1 } } } },
    });
    expect(authors[0].posts[0].premiumComments.map((c) => c.body)).toEqual(["premium-2"]);
  });
});
