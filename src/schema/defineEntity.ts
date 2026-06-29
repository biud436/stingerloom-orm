/* eslint-disable @typescript-eslint/no-explicit-any */
import { AdvancedIndexOptions } from "../decorators/Indexer";
import { HookEvent } from "../decorators/Hooks";
import { ComputedColumnOption } from "../decorators/ComputedColumn";
import { ClazzType } from "../utils/types";
import { EntitySchema } from "./EntitySchema";
import {
  ColumnSchemaDef,
  EntitySchemaOptions,
  RelationSchemaDef,
} from "./EntitySchemaTypes";
import {
  ColumnBuilder,
  ComputedBuilder,
  RelationBuilder,
  SchemaBuilder,
} from "./builders";

/** Any field builder accepted by {@link defineEntity}. */
export type AnyBuilder = SchemaBuilder<any, any>;

/** A map of property name → field builder. */
export type EntityColumns = Record<string, AnyBuilder>;

type Prettify<T> = { [K in keyof T]: T[K] } & {};

/** Pulls the inferred field type out of a builder. */
type Infer<B> = B extends SchemaBuilder<infer T, any> ? T : never;

/** Keys whose builder is a relation (rendered optional in the row type). */
type RelationFieldKeys<Cols> = {
  [K in keyof Cols]: Cols[K] extends SchemaBuilder<any, "relation"> ? K : never;
}[keyof Cols];

/** Keys whose builder is a column or computed column (required in the row type). */
type DataFieldKeys<Cols> = Exclude<keyof Cols, RelationFieldKeys<Cols>>;

/**
 * The entity row type inferred from a builder map: columns and computed columns
 * are required, relations are optional (they are loaded on demand).
 */
export type InferShape<Cols extends EntityColumns> = Prettify<
  { [K in DataFieldKeys<Cols>]: Infer<Cols[K]> } & {
    [K in RelationFieldKeys<Cols>]?: Infer<Cols[K]>;
  }
>;

/**
 * Constructor returned by {@link defineEntity}. It is a real runtime class
 * (usable everywhere the ORM expects an entity target) whose instance type is
 * the inferred row shape, so `InferEntity<typeof X>` recovers it.
 */
export type EntityClass<Shape> = (new (...args: any[]) => Shape) & {
  /** Phantom brand carrying the inferred shape. Absent at runtime. */
  readonly __stinger_shape?: Shape;
};

/**
 * Recovers the row type of an entity defined with {@link defineEntity}.
 *
 * Also works on decorator-based entity classes (it falls back to the class
 * instance type).
 *
 * @example
 * ```ts
 * export const User = defineEntity("users", { id: t.int().primary().generated() });
 * export type User = InferEntity<typeof User>;
 * ```
 */
export type InferEntity<C> = C extends new (...args: any[]) => infer S
  ? S
  : never;

/** Advanced, low-frequency options for {@link defineEntity}. */
export interface DefineEntityOptions {
  /** Database table name. Defaults to the first `defineEntity` argument. */
  tableName?: string;
  /** Composite / advanced indexes. */
  indexes?: { columns: string[]; name?: string; options?: AdvancedIndexOptions }[];
  /** Additional composite unique indexes (merged with per-column `.unique()`). */
  uniqueIndexes?: { columns: string[]; name?: string }[];
  /** Full-text search indexes. */
  fullTextIndexes?: { columns: string[]; name?: string; language?: string }[];
  /** Lifecycle hooks → method names on a base class (rarely used decorator-free). */
  hooks?: Partial<Record<HookEvent, string>>;
  /** Excludes this entity from the `"tenant_column"` strategy. */
  nonTenant?: boolean;
}

/**
 * Creates a runtime class with a valid `name` so the rest of the ORM (which
 * derives the entity/table name from `target.name`) treats it like a normal
 * decorated class. The computed-property trick is the standard way to give a
 * dynamically created class a real name.
 */
function mintEntityClass(name: string): ClazzType {
  const ident = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : "StingerEntity";
  const holder: Record<string, ClazzType> = { [ident]: class {} };
  return holder[ident];
}

/**
 * Decorator-free, fully type-inferred entity definition.
 *
 * Builds an entity from a map of fluent {@link t} builders. The returned value
 * is a real class you use as the ORM target (`em.getRepository(User)`,
 * relation `target`s, etc.), and `InferEntity<typeof User>` gives you the row
 * type — so neither the class nor the property types are written by hand.
 *
 * Internally it converts the builders into the same `EntitySchema` options the
 * decorator path produces, so it shares 100% of the existing metadata bridge.
 *
 * @example
 * ```ts
 * import { defineEntity, t, InferEntity } from "@stingerloom/orm";
 *
 * export const User = defineEntity("users", {
 *   id:        t.int().primary().generated(),
 *   email:     t.varchar(255).unique(),
 *   name:      t.varchar(255).nullable(),
 *   createdAt: t.datetime().createTimestamp(),
 *   posts:     t.oneToMany(() => Post, "author"),
 * });
 * export type User = InferEntity<typeof User>;
 * ```
 */
export function defineEntity<Cols extends EntityColumns>(
  name: string,
  columns: Cols,
  options: DefineEntityOptions = {},
): EntityClass<InferShape<Cols>> {
  const target = mintEntityClass(name);

  const columnDefs: Record<string, ColumnSchemaDef> = {};
  const relationDefs: Record<string, RelationSchemaDef> = {};
  const computedDefs: Record<string, ComputedColumnOption> = {};
  const uniqueIndexes: { columns: string[]; name?: string }[] = [
    ...(options.uniqueIndexes ?? []),
  ];

  for (const [key, builder] of Object.entries(columns) as [
    string,
    AnyBuilder,
  ][]) {
    if (builder instanceof ColumnBuilder) {
      columnDefs[key] = builder._def;
      if (builder._unique) {
        uniqueIndexes.push({
          columns: [builder._def.name ?? key],
          ...(builder._uniqueName ? { name: builder._uniqueName } : {}),
        });
      }
    } else if (builder instanceof RelationBuilder) {
      relationDefs[key] = builder._def;
    } else if (builder instanceof ComputedBuilder) {
      computedDefs[key] = builder._def;
    }
  }

  const schemaOptions: EntitySchemaOptions<any> = {
    target,
    tableName: options.tableName ?? name,
    columns: columnDefs as any,
    ...(Object.keys(relationDefs).length
      ? { relations: relationDefs as any }
      : {}),
    ...(Object.keys(computedDefs).length
      ? { computedColumns: computedDefs as any }
      : {}),
    ...(uniqueIndexes.length ? { uniqueIndexes } : {}),
    ...(options.indexes ? { indexes: options.indexes } : {}),
    ...(options.fullTextIndexes
      ? { fullTextIndexes: options.fullTextIndexes }
      : {}),
    ...(options.hooks ? { hooks: options.hooks as any } : {}),
    ...(options.nonTenant ? { nonTenant: true } : {}),
  };

  // Side-effect: registers all metadata on `target` via the existing bridge.
  // eslint-disable-next-line no-new
  new EntitySchema(schemaOptions);

  return target as EntityClass<InferShape<Cols>>;
}
