/**
 * Read-path `relations` identifier validation (V4-T2-3).
 *
 * Every relation loader filters the requested names with
 * `relations.includes(...)`, so before this guard a typo produced no error at
 * all: the query succeeded and the relation property stayed `undefined` — a
 * silently wrong answer, while the same typo in a bulk update criteria already
 * threw "Unknown column ... Valid columns: ...". Nested paths
 * ("author.profile") were documented in FindOption's JSDoc but never
 * implemented, so they could only ever no-op.
 *
 * Fail-before (probe on 3df4001): all four typo cases below returned rows with
 * the relation missing, and the nested entry was silently dropped.
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../../src/decorators/ManyToOne";
import { OneToMany } from "../../../src/decorators/OneToMany";
import { OneToOne } from "../../../src/decorators/OneToOne";
import { ManyToMany } from "../../../src/decorators/ManyToMany";
import { Relation } from "../../../src/types/Relation";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";
import { InvalidQueryError } from "../../../src/errors/InvalidQueryError";

@Entity({ name: "rnv_profiles" })
class RnvProfile {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 100 })
  bio!: string;

  @Column({ type: "int", nullable: true })
  authorId?: number;

  @OneToOne(() => RnvAuthor, { joinColumn: "authorId", inverseSide: "profile" })
  author!: Relation<RnvAuthor>;
}

@Entity({ name: "rnv_tags" })
class RnvTag {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 60 })
  label!: string;
}

@Entity({ name: "rnv_authors" })
class RnvAuthor {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 100 })
  name!: string;

  @OneToMany(() => RnvPost, { mappedBy: "author" })
  posts!: RnvPost[];

  @OneToOne(() => RnvProfile, { inverseSide: "author" })
  profile!: Relation<RnvProfile>;
}

@Entity({ name: "rnv_posts" })
class RnvPost {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 120 })
  title!: string;

  @Column({ type: "int", nullable: true })
  authorId?: number;

  @ManyToOne(() => RnvAuthor, (e: RnvAuthor) => e.posts, { joinColumn: "authorId" })
  author!: Relation<RnvAuthor>;

  @ManyToMany(() => RnvTag, {
    joinTable: {
      name: "rnv_post_tags",
      joinColumn: "postId",
      inverseJoinColumn: "tagId",
    },
  })
  tags!: RnvTag[];
}

/** Runs a query that must reject and hands back the thrown error, typed. */
async function captureError(run: () => Promise<unknown>): Promise<InvalidQueryError> {
  try {
    await run();
  } catch (error) {
    return error as InvalidQueryError;
  }
  throw new Error("expected the query to reject, but it resolved");
}

