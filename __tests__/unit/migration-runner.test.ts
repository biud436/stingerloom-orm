/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  Migration,
  MigrationContext,
  MigrationQueryRunner,
  MySqlMigrationRunner,
  PostgresMigrationRunner,
  SqliteMigrationRunner,
} from "../../src/migration";
import { MigrationRunner } from "../../src/migration/MigrationRunner";
import { ISqlDriver } from "../../src/dialects/SqlDriver";

// ─── Mock helpers ────────────────────────────────────────────

function createMockDriver(): ISqlDriver {
  return {
    isMySqlFamily: jest.fn().mockReturnValue(false),
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
    acquireAdvisoryLock: jest.fn().mockResolvedValue(true),
    releaseAdvisoryLock: jest.fn().mockResolvedValue(undefined),
    createSavepointSql: jest.fn().mockReturnValue("SAVEPOINT sp"),
    rollbackToSavepointSql: jest.fn().mockReturnValue("ROLLBACK TO SAVEPOINT sp"),
    releaseSavepointSql: jest.fn().mockReturnValue("RELEASE SAVEPOINT sp"),
  } as unknown as ISqlDriver;
}

function createMockQueryRunner(): MigrationQueryRunner & {
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

// ─── Test migrations ─────────────────────────────────────────

class CreateUsersTable extends Migration {
  async up(ctx: MigrationContext): Promise<void> {
    await ctx.query(
      'CREATE TABLE "users" ("id" SERIAL PRIMARY KEY, "name" VARCHAR(255))',
    );
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

class CreatePostsTable extends Migration {
  async up(ctx: MigrationContext): Promise<void> {
    await ctx.query(
      'CREATE TABLE "posts" ("id" SERIAL PRIMARY KEY, "title" VARCHAR(255))',
    );
  }
  async down(ctx: MigrationContext): Promise<void> {
    await ctx.query('DROP TABLE "posts"');
  }
}

// ─── Tests ───────────────────────────────────────────────────

describe("MigrationRunner", () => {
  describe("run()", () => {
    it("미실행 마이그레이션을 순서대로 실행해야 함", async () => {
      const driver = createMockDriver();
      const qr = createMockQueryRunner();
      const m1 = new CreateUsersTable();
      const m2 = new AddEmailToUsers();

      const runner = new PostgresMigrationRunner([m1, m2], driver, qr);
      const results = await runner.run();

      expect(results).toHaveLength(2);
      expect(results[0].name).toBe("CreateUsersTable");
      expect(results[0].success).toBe(true);
      expect(results[1].name).toBe("AddEmailToUsers");
      expect(results[1].success).toBe(true);
    });

    it("이미 실행된 마이그레이션은 스킵해야 함", async () => {
      const driver = createMockDriver();
      const qr = createMockQueryRunner();
      qr.mockSelect([{ name: "CreateUsersTable" }]);

      const m1 = new CreateUsersTable();
      const m2 = new AddEmailToUsers();
      const runner = new PostgresMigrationRunner([m1, m2], driver, qr);

      const results = await runner.run();

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("AddEmailToUsers");
    });

    it("외부 마이그레이션 목록을 전달하여 실행할 수 있어야 함", async () => {
      const driver = createMockDriver();
      const qr = createMockQueryRunner();
      const m1 = new CreateUsersTable();
      const m2 = new AddEmailToUsers();
      const m3 = new CreatePostsTable();

      // 생성자에는 m1만 전달하지만, run()에 [m1, m2, m3]을 전달
      const runner = new PostgresMigrationRunner([m1], driver, qr);
      const results = await runner.run([m1, m2, m3]);

      expect(results).toHaveLength(3);
      expect(results[2].name).toBe("CreatePostsTable");
    });
  });

  describe("rollback(n?)", () => {
    it("기본값으로 최근 1개 마이그레이션을 되돌려야 함", async () => {
      const driver = createMockDriver();
      const qr = createMockQueryRunner();
      qr.mockSelect([
        { name: "CreateUsersTable" },
        { name: "AddEmailToUsers" },
      ]);

      const m1 = new CreateUsersTable();
      const m2 = new AddEmailToUsers();
      const runner = new PostgresMigrationRunner([m1, m2], driver, qr);

      const results = await runner.rollback();

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("AddEmailToUsers");
      expect(results[0].direction).toBe("down");
      expect(results[0].success).toBe(true);
    });

    it("최근 n개 마이그레이션을 되돌려야 함", async () => {
      const driver = createMockDriver();
      const qr = createMockQueryRunner();
      qr.mockSelect([
        { name: "CreateUsersTable" },
        { name: "AddEmailToUsers" },
        { name: "CreatePostsTable" },
      ]);

      const m1 = new CreateUsersTable();
      const m2 = new AddEmailToUsers();
      const m3 = new CreatePostsTable();
      const runner = new PostgresMigrationRunner([m1, m2, m3], driver, qr);

      const results = await runner.rollback(2);

      expect(results).toHaveLength(2);
      expect(results[0].name).toBe("CreatePostsTable");
      expect(results[1].name).toBe("AddEmailToUsers");
    });

    it("실행된 마이그레이션이 없으면 빈 배열을 반환해야 함", async () => {
      const driver = createMockDriver();
      const qr = createMockQueryRunner();

      const runner = new PostgresMigrationRunner([], driver, qr);
      const results = await runner.rollback();

      expect(results).toHaveLength(0);
    });

    it("등록되지 않은 마이그레이션을 rollback하면 에러 결과를 반환해야 함", async () => {
      const driver = createMockDriver();
      const qr = createMockQueryRunner();
      qr.mockSelect([{ name: "UnknownMigration" }]);

      const runner = new PostgresMigrationRunner([], driver, qr);
      const results = await runner.rollback();

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain("not found");
    });
  });

  describe("status()", () => {
    it("실행됨/미실행 목록을 반환해야 함", async () => {
      const driver = createMockDriver();
      const qr = createMockQueryRunner();
      qr.mockSelect([{ name: "CreateUsersTable" }]);

      const m1 = new CreateUsersTable();
      const m2 = new AddEmailToUsers();
      const m3 = new CreatePostsTable();
      const runner = new PostgresMigrationRunner([m1, m2, m3], driver, qr);

      const result = await runner.status();

      expect(result.executed).toEqual(["CreateUsersTable"]);
      expect(result.pending).toEqual(["AddEmailToUsers", "CreatePostsTable"]);
    });

    it("모두 실행된 경우 pending이 비어있어야 함", async () => {
      const driver = createMockDriver();
      const qr = createMockQueryRunner();
      qr.mockSelect([
        { name: "CreateUsersTable" },
        { name: "AddEmailToUsers" },
      ]);

      const m1 = new CreateUsersTable();
      const m2 = new AddEmailToUsers();
      const runner = new PostgresMigrationRunner([m1, m2], driver, qr);

      const result = await runner.status();

      expect(result.executed).toEqual([
        "CreateUsersTable",
        "AddEmailToUsers",
      ]);
      expect(result.pending).toEqual([]);
    });

    it("아무것도 실행되지 않은 경우 executed가 비어있어야 함", async () => {
      const driver = createMockDriver();
      const qr = createMockQueryRunner();

      const m1 = new CreateUsersTable();
      const runner = new PostgresMigrationRunner([m1], driver, qr);

      const result = await runner.status();

      expect(result.executed).toEqual([]);
      expect(result.pending).toEqual(["CreateUsersTable"]);
    });
  });

  describe("__migrations 테이블", () => {
    it("MySQL 구문으로 생성해야 함", async () => {
      const driver = createMockDriver();
      const qr = createMockQueryRunner();
      const runner = new MySqlMigrationRunner([], driver, qr);

      await runner.ensureMigrationTable();

      expect(qr.queries[0]).toContain("`__migrations`");
      expect(qr.queries[0]).toContain("AUTO_INCREMENT");
    });

    it("PostgreSQL 구문으로 생성해야 함", async () => {
      const driver = createMockDriver();
      const qr = createMockQueryRunner();
      const runner = new PostgresMigrationRunner([], driver, qr);

      await runner.ensureMigrationTable();

      expect(qr.queries[0]).toContain('"__migrations"');
      expect(qr.queries[0]).toContain("SERIAL PRIMARY KEY");
    });

    it("SQLite 구문으로 생성해야 함", async () => {
      const driver = createMockDriver();
      const qr = createMockQueryRunner();
      const runner = new SqliteMigrationRunner([], driver, qr);

      await runner.ensureMigrationTable();

      expect(qr.queries[0]).toContain('"__migrations"');
      expect(qr.queries[0]).toContain("INTEGER PRIMARY KEY AUTOINCREMENT");
    });

    it("마이그레이션 실행 후 INSERT 기록이 남아야 함", async () => {
      const driver = createMockDriver();
      const qr = createMockQueryRunner();
      const m1 = new CreateUsersTable();
      const runner = new PostgresMigrationRunner([m1], driver, qr);

      await runner.run();

      const insertQuery = qr.queries.find((q) => q.includes("INSERT INTO"));
      expect(insertQuery).toBeDefined();
      expect(insertQuery).toContain("CreateUsersTable");
    });

    it("rollback 후 DELETE 기록이 남아야 함", async () => {
      const driver = createMockDriver();
      const qr = createMockQueryRunner();
      qr.mockSelect([{ name: "CreateUsersTable" }]);

      const m1 = new CreateUsersTable();
      const runner = new PostgresMigrationRunner([m1], driver, qr);

      await runner.rollback();

      const deleteQuery = qr.queries.find((q) => q.includes("DELETE FROM"));
      expect(deleteQuery).toBeDefined();
      expect(deleteQuery).toContain("CreateUsersTable");
    });
  });

  describe("dialect별 서브클래스", () => {
    it("MySqlMigrationRunner는 MigrationRunner의 인스턴스여야 함", () => {
      const driver = createMockDriver();
      const qr = createMockQueryRunner();
      const runner = new MySqlMigrationRunner([], driver, qr);
      expect(runner).toBeInstanceOf(MigrationRunner);
    });

    it("PostgresMigrationRunner는 MigrationRunner의 인스턴스여야 함", () => {
      const driver = createMockDriver();
      const qr = createMockQueryRunner();
      const runner = new PostgresMigrationRunner([], driver, qr);
      expect(runner).toBeInstanceOf(MigrationRunner);
    });

    it("SqliteMigrationRunner는 MigrationRunner의 인스턴스여야 함", () => {
      const driver = createMockDriver();
      const qr = createMockQueryRunner();
      const runner = new SqliteMigrationRunner([], driver, qr);
      expect(runner).toBeInstanceOf(MigrationRunner);
    });

    it("MySQL은 백틱, PostgreSQL은 큰따옴표 식별자를 사용해야 함", async () => {
      const driver = createMockDriver();
      const mysqlQr = createMockQueryRunner();
      const pgQr = createMockQueryRunner();

      const mysqlRunner = new MySqlMigrationRunner([], driver, mysqlQr);
      const pgRunner = new PostgresMigrationRunner([], driver, pgQr);

      await mysqlRunner.ensureMigrationTable();
      await pgRunner.ensureMigrationTable();

      // MySQL uses backticks
      expect(mysqlQr.queries[0]).toMatch(/`__migrations`/);
      expect(mysqlQr.queries[0]).not.toMatch(/"__migrations"/);

      // PostgreSQL uses double quotes
      expect(pgQr.queries[0]).toMatch(/"__migrations"/);
      expect(pgQr.queries[0]).not.toMatch(/`__migrations`/);
    });
  });
});
