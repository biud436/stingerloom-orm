/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  MigrationCli,
  MigrationCommand,
  Migration,
  MigrationContext,
  PostgresMigrationRunner,
  MigrationResult,
} from "../../src/migration";

// ─── MigrationRunner mock ────────────────────────────────────

jest.mock("../../src/migration/PostgresMigrationRunner");

const MockMigrationRunner = PostgresMigrationRunner as jest.MockedClass<
  typeof PostgresMigrationRunner
>;

// ─── DatabaseClient mock ─────────────────────────────────────

const mockQuery = jest.fn();
const mockConnect = jest.fn().mockResolvedValue({
  query: mockQuery,
});
const mockClose = jest.fn();

jest.mock("../../src/DatabaseClient", () => ({
  DatabaseClient: {
    getInstance: () => ({
      connect: mockConnect,
      close: mockClose,
      type: "postgres",
    }),
  },
}));

// ─── Test migrations ─────────────────────────────────────────

class CreateUsersTable extends Migration {
  async up(ctx: MigrationContext): Promise<void> {
    await ctx.query('CREATE TABLE "users" ("id" SERIAL PRIMARY KEY)');
  }
  async down(ctx: MigrationContext): Promise<void> {
    await ctx.query('DROP TABLE "users"');
  }
}

class AddEmailToUsers extends Migration {
  async up(ctx: MigrationContext): Promise<void> {
    await ctx.query('ALTER TABLE "users" ADD COLUMN "email" VARCHAR(255)');
  }
  async down(ctx: MigrationContext): Promise<void> {
    await ctx.query('ALTER TABLE "users" DROP COLUMN "email"');
  }
}

const defaultOptions: any = {
  type: "postgres",
  host: "localhost",
  port: 5432,
  username: "test",
  password: "test",
  database: "testdb",
  entities: [],
};

// ─── Tests ───────────────────────────────────────────────────

