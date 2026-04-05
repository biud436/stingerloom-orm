import "reflect-metadata";
import {
  StingerloomPlugin,
  QueryInfo,
} from "../../src/core/plugin/StingerloomPlugin";
import { EntityManager } from "../../src/core/EntityManager";

describe("Plugin query hooks (#228)", () => {
  describe("StingerloomPlugin interface", () => {
    it("should accept plugins with beforeQuery hook", () => {
      const plugin: StingerloomPlugin<{}> = {
        name: "test-before-query",
        install: () => ({}),
        beforeQuery(query: QueryInfo) {
          return { ...query, sql: query.sql + " /* modified */" };
        },
      };

      expect(plugin.beforeQuery).toBeDefined();
      const result = plugin.beforeQuery!({
        sql: "SELECT 1",
        operation: "select",
      });
      expect(result?.sql).toContain("/* modified */");
    });

    it("should accept plugins with afterQuery hook", () => {
      const log: { sql: string; duration: number }[] = [];

      const plugin: StingerloomPlugin<{}> = {
        name: "test-after-query",
        install: () => ({}),
        afterQuery(query: QueryInfo, _result: any, durationMs: number) {
          log.push({ sql: query.sql, duration: durationMs });
        },
      };

      plugin.afterQuery!(
        { sql: "SELECT 1", operation: "select" },
        [{ id: 1 }],
        5,
      );

      expect(log).toHaveLength(1);
      expect(log[0].sql).toBe("SELECT 1");
      expect(log[0].duration).toBe(5);
    });

    it("should accept plugins with transaction hooks", () => {
      let beforeCalled = false;
      let afterCommitted: boolean | undefined;

      const plugin: StingerloomPlugin<{}> = {
        name: "test-tx-hooks",
        install: () => ({}),
        beforeTransaction() {
          beforeCalled = true;
        },
        afterTransaction(committed: boolean) {
          afterCommitted = committed;
        },
      };

      plugin.beforeTransaction!();
      expect(beforeCalled).toBe(true);

      plugin.afterTransaction!(true);
      expect(afterCommitted).toBe(true);
    });

    it("should accept plugins without any hooks (backward compat)", () => {
      const plugin: StingerloomPlugin<{ greet(): string }> = {
        name: "test-no-hooks",
        install: () => ({ greet: () => "hello" }),
      };

      expect(plugin.beforeQuery).toBeUndefined();
      expect(plugin.afterQuery).toBeUndefined();
      expect(plugin.beforeTransaction).toBeUndefined();
      expect(plugin.afterTransaction).toBeUndefined();
    });
  });

  describe("EntityManager plugin hook notification", () => {
    it("should call notifyPluginBeforeQuery on installed plugins", () => {
      const em = new EntityManager();
      const queries: QueryInfo[] = [];

      const plugin: StingerloomPlugin<{}> = {
        name: "capture",
        install: () => ({}),
        beforeQuery(query) {
          queries.push(query);
        },
      };

      em.extend(plugin);

      const queryInfo: QueryInfo = { sql: "SELECT 1", operation: "select" };
      em.notifyPluginBeforeQuery(queryInfo);

      expect(queries).toHaveLength(1);
      expect(queries[0].sql).toBe("SELECT 1");
    });

    it("should allow beforeQuery to transform the query", () => {
      const em = new EntityManager();

      const plugin: StingerloomPlugin<{}> = {
        name: "transform",
        install: () => ({}),
        beforeQuery(query) {
          return { ...query, sql: query.sql + " /* traced */" };
        },
      };

      em.extend(plugin);

      const result = em.notifyPluginBeforeQuery({
        sql: "SELECT 1",
        operation: "select",
      });

      expect(result.sql).toBe("SELECT 1 /* traced */");
    });

    it("should call notifyPluginAfterQuery on installed plugins", () => {
      const em = new EntityManager();
      const log: { sql: string; duration: number }[] = [];

      const plugin: StingerloomPlugin<{}> = {
        name: "audit",
        install: () => ({}),
        afterQuery(query, _result, duration) {
          log.push({ sql: query.sql, duration });
        },
      };

      em.extend(plugin);

      em.notifyPluginAfterQuery(
        { sql: "INSERT INTO users", operation: "insert" },
        { affected: 1 },
        10,
      );

      expect(log).toHaveLength(1);
      expect(log[0].sql).toBe("INSERT INTO users");
      expect(log[0].duration).toBe(10);
    });

    it("should chain multiple plugins in order", () => {
      const em = new EntityManager();
      const order: string[] = [];

      em.extend({
        name: "first",
        install: () => ({}),
        beforeQuery(query) {
          order.push("first");
          return query;
        },
      });

      em.extend({
        name: "second",
        install: () => ({}),
        beforeQuery(query) {
          order.push("second");
          return query;
        },
      });

      em.notifyPluginBeforeQuery({ sql: "SELECT 1" });
      expect(order).toEqual(["first", "second"]);
    });
  });

  describe("EntityManager.registerPluginPlaceholder", () => {
    it("should allow registering new plugin placeholders", () => {
      // This should not throw
      EntityManager.registerPluginPlaceholder("customMethod");

      const em = new EntityManager();
      const plugin: StingerloomPlugin<{ customMethod(): string }> = {
        name: "custom",
        install: () => ({
          customMethod: () => "works",
        }),
      };

      // Should not throw "conflicts with existing member" since we registered it
      em.extend(plugin);
      expect((em as any).customMethod()).toBe("works");
    });
  });
});
