/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../utils";
import type { InheritanceResolver } from "./InheritanceResolver";
import type { RelationMetadataResolver } from "./RelationMetadataResolver";
import { joinedSubclassRow, type RowClassifier } from "./ResultTransformer";
import { singleTableRowShape } from "./SingleTableRows";
import { joinedSubclassPrefixes } from "./JoinedChildSource";

/**
 * How a row of `entity` is built when `entity` is the root of a
 * SINGLE_TABLE or JOINED hierarchy with subclasses: as the subclass its
 * discriminator names, holding that class's columns only — the instance a
 * read of the root builds. Undefined for any other entity, whose rows are
 * built as itself.
 *
 * A JOINED row carries each subclass's own columns as
 * `<childTable>_<column>` (see buildJoinedRootSelect). A TABLE_PER_CLASS
 * root is not covered: a key that points at it names a row of the root's
 * own table.
 */
export function polymorphicRowClassifier(
  ctx: { inheritanceResolver: InheritanceResolver; resolver: RelationMetadataResolver },
  entity: ClazzType<any>,
): RowClassifier | undefined {
  const { inheritanceResolver } = ctx;
  const strategy = inheritanceResolver.getStrategy(entity);
  if (strategy !== "SINGLE_TABLE" && strategy !== "JOINED") return undefined;
  if (!inheritanceResolver.isPolymorphicQuery(entity)) return undefined;
  const discriminatorMap = inheritanceResolver.buildDiscriminatorMap(entity);
  const discriminatorColumn = inheritanceResolver.getDiscriminatorColumn(entity)?.name;
  if (discriminatorMap.size === 0 || !discriminatorColumn) return undefined;

  const classOf = (value: unknown): ClazzType<any> =>
    (value != null ? discriminatorMap.get(String(value)) : undefined) ?? entity;

  if (strategy === "SINGLE_TABLE") {
    const shape = singleTableRowShape(ctx, entity);
    return (row) => {
      const entityClass = classOf(row[discriminatorColumn]);
      return { entityClass, row: shape ? shape(entityClass, row) : row };
    };
  }

  const prefixes = joinedSubclassPrefixes(ctx, entity);
  const allPrefixes = new Set(prefixes.values());
  return (row) => {
    const value = row[discriminatorColumn];
    const prefix = value != null ? prefixes.get(String(value)) : undefined;
    return {
      entityClass: classOf(value),
      row: joinedSubclassRow(row, discriminatorColumn, prefix, allPrefixes),
    };
  };
}
