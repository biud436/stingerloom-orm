import "reflect-metadata";
import sql from "sql-template-tag";
import { resetScannerContainer } from "../../src/scanner/ScannerContainer";
import { EntityManager } from "../../src/core/EntityManager";
import { BaseRepository } from "../../src/core/BaseRepository";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";

// ── Mocks ─────────────────────────────────────────────────

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
  };
});

// ── Helpers ───────────────────────────────────────────────

function createTestEntityManager() {
  const em = new EntityManager();
  (em as any).driver = {
    wrap: (name: string) => `\`${name}\``,
  };
  return em;
}

class User {}

const userMetadata = {
  name: "User",
  target: User,
  columns: [
    {
      name: "id",
      propertyKey: "id",
      options: { primary: true, autoIncrement: true },
    },
    { name: "name", propertyKey: "name", options: {} },
    { name: "view_count", propertyKey: "viewCount", options: {} },
  ],
};

function primeMetadata(em: EntityManager) {
  jest
    .spyOn((em as any).resolver, "resolveEntityMetadata")
    .mockReturnValue(userMetadata);
  jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);
  jest
    .spyOn((em as any).resolver, "getUpdateTimestampColumn")
    .mockReturnValue(null);
}

function lastUpdateSqlText(): string {
  const { __mockQuery } = jest.requireMock(
    "../../src/dialects/TransactionSessionManager",
  );
  const updateCall = __mockQuery.mock.calls.find(
    (call: any[]) => typeof call[0] !== "string",
  );
  expect(updateCall).toBeDefined();
  return updateCall![0].text || String(updateCall![0]);
}

// ── Tests ─────────────────────────────────────────────────

describe("EntityManager.update (single-call, filter-first sugar over updateMany)", () => {
  let em: EntityManager;

  beforeEach(() => {
    MetadataLayerRegistry.reset();
    resetScannerContainer();
    jest.clearAllMocks();
    em = createTestEntityManager();
  });

  it("updates rows matching the where filter and returns affected count", async () => {
    const { __mockQuery } = jest.requireMock(
      "../../src/dialects/TransactionSessionManager",
    );
    primeMetadata(em);
    __mockQuery.mockResolvedValue({ results: { affectedRows: 1 }, fields: [] });

    const result = await em.update(User, { id: 1 } as any, {
      name: "Alice",
    } as any);

    expect(result.affected).toBe(1);

    const sqlText = lastUpdateSqlText();
    expect(sqlText).toContain("UPDATE");
    expect(sqlText).toContain("SET");
    expect(sqlText).toContain("`name`");
    expect(sqlText).toContain("WHERE");
    expect(sqlText).toContain("`id`");
  });

  it("forwards raw Sql expressions through to the SET clause", async () => {
    const { __mockQuery } = jest.requireMock(
      "../../src/dialects/TransactionSessionManager",
    );
    primeMetadata(em);
    __mockQuery.mockResolvedValue({ results: { affectedRows: 2 }, fields: [] });

    const result = await em.update(User, { id: 1 } as any, {
      viewCount: sql`view_count + 1`,
    } as any);

    expect(result.affected).toBe(2);
    expect(lastUpdateSqlText()).toContain("view_count + 1");
  });

  it("rejects an empty WHERE to prevent a table-wide update", async () => {
    primeMetadata(em);

    await expect(
      em.update(User, {} as any, { name: "Alice" } as any),
    ).rejects.toThrow();
  });

  it("is exposed on BaseRepository with the filter-first signature", async () => {
    const { __mockQuery } = jest.requireMock(
      "../../src/dialects/TransactionSessionManager",
    );
    primeMetadata(em);
    __mockQuery.mockResolvedValue({ results: { affectedRows: 1 }, fields: [] });

    const repo = new BaseRepository<User>(User, em);
    const result = await repo.update({ id: 1 } as any, {
      name: "Bob",
    } as any);

    expect(result.affected).toBe(1);
    const sqlText = lastUpdateSqlText();
    expect(sqlText).toContain("`name`");
    expect(sqlText).toContain("WHERE");
  });
});
