import "reflect-metadata";
import { QueryTracker, QueryLogEntry } from "../../src/core/QueryTracker";
import { EntityManager } from "../../src/core/EntityManager";

// Mock 모듈 설정
jest.mock("../../src/DatabaseClient", () => {
  return {
    DatabaseClient: {
      getInstance: jest.fn().mockReturnValue({
        type: "mysql",
        getConnection: jest.fn(),
        getOptions: jest.fn().mockReturnValue({ synchronize: false }),
        connect: jest.fn(),
      }),
    },
  };
});

const mockQuery = jest.fn();
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockStartTransaction = jest.fn().mockResolvedValue(undefined);
const mockCommit = jest.fn().mockResolvedValue(undefined);
const mockRollback = jest.fn().mockResolvedValue(undefined);
const mockClose = jest.fn().mockResolvedValue(undefined);

jest.mock("../../src/dialects/TransactionSessionManager", () => {
  return {
    TransactionSessionManager: jest.fn().mockImplementation(() => ({
      connect: mockConnect,
      startTransaction: mockStartTransaction,
      query: mockQuery,
      commit: mockCommit,
      rollback: mockRollback,
      close: mockClose,
    })),
  };
});

describe("QueryTracker", () => {
  let tracker: QueryTracker;

  beforeEach(() => {
    tracker = new QueryTracker();
  });

  describe("track()", () => {
    it("should record a query log entry", () => {
      tracker.track("User", "SELECT * FROM user", 5);

      const log = tracker.getLog();
      expect(log).toHaveLength(1);
      expect(log[0].entityName).toBe("User");
      expect(log[0].sql).toBe("SELECT * FROM user");
      expect(log[0].durationMs).toBe(5);
      expect(log[0].timestamp).toBeGreaterThan(0);
    });

    it("should record multiple query log entries", () => {
      tracker.track("User", "SELECT * FROM user", 5);
      tracker.track("Post", "SELECT * FROM post", 10);
      tracker.track("User", "SELECT * FROM user WHERE id = 1", 3);

      const log = tracker.getLog();
      expect(log).toHaveLength(3);
    });
  });

  describe("getLog()", () => {
    it("should return empty array when no queries tracked", () => {
      expect(tracker.getLog()).toHaveLength(0);
    });

    it("should return readonly array", () => {
      tracker.track("User", "SELECT 1", 1);
      const log = tracker.getLog();
      expect(Array.isArray(log)).toBe(true);
      expect(log).toHaveLength(1);
    });
  });

  describe("reset()", () => {
    it("should clear all log entries", () => {
      tracker.track("User", "SELECT 1", 1);
      tracker.track("Post", "SELECT 2", 2);
      expect(tracker.getLog()).toHaveLength(2);

      tracker.reset();
      expect(tracker.getLog()).toHaveLength(0);
    });

    it("should allow new entries after reset", () => {
      tracker.track("User", "SELECT 1", 1);
      tracker.reset();
      tracker.track("Post", "SELECT 2", 2);
      expect(tracker.getLog()).toHaveLength(1);
      expect(tracker.getLog()[0].entityName).toBe("Post");
    });
  });

  describe("N+1 detection", () => {
    it("should warn when same entity queried 10+ times within window", () => {
      const warnSpy = jest.spyOn(console, "log").mockImplementation();

      // Track 10 queries for same entity rapidly
      for (let i = 0; i < 10; i++) {
        tracker.track("Cat", `SELECT * FROM cat WHERE id = ${i}`, 1);
      }

      // Should have logged an N+1 warning
      const warnCalls = warnSpy.mock.calls.filter(
        (call) => String(call[0]).includes("[N+1 WARNING]"),
      );
      expect(warnCalls.length).toBe(1);
      expect(String(warnCalls[0][0])).toContain("Cat");

      warnSpy.mockRestore();
    });

    it("should not warn when queries are below threshold", () => {
      const warnSpy = jest.spyOn(console, "log").mockImplementation();

      // Only 5 queries, below default threshold of 10
      for (let i = 0; i < 5; i++) {
        tracker.track("Cat", `SELECT * FROM cat WHERE id = ${i}`, 1);
      }

      const warnCalls = warnSpy.mock.calls.filter(
        (call) => String(call[0]).includes("[N+1 WARNING]"),
      );
      expect(warnCalls.length).toBe(0);

      warnSpy.mockRestore();
    });

    it("should not warn twice for the same entity", () => {
      const warnSpy = jest.spyOn(console, "log").mockImplementation();

      // Track 20 queries
      for (let i = 0; i < 20; i++) {
        tracker.track("Cat", `SELECT * FROM cat WHERE id = ${i}`, 1);
      }

      const warnCalls = warnSpy.mock.calls.filter(
        (call) => String(call[0]).includes("[N+1 WARNING]"),
      );
      // Should only warn once, not twice
      expect(warnCalls.length).toBe(1);

      warnSpy.mockRestore();
    });

    it("should warn separately for different entities", () => {
      const warnSpy = jest.spyOn(console, "log").mockImplementation();

      for (let i = 0; i < 10; i++) {
        tracker.track("Cat", `SELECT * FROM cat WHERE id = ${i}`, 1);
      }
      for (let i = 0; i < 10; i++) {
        tracker.track("Dog", `SELECT * FROM dog WHERE id = ${i}`, 1);
      }

      const warnCalls = warnSpy.mock.calls.filter(
        (call) => String(call[0]).includes("[N+1 WARNING]"),
      );
      expect(warnCalls.length).toBe(2);

      warnSpy.mockRestore();
    });

    it("should reset warned entities on reset()", () => {
      const warnSpy = jest.spyOn(console, "log").mockImplementation();

      for (let i = 0; i < 10; i++) {
        tracker.track("Cat", `SELECT * FROM cat WHERE id = ${i}`, 1);
      }

      tracker.reset();

      for (let i = 0; i < 10; i++) {
        tracker.track("Cat", `SELECT * FROM cat WHERE id = ${i}`, 1);
      }

      const warnCalls = warnSpy.mock.calls.filter(
        (call) => String(call[0]).includes("[N+1 WARNING]"),
      );
      // Should warn twice: once before reset, once after
      expect(warnCalls.length).toBe(2);

      warnSpy.mockRestore();
    });

    it("should use custom threshold", () => {
      const customTracker = new QueryTracker({ threshold: 3 });
      const warnSpy = jest.spyOn(console, "log").mockImplementation();

      for (let i = 0; i < 3; i++) {
        customTracker.track("Cat", `SELECT * FROM cat WHERE id = ${i}`, 1);
      }

      const warnCalls = warnSpy.mock.calls.filter(
        (call) => String(call[0]).includes("[N+1 WARNING]"),
      );
      expect(warnCalls.length).toBe(1);

      warnSpy.mockRestore();
    });
  });

  describe("slow query detection", () => {
    it("should warn on slow queries when slowQueryMs is set", () => {
      const slowTracker = new QueryTracker({ slowQueryMs: 100 });
      const warnSpy = jest.spyOn(console, "log").mockImplementation();

      slowTracker.track("User", "SELECT * FROM user", 150);

      const warnCalls = warnSpy.mock.calls.filter(
        (call) => String(call[0]).includes("[SLOW QUERY]"),
      );
      expect(warnCalls.length).toBe(1);
      expect(String(warnCalls[0][0])).toContain("150ms");

      warnSpy.mockRestore();
    });

    it("should not warn on fast queries", () => {
      const slowTracker = new QueryTracker({ slowQueryMs: 100 });
      const warnSpy = jest.spyOn(console, "log").mockImplementation();

      slowTracker.track("User", "SELECT * FROM user", 50);

      const warnCalls = warnSpy.mock.calls.filter(
        (call) => String(call[0]).includes("[SLOW QUERY]"),
      );
      expect(warnCalls.length).toBe(0);

      warnSpy.mockRestore();
    });

    it("should not check slow queries when slowQueryMs is null", () => {
      const warnSpy = jest.spyOn(console, "log").mockImplementation();

      // Default tracker has no slowQueryMs
      tracker.track("User", "SELECT * FROM user", 5000);

      const warnCalls = warnSpy.mock.calls.filter(
        (call) => String(call[0]).includes("[SLOW QUERY]"),
      );
      expect(warnCalls.length).toBe(0);

      warnSpy.mockRestore();
    });
  });
});

