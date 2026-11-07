import { AsyncLocalStorage } from "async_hooks";

/**
 * The async flow of one transaction the ORM opens on a session of its own:
 * everything that runs from before BEGIN until after COMMIT or ROLLBACK,
 * including the callback's work and whatever that work awaits. A flow
 * opened inside another one keeps it as `outer`.
 *
 * A connection that holds one transaction at a time for every caller
 * (SQLite's single handle) uses the flow to tell the transaction's own
 * statements, which run at once, from other work, which waits for COMMIT or
 * ROLLBACK.
 *
 * @internal Package-internal — not a public API.
 */
export interface TransactionFlow {
  readonly outer?: TransactionFlow;
}

const flows = new AsyncLocalStorage<TransactionFlow>();

/**
 * Runs `fn` as the flow of a transaction it is about to open.
 *
 * @internal Package-internal — not a public API.
 */
export function runInTransactionFlow<R>(fn: () => R): R {
  return flows.run({ outer: flows.getStore() }, fn);
}

/**
 * The innermost transaction flow of the current async context.
 *
 * @internal Package-internal — not a public API.
 */
export function currentTransactionFlow(): TransactionFlow | undefined {
  return flows.getStore();
}

/**
 * Whether the current async context runs in `flow` or in a flow opened
 * inside it.
 *
 * @internal Package-internal — not a public API.
 */
export function runsInFlow(flow: TransactionFlow): boolean {
  for (let f = flows.getStore(); f; f = f.outer) {
    if (f === flow) return true;
  }
  return false;
}
