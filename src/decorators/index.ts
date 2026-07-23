/**
 * Entity definition decorators.
 *
 * Declared as explicit named re-exports (no `export *`) so that adding an
 * export to an internal module does not silently widen this subpath's API.
 */

export {
  Column,
  COLUMN_TOKEN,
  ColumnOption,
  ColumnTransformer,
  ColumnType,
  inferColumnDefaults,
  KnownColumnType,
  ResolvedColumnOption,
} from "./Column";
export {
  COMPUTED_COLUMN_TOKEN,
  ComputedColumn,
  ComputedColumnExpressionBuilder,
  ComputedColumnExpressionContext,
  ComputedColumnMetadata,
  ComputedColumnOption,
} from "./ComputedColumn";
export {
  CREATE_TIMESTAMP_TOKEN,
  CreateTimestamp,
  TimestampColumnType,
  TimestampOptions,
} from "./CreateTimestamp";
export { CustomColumn } from "./CustomColumn";
export { DELETED_AT_TOKEN, DeletedAt } from "./DeletedAt";
export {
  DISCRIMINATOR_COLUMN_TOKEN,
  DiscriminatorColumn,
  DiscriminatorColumnOptions,
} from "./DiscriminatorColumn";
export {
  DISCRIMINATOR_VALUE_TOKEN,
  DiscriminatorValue,
} from "./DiscriminatorValue";
export { Entity, ENTITY_TOKEN, EntityMetadata, EntityOption } from "./Entity";
export {
  FULLTEXT_INDEX_TOKEN,
  FullTextIndex,
  FullTextIndexMetadata,
} from "./FullTextIndex";
export {
  AfterDelete,
  AfterInsert,
  AfterUpdate,
  BeforeDelete,
  BeforeInsert,
  BeforeUpdate,
  HOOK_TOKEN,
  HookEvent,
  HookMetadata,
} from "./Hooks";
export {
  AdvancedIndexOptions,
  COMPOSITE_INDEX_TOKEN,
  CompositeIndexMetadata,
  Index,
  INDEX_TOKEN,
  IndexMetadata,
  IndexOption,
} from "./Indexer";
export {
  Inheritance,
  INHERITANCE_TOKEN,
  InheritanceOptions,
  InheritanceStrategy,
} from "./Inheritance";
export {
  JSON_INDEX_TOKEN,
  JsonIndex,
  JsonIndexMetadata,
  JsonIndexOptions,
} from "./JsonIndex";
export {
  JoinTableOption,
  MANY_TO_MANY_TOKEN,
  ManyToMany,
  ManyToManyMetadata,
  ManyToManyOption,
} from "./ManyToMany";
export {
  EntityLike,
  MANY_TO_ONE_TOKEN,
  ManyToOne,
  ManyToOneMetadata,
  ManyToOneOption,
  RetrieveEntity,
  SetRelatedEntity,
} from "./ManyToOne";
export {
  ONE_TO_MANY_TOKEN,
  OneToMany,
  OneToManyMetadata,
  OneToManyOption,
} from "./OneToMany";
export {
  ONE_TO_ONE_TOKEN,
  OneToOne,
  OneToOneMetadata,
  OneToOneOption,
} from "./OneToOne";
export { PrimaryColumn } from "./PrimaryColumn";
export {
  GenerationStrategy,
  PrimaryGeneratedColumn,
} from "./PrimaryGeneratedColumn";
export {
  RELATION_COLUMN_TOKEN,
  RelationColumn,
  RelationColumnMetadata,
  RelationColumnOption,
} from "./RelationColumn";
export {
  getTenantColumnMetadata,
  isNonTenantEntity,
  NON_TENANT_ENTITY_TOKEN,
  NonTenantEntity,
  TENANT_COLUMN_TOKEN,
  TenantColumn,
  TenantColumnMetadata,
  TenantColumnOptions,
} from "./TenantColumn";
export {
  Transactional,
  TransactionalOptions,
  TransactionPropagation,
  transactionStorage,
} from "./Transactional";
export {
  UNIQUE_INDEX_TOKEN,
  UniqueIndex,
  UniqueIndexMetadata,
} from "./UniqueIndex";
export { UPDATE_TIMESTAMP_TOKEN, UpdateTimestamp } from "./UpdateTimestamp";
export {
  ConstraintType,
  Max,
  MaxLength,
  Min,
  MinLength,
  NotNull,
  VALIDATION_TOKEN,
  ValidationMetadata,
} from "./Validation";
export { Version, VERSION_TOKEN } from "./Version";
