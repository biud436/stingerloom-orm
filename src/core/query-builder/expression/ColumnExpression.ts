/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql, raw } from "../../../utils/sqlTag";
import { ColumnCondition } from "../condition/ColumnCondition";
import { OrmError } from "../../../errors/OrmError";
import { OrmErrorCode } from "../../../errors/OrmErrorCode";
import type { ConditionLike } from "../../expressions/ConditionLike";
import { OrderExpression } from "../../expressions/OrderExpression";
import { AggregateExpression } from "../../expressions/AggregateExpression";
import { escapeLikeValue } from "../../expressions/likeEscape";
import {
  resolveRegex,
  inlineFlagPrefix,
  type RegexInput,
} from "../../expressions/RegexPattern";
import { AliasedExpression } from "../../expressions/AliasedExpression";
import type { ScalarExpression } from "../../expressions/ScalarExpression";
import { coalesce as coalesceFn } from "../../expressions/NullishExpression";
import { buildCastScalar } from "../../expressions/CastExpression";
import { buildDateComponentFromRef } from "../../expressions/DateComponentExpression";
import {
  buildToLowerCase,
  buildToUpperCase,
  buildTrim,
  buildLength,
  buildSubstring,
  buildConcat,
  buildIndexOf,
  buildReplace,
  type InnerRenderer,
} from "../../expressions/StringExpression";
import {
  buildAdd,
  buildSub,
  buildMul,
  buildDiv,
  buildMod,
  buildNeg,
  buildAbs,
  buildFloor,
  buildCeil,
  buildRound,
  buildSqrt,
} from "../../expressions/NumericExpression";
import { buildDateAdd } from "../../expressions/DateArithmeticExpression";
import type {
  ArrayOperator,
  CastKind,
  DateAddUnit,
  DateComponent,
  FullTextSearchOptions,
} from "../../../dialects/DialectExpression";

/**
 * A typed column expression providing QueryDSL-style condition builders.
 *
 * Each method returns a `ColumnCondition` that can be passed directly
 * to `where()`, `andWhere()`, or `orWhere()`.
 *
 * @example
 * ```ts
 * const u = qAlias(User, "u");
 * qb.where(u.firstName.eq("Alice"))
 *   .where(u.age.gte(18))
 *   .where(u.name.like("%John%"))
 *   .where(u.status.in(["active", "pending"]))
 *   .where(u.deletedAt.isNull())
 * ```
 */
export class ColumnExpression {
  readonly __isColumnExpression = true as const;
  constructor(private readonly ref: string) {}

  /** `column = value` */
  eq(value: any): ColumnCondition { return new ColumnCondition(this.ref, "=", value); }
  /** `column != value` */
  neq(value: any): ColumnCondition { return new ColumnCondition(this.ref, "!=", value); }
  /** `column > value` */
  gt(value: any): ColumnCondition { return new ColumnCondition(this.ref, ">", value); }
  /** `column >= value` */
  gte(value: any): ColumnCondition { return new ColumnCondition(this.ref, ">=", value); }
  /** `column < value` */
  lt(value: any): ColumnCondition { return new ColumnCondition(this.ref, "<", value); }
  /** `column <= value` */
  lte(value: any): ColumnCondition { return new ColumnCondition(this.ref, "<=", value); }
  /** `column LIKE pattern` (pattern passed through verbatim — wildcards kept). */
  like(pattern: string): ColumnCondition { return new ColumnCondition(this.ref, "LIKE", pattern); }
  /** `column NOT LIKE pattern` (pattern passed through verbatim). */
  notLike(pattern: string): ColumnCondition { return new ColumnCondition(this.ref, "NOT LIKE", pattern); }
  /** `column IN (values)` — accepts either a value list or a subquery. */
  in(values: any[]): ColumnCondition;
  in(subquery: { toSql(): Sql }): ColumnCondition;
  in(valuesOrSubquery: any[] | { toSql(): Sql }): ColumnCondition {
    return new ColumnCondition(this.ref, "IN", valuesOrSubquery);
  }
  /** `column NOT IN (values)` — accepts either a value list or a subquery. */
  notIn(values: any[]): ColumnCondition;
  notIn(subquery: { toSql(): Sql }): ColumnCondition;
  notIn(valuesOrSubquery: any[] | { toSql(): Sql }): ColumnCondition {
    return new ColumnCondition(this.ref, "NOT IN", valuesOrSubquery);
  }
  /** `column IS NULL` */
  isNull(): ColumnCondition { return new ColumnCondition(this.ref, "IS NULL", undefined); }
  /** `column IS NOT NULL` */
  isNotNull(): ColumnCondition { return new ColumnCondition(this.ref, "IS NOT NULL", undefined); }
  /** `column BETWEEN min AND max` */
  between(min: any, max: any): ColumnCondition { return new ColumnCondition(this.ref, "BETWEEN", [min, max]); }

