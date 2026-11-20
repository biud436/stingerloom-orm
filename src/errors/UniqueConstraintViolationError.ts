import { OrmError, OrmErrorOptions } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

/**
 * What the database said about the unique constraint a statement broke.
 * Each field is set only when the database reports it.
 */
export interface UniqueConstraintViolationDetail {
  /**
   * The constraint or unique index name. PostgreSQL and MySQL/MariaDB report
   * it (`PRIMARY` for a MySQL primary key); SQLite reports it only for an
   * index over expressions.
   */
  constraint?: string;
  /**
   * The table. PostgreSQL and SQLite report it, MySQL 8.0.19+ too; MariaDB
   * and older MySQL do not.
   */
  table?: string;
  /**
   * The key's columns, as the database names them (not entity property
   * names). PostgreSQL and SQLite report them; MySQL/MariaDB do not.
   */
  columns?: string[];
}

/**
 * Thrown when a statement would store a duplicate value in a primary key or
 * a unique column or index. Code {@link OrmErrorCode.UNIQUE_VIOLATION}; the
 * message is the database's, and the driver's error is kept as
 * {@link cause} (PostgreSQL `23505`, MySQL/MariaDB errno `1062`, SQLite
 * `SQLITE_CONSTRAINT_UNIQUE` / `SQLITE_CONSTRAINT_PRIMARYKEY`).
 */
export class UniqueConstraintViolationError extends OrmError {
  /** See {@link UniqueConstraintViolationDetail.constraint}. */
  public readonly constraint?: string;
  /** See {@link UniqueConstraintViolationDetail.table}. */
  public readonly table?: string;
  /** See {@link UniqueConstraintViolationDetail.columns}. */
  public readonly columns?: string[];

  constructor(
    message: string,
    detail: UniqueConstraintViolationDetail = {},
    options?: OrmErrorOptions,
  ) {
    super(OrmErrorCode.UNIQUE_VIOLATION, message, undefined, options);
    this.name = "UniqueConstraintViolationError";
    this.constraint = detail.constraint;
    this.table = detail.table;
    this.columns = detail.columns;
  }
}
