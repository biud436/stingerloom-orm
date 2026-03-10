/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { ISqlDriver } from "../../src/dialects/SqlDriver";
import {
  Migration,
  MigrationContext,
  MigrationRunner,
  MigrationQueryRunner,
} from "../../src/migration";
import { AdvisoryLockError } from "../../src/errors/AdvisoryLockError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";

// ─── Mock helpers ────────────────────────────────────────────

function createMockDriver(isMySql: boolean, lockBehavior?: {
  acquireResult?: boolean;
  acquireThrow?: Error;
}): ISqlDriver {
  return {
    isMySqlFamily: () => isMySql,
    hasTable: jest.fn(),
    addPrimaryKey: jest.fn(),
    addAutoIncrement: jest.fn(),
    dropPrimaryKey: jest.fn(),
    addUniqueKey: jest.fn(),
    dropUniqueKey: jest.fn(),
    addColumn: jest.fn(),
    dropColumn: jest.fn(),
    addForeignKey: jest.fn(),
    generateForeignKeyName: jest.fn(),
    dropForeignKey: jest.fn(),
    addIndex: jest.fn(),
    hasIndex: jest.fn(),
    dropIndex: jest.fn(),
    getSchemas: jest.fn(),
    getIndexes: jest.fn(),
    getForeignKeys: jest.fn(),
    getPrimaryKeys: jest.fn(),
    createTable: jest.fn(),
    getColumnType: jest.fn(),
    castType: jest.fn(),
    getForUpdateNoWait: jest.fn().mockReturnValue("FOR UPDATE NOWAIT"),
    acquireAdvisoryLock: lockBehavior?.acquireThrow
      ? jest.fn().mockRejectedValue(lockBehavior.acquireThrow)
      : jest.fn().mockResolvedValue(lockBehavior?.acquireResult ?? true),
    releaseAdvisoryLock: jest.fn().mockResolvedValue(undefined),
    createSavepointSql: jest.fn().mockReturnValue("SAVEPOINT sp"),
    rollbackToSavepointSql: jest.fn().mockReturnValue("ROLLBACK TO SAVEPOINT sp"),
    releaseSavepointSql: jest.fn().mockReturnValue("RELEASE SAVEPOINT sp"),
    hasForeignKey: jest.fn(),
    hasColumn: jest.fn(),
    setQueryTimeout: jest.fn(),
    supportsExplain: jest.fn(),
    buildExplainSql: jest.fn(),
    buildUpsertSql: jest.fn(),
    addCompositeUniqueIndex: jest.fn(),
    executeRaw: jest.fn(),
  } as unknown as ISqlDriver;
}

function createMockQueryRunner(): MigrationQueryRunner & {
  queries: string[];
} {
  const queries: string[] = [];
  return {
    queries,
    query: jest.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes("SELECT")) {
        return { results: [] };
      }
      return { results: [] };
    }),
  };
}

class TestMigration extends Migration {
  async up(ctx: MigrationContext): Promise<void> {
    await ctx.query('CREATE TABLE "test" ("id" SERIAL PRIMARY KEY)');
  }
  async down(ctx: MigrationContext): Promise<void> {
    await ctx.query('DROP TABLE "test"');
  }
}

// ─── Tests ───────────────────────────────────────────────────

