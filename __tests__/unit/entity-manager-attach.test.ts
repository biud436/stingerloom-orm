/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Regression coverage for `EntityManager.attach()` (#294).
 *
 * `attach()` is the codepath that lets a second `EntityManager` reuse an
 * already-registered `DatabaseClient` connection without opening a new pool —
 * the linchpin of the `tenantStrategy: "database"` router's resolver-string
 * branch. Pre-#294 there were zero tests calling it directly: a future
 * refactor that reverted to `register()` (re-creating the connector and
 * silently leaking the old pool, the original PR #269 bug) would have left
 * the suite green.
 */

function resetDatabaseClient() {
  const { DatabaseClient } = require("../../src/DatabaseClient");
  (DatabaseClient as any).instance = undefined;
  return DatabaseClient;
}

// Mock SqliteConnector so attach() can exercise the full initializeFromConnection
// pipeline (driver/dataSource construction, ctx wiring) without opening a real
// pool. The constructor is a `jest.fn()` so we can count instantiations across
// register() vs attach() — the central guarantee of attach() is "no new pool".
const sqliteConnectorCtor = jest.fn().mockImplementation(() => ({
  connect: jest.fn().mockResolvedValue(undefined),
  close: jest.fn().mockResolvedValue(undefined),
  // Minimal shape SqliteDriver / SqliteDataSource read at construction time.
  _db: {},
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  commit: jest.fn().mockResolvedValue(undefined),
  rollback: jest.fn().mockResolvedValue(undefined),
  executeQuery: jest.fn().mockResolvedValue([]),
  executeRaw: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../src/dialects/sqlite/SqliteConnector", () => ({
  SqliteConnector: sqliteConnectorCtor,
}));

import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { OrmError } from "../../src/errors/OrmError";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";
import { SnakeNamingStrategy } from "../../src/core/generators/SnakeNamingStrategy";
import type { DatabaseClientOptions } from "../../src/core/DatabaseClientOptions";

const BASE_OPTIONS: DatabaseClientOptions = {
  type: "sqlite",
  database: ":memory:",
  entities: [],
};

describe("EntityManager.attach() — pool-leak regression (#294)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetDatabaseClient();
  });

  it("reuses the same connector held by DatabaseClient — no new pool created", async () => {
    const DatabaseClient = require("../../src/DatabaseClient").DatabaseClient;
    const client = DatabaseClient.getInstance();

    // Owner EM creates the pool via the standard register() path.
    const owner = new EntityManager();
    await owner.register({ ...BASE_OPTIONS }, "shared");

    expect(sqliteConnectorCtor).toHaveBeenCalledTimes(1);
    const ownerConnector = client.getConnection("shared");

    // attach() must NOT call SqliteConnector again — that's the whole point.
    const second = new EntityManager();
    await second.attach("shared");

    expect(sqliteConnectorCtor).toHaveBeenCalledTimes(1);
    expect(client.getConnection("shared")).toBe(ownerConnector);
    // Both EMs must end up bound to the same connector instance.
    expect((second as any).driver).toBeDefined();
    expect((second as any).driver.connector ?? (second as any).driver["connector"])
      .toBe(ownerConnector);
  });

  it("forces synchronize=false even when the override requests synchronize=true", async () => {
    // Owner registered with synchronize: true (worst-case scenario where the
    // attached EM would otherwise re-fire DDL through the same options entry).
    const owner = new EntityManager();
    await owner.register({ ...BASE_OPTIONS, synchronize: true }, "sync-shared");

    const attached = new EntityManager();
    await attached.attach("sync-shared", { synchronize: true });

    // The contract: an attached EM never re-DDLs, regardless of overrides or
    // the original options. Verified through the public _ctx contract that
    // SchemaRegistrar.registerEntities() reads.
    const ctx = (attached as any)._ctx;
    expect(ctx.getSynchronize()).toBe(false);

    // Sanity: the owning EM still reflects its own configured synchronize.
    const ownerCtx = (owner as any)._ctx;
    expect(ownerCtx.getSynchronize()).toBe(true);
  });

  it("throws OrmError(NOT_CONNECTED) with the registered-name hint when the name is unknown", async () => {
    const em = new EntityManager();
    let caught: unknown;
    try {
      await em.attach("not-registered");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(OrmError);
    expect((caught as OrmError).code).toBe(OrmErrorCode.NOT_CONNECTED);
    expect((caught as OrmError).message).toContain("not-registered");
    // Suggestion must point at DatabaseClient.connect() — that's the actionable fix.
    expect(((caught as OrmError) as any).suggestion ?? "").toMatch(/connect/i);
  });

  it("applies a namingStrategy override even when the original registration had none", async () => {
    const owner = new EntityManager();
    await owner.register({ ...BASE_OPTIONS }, "naming-shared");

    // Owner has no naming strategy → DefaultNamingStrategy (camelCase passthrough).
    // The strategy lives on the per-EM SchemaRegistrar; attach() must build a
    // fresh SchemaRegistrar with the override, not mutate the owner's.
    const ownerStrategy = (owner as any).schemaRegistrar?.namingStrategy;

    const attached = new EntityManager();
    await attached.attach("naming-shared", {
      namingStrategy: new SnakeNamingStrategy(),
    });

    const attachedStrategy = (attached as any).schemaRegistrar?.namingStrategy;
    expect(attachedStrategy).toBeInstanceOf(SnakeNamingStrategy);
    // The owner must keep its original (non-snake) strategy — attach() never
    // touches the registering EM's SchemaRegistrar.
    expect(ownerStrategy).not.toBeInstanceOf(SnakeNamingStrategy);
  });

  it("multiple EMs attached to the same connection share the underlying pool", async () => {
    const DatabaseClient = require("../../src/DatabaseClient").DatabaseClient;
    const client = DatabaseClient.getInstance();

    const owner = new EntityManager();
    await owner.register({ ...BASE_OPTIONS }, "multi-shared");

    const a = new EntityManager();
    const b = new EntityManager();
    await a.attach("multi-shared");
    await b.attach("multi-shared");

    // Three EMs (owner + a + b) but only one connector instance was ever created.
    expect(sqliteConnectorCtor).toHaveBeenCalledTimes(1);
    const shared = client.getConnection("multi-shared");
    expect((a as any).driver.connector ?? (a as any).driver["connector"]).toBe(shared);
    expect((b as any).driver.connector ?? (b as any).driver["connector"]).toBe(shared);
  });
});
