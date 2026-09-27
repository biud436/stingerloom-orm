import { ClazzType } from "../../utils";
import { COLUMN_TOKEN, ColumnOption, ColumnType } from "../../decorators/Column";
import { ColumnMetadata } from "../../scanner/ColumnScanner";
import {
  RELATION_COLUMN_TOKEN,
  RelationColumnMetadata,
} from "../../decorators/RelationColumn";
import { inferRelatedPkType } from "./RelatedPkTypeResolver";
import { InheritanceResolver } from "../InheritanceResolver";

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

const inheritance = new InheritanceResolver();

/**
 * The entity whose table holds `entity`'s rows: the root for a SINGLE_TABLE
 * child, which has no table of its own, and the entity itself otherwise.
 */
export function tableOwnerEntity<T>(entity: ClazzType<T>): ClazzType<any> {
  if (
    inheritance.getStrategy(entity) === "SINGLE_TABLE" &&
    inheritance.isChildEntity(entity)
  ) {
    return inheritance.getRoot(entity) ?? entity;
  }
  return entity;
}

/**
 * Collects the columns of the table `entity` owns, in DDL order — the layout
 * synchronize creates, which in an inheritance hierarchy is not the entity's
 * own column list (see {@link collectEntityColumns}):
 *
 * - SINGLE_TABLE root: its columns, the discriminator, then every child's
 *   columns, nullable since a row leaves its siblings' columns empty.
 * - SINGLE_TABLE child: its root's table (see {@link tableOwnerEntity}).
 * - JOINED root: its columns and the discriminator.
 * - JOINED child: the primary key and the columns the child declares; the
 *   inherited ones live on the root's table.
 * - TABLE_PER_CLASS and no hierarchy: the entity's columns.
 *
 * The schema diff and migrate:generate read tables through this, so they
 * compare and create what the hierarchy stores rather than a table that
 * would drop its discriminator or copy the root's columns into a child's.
 */
export function collectTableColumns<T>(
  entity: ClazzType<T>,
): EntityColumnDef[] {
  const owner = tableOwnerEntity(entity);
  const strategy = inheritance.getStrategy(owner);
  const columns = collectEntityColumns(owner);
  if (strategy !== "SINGLE_TABLE" && strategy !== "JOINED") return columns;

  if (inheritance.isChildEntity(owner)) {
    const root = inheritance.getRoot(owner);
    if (!root) return columns;
    const inherited = new Set(collectEntityColumns(root).map((c) => c.name));
    return columns.filter((c) => c.options.primary || !inherited.has(c.name));
  }

  const names = new Set(columns.map((c) => c.name));
  const discriminator = inheritance.getDiscriminatorColumn(owner);
  if (discriminator && !names.has(discriminator.name)) {
    names.add(discriminator.name);
    columns.push({
      name: discriminator.name,
      options: {
        type: discriminator.type,
        length: discriminator.length,
        nullable: false,
      },
    });
  }
  if (strategy === "SINGLE_TABLE") {
    for (const child of inheritance.getConcreteEntities(owner)) {
      if (child === owner) continue;
      for (const col of collectEntityColumns(child)) {
        if (names.has(col.name)) continue;
        names.add(col.name);
        columns.push({ ...col, options: { ...col.options, nullable: true } });
      }
    }
  }
  return columns;
}
