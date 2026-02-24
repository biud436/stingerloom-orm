# 멀티테넌시 (Multi-Tenancy)

Stingerloom ORM은 Docker OverlayFS와 동일한 개념의 **레이어드 메타데이터 시스템**을 통해 멀티테넌시를 지원합니다.

---

## 개념: Docker OverlayFS 비유

Docker의 OverlayFS는 여러 파일시스템 레이어를 계층적으로 쌓아 올리는 방식입니다. Stingerloom ORM의 레이어드 메타데이터도 동일한 원리를 사용합니다.

```
┌─────────────────────────────────────┐
│  Tenant Layer (Upper / Work Layer)  │  ← 테넌트별 수정 사항 (읽기/쓰기)
│  예: "tenant_1" 전용 스키마 오버라이드  │
├─────────────────────────────────────┤
│  Public Layer (Lower Layer)         │  ← 기본 스키마 (읽기 전용)
│  모든 엔티티 포함                     │
└─────────────────────────────────────┘
```

**읽기 순서:** 상위(Tenant) → 하위(Public) 순으로 조회

- 테넌트 레이어에 키가 있으면 그 값을 반환
- 없으면 Public 레이어에서 조회 (Fallback)

**쓰기 방식:** Copy-on-Write

- 항상 현재 컨텍스트의 최상위 쓰기 가능 레이어에만 기록
- Public 레이어는 읽기 전용이므로 수정 불가

---

## 핵심 컴포넌트

### LayeredMetadataStore

메타데이터를 레이어 기반으로 관리하는 핵심 클래스입니다.

```typescript
import { LayeredMetadataStore } from "stingerloom-orm";

const store = new LayeredMetadataStore();

// 기본 레이어 구조 (생성자에서 자동 생성)
// - "public" 레이어 (읽기 전용, Lower Layer)

// 테넌트 레이어 추가
store.addLayer("tenant_1", false); // 두 번째 인자: isReadOnly

// 컨텍스트 전환
store.setContext("tenant_1");

// 현재 컨텍스트에 메타데이터 저장 (Copy-on-Write)
store.set("someKey", { tableName: "users_tenant_1" });

// 조회 (상위 → 하위 Fallback)
const value = store.get("someKey");
```

### MetadataContext

`AsyncLocalStorage`를 사용하여 요청(또는 비동기 실행 단위)별로 독립적인 테넌트 컨텍스트를 유지합니다.

```typescript
import { MetadataContext } from "stingerloom-orm";

// 현재 테넌트 ID 조회 (없으면 "public" 반환)
const tenant = MetadataContext.getCurrentTenant();

// 컨텍스트 활성화 여부 확인
const isActive = MetadataContext.isActive();
```

---

## withTenant(tenantId, callback) API

특정 테넌트 컨텍스트 내에서 콜백을 실행합니다. 콜백 내부의 모든 비동기 호출에서 동일한 `tenantId`가 유지됩니다.

```typescript
import { MetadataContext } from "stingerloom-orm";

// 기본 사용법
await MetadataContext.run("tenant_1", async () => {
  // 이 블록 내의 모든 메타데이터 조회는 tenant_1 컨텍스트
  const users = await em.find(User);
  // → tenant_1 레이어 → public 레이어 순서로 메타데이터 조회
});

// 중첩 컨텍스트
await MetadataContext.run("tenant_1", async () => {
  const users = await em.find(User); // tenant_1 컨텍스트

  // 내부 콜백도 tenant_1 컨텍스트 유지
  await someAsyncOperation();
});
```

---

## 멀티테넌시 시나리오 예제

### NestJS Middleware로 자동 컨텍스트 설정

```typescript
// tenant.middleware.ts
import { Injectable, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { MetadataContext } from "stingerloom-orm";

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    // 요청 헤더에서 테넌트 ID 추출
    const tenantId = req.headers["x-tenant-id"] as string ?? "public";

    // 요청 전체를 테넌트 컨텍스트로 래핑
    MetadataContext.run(tenantId, () => {
      next();
    });
  }
}

// app.module.ts
@Module({
  // ...
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantMiddleware).forRoutes("*");
  }
}
```

