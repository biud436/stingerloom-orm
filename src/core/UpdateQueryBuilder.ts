/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql, raw, join } from "../utils/sqlTag";
import { ClazzType } from "../utils";
import { UpdateData } from "../dialects/FindOption";
import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";
import { Conditions } from "./Conditions";
import {
  isConditionLike,
  type ConditionLike,
  type ColumnResolver,
} from "./expressions/ConditionLike";
import {
  OrderExpression,
  isOrderExpression,
  type OrderDirection,
} from "./expressions/OrderExpression";
import type { DialectExpression } from "../dialects/DialectExpression";
import type { EntityManager } from "./EntityManager";

/**
 * Fluent builder for `UPDATE ... SET ... WHERE ... [ORDER BY ...] [LIMIT n]`.
 *
 * Created by `em.createUpdateBuilder(Entity, "alias")` or
 * `em.createUpdateBuilder(qAlias(Entity, "alias"))`. Mirrors the
 * `qAlias`-based predicate DSL used by `SelectQueryBuilder` so the same
 * `i.priority.eq(5)` / `i.status.in([...])` expressions work for UPDATE
 * filters.
 *
 * Dialect behavior matches `EntityManager.updateMany`:
 *
 * - MySQL/MariaDB — emits native `UPDATE … ORDER BY … LIMIT n`.
 * - PostgreSQL / SQLite — when `orderBy` or `limit` is set, rewrites to
 *   `UPDATE t SET … WHERE pk IN (SELECT pk FROM t WHERE … ORDER BY … LIMIT n)`.
 *   Composite-PK entities throw an `UNSUPPORTED_OPERATION` error on this path.
 *
 * @example
 * ```ts
 * const i = qAlias(Issue, "i");
 *
 * const result = await em.createUpdateBuilder(i)
 *   .set({ claimedBy: workerId, claimedAt: sql`NOW()` })
 *   .where(i.projectId.eq(projectId))
 *   .andWhere(i.status.in([BACKLOG, TODO]))
 *   .andWhere(i.assigneeId.isNull())
 *   .orderBy(i.priority.asc())
 *   .addOrderBy(i.number.asc())
 *   .limit(1)
 *   .execute();
 * ```
 */
export class UpdateQueryBuilder<T> {
  private setEntries: Sql[] = [];
  private conditions: Sql[] = [];
  private orderByExprs: Array<{ ref: string; direction: OrderDirection; isRaw: boolean }> = [];
  private limitValue: number | undefined;

  constructor(
    private readonly em: EntityManager,
    private readonly entity: ClazzType<T>,
    private readonly aliasName: string,
    private readonly propertyToColumnMap: Map<string, string>,
    private readonly dialectExpression?: DialectExpression,
  ) {}

  // ── SET ────────────────────────────────────────────────

  /**
   * Add columns to the SET clause from a typed data object.
   *
   * Each value can be a literal entity field value or a `Sql` expression
   * (for raw SQL like `sql\`NOW()\`` or `sql\`view_count + 1\``).
   *
   * Multiple `.set()` calls accumulate; the last write wins per column.
   */
  set(data: UpdateData<T>): this {
    for (const key in data) {
      const value = (data as any)[key];
      if (value === undefined) continue;
      const dbCol = this.propertyToColumnMap.get(key) ?? key;
      this.setEntries.push(sql`${raw(this.em.wrap(dbCol))} = ${value}`);
    }
    return this;
  }

  /**
   * Escape hatch: write a single column to a raw SQL expression. The column
   * name still goes through the property→column map; the value is whatever
   * `Sql` template you pass in.
   */
  setRaw(column: keyof T & string, expr: Sql): this {
    const dbCol = this.propertyToColumnMap.get(column) ?? column;
    this.setEntries.push(sql`${raw(this.em.wrap(dbCol))} = ${expr}`);
    return this;
  }

  // ── WHERE ──────────────────────────────────────────────

  /**
   * Set the first WHERE condition. Replaces any previously-set conditions.
   * Subsequent calls should use `.andWhere()` / `.orWhere()`.
   */
  where(condition: Sql | ConditionLike): this {
    this.conditions = [this.resolveCondition(condition)];
    return this;
  }

  /** AND another condition onto the WHERE clause. */
  andWhere(condition: Sql | ConditionLike): this {
    this.conditions.push(this.resolveCondition(condition));
    return this;
  }

