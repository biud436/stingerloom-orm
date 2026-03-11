import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import {
  encodeCursor,
  decodeCursor,
  normalizePageSize,
  CursorPaginationResult,
} from "../../src/core/CursorPagination";

// ─────────────────────────────────────────────────────────────────────────────
// Mock 설정
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// 헬퍼
// ─────────────────────────────────────────────────────────────────────────────

function createTestEntityManager() {
  const em = new EntityManager();
  (em as any).driver = {
    wrap: (name: string) => `\`${name}\``,
  };
  return em;
}

const ItemEntity = class Item {} as any;

const itemMetadata = {
  name: "Item",
  target: ItemEntity,
  columns: [
    { name: "id", options: { primary: true, autoIncrement: true } },
    { name: "title", options: {} },
    { name: "createdAt", options: {} },
  ],
};

function setupMocks(em: EntityManager): void {
  jest.spyOn((em as any).resolver, "resolveEntityMetadata").mockReturnValue(itemMetadata);
  jest.spyOn((em as any).resolver, "getDeletedAtColumn").mockReturnValue(null);
}

function makeRows(start: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: start + i,
    title: `Item ${start + i}`,
    createdAt: `2024-01-${String(start + i).padStart(2, "0")}`,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 커서 유틸리티 단위 테스트
// ─────────────────────────────────────────────────────────────────────────────

describe("CursorPagination utilities", () => {
  describe("encodeCursor / decodeCursor", () => {
    it("should encode and decode numeric values", () => {
      const encoded = encodeCursor(42);
      const decoded = decodeCursor(encoded);
      expect(decoded).toBe(42);
    });

    it("should encode and decode string values", () => {
      const encoded = encodeCursor("abc-123");
      const decoded = decodeCursor(encoded);
      expect(decoded).toBe("abc-123");
    });

    it("should encode and decode null values", () => {
      const encoded = encodeCursor(null);
      const decoded = decodeCursor(encoded);
      expect(decoded).toBeNull();
    });

    it("should produce a valid Base64 string", () => {
      const encoded = encodeCursor(100);
      expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/);
    });

    it("should return null for invalid cursor", () => {
      expect(decodeCursor("not-valid-base64!!!")).toBeNull();
    });

    it("should return null for empty string", () => {
      expect(decodeCursor("")).toBeNull();
    });

    it("should handle date string values", () => {
      const dateStr = "2024-01-15T10:30:00Z";
      const encoded = encodeCursor(dateStr);
      expect(decodeCursor(encoded)).toBe(dateStr);
    });

    it("should produce different cursors for different values", () => {
      const c1 = encodeCursor(1);
      const c2 = encodeCursor(2);
      expect(c1).not.toBe(c2);
    });
  });

  describe("normalizePageSize", () => {
    it("should return default (20) for undefined", () => {
      expect(normalizePageSize(undefined)).toBe(20);
    });

    it("should return default (20) for 0", () => {
      expect(normalizePageSize(0)).toBe(20);
    });

    it("should return default (20) for negative numbers", () => {
      expect(normalizePageSize(-5)).toBe(20);
    });

    it("should return the given value for positive numbers", () => {
      expect(normalizePageSize(10)).toBe(10);
      expect(normalizePageSize(50)).toBe(50);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EntityManager.findWithCursor 통합 테스트
// ─────────────────────────────────────────────────────────────────────────────

describe("EntityManager.findWithCursor", () => {
  let em: EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    em = createTestEntityManager();
    setupMocks(em);
  });

  it("should return empty result when no rows exist", async () => {
    mockQuery
      .mockResolvedValueOnce(undefined) // SET autocommit = 0
      .mockResolvedValueOnce({ results: [], fields: [] });

    const result = await em.findWithCursor(ItemEntity);

    expect(result.data).toEqual([]);
    expect(result.hasNextPage).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(result.count).toBe(0);
  });

  it("should return data with hasNextPage=false when results <= take", async () => {
    const rows = makeRows(1, 3);
    mockQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ results: rows, fields: [] });

    const result = await em.findWithCursor(ItemEntity, { take: 5 });

    expect(result.data.length).toBe(3);
    expect(result.hasNextPage).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(result.count).toBe(3);
  });

  it("should return hasNextPage=true and nextCursor when more results exist", async () => {
    // take=3 -> query fetches 4 -> 4 returned -> hasNextPage=true
    const rows = makeRows(1, 4);
    mockQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ results: rows, fields: [] });

    const result = await em.findWithCursor(ItemEntity, { take: 3 });

    expect(result.data.length).toBe(3);
    expect(result.hasNextPage).toBe(true);
    expect(result.nextCursor).not.toBeNull();
    expect(result.count).toBe(3);
  });

  it("should use default take of 20 when not specified", async () => {
    const rows = makeRows(1, 21); // 21 = default 20 + 1
    mockQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ results: rows, fields: [] });

    const result = await em.findWithCursor(ItemEntity);

    expect(result.data.length).toBe(20);
    expect(result.hasNextPage).toBe(true);
  });

  it("should generate correct nextCursor from last item", async () => {
    const rows = makeRows(10, 4); // id: 10, 11, 12, 13
    mockQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ results: rows, fields: [] });

    const result = await em.findWithCursor(ItemEntity, {
      take: 3,
      orderBy: "id",
    });

    // nextCursor encodes last item's id (12, since 13 is the extra)
    expect(result.nextCursor).toBe(encodeCursor(12));
  });

  it("should decode cursor and use it in WHERE condition", async () => {
    const cursor = encodeCursor(5);
    const rows = makeRows(6, 3);
    mockQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ results: rows, fields: [] });

    const result = await em.findWithCursor(ItemEntity, {
      take: 5,
      cursor,
      orderBy: "id",
    });

    expect(result.data.length).toBe(3);
    // SQL should contain > operator for ASC direction
    const sqlCall = mockQuery.mock.calls[1][0];
    const sqlText = sqlCall.sql ?? sqlCall.text ?? String(sqlCall);
    expect(sqlText).toContain(">");
  });

  it("should throw on invalid cursor", async () => {
    await expect(
      em.findWithCursor(ItemEntity, { cursor: "invalid!!!" }),
    ).rejects.toThrow("Invalid cursor value");
  });

  it("should support DESC direction", async () => {
    const rows = makeRows(7, 4);
    mockQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ results: rows, fields: [] });

    const result = await em.findWithCursor(ItemEntity, {
      take: 3,
      direction: "DESC",
      orderBy: "id",
    });

    expect(result.data.length).toBe(3);
    expect(result.hasNextPage).toBe(true);

    const sqlCall = mockQuery.mock.calls[1][0];
    const sqlText = sqlCall.sql ?? sqlCall.text ?? String(sqlCall);
    expect(sqlText).toContain("DESC");
  });

  it("should use < operator for DESC with cursor", async () => {
    const cursor = encodeCursor(100);
    const rows = makeRows(90, 3);
    mockQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ results: rows, fields: [] });

    await em.findWithCursor(ItemEntity, {
      take: 5,
      cursor,
      direction: "DESC",
      orderBy: "id",
    });

    const sqlCall = mockQuery.mock.calls[1][0];
    const sqlText = sqlCall.sql ?? sqlCall.text ?? String(sqlCall);
    expect(sqlText).toContain("<");
  });

  it("should support where condition alongside cursor", async () => {
    const rows = makeRows(1, 2);
    mockQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ results: rows, fields: [] });

    await em.findWithCursor(ItemEntity, {
      take: 5,
      where: { title: "Item 1" } as any,
    });

    const sqlCall = mockQuery.mock.calls[1][0];
    const sqlText = sqlCall.sql ?? sqlCall.text ?? String(sqlCall);
    expect(sqlText).toContain("`title`");
  });

  it("should use PK as default orderBy when not specified", async () => {
    const rows = makeRows(1, 2);
    mockQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ results: rows, fields: [] });

    await em.findWithCursor(ItemEntity, { take: 5 });

    const sqlCall = mockQuery.mock.calls[1][0];
    const sqlText = sqlCall.sql ?? sqlCall.text ?? String(sqlCall);
    expect(sqlText).toContain("`id`");
    expect(sqlText).toContain("ASC");
  });

  it("should support custom orderBy column", async () => {
    const rows = makeRows(1, 2);
    mockQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ results: rows, fields: [] });

    await em.findWithCursor(ItemEntity, {
      take: 5,
      orderBy: "createdAt",
    });

    const sqlCall = mockQuery.mock.calls[1][0];
    const sqlText = sqlCall.sql ?? sqlCall.text ?? String(sqlCall);
    expect(sqlText).toContain("`createdAt`");
  });

  it("should rollback on query error", async () => {
    mockQuery
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("DB error"));

    await expect(
      em.findWithCursor(ItemEntity, { take: 5 }),
    ).rejects.toThrow("DB error");

    expect(mockRollback).toHaveBeenCalled();
  });

  it("should throw for unknown entity", async () => {
    const UnknownEntity = class Unknown {} as any;
    // Override the mock to return null for unknown entity
    jest.spyOn((em as any).resolver, "resolveEntityMetadata").mockReturnValue(null);

    await expect(
      em.findWithCursor(UnknownEntity),
    ).rejects.toThrow();
  });

  it("should return exactly take items when results equal take+1", async () => {
    const rows = makeRows(1, 6); // take=5, query fetches 6
    mockQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ results: rows, fields: [] });

    const result = await em.findWithCursor(ItemEntity, { take: 5 });

    expect(result.data.length).toBe(5);
    expect(result.hasNextPage).toBe(true);
    // The 6th item should NOT be in the result
    const ids = result.data.map((d: any) => d.id);
    expect(ids).not.toContain(6);
  });

  it("should return hasNextPage=false when results exactly equal take", async () => {
    const rows = makeRows(1, 5); // exactly take=5, no extra
    mockQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ results: rows, fields: [] });

    const result = await em.findWithCursor(ItemEntity, { take: 5 });

    expect(result.data.length).toBe(5);
    expect(result.hasNextPage).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it("should handle null results gracefully", async () => {
    mockQuery
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ results: null, fields: [] });

    const result = await em.findWithCursor(ItemEntity);

    expect(result.data).toEqual([]);
    expect(result.hasNextPage).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(result.count).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BaseRepository.findWithCursor 위임 테스트
// ─────────────────────────────────────────────────────────────────────────────

describe("BaseRepository.findWithCursor", () => {
  it("should delegate to EntityManager.findWithCursor", async () => {
    const em = createTestEntityManager();
    setupMocks(em);

    const expectedResult: CursorPaginationResult<any> = {
      data: [{ id: 1, title: "Test" }],
      hasNextPage: false,
      nextCursor: null,
      count: 1,
    };

    jest.spyOn(em, "findWithCursor").mockResolvedValueOnce(expectedResult);

    const { BaseRepository } = require("../../src/core/BaseRepository");
    const repo = new BaseRepository(ItemEntity, em);

    const result = await repo.findWithCursor({ take: 10 });

    expect(em.findWithCursor).toHaveBeenCalledWith(ItemEntity, { take: 10 });
    expect(result).toBe(expectedResult);
  });
});
