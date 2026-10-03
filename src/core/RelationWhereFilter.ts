/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../utils/types";
import sql, { Sql, join, raw } from "../utils/sqlTag";
import { InvalidQueryError } from "../errors";
import type { EntityManagerInternals } from "./EntityManagerInternals";
import type { RelationMetadataResolver } from "./RelationMetadataResolver";
import { Conditions } from "./Conditions";
import { resolveWhereClause } from "./WhereResolver";
import { createDialectExpression } from "../dialects/DialectExpression";
import { buildEntityColumnScope, type ColumnNameScope } from "./ColumnNameValidator";
import { buildTpcUnionSource, isTpcPolymorphicRoot, tpcSourceContextOf } from "./TpcUnionSource";
import { buildJoinedChildSelect, isJoinedChild } from "./JoinedChildSource";

/** Keys of a filter on a collection relation (`@OneToMany`, `@ManyToMany`). */
const COLLECTION_FILTER_KEYS = ["some", "none", "every"] as const;
/** Keys of a filter on a single-valued relation (`@ManyToOne`, `@OneToOne`). */
const TO_ONE_FILTER_KEYS = ["is", "isNot"] as const;

type RelationKind = "OneToMany" | "ManyToMany" | "ManyToOne" | "OneToOne";

/** How a related row is reached from the row a filter applies to. */
interface RelationPath {
  kind: RelationKind;
  RelatedEntity: ClazzType<any>;
  /**
   * The predicates and FROM clause that tie a related row, read under
   * `alias`, to the current row. `outer` qualifies a column of the current
   * row.
   */
  correlate: (alias: string, outer: (column: string) => string) => { from: Sql; on: Sql[] };
}

/**
 * Builds the predicates `where` filters on relations compile to: a
 * correlated `EXISTS` per filter, scoped like a relation load (soft-delete,
 * tenant, single-table subtype), with the filter's own where resolved
 * against the related entity — relation filters included, to any depth.
 */
export class RelationWhereFilterBuilder {
  constructor(
    private readonly ctx: EntityManagerInternals,
    private readonly resolver: RelationMetadataResolver,
    private readonly withDeleted: boolean | undefined,
  ) {}

  /**
   * The WhereResolver hook for rows of `entity`, whose columns `outer`
   * qualifies. `depth` keeps the aliases of nested filters apart.
   */
  hookFor(
    entity: ClazzType<any>,
    outer: (column: string) => string,
    depth = 0,
  ): (property: string, filter: Record<string, unknown>) => Sql | undefined {
    return (property, filter) => {
      const path = this.pathOf(entity, property);
      if (!path) return undefined;
      return this.compile(entity, property, path, filter, outer, depth);
    };
  }

  private compile(
    entity: ClazzType<any>,
    property: string,
    path: RelationPath,
    filter: Record<string, unknown>,
    outer: (column: string) => string,
    depth: number,
  ): Sql {
    const collection = path.kind === "OneToMany" || path.kind === "ManyToMany";
    const allowed: readonly string[] = collection ? COLLECTION_FILTER_KEYS : TO_ONE_FILTER_KEYS;
    const predicates: Sql[] = [];

    for (const [key, value] of Object.entries(filter)) {
      if (value === undefined) continue;
      if (!allowed.includes(key)) {
        throw new InvalidQueryError(
          `"${key}" cannot filter relation "${property}" of "${entity.name}": it is a ${path.kind}, ` +
            `which takes ${allowed.map((k) => `"${k}"`).join(" / ")}.`,
          collection
            ? `Write { ${property}: { some: { ... } } } — "some", "none" and "every" filter a collection.`
            : `Write { ${property}: { is: { ... } } } — "is" and "isNot" filter a single-valued relation.`,
        );
      }

      if (value === null && collection) {
        throw new InvalidQueryError(
          `"${key}" of relation "${property}" of "${entity.name}" is null; a collection filter takes a where clause.`,
          `Write { ${property}: { none: {} } } for rows with no related row, { ${property}: { some: {} } } for rows with one.`,
        );
      }

      const alias = `__rf${depth}`;
      const matches = (where: unknown) => this.existsMatching(path, alias, outer, where, depth);

      if (key === "some" || key === "is") {
        predicates.push(value === null ? sql`NOT ${this.existsMatching(path, alias, outer, undefined, depth)}` : matches(value));
      } else if (key === "none" || key === "isNot") {
        predicates.push(value === null ? this.existsMatching(path, alias, outer, undefined, depth) : sql`NOT ${matches(value)}`);
      } else {
        // every: no related row fails the where — a row the where reads as
        // unknown (a NULL column) fails it too.
        predicates.push(sql`NOT ${this.existsMatching(path, alias, outer, value, depth, true)}`);
      }
    }

    if (predicates.length === 0) return sql`1 = 1`;
    return predicates.length === 1 ? predicates[0] : Conditions.and(predicates);
  }

