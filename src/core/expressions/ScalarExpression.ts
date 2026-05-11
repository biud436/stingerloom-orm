/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql, raw, join } from "sql-template-tag";
import type { ConditionLike, ColumnResolver } from "./ConditionLike";
import type {
  CastKind,
  DateAddUnit,
  DateComponent,
  DialectExpression,
} from "../../dialects/DialectExpression";
import { AliasedExpression } from "./AliasedExpression";
import { OrderExpression } from "./OrderExpression";

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
  /** `CHAR_LENGTH(x)` — character count. */
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
  ceil(): ScalarExpression {
    return buildStringFn("CEIL", this.renderer);
  }
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

  // ── Date arithmetic (Tier 3) ───────────────────────────
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

// ── Shared helpers for ScalarExpression Tier 3 methods ──

type InnerRender = (r: ColumnResolver, d?: DialectExpression) => Sql;

/** @internal Build `FN(x)` wrapping the inner renderer. */
function buildStringFn(fn: string, inner: InnerRender): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    const v = inner(resolveColumn, dialect);
    return sql`${raw(fn)}(${v})`;
  });
}

/** @internal Render an argument as either a nested expression's inner SQL or a bound parameter. */
function renderArg(
  arg: unknown,
  resolveColumn: ColumnResolver,
  dialect?: DialectExpression,
): Sql {
  if (
    arg !== null &&
    typeof arg === "object" &&
    (arg as { __isScalarExpression?: unknown }).__isScalarExpression === true
  ) {
    return (arg as { renderer: InnerRender }).renderer(resolveColumn, dialect);
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

function buildSubstringFromRenderer(
  inner: InnerRender,
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
  inner: InnerRender,
  args: unknown[],
): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    const head = inner(resolveColumn, dialect);
    const tail = args.map((a) => renderArg(a, resolveColumn, dialect));
    const all = [head, ...tail];
    // Inline manual join to avoid extra import churn.
    let acc = sql`${all[0]}`;
    for (let i = 1; i < all.length; i++) {
      acc = sql`${acc}, ${all[i]}`;
    }
    return sql`CONCAT(${acc})`;
  });
}

function buildIndexOfFromRenderer(
  inner: InnerRender,
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
    const n = renderArg(needle, resolveColumn, dialect);
    return sql`(${dialect.stringIndexOf(haystack, n)} - 1)`;
  });
}

function buildReplaceFromRenderer(
  inner: InnerRender,
  from: unknown,
  to: unknown,
): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    const v = inner(resolveColumn, dialect);
    const a = renderArg(from, resolveColumn, dialect);
    const b = renderArg(to, resolveColumn, dialect);
    return sql`REPLACE(${v}, ${a}, ${b})`;
  });
}

function buildBinaryOpFromRenderer(
  inner: InnerRender,
  op: string,
  right: unknown,
): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    const left = inner(resolveColumn, dialect);
    const r = renderArg(right, resolveColumn, dialect);
    return sql`(${left} ${raw(op)} ${r})`;
  });
}

function buildUnaryNegFromRenderer(inner: InnerRender): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    return sql`(-${inner(resolveColumn, dialect)})`;
  });
}

function buildRoundFromRenderer(
  inner: InnerRender,
  digits: number | undefined,
): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    const v = inner(resolveColumn, dialect);
    if (digits === undefined) return sql`ROUND(${v})`;
    return sql`ROUND(${v}, ${digits})`;
  });
}

function buildDateAddFromRenderer(
  inner: InnerRender,
  n: number,
  unit: DateAddUnit,
): ScalarExpression {
  return new ScalarExpression((resolveColumn, dialect) => {
    if (!dialect) {
      throw new Error(
        "Date add expressions require a DialectExpression. Ensure the query " +
          "builder was created via EntityManager.createQueryBuilder().",
      );
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

    if (op === "IS NULL") return sql`${expr} IS NULL`;
    if (op === "IS NOT NULL") return sql`${expr} IS NOT NULL`;
    if (op === "BETWEEN") {
      const [min, max] = this.value as [any, any];
      return sql`${expr} BETWEEN ${min} AND ${max}`;
    }
    if (op === "IN" || op === "NOT IN") {
      const values = (this.value as any[]) ?? [];
      if (values.length === 0) {
        return op === "IN" ? sql`1 = 0` : sql`1 = 1`;
      }
      const placeholders = values.map((v) => sql`${v}`);
      return sql`${expr} ${raw(op)} (${join(placeholders, ", ")})`;
    }
    return sql`${expr} ${raw(op)} ${this.value as any}`;
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
