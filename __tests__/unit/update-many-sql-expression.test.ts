import "reflect-metadata";
import sql, { raw } from "sql-template-tag";
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

const commentMetadata = {
  name: "PostComment",
  target: class PostComment {},
  columns: [
    { name: "id", propertyKey: "id", options: { primary: true, autoIncrement: true } },
    { name: "pos", propertyKey: "pos", options: {} },
    { name: "depth", propertyKey: "depth", options: {} },
    { name: "content", propertyKey: "content", options: {} },
    { name: "post_id", propertyKey: "postId", options: {} },
  ],
};

// ── Tests ─────────────────────────────────────────────────

describe("updateMany with Sql expressions", () => {
  let em: EntityManager;

  beforeEach(() => {
    MetadataLayerRegistry.reset();
    resetScannerContainer();
    jest.clearAllMocks();
    em = createTestEntityManager();
  });

  it("should accept Sql expression in data values (increment)", async () => {
    const { __mockQuery } = jest.requireMock(
      "../../src/dialects/TransactionSessionManager",
    );

    jest
      .spyOn((em as any).resolver, "resolveEntityMetadata")
      .mockReturnValue(commentMetadata);
    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);
    jest
      .spyOn((em as any).resolver, "getUpdateTimestampColumn")
      .mockReturnValue(null);

    __mockQuery.mockResolvedValue({
      results: { affectedRows: 3 },
      fields: [],
    });

    const result = await em.updateMany(
      commentMetadata.target,
      { pos: sql`pos + 1` } as any,
      { where: { postId: 5 } as any },
    );

    expect(result.affected).toBe(3);

    const calls = __mockQuery.mock.calls;
    const updateCall = calls.find(
      (call: any[]) => typeof call[0] !== "string",
    );
    expect(updateCall).toBeDefined();

    const sqlText = updateCall![0].text || String(updateCall![0]);
    expect(sqlText).toContain("UPDATE");
    expect(sqlText).toContain("SET");
    // The Sql expression should be inlined as raw SQL, not parameterized
    expect(sqlText).toContain("pos + 1");
  });

  it("should accept mixed literal values and Sql expressions", async () => {
    const { __mockQuery } = jest.requireMock(
      "../../src/dialects/TransactionSessionManager",
    );

    jest
      .spyOn((em as any).resolver, "resolveEntityMetadata")
      .mockReturnValue(commentMetadata);
    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);
    jest
      .spyOn((em as any).resolver, "getUpdateTimestampColumn")
      .mockReturnValue(null);

    __mockQuery.mockResolvedValue({
      results: { affectedRows: 1 },
      fields: [],
    });

    const result = await em.updateMany(
      commentMetadata.target,
      {
        content: "updated",
        pos: sql`pos + 1`,
      } as any,
      { where: { id: 1 } as any },
    );

    expect(result.affected).toBe(1);

    const calls = __mockQuery.mock.calls;
    const updateCall = calls.find(
      (call: any[]) => typeof call[0] !== "string",
    );
    const sqlText = updateCall![0].text || String(updateCall![0]);

    // Both literal and Sql expression should be in the SET clause
    expect(sqlText).toContain("SET");
    expect(sqlText).toContain("pos + 1");
  });

  it("should work with CURRENT_TIMESTAMP expression", async () => {
    const metaWithUpdatedAt = {
      ...commentMetadata,
      columns: [
        ...commentMetadata.columns,
        { name: "updated_at", propertyKey: "updatedAt", options: {} },
      ],
    };

    const { __mockQuery } = jest.requireMock(
      "../../src/dialects/TransactionSessionManager",
    );

    jest
      .spyOn((em as any).resolver, "resolveEntityMetadata")
      .mockReturnValue(metaWithUpdatedAt);
    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);
    jest
      .spyOn((em as any).resolver, "getUpdateTimestampColumn")
      .mockReturnValue(null);

    __mockQuery.mockResolvedValue({
      results: { affectedRows: 1 },
      fields: [],
    });

    await em.updateMany(
      metaWithUpdatedAt.target,
      { updatedAt: sql`CURRENT_TIMESTAMP` } as any,
      { where: { id: 1 } as any },
    );

    const calls = __mockQuery.mock.calls;
    const updateCall = calls.find(
      (call: any[]) => typeof call[0] !== "string",
    );
    const sqlText = updateCall![0].text || String(updateCall![0]);

    expect(sqlText).toContain("CURRENT_TIMESTAMP");
  });

  it("should coexist with @UpdateTimestamp auto-injection", async () => {
    const { __mockQuery } = jest.requireMock(
      "../../src/dialects/TransactionSessionManager",
    );

    jest
      .spyOn((em as any).resolver, "resolveEntityMetadata")
      .mockReturnValue(commentMetadata);
    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);
    // Simulate @UpdateTimestamp on a column named "updated_at"
    jest
      .spyOn((em as any).resolver, "getUpdateTimestampColumn")
      .mockReturnValue("updated_at");

    __mockQuery.mockResolvedValue({
      results: { affectedRows: 1 },
      fields: [],
    });

    await em.updateMany(
      commentMetadata.target,
      { pos: sql`pos + 1` } as any,
      { where: { id: 1 } as any },
    );

    const calls = __mockQuery.mock.calls;
    const updateCall = calls.find(
      (call: any[]) => typeof call[0] !== "string",
    );
    const sqlText = updateCall![0].text || String(updateCall![0]);

    // Should have both the Sql expression AND the auto-injected timestamp
    expect(sqlText).toContain("pos + 1");
    expect(sqlText).toContain("`updated_at`");
  });

  it("BaseRepository.updateMany should accept Sql expressions", async () => {
    const mockEm = {
      updateMany: jest.fn().mockResolvedValue({ affected: 2 }),
    } as any;

    const repo = new BaseRepository(commentMetadata.target, mockEm);

    await repo.updateMany(
      { pos: sql`pos + 1` } as any,
      { where: { postId: 5 } as any },
    );

    expect(mockEm.updateMany).toHaveBeenCalledWith(
      commentMetadata.target,
      { pos: expect.any(Object) },
      { where: { postId: 5 } },
    );
  });
});
