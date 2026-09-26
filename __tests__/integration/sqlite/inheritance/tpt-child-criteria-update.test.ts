/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite In-Memory: criteria updates on a JOINED (TPT) child —
 * updateMany(), update(), increment()/decrement(), softDelete(), restore().
 *
 * A child row is split between the root table (the key and every inherited
 * column) and the child's own table. These writes ran one UPDATE against the
 * child's table with the caller's SET list and WHERE as written, so any
 * inherited column — named in the SET list or the criteria, or added by the
 * ORM: a root @UpdateTimestamp, @Version or @DeletedAt — failed with
 * `no such column`. A root relation join column was written to a stray copy
 * on the child table instead of the root's.
 *
 * They now go the way delete() does (V6-T1-6): the matching keys are read
 * through the join, each column qualified with its table, then each table
 * takes the assignments to its own columns by those keys.
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
  Version,
  UpdateTimestamp,
  ManyToOne,
  RelationColumn,
} from "../../../../src";
import { EntityManager } from "../../../../src/core/EntityManager";
import { MetadataContext } from "../../../../src/metadata/MetadataContext";

@Entity({ name: "tcu_owner" })
class TcuOwner {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
}

@Entity({ name: "tcu_doc" })
@Inheritance({ strategy: "JOINED" })
@DiscriminatorColumn({ name: "dtype" })
class TcuDoc {
  @PrimaryGeneratedColumn() id!: number;
  @Column() title!: string;
  @Column({ type: "int" }) score!: number;
  @ManyToOne(() => TcuOwner, (o: any) => o.docs)
  @RelationColumn({ name: "owner_id", nullable: true } as any)
  owner!: TcuOwner | null;
  @Version() version!: number;
  @UpdateTimestamp() updatedAt!: Date;
  @DeletedAt() deletedAt!: Date | null;
}

@Entity({ name: "tcu_review" })
@DiscriminatorValue("review")
class TcuReview extends TcuDoc {
  @Column() reviewer!: string;
  @Column({ type: "int" }) stars!: number;
}

@Entity({ name: "tcu_memo" })
@DiscriminatorValue("memo")
class TcuMemo extends TcuDoc {
  @Column() note!: string;
}

const ENTITIES = [TcuOwner, TcuDoc, TcuReview, TcuMemo];

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
    `tcu_${Math.random().toString(36).slice(2, 10)}`,
  );
  return em;
}

async function rawRows(em: EntityManager, query: string): Promise<any[]> {
  const raw: any = await em.getDriver()!.executeRaw(query);
  return Array.isArray(raw) ? raw : (raw.results ?? raw.rows ?? []);
}

const PAST = "2020-01-01T00:00:00.000Z";

