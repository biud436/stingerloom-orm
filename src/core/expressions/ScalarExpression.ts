/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql, raw, join } from "../../utils/sqlTag";
import type { ConditionLike, ColumnResolver } from "./ConditionLike";
import type {
  CastKind,
  DateAddUnit,
  DateComponent,
  DialectExpression,
} from "../../dialects/DialectExpression";
import { AliasedExpression } from "./AliasedExpression";
import { OrderExpression } from "./OrderExpression";
import { renderExpressionArg } from "./expressionArg";
import { OrmError } from "../../errors/OrmError";
import { OrmErrorCode } from "../../errors/OrmErrorCode";

/**
 * Renderer contract for a scalar SQL expression — produces one `Sql`
 * value per call. Used by {@link ScalarExpression} to defer rendering
 * until the query builder has an alias resolver and dialect handle.
 */
export type ScalarRenderer = (
  resolveColumn: ColumnResolver,
  dialect?: DialectExpression,
) => Sql;

/**
 * A deferred scalar SQL expression — the output of functions that
 * compute a value (`COALESCE(a, b)`, `NULLIF(a, b)`, `CAST(col AS
 * TYPE)`, `EXTRACT(YEAR FROM col)` …).
 *
 * Plays the same dual role as a {@link ColumnExpression}: it can be
 * projected in SELECT via `.as("alias")`, compared with `.eq()` /
 * `.gt()` / `.between()` to produce a {@link ScalarCondition}, and used
 * as an argument to other scalar expressions (so `coalesce(col,
 * nullif(x, y))` composes naturally).
 *
 * @example
 * ```ts
 * const u = qAlias(User, "u");
 * const display = u.nickname.coalesce(u.name, "anonymous");
 *
 * qb.select([display.as("display_name")])
 *   .where(display.eq("admin"));
 * ```
 */
export class ScalarExpression {
  readonly __isScalarExpression = true as const;

  constructor(readonly renderer: ScalarRenderer) {}

  /** Tag this expression for SELECT with a result alias. */
  as(alias: string): AliasedExpression {
    const renderer = this.renderer;
    return new AliasedExpression(alias, (resolveColumn, dialect) =>
      renderer(resolveColumn, dialect),
    );
  }

  eq(value: any): ScalarCondition {
    return new ScalarCondition(this, "=", value);
  }
  neq(value: any): ScalarCondition {
    return new ScalarCondition(this, "!=", value);
  }
  gt(value: any): ScalarCondition {
    return new ScalarCondition(this, ">", value);
  }
  gte(value: any): ScalarCondition {
    return new ScalarCondition(this, ">=", value);
  }
  lt(value: any): ScalarCondition {
    return new ScalarCondition(this, "<", value);
  }
  lte(value: any): ScalarCondition {
    return new ScalarCondition(this, "<=", value);
  }
  between(min: any, max: any): ScalarCondition {
    return new ScalarCondition(this, "BETWEEN", [min, max]);
  }
  in(values: any[]): ScalarCondition {
    return new ScalarCondition(this, "IN", values);
  }
  notIn(values: any[]): ScalarCondition {
    return new ScalarCondition(this, "NOT IN", values);
  }
  isNull(): ScalarCondition {
    return new ScalarCondition(this, "IS NULL", undefined);
  }
  isNotNull(): ScalarCondition {
    return new ScalarCondition(this, "IS NOT NULL", undefined);
  }
  like(pattern: string): ScalarCondition {
    return new ScalarCondition(this, "LIKE", pattern);
  }
  notLike(pattern: string): ScalarCondition {
    return new ScalarCondition(this, "NOT LIKE", pattern);
  }

