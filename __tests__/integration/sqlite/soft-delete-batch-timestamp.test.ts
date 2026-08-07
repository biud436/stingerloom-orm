/**
 * SQLite In-Memory: Soft Delete, Batch Operations, Create/Update Timestamps
 *
 * Three features tested against SQLite in-memory:
 * 1. @DeletedAt -- softDelete(), auto-filtering, withDeleted, restore()
 * 2. Batch Operations -- insertMany(), saveMany(), deleteMany(), count(), sum()
 * 3. @CreateTimestamp / @UpdateTimestamp -- INSERT/UPDATE auto-timestamp
 *
 * NOTE on `affected` counts:
 * SQLite's transaction session returns `{ results: { changes: N }, fields: null }`
 * but EntityManager reads `queryResult.rowCount` (PostgreSQL pattern), which is
 * undefined for SQLite. Therefore `affected` is always 0 on SQLite for
 * softDelete/restore/delete/deleteMany. Tests verify data state instead.
 */

import "reflect-metadata";
import {
  createTestConnection,
  type TestConnectionResult,
} from "../helpers/test-connection";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  DeletedAt,
  DELETED_AT_TOKEN,
  CreateTimestamp,
  UpdateTimestamp,
} from "../../../src";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";
import { DatabaseClient } from "../../../src/DatabaseClient";

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function shortTableName(prefix: string): string {
  return `${prefix}_${Date.now().toString().slice(-7)}`;
}

function clearScanners(): void {
  getScannerInstance(ColumnScanner).clear();
}

// ─────────────────────────────────────────────────────────
// 1. Soft Delete
// ─────────────────────────────────────────────────────────

