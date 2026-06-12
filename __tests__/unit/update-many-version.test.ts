import "reflect-metadata";
import { resetScannerContainer } from "../../src/scanner/ScannerContainer";
import { EntityManager } from "../../src/core/EntityManager";
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

function setupEm(
  em: EntityManager,
  metadata: any,
  versionProp: string | null,
) {
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

function getUpdateSqlText(): string {
  const { __mockQuery } = jest.requireMock(
    "../../src/dialects/TransactionSessionManager",
  );
  const updateCall = __mockQuery.mock.calls.find(
    (call: any[]) => typeof call[0] !== "string",
  );
  return updateCall![0].text || String(updateCall![0]);
}

const versionedMeta = {
  name: "Doc",
  target: class Doc {},
  columns: [
    { name: "id", propertyKey: "id", options: { primary: true, autoIncrement: true } },
    { name: "title", propertyKey: "title", options: {} },
    { name: "version", propertyKey: "version", options: {} },
  ],
};

const plainMeta = {
  name: "Note",
  target: class Note {},
  columns: [
    { name: "id", propertyKey: "id", options: { primary: true, autoIncrement: true } },
    { name: "title", propertyKey: "title", options: {} },
  ],
};

// Snake-cased version column to verify NamingStrategy mapping.
const snakeVersionedMeta = {
  name: "Snake",
  target: class Snake {},
  columns: [
    { name: "id", propertyKey: "id", options: { primary: true, autoIncrement: true } },
    { name: "title", propertyKey: "title", options: {} },
    { name: "row_version", propertyKey: "version", options: {} },
  ],
};

// ── Tests ─────────────────────────────────────────────────

describe("updateMany @Version increment", () => {
  let em: EntityManager;

  beforeEach(() => {
    MetadataLayerRegistry.reset();
    resetScannerContainer();
    jest.clearAllMocks();
    em = createTestEntityManager();
    const { __mockQuery } = jest.requireMock(
      "../../src/dialects/TransactionSessionManager",
    );
    __mockQuery.mockResolvedValue({ results: { affectedRows: 3 }, fields: [] });
  });

  it("bumps the version column by default when the entity has @Version", async () => {
    setupEm(em, versionedMeta, "version");

    await em.updateMany(
      versionedMeta.target,
      { title: "Updated" } as any,
      { where: { id: 1 } as any },
    );

    const sqlText = getUpdateSqlText();
    expect(sqlText).toMatch(/`version`\s*=\s*`version`\s*\+\s*1/);
  });

  it("does NOT auto-bump when data explicitly sets the version property", async () => {
    setupEm(em, versionedMeta, "version");

    await em.updateMany(
      versionedMeta.target,
      { title: "Updated", version: 5 } as any,
      { where: { id: 1 } as any },
    );

    const sqlText = getUpdateSqlText();
    // The explicit user value is written; the auto-increment arithmetic is not.
    expect(sqlText).not.toMatch(/`version`\s*=\s*`version`\s*\+\s*1/);
    expect(sqlText).toMatch(/`version`\s*=/);
  });

  it("does not touch version on an entity without @Version", async () => {
    setupEm(em, plainMeta, null);

    await em.updateMany(
      plainMeta.target,
      { title: "Updated" } as any,
      { where: { id: 1 } as any },
    );

    const sqlText = getUpdateSqlText();
    expect(sqlText).not.toMatch(/version/i);
  });

  it("maps the version PROPERTY key to its DB column (NamingStrategy)", async () => {
    setupEm(em, snakeVersionedMeta, "version");

    await em.updateMany(
      snakeVersionedMeta.target,
      { title: "Updated" } as any,
      { where: { id: 1 } as any },
    );

    const sqlText = getUpdateSqlText();
    expect(sqlText).toMatch(/`row_version`\s*=\s*`row_version`\s*\+\s*1/);
  });
});
