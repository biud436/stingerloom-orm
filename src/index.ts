/**
 * Stingerloom ORM - A standalone, framework-agnostic TypeScript ORM
 *
 * This ORM can be used with any Node.js framework or standalone.
 * It provides a clean, type-safe API for working with MySQL, PostgreSQL,
 * and SQLite databases.
 *
 * The public API surface is declared here as explicit named re-exports.
 * Wildcard (`export *`) re-exports are deliberately avoided so that adding an
 * export to an internal module does not silently widen the published API.
 * A new symbol becomes public only by being listed below, and
 * `__tests__/unit/public-api-surface.test.ts` guards the surface against
 * accidental drift.
 */

// Ensure reflect-metadata is loaded before any decorator usage
import "reflect-metadata";

// Core ORM functionality
export { DatabaseClient } from "./DatabaseClient";
export { BaseRawQueryBuilder } from "./core/BaseRawQueryBuilder";
export { BaseRepository, RelationHandle } from "./core/BaseRepository";
export {
  ColumnTypeRegistry,
  CustomColumnTypeDefinition,
  DialectName,
} from "./core/ColumnTypeRegistry";
export { CompiledQuery, p, PlaceholderMarker } from "./core/CompiledQuery";
export { Conditions } from "./core/Conditions";
export {
  CursorPaginationOption,
  CursorPaginationResult,
  decodeCursor,
  encodeCursor,
  normalizePageSize,
} from "./core/CursorPagination";
export {
  DatabaseClientOptions,
  LoggingOptions,
  normalizeSynchronizePolicy,
  PoolOptions,
  RetryOptions,
  ServerDatabaseClientOptions,
  SqliteDatabaseClientOptions,
  SslOptions,
  SynchronizeMode,
  SynchronizeOption,
  SynchronizeOptions,
  SynchronizePolicy,
  validateDatabaseClientOptions,
} from "./core/DatabaseClientOptions";
export {
  EntityEventEmitter,
  EntityEventListener,
  EntityEventPayload,
  EntityEventType,
} from "./core/EntityEventEmitter";
export {
  ColumnMetadataView,
  EntityManager,
  EntityMetadataView,
  RefSpec,
  RefTuple,
  RelationMetadataView,
  TransactionOptions,
} from "./core/EntityManager";
export {
  DeleteEvent,
  EntitySubscriber,
  InsertEvent,
  UpdateEvent,
} from "./core/EntitySubscriber";
export { ExplainResult } from "./core/ExplainResult";
export {
  createLazyProxy,
  injectLazyProxy,
  isLazyProxy,
  LazyLoadFn,
  loadLazy,
} from "./core/LazyLoader";
export { MultiTenantEntityManager } from "./core/MultiTenantEntityManager";
export { MyClassConstructor } from "./core/MyClassConstructor";
export {
  normalizePage,
  PagePaginationOption,
  PagePaginationResult,
} from "./core/PagePagination";
export {
  QueryLogEntry,
  QueryTracker,
  QueryTrackerEvents,
  QueryTrackerOptions,
} from "./core/QueryTracker";
export {
  DatabaseType,
  RawQueryBuilder,
  RawQueryExecutor,
  SubqueryType,
} from "./core/RawQueryBuilder";
export {
  QueryBuilderFactoryFn,
  RawQueryBuilderFactory,
} from "./core/RawQueryBuilderFactory";
export {
  CoerceMap,
  coerceRow,
  coerceRows,
  CoerceType,
  RawResultOptions,
} from "./core/RawValueCoercion";
export {
  alias,
  ArrayValidator,
  ColumnCondition,
  ColumnExpression,
  EntityRef,
  JoinOnBuilder,
  qAlias,
  QEntity,
  QEntityDynamicAccess,
  RowValidator,
  SelectQueryBuilder,
  SubqueryInput,
  WhereGroupBuilder,
  WhereOperator,
} from "./core/SelectQueryBuilder";
export {
  AliasRef,
  createAliasRef,
  createEntitySqlRef,
  SqlRef,
} from "./core/SqlRef";
export {
  TenantConnectionRouter,
  TenantConnectionRouterOptions,
  TenantDatabaseResolver,
} from "./core/TenantConnectionRouter";
export {
  DatabaseStrategy,
  SchemaQualifiedStrategy,
  SearchPathStrategy,
  TenantColumnStrategy,
  TenantQueryStrategy,
} from "./core/TenantQueryStrategy";
export { UpdateQueryBuilder } from "./core/UpdateQueryBuilder";
export {
  ClassTransformerDeserializer,
} from "./core/deserializer/ClassTransformerDeserializer";
export { deserializeEntity } from "./core/deserializer/DeserializeEntity";
export { DeserializeOptions } from "./core/deserializer/DeserializeOptions";
export { Deserializer } from "./core/deserializer/Deserializer";
export { DeserializerRegistry } from "./core/deserializer/DeserializerRegistry";
export {
  PlainObjectDeserializer,
} from "./core/deserializer/PlainObjectDeserializer";
export {
  AggregateCondition,
  AggregateExpression,
  AggregateFunc,
  aggregateOver,
} from "./core/expressions/AggregateExpression";
export { AliasedExpression } from "./core/expressions/AliasedExpression";
export {
  BucketOperator,
  buckets,
  caseBuilder,
  CaseBuilder,
  cases,
  CaseValueBuilder,
  CaseWhenBuilder,
  iff,
  mapValues,
} from "./core/expressions/CaseExpression";
export { ConditionLike } from "./core/expressions/ConditionLike";
export {
  dateDiff,
  dateTrunc,
  random,
} from "./core/expressions/DateArithmeticExpression";
export {
  JsonPathCondition,
  JsonPathExpression,
  JsonScalarExpression,
} from "./core/expressions/JsonPathExpression";
export {
  Expressions,
  LogicalCondition,
  LogicalOperator,
} from "./core/expressions/LogicalCondition";
export { coalesce, nullif } from "./core/expressions/NullishExpression";
export {
  NullsPosition,
  OrderDirection,
  OrderExpression,
} from "./core/expressions/OrderExpression";
export {
  mode,
  OrderedSetAggregateExpression,
  OrderedSetAggregateFunc,
  OrderedSetOrderByTarget,
  percentileCont,
  percentileDisc,
} from "./core/expressions/OrderedSetAggregateExpression";
export { rawExpr } from "./core/expressions/RawExpression";
export { RegexInput } from "./core/expressions/RegexPattern";
export {
  ScalarCondition,
  ScalarExpression,
} from "./core/expressions/ScalarExpression";
export {
  exists,
  ExistsCondition,
  notExists,
} from "./core/expressions/SubqueryExpression";
export {
  currentDate,
  currentTime,
  currentTimestamp,
} from "./core/expressions/TemporalExpression";
export {
  tuple,
  TupleColumn,
  TupleCondition,
  TupleExpression,
  TupleOperator,
} from "./core/expressions/TupleExpression";
export { WindowBuilder } from "./core/expressions/WindowExpression";
export {
  cumeDist,
  denseRank,
  firstValue,
  lag,
  lastValue,
  lead,
  nthValue,
  ntile,
  percentRank,
  rank,
  rowNumber,
} from "./core/expressions/WindowFunctions";
export {
  DefaultNamingStrategy,
  NamingStrategy,
} from "./core/generators/NamingStrategy";
export {
  ColumnChange,
  createSchemaDiffResult,
  EnumChange,
  RenamedColumn,
  SchemaDiff,
  SchemaDiffOptions,
  SchemaDiffResult,
} from "./core/generators/SchemaDiff";
export {
  SchemaDiffMigrationGenerator,
} from "./core/generators/SchemaDiffMigrationGenerator";
export {
  SchemaDialect,
  SchemaGenerator,
  SchemaGeneratorOptions,
} from "./core/generators/SchemaGenerator";
export { SnakeNamingStrategy } from "./core/generators/SnakeNamingStrategy";
export { PluginContext } from "./core/plugin/PluginContext";
export {
  InstalledPlugin,
  QueryInfo,
  StingerloomPlugin,
} from "./core/plugin/StingerloomPlugin";
export {
  DeleteEntry,
  InsertEntry,
  PersistEntry,
  TrackedEntry,
} from "./core/plugin/buffer/BufferEntry";
export {
  BufferCascadeOptions,
  BufferChangeset,
  BufferFlushResult,
  BufferPluginOptions,
  BufferPreviewEntry,
  BulkDeleteEntry,
  BulkUpdateEntry,
  ChangeTrackingPolicy,
  FlushEvent,
  FlushEventListener,
  FlushEventType,
  FlushMode,
  LockMode,
} from "./core/plugin/buffer/BufferPreview";
export {
  BufferStrategy,
  SnapshotStrategy,
} from "./core/plugin/buffer/BufferStrategy";
export { EntityState } from "./core/plugin/buffer/EntityUnitState";
export { WriteBuffer } from "./core/plugin/buffer/WriteBuffer";
export { bufferPlugin } from "./core/plugin/buffer/bufferPlugin";
export {
  FilteredMappedPipeline,
  MappedPipeline,
  RawPipeline,
  RawPipelineOptions,
  rawPipelinePlugin,
} from "./core/plugin/raw-pipeline/index";

