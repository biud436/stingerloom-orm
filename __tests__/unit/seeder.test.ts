/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  Seeder,
  SeederContext,
  SeederRunner,
  SeederQueryRunner,
  SeederResult,
} from "../../src/seeding";
import { EntityManager } from "../../src/core/EntityManager";
import { ISqlDriver } from "../../src/dialects/SqlDriver";

// ─── Mock helpers ────────────────────────────────────────────

function createMockDriver(isMySql: boolean): ISqlDriver {
  return {
    isMySqlFamily: () => isMySql,
  } as unknown as ISqlDriver;
}

function createMockEntityManager(isMySql: boolean): EntityManager {
  const driver = createMockDriver(isMySql);
  return {
    getDriver: () => driver,
  } as unknown as EntityManager;
}

/** EM double that also exposes `_ctx.getDialect()` like the real manager. */
function createMockEntityManagerWithDialect(
  dialect: "mysql" | "postgres" | "sqlite",
): EntityManager {
  const driver = createMockDriver(dialect === "mysql");
  return {
    getDriver: () => driver,
    _ctx: { getDialect: () => dialect },
  } as unknown as EntityManager;
}

function createMockQueryRunner(): SeederQueryRunner & {
  queries: string[];
  mockSelect: (rows: any[]) => void;
} {
  let selectResult: any = { results: [] };
  const queries: string[] = [];
  return {
    queries,
    mockSelect: (rows: any[]) => {
      selectResult = { results: rows };
    },
    query: jest.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes("SELECT")) {
        return selectResult;
      }
      return { results: [] };
    }),
  };
}

// ─── Test seeders ────────────────────────────────────────────

class UserSeeder extends Seeder {
  runCalled = false;
  revertCalled = false;

  async run(ctx: SeederContext): Promise<void> {
    this.runCalled = true;
  }

  async revert(ctx: SeederContext): Promise<void> {
    this.revertCalled = true;
  }
}

class PostSeeder extends Seeder {
  runCalled = false;

  async run(ctx: SeederContext): Promise<void> {
    this.runCalled = true;
  }

  async revert(ctx: SeederContext): Promise<void> {
    // no-op
  }
}

class FailingSeeder extends Seeder {
  async run(_ctx: SeederContext): Promise<void> {
    throw new Error("Seeder failed intentionally");
  }
}

class NoRevertSeeder extends Seeder {
  async run(_ctx: SeederContext): Promise<void> {
    // no-op
  }
  // No revert() method
}

// ─── Tests ───────────────────────────────────────────────────

