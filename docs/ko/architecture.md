# Architecture

이 문서는 Stingerloom ORM의 내부 구조를 설명해요. `em.find()`나 `em.save()`를 쓸 때 내부에서 무슨 일이 일어나는지 궁금했다면, 여기서 시작하면 돼요. [Getting Started](./getting-started.md) 가이드를 먼저 읽는 걸 추천해요.

## 쿼리가 시스템을 통과하는 과정

아키텍처를 이해하는 가장 좋은 방법은 실제 쿼리를 따라가 보는 거예요. 이런 코드를 작성했다고 해볼게요:

```typescript
const users = await em.find(User, { where: { isActive: true }, relations: ["posts"] });
```

ORM 내부에서는 어떤 일이 일어날까요?

### Step 1: 엔티티 정의 조회

애플리케이션이 시작될 때, `User` 클래스의 `@Entity()`와 `@Column()` 데코레이터가 메타데이터(테이블 이름, 컬럼 목록, 관계 정의)를 메타데이터 스토어에 등록했어요. 이제 ORM이 그 메타데이터를 다시 읽어야 해요.

`RelationMetadataResolver`가 이 조회를 담당하는 모듈이에요. "`User`가 어떤 테이블에 매핑되는지?", "ManyToOne 관계가 뭔지?" 같은 질문에 답해줘요.

### Step 2: SQL 빌드

Query builder가 메타데이터와 `FindOption`을 받아서 파라미터화된 SQL 쿼리를 조립해요. Stingerloom에는 두 가지 query builder가 있어요:

- **`RawQueryBuilder`** -- 로우레벨 자유 형식 SQL builder예요. `find()`, `save()` 등 EntityManager 메서드 내부에서 사용돼요.
- **`SelectQueryBuilder`** -- 타입 안전한 엔티티 기반 builder로, `em.createQueryBuilder(User, "u")`로 생성해요. 컬럼 이름에 `keyof T` 자동완성을 제공해요.

간단한 `find()` 호출의 경우, ORM은 내부적으로 `RawQueryBuilder`를 사용해서 이런 SQL을 만들어요:

```sql
SELECT "id", "name", "email" FROM "user" WHERE "isActive" = $1
```

여기서 두 가지 중요한 일이 일어나요:

- `true` 같은 **값**은 SQL 문자열에 직접 들어가지 않아요. `$1`, `$2` 파라미터가 돼요 -- 이렇게 SQL injection을 방지해요.
- **테이블 이름과 컬럼 이름**은 데이터베이스 드라이버가 escape 처리해요. MySQL은 `` `backticks` ``로, PostgreSQL은 `"double quotes"`로 감싸요.

멀티테넌트 컨텍스트에서 실행 중이라면, `TenantQueryStrategy`가 테이블 이름을 변경할 수 있어요. `schema_qualified` 전략에서는 `"user"`가 `"acme_corp"."user"`가 돼요. 기본 `search_path` 전략에서는 테이블 이름이 그대로 유지되고, ORM이 트랜잭션 내에서 `search_path`를 설정해요.

### Step 3: 실행 방식 결정

모든 쿼리에 전체 트랜잭션이 필요한 건 아니에요. EntityManager가 판단을 내려요:

| 상황 | 동작 |
|------|------|
| `@Transactional` 내부에 이미 있을 때 | 기존 세션을 재사용해요 |
| PostgreSQL tenant + `search_path` 전략 | 트랜잭션으로 감싸요 (`SET LOCAL search_path`에 필요) |
| 쿼리에 timeout이 있을 때 (PostgreSQL) | 트랜잭션으로 감싸요 (`SET LOCAL statement_timeout`에 필요) |
| 그 외 모든 경우 (대부분의 읽기) | 경량 경로 -- connect, query, close. `BEGIN`/`COMMIT` 없음 |