  // ── String convenience (Tier 1) ─────────────────────────
  // These escape LIKE metacharacters in user input so "50%" does not
  // match "starts with 50" patterns; callers who want raw wildcards
  // should use .like() instead.

  /** `column LIKE 'value%' ESCAPE '\\'` — matches strings starting with `value`. */
  startsWith(value: string): ColumnCondition {
    const pattern = `${escapeLikeValue(value)}%`;
    return this.likeWithEscape(pattern);
  }
  /** `column LIKE '%value' ESCAPE '\\'` — matches strings ending with `value`. */
  endsWith(value: string): ColumnCondition {
    const pattern = `%${escapeLikeValue(value)}`;
    return this.likeWithEscape(pattern);
  }
  /** `column LIKE '%value%' ESCAPE '\\'` — substring match. */
  contains(value: string): ColumnCondition {
    const pattern = `%${escapeLikeValue(value)}%`;
    return this.likeWithEscape(pattern);
  }

  private likeWithEscape(pattern: string): ColumnCondition {
    return new ColumnCondition(
      this.ref,
      "_LIKE_ESCAPED",
      pattern,
      (qualified) => sql`${raw(qualified)} LIKE ${pattern} ESCAPE ${"\\"}`,
    );
  }

  /**
   * `LOWER(column) = LOWER(value)` — collation-independent case-insensitive
   * equality. Works on every dialect without relying on case-insensitive
   * collation settings.
   */
  equalsIgnoreCase(value: string): ColumnCondition {
    return new ColumnCondition(
      this.ref,
      "_CI_EQ",
      value,
      (qualified) =>
        sql`LOWER(${raw(qualified)}) = LOWER(${value})`,
    );
  }

  /**
   * Case-insensitive LIKE. Pattern metacharacters are NOT auto-escaped
   * (pass-through — matches the semantics of `.like()`).
   *
   * - PostgreSQL: native `ILIKE`
   * - MySQL/SQLite: `LOWER(col) LIKE LOWER(pattern) ESCAPE '\\'`
   */
  likeIgnoreCase(pattern: string): ColumnCondition {
    return this.ciLike(pattern);
  }

  /** Case-insensitive "starts with". Escapes metacharacters in `value`. */
  startsWithIgnoreCase(value: string): ColumnCondition {
    return this.ciLike(`${escapeLikeValue(value)}%`);
  }
  /** Case-insensitive "ends with". Escapes metacharacters in `value`. */
  endsWithIgnoreCase(value: string): ColumnCondition {
    return this.ciLike(`%${escapeLikeValue(value)}`);
  }
  /** Case-insensitive substring match. Escapes metacharacters in `value`. */
  containsIgnoreCase(value: string): ColumnCondition {
    return this.ciLike(`%${escapeLikeValue(value)}%`);
  }

  private ciLike(pattern: string): ColumnCondition {
    return new ColumnCondition(
      this.ref,
      "_CI_LIKE",
      pattern,
      (qualified, dialect) => {
        if (dialect) {
          return dialect.caseInsensitiveLike(qualified, pattern);
        }
        // No dialect available (detached expression) — fall back to a
        // collation-agnostic LOWER() comparison that works everywhere.
        return sql`LOWER(${raw(qualified)}) LIKE LOWER(${pattern}) ESCAPE ${"\\"}`;
      },
    );
  }

