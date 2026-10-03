/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../utils/types";
import type { InheritanceResolver } from "./InheritanceResolver";
import type { RelationMetadataResolver } from "./RelationMetadataResolver";
import { entityRowColumns } from "./TpcUnionSource";

/** Cuts one raw row down to the columns of the class it is read as. */
export type RowShape = (entityClass: ClazzType<any>, row: Record<string, any>) => Record<string, any>;

/**
 * The row shape of a SINGLE_TABLE hierarchy, or undefined for an entity
 * outside one.
 *
 * A single-table row carries every subtype's columns and the
 * discriminator — what a `RETURNING *` hands back and what a polymorphic
 * root read selects. An instance holds the columns of its own class
 * (inherited ones included), the shape `find()` on that class gives it: a
 * sibling subtype's columns are dropped, and the discriminator stays only
 * where the class declares it as a `@Column`. Keys outside the hierarchy's
 * columns — the aliases of JOINed relations, generated values — are kept.
 */
export function singleTableRowShape(
  ctx: { inheritanceResolver: InheritanceResolver; resolver: RelationMetadataResolver },
  entity: ClazzType<any>,
): RowShape | undefined {
  const { inheritanceResolver, resolver } = ctx;
  if (inheritanceResolver.getStrategy(entity) !== "SINGLE_TABLE") return undefined;

  const root = inheritanceResolver.getRoot(entity) ?? entity;
  const classes = new Set<ClazzType<any>>([
    root,
    entity,
    ...inheritanceResolver.buildDiscriminatorMap(root).values(),
  ]);

  const own = new Map<ClazzType<any>, Set<string>>();
  const hierarchy = new Set<string>();
  for (const cls of classes) {
    const columns = new Set(entityRowColumns(resolver, cls));
    own.set(cls, columns);
    for (const column of columns) hierarchy.add(column);
  }
  const discriminator = inheritanceResolver.getDiscriminatorColumn(root)?.name;
  if (discriminator) hierarchy.add(discriminator);

  // The registered root carries the whole table — every subtype's columns
  // and the discriminator — for the DDL. Its own columns are the ones every
  // subclass inherits: a subtype's column is missing from its siblings, the
  // injected discriminator from all of them (a discriminator declared as a
  // @Column on the root is inherited, and stays).
  const subclasses = [...classes].filter((cls) => cls !== root);
  const rootColumns = [...own.get(root)!];
  own.set(
    root,
    new Set(
      subclasses.length > 0
        ? rootColumns.filter((column) => subclasses.every((cls) => own.get(cls)!.has(column)))
        : rootColumns.filter((column) => column !== discriminator),
    ),
  );

  return (entityClass, row) => {
    const keep = own.get(entityClass) ?? own.get(entity)!;
    const shaped: Record<string, any> = {};
    for (const key in row) {
      if (!hierarchy.has(key) || keep.has(key)) shaped[key] = row[key];
    }
    return shaped;
  };
}

/** {@link singleTableRowShape} applied to rows all read as `entity`. */
export function shapeSingleTableRows<R extends Record<string, any>>(
  ctx: { inheritanceResolver: InheritanceResolver; resolver: RelationMetadataResolver },
  entity: ClazzType<any>,
  rows: R[],
): R[] {
  const shape = singleTableRowShape(ctx, entity);
  return shape ? (rows.map((row) => shape(entity, row)) as R[]) : rows;
}
