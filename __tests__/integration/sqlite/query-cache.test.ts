/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite In-Memory 쿼리 결과 캐시 통합 테스트
 *
 * 실제 EntityManager 경로에서 opt-in 캐시의 계약을 검증한다:
 * - 히트는 DB를 건너뛴다(대역 외 raw UPDATE가 보이지 않아야 캐시가 실재함)
 * - 같은 EntityManager를 통한 쓰기는 해당 테이블 태그를 무효화한다
 * - TTL 만료 후에는 다시 DB를 읽는다
 * - 트랜잭션 내부 읽기는 캐시를 우회한다(자기 미커밋 쓰기를 봐야 함)
 * - relations를 실은 캐시 엔트리는 관계 테이블 쓰기에도 무효화된다
 * - SelectQueryBuilder.cache() / findAndCount / 사용자 태그 / kill switch
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../../src/decorators/ManyToOne";
import { OneToMany } from "../../../src/decorators/OneToMany";
import { Relation } from "../../../src/types/Relation";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";

@Entity({ name: "qc_authors" })
class QcAuthor {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 100 })
  name!: string;

  @Column({ type: "int" })
  score!: number;

  @OneToMany(() => QcPost, { mappedBy: "author" })
  posts!: QcPost[];
}

@Entity({ name: "qc_posts" })
class QcPost {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 120 })
  title!: string;

  @Column({ type: "int", nullable: true })
  authorId?: number;

  @ManyToOne(() => QcAuthor, (e: QcAuthor) => e.posts, {
    joinColumn: "authorId",
  })
  author!: Relation<QcAuthor>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("[Integration] SQLite: query result cache", () => {
  let em: EntityManager;
  let authorId: number;

  beforeAll(async () => {
    em = await createTestEntityManager({
      entities: [QcAuthor, QcPost],
    });
  });

  afterAll(async () => {
    await (em as unknown as { destroy?: () => Promise<void> }).destroy?.();
  });

  beforeEach(async () => {
    await em.query('DELETE FROM "qc_posts"');
    await em.query('DELETE FROM "qc_authors"');
    await em.queryCache?.clear();
    const author = await em.save(QcAuthor, { name: "kim", score: 10 });
    authorId = author.id;
    await em.save(QcPost, { title: "first", authorId });
  });

  /** 캐시를 우회하는 대역 외 쓰기 — em.query(raw)는 무효화를 트리거하지 않는다. */
  async function outOfBandScore(score: number): Promise<void> {
    await em.query(
      `UPDATE "qc_authors" SET "score" = ${score} WHERE "id" = ${authorId}`,
    );
  }

  it("serves repeated finds from the cache until a write through the EM invalidates", async () => {
    const first = await em.findOne(QcAuthor, {
      where: { id: authorId },
      cache: true,
    });
    expect(first?.score).toBe(10);

    // Out-of-band change: a genuine cache must NOT see this yet.
    await outOfBandScore(77);
    const cached = await em.findOne(QcAuthor, {
      where: { id: authorId },
      cache: true,
    });
    expect(cached?.score).toBe(10);

    // A write through the EntityManager invalidates the table tag.
    await em.update(QcAuthor, { id: authorId }, { score: 99 });
    const fresh = await em.findOne(QcAuthor, {
      where: { id: authorId },
      cache: true,
    });
    expect(fresh?.score).toBe(99);
  });

  it("hits hydrate fresh instances — mutating a result never leaks into later reads", async () => {
    const a = await em.findOne(QcAuthor, {
      where: { id: authorId },
      cache: true,
    });
    a!.name = "MUTATED";
    const b = await em.findOne(QcAuthor, {
      where: { id: authorId },
      cache: true,
    });
    expect(b?.name).toBe("kim");
    expect(b).not.toBe(a);
  });

  it("expires by TTL", async () => {
    await em.findOne(QcAuthor, { where: { id: authorId }, cache: 40 });
    await outOfBandScore(55);

    const stillCached = await em.findOne(QcAuthor, {
      where: { id: authorId },
      cache: 40,
    });
    expect(stillCached?.score).toBe(10);

    await sleep(80);
    const fresh = await em.findOne(QcAuthor, {
      where: { id: authorId },
      cache: 40,
    });
    expect(fresh?.score).toBe(55);
  });

  it("save() invalidates cached lists of the same table", async () => {
    const before = await em.find(QcAuthor, { cache: true });
    expect(before).toHaveLength(1);

    await em.save(QcAuthor, { name: "lee", score: 1 });
    const after = await em.find(QcAuthor, { cache: true });
    expect(after).toHaveLength(2);
  });

  it("caches findAndCount as a pair and invalidates both on write", async () => {
    const [rows, count] = await em.findAndCount(QcAuthor, { cache: true });
    expect(rows).toHaveLength(1);
    expect(count).toBe(1);

    // Out-of-band insert is invisible to the cached pair.
    await em.query(
      'INSERT INTO "qc_authors" ("name", "score") VALUES (\'ghost\', 0)',
    );
    const [cachedRows, cachedCount] = await em.findAndCount(QcAuthor, {
      cache: true,
    });
    expect(cachedRows).toHaveLength(1);
    expect(cachedCount).toBe(1);

    await em.save(QcAuthor, { name: "park", score: 2 });
    const [freshRows, freshCount] = await em.findAndCount(QcAuthor, {
      cache: true,
    });
    expect(freshRows).toHaveLength(3);
    expect(freshCount).toBe(3);
  });

  it("invalidates a relations-loaded entry when the related table is written", async () => {
    const withPosts = await em.find(QcAuthor, {
      where: { id: authorId },
      relations: ["posts"],
      cache: true,
    });
    expect(withPosts[0].posts?.[0]?.title).toBe("first");

    // Prove it is cached: raw UPDATE on the posts table stays invisible.
    await em.query(
      `UPDATE "qc_posts" SET "title" = 'raw-renamed' WHERE "authorId" = ${authorId}`,
    );
    const cached = await em.find(QcAuthor, {
      where: { id: authorId },
      relations: ["posts"],
      cache: true,
    });
    expect(cached[0].posts?.[0]?.title).toBe("first");

    // Writing the RELATED entity through the EM drops the tagged entry.
    const post = (await em.find(QcPost, {}))[0];
    await em.update(QcPost, { id: post.id }, { title: "em-renamed" });
    const fresh = await em.find(QcAuthor, {
      where: { id: authorId },
      relations: ["posts"],
      cache: true,
    });
    expect(fresh[0].posts?.[0]?.title).toBe("em-renamed");
  });

  it("bypasses the cache inside a transaction so it sees its own writes", async () => {
    // Prime the cache outside the transaction.
    const primed = await em.findOne(QcAuthor, {
      where: { id: authorId },
      cache: true,
    });
    expect(primed?.score).toBe(10);

    await em.transaction(async (tx) => {
      await tx.update(QcAuthor, { id: authorId }, { score: 500 });
      const inTx = await tx.findOne(QcAuthor, {
        where: { id: authorId },
        cache: true,
      });
      expect(inTx?.score).toBe(500);
    });

    const after = await em.findOne(QcAuthor, {
      where: { id: authorId },
      cache: true,
    });
    expect(after?.score).toBe(500);
  });

  it("supports manual invalidation by user tag", async () => {
    await em.findOne(QcAuthor, {
      where: { id: authorId },
      cache: { ttl: 60_000, tag: "author-page" },
    });
    await outOfBandScore(31);

    const cached = await em.findOne(QcAuthor, {
      where: { id: authorId },
      cache: { ttl: 60_000, tag: "author-page" },
    });
    expect(cached?.score).toBe(10);

    await em.queryCache?.invalidate("author-page");
    const fresh = await em.findOne(QcAuthor, {
      where: { id: authorId },
      cache: { ttl: 60_000, tag: "author-page" },
    });
    expect(fresh?.score).toBe(31);
  });

  it("caches SelectQueryBuilder terminals via .cache()", async () => {
    const qb = () =>
      em
        .createQueryBuilder(QcAuthor, "a")
        .where("id", "=", authorId)
        .cache(60_000);

    const first = await qb().getMany();
    expect(first[0].score).toBe(10);

    await outOfBandScore(64);
    const cached = await qb().getMany();
    expect(cached[0].score).toBe(10);

    const cachedCount = await em
      .createQueryBuilder(QcAuthor, "a")
      .cache(60_000)
      .getCount();
    expect(cachedCount).toBe(1);

    await em.update(QcAuthor, { id: authorId }, { score: 65 });
    const fresh = await qb().getMany();
    expect(fresh[0].score).toBe(65);
  });

  it("reports hits and misses via em.queryCache.stats", async () => {
    const statsBefore = em.queryCache!.stats;
    await em.findOne(QcAuthor, { where: { id: authorId }, cache: true });
    await em.findOne(QcAuthor, { where: { id: authorId }, cache: true });
    const statsAfter = em.queryCache!.stats;
    expect(statsAfter.misses).toBeGreaterThan(statsBefore.misses);
    expect(statsAfter.hits).toBeGreaterThan(statsBefore.hits);
  });

  it("uncached reads never populate or read the cache", async () => {
    await em.findOne(QcAuthor, { where: { id: authorId } });
    await outOfBandScore(42);
    const fresh = await em.findOne(QcAuthor, { where: { id: authorId } });
    expect(fresh?.score).toBe(42);
  });

  it("register({ cache: false }) is a kill switch for per-query cache requests", async () => {
    const emOff = new EntityManager();
    await emOff.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities: [QcAuthor, QcPost],
        synchronize: true,
        cache: false,
      } as any,
      "qc_off",
    );
    try {
      const author = await emOff.save(QcAuthor, { name: "off", score: 1 });
      await emOff.findOne(QcAuthor, { where: { id: author.id }, cache: true });
      await emOff.query(
        `UPDATE "qc_authors" SET "score" = 2 WHERE "id" = ${author.id}`,
      );
      const fresh = await emOff.findOne(QcAuthor, {
        where: { id: author.id },
        cache: true,
      });
      expect(fresh?.score).toBe(2);
      expect(emOff.queryCache).toBeUndefined();
    } finally {
      await (emOff as unknown as { destroy?: () => Promise<void> }).destroy?.();
    }
  });
});
