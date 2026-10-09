import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";
import { closestIdentifier } from "./closestIdentifier";

const VALID_LEVELS = [
  "READ UNCOMMITTED",
  "READ COMMITTED",
  "REPEATABLE READ",
  "SERIALIZABLE",
] as const;

export function validateIsolationLevel(level: string): void {
  if (!VALID_LEVELS.includes(level as any)) {
    const suggestion =
      typeof level === "string" ? closestIdentifier(level, VALID_LEVELS) : null;
    throw new OrmError(
      OrmErrorCode.INVALID_CONFIG,
      `Invalid transaction isolation level: ${JSON.stringify(level)}.` +
        (suggestion ? ` Did you mean "${suggestion}"?` : ""),
      `Use one of: ${VALID_LEVELS.join(", ")}.`,
    );
  }
}