  /**
   * `EXISTS (SELECT 1 FROM <related> WHERE <correlation> AND <scope> AND <where>)`.
   * With `negateWhere`, the where is negated — the "every" form, where a
   * row that fails the filter, or reads it as unknown, counts against it.
   * `NOT (where)` alone would let an unknown row through (NOT UNKNOWN is
   * UNKNOWN), so the where is folded to true / false first.
   */
  private existsMatching(
    path: RelationPath,
    alias: string,
    outer: (column: string) => string,
    where: unknown,
    depth: number,
    negateWhere = false,
  ): Sql {
    const { RelatedEntity } = path;
    const relatedMetadata = this.resolver.resolveEntityMetadata(RelatedEntity);
    if (!relatedMetadata) {
      throw new InvalidQueryError(`Entity metadata for "${RelatedEntity.name}" does not exist.`);
    }
    const { from, on } = path.correlate(alias, outer);
    const conditions: Sql[] = [...on, ...this.scopeOf(RelatedEntity, alias)];

    if (where !== undefined && where !== null) {
      const inner = (column: string) => `${this.ctx.wrap(alias)}.${this.ctx.wrap(column)}`;
      const dialect = this.ctx.getDialect();
      const resolved = resolveWhereClause(where as any, {
        wrapColumn: (n) => this.ctx.wrap(n),
        qualified: true,
        tableName: alias,
        dialect,
        dialectExpression: createDialectExpression(dialect),
        propertyToColumn: this.ctx.buildPropertyToColumnMap(relatedMetadata),
        relationFilter: this.hookFor(RelatedEntity, inner, depth + 1),
      });
      if (resolved.length > 0) {
        const combined = resolved.length === 1 ? resolved[0] : Conditions.and(resolved);
        conditions.push(negateWhere ? sql`CASE WHEN (${combined}) THEN 1 ELSE 0 END = 0` : combined);
      } else if (negateWhere) {
        // every: {} — no row can fail an empty filter.
        conditions.push(sql`1 = 0`);
      }
    }

    return sql`EXISTS (SELECT 1 FROM ${from} WHERE ${join(conditions, " AND ")})`;
  }

  /** The predicates a relation load applies to `RelatedEntity` rows. */
  private scopeOf(RelatedEntity: ClazzType<any>, alias: string): Sql[] {
    const scope: Sql[] = [];
    const deletedAt = this.resolver.getDeletedAtColumn(RelatedEntity);
    if (deletedAt && !this.withDeleted) {
      scope.push(Conditions.isNull(`${this.ctx.wrap(alias)}.${this.ctx.wrap(deletedAt)}`));
    }
    const sti = this.ctx.getInheritanceResolver().getSingleTableChildDiscriminator(RelatedEntity);
    if (sti) {
      scope.push(Conditions.equals(`${this.ctx.wrap(alias)}.${this.ctx.wrap(sti.columnName)}`, sti.value));
    }
    const tenant = this.ctx.buildTenantWhereClause(RelatedEntity, alias);
    if (tenant) scope.push(tenant);
    return scope;
  }

  /**
   * `<source> AS alias` for a related entity: its table, the UNION ALL of a
   * TABLE_PER_CLASS root, or a JOINED child's two tables — the rows a
   * relation load reads.
   */
  private sourceOf(RelatedEntity: ClazzType<any>, alias: string): Sql {
    const metadata = this.resolver.resolveEntityMetadata(RelatedEntity)!;
    const inheritance = this.ctx.getInheritanceResolver();
    const context = tpcSourceContextOf(this.ctx, this.resolver);
    const wrappedAlias = raw(this.ctx.wrap(alias));
    if (isTpcPolymorphicRoot(inheritance, RelatedEntity)) {
      return sql`(${buildTpcUnionSource(context, RelatedEntity)}) AS ${wrappedAlias}`;
    }
    if (isJoinedChild(inheritance, RelatedEntity)) {
      const select = buildJoinedChildSelect(context, RelatedEntity);
      if (select) return sql`(${select}) AS ${wrappedAlias}`;
    }
    return sql`${raw(this.ctx.wrapTable(metadata.name))} AS ${wrappedAlias}`;
  }

