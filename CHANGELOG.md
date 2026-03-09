# Changelog

All notable changes to this project are documented in this file.

Releases: https://github.com/biud436/stingerloom-orm/releases

---

## [0.2.1] — 2026-03-09

### Added

- **`@CreateTimestamp()` decorator** — Auto-set current time on INSERT (`DATETIME NOT NULL`)
- **`@UpdateTimestamp()` decorator** — Auto-set current time on INSERT and UPDATE (`DATETIME NOT NULL`)
- **`timestamptz` column type** — PostgreSQL `TIMESTAMPTZ` (MySQL: `DATETIME`, SQLite: `TEXT` fallback)

### Tests

- `@Column` 데코레이터 없는 속성이 DDL에서 제외되는지 검증 (유닛 6개 + 통합 1개)
- `@CreateTimestamp` / `@UpdateTimestamp` 유닛 8개 + 통합 3개
- `timestamptz` 유닛 6개 (3개 드라이버)

### Docs

- `docs/entities.md`: `@CreateTimestamp`/`@UpdateTimestamp` 섹션, `timestamptz` 타입 추가
- `docs/api-reference.md`: 데코레이터 테이블 및 ColumnType 정의 업데이트
- 전체 문서 및 예제 README 영어 번역

### Other

- `MetadataContext.isActive()` 단순화
- NestJS 예제를 `@stingerloom/orm/nestjs` subpath export로 전환
- `nestjs-todo`를 배포된 `@stingerloom/orm@^0.2.0`으로 전환

**Full Changelog**: https://github.com/biud436/stingerloom-orm/compare/v0.2.0...v0.2.1

---

## [0.2.0] — 2026-03-08

### Added

- **NestJS 통합 모듈 추출** (`@stingerloom/orm/nestjs`)
  - `StinglerloomOrmModule` — `forRoot()` / `forFeature()` 지원
  - `StingerloomOrmCoreModule` — EntityManager provider
  - `StinglerloomOrmService` — NestJS 생명주기 훅
  - `InjectRepository` — NestJS 전용 리포지토리 인젝션 데코레이터
  - `@nestjs/common`, `@nestjs/core` optional peer dependencies
  - `typesVersions` 필드 추가 (`moduleResolution: "node"` 호환)
  - 4개 예제 프로젝트에서 중복 16개 파일 삭제 (-729 lines)

**Full Changelog**: https://github.com/biud436/stingerloom-orm/compare/v0.1.2...v0.2.0

---

## [0.1.2] — 2026-03-07

### Added

- **nestjs-todo 예제** 추가
- README 설치 안내 업데이트

### Docs

- README 한국어 잔여 텍스트 영어로 수정

**Full Changelog**: https://github.com/biud436/stingerloom-orm/compare/v0.1.1...v0.1.2

---

## [0.1.1] — 2026-03-07

### Added

- **MCP 서버** — MySQL/PostgreSQL 직접 접근 (`mcp/mysql-server.ts`, `mcp/postgres-server.ts`)
- **IConnection 인터페이스** + 다이얼렉트별 커넥션 + 커넥션 누수 감지기
- **Advisory lock** + 중첩 트랜잭션 세이브포인트 전파
- **QueryTracker 메모리 누수 방지** + Graceful shutdown
- **Swagger UI + class-validator** 전 예제 프로젝트에 추가
- `{propertyName}Id` FK 자동 컨벤션 (`save()`, `insertMany()`)
- `@Column` 기반 FK 자동 감지 + `mappedBy`/`inverseSide` 타입 안전성
- `clear()` 메서드 + `insertMany` 타임스탬프 성능 개선

### Fixed

- ORM 안정성 점검 — `WhereClause<T>` 타입 통합, `as any` 28개 제거, `skip→limit` 버그 수정
- EntityManager async factory로 NestJS `onModuleInit` 순서 문제 해결
- Partial update 시 FK 보존 + `save()` 반환 타입 수정
- INSERT/UPDATE 시 ManyToOne FK 컬럼 중복 방지
- ManyToOne 관계가 명시적으로 null일 때 FK를 NULL로 설정
- `insertMany` @BeforeInsert 훅 + @DeletedAt 컬럼 제외
- `NotSupportedDatabaseTypeError` 에러 메시지 영어 통일

### Refactor

- MSSQL 드라이버 제거
- `Connection.ts`를 `core/`에서 `dialects/mysql/`로 이동
- Deserializer 관련 파일을 `core/deserializer/` 폴더로 이동
- `createLazyProxy` 함수 시그니처 단순화
- MCP 서버 `server.tool()` → `server.registerTool()` API 마이그레이션

