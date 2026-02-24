/**
 * Soft Delete 통합 테스트
 *
 * @DeletedAt 데코레이터를 사용한 soft delete / restore 기능을 검증합니다.
 *
 * 테스트 항목:
 * - softDelete()로 deleted_at 컬럼에 현재 시각 기록
 * - find/findOne에서 soft-deleted 엔티티 자동 필터링
 * - withDeleted 옵션으로 soft-deleted 포함 조회
 * - restore()로 soft-deleted 엔티티 복원
 * - @DeletedAt 없는 엔티티에 softDelete 시 에러
 *
 * 실행 전 필요 사항:
 * - MySQL 서버 실행 중
 * - examples/nestjs-cats/.env의 연결 정보가 유효
 */

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { BaseRepository } from "../../src/core/BaseRepository";
import {
  createTestConnection,
  dropTestTable,
  truncateTestTable,
  TestConnectionResult,
} from "./helpers/test-connection";
import {
  generateTableName,
  createDynamicEntity,
  DynamicEntityResult,
} from "./helpers/create-test-entity";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  DeletedAt,
  DELETED_AT_TOKEN,
} from "../../src";
import Container from "typedi";
import { ColumnScanner } from "../../src/scanner";

// ─────────────────────────────────────────────────────────────────────────────
// 동적 엔티티 팩토리: @DeletedAt 포함
// ─────────────────────────────────────────────────────────────────────────────

interface SoftDeleteEntityResult {
  EntityClass: new () => any;
  tableName: string;
}

function createSoftDeleteEntity(baseName = "sd_test"): SoftDeleteEntityResult {
  const tableName = generateTableName(baseName);

  const DynamicClass = class {} as any;
  Object.defineProperty(DynamicClass, "name", {
    value: tableName,
    writable: false,
  });

  const columnScanner = Container.get(ColumnScanner);
  columnScanner.clear();

  // id (PK)
  Reflect.defineMetadata("design:type", Number, DynamicClass.prototype, "id");
  PrimaryGeneratedColumn()(DynamicClass.prototype, "id");

  // name (VARCHAR)
  Reflect.defineMetadata("design:type", String, DynamicClass.prototype, "name");
  Column()(DynamicClass.prototype, "name");

  // age (INT)
  Reflect.defineMetadata("design:type", Number, DynamicClass.prototype, "age");
  Column({ type: "int" })(DynamicClass.prototype, "age");

  // deletedAt (@DeletedAt)
  Reflect.defineMetadata(
    "design:type",
    Date,
    DynamicClass.prototype,
    "deletedAt",
  );
  DeletedAt()(DynamicClass.prototype, "deletedAt");

  Entity()(DynamicClass);

  return { EntityClass: DynamicClass, tableName };
}

// ─────────────────────────────────────────────────────────────────────────────
// 테스트 스위트
// ─────────────────────────────────────────────────────────────────────────────

