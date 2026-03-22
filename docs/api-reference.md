# API Reference

A quick-reference for method signatures and types. For usage and examples, see the topic-specific documentation.

- [Entity Definition](./entities.md) | [Relations](./relations.md) | [EntityManager](./entity-manager.md)
- [Query Builder](./query-builder.md) | [Transactions](./transactions.md) | [Migrations](./migrations.md)
- [Advanced Features](./advanced.md) | [Multi-Tenancy](./multi-tenancy.md) | [Configuration](./configuration.md)

## EntityManager

```typescript
import { EntityManager } from "@stingerloom/orm";
const em = new EntityManager();
```

### Connection

| Method | Signature | Description |
|--------|-----------|-------------|
| `register` | `(options: DatabaseClientOptions, connectionName?: string): Promise<void>` | Connect to DB + register entities |
| `getConnectionName` | `(): string` | Connection name (default: `"default"`) |
| `getDriver` | `(): ISqlDriver \| undefined` | SQL driver |
| `propagateShutdown` | `(): Promise<void>` | Clean up internal resources |

### CRUD

| Method | Signature | Description |
|--------|-----------|-------------|
| `find` | `<T>(entity, option?): Promise<T[]>` | List query |
| `findOne` | `<T>(entity, option): Promise<T \| null>` | Single record query |
| `findAndCount` | `<T>(entity, option?): Promise<[T[], number]>` | List + total count |
| `findWithCursor` | `<T>(entity, option?): Promise<CursorPaginationResult<T>>` | Cursor pagination |
| `save` | `<T>(entity, item): Promise<InstanceType<ClazzType<T>>>` | INSERT or UPDATE |
| `delete` | `<T>(entity, criteria): Promise<DeleteResult>` | Permanent delete |
| `softDelete` | `<T>(entity, criteria): Promise<DeleteResult>` | Soft Delete |
| `restore` | `<T>(entity, criteria): Promise<DeleteResult>` | Restore Soft Delete |
| `upsert` | `<T>(entity, data, conflictColumns?): Promise<void>` | INSERT ... ON CONFLICT |
| `updateMany` | `<T>(entity, criteria, partial): Promise<{ affected: number }>` | Bulk UPDATE by condition |

### Batch

| Method | Signature | Description |
|--------|-----------|-------------|
| `insertMany` | `<T>(entity, items[]): Promise<{ affected: number }>` | Multi-row INSERT |
| `saveMany` | `<T>(entity, items[]): Promise<InstanceType<ClazzType<T>>[]>` | Multi-row INSERT/UPDATE |
| `deleteMany` | `<T>(entity, ids[]): Promise<DeleteResult>` | Multi-row delete |

### Aggregation

| Method | Signature | Description |
|--------|-----------|-------------|
| `count` | `<T>(entity, where?): Promise<number>` | Count |
| `sum` | `<T>(entity, field, where?): Promise<number>` | Sum |
| `avg` | `<T>(entity, field, where?): Promise<number>` | Average |
| `min` | `<T>(entity, field, where?): Promise<number>` | Minimum |
| `max` | `<T>(entity, field, where?): Promise<number>` | Maximum |

### Streaming

| Method | Signature | Description |
|--------|-----------|-------------|
| `stream` | `<T>(entity, option?, batchSize?): AsyncGenerator<T>` | Async generator for large datasets |

```typescript
for await (const user of em.stream(User, { where: { isActive: true } }, 1000)) {
  // process one entity at a time without holding all rows in memory
}
```

### Transaction

| Method | Signature | Description |
|--------|-----------|-------------|
| `transaction` | `<T>(callback: (em: EntityManager) => Promise<T>, options?: TransactionOptions): Promise<T>` | Execute callback in a transaction (with optional deadlock retry) |

### Raw Query / Analysis

| Method | Signature | Description |
|--------|-----------|-------------|
| `query` | `<T>(sql: string \| Sql, params?: unknown[]): Promise<T[]>` | Execute arbitrary SQL |
| `explain` | `<T>(entity, option?): Promise<ExplainResult>` | EXPLAIN analysis |

### Query Builder

