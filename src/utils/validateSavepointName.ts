import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";

/**
 * Regex pattern allowed for savepoint names.
 * Must start with a letter or underscore, followed by alphanumerics or underscores only.
 */
const SAVEPOINT_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Validates that a savepoint name is safe.
 * Only allows alphanumerics and underscores to prevent SQL injection.
 *
 * @param name - the savepoint name to validate
 * @throws {OrmError} when the name is invalid (OrmErrorCode.INVALID_SAVEPOINT_NAME)
 */
export function validateSavepointName(name: string): void {
  if (!SAVEPOINT_NAME_PATTERN.test(name)) {
    throw new OrmError(
      OrmErrorCode.INVALID_SAVEPOINT_NAME,
      `Invalid savepoint name: "${name}". Savepoint names must start with a letter or underscore and contain only alphanumeric characters and underscores.`,
    );
  }
}
