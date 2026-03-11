/**
 * Regression test for falsy WHERE values (0, false, "").
 *
 * Previously, `find()` and `explain()` used `if (value)` to check WHERE
 * condition values, which would skip legitimate falsy values like 0, false,
 * and empty string "". The fix changes this to `if (value !== undefined && value !== null)`.
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
class FalsyTestEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ type: "boolean" })
  active!: boolean;

  @Column({ type: "int" })
  count!: number;
}

function createTestEntityManager() {
  const em = new EntityManager();
  (em as any).driver = {
    wrap: (name: string) => `\`${name}\``,
    supportsExplain: () => true,
    buildExplainSql: () => "EXPLAIN ",
  };
  (em as any).dbType = "mysql";
  return em;
}

function setupMocks(em: EntityManager) {
  const metadata = {
    name: "FalsyTestEntity",
    target: FalsyTestEntity,
    columns: [
      { name: "id", options: { primary: true, autoIncrement: true } },
      { name: "name", options: {} },
      { name: "active", options: {} },
      { name: "count", options: {} },
    ],
  };
  jest.spyOn((em as any).resolver, "resolveEntityMetadata").mockReturnValue(metadata);
  jest.spyOn((em as any).resolver, "resolveManyToOneMetadata").mockReturnValue([]);
  jest.spyOn((em as any).resolver, "resolveOneToOneMetadata").mockReturnValue([]);
  jest.spyOn((em as any).resolver, "resolveOneToManyMetadata").mockReturnValue([]);
  jest.spyOn((em as any).resolver, "resolveManyToManyMetadata").mockReturnValue([]);
  jest.spyOn((em as any).resolver, "getDeletedAtColumn").mockReturnValue(null);
}

describe("find() WHERE with falsy values (regression)", () => {
  let em: EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    em = createTestEntityManager();
    setupMocks(em);
  });

  it("should include WHERE condition when value is 0", async () => {
    mockQuery.mockResolvedValue({
      results: [{ id: 1, name: "Zero", active: true, count: 0 }],
      fields: [],
    });

    await em.find(FalsyTestEntity, {
      where: { count: 0 } as any,
    });

    // Check that the query was called with a SQL that includes the 0 condition
    const queryCall = mockQuery.mock.calls.find(
      (call: any[]) => typeof call[0] !== "string",
    );
    expect(queryCall).toBeDefined();
    const sqlObj = queryCall![0];
    const sqlText = sqlObj.text ?? sqlObj.sql ?? String(sqlObj);
    expect(sqlText).toContain("`count`");
  });

  it("should include WHERE condition when value is false", async () => {
    mockQuery.mockResolvedValue({
      results: [{ id: 1, name: "Inactive", active: false, count: 5 }],
      fields: [],
    });

    await em.find(FalsyTestEntity, {
      where: { active: false } as any,
    });

    const queryCall = mockQuery.mock.calls.find(
      (call: any[]) => typeof call[0] !== "string",
    );
    expect(queryCall).toBeDefined();
    const sqlObj = queryCall![0];
    const sqlText = sqlObj.text ?? sqlObj.sql ?? String(sqlObj);
    expect(sqlText).toContain("`active`");
  });

  it("should include WHERE condition when value is empty string", async () => {
    mockQuery.mockResolvedValue({
      results: [{ id: 1, name: "", active: true, count: 1 }],
      fields: [],
    });

    await em.find(FalsyTestEntity, {
      where: { name: "" } as any,
    });

    const queryCall = mockQuery.mock.calls.find(
      (call: any[]) => typeof call[0] !== "string",
    );
    expect(queryCall).toBeDefined();
    const sqlObj = queryCall![0];
    const sqlText = sqlObj.text ?? sqlObj.sql ?? String(sqlObj);
    // The WHERE clause should contain the `name` column
    expect(sqlText).toContain("`name`");
  });

  it("should still skip WHERE condition when value is null", async () => {
    mockQuery.mockResolvedValue({
      results: [{ id: 1, name: "Test", active: true, count: 1 }],
      fields: [],
    });

    await em.find(FalsyTestEntity, {
      where: { name: null } as any,
    });

    // For the SELECT query (skip SET autocommit), the text should NOT have `name` in WHERE
    const queryCall = mockQuery.mock.calls.find(
      (call: any[]) => {
        const arg = call[0];
        if (typeof arg === "string") return false;
        const text = arg.text ?? arg.sql ?? String(arg);
        return text.includes("SELECT");
      },
    );
    expect(queryCall).toBeDefined();
    const sqlObj = queryCall![0];
    const sqlText = sqlObj.text ?? sqlObj.sql ?? String(sqlObj);
    // With null value, WHERE should not contain name = null condition
    expect(sqlText).not.toMatch(/`name`\s*=/);
  });

  it("should still skip WHERE condition when value is undefined", async () => {
    mockQuery.mockResolvedValue({
      results: [{ id: 1, name: "Test", active: true, count: 1 }],
      fields: [],
    });

    await em.find(FalsyTestEntity, {
      where: { name: undefined } as any,
    });

    const queryCall = mockQuery.mock.calls.find(
      (call: any[]) => {
        const arg = call[0];
        if (typeof arg === "string") return false;
        const text = arg.text ?? arg.sql ?? String(arg);
        return text.includes("SELECT");
      },
    );
    expect(queryCall).toBeDefined();
    const sqlObj = queryCall![0];
    const sqlText = sqlObj.text ?? sqlObj.sql ?? String(sqlObj);
    expect(sqlText).not.toMatch(/`name`\s*=/);
  });
});

describe("propagateShutdown() resource cleanup", () => {
  it("should clear all internal state on shutdown", async () => {
    const em = new EntityManager();
    (em as any).driver = {
      wrap: (name: string) => `\`${name}\``,
    };

    // Add some state
    const listener = jest.fn();
    em.on("beforeInsert", listener);
    em.addSubscriber({ listenTo: () => FalsyTestEntity } as any);
    (em as any).dirtyEntities.add({});
    (em as any).queryTracker = { getLog: () => [], reset: jest.fn() };
    (em as any).replication["router"] = { resetFailedSlaves: jest.fn() };

    // Call propagateShutdown
    await em.propagateShutdown();

    // Verify cleanup
    expect((em as any).subscribers.length).toBe(0);
    expect((em as any).dirtyEntities.size).toBe(0);
    expect((em as any).queryTracker).toBeNull();
    expect((em as any).replication["router"]).toBeNull();
  });
});