describe("[Integration] SQLite: Soft Delete", () => {
  let conn: TestConnectionResult;
  let SdEntity: new () => any;
  let tableName: string;

  beforeAll(async () => {
    tableName = shortTableName("sd");

    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: false,
        logging: false,
      },
      () => {
        clearScanners();

        const DC = class {} as any;
        Object.defineProperty(DC, "name", { value: tableName });

        // id
        Reflect.defineMetadata("design:type", Number, DC.prototype, "id");
        PrimaryGeneratedColumn()(DC.prototype, "id");

        // name
        Reflect.defineMetadata("design:type", String, DC.prototype, "name");
        Column()(DC.prototype, "name");

        // age
        Reflect.defineMetadata("design:type", Number, DC.prototype, "age");
        Column({ type: "int" })(DC.prototype, "age");

        // deletedAt -- DeletedAt() internally calls Column({ type: "datetime", nullable: true })
        Reflect.defineMetadata("design:type", Date, DC.prototype, "deletedAt");
        DeletedAt()(DC.prototype, "deletedAt");

        Entity()(DC);
        SdEntity = DC;
        return { entities: [DC] };
      },
    );

    // Manual CREATE TABLE
    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(`
      CREATE TABLE IF NOT EXISTS "${tableName}" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "name" TEXT NOT NULL,
        "age" INTEGER NOT NULL,
        "deletedAt" TEXT
      )
    `);
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  beforeEach(async () => {
    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(`DELETE FROM "${tableName}"`);
  });

  it("softDelete() should mark the entity as deleted", async () => {
    const repo = conn.em.getRepository(SdEntity);
    const saved = await repo.save({ name: "Alice", age: 25 });

    const result = await repo.softDelete({ id: saved.id } as any);

    expect(result).toBeDefined();

    // Verify via raw query that deletedAt is now set
    const connector = DatabaseClient.getInstance().getConnection();
    const rows = await connector.query(
      `SELECT "deletedAt" FROM "${tableName}" WHERE "id" = ${saved.id}`,
    );
    expect(rows[0].deletedAt).not.toBeNull();
  });

  it("soft-deleted entity should be excluded from find()", async () => {
    const repo = conn.em.getRepository(SdEntity);
    const saved = await repo.save({ name: "Bob", age: 30 });
    await repo.softDelete({ id: saved.id } as any);

    const found = await repo.find();
    const items = Array.isArray(found) ? found : found ? [found] : [];

    const names = items.map((i: any) => i.name);
    expect(names).not.toContain("Bob");
  });

  it("soft-deleted entity should be excluded from findOne()", async () => {
    const repo = conn.em.getRepository(SdEntity);
    const saved = await repo.save({ name: "Charlie", age: 35 });
    await repo.softDelete({ id: saved.id } as any);

    const found = await repo.findOne({ where: { id: saved.id } });
    if (Array.isArray(found)) {
      expect(found.length).toBe(0);
    } else {
      expect(found).toBeNull();
    }
  });

  it("find() should return only non-deleted entities when mixed", async () => {
    const repo = conn.em.getRepository(SdEntity);
    await repo.save({ name: "Visible1", age: 20 });
    const toDelete = await repo.save({ name: "Deleted1", age: 22 });
    await repo.save({ name: "Visible2", age: 24 });

    await repo.softDelete({ id: toDelete.id } as any);

    const found = await repo.find();
    const items = Array.isArray(found) ? found : found ? [found] : [];

    expect(items.length).toBe(2);
    const names = items.map((i: any) => i.name);
    expect(names).toContain("Visible1");
    expect(names).toContain("Visible2");
    expect(names).not.toContain("Deleted1");
  });

  it("withDeleted: true should include soft-deleted entities", async () => {
    const repo = conn.em.getRepository(SdEntity);
    const saved = await repo.save({ name: "Recoverable", age: 28 });
    await repo.softDelete({ id: saved.id } as any);

    const found = await repo.find({ withDeleted: true } as any);
    const items = Array.isArray(found) ? found : found ? [found] : [];

    const names = items.map((i: any) => i.name);
    expect(names).toContain("Recoverable");
  });

  // ── #351: aggregate paths must honor @DeletedAt like find() ──────────
  it("count() should exclude soft-deleted rows by default (#351)", async () => {
    const repo = conn.em.getRepository(SdEntity);
    await repo.save({ name: "Live1", age: 20 });
    await repo.save({ name: "Live2", age: 21 });
    const trashed = await repo.save({ name: "Trashed", age: 22 });
    await repo.softDelete({ id: trashed.id } as any);

    expect(await conn.em.count(SdEntity)).toBe(2);
  });

  it("count() with withDeleted=true should include soft-deleted rows (#351)", async () => {
    const repo = conn.em.getRepository(SdEntity);
    await repo.save({ name: "Live1", age: 20 });
    const trashed = await repo.save({ name: "Trashed", age: 22 });
    await repo.softDelete({ id: trashed.id } as any);

    expect(await conn.em.count(SdEntity, undefined, true)).toBe(2);
  });

  it("exists() should not see a soft-deleted row by default (#351)", async () => {
    const repo = conn.em.getRepository(SdEntity);
    const trashed = await repo.save({ name: "Ghost", age: 99 });
    await repo.softDelete({ id: trashed.id } as any);

    expect(await conn.em.exists(SdEntity, { id: trashed.id } as any)).toBe(false);
    expect(
      await conn.em.exists(SdEntity, { id: trashed.id } as any, true),
    ).toBe(true);
  });

  it("findAndCount() should return a consistent [rows, count] tuple (#351)", async () => {
    const repo = conn.em.getRepository(SdEntity);
    await repo.save({ name: "Live1", age: 20 });
    await repo.save({ name: "Live2", age: 21 });
    const trashed = await repo.save({ name: "Trashed", age: 22 });
    await repo.softDelete({ id: trashed.id } as any);

    const [rows, total] = await conn.em.findAndCount(SdEntity, {});
    // The bug: rows excluded the trashed row but count included it (3),
    // so rows.length (2) !== total (3). They must agree.
    expect(rows.length).toBe(2);
    expect(total).toBe(2);

    const [allRows, allTotal] = await conn.em.findAndCount(SdEntity, {
      withDeleted: true,
    } as any);
    expect(allRows.length).toBe(3);
    expect(allTotal).toBe(3);
  });

  it("restore() should make entity visible again in find()", async () => {
    const repo = conn.em.getRepository(SdEntity);
    const saved = await repo.save({ name: "Restorable", age: 40 });

    await repo.softDelete({ id: saved.id } as any);

    // Confirm hidden
    const afterDelete = await repo.findOne({ where: { id: saved.id } });
    if (Array.isArray(afterDelete)) {
      expect(afterDelete.length).toBe(0);
    } else {
      expect(afterDelete).toBeNull();
    }

    // Restore
    await repo.restore({ id: saved.id } as any);

    // Confirm visible again
    const afterRestore = await repo.findOne({ where: { id: saved.id } });
    const item = Array.isArray(afterRestore) ? afterRestore[0] : afterRestore;
    expect(item).toBeDefined();
    expect(item).not.toBeNull();
    expect(item.name).toBe("Restorable");
  });

  it("full lifecycle: Create -> SoftDelete -> Restore -> HardDelete", async () => {
    const repo = conn.em.getRepository(SdEntity);

    // 1. Create
    const created = await repo.save({ name: "Lifecycle", age: 25 });
    expect(created.id).toBeDefined();

    // 2. Soft Delete
    await repo.softDelete({ id: created.id } as any);

    // 3. Invisible in normal query
    const afterSoft = await repo.findOne({ where: { id: created.id } });
    if (Array.isArray(afterSoft)) {
      expect(afterSoft.length).toBe(0);
    } else {
      expect(afterSoft).toBeNull();
    }

    // 4. Restore
    await repo.restore({ id: created.id } as any);

    // 5. Visible again
    const afterRestore = await repo.findOne({ where: { id: created.id } });
    const restored = Array.isArray(afterRestore) ? afterRestore[0] : afterRestore;
    expect(restored).toBeDefined();
    expect(restored).not.toBeNull();
    expect(restored.name).toBe("Lifecycle");

    // 6. Hard Delete
    await repo.delete({ id: created.id } as any);

    // 7. Gone even with withDeleted
    const afterHard = await repo.findOne({
      where: { id: created.id },
      withDeleted: true,
    } as any);
    if (Array.isArray(afterHard)) {
      expect(afterHard.length).toBe(0);
    } else {
      expect(afterHard).toBeNull();
    }
  });

  it("softDelete with condition should delete multiple matching entities", async () => {
    const repo = conn.em.getRepository(SdEntity);
    await repo.save({ name: "Same", age: 50 });
    await repo.save({ name: "Same", age: 50 });
    await repo.save({ name: "Different", age: 60 });

    await repo.softDelete({ name: "Same" } as any);

    const found = await repo.find();
    const items = Array.isArray(found) ? found : found ? [found] : [];
    expect(items.length).toBe(1);
    expect(items[0].name).toBe("Different");
  });

  // ── opposite-state predicates: softDelete/restore only touch the right rows ──
  it("re-soft-deleting a broader set preserves an already-deleted row's timestamp", async () => {
    const repo = conn.em.getRepository(SdEntity);
    const a = await repo.save({ name: "Dup", age: 88 });
    const b = await repo.save({ name: "Dup", age: 88 });

    const connector = DatabaseClient.getInstance().getConnection();
    // Simulate A having been soft-deleted earlier with a known sentinel value.
    await connector.query(
      `UPDATE "${tableName}" SET "deletedAt" = '2020-01-01 00:00:00' WHERE "id" = ${a.id}`,
    );

    // Broader soft delete matching BOTH the already-deleted A and the active B.
    await repo.softDelete({ name: "Dup" } as any);

    const rows = await connector.query(
      `SELECT "id", "deletedAt" FROM "${tableName}" WHERE "name" = 'Dup' ORDER BY "id"`,
    );
    const rowA = rows.find((r: any) => r.id === a.id);
    const rowB = rows.find((r: any) => r.id === b.id);

    // A keeps its original timestamp — it was already deleted, so the
    // deleted_at IS NULL predicate excludes it from the restamp.
    expect(rowA.deletedAt).toBe("2020-01-01 00:00:00");
    // B is newly soft-deleted (was active, so it WAS stamped).
    expect(rowB.deletedAt).not.toBeNull();
    expect(rowB.deletedAt).not.toBe("2020-01-01 00:00:00");
  });

  it("restore() revives a mixed active/deleted set, leaving every row visible", async () => {
    const repo = conn.em.getRepository(SdEntity);
    const active = await repo.save({ name: "Mix", age: 99 });
    const deleted = await repo.save({ name: "Mix", age: 99 });

    await repo.softDelete({ id: deleted.id } as any);

    // Criteria matches both the active and the soft-deleted row. The
    // deleted_at IS NOT NULL predicate (asserted at the SQL level in the unit
    // suite — SQLite cannot report `affected`) means only the deleted row is
    // written, and the full set ends up visible.
    await repo.restore({ name: "Mix" } as any);

    const found = await repo.find();
    const items = Array.isArray(found) ? found : found ? [found] : [];
    const ids = items.map((i: any) => i.id);
    expect(ids).toContain(active.id);
    expect(ids).toContain(deleted.id);
  });

  // ── findWithCursor() must honor withDeleted like find() ──────────────
  it("findWithCursor() excludes soft-deleted rows by default", async () => {
    const repo = conn.em.getRepository(SdEntity);
    await repo.save({ name: "CursorLive1", age: 20 });
    const trashed = await repo.save({ name: "CursorTrashed", age: 21 });
    await repo.save({ name: "CursorLive2", age: 22 });
    await repo.softDelete({ id: trashed.id } as any);

    const page = await conn.em.findWithCursor(SdEntity, { take: 10 });

    const names = page.data.map((i: any) => i.name);
    expect(names).toContain("CursorLive1");
    expect(names).toContain("CursorLive2");
    expect(names).not.toContain("CursorTrashed");
    expect(page.count).toBe(2);
  });

  it("findWithCursor() with withDeleted=true includes soft-deleted rows", async () => {
    const repo = conn.em.getRepository(SdEntity);
    await repo.save({ name: "CursorLive1", age: 20 });
    const trashed = await repo.save({ name: "CursorTrashed", age: 21 });
    await repo.save({ name: "CursorLive2", age: 22 });
    await repo.softDelete({ id: trashed.id } as any);

    const page = await conn.em.findWithCursor(SdEntity, {
      take: 10,
      withDeleted: true,
    });

    const names = page.data.map((i: any) => i.name);
    expect(names).toContain("CursorLive1");
    expect(names).toContain("CursorLive2");
    expect(names).toContain("CursorTrashed");
    expect(page.count).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────
// 2. Batch Operations
// ─────────────────────────────────────────────────────────

describe("[Integration] SQLite: Batch Operations", () => {
  let conn: TestConnectionResult;
  let BatchEntity: new () => any;
  let tableName: string;

  beforeAll(async () => {
    tableName = shortTableName("batch");

    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: false,
        logging: false,
      },
      () => {
        clearScanners();

        const DC = class {} as any;
        Object.defineProperty(DC, "name", { value: tableName });

        // id
        Reflect.defineMetadata("design:type", Number, DC.prototype, "id");
        PrimaryGeneratedColumn()(DC.prototype, "id");

        // name
        Reflect.defineMetadata("design:type", String, DC.prototype, "name");
        Column()(DC.prototype, "name");

        // age
        Reflect.defineMetadata("design:type", Number, DC.prototype, "age");
        Column({ type: "int" })(DC.prototype, "age");

        // email (nullable)
        Reflect.defineMetadata("design:type", String, DC.prototype, "email");
        Column({ type: "varchar", length: 255, nullable: true })(DC.prototype, "email");

        Entity()(DC);
        BatchEntity = DC;
        return { entities: [DC] };
      },
    );

    // Manual CREATE TABLE
    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(`
      CREATE TABLE IF NOT EXISTS "${tableName}" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "name" TEXT NOT NULL,
        "age" INTEGER NOT NULL,
        "email" TEXT
      )
    `);
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  beforeEach(async () => {
    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(`DELETE FROM "${tableName}"`);
  });

  // ─── insertMany ────────────────────────────────────────

  it("insertMany() should insert multiple rows", async () => {
    const repo = conn.em.getRepository(BatchEntity);
    await repo.insertMany([
      { name: "Alice", age: 25 },
      { name: "Bob", age: 30 },
      { name: "Charlie", age: 35 },
    ]);

    // Verify by counting
    const count = await repo.count();
    expect(count).toBe(3);
  });

  it("insertMany() with empty array should insert nothing", async () => {
    const repo = conn.em.getRepository(BatchEntity);
    const result = await repo.insertMany([]);
    expect(result.affected).toBe(0);
  });

  it("insertMany() followed by count() should be consistent", async () => {
    const repo = conn.em.getRepository(BatchEntity);
    await repo.insertMany([
      { name: "A", age: 1 },
      { name: "B", age: 2 },
      { name: "C", age: 3 },
      { name: "D", age: 4 },
      { name: "E", age: 5 },
    ]);

    const count = await repo.count();
    expect(count).toBe(5);
  });

  it("insertMany() with nullable columns should store null", async () => {
    const repo = conn.em.getRepository(BatchEntity);
    await repo.insertMany([
      { name: "NullEmail1", age: 10, email: null },
      { name: "NullEmail2", age: 20, email: null },
    ]);

    const found = await repo.find();
    const items = Array.isArray(found) ? found : found ? [found] : [];

    for (const item of items) {
      expect(item.email == null).toBe(true);
    }
  });

  // ─── saveMany ──────────────────────────────────────────

  it("saveMany() should save multiple new entities with generated ids", async () => {
    const repo = conn.em.getRepository(BatchEntity);
    const results = await repo.saveMany([
      { name: "S1", age: 10 },
      { name: "S2", age: 20 },
      { name: "S3", age: 30 },
    ]);

    expect(results).toBeDefined();
    expect(results.length).toBe(3);

    for (const item of results) {
      expect(item.id).toBeDefined();
      expect(item.id).toBeGreaterThan(0);
    }
  });

  it("saveMany() with empty array should return empty array", async () => {
    const repo = conn.em.getRepository(BatchEntity);
    const results = await repo.saveMany([]);
    expect(results).toEqual([]);
  });

  // ─── deleteMany ────────────────────────────────────────

  it("deleteMany() should delete multiple entities by PK array", async () => {
    const repo = conn.em.getRepository(BatchEntity);
    const s1 = await repo.save({ name: "A", age: 10 });
    const s2 = await repo.save({ name: "B", age: 20 });
    await repo.save({ name: "C", age: 30 });

    await repo.deleteMany([s1.id, s2.id]);

    // Verify only "C" remains
    const found = await repo.find();
    const items = Array.isArray(found) ? found : found ? [found] : [];
    expect(items.length).toBe(1);
    expect(items[0].name).toBe("C");
  });

  it("deleteMany() with empty array should not delete anything", async () => {
    const repo = conn.em.getRepository(BatchEntity);
    await repo.save({ name: "Safe", age: 10 });

    const result = await repo.deleteMany([]);
    expect(result.affected).toBe(0);

    const count = await repo.count();
    expect(count).toBe(1);
  });

  // ─── sum ───────────────────────────────────────────────

  it("sum() should return correct total after saveMany", async () => {
    const repo = conn.em.getRepository(BatchEntity);
    const items = Array.from({ length: 10 }, (_, i) => ({
      name: `User${i + 1}`,
      age: (i + 1) * 5,
    }));

    await repo.saveMany(items);

    const count = await repo.count();
    expect(count).toBe(10);

    const total = await repo.sum("age");
    // 5+10+15+20+25+30+35+40+45+50 = 275
    expect(total).toBe(275);
  });

  // ─── composite scenario ────────────────────────────────

  it("insertMany -> find -> deleteMany full flow", async () => {
    const repo = conn.em.getRepository(BatchEntity);

    // 1. Batch insert
    await repo.insertMany([
      { name: "Batch1", age: 10 },
      { name: "Batch2", age: 20 },
      { name: "Batch3", age: 30 },
    ]);

    // 2. Find all
    const found = await repo.find();
    const items = Array.isArray(found) ? found : found ? [found] : [];
    expect(items.length).toBe(3);

    // 3. Delete all
    const ids = items.map((i: any) => i.id);
    await repo.deleteMany(ids);

    // 4. Empty
    const count = await repo.count();
    expect(count).toBe(0);
  });

  // ─── update() single-call sugar ─────────────────────────
  // `update(where, data)` is the filter-first sugar over `updateMany`.
  // SQLite reports `affected: 0` (see file header), so we assert data state.

  it("em.update() changes the matching row", async () => {
    const repo = conn.em.getRepository(BatchEntity);
    const saved = await repo.save({ name: "Origin", age: 41 });

    await conn.em.update(
      BatchEntity,
      { id: saved.id } as any,
      { name: "Renamed", age: 42 } as any,
    );

    const after = await repo.findOne({ where: { id: saved.id } });
    const row = Array.isArray(after) ? after[0] : after;
    expect(row.name).toBe("Renamed");
    expect(row.age).toBe(42);
  });

  it("repo.update() updates only rows matching the filter", async () => {
    const repo = conn.em.getRepository(BatchEntity);
    await repo.insertMany([
      { name: "Keep", age: 10 },
      { name: "Target", age: 20 },
      { name: "Target", age: 21 },
    ]);

    await repo.update({ name: "Target" } as any, { age: 99 } as any);

    const found = await repo.find();
    const items = Array.isArray(found) ? found : found ? [found] : [];
    const keep = items.find((r: any) => r.name === "Keep");
    const targets = items.filter((r: any) => r.name === "Target");
    expect(keep.age).toBe(10);
    expect(targets.every((r: any) => r.age === 99)).toBe(true);
  });

  it("em.update() rejects an empty WHERE (no table-wide update)", async () => {
    const repo = conn.em.getRepository(BatchEntity);
    await repo.insertMany([
      { name: "A", age: 1 },
      { name: "B", age: 2 },
    ]);

    await expect(
      conn.em.update(BatchEntity, {} as any, { age: 0 } as any),
    ).rejects.toThrow();

    // Untouched.
    const found = await repo.find();
    const items = Array.isArray(found) ? found : found ? [found] : [];
    expect(items.every((r: any) => r.age !== 0)).toBe(true);
  });

  // ─── findBy() / findOneBy() filter-first reads ──────────

  it("em.findOneBy() returns the single matching row", async () => {
    const repo = conn.em.getRepository(BatchEntity);
    await repo.insertMany([
      { name: "Solo", age: 30 },
      { name: "Other", age: 31 },
    ]);

    const row = await conn.em.findOneBy(BatchEntity, { name: "Solo" } as any);
    expect(row).not.toBeNull();
    expect((row as any).name).toBe("Solo");
    expect((row as any).age).toBe(30);
  });

  it("em.findBy() returns all rows matching the filter", async () => {
    const repo = conn.em.getRepository(BatchEntity);
    await repo.insertMany([
      { name: "Dup", age: 1 },
      { name: "Dup", age: 2 },
      { name: "Unique", age: 3 },
    ]);

    const rows = await conn.em.findBy(BatchEntity, { name: "Dup" } as any);
    expect(rows.length).toBe(2);
    expect(rows.every((r: any) => r.name === "Dup")).toBe(true);
  });

  it("repo.findBy() / findOneBy() delegate end-to-end", async () => {
    const repo = conn.em.getRepository(BatchEntity);
    await repo.insertMany([
      { name: "R1", age: 10 },
      { name: "R2", age: 20 },
    ]);

    const one = await repo.findOneBy({ name: "R2" } as any);
    expect((one as any).age).toBe(20);

    const all = await repo.findBy({ age: 10 } as any);
    expect(all.length).toBe(1);
    expect((all[0] as any).name).toBe("R1");
  });

  it("em.findOneBy() returns null when nothing matches", async () => {
    const repo = conn.em.getRepository(BatchEntity);
    await repo.insertMany([{ name: "Present", age: 1 }]);

    const row = await conn.em.findOneBy(BatchEntity, {
      name: "Absent",
    } as any);
    expect(row).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
// 3. Create/Update Timestamps
// ─────────────────────────────────────────────────────────

describe("[Integration] SQLite: Create/Update Timestamps", () => {
  let conn: TestConnectionResult;
  let TsEntity: new () => any;
  let tableName: string;

  beforeAll(async () => {
    tableName = shortTableName("ts");

    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: false,
        logging: false,
      },
      () => {
        clearScanners();

        const DC = class {} as any;
        Object.defineProperty(DC, "name", { value: tableName });

        // id
        Reflect.defineMetadata("design:type", Number, DC.prototype, "id");
        PrimaryGeneratedColumn()(DC.prototype, "id");

        // title
        Reflect.defineMetadata("design:type", String, DC.prototype, "title");
        Column({ type: "varchar", length: 200 })(DC.prototype, "title");

        // createdAt -- CreateTimestamp() internally calls Column({ type: "datetime", nullable: false })
        Reflect.defineMetadata("design:type", Date, DC.prototype, "createdAt");
        CreateTimestamp()(DC.prototype, "createdAt");

        // updatedAt -- UpdateTimestamp() internally calls Column({ type: "datetime", nullable: false })
        Reflect.defineMetadata("design:type", Date, DC.prototype, "updatedAt");
        UpdateTimestamp()(DC.prototype, "updatedAt");

        Entity()(DC);
        TsEntity = DC;
        return { entities: [DC] };
      },
    );

    // Manual CREATE TABLE (datetime stored as TEXT in SQLite)
    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(`
      CREATE TABLE IF NOT EXISTS "${tableName}" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "title" TEXT NOT NULL,
        "createdAt" TEXT,
        "updatedAt" TEXT
      )
    `);
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  beforeEach(async () => {
    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(`DELETE FROM "${tableName}"`);
  });

  it("INSERT should auto-set createdAt and updatedAt", async () => {
    const saved: any = await conn.em.save(TsEntity, { title: "Hello" });

    expect(saved).toBeDefined();

    // Temporal columns hydrate as Date on SQLite too (V3-T1-1)
    expect(saved.createdAt).toBeInstanceOf(Date);
    expect(saved.updatedAt).toBeInstanceOf(Date);

    const createdAt: Date = saved.createdAt;
    const updatedAt: Date = saved.updatedAt;

    expect(createdAt.getTime()).not.toBeNaN();
    expect(updatedAt.getTime()).not.toBeNaN();

    // On INSERT, createdAt and updatedAt should be the same (or very close)
    expect(Math.abs(createdAt.getTime() - updatedAt.getTime())).toBeLessThan(1000);
  });

  it("UPDATE should change updatedAt but keep createdAt", async () => {
    const saved: any = await conn.em.save(TsEntity, { title: "Original" });

    expect(saved.createdAt).toBeInstanceOf(Date);

    // Wait to ensure timestamps differ
    await new Promise((resolve) => setTimeout(resolve, 50));

    const updated: any = await conn.em.save(TsEntity, {
      id: saved.id,
      title: "Modified",
    });

    expect(updated).toBeDefined();
    expect(updated.createdAt).toBeInstanceOf(Date);
    expect(updated.updatedAt).toBeInstanceOf(Date);

    // createdAt should not change
    expect(updated.createdAt.toISOString()).toBe(saved.createdAt.toISOString());

    // updatedAt should be >= original updatedAt
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(
      saved.updatedAt.getTime(),
    );
  });

  it("multiple inserts should each get their own timestamps", async () => {
    const saved1: any = await conn.em.save(TsEntity, { title: "First" });

    await new Promise((resolve) => setTimeout(resolve, 20));

    const saved2: any = await conn.em.save(TsEntity, { title: "Second" });

    expect(saved1.createdAt).toBeInstanceOf(Date);
    expect(saved2.createdAt).toBeInstanceOf(Date);

    // Second insert should have a createdAt >= first
    expect(saved2.createdAt.getTime()).toBeGreaterThanOrEqual(
      saved1.createdAt.getTime(),
    );
  });

  it("findOne should return entity with timestamp fields populated", async () => {
    const saved: any = await conn.em.save(TsEntity, { title: "Findable" });

    const found: any = await conn.em.findOne(TsEntity, {
      where: { id: saved.id } as any,
    });

    expect(found).toBeDefined();
    expect(found).not.toBeNull();
    expect(found.title).toBe("Findable");

    // Timestamps hydrate as Date (V3-T1-1)
    expect(found.createdAt).toBeInstanceOf(Date);
    expect(found.updatedAt).toBeInstanceOf(Date);
  });
});

// ─────────────────────────────────────────────────────────
// 4. #373: all-default batch INSERT (every column omitted)
// ─────────────────────────────────────────────────────────

describe("[Integration] SQLite: all-default batch INSERT (#373)", () => {
  let conn: TestConnectionResult;
  let DefEntity: new () => any;
  let tableName: string;

  beforeAll(async () => {
    tableName = shortTableName("alldef");

    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: false,
        logging: false,
      },
      () => {
        clearScanners();

        const DC = class {} as any;
        Object.defineProperty(DC, "name", { value: tableName });

        // id
        Reflect.defineMetadata("design:type", Number, DC.prototype, "id");
        PrimaryGeneratedColumn()(DC.prototype, "id");

        // status -- has a DB-side default; omitting it must fall back to DEFAULT
        Reflect.defineMetadata("design:type", String, DC.prototype, "status");
        Column({ type: "varchar", default: "pending" })(DC.prototype, "status");

        // priority -- another defaulted column
        Reflect.defineMetadata("design:type", Number, DC.prototype, "priority");
        Column({ type: "int", default: 0 })(DC.prototype, "priority");

        Entity()(DC);
        DefEntity = DC;
        return { entities: [DC] };
      },
    );

    // Manual CREATE TABLE with DB-side defaults
    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(`
      CREATE TABLE IF NOT EXISTS "${tableName}" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "status" TEXT NOT NULL DEFAULT 'pending',
        "priority" INTEGER NOT NULL DEFAULT 0
      )
    `);
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  beforeEach(async () => {
    const connector = DatabaseClient.getInstance().getConnection();
    await connector.query(`DELETE FROM "${tableName}"`);
  });

  it("saveMany with two empty objects inserts both rows, assigns PKs, and applies defaults", async () => {
    const results = await conn.em.saveMany(DefEntity, [{}, {}] as any);

    expect(results.length).toBe(2);

    const ids = results.map((r: any) => r.id);
    expect(ids[0]).toBeGreaterThan(0);
    expect(ids[1]).toBeGreaterThan(0);
    // Per-row inserts must yield distinct, exact rowids.
    expect(ids[0]).not.toBe(ids[1]);

    for (const row of results) {
      expect((row as any).status).toBe("pending");
      expect((row as any).priority).toBe(0);
    }

    // Confirm the rows are actually persisted with their defaults.
    const connector = DatabaseClient.getInstance().getConnection();
    const persisted = await connector.query(
      `SELECT "id", "status", "priority" FROM "${tableName}" ORDER BY "id"`,
    );
    expect(persisted.length).toBe(2);
    expect(persisted[0].status).toBe("pending");
    expect(persisted[0].priority).toBe(0);
    expect(persisted[1].status).toBe("pending");
    expect(persisted[1].priority).toBe(0);
  });
});
