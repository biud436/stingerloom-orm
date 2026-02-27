# 멀티테넌시 (Multi-Tenancy)

SaaS 서비스를 만들 때 고객(테넌트)마다 데이터를 완전히 격리해야 하는 경우가 있습니다. A 회사의 사용자 목록에 B 회사의 데이터가 섞이면 안 되겠죠.

Stingerloom ORM은 **레이어드 메타데이터 시스템**으로 멀티테넌시를 지원합니다. Docker의 OverlayFS와 동일한 원리입니다.

## 작동 원리

```
┌──────────────────────────────────┐
│  Tenant Layer (읽기/쓰기)         │  ← 테넌트별 수정 사항
│  예: "acme_corp" 전용 오버라이드    │
├──────────────────────────────────┤
│  Public Layer (읽기 전용)         │  ← 기본 스키마 (모든 엔티티)
│  @Entity, @Column 등 기본 정의     │
└──────────────────────────────────┘
```

**읽기:** 테넌트 레이어를 먼저 확인하고, 없으면 Public 레이어에서 읽습니다.

**쓰기:** 현재 테넌트 레이어에만 기록합니다 (Copy-on-Write). Public 레이어는 변경되지 않습니다.

핵심은 간단합니다. "지금 어떤 테넌트로 요청이 들어왔는지"를 설정하면, 나머지는 ORM이 알아서 처리합니다.

## 기본 사용법

`MetadataContext.run()`으로 특정 테넌트 컨텍스트 안에서 코드를 실행합니다.

```typescript
import { MetadataContext } from "stingerloom-orm";

// tenant_1 컨텍스트에서 실행
await MetadataContext.run("tenant_1", async () => {
  const users = await em.find(User);
  // → tenant_1 레이어 → public 레이어 순서로 조회
});

// 콜백 밖에서는 자동으로 "public"으로 복귀
```

`MetadataContext.run()`은 `AsyncLocalStorage`를 사용하므로, 콜백 내부에서 호출하는 모든 비동기 함수에서 동일한 테넌트 컨텍스트가 유지됩니다.

```typescript
// 현재 테넌트 확인
const tenant = MetadataContext.getCurrentTenant(); // "tenant_1" 또는 "public"
const isActive = MetadataContext.isActive();       // true / false
```

## NestJS 미들웨어로 자동 설정

실제 서비스에서는 HTTP 요청마다 테넌트를 자동으로 설정합니다. 미들웨어를 사용하면 모든 컨트롤러와 서비스에서 별도 코드 없이 테넌트 격리가 적용됩니다.

```typescript
// tenant.middleware.ts
import { Injectable, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { MetadataContext } from "stingerloom-orm";

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const tenantId = req.headers["x-tenant-id"] as string ?? "public";

    // 요청 전체를 테넌트 컨텍스트로 래핑
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

이제 API를 호출할 때 `X-Tenant-Id` 헤더만 추가하면 됩니다.

```bash
# acme_corp 테넌트의 사용자 조회
curl -H "X-Tenant-Id: acme_corp" http://localhost:3000/users

# globex 테넌트의 게시글 조회
curl -H "X-Tenant-Id: globex" http://localhost:3000/posts

# 헤더가 없으면 → "public" 컨텍스트
curl http://localhost:3000/users
```

## PostgreSQL 스키마 기반 격리

PostgreSQL에서는 스키마를 사용하여 테넌트 데이터를 물리적으로 완전히 격리할 수 있습니다. `TenantMigrationRunner`가 테넌트별 스키마를 자동으로 생성해줍니다.

### 테넌트 스키마 프로비저닝

```typescript
import { PostgresTenantMigrationRunner, EntityManager } from "stingerloom-orm";

const em = new EntityManager();
await em.register({
  type: "postgres",
  host: "localhost",
  port: 5432,
  username: "postgres",
  password: "password",
  database: "mydb",
  entities: [User, Post],
  synchronize: true,
});