describe("EntityManager QueryTracker integration", () => {
  let em: EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    em = new EntityManager();

    // resolveEntityMetadata mock
    jest.spyOn((em as any).resolver, "resolveEntityMetadata").mockReturnValue({
      name: "User",
      target: class User {},
      columns: [
        { name: "id", options: { primary: true, autoIncrement: true } },
        { name: "name", options: {} },
      ],
    });

    // isMySqlFamily mock
    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);
    jest.spyOn(em as any, "isPostgres").mockReturnValue(false);
    jest.spyOn(em as any, "wrap").mockImplementation((...args: any[]) => `\`${args[0]}\``);
    jest.spyOn((em as any).resolver, "resolveOneToOneMetadata").mockReturnValue([]);
    jest.spyOn((em as any).resolver, "resolveManyToOneMetadata").mockReturnValue([]);
    jest.spyOn((em as any).resolver, "resolveOneToManyMetadata").mockReturnValue([]);
    jest.spyOn((em as any).cascadeHandler, "runHooks").mockResolvedValue(undefined);
    jest.spyOn((em as any).cascadeHandler, "cascadeSaveOneToMany").mockResolvedValue(undefined);
    jest.spyOn((em as any).resolver, "getDeletedAtColumn").mockReturnValue(null);
    jest.spyOn(em as any, "findOneInternal").mockResolvedValue(undefined);
  });

  it("should return empty query log by default", () => {
    expect(em.getQueryLog()).toEqual([]);
  });

  it("should initialize QueryTracker when nPlusOne logging is enabled", () => {
    (em as any).initQueryTracker({
      type: "mysql",
      host: "localhost",
      port: 3306,
      username: "root",
      password: "",
      database: "test",
      entities: [],
      logging: { nPlusOne: true },
    });

    expect((em as any).queryTracker).not.toBeNull();
  });

  it("should initialize QueryTracker when slowQueryMs is set", () => {
    (em as any).initQueryTracker({
      type: "mysql",
      host: "localhost",
      port: 3306,
      username: "root",
      password: "",
      database: "test",
      entities: [],
      logging: { slowQueryMs: 200 },
    });

    expect((em as any).queryTracker).not.toBeNull();
  });

  it("should NOT initialize QueryTracker when logging is just boolean true", () => {
    (em as any).initQueryTracker({
      type: "mysql",
      host: "localhost",
      port: 3306,
      username: "root",
      password: "",
      database: "test",
      entities: [],
      logging: true,
    });

    expect((em as any).queryTracker).toBeNull();
  });

  it("should track queries via trackQuery when QueryTracker is enabled", () => {
    (em as any).initQueryTracker({
      type: "mysql",
      host: "localhost",
      port: 3306,
      username: "root",
      password: "",
      database: "test",
      entities: [],
      logging: { nPlusOne: true },
    });

    (em as any).trackQuery("User", "SELECT * FROM user", 5);

    const log = em.getQueryLog();
    expect(log).toHaveLength(1);
    expect(log[0].entityName).toBe("User");
    expect(log[0].durationMs).toBe(5);
  });

  it("should not fail when trackQuery is called without QueryTracker", () => {
    expect(() => {
      (em as any).trackQuery("User", "SELECT * FROM user", 5);
    }).not.toThrow();
  });

  it("should track queries during save()", async () => {
    (em as any).initQueryTracker({
      type: "mysql",
      host: "localhost",
      port: 3306,
      username: "root",
      password: "",
      database: "test",
      entities: [],
      logging: { nPlusOne: true },
    });

    mockQuery
      .mockResolvedValueOnce(undefined) // SET autocommit = 0
      .mockResolvedValueOnce({
        results: { insertId: 1, affectedRows: 1 },
        fields: [],
      });

    class User { id!: number; name!: string; }
    jest.spyOn((em as any).resolver, "resolveEntityMetadata").mockReturnValue({
      name: "User",
      target: User,
      columns: [
        { name: "id", options: { primary: true, autoIncrement: true } },
        { name: "name", options: {} },
      ],
    });

    await em.save(User, { name: "Alice" });

    const log = em.getQueryLog();
    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(log.some((e) => e.entityName === "User")).toBe(true);
  });

  it("should track queries during delete()", async () => {
    (em as any).initQueryTracker({
      type: "mysql",
      host: "localhost",
      port: 3306,
      username: "root",
      password: "",
      database: "test",
      entities: [],
      logging: { nPlusOne: true },
    });

    mockQuery
      .mockResolvedValueOnce(undefined) // SET autocommit = 0
      .mockResolvedValueOnce({
        results: { affectedRows: 1 },
        fields: [],
      });

    class User { id!: number; name!: string; }
    jest.spyOn((em as any).resolver, "resolveEntityMetadata").mockReturnValue({
      name: "User",
      target: User,
      columns: [
        { name: "id", options: { primary: true, autoIncrement: true } },
        { name: "name", options: {} },
      ],
    });

    await em.delete(User, { id: 1 } as any);

    const log = em.getQueryLog();
    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(log.some((e) => e.entityName === "User")).toBe(true);
  });
});
