/**
 * PostgreSQL 드라이버 통합 테스트
 *
 * MySQL 통합 테스트와 동일한 시나리오를 PostgreSQL에서 실행하여
 * 드라이버별 SQL 차이(RETURNING, SERIAL, ON CONFLICT, 스키마 한정 식별자)가
 * 올바르게 동작하는지 검증합니다.
 *
 * ## 커버 시나리오
 * - CRUD 라운드트립 (SERIAL + RETURNING)
 * - FK 객체 할당 (ManyToOne)
 * - 부분 업데이트 FK 보존 (M-6)
 * - Upsert (ON CONFLICT)
 * - 트랜잭션 롤백 (BEGIN/COMMIT/ROLLBACK)
 * - 스키마 한정 식별자 (schema.table)
 *
 * 실행:
 *   INTEGRATION_TEST=true npx jest --testPathPattern="postgres-driver"
 *
 * 사전 조건:
 *   - PostgreSQL 서버 실행 중 (localhost:5432)
 *   - DB: multi_tenancy_db / User: postgres / Password: postgres
 */

import "reflect-metadata";
import sql, { raw } from "sql-template-tag";
import { EntityManager } from "../../src/core/EntityManager";
import { BaseRepository } from "../../src/core/BaseRepository";
import { TransactionSessionManager } from "../../src/dialects/TransactionSessionManager";
import { DatabaseClientOptions } from "../../src/core/DatabaseClientOptions";
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  OneToMany,
} from "../../src";
import { getScannerInstance } from "../../src/scanner/ScannerContainer";
import {
  ColumnScanner,
  ManyToOneScanner,
  OneToManyScanner,
} from "../../src/scanner";
import {
  createTestConnection,
  rawQuery,
  type TestConnectionResult,
} from "./helpers/test-connection";
import {
  createCrudTestEntity,
  createDynamicEntity,
  type DynamicEntityResult,
} from "./helpers/create-test-entity";

const INTEGRATION = process.env.INTEGRATION_TEST === "true";
const integrationDescribe = INTEGRATION ? describe : describe.skip;

/** PostgreSQL 연결 기본 옵션 */
const PG_BASE: Partial<DatabaseClientOptions> = {
  type: "postgres",
  host: process.env.PG_HOST || "localhost",
  port: parseInt(process.env.PG_PORT || "5432", 10),
  username: process.env.PG_USER || "postgres",
  password: process.env.PG_PASSWORD || "postgres",
  database: process.env.PG_DATABASE || "multi_tenancy_db",
};

/** 타임스탬프 기반 고유 스키마 이름 생성 */
function uniqueSchemaName(base: string): string {
  return `${base}_${Date.now()}`;
}

/** PostgreSQL에서 테이블 DROP (double-quote 사용) */
async function pgDropTable(
  schemaName: string,
  tableName: string,
): Promise<void> {
  try {
    await rawQuery(
      `DROP TABLE IF EXISTS "${schemaName}"."${tableName}" CASCADE`,
    );
  } catch {
    // ignore
  }
}

/** PostgreSQL에서 테이블 데이터 삭제 + 시퀀스 리셋 */
async function pgTruncateTable(
  schemaName: string,
  tableName: string,
): Promise<void> {
  try {
    await rawQuery(
      `TRUNCATE TABLE "${schemaName}"."${tableName}" RESTART IDENTITY CASCADE`,
    );
  } catch {
    // ignore — 테이블이 아직 없을 수 있음
  }
}

