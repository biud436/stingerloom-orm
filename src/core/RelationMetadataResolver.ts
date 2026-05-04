/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType, Logger } from "../utils";
import {
  ColumnMetadata,
  EntityScannerMetadata,
  EntityScanner,
  ManyToOneScanner,
  OneToManyScanner,
  ManyToManyScanner,
  OneToOneScanner,
} from "../scanner";
import { getScannerInstance } from "../scanner/ScannerContainer";
import {
  ENTITY_TOKEN,
  MANY_TO_ONE_TOKEN,
  ManyToOneMetadata,
  ONE_TO_MANY_TOKEN,
  OneToManyMetadata,
  MANY_TO_MANY_TOKEN,
  ManyToManyMetadata,
  DELETED_AT_TOKEN,
  CREATE_TIMESTAMP_TOKEN,
  UPDATE_TIMESTAMP_TOKEN,
  ONE_TO_ONE_TOKEN,
  OneToOneMetadata,
  COLUMN_TOKEN,
  VERSION_TOKEN,
  RELATION_COLUMN_TOKEN,
  RelationColumnMetadata,
} from "../decorators";
import { MetadataContext } from "../metadata/MetadataContext";

/**
 * Pure metadata lookup layer. No DB calls, no side effects.
 * Resolves entity/relation metadata via the layered store, with a Reflect fallback.
 */
export class RelationMetadataResolver {
  private readonly logger = new Logger(RelationMetadataResolver.name);

  /**
   * Looks up entity metadata through the layered metadata system.
   *
   * Lookup priority:
   * 1. EntityScanner.scan() — through MetadataLayerRegistry (multi-tenant layer support)
   * 2. Reflect.getMetadata() — static metadata attached directly to the class by decorators (fallback)
   */
  resolveEntityMetadata<T>(
    entity: ClazzType<T>,
  ): EntityScannerMetadata | null {
    const context = MetadataContext.isActive()
      ? MetadataContext.getCurrentTenant()
      : "public";

    // 1. Lookup through the layered metadata system (multi-tenant support)
    const entityScanner = getScannerInstance(EntityScanner);
    const layeredMetadata = entityScanner.scan(entity);
    if (layeredMetadata) {
      return layeredMetadata;
    }

    // 2. Reflect fallback (metadata attached directly by decorators — single-tenant compatibility)
    const reflectMetadata = Reflect.getMetadata(ENTITY_TOKEN, entity) as
      | EntityScannerMetadata
      | undefined;

    if (reflectMetadata) {
      this.logger.warn(
        `[resolveEntityMetadata] "${entity.name}" resolved via Reflect.getMetadata fallback (context: "${context}"). ` +
          `This entity was not found in the layered store.`,
      );
    } else {
      this.logger.error(
        `[resolveEntityMetadata] "${entity.name}" not found in any metadata source (context: "${context}")`,
      );
    }

    return reflectMetadata ?? null;
  }

  /**
   * Returns the name of the column marked with the @DeletedAt decorator, or null if none.
   */
  getDeletedAtColumn<T>(entity: ClazzType<T>): string | null {
    const column = Reflect.getMetadata(DELETED_AT_TOKEN, entity) as
      | string
      | undefined;
    return column ?? null;
  }

  /**
   * Returns the name of the column marked with the @CreateTimestamp decorator.
   */
  getCreateTimestampColumn<T>(entity: ClazzType<T>): string | null {
    const column = Reflect.getMetadata(CREATE_TIMESTAMP_TOKEN, entity) as
      | string
      | undefined;
    return column ?? null;
  }

  /**
   * Returns the name of the column marked with the @UpdateTimestamp decorator.
   */
  getUpdateTimestampColumn<T>(entity: ClazzType<T>): string | null {
    const column = Reflect.getMetadata(UPDATE_TIMESTAMP_TOKEN, entity) as
      | string
      | undefined;
    return column ?? null;
  }

  /**
   * Returns the name of the column marked with the @Version decorator, or null if none.
   */
  getVersionColumn<T>(entity: ClazzType<T>): string | null {
    const column = Reflect.getMetadata(VERSION_TOKEN, entity) as
      | string
      | undefined;
    return column ?? null;
  }

