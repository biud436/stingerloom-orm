# Multi-Tenancy

## 문제 상황

SaaS 제품을 만든다고 생각해 봅시다. 수백 개의 회사가 사용하는 프로젝트 관리 도구입니다. A 회사에는 직원이 50명, B 회사에는 200명이 있고, 두 회사 모두 같은 서버, 같은 데이터베이스를 사용합니다.

하지만 A 회사는 **절대** B 회사의 데이터를 볼 수 없어야 합니다. API 응답에서도, DB 쿼리에서도, 버그로 인한 우연한 노출도 허용되지 않아야 하죠. 이게 바로 **멀티테넌시**입니다 — 하나의 애플리케이션 안에 여러 고객(테넌트)을 격리하는 것입니다.

일반적으로 네 가지 접근 방식이 있습니다:

1. **DB 분리** — 테넌트마다 별도의 물리 DB. 격리는 가장 강하지만 운영 비용이 가장 높습니다.
2. **DB 공유, 스키마 분리** — DB는 하나지만 테넌트마다 별도 네임스페이스(스키마)를 사용합니다. 격리와 효율의 균형이 좋습니다.
3. **전부 공유** — DB 하나, 스키마 하나, 모든 테이블에 `tenant_id` 컬럼. 가장 저렴하지만 WHERE 절 하나 빠지면 데이터가 유출됩니다.
4. **DB 분리 + 라우팅 레이어** — #1과 형태는 같지만 ORM이 `MetadataContext` 기반으로 매 요청을 알맞은 풀에 자동 라우팅합니다.

Stingerloom ORM은 네 가지를 모두 지원합니다:

- **#2 (스키마 기반)** — `search_path` / `schema_qualified` 전략 (PostgreSQL 전용), **레이어드 메타데이터 시스템** 위에서 동작합니다.
- **#3 (컬럼 기반)** — `tenant_column` 전략 (모든 다이얼렉트).
- **#1 / #4 (DB 기반)** — `database` 전략 + `MultiTenantEntityManager` (모든 다이얼렉트).

---

## 작동 원리 — OverlayFS 비유

Docker를 사용해 보셨다면, 컨테이너가 베이스 이미지를 공유하면서 각자 쓰기 가능한 레이어를 갖는 구조에 익숙하실 겁니다. 변경 사항은 최상위 레이어에 기록되고 베이스는 그대로 유지됩니다. 파일을 읽을 때는 최상위 레이어를 먼저 확인하고, 없으면 베이스로 폴백합니다.

Stingerloom의 메타데이터 시스템도 같은 방식입니다:

```
┌──────────────────────────────────────────────┐
│  Tenant Layer  (read / write)                │  ← Per-tenant overrides
│  e.g., "acme_corp" has a custom table name   │    (Copy-on-Write)
├──────────────────────────────────────────────┤
│  Public Layer  (read-only)                   │  ← Base schema definitions
│  @Entity, @Column decorators register here   │    (shared by all tenants)
└──────────────────────────────────────────────┘
```

**메타데이터 읽기:** 테넌트 레이어를 먼저 확인하고, 없으면 public 레이어로 폴백합니다.

**메타데이터 쓰기:** 항상 테넌트 레이어에 기록합니다. Public 레이어는 런타임에 절대 수정되지 않습니다. Docker OverlayFS와 동일한 Copy-on-Write 원칙입니다.

핵심은 **이걸 직접 신경 쓸 필요가 없다**는 점이에요. "이 요청이 어떤 테넌트에 속하는지"만 설정하면, ORM이 자동으로 올바른 스키마로 쿼리를 라우팅해 줍니다.

---

## 테넌트 컨텍스트 설정

SaaS 앱에서 모든 HTTP 요청은 특정 테넌트에 속합니다. ORM에게 어떤 테넌트인지 알려주려면 `MetadataContext.run()`을 사용합니다:

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

`MetadataContext.run()`은 Node.js의 `AsyncLocalStorage`를 사용합니다. 파라미터로 넘기지 않아도 전체 async 호출 체인에 컨텍스트를 전파해 주는 내장 메커니즘이죠. async JavaScript의 "thread-local 변수"라고 생각하면 됩니다.

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

콜 스택이 아무리 깊어져도 — controller → service → repository → EntityManager — `AsyncLocalStorage`를 통해 테넌트 컨텍스트를 항상 가져올 수 있습니다. `tenantId`를 함수 파라미터로 일일이 넘길 필요가 없어요.

### 현재 컨텍스트 확인

```typescript
const tenant = MetadataContext.getCurrentTenant();
// "acme_corp" inside run(), "public" outside

const isActive = MetadataContext.isActive();
// true inside run(), false outside
```

### 동시성 안전

각 HTTP 요청은 고유한 `AsyncLocalStorage` 컨텍스트를 가집니다. "acme_corp"과 "globex" 요청이 정확히 같은 밀리초에 들어와도 각각 다른 테넌트 ID를 보게 됩니다. 덮어쓸 수 있는 공유 전역 변수 같은 건 존재하지 않습니다.

