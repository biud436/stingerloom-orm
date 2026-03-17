/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { StingerloomPlugin } from "../../src/core/plugin/StingerloomPlugin";
import { PluginContext } from "../../src/core/plugin/PluginContext";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";
import { OrmError } from "../../src/errors/OrmError";

// Mock DatabaseClient
jest.mock("../../src/DatabaseClient", () => {
  const mockClose = jest.fn().mockResolvedValue(undefined);
  return {
    DatabaseClient: {
      getInstance: jest.fn().mockReturnValue({
        type: "mysql",
        getConnection: jest.fn(),
        getOptions: jest.fn().mockReturnValue({ synchronize: false }),
        connect: jest.fn(),
        close: mockClose,
        getType: jest.fn().mockReturnValue("mysql"),
      }),
    },
  };
});

jest.mock("../../src/dialects/TransactionSessionManager", () => {
  return {
    TransactionSessionManager: jest.fn().mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    })),
  };
});

describe("Plugin System", () => {
  let em: EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    em = new EntityManager();
  });

  // ── Basic Registration ──────────────────────────────────────

  it("should call install() when extending with a plugin", () => {
    const installFn = jest.fn();
    const plugin: StingerloomPlugin = {
      name: "test-plugin",
      install: installFn,
    };

    em.extend(plugin);

    expect(installFn).toHaveBeenCalledTimes(1);
    expect(installFn).toHaveBeenCalledWith(expect.objectContaining({
      em: expect.any(EntityManager),
    }));
  });

  // ── Idempotency ─────────────────────────────────────────────

  it("should only call install() once for the same plugin name", () => {
    const installFn = jest.fn();
    const plugin: StingerloomPlugin = {
      name: "idempotent",
      install: installFn,
    };

    em.extend(plugin);
    em.extend(plugin);
    em.extend(plugin);

    expect(installFn).toHaveBeenCalledTimes(1);
  });

  // ── API Method Mixin ────────────────────────────────────────

  it("should mix plugin API methods into the EntityManager instance", () => {
    const plugin: StingerloomPlugin<{ greet(): string }> = {
      name: "greeter",
      install() {
        return { greet: () => "hello from plugin" };
      },
    };

    const extended = em.extend(plugin);

    expect(extended.greet()).toBe("hello from plugin");
    // Also accessible via the original em reference
    expect((em as any).greet()).toBe("hello from plugin");
  });

  // ── Method Conflict ─────────────────────────────────────────

  it("should throw PLUGIN_CONFLICT when API key collides with existing member", () => {
    const plugin: StingerloomPlugin<{ find(): void }> = {
      name: "conflict",
      install() {
        return { find: () => {} };
      },
    };

    expect(() => em.extend(plugin)).toThrow(OrmError);

    try {
      em.extend(plugin);
    } catch (err: any) {
      expect(err.code).toBe(OrmErrorCode.PLUGIN_CONFLICT);
      expect(err.message).toContain('"conflict"');
      expect(err.message).toContain('"find"');
    }
  });

  // ── Dependency Fulfilled ────────────────────────────────────

  it("should succeed when dependencies are satisfied", () => {
    const pluginA: StingerloomPlugin = {
      name: "base",
      install: jest.fn(),
    };

    const pluginB: StingerloomPlugin = {
      name: "derived",
      dependencies: ["base"],
      install: jest.fn(),
    };

    em.extend(pluginA);
    em.extend(pluginB);

    expect(pluginA.install).toHaveBeenCalledTimes(1);
    expect(pluginB.install).toHaveBeenCalledTimes(1);
    expect(em.hasPlugin("base")).toBe(true);
    expect(em.hasPlugin("derived")).toBe(true);
  });

  // ── Dependency Missing ──────────────────────────────────────

  it("should throw PLUGIN_DEPENDENCY_MISSING when dependency is not installed", () => {
    const plugin: StingerloomPlugin = {
      name: "needs-base",
      dependencies: ["nonexistent"],
      install: jest.fn(),
    };

    expect(() => em.extend(plugin)).toThrow(OrmError);

    try {
      em.extend(plugin);
    } catch (err: any) {
      expect(err.code).toBe(OrmErrorCode.PLUGIN_DEPENDENCY_MISSING);
      expect(err.message).toContain('"needs-base"');
      expect(err.message).toContain('"nonexistent"');
    }
  });

  // ── PluginContext Properties ─────────────────────────────────

  it("should provide correct PluginContext properties", () => {
    let receivedCtx: PluginContext | null = null;
    const plugin: StingerloomPlugin = {
      name: "ctx-check",
      install(ctx) {
        receivedCtx = ctx;
      },
    };

    em.extend(plugin);

    expect(receivedCtx).not.toBeNull();
    expect(receivedCtx!.em).toBe(em);
    expect(receivedCtx!.connectionName).toBe("default");
    expect(receivedCtx!.events).toBeDefined();
    expect(typeof receivedCtx!.addSubscriber).toBe("function");
    expect(typeof receivedCtx!.removeSubscriber).toBe("function");
    expect(typeof receivedCtx!.getEntities).toBe("function");
    expect(typeof receivedCtx!.getPlugin).toBe("function");
    expect(typeof receivedCtx!.isMySqlFamily).toBe("function");
    expect(typeof receivedCtx!.isPostgres).toBe("function");
    expect(typeof receivedCtx!.isSqlite).toBe("function");
    expect(typeof receivedCtx!.wrap).toBe("function");
    expect(typeof receivedCtx!.wrapTable).toBe("function");
    expect(typeof receivedCtx!.executeInTransaction).toBe("function");
    expect(typeof receivedCtx!.executeReadOnly).toBe("function");
  });

  // ── Event Subscription via Plugin ───────────────────────────

  it("should allow plugins to subscribe to entity events", () => {
    const listener = jest.fn();
    const plugin: StingerloomPlugin = {
      name: "event-sub",
      install(ctx) {
        ctx.events.on("afterInsert", listener);
      },
    };

    em.extend(plugin);

    // Emit via the public on/off interface — the same emitter
    const emitter = (em as any).eventEmitter;
    emitter.emit("afterInsert", { entity: class Foo {}, data: { id: 1 } });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  // ── EntitySubscriber via Plugin ─────────────────────────────

  it("should allow plugins to add EntitySubscribers", () => {
    class Dummy {}
    const sub = {
      listenTo: () => Dummy,
      afterInsert: jest.fn(),
    };

    const plugin: StingerloomPlugin = {
      name: "sub-plugin",
      install(ctx) {
        ctx.addSubscriber(sub);
      },
    };

    em.extend(plugin);

    const subs = (em as any).subscribers;
    expect(subs).toContain(sub);
  });

  // ── getPlugin() Cross-Plugin Access ─────────────────────────

  it("should allow plugins to access each other's API via getPlugin()", () => {
    const pluginA: StingerloomPlugin<{ getValue(): number }> = {
      name: "provider",
      install() {
        return { getValue: () => 42 };
      },
    };

    let retrieved: any = null;
    const pluginB: StingerloomPlugin = {
      name: "consumer",
      dependencies: ["provider"],
      install(ctx) {
        retrieved = ctx.getPlugin<{ getValue(): number }>("provider");
      },
    };

    em.extend(pluginA);
    em.extend(pluginB);

    expect(retrieved).not.toBeNull();
    expect(retrieved.getValue()).toBe(42);
  });

  // ── Shutdown Reverse Order ──────────────────────────────────

  it("should call plugin shutdown in reverse order (LIFO)", async () => {
    const order: string[] = [];

    const pluginA: StingerloomPlugin = {
      name: "first",
      install() {},
      shutdown() { order.push("first"); },
    };

    const pluginB: StingerloomPlugin = {
      name: "second",
      install() {},
      shutdown() { order.push("second"); },
    };

    const pluginC: StingerloomPlugin = {
      name: "third",
      install() {},
      shutdown() { order.push("third"); },
    };

    em.extend(pluginA);
    em.extend(pluginB);
    em.extend(pluginC);

    await em.propagateShutdown();

    expect(order).toEqual(["third", "second", "first"]);
  });

  // ── Shutdown Error Isolation ────────────────────────────────

  it("should continue shutdown if a plugin throws during shutdown", async () => {
    const order: string[] = [];

    const pluginA: StingerloomPlugin = {
      name: "safe",
      install() {},
      shutdown() { order.push("safe"); },
    };

    const pluginB: StingerloomPlugin = {
      name: "broken",
      install() {},
      shutdown() {
        throw new Error("broken shutdown");
      },
    };

    em.extend(pluginA);
    em.extend(pluginB);

    // Should not throw
    await em.propagateShutdown();

    // "safe" should still be called despite "broken" throwing
    // Reverse order: broken first (throws), then safe
    expect(order).toEqual(["safe"]);
  });

  // ── hasPlugin() ─────────────────────────────────────────────

  it("should return false before install and true after", () => {
    expect(em.hasPlugin("check-me")).toBe(false);

    em.extend({
      name: "check-me",
      install() {},
    });

    expect(em.hasPlugin("check-me")).toBe(true);
  });

  // ── register() with plugins option ──────────────────────────

  it("should install plugins specified in DatabaseClientOptions", async () => {
    const installA = jest.fn();
    const installB = jest.fn();

    const pluginA: StingerloomPlugin = { name: "optA", install: installA };
    const pluginB: StingerloomPlugin = { name: "optB", install: installB };

    await em.register({
      type: "mysql",
      host: "localhost",
      port: 3306,
      username: "root",
      password: "",
      database: "test",
      entities: [],
      synchronize: false,
      plugins: [pluginA, pluginB],
    });

    expect(installA).toHaveBeenCalledTimes(1);
    expect(installB).toHaveBeenCalledTimes(1);
    expect(em.hasPlugin("optA")).toBe(true);
    expect(em.hasPlugin("optB")).toBe(true);
  });

  // ── Plugin State Isolation ──────────────────────────────────

  it("should maintain independent state per plugin", () => {
    const pluginA: StingerloomPlugin<{ getCountA(): number; incA(): void }> = {
      name: "counter-a",
      install() {
        let count = 0;
        return {
          getCountA: () => count,
          incA: () => { count++; },
        };
      },
    };

    const pluginB: StingerloomPlugin<{ getCountB(): number; incB(): void }> = {
      name: "counter-b",
      install() {
        let count = 100;
        return {
          getCountB: () => count,
          incB: () => { count++; },
        };
      },
    };

    const ext = em.extend(pluginA).extend(pluginB);

    ext.incA();
    ext.incA();
    ext.incB();

    expect(ext.getCountA()).toBe(2);
    expect(ext.getCountB()).toBe(101);
  });

  // ── getPluginApi() ──────────────────────────────────────────

  it("should return undefined for uninstalled plugin", () => {
    expect(em.getPluginApi("nonexistent")).toBeUndefined();
  });

  it("should return the API object for an installed plugin", () => {
    const plugin: StingerloomPlugin<{ magic(): number }> = {
      name: "api-test",
      install() {
        return { magic: () => 7 };
      },
    };

    em.extend(plugin);

    const api = em.getPluginApi<{ magic(): number }>("api-test");
    expect(api).toBeDefined();
    expect(api!.magic()).toBe(7);
  });

  // ── Plugin without API return ───────────────────────────────

  it("should handle plugins that return void from install()", () => {
    const plugin: StingerloomPlugin = {
      name: "void-plugin",
      install() {
        // no return
      },
    };

    // Should not throw
    em.extend(plugin);
    expect(em.hasPlugin("void-plugin")).toBe(true);
    expect(em.getPluginApi("void-plugin")).toEqual({});
  });

  // ── Shutdown clears plugins ─────────────────────────────────

  it("should clear all plugins after propagateShutdown()", async () => {
    em.extend({ name: "temp", install() {} });
    expect(em.hasPlugin("temp")).toBe(true);

    await em.propagateShutdown();

    expect(em.hasPlugin("temp")).toBe(false);
  });

  // ── Async shutdown ──────────────────────────────────────────

  it("should await async plugin shutdown", async () => {
    let shutdownCompleted = false;

    const plugin: StingerloomPlugin = {
      name: "async-shutdown",
      install() {},
      async shutdown() {
        await new Promise((r) => setTimeout(r, 10));
        shutdownCompleted = true;
      },
    };

    em.extend(plugin);
    await em.propagateShutdown();

    expect(shutdownCompleted).toBe(true);
  });

  // ── PluginContext is shared (singleton) ─────────────────────

  it("should provide the same PluginContext to all plugins", () => {
    const contexts: PluginContext[] = [];

    const pluginA: StingerloomPlugin = {
      name: "ctx-a",
      install(ctx) { contexts.push(ctx); },
    };

    const pluginB: StingerloomPlugin = {
      name: "ctx-b",
      install(ctx) { contexts.push(ctx); },
    };

    em.extend(pluginA);
    em.extend(pluginB);

    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toBe(contexts[1]);
  });

  // ── Conflict with plugin-added method ───────────────────────

  it("should throw PLUGIN_CONFLICT when two plugins add the same method", () => {
    const pluginA: StingerloomPlugin<{ sharedMethod(): void }> = {
      name: "plugin-a",
      install() {
        return { sharedMethod: () => {} };
      },
    };

    const pluginB: StingerloomPlugin<{ sharedMethod(): void }> = {
      name: "plugin-b",
      install() {
        return { sharedMethod: () => {} };
      },
    };

    em.extend(pluginA);

    expect(() => em.extend(pluginB)).toThrow(OrmError);

    try {
      // Reset for second attempt (already installed, so need fresh em)
      const em2 = new EntityManager();
      em2.extend(pluginA);
      em2.extend(pluginB);
    } catch (err: any) {
      expect(err.code).toBe(OrmErrorCode.PLUGIN_CONFLICT);
      expect(err.message).toContain('"sharedMethod"');
    }
  });
});
