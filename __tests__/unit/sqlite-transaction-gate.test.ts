/**
 * SqliteTransactionGate gives SQLite's single connection to one transaction
 * at a time: the holding flow's statements run at once, other work waits its
 * turn in order, and a transaction asked for inside the holding flow is
 * refused instead of colliding with it.
 */
import { SqliteTransactionGate } from "../../src/dialects/sqlite/SqliteTransactionGate";
import {
  currentTransactionFlow,
  runInTransactionFlow,
  TransactionFlow,
} from "../../src/dialects/TransactionFlow";
import { OrmErrorCode } from "../../src/errors/OrmErrorCode";

/** Begins a transaction on `gate` in a new flow; `body` runs in that flow while it holds the gate. */
function transaction(
  gate: SqliteTransactionGate,
  body: (flow: TransactionFlow) => Promise<void>,
): Promise<void> {
  return runInTransactionFlow(async () => {
    const flow = currentTransactionFlow()!;
    await gate.begin(flow);
    try {
      await body(flow);
    } finally {
      gate.end(flow);
    }
  });
}

function latch(): { done: Promise<void>; release: () => void } {
  let release!: () => void;
  const done = new Promise<void>((resolve) => (release = resolve));
  return { done, release };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("SqliteTransactionGate", () => {
  it("runs a statement at once when no transaction holds the connection", () => {
    const gate = new SqliteTransactionGate();

    expect(gate.run(() => 42)).toBe(42);
  });

  it("returns one gate per database handle", () => {
    const db = {};

    expect(SqliteTransactionGate.of(db)).toBe(SqliteTransactionGate.of(db));
    expect(SqliteTransactionGate.of({})).not.toBe(SqliteTransactionGate.of(db));
  });

  it("runs the holding flow's statements at once and holds other statements until it ends", async () => {
    const gate = new SqliteTransactionGate();
    const order: string[] = [];
    const hold = latch();

    const tx = transaction(gate, async () => {
      order.push(String(gate.run(() => "inside")));
      await hold.done;
      order.push("commit");
    });
    await flush();
    const outside = Promise.resolve(gate.run(() => order.push("outside")));
    await flush();
    expect(order).toEqual(["inside"]);

    hold.release();
    await Promise.all([tx, outside]);

    expect(order).toEqual(["inside", "commit", "outside"]);
  });

  it("gives the connection out in the order it was asked for", async () => {
    const gate = new SqliteTransactionGate();
    const order: string[] = [];
    const hold = latch();

    const first = transaction(gate, async () => {
      await hold.done;
      order.push("first");
    });
    await flush();
    const second = transaction(gate, async () => {
      order.push("second");
    });
    const statement = Promise.resolve(gate.run(() => order.push("statement")));
    const third = transaction(gate, async () => {
      order.push("third");
    });

    hold.release();
    await Promise.all([first, second, statement, third]);

    expect(order).toEqual(["first", "second", "statement", "third"]);
  });

  it("refuses a transaction asked for inside the holding flow", async () => {
    const gate = new SqliteTransactionGate();
    let refused: unknown;
    let nestedRefused: unknown;

    await transaction(gate, async () => {
      refused = await transaction(gate, async () => {}).catch((e) => e);
      nestedRefused = await runInTransactionFlow(() =>
        runInTransactionFlow(() => gate.begin(currentTransactionFlow()!)),
      ).catch((e) => e);
      expect(gate.run(() => "still held")).toBe("still held");
    });

    expect(refused).toMatchObject({ code: OrmErrorCode.UNSUPPORTED_OPERATION });
    expect(nestedRefused).toMatchObject({ code: OrmErrorCode.UNSUPPORTED_OPERATION });
    expect(gate.run(() => "free")).toBe("free");
  });

  it("ignores end() from a flow that does not hold the connection", async () => {
    const gate = new SqliteTransactionGate();
    const hold = latch();
    let ran = false;

    const tx = transaction(gate, async () => {
      await hold.done;
    });
    await flush();
    gate.end({});
    const outside = Promise.resolve(gate.run(() => (ran = true)));
    await flush();
    expect(ran).toBe(false);

    hold.release();
    await Promise.all([tx, outside]);
    expect(ran).toBe(true);
  });

  it("holds back work of an ended transaction's flow while another transaction holds the connection", async () => {
    const gate = new SqliteTransactionGate();
    const order: string[] = [];
    const hold = latch();
    const wake = latch();
    let stale!: Promise<unknown>;

    await transaction(gate, async () => {
      // Continues in this transaction's flow after the transaction ends.
      stale = wake.done.then(() => gate.run(() => order.push("stale")));
    });
    const other = transaction(gate, async () => {
      await hold.done;
      order.push("other");
    });
    await flush();
    wake.release();
    await flush();
    expect(order).toEqual([]);

    hold.release();
    await Promise.all([other, stale]);
    expect(order).toEqual(["other", "stale"]);
  });

  describe("waiting", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it("fails work that waits longer than waitTimeoutMs and serves the next in line", async () => {
      const gate = new SqliteTransactionGate();
      gate.waitTimeoutMs = 100;
      const hold = latch();
      const tx = transaction(gate, () => hold.done);
      await Promise.resolve();

      const timedOut = Promise.resolve(gate.run(() => "late")).catch((e) => e);
      jest.advanceTimersByTime(100);
      gate.waitTimeoutMs = 0;
      const next = Promise.resolve(gate.run(() => "next"));
      hold.release();
      await tx;

      expect(await timedOut).toMatchObject({ code: OrmErrorCode.CONNECTION_FAILED });
      expect((await timedOut).message).toContain("100 ms");
      expect(await next).toBe("next");
    });

    it("waits without a timer when waitTimeoutMs is 0", async () => {
      const gate = new SqliteTransactionGate();
      gate.waitTimeoutMs = 0;
      const hold = latch();
      const tx = transaction(gate, () => hold.done);
      await Promise.resolve();

      const waiting = Promise.resolve(gate.run(() => "ran"));
      expect(jest.getTimerCount()).toBe(0);

      hold.release();
      await tx;
      expect(await waiting).toBe("ran");
    });
  });
});
