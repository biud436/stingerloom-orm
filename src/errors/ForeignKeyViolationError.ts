import { OrmError, OrmErrorOptions } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

/**
 * What the database said about the foreign key a statement broke. Each
 * field is set only when the database reports it: PostgreSQL and
 * MySQL/MariaDB report both, SQLite neither.
 */
export interface ForeignKeyViolationDetail {
  /** The foreign key constraint name. */
  constraint?: string;
  /** The table that holds the foreign key (the referencing table). */
  table?: string;
}

/**
 * Thrown when a statement breaks a foreign key: a row points at a parent row
 * that does not exist, or a parent row still referenced from another table
 * is deleted or has its key changed. Code {@link OrmErrorCode.FK_VIOLATION};
 * the message is the database's, and the driver's error is kept as
 * {@link cause} (PostgreSQL `23503`, MySQL/MariaDB errno `1451` / `1452`,
 * SQLite `SQLITE_CONSTRAINT_FOREIGNKEY`).
 */
export class ForeignKeyViolationError extends OrmError {
  /** See {@link ForeignKeyViolationDetail.constraint}. */
  public readonly constraint?: string;
  /** See {@link ForeignKeyViolationDetail.table}. */
  public readonly table?: string;

  constructor(
    message: string,
    detail: ForeignKeyViolationDetail = {},
    options?: OrmErrorOptions,
  ) {
    super(OrmErrorCode.FK_VIOLATION, message, undefined, options);
    this.name = "ForeignKeyViolationError";
    this.constraint = detail.constraint;
    this.table = detail.table;
  }
}