  /**
   * Looks up ManyToOne relation metadata through the layered metadata system.
   *
   * Lookup priority:
   * 1. ManyToOneScanner — through MetadataLayerRegistry (multi-tenant layer support)
   * 2. Reflect.getMetadata() — static metadata attached directly by decorators (fallback)
   */
  resolveManyToOneMetadata<T>(
    entity: ClazzType<T>,
  ): ManyToOneMetadata<any>[] {
    // 1. Lookup through the layered metadata system (multi-tenant support)
    const manyToOneScanner = getScannerInstance(ManyToOneScanner);
    const allRelations = manyToOneScanner.getByTarget<ManyToOneMetadata<any>>(entity);

    if (allRelations.length > 0) {
      return this.resolveJoinColumnsFromColumnMeta(entity, allRelations);
    }

    // 2. Reflect fallback (metadata attached directly by decorators — single-tenant compatibility)
    const reflectMetadata =
      (Reflect.getMetadata(MANY_TO_ONE_TOKEN, entity) as
        | ManyToOneMetadata<any>[]
        | undefined) ??
      (Reflect.getMetadata(MANY_TO_ONE_TOKEN, entity.prototype) as
        | ManyToOneMetadata<any>[]
        | undefined);

    if (reflectMetadata && reflectMetadata.length > 0) {
      this.logger.warn(
        `[resolveManyToOneMetadata] "${entity.name}" ManyToOne resolved via Reflect.getMetadata fallback.`,
      );
      return this.resolveJoinColumnsFromColumnMeta(entity, reflectMetadata);
    }

    return [];
  }

  /**
   * Automatically resolves the joinColumn for a ManyToOne relation.
   *
   * Resolution priority:
   * 1. @RelationColumn metadata (explicit name or automatic inference)
   * 2. If the @ManyToOne option explicitly specifies joinColumn → use it as-is
   * 3. If the same entity declares a `{propertyName}Id` property via @Column
   *    → use that @Column's actual DB column name (name) as the FK column
   * 4. If none of the above apply → joinColumn remains unset
   */
  resolveJoinColumnsFromColumnMeta(
    entity: ClazzType<any>,
    relations: ManyToOneMetadata<any>[],
  ): ManyToOneMetadata<any>[] {
    // Look up @RelationColumn metadata
    const relationColumns: RelationColumnMetadata[] =
      Reflect.getMetadata(RELATION_COLUMN_TOKEN, entity) ??
      Reflect.getMetadata(RELATION_COLUMN_TOKEN, entity.prototype) ??
      [];

    // Look up @Column metadata (property key → column metadata)
    const columnsMeta: ColumnMetadata[] =
      Reflect.getMetadata(COLUMN_TOKEN, entity) ??
      Reflect.getMetadata(COLUMN_TOKEN, entity.prototype) ??
      [];

    return relations.map((rel) => {
      // 1. Check @RelationColumn metadata first (highest priority)
      const relCol = relationColumns.find(
        (rc) => rc.propertyKey === rel.columnName,
      );
      if (relCol) {
        let resolvedName = relCol.name;
        if (!resolvedName) {
          resolvedName = `${rel.columnName}Id`;
          this.logger.warn(
            `@RelationColumn name not specified for '${rel.columnName}' on ${entity.name}, inferred '${resolvedName}'.`,
          );
        }
        return {
          ...rel,
          joinColumn: resolvedName,
          references: relCol.referencedColumn ?? rel.references,
        };
      }

      // 2. If option.joinColumn is already specified → keep it as-is
      if (rel.joinColumn) return rel;

      // 3. Search for an @Column matching the `{propertyName}Id` pattern
      if (columnsMeta.length === 0) return rel;

      const fkPropertyName = `${rel.columnName}Id`;
      const matchingColumn = columnsMeta.find(
        (col: ColumnMetadata) => col.propertyKey === fkPropertyName,
      );

      if (!matchingColumn) return rel;

      // Use the @Column's actual DB name (name if provided, otherwise propertyKey)
      const resolvedJoinColumn = matchingColumn.name ?? fkPropertyName;

      return {
        ...rel,
        joinColumn: resolvedJoinColumn,
      };
    });
  }