/** 스키마 DROP (cleanup 용) */
async function dropSchema(name: string): Promise<void> {
  try {
    await rawQuery(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
  } catch {
    // ignore
  }
}

/** find() 결과를 배열로 정규화 */
function toArray<T>(result: any): T[] {
  if (result === undefined || result === null) return [];
  if (Array.isArray(result)) return result;
  return [result];
}

/**
 * PostgreSQL 전용 OneToMany/ManyToOne 엔티티 쌍 생성
 */
function createPgRelationEntities() {
  const ts = String(Date.now()).slice(-7);
  const parentTableName = `tp_${ts}`;
  const childTableName = `tc_${ts}`;

  getScannerInstance(ColumnScanner).clear();
  getScannerInstance(ManyToOneScanner).clear();
  getScannerInstance(OneToManyScanner).clear();

  // ── Parent ──
  const ParentClass = class {} as any;
  Object.defineProperty(ParentClass, "name", {
    value: parentTableName,
    writable: false,
  });

  Reflect.defineMetadata("design:type", Number, ParentClass.prototype, "id");
  PrimaryGeneratedColumn()(ParentClass.prototype, "id");

  Reflect.defineMetadata("design:type", String, ParentClass.prototype, "name");
  Column()(ParentClass.prototype, "name");

  Reflect.defineMetadata(
    "design:type",
    Array,
    ParentClass.prototype,
    "children",
  );
  OneToMany(() => ChildClass, { mappedBy: "parent" })(
    ParentClass.prototype,
    "children",
  );

  Entity()(ParentClass);

  // ── Child (id, title, age, parentFk, parent) ──
  const ChildClass = class {} as any;
  Object.defineProperty(ChildClass, "name", {
    value: childTableName,
    writable: false,
  });

  Reflect.defineMetadata("design:type", Number, ChildClass.prototype, "id");
  PrimaryGeneratedColumn()(ChildClass.prototype, "id");

  Reflect.defineMetadata("design:type", String, ChildClass.prototype, "title");
  Column()(ChildClass.prototype, "title");

  Reflect.defineMetadata("design:type", Number, ChildClass.prototype, "age");
  Column({ type: "int", nullable: true })(ChildClass.prototype, "age");

  Reflect.defineMetadata(
    "design:type",
    Number,
    ChildClass.prototype,
    "parentFk",
  );
  Column({ type: "int", nullable: true })(ChildClass.prototype, "parentFk");

  Reflect.defineMetadata(
    "design:type",
    ParentClass,
    ChildClass.prototype,
    "parent",
  );
  ManyToOne(() => ParentClass, (e: any) => e.parent, {
    joinColumn: "parentFk",
    eager: true,
  })(ChildClass.prototype, "parent");

  Entity()(ChildClass);

  return { ParentClass, ChildClass, parentTableName, childTableName };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 1: CRUD 라운드트립 (SERIAL + RETURNING)
// ═══════════════════════════════════════════════════════════════════════════════

integrationDescribe(
  "[Integration][Postgres] CRUD 라운드트립 (SERIAL + RETURNING)",
  () => {
    const schema = uniqueSchemaName("tpg_crud");
    let conn: TestConnectionResult;
    let em: EntityManager;
    let testEntity: DynamicEntityResult;

    beforeAll(async () => {
      conn = await createTestConnection(
        { ...PG_BASE, schema, synchronize: true, logging: false },
        () => {
          testEntity = createCrudTestEntity("tpg_crud_item");
          return { entities: [testEntity.EntityClass] };
        },
      );
      em = conn.em;
    }, 30000);

    afterAll(async () => {
      await dropSchema(schema);
      if (conn) await conn.cleanup();
    }, 15000);

    beforeEach(async () => {
      await pgTruncateTable(schema, testEntity.tableName);
    });

    it("save()가 SERIAL로 자동 생성된 id를 반환해야 한다", async () => {
      const saved = await em.save(testEntity.EntityClass, {
        name: "Alice",
        age: 30,
      });

      expect(saved).toBeDefined();
      expect(saved.id).toBeDefined();
      expect(typeof saved.id).toBe("number");
      expect(saved.id).toBeGreaterThan(0);
    });

    it("save → findOne 라운드트립이 정확해야 한다", async () => {
      const saved = await em.save(testEntity.EntityClass, {
        name: "Bob",
        age: 25,
        email: "bob@pg.com",
      });

      const found = await em.findOne(testEntity.EntityClass, {
        where: { id: saved.id },
      });

      expect(found).not.toBeNull();
      expect(found!.name).toBe("Bob");
      expect(found!.age).toBe(25);
      expect(found!.email).toBe("bob@pg.com");
    });

    it("여러 엔티티의 SERIAL id가 순차적이어야 한다", async () => {
      const a = await em.save(testEntity.EntityClass, {
        name: "A",
        age: 1,
      });
      const b = await em.save(testEntity.EntityClass, {
        name: "B",
        age: 2,
      });
      const c = await em.save(testEntity.EntityClass, {
        name: "C",
        age: 3,
      });

      expect(a.id).toBeLessThan(b.id);
      expect(b.id).toBeLessThan(c.id);
    });

    it("save()는 단일 객체를 반환해야 한다 (J-4)", async () => {
      const result = await em.save(testEntity.EntityClass, {
        name: "Single",
        age: 10,
      });

      expect(Array.isArray(result)).toBe(false);
      expect(result).not.toBeNull();
      expect(result !== undefined).toBe(true);
      expect(result).toHaveProperty("id");
    });

    it("존재하지 않는 ID 조회 시 null 반환 (J-5)", async () => {
      const result = await em.findOne(testEntity.EntityClass, {
        where: { id: 999999 },
      });

      expect(result).toBeNull();
      expect(result === null).toBe(true);
      expect(result === undefined).toBe(false);
    });

    it("빈 테이블에서 find()가 에러 없이 반환해야 한다 (J-6)", async () => {
      const result = await em.find(testEntity.EntityClass, {});
      const items = toArray(result);
      expect(items).toHaveLength(0);
    });

    it("nullable 컬럼이 null인 엔티티도 라운드트립 가능해야 한다", async () => {
      const saved = await em.save(testEntity.EntityClass, {
        name: "NoEmail",
        age: 20,
        email: null,
      });

      const found = await em.findOne(testEntity.EntityClass, {
        where: { id: saved.id },
      });

      expect(found).not.toBeNull();
      expect(found!.name).toBe("NoEmail");
      expect(found!.email == null).toBe(true);
    });

    it("삭제 후 findOne이 null을 반환해야 한다", async () => {
      const saved = await em.save(testEntity.EntityClass, {
        name: "DeleteMe",
        age: 1,
      });

      const repo = em.getRepository(testEntity.EntityClass);
      await repo.delete({ id: saved.id } as any);

      const found = await em.findOne(testEntity.EntityClass, {
        where: { id: saved.id },
      });
      expect(found).toBeNull();
    });
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 2: FK 객체 할당 + 부분 업데이트 FK 보존
// ═══════════════════════════════════════════════════════════════════════════════

integrationDescribe(
  "[Integration][Postgres] FK 객체 할당 + 부분 업데이트 (M-6)",
  () => {
    const schema = uniqueSchemaName("tpg_fk");
    let conn: TestConnectionResult;
    let em: EntityManager;
    let entities: ReturnType<typeof createPgRelationEntities>;
    let parentRepo: BaseRepository<any>;
    let childRepo: BaseRepository<any>;

    beforeAll(async () => {
      conn = await createTestConnection(
        { ...PG_BASE, schema, synchronize: true, logging: false },
        () => {
          entities = createPgRelationEntities();
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
      await dropSchema(schema);
      if (conn) await conn.cleanup();
    }, 15000);

    beforeEach(async () => {
      await pgTruncateTable(schema, entities.childTableName);
      await pgTruncateTable(schema, entities.parentTableName);
    });

    // ─── J-2: 관계 객체 할당 ─────────────────────────────────

    it("J-2: parent 객체 할당 후 save → FK가 DB에 저장되어야 한다", async () => {
      const parent = await parentRepo.save({ name: "Alice" });
      const saved = await childRepo.save({
        title: "Nabi",
        parent: parent,
      });

      const found = await childRepo.findOne({ where: { id: saved.id } });
      const child = Array.isArray(found) ? found[0] : found;

      expect(child).toBeDefined();
      expect(child.parent).toBeDefined();
      expect(child.parent).not.toBeNull();
      expect(child.parent.id).toBe(parent.id);
      expect(child.parent.name).toBe("Alice");
    });

    it("J-2: raw 쿼리로 FK 컬럼 값 직접 확인", async () => {
      const parent = await parentRepo.save({ name: "Bob" });
      const saved = await childRepo.save({
        title: "Cheese",
        parent: parent,
      });

      const rows = await rawQuery(
        `SELECT "parentFk" FROM "${schema}"."${entities.childTableName}" WHERE "id" = ${saved.id}`,
      );
      const row = Array.isArray(rows) ? rows[0] : rows;
      expect(Number(row?.parentFk)).toBe(parent.id);
    });

    // ─── J-3: FK 직접 지정 ───────────────────────────────────

    it("J-3: parentFk 직접 지정 → FK가 저장되어야 한다", async () => {
      const parent = await parentRepo.save({ name: "Direct" });
      const saved = await childRepo.save({
        title: "DirectChild",
        parentFk: parent.id,
      });

      const found = await childRepo.findOne({ where: { id: saved.id } });
      const child = Array.isArray(found) ? found[0] : found;

      expect(child.parent).toBeDefined();
      expect(child.parent.id).toBe(parent.id);
    });

    // ─── M-1: 부모 재할당 ────────────────────────────────────

    it("M-1: parent를 다른 객체로 교체하면 FK가 변경되어야 한다", async () => {
      const parent1 = await parentRepo.save({ name: "Owner1" });
      const parent2 = await parentRepo.save({ name: "Owner2" });

      const saved = await childRepo.save({
        title: "Reassign",
        parent: parent1,
      });

      await childRepo.save({
        id: saved.id,
        title: "Reassign",
        parent: parent2,
      });

      const found = await childRepo.findOne({ where: { id: saved.id } });
      const child = Array.isArray(found) ? found[0] : found;
      expect(child.parent.id).toBe(parent2.id);
      expect(child.parent.name).toBe("Owner2");
    });

    // ─── M-2: 관계 해제 ─────────────────────────────────────

    it("M-2: parent = null → FK가 NULL이 되어야 한다", async () => {
      const parent = await parentRepo.save({ name: "NullOwner" });
      const saved = await childRepo.save({
        title: "Orphan",
        parent: parent,
      });

      await childRepo.save({
        id: saved.id,
        title: "Orphan",
        parent: null,
      });

      const rows = await rawQuery(
        `SELECT "parentFk" FROM "${schema}"."${entities.childTableName}" WHERE "id" = ${saved.id}`,
      );
      const row = Array.isArray(rows) ? rows[0] : rows;
      expect(row?.parentFk).toBeNull();
    });

    // ─── M-6a: 부분 업데이트 FK 보존 ────────────────────────

    it("M-6a: save({ id, title }) 시 기존 FK가 보존되어야 한다", async () => {
      const parent = await parentRepo.save({ name: "Preserved" });
      const saved = await childRepo.save({
        title: "Nabi",
        age: 3,
        parent: parent,
      });

      // 부분 업데이트: title만 변경
      await childRepo.save({
        id: saved.id,
        title: "NewName",
      });

      const rows = await rawQuery(
        `SELECT "parentFk", "age", "title" FROM "${schema}"."${entities.childTableName}" WHERE "id" = ${saved.id}`,
      );
      const row = Array.isArray(rows) ? rows[0] : rows;

      expect(Number(row?.parentFk)).toBe(parent.id);
      expect(row?.title).toBe("NewName");
    });

    it("M-6a: 부분 업데이트 후 findOne으로 FK 관계 로딩 검증", async () => {
      const parent = await parentRepo.save({ name: "EagerCheck" });
      const saved = await childRepo.save({
        title: "Cat",
        parent: parent,
      });

      await childRepo.save({
        id: saved.id,
        title: "Updated",
      });

      const found = await childRepo.findOne({ where: { id: saved.id } });
      const child = Array.isArray(found) ? found[0] : found;

      expect(child.title).toBe("Updated");
      expect(child.parent).not.toBeNull();
      expect(child.parent.id).toBe(parent.id);
    });

    // ─── M-6b: 다른 컬럼 보존 ───────────────────────────────

    it("M-6b: save({ id, title }) 시 age가 보존되어야 한다", async () => {
      const saved = await childRepo.save({
        title: "Aged",
        age: 5,
      });

      await childRepo.save({
        id: saved.id,
        title: "StillAged",
      });

      const rows = await rawQuery(
        `SELECT "age", "title" FROM "${schema}"."${entities.childTableName}" WHERE "id" = ${saved.id}`,
      );
      const row = Array.isArray(rows) ? rows[0] : rows;

      expect(Number(row?.age)).toBe(5);
      expect(row?.title).toBe("StillAged");
    });

    it("M-6b: id만 지정한 빈 업데이트 시 모든 컬럼 보존", async () => {
      const parent = await parentRepo.save({ name: "Full" });
      const saved = await childRepo.save({
        title: "Full",
        age: 7,
        parent: parent,
      });

      await childRepo.save({ id: saved.id });

      const rows = await rawQuery(
        `SELECT "title", "age", "parentFk" FROM "${schema}"."${entities.childTableName}" WHERE "id" = ${saved.id}`,
      );
      const row = Array.isArray(rows) ? rows[0] : rows;

      expect(row?.title).toBe("Full");
      expect(Number(row?.age)).toBe(7);
      expect(Number(row?.parentFk)).toBe(parent.id);
    });

    // ─── M-6c: FK 명시적 변경 ───────────────────────────────

    it("M-6c: 부분 업데이트에서 parent를 다른 객체로 변경", async () => {
      const p1 = await parentRepo.save({ name: "Old" });
      const p2 = await parentRepo.save({ name: "New" });
      const saved = await childRepo.save({
        title: "Switch",
        age: 3,
        parent: p1,
      });

      await childRepo.save({
        id: saved.id,
        parent: p2,
      });

      const rows = await rawQuery(
        `SELECT "parentFk", "title", "age" FROM "${schema}"."${entities.childTableName}" WHERE "id" = ${saved.id}`,
      );
      const row = Array.isArray(rows) ? rows[0] : rows;

      expect(Number(row?.parentFk)).toBe(p2.id);
      expect(row?.title).toBe("Switch");
      expect(Number(row?.age)).toBe(3);
    });

    // ─── M-6d: FK 명시적 null ───────────────────────────────

    it("M-6d: 부분 업데이트에서 parent = null로 해제", async () => {
      const parent = await parentRepo.save({ name: "Detach" });
      const saved = await childRepo.save({
        title: "Detach",
        age: 4,
        parent: parent,
      });

      await childRepo.save({
        id: saved.id,
        parent: null,
      });

      const rows = await rawQuery(
        `SELECT "parentFk", "title", "age" FROM "${schema}"."${entities.childTableName}" WHERE "id" = ${saved.id}`,
      );
      const row = Array.isArray(rows) ? rows[0] : rows;

      expect(row?.parentFk).toBeNull();
      expect(row?.title).toBe("Detach");
      expect(Number(row?.age)).toBe(4);
    });

    // ─── M-4: FK 제약 위반 삭제 ─────────────────────────────

    it("M-4: 자식이 있는 부모 삭제 시 FK 제약 위반 에러", async () => {
      const parent = await parentRepo.save({ name: "Protected" });
      await childRepo.save({ title: "Cat", parentFk: parent.id });

      await expect(
        parentRepo.delete({ id: parent.id } as any),
      ).rejects.toThrow();
    });

    it("M-4: 자식 삭제 후 부모 삭제 성공", async () => {
      const parent = await parentRepo.save({ name: "Safe" });
      const cat = await childRepo.save({
        title: "SafeCat",
        parentFk: parent.id,
      });

      await childRepo.delete({ id: cat.id } as any);
      await parentRepo.delete({ id: parent.id } as any);

      // 삭제 후 부모가 없어야 한다
      const found = await parentRepo.findOne({ where: { id: parent.id } });
      expect(found == null).toBe(true);
    });
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 3: Upsert (ON CONFLICT)
// ═══════════════════════════════════════════════════════════════════════════════

integrationDescribe("[Integration][Postgres] Upsert (ON CONFLICT)", () => {
  const schema = uniqueSchemaName("tpg_upsert");
  let conn: TestConnectionResult;
  let em: EntityManager;
  let testEntity: DynamicEntityResult;

  beforeAll(async () => {
    conn = await createTestConnection(
      { ...PG_BASE, schema, synchronize: true, logging: false },
      () => {
        testEntity = createDynamicEntity("tpg_upsert_item", [
          { name: "id", designType: Number, primary: true },
          {
            name: "slug",
            designType: String,
            options: { type: "varchar", length: 255 },
          },
          {
            name: "title",
            designType: String,
            options: { type: "varchar", length: 255 },
          },
          {
            name: "viewCount",
            designType: Number,
            options: { type: "int", nullable: true },
          },
        ]);
        return { entities: [testEntity.EntityClass] };
      },
    );
    em = conn.em;

    // slug에 UNIQUE 인덱스 추가
    await rawQuery(
      `CREATE UNIQUE INDEX "uq_${testEntity.tableName}_slug" ON "${schema}"."${testEntity.tableName}" ("slug")`,
    );
  }, 30000);

  afterAll(async () => {
    await dropSchema(schema);
    if (conn) await conn.cleanup();
  }, 15000);

  beforeEach(async () => {
    await pgTruncateTable(schema, testEntity.tableName);
  });

  it("최초 실행 시 INSERT 되어야 한다", async () => {
    await em.upsert(
      testEntity.EntityClass,
      { slug: "hello-world", title: "Hello World", viewCount: 0 },
      ["slug"] as any,
    );

    const found = await em.findOne(testEntity.EntityClass, {
      where: { slug: "hello-world" },
    });
    expect(found).not.toBeNull();
    expect(found!.title).toBe("Hello World");
    expect(found!.viewCount).toBe(0);
  });

  it("동일 slug로 재실행 시 UPDATE 되어야 한다", async () => {
    // 최초 INSERT
    await em.upsert(
      testEntity.EntityClass,
      { slug: "update-me", title: "Original", viewCount: 1 },
      ["slug"] as any,
    );

    // 동일 slug로 upsert → UPDATE
    await em.upsert(
      testEntity.EntityClass,
      { slug: "update-me", title: "Updated", viewCount: 10 },
      ["slug"] as any,
    );

    const found = await em.findOne(testEntity.EntityClass, {
      where: { slug: "update-me" },
    });
    expect(found).not.toBeNull();
    expect(found!.title).toBe("Updated");
    expect(found!.viewCount).toBe(10);
  });

  it("충돌하지 않는 slug는 별도 레코드로 INSERT", async () => {
    await em.upsert(
      testEntity.EntityClass,
      { slug: "post-a", title: "Post A", viewCount: 1 },
      ["slug"] as any,
    );

    await em.upsert(
      testEntity.EntityClass,
      { slug: "post-b", title: "Post B", viewCount: 2 },
      ["slug"] as any,
    );

    const items = toArray(await em.find(testEntity.EntityClass, {}));
    expect(items.length).toBe(2);
  });

  it("upsert 후 레코드가 하나만 존재해야 한다 (멱등성)", async () => {
    for (let i = 0; i < 5; i++) {
      await em.upsert(
        testEntity.EntityClass,
        { slug: "idempotent", title: `Title_${i}`, viewCount: i },
        ["slug"] as any,
      );
    }

    const rows = await rawQuery(
      `SELECT COUNT(*) as cnt FROM "${schema}"."${testEntity.tableName}" WHERE "slug" = 'idempotent'`,
    );
    const row = Array.isArray(rows) ? rows[0] : rows;
    expect(Number(row?.cnt)).toBe(1);

    const found = await em.findOne(testEntity.EntityClass, {
      where: { slug: "idempotent" },
    });
    expect(found!.title).toBe("Title_4");
    expect(found!.viewCount).toBe(4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 4: 트랜잭션 롤백 (BEGIN/COMMIT/ROLLBACK)
// ═══════════════════════════════════════════════════════════════════════════════

integrationDescribe(
  "[Integration][Postgres] 트랜잭션 롤백",
  () => {
    const schema = uniqueSchemaName("tpg_txn");
    let conn: TestConnectionResult;
    let em: EntityManager;
    let testEntity: DynamicEntityResult;

    beforeAll(async () => {
      conn = await createTestConnection(
        { ...PG_BASE, schema, synchronize: true, logging: false },
        () => {
          testEntity = createCrudTestEntity("tpg_txn_item");
          return { entities: [testEntity.EntityClass] };
        },
      );
      em = conn.em;
    }, 30000);

    afterAll(async () => {
      await dropSchema(schema);
      if (conn) await conn.cleanup();
    }, 15000);

    beforeEach(async () => {
      await pgTruncateTable(schema, testEntity.tableName);
    });

    it("롤백하면 INSERT가 반영되지 않아야 한다", async () => {
      const session = new TransactionSessionManager();
      try {
        await session.connect();
        await session.startTransaction();

        const tbl = `"${schema}"."${testEntity.tableName}"`;
        await session.query(
          sql`INSERT INTO ${raw(tbl)} ("name", "age") VALUES (${"RolledBack"}, ${99})`,
        );

        await session.rollback();
      } finally {
        await session.close();
      }

      const found = toArray(
        await em.find(testEntity.EntityClass, {
          where: { name: "RolledBack" },
        }),
      );
      expect(found).toHaveLength(0);
    });

    it("커밋하면 INSERT가 유지되어야 한다", async () => {
      const session = new TransactionSessionManager();
      try {
        await session.connect();
        await session.startTransaction();

        const tbl = `"${schema}"."${testEntity.tableName}"`;
        await session.query(
          sql`INSERT INTO ${raw(tbl)} ("name", "age") VALUES (${"Committed"}, ${30})`,
        );

        await session.commit();
      } finally {
        await session.close();
      }

      const result = await em.findOne(testEntity.EntityClass, {
        where: { name: "Committed" },
      });
      expect(result).toBeDefined();
      expect(result!.name).toBe("Committed");
    });

    it("여러 INSERT 후 롤백하면 전부 반영되지 않아야 한다", async () => {
      const session = new TransactionSessionManager();
      try {
        await session.connect();
        await session.startTransaction();

        const tbl = `"${schema}"."${testEntity.tableName}"`;
        await session.query(
          sql`INSERT INTO ${raw(tbl)} ("name", "age") VALUES (${"A"}, ${1})`,
        );
        await session.query(
          sql`INSERT INTO ${raw(tbl)} ("name", "age") VALUES (${"B"}, ${2})`,
        );

        await session.rollback();
      } finally {
        await session.close();
      }

      const a = toArray(
        await em.find(testEntity.EntityClass, { where: { name: "A" } }),
      );
      const b = toArray(
        await em.find(testEntity.EntityClass, { where: { name: "B" } }),
      );
      expect(a).toHaveLength(0);
      expect(b).toHaveLength(0);
    });

    it("Savepoint 롤백 시 이전 INSERT는 유지되어야 한다", async () => {
      const session = new TransactionSessionManager();
      try {
        await session.connect();
        await session.startTransaction();

        const tbl = `"${schema}"."${testEntity.tableName}"`;

        // savepoint 이전 INSERT
        await session.query(
          sql`INSERT INTO ${raw(tbl)} ("name", "age") VALUES (${"Before"}, ${10})`,
        );

        await session.savepoint("sp1");

        // savepoint 이후 INSERT
        await session.query(
          sql`INSERT INTO ${raw(tbl)} ("name", "age") VALUES (${"After"}, ${20})`,
        );

        await session.rollbackTo("sp1");
        await session.commit();
      } finally {
        await session.close();
      }

      const before = await em.findOne(testEntity.EntityClass, {
        where: { name: "Before" },
      });
      expect(before).toBeDefined();
      expect(before!.name).toBe("Before");

      const after = toArray(
        await em.find(testEntity.EntityClass, { where: { name: "After" } }),
      );
      expect(after).toHaveLength(0);
    });

    it("SERIALIZABLE 격리 수준으로 트랜잭션 가능해야 한다", async () => {
      const session = new TransactionSessionManager();
      try {
        await session.connect();
        await session.startTransaction("SERIALIZABLE");

        const tbl = `"${schema}"."${testEntity.tableName}"`;
        await session.query(
          sql`INSERT INTO ${raw(tbl)} ("name", "age") VALUES (${"Serial"}, ${60})`,
        );

        await session.commit();
      } finally {
        await session.close();
      }

      const result = await em.findOne(testEntity.EntityClass, {
        where: { name: "Serial" },
      });
      expect(result).toBeDefined();
      expect(result!.name).toBe("Serial");
    });

    it("EntityManager save()가 자동 커밋해야 한다", async () => {
      const repo = em.getRepository(testEntity.EntityClass);
      const saved = await repo.save({
        name: "AutoCommit",
        age: 42,
      });

      expect(saved.id).toBeDefined();

      const found = await em.findOne(testEntity.EntityClass, {
        where: { name: "AutoCommit" },
      });
      expect(found).toBeDefined();
      expect(found!.name).toBe("AutoCommit");
    });
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 5: 스키마 한정 식별자 검증
//
// 주: 멀티 스키마 격리는 multi-tenancy-postgres.test.ts에서 커버됨.
// 여기서는 단일 커넥션 내에서 스키마 한정 식별자가 올바르게 동작하는지 확인.
// ═══════════════════════════════════════════════════════════════════════════════

integrationDescribe(
  "[Integration][Postgres] 스키마 한정 식별자",
  () => {
    const schema = uniqueSchemaName("tpg_schema");
    let conn: TestConnectionResult;
    let em: EntityManager;
    let testEntity: DynamicEntityResult;

    beforeAll(async () => {
      conn = await createTestConnection(
        { ...PG_BASE, schema, synchronize: true, logging: false },
        () => {
          testEntity = createCrudTestEntity("tpg_schema_item");
          return { entities: [testEntity.EntityClass] };
        },
      );
      em = conn.em;
    }, 30000);

    afterAll(async () => {
      await dropSchema(schema);
      if (conn) await conn.cleanup();
    }, 15000);

    it("테이블이 지정된 스키마에 생성되어야 한다", async () => {
      const tables = await rawQuery(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = '${schema}'`,
      );
      const tableNames = (Array.isArray(tables) ? tables : [tables]).map(
        (r: any) => r.table_name,
      );
      expect(tableNames.length).toBeGreaterThan(0);
    });

    it("public 스키마에는 테스트 테이블이 생성되지 않아야 한다", async () => {
      const tables = await rawQuery(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'tpg_schema%'`,
      );
      const items = Array.isArray(tables) ? tables : tables ? [tables] : [];
      expect(items.length).toBe(0);
    });

    it("스키마 한정 테이블에 CRUD가 정상 동작해야 한다", async () => {
      const saved = await em.save(testEntity.EntityClass, {
        name: "SchemaTest",
        age: 42,
      });

      expect(saved.id).toBeGreaterThan(0);

      const found = await em.findOne(testEntity.EntityClass, {
        where: { id: saved.id },
      });
      expect(found).not.toBeNull();
      expect(found!.name).toBe("SchemaTest");
    });

    it("raw 쿼리로 스키마 한정 테이블 직접 조회 가능해야 한다", async () => {
      await em.save(testEntity.EntityClass, { name: "RawCheck", age: 1 });

      const rows = await rawQuery(
        `SELECT "name" FROM "${schema}"."${testEntity.tableName}" WHERE "name" = 'RawCheck'`,
      );
      const row = Array.isArray(rows) ? rows[0] : rows;
      expect(row?.name).toBe("RawCheck");
    });
  },
);
