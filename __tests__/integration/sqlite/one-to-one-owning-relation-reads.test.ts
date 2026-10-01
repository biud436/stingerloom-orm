/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * find() hydrates the owner side of a `@OneToOne` however its join column is
 * declared.
 *
 * The read JOINed the related table for an owning `@OneToOne` declared with
 * `@RelationColumn` or a `${property}Id` `@Column`, but the result hydrator
 * looked only at the decorator's deprecated `joinColumn` option, took those
 * relations for the inverse side and never built them: `relations: ["profile"]`
 * and `eager: true` left `user.profile` undefined. A JOINED child read with an
 * eager `@OneToOne` (and no eager `@ManyToOne`) returned the joined columns as
 * raw `<relation>_<column>` keys instead.
 */
import "reflect-metadata";
import {
  Column,
  DiscriminatorColumn,
  DiscriminatorValue,
  Entity,
  Inheritance,
  OneToOne,
  PrimaryGeneratedColumn,
  RelationColumn,
} from "../../../src";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";

@Entity({ name: "o2or_profile" })
class O2oRProfile {
  @PrimaryGeneratedColumn() id!: number;
  @Column() bio!: string;

  @OneToOne(() => O2oRUser, { inverseSide: "profile" })
  user!: O2oRUser | null;
}

@Entity({ name: "o2or_user" })
class O2oRUser {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;

  @OneToOne(() => O2oRProfile, { inverseSide: "user" })
  @RelationColumn({ name: "profile_id" })
  profile!: O2oRProfile | null;
}

@Entity({ name: "o2or_by_join_column" })
class ByJoinColumnOption {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;

  @OneToOne(() => O2oRProfile, { joinColumn: "profile_id" })
  profile!: O2oRProfile | null;
}

@Entity({ name: "o2or_by_column" })
class ByDeclaredColumn {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;

  @Column({ name: "profile_fk", type: "int", nullable: true })
  profileId!: number | null;

  @OneToOne(() => O2oRProfile)
  profile!: O2oRProfile | null;
}

@Entity({ name: "o2or_eager" })
class EagerOwner {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;

  @OneToOne(() => O2oRProfile, { eager: true })
  @RelationColumn({ name: "profile_id" })
  profile!: O2oRProfile | null;
}

@Entity({ name: "o2or_doc" })
@Inheritance({ strategy: "JOINED" })
@DiscriminatorColumn({ name: "dtype" })
class O2oRDoc {
  @PrimaryGeneratedColumn() id!: number;
  @Column() title!: string;

  @OneToOne(() => O2oRProfile)
  @RelationColumn({ name: "cover_id" })
  cover!: O2oRProfile | null;
}

@Entity({ name: "o2or_memo" })
@DiscriminatorValue("memo")
class O2oRMemo extends O2oRDoc {
  @Column() body!: string;

  @OneToOne(() => O2oRProfile)
  @RelationColumn({ name: "stamp_id" })
  stamp!: O2oRProfile | null;
}

describe("[Integration] SQLite: owning @OneToOne relations are hydrated", () => {
  let em: EntityManager;
  let first: O2oRProfile;
  let second: O2oRProfile;

  beforeAll(async () => {
    em = await createTestEntityManager({
      entities: [
        O2oRProfile,
        O2oRUser,
        ByJoinColumnOption,
        ByDeclaredColumn,
        EagerOwner,
        O2oRDoc,
        O2oRMemo,
      ],
    });
  });

  afterAll(async () => {
    await (em as unknown as { destroy?: () => Promise<void> }).destroy?.();
  });

  beforeEach(async () => {
    for (const table of [
      "o2or_user",
      "o2or_by_join_column",
      "o2or_by_column",
      "o2or_eager",
      "o2or_memo",
      "o2or_doc",
      "o2or_profile",
    ]) {
      await em.query(`DELETE FROM ${table}`);
    }
    first = await em.save(O2oRProfile, { bio: "first" });
    second = await em.save(O2oRProfile, { bio: "second" });
  });

  function expectProfile(value: unknown, profile: O2oRProfile): void {
    expect(value).toBeInstanceOf(O2oRProfile);
    expect(value).toMatchObject({ id: profile.id, bio: profile.bio });
  }

  describe.each([
    { label: "@RelationColumn", entity: O2oRUser },
    { label: "joinColumn option", entity: ByJoinColumnOption },
    { label: "${property}Id @Column", entity: ByDeclaredColumn },
  ])("join column declared with $label", ({ entity }) => {
    const db = (): any => em;

    it("findOne() with relations builds the related instance", async () => {
      const { id } = await db().save(entity, { name: "a", profile: second });

      const found = await db().findOne(entity, {
        where: { id },
        relations: ["profile"],
      });

      expectProfile(found.profile, second);
    });

    it("find() with relations builds it for every row and null for none", async () => {
      await db().save(entity, { name: "a", profile: first });
      await db().save(entity, { name: "b" });

      const rows = await db().find(entity, {
        relations: ["profile"],
        orderBy: { id: "ASC" },
      });

      expectProfile(rows[0].profile, first);
      expect(rows[1].profile).toBeNull();
    });
  });

  it("the ${property}Id shadow is set next to the loaded relation", async () => {
    const { id } = await em.save(O2oRUser, { name: "a", profile: second });

    const found = (await em.findOne(O2oRUser, {
      where: { id },
      relations: ["profile"],
    })) as any;

    expect(found.profileId).toBe(second.id);
    expectProfile(found.profile, second);
  });

  it("an eager relation is loaded without being named", async () => {
    await em.save(EagerOwner, { name: "a", profile: first });
    await em.save(EagerOwner, { name: "b" });

    const rows = await em.find(EagerOwner, { orderBy: { id: "ASC" } });

    expectProfile(rows[0].profile, first);
    expect(rows[1].profile).toBeNull();
  });

  it("the inverse side loads the owner a save() linked", async () => {
    const user = await em.save(O2oRUser, { name: "a", profile: first });

    const profile = await em.findOne(O2oRProfile, {
      where: { id: first.id },
      relations: ["user"],
    });

    expect(profile?.user).toBeInstanceOf(O2oRUser);
    expect(profile?.user).toMatchObject({ id: user.id, name: "a" });
  });

  describe("JOINED hierarchy", () => {
    it("a child read builds both the inherited and its own relation", async () => {
      const { id } = await em.save(O2oRMemo, {
        title: "t",
        body: "b",
        cover: first,
        stamp: second,
      });

      const memo = (await em.findOne(O2oRMemo, {
        where: { id },
        relations: ["cover", "stamp"],
      })) as any;

      expectProfile(memo.cover, first);
      expectProfile(memo.stamp, second);
      expect(memo).not.toHaveProperty("cover_bio");
      expect(memo).not.toHaveProperty("stamp_bio");
    });

    it("a root read builds the subclass with the relation", async () => {
      await em.save(O2oRMemo, { title: "t", body: "b", cover: second });

      const [doc] = await em.find(O2oRDoc, { relations: ["cover"] });

      expect(doc).toBeInstanceOf(O2oRMemo);
      expectProfile(doc.cover, second);
    });
  });
});
