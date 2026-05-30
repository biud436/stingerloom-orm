import "reflect-metadata";
import { resetScannerContainer } from "../../src/scanner/ScannerContainer";
import { EntityManager } from "../../src/core/EntityManager";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";
import { InvalidQueryError } from "../../src/errors/InvalidQueryError";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Regression for #353: validateCriteriaKeys() used to build its allow-list
// from metadata.columns only, so a @ManyToOne/@OneToOne FK shadow property
// (e.g. `userId` backing a `user` relation) — which the SQL builder
// (buildPropertyToColumnMap → collectFkPropertyMappings) resolves fine — was
// rejected with `Unknown column "userId"`. The guard now derives its allow-list
// from the same builder, so updateMany/delete/softDelete/restore accept FK
// shadow props.

jest.mock("../../src/DatabaseClient", () => ({
  DatabaseClient: {
    getInstance: jest.fn().mockReturnValue({
      type: "mysql",
      getConnection: jest.fn(),
      getOptions: jest.fn().mockReturnValue({ synchronize: false }),
      connect: jest.fn(),
    }),
  },
}));

jest.mock("../../src/dialects/TransactionSessionManager", () => {
  const mockQuery = jest.fn().mockResolvedValue({ affectedRows: 1, rowCount: 1 });
  return {
    TransactionSessionManager: jest.fn().mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      query: mockQuery,
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    })),
    __mockQuery: mockQuery,
  };
});

class Notification {}

const metadata = {
  name: "Notification",
  target: Notification,
  columns: [
    { name: "id", propertyKey: "id", options: { primary: true, autoIncrement: true } },
    { name: "read_at", propertyKey: "readAt", options: {} },
  ],
};

function createEm(deletedAtColumn: string | null = null): EntityManager {
  const em = new EntityManager();
  (em as any).driver = { wrap: (n: string) => `\`${n}\`` };
  (em as any).resolver = {
    resolveEntityMetadata: jest.fn().mockReturnValue(metadata),
    getDeletedAtColumn: jest.fn().mockReturnValue(deletedAtColumn),
    getUpdateTimestampColumn: jest.fn().mockReturnValue(null),
    getCreateTimestampColumn: jest.fn().mockReturnValue(null),
    getVersionColumn: jest.fn().mockReturnValue(null),
    // What collectFkPropertyMappings() yields for a `@ManyToOne user` with
    // joinColumn "user_id": the FK shadow property maps to the FK column.
    collectFkPropertyMappings: jest
      .fn()
      .mockReturnValue(new Map([["userId", "user_id"]])),
  };
  return em;
}

describe("validateCriteriaKeys accepts @RelationColumn FK shadow props (#353)", () => {
  beforeEach(() => {
    MetadataLayerRegistry.reset();
    resetScannerContainer();
    jest.clearAllMocks();
  });

  it("delete() by an FK shadow prop passes validation", async () => {
    const em = createEm();
    await expect(
      em.delete(Notification, { userId: 5 } as any),
    ).resolves.not.toThrow();
  });

  it("updateMany() filtering by an FK shadow prop passes validation", async () => {
    const em = createEm();
    await expect(
      em.updateMany(
        Notification,
        { readAt: new Date() } as any,
        { where: { userId: 5 } as any },
      ),
    ).resolves.not.toThrow();
  });

  it("updateMany() SETTING an FK shadow prop passes validation", async () => {
    const em = createEm();
    await expect(
      em.updateMany(
        Notification,
        { userId: 9 } as any,
        { where: { id: 1 } as any },
      ),
    ).resolves.not.toThrow();
  });

  it("softDelete() by an FK shadow prop passes validation", async () => {
    const em = createEm("deleted_at");
    await expect(
      em.softDelete(Notification, { userId: 5 } as any),
    ).resolves.not.toThrow();
  });

  it("restore() by an FK shadow prop passes validation", async () => {
    const em = createEm("deleted_at");
    await expect(
      em.restore(Notification, { userId: 5 } as any),
    ).resolves.not.toThrow();
  });

  it("still rejects a genuinely unknown column", async () => {
    const em = createEm();
    await expect(
      em.delete(Notification, { totallyBogus: 1 } as any),
    ).rejects.toThrow(InvalidQueryError);
  });

  it("error message still names the unknown key", async () => {
    const em = createEm();
    await expect(
      em.delete(Notification, { totallyBogus: 1 } as any),
    ).rejects.toThrow(/totallyBogus/);
  });
});
