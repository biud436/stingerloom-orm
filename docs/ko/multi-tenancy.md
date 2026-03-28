# Multi-Tenancy

## 문제 상황

SaaS 제품을 만든다고 생각해 보세요. 수백 개의 회사가 사용하는 프로젝트 관리 도구예요. A 회사에는 직원이 50명, B 회사에는 200명이 있어요. 두 회사 모두 같은 서버, 같은 데이터베이스를 사용해요.

하지만 A 회사는 **절대** B 회사의 데이터를 볼 수 없어야 해요. API 응답에서도, DB 쿼리에서도, 버그로 인한 우연한 노출도 안 돼요. 이게 바로 **멀티테넌시**예요 — 하나의 애플리케이션에 여러 고객(테넌트)을 격리하는 거예요.

일반적으로 세 가지 접근 방식이 있어요:

1. **DB 분리** — 테넌트마다 별도 DB. 단순하지만 운영 비용이 높아요.
2. **DB 공유, 스키마 분리** — DB는 하나지만 테넌트마다 별도 네임스페이스(스키마)를 사용해요. 격리와 효율의 균형이 좋아요.
3. **전부 공유** — DB 하나, 스키마 하나, 모든 테이블에 `tenant_id` 컬럼. 가장 저렴하지만 WHERE 절 하나 빠지면 데이터가 유출돼요.

Stingerloom ORM은 **레이어드 메타데이터 시스템**을 통해 **#2** (PostgreSQL 스키마 기반 격리)를 지원하고, **#3** 방식에 필요한 컨텍스트 기반 인프라도 제공해요.

---

## 작동 원리 — OverlayFS 비유

Docker를 사용해 보셨다면, 컨테이너가 베이스 이미지를 공유하면서 각자 쓰기 가능한 레이어를 갖는 걸 아실 거예요. 변경 사항은 최상위 레이어에 기록되고, 베이스는 그대로 유지돼요. 파일을 읽을 때는 최상위 레이어를 먼저 확인하고, 없으면 베이스로 폴백해요.

Stingerloom의 메타데이터 시스템도 같은 방식이에요:

```
┌──────────────────────────────────────────────┐
│  Tenant Layer  (read / write)                │  ← Per-tenant overrides
│  e.g., "acme_corp" has a custom table name   │    (Copy-on-Write)
├──────────────────────────────────────────────┤
│  Public Layer  (read-only)                   │  ← Base schema definitions
│  @Entity, @Column decorators register here   │    (shared by all tenants)
└──────────────────────────────────────────────┘
```

**메타데이터 읽기:** 테넌트 레이어를 먼저 확인하고, 없으면 public 레이어로 폴백해요.

**메타데이터 쓰기:** 항상 테넌트 레이어에 기록해요. Public 레이어는 런타임에 절대 수정되지 않아요. Docker OverlayFS와 동일한 Copy-on-Write 원칙이에요.

핵심은 **이걸 직접 신경 쓸 필요가 없다**는 거예요. "이 요청이 어떤 테넌트에 속하는지"만 설정하면, ORM이 자동으로 올바른 스키마로 쿼리를 라우팅해줘요.

---

## 테넌트 컨텍스트 설정

SaaS 앱에서 모든 HTTP 요청은 특정 테넌트에 속해요. ORM에게 어떤 테넌트인지 알려줘야 하는데, `MetadataContext.run()`을 사용하면 돼요:

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

`MetadataContext.run()`은 Node.js의 `AsyncLocalStorage`를 사용해요. 파라미터로 넘기지 않아도 전체 async 호출 체인에 컨텍스트를 전파하는 내장 메커니즘이에요. async JavaScript의 "thread-local 변수"라고 생각하면 돼요.

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

콜 스택이 아무리 깊어져도 — controller -> service -> repository -> EntityManager — `AsyncLocalStorage`를 통해 테넌트 컨텍스트를 항상 가져올 수 있어요. `tenantId`를 함수 파라미터로 넘길 필요가 없어요.

