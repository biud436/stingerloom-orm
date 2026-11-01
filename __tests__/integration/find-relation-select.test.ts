/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `select` in a relation's entry of `relations` on a real PostgreSQL /
 * MySQL (MariaDB): a JOINed ManyToOne, a paged OneToMany (the column list
 * inside the window-function derived table), a ManyToMany read through its
 * join table, and a nested to-one relation loaded by a join column the
 * outer `select` does not name.
 *
 * SQLite: __tests__/integration/sqlite/find-relation-select.test.ts
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
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  OneToMany,
  ManyToMany,
  RelationColumn,
} from "../../src";

function shortName(prefix: string): string {
  return `${prefix}_${String(Date.now()).slice(-7)}`;
}

describe.each(getTestDrivers())(
  "[Integration] $label: select in a relation's entry",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let E: Record<string, new () => any>;
    const t = {
      team: shortName("rste"),
      user: shortName("rsus"),
      tag: shortName("rsta"),
      post: shortName("rspo"),
      comment: shortName("rsco"),
      postTags: shortName("rspt"),
    };

    beforeAll(async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          @Entity({ name: t.team })
          class Team {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) name!: string;
            @Column({ type: "varchar", length: 40 }) motto!: string;
          }

          @Entity({ name: t.user })
          class User {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) name!: string;
            @Column({ type: "varchar", length: 60 }) email!: string;
            @ManyToOne(() => Team, (tm: any) => tm.id)
            @RelationColumn({ name: "team_id" })
            team!: any;
            @OneToMany(() => Post, { mappedBy: "author" }) posts!: any[];
          }

          @Entity({ name: t.tag })
          class Tag {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) label!: string;
            @Column({ type: "varchar", length: 40 }) color!: string;
          }

          @Entity({ name: t.post })
          class Post {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) title!: string;
            @ManyToOne(() => User, (u: any) => u.posts)
            @RelationColumn({ name: "author_id" })
            author!: any;
            @OneToMany(() => Comment, { mappedBy: "post" }) comments!: any[];
            @ManyToMany(() => Tag, {
              joinTable: { name: t.postTags, joinColumn: "post_id", inverseJoinColumn: "tag_id" },
            })
            tags!: any[];
          }

          @Entity({ name: t.comment })
          class Comment {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) body!: string;
            @Column({ type: "int", name: "score_points" }) score!: number;
            @ManyToOne(() => Post, (p: any) => p.comments)
            @RelationColumn({ name: "post_id" })
            post!: any;
            @ManyToOne(() => User, (u: any) => u.id)
            @RelationColumn({ name: "author_id" })
            author!: any;
          }

          E = { Team, User, Tag, Post, Comment };
          return { entities: [Team, User, Tag, Post, Comment] };
        },
      );
      em = conn.em;

      const team = await em.save(E.Team, { name: "core", motto: "ship it" });
      const alice = await em.save(E.User, { name: "alice", email: "a@x.io", team });
      const bob = await em.save(E.User, { name: "bob", email: "b@x.io", team: null });
      const red = await em.save(E.Tag, { label: "red", color: "#f00" });
      const p1 = await em.save(E.Post, { title: "p1", author: alice });
      await em.save(E.Post, { title: "p2", author: bob });
      const q = (name: string) => (type === "postgres" ? `"${name}"` : `\`${name}\``);
      await rawQuery(
        `INSERT INTO ${q(t.postTags)} (${q("post_id")}, ${q("tag_id")}) VALUES (${p1.id}, ${red.id})`,
      );
      for (const [body, score, author] of [
        ["a", 10, bob],
        ["b", 30, alice],
        ["c", 20, bob],
      ] as const) {
        await em.save(E.Comment, { post: p1, body, score, author });
      }
    }, 60000);

    afterAll(async () => {
      try {
        await rawQuery(disableFkChecksSql(type));
        for (const name of [t.postTags, t.comment, t.post, t.tag, t.user, t.team]) await dropTestTable(name);
        await rawQuery(enableFkChecksSql(type));
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 30000);

    it("reads only the named columns of a JOINed ManyToOne", async () => {
      const posts: any[] = await em.find(E.Post, {
        orderBy: { id: "ASC" },
        relations: { author: { select: ["name"] } },
      });

      expect(posts.map((p) => [typeof p.author.id, p.author.name, p.author.email])).toEqual([
        ["number", "alice", undefined],
        ["number", "bob", undefined],
      ]);
    });

    it("narrows a paged OneToMany and a ManyToMany read through its join table", async () => {
      const [p1]: any[] = await em.find(E.Post, {
        where: { title: "p1" },
        relations: {
          comments: { select: ["body", "score"], orderBy: { score: "DESC" }, take: 2 },
          tags: { select: { label: true } },
        },
      });

      expect(p1.comments.map((c: any) => ({ ...c }))).toEqual([
        { id: expect.any(Number), body: "b", score: 30 },
        { id: expect.any(Number), body: "c", score: 20 },
      ]);
      expect(p1.tags.map((tg: any) => ({ ...tg }))).toEqual([{ id: expect.any(Number), label: "red" }]);
    });

    it("keeps the join column a nested to-one relation is loaded by", async () => {
      const [p1]: any[] = await em.find(E.Post, {
        where: { title: "p1" },
        relations: {
          author: { select: ["name"], relations: { team: { select: ["name"] } } },
          comments: { select: ["body"], orderBy: { score: "ASC" }, relations: { author: { select: ["name"] } } },
        },
      });

      expect([p1.author.name, p1.author.team.name, p1.author.team.motto]).toEqual(["alice", "core", undefined]);
      expect(p1.comments.map((c: any) => [c.body, c.author.name, c.author.email])).toEqual([
        ["a", "bob", undefined],
        ["c", "bob", undefined],
        ["b", "alice", undefined],
      ]);
    });
  },
);
