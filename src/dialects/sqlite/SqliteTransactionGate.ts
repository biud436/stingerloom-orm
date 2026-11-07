import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";
import { runsInFlow, TransactionFlow } from "../TransactionFlow";

/** How long work waits for the connection when `pool.acquireTimeoutMs` is not set. */
export const DEFAULT_SQLITE_WAIT_MS = 30_000;

interface Waiter {
  grant(): void;
}

/**
 * Takes turns on one SQLite connection.
 *
 * better-sqlite3 opens a single handle, and a transaction open on it takes
 * every statement anyone runs on that handle until COMMIT or ROLLBACK. Two
 * transactions that overlapped issued two BEGINs on it: the second failed,
 * its ROLLBACK undid the first one's work, the first went on in autocommit
 * and failed at COMMIT with its later rows already written, and a read
 * running alongside returned rows that were then rolled back.
 *
 * The gate gives the connection to one transaction at a time, in the order
 * they asked for it. While a transaction holds it, statements from that
 * transaction's flow ({@link TransactionFlow}) run at once, and any other
 * statement waits for COMMIT or ROLLBACK and runs in its turn. A transaction
 * asked for inside the flow of the one that holds the connection could only
 * collide with it, and is refused before BEGIN.
 *
 * A session the caller drives outside any flow is not held back when it
 * begins a transaction, as before.
 *
 * @internal Package-internal — not a public API.
 */
export class SqliteTransactionGate {
  private static readonly gates = new WeakMap<object, SqliteTransactionGate>();

  /** The gate of the better-sqlite3 handle `db`. */
  static of(db: object): SqliteTransactionGate {
    let gate = SqliteTransactionGate.gates.get(db);
    if (!gate) {
      gate = new SqliteTransactionGate();
      SqliteTransactionGate.gates.set(db, gate);
    }
    return gate;
  }

  /**
   * How long a statement or a transaction waits for its turn before it
   * fails; 0 waits without a limit. Set from `pool.acquireTimeoutMs`.
   */
  waitTimeoutMs = DEFAULT_SQLITE_WAIT_MS;

  /** The flow whose transaction holds the connection. */
  private holder?: TransactionFlow;
  /** Whether a turn is in progress. Its end hands it straight to the next waiter. */
  private taken = false;
  private readonly waiters: Waiter[] = [];

  /**
   * Runs `statement` now when no turn is in progress or the current flow's
   * transaction holds the connection; otherwise after the transactions and
   * statements that asked before it.
   */
  run<R>(statement: () => R): R | Promise<R> {
    if (!this.taken || this.heldByCurrentFlow()) return statement();
    return this.runInTurn(statement);
  }

  private async runInTurn<R>(statement: () => R): Promise<R> {
    await this.waitForTurn("run a statement");
    try {
      return statement();
    } finally {
      this.passTurn();
    }
  }

  /**
   * Gives the connection to the transaction of `flow`, once the transaction
   * holding it, and any work queued before, is done.
   *
   * @throws {OrmError} UNSUPPORTED_OPERATION when the transaction holding
   * the connection is the current flow's own
   * @throws {OrmError} CONNECTION_FAILED when the wait outlasts
   * {@link waitTimeoutMs}
   */
  async begin(flow: TransactionFlow): Promise<void> {
    if (this.heldByCurrentFlow()) {
      throw new OrmError(
        OrmErrorCode.UNSUPPORTED_OPERATION,
        "Cannot open a transaction inside another one on SQLite: its single connection holds one transaction at a time.",
        "Join the open transaction (the default REQUIRED propagation), take a savepoint with NESTED, or run the work after the outer transaction ends.",
      );
    }
    if (this.taken) {
      await this.waitForTurn("begin a transaction");
    } else {
      this.taken = true;
    }
    this.holder = flow;
  }

  /** Ends the turn of `flow`'s transaction, when it holds the connection. */
  end(flow: TransactionFlow): void {
    if (this.holder !== flow) return;
    this.holder = undefined;
    this.passTurn();
  }

  private heldByCurrentFlow(): boolean {
    return this.holder !== undefined && runsInFlow(this.holder);
  }

  private waitForTurn(purpose: string): Promise<void> {
    const timeoutMs = this.waitTimeoutMs;
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter: Waiter = {
        grant: () => {
          if (timer !== undefined) clearTimeout(timer);
          resolve();
        },
      };
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(
            new OrmError(
              OrmErrorCode.CONNECTION_FAILED,
              `Timed out after ${timeoutMs} ms waiting to ${purpose} on the SQLite connection: a transaction still holds it.`,
              "SQLite runs one transaction at a time on its single connection. Keep transactions short, or raise pool.acquireTimeoutMs (0 waits without a limit).",
            ),
          );
        }, timeoutMs);
      }
      this.waiters.push(waiter);
    });
  }

  private passTurn(): void {
    const next = this.waiters.shift();
    if (next) next.grant();
    else this.taken = false;
  }
}