  /**
   * The column of `keyed` a join column of relation `property` (declared on
   * `entity`) points at: the relation's `references` when it names one,
   * otherwise the single primary key. A composite key with no `references`
   * has no single column to correlate on, so the filter is refused rather
   * than matched on one part of the key.
   */
  private keyColumnOf(
    entity: ClazzType<any>,
    property: string,
    keyed: ClazzType<any>,
    references: string | undefined,
  ): string {
    if (references) return references;
    const keys = (this.resolver.resolveEntityMetadata(keyed)?.columns ?? [])
      .filter((col: any) => col.options?.primary)
      .map((col: any) => col.name as string);
    if (keys.length === 1) return keys[0];
    if (keys.length === 0) return "id";
    throw new InvalidQueryError(
      `Relation "${property}" of "${entity.name}" cannot be filtered: "${keyed.name}" has a composite primary key ` +
        `(${keys.join(", ")}) and the relation does not say which column its join column references.`,
      `Declare the referenced column on the relation that holds the join column: @ManyToOne(() => ${keyed.name}, { references: "<column>" }).`,
    );
  }

  /** How `property` of `entity` reaches its related rows; undefined when it is no relation. */
  private pathOf(entity: ClazzType<any>, property: string): RelationPath | undefined {
    const wrap = (name: string) => this.ctx.wrap(name);
    const col = (alias: string, column: string) => raw(`${wrap(alias)}.${wrap(column)}`);

    const m2o = this.resolver.resolveManyToOneMetadata(entity).find((r) => r.columnName === property);
    if (m2o) {
      const RelatedEntity = m2o.getMappingEntity() as ClazzType<any>;
      const joinColumn = m2o.joinColumn ?? `${m2o.columnName}_id`;
      const targetKey = this.keyColumnOf(entity, property, RelatedEntity, (m2o as any).references);
      return {
        kind: "ManyToOne",
        RelatedEntity,
        correlate: (alias, outer) => ({
          from: this.sourceOf(RelatedEntity, alias),
          on: [sql`${col(alias, targetKey)} = ${raw(outer(joinColumn))}`],
        }),
      };
    }

    const o2m = this.resolver.resolveOneToManyMetadata(entity).find((r) => r.propertyKey === property);
    if (o2m) {
      const RelatedEntity = o2m.getRelatedEntity();
      const owner = this.resolver
        .resolveManyToOneMetadata(RelatedEntity)
        .find((m) => m.columnName === o2m.mappedBy);
      const fkColumn = owner?.joinColumn ?? o2m.mappedBy;
      const parentKey = this.keyColumnOf(entity, property, entity, (owner as any)?.references);
      return {
        kind: "OneToMany",
        RelatedEntity,
        correlate: (alias, outer) => ({
          from: this.sourceOf(RelatedEntity, alias),
          on: [sql`${col(alias, fkColumn)} = ${raw(outer(parentKey))}`],
        }),
      };
    }

    const m2m = this.resolver.resolveManyToManyMetadata(entity).find((r) => r.propertyKey === property);
    if (m2m) {
      const RelatedEntity = m2m.getRelatedEntity();
      const joinInfo = this.resolver.resolveManyToManyJoinTable(m2m);
      if (!joinInfo) {
        throw new InvalidQueryError(
          `Relation "${property}" of "${entity.name}" cannot be filtered: no join table is known for it` +
            (m2m.mappedBy ? ` — "${m2m.mappedBy}" on "${RelatedEntity.name}" declares no joinTable.` : "."),
          `Declare the join table on the owning side: @ManyToMany(() => ${RelatedEntity.name}, { joinTable: { name, joinColumn, inverseJoinColumn } }).`,
        );
      }
      const parentKey = this.keyColumnOf(entity, property, entity, undefined);
      const relatedKey = this.keyColumnOf(entity, property, RelatedEntity, undefined);
      return {
        kind: "ManyToMany",
        RelatedEntity,
        correlate: (alias, outer) => {
          const joinAlias = `${alias}_jt`;
          return {
            from: sql`${raw(this.ctx.wrapTable(joinInfo.joinTableName))} AS ${raw(wrap(joinAlias))} INNER JOIN ${this.sourceOf(RelatedEntity, alias)} ON ${col(alias, relatedKey)} = ${col(joinAlias, joinInfo.inverseJoinColumn)}`,
            on: [sql`${col(joinAlias, joinInfo.joinColumn)} = ${raw(outer(parentKey))}`],
          };
        },
      };
    }

    const o2o = this.resolver.resolveOneToOneMetadata(entity).find((r) => r.propertyKey === property);
    if (o2o) {
      const RelatedEntity = o2o.getRelatedEntity() as ClazzType<any>;
      if (o2o.joinColumn) {
        const joinColumn = o2o.joinColumn;
        const targetKey = this.keyColumnOf(entity, property, RelatedEntity, undefined);
        return {
          kind: "OneToOne",
          RelatedEntity,
          correlate: (alias, outer) => ({
            from: this.sourceOf(RelatedEntity, alias),
            on: [sql`${col(alias, targetKey)} = ${raw(outer(joinColumn))}`],
          }),
        };
      }
      const owner = this.resolver
        .resolveOneToOneMetadata(RelatedEntity)
        .find((r) => r.propertyKey === o2o.inverseSide && !!r.joinColumn);
      if (!owner?.joinColumn) {
        throw new InvalidQueryError(
          `Relation "${property}" of "${entity.name}" cannot be filtered: it is the inverse side of a OneToOne` +
            (o2o.inverseSide
              ? ` and "${o2o.inverseSide}" on "${RelatedEntity.name}" holds no join column.`
              : ` and names no inverseSide on "${RelatedEntity.name}".`),
          `Give the owning side its column (@RelationColumn on "${RelatedEntity.name}") and name it in inverseSide.`,
        );
      }
      const ownerColumn = owner.joinColumn;
      const parentKey = this.keyColumnOf(entity, property, entity, undefined);
      return {
        kind: "OneToOne",
        RelatedEntity,
        correlate: (alias, outer) => ({
          from: this.sourceOf(RelatedEntity, alias),
          on: [sql`${col(alias, ownerColumn)} = ${raw(outer(parentKey))}`],
        }),
      };
    }

    return undefined;
  }
}

