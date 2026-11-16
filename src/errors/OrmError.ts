import { OrmErrorCode } from "./OrmErrorCode";

/** Options every {@link OrmError} accepts besides its code, message and suggestion. */
export interface OrmErrorOptions {
  /**
   * The error that caused this one, typically the driver's: kept as
   * {@link OrmError.cause} so its own fields (`code: "ECONNREFUSED"`, a
   * PostgreSQL SQLSTATE, a MySQL errno) stay readable.
   */
  cause?: unknown;
}

/**
 * Base class for ORM errors.
 * All ORM-specific errors extend this class.
 */
export class OrmError extends Error {
  public readonly code: OrmErrorCode;

  /**
   * Actionable suggestion to help the user resolve this error.
   * May be null when no specific guidance is available.
   *
   * Also appended to `message` as a trailing `Suggestion: ...` line, so the
   * guidance survives every rendering path (app logs, NestJS filters,
   * uncaught stack traces) — not just consumers that read this field.
   */
  public readonly suggestion: string | null;

  /**
   * The error this one wraps, when it wraps one: the driver error behind a
   * failed connection or DDL statement, for instance. Set the way
   * `new Error(message, { cause })` sets it (own, non-enumerable), and absent
   * when no cause was given.
   */
  declare public readonly cause?: unknown;

  constructor(
    code: OrmErrorCode,
    message: string,
    suggestion?: string,
    options?: OrmErrorOptions,
  ) {
    // Merge before super() so the stack trace header carries it too — Node
    // bakes `name: message` into `stack` at construction time.
    super(suggestion ? `${message}\nSuggestion: ${suggestion}` : message);
    this.name = "OrmError";
    this.code = code;
    this.suggestion = suggestion ?? null;
    if (options && "cause" in options) {
      Object.defineProperty(this, "cause", {
        value: options.cause,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
  }
}
