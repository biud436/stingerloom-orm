/* eslint-disable @typescript-eslint/no-explicit-any */
import { AsyncLocalStorage } from "async_hooks";
import { TransactionSessionManager } from "../dialects/TransactionSessionManager";
import { TRANSACTION_ISOLATION_LEVEL } from "../dialects/IsolationLevel";

/**
 * AsyncLocalStorage instance that holds the active TransactionSessionManager
 * for the current async context. This allows nested calls within a
 * @Transactional method to access the same transaction session.
 */
export const transactionStorage =
  new AsyncLocalStorage<TransactionSessionManager>();

/**
 * Method decorator that wraps the decorated method in a database transaction.
 *
 * - Creates a TransactionSessionManager, connects, and starts a transaction.
 * - On success: COMMITs the transaction.
 * - On error: ROLLBACKs the transaction, then rethrows.
 * - Uses AsyncLocalStorage so nested calls can join the same transaction.
 *
 * @param isolationLevel - Optional transaction isolation level.
 */
export function Transactional(
  isolationLevel?: TRANSACTION_ISOLATION_LEVEL,
): MethodDecorator {
  return (_target, _propertyKey, descriptor: PropertyDescriptor) => {
    const originalMethod = descriptor.value;

    descriptor.value = async function (this: any, ...args: any[]) {
      // If already inside a transaction, reuse it (nested call)
      const existingSession = transactionStorage.getStore();
      if (existingSession) {
        return originalMethod.apply(this, args);
      }

      const session = new TransactionSessionManager();
      await session.connect();
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
