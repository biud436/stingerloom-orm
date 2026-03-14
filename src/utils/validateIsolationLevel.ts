const VALID_LEVELS = [
  "READ UNCOMMITTED",
  "READ COMMITTED",
  "REPEATABLE READ",
  "SERIALIZABLE",
] as const;

export function validateIsolationLevel(level: string): void {
  if (!VALID_LEVELS.includes(level as any)) {
    throw new Error(`Invalid transaction isolation level: "${level}"`);
  }
}
