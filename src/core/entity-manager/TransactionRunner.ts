/* eslint-disable @typescript-eslint/no-explicit-any */
import { TransactionSessionManager } from "../../dialects/TransactionSessionManager";
import { ReplicationNodeConfig } from "../../dialects/ReplicationRouter";
import {
  transactionStorage,
  TransactionPropagation,
} from "../../decorators/Transactional";
import { MetadataContext } from "../../metadata/MetadataContext";
import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";
import { isDeadlockError, isStatementTimeoutError } from "./internal-utils";
import { QueryTimeoutError } from "../../errors/QueryTimeoutError";
import type {
  TransactionOptions,
  ExecuteTransactionOptions,
} from "./types";
import type { EntityManagerInternals } from "../EntityManagerInternals";
import type { EntityManager } from "../EntityManager";

/**
 * Transaction execution engine extracted from EntityManager: the
 * `executeInTransaction` write wrapper, the `executeReadOnly` lightweight
 * read path, and the public `transaction()` API (propagation, isolation,
 * deadlock retry).
 *
 * The facade keeps thin delegators so `_ctx` routing, `PluginContext`, and
 * test spies (`jest.spyOn(em as any, "executeReadOnly")` etc.) keep
 * intercepting on the EntityManager. Internal cross-calls (executeReadOnly →
 * executeInTransaction, transaction() → executeInTransaction) route back
 * through `ctx` — i.e. through the facade delegators — for the same reason.
 *
 * @internal Package-internal — not a public API.
 */
export class TransactionRunner {
  /**
   * Monotonic counter for NESTED-propagation savepoint names in transaction().
   *
   * Process-wide (static), not per-instance: every EntityManager owns its own
   * TransactionRunner, yet they all see the same ambient session through
   * AsyncLocalStorage. A per-instance counter emitted `sp_em_1` twice on one
   * session when a second manager nested inside the first — the later
   * SAVEPOINT shadows the earlier one, so the outer `ROLLBACK TO sp_em_1`
   * lands on the inner marker and silently keeps the work it meant to undo.
   * The `sp_em_` prefix keeps these distinct from @Transactional's `sp_N`.
   */
  private static txSavepointCounter = 0;

  constructor(private readonly ctx: EntityManagerInternals) {}

  async executeInTransaction<R>(
    fn: (session: TransactionSessionManager) => Promise<R>,
    existingSession?: TransactionSessionManager,
    readNodeOverride?: ReplicationNodeConfig | null,
    txOptions?: ExecuteTransactionOptions,
  ): Promise<R> {
    const reusable = txOptions?.forceNew
      ? undefined
      : (existingSession ?? transactionStorage.getStore());
    if (reusable) {
      return fn(reusable);
    }

    const session = new TransactionSessionManager();
    let committed = false;
    try {
      if (readNodeOverride) {
        await session.connectToNode(readNodeOverride);
      } else {
        await session.connect(
          txOptions?.connectionName ?? this.ctx.getConnectionName(),
        );
      }
      await this.ctx.notifyTransactionSubscribers("beforeTransactionStart");
      this.ctx.notifyPluginBeforeTransaction();
      await session.startTransaction(txOptions?.isolationLevel);

      await this.ctx.notifyTransactionSubscribers("afterTransactionStart");

      const result = await fn(session);
      await this.ctx.notifyTransactionSubscribers("beforeTransactionCommit");
      await session.commit();
      committed = true;
      this.ctx.notifyPluginAfterTransaction(true);
      await this.ctx.notifyTransactionSubscribers("afterTransactionCommit");
      return result;
    } catch (e: unknown) {
      // Once COMMIT has succeeded the data is durable — a throwing
      // post-commit notification must not run ROLLBACK or fire the rollback
      // events on top of it. The error still propagates to the caller.
      if (committed) throw e;
      try {
        await this.ctx.notifyTransactionSubscribers("beforeTransactionRollback");
        await session.rollback();
        this.ctx.notifyPluginAfterTransaction(false);
        await this.ctx.notifyTransactionSubscribers("afterTransactionRollback");
      } catch (rollbackError) {
        this.ctx.getLogger().error(`Failed to rollback transaction: ${rollbackError}`);
        const original = e instanceof Error ? e : new Error(String(e));
        const combined = new OrmError(
          OrmErrorCode.TRANSACTION_ROLLBACK_FAILED,
          `Transaction failed and rollback also failed: ${original.message}`,
        );
        (combined as any).cause = original;
        (combined as any).rollbackError = rollbackError;
        throw combined;
      }
      throw e;
    } finally {
      this.ctx.clearTxDirtyEntities(session);
      try {
        await session.close();
      } catch (closeError) {
        this.ctx.getLogger().error(`Failed to close transaction: ${closeError}`);
      }
    }
  }

