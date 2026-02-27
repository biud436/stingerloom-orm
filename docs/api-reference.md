# API 레퍼런스 (API Reference)

Stingerloom ORM의 전체 공개 API를 정리합니다. 기본 사용법은 각 주제별 문서를, 여기서는 시그니처와 옵션을 빠르게 참조할 수 있습니다.

- [엔티티 정의](./entities.md) | [관계](./relations.md) | [EntityManager](./entity-manager.md)
- [쿼리 빌더](./query-builder.md) | [트랜잭션](./transactions.md) | [마이그레이션](./migrations.md)
- [고급 기능](./advanced.md) | [멀티테넌시](./multi-tenancy.md) | [설정](./configuration.md)

---

## EntityManager

ORM의 핵심 진입점. 모든 CRUD, 집계, Raw Query, 이벤트를 담당합니다.

```typescript
import { EntityManager } from "stingerloom-orm";
const em = new EntityManager();
```

### 연결 및 등록

| 메서드 | 시그니처 | 설명 |
|--------|---------|------|
| `register` | `(options: DatabaseClientOptions, connectionName?: string): Promise<void>` | DB 연결 + 엔티티 등록 |
| `getConnectionName` | `(): string` | 현재 연결 이름 반환 (기본값: `"default"`) |
| `getDriver` | `(): ISqlDriver \| undefined` | 바인딩된 SQL 드라이버 반환 |
| `propagateShutdown` | `(): Promise<void>` | 리스너/구독자/트래커 등 내부 리소스 정리 |

### CRUD

| 메서드 | 시그니처 | 설명 |
|--------|---------|------|
| `find` | `<T>(entity, option?): Promise<EntityResult<T>>` | 목록 조회 |
| `findOne` | `<T>(entity, option): Promise<T \| null>` | 단건 조회 (없으면 `null`) |
| `findAndCount` | `<T>(entity, option?): Promise<[T[], number]>` | 목록 + 전체 개수 |
| `findWithCursor` | `<T>(entity, option?): Promise<CursorPaginationResult<T>>` | 커서 기반 페이지네이션 |
| `save` | `<T>(entity, item): Promise<InstanceType<ClazzType<T>>>` | INSERT (PK 없음) 또는 UPDATE (PK 있음) |
| `delete` | `<T>(entity, criteria): Promise<DeleteResult>` | 영구 삭제 |
| `softDelete` | `<T>(entity, criteria): Promise<DeleteResult>` | Soft Delete (`@DeletedAt`) |
| `restore` | `<T>(entity, criteria): Promise<DeleteResult>` | Soft Delete 복원 |
| `upsert` | `<T>(entity, data, conflictColumns?): Promise<void>` | INSERT ... ON CONFLICT DO UPDATE |

### 배치 연산

| 메서드 | 시그니처 | 설명 |
|--------|---------|------|
| `insertMany` | `<T>(entity, items[]): Promise<{ affected: number }>` | 단일 INSERT 쿼리로 다건 삽입 |
| `saveMany` | `<T>(entity, items[]): Promise<InstanceType<ClazzType<T>>[]>` | 각 아이템 INSERT/UPDATE |
| `deleteMany` | `<T>(entity, ids[]): Promise<DeleteResult>` | `WHERE pk IN (...)` 다건 삭제 |

### 집계

| 메서드 | 시그니처 | 설명 |
|--------|---------|------|
| `count` | `<T>(entity, where?): Promise<number>` | 개수 |
| `sum` | `<T>(entity, field, where?): Promise<number>` | 합계 |
| `avg` | `<T>(entity, field, where?): Promise<number>` | 평균 |
| `min` | `<T>(entity, field, where?): Promise<number>` | 최솟값 |
| `max` | `<T>(entity, field, where?): Promise<number>` | 최댓값 |

### Raw Query

| 메서드 | 시그니처 | 설명 |
|--------|---------|------|
| `query` | `<T>(sql: string \| Sql, params?: unknown[]): Promise<T[]>` | 임의 SQL 실행 |
| `explain` | `<T>(entity, option?): Promise<ExplainResult>` | EXPLAIN 쿼리 분석 |

