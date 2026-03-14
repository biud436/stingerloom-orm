import { OrmErrorCode } from "./OrmErrorCode";

/**
 * ORM 에러의 기본 클래스입니다.
 * 모든 ORM 에러는 이 클래스를 상속합니다.
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
