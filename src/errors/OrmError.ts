import { OrmErrorCode } from "./OrmErrorCode";

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

  constructor(code: OrmErrorCode, message: string, suggestion?: string) {
    // Merge before super() so the stack trace header carries it too — Node
    // bakes `name: message` into `stack` at construction time.
    super(suggestion ? `${message}\nSuggestion: ${suggestion}` : message);
    this.name = "OrmError";
    this.code = code;
    this.suggestion = suggestion ?? null;
  }
}
