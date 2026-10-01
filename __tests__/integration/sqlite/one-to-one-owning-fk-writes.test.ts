/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Every write path stores the foreign key of an owning `@OneToOne`, the way
 * it stores a `@ManyToOne`'s.
 *
 * The writers resolved keys from `@ManyToOne` metadata alone, so the owning
 * side of a `@OneToOne` had no writer: the DDL created its join column, and
 * save(), saveMany(), insertMany(), insertManyAndReturn() and the upsert
 * family stored NULL there — given a related instance, a bare key or the
 * `${property}Id` shadow, with no error or warning. Only updateMany() wrote
 * it. Each case below runs against the three ways of declaring the join
 * column: `@RelationColumn`, the deprecated `joinColumn` option, and a
 * `${property}Id` `@Column`.
 *
 * save()'s UPDATE also dropped a bare key for a `@ManyToOne`
 * (`{ id, author: 2 }` kept the old parent) while its INSERT honoured it.
 */
import "reflect-metadata";
import {
  Column,
  Entity,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
  RelationColumn,
  UniqueIndex,
} from "../../../src";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";

@Entity({ name: "o2ofk_profile" })
class O2oFkProfile {
  @PrimaryGeneratedColumn() id!: number;
  @Column() bio!: string;
}

@Entity({ name: "o2ofk_by_relation_column" })
@UniqueIndex(["name"])
class ByRelationColumn {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;

  @OneToOne(() => O2oFkProfile)
  @RelationColumn({ name: "profile_id" })
  profile!: O2oFkProfile | null;
}

@Entity({ name: "o2ofk_by_join_column" })
@UniqueIndex(["name"])
class ByJoinColumnOption {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;

  @OneToOne(() => O2oFkProfile, { joinColumn: "profile_id" })
  profile!: O2oFkProfile | null;
}

@Entity({ name: "o2ofk_by_column" })
@UniqueIndex(["name"])
class ByDeclaredColumn {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;

  @Column({ name: "profile_fk", type: "int", nullable: true })
  profileId!: number | null;

  @OneToOne(() => O2oFkProfile)
  profile!: O2oFkProfile | null;
}

@Entity({ name: "o2ofk_book" })
class O2oFkBook {
  @PrimaryGeneratedColumn() id!: number;
  @Column() title!: string;

  @ManyToOne(() => O2oFkProfile, () => undefined)
  @RelationColumn({ name: "author_id" })
  author!: O2oFkProfile | null;
}

@Entity({ name: "o2ofk_note" })
class O2oFkNote {
  @PrimaryGeneratedColumn() id!: number;
  @Column() title!: string;

  @Column({ name: "author_fk", type: "int", nullable: true })
  authorId!: number | null;

  @ManyToOne(() => O2oFkProfile, () => undefined)
  author!: O2oFkProfile | null;
}

const OWNERS = [
  { label: "@RelationColumn", entity: ByRelationColumn, table: "o2ofk_by_relation_column", fk: "profile_id" },
  { label: "joinColumn option", entity: ByJoinColumnOption, table: "o2ofk_by_join_column", fk: "profile_id" },
  { label: "${property}Id @Column", entity: ByDeclaredColumn, table: "o2ofk_by_column", fk: "profile_fk" },
] as const;

