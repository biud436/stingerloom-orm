/**
 * Regex pattern normalization shared by `ColumnExpression.matches()`, the
 * dialect `regexMatch` renderers, and the SQLite `regexp` UDF.
 *
 * A `.matches()` argument is either a raw pattern string or a JS `RegExp`.
 * We normalize both to a pattern plus a small set of portable flags, then
 * encode the flags as an inline `(?ims)` prefix on the pattern so the same
 * bound string flows through every dialect:
 *
 * - PostgreSQL ARE and MySQL/MariaDB ICU regex both understand the inline
 *   `(?i)` / `(?m)` / `(?s)` option groups natively.
 * - SQLite has no native regex engine, so the registered `regexp` UDF runs
 *   the pattern through a JS `RegExp` — but JS does *not* accept inline flag
 *   groups, so {@link parseInlineFlags} strips the prefix back into JS flags.
 *
 * Note on portability: `i` (case-insensitive) is consistent across engines;
 * `m` and `s` have engine-specific newline semantics (documented in the
 * query-builder guide). Patterns are always bound as parameters, so there is
 * no SQL-injection surface; a hostile pattern can still cause ReDoS, which
 * is the caller's responsibility.
 */

/** Accepted input to `.matches()` — a raw pattern string or a JS `RegExp`. */
export type RegexInput = string | RegExp;

/** Normalized regex: the bare pattern plus the portable flag set. */
export interface ResolvedRegex {
  /** Pattern source (a string passes through; a `RegExp` contributes `.source`). */
  pattern: string;
  /** `i` flag — case-insensitive. Portable across all dialects. */
  caseInsensitive: boolean;
  /** `m` flag — multiline `^`/`$`. Engine-specific newline semantics. */
  multiline: boolean;
  /** `s` flag — dotAll (`.` matches newline). PostgreSQL default; engine-specific. */
  dotAll: boolean;
}

/**
 * Normalize a {@link RegexInput} into a {@link ResolvedRegex}. A string carries
 * no flags (any inline `(?i)` it already contains is left intact and handled
 * natively / by the UDF); a `RegExp` contributes its `i` / `m` / `s` flags.
 * The `g` / `u` / `y` flags are meaningless for a SQL predicate and ignored.
 */
export function resolveRegex(input: RegexInput): ResolvedRegex {
  if (typeof input === "string") {
    return {
      pattern: input,
      caseInsensitive: false,
      multiline: false,
      dotAll: false,
    };
  }
  return {
    pattern: input.source,
    caseInsensitive: input.flags.includes("i"),
    multiline: input.flags.includes("m"),
    dotAll: input.flags.includes("s"),
  };
}

/** The portable flag triplet carried into a dialect `regexMatch` renderer. */
export interface RegexFlagSet {
  caseInsensitive: boolean;
  multiline: boolean;
  dotAll: boolean;
}

/**
 * Encode a flag set as an inline option prefix — `"(?im)"`, `"(?s)"`, etc.,
 * or `""` when no flags are set. Prepend to the pattern before binding.
 */
export function inlineFlagPrefix(flags: RegexFlagSet): string {
  let letters = "";
  if (flags.caseInsensitive) letters += "i";
  if (flags.multiline) letters += "m";
  if (flags.dotAll) letters += "s";
  return letters ? `(?${letters})` : "";
}

/**
 * Split a leading inline-flag group (`"(?im)foo"` → `{ source: "foo",
 * jsFlags: "im" }`) so a JS `RegExp` can be built from it. Used by the SQLite
 * `regexp` UDF, since JS rejects inline option groups. Unknown letters
 * (e.g. PostgreSQL-only `x`) are dropped from the JS flags. A pattern with no
 * leading group passes through unchanged.
 */
export function parseInlineFlags(pattern: string): {
  source: string;
  jsFlags: string;
} {
  const match = /^\(\?([a-z]+)\)/.exec(pattern);
  if (!match) return { source: pattern, jsFlags: "" };
  const letters = match[1];
  let jsFlags = "";
  if (letters.includes("i")) jsFlags += "i";
  if (letters.includes("m")) jsFlags += "m";
  if (letters.includes("s")) jsFlags += "s";
  return { source: pattern.slice(match[0].length), jsFlags };
}
