import { ClazzType } from "../../utils";
import { COLUMN_TOKEN, ColumnOption, ColumnType } from "../../decorators/Column";
import { ColumnMetadata } from "../../scanner/ColumnScanner";
import {
  RELATION_COLUMN_TOKEN,
  RelationColumnMetadata,
} from "../../decorators/RelationColumn";
import { inferRelatedPkType } from "./RelatedPkTypeResolver";

/** A column the schema generators render: its DB name plus its resolved options. */
export interface EntityColumnDef {
  name: string;
  options: ColumnOption;
}

/**
 * Collects the columns an entity declares, in DDL order.
 *
 * `@Column` metadata first, then the `@RelationColumn` FK shadows that have no
 * `@Column` of their own (their type is inferred from the related entity's PK).
 *
 * SchemaGenerator (migrate:generate CREATE TABLE) and SchemaDiff (runtime
 * synchronize) both read the entity through this one function — they used to
 * carry byte-identical copies, so a fix to one silently skipped the other.
 */
export function collectEntityColumns<T>(
  entity: ClazzType<T>,
): EntityColumnDef[] {
  const columns = (Reflect.getMetadata(COLUMN_TOKEN, entity.prototype) ??
    []) as ColumnMetadata[];
  const result: EntityColumnDef[] = columns.map((col) => ({
    name: col.name ?? "unknown",
    options: (col.options ?? {
      type: "varchar" as ColumnType,
      length: 255,
      nullable: false,
    }) as ColumnOption,
  }));

  const relationColumns: RelationColumnMetadata[] =
    Reflect.getMetadata(RELATION_COLUMN_TOKEN, entity) ??
    Reflect.getMetadata(RELATION_COLUMN_TOKEN, entity.prototype) ??
    [];
  const existingNames = new Set(result.map((c) => c.name));

  for (const rc of relationColumns) {
    const fkName = rc.name ?? `${rc.propertyKey}Id`;
    if (existingNames.has(fkName)) continue; // @Column already declared it

    // FK column type: explicit option → inferred target PK type → "int"
    const fkType: ColumnType =
      rc.type ?? inferRelatedPkType(entity, rc.propertyKey) ?? "int";

    result.push({
      name: fkName,
      options: {
        type: fkType,
        nullable: rc.nullable ?? true,
      } as ColumnOption,
    });
  }

  return result;
}
