/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClazzType } from "../../utils";
import { COLUMN_TOKEN, ColumnType } from "../../decorators/Column";
import {
  MANY_TO_ONE_TOKEN,
  ManyToOneMetadata,
} from "../../decorators/ManyToOne";
import {
  ONE_TO_ONE_TOKEN,
  OneToOneMetadata,
} from "../../decorators/OneToOne";
import { ColumnMetadata } from "../../scanner/ColumnScanner";

/**
 * Shared FK-type inference for the DDL generators.
 *
 * `SchemaGenerator` (CREATE TABLE) and `SchemaDiff` (migration diffing) both
 * derive the type of a `@RelationColumn` FK column from the referenced
 * entity's primary key. The two used to carry verbatim copies of these
 * helpers — fixing one without the other would make CREATE TABLE and the
 * schema diff disagree on the FK type, which turns into a migration that
 * re-alters the column on every sync. Single source of truth lives here.
 */

/**
 * Infers the PK type of the target entity referenced by @RelationColumn.
 * Looks up the target entity in either ManyToOne or OneToOne metadata and
 * returns its PK type, or null when the property has no relation metadata.
 */
export function inferRelatedPkType<T>(
  entity: ClazzType<T>,
  propertyKey: string,
): ColumnType | null {
  const manyToOnes = (Reflect.getMetadata(MANY_TO_ONE_TOKEN, entity) ??
    Reflect.getMetadata(MANY_TO_ONE_TOKEN, entity.prototype) ??
    []) as ManyToOneMetadata<any>[];
  const m2o = manyToOnes.find((r) => r.columnName === propertyKey);
  if (m2o) {
    const relatedEntity = m2o.getMappingEntity() as ClazzType<any>;
    return findPrimaryKeyType(relatedEntity);
  }

  const oneToOnes = (Reflect.getMetadata(ONE_TO_ONE_TOKEN, entity) ??
    []) as OneToOneMetadata<any>[];
  const o2o = oneToOnes.find((r) => r.propertyKey === propertyKey);
  if (o2o) {
    const relatedEntity = o2o.getRelatedEntity();
    return findPrimaryKeyType(relatedEntity);
  }

  return null;
}

/**
 * Returns the declared type of the entity's primary-key column.
 *
 * Limitation: for a composite PK (multiple `@PrimaryColumn`s) only the first
 * primary column's type is returned — composite-PK foreign keys are outside
 * the supported scope of `@RelationColumn` type inference, so a multi-column
 * FK must declare its column types explicitly.
 */
export function findPrimaryKeyType<T>(
  entity: ClazzType<T>,
): ColumnType | null {
  const columns = (Reflect.getMetadata(COLUMN_TOKEN, entity.prototype) ??
    []) as ColumnMetadata[];
  const pk = columns.find((col) => col.options?.primary);
  return (pk?.options?.type as ColumnType) ?? null;
}
