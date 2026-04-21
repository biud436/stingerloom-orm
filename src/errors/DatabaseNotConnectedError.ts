import { OrmError } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

/**
 * Thrown when an operation is attempted without an active database connection.
 */
export class DatabaseNotConnectedError extends OrmError {
  constructor() {
    super(
      OrmErrorCode.NOT_CONNECTED,
      `Database is not connected.`,
      `Call entityManager.register(options) or entityManager.connect(options) before executing queries.`,
    );
    this.name = "DatabaseNotConnectedError";
  }
}
