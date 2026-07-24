/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql, raw } from "../../../utils/sqlTag";
import { Conditions } from "../../Conditions";
import { OrmError } from "../../../errors/OrmError";
import { OrmErrorCode } from "../../../errors/OrmErrorCode";

/**
 * Fluent builder for JOIN ON conditions.
 *
 * Used with entity-aware joins to build type-safe ON clauses
 * using entity property names instead of raw column names.
 *
 * @example
 * ```ts
 * qb.leftJoin(User, "u", (join) =>
 *   join.on("p.userId", "=", "u.id")
 * )
 * ```
 */
export class JoinOnBuilder {
  private conditions: Sql[] = [];

  constructor(
    private readonly columnResolver: (ref: string) => string,
  ) {}

  /**
   * Add an ON condition comparing two column references.
   * Both sides are resolved through the alias registry.
   *
   * @example join.on("p.userId", "=", "u.id")
   */
  on(leftRef: string, operator: string, rightRef: string): this {
    const left = this.columnResolver(leftRef);
    const right = this.columnResolver(rightRef);
    this.conditions.push(Conditions.compareColumns(left, operator, right));
    return this;
  }

  /**
   * Alias for `on()` — add additional ON condition with AND semantics.
   */
  andOn(leftRef: string, operator: string, rightRef: string): this {
    return this.on(leftRef, operator, rightRef);
  }

  /**
   * Add an ON condition comparing a column to a literal value.
   *
   * @example join.onVal("p.status", "=", "published")
   */
  onVal(ref: string, operator: string, value: any): this {
    const col = this.columnResolver(ref);
    const op = operator.trim().toUpperCase();
    this.conditions.push(sql`${raw(col)} ${raw(op)} ${value}`);
    return this;
  }

  /**
   * Add an ON condition asserting `ref BETWEEN lowRef AND highRef`, where
   * all three arguments are column references. This is the dominant join
   * shape for range-containment self-joins (nested sets, interval trees):
   *
   * @example
   * ```ts
   * // SELECT ... FROM category node JOIN category parent
   * //   ON node.lft BETWEEN parent.lft AND parent.rgt
   * qb.innerJoin(Category, "parent", (j) =>
   *   j.onBetween("node.lft", "parent.lft", "parent.rgt"),
   * )
   * ```
   */
  onBetween(ref: string, lowRef: string, highRef: string): this {
    const col = this.columnResolver(ref);
    const low = this.columnResolver(lowRef);
    const high = this.columnResolver(highRef);
    this.conditions.push(
      sql`${raw(col)} BETWEEN ${raw(low)} AND ${raw(high)}`,
    );
    return this;
  }

  /**
   * Alias for `onBetween()` — additional range condition with AND semantics.
   */
  andOnBetween(ref: string, lowRef: string, highRef: string): this {
    return this.onBetween(ref, lowRef, highRef);
  }

  /**
   * Literal-value variant of {@link onBetween}: `ref BETWEEN low AND high`
   * with `low`/`high` bound as parameters.
   *
   * @example join.onValBetween("node.lft", 1, 42)
   */
  onValBetween(ref: string, low: any, high: any): this {
    const col = this.columnResolver(ref);
    this.conditions.push(sql`${raw(col)} BETWEEN ${low} AND ${high}`);
    return this;
  }

  /**
   * Add an ON condition asserting `ref IS NULL`. The reference is resolved
   * through the alias registry, just like {@link on}.
   *
   * @example join.on("p.userId", "=", "u.id").onNull("u.deletedAt")
   */
  onNull(ref: string): this {
    const col = this.columnResolver(ref);
    this.conditions.push(Conditions.isNull(col));
    return this;
  }

  /**
   * Add an ON condition asserting `ref IS NOT NULL`.
   *
   * @example join.on("p.userId", "=", "u.id").onNotNull("u.verifiedAt")
   */
  onNotNull(ref: string): this {
    const col = this.columnResolver(ref);
    this.conditions.push(Conditions.isNotNull(col));
    return this;
  }

  /**
   * Add an ON condition asserting `ref IN (...)`. The `values` are USER
   * VALUES and are bound as parameters (never concatenated into SQL); the
   * bound params flow through {@link build} into the assembled JOIN SQL via
   * the same `Sql` channel used by {@link onVal}.
   *
   * An empty `values` array emits a matches-nothing predicate (`1 = 0`)
   * rather than the syntactically invalid `IN ()`, mirroring how the WHERE
   * builder handles empty `in` arrays.
   *
   * @example join.on("p.userId", "=", "u.id").onIn("u.role", ["admin", "editor"])
   */
  onIn(ref: string, values: unknown[]): this {
    const col = this.columnResolver(ref);
    if (values.length === 0) {
      this.conditions.push(sql`1 = 0`);
      return this;
    }
    this.conditions.push(Conditions.in(col, values as any[]));
    return this;
  }

  /** @internal Build the combined ON condition. */
  build(): Sql {
    if (this.conditions.length === 0) {
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        "JOIN ON condition is empty. Use .on() to specify at least one condition.",
      );
    }
    if (this.conditions.length === 1) return this.conditions[0];
    return Conditions.and(this.conditions);
  }
}
