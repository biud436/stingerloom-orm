import "reflect-metadata";
import {
  BeforeInsert,
  AfterInsert,
  BeforeUpdate,
  AfterUpdate,
  BeforeDelete,
  AfterDelete,
  HOOK_TOKEN,
  HookMetadata,
  HookEvent,
} from "../../src/decorators/Hooks";

describe("Entity 생명주기 훅 데코레이터", () => {
  describe("메타데이터 저장", () => {
    it("@BeforeInsert 메타데이터가 저장되어야 한다", () => {
      class User {
        @BeforeInsert()
        onBeforeInsert() {}
      }

      const hooks: HookMetadata[] = Reflect.getMetadata(HOOK_TOKEN, User) ?? [];
      expect(hooks.some((h) => h.event === "beforeInsert" && h.methodName === "onBeforeInsert")).toBe(true);
    });

    it("@AfterInsert 메타데이터가 저장되어야 한다", () => {
      class Post {
        @AfterInsert()
        onAfterInsert() {}
      }

      const hooks: HookMetadata[] = Reflect.getMetadata(HOOK_TOKEN, Post) ?? [];
      expect(hooks.some((h) => h.event === "afterInsert")).toBe(true);
    });

    it("@BeforeUpdate 메타데이터가 저장되어야 한다", () => {
      class Article {
        @BeforeUpdate()
        onBeforeUpdate() {}
      }

      const hooks: HookMetadata[] = Reflect.getMetadata(HOOK_TOKEN, Article) ?? [];
      expect(hooks.some((h) => h.event === "beforeUpdate")).toBe(true);
    });

    it("@AfterUpdate 메타데이터가 저장되어야 한다", () => {
      class Comment {
        @AfterUpdate()
        onAfterUpdate() {}
      }

      const hooks: HookMetadata[] = Reflect.getMetadata(HOOK_TOKEN, Comment) ?? [];
      expect(hooks.some((h) => h.event === "afterUpdate")).toBe(true);
    });

    it("@BeforeDelete 메타데이터가 저장되어야 한다", () => {
      class Tag {
        @BeforeDelete()
        onBeforeDelete() {}
      }

      const hooks: HookMetadata[] = Reflect.getMetadata(HOOK_TOKEN, Tag) ?? [];
      expect(hooks.some((h) => h.event === "beforeDelete")).toBe(true);
    });

    it("@AfterDelete 메타데이터가 저장되어야 한다", () => {
      class Category {
        @AfterDelete()
        onAfterDelete() {}
      }

      const hooks: HookMetadata[] = Reflect.getMetadata(HOOK_TOKEN, Category) ?? [];
      expect(hooks.some((h) => h.event === "afterDelete")).toBe(true);
    });
  });

  describe("다중 훅 등록", () => {
    it("동일 클래스에 여러 훅을 등록할 수 있어야 한다", () => {
      class Order {
        @BeforeInsert()
        validate() {}

        @AfterInsert()
        sendEmail() {}

        @BeforeDelete()
        checkPermission() {}
      }

      const hooks: HookMetadata[] = Reflect.getMetadata(HOOK_TOKEN, Order) ?? [];
      expect(hooks).toHaveLength(3);
      const events = hooks.map((h) => h.event);
      expect(events).toContain("beforeInsert");
      expect(events).toContain("afterInsert");
      expect(events).toContain("beforeDelete");
    });

    it("동일 이벤트에 여러 훅을 등록할 수 있어야 한다", () => {
      class Product {
        @BeforeInsert()
        validatePrice() {}

        @BeforeInsert()
        validateStock() {}
      }

      const hooks: HookMetadata[] = Reflect.getMetadata(HOOK_TOKEN, Product) ?? [];
      const beforeInserts = hooks.filter((h) => h.event === "beforeInsert");
      expect(beforeInserts).toHaveLength(2);
      expect(beforeInserts.map((h) => h.methodName)).toContain("validatePrice");
      expect(beforeInserts.map((h) => h.methodName)).toContain("validateStock");
    });
  });

  describe("훅 없는 엔티티", () => {
    it("훅이 없는 엔티티는 빈 배열이어야 한다", () => {
      class Plain {
        id!: number;
      }

      const hooks: HookMetadata[] = Reflect.getMetadata(HOOK_TOKEN, Plain) ?? [];
      expect(hooks).toHaveLength(0);
    });
  });

  describe("훅 실행 로직 (단위 테스트)", () => {
    it("훅 메서드가 실제로 호출되어야 한다", async () => {
      const called: string[] = [];

      class Invoice {
        @BeforeInsert()
        onBeforeInsert() {
          called.push("beforeInsert");
        }

        @AfterInsert()
        onAfterInsert() {
          called.push("afterInsert");
        }
      }

      const item = new Invoice();
      const hooks: HookMetadata[] = Reflect.getMetadata(HOOK_TOKEN, Invoice) ?? [];

      // Simulate runHooks
      for (const hook of hooks.filter((h) => h.event === "beforeInsert")) {
        await (item as any)[hook.methodName]();
      }

      expect(called).toContain("beforeInsert");
      expect(called).not.toContain("afterInsert");
    });

    it("async 훅 메서드가 await되어야 한다", async () => {
      const log: string[] = [];

      class AsyncEntity {
        @BeforeInsert()
        async asyncHook() {
          await Promise.resolve();
          log.push("async-done");
        }
      }

      const item = new AsyncEntity();
      const hooks: HookMetadata[] = Reflect.getMetadata(HOOK_TOKEN, AsyncEntity) ?? [];

      for (const hook of hooks) {
        await (item as any)[hook.methodName]();
      }

      expect(log).toContain("async-done");
    });
  });

  describe("HookEvent 타입", () => {
    it("6가지 이벤트 타입이 모두 존재해야 한다", () => {
      const events: HookEvent[] = [
        "beforeInsert",
        "afterInsert",
        "beforeUpdate",
        "afterUpdate",
        "beforeDelete",
        "afterDelete",
      ];
      expect(events).toHaveLength(6);
    });
  });
});

