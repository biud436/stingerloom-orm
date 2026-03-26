/* eslint-disable @typescript-eslint/no-explicit-any */
import { ColumnType } from "../decorators/Column";
import { CascadeOption } from "../types/CascadeType";
import { ReferentialAction } from "../types/ReferentialAction";
import { JoinTableOption } from "../decorators/ManyToMany";
import { HookEvent } from "../decorators/Hooks";
import { ConstraintType } from "../decorators/Validation";
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
  transform?: (raw: unknown) => any;

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
}

export interface ManyToManyRelationDef {
  kind: "manyToMany";
  target: () => ClazzType;
  joinTable?: JoinTableOption;
  mappedBy?: string;
  cascade?: CascadeOption;
}

/**
 * Main input type for EntitySchema.
 * `T` is the entity class — column/relation keys are type-checked against it.
 */
export interface EntitySchemaOptions<T> {
  target: ClazzType<T>;
  tableName?: string;
  columns: { [K in keyof T]?: ColumnSchemaDef };
  relations?: { [K in keyof T]?: RelationSchemaDef };
  uniqueIndexes?: { columns: string[]; name?: string }[];
  indexes?: { columns: string[]; name?: string }[];
  hooks?: Partial<Record<HookEvent, Extract<keyof T, string>>>;
}
