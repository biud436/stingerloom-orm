/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql, raw, join, type RawValue } from "../utils/sqlTag";
import { Conditions } from "./Conditions";
import { resolveWhereClause, type WhereResolverOptions } from "./WhereResolver";
import type { WhereClause } from "../dialects/FindOption";
import { EntityManager } from "./EntityManager";
import { ClazzType } from "../utils/types";
import { RawQueryBuilder } from "./RawQueryBuilder";
import { RawQueryBuilderFactory } from "./RawQueryBuilderFactory";
import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";
import { EntityNotFoundError } from "../errors/EntityNotFoundError";
import { DeserializerRegistry } from "./deserializer/DeserializerRegistry";
import { ResultTransformerFactory } from "./ResultTransformerFactory";
import { CompiledQuery } from "./CompiledQuery";
import type { QueryCachePolicy } from "./cache/QueryResultCache";
import {
  normalizePage,
  normalizePageSize,
  type PagePaginationResult,
} from "./PagePagination";
import {
  encodeCursor,
  decodeCursor,
  type CursorPaginationOption,
  type CursorPaginationResult,
} from "./CursorPagination";
import { coerceRows, type RawResultOptions } from "./RawValueCoercion";
import { COLUMN_TOKEN } from "../decorators/Column";
import { buildPropertyToColumnMap as buildSharedPropertyToColumnMap } from "./PropertyColumnMap";
import { InheritanceResolver } from "./InheritanceResolver";
import {
  JsonPathCondition,
  makeJsonPathExpression,
  type JsonPathExpression,
} from "./expressions/JsonPathExpression";
import {
  isConditionLike,
  type ConditionLike,
  type ColumnResolver,
} from "./expressions/ConditionLike";
import { OrderExpression, isOrderExpression } from "./expressions/OrderExpression";
import {
  AggregateExpression,
  AggregateCondition,
  isAggregateExpression,
  isAggregateCondition,
} from "./expressions/AggregateExpression";
import {
  LogicalCondition,
  isLogicalCondition,
} from "./expressions/LogicalCondition";
import { escapeLikeValue } from "./expressions/likeEscape";
import {
  resolveRegex,
  inlineFlagPrefix,
  type RegexInput,
} from "./expressions/RegexPattern";
import {
  AliasedExpression,
  isAliasedExpression,
} from "./expressions/AliasedExpression";
import { ScalarExpression, isScalarExpression } from "./expressions/ScalarExpression";
import {
  getExpressionContext,
  type SelectExpressionContext,
} from "./expressions/ComputedColumnExpression";
import { coalesce as coalesceFn } from "./expressions/NullishExpression";
import { buildCastScalar } from "./expressions/CastExpression";
import { buildDateComponentFromRef } from "./expressions/DateComponentExpression";
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
} from "./expressions/StringExpression";
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
} from "./expressions/NumericExpression";
import { buildDateAdd } from "./expressions/DateArithmeticExpression";
import { Logger } from "../utils/Logger";
import { ExplainResult } from "./ExplainResult";
import { ExplainQueryHandler } from "./ExplainQueryHandler";
import { InvalidQueryError } from "../errors/InvalidQueryError";
import type {
  ArrayOperator,
  CastKind,
  DateAddUnit,
  DateComponent,
  FullTextSearchOptions,
} from "../dialects/DialectExpression";
import type { InheritanceStrategy } from "../decorators/Inheritance";
import type { ColumnMetadata } from "../scanner/ColumnScanner";
import type { DialectExpression } from "../dialects/DialectExpression";
import type { RelationMetadataResolver } from "./RelationMetadataResolver";
import type { EntityManagerInternals } from "./EntityManagerInternals";
import type { EntityScannerMetadata } from "../scanner";
import { JoinOnBuilder } from "./query-builder/join/JoinOnBuilder";
import {
  alias,
  isEntityRef,
  type EntityRef,
} from "./query-builder/alias/EntityRef";
import { ColumnCondition } from "./query-builder/condition/ColumnCondition";
import { ColumnExpression } from "./query-builder/expression/ColumnExpression";
import {
  qAlias,
  __clearQAliasCache,
  type QEntity,
  type QEntityDynamicAccess,
} from "./query-builder/alias/qAlias";
import { WhereGroupBuilder } from "./query-builder/where-group/WhereGroupBuilder";
import type {
  RowValidator,
  ArrayValidator,
  WhereOperator,
} from "./query-builder/types";

/**
 * Entry in the alias registry: maps a table alias to its entity metadata.
 */
interface AliasEntry {
  entity: ClazzType<any>;
  tableName: string;
  propertyToColumnMap: Map<string, string>;
}

export { JoinOnBuilder };

/**
 * #372: resolver handed to correlated-subquery factories. Maps an outer
 * `"alias.property"` reference to its escaped identifier as a `Sql`
 * fragment (e.g. `outer("node.lft")` → `` `node`.`LFT_NO` ``), so a
 * subquery can reference the outer row through the typed surface.
 */
export type OuterRefResolver = (ref: string) => Sql;

/**
 * A subquery argument: either a pre-built builder, or a factory receiving
 * an {@link OuterRefResolver} for correlated subqueries (#372).
 */
export type SubqueryInput =
  | SelectQueryBuilder<any, any>
  | ((outer: OuterRefResolver) => SelectQueryBuilder<any, any>);

export { alias, isEntityRef, type EntityRef };

// ── QueryDSL-style expressions ────────────────────────────

export { ColumnCondition };

export { ColumnExpression };

export { qAlias, __clearQAliasCache };
export type { QEntity, QEntityDynamicAccess };

export { WhereGroupBuilder };
export type { RowValidator, ArrayValidator, WhereOperator };

/**
 * Narrow, typed view of the `EntityManager` internals this builder reads.
 *
 * `EntityManager` keeps `resolver` and `_ctx` private on its public type, so
 * the builder narrows through {@link SelectQueryBuilder.emInternals} — a
 * single sanctioned cast — instead of scattering `as any` at every access
 * site. Members mirror the real EntityManager, which always carries them;
 * the runtime guards at the call sites stay in place because query-builder
 * unit tests construct partial EM doubles that may omit any of these.
 */
interface EntityManagerInternalView {
  readonly resolver: RelationMetadataResolver;
  readonly _ctx: EntityManagerInternals;
  emitAfterLoad(
    entityClass: ClazzType<unknown>,
    entities: unknown,
  ): Promise<void>;
}

/**
 * Type-safe column reference: entity property keys (string keys only).
 */
type ColumnOf<T> = keyof T & string;


/**
 * Type-safe order-by specification.
 */
type OrderBySpec<T> = {
  [K in ColumnOf<T>]?: "ASC" | "DESC";
};


/**
 * A type-safe, fluent query builder derived from a repository entity type.
 *
 * Created via `repository.createQueryBuilder("alias")` or
 * `em.createQueryBuilder(Entity, "alias")`.
 *
 * **Type-safe projections:** When you call `select(["id", "name"])`, the
 * return type of `getMany()` narrows from `T[]` to `Pick<T, "id" | "name">[]`.
 * Accessing unselected columns becomes a compile-time error.
 *
 * @template T       The full entity type — used for column references in where/orderBy.
 * @template TResult The projected result type — defaults to `T` (all columns).
 *                   Changes when `select()` is called with specific columns.
 *
 * @example
 * ```ts
 * const users = await repo
 *   .createQueryBuilder("u")
 *   .select(["id", "name"])      // TResult = Pick<User, "id" | "name">
 *   .where("status", "active")   // still references full User columns
 *   .getMany();                  // Promise<Pick<User, "id" | "name">[]>
 *
 * users[0].id;    // ✓ OK
 * users[0].name;  // ✓ OK
 * users[0].email; // ✗ Compile error — "email" not in Pick<User, "id" | "name">
 * ```
 */
export class SelectQueryBuilder<T, TResult = T> {
  protected readonly alias: string;
  protected readonly entity: ClazzType<T>;
  protected readonly em: EntityManager;

  /**
   * Single narrowing point for the EntityManager internals (see
   * {@link EntityManagerInternalView}). Read live on every access — never
   * cached — so test-time reassignment of `em.resolver` etc. is honored.
   */
  private get emInternals(): EntityManagerInternalView {
    return this.em as unknown as EntityManagerInternalView;
  }

  protected selectColumns: string[] | "*" = "*";
  protected distinct = false;
  protected whereClauses: Sql[] = [];
  /**
   * ORDER BY entries. `column` is a string when the source was a
   * resolved column reference / pre-rendered identifier; it's a
   * parameterized {@link Sql} when the source was a
   * {@link ScalarExpression} carrying bound parameters (e.g.
   * `Expressions.dateTrunc(col, "week")`).
   */
  protected orderByClauses: Array<{
    column: string | Sql;
    direction: "ASC" | "DESC";
    /** Optional NULLS FIRST/LAST position (Postgres/SQLite native; emulated on MySQL). */
    nulls?: "FIRST" | "LAST";
    /** When true, `column` is a pre-rendered SQL fragment — bypass resolver. */
    isRaw?: boolean;
  }> = [];
  /**
   * GROUP BY entries. Stored as parameterized {@link Sql} so derived
   * expressions (e.g. `Expressions.dateTrunc(col, "week")`) keep their
   * bindings instead of being inlined as strings.
   */
  protected groupByCols: Sql[] = [];
  protected havingClauses: Sql[] = [];
  protected joinClauses: Array<{
    type: "LEFT" | "INNER" | "RIGHT";
    table: string;
    alias: string;
    condition: Sql;
    /**
     * Entity behind the joined table when known (entity-aware / relation
     * joins). Lets the render step scope the JOIN by tenant at execution
     * time. String-based joins stay undefined and unscoped by design.
     */
    joinedEntity?: ClazzType<any>;
  }> = [];
  protected limitValue: number | [number, number] | undefined;
  protected offsetValue: number | undefined;
  protected lockClause: string | undefined;
  /** Per-builder query result cache request (see {@link cache}). */
  protected cacheOption:
    | boolean
    | number
    | { ttl?: number; tag?: string }
    | undefined;
  protected withDeletedFlag = false;
  protected withoutTenantScopeFlag = false;
  protected extraSegments: Sql[] = [];
  protected rowValidator: RowValidator<any> | undefined;
  protected arrayValidatorFn: ArrayValidator<any> | undefined;
  protected selectedPropertyKeys: string[] | null = null;
  /**
   * Deferred SELECT projections built from {@link AliasedExpression}s /
   * {@link AggregateExpression}s via `select([...])`.
   *
   * Stored unresolved and rendered at build time (see
   * {@link renderAliasedProjections}) rather than eagerly at `select()` call
   * time. Deferral lets a projection reference a JOIN alias that is
   * registered *after* the `select()` call — e.g. a nested-set self-join
   * where `select([parent.name.as(...)])` precedes
   * `innerJoin(Category, "parent", ...)`. Eager resolution left such columns
   * unqualified (`parent.name` instead of `parent.CTGR_NM`).
   *
   * When non-null, this takes precedence over both {@link selectColumns} and
   * {@link selectExpressions} in the build path — the SELECT segment is
   * emitted via `RawQueryBuilder.selectFragments()` so bound values (e.g.
   * JSON path literals on MySQL) are preserved through execution.
   */
  protected aliasedProjections:
    | Array<AliasedExpression | AggregateExpression>
    | null = null;
  protected indexHints: Array<{
    type: "USE" | "FORCE" | "IGNORE";
    indexName: string;
  }> = [];
  protected pgHints: string[] = [];

  /** Maps TypeScript property names to DB column names (NamingStrategy). */
  protected propertyToColumnMap?: Map<string, string>;

  /** Dialect-specific SQL expression generator (ILIKE, full-text search, etc.). */
  protected dialectExpression?: DialectExpression;

  /**
   * Registry mapping table aliases to their entity metadata.
   * Enables cross-entity column resolution: `"u.firstName"` → `"u"."first_name"`.
   */
  protected aliasRegistry: Map<string, AliasEntry> = new Map();

  /**
   * Parameterized SQL expressions for the SELECT clause.
   * Unlike `selectColumns` (string[]), these preserve `sql-template-tag` parameter bindings.
   * Used by `addSelectSubquery()` and `withCount()` for scalar subqueries in SELECT.
   */
  protected selectExpressions: Sql[] = [];

  /**
   * #370: joined-entity selections registered by the *AndSelect methods.
   * Each entry drives result nesting in getMany()/getOne(): the row segment
   * whose keys carry the `${alias}_` prefix hydrates into `property` on the
   * entity bound to `sourceAlias`. `property` is null when the join target
   * could not be matched to a relation (plain entity joins without a
   * corresponding @ManyToOne/@OneToOne/@OneToMany) — those columns are
   * stripped from the root entity but stay available via getRawMany().
   */
  protected joinedSelections: Array<{
    alias: string;
    sourceAlias: string;
    property: string | null;
    kind: "many-to-one" | "one-to-one" | "one-to-many";
    entity: ClazzType<any>;
  }> = [];

  /** #370: true once the root `alias.*` has been expanded to `alias_col`-aliased columns. */
  protected rootSelectExpanded = false;

  // ── Inheritance state ──────────────────────────────────
  protected inheritanceStrategy: InheritanceStrategy | null = null;
  protected isInheritanceChild = false;
  protected isPolymorphicQuery = false;
  protected discriminatorColumnName?: string;
  protected discriminatorMap?: Map<string, ClazzType<any>>;

  /** TPT child: route parent-only columns to parent table alias. */
  protected tptParentInfo?: {
    alias: string;
    tableName: string;
    parentOnlyColumns: Set<string>;
  };
  /** TPT child: explicit SELECT list (child cols + parent cols from different tables). */
  protected tptSelectColumns?: string[];

  /** TPT polymorphic: discriminator value → child table name (for result prefix stripping). */
  protected tptChildPrefixMap?: Map<string, string>;
  /** TPT polymorphic: extra SELECT expressions for child own columns (prefixed). */
  protected tptPolymorphicSelectColumns?: string[];

  /** TPC polymorphic: UNION ALL subquery for FROM clause. */
  protected tpcFromSql?: Sql;

  constructor(entity: ClazzType<T>, alias: string, em: EntityManager) {
    this.entity = entity;
    this.alias = alias;
    this.em = em;
  }

  /** Set the property-to-column mapping for NamingStrategy support. */
  setPropertyToColumnMap(map: Map<string, string>): this {
    this.propertyToColumnMap = map;
    // Also register main entity in alias registry
    const resolver = this.emInternals.resolver;
    if (resolver) {
      const metadata = resolver.resolveEntityMetadata(this.entity);
      if (metadata) {
        this.aliasRegistry.set(this.alias, {
          entity: this.entity,
          tableName: metadata.name,
          propertyToColumnMap: map,
        });
      }
    }
    return this;
  }

  /** Set the dialect expression strategy for operator translation. */
  setDialectExpression(expr: DialectExpression): this {
    this.dialectExpression = expr;
    return this;
  }

  /**
   * Apply inheritance strategy setup. Called automatically by EntityManager.createQueryBuilder()
   * when the entity participates in an inheritance hierarchy.
   *
   * - **STI child:** auto-adds discriminator WHERE clause
   * - **STI root:** enables polymorphic deserialization in getMany()
   * - **TPT child:** auto INNER JOINs parent table, routes columns correctly
   * - **TPT root:** LEFT JOINs all child tables, polymorphic deserialization
   * - **TPC child:** no changes (each child has its own table)
   * - **TPC root:** replaces FROM with UNION ALL subquery, polymorphic deserialization
   *
   * @internal
   */
  applyInheritance(
    ir: InheritanceResolver,
    resolver: RelationMetadataResolver,
  ): this {
    const strategy = ir.getStrategy(this.entity);
    if (!strategy) return this;

    this.inheritanceStrategy = strategy;
    this.isInheritanceChild = ir.isChildEntity(this.entity);
    this.isPolymorphicQuery = ir.isPolymorphicQuery(this.entity);

    const discCol = ir.getDiscriminatorColumn(this.entity);
    this.discriminatorColumnName = discCol?.name ?? "dtype";

    if (this.isPolymorphicQuery) {
      this.discriminatorMap = ir.buildDiscriminatorMap(this.entity);
    }

    switch (strategy) {
      case "SINGLE_TABLE":
        this.applySTI(ir);
        break;
      case "JOINED":
        this.applyTPT(ir, resolver);
        break;
      case "TABLE_PER_CLASS":
        this.applyTPC(ir, resolver);
        break;
    }

    return this;
  }

  private applySTI(ir: InheritanceResolver): void {
    // STI child: auto-add discriminator WHERE
    if (this.isInheritanceChild) {
      const discVal = ir.getDiscriminatorValue(this.entity);
      if (discVal && this.discriminatorColumnName) {
        this.whereClauses.push(
          Conditions.equals(
            `${this.em.wrap(this.alias)}.${this.em.wrap(this.discriminatorColumnName)}`,
            discVal,
          ),
        );
      }
    }
    // STI root (polymorphic): discriminatorMap already set — getMany() handles deserialization
  }

  private applyTPT(ir: InheritanceResolver, resolver: RelationMetadataResolver): void {
    const metadata = resolver.resolveEntityMetadata(this.entity);
    if (!metadata) return;

    const pk = metadata.columns.find((c: any) => c.options?.primary);
    if (!pk) return;

    if (this.isInheritanceChild) {
      // TPT child: INNER JOIN parent table
      const root = ir.getRoot(this.entity)!;
      const rootMeta = resolver.resolveEntityMetadata(root);
      if (!rootMeta) return;

      const rootTableName = rootMeta.name;
      const tableName = metadata.name;
      const parentAlias = "__inh";

      // Identify which columns belong to parent vs child
      const pkColNames = new Set(
        metadata.columns
          .filter((c: any) => c.options?.primary)
          .map((c: any) => c.name),
      );
      const rootColNames = new Set(
        rootMeta.columns.map((c: any) => c.name),
      );
      const parentOnlyColumns = new Set<string>();
      for (const colName of rootColNames) {
        if (!pkColNames.has(colName)) {
          parentOnlyColumns.add(colName);
        }
      }

      this.tptParentInfo = { alias: parentAlias, tableName: rootTableName, parentOnlyColumns };

      // Build explicit SELECT column list: child own columns + parent columns
      const selectCols: string[] = [];
      for (const col of metadata.columns) {
        const isRootOnly = rootColNames.has(col.name) && !pkColNames.has(col.name);
        if (!isRootOnly) {
          selectCols.push(`${this.em.wrap(this.alias)}.${this.em.wrap(col.name)}`);
        }
      }
      for (const col of rootMeta.columns) {
        if (!pkColNames.has(col.name)) {
          selectCols.push(`${this.em.wrap(parentAlias)}.${this.em.wrap(col.name)}`);
        }
      }
      this.tptSelectColumns = selectCols;

      // Add INNER JOIN
      const joinCond = sql`${raw(`${this.em.wrap(this.alias)}.${this.em.wrap(pk.name)}`)
        } = ${raw(`${this.em.wrap(parentAlias)}.${this.em.wrap(pk.name)}`)}`;
      this.joinClauses.push({
        type: "INNER",
        table: rootTableName,
        alias: parentAlias,
        condition: joinCond,
      });

      // Register parent in alias registry
      const parentPropMap = this.buildPropertyToColumnMapFromMetadata(rootMeta);
      this.aliasRegistry.set(parentAlias, {
        entity: root,
        tableName: rootTableName,
        propertyToColumnMap: parentPropMap,
      });
    } else if (this.isPolymorphicQuery) {
      // TPT root (polymorphic): LEFT JOIN all child tables
      const tableName = metadata.name;
      const children = ir.getConcreteEntities(this.entity).filter((c) => c !== this.entity);
      const extraSelectCols: string[] = [];
      const childPrefixMap = new Map<string, string>();

      for (const ChildEntity of children) {
        const childMeta = resolver.resolveEntityMetadata(ChildEntity);
        if (!childMeta) continue;
        const childTableName = childMeta.name;
        const dv = ir.getDiscriminatorValue(ChildEntity);

        // LEFT JOIN child table on PK
        const joinCond = sql`${raw(`${this.em.wrap(this.alias)}.${this.em.wrap(pk.name)}`)
          } = ${raw(`${this.em.wrap(childTableName)}.${this.em.wrap(pk.name)}`)}`;
        this.joinClauses.push({
          type: "LEFT",
          table: childTableName,
          alias: childTableName,
          condition: joinCond,
        });

        // Add child own columns to SELECT with prefix aliases
        const ownCols = ir.getOwnColumns(ChildEntity);
        for (const col of ownCols) {
          extraSelectCols.push(
            `${this.em.wrap(childTableName)}.${this.em.wrap(col.name)} AS ${this.em.wrap(`${childTableName}_${col.name}`)}`,
          );
        }

        if (dv) {
          childPrefixMap.set(dv, childTableName);
        }
      }

      this.tptPolymorphicSelectColumns = extraSelectCols;
      this.tptChildPrefixMap = childPrefixMap;
    }
  }

  private applyTPC(ir: InheritanceResolver, resolver: RelationMetadataResolver): void {
    if (!this.isPolymorphicQuery) return;

    // TPC root (polymorphic): build UNION ALL subquery
    const allEntities = ir.getConcreteEntities(this.entity);
    const allHierarchyCols = ir.getAllHierarchyColumns(this.entity).map((c) => c.name);
    const discColName = this.discriminatorColumnName ?? "dtype";

    const subQueries: Sql[] = [];
    for (const ent of allEntities) {
      const entMeta = resolver.resolveEntityMetadata(ent);
      if (!entMeta) continue;
      const entTableName = entMeta.name;
      const entColNames = new Set(entMeta.columns.map((c: any) => c.name));
      const discVal = ir.getDiscriminatorValue(ent) ?? ent.name;

      const colExprs: Sql[] = allHierarchyCols.map((colName) =>
        entColNames.has(colName)
          ? sql`${raw(this.em.wrap(colName))}`
          : sql`NULL AS ${raw(this.em.wrap(colName))}`,
      );
      colExprs.push(sql`${discVal} AS ${raw(this.em.wrap(discColName))}`);

      const subSql = sql`SELECT ${join(colExprs, ", ")} FROM ${raw(this.em.wrapTable(entTableName))}`;
      subQueries.push(subSql);
    }

    this.tpcFromSql = join(subQueries, " UNION ALL ");
  }

  // ── Helpers ──────────────────────────────────────────────

  /** Qualify a column with the main alias: `"u"."name"` */
  protected col(column: string): string {
    const dbCol = this.propertyToColumnMap?.get(column) ?? column;
    // TPT child: route parent-only columns to parent table alias
    if (this.tptParentInfo?.parentOnlyColumns.has(dbCol)) {
      return `${this.em.wrap(this.tptParentInfo.alias)}.${this.em.wrap(dbCol)}`;
    }
    return `${this.em.wrap(this.alias)}.${this.em.wrap(dbCol)}`;
  }

  /** Qualify a column for a different alias, resolving property names via alias registry. */
  protected qualifiedCol(tableAlias: string, column: string): string {
    const entry = this.aliasRegistry.get(tableAlias);
    if (entry) {
      const dbCol = entry.propertyToColumnMap.get(column) ?? column;
      return `${this.em.wrap(tableAlias)}.${this.em.wrap(dbCol)}`;
    }
    return `${this.em.wrap(tableAlias)}.${this.em.wrap(column)}`;
  }

