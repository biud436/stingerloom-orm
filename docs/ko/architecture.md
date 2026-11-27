# Architecture

`em.find()`나 `em.save()`를 쓰면서 내부에서 무슨 일이 일어나는지 궁금했다면 Stingerloom ORM의 내부 구조부터 살펴보세요. 그 전에 [Getting Started](./getting-started.md) 가이드를 읽기를 권합니다.

## 쿼리가 시스템을 통과하는 과정

아키텍처를 이해하는 가장 좋은 방법은 실제 쿼리를 따라가 보는 것입니다. 다음 코드를 작성했다고 해 보겠습니다.

```typescript
const users = await em.find(User, { where: { isActive: true }, relations: ["posts"] });
```

ORM 내부에서는 어떤 일이 일어날까요?

### Step 1: 엔티티 정의 조회

애플리케이션이 시작될 때 `User` 클래스의 `@Entity()`와 `@Column()` 데코레이터는 테이블 이름, 컬럼 목록, 관계 정의 같은 메타데이터를 메타데이터 저장소에 등록했습니다. 이제 ORM은 그 메타데이터를 다시 읽어야 합니다.

이 조회는 `RelationMetadataResolver` 모듈이 담당합니다. 이 모듈은 "`User`는 어느 테이블에 매핑되는가?", "ManyToOne 관계는 무엇인가?" 같은 질문에 답합니다.

### Step 2: SQL 빌드

쿼리 빌더는 메타데이터와 `FindOption`을 받아 파라미터화된 SQL 쿼리를 조립합니다. Stingerloom에는 쿼리 빌더가 두 가지 있습니다.

- **`RawQueryBuilder`**: 저수준의 자유 형식 SQL 빌더입니다. `find()`, `save()` 같은 EntityManager 메서드가 내부에서 사용합니다.
- **`SelectQueryBuilder`**: 타입 안전한 엔티티 기반 빌더입니다. `em.createQueryBuilder(User, "u")`로 생성합니다. 컬럼 이름에 `keyof T` 자동 완성을 제공합니다.

간단한 `find()` 호출이라면 ORM은 내부에서 `RawQueryBuilder`로 다음 SQL을 만듭니다.

```sql
SELECT "id", "name", "email" FROM "user" WHERE "isActive" = $1
```

여기서 중요한 일이 두 가지 일어납니다.

- `true` 같은 값은 SQL 문자열에 직접 들어가지 않습니다. 대신 `$1`, `$2` 같은 파라미터가 됩니다. 이렇게 해서 SQL 인젝션을 막습니다.
- 테이블 이름과 컬럼 이름은 데이터베이스 드라이버가 이스케이프합니다. MySQL은 `` `backticks` ``로 감싸고 PostgreSQL은 `"double quotes"`로 감쌉니다.

애플리케이션이 멀티테넌트 컨텍스트에서 실행 중이라면 `TenantQueryStrategy`가 테이블 이름을 바꿀 수 있습니다. `schema_qualified` 전략에서는 `"user"`가 `"acme_corp"."user"`가 됩니다. 기본 전략인 `search_path`에서는 테이블 이름을 그대로 둡니다. 대신 ORM이 트랜잭션 안에서 `search_path`를 설정합니다.

### Step 3: 실행 방식 결정

모든 쿼리에 트랜잭션이 필요한 것은 아닙니다. EntityManager는 다음 기준으로 판단합니다.

| 상황 | 동작 |
|------|------|
| `@Transactional` 내부에 이미 있을 때 | 기존 세션을 재사용합니다 |
| PostgreSQL 테넌트 + `search_path` 전략 | 트랜잭션으로 감쌉니다 (`SET LOCAL search_path`에 필요) |
| 쿼리에 타임아웃이 있을 때 (PostgreSQL) | 트랜잭션으로 감쌉니다 (`SET LOCAL statement_timeout`에 필요) |
| 그 외 모든 경우 (대부분의 읽기) | 경량 경로: connect, query, close. `BEGIN`/`COMMIT` 없음 |

이 기준에 따라 테넌트 컨텍스트 없이 단순한 `em.find(User)`를 실행하면 트랜잭션을 아예 건너뜁니다. 그만큼 네트워크 라운드 트립이 여러 번 줄어듭니다.

### Step 4: 결과 변환

데이터베이스는 `{ id: 1, name: "Alice", isActive: true }` 같은 raw 행을 반환합니다. ORM은 이 행을 제대로 된 `User` 인스턴스로 만들어야 합니다.

