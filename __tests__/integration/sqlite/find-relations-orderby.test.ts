/**
 * relations JOIN + orderBy on a column name that exists on BOTH tables.
 *
 * Every practical entity pair shares column names (id, createdAt, ...), and
 * find() qualifies select/where/groupBy/soft-delete/tenant references with the
 * root table when eager joins are present — but orderBy was emitted
 * unqualified, so `em.find(Child, { relations: ["parent"], orderBy: { id } })`
 * died with "ambiguous column name: id" (surfaced by examples/vanilla-todo-
 * sqlite). Regression coverage for the orderBy qualification (V3-T0-1).
 */
import "reflect-metadata";
import { Entity } from "../../../src/decorators/Entity";
import { Column } from "../../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../../src/decorators/ManyToOne";
import { CreateTimestamp } from "../../../src/decorators/CreateTimestamp";
import { createTestEntityManager } from "../../../src/testing/createTestEntityManager";
import { EntityManager } from "../../../src/core/EntityManager";

@Entity({ name: "fro_parents" })
class FroParent {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 120 })
  name!: string;

  @CreateTimestamp()
  createdAt!: Date;
}

@Entity({ name: "fro_children" })
class FroChild {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 120 })
  title!: string;

  @Column({ type: "int" })
  parentId!: number;

  @ManyToOne(() => FroParent, (e: FroParent) => e.id, { joinColumn: "parentId" })
  parent!: FroParent;

  @CreateTimestamp()
  createdAt!: Date;
}

describe("[Integration] SQLite: find() relations + orderBy on shared column names", () => {
  let em: EntityManager;

  beforeAll(async () => {
    em = await createTestEntityManager({ entities: [FroParent, FroChild] });

    const parent = await em.save(FroParent, { name: "p1" });
    await em.save(FroChild, { title: "c-one", parentId: parent.id });
    await em.save(FroChild, { title: "c-two", parentId: parent.id });
    await em.save(FroChild, { title: "c-three", parentId: parent.id });
  });

  afterAll(async () => {
    await (em as unknown as { destroy?: () => Promise<void> }).destroy?.();
  });

  it("orders by a shared column (id) while eager-joining the relation", async () => {
    const rows = await em.find(FroChild, {
      relations: ["parent"],
      orderBy: { id: "DESC" },
    });

    expect(rows.map((r) => r.title)).toEqual(["c-three", "c-two", "c-one"]);
    expect(rows[0].parent?.name).toBe("p1");
  });

  it("orders by a shared timestamp column (createdAt) with the relation joined", async () => {
    const rows = await em.find(FroChild, {
      relations: ["parent"],
      orderBy: { createdAt: "ASC", id: "ASC" },
    });

    expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it("where on a shared column with the relation joined keeps working", async () => {
    const rows = await em.find(FroChild, {
      relations: ["parent"],
      where: { id: 2 },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("c-two");
    expect(rows[0].parent?.id).toBe(1);
  });

  it("orderBy without relations is unaffected", async () => {
    const rows = await em.find(FroChild, { orderBy: { id: "ASC" } });
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
  });
});