  /**
   * Resolve a column reference that may use `"alias.property"` notation.
   *
   * - `"u.firstName"` → splits on dot, looks up alias `"u"` in registry,
   *   maps property `"firstName"` → DB column `"first_name"` → `"u"."first_name"`
   * - `"firstName"` → no dot, delegates to `col()` (main entity)
   */
  protected resolveColumn(ref: string): string {
    const dotIndex = ref.indexOf(".");
    if (dotIndex > 0) {
      const alias = ref.substring(0, dotIndex);
      const property = ref.substring(dotIndex + 1);
      return this.qualifiedCol(alias, property);
    }
    return this.col(ref);
  }

  /**
   * @internal Build the {@link WhereResolverOptions} used to translate a
   * Prisma-style {@link WhereClause} object into qualified SQL conditions —
   * the same resolver `EntityManager.find()` uses. Columns are qualified
   * with the builder's main alias (so `{ status: "active" }` becomes
   * `"u"."status" = ?`), property names map through the NamingStrategy via
   * `col()`, and the dialect / dialect-expression strategy are threaded so
   * `ilike` / `search` operators render correctly.
   */
  private whereClauseResolverOptions(): WhereResolverOptions {
    const ctx = this.emInternals._ctx;
    const dialect: "mysql" | "postgres" | "sqlite" = ctx?.isMySqlFamily?.()
      ? "mysql"
      : ctx?.isSqlite?.()
        ? "sqlite"
        : "postgres";
    return {
      wrapColumn: (name: string) => this.em.wrap(name),
      qualified: true,
      // col() handles property→column mapping, main-alias qualification,
      // and TPT parent-column routing in one step.
      qualifyColumn: (dbColumnName: string) => this.col(dbColumnName),
      dialect,
      dialectExpression: this.dialectExpression,
    };
  }

  /**
   * @internal Runtime guard: is `value` a plain `WhereClause` object (or
   * array of them) rather than a `Sql`, a QueryDSL condition/expression,
   * an `EntityRef`, or a subquery builder? Used by `where()`/`andWhere()`/
   * `orWhere()` to route the filter-object overload without colliding with
   * the existing condition overloads.
   */
  private isPlainWhereClause(
    value: unknown,
  ): value is WhereClause<T> | WhereClause<T>[] {
    if (value === null || typeof value !== "object") return false;
    if (Array.isArray(value)) {
      // OR-group form: only treat as a where-clause array when every
      // element is itself a plain object (not e.g. a list of Sql fragments).
      return value.every(
        (el) =>
          el !== null && typeof el === "object" && this.isPlainWhereClause(el),
      );
    }
    const o = value as Record<string, unknown>;
    if ("sql" in o && "values" in o) return false; // Sql
    if (
      o.__isCondition ||
      o.__isColumnExpression ||
      o.__isScalarExpression ||
      o.__isAggregateExpression
    ) {
      return false; // QueryDSL condition / expression
    }
    if (typeof o._alias === "string" && typeof o._entity === "function") {
      return false; // EntityRef / QEntity proxy
    }
    if (typeof (o as { toSql?: unknown }).toSql === "function") {
      return false; // subquery-like builder
    }
    return true;
  }

  /**
   * Characters that cannot appear in a column reference accepted by the
   * string overloads (`"firstName"` / `"u.firstName"`): whitespace,
   * comparison operators, parentheses, quotes, and parameter markers.
   */
  private static readonly SQL_FRAGMENT_CHARS = /[\s=<>!()'"`;,?:]/;

  /**
   * Fail fast when a string argument to `where()`/`andWhere()`/`orWhere()`
   * is a raw SQL fragment (`"u.id = :id"`) rather than a column reference.
   * The string overloads would otherwise identifier-quote the whole
   * fragment (`"u"."id = :id" = ?`) with a dangling bind, and the failure
   * only surfaces as a cryptic driver error at execution time.
   */
  private assertColumnRefString(ref: string, method: string): void {
    if (!SelectQueryBuilder.SQL_FRAGMENT_CHARS.test(ref)) return;
    throw new InvalidQueryError(
      `${method}() received a raw SQL string ("${ref}") — string arguments must be a plain column reference such as "firstName" or "u.firstName".`,
      "For raw SQL use a parameterized template: where(sql`u.id = ${value}`) — or a Conditions helper (Conditions.like(...)), rawExpr(), the filter-object form (where({ name: value })), or the column/value overloads (where(\"u.name\", value) / where(\"age\", \">=\", 18)).",
    );
  }

  /**
   * @internal Resolve a `WhereClause` object/array into a single combined
   * `Sql` condition (keys AND-ed; array elements OR-ed), or `null` when the
   * clause is empty (`{}` / `[]`) so callers can skip pushing a no-op.
   */
  private whereClauseToSql(
    clause: WhereClause<T> | WhereClause<T>[],
  ): Sql | null {
    const resolved = resolveWhereClause<T>(
      clause,
      this.whereClauseResolverOptions(),
    );
    if (resolved.length === 0) return null;
    return resolved.length === 1 ? resolved[0] : Conditions.and(resolved);
  }

  /**
   * Build a property-to-column map from entity metadata.
   * Delegates to the shared {@link buildSharedPropertyToColumnMap} helper
   * (also backing EntityManager and SchemaGenerator), kept as a protected
   * method so subclass query builders retain their extension point.
   *
   * Folds in `@ManyToOne`/`@OneToOne` FK backing-property mappings
   * (e.g. `workspaceId` → `workspace_id`) when the metadata carries an
   * entity reference, so `qAlias(Entity).fkProp` resolves correctly.
   */
  protected buildPropertyToColumnMapFromMetadata(
    metadata: { target?: ClazzType<any>; columns: ColumnMetadata[] },
  ): Map<string, string> {
    return buildSharedPropertyToColumnMap(metadata, this.emInternals.resolver);
  }

  // ── SELECT ───────────────────────────────────────────────

  /**
   * Select specific columns. Receives `keyof T` auto-completion.
   *
   * When specific columns are provided, the result type narrows to
   * `Pick<T, K>` — accessing unselected columns becomes a compile error.
   *
   * @example
   * ```ts
   * qb.select(["id", "name"])   // result type: Pick<User, "id" | "name">
   * qb.select("*")              // result type: T (all columns)
   * ```
   */
  select<K extends ColumnOf<T>>(
    columns: K[],
  ): SelectQueryBuilder<T, Pick<T, K>>;
  select(columns: "*"): SelectQueryBuilder<T, T>;
  /**
   * Seed the SELECT clause with one or more {@link AggregateExpression}s.
   *
   * Result keying: aggregate columns are exposed under their alias — either
   * the one passed to `.as("name")` or the deterministic default from
   * `AggregateExpression.getAlias()` (e.g. `agg_count_id`). Prefer
   * `getRawMany()` when the projection is aggregate-only, since TResult
   * no longer matches the entity shape.
   */
  select(aggregate: AggregateExpression): SelectQueryBuilder<T, any>;
  select(aggregates: AggregateExpression[]): SelectQueryBuilder<T, any>;
  /**
   * Seed the SELECT clause with one or more {@link AliasedExpression}s
   * — columns or JSON-path extractions tagged with an explicit result
   * alias via `.as("name")`. Mix of {@link AliasedExpression} and
   * {@link AggregateExpression} is supported; the list is rendered as a
   * parameterized SELECT fragment so JSON path literals survive
   * execution.
   */
  select(aliased: AliasedExpression): SelectQueryBuilder<T, any>;
  select(aliased: AliasedExpression[]): SelectQueryBuilder<T, any>;
  select(
    projections: Array<AliasedExpression | AggregateExpression>,
  ): SelectQueryBuilder<T, any>;
  select<K extends ColumnOf<T>>(
    columns:
      | K[]
      | "*"
      | AggregateExpression
      | AggregateExpression[]
      | AliasedExpression
      | AliasedExpression[]
      | Array<AliasedExpression | AggregateExpression>,
  ): SelectQueryBuilder<T, any> {
    if (isAliasedExpression(columns)) {
      return this.selectAliased([columns]);
    }
    if (isAggregateExpression(columns)) {
      // Aggregates that carry bound parameters — a custom argument renderer
      // (`AVG(scalarExpr)`) or a `FILTER (WHERE …)` predicate — must travel
      // through the parameterized path so those values survive.
      if (this.aggregateNeedsParamPath(columns as AggregateExpression)) {
        return this.selectAliased([columns]);
      }
      return this.selectAggregates([columns]);
    }
    if (Array.isArray(columns) && columns.length > 0) {
      const first = columns[0];
      if (isAliasedExpression(first) || isAggregateExpression(first)) {
        // Any aliased entry — or any aggregate with a parameterized arg
        // renderer — forces the parameterized-fragment path so bindings
        // survive; a homogeneous list of plain column aggregates keeps
        // the cheaper string path.
        const needsParamPath = (columns as unknown[]).some(
          (c) =>
            isAliasedExpression(c) ||
            (isAggregateExpression(c) &&
              this.aggregateNeedsParamPath(c as AggregateExpression)),
        );
        if (needsParamPath) {
          return this.selectAliased(
            columns as Array<AliasedExpression | AggregateExpression>,
          );
        }
        return this.selectAggregates(columns as AggregateExpression[]);
      }
    }
    if (columns === "*") {
      this.selectColumns = "*";
      this.selectedPropertyKeys = null;
      this.aliasedProjections = null;
    } else {
      this.selectColumns = (columns as string[]).map((c) => this.col(c));
      this.selectedPropertyKeys = columns as string[];
      this.aliasedProjections = null;
    }
    return this as any;
  }

  /**
   * @internal True when an aggregate must travel through the parameterized
   * SELECT path instead of the cheap stringified one.
   *
   * The stringified path drops bound values and the dialect, which is fine
   * for a plain `COUNT(col)` but not for an aggregate that embeds parameters:
   * a custom argument renderer (`AVG(scalarExpr)`) or a `FILTER (WHERE …)`
   * predicate. Both carry bindings that the string path would silently lose.
   */
  private aggregateNeedsParamPath(agg: AggregateExpression): boolean {
    return agg.argRenderer !== undefined || agg.filterCondition !== undefined;
  }

  /**
   * @internal Replace the SELECT clause with aggregate-only projections.
   *
   * Aggregates render as pure raw SQL (func name + qualified column, no
   * bound parameters), so it's safe to stringify them and funnel through
   * `selectColumns` — the same path as plain columns. Keeping them there
   * avoids the `selectExpressions` merge machinery which requires a
   * non-empty column list to attach to. Aggregates that carry bindings
   * (see {@link aggregateNeedsParamPath}) are routed elsewhere before
   * reaching here.
   */
  private selectAggregates(aggregates: AggregateExpression[]): this {
    const fragments: string[] = [];
    for (const agg of aggregates) {
      const resolvedAlias = agg.alias ?? agg.getAlias();
      const fn = agg.renderFunction(
        (ref) => this.resolveColumn(ref),
        this.dialectExpression,
      );
      fragments.push(`${fn.sql} AS ${this.em.wrap(resolvedAlias)}`);
    }
    this.selectColumns = fragments;
    this.selectedPropertyKeys = null;
    this.aliasedProjections = null;
    return this;
  }

  /**
   * @internal Record a parameterized alias projection for deferred rendering.
   *
   * Used when the projection contains an {@link AliasedExpression} —
   * JSON path extractions encode path literals as bound parameters, so the
   * list is rendered as a `Sql[]` (preserving those values) at build time and
   * handed to {@link RawQueryBuilder.selectFragments}. Aggregates mixed in are
   * rendered alongside so callers can freely combine `count().as()` with
   * `col.as()`.
   *
   * Projections are stored unresolved and resolved in
   * {@link renderAliasedProjections} at build time — see
   * {@link aliasedProjections} for why deferral matters (forward references
   * to JOIN aliases registered after this call).
   */
  private selectAliased(
    projections: Array<AliasedExpression | AggregateExpression>,
  ): this {
    this.aliasedProjections = projections;
    this.selectColumns = "*";
    this.selectedPropertyKeys = null;
    return this;
  }

  /**
   * @internal Render the deferred {@link aliasedProjections} into SELECT
   * fragments. Called at build time (`toSql()`), after every JOIN alias has
   * been registered, so projections referencing a later-joined alias resolve
   * to the correct qualified column.
   */
  private renderAliasedProjections(): Sql[] {
    const fragments: Sql[] = [];
    const resolver: ColumnResolver = (ref) => this.resolveColumn(ref);
    for (const p of this.aliasedProjections ?? []) {
      if (isAliasedExpression(p)) {
        const inner = p.renderer(resolver, this.dialectExpression);
        fragments.push(sql`${inner} AS ${raw(this.em.wrap(p.alias))}`);
      } else if (isAggregateExpression(p)) {
        const resolvedAlias = p.alias ?? p.getAlias();
        const fn = p.renderFunction(resolver, this.dialectExpression);
        fragments.push(sql`${fn} AS ${raw(this.em.wrap(resolvedAlias))}`);
      }
    }
    return fragments;
  }

  /**
   * Add additional select expressions (raw SQL fragments or aggregates).
   *
   * @example
   * ```ts
   * qb.addSelect(Conditions.count("*"), "total")
   * ```
   */
  /**
   * Select columns using alias-prefixed property names for cross-entity queries.
   *
   * Unlike `select()`, this method accepts `"alias.property"` notation and
   * does not perform TypeScript type narrowing.
   *
   * @example
   * ```ts
   * qb.leftJoin(User, "u", (j) => j.on("p.userId", "=", "u.id"))
   *   .selectRaw(["p.title", "u.firstName"])
   * ```
   */
  selectRaw(columns: string[]): this {
    this.selectColumns = columns.map((c) => this.resolveRawSelectColumn(c));
    this.selectedPropertyKeys = null;
    return this;
  }

  /**
   * @internal Resolve one `selectRaw()` token.
   *
   * A token is alias-resolved (property → DB column, alias qualification)
   * only when it is a *bare column reference* — `property` or
   * `alias.property`. Anything carrying SQL syntax (function calls like
   * `COUNT(*)`, operators, `*`, whitespace, quotes) is a raw expression the
   * caller wrote deliberately and passes through untouched. Routing such
   * expressions through {@link resolveColumn} previously mangled them into
   * `"alias"."COUNT(*)"`-style garbage.
   */
  private resolveRawSelectColumn(token: string): string {
    const isBareColumnRef =
      /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(token.trim());
    return isBareColumnRef ? this.resolveColumn(token) : token;
  }

  addSelect(expr: AggregateExpression): this;
  addSelect(expr: AliasedExpression): this;
  /**
   * #372: expression-builder form. The callback receives the same
   * dialect-portable `e` context as `@ComputedColumn({ expression })` —
   * `e.col("alias.prop")`, `e.count(...)`, `e.iff(...)`, arithmetic — so
   * `COUNT(node.name) - 1 AS depth`-style projections need no raw SQL.
   *
   * @example
   * ```ts
   * qb.addSelect((e) => e.count("node.name").sub(1), "depth")
   * qb.addSelect((e) => e.col("c.rgt").sub(e.col("c.lft").add(1)).div(2).floor(), "children")
   * ```
   */
  addSelect(
    builder: (
      e: SelectExpressionContext,
    ) => ScalarExpression | AggregateExpression | AliasedExpression,
    alias?: string,
  ): this;
  addSelect(expr: Sql | string, alias?: string): this;
  addSelect(
    expr:
      | Sql
      | string
      | AggregateExpression
      | AliasedExpression
      | ((
          e: SelectExpressionContext,
        ) => ScalarExpression | AggregateExpression | AliasedExpression),
    alias?: string,
  ): this {
    if (typeof expr === "function") {
      const result = expr(getExpressionContext());
      if (isScalarExpression(result)) {
        if (!alias) {
          throw new OrmError(
            OrmErrorCode.INVALID_QUERY,
            "addSelect(builder) with a scalar expression requires an alias: " +
              'addSelect((e) => ..., "alias") or return e.expr(...).as("alias").',
          );
        }
        const inner = result.renderer(
          (ref) => this.resolveColumn(ref),
          this.dialectExpression,
        );
        this.selectExpressions.push(
          sql`${inner} AS ${raw(this.em.wrap(alias))}`,
        );
        return this;
      }
      if (isAliasedExpression(result)) return this.addSelect(result);
      if (isAggregateExpression(result)) {
        return this.addSelect(alias ? result.as(alias) : result);
      }
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        "addSelect(builder) must return an expression built from the provided " +
          "context — e.col(...), e.count(...), e.iff(...), or .as(alias) thereof.",
      );
    }
    if (isAliasedExpression(expr)) {
      // Route through `selectExpressions` so JSON path bindings survive;
      // these fragments are appended to the existing SELECT list at
      // build time.
      const inner = expr.renderer(
        (ref) => this.resolveColumn(ref),
        this.dialectExpression,
      );
      this.selectExpressions.push(
        sql`${inner} AS ${raw(this.em.wrap(expr.alias))}`,
      );
      return this;
    }
    if (isAggregateExpression(expr)) {
      const resolvedAlias = expr.alias ?? alias ?? expr.getAlias();
      // Aggregates that carry bound parameters — a custom argRenderer
      // (`AVG(scalarExpr)`) or a `FILTER (WHERE …)` predicate — route through
      // the parameterized selectExpressions list so the bindings survive.
      // Plain column aggregates have no parameters and stay on the cheap
      // stringified path.
      if (this.aggregateNeedsParamPath(expr as AggregateExpression)) {
        const inner = expr.renderFunction(
          (ref) => this.resolveColumn(ref),
          this.dialectExpression,
        );
        this.selectExpressions.push(
          sql`${inner} AS ${raw(this.em.wrap(resolvedAlias))}`,
        );
        return this;
      }
      const fn = expr.renderFunction((ref) => this.resolveColumn(ref));
      const fragment = `${fn.sql} AS ${this.em.wrap(resolvedAlias)}`;
      if (this.selectColumns === "*") {
        this.selectColumns = [`${this.em.wrap(this.alias)}.*`, fragment];
      } else {
        (this.selectColumns as string[]).push(fragment);
      }
      return this;
    }
    const exprStr = typeof expr === "string" ? this.resolveColumn(expr) : expr.sql;
    const fragment = alias ? `${exprStr} AS ${this.em.wrap(alias)}` : exprStr;
    if (this.selectColumns === "*") {
      this.selectColumns = [`${this.em.wrap(this.alias)}.*`, fragment];
    } else {
      (this.selectColumns as string[]).push(fragment);
    }
    return this;
  }

  /**
   * Enable SELECT DISTINCT.
   */
  setDistinct(value = true): this {
    this.distinct = value;
    return this;
  }

  // ── WHERE ────────────────────────────────────────────────

  /**
   * Add a WHERE condition. Supports multiple call signatures:
   *
   * 1. `where("name", "Alice")` → equals (main entity property)
   * 2. `where("age", ">=", 18)` → operator
   * 3. `where("u.firstName", "LIKE", "%John%")` → cross-entity with alias
   * 4. `where(Conditions.like(...))` → raw Sql
   *
   * String arguments are column references, never SQL. Passing a raw SQL
   * fragment (`where("u.id = :id", { id })`) throws `InvalidQueryError` —
   * use the `sql` template tag, `Conditions`, or the filter-object form.
   */
  where(condition: Sql): this;
  where(condition: ColumnCondition): this;
  where(condition: JsonPathCondition): this;
  where(condition: AggregateCondition): this;
  where(condition: LogicalCondition): this;
  where(condition: ConditionLike): this;
  where(clause: WhereClause<T> | WhereClause<T>[]): this;
  where(column: ColumnOf<T>, value: T[ColumnOf<T>] | Sql | null): this;
  where(column: ColumnOf<T>, operator: WhereOperator, value: any): this;
  where(column: string, value: any): this;
  where(column: string, operator: WhereOperator, value: any): this;
  where(
    columnOrCondition: string | Sql | ConditionLike | WhereClause<T> | WhereClause<T>[],
    operatorOrValue?: any,
    value?: any,
  ): this {
    if (typeof columnOrCondition === "string") {
      this.assertColumnRefString(columnOrCondition, "where");
    }
    if (
      operatorOrValue === undefined &&
      value === undefined &&
      this.isPlainWhereClause(columnOrCondition)
    ) {
      const cond = this.whereClauseToSql(columnOrCondition);
      if (cond) this.whereClauses.push(cond);
      return this;
    }
    this.whereClauses.push(
      this.resolveCondition(columnOrCondition as any, operatorOrValue, value),
    );
    return this;
  }

  /**
   * Add an AND WHERE condition.
   */
  andWhere(condition: Sql): this;
  andWhere(condition: ColumnCondition): this;
  andWhere(condition: JsonPathCondition): this;
  andWhere(condition: AggregateCondition): this;
  andWhere(condition: LogicalCondition): this;
  andWhere(condition: ConditionLike): this;
  andWhere(clause: WhereClause<T> | WhereClause<T>[]): this;
  andWhere(column: ColumnOf<T>, value: T[ColumnOf<T>] | Sql | null): this;
  andWhere(column: ColumnOf<T>, operator: WhereOperator, value: any): this;
  andWhere(column: string, value: any): this;
  andWhere(column: string, operator: WhereOperator, value: any): this;
  andWhere(
    columnOrCondition: string | Sql | ConditionLike | WhereClause<T> | WhereClause<T>[],
    operatorOrValue?: any,
    value?: any,
  ): this {
    if (typeof columnOrCondition === "string") {
      this.assertColumnRefString(columnOrCondition, "andWhere");
    }
    if (
      operatorOrValue === undefined &&
      value === undefined &&
      this.isPlainWhereClause(columnOrCondition)
    ) {
      const cond = this.whereClauseToSql(columnOrCondition);
      if (cond) this.whereClauses.push(cond);
      return this;
    }
    this.whereClauses.push(
      this.resolveCondition(columnOrCondition as any, operatorOrValue, value),
    );
    return this;
  }

  /**
   * Add an OR WHERE condition (wrapped in parentheses with existing conditions).
   */
  orWhere(condition: Sql): this;
  orWhere(condition: ColumnCondition): this;
  orWhere(condition: JsonPathCondition): this;
  orWhere(condition: AggregateCondition): this;
  orWhere(condition: LogicalCondition): this;
  orWhere(condition: ConditionLike): this;
  orWhere(clause: WhereClause<T> | WhereClause<T>[]): this;
  orWhere(column: ColumnOf<T>, value: T[ColumnOf<T>] | Sql | null): this;
  orWhere(column: ColumnOf<T>, operator: WhereOperator, value: any): this;
  orWhere(column: string, value: any): this;
  orWhere(column: string, operator: WhereOperator, value: any): this;
  orWhere(
    columnOrCondition: string | Sql | ConditionLike | WhereClause<T> | WhereClause<T>[],
    operatorOrValue?: any,
    value?: any,
  ): this {
    if (typeof columnOrCondition === "string") {
      this.assertColumnRefString(columnOrCondition, "orWhere");
    }
    let cond: Sql | null;
    if (
      operatorOrValue === undefined &&
      value === undefined &&
      this.isPlainWhereClause(columnOrCondition)
    ) {
      cond = this.whereClauseToSql(columnOrCondition);
      // Empty clause ({} / []) — nothing to OR in.
      if (!cond) return this;
    } else {
      cond = this.resolveCondition(
        columnOrCondition as any,
        operatorOrValue,
        value,
      );
    }
    if (this.whereClauses.length === 0) {
      this.whereClauses.push(cond);
    } else {
      // Wrap existing AND clauses and add OR
      const existing = Conditions.and(this.whereClauses);
      this.whereClauses = [Conditions.or([existing, cond])];
    }
    return this;
  }

  /**
   * WHERE column IN (values). Supports `"alias.property"` notation.
   */
  whereIn(column: ColumnOf<T>, values: any[]): this;
  whereIn(column: string, values: any[]): this;
  whereIn(column: string, values: any[]): this {
    this.whereClauses.push(Conditions.in(this.resolveColumn(column), values));
    return this;
  }