| Method | Signature | Description |
|--------|-----------|-------------|
| `createQueryBuilder` | `(): BaseRawQueryBuilder` | Create a RawQueryBuilder (free-form SQL) |
| `createQueryBuilder` | `<T>(entity, alias): SelectQueryBuilder<T>` | Create a type-safe SelectQueryBuilder |

### Plugin System

| Method | Signature | Description |
|--------|-----------|-------------|
| `extend` | `<TApi>(plugin: StingerloomPlugin<TApi>): this & TApi` | Install a plugin |
| `hasPlugin` | `(name: string): boolean` | Check if installed |
| `getPluginApi` | `<T>(name: string): T \| undefined` | Get plugin API by name |

### Events

| Method | Signature | Description |
|--------|-----------|-------------|
| `on` | `(event: EntityEventType, listener): void` | Register listener |
| `off` | `(event: EntityEventType, listener): void` | Remove listener |
| `removeAllListeners` | `(): void` | Remove all listeners |
| `addSubscriber` | `(subscriber: EntitySubscriber<any>): void` | Register subscriber |
| `removeSubscriber` | `(subscriber: EntitySubscriber<any>): void` | Remove subscriber |
| `getQueryLog` | `(): ReadonlyArray<QueryLogEntry>` | Query log |

## BaseRepository

Per-entity CRUD wrapper. [Usage ->](./advanced.md)

```typescript
const userRepo = em.getRepository(User);
// or
const userRepo = BaseRepository.of(User, em);
```

`find`, `findOne`, `findWithCursor`, `findAndCount`, `save`, `delete`, `remove`, `softDelete`, `restore`, `insertMany`, `saveMany`, `deleteMany`, `count`, `sum`, `avg`, `min`, `max`, `explain`, `upsert`, `persist`, `stream`, `createQueryBuilder` — Uses the same API as EntityManager without specifying the entity.

## Decorators

### Entity

| Decorator | Description |
|-----------|-------------|
| `@Entity(options?)` | Register a class as an ORM entity. `{ name: "table_name" }` |
| `@Column(option?)` | Regular column |
| `@PrimaryGeneratedColumn(option?)` | Auto-increment PK |
| `@PrimaryColumn(option?)` | Manual PK |
| `@Index()` | Single-column index (property level) |
| `@Index(columns, name?)` | Composite non-unique index (class level) |
| `@UniqueIndex(columns, name?)` | Composite unique index (class level) |
| `@Version()` | Optimistic locking version column |
| `@DeletedAt()` | Soft Delete timestamp |
| `@CreateTimestamp()` | Auto-set on INSERT (datetime NOT NULL) |
| `@UpdateTimestamp()` | Auto-set on INSERT and UPDATE (datetime NOT NULL) |

### Relations

| Decorator | Description |
|-----------|-------------|
| `@ManyToOne(getEntity, getProperty?, option?)` | Many-to-one (FK owner side) |
| `@OneToMany(getEntity, option)` | One-to-many (inverse side) |
| `@OneToOne(getEntity, option?)` | One-to-one |
| `@ManyToMany(getEntity, option?)` | Many-to-many |

### Lifecycle Hooks

| Decorator | Timing |
|-----------|--------|
| `@BeforeInsert` | Just before INSERT |
| `@AfterInsert` | After INSERT |
| `@BeforeUpdate` | Just before UPDATE |
| `@AfterUpdate` | After UPDATE |
| `@BeforeDelete` | Just before DELETE |
| `@AfterDelete` | After DELETE |

### Validation

| Decorator | Description |
|-----------|-------------|
| `@NotNull()` | Disallow null/undefined |
| `@MinLength(n)` | Minimum string length |
| `@MaxLength(n)` | Maximum string length |
| `@Min(n)` | Minimum numeric value |
| `@Max(n)` | Maximum numeric value |

### Transaction / DI

| Decorator | Description |
|-----------|-------------|
| `@Transactional(isolationLevel?)` | Wrap method in a transaction |
| `@InjectRepository(Entity, connectionName?)` | Inject `BaseRepository<T>` in NestJS (default connection if omitted) |
| `@InjectEntityManager(connectionName?)` | Inject `EntityManager` in NestJS (default connection if omitted) |

## Type Reference

### FindOption\<T\>