### 현재 컨텍스트 확인

```typescript
const tenant = MetadataContext.getCurrentTenant();
// "acme_corp" inside run(), "public" outside

const isActive = MetadataContext.isActive();
// true inside run(), false outside
```

### 동시성 안전

각 HTTP 요청은 고유한 `AsyncLocalStorage` 컨텍스트를 갖게 돼요. "acme_corp"과 "globex" 요청이 정확히 같은 밀리초에 들어와도 각각 다른 테넌트 ID를 볼 수 있어요. 덮어쓸 수 있는 공유 전역 변수 같은 건 없어요.

```
Request A (acme_corp)  ──────────────────────────►  sees "acme_corp" throughout
Request B (globex)     ──────────────────────────►  sees "globex" throughout
                       ↑ concurrent, but isolated
```

---

## NestJS 미들웨어로 자동 설정

실제 애플리케이션에서는 매 요청마다 `MetadataContext.run()`을 직접 호출하지 않아요. 대신 미들웨어를 사용해서 HTTP 요청에서 테넌트를 추출하고, 전체 요청 라이프사이클을 테넌트 컨텍스트로 감싸면 돼요.

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

이렇게 하면 NestJS 앱의 모든 controller와 service가 자동으로 올바른 테넌트 컨텍스트에서 실행돼요. 비즈니스 로직은 수정할 필요가 없어요:

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

`X-Tenant-Id` 헤더가 가장 간단하지만, 프로덕션에서는 다른 방법도 사용할 수 있어요:

| 소스 | 예시 | 사용 시점 |
|------|------|----------|
| HTTP 헤더 | `X-Tenant-Id: acme_corp` | 내부 API, 마이크로서비스 |
| 서브도메인 | `acme.yourapp.com` | 고객 대면 앱 |
| JWT claim | `{ tenantId: "acme_corp" }` | 토큰 기반 인증 |
| URL 경로 | `/tenants/acme_corp/users` | 명시적 스코핑이 있는 REST API |

어떤 방법이든 미들웨어 패턴은 동일해요 — 테넌트 ID를 추출하고 `MetadataContext.run()`에 넘기면 돼요.

---

## PostgreSQL 스키마 기반 격리

지금까지 쿼리 라우팅에 대해 이야기했어요. 그런데 테넌트 데이터는 실제로 어디에 저장될까요? PostgreSQL 스키마를 사용하면, 각 테넌트가 모든 테이블의 복사본을 포함하는 별도의 네임스페이스를 갖게 돼요.

PostgreSQL 스키마는 파일시스템의 폴더라고 생각하면 돼요:

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

각 스키마는 자체 `user` 테이블을 갖고, 자체 데이터를 포함해요. `acme_corp.user`와 `globex.user`는 완전히 별개예요 — 데이터, 인덱스, 시퀀스가 모두 달라요.

### TenantMigrationRunner로 테넌트 스키마 생성

`PostgresTenantMigrationRunner`는 테넌트 스키마 생성을 자동화해요. public 스키마의 테이블 구조를 새 테넌트 스키마로 복제해줘요.

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

이렇게 하면 다음 SQL이 실행돼요:

```sql
-- 1. Create the schema
CREATE SCHEMA IF NOT EXISTS "acme_corp";

-- 2. Clone each table's structure from public (including indexes, constraints, defaults)
CREATE TABLE IF NOT EXISTS "acme_corp"."user"
  (LIKE "public"."user" INCLUDING ALL);

CREATE TABLE IF NOT EXISTS "acme_corp"."post"
  (LIKE "public"."post" INCLUDING ALL);
```

`INCLUDING ALL`은 컬럼, 인덱스, 제약 조건, 기본값, 시퀀스를 모두 복사해요 — 데이터만 빼고요. 테넌트는 모든 테이블의 빈 복사본으로 시작돼요.

