/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The upsert family writes the `@ManyToOne` keys a payload states, the way
 * insertMany() and save() do.
 *
 * `upsert()` / `insertIgnore()` / `batchUpsert()` built their column list from
 * the declared `@Column`s alone, so a relation — given as a related instance,
 * a bare key or the `${property}Id` shadow — was dropped without a word and
 * the row stored a NULL foreign key. With a conflict target over the FK
 * columns that was worse than a lost value: NULLs never conflict, so every
 * "upsert" of the same pair inserted another orphan row.
 *
 * A join column that is also a declared `@Column` was dropped too when the
 * payload stated only the relation.
 */
import "reflect-metadata";
import {
  Column,
  DeletedAt,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  RelationColumn,
  UniqueIndex,
} from "../../../src";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";

@Entity({ name: "ufk_user" })
class UfkUser {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
}

@Entity({ name: "ufk_post" })
class UfkPost {
  @PrimaryGeneratedColumn() id!: number;
  @Column() title!: string;
}

/** Join columns no `@Column` declares, unique per (user, post). */
@Entity({ name: "ufk_like" })
@UniqueIndex(["user_id", "post_id"])
class UfkLike {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "int", default: 1 }) weight!: number;

  @ManyToOne(() => UfkUser, () => undefined)
  @RelationColumn({ name: "user_id" })
  user!: UfkUser;

  @ManyToOne(() => UfkPost, () => undefined)
  @RelationColumn({ name: "post_id" })
  post!: UfkPost;
}

/** A join column declared as a `@Column` under its own DB name. */
@Entity({ name: "ufk_note" })
@UniqueIndex(["slug"])
class UfkNote {
  @PrimaryGeneratedColumn() id!: number;
  @Column() slug!: string;
  @Column({ name: "owner_fk", type: "int", nullable: true })
  ownerId!: number | null;

  @ManyToOne(() => UfkUser, () => undefined)
  owner!: UfkUser;
}

/** Only keys and the soft-delete column: a conflict can only revive. */
@Entity({ name: "ufk_bookmark" })
@UniqueIndex(["user_id", "post_id"])
class UfkBookmark {
  @PrimaryGeneratedColumn() id!: number;

  @ManyToOne(() => UfkUser, () => undefined)
  @RelationColumn({ name: "user_id" })
  user!: UfkUser;

  @ManyToOne(() => UfkPost, () => undefined)
  @RelationColumn({ name: "post_id" })
  post!: UfkPost;

  @DeletedAt() deletedAt!: Date | null;
}

const PAIR = ["user_id", "post_id"];

