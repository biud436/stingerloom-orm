# API Reference

메서드 시그니처와 타입을 빠르게 찾아볼 수 있는 레퍼런스예요. 사용법과 예제는 각 주제별 문서를 참고해 주세요.

- [Entity Definition](./entities.md) | [Relations](./relations.md) | [EntityManager](./entity-manager.md)
- [Query Builder](./query-builder.md) | [Transactions](./transactions.md) | [Migrations](./migrations.md)
- [Advanced Features](./advanced.md) | [Multi-Tenancy](./multi-tenancy.md) | [Configuration](./configuration.md)

## EntityManager

```typescript
import { EntityManager } from "@stingerloom/orm";
const em = new EntityManager();
```

### Connection

| Method | Signature | 설명 |
|--------|-----------|------|
| `register` | `(options: DatabaseClientOptions, connectionName?: string): Promise<void>` | DB 연결 및 엔티티 등록 |
| `getConnectionName` | `(): string` | 커넥션 이름 (기본값: `"default"`) |
| `getDriver` | `(): ISqlDriver \| undefined` | SQL 드라이버 반환 |
| `propagateShutdown` | `(): Promise<void>` | 내부 리소스 정리 |

### CRUD

| Method | Signature | 설명 |
|--------|-----------|------|
| `find` | `<T>(entity, option?): Promise<T[]>` | 목록 조회 |
| `findOne` | `<T>(entity, option): Promise<T \| null>` | 단건 조회 |
| `findOneOrFail` | `<T>(entity, option): Promise<T>` | 단건 조회 (없으면 `EntityNotFoundError` 발생) |
| `exists` | `<T>(entity, option?): Promise<boolean>` | 매칭되는 레코드 존재 여부 |
| `findByPK` | `<T>(entity, pk): Promise<T \| null>` | 기본 키로 조회 |
| `findByPKs` | `<T>(entity, pks[]): Promise<T[]>` | 여러 기본 키로 조회 |
| `findAndCount` | `<T>(entity, option?): Promise<[T[], number]>` | 목록 + 전체 개수 |
| `findWithCursor` | `<T>(entity, option?): Promise<CursorPaginationResult<T>>` | 커서 페이지네이션 |
| `save` | `<T>(entity, item): Promise<InstanceType<ClazzType<T>>>` | INSERT 또는 UPDATE |
| `delete` | `<T>(entity, criteria): Promise<DeleteResult>` | 영구 삭제 |
| `softDelete` | `<T>(entity, criteria): Promise<DeleteResult>` | Soft Delete |
| `restore` | `<T>(entity, criteria): Promise<DeleteResult>` | Soft Delete 복원 |
| `upsert` | `<T>(entity, data, conflictColumns?): Promise<void>` | INSERT ... ON CONFLICT |
| `batchUpsert` | `<T>(entity, items[], conflictColumns?): Promise<void>` | 다건 upsert |
| `updateMany` | `<T>(entity, data: UpdateData<T>, options): Promise<{ affected: number }>` | 조건별 일괄 UPDATE (SQL 표현식 지원) |

### Batch

| Method | Signature | 설명 |
|--------|-----------|------|
| `insertMany` | `<T>(entity, items[]): Promise<{ affected: number }>` | 다건 INSERT |
| `saveMany` | `<T>(entity, items[]): Promise<InstanceType<ClazzType<T>>[]>` | 다건 INSERT/UPDATE |
| `deleteMany` | `<T>(entity, ids[]): Promise<DeleteResult>` | 다건 삭제 |

### Aggregation

| Method | Signature | 설명 |
|--------|-----------|------|
| `count` | `<T>(entity, where?): Promise<number>` | 개수 |
| `sum` | `<T>(entity, field, where?): Promise<number>` | 합계 |
| `avg` | `<T>(entity, field, where?): Promise<number>` | 평균 |
| `min` | `<T>(entity, field, where?): Promise<number>` | 최솟값 |
| `max` | `<T>(entity, field, where?): Promise<number>` | 최댓값 |

### Streaming

| Method | Signature | 설명 |
|--------|-----------|------|
| `stream` | `<T>(entity, option?, batchSize?): AsyncGenerator<T>` | async generator (한 번에 하나씩) |
| `streamBatch` | `<T>(entity, option?, batchSize?): AsyncGenerator<T[]>` | async generator (엔티티 배열 단위) |

```typescript
// 하나씩 처리
for await (const user of em.stream(User, { where: { isActive: true } }, 1000)) {
  await process(user);
}

// 배치 단위 처리
for await (const batch of em.streamBatch(User, {}, 500)) {
  await bulkInsert(batch); // batch는 User[]
}
```

