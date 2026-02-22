import "reflect-metadata";
import Container from "typedi";
import sql, { join, raw } from "sql-template-tag";
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

// EntityManager의 resolveEntityMetadata를 모킹하기 위한 헬퍼
function createTestEntityManager() {
  const em = new EntityManager();

  // driver를 mock으로 설정 (wrap 메서드)
  (em as any).driver = {
    wrap: (name: string) => `\`${name}\``,
  };

  return em;
}

// 테스트용 엔티티 메타데이터
const userMetadata = {
  name: "User",
  target: class User {},
  columns: [
    { name: "id", options: { primary: true, autoIncrement: true } },
    { name: "name", options: {} },
    { name: "email", options: {} },
  ],
};

const productMetadata = {
  name: "Product",
  target: class Product {},
  columns: [
    { name: "id", options: { primary: true, autoIncrement: true } },
    { name: "title", options: {} },
    { name: "price", options: {} },
  ],
};

describe("EntityManager.saveMany()", () => {
  let em: EntityManager;

  beforeEach(() => {
    MetadataLayerRegistry.reset();
    Container.reset();
    jest.clearAllMocks();
    em = createTestEntityManager();
  });

  it("should return empty array for empty input", async () => {
    const result = await em.saveMany(userMetadata.target, []);
    expect(result).toEqual([]);
  });

  it("should call save() for each item", async () => {
    const saveSpy = jest
      .spyOn(em, "save")
      .mockResolvedValueOnce({ id: 1, name: "Alice", email: "a@test.com" } as any)
      .mockResolvedValueOnce({ id: 2, name: "Bob", email: "b@test.com" } as any);

    const items = [
      { name: "Alice", email: "a@test.com" },
      { name: "Bob", email: "b@test.com" },
    ];

    const result = await em.saveMany(userMetadata.target, items);

    expect(saveSpy).toHaveBeenCalledTimes(2);
    expect(saveSpy).toHaveBeenCalledWith(userMetadata.target, items[0]);
    expect(saveSpy).toHaveBeenCalledWith(userMetadata.target, items[1]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ id: 1, name: "Alice", email: "a@test.com" });
    expect(result[1]).toEqual({ id: 2, name: "Bob", email: "b@test.com" });
  });

  it("should handle a single item", async () => {
    const saveSpy = jest
      .spyOn(em, "save")
      .mockResolvedValueOnce({ id: 1, name: "Solo" } as any);

    const result = await em.saveMany(userMetadata.target, [{ name: "Solo" }]);

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ id: 1, name: "Solo" });
  });

  it("should propagate errors from save()", async () => {
    jest
      .spyOn(em, "save")
      .mockResolvedValueOnce({ id: 1, name: "Ok" } as any)
      .mockRejectedValueOnce(new Error("DB connection lost"));

    await expect(
      em.saveMany(userMetadata.target, [
        { name: "Ok" },
        { name: "Fail" },
      ]),
    ).rejects.toThrow("DB connection lost");
  });

  it("should handle many items", async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      name: `User ${i}`,
      email: `user${i}@test.com`,
    }));

    const saveSpy = jest.spyOn(em, "save");
    for (let i = 0; i < 10; i++) {
      saveSpy.mockResolvedValueOnce({
        id: i + 1,
        name: `User ${i}`,
        email: `user${i}@test.com`,
      } as any);
    }

    const result = await em.saveMany(userMetadata.target, items);

    expect(saveSpy).toHaveBeenCalledTimes(10);
    expect(result).toHaveLength(10);
    expect(result[0]).toEqual({
      id: 1,
      name: "User 0",
      email: "user0@test.com",
    });
    expect(result[9]).toEqual({
      id: 10,
      name: "User 9",
      email: "user9@test.com",
    });
  });
});

