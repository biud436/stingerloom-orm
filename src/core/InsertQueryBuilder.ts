/* eslint-disable @typescript-eslint/no-explicit-any */
import { Sql, isSqlFragment } from "../utils/sqlTag";
import { ClazzType } from "../utils";
import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";
import {
  isConditionLike,
  type ConditionLike,
  type ColumnResolver,
} from "./expressions/ConditionLike";
import type { DialectExpression } from "../dialects/DialectExpression";
import type { EntityManager } from "./EntityManager";
import { qAlias, type QEntity } from "./query-builder/alias/qAlias";
import {
  qExcluded,
  splitColumnRef,
} from "./query-builder/alias/qExcluded";
import { renderNullishArg } from "./expressions/NullishExpression";
import { isScalarExpression } from "./expressions/ScalarExpression";
import { isAggregateExpression } from "./expressions/AggregateExpression";
import { isJsonPathExpression } from "./expressions/JsonPathExpression";

/**
 * One row handed to {@link InsertQueryBuilder.values}. Every entity property
 * is optional and may hold either its declared value or a raw `Sql` fragment
 * (e.g. ``sql`NOW()` ``) that is spliced into the VALUES tuple untouched.
 */
export type InsertValues<T> = {
  [K in keyof T]?: T[K] | Sql;
};

/**
 * A value assignable in the `DO UPDATE SET` clause.
 *
 * Beyond literals and raw `Sql`, this accepts the whole QueryDSL expression
 * vocabulary — column references from `qAlias` / `qExcluded`, scalar
 * expressions built from them (`.add()`, `greatest()`, `coalesce()` …),
 * aggregates and JSON path extractions.
 */
export type ConflictSetValue<V> = V | Sql | object;

/**
 * The `DO UPDATE SET` assignment map: entity properties to the values or
 * expressions they take when a row conflicts.
 */
export type ConflictSet<T> = {
  [K in keyof T]?: ConflictSetValue<T[K]>;
};

/**
 * Callback form of {@link InsertQueryBuilder.doUpdate}. Receives a reference
 * to the row already stored (`target`) and to the row the INSERT proposed
 * (`excluded`), so the SET expressions can combine both.
 *
 * @example
 * ```ts
 * .doUpdate((t, ex) => ({ records: t.records.add(ex.records) }))
 * ```
 */
export type ConflictSetFactory<T> = (
  target: QEntity<T>,
  excluded: QEntity<T>,
) => ConflictSet<T>;

/**
 * @internal One resolved `DO UPDATE SET` assignment. Expression-valued
 * entries arrive already rendered; literal entries stay unrendered so the
 * write path can apply the column's write transformer before binding them.
 */
export type ResolvedSetEntry =
  | { kind: "expression"; property: string; value: Sql }
  | { kind: "literal"; property: string; value: unknown };

/** @internal The conflict target an INSERT statement declares. */
export interface ConflictTarget {
  /** Entity property names. Empty when a constraint name is used instead. */
  properties: string[];
  /** PostgreSQL `ON CONFLICT ON CONSTRAINT <name>`. */
  constraintName?: string;
  /** PostgreSQL partial-unique-index predicate: `ON CONFLICT (…) WHERE …`. */
  indexPredicate?: Sql;
}

/** @internal What an INSERT does when a row conflicts. */
export type ConflictAction =
  | { kind: "none" }
  | { kind: "nothing" }
  | { kind: "update"; set: ResolvedSetEntry[]; where?: Sql };

/** @internal Everything {@link InsertQueryBuilder} hands to the write path. */
export interface InsertBuilderSpec<T> {
  items: InsertValues<T>[];
  target?: ConflictTarget;
  action: ConflictAction;
}

