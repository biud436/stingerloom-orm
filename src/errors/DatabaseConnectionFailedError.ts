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
        ? `데이터베이스 연결에 실패했습니다: ${detail}`
        : "데이터베이스 연결에 실패했습니다.",
      500,
    );
    if (originalError !== undefined) {
      this.cause = originalError;
    }
  }
}
