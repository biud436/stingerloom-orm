/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql, raw, join } from "sql-template-tag";
import type { ConditionLike, ColumnResolver } from "./ConditionLike";
import type { DialectExpression } from "../../dialects/DialectExpression";
import { ScalarExpression } from "./ScalarExpression";

/**
 * @internal Shared helper — render any value usable as a CASE result:
 * a column/scalar expression unwraps to its inner SQL, everything else
 * is bound as a parameter.
 */
function renderResultValue(
  value: unknown,
  resolveColumn: ColumnResolver,
  dialect?: DialectExpression,
): Sql {
  if (
    value !== null &&
    typeof value === "object" &&
    (value as { __isScalarExpression?: unknown }).__isScalarExpression === true
  ) {
    return (value as {
      renderer: (r: ColumnResolver, d?: DialectExpression) => Sql;
    }).renderer(resolveColumn, dialect);
  }
  if (
    value !== null &&
    typeof value === "object" &&
    (value as { __isColumnExpression?: unknown }).__isColumnExpression === true
  ) {
    return sql`${raw(resolveColumn((value as { toString(): string }).toString()))}`;
  }
  return sql`${value as any}`;
}

interface CaseBranch {
  condition: ConditionLike;
  result: unknown;
}

/**
 * Fluent builder for a **searched** `CASE WHEN cond THEN result …
 * ELSE default END` expression.
 *
 * Start via `Expressions.caseBuilder()`. Chain `.when(cond).then(val)`
 * for each branch, optionally finish with `.otherwise(val)`, then call
 * `.end()` to get a {@link ScalarExpression}.
 *
 * For common shapes that don't need a full chain, prefer the focused
 * shortcuts: {@link iff} (two-branch ternary) and {@link buckets}
 * (threshold ladder).
 *
 * @example
 * ```ts
 * const u = qAlias(User, "u");
 * const tier = Expressions.caseBuilder()
 *   .when(u.score.gte(90)).then("gold")
 *   .when(u.score.gte(70)).then("silver")
 *   .otherwise("bronze")
 *   .end();
 *
 * qb.select([tier.as("tier")]);
 * ```
 */
export class CaseBuilder {
  private readonly branches: CaseBranch[] = [];
  private elseValue: { present: true; value: unknown } | undefined;

  /** Start a new branch — takes a condition. Must be followed by `.then()`. */
  when(condition: ConditionLike): CaseWhenBuilder {
    if (this.elseValue) {
      throw new Error(
        "CaseBuilder: cannot add .when() after .otherwise() has been set.",
      );
    }
    if (!condition || (condition as { __isCondition?: unknown }).__isCondition !== true) {
      throw new Error(
        "CaseBuilder.when() expects a ConditionLike argument.",
      );
    }
    return new CaseWhenBuilder(this, condition);
  }

  /** @internal Append a completed branch. */
  _appendBranch(branch: CaseBranch): this {
    if (this.elseValue) {
      throw new Error(
        "CaseBuilder: cannot add .when() after .otherwise() has been set.",
      );
    }
    this.branches.push(branch);
    return this;
  }

  /** Attach the `ELSE default` branch. After this, only `.end()` is valid. */
  otherwise(value: unknown): CaseBuilder {
    if (this.elseValue) {
      throw new Error("CaseBuilder: .otherwise() already set.");
    }
    this.elseValue = { present: true, value };
    return this;
  }

  /** Finalize — produce a {@link ScalarExpression} ready for SELECT/WHERE/etc. */
  end(): ScalarExpression {
    if (this.branches.length === 0) {
      throw new Error(
        "CaseBuilder.end(): CASE expression needs at least one WHEN/THEN pair.",
      );
    }
    const branches = this.branches;
    const elseValue = this.elseValue;
    return new ScalarExpression((resolveColumn, dialect) => {
      const whenParts = branches.map((b) => {
        const cond = b.condition.resolve(resolveColumn, dialect);
        const result = renderResultValue(b.result, resolveColumn, dialect);
        return sql`WHEN ${cond} THEN ${result}`;
      });
      if (elseValue) {
        const def = renderResultValue(elseValue.value, resolveColumn, dialect);
        return sql`CASE ${join(whenParts, " ")} ELSE ${def} END`;
      }
      return sql`CASE ${join(whenParts, " ")} END`;
    });
  }
}