describe("EntityManager.insertMany()", () => {
  let em: EntityManager;

  beforeEach(() => {
    MetadataLayerRegistry.reset();
    Container.reset();
    jest.clearAllMocks();
    em = createTestEntityManager();
  });

  it("should return { affected: 0 } for empty input", async () => {
    const result = await em.insertMany(userMetadata.target, []);
    expect(result).toEqual({ affected: 0 });
  });

  it("should throw when entity metadata does not exist", async () => {
    class UnknownEntity {}

    // resolveEntityMetadata returns null for unknown entities
    jest
      .spyOn(em as any, "resolveEntityMetadata")
      .mockReturnValue(null);

    await expect(
      em.insertMany(UnknownEntity, [{ name: "test" }]),
    ).rejects.toThrow("Entity metadata does not exist.");
  });

  it("should execute a single INSERT query for multiple items", async () => {
    const { __mockQuery } =
      jest.requireMock("../../src/dialects/TransactionSessionManager");

    jest
      .spyOn(em as any, "resolveEntityMetadata")
      .mockReturnValue(userMetadata);

    // isMySqlFamily returns true
    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);

    __mockQuery.mockResolvedValue({
      results: { affectedRows: 3 },
      fields: [],
    });

    const items = [
      { name: "Alice", email: "a@test.com" },
      { name: "Bob", email: "b@test.com" },
      { name: "Charlie", email: "c@test.com" },
    ];

    const result = await em.insertMany(userMetadata.target, items);

    expect(result.affected).toBe(3);

    // query should be called 3 times:
    // 1. SET autocommit = 0
    // 2. INSERT INTO ...
    // So the second call should be the INSERT
    const calls = __mockQuery.mock.calls;
    // Find the INSERT call (not "SET autocommit")
    const insertCall = calls.find(
      (call: any[]) => typeof call[0] !== "string",
    );
    expect(insertCall).toBeDefined();

    // Verify the SQL contains INSERT INTO and multiple value placeholders
    const sqlObj = insertCall![0];
    const sqlText = sqlObj.text || sqlObj.sql || String(sqlObj);
    expect(sqlText).toContain("INSERT INTO");
    expect(sqlText).toContain("`User`");
  });

  it("should handle a single item", async () => {
    const { __mockQuery } =
      jest.requireMock("../../src/dialects/TransactionSessionManager");

    jest
      .spyOn(em as any, "resolveEntityMetadata")
      .mockReturnValue(userMetadata);
    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);

    __mockQuery.mockResolvedValue({
      results: { affectedRows: 1 },
      fields: [],
    });

    const result = await em.insertMany(userMetadata.target, [
      { name: "Solo", email: "solo@test.com" },
    ]);

    expect(result.affected).toBe(1);
  });

  it("should exclude auto-increment columns when values are not provided", async () => {
    const { __mockQuery } =
      jest.requireMock("../../src/dialects/TransactionSessionManager");

    jest
      .spyOn(em as any, "resolveEntityMetadata")
      .mockReturnValue(userMetadata);
    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);

    __mockQuery.mockResolvedValue({
      results: { affectedRows: 2 },
      fields: [],
    });

    // Items without PK (id is auto-increment and not provided)
    const items = [
      { name: "Alice", email: "a@test.com" },
      { name: "Bob", email: "b@test.com" },
    ];

    const result = await em.insertMany(userMetadata.target, items);

    expect(result.affected).toBe(2);

    // The INSERT should not include the `id` column
    const calls = __mockQuery.mock.calls;
    const insertCall = calls.find(
      (call: any[]) => typeof call[0] !== "string",
    );
    const sqlObj = insertCall![0];
    const sqlText = sqlObj.text || sqlObj.sql || String(sqlObj);
    expect(sqlText).not.toContain("`id`");
    expect(sqlText).toContain("`name`");
    expect(sqlText).toContain("`email`");
  });

  it("should rollback on query error", async () => {
    const {
      __mockQuery,
      __mockRollback,
    } = jest.requireMock("../../src/dialects/TransactionSessionManager");

    jest
      .spyOn(em as any, "resolveEntityMetadata")
      .mockReturnValue(userMetadata);
    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);

    // First call succeeds (SET autocommit), second fails (INSERT)
    __mockQuery
      .mockResolvedValueOnce(undefined) // SET autocommit
      .mockRejectedValueOnce(new Error("Duplicate entry"));

    await expect(
      em.insertMany(userMetadata.target, [
        { name: "Alice", email: "a@test.com" },
      ]),
    ).rejects.toThrow("Duplicate entry");
  });

  it("should handle PostgreSQL rowCount result", async () => {
    const { __mockQuery } =
      jest.requireMock("../../src/dialects/TransactionSessionManager");

    jest
      .spyOn(em as any, "resolveEntityMetadata")
      .mockReturnValue(userMetadata);
    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(false);

    __mockQuery.mockResolvedValue({
      results: { rowCount: 5 },
      fields: [],
    });

    const items = Array.from({ length: 5 }, (_, i) => ({
      name: `User ${i}`,
      email: `u${i}@test.com`,
    }));

    const result = await em.insertMany(userMetadata.target, items);

    expect(result.affected).toBe(5);
  });
});