  /**
   * WHERE column NOT IN (values). Supports `"alias.property"` notation.
   */
  whereNotIn(column: ColumnOf<T>, values: any[]): this;
  whereNotIn(column: string, values: any[]): this;
  whereNotIn(column: string, values: any[]): this {
    this.whereClauses.push(Conditions.notIn(this.resolveColumn(column), values));
    return this;
  }

  /**
   * WHERE column IS NULL. Supports `"alias.property"` notation.
   */
  whereNull(column: ColumnOf<T>): this;
  whereNull(column: string): this;
  whereNull(column: string): this {
    this.whereClauses.push(Conditions.isNull(this.resolveColumn(column)));
    return this;
  }

  /**
   * WHERE column IS NOT NULL. Supports `"alias.property"` notation.
   */
  whereNotNull(column: ColumnOf<T>): this;
  whereNotNull(column: string): this;
  whereNotNull(column: string): this {
    this.whereClauses.push(Conditions.isNotNull(this.resolveColumn(column)));
    return this;
  }

  /**
   * WHERE column BETWEEN min AND max. Supports `"alias.property"` notation.
   */
  whereBetween(column: ColumnOf<T>, min: any, max: any): this;
  whereBetween(column: string, min: any, max: any): this;
  whereBetween(column: string, min: any, max: any): this {
    this.whereClauses.push(Conditions.between(this.resolveColumn(column), min, max));
    return this;
  }

  /**
   * WHERE column LIKE pattern. Supports `"alias.property"` notation.
   */
  whereLike(column: ColumnOf<T>, pattern: string): this;
  whereLike(column: string, pattern: string): this;
  whereLike(column: string, pattern: string): this {
    this.whereClauses.push(Conditions.like(this.resolveColumn(column), pattern));
    return this;
  }

  // ── JOIN ─────────────────────────────────────────────────

  /**
   * Add a LEFT JOIN.
   *
   * Supports two forms:
   * 1. **String-based** (backward compatible): `leftJoin("posts", "p", "u.id = p.author_id")`
   * 2. **Entity-aware**: `leftJoin(User, "u", (join) => join.on("p.userId", "=", "u.id"))`
   */
  leftJoin(table: string, alias: string, condition: Sql | string): this;
  leftJoin<U>(entity: ClazzType<U>, alias: string, onBuilder: (join: JoinOnBuilder) => JoinOnBuilder): this;
  leftJoin<U>(ref: EntityRef<U>, onBuilder: (join: JoinOnBuilder) => JoinOnBuilder): this;
  leftJoin(
    tableOrEntity: string | ClazzType<any> | EntityRef<any>,
    aliasOrBuilder: string | ((join: JoinOnBuilder) => JoinOnBuilder),
    conditionOrBuilder?: Sql | string | ((join: JoinOnBuilder) => JoinOnBuilder),
  ): this {
    if (isEntityRef(tableOrEntity) && typeof aliasOrBuilder === "function") {
      return this.addEntityJoin("LEFT", tableOrEntity._entity, tableOrEntity._alias, aliasOrBuilder as (join: JoinOnBuilder) => JoinOnBuilder);
    }
    if (typeof tableOrEntity === "function" && typeof conditionOrBuilder === "function") {
      return this.addEntityJoin("LEFT", tableOrEntity, aliasOrBuilder as string, conditionOrBuilder as (join: JoinOnBuilder) => JoinOnBuilder);
    }
    return this.addJoin("LEFT", tableOrEntity as string, aliasOrBuilder as string, conditionOrBuilder as Sql | string);
  }

  /**
   * Add an INNER JOIN.
   *
   * Supports both string-based and entity-aware forms.
   */
  innerJoin(table: string, alias: string, condition: Sql | string): this;
  innerJoin<U>(entity: ClazzType<U>, alias: string, onBuilder: (join: JoinOnBuilder) => JoinOnBuilder): this;
  innerJoin<U>(ref: EntityRef<U>, onBuilder: (join: JoinOnBuilder) => JoinOnBuilder): this;
  innerJoin(
    tableOrEntity: string | ClazzType<any> | EntityRef<any>,
    aliasOrBuilder: string | ((join: JoinOnBuilder) => JoinOnBuilder),
    conditionOrBuilder?: Sql | string | ((join: JoinOnBuilder) => JoinOnBuilder),
  ): this {
    if (isEntityRef(tableOrEntity) && typeof aliasOrBuilder === "function") {
      return this.addEntityJoin("INNER", tableOrEntity._entity, tableOrEntity._alias, aliasOrBuilder as (join: JoinOnBuilder) => JoinOnBuilder);
    }
    if (typeof tableOrEntity === "function" && typeof conditionOrBuilder === "function") {
      return this.addEntityJoin("INNER", tableOrEntity, aliasOrBuilder as string, conditionOrBuilder as (join: JoinOnBuilder) => JoinOnBuilder);
    }
    return this.addJoin("INNER", tableOrEntity as string, aliasOrBuilder as string, conditionOrBuilder as Sql | string);
  }

  /**
   * Add a RIGHT JOIN.
   *
   * Supports both string-based and entity-aware forms.
   */
  rightJoin(table: string, alias: string, condition: Sql | string): this;
  rightJoin<U>(entity: ClazzType<U>, alias: string, onBuilder: (join: JoinOnBuilder) => JoinOnBuilder): this;
  rightJoin<U>(ref: EntityRef<U>, onBuilder: (join: JoinOnBuilder) => JoinOnBuilder): this;
  rightJoin(
    tableOrEntity: string | ClazzType<any> | EntityRef<any>,
    aliasOrBuilder: string | ((join: JoinOnBuilder) => JoinOnBuilder),
    conditionOrBuilder?: Sql | string | ((join: JoinOnBuilder) => JoinOnBuilder),
  ): this {
    if (isEntityRef(tableOrEntity) && typeof aliasOrBuilder === "function") {
      return this.addEntityJoin("RIGHT", tableOrEntity._entity, tableOrEntity._alias, aliasOrBuilder as (join: JoinOnBuilder) => JoinOnBuilder);
    }
    if (typeof tableOrEntity === "function" && typeof conditionOrBuilder === "function") {
      return this.addEntityJoin("RIGHT", tableOrEntity, aliasOrBuilder as string, conditionOrBuilder as (join: JoinOnBuilder) => JoinOnBuilder);
    }
    return this.addJoin("RIGHT", tableOrEntity as string, aliasOrBuilder as string, conditionOrBuilder as Sql | string);
  }

  /**
   * LEFT JOIN and automatically SELECT all columns from the joined entity.
   *
   * Equivalent to `leftJoin()` + `selectRaw()` for all joined entity columns.
   * The result includes both the main entity's and joined entity's columns.
   *
   * @example
   * ```ts
   * const results = await em
   *   .createQueryBuilder(Post, "p")
   *   .leftJoinAndSelect(User, "u", (j) => j.on("p.authorId", "=", "u.id"))
   *   .where("p.status", "published")
   *   .getRawMany();
   * // [{ id: 1, title: "...", u_id: 1, u_name: "Alice", u_email: "..." }, ...]
   * ```
   */
  leftJoinAndSelect<U>(entity: ClazzType<U>, alias: string, onBuilder: (join: JoinOnBuilder) => JoinOnBuilder): this;
  leftJoinAndSelect<U>(ref: EntityRef<U>, onBuilder: (join: JoinOnBuilder) => JoinOnBuilder): this;
  leftJoinAndSelect<U>(
    entityOrRef: ClazzType<U> | EntityRef<U>,
    aliasOrBuilder: string | ((join: JoinOnBuilder) => JoinOnBuilder),
    onBuilder?: (join: JoinOnBuilder) => JoinOnBuilder,
  ): this {
    if (isEntityRef(entityOrRef) && typeof aliasOrBuilder === "function") {
      return this.addEntityJoin("LEFT", entityOrRef._entity, entityOrRef._alias, aliasOrBuilder as (join: JoinOnBuilder) => JoinOnBuilder, true);
    }
    return this.addEntityJoin("LEFT", entityOrRef as ClazzType<U>, aliasOrBuilder as string, onBuilder!, true);
  }

  /**
   * INNER JOIN and automatically SELECT all columns from the joined entity.
   * @see leftJoinAndSelect
   */
  innerJoinAndSelect<U>(entity: ClazzType<U>, alias: string, onBuilder: (join: JoinOnBuilder) => JoinOnBuilder): this;
  innerJoinAndSelect<U>(ref: EntityRef<U>, onBuilder: (join: JoinOnBuilder) => JoinOnBuilder): this;
  innerJoinAndSelect<U>(
    entityOrRef: ClazzType<U> | EntityRef<U>,
    aliasOrBuilder: string | ((join: JoinOnBuilder) => JoinOnBuilder),
    onBuilder?: (join: JoinOnBuilder) => JoinOnBuilder,
  ): this {
    if (isEntityRef(entityOrRef) && typeof aliasOrBuilder === "function") {
      return this.addEntityJoin("INNER", entityOrRef._entity, entityOrRef._alias, aliasOrBuilder as (join: JoinOnBuilder) => JoinOnBuilder, true);
    }
    return this.addEntityJoin("INNER", entityOrRef as ClazzType<U>, aliasOrBuilder as string, onBuilder!, true);
  }

  /**
   * Add a LEFT JOIN using a relation property name.
   * Automatically resolves the ON condition from @ManyToOne / @OneToMany / @OneToOne metadata.
   *
   * @example
   * ```ts
   * // Post has @ManyToOne(() => User) user property
   * em.createQueryBuilder(Post, "p")
   *   .leftJoinRelation("user", "u")   // auto: ON p.user_id = u.id
   *   .where("u.firstName", "LIKE", "%John%")
   * ```
   */
  leftJoinRelation(propertyName: string, alias: string): this {
    return this.addRelationJoin("LEFT", propertyName, alias);
  }

  /**
   * Add an INNER JOIN using a relation property name.
   * @see leftJoinRelation
   */
  innerJoinRelation(propertyName: string, alias: string): this {
    return this.addRelationJoin("INNER", propertyName, alias);
  }

  /**
   * LEFT JOIN using a relation property name and auto-SELECT all joined columns.
   *
   * @example
   * ```ts
   * em.createQueryBuilder(Post, "p")
   *   .leftJoinRelationAndSelect("author", "u")
   *   .getRawMany();
   * ```
   */
  leftJoinRelationAndSelect(propertyName: string, alias: string): this {
    return this.addRelationJoin("LEFT", propertyName, alias, true);
  }

  /**
   * INNER JOIN using a relation property name and auto-SELECT all joined columns.
   * @see leftJoinRelationAndSelect
   */
  innerJoinRelationAndSelect(propertyName: string, alias: string): this {
    return this.addRelationJoin("INNER", propertyName, alias, true);
  }

  protected addJoin(
    type: "LEFT" | "INNER" | "RIGHT",
    table: string,
    alias: string,
    condition: Sql | string,
  ): this {
    const cond =
      typeof condition === "string" ? sql`${raw(condition)}` : condition;
    this.joinClauses.push({ type, table, alias, condition: cond });
    return this;
  }

  protected addEntityJoin<U>(
    type: "LEFT" | "INNER" | "RIGHT",
    entity: ClazzType<U>,
    alias: string,
    onBuilder: (join: JoinOnBuilder) => JoinOnBuilder,
    andSelect = false,
  ): this {
    const resolver = this.emInternals.resolver;
    if (!resolver) {
      throw new OrmError(
        OrmErrorCode.ENTITY_METADATA_NOT_FOUND,
        `EntityManager not connected. Cannot resolve entity metadata for ${entity.name}.`,
      );
    }
    const metadata = resolver.resolveEntityMetadata(entity);
    if (!metadata) {
      throw new OrmError(
        OrmErrorCode.ENTITY_METADATA_NOT_FOUND,
        `Entity metadata not found for ${entity.name}. Did you register the entity?`,
      );
    }

    const propToCol = this.buildPropertyToColumnMapFromMetadata(metadata);
    this.aliasRegistry.set(alias, {
      entity,
      tableName: metadata.name,
      propertyToColumnMap: propToCol,
    });

    const builder = new JoinOnBuilder((ref) => this.resolveColumn(ref));
    onBuilder(builder);
    const condition = builder.build();

    this.joinClauses.push({
      type,
      table: metadata.name,
      alias,
      condition,
      joinedEntity: entity,
    });

    if (andSelect) {
      // Plain entity join: try to match the joined entity to a relation on
      // the root so getMany()/getOne() can nest it; null when unmatched.
      const relInfo = this.resolveRelationToEntity(this.entity, entity);
      this.appendJoinedColumnsToSelect(alias, propToCol, {
        sourceAlias: this.alias,
        property: relInfo?.property ?? null,
        kind: relInfo?.kind ?? "many-to-one",
        entity,
      });
    }

    return this;
  }

  /**
   * #370: find the relation property on `sourceEntity` whose target is
   * `joinedEntity`. Used by entity-based *AndSelect joins (which carry no
   * relation property of their own) to locate the nesting target.
   */
  protected resolveRelationToEntity(
    sourceEntity: ClazzType<any>,
    joinedEntity: ClazzType<any>,
  ): {
    property: string;
    kind: "many-to-one" | "one-to-one" | "one-to-many";
  } | null {
    const resolver = this.emInternals.resolver;
    if (!resolver) return null;

    const m2o = resolver
      .resolveManyToOneMetadata(sourceEntity)
      .find((r: any) => r.getMappingEntity?.() === joinedEntity);
    if (m2o) return { property: (m2o as any).columnName, kind: "many-to-one" };

    const o2o = resolver
      .resolveOneToOneMetadata(sourceEntity)
      .find(
        (r: any) =>
          (r.getRelatedEntity ?? r.getMappingEntity)?.() === joinedEntity,
      );
    if (o2o) return { property: (o2o as any).propertyKey, kind: "one-to-one" };

    const o2m = resolver
      .resolveOneToManyMetadata(sourceEntity)
      .find((r: any) => r.getRelatedEntity?.() === joinedEntity);
    if (o2m) return { property: (o2m as any).propertyKey, kind: "one-to-many" };

    return null;
  }

  /**
   * Append all columns from a joined entity to the SELECT clause.
   * Used by *AndSelect methods.
   *
   * #370: every joined column is aliased as `alias_column`
   * (`` `u`.`id` AS `u_id` ``) so joined values can never clobber
   * same-named root columns when the driver objectifies rows. When a
   * `selection` descriptor is supplied, the columns also hydrate into the
   * relation property on getMany()/getOne() entity results.
   */
  protected appendJoinedColumnsToSelect(
    alias: string,
    propToCol: Map<string, string>,
    selection?: {
      sourceAlias: string;
      property: string | null;
      kind: "many-to-one" | "one-to-one" | "one-to-many";
      entity: ClazzType<any>;
    },
  ): void {
    const cols: string[] = [];
    const seen = new Set<string>();
    for (const [, dbCol] of propToCol) {
      if (seen.has(dbCol)) continue;
      seen.add(dbCol);
      cols.push(
        `${this.em.wrap(alias)}.${this.em.wrap(dbCol)} AS ${this.em.wrap(`${alias}_${dbCol}`)}`,
      );
    }
    if (cols.length === 0) return;

    if (this.selectColumns === "*") {
      // Expand main entity's * to explicit columns, then append joined
      this.selectColumns = [...this.expandRootSelectColumns(), ...cols];
    } else {
      (this.selectColumns as string[]).push(...cols);
    }

    if (selection) {
      this.joinedSelections.push({ alias, ...selection });
    }
  }

  /**
   * #370: expand the root `alias.*` into explicit `alias_col`-aliased
   * columns so root and joined columns can never collide in the row object
   * (e.g. a root FK `user_id` vs. a joined `` `user`.`id` AS `user_id` ``).
   * Falls back to plain `alias.*` for inheritance queries, whose SELECT
   * assembly manages its own column lists.
   */
  private expandRootSelectColumns(): string[] {
    const star = [`${this.em.wrap(this.alias)}.*`];
    if (
      this.isPolymorphicQuery ||
      this.tptSelectColumns ||
      this.tptPolymorphicSelectColumns?.length ||
      this.tpcFromSql
    ) {
      return star;
    }
    const resolver = this.emInternals.resolver;
    const rootMeta = resolver?.resolveEntityMetadata?.(this.entity);
    if (!rootMeta) return star;

    const propToCol = this.buildPropertyToColumnMapFromMetadata(rootMeta);
    const cols: string[] = [];
    const seen = new Set<string>();
    for (const [, dbCol] of propToCol) {
      if (seen.has(dbCol)) continue;
      seen.add(dbCol);
      cols.push(
        `${this.em.wrap(this.alias)}.${this.em.wrap(dbCol)} AS ${this.em.wrap(`${this.alias}_${dbCol}`)}`,
      );
    }
    if (cols.length === 0) return star;
    this.rootSelectExpanded = true;
    return cols;
  }

  protected addRelationJoin(
    type: "LEFT" | "INNER" | "RIGHT",
    propertyName: string,
    alias: string,
    andSelect = false,
  ): this {
    const resolver = this.emInternals.resolver;
    if (!resolver) {
      throw new OrmError(
        OrmErrorCode.ENTITY_METADATA_NOT_FOUND,
        `EntityManager not connected. Cannot resolve relation metadata.`,
      );
    }

    // Check source entity — may be a joined entity if propertyName is "alias.property"
    let sourceAlias = this.alias;
    let sourceEntity = this.entity as ClazzType<any>;
    let relationProp = propertyName;

    const dotIndex = propertyName.indexOf(".");
    if (dotIndex > 0) {
      sourceAlias = propertyName.substring(0, dotIndex);
      relationProp = propertyName.substring(dotIndex + 1);
      const entry = this.aliasRegistry.get(sourceAlias);
      if (entry) {
        sourceEntity = entry.entity;
      }
    }

    // Try ManyToOne
    const manyToOnes = resolver.resolveManyToOneMetadata(sourceEntity);
    const m2oRel = manyToOnes.find((r) => r.columnName === relationProp);
    if (m2oRel) {
      return this.addRelationJoinFromManyToOne(type, m2oRel, alias, sourceAlias, resolver, andSelect);
    }

    // Try OneToMany
    const oneToManys = resolver.resolveOneToManyMetadata(sourceEntity);
    const o2mRel = oneToManys.find((r) => r.propertyKey === relationProp);
    if (o2mRel) {
      return this.addRelationJoinFromOneToMany(type, o2mRel, alias, sourceAlias, sourceEntity, resolver, andSelect);
    }

    // Try OneToOne
    const oneToOnes = resolver.resolveOneToOneMetadata(sourceEntity);
    const o2oRel = oneToOnes.find((r) => r.propertyKey === relationProp);
    if (o2oRel) {
      return this.addRelationJoinFromOneToOne(type, o2oRel, alias, sourceAlias, resolver, andSelect);
    }

    throw new OrmError(
      OrmErrorCode.INVALID_QUERY,
      `No relation found for property "${relationProp}" on entity ${sourceEntity.name}. ` +
        `Available ManyToOne: [${manyToOnes.map((r) => r.columnName).join(", ")}], ` +
        `OneToMany: [${oneToManys.map((r) => r.propertyKey).join(", ")}], ` +
        `OneToOne: [${oneToOnes.map((r) => r.propertyKey).join(", ")}].`,
    );
  }

  protected addRelationJoinFromManyToOne(
    type: "LEFT" | "INNER" | "RIGHT",
    rel: any,
    alias: string,
    sourceAlias: string,
    resolver: RelationMetadataResolver,
    andSelect = false,
  ): this {
    const RelatedEntity = rel.getMappingEntity() as ClazzType<any>;
    const relatedMeta = resolver.resolveEntityMetadata(RelatedEntity);
    if (!relatedMeta) {
      throw new OrmError(
        OrmErrorCode.ENTITY_METADATA_NOT_FOUND,
        `Entity metadata not found for ${RelatedEntity.name}.`,
      );
    }

    // FK column on source entity
    const sourceEntry = this.aliasRegistry.get(sourceAlias);
    const joinColumn = sourceEntry
      ? (sourceEntry.propertyToColumnMap.get(rel.joinColumn ?? `${rel.columnName}Id`) ?? rel.joinColumn ?? `${rel.columnName}_id`)
      : (rel.joinColumn ?? `${rel.columnName}_id`);

    // PK column on related entity
    const referencedColumn = rel.references ?? this.findPrimaryColumn(relatedMeta) ?? "id";

    // Register alias
    const propToCol = this.buildPropertyToColumnMapFromMetadata(relatedMeta);
    this.aliasRegistry.set(alias, {
      entity: RelatedEntity,
      tableName: relatedMeta.name,
      propertyToColumnMap: propToCol,
    });

    const left = `${this.em.wrap(sourceAlias)}.${this.em.wrap(joinColumn)}`;
    const right = `${this.em.wrap(alias)}.${this.em.wrap(referencedColumn)}`;
    const condition = Conditions.compareColumns(left, "=", right);

    this.joinClauses.push({
      type,
      table: relatedMeta.name,
      alias,
      condition,
      joinedEntity: RelatedEntity,
    });
    if (andSelect)
      this.appendJoinedColumnsToSelect(alias, propToCol, {
        sourceAlias,
        property: rel.columnName,
        kind: "many-to-one",
        entity: RelatedEntity,
      });
    return this;
  }

  protected addRelationJoinFromOneToMany(
    type: "LEFT" | "INNER" | "RIGHT",
    rel: any,
    alias: string,
    sourceAlias: string,
    sourceEntity: ClazzType<any>,
    resolver: RelationMetadataResolver,
    andSelect = false,
  ): this {
    const RelatedEntity = rel.getRelatedEntity() as ClazzType<any>;
    const relatedMeta = resolver.resolveEntityMetadata(RelatedEntity);
    if (!relatedMeta) {
      throw new OrmError(
        OrmErrorCode.ENTITY_METADATA_NOT_FOUND,
        `Entity metadata not found for ${RelatedEntity.name}.`,
      );
    }

    // Find the ManyToOne on the related entity that maps back
    const relatedM2Os = resolver.resolveManyToOneMetadata(RelatedEntity);
    const reverseRel = relatedM2Os.find((r) => r.columnName === rel.mappedBy);

    const propToCol = this.buildPropertyToColumnMapFromMetadata(relatedMeta);

    // FK column on related entity
    let fkColumn: string;
    if (reverseRel?.joinColumn) {
      fkColumn = reverseRel.joinColumn;
    } else {
      // fallback: use mappedById from propToCol, or convention
      fkColumn = propToCol.get(`${rel.mappedBy}Id`) ?? `${rel.mappedBy}_id`;
    }

    // PK column on source entity
    const sourceMeta = resolver.resolveEntityMetadata(sourceEntity);
    const pk = sourceMeta ? this.findPrimaryColumn(sourceMeta) ?? "id" : "id";

    this.aliasRegistry.set(alias, {
      entity: RelatedEntity,
      tableName: relatedMeta.name,
      propertyToColumnMap: propToCol,
    });

    const left = `${this.em.wrap(sourceAlias)}.${this.em.wrap(pk)}`;
    const right = `${this.em.wrap(alias)}.${this.em.wrap(fkColumn)}`;
    const condition = Conditions.compareColumns(left, "=", right);

    this.joinClauses.push({
      type,
      table: relatedMeta.name,
      alias,
      condition,
      joinedEntity: RelatedEntity,
    });
    if (andSelect)
      this.appendJoinedColumnsToSelect(alias, propToCol, {
        sourceAlias,
        property: rel.propertyKey,
        kind: "one-to-many",
        entity: RelatedEntity,
      });
    return this;
  }

