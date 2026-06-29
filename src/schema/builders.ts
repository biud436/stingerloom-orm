/* eslint-disable @typescript-eslint/no-explicit-any */
import { ColumnType, ColumnTransformer } from "../decorators/Column";
import { GenerationStrategy } from "../decorators/PrimaryGeneratedColumn";
import { JsonIndexOptions } from "../decorators/JsonIndex";
import { JoinTableOption } from "../decorators/ManyToMany";
import { RelationColumnOption } from "../decorators/RelationColumn";
import { ComputedColumnOption } from "../decorators/ComputedColumn";
import { CascadeOption } from "../types/CascadeType";
import { ReferentialAction } from "../types/ReferentialAction";
import { ClazzType } from "../utils/types";
import {
  ColumnSchemaDef,
  RelationSchemaDef,
  ValidationDef,
} from "./EntitySchemaTypes";

/**
 * Discriminates a builder as a stored column, a relation, or a DB-computed
 * column. Used only at the type level by {@link InferEntity} to decide which
 * fields are required (columns/computed) and which are optional (relations).
 */
export type BuilderKind = "column" | "relation" | "computed";

/**
 * Common base for every fluent field builder produced by {@link t}.
 *
 * The two phantom members carry type information only — they are declared with
 * `declare` so they never exist at runtime. `__infer` holds the inferred
 * TypeScript type of the field (e.g. `number`, `string | null`, `Post[]`), and
 * `__kind` lets `InferEntity` tell relations apart from columns.
 */
export abstract class SchemaBuilder<TInfer, TKind extends BuilderKind> {
  /** Phantom: inferred TS type of this field. Absent at runtime. */
  declare readonly __infer: TInfer;
  /** Phantom: column vs. relation vs. computed discriminator. Absent at runtime. */
  declare readonly __kind: TKind;
}

/**
 * Fluent builder for a stored column. Every modifier returns a new builder so
 * the inferred type can change (`nullable()` widens `T` to `T | null`) while
 * keeping the chain immutable.
 */
export class ColumnBuilder<TInfer> extends SchemaBuilder<TInfer, "column"> {
  /** @internal Resolved {@link ColumnSchemaDef} passed to `EntitySchema`. */
  readonly _def: ColumnSchemaDef;
  /** @internal Set by {@link unique}; `defineEntity` lifts it to a unique index. */
  _unique = false;
  /** @internal Optional name for the `unique()` index. */
  _uniqueName?: string;

  constructor(def: ColumnSchemaDef) {
    super();
    this._def = def;
  }

  private with<U = TInfer>(patch: Partial<ColumnSchemaDef>): ColumnBuilder<U> {
    const next = new ColumnBuilder<U>({ ...this._def, ...patch });
    next._unique = this._unique;
    next._uniqueName = this._uniqueName;
    return next;
  }

  /** Marks the column as (part of) the primary key. */
  primary(): ColumnBuilder<TInfer> {
    return this.with({ primary: true });
  }

  /**
   * Database-generated primary key. `"increment"` → auto-increment,
   * `"uuid"` / `"uuid-v7"` → generated UUID. Pair with {@link primary}.
   */
  generated(strategy: GenerationStrategy = "increment"): ColumnBuilder<TInfer> {
    if (strategy === "increment") {
      return this.with({ autoIncrement: true });
    }
    return this.with({ generationStrategy: strategy });
  }

  /** Allows `NULL`; widens the inferred type to `TInfer | null`. */
  nullable(): ColumnBuilder<TInfer | null> {
    return this.with<TInfer | null>({ nullable: true });
  }

  /** Adds a single-column unique index (lifted to `uniqueIndexes`). */
  unique(name?: string): ColumnBuilder<TInfer> {
    const next = this.with({});
    next._unique = true;
    next._uniqueName = name;
    return next;
  }

  /** Adds a single-column non-unique index. */
  index(): ColumnBuilder<TInfer> {
    return this.with({ index: true });
  }

  /** Sets the column default value. */
  default(value: string | number | boolean | null): ColumnBuilder<TInfer> {
    return this.with({ default: value });
  }

  /** Overrides the database column name (defaults to the property key). */
  name(dbName: string): ColumnBuilder<TInfer> {
    return this.with({ name: dbName });
  }