```
Request A (acme_corp)  ──────────────────────────►  sees "acme_corp" throughout
Request B (globex)     ──────────────────────────►  sees "globex" throughout
                       ↑ concurrent, but isolated
```

---

## NestJS 미들웨어로 자동 설정

실제 애플리케이션에서는 매 요청마다 `MetadataContext.run()`을 직접 호출하지 않습니다. 대신 미들웨어를 사용해서 HTTP 요청에서 테넌트를 추출하고, 전체 요청 라이프사이클을 테넌트 컨텍스트로 감싸면 됩니다.

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

이렇게 하면 NestJS 앱의 모든 controller와 service가 자동으로 올바른 테넌트 컨텍스트에서 실행됩니다. 비즈니스 로직은 손댈 필요가 없어요:

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

`X-Tenant-Id` 헤더가 가장 간단하지만, 프로덕션에서는 다른 방법도 사용할 수 있습니다:

| 소스 | 예시 | 사용 시점 |
|------|------|----------|
| HTTP 헤더 | `X-Tenant-Id: acme_corp` | 내부 API, 마이크로서비스 |
| 서브도메인 | `acme.yourapp.com` | 고객 대면 앱 |
| JWT claim | `{ tenantId: "acme_corp" }` | 토큰 기반 인증 |
| URL 경로 | `/tenants/acme_corp/users` | 명시적 스코핑이 있는 REST API |

어떤 방법을 쓰든 미들웨어 패턴은 동일합니다 — 테넌트 ID를 추출하고 `MetadataContext.run()`에 넘기면 됩니다.

---

## PostgreSQL 스키마 기반 격리

지금까지 쿼리 라우팅에 대해 이야기했는데, 정작 테넌트 데이터는 실제로 어디에 저장될까요? PostgreSQL 스키마를 사용하면 각 테넌트가 모든 테이블의 복사본을 포함하는 별도의 네임스페이스를 갖게 됩니다.

PostgreSQL 스키마는 파일시스템의 폴더라고 생각하면 됩니다:

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

각 스키마는 자체 `user` 테이블을 갖고, 자체 데이터를 포함합니다. `acme_corp.user`와 `globex.user`는 완전히 별개입니다 — 데이터, 인덱스, 시퀀스가 모두 다릅니다.

### TenantMigrationRunner로 테넌트 스키마 생성

`PostgresTenantMigrationRunner`는 테넌트 스키마 생성을 자동화합니다. public 스키마의 테이블 구조를 새 테넌트 스키마로 복제해 줍니다.

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

이렇게 하면 다음 SQL이 실행됩니다:

```sql
-- 1. Create the schema
CREATE SCHEMA IF NOT EXISTS "acme_corp";

-- 2. Clone each table's structure from public (including indexes, constraints, defaults)
CREATE TABLE IF NOT EXISTS "acme_corp"."user"
  (LIKE "public"."user" INCLUDING ALL);

CREATE TABLE IF NOT EXISTS "acme_corp"."post"
  (LIKE "public"."post" INCLUDING ALL);
```

`INCLUDING ALL`은 컬럼, 인덱스, 제약 조건, 기본값, 시퀀스를 모두 복사합니다 — 데이터만 빼고요. 테넌트는 모든 테이블의 빈 복사본으로 시작합니다.

`ensureSchema()`는 멱등(idempotent)입니다 — 같은 테넌트에 두 번 호출해도 두 번째 호출은 아무것도 하지 않습니다. 내부적으로 advisory lock을 사용해서, 여러 프로세스가 동시에 같은 스키마를 생성하려는 race condition도 방지합니다.

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

### NestJS에서 자동 프로비저닝

앱 시작 시 알려진 모든 테넌트를 프로비저닝하는 서비스를 만들 수 있습니다:

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
스키마 기반 멀티테넌시는 현재 PostgreSQL에서만 지원됩니다. MySQL은 데이터베이스와 별개의 스키마 개념이 없고, SQLite는 스키마 자체를 지원하지 않습니다. MySQL이나 SQLite에서 `TenantMigrationRunner`를 사용하면 `UnsupportedError`가 발생합니다.
:::

---

## 테넌트 쿼리 전략

테넌트 컨텍스트 안에서 쿼리가 실행되면, ORM이 올바른 곳 — 스키마, 컬럼 predicate, 또는 물리 데이터베이스 — 으로 라우팅해야 합니다. 네 가지 전략이 있고, 선택에 따라 성능 / 격리 강도 / 운영 비용이 달라집니다.

### 한눈에 보기