  protected addRelationJoinFromOneToOne(
    type: "LEFT" | "INNER" | "RIGHT",
    rel: any,
    alias: string,
    sourceAlias: string,
    resolver: RelationMetadataResolver,
    andSelect = false,
  ): this {
    const RelatedEntity = (rel.getRelatedEntity ?? rel.getMappingEntity)() as ClazzType<any>;
    const relatedMeta = resolver.resolveEntityMetadata(RelatedEntity);
    if (!relatedMeta) {
      throw new OrmError(
        OrmErrorCode.ENTITY_METADATA_NOT_FOUND,
        `Entity metadata not found for ${RelatedEntity.name}.`,
      );
    }

    const sourceEntry = this.aliasRegistry.get(sourceAlias);
    const joinColumn = sourceEntry
      ? (sourceEntry.propertyToColumnMap.get(rel.joinColumn ?? `${rel.propertyKey}Id`) ?? rel.joinColumn ?? `${rel.propertyKey}_id`)
      : (rel.joinColumn ?? `${rel.propertyKey}_id`);

    const referencedColumn = this.findPrimaryColumn(relatedMeta) ?? "id";

    const propToCol = this.buildPropertyToColumnMapFromMetadata(relatedMeta);
    this.aliasRegistry.set(alias, {
      entity: RelatedEntity,
      tableName: relatedMeta.name,
      propertyToColumnMap: propToCol,
    });

    const left = `${this.em.wrap(sourceAlias)}.${this.em.wrap(joinColumn)}`;
    const right = `${this.em.wrap(alias)}.${this.em.wrap(referencedColumn)}`;
    const condition = Conditions.compareColumns(left, "=", right);

    this.joinClauses.push({
      type,
      table: relatedMeta.name,
      alias,
      condition,
      joinedEntity: RelatedEntity,
    });
    if (andSelect)
      this.appendJoinedColumnsToSelect(alias, propToCol, {
        sourceAlias,
        property: rel.propertyKey,
        kind: "one-to-one",
        entity: RelatedEntity,
      });
    return this;
  }

  protected findPrimaryColumn(metadata: EntityScannerMetadata): string | null {
    const pk = metadata.columns.find(
      (c: ColumnMetadata) => c.options?.primary || (c.options as any)?.autoIncrement,
    );
    return pk?.name ?? null;
  }

  /**
   * Build a correlated EXISTS subquery for a relation.
   * Used by `whereHas()`, `whereNotHas()`.
   *
   * @returns A `Sql` fragment: `SELECT 1 FROM related_table WHERE correlation [AND ...]`
   */
  protected buildRelationExistsSubquery(
    propertyName: string,
    fn?: (subQb: SelectQueryBuilder<any, any>) => void,
  ): Sql {
    return this.buildRelationSubquery(propertyName, "exists", fn);
  }

  /**
   * Build a correlated COUNT subquery for a relation.
   * Used by `withCount()`.
   *
   * @returns A `Sql` fragment: `SELECT COUNT(*) FROM related_table WHERE correlation [AND ...]`
   */
  protected buildRelationCountSubquery(
    propertyName: string,
    fn?: (subQb: SelectQueryBuilder<any, any>) => void,
  ): Sql {
    return this.buildRelationSubquery(propertyName, "count", fn);
  }

  /**
   * Core helper: build a correlated subquery (EXISTS or COUNT) for a relation.
   */
  protected buildRelationSubquery(
    propertyName: string,
    mode: "exists" | "count",
    fn?: (subQb: SelectQueryBuilder<any, any>) => void,
  ): Sql {
    const resolver = this.emInternals.resolver;
    if (!resolver) {
      throw new OrmError(
        OrmErrorCode.ENTITY_METADATA_NOT_FOUND,
        `EntityManager not connected. Cannot resolve relation metadata.`,
      );
    }

    // Determine source
    let sourceAlias = this.alias;
    let sourceEntity = this.entity as ClazzType<any>;
    let relationProp = propertyName;

    const dotIndex = propertyName.indexOf(".");
    if (dotIndex > 0) {
      sourceAlias = propertyName.substring(0, dotIndex);
      relationProp = propertyName.substring(dotIndex + 1);
      const entry = this.aliasRegistry.get(sourceAlias);
      if (entry) sourceEntity = entry.entity;
    }

    // Try ManyToOne
    const manyToOnes = resolver.resolveManyToOneMetadata(sourceEntity);
    const m2oRel = manyToOnes.find((r) => r.columnName === relationProp);
    if (m2oRel) {
      return this.buildM2OSubquery(m2oRel, sourceAlias, resolver, mode, fn);
    }

    // Try OneToMany
    const oneToManys = resolver.resolveOneToManyMetadata(sourceEntity);
    const o2mRel = oneToManys.find((r) => r.propertyKey === relationProp);
    if (o2mRel) {
      return this.buildO2MSubquery(o2mRel, sourceAlias, sourceEntity, resolver, mode, fn);
    }

    // Try OneToOne
    const oneToOnes = resolver.resolveOneToOneMetadata(sourceEntity);
    const o2oRel = oneToOnes.find((r) => r.propertyKey === relationProp);
    if (o2oRel) {
      return this.buildO2OSubquery(o2oRel, sourceAlias, resolver, mode, fn);
    }

    throw new OrmError(
      OrmErrorCode.INVALID_QUERY,
      `No relation found for property "${relationProp}" on entity ${sourceEntity.name}. ` +
        `Available ManyToOne: [${manyToOnes.map((r) => r.columnName).join(", ")}], ` +
        `OneToMany: [${oneToManys.map((r) => r.propertyKey).join(", ")}], ` +
        `OneToOne: [${oneToOnes.map((r) => r.propertyKey).join(", ")}].`,
    );
  }

  private buildM2OSubquery(
    rel: any,
    sourceAlias: string,
    resolver: RelationMetadataResolver,
    mode: "exists" | "count",
    fn?: (subQb: SelectQueryBuilder<any, any>) => void,
  ): Sql {
    const RelatedEntity = rel.getMappingEntity() as ClazzType<any>;
    const relatedMeta = resolver.resolveEntityMetadata(RelatedEntity);
    if (!relatedMeta) {
      throw new OrmError(OrmErrorCode.ENTITY_METADATA_NOT_FOUND, `Entity metadata not found for ${RelatedEntity.name}.`);
    }

    const sourceEntry = this.aliasRegistry.get(sourceAlias);
    const joinColumn = sourceEntry
      ? (sourceEntry.propertyToColumnMap.get(rel.joinColumn ?? `${rel.columnName}Id`) ?? rel.joinColumn ?? `${rel.columnName}_id`)
      : (rel.joinColumn ?? `${rel.columnName}_id`);
    const referencedColumn = rel.references ?? this.findPrimaryColumn(relatedMeta) ?? "id";

    const innerAlias = `__sub_${rel.columnName}`;
    const selectExpr = mode === "exists" ? "1" : "COUNT(*)";

    const outerRef = `${this.em.wrap(sourceAlias)}.${this.em.wrap(joinColumn)}`;
    const innerRef = `${this.em.wrap(innerAlias)}.${this.em.wrap(referencedColumn)}`;

    const subQb = new SelectQueryBuilder<any>(RelatedEntity, innerAlias, this.em);
    subQb.propertyToColumnMap = this.buildPropertyToColumnMapFromMetadata(relatedMeta);
    subQb.aliasRegistry.set(innerAlias, {
      entity: RelatedEntity,
      tableName: relatedMeta.name,
      propertyToColumnMap: subQb.propertyToColumnMap,
    });
    subQb.dialectExpression = this.dialectExpression;
    subQb.withDeletedFlag = true; // subqueries don't auto-filter soft deletes
    subQb.withoutTenantScopeFlag = this.withoutTenantScopeFlag;

    subQb.whereClauses.push(Conditions.compareColumns(innerRef, "=", outerRef));
    if (fn) fn(subQb);

    this.appendTenantPredicate(subQb.whereClauses, RelatedEntity, innerAlias);

    const innerWhere = subQb.whereClauses.length > 0
      ? sql`WHERE ${join(subQb.whereClauses, " AND ")}`
      : sql``;

    return sql`SELECT ${raw(selectExpr)} FROM ${raw(this.em.wrapTable(relatedMeta.name))} AS ${raw(this.em.wrap(innerAlias))} ${innerWhere}`;
  }

  private buildO2MSubquery(
    rel: any,
    sourceAlias: string,
    sourceEntity: ClazzType<any>,
    resolver: RelationMetadataResolver,
    mode: "exists" | "count",
    fn?: (subQb: SelectQueryBuilder<any, any>) => void,
  ): Sql {
    const RelatedEntity = rel.getRelatedEntity() as ClazzType<any>;
    const relatedMeta = resolver.resolveEntityMetadata(RelatedEntity);
    if (!relatedMeta) {
      throw new OrmError(OrmErrorCode.ENTITY_METADATA_NOT_FOUND, `Entity metadata not found for ${RelatedEntity.name}.`);
    }

    const relatedM2Os = resolver.resolveManyToOneMetadata(RelatedEntity);
    const reverseRel = relatedM2Os.find((r) => r.columnName === rel.mappedBy);
    const propToCol = this.buildPropertyToColumnMapFromMetadata(relatedMeta);

    let fkColumn: string;
    if (reverseRel?.joinColumn) {
      fkColumn = reverseRel.joinColumn;
    } else {
      fkColumn = propToCol.get(`${rel.mappedBy}Id`) ?? `${rel.mappedBy}_id`;
    }

    const sourceMeta = resolver.resolveEntityMetadata(sourceEntity);
    const pk = sourceMeta ? this.findPrimaryColumn(sourceMeta) ?? "id" : "id";

    const innerAlias = `__sub_${rel.propertyKey}`;
    const selectExpr = mode === "exists" ? "1" : "COUNT(*)";

    const outerRef = `${this.em.wrap(sourceAlias)}.${this.em.wrap(pk)}`;
    const innerRef = `${this.em.wrap(innerAlias)}.${this.em.wrap(fkColumn)}`;

    const subQb = new SelectQueryBuilder<any>(RelatedEntity, innerAlias, this.em);
    subQb.propertyToColumnMap = propToCol;
    subQb.aliasRegistry.set(innerAlias, {
      entity: RelatedEntity,
      tableName: relatedMeta.name,
      propertyToColumnMap: propToCol,
    });
    subQb.dialectExpression = this.dialectExpression;
    subQb.withDeletedFlag = true;
    subQb.withoutTenantScopeFlag = this.withoutTenantScopeFlag;

    subQb.whereClauses.push(Conditions.compareColumns(innerRef, "=", outerRef));
    if (fn) fn(subQb);

    this.appendTenantPredicate(subQb.whereClauses, RelatedEntity, innerAlias);

    const innerWhere = subQb.whereClauses.length > 0
      ? sql`WHERE ${join(subQb.whereClauses, " AND ")}`
      : sql``;

    return sql`SELECT ${raw(selectExpr)} FROM ${raw(this.em.wrapTable(relatedMeta.name))} AS ${raw(this.em.wrap(innerAlias))} ${innerWhere}`;
  }

  private buildO2OSubquery(
    rel: any,
    sourceAlias: string,
    resolver: RelationMetadataResolver,
    mode: "exists" | "count",
    fn?: (subQb: SelectQueryBuilder<any, any>) => void,
  ): Sql {
    const RelatedEntity = (rel.getRelatedEntity ?? rel.getMappingEntity)() as ClazzType<any>;
    const relatedMeta = resolver.resolveEntityMetadata(RelatedEntity);
    if (!relatedMeta) {
      throw new OrmError(OrmErrorCode.ENTITY_METADATA_NOT_FOUND, `Entity metadata not found for ${RelatedEntity.name}.`);
    }

    const sourceEntry = this.aliasRegistry.get(sourceAlias);
    const joinColumn = sourceEntry
      ? (sourceEntry.propertyToColumnMap.get(rel.joinColumn ?? `${rel.propertyKey}Id`) ?? rel.joinColumn ?? `${rel.propertyKey}_id`)
      : (rel.joinColumn ?? `${rel.propertyKey}_id`);
    const referencedColumn = this.findPrimaryColumn(relatedMeta) ?? "id";

    const innerAlias = `__sub_${rel.propertyKey}`;
    const selectExpr = mode === "exists" ? "1" : "COUNT(*)";

    const outerRef = `${this.em.wrap(sourceAlias)}.${this.em.wrap(joinColumn)}`;
    const innerRef = `${this.em.wrap(innerAlias)}.${this.em.wrap(referencedColumn)}`;

    const subQb = new SelectQueryBuilder<any>(RelatedEntity, innerAlias, this.em);
    subQb.propertyToColumnMap = this.buildPropertyToColumnMapFromMetadata(relatedMeta);
    subQb.aliasRegistry.set(innerAlias, {
      entity: RelatedEntity,
      tableName: relatedMeta.name,
      propertyToColumnMap: subQb.propertyToColumnMap,
    });
    subQb.dialectExpression = this.dialectExpression;
    subQb.withDeletedFlag = true;
    subQb.withoutTenantScopeFlag = this.withoutTenantScopeFlag;

    subQb.whereClauses.push(Conditions.compareColumns(innerRef, "=", outerRef));
    if (fn) fn(subQb);

    this.appendTenantPredicate(subQb.whereClauses, RelatedEntity, innerAlias);

    const innerWhere = subQb.whereClauses.length > 0
      ? sql`WHERE ${join(subQb.whereClauses, " AND ")}`
      : sql``;

    return sql`SELECT ${raw(selectExpr)} FROM ${raw(this.em.wrapTable(relatedMeta.name))} AS ${raw(this.em.wrap(innerAlias))} ${innerWhere}`;
  }

  // ── ORDER BY / GROUP BY / HAVING ────────────────────────

  /**
   * Set ORDER BY with type-safe column references.
   *
   * @example
   * ```ts
   * qb.orderBy({ createdAt: "DESC", name: "ASC" })
   * ```
   */
  orderBy(spec: OrderBySpec<T>): this;
  /**
   * QueryDSL-style: accept an {@link OrderExpression} from
   * `u.col.asc()` / `.desc().nullsLast()` etc. Replaces the existing
   * ORDER BY list so a single call can re-seed ordering.
   */
  orderBy(spec: OrderExpression): this;
  orderBy(spec: OrderBySpec<T> | OrderExpression): this {
    if (isOrderExpression(spec)) {
      this.orderByClauses = [];
      return this.pushOrderExpression(spec);
    }
    for (const key in spec) {
      const direction = (spec as OrderBySpec<T>)[key as ColumnOf<T>];
      if (direction) {
        this.orderByClauses.push({
          column: this.col(key),
          direction,
        });
      }
    }
    return this;
  }

  /**
   * Add a single ORDER BY clause. Supports `"alias.property"` notation,
   * an {@link OrderExpression} from `col.asc()/.desc().nullsLast()`, or
   * a {@link ScalarExpression} carrying parameter bindings (e.g.
   * `Expressions.dateTrunc(col, "week")`).
   */
  addOrderBy(expr: OrderExpression): this;
  addOrderBy(expr: ScalarExpression, direction: "ASC" | "DESC"): this;
  addOrderBy(column: ColumnExpression, direction: "ASC" | "DESC"): this;
  addOrderBy(column: ColumnOf<T>, direction: "ASC" | "DESC"): this;
  addOrderBy(column: string, direction: "ASC" | "DESC"): this;
  addOrderBy(
    columnOrExpr: string | OrderExpression | ScalarExpression | ColumnExpression,
    direction?: "ASC" | "DESC",
  ): this {
    if (isOrderExpression(columnOrExpr)) {
      return this.pushOrderExpression(columnOrExpr);
    }
    if (
      columnOrExpr !== null &&
      typeof columnOrExpr === "object" &&
      (columnOrExpr as { __isScalarExpression?: unknown }).__isScalarExpression === true
    ) {
      const rendered = (columnOrExpr as ScalarExpression).renderer(
        (ref) => this.resolveColumn(ref),
        this.dialectExpression,
      );
      this.orderByClauses.push({
        column: rendered,
        direction: direction!,
      });
      return this;
    }
    if (
      columnOrExpr !== null &&
      typeof columnOrExpr === "object" &&
      (columnOrExpr as { __isColumnExpression?: unknown }).__isColumnExpression === true
    ) {
      this.orderByClauses.push({
        column: this.resolveColumn(
          (columnOrExpr as { toString(): string }).toString(),
        ),
        direction: direction!,
      });
      return this;
    }
    this.orderByClauses.push({
      column: this.resolveColumn(columnOrExpr as string),
      direction: direction!,
    });
    return this;
  }

  /**
   * @internal Translate an {@link OrderExpression} (which may carry either
   * a deferred column ref or a pre-rendered aggregate fragment) into an
   * entry on `orderByClauses`.
   */
  private pushOrderExpression(expr: OrderExpression): this {
    let column: string | Sql;
    if (expr.renderer) {
      column = expr.renderer(
        (ref) => this.resolveColumn(ref),
        this.dialectExpression,
      );
    } else if (expr.isRaw) {
      column = expr.ref;
    } else {
      column = this.resolveColumn(expr.ref);
    }
    this.orderByClauses.push({
      column,
      direction: expr.direction,
      nulls: expr.nulls,
      isRaw: expr.isRaw,
    });
    return this;
  }

  /**
   * Set GROUP BY columns. Supports `"alias.property"` notation,
   * raw `Sql` fragments (their bindings are preserved), and
   * {@link ScalarExpression} / {@link ColumnExpression} instances —
   * convenient when grouping by the same derived expression used in
   * SELECT (e.g. `Expressions.dateTrunc(col, "week")`).
   */
  groupBy(columns: ColumnOf<T>[]): this;
  groupBy(columns: string[]): this;
  groupBy(
    columns: Array<string | Sql | ColumnExpression | ScalarExpression>,
  ): this;
  groupBy(
    columns: Array<string | Sql | ColumnExpression | ScalarExpression>,
  ): this {
    this.groupByCols = columns.map((c) =>
      this.renderGroupByEntry(c as unknown),
    );
    return this;
  }

  /** @internal Translate one GROUP BY entry into a parameterized Sql fragment. */
  private renderGroupByEntry(entry: unknown): Sql {
    if (typeof entry === "string") {
      return sql`${raw(this.resolveColumn(entry))}`;
    }
    if (entry !== null && typeof entry === "object") {
      if ((entry as { __isScalarExpression?: unknown }).__isScalarExpression === true) {
        return (entry as {
          renderer: (r: ColumnResolver, d?: any) => Sql;
        }).renderer((ref) => this.resolveColumn(ref), this.dialectExpression);
      }
      if ((entry as { __isColumnExpression?: unknown }).__isColumnExpression === true) {
        return sql`${raw(this.resolveColumn((entry as { toString(): string }).toString()))}`;
      }
      if (typeof (entry as { sql?: unknown }).sql === "string") {
        return entry as Sql;
      }
    }
    throw new OrmError(
      OrmErrorCode.INVALID_QUERY,
      `groupBy: unsupported entry of type ${typeof entry}`,
    );
  }

  /**
   * Add HAVING conditions (used with GROUP BY).
   *
   * Accepts raw SQL fragments or any QueryDSL condition — typically an
   * {@link AggregateCondition} from `u.id.count().gt(10)`. Column references
   * inside the condition are resolved through the alias registry so property
   * names honor NamingStrategy.
   */
  having(condition: Sql): this;
  having(condition: ConditionLike): this;
  having(condition: Sql | ConditionLike): this {
    if (isConditionLike(condition)) {
      this.havingClauses.push(
        condition.resolve(
          (ref) => this.resolveColumn(ref),
          this.dialectExpression,
        ),
      );
      return this;
    }
    this.havingClauses.push(condition);
    return this;
  }

  // ── LIMIT / OFFSET ──────────────────────────────────────

  /**
   * Set the maximum number of rows to return.
   */
  limit(count: number): this {
    this.limitValue = count;
    return this;
  }

  /**
   * Set the number of rows to skip.
   */
  offset(count: number): this {
    this.offsetValue = count;
    return this;
  }

  /**
   * Convenience: set both skip and take.
   */
  skip(count: number): this {
    this.offsetValue = count;
    return this;
  }

  take(count: number): this {
    this.limitValue = count;
    return this;
  }

  // ── LOCK / SOFT DELETE ──────────────────────────────────

  /**
   * Add FOR UPDATE lock.
   */
  forUpdate(): this {
    this.lockClause = "FOR UPDATE";
    return this;
  }

  /**
   * Add FOR SHARE lock.
   */
  forShare(): this {
    const internals = this.emInternals._ctx;
    this.lockClause = internals.isMySqlFamily()
      ? "LOCK IN SHARE MODE"
      : "FOR SHARE";
    return this;
  }

  /**
   * Add FOR UPDATE NOWAIT lock (MySQL 8.0+, PostgreSQL 9.5+).
   * Fails immediately if rows are already locked.
   */
  forUpdateNowait(): this {
    this.lockClause = "FOR UPDATE NOWAIT";
    return this;
  }

  /**
   * Add FOR UPDATE SKIP LOCKED lock (MySQL 8.0+, PostgreSQL 9.5+).
   * Skips rows that are already locked by other transactions.
   */
  forUpdateSkipLocked(): this {
    this.lockClause = "FOR UPDATE SKIP LOCKED";
    return this;
  }

  /**
   * Add FOR SHARE NOWAIT lock (MySQL 8.0+, PostgreSQL 9.5+).
   */
  forShareNowait(): this {
    const internals = this.emInternals._ctx;
    this.lockClause = internals.isMySqlFamily()
      ? "LOCK IN SHARE MODE NOWAIT"
      : "FOR SHARE NOWAIT";
    return this;
  }

  /**
   * Add FOR SHARE SKIP LOCKED lock (MySQL 8.0+, PostgreSQL 9.5+).
   */
  forShareSkipLocked(): this {
    const internals = this.emInternals._ctx;
    this.lockClause = internals.isMySqlFamily()
      ? "LOCK IN SHARE MODE SKIP LOCKED"
      : "FOR SHARE SKIP LOCKED";
    return this;
  }

  // ── INDEX HINTS ─────────────────────────────────────────

  /**
   * MySQL: USE INDEX (indexName)
   * Suggests an index for the optimizer to consider.
   */
  useIndex(indexName: string): this {
    this.indexHints.push({ type: "USE", indexName });
    return this;
  }

  /**
   * MySQL: FORCE INDEX (indexName)
   * Forces the optimizer to use a specific index.
   */
  forceIndex(indexName: string): this {
    this.indexHints.push({ type: "FORCE", indexName });
    return this;
  }

  /**
   * MySQL: IGNORE INDEX (indexName)
   * Tells the optimizer to ignore a specific index.
   */
  ignoreIndex(indexName: string): this {
    this.indexHints.push({ type: "IGNORE", indexName });
    return this;
  }

  /**
   * PostgreSQL: pg_hint_plan style hint comment.
   * Added as a hint comment before SELECT.
   *
   * @example
   * ```ts
   * qb.hint("IndexScan(o idx_order_date)")
   * ```
   */
  hint(hintText: string): this {
    this.pgHints.push(hintText);
    return this;
  }

  /**
   * Include soft-deleted entities in results.
   */
  withDeleted(): this {
    this.withDeletedFlag = true;
    return this;
  }

  /**
   * Disable the automatic tenant predicate injection under the
   * `"tenant_column"` multi-tenancy strategy.
   *
   * By default, queries built against tenant-scoped entities are filtered by
   * `tenant_id = <currentTenant>`. Call this opt-out when you genuinely need
   * cross-tenant visibility (admin dashboards, background jobs, data migration).
   *
   * No-op when the strategy is not `"tenant_column"` or the entity is
   * `@NonTenantEntity()`. For context-wide opt-out use
   * `MetadataContext.runUnscoped()`.
   */
  withoutTenantScope(): this {
    this.withoutTenantScopeFlag = true;
    return this;
  }

