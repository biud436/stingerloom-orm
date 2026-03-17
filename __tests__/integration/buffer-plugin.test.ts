/**
 * Buffer Plugin 통합 테스트
 *
 * 실제 MySQL/PostgreSQL 데이터베이스에 연결하여
 * bufferPlugin의 track → dirty → flush 전체 사이클을 검증합니다.
 *
 * 검증 항목:
 * - track()된 엔티티의 변경이 flush() 시 실제 DB에 반영되는지
 * - save() 큐잉이 실제 INSERT로 실행되는지
 * - delete() 큐잉이 실제 DELETE로 실행되는지
 * - flush()가 단일 트랜잭션으로 원자적 실행되는지
 * - flush 후 re-snapshot이 정상 동작하는지 (accumulate → flush 반복)
 * - 혼합 연산 (update + insert + delete)이 올바른 순서로 실행되는지
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
import { getTestDrivers } from "./helpers/driver-config";
import { bufferPlugin } from "../../src/core/plugin/buffer/bufferPlugin";
import { WriteBuffer } from "../../src/core/plugin/buffer/WriteBuffer";

const drivers = getTestDrivers();

describe.each(drivers)("[Integration] $label: Buffer Plugin", ({ type, options }) => {
  let conn: TestConnectionResult;
  let em: EntityManager;
  let testEntity: DynamicEntityResult;

  beforeAll(async () => {
    conn = await createTestConnection(
      { ...options, synchronize: true, logging: false, plugins: [bufferPlugin()] },
      () => {
        testEntity = createCrudTestEntity("mut_test");
        return { entities: [testEntity.EntityClass] };
      },
    );
    em = conn.em;
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

  // ── 헬퍼 ─────────────────────────────────────────────────────

  async function seedUser(data: { name: string; age: number; email?: string | null }) {
    return em.save(testEntity.EntityClass, {
      name: data.name,
      age: data.age,
      email: data.email ?? null,
    });
  }

  async function findById(id: number) {
    const result = await em.findOne(testEntity.EntityClass, { where: { id } as any });
    return Array.isArray(result) ? result[0] : result;
  }

  async function findAll() {
    const result = await em.find(testEntity.EntityClass);
    return Array.isArray(result) ? result : result ? [result] : [];
  }

  // ── 설치 확인 ─────────────────────────────────────────────────

  describe("plugin installation", () => {
    it("mutate()가 Mutation 인스턴스를 반환해야 한다", () => {
      const mut = (em as any).buffer();
      expect(mut).toBeInstanceOf(Mutation);
    });
  });

  // ── mut.findOne() / mut.find() — auto-tracking ────────────

  describe("auto-tracking via mut.findOne() and mut.find()", () => {
    it("mut.findOne()으로 로드하면 자동 track되어야 한다", async () => {
      const created = await seedUser({ name: "AutoTrack", age: 30 });

      const mut: Mutation = (em as any).buffer();
      const user = await mut.findOne(testEntity.EntityClass, { where: { id: created.id } as any });

      expect(user).toBeDefined();
      expect(mut.tracked()).toHaveLength(1);

      // 변경 후 flush
      user.name = "AutoTracked Updated";
      const result = await mut.flush();
      expect(result.updates).toBe(1);

      const found = await findById(created.id);
      expect(found.name).toBe("AutoTracked Updated");
    });

    it("mut.findOne()에서 결과 없으면 null 반환, track 없음", async () => {
      const mut: Mutation = (em as any).buffer();
      const user = await mut.findOne(testEntity.EntityClass, { where: { id: 999999 } as any });

      expect(user).toBeNull();
      expect(mut.tracked()).toHaveLength(0);
    });

    it("mut.find()로 여러 엔티티를 로드하면 모두 자동 track되어야 한다", async () => {
      await seedUser({ name: "Batch1", age: 10 });
      await seedUser({ name: "Batch2", age: 20 });
      await seedUser({ name: "Batch3", age: 30 });

      const mut: Mutation = (em as any).buffer();
      const users = await mut.find(testEntity.EntityClass, {});

      expect(users.length).toBe(3);
      expect(mut.tracked()).toHaveLength(3);

      // 일부만 변경
      users[0].name = "Modified1";
      users[2].name = "Modified3";

      expect(mut.dirty()).toHaveLength(2);

      const result = await mut.flush();
      expect(result.updates).toBe(2);

      const found0 = await findById(users[0].id);
      const found1 = await findById(users[1].id);
      const found2 = await findById(users[2].id);

      expect(found0.name).toBe("Modified1");
      expect(found1.name).toBe("Batch2"); // 불변
      expect(found2.name).toBe("Modified3");
    });
  });

  // ── Identity Map ───────────────────────────────────────────────

  describe("Identity Map", () => {
    it("같은 PK를 두 번 findOne해도 동일 인스턴스를 반환해야 한다", async () => {
      const created = await seedUser({ name: "IdentityTest", age: 25 });

      const mut: Mutation = (em as any).buffer();
      const first = await mut.findOne(testEntity.EntityClass, { where: { id: created.id } as any });
      first.name = "Modified";

      const second = await mut.findOne(testEntity.EntityClass, { where: { id: created.id } as any });

      expect(first).toBe(second); // 같은 참조
      expect(second.name).toBe("Modified"); // 수정된 값이 보여야 함
      expect(mut.tracked()).toHaveLength(1); // 중복 tracking 없음
    });

    it("find() 결과 중 이미 tracked된 PK는 기존 인스턴스로 대체되어야 한다", async () => {
      const u1 = await seedUser({ name: "User1", age: 10 });
      await seedUser({ name: "User2", age: 20 });

      const mut: Mutation = (em as any).buffer();

      // u1을 먼저 findOne으로 로드 + 수정
      const tracked = await mut.findOne(testEntity.EntityClass, { where: { id: u1.id } as any });
      tracked.name = "Locally Modified";

      // find()로 전체 조회 — u1은 기존 인스턴스여야 함
      const all = await mut.find(testEntity.EntityClass, {});

      const matchedU1 = all.find((u: any) => u.id === u1.id);
      expect(matchedU1).toBe(tracked); // 같은 참조
      expect(matchedU1.name).toBe("Locally Modified"); // DB 값("User1")이 아닌 로컬 수정 값

      // flush하면 수정이 DB에 반영되어야 함
      const result = await mut.flush();
      expect(result.updates).toBe(1); // Locally Modified만 dirty

      const found = await findById(u1.id);
      expect(found.name).toBe("Locally Modified");
    });

    it("같은 PK의 다른 인스턴스를 track하면 에러가 발생해야 한다", async () => {
      const created = await seedUser({ name: "Conflict", age: 30 });

      const mut: Mutation = (em as any).buffer();
      await mut.findOne(testEntity.EntityClass, { where: { id: created.id } as any });

      // 새 인스턴스를 수동으로 만들어서 track 시도
      const duplicate = Object.assign(Object.create(testEntity.EntityClass.prototype), {
        id: created.id,
        name: "Duplicate",
        age: 99,
      });

      expect(() => mut.track(duplicate)).toThrow(/Identity conflict/);
    });
  });

  // ── UPDATE: track + dirty + flush ─────────────────────────────

  describe("tracked entity UPDATE", () => {
    it("track → 변경 → flush 시 실제 DB에 UPDATE가 반영되어야 한다", async () => {
      const created = await seedUser({ name: "Alice", age: 25, email: "alice@test.com" });

      const mut: Mutation = (em as any).buffer();
      mut.track(created);
      created.name = "Alice Updated";
      created.age = 26;

      expect(mut.dirty()).toHaveLength(1);

      const result = await mut.flush();
      expect(result.updates).toBe(1);
      expect(result.inserts).toBe(0);
      expect(result.deletes).toBe(0);

      // DB에서 재조회하여 실제 반영 확인
      const found = await findById(created.id);
      expect(found).toBeDefined();
      expect(found.name).toBe("Alice Updated");
      expect(found.age).toBe(26);
    });

    it("변경 없이 flush하면 no-op이어야 한다", async () => {
      const created = await seedUser({ name: "Bob", age: 30 });

      const mut: Mutation = (em as any).buffer();
      mut.track(created);

      expect(mut.dirty()).toHaveLength(0);

      const result = await mut.flush();
      expect(result.updates).toBe(0);
      expect(result.inserts).toBe(0);
      expect(result.deletes).toBe(0);

      // DB 값 불변 확인
      const found = await findById(created.id);
      expect(found.name).toBe("Bob");
    });

    it("여러 엔티티를 동시에 track하고 flush할 수 있어야 한다", async () => {
      const user1 = await seedUser({ name: "User1", age: 20 });
      const user2 = await seedUser({ name: "User2", age: 30 });
      const user3 = await seedUser({ name: "User3", age: 40 });

      const mut: Mutation = (em as any).buffer();
      mut.track(user1);
      mut.track(user2);
      mut.track(user3);

      user1.name = "Updated1";
      user3.name = "Updated3";
      // user2는 변경 없음

      expect(mut.dirty()).toHaveLength(2);

      const result = await mut.flush();
      expect(result.updates).toBe(2);

      const found1 = await findById(user1.id);
      const found2 = await findById(user2.id);
      const found3 = await findById(user3.id);

      expect(found1.name).toBe("Updated1");
      expect(found2.name).toBe("User2"); // 불변
      expect(found3.name).toBe("Updated3");
    });
  });

  // ── INSERT: save 큐잉 + flush ─────────────────────────────────

  describe("queued INSERT via save()", () => {
    it("save() 큐잉 후 flush 시 실제 DB에 INSERT가 반영되어야 한다", async () => {
      const mut: Mutation = (em as any).buffer();
      mut.save(testEntity.EntityClass, { name: "NewUser", age: 22, email: "new@test.com" });

      const result = await mut.flush();
      expect(result.inserts).toBe(1);

      const all = await findAll();
      expect(all.length).toBe(1);
      expect(all[0].name).toBe("NewUser");
      expect(all[0].age).toBe(22);
    });

    it("여러 INSERT를 큐잉하고 한번에 flush할 수 있어야 한다", async () => {
      const mut: Mutation = (em as any).buffer();
      mut.save(testEntity.EntityClass, { name: "A", age: 10 });
      mut.save(testEntity.EntityClass, { name: "B", age: 20 });
      mut.save(testEntity.EntityClass, { name: "C", age: 30 });

      const result = await mut.flush();
      expect(result.inserts).toBe(3);

      const all = await findAll();
      expect(all.length).toBe(3);
    });
  });

  // ── DELETE: delete 큐잉 + flush ───────────────────────────────

  describe("queued DELETE via delete()", () => {
    it("delete() 큐잉 후 flush 시 실제 DB에서 삭제되어야 한다", async () => {
      const created = await seedUser({ name: "ToDelete", age: 99 });

      const mut: Mutation = (em as any).buffer();
      mut.delete(testEntity.EntityClass, { id: created.id } as any);

      const result = await mut.flush();
      expect(result.deletes).toBe(1);

      const found = await findById(created.id);
      expect(found).toBeNull();
    });

    it("조건 기반 DELETE가 정상 동작해야 한다", async () => {
      await seedUser({ name: "Keep", age: 20 });
      await seedUser({ name: "Remove", age: 99 });
      await seedUser({ name: "Remove", age: 99 });

      const mut: Mutation = (em as any).buffer();
      mut.delete(testEntity.EntityClass, { name: "Remove" } as any);

      const result = await mut.flush();
      expect(result.deletes).toBe(1); // 1 delete operation (condition-based)

      const all = await findAll();
      expect(all.length).toBe(1);
      expect(all[0].name).toBe("Keep");
    });
  });

  // ── 혼합 연산 ─────────────────────────────────────────────────

  describe("mixed operations (update + insert + delete)", () => {
    it("UPDATE + INSERT + DELETE를 단일 flush로 원자적 실행해야 한다", async () => {
      // 시드 데이터
      const existing = await seedUser({ name: "Existing", age: 25 });
      const toDelete = await seedUser({ name: "ToDelete", age: 99 });

      const mut: Mutation = (em as any).buffer();

      // UPDATE: track + modify
      mut.track(existing);
      existing.name = "Modified";

      // INSERT: 새 엔티티 큐잉
      mut.save(testEntity.EntityClass, { name: "Brand New", age: 10 });

      // DELETE: 기존 엔티티 삭제 큐잉
      mut.delete(testEntity.EntityClass, { id: toDelete.id } as any);

      const result = await mut.flush();
      expect(result.updates).toBe(1);
      expect(result.inserts).toBe(1);
      expect(result.deletes).toBe(1);

      // DB 검증
      const modified = await findById(existing.id);
      expect(modified.name).toBe("Modified");

      const deleted = await findById(toDelete.id);
      expect(deleted).toBeNull();

      const all = await findAll();
      expect(all.length).toBe(2); // existing(modified) + brand new
      expect(all.some((u: any) => u.name === "Brand New")).toBe(true);
    });
  });

  // ── flush 후 re-snapshot (retainAfterFlush) ───────────────────

  describe("accumulate → flush → accumulate → flush", () => {
    it("flush 후 re-snapshot되어 추가 변경을 다시 flush할 수 있어야 한다", async () => {
      const user = await seedUser({ name: "Step1", age: 10 });

      const mut: Mutation = (em as any).buffer();
      mut.track(user);

      // 1차 변경 + flush
      user.name = "Step2";
      let result = await mut.flush();
      expect(result.updates).toBe(1);

      let found = await findById(user.id);
      expect(found.name).toBe("Step2");

      // flush 후 dirty 아님 (re-snapshot됨)
      expect(mut.dirty()).toHaveLength(0);
      expect(mut.tracked()).toHaveLength(1);

      // 2차 변경 + flush
      user.name = "Step3";
      user.age = 99;

      expect(mut.dirty()).toHaveLength(1);

      result = await mut.flush();
      expect(result.updates).toBe(1);

      found = await findById(user.id);
      expect(found.name).toBe("Step3");
      expect(found.age).toBe(99);
    });
  });

  // ── preview ───────────────────────────────────────────────────

  describe("preview()", () => {
    it("flush 전에 preview로 실행할 연산을 확인할 수 있어야 한다", async () => {
      const user = await seedUser({ name: "PreviewUser", age: 25 });

      const mut: Mutation = (em as any).buffer();
      mut.track(user);
      user.name = "Changed";
      mut.save(testEntity.EntityClass, { name: "NewItem", age: 1 });
      mut.delete(testEntity.EntityClass, { id: 999 } as any);

      const preview = mut.preview();
      expect(preview).toHaveLength(3);

      expect(preview[0].action).toBe("update");
      expect(preview[1].action).toBe("insert");
      expect(preview[2].action).toBe("delete");

      // preview는 DB에 영향을 주지 않아야 함
      const found = await findById(user.id);
      expect(found.name).toBe("PreviewUser"); // 아직 원래 값
    });
  });

  // ── 트랜잭션 원자성 ───────────────────────────────────────────

  describe("transaction atomicity", () => {
    it("flush 중간에 에러 발생 시 모든 변경이 롤백되어야 한다", async () => {
      const user = await seedUser({ name: "AtomicTest", age: 25 });

      const mut: Mutation = (em as any).buffer();
      mut.track(user);
      user.name = "ShouldRollback";

      // NOT NULL 제약 위반으로 INSERT 에러 유발 (name은 NOT NULL)
      mut.save(testEntity.EntityClass, { name: null as any, age: null as any });

      try {
        await mut.flush();
        fail("flush should have thrown");
      } catch {
        // expected
      }

      // 트랜잭션이 롤백되었으므로 원래 값 유지
      const found = await findById(user.id);
      expect(found.name).toBe("AtomicTest");
    });
  });

  // ── clear / untrack ───────────────────────────────────────────

  describe("clear() and untrack()", () => {
    it("untrack된 엔티티는 flush에 포함되지 않아야 한다", async () => {
      const user1 = await seedUser({ name: "Keep", age: 10 });
      const user2 = await seedUser({ name: "Untrack", age: 20 });

      const mut: Mutation = (em as any).buffer();
      mut.track(user1);
      mut.track(user2);
      user1.name = "Keep Modified";
      user2.name = "Should Not Apply";

      mut.untrack(user2);

      const result = await mut.flush();
      expect(result.updates).toBe(1);

      const found1 = await findById(user1.id);
      const found2 = await findById(user2.id);

      expect(found1.name).toBe("Keep Modified");
      expect(found2.name).toBe("Untrack"); // 원래 값 유지
    });

    it("clear() 후 flush는 no-op이어야 한다", async () => {
      const user = await seedUser({ name: "ClearTest", age: 10 });

      const mut: Mutation = (em as any).buffer();
      mut.track(user);
      user.name = "Modified";
      mut.save(testEntity.EntityClass, { name: "NewItem", age: 1 });

      mut.clear();

      const result = await mut.flush();
      expect(result).toEqual({ updates: 0, inserts: 0, deletes: 0 });

      // DB 불변 확인
      const found = await findById(user.id);
      expect(found.name).toBe("ClearTest");

      const all = await findAll();
      expect(all.length).toBe(1);
    });
  });
});
