# API Reference

메서드 시그니처와 타입을 빠르게 찾아보는 레퍼런스입니다. 사용법과 예제는 주제별 문서에 있습니다.

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
| `getConnectionName` | `(): string` | 연결 이름 (기본값: `"default"`) |
| `getDriver` | `(): ISqlDriver \| undefined` | SQL 드라이버 반환 |
| `propagateShutdown` | `(options?: { gracefulTimeoutMs?: number; closeConnections?: boolean }): Promise<boolean>` | 내부 리소스 정리. 제한 시간이 지났는데 아직 실행 중인 쿼리가 있었으면 `false`를 반환합니다. [사용법 ->](./entity-manager-advanced.md#종료-propagateshutdown) |

### CRUD

| Method | Signature | 설명 |
|--------|-----------|------|
| `find` | `<T>(entity, option?): Promise<T[]>` | 목록 조회. `select`나 `relations` 항목의 `select`가 있으면 결과를 `FindResult`로 좁힘 |
| `findBy` | `<T>(entity, where): Promise<T[]>` | 필터 우선 목록 조회 (`find({ where })`의 단축형) |
| `findOne` | `<T>(entity, option): Promise<T \| null>` | 단건 조회 |
| `findOneBy` | `<T>(entity, where): Promise<T \| null>` | 필터 우선 단건 조회 (`findOne({ where })`의 단축형) |
| `findOneOrFail` | `<T>(entity, option): Promise<T>` | 단건 조회 (없으면 `EntityNotFoundError`를 던짐) |
| `findOneByOrFail` | `<T>(entity, where): Promise<T>` | 필터 우선 단건 조회 (없으면 `EntityNotFoundError`를 던짐). `findOneBy` + `findOneOrFail` 조합 |
| `exists` | `<T>(entity, where?, withDeleted?, onlyDeleted?): Promise<boolean>` | 매칭되는 행이 있는지 확인 |
| `findByPK` | `<T>(entity, id: unknown): Promise<T \| null>` | 기본 키로 조회 |
| `findByPKs` | `<T>(entity, ids: unknown[]): Promise<T[]>` | 여러 기본 키로 조회 |
| `findByPKsMap` | `<T>(entity, ids: unknown[]): Promise<Map<string \| number \| bigint, T>>` | 배치로 조회하고 기본 키를 키로 하는 `Map`을 반환. 반환한 Map에서는 O(1)로 조회. 복합 기본 키는 `"col1=v1,col2=v2"` 문자열 키 |
| `pluck` | `<T, K extends keyof T & string>(entity, column: K, where?): Promise<T[K][]>` | 매칭 행의 특정 컬럼 값을 1차원 배열로 반환. `find()`를 재사용하므로 테넌트 범위, 소프트 삭제, 네이밍 전략이 자동으로 적용됨 |
| `findAndCount` | `<T>(entity, option?): Promise<[T[], number]>` | 목록 + 전체 개수 |
| `findWithCursor` | `<T>(entity, option?): Promise<CursorPaginationResult<T>>` | 커서 페이지네이션 |
| `save` | `<T>(entity, item): Promise<InstanceType<ClazzType<T>>>` | INSERT 또는 UPDATE |
| `delete` | `<T>(entity, criteria): Promise<DeleteResult>` | 영구 삭제 |
| `softDelete` | `<T>(entity, criteria): Promise<DeleteResult>` | 소프트 삭제 |
| `restore` | `<T>(entity, criteria): Promise<DeleteResult>` | 소프트 삭제 복원 |
| `upsert` | `<T>(entity, data, conflictColumns?): Promise<{ affected: number }>` | INSERT ... ON CONFLICT. MySQL은 INSERT면 1, UPDATE면 2를 반환 |
| `batchUpsert` | `<T>(entity, items[], conflictColumns?): Promise<{ affected: number }>` | 다건 upsert. MySQL 주의 사항도 같음 |
| `update` | `<T>(entity, where, data): Promise<{ affected: number }>` | 필터 우선 UPDATE (`updateMany`의 단축형, `delete`와 같은 인자 순서) |
| `updateMany` | `<T>(entity, data: UpdateData<T>, options): Promise<{ affected: number }>` | 조건별 일괄 UPDATE (SQL 표현식 지원) |
| `increment` | `<T>(entity, where, column: keyof T & string, by?: number): Promise<{ affected: number }>` | 숫자 컬럼에 `by`를 `SET col = col + ?`로 원자적으로 더함. `by` 기본값은 `1`. `update()`의 안전장치를 물려받음 |
| `decrement` | `<T>(entity, where, column: keyof T & string, by?: number): Promise<{ affected: number }>` | 숫자 컬럼에서 `by`를 원자적으로 뺌. `by` 기본값은 `1`. `increment`의 역연산 |

### 구성 (저장 없음)

숨은 Unit of Work 없이 엔티티 인스턴스를 만들거나 준비하는 헬퍼입니다. 결과를 `save()`에 넘기면 저장됩니다.

| 메서드 | 시그니처 | 설명 |
|--------|-----------|-------------|
| `create` | `<T>(entity, data?): InstanceType<ClazzType<T>>` | 평범한 객체로 하이드레이트한 인스턴스를 만들고 저장하지 않음. 메서드, 게터, 트랜스포머가 적용된 실제 클래스 인스턴스. 배열을 넘기면 여러 개 생성 |
| `merge` | `<T>(target, ...sources): T` | 기존 인스턴스에 부분 패치를 병합하고 그 인스턴스를 반환. 중첩 객체는 재귀 병합. 배열, `Date`, `Buffer`는 교체. `undefined`는 건너뜀. 메모리 안에서만 처리 |
| `preload` | `<T>(entity, partial): Promise<InstanceType<ClazzType<T>> \| undefined>` | `partial`의 기본 키로 행을 조회하고 나머지를 병합해 반환. read-modify-write `save()`에 바로 사용. 완전한 기본 키가 없거나 매칭 행이 없으면 `undefined` (TypeORM과 같음) |

### Batch

| Method | Signature | 설명 |
|--------|-----------|------|
| `insertMany` | `<T>(entity, items[]): Promise<{ affected: number }>` | 다건 INSERT |
| `insertManyAndReturn` | `<T>(entity, items[]): Promise<InstanceType<ClazzType<T>>[]>` | 다건 `INSERT … RETURNING *`. 하이드레이트한 엔티티 인스턴스를 입력 순서대로 반환. PostgreSQL, SQLite 3.35+, MariaDB 10.5+ 전용. MySQL에서 호출하면 `OrmError (UNSUPPORTED_DATABASE)`를 던짐 |
| `insertIgnore` | `<T>(entity, data, conflictColumns?): Promise<{ affected: number }>` | 멱등 단건 INSERT. 새로 삽입하면 1, 일치하는 행이 이미 있으면 0. MySQL은 `INSERT IGNORE`, PostgreSQL과 SQLite는 `INSERT … ON CONFLICT DO NOTHING` |
| `saveMany` | `<T>(entity, items[]): Promise<InstanceType<ClazzType<T>>[]>` | 다건 INSERT/UPDATE |
| `deleteMany` | `<T>(entity, ids[]): Promise<DeleteResult>` | 기본 키로 다건 삭제. 복합 키는 행마다 객체 하나 |

### Relation Batch Writes

`@ManyToMany` 조인 테이블에 쓰는 메서드입니다. 모든 다이얼렉트에서 같은 코드로 동작합니다. 소유 측(owning side)과 `mappedBy` 측을 모두 지원합니다. `attachRelation`과 `detachRelation`은 엔티티 인스턴스가 아니라 기본 키 값을 받습니다. `BaseRepository.relation(ownerId, propertyKey)`의 `.add(relatedId)`와 `.remove(relatedId)`도 같은 동작입니다.

| Method | Signature | 설명 |
|--------|-----------|------|
| `attachRelation` | `<T>(entity, ownerId: unknown, propertyKey: keyof T & string, relatedId: unknown, options?: { ignoreExisting?: boolean }): Promise<{ affected: number }>` | 조인 테이블에 (owner, related) 행을 추가합니다. `ignoreExisting`이 `true`이면 이미 있는 쌍은 중복 키 에러 대신 0행 no-op이 됩니다. `ignoreExisting`의 기본값은 `true`입니다 |
| `detachRelation` | `<T>(entity, ownerId: unknown, propertyKey: keyof T & string, relatedId: unknown): Promise<{ affected: number }>` | 조인 테이블에서 (owner, related) 행을 제거합니다. 쌍이 없으면 0 |

### Aggregation

| Method | Signature | 설명 |
|--------|-----------|------|
| `count` | `<T>(entity, where?, withDeleted?, onlyDeleted?): Promise<number>` | 개수 |
| `sum` | `<T>(entity, field, where?, withDeleted?, onlyDeleted?): Promise<number>` | 합계 |
| `avg` | `<T>(entity, field, where?, withDeleted?, onlyDeleted?): Promise<number>` | 평균 |
| `min` | `<T>(entity, field, where?, withDeleted?, onlyDeleted?): Promise<number>` | 최솟값 |
| `max` | `<T>(entity, field, where?, withDeleted?, onlyDeleted?): Promise<number>` | 최댓값 |

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
| `transaction` | `<T>(callback: (em: EntityManager) => Promise<T>, options?: TransactionOptions): Promise<T>` | 콜백을 트랜잭션 안에서 실행 (데드락 재시도 옵션 지원) |

### Raw Query / Analysis

| Method | Signature | 설명 |
|--------|-----------|------|
| `query` | `<T>(sql: string \| Sql, params?: unknown[]): Promise<T[]>` | 임의의 SQL 실행 |
| `query` | `<Row>(shape: RowShape<Row>): RowQuery<Row>`<br>`<Row>(shape: RowShape<Row>, sql: string \| Sql, params?: unknown[]): Promise<Row[]>` | [`defineRow()` shape](./row-shapes.md)로 읽은 타입 있는 raw 행. 태그드 템플릿 러너나 `(shape, sql, params?)` 형태로 호출 |
| `explain` | `<T>(entity, option?): Promise<ExplainResult>` | EXPLAIN 분석 |

### Query Builder

| Method | Signature | 설명 |
|--------|-----------|------|
| `createQueryBuilder` | `(): BaseRawQueryBuilder` | RawQueryBuilder 생성 (자유 형식 SQL) |
| `createQueryBuilder` | `<T>(entity, alias): SelectQueryBuilder<T>` | 타입 안전한 SelectQueryBuilder 생성 |
| `ref` | `<T>(entity: Class<T>, alias?: string): SqlRef<T>` | 엔티티의 타입 안전 `sql`-tag 프록시. `${ref}` -> `"table" AS alias`, `${ref.col}` -> alias 한정 컬럼. [사용법 ->](./raw-sql.md#타입-참조-typed-references) |
| `aliasRef` | `(alias: string): AliasRef` | `ref()`의 alias 전용 형제 헬퍼. CTE와 파생 테이블의 컬럼 참조에 사용. `${ref}` -> bare alias, `${ref.col}` -> `alias."col"` (`camelToSnakeCase` 적용) |
| `createUpdateBuilder` | `<T>(entity, alias?): UpdateQueryBuilder<T>` | `qAlias` 조건 DSL 위의 `UPDATE … SET … WHERE … ORDER BY … LIMIT` 빌더. [사용법 ->](./query-builder.md#updatequerybuilder-—-타입-안전한-update-order-by-limit) |
| `createInsertBuilder` | `<T>(entity, alias?): InsertQueryBuilder<T>` | 충돌 절에서 저장된 행을 읽을 수 있는 `INSERT … ON CONFLICT` 빌더 (`qExcluded`, `greatest`). [사용법 ->](./entity-manager-writes.md#표현식-기반-upsert-—-createinsertbuilder) |

### Plugin System

| Method | Signature | 설명 |
|--------|-----------|------|
| `extend` | `<TApi>(plugin: StingerloomPlugin<TApi>): this & TApi` | 플러그인 설치 |
| `hasPlugin` | `(name: string): boolean` | 설치 여부 확인 |
| `registerColumnType` | `(name: string, definition: CustomColumnTypeDefinition): void` | 커스텀 컬럼 타입을 프로세스 전역에 등록 ([ColumnTypeRegistry](#columntyperegistry)) |
| `getPluginApi` | `<T>(name: string): T \| undefined` | 이름으로 플러그인 API 조회 |

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

엔티티별 CRUD 래퍼입니다. [사용법 ->](./advanced.md)

```typescript
const userRepo = em.getRepository(User);
// or
const userRepo = BaseRepository.of(User, em);
```

`find`, `findBy`, `findOne`, `findOneBy`, `findOneOrFail`, `findOneByOrFail`, `findWithCursor`, `findAndCount`, `pluck`, `create`, `merge`, `preload`, `save`, `delete`, `remove`, `softDelete`, `restore`, `insertMany`, `insertManyAndReturn`, `insertIgnore`, `saveMany`, `deleteMany`, `batchUpsert`, `count`, `sum`, `avg`, `min`, `max`, `explain`, `upsert`, `persist`, `stream`, `streamBatch`, `createQueryBuilder`, `createUpdateBuilder`, `createInsertBuilder`, `update`, `updateMany`, `increment`, `decrement`는 EntityManager와 같은 API입니다. 다만 엔티티를 지정하지 않고 호출합니다.

리포지토리 전용 헬퍼는 다음과 같습니다.

| Method | Signature | 설명 |
|--------|-----------|------|
| `relation` | `(ownerId: unknown, propertyKey: keyof T & string): RelationHandle<T>` | owner 하나의 `@ManyToMany` 조인 테이블 행을 다루는 `{ add(relatedId, options?), remove(relatedId) }`. `attachRelation`과 `detachRelation`의 단축형 |

서브클래스에서는 protected 필드 `entity`(엔티티 클래스)와 `em`(EntityManager 인스턴스)을 씁니다.

## Decorators

### Entity

| Decorator | 설명 |
|-----------|------|
| `@Entity(options?)` | 클래스를 ORM 엔티티로 등록합니다. 옵션은 `{ name: "table_name", schema: "public" }` 형태입니다. `schema`는 테이블을 PostgreSQL 스키마에 고정합니다. 그래서 그 테이블은 테넌트 전략의 영향을 받지 않습니다 |
| `@Column(option?)` | 일반 컬럼 |
| `@PrimaryGeneratedColumn(option?)` | 자동 증가 기본 키 |
| `@PrimaryColumn(option?)` | 수동 기본 키 |
| `@Index()` | 단일 컬럼 인덱스 (속성 레벨) |
| `@Index(columns, name?)` | 복합 비고유 인덱스 (클래스 레벨) |
| `@UniqueIndex(columns, name?)` | 복합 고유 인덱스 (클래스 레벨) |
| `@Version()` | 낙관적 잠금 버전 컬럼 |
| `@DeletedAt()` | 소프트 삭제 타임스탬프 |
| `@CreateTimestamp()` | INSERT 시 자동 설정 (datetime NOT NULL) |
| `@UpdateTimestamp()` | INSERT/UPDATE 시 자동 설정 (datetime NOT NULL) |

### Relations

| Decorator | 설명 |
|-----------|------|
| `@ManyToOne(getEntity, getProperty, option?)` | Many-to-one (외래 키 소유 측). `getProperty`는 역방향 속성을 가리킵니다(`(user) => user.posts`) |
| `@OneToMany(getEntity, option)` | One-to-many (역방향). `option.mappedBy`는 ManyToOne 속성 이름입니다 |
| `@OneToOne(getEntity, option?)` | One-to-one |
| `@ManyToMany(getEntity, option?)` | Many-to-many |
| `@RelationColumn(option?)` | @ManyToOne/@OneToOne의 외래 키 컬럼 선언 |

### Lifecycle Hooks

| Decorator | 시점 |
|-----------|------|
| `@BeforeInsert()` | INSERT 직전 |
| `@AfterInsert()` | INSERT 직후 |
| `@BeforeUpdate()` | UPDATE 직전 |
| `@AfterUpdate()` | UPDATE 직후 |
| `@BeforeDelete()` | DELETE 직전 |
| `@AfterDelete()` | DELETE 직후 |

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
| `@Transactional(isolationLevel?)` | 메서드를 트랜잭션으로 감쌉니다 |
| `@InjectRepository(Entity, connectionName?)` | NestJS에서 `BaseRepository<T>` 주입 (생략하면 기본 연결) |
| `@InjectEntityManager(connectionName?)` | NestJS에서 `EntityManager` 주입 (생략하면 기본 연결) |

## Type Reference

### FindOption\<T\>

```typescript
interface FindOption<T> {
  select?: readonly (keyof T)[] | { [K in keyof T]?: boolean };  // 결과 타입을 좁힘
  where?: WhereClause<T> | WhereClause<T>[];  // single or array (OR between groups)
  limit?: number | [number, number];
  skip?: number;
  take?: number;
  orderBy?: Partial<Record<keyof T, "ASC" | "DESC">>;
  groupBy?: (keyof T)[];
  having?: Sql[];
  relations?: (keyof T | string)[] | RelationsObject<T>;  // 점 경로·객체 형식으로 중첩
  withCount?: WithCountOption<T>;  // { 개수속성: "관계" }: 관계 문서 참고
  withDeleted?: boolean;
  onlyDeleted?: boolean;         // 소프트 삭제된 행만 반환 (withDeleted보다 우선)
  distinct?: boolean;            // SELECT DISTINCT
  timeout?: number;
  useMaster?: boolean;
  lock?: LockMode;
  cache?: boolean | number | { ttl?: number; tag?: string };  // opt-in 쿼리 결과 캐시
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

각 필드에는 단순 값, 필터 객체, `Sql` 객체, `null` 가운데 하나를 넣습니다. 단순 값은 동등 비교로 처리합니다.

```typescript
type WhereClause<T> = {
  [K in keyof T]?: T[K] | FieldFilter<T[K]> | Sql | null;
} & {
  OR?: WhereClause<T>[];
  AND?: WhereClause<T>[];
  NOT?: WhereClause<T>;
};
```

`null`은 값이므로 `IS NULL`이 됩니다. `undefined`는 키가 없는 것으로 보고 그 필드를 쿼리에서 뺍니다. 이 동작은 조건을 좁히지 않고 없앱니다. 그래서 다음 모양은 `InvalidQueryError`로 거부합니다.

| 모양 | 동작 |
|---|---|
| `findOne` / `findOneBy` / `findOneOrFail` / `findOneByOrFail` / `exists`에서 명시한 필드가 전부 undefined | 거부. 아무 행이나 조회하게 되기 때문 |
| 연산자 피연산자, `in` / 배열 원소, `between` 경계가 undefined | 거부. 피연산자는 명시적인 비교이기 때문 |
| `OR` 분기(또는 배열 형태 원소)가 아무 조건도 만들지 못함 | 거부. 빈 분기는 TRUE이므로 OR의 범위가 넓어지기 때문 |

그 밖의 자리에서는 undefined 필드를 그대로 건너뜁니다. 목록 조회, 집계, criteria 쓰기, 정의된 필드가 함께 있는 where가 여기에 해당합니다. `findByPK(E, undefined)`와 `findByPKs(E, [..., undefined])`도 거부합니다. 자세한 규칙은 [undefined 값](./entity-manager-querying.md#undefined-값)에 있습니다.

### Filter Operators

연산자는 필드 타입에 따라 다릅니다. `string` 필드에는 `contains`, `startsWith` 같은 연산자가 더 있습니다.

```typescript
// All types: BaseFilter<T>
{ eq, ne, in, notIn, not, isNull }

// number, Date, bigint: ComparableFilter<T> (extends BaseFilter)
{ gt, gte, lt, lte, between }

// string: StringFilter (extends ComparableFilter)
{ like, notLike, ilike, contains, startsWith, endsWith }
```

사용 예제는 [쿼리 & 페이지네이션의 WHERE 필터](./entity-manager-querying.md#where-필터)에 있습니다.

### WhereOperator (SelectQueryBuilder)

인자를 3개 받는 `where()` 메서드에서 쓰는 타입 안전 연산자 union입니다.

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

  // @Transactional과 같은 설정을 데코레이터 없이 지정합니다. ./decorator-free.md 참고
  isolationLevel?: TRANSACTION_ISOLATION_LEVEL;  // @Transactional("SERIALIZABLE")
  propagation?: TransactionPropagation | "REQUIRED" | "REQUIRES_NEW" | "NESTED";
  connectionName?: string;                       // 멀티 DB 대상 연결
}
```

### SelectQueryBuilder\<T, TResult\>

[사용법 ->](./query-builder.md) ·
[패턴 ->](./query-builder-patterns.md) ·
[QueryDSL ->](./query-builder-querydsl.md) ·
[실행 ->](./query-builder-execution.md)

```typescript
// em.createQueryBuilder(Entity, "alias")로 생성
class SelectQueryBuilder<T, TResult = T> {
  // ── SELECT ─────────────────────────────────────────────
  select(columns: (keyof T & string)[] | "*"): this;
  addSelect(expr: Sql | string, alias?: string): this;
  setDistinct(value?: boolean): this;
  withCount(relation: string, alias?: string,
            fn?: (sub: SelectQueryBuilder<any>) => void): this;

  // ── WHERE ──────────────────────────────────────────────
  where(condition: Sql): this;
  where(clause: WhereClause<T> | WhereClause<T>[]): this; // find() 스타일 필터 객체
  where(column: keyof T & string, value: any): this;
  where(column: keyof T & string, operator: string, value: any): this;
  andWhere(...): this;  // where()와 동일한 오버로드 (WhereClause 포함)
  orWhere(...): this;   // where()와 동일한 오버로드 (WhereClause 포함)
  whereIn(column: keyof T & string, values: any[]): this;
  whereNotIn(column: keyof T & string, values: any[]): this;
  whereNull(column: keyof T & string): this;
  whereNotNull(column: keyof T & string): this;
  whereBetween(column: keyof T & string, min: any, max: any): this;
  whereLike(column: keyof T & string, pattern: string): this;

  // 관계 기반 EXISTS / NOT EXISTS 서브쿼리.
  whereHas(relation: string,
           fn?: (sub: SelectQueryBuilder<any>) => void): this;
  whereNotHas(relation: string,
              fn?: (sub: SelectQueryBuilder<any>) => void): this;

  // IN (서브쿼리): 빌드한 SelectQueryBuilder를 받습니다.
  whereInSubquery(column: keyof T & string,
                  sub: SelectQueryBuilder<any>): this;
  whereNotInSubquery(column: keyof T & string,
                     sub: SelectQueryBuilder<any>): this;

  // ── JOIN / GROUP / ORDER ───────────────────────────────
  leftJoin(table: string, alias: string, condition: Sql | string): this;
  innerJoin(table: string, alias: string, condition: Sql | string): this;
  rightJoin(table: string, alias: string, condition: Sql | string): this;
  orderBy(spec: { [K in keyof T & string]?: "ASC" | "DESC" }): this;
  addOrderBy(column: string | ScalarExpression, direction: "ASC" | "DESC"): this;
  addOrderBy(expr: OrderExpression): this;
  groupBy(columns: Array<string | Sql | ScalarExpression>): this;
  //   문자열 항목: 맨 "prop" / "alias.prop", 또는 "first-name" 같은 컬럼명
  //   → 컬럼으로 해석,
  //   "UPPER(col)" / "col + 1" → 표현식 그대로 출력 (selectRaw와 같은 규칙)
  having(condition: Sql): this;
  limit(count: number): this;
  offset(count: number): this;
  skip(count: number): this;
  take(count: number): this;

  // ── LOCK / HINT ────────────────────────────────────────
  forUpdate(): this;
  forUpdateNowait(): this;
  forUpdateSkipLocked(): this;
  forShare(): this;
  forShareNowait(): this;
  forShareSkipLocked(): this;
  useIndex(indexName: string): this;           // MySQL
  forceIndex(indexName: string): this;         // MySQL
  ignoreIndex(indexName: string): this;        // MySQL
  hint(hintText: string): this;                // PostgreSQL (pg_hint_plan)
  withDeleted(): this;
  appendSql(fragment: Sql): this;

  // ── 합성 (Composition) ─────────────────────────────────
  // 조건부 분기: condition이 truthy일 때만 fn을 적용합니다.
  when(condition: boolean | (() => boolean),
       fn: (qb: this) => void,
       elseFn?: (qb: this) => void): this;
  // 재사용하는 변환 적용: fn은 변형한 qb를 반환합니다.
  pipe(fn: (qb: this) => this): this;
  // 엔티티 클래스의 `static scopes`에 선언된 명명 스코프 적용.
  applyScope(name: string): this;

  // ── 검증 (Validation) ──────────────────────────────────
  validate(validator: RowValidator<TResult>): this;
  validateArray(validator: ArrayValidator<TResult>): this;

  // ── 컴파일 & 서브쿼리 ──────────────────────────────────
  toSql(): Sql;
  getSql(): { text: string; values: any[] };
  asSubquery(alias: string): Sql;

  // 이름 있는 플레이스홀더로 미리 컴파일합니다. 다시 빌드하지 않고 재실행합니다.
  prepare<P extends Record<string, unknown> = Record<string, unknown>>():
    CompiledQuery<TResult, P>;
  preparePartial<P extends Record<string, unknown> = Record<string, unknown>>():
    CompiledQuery<TResult, P>;

  // ── 실행: 클래스 인스턴스 ──────────────────────────────
  getMany(): Promise<TResult[]>;
  getOne(): Promise<TResult | null>;
  getOneOrFail(): Promise<TResult>;           // EntityNotFoundError를 던짐
  getCount(): Promise<number>;
  getManyAndCount(): Promise<[TResult[], number]>;
  paginate(opts?: { page?: number; pageSize?: number }):
    Promise<PagePaginationResult<TResult>>;
  getCursor(option?: CursorPaginationOption<T>):
    Promise<CursorPaginationResult<TResult>>;  // 키셋 페이지네이션. 빌더의 복사본에서 실행하므로 부수 효과 없음
  getMap<K extends ColumnOf<T>>(keyColumn: K): Promise<Map<T[K], TResult>>;  // getMany() 결과를 keyColumn 기준 Map으로 인덱싱. 중복 키는 마지막 행이 남음
  pluck<K extends ColumnOf<T>>(column: K): Promise<Array<T[K]>>;             // 특정 컬럼 값만 1차원 배열로 반환. getMany()에 위임
  exists(): Promise<boolean>;
  getExists(): Promise<boolean>;              // exists() 별칭
  getSum(column: ColumnOf<T>): Promise<number>;   // SUM: 빈 결과면 0
  getAvg(column: ColumnOf<T>): Promise<number>;   // AVG: 빈 결과면 0
  getMin(column: ColumnOf<T>): Promise<number>;   // MIN: 빈 결과면 0
  getMax(column: ColumnOf<T>): Promise<number>;   // MAX: 빈 결과면 0
  explain(): Promise<ExplainResult>;          // 쿼리 플랜

  // ── 실행: 타입이 있는 plain 객체 (역직렬화 없음) ───────
  getPartialMany(): Promise<TResult[]>;
  getPartialOne(): Promise<TResult | null>;
  getPartialManyAndCount(): Promise<[TResult[], number]>;
  paginatePartial(opts?: { page?: number; pageSize?: number }):
    Promise<PagePaginationResult<TResult>>;

  // ── 실행: untyped 또는 coerce된 plain 객체 ────────────
  // `T`로 행 모양을 선언합니다.
  // 선택 옵션인 `coerce` 맵은 드라이버가 문자열로 반환한 값을 숫자나 Date로 매핑합니다.
  // mysql2 BIGINT/DECIMAL, pg NUMERIC, 날짜 컬럼이 그 예입니다.
  getRawMany<T = Record<string, unknown>>(options?: RawResultOptions<T>): Promise<T[]>;
  getRawOne<T = Record<string, unknown>>(options?: RawResultOptions<T>): Promise<T | null>;
}

// RawResultOptions<T>: 키별 coercion 맵.
//   coerce: { [K in keyof T]?: "number" | "bigint" | "boolean" | "date" | (raw: unknown) => T[K] }
```

모듈 헬퍼 `qAlias()`는 `SelectQueryBuilder`와 함께 export합니다.
`qAlias()`는 [QueryDSL 표현식](./query-builder-querydsl.md)에서 쓰는 타입 프록시를 반환합니다.
그래서 컴파일 타임에 이름을 바꿔도 컬럼 참조가 그대로 유지됩니다.

```typescript
import { qAlias } from "@stingerloom/orm";

function qAlias<T>(entity: Class<T>, name: string): QEntity<T>;

const u = qAlias(User, "u");
qb.where(u.email, "alice@example.com");
```

`qAlias()`는 `i.field(name)`과 `i.jsonField(name)` 동적 접근자도 제공합니다. 호출할 때 문자열로 컬럼을 고르는 경우에 씁니다. 저장된 필터 컴파일러와 동적 컬럼 DSL이 그 예입니다. `@ManyToOne`과 `@OneToOne`의 `fkProperty` 옵션은 관례와 다른 외래 키 속성 이름을 리졸버가 매핑하게 합니다. 이때 `@Column`을 따로 중복 선언하지 않아도 됩니다.

### Expressions (QueryDSL 헬퍼)

`Expressions` 네임스페이스는 scalar, aggregate, 분석 헬퍼를 묶은 것입니다. 보통 `as exp`로 alias를 붙입니다. 이 헬퍼는 `select()`, `where()`, `groupBy()`, `orderBy()`, `having()` 안에서 쓰고 모든 다이얼렉트에서 동작합니다. 각 헬퍼는 `ScalarExpression`, `AggregateExpression`, `WindowBuilder` 가운데 하나를 반환합니다. 반환값은 서로 조합되고 파라미터 바인딩을 끝까지 유지합니다.

전체 목록은 [QueryDSL 가이드](./query-builder-querydsl.md)에 있습니다. 요약은 다음과 같습니다.

| Family | Members |
|--------|---------|
| Null 처리 | `coalesce(a, b, …)`, `nullif(a, b)` |
| 행 단위 최대 / 최소 | `greatest(a, b, …)`, `least(a, b, …)`. `col.greatest(…)` / `col.least(…)` 체인도 가능. PostgreSQL·MySQL은 `GREATEST`/`LEAST`, SQLite는 스칼라 `MAX`/`MIN`. NULL 처리는 엔진별로 다름 |
| Cast | `.stringValue / intValue / longValue / bigintValue / floatValue / booleanValue` (column 또는 scalar) |
| Date / time | `currentDate / currentTime / currentTimestamp`, `dateTrunc(value, unit)`, `dateDiff(a, b, unit)`, `.addYears/Months/Days/Hours/Minutes/Seconds(n)`, `.year / month / day / hour / minute / second / dayOfWeek / dayOfMonth / dayOfYear / week` |
| Aggregate | `count(arg)`, `sum / avg / min / max / aggregate(scalarExpr)` (`ColumnExpression`에서도 체이닝 가능) |
| Ordered-set aggregate *(PostgreSQL 네이티브. MySQL과 SQLite는 `UNSUPPORTED_OPERATION`을 던짐)* | `percentileCont(p, orderBy)`, `percentileDisc(p, orderBy)`, `mode(orderBy)` |
| Window 함수 | `rowNumber / rank / denseRank / ntile(n) / percentRank / cumeDist`, 위치 기반 `lag / lead(expr, offset?, default?) / firstValue / lastValue / nthValue(expr, n)`. 전부 `.partitionBy(...)` / `.orderBy(...)` / `.rowsBetween(...)` / `.rangeBetween(...)` 후 `.as(alias)`로 마감하는 `WindowBuilder`를 반환합니다. |
| CASE | `caseBuilder()`, `cases(subject)`, 그리고 단축형 `iff(cond, a, b)`, `mapValues(subject, {…}, default?)`, `buckets(subject, [[t, r], …], default?)` |
| 서브쿼리 | `exists(subQb)`, `notExists(subQb)`, column `.in(subQb) / .notIn(subQb) / .eq(subQb)` … |
| 논리 | `and(...)`, `or(...)`, `not(cond)` over `ConditionLike` (column / JSON-path / aggregate / scalar) |
| 문자열 | `.toLowerCase / toUpperCase / trim / length / substring(s, e?) / concat(...args) / indexOf(needle) / replace(from, to)`, LIKE-safe `.startsWith / endsWith / contains` (`*IgnoreCase` 형제) |
| 산술 / 수학 | `.add / sub / mul / div / mod / neg / abs / floor / ceil / round(digits?) / sqrt`, `random()` |
| 전문 검색 | `Conditions.fullTextSearch(columns, term, { language?, mode? })`. MySQL은 `MATCH … AGAINST`, PostgreSQL은 `to_tsvector @@ to_tsquery` |
| 탈출구 | ``Expressions.raw<T>(sql`…`)``, `qb.selectSchema(zodSchema)` (Zod / Valibot / Effect, `TResult` 좁히기) |

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

[사용법 ->](./query-builder-execution.md#결과-검증-—-validate)

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
  renamedFrom?: string;    // 예전 DB 컬럼 이름: 이름 변경을 drop + add로 보지 않게 합니다
}
```

### ColumnType

```typescript
type KnownColumnType =
  | "varchar" | "char" | "int" | "number" | "float" | "double" | "decimal" | "bigint"
  | "boolean" | "datetime" | "timestamp" | "timestamptz" | "date"
  | "text" | "longtext" | "blob" | "uuid"
  | "json" | "jsonb" | "enum" | "array";

// ColumnTypeRegistry로 등록된 커스텀 타입은 string으로도 허용됩니다.
type ColumnType = KnownColumnType | (string & {});
```

내장 `KnownColumnType` 값 20개는 자동 완성으로 제공됩니다.
[`ColumnTypeRegistry`](#columntyperegistry)에 등록한 임의 문자열도 허용합니다.
`"geometry"`, `"vector"`가 그 예입니다.
다이얼렉트별 DDL은 등록된 정의로 해석합니다.

### Relation Options

```typescript
interface ManyToOneOption {
  joinColumn?: string;        // Deprecated on decorators — prefer @RelationColumn({ name }); still the contract for defineEntity/EntitySchema
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
  joinColumn?: string;        // Deprecated on decorators — prefer @RelationColumn({ name }); still the contract for defineEntity/EntitySchema
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
  name?: string;              // 외래 키 컬럼 이름 (생략하면 {propertyName}Id로 추론)
  type?: ColumnType;          // 외래 키 컬럼 타입 (생략하면 대상 기본 키 타입으로 추론)
  nullable?: boolean;         // 기본값: true
  referencedColumn?: string;  // 대상 참조 컬럼 (기본값: 기본 키)
}
```

> `mappedBy`와 `inverseSide`는 대상 엔티티의 속성 이름을 자동 완성합니다. 임의의 문자열도 허용합니다.

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
  synchronize?: boolean | "safe" | "dry-run" | SynchronizeOptions; // 객체 폼: { mode, continueOnError, failOnDestructiveChange, logDDL }
  schema?: string;
  charset?: string;
  datesStrings?: boolean;
  queryTimeout?: number;
  pool?: PoolOptions;
  retry?: RetryOptions;
  onConnectionError?: (error: OrmError) => void; // SQL 문을 실행하지 않는 동안 끊긴 풀 연결 (PostgreSQL, MySQL/MariaDB)
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
  maxAttempts?: number; // Default: 3
  backoffMs?: number;   // Default: 1000
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
  strategy?: "round-robin" | "random"; // 기본값: "round-robin"
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
  ssl?: boolean | SslOptions; // 기본값: 연결의 ssl
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
interface DeleteEvent<T> {
  entityClass: new (...args: any[]) => T;
  criteria: any;
  manager: EntityManager;
  affected?: number; // after 이벤트에만 설정합니다. 일치하는 행이 없으면 after 이벤트가 발생하지 않습니다
}
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

구현체는 `PostgresTenantMigrationRunner`, `MySqlTenantMigrationRunner`, `SqliteTenantMigrationRunner`입니다.

### Migration

[사용법 ->](./migrations.md)

```typescript
abstract class Migration {
  get name(): string;
  readonly transaction?: boolean;   // true: 추적 행과 함께 트랜잭션으로 실행. 미지정: PostgreSQL/SQLite는 트랜잭션, MySQL은 아님
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
  addTables: string[];
  dropTables: string[];
  addColumns: ColumnChange[];
  dropColumns: ColumnChange[];
  alterColumns: ColumnChange[];
  renamedColumns?: RenamedColumn[];        // @Column({ renamedFrom }) 또는 이름이 맞는 리네임
  renameCandidates?: RenameCandidate[];    // 리네임일 수도 있는 쌍. drop + add로 적용하고 보고만 함
  addTableEntityMap?: Record<string, ClazzType<any>>;
  enumChanges?: EnumChange[];              // 만들거나 바꿀 PostgreSQL ENUM 타입
  addComputedColumns?: ComputedColumnChange[];
}

interface ColumnChange {
  tableName: string;
  schema?: string;              // @Entity({ schema })로 고정한 PostgreSQL 스키마
  columnName: string;
  columnType?: string;
  currentType?: string;         // 데이터베이스에 있는 컬럼 타입 (alterColumns)
  nullable?: boolean;
  currentNullable?: boolean;    // 데이터베이스에 있는 컬럼의 NULL 허용 여부 (alterColumns)
  renamedFrom?: string;         // 추가 컬럼의 @Column({ renamedFrom })
  // ...그 밖에 길이, 정밀도, 스케일, enum 정보
}

interface RenamedColumn {
  tableName: string;
  schema?: string;
  oldColumnName: string;
  newColumnName: string;
  columnType: string;
  reason?: "hint" | "similar-name";
}
```

`SchemaDiff#diff(entities, queryRunner, dialect)`가 이 값을 반환합니다. 프로그래밍 방식 흐름은 [마이그레이션](./migrations.md#프로그래밍-방식-api)에 있습니다.

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

CLI 실행 명령은 `npx stingerloom migrate:run|rollback|status|generate`입니다.

관련 클래스는 `MigrationRunner`, `MigrationCli`, `SchemaDiff`, `SchemaDiffMigrationGenerator`입니다.

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

## 도구 (Tooling)

### Seeder / SeederRunner

[사용법 ->](./seeding.md)

`src/seeding/`에서 다시 export합니다.
추상 클래스 `Seeder`를 상속한 클래스를 `SeederRunner`와 함께 씁니다.
그러면 데이터베이스에 재현 가능한 픽스처나 프로덕션 기본값을 채웁니다.
실행 이력은 `__seeds` 테이블에 기록합니다.
그래서 각 시더는 환경마다 한 번만 실행합니다.

```typescript
interface SeederContext {
  em: EntityManager;
}

abstract class Seeder {
  readonly name: string;                       // 기본값은 constructor.name
  abstract run(ctx: SeederContext): Promise<void>;
  revert?(ctx: SeederContext): Promise<void>;  // 선택 사항. revertLast()에서 호출
}

interface SeederResult {
  name: string;
  direction: "run" | "revert";
  success: boolean;
  error?: string;
}

interface SeederRunnerOptions {
  trackExecution?: boolean;  // 기본값: true
  tableName?: string;        // 기본값: "__seeds"
}

interface SeederQueryRunner {
  query: (sql: string) => Promise<any>;
}

class SeederRunner {
  constructor(
    seeders: Seeder[],
    em: EntityManager,
    queryRunner: SeederQueryRunner,
    options?: SeederRunnerOptions,
  );
  ensureSeedTable(): Promise<void>;
  runAll(): Promise<SeederResult[]>;
  runOne(seeder: Seeder): Promise<SeederResult>;
  revertLast(): Promise<SeederResult | null>;
  status(): Promise<{ executed: string[]; pending: string[] }>;
  getExecutedSeeds(): Promise<string[]>;
}
```

### IntrospectionGenerator

[사용법 ->](./introspection.md)

`src/introspection/`과 `@stingerloom/orm/introspection`에서 다시 export합니다.
다이얼렉트별 카탈로그를 다이얼렉트에 중립적인 스키마 IR로 읽습니다.
카탈로그는 `pg_catalog`, `INFORMATION_SCHEMA`, SQLite `PRAGMA`입니다.
그리고 이 IR로 데코레이터 스타일이나 code-first 스타일의 엔티티 소스 코드를 생성합니다.
컬럼마다 ORM 타입은 ORM의 컬럼 정의 빌더로 후보를 렌더링해서 고릅니다.
그래서 엔티티가 재현하지 못하는 부분에는 `// NOTE:` 주석이 붙습니다.
출력은 라운드 트립에서 안정적입니다.
생성된 엔티티를 빈 스키마에 다시 적용하고 인트로스펙트해도 같은 파일이 나옵니다.

```typescript
type IntrospectionDialect = "mysql" | "postgres" | "sqlite";

interface GeneratedEntity {
  tableName: string;
  className: string;
  code: string;
  fileName: string;
  notes: string[];     // 파일에 달린 모든 // NOTE:
}

interface IntrospectionGeneratorOptions {
  schema?: string;                                  // 기본값: "public" (PostgreSQL)
  excludeTables?: string[];
  includeTables?: string[];                         // 설정하면 이 테이블만 생성
  codeBuilderOptions?: EntityCodeBuilderOptions;    // 예: { importPath: "../orm" }
}

interface IntrospectionQueryFn {
  (sql: string | import("sql-template-tag").Sql): Promise<any>;
}

class IntrospectionGenerator {
  constructor(
    queryFn: IntrospectionQueryFn,
    dialect: IntrospectionDialect,
    options?: IntrospectionGeneratorOptions,
  );
  generate(): Promise<GeneratedEntity[]>;
  readSchema(): Promise<SchemaIR>;             // 선택된 테이블을 스키마 IR로
  readTable(table: string): Promise<TableIR>;
  discoverTables(): Promise<string[]>;
  /** @deprecated readTable()을 쓰세요 */ getColumns(table: string): Promise<DbColumn[]>;
  /** @deprecated readTable()을 쓰세요 */ getPrimaryKeys(table: string): Promise<string[]>;
  /** @deprecated readTable()을 쓰세요 */ getForeignKeys(table: string): Promise<DbForeignKey[]>;
  /** @deprecated readTable()을 쓰세요 */ getIndexes(table: string): Promise<DbIndex[]>;
}

// 편의 래퍼: DatabaseClient로 연결하고 파일을 디스크에 기록합니다.
// `npx stingerloom introspect` CLI 명령의 백엔드이기도 합니다.
interface IntrospectionCliOptions {
  outputDir?: string;             // 기본값: "./entities"
  schema?: string;
  includeTables?: string[];
  excludeTables?: string[];
  codeBuilderOptions?: EntityCodeBuilderOptions;
  dryRun?: boolean;
}

interface IntrospectionCliResult {
  writtenFiles: string[];
  entities: GeneratedEntity[];
}

function runIntrospect(
  dbOptions: DatabaseClientOptions,
  cliOptions?: IntrospectionCliOptions,
): Promise<IntrospectionCliResult>;

// 하위 레벨 헬퍼 (이것도 다시 export합니다)
class EntityCodeBuilder {
  constructor(options?: EntityCodeBuilderOptions);
  build(tableName: string, columns: DbColumn[],
        pks: string[], fks: DbForeignKey[],
        dialect: IntrospectionDialect,
        indexes?: DbIndex[]): string;
  emit(model: EntityModel): string;
  tableNameToClassName(tableName: string): string;
  classNameToFileName(className: string): string;
}

// 예전 타입 표. 제너레이터는 더 이상 toColumnType()을 참조하지 않습니다.
class IntrospectionTypeMapper {
  /** @deprecated */
  toColumnType(
    dbType: string,
    dialect: IntrospectionDialect,
    columnTypeFull?: string,
  ): ColumnType;
  toTsType(columnType: ColumnType): string;
  parseSqliteWidth(declaredType: string): number | null;
  parseSqlitePrecisionScale(declaredType: string): { precision: number; scale: number } | null;
}
```

## Errors

ORM이 던지는 에러는 모두 `OrmError`입니다. `OrmError`는 `OrmErrorCode`의 `code`, 해결 힌트인 `suggestion`, 다른 에러를 감쌀 때의 `cause`를 담습니다. `suggestion`이 없으면 값은 `null`입니다. `suggestion`은 `message` 끝에도 `Suggestion:` 줄로 붙습니다. 고유 키나 외래 키를 어긴 SQL 문은 [`UniqueConstraintViolationError` 또는 `ForeignKeyViolationError`](#제약-조건-위반)로 실패합니다. SQL 문이 데이터베이스에서 받는 그 밖의 에러는 드라이버가 던진 그대로 전달됩니다. NOT NULL이나 CHECK 위반, 문법 에러가 그 예입니다.

```typescript
try {
  await em.find(UnregisteredEntity);
} catch (e) {
  if (e instanceof OrmError) {
    console.error(e.code);       // "ORM_ENTITY_METADATA_NOT_FOUND"
    console.error(e.message);    // 'Entity metadata for "UnregisteredEntity" does not exist. …\nSuggestion: Decorate UnregisteredEntity with @Entity() …'
    console.error(e.suggestion); // 'Decorate UnregisteredEntity with @Entity() …' (같은 힌트, 접두어 없이)
  }
}
```

`ValidationError`는 `actual`과 `expected`도 담습니다. `actual`은 측정한 값입니다. `@MinLength`와 `@MaxLength`에서는 길이이고 `@Min`과 `@Max`에서는 값 자체입니다.

```typescript
try {
  await em.save(User, { name: "A" }); // @MinLength(2) 실패
} catch (e) {
  if (e instanceof ValidationError) {
    console.error(e.message);  // 'name must be at least 2 characters long (actual: 1, expected: 2)\nSuggestion: Check the "name" field — it failed the "minLength" validation.'
    console.error(e.actual);   // 1
    console.error(e.expected); // 2
  }
}
```

`cause`에는 `ORM_CONNECTION_FAILED`, `ORM_SCHEMA_SYNC_FAILED`, `ORM_QUERY_TIMEOUT`, `ORM_UNIQUE_VIOLATION`, `ORM_FK_VIOLATION` 뒤의 드라이버 에러와 `ORM_TRANSACTION_ROLLBACK_FAILED` 뒤의 원래 에러가 담깁니다. 그래서 그 에러의 필드도 그대로 남아 있습니다. `(e.cause as { code?: string }).code`는 `"ECONNREFUSED"`, `"28P01"` 같은 PostgreSQL SQLSTATE, `"ER_BAD_DB_ERROR"` 같은 MySQL 코드 가운데 하나입니다. 어떤 실패가 `register()`를 실패시키는지는 [실패한 시도로 치는 경우](./configuration.md#실패한-시도로-치는-경우)에 있습니다.

| Error | 코드 | 던지는 경우 |
|-------|------|-------------|
| `OrmError` | 전부 | 기본 클래스. 서브클래스가 없는 코드는 이 클래스로 직접 던집니다 |
| `ValidationError` | `ORM_VALIDATION_FAILED` | 검증 데코레이터가 값을 거부할 때 (`actual`, `expected` 포함) |
| `InvalidQueryError` | `ORM_INVALID_QUERY` | 쿼리 옵션이 없는 컬럼을 가리키거나 형식이 잘못됐을 때 |
| `EntityNotFoundError` | `ORM_ENTITY_NOT_FOUND` | `findOneOrFail()` 등이 행을 찾지 못했을 때 |
| `EntityMetadataNotFoundError` | `ORM_ENTITY_METADATA_NOT_FOUND` | 클래스가 엔티티가 아니거나 그 연결에 등록되지 않았을 때 |
| `PrimaryKeyNotFoundError` | `ORM_PRIMARY_KEY_NOT_FOUND` | 작업에 필요한 기본 키를 엔티티가 선언하지 않았을 때 |
| `DeleteWithoutConditionsError` | `ORM_DELETE_WITHOUT_CONDITIONS` | 조건이 비어 있어서 모든 행을 삭제하는 DELETE를 실행하려 할 때 |
| `OptimisticLockError` | `ORM_OPTIMISTIC_LOCK_FAILED` | `@Version` 검사에서 행이 바뀐 것을 발견했을 때 |
| `AdvisoryLockError` | `ORM_ADVISORY_LOCK_FAILED` | 마이그레이션·시더 잠금을 제한 시간 안에 얻지 못했을 때 |
| `UnsupportedFeatureError` | `ORM_UNSUPPORTED_OPERATION` | 연결한 데이터베이스 버전에 DDL 문이 필요로 하는 기능이 없을 때 |
| `UniqueConstraintViolationError` | `ORM_UNIQUE_VIOLATION` | SQL 문이 중복된 기본 키나 고유 값을 저장하려 할 때. 드라이버 에러가 `cause`이고 `constraint`, `table`, `columns`도 있음 |
| `ForeignKeyViolationError` | `ORM_FK_VIOLATION` | 행이 없는 부모를 가리키거나 참조 중인 부모를 삭제하거나 그 키를 바꿀 때. 드라이버 에러가 `cause`이고 `constraint`, `table`도 있음 |
| `QueryTimeoutError` | `ORM_QUERY_TIMEOUT` | PostgreSQL이나 MySQL/MariaDB가 `timeout` / `queryTimeout`을 넘긴 읽기를 취소했을 때. 드라이버 에러가 `cause` |
| `DatabaseNotConnectedError` | `ORM_NOT_CONNECTED` | 그 연결 이름으로 등록된 것이 없을 때 (예: `register()` 전의 쿼리) |
| `DatabaseConnectionFailedError` | `ORM_CONNECTION_FAILED` | 쿼리가 연결을 얻지 못했을 때 (서버 다운, 풀 고갈). 드라이버 에러가 `cause`이고 `status: 500`도 있음 |
| `NotSupportedDatabaseTypeError` | `ORM_UNSUPPORTED_DATABASE` | `type`이 ORM에 드라이버가 없는 데이터베이스일 때. `status: 500`도 있음 |
| `TransactionError` | `ORM_TRANSACTION_FAILED` | deprecated. ORM 어디에서도 던지지 않으므로 `instanceof TransactionError`는 맞는 경우가 없습니다. 롤백 실패는 `ORM_TRANSACTION_ROLLBACK_FAILED` 코드의 `OrmError`입니다 |

`register()`도 열지 못한 연결을 `ORM_CONNECTION_FAILED` 코드의 `OrmError`로 알립니다. `DatabaseConnectionFailedError`와 `NotSupportedDatabaseTypeError`는 예전에는 별도의 `Exception` 클래스를 상속했고 `code`가 없었습니다. `Exception`은 지금도 export합니다. 하지만 이 클래스를 상속하는 ORM 에러는 없습니다.

`ORM_CONNECTION_LOST`는 ORM이 던지지 않는 유일한 코드입니다. 실행 중인 SQL 문이 없는 풀 연결을 서버가 닫으면 그 에러를 받을 호출자가 없습니다. 그래서 이 `OrmError`는 [`onConnectionError`](./configuration.md#시작-이후-끊긴-연결) 옵션으로 전달합니다. 옵션을 설정하지 않았으면 경고 로그로 남깁니다. 드라이버 에러는 `cause`에 담습니다.

### 제약 조건 위반

중복 키와 외래 키 위반은 데이터베이스와 쓰기 경로에 상관없이 `OrmError`로 실패합니다. `save()`, 배치 메서드, upsert 메서드, 쿼리 빌더, 쓰기 버퍼의 flush, raw `em.query()`가 모두 같습니다. 메시지는 데이터베이스가 보낸 그대로입니다. 그리고 드라이버 에러는 `cause`에 담깁니다. 그래서 드라이버 코드로 확인하던 코드는 `e.cause`에서 같은 값을 찾으면 됩니다. 드라이버 코드는 `23505`, errno `1062`, `SQLITE_CONSTRAINT_UNIQUE` 같은 값입니다. COMMIT 시점에 검사하는 지연(deferred) 제약 조건이 실패해도 `em.transaction()`이 같은 에러를 던집니다.

```typescript
try {
  await em.save(User, { email: "taken@example.com" });
} catch (e) {
  if (e instanceof UniqueConstraintViolationError) {
    e.code;       // "ORM_UNIQUE_VIOLATION"
    e.constraint; // "uq_users_email" (PostgreSQL, MySQL/MariaDB)
    e.columns;    // ["email"] (PostgreSQL, SQLite)
    e.cause;      // 드라이버 에러: code "23505", errno 1062, code "SQLITE_CONSTRAINT_UNIQUE" 중 하나
  } else if (e instanceof ForeignKeyViolationError) {
    e.code;       // "ORM_FK_VIOLATION"
    e.table;      // 외래 키를 가진 테이블 (PostgreSQL, MySQL/MariaDB)
  }
}
```

나머지 필드에는 데이터베이스가 보고한 제약 조건 정보가 담깁니다. 데이터베이스가 보고하지 않은 항목은 `undefined`입니다. `columns`와 `table`은 엔티티 속성 이름이 아니라 데이터베이스의 이름입니다. 외래 키의 `table`은 SQL 문이 참조의 어느 쪽에 썼든 외래 키를 가진 테이블입니다.

| 필드 | PostgreSQL | MySQL / MariaDB | SQLite |
|------|------------|-----------------|--------|
| `UniqueConstraintViolationError.constraint` | 제약 조건 또는 인덱스 이름 | 키 이름 (기본 키는 `PRIMARY`) | 표현식 인덱스일 때만 |
| `UniqueConstraintViolationError.table` | 있음 | MySQL 8.0.19 이상만 | 있음 |
| `UniqueConstraintViolationError.columns` | 있음 (표현식 키는 그 텍스트) | 없음 | 있음 |
| `ForeignKeyViolationError.constraint` | 있음 | 있음 | 없음 |
| `ForeignKeyViolationError.table` | 있음 | 있음 | 없음 |

NOT NULL이나 CHECK 위반은 변환하지 않고 드라이버 에러 그대로 전달됩니다.

이전 버전에서는 이런 위반이 드라이버 에러 그대로 전달됐습니다. `OrmErrorCode.UNIQUE_VIOLATION`과 `FK_VIOLATION`을 생성하는 곳도 없었습니다. PostgreSQL과 MySQL/MariaDB에서 COMMIT이 실패할 때도 잘못 알렸습니다. 지연 제약 조건이나 직렬화 실패가 그런 경우입니다. 이때 `em.transaction()`은 `ORM_TRANSACTION_ROLLBACK_FAILED`로 알렸고 `@Transactional` 메서드는 연결 에러로 알렸습니다. 이제는 둘 다 COMMIT이 받은 에러 그대로 실패합니다. 롤백도 다른 실패와 똑같이 진행합니다.

### OrmErrorCode

```typescript
enum OrmErrorCode {
  // Connection
  CONNECTION_FAILED = "ORM_CONNECTION_FAILED",
  NOT_CONNECTED = "ORM_NOT_CONNECTED",
  CONNECTION_LOST = "ORM_CONNECTION_LOST",
  UNSUPPORTED_DATABASE = "ORM_UNSUPPORTED_DATABASE",
  // Entity
  ENTITY_NOT_FOUND = "ORM_ENTITY_NOT_FOUND",
  ENTITY_METADATA_NOT_FOUND = "ORM_ENTITY_METADATA_NOT_FOUND",
  PRIMARY_KEY_NOT_FOUND = "ORM_PRIMARY_KEY_NOT_FOUND",
  // Query
  INVALID_QUERY = "ORM_INVALID_QUERY",
  DELETE_WITHOUT_CONDITIONS = "ORM_DELETE_WITHOUT_CONDITIONS",
  QUERY_TIMEOUT = "ORM_QUERY_TIMEOUT",
  QUERY_ERROR = "ORM_INVALID_QUERY", // deprecated: INVALID_QUERY와 같은 값
  BIGINT_PRECISION_LOSS = "ORM_BIGINT_PRECISION_LOSS",
  DECIMAL_PRECISION_LOSS = "ORM_DECIMAL_PRECISION_LOSS",
  MISSING_REQUIRED_COLUMNS = "ORM_MISSING_REQUIRED_COLUMNS",
  MISSING_PLACEHOLDER = "ORM_MISSING_PLACEHOLDER",
  // Transaction
  TRANSACTION_FAILED = "ORM_TRANSACTION_FAILED", // deprecated: 어디에서도 보고하지 않음
  TRANSACTION_ROLLBACK_FAILED = "ORM_TRANSACTION_ROLLBACK_FAILED",
  INVALID_SAVEPOINT_NAME = "ORM_INVALID_SAVEPOINT_NAME",
  // Locking
  ADVISORY_LOCK_FAILED = "ORM_ADVISORY_LOCK_FAILED",
  OPTIMISTIC_LOCK_FAILED = "ORM_OPTIMISTIC_LOCK_FAILED",
  // Validation
  VALIDATION_FAILED = "ORM_VALIDATION_FAILED",
  VALIDATION_ERROR = "ORM_VALIDATION_FAILED", // deprecated: VALIDATION_FAILED와 같은 값
  // 제약 조건 위반: UniqueConstraintViolationError / ForeignKeyViolationError
  UNIQUE_VIOLATION = "ORM_UNIQUE_VIOLATION",
  FK_VIOLATION = "ORM_FK_VIOLATION",
  // Unsupported operation
  UNSUPPORTED_OPERATION = "ORM_UNSUPPORTED_OPERATION",
  // Configuration, entity loading and optional dependencies
  INVALID_CONFIG = "ORM_INVALID_CONFIG",
  ENTITY_GLOB_NO_MATCH = "ORM_ENTITY_GLOB_NO_MATCH",
  ENTITY_GLOB_LOAD_FAILED = "ORM_ENTITY_GLOB_LOAD_FAILED",
  MISSING_DEPENDENCY = "ORM_MISSING_DEPENDENCY",
  // Plugins
  PLUGIN_DEPENDENCY_MISSING = "ORM_PLUGIN_DEPENDENCY_MISSING",
  PLUGIN_CONFLICT = "ORM_PLUGIN_CONFLICT",
  BUFFER_NOT_INSTALLED = "ORM_BUFFER_NOT_INSTALLED",
  BUFFER_NOT_TRACKED = "ORM_BUFFER_NOT_TRACKED",
  BUFFER_IDENTITY_CONFLICT = "ORM_BUFFER_IDENTITY_CONFLICT",
  // Schema
  SCHEMA_ERROR = "ORM_SCHEMA_ERROR",
  SCHEMA_SYNC_FAILED = "ORM_SCHEMA_SYNC_FAILED",
  SCHEMA_SYNC_DESTRUCTIVE_CHANGE = "ORM_SCHEMA_SYNC_DESTRUCTIVE_CHANGE",
  // Multi-tenancy
  MISSING_TENANT_CONTEXT = "ORM_MISSING_TENANT_CONTEXT",
  TENANT_MISMATCH = "ORM_TENANT_MISMATCH",
  CROSS_TENANT_TRANSACTION = "ORM_CROSS_TENANT_TRANSACTION",
  TENANT_RESOLVER_MISSING = "ORM_TENANT_RESOLVER_MISSING",
}
```

`QUERY_ERROR`와 `VALIDATION_ERROR`는 deprecated된 별칭입니다. 각각 중복되던 코드인 `INVALID_QUERY`, `VALIDATION_FAILED`와 같은 값입니다. 그래서 어느 이름으로 확인해도 같은 에러가 걸립니다. `VALIDATION_FAILED`는 `ValidationError`에서만 나옵니다.

이전 버전에서는 같은 개념에 코드가 두 개씩 있었습니다.

- `"ORM_QUERY_ERROR"`는 선언한 컬럼이 빠진 `em.query(shape)` 결과, 실패한 `getRawMany()` 변환, 잘못된 ORDER BY 방향, 쓴 행을 다시 조회하지 못한 쓰기에서 나왔습니다. 이제는 `"ORM_INVALID_QUERY"`로 알립니다. `OrmErrorCode.QUERY_ERROR`로 확인하는 코드에도 그대로 걸립니다.
- `"ORM_VALIDATION_ERROR"`는 스키마 검사에서 나왔습니다. 렌더링하지 못하는 값을 반환하는 `@ComputedColumn` 빌더, 잘못된 `@FullTextIndex` 언어, enum 값이나 다른 DDL 리터럴에 든 null 바이트가 그 경우입니다. 이제는 `"ORM_SCHEMA_ERROR"`로 알립니다. 그래서 `OrmErrorCode.VALIDATION_ERROR`로 확인하는 코드에는 대신 `ValidationError`가 걸립니다.
- `master`나 `slaves`가 없는 `replication` 옵션은 `"ORM_VALIDATION_FAILED"`가 아니라 `"ORM_INVALID_CONFIG"`로 알립니다.

`e.code`를 예전 문자열과 비교하던 코드는 새 문자열로 바꿔야 합니다.

## EntitySchema (Decorator-Free Entity Definition)

[사용법 ->](./entities.md#데코레이터-없이-엔티티-정의하기-entityschema) · [데코레이터 → 대안 전체 매핑 ->](./decorator-free.md)

```typescript
import { EntitySchema, EntitySchemaOptions, ColumnSchemaDef } from "@stingerloom/orm";

const schema = new EntitySchema<T>(options: EntitySchemaOptions<T>);
```

### EntitySchemaOptions\<T\>

```typescript
interface EntitySchemaOptions<T> {
  target: ClazzType<T>;                                    // 엔티티 클래스
  tableName?: string;                                      // 테이블 이름 (기본: 클래스명 snake_case)
  schema?: string;                                         // 테이블을 고정할 PostgreSQL 스키마 (@Entity({ schema }) 대응)
  columns: { [K in keyof T]?: ColumnSchemaDef };           // 컬럼 정의
  computedColumns?: { [K in keyof T]?: ComputedColumnOption };  // @ComputedColumn 대응
  relations?: { [K in keyof T]?: RelationSchemaDef };      // 관계 정의
  uniqueIndexes?: { columns: string[]; name?: string }[];  // 복합 고유 인덱스
  indexes?: { columns: string[]; name?: string; options?: AdvancedIndexOptions }[];  // 복합 비고유 인덱스
  fullTextIndexes?: { columns: string[]; name?: string; language?: string }[];  // @FullTextIndex 대응
  nonTenant?: boolean;                                     // @NonTenantEntity 대응
  hooks?: Partial<Record<HookEvent, Extract<keyof T, string>>>;  // 생명주기 훅

  // 상속 매핑 (@Inheritance, @DiscriminatorColumn, @DiscriminatorValue 대체)
  inheritance?: InheritanceSchemaDef;                      // 루트 엔티티: 전략 선언
  discriminatorColumn?: DiscriminatorColumnSchemaDef;      // 루트 엔티티: 구분 컬럼 설정
  discriminatorValue?: string;                             // 자식 엔티티: 구분 값
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
  renamedFrom?: string;                       // 예전 DB 컬럼 이름 (이름 변경 힌트)
  transform?: (raw: unknown) => any;          // @deprecated: transformer를 사용
  transformer?: ColumnTransformer;            // @Column({ transformer }): 양방향
  generationStrategy?: "increment" | "uuid" | "uuid-v7";  // @PrimaryGeneratedColumn(strategy)
  jsonIndex?: JsonIndexOptions;               // 이 컬럼의 @JsonIndex()
  tenant?: boolean;                           // @TenantColumn(): 테넌트 구분 컬럼 표시

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
  | { kind: "manyToOne"; target: () => ClazzType; joinColumn?: string; references?: string; eager?: boolean; cascade?: CascadeOption; lazy?: boolean; relationColumn?: RelationColumnOption }
  | { kind: "oneToMany"; target: () => ClazzType; mappedBy: string; cascade?: CascadeOption }
  | { kind: "oneToOne"; target: () => ClazzType; joinColumn?: string; inverseSide?: string; eager?: boolean; cascade?: CascadeOption; relationColumn?: RelationColumnOption }
  | { kind: "manyToMany"; target: () => ClazzType; joinTable?: JoinTableOption; mappedBy?: string };
```

> `relationColumn`은 명시적인 외래 키 컬럼 메타데이터를 담습니다(`name`, `type`, `nullable`, `referencedColumn`). `@RelationColumn()`에 대응합니다. 자세한 내용은 [데코레이터 없이 사용하기](./decorator-free.md#외래-키-컬럼-relationcolumn)에 있습니다.

## defineRow (Raw 결과 타입)

[사용법 ->](./row-shapes.md)

```typescript
import { defineRow, t, InferRow, isRowShape } from "@stingerloom/orm";

const shape = defineRow(columns: Record<string, ColumnBuilder<any>>, options?: { name?: string });
type Row = InferRow<typeof shape>;
const rows: Row[] = await em.query(shape)`SELECT ...`;
```

| Export | 설명 |
|--------|------|
| `defineRow(columns, options?)` | `t` 컬럼 빌더로 얼린(frozen) `RowShape`를 만듭니다. 아무것도 등록하지 않습니다. 관계 빌더와 계산 컬럼 빌더는 `SCHEMA_ERROR`를 던집니다 |
| `InferRow<S>` | shape의 행 타입 |
| `InferRowColumns<Cols>` | 컬럼 맵의 행 타입 |
| `RowShape<Row>` / `RowColumns` / `RowQuery<Row>` / `DefineRowOptions` | 보조 타입 (`RowQuery`는 `em.query(shape)`가 반환하는 태그드 러너) |
| `isRowShape(value)` | shape 타입 가드 |

## Utilities

| Export | 설명 |
|--------|------|
| `ClazzType<T>` | `new (...args: any[]) => T` |
| `FindResult<T, S, R, W>` | 조회가 반환하는 엔티티의 타입을 `select`(S), `relations`(R), `withCount`(W)로 좁힌 것. 선택한 속성, 로드한 관계, 채운 개수, 메서드를 담습니다. `select`가 있는 `relations` 항목은 그 관계를 좁힙니다. 그 밖에는 `T` |
| `SelectFindOption<T, S, R, W>` / `RelationsFindOption<T, R>` | 조회 메서드가 결과를 좁히는 옵션 모양: `select`가 있는 `FindOption<T>`, 또는 객체 형식 `relations`가 있는 `FindOption<T>` |
| `EntityResult<T>` | deprecated. 예전에는 `T \| T[]`였습니다. 지금은 `find()`는 `T[]`를 반환하고 `save()`는 `T`를 반환합니다 |
| `DeepPartial<T>` | Deep partial 타입 |
| `Relation<T>` | 단수 관계 속성용 identity 래퍼. `design:type`을 `Object`로 지워서 서로 참조하는 엔티티를 ESM에서도 로드하게 합니다 ([관계](./relations.md) 참고) |
| `WhereClause<T>` | 타입 안전한 WHERE 조건. 컬럼 동등 비교, 연산자(`gt`, `in`, `like`, …), `AND` / `OR` / `NOT` 지원 |
| `RawQueryBuilderFactory` | Query builder 팩토리 |
| `MetadataContext` | AsyncLocalStorage 기반 테넌트 컨텍스트 |
| `Logger` | 내부 로깅 유틸리티 |
