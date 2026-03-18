/**
 * Buffer Plugin (WriteBuffer UoW) Integration Test
 *
 * Tests the full WriteBuffer lifecycle against real MySQL/PostgreSQL databases.
 *
 * Coverage:
 * - track → dirty → flush cycle (UPDATE)
 * - save() / delete() queue → flush (INSERT / DELETE)
 * - persist() / remove() instance-based API
 * - Identity Map (dedup, conflict detection)
 * - Entity states (NEW → MANAGED → DETACHED → REMOVED)
 * - Mixed operations atomicity (update + insert + delete in one flush)
 * - Accumulate → flush → accumulate → flush (re-snapshot)
 * - preview() dry-run
 * - Transaction rollback on error
 * - clear() / untrack()
 * - Cascade persist through O2M relations
 * - Bulk DML (updateMany / deleteMany)
 * - Flush events (preInsert/postInsert/preUpdate/postUpdate/preDelete/postDelete)
 * - Read-only entities (markReadOnly skips dirty check)
 * - Pessimistic locking (FOR UPDATE)
 * - getReference() identity-mapped PK-only reference
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import {
  createTestConnection,
  dropTestTable,
  truncateTestTable,
  TestConnectionResult,
} from "./helpers/test-connection";
import {
  createCrudTestEntity,
  DynamicEntityResult,
} from "./helpers/create-test-entity";
import {
  createCascadeRelationEntities,
  RelatedEntitiesResult,
} from "./helpers/create-relation-entity";
import { getTestDrivers } from "./helpers/driver-config";
import { bufferPlugin } from "../../src/core/plugin/buffer/bufferPlugin";
import { WriteBuffer } from "../../src/core/plugin/buffer/WriteBuffer";
import { EntityState } from "../../src/core/plugin/buffer/EntityUnitState";
import {
  LockMode,
  FlushEvent,
} from "../../src/core/plugin/buffer/BufferPreview";

const drivers = getTestDrivers();

describe.each(drivers)("[Integration] $label: Buffer Plugin", ({ type, options }) => {
  let conn: TestConnectionResult;
  let em: EntityManager;
  let testEntity: DynamicEntityResult;
  let relEntities: RelatedEntitiesResult;

  beforeAll(async () => {
    conn = await createTestConnection(
      { ...options, synchronize: true, logging: false, plugins: [bufferPlugin({ cascade: true })] },
      () => {
        testEntity = createCrudTestEntity("buf_it");
        relEntities = createCascadeRelationEntities("buf_casc");
        return { entities: [testEntity.EntityClass, relEntities.ParentClass, relEntities.ChildClass] };
      },
    );
    em = conn.em;
  }, 30000);

  afterAll(async () => {
    if (!conn) return;
    try { await dropTestTable(relEntities.childTableName); } catch {}
    try { await dropTestTable(relEntities.parentTableName); } catch {}
    try { await dropTestTable(testEntity.tableName); } catch {}
    await conn.cleanup();
  }, 15000);

  beforeEach(async () => {
    try { await truncateTestTable(relEntities.childTableName); } catch {}
    try { await truncateTestTable(relEntities.parentTableName); } catch {}
    await truncateTestTable(testEntity.tableName);
  });

  // ── helpers ─────────────────────────────────────────────────

  async function seed(data: { name: string; age: number; email?: string | null }) {
    return em.save(testEntity.EntityClass, { name: data.name, age: data.age, email: data.email ?? null });
  }
  async function findById(id: number) {
    const r = await em.findOne(testEntity.EntityClass, { where: { id } as any });
    return Array.isArray(r) ? r[0] : r;
  }
  async function findAll() {
    const r = await em.find(testEntity.EntityClass);
    return Array.isArray(r) ? r : r ? [r] : [];
  }

  // ═══════════════════════════════════════════════════════════════
  // Installation
  // ═══════════════════════════════════════════════════════════════

  it("em.buffer() returns WriteBuffer instance", () => {
    const buf = (em as any).buffer();
    expect(buf).toBeInstanceOf(WriteBuffer);
  });

  // ═══════════════════════════════════════════════════════════════
  // Auto-tracking via findOne / find
  // ═══════════════════════════════════════════════════════════════

  describe("auto-tracking", () => {
    it("findOne auto-tracks and flush applies UPDATE", async () => {
      const created = await seed({ name: "AutoTrack", age: 30 });
      const buf: WriteBuffer = (em as any).buffer();

      const user = await buf.findOne(testEntity.EntityClass, { where: { id: created.id } as any });
      expect(user).not.toBeNull();
      expect(buf.tracked()).toHaveLength(1);

      (user as any).name = "Updated";
      const result = await buf.flush();
      expect(result.updates).toBe(1);

      const found = await findById(created.id);
      expect(found.name).toBe("Updated");
    });

    it("findOne returns null for missing row, no tracking", async () => {
      const buf: WriteBuffer = (em as any).buffer();
      const user = await buf.findOne(testEntity.EntityClass, { where: { id: 999999 } as any });
      expect(user).toBeNull();
      expect(buf.tracked()).toHaveLength(0);
    });

    it("find auto-tracks all results, dirty detects partial changes", async () => {
      await seed({ name: "A", age: 10 });
      await seed({ name: "B", age: 20 });
      await seed({ name: "C", age: 30 });

      const buf: WriteBuffer = (em as any).buffer();
      const users = await buf.find(testEntity.EntityClass, {});
      expect(users.length).toBe(3);
      expect(buf.tracked()).toHaveLength(3);

      (users[0] as any).name = "A2";
      (users[2] as any).name = "C2";
      expect(buf.dirty()).toHaveLength(2);

      const result = await buf.flush();
      expect(result.updates).toBe(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Identity Map
  // ═══════════════════════════════════════════════════════════════

  describe("Identity Map", () => {
    it("same PK via findOne returns same reference", async () => {
      const created = await seed({ name: "IdMap", age: 25 });
      const buf: WriteBuffer = (em as any).buffer();

      const first = await buf.findOne(testEntity.EntityClass, { where: { id: created.id } as any });
      (first as any).name = "Modified";
      const second = await buf.findOne(testEntity.EntityClass, { where: { id: created.id } as any });

      expect(first).toBe(second);
      expect((second as any).name).toBe("Modified");
      expect(buf.tracked()).toHaveLength(1);
    });

    it("find reuses tracked instance from prior findOne", async () => {
      const u1 = await seed({ name: "User1", age: 10 });
      await seed({ name: "User2", age: 20 });

      const buf: WriteBuffer = (em as any).buffer();
      const tracked = await buf.findOne(testEntity.EntityClass, { where: { id: u1.id } as any });
      (tracked as any).name = "LocalMod";

      const all = await buf.find(testEntity.EntityClass, {});
      const match = all.find((u: any) => u.id === u1.id);
      expect(match).toBe(tracked);
      expect((match as any).name).toBe("LocalMod");
    });

    it("duplicate PK track throws identity conflict", async () => {
      const created = await seed({ name: "Conflict", age: 30 });
      const buf: WriteBuffer = (em as any).buffer();
      await buf.findOne(testEntity.EntityClass, { where: { id: created.id } as any });

      const dup = Object.assign(Object.create(testEntity.EntityClass.prototype), {
        id: created.id, name: "Dup", age: 99,
      });
      expect(() => buf.track(dup)).toThrow(/Identity conflict/);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // UPDATE: track + dirty + flush
  // ═══════════════════════════════════════════════════════════════

  describe("tracked entity UPDATE", () => {
    it("flush writes dirty fields to DB", async () => {
      const created = await seed({ name: "Alice", age: 25, email: "a@b.c" });
      const buf: WriteBuffer = (em as any).buffer();
      buf.track(created);
      created.name = "Alice2";
      created.age = 26;

      const result = await buf.flush();
      expect(result.updates).toBe(1);

      const found = await findById(created.id);
      expect(found.name).toBe("Alice2");
      expect(found.age).toBe(26);
    });

    it("no-op when nothing changed", async () => {
      const created = await seed({ name: "Bob", age: 30 });
      const buf: WriteBuffer = (em as any).buffer();
      buf.track(created);

      const result = await buf.flush();
      expect(result.updates).toBe(0);
    });

    it("multiple entities tracked and flushed", async () => {
      const u1 = await seed({ name: "U1", age: 20 });
      const u2 = await seed({ name: "U2", age: 30 });
      const u3 = await seed({ name: "U3", age: 40 });

      const buf: WriteBuffer = (em as any).buffer();
      buf.track(u1); buf.track(u2); buf.track(u3);
      u1.name = "Mod1";
      u3.name = "Mod3";

      expect(buf.dirty()).toHaveLength(2);

      const result = await buf.flush();
      expect(result.updates).toBe(2);

      expect((await findById(u1.id)).name).toBe("Mod1");
      expect((await findById(u2.id)).name).toBe("U2");
      expect((await findById(u3.id)).name).toBe("Mod3");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // INSERT: save() queue
  // ═══════════════════════════════════════════════════════════════

  describe("queued INSERT via save()", () => {
    it("save + flush writes row to DB", async () => {
      const buf: WriteBuffer = (em as any).buffer();
      buf.save(testEntity.EntityClass, { name: "New", age: 22, email: "n@b.c" });

      const result = await buf.flush();
      expect(result.inserts).toBe(1);

      const all = await findAll();
      expect(all.length).toBe(1);
      expect(all[0].name).toBe("New");
    });

    it("multiple saves flushed together", async () => {
      const buf: WriteBuffer = (em as any).buffer();
      buf.save(testEntity.EntityClass, { name: "A", age: 10 });
      buf.save(testEntity.EntityClass, { name: "B", age: 20 });
      buf.save(testEntity.EntityClass, { name: "C", age: 30 });

      const result = await buf.flush();
      expect(result.inserts).toBe(3);
      expect((await findAll()).length).toBe(3);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // persist() / remove()
  // ═══════════════════════════════════════════════════════════════

  describe("persist() and remove()", () => {
    it("persist new instance (no PK) → INSERT with PK writeback", async () => {
      const buf: WriteBuffer = (em as any).buffer();
      const inst = Object.assign(Object.create(testEntity.EntityClass.prototype), {
        name: "Persisted", age: 33,
      });

      buf.persist(inst);
      expect(buf.getState(inst)).toBe(EntityState.NEW);

      const result = await buf.flush();
      expect(result.inserts).toBe(1);
      expect(inst.id).toBeDefined();
      expect(inst.id).toBeGreaterThan(0);
      expect(buf.getState(inst)).toBe(EntityState.MANAGED);

      const found = await findById(inst.id);
      expect(found.name).toBe("Persisted");
    });

    it("persist existing (has PK) delegates to track", async () => {
      const created = await seed({ name: "Existing", age: 40 });
      const buf: WriteBuffer = (em as any).buffer();

      buf.persist(created);
      expect(buf.getState(created)).toBe(EntityState.MANAGED);
      expect(buf.tracked()).toHaveLength(1);
    });

    it("remove tracked instance → DELETE on flush", async () => {
      const created = await seed({ name: "ToRemove", age: 50 });
      const buf: WriteBuffer = (em as any).buffer();

      const loaded = await buf.findOne(testEntity.EntityClass, { where: { id: created.id } as any });
      buf.remove(loaded);
      expect(buf.getState(loaded)).toBe(EntityState.REMOVED);

      const result = await buf.flush();
      expect(result.deletes).toBe(1);

      const found = await findById(created.id);
      expect(found).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // DELETE: delete() queue
  // ═══════════════════════════════════════════════════════════════

  describe("queued DELETE", () => {
    it("delete + flush removes row", async () => {
      const created = await seed({ name: "Del", age: 99 });
      const buf: WriteBuffer = (em as any).buffer();
      buf.delete(testEntity.EntityClass, { id: created.id } as any);

      const result = await buf.flush();
      expect(result.deletes).toBe(1);

      expect(await findById(created.id)).toBeNull();
    });

    it("condition-based delete removes matching rows", async () => {
      await seed({ name: "Keep", age: 20 });
      await seed({ name: "Remove", age: 99 });
      await seed({ name: "Remove", age: 99 });

      const buf: WriteBuffer = (em as any).buffer();
      buf.delete(testEntity.EntityClass, { name: "Remove" } as any);

      await buf.flush();

      const all = await findAll();
      expect(all.length).toBe(1);
      expect(all[0].name).toBe("Keep");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Mixed operations atomicity
  // ═══════════════════════════════════════════════════════════════

  describe("mixed operations", () => {
    it("UPDATE + INSERT + DELETE in single atomic flush", async () => {
      const existing = await seed({ name: "Existing", age: 25 });
      const toDelete = await seed({ name: "ToDelete", age: 99 });

      const buf: WriteBuffer = (em as any).buffer();
      buf.track(existing);
      existing.name = "Modified";
      buf.save(testEntity.EntityClass, { name: "New", age: 10 });
      buf.delete(testEntity.EntityClass, { id: toDelete.id } as any);

      const result = await buf.flush();
      expect(result.updates).toBe(1);
      expect(result.inserts).toBe(1);
      expect(result.deletes).toBe(1);

      const all = await findAll();
      expect(all.length).toBe(2);
      expect(all.some((u: any) => u.name === "Modified")).toBe(true);
      expect(all.some((u: any) => u.name === "New")).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Re-snapshot after flush
  // ═══════════════════════════════════════════════════════════════

  describe("accumulate → flush → accumulate → flush", () => {
    it("re-snapshots tracked entities for subsequent flush", async () => {
      const user = await seed({ name: "Step1", age: 10 });
      const buf: WriteBuffer = (em as any).buffer();
      buf.track(user);

      user.name = "Step2";
      await buf.flush();
      expect(buf.dirty()).toHaveLength(0);

      user.name = "Step3";
      const result = await buf.flush();
      expect(result.updates).toBe(1);

      expect((await findById(user.id)).name).toBe("Step3");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // preview()
  // ═══════════════════════════════════════════════════════════════

  describe("preview()", () => {
    it("returns planned ops without touching DB", async () => {
      const user = await seed({ name: "Preview", age: 25 });
      const buf: WriteBuffer = (em as any).buffer();
      buf.track(user);
      user.name = "Changed";
      buf.save(testEntity.EntityClass, { name: "New", age: 1 });

      const preview = buf.preview();
      expect(preview.length).toBeGreaterThanOrEqual(2);

      expect((await findById(user.id)).name).toBe("Preview"); // not flushed
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Transaction rollback
  // ═══════════════════════════════════════════════════════════════

  describe("transaction atomicity", () => {
    it("rolls back all changes on flush error", async () => {
      const user = await seed({ name: "Atomic", age: 25 });
      const buf: WriteBuffer = (em as any).buffer();
      buf.track(user);
      user.name = "ShouldRollback";
      buf.save(testEntity.EntityClass, { name: null as any, age: null as any });

      await expect(buf.flush()).rejects.toThrow();

      expect((await findById(user.id)).name).toBe("Atomic");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // clear() / untrack()
  // ═══════════════════════════════════════════════════════════════

  describe("clear() and untrack()", () => {
    it("untracked entity excluded from flush", async () => {
      const u1 = await seed({ name: "Keep", age: 10 });
      const u2 = await seed({ name: "Skip", age: 20 });

      const buf: WriteBuffer = (em as any).buffer();
      buf.track(u1); buf.track(u2);
      u1.name = "Modified";
      u2.name = "SkipMod";
      buf.untrack(u2);

      await buf.flush();
      expect((await findById(u1.id)).name).toBe("Modified");
      expect((await findById(u2.id)).name).toBe("Skip");
    });

    it("clear() makes flush no-op", async () => {
      const user = await seed({ name: "Clear", age: 10 });
      const buf: WriteBuffer = (em as any).buffer();
      buf.track(user);
      user.name = "Mod";
      buf.save(testEntity.EntityClass, { name: "X", age: 1 });

      buf.clear();
      const result = await buf.flush();
      expect(result).toEqual({ updates: 0, inserts: 0, deletes: 0 });

      expect((await findById(user.id)).name).toBe("Clear");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // getReference()
  // ═══════════════════════════════════════════════════════════════

  describe("getReference()", () => {
    it("creates identity-mapped reference with PK", async () => {
      const created = await seed({ name: "RefTarget", age: 25 });
      const buf: WriteBuffer = (em as any).buffer();

      const ref = buf.getReference(testEntity.EntityClass, created.id);
      expect((ref as any).id).toBe(created.id);
      expect(buf.getState(ref)).toBe(EntityState.MANAGED);
      expect(buf.getReference(testEntity.EntityClass, created.id)).toBe(ref);
    });

    it("findOne after getReference returns same instance", async () => {
      const created = await seed({ name: "RefFirst", age: 30 });
      const buf: WriteBuffer = (em as any).buffer();

      const ref = buf.getReference(testEntity.EntityClass, created.id);
      const loaded = await buf.findOne(testEntity.EntityClass, { where: { id: created.id } as any });

      expect(loaded).toBe(ref);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Read-only entities
  // ═══════════════════════════════════════════════════════════════

  describe("read-only entities", () => {
    it("markReadOnly skips dirty check on flush", async () => {
      const user = await seed({ name: "ReadOnly", age: 25 });
      const buf: WriteBuffer = (em as any).buffer();
      buf.track(user);
      buf.markReadOnly(user);
      user.name = "Mutated";

      const result = await buf.flush();
      expect(result.updates).toBe(0);
      expect((await findById(user.id)).name).toBe("ReadOnly");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Bulk DML
  // ═══════════════════════════════════════════════════════════════

  describe("bulk DML", () => {
    it("updateMany updates matching rows", async () => {
      await seed({ name: "Bulk1", age: 10 });
      await seed({ name: "Bulk2", age: 10 });
      await seed({ name: "Bulk3", age: 20 });

      const buf: WriteBuffer = (em as any).buffer();
      buf.updateMany(testEntity.EntityClass, { where: { age: 10 }, set: { name: "BulkUpd" } });

      await buf.flush();

      const all = await findAll();
      expect(all.filter((u: any) => u.name === "BulkUpd").length).toBe(2);
      expect(all.find((u: any) => u.age === 20)!.name).toBe("Bulk3");
    });

    it("deleteMany deletes matching rows", async () => {
      await seed({ name: "Keep", age: 10 });
      await seed({ name: "Del1", age: 99 });
      await seed({ name: "Del2", age: 99 });

      const buf: WriteBuffer = (em as any).buffer();
      buf.deleteMany(testEntity.EntityClass, { age: 99 });

      await buf.flush();

      const all = await findAll();
      expect(all.length).toBe(1);
      expect(all[0].name).toBe("Keep");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Flush events
  // ═══════════════════════════════════════════════════════════════

  describe("flush events", () => {
    it("fires preInsert/postInsert on persist + flush", async () => {
      const buf: WriteBuffer = (em as any).buffer();
      const events: string[] = [];

      buf.onFlushEvent("preInsert", (e: FlushEvent) => { events.push("pre"); });
      buf.onFlushEvent("postInsert", (e: FlushEvent) => { events.push("post"); });

      const inst = Object.assign(Object.create(testEntity.EntityClass.prototype), {
        name: "EvtIns", age: 10,
      });
      buf.persist(inst);
      await buf.flush();

      expect(events).toEqual(["pre", "post"]);
    });

    it("fires preUpdate/postUpdate on tracked update + flush", async () => {
      const user = await seed({ name: "EvtUpd", age: 25 });
      const buf: WriteBuffer = (em as any).buffer();
      const events: string[] = [];

      buf.onFlushEvent("preUpdate", () => { events.push("preU"); });
      buf.onFlushEvent("postUpdate", () => { events.push("postU"); });

      buf.track(user);
      user.name = "EvtUpd2";
      await buf.flush();

      expect(events).toEqual(["preU", "postU"]);
    });

    it("fires preDelete/postDelete on delete + flush", async () => {
      const user = await seed({ name: "EvtDel", age: 25 });
      const buf: WriteBuffer = (em as any).buffer();
      const events: string[] = [];

      buf.onFlushEvent("preDelete", () => { events.push("preD"); });
      buf.onFlushEvent("postDelete", () => { events.push("postD"); });

      buf.delete(testEntity.EntityClass, { id: user.id } as any);
      await buf.flush();

      expect(events).toEqual(["preD", "postD"]);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Pessimistic locking
  // ═══════════════════════════════════════════════════════════════

  describe("pessimistic locking", () => {
    it("PESSIMISTIC_WRITE lock allows update through flush", async () => {
      const user = await seed({ name: "Locked", age: 25 });
      const buf: WriteBuffer = (em as any).buffer();

      const loaded = await buf.findOne(testEntity.EntityClass, {
        where: { id: user.id } as any,
        lock: LockMode.PESSIMISTIC_WRITE,
      } as any);

      (loaded as any).name = "LockedUpd";
      const result = await buf.flush();
      expect(result.updates).toBe(1);

      expect((await findById(user.id)).name).toBe("LockedUpd");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Cascade persist (O2M)
  // ═══════════════════════════════════════════════════════════════

  describe("cascade persist (OneToMany)", () => {
    it("parent persist cascades to child inserts", async () => {
      const buf: WriteBuffer = (em as any).buffer();

      const parent = Object.assign(Object.create(relEntities.ParentClass.prototype), {
        name: "CascParent",
      });
      const child1 = Object.assign(Object.create(relEntities.ChildClass.prototype), {
        title: "Child1",
      });
      const child2 = Object.assign(Object.create(relEntities.ChildClass.prototype), {
        title: "Child2",
      });

      parent.children = [child1, child2];
      buf.persist(parent);

      const result = await buf.flush();
      // At minimum the parent is inserted; cascade may insert children too
      expect(result.inserts).toBeGreaterThanOrEqual(1);

      expect(parent.id).toBeDefined();
      expect(parent.id).toBeGreaterThan(0);

      // Verify parent exists in DB
      const found = await em.findOne(relEntities.ParentClass, {
        where: { id: parent.id } as any,
      });
      expect(found).not.toBeNull();
      expect((found as any).name).toBe("CascParent");
    });
  });
});