  /** Sets the column length (e.g. `varchar(length)`). */
  length(value: number): ColumnBuilder<TInfer> {
    return this.with({ length: value });
  }

  /** Sets numeric precision. */
  precision(value: number): ColumnBuilder<TInfer> {
    return this.with({ precision: value });
  }

  /** Sets numeric scale. */
  scale(value: number): ColumnBuilder<TInfer> {
    return this.with({ scale: value });
  }

  /** Names the PostgreSQL `ENUM` type (only meaningful for enum columns). */
  enumName(value: string): ColumnBuilder<TInfer> {
    return this.with({ enumName: value });
  }

  /** Bidirectional value transformer (decorator-free `@Column({ transformer })`). */
  transformer(transformer: ColumnTransformer): ColumnBuilder<TInfer> {
    return this.with({ transformer });
  }

  /** Declares a JSON/JSONB expression index over this column. */
  jsonIndex(options: JsonIndexOptions): ColumnBuilder<TInfer> {
    return this.with({ jsonIndex: options });
  }

  /** Inline validation constraints (decorator-free `@Validation`). */
  validate(rules: ValidationDef[]): ColumnBuilder<TInfer> {
    return this.with({ validation: rules });
  }

  /** Auto-set on INSERT (decorator-free `@CreateTimestamp`). */
  createTimestamp(): ColumnBuilder<TInfer> {
    return this.with({ createTimestamp: true });
  }

  /** Auto-set on INSERT/UPDATE (decorator-free `@UpdateTimestamp`). */
  updateTimestamp(): ColumnBuilder<TInfer> {
    return this.with({ updateTimestamp: true });
  }

  /** Soft-delete marker; implies nullable (decorator-free `@DeletedAt`). */
  deletedAt(): ColumnBuilder<TInfer | null> {
    return this.with<TInfer | null>({ deletedAt: true, nullable: true });
  }

  /** Optimistic-locking version column (decorator-free `@Version`). */
  version(): ColumnBuilder<TInfer> {
    return this.with({ version: true });
  }

  /** Marks this column as the tenant discriminator (decorator-free `@TenantColumn`). */
  tenant(): ColumnBuilder<TInfer> {
    return this.with({ tenant: true });
  }
}

/** Builder for a relation field. Carries the resolved {@link RelationSchemaDef}. */
export class RelationBuilder<TInfer> extends SchemaBuilder<TInfer, "relation"> {
  /** @internal */ readonly _def: RelationSchemaDef;
  constructor(def: RelationSchemaDef) {
    super();
    this._def = def;
  }
}

/** Builder for a database-computed column (decorator-free `@ComputedColumn`). */
export class ComputedBuilder<TInfer> extends SchemaBuilder<TInfer, "computed"> {
  /** @internal */ readonly _def: ComputedColumnOption;
  constructor(def: ComputedColumnOption) {
    super();
    this._def = def;
  }
}

/** Options for {@link t.manyToOne}. Mirrors `ManyToOneRelationDef` minus `kind`/`target`. */
export interface ManyToOneBuilderOptions {
  joinColumn?: string;
  references?: string;
  eager?: boolean;
  cascade?: CascadeOption;
  lazy?: boolean;
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
  createForeignKeyConstraints?: boolean;
  relationColumn?: RelationColumnOption;
}

/** Options for {@link t.oneToOne}. Mirrors `OneToOneRelationDef` minus `kind`/`target`. */
export interface OneToOneBuilderOptions {
  joinColumn?: string;
  inverseSide?: string;
  eager?: boolean;
  cascade?: CascadeOption;
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
  createForeignKeyConstraints?: boolean;
  relationColumn?: RelationColumnOption;
}

/** Options for {@link t.manyToMany}. Mirrors `ManyToManyRelationDef` minus `kind`/`target`. */
export interface ManyToManyBuilderOptions {
  joinTable?: JoinTableOption;
  mappedBy?: string;
  cascade?: CascadeOption;
}

function column<T>(def: ColumnSchemaDef): ColumnBuilder<T> {
  return new ColumnBuilder<T>(def);
}

