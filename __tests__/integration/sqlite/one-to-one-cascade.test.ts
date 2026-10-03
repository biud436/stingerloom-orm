/**
 * `cascade` on `@OneToOne`, both sides, through every write path that
 * cascades.
 *
 * Before: CascadeHandler only read ManyToOne and OneToMany metadata, so a
 * OneToOne's `cascade` did nothing. `save(User, { profile: { bio } })` left
 * no profile row and a NULL join column, the inverse side's counterpart was
 * dropped the same way, and `delete()` removed the parent alone — no error
 * anywhere (probe on fefabec: profiles [], avatars [] after the save).
 *
 * - Owning side (`User.profile`, join column on the user): the target is
 *   saved first and its key written to the join column; on `delete()` it is
 *   removed right after the user rows, which reference it.
 * - Inverse side (`User.avatar`, join column on the avatar): the counterpart
 *   gets the user's key and is saved after the user; it is removed before
 *   the user, like a OneToMany child.
 * - `softDelete()` / `restore()` follow both sides for a soft-deletable
 *   target; `cascade: ["insert"]` keeps the target on delete.
 *
 * PG / MariaDB: __tests__/integration/one-to-one-cascade.test.ts
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { OneToOne } from "../../../src/decorators/OneToOne";
import { RelationColumn } from "../../../src/decorators/RelationColumn";
import { DeletedAt } from "../../../src/decorators/DeletedAt";
import { Relation } from "../../../src/types/Relation";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";

@Entity({ name: "ooc_profiles" })
class OocProfile {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) bio!: string;
  @DeletedAt() deletedAt!: Date | null;
}

@Entity({ name: "ooc_avatars" })
class OocAvatar {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) url!: string;
  @OneToOne(() => OocUser)
  @RelationColumn({ name: "owner_id", nullable: true })
  owner!: Relation<OocUser> | null;
  @DeletedAt() deletedAt!: Date | null;
}

@Entity({ name: "ooc_badges" })
class OocBadge {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) label!: string;
}

@Entity({ name: "ooc_users" })
class OocUser {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) name!: string;

  @OneToOne(() => OocProfile, { cascade: true })
  @RelationColumn({ name: "profile_id", nullable: true })
  profile!: Relation<OocProfile> | null;

  @OneToOne(() => OocAvatar, { inverseSide: "owner", cascade: true })
  avatar!: Relation<OocAvatar> | null;

  // Insert-only: saved with the user, kept when the user goes.
  @OneToOne(() => OocBadge, { cascade: ["insert"] })
  @RelationColumn({ name: "badge_id", nullable: true })
  badge!: Relation<OocBadge> | null;

  @DeletedAt() deletedAt!: Date | null;
}

describe("[Integration] SQLite: @OneToOne cascade", () => {
  let em: EntityManager;

  beforeAll(async () => {
    em = await createTestEntityManager({ entities: [OocProfile, OocAvatar, OocBadge, OocUser] });
  });

  afterAll(async () => {
    await em.propagateShutdown();
  });

  beforeEach(async () => {
    for (const table of ["ooc_avatars", "ooc_users", "ooc_profiles", "ooc_badges"]) {
      await em.query(`DELETE FROM ${table}`);
    }
  });

  const read = (id: number) =>
    em.findOne(OocUser, { where: { id }, relations: ["profile", "avatar", "badge"], withDeleted: true });

  describe("save", () => {
    it("inserts the owning side's target first and writes its key", async () => {
      const user = await em.save(OocUser, { name: "alice", profile: { bio: "hi" } } as any);
      const stored = await read(user.id);
      expect(stored!.profile?.bio).toBe("hi");
      expect((stored as any).profileId).toBe(stored!.profile!.id);
    });

    it("inserts the inverse side's counterpart with the parent's key", async () => {
      const user = await em.save(OocUser, { name: "alice", avatar: { url: "a.png" } } as any);
      const [avatar] = await em.find(OocAvatar, {});
      expect(avatar.url).toBe("a.png");
      expect((avatar as any).ownerId).toBe(user.id);
      expect((await read(user.id))!.avatar?.url).toBe("a.png");
    });

    it("updates both sides when the parent is saved again", async () => {
      const user = await em.save(OocUser, {
        name: "alice",
        profile: { bio: "hi" },
        avatar: { url: "a.png" },
      } as any);
      const stored = (await read(user.id))!;
      await em.save(OocUser, {
        id: user.id,
        name: "alice",
        profile: { id: stored.profile!.id, bio: "edited" },
        avatar: { id: stored.avatar!.id, url: "b.png" },
      } as any);
      const after = (await read(user.id))!;
      expect([after.profile?.bio, after.avatar?.url]).toEqual(["edited", "b.png"]);
      expect(await em.count(OocProfile)).toBe(1);
      expect(await em.count(OocAvatar)).toBe(1);
    });

    it("cascades through saveMany", async () => {
      const users = await em.saveMany(OocUser, [
        { name: "a", profile: { bio: "pa" }, avatar: { url: "aa" } },
        { name: "b", profile: { bio: "pb" }, avatar: { url: "ab" } },
      ] as any);
      for (const [user, bio, url] of [
        [users[0], "pa", "aa"],
        [users[1], "pb", "ab"],
      ] as const) {
        const stored = (await read(user.id))!;
        expect([stored.profile?.bio, stored.avatar?.url]).toEqual([bio, url]);
      }
    });

    it("rolls the parent back when a cascaded save fails", async () => {
      await expect(
        em.save(OocUser, { name: "alice", avatar: { url: null } } as any),
      ).rejects.toThrow();
      expect(await em.count(OocUser)).toBe(0);
    });
  });

  describe("removal", () => {
    async function seed(name: string) {
      const user = await em.save(OocUser, {
        name,
        profile: { bio: `${name}-p` },
        avatar: { url: `${name}-a` },
        badge: { label: `${name}-b` },
      } as any);
      return user.id;
    }

    it("delete removes both sides' targets, not the insert-only one", async () => {
      const id = await seed("alice");
      const keep = await seed("bob");
      await em.delete(OocUser, { id });
      expect((await em.find(OocProfile, { withDeleted: true })).map((p) => p.bio)).toEqual(["bob-p"]);
      expect((await em.find(OocAvatar, { withDeleted: true })).map((a) => a.url)).toEqual(["bob-a"]);
      expect((await em.find(OocBadge, {})).map((b) => b.label).sort()).toEqual(["alice-b", "bob-b"]);
      expect((await read(keep))!.profile?.bio).toBe("bob-p");
    });

    it("deleteMany removes them for every deleted row", async () => {
      const ids = [await seed("a"), await seed("b")];
      await em.deleteMany(OocUser, ids);
      expect(await em.count(OocProfile, undefined, true)).toBe(0);
      expect(await em.count(OocAvatar, undefined, true)).toBe(0);
    });

    it("softDelete trashes both sides, restore revives them", async () => {
      const id = await seed("alice");
      await em.softDelete(OocUser, { id });
      expect(await em.find(OocProfile, {})).toEqual([]);
      expect(await em.find(OocAvatar, {})).toEqual([]);

      await em.restore(OocUser, { id });
      const stored = (await read(id))!;
      expect([stored.profile?.bio, stored.avatar?.url]).toEqual(["alice-p", "alice-a"]);
      expect(stored.profile?.deletedAt).toBeNull();
      expect(stored.avatar?.deletedAt).toBeNull();
    });

    it("restore leaves the targets of a parent that was not trashed alone", async () => {
      const id = await seed("alice");
      const [profile] = await em.find(OocProfile, {});
      await em.softDelete(OocProfile, { id: profile.id });
      await em.restore(OocUser, { id });
      expect(await em.find(OocProfile, {})).toEqual([]);
    });
  });
});