describe("SeederRunner", () => {
  describe("ensureSeedTable()", () => {
    it("should create __seeds table with MySQL syntax", async () => {
      const em = createMockEntityManager(true);
      const qr = createMockQueryRunner();
      const runner = new SeederRunner([], em, qr);

      await runner.ensureSeedTable();

      expect(qr.queries[0]).toContain("`__seeds`");
      expect(qr.queries[0]).toContain("AUTO_INCREMENT");
      expect(qr.queries[0]).toContain("CREATE TABLE IF NOT EXISTS");
    });

    it("should create __seeds table with PostgreSQL syntax", async () => {
      const em = createMockEntityManager(false);
      const qr = createMockQueryRunner();
      const runner = new SeederRunner([], em, qr);

      await runner.ensureSeedTable();

      expect(qr.queries[0]).toContain('"__seeds"');
      expect(qr.queries[0]).toContain("SERIAL PRIMARY KEY");
      expect(qr.queries[0]).toContain("CREATE TABLE IF NOT EXISTS");
    });

    it("should create __seeds table with SQLite rowid-alias syntax", async () => {
      const em = createMockEntityManagerWithDialect("sqlite");
      const qr = createMockQueryRunner();
      const runner = new SeederRunner([], em, qr);

      await runner.ensureSeedTable();

      expect(qr.queries[0]).toContain('"__seeds"');
      expect(qr.queries[0]).toContain("INTEGER PRIMARY KEY AUTOINCREMENT");
      expect(qr.queries[0]).not.toContain("SERIAL");
    });

    it("should keep PostgreSQL syntax when the EM exposes its dialect", async () => {
      const em = createMockEntityManagerWithDialect("postgres");
      const qr = createMockQueryRunner();
      const runner = new SeederRunner([], em, qr);

      await runner.ensureSeedTable();

      expect(qr.queries[0]).toContain("SERIAL PRIMARY KEY");
    });

    it("should use custom table name", async () => {
      const em = createMockEntityManager(false);
      const qr = createMockQueryRunner();
      const runner = new SeederRunner([], em, qr, {
        tableName: "__custom_seeds",
      });

      await runner.ensureSeedTable();

      expect(qr.queries[0]).toContain('"__custom_seeds"');
    });
  });

  describe("runAll()", () => {
    it("should execute all pending seeders in order", async () => {
      const em = createMockEntityManager(false);
      const qr = createMockQueryRunner();
      const s1 = new UserSeeder();
      const s2 = new PostSeeder();

      const runner = new SeederRunner([s1, s2], em, qr);
      const results = await runner.runAll();

      expect(results).toHaveLength(2);
      expect(results[0].name).toBe("UserSeeder");
      expect(results[0].success).toBe(true);
      expect(results[0].direction).toBe("run");
      expect(results[1].name).toBe("PostSeeder");
      expect(results[1].success).toBe(true);
      expect(s1.runCalled).toBe(true);
      expect(s2.runCalled).toBe(true);
    });

    it("should skip already-executed seeders", async () => {
      const em = createMockEntityManager(false);
      const qr = createMockQueryRunner();
      qr.mockSelect([{ name: "UserSeeder" }]);

      const s1 = new UserSeeder();
      const s2 = new PostSeeder();

      const runner = new SeederRunner([s1, s2], em, qr);
      const results = await runner.runAll();

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("PostSeeder");
      expect(s1.runCalled).toBe(false);
      expect(s2.runCalled).toBe(true);
    });

    it("should stop on first error", async () => {
      const em = createMockEntityManager(false);
      const qr = createMockQueryRunner();
      const s1 = new FailingSeeder();
      const s2 = new PostSeeder();

      const runner = new SeederRunner([s1, s2], em, qr);
      const results = await runner.runAll();

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("FailingSeeder");
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain("Seeder failed intentionally");
      expect(s2.runCalled).toBe(false);
    });

    it("should record seeder name after execution", async () => {
      const em = createMockEntityManager(false);
      const qr = createMockQueryRunner();
      const s1 = new UserSeeder();

      const runner = new SeederRunner([s1], em, qr);
      await runner.runAll();

      const insertQuery = qr.queries.find((q) => q.includes("INSERT INTO"));
      expect(insertQuery).toBeDefined();
      expect(insertQuery).toContain("UserSeeder");
    });

    it("should skip tracking when trackExecution is false", async () => {
      const em = createMockEntityManager(false);
      const qr = createMockQueryRunner();
      const s1 = new UserSeeder();

      const runner = new SeederRunner([s1], em, qr, {
        trackExecution: false,
      });
      const results = await runner.runAll();

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      // No CREATE TABLE or INSERT queries
      const createQuery = qr.queries.find((q) =>
        q.includes("CREATE TABLE"),
      );
      expect(createQuery).toBeUndefined();
      const insertQuery = qr.queries.find((q) => q.includes("INSERT INTO"));
      expect(insertQuery).toBeUndefined();
    });
  });

  describe("runOne()", () => {
    it("should run a single seeder and track it", async () => {
      const em = createMockEntityManager(false);
      const qr = createMockQueryRunner();
      const s1 = new UserSeeder();

      const runner = new SeederRunner([s1], em, qr);
      const result = await runner.runOne(s1);

      expect(result.name).toBe("UserSeeder");
      expect(result.success).toBe(true);
      expect(result.direction).toBe("run");
      expect(s1.runCalled).toBe(true);
    });
  });

  describe("revertLast()", () => {
    it("should revert the most recent seeder", async () => {
      const em = createMockEntityManager(false);
      const qr = createMockQueryRunner();
      qr.mockSelect([
        { name: "UserSeeder" },
        { name: "PostSeeder" },
      ]);

      const s1 = new UserSeeder();
      const s2 = new PostSeeder();

      const runner = new SeederRunner([s1, s2], em, qr);
      const result = await runner.revertLast();

      expect(result).not.toBeNull();
      expect(result!.name).toBe("PostSeeder");
      expect(result!.direction).toBe("revert");
      expect(result!.success).toBe(true);
    });

    it("should return null when no seeders have been executed", async () => {
      const em = createMockEntityManager(false);
      const qr = createMockQueryRunner();

      const runner = new SeederRunner([], em, qr);
      const result = await runner.revertLast();

      expect(result).toBeNull();
    });

    it("should return error if seeder not found in registered list", async () => {
      const em = createMockEntityManager(false);
      const qr = createMockQueryRunner();
      qr.mockSelect([{ name: "UnknownSeeder" }]);

      const runner = new SeederRunner([], em, qr);
      const result = await runner.revertLast();

      expect(result).not.toBeNull();
      expect(result!.success).toBe(false);
      expect(result!.error).toContain("not found");
    });

    it("should return error if seeder has no revert() method", async () => {
      const em = createMockEntityManager(false);
      const qr = createMockQueryRunner();
      qr.mockSelect([{ name: "NoRevertSeeder" }]);

      const s1 = new NoRevertSeeder();
      const runner = new SeederRunner([s1], em, qr);
      const result = await runner.revertLast();

      expect(result).not.toBeNull();
      expect(result!.success).toBe(false);
      expect(result!.error).toContain("does not implement revert()");
    });

    it("should remove seed record after successful revert", async () => {
      const em = createMockEntityManager(false);
      const qr = createMockQueryRunner();
      qr.mockSelect([{ name: "UserSeeder" }]);

      const s1 = new UserSeeder();
      const runner = new SeederRunner([s1], em, qr);
      await runner.revertLast();

      const deleteQuery = qr.queries.find((q) => q.includes("DELETE FROM"));
      expect(deleteQuery).toBeDefined();
      expect(deleteQuery).toContain("UserSeeder");
    });
  });

  describe("status()", () => {
    it("should return executed and pending lists", async () => {
      const em = createMockEntityManager(false);
      const qr = createMockQueryRunner();
      qr.mockSelect([{ name: "UserSeeder" }]);

      const s1 = new UserSeeder();
      const s2 = new PostSeeder();

      const runner = new SeederRunner([s1, s2], em, qr);
      const result = await runner.status();

      expect(result.executed).toEqual(["UserSeeder"]);
      expect(result.pending).toEqual(["PostSeeder"]);
    });

    it("should return all pending when none executed", async () => {
      const em = createMockEntityManager(false);
      const qr = createMockQueryRunner();

      const s1 = new UserSeeder();
      const s2 = new PostSeeder();

      const runner = new SeederRunner([s1, s2], em, qr);
      const result = await runner.status();

      expect(result.executed).toEqual([]);
      expect(result.pending).toEqual(["UserSeeder", "PostSeeder"]);
    });

    it("should return empty pending when all executed", async () => {
      const em = createMockEntityManager(false);
      const qr = createMockQueryRunner();
      qr.mockSelect([
        { name: "UserSeeder" },
        { name: "PostSeeder" },
      ]);

      const s1 = new UserSeeder();
      const s2 = new PostSeeder();

      const runner = new SeederRunner([s1, s2], em, qr);
      const result = await runner.status();

      expect(result.executed).toEqual(["UserSeeder", "PostSeeder"]);
      expect(result.pending).toEqual([]);
    });
  });

  describe("Seeder base class", () => {
    it("should use class name as default seeder name", () => {
      const seeder = new UserSeeder();
      expect(seeder.name).toBe("UserSeeder");
    });
  });
});
