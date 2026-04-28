/**
 * Regression test for issue #278.
 *
 * `EntityManager.executeInTransaction()` previously called
 * `this.dirtyEntities.clear()` in its finally block. Because `dirtyEntities`
 * is a single instance-wide Set on a shared (NestJS singleton) EntityManager,
 * a finishing transaction would wipe dirty-state belonging to non-tx writers
 * and to other concurrent transactions.
 *
 * The fix removes the `clear()` — partitioning lives entirely in
 * `txDirtyEntities` (a WeakMap keyed by TransactionSessionManager), and
 * the per-session entry is the only thing the finally block must drop.
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

const sessionInstances: any[] = [];
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockStartTransaction = jest.fn().mockResolvedValue(undefined);
const mockCommit = jest.fn().mockResolvedValue(undefined);
const mockRollback = jest.fn().mockResolvedValue(undefined);
const mockClose = jest.fn().mockResolvedValue(undefined);
const mockQuery = jest.fn().mockResolvedValue({ results: [], fields: [] });

jest.mock("../../src/dialects/TransactionSessionManager", () => {
  return {
    TransactionSessionManager: jest.fn().mockImplementation(() => {
      const instance = {
        connect: mockConnect,
        startTransaction: mockStartTransaction,
        query: mockQuery,
        commit: mockCommit,
        rollback: mockRollback,
        close: mockClose,
      };
      sessionInstances.push(instance);
      return instance;
    }),
  };
});

import { EntityManager } from "../../src/core/EntityManager";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";

@Entity()
class DirtyTestEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  name!: string;
}

function createEm(): EntityManager {
  const em = new EntityManager();
  (em as any).driver = { wrap: (n: string) => `\`${n}\`` };
  (em as any).dbType = "mysql";
  return em;
}

describe("EntityManager dirtyEntities transaction isolation (regression #278)", () => {
  beforeEach(() => {
    sessionInstances.length = 0;
    jest.clearAllMocks();
  });

  it("does not wipe non-tx dirty state when a transaction commits", async () => {
    const em = createEm();
    const dirtySet: Set<unknown> = (em as any).dirtyEntities;

    const nonTxEntity = new DirtyTestEntity();
    nonTxEntity.id = 1;
    nonTxEntity.name = "outside-tx";

    // Simulate a non-tx writer: markDirty() outside any transaction lands in
    // the shared instance Set.
    (em as any)._ctx.markDirty(nonTxEntity);
    expect(dirtySet.has(nonTxEntity)).toBe(true);

    await em.transaction(async () => {
      const txEntity = new DirtyTestEntity();
      txEntity.id = 2;
      txEntity.name = "inside-tx";
      (em as any)._ctx.markDirty(txEntity);
      // tx-scoped writes never touch the shared Set
      expect(dirtySet.has(txEntity)).toBe(false);
    });

    expect(mockCommit).toHaveBeenCalledTimes(1);
    // The non-tx writer's entry must survive the tx finally block.
    expect(dirtySet.has(nonTxEntity)).toBe(true);
  });

  it("does not wipe non-tx dirty state when a transaction rolls back", async () => {
    const em = createEm();
    const dirtySet: Set<unknown> = (em as any).dirtyEntities;

    const nonTxEntity = new DirtyTestEntity();
    nonTxEntity.id = 10;
    nonTxEntity.name = "survives-rollback";
    (em as any)._ctx.markDirty(nonTxEntity);

    await expect(
      em.transaction(async () => {
        throw new Error("rollback me");
      }),
    ).rejects.toThrow("rollback me");

    expect(mockRollback).toHaveBeenCalledTimes(1);
    expect(dirtySet.has(nonTxEntity)).toBe(true);
  });

  it("isolates two concurrent transactions: each removes only its own session entry", async () => {
    const em = createEm();
    const txDirty: WeakMap<any, Set<unknown>> = (em as any).txDirtyEntities;

    // Coordinate the two transactions so they overlap: both markDirty,
    // both observe each other's session, then both commit.
    let resolveBoth: () => void = () => {};
    const bothEntered = new Promise<void>((r) => {
      let count = 0;
      resolveBoth = () => {
        count += 1;
        if (count === 2) r();
      };
    });

    const captured: Array<{ session: any; entity: DirtyTestEntity }> = [];

    const txA = em.transaction(async () => {
      const { transactionStorage } = await import(
        "../../src/decorators/Transactional"
      );
      const session = transactionStorage.getStore();
      const e = new DirtyTestEntity();
      e.id = 100;
      e.name = "A";
      (em as any)._ctx.markDirty(e);
      captured.push({ session, entity: e });
      resolveBoth();
      await bothEntered;
      // At this point both sessions exist in txDirty
      expect(txDirty.has(session)).toBe(true);
    });

    const txB = em.transaction(async () => {
      const { transactionStorage } = await import(
        "../../src/decorators/Transactional"
      );
      const session = transactionStorage.getStore();
      const e = new DirtyTestEntity();
      e.id = 200;
      e.name = "B";
      (em as any)._ctx.markDirty(e);
      captured.push({ session, entity: e });
      resolveBoth();
      await bothEntered;
      expect(txDirty.has(session)).toBe(true);
    });

    await Promise.all([txA, txB]);

    expect(captured).toHaveLength(2);
    expect(captured[0].session).not.toBe(captured[1].session);
    // After both commits, each session entry has been deleted.
    expect(txDirty.has(captured[0].session)).toBe(false);
    expect(txDirty.has(captured[1].session)).toBe(false);
    expect(mockCommit).toHaveBeenCalledTimes(2);
  });
});