/**
 * The entity relation `property` of `entity` reaches, and the join table it
 * crosses when it is a ManyToMany; undefined when `property` is no
 * relation. What a relation filter on `property` reads.
 */
export function relationFilterTargetOf(
  resolver: RelationMetadataResolver,
  entity: ClazzType<any>,
  property: string,
): { entity: ClazzType<any>; joinTableName?: string } | undefined {
  const m2o = resolver.resolveManyToOneMetadata(entity).find((r) => r.columnName === property);
  if (m2o) return { entity: m2o.getMappingEntity() as ClazzType<any> };
  const o2m = resolver.resolveOneToManyMetadata(entity).find((r) => r.propertyKey === property);
  if (o2m) return { entity: o2m.getRelatedEntity() as ClazzType<any> };
  const m2m = resolver.resolveManyToManyMetadata(entity).find((r) => r.propertyKey === property);
  if (m2m) {
    return {
      entity: m2m.getRelatedEntity() as ClazzType<any>,
      joinTableName: resolver.resolveManyToManyJoinTable(m2m)?.joinTableName,
    };
  }
  const o2o = resolver.resolveOneToOneMetadata(entity).find((r) => r.propertyKey === property);
  if (o2o) return { entity: o2o.getRelatedEntity() as ClazzType<any> };
  return undefined;
}

/**
 * The identifier scope of a read on `entity` that also knows its relations:
 * a relation filter's where is checked against the related entity's scope,
 * at any depth, the same way the read's own where is checked.
 */
export function relationAwareScope(
  ctx: EntityManagerInternals,
  resolver: RelationMetadataResolver,
  entity: ClazzType<any>,
  metadata?: { columns: any[] },
): ColumnNameScope {
  const resolved = metadata ?? resolver.resolveEntityMetadata(entity);
  const scope = buildEntityColumnScope({
    entity,
    metadata: resolved ?? { columns: [] },
    propertyToColumn: resolved ? ctx.buildPropertyToColumnMap(resolved as any) : new Map(),
    computedColumns: ctx.getComputedColumnNames(entity),
    inheritanceResolver: ctx.getInheritanceResolver(),
  });
  scope.relationScope = (property: string) => {
    const target = relatedEntityOf(resolver, entity, property);
    return target ? relationAwareScope(ctx, resolver, target) : undefined;
  };
  return scope;
}

function relatedEntityOf(
  resolver: RelationMetadataResolver,
  entity: ClazzType<any>,
  property: string,
): ClazzType<any> | undefined {
  return relationFilterTargetOf(resolver, entity, property)?.entity;
}
