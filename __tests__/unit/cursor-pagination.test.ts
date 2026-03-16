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
      .mockResolvedValueOnce({ results: rows, fields: [] });

    const result = await em.findWithCursor(ItemEntity);

    expect(result.data.length).toBe(20);
    expect(result.hasNextPage).toBe(true);
  });

  it("should generate correct nextCursor from last item", async () => {
    const rows = makeRows(10, 4); // id: 10, 11, 12, 13
    mockQuery
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
      .mockResolvedValueOnce({ results: rows, fields: [] });

    const result = await em.findWithCursor(ItemEntity, {
      take: 5,
      cursor,
      orderBy: "id",
    });

    expect(result.data.length).toBe(3);
    // SQL should contain > operator for ASC direction
    const sqlCall = mockQuery.mock.calls[0][0];
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
      .mockResolvedValueOnce({ results: rows, fields: [] });

    const result = await em.findWithCursor(ItemEntity, {
      take: 3,
      direction: "DESC",
      orderBy: "id",
    });

    expect(result.data.length).toBe(3);
    expect(result.hasNextPage).toBe(true);

    const sqlCall = mockQuery.mock.calls[0][0];
    const sqlText = sqlCall.sql ?? sqlCall.text ?? String(sqlCall);
    expect(sqlText).toContain("DESC");
  });

  it("should use < operator for DESC with cursor", async () => {
    const cursor = encodeCursor(100);
    const rows = makeRows(90, 3);
    mockQuery
      .mockResolvedValueOnce({ results: rows, fields: [] });

    await em.findWithCursor(ItemEntity, {
      take: 5,
      cursor,
      direction: "DESC",
      orderBy: "id",
    });

    const sqlCall = mockQuery.mock.calls[0][0];
    const sqlText = sqlCall.sql ?? sqlCall.text ?? String(sqlCall);
    expect(sqlText).toContain("<");
  });

  it("should support where condition alongside cursor", async () => {
    const rows = makeRows(1, 2);
    mockQuery
      .mockResolvedValueOnce({ results: rows, fields: [] });

    await em.findWithCursor(ItemEntity, {
      take: 5,
      where: { title: "Item 1" } as any,
    });

    const sqlCall = mockQuery.mock.calls[0][0];
    const sqlText = sqlCall.sql ?? sqlCall.text ?? String(sqlCall);
    expect(sqlText).toContain("`title`");
  });

  it("should use PK as default orderBy when not specified", async () => {
    const rows = makeRows(1, 2);
    mockQuery
      .mockResolvedValueOnce({ results: rows, fields: [] });

    await em.findWithCursor(ItemEntity, { take: 5 });

    const sqlCall = mockQuery.mock.calls[0][0];
    const sqlText = sqlCall.sql ?? sqlCall.text ?? String(sqlCall);
    expect(sqlText).toContain("`id`");
    expect(sqlText).toContain("ASC");
  });

  it("should support custom orderBy column", async () => {
    const rows = makeRows(1, 2);
    mockQuery
      .mockResolvedValueOnce({ results: rows, fields: [] });

    await em.findWithCursor(ItemEntity, {
      take: 5,
      orderBy: "createdAt",
    });

    const sqlCall = mockQuery.mock.calls[0][0];
    const sqlText = sqlCall.sql ?? sqlCall.text ?? String(sqlCall);
    expect(sqlText).toContain("`createdAt`");
  });

  it("should close session on query error (read-only: no rollback)", async () => {
    mockQuery
      .mockRejectedValueOnce(new Error("DB error"));

    await expect(
      em.findWithCursor(ItemEntity, { take: 5 }),
    ).rejects.toThrow("DB error");

    expect(mockRollback).not.toHaveBeenCalled();
    expect(mockClose).toHaveBeenCalled();
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
      .mockResolvedValueOnce({ results: rows, fields: [] });

    const result = await em.findWithCursor(ItemEntity, { take: 5 });

    expect(result.data.length).toBe(5);
    expect(result.hasNextPage).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it("should handle null results gracefully", async () => {
    mockQuery
      .mockResolvedValueOnce({ results: null, fields: [] });

    const result = await em.findWithCursor(ItemEntity);

    expect(result.data).toEqual([]);
    expect(result.hasNextPage).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(result.count).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UUID PK 커서 페이지네이션 테스트
// ─────────────────────────────────────────────────────────────────────────────

const UuidEntity = class UuidItem {} as any;

const uuidMetadata = {
  name: "UuidItem",
  target: UuidEntity,
  columns: [
    { name: "id", options: { primary: true, type: "varchar" } },
    { name: "title", options: {} },
    { name: "createdAt", options: {} },
  ],
};

function setupUuidMocks(em: EntityManager): void {
  jest.spyOn((em as any).resolver, "resolveEntityMetadata").mockReturnValue(uuidMetadata);
  jest.spyOn((em as any).resolver, "getDeletedAtColumn").mockReturnValue(null);
}

/** 정렬된 UUID v4 목록 생성 (사전순) */
function makeSortedUuids(count: number): string[] {
  const uuids = [
    "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d",
    "1b2c3d4e-5f6a-4b7c-9d8e-9f0a1b2c3d4e",
    "2c3d4e5f-6a7b-4c8d-ae9f-0a1b2c3d4e5f",
    "3d4e5f6a-7b8c-4d9e-bf0a-1b2c3d4e5f6a",
    "4e5f6a7b-8c9d-4eaf-c01b-2c3d4e5f6a7b",
    "5f6a7b8c-9dae-4fb0-d12c-3d4e5f6a7b8c",
    "6a7b8c9d-aebf-40c1-e23d-4e5f6a7b8c9d",
    "7b8c9dae-bfc0-41d2-f34e-5f6a7b8c9dae",
    "8c9daebf-c0d1-42e3-a45f-6a7b8c9daebf",
    "9daebfc0-d1e2-43f4-b560-7b8c9daebfc0",
  ];
  return uuids.slice(0, count);
}

function makeUuidRows(uuids: string[]) {
  return uuids.map((id, i) => ({
    id,
    title: `Item ${i + 1}`,
    createdAt: `2024-01-${String(i + 1).padStart(2, "0")}`,
  }));
}

describe("UUID PK cursor pagination", () => {
  let em: EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    em = createTestEntityManager();
    setupUuidMocks(em);
  });

  it("should encode and decode UUID cursor values correctly", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const encoded = encodeCursor(uuid);
    const decoded = decodeCursor(encoded);
    expect(decoded).toBe(uuid);
  });

  it("should return first page with UUID PKs", async () => {
    const uuids = makeSortedUuids(4);
    const rows = makeUuidRows(uuids);
    mockQuery
      .mockResolvedValueOnce({ results: rows, fields: [] });

    const result = await em.findWithCursor(UuidEntity, { take: 3 });

    expect(result.data.length).toBe(3);
    expect(result.hasNextPage).toBe(true);
    expect(result.nextCursor).not.toBeNull();
    // nextCursor should encode the 3rd UUID (index 2)
    expect(result.nextCursor).toBe(encodeCursor(uuids[2]));
  });

  it("should generate > operator with UUID cursor for ASC", async () => {
    const uuids = makeSortedUuids(3);
    const cursor = encodeCursor(uuids[0]);
    const rows = makeUuidRows(uuids.slice(1));
    mockQuery
      .mockResolvedValueOnce({ results: rows, fields: [] });

    await em.findWithCursor(UuidEntity, {
      take: 5,
      cursor,
      orderBy: "id",
    });

    const sqlCall = mockQuery.mock.calls[0][0];
    const sqlText = sqlCall.sql ?? sqlCall.text ?? String(sqlCall);
    expect(sqlText).toContain(">");
  });

  it("should generate < operator with UUID cursor for DESC", async () => {
    const uuids = makeSortedUuids(3);
    const cursor = encodeCursor(uuids[2]);
    const rows = makeUuidRows(uuids.slice(0, 2).reverse());
    mockQuery
      .mockResolvedValueOnce({ results: rows, fields: [] });

    await em.findWithCursor(UuidEntity, {
      take: 5,
      cursor,
      direction: "DESC",
      orderBy: "id",
    });

    const sqlCall = mockQuery.mock.calls[0][0];
    const sqlText = sqlCall.sql ?? sqlCall.text ?? String(sqlCall);
    expect(sqlText).toContain("<");
  });

  it("should pass UUID cursor as parameterized value (not interpolated)", async () => {
    const uuids = makeSortedUuids(3);
    const cursor = encodeCursor(uuids[0]);
    const rows = makeUuidRows(uuids.slice(1));
    mockQuery
      .mockResolvedValueOnce({ results: rows, fields: [] });

    await em.findWithCursor(UuidEntity, { take: 5, cursor, orderBy: "id" });

    const sqlCall = mockQuery.mock.calls[0][0];
    // UUID should be in the values array (parameterized), not inline in SQL
    const values = sqlCall.values ?? [];
    expect(values).toContain(uuids[0]);
    // SQL text should NOT contain the raw UUID string
    const sqlText = sqlCall.sql ?? sqlCall.text ?? String(sqlCall);
    expect(sqlText).not.toContain(uuids[0]);
  });

  it("should traverse multiple pages with UUID PKs", async () => {
    const allUuids = makeSortedUuids(7);

    // Page 1: take=3 → query 4, returns first 4
    const page1Rows = makeUuidRows(allUuids.slice(0, 4));
    mockQuery
      .mockResolvedValueOnce({ results: page1Rows, fields: [] });

    const page1 = await em.findWithCursor(UuidEntity, { take: 3 });
    expect(page1.data.length).toBe(3);
    expect(page1.hasNextPage).toBe(true);
    const cursor1 = page1.nextCursor!;
    expect(decodeCursor(cursor1)).toBe(allUuids[2]);

    // Page 2: cursor from page 1, take=3 → query 4, returns next 4
    jest.clearAllMocks();
    em = createTestEntityManager();
    setupUuidMocks(em);

    const page2Rows = makeUuidRows(allUuids.slice(3, 7));
    mockQuery
      .mockResolvedValueOnce({ results: page2Rows, fields: [] });

    const page2 = await em.findWithCursor(UuidEntity, {
      take: 3,
      cursor: cursor1,
    });
    expect(page2.data.length).toBe(3);
    expect(page2.hasNextPage).toBe(true);
    const cursor2 = page2.nextCursor!;
    expect(decodeCursor(cursor2)).toBe(allUuids[5]);

    // Page 3: last page, only 1 item left
    jest.clearAllMocks();
    em = createTestEntityManager();
    setupUuidMocks(em);

    const page3Rows = makeUuidRows(allUuids.slice(6));
    mockQuery
      .mockResolvedValueOnce({ results: page3Rows, fields: [] });

    const page3 = await em.findWithCursor(UuidEntity, {
      take: 3,
      cursor: cursor2,
    });
    expect(page3.data.length).toBe(1);
    expect(page3.hasNextPage).toBe(false);
    expect(page3.nextCursor).toBeNull();
  });

  it("should use createdAt as orderBy for meaningful UUID ordering", async () => {
    const uuids = makeSortedUuids(3);
    const rows = makeUuidRows(uuids);
    mockQuery
      .mockResolvedValueOnce({ results: rows, fields: [] });

    await em.findWithCursor(UuidEntity, {
      take: 5,
      orderBy: "createdAt",
    });

    const sqlCall = mockQuery.mock.calls[0][0];
    const sqlText = sqlCall.sql ?? sqlCall.text ?? String(sqlCall);
    expect(sqlText).toContain("`createdAt`");
    expect(sqlText).toContain("ORDER BY");
  });

  it("should support where condition with UUID cursor", async () => {
    const uuids = makeSortedUuids(2);
    const cursor = encodeCursor(uuids[0]);
    const rows = makeUuidRows(uuids.slice(1));
    mockQuery
      .mockResolvedValueOnce({ results: rows, fields: [] });

    await em.findWithCursor(UuidEntity, {
      take: 5,
      cursor,
      where: { title: "Item 2" } as any,
      orderBy: "id",
    });

    const sqlCall = mockQuery.mock.calls[0][0];
    const sqlText = sqlCall.sql ?? sqlCall.text ?? String(sqlCall);
    expect(sqlText).toContain(">");
    expect(sqlText).toContain("`title`");
  });

  it("should return empty result for UUID entity with no rows", async () => {
    mockQuery
      .mockResolvedValueOnce({ results: [], fields: [] });

    const result = await em.findWithCursor(UuidEntity);
    expect(result.data).toEqual([]);
    expect(result.hasNextPage).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(result.count).toBe(0);
  });

  it("should handle random UUID v4 values (non-sequential)", async () => {
    // UUID v4는 랜덤이므로 사전순 정렬 시 삽입 순서와 다를 수 있음
    const randomUuids = [
      "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "6ba7b810-9dad-41d9-80b4-00c04fd430c8",
      "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    ];
    // DB가 ORDER BY id ASC로 정렬하면 사전순: 6ba... < a0e... < f47...
    const sorted = [...randomUuids].sort();
    const rows = makeUuidRows(sorted);

    mockQuery
      .mockResolvedValueOnce({ results: rows, fields: [] });

    const result = await em.findWithCursor(UuidEntity, { take: 2 });

    expect(result.data.length).toBe(2);
    expect(result.hasNextPage).toBe(true);
    // cursor should be the 2nd item in sorted order
    expect(decodeCursor(result.nextCursor!)).toBe(sorted[1]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 비숫자형 PK 경고 테스트
// ─────────────────────────────────────────────────────────────────────────────

describe("Non-numeric PK cursor pagination warnings", () => {
  let em: EntityManager;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    // mockQuery에 기본 반환값 설정 — 경고 테스트에서는 쿼리 결과가 중요하지 않음
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ results: [], fields: [] });
    em = createTestEntityManager();
    warnSpy = jest.spyOn((em as any).logger, "warn");
  });

  function setupWithPkType(type: string) {
    const meta = {
      name: "TestEntity",
      target: UuidEntity,
      columns: [
        { name: "id", options: { primary: true, type } },
        { name: "title", options: {} },
      ],
    };
    jest.spyOn((em as any).resolver, "resolveEntityMetadata").mockReturnValue(meta);
    jest.spyOn((em as any).resolver, "getDeletedAtColumn").mockReturnValue(null);
  }

  it("should warn when PK is varchar and orderBy is not specified (MySQL)", async () => {
    (em as any).dbType = "mysql";
    setupWithPkType("varchar");

    await em.findWithCursor(UuidEntity);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("MySQL");
    expect(warnSpy.mock.calls[0][0]).toContain("VARCHAR");
    expect(warnSpy.mock.calls[0][0]).toContain("orderBy");
  });

  it("should warn when PK is varchar and orderBy is not specified (PostgreSQL)", async () => {
    (em as any).dbType = "postgres";
    setupWithPkType("varchar");

    await em.findWithCursor(UuidEntity);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("PostgreSQL");
    expect(warnSpy.mock.calls[0][0]).toContain("UUID v7");
  });

  it("should warn when PK is char (SQLite)", async () => {
    (em as any).dbType = "sqlite";
    setupWithPkType("char");

    await em.findWithCursor(UuidEntity);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("SQLite");
    expect(warnSpy.mock.calls[0][0]).toContain("INTEGER PK");
  });

  it("should warn when PK is text type", async () => {
    (em as any).dbType = "mysql";
    setupWithPkType("text");

    await em.findWithCursor(UuidEntity);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("non-numeric PK");
  });

  it("should NOT warn when PK is int", async () => {
    (em as any).dbType = "mysql";
    setupWithPkType("int");

    await em.findWithCursor(UuidEntity);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("should NOT warn when PK is bigint", async () => {
    (em as any).dbType = "postgres";
    setupWithPkType("bigint");

    await em.findWithCursor(UuidEntity);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("should NOT warn when explicit orderBy is provided", async () => {
    (em as any).dbType = "mysql";
    setupWithPkType("varchar");

    await em.findWithCursor(UuidEntity, { orderBy: "createdAt" as any });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("should warn only once per entity (dedup)", async () => {
    (em as any).dbType = "mysql";
    setupWithPkType("varchar");

    await em.findWithCursor(UuidEntity);
    await em.findWithCursor(UuidEntity);

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("should warn for MariaDB (same as MySQL)", async () => {
    (em as any).dbType = "mariadb";
    setupWithPkType("varchar");

    await em.findWithCursor(UuidEntity);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("MySQL");
  });

  it("should clear warning dedup set on propagateShutdown", async () => {
    (em as any).dbType = "mysql";
    setupWithPkType("varchar");

    await em.findWithCursor(UuidEntity);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    await em.propagateShutdown();
    warnSpy.mockClear();

    await em.findWithCursor(UuidEntity);
    expect(warnSpy).toHaveBeenCalledTimes(1);
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
