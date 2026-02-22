import "reflect-metadata";
import { MySqlDriver } from "../../src/dialects/mysql/MySqlDriver";
import { PostgresDriver } from "../../src/dialects/postgres/PostgresDriver";
import { SqliteDriver } from "../../src/dialects/sqlite/SqliteDriver";
import { MssqlDriver } from "../../src/dialects/mssql/MssqlDriver";
import { EntityManager } from "../../src/core/EntityManager";
import { ExplainResult } from "../../src/core/ExplainResult";
import { InvalidQueryError } from "../../src/errors/InvalidQueryError";

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

// ─── Driver supportsExplain / buildExplainSql 테스트 ──────────────────────

describe("Driver supportsExplain() / buildExplainSql()", () => {
  describe("MySqlDriver", () => {
    let driver: MySqlDriver;
    beforeEach(() => { driver = new MySqlDriver({} as any, "mysql"); });

    it("should support EXPLAIN", () => {
      expect(driver.supportsExplain()).toBe(true);
    });

    it("should build EXPLAIN SELECT SQL", () => {
      expect(driver.buildExplainSql("SELECT * FROM users")).toBe(
        "EXPLAIN SELECT * FROM users",
      );
    });
  });

  describe("PostgresDriver", () => {
    let driver: PostgresDriver;
    beforeEach(() => { driver = new PostgresDriver({} as any, "postgres"); });

    it("should support EXPLAIN", () => {
      expect(driver.supportsExplain()).toBe(true);
    });

    it("should build EXPLAIN (FORMAT JSON) SQL", () => {
      expect(driver.buildExplainSql("SELECT * FROM users")).toBe(
        "EXPLAIN (FORMAT JSON) SELECT * FROM users",
      );
    });
  });

  describe("SqliteDriver", () => {
    let driver: SqliteDriver;
    beforeEach(() => { driver = new SqliteDriver({} as any); });

    it("should support EXPLAIN", () => {
      expect(driver.supportsExplain()).toBe(true);
    });

    it("should build EXPLAIN QUERY PLAN SQL", () => {
      expect(driver.buildExplainSql("SELECT * FROM users")).toBe(
        "EXPLAIN QUERY PLAN SELECT * FROM users",
      );
    });
  });

  describe("MssqlDriver", () => {
    let driver: MssqlDriver;
    beforeEach(() => { driver = new MssqlDriver({} as any); });

    it("should not support EXPLAIN", () => {
      expect(driver.supportsExplain()).toBe(false);
    });

    it("should throw when buildExplainSql is called", () => {
      expect(() => driver.buildExplainSql("SELECT * FROM users")).toThrow(
        "EXPLAIN is not supported for MSSQL.",
      );
    });
  });
});

// ─── EntityManager.explain() 테스트 ──────────────────────────────────────

