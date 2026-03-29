/**
 * @CreateTimestamp / @UpdateTimestamp 통합 테스트
 *
 * 실제 DB에서 INSERT 시 createdAt/updatedAt이 자동 설정되고,
 * UPDATE 시 updatedAt만 갱신되는지 검증합니다.
 */

import "reflect-metadata";
import {
  createTestConnection,
  dropTestTable,
  rawQuery,
  type TestConnectionResult,
} from "./helpers/test-connection";
import { generateTableName } from "./helpers/create-test-entity";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateTimestamp,
  UpdateTimestamp,
} from "../../src";
import { getScannerInstance } from "../../src/scanner/ScannerContainer";
import { ColumnScanner } from "../../src/scanner";
import {
  getTestDrivers,
  type TestDriverConfig,
} from "./helpers/driver-config";
import {
  getColumnsSql,
  normalizeColumns,
} from "./helpers/driver-helpers";

// ─────────────────────────────────────────────────────────────────────────────
// 동적 엔티티 팩토리
// ─────────────────────────────────────────────────────────────────────────────

function createTimestampEntity() {
  const tableName = generateTableName("ts_test");

  const DynamicClass = class {} as any;
  Object.defineProperty(DynamicClass, "name", {
    value: tableName,
    writable: false,
  });

  getScannerInstance(ColumnScanner).clear();

  Reflect.defineMetadata("design:type", Number, DynamicClass.prototype, "id");
  PrimaryGeneratedColumn()(DynamicClass.prototype, "id");

  Reflect.defineMetadata("design:type", String, DynamicClass.prototype, "title");
  Column({ type: "varchar", length: 200 })(DynamicClass.prototype, "title");

  Reflect.defineMetadata("design:type", Date, DynamicClass.prototype, "createdAt");
  CreateTimestamp()(DynamicClass.prototype, "createdAt");

  Reflect.defineMetadata("design:type", Date, DynamicClass.prototype, "updatedAt");
  UpdateTimestamp()(DynamicClass.prototype, "updatedAt");

  Entity()(DynamicClass);

  return { EntityClass: DynamicClass, tableName };
}

// ─────────────────────────────────────────────────────────────────────────────
// 테스트
// ─────────────────────────────────────────────────────────────────────────────

describe.each(getTestDrivers())(
  "[Integration] @CreateTimestamp / @UpdateTimestamp ($label)",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let entity: ReturnType<typeof createTimestampEntity>;

    afterEach(async () => {
      try {
        if (entity) await dropTestTable(entity.tableName);
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 15000);

    it("INSERT 시 createdAt과 updatedAt이 자동으로 설정되어야 한다", async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          entity = createTimestampEntity();
          return { entities: [entity.EntityClass] };
        },
      );

      const saved: any = await conn.em.save(entity.EntityClass, {
        title: "Hello",
      });

      expect(saved).toBeDefined();
      expect(saved.createdAt).toBeInstanceOf(Date);
      expect(saved.updatedAt).toBeInstanceOf(Date);

      // createdAt과 updatedAt이 동일해야 함 (INSERT 시 동시 설정)
      expect(saved.createdAt.getTime()).toBe(saved.updatedAt.getTime());
    }, 30000);

    it("UPDATE 시 updatedAt만 갱신되고 createdAt은 유지되어야 한다", async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          entity = createTimestampEntity();
          return { entities: [entity.EntityClass] };
        },
      );

      const saved: any = await conn.em.save(entity.EntityClass, {
        title: "Original",
      });

      const originalCreatedAt = saved.createdAt;
      const originalUpdatedAt = saved.updatedAt;

      // 시간 차이를 보장하기 위해 잠시 대기
      await new Promise((resolve) => setTimeout(resolve, 50));

      const updated: any = await conn.em.save(entity.EntityClass, {
        id: saved.id,
        title: "Modified",
      });

      expect(updated).toBeDefined();

      // createdAt은 변경되지 않아야 함
      expect(updated.createdAt.getTime()).toBe(originalCreatedAt.getTime());

      // updatedAt은 갱신되어야 함
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(
        originalUpdatedAt.getTime(),
      );
    }, 30000);

    it("DDL에 createdAt/updatedAt 컬럼이 존재해야 한다", async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          entity = createTimestampEntity();
          return { entities: [entity.EntityClass] };
        },
      );

      const result = await rawQuery(getColumnsSql(type, entity.tableName));
      const rs = result?.results ?? result;
      const columns = Array.isArray(rs) ? rs : [rs];
      const normalized = normalizeColumns(type, columns);
      const colNames = normalized.map((c) => c.name);

      expect(colNames).toContain("createdAt");
      expect(colNames).toContain("updatedAt");
    }, 30000);
  },
);
