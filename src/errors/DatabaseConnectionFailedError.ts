import { Exception } from "./Exception";

export class DatabaseConnectionFailedError extends Exception {
  readonly cause?: unknown;

  constructor(originalError?: unknown) {
    const detail =
      originalError instanceof Error
        ? originalError.message
        : originalError != null
          ? String(originalError)
          : undefined;
    super(
      detail
        ? `Failed to connect to the database: ${detail}`
        : "Failed to connect to the database.",
      500,
    );
    if (originalError !== undefined) {
      this.cause = originalError;
    }
  }
}