  // ── VALIDATION ──────────────────────────────────────────

  /**
   * Attach a **row-level** validator. Each row returned by `getMany()` /
   * `getOne()` is passed through this validator before being returned.
   *
   * Accepts:
   * - A plain function: `(row) => row` (throw to reject)
   * - A zod schema (or anything with a `.parse()` method)
   *
   * By default, no validator is attached — zero overhead.
   *
   * @example
   * ```ts
   * // With zod
   * import { z } from "zod";
   * const UserRow = z.object({ id: z.number(), name: z.string() });
   *
   * const users = await em
   *   .createQueryBuilder(User, "u")
   *   .select(["id", "name"])
   *   .validate(UserRow)
   *   .getMany();  // throws ZodError if any row doesn't match
   *
   * // With a plain function
   * .validate((row) => {
   *   if (!row.name) throw new Error("name is required");
   *   return row;
   * })
   * ```
   */
  validate(validator: RowValidator<TResult>): this {
    this.rowValidator = validator;
    return this;
  }

  /**
   * Type-inferred schema-validated result — a Zod / Valibot / Effect
   * schema (anything with a `.parse(data)` method) is attached as the
   * row validator AND the query builder's `TResult` type narrows to
   * the schema's inferred output type.
   *
   * Combines `.validate(schema)` with a type-level reshaping — the
   * caller no longer needs to carry a separate generic for the SELECT
   * projection.
   *
   * @example
   * ```ts
   * import { z } from "zod";
   *
   * const UserRow = z.object({ id: z.number(), name: z.string() });
   *
   * const rows = await em
   *   .createQueryBuilder(User, "u")
   *   .select(["id", "name"])
   *   .selectSchema(UserRow)
   *   .getMany();
   * //    ^? Array<{ id: number; name: string }>   — inferred from UserRow
   * ```
   *
   * @remarks
   * The SELECT list is untouched — the caller is responsible for
   * projecting a compatible shape (e.g. via `.select([...])` or
   * `.as("alias")` projections). This method purely wires runtime
   * validation plus type inference.
   */
  selectSchema<TSchema extends { parse(data: unknown): unknown }>(
    schema: TSchema,
  ): SelectQueryBuilder<
    T,
    TSchema extends { parse(data: unknown): infer O } ? O : never
  > {
    this.rowValidator = schema as unknown as RowValidator<TResult>;
    return this as unknown as SelectQueryBuilder<
      T,
      TSchema extends { parse(data: unknown): infer O } ? O : never
    >;
  }

  /**
   * Attach an **array-level** validator. The entire result array is passed
   * through this validator before being returned from `getMany()`.
   *
   * Accepts:
   * - A plain function: `(rows) => rows` (throw to reject)
   * - A zod array schema (or anything with a `.parse()` method)
   *
   * @example
   * ```ts
   * import { z } from "zod";
   * const UsersArray = z.array(z.object({ id: z.number(), name: z.string() }));
   *
   * const users = await qb
   *   .select(["id", "name"])
   *   .validateArray(UsersArray)
   *   .getMany();
   * ```
   */
  validateArray(validator: ArrayValidator<TResult>): this {
    this.arrayValidatorFn = validator;
    return this;
  }

  // ── CONDITIONAL / COMPOSABLE ─────────────────────────────

  /**
   * Conditionally apply query modifications.
   *
   * Eliminates `if/else` blocks outside the query chain. When `condition`
   * is truthy (or returns truthy for lazy evaluation), `fn` is called.
   * Otherwise `elseFn` is called if provided. Always returns `this`.
   *
   * @example
   * ```ts
   * const users = await repo.createQueryBuilder("u")
   *   .when(!!searchName, qb => qb.where("name", "LIKE", `%${searchName}%`))
   *   .when(onlyActive, qb => qb.where("status", "active"),
   *                     qb => qb.withDeleted())
   *   .getMany();
   * ```
   */
  when(
    condition: boolean | (() => boolean),
    fn: (qb: this) => void,
    elseFn?: (qb: this) => void,
  ): this {
    const result = typeof condition === "function" ? condition() : condition;
    if (result) fn(this);
    else if (elseFn) elseFn(this);
    return this;
  }

  /**
   * Apply a composable query transform function.
   *
   * Use `pipe()` to extract reusable query logic into standalone functions
   * and compose them in a fluent chain.
   *
   * @example
   * ```ts
   * function withPagination<T>(page: number, size: number) {
   *   return (qb: SelectQueryBuilder<T>) =>
   *     qb.offset((page - 1) * size).limit(size);
   * }
   *
   * const users = await repo.createQueryBuilder("u")
   *   .pipe(withPagination(2, 20))
   *   .getMany();
   * ```
   */
  pipe(fn: (qb: this) => this): this {
    return fn(this);
  }

  /**
   * Add a parenthesized group of AND conditions.
   *
   * All conditions inside the group are combined with AND, then the whole
   * group is appended to the existing WHERE with AND semantics.
   *
   * @example
   * ```ts
   * qb.where("active", true)
   *   .andWhereGroup(g => g
   *     .where("age", ">=", 18)
   *     .where("role", "user")
   *   )
   * // WHERE "active" = true AND ("age" >= 18 AND "role" = 'user')
   * ```
   */
  andWhereGroup(fn: (group: WhereGroupBuilder<T>) => void): this {
    const group = new WhereGroupBuilder<T>(
      (ref) => this.resolveColumn(ref),
      (id) => this.em.wrap(id),
      this.dialectExpression,
    );
    fn(group);
    this.whereClauses.push(group.build());
    return this;
  }

  /**
   * Add a parenthesized group of conditions with OR semantics.
   *
   * All conditions inside the group are combined with AND. The resulting
   * group is OR-ed with the existing WHERE conditions.
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
  orWhereGroup(fn: (group: WhereGroupBuilder<T>) => void): this {
    const group = new WhereGroupBuilder<T>(
      (ref) => this.resolveColumn(ref),
      (id) => this.em.wrap(id),
      this.dialectExpression,
    );
    fn(group);
    const groupSql = group.build();
    if (this.whereClauses.length === 0) {
      this.whereClauses.push(groupSql);
    } else {
      const existing =
        this.whereClauses.length === 1
          ? this.whereClauses[0]
          : Conditions.and(this.whereClauses);
      this.whereClauses = [Conditions.or([existing, groupSql])];
    }
    return this;
  }

  // ── RELATION-AWARE QUERIES ─────────────────────────────

  /**
   * Filter entities that have at least one related entity matching the condition.
   *
   * Generates `WHERE EXISTS (SELECT 1 FROM related_table WHERE correlation AND ...)`.
   * Resolves relation metadata automatically from `@ManyToOne`, `@OneToMany`, `@OneToOne`.
   *
   * @param relation - Property name of the relation on the entity (e.g., "comments", "author")
   * @param fn - Optional callback to add extra conditions on the related entity
   *
   * @example
   * ```ts
   * // Posts that have at least one comment
   * qb.whereHas("comments").getMany();
   *
   * // Posts that have recent comments
   * qb.whereHas("comments", sub =>
   *   sub.where("createdAt", ">=", sevenDaysAgo)
   * ).getMany();
   * ```
   */
  whereHas(
    relation: string,
    fn?: (subQb: SelectQueryBuilder<any, any>) => void,
  ): this {
    const subSql = this.buildRelationExistsSubquery(relation, fn);
    this.whereClauses.push(Conditions.exists(sql`(${subSql})`));
    return this;
  }

  /**
   * Filter entities that have NO related entities matching the condition.
   *
   * Generates `WHERE NOT EXISTS (SELECT 1 FROM related_table WHERE ...)`.
   *
   * @example
   * ```ts
   * // Posts without any comments
   * qb.whereNotHas("comments").getMany();
   * ```
   */
  whereNotHas(
    relation: string,
    fn?: (subQb: SelectQueryBuilder<any, any>) => void,
  ): this {
    const subSql = this.buildRelationExistsSubquery(relation, fn);
    this.whereClauses.push(Conditions.notExists(sql`(${subSql})`));
    return this;
  }

  /**
   * Add a relation count as a scalar subquery in the SELECT clause.
   *
   * @param relation - Relation property name
   * @param alias - Column alias for the count (default: `${relation}_count`)
   * @param fn - Optional callback to filter which related entities are counted
   *
   * @example
   * ```ts
   * const users = await em.createQueryBuilder(User, "u")
   *   .withCount("posts", "postCount")
   *   .withCount("posts", "activePostCount", sub => sub.where("status", "published"))
   *   .getRawMany();
   * ```
   */
  withCount(
    relation: string,
    alias?: string,
    fn?: (subQb: SelectQueryBuilder<any, any>) => void,
  ): this {
    const countSql = this.buildRelationCountSubquery(relation, fn);
    const colAlias = alias ?? `${relation}_count`;
    this.selectExpressions.push(
      sql`(${countSql}) AS ${raw(this.em.wrap(colAlias))}`,
    );
    return this;
  }

  /**
   * Shorthand for `leftJoinRelationAndSelect(relation, alias)`.
   *
   * Loads a relation via LEFT JOIN and includes all its columns in the result.
   *
   * @example
   * ```ts
   * qb.loadRelation("author").loadRelation("comments").getMany();
   * ```
   */
  loadRelation(relation: string, alias?: string): this {
    return this.leftJoinRelationAndSelect(relation, alias ?? relation);
  }

  // ── SUBQUERY INTEGRATION ───────────────────────────────

  /**
   * Add `WHERE column IN (subquery)` using a type-safe SelectQueryBuilder.
   *
   * @example
   * ```ts
   * const activeUserIds = em.createQueryBuilder(User, "u2")
   *   .select(["id"])
   *   .where("status", "active");
   *
   * const posts = await em.createQueryBuilder(Post, "p")
   *   .whereInSubquery("authorId", activeUserIds)
   *   .getMany();
   * ```
   */
  whereInSubquery(
    column: ColumnOf<T>,
    subQb: SelectQueryBuilder<any, any>,
  ): this;
  whereInSubquery(
    column: string,
    subQb: SelectQueryBuilder<any, any>,
  ): this;
  whereInSubquery(
    column: string,
    subQb: SelectQueryBuilder<any, any>,
  ): this {
    const qualified = this.resolveColumn(column);
    const subSql = subQb.toSql();
    this.whereClauses.push(
      Conditions.inSubquery(qualified, sql`(${subSql})`),
    );
    return this;
  }

  /**
   * Add `WHERE NOT IN (subquery)`.
   */
  whereNotInSubquery(
    column: ColumnOf<T>,
    subQb: SelectQueryBuilder<any, any>,
  ): this;
  whereNotInSubquery(
    column: string,
    subQb: SelectQueryBuilder<any, any>,
  ): this;
  whereNotInSubquery(
    column: string,
    subQb: SelectQueryBuilder<any, any>,
  ): this {
    const qualified = this.resolveColumn(column);
    const subSql = subQb.toSql();
    this.whereClauses.push(
      Conditions.notInSubquery(qualified, sql`(${subSql})`),
    );
    return this;
  }

  /**
   * Add `WHERE EXISTS (subquery)` using a SelectQueryBuilder.
   *
   * @example
   * ```ts
   * const activePosts = em.createQueryBuilder(Post, "p2")
   *   .select(["id"])
   *   .where(sql`"p2"."author_id" = "u"."id"`);
   *
   * const users = await em.createQueryBuilder(User, "u")
   *   .whereExistsSubquery(activePosts)
   *   .getMany();
   * ```
   */
  whereExistsSubquery(subQb: SubqueryInput): this {
    const subSql = this.resolveSubquery(subQb).toSql();
    this.whereClauses.push(Conditions.exists(sql`(${subSql})`));
    return this;
  }

  /**
   * Add `WHERE NOT EXISTS (subquery)`.
   */
  whereNotExistsSubquery(subQb: SubqueryInput): this {
    const subSql = this.resolveSubquery(subQb).toSql();
    this.whereClauses.push(Conditions.notExists(sql`(${subSql})`));
    return this;
  }

  /**
   * Add a scalar subquery to the SELECT clause.
   *
   * Accepts either a pre-built sub-builder, or — for **correlated**
   * subqueries — a factory that receives an `outer` resolver (#372). The
   * resolver maps an outer `"alias.property"` reference to its escaped
   * identifier (`Sql` fragment), so the subquery can reference the outer
   * row without hand-writing dialect-specific identifiers.
   *
   * @example
   * ```ts
   * // Plain subquery (uncorrelated)
   * const latestComment = em.createQueryBuilder(Comment, "c")
   *   .select(["content"])
   *   .where(sql`"c"."post_id" = "p"."id"`)
   *   .orderBy({ createdAt: "DESC" })
   *   .limit(1);
   * qb.addSelectSubquery(latestComment, "latestComment");
   *
   * // Correlated subquery — per-node descendant post count (nested set)
   * em.createQueryBuilder(Category, "node")
   *   .addSelectSubquery(
   *     (outer) =>
   *       em.createQueryBuilder(Post, "p")
   *         .selectRaw(["COUNT(*)"])
   *         .innerJoin(Category, "a", (j) => j.on("p.categoryId", "=", "a.id"))
   *         .where(sql`${outer("a.lft")} BETWEEN ${outer("node.lft")} AND ${outer("node.rgt")}`),
   *     "postCount",
   *   );
   * ```
   */
  addSelectSubquery(subQb: SubqueryInput, alias: string): this {
    const subSql = this.resolveSubquery(subQb).toSql();
    this.selectExpressions.push(
      sql`(${subSql}) AS ${raw(this.em.wrap(alias))}`,
    );
    return this;
  }

  /**
   * #372: resolve a {@link SubqueryInput} — invoke factories with an
   * `outer` resolver bound to this builder's alias registry, so the
   * subquery can embed escaped outer-column references.
   */
  protected resolveSubquery(input: SubqueryInput): SelectQueryBuilder<any, any> {
    if (typeof input === "function") {
      return input((ref: string) => raw(this.resolveColumn(ref)));
    }
    return input;
  }

  // ── SCOPES ─────────────────────────────────────────────

  /**
   * Apply a named scope defined as a static property on the entity class.
   *
   * Scopes are reusable query fragments defined on the entity:
   * ```ts
   * @Entity()
   * class User {
   *   static scopes = {
   *     active: (qb: SelectQueryBuilder<User>) => qb.where("status", "active"),
   *     recent: (qb: SelectQueryBuilder<User>) => qb.orderBy({ createdAt: "DESC" }).limit(10),
   *   };
   * }
   * ```
   *
   * @example
   * ```ts
   * const users = await repo.createQueryBuilder("u")
   *   .applyScope("active")
   *   .applyScope("recent")
   *   .getMany();
   * ```
   */
  applyScope(name: string): this {
    const scopes = (this.entity as any).scopes;
    if (!scopes || typeof scopes[name] !== "function") {
      const available = scopes ? Object.keys(scopes).join(", ") : "none";
      throw new OrmError(
        OrmErrorCode.INVALID_QUERY,
        `Scope "${name}" not found on entity ${this.entity.name}. Available: [${available}].`,
      );
    }
    scopes[name](this);
    return this;
  }

  // ── RAW APPEND ──────────────────────────────────────────

  /**
   * Append a raw SQL fragment to the query.
   */
  appendSql(fragment: Sql): this {
    this.extraSegments.push(fragment);
    return this;
  }

  // ── BUILD ───────────────────────────────────────────────

  /**
   * Build the final SQL query. Returns a `Sql` object (sql-template-tag).
   */
  toSql(): Sql {
    const tableName = this.resolveTableName();
    const qb = RawQueryBuilderFactory.create() as RawQueryBuilder;

    // Database type
    const internals = this.emInternals._ctx;
    if (internals.isMySqlFamily()) qb.setDatabaseType("mysql");
    else if (internals.isSqlite?.()) qb.setDatabaseType("sqlite");
    else qb.setDatabaseType("postgresql");

    // SELECT — inheritance-aware
    if (this.aliasedProjections !== null) {
      // Aliased-expression projection (may carry bound params for JSON
      // extract); bypass the string-based select() path to keep values
      // attached to their placeholders. Resolved here (not at select() call
      // time) so projections may reference JOIN aliases registered later.
      qb.selectFragments(this.renderAliasedProjections(), this.distinct);
    } else if (this.selectColumns === "*") {
      // TPT child: use explicit column list from both tables
      if (this.tptSelectColumns) {
        const cols = [...this.tptSelectColumns];
        if (this.distinct) {
          qb.selectDistinct(cols);
        } else {
          qb.select(cols);
        }
      } else {
        const allCols = `${this.em.wrap(this.alias)}.*`;
        // TPT polymorphic: append child own columns with prefix aliases
        if (this.tptPolymorphicSelectColumns?.length) {
          const cols = [allCols, ...this.tptPolymorphicSelectColumns];
          if (this.distinct) {
            qb.selectDistinct(cols);
          } else {
            qb.select(cols);
          }
        } else {
          if (this.distinct) {
            qb.selectDistinct([allCols]);
          } else {
            qb.select([allCols]);
          }
        }
      }
    } else {
      // TPT polymorphic: append child columns to user-specified columns
      const cols = this.tptPolymorphicSelectColumns?.length
        ? [...(this.selectColumns as string[]), ...this.tptPolymorphicSelectColumns]
        : this.selectColumns as string[];
      if (this.distinct) {
        qb.selectDistinct(cols);
      } else {
        qb.select(cols);
      }
    }

    // Parameterized SELECT expressions (withCount, addSelectSubquery)
    for (const expr of this.selectExpressions) {
      qb.addSelectExpression(expr);
    }

    // FROM — TPC polymorphic uses UNION ALL subquery
    if (this.tpcFromSql) {
      qb.from(sql`(${this.tpcFromSql})`, `AS ${this.em.wrap(this.alias)}`);
    } else {
      const fromExpr = `${this.em.wrapTable(tableName)} AS ${this.em.wrap(this.alias)}`;
      if (this.indexHints.length > 0 && internals.isMySqlFamily()) {
        const hints = this.indexHints
          .map((h) => `${h.type} INDEX (${this.em.wrap(h.indexName)})`)
          .join(" ");
        qb.from(`${fromExpr} ${hints}`);
      } else {
        qb.from(fromExpr);
      }
    }

    // JOINs
    for (const j of this.joinClauses) {
      qb.join(
        j.type,
        this.em.wrapTable(j.table),
        this.em.wrap(j.alias),
        this.scopedJoinCondition(j),
      );
    }

    // Soft delete auto-filter (use local copy to avoid mutating shared state)
    const effectiveWhere = [...this.whereClauses];
    const resolver = this.emInternals.resolver;
    if (resolver) {
      const deletedAtColumn = resolver.getDeletedAtColumn(this.entity);
      if (deletedAtColumn && !this.withDeletedFlag) {
        effectiveWhere.push(Conditions.isNull(this.col(deletedAtColumn)));
      }
    }

    // Tenant scoping under the "tenant_column" strategy. Qualify by the
    // main-table alias so the predicate works in the presence of JOINs.
    this.appendTenantPredicate(effectiveWhere, this.entity, this.alias);

    // WHERE
    qb.where(effectiveWhere);

    // GROUP BY
    if (this.groupByCols.length > 0) {
      qb.groupBy(this.groupByCols);
    }

    // HAVING
    if (this.havingClauses.length > 0) {
      qb.having(this.havingClauses);
    }

    // ORDER BY
    if (this.orderByClauses.length > 0) {
      const orderFragment = this.renderOrderBy(internals.isMySqlFamily());
      qb.appendSql(orderFragment);
    }

    // LIMIT / OFFSET
    if (this.offsetValue !== undefined && this.limitValue !== undefined) {
      qb.limit([this.offsetValue, this.limitValue as number]);
    } else if (this.limitValue !== undefined) {
      qb.limit(this.limitValue as number);
    } else if (this.offsetValue !== undefined) {
      if (internals.isMySqlFamily()) {
        // MySQL requires LIMIT with OFFSET; use Number.MAX_SAFE_INTEGER
        qb.limit([this.offsetValue, Number.MAX_SAFE_INTEGER]);
      } else {
        qb.offset(this.offsetValue);
      }
    }

    // LOCK
    if (this.lockClause) {
      qb.appendSql(raw(this.lockClause));
    }

    // Extra segments
    for (const seg of this.extraSegments) {
      qb.appendSql(seg);
    }

    const built = qb.build();

    // pg_hint_plan: prepend /*+ ... */ before SELECT
    if (this.pgHints.length > 0) {
      const hintComment = `/*+ ${this.pgHints.join(" ")} */ `;
      return sql`${raw(hintComment)}${built}`;
    }

    return built;
  }

  /**
   * Get the raw SQL text and parameters (for debugging).
   */
  getSql(): { text: string; values: any[] } {
    const built = this.toSql();
    return { text: built.sql, values: built.values };
  }

  // ── EXECUTION: Safe (class instances) ───────────────────

  /**
   * Execute the query and return class instances.
   *
   * Always deserializes rows into actual entity instances via
   * `class-transformer`, so `instanceof`, class methods, lifecycle hooks,
   * and `em.save()` all work correctly.
   *
   * When `select()` is used with specific columns, validates that all
   * required (non-nullable) columns are included. Throws `OrmError` with
   * `MISSING_REQUIRED_COLUMNS` if a required column is omitted.
   *
   * For plain-object projections without validation, use `getPartialMany()`.
   * For completely untyped results, use `getRawMany()`.
   */
  /**
   * Opt into query result caching for this builder's terminals (`getMany`,
   * `getOne`, `getRawMany`, `getPartialMany`, `getCount`, aggregate scalars,
   * `exists`).
   *
   * - `true` (default) → connection-level default TTL
   * - `number`         → TTL in milliseconds
   * - `{ ttl, tag }`   → TTL override plus a user tag for manual
   *   invalidation via `em.queryCache?.invalidate(tag)`
   *
   * Cached entries are invalidated by writes issued through the same
   * EntityManager against the root entity or its entity-aware joins
   * (`*AndSelect` / `loadRelation`). Raw table-name joins are bounded by the
   * TTL only — pass a `tag` to invalidate those by hand. Locking queries
   * (`FOR UPDATE`) and reads inside an active transaction always bypass the
   * cache. See `FindOption.cache` for the full semantics.
   *
   * @example
   * ```ts
   * const rows = await em.createQueryBuilder(Product, "p")
   *   .where("featured", true)
   *   .cache(30_000)
   *   .getMany();
   * ```
   */
  cache(option: boolean | number | { ttl?: number; tag?: string } = true): this {
    this.cacheOption = option;
    return this;
  }

  /**
   * @internal Dispatch a built SELECT through the query result cache when
   * this builder opted in via {@link cache}; plain `em.query` otherwise.
   */
  protected async execQuery<TRow = any>(built: Sql): Promise<TRow[]> {
    const policy = this.resolveCachePolicy();
    if (!policy) return this.em.query<TRow>(built);
    return policy.fetchRows(built, () => this.em.query<TRow>(built));
  }

  private resolveCachePolicy(): QueryCachePolicy | undefined {
    if (!this.cacheOption || this.lockClause) return undefined;
    // Partial EM doubles in unit tests may omit any internals member.
    const cacheManager = this.emInternals._ctx?.getQueryCache?.();
    if (!cacheManager) return undefined;
    const joined = this.joinedSelections
      .map((s) => s.entity)
      .filter((e): e is ClazzType<any> => !!e);
    return cacheManager.policyForBuilder(this.entity, joined, this.cacheOption);
  }