describe("[Integration] SQLite: TPT child criteria updates", () => {
  let em: EntityManager;
  const R = TcuReview;
  let s: { bob: number; amy: number; cat: number; memo: number };

  /** One root row with its child columns, by primary key. */
  const row = async (id: number) => {
    const [root] = await rawRows(
      em,
      `SELECT title, score, owner_id, version, updatedAt, deletedAt FROM tcu_doc WHERE id = ${id}`,
    );
    const [child] = await rawRows(em, `SELECT reviewer, stars FROM tcu_review WHERE id = ${id}`);
    return { ...root, ...child };
  };

  beforeEach(async () => {
    em = await makeEm();
    const bob = await em.save(R, { title: "shared", score: 10, reviewer: "bob", stars: 1 });
    const amy = await em.save(R, { title: "r2", score: 20, reviewer: "amy", stars: 2 });
    const cat = await em.save(R, { title: "r3", score: 30, reviewer: "cat", stars: 3 });
    // A sibling sharing the title: a root-column criteria must not reach it.
    const memo = await em.save(TcuMemo, { title: "shared", score: 10, note: "n" } as any);
    s = { bob: bob.id, amy: amy.id, cat: cat.id, memo: memo.id };
    // A stamp in the past, so an @UpdateTimestamp write is visible.
    await em.getDriver()!.executeRaw(`UPDATE tcu_doc SET updatedAt = '${PAST}'`);
  });

  afterEach(async () => {
    await em.propagateShutdown();
  });

  describe("updateMany()", () => {
    it("sets a child column by a root-column criteria, never a sibling's row", async () => {
      const result = await em.updateMany(R, { stars: 9 }, { where: { title: "shared" } });
      expect(result.affected).toBe(1);
      expect(await row(s.bob)).toMatchObject({ stars: 9, version: 2 });
      expect(await row(s.amy)).toMatchObject({ stars: 2, version: 1 });
      expect((await row(s.memo)).version).toBe(1);
    });

    it("sets a root column by a child-column criteria", async () => {
      const result = await em.updateMany(R, { title: "renamed" }, { where: { reviewer: "amy" } });
      expect(result.affected).toBe(1);
      expect(await row(s.amy)).toMatchObject({ title: "renamed", reviewer: "amy" });
      expect((await row(s.bob)).title).toBe("shared");
    });

    it("sets columns of both tables in one call", async () => {
      const result = await em.updateMany(
        R,
        { score: 99, stars: 7 },
        { where: { OR: [{ reviewer: "bob" }, { title: "r3" }] } },
      );
      expect(result.affected).toBe(2);
      expect(await row(s.bob)).toMatchObject({ score: 99, stars: 7 });
      expect(await row(s.cat)).toMatchObject({ score: 99, stars: 7 });
      expect(await row(s.amy)).toMatchObject({ score: 20, stars: 2 });
    });

    it("bumps the root's @Version and stamps its @UpdateTimestamp", async () => {
      await em.updateMany(R, { stars: 5 }, { where: { reviewer: "bob" } });
      const bob = await row(s.bob);
      expect(bob.version).toBe(2);
      expect(bob.updatedAt).not.toBe(PAST);
      expect((await row(s.amy)).updatedAt).toBe(PAST);
    });

    it("applies orderBy on a root column and limit", async () => {
      const result = await em.updateMany(
        R,
        { stars: 0 },
        { where: { score: { gte: 10 } }, orderBy: { score: "DESC" }, limit: 2 },
      );
      expect(result.affected).toBe(2);
      expect((await row(s.cat)).stars).toBe(0);
      expect((await row(s.amy)).stars).toBe(0);
      expect((await row(s.bob)).stars).toBe(1);
    });

    it("skips trashed rows unless withDeleted", async () => {
      await em.getDriver()!.executeRaw(`UPDATE tcu_doc SET deletedAt = '${PAST}' WHERE id = ${s.amy}`);
      expect((await em.updateMany(R, { stars: 8 }, { where: { reviewer: "amy" } })).affected).toBe(0);
      expect((await row(s.amy)).stars).toBe(2);
      const result = await em.updateMany(
        R,
        { stars: 8 },
        { where: { reviewer: "amy" }, withDeleted: true },
      );
      expect(result.affected).toBe(1);
      expect((await row(s.amy)).stars).toBe(8);
    });

    it("writes a relation join column the root declares on the root table", async () => {
      const owner = await em.save(TcuOwner, { name: "o" } as any);
      await em.updateMany(R, { ownerId: owner.id } as any, { where: { reviewer: "bob" } });
      expect((await row(s.bob)).owner_id).toBe(owner.id);
      expect(await em.count(R, { ownerId: owner.id } as any)).toBe(1);
    });

    it("does not reach a sibling's row through its primary key", async () => {
      const result = await em.updateMany(R, { score: 1 }, { where: { id: s.memo } });
      expect(result.affected).toBe(0);
      expect(await row(s.memo)).toMatchObject({ score: 10, version: 1 });
    });

    it("reports 0 and writes nothing when no row matches", async () => {
      const result = await em.updateMany(R, { stars: 4 }, { where: { reviewer: "nobody" } });
      expect(result.affected).toBe(0);
      expect((await row(s.bob)).version).toBe(1);
    });
  });

  it("update() writes both tables", async () => {
    const result = await em.update(R, { reviewer: "cat" }, { title: "c", stars: 6 });
    expect(result.affected).toBe(1);
    expect(await row(s.cat)).toMatchObject({ title: "c", stars: 6, version: 2 });
  });

  it("increment() and decrement() reach a column of either table", async () => {
    await em.increment(R, { title: "r2" }, "stars", 3);
    await em.decrement(R, { reviewer: "amy" }, "score", 5);
    expect(await row(s.amy)).toMatchObject({ stars: 5, score: 15, version: 3 });
    expect(await row(s.bob)).toMatchObject({ stars: 1, score: 10, version: 1 });
  });

  describe("softDelete() and restore()", () => {
    it("stamp and clear the root's @DeletedAt by a child-column criteria", async () => {
      expect((await em.softDelete(R, { reviewer: "amy" })).affected).toBe(1);
      expect((await row(s.amy)).deletedAt).not.toBeNull();
      expect((await em.find(R, {})).map((r: any) => r.reviewer)).toEqual(["bob", "cat"]);

      expect((await em.restore(R, { reviewer: "amy" })).affected).toBe(1);
      expect((await row(s.amy)).deletedAt).toBeNull();
    });

    it("soft-delete by a root-column criteria keeps a sibling sharing the value live", async () => {
      expect((await em.softDelete(R, { title: "shared" })).affected).toBe(1);
      expect((await row(s.bob)).deletedAt).not.toBeNull();
      expect((await row(s.memo)).deletedAt).toBeNull();
    });

    it("count only rows that change state", async () => {
      await em.softDelete(R, { reviewer: "bob" });
      expect((await em.softDelete(R, { reviewer: { in: ["bob", "cat"] } })).affected).toBe(1);
      expect((await em.restore(R, { score: { gte: 10 } })).affected).toBe(2);
    });

    it("soft-delete by primary key", async () => {
      expect((await em.softDelete(R, { id: s.cat })).affected).toBe(1);
      expect((await row(s.cat)).deletedAt).not.toBeNull();
    });
  });

  it("rolls every table back when the child statement fails", async () => {
    await em.getDriver()!.executeRaw(
      `CREATE TRIGGER tcu_block BEFORE UPDATE ON tcu_review BEGIN SELECT RAISE(ABORT, 'blocked'); END`,
    );
    let rejection: unknown;
    try {
      await em.updateMany(R, { title: "x", stars: 0 }, { where: { reviewer: "bob" } });
    } catch (e) {
      rejection = e;
    }
    expect(String((rejection as { message?: string } | undefined)?.message)).toContain("blocked");
    expect(await row(s.bob)).toMatchObject({ title: "shared", stars: 1, version: 1 });
  });
});

