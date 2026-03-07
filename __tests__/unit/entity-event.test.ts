import "reflect-metadata";
import {
  EntityEventEmitter,
  EntityEventType,
  EntityEventPayload,
} from "../../src/core/EntityEventEmitter";

describe("EntityEventEmitter 단위 테스트", () => {
  let emitter: EntityEventEmitter;

  beforeEach(() => {
    emitter = new EntityEventEmitter();
  });

  describe("on / emit", () => {
    it("등록된 리스너가 emit 시 호출되어야 한다", async () => {
      const spy = jest.fn();
      emitter.on("beforeInsert", spy);

      class Dummy {}
      await emitter.emit("beforeInsert", { entity: Dummy, data: { id: 1 } });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({ entity: Dummy, data: { id: 1 } });
    });

    it("여러 리스너가 동일 이벤트에 등록되면 모두 호출되어야 한다", async () => {
      const spy1 = jest.fn();
      const spy2 = jest.fn();
      emitter.on("afterInsert", spy1);
      emitter.on("afterInsert", spy2);

      class Item {}
      await emitter.emit("afterInsert", { entity: Item, data: {} });

      expect(spy1).toHaveBeenCalledTimes(1);
      expect(spy2).toHaveBeenCalledTimes(1);
    });

    it("다른 이벤트의 리스너는 호출되지 않아야 한다", async () => {
      const spy = jest.fn();
      emitter.on("beforeUpdate", spy);

      class Item {}
      await emitter.emit("beforeInsert", { entity: Item, data: {} });

      expect(spy).not.toHaveBeenCalled();
    });

    it("비동기 리스너가 순차적으로 await되어야 한다", async () => {
      const order: number[] = [];

      emitter.on("beforeInsert", async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push(1);
      });

      emitter.on("beforeInsert", async () => {
        order.push(2);
      });

      class Item {}
      await emitter.emit("beforeInsert", { entity: Item, data: {} });

      expect(order).toEqual([1, 2]);
    });

    it("리스너가 없는 이벤트를 emit해도 에러가 발생하지 않아야 한다", async () => {
      class Item {}
      await expect(
        emitter.emit("afterDelete", { entity: Item, data: {} }),
      ).resolves.toBeUndefined();
    });
  });

  describe("off", () => {
    it("리스너를 제거하면 더 이상 호출되지 않아야 한다", async () => {
      const spy = jest.fn();
      emitter.on("beforeDelete", spy);
      emitter.off("beforeDelete", spy);

      class Item {}
      await emitter.emit("beforeDelete", { entity: Item, data: {} });

      expect(spy).not.toHaveBeenCalled();
    });

    it("등록하지 않은 리스너를 off해도 에러가 발생하지 않아야 한다", () => {
      const spy = jest.fn();
      expect(() => emitter.off("afterUpdate", spy)).not.toThrow();
    });
  });

  describe("removeAllListeners", () => {
    it("모든 리스너를 제거해야 한다", async () => {
      const spy1 = jest.fn();
      const spy2 = jest.fn();
      emitter.on("beforeInsert", spy1);
      emitter.on("afterDelete", spy2);

      emitter.removeAllListeners();

      class Item {}
      await emitter.emit("beforeInsert", { entity: Item, data: {} });
      await emitter.emit("afterDelete", { entity: Item, data: {} });

      expect(spy1).not.toHaveBeenCalled();
      expect(spy2).not.toHaveBeenCalled();
    });
  });

  describe("모든 이벤트 타입", () => {
    const eventTypes: EntityEventType[] = [
      "beforeInsert",
      "afterInsert",
      "beforeUpdate",
      "afterUpdate",
      "beforeDelete",
      "afterDelete",
    ];

    it.each(eventTypes)(
      "%s 이벤트가 정상적으로 emit되어야 한다",
      async (eventType) => {
        const spy = jest.fn();
        emitter.on(eventType, spy);

        class TestEntity {}
        await emitter.emit(eventType, {
          entity: TestEntity,
          data: { id: 1 },
        });

        expect(spy).toHaveBeenCalledTimes(1);
      },
    );
  });
});

// ─── EntityManager 이벤트 통합 테스트 ────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockQuery = jest.fn();
const mockCommit = jest.fn();
const mockRollback = jest.fn();
const mockClose = jest.fn();
const mockTxConnect = jest.fn();
const mockStartTransaction = jest.fn();

jest.mock("../../src/dialects/TransactionSessionManager", () => ({
  TransactionSessionManager: jest.fn().mockImplementation(() => ({
    connect: mockTxConnect,
    startTransaction: mockStartTransaction,
    query: mockQuery,
    commit: mockCommit,
    rollback: mockRollback,
    close: mockClose,
  })),
}));

jest.mock("../../src/DatabaseClient", () => ({
  DatabaseClient: {
    getInstance: () => ({
      connect: jest.fn().mockResolvedValue({ query: jest.fn() }),
      close: jest.fn(),
      getConnection: jest.fn(),
      getOptions: jest.fn().mockReturnValue({ synchronize: false }),
      type: "postgres",
    }),
  },
}));