// Decorators for entity definitions
export {
  Column,
  COLUMN_TOKEN,
  ColumnOption,
  ColumnTransformer,
  ColumnType,
  inferColumnDefaults,
  KnownColumnType,
  ResolvedColumnOption,
} from "./decorators/Column";
export {
  COMPUTED_COLUMN_TOKEN,
  ComputedColumn,
  ComputedColumnExpressionBuilder,
  ComputedColumnExpressionContext,
  ComputedColumnMetadata,
  ComputedColumnOption,
} from "./decorators/ComputedColumn";
export {
  CREATE_TIMESTAMP_TOKEN,
  CreateTimestamp,
  TimestampColumnType,
  TimestampOptions,
} from "./decorators/CreateTimestamp";
export { CustomColumn } from "./decorators/CustomColumn";
export { DELETED_AT_TOKEN, DeletedAt } from "./decorators/DeletedAt";
export {
  DISCRIMINATOR_COLUMN_TOKEN,
  DiscriminatorColumn,
  DiscriminatorColumnOptions,
} from "./decorators/DiscriminatorColumn";
export {
  DISCRIMINATOR_VALUE_TOKEN,
  DiscriminatorValue,
} from "./decorators/DiscriminatorValue";
export {
  Entity,
  ENTITY_TOKEN,
  EntityMetadata,
  EntityOption,
} from "./decorators/Entity";
export {
  FULLTEXT_INDEX_TOKEN,
  FullTextIndex,
  FullTextIndexMetadata,
} from "./decorators/FullTextIndex";
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
} from "./decorators/Hooks";
export {
  AdvancedIndexOptions,
  COMPOSITE_INDEX_TOKEN,
  CompositeIndexMetadata,
  Index,
  INDEX_TOKEN,
  IndexMetadata,
  IndexOption,
} from "./decorators/Indexer";
export {
  Inheritance,
  INHERITANCE_TOKEN,
  InheritanceOptions,
  InheritanceStrategy,
} from "./decorators/Inheritance";
export {
  JSON_INDEX_TOKEN,
  JsonIndex,
  JsonIndexMetadata,
  JsonIndexOptions,
} from "./decorators/JsonIndex";
export {
  JoinTableOption,
  MANY_TO_MANY_TOKEN,
  ManyToMany,
  ManyToManyMetadata,
  ManyToManyOption,
} from "./decorators/ManyToMany";
export {
  EntityLike,
  MANY_TO_ONE_TOKEN,
  ManyToOne,
  ManyToOneMetadata,
  ManyToOneOption,
  RetrieveEntity,
  SetRelatedEntity,
} from "./decorators/ManyToOne";
export {
  ONE_TO_MANY_TOKEN,
  OneToMany,
  OneToManyMetadata,
  OneToManyOption,
} from "./decorators/OneToMany";
export {
  ONE_TO_ONE_TOKEN,
  OneToOne,
  OneToOneMetadata,
  OneToOneOption,
} from "./decorators/OneToOne";
export { PrimaryColumn } from "./decorators/PrimaryColumn";
export {
  GenerationStrategy,
  PrimaryGeneratedColumn,
} from "./decorators/PrimaryGeneratedColumn";
export {
  RELATION_COLUMN_TOKEN,
  RelationColumn,
  RelationColumnMetadata,
  RelationColumnOption,
} from "./decorators/RelationColumn";
export {
  getTenantColumnMetadata,
  isNonTenantEntity,
  NON_TENANT_ENTITY_TOKEN,
  NonTenantEntity,
  TENANT_COLUMN_TOKEN,
  TenantColumn,
  TenantColumnMetadata,
  TenantColumnOptions,
} from "./decorators/TenantColumn";
export {
  Transactional,
  TransactionalOptions,
  TransactionPropagation,
  transactionStorage,
} from "./decorators/Transactional";
export {
  UNIQUE_INDEX_TOKEN,
  UniqueIndex,
  UniqueIndexMetadata,
} from "./decorators/UniqueIndex";
export {
  UPDATE_TIMESTAMP_TOKEN,
  UpdateTimestamp,
} from "./decorators/UpdateTimestamp";
export {
  ConstraintType,
  Max,
  MaxLength,
  Min,
  MinLength,
  NotNull,
  VALIDATION_TOKEN,
  ValidationMetadata,
} from "./decorators/Validation";
export { Version, VERSION_TOKEN } from "./decorators/Version";