  /**
   * Looks up OneToMany relation metadata through the layered metadata system.
   *
   * Lookup priority:
   * 1. OneToManyScanner — through MetadataLayerRegistry (multi-tenant layer support)
   * 2. Reflect.getMetadata() — static metadata attached directly by decorators (fallback)
   */
  resolveOneToManyMetadata<T>(
    entity: ClazzType<T>,
  ): OneToManyMetadata<any>[] {
    // 1. Lookup through the layered metadata system (multi-tenant support)
    const oneToManyScanner = getScannerInstance(OneToManyScanner);
    const allRelations = oneToManyScanner.getByTarget<OneToManyMetadata<any>>(entity);

    if (allRelations.length > 0) {
      return allRelations;
    }

    // 2. Reflect fallback (metadata attached directly by decorators — single-tenant compatibility)
    const reflectMetadata =
      (Reflect.getMetadata(ONE_TO_MANY_TOKEN, entity) as
        | OneToManyMetadata<any>[]
        | undefined) ??
      (Reflect.getMetadata(ONE_TO_MANY_TOKEN, entity.prototype) as
        | OneToManyMetadata<any>[]
        | undefined);

    if (reflectMetadata && reflectMetadata.length > 0) {
      this.logger.warn(
        `[resolveOneToManyMetadata] "${entity.name}" OneToMany resolved via Reflect.getMetadata fallback.`,
      );
      return reflectMetadata;
    }

    return [];
  }

  /**
   * Looks up ManyToMany relation metadata through the layered metadata system.
   *
   * Lookup priority:
   * 1. ManyToManyScanner — through MetadataLayerRegistry (multi-tenant layer support)
   * 2. Reflect.getMetadata() — static metadata attached directly by decorators (fallback)
   */
  resolveManyToManyMetadata<T>(
    entity: ClazzType<T>,
  ): ManyToManyMetadata<any>[] {
    // 1. Lookup through the layered metadata system (multi-tenant support)
    const manyToManyScanner = getScannerInstance(ManyToManyScanner);
    const allRelations = manyToManyScanner.getByTarget<ManyToManyMetadata<any>>(entity);

    if (allRelations.length > 0) {
      return allRelations;
    }

    // 2. Reflect fallback (metadata attached directly by decorators — single-tenant compatibility)
    const reflectMetadata =
      (Reflect.getMetadata(MANY_TO_MANY_TOKEN, entity) as
        | ManyToManyMetadata<any>[]
        | undefined) ??
      (Reflect.getMetadata(MANY_TO_MANY_TOKEN, entity.prototype) as
        | ManyToManyMetadata<any>[]
        | undefined);

    if (reflectMetadata && reflectMetadata.length > 0) {
      this.logger.warn(
        `[resolveManyToManyMetadata] "${entity.name}" ManyToMany resolved via Reflect.getMetadata fallback.`,
      );
      return reflectMetadata;
    }

    return [];
  }

  /**
   * Looks up OneToOne relation metadata through the layered metadata system.
   *
   * Lookup priority:
   * 1. OneToOneScanner — through MetadataLayerRegistry (multi-tenant layer support)
   * 2. Reflect.getMetadata() — static metadata attached directly by decorators (fallback)
   */
  resolveOneToOneMetadata<T>(
    entity: ClazzType<T>,
  ): OneToOneMetadata<any>[] {
    // 1. Lookup through the layered metadata system (multi-tenant support)
    const oneToOneScanner = getScannerInstance(OneToOneScanner);
    const allRelations = oneToOneScanner.getByTarget<OneToOneMetadata<any>>(entity);

    if (allRelations.length > 0) {
      return this.resolveJoinColumnsFromColumnMetaForOneToOne(
        entity,
        allRelations,
      );
    }

    // 2. Reflect fallback (metadata attached directly by decorators — single-tenant compatibility)
    const reflectMetadata =
      (Reflect.getMetadata(ONE_TO_ONE_TOKEN, entity) as
        | OneToOneMetadata<any>[]
        | undefined) ??
      (Reflect.getMetadata(ONE_TO_ONE_TOKEN, entity.prototype) as
        | OneToOneMetadata<any>[]
        | undefined);

    if (reflectMetadata && reflectMetadata.length > 0) {
      this.logger.warn(
        `[resolveOneToOneMetadata] "${entity.name}" OneToOne resolved via Reflect.getMetadata fallback.`,
      );
      return this.resolveJoinColumnsFromColumnMetaForOneToOne(
        entity,
        reflectMetadata,
      );
    }

    return [];
  }

