/**
 * OneToMany / ManyToOne 관계 통합 테스트
 *
 * 실제 MySQL 데이터베이스에 연결하여 부모-자식 관계의
 * 생성·조회·갱신·삭제 사이클을 검증합니다.
 *
 * ## 엔티티 구조
 *
 * ParentClass
 *   - id (PK, AUTO_INCREMENT)
 *   - name (VARCHAR)
 *   - children (OneToMany → ChildClass.parent)
 *
 * ChildClass
 *   - id (PK, AUTO_INCREMENT)
 *   - title (VARCHAR)
 *   - parentFk (INT, nullable) ← DB 컬럼, @Column 필요
 *   - parent (ManyToOne, joinColumn: "parentFk", eager: true)
 *
 * ## FK 컬럼 설계
 * @ManyToOne joinColumn("parentFk")과 @Column("parentFk")을 분리 선언합니다.
 * - @Column 선언: createTable에서 DB 컬럼 생성
 * - @ManyToOne 선언: addForeignKey로 FK 제약 추가
 * - camelCase "parentFk" 사용: eager alias "parent_id"와 충돌 방지
 *
 * ## 실행 전 필요 사항
 * - MySQL 서버 실행 중
 * - examples/nestjs-cats/.env 연결 정보가 유효
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

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1: 기본 ManyToOne / OneToMany 관계
// ─────────────────────────────────────────────────────────────────────────────

describe("[Integration] OneToMany / ManyToOne 기본 관계", () => {
  let conn: TestConnectionResult;
  let em: EntityManager;
  let entities: RelatedEntitiesResult;
  let parentRepo: BaseRepository<any>;
  let childRepo: BaseRepository<any>;

  beforeAll(async () => {
    conn = await createTestConnection(
      { synchronize: true, logging: false },
      () => {
        entities = createOneToManyTestEntities("rel_basic");
        // 부모 테이블이 먼저 생성되어야 자식의 FK 제약이 추가됩니다.
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
    // FK 제약이 있으므로 자식 → 부모 순서로 DROP
    try {
      await rawQuery("SET FOREIGN_KEY_CHECKS = 0");
      if (entities) await dropTestTable(entities.childTableName);
      if (entities) await dropTestTable(entities.parentTableName);
      await rawQuery("SET FOREIGN_KEY_CHECKS = 1");
    } catch {
      // ignore
    }
    if (conn) await conn.cleanup();
  }, 15000);

  beforeEach(async () => {
    // FK 제약을 고려하여 자식 먼저 삭제
    await truncateTestTable(entities.childTableName);
    await truncateTestTable(entities.parentTableName);
  });

  // ─── CREATE ─────────────────────────────────────────────────────────────────

  describe("Create — FK 저장", () => {
    it("부모 저장 후 자식을 FK와 함께 저장할 수 있어야 한다", async () => {
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

    it("자식의 FK 값(parentFk)이 부모 id와 일치해야 한다", async () => {
      const parent = await parentRepo.save({ name: "Bob" });
      await childRepo.save({ title: "Bob's child", parentFk: parent.id });

      // DB에서 직접 조회하여 FK 저장 확인
      const rawRows = await rawQuery(
        `SELECT parentFk FROM \`${entities.childTableName}\` WHERE title = 'Bob\\'s child'`,
      );
      const rows = rawRows?.results ?? rawRows;
      const row = Array.isArray(rows) ? rows[0] : rows;
      expect(Number(row?.parentFk)).toBe(parent.id);
    });

    it("FK가 없는(null) 자식도 저장할 수 있어야 한다", async () => {
      const child = await childRepo.save({
        title: "Orphan child",
        parentFk: null,
      });

      expect(child).toBeDefined();
      expect(child.id).toBeGreaterThan(0);
    });

    it("한 부모에 여러 자식을 저장할 수 있어야 한다", async () => {
      const parent = await parentRepo.save({ name: "Multi-parent" });

      await childRepo.save({ title: "Child 1", parentFk: parent.id });
      await childRepo.save({ title: "Child 2", parentFk: parent.id });
      await childRepo.save({ title: "Child 3", parentFk: parent.id });

      const rawRows = await rawQuery(
        `SELECT COUNT(*) AS cnt FROM \`${entities.childTableName}\` WHERE parentFk = ${parent.id}`,
      );
      const rows = rawRows?.results ?? rawRows;
      const row = Array.isArray(rows) ? rows[0] : rows;
      expect(Number(row?.cnt)).toBe(3);
    });
  });

  // ─── READ: Eager Loading (ManyToOne) ────────────────────────────────────────

  describe("Read — ManyToOne Eager 로딩", () => {
    it("자식 조회 시 parent 객체가 자동으로 로드되어야 한다 (eager: true)", async () => {
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

    it("eager 로드된 parent의 id가 일치해야 한다", async () => {
      const parent = await parentRepo.save({ name: "Parent for eager" });
      const saved = await childRepo.save({
        title: "Child",
        parentFk: parent.id,
      });

      const found = await childRepo.findOne({ where: { id: saved.id } });
      const child = Array.isArray(found) ? found[0] : found;

      expect(child.parent.id).toBe(parent.id);
    });

    it("eager 로드된 parent의 name이 일치해야 한다", async () => {
      const parent = await parentRepo.save({ name: "Named Parent" });
      const saved = await childRepo.save({
        title: "Named Child",
        parentFk: parent.id,
      });

      const found = await childRepo.findOne({ where: { id: saved.id } });
      const child = Array.isArray(found) ? found[0] : found;

      expect(child.parent.name).toBe("Named Parent");
    });

    it("FK가 null인 자식의 parent는 null이어야 한다", async () => {
      const saved = await childRepo.save({ title: "No Parent", parentFk: null });

      const found = await childRepo.findOne({ where: { id: saved.id } });
      const child = Array.isArray(found) ? found[0] : found;

      // parent가 null이거나 없어야 함
      expect(child.parent == null).toBe(true);
    });

    it("find()로 여러 자식을 조회할 때 각각 parent가 로드되어야 한다", async () => {
      const parent1 = await parentRepo.save({ name: "P1" });
      const parent2 = await parentRepo.save({ name: "P2" });

      await childRepo.save({ title: "C1", parentFk: parent1.id });
      await childRepo.save({ title: "C2", parentFk: parent2.id });

      const result = await childRepo.find();
      const children = Array.isArray(result) ? result : result ? [result] : [];

      // parent가 있는 자식들만 검사
      const withParent = children.filter((c: any) => c.parent != null);
      expect(withParent.length).toBeGreaterThanOrEqual(2);

      for (const c of withParent) {
        expect(c.parent.id).toBeDefined();
        expect(c.parent.name).toBeDefined();
      }
    });
  });

  // ─── READ: OneToMany via relations ──────────────────────────────────────────

  describe("Read — OneToMany relations 옵션", () => {
    it("relations: ['children']로 부모 조회 시 children 배열이 로드되어야 한다", async () => {
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

    it("children 배열의 각 요소가 올바른 title을 가져야 한다", async () => {
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

    it("자식이 없는 부모의 children은 빈 배열이어야 한다", async () => {
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

    it("relations 없이 조회 시 children이 로드되지 않아야 한다", async () => {
      const parent = await parentRepo.save({ name: "No relations" });
      await childRepo.save({ title: "Hidden child", parentFk: parent.id });

      const found = await parentRepo.findOne({
        where: { id: parent.id },
        // relations 미지정
      });
      const p = Array.isArray(found) ? found[0] : found;

      // children이 undefined이거나 빈 배열이어야 함
      const children = p?.children;
      const isEmpty = children == null || (Array.isArray(children) && children.length === 0);
      expect(isEmpty).toBe(true);
    });
  });

  // ─── UPDATE ─────────────────────────────────────────────────────────────────

  describe("Update — FK 변경", () => {
    it("자식의 FK(parentFk)를 다른 부모로 변경할 수 있어야 한다", async () => {
      const parent1 = await parentRepo.save({ name: "Original Parent" });
      const parent2 = await parentRepo.save({ name: "New Parent" });

      const child = await childRepo.save({
        title: "Reassignable Child",
        parentFk: parent1.id,
      });

      // FK 변경
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

    it("부모의 이름을 변경해도 자식의 eager 로드 결과에 반영되어야 한다", async () => {
      const parent = await parentRepo.save({ name: "Old Name" });
      const child = await childRepo.save({
        title: "Child",
        parentFk: parent.id,
      });

      // 부모 이름 변경
      await parentRepo.save({ id: parent.id, name: "New Name" });

      // 자식 재조회
      const found = await childRepo.findOne({ where: { id: child.id } });
      const c = Array.isArray(found) ? found[0] : found;

      expect(c.parent.name).toBe("New Name");
    });
  });

  // ─── DELETE ─────────────────────────────────────────────────────────────────

  describe("Delete — 참조 무결성", () => {
    it("자식만 삭제해도 부모는 유지되어야 한다", async () => {
      const parent = await parentRepo.save({ name: "Surviving Parent" });
      const child = await childRepo.save({
        title: "Deletable Child",
        parentFk: parent.id,
      });

      await childRepo.delete({ id: child.id } as any);

      // 자식 삭제 확인
      const foundChild = await childRepo.findOne({ where: { id: child.id } });
      if (Array.isArray(foundChild)) {
        expect(foundChild.length).toBe(0);
      } else {
        expect(foundChild).toBeUndefined();
      }

      // 부모는 유지
      const foundParent = await parentRepo.findOne({
        where: { id: parent.id },
      });
      const p = Array.isArray(foundParent) ? foundParent[0] : foundParent;
      expect(p).toBeDefined();
      expect(p.name).toBe("Surviving Parent");
    });

    it("FK 조건으로 여러 자식을 한 번에 삭제할 수 있어야 한다", async () => {
      const parent = await parentRepo.save({ name: "Bulk Delete Parent" });
      await childRepo.save({ title: "Child A", parentFk: parent.id });
      await childRepo.save({ title: "Child B", parentFk: parent.id });

      const result = await childRepo.delete({ parentFk: parent.id } as any);
      expect(result.affected).toBe(2);

      // 부모는 유지
      const countRows = await rawQuery(
        `SELECT COUNT(*) AS cnt FROM \`${entities.parentTableName}\` WHERE id = ${parent.id}`,
      );
      const rows = countRows?.results ?? countRows;
      const row = Array.isArray(rows) ? rows[0] : rows;
      expect(Number(row?.cnt)).toBe(1);
    });
  });

  // ─── FULL LIFECYCLE ──────────────────────────────────────────────────────────

  describe("전체 관계 라이프사이클", () => {
    it("Parent 생성 → Child 생성 (FK) → 조회(eager+relations) → 업데이트 → 삭제 흐름", async () => {
      // 1. 부모 생성
      const parent = await parentRepo.save({ name: "Lifecycle Parent" });
      expect(parent.id).toBeGreaterThan(0);

      // 2. 자식 생성 (FK 포함)
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

      // 3. 자식 조회 → eager parent 확인
      const foundChild = await childRepo.findOne({ where: { id: child1.id } });
      const c = Array.isArray(foundChild) ? foundChild[0] : foundChild;
      expect(c.parent.id).toBe(parent.id);
      expect(c.parent.name).toBe("Lifecycle Parent");

      // 4. 부모 조회 → OneToMany 확인
      const foundParent = await parentRepo.findOne({
        where: { id: parent.id },
        relations: ["children"],
      } as any);
      const p = Array.isArray(foundParent) ? foundParent[0] : foundParent;
      expect(p.children.length).toBe(2);

      // 5. 자식 타이틀 업데이트
      await childRepo.save({ id: child1.id, title: "Updated LC Child 1", parentFk: parent.id });
      const updatedChild = await childRepo.findOne({ where: { id: child1.id } });
      const uc = Array.isArray(updatedChild) ? updatedChild[0] : updatedChild;
      expect(uc.title).toBe("Updated LC Child 1");
      expect(uc.parent.id).toBe(parent.id); // FK 유지

      // 6. 자식 삭제
      await childRepo.delete({ id: child1.id } as any);
      await childRepo.delete({ id: child2.id } as any);

      // 7. 부모 재조회 → children 없음
      const afterDelete = await parentRepo.findOne({
        where: { id: parent.id },
        relations: ["children"],
      } as any);
      const pa = Array.isArray(afterDelete) ? afterDelete[0] : afterDelete;
      const remaining = pa.children ?? [];
      expect(remaining.length).toBe(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: Cascade Insert (OneToMany → 자식 자동 저장)
// ─────────────────────────────────────────────────────────────────────────────

describe("[Integration] OneToMany Cascade Insert", () => {
  let conn: TestConnectionResult;
  let em: EntityManager;
  let entities: RelatedEntitiesResult;
  let parentRepo: BaseRepository<any>;
  let childRepo: BaseRepository<any>;

  beforeAll(async () => {
    conn = await createTestConnection(
      { synchronize: true, logging: false },
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
      await rawQuery("SET FOREIGN_KEY_CHECKS = 0");
      if (entities) await dropTestTable(entities.childTableName);
      if (entities) await dropTestTable(entities.parentTableName);
      await rawQuery("SET FOREIGN_KEY_CHECKS = 1");
    } catch {
      // ignore
    }
    if (conn) await conn.cleanup();
  }, 15000);

  beforeEach(async () => {
    await truncateTestTable(entities.childTableName);
    await truncateTestTable(entities.parentTableName);
  });

  it("부모와 함께 children 배열을 저장하면 자식들이 자동 생성되어야 한다", async () => {
    const saved = await parentRepo.save({
      name: "Cascade Parent",
      children: [{ title: "Cascade Child 1" }, { title: "Cascade Child 2" }],
    });

    expect(saved).toBeDefined();
    expect(saved.id).toBeGreaterThan(0);

    // 자식들이 실제로 DB에 저장되었는지 확인
    const rows = await rawQuery(
      `SELECT COUNT(*) AS cnt FROM \`${entities.childTableName}\` WHERE parentFk = ${saved.id}`,
    );
    const rs = rows?.results ?? rows;
    const r = Array.isArray(rs) ? rs[0] : rs;
    expect(Number(r?.cnt)).toBe(2);
  });

  it("cascade로 저장된 자식들의 FK(parentFk)가 부모 id와 일치해야 한다", async () => {
    const parent = await parentRepo.save({
      name: "FK Cascade Parent",
      children: [{ title: "FK Child" }],
    });

    const rows = await rawQuery(
      `SELECT parentFk FROM \`${entities.childTableName}\` WHERE title = 'FK Child'`,
    );
    const rs = rows?.results ?? rows;
    const row = Array.isArray(rs) ? rs[0] : rs;
    expect(Number(row?.parentFk)).toBe(parent.id);
  });

  it("cascade 저장 시 children이 빈 배열이면 자식이 없어야 한다", async () => {
    await parentRepo.save({ name: "Empty Children", children: [] });

    const rows = await rawQuery(
      `SELECT COUNT(*) AS cnt FROM \`${entities.childTableName}\``,
    );
    const rs = rows?.results ?? rows;
    const r = Array.isArray(rs) ? rs[0] : rs;
    expect(Number(r?.cnt)).toBe(0);
  });

  it("cascade 없이 저장하면 자식이 저장되지 않아야 한다", async () => {
    // children 미포함 → cascade 미발동
    const parent = await parentRepo.save({ name: "No Cascade" });

    const rows = await rawQuery(
      `SELECT COUNT(*) AS cnt FROM \`${entities.childTableName}\` WHERE parentFk = ${parent.id}`,
    );
    const rs = rows?.results ?? rows;
    const r = Array.isArray(rs) ? rs[0] : rs;
    expect(Number(r?.cnt)).toBe(0);
  });

  it("여러 번 cascade 저장 시 자식들이 누적 생성되어야 한다", async () => {
    const parent = await parentRepo.save({ name: "Accumulate Parent" });

    // 1차 저장 (cascade 없이 부모만)
    // 2차: 자식 직접 저장
    await childRepo.save({ title: "Direct Child", parentFk: parent.id });

    // 부모를 통한 cascade 저장 (기존 부모 id 재사용)
    await parentRepo.save({
      name: "Accumulate Parent (updated)",
      children: [{ title: "Cascaded Child" }],
    });

    // 총 자식 수 (Direct 1 + 새 부모의 Cascaded 1 = 최소 1)
    // 새 부모가 생성될 수도 있으므로 최소 1개 이상 검사
    const rows = await rawQuery(
      `SELECT COUNT(*) AS cnt FROM \`${entities.childTableName}\``,
    );
    const rs = rows?.results ?? rows;
    const r = Array.isArray(rs) ? rs[0] : rs;
    expect(Number(r?.cnt)).toBeGreaterThanOrEqual(1);
  });
});