describe("[Integration] SQLite: owning @OneToOne foreign keys are written", () => {
  let em: EntityManager;
  let first: O2oFkProfile;
  let second: O2oFkProfile;

  beforeAll(async () => {
    em = await createTestEntityManager({
      entities: [
        O2oFkProfile,
        ByRelationColumn,
        ByJoinColumnOption,
        ByDeclaredColumn,
        O2oFkBook,
        O2oFkNote,
      ],
    });
  });

  afterAll(async () => {
    await (em as unknown as { destroy?: () => Promise<void> }).destroy?.();
  });

  beforeEach(async () => {
    for (const { table } of OWNERS) await em.query(`DELETE FROM ${table}`);
    await em.query("DELETE FROM o2ofk_book");
    await em.query("DELETE FROM o2ofk_note");
    await em.query("DELETE FROM o2ofk_profile");
    first = await em.save(O2oFkProfile, { bio: "first" });
    second = await em.save(O2oFkProfile, { bio: "second" });
  });

  describe.each(OWNERS)("join column declared with $label", ({ entity, table, fk }) => {
    const E = entity;
    // The payload shapes differ per entity, so calls go through an untyped
    // view: inferring T from each literal would reject the shadow forms.
    const db = (): any => em;

    async function keys(): Promise<Array<{ name: string; fk: number | null }>> {
      return (await em.query(
        `SELECT name, ${fk} AS fk FROM ${table} ORDER BY id`,
      )) as unknown as Array<{ name: string; fk: number | null }>;
    }

    describe("save() INSERT", () => {
      it("writes the key of a related instance", async () => {
        await db().save(E, { name: "a", profile: first });

        expect(await keys()).toEqual([{ name: "a", fk: first.id }]);
      });

      it("writes a bare key", async () => {
        await db().save(E, { name: "a", profile: first.id });

        expect(await keys()).toEqual([{ name: "a", fk: first.id }]);
      });

      it("writes the ${property}Id shadow", async () => {
        await db().save(E, { name: "a", profileId: first.id });

        expect(await keys()).toEqual([{ name: "a", fk: first.id }]);
      });
    });

    describe("save() UPDATE", () => {
      let id: number;

      beforeEach(async () => {
        ({ id } = await db().save(E, { name: "a", profile: first }));
      });

      it("reassigns to a related instance", async () => {
        await db().save(E, { id, profile: second });

        expect(await keys()).toEqual([{ name: "a", fk: second.id }]);
      });

      it("reassigns to a bare key", async () => {
        await db().save(E, { id, profile: second.id });

        expect(await keys()).toEqual([{ name: "a", fk: second.id }]);
      });

      it("reassigns through the ${property}Id shadow", async () => {
        await db().save(E, { id, profileId: second.id });

        expect(await keys()).toEqual([{ name: "a", fk: second.id }]);
      });

      it("clears the key for a relation stated as null", async () => {
        await db().save(E, { id, profile: null });

        expect(await keys()).toEqual([{ name: "a", fk: null }]);
      });

      it("clears the key for a shadow stated as null", async () => {
        await db().save(E, { id, profileId: null });

        expect(await keys()).toEqual([{ name: "a", fk: null }]);
      });

      it("keeps the stored key when the payload leaves the relation out", async () => {
        await db().save(E, { id, name: "b" });

        expect(await keys()).toEqual([{ name: "b", fk: first.id }]);
      });
    });

    it("insertMany() writes each row's key", async () => {
      await db().insertMany(E, [
        { name: "a", profile: first },
        { name: "b", profile: second.id },
        { name: "c", profileId: first.id },
        { name: "d" },
      ]);

      expect(await keys()).toEqual([
        { name: "a", fk: first.id },
        { name: "b", fk: second.id },
        { name: "c", fk: first.id },
        { name: "d", fk: null },
      ]);
    });

    it("insertManyAndReturn() writes each row's key", async () => {
      await db().insertManyAndReturn(E, [
        { name: "a", profile: second },
        { name: "b", profileId: first.id },
      ]);

      expect(await keys()).toEqual([
        { name: "a", fk: second.id },
        { name: "b", fk: first.id },
      ]);
    });

    it("saveMany() writes each new row's key", async () => {
      await db().saveMany(E, [
        { name: "a", profile: second },
        { name: "b", profileId: first.id },
      ]);

      expect(await keys()).toEqual([
        { name: "a", fk: second.id },
        { name: "b", fk: first.id },
      ]);
    });

    it("upsert() writes the key and reassigns it on conflict", async () => {
      await db().upsert(E, { name: "a", profile: first }, ["name"]);
      expect(await keys()).toEqual([{ name: "a", fk: first.id }]);

      await db().upsert(E, { name: "a", profile: second }, ["name"]);
      expect(await keys()).toEqual([{ name: "a", fk: second.id }]);
    });

    it("batchUpsert() writes each row's key", async () => {
      await db().batchUpsert(
        E,
        [
          { name: "a", profile: first },
          { name: "b", profile: second.id },
        ],
        ["name"],
      );

      expect(await keys()).toEqual([
        { name: "a", fk: first.id },
        { name: "b", fk: second.id },
      ]);
    });

    it("insertIgnore() writes the key", async () => {
      await db().insertIgnore(E, { name: "a", profile: second }, ["name"]);

      expect(await keys()).toEqual([{ name: "a", fk: second.id }]);
    });
  });

  describe("@ManyToOne", () => {
    async function bookKeys(): Promise<unknown[]> {
      return (await em.query(
        "SELECT title, author_id FROM o2ofk_book ORDER BY id",
      )) as unknown as unknown[];
    }

    it("save() UPDATE reassigns to a bare key", async () => {
      const { id } = await em.save(O2oFkBook, { title: "t", author: first });

      await em.save(O2oFkBook, { id, author: second.id } as any);

      expect(await bookKeys()).toEqual([{ title: "t", author_id: second.id }]);
    });

    it("a batch mixing relation and declared-column rows writes both keys", async () => {
      const rows = [
        { title: "a", author: first },
        { title: "b", authorId: second.id },
      ];
      await em.insertMany(O2oFkNote, rows as any);
      await em.saveMany(O2oFkNote, rows.map((row) => ({ ...row })) as any);

      expect(
        await em.query("SELECT title, author_fk FROM o2ofk_note ORDER BY id"),
      ).toEqual([
        { title: "a", author_fk: first.id },
        { title: "b", author_fk: second.id },
        { title: "a", author_fk: first.id },
        { title: "b", author_fk: second.id },
      ]);
    });
  });
});
