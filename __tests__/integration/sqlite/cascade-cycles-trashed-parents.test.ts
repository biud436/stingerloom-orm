/**
 * Cascades over object graphs that point back at an ancestor, and hard
 * deletes of a soft-deleted parent.
 *
 * - A graph whose cascaded entity points back at the row being saved —
 *   `user.profile.user === user`, `user.avatar.owner === user`, a post in
 *   `owner.posts` whose `user` is the owner — saved the ancestor again from
 *   the child, which cascaded to the child again, without end. Each row is
 *   now saved once, and the child's join column takes the parent's key.
 * - `delete()` removes a soft-deleted parent too, but the cascade read only
 *   live parents, so the parent went and its cascaded rows stayed behind.
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { OneToOne } from "../../../src/decorators/OneToOne";
import { OneToMany } from "../../../src/decorators/OneToMany";
import { ManyToOne } from "../../../src/decorators/ManyToOne";
import { RelationColumn } from "../../../src/decorators/RelationColumn";
import { DeletedAt } from "../../../src/decorators/DeletedAt";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";

@Entity({ name: "cct_profiles" })
class CctProfile {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) bio!: string;
  @OneToOne(() => CctUser, { inverseSide: "profile", cascade: true }) user!: CctUser | null;
}

@Entity({ name: "cct_avatars" })
class CctAvatar {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) url!: string;
  @OneToOne(() => CctUser, { cascade: true })
  @RelationColumn({ name: "owner_id", nullable: true })
  owner!: CctUser | null;
}

@Entity({ name: "cct_users" })
class CctUser {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) name!: string;
  @OneToOne(() => CctProfile, { cascade: true })
  @RelationColumn({ name: "profile_id", nullable: true })
  profile!: CctProfile | null;
  @OneToOne(() => CctAvatar, { inverseSide: "owner", cascade: true }) avatar!: CctAvatar | null;
  @OneToMany(() => CctPost, { mappedBy: "user", cascade: true }) posts!: CctPost[];
  @DeletedAt() deletedAt!: Date | null;
}

@Entity({ name: "cct_posts" })
class CctPost {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) title!: string;
  @ManyToOne(() => CctUser, (u: CctUser) => u.posts, { cascade: true })
  @RelationColumn({ name: "user_id", nullable: true })
  user!: CctUser | null;
}

describe("[Integration] SQLite: cascades over back-references and trashed parents", () => {
  let em: EntityManager;

  beforeAll(async () => {
    em = await createTestEntityManager({ entities: [CctProfile, CctAvatar, CctUser, CctPost] });
  });

  afterAll(async () => {
    await em.propagateShutdown();
  });

  beforeEach(async () => {
    for (const table of ["cct_posts", "cct_avatars", "cct_users", "cct_profiles"]) {
      await em.query(`DELETE FROM ${table}`);
    }
  });

  const rows = (table: string) => em.query<any>(`SELECT * FROM ${table} ORDER BY id`);

  describe("back-references", () => {
    it("saves an owning OneToOne whose target points back at the row once", async () => {
      const user: any = { name: "alice", profile: { bio: "hi" } };
      user.profile.user = user;
      const saved = await em.save(CctUser, user);

      const [profile] = await rows("cct_profiles");
      expect(await rows("cct_users")).toEqual([expect.objectContaining({ id: saved.id, profile_id: profile.id })]);
      expect(await rows("cct_profiles")).toHaveLength(1);
    });

    it("saves an inverse OneToOne whose counterpart points back at the row once", async () => {
      const user: any = { name: "bob", avatar: { url: "a.png" } };
      user.avatar.owner = user;
      const saved = await em.save(CctUser, user);

      expect(await rows("cct_users")).toHaveLength(1);
      expect(await rows("cct_avatars")).toEqual([expect.objectContaining({ url: "a.png", owner_id: saved.id })]);
    });

    it("saves OneToMany children that point back at the parent once, with its key", async () => {
      const owner: any = { name: "carol", posts: [{ title: "p1" }, { title: "p2" }] };
      for (const post of owner.posts) post.user = owner;
      const saved = await em.save(CctUser, owner);

      expect(await rows("cct_users")).toHaveLength(1);
      expect((await rows("cct_posts")).map((p: any) => [p.title, p.user_id])).toEqual([
        ["p1", saved.id],
        ["p2", saved.id],
      ]);
    });

    it("saves a child whose parent points at it, through the child", async () => {
      const post: any = { title: "solo", user: { name: "dave" } };
      post.user.posts = [post];
      const saved = await em.save(CctPost, post);

      const users = await rows("cct_users");
      expect(users).toHaveLength(1);
      expect(await rows("cct_posts")).toEqual([expect.objectContaining({ id: saved.id, user_id: users[0].id })]);
    });
  });

  describe("hard delete of a soft-deleted parent", () => {
    it("removes the cascaded rows on both OneToOne sides and the OneToMany children", async () => {
      const user = await em.save(CctUser, {
        name: "erin",
        profile: { bio: "x" },
        avatar: { url: "e.png" },
        posts: [{ title: "e1" }],
      } as any);
      await em.softDelete(CctUser, { id: user.id });
      // None of the cascaded entities is soft-deletable, so the soft delete
      // left them in place.
      expect(await rows("cct_profiles")).toHaveLength(1);

      await em.delete(CctUser, { id: user.id });

      expect(await rows("cct_users")).toEqual([]);
      expect(await rows("cct_profiles")).toEqual([]);
      expect(await rows("cct_avatars")).toEqual([]);
      expect(await rows("cct_posts")).toEqual([]);
    });

    it("deleteMany does the same for a mix of live and trashed parents", async () => {
      const live = await em.save(CctUser, { name: "live", profile: { bio: "l" } } as any);
      const trashed = await em.save(CctUser, { name: "trashed", profile: { bio: "t" } } as any);
      await em.softDelete(CctUser, { id: trashed.id });

      await em.deleteMany(CctUser, [live.id, trashed.id]);

      expect(await rows("cct_users")).toEqual([]);
      expect(await rows("cct_profiles")).toEqual([]);
    });
  });
});