  // ── CAST helpers — chain a CAST onto any scalar result ──
  /** Wrap in `CAST(... AS TEXT/CHAR)`. */
  stringValue(): ScalarExpression {
    return this.buildCast("string");
  }
  /** Wrap in `CAST(... AS INTEGER/SIGNED)`. */
  intValue(): ScalarExpression {
    return this.buildCast("int");
  }
  /** Wrap in `CAST(... AS BIGINT/SIGNED)`. */
  longValue(): ScalarExpression {
    return this.buildCast("long");
  }
  /** Wrap in `CAST(... AS REAL/DECIMAL)`. */
  floatValue(): ScalarExpression {
    return this.buildCast("float");
  }
  /** Wrap in `CAST(... AS BOOLEAN/UNSIGNED/INTEGER)`. */
  booleanValue(): ScalarExpression {
    return this.buildCast("boolean");
  }
  /** Wrap in `CAST(... AS BIGINT/SIGNED/INTEGER)` — JS `bigint` intent. */
  bigintValue(): ScalarExpression {
    return this.buildCast("bigint");
  }

  private buildCast(kind: CastKind): ScalarExpression {
    const innerRenderer = this.renderer;
    return new ScalarExpression((resolveColumn, dialect) => {
      if (!dialect) {
        throw new Error(
          "CAST expressions require a DialectExpression. Ensure the query " +
            "builder was created via EntityManager.createQueryBuilder().",
        );
      }
      const value = innerRenderer(resolveColumn, dialect);
      const typeName = dialect.castTypeName(kind);
      return sql`CAST(${value} AS ${raw(typeName)})`;
    });
  }

  // ── Date / time component helpers (Tier 2) ─────────────
  /** Extract year. */
  year(): ScalarExpression {
    return this.buildDateComponent("year");
  }
  /** Extract month (1–12). */
  month(): ScalarExpression {
    return this.buildDateComponent("month");
  }
  /** Alias of `.dayOfMonth()`. */
  day(): ScalarExpression {
    return this.buildDateComponent("day");
  }
  /** Extract hour (0–23). */
  hour(): ScalarExpression {
    return this.buildDateComponent("hour");
  }
  /** Extract minute of hour (0–59). */
  minute(): ScalarExpression {
    return this.buildDateComponent("minute");
  }
  /** Extract second of minute (0–59). */
  second(): ScalarExpression {
    return this.buildDateComponent("second");
  }
  /** Day of week — engine-specific encoding. */
  dayOfWeek(): ScalarExpression {
    return this.buildDateComponent("dayOfWeek");
  }
  /** Day of month (1–31). */
  dayOfMonth(): ScalarExpression {
    return this.buildDateComponent("dayOfMonth");
  }
  /** Day of year (1–366). */
  dayOfYear(): ScalarExpression {
    return this.buildDateComponent("dayOfYear");
  }
  /** Week of year — engine-specific encoding. */
  week(): ScalarExpression {
    return this.buildDateComponent("week");
  }

  private buildDateComponent(component: DateComponent): ScalarExpression {
    const innerRenderer = this.renderer;
    return new ScalarExpression((resolveColumn, dialect) => {
      if (!dialect) {
        throw new Error(
          "Date component expressions require a DialectExpression. " +
            "Ensure the query builder was created via EntityManager.createQueryBuilder().",
        );
      }
      const value = innerRenderer(resolveColumn, dialect);
      return dialect.dateComponent(value, component);
    });
  }

  // ── String helpers (Tier 3 — chain on any scalar) ──────

  /** `LOWER(x)` — matches JS `String.prototype.toLowerCase`. */
  toLowerCase(): ScalarExpression {
    return buildStringFn("LOWER", this.renderer);
  }
  /** `UPPER(x)`. */
  toUpperCase(): ScalarExpression {
    return buildStringFn("UPPER", this.renderer);
  }
  /** `TRIM(x)`. */
  trim(): ScalarExpression {
    return buildStringFn("TRIM", this.renderer);
  }
  /** `CHAR_LENGTH(x)` — character count (multibyte-safe). */
  length(): ScalarExpression {
    return buildStringFn("CHAR_LENGTH", this.renderer);
  }
  /** `SUBSTR(x, start+1[, end-start])` — JS `substring` semantics. */
  substring(start: number, end?: number): ScalarExpression {
    return buildSubstringFromRenderer(this.renderer, start, end);
  }
  /** `CONCAT(x, ...args)`. */
  concat(...args: unknown[]): ScalarExpression {
    return buildConcatFromRenderer(this.renderer, args);
  }
  /** JS-style `indexOf` — 0-based, `-1` when not found. */
  indexOf(needle: unknown): ScalarExpression {
    return buildIndexOfFromRenderer(this.renderer, needle);
  }
  /** `REPLACE(x, from, to)`. */
  replace(from: unknown, to: unknown): ScalarExpression {
    return buildReplaceFromRenderer(this.renderer, from, to);
  }

