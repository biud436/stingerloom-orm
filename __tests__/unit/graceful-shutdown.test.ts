import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { QueryTracker } from "../../src/core/QueryTracker";

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

/**
 * Runs `fn` under fake timers. Waiting for the grace period needs the clock
 * to move, and nothing here moves it, so a wait would hang the test instead
 * of settling. That makes "it did not wait" a fact rather than an elapsed-time
 * bound, which a loaded test run can stretch past any limit.
 */
async function settlesWithoutWaiting<T>(fn: () => Promise<T>): Promise<T> {
  jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
  try {
    const result = await fn();
    expect(jest.getTimerCount()).toBe(0);
    return result;
  } finally {
    jest.useRealTimers();
  }
}

describe("Graceful Shutdown (Issue #18)", () => {
  let em: EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    em = new EntityManager();
  });

  describe("propagateShutdown() — basic behavior", () => {
    it("should return true when called without options", async () => {
      const result = await em.propagateShutdown();
      expect(result).toBe(true);
    });

    it("should return true when called with empty options", async () => {
      const result = await em.propagateShutdown({});
      expect(result).toBe(true);
    });

    it("should clear subscribers", async () => {
      const subscribers = (em as any).subscribers;
      subscribers.push({ afterInsert: jest.fn() });
      expect(subscribers).toHaveLength(1);

      await em.propagateShutdown();

      expect(subscribers).toHaveLength(0);
    });

    it("should clear dirtyEntities", async () => {
      const dirtyEntities = (em as any).dirtyEntities as Set<any>;
      dirtyEntities.add({ id: 1 });
      expect(dirtyEntities.size).toBe(1);

      await em.propagateShutdown();

      expect(dirtyEntities.size).toBe(0);
    });

    it("should null out queryTracker", async () => {
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

      await em.propagateShutdown();

      expect((em as any).queryTracker).toBeNull();
    });

    it("should null out replicationRouter", async () => {
      // Manually set a replication router
      const { ReplicationRouter } = require("../../src/dialects/ReplicationRouter");
      (em as any).replication["router"] = new ReplicationRouter({
        master: { host: "master", port: 5432, username: "u", password: "p", database: "db" },
        slaves: [{ host: "slave1", port: 5432, username: "u", password: "p", database: "db" }],
      });

      expect((em as any).replication["router"]).not.toBeNull();

      await em.propagateShutdown();

      expect((em as any).replication["router"]).toBeNull();
    });

    it("should reset replicationRouter failedSlaves before nulling", async () => {
      const { ReplicationRouter } = require("../../src/dialects/ReplicationRouter");
      const slave = { host: "slave1", port: 5432, username: "u", password: "p", database: "db" };
      const router = new ReplicationRouter({
        master: { host: "master", port: 5432, username: "u", password: "p", database: "db" },
        slaves: [slave],
      });
      router.markSlaveFailed(slave);
      expect(router.healthySlaveCount).toBe(0);

      (em as any).replication["router"] = router;

      const resetSpy = jest.spyOn(router, "resetFailedSlaves");
      await em.propagateShutdown();

      expect(resetSpy).toHaveBeenCalled();
    });
  });

  describe("propagateShutdown() — gracefulTimeoutMs", () => {
    it("should wait for active queries before shutting down", async () => {
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

      const tracker = (em as any).queryTracker as QueryTracker;
      tracker.beginQuery();

      // Simulate query completing after 50ms
      setTimeout(() => tracker.endQuery(), 50);

      const result = await em.propagateShutdown({ gracefulTimeoutMs: 5000 });
      expect(result).toBe(true);
    });

    it("should return false when queries do not complete within timeout", async () => {
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

      const tracker = (em as any).queryTracker as QueryTracker;
      tracker.beginQuery(); // This query never completes

      const result = await em.propagateShutdown({ gracefulTimeoutMs: 100 });
      expect(result).toBe(false);
    });

    it("should return true immediately when no active queries", async () => {
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

      const result = await settlesWithoutWaiting(() =>
        em.propagateShutdown({ gracefulTimeoutMs: 5000 }),
      );

      // No active queries → nothing to wait for, despite the 5 s grace period.
      expect(result).toBe(true);
    });

    it("should skip waiting when gracefulTimeoutMs is 0 (default)", async () => {
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

      const tracker = (em as any).queryTracker as QueryTracker;
      tracker.beginQuery();

      const result = await settlesWithoutWaiting(() =>
        em.propagateShutdown({ gracefulTimeoutMs: 0 }),
      );

      expect(result).toBe(true); // No waiting, so "success"
    });

    it("should skip waiting when queryTracker is null", async () => {
      // Default state: queryTracker is null
      expect((em as any).queryTracker).toBeNull();

      const result = await em.propagateShutdown({ gracefulTimeoutMs: 5000 });
      expect(result).toBe(true);
    });
  });

  describe("propagateShutdown() — closeConnections", () => {
    it("should close connection when closeConnections is true", async () => {
      const { DatabaseClient } = require("../../src/DatabaseClient");
      const mockClient = DatabaseClient.getInstance();

      await em.propagateShutdown({ closeConnections: true });

      expect(mockClient.close).toHaveBeenCalledWith("default");
    });

    it("should not close connection when closeConnections is false (default)", async () => {
      const { DatabaseClient } = require("../../src/DatabaseClient");
      const mockClient = DatabaseClient.getInstance();

      await em.propagateShutdown();

      expect(mockClient.close).not.toHaveBeenCalled();
    });

    it("should handle connection close errors gracefully", async () => {
      const { DatabaseClient } = require("../../src/DatabaseClient");
      const mockClient = DatabaseClient.getInstance();
      mockClient.close.mockRejectedValueOnce(new Error("Connection already closed"));

      // Should not throw
      const result = await em.propagateShutdown({ closeConnections: true });
      expect(result).toBe(true);
    });

    it("should close the correct named connection", async () => {
      const { DatabaseClient } = require("../../src/DatabaseClient");
      const mockClient = DatabaseClient.getInstance();

      (em as any).connectionName = "secondary";

      await em.propagateShutdown({ closeConnections: true });

      expect(mockClient.close).toHaveBeenCalledWith("secondary");
    });
  });

  describe("propagateShutdown() — combined options", () => {
    it("should wait for queries then close connections", async () => {
      const { DatabaseClient } = require("../../src/DatabaseClient");
      const mockClient = DatabaseClient.getInstance();

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

      const tracker = (em as any).queryTracker as QueryTracker;
      tracker.beginQuery();

      setTimeout(() => tracker.endQuery(), 30);

      const result = await em.propagateShutdown({
        gracefulTimeoutMs: 5000,
        closeConnections: true,
      });

      expect(result).toBe(true);
      expect(mockClient.close).toHaveBeenCalled();
      expect((em as any).queryTracker).toBeNull();
      expect((em as any).replication["router"]).toBeNull();
    });
  });

  describe("getQueryTracker()", () => {
    it("should return null by default", () => {
      expect(em.getQueryTracker()).toBeNull();
    });

    it("should return the tracker when initialized", () => {
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

      expect(em.getQueryTracker()).toBeInstanceOf(QueryTracker);
    });
  });

  describe("EntityManager initQueryTracker — new options", () => {
    it("should pass enableQueryTracking=false to disable tracker", () => {
      (em as any).initQueryTracker({
        type: "mysql",
        host: "localhost",
        port: 3306,
        username: "root",
        password: "",
        database: "test",
        entities: [],
        logging: { nPlusOne: true, enableQueryTracking: false },
      });

      expect((em as any).queryTracker).toBeNull();
    });

    it("should pass maxLogEntries to tracker", () => {
      (em as any).initQueryTracker({
        type: "mysql",
        host: "localhost",
        port: 3306,
        username: "root",
        password: "",
        database: "test",
        entities: [],
        logging: { nPlusOne: true, maxLogEntries: 50 },
      });

      const tracker = (em as any).queryTracker as QueryTracker;
      expect(tracker).not.toBeNull();

      // Verify maxLogEntries is applied by tracking more than 50
      for (let i = 0; i < 60; i++) {
        tracker.track("User", `SELECT ${i}`, 1);
      }
      expect(tracker.getLog()).toHaveLength(50);
    });

    it("should pass ttlMs to tracker", () => {
      (em as any).initQueryTracker({
        type: "mysql",
        host: "localhost",
        port: 3306,
        username: "root",
        password: "",
        database: "test",
        entities: [],
        logging: { nPlusOne: true, ttlMs: 5000 },
      });

      const tracker = (em as any).queryTracker as QueryTracker;
      expect(tracker).not.toBeNull();
      expect((tracker as any).ttlMs).toBe(5000);
    });
  });

  describe("beginTrackQuery / trackQuery integration", () => {
    it("should increment and decrement active count via beginTrackQuery/trackQuery", () => {
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

      const tracker = (em as any).queryTracker as QueryTracker;

      // Simulate what EntityManager does before/after query execution
      (em as any).beginTrackQuery();
      expect(tracker.activeQueryCount).toBe(1);

      (em as any).trackQuery("User", "SELECT * FROM user", 5);
      expect(tracker.activeQueryCount).toBe(0);
      expect(tracker.getLog()).toHaveLength(1);
    });

    it("should not throw when tracker is null", () => {
      expect(() => {
        (em as any).beginTrackQuery();
      }).not.toThrow();

      expect(() => {
        (em as any).trackQuery("User", "SELECT 1", 1);
      }).not.toThrow();
    });
  });
});
