# API 레퍼런스 (API Reference)

메서드 시그니처와 타입을 빠르게 확인하는 레퍼런스입니다. 사용법과 예제는 각 주제별 문서를 참고하세요.

- [엔티티 정의](./entities.md) | [관계](./relations.md) | [EntityManager](./entity-manager.md)
- [쿼리 빌더](./query-builder.md) | [트랜잭션](./transactions.md) | [마이그레이션](./migrations.md)
- [고급 기능](./advanced.md) | [멀티테넌시](./multi-tenancy.md) | [설정](./configuration.md)

## EntityManager

```typescript
import { EntityManager } from "stingerloom-orm";
const em = new EntityManager();
```

### 연결

| 메서드 | 시그니처 | 설명 |
|--------|---------|------|
| `register` | `(options: DatabaseClientOptions, connectionName?: string): Promise<void>` | DB 연결 + 엔티티 등록 |
| `getConnectionName` | `(): string` | 연결 이름 (기본값: `"default"`) |
| `getDriver` | `(): ISqlDriver \| undefined` | SQL 드라이버 |
| `propagateShutdown` | `(): Promise<void>` | 내부 리소스 정리 |

### CRUD

| 메서드 | 시그니처 | 설명 |
|--------|---------|------|
| `find` | `<T>(entity, option?): Promise<EntityResult<T>>` | 목록 조회 |
| `findOne` | `<T>(entity, option): Promise<T \| null>` | 단건 조회 |
| `findAndCount` | `<T>(entity, option?): Promise<[T[], number]>` | 목록 + 전체 개수 |
| `findWithCursor` | `<T>(entity, option?): Promise<CursorPaginationResult<T>>` | 커서 페이지네이션 |
| `save` | `<T>(entity, item): Promise<InstanceType<ClazzType<T>>>` | INSERT 또는 UPDATE |
| `delete` | `<T>(entity, criteria): Promise<DeleteResult>` | 영구 삭제 |
| `softDelete` | `<T>(entity, criteria): Promise<DeleteResult>` | Soft Delete |
| `restore` | `<T>(entity, criteria): Promise<DeleteResult>` | Soft Delete 복원 |
| `upsert` | `<T>(entity, data, conflictColumns?): Promise<void>` | INSERT ... ON CONFLICT |

### 배치

| 메서드 | 시그니처 | 설명 |
|--------|---------|------|
| `insertMany` | `<T>(entity, items[]): Promise<{ affected: number }>` | 다건 INSERT |
| `saveMany` | `<T>(entity, items[]): Promise<InstanceType<ClazzType<T>>[]>` | 다건 INSERT/UPDATE |
| `deleteMany` | `<T>(entity, ids[]): Promise<DeleteResult>` | 다건 삭제 |

### 집계

| 메서드 | 시그니처 | 설명 |
|--------|---------|------|
| `count` | `<T>(entity, where?): Promise<number>` | 개수 |
| `sum` | `<T>(entity, field, where?): Promise<number>` | 합계 |
| `avg` | `<T>(entity, field, where?): Promise<number>` | 평균 |
| `min` | `<T>(entity, field, where?): Promise<number>` | 최솟값 |
| `max` | `<T>(entity, field, where?): Promise<number>` | 최댓값 |

### Raw Query / 분석

| 메서드 | 시그니처 | 설명 |
|--------|---------|------|
| `query` | `<T>(sql: string \| Sql, params?: unknown[]): Promise<T[]>` | 임의 SQL 실행 |
| `explain` | `<T>(entity, option?): Promise<ExplainResult>` | EXPLAIN 분석 |

### 이벤트