describe("[Integration] SQLite: relations identifier validation", () => {
  let em: EntityManager;

  beforeAll(async () => {
    em = await createTestEntityManager({
      entities: [RnvAuthor, RnvPost, RnvTag, RnvProfile],
    });
    const author = await em.save(RnvAuthor, { name: "kim" });
    await em.save(RnvProfile, { bio: "hello", authorId: author.id });
    const post = await em.save(RnvPost, { title: "p1", authorId: author.id });
    const tag = await em.save(RnvTag, { label: "orm" });
    await em.attachRelation(RnvPost, post.id, "tags", tag.id);
  });

  afterAll(async () => {
    await (em as unknown as { destroy?: () => Promise<void> }).destroy?.();
  });

  describe("fail-fast on unresolvable names", () => {
    it("rejects a misspelled ManyToOne relation and names the valid ones", async () => {
      await expect(
        em.find(RnvPost, { relations: ["autor"] }),
      ).rejects.toThrow(InvalidQueryError);

      const error = await captureError(() => em.find(RnvPost, { relations: ["autor"] }));
      expect(error.message).toContain('Unknown relation "autor"');
      expect(error.message).toContain('entity "RnvPost"');
      expect(error.message).toContain("author (ManyToOne)");
      expect(error.message).toContain("tags (ManyToMany)");
      expect(error.message).toContain('Did you mean "author"?');
    });

    it("rejects a misspelled OneToMany relation", async () => {
      const error = await captureError(() => em.find(RnvAuthor, { relations: ["postz"] }));
      expect(error).toBeInstanceOf(InvalidQueryError);
      expect(error.message).toContain('Unknown relation "postz"');
      expect(error.message).toContain("posts (OneToMany)");
      expect(error.message).toContain('Did you mean "posts"?');
    });

    it("rejects a misspelled ManyToMany relation", async () => {
      const error = await captureError(() => em.find(RnvPost, { relations: ["tagz"] }));
      expect(error).toBeInstanceOf(InvalidQueryError);
      expect(error.message).toContain('Unknown relation "tagz"');
      expect(error.message).toContain('Did you mean "tags"?');
    });

    it("rejects a misspelled OneToOne relation", async () => {
      const error = await captureError(() => em.find(RnvAuthor, { relations: ["profil"] }));
      expect(error).toBeInstanceOf(InvalidQueryError);
      expect(error.message).toContain('Unknown relation "profil"');
      expect(error.message).toContain("profile (OneToOne)");
    });

    it("accepts a case-only mismatch as the intended name in the hint", async () => {
      const error = await captureError(() => em.find(RnvPost, { relations: ["Author"] }));
      expect(error).toBeInstanceOf(InvalidQueryError);
      expect(error.message).toContain('Did you mean "author"?');
    });

    it("omits the hint when nothing is close enough", async () => {
      const error = await captureError(() => em.find(RnvPost, { relations: ["zzzzzzzz"] }));
      expect(error).toBeInstanceOf(InvalidQueryError);
      expect(error.message).not.toContain("Did you mean");
    });

    it("rejects a nested relation path with a dedicated message", async () => {
      const error = await captureError(() => em.find(RnvPost, { relations: ["author", "author.profile"] }));
      expect(error).toBeInstanceOf(InvalidQueryError);
      expect(error.message).toContain(
        'Nested relation path "author.profile" is not supported',
      );
      expect((error as InvalidQueryError).suggestion).toContain(
        'Load "author" here',
      );
    });

    it("guards findOne / findAndCount / findWithPage through the same gate", async () => {
      await expect(
        em.findOne(RnvPost, { relations: ["autor"] }),
      ).rejects.toThrow(InvalidQueryError);
      await expect(
        em.findAndCount(RnvPost, { relations: ["autor"] }),
      ).rejects.toThrow(InvalidQueryError);
      await expect(
        em.findWithPage(RnvPost, { relations: ["autor"], page: 1, pageSize: 10 }),
      ).rejects.toThrow(InvalidQueryError);
    });

  });

  describe("no regression for valid usage", () => {
    it("loads ManyToOne + ManyToMany by property name", async () => {
      const posts = await em.find(RnvPost, { relations: ["author", "tags"] });
      expect(posts[0].author?.name).toBe("kim");
      expect(posts[0].tags?.map((t) => t.label)).toEqual(["orm"]);
    });

    it("loads OneToMany + inverse OneToOne", async () => {
      const authors = await em.find(RnvAuthor, {
        relations: ["posts", "profile"],
      });
      expect(authors[0].posts?.[0]?.title).toBe("p1");
      expect(authors[0].profile?.bio).toBe("hello");
    });

    it("loads the owning side of a OneToOne", async () => {
      const profiles = await em.find(RnvProfile, { relations: ["author"] });
      expect(profiles[0].author?.name).toBe("kim");
    });

    it("leaves queries without relations untouched", async () => {
      const posts = await em.find(RnvPost, { where: { title: "p1" } });
      expect(posts).toHaveLength(1);
      expect(posts[0].author).toBeUndefined();
    });

    it("accepts an empty relations array", async () => {
      const posts = await em.find(RnvPost, { relations: [] });
      expect(posts).toHaveLength(1);
    });
  });
});