  /**
   * Runs `fn` with the driver's statement timeout in force on `session`, and
   * translates the database's cancellation into {@link QueryTimeoutError}.
   *
   * Three things this centralizes, each of which used to be missing somewhere:
   * - **Where the statement runs.** PostgreSQL's `SET LOCAL` silently does
   *   nothing outside a transaction (the server accepts it and moves on), so
   *   the timeout has to be issued on the session that actually executes the
   *   read — including the transaction `executeReadOnly` opens for it.
   * - **Restoring the session.** MySQL/MariaDB use `SET SESSION`, which
   *   outlives the query and rides the pooled connection into whatever runs
   *   next. A per-query override is undone afterwards, back to the
   *   connection-level default (or "no limit" when there is none). SQLite is
   *   left alone: its `PRAGMA busy_timeout` is a lock wait, not a statement
   *   timeout, and zeroing it would drop better-sqlite3's default lock wait.
   * - **What the caller catches.** Drivers report the cancellation with their
   *   own codes; the documented contract is a `QueryTimeoutError`.
   */
  private async withQueryTimeout<R>(
    session: TransactionSessionManager,
    timeout: number | undefined,
    fn: (session: TransactionSessionManager) => Promise<R>,
  ): Promise<R> {
    const driver = this.ctx.getDriver();
    if (!timeout || timeout <= 0 || !driver) {
      return fn(session);
    }

    await session.query(driver.setQueryTimeout(timeout));

    try {
      return await fn(session);
    } catch (e: unknown) {
      if (isStatementTimeoutError(e)) {
        throw new QueryTimeoutError(timeout, e);
      }
      throw e;
    } finally {
      const fallback = this.ctx.getDefaultQueryTimeout() ?? 0;
      if (fallback !== timeout && !this.ctx.isSqlite()) {
        try {
          await session.query(driver.setQueryTimeout(fallback));
        } catch (restoreError) {
          this.ctx
            .getLogger()
            .warn(`Failed to restore the query timeout: ${restoreError}`);
        }
      }
    }
  }

  async executeReadOnly<R>(
    fn: (session: TransactionSessionManager) => Promise<R>,
    options?: {
      existingSession?: TransactionSessionManager;
      readNodeOverride?: ReplicationNodeConfig | null;
      timeout?: number;
    },
  ): Promise<R> {
    const { existingSession, readNodeOverride, timeout } = options ?? {};

    // Every path below runs the caller's work through `withQueryTimeout`, so
    // the timeout statement is issued on whichever session actually executes
    // the read — including the ambient one and the PostgreSQL transaction the
    // next branch opens, where `SET LOCAL` is a no-op outside a transaction.
    const run = (session: TransactionSessionManager): Promise<R> =>
      this.withQueryTimeout(session, timeout, fn);

    // 1. Reuse existing session (@Transactional or nested call)
    const reusable = existingSession ?? transactionStorage.getStore();
    if (reusable) {
      return run(reusable);
    }

    // 2. PostgreSQL tenant or timeout → need transaction for SET LOCAL
    const tenant = this.ctx.isPostgres()
      ? MetadataContext.getCurrentTenant()
      : "public";
    const needsTxForTenant =
      this.ctx.isPostgres() &&
      tenant !== "public" &&
      this.ctx.getTenantStrategy().needsTransactionForTenantRead();
    if (this.ctx.isPostgres() && (needsTxForTenant || (timeout && timeout > 0))) {
      return this.ctx.executeInTransaction(run, existingSession, readNodeOverride);
    }

    // 3. Lightweight read-only path (no BEGIN/COMMIT)
    const session = new TransactionSessionManager();
    try {
      if (readNodeOverride) {
        await session.connectToNode(readNodeOverride);
      } else {
        await session.connect(this.ctx.getConnectionName());
      }

      const result = await run(session);
      return result;
    } finally {
      try {
        await session.close();
      } catch (closeError) {
        this.ctx.getLogger().error(`Failed to close read-only session: ${closeError}`);
      }
    }
  }

  async transaction<R>(
    callback: (em: EntityManager) => Promise<R>,
    options?: TransactionOptions,
  ): Promise<R> {
    const manager = this.ctx.getManager();
    const maxRetries = options?.retryOnDeadlock ? (options.maxRetries ?? 3) : 0;
    const retryDelayMs = options?.retryDelayMs ?? 100;
    const propagation = options?.propagation ?? TransactionPropagation.REQUIRED;
    const isolationLevel = options?.isolationLevel;
    const connectionName = options?.connectionName;

    // ── NESTED: savepoint within the ambient transaction ──────────────
    // Mirrors @Transactional's NESTED branch. Only failures inside the
    // callback roll back to the savepoint; the outer transaction continues.
    const ambient = transactionStorage.getStore();
    if (propagation === TransactionPropagation.NESTED && ambient) {
      const savepointName = `sp_em_${++TransactionRunner.txSavepointCounter}`;
      await ambient.savepoint(savepointName);
      try {
        return await transactionStorage.run(ambient, () => callback(manager));
      } catch (e) {
        await ambient.rollbackTo(savepointName);
        throw e;
      }
    }

    // REQUIRES_NEW always opens a fresh, independent transaction even when one
    // is already active. REQUIRED (default) reuses the ambient one if present.
    const forceNew = propagation === TransactionPropagation.REQUIRES_NEW;
    const txOptions: ExecuteTransactionOptions = {
      isolationLevel,
      connectionName,
      forceNew,
    };

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.ctx.executeInTransaction(
          async (session) => {
            return transactionStorage.run(session, () => callback(manager));
          },
          undefined,
          undefined,
          txOptions,
        );
      } catch (e: unknown) {
        lastError = e;
        if (attempt < maxRetries && isDeadlockError(e)) {
          this.ctx.getLogger().warn(
            `Deadlock detected (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${retryDelayMs}ms...`,
          );
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          continue;
        }
        throw e;
      }
    }
    throw lastError;
  }
}
