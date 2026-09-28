/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite In-Memory: findWithCursor() on a JOINED (TPT) root.
 *
 * find() on the root is polymorphic — it LEFT JOINs every child table and
 * returns each row as its subclass with the subclass's columns. The cursor
 * page read the root table alone, so every row came back as the root class
 * without any child column. Both reads now return the same entities.
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

@Entity({ name: "trc_owner" })
class TrcOwner {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
}

@Entity({ name: "trc_doc" })
@Inheritance({ strategy: "JOINED" })
@DiscriminatorColumn({ name: "dtype" })
class TrcDoc {
  @PrimaryGeneratedColumn() id!: number;
  @Column() title!: string;
  @DeletedAt() deletedAt!: Date | null;
  @ManyToOne(() => TrcOwner, (o: any) => o.docs)
  @RelationColumn({ name: "owner_id" })
  owner!: TrcOwner | null;
}

@Entity({ name: "trc_review" })
@DiscriminatorValue("review")
class TrcReview extends TrcDoc {
  @Column() reviewer!: string;
  @ManyToOne(() => TrcOwner, (o: any) => o.reviews)
  @RelationColumn({ name: "editor_id" })
  editor!: TrcOwner | null;
}

@Entity({ name: "trc_memo" })
@DiscriminatorValue("memo")
class TrcMemo extends TrcDoc {
  @Column({ nullable: true }) note!: string;
}

describe("[Integration] SQLite: findWithCursor() on a TPT root", () => {
  let em: EntityManager;
  let alice: TrcOwner;
  let bob: TrcOwner;

  const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

  /** Every page of a cursor walk, concatenated. */
  const walk = async (option: any) => {
    const rows: any[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await em.findWithCursor(TrcDoc, { ...option, cursor });
      rows.push(...page.data);
      if (!page.hasNextPage) return rows;
      cursor = page.nextCursor!;
    }
    throw new Error("cursor walk did not end");
  };

  beforeEach(async () => {
    em = new EntityManager();
    await em.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities: [TrcOwner, TrcDoc, TrcReview, TrcMemo],
        synchronize: true,
        logging: false,
      } as any,
      `trc_${Math.random().toString(36).slice(2, 10)}`,
    );
    alice = await em.save(TrcOwner, { name: "alice" } as any);
    bob = await em.save(TrcOwner, { name: "bob" } as any);
    await em.save(TrcReview, { title: "b", reviewer: "r1", owner: alice, editor: bob } as any);
    await em.save(TrcMemo, { title: "a", note: "n1", owner: bob } as any);
    await em.save(TrcReview, { title: "b", reviewer: "r2", owner: bob } as any);
    await em.save(TrcMemo, { title: "c", note: "n2" } as any);
    const trashed = await em.save(TrcReview, { title: "a", reviewer: "r3" } as any);
    await em.softDelete(TrcDoc, { id: trashed.id } as any);
  });

  afterEach(async () => {
    await em.propagateShutdown();
  });

  it("returns each row as its subclass with the subclass's columns", async () => {
    const page = await em.findWithCursor(TrcDoc, { take: 10 });
    expect(page.data.map((d) => d.constructor)).toEqual([
      TrcReview,
      TrcMemo,
      TrcReview,
      TrcMemo,
    ]);
    expect(page.data[0]).toMatchObject({
      title: "b",
      reviewer: "r1",
      ownerId: alice.id,
      editorId: bob.id,
    });
    expect(page.data[1]).toMatchObject({ title: "a", note: "n1" });
  });

  it("reads the same entities as find()", async () => {
    const byCursor = await walk({ take: 2 });
    const byFind = await em.find(TrcDoc, { orderBy: { id: "ASC" } } as any);
    expect(byCursor.map((d) => d.constructor)).toEqual(byFind.map((d) => d.constructor));
    expect(plain(byCursor)).toEqual(plain(byFind));
  });

  it("pages by a root column with ties across subclasses, each row once", async () => {
    const rows = await walk({ take: 1, orderBy: "title", direction: "DESC" });
    expect(rows.map((d) => [d.title, d.constructor.name])).toEqual([
      ["c", "TrcMemo"],
      ["b", "TrcReview"],
      ["b", "TrcReview"],
      ["a", "TrcMemo"],
    ]);
    expect(new Set(rows.map((d) => d.id)).size).toBe(4);
  });

  it("filters by root columns and the root's @DeletedAt", async () => {
    const page = await em.findWithCursor(TrcDoc, { where: { title: "a" } } as any);
    expect(page.data.map((d) => [d.constructor.name, (d as any).note])).toEqual([
      ["TrcMemo", "n1"],
    ]);
    const withDeleted = await em.findWithCursor(TrcDoc, {
      where: { title: "a" },
      withDeleted: true,
    } as any);
    expect(withDeleted.data.map((d) => d.constructor.name)).toEqual(["TrcMemo", "TrcReview"]);
  });

  it("matches the query builder's getCursor(), which pages the polymorphic read", async () => {
    const byBuilder = await em
      .createQueryBuilder(TrcDoc, "d")
      .getCursor({ take: 10 } as any);
    const byEm = await em.findWithCursor(TrcDoc, { take: 10 });
    expect(byEm.data.map((d) => d.constructor)).toEqual(
      byBuilder.data.map((d: any) => d.constructor),
    );
  });

  it("loads a root relation into each subclass row", async () => {
    const page = await em.findWithCursor(TrcDoc, { relations: ["owner"] } as any);
    expect(plain(page.data).map((d: any) => d.owner?.name ?? null)).toEqual([
      "alice",
      "bob",
      "bob",
      null,
    ]);
  });
});
