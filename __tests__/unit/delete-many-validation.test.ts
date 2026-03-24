import "reflect-metadata";
import Container from "typedi";
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
  const mockQuery = jest.fn();
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

function createTestEntityManager() {
  const em = new EntityManager();
  (em as any).driver = {
    wrap: (name: string) => `\`${name}\``,
  };
  return em;
}

const UserClass = class User {};
const userMetadata = {
  name: "User",
  target: UserClass,
  columns: [
    { name: "id", options: { primary: true, autoIncrement: true } },
    { name: "name", options: {} },
  ],
};

describe("deleteMany() scalar validation (#120)", () => {
  let em: EntityManager;

  beforeEach(() => {
    MetadataLayerRegistry.reset();
    Container.reset();
    jest.clearAllMocks();
    em = createTestEntityManager();
    (em as any).resolver = {
      resolveEntityMetadata: jest.fn().mockReturnValue(userMetadata),
      resolveManyToOneMetadata: jest.fn().mockReturnValue([]),
      resolveOneToOneMetadata: jest.fn().mockReturnValue([]),
    };
  });

  it("should reject objects in ids array", async () => {
    await expect(
      em.deleteMany(UserClass, [{ name: "Alice" }]),
    ).rejects.toThrow(InvalidQueryError);
  });

  it("should reject null in ids array", async () => {
    await expect(em.deleteMany(UserClass, [null])).rejects.toThrow(
      InvalidQueryError,
    );
  });

  it("should reject undefined in ids array", async () => {
    await expect(em.deleteMany(UserClass, [undefined])).rejects.toThrow(
      InvalidQueryError,
    );
  });

  it("should reject arrays in ids array", async () => {
    await expect(em.deleteMany(UserClass, [[1, 2]])).rejects.toThrow(
      InvalidQueryError,
    );
  });

  it("should reject boolean in ids array", async () => {
    await expect(em.deleteMany(UserClass, [true])).rejects.toThrow(
      InvalidQueryError,
    );
  });

  it("should return { affected: 0 } for empty array", async () => {
    const result = await em.deleteMany(UserClass, []);
    expect(result).toEqual({ affected: 0 });
  });

  it("should accept number ids", async () => {
    // Validation passes — no throw before reaching transaction
    await expect(
      em.deleteMany(UserClass, [1, 2, 3]),
    ).resolves.not.toThrow();
  });

  it("should accept string ids", async () => {
    await expect(
      em.deleteMany(UserClass, ["a", "b", "c"]),
    ).resolves.not.toThrow();
  });

  it("should accept bigint ids", async () => {
    await expect(
      em.deleteMany(UserClass, [BigInt(1), BigInt(2)]),
    ).resolves.not.toThrow();
  });

  it("should include typeof in error message", async () => {
    await expect(em.deleteMany(UserClass, [{ id: 1 }])).rejects.toThrow(
      /received object/,
    );
  });
});
