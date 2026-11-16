import { OrmError } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

/**
 * Thrown when the connection options name a database type the ORM has no
 * driver for. Code {@link OrmErrorCode.UNSUPPORTED_DATABASE}.
 */
export class NotSupportedDatabaseTypeError extends OrmError {
  /** HTTP-style status, kept from the time this class extended `Exception`. */
  public readonly status = 500;

  /** @param type - the database type the options named, when known */
  constructor(type?: unknown) {
    super(
      OrmErrorCode.UNSUPPORTED_DATABASE,
      type === undefined
        ? "Unsupported database type."
        : `Unsupported database type: ${JSON.stringify(type)}.`,
      'Supported types: "mysql", "mariadb", "postgres", "sqlite".',
    );
    this.name = "NotSupportedDatabaseTypeError";
  }
}