  /**
   * Automatically resolves the joinColumn for a OneToOne relation.
   * Resolution priority matches ManyToOne:
   * 1. @RelationColumn > 2. option.joinColumn > 3. `{propName}Id` @Column
   */
  resolveJoinColumnsFromColumnMetaForOneToOne(
    entity: ClazzType<any>,
    relations: OneToOneMetadata<any>[],
  ): OneToOneMetadata<any>[] {
    // Look up @RelationColumn metadata
    const relationColumns: RelationColumnMetadata[] =
      Reflect.getMetadata(RELATION_COLUMN_TOKEN, entity) ??
      Reflect.getMetadata(RELATION_COLUMN_TOKEN, entity.prototype) ??
      [];

    const columnsMeta: ColumnMetadata[] =
      Reflect.getMetadata(COLUMN_TOKEN, entity) ??
      Reflect.getMetadata(COLUMN_TOKEN, entity.prototype) ??
      [];

    return relations.map((rel) => {
      // 1. Check @RelationColumn metadata first (highest priority)
      const relCol = relationColumns.find(
        (rc) => rc.propertyKey === rel.propertyKey,
      );
      if (relCol) {
        let resolvedName = relCol.name;
        if (!resolvedName) {
          resolvedName = `${rel.propertyKey}Id`;
          this.logger.warn(
            `@RelationColumn name not specified for '${rel.propertyKey}' on ${entity.name}, inferred '${resolvedName}'.`,
          );
        }
        return {
          ...rel,
          joinColumn: resolvedName,
        };
      }

      // 2. If option.joinColumn is already specified → keep it as-is
      if (rel.joinColumn) return rel;

      // 3. Search for an @Column matching the `{propertyName}Id` pattern
      if (columnsMeta.length === 0) return rel;

      const fkPropertyName = `${rel.propertyKey}Id`;
      const matchingColumn = columnsMeta.find(
        (col: ColumnMetadata) => col.propertyKey === fkPropertyName,
      );

      if (!matchingColumn) return rel;

      const resolvedJoinColumn = matchingColumn.name ?? fkPropertyName;

      return {
        ...rel,
        joinColumn: resolvedJoinColumn,
      };
    });
  }

  /**
   * FK backing-property mappings for `qAlias` / property→column resolution.
   *
   * Given an entity with `@ManyToOne workspace + @RelationColumn({ name: "workspace_id" })`,
   * Stingerloom's convention is to expose the FK value through a sibling
   * `workspaceId` property. The DDL/INSERT path knows about that column
   * because it goes through `resolveManyToOneMetadata()`, but
   * `buildPropertyToColumnMap()` only iterated `@Column` metadata — so
   * `qAlias(Entity).workspaceId.eq(...)` rendered as `entity.workspaceId`
   * (camelCase) and the database rejected the unknown column.
   *
   * This helper closes the gap by listing every `{relationProp}Id` →
   * `joinColumn` pair derived from M2O / O2O relations.
   */
  collectFkPropertyMappings<T>(entity: ClazzType<T>): Map<string, string> {
    const map = new Map<string, string>();

    for (const rel of this.resolveManyToOneMetadata(entity)) {
      if (rel.joinColumn) {
        map.set(`${rel.columnName}Id`, rel.joinColumn);
      }
    }

    for (const rel of this.resolveOneToOneMetadata(entity)) {
      if (rel.joinColumn) {
        map.set(`${rel.propertyKey}Id`, rel.joinColumn);
      }
    }

    return map;
  }

  /**
   * Finalizes the joinTable information for a ManyToMany relation.
   * For the owning side (joinTable present), returns it as-is; for the inverse side (mappedBy),
   * fetches joinTable from the owning side.
   */
  resolveManyToManyJoinTable<T>(rel: ManyToManyMetadata<any>): {
    joinTableName: string;
    joinColumn: string;
    inverseJoinColumn: string;
  } | null {
    if (rel.joinTable) {
      return {
        joinTableName: rel.joinTable.name,
        joinColumn: rel.joinTable.joinColumn,
        inverseJoinColumn: rel.joinTable.inverseJoinColumn,
      };
    }

    // Inverse side: fetch joinTable from the owning side referenced by mappedBy
    if (rel.mappedBy) {
      const RelatedEntity = rel.getRelatedEntity();
      const relatedManyToMany = this.resolveManyToManyMetadata(RelatedEntity);
      const ownerRel = relatedManyToMany.find(
        (r) => r.propertyKey === rel.mappedBy && r.joinTable,
      );
      if (ownerRel?.joinTable) {
        // Inverse side — swap joinColumn and inverseJoinColumn
        return {
          joinTableName: ownerRel.joinTable.name,
          joinColumn: ownerRel.joinTable.inverseJoinColumn,
          inverseJoinColumn: ownerRel.joinTable.joinColumn,
        };
      }
    }

    return null;
  }
}
