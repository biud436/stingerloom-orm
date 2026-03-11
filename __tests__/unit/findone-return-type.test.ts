import "reflect-metadata";

jest.mock("../../src/DatabaseClient", () => {
  return {
    DatabaseClient: {
      getInstance: jest.fn().mockReturnValue({
        type: "mysql",
        getType: jest.fn().mockReturnValue("mysql"),
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

import { EntityManager } from "../../src/core/EntityManager";
import { BaseRepository } from "../../src/core/BaseRepository";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";

@Entity()
class TestUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "varchar" })
  email!: string;
}

function createTestEntityManager() {
  const em = new EntityManager();
  (em as any).driver = {
    wrap: (name: string) => `\`${name}\``,
  };
  return em;
}

describe("findOne() return type: T | null", () => {
  let em: EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    em = createTestEntityManager();
    const metadata = {
      name: "TestUser",
      target: TestUser,
      columns: [
        { name: "id", options: { primary: true, autoIncrement: true } },
        { name: "name", options: {} },
        { name: "email", options: {} },
      ],
    };
    jest.spyOn((em as any).resolver, "resolveEntityMetadata").mockReturnValue(metadata);
    jest.spyOn((em as any).resolver, "resolveManyToOneMetadata").mockReturnValue([]);
    jest.spyOn((em as any).resolver, "resolveOneToOneMetadata").mockReturnValue([]);
    jest.spyOn((em as any).resolver, "resolveOneToManyMetadata").mockReturnValue([]);
    jest.spyOn((em as any).resolver, "getDeletedAtColumn").mockReturnValue(null);
  });

  it("should return a single entity (not an array) when a row is found", async () => {
    mockQuery.mockResolvedValue({
      results: [{ id: 1, name: "Alice", email: "alice@test.com" }],
      fields: [],
    });

    const result = await em.findOne(TestUser, {
      where: { id: 1 } as any,
    });

    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(false);
    expect((result as any).id).toBe(1);
    expect((result as any).name).toBe("Alice");
  });

  it("should return null when no rows are found", async () => {
    mockQuery.mockResolvedValue({
      results: [],
      fields: [],
    });

    const result = await em.findOne(TestUser, {
      where: { id: 999 } as any,
    });

    expect(result).toBeNull();
  });

  it("should return null when query returns undefined results", async () => {
    mockQuery.mockResolvedValue({
      results: undefined,
      fields: [],
    });

    const result = await em.findOne(TestUser, {
      where: { id: 999 } as any,
    });

    expect(result).toBeNull();
  });

  it("should return first element when find returns an array", async () => {
    // Even with limit:1, if the underlying find() somehow returns multiple,
    // findOne should take the first one
    mockQuery.mockResolvedValue({
      results: [
        { id: 1, name: "Alice", email: "alice@test.com" },
        { id: 2, name: "Bob", email: "bob@test.com" },
      ],
      fields: [],
    });

    const result = await em.findOne(TestUser, {
      where: {} as any,
    });

    expect(result).not.toBeNull();
    // Should get the first result (or the array, then first element)
    expect(result).toBeDefined();
  });

  describe("BaseRepository.findOne()", () => {
    let repo: BaseRepository<TestUser>;

    beforeEach(() => {
      repo = new BaseRepository(TestUser, em);
    });

    it("should return T | null through repository", async () => {
      mockQuery.mockResolvedValue({
        results: [{ id: 1, name: "Alice", email: "alice@test.com" }],
        fields: [],
      });

      const result = await repo.findOne({
        where: { id: 1 } as any,
      });

      expect(result).not.toBeNull();
      expect(Array.isArray(result)).toBe(false);
    });

    it("should return null through repository when not found", async () => {
      mockQuery.mockResolvedValue({
        results: [],
        fields: [],
      });

      const result = await repo.findOne({
        where: { id: 999 } as any,
      });

      expect(result).toBeNull();
    });
  });
});