이 일은 `ResultTransformer`가 처리합니다. `ResultTransformer`는 행을 타입이 있는 객체로 역직렬화합니다. 그리고 JOIN 결과로 즉시 로딩 관계를 채웁니다. 지연 로딩 관계는 처음 접근할 때 데이터를 로드하는 프록시 객체로 감쌉니다.

### Step 5: 반환

결과로 타입이 완전히 지정된 `User[]` 배열을 받습니다. 관계는 채워져 있고 지연 로딩에 쓸 프록시도 준비되어 있습니다.

> 힌트: 쓰기 연산(`save`, `delete`, `upsert`)은 항상 트랜잭션 안에서 실행됩니다. 쓰기에는 경량 경로가 없습니다.

## 왜 코드가 모듈로 분리되어 있나요

ORM은 데이터베이스 연결, SQL 생성, 트랜잭션 관리, 관계 로딩, DDL 생성, 멀티테넌시 처리처럼 많은 일을 합니다. 이 모든 코드가 파일 하나에 있다면 읽을 수도 테스트할 수도 없습니다.

Stingerloom은 이런 관심사를 `src/` 아래 디렉토리로 나눕니다. 그리고 의존성은 아래 방향으로만 흐른다는 엄격한 규칙을 따릅니다. 하위 레이어는 절대 상위 레이어에서 import하지 않습니다.

| 레이어 | 디렉토리 | 역할 |
|--------|----------|------|
| Integration | `integration/` | ORM을 프레임워크(NestJS)에 연결합니다 |
| Core | `core/` | EntityManager와 핸들러: 핵심 로직입니다 |
| Connection | `DatabaseClient.ts` | 데이터베이스 연결을 보관하고 앱 전체에서 공유합니다 |
| Scanner | `scanner/` | `@Entity` / `@Column` 데코레이터를 읽어서 메타데이터 레지스트리를 구성합니다 |
| Decorators | `decorators/` | 데코레이터 함수 자체입니다 (`@Entity`, `@Column`, `@ManyToOne` 등) |
| Metadata | `metadata/` | 멀티테넌시를 뒷받침하는 레이어드 메타데이터 저장소입니다 |
| Dialects | `dialects/` | 데이터베이스별 코드: DB마다 하위 폴더가 있습니다 |
| Foundation | `types/`, `errors/`, `utils/` | 공유 타입, 에러 클래스, 로거입니다 |

레이어를 나누면 MySQL 관련 버그를 고칠 때 `src/dialects/mysql/`만 보면 됩니다. 새 데코레이터를 추가할 때는 `src/decorators/`와 `src/scanner/`에서 작업하면 됩니다. 이처럼 레이어가 변경 범위를 좁혀 줍니다.

## EntityManager는 모놀리스가 아니에요

처음 작성했을 때 EntityManager는 쿼리, 관계, cascade, 집계, 스키마 동기화를 모두 처리했습니다. 기능이 늘어나면서 EntityManager는 너무 커져 파악하기 어려워졌습니다.

그래서 각 책임을 **핸들러 클래스**(handler class)로 분리했습니다.

| Handler | 존재 이유 |
|---------|----------|
| `RelationMetadataResolver` | 메타데이터 읽기를 쿼리 실행에서 분리합니다 |
| `SchemaRegistrar` | DDL 생성을 런타임 쿼리에서 분리합니다 |
| `RelationLoader` | N+1 쿼리를 막는 배치 로딩 로직을 캡슐화합니다 |
| `CascadeHandler` | 재귀적인 cascade save/delete 로직을 격리합니다 |
| `AggregateQueryHandler` | COUNT/SUM/AVG/MIN/MAX에는 고유한 SQL 패턴이 있습니다 |
| `ExplainQueryHandler` | 데이터베이스마다 EXPLAIN 형식이 다릅니다 |
| `ReplicationManager` | 읽기 레플리카 라우팅은 쿼리 로직과 독립적입니다 |
| `TenantQueryStrategy` | 멀티테넌트 테이블 한정은 별도의 관심사입니다 |

모든 핸들러는 EntityManager 클래스가 아니라 `EntityManagerInternals` 인터페이스에 의존합니다. 그래서 순환 import가 생기지 않고 핸들러마다 따로 테스트하기 쉽습니다. EntityManager 전체를 준비하지 않고 인터페이스만 mock하면 됩니다.

```typescript
// EntityManager wires the handlers at construction time
private readonly relationLoader = new RelationLoader(this.resolver, this._ctx);
private readonly aggregateHandler = new AggregateQueryHandler(this.resolver, this._ctx);
```

## 하나의 인터페이스, 세 개의 데이터베이스