/** Options for {@link InsertQueryBuilder.onConflict}. */
export interface OnConflictOptions {
  /**
   * Index predicate for a **partial** unique index — emitted as
   * `ON CONFLICT (cols) WHERE <predicate>`. PostgreSQL only; SQLite accepts
   * the syntax for partial indexes too, MySQL has no conflict target at all.
   *
   * This narrows which *index* arbitrates the conflict. To filter which
   * conflicting rows get updated, use {@link InsertQueryBuilder.doUpdateWhere}.
   */
  where?: Sql | ConditionLike;
}

/**
 * Fluent builder for `INSERT … VALUES … ON CONFLICT …`, with the full
 * QueryDSL expression vocabulary available in the conflict action.
 *
 * Created by `em.createInsertBuilder(Entity)` or
 * `em.createInsertBuilder(qAlias(Entity, "alias"))`. It is the expression-
 * capable counterpart to `em.upsert()` / `em.batchUpsert()`, which can only
 * overwrite a conflicting row with the proposed values.
 *
 * The reason to reach for it is a conflict action that has to *read* the
 * stored row — an accumulating counter, a high-water mark, a merge — which
 * cannot be expressed as `col = EXCLUDED.col` and which a read-then-write
 * round trip cannot do safely without row locks:
 *
 * @example Accumulate counters and keep the later timestamp
 * ```ts
 * await em.createInsertBuilder(SyncMarker)
 *   .values(rows)
 *   .onConflict(["mac", "bucketStart"])
 *   .doUpdate((t, ex) => ({
 *     records:  t.records.add(ex.records),
 *     lastTime: greatest(t.lastTime, ex.lastTime),
 *     syncedAt: sql`NOW()`,
 *   }))
 *   .execute();
 * ```
 *
 * Dialect behavior:
 *
 * - **PostgreSQL** — `ON CONFLICT (cols) DO UPDATE SET … WHERE …`, plus
 *   `ON CONSTRAINT` and partial-index predicates.
 * - **SQLite** — same, minus `ON CONSTRAINT`.
 * - **MySQL / MariaDB** — `ON DUPLICATE KEY UPDATE …`. The engine has no
 *   conflict target, so `.onConflict()` columns are accepted (they keep the
 *   call portable) but not emitted; `.doNothing()` becomes `INSERT IGNORE`.
 *   `.onConflictConstraint()`, `.onConflict(…, { where })` and
 *   `.doUpdateWhere()` have no MySQL equivalent and throw.
 *
 * Like `createUpdateBuilder()`, this is a **statement-level** API: it does
 * not emit `beforeInsert` / `afterInsert` events or run entity hooks. Tenant
 * columns, `@CreateTimestamp` / `@UpdateTimestamp` / `@Version` defaults and
 * column transformers on the inserted values are applied exactly as in
 * `insertMany()`.
 */
export class InsertQueryBuilder<T> {
  private rows: InsertValues<T>[] = [];
  private conflictTarget: ConflictTarget | undefined;
  private action: ConflictAction = { kind: "none" };

  constructor(
    private readonly em: EntityManager,
    private readonly entity: ClazzType<T>,
    private readonly aliasName: string,
    private readonly propertyToColumnMap: Map<string, string>,
    private readonly dialectExpression?: DialectExpression,
  ) {}

  // ── VALUES ─────────────────────────────────────────────

  /**
   * Add one row or several to the VALUES list. Multiple calls accumulate,
   * so rows can be appended in a loop.
   *
   * Each cell takes either the property's declared value or a raw `Sql`
   * fragment. Values go through the column's write transformer; `Sql`
   * fragments are spliced verbatim.
   */
  values(data: InsertValues<T> | InsertValues<T>[]): this {
    if (Array.isArray(data)) {
      this.rows.push(...data);
    } else {
      this.rows.push(data);
    }
    return this;
  }

  // ── Conflict target ────────────────────────────────────

