import "reflect-metadata";
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

// ── Typed entities (shape drives `keyof T` column typing) ──

class Post {
  id!: number;
  viewCount!: number;
  stock!: number;
}

class Doc {
  id!: number;
  views!: number;
  version!: number;
}

// ── Helpers ───────────────────────────────────────────────

function createTestEntityManager() {
  const em = new EntityManager();
  (em as any).driver = {
    wrap: (name: string) => `\`${name}\``,
  };
  return em;
}

function setupEm(em: EntityManager, metadata: any, versionProp: string | null) {
  jest
    .spyOn((em as any).resolver, "resolveEntityMetadata")
    .mockReturnValue(metadata);
  jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);
  jest
    .spyOn((em as any).resolver, "getUpdateTimestampColumn")
    .mockReturnValue(null);
  jest
    .spyOn((em as any).resolver, "getVersionColumn")
    .mockReturnValue(versionProp);
}

/** Returns the parameterised UPDATE call captured by the mock session. */
function getUpdateCall(): { text: string; values: unknown[] } {
  const { __mockQuery } = jest.requireMock(
    "../../src/dialects/TransactionSessionManager",
  );
  const updateCall = __mockQuery.mock.calls.find(
    (call: any[]) => typeof call[0] !== "string",
  );
  expect(updateCall).toBeDefined();
  return {
    text: updateCall![0].text ?? String(updateCall![0]),
    values: updateCall![0].values ?? [],
  };
}

const postMeta = {
  name: "Post",
  target: Post,
  columns: [
    {
      name: "id",
      propertyKey: "id",
      options: { primary: true, autoIncrement: true },
    },
    { name: "view_count", propertyKey: "viewCount", options: {} },
    { name: "stock", propertyKey: "stock", options: {} },
  ],
};

const versionedMeta = {
  name: "Doc",
  target: Doc,
  columns: [
    {
      name: "id",
      propertyKey: "id",
      options: { primary: true, autoIncrement: true },
    },
    { name: "views", propertyKey: "views", options: {} },
    { name: "version", propertyKey: "version", options: {} },
  ],
};

// ── Tests ─────────────────────────────────────────────────

describe("EntityManager.increment / decrement", () => {
  let em: EntityManager;

  beforeEach(() => {
    MetadataLayerRegistry.reset();
    resetScannerContainer();
    jest.clearAllMocks();
    em = createTestEntityManager();
    const { __mockQuery } = jest.requireMock(
      "../../src/dialects/TransactionSessionManager",
    );
    __mockQuery.mockResolvedValue({ results: { affectedRows: 2 }, fields: [] });
  });

  it("increment generates SET <col> = <col> + ? with by bound, filtered by where", async () => {
    setupEm(em, postMeta, null);

    const result = await em.increment(Post, { id: 1 }, "viewCount", 5);

    const { text, values } = getUpdateCall();
    expect(text).toContain("UPDATE");
    // RHS references the snake_cased DB column, bound delta as a parameter.
    expect(text).toMatch(/`view_count`\s*=\s*`view_count`\s*\+\s*(?:\?|\$\d+)/);
    expect(values).toContain(5);
    // Filtered by the where clause (id = 1).
    expect(text).toMatch(/WHERE/);
    expect(values).toContain(1);
    // Affected rows surfaced from the driver result.
    expect(result).toEqual({ affected: 2 });
  });

  it("increment defaults by to 1 when omitted", async () => {
    setupEm(em, postMeta, null);

    await em.increment(Post, { id: 1 }, "viewCount");

    const { text, values } = getUpdateCall();
    expect(text).toMatch(/`view_count`\s*=\s*`view_count`\s*\+\s*(?:\?|\$\d+)/);
    expect(values).toContain(1);
  });

  it("decrement generates the subtraction form SET <col> = <col> - ?", async () => {
    setupEm(em, postMeta, null);

    await em.decrement(Post, { id: 3 }, "stock", 2);

    const { text, values } = getUpdateCall();
    expect(text).toMatch(/`stock`\s*=\s*`stock`\s*-\s*(?:\?|\$\d+)/);
    expect(values).toContain(2);
    expect(values).toContain(3);
  });

  it("decrement defaults by to 1 when omitted", async () => {
    setupEm(em, postMeta, null);

    await em.decrement(Post, { id: 3 }, "stock");

    const { text, values } = getUpdateCall();
    expect(text).toMatch(/`stock`\s*=\s*`stock`\s*-\s*(?:\?|\$\d+)/);
    expect(values).toContain(1);
  });

  it("returns { affected } from the driver result", async () => {
    setupEm(em, postMeta, null);
    const { __mockQuery } = jest.requireMock(
      "../../src/dialects/TransactionSessionManager",
    );
    __mockQuery.mockResolvedValue({ results: { affectedRows: 7 }, fields: [] });

    const result = await em.increment(Post, { id: 1 }, "viewCount");

    expect(result).toEqual({ affected: 7 });
  });

  it("rejects a non-finite by amount", async () => {
    setupEm(em, postMeta, null);

    await expect(
      em.increment(Post, { id: 1 }, "viewCount", Number.NaN),
    ).rejects.toThrow();
  });

  it("rejects an empty WHERE (inherited from update guard)", async () => {
    setupEm(em, postMeta, null);

    await expect(em.increment(Post, {}, "viewCount", 1)).rejects.toThrow();
  });

  it("bumps the @Version column in the same statement", async () => {
    setupEm(em, versionedMeta, "version");

    await em.increment(Doc, { id: 1 }, "views", 3);

    const { text } = getUpdateCall();
    // The increment expression is present...
    expect(text).toMatch(/`views`\s*=\s*`views`\s*\+\s*(?:\?|\$\d+)/);
    // ...and the optimistic-lock version is auto-bumped alongside it.
    expect(text).toMatch(/`version`\s*=\s*`version`\s*\+\s*1/);
  });
});

describe("BaseRepository.increment / decrement", () => {
  it("increment delegates to EntityManager.increment with the bound entity", async () => {
    const mockEm = {
      increment: jest.fn().mockResolvedValue({ affected: 1 }),
    } as unknown as EntityManager;
    const repo = new BaseRepository<Post>(Post, mockEm);

    const result = await repo.increment({ id: 1 }, "viewCount", 4);

    expect(mockEm.increment).toHaveBeenCalledWith(Post, { id: 1 }, "viewCount", 4);
    expect(result).toEqual({ affected: 1 });
  });

  it("decrement delegates to EntityManager.decrement (default by = 1)", async () => {
    const mockEm = {
      decrement: jest.fn().mockResolvedValue({ affected: 1 }),
    } as unknown as EntityManager;
    const repo = new BaseRepository<Post>(Post, mockEm);

    await repo.decrement({ id: 9 }, "stock");

    expect(mockEm.decrement).toHaveBeenCalledWith(Post, { id: 9 }, "stock", 1);
  });
});