MySQL, PostgreSQL, SQLite는 저마다 다르게 동작합니다. Stingerloom은 코드베이스 곳곳에 `if (mysql) ... else if (postgres) ...`를 흩어 두지 않습니다. 대신 각 데이터베이스가 구현하는 `ISqlDriver` 인터페이스 하나를 정의합니다.

| 항목 | MySQL | PostgreSQL | SQLite |
|------|-------|------------|--------|
| Identifier wrapping | `` `backticks` `` | `"double quotes"` | `"double quotes"` |
| Primary key generation | AUTO_INCREMENT | SERIAL / RETURNING | INTEGER PRIMARY KEY |
| Upsert syntax | ON DUPLICATE KEY UPDATE | ON CONFLICT DO UPDATE | ON CONFLICT DO UPDATE |
| Query timeout | SET SESSION max_execution_time | SET LOCAL statement_timeout | Driver-level |
| Schema support | 미지원 | `"schema"."table"` | 미지원 |

설정에서 `type: "mysql"`을 `type: "postgres"`로 바꾸면 EntityManager가 다른 드라이버의 인스턴스를 만듭니다. 애플리케이션 코드는 그대로입니다.

> 힌트: 새 데이터베이스를 지원하려면 `src/dialects/` 아래 새 하위 폴더에 `ISqlDriver`를 구현하면 됩니다. 이 인터페이스는 DDL 연산, 타입 매핑, upsert 문법, 식별자 이스케이프, EXPLAIN 출력을 다룹니다.

### SQL Injection 방지 방법

모든 쿼리는 두 가지 안전 규칙을 따릅니다.

1. **사용자가 넘긴 값**: 파라미터로 바인딩됩니다. 쿼리에는 `$1`, `$2`로 나타나고 절대 문자열로 직접 들어가지 않습니다.
2. **테이블 이름과 컬럼 이름**: 드라이버의 `wrapIdentifier()` 메서드로 이스케이프됩니다.

내부 코드가 실제로 어떻게 생겼는지 예시를 보겠습니다. ORM은 INSERT 쿼리를 만들 때 `sql-template-tag`로 파라미터화된 쿼리를 구성합니다.

```typescript
// Internal code (simplified from EntityManager.saveInternal)
const insertSql = sql`
  INSERT INTO ${raw(this.wrapTable("user"))}
  (${join(columns, ", ")})
  VALUES (${join(values, ", ")})
`;
```

결과는 다음과 같습니다.

```
SQL:        INSERT INTO "user" ("name", "email") VALUES ($1, $2)
Parameters: ["John Doe", "john@example.com"]
```

`raw()` 래퍼는 이미 이스케이프된 식별자에만 씁니다. `wrapIdentifier()`를 거친 테이블 이름과 컬럼 이름이 여기에 해당합니다. `"John Doe"` 같은 사용자 값은 `sql-template-tag`의 템플릿 리터럴을 거치면서 파라미터 배열로 자동 추출됩니다. 사용자 입력을 SQL 문자열에 이어 붙이는 코드 경로는 없습니다.

이 두 규칙 덕분에 공격자가 `'; DROP TABLE users; --`를 이름 값으로 넘겨도 그 값은 실행 가능한 SQL이 아니라 무해한 파라미터 값이 됩니다.

## 멀티테넌시: Docker처럼 레이어로

SaaS 애플리케이션에서는 고객마다 데이터를 완전히 분리해야 합니다. Stingerloom은 **레이어드 메타데이터 시스템**으로 이 문제를 해결합니다. Docker가 파일 시스템 레이어에 쓰는 OverlayFS와 같은 개념입니다.

맨 아래에는 기본 스키마를 담은 **public 레이어**가 있습니다. 여기에는 모든 `@Entity`와 `@Column` 정의가 들어 있습니다. 이 레이어는 런타임에 읽기 전용입니다.

그 위에는 테넌트마다 자기 **테넌트 레이어**가 있습니다. ORM은 메타데이터를 읽을 때 테넌트 레이어를 먼저 확인합니다. 찾지 못하면 public 레이어로 넘어갑니다. 쓰기는 항상 테넌트 레이어에 기록됩니다(Copy-on-Write).

### 왜 AsyncLocalStorage를 쓰나요?

웹 서버에서는 같은 Node.js 프로세스 안에서 많은 요청이 동시에 실행됩니다. 현재 테넌트를 전역 변수에 저장하면 테넌트가 "acme"인 Request A와 테넌트가 "globex"인 Request B가 서로의 값을 덮어씁니다.