describe("EntityManager.explain()", () => {
  let em: EntityManager;

  const mockMetadata = {
    name: "TestEntity",
    columns: [
      { name: "id", options: { primary: true } },
      { name: "name", options: {} },
      { name: "age", options: {} },
    ],
  };

  function setupDriver(driver: any) {
    (em as any).driver = driver;
    (em as any)._entities = [];
    jest.spyOn(em as any, "resolveEntityMetadata").mockReturnValue(mockMetadata);
    jest.spyOn(em as any, "resolveManyToOneMetadata").mockReturnValue([]);
    jest.spyOn(em as any, "resolveOneToOneMetadata").mockReturnValue([]);
    jest.spyOn(em as any, "getDeletedAtColumn").mockReturnValue(null);
  }

  class TestEntity {
    id!: number;
    name!: string;
    age!: number;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    em = new EntityManager();
  });

  it("should throw InvalidQueryError when driver does not support EXPLAIN", async () => {
    setupDriver(new MssqlDriver({} as any));
    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(false);

    await expect(em.explain(TestEntity)).rejects.toThrow(InvalidQueryError);
  });

  it("should throw InvalidQueryError when driver is not set", async () => {
    (em as any).driver = undefined;

    await expect(em.explain(TestEntity)).rejects.toThrow(InvalidQueryError);
  });

  it("should execute EXPLAIN SQL for MySQL driver", async () => {
    setupDriver(new MySqlDriver({} as any, "mysql"));
    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);

    mockQuery.mockResolvedValue({
      results: [{
        id: 1, select_type: "SIMPLE", table: "TestEntity",
        type: "ALL", possible_keys: null, key: null,
        rows: 100, filtered: 100.0,
      }],
    });

    const result = await em.explain(TestEntity);

    // Verify EXPLAIN SQL was sent (Sql object has .text property)
    const calls = mockQuery.mock.calls.map((c) =>
      typeof c[0] === "string" ? c[0] : (c[0]?.text ?? String(c[0])),
    );
    const explainCall = calls.find((c) => c.includes("EXPLAIN"));
    expect(explainCall).toBeDefined();
    expect(result.raw).toHaveLength(1);
    expect(result.type).toBe("ALL");
    expect(result.rows).toBe(100);
  });

  it("should parse MySQL EXPLAIN result correctly", async () => {
    setupDriver(new MySqlDriver({} as any, "mysql"));
    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);

    mockQuery.mockResolvedValue({
      results: [{
        select_type: "SIMPLE", table: "TestEntity",
        type: "ref", possible_keys: "idx_name,idx_age",
        key: "idx_name", rows: 5, filtered: 80.0,
      }],
    });

    const result = await em.explain(TestEntity);

    expect(result.type).toBe("ref");
    expect(result.rows).toBe(5);
    expect(result.possibleKeys).toEqual(["idx_name", "idx_age"]);
    expect(result.key).toBe("idx_name");
    expect(result.cost).toBe(80.0);
  });

  it("should parse PostgreSQL EXPLAIN (FORMAT JSON) result correctly", async () => {
    setupDriver(new PostgresDriver({} as any, "postgres"));
    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(false);

    mockQuery.mockResolvedValue({
      results: [{
        "QUERY PLAN": [{
          Plan: {
            "Node Type": "Seq Scan",
            "Plan Rows": 50,
            "Total Cost": 12.34,
            "Relation Name": "TestEntity",
          },
        }],
      }],
    });

    const result = await em.explain(TestEntity);

    expect(result.type).toBe("Seq Scan");
    expect(result.rows).toBe(50);
    expect(result.cost).toBe(12.34);
    expect(result.possibleKeys).toBeNull();
  });

  it("should parse PostgreSQL EXPLAIN with index scan", async () => {
    setupDriver(new PostgresDriver({} as any, "postgres"));
    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(false);

    mockQuery.mockResolvedValue({
      results: [{
        "QUERY PLAN": [{
          Plan: {
            "Node Type": "Index Scan",
            "Plan Rows": 1,
            "Total Cost": 0.29,
            "Index Name": "users_pkey",
          },
        }],
      }],
    });

    const result = await em.explain(TestEntity);

    expect(result.type).toBe("Index Scan");
    expect(result.rows).toBe(1);
    expect(result.key).toBe("users_pkey");
    expect(result.cost).toBe(0.29);
  });

  it("should parse SQLite EXPLAIN QUERY PLAN result (SCAN)", async () => {
    setupDriver(new SqliteDriver({} as any));
    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(false);

    mockQuery.mockResolvedValue({
      results: [
        { id: 2, parent: 0, notused: 0, detail: "SCAN TestEntity" },
      ],
    });

    const result = await em.explain(TestEntity);

    expect(result.type).toBe("SCAN");
    expect(result.key).toBeNull();
    expect(result.rows).toBeNull();
  });

  it("should parse SQLite EXPLAIN QUERY PLAN result (SEARCH with INDEX)", async () => {
    setupDriver(new SqliteDriver({} as any));
    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(false);

    mockQuery.mockResolvedValue({
      results: [
        { id: 3, parent: 0, notused: 0, detail: "SEARCH TestEntity USING INDEX idx_name (name=?)" },
      ],
    });

    const result = await em.explain(TestEntity);

    expect(result.type).toBe("SEARCH");
    expect(result.key).toBe("idx_name");
  });

  it("should handle empty EXPLAIN result", async () => {
    setupDriver(new MySqlDriver({} as any, "mysql"));
    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);

    mockQuery.mockResolvedValue({ results: [] });

    const result = await em.explain(TestEntity);

    expect(result.raw).toEqual([]);
    expect(result.rows).toBeNull();
    expect(result.type).toBeNull();
  });

  it("should pass WHERE conditions to the EXPLAIN query", async () => {
    setupDriver(new MySqlDriver({} as any, "mysql"));
    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);

    mockQuery.mockResolvedValue({
      results: [{ select_type: "SIMPLE", type: "const", rows: 1, filtered: 100 }],
    });

    await em.explain(TestEntity, { where: { name: "test" } as any });

    const calls = mockQuery.mock.calls.map((c) =>
      typeof c[0] === "string" ? c[0] : (c[0]?.text ?? String(c[0])),
    );
    const explainCall = calls.find((c) => c.includes("EXPLAIN"));
    expect(explainCall).toContain("WHERE");
  });

  it("should return ExplainResult with all standardized fields", async () => {
    setupDriver(new MySqlDriver({} as any, "mysql"));
    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);

    mockQuery.mockResolvedValue({
      results: [{
        select_type: "SIMPLE", type: "ALL", rows: 10,
        possible_keys: null, key: null, filtered: 100,
      }],
    });

    const result: ExplainResult = await em.explain(TestEntity);

    expect(result).toHaveProperty("raw");
    expect(result).toHaveProperty("rows");
    expect(result).toHaveProperty("type");
    expect(result).toHaveProperty("possibleKeys");
    expect(result).toHaveProperty("key");
    expect(result).toHaveProperty("cost");
  });
});

// ─── BaseRepository.explain() 위임 테스트 ────────────────────────────────

describe("BaseRepository.explain()", () => {
  it("should delegate to EntityManager.explain()", async () => {
    const { BaseRepository } = require("../../src/core/BaseRepository");

    class TestEntity {
      id!: number;
    }

    const mockExplain = jest.fn().mockResolvedValue({
      raw: [], rows: null, type: null, possibleKeys: null, key: null, cost: null,
    });

    const mockEm = { explain: mockExplain } as any;
    const repo = new BaseRepository(TestEntity, mockEm);

    const option = { where: { id: 1 } };
    await repo.explain(option);

    expect(mockExplain).toHaveBeenCalledWith(TestEntity, option);
  });
});