즉, tenant 컨텍스트 없이 단순한 `em.find(User)`를 실행하면 트랜잭션을 완전히 건너뛰어서 여러 번의 네트워크 왕복을 절약해요.

### Step 4: 결과 변환

데이터베이스가 `{ id: 1, name: "Alice", isActive: true }` 같은 raw row를 반환해요. ORM은 이걸 제대로 된 `User` 인스턴스로 만들어야 해요.

`ResultTransformer`가 이걸 처리해요: row를 타입이 지정된 객체로 역직렬화하고, JOIN 결과에서 eager relation을 채우고, lazy relation은 첫 접근 시 데이터를 로드하는 proxy 객체로 감싸요.

### Step 5: 반환

완전히 타입이 지정된 `User[]` 배열을 받게 돼요. relation이 채워져 있고, lazy loading을 위한 proxy도 준비되어 있어요.

> **Hint** 쓰기 연산(`save`, `delete`, `upsert`)은 항상 트랜잭션 내에서 실행돼요 -- 쓰기에는 경량 경로가 없어요.

## 왜 코드가 모듈로 분리되어 있나요

ORM은 많은 일을 해요: 데이터베이스 연결, SQL 빌드, 트랜잭션 관리, relation 로딩, DDL 생성, 멀티테넌시 처리. 이 모든 게 하나의 파일에 있으면 읽을 수도 없고 테스트할 수도 없어요.

Stingerloom은 이런 관심사를 `src/` 아래 디렉토리로 분리하고, 엄격한 규칙을 따라요: **의존성은 아래 방향으로만 흘러요**. 하위 레이어는 절대 상위 레이어에서 import하지 않아요.

| 레이어 | 디렉토리 | 역할 |
|--------|----------|------|
| Integration | `integration/` | ORM을 프레임워크(NestJS)와 도구(Prisma import)에 연결해요 |
| Core | `core/` | EntityManager와 handler들 -- 핵심 로직이에요 |
| Connection | `DatabaseClient.ts` | 데이터베이스 연결을 보관하고 앱 전체에서 공유해요 |
| Scanner | `scanner/` | `@Entity` / `@Column` 데코레이터를 읽어서 메타데이터 레지스트리를 구성해요 |
| Decorators | `decorators/` | 데코레이터 함수 자체예요 (`@Entity`, `@Column`, `@ManyToOne` 등) |
| Metadata | `metadata/` | 멀티테넌시를 지원하는 레이어드 메타데이터 스토어예요 |
| Dialects | `dialects/` | 데이터베이스별 코드 -- DB마다 하위 폴더가 있어요 |
| Foundation | `types/`, `errors/`, `utils/` | 공유 타입, 에러 클래스, 로거예요 |

이 레이어링이 왜 중요하냐면, MySQL 관련 버그를 고칠 때 `src/dialects/mysql/`만 보면 돼요. 새 데코레이터를 추가할 때는 `src/decorators/`와 `src/scanner/`에서 작업하면 돼요. 레이어가 변경 범위를 한정시켜줘요.

## EntityManager는 모놀리스가 아니에요

EntityManager를 처음 작성했을 때는 모든 걸 처리했어요 -- 쿼리, relation, cascade, aggregation, schema sync. 기능이 늘어나면서 너무 커져서 파악하기 어려워졌어요.

해결책은 각 책임을 **handler 클래스**로 추출하는 거였어요:

| Handler | 존재 이유 |
|---------|----------|
| `RelationMetadataResolver` | 메타데이터 읽기를 쿼리 실행에서 분리해요 |
| `SchemaRegistrar` | DDL 생성을 런타임 쿼리에서 분리해요 |
| `RelationLoader` | N+1 쿼리를 방지하는 배치 로딩 로직을 캡슐화해요 |
| `CascadeHandler` | 재귀적 cascade save/delete 로직을 격리해요 |
| `AggregateQueryHandler` | COUNT/SUM/AVG/MIN/MAX는 고유한 SQL 패턴이 있어요 |
| `ExplainQueryHandler` | 각 데이터베이스마다 EXPLAIN 형식이 달라요 |
| `ReplicationManager` | Read replica 라우팅은 쿼리 로직과 독립적이에요 |
| `TenantQueryStrategy` | 멀티테넌트 테이블 한정은 별도의 관심사예요 |

