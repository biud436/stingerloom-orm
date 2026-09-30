import { DefaultValue, stripOuterParens } from "../SchemaIR";

const NUMBER_LITERAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** Whether `text` is a plain SQL numeric literal (`-1`, `0.50`, `1e3`). */
export function isNumberLiteral(text: string): boolean {
  return NUMBER_LITERAL.test(text.trim());
}

/**
 * Reads a quoted SQL string literal that starts at index 0.
 *
 * Returns the decoded value and the index just past the closing quote, or
 * `null` when the text does not start with a complete literal. `''` is always
 * an escaped quote; with `backslashEscapes` (MySQL / MariaDB) so are `\'`,
 * `\\` and the other C-style escapes.
 */
export function readQuotedLiteral(
  text: string,
  quote: "'" | '"' = "'",
  backslashEscapes = false,
): { value: string; end: number } | null {
  if (text[0] !== quote) return null;
  let value = "";
  let i = 1;
  while (i < text.length) {
    const ch = text[i];
    if (backslashEscapes && ch === "\\" && i + 1 < text.length) {
      value += unescapeBackslash(text[i + 1]);
      i += 2;
      continue;
    }
    if (ch === quote) {
      if (text[i + 1] === quote) {
        value += quote;
        i += 2;
        continue;
      }
      return { value, end: i + 1 };
    }
    value += ch;
    i++;
  }
  return null;
}

function unescapeBackslash(ch: string): string {
  switch (ch) {
    case "0":
      return "\0";
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    case "b":
      return "\b";
    case "Z":
      return "\x1a";
    default:
      // \\ → \, \' → ', \" → ", and MySQL's rule for anything else: the
      // backslash is dropped.
      return ch;
  }
}

/**
 * Parses a default the way standard SQL spells it in DDL: `NULL`, a quoted
 * string, a number, `TRUE` / `FALSE`, or an expression. This is how SQLite
 * reports defaults, MariaDB (10.2.7+) too, and PostgreSQL once its casts are
 * removed.
 *
 * `trailing` recognizes text after a quoted literal that does not change the
 * value (PostgreSQL's `::type` casts); anything else after the literal makes
 * the whole default an expression.
 */
export function parseSqlDefault(
  raw: string,
  options: {
    backslashEscapes?: boolean;
    /** Double-quoted text is a string literal (SQLite's legacy leniency). */
    doubleQuotedStrings?: boolean;
    trailing?: RegExp;
  } = {},
): DefaultValue {
  const trimmed = raw.trim();
  const upper = trimmed.toUpperCase();
  if (upper === "NULL") return { kind: "null" };
  if (upper === "TRUE") return { kind: "boolean", value: true };
  if (upper === "FALSE") return { kind: "boolean", value: false };

  for (const quote of options.doubleQuotedStrings ? (["'", '"'] as const) : (["'"] as const)) {
    const literal = readQuotedLiteral(trimmed, quote, options.backslashEscapes);
    if (!literal) continue;
    const rest = trimmed.slice(literal.end);
    if (rest === "" || (options.trailing && options.trailing.test(rest))) {
      return { kind: "string", value: literal.value };
    }
  }

  const unwrapped = stripOuterParens(trimmed);
  if (isNumberLiteral(unwrapped)) return { kind: "number", value: unwrapped };
  if (unwrapped !== trimmed) {
    // `(0)` or `('x')` — a literal someone wrapped in parentheses.
    const inner = parseSqlDefault(unwrapped, options);
    if (inner.kind !== "expression") return inner;
  }
  return { kind: "expression", sql: unwrapped };
}
