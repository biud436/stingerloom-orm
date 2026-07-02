# Stingerloom ORM - Project Context

## 프로젝트 개요

TypeScript 기반의 ORM으로, PostgreSQL/MySQL/SQLite를 지원하며 Docker OverlayFS 방식의 **레이어드 메타데이터 시스템**을 통해 멀티테넌시를 지원합니다.

- **패키지명:** `@stingerloom/orm` (v1.0.0)
- **패키지 매니저:** pnpm
- **npm 배포:** https://www.npmjs.com/package/@stingerloom/orm
- **진입점:** `dist/index.js` (CJS) / `dist/esm/index.js` (ESM) / `dist/index.d.ts`
- **서브패스:** `@stingerloom/orm/nestjs`, `@stingerloom/orm/prisma-import`
- **CLI:** `stingerloom` (마이그레이션), `stingerloom-prisma-import` (Prisma 스키마 변환)

---

## 디렉토리 구조

```
/
├── src/
│   ├── core/                   # EntityManager, BaseRepository, SelectQueryBuilder,
│   │   │                       # RawQueryBuilder, SchemaRegistrar, QueryTracker,
│   │   │                       # CascadeHandler, RelationLoader, ResultTransformer
│   │   ├── generators/         # SchemaGenerator, SchemaDiff, SchemaDiffMigrationGenerator,
│   │   │                       # NamingStrategy, SnakeNamingStrategy
│   │   ├── deserializer/       # ClassTransformerDeserializer, DeserializerRegistry
│   │   └── plugin/             # StingerloomPlugin, WriteBuffer (Unit of Work)
│   ├── decorators/             # @Entity, @Column, @ComputedColumn, @ManyToOne, @OneToMany,
│   │                           # @ManyToMany, @OneToOne, @Index, @UniqueIndex, @FullTextIndex,
│   │                           # @Version, @CreateTimestamp, @UpdateTimestamp, @DeletedAt,
│   │                           # @InjectRepository, @InjectEntityManager, @Transactional,
│   │                           # @Hooks, @Validation, @PrimaryColumn, @PrimaryGeneratedColumn
│   ├── dialects/
│   │   ├── mysql/              # MySqlDriver, MySqlConnector, MySqlDataSource, MySqlTenantMigrationRunner
│   │   ├── postgres/           # PostgresDriver, PostgresConnector, PostgresDataSource, PostgresTenantMigrationRunner
│   │   ├── sqlite/             # SqliteDriver, SqliteConnector, SqliteDataSource, SqliteTenantMigrationRunner
│   │   ├── SqlDriver.ts        # ISqlDriver 인터페이스
│   │   ├── FindOption.ts       # 쿼리 옵션 인터페이스
│   │   ├── TransactionSessionManager.ts
│   │   ├── ReplicationRouter.ts
│   │   └── ConnectionLeakDetector.ts
│   ├── metadata/               # LayeredMetadataStore, MetadataLayer, MetadataContext,
│   │                           # MultiTenantMetadataManager (AsyncLocalStorage 기반)
│   ├── scanner/                # EntityScanner, ColumnScanner, ManyToOneScanner 등 (TypeDI @Service)
│   ├── migration/              # MigrationRunner, Migration, MigrationCli, cli-entry
│   ├── seeding/                # Seeder, SeederRunner
│   ├── introspection/          # IntrospectionGenerator, EntityCodeBuilder, TypeMapper
│   ├── schema/                 # defineEntity 코드 우선 빌더 (t 필드 빌더, InferEntity),
│   │                           # EntitySchema (데코레이터 없는 엔티티 정의)
│   ├── integration/
│   │   ├── nestjs/             # StingerloomOrmModule, @InjectRepository, @InjectEntityManager
│   │   └── prisma-import/      # PrismaImporter, TypeMapper, RelationResolver
│   ├── types/                  # ColumnType, CascadeType, ReferentialAction, DeepPartial 등
│   ├── utils/                  # Logger, ReflectManager, uuid-v7, camelToSnakeCase 등
│   └── errors/                 # OrmError, OrmErrorCode + 16개 커스텀 에러 클래스
├── __tests__/
│   ├── unit/                   # 277개 유닛 테스트 파일 (5,332 tests)
│   └── integration/            # 88개 통합 테스트 파일 (sqlite/ 포함, INTEGRATION_TEST=true 필요)
├── examples/
│   ├── nestjs-cats/            # NestJS 기본 예제 (CRUD, EntitySubscriber, cursor pagination)
│   ├── nestjs-blog/            # NestJS 블로그 예제 (M2M, soft delete, upsert, 59 e2e tests)
│   ├── nestjs-linear-clone/    # Linear/Jira식 이슈 트래커 (재귀 CTE, 윈도 함수, SKIP LOCKED 큐)
│   ├── nestjs-multitenant/     # NestJS 멀티테넌시 예제 (PostgreSQL 스키마 격리)
│   ├── nestjs-todo/            # NestJS 최소 CRUD 예제
│   ├── nestjs-todo-sqlite/     # NestJS SQLite 예제
│   └── prisma-import-demo/     # Prisma 스키마 → Stingerloom 마이그레이션 예제
├── mcp/                        # MCP 서버 (MySQL, PostgreSQL 직접 접근)
├── docs/                       # 영어 문서 (50개 파일)
│   └── ko/                     # 한국어 문서 (47개 파일)
├── .claude/agents/             # 에이전트 전문가 정의 (5개)
├── dist/                       # 빌드 결과물 (gitignored)
├── package.json
├── tsconfig.json               # CJS 빌드
├── tsconfig.esm.json           # ESM 빌드
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

관련 파일: `src/metadata/LayeredMetadataStore.ts`, `MetadataLayer.ts`, `MetadataContext.ts`, `MultiTenantMetadataManager.ts`

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

새 드라이버 작성 시 `ISqlDriver` 인터페이스 완전 구현 필수.

**SQL Injection 방지 원칙:**
- 사용자 입력 값은 반드시 파라미터 바인딩 사용 (`sql-template-tag` 활용)
- 테이블명/컬럼명은 `escapeIdentifier()` 메서드로 래핑
- DDL 쿼리에서도 모든 식별자는 드라이버별 escape 처리

### 3. ColumnType 매핑

```typescript
type ColumnType = "varchar" | "int" | "number" | "float" | "double" | "bigint"
                | "boolean" | "datetime" | "timestamp" | "timestamptz" | "date"
                | "text" | "longtext" | "blob" | "char"
                | "json" | "jsonb" | "enum" | "array" | "uuid";
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

