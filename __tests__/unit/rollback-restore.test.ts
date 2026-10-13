/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * restoreOnRollback: the properties a write changes on the caller's objects
 * are put back when the transaction rolls back, unless the caller changed
 * them again since.
 */
import "reflect-metadata";
import { TransactionSessionManager } from "../../src/dialects/TransactionSessionManager";
import { restoreOnRollback } from "../../src/core/entity-manager/rollback-restore";

async function openSession(): Promise<TransactionSessionManager> {
  const session = new TransactionSessionManager();
  (session as any).connection = {};
  (session as any).dataSource = {
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
  };
  await session.startTransaction();
  return session;
}

describe("restoreOnRollback", () => {
  it("removes properties the write added and puts back the ones it changed", async () => {
    const session = await openSession();
    const createdAt = new Date("2026-01-01T00:00:00Z");
    const item: Record<string, unknown> = { title: "a", tenantId: null, createdAt };

    await restoreOnRollback(session, [item], async () => {
      item.id = 1;
      item.tenantId = "acme";
      item.createdAt = new Date();
    });
    expect(item).toEqual({ title: "a", tenantId: "acme", createdAt: expect.any(Date), id: 1 });

    await session.rollback();

    expect(item).toEqual({ title: "a", tenantId: null, createdAt });
    expect(item.createdAt).toBe(createdAt);
    expect("id" in item).toBe(false);
  });

  it("keeps what the write left when the transaction commits", async () => {
    const session = await openSession();
    const item: Record<string, unknown> = { title: "a" };

    await restoreOnRollback(session, [item], async () => {
      item.id = 1;
    });
    await session.commit();

    expect(item).toEqual({ title: "a", id: 1 });
  });

  it("keeps a value the caller set after the write", async () => {
    const session = await openSession();
    const item: Record<string, unknown> = { title: "a" };

    await restoreOnRollback(session, [item], async () => {
      item.id = 1;
      item.version = 1;
    });
    item.id = 42;
    item.title = "edited";

    await session.rollback();

    expect(item).toEqual({ id: 42, title: "edited" });
  });

  it("restores what a write changed before it threw", async () => {
    const session = await openSession();
    const item: Record<string, unknown> = { title: "a" };

    await expect(
      restoreOnRollback(session, [item], async () => {
        item.id = 1;
        throw new Error("child insert failed");
      }),
    ).rejects.toThrow("child insert failed");
    expect(item.id).toBe(1);

    await session.rollback();

    expect(item).toEqual({ title: "a" });
  });

  it("restores each of several targets", async () => {
    const session = await openSession();
    const items: Record<string, unknown>[] = [{ title: "a" }, { title: "b" }];

    await restoreOnRollback(session, items, async () => {
      items.forEach((item, i) => (item.id = i + 1));
    });
    await session.rollback();

    expect(items).toEqual([{ title: "a" }, { title: "b" }]);
  });

  it("restores a class instance's declared fields", async () => {
    class Doc {
      id: number | undefined = undefined;
      title = "a";
    }
    const session = await openSession();
    const doc = new Doc();

    await restoreOnRollback(session, [doc], async () => {
      doc.id = 1;
    });
    await session.rollback();

    expect(doc.id).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(doc, "id")).toBe(true);
    expect(doc).toBeInstanceOf(Doc);
  });

  it("restores the data behind an own accessor and leaves the accessor alone", async () => {
    const session = await openSession();
    const item: Record<string, unknown> = { first: "kim" };
    Object.defineProperty(item, "label", {
      get: () => `#${String(item.id ?? "new")} ${String(item.first)}`,
      enumerable: true,
    });

    await restoreOnRollback(session, [item], async () => {
      item.id = 1;
    });
    expect(item.label).toBe("#1 kim");
    await session.rollback();

    expect(item.label).toBe("#new kim");
    expect("id" in item).toBe(false);
  });

  it("does nothing without an open transaction", async () => {
    const session = new TransactionSessionManager();
    const onRollback = jest.spyOn(session, "onRollback");
    const item: Record<string, unknown> = { title: "a" };

    const result = await restoreOnRollback(session, [item], async () => {
      item.id = 1;
      return "saved";
    });

    expect(result).toBe("saved");
    expect(onRollback).not.toHaveBeenCalled();
    expect(item.id).toBe(1);
  });

  it("skips targets that are not objects", async () => {
    const session = await openSession();

    await expect(
      restoreOnRollback(session, [null, undefined, 3, "x"], async () => "done"),
    ).resolves.toBe("done");
    await expect(session.rollback()).resolves.toBeUndefined();
  });
});
