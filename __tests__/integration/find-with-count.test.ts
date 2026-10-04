/**
 * `withCount` on a real PostgreSQL / MySQL (MariaDB): the batched GROUP BY
 * of a OneToMany and of a ManyToMany read through its join table, a count's
 * where and soft-delete scope, counts under `relations`, the cursor path,
 * and the count handed back as a number — PostgreSQL returns `COUNT(*)` as
 * a bigint string.
 *
 * SQLite: __tests__/integration/sqlite/find-with-count.test.ts
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
  "[Integration] $label: withCount",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let E: Record<string, new () => any>;
    let ids: Record<string, number>;
    const t = {
      user: shortName("wcus"),
      tag: shortName("wcta"),
      post: shortName("wcpo"),
      comment: shortName("wcco"),
      postTags: shortName("wcpt"),
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
            postCount?: number;
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
            @RelationColumn({ name: "author_id", nullable: true })
            author!: any;
            @OneToMany(() => Comment, { mappedBy: "post" }) comments!: any[];
            @ManyToMany(() => Tag, {
              joinTable: { name: t.postTags, joinColumn: "post_id", inverseJoinColumn: "tag_id" },
            })
            tags!: any[];
            commentCount?: number;
            approvedCount?: number;
            tagCount?: number;
          }

          @Entity({ name: t.comment })
          class Comment {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "boolean" }) approved!: boolean;
            @ManyToOne(() => Post, (p: any) => p.comments)
            @RelationColumn({ name: "post_id" })
            post!: any;
            @DeletedAt() deletedAt!: Date | null;
          }

          E = { User, Tag, Post, Comment };
          return { entities: [User, Tag, Post, Comment] };
        },
      );
      em = conn.em;

      const alice = await em.save(E.User, { name: "alice" });
      const orm = await em.save(E.Tag, { label: "orm" });
      const sqlTag = await em.save(E.Tag, { label: "sql" });
      const p1 = await em.save(E.Post, { title: "p1", author: alice });
      const p2 = await em.save(E.Post, { title: "p2", author: alice });
      const p3 = await em.save(E.Post, { title: "p3", author: null });
      const q = (name: string) => (type === "postgres" ? `"${name}"` : `\`${name}\``);
      await rawQuery(
        `INSERT INTO ${q(t.postTags)} (${q("post_id")}, ${q("tag_id")}) VALUES (${p1.id}, ${orm.id}), (${p1.id}, ${sqlTag.id}), (${p2.id}, ${sqlTag.id})`,
      );
      await em.save(E.Comment, { approved: true, post: p1 });
      await em.save(E.Comment, { approved: false, post: p1 });
      await em.save(E.Comment, { approved: true, post: p2 });
      const trashed = await em.save(E.Comment, { approved: true, post: p2 });
      await em.softDelete(E.Comment, { id: trashed.id });
      ids = { alice: alice.id, p1: p1.id, p2: p2.id, p3: p3.id };
    }, 60000);

    afterAll(async () => {
      try {
        await rawQuery(disableFkChecksSql(type));
        for (const name of [t.postTags, t.comment, t.post, t.tag, t.user]) {
          await dropTestTable(name);
        }
        await rawQuery(enableFkChecksSql(type));
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 30000);

    it("counts a OneToMany and a ManyToMany per parent, as numbers, 0 for none", async () => {
      const posts = await em.find(E.Post, {
        orderBy: { id: "ASC" },
        withCount: {
          commentCount: "comments",
          approvedCount: { relation: "comments", where: { approved: true } },
          tagCount: "tags",
        },
      } as any);
      expect(posts.map((p: any) => [p.title, p.commentCount, p.approvedCount, p.tagCount])).toEqual([
        ["p1", 2, 1, 2],
        ["p2", 1, 1, 1],
        ["p3", 0, 0, 0],
      ]);
    });

    it("counts soft-deleted rows when the count says withDeleted", async () => {
      const [p2] = await em.find(E.Post, {
        where: { id: ids.p2 },
        withCount: { commentCount: { relation: "comments", withDeleted: true } },
      } as any);
      expect(p2.commentCount).toBe(2);
    });

    it("counts under relations and on cursor pages", async () => {
      const [alice] = await em.find(E.User, {
        where: { id: ids.alice },
        withCount: { postCount: "posts" },
        relations: { posts: { orderBy: { id: "ASC" }, withCount: { commentCount: "comments" } } },
      } as any);
      expect(alice.postCount).toBe(2);
      expect(alice.posts.map((p: any) => p.commentCount)).toEqual([2, 1]);

      const page = await em.findWithCursor(E.Post, { take: 2, withCount: { tagCount: "tags" } } as any);
      expect(page.data.map((p: any) => p.tagCount)).toEqual([2, 1]);
    });
  },
);
