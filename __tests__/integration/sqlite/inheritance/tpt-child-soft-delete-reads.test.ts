/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite In-Memory: a JOINED (TPT) child whose root declares @DeletedAt.
 *
 * The child reads its inherited columns from the root table, which it INNER
 * JOINs under the root's name — but the soft-delete predicate was qualified
 * with the child's table, `"tsr_review"."deletedAt" IS NULL`, a column the
 * child table does not have. Every find() on the child failed with
 * `no such column`, and so did save(), which reads the row back.
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
} from "../../../../src";
import { EntityManager } from "../../../../src/core/EntityManager";

@Entity({ name: "tsr_doc" })
@Inheritance({ strategy: "JOINED" })
@DiscriminatorColumn({ name: "dtype" })
class TsrDoc {
  @PrimaryGeneratedColumn() id!: number;
  @Column() title!: string;
  @DeletedAt() deletedAt!: Date | null;
}

@Entity({ name: "tsr_review" })
@DiscriminatorValue("review")
class TsrReview extends TsrDoc {
  @Column() reviewer!: string;
}

@Entity({ name: "tsr_memo" })
@DiscriminatorValue("memo")
class TsrMemo extends TsrDoc {
  @Column() note!: string;
}

describe("[Integration] SQLite: TPT child reads with a root @DeletedAt", () => {
  let em: EntityManager;
  let bob: TsrReview;
  let amy: TsrReview;

  beforeEach(async () => {
    em = new EntityManager();
    await em.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities: [TsrDoc, TsrReview, TsrMemo],
        synchronize: true,
        logging: false,
      } as any,
      `tsr_${Math.random().toString(36).slice(2, 10)}`,
    );
    bob = await em.save(TsrReview, { title: "shared", reviewer: "bob" } as any);
    amy = await em.save(TsrReview, { title: "r2", reviewer: "amy" } as any);
    await em.save(TsrMemo, { title: "shared", note: "n" } as any);
    // Trashed through the root table directly, independent of softDelete().
    await em
      .getDriver()!
      .executeRaw(`UPDATE tsr_doc SET deletedAt = '2026-01-01T00:00:00.000Z' WHERE id = ${amy.id}`);
  });

  afterEach(async () => {
    await em.propagateShutdown();
  });

  it("save() returns the row it read back", () => {
    expect(bob).toMatchObject({ title: "shared", reviewer: "bob", deletedAt: null });
    expect(bob).toBeInstanceOf(TsrReview);
  });

  it("find() hides a row trashed on the root table", async () => {
    const rows = await em.find(TsrReview, {});
    expect(rows.map((r) => r.id)).toEqual([bob.id]);
  });

  it("find() filters by columns of both tables alongside the soft-delete predicate", async () => {
    const byRoot = await em.find(TsrReview, { where: { title: "shared" } as any });
    expect(byRoot.map((r) => r.reviewer)).toEqual(["bob"]);
    const byChild = await em.find(TsrReview, { where: { reviewer: "amy" } as any });
    expect(byChild).toEqual([]);
  });

  it("withDeleted and onlyDeleted see the trashed row", async () => {
    const all = await em.find(TsrReview, { withDeleted: true, orderBy: { id: "ASC" } } as any);
    expect(all.map((r) => r.id)).toEqual([bob.id, amy.id]);
    const trashed = await em.find(TsrReview, { onlyDeleted: true } as any);
    expect(trashed.map((r) => r.id)).toEqual([amy.id]);
    expect(trashed[0].deletedAt).toBeInstanceOf(Date);
  });

  it("findOne() and findByPK() answer by the root's deletedAt", async () => {
    expect((await em.findOne(TsrReview, { where: { id: bob.id } as any }))?.reviewer).toBe("bob");
    expect(await em.findOne(TsrReview, { where: { id: amy.id } as any })).toBeNull();
    expect((await em.findByPK(TsrReview, bob.id))?.reviewer).toBe("bob");
    expect(await em.findByPK(TsrReview, amy.id)).toBeNull();
  });

  it("pluck() reads live rows only", async () => {
    expect(await em.pluck(TsrReview, "reviewer" as any)).toEqual(["bob"]);
  });

  it("a root read is unaffected", async () => {
    const rows = await em.find(TsrDoc, { orderBy: { id: "ASC" } } as any);
    expect(rows.map((r) => r.title)).toEqual(["shared", "shared"]);
  });
});