### 이벤트

| 메서드 | 시그니처 | 설명 |
|--------|---------|------|
| `on` | `(event: EntityEventType, listener): void` | 이벤트 리스너 등록 |
| `off` | `(event: EntityEventType, listener): void` | 이벤트 리스너 제거 |
| `removeAllListeners` | `(): void` | 전체 리스너 제거 |
| `addSubscriber` | `(subscriber: EntitySubscriber<any>): void` | EntitySubscriber 등록 |
| `removeSubscriber` | `(subscriber: EntitySubscriber<any>): void` | EntitySubscriber 제거 |

### 쿼리 로그

| 메서드 | 시그니처 | 설명 |
|--------|---------|------|
| `getQueryLog` | `(): ReadonlyArray<QueryLogEntry>` | 쿼리 실행 로그 반환 |

---

## BaseRepository

엔티티별 CRUD를 캡슐화하는 리포지토리 패턴.

```typescript
import { BaseRepository } from "stingerloom-orm";

// EntityManager를 통해 생성 (권장)
const userRepo = em.getRepository(User);

// 또는 정적 팩토리 메서드
const userRepo2 = BaseRepository.of(User, em);
```

| 메서드 | 시그니처 |
|--------|---------|
| `find` | `(option?): Promise<EntityResult<T>>` |
| `findOne` | `(option): Promise<T \| null>` |
| `findWithCursor` | `(option?): Promise<CursorPaginationResult<T>>` |
| `findAndCount` | `(option?): Promise<[T[], number]>` |
| `save` | `(item): Promise<EntityResult<T>>` |
| `delete` | `(criteria): Promise<DeleteResult>` |
| `remove` | `(item): Promise<DeleteResult>` |
| `softDelete` | `(criteria): Promise<DeleteResult>` |
| `restore` | `(criteria): Promise<DeleteResult>` |
| `insertMany` | `(items[]): Promise<{ affected: number }>` |
| `saveMany` | `(items[]): Promise<InstanceType<ClazzType<T>>[]>` |
| `deleteMany` | `(ids[]): Promise<DeleteResult>` |
| `count` | `(where?): Promise<number>` |
| `sum` | `(field, where?): Promise<number>` |
| `avg` | `(field, where?): Promise<number>` |
| `min` | `(field, where?): Promise<number>` |
| `max` | `(field, where?): Promise<number>` |
| `explain` | `(option?): Promise<ExplainResult>` |
| `upsert` | `(data, conflictColumns?): Promise<void>` |
| `persist` | `(item): Promise<EntityResult<T>>` |

---

## 데코레이터

### 엔티티 데코레이터

| 데코레이터 | 시그니처 | 설명 |
|-----------|---------|------|
| `@Entity` | `(options?: { name?: string })` | 클래스를 ORM 엔티티로 등록 |
| `@Column` | `(option?: ColumnOption)` | 일반 컬럼 정의 |
| `@PrimaryGeneratedColumn` | `(option?: ColumnOption)` | 자동 증가 PK |
| `@PrimaryColumn` | `(option?: ColumnOption)` | 수동 PK |
| `@Index` | `()` | 컬럼 인덱스 |
| `@UniqueIndex` | `(columns: string[], options?: { name?: string })` | 복합 유니크 인덱스 (클래스 레벨) |
| `@Version` | `()` | 낙관적 잠금 버전 컬럼 |
| `@DeletedAt` | `()` | Soft Delete 타임스탬프 컬럼 |

### 관계 데코레이터

| 데코레이터 | 설명 |
|-----------|------|
| `@ManyToOne(getEntity, getProperty, option?)` | 다대일 (FK 소유측) |
| `@OneToMany(getEntity, option)` | 일대다 (역방향) |
| `@OneToOne(getEntity, option?)` | 일대일 |
| `@ManyToMany(getEntity, option?)` | 다대다 |

### 생명주기 훅