### Transaction

| Method | Signature | 설명 |
|--------|-----------|------|
| `transaction` | `<T>(callback: (em: EntityManager) => Promise<T>, options?: TransactionOptions): Promise<T>` | 콜백을 트랜잭션으로 실행해요 (deadlock 재시도 옵션 지원) |

### Raw Query / Analysis

| Method | Signature | 설명 |
|--------|-----------|------|
| `query` | `<T>(sql: string \| Sql, params?: unknown[]): Promise<T[]>` | 임의의 SQL 실행 |
| `explain` | `<T>(entity, option?): Promise<ExplainResult>` | EXPLAIN 분석 |

### Query Builder

| Method | Signature | 설명 |
|--------|-----------|------|
| `createQueryBuilder` | `(): BaseRawQueryBuilder` | RawQueryBuilder 생성 (자유 형식 SQL) |
| `createQueryBuilder` | `<T>(entity, alias): SelectQueryBuilder<T>` | 타입 안전한 SelectQueryBuilder 생성 |

### Plugin System

| Method | Signature | 설명 |
|--------|-----------|------|
| `extend` | `<TApi>(plugin: StingerloomPlugin<TApi>): this & TApi` | 플러그인 설치 |
| `hasPlugin` | `(name: string): boolean` | 설치 여부 확인 |
| `getPluginApi` | `<T>(name: string): T \| undefined` | 이름으로 플러그인 API 가져오기 |

### Events

| Method | Signature | 설명 |
|--------|-----------|------|
| `on` | `(event: EntityEventType, listener): void` | 리스너 등록 |
| `off` | `(event: EntityEventType, listener): void` | 리스너 제거 |
| `removeAllListeners` | `(): void` | 모든 리스너 제거 |
| `addSubscriber` | `(subscriber: EntitySubscriber<any>): void` | 구독자 등록 |
| `removeSubscriber` | `(subscriber: EntitySubscriber<any>): void` | 구독자 제거 |
| `getQueryLog` | `(): ReadonlyArray<QueryLogEntry>` | 쿼리 로그 |
| `getEntityMetadata` | `<T>(entity): EntityMetadataView \| null` | 전체 엔티티 메타데이터 |
| `getColumnMetadata` | `<T>(entity): ColumnMetadataView[]` | 컬럼 메타데이터 |
| `getRelationMetadata` | `<T>(entity): RelationMetadataView[]` | 관계 메타데이터 |

## BaseRepository

엔티티별 CRUD 래퍼예요. [사용법 ->](./advanced.md)

```typescript
const userRepo = em.getRepository(User);
// or
const userRepo = BaseRepository.of(User, em);
```

`find`, `findOne`, `findOneOrFail`, `findWithCursor`, `findAndCount`, `save`, `delete`, `remove`, `softDelete`, `restore`, `insertMany`, `saveMany`, `deleteMany`, `batchUpsert`, `count`, `sum`, `avg`, `min`, `max`, `explain`, `upsert`, `persist`, `stream`, `streamBatch`, `createQueryBuilder` -- EntityManager와 동일한 API를 엔티티 지정 없이 사용할 수 있어요.

서브클래스에서 사용 가능한 protected 필드: `entity` (엔티티 클래스)와 `em` (EntityManager 인스턴스).

## Decorators

### Entity

| Decorator | 설명 |
|-----------|------|
| `@Entity(options?)` | 클래스를 ORM 엔티티로 등록해요. `{ name: "table_name" }` |
| `@Column(option?)` | 일반 컬럼 |
| `@PrimaryGeneratedColumn(option?)` | 자동 증가 PK |
| `@PrimaryColumn(option?)` | 수동 PK |
| `@Index()` | 단일 컬럼 인덱스 (프로퍼티 레벨) |
| `@Index(columns, name?)` | 복합 비고유 인덱스 (클래스 레벨) |
| `@UniqueIndex(columns, name?)` | 복합 고유 인덱스 (클래스 레벨) |
| `@Version()` | 낙관적 잠금 버전 컬럼 |
| `@DeletedAt()` | Soft Delete 타임스탬프 |
| `@CreateTimestamp()` | INSERT 시 자동 설정 (datetime NOT NULL) |
| `@UpdateTimestamp()` | INSERT/UPDATE 시 자동 설정 (datetime NOT NULL) |

### Relations

