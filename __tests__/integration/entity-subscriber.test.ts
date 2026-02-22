/**
 * EntitySubscriber 통합 테스트
 *
 * EntityManager.addSubscriber()를 통해 등록된 Subscriber가
 * 실제 DB 연산(save/delete) 시 올바르게 호출되는지 검증합니다.
 *
 * 테스트 항목:
 * - addSubscriber 후 save()시 beforeInsert/afterInsert 호출
 * - save(with PK)시 beforeUpdate/afterUpdate 호출
 * - delete()시 beforeDelete/afterDelete 호출
 * - listenTo() 필터링 — 다른 엔티티 이벤트 미수신
 * - removeSubscriber 후 이벤트 미수신
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
  type TestConnectionResult,
} from "./helpers/test-connection";
import { createCrudTestEntity, type DynamicEntityResult } from "./helpers/create-test-entity";
import {
  EntitySubscriber,
  InsertEvent,
  UpdateEvent,
  DeleteEvent,
} from "../../src/core/EntitySubscriber";

// ─────────────────────────────────────────────────────────────────────────────
// 이벤트 추적용 유틸리티
// ─────────────────────────────────────────────────────────────────────────────

interface EventLog {
  event: string;
  data?: any;
}

let eventLogs: EventLog[] = [];

function clearLogs() {
  eventLogs = [];
}

// ─────────────────────────────────────────────────────────────────────────────
// 테스트 스위트
// ─────────────────────────────────────────────────────────────────────────────

describe("[Integration] EntitySubscriber (addSubscriber/removeSubscriber)", () => {
  let conn: TestConnectionResult;
  let em: EntityManager;
  let entityA: DynamicEntityResult;
  let entityB: DynamicEntityResult;
  let repoA: BaseRepository<any>;
  let repoB: BaseRepository<any>;

  beforeAll(async () => {
    conn = await createTestConnection(
      { synchronize: true, logging: false },
      () => {
        entityA = createCrudTestEntity("sub_a");
        entityB = createCrudTestEntity("sub_b");
        return { entities: [entityA.EntityClass, entityB.EntityClass] };
      },
    );
    em = conn.em;
    repoA = em.getRepository(entityA.EntityClass);
    repoB = em.getRepository(entityB.EntityClass);
  }, 30000);

  afterAll(async () => {
    try {
      await dropTestTable(entityA.tableName);
    } catch {
      // ignore
    }
    try {
      await dropTestTable(entityB.tableName);
    } catch {
      // ignore
    }
    await conn.cleanup();
  }, 15000);

  beforeEach(async () => {
    await truncateTestTable(entityA.tableName);
    await truncateTestTable(entityB.tableName);
    clearLogs();
  });

  // ─── INSERT 이벤트 ────────────────────────────────────────────────────────

  describe("INSERT 이벤트", () => {
    it("save() 시 beforeInsert와 afterInsert가 호출되어야 한다", async () => {
      const subscriber: EntitySubscriber<any> = {
        listenTo: () => entityA.EntityClass,
        beforeInsert(event: InsertEvent<any>) {
          eventLogs.push({ event: "beforeInsert", data: event.entity });
        },
        afterInsert(event: InsertEvent<any>) {
          eventLogs.push({ event: "afterInsert", data: event.entity });
        },
      };
      em.addSubscriber(subscriber);

      try {
        await repoA.save({ name: "Alice", age: 25 });

        const events = eventLogs.map((e) => e.event);
        expect(events).toContain("beforeInsert");
        expect(events).toContain("afterInsert");
      } finally {
        em.removeSubscriber(subscriber);
      }
    });

    it("beforeInsert가 afterInsert보다 먼저 호출되어야 한다", async () => {
      const subscriber: EntitySubscriber<any> = {
        listenTo: () => entityA.EntityClass,
        beforeInsert() {
          eventLogs.push({ event: "beforeInsert" });
        },
        afterInsert() {
          eventLogs.push({ event: "afterInsert" });
        },
      };
      em.addSubscriber(subscriber);

      try {
        await repoA.save({ name: "Bob", age: 30 });

        const events = eventLogs.map((e) => e.event);
        const beforeIdx = events.indexOf("beforeInsert");
        const afterIdx = events.indexOf("afterInsert");
        expect(beforeIdx).toBeGreaterThanOrEqual(0);
        expect(afterIdx).toBeGreaterThanOrEqual(0);
        expect(beforeIdx).toBeLessThan(afterIdx);
      } finally {
        em.removeSubscriber(subscriber);
      }
    });

    it("이벤트 객체에 entity와 manager가 전달되어야 한다", async () => {
      let receivedEvent: InsertEvent<any> | null = null;
      const subscriber: EntitySubscriber<any> = {
        listenTo: () => entityA.EntityClass,
        beforeInsert(event: InsertEvent<any>) {
          receivedEvent = event;
        },
      };
      em.addSubscriber(subscriber);

      try {
        await repoA.save({ name: "Charlie", age: 35 });

        expect(receivedEvent).not.toBeNull();
        expect(receivedEvent!.entity).toBeDefined();
        expect(receivedEvent!.manager).toBeDefined();
        expect(receivedEvent!.manager).toBe(em);
      } finally {
        em.removeSubscriber(subscriber);
      }
    });
  });

  // ─── UPDATE 이벤트 ────────────────────────────────────────────────────────

  describe("UPDATE 이벤트", () => {
    it("기존 엔티티 save(with PK) 시 beforeUpdate와 afterUpdate가 호출되어야 한다", async () => {
      const subscriber: EntitySubscriber<any> = {
        listenTo: () => entityA.EntityClass,
        beforeUpdate(event: UpdateEvent<any>) {
          eventLogs.push({ event: "beforeUpdate", data: event.entity });
        },
        afterUpdate(event: UpdateEvent<any>) {
          eventLogs.push({ event: "afterUpdate", data: event.entity });
        },
      };
      em.addSubscriber(subscriber);

      try {
        const created = await repoA.save({ name: "Diana", age: 28 });
        clearLogs(); // INSERT 이벤트 제거

        await repoA.save({ id: created.id, name: "Diana Updated", age: 29 });

        const events = eventLogs.map((e) => e.event);
        expect(events).toContain("beforeUpdate");
        expect(events).toContain("afterUpdate");
      } finally {
        em.removeSubscriber(subscriber);
      }
    });

    it("UPDATE 시 INSERT 이벤트는 호출되지 않아야 한다", async () => {
      const subscriber: EntitySubscriber<any> = {
        listenTo: () => entityA.EntityClass,
        beforeInsert() {
          eventLogs.push({ event: "beforeInsert" });
        },
        afterInsert() {
          eventLogs.push({ event: "afterInsert" });
        },
        beforeUpdate() {
          eventLogs.push({ event: "beforeUpdate" });
        },
        afterUpdate() {
          eventLogs.push({ event: "afterUpdate" });
        },
      };
      em.addSubscriber(subscriber);

      try {
        const created = await repoA.save({ name: "Eve", age: 22 });
        clearLogs();

        await repoA.save({ id: created.id, name: "Eve Updated", age: 23 });

        const events = eventLogs.map((e) => e.event);
        expect(events).not.toContain("beforeInsert");
        expect(events).not.toContain("afterInsert");
        expect(events).toContain("beforeUpdate");
        expect(events).toContain("afterUpdate");
      } finally {
        em.removeSubscriber(subscriber);
      }
    });
  });

  // ─── DELETE 이벤트 ────────────────────────────────────────────────────────

  describe("DELETE 이벤트", () => {
    it("delete() 시 beforeDelete와 afterDelete가 호출되어야 한다", async () => {
      const subscriber: EntitySubscriber<any> = {
        listenTo: () => entityA.EntityClass,
        beforeDelete(event: DeleteEvent<any>) {
          eventLogs.push({ event: "beforeDelete", data: event.criteria });
        },
        afterDelete(event: DeleteEvent<any>) {
          eventLogs.push({ event: "afterDelete", data: event.criteria });
        },
      };
      em.addSubscriber(subscriber);

      try {
        const created = await repoA.save({ name: "Frank", age: 40 });
        clearLogs();

        await repoA.delete({ id: created.id } as any);

        const events = eventLogs.map((e) => e.event);
        expect(events).toContain("beforeDelete");
        expect(events).toContain("afterDelete");
      } finally {
        em.removeSubscriber(subscriber);
      }
    });

    it("beforeDelete가 afterDelete보다 먼저 호출되어야 한다", async () => {
      const subscriber: EntitySubscriber<any> = {
        listenTo: () => entityA.EntityClass,
        beforeDelete() {
          eventLogs.push({ event: "beforeDelete" });
        },
        afterDelete() {
          eventLogs.push({ event: "afterDelete" });
        },
      };
      em.addSubscriber(subscriber);

      try {
        const created = await repoA.save({ name: "Grace", age: 27 });
        clearLogs();

        await repoA.delete({ id: created.id } as any);

        const events = eventLogs.map((e) => e.event);
        const beforeIdx = events.indexOf("beforeDelete");
        const afterIdx = events.indexOf("afterDelete");
        expect(beforeIdx).toBeGreaterThanOrEqual(0);
        expect(afterIdx).toBeGreaterThanOrEqual(0);
        expect(beforeIdx).toBeLessThan(afterIdx);
      } finally {
        em.removeSubscriber(subscriber);
      }
    });
  });

  // ─── listenTo 필터링 ──────────────────────────────────────────────────────

  describe("listenTo() 필터링", () => {
    it("listenTo 대상이 아닌 엔티티의 이벤트는 수신하지 않아야 한다", async () => {
      const subscriber: EntitySubscriber<any> = {
        listenTo: () => entityA.EntityClass, // entityA만 구독
        beforeInsert() {
          eventLogs.push({ event: "beforeInsert-A" });
        },
        afterInsert() {
          eventLogs.push({ event: "afterInsert-A" });
        },
      };
      em.addSubscriber(subscriber);

      try {
        // entityB에 대해 save() — subscriber에 이벤트가 전달되지 않아야 함
        await repoB.save({ name: "OtherEntity", age: 50 });

        const events = eventLogs.map((e) => e.event);
        expect(events).not.toContain("beforeInsert-A");
        expect(events).not.toContain("afterInsert-A");
      } finally {
        em.removeSubscriber(subscriber);
      }
    });

    it("listenTo 대상 엔티티의 이벤트만 수신해야 한다", async () => {
      const subscriber: EntitySubscriber<any> = {
        listenTo: () => entityA.EntityClass,
        afterInsert() {
          eventLogs.push({ event: "afterInsert-A" });
        },
      };
      em.addSubscriber(subscriber);

      try {
        // entityB save → 이벤트 없어야 함
        await repoB.save({ name: "B-Entity", age: 10 });
        expect(eventLogs.length).toBe(0);

        // entityA save → 이벤트 있어야 함
        await repoA.save({ name: "A-Entity", age: 20 });
        const events = eventLogs.map((e) => e.event);
        expect(events).toContain("afterInsert-A");
      } finally {
        em.removeSubscriber(subscriber);
      }
    });
  });

  // ─── removeSubscriber ─────────────────────────────────────────────────────

  describe("removeSubscriber", () => {
    it("removeSubscriber 후 이벤트를 수신하지 않아야 한다", async () => {
      const subscriber: EntitySubscriber<any> = {
        listenTo: () => entityA.EntityClass,
        afterInsert() {
          eventLogs.push({ event: "afterInsert" });
        },
      };
      em.addSubscriber(subscriber);

      // 이벤트 수신 확인
      await repoA.save({ name: "Before Remove", age: 10 });
      expect(eventLogs.map((e) => e.event)).toContain("afterInsert");

      clearLogs();

      // subscriber 제거
      em.removeSubscriber(subscriber);

      // 이벤트 미수신 확인
      await repoA.save({ name: "After Remove", age: 20 });
      expect(eventLogs.length).toBe(0);
    });
  });

  // ─── 전체 라이프사이클 ────────────────────────────────────────────────────

  describe("전체 라이프사이클", () => {
    it("INSERT → UPDATE → DELETE 시 모든 이벤트가 올바른 순서로 호출되어야 한다", async () => {
      const subscriber: EntitySubscriber<any> = {
        listenTo: () => entityA.EntityClass,
        beforeInsert() { eventLogs.push({ event: "beforeInsert" }); },
        afterInsert() { eventLogs.push({ event: "afterInsert" }); },
        beforeUpdate() { eventLogs.push({ event: "beforeUpdate" }); },
        afterUpdate() { eventLogs.push({ event: "afterUpdate" }); },
        beforeDelete() { eventLogs.push({ event: "beforeDelete" }); },
        afterDelete() { eventLogs.push({ event: "afterDelete" }); },
      };
      em.addSubscriber(subscriber);

      try {
        // INSERT
        const created = await repoA.save({ name: "Lifecycle", age: 25 });
        expect(eventLogs.map((e) => e.event)).toEqual([
          "beforeInsert",
          "afterInsert",
        ]);

        clearLogs();

        // UPDATE
        await repoA.save({ id: created.id, name: "Updated", age: 26 });
        expect(eventLogs.map((e) => e.event)).toEqual([
          "beforeUpdate",
          "afterUpdate",
        ]);

        clearLogs();

        // DELETE
        await repoA.delete({ id: created.id } as any);
        expect(eventLogs.map((e) => e.event)).toEqual([
          "beforeDelete",
          "afterDelete",
        ]);
      } finally {
        em.removeSubscriber(subscriber);
      }
    });
  });
});
