# Stingerloom ORM - Project Context

## 프로젝트 개요

TypeScript 기반의 ORM으로, PostgreSQL/MySQL을 지원하며 Docker OverlayFS 방식의 **레이어드 메타데이터 시스템**을 통해 멀티테넌시를 지원합니다.

- **패키지명:** `stingerloom-orm` (v0.1.0)
- **패키지 매니저:** pnpm
- **npm 배포 상태:** 미배포 → examples 실행 전 반드시 `pnpm build` 필요
- **진입점:** `dist/index.js` / `dist/index.d.ts`

---

## 디렉토리 구조

```
/
├── src/
│   ├── core/               # EntityManager, BaseRepository, QueryBuilder, Deserializer,
│   │                       # SchemaGenerator, SchemaDiff, EntitySubscriber, QueryTracker
│   ├── decorators/         # @Entity, @Column, @ManyToOne, @Index, @Version, @UniqueIndex,
│   │                       # @InjectRepository, @Transactional, @Hooks, @Validation 등
│   ├── dialects/
│   │   ├── mysql/          # MySqlDriver, MySqlConnector, MySqlDataSource, MySqlTenantMigrationRunner
│   │   ├── postgres/       # PostgresDriver, PostgresConnector, PostgresDataSource, PostgresTenantMigrationRunner
│   │   ├── sqlite/         # SqliteDriver, SqliteConnector, SqliteDataSource
│   │   └── mssql/          # MssqlDriver, MssqlConnector, MssqlDataSource
│   ├── metadata/           # LayeredMetadataStore, MetadataLayer, MetadataContext (AsyncLocalStorage)
│   ├── scanner/            # EntityScanner, ColumnScanner, ManyToOneScanner
│   ├── migration/          # MigrationRunner, MigrationGenerator
│   ├── types/              # ColumnType enum, 공통 타입
│   ├── utils/              # ReflectManager, Logger
│   └── errors/             # OrmError, OrmErrorCode, 커스텀 에러 클래스들
├── __tests__/
│   ├── unit/               # 72+ 유닛 테스트 파일
│   └── integration/        # 통합 테스트 (INTEGRATION_TEST=true 필요)
├── examples/
│   ├── nestjs-cats/        # NestJS 기본 예제 (CRUD, EntitySubscriber, cursor pagination)
│   ├── nestjs-blog/        # NestJS 블로그 예제 (M2M, soft delete, upsert, 59 e2e tests)
│   └── nestjs-multitenant/ # NestJS 멀티테넌시 예제 (PostgreSQL 스키마 격리)
├── docs/                   # 한국어 문서 (12개 파일)
├── .claude/agents/         # 에이전트 전문가 정의 (5개)
├── dist/                   # 빌드 결과물 (gitignored)
├── package.json
├── tsconfig.json
└── jest.config.js
```

---

## 핵심 아키텍처

### 1. 레이어드 메타데이터 시스템 (멀티테넌시)

Docker OverlayFS와 동일한 개념:
- **Public Layer (하위):** 기본 스키마 (모든 엔티티 포함, 읽기 전용)
- **Tenant Layer (상위):** 테넌트별 수정 사항 (Copy-on-Write)
- **Context Switching:** `MetadataContext.run(tenantId, callback)` (AsyncLocalStorage 기반)
- **Fallback:** 테넌트 레이어에 없으면 Public Layer에서 조회
- **동시성 안전:** `resolveContext()`가 AsyncLocalStorage 우선 조회 → 인스턴스 상태 fallback

관련 파일: `src/metadata/LayeredMetadataStore.ts`, `MetadataLayer.ts`, `MetadataLayerRegistry.ts`, `MetadataContext.ts`

**중요:**
- 메타데이터는 전역 싱글톤이 아니라 레이어 기반으로 격리되어야 함
- 프로덕션 코드에서 `setContext()` 사용 금지 (deprecated) → `MetadataContext.run()` 사용
- `getAllInContext()`는 public + 대상 컨텍스트 레이어만 병합 (다른 테넌트 데이터 격리)

### 2. 드라이버/다이얼렉트 추상화

**인터페이스:** `src/dialects/SqlDriver.ts` (`ISqlDriver`)

