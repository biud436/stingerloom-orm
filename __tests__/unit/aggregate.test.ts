import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { TransactionSessionManager } from "../../src/dialects/TransactionSessionManager";
import { DatabaseClient } from "../../src/DatabaseClient";
import { EntityScanner } from "../../src/scanner";
// ScannerContainer is mocked below

/* eslint-disable @typescript-eslint/no-explicit-any */

// ─── Mock setup ────────────────────────────────────────────────

jest.mock("../../src/dialects/TransactionSessionManager");
jest.mock("../../src/DatabaseClient");

const MockTransactionSessionManager =
  TransactionSessionManager as jest.MockedClass<
    typeof TransactionSessionManager
  >;

// Product entity class
class Product {
  id!: number;
  name!: string;
  price!: number;
  quantity!: number;
}

// Common metadata (Product entity)
const productMetadata = {
  name: "Product",
  target: Product,
  columns: [
    { name: "id", options: { primary: true, autoIncrement: true } },
    { name: "name", options: {} },
    { name: "price", options: {} },
    { name: "quantity", options: {} },
  ],
};

// EntityScanner mock
const mockEntityScanner = {
  scan: jest.fn().mockReturnValue(productMetadata),
  makeEntities: jest.fn(),
};

// Mock getScannerInstance so it returns the EntityScanner mock
jest.mock("../../src/scanner/ScannerContainer", () => ({
  getScannerInstance: (cls: any) => {
    if (cls === EntityScanner) return mockEntityScanner as any;
    // Relation scanners (ManyToOne/OneToOne/...) are reached via
    // buildPropertyToColumnMap → collectFkPropertyMappings. Product declares no
    // relations, so getByTarget() returns no relation metadata.
    return { getByTarget: () => [] } as any;
  },
  resetScannerContainer: jest.fn(),
}));

// DatabaseClient mock
const mockGetInstance = jest.fn().mockReturnValue({
  type: "mysql",
  getConnection: jest.fn(),
  getOptions: jest.fn().mockReturnValue({ synchronize: false }),
});
(DatabaseClient.getInstance as jest.Mock) = mockGetInstance;