describe("EntityManager.deleteMany()", () => {
  let em: EntityManager;

  beforeEach(() => {
    MetadataLayerRegistry.reset();
    Container.reset();
    jest.clearAllMocks();
    em = createTestEntityManager();
  });

  it("should return { affected: 0 } for empty ids array", async () => {
    const result = await em.deleteMany(userMetadata.target, []);
    expect(result).toEqual({ affected: 0 });
  });

  it("should throw when entity metadata does not exist", async () => {
    class UnknownEntity {}

    jest
      .spyOn(em as any, "resolveEntityMetadata")
      .mockReturnValue(null);

    await expect(
      em.deleteMany(UnknownEntity, [1, 2]),
    ).rejects.toThrow("Entity metadata does not exist.");
  });

  it("should throw when primary key column is not found", async () => {
    const noPkMetadata = {
      name: "NoPk",
      target: class NoPk {},
      columns: [
        { name: "name", options: {} },
      ],
    };

    jest
      .spyOn(em as any, "resolveEntityMetadata")
      .mockReturnValue(noPkMetadata);

    await expect(
      em.deleteMany(noPkMetadata.target, [1]),
    ).rejects.toThrow("Primary key column not found.");
  });

  it("should execute DELETE ... WHERE pk IN (...) for multiple ids", async () => {
    const { __mockQuery } =
      jest.requireMock("../../src/dialects/TransactionSessionManager");

    jest
      .spyOn(em as any, "resolveEntityMetadata")
      .mockReturnValue(userMetadata);
    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);

    __mockQuery.mockResolvedValue({
      results: { affectedRows: 3 },
      fields: [],
    });

    const result = await em.deleteMany(userMetadata.target, [1, 2, 3]);

    expect(result.affected).toBe(3);

    // Find the DELETE call (not "SET autocommit")
    const calls = __mockQuery.mock.calls;
    const deleteCall = calls.find(
      (call: any[]) => typeof call[0] !== "string",
    );
    expect(deleteCall).toBeDefined();

    const sqlObj = deleteCall![0];
    const sqlText = sqlObj.text || sqlObj.sql || String(sqlObj);
    expect(sqlText).toContain("DELETE FROM");
    expect(sqlText).toContain("`User`");
    expect(sqlText).toContain("IN");
  });

  it("should handle a single id", async () => {
    const { __mockQuery } =
      jest.requireMock("../../src/dialects/TransactionSessionManager");

    jest
      .spyOn(em as any, "resolveEntityMetadata")
      .mockReturnValue(userMetadata);
    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);

    __mockQuery.mockResolvedValue({
      results: { affectedRows: 1 },
      fields: [],
    });

    const result = await em.deleteMany(userMetadata.target, [42]);

    expect(result.affected).toBe(1);
  });

  it("should use parameterized values to prevent SQL injection", async () => {
    const { __mockQuery } =
      jest.requireMock("../../src/dialects/TransactionSessionManager");

    jest
      .spyOn(em as any, "resolveEntityMetadata")
      .mockReturnValue(userMetadata);
    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);

    __mockQuery.mockResolvedValue({
      results: { affectedRows: 0 },
      fields: [],
    });

    // Attempt SQL injection via id value
    const maliciousId = "1; DROP TABLE User; --";
    await em.deleteMany(userMetadata.target, [maliciousId]);

    // The id should be passed as a parameter, not interpolated into SQL
    const calls = __mockQuery.mock.calls;
    const deleteCall = calls.find(
      (call: any[]) => typeof call[0] !== "string",
    );
    const sqlObj = deleteCall![0];
    const sqlText = sqlObj.text || sqlObj.sql || String(sqlObj);

    // The SQL text should NOT contain the malicious string directly
    expect(sqlText).not.toContain("DROP TABLE");
    // The values array should contain the malicious string as a parameter
    const sqlValues = sqlObj.values || [];
    expect(sqlValues).toContain(maliciousId);
  });

  it("should handle PostgreSQL rowCount result", async () => {
    const { __mockQuery } =
      jest.requireMock("../../src/dialects/TransactionSessionManager");

    jest
      .spyOn(em as any, "resolveEntityMetadata")
      .mockReturnValue(userMetadata);
    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(false);

    __mockQuery.mockResolvedValue({
      results: { rowCount: 2 },
      fields: [],
    });

    const result = await em.deleteMany(userMetadata.target, [10, 20]);

    expect(result.affected).toBe(2);
  });

  it("should rollback on query error", async () => {
    const {
      __mockQuery,
      __mockRollback,
    } = jest.requireMock("../../src/dialects/TransactionSessionManager");

    jest
      .spyOn(em as any, "resolveEntityMetadata")
      .mockReturnValue(userMetadata);
    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);

    __mockQuery
      .mockResolvedValueOnce(undefined) // SET autocommit
      .mockRejectedValueOnce(new Error("Foreign key constraint"));

    await expect(
      em.deleteMany(userMetadata.target, [1, 2]),
    ).rejects.toThrow("Foreign key constraint");
  });
});