  /**
   * Regular-expression match — `column ~ pattern` (PostgreSQL) /
   * `column REGEXP pattern` (MySQL/SQLite). Accepts a raw pattern string or a
   * JS `RegExp`; the `RegExp` `i` / `m` / `s` flags are carried as an inline
   * `(?ims)` option group on the bound pattern (no injection surface).
   *
   * `i` (case-insensitive) is portable; `m` / `s` carry engine-specific
   * newline semantics. SQLite is served by the connector's `regexp` UDF.
   * Negate with `.not()`.
   *
   * @example
   * ```ts
   * const u = qAlias(User, "u");
   * qb.where(u.email.matches("^[^@]+@example\\.com$"));
   * qb.where(u.title.matches(/typescript/i));
   * qb.where(u.slug.matches(/^[a-z0-9-]+$/).not());
   * ```
   */
  matches(pattern: RegexInput): ColumnCondition {
    const resolved = resolveRegex(pattern);
    const flags = {
      caseInsensitive: resolved.caseInsensitive,
      multiline: resolved.multiline,
      dotAll: resolved.dotAll,
    };
    return new ColumnCondition(
      this.ref,
      "_REGEX",
      resolved.pattern,
      (qualified, dialect) => {
        const col = raw(qualified);
        if (dialect) {
          return dialect.regexMatch(col, resolved.pattern, flags);
        }
        // No dialect available (detached expression) — emit the portable
        // REGEXP form (PostgreSQL would need `~`, but a detached expression
        // is not bound to a dialect).
        return sql`${col} REGEXP ${inlineFlagPrefix(flags) + resolved.pattern}`;
      },
    );
  }

  /**
   * Full-text search predicate over this (single) column — the `qAlias()`
   * counterpart of `find({ search })` / `Conditions.fullTextSearch`.
   *
   * - PostgreSQL: `to_tsvector(lang, col) @@ plainto_tsquery(lang, query)`
   *   (`options.language`, default `"english"`).
   * - MySQL: `MATCH(col) AGAINST(query IN BOOLEAN|NATURAL LANGUAGE MODE)`
   *   (`options.mode`, default `"boolean"`; a `FULLTEXT` index is required).
   * - SQLite: throws `OrmError(UNSUPPORTED_DATABASE)` — use FTS5 virtual
   *   tables with `em.query()`.
   *
   * The query string is bound as a parameter. Negate with `.not()` and
   * compose with `.and()` / `.or()`. For multi-column matching use
   * `Conditions.fullTextSearch([c1, c2], query, options)`.
   *
   * @example
   * ```ts
   * const a = qAlias(Article, "a");
   * qb.where(a.body.matchAgainst("typescript orm", { mode: "boolean" }));
   * ```
   */
  matchAgainst(
    query: string,
    options?: FullTextSearchOptions,
  ): ColumnCondition {
    return new ColumnCondition(this.ref, "_FTS", query, (qualified, dialect) => {
      if (!dialect) {
        throw new OrmError(
          OrmErrorCode.INVALID_QUERY,
          "matchAgainst() needs a dialect-bound query builder — it has no " +
            "dialect-agnostic form. Use it inside em.createQueryBuilder(...).",
        );
      }
      return dialect.fullTextSearch(qualified, query, options);
    });
  }

  /**
   * PostgreSQL array containment — `column @> ARRAY[...]`: true when this
   * array column contains **all** of `values`. The symmetric counterpart of
   * the JSON-path `.contains()`.
   *
   * PostgreSQL-only; MySQL/SQLite throw `OrmError(UNSUPPORTED_DATABASE)` (no
   * native array column type). The value array is bound as a single
   * parameter. Negate with `.not()`.
   *
   * @example
   * ```ts
   * const u = qAlias(User, "u");
   * qb.where(u.tags.arrayContains(["admin", "beta"]));   // tags @> $1
   * ```
   */
  arrayContains(values: unknown[]): ColumnCondition {
    return this.arrayPredicate("contains", values);
  }

  /**
   * PostgreSQL array overlap — `column && ARRAY[...]`: true when this array
   * column shares **at least one** element with `values`. PostgreSQL-only.
   */
  arrayOverlaps(values: unknown[]): ColumnCondition {
    return this.arrayPredicate("overlaps", values);
  }

  /**
   * PostgreSQL array containment (reversed) — `column <@ ARRAY[...]`: true
   * when **every** element of this array column appears in `values`.
   * PostgreSQL-only.
   */
  arrayContainedBy(values: unknown[]): ColumnCondition {
    return this.arrayPredicate("containedBy", values);
  }