describe("Aggregate Queries", () => {
  let em: EntityManager;
  let mockQuery: jest.Mock;
  let mockConnect: jest.Mock;
  let mockStartTransaction: jest.Mock;
  let mockCommit: jest.Mock;
  let mockRollback: jest.Mock;
  let mockClose: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    mockQuery = jest.fn();
    mockConnect = jest.fn().mockResolvedValue(undefined);
    mockStartTransaction = jest.fn().mockResolvedValue(undefined);
    mockCommit = jest.fn().mockResolvedValue(undefined);
    mockRollback = jest.fn().mockResolvedValue(undefined);
    mockClose = jest.fn().mockResolvedValue(undefined);

    MockTransactionSessionManager.mockImplementation(
      () =>
        ({
          connect: mockConnect,
          startTransaction: mockStartTransaction,
          query: mockQuery,
          commit: mockCommit,
          rollback: mockRollback,
          close: mockClose,
        }) as any,
    );

    em = new EntityManager();
    // Force isMySqlFamily() to return true
    Object.defineProperty(em, "client", {
      configurable: true,
      get: () => ({
        type: "mysql",
        getConnection: jest.fn(),
        getOptions: jest.fn().mockReturnValue({ synchronize: false }),
      }),
    });
  });

  describe("count()", () => {
    it("조건 없이 전체 행 수를 반환해야 한다", async () => {
      mockQuery.mockResolvedValue({
        results: [{ result: 42 }],
        fields: [],
      });

      const result = await em.count(Product);
      expect(result).toBe(42);
      expect(mockConnect).toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalled();
      expect(mockStartTransaction).not.toHaveBeenCalled();
      expect(mockCommit).not.toHaveBeenCalled();
    });

    it("WHERE 조건이 있으면 조건에 맞는 행 수를 반환해야 한다", async () => {
      mockQuery.mockResolvedValue({
        results: [{ result: 5 }],
        fields: [],
      });

      const result = await em.count(Product, {
        name: "Widget",
      });
      expect(result).toBe(5);
    });

    it("결과가 비어 있으면 0을 반환해야 한다", async () => {
      mockQuery.mockResolvedValue({
        results: [],
        fields: [],
      });

      const result = await em.count(Product);
      expect(result).toBe(0);
    });

    it("result가 null이면 0을 반환해야 한다", async () => {
      mockQuery.mockResolvedValue({
        results: [{ result: null }],
        fields: [],
      });

      const result = await em.count(Product);
      expect(result).toBe(0);
    });
  });

  describe("sum()", () => {
    it("특정 필드의 합계를 반환해야 한다", async () => {
      mockQuery.mockResolvedValue({
        results: [{ result: 1500 }],
        fields: [],
      });

      const result = await em.sum(
        Product,
        "price",
      );
      expect(result).toBe(1500);
    });

    it("WHERE 조건과 함께 합계를 반환해야 한다", async () => {
      mockQuery.mockResolvedValue({
        results: [{ result: 300 }],
        fields: [],
      });

      const result = await em.sum(
        Product,
        "price",
        { name: "Widget" } as any,
      );
      expect(result).toBe(300);
    });

    it("결과가 null이면 0을 반환해야 한다", async () => {
      mockQuery.mockResolvedValue({
        results: [{ result: null }],
        fields: [],
      });

      const result = await em.sum(
        Product,
        "price",
      );
      expect(result).toBe(0);
    });
  });

  describe("avg()", () => {
    it("특정 필드의 평균을 반환해야 한다", async () => {
      mockQuery.mockResolvedValue({
        results: [{ result: 75.5 }],
        fields: [],
      });

      const result = await em.avg(
        Product,
        "price",
      );
      expect(result).toBe(75.5);
    });

    it("결과가 비어 있으면 0을 반환해야 한다", async () => {
      mockQuery.mockResolvedValue({
        results: [],
        fields: [],
      });

      const result = await em.avg(
        Product,
        "price",
      );
      expect(result).toBe(0);
    });
  });

  describe("min()", () => {
    it("특정 필드의 최솟값을 반환해야 한다", async () => {
      mockQuery.mockResolvedValue({
        results: [{ result: 10 }],
        fields: [],
      });

      const result = await em.min(
        Product,
        "price",
      );
      expect(result).toBe(10);
    });

    it("WHERE 조건과 함께 최솟값을 반환해야 한다", async () => {
      mockQuery.mockResolvedValue({
        results: [{ result: 25 }],
        fields: [],
      });

      const result = await em.min(
        Product,
        "price",
        { quantity: 5 },
      );
      expect(result).toBe(25);
    });
  });

  describe("max()", () => {
    it("특정 필드의 최댓값을 반환해야 한다", async () => {
      mockQuery.mockResolvedValue({
        results: [{ result: 999 }],
        fields: [],
      });

      const result = await em.max(
        Product,
        "price",
      );
      expect(result).toBe(999);
    });

    it("WHERE 조건과 함께 최댓값을 반환해야 한다", async () => {
      mockQuery.mockResolvedValue({
        results: [{ result: 500 }],
        fields: [],
      });

      const result = await em.max(
        Product,
        "price",
        { name: "Widget" } as any,
      );
      expect(result).toBe(500);
    });
  });

  describe("에러 처리", () => {
    it("메타데이터가 없으면 에러를 throw해야 한다", async () => {
      mockEntityScanner.scan.mockReturnValueOnce(null);

      await expect(
        em.count(class Unknown {} as any),
      ).rejects.toThrow("Entity metadata for \"Unknown\" does not exist.");
    });

    it("쿼리 에러 시 close만 호출하고 에러를 재throw해야 한다 (read-only: no rollback)", async () => {
      mockQuery.mockRejectedValueOnce(new Error("DB error"));

      await expect(
        em.count(Product),
      ).rejects.toThrow("DB error");

      expect(mockRollback).not.toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalled();
    });
  });

  describe("BaseRepository 위임", () => {
    it("count()를 EntityManager에 위임해야 한다", async () => {
      mockQuery.mockResolvedValue({
        results: [{ result: 10 }],
        fields: [],
      });

      const repo = em.getRepository(Product);
      const result = await repo.count();
      expect(result).toBe(10);
    });

    it("sum()을 EntityManager에 위임해야 한다", async () => {
      mockQuery.mockResolvedValue({
        results: [{ result: 500 }],
        fields: [],
      });

      const repo = em.getRepository(Product);
      const result = await repo.sum("price");
      expect(result).toBe(500);
    });

    it("avg()를 EntityManager에 위임해야 한다", async () => {
      mockQuery.mockResolvedValue({
        results: [{ result: 50 }],
        fields: [],
      });

      const repo = em.getRepository(Product);
      const result = await repo.avg("price");
      expect(result).toBe(50);
    });

    it("min()을 EntityManager에 위임해야 한다", async () => {
      mockQuery.mockResolvedValue({
        results: [{ result: 1 }],
        fields: [],
      });

      const repo = em.getRepository(Product);
      const result = await repo.min("price");
      expect(result).toBe(1);
    });

    it("max()를 EntityManager에 위임해야 한다", async () => {
      mockQuery.mockResolvedValue({
        results: [{ result: 999 }],
        fields: [],
      });

      const repo = em.getRepository(Product);
      const result = await repo.max("price");
      expect(result).toBe(999);
    });
  });

  describe("트랜잭션 라이프사이클", () => {
    it("standalone aggregate: connect → query → close 순서로 호출해야 한다 (no transaction)", async () => {
      const callOrder: string[] = [];
      mockConnect.mockImplementation(() => {
        callOrder.push("connect");
        return Promise.resolve();
      });
      mockQuery.mockImplementation(() => {
        callOrder.push("query");
        return Promise.resolve({ results: [{ result: 1 }], fields: [] });
      });
      mockClose.mockImplementation(() => {
        callOrder.push("close");
        return Promise.resolve();
      });

      await em.count(Product);

      expect(callOrder).toEqual([
        "connect",
        "query",
        "close",
      ]);
      expect(mockStartTransaction).not.toHaveBeenCalled();
      expect(mockCommit).not.toHaveBeenCalled();
    });
  });
});
