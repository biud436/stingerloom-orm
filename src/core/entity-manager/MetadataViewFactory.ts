/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../utils";
import type { EntityManagerInternals } from "../EntityManagerInternals";
import type {
  EntityMetadataView,
  ColumnMetadataView,
  RelationMetadataView,
} from "./types";

/**
 * Builds the public metadata views (#233) exposed via
 * `EntityManager.getEntityMetadata()` / `getColumnMetadata()` /
 * `getRelationMetadata()`.
 *
 * Extracted from EntityManager; the facade keeps thin delegators so the
 * public API stays byte-identical. Collaborators are read through the
 * `EntityManagerInternals` bridge at call time (live getters) so test-time
 * reassignment of `em.resolver` is honored.
 *
 * @internal Package-internal — not a public API.
 */
export class MetadataViewFactory {
  constructor(private readonly ctx: EntityManagerInternals) {}

  getEntityMetadata<T>(entity: ClazzType<T>): EntityMetadataView | null {
    const resolver = this.ctx.getResolver();
    const meta = resolver.resolveEntityMetadata(entity);
    if (!meta) return null;

    // Route through the facade so jest.spyOn(em, "getColumnMetadata") /
    // "getRelationMetadata" keeps intercepting the nested calls.
    const manager = this.ctx.getManager();
    const columns = manager.getColumnMetadata(entity);
    const relations = manager.getRelationMetadata(entity);

    return {
      tableName: meta.name || entity.name,
      columns,
      relations,
      indexes: meta.indexes ?? [],
      deletedAtColumn: resolver.getDeletedAtColumn(entity),
      createTimestampColumn: resolver.getCreateTimestampColumn(entity),
      updateTimestampColumn: resolver.getUpdateTimestampColumn(entity),
      versionColumn: resolver.getVersionColumn(entity),
    };
  }

  getColumnMetadata<T>(entity: ClazzType<T>): ColumnMetadataView[] {
    const meta = this.ctx.getResolver().resolveEntityMetadata(entity);
    if (!meta) return [];

    return (meta.columns ?? []).map((col: any) => ({
      propertyKey: col.propertyKey ?? col.name,
      columnName: col.name ?? col.propertyKey,
      type: col.options?.type ?? col.type,
      nullable: col.options?.nullable ?? false,
      primary: col.options?.primary ?? false,
      unique: col.options?.unique ?? false,
      default: col.options?.default,
      length: col.options?.length,
    }));
  }

  getRelationMetadata<T>(entity: ClazzType<T>): RelationMetadataView[] {
    const resolver = this.ctx.getResolver();
    const results: RelationMetadataView[] = [];

    for (const rel of resolver.resolveManyToOneMetadata(entity)) {
      results.push({
        type: "ManyToOne",
        propertyKey: rel.columnName,
        target: rel.getMappingEntity(),
        joinColumn: rel.joinColumn ?? null,
        eager: rel.option?.eager ?? false,
      });
    }

    for (const rel of resolver.resolveOneToManyMetadata(entity)) {
      results.push({
        type: "OneToMany",
        propertyKey: rel.propertyKey,
        target: rel.getRelatedEntity(),
        joinColumn: null,
        eager: false,
      });
    }

    for (const rel of resolver.resolveManyToManyMetadata(entity)) {
      results.push({
        type: "ManyToMany",
        propertyKey: rel.propertyKey,
        target: rel.getRelatedEntity(),
        joinColumn: null,
        eager: false,
      });
    }

    for (const rel of resolver.resolveOneToOneMetadata(entity)) {
      results.push({
        type: "OneToOne",
        propertyKey: rel.propertyKey,
        target: rel.getRelatedEntity(),
        joinColumn: rel.joinColumn ?? null,
        eager: rel.option?.eager ?? false,
      });
    }

    return results;
  }
}