  private arrayPredicate(
    operator: ArrayOperator,
    values: unknown[],
  ): ColumnCondition {
    return new ColumnCondition(
      this.ref,
      "_ARRAY",
      values,
      (qualified, dialect) => {
        if (!dialect) {
          throw new OrmError(
            OrmErrorCode.INVALID_QUERY,
            "Array operators need a dialect-bound query builder. Use them " +
              "inside em.createQueryBuilder(...).",
          );
        }
        return dialect.arrayPredicate(raw(qualified), operator, values);
      },
    );
  }

  // ── Ordering helpers (Tier 1) ──────────────────────────

  /** Ascending ORDER BY on this column. */
  asc(): OrderExpression { return new OrderExpression(this.ref, "ASC"); }
  /** Descending ORDER BY on this column. */
  desc(): OrderExpression { return new OrderExpression(this.ref, "DESC"); }

  // ── SELECT alias (Tier 2) ──────────────────────────────

  /**
   * Tag this column for SELECT with an explicit result alias.
   *
   * Produces `<qualified_col> AS <alias>` in the SELECT list. Only
   * meaningful when passed to `select()` / `addSelect()` — the result
   * is an {@link AliasedExpression}, not a condition, so it cannot
   * appear in `where()` / `having()`.
   *
   * @example
   * ```ts
   * qb.select([u.firstName.as("name"), u.age.as("years")]).getRawMany();
   * ```
   */
  as(alias: string): AliasedExpression {
    const ref = this.ref;
    return new AliasedExpression(alias, (resolveColumn) =>
      sql`${raw(resolveColumn(ref))}`,
    );
  }

  // ── Null handling (Tier 2) ─────────────────────────────

  /**
   * `COALESCE(this, fallback1, fallback2, …)` — returns the first
   * non-null value from left to right. Useful for picking a display
   * name with graceful fallback.
   *
   * Requires at least one fallback. Fallbacks may be other column
   * expressions, scalar expressions, aggregates, JSON path extracts,
   * or plain values (which become bound parameters).
   *
   * @example
   * ```ts
   * qb.select([u.nickname.coalesce(u.name, "anonymous").as("display")]);
   * ```
   */
  coalesce(...fallbacks: unknown[]): ScalarExpression {
    if (fallbacks.length === 0) {
      throw new Error(
        "coalesce() requires at least one fallback argument.",
      );
    }
    return coalesceFn(this, ...fallbacks);
  }

  // ── CAST helpers (Tier 2) ──────────────────────────────

  /** `CAST(column AS <dialect-string-type>)` — TEXT / CHAR. */
  stringValue(): ScalarExpression {
    return this.buildCast("string");
  }
  /** `CAST(column AS <dialect-int-type>)` — INTEGER / SIGNED. */
  intValue(): ScalarExpression {
    return this.buildCast("int");
  }
  /** `CAST(column AS <dialect-long-type>)` — BIGINT / SIGNED. */
  longValue(): ScalarExpression {
    return this.buildCast("long");
  }
  /** `CAST(column AS <dialect-float-type>)` — REAL / DECIMAL. */
  floatValue(): ScalarExpression {
    return this.buildCast("float");
  }
  /** `CAST(column AS <dialect-boolean-type>)` — BOOLEAN / UNSIGNED / INTEGER. */
  booleanValue(): ScalarExpression {
    return this.buildCast("boolean");
  }
  /**
   * `CAST(column AS <dialect-bigint-type>)` — same SQL target as
   * `.longValue()` (BIGINT / SIGNED / INTEGER), but the method name
   * documents the intent for JavaScript `bigint` return values. The
   * driver may still deliver the value as a string; wrap with `BigInt(...)`
   * in application code to get a native `bigint`.
   */
  bigintValue(): ScalarExpression {
    return this.buildCast("bigint");
  }

  private buildCast(kind: CastKind): ScalarExpression {
    const ref = this.ref;
    return buildCastScalar(kind, (resolveColumn) =>
      sql`${raw(resolveColumn(ref))}`,
    );
  }

  // ── Date / time component helpers (Tier 2) ─────────────

