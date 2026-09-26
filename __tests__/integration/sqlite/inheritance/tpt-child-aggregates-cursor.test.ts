/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite In-Memory: aggregates and cursor pagination on a JOINED (TPT) child.
 *
 * find() reads a child through its table INNER JOINed to the root's, which
 * holds every inherited column. count()/exists()/sum()/avg()/min()/max() —
 * and so the totals of findAndCount()/findWithPage() — and findWithCursor()
 * read the child's table alone, so:
 *
 *   - criteria, aggregate fields, groupBy and cursor order columns naming an
 *     inherited column failed with `no such column`;
 *   - a root @DeletedAt made every one of them fail, the soft-delete
 *     predicate included;
 *   - findWithCursor() selected every column bare from the child table and
 *     failed even with no criteria.
 *
 * They now read the same rows find() does: the two tables joined.
 */
import "reflect-metadata";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Inheritance,
  DiscriminatorColumn,
  DiscriminatorValue,
  DeletedAt,
  ManyToOne,
  RelationColumn,
} from "../../../../src";
import { EntityManager } from "../../../../src/core/EntityManager";
import { MetadataContext } from "../../../../src/metadata/MetadataContext";

@Entity({ name: "tac_owner" })
class TacOwner {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
}

@Entity({ name: "tac_doc" })
@Inheritance({ strategy: "JOINED" })
@DiscriminatorColumn({ name: "dtype" })
class TacDoc {
  @PrimaryGeneratedColumn() id!: number;
  @Column() title!: string;
  @Column({ type: "int" }) score!: number;
  @ManyToOne(() => TacOwner, (o: any) => o.docs)
  @RelationColumn({ name: "owner_id", nullable: true } as any)
  owner!: TacOwner | null;
  @DeletedAt() deletedAt!: Date | null;
}

@Entity({ name: "tac_review" })
@DiscriminatorValue("review")
class TacReview extends TacDoc {
  @Column() reviewer!: string;
  @Column({ type: "int" }) stars!: number;
}

@Entity({ name: "tac_memo" })
@DiscriminatorValue("memo")
class TacMemo extends TacDoc {
  @Column() note!: string;
}

const ENTITIES = [TacOwner, TacDoc, TacReview, TacMemo];

async function makeEm(tenant = false): Promise<EntityManager> {
  const em = new EntityManager();
  await em.register(
    {
      type: "sqlite",
      database: ":memory:",
      entities: ENTITIES,
      synchronize: true,
      logging: false,
      ...(tenant ? { tenantStrategy: "tenant_column" } : {}),
    } as any,
    `tac_${Math.random().toString(36).slice(2, 10)}`,
  );
  return em;
}

