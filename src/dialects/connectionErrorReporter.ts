import type { DatabaseClientOptions } from "../core/DatabaseClientOptions";
import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";
import type { Logger } from "../utils/Logger";

/**
 * Builds the sink a connector hands every error a pooled connection raises
 * outside a statement — the server closed it while it sat idle, or between
 * two statements of a transaction. No call is waiting on such an error, so
 * it has nowhere to reject to: it goes to the `onConnectionError` option, or
 * to a warning when there is none.
 *
 * One failure can reach the sink through more than one driver event, and a
 * dying connection can raise more than one error; each connection is
 * reported once.
 */
export function createConnectionErrorReporter(
  options: Pick<DatabaseClientOptions, "onConnectionError">,
  logger: Logger,
  database: string,
): (cause: unknown, connection: object) => void {
  const listener = options.onConnectionError;
  const reported = new WeakSet<object>();

  return (cause: unknown, connection: object): void => {
    if (reported.has(connection)) return;
    reported.add(connection);

    const detail = cause instanceof Error ? cause.message : String(cause);
    const error = new OrmError(
      OrmErrorCode.CONNECTION_LOST,
      `A pooled ${database} connection was lost. ${detail}`,
      "The pool discards the connection and opens a new one on demand; a transaction that was using it fails on its next statement",
      { cause },
    );

    if (!listener) {
      logger.warn(error.message);
      return;
    }
    try {
      listener(error);
    } catch (thrown) {
      logger.error(
        `onConnectionError threw while handling "${error.message}": ${thrown instanceof Error ? thrown.message : String(thrown)}`,
      );
    }
  };
}