// Database dialects and drivers
export {
  ColumnDefContext,
  ColumnDefinitionBuilder,
  ColumnDefinitionDialect,
} from "./dialects/ColumnDefinitionBuilder";
export {
  ConnectionLeakDetector,
  PoolMetrics,
} from "./dialects/ConnectionLeakDetector";
export { DbVersion } from "./dialects/DbVersion";
export {
  ALL_COMMON,
  ALL_MYSQL,
  ALL_POSTGRES,
  ALL_SQLITE,
  CommonCapabilities,
  DialectCapabilities,
  FeatureRule,
  FeatureTable,
  MySqlCapabilities,
  PostgresCapabilities,
  SqliteCapabilities,
  VersionGate,
} from "./dialects/DialectCapabilities";
export {
  AggregateFilterOptions,
  ArrayOperator,
  CastKind,
  ColumnJsonMeta,
  createDialectExpression,
  DateAddUnit,
  DateComponent,
  DateTruncUnit,
  DialectExpression,
  FullTextSearchOptions,
  RegexMatchFlags,
} from "./dialects/DialectExpression";
export { DriverFactory, DriverRegistry } from "./dialects/DriverRegistry";
export { EntityNotFound } from "./dialects/EntityNotFound";
export {
  BaseFilter,
  ComparableFilter,
  FieldFilter,
  FILTER_OPERATOR_KEYS,
  FindOption,
  RelationKeys,
  StringFilter,
  UpdateData,
  UpdateManyOptions,
  WhereClause,
} from "./dialects/FindOption";
export { IConnection } from "./dialects/IConnection";
export { IDataSource } from "./dialects/IDataSource";
export { IOrderBy } from "./dialects/IOrderBy";
export { IQueryEngine } from "./dialects/IQueryEngine";
export { ISelectOption } from "./dialects/ISelectOption";
export {
  ITenantMigrationRunner,
  TenantMigrationRunnerOptions,
  TenantSyncResult,
  TenantTableFilterOptions,
} from "./dialects/ITenantMigrationRunner";
export { ITxEngine } from "./dialects/ITxEngine";
export { TRANSACTION_ISOLATION_LEVEL } from "./dialects/IsolationLevel";
export {
  HealthCheckConfig,
  HealthCheckFn,
  ReplicationConfig,
  ReplicationNodeConfig,
  ReplicationRouter,
  ReplicationStrategy,
} from "./dialects/ReplicationRouter";
export { ISqlDriver } from "./dialects/SqlDriver";
export {
  TransactionSessionManager,
} from "./dialects/TransactionSessionManager";
export {
  MySqlExpression,
  PostgresExpression,
  SqliteExpression,
} from "./dialects/expression/index";
export {
  MySqlTenantMigrationRunner,
  PostgresConnector,
  PostgresDataSource,
  PostgresDriver,
  PostgresTenantMigrationRunner,
  SqliteConnector,
  SqliteDataSource,
  SqliteDriver,
  SqliteTenantMigrationRunner,
} from "./dialects/index";
export { AnyEntity, MySqlConnector } from "./dialects/mysql/MySqlConnector";
export { MySqlDataSource } from "./dialects/mysql/MySqlDataSource";
export { MySqlDriver } from "./dialects/mysql/MySqlDriver";