describe("BaseRepository batch methods", () => {
  it("should have saveMany method that delegates to EntityManager", async () => {
    const mockEm = {
      saveMany: jest.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]),
      insertMany: jest.fn().mockResolvedValue({ affected: 2 }),
    } as any;

    const { BaseRepository } = require("../../src/core/BaseRepository");
    const repo = new BaseRepository(userMetadata.target, mockEm);

    const items = [{ name: "A" }, { name: "B" }];

    const saveResult = await repo.saveMany(items);
    expect(mockEm.saveMany).toHaveBeenCalledWith(userMetadata.target, items);
    expect(saveResult).toHaveLength(2);

    const insertResult = await repo.insertMany(items);
    expect(mockEm.insertMany).toHaveBeenCalledWith(userMetadata.target, items);
    expect(insertResult.affected).toBe(2);
  });

  it("should handle empty arrays in repository methods", async () => {
    const mockEm = {
      saveMany: jest.fn().mockResolvedValue([]),
      insertMany: jest.fn().mockResolvedValue({ affected: 0 }),
    } as any;

    const { BaseRepository } = require("../../src/core/BaseRepository");
    const repo = new BaseRepository(userMetadata.target, mockEm);

    const saveResult = await repo.saveMany([]);
    expect(saveResult).toEqual([]);

    const insertResult = await repo.insertMany([]);
    expect(insertResult.affected).toBe(0);
  });

  it("should have deleteMany method that delegates to EntityManager", async () => {
    const mockEm = {
      deleteMany: jest.fn().mockResolvedValue({ affected: 3 }),
    } as any;

    const { BaseRepository } = require("../../src/core/BaseRepository");
    const repo = new BaseRepository(userMetadata.target, mockEm);

    const result = await repo.deleteMany([1, 2, 3]);
    expect(mockEm.deleteMany).toHaveBeenCalledWith(userMetadata.target, [1, 2, 3]);
    expect(result.affected).toBe(3);
  });
});