/**
 * @internal Intermediate builder state — the condition has been given,
 * awaiting its `.then(result)` call before the chain can continue.
 */
export class CaseWhenBuilder {
  constructor(
    private readonly parent: CaseBuilder,
    private readonly condition: ConditionLike,
  ) {}

  then(result: unknown): CaseBuilder {
    return this.parent._appendBranch({
      condition: this.condition,
      result,
    });
  }
}

/**
 * Fluent builder for a **simple** `CASE value WHEN v1 THEN r1 …` expression.
 *
 * Start via `Expressions.cases(valueExpr)`. Each `.when(value, result)`
 * adds a branch; `.otherwise(result)` sets the default; `.end()` finalizes.
 *
 * For static one-to-one mappings prefer the focused shortcut
 * {@link mapValues}, which accepts an object literal.
 *
 * @example
 * ```ts
 * const u = qAlias(User, "u");
 * const weight = Expressions.cases(u.status)
 *   .when("active", 1)
 *   .when("pending", 0)
 *   .otherwise(-1)
 *   .end();
 * ```
 */
export class CaseValueBuilder {
  private readonly branches: Array<{ value: unknown; result: unknown }> = [];
  private elseValue: { present: true; value: unknown } | undefined;

  constructor(private readonly subject: unknown) {}

  when(value: unknown, result: unknown): this {
    if (this.elseValue) {
      throw new Error(
        "CaseValueBuilder: cannot add .when() after .otherwise() has been set.",
      );
    }
    this.branches.push({ value, result });
    return this;
  }

  otherwise(result: unknown): this {
    if (this.elseValue) {
      throw new Error("CaseValueBuilder: .otherwise() already set.");
    }
    this.elseValue = { present: true, value: result };
    return this;
  }

  end(): ScalarExpression {
    if (this.branches.length === 0) {
      throw new Error(
        "CaseValueBuilder.end(): simple CASE needs at least one WHEN/THEN pair.",
      );
    }
    const subject = this.subject;
    const branches = this.branches;
    const elseValue = this.elseValue;
    return new ScalarExpression((resolveColumn, dialect) => {
      const subj = renderResultValue(subject, resolveColumn, dialect);
      const whenParts = branches.map((b) => {
        const val = renderResultValue(b.value, resolveColumn, dialect);
        const res = renderResultValue(b.result, resolveColumn, dialect);
        return sql`WHEN ${val} THEN ${res}`;
      });
      if (elseValue) {
        const def = renderResultValue(elseValue.value, resolveColumn, dialect);
        return sql`CASE ${subj} ${join(whenParts, " ")} ELSE ${def} END`;
      }
      return sql`CASE ${subj} ${join(whenParts, " ")} END`;
    });
  }
}

/** Factory for a searched-CASE builder. Entry point for `Expressions.caseBuilder()`. */
export function caseBuilder(): CaseBuilder {
  return new CaseBuilder();
}

/** Factory for a simple-CASE builder. Entry point for `Expressions.cases(subject)`. */
export function cases(subject: unknown): CaseValueBuilder {
  return new CaseValueBuilder(subject);
}

/**
 * Shortcut for the two-branch `CASE WHEN cond THEN a ELSE b END` shape —
 * the SQL equivalent of a ternary expression. Prefer this over
 * {@link caseBuilder} when exactly one condition picks between two results.
 *
 * Emits the same SQL as
 * `caseBuilder().when(cond).then(whenTrue).otherwise(whenFalse).end()`.
 *
 * @example
 * ```ts
 * const u = qAlias(User, "u");
 * Expressions.iff(u.deletedAt.isNull(), "active", "deleted")
 * // CASE WHEN "u"."deleted_at" IS NULL THEN ? ELSE ? END
 * ```
 */