// Type definitions
export {
  CascadeOption,
  CascadeType,
  hasCascade,
  normalizeCascade,
} from "./types/CascadeType";
export {
  CamelCase,
  ColumnPaths,
  SelectField,
  TableSchema,
} from "./types/ColumnPaths";
export { DeepPartial } from "./types/DeepPartial";
export { DeleteResult } from "./types/DeleteResult";
export { DriverQueryOptions } from "./types/DriverQueryOptions";
export { EntityResult } from "./types/EntityResult";
export { OrderByOption, SortDirection } from "./types/OrderByOption";
export { QueryResult } from "./types/QueryResult";
export {
  ReferentialAction,
  VALID_REFERENTIAL_ACTIONS,
} from "./types/ReferentialAction";

// Metadata management (Layered/Multi-tenant support)
export { MetadataContext } from "./metadata/MetadataContext";
export { MetadataLayer } from "./metadata/MetadataLayer";

// Migration system
export { Migration, MigrationContext } from "./migration/Migration";
export {
  MigrationCli,
  MigrationCommand,
  MigrationGenerateOptions,
} from "./migration/MigrationCli";
export {
  MigrationHooks,
  MigrationQueryRunner,
  MigrationRecord,
  MigrationResult,
  MigrationRunner,
  MigrationRunnerOptions,
} from "./migration/MigrationRunner";
export { MySqlMigrationRunner } from "./migration/MySqlMigrationRunner";
export { PostgresMigrationRunner } from "./migration/PostgresMigrationRunner";
export { SqliteMigrationRunner } from "./migration/SqliteMigrationRunner";