/**
 * Fluent, type-carrying field builders for {@link defineEntity}.
 *
 * Each factory fixes the inferred TypeScript type of the field, so the entity
 * row type can be recovered with `InferEntity<typeof MyEntity>` — no separate
 * class or interface required.
 *
 * @example
 * ```ts
 * export const User = defineEntity("users", {
 *   id:    t.int().primary().generated(),
 *   email: t.varchar(255).unique(),
 *   name:  t.varchar(255).nullable(),
 *   role:  t.enum(["admin", "user"]).default("user"),
 *   posts: t.oneToMany(() => Post, "author"),
 * });
 * export type User = InferEntity<typeof User>;
 * // { id: number; email: string; name: string | null; role: "admin" | "user"; posts?: Post[] }
 * ```
 */
export const t = {
  // ── numeric ──────────────────────────────────────────────────────────────
  int: () => column<number>({ type: "int" }),
  integer: () => column<number>({ type: "int" }),
  bigint: () => column<number>({ type: "bigint" }),
  float: () => column<number>({ type: "float" }),
  double: () => column<number>({ type: "double" }),
  number: () => column<number>({ type: "number" }),
  decimal: (precision?: number, scale?: number) =>
    column<number>({
      type: "number",
      ...(precision != null ? { precision } : {}),
      ...(scale != null ? { scale } : {}),
    }),

  // ── string ───────────────────────────────────────────────────────────────
  varchar: (length?: number) =>
    column<string>({ type: "varchar", ...(length != null ? { length } : {}) }),
  char: (length?: number) =>
    column<string>({ type: "char", ...(length != null ? { length } : {}) }),
  text: () => column<string>({ type: "text" }),
  longtext: () => column<string>({ type: "longtext" }),
  uuid: () => column<string>({ type: "uuid" }),

  // ── boolean ──────────────────────────────────────────────────────────────
  boolean: () => column<boolean>({ type: "boolean" }),

  // ── temporal ─────────────────────────────────────────────────────────────
  datetime: () => column<Date>({ type: "datetime" }),
  timestamp: () => column<Date>({ type: "timestamp" }),
  timestamptz: () => column<Date>({ type: "timestamptz" }),
  date: () => column<Date>({ type: "date" }),

  // ── binary ───────────────────────────────────────────────────────────────
  blob: () => column<Buffer>({ type: "blob" }),

  // ── structured ───────────────────────────────────────────────────────────
  json: <T = unknown>() => column<T>({ type: "json" }),
  jsonb: <T = unknown>() => column<T>({ type: "jsonb" }),
  array: <T = unknown>() => column<T[]>({ type: "array" }),
  enum: <const E extends string>(values: readonly E[]) =>
    column<E>({ type: "enum", enumValues: values as unknown as string[] }),

  // ── relations ────────────────────────────────────────────────────────────
  manyToOne: <C extends ClazzType>(
    target: () => C,
    options?: ManyToOneBuilderOptions,
  ) =>
    new RelationBuilder<InstanceType<C>>({
      kind: "manyToOne",
      target,
      ...options,
    }),

  oneToMany: <C extends ClazzType>(
    target: () => C,
    mappedBy: (keyof InstanceType<C> & string) | (string & {}),
    options?: { cascade?: CascadeOption },
  ) =>
    new RelationBuilder<InstanceType<C>[]>({
      kind: "oneToMany",
      target,
      mappedBy: mappedBy as string,
      ...options,
    }),

  oneToOne: <C extends ClazzType>(
    target: () => C,
    options?: OneToOneBuilderOptions,
  ) =>
    new RelationBuilder<InstanceType<C>>({
      kind: "oneToOne",
      target,
      ...options,
    }),

  manyToMany: <C extends ClazzType>(
    target: () => C,
    options?: ManyToManyBuilderOptions,
  ) =>
    new RelationBuilder<InstanceType<C>[]>({
      kind: "manyToMany",
      target,
      ...options,
    }),

  // ── computed ─────────────────────────────────────────────────────────────
  computed: <T = unknown>(
    expression: ComputedColumnOption["expression"],
    options?: { stored?: boolean; type?: ColumnType },
  ) => new ComputedBuilder<T>({ expression, ...options }),
};

/** The shape of the {@link t} builder namespace. */
export type ColumnTypes = typeof t;
