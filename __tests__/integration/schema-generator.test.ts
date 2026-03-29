/**
 * SchemaGenerator (synchronize) 통합 테스트
 *
 * EntityManager.register({ synchronize: true })를 통해
 * 테이블, 인덱스, 외래키가 자동으로 생성되는지 검증합니다.
 *
 * 테스트 항목:
 * - synchronize: true 시 테이블 자동 생성
 * - 생성된 테이블의 컬럼 검증
 * - @Index → DB 인덱스 생성 확인
 * - @ManyToOne → FK 제약 생성 확인
 * - DROP TABLE 후 재연결 시 테이블 재생성
 *
 * 실행 전 필요 사항:
 * - MySQL 또는 PostgreSQL 서버 실행 중
 * - 연결 정보가 유효
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
  ManyToOne,
  Index,
} from "../../src";
import { getScannerInstance } from "../../src/scanner/ScannerContainer";
import { ColumnScanner, ManyToOneScanner } from "../../src/scanner";
import {
  getTestDrivers,
  type TestDriverConfig,
  type TestDriverType,
} from "./helpers/driver-config";
import {
  qi,
  disableFkChecksSql,
  enableFkChecksSql,
  hasTableSql,
  getColumnsSql,
  getColumnSql,
  getIndexesSql,
  getForeignKeysSql,
  getPrimaryKeyColumnsSql,
  normalizeColumns,
  normalizeIndexes,
  normalizeForeignKeys,
} from "./helpers/driver-helpers";

// ─────────────────────────────────────────────────────────────────────────────
// 동적 엔티티 팩토리
// ─────────────────────────────────────────────────────────────────────────────

interface SchemaTestResult {
  EntityClass: new () => any;
  tableName: string;
}

function shortTableName(prefix: string): string {
  const ts = String(Date.now()).slice(-7);
  return `${prefix}_${ts}`;
}

function createBasicSchemaEntity(baseName = "schema_test"): SchemaTestResult {
  const tableName = generateTableName(baseName);

  const DynamicClass = class {} as any;
  Object.defineProperty(DynamicClass, "name", {
    value: tableName,
    writable: false,
  });

  getScannerInstance(ColumnScanner).clear();

  // id (PK)
  Reflect.defineMetadata("design:type", Number, DynamicClass.prototype, "id");
  PrimaryGeneratedColumn()(DynamicClass.prototype, "id");

  // name (VARCHAR)
  Reflect.defineMetadata("design:type", String, DynamicClass.prototype, "name");
  Column()(DynamicClass.prototype, "name");

  // age (INT)
  Reflect.defineMetadata("design:type", Number, DynamicClass.prototype, "age");
  Column({ type: "int" })(DynamicClass.prototype, "age");

  // email (VARCHAR, nullable)
  Reflect.defineMetadata(
    "design:type",
    String,
    DynamicClass.prototype,
    "email",
  );
  Column({ type: "varchar", length: 255, nullable: true })(
    DynamicClass.prototype,
    "email",
  );

  Entity()(DynamicClass);

  return { EntityClass: DynamicClass, tableName };
}

interface IndexedEntityResult {
  EntityClass: new () => any;
  tableName: string;
}

function createIndexedEntity(baseName = "idx_test"): IndexedEntityResult {
  const tableName = generateTableName(baseName);

  const DynamicClass = class {} as any;
  Object.defineProperty(DynamicClass, "name", {
    value: tableName,
    writable: false,
  });

  getScannerInstance(ColumnScanner).clear();

  // id (PK)
  Reflect.defineMetadata("design:type", Number, DynamicClass.prototype, "id");
  PrimaryGeneratedColumn()(DynamicClass.prototype, "id");

  // name (VARCHAR) + @Index
  Reflect.defineMetadata("design:type", String, DynamicClass.prototype, "name");
  Column()(DynamicClass.prototype, "name");
  Index()(DynamicClass.prototype, "name");

  // email (VARCHAR) + @Index
  Reflect.defineMetadata(
    "design:type",
    String,
    DynamicClass.prototype,
    "email",
  );
  Column({ type: "varchar", length: 255 })(DynamicClass.prototype, "email");
  Index()(DynamicClass.prototype, "email");

  Entity()(DynamicClass);

  return { EntityClass: DynamicClass, tableName };
}

interface FkEntitiesResult {
  ParentClass: new () => any;
  ChildClass: new () => any;
  parentTableName: string;
  childTableName: string;
}

function createFkTestEntities(): FkEntitiesResult {
  const parentTableName = shortTableName("sp");
  const childTableName = shortTableName("sc");

  getScannerInstance(ColumnScanner).clear();
  getScannerInstance(ManyToOneScanner).clear();

  // ── ParentClass ─────────────────────────────────────────────────────────
  const ParentClass = class {} as any;
  Object.defineProperty(ParentClass, "name", {
    value: parentTableName,
    writable: false,
  });

  Reflect.defineMetadata("design:type", Number, ParentClass.prototype, "id");
  PrimaryGeneratedColumn()(ParentClass.prototype, "id");

  Reflect.defineMetadata("design:type", String, ParentClass.prototype, "name");
  Column()(ParentClass.prototype, "name");

  Entity()(ParentClass);

  // ── ChildClass ──────────────────────────────────────────────────────────
  const ChildClass = class {} as any;
  Object.defineProperty(ChildClass, "name", {
    value: childTableName,
    writable: false,
  });

  Reflect.defineMetadata("design:type", Number, ChildClass.prototype, "id");
  PrimaryGeneratedColumn()(ChildClass.prototype, "id");

  Reflect.defineMetadata("design:type", String, ChildClass.prototype, "title");
  Column()(ChildClass.prototype, "title");

  // FK 컬럼
  Reflect.defineMetadata(
    "design:type",
    Number,
    ChildClass.prototype,
    "parentFk",
  );
  Column({ type: "int", nullable: true })(ChildClass.prototype, "parentFk");

  // @ManyToOne
  Reflect.defineMetadata(
    "design:type",
    ParentClass,
    ChildClass.prototype,
    "parent",
  );
  ManyToOne(() => ParentClass, (e: any) => e.parent, {
    joinColumn: "parentFk",
  })(ChildClass.prototype, "parent");

  Entity()(ChildClass);

  return { ParentClass, ChildClass, parentTableName, childTableName };
}

// ─────────────────────────────────────────────────────────────────────────────
// 테스트 스위트
// ─────────────────────────────────────────────────────────────────────────────

describe.each(getTestDrivers())(
  "[Integration] SchemaGenerator (synchronize) ($label)",
  ({ type, options }: TestDriverConfig) => {
    // ─── 테이블 생성 ─────────────────────────────────────────────────────────

    describe("테이블 자동 생성", () => {
      let conn: TestConnectionResult;
      let entity: SchemaTestResult;

      afterEach(async () => {
        try {
          if (entity) await dropTestTable(entity.tableName);
        } catch {
          // ignore
        }
        if (conn) await conn.cleanup();
      }, 15000);

      it("synchronize: true 시 엔티티 테이블이 자동으로 생성되어야 한다", async () => {
        conn = await createTestConnection(
          { synchronize: true, logging: false, ...options },
          () => {
            entity = createBasicSchemaEntity();
            return { entities: [entity.EntityClass] };
          },
        );

        // 테이블 존재 확인
        const result = await rawQuery(hasTableSql(type, entity.tableName));
        const rs = result?.results ?? result;
        const rows = Array.isArray(rs) ? rs : rs ? [rs] : [];
        expect(rows.length).toBeGreaterThan(0);
      }, 30000);

      it("생성된 테이블에 정의한 컬럼이 모두 존재해야 한다", async () => {
        conn = await createTestConnection(
          { synchronize: true, logging: false, ...options },
          () => {
            entity = createBasicSchemaEntity();
            return { entities: [entity.EntityClass] };
          },
        );

        const result = await rawQuery(getColumnsSql(type, entity.tableName));
        const rs = result?.results ?? result;
        const columns = Array.isArray(rs) ? rs : [rs];
        const normalized = normalizeColumns(type, columns);
        const colNames = normalized.map((c) => c.name);

        expect(colNames).toContain("id");
        expect(colNames).toContain("name");
        expect(colNames).toContain("age");
        expect(colNames).toContain("email");
      }, 30000);

      it("PrimaryGeneratedColumn이 AUTO_INCREMENT PK로 생성되어야 한다", async () => {
        conn = await createTestConnection(
          { synchronize: true, logging: false, ...options },
          () => {
            entity = createBasicSchemaEntity();
            return { entities: [entity.EntityClass] };
          },
        );

        const result = await rawQuery(getColumnSql(type, entity.tableName, "id"));
        const rs = result?.results ?? result;
        const rows = Array.isArray(rs) ? rs : [rs];
        const normalized = normalizeColumns(type, rows);
        const idCol = normalized[0];

        expect(idCol).toBeDefined();
        expect(idCol.isAutoIncrement).toBe(true);

        if (type === "mysql") {
          // MySQL: SHOW COLUMNS Key 필드로 PK 확인
          expect(idCol.isPrimary).toBe(true);
        } else {
          // PostgreSQL: 별도 PK 쿼리로 확인
          const pkResult = await rawQuery(getPrimaryKeyColumnsSql(entity.tableName));
          const pkRs = pkResult?.results ?? pkResult;
          const pkRows = Array.isArray(pkRs) ? pkRs : pkRs ? [pkRs] : [];
          const pkCols = pkRows.map((r: any) => r.column_name);
          expect(pkCols).toContain("id");
        }
      }, 30000);
    });

    // ─── 인덱스 생성 ─────────────────────────────────────────────────────────

    describe("@Index 인덱스 생성", () => {
      let conn: TestConnectionResult;
      let entity: IndexedEntityResult;

      afterEach(async () => {
        try {
          if (entity) await dropTestTable(entity.tableName);
        } catch {
          // ignore
        }
        if (conn) await conn.cleanup();
      }, 15000);

      it("@Index 데코레이터가 있는 컬럼에 DB 인덱스가 생성되어야 한다", async () => {
        conn = await createTestConnection(
          { synchronize: true, logging: false, ...options },
          () => {
            entity = createIndexedEntity();
            return { entities: [entity.EntityClass] };
          },
        );

        const result = await rawQuery(getIndexesSql(type, entity.tableName));
        const rs = result?.results ?? result;
        const indexes = Array.isArray(rs) ? rs : [rs];
        const normalized = normalizeIndexes(type, indexes);
        const indexNames = normalized.map((idx) => idx.name);

        // INDEX_<tableName>_name, INDEX_<tableName>_email 형식
        const expectedNameIndex = `INDEX_${entity.tableName}_name`;
        const expectedEmailIndex = `INDEX_${entity.tableName}_email`;

        // PostgreSQL lowercases index names, so check case-insensitively
        const indexNamesLower = indexNames.map((n) => n.toLowerCase());
        expect(indexNamesLower).toContain(expectedNameIndex.toLowerCase());
        expect(indexNamesLower).toContain(expectedEmailIndex.toLowerCase());
      }, 30000);
    });

    // ─── 외래키 생성 ─────────────────────────────────────────────────────────

    describe("@ManyToOne FK 제약 생성", () => {
      let conn: TestConnectionResult;
      let entities: FkEntitiesResult;

      afterEach(async () => {
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

      it("@ManyToOne 관계가 DB FK 제약으로 생성되어야 한다", async () => {
        conn = await createTestConnection(
          { synchronize: true, logging: false, ...options },
          () => {
            entities = createFkTestEntities();
            // Parent를 먼저 등록해야 FK 대상 테이블이 존재
            return {
              entities: [entities.ParentClass, entities.ChildClass],
            };
          },
        );

        // FK 확인
        const result = await rawQuery(
          getForeignKeysSql(type, entities.childTableName),
        );
        const rs = result?.results ?? result;
        const fkRows = Array.isArray(rs) ? rs : rs ? [rs] : [];
        const fks = normalizeForeignKeys(type, fkRows);

        expect(fks.length).toBeGreaterThan(0);

        // parentFk 컬럼이 FK로 등록되어 있는지 확인
        const parentFk = fks.find(
          (fk) => fk.columnName === "parentFk",
        );
        expect(parentFk).toBeDefined();
        expect(parentFk!.referencedTableName).toBe(entities.parentTableName);
        expect(parentFk!.referencedColumnName).toBe("id");
      }, 30000);
    });

    // ─── DROP 후 재생성 ───────────────────────────────────────────────────────

    describe("DROP TABLE 후 재생성", () => {
      it("테이블 DROP 후 재연결(synchronize)하면 테이블이 재생성되어야 한다", async () => {
        let entity: SchemaTestResult;

        // 1. 첫 번째 연결 — 테이블 생성
        let conn = await createTestConnection(
          { synchronize: true, logging: false, ...options },
          () => {
            entity = createBasicSchemaEntity("recreate");
            return { entities: [entity!.EntityClass] };
          },
        );

        // 테이블 존재 확인
        let result = await rawQuery(hasTableSql(type, entity!.tableName));
        let rs = result?.results ?? result;
        let rows = Array.isArray(rs) ? rs : rs ? [rs] : [];
        expect(rows.length).toBeGreaterThan(0);

        // 2. 테이블 DROP
        await dropTestTable(entity!.tableName);

        // DROP 확인
        result = await rawQuery(hasTableSql(type, entity!.tableName));
        rs = result?.results ?? result;
        const afterDrop = Array.isArray(rs) ? rs : rs ? [rs] : [];
        expect(afterDrop.length).toBe(0);

        // 3. 연결 종료
        await conn.cleanup();

        // 4. 재연결 — 같은 엔티티 클래스(같은 테이블명)
        // 새로운 엔티티를 같은 테이블명으로 생성
        conn = await createTestConnection(
          { synchronize: true, logging: false, ...options },
          () => {
            const tableName = entity!.tableName;
            const DynamicClass = class {} as any;
            Object.defineProperty(DynamicClass, "name", {
              value: tableName,
              writable: false,
            });

            getScannerInstance(ColumnScanner).clear();

            Reflect.defineMetadata("design:type", Number, DynamicClass.prototype, "id");
            PrimaryGeneratedColumn()(DynamicClass.prototype, "id");
            Reflect.defineMetadata("design:type", String, DynamicClass.prototype, "name");
            Column()(DynamicClass.prototype, "name");
            Reflect.defineMetadata("design:type", Number, DynamicClass.prototype, "age");
            Column({ type: "int" })(DynamicClass.prototype, "age");
            Reflect.defineMetadata("design:type", String, DynamicClass.prototype, "email");
            Column({ type: "varchar", length: 255, nullable: true })(DynamicClass.prototype, "email");

            Entity()(DynamicClass);

            return { entities: [DynamicClass] };
          },
        );

        // 5. 테이블 재생성 확인
        result = await rawQuery(hasTableSql(type, entity!.tableName));
        rs = result?.results ?? result;
        rows = Array.isArray(rs) ? rs : rs ? [rs] : [];
        expect(rows.length).toBeGreaterThan(0);

        // cleanup
        try {
          await dropTestTable(entity!.tableName);
        } catch {
          // ignore
        }
        await conn.cleanup();
      }, 60000);
    });
  },
);
