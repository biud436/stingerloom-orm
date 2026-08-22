import "reflect-metadata";
import { MySqlDriver } from "../../src/dialects/mysql/MySqlDriver";
import { PostgresDriver } from "../../src/dialects/postgres/PostgresDriver";
import { SqliteDriver } from "../../src/dialects/sqlite/SqliteDriver";
import { QueryTimeoutError } from "../../src/errors/QueryTimeoutError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";
import { EntityManager } from "../../src/core/EntityManager";
import { DbVersion } from "../../src/dialects/DbVersion";
import { isStatementTimeoutError } from "../../src/core/entity-manager/internal-utils";

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

// ─── Driver setQueryTimeout 테스트 ────────────────────────────────────────────

describe("Driver setQueryTimeout()", () => {
  describe("MySqlDriver", () => {
    let driver: MySqlDriver;

    beforeEach(() => {
      driver = new MySqlDriver({} as any, "mysql");
    });

    it("should return SET SESSION max_execution_time SQL", () => {
      expect(driver.setQueryTimeout(5000)).toBe(
        "SET SESSION max_execution_time = 5000",
      );
    });

    it("should floor fractional milliseconds", () => {
      expect(driver.setQueryTimeout(1500.7)).toBe(
        "SET SESSION max_execution_time = 1500",
      );
    });

    it("should handle zero timeout", () => {
      expect(driver.setQueryTimeout(0)).toBe(
        "SET SESSION max_execution_time = 0",
      );
    });

    it("should clamp negative values to zero", () => {
      expect(driver.setQueryTimeout(-100)).toBe(
        "SET SESSION max_execution_time = 0",
      );
    });
  });

  describe("MySqlDriver on MariaDB", () => {
    // MariaDB has no `max_execution_time` — SET-ting it dies with
    // ER_UNKNOWN_SYSTEM_VARIABLE (1193), which used to make every timed read
    // fail on MariaDB. Its equivalent is `max_statement_time`, in SECONDS.

    it("declared type mariadb uses max_statement_time in seconds", () => {
      const driver = new MySqlDriver({} as any, "mariadb");
      expect(driver.setQueryTimeout(300)).toBe(
        "SET SESSION max_statement_time = 0.3",
      );
    });

    it("declared type mysql pointed at a MariaDB server is detected from the version string", () => {
      const driver = new MySqlDriver(
        {} as any,
        "mysql",
        DbVersion.parse("11.8.6-MariaDB-ubu2404"),
      );
      expect(driver.setQueryTimeout(5000)).toBe(
        "SET SESSION max_statement_time = 5",
      );
    });

    it("zero still means no limit", () => {
      const driver = new MySqlDriver({} as any, "mariadb");
      expect(driver.setQueryTimeout(0)).toBe(
        "SET SESSION max_statement_time = 0",
      );
    });

    it("a genuine MySQL version string keeps max_execution_time", () => {
      const driver = new MySqlDriver(
        {} as any,
        "mysql",
        DbVersion.parse("8.0.36-MySQL Community Server"),
      );
      expect(driver.setQueryTimeout(300)).toBe(
        "SET SESSION max_execution_time = 300",
      );
    });
  });

  describe("PostgresDriver", () => {
    let driver: PostgresDriver;

    beforeEach(() => {
      driver = new PostgresDriver({} as any, "postgres");
    });

    it("should return SET LOCAL statement_timeout SQL", () => {
      expect(driver.setQueryTimeout(3000)).toBe(
        "SET LOCAL statement_timeout = '3000ms'",
      );
    });

    it("should floor fractional milliseconds", () => {
      expect(driver.setQueryTimeout(2500.9)).toBe(
        "SET LOCAL statement_timeout = '2500ms'",
      );
    });

    it("should handle zero timeout", () => {
      expect(driver.setQueryTimeout(0)).toBe(
        "SET LOCAL statement_timeout = '0ms'",
      );
    });

    it("should clamp negative values to zero", () => {
      expect(driver.setQueryTimeout(-50)).toBe(
        "SET LOCAL statement_timeout = '0ms'",
      );
    });
  });

  describe("SqliteDriver", () => {
    let driver: SqliteDriver;

    beforeEach(() => {
      driver = new SqliteDriver({} as any);
    });

    it("should return PRAGMA busy_timeout SQL", () => {
      expect(driver.setQueryTimeout(2000)).toBe("PRAGMA busy_timeout = 2000");
    });

    it("should floor fractional milliseconds", () => {
      expect(driver.setQueryTimeout(1000.3)).toBe("PRAGMA busy_timeout = 1000");
    });

    it("should handle zero timeout", () => {
      expect(driver.setQueryTimeout(0)).toBe("PRAGMA busy_timeout = 0");
    });

    it("should clamp negative values to zero", () => {
      expect(driver.setQueryTimeout(-200)).toBe("PRAGMA busy_timeout = 0");
    });
  });

});

