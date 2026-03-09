/**
 * @Column 데코레이터가 없는 속성이 실제 DB 테이블에서 제외되는지 검증하는 통합 테스트
 *
 * 엔티티의 모든 속성에 @Column을 넣되, 특정 속성 하나만 빼고,
 * synchronize 후 실제 DB 테이블을 introspect하여 해당 컬럼이 존재하지 않는지 확인합니다.
 */

import "reflect-metadata";
import {
  createTestConnection,
  dropTestTable,
  rawQuery,
  type TestConnectionResult,
} from "./helpers/test-connection";
import {
  createDynamicEntity,
  generateTableName,
  type DynamicEntityResult,
} from "./helpers/create-test-entity";
import {
  getTestDrivers,
  type TestDriverConfig,
} from "./helpers/driver-config";
import {
  getColumnsSql,
  normalizeColumns,
} from "./helpers/driver-helpers";
import { Entity, Column, PrimaryGeneratedColumn } from "../../src";
import Container from "typedi";
import { ColumnScanner } from "../../src/scanner";

// ─────────────────────────────────────────────────────────────────────────────
// 동적 엔티티 팩토리: @Column이 없는 속성을 포함한 엔티티
// ─────────────────────────────────────────────────────────────────────────────

interface ExclusionTestResult {
  EntityClass: new () => any;
  tableName: string;
  decoratedColumns: string[];
  undecoratedProperty: string;
}

function createEntityWithUndecoratedProperty(): ExclusionTestResult {
  const tableName = generateTableName("col_excl");

  const DynamicClass = class {} as any;
  Object.defineProperty(DynamicClass, "name", {
    value: tableName,
    writable: false,
  });

  Container.get(ColumnScanner).clear();

  // id (PK) — @PrimaryGeneratedColumn 있음
  Reflect.defineMetadata("design:type", Number, DynamicClass.prototype, "id");
  PrimaryGeneratedColumn()(DynamicClass.prototype, "id");

  // title — @Column 있음
  Reflect.defineMetadata("design:type", String, DynamicClass.prototype, "title");
  Column({ type: "varchar", length: 200 })(DynamicClass.prototype, "title");

  // content — @Column 있음
  Reflect.defineMetadata("design:type", String, DynamicClass.prototype, "content");
  Column({ type: "text", nullable: true })(DynamicClass.prototype, "content");

  // published — @Column 있음
  Reflect.defineMetadata("design:type", Boolean, DynamicClass.prototype, "published");
  Column({ type: "boolean" })(DynamicClass.prototype, "published");

  // viewCount — @Column 있음
  Reflect.defineMetadata("design:type", Number, DynamicClass.prototype, "viewCount");
  Column({ type: "int" })(DynamicClass.prototype, "viewCount");

  // temporaryNote — @Column 없음! DB에 생성되면 안 됨
  // design:type만 설정하고 Column 데코레이터는 호출하지 않음
  Reflect.defineMetadata("design:type", String, DynamicClass.prototype, "temporaryNote");

  Entity()(DynamicClass);

  return {
    EntityClass: DynamicClass,
    tableName,
    decoratedColumns: ["id", "title", "content", "published", "viewCount"],
    undecoratedProperty: "temporaryNote",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 테스트
// ─────────────────────────────────────────────────────────────────────────────

describe.each(getTestDrivers())(
  "[Integration] @Column 데코레이터 제외 검증 ($label)",
  ({ type, options }: TestDriverConfig) => {
    let conn: TestConnectionResult;
    let entity: ExclusionTestResult;

    afterEach(async () => {
      try {
        if (entity) await dropTestTable(entity.tableName);
      } catch {
        // ignore
      }
      if (conn) await conn.cleanup();
    }, 15000);

    it("@Column이 있는 속성만 실제 DB 컬럼으로 생성되어야 한다", async () => {
      conn = await createTestConnection(
        { synchronize: true, logging: false, ...options },
        () => {
          entity = createEntityWithUndecoratedProperty();
          return { entities: [entity.EntityClass] };
        },
      );

      // 실제 DB에서 컬럼 목록 조회
      const result = await rawQuery(getColumnsSql(type, entity.tableName));
      const rs = result?.results ?? result;
      const columns = Array.isArray(rs) ? rs : [rs];
      const normalized = normalizeColumns(type, columns);
      const colNames = normalized.map((c) => c.name);

      // @Column이 있는 속성은 모두 존재해야 함
      for (const expected of entity.decoratedColumns) {
        expect(colNames).toContain(expected);
      }

      // @Column이 없는 속성은 DB에 존재하지 않아야 함
      expect(colNames).not.toContain(entity.undecoratedProperty);

      // 컬럼 수가 정확히 데코레이터가 있는 속성 수와 일치해야 함
      expect(colNames.length).toBe(entity.decoratedColumns.length);
    }, 30000);
  },
);
