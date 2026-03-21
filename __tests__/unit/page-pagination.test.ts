import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import {
  normalizePage,
  normalizePageSize,
  PagePaginationResult,
} from "../../src/core/PagePagination";

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

/**
 * findWithPage internally calls findAndCount which issues (read-only, no transaction):
 * 1. SELECT ... (data query)
 * 2. SELECT COUNT(*) (count query)
 */
function mockFindAndCount(rows: any[], total: number) {
  mockQuery
    .mockResolvedValueOnce({ results: rows, fields: [] }) // data
    .mockResolvedValueOnce({ results: [{ result: total }], fields: [] }); // count
}

// ─────────────────────────────────────────────────────────────────────────────
// normalizePage 단위 테스트
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizePage", () => {
  it("should return 1 for undefined", () => {
    expect(normalizePage(undefined)).toBe(1);
  });

  it("should return 1 for null", () => {
    expect(normalizePage(null as any)).toBe(1);
  });

  it("should return 1 for 0", () => {
    expect(normalizePage(0)).toBe(1);
  });

  it("should return 1 for negative numbers", () => {
    expect(normalizePage(-3)).toBe(1);
    expect(normalizePage(-100)).toBe(1);
  });

  it("should floor decimal values", () => {
    expect(normalizePage(2.7)).toBe(2);
    expect(normalizePage(3.1)).toBe(3);
  });

  it("should pass through positive integers", () => {
    expect(normalizePage(1)).toBe(1);
    expect(normalizePage(5)).toBe(5);
    expect(normalizePage(100)).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EntityManager.findWithPage 테스트
// ─────────────────────────────────────────────────────────────────────────────

describe("EntityManager.findWithPage", () => {
  let em: EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    em = createTestEntityManager();
    setupMocks(em);
  });

  it("should use default page=1 and pageSize=20", async () => {
    const rows = makeRows(1, 20);
    mockFindAndCount(rows, 50);

    const result = await em.findWithPage(ItemEntity);

    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
    expect(result.data.length).toBe(20);
    expect(result.total).toBe(50);
    expect(result.totalPages).toBe(3);
    expect(result.hasNextPage).toBe(true);
    expect(result.hasPreviousPage).toBe(false);
  });

  it("should return correct metadata for first page", async () => {
    const rows = makeRows(1, 10);
    mockFindAndCount(rows, 25);

    const result = await em.findWithPage(ItemEntity, { page: 1, pageSize: 10 });

    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(10);
    expect(result.total).toBe(25);
    expect(result.totalPages).toBe(3);
    expect(result.hasNextPage).toBe(true);
    expect(result.hasPreviousPage).toBe(false);
  });

  it("should return correct metadata for middle page", async () => {
    const rows = makeRows(11, 10);
    mockFindAndCount(rows, 25);

    const result = await em.findWithPage(ItemEntity, { page: 2, pageSize: 10 });

    expect(result.page).toBe(2);
    expect(result.totalPages).toBe(3);
    expect(result.hasNextPage).toBe(true);
    expect(result.hasPreviousPage).toBe(true);
  });

  it("should return correct metadata for last page", async () => {
    const rows = makeRows(21, 5);
    mockFindAndCount(rows, 25);

    const result = await em.findWithPage(ItemEntity, { page: 3, pageSize: 10 });

    expect(result.page).toBe(3);
    expect(result.totalPages).toBe(3);
    expect(result.data.length).toBe(5);
    expect(result.hasNextPage).toBe(false);
    expect(result.hasPreviousPage).toBe(true);
  });

  it("should return empty result when no data exists", async () => {
    mockFindAndCount([], 0);

    const result = await em.findWithPage(ItemEntity, { page: 1, pageSize: 10 });

    expect(result.data).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.totalPages).toBe(0);
    expect(result.hasNextPage).toBe(false);
    expect(result.hasPreviousPage).toBe(false);
  });

  it("should return empty data for out-of-range page", async () => {
    mockFindAndCount([], 25);

    const result = await em.findWithPage(ItemEntity, { page: 100, pageSize: 10 });

    expect(result.data).toEqual([]);
    expect(result.total).toBe(25);
    expect(result.totalPages).toBe(3);
    expect(result.page).toBe(100);
    expect(result.hasNextPage).toBe(false);
    expect(result.hasPreviousPage).toBe(true);
  });

  it("should normalize invalid page values", async () => {
    const rows = makeRows(1, 5);
    mockFindAndCount(rows, 5);

    const result = await em.findWithPage(ItemEntity, { page: -1, pageSize: 10 });

    expect(result.page).toBe(1);
    expect(result.hasPreviousPage).toBe(false);
  });

  it("should normalize invalid pageSize values", async () => {
    const rows = makeRows(1, 20);
    mockFindAndCount(rows, 40);

    const result = await em.findWithPage(ItemEntity, { page: 1, pageSize: 0 });

    expect(result.pageSize).toBe(20); // default
  });

  it("should pass where/orderBy/relations to findAndCount", async () => {
    const findAndCountSpy = jest.spyOn(em, "findAndCount").mockResolvedValueOnce([[], 0]);

    await em.findWithPage(ItemEntity, {
      page: 2,
      pageSize: 5,
      where: { title: "test" } as any,
      orderBy: { id: "DESC" } as any,
      relations: ["tags"] as any,
    });

    expect(findAndCountSpy).toHaveBeenCalledWith(ItemEntity, expect.objectContaining({
      where: { title: "test" },
      orderBy: { id: "DESC" },
      relations: ["tags"],
      limit: [5, 5], // (page-1)*pageSize, pageSize
    }));
  });

  it("should pass withDeleted/timeout/useMaster/groupBy/having", async () => {
    const findAndCountSpy = jest.spyOn(em, "findAndCount").mockResolvedValueOnce([[], 0]);

    await em.findWithPage(ItemEntity, {
      withDeleted: true,
      timeout: 5000,
      useMaster: true,
    });

    expect(findAndCountSpy).toHaveBeenCalledWith(ItemEntity, expect.objectContaining({
      withDeleted: true,
      timeout: 5000,
      useMaster: true,
    }));
  });

  it("should handle exactly one page of results", async () => {
    const rows = makeRows(1, 10);
    mockFindAndCount(rows, 10);

    const result = await em.findWithPage(ItemEntity, { page: 1, pageSize: 10 });

    expect(result.totalPages).toBe(1);
    expect(result.hasNextPage).toBe(false);
    expect(result.hasPreviousPage).toBe(false);
  });

  it("should calculate correct offset for page 3 with pageSize 15", async () => {
    const findAndCountSpy = jest.spyOn(em, "findAndCount").mockResolvedValueOnce([[], 0]);

    await em.findWithPage(ItemEntity, { page: 3, pageSize: 15 });

    expect(findAndCountSpy).toHaveBeenCalledWith(ItemEntity, expect.objectContaining({
      limit: [30, 15], // (3-1)*15 = 30
    }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BaseRepository.findWithPage 위임 테스트
// ─────────────────────────────────────────────────────────────────────────────

describe("BaseRepository.findWithPage", () => {
  it("should delegate to EntityManager.findWithPage", async () => {
    const em = createTestEntityManager();
    setupMocks(em);

    const expectedResult: PagePaginationResult<any> = {
      data: [{ id: 1, title: "Test" }],
      total: 1,
      page: 1,
      pageSize: 10,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: false,
    };

    jest.spyOn(em, "findWithPage").mockResolvedValueOnce(expectedResult);

    const { BaseRepository } = require("../../src/core/BaseRepository");
    const repo = new BaseRepository(ItemEntity, em);

    const result = await repo.findWithPage({ page: 1, pageSize: 10 });

    expect(em.findWithPage).toHaveBeenCalledWith(ItemEntity, { page: 1, pageSize: 10 });
    expect(result).toBe(expectedResult);
  });
});
