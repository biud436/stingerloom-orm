/**
 * Nested relations in find() on a real PostgreSQL / MySQL (MariaDB).
 *
 * The relation reads now select each related entity's full read column set
 * (its foreign keys and computed columns) — in the JOIN of a to-one relation,
 * in the batched OneToMany / inverse OneToOne reads and in the ManyToMany
 * join-table read — and nested levels run the batched loaders again. These
 * cases run every one of those statements on both server dialects.
 *
 * SQLite: __tests__/integration/sqlite/find-nested-relations.test.ts
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
  ComputedColumn,
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
  "[Integration] $label: nested relations in find()",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let E: Record<string, new () => any>;
    const t = {
      team: shortName("nrte"),
      user: shortName("nrus"),
      profile: shortName("nrpr"),
      post: shortName("nrpo"),
      comment: shortName("nrco"),
      tag: shortName("nrta"),
      postTags: shortName("nrpt"),
    };
    let ids: Record<string, number>;

    beforeAll(async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          @Entity({ name: t.team })
          class Team {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) title!: string;
            @OneToMany(() => User, { mappedBy: "team" }) members!: any[];
          }

          @Entity({ name: t.user })
          class User {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) name!: string;
            @Column({ type: "int" }) score!: number;
            @ComputedColumn({ expression: "score * 2", type: "int" }) doubled!: number;
            @ManyToOne(() => Team, (tm: any) => tm.members)
            @RelationColumn({ name: "team_id", nullable: true })
            team!: any;
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
            @ManyToMany(() => Post, { mappedBy: "tags" }) posts!: any[];
          }

          @Entity({ name: t.post })
          class Post {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 40 }) title!: string;
            @ManyToOne(() => User, (u: any) => u.posts)
            @RelationColumn({ name: "author_id" })
            author!: any;
            @ManyToOne(() => Team, (tm: any) => tm.id)
            @RelationColumn({ name: "team_id", nullable: true })
            team!: any;
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
            @ManyToOne(() => Post, (p: any) => p.comments)
            @RelationColumn({ name: "post_id" })
            post!: any;
            @ManyToOne(() => User, (u: any) => u.id)
            @RelationColumn({ name: "author_id" })
            author!: any;
            @DeletedAt() deletedAt!: Date | null;
          }

          E = { Team, User, Profile, Tag, Post, Comment };
          return { entities: [Team, User, Profile, Tag, Post, Comment] };
        },
      );
      em = conn.em;

      const core = await em.save(E.Team, { title: "core" });
      const infra = await em.save(E.Team, { title: "infra" });
      const alice = await em.save(E.User, { name: "alice", score: 3, team: core });
      const bob = await em.save(E.User, { name: "bob", score: 5, team: infra });
      await em.save(E.Profile, { bio: "alice's", owner: alice });
      const orm = await em.save(E.Tag, { label: "orm" });
      const sqlTag = await em.save(E.Tag, { label: "sql" });
      const p1 = await em.save(E.Post, { title: "p1", author: alice, team: infra });
      const p2 = await em.save(E.Post, { title: "p2", author: bob, team: null });
      const q = (name: string) => (type === "postgres" ? `"${name}"` : `\`${name}\``);
      await rawQuery(
        `INSERT INTO ${q(t.postTags)} (${q("post_id")}, ${q("tag_id")}) VALUES (${p1.id}, ${orm.id}), (${p1.id}, ${sqlTag.id}), (${p2.id}, ${sqlTag.id})`,
      );
      await em.save(E.Comment, { body: "c1", post: p1, author: bob });
      await em.save(E.Comment, { body: "c2", post: p2, author: alice });
      const trashed = await em.save(E.Comment, { body: "c3-trashed", post: p1, author: alice });
      await em.softDelete(E.Comment, { id: trashed.id });
      ids = { core: core.id, infra: infra.id, alice: alice.id, bob: bob.id, p1: p1.id, p2: p2.id };
    }, 60000);

    afterAll(async () => {
      try {
        await rawQuery(disableFkChecksSql(type));
        for (const name of [t.postTags, t.comment, t.post, t.profile, t.tag, t.user, t.team]) {
          await dropTestTable(name);
        }
        await rawQuery(enableFkChecksSql(type));
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 30000);

    const sortById = (rows: any[]) => [...rows].sort((a, b) => a.id - b.id);

    it("loads every relation kind at a nested level", async () => {
      const posts = sortById(
        await em.find(E.Post, {
          relations: {
            comments: { relations: ["author.team"] },
            author: { relations: { profile: true, posts: { relations: ["tags"] } } },
          },
        }),
      );
      const [p1, p2] = posts;
      expect(p1.comments.map((c: any) => [c.body, c.author.name, c.author.team.title])).toEqual([
        ["c1", "bob", "infra"],
      ]);
      expect(p1.author.profile.bio).toBe("alice's");
      expect(p1.author.posts.map((p: any) => p.tags.map((tg: any) => tg.label).sort())).toEqual([
        ["orm", "sql"],
      ]);
      expect(p2.author.profile).toBeNull();
      expect(p2.comments[0].author.team.title).toBe("core");
    });

    it("loads a ManyToOne under the owning side of a OneToOne", async () => {
      const [profile] = await em.find(E.Profile, { relations: ["owner.team"] });
      expect(profile.owner.team.title).toBe("core");
    });

    it("hydrates related entities with their foreign keys and computed columns", async () => {
      const [p2] = await em.find(E.Post, { where: { id: ids.p2 }, relations: ["author", "comments", "tags"] });
      expect(p2.author).toMatchObject({ name: "bob", doubled: 10, teamId: ids.infra });
      expect(p2.comments[0]).toMatchObject({ body: "c2", authorId: ids.alice, postId: ids.p2 });
      expect(p2.tags.map((tg: any) => tg.label)).toEqual(["sql"]);
    });

    it("keeps a JOINed relation's own relation apart from a same-named JOIN of the row", async () => {
      const [plain] = await em.find(E.Post, { where: { id: ids.p1 }, relations: ["author", "team"] });
      expect(plain.team.title).toBe("infra");
      expect(plain.author.team).toBeNull();

      const [nested] = await em.find(E.Post, { where: { id: ids.p1 }, relations: ["author.team", "team"] });
      expect(nested.author.team.title).toBe("core");
    });

    it("applies soft-delete and withDeleted on a nested level", async () => {
      const [alice] = await em.find(E.User, { where: { id: ids.alice }, relations: ["posts.comments"] });
      expect(alice.posts[0].comments.map((c: any) => c.body)).toEqual(["c1"]);
      const [all] = await em.find(E.User, {
        where: { id: ids.alice },
        relations: ["posts.comments"],
        withDeleted: true,
      });
      expect(all.posts[0].comments.map((c: any) => c.body).sort()).toEqual(["c1", "c3-trashed"]);
    });

    it("loads nested relations on cursor pages", async () => {
      const page = await em.findWithCursor(E.Post, { take: 10, relations: ["author.team", "comments.author"] });
      expect(page.data.map((p: any) => p.author.team.title)).toEqual(["core", "infra"]);
      expect(page.data[0].comments[0].author.name).toBe("bob");
    });
  },
);