  async getMany(): Promise<TResult[]> {
    this.validateRequiredColumns();

    // Two-phase root pagination: when a to-many *AndSelect join is combined
    // with LIMIT/OFFSET, the window would otherwise apply to the JOIN-
    // multiplied rows and silently truncate a root's children at the page
    // boundary. Resolve the page of distinct roots first, then hydrate them
    // fully (see fetchRootPage). Falls back to the single-phase path (with a
    // debug warning) when the root PK is unresolvable.
    if (
      this.hasToManyJoinedSelection() &&
      (this.limitValue !== undefined || this.offsetValue !== undefined)
    ) {
      const pkCols = this.resolveRootPkColumns();
      if (pkCols.length > 0) {
        return this.fetchRootPage(pkCols, "entity");
      }
      this.warnUnresolvableRootPage();
    }

    const built = this.toSql();
    const rows = await this.execQuery<any>(built);

    let entities: TResult[];

    // Polymorphic deserialization: instantiate correct subclass per row
    if (this.isPolymorphicQuery && this.discriminatorMap?.size) {
      entities =
        this.inheritanceStrategy === "JOINED" && this.tptChildPrefixMap
          ? this.applyValidation(this.deserializeTPTPolymorphic(rows))
          : this.applyValidation(this.deserializePolymorphic(rows));
    } else if (this.joinedSelections.length > 0) {
      // #370: *AndSelect joins — split alias-prefixed columns per join,
      // hydrate them into the relation property, and dedupe/group roots.
      entities = this.applyValidation(this.transformJoinedEntityRows(rows));
    } else {
      // Run rows through ResultTransformer so that NamingStrategy reverse-
      // mapping (e.g. SnakeNamingStrategy: `issue_counter` → `issueCounter`)
      // and column transformers fire. Calling the deserializer directly here
      // skipped both, so qAlias-driven queries returned entities with the raw
      // DB column names — `(project.issueCounter ?? 0) + 1` then always
      // collapsed to `1` because the property was actually `issue_counter`.
      const transformer = ResultTransformerFactory.create();
      entities = this.applyValidation(
        transformer.toEntities(this.entity, { results: rows }),
      );
    }

    // #371: afterLoad parity with find/findOne — entity-typed reads fire
    // subscribers; raw/partial reads stay raw.
    await this.notifyAfterLoad(entities);
    return entities;
  }

  /**
   * #371: fire `afterLoad` subscribers for entity results, mirroring the
   * find/findOne paths. No-op when the EntityManager does not expose the
   * hook (plain mocks) or there are no entities.
   */
  protected async notifyAfterLoad(entities: TResult[]): Promise<void> {
    if (!entities?.length) return;
    const emit = this.emInternals.emitAfterLoad;
    if (typeof emit !== "function") return;
    await emit.call(this.em, this.entity, entities);
  }

  /**
   * #370: entity transformation for *AndSelect queries.
   *
   * Each row is partitioned by alias prefix (longest prefix first, so
   * overlapping aliases split deterministically): `${rootAlias}_*` columns
   * (when the root `*` was expanded) plus unmatched keys form the root row;
   * `${joinAlias}_*` columns form one sub-row per joined selection. Roots
   * are deduped by PK so OneToMany joins group into arrays instead of
   * duplicating the root entity; LEFT JOIN misses become `null` (to-one)
   * or are skipped (to-many).
   */
  protected transformJoinedEntityRows(rows: any[]): TResult[] {
    const transformer = ResultTransformerFactory.create();
    const resolver = this.emInternals.resolver;
    const rootMeta = resolver?.resolveEntityMetadata?.(this.entity);
    const pkNamesOf = (entity: ClazzType<any>): string[] => {
      const meta = resolver?.resolveEntityMetadata?.(entity);
      return (meta?.columns ?? [])
        .filter((c: ColumnMetadata) => c.options?.primary)
        .map((c: ColumnMetadata) => c.name);
    };
    const rootPkCols = rootMeta ? pkNamesOf(this.entity) : [];
    const joinedPkCols = new Map<string, string[]>();
    for (const sel of this.joinedSelections) {
      joinedPkCols.set(sel.alias, pkNamesOf(sel.entity));
    }

    // Longest-prefix-first matching keeps overlapping aliases unambiguous
    // (e.g. join aliases `user` and `user_profile`).
    const prefixes: Array<{ prefix: string; alias: string | null }> =
      this.joinedSelections.map((s) => ({ prefix: `${s.alias}_`, alias: s.alias }));
    if (this.rootSelectExpanded) {
      prefixes.push({ prefix: `${this.alias}_`, alias: null });
    }
    prefixes.sort((a, b) => b.prefix.length - a.prefix.length);

    const toEntity = (entity: ClazzType<any>, row: any) =>
      transformer.toEntity(entity, { results: [row], fields: [] } as any);
    const isAllNull = (row: any) =>
      !row || Object.values(row).every((v) => v === null || v === undefined);
    const pkKeyOf = (pkCols: string[], row: any): string | null => {
      if (pkCols.length === 0) return null;
      const vals = pkCols.map((c) => row?.[c]);
      if (vals.some((v) => v === null || v === undefined)) return null;
      return vals.map((v) => String(v)).join("");
    };

    const ordered: any[] = [];
    const rootsByKey = new Map<string, any>();
    // Cross-row instance registry: `${parentKey}/${alias}[:${childPk}]` →
    // hydrated entity. Lets deeper joins attach to the same instance the
    // earlier row created (OneToMany grouping, nested *AndSelect chains).
    const instanceRegistry = new Map<string, any>();
    let syntheticRootSeq = 0;

    for (const row of rows) {
      // 1. Partition the row by alias prefix.
      const parts = new Map<string | null, any>();
      for (const key of Object.keys(row)) {
        let target: string | null | undefined;
        let stripped = key;
        for (const { prefix, alias } of prefixes) {
          if (key.startsWith(prefix)) {
            target = alias;
            stripped = key.substring(prefix.length);
            break;
          }
        }
        if (target === undefined) {
          // Unmatched key — root column (explicit select / extra expressions)
          target = null;
        }
        let part = parts.get(target ?? null);
        if (!part) {
          part = {};
          parts.set(target ?? null, part);
        }
        part[stripped] = row[key];
      }

      // 2. Dedup the root by PK; synthesize a unique key when unavailable.
      const rootRow = parts.get(null) ?? {};
      const rootKey =
        pkKeyOf(rootPkCols, rootRow) ?? `row:${syntheticRootSeq++}`;
      let rootInst = rootsByKey.get(rootKey);
      if (!rootInst) {
        rootInst = toEntity(this.entity, rootRow);
        rootsByKey.set(rootKey, rootInst);
        ordered.push(rootInst);
      }

      // 3. Hydrate joined selections, attaching each to its parent.
      const aliasInstances = new Map<string, any>([[this.alias, rootInst]]);
      const aliasKeys = new Map<string, string>([[this.alias, rootKey]]);

      for (const sel of this.joinedSelections) {
        const parentInst = aliasInstances.get(sel.sourceAlias);
        const parentKey = aliasKeys.get(sel.sourceAlias);
        if (!parentInst || !sel.property) continue;

        const subRow = parts.get(sel.alias);
        if (sel.kind === "one-to-many") {
          if (!Array.isArray(parentInst[sel.property])) {
            parentInst[sel.property] = [];
          }
          if (isAllNull(subRow)) continue;
          const childPk = pkKeyOf(joinedPkCols.get(sel.alias) ?? [], subRow);
          const childKey = `${parentKey}/${sel.alias}:${childPk ?? `${ordered.length}:${parentInst[sel.property].length}`}`;
          let childInst = instanceRegistry.get(childKey);
          if (!childInst) {
            childInst = toEntity(sel.entity, subRow);
            instanceRegistry.set(childKey, childInst);
            parentInst[sel.property].push(childInst);
          }
          aliasInstances.set(sel.alias, childInst);
          aliasKeys.set(sel.alias, childKey);
        } else {
          if (isAllNull(subRow)) {
            if (parentInst[sel.property] === undefined) {
              parentInst[sel.property] = null;
            }
            continue;
          }
          const childKey = `${parentKey}/${sel.alias}`;
          let childInst = instanceRegistry.get(childKey);
          if (!childInst) {
            childInst = toEntity(sel.entity, subRow);
            instanceRegistry.set(childKey, childInst);
          }
          parentInst[sel.property] = childInst;
          aliasInstances.set(sel.alias, childInst);
          aliasKeys.set(sel.alias, childKey);
        }
      }
    }

    return ordered as TResult[];
  }

  /**
   * Compile this query once so subsequent executions skip SQL assembly.
   *
   * Use `p("name")` to mark runtime parameter slots in `.where()`, `.limit()`,
   * etc. Calling `.prepare()` freezes the current builder state: later
   * mutations do not affect the returned `CompiledQuery`.
   *
   * @example
   * ```ts
   * const q = em.createQueryBuilder(User, "u")
   *   .where(sql`u.id = ${p("id")}`)
   *   .prepare<{ id: number }>();
   *
   * await q.executeOne({ id: 42 });
   * await q.executeOne({ id: 77 });   // no rebuild
   * ```
   */
  prepare<P extends Record<string, unknown> = Record<string, unknown>>(): CompiledQuery<TResult, P> {
    this.validateRequiredColumns();
    const built = this.toSql();

    const entity = this.entity;
    const isPoly = this.isPolymorphicQuery;
    const discMap = this.discriminatorMap;
    const strategy = this.inheritanceStrategy;
    const tptMap = this.tptChildPrefixMap;
    const hasJoinedSelections = this.joinedSelections.length > 0;
    const deserializePoly = this.deserializePolymorphic.bind(this);
    const deserializeTPT = this.deserializeTPTPolymorphic.bind(this);
    const transformJoined = this.transformJoinedEntityRows.bind(this);
    const applyVal = this.applyValidation.bind(this);

    const deserialize = (rows: any[]): TResult[] => {
      if (isPoly && discMap?.size) {
        if (strategy === "JOINED" && tptMap) {
          return applyVal(deserializeTPT(rows));
        }
        return applyVal(deserializePoly(rows));
      }
      if (hasJoinedSelections) {
        // Mirror getMany(): *AndSelect joins hydrate alias-prefixed columns
        // into relation properties and dedupe/group roots.
        return applyVal(transformJoined(rows));
      }
      // Mirror getMany(): run rows through ResultTransformer so NamingStrategy
      // reverse-mapping (e.g. `issue_counter` → `issueCounter`) and column
      // transformers (boolean 0/1 → bool, JSON parse, custom `from()`) fire.
      // Calling the deserializer directly here skipped both, so prepared
      // queries leaked raw DB column names and untransformed values.
      const transformer = ResultTransformerFactory.create();
      return applyVal(transformer.toEntities(entity, { results: rows }));
    };

    return new CompiledQuery<TResult, P>(
      built.strings,
      built.values,
      (sql) => this.em.query<any>(sql),
      deserialize,
    );
  }

  /**
   * Compile a partial-projection query (no class deserialization).
   * Mirrors `getPartialMany()` — returns plain objects shaped by `select()`.
   */
  preparePartial<P extends Record<string, unknown> = Record<string, unknown>>(): CompiledQuery<TResult, P> {
    const built = this.toSql();
    const applyVal = this.applyValidation.bind(this);
    return new CompiledQuery<TResult, P>(
      built.strings,
      built.values,
      (sql) => this.em.query<any>(sql),
      (rows) => applyVal(rows) as unknown as TResult[],
    );
  }

