/**
 * SQLite In-Memory SchemaDiff 동기화 후 검증 통합 테스트 (Issue #119)
 *
 * 실제 SQLite 인메모리 DB에 대해 synchronize로 테이블을 생성한 뒤,
 * SchemaDiff.diff()가 컬럼 추가/수정/삭제/리네임을 올바르게 감지하는지 검증합니다.
 *
 * 기존 schema-diff.test.ts(mocked queryRunner)와 달리
 * 실제 DB를 대상으로 end-to-end 검증합니다.
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
} from "../../../src";
import { getScannerInstance } from "../../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../../src/scanner";
import { DatabaseClient } from "../../../src/DatabaseClient";
import { SchemaDiff } from "../../../src/core/generators/SchemaDiff";
import type { Sql } from "sql-template-tag";

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

/** Fixed table name (shared across entity versions) */
const TABLE_NAME = `sd_sync_${String(Date.now()).slice(-7)}`;

/**
 * V1 엔티티: id (PK), name (varchar), age (int)
 */
function createV1Entity(): new () => any {
  getScannerInstance(ColumnScanner).clear();

  const DynClass = class {} as any;
  Object.defineProperty(DynClass, "name", {
    value: TABLE_NAME,
    writable: false,
  });

  Reflect.defineMetadata("design:type", Number, DynClass.prototype, "id");
  PrimaryGeneratedColumn()(DynClass.prototype, "id");

  Reflect.defineMetadata("design:type", String, DynClass.prototype, "name");
  Column()(DynClass.prototype, "name");

  Reflect.defineMetadata("design:type", Number, DynClass.prototype, "age");
  Column({ type: "int" })(DynClass.prototype, "age");

  Entity()(DynClass);
  return DynClass;
}

/**
 * V2 엔티티: V1 + email (varchar, nullable)
 */
function createV2WithAddedColumn(): new () => any {
  getScannerInstance(ColumnScanner).clear();

  const DynClass = class {} as any;
  Object.defineProperty(DynClass, "name", {
    value: TABLE_NAME,
    writable: false,
  });

  Reflect.defineMetadata("design:type", Number, DynClass.prototype, "id");
  PrimaryGeneratedColumn()(DynClass.prototype, "id");

  Reflect.defineMetadata("design:type", String, DynClass.prototype, "name");
  Column()(DynClass.prototype, "name");

  Reflect.defineMetadata("design:type", Number, DynClass.prototype, "age");
  Column({ type: "int" })(DynClass.prototype, "age");

  Reflect.defineMetadata("design:type", String, DynClass.prototype, "email");
  Column({ type: "varchar", nullable: true })(DynClass.prototype, "email");

  Entity()(DynClass);
  return DynClass;
}

/**
 * V3 엔티티: V1 + email + bio (text, nullable) — 2개 컬럼 추가
 */
function createV3WithMultipleAddedColumns(): new () => any {
  getScannerInstance(ColumnScanner).clear();

  const DynClass = class {} as any;
  Object.defineProperty(DynClass, "name", {
    value: TABLE_NAME,
    writable: false,
  });

  Reflect.defineMetadata("design:type", Number, DynClass.prototype, "id");
  PrimaryGeneratedColumn()(DynClass.prototype, "id");

  Reflect.defineMetadata("design:type", String, DynClass.prototype, "name");
  Column()(DynClass.prototype, "name");

  Reflect.defineMetadata("design:type", Number, DynClass.prototype, "age");
  Column({ type: "int" })(DynClass.prototype, "age");

  Reflect.defineMetadata("design:type", String, DynClass.prototype, "email");
  Column({ type: "varchar", nullable: true })(DynClass.prototype, "email");

  Reflect.defineMetadata("design:type", String, DynClass.prototype, "bio");
  Column({ type: "text", nullable: true })(DynClass.prototype, "bio");

  Entity()(DynClass);
  return DynClass;
}

/**
 * 타입 변경: age를 int → text로 변경
 */
function createEntityWithChangedType(): new () => any {
  getScannerInstance(ColumnScanner).clear();

  const DynClass = class {} as any;
  Object.defineProperty(DynClass, "name", {
    value: TABLE_NAME,
    writable: false,
  });

  Reflect.defineMetadata("design:type", Number, DynClass.prototype, "id");
  PrimaryGeneratedColumn()(DynClass.prototype, "id");

  Reflect.defineMetadata("design:type", String, DynClass.prototype, "name");
  Column()(DynClass.prototype, "name");

  // age: int → text (type change: INTEGER → TEXT)
  Reflect.defineMetadata("design:type", String, DynClass.prototype, "age");
  Column({ type: "text" })(DynClass.prototype, "age");

  Entity()(DynClass);
  return DynClass;
}