```typescript
interface FindOption<T> {
  select?: (keyof T)[] | Partial<Record<keyof T, boolean>>;
  where?: WhereClause<T> | WhereClause<T>[];  // single or array (OR between groups)
  limit?: number | [number, number];
  skip?: number;
  take?: number;
  orderBy?: Partial<Record<keyof T, "ASC" | "DESC">>;
  groupBy?: (keyof T)[];
  having?: Sql[];
  relations?: (keyof T)[];
  withDeleted?: boolean;
  distinct?: boolean;            // SELECT DISTINCT
  timeout?: number;
  useMaster?: boolean;
  lock?: LockMode;
}
```

### WhereClause\<T\>

Each field accepts a plain value (equality), a filter object, a `Sql` object, or `null`:

```typescript
type WhereClause<T> = {
  [K in keyof T]?: T[K] | FieldFilter<T[K]> | Sql | null;
} & {
  OR?: WhereClause<T>[];
  AND?: WhereClause<T>[];
  NOT?: WhereClause<T>;
};
```

### Filter Operators

Operators are determined by the field type — `string` fields get extra operators like `contains` and `startsWith`.

```typescript
// All types: BaseFilter<T>
{ eq, ne, in, notIn, not, isNull }

// number, Date, bigint: ComparableFilter<T> (extends BaseFilter)
{ gt, gte, lt, lte, between }

// string: StringFilter (extends ComparableFilter)
{ like, notLike, ilike, contains, startsWith, endsWith }
```

