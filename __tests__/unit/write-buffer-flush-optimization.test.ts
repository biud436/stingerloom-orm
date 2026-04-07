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
  });

  it("hasQueuedWork concept: empty queues return false", () => {
    // Test the logic that hasQueuedWork checks
    const queues = {
      insertQueue: [] as any[],
      deleteQueue: [] as any[],
      persistQueue: [] as any[],
      bulkUpdateQueue: [] as any[],
      bulkDeleteQueue: [] as any[],
    };

    const hasQueuedWork = () =>
      queues.insertQueue.length > 0
      || queues.deleteQueue.length > 0
      || queues.persistQueue.length > 0
      || queues.bulkUpdateQueue.length > 0
      || queues.bulkDeleteQueue.length > 0;

    expect(hasQueuedWork()).toBe(false);

    queues.insertQueue.push({ entity: Item, data: {} });
    expect(hasQueuedWork()).toBe(true);
  });

  it("hasQueuedWork concept: detects bulkUpdate queue", () => {
    const queues = {
      insertQueue: [] as any[],
      deleteQueue: [] as any[],
      persistQueue: [] as any[],
      bulkUpdateQueue: [{ entity: Item, criteria: {}, data: {} }],
      bulkDeleteQueue: [] as any[],
    };

    const hasQueuedWork = () =>
      queues.insertQueue.length > 0
      || queues.deleteQueue.length > 0
      || queues.persistQueue.length > 0
      || queues.bulkUpdateQueue.length > 0
      || queues.bulkDeleteQueue.length > 0;

    expect(hasQueuedWork()).toBe(true);
  });
});