  // ── Numeric (Tier 3) ───────────────────────────────────
  add(right: unknown): ScalarExpression {
    return buildBinaryOpFromRenderer(this.renderer, "+", right);
  }
  sub(right: unknown): ScalarExpression {
    return buildBinaryOpFromRenderer(this.renderer, "-", right);
  }
  mul(right: unknown): ScalarExpression {
    return buildBinaryOpFromRenderer(this.renderer, "*", right);
  }
  div(right: unknown): ScalarExpression {
    return buildBinaryOpFromRenderer(this.renderer, "/", right);
  }
  /**
   * `(x % y)` — standard SQL on PostgreSQL / SQLite; MySQL also accepts
   * `%` as a MOD operator. Result semantics match JS `%` for positive
   * operands; for negative values, SQL engines differ (MySQL/SQLite
   * match JS, PostgreSQL returns the sign of the dividend).
   */
  mod(right: unknown): ScalarExpression {
    return buildBinaryOpFromRenderer(this.renderer, "%", right);
  }
  neg(): ScalarExpression {
    return buildUnaryNegFromRenderer(this.renderer);
  }

  // ── Math (Tier 3) ──────────────────────────────────────
  abs(): ScalarExpression {
    return buildStringFn("ABS", this.renderer);
  }
  floor(): ScalarExpression {
    return buildStringFn("FLOOR", this.renderer);
  }
  /**
   * `CEIL(x)` — MySQL, PostgreSQL, and SQLite (SQLite 3.35+) all accept
   * `CEIL`. Older SQLite may require `CEILING` or a compile flag; this
   * helper uses `CEIL` which matches PostgreSQL and MySQL docs.
   */
  ceil(): ScalarExpression {
    return buildStringFn("CEIL", this.renderer);
  }
  /**
   * `ROUND(x)` or `ROUND(x, digits)`. Positive `digits` rounds to that
   * many decimal places; 0 (default) rounds to integer.
   */
  round(digits?: number): ScalarExpression {
    return buildRoundFromRenderer(this.renderer, digits);
  }
  sqrt(): ScalarExpression {
    return buildStringFn("SQRT", this.renderer);
  }

  // ── Ordering helpers — use the scalar expression as ORDER BY ──

  /** Sort by this scalar expression ascending. */
  asc(): OrderExpression {
    const renderer = this.renderer;
    return new OrderExpression(
      "",
      "ASC",
      undefined,
      true,
      (resolveColumn, dialect) => renderer(resolveColumn, dialect),
    );
  }
  /** Sort by this scalar expression descending. */
  desc(): OrderExpression {
    const renderer = this.renderer;
    return new OrderExpression(
      "",
      "DESC",
      undefined,
      true,
      (resolveColumn, dialect) => renderer(resolveColumn, dialect),
    );
  }

  // ── Date arithmetic (Tier 3) — `value + N units`; negative `n` subtracts ──
  addYears(n: number): ScalarExpression {
    return buildDateAddFromRenderer(this.renderer, n, "year");
  }
  addMonths(n: number): ScalarExpression {
    return buildDateAddFromRenderer(this.renderer, n, "month");
  }
  addDays(n: number): ScalarExpression {
    return buildDateAddFromRenderer(this.renderer, n, "day");
  }
  addHours(n: number): ScalarExpression {
    return buildDateAddFromRenderer(this.renderer, n, "hour");
  }
  addMinutes(n: number): ScalarExpression {
    return buildDateAddFromRenderer(this.renderer, n, "minute");
  }
  addSeconds(n: number): ScalarExpression {
    return buildDateAddFromRenderer(this.renderer, n, "second");
  }
}