| 메서드 | 시그니처 | 설명 |
|--------|---------|------|
| `on` | `(event: EntityEventType, listener): void` | 리스너 등록 |
| `off` | `(event: EntityEventType, listener): void` | 리스너 제거 |
| `removeAllListeners` | `(): void` | 전체 리스너 제거 |
| `addSubscriber` | `(subscriber: EntitySubscriber<any>): void` | 구독자 등록 |
| `removeSubscriber` | `(subscriber: EntitySubscriber<any>): void` | 구독자 제거 |
| `getQueryLog` | `(): ReadonlyArray<QueryLogEntry>` | 쿼리 로그 |

## BaseRepository

엔티티별 CRUD 래퍼. [사용법 →](./advanced.md)

```typescript
const userRepo = em.getRepository(User);
// 또는
const userRepo = BaseRepository.of(User, em);
```

`find`, `findOne`, `findWithCursor`, `findAndCount`, `save`, `delete`, `remove`, `softDelete`, `restore`, `insertMany`, `saveMany`, `deleteMany`, `count`, `sum`, `avg`, `min`, `max`, `explain`, `upsert`, `persist` — EntityManager와 동일한 API를 엔티티 지정 없이 사용합니다.

## 데코레이터

### 엔티티

| 데코레이터 | 설명 |
|-----------|------|
| `@Entity(options?)` | 클래스를 ORM 엔티티로 등록. `{ name: "table_name" }` |
| `@Column(option?)` | 일반 컬럼 |
| `@PrimaryGeneratedColumn(option?)` | 자동 증가 PK |
| `@PrimaryColumn(option?)` | 수동 PK |
| `@Index()` | 컬럼 인덱스 |
| `@UniqueIndex(columns, options?)` | 복합 유니크 인덱스 (클래스 레벨) |
| `@Version()` | 낙관적 잠금 버전 컬럼 |
| `@DeletedAt()` | Soft Delete 타임스탬프 |

### 관계

| 데코레이터 | 설명 |
|-----------|------|
| `@ManyToOne(getEntity, getProperty?, option?)` | 다대일 (FK 소유측) |
| `@OneToMany(getEntity, option)` | 일대다 (역방향) |
| `@OneToOne(getEntity, option?)` | 일대일 |
| `@ManyToMany(getEntity, option?)` | 다대다 |

### 생명주기 훅

| 데코레이터 | 시점 |
|-----------|------|
| `@BeforeInsert` | INSERT 직전 |
| `@AfterInsert` | INSERT 후 |
| `@BeforeUpdate` | UPDATE 직전 |
| `@AfterUpdate` | UPDATE 후 |
| `@BeforeDelete` | DELETE 직전 |
| `@AfterDelete` | DELETE 후 |

### 유효성 검사

| 데코레이터 | 설명 |
|-----------|------|
| `@NotNull()` | null/undefined 불허 |
| `@MinLength(n)` | 문자열 최소 길이 |
| `@MaxLength(n)` | 문자열 최대 길이 |
| `@Min(n)` | 숫자 최솟값 |
| `@Max(n)` | 숫자 최댓값 |

### 트랜잭션 / DI

| 데코레이터 | 설명 |
|-----------|------|
| `@Transactional(isolationLevel?)` | 메서드를 트랜잭션으로 래핑 |
| `@InjectRepository(Entity)` | NestJS에 `BaseRepository<T>` 주입 |
| `@InjectEntityManager()` | NestJS에 `EntityManager` 주입 |

## 타입 레퍼런스

### FindOption\<T\>

```typescript
interface FindOption<T> {
  select?: (keyof T)[] | Partial<Record<keyof T, boolean>>;
  where?: Partial<T>;
  limit?: number | [number, number];
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
  take?: number;               // 페이지 크기 (기본값: 20)
  cursor?: string;             // Base64 커서
  orderBy?: keyof T & string;  // 정렬 컬럼 (기본값: PK)
  direction?: "ASC" | "DESC";  // 정렬 방향 (기본값: "ASC")
  where?: Partial<T>;          // WHERE 조건
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
  type: string | null;           // ALL, ref, Seq Scan 등
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
  name?: string;           // 컬럼명 (생략 시 프로퍼티명)
  type?: ColumnType;       // 컬럼 타입 (생략 시 자동 추론)
  length?: number;
  nullable?: boolean;      // 기본값: false
  primary?: boolean;
  autoIncrement?: boolean;
  transform?: (raw: unknown) => any;
  precision?: number;
  scale?: number;
  enumValues?: string[];   // PostgreSQL ENUM
  enumName?: string;       // PostgreSQL ENUM 타입명
}
```

