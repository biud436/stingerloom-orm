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
   */
  public readonly suggestion: string | null;

  constructor(code: OrmErrorCode, message: string, suggestion?: string) {
    super(message);
    this.name = "OrmError";
    this.code = code;
    this.suggestion = suggestion ?? null;
  }
}