// ── Rendering behind the helper methods ──
// A ColumnExpression's helpers run through these as well, on a
// ScalarExpression of its column reference.

/**
 * @internal The error a dialect-dependent expression throws when it is
 * rendered without a dialect.
 */
export function dialectRequired(feature: string): OrmError {
  return new OrmError(
    OrmErrorCode.INVALID_QUERY,
    `${feature} requires a DialectExpression. Ensure the query builder was ` +
      "created via EntityManager.createQueryBuilder() — the dialect is propagated " +
      "from the active EntityManager, so a builder constructed in isolation has no " +
      "way to render dialect-specific SQL.",
  );
}

/** @internal Build `FN(x)` wrapping the inner renderer. */
function buildStringFn(fn: string, inner: ScalarRenderer): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    const v = inner(resolveColumn, dialect);
    return sql`${raw(fn)}(${v})`;
  });
}

/**
 * `SUBSTR(x, jsStart + 1[, end - jsStart])` — JS `substring` semantics
 * (0-based, end exclusive). Negative arguments are not adjusted: SQL
 * engines interpret them engine-specifically, so clamp at the call site.
 */
function buildSubstringFromRenderer(
  inner: ScalarRenderer,
  start: number,
  end: number | undefined,
): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    const v = inner(resolveColumn, dialect);
    const sqlStart = start + 1;
    if (end === undefined) return sql`SUBSTR(${v}, ${sqlStart})`;
    const length = end - start;
    return sql`SUBSTR(${v}, ${sqlStart}, ${length})`;
  });
}

function buildConcatFromRenderer(
  inner: ScalarRenderer,
  args: unknown[],
): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    const head = inner(resolveColumn, dialect);
    const tail = args.map((a) => renderExpressionArg(a, resolveColumn, dialect));
    return sql`CONCAT(${join([head, ...tail], ", ")})`;
  });
}

/** `STRPOS / LOCATE / INSTR` (dialect-specific) minus 1 — 0-based, `-1` when absent. */
function buildIndexOfFromRenderer(
  inner: ScalarRenderer,
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
    const n = renderExpressionArg(needle, resolveColumn, dialect);
    return sql`(${dialect.stringIndexOf(haystack, n)} - 1)`;
  });
}

function buildReplaceFromRenderer(
  inner: ScalarRenderer,
  from: unknown,
  to: unknown,
): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    const v = inner(resolveColumn, dialect);
    const a = renderExpressionArg(from, resolveColumn, dialect);
    const b = renderExpressionArg(to, resolveColumn, dialect);
    return sql`REPLACE(${v}, ${a}, ${b})`;
  });
}

function buildBinaryOpFromRenderer(
  inner: ScalarRenderer,
  op: string,
  right: unknown,
): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    const left = inner(resolveColumn, dialect);
    const r = renderExpressionArg(right, resolveColumn, dialect);
    return sql`(${left} ${raw(op)} ${r})`;
  });
}

function buildUnaryNegFromRenderer(inner: ScalarRenderer): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    return sql`(-${inner(resolveColumn, dialect)})`;
  });
}

function buildRoundFromRenderer(
  inner: ScalarRenderer,
  digits: number | undefined,
): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    const v = inner(resolveColumn, dialect);
    if (digits === undefined) return sql`ROUND(${v})`;
    return sql`ROUND(${v}, ${digits})`;
  });
}

function buildDateAddFromRenderer(
  inner: ScalarRenderer,
  n: number,
  unit: DateAddUnit,
): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    if (!dialect) {
      throw dialectRequired("Date add expressions");
    }
    const v = inner(resolveColumn, dialect);
    return dialect.dateAdd(v, n, unit);
  });
}

