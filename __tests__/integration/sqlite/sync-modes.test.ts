/**
 * SQLite synchronize 모드 통합 테스트 (Issue #137)
 *
 * synchronize: true / "safe" / "dry-run" 모드가 기존 테이블에 대해
 * ADD COLUMN, DROP COLUMN, ALTER COLUMN을 올바르게 수행하는지 검증합니다.
 */

import "reflect-metadata";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Container from "typedi";
import { EntityManager } from "../../../src/core/EntityManager";
import { DatabaseClient } from "../../../src/DatabaseClient";
import { MetadataLayerRegistry } from "../../../src/scanner/MetadataScanner";
import { ColumnScanner } from "../../../src/scanner";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
} from "../../../src";

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

const TABLE_NAME = "sync_test_users";

function resetState() {
  MetadataLayerRegistry.reset();
  Container.reset();
}

function createEntity(
  columns: Array<{ name: string; type?: string; nullable?: boolean; primary?: boolean }>,
): new () => any {
  Container.get(ColumnScanner).clear();

  const DynClass = class {} as any;
  Object.defineProperty(DynClass, "name", { value: TABLE_NAME, writable: false });

  for (const col of columns) {
    if (col.primary) {
      Reflect.defineMetadata("design:type", Number, DynClass.prototype, col.name);
      PrimaryGeneratedColumn()(DynClass.prototype, col.name);
    } else {
      const designType = col.type === "int" ? Number : String;
      Reflect.defineMetadata("design:type", designType, DynClass.prototype, col.name);
      Column({ type: col.type as any ?? "varchar", nullable: col.nullable ?? false })(
        DynClass.prototype,
        col.name,
      );
    }
  }

  Entity()(DynClass);
  return DynClass;
}

async function registerWithSync(
  dbPath: string,
  entityClass: new () => any,
  syncMode: boolean | "safe" | "dry-run",
): Promise<EntityManager> {
  const em = new EntityManager();
  await em.register({
    type: "sqlite",
    host: "",
    port: 0,
    username: "",
    password: "",
    database: dbPath,
    entities: [entityClass],
    synchronize: syncMode,
    logging: false,
  });
  return em;
}

async function getColumnNames(dbPath: string): Promise<string[]> {
  const connector = DatabaseClient.getInstance().getConnection();
  const escaped = TABLE_NAME.replace(/"/g, '""');
  const rows = await connector.query(`PRAGMA table_info("${escaped}")`);
  const normalized = Array.isArray(rows) ? rows : (rows as any).rows ?? [];
  return normalized.map((r: any) => r.name);
}

async function closeDb(): Promise<void> {
  try {
    await DatabaseClient.getInstance().close();
  } catch {
    // already closed
  }
}

// ─────────────────────────────────────────────────────────
// V1: id, name, age
// V2: id, name, age, email (added)
// V3: id, name (age removed)
// ─────────────────────────────────────────────────────────

const V1_COLUMNS = [
  { name: "id", primary: true },
  { name: "name", type: "varchar" },
  { name: "age", type: "int" },
];

const V2_COLUMNS = [
  ...V1_COLUMNS,
  { name: "email", type: "varchar", nullable: true },
];

const V3_COLUMNS = [
  { name: "id", primary: true },
  { name: "name", type: "varchar" },
  // age removed
];

// ─────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────

describe("[Integration] SQLite synchronize modes (Issue #137)", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `sync_test_${Date.now()}.sqlite`);
  });

  afterEach(async () => {
    await closeDb();
    resetState();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  describe("synchronize: true (full sync)", () => {
    it("should CREATE TABLE on first sync", async () => {
      resetState();
      const V1 = createEntity(V1_COLUMNS);
      await registerWithSync(dbPath, V1, true);

      const columns = await getColumnNames(dbPath);
      expect(columns).toContain("id");
      expect(columns).toContain("name");
      expect(columns).toContain("age");
    });

    it("should ADD COLUMN when entity has a new column", async () => {
      // Phase 1: create V1 table
      resetState();
      const V1 = createEntity(V1_COLUMNS);
      await registerWithSync(dbPath, V1, true);
      await closeDb();

      // Phase 2: re-sync with V2 (added email)
      resetState();
      const V2 = createEntity(V2_COLUMNS);
      await registerWithSync(dbPath, V2, true);

      const columns = await getColumnNames(dbPath);
      expect(columns).toContain("email");
      expect(columns).toContain("id");
      expect(columns).toContain("name");
      expect(columns).toContain("age");
    });

    it("should DROP COLUMN when entity removes a column", async () => {
      // Phase 1: create V1 table (id, name, age)
      resetState();
      const V1 = createEntity(V1_COLUMNS);
      await registerWithSync(dbPath, V1, true);
      await closeDb();

      // Phase 2: re-sync with V3 (age removed)
      resetState();
      const V3 = createEntity(V3_COLUMNS);
      await registerWithSync(dbPath, V3, true);

      const columns = await getColumnNames(dbPath);
      expect(columns).toContain("id");
      expect(columns).toContain("name");
      expect(columns).not.toContain("age");
    });
  });

  describe('synchronize: "safe"', () => {
    it("should ADD COLUMN when entity has a new column", async () => {
      // Phase 1: create V1 table
      resetState();
      const V1 = createEntity(V1_COLUMNS);
      await registerWithSync(dbPath, V1, true);
      await closeDb();

      // Phase 2: re-sync with V2 in safe mode (added email)
      resetState();
      const V2 = createEntity(V2_COLUMNS);
      await registerWithSync(dbPath, V2, "safe");

      const columns = await getColumnNames(dbPath);
      expect(columns).toContain("email");
    });

    it("should NOT DROP COLUMN even when entity removes a column", async () => {
      // Phase 1: create V1 table (id, name, age)
      resetState();
      const V1 = createEntity(V1_COLUMNS);
      await registerWithSync(dbPath, V1, true);
      await closeDb();

      // Phase 2: re-sync with V3 in safe mode (age removed in entity)
      resetState();
      const V3 = createEntity(V3_COLUMNS);
      await registerWithSync(dbPath, V3, "safe");

      const columns = await getColumnNames(dbPath);
      expect(columns).toContain("id");
      expect(columns).toContain("name");
      // age should still exist — safe mode never drops
      expect(columns).toContain("age");
    });
  });

  describe('synchronize: "dry-run"', () => {
    it("should NOT modify the database", async () => {
      // Phase 1: create V1 table
      resetState();
      const V1 = createEntity(V1_COLUMNS);
      await registerWithSync(dbPath, V1, true);
      await closeDb();

      // Phase 2: dry-run with V2 (added email)
      resetState();
      const V2 = createEntity(V2_COLUMNS);
      await registerWithSync(dbPath, V2, "dry-run");

      const columns = await getColumnNames(dbPath);
      // email should NOT be added in dry-run mode
      expect(columns).not.toContain("email");
      expect(columns).toContain("id");
      expect(columns).toContain("name");
      expect(columns).toContain("age");
    });
  });

  describe("no-change scenario", () => {
    it("should not error when entity matches DB schema exactly", async () => {
      // Phase 1: create V1 table
      resetState();
      const V1 = createEntity(V1_COLUMNS);
      await registerWithSync(dbPath, V1, true);
      await closeDb();

      // Phase 2: re-sync with same entity — no changes needed
      resetState();
      const V1Again = createEntity(V1_COLUMNS);
      await expect(
        registerWithSync(dbPath, V1Again, true),
      ).resolves.not.toThrow();
    });
  });
});
