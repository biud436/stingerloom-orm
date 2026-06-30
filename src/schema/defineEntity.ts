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
export type EntityClass<Shape> = (new (init?: Partial<Shape>) => Shape) & {
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

/**
 * A decorator-free lifecycle hook. Receives the entity instance both as `this`
 * and as the first argument, so you can write either `function () { this.x }`
 * or `(e) => { e.x }`. The instance must be created with the entity class (e.g.
 * `new User({ … })`) for the hook to fire — see {@link defineEntity}.
 */
export type EntityHookFn<Shape> = (
  this: Shape,
  entity: Shape,
) => void | Promise<void>;

/** Advanced, low-frequency options for {@link defineEntity}. */
export interface DefineEntityOptions<Shape = any> {
  /** Database table name. Defaults to the first `defineEntity` argument. */
  tableName?: string;
  /** Composite / advanced indexes. */
  indexes?: { columns: string[]; name?: string; options?: AdvancedIndexOptions }[];
  /** Additional composite unique indexes (merged with per-column `.unique()`). */
  uniqueIndexes?: { columns: string[]; name?: string }[];
  /** Full-text search indexes. */
  fullTextIndexes?: { columns: string[]; name?: string; language?: string }[];
  /**
   * Lifecycle hooks (decorator-free `@BeforeInsert` … `@AfterDelete`). Each
   * event maps to either an inline function or the name of a method on the
   * entity's prototype. Hooks fire on entity **instances** — create one with
   * `new MyEntity({ … })` (the minted constructor accepts a partial) so the
   * hook method is present on the saved object.
   *
   * @example
   * ```ts
   * const Article = defineEntity("articles", {
   *   id:    t.int().primary().generated(),
   *   title: t.varchar(200),
   *   slug:  t.varchar(200).nullable(),
   * }, {
   *   hooks: {
   *     beforeInsert(e) {
   *       e.slug ??= e.title.toLowerCase().replace(/\s+/g, "-");
   *     },
   *   },
   * });
   *
   * await em.save(Article, new Article({ title: "Hello World" }));
   * // slug === "hello-world"
   * ```
   */
  hooks?: Partial<Record<HookEvent, string | EntityHookFn<Shape>>>;
  /** Excludes this entity from the `"tenant_column"` strategy. */
  nonTenant?: boolean;
}

/**
 * Creates a runtime class with a valid `name` so the rest of the ORM (which
 * derives the entity/table name from `target.name`) treats it like a normal
 * decorated class. The computed-property trick is the standard way to give a
 * dynamically created class a real name.
 *
 * The constructor accepts an optional partial initializer and copies it onto
 * the instance, so `new User({ name: "Ada" })` yields a typed, hook-capable
 * instance — the decorator-free counterpart to `Object.assign(new User(), …)`.
 */
function mintEntityClass(name: string): ClazzType {
  const ident = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : "StingerEntity";
  const holder: Record<string, ClazzType> = {
    [ident]: class {
      constructor(init?: Record<string, unknown>) {
        if (init) Object.assign(this, init);
      }
    },
  };
  return holder[ident];
}

/**
 * Resolves the `hooks` option into the `{ event: methodName }` map the
 * EntitySchema bridge expects. Inline functions are attached to the prototype
 * under a stable, non-enumerable method name; string handlers are passed
 * through as-is (they name a method already on the class).
 */
function resolveHooks<Shape>(
  target: ClazzType,
  hooks: NonNullable<DefineEntityOptions<Shape>["hooks"]>,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [event, handler] of Object.entries(hooks)) {
    if (!handler) continue;
    if (typeof handler === "function") {
      const methodName = `__stinger_hook_${event}`;
      Object.defineProperty(target.prototype, methodName, {
        value: handler,
        writable: true,
        configurable: true,
        enumerable: false,
      });
      map[event] = methodName;
    } else {
      map[event] = handler;
    }
  }
  return map;
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
  options: DefineEntityOptions<InferShape<Cols>> = {},
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

  const hooks = options.hooks ? resolveHooks(target, options.hooks) : undefined;

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
    ...(hooks && Object.keys(hooks).length ? { hooks: hooks as any } : {}),
    ...(options.nonTenant ? { nonTenant: true } : {}),
  };

  // Side-effect: registers all metadata on `target` via the existing bridge.
  // eslint-disable-next-line no-new
  new EntitySchema(schemaOptions);

  return target as EntityClass<InferShape<Cols>>;
}