`AsyncLocalStorage`는 async 실행 흐름마다 격리된 저장소를 따로 제공해서 이 문제를 해결합니다. 요청이 미들웨어에 들어와 `MetadataContext.run("acme", callback)`을 호출했다고 해 보겠습니다. 그러면 그 콜백에서 호출되는 모든 함수는 "acme"를 현재 테넌트로 봅니다. 함수의 중첩 깊이나 함수가 지나는 `await` 지점의 수와 관계없이 마찬가지입니다. 동시에 `MetadataContext.run("globex", callback)`을 실행하는 요청은 자기 격리 컨텍스트에서 "globex"를 봅니다. 두 요청은 절대 서로 간섭하지 않습니다.

로깅 라이브러리가 request ID를 다루고 트레이싱 라이브러리가 span을 연결할 때 쓰는 것과 같은 메커니즘입니다. Node.js에 내장되어 있습니다. 그리고 전역 변수와 비교해 성능 오버헤드가 없습니다.

```typescript
// Request A: queries acme_corp's data
MetadataContext.run("acme_corp", async () => {
  await em.find(User);
  // ORM reads metadata from acme_corp's tenant layer
  // Falls back to public layer for anything not overridden
});

// Request B (concurrent): queries globex's data, completely isolated
MetadataContext.run("globex", async () => {
  await em.find(User);
  // Completely separate execution context -- no shared state with Request A
});
```

PostgreSQL에서는 ORM이 테넌트마다 별도의 스키마를 써서 테넌트를 물리적으로 격리할 수 있습니다. `TenantMigrationRunner`는 public 스키마의 테이블 구조를 복사해서 이 스키마를 자동으로 생성합니다. 두 가지 쿼리 전략을 포함한 전체 가이드는 [Multi-Tenancy](./multi-tenancy.md)를 참고하세요.

## 트랜잭션: 언제, 왜

모든 `save()`, `delete()`, `upsert()`는 트랜잭션 안에서 실행됩니다. 생명주기는 간단합니다.

1. 풀에서 연결을 하나 꺼냅니다.
2. `BEGIN`을 실행합니다.
3. 쿼리를 하나 이상 실행합니다.
4. 성공하면 `COMMIT`하고 에러가 나면 `ROLLBACK`합니다.
5. 연결을 풀에 반환합니다.

`@Transactional` 데코레이터는 활성 세션을 `AsyncLocalStorage`에 저장합니다. 그래서 `@Transactional` 메서드 안에서 `em.save()`를 두 번 호출하면 두 연산이 같은 트랜잭션을 공유합니다. `BEGIN`도 한 번이고 `COMMIT`도 한 번입니다.

```typescript
@Transactional()
async transferFunds(fromId: number, toId: number, amount: number) {
  await this.em.save(Account, { id: fromId, balance: from.balance - amount });
  await this.em.save(Account, { id: toId, balance: to.balance + amount });
  // Both saves share one transaction
  // COMMIT on return, ROLLBACK if an exception is thrown
}
```

읽기 전용 쿼리(`find`, `findOne`, `count`, `explain`)는 가능하면 트랜잭션을 건너뜁니다. `BEGIN`도 `COMMIT`도 없이 connect, query, close만 합니다. 이 최적화로 읽기 지연 시간이 크게 줄어듭니다.

데드락은 두 트랜잭션이 상대의 잠금을 서로 기다리는 상황입니다. 트랜잭션이 데드락에 걸리면 데이터베이스가 둘 중 하나를 종료합니다. `TransactionOptions`에서 `retryOnDeadlock: true`를 설정하면 ORM이 데드락 에러를 잡아서 콜백 전체를 다시 실행합니다. 전체 가이드는 [Transactions](./transactions.md)를 참고하세요.

## Schema Sync와 Migrations

`em.register()`를 호출하면 `SchemaRegistrar`가 엔티티 정의를 실제 데이터베이스와 비교합니다. 그리고 설정에 따라 스키마를 갱신합니다.

| `synchronize` 값 | 동작 | 사용 시점 |
|-------------------|------|----------|
| `true` | 엔티티에 맞게 테이블을 생성하고 컬럼을 추가, 변경, 삭제합니다 | 개발 환경에서만 |
| `"safe"` | 생성과 추가만 하고 삭제는 하지 않습니다 | 스테이징 |
| `"dry-run"` | DDL을 실행하지 않고 로그만 남깁니다 | 변경 사항 검토 시 |
| `false` (기본값) | 아무것도 하지 않습니다 | 프로덕션 |

> 경고: `synchronize: true`는 컬럼을 삭제할 수 있습니다. 프로덕션에서는 절대 사용하지 마세요. 대신 [Migrations](./migrations.md)를 사용하세요.