| 항목 | `search_path` | `schema_qualified` | `tenant_column` | `database` |
|---|---|---|---|---|
| Dialect 지원 | PostgreSQL 전용 | PostgreSQL 전용 | 전 dialect (MySQL/PG/SQLite) | 전 dialect |
| 격리 수준 | 스키마 | 스키마 | row (predicate) | **물리 DB** |
| read 라운드 트립 | ~5 (BEGIN/SET LOCAL/...) | 1 | 1 | 1 |
| Connection pool | 1개 공유 | 1개 공유 | 1개 공유 | **N개 (테넌트마다)** |
| 신규 테넌트 비용 | `CREATE SCHEMA` | `CREATE SCHEMA` | 무료 | **`CREATE DATABASE`** |
| Cross-tenant join | OK (같은 DB) | OK (같은 DB) | OK (`tenant_id` 필터) | 불가능 (다른 DB) |
| 지원 테넌트 수 | 100~1k | 100~1k | 1k+ | ~50 (pool 예산) |
| 지리 / 컴플라이언스 분리 | 미지원 | 미지원 | 미지원 | 지원 |
| 테넌트별 백업/복구 | DB 단위 | DB 단위 | DB 단위 | **간단** |
| 운영 복잡도 | 낮음 | 낮음 | 가장 낮음 | **가장 높음** |

### "라운드 트립"이란?

라운드 트립은 애플리케이션과 PostgreSQL 서버 사이의 한 번의 요청-응답 사이클입니다. 각 라운드 트립마다 최소 한 번의 네트워크 지연이 발생합니다. DB가 10ms 거리에 있다면, 5번의 라운드 트립 = 데이터를 받기도 전에 50ms의 오버헤드가 생기는 셈이죠.

### 전략 1: `"search_path"` (기본값)

PostgreSQL에는 `search_path`라는 세션 변수가 있습니다. 스키마가 명시되지 않은 테이블 이름이 어떤 스키마를 가리키는지 결정하는 변수입니다. 이 전략은 각 테넌트 쿼리 전에 트랜잭션 안에서 `search_path`를 설정합니다.

```typescript
await em.register({
  type: "postgres",
  // ...
  tenantStrategy: "search_path",  // default — can be omitted
});
```

`MetadataContext.run("acme_corp", ...)` 블록 안에서 `em.find(User)`를 실행하면, 네트워크 레벨에서 다음과 같은 일이 일어납니다:

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

단일 테넌트 읽기에 4번의 라운드 트립이 필요합니다 (connect + BEGIN + SET LOCAL + SELECT + COMMIT). `SET LOCAL`은 search_path 변경이 이 트랜잭션에만 적용되도록 보장합니다 — 다른 커넥션에는 영향을 주지 않아요.

**장점:** PostgreSQL에서 잘 정립된 패턴입니다. pg_dump, 모니터링 등 기존 도구와 자연스럽게 호환됩니다.

**단점:** 모든 테넌트 읽기에 트랜잭션 래핑이 필요해서 지연이 추가됩니다.

#### 테넌트 마커는 유효한 PG 식별자여야 합니다

`search_path`가 기본 전략이기 때문에, `MetadataContext.run(<value>)`에 넘긴 값이 그대로 PostgreSQL 스키마 이름으로 사용됩니다 (`SET LOCAL search_path TO "<value>"`). 즉 마커는 유효한 PG 식별자여야 합니다 — 알파벳·숫자·언더스코어·하이픈·`$`만 허용되며, 시작 문자는 알파벳 또는 언더스코어여야 합니다.

식별자 검증을 통과하지 못하는 값(예: `"12345"` 같은 순수 숫자 workspace id)을 넘기면, 커넥터는 모든 트랜잭션을 중단하는 대신 `SET LOCAL`을 **skip하고** 유니크한 invalid 마커당 한 번씩 경고를 남깁니다:

```
WARN [PostgresConnector] MetadataContext tenant "12345" is not a valid
PostgreSQL identifier — skipping SET LOCAL search_path. If you intended
schema-based isolation, set tenantStrategy:"schema_qualified" or use a
schema-name tenant marker. If you use MetadataContext only for app-side
context, set tenantStrategy:"tenant_column" to silence this warning.
```

세 가지 해결 경로가 있습니다:

1. **스키마 이름 형태의 마커로 바꿉니다.** 숫자 id를 prefix와 함께 감싸서 동일한 문자열을 스키마 이름으로도 사용하세요: `MetadataContext.run(\`tenant_${workspaceId}\`, ...)`.
2. **`schema_qualified`로 전환합니다.** 동일한 격리 모델이지만 `SET LOCAL` 라운드 트립이 없고, 마커에 대한 식별자 규칙은 동일하게 적용됩니다.
3. **`tenant_column`(또는 `database`)으로 전환합니다.** `MetadataContext.run()`을 순전히 앱 컨텍스트 마커로만 사용하고 있다면 — 즉 활성 workspace를 subscriber·감사 로그·row-level guard에 노출하기 위해 열고 있고 실제 격리는 컬럼 레벨에서 강제하고 있다면 — 그 의도를 전략으로 명시하세요. 그러면 커넥터는 더 이상 `search_path`를 건드리지 않습니다.

### 전략 2: `"schema_qualified"`

search_path를 변경하는 대신, 테이블 이름 앞에 스키마 이름을 직접 붙이는 방식입니다:

```typescript
await em.register({
  type: "postgres",
  // ...
  tenantStrategy: "schema_qualified",
});
```

`MetadataContext.run("acme_corp", ...)` 안에서 `em.find(User)`를 실행하면:

```
App                                    PostgreSQL
 │                                          │
 ├─── SELECT * FROM "acme_corp"."user" ──► │
 │◄── rows ─────────────────────────────── │
```

단 1번의 라운드 트립입니다 (커넥션 제외). 단순 읽기에는 트랜잭션이 필요 없습니다.

```sql
-- With schema_qualified strategy, tenant context = "acme_corp":
SELECT * FROM "acme_corp"."user"

-- With schema_qualified strategy, tenant context = "public" (or no context):
SELECT * FROM "user"
```

**장점:** 더 빠릅니다. 읽기에 불필요한 트랜잭션 오버헤드가 없습니다.

**단점:** 실질적으로 없습니다 — SQL이 약간 다를 뿐 두 전략 모두 동일한 결과를 만들어요.

### 성능 비교

| 시나리오 | `search_path` | `schema_qualified` |
|---------|:-------------:|:------------------:|
| 테넌트 읽기 (라운드 트립) | 4-5 | **1-2** |
| 비테넌트 읽기 | 1-2 | 1-2 |
| 쓰기 작업 | 트랜잭션 (동일) | 트랜잭션 (동일) |
| 결과 정확성 | 동일 | 동일 |

**`schema_qualified`를 선택해야 할 때:** 테넌트 스코프 쿼리가 많은 읽기 위주 앱 — 대부분의 SaaS 앱이 여기에 해당됩니다. 네트워크 지연이 10ms라면, 단일 테넌트 읽기의 오버헤드가 약 40ms (search_path)에서 약 10ms (schema_qualified)로 줄어듭니다.

두 전략 모두 동일한 결과를 만듭니다. 차이는 순수하게 성능에만 있어요. search_path를 써야 하는 특별한 이유(예: 스키마 한정 이름을 지원하지 않는 도구와의 호환)가 없다면, **`schema_qualified`가 더 나은 기본값**입니다.

### 프로그래밍 방식 접근

커스텀 미들웨어나 테스트 같은 고급 사용 사례를 위해 전략 클래스가 export 되어 있습니다:

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

스키마 기반 격리는 PostgreSQL이 필요합니다. 앱이 MySQL이나 SQLite에서 돌아가거나, 테넌트 수가 수천 개로 불어나서 테넌트당 스키마 하나씩 만드는 게 카탈로그와 마이그레이션 부담이 되기 시작한다면, 세 번째 옵션이 있습니다 — 모든 테넌트의 행을 같은 테이블에 넣고 디스크리미네이터 컬럼으로 구분하는 방식입니다.

처음에 소개한 **#3** 접근입니다 — DB 하나, 스키마 하나, 테넌트 범위 테이블마다 `tenant_id` 컬럼. 전통적으로 이 방식은 위험합니다. `WHERE tenant_id = ?` 하나 빠뜨리면 다른 테넌트 데이터가 누출되니까요. Stingerloom은 이를 안전하게 만듭니다 — 모든 read / update / delete에 predicate를 자동으로 주입하고, 모든 insert에서 이를 검증하며, 의도적인 크로스 테넌트 접근이 필요한 관리자 케이스에는 명시적인 탈출구를 제공합니다.

### 언제 `schema_qualified` 대신 선택해야 하나요?

| 항목 | `schema_qualified` (전략 2) | `tenant_column` (전략 3) |
|---|---|---|
| 다이얼렉트 지원 | PostgreSQL만 | MySQL, PostgreSQL, SQLite |
| 새 테넌트 온보딩 | 모든 테이블마다 `CREATE SCHEMA` + `CREATE TABLE (LIKE …)` | 없음 — 첫 INSERT가 `tenant_id`를 채움 |
| 스키마 변경 | 모든 테넌트 스키마에 각각 적용 | 한 번 적용하면 모든 테넌트가 즉시 반영 |
| `pg_catalog` 부하 | N 테이블 × M 테넌트 | 전체 N 테이블 |
| 일반적인 테넌트 수 | 수십 ~ 수백 개 | 수천 개 이상 |
| 격리 경계 | PostgreSQL 스키마 (DB 수준 강제) | ORM이 강제하는 WHERE 절 |
| Raw SQL 안전성 | `search_path`나 qualified 이름으로 이미 스코프됨 | **수동으로 predicate를 포함해야 함** |

`schema_qualified`는 DB 수준의 더 강한 격리를 제공합니다. 잘못된 컨텍스트에서 raw `SELECT * FROM user`를 실행하면 다른 테넌트의 데이터가 아니라 잘못된 스키마를 조회하게 됩니다. `tenant_column`은 그런 강한 경계를 내주는 대신, 테넌트당 DDL 없이 수천 개의 테넌트로 확장되는 단일 공유 스키마를 얻습니다.

### 전략 활성화

```typescript
await em.register({
  type: "mysql",            // "postgres" / "sqlite" 도 가능
  // ...
  entities: [User, Post, Invoice],
  synchronize: true,
  tenantStrategy: "tenant_column",
  tenantColumnName: "tenant_id",   // optional — "tenant_id" is the default
  tenantColumnType: "varchar",     // optional — "varchar" | "uuid" | "int" | "bigint"
  tenantColumnLength: 64,          // optional — varchar 에만 적용
});
```

