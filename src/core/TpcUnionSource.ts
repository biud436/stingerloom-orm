/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql, join, raw } from "../utils/sqlTag";
import { ClazzType } from "../utils";
import { InheritanceResolver } from "./InheritanceResolver";
import { RelationMetadataResolver } from "./RelationMetadataResolver";
import { declaredComputedColumns } from "./generators/entityColumns";
import type { EntityManagerInternals } from "./EntityManagerInternals";

/** Alias the TPC UNION ALL derived table is read under. */
export const TPC_UNION_ALIAS = "_tpc";

/** One physical table of a TABLE_PER_CLASS hierarchy. */
export interface TpcTable<T = any> {
  entity: ClazzType<T>;
  tableName: string;
}

export interface TpcSourceContext {
  inheritanceResolver: InheritanceResolver;
  resolver: RelationMetadataResolver;
  wrap: (identifier: string) => string;
  wrapTable: (tableName: string) => string;
  /**
   * Give the first table's NULL padding the column's own type when the
   * column's first holder comes third or later. PostgreSQL resolves a
   * UNION's column types pairwise from the left: two untyped NULLs resolve
   * to text, which then clashes with a later table's integer column ("UNION
   * types text and integer cannot be matched").
   */
  typedNullPadding?: boolean;
}

/**
 * The {@link TpcSourceContext} of an EntityManager: its resolvers and
 * identifier wrappers, with typed NULL padding on PostgreSQL.
 */
export function tpcSourceContextOf(
  ctx: Pick<
    EntityManagerInternals,
    "getInheritanceResolver" | "wrap" | "wrapTable" | "isPostgres"
  >,
  resolver: RelationMetadataResolver,
): TpcSourceContext {
  return {
    inheritanceResolver: ctx.getInheritanceResolver(),
    resolver,
    wrap: (n) => ctx.wrap(n),
    wrapTable: (n) => ctx.wrapTable(n),
    // Read when a UNION is built, not here: the aggregate path builds this
    // context for every entity.
    get typedNullPadding() {
      return ctx.isPostgres();
    },
  };
}

/**
 * True when `entity` is the root of a TABLE_PER_CLASS hierarchy with at least
 * one registered subclass — the case where the root's own table does not hold
 * the hierarchy's rows and a read or write on the root must span every
 * concrete table.
 */
export function isTpcPolymorphicRoot(
  inheritanceResolver: InheritanceResolver,
  entity: ClazzType<any>,
): boolean {
  return (
    inheritanceResolver.getStrategy(entity) === "TABLE_PER_CLASS" &&
    inheritanceResolver.isPolymorphicQuery(entity)
  );
}

/**
 * The concrete tables a TABLE_PER_CLASS root spans, root first. Entities
 * without resolvable metadata are skipped, mirroring the read path.
 */
export function resolveTpcTables(
  ctx: Pick<TpcSourceContext, "inheritanceResolver" | "resolver">,
  root: ClazzType<any>,
): TpcTable[] {
  const tables: TpcTable[] = [];
  for (const entity of ctx.inheritanceResolver.getConcreteEntities(root)) {
    const meta = ctx.resolver.resolveEntityMetadata(entity);
    if (!meta) continue;
    tables.push({ entity, tableName: meta.name });
  }
  return tables;
}

/**
 * The columns an entity's rows occupy, in table order: the entity's columns,
 * the join columns of its ManyToOne and owning OneToOne relations that no
 * column declares, then its `@ComputedColumn`s. For a concrete
 * TABLE_PER_CLASS entity that is its table: every concrete table repeats the
 * relations and generated columns it inherits, so a child's list carries the
 * root's as well as its own.
 */
export function entityRowColumns(
  resolver: RelationMetadataResolver,
  entity: ClazzType<any>,
): string[] {
  const columns: string[] = [];
  const seen = new Set<string>();
  const add = (name: string | undefined) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    columns.push(name);
  };
  for (const col of resolver.resolveEntityMetadata(entity)?.columns ?? []) {
    add(col.name);
  }
  for (const rel of resolver.resolveManyToOneMetadata(entity)) {
    add(rel.joinColumn);
  }
  for (const rel of resolver.resolveOneToOneMetadata(entity)) {
    add(rel.joinColumn);
  }
  for (const computed of declaredComputedColumns(entity)) {
    add(computed.name);
  }
  return columns;
}

/**
 * Every column the rows of an inheritance hierarchy occupy, root first and
 * each named once — the UNION ALL's column list for a TABLE_PER_CLASS root,
 * the shared table's for a SINGLE_TABLE root. The discriminator is left out
 * unless an entity declares it as a column.
 */
export function hierarchyRowColumns(
  ctx: Pick<TpcSourceContext, "inheritanceResolver" | "resolver">,
  root: ClazzType<any>,
): string[] {
  const columns = new Set<string>();
  for (const { entity } of resolveTpcTables(ctx, root)) {
    for (const name of entityRowColumns(ctx.resolver, entity)) columns.add(name);
  }
  return [...columns];
}

/**
 * The discriminator literal a concrete table's rows carry in the UNION ALL:
 * its `@DiscriminatorValue`, else the class name.
 */