| 데코레이터 | 실행 시점 |
|-----------|---------|
| `@BeforeInsert` | INSERT 직전 |
| `@AfterInsert` | INSERT 완료 후 |
| `@BeforeUpdate` | UPDATE 직전 |
| `@AfterUpdate` | UPDATE 완료 후 |
| `@BeforeDelete` | DELETE 직전 |
| `@AfterDelete` | DELETE 완료 후 |

### 유효성 검사

| 데코레이터 | 설명 |
|-----------|------|
| `@NotNull()` | null/undefined 불허 |
| `@MinLength(n)` | 문자열 최소 길이 |
| `@MaxLength(n)` | 문자열 최대 길이 |
| `@Min(n)` | 숫자 최솟값 |
| `@Max(n)` | 숫자 최댓값 |

### 트랜잭션

| 데코레이터 | 설명 |
|-----------|------|
| `@Transactional(isolationLevel?)` | 메서드를 트랜잭션으로 래핑 |

### DI (NestJS 통합)

| 데코레이터 | 설명 |
|-----------|------|
| `@InjectRepository(EntityClass)` | NestJS 서비스에 `BaseRepository<T>` 주입 |
| `@InjectEntityManager()` | NestJS 서비스에 `EntityManager` 주입 |

---

## FindOption\<T\>

`find()`, `findOne()`, `explain()` 등에 전달하는 조회 옵션.

```typescript
type FindOption<T> = {
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
};
```

| 옵션 | 설명 |
|------|------|
| `select` | SELECT 컬럼 (배열 또는 `{ id: true, name: true }`) |
| `where` | WHERE 조건 |
| `limit` | LIMIT (단일 숫자 또는 `[offset, count]`) |
| `take` | 가져올 행 수 |
| `orderBy` | ORDER BY |
| `groupBy` | GROUP BY |
| `having` | HAVING 절 (`sql-template-tag` Sql 배열) |
| `relations` | 로드할 관계 프로퍼티명 |
| `withDeleted` | soft-deleted 포함 여부 |
| `timeout` | 쿼리 타임아웃 (ms), 연결 레벨보다 우선 |
| `useMaster` | Read Replica 환경에서 master 강제 사용 |

---

## CursorPaginationOption\<T\>

```typescript
interface CursorPaginationOption<T> {
  take?: number;               // 페이지 크기 (기본값: 20)
  cursor?: string;             // Base64 인코딩 커서
  orderBy?: keyof T & string;  // 정렬 컬럼 (기본값: PK)
  direction?: "ASC" | "DESC";  // 정렬 방향 (기본값: "ASC")
  where?: Partial<T>;          // 추가 WHERE 조건
}
```

## CursorPaginationResult\<T\>

```typescript
interface CursorPaginationResult<T> {
  data: T[];
  hasNextPage: boolean;
  nextCursor: string | null;
  count: number;
}
```

---

## ExplainResult

```typescript
interface ExplainResult {
  raw: Record<string, unknown>[];  // DB 원본 EXPLAIN 결과
  rows: number | null;             // 예상 검사 행 수
  type: string | null;             // 접근 방식 (ALL, ref, Seq Scan 등)
  possibleKeys: string[] | null;   // 사용 가능 인덱스
  key: string | null;              // 실제 선택된 인덱스
  cost: number | null;             // 예상 비용
}
```

---

## DeleteResult

```typescript
interface DeleteResult {
  affected: number;  // 삭제/수정된 행 수
}
```

---

## EntitySubscriber\<T\>

