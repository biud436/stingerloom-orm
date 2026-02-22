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
