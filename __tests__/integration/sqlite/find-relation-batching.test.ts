/**
 * The batched collection reads behind `relations`: how a page of each
 * parent's rows is ranked, and how many parent keys one statement binds.
 *
 * - Per-parent paging breaks ties by every column of the related primary
 *   key, so a composite-keyed relation pages the same way twice.
 * - A level binds each parent key once, and a parent set larger than the
 *   driver's slice (900 keys on SQLite) is read in slices and merged.
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { PrimaryColumn } from "../../../src/decorators/PrimaryColumn";
import { ManyToOne } from "../../../src/decorators/ManyToOne";
import { OneToMany } from "../../../src/decorators/OneToMany";
import { RelationColumn } from "../../../src/decorators/RelationColumn";
import { Relation } from "../../../src/types/Relation";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";
import { DatabaseClient } from "../../../src/DatabaseClient";

@Entity({ name: "frb_users" })
class FrbUser {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) name!: string;
  @OneToMany(() => FrbPost, { mappedBy: "author" }) posts!: FrbPost[];
}

@Entity({ name: "frb_posts" })
class FrbPost {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar", length: 40 }) title!: string;
  @ManyToOne(() => FrbUser, (u: FrbUser) => u.posts)
  @RelationColumn({ name: "author_id", nullable: true })
  author!: Relation<FrbUser> | null;
  @OneToMany(() => FrbVote, { mappedBy: "post" }) votes!: FrbVote[];
}

/** Keyed by (round, seat): two votes of one round tie on the first key column. */
@Entity({ name: "frb_votes" })
class FrbVote {
  @PrimaryColumn({ type: "int" }) round!: number;
  @PrimaryColumn({ type: "int" }) seat!: number;
  @Column({ type: "varchar", length: 10 }) choice!: string;
  @ManyToOne(() => FrbPost, (p: FrbPost) => p.votes)
  @RelationColumn({ name: "post_id" })
  post!: Relation<FrbPost>;
}

/** The statements a read issued, oldest first. */
async function capture(run: () => Promise<unknown>): Promise<Array<{ sql: string; values: unknown[] }>> {
  const connector = DatabaseClient.getInstance().getConnection("frb");
  const spy = jest.spyOn(connector, "query");
  try {
    await run();
    return spy.mock.calls.map(([query, params]: any[]) => ({
      sql: typeof query === "string" ? query : (query.text ?? query.sql ?? String(query)),
      values: [...(typeof query === "string" ? (params ?? []) : (query.values ?? params ?? []))],
    }));
  } finally {
    spy.mockRestore();
  }
}

describe("[Integration] SQLite: batched relation reads", () => {
  let em: EntityManager;

  beforeAll(async () => {
    em = await createTestEntityManager({
      entities: [FrbUser, FrbPost, FrbVote],
      connectionName: "frb",
    });
  });

  afterAll(async () => {
    await em.propagateShutdown();
  });

  describe("per-parent paging on a composite key", () => {
    let postId: number;

    beforeAll(async () => {
      const post = await em.save(FrbPost, { title: "ranked", author: null });
      postId = post.id;
      // Inserted out of key order: (1,2) before (1,1). Ranking by the first
      // key column alone leaves the two round-1 votes tied, in storage order.
      await em.save(FrbVote, { round: 1, seat: 2, choice: "b", post });
      await em.save(FrbVote, { round: 1, seat: 1, choice: "a", post });
      await em.save(FrbVote, { round: 2, seat: 1, choice: "c", post });
    });

    const keys = (post: FrbPost) => post.votes.map((v) => `${v.round}-${v.seat}`);

    it("ranks by every primary-key column, so a page is the same on every read", async () => {
      const read = () =>
        em.findOne(FrbPost, { where: { id: postId }, relations: { votes: { take: 2 } } });
      expect(keys((await read())!)).toEqual(["1-1", "1-2"]);
      expect(keys((await read())!)).toEqual(["1-1", "1-2"]);
      const rest = await em.findOne(FrbPost, {
        where: { id: postId },
        relations: { votes: { skip: 2, take: 2 } },
      });
      expect(keys(rest!)).toEqual(["2-1"]);
    });

    it("breaks an orderBy tie by the full key too", async () => {
      const post = await em.findOne(FrbPost, {
        where: { id: postId },
        relations: { votes: { orderBy: { round: "DESC" }, take: 2 } },
      });
      expect(keys(post!)).toEqual(["2-1", "1-1"]);
    });

    it("names every key column in the window's ORDER BY", async () => {
      const statements = await capture(() =>
        em.findOne(FrbPost, { where: { id: postId }, relations: { votes: { take: 1 } } }),
      );
      const paged = statements.find((s) => s.sql.includes("ROW_NUMBER()"))!;
      expect(paged.sql).toMatch(/ORDER BY "round" ASC, "seat" ASC\)/);
    });
  });

  describe("parent keys per statement", () => {
    const USERS = 1_000;

    beforeAll(async () => {
      const rows = Array.from({ length: USERS }, (_, i) => ({ name: `u${i + 1}` }));
      await em.insertMany(FrbUser, rows);
      const first = (await em.findOne(FrbUser, { where: { name: "u1" } }))!;
      const last = (await em.findOne(FrbUser, { where: { name: `u${USERS}` } }))!;
      await em.save(FrbPost, { title: "first-a", author: first });
      await em.save(FrbPost, { title: "first-b", author: first });
      await em.save(FrbPost, { title: "last-a", author: last });
    });

    it("reads a parent set above the slice size in slices and merges them", async () => {
      let users: FrbUser[] = [];
      const statements = await capture(async () => {
        users = await em.find(FrbUser, { relations: ["posts"], orderBy: { id: "ASC" } });
      });
      const batched = statements.filter((s) => s.sql.includes('"frb_posts"') && s.sql.includes(" IN ("));
      expect(batched).toHaveLength(2);
      expect(batched[0].values).toHaveLength(900);
      expect(batched[1].values).toHaveLength(USERS - 900);

      expect(users).toHaveLength(USERS);
      expect(users[0].posts.map((p) => p.title).sort()).toEqual(["first-a", "first-b"]);
      expect(users[USERS - 1].posts.map((p) => p.title)).toEqual(["last-a"]);
      expect(users[1].posts).toEqual([]);
    });

    it("pages each parent within a slice", async () => {
      const users = await em.find(FrbUser, {
        relations: { posts: { orderBy: { title: "ASC" }, take: 1 } },
        orderBy: { id: "ASC" },
      });
      expect(users[0].posts.map((p) => p.title)).toEqual(["first-a"]);
      expect(users[USERS - 1].posts.map((p) => p.title)).toEqual(["last-a"]);
    });

    it("binds each parent key once when a nested level reaches the same parent twice", async () => {
      // Two posts of one author: the JOIN hydrates an author per post, and
      // the nested `posts` level must not bind that author's key twice.
      const statements = await capture(() =>
        em.find(FrbPost, { where: { title: { startsWith: "first" } }, relations: ["author.posts"] }),
      );
      const nested = statements.find((s) => s.sql.includes('"frb_posts"') && s.sql.includes(" IN ("))!;
      expect(nested.values).toHaveLength(1);
    });
  });
});