  /**
   * Declare which columns arbitrate the conflict. Accepts entity property
   * names or `qAlias` column references; both resolve through the naming
   * strategy.
   *
   * Defaults to the primary key when omitted.
   */
  onConflict(
    columns: Array<(keyof T & string) | { toString(): string }>,
    options?: OnConflictOptions,
  ): this {
    const properties = columns.map((c) =>
      typeof c === "string" ? c : splitColumnRef(String(c)).property,
    );
    if (properties.length === 0) {
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        "InsertQueryBuilder.onConflict() requires at least one column. Omit the call entirely to arbitrate on the primary key.",
      );
    }
    this.conflictTarget = {
      properties,
      indexPredicate: options?.where
        ? this.resolveCondition(options.where)
        : undefined,
    };
    return this;
  }

  /**
   * Arbitrate the conflict by unique-constraint name —
   * `ON CONFLICT ON CONSTRAINT <name>`. **PostgreSQL only**; the name is
   * emitted as a quoted identifier.
   *
   * Prefer {@link onConflict} unless the constraint is one the column list
   * cannot name (e.g. an exclusion constraint).
   */
  onConflictConstraint(name: string): this {
    if (!name || !name.trim()) {
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        "InsertQueryBuilder.onConflictConstraint() requires a constraint name.",
      );
    }
    this.conflictTarget = { properties: [], constraintName: name };
    return this;
  }

  // ── Conflict action ────────────────────────────────────

  /** Skip conflicting rows: `DO NOTHING` (PG/SQLite) / `INSERT IGNORE` (MySQL). */
  doNothing(): this {
    this.action = { kind: "nothing" };
    return this;
  }

  /**
   * Overwrite the listed columns with the proposed values — the same
   * `col = EXCLUDED.col` form `em.upsert()` produces.
   */
  doUpdate(columns: Array<keyof T & string>): this;
  /**
   * Assign literal values or raw `Sql` to the listed columns on conflict.
   */
  doUpdate(set: ConflictSet<T>): this;
  /**
   * Build the assignments from the stored row and the proposed row — the
   * expression form.
   *
   * @param factory receives `(target, excluded)`; `target` reads the row
   *        already in the table, `excluded` the row this INSERT proposed.
   */
  doUpdate(factory: ConflictSetFactory<T>): this;
  doUpdate(
    spec: Array<keyof T & string> | ConflictSet<T> | ConflictSetFactory<T>,
  ): this {
    const set = Array.isArray(spec)
      ? this.setFromColumnList(spec)
      : typeof spec === "function"
        ? this.resolveSet(
            spec(
              qAlias(this.entity, this.aliasName),
              qExcluded(this.entity),
            ),
          )
        : this.resolveSet(spec);

    if (set.length === 0) {
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        "InsertQueryBuilder.doUpdate() produced no assignments. Pass at least one column, or call .doNothing() to skip conflicting rows.",
      );
    }
    const existingWhere =
      this.action.kind === "update" ? this.action.where : undefined;
    this.action = { kind: "update", set, where: existingWhere };
    return this;
  }

  /**
   * Restrict which conflicting rows the update touches —
   * `DO UPDATE SET … WHERE <condition>`. Rows that fail the condition are
   * left untouched (and not counted as inserted).
   *
   * PostgreSQL and SQLite only — MySQL's `ON DUPLICATE KEY UPDATE` takes no
   * WHERE clause. Express the same intent there with a `CASE` in the SET
   * value, or by making the assignment idempotent.
   *
   * Unqualified column references read the stored row; use the `excluded`
   * reference for the proposed one.
   */
  doUpdateWhere(condition: Sql | ConditionLike): this {
    if (this.action.kind !== "update") {
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        "InsertQueryBuilder.doUpdateWhere() must follow .doUpdate() — there is no update to filter.",
      );
    }
    this.action = {
      ...this.action,
      where: this.resolveCondition(condition),
    };
    return this;
  }

  // ── Execution ──────────────────────────────────────────

  /**
   * Execute the INSERT and return the affected row count.
   *
   * Runs inside the EntityManager's transaction wrapper, with tenant
   * scoping, timestamp/version defaults and column transformers applied
   * exactly as `insertMany()` applies them.
   *
   * Note that "affected" is engine-specific for an upsert: MySQL reports 2
   * for a row it updated and 1 for a row it inserted, while PostgreSQL and
   * SQLite report 1 per row written and 0 for one skipped.
   */
  async execute(): Promise<{ affected: number }> {
    return (this.em as any).executeBuilderInsert(this.entity, this.spec());
  }

  /**
   * Build the SQL without executing — useful for tests and inspection.
   * Tenant scoping is **not** applied here (it is added at execute time).
   */
  build(): Sql {
    return (this.em as any).buildBuilderInsertSql(this.entity, this.spec());
  }

  /** Convenience accessor returning the SQL text and bound values. */
  toSql(): { text: string; values: unknown[] } {
    const built = this.build();
    return { text: built.text, values: built.values };
  }

  // ── internals ──────────────────────────────────────────

  /** @internal The immutable snapshot the write path consumes. */
  private spec(): InsertBuilderSpec<T> {
    if (this.rows.length === 0) {
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        "InsertQueryBuilder: no rows to insert. Call .values() at least once.",
      );
    }
    return {
      items: this.rows,
      target: this.conflictTarget,
      action: this.action,
    };
  }

  /** `col = EXCLUDED.col` for each named column. */
  private setFromColumnList(
    columns: Array<keyof T & string>,
  ): ResolvedSetEntry[] {
    const excluded = qExcluded(this.entity) as any;
    return columns.map((property) => ({
      kind: "expression" as const,
      property,
      value: renderNullishArg(
        excluded[property],
        this.columnResolver,
        this.dialectExpression,
      ),
    }));
  }

  /**
   * Split an assignment map into pre-rendered expressions and literals.
   *
   * Literals stay unrendered on purpose: the write path knows each column's
   * metadata and applies its write transformer before binding, which the
   * builder cannot do.
   */
  private resolveSet(set: ConflictSet<T>): ResolvedSetEntry[] {
    const entries: ResolvedSetEntry[] = [];
    for (const property of Object.keys(set) as Array<keyof T & string>) {
      const value = set[property];
      if (value === undefined) continue;
      if (this.isExpressionValue(value)) {
        entries.push({
          kind: "expression",
          property,
          value: renderNullishArg(
            value,
            this.columnResolver,
            this.dialectExpression,
          ),
        });
        continue;
      }
      entries.push({ kind: "literal", property, value });
    }
    return entries;
  }

  /**
   * Whether a SET value is an expression to render rather than a value to
   * bind. `Sql` fragments count — they are spliced as written.
   */
  private isExpressionValue(value: unknown): boolean {
    if (value === null || typeof value !== "object") return false;
    if (isSqlFragment(value)) return true;
    const marked = value as { __isColumnExpression?: unknown };
    return (
      marked.__isColumnExpression === true ||
      isScalarExpression(value) ||
      isAggregateExpression(value) ||
      isJsonPathExpression(value)
    );
  }

  private resolveCondition(condition: Sql | ConditionLike): Sql {
    if (isConditionLike(condition)) {
      return condition.resolve(this.columnResolver, this.dialectExpression);
    }
    return condition;
  }

  /**
   * Resolves a deferred column reference for the conflict clause.
   *
   * References carrying the `qExcluded` sentinel alias render as the
   * dialect's proposed-row syntax; everything else renders as a **bare**
   * column name, which every dialect reads as the stored row inside
   * `DO UPDATE SET` / `ON DUPLICATE KEY UPDATE`. Qualifying it would be
   * wrong on MySQL and fragile on a schema-qualified PostgreSQL target.
   */
  private columnResolver: ColumnResolver = (ref: string) => {
    const { property, isExcluded } = splitColumnRef(ref);
    const dbCol = this.propertyToColumnMap.get(property) ?? property;
    const wrapped = this.em.wrap(dbCol);
    return isExcluded
      ? (this.em as any).renderExcludedColumn(wrapped)
      : wrapped;
  };
}