export function iff(
  condition: ConditionLike,
  whenTrue: unknown,
  whenFalse: unknown,
): ScalarExpression {
  return new CaseBuilder()
    .when(condition)
    .then(whenTrue)
    .otherwise(whenFalse)
    .end();
}

/**
 * Shortcut for a simple `CASE subject WHEN v1 THEN r1 … ELSE default END`
 * built from an object literal. Prefer this over {@link cases} when the
 * mapping is a static, one-to-one relationship from known values to
 * constants (status → weight, role → tier, code → label).
 *
 * Object keys become the `WHEN` values bound as parameters; the common
 * case is string subjects (enums, status columns). If `mapping` is empty
 * the function throws.
 *
 * @example
 * ```ts
 * const u = qAlias(User, "u");
 * Expressions.mapValues(u.status, { active: 1, pending: 0 }, -1)
 * // CASE "u"."status" WHEN ? THEN ? WHEN ? THEN ? ELSE ? END
 * ```
 */
export function mapValues(
  subject: unknown,
  mapping: Record<string, unknown>,
  defaultResult?: unknown,
): ScalarExpression {
  const entries = Object.entries(mapping);
  if (entries.length === 0) {
    throw new Error(
      "Expressions.mapValues(): mapping must contain at least one entry.",
    );
  }
  const builder = new CaseValueBuilder(subject);
  for (const [value, result] of entries) {
    builder.when(value, result);
  }
  if (defaultResult !== undefined) {
    builder.otherwise(defaultResult);
  }
  return builder.end();
}

/** @internal Minimal interface threshold ladder expects from its subject. */
interface ComparableExpression {
  gt(value: unknown): ConditionLike;
  gte(value: unknown): ConditionLike;
  lt(value: unknown): ConditionLike;
  lte(value: unknown): ConditionLike;
}

export type BucketOperator = ">=" | ">" | "<=" | "<";

/**
 * Shortcut for a threshold ladder — a searched `CASE` where every
 * branch compares the same subject to a different threshold with the
 * same operator. Covers the score → tier, latency → bucket, age → cohort
 * shape without repeating the subject or operator per branch.
 *
 * Thresholds are ordered: each `[threshold, result]` tuple becomes one
 * `WHEN subject <op> threshold THEN result` branch. The caller is
 * responsible for ordering — descending for `>=`/`>`, ascending for
 * `<=`/`<` — since SQL evaluates branches top-down.
 *
 * @param op Comparison operator applied to every branch. Default `">="`.
 *
 * @example
 * ```ts
 * const u = qAlias(User, "u");
 * // score >= 90 → "gold", else score >= 70 → "silver", else "bronze"
 * Expressions.buckets(u.score, [
 *   [90, "gold"],
 *   [70, "silver"],
 * ], "bronze");
 *
 * // age < 18 → "child", else age < 65 → "adult", else "senior"
 * Expressions.buckets(u.age, [
 *   [18, "child"],
 *   [65, "adult"],
 * ], "senior", { op: "<" });
 * ```
 */
export function buckets(
  subject: ComparableExpression,
  thresholds: ReadonlyArray<readonly [unknown, unknown]>,
  defaultResult?: unknown,
  options?: { op?: BucketOperator },
): ScalarExpression {
  if (thresholds.length === 0) {
    throw new Error(
      "Expressions.buckets(): thresholds must contain at least one entry.",
    );
  }
  const op = options?.op ?? ">=";
  if (
    subject === null ||
    typeof subject !== "object" ||
    typeof (subject as Partial<ComparableExpression>).gte !== "function"
  ) {
    throw new Error(
      "Expressions.buckets(): subject must expose .gt/.gte/.lt/.lte " +
        "(ColumnExpression or ScalarExpression).",
    );
  }
  const builder = new CaseBuilder();
  for (const [threshold, result] of thresholds) {
    const cond =
      op === ">="
        ? subject.gte(threshold)
        : op === ">"
          ? subject.gt(threshold)
          : op === "<="
            ? subject.lte(threshold)
            : subject.lt(threshold);
    builder.when(cond).then(result);
  }
  if (defaultResult !== undefined) {
    builder.otherwise(defaultResult);
  }
  return builder.end();
}
