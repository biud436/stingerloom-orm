/**
 * Core ORM internals are intentionally not re-exported here.
 *
 * Declared as explicit named re-exports (no `export *`) so that adding an
 * export to an internal module does not silently widen this subpath's API.
 */

export { BaseRawQueryBuilder } from "./BaseRawQueryBuilder";
export { BaseRepository, RelationHandle } from "./BaseRepository";
export {
  ColumnTypeRegistry,
  CustomColumnTypeDefinition,
  DialectName,
} from "./ColumnTypeRegistry";
export { CompiledQuery, p, PlaceholderMarker } from "./CompiledQuery";
export { Conditions } from "./Conditions";
export {
  CursorPaginationOption,
  CursorPaginationResult,
  decodeCursor,
  encodeCursor,
  normalizePageSize,
} from "./CursorPagination";
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
} from "./DatabaseClientOptions";
export {
  EntityEventEmitter,
  EntityEventListener,
  EntityEventPayload,
  EntityEventType,
} from "./EntityEventEmitter";
export {
  ColumnMetadataView,
  EntityManager,
  EntityMetadataView,
  RefSpec,
  RefTuple,
  RelationMetadataView,
  TransactionOptions,
} from "./EntityManager";
export {
  DeleteEvent,
  EntitySubscriber,
  InsertEvent,
  UpdateEvent,
} from "./EntitySubscriber";
export { ExplainResult } from "./ExplainResult";
export {
  createLazyProxy,
  injectLazyProxy,
  isLazyProxy,
  LazyLoadFn,
  loadLazy,
} from "./LazyLoader";
export { MultiTenantEntityManager } from "./MultiTenantEntityManager";
export { MyClassConstructor } from "./MyClassConstructor";
export {
  normalizePage,
  PagePaginationOption,
  PagePaginationResult,
} from "./PagePagination";
export {
  QueryLogEntry,
  QueryTracker,
  QueryTrackerEvents,
  QueryTrackerOptions,
} from "./QueryTracker";
export {
  DatabaseType,
  RawQueryBuilder,
  RawQueryExecutor,
  SubqueryType,
} from "./RawQueryBuilder";
export {
  QueryBuilderFactoryFn,
  RawQueryBuilderFactory,
} from "./RawQueryBuilderFactory";
export {
  CoerceMap,
  coerceRow,
  coerceRows,
  CoerceType,
  RawResultOptions,
} from "./RawValueCoercion";
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
} from "./SelectQueryBuilder";
export { AliasRef, createAliasRef, createEntitySqlRef, SqlRef } from "./SqlRef";
export {
  TenantConnectionRouter,
  TenantConnectionRouterOptions,
  TenantDatabaseResolver,
} from "./TenantConnectionRouter";
export {
  DatabaseStrategy,
  SchemaQualifiedStrategy,
  SearchPathStrategy,
  TenantColumnStrategy,
  TenantQueryStrategy,
} from "./TenantQueryStrategy";
export { UpdateQueryBuilder } from "./UpdateQueryBuilder";
export {
  ClassTransformerDeserializer,
} from "./deserializer/ClassTransformerDeserializer";
export { deserializeEntity } from "./deserializer/DeserializeEntity";
export { DeserializeOptions } from "./deserializer/DeserializeOptions";
export { Deserializer } from "./deserializer/Deserializer";
export { DeserializerRegistry } from "./deserializer/DeserializerRegistry";
export {
  PlainObjectDeserializer,
} from "./deserializer/PlainObjectDeserializer";
export {
  AggregateCondition,
  AggregateExpression,
  AggregateFunc,
  aggregateOver,
} from "./expressions/AggregateExpression";
export { AliasedExpression } from "./expressions/AliasedExpression";
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
} from "./expressions/CaseExpression";
export { ConditionLike } from "./expressions/ConditionLike";
export {
  dateDiff,
  dateTrunc,
  random,
} from "./expressions/DateArithmeticExpression";
export {
  JsonPathCondition,
  JsonPathExpression,
  JsonScalarExpression,
} from "./expressions/JsonPathExpression";
export {
  Expressions,
  LogicalCondition,
  LogicalOperator,
} from "./expressions/LogicalCondition";
export { coalesce, nullif } from "./expressions/NullishExpression";
export {
  NullsPosition,
  OrderDirection,
  OrderExpression,
} from "./expressions/OrderExpression";
export {
  mode,
  OrderedSetAggregateExpression,
  OrderedSetAggregateFunc,
  OrderedSetOrderByTarget,
  percentileCont,
  percentileDisc,
} from "./expressions/OrderedSetAggregateExpression";
export { rawExpr } from "./expressions/RawExpression";
export { RegexInput } from "./expressions/RegexPattern";
export {
  ScalarCondition,
  ScalarExpression,
} from "./expressions/ScalarExpression";
export {
  exists,
  ExistsCondition,
  notExists,
} from "./expressions/SubqueryExpression";
export {
  currentDate,
  currentTime,
  currentTimestamp,
} from "./expressions/TemporalExpression";
export {
  tuple,
  TupleColumn,
  TupleCondition,
  TupleExpression,
  TupleOperator,
} from "./expressions/TupleExpression";
export { WindowBuilder } from "./expressions/WindowExpression";
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
} from "./expressions/WindowFunctions";
export {
  DefaultNamingStrategy,
  NamingStrategy,
} from "./generators/NamingStrategy";
export {
  ColumnChange,
  createSchemaDiffResult,
  EnumChange,
  RenamedColumn,
  SchemaDiff,
  SchemaDiffOptions,
  SchemaDiffResult,
} from "./generators/SchemaDiff";
export {
  SchemaDiffMigrationGenerator,
} from "./generators/SchemaDiffMigrationGenerator";
export {
  SchemaDialect,
  SchemaGenerator,
  SchemaGeneratorOptions,
} from "./generators/SchemaGenerator";
export { SnakeNamingStrategy } from "./generators/SnakeNamingStrategy";
export { PluginContext } from "./plugin/PluginContext";
export {
  InstalledPlugin,
  QueryInfo,
  StingerloomPlugin,
} from "./plugin/StingerloomPlugin";
export {
  DeleteEntry,
  InsertEntry,
  PersistEntry,
  TrackedEntry,
} from "./plugin/buffer/BufferEntry";
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
} from "./plugin/buffer/BufferPreview";
export {
  BufferStrategy,
  SnapshotStrategy,
} from "./plugin/buffer/BufferStrategy";
export { EntityState } from "./plugin/buffer/EntityUnitState";
export { WriteBuffer } from "./plugin/buffer/WriteBuffer";
export { bufferPlugin } from "./plugin/buffer/bufferPlugin";
export {
  FilteredMappedPipeline,
  MappedPipeline,
  RawPipeline,
  RawPipelineOptions,
  rawPipelinePlugin,
} from "./plugin/raw-pipeline/index";