function tpcDiscriminatorLiteral(
  inheritanceResolver: InheritanceResolver,
  entity: ClazzType<any>,
): string {
  return inheritanceResolver.getDiscriminatorValue(entity) ?? entity.name;
}

/**
 * The UNION ALL body a TABLE_PER_CLASS root reads from: every concrete table
 * projected onto the hierarchy's full column set — columns and relation join
 * columns alike, a column a table lacks padded to NULL (typed where
 * {@link TpcSourceContext.typedNullPadding} asks for it) — plus the
 * discriminator as a literal. Wrap it in parentheses and alias it (see
 * {@link TPC_UNION_ALIAS}) to use it as a FROM source.
 *
 * Shared by find(), the aggregates, cursor pagination, relation loading and
 * the SelectQueryBuilder so every root read sees the same rows.
 */
export function buildTpcUnionSource(
  ctx: TpcSourceContext,
  root: ClazzType<any>,
  discriminatorColumnName?: string,
): Sql {
  const { inheritanceResolver, resolver, wrap, wrapTable } = ctx;
  const discColName =
    discriminatorColumnName ??
    inheritanceResolver.getDiscriminatorColumn(root)?.name ??
    "dtype";

  const allHierarchyCols = hierarchyRowColumns(ctx, root);
  const tables = resolveTpcTables(ctx, root).map(({ entity, tableName }) => ({
    entity,
    tableName,
    columns: new Set(entityRowColumns(resolver, entity)),
  }));

  // Each column's first holder, by position. A column no table ahead of the
  // third holds is padded in the first table with a zero-row read of it,
  // which carries the column's type (see typedNullPadding).
  const firstHolder = new Map<string, number>();
  tables.forEach(({ columns }, index) => {
    for (const name of columns) {
      if (!firstHolder.has(name)) firstHolder.set(name, index);
    }
  });
  const pad = (colName: string, index: number): Sql => {
    const holder = firstHolder.get(colName)!;
    if (!ctx.typedNullPadding || index > 0 || holder < 2) {
      return sql`NULL AS ${raw(wrap(colName))}`;
    }
    return sql`(SELECT ${raw(wrap(colName))} FROM ${raw(wrapTable(tables[holder].tableName))} WHERE FALSE) AS ${raw(wrap(colName))}`;
  };

  const subQueries: Sql[] = [];
  tables.forEach(({ entity, tableName, columns }, index) => {
    const colExprs: Sql[] = allHierarchyCols.map((colName) =>
      columns.has(colName) ? sql`${raw(wrap(colName))}` : pad(colName, index),
    );
    colExprs.push(
      sql`${tpcDiscriminatorLiteral(inheritanceResolver, entity)} AS ${raw(wrap(discColName))}`,
    );

    subQueries.push(
      sql`SELECT ${join(colExprs, ", ")} FROM ${raw(wrapTable(tableName))}`,
    );
  });

  return join(subQueries, " UNION ALL ");
}

/**
 * Drops from each UNION ALL row the columns its own table does not hold.
 *
 * The UNION pads a sibling's columns to NULL, so without this a row came back
 * with properties its class does not declare — `floors: null` on a Vehicle,
 * and a sibling relation's join column as a raw `driver_id: null` key. Keys
 * outside the hierarchy's columns (the discriminator, the columns of a JOINed
 * relation) are kept. A row whose discriminator names no concrete table is
 * returned as is.
 *
 * @returns The rows themselves when no table lacks a column, otherwise new
 *   row objects.
 */
export function pruneTpcSiblingColumns(
  ctx: Pick<TpcSourceContext, "inheritanceResolver" | "resolver">,
  root: ClazzType<any>,
  rows: any[],
  discriminatorColumnName: string,
): any[] {
  const { inheritanceResolver, resolver } = ctx;
  const ownColumns = new Map<string, Set<string>>();
  const hierarchy = new Set<string>();
  for (const { entity } of resolveTpcTables(ctx, root)) {
    const columns = entityRowColumns(resolver, entity);
    ownColumns.set(
      tpcDiscriminatorLiteral(inheritanceResolver, entity),
      new Set(columns),
    );
    for (const name of columns) hierarchy.add(name);
  }
  const padded = [...ownColumns.values()].some(
    (columns) => columns.size < hierarchy.size,
  );
  if (!padded) return rows;

  return rows.map((row) => {
    const own = ownColumns.get(String(row[discriminatorColumnName]));
    if (!own) return row;
    const pruned: Record<string, unknown> = {};
    for (const key in row) {
      if (!hierarchy.has(key) || own.has(key)) pruned[key] = row[key];
    }
    return pruned;
  });
}

/**
 * `(<union>) AS "_tpc"` — the FROM source of a TABLE_PER_CLASS root read.
 */
export function buildTpcFromSource(
  ctx: TpcSourceContext,
  root: ClazzType<any>,
): Sql {
  return sql`(${buildTpcUnionSource(ctx, root)}) AS ${raw(ctx.wrap(TPC_UNION_ALIAS))}`;
}