| Decorator | 설명 |
|-----------|------|
| `@ManyToOne(getEntity, getProperty?, option?)` | Many-to-one (FK 소유 측) |
| `@OneToMany(getEntity, option)` | One-to-many (역방향) |
| `@OneToOne(getEntity, option?)` | One-to-one |
| `@ManyToMany(getEntity, option?)` | Many-to-many |
| `@RelationColumn(option?)` | @ManyToOne/@OneToOne의 FK 컬럼 선언 |

### Lifecycle Hooks

| Decorator | 시점 |
|-----------|------|
| `@BeforeInsert` | INSERT 직전 |
| `@AfterInsert` | INSERT 직후 |
| `@BeforeUpdate` | UPDATE 직전 |
| `@AfterUpdate` | UPDATE 직후 |
| `@BeforeDelete` | DELETE 직전 |
| `@AfterDelete` | DELETE 직후 |

### Validation

| Decorator | 설명 |
|-----------|------|
| `@NotNull()` | null/undefined 불허 |
| `@MinLength(n)` | 최소 문자열 길이 |
| `@MaxLength(n)` | 최대 문자열 길이 |
| `@Min(n)` | 최소 숫자 값 |
| `@Max(n)` | 최대 숫자 값 |

### Transaction / DI

| Decorator | 설명 |
|-----------|------|
| `@Transactional(isolationLevel?)` | 메서드를 트랜잭션으로 감싸요 |
| `@InjectRepository(Entity, connectionName?)` | NestJS에서 `BaseRepository<T>` 주입 (생략 시 기본 커넥션) |
| `@InjectEntityManager(connectionName?)` | NestJS에서 `EntityManager` 주입 (생략 시 기본 커넥션) |

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

enum LockMode {
  PESSIMISTIC_WRITE = "PESSIMISTIC_WRITE",
  PESSIMISTIC_READ = "PESSIMISTIC_READ",
  PESSIMISTIC_WRITE_NOWAIT = "PESSIMISTIC_WRITE_NOWAIT",
  PESSIMISTIC_READ_NOWAIT = "PESSIMISTIC_READ_NOWAIT",
  PESSIMISTIC_WRITE_SKIP_LOCKED = "PESSIMISTIC_WRITE_SKIP_LOCKED",
  PESSIMISTIC_READ_SKIP_LOCKED = "PESSIMISTIC_READ_SKIP_LOCKED",
}
```

### WhereClause\<T\>

각 필드에는 단순 값(동등 비교), 필터 객체, `Sql` 객체, 또는 `null`을 넣을 수 있어요:

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

연산자는 필드 타입에 따라 달라져요. `string` 필드에는 `contains`, `startsWith` 같은 추가 연산자가 제공돼요.

```typescript
// All types: BaseFilter<T>
{ eq, ne, in, notIn, not, isNull }

// number, Date, bigint: ComparableFilter<T> (extends BaseFilter)
{ gt, gte, lt, lte, between }

// string: StringFilter (extends ComparableFilter)
{ like, notLike, ilike, contains, startsWith, endsWith }
```

사용 예제는 [Querying -- WHERE Filters](./entity-manager-querying.md#where-filters)를 참고해 주세요.

### WhereOperator (SelectQueryBuilder)

3개 인자를 받는 `where()` 메서드용 타입 안전 연산자 union이에요:

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

[사용법 ->](./query-builder.md)

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
  forUpdateNowait(): this;
  forUpdateSkipLocked(): this;
  forShare(): this;
  forShareNowait(): this;
  forShareSkipLocked(): this;
  useIndex(indexName: string): this;           // MySQL
  forceIndex(indexName: string): this;         // MySQL
  ignoreIndex(indexName: string): this;        // MySQL
  hint(hintText: string): this;               // PostgreSQL (pg_hint_plan)
  withDeleted(): this;
  appendSql(fragment: Sql): this;
  validate(validator: RowValidator<TResult>): this;
  validateArray(validator: ArrayValidator<TResult>): this;
  toSql(): Sql;
  getSql(): { text: string; values: any[] };
  getMany(): Promise<TResult[]>;
  getOne(): Promise<TResult | null>;
  getOneOrFail(): Promise<TResult>;           // EntityNotFoundError 발생
  getCount(): Promise<number>;
  getManyAndCount(): Promise<[T[], number]>;
  exists(): Promise<boolean>;
  asSubquery(alias: string): Sql;
}
```

### RawQueryBuilder -- Set Operations, CTE, Window Functions

[사용법 ->](./query-builder.md)

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