  /**
   * OR another condition onto the WHERE clause.
   * Parenthesizes the prior conditions to preserve precedence:
   * `WHERE (prev_a AND prev_b) OR new`.
   */
  orWhere(condition: Sql | ConditionLike): this {
    if (this.conditions.length === 0) {
      this.conditions.push(this.resolveCondition(condition));
      return this;
    }
    const prior =
      this.conditions.length === 1
        ? this.conditions[0]
        : Conditions.and(this.conditions);
    const next = this.resolveCondition(condition);
    this.conditions = [Conditions.or([prior, next])];
    return this;
  }

  // ── ORDER BY ───────────────────────────────────────────

  /**
   * Set the first ORDER BY expression. Replaces any previously-set order.
   *
   * Accepts:
   * - An `OrderExpression` (e.g. `i.priority.asc()`)
   * - A property key with optional direction (e.g. `"priority"`, `"DESC"`)
   */
  orderBy(spec: OrderExpression): this;
  orderBy(column: keyof T & string, direction?: OrderDirection): this;
  orderBy(
    specOrColumn: OrderExpression | (keyof T & string),
    direction: OrderDirection = "ASC",
  ): this {
    this.orderByExprs = [];
    return this.addOrderBy(specOrColumn as any, direction);
  }

  /** Append another ORDER BY expression. */
  addOrderBy(spec: OrderExpression): this;
  addOrderBy(column: keyof T & string, direction?: OrderDirection): this;
  addOrderBy(
    specOrColumn: OrderExpression | (keyof T & string),
    direction: OrderDirection = "ASC",
  ): this {
    if (isOrderExpression(specOrColumn)) {
      this.orderByExprs.push({
        ref: specOrColumn.ref,
        direction: specOrColumn.direction,
        isRaw: specOrColumn.isRaw,
      });
    } else {
      this.orderByExprs.push({
        ref: specOrColumn as string,
        direction: this.normalizeDirection(direction),
        isRaw: false,
      });
    }
    return this;
  }

  // ── LIMIT ──────────────────────────────────────────────

  /** Cap the number of rows updated. Required to be a non-negative integer. */
  limit(n: number): this {
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        `UpdateQueryBuilder.limit must be a non-negative integer, got ${String(n)}`,
      );
    }
    this.limitValue = n;
    return this;
  }

  // ── Execution ──────────────────────────────────────────

  /**
   * Execute the UPDATE statement and return the affected row count.
   *
   * Runs inside the EntityManager's transaction wrapper; tenant scoping
   * and `@UpdateTimestamp` injection are applied identically to
   * `EntityManager.updateMany`.
   */
  async execute(): Promise<{ affected: number }> {
    if (this.setEntries.length === 0) {
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        "UpdateQueryBuilder.execute(): no SET columns provided. Call .set() at least once before .execute().",
      );
    }
    const orderBySql = this.buildOrderBySql();
    return (this.em as any).executeBuilderUpdate(
      this.entity,
      this.setEntries,
      this.conditions,
      orderBySql,
      this.limitValue,
    );
  }

  /**
   * Build the SQL without executing — useful for tests and inspection.
   * Tenant scoping is **not** applied here (it's added at execute time).
   */
  build(): Sql {
    if (this.setEntries.length === 0) {
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        "UpdateQueryBuilder.build(): no SET columns provided.",
      );
    }
    return (this.em as any).buildBuilderUpdateSql(
      this.entity,
      this.setEntries,
      this.conditions,
      this.buildOrderBySql(),
      this.limitValue,
    );
  }

  /** Convenience accessor returning the SQL text and bound values. */
  toSql(): { text: string; values: unknown[] } {
    const built = this.build();
    return { text: built.text, values: built.values };
  }

  // ── internals ──────────────────────────────────────────

  private resolveCondition(condition: Sql | ConditionLike): Sql {
    if (isConditionLike(condition)) {
      return condition.resolve(this.columnResolver, this.dialectExpression);
    }
    return condition;
  }

  private columnResolver: ColumnResolver = (ref: string) => {
    const dot = ref.lastIndexOf(".");
    const prop = dot >= 0 ? ref.substring(dot + 1) : ref;
    const dbCol = this.propertyToColumnMap.get(prop) ?? prop;
    return this.em.wrap(dbCol);
  };

  private normalizeDirection(dir: string | undefined): OrderDirection {
    return typeof dir === "string" && dir.toUpperCase() === "DESC"
      ? "DESC"
      : "ASC";
  }

  private buildOrderBySql(): Sql | undefined {
    if (this.orderByExprs.length === 0) return undefined;
    const items: Sql[] = [];
    for (const { ref, direction, isRaw } of this.orderByExprs) {
      const col = isRaw ? ref : this.columnResolver(ref);
      items.push(sql`${raw(col)} ${raw(direction)}`);
    }
    return sql`ORDER BY ${join(items, ", ")}`;
  }
}
