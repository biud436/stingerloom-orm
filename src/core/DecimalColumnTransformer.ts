import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";

/**
 * Entity-side representation of a `decimal` column.
 *
 * - `"number"` (default) — a JS number. A stored value the number cannot
 *   hold digit for digit throws {@link OrmErrorCode.DECIMAL_PRECISION_LOSS}
 *   instead of being rounded silently.
 * - `"string"` — the decimal digits as text, exact.
 *
 * PostgreSQL (`NUMERIC`) and mysql2 (`DECIMAL`) deliver the value as text.
 * SQLite has no exact decimal storage and delivers a number; in `"string"`
 * mode it is padded with zeros to the column's scale (never rounded), so
 * `19.9` reads as `"19.90"` the way the other two databases return it.
 */
export type DecimalMode = "number" | "string";

export const DEFAULT_DECIMAL_MODE: DecimalMode = "number";

/** The scale a `decimal` column without an explicit one is created with. */
export const DEFAULT_DECIMAL_SCALE = 2;

/** Plain decimal text as the drivers deliver it: optional sign, digits, optional fraction. */
const DECIMAL_TEXT = /^-?\d+(?:\.\d+)?$/;

function precisionLoss(value: string, where: string): OrmError {
  return new OrmError(
    OrmErrorCode.DECIMAL_PRECISION_LOSS,
    `${where} holds ${value}, which a JS number cannot represent exactly.`,
    `Read the column exactly with @Column({ type: "decimal", decimalMode: "string" }) ` +
      `(t.decimal(precision, scale, { mode: "string" }) for defineEntity).`,
  );
}

/** `"1234.500"` → `"1234.5"`, `"7.000"` → `"7"`. */
function trimFraction(text: string): string {
  if (!text.includes(".")) return text;
  return text.replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Whether `value` reads back as `text`: the same digits once trailing
 * fraction zeros are ignored. A JS number holds about 15–17 significant
 * digits, so wider values (and anything `toFixed` cannot print) fail.
 */
function holdsExactly(value: number, text: string): boolean {
  if (value === 0) return true;
  const trimmed = trimFraction(text);
  const dot = trimmed.indexOf(".");
  const digits = dot < 0 ? 0 : trimmed.length - dot - 1;
  if (digits > 100) return false;
  return value.toFixed(digits) === trimmed;
}

/** A number as decimal text, padded with zeros to `scale` but never rounded. */
function decimalText(value: number, scale: number): string {
  const text = String(value);
  if (scale <= 0 || !DECIMAL_TEXT.test(text)) return text;
  const dot = text.indexOf(".");
  const digits = dot < 0 ? 0 : text.length - dot - 1;
  if (digits >= scale) return text;
  return `${text}${dot < 0 ? "." : ""}${"0".repeat(scale - digits)}`;
}

/**
 * Converts a driver-level decimal value (number or decimal text) to the
 * representation `mode` asks for. Other inputs (PostgreSQL `NaN` /
 * `Infinity`, values a transformer already converted) pass through.
 *
 * @param scale - the column's declared scale, used to pad SQLite numbers in `"string"` mode
 * @param where - label used in the precision-loss error, e.g. `Invoice.total`
 */
export function normalizeDecimalValue(
  value: unknown,
  mode: DecimalMode,
  scale: number,
  where: string,
): unknown {
  if (value === null || value === undefined) return value;
  if (mode === "string") {
    if (typeof value === "number") return decimalText(value, scale);
    if (typeof value === "bigint") return value.toString();
    return value;
  }
  if (typeof value === "bigint") {
    const text = value.toString();
    const asNumber = Number(value);
    if (!holdsExactly(asNumber, text)) throw precisionLoss(text, where);
    return asNumber;
  }
  if (typeof value !== "string" || !DECIMAL_TEXT.test(value)) return value;
  const asNumber = Number(value);
  if (!holdsExactly(asNumber, value)) throw precisionLoss(value, where);
  return asNumber;
}

/** The read conversion for a `decimal` column. */
export function makeDecimalColumnRead(
  mode: DecimalMode,
  scale: number | undefined,
  owner: string,
  key: string,
): (raw: unknown) => unknown {
  const where = `${owner}.${key}`;
  const effectiveScale = scale ?? DEFAULT_DECIMAL_SCALE;
  return (raw) => normalizeDecimalValue(raw, mode, effectiveScale, where);
}
