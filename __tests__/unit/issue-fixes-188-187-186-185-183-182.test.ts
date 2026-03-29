/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import {
  EntitySubscriber,
  InsertEvent,
} from "../../src/core/EntitySubscriber";
import { PostgresDriver } from "../../src/dialects/postgres/PostgresDriver";
import { SchemaDiff } from "../../src/core/generators/SchemaDiff";
import { SchemaGenerator } from "../../src/core/generators/SchemaGenerator";
import { Entity, ENTITY_TOKEN } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../src/decorators/ManyToOne";
import {
  encodeCursor,
} from "../../src/core/CursorPagination";

// ─────────────────────────────────────────────────────────────────────────────
// Mock 설정 (EntityManager 테스트 공용)
// ─────────────────────────────────────────────────────────────────────────────

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
      connectToNode: jest.fn().mockResolvedValue(undefined),
      startTransaction: mockStartTransaction,
      query: mockQuery,
      commit: mockCommit,
      rollback: mockRollback,
      close: mockClose,
    })),
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: EntityManager creation
// ─────────────────────────────────────────────────────────────────────────────

class TestUser {
  id!: number;
  name!: string;
  email!: string;
}

class TestPost {
  id!: number;
  title!: string;
}

const userMetadata = {
  name: "User",
  target: TestUser,
  columns: [
    { name: "id", options: { primary: true, autoIncrement: true } },
    { name: "name", options: {} },
    { name: "email", options: {} },
  ],
};

const postMetadata = {
  name: "Post",
  target: TestPost,
  columns: [
    { name: "id", options: { primary: true, autoIncrement: true } },
    { name: "title", options: {} },
  ],
};

function createTestEntityManager() {
  const em = new EntityManager();
  (em as any).driver = {
    wrap: (name: string) => `\`${name}\``,
  };
  return em;
}

function setupEmMocks(em: EntityManager, metadata: any = userMetadata) {
  jest
    .spyOn((em as any).resolver, "resolveEntityMetadata")
    .mockImplementation((entity: any) => {
      if (entity === TestUser) return userMetadata;
      if (entity === TestPost) return postMetadata;
      return metadata;
    });
  jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);
  jest.spyOn(em as any, "isPostgres").mockReturnValue(false);
  jest
    .spyOn(em as any, "wrap")
    .mockImplementation((...args: any[]) => `\`${args[0]}\``);
  jest
    .spyOn((em as any).resolver, "resolveOneToOneMetadata")
    .mockReturnValue([]);
  jest
    .spyOn((em as any).resolver, "resolveManyToOneMetadata")
    .mockReturnValue([]);
  jest
    .spyOn((em as any).resolver, "resolveOneToManyMetadata")
    .mockReturnValue([]);
  jest
    .spyOn((em as any).cascadeHandler, "runHooks")
    .mockResolvedValue(undefined);
  jest
    .spyOn((em as any).cascadeHandler, "cascadeSaveOneToMany")
    .mockResolvedValue(undefined);
  jest
    .spyOn((em as any).resolver, "getDeletedAtColumn")
    .mockReturnValue(null);
  jest
    .spyOn(em as any, "findOneInternal")
    .mockResolvedValue(undefined);
}

// ═════════════════════════════════════════════════════════════════════════════
// Issue #188: MySQL connector rollback error handling
// ═════════════════════════════════════════════════════════════════════════════

