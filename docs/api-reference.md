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

### Transaction

| Method | Signature | Description |
|--------|-----------|-------------|
| `transaction` | `<T>(callback: (em: EntityManager) => Promise<T>): Promise<T>` | Execute callback in a transaction |

### Raw Query / Analysis

| Method | Signature | Description |
|--------|-----------|-------------|
| `query` | `<T>(sql: string \| Sql, params?: unknown[]): Promise<T[]>` | Execute arbitrary SQL |
| `explain` | `<T>(entity, option?): Promise<ExplainResult>` | EXPLAIN analysis |

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

`find`, `findOne`, `findWithCursor`, `findAndCount`, `save`, `delete`, `remove`, `softDelete`, `restore`, `insertMany`, `saveMany`, `deleteMany`, `count`, `sum`, `avg`, `min`, `max`, `explain`, `upsert`, `persist` — Uses the same API as EntityManager without specifying the entity.

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
  where?: Partial<T>;
  limit?: number | [number, number];
  skip?: number;
  take?: number;
  orderBy?: Partial<Record<keyof T, "ASC" | "DESC">>;
  groupBy?: (keyof T)[];
  having?: Sql[];
  relations?: (keyof T)[];
  withDeleted?: boolean;
  timeout?: number;
  useMaster?: boolean;
}
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

Related classes: `MigrationRunner`, `MigrationCli`, `SchemaDiff`, `SchemaDiffMigrationGenerator`

## Errors

| Error | Description |
|-------|-------------|
| `OrmError` | Base ORM error (includes optional `suggestion: string \| null` field with actionable fix hint) |
| `ValidationError` | Validation failure |
| `EntityNotFoundError` | Entity not found |
| `EntityMetadataNotFoundError` | Metadata not found |
| `InvalidQueryError` | Invalid query |
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
