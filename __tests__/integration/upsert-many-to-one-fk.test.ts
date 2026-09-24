/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The upsert family writes `@ManyToOne` keys against real servers
 * (MySQL/MariaDB + PostgreSQL).
 *
 * Mirrors __tests__/integration/sqlite/upsert-many-to-one-fk.test.ts. The
 * dialect-specific parts are the conflict forms themselves (`ON CONFLICT` vs
 * `ON DUPLICATE KEY UPDATE` / `INSERT IGNORE`) and PostgreSQL's refusal to
 * let one statement's DO UPDATE reach a row twice ("ON CONFLICT DO UPDATE
 * command cannot affect row a second time"), which a revive-only batch keyed
 * by foreign keys must avoid by collapsing repeated pairs.
 *
 * Runs only under INTEGRATION_TEST=true; individual drivers can be disabled
 * with INTEGRATION_TEST_MYSQL=false / INTEGRATION_TEST_POSTGRES=false.
 */
import "reflect-metadata";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../src/decorators/ManyToOne";
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
  user: "ufk_d_user",
  post: "ufk_d_post",
  like: "ufk_d_like",
  note: "ufk_d_note",
  bookmark: "ufk_d_bookmark",
} as const;
/** Children before parents, so the foreign keys never block a DELETE / DROP. */
const TEARDOWN_ORDER = [
  TABLES.like,
  TABLES.note,
  TABLES.bookmark,
  TABLES.user,
  TABLES.post,
];

const PAIR = ["user_id", "post_id"];

