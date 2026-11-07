/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Overlapping work on SQLite's single connection takes turns.
 *
 * better-sqlite3 opens one handle, and every write opened its own
 * transaction on it with a bare BEGIN. Two writes that overlapped issued two
 * BEGINs: the second failed, its ROLLBACK undid the first one's work, the
 * first went on in autocommit and then failed at COMMIT — every caller was
 * told its write failed while some rows were in the table. A read that ran
 * while a transaction was open returned rows the transaction later rolled
 * back, and REQUIRES_NEW inside a transaction rolled the outer one back.
 */
import "reflect-metadata";
import {
  Column,
  Entity,
  PrimaryGeneratedColumn,
  Transactional,
  TransactionPropagation,
} from "../../../src";
import { EntityManager } from "../../../src/core/EntityManager";
import { OrmErrorCode } from "../../../src/errors/OrmErrorCode";
import sql from "../../../src/utils/sqlTag";

@Entity({ name: "sct_note" })
class SctNote {
  @PrimaryGeneratedColumn() id!: number;
  @Column() body!: string;
}

async function connect(extra: Record<string, unknown> = {}): Promise<EntityManager> {
  const em = new EntityManager();
  await em.register({
    type: "sqlite",
    database: ":memory:",
    entities: [SctNote],
    synchronize: true,
    logging: false,
    ...extra,
  } as any);
  return em;
}

async function bodies(em: EntityManager): Promise<string[]> {
  const rows: any = await em.getDriver()!.executeRaw(`SELECT body FROM sct_note ORDER BY id`);
  return (rows as any[]).map((row) => row.body);
}

function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Starts `read` and reports whether it has settled yet. */
function pending<T>(read: Promise<T>): { result: Promise<T>; settled: () => boolean } {
  let settled = false;
  const result = read.finally(() => (settled = true));
  return { result, settled: () => settled };
}

async function errorOf(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
    return null;
  } catch (e) {
    return e;
  }
}

