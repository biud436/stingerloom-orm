/**
 * SQLite In-Memory: a to-one relation a read did not load is left off the
 * entity, so saving the entity back keeps its foreign key.
 *
 * A read with `relations` JOINs what it names, and the JOIN path set every
 * other `@ManyToOne` / owning `@OneToOne` of the entity — and of the
 * entities it JOINed — to `null`. The null claimed there was no related
 * row, and `save()` of the entity as read wrote it: the foreign key was
 * cleared. A read without `relations`, a cursor page and the query builder
 * already left such relations off.
 *
 * PostgreSQL / MySQL: __tests__/integration/find-unloaded-relation-round-trip.test.ts
 */

import "reflect-metadata";
import { createTestConnection, type TestConnectionResult } from "../helpers/test-connection";
import { Entity, Column, PrimaryGeneratedColumn, ManyToOne, OneToOne, RelationColumn } from "../../../src";

describe("[Integration] SQLite: to-one relations a read did not load", () => {
  let conn: TestConnectionResult;
  const E: Record<string, new () => any> = {};
  const suffix = String(Date.now()).slice(-6);

  beforeAll(async () => {
    conn = await createTestConnection(
      { type: "sqlite", database: ":memory:", synchronize: true, logging: false },
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
  });

  afterAll(async () => {
    if (conn) await conn.cleanup();
  });

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
});
