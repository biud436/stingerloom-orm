/* eslint-disable @typescript-eslint/no-explicit-any */
import sql, { Sql, raw } from "../utils/sqlTag";
import { ClazzType } from "../utils";
import { InheritanceResolver } from "./InheritanceResolver";
import { RelationMetadataResolver } from "./RelationMetadataResolver";
import { collectTableComputedColumns, declaredComputedColumns } from "./generators/entityColumns";

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
 * the root's own columns, the join columns of the relations it declares and
 * its `@ComputedColumn`s. Every other column of a child lives on the child's
 * table.
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
  for (const computed of declaredComputedColumns(root)) {
    columns.add(computed.name);
  }
  return columns;
}

/**
 * The join columns a JOINED child's own table holds: those of the relations
 * the child declares. The relations it inherits keep theirs on the root's
 * table (see {@link joinedRootColumns}).
 */
export function joinedChildJoinColumns(
  resolver: RelationMetadataResolver,
  child: ClazzType<any>,
  root: ClazzType<any>,
): Set<string> {
  const rootColumns = joinedRootColumns(resolver, root);
  const columns = new Set<string>();
  for (const rel of [
    ...resolver.resolveManyToOneMetadata(child),
    ...resolver.resolveOneToOneMetadata(child),
  ]) {
    if (rel.joinColumn && !rootColumns.has(rel.joinColumn)) {
      columns.add(rel.joinColumn);
    }
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

  // The child's own columns, generated ones included, and the join columns
  // of the relations it declares; the rest, inherited, are read from the
  // root.
  const childColumns = new Set<string>();
  for (const col of childMeta.columns) childColumns.add(col.name);
  for (const rel of resolver.resolveManyToOneMetadata(child)) {
    if (rel.joinColumn) childColumns.add(rel.joinColumn);
  }
  for (const rel of resolver.resolveOneToOneMetadata(child)) {
    if (rel.joinColumn) childColumns.add(rel.joinColumn);
  }
  for (const computed of declaredComputedColumns(child)) {
    childColumns.add(computed.name);
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

/**
 * True when `entity` is the root of a JOINED hierarchy with subclasses: a row
 * of it may be a subclass's, whose own columns live on that subclass's table.
 */
export function isJoinedPolymorphicRoot(
  inheritanceResolver: InheritanceResolver,
  entity: ClazzType<any>,
): boolean {
  return (
    inheritanceResolver.getStrategy(entity) === "JOINED" &&
    inheritanceResolver.isPolymorphicQuery(entity)
  );
}

/** The subclasses of a JOINED root, each with a table of its own. */
export function joinedSubclasses(
  inheritanceResolver: InheritanceResolver,
  root: ClazzType<any>,
): ClazzType<any>[] {
  return inheritanceResolver.getConcreteEntities(root).filter((c) => c !== root);
}

/**
 * Discriminator value → subclass table name: the prefix a polymorphic read
 * of a JOINED root gives each subclass's own columns (see
 * {@link joinedSubclassColumns}).
 */
export function joinedSubclassPrefixes(
  ctx: Pick<JoinedChildSourceContext, "inheritanceResolver" | "resolver">,
  root: ClazzType<any>,
): Map<string, string> {
  const prefixes = new Map<string, string>();
  for (const child of joinedSubclasses(ctx.inheritanceResolver, root)) {
    const childMeta = ctx.resolver.resolveEntityMetadata(child);
    const value = ctx.inheritanceResolver.getDiscriminatorValue(child);
    if (childMeta && value) prefixes.set(value, childMeta.name);
  }
  return prefixes;
}

/**
 * The columns each subclass table of a JOINED root holds besides the shared
 * key — its own columns, the join columns of the relations it declares and
 * its generated columns — as a polymorphic read selects them:
 * `child.column AS "<childTable>_<column>"`, so the columns of two
 * subclasses never share a name. `alias` is that output name.
 */
export function joinedSubclassColumns(
  ctx: Pick<JoinedChildSourceContext, "inheritanceResolver" | "resolver" | "wrap">,
  root: ClazzType<any>,
): Array<{ table: string; column: string; select: string; alias: string }> {
  const { inheritanceResolver, resolver, wrap } = ctx;
  const columns: Array<{ table: string; column: string; select: string; alias: string }> = [];
  const pk = resolver.resolveEntityMetadata(root)?.columns.find((c: any) => c.options?.primary);
  if (!pk) return columns;
  for (const child of joinedSubclasses(inheritanceResolver, root)) {
    const childMeta = resolver.resolveEntityMetadata(child);
    if (!childMeta) continue;
    const childTable = childMeta.name;
    const names = new Set(
      inheritanceResolver.getOwnColumns(child).map((col) => col.name as string),
    );
    for (const name of joinedChildJoinColumns(resolver, child, root)) names.add(name);
    for (const computed of collectTableComputedColumns(child)) names.add(computed.name);
    for (const name of names) {
      const alias = `${childTable}_${name}`;
      columns.push({
        table: childTable,
        column: name,
        select: `${wrap(childTable)}.${wrap(name)} AS ${wrap(alias)}`,
        alias,
      });
    }
  }
  return columns;
}

/**
 * How a read of a JOINED root refers to `column`: the root's own columns
 * through `root(column)`; a column only subclass tables hold through
 * `child(table, column)` of the one subclass that declares it, or — when
 * several do — the first non-null of them, since each row has exactly one
 * subclass row. Returns the qualifier, built once per read.
 */
export function joinedRootColumnQualifier(
  ctx: Pick<JoinedChildSourceContext, "inheritanceResolver" | "resolver" | "wrap">,
  root: ClazzType<any>,
  refs: {
    root: (column: string) => string;
    child: (table: string, column: string, alias: string) => string;
  },
): (column: string) => string {
  const rootColumns = joinedRootTableColumns(ctx.resolver, root);
  const holders = new Map<string, Array<{ table: string; alias: string }>>();
  for (const { table, column, alias } of joinedSubclassColumns(ctx, root)) {
    if (rootColumns.has(column)) continue;
    const list = holders.get(column) ?? [];
    list.push({ table, alias });
    holders.set(column, list);
  }
  return (column) => {
    const tables = holders.get(column);
    if (!tables) return refs.root(column);
    const refList = tables.map(({ table, alias }) => refs.child(table, column, alias));
    return refList.length === 1 ? refList[0] : `COALESCE(${refList.join(", ")})`;
  };
}

/**
 * The subclass tables of a JOINED root that hold `column` when the root's
 * table does not — empty for a root column.
 */
export function joinedSubclassColumnHolders(
  ctx: Pick<JoinedChildSourceContext, "inheritanceResolver" | "resolver" | "wrap">,
  root: ClazzType<any>,
  column: string,
): Array<{ table: string; alias: string }> {
  if (joinedRootTableColumns(ctx.resolver, root).has(column)) return [];
  return joinedSubclassColumns(ctx, root)
    .filter((col) => col.column === column)
    .map(({ table, alias }) => ({ table, alias }));
}

/**
 * `SELECT <root columns>, <subclass columns as childTable_column> FROM root
 * LEFT JOIN child ...` — a JOINED root's rows with each subclass's own
 * columns, as find() on the root reads them. `rootColumns` are the root
 * table's columns the read selects. Wrapped as a derived table, a statement
 * reads the root's columns under their bare names.
 *
 * Null when the root has no metadata or no primary key.
 */
export function buildJoinedRootSelect(
  ctx: JoinedChildSourceContext,
  root: ClazzType<any>,
  rootColumns: readonly string[],
): Sql | null {
  const { inheritanceResolver, resolver, wrap, wrapTable } = ctx;
  const rootMeta = resolver.resolveEntityMetadata(root);
  const pk = rootMeta?.columns.find((c: any) => c.options?.primary);
  if (!rootMeta || !pk) return null;
  const rootTable = wrap(rootMeta.name);
  const columns = [
    ...rootColumns.map((name) => `${rootTable}.${wrap(name)}`),
    ...joinedSubclassColumns(ctx, root).map((col) => col.select),
  ];
  const joins: string[] = [];
  for (const child of joinedSubclasses(inheritanceResolver, root)) {
    const childMeta = resolver.resolveEntityMetadata(child);
    if (!childMeta) continue;
    const childTable = wrap(childMeta.name);
    joins.push(
      ` LEFT JOIN ${wrapTable(childMeta.name)} AS ${childTable} ON ${rootTable}.${wrap(pk.name)} = ${childTable}.${wrap(pk.name)}`,
    );
  }
  return sql`SELECT ${raw(columns.join(", "))} FROM ${raw(wrapTable(rootMeta.name))} AS ${raw(rootTable)}${raw(joins.join(""))}`;
}

/** Every column of a JOINED root's table: its key and {@link joinedRootColumns}. */
function joinedRootTableColumns(
  resolver: RelationMetadataResolver,
  root: ClazzType<any>,
): Set<string> {
  const columns = joinedRootColumns(resolver, root);
  for (const col of resolver.resolveEntityMetadata(root)?.columns ?? []) {
    if (col.options?.primary) columns.add(col.name);
  }
  return columns;
}
