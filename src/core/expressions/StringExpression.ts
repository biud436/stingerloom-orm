import sql, { Sql, raw, join } from "sql-template-tag";
import type { DialectExpression } from "../../dialects/DialectExpression";
import type { ColumnResolver } from "./ConditionLike";
import { ScalarExpression } from "./ScalarExpression";

/**
 * Renderer contract shared by column- and scalar-based callers —
 * produces the inner SQL fragment that string helpers wrap.
 */
export type InnerRenderer = (
  resolveColumn: ColumnResolver,
  dialect?: DialectExpression,
) => Sql;

/**
 * @internal Render any string-function argument:
 * - Column / scalar / JSON-path expressions unwrap to their inner SQL.
 * - Plain primitives are bound as parameters.
 */
export function renderStringArg(
  arg: unknown,
  resolveColumn: ColumnResolver,
  dialect?: DialectExpression,
): Sql {
  if (
    arg !== null &&
    typeof arg === "object" &&
    (arg as { __isScalarExpression?: unknown }).__isScalarExpression === true
  ) {
    return (arg as {
      renderer: (r: ColumnResolver, d?: DialectExpression) => Sql;
    }).renderer(resolveColumn, dialect);
  }
  if (
    arg !== null &&
    typeof arg === "object" &&
    (arg as { __isColumnExpression?: unknown }).__isColumnExpression === true
  ) {
    return sql`${raw(resolveColumn((arg as { toString(): string }).toString()))}`;
  }
  return sql`${arg as string | number | boolean | null}`;
}

// ── Factories — each returns a ScalarExpression ──────────────

/** `LOWER(x)`. Standard SQL, identical on MySQL / PostgreSQL / SQLite. */
export function buildToLowerCase(inner: InnerRenderer): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    const v = inner(resolveColumn, dialect);
    return sql`LOWER(${v})`;
  });
}

/** `UPPER(x)`. Standard SQL. */
export function buildToUpperCase(inner: InnerRenderer): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    const v = inner(resolveColumn, dialect);
    return sql`UPPER(${v})`;
  });
}

/** `TRIM(x)`. Standard SQL. */
export function buildTrim(inner: InnerRenderer): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    const v = inner(resolveColumn, dialect);
    return sql`TRIM(${v})`;
  });
}

/**
 * `CHAR_LENGTH(x)` — number of characters (multibyte-safe). Supported
 * by MySQL, PostgreSQL, and SQLite.
 */
export function buildLength(inner: InnerRenderer): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    const v = inner(resolveColumn, dialect);
    return sql`CHAR_LENGTH(${v})`;
  });
}

/**
 * `SUBSTR(x, jsStart + 1[, end - jsStart])` — matches JS
 * `String.prototype.substring` semantics (0-based, end exclusive).
 * Negative arguments are not adjusted: SQL engines interpret them
 * engine-specifically, mirroring JS behavior for `start < 0` is not
 * portable. Clamp at call site if needed.
 */
export function buildSubstring(
  inner: InnerRenderer,
  start: number,
  end: number | undefined,
): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    const v = inner(resolveColumn, dialect);
    const sqlStart = start + 1;
    if (end === undefined) {
      return sql`SUBSTR(${v}, ${sqlStart})`;
    }
    const length = end - start;
    return sql`SUBSTR(${v}, ${sqlStart}, ${length})`;
  });
}

/**
 * `CONCAT(x, ...args)`. Arguments may be columns, scalar expressions,
 * or plain values — each is rendered independently so bindings are
 * preserved.
 */
export function buildConcat(
  inner: InnerRenderer,
  args: unknown[],
): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    const head = inner(resolveColumn, dialect);
    const tail = args.map((a) => renderStringArg(a, resolveColumn, dialect));
    return sql`CONCAT(${join([head, ...tail], ", ")})`;
  });
}

/**
 * `STRPOS / LOCATE / INSTR` (dialect-specific) minus 1 — matches JS
 * `indexOf` semantics (0-based; `-1` when not found).
 */
export function buildIndexOf(
  inner: InnerRenderer,
  needle: unknown,
): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    if (!dialect) {
      throw new Error(
        "indexOf() requires a DialectExpression. Ensure the query builder was " +
          "created via EntityManager.createQueryBuilder().",
      );
    }
    const haystack = inner(resolveColumn, dialect);
    const needleSql = renderStringArg(needle, resolveColumn, dialect);
    const pos = dialect.stringIndexOf(haystack, needleSql);
    return sql`(${pos} - 1)`;
  });
}

/** `REPLACE(x, from, to)`. Standard SQL. */
export function buildReplace(
  inner: InnerRenderer,
  from: unknown,
  to: unknown,
): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    const v = inner(resolveColumn, dialect);
    const a = renderStringArg(from, resolveColumn, dialect);
    const b = renderStringArg(to, resolveColumn, dialect);
    return sql`REPLACE(${v}, ${a}, ${b})`;
  });
}