describe("[Integration] SQLite: TPT child aggregates and cursor pagination", () => {
  let em: EntityManager;
  const R: any = TacReview;
  let ownerA: TacOwner;
  let ownerB: TacOwner;

  beforeEach(async () => {
    em = await makeEm();
    ownerA = await em.save(TacOwner, { name: "a" } as any);
    ownerB = await em.save(TacOwner, { name: "b" } as any);
    // Five reviews, one of them trashed; a memo and a plain doc share the
    // titles and scores so a root-column criteria has sibling rows to miss.
    const reviews = [
      { title: "t1", score: 10, reviewer: "bob", stars: 1, ownerId: ownerA.id },
      { title: "t2", score: 20, reviewer: "amy", stars: 2, ownerId: ownerA.id },
      { title: "t3", score: 30, reviewer: "bob", stars: 3, ownerId: ownerB.id },
      { title: "t4", score: 40, reviewer: "amy", stars: 4, ownerId: ownerB.id },
      { title: "t5", score: 50, reviewer: "bob", stars: 5, ownerId: ownerB.id },
    ];
    for (const row of reviews) await em.save(TacReview, row as any);
    await em.save(TacMemo, { title: "t1", score: 10, note: "n", ownerId: ownerA.id } as any);
    await em.save(TacDoc, { title: "t1", score: 10, ownerId: ownerA.id } as any);
    await em
      .getDriver()!
      .executeRaw(`UPDATE tac_doc SET deletedAt = '2026-01-01T00:00:00.000Z' WHERE title = 't5'`);
  });

  afterEach(async () => {
    await em.propagateShutdown();
  });

  describe("aggregates", () => {
    it("count() and exists() filter by a root column over this class's live rows", async () => {
      expect(await em.count(R, { title: "t1" })).toBe(1);
      expect(await em.count(R, { score: { gte: 20 } } as any)).toBe(3);
      expect(await em.count(R, {})).toBe(4);
      expect(await em.exists(R, { title: "t2" })).toBe(true);
      expect(await em.exists(R, { title: "t5" })).toBe(false);
    });

    it("count() honours withDeleted and onlyDeleted", async () => {
      expect(await em.count(R, {}, true)).toBe(5);
      expect(await em.count(R, {}, false, true)).toBe(1);
    });

    it("sum/avg/min/max aggregate a root column and filter across both tables", async () => {
      expect(await em.sum(TacReview, "score", {})).toBe(100);
      expect(await em.sum(TacReview, "stars", { title: { in: ["t1", "t2"] } } as any)).toBe(3);
      expect(await em.avg(TacReview, "score", { reviewer: "amy" } as any)).toBe(30);
      expect(await em.min(TacReview, "score", { reviewer: "bob" } as any)).toBe(10);
      expect(await em.max(TacReview, "score", {})).toBe(40);
    });

    it("count() filters by a relation join column the root declares", async () => {
      expect(await em.count(R, { ownerId: ownerA.id } as any)).toBe(2);
      // t5 is trashed.
      expect(await em.count(R, { ownerId: ownerB.id } as any)).toBe(2);
    });

    it("findAndCount() and findWithPage() totals agree with the rows", async () => {
      const [rows, total] = await em.findAndCount(R, {
        where: { score: { lte: 30 } },
        orderBy: { id: "ASC" },
      } as any);
      expect(rows.map((r: any) => r.title)).toEqual(["t1", "t2", "t3"]);
      expect(total).toBe(3);

      const page = await em.findWithPage(R, { page: 2, pageSize: 3, orderBy: { id: "ASC" } } as any);
      expect(page.total).toBe(4);
      expect(page.data.map((r: any) => r.title)).toEqual(["t4"]);
    });

    it("a grouped findAndCount() counts groups of a root column", async () => {
      const [, groups] = await em.findAndCount(R, {
        select: ["reviewer"],
        groupBy: ["reviewer"],
      } as any);
      expect(groups).toBe(2);
    });
  });

  describe("findWithCursor()", () => {
    it("pages this class's live rows in primary-key order", async () => {
      const first = await em.findWithCursor(R, { take: 3 });
      expect(first.data.map((r: any) => r.title)).toEqual(["t1", "t2", "t3"]);
      expect(first.data[0]).toBeInstanceOf(TacReview);
      expect(first.data[0]).toMatchObject({ reviewer: "bob", stars: 1, score: 10 });
      expect(first.hasNextPage).toBe(true);

      const second = await em.findWithCursor(R, { take: 3, cursor: first.nextCursor! });
      expect(second.data.map((r: any) => r.title)).toEqual(["t4"]);
      expect(second.hasNextPage).toBe(false);
    });

    it("orders by and filters on root columns across pages", async () => {
      const opts = { take: 2, orderBy: "score", direction: "DESC", where: { score: { gt: 10 } } } as any;
      const first = await em.findWithCursor(R, opts);
      expect(first.data.map((r: any) => r.score)).toEqual([40, 30]);
      const second = await em.findWithCursor(R, { ...opts, cursor: first.nextCursor });
      expect(second.data.map((r: any) => r.score)).toEqual([20]);
      expect(second.hasNextPage).toBe(false);
    });

    it("withDeleted pages the trashed row too", async () => {
      const page = await em.findWithCursor(R, { take: 10, withDeleted: true } as any);
      expect(page.data.map((r: any) => r.title)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    });

    it("filters by a relation join column the root declares", async () => {
      const page = await em.findWithCursor(R, { take: 10, where: { ownerId: ownerA.id } } as any);
      expect(page.data.map((r: any) => r.title)).toEqual(["t1", "t2"]);
    });
  });
});

describe("[Integration] SQLite: TPT child aggregates and cursor under tenant_column", () => {
  let em: EntityManager;
  const R: any = TacReview;
  const acme = <T>(fn: () => Promise<T>) => MetadataContext.run("acme", fn);

  beforeEach(async () => {
    MetadataContext.reset();
    em = await makeEm(true);
    await acme(() => em.save(R, { title: "t", score: 1, reviewer: "bob", stars: 1 }));
    await MetadataContext.run("globex", () =>
      em.save(R, { title: "t", score: 5, reviewer: "bob", stars: 1 }),
    );
  });

  afterEach(async () => {
    await em.propagateShutdown();
  });

  it("counts and sums the active tenant's rows only", async () => {
    await acme(async () => {
      expect(await em.count(R, { title: "t" })).toBe(1);
      expect(await em.sum(TacReview, "score", {})).toBe(1);
    });
  });

  it("pages the active tenant's rows only", async () => {
    await acme(async () => {
      const page = await em.findWithCursor(R, { take: 10 });
      expect(page.data.map((r: any) => r.score)).toEqual([1]);
    });
  });
});
