# Changelog

모든 주목할 만한 변경 사항은 이 파일에 기록됩니다.

## [Unreleased] — 내실 다지기 세션 (2026-02-22)

### Added

- **이벤트 시스템** (`bfc6159`)
  - `EntityEventEmitter`: on/off/emit/removeAllListeners API
  - `EntityManager.on(event, handler)` / `EntityManager.off(event, handler)`
  - 이벤트: `beforeInsert`, `afterInsert`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`
  - 22개 유닛 테스트

- **Select 특정 컬럼** (`2258dd5`)
  - `FindOption.select?: string[] | Record<string, boolean>` 옵션 추가
  - `find(Entity, { select: ["id", "name"] })` → `SELECT "id", "name" FROM ...`
  - `escapeIdentifier()`로 컬럼명 escape 보장
  - 7개 유닛 테스트

- **Raw Query 제네릭 타입** (`21008a3`)
  - `EntityManager.query<T>(sql, params?): Promise<T[]>` 제네릭 메서드
  - `string` SQL 및 `sql-template-tag` Sql 객체 모두 지원
  - 자동 트랜잭션 관리 (commit/rollback)
  - 12개 유닛 테스트

- **Connection Retry (지수 백오프)** (`21008a3`)
  - `DatabaseClientOptions.retry?: RetryOptions`
  - `RetryOptions { maxAttempts: number, backoffMs: number }`
  - 실제 지연: `backoffMs * 2^(attempt-1)`
  - 11개 유닛 테스트

- **복합 PK 지원** (`a124fb0`)
  - `@PrimaryColumn(options?)` 데코레이터 추가 (auto-increment 없는 수동 PK)
  - 여러 `@PrimaryColumn` → `PRIMARY KEY (col1, col2)` DDL 생성
  - `EntityManager.find/findOne/delete`에서 복합 PK WHERE 절 처리
  - `SchemaGenerator` DDL 반영
  - 16개 유닛 테스트

- **MSSQL 드라이버** (`9b2c681`)
  - `MssqlDriver` / `MssqlConnector` / `MssqlDataSource` 구현
  - 식별자 래핑: `[column_name]` (대괄호)
  - PK: `IDENTITY(1,1)`, 파라미터: `@param0` 형식
  - 타입 매핑: varchar→NVARCHAR, boolean→BIT, datetime→DATETIME2
  - `DatabaseClient`, `TransactionSessionManager`, `EntityManager`에 `"mssql"` 통합
  - 69개 유닛 테스트

- **쿼리 결과 캐싱** (`d856ab6`, `b88274b`)
  - `QueryCache`: Map 기반, TTL 자동 만료 (기본 30초)
  - `FindOption.cache?: boolean | number` (`true` → 30초, `number` → 해당 ms)
  - 캐시 키: 엔티티명 + where/orderBy/limit/take/select 조합 해시
  - `EntityManager.clearCache(entity?)` 수동 무효화
  - save/update/delete/deleteMany/insertMany/softDelete/restore 시 자동 무효화
  - 32개 유닛 테스트

- **타입 시스템 강화** (`b88274b`)
  - `FindCondition<T>`: `$eq/$ne/$gt/$lt/$gte/$lte/$like/$in/$notIn/$isNull` 연산자 타입
  - `DeepPartial<T>`: 재귀적 optional 타입 (save/update 인자용)
  - `OrderByOption<T>`: SortDirection + 엔티티 필드 기반 타입 안전 정렬
  - `FindOption<T>` 제네릭 교체

- **OrmError 체계화** (`b88274b`)
  - `OrmError` (base) + `OrmErrorCode` enum (11개 코드)
  - `EntityMetadataNotFoundError`, `EntityNotFoundError`, `PrimaryKeyNotFoundError`
  - `InvalidQueryError`, `TransactionError`, `DeleteWithoutConditionsError`
  - `EntityManager` 전체 throw 지점 구체적 에러 클래스로 교체
  - 39개 유닛 테스트 (type-safety.test.ts)

- **EntitySubscriber 패턴** (`91ddf9f`)
  - `EntitySubscriber<T>` 인터페이스: `listenTo()` + 생명주기 훅 + 트랜잭션 훅
  - `InsertEvent<T>`, `UpdateEvent<T>`, `DeleteEvent<T>` 이벤트 객체
  - `EntityManager.addSubscriber()` / `removeSubscriber()`
  - `notifySubscribers()`: `listenTo()`로 대상 엔티티 필터링
  - 22개 유닛 테스트

- **EXPLAIN 쿼리 지원** (`58c8c37`)
  - `EntityManager.explain<T>(entity, option?): Promise<ExplainResult>`
  - `ExplainResult`: raw/rows/type/possibleKeys/key/cost 표준화 타입
  - MySQL: `EXPLAIN SELECT ...`, PostgreSQL: `EXPLAIN (FORMAT JSON) SELECT ...`, SQLite: `EXPLAIN QUERY PLAN`
  - `ISqlDriver.supportsExplain(): boolean`
  - `BaseRepository.explain(option?)` 위임 메서드

- **신기능 통합 테스트 추가** (`55d9422`)
  - `integration/query-cache.test.ts`, `integration/entity-subscriber.test.ts`
  - `integration/many-to-many.test.ts`, `integration/schema-generator.test.ts`

- **OneToMany / ManyToOne 관계 통합 테스트** (미커밋 신규)
  - `integration/helpers/create-relation-entity.ts`: 동적 엔티티 쌍 팩토리
    - `createOneToManyTestEntities()`: 기본 관계 (cascade 없음)
    - `createCascadeRelationEntities()`: cascade insert 관계
    - MySQL FK 64자 제한 대응 짧은 테이블명 생성 (`shortTableName`)
  - `integration/relations-one-to-many.test.ts`: 20개 통합 테스트
    - Suite 1: 기본 ManyToOne/OneToMany — CRUD + eager 로딩 + relations 옵션 + FK 무결성
    - Suite 2: Cascade Insert — OneToMany cascade: ["insert"] 자동 자식 저장

- **커서 기반 페이지네이션** (`c608296`)
  - `CursorPaginationOption<T>`: take, cursor, orderBy, direction, where
  - `CursorPaginationResult<T>`: data, hasNextPage, nextCursor, count
  - `encodeCursor()` / `decodeCursor()`: Base64 JSON 인코딩/디코딩
  - `EntityManager.findWithCursor<T>(entity, option)`: `take+1` 조회로 hasNextPage 결정
  - `@DeletedAt` 자동 필터, WHERE 조건 병합, orderBy 미지정 시 PK 기본값
  - `BaseRepository.findWithCursor(option)` 위임 메서드
  - 30개 유닛 테스트

- **쿼리 타임아웃** (`3641c79`)
  - `DatabaseClientOptions.queryTimeout?: number` — connection-level 기본 타임아웃
  - `FindOption.timeout?: number` — per-query 타임아웃
  - `ISqlDriver.setQueryTimeout(ms): string` — 드라이버별 SET 문 생성
    - MySQL: `SET SESSION max_execution_time = N`
    - PostgreSQL: `SET LOCAL statement_timeout = 'Nms'`
    - SQLite: `PRAGMA busy_timeout = N`
    - MSSQL: `SET LOCK_TIMEOUT N`
  - `QueryTimeoutError` + `OrmErrorCode.QUERY_TIMEOUT`
  - 25개 유닛 테스트

- **한국어 문서화** (`aae2983`)
  - `docs/` 폴더 신규 생성, 10개 파일
  - getting-started, entities, relations, entity-manager, query-builder, transactions, migrations, advanced, multi-tenancy

- **N+1 쿼리 감지 및 슬로우 쿼리 경고** (`935c1ee`)
  - `QueryTracker`: 쿼리 이력 추적 (엔티티명, SQL, 실행시간, 타임스탬프)
  - N+1 감지: 동일 엔티티 100ms 내 10회+ → `[N+1 WARNING]` 경고
  - 슬로우 쿼리: `slowQueryMs` 초과 시 `[SLOW QUERY] 245ms: ...` 경고
  - `DatabaseClientOptions.logging`: `queries?`, `slowQueryMs?`, `nPlusOne?` 확장
  - `EntityManager.getQueryLog()` 쿼리 로그 반환
  - 23개 유닛 테스트

- **통합 테스트 인프라 및 테스트 파일** (`3b0aaa6`, `ee32fe4`)
  - `__tests__/integration/helpers/`: test-connection, create-test-entity, create-relation-entity
  - `crud-basic.test.ts`, `relations-one-to-many.test.ts`
  - `soft-delete.test.ts`, `aggregate.test.ts`, `batch-operations.test.ts`
  - `lifecycle-hooks.test.ts`, `one-to-one.test.ts`
  - INTEGRATION_TEST 환경변수 기반 skip 처리

### Fixed

- **`makeManyTones()` 오타 수정** (`d908034`)
  - `ManyToOneScanner.makeManyTones` → `makeManyToOnes`

- **Eager load LEFT JOIN 순서 버그** (`1d8356b`)
  - `find()`에서 WHERE/ORDER BY 뒤에 LEFT JOIN이 붙던 문제 수정
  - `SELECT ... FROM t LEFT JOIN ... WHERE ...` 올바른 순서로 변경
  - MariaDB SQL syntax 에러 해결

- **@BeforeInsert 뮤테이션 미반영** (`3cef629`)
  - `save()`에서 columns/values가 훅 실행 전에 추출되던 문제 수정
  - 훅 실행 후 엔티티 최신 값을 INSERT SQL에 반영

- **@OneToOne eager load 결과 undefined** (`3cef629`)
  - `ResultTransformer.transformNested()`가 `ONE_TO_ONE_TOKEN` 미처리 문제 수정
  - OneToOne도 ManyToOne과 동일한 alias 패턴으로 처리

- **null FK LEFT JOIN 결과 null 미처리** (`3cef629`)
  - LEFT JOIN 미매칭 시 모든 컬럼 NULL인 객체를 `null`로 올바르게 처리

---

## 테스트 현황

| 시점 | 테스트 수 |
|------|----------|
| SQLite 드라이버 추가 후 | 363 |
| Eager 로딩 추가 후 | 370 |
| 마이그레이션 시스템 후 | 415 |
| @ManyToMany 후 | 427 |
| Cascade + Lazy 로딩 후 | 496 |
| Soft Delete 추가 후 | 540 |
| 세션 시작 (2026-02-22) | **691** |
| 이벤트 시스템 + Select 컬럼 + Raw Query 제네릭 | 721 |
| 복합 PK + MSSQL + 쿼리 캐싱 + 타입 강화 | 813 |
| EntitySubscriber | 906 |
| N+1 감지 시스템 | 929 |
| 통합 테스트 5개 파일 추가 | **1059** |
| 쿼리 타임아웃 + 커서 페이지네이션 + 한국어 문서 | 1163 |
| EXPLAIN 쿼리 + 신기능 통합 테스트 추가 | **1163** (전부 통과) |
| OneToMany/ManyToOne 관계 통합 테스트 추가 | 1163+ |

---

## 이전 릴리스

### 내실 다지기 이전 (주요 기능)

- **Soft Delete** — `@DeletedAt`, softDelete/restore, withDeleted 옵션
- **Cascade 옵션** — CascadeType, cascadeSaveOneToMany/ManyToOne/Delete
- **Lazy 로딩** — Proxy 기반 LazyLoader, `@ManyToOne lazy: true`
- **마이그레이션 시스템 + CLI** — Migration/MigrationRunner, migrate:run/rollback/status
- **`@ManyToMany` 관계** — JoinTable, ManyToManyScanner
- **연결 풀링 (PoolOptions)** — max/min/acquireTimeoutMs/idleTimeoutMs
- **Schema Generation** — syncSchema/createTable DDL 자동 생성
- **`@OneToOne` 관계** — 단방향/양방향, eager 지원
- **배치 연산** — insertMany/saveMany/deleteMany
- **유효성 검사 데코레이터** — @NotNull, @MinLength, @MaxLength, @Min, @Max
- **Entity 생명주기 훅** — @BeforeInsert/Update/Delete, @AfterInsert/Update/Delete
- **Aggregate 쿼리** — count/sum/avg/min/max
- **@Transactional 데코레이터** — AsyncLocalStorage 기반
- **Query Builder WHERE 개선** — andWhere/orWhere/whereIn/whereNotIn/whereNull/whereNotNull/whereBetween

### 멀티테넌시 & 코어

- **레이어드 메타데이터** (`26ff198`, `289d2cf`, `59cdb08`)
  - Docker OverlayFS 방식의 Public/Tenant 레이어
  - `withTenant(tenantId, callback)` API
  - `AsyncLocalStorage` 기반 컨텍스트 전환

- **PostgreSQL 지원** (`347ec72`)
  - `PostgresDriver`, `PostgresConnector`, `PostgresDataSource`
  - 스키마 한정 식별자 (`schema.table`)
  - ENUM 타입 지원

- **SQL Injection 방지** (`530b748`)
  - `wrapIdentifier()` 강제화
  - operator 화이트리스트
  - DDL 식별자 escape

- **`DeserializerRegistry`** (`6fa2c9f`)
  - 플러거블 역직렬화 전략 패턴
