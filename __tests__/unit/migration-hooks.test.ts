/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  MigrationRunner,
  MigrationHooks,
  MigrationResult,
} from "../../src/migration/MigrationRunner";
import { Migration, MigrationContext } from "../../src/migration/Migration";

// Concrete implementation for testing
class TestMigrationRunner extends MigrationRunner {
  protected wrapIdentifier(name: string): string {
    return `"${name}"`;
  }
  protected autoIncrementPkDefinition(): string {
    return "INTEGER PRIMARY KEY AUTOINCREMENT";
  }
}

// Mock driver
const mockDriver = {
  acquireAdvisoryLock: jest.fn().mockResolvedValue(true),
  releaseAdvisoryLock: jest.fn().mockResolvedValue(undefined),
} as any;

// Mock query runner
function createMockQueryRunner() {
  const executed: string[] = [];
  return {
    query: jest.fn(async (sql: string) => {
      executed.push(sql);
      // Return empty array for SELECT queries
      if (sql.startsWith("SELECT")) return [];
      return {};
    }),
    executed,
  };
}

// Test migration
class TestMigration extends Migration {
  get name() { return "test_001"; }
  async up(ctx: MigrationContext) {
    await ctx.query("CREATE TABLE test (id INT)");
  }
  async down(ctx: MigrationContext) {
    await ctx.query("DROP TABLE test");
  }
}

class FailingMigration extends Migration {
  get name() { return "fail_001"; }
  async up() {
    throw new Error("migration failed");
  }
  async down() {}
}

describe("MigrationRunner lifecycle hooks (#232)", () => {
  it("should call beforeAll and afterAll hooks", async () => {
    const hooks: MigrationHooks = {
      beforeAll: jest.fn(),
      afterAll: jest.fn(),
    };

    const qr = createMockQueryRunner();
    const runner = new TestMigrationRunner(
      [new TestMigration()],
      mockDriver,
      qr,
      { hooks },
    );

    await runner.runAll();

    expect(hooks.beforeAll).toHaveBeenCalledTimes(1);
    expect(hooks.afterAll).toHaveBeenCalledTimes(1);
    // afterAll receives results array
    const afterAllArgs = (hooks.afterAll as jest.Mock).mock.calls[0];
    expect(afterAllArgs[1]).toBeInstanceOf(Array);
  });

  it("should call beforeEach and afterEach hooks for each migration", async () => {
    const hooks: MigrationHooks = {
      beforeEach: jest.fn(),
      afterEach: jest.fn(),
    };

    const qr = createMockQueryRunner();
    const runner = new TestMigrationRunner(
      [new TestMigration()],
      mockDriver,
      qr,
      { hooks },
    );

    await runner.runAll();

    expect(hooks.beforeEach).toHaveBeenCalledTimes(1);
    expect(hooks.afterEach).toHaveBeenCalledTimes(1);

    // afterEach receives migration, context, and duration
    const afterArgs = (hooks.afterEach as jest.Mock).mock.calls[0];
    expect(afterArgs[0]).toBeInstanceOf(TestMigration);
    expect(typeof afterArgs[2]).toBe("number"); // durationMs
  });

  it("should call onError hook when migration fails", async () => {
    const hooks: MigrationHooks = {
      onError: jest.fn(),
    };

    const qr = createMockQueryRunner();
    const runner = new TestMigrationRunner(
      [new FailingMigration()],
      mockDriver,
      qr,
      { hooks },
    );

    const results = await runner.runAll();

    expect(hooks.onError).toHaveBeenCalledTimes(1);
    const errorArgs = (hooks.onError as jest.Mock).mock.calls[0];
    expect(errorArgs[0]).toBeInstanceOf(FailingMigration);
    expect(errorArgs[1]).toBeInstanceOf(Error);
    expect(results[0].success).toBe(false);
  });

  it("should support custom table name", async () => {
    const qr = createMockQueryRunner();
    const runner = new TestMigrationRunner(
      [new TestMigration()],
      mockDriver,
      qr,
      { tableName: "custom_migrations" },
    );

    await runner.runAll();

    const createTableSql = qr.executed.find((s) =>
      s.includes("custom_migrations"),
    );
    expect(createTableSql).toBeDefined();
  });

  it("should call hooks during runDown", async () => {
    const hooks: MigrationHooks = {
      beforeEach: jest.fn(),
      afterEach: jest.fn(),
    };

    const qr = createMockQueryRunner();
    const runner = new TestMigrationRunner(
      [new TestMigration()],
      mockDriver,
      qr,
      { hooks },
    );

    await runner.runDown(new TestMigration());

    expect(hooks.beforeEach).toHaveBeenCalledTimes(1);
    expect(hooks.afterEach).toHaveBeenCalledTimes(1);
  });
});