모든 handler는 EntityManager 클래스가 아닌 `EntityManagerInternals` 인터페이스에 의존해요. 이렇게 하면 순환 import를 방지하고, 각 handler를 독립적으로 테스트하기 쉬워요 -- 전체 EntityManager를 셋업하지 않고 인터페이스만 mock하면 돼요.

```typescript
// EntityManager wires the handlers at construction time
private readonly relationLoader = new RelationLoader(this.resolver, this._ctx);
private readonly aggregateHandler = new AggregateQueryHandler(this.resolver, this._ctx);
```

## 하나의 인터페이스, 세 개의 데이터베이스

MySQL, PostgreSQL, SQLite는 각각 다르게 동작해요. 코드베이스 전체에 `if (mysql) ... else if (postgres) ...`를 뿌리는 대신, Stingerloom은 각 데이터베이스가 구현하는 단일 `ISqlDriver` 인터페이스를 정의해요.

| 항목 | MySQL | PostgreSQL | SQLite |
|------|-------|------------|--------|
| Identifier wrapping | `` `backticks` `` | `"double quotes"` | `"double quotes"` |
| Primary key generation | AUTO_INCREMENT | SERIAL / RETURNING | INTEGER PRIMARY KEY |
| Upsert syntax | ON DUPLICATE KEY UPDATE | ON CONFLICT DO UPDATE | ON CONFLICT DO UPDATE |
| Query timeout | SET SESSION max_execution_time | SET LOCAL statement_timeout | Driver-level |
| Schema support | -- | `"schema"."table"` | -- |

설정에서 `type: "mysql"`을 `type: "postgres"`로 바꾸면, EntityManager가 다른 드라이버를 인스턴스화해요. 애플리케이션 코드는 그대로예요.

> **Hint** 새 데이터베이스 지원을 추가하려면, `src/dialects/` 아래 새 하위 폴더에 `ISqlDriver`를 구현하면 돼요. 인터페이스는 DDL 연산, 타입 매핑, upsert 구문, identifier escaping, EXPLAIN 출력을 다뤄요.

### SQL Injection 방지 방법

모든 쿼리는 두 가지 안전 규칙을 거쳐요:

1. **사용자 제공 값**은 파라미터 바인딩돼요. 쿼리에서 `$1`, `$2`로 나타나고, 인라인 문자열로는 절대 들어가지 않아요.
2. **테이블 이름과 컬럼 이름**은 드라이버의 `wrapIdentifier()` 메서드로 escape돼요.

내부 코드가 실제로 어떻게 생겼는지 구체적인 예시를 볼게요. ORM이 INSERT 쿼리를 빌드할 때, `sql-template-tag`를 사용해서 파라미터화된 쿼리를 구성해요:

```typescript
// Internal code (simplified from EntityManager.saveInternal)
const insertSql = sql`
  INSERT INTO ${raw(this.wrapTable("user"))}
  (${join(columns, ", ")})
  VALUES (${join(values, ", ")})
`;
```

결과는 이렇게 돼요:

```
SQL:        INSERT INTO "user" ("name", "email") VALUES ($1, $2)
Parameters: ["John Doe", "john@example.com"]
```

`raw()` 래퍼는 이미 escape된 identifier(이미 `wrapIdentifier()`를 거친 테이블 이름과 컬럼 이름)에만 사용돼요. `"John Doe"` 같은 사용자 값은 `sql-template-tag`의 template literal을 거쳐서 자동으로 파라미터 배열로 추출돼요. 사용자 입력을 SQL 문자열에 연결하는 코드 경로는 없어요.