describe.each(drivers)(
  "[Integration][$label] upsert family writes @ManyToOne keys",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let UserE: new () => { id: number; name: string };
    let PostE: new () => { id: number; title: string };
    let LikeE: new () => any;
    let NoteE: new () => any;
    let BookmarkE: new () => any;
    let alice: { id: number };
    let bob: { id: number };
    let post: { id: number };

    const q = (name: string) => (type === "mysql" ? `\`${name}\`` : `"${name}"`);

    beforeAll(async () => {
      conn = await createTestConnection(
        { ...options, synchronize: true, logging: false },
        () => {
          @Entity({ name: TABLES.user })
          class User {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 32 }) name!: string;
          }

          @Entity({ name: TABLES.post })
          class Post {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 32 }) title!: string;
          }

          @Entity({ name: TABLES.like })
          @UniqueIndex(["user_id", "post_id"])
          class Like {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "int", default: 1 }) weight!: number;

            @ManyToOne(() => User, () => undefined)
            @RelationColumn({ name: "user_id" })
            user!: User;

            @ManyToOne(() => Post, () => undefined)
            @RelationColumn({ name: "post_id" })
            post!: Post;
          }

          @Entity({ name: TABLES.note })
          @UniqueIndex(["slug"])
          class Note {
            @PrimaryGeneratedColumn() id!: number;
            @Column({ type: "varchar", length: 32 }) slug!: string;
            @Column({ name: "owner_fk", type: "int", nullable: true })
            ownerId!: number | null;

            @ManyToOne(() => User, () => undefined)
            owner!: User;
          }

          @Entity({ name: TABLES.bookmark })
          @UniqueIndex(["user_id", "post_id"])
          class Bookmark {
            @PrimaryGeneratedColumn() id!: number;

            @ManyToOne(() => User, () => undefined)
            @RelationColumn({ name: "user_id" })
            user!: User;

            @ManyToOne(() => Post, () => undefined)
            @RelationColumn({ name: "post_id" })
            post!: Post;

            @DeletedAt() deletedAt!: Date | null;
          }

          UserE = User;
          PostE = Post;
          LikeE = Like;
          NoteE = Note;
          BookmarkE = Bookmark;
          return { entities: [User, Post, Like, Note, Bookmark] };
        },
      );
      em = conn.em;
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
      alice = await em.save(UserE, { name: "alice" } as any);
      bob = await em.save(UserE, { name: "bob" } as any);
      post = await em.save(PostE, { title: "p" } as any);
    });

    async function rows(table: string, columns: string[]): Promise<any[]> {
      const list = columns.map(q).join(", ");
      const result = (await em.query(
        `SELECT ${list} FROM ${q(table)} ORDER BY ${q("id")}`,
      )) as unknown as any[];
      // Normalize driver-specific integer / NULL shapes for comparison.
      return result.map((row) =>
        Object.fromEntries(
          columns.map((c) => [
            c,
            row[c] === null || row[c] === undefined || row[c] instanceof Date
              ? (row[c] ?? null)
              : Number(row[c]),
          ]),
        ),
      );
    }

    async function trashBookmarks(): Promise<void> {
      for (const { id } of await rows(TABLES.bookmark, ["id"])) {
        await em.softDelete(BookmarkE, { id });
      }
    }

    it("upsert() writes the keys and updates the row for the same pair", async () => {
      await em.upsert(LikeE, { user: alice, post, weight: 3 }, PAIR);
      await em.upsert(LikeE, { user: alice.id, post: post.id, weight: 5 }, PAIR);
      await em.upsert(LikeE, { userId: bob.id, postId: post.id, weight: 7 }, PAIR);

      expect(await rows(TABLES.like, ["user_id", "post_id", "weight"])).toEqual([
        { user_id: alice.id, post_id: post.id, weight: 5 },
        { user_id: bob.id, post_id: post.id, weight: 7 },
      ]);
    });

    it("upsert() reassigns a declared join column on conflict", async () => {
      await em.upsert(NoteE, { slug: "a", owner: alice }, ["slug"]);
      await em.upsert(NoteE, { slug: "a", owner: bob }, ["slug"]);
      await em.upsert(NoteE, { slug: "b", owner: alice.id }, ["slug"]);

      expect(await rows(TABLES.note, ["owner_fk"])).toEqual([
        { owner_fk: bob.id },
        { owner_fk: alice.id },
      ]);
    });

    it("insertIgnore() writes the keys and skips an existing pair", async () => {
      const first = await em.insertIgnore(LikeE, { user: alice, post, weight: 3 }, PAIR);
      const second = await em.insertIgnore(LikeE, { user: alice, post, weight: 9 }, PAIR);

      expect([first.affected, second.affected]).toEqual([1, 0]);
      expect(await rows(TABLES.like, ["user_id", "post_id", "weight"])).toEqual([
        { user_id: alice.id, post_id: post.id, weight: 3 },
      ]);
    });

    it("batchUpsert() writes each row's keys and updates on conflict", async () => {
      await em.batchUpsert(
        LikeE,
        [
          { user: alice, post, weight: 1 },
          { user: bob.id, post: post.id, weight: 2 },
        ],
        PAIR,
      );
      await em.batchUpsert(
        LikeE,
        [
          { userId: alice.id, postId: post.id, weight: 10 },
          { user: bob, post, weight: 20 },
        ],
        PAIR,
      );

      expect(await rows(TABLES.like, ["user_id", "post_id", "weight"])).toEqual([
        { user_id: alice.id, post_id: post.id, weight: 10 },
        { user_id: bob.id, post_id: post.id, weight: 20 },
      ]);
    });

    it("batchUpsert() revives rows keyed by relations, a repeated pair once", async () => {
      await em.batchUpsert(BookmarkE, [{ user: alice, post }], PAIR);
      await trashBookmarks();

      await em.batchUpsert(
        BookmarkE,
        [
          { user: alice, post },
          { user: alice.id, post: post.id },
          { user: bob, post },
        ],
        PAIR,
      );

      expect(
        await rows(TABLES.bookmark, ["user_id", "post_id", "deletedAt"]),
      ).toEqual([
        { user_id: alice.id, post_id: post.id, deletedAt: null },
        { user_id: bob.id, post_id: post.id, deletedAt: null },
      ]);
    });
  },
);
