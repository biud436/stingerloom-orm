/* eslint-disable @typescript-eslint/no-explicit-any */
import { AsyncLocalStorage } from "async_hooks";
import { TransactionSessionManager } from "../dialects/TransactionSessionManager";
import { TRANSACTION_ISOLATION_LEVEL } from "../dialects/IsolationLevel";

/**
 * Transaction propagation strategies.
 *
 * - REQUIRED: Join the existing transaction if present; otherwise create a new one. (default)
 * - REQUIRES_NEW: Always create a new, independent transaction (new connection/session).
 * - NESTED: Create a savepoint within the existing transaction; rollback only the savepoint on failure.
 */
export enum TransactionPropagation {
  REQUIRED = "REQUIRED",
  REQUIRES_NEW = "REQUIRES_NEW",
  NESTED = "NESTED",
}

export interface TransactionalOptions {
  isolationLevel?: TRANSACTION_ISOLATION_LEVEL;
  propagation?: TransactionPropagation;
  connectionName?: string;
}

/**
 * AsyncLocalStorage instance that holds the active TransactionSessionManager
 * for the current async context. This allows nested calls within a
 * @Transactional method to access the same transaction session.
 */
export const transactionStorage =
  new AsyncLocalStorage<TransactionSessionManager>();

let savepointCounter = 0;

/**
 * Method decorator that wraps the decorated method in a database transaction.
 *
 * - Creates a TransactionSessionManager, connects, and starts a transaction.
 * - On success: COMMITs the transaction.
 * - On error: ROLLBACKs the transaction, then rethrows.
 * - Uses AsyncLocalStorage so nested calls can join the same transaction.
 *
 * Supports three signatures:
 * - @Transactional()
 * - @Transactional("SERIALIZABLE")
 * - @Transactional({ isolationLevel: "SERIALIZABLE", propagation: TransactionPropagation.NESTED })
 */
export function Transactional(
  options?: TRANSACTION_ISOLATION_LEVEL | TransactionalOptions,
): MethodDecorator {
  const resolved: TransactionalOptions =
    typeof options === "string"
      ? { isolationLevel: options }
      : options ?? {};

  const isolationLevel = resolved.isolationLevel;
  const propagation = resolved.propagation ?? TransactionPropagation.REQUIRED;
  const connectionName = resolved.connectionName;

  return (_target, _propertyKey, descriptor: PropertyDescriptor) => {
    const originalMethod = descriptor.value;

    descriptor.value = async function (this: any, ...args: any[]) {
      const existingSession = transactionStorage.getStore();

      // ──── REQUIRES_NEW: Always start a fresh transaction ────
      if (propagation === TransactionPropagation.REQUIRES_NEW) {
        const session = new TransactionSessionManager();
        await session.connect(connectionName);
        await session.startTransaction(isolationLevel);

        try {
          const result = await transactionStorage.run(
            session,
            () => originalMethod.apply(this, args),
          );
          await session.commit();
          return result;
        } catch (error) {
          await session.rollback();
          throw error;
        } finally {
          await session.close();
        }
      }

      // ──── NESTED: Use savepoint within existing transaction ────
      if (propagation === TransactionPropagation.NESTED && existingSession) {
        const savepointName = `sp_${++savepointCounter}`;
        await existingSession.savepoint(savepointName);

        try {
          const result = await originalMethod.apply(this, args);
          return result;
        } catch (error) {
          await existingSession.rollbackTo(savepointName);
          throw error;
        }
      }

      // ──── REQUIRED (default): Join existing or create new ────
      if (existingSession) {
        return originalMethod.apply(this, args);
      }

      const session = new TransactionSessionManager();
      await session.connect(connectionName);
      await session.startTransaction(isolationLevel);

      try {
        const result = await transactionStorage.run(
          session,
          () => originalMethod.apply(this, args),
        );
        await session.commit();
        return result;
      } catch (error) {
        await session.rollback();
        throw error;
      } finally {
        await session.close();
      }
    };

    return descriptor;
  };
}
