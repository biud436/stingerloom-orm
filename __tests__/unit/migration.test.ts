/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  Migration,
  MigrationContext,
  MigrationRunner,
  MigrationQueryRunner,
} from "../../src/migration";
import { ISqlDriver } from "../../src/dialects/SqlDriver";

// ─── Mock helpers ────────────────────────────────────────────

function createMockDriver(isMySql: boolean): ISqlDriver {
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
  } as unknown as ISqlDriver;
}

function createMockQueryRunner(): MigrationQueryRunner & {
  queries: string[];
  setResult: (result: any) => void;
} {
  let nextResult: any = { results: [] };
  const queries: string[] = [];
  return {
    queries,
    setResult: (result: any) => {
      nextResult = result;
    },
    query: jest.fn(async (sql: string) => {
      queries.push(sql);
      return nextResult;
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
      'CREATE TABLE "posts" ("id" SERIAL PRIMARY KEY, "title" VARCHAR(255), "user_id" INT)',
    );
  }
  async down(ctx: MigrationContext): Promise<void> {
    await ctx.query('DROP TABLE "posts"');
  }
}

class FailingMigration extends Migration {
  async up(): Promise<void> {
    throw new Error("Migration intentionally failed");
  }
  async down(): Promise<void> {
    // no-op
  }
}

// ─── Tests ───────────────────────────────────────────────────

describe("Migration System", () => {
  describe("Migration 추상 클래스", () => {
    it("name은 기본적으로 클래스명을 반환해야 함", () => {
      const migration = new CreateUsersTable();
      expect(migration.name).toBe("CreateUsersTable");
    });

    it("up과 down 메서드가 존재해야 함", () => {
      const migration = new CreateUsersTable();
      expect(typeof migration.up).toBe("function");
      expect(typeof migration.down).toBe("function");
    });
  });

  describe("MigrationRunner - PostgreSQL", () => {
    let driver: ISqlDriver;
    let queryRunner: ReturnType<typeof createMockQueryRunner>;
    let runner: MigrationRunner;

    beforeEach(() => {
      driver = createMockDriver(false);
      queryRunner = createMockQueryRunner();
    });

    it("__migrations 테이블을 PostgreSQL 구문으로 생성해야 함", async () => {
      runner = new MigrationRunner([], driver, queryRunner);
      await runner.ensureMigrationTable();

      expect(queryRunner.queries.length).toBe(1);
      expect(queryRunner.queries[0]).toContain("CREATE TABLE IF NOT EXISTS");
      expect(queryRunner.queries[0]).toContain('"__migrations"');
      expect(queryRunner.queries[0]).toContain("SERIAL PRIMARY KEY");
    });

    it("미실행 마이그레이션을 순서대로 실행해야 함", async () => {
      const m1 = new CreateUsersTable();
      const m2 = new AddEmailToUsers();

      runner = new MigrationRunner([m1, m2], driver, queryRunner);

      const results = await runner.runAll();

      expect(results).toHaveLength(2);
      expect(results[0].name).toBe("CreateUsersTable");
      expect(results[0].direction).toBe("up");
      expect(results[0].success).toBe(true);
      expect(results[1].name).toBe("AddEmailToUsers");
      expect(results[1].direction).toBe("up");
      expect(results[1].success).toBe(true);
    });

    it("이미 실행된 마이그레이션은 건너뛰어야 함", async () => {
      const m1 = new CreateUsersTable();
      const m2 = new AddEmailToUsers();

      queryRunner = createMockQueryRunner();

      // getExecutedMigrations 호출 시 이미 실행된 마이그레이션 반환
      let callCount = 0;
      (queryRunner.query as jest.Mock).mockImplementation(
        async (sql: string) => {
          queryRunner.queries.push(sql);
          callCount++;
          // 첫 번째 호출: CREATE TABLE (ensureMigrationTable)
          // 두 번째 호출: SELECT (getExecutedMigrations)
          if (sql.includes("SELECT")) {
            return { results: [{ name: "CreateUsersTable" }] };
          }
          return { results: [] };
        },
      );

      runner = new MigrationRunner([m1, m2], driver, queryRunner);
      const results = await runner.runAll();

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("AddEmailToUsers");
    });

    it("실패한 마이그레이션에서 중단해야 함", async () => {
      const m1 = new CreateUsersTable();
      const m2 = new FailingMigration();
      const m3 = new CreatePostsTable();

      runner = new MigrationRunner([m1, m2, m3], driver, queryRunner);
      const results = await runner.runAll();

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
      expect(results[1].error).toContain("intentionally failed");
      // m3 should not have been executed
    });

    it("마이그레이션 실행 시 __migrations에 기록해야 함", async () => {
      const m1 = new CreateUsersTable();
      runner = new MigrationRunner([m1], driver, queryRunner);

      await runner.runAll();

      const insertQuery = queryRunner.queries.find((q) =>
        q.includes("INSERT INTO"),
      );
      expect(insertQuery).toBeDefined();
      expect(insertQuery).toContain("CreateUsersTable");
    });

    it("runDown은 마이그레이션을 되돌리고 기록을 삭제해야 함", async () => {
      const m1 = new CreateUsersTable();
      runner = new MigrationRunner([m1], driver, queryRunner);

      const result = await runner.runDown(m1);

      expect(result.direction).toBe("down");
      expect(result.success).toBe(true);

      // down의 쿼리가 실행되었는지
      const dropQuery = queryRunner.queries.find((q) =>
        q.includes("DROP TABLE"),
      );
      expect(dropQuery).toBeDefined();

      // __migrations에서 삭제되었는지
      const deleteQuery = queryRunner.queries.find((q) =>
        q.includes("DELETE FROM"),
      );
      expect(deleteQuery).toBeDefined();
      expect(deleteQuery).toContain("CreateUsersTable");
    });

    it("revertLast는 가장 최근 마이그레이션을 되돌려야 함", async () => {
      const m1 = new CreateUsersTable();
      const m2 = new AddEmailToUsers();

      queryRunner = createMockQueryRunner();
      let callCount = 0;
      (queryRunner.query as jest.Mock).mockImplementation(
        async (sql: string) => {
          queryRunner.queries.push(sql);
          callCount++;
          if (sql.includes("SELECT")) {
            return {
              results: [
                { name: "CreateUsersTable" },
                { name: "AddEmailToUsers" },
              ],
            };
          }
          return { results: [] };
        },
      );

      runner = new MigrationRunner([m1, m2], driver, queryRunner);
      const result = await runner.revertLast();

      expect(result).not.toBeNull();
      expect(result!.name).toBe("AddEmailToUsers");
      expect(result!.direction).toBe("down");
      expect(result!.success).toBe(true);
    });

    it("실행된 마이그레이션이 없으면 revertLast는 null을 반환해야 함", async () => {
      runner = new MigrationRunner([], driver, queryRunner);
      const result = await runner.revertLast();
      expect(result).toBeNull();
    });

    it("getPendingMigrations는 미실행 마이그레이션만 반환해야 함", async () => {
      const m1 = new CreateUsersTable();
      const m2 = new AddEmailToUsers();
      const m3 = new CreatePostsTable();

      queryRunner = createMockQueryRunner();
      (queryRunner.query as jest.Mock).mockImplementation(
        async (sql: string) => {
          queryRunner.queries.push(sql);
          if (sql.includes("SELECT")) {
            return { results: [{ name: "CreateUsersTable" }] };
          }
          return { results: [] };
        },
      );

      runner = new MigrationRunner([m1, m2, m3], driver, queryRunner);
      const pending = await runner.getPendingMigrations();

      expect(pending).toHaveLength(2);
      expect(pending[0].name).toBe("AddEmailToUsers");
      expect(pending[1].name).toBe("CreatePostsTable");
    });
  });

  describe("MigrationRunner - MySQL", () => {
    let driver: ISqlDriver;
    let queryRunner: ReturnType<typeof createMockQueryRunner>;
    let runner: MigrationRunner;

    beforeEach(() => {
      driver = createMockDriver(true);
      queryRunner = createMockQueryRunner();
    });

    it("__migrations 테이블을 MySQL 구문으로 생성해야 함", async () => {
      runner = new MigrationRunner([], driver, queryRunner);
      await runner.ensureMigrationTable();

      expect(queryRunner.queries.length).toBe(1);
      expect(queryRunner.queries[0]).toContain("CREATE TABLE IF NOT EXISTS");
      expect(queryRunner.queries[0]).toContain("`__migrations`");
      expect(queryRunner.queries[0]).toContain("AUTO_INCREMENT");
    });

    it("MySQL에서도 마이그레이션이 순서대로 실행되어야 함", async () => {
      const m1 = new CreateUsersTable();
      const m2 = new AddEmailToUsers();

      runner = new MigrationRunner([m1, m2], driver, queryRunner);
      const results = await runner.runAll();

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
    });

    it("MySQL에서 식별자가 백틱으로 래핑되어야 함", async () => {
      const m1 = new CreateUsersTable();
      runner = new MigrationRunner([m1], driver, queryRunner);

      await runner.runAll();

      // INSERT 쿼리가 백틱을 사용하는지 확인
      const insertQuery = queryRunner.queries.find((q) =>
        q.includes("INSERT INTO"),
      );
      expect(insertQuery).toContain("`__migrations`");
    });
  });

  describe("MigrationContext", () => {
    it("up 메서드에서 driver와 query를 사용할 수 있어야 함", async () => {
      const driver = createMockDriver(false);
      const queryRunner = createMockQueryRunner();

      class TestMigration extends Migration {
        driverAvailable = false;
        queryAvailable = false;

        async up(ctx: MigrationContext): Promise<void> {
          this.driverAvailable = !!ctx.driver;
          this.queryAvailable = typeof ctx.query === "function";
          await ctx.query("SELECT 1");
        }
        async down(): Promise<void> {}
      }

      const migration = new TestMigration();
      const runner = new MigrationRunner([migration], driver, queryRunner);
      await runner.runUp(migration);

      expect(migration.driverAvailable).toBe(true);
      expect(migration.queryAvailable).toBe(true);
    });

    it("up 메서드에서 driver의 DDL 메서드를 사용할 수 있어야 함", async () => {
      const driver = createMockDriver(false);
      const queryRunner = createMockQueryRunner();

      class DDLMigration extends Migration {
        async up(ctx: MigrationContext): Promise<void> {
          await ctx.driver.addColumn("users", "age", "INT");
        }
        async down(ctx: MigrationContext): Promise<void> {
          await ctx.driver.dropColumn("users", "age");
        }
      }

      const migration = new DDLMigration();
      const runner = new MigrationRunner([migration], driver, queryRunner);

      const result = await runner.runUp(migration);
      expect(result.success).toBe(true);
      expect(driver.addColumn).toHaveBeenCalledWith("users", "age", "INT");
    });
  });

  describe("결과 정규화", () => {
    it("배열 결과를 올바르게 처리해야 함", async () => {
      const driver = createMockDriver(false);
      const queryRunner = createMockQueryRunner();

      // 결과가 직접 배열인 경우
      (queryRunner.query as jest.Mock).mockImplementation(
        async (sql: string) => {
          queryRunner.queries.push(sql);
          if (sql.includes("SELECT")) {
            return [{ name: "CreateUsersTable" }];
          }
          return [];
        },
      );

      const m1 = new CreateUsersTable();
      const m2 = new AddEmailToUsers();
      const runner = new MigrationRunner([m1, m2], driver, queryRunner);
      const pending = await runner.getPendingMigrations();

      expect(pending).toHaveLength(1);
      expect(pending[0].name).toBe("AddEmailToUsers");
    });

    it("PostgreSQL rows 형태 결과를 올바르게 처리해야 함", async () => {
      const driver = createMockDriver(false);
      const queryRunner = createMockQueryRunner();

      (queryRunner.query as jest.Mock).mockImplementation(
        async (sql: string) => {
          queryRunner.queries.push(sql);
          if (sql.includes("SELECT")) {
            return { rows: [{ name: "CreateUsersTable" }] };
          }
          return { rows: [] };
        },
      );

      const m1 = new CreateUsersTable();
      const m2 = new AddEmailToUsers();
      const runner = new MigrationRunner([m1, m2], driver, queryRunner);
      const pending = await runner.getPendingMigrations();

      expect(pending).toHaveLength(1);
      expect(pending[0].name).toBe("AddEmailToUsers");
    });

    it("null 결과를 빈 배열로 처리해야 함", async () => {
      const driver = createMockDriver(false);
      const queryRunner = createMockQueryRunner();

      (queryRunner.query as jest.Mock).mockImplementation(
        async (sql: string) => {
          queryRunner.queries.push(sql);
          if (sql.includes("SELECT")) {
            return null;
          }
          return null;
        },
      );

      const m1 = new CreateUsersTable();
      const runner = new MigrationRunner([m1], driver, queryRunner);
      const pending = await runner.getPendingMigrations();

      expect(pending).toHaveLength(1);
    });
  });

  describe("에러 처리", () => {
    it("runDown이 실패하면 에러 메시지를 포함한 결과를 반환해야 함", async () => {
      const driver = createMockDriver(false);
      const queryRunner = createMockQueryRunner();

      class FailOnDown extends Migration {
        async up(): Promise<void> {}
        async down(): Promise<void> {
          throw new Error("Cannot revert");
        }
      }

      const migration = new FailOnDown();
      const runner = new MigrationRunner([migration], driver, queryRunner);
      const result = await runner.runDown(migration);

      expect(result.success).toBe(false);
      expect(result.direction).toBe("down");
      expect(result.error).toContain("Cannot revert");
    });

    it("등록되지 않은 마이그레이션을 revert하면 에러 결과를 반환해야 함", async () => {
      const driver = createMockDriver(false);
      const queryRunner = createMockQueryRunner();

      (queryRunner.query as jest.Mock).mockImplementation(
        async (sql: string) => {
          queryRunner.queries.push(sql);
          if (sql.includes("SELECT")) {
            return { results: [{ name: "UnknownMigration" }] };
          }
          return { results: [] };
        },
      );

      const runner = new MigrationRunner([], driver, queryRunner);
      const result = await runner.revertLast();

      expect(result).not.toBeNull();
      expect(result!.success).toBe(false);
      expect(result!.error).toContain("not found");
    });
  });
});