/**
 * 타입 변경: age를 int → float (INTEGER → REAL, affinity mismatch)
 */
function createEntityWithRealType(): new () => any {
  getScannerInstance(ColumnScanner).clear();

  const DynClass = class {} as any;
  Object.defineProperty(DynClass, "name", {
    value: TABLE_NAME,
    writable: false,
  });

  Reflect.defineMetadata("design:type", Number, DynClass.prototype, "id");
  PrimaryGeneratedColumn()(DynClass.prototype, "id");

  Reflect.defineMetadata("design:type", String, DynClass.prototype, "name");
  Column()(DynClass.prototype, "name");

  // age: int → float (INTEGER → REAL)
  Reflect.defineMetadata("design:type", Number, DynClass.prototype, "age");
  Column({ type: "float" })(DynClass.prototype, "age");

  Entity()(DynClass);
  return DynClass;
}

/**
 * 컬럼 삭제: age 컬럼 없음 (id, name만)
 */
function createEntityWithDroppedColumn(): new () => any {
  getScannerInstance(ColumnScanner).clear();

  const DynClass = class {} as any;
  Object.defineProperty(DynClass, "name", {
    value: TABLE_NAME,
    writable: false,
  });

  Reflect.defineMetadata("design:type", Number, DynClass.prototype, "id");
  PrimaryGeneratedColumn()(DynClass.prototype, "id");

  Reflect.defineMetadata("design:type", String, DynClass.prototype, "name");
  Column()(DynClass.prototype, "name");

  Entity()(DynClass);
  return DynClass;
}

/**
 * 리네임 시뮬레이션: age 제거 + years 추가 (같은 타입 INTEGER)
 */
function createEntityWithRenamedColumn(): new () => any {
  getScannerInstance(ColumnScanner).clear();

  const DynClass = class {} as any;
  Object.defineProperty(DynClass, "name", {
    value: TABLE_NAME,
    writable: false,
  });

  Reflect.defineMetadata("design:type", Number, DynClass.prototype, "id");
  PrimaryGeneratedColumn()(DynClass.prototype, "id");

  Reflect.defineMetadata("design:type", String, DynClass.prototype, "name");
  Column()(DynClass.prototype, "name");

  // "age" removed, "years" added with same type → rename detection
  Reflect.defineMetadata("design:type", Number, DynClass.prototype, "years");
  Column({ type: "int" })(DynClass.prototype, "years");

  Entity()(DynClass);
  return DynClass;
}

/**
 * 리네임으로 오인될 수 없는 교체: age(int) 제거 + nickname(varchar) 추가.
 * 타입이 호환되지 않으므로 detectRenames가 짝지어선 안 된다.
 */
function createEntityWithIncompatibleReplacement(): new () => any {
  getScannerInstance(ColumnScanner).clear();

  const DynClass = class {} as any;
  Object.defineProperty(DynClass, "name", {
    value: TABLE_NAME,
    writable: false,
  });

  Reflect.defineMetadata("design:type", Number, DynClass.prototype, "id");
  PrimaryGeneratedColumn()(DynClass.prototype, "id");

  Reflect.defineMetadata("design:type", String, DynClass.prototype, "name");
  Column()(DynClass.prototype, "name");

  Reflect.defineMetadata("design:type", String, DynClass.prototype, "nickname");
  Column({ type: "varchar", nullable: true })(DynClass.prototype, "nickname");

  Entity()(DynClass);
  return DynClass;
}

/**
 * 새 테이블 엔티티 (DB에 존재하지 않는 테이블)
 */
function createNewTableEntity(): { entity: new () => any; tableName: string } {
  const newTable = `sd_new_${String(Date.now()).slice(-7)}`;
  getScannerInstance(ColumnScanner).clear();

  const DynClass = class {} as any;
  Object.defineProperty(DynClass, "name", {
    value: newTable,
    writable: false,
  });

  Reflect.defineMetadata("design:type", Number, DynClass.prototype, "id");
  PrimaryGeneratedColumn()(DynClass.prototype, "id");

  Reflect.defineMetadata("design:type", String, DynClass.prototype, "title");
  Column()(DynClass.prototype, "title");

  Entity()(DynClass);
  return { entity: DynClass, tableName: newTable };
}