describe("Advisory Lock", () => {
  describe("MigrationRunner with advisory lock", () => {
    it("should acquire and release advisory lock during runAll()", async () => {
      const driver = createMockDriver(false);
      const qr = createMockQueryRunner();
      const m = new TestMigration();
      const runner = new MigrationRunner([m], driver, qr);

      await runner.runAll();

      expect(driver.acquireAdvisoryLock).toHaveBeenCalledTimes(1);
      expect(driver.acquireAdvisoryLock).toHaveBeenCalledWith(
        "stingerloom_migration_lock",
        10000,
      );
      expect(driver.releaseAdvisoryLock).toHaveBeenCalledTimes(1);
      expect(driver.releaseAdvisoryLock).toHaveBeenCalledWith(
        "stingerloom_migration_lock",
      );
    });

    it("should throw AdvisoryLockError when lock acquisition fails", async () => {
      const driver = createMockDriver(false, { acquireResult: false });
      const qr = createMockQueryRunner();
      const m = new TestMigration();
      const runner = new MigrationRunner([m], driver, qr);

      await expect(runner.runAll()).rejects.toThrow(AdvisoryLockError);
      await expect(runner.runAll()).rejects.toThrow(
        /Failed to acquire migration lock/,
      );
    });

    it("should release lock even if migration fails", async () => {
      const driver = createMockDriver(false);
      const qr = createMockQueryRunner();

      class FailingMigration extends Migration {
        async up(): Promise<void> {
          throw new Error("migration failed");
        }
        async down(): Promise<void> {}
      }

      const m = new FailingMigration();
      const runner = new MigrationRunner([m], driver, qr);

      // runAll catches migration errors and returns results, doesn't throw
      const results = await runner.runAll();
      expect(results[0].success).toBe(false);

      // Lock should still be released
      expect(driver.releaseAdvisoryLock).toHaveBeenCalledTimes(1);
    });

    it("should use custom lockId from options", async () => {
      const driver = createMockDriver(false);
      const qr = createMockQueryRunner();
      const m = new TestMigration();
      const runner = new MigrationRunner([m], driver, qr, {
        lockId: "custom_lock",
      });

      await runner.runAll();

      expect(driver.acquireAdvisoryLock).toHaveBeenCalledWith(
        "custom_lock",
        10000,
      );
      expect(driver.releaseAdvisoryLock).toHaveBeenCalledWith("custom_lock");
    });

    it("should use custom lockTimeoutMs from options", async () => {
      const driver = createMockDriver(false);
      const qr = createMockQueryRunner();
      const m = new TestMigration();
      const runner = new MigrationRunner([m], driver, qr, {
        lockTimeoutMs: 30000,
      });

      await runner.runAll();

      expect(driver.acquireAdvisoryLock).toHaveBeenCalledWith(
        "stingerloom_migration_lock",
        30000,
      );
    });

    it("should acquire lock via run() which calls runAll()", async () => {
      const driver = createMockDriver(false);
      const qr = createMockQueryRunner();
      const m = new TestMigration();
      const runner = new MigrationRunner([m], driver, qr);

      await runner.run();

      expect(driver.acquireAdvisoryLock).toHaveBeenCalledTimes(1);
      expect(driver.releaseAdvisoryLock).toHaveBeenCalledTimes(1);
    });
  });

  describe("AdvisoryLockError", () => {
    it("should have correct error code", () => {
      const error = new AdvisoryLockError("test");
      expect(error.code).toBe(OrmErrorCode.ADVISORY_LOCK_FAILED);
      expect(error.name).toBe("AdvisoryLockError");
    });

    it("should be instanceof OrmError", () => {
      const error = new AdvisoryLockError("test");
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe("Driver advisory lock methods", () => {
    it("SQLite acquireAdvisoryLock should always return true (no-op)", async () => {
      // SQLite는 단일 프로세스이므로 항상 true
      const { SqliteDriver } = require("../../src/dialects/sqlite/SqliteDriver");
      const mockConnector = {
        query: jest.fn(),
        getConnection: jest.fn(),
        connect: jest.fn(),
      };
      const driver = new SqliteDriver(mockConnector);

      const result = await driver.acquireAdvisoryLock("test_lock");
      expect(result).toBe(true);
    });

    it("SQLite releaseAdvisoryLock should be a no-op", async () => {
      const { SqliteDriver } = require("../../src/dialects/sqlite/SqliteDriver");
      const mockConnector = {
        query: jest.fn(),
        getConnection: jest.fn(),
        connect: jest.fn(),
      };
      const driver = new SqliteDriver(mockConnector);

      // Should not throw
      await driver.releaseAdvisoryLock("test_lock");
      expect(mockConnector.query).not.toHaveBeenCalled();
    });
  });

  describe("Driver savepoint SQL methods", () => {
    it("MySQL should generate correct savepoint SQL", () => {
      const { MySqlDriver } = require("../../src/dialects/mysql/MySqlDriver");
      const mockConnector = { query: jest.fn() };
      const driver = new MySqlDriver(mockConnector);

      expect(driver.createSavepointSql("sp1")).toBe("SAVEPOINT `sp1`");
      expect(driver.rollbackToSavepointSql("sp1")).toBe("ROLLBACK TO SAVEPOINT `sp1`");
      expect(driver.releaseSavepointSql("sp1")).toBe("RELEASE SAVEPOINT `sp1`");
    });

    it("PostgreSQL should generate correct savepoint SQL", () => {
      const { PostgresDriver } = require("../../src/dialects/postgres/PostgresDriver");
      const mockConnector = { query: jest.fn() };
      const driver = new PostgresDriver(mockConnector);

      expect(driver.createSavepointSql("sp1")).toBe('SAVEPOINT "sp1"');
      expect(driver.rollbackToSavepointSql("sp1")).toBe('ROLLBACK TO SAVEPOINT "sp1"');
      expect(driver.releaseSavepointSql("sp1")).toBe('RELEASE SAVEPOINT "sp1"');
    });

    it("SQLite should generate correct savepoint SQL", () => {
      const { SqliteDriver } = require("../../src/dialects/sqlite/SqliteDriver");
      const mockConnector = { query: jest.fn() };
      const driver = new SqliteDriver(mockConnector);

      expect(driver.createSavepointSql("sp1")).toBe('SAVEPOINT "sp1"');
      expect(driver.rollbackToSavepointSql("sp1")).toBe('ROLLBACK TO SAVEPOINT "sp1"');
      expect(driver.releaseSavepointSql("sp1")).toBe('RELEASE SAVEPOINT "sp1"');
    });

    it("savepoint name with special characters should be rejected", () => {
      const { MySqlDriver } = require("../../src/dialects/mysql/MySqlDriver");
      const { OrmError } = require("../../src/errors/OrmError");
      const mockConnector = { query: jest.fn() };
      const driver = new MySqlDriver(mockConnector);

      // Backtick in name should be rejected (SQL injection prevention)
      expect(() => driver.createSavepointSql("sp`1")).toThrow(OrmError);
    });
  });
});
