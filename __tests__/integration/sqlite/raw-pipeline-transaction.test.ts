/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite In-Memory: `em.pipe()` inside a transaction runs its batches on the
 * transaction's session — the path that lets them read the transaction's own
 * writes on PostgreSQL / MySQL, where a pooled connection would not. SQLite
 * has one connection, so here the reads match either way; these pin the
 * routing and the session's result formats.
 *
 * Real databases: __tests__/integration/raw-pipeline-transaction.test.ts
 */
import "reflect-metadata";
import { Entity, Column, PrimaryGeneratedColumn } from "../../../src";
import { EntityManager } from "../../../src/core/EntityManager";
import { rawPipelinePlugin } from "../../../src/core/plugin/raw-pipeline/rawPipelinePlugin";
import { TransactionSessionManager } from "../../../src/dialects/TransactionSessionManager";

@Entity({ name: "rptx_note" })
class RptxNote {
  @PrimaryGeneratedColumn() id!: number;
  @Column() label!: string;
}

async function drain(gen: AsyncGenerator<any[]>): Promise<any[]> {
  const rows: any[] = [];
  for await (const batch of gen) rows.push(...batch);
  return rows;
}

describe("[Integration] SQLite: em.pipe() inside a transaction", () => {
  let base: EntityManager;
  let em: any;

  beforeEach(async () => {
    base = new EntityManager();
    await base.register(
      {
        type: "sqlite",
        database: ":memory:",
        entities: [RptxNote],
        synchronize: true,
        logging: false,
      } as any,
      `rptx_${Math.random().toString(36).slice(2, 10)}`,
    );
    em = base.extend(rawPipelinePlugin());
    await em.save(RptxNote, { label: "a" });
    await em.save(RptxNote, { label: "b" });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await base.propagateShutdown();
  });

  it("runs every batch mode on the transaction's session", async () => {
    const onSession = jest.spyOn(TransactionSessionManager.prototype, "queryWithOptions");

    const seen = await em.transaction(async () => {
      await em.save(RptxNote, { label: "c" });
      return {
        raw: await drain(em.pipe(RptxNote, { orderBy: { id: "ASC" }, batchSize: 2 }).raw()),
        keyset: await drain(
          em.pipe(RptxNote, { orderBy: { id: "DESC" }, keyset: true, batchSize: 1 }).raw(),
        ),
        arrays: await drain(
          em.pipe(RptxNote, { select: ["label"], orderBy: { id: "ASC" } }).binary({ arrayMode: true }),
        ),
      };
    });

    expect(seen.raw.map((r: any) => r.label)).toEqual(["a", "b", "c"]);
    expect(seen.keyset.map((r: any) => r.label)).toEqual(["c", "b", "a"]);
    expect(seen.arrays).toEqual([["a"], ["b"], ["c"]]);
    // raw: 2 batches, keyset: 3 full batches + the empty one, arrays: 1.
    expect(onSession).toHaveBeenCalledTimes(7);
  });

  it("reads from the driver outside a transaction", async () => {
    const onSession = jest.spyOn(TransactionSessionManager.prototype, "queryWithOptions");

    const rows = await em.pipe(RptxNote).collect();

    expect(rows.map((r: any) => r.label).sort()).toEqual(["a", "b"]);
    expect(onSession).not.toHaveBeenCalled();
  });
});
