import "reflect-metadata";
import { SelectQueryBuilder } from "../../src/core/SelectQueryBuilder";
import { EntityManager } from "../../src/core/EntityManager";
import { Entity, PrimaryGeneratedColumn, Column } from "../../src/decorators";
import { RelationMetadataResolver } from "../../src/core/RelationMetadataResolver";

@Entity()
class Item {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  name!: string;
}

function createMockEm(batches: any[][]) {
  const resolver = new RelationMetadataResolver();
  let callIndex = 0;

  function wrap(col: string) {
    return `\`${col.replace(/`/g, "``")}\``;
  }

  return {
    wrap,
    wrapTable: (t: string) => wrap(t),
    resolver,
    _ctx: {
      isMySqlFamily: () => true,
      isPostgres: () => false,
      isSqlite: () => false,
    },
    async query<T>(): Promise<T[]> {
      const result = batches[callIndex] ?? [];
      callIndex++;
      return result as T[];
    },
  } as unknown as EntityManager;
}

describe("SelectQueryBuilder.stream()", () => {
  it("should yield all items across multiple batches", async () => {
    const batch1 = [{ id: 1, name: "a" }, { id: 2, name: "b" }];
    const batch2 = [{ id: 3, name: "c" }];
    const em = createMockEm([batch1, batch2]);

    const qb = new SelectQueryBuilder(Item, "i", em);
    const results: any[] = [];
    for await (const item of qb.stream(2)) {
      results.push(item);
    }

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ id: 1, name: "a" });
    expect(results[2]).toEqual({ id: 3, name: "c" });
  });

  it("should stop when an empty batch is returned", async () => {
    const em = createMockEm([[]]);
    const qb = new SelectQueryBuilder(Item, "i", em);

    const results: any[] = [];
    for await (const item of qb.stream(10)) {
      results.push(item);
    }

    expect(results).toHaveLength(0);
  });

  it("should stop when batch is smaller than batchSize", async () => {
    const batch1 = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const em = createMockEm([batch1]);

    const qb = new SelectQueryBuilder(Item, "i", em);
    const results: any[] = [];
    for await (const item of qb.stream(5)) {
      results.push(item);
    }

    expect(results).toHaveLength(3);
  });

  it("should handle exact batch size boundary", async () => {
    const batch1 = [{ id: 1 }, { id: 2 }];
    const batch2 = [{ id: 3 }, { id: 4 }];
    const batch3: any[] = [];
    const em = createMockEm([batch1, batch2, batch3]);

    const qb = new SelectQueryBuilder(Item, "i", em);
    const results: any[] = [];
    for await (const item of qb.stream(2)) {
      results.push(item);
    }

    expect(results).toHaveLength(4);
  });

  it("should enforce minimum batchSize of 1", async () => {
    const batch1 = [{ id: 1 }];
    const em = createMockEm([batch1]);

    const qb = new SelectQueryBuilder(Item, "i", em);
    const results: any[] = [];
    for await (const item of qb.stream(0)) {
      results.push(item);
    }

    expect(results).toHaveLength(1);
  });

  it("should not mutate the original query builder state", async () => {
    const em = createMockEm([[{ id: 1 }]]);
    const qb = new SelectQueryBuilder(Item, "i", em);
    qb.where("name", "test");
    qb.limit(100);

    const originalLimit = (qb as any).limitValue;
    const originalOffset = (qb as any).offsetValue;

    for await (const _ of qb.stream(10)) {
      // consume
    }

    expect((qb as any).limitValue).toBe(originalLimit);
    expect((qb as any).offsetValue).toBe(originalOffset);
  });

  it("should use default batchSize of 1000", async () => {
    // Create a batch of 999 items (less than 1000) — should stop after one batch
    const batch = Array.from({ length: 999 }, (_, i) => ({ id: i }));
    const em = createMockEm([batch]);

    const qb = new SelectQueryBuilder(Item, "i", em);
    const results: any[] = [];
    for await (const item of qb.stream()) {
      results.push(item);
    }

    expect(results).toHaveLength(999);
  });
});

describe("SelectQueryBuilder.streamBatch()", () => {
  it("should yield full batch arrays across multiple windows", async () => {
    const batch1 = [{ id: 1, name: "a" }, { id: 2, name: "b" }];
    const batch2 = [{ id: 3, name: "c" }];
    const em = createMockEm([batch1, batch2]);

    const qb = new SelectQueryBuilder(Item, "i", em);
    const windows: any[][] = [];
    for await (const page of qb.streamBatch(2)) {
      windows.push(page);
    }

    expect(windows).toHaveLength(2);
    expect(windows[0]).toEqual(batch1);
    expect(windows[1]).toEqual(batch2);
  });

  it("should stop when an empty batch is returned", async () => {
    const em = createMockEm([[]]);
    const qb = new SelectQueryBuilder(Item, "i", em);

    const windows: any[][] = [];
    for await (const page of qb.streamBatch(10)) {
      windows.push(page);
    }

    expect(windows).toHaveLength(0);
  });

  it("should stop when batch is smaller than batchSize", async () => {
    const batch1 = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const em = createMockEm([batch1]);

    const qb = new SelectQueryBuilder(Item, "i", em);
    const windows: any[][] = [];
    for await (const page of qb.streamBatch(5)) {
      windows.push(page);
    }

    expect(windows).toHaveLength(1);
    expect(windows[0]).toHaveLength(3);
  });

  it("should handle exact batch size boundary with trailing empty batch", async () => {
    const batch1 = [{ id: 1 }, { id: 2 }];
    const batch2 = [{ id: 3 }, { id: 4 }];
    const batch3: any[] = [];
    const em = createMockEm([batch1, batch2, batch3]);

    const qb = new SelectQueryBuilder(Item, "i", em);
    const windows: any[][] = [];
    for await (const page of qb.streamBatch(2)) {
      windows.push(page);
    }

    expect(windows).toHaveLength(2);
    expect(windows.flat()).toHaveLength(4);
  });

  it("should enforce minimum batchSize of 1", async () => {
    const batch1 = [{ id: 1 }];
    const em = createMockEm([batch1]);

    const qb = new SelectQueryBuilder(Item, "i", em);
    const windows: any[][] = [];
    for await (const page of qb.streamBatch(0)) {
      windows.push(page);
    }

    expect(windows).toHaveLength(1);
    expect(windows[0]).toHaveLength(1);
  });

  it("should not mutate the original query builder state", async () => {
    const em = createMockEm([[{ id: 1 }]]);
    const qb = new SelectQueryBuilder(Item, "i", em);
    qb.where("name", "test");
    qb.limit(100);

    const originalLimit = (qb as any).limitValue;
    const originalOffset = (qb as any).offsetValue;

    for await (const _ of qb.streamBatch(10)) {
      // consume
    }

    expect((qb as any).limitValue).toBe(originalLimit);
    expect((qb as any).offsetValue).toBe(originalOffset);
  });

  it("should release resources when consumer breaks early", async () => {
    const batch1 = [{ id: 1 }, { id: 2 }];
    const batch2 = [{ id: 3 }, { id: 4 }];
    const em = createMockEm([batch1, batch2]);

    const qb = new SelectQueryBuilder(Item, "i", em);
    const windows: any[][] = [];
    for await (const page of qb.streamBatch(2)) {
      windows.push(page);
      break;
    }

    expect(windows).toHaveLength(1);
    expect(windows[0]).toEqual(batch1);
  });
});