describe("MigrationCli", () => {
  let cli: MigrationCli;
  let mockRunnerInstance: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Set up mock runner instance methods
    mockRunnerInstance = {
      run: jest.fn().mockResolvedValue([]),
      rollback: jest.fn().mockResolvedValue([]),
      status: jest.fn().mockResolvedValue({ executed: [], pending: [] }),
    };

    MockMigrationRunner.mockImplementation(() => mockRunnerInstance);

    cli = new MigrationCli(
      [new CreateUsersTable(), new AddEmailToUsers()],
      defaultOptions,
    );
  });

  describe("connect()", () => {
    it("DB에 연결하고 MigrationRunner를 초기화해야 함", async () => {
      await cli.connect();

      expect(mockConnect).toHaveBeenCalledWith(defaultOptions);
      expect(MockMigrationRunner).toHaveBeenCalledTimes(1);
    });
  });

  describe("execute() - 연결 전 호출", () => {
    it("connect() 없이 execute()를 호출하면 에러를 던져야 함", async () => {
      await expect(cli.execute("migrate:run")).rejects.toThrow(
        "Not connected",
      );
    });

    it("connect() 없이 migrateRun()을 호출하면 에러를 던져야 함", async () => {
      await expect(cli.migrateRun()).rejects.toThrow("Not connected");
    });

    it("connect() 없이 migrateRollback()을 호출하면 에러를 던져야 함", async () => {
      await expect(cli.migrateRollback()).rejects.toThrow("Not connected");
    });

    it("connect() 없이 migrateStatus()를 호출하면 에러를 던져야 함", async () => {
      await expect(cli.migrateStatus()).rejects.toThrow("Not connected");
    });
  });

  describe("execute('migrate:run')", () => {
    it("MigrationRunner.run()을 호출해야 함", async () => {
      const runResults: MigrationResult[] = [
        { name: "CreateUsersTable", direction: "up", success: true },
        { name: "AddEmailToUsers", direction: "up", success: true },
      ];
      mockRunnerInstance.run.mockResolvedValue(runResults);

      await cli.connect();
      const results = await cli.execute("migrate:run");

      expect(mockRunnerInstance.run).toHaveBeenCalledTimes(1);
      expect(results).toEqual(runResults);
    });

    it("pending 마이그레이션이 없으면 빈 배열을 반환해야 함", async () => {
      mockRunnerInstance.run.mockResolvedValue([]);

      await cli.connect();
      const results = await cli.execute("migrate:run");

      expect(results).toEqual([]);
    });
  });

  describe("execute('migrate:rollback')", () => {
    it("MigrationRunner.rollback(1)을 호출해야 함", async () => {
      const rollbackResults: MigrationResult[] = [
        { name: "AddEmailToUsers", direction: "down", success: true },
      ];
      mockRunnerInstance.rollback.mockResolvedValue(rollbackResults);

      await cli.connect();
      const results = await cli.execute("migrate:rollback");

      expect(mockRunnerInstance.rollback).toHaveBeenCalledWith(1);
      expect(results).toEqual(rollbackResults);
    });

    it("rollback할 마이그레이션이 없으면 빈 배열을 반환해야 함", async () => {
      mockRunnerInstance.rollback.mockResolvedValue([]);

      await cli.connect();
      const results = await cli.execute("migrate:rollback");

      expect(results).toEqual([]);
    });

    it("rollback 실패 시 에러 결과를 반환해야 함", async () => {
      const failResult: MigrationResult[] = [
        {
          name: "AddEmailToUsers",
          direction: "down",
          success: false,
          error: "Cannot revert",
        },
      ];
      mockRunnerInstance.rollback.mockResolvedValue(failResult);

      await cli.connect();
      const results = await cli.execute("migrate:rollback");

      expect(results).toEqual(failResult);
      expect((results as MigrationResult[])[0].success).toBe(false);
    });
  });

  describe("execute('migrate:status')", () => {
    it("MigrationRunner.status()를 호출해야 함", async () => {
      const statusResult = {
        executed: ["CreateUsersTable"],
        pending: ["AddEmailToUsers"],
      };
      mockRunnerInstance.status.mockResolvedValue(statusResult);

      await cli.connect();
      const result = await cli.execute("migrate:status");

      expect(mockRunnerInstance.status).toHaveBeenCalledTimes(1);
      expect(result).toEqual(statusResult);
    });

    it("모든 마이그레이션이 실행된 경우 pending이 비어있어야 함", async () => {
      const statusResult = {
        executed: ["CreateUsersTable", "AddEmailToUsers"],
        pending: [],
      };
      mockRunnerInstance.status.mockResolvedValue(statusResult);

      await cli.connect();
      const result = await cli.execute("migrate:status");

      expect((result as any).pending).toEqual([]);
    });
  });

  describe("execute() - 알 수 없는 명령어", () => {
    it("알 수 없는 명령어로 호출하면 에러를 던져야 함", async () => {
      await cli.connect();

      await expect(
        cli.execute("migrate:unknown" as MigrationCommand),
      ).rejects.toThrow("Unknown command");
    });
  });

  describe("close()", () => {
    it("DatabaseClient.close()를 호출해야 함", async () => {
      await cli.connect();
      await cli.close();

      expect(mockClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("migrateRun() 직접 호출", () => {
    it("MigrationRunner.run()을 호출하고 결과를 반환해야 함", async () => {
      const runResults: MigrationResult[] = [
        { name: "CreateUsersTable", direction: "up", success: true },
      ];
      mockRunnerInstance.run.mockResolvedValue(runResults);

      await cli.connect();
      const results = await cli.migrateRun();

      expect(mockRunnerInstance.run).toHaveBeenCalledTimes(1);
      expect(results).toEqual(runResults);
    });
  });

  describe("migrateRollback() 직접 호출", () => {
    it("MigrationRunner.rollback(1)을 호출하고 결과를 반환해야 함", async () => {
      const rollbackResults: MigrationResult[] = [
        { name: "CreateUsersTable", direction: "down", success: true },
      ];
      mockRunnerInstance.rollback.mockResolvedValue(rollbackResults);

      await cli.connect();
      const results = await cli.migrateRollback();

      expect(mockRunnerInstance.rollback).toHaveBeenCalledWith(1);
      expect(results).toEqual(rollbackResults);
    });
  });

  describe("migrateStatus() 직접 호출", () => {
    it("MigrationRunner.status()를 호출하고 결과를 반환해야 함", async () => {
      const statusResult = {
        executed: [],
        pending: ["CreateUsersTable", "AddEmailToUsers"],
      };
      mockRunnerInstance.status.mockResolvedValue(statusResult);

      await cli.connect();
      const result = await cli.migrateStatus();

      expect(mockRunnerInstance.status).toHaveBeenCalledTimes(1);
      expect(result).toEqual(statusResult);
    });
  });
});
