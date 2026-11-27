# Multi-Tenancy

## 문제 상황

SaaS 제품을 만든다고 생각해 봅시다. 회사 수백 곳이 쓰는 프로젝트 관리 도구입니다. A 회사에는 직원이 50명 있고 B 회사에는 200명 있습니다. 두 회사는 같은 서버와 같은 데이터베이스에서 같은 애플리케이션을 씁니다.

하지만 A 회사가 B 회사의 데이터를 보는 일은 절대 없어야 합니다. API 응답에서도, 데이터베이스 쿼리에서도 안 되고 버그로 우연히 노출되어서도 안 됩니다. 이것이 **멀티테넌시**(multi-tenancy)입니다. 멀티테넌시는 애플리케이션 하나 안에서 여러 고객을 서로 격리하는 방식입니다. 이 고객 하나하나를 테넌트(tenant)라고 부릅니다.

흔히 쓰는 접근 방식은 네 가지입니다.

1. **DB 분리**: 테넌트마다 물리 데이터베이스를 따로 둡니다. 격리는 가장 강하지만 운영 비용이 가장 높습니다.
2. **DB 공유, 스키마 분리**: 데이터베이스는 하나이고 테넌트마다 자기 스키마(네임스페이스)를 씁니다. 격리와 효율의 균형이 좋습니다.
3. **전부 공유**: 데이터베이스 하나와 스키마 하나를 쓰고 모든 테이블에 `tenant_id` 컬럼을 둡니다. 가장 저렴하지만 WHERE 절 하나만 빠져도 데이터가 유출됩니다.
4. **DB 분리 + 라우팅 레이어**: #1과 형태는 같습니다. 다만 ORM이 `MetadataContext`를 보고 요청마다 알맞은 풀로 자동 라우팅합니다.

Stingerloom ORM은 네 가지를 모두 지원합니다.

- **#2 (스키마 기반)**: `search_path` 전략과 `schema_qualified` 전략을 씁니다. PostgreSQL 전용이고 레이어드 메타데이터 시스템 위에서 동작합니다.
- **#3 (컬럼 기반)**: `tenant_column` 전략을 씁니다. 모든 다이얼렉트에서 동작합니다.
- **#1 / #4 (DB 기반)**: `database` 전략과 `MultiTenantEntityManager`를 씁니다. 모든 다이얼렉트에서 동작합니다.

---

## 작동 원리 — OverlayFS 비유

Docker를 써 봤다면 이 구조가 익숙할 것입니다. 컨테이너는 베이스 이미지를 공유하면서 각자 쓰기 가능한 레이어를 하나씩 가집니다. 변경 사항은 최상위 레이어에 기록되고 베이스는 그대로 남습니다. 파일을 읽을 때 Docker는 최상위 레이어를 먼저 확인하고 없으면 베이스로 넘어갑니다.

Stingerloom의 메타데이터 시스템도 같은 방식입니다.

```
┌──────────────────────────────────────────────┐
│  Tenant Layer  (read / write)                │  ← Per-tenant overrides
│  e.g., "acme_corp" has a custom table name   │    (Copy-on-Write)
├──────────────────────────────────────────────┤
│  Public Layer  (read-only)                   │  ← Base schema definitions
│  @Entity, @Column decorators register here   │    (shared by all tenants)
└──────────────────────────────────────────────┘
```

메타데이터 읽기: 테넌트 레이어를 먼저 확인하고 없으면 public 레이어로 넘어갑니다.

메타데이터 쓰기: 항상 테넌트 레이어에 기록합니다. public 레이어는 런타임에 절대 수정되지 않습니다. Docker OverlayFS와 같은 Copy-on-Write 원칙입니다.

핵심은 이 구조를 직접 신경 쓸 필요가 없다는 점입니다. 요청이 어떤 테넌트에 속하는지만 설정하면 ORM이 모든 쿼리를 올바른 스키마로 자동 라우팅합니다.

---

## 테넌트 컨텍스트 설정

SaaS 앱에서 모든 HTTP 요청은 특정 테넌트에 속합니다. ORM에 그 테넌트를 알리려면 `MetadataContext.run()`을 씁니다.

```typescript
import { MetadataContext } from "@stingerloom/orm";

await MetadataContext.run("acme_corp", async () => {
  // Everything inside this callback runs in the "acme_corp" context.
  // All ORM queries automatically target acme_corp's schema.
  const users = await em.find(User);
  // → SELECT * FROM "acme_corp"."user"
});

// Outside the callback, we're back to "public" automatically.
const users = await em.find(User);
// → SELECT * FROM "user"  (public schema)
```

### 내부적으로 어떻게 동작하나요?

`MetadataContext.run()`은 Node.js의 `AsyncLocalStorage`를 씁니다. `AsyncLocalStorage`는 값을 파라미터로 넘기지 않아도 async 호출 체인 전체에 컨텍스트를 전파하는 내장 기능입니다. async JavaScript의 thread-local 변수라고 생각하면 됩니다.

```
HTTP Request arrives with header "X-Tenant-Id: acme_corp"
    │
    ▼
MetadataContext.run("acme_corp", async () => {
    │
    ├─► Controller.getUsers()
    │       │
    │       ├─► UserService.findAll()
    │       │       │
    │       │       └─► em.find(User)
    │       │               │
    │       │               └─► MetadataContext.getCurrentTenant()
    │       │                   returns "acme_corp" ← AsyncLocalStorage
    │       │                   │
    │       │                   └─► SQL: SELECT * FROM "acme_corp"."user"
    │       │
    │       └─► return users
    │
    └─► Response sent
});
// Context automatically reverts to "public"
```

호출 스택이 controller → service → repository → EntityManager처럼 아무리 깊어져도 테넌트 컨텍스트는 항상 `AsyncLocalStorage`에서 조회됩니다. 그래서 `tenantId`를 함수 파라미터로 일일이 넘길 필요가 없습니다.

### 현재 컨텍스트 확인

```typescript
const tenant = MetadataContext.getCurrentTenant();
// "acme_corp" inside run(), "public" outside

const isActive = MetadataContext.isActive();
// true inside run(), false outside
```

### 동시성 안전

HTTP 요청은 저마다 자기 `AsyncLocalStorage` 컨텍스트를 가집니다. "acme_corp" 요청과 "globex" 요청이 정확히 같은 밀리초에 들어와도 각 요청은 자기 테넌트 ID를 봅니다. 서로 덮어쓸 공유 전역 변수가 없기 때문입니다.

```
Request A (acme_corp)  ──────────────────────────►  sees "acme_corp" throughout
Request B (globex)     ──────────────────────────►  sees "globex" throughout
                       ↑ concurrent, but isolated
```

---

## NestJS 미들웨어로 자동 설정

실제 애플리케이션에서는 요청마다 `MetadataContext.run()`을 직접 호출하지 않습니다. 대신 미들웨어에서 HTTP 요청의 테넌트를 추출합니다. 그리고 요청의 생명주기 전체를 테넌트 컨텍스트로 감쌉니다.

```typescript
// tenant.middleware.ts
import { Injectable, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { MetadataContext } from "@stingerloom/orm";

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    // Extract tenant from request header (you could also use subdomain, JWT claim, etc.)
    const tenantId = req.headers["x-tenant-id"] as string ?? "public";

    // Wrap the ENTIRE request in a tenant context
    MetadataContext.run(tenantId, () => {
      next();
    });
  }
}
```

```typescript
// app.module.ts
@Module({ /* ... */ })
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantMiddleware).forRoutes("*");
  }
}
```

이제 NestJS 앱의 모든 controller와 service가 자동으로 올바른 테넌트 컨텍스트에서 실행됩니다. 비즈니스 로직은 고칠 필요가 없습니다.

```bash
# Query users for acme_corp
curl -H "X-Tenant-Id: acme_corp" http://localhost:3000/users
# → SELECT * FROM "acme_corp"."user"

# Query posts for globex
curl -H "X-Tenant-Id: globex" http://localhost:3000/posts
# → SELECT * FROM "globex"."post"

# Without the header → "public" schema
curl http://localhost:3000/users
# → SELECT * FROM "user"
```

### 테넌트 ID는 어디서 가져와야 하나요?

`X-Tenant-Id` 헤더가 가장 간단합니다. 프로덕션에서는 다음 방법도 씁니다.

| 소스 | 예시 | 사용 시점 |
|------|------|----------|
| HTTP 헤더 | `X-Tenant-Id: acme_corp` | 내부 API, 마이크로서비스 |
| 서브도메인 | `acme.yourapp.com` | 고객 대면 앱 |
| JWT claim | `{ tenantId: "acme_corp" }` | 토큰 기반 인증 |
| URL 경로 | `/tenants/acme_corp/users` | 테넌트 범위를 경로에 명시하는 REST API |