import { EntityManager } from "../../src/core/EntityManager";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";

describe("EntityManager 이벤트 통합 테스트", () => {
  let em: EntityManager;

  @Entity()
  class EventItem {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    name!: string;
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    em = new EntityManager();
    await em.connect({
      type: "postgres",
      host: "localhost",
      port: 5432,
      username: "test",
      password: "test",
      database: "testdb",
      entities: [],
    });
  });

  afterEach(() => {
    em.removeAllListeners();
  });

  it("INSERT 시 beforeInsert, afterInsert 이벤트가 발행되어야 한다", async () => {
    const events: string[] = [];

    em.on("beforeInsert", () => {
      events.push("beforeInsert");
    });
    em.on("afterInsert", () => {
      events.push("afterInsert");
    });

    mockQuery.mockResolvedValue({
      results: [{ id: 1 }],
      fields: [],
    });

    await em.save(EventItem, { name: "test" } as any);

    expect(events).toContain("beforeInsert");
    expect(events).toContain("afterInsert");
  });

  it("UPDATE 시 beforeUpdate, afterUpdate 이벤트가 발행되어야 한다", async () => {
    const events: string[] = [];

    em.on("beforeUpdate", () => {
      events.push("beforeUpdate");
    });
    em.on("afterUpdate", () => {
      events.push("afterUpdate");
    });

    mockQuery
      .mockResolvedValueOnce({ results: [], rowCount: 1, fields: [] })
      .mockResolvedValue({
        results: [{ id: 1, name: "updated" }],
        fields: [],
      });

    await em.save(EventItem, { id: 1, name: "updated" } as any);

    expect(events).toContain("beforeUpdate");
    expect(events).toContain("afterUpdate");
  });

  it("DELETE 시 beforeDelete, afterDelete 이벤트가 발행되어야 한다", async () => {
    const events: string[] = [];

    em.on("beforeDelete", () => {
      events.push("beforeDelete");
    });
    em.on("afterDelete", () => {
      events.push("afterDelete");
    });

    mockQuery.mockResolvedValue({
      results: [], rowCount: 1,
      fields: [],
    });

    await em.delete(EventItem, { id: 1 } as any);

    expect(events).toContain("beforeDelete");
    expect(events).toContain("afterDelete");
  });

  it("beforeInsert 이벤트 페이로드에 entity와 data가 포함되어야 한다", async () => {
    let receivedPayload: EntityEventPayload | null = null;

    em.on("beforeInsert", (payload) => {
      receivedPayload = payload;
    });

    mockQuery.mockResolvedValue({
      results: [{ id: 1 }],
      fields: [],
    });

    await em.save(EventItem, { name: "payload-test" } as any);

    expect(receivedPayload).not.toBeNull();
    expect(receivedPayload!.entity).toBe(EventItem);
    expect(receivedPayload!.data).toMatchObject({ name: "payload-test" });
  });

  it("off로 리스너를 제거하면 더 이상 호출되지 않아야 한다", async () => {
    const spy = jest.fn();
    em.on("beforeInsert", spy);
    em.off("beforeInsert", spy);

    mockQuery.mockResolvedValue({
      results: [{ id: 1 }],
      fields: [],
    });

    await em.save(EventItem, { name: "removed" } as any);

    expect(spy).not.toHaveBeenCalled();
  });

  it("removeAllListeners로 모든 리스너를 제거해야 한다", async () => {
    const spy1 = jest.fn();
    const spy2 = jest.fn();
    em.on("beforeInsert", spy1);
    em.on("afterInsert", spy2);

    em.removeAllListeners();

    mockQuery.mockResolvedValue({
      results: [{ id: 1 }],
      fields: [],
    });

    await em.save(EventItem, { name: "cleared" } as any);

    expect(spy1).not.toHaveBeenCalled();
    expect(spy2).not.toHaveBeenCalled();
  });

  it("이벤트 리스너 없이도 save/delete가 정상 동작해야 한다", async () => {
    mockQuery.mockResolvedValue({
      results: [{ id: 1 }],
      fields: [],
    });

    await expect(
      em.save(EventItem, { name: "no-listeners" } as any),
    ).resolves.toBeDefined();

    mockQuery.mockResolvedValue({
      results: [], rowCount: 1,
      fields: [],
    });

    await expect(
      em.delete(EventItem, { id: 1 } as any),
    ).resolves.toEqual({ affected: 1 });
  });

  it("beforeInsert가 INSERT 쿼리 전에 발행되어야 한다", async () => {
    const callOrder: string[] = [];

    em.on("beforeInsert", () => {
      callOrder.push("event:beforeInsert");
    });

    mockQuery.mockImplementation(() => {
      callOrder.push("query");
      return Promise.resolve({ results: [{ id: 1 }], fields: [] });
    });

    await em.save(EventItem, { name: "ordered" } as any);

    const beforeIdx = callOrder.indexOf("event:beforeInsert");
    const queryIdx = callOrder.indexOf("query");
    expect(beforeIdx).toBeGreaterThanOrEqual(0);
    expect(queryIdx).toBeGreaterThan(beforeIdx);
  });
});