### ColumnType

```typescript
type ColumnType =
  | "varchar" | "int" | "number" | "float" | "double" | "bigint"
  | "boolean" | "datetime" | "timestamp" | "date"
  | "text" | "longtext" | "blob"
  | "json" | "jsonb" | "enum";
```

### 관계 옵션

```typescript
interface ManyToOneOption {
  joinColumn?: string;
  eager?: boolean;
  lazy?: boolean;
  cascade?: CascadeOption;
  transform?: (raw: unknown) => any;
}

interface OneToManyOption {
  mappedBy: string;
  cascade?: CascadeOption;
}

interface OneToOneOption {
  joinColumn?: string;
  inverseSide?: string;
  eager?: boolean;
  cascade?: CascadeOption;
}

interface ManyToManyOption {
  joinTable?: { name: string; joinColumn: string; inverseJoinColumn: string };
  mappedBy?: string;
}

type CascadeOption = boolean | ("insert" | "update" | "delete" | "remove")[];
```

### 설정 옵션

```typescript
interface DatabaseClientOptions {
  type: "mysql" | "mariadb" | "postgres" | "sqlite" | "mssql";
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  entities: AnyEntity[];
  synchronize?: boolean;
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
  max?: number;              // 기본값: 10
  min?: number;              // 기본값: 0
  acquireTimeoutMs?: number; // 기본값: 30000
  idleTimeoutMs?: number;    // 기본값: 10000
}

interface RetryOptions {
  maxAttempts: number;  // 기본값: 3
  backoffMs: number;    // 기본값: 1000
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

[사용법 →](./multi-tenancy.md)

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

구현체: `PostgresTenantMigrationRunner`, `MySqlTenantMigrationRunner`, `SqliteTenantMigrationRunner`, `MssqlTenantMigrationRunner`

### Migration

[사용법 →](./migrations.md)

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

관련 클래스: `MigrationRunner`, `MigrationCli`, `SchemaDiff`, `SchemaDiffMigrationGenerator`

## 에러

| 에러 | 설명 |
|------|------|
| `OrmError` | 기본 ORM 에러 |
| `ValidationError` | 유효성 검사 실패 |
| `EntityNotFoundError` | 엔티티를 찾을 수 없음 |
| `EntityMetadataNotFoundError` | 메타데이터 없음 |
| `InvalidQueryError` | 잘못된 쿼리 |
| `PrimaryKeyNotFoundError` | PK 없음 |
| `DeleteWithoutConditionsError` | 조건 없는 삭제 |
| `QueryTimeoutError` | 쿼리 타임아웃 |
| `TransactionError` | 트랜잭션 에러 |
| `DatabaseNotConnectedError` | DB 미연결 |
| `DatabaseConnectionFailedError` | DB 연결 실패 |
| `NotSupportedDatabaseTypeError` | 미지원 DB 타입 |

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
}
```

## 유틸리티

| export | 설명 |
|--------|------|
| `ClazzType<T>` | `new (...args: any[]) => T` |
| `EntityResult<T>` | `T \| T[]` |
| `DeepPartial<T>` | 깊은 부분 타입 |
| `FindCondition<T>` | `{ [P in keyof T]?: T[P] }` |
| `RawQueryBuilderFactory` | 쿼리 빌더 팩토리 |
| `LayeredMetadataStore` | 레이어드 메타데이터 |
| `MetadataContext` | AsyncLocalStorage 기반 테넌트 컨텍스트 |
| `Logger` | 내부 로깅 유틸리티 |
