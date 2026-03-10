import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";

/**
 * Savepoint 이름에 허용되는 정규식 패턴입니다.
 * 영문자 또는 밑줄로 시작하고, 이후 영숫자 또는 밑줄만 허용합니다.
 */
const SAVEPOINT_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Savepoint 이름이 유효한지 검증합니다.
 * SQL Injection을 방지하기 위해 영숫자와 밑줄만 허용합니다.
 *
 * @param name - 검증할 savepoint 이름
 * @throws {OrmError} 유효하지 않은 savepoint 이름인 경우 (OrmErrorCode.INVALID_SAVEPOINT_NAME)
 */
export function validateSavepointName(name: string): void {
  if (!SAVEPOINT_NAME_PATTERN.test(name)) {
    throw new OrmError(
      OrmErrorCode.INVALID_SAVEPOINT_NAME,
      `Invalid savepoint name: "${name}". Savepoint names must start with a letter or underscore and contain only alphanumeric characters and underscores.`,
    );
  }
}
