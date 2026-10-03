/**
 * Per-relation `where` / `orderBy` / `take` / `skip` / `withDeleted` on a
 * real PostgreSQL / MySQL (MariaDB).
 *
 * Paging each parent's rows runs a `ROW_NUMBER() OVER (PARTITION BY ...)`
 * read wrapped in a derived table — the statement these cases run on both
 * server dialects, for a OneToMany and for a ManyToMany read through its
 * join table, plus a filtered relation, a per-relation soft-delete override
 * on a JOINed ManyToOne, and options at a nested level.
 *
 * SQLite: __tests__/integration/sqlite/find-relation-filters.test.ts
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
  DeletedAt,
} from "../../src";

function shortName(prefix: string): string {
  return `${prefix}_${String(Date.now()).slice(-7)}`;
}

describe.each(getTestDrivers())(
  "[Integration] $label: per-relation options in relations",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let E: Record<string, new () => any>;
    const t = {
      user: shortName("rfus"),
      tag: shortName("rfta"),
      post: shortName("rfpo"),
      comment: shortName("rfco"),
      postTags: shortName("rfpt"),
    };

    beforeAll(async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          @Entity({ name: t.user })
          class User {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) name!: string;
            @OneToMany(() => Post, { mappedBy: "author" }) posts!: any[];
            @DeletedAt() deletedAt!: Date | null;
          }

          @Entity({ name: t.tag })
          class Tag {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) label!: string;
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
            @Column({ type: "boolean" }) approved!: boolean;
            @ManyToOne(() => Post, (p: any) => p.comments)
            @RelationColumn({ name: "post_id" })
            post!: any;
            @ManyToOne(() => User, (u: any) => u.id)
            @RelationColumn({ name: "author_id" })
            author!: any;
            @DeletedAt() deletedAt!: Date | null;
          }

          E = { User, Tag, Post, Comment };
          return { entities: [User, Tag, Post, Comment] };
        },
      );
      em = conn.em;

      const alice = await em.save(E.User, { name: "alice" });
      const bob = await em.save(E.User, { name: "bob" });
      const gone = await em.save(E.User, { name: "gone" });
      const tagIds: number[] = [];
      for (const label of ["c", "a", "b"]) tagIds.push((await em.save(E.Tag, { label })).id);
      const p1 = await em.save(E.Post, { title: "p1", author: alice });
      const p2 = await em.save(E.Post, { title: "p2", author: bob });
      await em.save(E.Post, { title: "p3", author: gone });
      const q = (name: string) => (type === "postgres" ? `"${name}"` : `\`${name}\``);
      await rawQuery(
        `INSERT INTO ${q(t.postTags)} (${q("post_id")}, ${q("tag_id")}) VALUES ` +
          `(${p1.id}, ${tagIds[0]}), (${p1.id}, ${tagIds[1]}), (${p1.id}, ${tagIds[2]}), (${p2.id}, ${tagIds[2]})`,
      );
      const seed: Array<[any, string, number, boolean, any]> = [
        [p1, "p1-a", 10, true, bob],
        [p1, "p1-b", 50, false, bob],
        [p1, "p1-c", 30, true, alice],
        [p1, "p1-d", 40, true, bob],
        [p2, "p2-a", 5, true, alice],
        [p2, "p2-b", 15, false, alice],
      ];
      for (const [post, body, score, approved, author] of seed) {
        await em.save(E.Comment, { post, body, score, approved, author });
      }
      const trashed = await em.save(E.Comment, { post: p1, body: "p1-trashed", score: 99, approved: true, author: alice });
      await em.softDelete(E.Comment, { id: trashed.id });
      await em.softDelete(E.User, { id: gone.id });
    }, 60000);

    afterAll(async () => {
      try {
        await rawQuery(disableFkChecksSql(type));
        for (const name of [t.postTags, t.comment, t.post, t.tag, t.user]) await dropTestTable(name);
        await rawQuery(enableFkChecksSql(type));
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 30000);

    const findPosts = (relations: any, extra: Record<string, unknown> = {}) =>
      em.find(E.Post, { orderBy: { id: "ASC" }, relations, ...extra });
    const bodies = (post: any) => post.comments.map((c: any) => c.body);

    it("filters and orders a OneToMany through mapped columns", async () => {
      const [p1, p2] = await findPosts({
        comments: { where: { approved: true, score: { gte: 10 } }, orderBy: { score: "DESC" } },
      });
      expect(bodies(p1)).toEqual(["p1-d", "p1-c", "p1-a"]);
      expect(bodies(p2)).toEqual([]);
    });

    it("pages each parent's OneToMany rows with a window function", async () => {
      const posts = await findPosts({ comments: { orderBy: { score: "DESC" }, skip: 1, take: 2 } });
      expect(posts.map(bodies)).toEqual([["p1-d", "p1-c"], ["p2-a"], []]);
    });

    it("pages each parent's ManyToMany rows through the join table", async () => {
      const [p1, p2] = await findPosts({
        tags: { where: { label: { ne: "a" } }, orderBy: { label: "ASC" }, take: 1 },
      });
      expect(p1.tags.map((tg: any) => tg.label)).toEqual(["b"]);
      expect(p2.tags.map((tg: any) => tg.label)).toEqual(["b"]);
    });

    it("overrides withDeleted for one relation, JOINed or batched", async () => {
      const [p1, , p3] = await findPosts({
        author: { withDeleted: true },
        comments: { withDeleted: true, where: { score: 99 } },
      });
      expect(p3.author.name).toBe("gone");
      expect(bodies(p1)).toEqual(["p1-trashed"]);
      const [, , hidden] = await findPosts({ author: true });
      expect(hidden.author).toBeNull();
    });

    it("applies options at a nested level", async () => {
      const users = await em.find(E.User, {
        orderBy: { id: "ASC" },
        relations: {
          posts: { relations: { comments: { orderBy: { score: "ASC" }, take: 1, relations: ["author"] } } },
        },
      });
      expect(users.map((u: any) => u.posts.map((p: any) => bodies(p)))).toEqual([[["p1-a"]], [["p2-a"]]]);
      expect(users[0].posts[0].comments[0].author.name).toBe("bob");
    });
  },
);
