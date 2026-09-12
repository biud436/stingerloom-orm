/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../utils";
import { ColumnMetadata } from "../../scanner";
import { DefaultNamingStrategy, NamingStrategy } from "../generators/NamingStrategy";
import { ENTITY_TOKEN, EntityMetadata } from "../../decorators/Entity";
import { COLUMN_TOKEN } from "../../decorators/Column";
import { CREATE_TIMESTAMP_TOKEN } from "../../decorators/CreateTimestamp";
import { UPDATE_TIMESTAMP_TOKEN } from "../../decorators/UpdateTimestamp";
import { DELETED_AT_TOKEN } from "../../decorators/DeletedAt";
import { VERSION_TOKEN } from "../../decorators/Version";

/**
 * Resolve table and column names on the supplied entities through
 * `strategy`, mutating their decorator metadata in place.
 *
 * Backs `EntityManager.applyNamingStrategyToEntities()` (the public static
 * the migration CLI calls so `migrate:generate` does not diff camelCase
 * property names against snake_case DB columns) and the per-connection
 * application in `register()` / `attach()`.
 *
 * Idempotent: re-running with the same strategy is a no-op because the
 * `nameExplicit` flag is preserved and column names are already
 * snake-cased on the second pass.
 *
 * @internal Package-internal — not a public API.
 */
export function applyNamingStrategyToEntities(
  entities: Iterable<ClazzType<any>>,
  strategy?: NamingStrategy,
): void {
  const ns = strategy ?? new DefaultNamingStrategy();

  for (const entity of entities) {
    const meta = Reflect.getMetadata(ENTITY_TOKEN, entity) as EntityMetadata | undefined;
    if (!meta) continue;

    // 1. Table name (skip STI children — they share the root's table name)
    if (!meta.nameExplicit && !meta.inheritanceRoot) {
      meta.name = ns.tableName(meta.rawClassName ?? entity.name);
    }

    // 2. Column names. Columns without a propertyKey are DDL-only entries a
    //    previous registerEntities() injected in place (the STI/TPT
    //    discriminator) — renaming them through the strategy would replace
    //    their explicit DB name with columnName(undefined) and break the
    //    next connection's CREATE TABLE.
    const columns: ColumnMetadata[] = Reflect.getMetadata(COLUMN_TOKEN, entity.prototype) ?? [];
    for (const col of columns) {
      if (!col.nameExplicit && col.propertyKey) {
        col.name = ns.columnName(col.propertyKey);
      }
    }
    // Also update entity metadata's columns reference
    if (meta.columns) {
      for (const col of meta.columns as unknown as ColumnMetadata[]) {
        if (!col.nameExplicit && col.propertyKey) {
          col.name = ns.columnName(col.propertyKey);
        }
      }
    }

    // 3. Timestamp / DeletedAt / Version tokens — these store propertyKey,
    //    but are used as SQL column names. Update them if the naming strategy transforms them.
    const updateToken = (token: symbol) => {
      const propName = Reflect.getMetadata(token, entity) as string | undefined;
      if (propName) {
        // Find matching column to get its resolved DB name
        const matchingCol = columns.find((c) => c.propertyKey === propName);
        if (matchingCol && matchingCol.name !== propName) {
          Reflect.defineMetadata(token, matchingCol.name, entity);
        }
      }
    };
    updateToken(CREATE_TIMESTAMP_TOKEN);
    updateToken(UPDATE_TIMESTAMP_TOKEN);
    updateToken(DELETED_AT_TOKEN);
    updateToken(VERSION_TOKEN);

    // 4. Update Reflect metadata
    Reflect.defineMetadata(ENTITY_TOKEN, meta, entity);
    Reflect.defineMetadata(COLUMN_TOKEN, columns, entity.prototype);
  }
}