어떤 방법을 쓰든 미들웨어 패턴은 같습니다. 테넌트 ID를 추출해 `MetadataContext.run()`에 넘기면 됩니다.

---

## PostgreSQL 스키마 기반 격리

지금까지는 쿼리 라우팅을 살펴봤습니다. 그렇다면 테넌트 데이터는 실제로 어디에 저장될까요? PostgreSQL 스키마를 쓰면 테넌트마다 자기 네임스페이스가 생깁니다. 이 네임스페이스에는 모든 테이블의 복사본이 들어 있습니다.

PostgreSQL 스키마는 파일 시스템의 폴더와 비슷합니다.

```
Database "mydb"
├── public/           ← default schema (base tables)
│   ├── user
│   ├── post
│   └── comment
├── acme_corp/        ← tenant schema (same tables, different data)
│   ├── user
│   ├── post
│   └── comment
└── globex/           ← another tenant schema
    ├── user
    ├── post
    └── comment
```

스키마마다 자기 `user` 테이블이 있고 그 테이블에는 자기 행이 들어 있습니다. `acme_corp.user`와 `globex.user`는 완전히 별개입니다. 데이터도, 인덱스도, 시퀀스도 모두 다릅니다.

### TenantMigrationRunner로 테넌트 스키마 생성

`PostgresTenantMigrationRunner`는 테넌트 스키마 생성을 자동화합니다. public 스키마의 테이블 구조를 새 테넌트 스키마로 복제합니다.

```typescript
import { PostgresTenantMigrationRunner, EntityManager } from "@stingerloom/orm";

const em = new EntityManager();
await em.register({
  type: "postgres",
  host: "localhost",
  port: 5432,
  username: "postgres",
  password: "password",
  database: "mydb",
  entities: [User, Post],
  synchronize: true,  // creates tables in "public" schema
});

const driver = em.getDriver()!;
const runner = new PostgresTenantMigrationRunner(driver, {
  sourceSchema: "public",  // copy table structure from here
});
```

### 단일 테넌트 생성

```typescript
await runner.ensureSchema("acme_corp");
```

이 호출은 다음 SQL을 실행합니다.

```sql
-- 1. Create the schema
CREATE SCHEMA IF NOT EXISTS "acme_corp";

-- 2. Clone each table's structure from public (including indexes, constraints, defaults)
CREATE TABLE IF NOT EXISTS "acme_corp"."user"
  (LIKE "public"."user" INCLUDING ALL);

CREATE TABLE IF NOT EXISTS "acme_corp"."post"
  (LIKE "public"."post" INCLUDING ALL);
```

`INCLUDING ALL`은 데이터만 빼고 컬럼, 인덱스, 제약 조건, 기본값, 시퀀스를 모두 복사합니다. 그래서 테넌트는 모든 테이블의 빈 복사본으로 시작합니다.

`ensureSchema()`는 멱등(idempotent)입니다. 같은 테넌트로 두 번 호출해도 두 번째 호출은 아무것도 하지 않습니다. 내부에서는 어드바이저리 잠금(advisory lock)을 씁니다. 그래서 여러 프로세스가 같은 스키마를 동시에 생성하려 할 때 생기는 경쟁 상태(race condition)도 막습니다.

### 여러 테넌트 일괄 프로비저닝

```typescript
const result = await runner.syncTenantSchemas([
  "acme_corp", "globex", "initech", "umbrella"
]);

console.log(result.created);  // ["initech", "umbrella"] — newly created
console.log(result.skipped);  // ["acme_corp", "globex"] — already existed
```

### 기존 스키마 조회

```typescript
const schemas = await runner.discoverSchemas();
// ["public", "acme_corp", "globex"]
// (excludes pg_catalog, information_schema, and other system schemas)

runner.isProvisioned("acme_corp");    // true
runner.getProvisionedSchemas();       // ["acme_corp", "globex", ...]
```

### 복제할 테이블 고르기

기본적으로 원본 스키마의 모든 테이블을 복제합니다. `tables` 옵션은 이 범위를 좁힙니다. 엔티티 클래스나 테이블 이름으로 고르거나 접두사와 접미사로 고릅니다.

```typescript
const runner = new PostgresTenantMigrationRunner(driver, {
  tables: {
    include: [User, Post],        // 이 테이블만 (엔티티 클래스 또는 테이블 이름)
    exclude: ["__migrations"],    // 이 테이블은 절대 복제하지 않음
    excludePrefix: ["audit_"],    // audit_ 로 시작하는 테이블도 제외
  },
});
```