이 두 가지 규칙 시스템 덕분에, 공격자가 `'; DROP TABLE users; --`를 이름 값으로 전달해도 실행 가능한 SQL이 아닌 무해한 파라미터 값이 돼요.

## 멀티테넌시: Docker처럼 레이어로

SaaS 애플리케이션에서는 각 고객의 데이터를 완전히 분리해야 해요. Stingerloom은 **레이어드 메타데이터 시스템**으로 이걸 해결해요 -- Docker가 파일시스템 레이어에 사용하는 것과 같은 개념(OverlayFS)이에요.

하단에 기본 스키마를 담고 있는 **Public layer**가 있어요 -- 모든 `@Entity`와 `@Column` 정의가 들어 있어요. 런타임에서는 읽기 전용이에요.

그 위에 각 tenant가 자체 **Tenant layer**를 가져요. ORM이 메타데이터를 읽을 때 tenant layer를 먼저 확인해요. 없으면 Public layer로 fallback해요. 쓰기는 항상 tenant layer에 가요 (Copy-on-Write).

### 왜 AsyncLocalStorage를 쓰나요?

웹 서버에서는 같은 Node.js 프로세스에서 많은 요청이 동시에 실행돼요. 현재 tenant를 전역 변수에 저장하면, Request A(tenant "acme")와 Request B(tenant "globex")가 서로 덮어쓰게 돼요.

`AsyncLocalStorage`가 각 async 실행 체인에 고유한 격리 저장소를 제공해서 이 문제를 해결해요. 미들웨어에서 요청이 들어와 `MetadataContext.run("acme", callback)`을 호출하면, 그 callback에서 호출되는 모든 함수는 -- 아무리 깊이 중첩되어 있든, `await` 포인트를 몇 개 지나든 -- "acme"을 현재 tenant로 봐요. 동시에 `MetadataContext.run("globex", callback)`을 실행하는 요청은 자체 격리 컨텍스트에서 "globex"를 봐요. 둘은 절대 간섭하지 않아요.

이건 로깅 라이브러리가 request ID에, 트레이싱 라이브러리가 span correlation에 사용하는 것과 같은 메커니즘이에요. Node.js에 내장되어 있고, 전역 변수 대비 성능 오버헤드가 없어요.

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

PostgreSQL의 경우, ORM이 별도의 스키마를 사용해서 tenant를 물리적으로 격리할 수 있어요. `TenantMigrationRunner`가 public 스키마의 테이블 구조를 복제해서 이 스키마들을 자동으로 생성해요. 두 가지 query 전략을 포함한 전체 가이드는 [Multi-Tenancy](./multi-tenancy.md)를 참고하세요.

## 트랜잭션: 언제, 왜

모든 `save()`, `delete()`, `upsert()`는 트랜잭션 내에서 실행돼요. 라이프사이클은 간단해요:

1. 풀에서 커넥션을 가져와요.
2. `BEGIN`.
3. 하나 이상의 쿼리를 실행해요.
4. 성공하면 `COMMIT`, 에러 시 `ROLLBACK`.
5. 커넥션을 풀에 반환해요.

`@Transactional` 데코레이터는 활성 세션을 `AsyncLocalStorage`에 저장해요. `@Transactional` 메서드 안에서 `em.save()`를 두 번 호출하면, 두 연산이 같은 트랜잭션을 공유해요 -- `BEGIN` 한 번, `COMMIT` 한 번.

```typescript
@Transactional()
async transferFunds(fromId: number, toId: number, amount: number) {
  await this.em.save(Account, { id: fromId, balance: from.balance - amount });
  await this.em.save(Account, { id: toId, balance: to.balance + amount });
  // Both saves share one transaction
  // COMMIT on return, ROLLBACK if an exception is thrown
}
```

