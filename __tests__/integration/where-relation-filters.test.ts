/**
 * Relation filters in `where` on a real PostgreSQL / MySQL (MariaDB): the
 * correlated EXISTS of each relation kind — a OneToMany, a ManyToMany read
 * through its join table, a ManyToOne, both OneToOne sides — nested filters,
 * the count path findAndCount pairs with the rows, and a self-referencing
 * relation, where the outer row must be referenced by its table name.
 *
 * SQLite: __tests__/integration/sqlite/where-relation-filters.test.ts
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
  OneToOne,
  RelationColumn,
  DeletedAt,
} from "../../src";

function shortName(prefix: string): string {
  return `${prefix}_${String(Date.now()).slice(-7)}`;
}

describe.each(getTestDrivers())(
  "[Integration] $label: relation filters in where",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let E: Record<string, new () => any>;
    const t = {
      user: shortName("wfus"),
      profile: shortName("wfpr"),
      tag: shortName("wfta"),
      post: shortName("wfpo"),
      comment: shortName("wfco"),
      postTags: shortName("wfpt"),
      category: shortName("wfca"),
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
            @OneToOne(() => Profile, { inverseSide: "owner" }) profile!: any;
          }

          @Entity({ name: t.profile })
          class Profile {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) bio!: string;
            @OneToOne(() => User)
            @RelationColumn({ name: "owner_id" })
            owner!: any;
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
          }

          @Entity({ name: t.comment })
          class Comment {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) body!: string;
            @Column({ type: "boolean" }) approved!: boolean;
            @ManyToOne(() => Post, (p: any) => p.comments)
            @RelationColumn({ name: "post_id" })
            post!: any;
            @ManyToOne(() => User, (u: any) => u.id)
            @RelationColumn({ name: "author_id" })
            author!: any;
            @DeletedAt() deletedAt!: Date | null;
          }

          @Entity({ name: t.category })
          class Category {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) name!: string;
            @ManyToOne(() => Category, (c: any) => c.children)
            @RelationColumn({ name: "parent_id", nullable: true })
            parent!: any;
            @OneToMany(() => Category, { mappedBy: "parent" }) children!: any[];
          }

          E = { User, Profile, Tag, Post, Comment, Category };
          return { entities: [User, Profile, Tag, Post, Comment, Category] };
        },
      );
      em = conn.em;

      const alice = await em.save(E.User, { name: "alice" });
      const bob = await em.save(E.User, { name: "bob" });
      await em.save(E.Profile, { bio: "alice's", owner: alice });
      const orm = await em.save(E.Tag, { label: "orm" });
      const sqlTag = await em.save(E.Tag, { label: "sql" });
      const p1 = await em.save(E.Post, { title: "p1", author: alice });
      const p2 = await em.save(E.Post, { title: "p2", author: bob });
      await em.save(E.Post, { title: "p3", author: null });
      const q = (name: string) => (type === "postgres" ? `"${name}"` : `\`${name}\``);
      await rawQuery(
        `INSERT INTO ${q(t.postTags)} (${q("post_id")}, ${q("tag_id")}) VALUES (${p1.id}, ${orm.id}), (${p1.id}, ${sqlTag.id}), (${p2.id}, ${sqlTag.id})`,
      );
      await em.save(E.Comment, { body: "nice", approved: true, post: p1, author: bob });
      await em.save(E.Comment, { body: "hmm", approved: false, post: p1, author: alice });
      await em.save(E.Comment, { body: "ok", approved: true, post: p2, author: alice });
      const trashed = await em.save(E.Comment, { body: "spam", approved: false, post: p2, author: bob });
      await em.softDelete(E.Comment, { id: trashed.id });

      const root = await em.save(E.Category, { name: "root", parent: null });
      const child = await em.save(E.Category, { name: "child", parent: root });
      await em.save(E.Category, { name: "leaf", parent: child });
    }, 60000);

    afterAll(async () => {
      try {
        await rawQuery(disableFkChecksSql(type));
        for (const name of [t.postTags, t.comment, t.post, t.tag, t.profile, t.user, t.category]) {
          await dropTestTable(name);
        }
        await rawQuery(enableFkChecksSql(type));
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 30000);

    const titles = async (where: any) =>
      (await em.find(E.Post, { where, orderBy: { id: "ASC" } })).map((p: any) => p.title);

    it("some / none / every on a OneToMany, soft-deleted rows ignored", async () => {
      expect(await titles({ comments: { some: { approved: true } } })).toEqual(["p1", "p2"]);
      expect(await titles({ comments: { none: { approved: false } } })).toEqual(["p2", "p3"]);
      expect(await titles({ comments: { every: { approved: true } } })).toEqual(["p2", "p3"]);
    });

    it("a ManyToMany through its join table", async () => {
      expect(await titles({ tags: { some: { label: "orm" } } })).toEqual(["p1"]);
      expect(await titles({ tags: { none: {} } })).toEqual(["p3"]);
    });

    it("is / isNot on a ManyToOne and both OneToOne sides", async () => {
      expect(await titles({ author: { is: { name: "bob" } } })).toEqual(["p2"]);
      expect(await titles({ author: { is: null } })).toEqual(["p3"]);
      const users = await em.find(E.User, { where: { profile: { is: null } } });
      expect(users.map((u: any) => u.name)).toEqual(["bob"]);
      const profiles = await em.find(E.Profile, { where: { owner: { is: { name: "alice" } } } });
      expect(profiles.map((p: any) => p.bio)).toEqual(["alice's"]);
    });

    it("nests, and count / findAndCount agree with find", async () => {
      const where = { comments: { some: { author: { is: { name: "alice" } } } } };
      expect(await titles(where)).toEqual(["p1", "p2"]);
      expect(await em.count(E.Post, where)).toBe(2);
      const [rows, total] = await em.findAndCount(E.Post, { where, take: 1, orderBy: { id: "ASC" } });
      expect([rows.map((p: any) => p.title), total]).toEqual([["p1"], 2]);
    });

    it("correlates a self-referencing relation with the outer row", async () => {
      const rows = await em.find(E.Category, { where: { children: { some: {} } }, orderBy: { id: "ASC" } });
      expect(rows.map((c: any) => c.name)).toEqual(["root", "child"]);
    });
  },
);
