import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";

const VALID_LEVELS = [
  "READ UNCOMMITTED",
  "READ COMMITTED",
  "REPEATABLE READ",
  "SERIALIZABLE",
] as const;

export function validateIsolationLevel(level: string): void {
  if (!VALID_LEVELS.includes(level as any)) {
    throw new OrmError(
      OrmErrorCode.INVALID_CONFIG,
      `Invalid transaction isolation level: "${level}"`,
      `Use one of: ${VALID_LEVELS.join(", ")}.`,
    );
  }
}