### 5. Synchronize 모드

| 모드 | CREATE | ADD | ALTER | DROP | RENAME |
|------|--------|-----|-------|------|--------|
| `true` | O | O | O | O | O |
| `"safe"` | O | O | X | X | X |
| `"dry-run"` | 로그만 | 로그만 | 로그만 | 로그만 | 로그만 |
| `false` | X | X | X | X | X |

**옵션 객체 폼** (Issue #331): 단일 값에 묶여 있던 *복원력 / 파괴적 변경 안전성 / DDL 가시성* 세 관심사를 분리.
```ts
synchronize: {
  mode: true | "safe" | "dry-run",
  continueOnError: boolean,        // false → DDL 실패 시 부팅 중단 (default: true)
  failOnDestructiveChange: boolean, // true → DROP / 좁히는 ALTER throw (default: false)
  logDDL: boolean,                  // true → 모든 DDL을 info 로그 (default: false)
}
```
- 단일 값 폼(`true`, `"safe"`, `"dry-run"`, `false`)은 backward-compatible — 위 기본값으로 정규화됨
- 정규화: `normalizeSynchronizePolicy()` → `SynchronizePolicy` (싱글 truth)
- 에러 코드: `OrmErrorCode.SCHEMA_SYNC_FAILED`, `SCHEMA_SYNC_DESTRUCTIVE_CHANGE`

관련 파일: `src/core/SchemaRegistrar.ts` (`applySchemaDiff()`, `handleDdlError()`, `assertDestructiveAllowed()`), `src/core/DatabaseClientOptions.ts` (`SynchronizeOption`, `normalizeSynchronizePolicy()`), `src/core/generators/SchemaDiff.ts`

### 6. NamingStrategy

플러그인 방식의 네이밍 전략:
- `NamingStrategy` 인터페이스: `tableName()`, `columnName()`, `joinColumnName()`
- `SnakeNamingStrategy`: camelCase → snake_case 자동 변환
- `ResultTransformer`에서 DB 컬럼명 → 엔티티 속성명 역매핑
- SELECT, INSERT, UPDATE, DELETE, soft-delete, restore 전 연산에 적용

관련 파일: `src/core/generators/NamingStrategy.ts`, `src/core/generators/SnakeNamingStrategy.ts`

### 7. 데코레이터 메타데이터 시스템

```typescript
@Entity()                    // ENTITY_TOKEN 심볼로 메타데이터 저장
@Column(options)             // design:type 자동 추론, ColumnType 매핑
@ComputedColumn(expr)        // 계산 컬럼
@PrimaryGeneratedColumn()    // auto-increment 또는 "uuid" (UUIDv7)
@PrimaryColumn()             // 복합 PK
@ManyToOne(() => Entity, { joinColumn: "fk_column" })
@OneToMany(() => Entity, entity => entity.fk)
@ManyToMany(() => Entity)
@OneToOne(() => Entity)
@Index()
@UniqueIndex()
@FullTextIndex()
@Version()                   // 낙관적 잠금
@CreateTimestamp()            // INSERT 시 자동 시각 설정
@UpdateTimestamp()            // INSERT/UPDATE 시 자동 시각 설정
@DeletedAt()                 // Soft Delete
@Hooks()                     // 생명주기 훅
@Validation()                // 유효성 검사
@Transactional()             // 트랜잭션 데코레이터
@InjectRepository(Entity)    // NestJS 리포지토리 주입
@InjectEntityManager()       // NestJS EntityManager 주입
```

스캐너 체계: `EntityScanner` → `ColumnScanner` → `ManyToOneScanner` → `OneToManyScanner` → `ManyToManyScanner` → `OneToOneScanner` (TypeDI @Service)

### 8. 플러그인 시스템

```typescript
em.extend(myPlugin)  // dayjs-style 플러그인 등록
```

- `StingerloomPlugin` 인터페이스 + `PluginContext`
- 의존성/충돌 검증, LIFO shutdown
- 내장 플러그인: `bufferPlugin()` (WriteBuffer / Unit of Work)

---

## 개발 워크플로우

### 빌드
```bash
pnpm build          # dist/ 생성 (CJS + ESM)
```

### 테스트
```bash
pnpm test           # Jest 전체 테스트 실행
pnpm test -- --testPathPattern="<패턴>"  # 특정 테스트
```

### 문서 개발
```bash
pnpm docs:dev       # VitePress 개발 서버
pnpm docs:build     # 프로덕션 빌드
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
277개 파일, 5,332개 테스트 (2026-07-02 기준, 20 skipped, 0 failures)

### 통합 테스트 (`__tests__/integration/`)
88개 파일 (2026-07-02 기준, `INTEGRATION_TEST=true` 필요)
- MySQL/PostgreSQL 듀얼 드라이버: `crud-basic`, `relations-one-to-many`, `soft-delete`, `aggregate`, `batch-operations`, `lifecycle-hooks`, `one-to-one`, `many-to-many`, `schema-generator`, `entity-subscriber`, `upsert`, `complex-queries`
- PostgreSQL 전용: `postgres-driver.test.ts`, `postgres-driver-ddl.test.ts`, `multi-tenancy-postgres.test.ts`
- MySQL 전용: `mysql-driver-ddl.test.ts`
- SQLite (in-memory): `sqlite/` 46개 파일 (crud, relations, DDL, transactions, soft-delete, batch, hooks, queries 등)
- `snake-naming-strategy.test.ts` — NamingStrategy 통합 테스트

### e2e 테스트 (`examples/`)
- `examples/nestjs-cats/` — NestJS 기본 예제 (EntitySubscriber, cursor pagination)
- `examples/nestjs-blog/` — NestJS 블로그 예제 (59 e2e tests, M2M, soft delete, upsert)
- `examples/nestjs-linear-clone/` — 프로덕션급 SQL 패턴 예제 (재귀 CTE, 윈도 함수, FOR UPDATE SKIP LOCKED, 낙관적 잠금)
- `examples/nestjs-multitenant/` — PostgreSQL 멀티테넌시 예제 (TenantMigrationRunner)
- `examples/nestjs-todo/` — NestJS 최소 CRUD 예제

---

## 핵심 의존성

### 런타임 (dependencies)
| 패키지 | 용도 |
|-------|-----|
| `class-transformer` | 객체 직렬화/역직렬화 |
| `sql-template-tag` | 파라미터화된 SQL 쿼리 빌드 |
| `typedi` | 의존성 주입 (스캐너 등록) |

### 피어 (peerDependencies, 모두 optional)
| 패키지 | 용도 |
|-------|-----|
| `reflect-metadata` | 데코레이터 메타데이터 반영 |
| `mysql2` | MySQL 드라이버 |
| `pg` | PostgreSQL 드라이버 |
| `better-sqlite3` | SQLite 드라이버 |
| `@nestjs/common`, `@nestjs/core` | NestJS 통합 |
| `@mrleebo/prisma-ast` | Prisma 스키마 파싱 |
| `fast-glob` | 엔티티 glob 패턴 해석 |

---

## 현재 구현 상태

### 완료 (전체)
- CRUD (Create, Read, Update, Delete)
- 관계: @ManyToOne, @OneToMany, @ManyToMany, @OneToOne
- Eager / Lazy 로딩
- 트랜잭션 (@Transactional, 격리 수준, Savepoint, 데드락 재시도)
- MySQL / PostgreSQL / SQLite 드라이버
- PostgreSQL ENUM 타입 + ENUM 값 동기화, 스키마 한정 식별자
- NestJS 통합 (StingerloomOrmModule, @InjectRepository, @InjectEntityManager, multi-DB connectionName)
- 마이그레이션 시스템 + CLI (`npx stingerloom migrate:run|rollback|status|generate`)
- 연결 풀링 (PoolOptions), Connection Leak Detection
- Schema Generation (syncSchema/DDL) + Synchronize true/safe/dry-run 모드
- Soft Delete (@DeletedAt), Cascade, Batch 연산
- 유효성 검사 데코레이터, 생명주기 훅
- Aggregate (count/sum/avg/min/max)
- SelectQueryBuilder (getMany/getPartialMany/getRawMany, JOIN/WHERE/GROUP BY/HAVING)
- RawQueryBuilder (CTE, Window Functions, Set Operations)
- 이벤트 시스템, EntitySubscriber 패턴
- N+1 감지 + 슬로우 쿼리 경고 (QueryTracker)
- 커서 기반 페이지네이션 (findWithCursor)
- findAndCount() — `[T[], count]` 원자적 반환
- Upsert (INSERT ON CONFLICT / ON DUPLICATE KEY)
- @UniqueIndex 복합 고유 인덱스, @FullTextIndex
- EXPLAIN 쿼리 (ExplainResult 타입)
- 쿼리 타임아웃 (per-query / connection-level)
- Read Replica (읽기/쓰기 분리)
- 복합 PK (@PrimaryColumn)
- Raw Query 제네릭 + Connection Retry
- 멀티테넌시 레이어드 메타데이터 + AsyncLocalStorage 동시성 안전
- TenantMigrationRunner (PostgreSQL 스키마 기반 자동 프로비저닝)
- Schema Diff 기반 Migration 자동 생성 (SchemaDiff + SchemaDiffMigrationGenerator + 컬럼 리네임 감지)
- ManyToMany 중간 테이블 DDL 자동 생성
- 멀티 DB 지원 (named connections)
- propagateShutdown() — 리소스 정리 라이프사이클
- NamingStrategy (SnakeNamingStrategy 내장)
- UUID 컬럼 타입 + UUIDv7 지원
- 컬럼 트랜스포머 (@Column({ transformer }))
- 계산 컬럼 (@ComputedColumn)
- 플러그인 시스템 (em.extend(), WriteBuffer/UoW)
- 시딩 시스템 (Seeder, SeederRunner)
- 인트로스펙션 (DB 스키마 → 엔티티 클래스 자동 생성)
- EntitySchema (데코레이터 없는 엔티티 정의)
- defineEntity 코드 우선 빌더 (t 필드 빌더, InferEntity 타입 추론, 데코레이터 없는 생명주기 훅)
- Prisma 스키마 임포트
- stream() AsyncGenerator 기반 스트리밍
- distinct, DISTINCT ON (PostgreSQL)
- validate() / validateArray() 결과 검증 훅
- Dual CJS/ESM 빌드
- 영어 문서 (50페이지) + 한국어 문서 (47페이지)
- SQL Injection 전 드라이버 감사 완료
- WriteBuffer 1차 캐시 (PK findOne → Identity Map 히트 시 DB 스킵)
- SelectQueryBuilder 14개 생산성 메서드 (when, pipe, whereHas, whereInSubquery, applyScope 등)
- QueryDSL (qAlias) + Entity-aware JOIN + Relation-based auto-join
- 테넌트 프로비저닝 tableFilter 옵션
- @CreateTimestamp / @UpdateTimestamp 커스텀 타입 지원
- @RelationColumn 데코레이터
- exists() / findByPK() / findByPKs() / findOneOrFail()
- batchUpsert / streamBatch
- NOWAIT / SKIP LOCKED 잠금
- Index hints (MySQL / PostgreSQL)
- assertTenantContext() 테넌트 컨텍스트 경고

### 현재 안정성 상태 (v1.0.0, 2026-07-02 기준)
- **테스트:** 6,370 passed, 36 skipped, 0 failures — 유닛 5,312 (20 skipped) + SQLite 521 + PostgreSQL 537 (16 skipped) (2026-07-02 검증; MySQL은 서버 부재로 미실행, 직전 검증 411 passed / 17 skipped)
- **예제:** 7개 프로젝트 (nestjs-cats, nestjs-blog, nestjs-linear-clone, nestjs-multitenant, nestjs-todo, nestjs-todo-sqlite, prisma-import-demo) 타입 체크 통과 (2026-07-02 검증)
- **보안:** SQL Injection 취약점 수정 완료, 전 드라이버 감사 완료
- **격리:** 테넌트 간 메타데이터 유출 차단, AsyncLocalStorage 동시성 안전 확보

---

## 팀 역할 분담

에이전트 정의: `.claude/agents/*.md` (Claude Code 팀 시스템 사용)

### dialect-engineer (다이얼렉트 엔지니어)
- DB 드라이버 구현/유지 (MySQL, PostgreSQL, SQLite)
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
- 영어 주, 한국어 현지화

### example-tester (예제 통합 테스터)
- 예제 프로젝트 타입 체크 (`tsc --noEmit`)
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
| `src/index.ts` | 패키지 공개 API 진입점 |
| `src/core/EntityManager.ts` | 엔티티 매니저 (CRUD 진입점) |
| `src/core/BaseRepository.ts` | 기본 리포지토리 패턴 |
| `src/core/SelectQueryBuilder.ts` | DSL 쿼리 빌더 (getMany/getPartialMany/getRawMany) |
| `src/core/RawQueryBuilder.ts` | SQL 쿼리 빌더 (CTE, Window, Set Operations) |
| `src/core/SchemaRegistrar.ts` | 엔티티 등록 + synchronize 모드 적용 |
| `src/core/ResultTransformer.ts` | 결과 역직렬화 + NamingStrategy 역매핑 |
| `src/core/QueryTracker.ts` | N+1 감지 + 슬로우 쿼리 추적 |
| `src/core/generators/SchemaGenerator.ts` | DDL 생성 |
| `src/core/generators/SchemaDiff.ts` | 스키마 비교 (마이그레이션 자동 생성) |
| `src/core/generators/NamingStrategy.ts` | NamingStrategy 인터페이스 |
| `src/core/generators/SnakeNamingStrategy.ts` | camelCase → snake_case 변환 |
| `src/core/plugin/StingerloomPlugin.ts` | 플러그인 시스템 인터페이스 |
| `src/dialects/SqlDriver.ts` | ISqlDriver 인터페이스 |
| `src/dialects/mysql/MySqlDriver.ts` | MySQL 드라이버 구현 |
| `src/dialects/postgres/PostgresDriver.ts` | PostgreSQL 드라이버 구현 |
| `src/dialects/sqlite/SqliteDriver.ts` | SQLite 드라이버 구현 |
| `src/dialects/ReplicationRouter.ts` | Read Replica 라우팅 |
| `src/dialects/TransactionSessionManager.ts` | 트랜잭션 세션 관리 |
| `src/metadata/LayeredMetadataStore.ts` | 레이어드 메타데이터 핵심 |
| `src/metadata/MetadataContext.ts` | AsyncLocalStorage 기반 컨텍스트 |
| `src/integration/nestjs/index.ts` | NestJS 모듈 진입점 |
| `src/integration/prisma-import/index.ts` | Prisma 스키마 임포트 진입점 |
| `src/DatabaseClient.ts` | DB 연결 싱글톤 |
