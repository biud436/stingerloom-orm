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