특정 엔티티 이벤트에 반응하는 구독자 인터페이스. 자세한 사용법은 [advanced.md](./advanced.md#2-entitysubscriber)를 참조하세요.

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

---

## EntityEventType

`on()`/`off()` 이벤트 리스너에서 사용하는 이벤트 타입.

```typescript
type EntityEventType =
  | "beforeInsert" | "afterInsert"
  | "beforeUpdate" | "afterUpdate"
  | "beforeDelete" | "afterDelete";
```

---

## ColumnOption

```typescript
interface ColumnOption {
  name?: string;           // 컬럼명 (생략 시 프로퍼티명)
  type?: ColumnType;       // 컬럼 타입 (생략 시 design:type 추론)
  length?: number;         // 컬럼 길이
  nullable?: boolean;      // NULL 허용 (기본값: false)
  primary?: boolean;       // PK 여부
  autoIncrement?: boolean; // AUTO_INCREMENT
  transform?: (raw: unknown) => any; // 값 변환 함수
  precision?: number;      // 소수점 정밀도
  scale?: number;          // 소수점 스케일
  enumValues?: string[];   // PostgreSQL ENUM 값
  enumName?: string;       // PostgreSQL ENUM 타입 이름
}
```

---

## ColumnType

```typescript
type ColumnType =
  | "varchar" | "int" | "number" | "float" | "double" | "bigint"
  | "boolean" | "datetime" | "timestamp" | "date"
  | "text" | "longtext" | "blob"
  | "json" | "jsonb" | "enum";
```

---

## 관계 옵션

### ManyToOneOption

```typescript
interface ManyToOneOption {
  joinColumn?: string;     // FK 컬럼명
  eager?: boolean;         // 자동 LEFT JOIN
  lazy?: boolean;          // Proxy 지연 로딩
  cascade?: CascadeOption; // "insert" | "update" | "delete" | true | []
  transform?: (raw: unknown) => any;
}
```

### OneToManyOption

```typescript
interface OneToManyOption {
  mappedBy: string;        // ManyToOne 측 프로퍼티명
  cascade?: CascadeOption;
}
```

### OneToOneOption

```typescript
interface OneToOneOption {
  joinColumn?: string;     // FK 컬럼명 (소유측)
  inverseSide?: string;    // 역방향 프로퍼티명
  eager?: boolean;         // 자동 LEFT JOIN (소유측만)
  cascade?: CascadeOption;
}
```

### ManyToManyOption

```typescript
interface ManyToManyOption {
  joinTable?: JoinTableOption; // 소유측
  mappedBy?: string;           // 역방향
}

interface JoinTableOption {
  name: string;              // 중간 테이블명
  joinColumn: string;        // 현재 엔티티 FK
  inverseJoinColumn: string; // 대상 엔티티 FK
}
```

### CascadeOption

```typescript
type CascadeOption = boolean | ("insert" | "update" | "delete" | "remove")[];
```

---

## DatabaseClientOptions

전체 옵션은 [configuration.md](./configuration.md)를 참조하세요.

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
```

---

## PoolOptions / RetryOptions / LoggingOptions

```typescript
interface PoolOptions {
  max?: number;              // 기본값: 10
  min?: number;              // 기본값: 0 (PostgreSQL만)
  acquireTimeoutMs?: number; // 기본값: 30000
  idleTimeoutMs?: number;    // 기본값: 10000 (PostgreSQL만)
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
```

---

## ReplicationConfig

```typescript
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

---

## ITenantMigrationRunner

멀티테넌시 스키마 프로비저닝 인터페이스. 자세한 사용법은 [multi-tenancy.md](./multi-tenancy.md#tenantmigrationrunner)를 참조하세요.

```typescript
interface ITenantMigrationRunner {
  discoverSchemas(): Promise<string[]>;
  ensureSchema(tenantId: string): Promise<void>;
  syncTenantSchemas(tenantIds: string[]): Promise<TenantSyncResult>;
  isProvisioned(tenantId: string): boolean;
  getProvisionedSchemas(): string[];
  reset(): void;
}

interface TenantSyncResult {
  created: string[];
  skipped: string[];
}
```

**구현체:**

| 클래스 | import |
|--------|--------|
| `PostgresTenantMigrationRunner` | `import { PostgresTenantMigrationRunner } from "stingerloom-orm"` |
| `MySqlTenantMigrationRunner` | `import { MySqlTenantMigrationRunner } from "stingerloom-orm"` |
| `SqliteTenantMigrationRunner` | `import { SqliteTenantMigrationRunner } from "stingerloom-orm"` |
| `MssqlTenantMigrationRunner` | `import { MssqlTenantMigrationRunner } from "stingerloom-orm"` |

---

## Migration 시스템

자세한 사용법은 [migrations.md](./migrations.md)를 참조하세요.

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

| 클래스 | 설명 |
|--------|------|
| `MigrationRunner` | 마이그레이션 실행/롤백/상태 조회 |
| `MigrationCli` | DB 연결 + MigrationRunner 통합 |
| `SchemaDiff` | 엔티티 vs DB 스키마 비교 |
| `SchemaDiffMigrationGenerator` | 차이 기반 Migration 자동 생성 |

---

## 에러 클래스

| 에러 | 설명 |
|------|------|
| `OrmError` | 기본 ORM 에러 (code: `OrmErrorCode`) |
| `ValidationError` | 유효성 검사 실패 |
| `EntityNotFoundError` | 엔티티를 찾을 수 없음 |
| `EntityMetadataNotFoundError` | 엔티티 메타데이터 없음 |
| `InvalidQueryError` | 잘못된 쿼리 |
| `PrimaryKeyNotFoundError` | PK 컬럼을 찾을 수 없음 |
| `DeleteWithoutConditionsError` | 조건 없는 삭제 시도 |
| `QueryTimeoutError` | 쿼리 타임아웃 초과 |
| `TransactionError` | 트랜잭션 관련 에러 |
| `DatabaseNotConnectedError` | DB 미연결 상태 |
| `DatabaseConnectionFailedError` | DB 연결 실패 |
| `NotSupportedDatabaseTypeError` | 지원하지 않는 DB 타입 |

### OrmErrorCode

```typescript
enum OrmErrorCode {
  // 연결 관련
  CONNECTION_FAILED = "ORM_CONNECTION_FAILED",
  NOT_CONNECTED = "ORM_NOT_CONNECTED",
  UNSUPPORTED_DATABASE = "ORM_UNSUPPORTED_DATABASE",

  // 엔티티 관련
  ENTITY_NOT_FOUND = "ORM_ENTITY_NOT_FOUND",
  ENTITY_METADATA_NOT_FOUND = "ORM_ENTITY_METADATA_NOT_FOUND",
  PRIMARY_KEY_NOT_FOUND = "ORM_PRIMARY_KEY_NOT_FOUND",

  // 쿼리 관련
  INVALID_QUERY = "ORM_INVALID_QUERY",
  DELETE_WITHOUT_CONDITIONS = "ORM_DELETE_WITHOUT_CONDITIONS",
  QUERY_TIMEOUT = "ORM_QUERY_TIMEOUT",

  // 트랜잭션 관련
  TRANSACTION_FAILED = "ORM_TRANSACTION_FAILED",
  TRANSACTION_ROLLBACK_FAILED = "ORM_TRANSACTION_ROLLBACK_FAILED",

  // 유효성 검사
  VALIDATION_FAILED = "ORM_VALIDATION_FAILED",
}
```

---

## 유틸리티

| export | 설명 |
|--------|------|
| `ClazzType<T>` | `new (...args: any[]) => T` 클래스 타입 |
| `Logger` | 내부 로깅 유틸리티 |
| `ReflectManager` | reflect-metadata 래퍼 |
| `createEntityKey` | 엔티티 메타데이터 키 생성 |
| `camelToSnakeCase` | camelCase를 snake_case로 변환 |
| `RawQueryBuilderFactory` | `RawQueryBuilder` 인스턴스 생성 팩토리 |
| `DeserializerRegistry` | 역직렬화기 등록/조회 |

---

## 메타데이터 시스템

| export | 설명 |
|--------|------|
| `LayeredMetadataStore` | 레이어 기반 메타데이터 저장소 |
| `MetadataLayer` | 단일 메타데이터 레이어 |
| `MetadataContext` | AsyncLocalStorage 기반 테넌트 컨텍스트 |
| `LayeredMetadataScanner` | 메타데이터 스캐너 |

---

## 제네릭 타입

```typescript
// 엔티티 결과 타입 (find 반환값)
type EntityResult<T> = T | T[];

// 깊은 부분 타입
type DeepPartial<T> = { [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P] };

// 조건 타입
type FindCondition<T> = { [P in keyof T]?: T[P] };
```