### Tests

- PostgreSQL 드라이버 통합 테스트 35개
- FK object assignment 패턴 P0 통합 테스트
- nestjs-cats e2e 통합 테스트
- Jest 커버리지 설정 + SQLite 통합 테스트 + 스트레스 테스트

### Docs

- README 영어 리라이트 (minimal style)
- 프로덕션 운영 가이드 작성
- Onboarding 가이드 추가

### Security

- SQL Injection 취약점 6건 수정 (MySqlDriver 5, SchemaDiff 1)
- `getAllInContext()` 테넌트 간 데이터 유출 차단
- `AsyncLocalStorage` 동시성 안전 (`resolveContext()` 도입)

---

## [0.1.0] — 2026-03-07 (최초 npm 배포)

최초 배포. 2026-02-22 ~ 2026-03-07 개발 기간의 전체 기능 포함.

### Core

- **CRUD** — `EntityManager.find`, `findOne`, `findAndCount`, `save`, `delete`, `softDelete`, `restore`, `upsert`
- **Batch** — `insertMany`, `saveMany`, `deleteMany`
- **Aggregation** — `count`, `sum`, `avg`, `min`, `max`
- **Raw Query** — `query<T>(sql, params?)` 제네릭 메서드
- **BaseRepository** — 엔티티별 CRUD 래퍼

### Relations

- `@ManyToOne`, `@OneToMany`, `@OneToOne`, `@ManyToMany`
- Eager / Lazy 로딩
- Cascade (insert/update/delete)
- ManyToMany 중간 테이블 DDL 자동 생성

### Schema & Migrations

- `SchemaGenerator` — syncSchema/createTable DDL 자동 생성
- `SchemaDiff` + `SchemaDiffMigrationGenerator` — 스키마 비교 → 마이그레이션 자동 생성
- `MigrationRunner` + `MigrationCli` — migrate:run/rollback/status

### Decorators

- `@Entity`, `@Column`, `@PrimaryGeneratedColumn`, `@PrimaryColumn`
- `@Index`, `@UniqueIndex`, `@Version`, `@DeletedAt`
- `@BeforeInsert`, `@AfterInsert`, `@BeforeUpdate`, `@AfterUpdate`, `@BeforeDelete`, `@AfterDelete`
- `@NotNull`, `@MinLength`, `@MaxLength`, `@Min`, `@Max`
- `@Transactional` (AsyncLocalStorage 기반)

### Drivers

- **MySQL/MariaDB** — `MySqlDriver`, 연결 풀링, Read Replica
- **PostgreSQL** — `PostgresDriver`, 스키마 한정 식별자, ENUM 타입
- **SQLite** — `SqliteDriver`

### Multi-Tenancy

- 레이어드 메타데이터 (Docker OverlayFS 방식)
- `MetadataContext.run()` — AsyncLocalStorage 기반 컨텍스트 전환
- `TenantMigrationRunner` — PostgreSQL 스키마 기반 자동 프로비저닝

### Query Builder

- `RawQueryBuilderFactory` — SELECT/JOIN/WHERE/GROUP BY/HAVING/ORDER BY/LIMIT
- `FindOption<T>` — select, where, limit, take, orderBy, groupBy, having, relations, withDeleted, timeout, useMaster

### Advanced

- 커서 기반 페이지네이션 (`findWithCursor`)
- EXPLAIN 쿼리 분석 (`ExplainResult`)
- N+1 감지 + 슬로우 쿼리 경고 (`QueryTracker`)
- 이벤트 시스템 (`on`/`off`) + `EntitySubscriber` 패턴
- 연결 풀링 (`PoolOptions`)
- Connection Retry (지수 백오프)
- 쿼리 타임아웃 (per-query / connection-level)
- Read Replica (읽기/쓰기 분리)
- 멀티 DB 지원 (named connections)
- `propagateShutdown()` — 리소스 정리 생명주기
- SQL Injection 방지 — `escapeIdentifier()` + `sql-template-tag`

### Examples

- `examples/nestjs-cats` — 기본 CRUD, EntitySubscriber, 커서 페이지네이션
- `examples/nestjs-blog` — M2M, soft delete, upsert, 59 e2e tests
- `examples/nestjs-multitenant` — PostgreSQL 스키마 격리

### Tests

- 1,400+ 유닛 테스트, 0 failures
- 4개 예제 프로젝트 타입 체크 통과