### 자동으로 일어나는 일

`tenantStrategy: "tenant_column"`을 설정하면, 엔티티별 코드 없이도 ORM이 모든 엔티티에 네 가지 동작을 적용합니다:

1. **DDL 주입.** `SchemaRegistrar`가 모든 테이블에 `tenant_id VARCHAR(64) NOT NULL` (또는 설정된 타입)을 추가합니다. 엔티티 클래스에 컬럼을 선언할 필요가 없습니다.
2. **INSERT 자동 채움 + 검증.** `save()` / `saveMany()` / `insertMany()` / `upsert()` / `batchUpsert()`가 `MetadataContext.getCurrentTenant()` 값으로 `tenant_id`를 채웁니다. 테넌트 컨텍스트 없이 INSERT 하면 `MISSING_TENANT_CONTEXT`를 던지고, 컨텍스트와 다른 `tenant_id`를 명시적으로 넘기면 `TENANT_MISMATCH`를 던집니다.
3. **read WHERE 주입.** `find()`, `findOne()`, `findByPK()`, `findAndCount()`, `findWithCursor()`, `count()`, `exists()`, `sum()`, `avg()`, `min()`, `max()`, 그리고 `SelectQueryBuilder.getMany()` / `getCount()` / `exists()`에 `AND tenant_id = ?`가 자동으로 붙습니다. Eager JOIN과 relation loader도 같은 predicate를 상속해요.
4. **write WHERE 주입.** `updateMany()`, `deleteMany()`, `delete()`, `softDelete()`, `restore()`도 `AND tenant_id = ?`를 받기 때문에, 테넌트 컨텍스트를 깜빡해도 다른 테넌트의 행을 지울 수 없습니다.

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

`@TenantColumn` 선언은 **선택 사항**입니다. 선언하든 안 하든 컬럼은 ORM이 관리합니다. 애플리케이션 코드에서 엔티티 인스턴스로부터 테넌트 id를 읽어야 할 때만 선언하세요 — 감사 로그, 관리자 대시보드, 크로스 테넌트 익스포트 같은 경우입니다:

```typescript
import { TenantColumn } from "@stingerloom/orm";

@Entity()
class AuditLog {
  @PrimaryGeneratedColumn() id!: number;
  @Column() action!: string;
  @TenantColumn() tenantId!: string;   // 이제 log.tenantId 로 읽을 수 있음
}
```

`save()` 할 때 `@TenantColumn` 프로퍼티에 값을 할당하면, 현재 컨텍스트와 반드시 일치해야 합니다 — 아니면 ORM이 `TENANT_MISMATCH`를 던집니다. 프로퍼티를 수동으로 세팅해서 테넌트를 위조할 수는 없어요.

### `@NonTenantEntity`로 엔티티 제외

일부 테이블은 본질적으로 전역입니다 — `Tenant` 테이블 자체, 시스템 설정, 공유 룩업 테이블 (국가, 통화, 피처 플래그). 이런 엔티티에는 `@NonTenantEntity()`를 붙이면 ORM이 건드리지 않습니다: DDL 컬럼 없음, WHERE 주입 없음, INSERT 검증 없음.

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

테넌트 범위 엔티티에서 `@NonTenantEntity` 타겟으로 eager JOIN 해도 안전합니다 — ORM이 non-tenant 쪽의 tenant predicate를 자동으로 skip 합니다.

### 탈출구: `runUnscoped()`

진짜로 모든 테넌트를 가로질러 조회해야 할 때도 있습니다 — 청구 리포트, 야간 배치 작업, 데이터 익스포트. 그런 코드는 `MetadataContext.runUnscoped()`로 감싸면 WHERE 주입이 skip 됩니다:

```typescript
import { MetadataContext } from "@stingerloom/orm";

await MetadataContext.runUnscoped(async () => {
  const allPosts = await em.find(Post);
  // → SELECT ... FROM post           ← tenant 필터 없음
});
```

`runUnscoped()`는 **read에만** 적용됩니다. INSERT는 여전히 테넌트 컨텍스트를 요구합니다 — `run("acme", …)` 블록 안에서 호출한 `runUnscoped()`는 `acme`로 INSERT 하고, 모든 `run()` 바깥에서 호출하면 채울 값이 없으니 `MISSING_TENANT_CONTEXT`를 던집니다. 이 비대칭은 의도적입니다 — 관리자 read는 안전하지만, 테넌트 귀속 없는 관리자 write는 안전하지 않으니까요.

### 쿼리 단위 opt-out

`runUnscoped()`는 컨텍스트 전체에 적용됩니다. 특정 쿼리 하나만 필터를 우회해야 한다면 쿼리 단위 opt-out을 사용하세요:

```typescript
// FindOption
await em.find(Post, { withoutTenantScope: true });

// SelectQueryBuilder
await em.createQueryBuilder(Post, "p")
  .withoutTenantScope()
  .getMany();
```