// ─── EntityManager integration tests ────────────────────────

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

describe("EntityManager 훅 통합 테스트", () => {
  let em: EntityManager;

  const beforeInsertSpy = jest.fn();
  const afterInsertSpy = jest.fn();
  const beforeUpdateSpy = jest.fn();
  const afterUpdateSpy = jest.fn();
  const beforeDeleteSpy = jest.fn();
  const afterDeleteSpy = jest.fn();

  @Entity()
  class TrackedItem {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    name!: string;

    @BeforeInsert()
    onBeforeInsert() {
      beforeInsertSpy();
    }

    @AfterInsert()
    onAfterInsert() {
      afterInsertSpy();
    }

    @BeforeUpdate()
    onBeforeUpdate() {
      beforeUpdateSpy();
    }

    @AfterUpdate()
    onAfterUpdate() {
      afterUpdateSpy();
    }

    @BeforeDelete()
    onBeforeDelete() {
      beforeDeleteSpy();
    }

    @AfterDelete()
    onAfterDelete() {
      afterDeleteSpy();
    }
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

  it("INSERT 시 @BeforeInsert, @AfterInsert 훅을 호출해야 함", async () => {
    mockQuery.mockResolvedValue({
      results: [{ id: 1 }],
      fields: [],
    });

    const item = new TrackedItem();
    item.name = "test";

    await em.save(TrackedItem, item as any);

    expect(beforeInsertSpy).toHaveBeenCalledTimes(1);
    expect(afterInsertSpy).toHaveBeenCalledTimes(1);
    expect(beforeUpdateSpy).not.toHaveBeenCalled();
    expect(afterUpdateSpy).not.toHaveBeenCalled();
  });

  it("UPDATE 시 @BeforeUpdate, @AfterUpdate 훅을 호출해야 함", async () => {
    mockQuery
      .mockResolvedValueOnce({ results: [], rowCount: 1, fields: [] })
      .mockResolvedValue({ results: [{ id: 1, name: "updated" }], fields: [] });

    const item = new TrackedItem();
    item.id = 1;
    item.name = "updated";

    await em.save(TrackedItem, item as any);

    expect(beforeUpdateSpy).toHaveBeenCalledTimes(1);
    expect(afterUpdateSpy).toHaveBeenCalledTimes(1);
    expect(beforeInsertSpy).not.toHaveBeenCalled();
    expect(afterInsertSpy).not.toHaveBeenCalled();
  });

  it("DELETE 시 @BeforeDelete, @AfterDelete 훅을 호출해야 함", async () => {
    mockQuery.mockResolvedValue({
      results: [], rowCount: 1,
      fields: [],
    });

    const item = new TrackedItem();
    item.id = 1;
    item.onBeforeDelete = beforeDeleteSpy;
    item.onAfterDelete = afterDeleteSpy;

    await em.delete(TrackedItem, item as any);

    expect(beforeDeleteSpy).toHaveBeenCalledTimes(1);
    expect(afterDeleteSpy).toHaveBeenCalledTimes(1);
  });

  it("@BeforeInsert는 INSERT 쿼리 전에 호출되어야 함", async () => {
    const callOrder: string[] = [];

    beforeInsertSpy.mockImplementation(() => {
      callOrder.push("beforeInsert");
    });

    mockQuery.mockImplementation(() => {
      callOrder.push("query");
      return Promise.resolve({ results: [{ id: 1 }], fields: [] });
    });

    const item = new TrackedItem();
    item.name = "ordered";

    await em.save(TrackedItem, item as any);

    const beforeIdx = callOrder.indexOf("beforeInsert");
    const firstQueryIdx = callOrder.indexOf("query");
    expect(beforeIdx).toBeGreaterThanOrEqual(0);
    expect(firstQueryIdx).toBeGreaterThan(beforeIdx);
  });

  it("@BeforeInsert에서 item을 수정할 수 있어야 함", async () => {
    @Entity()
    class TimestampItem {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column()
      name!: string;

      @Column()
      createdAt!: string;

      @BeforeInsert()
      setTimestamp() {
        this.createdAt = "2026-01-01T00:00:00Z";
      }
    }

    mockQuery.mockResolvedValue({
      results: [{ id: 1 }],
      fields: [],
    });

    const item = new TimestampItem();
    item.name = "test";

    await em.save(TimestampItem, item as any);

    expect(item.createdAt).toBe("2026-01-01T00:00:00Z");
  });

  it("훅이 없는 엔티티의 save()는 에러 없이 동작해야 함", async () => {
    @Entity()
    class PlainItem {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column()
      value!: string;
    }

    mockQuery.mockResolvedValue({
      results: [{ id: 1 }],
      fields: [],
    });

    await expect(
      em.save(PlainItem, { value: "test" } as any),
    ).resolves.toBeDefined();
  });

  it("훅이 없는 엔티티의 delete()는 에러 없이 동작해야 함", async () => {
    @Entity()
    class PlainItem2 {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column()
      value!: string;
    }

    mockQuery.mockResolvedValue({
      results: [], rowCount: 1,
      fields: [],
    });

    await expect(
      em.delete(PlainItem2, { id: 1 } as any),
    ).resolves.toEqual({ affected: 1 });
  });
});
