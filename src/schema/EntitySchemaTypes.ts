/* eslint-disable @typescript-eslint/no-explicit-any */
import { ColumnType, ColumnTransformer, KnownColumnType } from "../decorators/Column";
import { GenerationStrategy } from "../decorators/PrimaryGeneratedColumn";
import { ComputedColumnOption } from "../decorators/ComputedColumn";
import { JsonIndexOptions } from "../decorators/JsonIndex";
import { AdvancedIndexOptions } from "../decorators/Indexer";
import { RelationColumnOption } from "../decorators/RelationColumn";
import { CascadeOption } from "../types/CascadeType";
import { ReferentialAction } from "../types/ReferentialAction";
import { JoinTableOption } from "../decorators/ManyToMany";
import { HookEvent } from "../decorators/Hooks";
import { ConstraintType } from "../decorators/Validation";
import { InheritanceStrategy } from "../decorators/Inheritance";
import { ClazzType } from "../utils/types";

/**
 * Validation definition for EntitySchema columns.
 */
export interface ValidationDef {
  constraint: ConstraintType;
  value?: number;
  message?: string;
}

/**
 * Column definition for EntitySchema.
 * Unifies @Column, @PrimaryGeneratedColumn, and special decorators
 * (@Index, @Version, @CreateTimestamp, @UpdateTimestamp, @DeletedAt).
 */
export interface ColumnSchemaDef {
  type: ColumnType;
  primary?: boolean;
  autoIncrement?: boolean;
  length?: number;
  nullable?: boolean;
  default?: string | number | boolean | null;
  precision?: number;
  scale?: number;
  enumValues?: string[];
  enumName?: string;
  name?: string;

  /**
   * Element type for `type: "array"` columns (PostgreSQL native arrays,
   * default "text" → `TEXT[]`). Decorator-free equivalent of
   * `@Column({ arrayElementType })`. Ignored on MySQL (JSON) / SQLite (TEXT).
   */
  arrayElementType?: ColumnType;

  /**
   * One-way read transform (DB → entity).
   * @deprecated Removal target: 2.0. Use `transformer` for bidirectional
   * transforms — mirrors the deprecation on `@Column({ transform })`.
   */
  transform?: (raw: unknown) => any;

  /**
   * Bidirectional value transformer applied on read (`from`) and write (`to`).
   * Decorator-free equivalent of `@Column({ transformer })`.
   */
  transformer?: ColumnTransformer;

  /**
   * Primary-key generation strategy. Decorator-free equivalent of
   * `@PrimaryGeneratedColumn("uuid" | "uuid-v7" | "increment")`.
   * Pair with `primary: true`.
   */
  generationStrategy?: GenerationStrategy;

  /**
   * Declares a JSON/JSONB expression index over this column (or a path inside
   * it). Decorator-free equivalent of `@JsonIndex(...)`. Pair with
   * `type: "jsonb"`.
   */
  jsonIndex?: JsonIndexOptions;

  /**
   * Marks this column as the tenant discriminator. Decorator-free equivalent
   * of `@TenantColumn()`. Only meaningful when `tenantStrategy: "tenant_column"`
   * is configured globally.
   */
  tenant?: boolean;

  // Special column flags (replace dedicated decorators)
  index?: boolean;
  createTimestamp?: boolean;
  updateTimestamp?: boolean;
  deletedAt?: boolean;
  version?: boolean;

  // Inline validation
  validation?: ValidationDef[];
}

/**
 * Relation definition for EntitySchema.
 * Discriminated union on `kind` to cover all 4 relation types.
 */
export type RelationSchemaDef =
  | ManyToOneRelationDef
  | OneToManyRelationDef
  | OneToOneRelationDef
  | ManyToManyRelationDef;

export interface ManyToOneRelationDef {
  kind: "manyToOne";
  target: () => ClazzType;
  joinColumn?: string;
  references?: string;
  eager?: boolean;
  cascade?: CascadeOption;
  lazy?: boolean;
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
  createForeignKeyConstraints?: boolean;

  /**
   * FK column metadata (name, type, nullable, referencedColumn).
   * Decorator-free equivalent of pairing `@RelationColumn(...)` with the
   * relation. Use when you need explicit control over the foreign-key column.
   */
  relationColumn?: RelationColumnOption;
}

export interface OneToManyRelationDef {
  kind: "oneToMany";
  target: () => ClazzType;
  mappedBy: string;
  cascade?: CascadeOption;
}