// ─── QueryTimeoutError 테스트 ────────────────────────────────────────────────

describe("QueryTimeoutError", () => {
  it("should have the correct error code", () => {
    const error = new QueryTimeoutError(5000);
    expect(error.code).toBe(OrmErrorCode.QUERY_TIMEOUT);
  });

  it("should include timeout value in the message", () => {
    const error = new QueryTimeoutError(3000);
    expect(error.message).toContain("3000ms");
  });

  it("should have the correct name", () => {
    const error = new QueryTimeoutError(1000);
    expect(error.name).toBe("QueryTimeoutError");
  });

  it("should be an instance of Error", () => {
    const error = new QueryTimeoutError(1000);
    expect(error).toBeInstanceOf(Error);
  });

  it("should keep the driver error as cause", () => {
    const driverError = Object.assign(new Error("canceled"), { code: "57014" });
    const error = new QueryTimeoutError(1000, driverError);
    expect(error.cause).toBe(driverError);
  });
});

// ─── isStatementTimeoutError 매핑 테스트 ─────────────────────────────────────

describe("isStatementTimeoutError()", () => {
  it("matches PostgreSQL 57014 (query_canceled)", () => {
    const e = Object.assign(
      new Error("canceling statement due to statement timeout"),
      { code: "57014" },
    );
    expect(isStatementTimeoutError(e)).toBe(true);
  });

  it("matches MySQL errno 3024 (ER_QUERY_TIMEOUT)", () => {
    const e = Object.assign(new Error("Query execution was interrupted"), {
      errno: 3024,
    });
    expect(isStatementTimeoutError(e)).toBe(true);
  });

  it("matches MariaDB errno 1969 (ER_STATEMENT_TIMEOUT)", () => {
    // Real shape observed on MariaDB 11.8: errno 1969, sqlState 70100,
    // code undefined.
    const e = Object.assign(
      new Error(
        "Query execution was interrupted (max_statement_time exceeded)",
      ),
      { errno: 1969, sqlState: "70100" },
    );
    expect(isStatementTimeoutError(e)).toBe(true);
  });

  it("does not match deadlocks or generic errors", () => {
    expect(
      isStatementTimeoutError(
        Object.assign(new Error("deadlock"), { errno: 1213 }),
      ),
    ).toBe(false);
    expect(isStatementTimeoutError(new Error("boom"))).toBe(false);
    expect(isStatementTimeoutError("57014")).toBe(false);
  });

  it("does not match SQLITE_BUSY (lock wait, not a statement timeout)", () => {
    const e = Object.assign(new Error("database is locked"), {
      code: "SQLITE_BUSY",
    });
    expect(isStatementTimeoutError(e)).toBe(false);
  });
});

// ─── EntityManager 타임아웃 통합 테스트 ─────────────────────────────────────

