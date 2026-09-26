/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql, raw } from "../utils/sqlTag";
import { ClazzType } from "../utils";
import { InheritanceResolver } from "./InheritanceResolver";
import { RelationMetadataResolver } from "./RelationMetadataResolver";

/** Alias the JOINED-child derived table is read under. */
export const JOINED_CHILD_ALIAS = "_tpt";

export interface JoinedChildSourceContext {
  inheritanceResolver: InheritanceResolver;
  resolver: RelationMetadataResolver;
  wrap: (identifier: string) => string;
  wrapTable: (tableName: string) => string;
}

/**
 * True when `entity` is a child of a JOINED (table-per-type) hierarchy: its
 * rows are split between the root's table, which holds every inherited
 * column, and its own table, which holds the shared primary key and the
 * columns the child declares.
 */
export function isJoinedChild(
  inheritanceResolver: InheritanceResolver,
  entity: ClazzType<any>,
): boolean {
  return (
    inheritanceResolver.getStrategy(entity) === "JOINED" &&
    inheritanceResolver.isChildEntity(entity)
  );
}

/**
 * The columns a JOINED hierarchy's root table holds besides the shared key:
 * the root's own columns and the join columns of the relations it declares.
 * Every other column of a child lives on the child's table.
 */
export function joinedRootColumns(
  resolver: RelationMetadataResolver,
  root: ClazzType<any>,
): Set<string> {
  const rootMeta = resolver.resolveEntityMetadata(root);
  const columns = new Set<string>();
  for (const col of rootMeta?.columns ?? []) {
    if (!col.options?.primary) columns.add(col.name);
  }
  for (const rel of resolver.resolveManyToOneMetadata(root)) {
    if (rel.joinColumn) columns.add(rel.joinColumn);
  }
  for (const rel of resolver.resolveOneToOneMetadata(root)) {
    if (rel.joinColumn) columns.add(rel.joinColumn);
  }
  return columns;
}

/**
 * `SELECT ... FROM child INNER JOIN root ON <pk>` — a JOINED child's rows
 * with every column under its bare name: the child table's key, own columns
 * and relation join columns, then the root's (see {@link joinedRootColumns}).
 * Wrapped as a derived table (see {@link buildJoinedChildFromSource}), a
 * statement that names columns unqualified — the aggregates, cursor
 * pagination — reads it like a single table.
 *
 * Null when the child or its root has no metadata or no primary key.
 */
export function buildJoinedChildSelect(
  ctx: JoinedChildSourceContext,
  child: ClazzType<any>,
): Sql | null {
  const { inheritanceResolver, resolver, wrap, wrapTable } = ctx;
  const root = inheritanceResolver.getRoot(child);
  const childMeta = resolver.resolveEntityMetadata(child);
  const rootMeta = root ? resolver.resolveEntityMetadata(root) : undefined;
  const pk = childMeta?.columns.find((c: any) => c.options?.primary);
  if (!root || !childMeta || !rootMeta || !pk) return null;

  const childTable = wrap(childMeta.name);
  const rootTable = wrap(rootMeta.name);
  const rootColumns = joinedRootColumns(resolver, root);

  // The child's own columns and the join columns of the relations it
  // declares; the rest, inherited, are read from the root.
  const childColumns = new Set<string>();
  for (const col of childMeta.columns) childColumns.add(col.name);
  for (const rel of resolver.resolveManyToOneMetadata(child)) {
    if (rel.joinColumn) childColumns.add(rel.joinColumn);
  }
  for (const rel of resolver.resolveOneToOneMetadata(child)) {
    if (rel.joinColumn) childColumns.add(rel.joinColumn);
  }

  const columns: string[] = [];
  for (const name of childColumns) {
    if (!rootColumns.has(name)) columns.push(`${childTable}.${wrap(name)}`);
  }
  for (const name of rootColumns) columns.push(`${rootTable}.${wrap(name)}`);

  const wrappedPk = wrap(pk.name);
  return sql`SELECT ${raw(columns.join(", "))} FROM ${raw(wrapTable(childMeta.name))} AS ${raw(childTable)} INNER JOIN ${raw(wrapTable(rootMeta.name))} AS ${raw(rootTable)} ON ${raw(childTable)}.${raw(wrappedPk)} = ${raw(rootTable)}.${raw(wrappedPk)}`;
}

/**
 * `(<select>) AS "_tpt"` — the FROM source of a JOINED child read that names
 * columns unqualified. Null under the same conditions as
 * {@link buildJoinedChildSelect}.
 */
export function buildJoinedChildFromSource(
  ctx: JoinedChildSourceContext,
  child: ClazzType<any>,
): Sql | null {
  const select = buildJoinedChildSelect(ctx, child);
  return select ? sql`(${select}) AS ${raw(ctx.wrap(JOINED_CHILD_ALIAS))}` : null;
}