See [Querying — WHERE Filters](./entity-manager-querying.md#where-filters) for usage examples.

### WhereOperator (SelectQueryBuilder)

Type-safe operator union for the 3-arg `where()` method:

```typescript
type WhereOperator =
  | "=" | "!=" | "<>" | "<" | ">" | "<=" | ">="
  | "LIKE" | "NOT LIKE" | "ILIKE"
  | "IN" | "NOT IN"
  | "IS NULL" | "IS NOT NULL" | "BETWEEN";
```

### TransactionOptions

```typescript
interface TransactionOptions {
  retryOnDeadlock?: boolean;  // Enable deadlock retry (default: false)
  maxRetries?: number;        // Maximum retries (default: 3)
  retryDelayMs?: number;      // Delay between retries in ms (default: 100)
}
```

### SelectQueryBuilder\<T\>

[Usage ->](./query-builder.md)

```typescript
// Created via em.createQueryBuilder(Entity, "alias")
class SelectQueryBuilder<T> {
  select(columns: (keyof T & string)[] | "*"): this;
  addSelect(expr: Sql | string, alias?: string): this;
  setDistinct(value?: boolean): this;
  where(condition: Sql): this;
  where(column: keyof T & string, value: any): this;
  where(column: keyof T & string, operator: string, value: any): this;
  andWhere(...): this;
  orWhere(...): this;
  whereIn(column: keyof T & string, values: any[]): this;
  whereNotIn(column: keyof T & string, values: any[]): this;
  whereNull(column: keyof T & string): this;
  whereNotNull(column: keyof T & string): this;
  whereBetween(column: keyof T & string, min: any, max: any): this;
  whereLike(column: keyof T & string, pattern: string): this;
  leftJoin(table: string, alias: string, condition: Sql | string): this;
  innerJoin(table: string, alias: string, condition: Sql | string): this;
  rightJoin(table: string, alias: string, condition: Sql | string): this;
  orderBy(spec: { [K in keyof T & string]?: "ASC" | "DESC" }): this;
  addOrderBy(column: keyof T & string, direction: "ASC" | "DESC"): this;
  groupBy(columns: (keyof T & string)[]): this;
  having(condition: Sql): this;
  limit(count: number): this;
  offset(count: number): this;
  skip(count: number): this;
  take(count: number): this;
  forUpdate(): this;
  forShare(): this;
  withDeleted(): this;
  appendSql(fragment: Sql): this;
  validate(validator: RowValidator<TResult>): this;
  validateArray(validator: ArrayValidator<TResult>): this;
  toSql(): Sql;
  getSql(): { text: string; values: any[] };
  getMany(): Promise<TResult[]>;
  getOne(): Promise<TResult | null>;
  getCount(): Promise<number>;
  getManyAndCount(): Promise<[T[], number]>;
  exists(): Promise<boolean>;
  asSubquery(alias: string): Sql;
}
```

### RawQueryBuilder — Set Operations, CTE, Window Functions

[Usage ->](./query-builder.md)

```typescript
class RawQueryBuilder {
  // ... (basic SELECT/FROM/WHERE/JOIN/ORDER BY/LIMIT methods)

  // Set Operations
  union(): this;
  unionAll(): this;
  intersect(): this;
  except(): this;

  // DISTINCT
  selectDistinct(columns: string[]): this;
  selectDistinctOn(distinctColumns: string[], selectColumns: string[] | "*"): this;

  // Common Table Expressions
  with(name: string, subquery: Sql | ((qb: RawQueryBuilder) => RawQueryBuilder)): this;
  withRecursive(name: string, subquery: Sql | ((qb: RawQueryBuilder) => RawQueryBuilder)): this;

  // Window Functions
  selectWithWindow(columns: Array<string | WindowColumn>): this;
}

interface WindowColumn {
  expr: string;                         // e.g. "ROW_NUMBER()", "SUM(salary)"
  over: { partitionBy?: string; orderBy?: string };
  alias: string;
}
```

### RowValidator / ArrayValidator

[Usage ->](./query-builder.md#result-validation--validate)

```typescript
// Row-level: validates each row individually
type RowValidator<TResult> =
  | ((row: TResult) => TResult)         // Plain function
  | { parse(data: unknown): TResult };  // Zod-style (.parse() method)

// Array-level: validates the entire result array
type ArrayValidator<TResult> =
  | ((rows: TResult[]) => TResult[])
  | { parse(data: unknown): TResult[] };
```

### CursorPaginationOption\<T\> / CursorPaginationResult\<T\>

```typescript
interface CursorPaginationOption<T> {
  take?: number;               // Page size (default: 20)
  cursor?: string;             // Base64 cursor
  orderBy?: keyof T & string;  // Sort column (default: PK)
  direction?: "ASC" | "DESC";  // Sort direction (default: "ASC")
  where?: Partial<T>;          // WHERE conditions
}

interface CursorPaginationResult<T> {
  data: T[];
  hasNextPage: boolean;
  nextCursor: string | null;
  count: number;
}
```

### ExplainResult

```typescript
interface ExplainResult {
  raw: Record<string, unknown>[];
  rows: number | null;
  type: string | null;           // ALL, ref, Seq Scan, etc.
  possibleKeys: string[] | null;
  key: string | null;
  cost: number | null;
}
```

### DeleteResult

```typescript
interface DeleteResult {
  affected: number;
}
```

### ColumnOption

```typescript
interface ColumnOption {
  name?: string;           // Column name (defaults to property name)
  type?: ColumnType;       // Column type (auto-inferred if omitted)
  length?: number;
  nullable?: boolean;      // Default: false
  primary?: boolean;
  autoIncrement?: boolean;
  default?: unknown;       // Column default value (string, number, boolean, or raw SQL in parentheses)
  transform?: (raw: unknown) => any;
  precision?: number;
  scale?: number;
  enumValues?: string[];   // PostgreSQL ENUM
  enumName?: string;       // PostgreSQL ENUM type name
}
```

### ColumnType

```typescript
type ColumnType =
  | "varchar" | "char" | "int" | "number" | "float" | "double" | "bigint"
  | "boolean" | "datetime" | "timestamp" | "timestamptz" | "date"
  | "text" | "longtext" | "blob"
  | "json" | "jsonb" | "enum" | "array";
```

### Relation Options

```typescript
interface ManyToOneOption {
  joinColumn?: string;        // FK column name (auto-detected from @Column if omitted)
  references?: string;        // Target reference column (defaults to PK)
  eager?: boolean;
  lazy?: boolean;
  cascade?: CascadeOption;
  onDelete?: ReferentialAction;  // 'CASCADE' | 'SET NULL' | 'SET DEFAULT' | 'RESTRICT' | 'NO ACTION'
  onUpdate?: ReferentialAction;  // default: 'NO ACTION'
  createForeignKeyConstraints?: boolean;  // false to skip FK constraint in DDL
  transform?: (raw: unknown) => any;
}

interface OneToManyOption<T> {
  mappedBy: Extract<keyof T, string> | (string & {});  // IntelliSense supported
  cascade?: CascadeOption;
}

interface OneToOneOption<T> {
  joinColumn?: string;        // FK column name (auto-detected from @Column if omitted)
  inverseSide?: Extract<keyof T, string> | (string & {});  // IntelliSense supported
  eager?: boolean;
  cascade?: CascadeOption;
  onDelete?: ReferentialAction;  // 'CASCADE' | 'SET NULL' | 'SET DEFAULT' | 'RESTRICT' | 'NO ACTION'
  onUpdate?: ReferentialAction;  // default: 'NO ACTION'
  createForeignKeyConstraints?: boolean;  // false to skip FK constraint in DDL
}

interface ManyToManyOption<T> {
  joinTable?: { name: string; joinColumn: string; inverseJoinColumn: string };
  mappedBy?: Extract<keyof T, string> | (string & {});     // IntelliSense supported
}

type CascadeOption = boolean | ("insert" | "update" | "delete" | "remove")[];
```

> `mappedBy` and `inverseSide` provide auto-completion for the target entity's property names. Arbitrary strings are also allowed.

### Configuration Options

```typescript
interface DatabaseClientOptions {
  type: "mysql" | "mariadb" | "postgres" | "sqlite";
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  entities: AnyEntity[];
  synchronize?: boolean | "safe" | "dry-run";
  schema?: string;
  charset?: string;
  datesStrings?: boolean;
  queryTimeout?: number;
  pool?: PoolOptions;
  retry?: RetryOptions;
  logging?: boolean | LoggingOptions;
  replication?: ReplicationConfig;
  plugins?: StingerloomPlugin[];  // Auto-install plugins on register()
}

interface PoolOptions {
  max?: number;              // Default: 10
  min?: number;              // Default: 0
  acquireTimeoutMs?: number; // Default: 30000
  idleTimeoutMs?: number;    // Default: 10000
}

interface RetryOptions {
  maxAttempts: number;  // Default: 3
  backoffMs: number;    // Default: 1000
}

interface LoggingOptions {
  queries?: boolean;
  slowQueryMs?: number;
  nPlusOne?: boolean;
}

interface ReplicationConfig {
  master: ReplicationNodeConfig;
  slaves: ReplicationNodeConfig[];
}

interface ReplicationNodeConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
}
```

### EntitySubscriber\<T\>

```typescript
interface EntitySubscriber<T = any> {
  listenTo(): new (...args: any[]) => T;
  afterLoad?(entity: T): void | Promise<void>;
  beforeInsert?(event: InsertEvent<T>): void | Promise<void>;
  afterInsert?(event: InsertEvent<T>): void | Promise<void>;
  beforeUpdate?(event: UpdateEvent<T>): void | Promise<void>;
  afterUpdate?(event: UpdateEvent<T>): void | Promise<void>;
  beforeDelete?(event: DeleteEvent<T>): void | Promise<void>;
  afterDelete?(event: DeleteEvent<T>): void | Promise<void>;
  beforeTransactionStart?(): void | Promise<void>;
  afterTransactionStart?(): void | Promise<void>;
  beforeTransactionCommit?(): void | Promise<void>;
  afterTransactionCommit?(): void | Promise<void>;
  beforeTransactionRollback?(): void | Promise<void>;
  afterTransactionRollback?(): void | Promise<void>;
}

interface InsertEvent<T> { entity: Partial<T>; manager: EntityManager; }
interface UpdateEvent<T> { entity: Partial<T>; manager: EntityManager; }
interface DeleteEvent<T> { entityClass: new (...args: any[]) => T; criteria: any; manager: EntityManager; }
```

### EntityEventType

```typescript
type EntityEventType =
  | "beforeInsert" | "afterInsert"
  | "beforeUpdate" | "afterUpdate"
  | "beforeDelete" | "afterDelete";
```

### StingerloomPlugin\<TApi\>

[Usage ->](./plugins.md)

```typescript
interface StingerloomPlugin<TApi = {}> {
  readonly name: string;
  readonly dependencies?: readonly string[];
  install(context: PluginContext): TApi | void;
  shutdown?(): Promise<void> | void;
}
```

### ITenantMigrationRunner

[Usage ->](./multi-tenancy.md)

```typescript
interface ITenantMigrationRunner {
  discoverSchemas(): Promise<string[]>;
  ensureSchema(tenantId: string): Promise<void>;
  syncTenantSchemas(tenantIds: string[]): Promise<TenantSyncResult>;
  isProvisioned(tenantId: string): boolean;
  getProvisionedSchemas(): string[];
  reset(): void;
}

interface TenantSyncResult { created: string[]; skipped: string[]; }
```

Implementations: `PostgresTenantMigrationRunner`, `MySqlTenantMigrationRunner`, `SqliteTenantMigrationRunner`

### Migration

[Usage ->](./migrations.md)

```typescript
abstract class Migration {
  get name(): string;
  abstract up(context: MigrationContext): Promise<void>;
  abstract down(context: MigrationContext): Promise<void>;
}

interface MigrationContext {
  driver: ISqlDriver;
  query: (sql: string) => Promise<any>;
}
```

### SchemaDiffResult

```typescript
interface SchemaDiffResult {
  addedTables: string[];
  droppedTables: string[];
  modifiedTables: ModifiedTable[];
  renamedColumns?: RenamedColumn[];       // Heuristic-detected column renames
  addTableEntityMap?: Record<string, ClazzType<any>>;
}

interface ModifiedTable {
  tableName: string;
  addedColumns: ColumnChange[];
  droppedColumns: ColumnChange[];
}

interface ColumnChange {
  columnName: string;
  columnType?: string;
  nullable?: boolean;
}

interface RenamedColumn {
  tableName: string;
  oldColumnName: string;
  newColumnName: string;
}
```

### MigrationCli

```typescript
class MigrationCli {
  constructor(migrations: Migration[], options: DatabaseClientOptions);
  connect(): Promise<void>;
  close(): Promise<void>;
  execute(command: MigrationCommand): Promise<any>;
}

type MigrationCommand = "migrate:run" | "migrate:rollback" | "migrate:status" | "migrate:generate";
```

CLI executable: `npx stingerloom migrate:run|rollback|status|generate`

Related classes: `MigrationRunner`, `MigrationCli`, `SchemaDiff`, `SchemaDiffMigrationGenerator`

## Errors

All ORM errors extend `OrmError`, which includes an optional `suggestion` field with an actionable fix hint. This helps you diagnose problems without consulting documentation:

```typescript
try {
  await em.find(UnregisteredEntity);
} catch (e) {
  if (e instanceof OrmError) {
    console.error(e.message);      // "Entity metadata not found for UnregisteredEntity"
    console.error(e.suggestion);   // "Did you register the entity in the entities array?"
    console.error(e.code);         // "ORM_ENTITY_METADATA_NOT_FOUND"
  }
}
```

`ValidationError` additionally carries `actual` and `expected` fields for quick diagnosis:

```typescript
try {
  await em.save(User, { name: "A" }); // @MinLength(2) fails
} catch (e) {
  if (e instanceof ValidationError) {
    console.error(e.message);    // "name must be at least 2 characters long"
    console.error(e.actual);     // "A"
    console.error(e.expected);   // "minLength: 2"
  }
}
```

| Error | Description |
|-------|-------------|
| `OrmError` | Base ORM error (includes `code`, `message`, and optional `suggestion`) |
| `ValidationError` | Validation failure (includes `actual` and `expected` fields) |
| `InvalidQueryError` | Invalid query (includes optional `suggestion` for fix hints) |
| `EntityNotFoundError` | Entity not found |
| `EntityMetadataNotFoundError` | Metadata not found |
| `PrimaryKeyNotFoundError` | PK not found |
| `DeleteWithoutConditionsError` | Delete without conditions |
| `QueryTimeoutError` | Query timeout |
| `TransactionError` | Transaction error |
| `DatabaseNotConnectedError` | DB not connected |
| `DatabaseConnectionFailedError` | DB connection failed |
| `NotSupportedDatabaseTypeError` | Unsupported DB type |

### OrmErrorCode

```typescript
enum OrmErrorCode {
  CONNECTION_FAILED = "ORM_CONNECTION_FAILED",
  NOT_CONNECTED = "ORM_NOT_CONNECTED",
  UNSUPPORTED_DATABASE = "ORM_UNSUPPORTED_DATABASE",
  ENTITY_NOT_FOUND = "ORM_ENTITY_NOT_FOUND",
  ENTITY_METADATA_NOT_FOUND = "ORM_ENTITY_METADATA_NOT_FOUND",
  PRIMARY_KEY_NOT_FOUND = "ORM_PRIMARY_KEY_NOT_FOUND",
  INVALID_QUERY = "ORM_INVALID_QUERY",
  DELETE_WITHOUT_CONDITIONS = "ORM_DELETE_WITHOUT_CONDITIONS",
  QUERY_TIMEOUT = "ORM_QUERY_TIMEOUT",
  TRANSACTION_FAILED = "ORM_TRANSACTION_FAILED",
  TRANSACTION_ROLLBACK_FAILED = "ORM_TRANSACTION_ROLLBACK_FAILED",
  VALIDATION_FAILED = "ORM_VALIDATION_FAILED",
  UNIQUE_VIOLATION = "ORM_UNIQUE_VIOLATION",
  FK_VIOLATION = "ORM_FK_VIOLATION",
  PLUGIN_DEPENDENCY_MISSING = "ORM_PLUGIN_DEPENDENCY_MISSING",
  PLUGIN_CONFLICT = "ORM_PLUGIN_CONFLICT",
  BUFFER_NOT_INSTALLED = "ORM_BUFFER_NOT_INSTALLED",
}
```

## EntitySchema (Decorator-Free Entity Definition)

[Usage ->](./entities.md#defining-entities-without-decorators-entityschema)

```typescript
import { EntitySchema, EntitySchemaOptions, ColumnSchemaDef } from "@stingerloom/orm";

const schema = new EntitySchema<T>(options: EntitySchemaOptions<T>);
```

### EntitySchemaOptions\<T\>

```typescript
interface EntitySchemaOptions<T> {
  target: ClazzType<T>;                                    // Entity class
  tableName?: string;                                      // Table name (defaults to snake_case of class name)
  columns: { [K in keyof T]?: ColumnSchemaDef };           // Column definitions
  relations?: { [K in keyof T]?: RelationSchemaDef };      // Relation definitions
  uniqueIndexes?: { columns: string[]; name?: string }[];  // Composite unique indexes
  hooks?: Partial<Record<HookEvent, Extract<keyof T, string>>>;  // Lifecycle hooks
}
```

### ColumnSchemaDef

```typescript
interface ColumnSchemaDef {
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

  // Special column flags
  index?: boolean;              // Equivalent to @Index()
  createTimestamp?: boolean;     // Equivalent to @CreateTimestamp()
  updateTimestamp?: boolean;     // Equivalent to @UpdateTimestamp()
  deletedAt?: boolean;           // Equivalent to @DeletedAt()
  version?: boolean;             // Equivalent to @Version()

  // Inline validation
  validation?: ValidationDef[];
}

interface ValidationDef {
  constraint: "notNull" | "minLength" | "maxLength" | "min" | "max";
  value?: number;
  message?: string;
}
```

### RelationSchemaDef

```typescript
type RelationSchemaDef =
  | { kind: "manyToOne"; target: () => ClazzType; joinColumn?: string; references?: string; eager?: boolean; cascade?: CascadeOption; lazy?: boolean }
  | { kind: "oneToMany"; target: () => ClazzType; mappedBy: string; cascade?: CascadeOption }
  | { kind: "oneToOne"; target: () => ClazzType; joinColumn?: string; inverseSide?: string; eager?: boolean; cascade?: CascadeOption }
  | { kind: "manyToMany"; target: () => ClazzType; joinTable?: JoinTableOption; mappedBy?: string };
```

## Utilities

| Export | Description |
|--------|-------------|
| `ClazzType<T>` | `new (...args: any[]) => T` |
| `EntityResult<T>` | **Deprecated** — was `T \| T[]`, replaced by `T[]` for `find()` and `T` for `save()` |
| `DeepPartial<T>` | Deep partial type |
| `WhereClause<T>` | `{ [P in keyof T]?: T[P] }` — typed WHERE conditions |
| `FindCondition<T>` | **Deprecated** — use `WhereClause<T>` instead |
| `RawQueryBuilderFactory` | Query builder factory |
| `LayeredMetadataStore` | Layered metadata |
| `MetadataContext` | AsyncLocalStorage-based tenant context |
| `Logger` | Internal logging utility |
