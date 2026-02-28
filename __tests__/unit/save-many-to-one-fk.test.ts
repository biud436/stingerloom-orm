/**
 * Regression test: save() should include ManyToOne FK columns in INSERT/UPDATE queries.
 *
 * Previously, save() only iterated over metadata.columns for building SQL,
 * which excluded FK columns defined via @ManyToOne (e.g., owner_id).
 * Setting `cat.owner = ownerEntity` and calling save() would not
 * generate an UPDATE SET owner_id = ? clause, leaving the DB unchanged.
 */
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
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";

@Entity()
class TestOwner {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  name!: string;
}

@Entity()
class TestPet {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  name!: string;

  // In a real entity this would have @ManyToOne, but we mock the metadata
  owner!: TestOwner;
}

const ownerMetadata = {
  name: "test_owner",
  target: TestOwner,
  columns: [
    { name: "id", options: { primary: true, autoIncrement: true } },
    { name: "name", options: {} },
  ],
};

const petMetadata = {
  name: "test_pet",
  target: TestPet,
  columns: [
    { name: "id", options: { primary: true, autoIncrement: true } },
    { name: "name", options: {} },
  ],
};

const manyToOneRelations = [
  {
    target: TestPet,
    columnName: "owner",
    joinColumn: "owner_id",
    getMappingEntity: () => TestOwner,
    getMappingProperty: () => {},
    option: {},
  },
];

function createTestEntityManager() {
  const em = new EntityManager();
  (em as any).driver = {
    wrap: (name: string) => `\`${name}\``,
    supportsExplain: () => false,
  };
  (em as any).dbType = "mysql";
  return em;
}

function setupMocks(em: EntityManager) {
  jest.spyOn(em as any, "resolveEntityMetadata").mockImplementation(
    (entity: any) => {
      if (entity === TestPet) return petMetadata;
      if (entity === TestOwner) return ownerMetadata;
      return null;
    },
  );
  jest
    .spyOn(em as any, "resolveManyToOneMetadata")
    .mockImplementation((entity: any) => {
      if (entity === TestPet) return manyToOneRelations;
      return [];
    });
  jest.spyOn(em as any, "resolveOneToOneMetadata").mockReturnValue([]);
  jest.spyOn(em as any, "resolveOneToManyMetadata").mockReturnValue([]);
  jest.spyOn(em as any, "resolveManyToManyMetadata").mockReturnValue([]);
  jest.spyOn(em as any, "getDeletedAtColumn").mockReturnValue(null);
}

function getSqlText(call: any[]): string {
  const sqlObj = call[0];
  return sqlObj.text ?? sqlObj.sql ?? String(sqlObj);
}

describe("save() ManyToOne FK column inclusion (regression)", () => {
  let em: EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    em = createTestEntityManager();
    setupMocks(em);
  });

  it("should include FK column (owner_id) in UPDATE query when relation object is set", async () => {
    const owner = new TestOwner();
    owner.id = 7;
    owner.name = "TestOwner";

    const pet = new TestPet();
    pet.id = 1;
    pet.name = "Whiskers";
    pet.owner = owner;

    // save() on an entity with existing PK → UPDATE path
    mockQuery.mockResolvedValue({ results: [], fields: [] });

    await em.save(TestPet, pet);

    // Find the UPDATE query (not SET autocommit, not START TRANSACTION)
    const updateCall = mockQuery.mock.calls.find((call: any[]) => {
      const text = getSqlText(call);
      return text.includes("UPDATE");
    });

    expect(updateCall).toBeDefined();
    const updateSql = getSqlText(updateCall!);
    expect(updateSql).toContain("`owner_id`");
    // FK value should be parameterized (owner.id = 7)
    expect(updateCall![0].values).toContain(7);
  });

  it("should include FK column (owner_id) in INSERT query when relation object is set", async () => {
    const owner = new TestOwner();
    owner.id = 3;
    owner.name = "InsertOwner";

    const pet = new TestPet();
    // No id → INSERT path (auto-increment)
    pet.name = "NewCat";
    pet.owner = owner;

    mockQuery.mockResolvedValue({
      results: { insertId: 99 },
      fields: [],
    });

    // findOne after INSERT
    jest
      .spyOn(em, "findOne")
      .mockResolvedValue({ id: 99, name: "NewCat", owner } as any);

    await em.save(TestPet, pet);

    // Find the INSERT query
    const insertCall = mockQuery.mock.calls.find((call: any[]) => {
      const text = getSqlText(call);
      return text.includes("INSERT");
    });

    expect(insertCall).toBeDefined();
    const insertSql = getSqlText(insertCall!);
    expect(insertSql).toContain("`owner_id`");
    expect(insertCall![0].values).toContain(3);
  });

  it("should NOT include FK column when relation object is null/undefined", async () => {
    const pet = new TestPet();
    pet.id = 2;
    pet.name = "Solo";
    // owner is not set (undefined)

    mockQuery.mockResolvedValue({ results: [], fields: [] });

    await em.save(TestPet, pet);

    const updateCall = mockQuery.mock.calls.find((call: any[]) => {
      const text = getSqlText(call);
      return text.includes("UPDATE");
    });

    expect(updateCall).toBeDefined();
    const updateSql = getSqlText(updateCall!);
    expect(updateSql).not.toContain("`owner_id`");
  });
});
