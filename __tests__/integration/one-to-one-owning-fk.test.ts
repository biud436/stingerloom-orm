/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The owner side of a `@OneToOne` is written and read back against real
 * servers (MySQL/MariaDB + PostgreSQL), and a JOINed relation keeps the
 * entity's own foreign key when the JOIN finds no row.
 *
 * Mirrors __tests__/integration/sqlite/one-to-one-owning-fk-writes.test.ts,
 * one-to-one-owning-relation-reads.test.ts and
 * joined-relation-column-alias.test.ts. The dialect-specific parts are the
 * write statements (RETURNING vs insertId, ON CONFLICT vs ON DUPLICATE KEY
 * UPDATE) and how each driver builds a row object from the JOINed columns.
 *
 * Runs only under INTEGRATION_TEST=true; individual drivers can be disabled
 * with INTEGRATION_TEST_MYSQL=false / INTEGRATION_TEST_POSTGRES=false.
 */
import "reflect-metadata";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../src/decorators/ManyToOne";
import { OneToOne } from "../../src/decorators/OneToOne";
import { RelationColumn } from "../../src/decorators/RelationColumn";
import { UniqueIndex } from "../../src/decorators/UniqueIndex";
import { DeletedAt } from "../../src/decorators/DeletedAt";
import { EntityManager } from "../../src/core/EntityManager";
import {
  createTestConnection,
  rawQuery,
  dropTestTable,
  TestConnectionResult,
} from "./helpers/test-connection";
import {
  getTestDrivers,
  type TestDriverConfig,
} from "./helpers/driver-config";

const INTEGRATION = process.env.INTEGRATION_TEST === "true";
const drivers = INTEGRATION ? getTestDrivers() : [];

const TABLES = {
  profile: "o2o_d_profile",
  user: "o2o_d_user",
  book: "o2o_d_book",
} as const;
/** Children before parents, so the foreign keys never block a DELETE / DROP. */
const TEARDOWN_ORDER = [TABLES.user, TABLES.book, TABLES.profile];

describe.each(drivers)(
  "[Integration][$label] owning @OneToOne keys and JOINed relation columns",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: any;
    let ProfileE: new () => any;
    let UserE: new () => any;
    let BookE: new () => any;
    let first: { id: number };
    let second: { id: number };

    const q = (name: string) => (type === "mysql" ? `\`${name}\`` : `"${name}"`);

    beforeAll(async () => {
      conn = await createTestConnection(
        { ...options, synchronize: true, logging: false },
        () => {
          @Entity({ name: TABLES.profile })
          class Profile {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 32 }) bio!: string;
            @DeletedAt() deletedAt!: Date | null;

            @OneToOne(() => User, { inverseSide: "profile" })
            user!: any;
          }

          @Entity({ name: TABLES.user })
          @UniqueIndex(["name"])
          class User {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 32 }) name!: string;

            @OneToOne(() => Profile, { eager: true, inverseSide: "user" })
            @RelationColumn({ name: "profile_id" })
            profile!: Profile | null;
          }

          @Entity({ name: TABLES.book })
          class Book {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 32 }) title!: string;

            @ManyToOne(() => Profile, () => undefined)
            @RelationColumn({ name: "author_id" })
            author!: Profile | null;
          }

          ProfileE = Profile;
          UserE = User;
          BookE = Book;
          return { entities: [Profile, User, Book] };
        },
      );
      em = conn.em as EntityManager;
    }, 60000);

    afterAll(async () => {
      for (const t of TEARDOWN_ORDER) {
        try {
          await dropTestTable(t);
        } catch {
          /* ignore */
        }
      }
      await conn.cleanup();
    });

    beforeEach(async () => {
      for (const t of TEARDOWN_ORDER) {
        await rawQuery(`DELETE FROM ${q(t)}`);
      }
      first = await em.save(ProfileE, { bio: "first" });
      second = await em.save(ProfileE, { bio: "second" });
    });

    async function userKeys(): Promise<Array<{ name: string; fk: number | null }>> {
      const result = (await em.query(
        `SELECT ${q("name")}, ${q("profile_id")} FROM ${q(TABLES.user)} ORDER BY ${q("id")}`,
      )) as any[];
      return result.map((row) => ({
        name: row.name,
        fk: row.profile_id === null ? null : Number(row.profile_id),
      }));
    }

    it("save() writes, reassigns and clears the key", async () => {
      const { id } = await em.save(UserE, { name: "a", profile: first });
      expect(await userKeys()).toEqual([{ name: "a", fk: first.id }]);

      await em.save(UserE, { id, profile: second.id });
      expect(await userKeys()).toEqual([{ name: "a", fk: second.id }]);

      await em.save(UserE, { id, profileId: first.id });
      expect(await userKeys()).toEqual([{ name: "a", fk: first.id }]);

      await em.save(UserE, { id, profile: null });
      expect(await userKeys()).toEqual([{ name: "a", fk: null }]);
    });

    it("the batch inserts write each row's key", async () => {
      await em.insertMany(UserE, [
        { name: "a", profile: first },
        { name: "b", profileId: second.id },
      ]);
      await em.saveMany(UserE, [{ name: "c", profile: second.id }]);

      expect(await userKeys()).toEqual([
        { name: "a", fk: first.id },
        { name: "b", fk: second.id },
        { name: "c", fk: second.id },
      ]);
    });

    it("the upsert family writes the key and reassigns it on conflict", async () => {
      await em.upsert(UserE, { name: "a", profile: first }, ["name"]);
      await em.upsert(UserE, { name: "a", profile: second }, ["name"]);
      await em.batchUpsert(UserE, [{ name: "b", profile: first }], ["name"]);

      expect(await userKeys()).toEqual([
        { name: "a", fk: second.id },
        { name: "b", fk: first.id },
      ]);
    });

    it("an eager read builds the relation and keeps the shadow key", async () => {
      const { id } = await em.save(UserE, { name: "a", profile: second });

      const user = await em.findOne(UserE, { where: { id } });

      expect(user.profile).toBeInstanceOf(ProfileE);
      expect(user.profile).toMatchObject({ id: second.id, bio: "second" });
      expect(Number(user.profileId)).toBe(second.id);
    });

    it("the inverse side loads the owner a save() linked", async () => {
      const user = await em.save(UserE, { name: "a", profile: first });

      const profile = await em.findOne(ProfileE, {
        where: { id: first.id },
        relations: ["user"],
      });

      expect(profile.user).toBeInstanceOf(UserE);
      expect(profile.user).toMatchObject({ id: user.id, name: "a" });
    });

    describe("a JOIN that finds no row keeps the stored key", () => {
      it("eager @OneToOne", async () => {
        const { id } = await em.save(UserE, { name: "a", profile: first });
        await em.softDelete(ProfileE, { id: first.id });

        const user = await em.findOne(UserE, { where: { id } });

        expect(user.profile).toBeNull();
        expect(Number(user.profileId)).toBe(first.id);
      });

      it("@ManyToOne", async () => {
        const { id } = await em.save(BookE, { title: "t", author: second });
        await em.softDelete(ProfileE, { id: second.id });

        const book = await em.findOne(BookE, { where: { id }, relations: ["author"] });

        expect(book.author).toBeNull();
        expect(Number(book.authorId)).toBe(second.id);
      });
    });
  },
);