describe("Issue #188: MySQL connector rollback error handling", () => {
  // We directly test the MySqlConnector class methods
  let MySqlConnector: any;

  beforeEach(() => {
    jest.resetModules();
    // Re-require to get a fresh copy
    MySqlConnector =
      require("../../src/dialects/mysql/MySqlConnector").MySqlConnector;
  });

  function createMockConnection(overrides: any = {}) {
    return {
      commit: jest.fn((cb: Function) => cb(null)),
      rollback: jest.fn((cb: Function) => cb(null)),
      query: jest.fn((_sql: string, cb: Function) => cb(null)),
      release: jest.fn(),
      destroy: jest.fn(),
      ...overrides,
    };
  }

  it("should call rollback when commit fails, passing error to reject", async () => {
    const connector = new MySqlConnector();
    const commitError = new Error("commit failed");

    const mockConnection = createMockConnection({
      commit: jest.fn((cb: Function) => cb(commitError)),
      rollback: jest.fn((cb: Function) => cb(null)),
      query: jest.fn((_sql: string, cb: Function) => cb(null)),
    });

    await expect(connector.commit(mockConnection)).rejects.toThrow(
      "commit failed",
    );
    expect(mockConnection.rollback).toHaveBeenCalledTimes(1);
  });

  it("should destroy connection when rollback in commit error path also fails", async () => {
    const connector = new MySqlConnector();
    const commitError = new Error("commit failed");
    const rollbackError = new Error("rollback failed");

    const mockConnection = createMockConnection({
      commit: jest.fn((cb: Function) => cb(commitError)),
      rollback: jest.fn((cb: Function) => cb(rollbackError)),
    });

    await expect(connector.commit(mockConnection)).rejects.toThrow(
      "commit failed",
    );
    expect(mockConnection.destroy).toHaveBeenCalledTimes(1);
    // release should NOT be called when destroy is called
    expect(mockConnection.release).not.toHaveBeenCalled();
  });

  it("should destroy connection when direct rollback fails", async () => {
    const connector = new MySqlConnector();
    const rollbackError = new Error("rollback failed");

    const mockConnection = createMockConnection({
      rollback: jest.fn((cb: Function) => cb(rollbackError)),
    });

    await expect(connector.rollback(mockConnection)).rejects.toThrow(
      "rollback failed",
    );
    expect(mockConnection.destroy).toHaveBeenCalledTimes(1);
    expect(mockConnection.release).not.toHaveBeenCalled();
  });

  it("should release connection after successful rollback and autocommit reset", async () => {
    const connector = new MySqlConnector();

    const mockConnection = createMockConnection({
      rollback: jest.fn((cb: Function) => cb(null)),
      query: jest.fn((_sql: string, cb: Function) => cb(null)),
    });

    await connector.rollback(mockConnection);
    expect(mockConnection.release).toHaveBeenCalledTimes(1);
    expect(mockConnection.destroy).not.toHaveBeenCalled();
  });

  it("should destroy connection when autocommit reset after rollback fails", async () => {
    const connector = new MySqlConnector();

    const mockConnection = createMockConnection({
      rollback: jest.fn((cb: Function) => cb(null)),
      query: jest.fn((_sql: string, cb: Function) =>
        cb(new Error("autocommit reset failed")),
      ),
    });

    await expect(connector.rollback(mockConnection)).rejects.toThrow(
      "autocommit reset failed",
    );
    expect(mockConnection.destroy).toHaveBeenCalledTimes(1);
    expect(mockConnection.release).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Issue #187: Cursor pagination NULL handling
// ═════════════════════════════════════════════════════════════════════════════

describe("Issue #187: Cursor pagination NULL handling", () => {
  let em: EntityManager;

  const ItemEntity = class Item {} as any;

  const itemMetadata = {
    name: "Item",
    target: ItemEntity,
    columns: [
      { name: "id", options: { primary: true, autoIncrement: true } },
      { name: "title", options: {} },
      { name: "createdAt", options: {} },
    ],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    em = createTestEntityManager();
    jest
      .spyOn((em as any).resolver, "resolveEntityMetadata")
      .mockReturnValue(itemMetadata);
    jest
      .spyOn((em as any).resolver, "getDeletedAtColumn")
      .mockReturnValue(null);
  });

  it("should include IS NULL condition in ASC cursor query", async () => {
    const cursor = encodeCursor(5);
    const rows = [
      { id: 6, title: "Item 6", createdAt: "2024-01-06" },
      { id: 7, title: "Item 7", createdAt: "2024-01-07" },
    ];
    mockQuery.mockResolvedValueOnce({ results: rows, fields: [] });

    await em.findWithCursor(ItemEntity, {
      take: 5,
      cursor,
      orderBy: "id",
      direction: "ASC",
    });

    const sqlCall = mockQuery.mock.calls[0][0];
    const sqlText = sqlCall.sql ?? sqlCall.text ?? String(sqlCall);
    // Verify the SQL includes IS NULL for NULL handling
    expect(sqlText).toContain("IS NULL");
    expect(sqlText).toContain(">");
  });

  it("should include IS NULL condition in DESC cursor query", async () => {
    const cursor = encodeCursor(100);
    const rows = [
      { id: 99, title: "Item 99", createdAt: "2024-01-99" },
      { id: 98, title: "Item 98", createdAt: "2024-01-98" },
    ];
    mockQuery.mockResolvedValueOnce({ results: rows, fields: [] });

    await em.findWithCursor(ItemEntity, {
      take: 5,
      cursor,
      orderBy: "id",
      direction: "DESC",
    });

    const sqlCall = mockQuery.mock.calls[0][0];
    const sqlText = sqlCall.sql ?? sqlCall.text ?? String(sqlCall);
    // Verify the SQL includes IS NULL for NULL handling in DESC
    expect(sqlText).toContain("IS NULL");
    expect(sqlText).toContain("<");
  });

  it("should use OR to combine cursor comparison with IS NULL", async () => {
    const cursor = encodeCursor(10);
    const rows = [{ id: 11, title: "Item 11", createdAt: "2024-01-11" }];
    mockQuery.mockResolvedValueOnce({ results: rows, fields: [] });

    await em.findWithCursor(ItemEntity, {
      take: 5,
      cursor,
      orderBy: "id",
    });

    const sqlCall = mockQuery.mock.calls[0][0];
    const sqlText = sqlCall.sql ?? sqlCall.text ?? String(sqlCall);
    // The condition should be: (col > ? OR col IS NULL)
    expect(sqlText).toContain("OR");
    expect(sqlText).toContain("IS NULL");
  });

  it("should not include IS NULL condition when no cursor is provided", async () => {
    const rows = [{ id: 1, title: "Item 1", createdAt: "2024-01-01" }];
    mockQuery.mockResolvedValueOnce({ results: rows, fields: [] });

    await em.findWithCursor(ItemEntity, { take: 5 });

    const sqlCall = mockQuery.mock.calls[0][0];
    const sqlText = sqlCall.sql ?? sqlCall.text ?? String(sqlCall);
    // Without a cursor, there should be no IS NULL from cursor logic
    expect(sqlText).not.toContain("IS NULL");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Issue #186: Entity inheritance
// ═════════════════════════════════════════════════════════════════════════════

describe("Issue #186: Entity inheritance", () => {
  // The @Entity decorator collects columns from the prototype chain,
  // so a child class should inherit parent's @Column metadata.

  // Define outside describe to allow decorator execution
  class BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: "datetime" })
    createdAt!: Date;

    @Column({ type: "datetime" })
    updatedAt!: Date;
  }

  @Entity()
  class ChildEntity extends BaseEntity {
    @Column({ type: "varchar", length: 255 })
    name!: string;

    @Column({ type: "text" })
    description!: string;
  }

  it("should include parent class columns in child entity metadata", () => {
    const metadata = Reflect.getMetadata(ENTITY_TOKEN, ChildEntity);

    expect(metadata).toBeDefined();
    expect(metadata.target).toBe(ChildEntity);

    const columnNames = metadata.columns.map((c: any) => c.name);
    // Parent columns
    expect(columnNames).toContain("id");
    expect(columnNames).toContain("createdAt");
    expect(columnNames).toContain("updatedAt");
    // Child columns
    expect(columnNames).toContain("name");
    expect(columnNames).toContain("description");
  });

  it("should have correct column count (parent + child)", () => {
    const metadata = Reflect.getMetadata(ENTITY_TOKEN, ChildEntity);
    // 3 from parent (id, createdAt, updatedAt) + 2 from child (name, description) = 5
    expect(metadata.columns.length).toBe(5);
  });

  it("should preserve column options from parent", () => {
    const metadata = Reflect.getMetadata(ENTITY_TOKEN, ChildEntity);
    const idColumn = metadata.columns.find((c: any) => c.name === "id");

    expect(idColumn).toBeDefined();
    expect(idColumn.options.primary).toBe(true);
    expect(idColumn.options.autoIncrement).toBe(true);
  });

  it("should preserve column types from parent", () => {
    const metadata = Reflect.getMetadata(ENTITY_TOKEN, ChildEntity);
    const createdAtCol = metadata.columns.find(
      (c: any) => c.name === "createdAt",
    );

    expect(createdAtCol).toBeDefined();
    expect(createdAtCol.options.type).toBe("datetime");
  });

  // Test deeper inheritance chain
  class GrandchildEntity extends ChildEntity {
    @Column({ type: "int" })
    level!: number;
  }

  // We need @Entity on Grandchild to generate metadata
  @Entity()
  class GrandchildEntityWithDecorator extends ChildEntity {
    @Column({ type: "int" })
    level!: number;
  }

  it("should support multi-level inheritance (grandchild)", () => {
    const metadata = Reflect.getMetadata(
      ENTITY_TOKEN,
      GrandchildEntityWithDecorator,
    );

    expect(metadata).toBeDefined();
    const columnNames = metadata.columns.map((c: any) => c.name);

    // BaseEntity columns
    expect(columnNames).toContain("id");
    expect(columnNames).toContain("createdAt");
    expect(columnNames).toContain("updatedAt");
    // ChildEntity columns
    expect(columnNames).toContain("name");
    expect(columnNames).toContain("description");
    // GrandchildEntity columns
    expect(columnNames).toContain("level");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Issue #185: Enum type consistency across drivers
// ═════════════════════════════════════════════════════════════════════════════

describe("Issue #185: Enum type consistency", () => {
  function createMockConnector(): any {
    return {
      connect: jest.fn(),
      getConnection: jest.fn(),
      query: jest.fn(),
      close: jest.fn(),
    };
  }

  it("PostgresDriver.castType('enum') should return 'USER-DEFINED'", () => {
    const driver = new PostgresDriver(createMockConnector());
    const result = driver.castType("enum");
    expect(result).toBe("USER-DEFINED");
  });

  it("SchemaDiff castTypePostgres('enum') should return 'USER-DEFINED'", () => {
    const schemaDiff = new SchemaDiff();
    // castTypePostgres is private, so we access it via castType which delegates
    const result = (schemaDiff as any).castTypePostgres("enum");
    expect(result).toBe("USER-DEFINED");
  });

  it("SchemaGenerator castType('enum') for postgres should return 'USER-DEFINED'", () => {
    const generator = new SchemaGenerator({ dialect: "postgres" });
    // castType delegates to the ColumnDefinitionBuilder
    const result = (generator as any).castType("enum");
    expect(result).toBe("USER-DEFINED");
  });

  it("all three sources should match for enum type", () => {
    const driver = new PostgresDriver(createMockConnector());
    const schemaDiff = new SchemaDiff();
    const generator = new SchemaGenerator({ dialect: "postgres" });

    const driverResult = driver.castType("enum");
    const schemaDiffResult = (schemaDiff as any).castTypePostgres("enum");
    const generatorResult = (generator as any).castType("enum");

    expect(driverResult).toBe(schemaDiffResult);
    expect(schemaDiffResult).toBe(generatorResult);
    expect(driverResult).toBe("USER-DEFINED");
  });

  it("MySQL driver should NOT return USER-DEFINED for enum", () => {
    const { MySqlDriver } = require("../../src/dialects/mysql/MySqlDriver");
    const driver = new MySqlDriver();
    const result = driver.castType("enum");
    // MySQL uses native ENUM, not USER-DEFINED
    expect(result).not.toBe("USER-DEFINED");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Issue #183: afterLoad event
// ═════════════════════════════════════════════════════════════════════════════

describe("Issue #183: afterLoad event", () => {
  let em: EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    em = createTestEntityManager();
    setupEmMocks(em);
  });

  it("should call afterLoad for each entity returned by find()", async () => {
    const afterLoadSpy = jest.fn();
    const sub: EntitySubscriber<TestUser> = {
      listenTo: () => TestUser,
      afterLoad: afterLoadSpy,
    };

    em.addSubscriber(sub);

    // find() goes through executeReadOnly which calls session.query
    mockQuery.mockResolvedValueOnce({
      results: [
        { id: 1, name: "Alice", email: "alice@test.com" },
        { id: 2, name: "Bob", email: "bob@test.com" },
      ],
      fields: [],
    });

    await em.find(TestUser, {});

    expect(afterLoadSpy).toHaveBeenCalledTimes(2);
  });

  it("should call afterLoad with the loaded entity instance", async () => {
    const afterLoadSpy = jest.fn();
    const sub: EntitySubscriber<TestUser> = {
      listenTo: () => TestUser,
      afterLoad: afterLoadSpy,
    };

    em.addSubscriber(sub);

    mockQuery.mockResolvedValueOnce({
      results: [{ id: 1, name: "Alice", email: "alice@test.com" }],
      fields: [],
    });

    await em.find(TestUser, {});

    expect(afterLoadSpy).toHaveBeenCalledTimes(1);
    const loadedEntity = afterLoadSpy.mock.calls[0][0];
    expect(loadedEntity).toBeDefined();
    // The entity should have the data from the query result
    expect(loadedEntity.name).toBe("Alice");
  });

  it("should NOT call afterLoad for a different entity type", async () => {
    const afterLoadSpy = jest.fn();
    const sub: EntitySubscriber<TestPost> = {
      listenTo: () => TestPost,
      afterLoad: afterLoadSpy,
    };

    em.addSubscriber(sub);

    mockQuery.mockResolvedValueOnce({
      results: [{ id: 1, name: "Alice", email: "alice@test.com" }],
      fields: [],
    });

    await em.find(TestUser, {});

    expect(afterLoadSpy).not.toHaveBeenCalled();
  });

  it("should call afterLoad for entities from findWithCursor()", async () => {
    const afterLoadSpy = jest.fn();
    const sub: EntitySubscriber<TestUser> = {
      listenTo: () => TestUser,
      afterLoad: afterLoadSpy,
    };

    em.addSubscriber(sub);

    // Override metadata mock for findWithCursor
    jest
      .spyOn((em as any).resolver, "resolveEntityMetadata")
      .mockReturnValue(userMetadata);

    mockQuery.mockResolvedValueOnce({
      results: [
        { id: 1, name: "Alice", email: "alice@test.com" },
        { id: 2, name: "Bob", email: "bob@test.com" },
        { id: 3, name: "Charlie", email: "charlie@test.com" },
      ],
      fields: [],
    });

    await em.findWithCursor(TestUser, { take: 5 });

    expect(afterLoadSpy).toHaveBeenCalledTimes(3);
  });

  it("should not call afterLoad when no results are returned", async () => {
    const afterLoadSpy = jest.fn();
    const sub: EntitySubscriber<TestUser> = {
      listenTo: () => TestUser,
      afterLoad: afterLoadSpy,
    };

    em.addSubscriber(sub);

    mockQuery.mockResolvedValueOnce({
      results: [],
      fields: [],
    });

    await em.find(TestUser, {});

    expect(afterLoadSpy).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Issue #182: Transaction lifecycle events
// ═════════════════════════════════════════════════════════════════════════════

describe("Issue #182: Transaction lifecycle events", () => {
  let em: EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    em = new EntityManager();

    // Set up basic mocks for save to work
    jest
      .spyOn((em as any).resolver, "resolveEntityMetadata")
      .mockImplementation((entity: any) => {
        if (entity === TestUser) return userMetadata;
        if (entity === TestPost) return postMetadata;
        return null;
      });
    jest.spyOn(em as any, "isMySqlFamily").mockReturnValue(true);
    jest.spyOn(em as any, "isPostgres").mockReturnValue(false);
    jest.spyOn(em as any, "isSqlite").mockReturnValue(false);
    jest
      .spyOn(em as any, "wrap")
      .mockImplementation((...args: any[]) => `\`${args[0]}\``);
    jest.spyOn(em as any, "wrapTable").mockImplementation(
      (...args: any[]) => `\`${args[0]}\``,
    );
    jest
      .spyOn((em as any).resolver, "resolveOneToOneMetadata")
      .mockReturnValue([]);
    jest
      .spyOn((em as any).resolver, "resolveManyToOneMetadata")
      .mockReturnValue([]);
    jest
      .spyOn((em as any).resolver, "resolveOneToManyMetadata")
      .mockReturnValue([]);
    jest
      .spyOn((em as any).cascadeHandler, "runHooks")
      .mockResolvedValue(undefined);
    jest
      .spyOn((em as any).cascadeHandler, "cascadeSaveOneToMany")
      .mockResolvedValue(undefined);
    jest
      .spyOn((em as any).cascadeHandler, "cascadeSaveManyToOne")
      .mockResolvedValue(undefined);
    jest
      .spyOn((em as any).resolver, "getDeletedAtColumn")
      .mockReturnValue(null);
    jest
      .spyOn((em as any).resolver, "getVersionColumn")
      .mockReturnValue(null);
    jest
      .spyOn(em as any, "findOneInternal")
      .mockResolvedValue(undefined);
    jest
      .spyOn(em as any, "hasEagerRelations")
      .mockReturnValue(false);
    jest
      .spyOn(em as any, "getComputedColumnNames")
      .mockReturnValue(new Set());
  });

  it("should call transaction lifecycle subscribers in correct order on successful transaction", async () => {
    const events: string[] = [];

    const sub: EntitySubscriber<TestUser> = {
      listenTo: () => TestUser,
      beforeTransactionStart: () => {
        events.push("beforeTransactionStart");
      },
      afterTransactionStart: () => {
        events.push("afterTransactionStart");
      },
      beforeTransactionCommit: () => {
        events.push("beforeTransactionCommit");
      },
      afterTransactionCommit: () => {
        events.push("afterTransactionCommit");
      },
    };

    em.addSubscriber(sub);

    // Mock query for SET autocommit = 0 and INSERT
    mockQuery
      .mockResolvedValueOnce(undefined) // SET autocommit = 0
      .mockResolvedValueOnce({
        results: { insertId: 1, affectedRows: 1 },
        fields: [],
      });

    await em.save(TestUser, { name: "Alice", email: "alice@test.com" });

    expect(events).toEqual([
      "beforeTransactionStart",
      "afterTransactionStart",
      "beforeTransactionCommit",
      "afterTransactionCommit",
    ]);
  });

  it("should call rollback lifecycle subscribers when transaction fails", async () => {
    const events: string[] = [];

    const sub: EntitySubscriber<TestUser> = {
      listenTo: () => TestUser,
      beforeTransactionStart: () => {
        events.push("beforeTransactionStart");
      },
      afterTransactionStart: () => {
        events.push("afterTransactionStart");
      },
      beforeTransactionRollback: () => {
        events.push("beforeTransactionRollback");
      },
      afterTransactionRollback: () => {
        events.push("afterTransactionRollback");
      },
    };

    em.addSubscriber(sub);

    // Mock: autocommit query succeeds, then INSERT query fails
    mockQuery
      .mockResolvedValueOnce(undefined) // SET autocommit = 0
      .mockRejectedValueOnce(new Error("INSERT failed"));

    await expect(
      em.save(TestUser, { name: "Alice", email: "alice@test.com" }),
    ).rejects.toThrow("INSERT failed");

    expect(events).toContain("beforeTransactionStart");
    expect(events).toContain("afterTransactionStart");
    expect(events).toContain("beforeTransactionRollback");
    expect(events).toContain("afterTransactionRollback");
  });

  it("should call notifyTransactionSubscribers for all subscribers regardless of entity type", async () => {
    const events: string[] = [];

    const userSub: EntitySubscriber<TestUser> = {
      listenTo: () => TestUser,
      beforeTransactionStart: () => {
        events.push("user:beforeTxStart");
      },
    };

    const postSub: EntitySubscriber<TestPost> = {
      listenTo: () => TestPost,
      beforeTransactionStart: () => {
        events.push("post:beforeTxStart");
      },
    };

    em.addSubscriber(userSub);
    em.addSubscriber(postSub);

    // Directly call notifyTransactionSubscribers
    await (em as any).notifyTransactionSubscribers("beforeTransactionStart");

    // Transaction subscribers fire for ALL subscribers regardless of entity type
    expect(events).toContain("user:beforeTxStart");
    expect(events).toContain("post:beforeTxStart");
  });

  it("should handle all six transaction lifecycle events", async () => {
    const events: string[] = [];

    const sub: EntitySubscriber<TestUser> = {
      listenTo: () => TestUser,
      beforeTransactionStart: () => {
        events.push("beforeTxStart");
      },
      afterTransactionStart: () => {
        events.push("afterTxStart");
      },
      beforeTransactionCommit: () => {
        events.push("beforeTxCommit");
      },
      afterTransactionCommit: () => {
        events.push("afterTxCommit");
      },
      beforeTransactionRollback: () => {
        events.push("beforeTxRollback");
      },
      afterTransactionRollback: () => {
        events.push("afterTxRollback");
      },
    };

    em.addSubscriber(sub);

    // Test all six events via direct calls
    await (em as any).notifyTransactionSubscribers("beforeTransactionStart");
    await (em as any).notifyTransactionSubscribers("afterTransactionStart");
    await (em as any).notifyTransactionSubscribers("beforeTransactionCommit");
    await (em as any).notifyTransactionSubscribers("afterTransactionCommit");
    await (em as any).notifyTransactionSubscribers(
      "beforeTransactionRollback",
    );
    await (em as any).notifyTransactionSubscribers("afterTransactionRollback");

    expect(events).toEqual([
      "beforeTxStart",
      "afterTxStart",
      "beforeTxCommit",
      "afterTxCommit",
      "beforeTxRollback",
      "afterTxRollback",
    ]);
  });

  it("should not throw if subscriber has no transaction lifecycle methods", async () => {
    const sub: EntitySubscriber<TestUser> = {
      listenTo: () => TestUser,
      // Only afterLoad defined, no transaction lifecycle methods
      afterLoad: jest.fn(),
    };

    em.addSubscriber(sub);

    await expect(
      (em as any).notifyTransactionSubscribers("beforeTransactionStart"),
    ).resolves.not.toThrow();
    await expect(
      (em as any).notifyTransactionSubscribers("afterTransactionCommit"),
    ).resolves.not.toThrow();
  });
});