export interface OneToOneRelationDef {
  kind: "oneToOne";
  target: () => ClazzType;
  joinColumn?: string;
  inverseSide?: string;
  eager?: boolean;
  cascade?: CascadeOption;
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
  createForeignKeyConstraints?: boolean;

  /**
   * FK column metadata (name, type, nullable, referencedColumn).
   * Decorator-free equivalent of pairing `@RelationColumn(...)` with the
   * owning side of the relation.
   */
  relationColumn?: RelationColumnOption;
}

export interface ManyToManyRelationDef {
  kind: "manyToMany";
  target: () => ClazzType;
  joinTable?: JoinTableOption;
  mappedBy?: string;
  cascade?: CascadeOption;
}

/**
 * Inheritance strategy definition for the root entity of a hierarchy.
 */
export interface InheritanceSchemaDef {
  strategy: InheritanceStrategy;
}

/**
 * Discriminator column definition for the root entity of a hierarchy.
 */
export interface DiscriminatorColumnSchemaDef {
  /** Column name in the database. Default: "dtype" */
  name?: string;
  /** Column type. Default: "varchar" */
  type?: KnownColumnType;
  /** Column length (for varchar). Default: 31 */
  length?: number;
}

/**
 * Main input type for EntitySchema.
 * `T` is the entity class — column/relation keys are type-checked against it.
 */
export interface EntitySchemaOptions<T> {
  target: ClazzType<T>;
  tableName?: string;
  columns: { [K in keyof T]?: ColumnSchemaDef };

  /**
   * Database-level generated/computed columns. Decorator-free equivalent of
   * `@ComputedColumn(...)`. Keep these out of `columns` — they are excluded
   * from INSERT/UPDATE and rendered as `GENERATED ALWAYS AS (...)`.
   *
   * @example
   * ```ts
   * new EntitySchema<User>({
   *   target: User,
   *   columns: { firstName: { type: "varchar" }, lastName: { type: "varchar" } },
   *   computedColumns: {
   *     fullName: { expression: "first_name || ' ' || last_name", stored: true, type: "varchar" },
   *   },
   * });
   * ```
   */
  computedColumns?: { [K in keyof T]?: ComputedColumnOption };

  relations?: { [K in keyof T]?: RelationSchemaDef };
  uniqueIndexes?: { columns: string[]; name?: string }[];
  indexes?: { columns: string[]; name?: string; options?: AdvancedIndexOptions }[];

  /**
   * Full-text search indexes. Decorator-free equivalent of `@FullTextIndex(...)`.
   * PostgreSQL → GIN `to_tsvector`, MySQL → `FULLTEXT`, SQLite → no-op.
   */
  fullTextIndexes?: { columns: string[]; name?: string; language?: string }[];

  /**
   * Excludes this entity from the `"tenant_column"` strategy. Decorator-free
   * equivalent of `@NonTenantEntity()`. Use for inherently global entities
   * (the tenants table, system config, shared reference data).
   */
  nonTenant?: boolean;

  hooks?: Partial<Record<HookEvent, Extract<keyof T, string>>>;

  /**
   * Marks this entity as the root of an inheritance hierarchy.
   * Only set this on the root (parent) entity.
   *
   * @example
   * ```ts
   * new EntitySchema<Payment>({
   *   target: Payment,
   *   inheritance: { strategy: "SINGLE_TABLE" },
   *   discriminatorColumn: { name: "payment_type" },
   *   columns: { id: { type: "int", primary: true, autoIncrement: true }, amount: { type: "int" } },
   * });
   * ```
   */
  inheritance?: InheritanceSchemaDef;

  /**
   * Configures the discriminator column. Only meaningful on the root entity.
   * Defaults to `{ name: "dtype", type: "varchar", length: 31 }` if omitted.
   */
  discriminatorColumn?: DiscriminatorColumnSchemaDef;

  /**
   * Discriminator value for a child entity.
   * Defaults to the class name if omitted on a child whose parent has `inheritance`.
   *
   * @example
   * ```ts
   * new EntitySchema<CreditCardPayment>({
   *   target: CreditCardPayment,
   *   discriminatorValue: "credit_card",
   *   columns: { cardNumber: { type: "varchar", nullable: true } },
   * });
   * ```
   */
  discriminatorValue?: string;
}
