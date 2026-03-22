import { OrmError } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

export class ValidationError extends OrmError {
  constructor(
    public readonly field: string,
    public readonly constraint: string,
    message: string,
    public readonly actual?: unknown,
    public readonly expected?: unknown,
  ) {
    const details =
      actual !== undefined || expected !== undefined
        ? ` (actual: ${JSON.stringify(actual)}, expected: ${JSON.stringify(expected)})`
        : "";
    super(
      OrmErrorCode.VALIDATION_FAILED,
      `${message}${details}`,
      `Check the "${field}" field — it failed the "${constraint}" validation.`,
    );
    this.name = "ValidationError";
  }
}
