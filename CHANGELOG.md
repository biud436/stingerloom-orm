# Changelog

모든 주목할 만한 변경 사항은 이 파일에 기록됩니다.

## [Unreleased]

### Added
- **Cascade 옵션** (`36496bb`, `e38fd17`)
  - `CascadeType`: `"insert" | "update" | "remove"` 타입 정의
  - `@OneToMany`, `@ManyToOne` 데코레이터에 `cascade?: CascadeType[]` 옵션 추가
  - `EntityManager.save()`: `cascadeSaveOneToMany` — 자식 배열 자동 저장
  - `EntityManager.save()`: `cascadeSaveManyToOne` — 중첩 부모 엔티티 자동 저장
  - `EntityManager.delete()`: `cascadeDeleteOneToMany` — 부모 삭제 전 자식 자동 삭제

- **Lazy 로딩** (`e38fd17`)
  - `LazyLoader`: Proxy 기반 지연 로딩 유틸리티
  - `createLazyProxy<T>()` — 프로퍼티 첫 접근 시 DB 쿼리 실행
  - `injectLazyProxy()` — 엔티티 프로퍼티에 Proxy 주입
  - `isLazyProxy()` — Lazy proxy 여부 감지
  - `@ManyToOne` 옵션에 `lazy?: boolean` 추가

- **마이그레이션 CLI** (`27dd54b`)
  - `MigrationCli`: `migrate:run`, `migrate:rollback`, `migrate:status` 명령어
  - `DatabaseClientOptions` 기반 DB 연결 후 `MigrationRunner` 실행

- **마이그레이션 시스템** (`ab13a64`, `f05f657`)
  - `Migration` 추상 클래스 (`up()` / `down()` / `name`)
  - `MigrationRunner`:
    - `__migrations` 테이블 자동 생성
    - `run()` — 미실행 마이그레이션 순서대로 실행
    - `rollback(n?)` — 최근 n개 롤백
    - `status()` — 실행됨/미실행 목록 반환

- **`@ManyToMany` 관계** (`674504f`)
  - `@ManyToMany(() => Entity, options?)` 데코레이터
  - `JoinTableOption`: `{ name, joinColumn, inverseJoinColumn }` 중간 테이블 설정
  - `ManyToManyScanner`: LayeredMetadataStore 통합 스캐너
  - `EntityManager.find()`: `relations` 옵션에 ManyToMany 필드 포함 시 INNER JOIN

- **연결 풀링 (PoolOptions)** (`53ffd2d`)
  - `PoolOptions` 인터페이스: `max`, `min`, `acquireTimeoutMs`, `idleTimeoutMs`
  - `DatabaseClientOptions.pool?: PoolOptions`
  - `PostgresConnector`: 전체 pool 옵션 적용 (pg.Pool)
  - `MySqlConnector`: `pool.max` → `connectionLimit` 적용

- **SQLite 통합** (`53ffd2d`, `96c401c`)
  - `SqliteDriver`, `SqliteConnector`, `SqliteDataSource` 구현
  - `DatabaseClient`, `TransactionSessionManager`, `EntityManager.connect()`에 `"sqlite"` case 추가
  - 단일 연결 (풀 없음) 방식으로 동작

- **Eager 로딩** (`8a11723`)
  - `@ManyToOne` 옵션에 `eager?: boolean` 추가
  - `EntityManager.find()`: eager 관계 자동 LEFT JOIN
  - `findOption.relations` 배열로 명시적 eager 로딩

- **쿼리 빌더 DSL 확장** (`620ba1f`)
  - `leftJoin()`, `innerJoin()`, `rightJoin()` 편의 메서드
  - 독립적인 `offset(n)` 메서드

- **`@OneToMany` 관계** (`a45bd40`, `fa31498`)
  - `@OneToMany(() => Entity, { mappedBy })` 데코레이터
  - `OneToManyScanner`: 레이어드 메타데이터 스캐너
  - `EntityManager.find()`: `relations` 옵션에 OneToMany 필드 포함 시 서브쿼리 로딩

- **Delete 연산** (`2fb0e0f`)
  - `EntityManager.delete(entity, criteria)` — WHERE 조건 필수, 빈 조건 차단
  - `BaseRepository.delete(criteria)` — 리포지토리 패턴
  - `DeleteResult { affected: number }` 반환

---

## 테스트 현황

| 시점 | 테스트 수 |
|------|----------|
| SQLite 드라이버 추가 후 | 363 |
| Eager 로딩 추가 후 | 370 |
| 마이그레이션 시스템 후 | 415 |
| 연결 풀링 후 | 415 |
| @ManyToMany 후 | 427 |
| Cascade + Lazy 로딩 후 | **496** |

---

## 이전 릴리스

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

- **`MultiTenantMetadataManager` deprecated** (`0bba268`)
  - 전역 싱글톤 폐기 → 레이어 기반 접근 권장
