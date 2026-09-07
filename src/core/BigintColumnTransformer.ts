import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";

/**
 * Entity-side representation of a `bigint` column.
 *
 * - `"number"` (default) — a plain JS number. Values outside the safe-integer
 *   range (±2^53) throw {@link OrmErrorCode.BIGINT_PRECISION_LOSS} instead of
 *   being rounded silently.
 * - `"string"` — the decimal digits as a string, lossless and JSON-safe.
 * - `"bigint"` — a native `BigInt`, lossless; `JSON.stringify` needs a
 *   replacer for these values.
 *
 * The driver layer always delivers bigint values losslessly (integers beyond
 * ±2^53 arrive as decimal strings on every driver); this mode only decides
 * what the entity property holds.
 */
export type BigintMode = "number" | "string" | "bigint";

export const DEFAULT_BIGINT_MODE: BigintMode = "number";

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = -MAX_SAFE;

/** Decimal integer literal, optionally signed — the driver-level bigint form. */
const INTEGER_STRING = /^-?\d+$/;

function precisionLoss(value: unknown, where: string): OrmError {
  return new OrmError(
    OrmErrorCode.BIGINT_PRECISION_LOSS,
    `${where} holds ${String(value)}, which cannot be represented exactly as a JS number (outside ±2^53).`,
    `Read the column losslessly with @Column({ type: "bigint", bigintMode: "string" }) ` +
      `or bigintMode: "bigint" (t.bigint({ mode: "string" | "bigint" }) for defineEntity).`,
  );
}

/**
 * Converts a driver-level integer value (number, decimal string or BigInt)
 * to the representation `mode` asks for. Non-integer inputs (NULL, floats,
 * arbitrary text) pass through untouched — the caller decides what they mean.
 *
 * @param where - label used in the precision-loss error, e.g. `User.balance`
 */
export function normalizeBigintValue(
  value: unknown,
  mode: BigintMode,
  where: string,
): unknown {
  if (value === null || value === undefined) return value;

  switch (mode) {
    case "number": {
      if (typeof value === "number") {
        if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
          throw precisionLoss(value, where);
        }
        return value;
      }
      if (typeof value === "bigint") {
        if (value > MAX_SAFE || value < MIN_SAFE) throw precisionLoss(value, where);
        return Number(value);
      }
      if (typeof value === "string" && INTEGER_STRING.test(value)) {
        const asNumber = Number(value);
        if (!Number.isSafeInteger(asNumber)) throw precisionLoss(value, where);
        return asNumber;
      }
      return value;
    }
    case "string": {
      if (typeof value === "bigint") return value.toString();
      if (typeof value === "number" && Number.isInteger(value)) {
        // Safe integers only reach this branch (drivers hand unsafe ones over
        // as strings), so String() cannot pick exponent notation.
        return String(value);
      }
      return value;
    }
    case "bigint": {
      if (typeof value === "bigint") return value;
      if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
      if (typeof value === "string" && INTEGER_STRING.test(value)) return BigInt(value);
      return value;
    }
    default:
      return value;
  }
}

/**
 * Read-side transform for a `bigint` column, bound to its mode. Used by the
 * result transformer the same way the temporal / JSON defaults are.
 */
export function makeBigintColumnRead(
  mode: BigintMode,
  entityName: string,
  propertyKey: string,
): (raw: unknown) => unknown {
  const where = `${entityName}.${propertyKey}`;
  return (raw) => normalizeBigintValue(raw, mode, where);
}

/**
 * Coerces an aggregate result (`SUM` / `MIN` / `MAX` / `COUNT`) to a number
 * the way the aggregate APIs promise, but refuses to round an integer that
 * the driver delivered losslessly beyond ±2^53. Fractional results (`AVG`,
 * decimal `SUM`) go through `Number()` unchanged.
 */
export function aggregateToNumber(value: unknown, where: string): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") {
    return normalizeBigintValue(value, "number", where) as number;
  }
  if (typeof value === "string" && INTEGER_STRING.test(value)) {
    return normalizeBigintValue(value, "number", where) as number;
  }
  return Number(value);
}