구현 드라이버:
| 드라이버 | 식별자 래핑 | PK 생성 | 스키마 지원 |
|---------|------------|---------|------------|
| MySQL | 백틱 (`) | AUTO_INCREMENT | 미지원 |
| PostgreSQL | 큰따옴표 (") | SERIAL / RETURNING | 지원 (schema.table) |
| SQLite | 큰따옴표 (") | INTEGER PRIMARY KEY | 미지원 |
| MSSQL | 대괄호 ([]) | IDENTITY | 지원 (schema.table) |

새 드라이버 작성 시 `ISqlDriver` 인터페이스 완전 구현 필수.

**SQL Injection 방지 원칙:**
- 사용자 입력 값은 반드시 파라미터 바인딩 사용 (`sql-template-tag` 활용)
- 테이블명/컬럼명은 `escapeIdentifier()` 메서드로 래핑
- DDL 쿼리에서도 모든 식별자는 드라이버별 escape 처리

### 3. ColumnType 매핑

```typescript
// src/types/ColumnType.ts
type ColumnType = "varchar" | "int" | "boolean" | "datetime" | "timestamp"
                | "text" | "blob" | "json" | "number" | "float" | "enum";
```

각 드라이버에서 `castType(type: ColumnType): string` 메서드로 DB별 타입으로 변환.

### 4. 트랜잭션 관리

모든 쿼리는 자동으로 트랜잭션으로 래핑됨:
1. `TransactionSessionManager` 생성
2. DB 연결
3. `START TRANSACTION` (MySQL) / `BEGIN` (PostgreSQL)
4. 쿼리 실행
5. `COMMIT` 또는 에러 시 `ROLLBACK`

관련 파일: `src/dialects/TransactionSessionManager.ts`

### 5. 데코레이터 메타데이터 시스템

```typescript
@Entity()           // ENTITY_TOKEN 심볼로 메타데이터 저장
@Column(options)    // design:type 자동 추론, ColumnType 매핑
@PrimaryGeneratedColumn()
@ManyToOne(() => Entity, { joinColumn: "fk_column" })
@Index()
@Version()
```

스캐너 체계: `EntityScanner` → `ColumnScanner` → `ManyToOneScanner` (TypeDI @Service)

---

## 개발 워크플로우

### 빌드
```bash
pnpm build          # dist/ 생성 (예제 실행 전 필수)
```

### 테스트
```bash
pnpm test           # Jest 전체 테스트 실행
pnpm test -- --testPathPattern="<패턴>"  # 특정 테스트
```

### 예제 실행
```bash
pnpm build          # 먼저 빌드
cd examples/nestjs-cats
pnpm install
pnpm start          # NestJS 서버 시작
```

---

## 테스트 구조

### 유닛 테스트 (`__tests__/unit/`)
72+ 파일, 1,405개 테스트 (2026-02-27 기준, 모두 통과)
주요 파일: layered-metadata, metadata-context, metadata-layer-registry, schema-generator, entity-subscriber, read-replica, cursor-pagination, explain-query, find-where-falsy-values, schema-diff, upsert, coverage-edge-cases 등

### 통합 테스트 (`__tests__/integration/`)
- `INTEGRATION_TEST=true` 환경변수 필요 (MySQL/PostgreSQL 실제 연결)
- `multi-tenancy-postgres.test.ts` — PostgreSQL 스키마 기반 멀티테넌시 (22개)
- `crud-basic`, `relations-one-to-many`, `soft-delete`, `aggregate`, `batch-operations`, `lifecycle-hooks`, `one-to-one`, `many-to-many`, `schema-generator`, `entity-subscriber`, `upsert`

### e2e 테스트 (`examples/`)
- `examples/nestjs-cats/` — NestJS 기본 예제 (EntitySubscriber, cursor pagination)
- `examples/nestjs-blog/` — NestJS 블로그 예제 (59 e2e tests, M2M, soft delete, upsert)
- `examples/nestjs-multitenant/` — PostgreSQL 멀티테넌시 예제 (TenantMigrationRunner)

---

## 핵심 의존성

| 패키지 | 용도 |
|-------|-----|
| `reflect-metadata` | 데코레이터 메타데이터 반영 |
| `mysql2` | MySQL 드라이버 |
| `pg` | PostgreSQL 드라이버 |
| `class-transformer` | 객체 직렬화/역직렬화 |
| `typedi` | 의존성 주입 (스캐너 등록) |
| `sql-template-tag` | 파라미터화된 SQL 쿼리 빌드 |

---

## 현재 구현 상태

### 완료 (전체)
- CRUD (Create, Read, Update, Delete)
- 관계: @ManyToOne, @OneToMany, @ManyToMany, @OneToOne
- Eager / Lazy 로딩
- 트랜잭션 (@Transactional, 격리 수준, Savepoint)
- MySQL / PostgreSQL / SQLite / MSSQL 드라이버
- PostgreSQL ENUM 타입, 스키마 한정 식별자
- DeserializerRegistry, NestJS 통합 (@InjectRepository, @InjectEntityManager)
- 마이그레이션 시스템 + CLI
- 연결 풀링 (PoolOptions)
- Schema Generation (syncSchema/DDL)
- Soft Delete (@DeletedAt), Cascade, Batch 연산
- 유효성 검사 데코레이터, 생명주기 훅
- Aggregate (count/sum/avg/min/max)
- Query Builder DSL (JOIN/WHERE/GROUP BY/HAVING)
- 이벤트 시스템, EntitySubscriber 패턴
- N+1 감지 + 슬로우 쿼리 경고 (QueryTracker)
- 커서 기반 페이지네이션 (findWithCursor)
- findAndCount() — `[T[], count]` 원자적 반환
- Upsert (INSERT ON CONFLICT / ON DUPLICATE KEY)
- @UniqueIndex 복합 고유 인덱스
- EXPLAIN 쿼리 (ExplainResult 타입)
- 쿼리 타임아웃 (per-query / connection-level)
- Read Replica (읽기/쓰기 분리)
- 복합 PK (@PrimaryColumn)
- Raw Query 제네릭 + Connection Retry
- 멀티테넌시 레이어드 메타데이터 + AsyncLocalStorage 동시성 안전
- TenantMigrationRunner (PostgreSQL 스키마 기반 자동 프로비저닝)
- Schema Diff 기반 Migration 자동 생성 (SchemaDiff + SchemaDiffMigrationGenerator)
- ManyToMany 중간 테이블 DDL 자동 생성
- 멀티 DB 지원 (named connections)
- propagateShutdown() — 리소스 정리 라이프사이클
- 한국어 문서 (docs/ 12개 파일: api-reference, configuration 포함)
- SQL Injection 전 드라이버 감사 완료 (2026-02-27)

### 현재 안정성 상태 (2026-02-27 기준)
- **테스트:** 1,405 passed, 26 skipped (integration), 0 failures
- **예제:** 3개 프로젝트 (nestjs-cats, nestjs-blog, nestjs-multitenant) 타입 체크 통과
- **보안:** SQL Injection 취약점 6건 수정, 전 드라이버 감사 완료
- **격리:** 테넌트 간 메타데이터 유출 차단, AsyncLocalStorage 동시성 안전 확보

---

## 팀 역할 분담

에이전트 정의: `.claude/agents/*.md` (Claude Code 팀 시스템 사용)

### dialect-engineer (다이얼렉트 엔지니어)
- DB 드라이버 구현/유지 (MySQL, PostgreSQL, SQLite, MSSQL)
- SQL Injection 방지 감사 및 수정
- `ISqlDriver` 인터페이스 준수, 파라미터 바인딩 검증

### test-engineer (테스트 엔지니어)
- 유닛/통합 테스트 작성 (`__tests__/`)
- 회귀 테스트, 엣지 케이스 커버리지 확보
- 테스트 건강성 유지 (0 failures 보장)

### arch-reviewer (아키텍처 리뷰어)
- 레이어드 메타데이터 원칙 준수 검토
- AsyncLocalStorage 동시성 안전성 감사
- 성능, 메모리 누수, 타입 안전성 검토

### docs-expert (문서 전문가) — **model: sonnet**
- 프로덕션 품질 문서 작성 (API 레퍼런스, 가이드, 튜토리얼)
- 소스코드-문서 일치 검증
- 한국어 주, 영어 기술 용어 병기

### example-tester (예제 통합 테스터)
- 예제 3개 프로젝트 타입 체크 (`tsc --noEmit`)
- 빌드 검증, e2e 테스트 유지
- ORM API 변경 시 예제 동기화

---

## 코딩 컨벤션

- **식별자 escape:** 드라이버의 `wrapIdentifier()` 또는 `escapeIdentifier()` 반드시 사용
- **파라미터 바인딩:** 사용자 값은 `sql-template-tag`의 템플릿 리터럴 사용
- **메타데이터 격리:** 전역 상태 사용 금지, 레이어를 통한 접근만 허용
- **동시성 안전:** `setContext()` 대신 `MetadataContext.run()` 사용 (프로덕션 코드)
- **TypeScript strict:** strict 모드 활성화, any 타입 사용 자제
- **경로 별칭:** `@/` → `src/` (tsconfig paths)

---

## 중요 파일 위치

| 파일 | 설명 |
|-----|-----|
| `src/dialects/SqlDriver.ts` | ISqlDriver 인터페이스 |
| `src/dialects/mysql/MySqlDriver.ts` | MySQL 드라이버 구현 |
| `src/dialects/postgres/PostgresDriver.ts` | PostgreSQL 드라이버 구현 |
| `src/metadata/LayeredMetadataStore.ts` | 레이어드 메타데이터 핵심 |
| `src/core/EntityManager.ts` | 엔티티 매니저 (CRUD 진입점) |
| `src/core/RawQueryBuilder.ts` | SQL 쿼리 빌더 |
| `src/core/BaseRepository.ts` | 기본 리포지토리 패턴 |
| `src/DatabaseClient.ts` | DB 연결 싱글톤 |
| `src/core/SchemaDiff.ts` | 스키마 비교 (마이그레이션 자동 생성) |
| `src/core/SchemaDiffMigrationGenerator.ts` | Schema Diff → Migration 파일 생성 |
| `src/core/QueryTracker.ts` | N+1 감지 + 슬로우 쿼리 추적 |
| `src/dialects/ReplicationRouter.ts` | Read Replica 라우팅 |
| `src/dialects/ITenantMigrationRunner.ts` | 테넌트 마이그레이션 인터페이스 |
| `src/dialects/postgres/PostgresTenantMigrationRunner.ts` | PostgreSQL 스키마 기반 테넌트 마이그레이션 |
| `src/index.ts` | 패키지 공개 API 진입점 |