  /** `EXTRACT(YEAR …)` / `YEAR(col)` / `strftime('%Y', col)`. */
  year(): ScalarExpression {
    return this.buildDateComponent("year");
  }
  /** `EXTRACT(MONTH …)` / `MONTH(col)` / `strftime('%m', col)`. */
  month(): ScalarExpression {
    return this.buildDateComponent("month");
  }
  /** Alias of `.dayOfMonth()` — 1–31. */
  day(): ScalarExpression {
    return this.buildDateComponent("day");
  }
  /** `EXTRACT(HOUR …)` / `HOUR(col)` / `strftime('%H', col)`. */
  hour(): ScalarExpression {
    return this.buildDateComponent("hour");
  }
  /** Minute of hour, 0–59. */
  minute(): ScalarExpression {
    return this.buildDateComponent("minute");
  }
  /** Second of minute, 0–59. */
  second(): ScalarExpression {
    return this.buildDateComponent("second");
  }
  /** Day of week — engine-specific encoding (see DialectExpression doc). */
  dayOfWeek(): ScalarExpression {
    return this.buildDateComponent("dayOfWeek");
  }
  /** Day of month, 1–31. */
  dayOfMonth(): ScalarExpression {
    return this.buildDateComponent("dayOfMonth");
  }
  /** Day of year, 1–366. */
  dayOfYear(): ScalarExpression {
    return this.buildDateComponent("dayOfYear");
  }
  /** Week of year — engine-specific encoding (see DialectExpression doc). */
  week(): ScalarExpression {
    return this.buildDateComponent("week");
  }

  private buildDateComponent(component: DateComponent): ScalarExpression {
    return buildDateComponentFromRef(component, this.ref);
  }

  // ── String helpers (Tier 3 / JS-idiomatic) ─────────────

  /** `LOWER(col)`. Matches JS `String.prototype.toLowerCase`. */
  toLowerCase(): ScalarExpression {
    return buildToLowerCase(this.innerRenderer());
  }
  /** `UPPER(col)`. Matches JS `String.prototype.toUpperCase`. */
  toUpperCase(): ScalarExpression {
    return buildToUpperCase(this.innerRenderer());
  }
  /** `TRIM(col)`. */
  trim(): ScalarExpression {
    return buildTrim(this.innerRenderer());
  }
  /** `CHAR_LENGTH(col)` — character count (multibyte safe). */
  length(): ScalarExpression {
    return buildLength(this.innerRenderer());
  }
  /**
   * `SUBSTR(col, start+1[, end-start])` — matches JS `String.prototype
   * .substring(indexStart, indexEnd?)` (0-based, end exclusive).
   */
  substring(start: number, end?: number): ScalarExpression {
    return buildSubstring(this.innerRenderer(), start, end);
  }
  /** `CONCAT(col, ...args)`. */
  concat(...args: unknown[]): ScalarExpression {
    return buildConcat(this.innerRenderer(), args);
  }
  /**
   * `STRPOS/LOCATE/INSTR(col, needle) - 1` — returns 0-based position,
   * `-1` when not found. Matches JS `String.prototype.indexOf`.
   */
  indexOf(needle: unknown): ScalarExpression {
    return buildIndexOf(this.innerRenderer(), needle);
  }
  /** `REPLACE(col, from, to)`. */
  replace(from: unknown, to: unknown): ScalarExpression {
    return buildReplace(this.innerRenderer(), from, to);
  }

  // ── Numeric arithmetic (Tier 3) ────────────────────────

  /** `(col + right)`. Right may be a primitive or another expression. */
  add(right: unknown): ScalarExpression {
    return buildAdd(this.innerRenderer(), right);
  }
  /** `(col - right)`. */
  sub(right: unknown): ScalarExpression {
    return buildSub(this.innerRenderer(), right);
  }
  /** `(col * right)`. */
  mul(right: unknown): ScalarExpression {
    return buildMul(this.innerRenderer(), right);
  }
  /** `(col / right)`. */
  div(right: unknown): ScalarExpression {
    return buildDiv(this.innerRenderer(), right);
  }
  /** `(col % right)`. */
  mod(right: unknown): ScalarExpression {
    return buildMod(this.innerRenderer(), right);
  }
  /** `-col`. */
  neg(): ScalarExpression {
    return buildNeg(this.innerRenderer());
  }