// Database seeding framework
export { Seeder, SeederContext } from "./seeding/Seeder";
export {
  SeederQueryRunner,
  SeederResult,
  SeederRunner,
  SeederRunnerOptions,
} from "./seeding/SeederRunner";

// Database introspection (entity generation from existing schema)
export {
  DbColumn,
  DbForeignKey,
  DbIndex,
  EntityCodeBuilder,
  EntityCodeBuilderOptions,
} from "./introspection/EntityCodeBuilder";
export {
  IntrospectionCliOptions,
  IntrospectionCliResult,
  runIntrospect,
} from "./introspection/IntrospectionCli";
export {
  GeneratedEntity,
  IntrospectionGenerator,
  IntrospectionGeneratorOptions,
  IntrospectionQueryFn,
} from "./introspection/IntrospectionGenerator";
export {
  IntrospectionDialect,
  IntrospectionTypeMapper,
} from "./introspection/TypeMapper";

// Error classes
export { AdvisoryLockError } from "./errors/AdvisoryLockError";
export {
  DatabaseConnectionFailedError,
} from "./errors/DatabaseConnectionFailedError";
export { DatabaseNotConnectedError } from "./errors/DatabaseNotConnectedError";
export {
  DeleteWithoutConditionsError,
} from "./errors/DeleteWithoutConditionsError";
export {
  EntityMetadataNotFoundError,
} from "./errors/EntityMetadataNotFoundError";
export { EntityNotFoundError } from "./errors/EntityNotFoundError";
export { Exception } from "./errors/Exception";
export { InvalidQueryError } from "./errors/InvalidQueryError";
export {
  NotSupportedDatabaseTypeError,
} from "./errors/NotSupportedDatabaseTypeError";
export { OptimisticLockError } from "./errors/OptimisticLockError";
export { OrmError } from "./errors/OrmError";
export { OrmErrorCode } from "./errors/OrmErrorCode";
export { PrimaryKeyNotFoundError } from "./errors/PrimaryKeyNotFoundError";
export { QueryTimeoutError } from "./errors/QueryTimeoutError";
export { TransactionError } from "./errors/TransactionError";
export {
  unsupportedExpression,
  UnsupportedExpressionOptions,
} from "./errors/UnsupportedExpressionError";
export { UnsupportedFeatureError } from "./errors/UnsupportedFeatureError";
export { ValidationError } from "./errors/ValidationError";

