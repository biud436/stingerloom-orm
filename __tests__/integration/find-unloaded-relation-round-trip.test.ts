/**
 * A to-one relation a read did not load is left off the entity on a real
 * PostgreSQL / MySQL (MariaDB), so saving the entity back keeps its foreign
 * key instead of clearing it.
 *
 * SQLite: __tests__/integration/sqlite/find-unloaded-relation-round-trip.test.ts
 */

import "reflect-metadata";
import { createTestConnection, dropTestTable, rawQuery, type TestConnectionResult } from "./helpers/test-connection";
import { getTestDrivers, type TestDriverConfig } from "./helpers/driver-config";
import { disableFkChecksSql, enableFkChecksSql } from "./helpers/driver-helpers";
import { Entity, Column, PrimaryGeneratedColumn, ManyToOne, OneToOne, RelationColumn } from "../../src";

describe.each(getTestDrivers())(
  "[Integration] $label: to-one relations a read did not load",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    const E: Record<string, new () => any> = {};
    const suffix = String(Date.now()).slice(-6);

    beforeAll(async () => {
      conn = await createTestConnection(
        { ...options, synchronize: true, logging: false },
        () => {
          @Entity({ name: `furt_team_${suffix}` })
          class RtTeam {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 20 }) name!: string;
          }
          @Entity({ name: `furt_badge_${suffix}` })
          class RtBadge {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 20 }) code!: string;
          }
          @Entity({ name: `furt_user_${suffix}` })
          class RtUser {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 20 }) name!: string;
            @ManyToOne(() => RtTeam, (t: any) => t.id)
            @RelationColumn({ name: "team_id" })
            team!: any;
          }
          @Entity({ name: `furt_post_${suffix}` })
          class RtPost {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 20 }) title!: string;
            @ManyToOne(() => RtUser, (u: any) => u.id)
            @RelationColumn({ name: "author_id" })
            author!: any;
            @ManyToOne(() => RtUser, (u: any) => u.id)
            @RelationColumn({ name: "editor_id" })
            editor!: any;
            @OneToOne(() => RtBadge)
            @RelationColumn({ name: "badge_id" })
            badge!: any;
          }
          Object.assign(E, { RtTeam, RtBadge, RtUser, RtPost });
          return { entities: [RtTeam, RtBadge, RtUser, RtPost] };
        },
      );
    }, 60000);

    afterAll(async () => {
      try {
        await rawQuery(disableFkChecksSql(type));
        for (const name of ["post", "user", "badge", "team"]) await dropTestTable(`furt_${name}_${suffix}`);
        await rawQuery(enableFkChecksSql(type));
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 30000);

    async function seed() {
      const em = conn.em;
      const team = await em.save(E.RtTeam, { name: "core" });
      const alice = await em.save(E.RtUser, { name: "alice", team });
      const bob = await em.save(E.RtUser, { name: "bob", team });
      const badge = await em.save(E.RtBadge, { code: "gold" });
      const post = await em.save(E.RtPost, { title: "p", author: alice, editor: bob, badge });
      return { team, alice, bob, badge, post };
    }

    it("leaves the relations it did not JOIN off the entity and keeps their keys on save", async () => {
      const { post, bob, badge } = await seed();

      const [read] = await conn.em.find(E.RtPost, { where: { id: post.id }, relations: ["author"] });
      expect(read.author.name).toBe("alice");
      expect(["editor" in read, "badge" in read]).toEqual([false, false]);
      expect([read.editorId, read.badgeId]).toEqual([bob.id, badge.id]);

      read.title = "edited";
      await conn.em.save(E.RtPost, read);

      const stored = await conn.em.findOne(E.RtPost, { where: { id: post.id } });
      expect([stored.title, stored.editorId, stored.badgeId]).toEqual(["edited", bob.id, badge.id]);
    });

    it("leaves a JOINed entity's own unloaded relation off, and saving it keeps the key", async () => {
      const { post, team } = await seed();

      const [read] = await conn.em.find(E.RtPost, { where: { id: post.id }, relations: ["author"] });
      expect("team" in read.author).toBe(false);
      expect(read.author.teamId).toBe(team.id);

      read.author.name = "alice2";
      await conn.em.save(E.RtUser, read.author);

      const stored = await conn.em.findOne(E.RtUser, { where: { id: read.author.id } });
      expect([stored.name, stored.teamId]).toEqual(["alice2", team.id]);
    });

    it("still reads null for a JOINed relation that has no row", async () => {
      const post = await conn.em.save(E.RtPost, { title: "lonely" });

      const [read] = await conn.em.find(E.RtPost, { where: { id: post.id }, relations: ["author", "badge"] });
      expect([read.author, read.badge]).toEqual([null, null]);
    });
  },
);