`ensureSchema()`는 멱등(idempotent)이에요 — 같은 테넌트에 두 번 호출해도 두 번째는 아무것도 하지 않아요. 내부적으로 advisory lock을 사용해서, 여러 프로세스가 동시에 같은 스키마를 생성하려는 race condition도 방지해요.

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

앱 시작 시 모든 알려진 테넌트를 프로비저닝하는 서비스를 만들 수 있어요:

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
스키마 기반 멀티테넌시는 현재 PostgreSQL에서만 지원돼요. MySQL은 데이터베이스와 별개의 스키마 개념이 없고, SQLite는 스키마를 아예 지원하지 않아요. MySQL이나 SQLite에서 `TenantMigrationRunner`를 사용하면 `UnsupportedError`가 발생해요.
:::

---

## 테넌트 쿼리 전략

테넌트 컨텍스트 안에서 쿼리가 실행되면, ORM이 올바른 스키마로 라우팅해야 해요. 두 가지 전략이 있고, 선택에 따라 성능이 달라져요.

### "라운드 트립"이란?

라운드 트립은 애플리케이션과 PostgreSQL 서버 사이의 한 번의 요청-응답 사이클이에요. 각 라운드 트립은 최소 한 번의 네트워크 지연이 발생해요. DB가 10ms 거리에 있다면, 5번의 라운드 트립 = 데이터를 받기도 전에 50ms의 오버헤드가 생기는 거예요.

### 전략 1: `"search_path"` (기본값)

PostgreSQL에는 `search_path`라는 세션 변수가 있어요. 스키마가 명시되지 않은 테이블 이름이 어떤 스키마를 가리키는지 결정하는 변수예요. 이 전략은 각 테넌트 쿼리 전에 트랜잭션 안에서 `search_path`를 설정해요.

```typescript
await em.register({
  type: "postgres",
  // ...
  tenantStrategy: "search_path",  // default — can be omitted
});
```

`MetadataContext.run("acme_corp", ...)` 블록 안에서 `em.find(User)`를 실행하면, 네트워크 레벨에서 이런 일이 일어나요:

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

단일 테넌트 읽기에 4번의 라운드 트립이 필요해요 (connect + BEGIN + SET LOCAL + SELECT + COMMIT). `SET LOCAL`은 search_path 변경이 이 트랜잭션에만 적용되도록 보장해요 — 다른 커넥션에는 영향을 주지 않아요.

**장점:** PostgreSQL에서 잘 정립된 패턴이에요. pg_dump, 모니터링 등 기존 도구와 자연스럽게 호환돼요.

**단점:** 모든 테넌트 읽기에 트랜잭션 래핑이 필요해서 지연이 추가돼요.

### 전략 2: `"schema_qualified"`

search_path를 변경하는 대신, 테이블 이름 앞에 스키마 이름을 직접 붙이는 방식이에요:

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

단 1번의 라운드 트립이에요 (커넥션 제외). 단순 읽기에는 트랜잭션이 필요 없어요.

```sql
-- With schema_qualified strategy, tenant context = "acme_corp":
SELECT * FROM "acme_corp"."user"

-- With schema_qualified strategy, tenant context = "public" (or no context):
SELECT * FROM "user"
```

**장점:** 더 빨라요. 읽기에 불필요한 트랜잭션 오버헤드가 없어요.

**단점:** 실질적으로 없어요 — SQL이 약간 다를 뿐 두 전략 모두 동일한 결과를 만들어요.

### 성능 비교

| 시나리오 | `search_path` | `schema_qualified` |
|---------|:-------------:|:------------------:|
| 테넌트 읽기 (라운드 트립) | 4-5 | **1-2** |
| 비테넌트 읽기 | 1-2 | 1-2 |
| 쓰기 작업 | 트랜잭션 (동일) | 트랜잭션 (동일) |
| 결과 정확성 | 동일 | 동일 |