[사용법 ->](./query-builder.md#result-validation--validate)

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

interface RelationColumnOption {
  name?: string;              // FK 컬럼명 (생략 시 {propertyName}Id로 추론)
  type?: ColumnType;          // FK 컬럼 타입 (생략 시 대상 PK 타입 추론)
  nullable?: boolean;         // 기본값: true
  referencedColumn?: string;  // 대상 참조 컬럼 (기본값: PK)
}
```

> `mappedBy`와 `inverseSide`는 대상 엔티티의 프로퍼티 이름 자동 완성을 지원해요. 임의의 문자열도 허용돼요.

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
  healthCheck?: HealthCheckConfig;
}

interface HealthCheckConfig {
  enabled: boolean;
  intervalMs?: number;          // 기본값: 5000
  query?: string;               // 기본값: "SELECT 1"
  failureThreshold?: number;    // 기본값: 3
  recoveryThreshold?: number;   // 기본값: 2
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

[사용법 ->](./plugins.md)

```typescript
interface StingerloomPlugin<TApi = {}> {
  readonly name: string;
  readonly dependencies?: readonly string[];
  install(context: PluginContext): TApi | void;
  shutdown?(): Promise<void> | void;
  beforeQuery?(query: QueryInfo): QueryInfo | void;
  afterQuery?(query: QueryInfo, result: any, durationMs: number): void;
}

interface QueryInfo {
  sql: string;
  params?: any[];
  operation?: string;  // "select" | "insert" | "update" | "delete" | "raw"
}
```

### ITenantMigrationRunner

[사용법 ->](./multi-tenancy.md)

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

구현체: `PostgresTenantMigrationRunner`, `MySqlTenantMigrationRunner`, `SqliteTenantMigrationRunner`

### Migration

[사용법 ->](./migrations.md)

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

### MigrationHooks

```typescript
interface MigrationHooks {
  beforeAll?(context: MigrationContext): Promise<void> | void;
  afterAll?(context: MigrationContext, results: MigrationResult[]): Promise<void> | void;
  beforeEach?(migration: Migration, context: MigrationContext): Promise<void> | void;
  afterEach?(migration: Migration, context: MigrationContext, durationMs: number): Promise<void> | void;
  onError?(migration: Migration, error: Error, context: MigrationContext): Promise<void> | void;
}

interface MigrationRunnerOptions {
  lockId?: string;
  lockTimeoutMs?: number;
  tableName?: string;              // 기본값: "__migrations"
  hooks?: MigrationHooks;
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

CLI 실행: `npx stingerloom migrate:run|rollback|status|generate`

관련 클래스: `MigrationRunner`, `MigrationCli`, `SchemaDiff`, `SchemaDiffMigrationGenerator`

### EntityMetadataView

```typescript
interface EntityMetadataView {
  tableName: string;
  columns: ColumnMetadataView[];
  relations: RelationMetadataView[];
  indexes: any[];
  deletedAtColumn?: string;
  createTimestampColumn?: string;
  updateTimestampColumn?: string;
  versionColumn?: string;
}

interface ColumnMetadataView {
  propertyKey: string;
  columnName: string;
  type: string;
  nullable: boolean;
  primary: boolean;
  unique: boolean;
  default?: any;
  length?: number;
}

interface RelationMetadataView {
  type: "ManyToOne" | "OneToMany" | "ManyToMany" | "OneToOne";
  propertyKey: string;
  target: ClazzType<any>;
  joinColumn: string | null;
  eager: boolean;
}
```

### DriverRegistry

```typescript
class DriverRegistry {
  static register(dbType: string, factory: DriverFactory): void;
  static unregister(dbType: string): void;
  static has(dbType: string): boolean;
  static get(dbType: string): DriverFactory | undefined;
  static getRegisteredTypes(): string[];
}

interface DriverFactory {
  createDriver(connector: any, dbType: string, schema?: string): ISqlDriver;
  createDataSource(connector: any): IDataSource;
}
```

### ColumnTypeRegistry

```typescript
class ColumnTypeRegistry {
  static getInstance(): ColumnTypeRegistry;
  register(name: string, definition: CustomColumnTypeDefinition): void;
  unregister(name: string): void;
  has(name: string): boolean;
  resolve(name: string, dialect: DialectName): string | undefined;
  getTransformer(name: string): ColumnTransformer | undefined;
  getRegisteredNames(): string[];
}

interface CustomColumnTypeDefinition {
  mysql?: string;
  postgres?: string;
  sqlite?: string;
  transformer?: ColumnTransformer;
}
```

### Test Utilities

```typescript
// @stingerloom/orm/testing
function createTestEntityManager(options: TestEntityManagerOptions): Promise<EntityManager>;
function createMockRepository<T>(entity: ClazzType<T>, overrides?: MockMethods<T>): BaseRepository<T>;
class InMemoryDriver implements Partial<ISqlDriver>;
```

## Errors

모든 ORM 에러는 `OrmError`를 상속하고, `suggestion` 필드에 해결 힌트가 포함될 수 있어요. 문서를 찾아보지 않아도 문제를 진단할 수 있어요:

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

`ValidationError`는 빠른 진단을 위해 `actual`과 `expected` 필드도 함께 제공해요:

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

| Error | 설명 |
|-------|------|
| `OrmError` | 기본 ORM 에러 (`code`, `message`, 선택적 `suggestion` 포함) |
| `ValidationError` | 유효성 검증 실패 (`actual`, `expected` 필드 포함) |
| `InvalidQueryError` | 잘못된 쿼리 (선택적 `suggestion` 포함) |
| `EntityNotFoundError` | 엔티티를 찾을 수 없음 |
| `EntityMetadataNotFoundError` | 메타데이터를 찾을 수 없음 |
| `PrimaryKeyNotFoundError` | PK를 찾을 수 없음 |
| `DeleteWithoutConditionsError` | 조건 없는 삭제 |
| `QueryTimeoutError` | 쿼리 타임아웃 |
| `TransactionError` | 트랜잭션 에러 |
| `DatabaseNotConnectedError` | DB 미연결 |
| `DatabaseConnectionFailedError` | DB 연결 실패 |
| `NotSupportedDatabaseTypeError` | 지원하지 않는 DB 타입 |

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

[사용법 ->](./entities.md#defining-entities-without-decorators-entityschema)

```typescript
import { EntitySchema, EntitySchemaOptions, ColumnSchemaDef } from "@stingerloom/orm";

const schema = new EntitySchema<T>(options: EntitySchemaOptions<T>);
```

### EntitySchemaOptions\<T\>

```typescript
interface EntitySchemaOptions<T> {
  target: ClazzType<T>;                                    // 엔티티 클래스
  tableName?: string;                                      // 테이블 이름 (기본: 클래스명 snake_case)
  columns: { [K in keyof T]?: ColumnSchemaDef };           // 컬럼 정의
  relations?: { [K in keyof T]?: RelationSchemaDef };      // 관계 정의
  uniqueIndexes?: { columns: string[]; name?: string }[];  // 복합 고유 인덱스
  indexes?: { columns: string[]; name?: string }[];        // 복합 비고유 인덱스
  hooks?: Partial<Record<HookEvent, Extract<keyof T, string>>>;  // 라이프사이클 훅

  // 상속 매핑 (@Inheritance, @DiscriminatorColumn, @DiscriminatorValue 대체)
  inheritance?: InheritanceSchemaDef;                      // 루트 엔티티: 전략 선언
  discriminatorColumn?: DiscriminatorColumnSchemaDef;      // 루트 엔티티: discriminator 컬럼 설정
  discriminatorValue?: string;                             // 자식 엔티티: discriminator 값
}

interface InheritanceSchemaDef {
  strategy: "SINGLE_TABLE" | "JOINED" | "TABLE_PER_CLASS";
}

interface DiscriminatorColumnSchemaDef {
  name?: string;           // 기본값: "dtype"
  type?: KnownColumnType;  // 기본값: "varchar"
  length?: number;         // 기본값: 31
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

| Export | 설명 |
|--------|------|
| `ClazzType<T>` | `new (...args: any[]) => T` |
| `EntityResult<T>` | **Deprecated** -- `T \| T[]`였지만, `find()`는 `T[]`, `save()`는 `T`로 대체됐어요 |
| `DeepPartial<T>` | Deep partial 타입 |
| `WhereClause<T>` | `{ [P in keyof T]?: T[P] }` -- 타입 안전한 WHERE 조건 |
| `FindCondition<T>` | **Deprecated** -- `WhereClause<T>`를 사용해 주세요 |
| `RawQueryBuilderFactory` | Query builder 팩토리 |
| `MetadataLayerRegistry` | 데코레이터 시점의 canonical 레이어드 메타데이터 레지스트리 (싱글턴) |
| `MetadataContext` | AsyncLocalStorage 기반 테넌트 컨텍스트 |
| `LayeredMetadataStore` | **Deprecated** -- 호환용 facade. EntityManager에 연결되지 않음 (issue #277) |
| `Logger` | 내부 로깅 유틸리티 |