const driver = em.getDriver()!;
const runner = new PostgresTenantMigrationRunner(driver, {
  sourceSchema: "public", // 이 스키마의 테이블 구조를 복제
});
```

### 단일 테넌트 생성

```typescript
await runner.ensureSchema("acme_corp");
// → CREATE SCHEMA "acme_corp"
// → 각 테이블을 CREATE TABLE ... (LIKE "public"."users" INCLUDING ALL) 로 복제
```

### 여러 테넌트 일괄 생성

```typescript
const result = await runner.syncTenantSchemas([
  "acme_corp", "globex", "initech", "umbrella"
]);

console.log(result.created);  // ["initech", "umbrella"] — 새로 생성됨
console.log(result.skipped);  // ["acme_corp", "globex"] — 이미 존재
```

### 기존 스키마 탐색

```typescript
const schemas = await runner.discoverSchemas();
// ["public", "acme_corp", "globex"]

runner.isProvisioned("acme_corp");   // true
runner.getProvisionedSchemas();       // ["acme_corp", "globex", ...]
```

### NestJS에서 자동 프로비저닝

앱이 시작될 때 모든 테넌트 스키마를 자동으로 생성하는 서비스를 만들 수 있습니다.

```typescript
// tenant-provisioning.service.ts
import { Injectable, OnModuleInit } from "@nestjs/common";
import { EntityManager, PostgresTenantMigrationRunner } from "stingerloom-orm";

@Injectable()
export class TenantProvisioningService implements OnModuleInit {
  private runner: PostgresTenantMigrationRunner;

  constructor(private readonly em: EntityManager) {}

  async onModuleInit() {
    const driver = this.em.getDriver()!;
    this.runner = new PostgresTenantMigrationRunner(driver);

    // 앱 시작 시 테넌트 프로비저닝
    await this.runner.syncTenantSchemas([
      "acme_corp",
      "globex",
    ]);
  }

  async provisionTenant(tenantId: string) {
    await this.runner.ensureSchema(tenantId);
  }
}
```

> **Hint** 현재 스키마 기반 멀티테넌시는 PostgreSQL에서만 지원됩니다. MySQL, SQLite, MSSQL은 `UnsupportedError`를 반환합니다.

## 레이어드 메타데이터 직접 사용

대부분의 경우 `MetadataContext.run()`만으로 충분하지만, 테넌트별로 메타데이터를 직접 오버라이드해야 할 때는 `LayeredMetadataStore`를 사용합니다.

```typescript
import { LayeredMetadataStore } from "stingerloom-orm";

const store = new LayeredMetadataStore();

// 테넌트 레이어 추가
store.addLayer("enterprise", false);

// 테넌트별 메타데이터 오버라이드
store.setContext("enterprise");
store.set("User", {
  tableName: "enterprise_users", // 이 테넌트에서만 다른 테이블 사용
});
```

## 주의 사항

**전역 상태 사용 금지** — 전역 싱글톤 대신 레이어를 통해 메타데이터에 접근하세요.

**Public 레이어는 읽기 전용** — `@Entity`, `@Column` 등 데코레이터로 등록된 메타데이터는 Public 레이어에 저장됩니다. 테넌트별 변경은 별도 레이어에서만 가능합니다.

**컨텍스트 범위** — `MetadataContext.run()` 블록 바깥에서는 자동으로 `"public"` 컨텍스트로 복귀됩니다.

## 예제 프로젝트

`examples/nestjs-multitenant/`에 완전한 NestJS 멀티테넌시 예제가 있습니다.

```bash
cd examples/nestjs-multitenant
pnpm install
pnpm start
```

## 다음 단계

- [설정 가이드](./configuration.md) — 풀링, Read Replica 등 운영 설정
- [마이그레이션](./migrations.md) — 프로덕션 스키마 관리
- [고급 기능](./advanced.md) — 이벤트 시스템, N+1 감지, 성능 최적화