**`schema_qualified`를 선택해야 할 때:** 테넌트 스코프 쿼리가 많은 읽기 위주 앱 — 대부분의 SaaS 앱이 해당돼요. 네트워크 지연이 10ms라면, 단일 테넌트 읽기의 오버헤드가 ~40ms (search_path)에서 ~10ms (schema_qualified)로 줄어요.

두 전략 모두 동일한 결과를 만들어요. 차이는 순수하게 성능에만 있어요. search_path를 써야 하는 특별한 이유(예: 스키마 한정 이름을 지원하지 않는 도구와의 호환)가 없다면, **`schema_qualified`가 더 나은 기본값**이에요.

### 프로그래밍 방식 접근

커스텀 미들웨어나 테스트 같은 고급 사용 사례를 위해 전략 클래스가 export 돼 있어요:

```typescript
import {
  TenantQueryStrategy,
  SearchPathStrategy,
  SchemaQualifiedStrategy,
} from "@stingerloom/orm";
```

---

## LayeredMetadata 직접 사용

대부분의 애플리케이션에서는 `MetadataContext.run()`과 스키마 기반 격리만으로 충분해요. 하지만 레이어드 메타데이터 시스템은 더 저수준의 프리미티브로, 특정 테넌트에 다른 테이블 이름이나 컬럼 설정을 주는 것 같은 고급 시나리오에 직접 사용할 수 있어요.

```typescript
import { LayeredMetadataStore } from "@stingerloom/orm";

const store = new LayeredMetadataStore();

// Create a tenant layer
store.addLayer("enterprise", false);  // false = writable

// Override metadata for this specific tenant
store.setContext("enterprise");
store.set("User", {
  tableName: "enterprise_users",  // this tenant uses a different table name
});
```

ORM이 `User`의 테이블 이름을 조회할 때:
- "enterprise" 컨텍스트에서 -> 테넌트 레이어에서 `"enterprise_users"` 발견
- 다른 컨텍스트에서 -> public 레이어로 폴백 -> `"user"` (기본값)

### 격리 보장

`getAllInContext("acme_corp")`는 **public 레이어**와 **acme_corp 레이어**만 병합해요. 다른 테넌트 레이어의 데이터는 절대 포함하지 않아요. 여러 테넌트가 동시에 활성화되어 있어도 크로스 테넌트 메타데이터 유출이 방지돼요.

```
getAllInContext("acme_corp")
  → public layer ∪ acme_corp layer ✓
  → globex layer is excluded ✗
  → initech layer is excluded ✗
```

---

## 중요한 설계 규칙

**전역 상태 없음.** 모든 테넌트 식별은 `AsyncLocalStorage`를 통해 이루어져요. 동시 요청에서도 안전해요. 한 요청이 다른 요청의 전역 변수를 실수로 덮어쓸 수 있는 상황은 없어요.

**Public 레이어는 읽기 전용.** `@Entity`와 `@Column` 데코레이터로 등록된 엔티티 메타데이터는 public 레이어에 저장돼요. 런타임에 수정할 수 없어요 — 테넌트 레이어만 쓰기를 허용해요.

**컨텍스트 자동 복원.** `MetadataContext.run()` 블록 밖에서는 컨텍스트가 자동으로 `"public"`으로 돌아가요. 테넌트 컨텍스트가 다음 요청으로 누출될 위험이 없어요.

**`setContext()`는 deprecated.** 초기 버전에서는 전역 테넌트 상태를 설정하는 `setContext()` 메서드를 사용했는데, 동시 요청에서 위험해요. 대신 항상 `MetadataContext.run()`을 사용하세요 — `AsyncLocalStorage`를 통해 콜백에 컨텍스트를 스코핑해줘요.

---

## 예제 프로젝트

완전한 NestJS 멀티테넌시 예제가 `examples/nestjs-multitenant/`에 있어요. 미들웨어 설정, 스키마 프로비저닝, 테넌트 격리 CRUD 작업을 보여줘요.

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
