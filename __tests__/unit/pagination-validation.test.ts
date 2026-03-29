import "reflect-metadata";
import { getScannerInstance, resetScannerContainer } from "../../src/scanner/ScannerContainer";
import { EntityManager } from "../../src/core/EntityManager";
import { MetadataLayerRegistry } from "../../src/scanner/MetadataScanner";
import { InvalidQueryError } from "../../src/errors/InvalidQueryError";

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
  return {
    TransactionSessionManager: jest.fn().mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue({ results: [], fields: [] }),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    })),
  };
});

const UserClass = class User {};
const userMetadata = {
  name: "User",
  target: UserClass,
  columns: [
    { name: "id", options: { primary: true, autoIncrement: true } },
    { name: "name", options: {} },
  ],
};

function createTestEntityManager() {
  const em = new EntityManager();
  (em as any).driver = {
    wrap: (name: string) => `\`${name}\``,
  };
  (em as any).resolver = {
    resolveEntityMetadata: jest.fn().mockReturnValue(userMetadata),
    resolveManyToOneMetadata: jest.fn().mockReturnValue([]),
    resolveOneToOneMetadata: jest.fn().mockReturnValue([]),
    resolveOneToManyMetadata: jest.fn().mockReturnValue([]),
  };
  return em;
}

describe("Pagination validation (#123)", () => {
  let em: EntityManager;

  beforeEach(() => {
    MetadataLayerRegistry.reset();
    resetScannerContainer();
    jest.clearAllMocks();
    em = createTestEntityManager();
  });

  describe("negative skip", () => {
    it("should throw InvalidQueryError for negative skip", async () => {
      await expect(
        em.find(UserClass, { skip: -1, take: 10 }),
      ).rejects.toThrow(InvalidQueryError);
    });

    it("should include value in error message", async () => {
      await expect(
        em.find(UserClass, { skip: -5 }),
      ).rejects.toThrow(/received -5/);
    });
  });

  describe("negative take", () => {
    it("should throw InvalidQueryError for negative take", async () => {
      await expect(
        em.find(UserClass, { take: -5 }),
      ).rejects.toThrow(InvalidQueryError);
    });
  });

  describe("negative limit (number)", () => {
    it("should throw InvalidQueryError for negative limit", async () => {
      await expect(
        em.find(UserClass, { limit: -1 }),
      ).rejects.toThrow(InvalidQueryError);
    });
  });

  describe("negative limit (tuple)", () => {
    it("should throw for negative offset in tuple", async () => {
      await expect(
        em.find(UserClass, { limit: [-1, 10] }),
      ).rejects.toThrow(InvalidQueryError);
    });

    it("should throw for negative count in tuple", async () => {
      await expect(
        em.find(UserClass, { limit: [0, -5] }),
      ).rejects.toThrow(InvalidQueryError);
    });
  });

  describe("valid values should not throw InvalidQueryError", () => {
    it("should not throw InvalidQueryError for skip: 0, take: 10", async () => {
      try {
        await em.find(UserClass, { skip: 0, take: 10 });
      } catch (e) {
        expect(e).not.toBeInstanceOf(InvalidQueryError);
      }
    });

    it("should not throw InvalidQueryError for limit: 10", async () => {
      try {
        await em.find(UserClass, { limit: 10 });
      } catch (e) {
        expect(e).not.toBeInstanceOf(InvalidQueryError);
      }
    });

    it("should not throw InvalidQueryError for limit: [0, 10]", async () => {
      try {
        await em.find(UserClass, { limit: [0, 10] });
      } catch (e) {
        expect(e).not.toBeInstanceOf(InvalidQueryError);
      }
    });

    it("should not throw InvalidQueryError for empty options", async () => {
      try {
        await em.find(UserClass, {});
      } catch (e) {
        expect(e).not.toBeInstanceOf(InvalidQueryError);
      }
    });
  });
});