### 테넌트별 스키마 분리

```typescript
// Public 레이어: 기본 User 테이블
@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Column()
  tenantId!: string;
}

// 서비스에서 테넌트 컨텍스트 활용
class UserService {
  async findUsersForTenant(tenantId: string) {
    return MetadataContext.run(tenantId, async () => {
      // 현재 컨텍스트가 tenantId로 설정됨
      return em.find(User, {
        where: { tenantId },
      });
    });
  }
}
```

### 테넌트별 메타데이터 오버라이드

```typescript
import { LayeredMetadataStore } from "stingerloom-orm";

const store = new LayeredMetadataStore();

// Public 레이어에 기본 스키마 등록 (자동으로 ORM이 처리)

// Tenant 레이어 생성 및 스키마 오버라이드
store.addLayer("enterprise", false);
store.setContext("enterprise");

// 특정 테넌트에서만 다른 테이블 설정 사용
store.set("User", {
  tableName: "enterprise_users",  // 테넌트별 다른 테이블명
  // ...
});

// 이후 enterprise 컨텍스트에서 User 조회 시 enterprise_users 테이블 사용
```

---

## MetadataLayer API

```typescript
// 레이어 추가
const layer = store.addLayer("tenant_2", false);

// 레이어 조회
const publicLayer = store.getLayer("public");

// 현재 컨텍스트 조회
const context = store.getContext(); // "public" | "tenant_1" | ...

// 메타데이터 쓰기 (Copy-on-Write)
store.set("entityKey", metadata);

// 메타데이터 읽기 (Fallback 포함)
const metadata = store.get("entityKey");

// 모든 메타데이터 목록 (현재 컨텍스트 기준)
const all = store.getAll();
```

---

## NestJS 통합 예제

`examples/nestjs-multitenant/` 폴더에 완전한 NestJS 멀티테넌시 예제가 포함되어 있습니다.

```
examples/nestjs-multitenant/
├── src/
│   ├── app.module.ts           # TenantMiddleware 등록
│   ├── tenant.middleware.ts    # X-Tenant-Id 헤더 기반 컨텍스트 설정
│   ├── users/
│   │   ├── user.entity.ts      # User 엔티티
│   │   ├── users.module.ts
│   │   ├── users.service.ts    # withTenant() 활용 CRUD
│   │   └── users.controller.ts
│   └── posts/
│       ├── post.entity.ts
│       ├── posts.module.ts
│       ├── posts.service.ts
│       └── posts.controller.ts
└── package.json
```

**실행 방법**

```bash
cd examples/nestjs-multitenant
pnpm install
pnpm start
```

**API 호출 예시**

```bash
# tenant_1 컨텍스트에서 유저 조회
curl -H "X-Tenant-Id: tenant_1" http://localhost:3000/users

# tenant_2 컨텍스트에서 포스트 조회
curl -H "X-Tenant-Id: tenant_2" http://localhost:3000/posts
```

`X-Tenant-Id` 헤더가 없으면 기본값 `"public"`으로 처리됩니다.

---

## 주의 사항

1. **전역 상태 사용 금지:** 새 기능 추가 시 전역 싱글톤 대신 레이어를 통한 메타데이터 접근을 사용하세요.

2. **Public 레이어는 읽기 전용:** `@Entity`, `@Column` 등 데코레이터 등록 시 Public 레이어에 저장됩니다. 테넌트별 오버라이드는 별도 레이어에 저장됩니다.

3. **AsyncLocalStorage 범위:** `MetadataContext.run()` 블록 외부에서는 컨텍스트가 `"public"`으로 자동 복귀됩니다.

4. **MultiTenantMetadataManager 사용 중단:** 이전 버전의 `MultiTenantMetadataManager`는 deprecated 처리되었습니다. `MetadataContext.run()` 또는 `LayeredMetadataStore`를 직접 사용하세요.