describe("[Integration] SQLite: overlapping work takes turns on the connection", () => {
  let em: EntityManager;

  beforeEach(async () => {
    em = await connect();
  });

  afterEach(async () => {
    await em.propagateShutdown({ closeConnections: true });
  });

  it("commits every one of overlapping saves", async () => {
    const names = ["a", "b", "c", "d", "e", "f"];

    const results = await Promise.allSettled(names.map((body) => em.save(SctNote, { body })));

    expect(results.map((r) => r.status)).toEqual(names.map(() => "fulfilled"));
    expect((await bodies(em)).sort()).toEqual(names);
  });

  it("runs overlapping transactions one after the other", async () => {
    const run = (name: string) =>
      em.transaction(async (tx) => {
        await tx.save(SctNote, { body: `${name}-1` });
        await tick();
        await tx.save(SctNote, { body: `${name}-2` });
      });

    await Promise.all([run("x"), run("y")]);

    expect(await bodies(em)).toEqual(["x-1", "x-2", "y-1", "y-2"]);
  });

  it("rolls back only the failing one of two overlapping transactions", async () => {
    const failing = em.transaction(async (tx) => {
      await tx.save(SctNote, { body: "failing" });
      await tick();
      throw new Error("abort");
    });
    const passing = em.transaction(async (tx) => {
      await tx.save(SctNote, { body: "passing" });
    });

    const [failure, passed] = await Promise.allSettled([failing, passing]);

    expect((failure as PromiseRejectedResult).reason.message).toBe("abort");
    expect(passed.status).toBe("fulfilled");
    expect(await bodies(em)).toEqual(["passing"]);
  });

  it("does not return to a read outside a transaction the rows it rolls back", async () => {
    await em.save(SctNote, { body: "before" });
    const hold = gate();

    const tx = em.transaction(async (t) => {
      await t.save(SctNote, { body: "uncommitted" });
      await hold.opened;
      throw new Error("abort");
    });
    await tick();
    const read = pending(em.find(SctNote, {}));
    await tick();
    expect(read.settled()).toBe(false);
    hold.open();

    expect(await errorOf(tx)).toMatchObject({ message: "abort" });
    expect((await read.result).map((n) => n.body)).toEqual(["before"]);
  });

  it("returns to a read outside a transaction its rows once it commits", async () => {
    const hold = gate();

    const tx = em.transaction(async (t) => {
      await t.save(SctNote, { body: "committed" });
      await hold.opened;
    });
    await tick();
    const read = pending(em.find(SctNote, {}));
    const rawRead = pending(
      em.getDriver()!.queryWithOptions!(sql`SELECT body FROM sct_note`, { arrayMode: true }),
    );
    await tick();
    expect([read.settled(), rawRead.settled()]).toEqual([false, false]);
    hold.open();

    await tx;
    expect((await read.result).map((n) => n.body)).toEqual(["committed"]);
    expect(await rawRead.result).toEqual([["committed"]]);
  });

  it("refuses REQUIRES_NEW inside a transaction before BEGIN and keeps the outer one", async () => {
    let inner: any;

    await em.transaction(async (tx) => {
      await tx.save(SctNote, { body: "outer-1" });
      inner = await errorOf(
        em.transaction(
          async (nested) => {
            await nested.save(SctNote, { body: "inner" });
          },
          { propagation: TransactionPropagation.REQUIRES_NEW },
        ),
      );
      await tx.save(SctNote, { body: "outer-2" });
    });

    expect(inner).toMatchObject({ code: OrmErrorCode.UNSUPPORTED_OPERATION });
    expect(await bodies(em)).toEqual(["outer-1", "outer-2"]);
  });

  it("refuses a @Transactional REQUIRES_NEW method inside a transaction", async () => {
    class NoteService {
      @Transactional({ propagation: TransactionPropagation.REQUIRES_NEW })
      async write(): Promise<void> {
        await em.save(SctNote, { body: "inner" });
      }
    }
    const service = new NoteService();
    let inner: any;

    await em.transaction(async (tx) => {
      await tx.save(SctNote, { body: "outer" });
      inner = await errorOf(service.write());
    });

    expect(inner).toMatchObject({ code: OrmErrorCode.UNSUPPORTED_OPERATION });
    expect(await bodies(em)).toEqual(["outer"]);
  });

  it("runs overlapping @Transactional methods one after the other", async () => {
    class NoteService {
      @Transactional()
      async write(name: string): Promise<void> {
        await em.save(SctNote, { body: `${name}-1` });
        await tick();
        await em.save(SctNote, { body: `${name}-2` });
      }
    }
    const service = new NoteService();

    await Promise.all([service.write("x"), service.write("y")]);

    expect(await bodies(em)).toEqual(["x-1", "x-2", "y-1", "y-2"]);
  });

  it("opens a transaction from a subscriber after the previous one commits", async () => {
    let audited = false;
    em.addSubscriber({
      listenTo: () => SctNote,
      async afterTransactionCommit() {
        if (audited) return;
        audited = true;
        await em.save(SctNote, { body: "audit" });
      },
    });

    await em.transaction(async (tx) => {
      await tx.save(SctNote, { body: "work" });
    });

    expect(await bodies(em)).toEqual(["work", "audit"]);
  });

  it("fails work that waits longer than pool.acquireTimeoutMs", async () => {
    const short = await connect({ pool: { acquireTimeoutMs: 50 } });
    try {
      const hold = gate();
      const tx = short.transaction(async (t) => {
        await t.save(SctNote, { body: "held" });
        await hold.opened;
      });
      await tick();

      const waited = await errorOf(short.save(SctNote, { body: "late" }));
      hold.open();
      await tx;

      expect(waited).toMatchObject({ code: OrmErrorCode.CONNECTION_FAILED });
      expect(waited.message).toContain("50 ms");
      expect(await bodies(short)).toEqual(["held"]);
    } finally {
      await short.propagateShutdown({ closeConnections: true });
    }
  });
});