describe("[Integration] Soft Delete (@DeletedAt)", () => {
  let conn: TestConnectionResult;
  let em: EntityManager;
  let testEntity: SoftDeleteEntityResult;
  let repo: BaseRepository<any>;

  beforeAll(async () => {
    conn = await createTestConnection(
      { synchronize: true, logging: false },
      () => {
        testEntity = createSoftDeleteEntity();
        return { entities: [testEntity.EntityClass] };
      },
    );
    em = conn.em;
    repo = em.getRepository(testEntity.EntityClass);
  }, 30000);

  afterAll(async () => {
    try {
      await dropTestTable(testEntity.tableName);
    } catch {
      // ignore
    }
    await conn.cleanup();
  }, 15000);

  beforeEach(async () => {
    await truncateTestTable(testEntity.tableName);
  });

  // ─── Soft Delete ──────────────────────────────────────────────────────────

  describe("softDelete()", () => {
    it("softDelete()로 엔티티를 삭제하면 affected가 1이어야 한다", async () => {
      const saved = await repo.save({ name: "Alice", age: 25 });

      const result = await repo.softDelete({ id: saved.id } as any);

      expect(result).toBeDefined();
      expect(result.affected).toBe(1);
    });

    it("softDelete 후 일반 find()에서 제외되어야 한다", async () => {
      const saved = await repo.save({ name: "Bob", age: 30 });

      await repo.softDelete({ id: saved.id } as any);

      const found = await repo.find();
      const items = Array.isArray(found) ? found : found ? [found] : [];

      const names = items.map((i: any) => i.name);
      expect(names).not.toContain("Bob");
    });

    it("softDelete 후 findOne()에서 제외되어야 한다", async () => {
      const saved = await repo.save({ name: "Charlie", age: 35 });

      await repo.softDelete({ id: saved.id } as any);

      const found = await repo.findOne({ where: { id: saved.id } });
      if (Array.isArray(found)) {
        expect(found.length).toBe(0);
      } else {
        expect(found).toBeNull();
      }
    });

    it("softDelete된 엔티티와 되지 않은 엔티티가 혼재할 때 find는 비삭제 건만 반환", async () => {
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

    it("조건으로 여러 엔티티를 softDelete할 수 있어야 한다", async () => {
      await repo.save({ name: "Same", age: 50 });
      await repo.save({ name: "Same", age: 50 });
      await repo.save({ name: "Different", age: 60 });

      const result = await repo.softDelete({ name: "Same" } as any);
      expect(result.affected).toBe(2);

      const found = await repo.find();
      const items = Array.isArray(found) ? found : found ? [found] : [];
      expect(items.length).toBe(1);
      expect(items[0].name).toBe("Different");
    });
  });

  // ─── withDeleted ──────────────────────────────────────────────────────────

  describe("withDeleted 옵션", () => {
    it("withDeleted: true로 조회하면 softDelete된 엔티티도 포함되어야 한다", async () => {
      const saved = await repo.save({ name: "Recoverable", age: 28 });
      await repo.softDelete({ id: saved.id } as any);

      const found = await repo.find({ withDeleted: true } as any);
      const items = Array.isArray(found) ? found : found ? [found] : [];

      const names = items.map((i: any) => i.name);
      expect(names).toContain("Recoverable");
    });

    it("withDeleted: true + where 조건으로 softDelete된 엔티티를 직접 조회", async () => {
      const saved = await repo.save({ name: "Specific", age: 33 });
      await repo.softDelete({ id: saved.id } as any);

      const found = await repo.findOne({
        where: { id: saved.id },
        withDeleted: true,
      } as any);
      const item = Array.isArray(found) ? found[0] : found;

      expect(item).toBeDefined();
      expect(item.name).toBe("Specific");
    });
  });

  // ─── Restore ──────────────────────────────────────────────────────────────

  describe("restore()", () => {
    it("restore() 후 일반 find()에서 다시 조회되어야 한다", async () => {
      const saved = await repo.save({ name: "Restorable", age: 40 });

      await repo.softDelete({ id: saved.id } as any);

      // 삭제 확인
      const afterDelete = await repo.findOne({
        where: { id: saved.id },
      });
      if (Array.isArray(afterDelete)) {
        expect(afterDelete.length).toBe(0);
      } else {
        expect(afterDelete).toBeNull();
      }

      // 복원
      const restoreResult = await repo.restore({ id: saved.id } as any);
      expect(restoreResult.affected).toBe(1);

      // 복원 확인
      const afterRestore = await repo.findOne({
        where: { id: saved.id },
      });
      const item = Array.isArray(afterRestore)
        ? afterRestore[0]
        : afterRestore;

      expect(item).toBeDefined();
      expect(item.name).toBe("Restorable");
    });

    it("여러 엔티티를 조건으로 복원할 수 있어야 한다", async () => {
      await repo.save({ name: "Bulk", age: 50 });
      await repo.save({ name: "Bulk", age: 50 });

      await repo.softDelete({ name: "Bulk" } as any);

      const restoreResult = await repo.restore({ name: "Bulk" } as any);
      expect(restoreResult.affected).toBe(2);

      const found = await repo.find({ where: { name: "Bulk" } });
      const items = Array.isArray(found) ? found : found ? [found] : [];
      expect(items.length).toBe(2);
    });
  });

  // ─── Full Lifecycle ───────────────────────────────────────────────────────

  describe("전체 Soft Delete 라이프사이클", () => {
    it("Create -> SoftDelete -> (invisible) -> Restore -> (visible) -> HardDelete -> (gone)", async () => {
      // 1. Create
      const created = await repo.save({ name: "Lifecycle", age: 25 });
      expect(created.id).toBeDefined();

      // 2. Soft Delete
      await repo.softDelete({ id: created.id } as any);

      // 3. Invisible in normal query
      const afterSoftDelete = await repo.findOne({
        where: { id: created.id },
      });
      if (Array.isArray(afterSoftDelete)) {
        expect(afterSoftDelete.length).toBe(0);
      } else {
        expect(afterSoftDelete).toBeNull();
      }

      // 4. Restore
      await repo.restore({ id: created.id } as any);

      // 5. Visible again
      const afterRestore = await repo.findOne({
        where: { id: created.id },
      });
      const restored = Array.isArray(afterRestore)
        ? afterRestore[0]
        : afterRestore;
      expect(restored).toBeDefined();
      expect(restored.name).toBe("Lifecycle");

      // 6. Hard Delete
      const hardDeleteResult = await repo.delete({
        id: created.id,
      } as any);
      expect(hardDeleteResult.affected).toBe(1);

      // 7. Gone even with withDeleted
      const afterHardDelete = await repo.findOne({
        where: { id: created.id },
        withDeleted: true,
      } as any);
      if (Array.isArray(afterHardDelete)) {
        expect(afterHardDelete.length).toBe(0);
      } else {
        expect(afterHardDelete).toBeNull();
      }
    });
  });

  // ─── Error Cases ──────────────────────────────────────────────────────────

  describe("에러 케이스", () => {
    it("@DeletedAt 없는 엔티티에 softDelete 호출 시 에러가 발생해야 한다", async () => {
      // @DeletedAt 없는 일반 엔티티
      const { EntityClass: PlainEntity } = createDynamicEntity(
        "no_deleted_at",
        [
          { name: "id", designType: Number, primary: true },
          { name: "name", designType: String },
        ],
      );

      // em.softDelete를 직접 호출 (엔티티를 register하지 않으므로 메타데이터 에러 가능)
      await expect(
        em.softDelete(PlainEntity, { id: 1 } as any),
      ).rejects.toThrow();
    });
  });
});
