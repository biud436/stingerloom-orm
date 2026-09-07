/**
 * `JSON.stringify` for log lines: BigInt values (bigint column parameters,
 * lossless driver results) are rendered as their decimal digits instead of
 * throwing `TypeError: Do not know how to serialize a BigInt`, and anything
 * else that cannot be serialized (cycles) falls back to `String(value)`.
 */
export function stringifyForLog(value: unknown, indent?: number): string {
  try {
    return JSON.stringify(
      value,
      (_key, v) => (typeof v === "bigint" ? v.toString() : v),
      indent,
    );
  } catch {
    return String(value);
  }
}
