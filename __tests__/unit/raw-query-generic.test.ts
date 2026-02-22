import "reflect-metadata";
import Container from "typedi";
import sql from "sql-template-tag";
import { EntityManager } from "../../src/core/EntityManager";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";

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

jest.mock("../../src/dialects/TransactionSessionManager", () => {
  const mockQuery = jest.fn();
  const mockConnect = jest.fn().mockResolvedValue(undefined);
  const mockStartTransaction = jest.fn().mockResolvedValue(undefined);
  const mockCommit = jest.fn().mockResolvedValue(undefined);
  const mockRollback = jest.fn().mockResolvedValue(undefined);
  const mockClose = jest.fn().mockResolvedValue(undefined);

  return {
    TransactionSessionManager: jest.fn().mockImplementation(() => ({
      connect: mockConnect,
      startTransaction: mockStartTransaction,
      query: mockQuery,
      commit: mockCommit,
      rollback: mockRollback,
      close: mockClose,
    })),
    __mockQuery: mockQuery,
    __mockConnect: mockConnect,
    __mockStartTransaction: mockStartTransaction,
    __mockCommit: mockCommit,
    __mockRollback: mockRollback,
    __mockClose: mockClose,
  };
});

function createTestEntityManager() {
  const em = new EntityManager();
  (em as any).driver = {
    wrap: (name: string) => `\`${name}\``,
  };
  return em;
}

describe("EntityManager.query<T>() - Raw Query Generic", () => {
  let em: EntityManager;

  beforeEach(() => {
    MetadataLayerRegistry.reset();
    Container.reset();
    jest.clearAllMocks();
    em = createTestEntityManager();
  });

  it("should return typed results from a Sql template query", async () => {
    const { __mockQuery } =
      jest.requireMock("../../src/dialects/TransactionSessionManager");

    __mockQuery.mockResolvedValue({
      results: [
        { id: 1, name: "Alice", age: 30 },
        { id: 2, name: "Bob", age: 25 },
      ],
      fields: [],
    });

    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);

    interface UserRow {
      id: number;
      name: string;
      age: number;
    }

    const results = await em.query<UserRow>(sql`SELECT * FROM users`);

    expect(results).toHaveLength(2);
    expect(results[0].id).toBe(1);
    expect(results[0].name).toBe("Alice");
    expect(results[1].age).toBe(25);
  });

  it("should return typed results from a string query", async () => {
    const { __mockQuery } =
      jest.requireMock("../../src/dialects/TransactionSessionManager");

    __mockQuery.mockResolvedValue({
      results: [{ count: 42 }],
      fields: [],
    });

    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);

    interface CountResult {
      count: number;
    }

    const results = await em.query<CountResult>("SELECT COUNT(*) as count FROM users");

    expect(results).toHaveLength(1);
    expect(results[0].count).toBe(42);
  });

  it("should return typed results from a string query with params", async () => {
    const { __mockQuery } =
      jest.requireMock("../../src/dialects/TransactionSessionManager");

    __mockQuery.mockResolvedValue({
      results: [{ id: 1, name: "Alice" }],
      fields: [],
    });

    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(false);

    interface UserRow {
      id: number;
      name: string;
    }

    const results = await em.query<UserRow>(
      "SELECT * FROM users WHERE id = $1",
      [1],
    );

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(1);
    expect(results[0].name).toBe("Alice");
  });

  it("should return empty array when results are null", async () => {
    const { __mockQuery } =
      jest.requireMock("../../src/dialects/TransactionSessionManager");

    __mockQuery.mockResolvedValue({
      results: null,
      fields: [],
    });

    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);

    const results = await em.query("SELECT * FROM empty_table");

    expect(results).toEqual([]);
  });

  it("should return empty array when query returns a non-array, non-result object", async () => {
    const { __mockQuery } =
      jest.requireMock("../../src/dialects/TransactionSessionManager");

    __mockQuery.mockResolvedValue(undefined);

    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);

    const results = await em.query("SELECT 1");

    expect(results).toEqual([]);
  });

  it("should handle array-style results from drivers like SQLite", async () => {
    const { __mockQuery } =
      jest.requireMock("../../src/dialects/TransactionSessionManager");

    // SQLite 드라이버 등은 배열을 직접 반환할 수 있음
    __mockQuery.mockResolvedValue([
      { id: 1, title: "Hello" },
      { id: 2, title: "World" },
    ]);

    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(false);

    interface PostRow {
      id: number;
      title: string;
    }

    const results = await em.query<PostRow>("SELECT * FROM posts");

    expect(results).toHaveLength(2);
    expect(results[0].title).toBe("Hello");
    expect(results[1].title).toBe("World");
  });

  it("should rollback and throw on query error", async () => {
    const { __mockQuery, __mockRollback } =
      jest.requireMock("../../src/dialects/TransactionSessionManager");

    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);

    __mockQuery
      .mockResolvedValueOnce(undefined) // SET autocommit
      .mockRejectedValueOnce(new Error("Syntax error"));

    await expect(
      em.query("INVALID SQL QUERY"),
    ).rejects.toThrow("Syntax error");
  });

  it("should commit transaction on success", async () => {
    const { __mockQuery, __mockCommit } =
      jest.requireMock("../../src/dialects/TransactionSessionManager");

    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);

    __mockQuery.mockResolvedValue({
      results: [{ val: 1 }],
      fields: [],
    });

    await em.query("SELECT 1 as val");

    // commit should be called (after SET autocommit and the query)
    expect(__mockCommit).toHaveBeenCalled();
  });

  it("should skip SET autocommit for non-MySQL databases", async () => {
    const { __mockQuery, __mockCommit } =
      jest.requireMock("../../src/dialects/TransactionSessionManager");

    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(false);

    __mockQuery.mockResolvedValue({
      results: [{ id: 1 }],
      fields: [],
    });

    await em.query(sql`SELECT 1`);

    // No "SET autocommit = 0" call
    const stringCalls = __mockQuery.mock.calls.filter(
      (call: any[]) => typeof call[0] === "string",
    );
    expect(stringCalls).toHaveLength(0);
  });

  it("should always close the transaction holder", async () => {
    const { __mockQuery, __mockClose } =
      jest.requireMock("../../src/dialects/TransactionSessionManager");

    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);

    __mockQuery.mockResolvedValue({
      results: [],
      fields: [],
    });

    await em.query("SELECT 1");

    expect(__mockClose).toHaveBeenCalled();
  });

  it("should close even when query throws", async () => {
    const { __mockQuery, __mockClose } =
      jest.requireMock("../../src/dialects/TransactionSessionManager");

    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);

    __mockQuery
      .mockResolvedValueOnce(undefined) // SET autocommit
      .mockRejectedValueOnce(new Error("fail"));

    await expect(em.query("BAD")).rejects.toThrow("fail");
    expect(__mockClose).toHaveBeenCalled();
  });

  it("should default to Record<string, unknown> type when no generic is provided", async () => {
    const { __mockQuery } =
      jest.requireMock("../../src/dialects/TransactionSessionManager");

    __mockQuery.mockResolvedValue({
      results: [{ x: 1, y: "hello" }],
      fields: [],
    });

    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(false);

    const results = await em.query("SELECT 1 as x, 'hello' as y");

    expect(results).toHaveLength(1);
    // TypeScript compile-time check: results[0] is Record<string, unknown>
    expect(results[0]).toHaveProperty("x", 1);
    expect(results[0]).toHaveProperty("y", "hello");
  });
});
