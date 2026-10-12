/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Query cache invalidation is tied to the end of the transaction a write ran
 * in, not to the write itself.
 *
 * SQLite runs every session on one shared connection, so a read issued
 * outside an open transaction sees that transaction's uncommitted rows and
 * can cache them. These tests hold a transaction open, read outside it with
 * a cache request, then end the transaction:
 * - after ROLLBACK the cache must not keep a value that was never committed
 * - after COMMIT an entry filled while the transaction was open is dropped
 * - the transaction the ORM opens itself for a cascading save behaves the same
 *
 * The PostgreSQL / MySQL side (a reader that sees the state the transaction
 * replaces): __tests__/integration/query-cache-transaction-end.test.ts
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../../src/decorators/ManyToOne";
import { OneToMany } from "../../../src/decorators/OneToMany";
import { RelationColumn } from "../../../src/decorators/RelationColumn";
import { Relation } from "../../../src/types/Relation";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";

@Entity({ name: "qcte_authors" })
class QcteAuthor {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 100 })
  name!: string;

  @Column({ type: "int" })
  score!: number;

  @OneToMany(() => QctePost, { mappedBy: "author" })
  posts!: QctePost[];
}

@Entity({ name: "qcte_posts" })
class QctePost {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 120 })
  title!: string;

  @ManyToOne(() => QcteAuthor, (e: QcteAuthor) => e.posts, { cascade: ["insert"] })
  @RelationColumn({ name: "authorId", nullable: true })
  author!: Relation<QcteAuthor>;
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (e) {
    return e;
  }
}

describe("[Integration] SQLite: query cache invalidation at transaction end", () => {
  let em: EntityManager;
  let authorId: number;

  beforeAll(async () => {
    em = await createTestEntityManager({
      entities: [QcteAuthor, QctePost],
    });
  });

  afterAll(async () => {
    await (em as unknown as { destroy?: () => Promise<void> }).destroy?.();
  });

  beforeEach(async () => {
    await em.query('DELETE FROM "qcte_posts"');
    await em.query('DELETE FROM "qcte_authors"');
    const author = await em.save(QcteAuthor, { name: "kim", score: 10 });
    authorId = author.id;
    await em.queryCache?.clear();
  });

  const cachedScore = async () =>
    (await em.findOne(QcteAuthor, { where: { id: authorId }, cache: 60_000 }))?.score;

  const listCached = async () =>
    (await em.find(QcteAuthor, { orderBy: { id: "ASC" }, cache: 60_000 })).map((a) => a.name);

  it("does not keep a value the rolled-back transaction never committed", async () => {
    const written = gate();
    const release = gate();
    const tx = em.transaction(async (t) => {
      await t.update(QcteAuthor, { id: authorId }, { score: 999 });
      written.open();
      await release.promise;
      throw new Error("abort");
    });

    await written.promise;
    try {
      // Outside the transaction's async context: the shared connection shows
      // the uncommitted row, and the read caches it.
      expect(await cachedScore()).toBe(999);
    } finally {
      release.open();
    }
    expect(String(await errorOf(tx))).toMatch(/abort/);

    expect(await cachedScore()).toBe(10);
  });

  it("drops an entry filled while the transaction was open when it commits", async () => {
    const written = gate();
    const release = gate();
    const tx = em.transaction(async (t) => {
      await t.update(QcteAuthor, { id: authorId }, { score: 555 });
      written.open();
      await release.promise;
    });

    await written.promise;
    try {
      await cachedScore();
      expect(em.queryCache?.stats.entries).toBe(1);
    } finally {
      release.open();
    }
    await tx;

    expect(em.queryCache?.stats.entries).toBe(0);
    expect(await cachedScore()).toBe(555);
  });

  it("holds a cascade-saved parent's invalidation until the ORM's own transaction ends", async () => {
    const inserting = gate();
    const release = gate();
    const stall = async (payload: any) => {
      if (payload.entity !== QctePost) return;
      inserting.open();
      await release.promise;
      throw new Error("post rejected");
    };
    em.on("beforeInsert", stall);
    try {
      // No em.transaction(): save() opens its own and cascades the new author into it.
      const save = em.save(QctePost, { title: "p", author: { name: "lee", score: 1 } as any });

      await inserting.promise;
      // The cascaded author is inserted but not committed.
      try {
        expect(await listCached()).toEqual(["kim", "lee"]);
      } finally {
        release.open();
      }
      expect(String(await errorOf(save))).toMatch(/post rejected/);
    } finally {
      em.off("beforeInsert", stall);
    }

    expect(await listCached()).toEqual(["kim"]);
  });

  it("invalidates when a write outside any user transaction fails after its statement ran", async () => {
    const inserted = gate();
    const release = gate();
    const stall = async (payload: any) => {
      if (payload.entity !== QcteAuthor) return;
      inserted.open();
      await release.promise;
      throw new Error("author rejected");
    };
    em.on("afterInsert", stall);
    try {
      const save = em.save(QcteAuthor, { name: "park", score: 3 });

      await inserted.promise;
      try {
        expect(await listCached()).toEqual(["kim", "park"]);
      } finally {
        release.open();
      }
      expect(String(await errorOf(save))).toMatch(/author rejected/);
    } finally {
      em.off("afterInsert", stall);
    }

    expect(await listCached()).toEqual(["kim"]);
  });
});
