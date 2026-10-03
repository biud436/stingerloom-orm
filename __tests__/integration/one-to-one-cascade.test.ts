/**
 * `@OneToOne` cascade on a real PostgreSQL / MySQL (MariaDB), where the
 * foreign keys are enforced: the owning side's target must be inserted
 * before the row that references it and deleted after it, the inverse
 * side's counterpart the other way round.
 *
 * SQLite: __tests__/integration/sqlite/one-to-one-cascade.test.ts
 */
import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import {
  createTestConnection,
  dropTestTable,
  rawQuery,
  type TestConnectionResult,
} from "./helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";
import { disableFkChecksSql, enableFkChecksSql } from "./helpers/driver-helpers";
import { Entity, Column, PrimaryGeneratedColumn, OneToOne, RelationColumn, DeletedAt } from "../../src";

function shortName(prefix: string): string {
  return `${prefix}_${String(Date.now()).slice(-7)}`;
}

describe.each(getTestDrivers())(
  "[Integration] $label: @OneToOne cascade",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let E: Record<string, new () => any>;
    const t = {
      profile: shortName("ocpr"),
      avatar: shortName("ocav"),
      user: shortName("ocus"),
    };

    beforeAll(async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          @Entity({ name: t.profile })
          class Profile {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) bio!: string;
            @DeletedAt() deletedAt!: Date | null;
          }

          @Entity({ name: t.avatar })
          class Avatar {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) url!: string;
            @OneToOne(() => User)
            @RelationColumn({ name: "owner_id", nullable: true })
            owner!: any;
            @DeletedAt() deletedAt!: Date | null;
          }

          @Entity({ name: t.user })
          class User {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) name!: string;
            @OneToOne(() => Profile, { cascade: true })
            @RelationColumn({ name: "profile_id", nullable: true })
            profile!: any;
            @OneToOne(() => Avatar, { inverseSide: "owner", cascade: true }) avatar!: any;
            @DeletedAt() deletedAt!: Date | null;
          }

          E = { Profile, Avatar, User };
          return { entities: [Profile, User, Avatar] };
        },
      );
      em = conn.em;
    }, 60000);

    afterAll(async () => {
      try {
        await rawQuery(disableFkChecksSql(type));
        for (const name of [t.avatar, t.user, t.profile]) await dropTestTable(name);
        await rawQuery(enableFkChecksSql(type));
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 30000);

    const read = (id: number) =>
      em.findOne(E.User, { where: { id }, relations: ["profile", "avatar"], withDeleted: true });

    it("saves both sides with their keys, in foreign-key order", async () => {
      const user = await em.save(E.User, { name: "alice", profile: { bio: "hi" }, avatar: { url: "a.png" } });
      const stored = await read(user.id);
      expect(stored.profile.bio).toBe("hi");
      expect(stored.profileId).toBe(stored.profile.id);
      expect(stored.avatar.url).toBe("a.png");
      expect(stored.avatar.ownerId).toBe(user.id);
    });

    it("delete removes the inverse counterpart before and the owning target after the parent", async () => {
      const user = await em.save(E.User, { name: "bob", profile: { bio: "bob-p" }, avatar: { url: "bob-a" } });
      const stored = await read(user.id);
      await em.delete(E.User, { id: user.id });
      expect(await em.findOne(E.Profile, { where: { id: stored.profile.id }, withDeleted: true })).toBeNull();
      expect(await em.findOne(E.Avatar, { where: { id: stored.avatar.id }, withDeleted: true })).toBeNull();
    });

    it("softDelete and restore follow both sides", async () => {
      const user = await em.save(E.User, { name: "carol", profile: { bio: "c-p" }, avatar: { url: "c-a" } });
      const stored = await read(user.id);
      await em.softDelete(E.User, { id: user.id });
      expect(await em.findOne(E.Profile, { where: { id: stored.profile.id } })).toBeNull();
      expect(await em.findOne(E.Avatar, { where: { id: stored.avatar.id } })).toBeNull();
      await em.restore(E.User, { id: user.id });
      const back = await read(user.id);
      expect([back.profile.deletedAt, back.avatar.deletedAt]).toEqual([null, null]);
    });
  },
);