  // ── Math functions (Tier 3) ────────────────────────────

  /** `ABS(col)`. */
  abs(): ScalarExpression {
    return buildAbs(this.innerRenderer());
  }
  /** `FLOOR(col)`. */
  floor(): ScalarExpression {
    return buildFloor(this.innerRenderer());
  }
  /** `CEIL(col)`. */
  ceil(): ScalarExpression {
    return buildCeil(this.innerRenderer());
  }
  /** `ROUND(col)` or `ROUND(col, digits)`. */
  round(digits?: number): ScalarExpression {
    return buildRound(this.innerRenderer(), digits);
  }
  /** `SQRT(col)`. */
  sqrt(): ScalarExpression {
    return buildSqrt(this.innerRenderer());
  }

  // ── Date arithmetic (Tier 3) ───────────────────────────

  /** `col + N years` — calendar-aware on all supported drivers. */
  addYears(n: number): ScalarExpression {
    return this.buildDateAdd(n, "year");
  }
  /** `col + N months` — calendar-aware on all supported drivers. */
  addMonths(n: number): ScalarExpression {
    return this.buildDateAdd(n, "month");
  }
  /** `col + N days`. */
  addDays(n: number): ScalarExpression {
    return this.buildDateAdd(n, "day");
  }
  /** `col + N hours`. */
  addHours(n: number): ScalarExpression {
    return this.buildDateAdd(n, "hour");
  }
  /** `col + N minutes`. */
  addMinutes(n: number): ScalarExpression {
    return this.buildDateAdd(n, "minute");
  }
  /** `col + N seconds`. */
  addSeconds(n: number): ScalarExpression {
    return this.buildDateAdd(n, "second");
  }

  private buildDateAdd(n: number, unit: DateAddUnit): ScalarExpression {
    return buildDateAdd(this.innerRenderer(), n, unit);
  }

  /** @internal Inner-fragment renderer shared by Tier 3 helpers. */
  private innerRenderer(): InnerRenderer {
    const ref = this.ref;
    return (resolveColumn) => sql`${raw(resolveColumn(ref))}`;
  }

  // ── Aggregate helpers (Tier 1) ─────────────────────────

  /** `COUNT(column)` aggregate. */
  count(): AggregateExpression {
    return new AggregateExpression(this.ref, "COUNT", false, undefined);
  }
  /** `COUNT(DISTINCT column)` aggregate. */
  countDistinct(): AggregateExpression {
    return new AggregateExpression(this.ref, "COUNT", true, undefined);
  }
  /** `SUM(column)` aggregate. */
  sum(): AggregateExpression {
    return new AggregateExpression(this.ref, "SUM", false, undefined);
  }
  /** `AVG(column)` aggregate. */
  avg(): AggregateExpression {
    return new AggregateExpression(this.ref, "AVG", false, undefined);
  }
  /** `MIN(column)` aggregate. */
  min(): AggregateExpression {
    return new AggregateExpression(this.ref, "MIN", false, undefined);
  }
  /** `MAX(column)` aggregate. */
  max(): AggregateExpression {
    return new AggregateExpression(this.ref, "MAX", false, undefined);
  }

  /**
   * `COUNT(column) FILTER (WHERE condition)` — count only the rows matching
   * `condition`. Shorthand for `.count().filter(condition)`.
   *
   * @example
   * ```ts
   * const u = qAlias(User, "u");
   * qb.select([u.id.countIf(u.status.eq("active")).as("active")]);
   * ```
   */
  countIf(condition: ConditionLike): AggregateExpression {
    return this.count().filter(condition);
  }

  /**
   * `SUM(column) FILTER (WHERE condition)` — sum `column` over only the rows
   * matching `condition`. Shorthand for `.sum().filter(condition)`.
   *
   * @example
   * ```ts
   * const o = qAlias(Order, "o");
   * qb.select([o.amount.sumIf(o.type.eq("refund")).as("refunds")]);
   * ```
   */
  sumIf(condition: ConditionLike): AggregateExpression {
    return this.sum().filter(condition);
  }

  /** Returns the `"alias.property"` string (for interop with `col()`-style API). */
  toString(): string { return this.ref; }
}