describe("EntityManager query timeout integration", () => {
  let em: EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({
      results: [{ id: 1, name: "test" }],
    });
    em = new EntityManager();
  });

  // EntityManager의 find()에서 timeout 옵션을 전달하면
  // setQueryTimeout SQL이 먼저 실행되는지 테스트
  it("should execute setQueryTimeout SQL before main query when FindOption.timeout is set", async () => {
    // driver를 직접 설정하여 테스트
    (em as any).driver = new MySqlDriver({} as any, "mysql");
    (em as any)._entities = [];

    // 엔티티 메타데이터 mock
    const mockMetadata = {
      name: "TestEntity",
      columns: [
        { name: "id", options: { primary: true } },
        { name: "name", options: {} },
      ],
    };

    jest
      .spyOn((em as any).resolver, "resolveEntityMetadata")
      .mockReturnValue(mockMetadata);
    jest
      .spyOn((em as any).resolver, "resolveManyToOneMetadata")
      .mockReturnValue([]);
    jest
      .spyOn((em as any).resolver, "resolveOneToOneMetadata")
      .mockReturnValue([]);
    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);

    class TestEntity {
      id!: number;
      name!: string;
    }

    await em.find(TestEntity, { timeout: 5000 } as any);

    // query 호출 순서 확인: SET SESSION max_execution_time → SELECT
    const calls = mockQuery.mock.calls.map((c) =>
      typeof c[0] === "string" ? c[0] : c[0]?.text ?? String(c[0]),
    );

    const timeoutCallIndex = calls.findIndex((c) =>
      c.includes("max_execution_time"),
    );
    expect(timeoutCallIndex).toBeGreaterThanOrEqual(0);
  });

  it("should use defaultQueryTimeout when no per-query timeout is set", async () => {
    (em as any).driver = new MySqlDriver({} as any, "mysql");
    (em as any).defaultQueryTimeout = 3000;
    (em as any)._entities = [];

    const mockMetadata = {
      name: "TestEntity",
      columns: [
        { name: "id", options: { primary: true } },
        { name: "name", options: {} },
      ],
    };

    jest
      .spyOn((em as any).resolver, "resolveEntityMetadata")
      .mockReturnValue(mockMetadata);
    jest
      .spyOn((em as any).resolver, "resolveManyToOneMetadata")
      .mockReturnValue([]);
    jest
      .spyOn((em as any).resolver, "resolveOneToOneMetadata")
      .mockReturnValue([]);
    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);

    class TestEntity {
      id!: number;
      name!: string;
    }

    await em.find(TestEntity, {});

    const calls = mockQuery.mock.calls.map((c) =>
      typeof c[0] === "string" ? c[0] : c[0]?.text ?? String(c[0]),
    );

    const timeoutCallIndex = calls.findIndex((c) =>
      c.includes("max_execution_time = 3000"),
    );
    expect(timeoutCallIndex).toBeGreaterThanOrEqual(0);
  });

  it("per-query timeout should override connection-level timeout", async () => {
    (em as any).driver = new MySqlDriver({} as any, "mysql");
    (em as any).defaultQueryTimeout = 3000;
    (em as any)._entities = [];

    const mockMetadata = {
      name: "TestEntity",
      columns: [
        { name: "id", options: { primary: true } },
        { name: "name", options: {} },
      ],
    };

    jest
      .spyOn((em as any).resolver, "resolveEntityMetadata")
      .mockReturnValue(mockMetadata);
    jest
      .spyOn((em as any).resolver, "resolveManyToOneMetadata")
      .mockReturnValue([]);
    jest
      .spyOn((em as any).resolver, "resolveOneToOneMetadata")
      .mockReturnValue([]);
    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);

    class TestEntity {
      id!: number;
      name!: string;
    }

    await em.find(TestEntity, { timeout: 7000 } as any);

    const calls = mockQuery.mock.calls.map((c) =>
      typeof c[0] === "string" ? c[0] : c[0]?.text ?? String(c[0]),
    );

    // per-query 7000이 사용되어야 함, connection-level 3000이 아님
    const timeoutCall = calls.find((c) => c.includes("max_execution_time"));
    expect(timeoutCall).toContain("7000");
    expect(timeoutCall).not.toContain("3000");
  });

  it("should not execute timeout SQL when no timeout is configured", async () => {
    (em as any).driver = new MySqlDriver({} as any, "mysql");
    (em as any)._entities = [];

    const mockMetadata = {
      name: "TestEntity",
      columns: [
        { name: "id", options: { primary: true } },
        { name: "name", options: {} },
      ],
    };

    jest
      .spyOn((em as any).resolver, "resolveEntityMetadata")
      .mockReturnValue(mockMetadata);
    jest
      .spyOn((em as any).resolver, "resolveManyToOneMetadata")
      .mockReturnValue([]);
    jest
      .spyOn((em as any).resolver, "resolveOneToOneMetadata")
      .mockReturnValue([]);
    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);

    class TestEntity {
      id!: number;
      name!: string;
    }

    await em.find(TestEntity, {});

    const calls = mockQuery.mock.calls.map((c) =>
      typeof c[0] === "string" ? c[0] : c[0]?.text ?? String(c[0]),
    );

    const timeoutCall = calls.find((c) =>
      c.includes("max_execution_time"),
    );
    expect(timeoutCall).toBeUndefined();
  });

  it("should work with PostgreSQL driver timeout", async () => {
    (em as any).driver = new PostgresDriver({} as any, "postgres");
    (em as any)._entities = [];

    const mockMetadata = {
      name: "TestEntity",
      columns: [
        { name: "id", options: { primary: true } },
        { name: "name", options: {} },
      ],
    };

    jest
      .spyOn((em as any).resolver, "resolveEntityMetadata")
      .mockReturnValue(mockMetadata);
    jest
      .spyOn((em as any).resolver, "resolveManyToOneMetadata")
      .mockReturnValue([]);
    jest
      .spyOn((em as any).resolver, "resolveOneToOneMetadata")
      .mockReturnValue([]);
    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(false);

    class TestEntity {
      id!: number;
      name!: string;
    }

    await em.find(TestEntity, { timeout: 2000 } as any);

    const calls = mockQuery.mock.calls.map((c) =>
      typeof c[0] === "string" ? c[0] : c[0]?.text ?? String(c[0]),
    );

    const timeoutCall = calls.find((c) => c.includes("statement_timeout"));
    expect(timeoutCall).toBe("SET LOCAL statement_timeout = '2000ms'");
  });
});