/**
 * Type guard — true if `value` is a {@link ScalarExpression}.
 */
export function isScalarExpression(
  value: unknown,
): value is ScalarExpression {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __isScalarExpression?: unknown }).__isScalarExpression === true
  );
}

/**
 * A deferred WHERE / HAVING condition comparing a {@link ScalarExpression}
 * to a scalar value (or BETWEEN range / IN list).
 *
 * Implements {@link ConditionLike}, so it can be passed to `where()`,
 * `andWhere()`, `orWhere()`, or `having()`.
 */
export class ScalarCondition implements ConditionLike {
  readonly __isCondition = true as const;
  readonly __isScalarCondition = true as const;

  constructor(
    readonly expression: ScalarExpression,
    readonly operator: string,
    readonly value: unknown,
  ) {}

  resolve(resolveColumn: ColumnResolver, dialect?: DialectExpression): Sql {
    const expr = this.expression.renderer(resolveColumn, dialect);
    const op = this.operator;
    // Unwrap any column / scalar expression on the right-hand side so
    // `u.price.mul(2).gt(u.cost)` compares against the column reference
    // instead of binding the expression object as a parameter. Plain
    // primitives still flow through `sql` as bound parameters.
    const rhs = (v: unknown) => renderExpressionArg(v, resolveColumn, dialect);

    if (op === "IS NULL") return sql`${expr} IS NULL`;
    if (op === "IS NOT NULL") return sql`${expr} IS NOT NULL`;
    if (op === "BETWEEN") {
      const [min, max] = this.value as [any, any];
      return sql`${expr} BETWEEN ${rhs(min)} AND ${rhs(max)}`;
    }
    if (op === "IN" || op === "NOT IN") {
      const values = (this.value as any[]) ?? [];
      if (values.length === 0) {
        return op === "IN" ? sql`1 = 0` : sql`1 = 1`;
      }
      const placeholders = values.map((v) => rhs(v));
      return sql`${expr} ${raw(op)} (${join(placeholders, ", ")})`;
    }
    return sql`${expr} ${raw(op)} ${rhs(this.value)}`;
  }

  /** Compose with another condition using AND. */
  and(other: ConditionLike): ConditionLike {
    return LogicalComposer.and(this, other);
  }
  /** Compose with another condition using OR. */
  or(other: ConditionLike): ConditionLike {
    return LogicalComposer.or(this, other);
  }
  /** Negate this scalar condition. */
  not(): ConditionLike {
    return LogicalComposer.not(this);
  }
}

/**
 * Type guard — true if `value` is a {@link ScalarCondition}.
 */
export function isScalarCondition(value: unknown): value is ScalarCondition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __isScalarCondition?: unknown }).__isScalarCondition === true
  );
}

/**
 * @internal Indirection layer so this file avoids a cycle with
 * {@link LogicalCondition}. Wired up at module load time via
 * {@link registerScalarLogicalComposer}.
 */
type LogicalComposerFns = {
  and(a: ConditionLike, b: ConditionLike): ConditionLike;
  or(a: ConditionLike, b: ConditionLike): ConditionLike;
  not(a: ConditionLike): ConditionLike;
};

let LogicalComposer: LogicalComposerFns = {
  and: () => {
    throw new Error(
      "LogicalCondition not registered. Ensure '@stingerloom/orm' is imported via its public entrypoint.",
    );
  },
  or: () => {
    throw new Error(
      "LogicalCondition not registered. Ensure '@stingerloom/orm' is imported via its public entrypoint.",
    );
  },
  not: () => {
    throw new Error(
      "LogicalCondition not registered. Ensure '@stingerloom/orm' is imported via its public entrypoint.",
    );
  },
};

/**
 * @internal Wire up the logical-composer functions after
 * {@link LogicalCondition} has been loaded. Called once from
 * `LogicalCondition.ts`.
 */
export function registerScalarLogicalComposer(fns: LogicalComposerFns): void {
  LogicalComposer = fns;
}
