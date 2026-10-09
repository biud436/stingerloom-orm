/* eslint-disable @typescript-eslint/no-explicit-any */
import { AsyncLocalStorage } from "async_hooks";
import { TransactionSessionManager } from "../dialects/TransactionSessionManager";
import { TRANSACTION_ISOLATION_LEVEL } from "../dialects/IsolationLevel";
import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";
import { closestIdentifier } from "../utils/closestIdentifier";
import { validateIsolationLevel } from "../utils/validateIsolationLevel";
import { isNonNegativeInteger, isNonNegativeNumber } from "../utils/optionRules";

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
  /** A `TransactionPropagation` member or its string value, e.g. `"REQUIRES_NEW"`. */
  propagation?: TransactionPropagation | `${TransactionPropagation}`;
  connectionName?: string;
}

const PROPAGATIONS: readonly string[] = Object.values(TransactionPropagation);

/**
 * Rejects an isolation level or propagation the transaction would not
 * honor. A propagation typo used to run as REQUIRED, and SQLite ignored any
 * isolation level, so neither showed up until the behavior differed.
 *
 * @internal Package-internal — not a public API.
 */
export function validateTransactionOptions(options: {
  isolationLevel?: unknown;
  propagation?: unknown;
  maxRetries?: unknown;
  retryDelayMs?: unknown;
}): void {
  const problems: string[] = [];
  if (options.maxRetries !== undefined) isNonNegativeInteger(options.maxRetries, "maxRetries", problems);
  if (options.retryDelayMs !== undefined) isNonNegativeNumber(options.retryDelayMs, "retryDelayMs", problems);
  if (problems.length > 0) {
    throw new OrmError(OrmErrorCode.INVALID_CONFIG, `Invalid transaction options: ${problems.join(" ")}`);
  }
  if (options.isolationLevel !== undefined) {
    validateIsolationLevel(options.isolationLevel as string);
  }
  const propagation = options.propagation;
  if (propagation !== undefined && !PROPAGATIONS.includes(propagation as string)) {
    const suggestion =
      typeof propagation === "string" ? closestIdentifier(propagation, PROPAGATIONS) : null;
    throw new OrmError(
      OrmErrorCode.INVALID_CONFIG,
      `Invalid transaction propagation: ${JSON.stringify(propagation)}.` +
        (suggestion ? ` Did you mean "${suggestion}"?` : ""),
      `Use one of: ${PROPAGATIONS.join(", ")}.`,
    );
  }
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
  validateTransactionOptions(resolved);

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
