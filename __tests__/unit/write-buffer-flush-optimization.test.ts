/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { COLUMN_TOKEN } from "../../src/decorators/Column";
import { ENTITY_TOKEN } from "../../src/decorators/Entity";

// We test the hasQueuedWork optimization by verifying that flush() does not
// call strategy.diff() when only queues are empty and no tracked entries exist.

class Item {
  id!: number;
  name!: string;
}

Reflect.defineMetadata(ENTITY_TOKEN, { name: "Item", tableName: "items" }, Item);
Reflect.defineMetadata(
  COLUMN_TOKEN,
  [
    { target: Item, name: "id", propertyKey: "id", type: Number, options: { primary: true, autoIncrement: true } },
    { target: Item, name: "name", propertyKey: "name", type: String, options: {} },
  ],
  Item.prototype,
);

// Since WriteBuffer depends heavily on EntityManager and PluginContext,
// we test the hasQueuedWork logic in isolation by importing the class
// and checking internal state.

describe("WriteBuffer flush optimization", () => {
  // Test the concept: when queues are empty and no tracked entries,
  // flush should be a no-op without computing any diffs
  it("should return no-op result when nothing is queued and no entries tracked", async () => {
    // We dynamically import to avoid complex mock setup at module level
    const { WriteBuffer } = await import("../../src/core/plugin/buffer/WriteBuffer");

    // Create a minimal mock context
    const mockEm = {
      save: jest.fn(),
      delete: jest.fn(),
      query: jest.fn(),
      find: jest.fn(),
      withTransaction: jest.fn().mockImplementation((fn: any) => fn(mockEm)),
    };

    const mockCtx = {
      em: mockEm,
      getEntities: () => [],
    };

    const buffer = new WriteBuffer(mockCtx as any, {});
    const result = await buffer.flush();

    expect(result).toEqual({ updates: 0, inserts: 0, deletes: 0 });
    // save/delete should never have been called
    expect(mockEm.save).not.toHaveBeenCalled();
    expect(mockEm.delete).not.toHaveBeenCalled();
    expect(buffer.preview()).toEqual([]);
  });

  // These two used to re-declare hasQueuedWork() inside the test file and
  // assert their own closure, which said nothing about WriteBuffer (the
  // shipping method is private). They drive the real buffer through its public
  // surface — size()/preview()/flush() — instead.
  it("a queued insert takes flush() off the no-op path", async () => {
    const { WriteBuffer } = await import("../../src/core/plugin/buffer/WriteBuffer");

    const mockEm: any = {
      save: jest.fn().mockResolvedValue({ id: 1, name: "queued" }),
      delete: jest.fn(),
      update: jest.fn(),
      query: jest.fn(),
      find: jest.fn(),
      transaction: jest.fn().mockImplementation((fn: any) => fn(mockEm)),
    };
    const buffer = new WriteBuffer(
      { em: mockEm, getEntities: () => [Item] } as any,
      {},
    );

    buffer.save(Item, { name: "queued" });
    expect(buffer.size().inserts).toBe(1);

    const result = await buffer.flush();

    expect(mockEm.save).toHaveBeenCalledWith(Item, { name: "queued" });
    expect(result).toEqual({ updates: 0, inserts: 1, deletes: 0 });
    expect(buffer.size().inserts).toBe(0);
  });

  it("a queued bulkUpdate takes flush() off the no-op path", async () => {
    const { WriteBuffer } = await import("../../src/core/plugin/buffer/WriteBuffer");

    const mockEm: any = {
      save: jest.fn(),
      delete: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      query: jest.fn(),
      find: jest.fn(),
      transaction: jest.fn().mockImplementation((fn: any) => fn(mockEm)),
    };
    const buffer = new WriteBuffer(
      { em: mockEm, getEntities: () => [Item] } as any,
      {},
    );

    buffer.updateMany(Item, { where: { id: 1 }, set: { name: "renamed" } });
    expect(buffer.size().bulkUpdates).toBe(1);
    expect(buffer.preview()).toEqual([
      {
        action: "bulkUpdate",
        entity: "Item",
        where: { id: 1 },
        set: { name: "renamed" },
      },
    ]);

    const result = await buffer.flush();

    expect(mockEm.update).toHaveBeenCalledWith(Item, { id: 1 }, { name: "renamed" });
    expect(result).toEqual({ updates: 1, inserts: 0, deletes: 0 });
    expect(buffer.size().bulkUpdates).toBe(0);
  });
});