필터는 `include` → `includePrefix` / `includeSuffix` → `exclude` → `excludePrefix` / `excludeSuffix` 순서로 적용됩니다. `@Entity({ schema })`로 고정했거나 `@NonTenantEntity()`를 붙인 테이블은 필터와 관계없이 항상 원본 스키마에 남습니다. 자세한 내용은 [공유 테이블](#공유-테이블-엔티티를-스키마에-고정하기)을 참고하세요.

### NestJS에서 자동 프로비저닝

다음 서비스는 앱이 시작할 때 알려진 테넌트를 모두 프로비저닝합니다.

```typescript
// tenant-provisioning.service.ts
import { Injectable, OnModuleInit } from "@nestjs/common";
import { EntityManager, PostgresTenantMigrationRunner } from "@stingerloom/orm";

@Injectable()
export class TenantProvisioningService implements OnModuleInit {
  private runner: PostgresTenantMigrationRunner;

  constructor(private readonly em: EntityManager) {}

  async onModuleInit() {
    const driver = this.em.getDriver()!;
    this.runner = new PostgresTenantMigrationRunner(driver);

    // Create schemas for all known tenants on startup
    await this.runner.syncTenantSchemas([
      "acme_corp",
      "globex",
    ]);
  }

  // Call this when a new customer signs up
  async provisionTenant(tenantId: string) {
    await this.runner.ensureSchema(tenantId);
  }
}
```

::: info
Stingerloom은 현재 PostgreSQL에서만 스키마 기반 멀티테넌시를 지원합니다. MySQL에는 데이터베이스와 별개인 스키마 개념이 없습니다. SQLite는 스키마 자체를 지원하지 않습니다. MySQL이나 SQLite에서 `TenantMigrationRunner`의 메서드를 호출하면 코드가 `ORM_UNSUPPORTED_DATABASE`인 `OrmError`를 던집니다.
:::

---

## 테넌트 쿼리 전략

테넌트 컨텍스트 안에서 쿼리가 실행되면 ORM은 쿼리를 올바른 곳으로 라우팅해야 합니다. 올바른 곳은 스키마일 수도 있고 컬럼 조건이나 물리 데이터베이스일 수도 있습니다. 전략은 네 가지입니다. 어떤 전략을 고르느냐에 따라 성능, 격리 강도, 운영 비용이 달라집니다.

### 한눈에 보기

| 항목 | `search_path` | `schema_qualified` | `tenant_column` | `database` |
|---|---|---|---|---|
| 다이얼렉트 지원 | PostgreSQL 전용 | PostgreSQL 전용 | 모든 다이얼렉트 (MySQL/PG/SQLite) | 모든 다이얼렉트 |
| 격리 수준 | 스키마 | 스키마 | 행 (조건) | 물리 DB |
| 읽기 라운드 트립 | ~5 (BEGIN/SET LOCAL/...) | 1 | 1 | 1 |
| 연결 풀 | 1개 공유 | 1개 공유 | 1개 공유 | N개 (테넌트마다) |
| 신규 테넌트 비용 | `CREATE SCHEMA` | `CREATE SCHEMA` | 무료 | `CREATE DATABASE` |
| 테넌트 간 JOIN | OK (같은 DB) | OK (같은 DB) | OK (`tenant_id` 필터) | 불가능 (다른 DB) |
| 지원 테넌트 수 | 100~1k | 100~1k | 1k+ | ~50 (풀 예산) |
| 지리 / 컴플라이언스 분리 | 미지원 | 미지원 | 미지원 | 지원 |
| 테넌트별 백업/복구 | DB 단위 | DB 단위 | DB 단위 | 간단 |
| 운영 복잡도 | 낮음 | 낮음 | 가장 낮음 | 가장 높음 |

### "라운드 트립"이란?

라운드 트립(round trip)은 애플리케이션과 PostgreSQL 서버 사이에서 요청과 응답을 한 번 주고받는 일입니다. 라운드 트립마다 적어도 네트워크 지연이 한 번 생깁니다. 데이터베이스까지 10ms가 걸린다면 라운드 트립 5번은 데이터를 받기도 전에 50ms의 오버헤드가 됩니다.

### 전략 1: `"search_path"` (기본값)

PostgreSQL에는 `search_path`라는 세션 변수가 있습니다. 스키마가 명시되지 않은 테이블 이름이 어떤 스키마를 가리키는지 결정하는 변수입니다. 이 전략은 각 테넌트 쿼리 전에 트랜잭션 안에서 `search_path`를 설정합니다.

```typescript
await em.register({
  type: "postgres",
  // ...
  tenantStrategy: "search_path",  // default — can be omitted
});
```

`MetadataContext.run("acme_corp", ...)` 블록 안에서 `em.find(User)`를 실행하면 네트워크 수준에서 다음 일이 일어납니다.

```
App                                    PostgreSQL
 │                                          │
 ├─── 1. BEGIN ──────────────────────────► │
 │◄── OK ───────────────────────────────── │
 │                                          │
 ├─── 2. SET LOCAL search_path            │
 │       TO "acme_corp" ─────────────────► │
 │◄── OK ───────────────────────────────── │
 │                                          │
 ├─── 3. SELECT * FROM "user" ───────────► │  ← unqualified "user" resolves
 │◄── rows ─────────────────────────────── │    to "acme_corp"."user"
 │                                          │
 ├─── 4. COMMIT ─────────────────────────► │
 │◄── OK ───────────────────────────────── │
```

테넌트 읽기 한 번에 연결 외에 라운드 트립이 4번 필요합니다. BEGIN, SET LOCAL, SELECT, COMMIT입니다. `SET LOCAL`은 search_path 변경이 이 트랜잭션에만 적용되도록 보장합니다. 그래서 다른 연결에는 영향을 주지 않습니다.

장점: PostgreSQL에서 잘 정립된 패턴입니다. pg_dump나 모니터링 같은 기존 도구가 그대로 동작합니다.

단점: 테넌트 읽기마다 트랜잭션으로 감싸야 하므로 지연이 늘어납니다.

#### 테넌트 마커는 유효한 PG 식별자여야 합니다

`search_path`가 기본 전략이므로 `MetadataContext.run(<value>)`에 넘긴 값은 `SET LOCAL search_path TO "<value>"`에서 그대로 PostgreSQL 스키마 이름으로 쓰입니다. 그래서 마커는 유효한 PostgreSQL 식별자여야 합니다. 허용하는 문자는 알파벳, 숫자, 언더스코어, 하이픈, `$`이고 첫 글자는 알파벳이나 언더스코어여야 합니다.

식별자 검증을 통과하지 못하는 값을 넘기면 커넥터는 트랜잭션마다 에러로 중단하는 대신 `SET LOCAL`을 건너뜁니다. `"12345"`처럼 숫자로만 된 workspace id가 그런 값입니다. 이때 커넥터는 잘못된 마커마다 경고를 한 번씩 남깁니다.

```
WARN [PostgresConnector] MetadataContext tenant "12345" is not a valid
PostgreSQL identifier — skipping SET LOCAL search_path. If you intended
schema-based isolation, set tenantStrategy:"schema_qualified" or use a
schema-name tenant marker. If you use MetadataContext only for app-side
context, set tenantStrategy:"tenant_column" to silence this warning.
```

해결 방법은 세 가지입니다.

1. **스키마 이름 형태의 마커로 바꿉니다.** 숫자 id 앞에 접두사를 붙이고 같은 문자열을 스키마 이름으로도 쓰세요. `MetadataContext.run(\`tenant_${workspaceId}\`, ...)`처럼 씁니다.
2. **`schema_qualified`로 전환합니다.** 격리 모델은 같고 `SET LOCAL` 라운드 트립이 없습니다. 마커의 식별자 규칙은 똑같이 적용됩니다.
3. **`tenant_column`(또는 `database`)으로 전환합니다.** `MetadataContext.run()`을 앱 쪽 컨텍스트 마커로만 쓰는 경우입니다. 활성 workspace를 구독자, 감사 로그, 행 수준 가드(row-level guard)에 보여 주려고 컨텍스트를 열고 실제 격리는 컬럼 수준에서 강제하는 경우가 여기에 해당합니다. 이때는 그 의도를 전략으로 명시하세요. 그러면 커넥터는 `search_path`를 건드리지 않습니다.

### 전략 2: `"schema_qualified"`

이 전략은 search_path를 바꾸지 않고 테이블 이름 앞에 스키마 이름을 직접 붙입니다.

```typescript
await em.register({
  type: "postgres",
  // ...
  tenantStrategy: "schema_qualified",
});
```

이제 `MetadataContext.run("acme_corp", ...)` 안에서 `em.find(User)`를 실행하면 다음과 같이 동작합니다.

```
App                                    PostgreSQL
 │                                          │
 ├─── SELECT * FROM "acme_corp"."user" ──► │
 │◄── rows ─────────────────────────────── │
```

라운드 트립은 연결을 빼면 1번뿐입니다. 단순 읽기에는 트랜잭션이 필요 없습니다.

```sql
-- With schema_qualified strategy, tenant context = "acme_corp":
SELECT * FROM "acme_corp"."user"

-- With schema_qualified strategy, tenant context = "public" (or no context):
SELECT * FROM "user"
```

장점: 더 빠릅니다. 읽기에 불필요한 트랜잭션 오버헤드가 없습니다.

단점: 실제로는 없습니다. SQL이 조금 다를 뿐 두 전략의 결과는 같습니다.

### 성능 비교

| 시나리오 | `search_path` | `schema_qualified` |
|---------|:-------------:|:------------------:|
| 테넌트 읽기 (라운드 트립) | 4-5 | 1-2 |
| 비테넌트 읽기 | 1-2 | 1-2 |
| 쓰기 작업 | 트랜잭션 (동일) | 트랜잭션 (동일) |
| 결과 정확성 | 동일 | 동일 |

`schema_qualified`를 고를 때: 테넌트 범위 쿼리가 많은 읽기 위주 앱에 맞습니다. 대부분의 SaaS 앱이 여기에 해당합니다. 네트워크 지연이 10ms라면 테넌트 읽기 한 번의 오버헤드가 search_path의 약 40ms에서 schema_qualified의 약 10ms로 줄어듭니다.

두 전략의 결과는 같습니다. 차이는 성능뿐입니다. search_path를 써야 할 특별한 이유가 없다면 `schema_qualified`가 더 나은 기본값입니다. 스키마 한정 이름을 지원하지 않는 도구와 호환해야 하는 경우가 그런 이유의 한 예입니다.

### 트랜잭션 안에서 테넌트 바꾸기 {#switching-tenants-inside-a-transaction}

테넌트 스키마는 모두 한 데이터베이스 안에 있습니다. 그래서 트랜잭션 하나에 여러 테넌트의 작업을 담아도 됩니다. 트랜잭션을 어느 테넌트에서 시작했든 각 SQL 문은 그 SQL 문을 보낼 때 활성화된 테넌트의 스키마에서 실행됩니다.

```typescript
await MetadataContext.run("acme_corp", async () => {
  await em.transaction(async () => {
    await em.save(Invoice, { total: 100 });      // → "acme_corp"

    await MetadataContext.run("globex", async () => {
      await em.save(Invoice, { total: 250 });    // → "globex"
    });
  });
});
```

`search_path` 전략에서는 트랜잭션의 `SET LOCAL`이 트랜잭션을 시작한 테넌트를 가리킵니다. 테넌트가 바뀌면 ORM이 다음 SQL 문 앞에 `SET LOCAL search_path`를 한 번 더 보냅니다. 작업이 원래 테넌트로 돌아올 때도 다시 보냅니다. 바뀔 때마다 라운드 트립이 하나 늘 뿐이고 테넌트가 그대로면 추가 SQL 문은 없습니다. `schema_qualified`에서는 테넌트 테이블이 이미 SQL에 스키마와 함께 적혀 있습니다. 테넌트 트랜잭션 안의 `"public"` 작업도 같은 방식으로 기본 스키마를 다시 가리킵니다. `MetadataContext.run()` 밖에서 시작한 트랜잭션도 마찬가지입니다. 테넌트 블록 안의 작업은 그 테넌트의 스키마로 갑니다.

모든 테넌트의 작업은 함께 커밋되거나 함께 롤백됩니다. 실패한 `NESTED` 트랜잭션이 실행하는 `ROLLBACK TO SAVEPOINT`는 세이브포인트를 만들 때의 search_path도 되돌립니다. 그 뒤의 SQL 문도 계속 각자의 테넌트 스키마에서 실행됩니다. [`database` 전략](#cross-tenant-transactions-are-forbidden)은 다릅니다. 이 전략에서는 테넌트마다 데이터베이스가 따로 있습니다. 그래서 트랜잭션 안에서 테넌트를 바꾸면 에러를 던집니다.

### 공유 테이블: 엔티티를 스키마에 고정하기

두 전략 모두 *모든* 테이블을 테넌트 스키마로 보냅니다. 테넌트 데이터에는 이 동작이 맞습니다. 하지만 모든 테넌트가 함께 쓰는 테이블도 있습니다. 구독 플랜, 국가 코드, 피처 플래그, 그리고 `tenants` 테이블 자체가 그렇습니다. `MetadataContext.run("acme_corp", ...)` 안에서는 이런 테이블에 닿지 못합니다. `search_path`는 테넌트 스키마만 지정하고 `public`으로 넘어가지 않습니다. `schema_qualified`는 이름을 `"acme_corp"."plan"`으로 바꿔 씁니다. 그러면 PostgreSQL은 `relation "plan" does not exist`로 응답합니다. 지금까지 유일한 우회책은 테이블을 테넌트 스키마마다 복제하는 것이었습니다. 그러면 테넌트마다 자기만 쓰는 빈 사본이 하나씩 생깁니다.

대신 엔티티를 스키마에 고정하세요.

```typescript
@Entity({ schema: "public" })
class Plan {
  @PrimaryGeneratedColumn() id!: number;
  @Column() code!: string;
  @OneToMany(() => Subscription, { mappedBy: "plan" }) subscriptions!: Subscription[];
}

@Entity()
class Subscription {
  @PrimaryGeneratedColumn() id!: number;
  @ManyToOne(() => Plan, (p) => p.subscriptions, { joinColumn: "plan_id" })
  plan!: Plan;
}
```

고정된 엔티티는 어떤 테넌트가 활성이든 어떤 전략을 쓰든 항상 `"schema"."table"`로 표기됩니다.

```sql
-- MetadataContext.run("acme_corp") 안, schema_qualified
SELECT * FROM "acme_corp"."subscription" s
  JOIN "public"."plan" p ON p."id" = s."plan_id"

-- MetadataContext.run("acme_corp") 안, search_path
SET LOCAL search_path TO "acme_corp";
SELECT * FROM "public"."plan"
```

고정은 테이블 이름이 쓰이는 모든 곳에 적용됩니다.

- **쿼리**: `find*`, 쓰기, 관계 로딩, `SelectQueryBuilder` JOIN, `em.ref()`.
- **Synchronize**: 테이블을 고정된 스키마에 생성하고 그 스키마에서 변경합니다. 스키마가 없으면 스키마도 함께 생성합니다. 테넌트 테이블에서 공유 테이블로 가는 외래 키는 `"public"."plan"`을 참조합니다.
- **`migrate:generate`**: diff가 고정된 스키마를 인트로스펙션합니다.
- **프로비저닝**: `PostgresTenantMigrationRunner`는 고정 테이블을 원본 스키마에 남겨 둡니다. 고정된 엔티티가 소유한 ManyToMany 조인 테이블도 마찬가지입니다. 이런 테이블은 `tables.include`에 적혀 있어도 테넌트로 복제하지 않습니다.

`@NonTenantEntity()`는 스키마 이름 없이 같은 일을 합니다. `search_path`와 `schema_qualified`에서는 엔티티를 연결의 기본 스키마에 고정합니다. 기본 스키마는 `schema` 옵션의 값이고 이 옵션이 없으면 `public`입니다. 그래서 이 데코레이터 하나가 모든 전략에서 "전역 테이블"을 뜻합니다. `tenant_column`에서는 같은 클래스에 구분 컬럼이 붙지 않습니다.

`JOINED`(table-per-type) 계층의 자식 엔티티는 따로 지정하지 않으면 루트의 스키마를 물려받습니다. 자식의 테이블만 다른 스키마에 고정해도 됩니다. `SINGLE_TABLE` 자식은 루트와 테이블을 공유하므로 스키마도 루트를 따릅니다. 자식에 다른 `schema`를 적으면 경고를 남기고 무시합니다. 코드 우선(code-first) 엔티티도 같은 옵션을 받습니다. `defineEntity("plans", { ... }, { schema: "public" })`와 `new EntitySchema({ target, schema: "public", ... })`처럼 씁니다. `em.resolveEntitySchema(Plan)`은 엔티티가 해석되는 스키마를 반환합니다. 엔티티가 테넌트 전략을 따르면 `undefined`를 반환합니다. MySQL과 SQLite에는 스키마 계층이 없으므로 이 옵션을 무시합니다.

::: warning
고정은 라우팅 결정이지 접근 제어가 아닙니다. 모든 테넌트가 고정 테이블의 같은 행을 읽고 씁니다. 테넌트 소유 데이터는 고정하지 않은 엔티티에 두세요.
:::

### 프로그래밍 방식 접근

커스텀 미들웨어나 테스트 같은 고급 용도에 쓰도록 전략 클래스를 export합니다.

```typescript
import {
  TenantQueryStrategy,
  SearchPathStrategy,
  SchemaQualifiedStrategy,
  TenantColumnStrategy,
} from "@stingerloom/orm";
```

---

## 전략 3: `tenant_column` (모든 다이얼렉트 지원)

스키마 기반 격리에는 PostgreSQL이 필요합니다. 하지만 앱이 MySQL이나 SQLite에서 실행될 수도 있습니다. 테넌트가 수천 개로 늘어나 테넌트마다 스키마를 하나씩 만드는 일이 카탈로그와 마이그레이션에 부담이 될 수도 있습니다. 이럴 때 쓰는 세 번째 방법이 있습니다. 모든 테넌트의 행을 같은 테이블에 넣고 구분 컬럼(discriminator column)으로 나누는 방식입니다.

처음에 소개한 #3 접근입니다. 데이터베이스와 스키마를 공유하고 테넌트 범위 테이블마다 `tenant_id` 컬럼을 둡니다. 일반적으로 이 방식은 위험합니다. `WHERE tenant_id = ?` 하나만 빠뜨려도 다른 테넌트의 행이 노출되기 때문입니다. Stingerloom은 이 방식을 안전하게 만듭니다.

- 모든 읽기, 갱신, 삭제에 조건을 자동으로 주입합니다.
- 모든 삽입에서 테넌트 값을 검증합니다.
- 테넌트를 넘나드는 접근이 의도된 관리자 작업에는 명시적인 탈출구를 제공합니다.

### 언제 `schema_qualified` 대신 선택해야 하나요?

| 항목 | `schema_qualified` (전략 2) | `tenant_column` (전략 3) |
|---|---|---|
| 다이얼렉트 지원 | PostgreSQL만 | MySQL, PostgreSQL, SQLite |
| 새 테넌트 온보딩 | 모든 테이블마다 `CREATE SCHEMA` + `CREATE TABLE (LIKE …)` | 없음: 첫 INSERT가 `tenant_id`를 채움 |
| 스키마 변경 | 모든 테넌트 스키마에 각각 적용 | 한 번 적용하면 모든 테넌트에 즉시 반영 |
| `pg_catalog` 부하 | N 테이블 × M 테넌트 | 전체 N 테이블 |
| 일반적인 테넌트 수 | 수십 ~ 수백 개 | 수천 개 이상 |
| 격리 경계 | PostgreSQL 스키마 (DB 수준 강제) | ORM이 강제하는 WHERE 절 |
| raw SQL 안전성 | `search_path`나 스키마 한정 이름으로 이미 범위가 정해짐 | 조건을 직접 넣어야 함 |

`schema_qualified`는 데이터베이스 수준에서 더 강하게 격리합니다. 잘못된 컨텍스트에서 raw `SELECT * FROM user`를 실행해도 다른 테넌트의 데이터가 아니라 엉뚱한 스키마를 조회할 뿐입니다. `tenant_column`은 이 강한 경계를 내주고 공유 스키마 하나를 얻습니다. 이 스키마는 테넌트마다 DDL을 실행하지 않고도 테넌트 수천 개로 확장됩니다.

### 전략 활성화

```typescript
await em.register({
  type: "mysql",            // "postgres"나 "sqlite"도 가능
  // ...
  entities: [User, Post, Invoice],
  synchronize: true,
  tenantStrategy: "tenant_column",
  tenantColumnName: "tenant_id",   // optional — "tenant_id" is the default
  tenantColumnType: "varchar",     // optional — "varchar" | "uuid" | "int" | "bigint"
  tenantColumnLength: 64,          // optional: varchar에만 적용
  tenantOnMissingContext: "throw", // optional: "throw" | "warn" (기본값) | "allow"
});
```

### 자동으로 일어나는 일

`tenantStrategy: "tenant_column"`을 설정하면 엔티티별 코드 없이도 ORM이 모든 엔티티에 네 가지 동작을 적용합니다.

1. **DDL 주입.** `SchemaRegistrar`가 모든 테이블에 `tenant_id VARCHAR(64) NOT NULL`을 추가합니다. 타입은 설정에 따라 달라집니다. 엔티티 클래스에 컬럼을 선언할 필요가 없습니다.
2. **INSERT 자동 채움 + 검증.** `save()` / `saveMany()` / `insertMany()` / `upsert()` / `batchUpsert()`가 `MetadataContext.getCurrentTenant()` 값으로 `tenant_id`를 채웁니다. 테넌트 컨텍스트 없이 INSERT하면 `MISSING_TENANT_CONTEXT`를 던집니다. 컨텍스트와 다른 `tenant_id`를 명시적으로 넘기면 `TENANT_MISMATCH`를 던집니다. UPDATE 쪽도 마찬가지입니다. 다른 테넌트를 지목한 페이로드로 `save()`를 호출하면 행을 옮기지 않고 거부합니다.
3. **읽기 WHERE 주입.** `find()`, `findOne()`, `findByPK()`, `findAndCount()`, `findWithCursor()`, `count()`, `exists()`, `sum()`, `avg()`, `min()`, `max()`, 그리고 `SelectQueryBuilder.getMany()` / `getCount()` / `exists()`에 `AND tenant_id = ?`가 자동으로 붙습니다. eager JOIN과 관계 로더도 같은 조건을 물려받습니다. [Raw Pipeline](./raw-pipeline.md#멀티테넌시)의 `em.pipe()` 배치와 `count()`에도 붙습니다.
4. **쓰기 WHERE 주입.** `updateMany()`, `deleteMany()`, `delete()`, `softDelete()`, `restore()`, 그리고 `save()` / `saveMany()`의 UPDATE 분기까지 모두 `AND tenant_id = ?`를 받습니다. 그래서 테넌트 A에서 실행한 쿼리는 테넌트 B의 행을 건드리지 못합니다. upsert 계열도 충돌 분기에 같은 조건이 붙습니다. 자세한 내용은 아래 표에 있습니다. 테넌트 컨텍스트가 아예 없을 때의 동작은 아래의 `tenantOnMissingContext` 정책을 따릅니다.

#### 어떤 쓰기 경로에 predicate가 붙나

| 연산 | 테넌트 A에서 테넌트 B 소유 행을 건드릴 때 |
|------|---------------------------------------------|
| `save({ id })` / `saveMany([{ id }])` | `EntityNotFoundError`: UPDATE는 `pk AND tenant_id`로 행을 찾고 존재 확인 쿼리에도 같은 범위가 걸립니다 |
| 페이로드에 다른 테넌트의 `tenant_id`를 넣은 `save()` | INSERT와 UPDATE 모두 `TENANT_MISMATCH`입니다. 테넌트 컬럼은 UPDATE `SET` 목록에 아예 들어가지 않습니다. 그래서 조회한 엔티티를 그대로 저장해도 행이 다른 테넌트로 옮겨지지 않습니다 |
| `upsert()` / `batchUpsert()` | 충돌 분기가 그 행을 건너뜁니다. PostgreSQL과 SQLite에서는 `affected`에 0으로 잡히고 엔티티 클래스마다 경고가 한 번 남습니다 |
| `createInsertBuilder().doUpdate()` | 마찬가지로 건너뜁니다. 직접 지정한 `doUpdateWhere()` 조건은 테넌트 조건과 AND로 묶입니다 |
| `createInsertBuilder().values(columns, query)` | 쿼리는 자기 테넌트 조건에 따라 테넌트 A의 행만 읽습니다. 그리고 쓰는 행에는 모두 테넌트 A가 들어갑니다. `columns`에 테넌트 컬럼을 넣으면 `INVALID_QUERY`를 던집니다 |
| `insertIgnore()` | 원래 안전합니다. `DO NOTHING`은 기존 행에 절대 쓰지 않고 이번 INSERT를 버립니다 |
| `update()` / `updateMany()` / `increment()` / `decrement()` / `delete()` / `deleteMany()` / `softDelete()` / `restore()` | `affected: 0`, 아무것도 쓰지 않습니다 |
| `createUpdateBuilder()` | `affected: 0`, 아무것도 쓰지 않습니다 |
| 테넌트 컬럼 자체를 쓰는 모든 연산 | `TENANT_MISMATCH`: 자기 행을 다른 테넌트에 넘기는 것도 막습니다. `save()`와 `updateMany()`는 *현재* 테넌트 값이면 통과시키고 `SET` 목록에서 뺍니다. 반면 `createUpdateBuilder().set()`과 `createInsertBuilder().doUpdate()`는 SQL 문이 실행될 때 값이 이미 렌더링되어 있으므로 컬럼 자체를 거부합니다. 이 가드는 테넌트 컨텍스트가 활성인 동안 적용됩니다. 의도적으로 행을 옮기려면 `MetadataContext.runUnscoped()`나 `MetadataContext.run("public", ...)`을 쓰세요 |
| `clear()` | 테넌트 A의 행만 삭제합니다. 테넌트 B의 행은 남습니다 |
| `@ManyToMany` 조인 테이블의 `attachRelation()` / `detachRelation()` | `attachRelation()`은 `EntityNotFoundError`를 던지고 `detachRelation()`은 `affected: 0`을 반환합니다. 조인 테이블에는 테넌트 컬럼이 없습니다. 그래서 쓰기 전에 두 id를 각자의 테이블에서 테넌트 조건으로 조회합니다. 두 행이 모두 테넌트 A의 것이거나 한쪽이 `@NonTenantEntity()`일 때만 링크를 씁니다 |
| `em.query()` raw SQL | 범위 없음: 호출 지점마다 한 번 경고합니다 |

`upsert()`, `batchUpsert()`, `createInsertBuilder().doUpdate()`는 먼저 INSERT를 시도합니다. 그래서 테넌트 컨텍스트가 없으면 항상 거부합니다. 새 행에 채워 넣을 테넌트 값이 없기 때문입니다. `tenantOnMissingContext` 정책과 관계없고 `runUnscoped()`나 `run("public", ...)` 안에서도 마찬가지입니다.

MySQL/MariaDB의 `ON DUPLICATE KEY UPDATE`에는 `WHERE`를 붙이지 못합니다. 그래서 대입 하나하나를 `col = IF(tbl.tenant_id = ?, VALUES(col), tbl.col)` 형태로 내보냅니다. MySQL 8.0.19+에서는 `VALUES(col)` 대신 `new.__col`을 씁니다. `@Version` 증가는 `version = IF(tbl.tenant_id = ?, COALESCE(tbl.version, 0) + 1, tbl.version)`으로 내보냅니다. 어느 쪽이든 다른 테넌트의 행은 그대로 남습니다. 하지만 `affected` 숫자의 뜻은 달라집니다. `mysql2`는 `CLIENT_FOUND_ROWS` 플래그를 켜고 연결합니다. 그래서 차단된 행은 `affected: 1`로 잡힙니다. 행은 찾았지만 아무것도 쓰지 않았다는 뜻입니다. 이 숫자는 INSERT가 보고하는 숫자와 같고 실제 갱신은 2를 보고합니다. 어느 쪽인지 알아야 하면 행을 다시 조회하세요.

```typescript
@Entity()
class Post {
  @PrimaryGeneratedColumn() id!: number;
  @Column() title!: string;
}

// 생성되는 테이블 DDL:
//   CREATE TABLE post (
//     id INTEGER PRIMARY KEY AUTO_INCREMENT,
//     title VARCHAR(255) NOT NULL,
//     tenant_id VARCHAR(64) NOT NULL          ← 자동 주입
//   )

await MetadataContext.run("acme", async () => {
  await em.save(Post, { title: "Hello" });
  // → INSERT INTO post (title, tenant_id) VALUES ('Hello', 'acme')

  const posts = await em.find(Post);
  // → SELECT ... FROM post WHERE tenant_id = 'acme'

  await em.delete(Post, { id: 42 });
  // → DELETE FROM post WHERE id = 42 AND tenant_id = 'acme'
});
```

### `@TenantColumn`으로 테넌트 값 읽기

`@TenantColumn` 선언은 선택 사항입니다. 선언하든 안 하든 컬럼은 ORM이 관리합니다. 애플리케이션 코드가 엔티티 인스턴스에서 테넌트 id를 읽어야 할 때만 선언하세요. 감사 로그, 관리자 대시보드, 테넌트 간 익스포트가 그런 경우입니다.

```typescript
import { TenantColumn } from "@stingerloom/orm";

@Entity()
class AuditLog {
  @PrimaryGeneratedColumn() id!: number;
  @Column() action!: string;
  @TenantColumn() tenantId!: string;   // 이제 log.tenantId로 읽을 수 있음
}
```

`save()`할 때 `@TenantColumn` 속성에 값을 할당하면 그 값은 현재 컨텍스트와 반드시 일치해야 합니다. 일치하지 않으면 ORM이 `TENANT_MISMATCH`를 던집니다. INSERT든 UPDATE든 같습니다. 속성을 직접 설정해 테넌트를 위조하지는 못합니다. 테넌트 조건이 걸리는 동안에는 이 컬럼이 UPDATE `SET` 목록에서 빠지기 때문입니다. 그래서 쓰기로 행의 소유자가 바뀌는 일 자체가 없습니다.

### `@NonTenantEntity`로 엔티티 제외

어떤 테이블은 본래 전역입니다. `Tenant` 테이블 자체, 시스템 설정, 국가·통화·피처 플래그 같은 공유 룩업 테이블이 그렇습니다. 이런 엔티티에 `@NonTenantEntity()`를 붙이면 ORM이 건드리지 않습니다. DDL에 컬럼을 추가하지 않고 WHERE도 주입하지 않으며 INSERT도 검증하지 않습니다.

```typescript
import { NonTenantEntity } from "@stingerloom/orm";

@Entity()
@NonTenantEntity()
class Tenant {
  @PrimaryColumn() id!: string;
  @Column() name!: string;
}

@Entity()
@NonTenantEntity()
class Country {
  @PrimaryColumn() code!: string;
  @Column() name!: string;
}
```

테넌트 범위 엔티티에서 `@NonTenantEntity` 대상으로 eager JOIN해도 안전합니다. ORM이 테넌트 범위가 아닌 쪽의 테넌트 조건을 자동으로 건너뜁니다.

같은 데코레이터는 스키마 기반 전략에서도 이 테이블을 전역으로 유지합니다. `search_path`와 `schema_qualified`에서는 엔티티를 연결의 기본 스키마에 고정합니다. 그래서 테넌트 컨텍스트 안에서도 이 테이블을 쓸 수 있습니다. 그리고 테넌트마다 복제되지도 않습니다. 자세한 내용은 [공유 테이블](#공유-테이블-엔티티를-스키마에-고정하기)을 참고하세요.

### 상속 계층

테넌트 컬럼은 공유 행을 실제로 저장하는 테이블을 따라갑니다. 그래서 위치가 [상속 전략](./inheritance-mapping.md)마다 달라집니다.

| 전략 | 컬럼이 놓이는 곳 | 자식 엔티티의 범위 적용 방식 |
|------|------------------|---------------------------|
| `SINGLE_TABLE` | 공유 테이블에 한 번, `NOT NULL` | 루트와 같은 조건을 씁니다 |
| `JOINED` | 루트 테이블에만 둡니다. 자식 테이블은 자기 컬럼과 키만 가집니다 | 자식 INSERT가 루트 행에 테넌트를 기록합니다. 루트를 JOIN하는 읽기는 루트 컬럼으로 필터합니다. 자식 테이블만 대상으로 하는 SQL 문(`count`, `exists`, 집계, 쿼리 빌더, `delete`의 자식 쪽)은 `pk IN (SELECT pk FROM root WHERE tenant_id = ?)`로 필터합니다 |
| `TABLE_PER_CLASS` | 모든 콘크리트 테이블 | 테이블마다 자기 조건을 가집니다. 다형 루트 읽기는 각 브랜치에서 실제 컬럼을 투영합니다 |

이 컬럼은 해당 전략을 쓰는 연결이 살아 있는 동안에만 엔티티 메타데이터에 추가됩니다. `propagateShutdown()`은 이 컬럼을 메타데이터에서 다시 제거합니다. 그래서 그 뒤에 `tenantStrategy: "tenant_column"` 없이 등록한 연결은 이 컬럼 없이 테이블을 만들고 씁니다. 같은 엔티티 클래스를 공유하면서 전략이 서로 다른 연결 두 개를 동시에 띄우는 것은 지원하지 않습니다. 두 연결이 클래스 메타데이터를 공유하기 때문입니다.

### 탈출구: `runUnscoped()`

정말로 모든 테넌트를 가로질러 조회해야 할 때도 있습니다. 청구 리포트, 야간 배치 작업, 데이터 익스포트가 그렇습니다. 이런 코드를 `MetadataContext.runUnscoped()`로 감싸면 WHERE 주입을 건너뜁니다.

```typescript
import { MetadataContext } from "@stingerloom/orm";

await MetadataContext.runUnscoped(async () => {
  const allPosts = await em.find(Post);
  // → SELECT ... FROM post           ← 테넌트 필터 없음
});
```

`runUnscoped()`는 읽기에만 적용됩니다. INSERT에는 여전히 테넌트 컨텍스트가 필요합니다. `run("acme", …)` 블록 안에서 호출한 `runUnscoped()`는 `acme`로 INSERT합니다. 어떤 `run()`에도 속하지 않은 곳에서 호출하면 채울 값이 없으므로 `MISSING_TENANT_CONTEXT`를 던집니다. 이 비대칭은 의도한 것입니다. 관리자의 읽기는 안전하지만 테넌트가 정해지지 않은 관리자의 쓰기는 안전하지 않기 때문입니다.

### 쿼리 단위 opt-out

`runUnscoped()`는 컨텍스트 전체에 적용됩니다. 특정 쿼리 하나만 필터를 우회해야 한다면 쿼리 단위 opt-out을 쓰세요.

```typescript
// FindOption
await em.find(Post, { withoutTenantScope: true });

// SelectQueryBuilder
await em.createQueryBuilder(Post, "p")
  .withoutTenantScope()
  .getMany();
```

쿼리 단위 플래그는 읽기에만 적용됩니다. `updateMany`, `deleteMany`, `softDelete`, `restore`는 이 플래그를 의도적으로 지원하지 않습니다. 실수로 다른 테넌트에 쓰는 일을 막으려는 것입니다. 테넌트를 넘나드는 쓰기에는 한 줄짜리 리팩터링으로 켜지는 플래그가 아니라 명시적인 `runUnscoped()` 블록이 필요합니다.

### 컨텍스트 부재: `tenantOnMissingContext`

위의 WHERE 주입이 어떤 테넌트를 바인딩할지 정하려면 활성화된 `MetadataContext.run()`이 필요합니다. 큐 워커, 크론 작업, 테넌트 미들웨어를 빠뜨린 라우트처럼 컨텍스트 바깥에서 실행되는 코드에는 테넌트가 없습니다. 그러면 조건을 만들지 못하고 그 쿼리는 모든 테넌트의 행을 대상으로 합니다. INSERT는 이 상태에서 처음부터 `MISSING_TENANT_CONTEXT`로 실패했습니다. 하지만 읽기, 갱신, 삭제는 지금까지 필터 없이 실행되면서도 로그를 한 줄도 남기지 않았습니다.

`tenantOnMissingContext` 옵션은 이때의 동작을 제어합니다.

```typescript
await em.register({
  // ...
  tenantStrategy: "tenant_column",
  tenantOnMissingContext: "throw",
});
```

| 정책 | 테넌트 컨텍스트가 없을 때의 동작 |
|------|--------------------------------|
| `"warn"` (기본값) | 쿼리는 필터 없이 실행됩니다. ORM은 엔티티 클래스마다 경고를 한 번 남깁니다. 경고 없이 실행되던 이전 동작과 호환됩니다. |
| `"throw"` | INSERT와 같은 에러인 `MISSING_TENANT_CONTEXT`로 거부합니다. 프로덕션에 권장합니다. |
| `"allow"` | 쿼리를 필터 없이 경고도 남기지 않고 실행합니다. 테넌트 범위 접근과 전역 접근을 의도적으로 섞어 쓰는 앱에 맞는 값입니다. |

이 정책은 자동 조건을 받는 모든 경로에 적용됩니다. `find*`, `count`와 `exists`를 포함한 집계, `SelectQueryBuilder`, 관계 로더, `updateMany`, `deleteMany`, `softDelete`, `restore`, 그리고 `save()` / `saveMany()`의 UPDATE 분기가 그 경로입니다. INSERT의 동작은 바꾸지 않습니다. INSERT는 컨텍스트가 없으면 항상 에러를 던집니다. 그리고 다음과 같은 명시적인 탈출구에서는 이 정책이 동작하지 않습니다.

- `MetadataContext.runUnscoped()`: 명시적으로 테넌트를 넘나드는 블록
- `MetadataContext.run("public", ...)`: 명시적인 관리자·부트스트랩 컨텍스트
- 쿼리 단위 `withoutTenantScope` 플래그
- `@NonTenantEntity()` 엔티티

기본값은 하위 호환성을 위해 `"warn"`입니다. 다음 메이저 버전에서 `"throw"`로 바뀝니다. 새 프로젝트라면 처음부터 `"throw"`를 설정하세요.

#### 컨텍스트 없는 백그라운드 작업

큐 워커나 크론 작업은 보통 한 번에 한 테넌트의 데이터를 처리합니다. 작업 페이로드에서 테넌트를 읽어 핸들러를 감싸세요. 그러면 일반 요청과 똑같이 테넌트 범위가 적용됩니다.

```typescript
worker.process(async (job) => {
  await MetadataContext.run(job.data.tenantId, async () => {
    await em.updateMany(Post, { published: true }, { where: { id: job.data.postId } });
  });
});
```

야간 익스포트나 전역 backfill처럼 정말로 테넌트를 가로지르는 유지보수 작업이라면 `runUnscoped()`로 의도를 명시하세요. `runUnscoped()`는 `"throw"`를 포함한 모든 정책에서 통과합니다.

```typescript
cron.schedule("0 3 * * *", () =>
  MetadataContext.runUnscoped(async () => {
    const allPosts = await em.find(Post); // 의도적으로 필터 없음
  }),
);
```

### Raw SQL 경고

ORM은 자기가 빌드한 쿼리에 테넌트 조건을 주입합니다. 하지만 `em.query("SELECT * FROM post")`를 직접 호출하면 Stingerloom이 SQL을 고쳐 쓰지 못합니다. 이때 `WHERE` 절은 개발자가 직접 책임져야 합니다. 테넌트 컨텍스트가 활성인 상태에서 호출 지점마다 `em.query()`를 처음 실행하면 ORM이 다음 경고를 남깁니다.

```
[multi-tenancy] em.query() called under tenant="acme" — raw SQL bypasses
automatic WHERE tenant_id injection. Filter by the tenant column manually,
or wrap the call in MetadataContext.runUnscoped() when cross-tenant access
is intended. Call site: at MyService.rawReport (src/my-service.ts:42:23)
```

호출 지점은 `em.query()`를 호출한 줄입니다. 번들로 빌드한 앱에서도 마찬가지입니다. ORM은 호출 지점 단위로 경고의 중복을 제거합니다. 그래서 자주 실행되는 루프에서도 수천 번이 아니라 한 번만 찍힙니다. 쿼리 빌더가 내부에서 `em.query()`로 실행하는 SQL 문은 이미 테넌트 조건을 담고 있으므로 경고하지 않습니다. `getMany()`, `getCount()`, `paginate()`, `stream()`, `prepare()`, `explain()` 등이 여기에 해당합니다.

ORM은 SQL 내용을 읽지 않습니다. 그래서 `tenant_id`로 직접 거르는 SQL 문이라도 경고가 뜹니다. 그런 호출이나 의도적으로 테넌트를 넘나드는 읽기는 `runUnscoped()`로 감싸 경고를 끄세요. 어느 쪽이든 raw SQL 문은 작성한 그대로 실행됩니다.

### 1차 캐시 격리

이 전략에서 Stingerloom의 Identity Map(WriteBuffer)은 캐시 키 앞에 현재 테넌트를 붙입니다. 그래서 테넌트 "acme"에서 `em.findByPK(Post, 1)`을 호출해도 테넌트 "globex"의 캐시된 행을 절대 반환하지 않습니다. `runUnscoped()` 안에서는 identity 캐시를 아예 건너뜁니다. 테넌트를 가로질러 읽을 때는 기본 키만으로는 행을 하나로 특정하지 못하기 때문입니다.

### Stingerloom이 RLS를 지원하지 않는 이유

PostgreSQL의 Row-Level Security(RLS, `CREATE POLICY`)는 `tenant_column`보다 안전한 방식으로 가끔 제안됩니다. ORM 대신 데이터베이스가 조건을 강제하기 때문입니다. 하지만 Stingerloom은 의도적으로 RLS를 지원하지 않습니다.

- **PostgreSQL 전용.** `tenant_column`을 고르는 주된 이유는 다이얼렉트 이식성입니다. RLS는 이 이유를 없애 버립니다.
- **플래너 함정.** `STABLE`이나 `LEAKPROOF`로 표시하지 않은 RLS 조건은 인덱스를 우회하고 플랜 캐시를 무효화할 수 있습니다. 이런 문제는 나중에 진단하기 어렵습니다.
- **범위 폭증.** `CREATE POLICY`는 ORM이 처음부터 끝까지 맡아야 하는 DDL입니다. 정책 생성, diff, 마이그레이션을 모두 맡아야 합니다. 다이얼렉트 하나의 기능 때문에 스키마 서브시스템의 표면적이 두 배로 커집니다.

PostgreSQL에서 데이터베이스가 강제하는 행 수준 격리가 필요하다면 Stingerloom과 별도로 DBA 레이어에서 RLS 정책을 적용하세요. ORM은 이 정책을 관리하지 않습니다.

---

## 전략 4: `database` (모든 다이얼렉트, 물리 격리)

`tenantStrategy: "database"`는 테넌트마다 자기만의 물리 데이터베이스를 줍니다. 풀도, DDL도, 백업 파일도 테넌트마다 따로 있습니다. ORM은 이 전략을 `MultiTenantEntityManager`라는 얇은 프록시로 제공합니다. 이 프록시는 호출마다 `MetadataContext.getCurrentTenant()`를 보고 알맞은 테넌트의 `EntityManager`에 위임합니다. 내부에서 각 테넌트는 `DatabaseClient`가 멀티 DB 설정에 이미 쓰는 이름 있는 연결(named connection) 기능 위에서 동작합니다. 그래서 이 전략은 쿼리 엔진을 깊게 다시 쓴 것이 아닙니다.

### 언제 선택하나요

다음 중 하나라도 해당하면 database 전략이 맞습니다.

- **컴플라이언스**: GDPR data residency, HIPAA enterprise tier, KISA처럼 물리 분리를 요구하는 경우입니다.
- **지리적 분산**: 테넌트마다 다른 지역의 DB 호스트를 쓰는 경우입니다. APAC 테넌트는 서울에, EU 테넌트는 프랑크푸르트에 두는 식입니다.
- **테넌트별 백업/복구 SLA**: `pg_dump tenant_acme` 한 번으로 한 테넌트의 데이터만 받아야 하는 경우입니다.
- **소수의 큰 enterprise 테넌트**: 보통 50곳 이하의 enterprise 고객입니다. free tier 계정 수천 개에는 맞지 않습니다.

저렴한 테넌트가 수천 개인 SaaS라면 `tenant_column`의 운영 비용이 훨씬 낮습니다. 엄격한 격리가 늘어나는 풀, 배포, 마이그레이션 비용만큼 가치가 있을 때만 `database`를 고르세요.

### 전략 활성화

```typescript
import { MultiTenantEntityManager, MetadataContext } from "@stingerloom/orm";

const em = new MultiTenantEntityManager();

await em.register({
  type: "postgres",
  database: "app_admin",          // 공유 admin / public DB
  username: "postgres",
  password: "postgres",
  host: "localhost",
  port: 5432,
  entities: [User, Post],
  synchronize: true,
  tenantStrategy: "database",
  tenantDatabaseResolver: (tenantId) => ({
    type: "postgres",
    database: `app_${tenantId}`,  // 테넌트마다 물리 DB
    username: "postgres",
    password: "postgres",
    host: "localhost",
    port: 5432,
    entities: [User, Post],
    synchronize: true,
  }),
});

await MetadataContext.run("acme", () => em.find(User));   // → app_acme DB
await MetadataContext.run("globex", () => em.find(User)); // → app_globex DB
```

같은 옵션이 MySQL과 SQLite에서도 동작합니다. 테넌트별 `type`과 `host`만 바꾸세요.

### Resolver vs. 정적 map

테넌트와 물리 DB의 매핑을 라우터에 알리는 방식은 두 가지입니다.

- **`tenantDatabaseResolver: (tenantId) => DatabaseClientOptions | string`**: 테넌트를 처음 쓸 때 한 번 호출됩니다. 전체 옵션 객체를 반환하면 라우터가 새 풀을 자동으로 프로비저닝합니다. 문자열을 반환하면 `DatabaseClient.connect()`로 미리 등록해 둔 이름 있는 연결을 씁니다. 실패는 캐시하지 않으므로 재시도하면 resolver를 다시 호출합니다.
- **`tenantDatabaseMap: Record<string, string>`**: 정적 매핑 객체입니다. resolver보다 먼저 검사합니다. 모든 테넌트를 배포 시점에 알 때 유용합니다.

둘을 함께 써도 됩니다. 같은 테넌트의 항목이 양쪽에 있으면 map이 우선합니다.

### Eager 프로비저닝

지연 해석은 개발 환경에서는 괜찮습니다. 하지만 프로덕션 트래픽이 첫 요청에서 콜드 스타트 비용을 치르면 안 됩니다.

```typescript
await em.register({
  // ...
  tenantStrategy: "database",
  tenantDatabaseResolver: (tenantId) => ({ /* ... */ }),
  eagerProvisionTenants: ["acme", "globex"],   // register() 시점에 해석
});
```

`eagerProvisionTenants`는 `register()`가 반환되기 전에 목록에 있는 테넌트마다 resolver를 실행하고 `synchronize`까지 마칩니다. 시작 시 헬스 체크와 함께 쓰세요.

### Public 컨텍스트 동작

쿼리가 `MetadataContext.run()` 블록 밖에서 `MultiTenantEntityManager`에 도달하면 이 전략에는 처리 정책이 필요합니다.

```typescript
publicTenantBehavior: "default"   // (기본값) admin / public EntityManager로 라우팅
publicTenantBehavior: "throw"     // MISSING_TENANT_CONTEXT로 거부
```

모든 요청에 테넌트가 *반드시* 설정되어야 하는 HTTP 서비스에서는 `"throw"`를 권장합니다. 그러면 컨텍스트 누락이 아무도 모르게 admin DB에 쓰는 대신 즉시 드러나는 버그가 됩니다.

### Cross-tenant 트랜잭션은 금지됩니다 {#cross-tenant-transactions-are-forbidden}

SQL 트랜잭션은 연결 하나에 묶이고 연결은 물리 DB 하나에 묶입니다. 그래서 트랜잭션 도중에 테넌트를 바꾸면 원자성(atomicity)을 보장하지 못합니다.

```typescript
await MetadataContext.run("acme", async () => {
  await em.transaction(async () => {
    await em.save(User, { name: "alice" });

    await MetadataContext.run("globex", async () => {
      // OrmErrorCode.CROSS_TENANT_TRANSACTION으로 에러를 던짐
      await em.save(User, { name: "carol" });
    });
  });
});
```

두 테넌트에 원자적으로 써야 한다면 그것은 멀티테넌트 문제가 아니라 분산 트랜잭션 문제입니다. 애플리케이션 레이어에서 saga나 outbox 패턴을 쓰세요.

PostgreSQL 스키마 전략은 모든 테넌트를 한 데이터베이스에 둡니다. 그래서 그 전략에서는 트랜잭션 하나가 여러 테넌트에 걸쳐도 됩니다. 자세한 내용은 [트랜잭션 안에서 테넌트 바꾸기](#switching-tenants-inside-a-transaction)를 참고하세요.

### 관리 작업: `forEachTenant`

대시보드, 감사, 마이그레이션처럼 모든 테넌트를 대상으로 작업해야 할 때 씁니다.

```typescript
const counts = await em.forEachTenant(async (tenantEm, tenantId) => ({
  tenantId,
  total: await tenantEm.count(User),
}));
// → [{ tenantId: "acme", value: { tenantId: "acme", total: 142 } }, ...]
```

세 가지 모드를 지원합니다.

- `"all"` (기본값): `Promise.all`을 쓰고 첫 실패에서 에러를 던집니다.
- `"settled"`: `Promise.allSettled`를 쓰고 테넌트마다 `{ value }`나 `{ error }`를 반환합니다.
- `"sequential"`: 한 번에 테넌트 하나씩 차례로 실행합니다. 공유 인프라에 부담을 주지 않으려는 경우에 유용합니다.

`forEachTenant`는 라우터가 이미 해석한 테넌트만 순회합니다. 지연 해석만 하는 테넌트는 먼저 한 번 사용하거나 미리 프로비저닝해 두어야 합니다.

### NestJS 통합

```typescript
import { Module, Injectable } from "@nestjs/common";
import { MultiTenantEntityManager } from "@stingerloom/orm";
import {
  StingerloomOrmModule,
  InjectMultiTenantEntityManager,
} from "@stingerloom/orm/nestjs";

@Module({
  imports: [
    StingerloomOrmModule.forRoot({
      type: "postgres",
      database: "app_admin",
      // ...
      tenantStrategy: "database",
      tenantDatabaseResolver: (id) => ({ /* ... */ }),
    }),
  ],
})
class AppModule {}

@Injectable()
class UserService {
  constructor(
    @InjectMultiTenantEntityManager()
    private readonly em: MultiTenantEntityManager,
  ) {}

  async listUsers() {
    // 미들웨어가 테넌트 컨텍스트를 채우면 알맞은 DB로 라우팅됩니다.
    return this.em.find(User);
  }
}
```

`@InjectEntityManager()`도 그대로 동작합니다. `tenantStrategy: "database"`에서는 `MultiTenantEntityManager`가 가진 admin / public `EntityManager`로 해석됩니다. 그래서 전역 테이블을 다룰 때 알맞습니다.

### Connection pool 예산

물리 격리의 단점은 연결 풀이 테넌트 수만큼 *불어난다*는 점입니다. 테넌트 50개에 `pool.max: 10`이면 DB 서버에 연결 500개를 요구합니다. 그런데 PostgreSQL의 기본 `max_connections`는 100입니다. 다음처럼 보수적으로 설정하세요.

- 테넌트마다 `pool.max`를 5 정도로 작게 잡습니다.
- `tenantConnectionTtlMs`로 유휴 테넌트 풀을 비우고 필요할 때 다시 만듭니다.
- `DatabaseClient.getInstance().getRegisteredNames().length`를 모니터링해서 등록된 연결 수가 예상보다 늘어나는 시점을 알아챕니다.

### Raw SQL은 안전합니다 (경고 없음)

격리를 연결 수준에서 강제하므로 `em.query("SELECT * FROM user")`는 항상 현재 테넌트의 DB만 봅니다. `tenant_column`의 raw SQL 경고는 이 전략에서 나오지 않습니다. 우회할 `WHERE tenant_id = ?` 자체가 없기 때문입니다.

---

## 레이어드 메타데이터가 테넌트를 격리하는 방식

위의 테넌트 전략은 레이어드 메타데이터 저장소 위에서 동작합니다. Docker OverlayFS와 같은 오버레이 방식입니다. 모든 `@Entity`/`@Column`/`@ManyToOne` 데코레이터는 `"public"` 레이어에 기록합니다. 테넌트 컨텍스트는 그 위에 자기 레이어를 가질 수 있습니다. 조회는 테넌트 레이어를 먼저 읽고 값이 없으면 public 레이어로 넘어갑니다.

이 저장소는 내부 구현이므로 패키지가 export하지 않습니다. 그래서 테넌트별 메타데이터 덮어쓰기는 공개 API가 아닙니다. 특정 테넌트만 다른 테이블 이름을 쓰는 것이 그 예입니다. 공개 API는 컨텍스트 전환인 `MetadataContext.run()`과 그 위에 만든 테넌트 전략을 제공합니다.

### 격리 보장

`MetadataContext.run("acme_corp", ...)` 안에서의 조회는 public 레이어와 `acme_corp` 레이어만 병합합니다. 다른 테넌트의 레이어는 절대 포함하지 않습니다. 그래서 여러 테넌트가 동시에 활성화되어 있어도 한 테넌트의 메타데이터가 다른 테넌트로 새지 않습니다.

```
MetadataContext.run("acme_corp", ...) 안에서 조회할 때
  → public layer + acme_corp layer  (포함)
  → globex layer                    (제외)
  → initech layer                   (제외)
```

---

## 중요한 설계 규칙

**전역 상태 없음.** 모든 테넌트 식별은 `AsyncLocalStorage`를 거칩니다. 그래서 동시 요청에서도 안전합니다. 한 요청이 다른 요청의 전역 변수를 실수로 덮어쓰는 일은 없습니다.

**Public 레이어는 읽기 전용.** `@Entity`와 `@Column` 데코레이터로 등록된 엔티티 메타데이터는 public 레이어에 저장됩니다. 이 레이어는 런타임에 수정하지 못합니다. 쓰기는 테넌트 레이어에만 허용합니다.

**컨텍스트 자동 복원.** `MetadataContext.run()` 블록 밖에서는 컨텍스트가 자동으로 `"public"`으로 돌아갑니다. 테넌트 컨텍스트가 다음 요청으로 새어 나갈 위험이 없습니다.

**`setContext()`는 deprecated.** 초기 버전의 ORM은 전역 테넌트 상태를 설정하는 `setContext()` 메서드를 썼습니다. 이 메서드는 동시 요청에서 위험합니다. 대신 항상 `MetadataContext.run()`을 쓰세요. `MetadataContext.run()`은 `AsyncLocalStorage`로 컨텍스트의 범위를 콜백 안으로 한정합니다.

---

## 예제 프로젝트

완전한 NestJS 멀티테넌시 예제가 `examples/nestjs-multitenant/`에 있습니다. 이 예제는 미들웨어 설정, 스키마 프로비저닝, 테넌트별로 격리된 CRUD 작업을 보여 줍니다.

```bash
cd examples/nestjs-multitenant
pnpm install
pnpm start
```

---

## 다음 단계

- [설정](./configuration.md): 풀링, 읽기 레플리카 같은 운영 설정
- [마이그레이션](./migrations.md): 프로덕션 스키마 관리
- [고급 기능 모음](./advanced.md): 이벤트 시스템, N+1 감지, 성능 최적화