/**
 * Type affinity 동일: name을 varchar → text (둘 다 TEXT affinity)
 */
function createEntityWithSameAffinity(): new () => any {
  getScannerInstance(ColumnScanner).clear();

  const DynClass = class {} as any;
  Object.defineProperty(DynClass, "name", {
    value: TABLE_NAME,
    writable: false,
  });

  Reflect.defineMetadata("design:type", Number, DynClass.prototype, "id");
  PrimaryGeneratedColumn()(DynClass.prototype, "id");

  // varchar → text (both map to TEXT in SQLite)
  Reflect.defineMetadata("design:type", String, DynClass.prototype, "name");
  Column({ type: "text" })(DynClass.prototype, "name");

  Reflect.defineMetadata("design:type", Number, DynClass.prototype, "age");
  Column({ type: "int" })(DynClass.prototype, "age");

  Entity()(DynClass);
  return DynClass;
}

/**
 * Boolean affinity: age를 boolean으로 (둘 다 INTEGER affinity)
 */
function createEntityWithBooleanType(): new () => any {
  getScannerInstance(ColumnScanner).clear();

  const DynClass = class {} as any;
  Object.defineProperty(DynClass, "name", {
    value: TABLE_NAME,
    writable: false,
  });

  Reflect.defineMetadata("design:type", Number, DynClass.prototype, "id");
  PrimaryGeneratedColumn()(DynClass.prototype, "id");

  Reflect.defineMetadata("design:type", String, DynClass.prototype, "name");
  Column()(DynClass.prototype, "name");

  // int → boolean (both map to INTEGER in SQLite)
  Reflect.defineMetadata("design:type", Boolean, DynClass.prototype, "age");
  Column({ type: "boolean" })(DynClass.prototype, "age");

  Entity()(DynClass);
  return DynClass;
}

/**
 * Nullability-only change: `name` flips from NOT NULL (V1) to nullable, with
 * the type/length unchanged.
 */
function createEntityWithNullableName(): new () => any {
  getScannerInstance(ColumnScanner).clear();

  const DynClass = class {} as any;
  Object.defineProperty(DynClass, "name", {
    value: TABLE_NAME,
    writable: false,
  });

  Reflect.defineMetadata("design:type", Number, DynClass.prototype, "id");
  PrimaryGeneratedColumn()(DynClass.prototype, "id");

  // name: NOT NULL (V1) → nullable (same inferred varchar/255 type)
  Reflect.defineMetadata("design:type", String, DynClass.prototype, "name");
  Column({ nullable: true })(DynClass.prototype, "name");

  Reflect.defineMetadata("design:type", Number, DynClass.prototype, "age");
  Column({ type: "int" })(DynClass.prototype, "age");

  Entity()(DynClass);
  return DynClass;
}

// ─────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────