프로덕션에서는 `SchemaDiff`가 실제 DB 스키마를 엔티티 메타데이터와 비교해서 마이그레이션 파일을 생성합니다. 마이그레이션을 검토한 뒤 명시적으로 적용하면 됩니다. 그러면 프로덕션 데이터베이스에 적용될 변경을 완전히 제어할 수 있습니다.

## NestJS Integration

NestJS 모듈은 익숙한 `forRoot` / `forFeature` 패턴을 따릅니다.

- **`forRoot(options)`**: 전역 `EntityManager`를 생성합니다. 앱이 시작될 때 연결하고 앱이 멈출 때 graceful shutdown을 수행합니다.
- **`forFeature([User, Post])`**: 리포지토리를 등록합니다. 서비스에서는 `@InjectRepository(User)`로 주입받습니다.

여러 데이터베이스에 연결하는 앱이라면 `connectionName`을 넘기면 됩니다.

```typescript
StingerloomOrmModule.forRoot(mysqlOptions)                // "default"
StingerloomOrmModule.forRoot(pgOptions, "analytics")      // named
StingerloomOrmModule.forFeature([Event], "analytics")     // binds to "analytics"

// In a service:
@InjectRepository(Event, "analytics") private readonly eventRepo: BaseRepository<Event>
@InjectEntityManager("analytics") private readonly em: EntityManager
```

> 힌트: `connectionName`을 생략하면 기본값 `"default"`가 쓰입니다. 기존 단일 DB 코드는 바꾸지 않아도 동작합니다.

## Directory Map

```
src/
├── core/                  EntityManager, handlers, query builders
│   ├── EntityManager.ts           The main entry point for all CRUD
│   ├── EntityManagerInternals.ts  Interface that handlers depend on
│   ├── RelationMetadataResolver.ts  Entity/relation metadata lookup
│   ├── SchemaRegistrar.ts         Schema sync on startup
│   ├── RelationLoader.ts          Batch relation loading (N+1 prevention)
│   ├── CascadeHandler.ts          Cascade save/delete
│   ├── AggregateQueryHandler.ts   COUNT/SUM/AVG/MIN/MAX
│   ├── ExplainQueryHandler.ts     EXPLAIN query parsing
│   ├── TenantQueryStrategy.ts     search_path vs schema_qualified
│   ├── SelectQueryBuilder.ts      Type-safe, entity-aware query builder
│   ├── BaseRawQueryBuilder.ts     Low-level SQL query construction
│   ├── RawQueryBuilder.ts         Free-form SQL (UNION, CTE, window functions)
│   ├── SchemaGenerator.ts         DDL generation
│   └── SchemaDiff.ts              Live DB <-> entity metadata comparison
├── decorators/            @Entity, @Column, @ManyToOne, hooks, validation
├── dialects/              Database-specific implementations
│   ├── SqlDriver.ts               ISqlDriver interface (all drivers implement this)
│   ├── TransactionSessionManager.ts  Connection + transaction lifecycle
│   ├── ReplicationRouter.ts       Read replica routing
│   ├── mysql/                     MySQL driver
│   ├── postgres/                  PostgreSQL driver + TenantMigrationRunner
│   └── sqlite/                    SQLite driver
├── metadata/              Layered metadata primitives
│   ├── MetadataContext.ts         AsyncLocalStorage-based tenant scoping
│   └── MetadataLayer.ts           Individual layer storage
├── scanner/               Decorator pipeline; `MetadataLayerRegistry` lives here
│   └── MetadataScanner.ts         Decorator-time registry (canonical)
├── migration/             MigrationRunner + CLI (`npx stingerloom`)
├── schema/                Decorator-free EntitySchema API
├── integration/           NestJS module
├── types/                 Shared types (QueryResult, EntityResult, ColumnType)
├── errors/                OrmError + 11 specific error codes
├── utils/                 Logger, ReflectManager
├── DatabaseClient.ts      Connection singleton
└── index.ts               Public API exports
```

## 다음 단계

- [Getting Started](./getting-started.md): 5분 안에 설치하고 첫 CRUD 실행하기
- [Entities](./entities.md): 데코레이터로 테이블 정의하기
- [Configuration](./configuration.md): 연결 풀, 타임아웃, 읽기 레플리카를 비롯한 연결 옵션 전체
- [Multi-Tenancy](./multi-tenancy.md): 레이어드 메타데이터, 스키마 격리, 쿼리 전략
- [API Reference](./api-reference.md): 전체 메서드 시그니처
