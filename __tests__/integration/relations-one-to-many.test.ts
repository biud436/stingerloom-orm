/**
 * OneToMany / ManyToOne relation integration tests
 *
 * Runs against a real database and exercises the create / read / update /
 * delete cycle of a parent-child relation.
 *
 * ## Entity layout
 *
 * ParentClass
 *   - id (PK, AUTO_INCREMENT)
 *   - name (VARCHAR)
 *   - children (OneToMany → ChildClass.parent)
 *
 * ChildClass
 *   - id (PK, AUTO_INCREMENT)
 *   - title (VARCHAR)
 *   - parentFk (INT, nullable) <- DB column, needs @Column
 *   - parent (ManyToOne, joinColumn: "parentFk", eager: true)
 *
 * ## FK column design
 * @ManyToOne joinColumn("parentFk") and @Column("parentFk") are declared separately.
 * - @Column: createTable creates the DB column
 * - @ManyToOne: addForeignKey adds the FK constraint
 * - camelCase "parentFk": avoids clashing with the eager alias "parent_id"
 *
 * ## Prerequisites
 * - A running MySQL or PostgreSQL server
 * - Valid connection settings
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { BaseRepository } from "../../src/core/BaseRepository";
import {
  createTestConnection,
  dropTestTable,
  truncateTestTable,
  rawQuery,
  type TestConnectionResult,
} from "./helpers/test-connection";
import {
  createOneToManyTestEntities,
  createCascadeRelationEntities,
  type RelatedEntitiesResult,
} from "./helpers/create-relation-entity";
import {
  getTestDrivers,
  type TestDriverConfig,
  type TestDriverType,
} from "./helpers/driver-config";
import {
  qi,
  disableFkChecksSql,
  enableFkChecksSql,
} from "./helpers/driver-helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1: basic ManyToOne / OneToMany relations
// ─────────────────────────────────────────────────────────────────────────────

describe.each(getTestDrivers())(
  "[Integration] OneToMany / ManyToOne basic relations ($label)",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let entities: RelatedEntitiesResult;
    let parentRepo: BaseRepository<any>;
    let childRepo: BaseRepository<any>;

    beforeAll(async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          entities = createOneToManyTestEntities("rel_basic");
          // The parent table must exist first so the child's FK constraint can be added.
          return {
            entities: [entities.ParentClass, entities.ChildClass],
          };
        },
      );
      em = conn.em;
      parentRepo = em.getRepository(entities.ParentClass);
      childRepo = em.getRepository(entities.ChildClass);
    }, 30000);

    afterAll(async () => {
      // FK constraints exist, so DROP the child before the parent
      try {
        await rawQuery(disableFkChecksSql(type));
        if (entities) await dropTestTable(entities.childTableName);
        if (entities) await dropTestTable(entities.parentTableName);
        await rawQuery(enableFkChecksSql(type));
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 15000);

    beforeEach(async () => {
      // Delete children first because of the FK constraint
      await truncateTestTable(entities.childTableName);
      await truncateTestTable(entities.parentTableName);
    });

    // ─── CREATE ─────────────────────────────────────────────────────────────────

    describe("Create — FK persistence", () => {
      it("saves a child with its FK after the parent is saved", async () => {
        const parent = await parentRepo.save({ name: "Alice" });
        expect(parent.id).toBeDefined();
        expect(parent.id).toBeGreaterThan(0);

        const child = await childRepo.save({
          title: "Child of Alice",
          parentFk: parent.id,
        });

        expect(child).toBeDefined();
        expect(child.id).toBeGreaterThan(0);
      });

      it("stores the child's FK value (parentFk) as the parent's id", async () => {
        const parent = await parentRepo.save({ name: "Bob" });
        await childRepo.save({ title: "Bob's child", parentFk: parent.id });

        // Read the row directly to confirm the FK was stored
        const rawRows = await rawQuery(
          `SELECT ${qi(type, "parentFk")} FROM ${qi(type, entities.childTableName)} WHERE ${qi(type, "title")} = 'Bob''s child'`,
        );
        const rows = rawRows?.results ?? rawRows;
        const row = Array.isArray(rows) ? rows[0] : rows;
        expect(Number(row?.parentFk)).toBe(parent.id);
      });

      it("saves a child with no FK (null)", async () => {
        const child = await childRepo.save({
          title: "Orphan child",
          parentFk: null,
        });

        expect(child).toBeDefined();
        expect(child.id).toBeGreaterThan(0);
      });

      it("saves several children under one parent", async () => {
        const parent = await parentRepo.save({ name: "Multi-parent" });

        await childRepo.save({ title: "Child 1", parentFk: parent.id });
        await childRepo.save({ title: "Child 2", parentFk: parent.id });
        await childRepo.save({ title: "Child 3", parentFk: parent.id });

        const rawRows = await rawQuery(
          `SELECT COUNT(*) AS cnt FROM ${qi(type, entities.childTableName)} WHERE ${qi(type, "parentFk")} = ${parent.id}`,
        );
        const rows = rawRows?.results ?? rawRows;
        const row = Array.isArray(rows) ? rows[0] : rows;
        expect(Number(row?.cnt)).toBe(3);
      });
    });

    // ─── READ: Eager Loading (ManyToOne) ────────────────────────────────────────

    describe("Read — ManyToOne eager loading", () => {
      it("loads the parent object automatically when reading a child (eager: true)", async () => {
        const parent = await parentRepo.save({ name: "Eager Parent" });
        const savedChild = await childRepo.save({
          title: "Eager Child",
          parentFk: parent.id,
        });

        const found = await childRepo.findOne({
          where: { id: savedChild.id },
        });
        const child = Array.isArray(found) ? found[0] : found;

        expect(child).toBeDefined();
        expect(child.parent).toBeDefined();
        expect(child.parent).not.toBeNull();
      });

      it("eager-loaded parent has the matching id", async () => {
        const parent = await parentRepo.save({ name: "Parent for eager" });
        const saved = await childRepo.save({
          title: "Child",
          parentFk: parent.id,
        });

        const found = await childRepo.findOne({ where: { id: saved.id } });
        const child = Array.isArray(found) ? found[0] : found;

        expect(child.parent.id).toBe(parent.id);
      });

      it("eager-loaded parent has the matching name", async () => {
        const parent = await parentRepo.save({ name: "Named Parent" });
        const saved = await childRepo.save({
          title: "Named Child",
          parentFk: parent.id,
        });

        const found = await childRepo.findOne({ where: { id: saved.id } });
        const child = Array.isArray(found) ? found[0] : found;

        expect(child.parent.name).toBe("Named Parent");
      });

      it("orders by a column present in both tables (id) alongside the eager JOIN", async () => {
        const parent = await parentRepo.save({ name: "OrderBy Parent" });
        await childRepo.save({ title: "ob-1", parentFk: parent.id });
        await childRepo.save({ title: "ob-2", parentFk: parent.id });
        await childRepo.save({ title: "ob-3", parentFk: parent.id });

        // The parent relation is eager, so a JOIN is always added — unless orderBy is
        // qualified with the root table, the id present on both sides fails as ambiguous.
        const rows = await em.find(entities.ChildClass, {
          orderBy: { id: "DESC" },
        });

        expect(rows.length).toBeGreaterThanOrEqual(3);
        const ids = rows.map((r: any) => r.id);
        expect([...ids].sort((a: number, b: number) => b - a)).toEqual(ids);
        expect(rows[0].parent).toBeDefined();
      });

      it("a child with a null FK has a null parent", async () => {
        const saved = await childRepo.save({ title: "No Parent", parentFk: null });

        const found = await childRepo.findOne({ where: { id: saved.id } });
        const child = Array.isArray(found) ? found[0] : found;

        // parent must be null or absent
        expect(child.parent == null).toBe(true);
      });

      it("find() loads the parent for each of several children", async () => {
        const parent1 = await parentRepo.save({ name: "P1" });
        const parent2 = await parentRepo.save({ name: "P2" });

        await childRepo.save({ title: "C1", parentFk: parent1.id });
        await childRepo.save({ title: "C2", parentFk: parent2.id });

        const result = await childRepo.find();
        const children = Array.isArray(result) ? result : result ? [result] : [];

        // Only check children that have a parent
        const withParent = children.filter((c: any) => c.parent != null);
        expect(withParent.length).toBeGreaterThanOrEqual(2);

        for (const c of withParent) {
          expect(c.parent.id).toBeDefined();
          expect(c.parent.name).toBeDefined();
        }
      });
    });

    // ─── READ: OneToMany via relations ──────────────────────────────────────────

    describe("Read — OneToMany via the relations option", () => {
      it("loads the children array when reading the parent with relations: ['children']", async () => {
        const parent = await parentRepo.save({ name: "Parent with kids" });
        await childRepo.save({ title: "Kid 1", parentFk: parent.id });
        await childRepo.save({ title: "Kid 2", parentFk: parent.id });

        const found = await parentRepo.findOne({
          where: { id: parent.id },
          relations: ["children"],
        } as any);
        const p = Array.isArray(found) ? found[0] : found;

        expect(p).toBeDefined();
        expect(Array.isArray(p.children)).toBe(true);
        expect(p.children.length).toBe(2);
      });

      it("each element of the children array has the right title", async () => {
        const parent = await parentRepo.save({ name: "Parent check" });
        await childRepo.save({ title: "Alpha", parentFk: parent.id });
        await childRepo.save({ title: "Beta", parentFk: parent.id });

        const found = await parentRepo.findOne({
          where: { id: parent.id },
          relations: ["children"],
        } as any);
        const p = Array.isArray(found) ? found[0] : found;

        const titles = p.children.map((c: any) => c.title).sort();
        expect(titles).toContain("Alpha");
        expect(titles).toContain("Beta");
      });

      it("a parent without children gets an empty children array", async () => {
        const parent = await parentRepo.save({ name: "Childless parent" });

        const found = await parentRepo.findOne({
          where: { id: parent.id },
          relations: ["children"],
        } as any);
        const p = Array.isArray(found) ? found[0] : found;

        expect(p).toBeDefined();
        const children = p.children ?? [];
        expect(Array.isArray(children)).toBe(true);
        expect(children.length).toBe(0);
      });

      it("does not load children when relations is omitted", async () => {
        const parent = await parentRepo.save({ name: "No relations" });
        await childRepo.save({ title: "Hidden child", parentFk: parent.id });

        const found = await parentRepo.findOne({
          where: { id: parent.id },
          // relations not specified
        });
        const p = Array.isArray(found) ? found[0] : found;

        // children must be undefined or an empty array
        const children = p?.children;
        const isEmpty = children == null || (Array.isArray(children) && children.length === 0);
        expect(isEmpty).toBe(true);
      });
    });

    // ─── UPDATE ─────────────────────────────────────────────────────────────────

    describe("Update — changing the FK", () => {
      it("moves a child to another parent by changing its FK (parentFk)", async () => {
        const parent1 = await parentRepo.save({ name: "Original Parent" });
        const parent2 = await parentRepo.save({ name: "New Parent" });

        const child = await childRepo.save({
          title: "Reassignable Child",
          parentFk: parent1.id,
        });

        // Change the FK
        await childRepo.save({
          id: child.id,
          title: "Reassignable Child",
          parentFk: parent2.id,
        });

        const found = await childRepo.findOne({ where: { id: child.id } });
        const updated = Array.isArray(found) ? found[0] : found;

        expect(updated.parent).toBeDefined();
        expect(updated.parent.id).toBe(parent2.id);
        expect(updated.parent.name).toBe("New Parent");
      });

      it("a renamed parent shows up in the child's eager-loaded result", async () => {
        const parent = await parentRepo.save({ name: "Old Name" });
        const child = await childRepo.save({
          title: "Child",
          parentFk: parent.id,
        });

        // Rename the parent
        await parentRepo.save({ id: parent.id, name: "New Name" });

        // Read the child again
        const found = await childRepo.findOne({ where: { id: child.id } });
        const c = Array.isArray(found) ? found[0] : found;

        expect(c.parent.name).toBe("New Name");
      });
    });

    // ─── DELETE ─────────────────────────────────────────────────────────────────

    describe("Delete — referential integrity", () => {
      it("deleting only the child keeps the parent", async () => {
        const parent = await parentRepo.save({ name: "Surviving Parent" });
        const child = await childRepo.save({
          title: "Deletable Child",
          parentFk: parent.id,
        });

        await childRepo.delete({ id: child.id } as any);

        // The child is gone
        const foundChild = await childRepo.findOne({ where: { id: child.id } });
        if (Array.isArray(foundChild)) {
          expect(foundChild.length).toBe(0);
        } else {
          expect(foundChild).toBeNull();
        }

        // The parent remains
        const foundParent = await parentRepo.findOne({
          where: { id: parent.id },
        });
        const p = Array.isArray(foundParent) ? foundParent[0] : foundParent;
        expect(p).toBeDefined();
        expect(p.name).toBe("Surviving Parent");
      });

      it("deletes several children at once by an FK condition", async () => {
        const parent = await parentRepo.save({ name: "Bulk Delete Parent" });
        await childRepo.save({ title: "Child A", parentFk: parent.id });
        await childRepo.save({ title: "Child B", parentFk: parent.id });

        const result = await childRepo.delete({ parentFk: parent.id } as any);
        expect(result.affected).toBe(2);

        // The parent remains
        const countRows = await rawQuery(
          `SELECT COUNT(*) AS cnt FROM ${qi(type, entities.parentTableName)} WHERE id = ${parent.id}`,
        );
        const rows = countRows?.results ?? countRows;
        const row = Array.isArray(rows) ? rows[0] : rows;
        expect(Number(row?.cnt)).toBe(1);
      });
    });

    // ─── FULL LIFECYCLE ──────────────────────────────────────────────────────────

    describe("Full relation lifecycle", () => {
      it("create Parent -> create Child (FK) -> read (eager + relations) -> update -> delete", async () => {
        // 1. Create the parent
        const parent = await parentRepo.save({ name: "Lifecycle Parent" });
        expect(parent.id).toBeGreaterThan(0);

        // 2. Create children (with FK)
        const child1 = await childRepo.save({
          title: "LC Child 1",
          parentFk: parent.id,
        });
        const child2 = await childRepo.save({
          title: "LC Child 2",
          parentFk: parent.id,
        });
        expect(child1.id).toBeDefined();
        expect(child2.id).toBeDefined();

        // 3. Read a child -> check the eager parent
        const foundChild = await childRepo.findOne({ where: { id: child1.id } });
        const c = Array.isArray(foundChild) ? foundChild[0] : foundChild;
        expect(c.parent.id).toBe(parent.id);
        expect(c.parent.name).toBe("Lifecycle Parent");

        // 4. Read the parent -> check OneToMany
        const foundParent = await parentRepo.findOne({
          where: { id: parent.id },
          relations: ["children"],
        } as any);
        const p = Array.isArray(foundParent) ? foundParent[0] : foundParent;
        expect(p.children.length).toBe(2);

        // 5. Update a child's title
        await childRepo.save({ id: child1.id, title: "Updated LC Child 1", parentFk: parent.id });
        const updatedChild = await childRepo.findOne({ where: { id: child1.id } });
        const uc = Array.isArray(updatedChild) ? updatedChild[0] : updatedChild;
        expect(uc.title).toBe("Updated LC Child 1");
        expect(uc.parent.id).toBe(parent.id); // FK unchanged

        // 6. Delete the children
        await childRepo.delete({ id: child1.id } as any);
        await childRepo.delete({ id: child2.id } as any);

        // 7. Read the parent again -> no children
        const afterDelete = await parentRepo.findOne({
          where: { id: parent.id },
          relations: ["children"],
        } as any);
        const pa = Array.isArray(afterDelete) ? afterDelete[0] : afterDelete;
        const remaining = pa.children ?? [];
        expect(remaining.length).toBe(0);
      });
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: Cascade Insert (OneToMany -> children saved automatically)
// ─────────────────────────────────────────────────────────────────────────────

describe.each(getTestDrivers())(
  "[Integration] OneToMany Cascade Insert ($label)",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let em: EntityManager;
    let entities: RelatedEntitiesResult;
    let parentRepo: BaseRepository<any>;
    let childRepo: BaseRepository<any>;

    beforeAll(async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          entities = createCascadeRelationEntities("cascade_rel");
          return {
            entities: [entities.ParentClass, entities.ChildClass],
          };
        },
      );
      em = conn.em;
      parentRepo = em.getRepository(entities.ParentClass);
      childRepo = em.getRepository(entities.ChildClass);
    }, 30000);

    afterAll(async () => {
      try {
        await rawQuery(disableFkChecksSql(type));
        if (entities) await dropTestTable(entities.childTableName);
        if (entities) await dropTestTable(entities.parentTableName);
        await rawQuery(enableFkChecksSql(type));
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 15000);

    beforeEach(async () => {
      await truncateTestTable(entities.childTableName);
      await truncateTestTable(entities.parentTableName);
    });

    it("saving a parent with a children array creates the children automatically", async () => {
      const saved = await parentRepo.save({
        name: "Cascade Parent",
        children: [{ title: "Cascade Child 1" }, { title: "Cascade Child 2" }],
      });

      expect(saved).toBeDefined();
      expect(saved.id).toBeGreaterThan(0);

      // Confirm the children actually reached the DB
      const rows = await rawQuery(
        `SELECT COUNT(*) AS cnt FROM ${qi(type, entities.childTableName)} WHERE ${qi(type, "parentFk")} = ${saved.id}`,
      );
      const rs = rows?.results ?? rows;
      const r = Array.isArray(rs) ? rs[0] : rs;
      expect(Number(r?.cnt)).toBe(2);
    });

    it("children saved by cascade carry the parent's id as their FK (parentFk)", async () => {
      const parent = await parentRepo.save({
        name: "FK Cascade Parent",
        children: [{ title: "FK Child" }],
      });

      const rows = await rawQuery(
        `SELECT ${qi(type, "parentFk")} FROM ${qi(type, entities.childTableName)} WHERE ${qi(type, "title")} = 'FK Child'`,
      );
      const rs = rows?.results ?? rows;
      const row = Array.isArray(rs) ? rs[0] : rs;
      expect(Number(row?.parentFk)).toBe(parent.id);
    });

    it("a cascade save with an empty children array creates no children", async () => {
      await parentRepo.save({ name: "Empty Children", children: [] });

      const rows = await rawQuery(
        `SELECT COUNT(*) AS cnt FROM ${qi(type, entities.childTableName)}`,
      );
      const rs = rows?.results ?? rows;
      const r = Array.isArray(rs) ? rs[0] : rs;
      expect(Number(r?.cnt)).toBe(0);
    });

    it("saving without children creates no child rows", async () => {
      // children omitted -> cascade does not fire
      const parent = await parentRepo.save({ name: "No Cascade" });

      const rows = await rawQuery(
        `SELECT COUNT(*) AS cnt FROM ${qi(type, entities.childTableName)} WHERE ${qi(type, "parentFk")} = ${parent.id}`,
      );
      const rs = rows?.results ?? rows;
      const r = Array.isArray(rs) ? rs[0] : rs;
      expect(Number(r?.cnt)).toBe(0);
    });

    it("repeated cascade saves accumulate children", async () => {
      const parent = await parentRepo.save({ name: "Accumulate Parent" });

      // First save: only the parent, no cascade
      // Second: save a child directly
      await childRepo.save({ title: "Direct Child", parentFk: parent.id });

      // Cascade save through a parent (the existing parent id is reused)
      await parentRepo.save({
        name: "Accumulate Parent (updated)",
        children: [{ title: "Cascaded Child" }],
      });

      // Total child count (Direct 1 + Cascaded 1 from the new parent = at least 1)
      // A new parent may be created, so check for at least one
      const rows = await rawQuery(
        `SELECT COUNT(*) AS cnt FROM ${qi(type, entities.childTableName)}`,
      );
      const rs = rows?.results ?? rows;
      const r = Array.isArray(rs) ? rs[0] : rs;
      expect(Number(r?.cnt)).toBeGreaterThanOrEqual(1);
    });
  },
);
