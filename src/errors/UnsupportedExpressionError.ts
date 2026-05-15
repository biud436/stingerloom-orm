import { OrmError } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

/**
 * Options for {@link unsupportedExpression}. Each field maps to one of the
 * questions a caller will ask after hitting a "not supported on this dialect"
 * throw: *why*, *what do I do instead*, *is there an approximate option*.
 *
 * The point of the helper is consistency — every unsupported-on-dialect
 * throw should expose the same shape, so users (and our docs) can rely on
 * the message containing actionable guidance.
 */
export interface UnsupportedExpressionOptions {
  /** Human-readable name of the feature, e.g. `"percentile_cont"` or `"fullTextSearch"`. */
  readonly feature: string;
  /** Active dialect on which the feature was attempted, e.g. `"mysql"` or `"sqlite"`. */
  readonly dialect: string;
  /** Short explanation of why the feature is unavailable here. */
  readonly why: string;
  /**
   * Concrete alternative — an emulation sketch, the recommended escape hatch,
   * or a pointer to the docs recipe. Always required so callers never see a
   * "this is unsupported" error without somewhere to go next.
   */
  readonly alternative: string;
  /**
   * Optional approximate-result option when one exists (e.g. percentile via
   * `ROW_NUMBER()` bucketing). Surfaced separately so callers can choose to
   * accept an inexact answer instead of switching dialects.
   */
  readonly approximate?: string;
  /**
   * Optional docs link / recipe identifier. Defaults to the cookbook page so
   * the message always points somewhere useful.
   */
  readonly docs?: string;
}

/**
 * Build a uniformly formatted {@link OrmError} for "feature X is not
 * supported on dialect Y" cases — the lingua franca for expression
 * compilers (`src/dialects/expression/*`, `src/core/expressions/*`).
 *
 * The thrown error always carries `OrmErrorCode.UNSUPPORTED_OPERATION` and a
 * message that names the feature, the dialect, the reason, and a concrete
 * alternative. Use this instead of `throw new Error("Unsupported X")` or
 * ad-hoc `new OrmError(...)` calls so error consumers can rely on a
 * predictable shape.
 *
 * @example
 * ```ts
 * if (dialect.dialect !== "postgres") {
 *   throw unsupportedExpression({
 *     feature: "percentile_cont",
 *     dialect: dialect.dialect,
 *     why: "MySQL has no native ordered-set aggregate.",
 *     alternative: "Emulate with a CTE: ROW_NUMBER() OVER (ORDER BY x), then pick rn = CEIL(N * p).",
 *     approximate: "Histogram-based bucketing on the same column is a coarser approximation.",
 *     docs: "docs/cookbook.md#cycle-time-percentile-report",
 *   });
 * }
 * ```
 */
export function unsupportedExpression(
  options: UnsupportedExpressionOptions,
): OrmError {
  const { feature, dialect, why, alternative, approximate, docs } = options;
  const docsRef = docs ?? "docs/cookbook.md";
  const parts = [
    `${feature} is not supported on ${dialect}.`,
    `Why: ${why}`,
    `Alternative: ${alternative}`,
  ];
  if (approximate) {
    parts.push(`Approximate: ${approximate}`);
  }
  parts.push(`See: ${docsRef}`);
  return new OrmError(
    OrmErrorCode.UNSUPPORTED_OPERATION,
    parts.join(" "),
    alternative,
  );
}
