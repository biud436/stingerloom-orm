/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql, join, raw } from "../utils/sqlTag";
import { ClazzType } from "../utils";
import { InheritanceResolver } from "./InheritanceResolver";
import { RelationMetadataResolver } from "./RelationMetadataResolver";

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
 * The UNION ALL body a TABLE_PER_CLASS root reads from: every concrete table
 * projected onto the hierarchy's full column set (columns a table lacks are
 * padded to NULL) plus the discriminator as a literal. Wrap it in parentheses
 * and alias it (see {@link TPC_UNION_ALIAS}) to use it as a FROM source.
 *
 * Shared by find(), the aggregates, cursor pagination and the
 * SelectQueryBuilder so every root read sees the same rows.
 */
export function buildTpcUnionSource(
  ctx: TpcSourceContext,
  root: ClazzType<any>,
  discriminatorColumnName?: string,
): Sql {
  const { inheritanceResolver, resolver, wrap, wrapTable } = ctx;
  const allHierarchyCols = inheritanceResolver
    .getAllHierarchyColumns(root)
    .map((c) => c.name);
  const discColName =
    discriminatorColumnName ??
    inheritanceResolver.getDiscriminatorColumn(root)?.name ??
    "dtype";

  const subQueries: Sql[] = [];
  for (const { entity, tableName } of resolveTpcTables(ctx, root)) {
    const entMeta = resolver.resolveEntityMetadata(entity)!;
    const entColNames = new Set(entMeta.columns.map((c: any) => c.name));
    const discVal =
      inheritanceResolver.getDiscriminatorValue(entity) ?? entity.name;

    const colExprs: Sql[] = allHierarchyCols.map((colName) =>
      entColNames.has(colName)
        ? sql`${raw(wrap(colName))}`
        : sql`NULL AS ${raw(wrap(colName))}`,
    );
    colExprs.push(sql`${discVal} AS ${raw(wrap(discColName))}`);

    subQueries.push(
      sql`SELECT ${join(colExprs, ", ")} FROM ${raw(wrapTable(tableName))}`,
    );
  }

  return join(subQueries, " UNION ALL ");
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