describe("[Integration] SQLite: the upsert family writes @ManyToOne keys", () => {
  let em: EntityManager;
  let alice: UfkUser;
  let bob: UfkUser;
  let post: UfkPost;

  beforeAll(async () => {
    em = await createTestEntityManager({
      entities: [UfkUser, UfkPost, UfkLike, UfkNote, UfkBookmark],
    });
  });

  afterAll(async () => {
    await (em as unknown as { destroy?: () => Promise<void> }).destroy?.();
  });

  beforeEach(async () => {
    for (const table of [
      "ufk_like",
      "ufk_note",
      "ufk_bookmark",
      "ufk_user",
      "ufk_post",
    ]) {
      await em.query(`DELETE FROM ${table}`);
    }
    alice = await em.save(UfkUser, { name: "alice" } as any);
    bob = await em.save(UfkUser, { name: "bob" } as any);
    post = await em.save(UfkPost, { title: "p" } as any);
  });

  async function rows(table: string, columns: string): Promise<any[]> {
    return (await em.query(
      `SELECT ${columns} FROM ${table} ORDER BY id`,
    )) as unknown as any[];
  }

  async function trashBookmarks(): Promise<void> {
    for (const { id } of await rows("ufk_bookmark", "id")) {
      await em.softDelete(UfkBookmark, { id });
    }
  }

  describe("upsert()", () => {
    it("writes the key of a related instance", async () => {
      await em.upsert(UfkLike, { user: alice, post, weight: 3 } as any, PAIR);

      expect(await rows("ufk_like", "user_id, post_id, weight")).toEqual([
        { user_id: alice.id, post_id: post.id, weight: 3 },
      ]);
    });

    it("updates the row for the same pair instead of inserting another", async () => {
      await em.upsert(UfkLike, { user: alice, post, weight: 3 } as any, PAIR);
      await em.upsert(UfkLike, { user: alice, post, weight: 5 } as any, PAIR);

      expect(await rows("ufk_like", "user_id, post_id, weight")).toEqual([
        { user_id: alice.id, post_id: post.id, weight: 5 },
      ]);
    });

    it("accepts a bare key and the ${property}Id shadow", async () => {
      await em.upsert(
        UfkLike,
        { user: alice.id, post: post.id, weight: 3 } as any,
        PAIR,
      );
      await em.upsert(
        UfkLike,
        { userId: alice.id, postId: post.id, weight: 7 } as any,
        PAIR,
      );

      expect(await rows("ufk_like", "user_id, post_id, weight")).toEqual([
        { user_id: alice.id, post_id: post.id, weight: 7 },
      ]);
    });

    it("inserts a row whose payload states only its relations", async () => {
      const result = await em.upsert(UfkLike, { user: alice, post } as any, PAIR);

      expect(result).toEqual({ affected: 1 });
      expect(await rows("ufk_like", "user_id, post_id, weight")).toEqual([
        { user_id: alice.id, post_id: post.id, weight: 1 },
      ]);
    });

    it("reassigns a stated key on conflict when it is not the conflict target", async () => {
      await em.upsert(UfkNote, { slug: "a", owner: alice } as any, ["slug"]);
      await em.upsert(UfkNote, { slug: "a", owner: bob } as any, ["slug"]);

      expect(await rows("ufk_note", "slug, owner_fk")).toEqual([
        { slug: "a", owner_fk: bob.id },
      ]);
    });

    it("keeps the stored key on conflict when the payload leaves the relation out", async () => {
      await em.upsert(UfkNote, { slug: "a", owner: alice } as any, ["slug"]);
      await em.upsert(UfkNote, { slug: "a" } as any, ["slug"]);

      expect(await rows("ufk_note", "slug, owner_fk")).toEqual([
        { slug: "a", owner_fk: alice.id },
      ]);
    });

    it("writes NULL for a relation stated as null", async () => {
      await em.upsert(UfkNote, { slug: "a", owner: alice } as any, ["slug"]);
      await em.upsert(UfkNote, { slug: "a", owner: null } as any, ["slug"]);

      expect(await rows("ufk_note", "slug, owner_fk")).toEqual([
        { slug: "a", owner_fk: null },
      ]);
    });

    it("fills a declared join column from the relation", async () => {
      await em.upsert(UfkNote, { slug: "a", owner: alice } as any, ["slug"]);
      await em.upsert(UfkNote, { slug: "b", owner: bob.id } as any, ["slug"]);
      await em.upsert(UfkNote, { slug: "c", ownerId: alice.id } as any, ["slug"]);

      expect(await rows("ufk_note", "slug, owner_fk")).toEqual([
        { slug: "a", owner_fk: alice.id },
        { slug: "b", owner_fk: bob.id },
        { slug: "c", owner_fk: alice.id },
      ]);
    });

    it("revives a soft-deleted row identified by its keys", async () => {
      await em.upsert(UfkBookmark, { user: alice, post } as any, PAIR);
      await trashBookmarks();

      await em.upsert(UfkBookmark, { user: alice, post } as any, PAIR);

      expect(await rows("ufk_bookmark", "user_id, post_id, deletedAt")).toEqual([
        { user_id: alice.id, post_id: post.id, deletedAt: null },
      ]);
    });

    it("does not change the caller's payload", async () => {
      const payload = { user: alice, post, weight: 3 };
      await em.upsert(UfkLike, payload as any, PAIR);

      expect(payload).toEqual({ user: alice, post, weight: 3 });
    });
  });

  describe("insertIgnore()", () => {
    it("writes the keys and skips an existing pair", async () => {
      const first = await em.insertIgnore(
        UfkLike,
        { user: alice, post, weight: 3 } as any,
        PAIR,
      );
      const second = await em.insertIgnore(
        UfkLike,
        { user: alice, post, weight: 9 } as any,
        PAIR,
      );

      expect([first, second]).toEqual([{ affected: 1 }, { affected: 0 }]);
      expect(await rows("ufk_like", "user_id, post_id, weight")).toEqual([
        { user_id: alice.id, post_id: post.id, weight: 3 },
      ]);
    });

    it("fills a declared join column from the relation", async () => {
      await em.insertIgnore(UfkNote, { slug: "a", owner: bob } as any, ["slug"]);

      expect(await rows("ufk_note", "slug, owner_fk")).toEqual([
        { slug: "a", owner_fk: bob.id },
      ]);
    });
  });

  describe("batchUpsert()", () => {
    it("writes each row's keys, whichever form states them", async () => {
      await em.batchUpsert(
        UfkLike,
        [
          { user: alice, post, weight: 1 },
          { user: bob.id, post: post.id, weight: 2 },
        ] as any,
        PAIR,
      );
      await em.batchUpsert(
        UfkLike,
        [
          { userId: alice.id, postId: post.id, weight: 10 },
          { user: bob, post, weight: 20 },
        ] as any,
        PAIR,
      );

      expect(await rows("ufk_like", "user_id, post_id, weight")).toEqual([
        { user_id: alice.id, post_id: post.id, weight: 10 },
        { user_id: bob.id, post_id: post.id, weight: 20 },
      ]);
    });

    it("binds NULL for a row that states no key when another row does", async () => {
      await em.batchUpsert(
        UfkNote,
        [
          { slug: "a", owner: alice },
          { slug: "b" },
        ] as any,
        ["slug"],
      );

      expect(await rows("ufk_note", "slug, owner_fk")).toEqual([
        { slug: "a", owner_fk: alice.id },
        { slug: "b", owner_fk: null },
      ]);
    });

    it("fills a declared join column row by row", async () => {
      await em.batchUpsert(
        UfkNote,
        [
          { slug: "a", ownerId: bob.id },
          { slug: "b", owner: alice },
        ] as any,
        ["slug"],
      );

      expect(await rows("ufk_note", "slug, owner_fk")).toEqual([
        { slug: "a", owner_fk: bob.id },
        { slug: "b", owner_fk: alice.id },
      ]);
    });

    it("revives soft-deleted rows keyed by relations, a repeated pair once", async () => {
      await em.batchUpsert(UfkBookmark, [{ user: alice, post }] as any, PAIR);
      await trashBookmarks();

      await em.batchUpsert(
        UfkBookmark,
        [
          { user: alice, post },
          { user: alice.id, post: post.id },
          { user: bob, post },
        ] as any,
        PAIR,
      );

      expect(await rows("ufk_bookmark", "user_id, post_id, deletedAt")).toEqual([
        { user_id: alice.id, post_id: post.id, deletedAt: null },
        { user_id: bob.id, post_id: post.id, deletedAt: null },
      ]);
    });
  });
});