describe("[Integration] SQLite: TPT child criteria updates under tenant_column", () => {
  let em: EntityManager;
  const R = TcuReview;
  const acme = <T>(fn: () => Promise<T>) => MetadataContext.run("acme", fn);

  beforeEach(async () => {
    MetadataContext.reset();
    em = await makeEm(true);
    await acme(() => em.save(R, { title: "t", score: 1, reviewer: "bob", stars: 1 }));
    await MetadataContext.run("globex", () =>
      em.save(R, { title: "t", score: 1, reviewer: "bob", stars: 1 }),
    );
  });

  afterEach(async () => {
    await em.propagateShutdown();
  });

  const byTenant = async () =>
    rawRows(
      em,
      `SELECT d.tenant_id, d.title, d.deletedAt IS NOT NULL AS trashed, r.stars
         FROM tcu_doc d JOIN tcu_review r ON r.id = d.id ORDER BY d.tenant_id`,
    );

  it("updateMany() writes the active tenant's rows only", async () => {
    await acme(async () => {
      expect(
        (await em.updateMany(R, { title: "u", stars: 9 }, { where: { reviewer: "bob" } })).affected,
      ).toBe(1);
    });
    expect(await byTenant()).toEqual([
      { tenant_id: "acme", title: "u", trashed: 0, stars: 9 },
      { tenant_id: "globex", title: "t", trashed: 0, stars: 1 },
    ]);
  });

  it("softDelete() and restore() stay in the active tenant", async () => {
    await acme(async () => {
      expect((await em.softDelete(R, { reviewer: "bob" })).affected).toBe(1);
    });
    await MetadataContext.run("globex", async () => {
      expect((await em.restore(R, { reviewer: "bob" })).affected).toBe(0);
    });
    expect((await byTenant()).map((r) => r.trashed)).toEqual([1, 0]);
  });
});