  /**
   * Execute the query and return a single class instance or null.
   * Automatically adds LIMIT 1 if not already set.
   */
  async getOne(): Promise<TResult | null> {
    if (this.limitValue === undefined) {
      this.limitValue = 1;
    }
    const results = await this.getMany();
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Execute the query and return a single class instance.
   * Throws EntityNotFoundError if no result is found.
   */
  async getOneOrFail(): Promise<TResult> {
    const result = await this.getOne();
    if (result === null) {
      throw new EntityNotFoundError(this.entity.name);
    }
    return result;
  }

  /**
   * Execute the query and return both the page of class instances and the
   * total row count — the query-builder counterpart to
   * `EntityManager.findAndCount()`. `rows` is exactly what {@link getMany}
   * returns (respecting LIMIT/OFFSET) while `total` is exactly what
   * {@link getCount} returns (ignoring LIMIT/OFFSET but still honoring
   * WHERE / JOIN / soft-delete / tenant scoping via {@link applyCountSource}).
   *
   * The two queries run sequentially rather than via `Promise.all`, mirroring
   * {@link paginate}: SQLite has a single connection and cannot hold two
   * concurrent transactions, so parallel reads would throw "cannot start a
   * transaction within a transaction" there.
   */
  async getManyAndCount(): Promise<[TResult[], number]> {
    const results = await this.getMany();
    const count = await this.getCount();
    return [results, count];
  }

  /**
   * Execute the query (via {@link getMany}) and index every row into a `Map`
   * keyed by the value of `keyColumn`, giving O(1) lookup by that column —
   * the query-builder counterpart to Laravel's `keyBy()`.
   *
   * This is a terminal like {@link getMany}, so it inherits everything the
   * built query already carries — WHERE / JOIN / ORDER BY / LIMIT / OFFSET,
   * the soft-delete auto-filter and tenant scoping — for free; it merely
   * re-indexes the rows `getMany()` returns and never issues its own SQL.
   *
   * **Last-wins on duplicate keys:** when two rows share the same `keyColumn`
   * value, the later row (in result order) overwrites the earlier one, so the
   * Map holds at most one row per key. Use a unique column (e.g. the primary
   * key) when a strict 1:1 mapping is required.
   *
   * The Map value is the element type of `getMany()` (`TResult`) and the key
   * is typed as `T[K]` — the column's value type on the entity. `K` is
   * constrained to a real column of `T` the same way {@link getSum} /
   * `select()` constrain their column argument, so a typo is a compile error.
   *
   * @example
   * ```ts
   * const byId = await em
   *   .createQueryBuilder(User, "u")
   *   .where("u.status", "active")
   *   .getMap("id");
   * byId.get(5); // the active User with id 5, or undefined
   * ```
   */
  async getMap<K extends ColumnOf<T>>(
    keyColumn: K,
  ): Promise<Map<T[K], TResult>> {
    const rows = await this.getMany();
    const map = new Map<T[K], TResult>();
    for (const row of rows) {
      // `row` is a TResult (possibly a `select()` projection of T); the key
      // column is always a column of T, so read it through a T view. No SQL
      // is issued here — getMany() already executed the query.
      const key = (row as unknown as T)[keyColumn];
      map.set(key, row);
    }
    return map;
  }

  /**
   * Execute the query (via {@link getMany}) and return a flat array of just
   * `column`'s value from every row, preserving result order — the
   * query-builder counterpart to Laravel's `pluck()`. Handy for collecting a
   * single column (e.g. a list of ids to feed a later `IN (...)`).
   *
   * Like {@link getMap} this is a terminal that delegates to {@link getMany},
   * so WHERE / JOIN / ORDER BY / LIMIT / soft-delete / tenant scoping all
   * apply and no additional SQL is built. Each element is typed as the
   * column's value type (`T[K]`), with `K` constrained to a real column of
   * `T`, so an empty result set yields `[]`.
   *
   * @example
   * ```ts
   * const ids = await em
   *   .createQueryBuilder(User, "u")
   *   .where("u.status", "active")
   *   .pluck("id"); // number[]
   * ```
   */
  async pluck<K extends ColumnOf<T>>(column: K): Promise<Array<T[K]>> {
    const rows = await this.getMany();
    // `column` is a column of T; read it through a T view of each TResult row.
    return rows.map((row) => (row as unknown as T)[column]);
  }

  /**
   * Execute the query as an offset-based page and return the page data
   * together with pagination metadata (`total`, `totalPages`,
   * `hasNextPage`, `hasPreviousPage`).
   *
   * This is the query-builder counterpart to `EntityManager.findWithPage()`
   * — use it when the query was assembled through the builder (joins,
   * `qAlias` conditions, subqueries, …) instead of a plain `FindOption`.
   * It removes the repeated `getManyAndCount()` + `Math.ceil()` boilerplate
   * that every paginated endpoint otherwise hand-rolls.
   *
   * `page` is 1-based and `pageSize` defaults to 20; both are normalized
   * the same way as `findWithPage()` (non-positive / fractional values are
   * coerced to a sane value). Any `limit`/`offset`/`skip`/`take` previously
   * set on the builder is overridden by `page`/`pageSize`. The builder
   * itself is not mutated — a clone carries the LIMIT/OFFSET — so the same
   * instance can be paged again or reused for a different query.
   *
   * When the builder carries a to-many `*AndSelect` join (e.g.
   * `leftJoinRelationAndSelect("comments", ...)`), `total` counts distinct
   * root entities and the page is computed over distinct roots — `getCount()`
   * and `getMany()` apply two-phase root pagination, so a page never truncates
   * a root's children at the boundary nor reports the JOIN-multiplied row
   * count.
   *
   * @example
   * ```ts
   * const result = await em
   *   .createQueryBuilder(Post, "p")
   *   .leftJoin(User, "u", (j) => j.on("p.authorId", "=", "u.id"))
   *   .where("p.status", "published")
   *   .orderBy({ createdAt: "DESC" })
   *   .paginate({ page: 2, pageSize: 10 });
   *
   * result.data;          // Post[] for page 2
   * result.total;         // total matching rows (ignores LIMIT/OFFSET)
   * result.totalPages;    // Math.ceil(total / pageSize)
   * result.hasNextPage;   // page < totalPages
   * ```
   */
  async paginate(
    options: { page?: number; pageSize?: number } = {},
  ): Promise<PagePaginationResult<TResult>> {
    const page = normalizePage(options.page);
    const pageSize = normalizePageSize(options.pageSize);
    const offset = (page - 1) * pageSize;

    const paged = this.clone();
    paged.offsetValue = offset;
    paged.limitValue = pageSize;

    // Run the count and the page sequentially (as getManyAndCount() does):
    // SQLite has a single connection and cannot hold two concurrent
    // transactions, so parallel reads would throw "cannot start a
    // transaction within a transaction" there.
    const total = await paged.getCount();
    const data = await paged.getMany();
    return this.buildPage(data, total, page, pageSize);
  }

  /**
   * Offset-pagination variant of {@link paginate} that returns plain
   * objects via {@link getPartialMany} instead of deserialized entity
   * instances.
   *
   * Use this for projected list views (`select(["id", "title"])`) where
   * the page data does not need to be a class instance — `paginate()`
   * uses `getMany()`, which rejects partial selects that omit required
   * columns, whereas this method allows them. Mirrors the
   * `getManyAndCount()` / `getPartialManyAndCount()` pairing.
   *
   * @example
   * ```ts
   * const page = await em
   *   .createQueryBuilder(Post, "p")
   *   .select(["id", "title"])
   *   .orderBy({ id: "DESC" })
   *   .paginatePartial({ page: 1, pageSize: 20 });
   *
   * page.data; // Pick<Post, "id" | "title">[] — plain objects, not entities
   * ```
   */
  async paginatePartial(
    options: { page?: number; pageSize?: number } = {},
  ): Promise<PagePaginationResult<TResult>> {
    const page = normalizePage(options.page);
    const pageSize = normalizePageSize(options.pageSize);
    const offset = (page - 1) * pageSize;

    const paged = this.clone();
    paged.offsetValue = offset;
    paged.limitValue = pageSize;

    const total = await paged.getCount();
    const data = await paged.getPartialMany();
    return this.buildPage(data, total, page, pageSize);
  }

  /** @internal Assemble the page-pagination metadata envelope. */
  private buildPage(
    data: TResult[],
    total: number,
    page: number,
    pageSize: number,
  ): PagePaginationResult<TResult> {
    const totalPages = Math.ceil(total / pageSize);
    return {
      data,
      total,
      page,
      pageSize,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1,
    };
  }

  /**
   * Keyset (cursor) pagination terminal — the seek-method counterpart to the
   * offset-based {@link paginate}. Instead of `LIMIT/OFFSET`, it filters with
   * a `<sortColumn> > <lastValue>` (ASC) / `< <lastValue>` (DESC) predicate, so
   * latency stays flat on very large tables and the page window does not skip
   * or duplicate rows when concurrent inserts shift offsets. Mirrors the
   * semantics of `EntityManager.findWithCursor()` and reuses the exact same
   * cursor encoding (`encodeCursor` / `decodeCursor`), `take` normalization
   * (`normalizePageSize`), and {@link CursorPaginationResult} envelope.
   *
   * The option shape is {@link CursorPaginationOption} — `take` (page size,
   * default 20), `cursor` (Base64 token from a previous call), `orderBy` (sort
   * property, default the entity primary key), and `direction` (default
   * `"ASC"`). The builder's own WHERE / JOIN / soft-delete / tenant scoping is
   * preserved: the keyset predicate is appended through `andWhere()` rather
   * than rebuilding the query, and the sort column is inserted as the PRIMARY
   * `ORDER BY` so any existing `orderBy()` clauses follow as tiebreakers.
   *
   * Side-effect-free on `this`: all mutation happens on a {@link clone}, so the
   * source builder can be reused or paged again afterward.
   *
   * Like `findWithCursor()`, `hasNextPage` is detected by over-fetching one
   * extra row (`take + 1`), and `nextCursor` is `encodeCursor(<last row's sort
   * value>)` — or `null` on the final page.
   *
   * IMPORTANT — use a NON-NULL sort column (the PK or a `NOT NULL` timestamp).
   * The keyset keeps not-yet-visited NULL rows in the window, which assumes the
   * PostgreSQL ordering `NULLs last in ASC / first in DESC`. MySQL and SQLite
   * sort NULLs the opposite way, so paging a NULLABLE sort column can repeat the
   * NULL rows across pages on those engines. This caveat is shared with
   * `findWithCursor`; keyset pagination is only well-defined over a strictly
   * ordered, non-null column.
   *
   * Scope: single-column keyset only (one `orderBy` column, matching
   * `findWithCursor`). The cursor value is read from the deserialized entity
   * by property name, so a sort column carrying a value `transformer` may
   * encode the transformed (not the raw DB) value; for the typical PK /
   * timestamp / numeric sort columns the two are identical. Combining with a
   * to-many `*AndSelect` join (distinct-root windowing) is out of scope.
   *
   * @example
   * ```ts
   * // First page
   * const first = await em
   *   .createQueryBuilder(Post, "p")
   *   .where("p.status", "published")
   *   .getCursor({ take: 20, orderBy: "id", direction: "ASC" });
   *
   * first.data;        // Post[] — up to 20 rows
   * first.hasNextPage; // true when a 21st row was over-fetched
   *
   * // Next page
   * if (first.nextCursor) {
   *   const second = await em
   *     .createQueryBuilder(Post, "p")
   *     .where("p.status", "published")
   *     .getCursor({ take: 20, cursor: first.nextCursor });
   * }
   * ```
   */
  async getCursor(
    option: CursorPaginationOption<T> = {},
  ): Promise<CursorPaginationResult<TResult>> {
    const direction = option.direction ?? "ASC";
    const pageSize = normalizePageSize(option.take);

    // Resolve the sort column. `option.orderBy` is an entity property name
    // (consistent with where()/orderBy()); when omitted, fall back to the
    // entity's primary key, matching findWithCursor.
    const sortProperty = this.resolveCursorSortProperty(option.orderBy);
    const qualifiedSortColumn = this.col(sortProperty);

    // Decode the incoming cursor with the same strictness as findWithCursor:
    // a non-null cursor string that fails to decode is a hard error.
    let cursorValue: unknown = null;
    if (option.cursor) {
      cursorValue = decodeCursor(option.cursor);
      if (cursorValue === null) {
        throw new InvalidQueryError(
          "Invalid cursor value.",
          "Ensure the cursor string was returned from a previous getCursor() call.",
        );
      }
    }

    // Operate on a clone so the source builder is untouched (as paginate() does).
    const paged = this.clone();

    // Honor the `withDeleted` option so soft-deleted rows can be included,
    // matching ReadExecutor.findWithCursor. A prior `.withDeleted()` on the
    // builder is preserved by clone(); this also lets the option request it.
    if (option.withDeleted) {
      paged.withDeleted();
    }

    // Append the keyset predicate, ANDed with the builder's existing WHERE /
    // JOIN / soft-delete / tenant clauses via the same andWhere() path. NULL
    // rows that have not been visited yet are included, matching findWithCursor.
    if (cursorValue !== null) {
      const keyset =
        direction === "ASC"
          ? Conditions.or([
              Conditions.gt(qualifiedSortColumn, cursorValue),
              Conditions.isNull(qualifiedSortColumn),
            ])
          : Conditions.or([
              Conditions.lt(qualifiedSortColumn, cursorValue),
              Conditions.isNull(qualifiedSortColumn),
            ]);
      paged.andWhere(keyset);
    }

    // The sort column drives ordering as the primary key; any ORDER BY already
    // on the builder follows as a tiebreaker.
    paged.orderByClauses = [
      { column: qualifiedSortColumn, direction },
      ...paged.orderByClauses,
    ];

    // Over-fetch one extra row to detect the next page. Keyset never uses OFFSET.
    paged.offsetValue = undefined;
    paged.limitValue = pageSize + 1;

    const rows = await paged.getMany();

    const hasNextPage = rows.length > pageSize;
    const data = hasNextPage ? rows.slice(0, pageSize) : rows;

    let nextCursor: string | null = null;
    if (hasNextPage && data.length > 0) {
      const lastRow = data[data.length - 1] as Record<string, unknown>;
      nextCursor = encodeCursor(lastRow[sortProperty]);
    }

    return {
      data,
      hasNextPage,
      nextCursor,
      count: data.length,
    };
  }

  /**
   * @internal Resolve the cursor sort column as an entity property name.
   * Returns `orderBy` when provided, otherwise the entity's primary-key
   * property. Throws when neither is available (matches findWithCursor).
   */
  private resolveCursorSortProperty(
    orderBy?: keyof T & string,
  ): keyof T & string {
    if (orderBy) {
      return orderBy;
    }
    const resolver = (this.em as unknown as {
      resolver?: RelationMetadataResolver;
    }).resolver;
    const metadata = resolver?.resolveEntityMetadata(this.entity);
    const pk = metadata?.columns?.find(
      (column: ColumnMetadata) => column.options?.primary,
    );
    const pkProperty = (pk?.propertyKey ?? pk?.name) as
      | (keyof T & string)
      | undefined;
    if (!pkProperty) {
      throw new InvalidQueryError(
        "Cursor pagination requires an orderBy column or a primary key.",
        "Pass orderBy in the getCursor() option, or add a primary key to the entity.",
      );
    }
    return pkProperty;
  }

  // ── EXECUTION: Partial (typed plain objects) ───────────

  /**
   * Execute the query and return plain objects with `Pick<T, K>` typing.
   *
   * No deserialization — results are NOT class instances. `instanceof`
   * returns false and lifecycle hooks do not fire. Do not pass these
   * to `em.save()`.
   *
   * When `select()` is used, the return type narrows to `Pick<T, K>[]`,
   * preventing access to unselected columns at compile time.
   */
  async getPartialMany(): Promise<TResult[]> {
    // Two-phase root pagination, partial variant: same root-windowing concern
    // as getMany() (see there), but rows stay as plain projected objects. The
    // page's roots are selected first, then their (flat) rows are returned in
    // page order without truncating any root's children at the boundary.
    if (
      this.hasToManyJoinedSelection() &&
      (this.limitValue !== undefined || this.offsetValue !== undefined)
    ) {
      const pkCols = this.resolveRootPkColumns();
      if (pkCols.length > 0) {
        return this.fetchRootPage(pkCols, "partial");
      }
      this.warnUnresolvableRootPage();
    }

    const built = this.toSql();
    const rows = await this.execQuery<any>(built);
    return this.applyValidation(rows);
  }

  /**
   * Execute the query and return a single plain object or null.
   * Automatically adds LIMIT 1 if not already set.
   */
  async getPartialOne(): Promise<TResult | null> {
    if (this.limitValue === undefined) {
      this.limitValue = 1;
    }
    const results = await this.getPartialMany();
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Execute the query and return both the page of plain objects and the
   * total count. Like {@link getManyAndCount} but returns plain projected
   * objects via {@link getPartialMany}. Runs sequentially (mirroring
   * {@link paginatePartial}) to stay safe on SQLite's single connection.
   */
  async getPartialManyAndCount(): Promise<[TResult[], number]> {
    const results = await this.getPartialMany();
    const count = await this.getCount();
    return [results, count];
  }

  // ── EXECUTION: Raw (untyped plain objects) ─────────────

  /**
   * Execute the query and return plain objects.
   *
   * Use when the result includes columns not in the entity definition
   * (e.g. `addSelect(sql\`COUNT(*)\`, "cnt")`). No deserialization,
   * no validation.
   *
   * Pass a type parameter to declare the row shape, and an optional
   * `coerce` map to normalize driver-native values — `mysql2` returns
   * `BIGINT` / `DECIMAL` as strings, `pg` returns `NUMERIC` as strings,
   * dates arrive as `Date` or string depending on driver options. The
   * coerce step removes the hand-written `Number(row.x)` boilerplate
   * that aggregate / analytics call sites otherwise accumulate.
   *
   * @example
   * ```ts
   * const rows = await qb
   *   .select([day.as("day"), count.as("completedCount")])
   *   .getRawMany<{ day: Date; completedCount: number }>({
   *     coerce: { day: "date", completedCount: "number" },
   *   });
   * ```
   */
  async getRawMany<T = Record<string, unknown>>(
    options?: RawResultOptions<T>,
  ): Promise<T[]> {
    const built = this.toSql();
    const rows = await this.execQuery<Record<string, unknown>>(built);
    if (options?.coerce) {
      return coerceRows<T>(rows, options.coerce);
    }
    return rows as unknown as T[];
  }

  /**
   * Execute the query and return a single plain object or null.
   * Automatically adds LIMIT 1 if not already set.
   *
   * Accepts the same type parameter and `coerce` option as
   * {@link getRawMany}.
   */
  async getRawOne<T = Record<string, unknown>>(
    options?: RawResultOptions<T>,
  ): Promise<T | null> {
    if (this.limitValue === undefined) {
      this.limitValue = 1;
    }
    const results = await this.getRawMany<T>(options);
    return results.length > 0 ? results[0] : null;
  }

  // ── EXECUTION: Streaming ────────────────────────────────

  /**
   * Stream results as an AsyncGenerator, fetching in batches via LIMIT/OFFSET.
   * Avoids loading the entire result set into memory.
   *
   * @param batchSize Number of rows per batch (default: 1000)
   */
  async *stream(batchSize = 1000): AsyncGenerator<TResult, void, undefined> {
    for await (const batch of this.streamBatch(batchSize)) {
      for (const row of batch) {
        yield row;
      }
    }
  }

  /**
   * Stream results as arrays (windows) via LIMIT/OFFSET — each yielded value
   * is a full batch of up to `batchSize` rows. Complements {@link stream},
   * which yields rows one at a time.
   *
   * Matches the `stream`/`streamBatch` pair on `EntityManager` and
   * `BaseRepository` for naming consistency.
   *
   * @param batchSize Number of rows per window (default: 1000)
   */
  async *streamBatch(batchSize = 1000): AsyncGenerator<TResult[], void, undefined> {
    const effectiveBatchSize = Math.max(batchSize, 1);

    // A limit()/offset() already set on the builder is the window the stream
    // covers — batching happens inside it. It used to be overwritten by the
    // internal batch values, silently streaming the whole table. The tuple
    // form of limitValue is only ever produced internally (limit() takes a
    // number), but unpack it defensively.
    let currentOffset = this.offsetValue ?? 0;
    let remaining: number;
    if (Array.isArray(this.limitValue)) {
      currentOffset = this.offsetValue ?? this.limitValue[0];
      remaining = this.limitValue[1];
    } else {
      remaining = this.limitValue ?? Infinity;
    }

    while (remaining > 0) {
      const size = Math.min(effectiveBatchSize, remaining);
      const cloned = this.clone();
      cloned.offsetValue = currentOffset;
      cloned.limitValue = size;

      const batch = await cloned.getPartialMany();
      if (batch.length === 0) break;

      yield batch;

      remaining -= batch.length;
      if (batch.length < size) break;
      currentOffset += batch.length;
    }
  }

  // ── EXECUTION: Utility ─────────────────────────────────

  /**
   * @internal Does this builder carry a to-many (`one-to-many`) joined
   * selection registered by an `*AndSelect` method? Such joins multiply root
   * rows, which changes both COUNT and LIMIT/OFFSET semantics — a plain
   * `COUNT(*)` overcounts, and a row-level LIMIT can truncate a root's
   * children at the page boundary.
   */
  protected hasToManyJoinedSelection(): boolean {
    return this.joinedSelections.some((s) => s.kind === "one-to-many");
  }

  /**
   * @internal Resolve the root entity's primary-key columns from metadata.
   * Returns one `{ name, propertyKey }` entry per PK column (composite PKs
   * yield several). `name` is the DB column — used for raw-row keying and SQL
   * identifiers; `propertyKey` is the entity property — used to read hydrated
   * instances. Empty when metadata is unavailable. PK membership matches the
   * grouping in {@link transformJoinedEntityRows} (`options.primary`).
   */
  protected resolveRootPkColumns(): Array<{ name: string; propertyKey: string }> {
    const resolver = this.emInternals.resolver;
    const meta = resolver?.resolveEntityMetadata?.(this.entity);
    if (!meta) return [];
    const pks: Array<{ name: string; propertyKey: string }> = [];
    for (const c of (meta.columns ?? []) as ColumnMetadata[]) {
      if (!c.options?.primary) continue;
      const name = c.name;
      if (typeof name !== "string" || name.length === 0) continue;
      pks.push({ name, propertyKey: (c.propertyKey as string) ?? name });
    }
    return pks;
  }

  /**
   * @internal Apply the shared FROM + JOIN + WHERE (soft-delete auto-filter +
   * tenant predicate) source to a count/distinct-style {@link RawQueryBuilder}.
   * Re-derives the same row source as {@link toSql} without mutating shared
   * state. The caller owns the SELECT clause (issued before) and any
   * GROUP BY / HAVING (issued after).
   */
  private applyCountSource(qb: RawQueryBuilder): void {
    const tableName = this.resolveTableName();

    // TPC polymorphic: FROM UNION ALL subquery
    if (this.tpcFromSql) {
      qb.from(sql`(${this.tpcFromSql})`, `AS ${this.em.wrap(this.alias)}`);
    } else {
      qb.from(`${this.em.wrapTable(tableName)} AS ${this.em.wrap(this.alias)}`);
    }

    for (const j of this.joinClauses) {
      qb.join(
        j.type,
        this.em.wrapTable(j.table),
        this.em.wrap(j.alias),
        this.scopedJoinCondition(j),
      );
    }

    // Soft delete auto-filter (re-derive, don't mutate shared state)
    const countWhere = [...this.whereClauses];
    const resolver = this.emInternals.resolver;
    if (resolver) {
      const deletedAtColumn = resolver.getDeletedAtColumn(this.entity);
      if (deletedAtColumn && !this.withDeletedFlag) {
        countWhere.push(Conditions.isNull(this.col(deletedAtColumn)));
      }
    }

    this.appendTenantPredicate(countWhere, this.entity, this.alias);

    qb.where(countWhere);
  }

  /**
   * Execute a COUNT query with the same WHERE/JOIN conditions.
   *
   * When a to-many (`one-to-many`) `*AndSelect` join is present, the JOIN
   * multiplies root rows, so a plain `COUNT(*)` over the joined row set
   * overcounts. In that case — and only when there is no GROUP BY / HAVING —
   * the count is taken over distinct root entities via a
   * `COUNT(*) FROM (SELECT DISTINCT <root pk> ...) ` wrapper, which is portable
   * across MySQL / PostgreSQL / SQLite and composite-PK safe. Hand-written
   * joins added through `leftJoin()/innerJoin()` without a joined selection
   * keep the plain `COUNT(*)` behavior (the caller may genuinely want the
   * multiplied row count).
   *
   * With a GROUP BY the query yields one row per group, so the count is the
   * **number of groups** surviving HAVING — the same contract
   * `EntityManager.findAndCount()` / `findWithPage()` apply to
   * `FindOption.groupBy`, which keeps `getManyAndCount()` / `paginate()`
   * totals consistent with the grouped rows they accompany. It is computed as
   * `COUNT(*) FROM (SELECT 1 ... GROUP BY ... HAVING ...)`. Per-group sizes
   * are not what this method returns: project them explicitly, e.g.
   * `addSelect(u.id.count().as("cnt"))` + `getRawMany()`.
   */
  async getCount(): Promise<number> {
    const internals = this.emInternals._ctx;
    const dbType = internals.isMySqlFamily()
      ? "mysql"
      : internals.isSqlite?.()
        ? "sqlite"
        : "postgresql";

    // Distinct-root count: only when a to-many joined selection multiplies
    // rows and the query carries no GROUP BY / HAVING (a GROUP BY takes the
    // grouped branch below) and the root PK is resolvable.
    if (
      this.groupByCols.length === 0 &&
      this.havingClauses.length === 0 &&
      this.hasToManyJoinedSelection()
    ) {
      const rootPkCols = this.resolveRootPkColumns();
      if (rootPkCols.length > 0) {
        const refs = rootPkCols.map(
          (c) => `${this.em.wrap(this.alias)}.${this.em.wrap(c.name)}`,
        );
        const inner = RawQueryBuilderFactory.create() as RawQueryBuilder;
        inner.setDatabaseType(dbType);
        inner.selectDistinct(refs);
        this.applyCountSource(inner);

        const outer = RawQueryBuilderFactory.create() as RawQueryBuilder;
        outer.setDatabaseType(dbType);
        outer.select(["COUNT(*) AS count"]);
        outer.from(sql`(${inner.build()})`, `AS ${this.em.wrap("count_src")}`);

        const built = outer.build();
        const rows = await this.execQuery<{ count: string | number }>(built);
        if (rows.length === 0) return 0;
        return Number(rows[0].count);
      }
    }

    // Grouped count: the data query returns one row per group, so the total
    // paired with it must be the number of groups surviving HAVING. A bare
    // `SELECT COUNT(*) ... GROUP BY ...` yields one row per group and reading
    // its first row reports the size of an arbitrary group instead. The
    // derived table projects a constant rather than the group expressions:
    // naming those would need synthetic aliases (MySQL rejects duplicate
    // derived-table column names such as `u.id, p.id`) and a parameterized
    // expression would have to match the GROUP BY text byte-for-byte on
    // PostgreSQL.
    if (this.groupByCols.length > 0) {
      const inner = RawQueryBuilderFactory.create() as RawQueryBuilder;
      inner.setDatabaseType(dbType);
      inner.select(["1"]);
      this.applyCountSource(inner);
      inner.groupBy(this.groupByCols);
      if (this.havingClauses.length > 0) {
        inner.having(this.havingClauses);
      }

      const outer = RawQueryBuilderFactory.create() as RawQueryBuilder;
      outer.setDatabaseType(dbType);
      outer.select(["COUNT(*) AS count"]);
      outer.from(
        sql`(${inner.build()})`,
        `AS ${this.em.wrap("grouped_src")}`,
      );

      const built = outer.build();
      const rows = await this.execQuery<{ count: string | number }>(built);
      if (rows.length === 0) return 0;
      return Number(rows[0].count);
    }

    const qb = RawQueryBuilderFactory.create() as RawQueryBuilder;
    qb.setDatabaseType(dbType);
    qb.select(["COUNT(*) AS count"]);
    this.applyCountSource(qb);

    // HAVING without GROUP BY treats the whole row source as one group:
    // the single COUNT(*) row is kept or filtered out (-> 0).
    if (this.havingClauses.length > 0) {
      qb.having(this.havingClauses);
    }

    const built = qb.build();
    const rows = await this.execQuery<{ count: string | number }>(built);
    if (rows.length === 0) return 0;
    return Number(rows[0].count);
  }

  /**
   * @internal Run a scalar aggregate (SUM / AVG / MIN / MAX) over the
   * builder's current FROM / JOIN / WHERE row source. Reuses
   * {@link applyCountSource} so the soft-delete auto-filter and tenant
   * predicate match {@link getCount}. GROUP BY / HAVING / ORDER BY and
   * LIMIT / OFFSET are intentionally omitted because the result is a single
   * scalar. Mirrors `EntityManager`'s aggregate semantics: a `NULL` / empty
   * result coerces to `0`, and driver-native numeric strings (e.g. a
   * PostgreSQL `NUMERIC`) are normalized to a JS `number`.
   */
  private async aggregateScalar(
    fn: "SUM" | "AVG" | "MIN" | "MAX",
    column: ColumnOf<T>,
  ): Promise<number> {
    const internals = this.emInternals._ctx;
    const dbType = internals.isMySqlFamily()
      ? "mysql"
      : internals.isSqlite?.()
        ? "sqlite"
        : "postgresql";

    // Distinct-root aggregate: when a to-many `*AndSelect` join multiplies
    // root rows and the query carries no GROUP BY / HAVING, a plain
    // `<FN>(col)` over the joined row set counts each root's value once per
    // joined child, inflating SUM/AVG (and breaking MIN/MAX dedup). Mirror
    // getCount()'s distinct-root wrapper: aggregate the ROOT column over a
    // `SELECT DISTINCT <root pk>, <col> AS agg_val` subquery so each root
    // contributes its value exactly once.
    if (
      this.groupByCols.length === 0 &&
      this.havingClauses.length === 0 &&
      this.hasToManyJoinedSelection()
    ) {
      const rootPkCols = this.resolveRootPkColumns();
      if (rootPkCols.length > 0) {
        const refs = rootPkCols.map(
          (c) => `${this.em.wrap(this.alias)}.${this.em.wrap(c.name)}`,
        );
        const inner = RawQueryBuilderFactory.create() as RawQueryBuilder;
        inner.setDatabaseType(dbType);
        inner.selectDistinct([
          ...refs,
          `${this.resolveColumn(column)} AS ${this.em.wrap("agg_val")}`,
        ]);
        this.applyCountSource(inner);

        const outer = RawQueryBuilderFactory.create() as RawQueryBuilder;
        outer.setDatabaseType(dbType);
        outer.select([
          `${fn}(${this.em.wrap("agg_val")}) AS ${this.em.wrap("result")}`,
        ]);
        outer.from(sql`(${inner.build()})`, `AS ${this.em.wrap("agg_src")}`);

        const built = outer.build();
        const rows = await this.execQuery<{ result: string | number | null }>(
          built,
        );
        if (rows.length === 0) return 0;
        const value = rows[0].result;
        return value === null || value === undefined ? 0 : Number(value);
      }
    }

    const qb = RawQueryBuilderFactory.create() as RawQueryBuilder;
    qb.setDatabaseType(dbType);
    // resolveColumn() maps property -> DB column and escapes the identifier
    // with the driver's wrap helper, so no raw column text is concatenated.
    qb.select([
      `${fn}(${this.resolveColumn(column)}) AS ${this.em.wrap("result")}`,
    ]);
    this.applyCountSource(qb);

    const built = qb.build();
    const rows = await this.execQuery<{ result: string | number | null }>(built);
    if (rows.length === 0) return 0;
    const value = rows[0].result;
    return value === null || value === undefined ? 0 : Number(value);
  }

  /**
   * Execute a `SUM(<column>)` over the same FROM / JOIN / WHERE conditions
   * as the built query (soft-delete and tenant scoping included). Returns
   * `0` when no rows match, matching `EntityManager.sum()`.
   */
  async getSum(column: ColumnOf<T>): Promise<number> {
    return this.aggregateScalar("SUM", column);
  }

  /**
   * Execute an `AVG(<column>)` over the same FROM / JOIN / WHERE conditions
   * as the built query. Returns `0` when no rows match, matching
   * `EntityManager.avg()`.
   */
  async getAvg(column: ColumnOf<T>): Promise<number> {
    return this.aggregateScalar("AVG", column);
  }

  /**
   * Execute a `MIN(<column>)` over the same FROM / JOIN / WHERE conditions
   * as the built query. Returns `0` when no rows match, matching
   * `EntityManager.min()`.
   */
  async getMin(column: ColumnOf<T>): Promise<number> {
    return this.aggregateScalar("MIN", column);
  }

  /**
   * Execute a `MAX(<column>)` over the same FROM / JOIN / WHERE conditions
   * as the built query. Returns `0` when no rows match, matching
   * `EntityManager.max()`.
   */
  async getMax(column: ColumnOf<T>): Promise<number> {
    return this.aggregateScalar("MAX", column);
  }

  /**
   * @internal Two-phase root pagination (TypeORM-style) for queries that carry
   * a to-many `*AndSelect` join plus LIMIT/OFFSET.
   *
   * Phase 1 selects the page of distinct root primary keys honoring the
   * builder's FROM/JOIN/WHERE/ORDER BY + LIMIT/OFFSET, so the window picks
   * whole roots rather than JOIN-multiplied rows. Phase 2 re-runs the full
   * `*AndSelect` query filtered by `root.pk IN (<page>)` WITHOUT LIMIT/OFFSET,
   * hydrates as usual (full child arrays), then reorders the roots to match
   * the phase-1 page order.
   *
   * @param mode `"entity"` hydrates via getMany() (grouped roots); `"partial"`
   *             returns plain projected rows via getPartialMany().
   */
  private async fetchRootPage(
    pkCols: Array<{ name: string; propertyKey: string }>,
    mode: "entity" | "partial",
  ): Promise<TResult[]> {
    const offset = this.offsetValue ?? 0;
    const limit =
      typeof this.limitValue === "number" ? this.limitValue : undefined;

    // Phase 1: page of distinct root PKs in ORDER BY order.
    const pkRows = await this.queryRootPkPage(pkCols, offset, limit);
    if (pkRows.length === 0) return [];

    // Phase 2: full query filtered to the page's roots, unpaged. The clone has
    // no LIMIT/OFFSET, so its getMany()/getPartialMany() does not re-enter the
    // two-phase path.
    const phase2 = this.clone();
    phase2.offsetValue = undefined;
    phase2.limitValue = undefined;
    phase2.whereClauses = [
      ...phase2.whereClauses,
      this.buildRootPkInCondition(pkCols, pkRows),
    ];
    const data =
      mode === "entity"
        ? await phase2.getMany()
        : await phase2.getPartialMany();

    return this.reorderByPkPage(data, pkCols, pkRows, mode);
  }

  /**
   * @internal Build and run the phase-1 query: a `SELECT DISTINCT <root pk>`
   * over the same FROM/JOIN/WHERE/ORDER BY as the main query, windowed by
   * LIMIT/OFFSET. Returns the raw PK rows (keyed by DB column name).
   *
   * PostgreSQL requires every ORDER BY expression to appear in the
   * `SELECT DISTINCT` list, so the (string) order-by column expressions are
   * appended to the select list, deduplicated. Order-by entries backed by a
   * parameterized `Sql` expression (e.g. an aggregate/scalar expression) are
   * not added and may be rejected by PostgreSQL — such orderings are uncommon
   * for to-many root pages.
   */
  private async queryRootPkPage(
    pkCols: Array<{ name: string; propertyKey: string }>,
    offset: number,
    limit: number | undefined,
  ): Promise<Array<Record<string, unknown>>> {
    const internals = this.emInternals._ctx;
    const isMySql = internals.isMySqlFamily();
    const dbType = isMySql
      ? "mysql"
      : internals.isSqlite?.()
        ? "sqlite"
        : "postgresql";

    const qb = RawQueryBuilderFactory.create() as RawQueryBuilder;
    qb.setDatabaseType(dbType);

    const refs = pkCols.map(
      (c) => `${this.em.wrap(this.alias)}.${this.em.wrap(c.name)}`,
    );
    const selectExprs = [...refs];
    const seen = new Set(refs);
    for (const entry of this.orderByClauses) {
      if (typeof entry.column === "string" && !seen.has(entry.column)) {
        seen.add(entry.column);
        selectExprs.push(entry.column);
      }
    }
    qb.selectDistinct(selectExprs);
    this.applyCountSource(qb);

    if (this.orderByClauses.length > 0) {
      qb.appendSql(this.renderOrderBy(isMySql));
    }

    if (limit !== undefined) {
      qb.limit([offset, limit]);
    } else if (offset > 0) {
      // MySQL requires LIMIT alongside OFFSET.
      if (isMySql) qb.limit([offset, Number.MAX_SAFE_INTEGER]);
      else qb.offset(offset);
    }

    return this.execQuery<Record<string, unknown>>(qb.build());
  }

  /**
   * @internal Build the `root.pk IN (<page>)` predicate for phase 2. Uses a
   * scalar IN list for single-column PKs and a row-value tuple IN list for
   * composite PKs (`(a, b) IN ((1,2), (3,4))`) — supported by MySQL,
   * PostgreSQL, and SQLite.
   */
  private buildRootPkInCondition(
    pkCols: Array<{ name: string; propertyKey: string }>,
    pkRows: Array<Record<string, unknown>>,
  ): Sql {
    const refs = pkCols.map(
      (c) => `${this.em.wrap(this.alias)}.${this.em.wrap(c.name)}`,
    );
    if (pkCols.length === 1) {
      const values = pkRows.map((r) => r[pkCols[0].name]);
      return Conditions.in(refs[0], values);
    }
    const lhs = join(
      refs.map((r) => raw(r)),
      ", ",
    );
    const tuples = pkRows.map(
      (r) =>
        sql`(${join(
          pkCols.map((c) => sql`${r[c.name] as RawValue}`),
          ", ",
        )})`,
    );
    return sql`(${lhs}) IN (${join(tuples, ", ")})`;
  }

  /**
   * @internal Reorder phase-2 results to match the phase-1 page order, keying
   * each result by its root PK. Entity results are keyed by entity property
   * (hydrated instances); partial rows are keyed by the aliased root PK column
   * (`${alias}_${pk}`, falling back to the bare column). Multiple rows that map
   * to the same root (partial mode) are kept together and emitted in page
   * order.
   */
  private reorderByPkPage(
    data: TResult[],
    pkCols: Array<{ name: string; propertyKey: string }>,
    pkRows: Array<Record<string, unknown>>,
    mode: "entity" | "partial",
  ): TResult[] {
    const SEP = "\u0000";
    const rowKey = (r: Record<string, unknown>): string =>
      pkCols.map((c) => String(r[c.name])).join(SEP);
    const dataKey = (e: any): string =>
      mode === "entity"
        ? pkCols.map((c) => String(e?.[c.propertyKey])).join(SEP)
        : pkCols
            .map((c) => {
              const aliased = e?.[`${this.alias}_${c.name}`];
              return String(aliased !== undefined ? aliased : e?.[c.name]);
            })
            .join(SEP);

    const groups = new Map<string, TResult[]>();
    for (const e of data) {
      const k = dataKey(e);
      const g = groups.get(k);
      if (g) g.push(e);
      else groups.set(k, [e]);
    }

    const ordered: TResult[] = [];
    for (const r of pkRows) {
      const k = rowKey(r);
      const g = groups.get(k);
      if (g) {
        ordered.push(...g);
        groups.delete(k);
      }
    }
    return ordered;
  }

  /**
   * @internal Emit a debug-level warning when LIMIT/OFFSET is combined with a
   * to-many `*AndSelect` join but the root primary key cannot be resolved, so
   * two-phase root pagination is skipped and the page may truncate a root's
   * children at the boundary.
   */
  private warnUnresolvableRootPage(): void {
    new Logger("SelectQueryBuilder").debug(
      `LIMIT/OFFSET combined with a to-many *AndSelect join on ` +
        `${this.entity.name}, but the root primary key could not be resolved. ` +
        `The page is computed over JOIN-multiplied rows and may truncate a ` +
        `root's children at the page boundary.`,
    );
  }

  /**
   * Check if any rows match the conditions.
   * Uses `SELECT 1 ... LIMIT 1` for early termination instead of COUNT(*).
   */
  async exists(): Promise<boolean> {
    const tableName = this.resolveTableName();
    const qb = RawQueryBuilderFactory.create() as RawQueryBuilder;

    const internals = this.emInternals._ctx;
    if (internals.isMySqlFamily()) qb.setDatabaseType("mysql");
    else if (internals.isSqlite?.()) qb.setDatabaseType("sqlite");
    else qb.setDatabaseType("postgresql");

    qb.select(["1"]);

    // TPC polymorphic: FROM UNION ALL subquery
    if (this.tpcFromSql) {
      qb.from(sql`(${this.tpcFromSql})`, `AS ${this.em.wrap(this.alias)}`);
    } else {
      qb.from(`${this.em.wrapTable(tableName)} AS ${this.em.wrap(this.alias)}`);
    }

    for (const j of this.joinClauses) {
      qb.join(
        j.type,
        this.em.wrapTable(j.table),
        this.em.wrap(j.alias),
        this.scopedJoinCondition(j),
      );
    }

    // Soft delete auto-filter (don't mutate shared state)
    const existsWhere = [...this.whereClauses];
    const resolver = this.emInternals.resolver;
    if (resolver) {
      const deletedAtColumn = resolver.getDeletedAtColumn(this.entity);
      if (deletedAtColumn && !this.withDeletedFlag) {
        existsWhere.push(Conditions.isNull(this.col(deletedAtColumn)));
      }
    }

    this.appendTenantPredicate(existsWhere, this.entity, this.alias);

    qb.where(existsWhere);
    qb.limit(1);

    const built = qb.build();
    const rows = await this.execQuery<Record<string, unknown>>(built);
    return rows.length > 0;
  }

  /**
   * Check if any rows match the conditions — the `get`-prefixed terminal
   * alias of {@link exists}, kept consistent with the other `get*` terminals
   * (`getMany` / `getCount` / ...) and `EntityManager.exists()`. Uses the same
   * efficient `SELECT 1 ... LIMIT 1` form.
   */
  async getExists(): Promise<boolean> {
    return this.exists();
  }

  /**
   * Return the query plan for the built SELECT, mirroring
   * `EntityManager.explain()`'s {@link ExplainResult} shape. The plan is
   * computed for the exact query produced by {@link toSql} (WHERE / JOIN /
   * ORDER BY / LIMIT included), prefixed with the driver's `EXPLAIN` syntax
   * and parsed by the dialect-aware {@link ExplainQueryHandler}.
   *
   * @throws InvalidQueryError when the active driver does not support EXPLAIN.
   */
  async explain(): Promise<ExplainResult> {
    const internals = this.emInternals._ctx;
    const driver = internals.getDriver?.();
    if (!driver || !driver.supportsExplain()) {
      throw new InvalidQueryError(
        "EXPLAIN is not supported by the current database driver.",
        "Use a driver that supports EXPLAIN (MySQL, PostgreSQL, or SQLite).",
      );
    }

    const built = this.toSql();
    const explainPrefix = driver.buildExplainSql("");
    const explainQuery = sql`${raw(explainPrefix)}${built}`;
    const rawRows = await this.em.query<Record<string, unknown>>(explainQuery);

    // Reuse the dialect-aware parser EntityManager.explain() relies on so the
    // ExplainResult shape (rows/type/possibleKeys/key/cost) stays identical.
    const handler = new ExplainQueryHandler(
      this.emInternals.resolver,
      internals,
    );
    return handler.parseExplainResult(rawRows ?? []);
  }

  /**
   * Return the query as a Sql subquery with an alias (for use in FROM/JOIN).
   */
  asSubquery(alias: string): Sql {
    const built = this.toSql();
    return sql`(${built}) AS ${raw(this.em.wrap(alias))}`;
  }

  /**
   * Create a shallow clone of this query builder.
   * Useful for building variations of the same base query.
   */
  clone(): SelectQueryBuilder<T, TResult> {
    const cloned = new SelectQueryBuilder<T, TResult>(this.entity, this.alias, this.em);
    cloned.selectColumns = this.selectColumns === "*" ? "*" : [...this.selectColumns as string[]];
    cloned.distinct = this.distinct;
    cloned.whereClauses = [...this.whereClauses];
    cloned.orderByClauses = [...this.orderByClauses];
    cloned.groupByCols = [...this.groupByCols];
    cloned.havingClauses = [...this.havingClauses];
    cloned.joinClauses = [...this.joinClauses];
    cloned.limitValue = this.limitValue;
    cloned.offsetValue = this.offsetValue;
    cloned.lockClause = this.lockClause;
    cloned.cacheOption = this.cacheOption;
    cloned.withDeletedFlag = this.withDeletedFlag;
    cloned.withoutTenantScopeFlag = this.withoutTenantScopeFlag;
    cloned.extraSegments = [...this.extraSegments];
    cloned.rowValidator = this.rowValidator;
    cloned.arrayValidatorFn = this.arrayValidatorFn;
    cloned.selectedPropertyKeys = this.selectedPropertyKeys ? [...this.selectedPropertyKeys] : null;
    cloned.indexHints = [...this.indexHints];
    cloned.pgHints = [...this.pgHints];
    cloned.propertyToColumnMap = this.propertyToColumnMap;
    cloned.dialectExpression = this.dialectExpression;
    cloned.aliasRegistry = new Map(this.aliasRegistry);
    cloned.selectExpressions = [...this.selectExpressions];
    cloned.joinedSelections = [...this.joinedSelections];
    cloned.rootSelectExpanded = this.rootSelectExpanded;
    cloned.aliasedProjections = this.aliasedProjections
      ? [...this.aliasedProjections]
      : null;
    // Inheritance state
    cloned.inheritanceStrategy = this.inheritanceStrategy;
    cloned.isInheritanceChild = this.isInheritanceChild;
    cloned.isPolymorphicQuery = this.isPolymorphicQuery;
    cloned.discriminatorColumnName = this.discriminatorColumnName;
    cloned.discriminatorMap = this.discriminatorMap;
    cloned.tptParentInfo = this.tptParentInfo;
    cloned.tptSelectColumns = this.tptSelectColumns ? [...this.tptSelectColumns] : undefined;
    cloned.tptChildPrefixMap = this.tptChildPrefixMap;
    cloned.tptPolymorphicSelectColumns = this.tptPolymorphicSelectColumns
      ? [...this.tptPolymorphicSelectColumns] : undefined;
    cloned.tpcFromSql = this.tpcFromSql;
    return cloned;
  }

  // ── Private ─────────────────────────────────────────────

  /**
   * Append the `tenant_id = <current>` predicate to a WHERE-clause accumulator
   * under the `"tenant_column"` strategy. No-op when:
   *   - strategy is not `"tenant_column"`
   *   - the entity is `@NonTenantEntity()`
   *   - the current context is unscoped (`MetadataContext.runUnscoped`)
   *   - this builder has opted out via `withoutTenantScope()`
   */
  protected appendTenantPredicate(
    whereAccumulator: Sql[],
    entity: ClazzType<any>,
    alias: string,
  ): void {
    if (this.withoutTenantScopeFlag) return;
    const internals = this.emInternals._ctx;
    if (!internals?.buildTenantWhereClause) return;
    const predicate = internals.buildTenantWhereClause(entity, alias);
    if (predicate) whereAccumulator.push(predicate);
  }

  /**
   * Return a JOIN's ON condition with the tenant predicate appended when the
   * joined table maps to a tenant-scoped entity (`joinedEntity` is recorded
   * by entity-aware and relation joins). Called at render time — never at
   * join-declaration time — so the predicate binds the tenant active when
   * the query EXECUTES, and a builder constructed outside
   * `MetadataContext.run()` still scopes correctly.
   */
  protected scopedJoinCondition(j: {
    condition: Sql;
    alias: string;
    joinedEntity?: ClazzType<any>;
  }): Sql {
    if (!j.joinedEntity) return j.condition;
    const joinTenant: Sql[] = [];
    this.appendTenantPredicate(joinTenant, j.joinedEntity, j.alias);
    if (joinTenant.length === 0) return j.condition;
    return sql`${j.condition} AND ${joinTenant[0]}`;
  }

  /**
   * Validate that all required (non-nullable) columns are included in
   * the select() projection. Only runs when select() was called with
   * specific columns. Throws OrmError if required columns are missing.
   */
  protected validateRequiredColumns(): void {
    if (this.selectedPropertyKeys === null) return;

    const columns: ColumnMetadata[] =
      Reflect.getMetadata(COLUMN_TOKEN, this.entity.prototype) ??
      Reflect.getMetadata(COLUMN_TOKEN, this.entity) ??
      [];

    if (columns.length === 0) return;

    const selectedSet = new Set(this.selectedPropertyKeys);
    const missing: string[] = [];

    for (const col of columns) {
      const opts = col.options ?? ({} as any);
      const isRequired =
        opts.nullable !== true &&
        opts.default === undefined &&
        opts.autoIncrement !== true;

      const key = col.propertyKey ?? col.name;
      if (isRequired && key && !selectedSet.has(key)) {
        missing.push(key);
      }
    }

    if (missing.length > 0) {
      throw new OrmError(
        OrmErrorCode.MISSING_REQUIRED_COLUMNS,
        `getMany() requires all non-nullable columns when using select(). ` +
          `Missing: [${missing.join(", ")}]. ` +
          `Use getPartialMany() to skip this check.`,
      );
    }
  }

  /**
   * Apply row-level and/or array-level validation to query results.
   * When no validators are attached, returns the rows as-is (zero overhead).
   */
  protected applyValidation(rows: any[]): TResult[] {
    let result = rows as TResult[];

    // Row-level validation
    if (this.rowValidator) {
      const v = this.rowValidator;
      if (typeof v === "function") {
        result = result.map(v);
      } else {
        // Zod-style: object with .parse() method
        result = result.map((row) => v.parse(row));
      }
    }

    // Array-level validation
    if (this.arrayValidatorFn) {
      const v = this.arrayValidatorFn;
      if (typeof v === "function") {
        result = v(result);
      } else {
        result = v.parse(result);
      }
    }

    return result;
  }

  protected resolveTableName(): string {
    const resolver = this.emInternals.resolver;
    if (!resolver) {
      throw new OrmError(
        OrmErrorCode.ENTITY_METADATA_NOT_FOUND,
        `EntityManager not connected. Cannot resolve table name for ${this.entity.name}.`,
      );
    }
    const metadata = resolver.resolveEntityMetadata(this.entity);
    if (!metadata) {
      throw new OrmError(
        OrmErrorCode.ENTITY_METADATA_NOT_FOUND,
        `Entity metadata not found for ${this.entity.name}. Did you register the entity?`,
      );
    }
    return metadata.name;
  }

  /**
   * @internal Render the accumulated ORDER BY list as a single SQL fragment.
   *
   * Handles two cross-dialect concerns:
   * - NULLS FIRST / NULLS LAST: native on PostgreSQL & SQLite (≥3.30),
   *   emulated on MySQL via `col IS NULL` ordering prefix.
   * - Aggregate-as-order-target: `isRaw` entries already contain a rendered
   *   SQL fragment (e.g. `COUNT("u"."id")`) and bypass identifier wrapping.
   */
  protected renderOrderBy(isMySqlFamily: boolean): Sql {
    const parts: Sql[] = this.orderByClauses.map((entry) => {
      const dir = entry.direction;
      if (dir !== "ASC" && dir !== "DESC") {
        throw new OrmError(
          OrmErrorCode.QUERY_ERROR,
          `Invalid ORDER BY direction: ${dir}`,
        );
      }
      // `column` may be a string (pre-resolved identifier or fragment) or a
      // parameterized `Sql` (ScalarExpression-sourced — bindings preserved).
      const colSql: Sql =
        typeof entry.column === "string" ? sql`${raw(entry.column)}` : entry.column;

      if (!entry.nulls) {
        return sql`${colSql} ${raw(dir)}`;
      }

      if (isMySqlFamily) {
        // MySQL has no NULLS FIRST/LAST keyword. Default ordering already
        // places NULLs first on ASC, last on DESC; flip it when the user
        // asks for the opposite by prefixing with `(col IS NULL) <dir>`.
        const defaultNullsFirst = dir === "ASC";
        const wantNullsFirst = entry.nulls === "FIRST";
        if (defaultNullsFirst === wantNullsFirst) {
          return sql`${colSql} ${raw(dir)}`;
        }
        // To float NULLs to the opposite side: order by (col IS NULL) first.
        // IS NULL → 1 (NULL rows), else 0; sorting DESC surfaces NULLs first.
        const nullPriority = wantNullsFirst ? "DESC" : "ASC";
        return sql`${colSql} IS NULL ${raw(nullPriority)}, ${colSql} ${raw(dir)}`;
      }

      // Postgres / SQLite: native NULLS clause.
      return sql`${colSql} ${raw(dir)} NULLS ${raw(entry.nulls)}`;
    });

    return sql`ORDER BY ${join(parts, ", ")}`;
  }

  protected resolveCondition(
    columnOrCondition:
      | string
      | Sql
      | ColumnCondition
      | JsonPathCondition
      | AggregateCondition
      | LogicalCondition
      | ConditionLike,
    operatorOrValue?: any,
    value?: any,
  ): Sql {
    // All QueryDSL conditions share the ConditionLike contract: column
    // refs are deferred, so resolve them through the builder's registry
    // and thread the dialect through for JSON / case-insensitive ops.
    if (isConditionLike(columnOrCondition)) {
      return columnOrCondition.resolve(
        (ref) => this.resolveColumn(ref),
        this.dialectExpression,
      );
    }

    // Overload 1: raw Sql condition
    if (typeof columnOrCondition !== "string") {
      return columnOrCondition;
    }

    const column = columnOrCondition;
    const qualified = this.resolveColumn(column);

    // Overload 2: where("name", "Alice") — 2 args, equals
    if (value === undefined) {
      const val = operatorOrValue;
      if (val === null) {
        return Conditions.isNull(qualified);
      }
      if (val instanceof Object && "sql" in val) {
        // Sql object passed as value
        return sql`${raw(qualified)} = ${val}`;
      }
      if (Array.isArray(val)) {
        return Conditions.in(qualified, val);
      }
      return Conditions.equals(qualified, val);
    }

    // Overload 3: where("age", ">=", 18) — 3 args, operator
    const operator = operatorOrValue as string;
    const normalizedOp = operator.trim().toUpperCase() as WhereOperator;

    switch (normalizedOp) {
      case "=":
        // `col = NULL` is always UNKNOWN; rewrite to IS NULL so the explicit
        // operator form matches the two-arg `where(col, null)` shorthand.
        if (value === null) return Conditions.isNull(qualified);
        return Conditions.equals(qualified, value);
      case "!=":
      case "<>":
        if (value === null) return Conditions.isNotNull(qualified);
        return Conditions.notEquals(qualified, value);
      case ">":
        return Conditions.gt(qualified, value);
      case ">=":
        return Conditions.gte(qualified, value);
      case "<":
        return Conditions.lt(qualified, value);
      case "<=":
        return Conditions.lte(qualified, value);
      case "LIKE":
        return Conditions.like(qualified, value);
      case "NOT LIKE":
        return Conditions.notLike(qualified, value);
      case "ILIKE":
        if (this.dialectExpression) {
          return this.dialectExpression.ilike(qualified, value);
        }
        return sql`${raw(qualified)} ILIKE ${value}`;
      case "IN":
        return Conditions.in(qualified, Array.isArray(value) ? value : [value]);
      case "NOT IN":
        return Conditions.notIn(
          qualified,
          Array.isArray(value) ? value : [value],
        );
      case "IS NULL":
        return Conditions.isNull(qualified);
      case "IS NOT NULL":
        return Conditions.isNotNull(qualified);
      case "BETWEEN":
        if (Array.isArray(value) && value.length === 2) {
          return Conditions.between(qualified, value[0], value[1]);
        }
        throw new OrmError(
          OrmErrorCode.INVALID_QUERY,
          `BETWEEN operator requires an array of [min, max]. Got: ${typeof value}`,
        );
      default:
        throw new OrmError(
          OrmErrorCode.INVALID_QUERY,
          `Unsupported operator: "${operator}". Use =, !=, <>, <, >, <=, >=, LIKE, IN, NOT IN, IS NULL, IS NOT NULL, BETWEEN.`,
        );
    }
  }

  // ── Inheritance deserialization ─────────────────────────

  /**
   * STI/TPC polymorphic: read discriminator value from each row and
   * instantiate the correct subclass.
   */
  private deserializePolymorphic(rows: any[]): any[] {
    const registry = DeserializerRegistry.getInstance();
    const discColName = this.discriminatorColumnName!;
    const discMap = this.discriminatorMap!;

    return rows.map((row) => {
      const discValue = row[discColName];
      const TargetClass =
        (discValue != null ? discMap.get(String(discValue)) : undefined) ??
        this.entity;
      return registry.deserialize(TargetClass, row);
    });
  }

  /**
   * TPT polymorphic: read discriminator, strip child table prefixes,
   * and instantiate correct subclass.
   */
  private deserializeTPTPolymorphic(rows: any[]): any[] {
    const registry = DeserializerRegistry.getInstance();
    const discColName = this.discriminatorColumnName!;
    const discMap = this.discriminatorMap!;
    const childPrefixMap = this.tptChildPrefixMap!;
    const allPrefixes = new Set(childPrefixMap.values());

    return rows.map((row) => {
      const discValue = row[discColName];
      const TargetClass =
        (discValue != null ? discMap.get(String(discValue)) : undefined) ??
        this.entity;

      if (TargetClass === this.entity) {
        // Root entity: strip all prefixed columns
        const cleaned: Record<string, any> = {};
        for (const key of Object.keys(row)) {
          let isPrefixed = false;
          for (const prefix of allPrefixes) {
            if (key.startsWith(`${prefix}_`)) {
              isPrefixed = true;
              break;
            }
          }
          if (!isPrefixed) {
            cleaned[key] = row[key];
          }
        }
        return registry.deserialize(TargetClass, cleaned);
      }

      // Child entity: move matching prefix columns to unprefixed names
      const matchingPrefix = childPrefixMap.get(String(discValue));
      const cleaned: Record<string, any> = {};
      for (const key of Object.keys(row)) {
        let isPrefixed = false;
        for (const prefix of allPrefixes) {
          if (key.startsWith(`${prefix}_`)) {
            isPrefixed = true;
            if (prefix === matchingPrefix) {
              cleaned[key.substring(prefix.length + 1)] = row[key];
            }
            break;
          }
        }
        if (!isPrefixed) {
          cleaned[key] = row[key];
        }
      }
      return registry.deserialize(TargetClass, cleaned);
    });
  }
}
