import { ClazzType } from "../utils";
import type { ColumnMetadata } from "../scanner/ColumnScanner";

/**
 * Anything that can enumerate FK backing-property mappings for an entity —
 * in practice a {@link RelationMetadataResolver}, but kept structural so
 * partial test mocks and the DDL generator can satisfy it too.
 */
export interface FkPropertyMappingSource {
  collectFkPropertyMappings<T>(entity: ClazzType<T>): Map<string, string>;
}

/**
 * Builds a Map from TypeScript property names to DB column names.
 *
 * `@Column` properties are read from `metadata.columns`. `@ManyToOne` /
 * `@OneToOne` FK backing properties (e.g. `workspaceId` for a
 * `workspace!: Workspace` relation) are folded in via
 * `collectFkPropertyMappings()` so that FK shadow properties resolve to the
 * real FK column. Without this, FK access rendered the camelCase property
 * name verbatim — the database rejected it on the query path, and on the
 * DDL path `@Index()` on a shadow property emitted an index against a
 * nonexistent column.
 *
 * Single source of truth shared by `EntityManager` (which adds a cache
 * wrapper on top), `SelectQueryBuilder`, and `SchemaGenerator`.
 */
export function buildPropertyToColumnMap(
  metadata: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    target?: ClazzType<any>;
    columns: ColumnMetadata[];
  },
  fkSource?: Partial<FkPropertyMappingSource> | null,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const col of metadata.columns) {
    const prop = col.propertyKey ?? col.name;
    map.set(prop, col.name);
  }
  // The source may be a partial mock in some tests, so guard the call.
  if (
    metadata.target &&
    typeof fkSource?.collectFkPropertyMappings === "function"
  ) {
    const fkMap = fkSource.collectFkPropertyMappings(metadata.target);
    for (const [prop, col] of fkMap) {
      // An explicit @Column on the same property wins (already in map).
      if (!map.has(prop)) map.set(prop, col);
    }
  }
  return map;
}