쿼리 단위 플래그는 read에만 적용됩니다. `updateMany` / `deleteMany` / `softDelete` / `restore`는 **의도적으로** 지원하지 않습니다 — 실수로 다른 테넌트 데이터를 수정하는 경우를 방지하려면, 한 줄짜리 리팩터링으로 켤 수 있는 플래그가 아니라 명시적인 `runUnscoped()` 블록이 필요합니다.

### Raw SQL 경고

ORM이 빌드한 쿼리에는 tenant predicate를 주입합니다. 하지만 `em.query("SELECT * FROM post")`를 직접 호출하면 Stingerloom이 SQL을 재작성할 수 없습니다 — `WHERE` 절은 개발자가 직접 책임져야 합니다. 활성 테넌트 컨텍스트 하에서 각 호출 지점이 `em.query()`를 처음 실행할 때 ORM이 다음과 같은 경고를 남깁니다:

```
[multi-tenancy] em.query() called under tenant="acme" — raw SQL bypasses
tenant predicate injection. Add "AND tenant_id = ?" to the query, or wrap
the call in MetadataContext.runUnscoped() to acknowledge cross-tenant scope.
    at MyService.rawReport (src/my-service.ts:42:23)
```

경고는 호출 지점 단위로 중복 제거되니까 뜨거운 루프에서도 수천 번이 아니라 한 번만 찍힙니다. 경고를 없애려면 SQL에 `AND tenant_id = ?`를 명시적으로 포함하거나, 의도적인 크로스 테넌트 read라면 `runUnscoped()`로 감싸면 됩니다.

### 1차 캐시 격리

Stingerloom의 Identity Map (WriteBuffer)은 이 전략에서 캐시 키에 현재 테넌트를 프리픽스로 붙입니다. 그래서 테넌트 "acme"에서 `em.findByPK(Post, 1)`을 해도, 테넌트 "globex"의 캐시된 행을 절대 돌려주지 않습니다. `runUnscoped()` 내부에서는 identity 캐시를 아예 skip 합니다 — 테넌트를 가로질러 읽는 상황에서는 bare PK가 모호하니까요.

### Stingerloom이 RLS를 지원하지 않는 이유

PostgreSQL Row-Level Security (`CREATE POLICY`)가 `tenant_column`의 더 안전한 버전으로 종종 제안됩니다 — ORM 대신 DB가 predicate를 강제한다는 이유로요. Stingerloom은 의도적으로 RLS를 지원하지 않습니다:

- **PostgreSQL 전용.** `tenant_column`을 고른 주된 이유(다이얼렉트 이식성)를 스스로 무효화합니다.
- **플래너 함정.** `STABLE` / `LEAKPROOF`로 표시되지 않은 RLS predicate는 인덱스를 우회하고 plan cache를 무효화할 수 있습니다. 사후 진단이 어려운 문제입니다.
- **범위 폭증.** `CREATE POLICY`는 ORM이 처음부터 끝까지 소유해야 하는 DDL입니다 — 정책 생성, diff, 마이그레이션 — 단일 다이얼렉트 기능을 위해 스키마 서브시스템의 표면적을 두 배로 키우게 됩니다.

PostgreSQL에서 DB 수준 행 격리가 필요하다면, Stingerloom과 별도로 DBA 레이어에서 RLS 정책을 적용하세요 — ORM이 이를 관리할 거라고 기대하지는 마시고요.

---

## 전략 4: `database` (모든 다이얼렉트, 물리 격리)

`tenantStrategy: "database"`는 테넌트마다 **자기 만의 물리 데이터베이스**를 줍니다. 자체 pool, 자체 DDL, 자체 백업 파일이죠. ORM은 `MultiTenantEntityManager`라는 얇은 proxy를 노출합니다. 이 proxy는 매 호출마다 `MetadataContext.getCurrentTenant()`를 보고 알맞은 테넌트 EntityManager로 위임합니다. 내부적으로는 `DatabaseClient`가 이미 multi-DB 용으로 사용하는 named-connection 메커니즘 위에서 동작하기 때문에, 쿼리 엔진을 깊게 다시 쓰는 게 아닙니다.

### 언제 선택하나요

다음 중 하나라도 해당되면 database 전략이 적합합니다:

- **컴플라이언스** — GDPR data residency, HIPAA enterprise tier, KISA 등 물리 분리가 강제되는 경우.
- **지리적 분산** — 테넌트마다 다른 region의 DB 호스트 (예: APAC 테넌트는 서울, EU 테넌트는 프랑크푸르트).
- **테넌트별 백업/복구 SLA** — `pg_dump tenant_acme` 한 번에 한 테넌트 데이터만 떨어지길 원하는 경우.
- **소수 (~50 이하)의 큰 enterprise 테넌트** — free tier 수천 명에는 부적합합니다.

free tier가 수천 개인 SaaS 시나리오에서는 `tenant_column`이 운영 비용이 훨씬 낮습니다. 엄격한 격리가 추가 pool, 추가 배포, 추가 마이그레이션 비용을 정당화할 때만 `database`를 선택하세요.

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