읽기 전용 쿼리(`find`, `findOne`, `count`, `explain`)는 가능하면 트랜잭션을 건너뛰어요. `BEGIN`도, `COMMIT`도 없이 -- connect, query, close만 해요. 이 최적화가 읽기 지연 시간을 크게 줄여줘요.

트랜잭션이 deadlock에 걸리면(두 트랜잭션이 서로의 lock을 기다리는 상황) 데이터베이스가 하나를 종료해요. `TransactionOptions`에서 `retryOnDeadlock: true`를 설정하면, ORM이 deadlock 에러를 잡아서 전체 callback을 다시 실행해요. 전체 가이드는 [Transactions](./transactions.md)를 참고하세요.

## Schema Sync와 Migrations

`em.register()`를 호출하면, `SchemaRegistrar`가 엔티티 정의를 실제 데이터베이스와 비교하고 선택적으로 스키마를 업데이트해요.

| `synchronize` 값 | 동작 | 사용 시점 |
|-------------------|------|----------|
| `true` | 엔티티에 맞게 테이블/컬럼을 생성, 변경, 삭제해요 | 개발 환경에서만 |
| `"safe"` | 생성과 추가만 하고, 삭제는 안 해요 | 스테이징 |
| `"dry-run"` | DDL을 실행하지 않고 로그만 남겨요 | 변경 사항 검토 시 |
| `false` (기본값) | 아무것도 안 해요 | 프로덕션 |

> **Warning** `synchronize: true`는 컬럼과 테이블을 삭제할 수 있어요. 프로덕션에서는 절대 사용하지 마세요. 대신 [Migrations](./migrations.md)를 사용하세요.

프로덕션에서는 `SchemaDiff`가 실제 DB 스키마를 엔티티 메타데이터와 비교해서 migration 파일을 생성해요. migration을 검토한 후 명시적으로 적용하면 돼요. 이렇게 하면 프로덕션 데이터베이스에 어떤 변경이 적용될지 완전히 제어할 수 있어요.

## NestJS Integration

NestJS 모듈은 익숙한 `forRoot` / `forFeature` 패턴을 따라요:

- **`forRoot(options)`** 은 전역 `EntityManager`를 생성해요. 시작 시 연결하고 앱이 멈출 때 graceful shutdown해요.
- **`forFeature([User, Post])`** 는 repository를 등록해요. 서비스에서 `@InjectRepository(User)`로 주입받아요.

여러 데이터베이스에 접속하는 앱이라면, `connectionName`을 전달하면 돼요:

```typescript
StingerloomOrmModule.forRoot(mysqlOptions)                // "default"
StingerloomOrmModule.forRoot(pgOptions, "analytics")      // named
StingerloomOrmModule.forFeature([Event], "analytics")     // binds to "analytics"

// In a service:
@InjectRepository(Event, "analytics") private readonly eventRepo: BaseRepository<Event>
@InjectEntityManager("analytics") private readonly em: EntityManager
```

> **Hint** `connectionName`을 생략하면 기본값 `"default"`가 돼요. 기존 단일 DB 코드는 변경 없이 동작해요.

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
├── integration/           NestJS module, Prisma importer
├── types/                 Shared types (QueryResult, EntityResult, ColumnType)
├── errors/                OrmError + 11 specific error codes
├── utils/                 Logger, ReflectManager
├── DatabaseClient.ts      Connection singleton
└── index.ts               Public API exports
```

## 다음 단계

- [Getting Started](./getting-started.md) -- 5분 안에 설치하고 첫 CRUD 실행하기
- [Entities](./entities.md) -- 데코레이터로 테이블 정의하기
- [Configuration](./configuration.md) -- 풀링, timeout, Read Replica 등 연결 옵션 전체
- [Multi-Tenancy](./multi-tenancy.md) -- 레이어드 메타데이터, 스키마 격리, query 전략
- [API Reference](./api-reference.md) -- 전체 메서드 시그니처
