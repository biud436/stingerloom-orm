/**
 * save() picks INSERT or UPDATE for a key the caller chooses by whether the
 * row exists.
 *
 * The branch followed the key's generation strategy: an assigned or composite
 * key always inserted, so saving an existing row again failed on the primary
 * key constraint, and a value given for a generated uuid key always updated,
 * so a new row with a caller-chosen id failed with EntityNotFoundError.
 */
import "reflect-metadata";
import {
  Entity,
  Column,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  Version,
  EntityNotFoundError,
} from "../../../src";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";

@Entity({ name: "sbk_setting" })
class Setting {
  @PrimaryColumn({ type: "varchar", length: 50 }) key!: string;
  @Column({ type: "varchar", length: 50 }) value!: string;
  @Version() version!: number;
}

@Entity({ name: "sbk_line" })
class Line {
  @PrimaryColumn({ type: "int" }) orderId!: number;
  @PrimaryColumn({ type: "int" }) lineNo!: number;
  @Column({ type: "int" }) quantity!: number;
}

@Entity({ name: "sbk_doc" })
class Doc {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Column({ type: "varchar", length: 50 }) title!: string;
}

@Entity({ name: "sbk_counter" })
class Counter {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "int" }) hits!: number;
}

describe("[Integration] SQLite: save() branches on whether the keyed row exists", () => {
  let em: EntityManager;

  beforeAll(async () => {
    em = await createTestEntityManager({ entities: [Setting, Line, Doc, Counter] });
  });

  afterAll(async () => {
    await (em as unknown as { destroy?: () => Promise<void> }).destroy?.();
  });

  it("inserts, then updates, a row with an assigned key", async () => {
    const created = await em.save(Setting, { key: "site.title", value: "Blog" });
    expect(created).toMatchObject({ key: "site.title", value: "Blog", version: 1 });

    const updated = await em.save(Setting, { key: "site.title", value: "Journal" });
    expect(updated).toMatchObject({ key: "site.title", value: "Journal", version: 2 });
    expect(await em.find(Setting)).toHaveLength(1);
  });

  it("keeps the optimistic lock on an assigned key", async () => {
    await em.save(Setting, { key: "site.lang", value: "en" });
    await expect(
      em.save(Setting, { key: "site.lang", value: "ko", version: 7 }),
    ).rejects.toThrow();
    expect((await em.findOne(Setting, { where: { key: "site.lang" } }))!.value).toBe("en");
  });

  it("inserts, then updates, a row with a composite key", async () => {
    await em.save(Line, { orderId: 1, lineNo: 1, quantity: 2 });
    await em.save(Line, { orderId: 1, lineNo: 2, quantity: 5 });
    const updated = await em.save(Line, { orderId: 1, lineNo: 1, quantity: 9 });

    expect(updated).toMatchObject({ orderId: 1, lineNo: 1, quantity: 9 });
    const rows = await em.find(Line, { orderBy: { lineNo: "ASC" } });
    expect(rows.map((r) => r.quantity)).toEqual([9, 5]);
  });

  it("updates existing rows and inserts new ones through saveMany", async () => {
    await em.save(Setting, { key: "many.a", value: "1" });
    const saved = await em.saveMany(Setting, [
      { key: "many.a", value: "2" },
      { key: "many.b", value: "1" },
    ]);

    expect(saved.map((s) => [s.key, s.value, s.version])).toEqual([
      ["many.a", "2", 2],
      ["many.b", "1", 1],
    ]);
  });

  it("inserts a row whose generated uuid key the caller chose, then updates it", async () => {
    const id = "0191e0c8-7b1a-7c3e-8f00-000000000001";
    const created = await em.save(Doc, { id, title: "draft" });
    expect(created).toMatchObject({ id, title: "draft" });

    const updated = await em.save(Doc, { id, title: "final" });
    expect(updated).toMatchObject({ id, title: "final" });
    expect(await em.find(Doc)).toHaveLength(1);
  });

  it("still generates the uuid key when none is given", async () => {
    const created = await em.save(Doc, { title: "auto" });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("still treats a given auto-increment key as an existing row", async () => {
    await expect(em.save(Counter, { id: 999, hits: 1 })).rejects.toThrow(EntityNotFoundError);
    const created = await em.save(Counter, { hits: 1 });
    const updated = await em.save(Counter, { id: created.id, hits: 2 });
    expect(updated.hits).toBe(2);
  });
});
