/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql, raw } from "sql-template-tag";
import { Conditions } from "../../Conditions";
import {
  isConditionLike,
  type ConditionLike,
} from "../../expressions/ConditionLike";
import type { DialectExpression } from "../../../dialects/DialectExpression";
import { OrmError } from "../../../errors/OrmError";
import { OrmErrorCode } from "../../../errors/OrmErrorCode";
import type { WhereOperator } from "../types";

/**
 * Lightweight builder for collecting WHERE conditions into an isolated group.
 *
 * Used by `andWhereGroup()` / `orWhereGroup()` to create parenthesized
 * condition groups: `(a = 1 AND b = 2) OR (c = 3 AND d = 4)`.
 *
 * @example
 * ```ts
 * qb.where("status", "active")
 *   .orWhereGroup(g => g
 *     .where("role", "admin")
 *     .where("verified", true)
 *   )
 * // WHERE "status" = 'active' OR ("role" = 'admin' AND "verified" = true)
 * ```
 */
export class WhereGroupBuilder<T> {
  private conditions: Sql[] = [];

  constructor(
    private readonly columnResolver: (ref: string) => string,
    private readonly wrapFn: (id: string) => string,
    /**
     * Dialect expression strategy, forwarded so group conditions that
     * contain JSON paths or case-insensitive LIKE get resolved correctly.
     * Optional because some call sites (legacy tests, unit fixtures)
     * construct groups without a live EntityManager.
     */
    private readonly dialectExpression?: DialectExpression,
  ) {}

  where(condition: Sql): this;
  where(condition: ConditionLike): this;
  where(column: keyof T & string, value: any): this;
  where(column: keyof T & string, operator: WhereOperator, value: any): this;
  where(column: string, value: any): this;
  where(column: string, operator: WhereOperator, value: any): this;
  where(
    columnOrCondition: string | Sql | ConditionLike,
    valueOrOperator?: any,
    value?: any,
  ): this {
    if (isConditionLike(columnOrCondition)) {
      this.conditions.push(
        columnOrCondition.resolve(
          (ref) => this.columnResolver(ref),
          this.dialectExpression,
        ),
      );
      return this;
    }
    if (typeof columnOrCondition === "object" && "sql" in columnOrCondition) {
      this.conditions.push(columnOrCondition as Sql);
      return this;
    }
    const col = this.columnResolver(columnOrCondition as string);
    if (value !== undefined) {
      const op = (valueOrOperator as string).trim().toUpperCase();
      if (op === "IS NULL") {
        this.conditions.push(Conditions.isNull(col));
      } else if (op === "IS NOT NULL") {
        this.conditions.push(Conditions.isNotNull(col));
      } else if (op === "IN") {
        this.conditions.push(Conditions.in(col, value as any[]));
      } else if (op === "NOT IN") {
        this.conditions.push(Conditions.notIn(col, value as any[]));
      } else if (op === "BETWEEN") {
        const [min, max] = value as [any, any];
        this.conditions.push(Conditions.between(col, min, max));
      } else if (op === "LIKE") {
        this.conditions.push(Conditions.like(col, value));
      } else if (op === "NOT LIKE") {
        this.conditions.push(Conditions.notLike(col, value));
      } else {
        this.conditions.push(sql`${raw(col)} ${raw(op)} ${value}`);
      }
    } else if (valueOrOperator === null) {
      // where(col, null) means IS NULL — `col = NULL` is always UNKNOWN.
      this.conditions.push(Conditions.isNull(col));
    } else if (Array.isArray(valueOrOperator)) {
      // where(col, [...]) is shorthand for an IN list, matching the top-level
      // builder's resolveCondition behavior.
      this.conditions.push(Conditions.in(col, valueOrOperator));
    } else {
      this.conditions.push(Conditions.equals(col, valueOrOperator));
    }
    return this;
  }

  whereIn(column: string, values: any[]): this {
    this.conditions.push(Conditions.in(this.columnResolver(column), values));
    return this;
  }

  whereNotIn(column: string, values: any[]): this {
    this.conditions.push(Conditions.notIn(this.columnResolver(column), values));
    return this;
  }

  whereNull(column: string): this {
    this.conditions.push(Conditions.isNull(this.columnResolver(column)));
    return this;
  }

  whereNotNull(column: string): this {
    this.conditions.push(Conditions.isNotNull(this.columnResolver(column)));
    return this;
  }

  whereBetween(column: string, min: any, max: any): this {
    this.conditions.push(Conditions.between(this.columnResolver(column), min, max));
    return this;
  }

  whereLike(column: string, pattern: string): this {
    this.conditions.push(Conditions.like(this.columnResolver(column), pattern));
    return this;
  }

  /** @internal Build the grouped condition wrapped in parentheses. */
  build(): Sql {
    if (this.conditions.length === 0) {
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        "WHERE group is empty. Add at least one condition inside the group.",
      );
    }
    if (this.conditions.length === 1) return this.conditions[0];
    return Conditions.and(this.conditions);
  }
}
