import "reflect-metadata";
import { QueryTracker, QueryLogEntry } from "../../src/core/QueryTracker";

describe("QueryTracker — Memory Leak Prevention (Issue #14)", () => {
  describe("maxLogEntries (ring buffer)", () => {
    it("should limit log entries to maxLogEntries", () => {
      const tracker = new QueryTracker({ maxLogEntries: 5 });

      for (let i = 0; i < 10; i++) {
        tracker.track("User", `SELECT ${i}`, 1);
      }

      const log = tracker.getLog();
      expect(log).toHaveLength(5);
      // Should keep the most recent 5 entries (indices 5-9)
      expect(log[0].sql).toBe("SELECT 5");
      expect(log[4].sql).toBe("SELECT 9");
    });

    it("should default maxLogEntries to 1000", () => {
      const tracker = new QueryTracker();

      for (let i = 0; i < 1050; i++) {
        tracker.track("User", `SELECT ${i}`, 1);
      }

      const log = tracker.getLog();
      expect(log).toHaveLength(1000);
      expect(log[0].sql).toBe("SELECT 50");
      expect(log[999].sql).toBe("SELECT 1049");
    });

    it("should allow unlimited entries when maxLogEntries is 0", () => {
      const tracker = new QueryTracker({ maxLogEntries: 0 });

      for (let i = 0; i < 2000; i++) {
        tracker.track("User", `SELECT ${i}`, 1);
      }

      expect(tracker.getLog()).toHaveLength(2000);
    });

    it("should not trim when below maxLogEntries", () => {
      const tracker = new QueryTracker({ maxLogEntries: 100 });

      for (let i = 0; i < 50; i++) {
        tracker.track("User", `SELECT ${i}`, 1);
      }

      expect(tracker.getLog()).toHaveLength(50);
    });

    it("should trim exactly to maxLogEntries after exceeding", () => {
      const tracker = new QueryTracker({ maxLogEntries: 3 });

      tracker.track("A", "SELECT 1", 1);
      tracker.track("B", "SELECT 2", 1);
      tracker.track("C", "SELECT 3", 1);
      expect(tracker.getLog()).toHaveLength(3);

      tracker.track("D", "SELECT 4", 1);
      expect(tracker.getLog()).toHaveLength(3);
      expect(tracker.getLog()[0].entityName).toBe("B");
      expect(tracker.getLog()[2].entityName).toBe("D");
    });
  });

  describe("enabled option", () => {
    it("should not track queries when enabled is false", () => {
      const tracker = new QueryTracker({ enabled: false });

      tracker.track("User", "SELECT * FROM user", 5);
      tracker.track("Post", "SELECT * FROM post", 10);

      expect(tracker.getLog()).toHaveLength(0);
    });

    it("should track queries when enabled is true (default)", () => {
      const tracker = new QueryTracker();

      tracker.track("User", "SELECT * FROM user", 5);

      expect(tracker.getLog()).toHaveLength(1);
    });

    it("should track queries when enabled is explicitly true", () => {
      const tracker = new QueryTracker({ enabled: true });

      tracker.track("User", "SELECT * FROM user", 5);

      expect(tracker.getLog()).toHaveLength(1);
    });

    it("should not emit slow query warnings when disabled", () => {
      const tracker = new QueryTracker({ enabled: false, slowQueryMs: 10 });
      const warnSpy = jest.spyOn(console, "log").mockImplementation();

      tracker.track("User", "SELECT * FROM user", 5000);

      const warnCalls = warnSpy.mock.calls.filter(
        (call) => String(call[0]).includes("[SLOW QUERY]"),
      );
      expect(warnCalls).toHaveLength(0);

      warnSpy.mockRestore();
    });

    it("should not emit N+1 warnings when disabled", () => {
      const tracker = new QueryTracker({ enabled: false, threshold: 3 });
      const warnSpy = jest.spyOn(console, "log").mockImplementation();

      for (let i = 0; i < 10; i++) {
        tracker.track("User", `SELECT ${i}`, 1);
      }

      const warnCalls = warnSpy.mock.calls.filter(
        (call) => String(call[0]).includes("[N+1 WARNING]"),
      );
      expect(warnCalls).toHaveLength(0);

      warnSpy.mockRestore();
    });
  });

  describe("TTL mechanism", () => {
    it("should evict entries older than ttlMs", () => {
      const tracker = new QueryTracker({ ttlMs: 200, maxLogEntries: 0 });

      // Add entries with old timestamps by manipulating the log directly
      const now = Date.now();
      const log = (tracker as any).log as QueryLogEntry[];
      log.push(
        { entityName: "Old1", sql: "SELECT old1", durationMs: 1, timestamp: now - 500 },
        { entityName: "Old2", sql: "SELECT old2", durationMs: 1, timestamp: now - 300 },
      );

      // track() triggers eviction
      tracker.track("New", "SELECT new", 1);

      const result = tracker.getLog();
      // Old1 and Old2 should be evicted (> 200ms old), only New remains
      expect(result).toHaveLength(1);
      expect(result[0].entityName).toBe("New");
    });

    it("should not evict entries within ttlMs", () => {
      const tracker = new QueryTracker({ ttlMs: 10000, maxLogEntries: 0 });

      tracker.track("A", "SELECT a", 1);
      tracker.track("B", "SELECT b", 1);
      tracker.track("C", "SELECT c", 1);

      expect(tracker.getLog()).toHaveLength(3);
    });

    it("should not perform TTL eviction when ttlMs is 0 (disabled)", () => {
      const tracker = new QueryTracker({ ttlMs: 0, maxLogEntries: 0 });

      const now = Date.now();
      const log = (tracker as any).log as QueryLogEntry[];
      log.push(
        { entityName: "Old", sql: "SELECT old", durationMs: 1, timestamp: now - 100000 },
      );

      tracker.track("New", "SELECT new", 1);

      expect(tracker.getLog()).toHaveLength(2);
    });

    it("should combine TTL and maxLogEntries", () => {
      const tracker = new QueryTracker({ ttlMs: 200, maxLogEntries: 2 });

      const now = Date.now();
      const log = (tracker as any).log as QueryLogEntry[];
      // Add 3 old entries
      log.push(
        { entityName: "Old1", sql: "SELECT old1", durationMs: 1, timestamp: now - 500 },
        { entityName: "Old2", sql: "SELECT old2", durationMs: 1, timestamp: now - 400 },
        { entityName: "Old3", sql: "SELECT old3", durationMs: 1, timestamp: now - 300 },
      );

      // New entry triggers TTL first (removes all 3 old), then adds 1
      tracker.track("New1", "SELECT new1", 1);
      tracker.track("New2", "SELECT new2", 1);
      tracker.track("New3", "SELECT new3", 1);

      const result = tracker.getLog();
      // maxLogEntries=2, so only 2 remain
      expect(result).toHaveLength(2);
      expect(result[0].entityName).toBe("New2");
      expect(result[1].entityName).toBe("New3");
    });
  });

  describe("activeQueryCount", () => {
    it("should start at 0", () => {
      const tracker = new QueryTracker();
      expect(tracker.activeQueryCount).toBe(0);
    });

    it("should increment on beginQuery()", () => {
      const tracker = new QueryTracker();
      tracker.beginQuery();
      expect(tracker.activeQueryCount).toBe(1);
      tracker.beginQuery();
      expect(tracker.activeQueryCount).toBe(2);
    });

    it("should decrement on endQuery()", () => {
      const tracker = new QueryTracker();
      tracker.beginQuery();
      tracker.beginQuery();
      tracker.endQuery();
      expect(tracker.activeQueryCount).toBe(1);
      tracker.endQuery();
      expect(tracker.activeQueryCount).toBe(0);
    });

    it("should not go below 0 on endQuery()", () => {
      const tracker = new QueryTracker();
      tracker.endQuery();
      expect(tracker.activeQueryCount).toBe(0);
    });
  });

  describe("waitForQueries()", () => {
    it("should resolve immediately when no active queries", async () => {
      const tracker = new QueryTracker();
      const result = await tracker.waitForQueries(1000);
      expect(result).toBe(true);
    });

    it("should resolve true when active queries complete within timeout", async () => {
      const tracker = new QueryTracker();
      tracker.beginQuery();

      // Simulate query completion after 50ms
      setTimeout(() => tracker.endQuery(), 50);

      const result = await tracker.waitForQueries(5000);
      expect(result).toBe(true);
      expect(tracker.activeQueryCount).toBe(0);
    });

    it("should resolve false on timeout", async () => {
      const tracker = new QueryTracker();
      tracker.beginQuery();

      const result = await tracker.waitForQueries(100);
      expect(result).toBe(false);
      expect(tracker.activeQueryCount).toBe(1);

      // Cleanup
      tracker.endQuery();
    });

    it("should wait for multiple active queries", async () => {
      const tracker = new QueryTracker();
      tracker.beginQuery();
      tracker.beginQuery();
      tracker.beginQuery();

      setTimeout(() => tracker.endQuery(), 20);
      setTimeout(() => tracker.endQuery(), 40);
      setTimeout(() => tracker.endQuery(), 60);

      const result = await tracker.waitForQueries(5000);
      expect(result).toBe(true);
      expect(tracker.activeQueryCount).toBe(0);
    });
  });

  describe("QueryTrackerOptions interface", () => {
    it("should accept all options together", () => {
      const tracker = new QueryTracker({
        windowMs: 200,
        threshold: 5,
        slowQueryMs: 500,
        maxLogEntries: 100,
        enabled: true,
        ttlMs: 60000,
      });

      tracker.track("Test", "SELECT 1", 1);
      expect(tracker.getLog()).toHaveLength(1);
    });

    it("should work with no options (all defaults)", () => {
      const tracker = new QueryTracker();
      tracker.track("Test", "SELECT 1", 1);
      expect(tracker.getLog()).toHaveLength(1);
    });
  });
});