같은 옵션이 MySQL, SQLite에서도 동작합니다. 테넌트별 `type` / `host`만 바꿔 주세요.

### Resolver vs. 정적 map

테넌트와 물리 DB의 매핑을 router에 알려주는 두 가지 방식이 있습니다:

- **`tenantDatabaseResolver: (tenantId) => DatabaseClientOptions | string`** — 테넌트 첫 사용 시 한 번 호출됩니다. 전체 옵션 객체를 반환하면 router가 새 pool을 자동 프로비저닝하고, 문자열을 반환하면 `DatabaseClient.connect()`로 미리 등록해 둔 named connection을 사용합니다. 실패는 캐시되지 않습니다 — 재시도 시 resolver가 다시 호출됩니다.
- **`tenantDatabaseMap: Record<string, string>`** — 정적 매핑 dictionary. 모든 테넌트가 배포 시점에 알려져 있을 때 유용합니다. resolver보다 먼저 검사됩니다.

둘 다 동시에 사용할 수 있습니다. 같은 테넌트에 대한 항목이 양쪽에 있으면 map이 이깁니다.

### Eager 프로비저닝

lazy 해석은 개발 환경에서는 괜찮지만, 프로덕션 트래픽이 첫 요청에서 cold-start 비용을 내면 안 됩니다:

```typescript
await em.register({
  // ...
  tenantStrategy: "database",
  tenantDatabaseResolver: (tenantId) => ({ /* ... */ }),
  eagerProvisionTenants: ["acme", "globex"],   // register() 시점에 해석
});
```

`eagerProvisionTenants`는 `register()`가 반환되기 전에 listed 테넌트의 resolver를 실행하고 `synchronize`까지 마칩니다. 시작 헬스 체크와 함께 쓰세요.

### Public 컨텍스트 동작

쿼리가 어떤 `MetadataContext.run()` 블록 **밖에서** `MultiTenantEntityManager`에 도달하면 정책이 필요합니다:

```typescript
publicTenantBehavior: "default"   // (기본값) admin / public EntityManager 로 라우팅
publicTenantBehavior: "throw"     // MISSING_TENANT_CONTEXT 로 거부
```

모든 요청에 테넌트가 *반드시* 설정되어야 하는 HTTP 서비스에서는 `"throw"`를 추천합니다. 컨텍스트 누락이 silent admin DB 쓰기 대신 fail-fast 버그가 됩니다.

### Cross-tenant 트랜잭션은 금지됩니다

SQL 트랜잭션은 단일 connection에 묶이고, connection은 단일 물리 DB에 묶입니다. 따라서 트랜잭션 도중 테넌트를 바꾸면 atomicity를 보장할 방법이 없습니다:

```typescript
await MetadataContext.run("acme", async () => {
  await em.transaction(async () => {
    await em.save(User, { name: "alice" });

    await MetadataContext.run("globex", async () => {
      // OrmErrorCode.CROSS_TENANT_TRANSACTION 으로 throw
      await em.save(User, { name: "carol" });
    });
  });
});
```

두 테넌트에 atomic 하게 써야 하는 상황이라면 사실 multi-tenant 문제가 아니라 distributed-transaction 문제입니다. 애플리케이션 레이어에서 saga / outbox 패턴을 쓰세요.

### 관리 작업: `forEachTenant`

대시보드, 감사, 마이그레이션처럼 모든 테넌트에 대해 작업해야 할 때 사용합니다:

```typescript
const counts = await em.forEachTenant(async (tenantEm, tenantId) => ({
  tenantId,
  total: await tenantEm.count(User),
}));
// → [{ tenantId: "acme", value: { tenantId: "acme", total: 142 } }, ...]
```

세 가지 모드를 지원합니다:

- `"all"` (기본) — `Promise.all`, 첫 실패에서 throw.
- `"settled"` — `Promise.allSettled`, 테넌트별 `{ value }` 또는 `{ error }` 반환.
- `"sequential"` — 한 번에 한 테넌트씩 순차 실행. 공유 인프라에 부담을 주지 않으려는 경우 유용합니다.

`forEachTenant`는 router가 이미 해석한 테넌트만 순회합니다. lazy-only 테넌트는 먼저 한 번 touch 하거나 eager 프로비저닝 해두어야 합니다.

### NestJS 통합

```typescript
import { Module, Injectable } from "@nestjs/common";
import {
  StingerloomOrmModule,
  InjectMultiTenantEntityManager,
  MultiTenantEntityManager,
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
    // 미들웨어가 테넌트 컨텍스트를 채워주면 알맞은 DB 로 라우팅됩니다.
    return this.em.find(User);
  }
}
```

`@InjectEntityManager()`도 그대로 동작합니다. `tenantStrategy: "database"`에서는 `MultiTenantEntityManager`가 보유한 **admin / public** `EntityManager`로 해석되어 global 테이블 조작에 적합해요.

### Connection pool 예산

물리 격리의 단점은 connection pool의 *증식*입니다. 테넌트 50개 × `pool.max: 10`이면 DB 서버에 connection 500개를 요구하게 되는데, PostgreSQL의 기본 `max_connections`는 100입니다. 보수적인 기본값:

- 테넌트당 `pool.max`를 작게 (예: 5).
- `tenantConnectionTtlMs`로 idle 한 테넌트 pool을 비우고 필요할 때 재사용.
- `DatabaseClient.getInstance().getRegisteredNames().length` 모니터링 — 예상보다 늘어나는 시점을 잡아주세요.

### Raw SQL은 안전합니다 (경고 없음)

격리가 connection 레벨에서 강제되기 때문에, `em.query("SELECT * FROM user")`는 항상 현재 테넌트의 DB만 봅니다. `tenant_column`의 raw SQL 경고는 이 전략에서는 발생하지 않습니다 — 우회할 `WHERE tenant_id = ?` 자체가 없기 때문이죠.

---

## LayeredMetadata 직접 사용

대부분의 애플리케이션에서는 `MetadataContext.run()`과 스키마 기반 격리만으로 충분합니다. 하지만 레이어드 메타데이터 시스템은 더 저수준의 프리미티브로, 특정 테넌트에 다른 테이블 이름이나 컬럼 설정을 주는 것 같은 고급 시나리오에 직접 사용할 수 있어요.

데코레이터 시점의 레지스트리는 `MetadataLayerRegistry`(`src/scanner/MetadataScanner.ts`)이며 싱글턴입니다. 모든 `@Entity`/`@Column`/`@ManyToOne` 데코레이터는 이 싱글턴의 `"public"` 레이어에 메타데이터를 기록하고, 모든 읽기도 이 싱글턴을 거칩니다. 특정 테넌트에 메타데이터를 덮어쓰려면 이 싱글턴에 레이어를 추가하고 `MetadataContext.run()`으로 컨텍스트를 전환하세요.

```typescript
import { MetadataLayerRegistry, MetadataContext } from "@stingerloom/orm";

const registry = MetadataLayerRegistry.getInstance();

// 테넌트 레이어 생성 (쓰기 가능)
registry.addLayer("enterprise", false);

// 요청 스코프 안에서 이 테넌트의 메타데이터를 덮어쓰기
await MetadataContext.run("enterprise", async () => {
  registry.getCurrentLayer().set("entities/User", {
    tableName: "enterprise_users", // 이 테넌트는 다른 테이블명을 사용
  });
});
```

ORM이 `User`의 테이블 이름을 조회할 때:
- "enterprise" 컨텍스트에서 → 테넌트 레이어에서 `"enterprise_users"` 발견
- 다른 컨텍스트에서 → public 레이어로 폴백 → `"user"` (기본값)

### 격리 보장

`MetadataLayerRegistry.resolveAll()`은 **public 레이어**와 **현재 활성 컨텍스트**의 레이어만 병합합니다. 다른 테넌트 레이어의 데이터는 절대 포함하지 않습니다. 여러 테넌트가 동시에 활성화되어 있어도 크로스 테넌트 메타데이터 유출이 방지됩니다.

```
MetadataContext.run("acme_corp", ...) 안에서 resolveAll() 호출 시
  → public layer + acme_corp layer  (포함)
  → globex layer                    (제외)
  → initech layer                   (제외)
```

---

## 중요한 설계 규칙

**전역 상태 없음.** 모든 테넌트 식별은 `AsyncLocalStorage`를 통해 이루어집니다. 동시 요청에서도 안전합니다. 한 요청이 다른 요청의 전역 변수를 실수로 덮어쓸 수 있는 상황은 존재하지 않아요.

**Public 레이어는 읽기 전용.** `@Entity`와 `@Column` 데코레이터로 등록된 엔티티 메타데이터는 public 레이어에 저장됩니다. 런타임에 수정할 수 없습니다 — 테넌트 레이어만 쓰기를 허용해요.

**컨텍스트 자동 복원.** `MetadataContext.run()` 블록 밖에서는 컨텍스트가 자동으로 `"public"`으로 돌아갑니다. 테넌트 컨텍스트가 다음 요청으로 누출될 위험이 없어요.

**`setContext()`는 deprecated.** 초기 버전에서는 전역 테넌트 상태를 설정하는 `setContext()` 메서드를 사용했지만, 동시 요청에서 위험합니다. 대신 항상 `MetadataContext.run()`을 사용하세요 — `AsyncLocalStorage`를 통해 콜백에 컨텍스트를 스코핑해 줍니다.

---

## 예제 프로젝트

완전한 NestJS 멀티테넌시 예제가 `examples/nestjs-multitenant/`에 있습니다. 미들웨어 설정, 스키마 프로비저닝, 테넌트 격리 CRUD 작업을 보여줘요.

```bash
cd examples/nestjs-multitenant
pnpm install
pnpm start
```

---

## 다음 단계

- [Configuration Guide](./configuration.md) — 풀링, Read Replica 등 운영 설정
- [Migrations](./migrations.md) — 프로덕션 스키마 관리
- [Advanced Features](./advanced.md) — 이벤트 시스템, N+1 감지, 성능 최적화