describe("[Integration] SQLite In-Memory: SchemaDiff 동기화 후 감지 검증", () => {
  let conn: TestConnectionResult;
  let V1Entity: new () => any;
  let schemaDiff: SchemaDiff;
  let queryRunner: { query: (sql: string | Sql) => Promise<any> };

  beforeAll(async () => {
    // Phase 1: 테이블 생성 via synchronize: true
    conn = await createTestConnection(
      {
        type: "sqlite",
        database: ":memory:",
        synchronize: true,
        logging: false,
      },
      () => {
        V1Entity = createV1Entity();
        return { entities: [V1Entity] };
      },
    );

    // queryRunner: direct access to the SQLite connector
    const connector = DatabaseClient.getInstance().getConnection();
    queryRunner = {
      query: (s: string | Sql) => connector.query(s as any),
    };
    schemaDiff = new SchemaDiff();
  });

  afterAll(async () => {
    await conn.cleanup();
  });

  // ─────────────────────────────────────────────────────────
  // Baseline: zero diff after sync
  // ─────────────────────────────────────────────────────────

  describe("Baseline (zero diff)", () => {
    it("should report no changes after initial synchronization", async () => {
      const result = await schemaDiff.diff([V1Entity], queryRunner, "sqlite");

      expect(result.addTables).toHaveLength(0);
      expect(result.addColumns).toHaveLength(0);
      expect(result.alterColumns).toHaveLength(0);
      expect(result.dropColumns).toHaveLength(0);
      expect(result.renamedColumns).toHaveLength(0);
    });

    it("table should exist in sqlite_master", async () => {
      const rows = await queryRunner.query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='${TABLE_NAME}'`,
      );
      const normalized = Array.isArray(rows) ? rows : (rows as any).rows ?? [];
      expect(normalized.length).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────
  // Added column detection
  // ─────────────────────────────────────────────────────────

  describe("Added column detection", () => {
    it("should detect a single added VARCHAR column", async () => {
      const V2 = createV2WithAddedColumn();
      const result = await schemaDiff.diff([V2], queryRunner, "sqlite");

      expect(result.addColumns.length).toBe(1);
      expect(result.addColumns[0].columnName).toBe("email");
      expect(result.addColumns[0].tableName).toBe(TABLE_NAME);
      expect(result.addColumns[0].columnType).toBe("TEXT"); // varchar → TEXT in SQLite
      expect(result.addColumns[0].nullable).toBe(true);
    });

    it("should detect multiple added columns", async () => {
      const V3 = createV3WithMultipleAddedColumns();
      const result = await schemaDiff.diff([V3], queryRunner, "sqlite");

      expect(result.addColumns.length).toBe(2);
      const names = result.addColumns.map((c) => c.columnName).sort();
      expect(names).toEqual(["bio", "email"]);
    });

    it("should not affect existing columns when detecting new ones", async () => {
      const V2 = createV2WithAddedColumn();
      const result = await schemaDiff.diff([V2], queryRunner, "sqlite");

      expect(result.alterColumns).toHaveLength(0);
      expect(result.dropColumns).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────
  // Modified column detection (type change)
  // ─────────────────────────────────────────────────────────

  describe("Modified column detection", () => {
    it("should detect type change from INTEGER to TEXT", async () => {
      const modified = createEntityWithChangedType();
      const result = await schemaDiff.diff([modified], queryRunner, "sqlite");

      const ageChange = result.alterColumns.find(
        (c) => c.columnName === "age",
      );
      expect(ageChange).toBeDefined();
      expect(ageChange!.columnType).toBe("TEXT");
      expect(ageChange!.currentType?.toUpperCase()).toContain("INT");
    });

    it("should detect type change from INTEGER to REAL", async () => {
      const modified = createEntityWithRealType();
      const result = await schemaDiff.diff([modified], queryRunner, "sqlite");

      const ageChange = result.alterColumns.find(
        (c) => c.columnName === "age",
      );
      expect(ageChange).toBeDefined();
      expect(ageChange!.columnType).toBe("REAL");
    });
  });

  // ─────────────────────────────────────────────────────────
  // Type affinity false positives
  // ─────────────────────────────────────────────────────────

  describe("Type affinity (no false positives)", () => {
    it("VARCHAR → TEXT should NOT be reported (same TEXT affinity)", async () => {
      const sameAffinity = createEntityWithSameAffinity();
      const result = await schemaDiff.diff(
        [sameAffinity],
        queryRunner,
        "sqlite",
      );

      const nameChange = result.alterColumns.find(
        (c) => c.columnName === "name",
      );
      expect(nameChange).toBeUndefined();
    });

    it("INT → BOOLEAN should NOT be reported (same INTEGER affinity)", async () => {
      const boolEntity = createEntityWithBooleanType();
      const result = await schemaDiff.diff(
        [boolEntity],
        queryRunner,
        "sqlite",
      );

      const ageChange = result.alterColumns.find(
        (c) => c.columnName === "age",
      );
      expect(ageChange).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────
  // Dropped column detection
  // ─────────────────────────────────────────────────────────

  describe("Dropped column detection", () => {
    it("should detect a removed column", async () => {
      const dropped = createEntityWithDroppedColumn();
      const result = await schemaDiff.diff([dropped], queryRunner, "sqlite");

      expect(result.dropColumns.length).toBeGreaterThanOrEqual(1);
      const ageDrop = result.dropColumns.find(
        (c) => c.columnName === "age",
      );
      expect(ageDrop).toBeDefined();
      expect(ageDrop!.tableName).toBe(TABLE_NAME);
    });
  });

  // ─────────────────────────────────────────────────────────
  // Column rename detection
  // ─────────────────────────────────────────────────────────

  describe("Column rename detection", () => {
    // Both outcomes used to be accepted by one if/else, so a regression that
    // downgraded a rename to DROP + ADD (data loss in production) still passed.
    // The two cases are pinned separately instead.
    it("should detect rename when one column dropped and one added with same type", async () => {
      const renamed = createEntityWithRenamedColumn();
      const result = await schemaDiff.diff([renamed], queryRunner, "sqlite");

      expect(result.renamedColumns).toBeDefined();
      expect(result.renamedColumns).toHaveLength(1);
      const rename = result.renamedColumns![0];
      expect(rename.oldColumnName).toBe("age");
      expect(rename.newColumnName).toBe("years");
      expect(rename.tableName).toBe(TABLE_NAME);

      // The matched pair must be consumed — leaving it in add/drop would emit
      // a destructive DROP alongside the RENAME.
      expect(
        result.dropColumns.some((c) => c.columnName === "age"),
      ).toBe(false);
      expect(
        result.addColumns.some((c) => c.columnName === "years"),
      ).toBe(false);
    });

    it("should NOT pair a type-incompatible add/drop as a rename", async () => {
      const replaced = createEntityWithIncompatibleReplacement();
      const result = await schemaDiff.diff([replaced], queryRunner, "sqlite");

      // int → varchar has no shared SQLite affinity, so this stays DROP + ADD.
      expect(result.renamedColumns ?? []).toHaveLength(0);
      expect(
        result.dropColumns.some((c) => c.columnName === "age"),
      ).toBe(true);
      expect(
        result.addColumns.some((c) => c.columnName === "nickname"),
      ).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────
  // Full table addition
  // ─────────────────────────────────────────────────────────

  describe("Full table addition", () => {
    it("should detect a brand new table (not in DB)", async () => {
      const { entity: newEntity, tableName: newTable } = createNewTableEntity();

      // Include both V1 (existing) and new entity (not in DB)
      const result = await schemaDiff.diff(
        [V1Entity, newEntity],
        queryRunner,
        "sqlite",
      );

      expect(result.addTables).toContain(newTable);
      // V1 table should not be in addTables
      expect(result.addTables).not.toContain(TABLE_NAME);
    });
  });

  // ─────────────────────────────────────────────────────────
  // Dropped table detection (opt-in)
  // ─────────────────────────────────────────────────────────

  describe("Dropped table detection", () => {
    it("should detect dropped tables when opt-in detectDroppedTables", async () => {
      // Create a temporary table directly in DB
      const tempTable = `sd_temp_${String(Date.now()).slice(-7)}`;
      await queryRunner.query(
        `CREATE TABLE "${tempTable}" ("id" INTEGER PRIMARY KEY)`,
      );

      // Run diff with only V1 entity — tempTable is in DB but not in entities
      const result = await schemaDiff.diff(
        [V1Entity],
        queryRunner,
        "sqlite",
        undefined,
        { detectDroppedTables: true },
      );

      expect(result.dropTables).toContain(tempTable);

      // Cleanup
      await queryRunner.query(`DROP TABLE IF EXISTS "${tempTable}"`);
    });
  });

  // ─────────────────────────────────────────────────────────
  // Nullable flag correctness
  // ─────────────────────────────────────────────────────────

  describe("Nullable flag correctness", () => {
    it("should report correct nullable flag for added columns", async () => {
      const V2 = createV2WithAddedColumn();
      const result = await schemaDiff.diff([V2], queryRunner, "sqlite");

      const emailCol = result.addColumns.find(
        (c) => c.columnName === "email",
      );
      expect(emailCol).toBeDefined();
      expect(emailCol!.nullable).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────
  // Nullability-only change detection (against a real SQLite schema)
  // ─────────────────────────────────────────────────────────

  describe("Nullability-only change detection", () => {
    it("should detect a NOT NULL → nullable change as a nullability-only alter", async () => {
      const nullableName = createEntityWithNullableName();
      const result = await schemaDiff.diff(
        [nullableName],
        queryRunner,
        "sqlite",
      );

      const nameChange = result.alterColumns.find(
        (c) => c.columnName === "name",
      );
      expect(nameChange).toBeDefined();
      expect(nameChange!.nullable).toBe(true);
      expect(nameChange!.currentNullable).toBe(false);
      // type/length unchanged — this is a pure nullability drift.
      expect(nameChange!.typeChanged).toBe(false);
    });

    it("should NOT flag the INTEGER PRIMARY KEY (SQLite reports notnull=0)", async () => {
      // SQLite's `INTEGER PRIMARY KEY` is reported as nullable; the PK must be
      // excluded from nullability diffing so the baseline never drifts.
      const nullableName = createEntityWithNullableName();
      const result = await schemaDiff.diff(
        [nullableName],
        queryRunner,
        "sqlite",
      );
      expect(result.alterColumns.some((c) => c.columnName === "id")).toBe(false);
    });
  });
});