// Schema-based entity definitions (decorator-free)
export { EntitySchema } from "./schema/EntitySchema";
export {
  ColumnSchemaDef,
  DiscriminatorColumnSchemaDef,
  EntitySchemaOptions,
  InheritanceSchemaDef,
  ManyToManyRelationDef,
  ManyToOneRelationDef,
  OneToManyRelationDef,
  OneToOneRelationDef,
  RelationSchemaDef,
  ValidationDef,
} from "./schema/EntitySchemaTypes";
export {
  BuilderKind,
  ColumnBuilder,
  ColumnTypes,
  ComputedBuilder,
  ManyToManyBuilderOptions,
  ManyToOneBuilderOptions,
  OneToOneBuilderOptions,
  RelationBuilder,
  SchemaBuilder,
  t,
} from "./schema/builders";
export {
  AnyBuilder,
  defineEntity,
  DefineEntityOptions,
  EntityClass,
  EntityColumns,
  EntityHookFn,
  InferEntity,
  InferShape,
} from "./schema/defineEntity";

// Prisma import (requires optional @mrleebo/prisma-ast)
export {
  FileWriter,
  FileWriterOptions,
  ManyToManyInverseRelation,
  ManyToManyOwningRelation,
  ManyToOneRelation,
  NativeTypeHint,
  OneToManyRelation,
  OneToOneInverseRelation,
  OneToOneOwningRelation,
  PrismaDefaultValue,
  PrismaEnumInfo,
  PrismaFieldInfo,
  PrismaImportContext,
  PrismaImporter,
  PrismaImportOptions,
  PrismaImportResult,
  PrismaModelInfo,
  PrismaRelationInfo,
  RelationResolver,
  ResolvedRelation,
  TypeMapper,
  TypeMappingResult,
  WriteResult,
} from "./integration/prisma-import/index";

// Utilities (explicit subset - low-level internals are intentionally not public)
export { ClazzType, Type } from "./utils/types";
export { Logger } from "./utils/Logger";
export { generateUUIDv7, extractTimestampFromUUIDv7 } from "./utils/uuid-v7";

// Re-export sql-template-tag utilities for updateMany SQL expressions.
// Kept public deliberately: `sql`/`raw`/`join`/`empty` appear in documented
// updateMany examples and `Sql` is the accepted parameter type there, so the
// coupling is part of the existing contract. Revisit wrapping it behind an
// owned type in a future major. Routed through the sqlTag wrapper so the
// `sql` default stays a function in the ESM build (see utils/sqlTag.ts).
export { default as sql, Sql, raw, join, empty } from "./utils/sqlTag";
