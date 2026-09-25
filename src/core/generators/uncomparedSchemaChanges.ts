import { ClazzType } from "../../utils";
import { MANY_TO_ONE_TOKEN, ManyToOneMetadata } from "../../decorators/ManyToOne";
import { ONE_TO_ONE_TOKEN, OneToOneMetadata } from "../../decorators/OneToOne";
import { COMPUTED_COLUMN_TOKEN } from "../../decorators/ComputedColumn";
import { collectEntityColumns } from "./entityColumns";
import type { SchemaDialect } from "./SchemaGenerator";

/**
 * Where the list of change kinds the schema diff does not compare is
 * documented, for the notices below to point at.
 */
export const UNCOMPARED_CHANGES_DOC =
  "docs/migrations.md#what-the-schema-diff-does-not-compare";

/**
 * The change kinds neither `synchronize` nor `migrate:generate` compares
 * against an existing table, narrowed to the ones these entities can run
 * into: a kind is listed only when some entity declares the property whose
 * change would go unnoticed. Index definitions are always listed — an index
 * removed from an entity leaves nothing behind to declare it.
 *
 * `synchronize` does create the indexes and foreign keys an entity adds;
 * `migrate:generate` adds neither to an existing table, which
 * {@link describeGenerateGaps} states on top of this list.
 */
function uncomparedKinds(
  entities: ClazzType<unknown>[],
  dialect: SchemaDialect,
): string[] {
  const columns = entities.flatMap((entity) => collectEntityColumns(entity));
  const relations = entities.flatMap(owningRelations);

  const kinds: string[] = [];
  if (columns.some((col) => col.options.default !== undefined)) {
    kinds.push("changed column defaults");
  }
  if (
    relations.some(
      (rel) =>
        rel.option?.onDelete !== undefined || rel.option?.onUpdate !== undefined,
    )
  ) {
    kinds.push("changed foreign key onDelete/onUpdate");
  }
  kinds.push("removed or redefined indexes");
  if (
    entities.some(
      (entity) =>
        ((Reflect.getMetadata(COMPUTED_COLUMN_TOKEN, entity.prototype) ??
          []) as unknown[]).length > 0,
    )
  ) {
    kinds.push("changed computed column expressions");
  }
  if (
    dialect === "mysql" &&
    columns.some((col) => col.options.type === "enum")
  ) {
    kinds.push("changed ENUM value lists");
  }
  return kinds;
}

/**
 * The `@ManyToOne` / owning `@OneToOne` relations an entity declares a
 * foreign key for. A `@OneToOne` without `inverseSide` is the owning one: its
 * join column may come from `@RelationColumn`, which the resolver reads later,
 * so the raw metadata need not carry it yet.
 */
function owningRelations(
  entity: ClazzType<unknown>,
): Array<ManyToOneMetadata<unknown> | OneToOneMetadata<unknown>> {
  const manyToOnes = (Reflect.getMetadata(MANY_TO_ONE_TOKEN, entity) ??
    Reflect.getMetadata(MANY_TO_ONE_TOKEN, entity.prototype) ??
    []) as ManyToOneMetadata<unknown>[];
  const oneToOnes = (Reflect.getMetadata(ONE_TO_ONE_TOKEN, entity) ??
    []) as OneToOneMetadata<unknown>[];
  return [...manyToOnes, ...oneToOnes.filter((rel) => !rel.inverseSide)];
}

/**
 * The one-line notice `synchronize` logs once per boot when a table already
 * existed: what it leaves as it is on such a table. SQLite additionally
 * cannot add a foreign key constraint to an existing table.
 */
export function describeSynchronizeGaps(
  entities: ClazzType<unknown>[],
  dialect: SchemaDialect,
): string {
  const kinds = uncomparedKinds(entities, dialect);
  if (dialect === "sqlite" && entities.some((e) => owningRelations(e).length > 0)) {
    kinds.push("foreign key constraints for relations added to an existing table");
  }
  return (
    `synchronize does not apply these to existing tables: ${kinds.join(", ")}. ` +
    `Write a migration for them (see ${UNCOMPARED_CHANGES_DOC}).`
  );
}

/**
 * The one-line notice `migrate:generate` logs when it diffed an existing
 * table: what a generated migration leaves out. Unlike `synchronize`, it
 * never adds an index or a foreign key constraint to an existing table.
 */
export function describeGenerateGaps(
  entities: ClazzType<unknown>[],
  dialect: SchemaDialect,
): string {
  const kinds = [
    "new indexes and foreign key constraints",
    ...uncomparedKinds(entities, dialect),
  ];
  return (
    `migrate:generate does not write these for existing tables: ${kinds.join(", ")}. ` +
    `Add them to the migration by hand (see ${UNCOMPARED_CHANGES_DOC}).`
  );
}
