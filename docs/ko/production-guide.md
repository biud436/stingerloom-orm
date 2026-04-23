# Production 운영 가이드

개발 환경에서 프로덕션으로 전환할 때 필요한 설정, 전략, 트러블슈팅을 다루는 문서예요. 프로덕션 배포 전에 꼭 확인해 주세요.

---

## 1. 권장 프로덕션 설정

### Connection Pool 크기

커넥션 풀 크기는 DB 서버의 `max_connections`와 애플리케이션 인스턴스 수를 기준으로 정해요.

**PostgreSQL 권장 설정**

```typescript
await em.register({
  type: "postgres",
  host: process.env.DB_HOST,
  port: 5432,
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  entities: [User, Post],
  synchronize: false, // Must be false in production
  pool: {
    max: 20,               // Max connections: (DB max_connections / app instances) * 0.8
    min: 5,                // Maintain at least 5 connections even when idle
    acquireTimeoutMs: 5000, // Connection acquire wait time (shorter than default 30000ms)
    idleTimeoutMs: 60000,  // Return connections unused for 60 seconds
  },
});
```

**MySQL/MariaDB 권장 설정**

```typescript
await em.register({
  type: "mysql",
  host: process.env.DB_HOST,
  port: 3306,
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset: "utf8mb4",
  entities: [User, Post],
  synchronize: false,
  pool: {
    max: 20, // Applied as connectionLimit in MySQL
  },
});
```

> **Note:** MySQL은 `min`, `acquireTimeoutMs`, `idleTimeoutMs`를 지원하지 않아요. PostgreSQL이 더 세밀한 풀 제어가 가능해요.

**풀 크기 계산 공식**

```
Recommended pool.max = floor(DB max_connections / app instances) * 0.8
```

예시: PostgreSQL `max_connections = 200`, 앱 인스턴스 4개
-> `pool.max = floor(200 / 4) * 0.8 = 40`

---

### Query Timeout

쿼리가 무한정 실행되면서 커넥션이 누수되는 걸 방지해요.

```typescript
await em.register({
  // ...
  queryTimeout: 30000, // Global: QueryTimeoutError after 30 seconds
});
```

특정 쿼리에만 다른 타임아웃을 적용할 수도 있어요.

```typescript
// Separate timeout for heavy analytical queries
const result = await em.find(Order, {
  where: { status: "completed" },
  timeout: 60000, // 60 seconds for this query only
});

// Real-time queries requiring fast responses
const user = await em.findOne(User, {
  where: { id: userId },
  timeout: 3000, // Fail after 3 seconds
});
```

DB 드라이버별 내부 구현:

| DB | Internal SQL |
|----|-------------|
| MySQL | `SET max_execution_time = N` |
| PostgreSQL | `SET LOCAL statement_timeout = N` |

---

### Retry 옵션

DB 서버 재시작이나 일시적인 네트워크 끊김에서 자동으로 복구해요.

```typescript
await em.register({
  // ...
  retry: {
    maxAttempts: 5,  // Maximum 5 retry attempts
    backoffMs: 500,  // Base delay: 500ms (exponential backoff applied)
  },
});
```

Exponential backoff 대기 시간:

| 시도 | 대기 시간 |
|------|-----------|
| 1회 | 500ms |
| 2회 | 1000ms |
| 3회 | 2000ms |
| 4회 | 4000ms |
| 5회 | 8000ms |

---

### 로깅 레벨

프로덕션에서는 slow query와 N+1 감지만 켜고, 전체 SQL 로깅은 꺼두세요.

```typescript
await em.register({
  // ...
  logging: {
    queries: false,      // Disable full SQL logging (performance impact)
    slowQueryMs: 1000,   // Warn only on queries taking longer than 1 second
    nPlusOne: true,      // Enable N+1 pattern detection
  },
});
```

코드에서 직접 slow query를 조회할 수도 있어요.

```typescript
// Use in performance analysis endpoints, etc.
const slowQueries = em.getQueryLog().filter(
  (entry) => entry.durationMs > 1000,
);
```

---

## 2. synchronize에서 Migration으로 전환하기

### `synchronize: true`가 프로덕션에서 위험한 이유

`synchronize: true`는 앱 시작 시 엔티티 정의와 실제 DB 스키마를 자동으로 동기화해요. 개발 중에는 편리하지만, 프로덕션에서는 다음과 같은 위험이 있어요.

| 위험 요소 | 설명 |
|-----------|------|
| **데이터 유실** | 컬럼 이름을 바꾸면 기존 컬럼을 DROP하고 새 컬럼을 ADD해요. 데이터가 사라져요. |
| **의도치 않은 DDL** | 엔티티 수정 후 배포하면 프로덕션 DB에 스키마 변경이 즉시 적용돼요. |
| **롤백 불가** | 자동 변경은 기록이 없어서 문제 발생 시 이전 상태로 되돌리기 어려워요. |
| **다운타임** | 대형 테이블에 인덱스를 추가하면 full table lock이 걸릴 수 있어요. |

### 단계별 전환 절차

**Step 1: 현재 스키마와 엔티티 간 차이 확인**

```typescript
import { SchemaDiff } from "@stingerloom/orm";

const diff = await SchemaDiff.compare(em, [User, Post, Comment]);

console.log("Tables to add:", diff.addedTables);
console.log("Tables to drop:", diff.droppedTables);
console.log("Tables to modify:", diff.modifiedTables);
```

**Step 2: Migration 자동 생성**

```typescript
import { SchemaDiff, SchemaDiffMigrationGenerator } from "@stingerloom/orm";

const diff = await SchemaDiff.compare(em, [User, Post]);
const generator = new SchemaDiffMigrationGenerator();
const migrations = generator.generate(diff);

console.log(`${migrations.length} migrations generated`);
```

**Step 3: Migration CLI 설정**

```typescript
// src/migrate.ts
import { MigrationCli } from "@stingerloom/orm";
import { CreateUsersTable } from "./migrations/001_CreateUsersTable";
import { AddPhoneToUsers } from "./migrations/002_AddPhoneToUsers";

const cli = new MigrationCli(
  [new CreateUsersTable(), new AddPhoneToUsers()],
  {
    type: "postgres",
    host: process.env.DB_HOST!,
    port: 5432,
    username: process.env.DB_USER!,
    password: process.env.DB_PASSWORD!,
    database: process.env.DB_NAME!,
    entities: [],
  },
);

async function main() {
  await cli.connect();
  try {
    const result = await cli.execute(process.argv[2] as any);
    console.log(result);
  } finally {
    await cli.close();
  }
}

main().catch(console.error);
```

```json
// package.json
{
  "scripts": {
    "migrate:run": "ts-node ./src/migrate.ts migrate:run",
    "migrate:rollback": "ts-node ./src/migrate.ts migrate:rollback",
    "migrate:status": "ts-node ./src/migrate.ts migrate:status"
  }
}
```

**Step 4: `synchronize` 비활성화**

```typescript
// Before
await em.register({ synchronize: true, ... });

// After
await em.register({ synchronize: false, ... }); // or remove the option (default is false)
```

**Step 5: 배포 파이프라인에 migration 단계 추가**

```bash
# Deployment script example
pnpm build
pnpm migrate:run    # Run migrations before deployment
pm2 restart app     # Restart the app
```

---

## 3. Zero-Downtime Migration 전략

### 안전한 Migration -- 즉시 적용 가능

| 작업 | 안전? | 이유 |
|------|-------|------|
| `ADD COLUMN NULL` | 안전 | 기존 행에 NULL이 들어가고, 서비스에 영향 없어요 |
| `ADD COLUMN DEFAULT` | 안전 | 기본값으로 자동 채워져요 |
| `CREATE INDEX CONCURRENTLY` | 안전 | 락 없이 인덱스를 생성해요 (PostgreSQL) |
| `CREATE TABLE` | 안전 | 기존 테이블에 영향 없어요 |
| `ADD FOREIGN KEY NOT VALID` | 안전 | 기존 데이터 검증을 건너뛰어요 |

```typescript
// Safe migration example: Adding a nullable column
export class AddOptionalBioToUsers extends Migration {
  async up(context: MigrationContext) {
    await context.query(
      `ALTER TABLE "users" ADD COLUMN "bio" TEXT NULL`
    );
  }

  async down(context: MigrationContext) {
    await context.query(
      `ALTER TABLE "users" DROP COLUMN "bio"`
    );
  }
}
```

### 위험한 Migration -- 단계별 적용 필요

| 작업 | 위험 원인 | 대응 전략 |
|------|-----------|-----------|
| `DROP COLUMN` | 앱 코드가 해당 컬럼을 참조하면 에러 | 코드에서 컬럼 참조 제거 후 DROP |
| `RENAME COLUMN` | 기존 코드가 이전 이름으로 쿼리 | 새 컬럼 추가 -> 데이터 복사 -> 코드 변경 -> 이전 컬럼 삭제 |
| `ADD COLUMN NOT NULL` | 기존 행에 값이 없으면 에러 | DEFAULT 추가 또는 NULL 허용 후 데이터 채우기 |
| `CREATE INDEX` | Full table lock | PostgreSQL: `CONCURRENTLY` 옵션 사용 |
| `ALTER COLUMN TYPE` | 타입 변환 실패 가능 | 새 컬럼 추가 -> 변환 -> 교체 |

**컬럼 이름 변경 -- Zero-Downtime 단계별 방법**

```typescript
// Step 1: Add new column (app v1 writes to both columns)
export class Step1_AddNewColumn extends Migration {
  async up(ctx: MigrationContext) {
    await ctx.query(
      `ALTER TABLE "users" ADD COLUMN "display_name" VARCHAR(100) NULL`
    );
    // Copy existing data
    await ctx.query(
      `UPDATE "users" SET "display_name" = "name" WHERE "display_name" IS NULL`
    );
  }
}

// Step 2: Deploy app v2 (reads/writes only new column)

// Step 3: Drop old column
export class Step3_DropOldColumn extends Migration {
  async up(ctx: MigrationContext) {
    await ctx.query(
      `ALTER TABLE "users" DROP COLUMN "name"`
    );
  }
}
```

### Blue-Green 배포 Migration 순서

Blue-Green 배포에서는 이전 버전(Blue)과 새 버전(Green)이 동일한 DB에 동시 접근해요.

```
Order:
1. Run backward-compatible migrations (works on the old version)
2. Deploy Green and switch traffic
3. Run cleanup migrations (old version no longer exists)
```

```bash
# 1. Backward-compatible migrations (works for both Blue and Green)
pnpm migrate:run   # Only includes ADD COLUMN NULL, ADD INDEX, etc.

# 2. Deploy Green
kubectl apply -f deployment-green.yaml

# 3. Cleanup after traffic switch
pnpm migrate:run   # Final cleanup: DROP old columns, RENAME, etc.
```

---

## 4. Connection Pool 모니터링

### 풀 상태 확인

PostgreSQL에서 현재 커넥션 상태를 직접 조회할 수 있어요.

```typescript
// Query connection status (PostgreSQL)
const stats = await em.query<{ state: string; count: string }[]>(`
  SELECT state, count(*)::text as count
  FROM pg_stat_activity
  WHERE datname = current_database()
  GROUP BY state
`);

console.log("Connection status:", stats);
// [
//   { state: "active", count: "5" },
//   { state: "idle", count: "15" },
//   { state: "idle in transaction", count: "2" }
// ]
```

`idle in transaction`이 많으면 트랜잭션이 commit/rollback 없이 오래 열려 있다는 뜻이에요.

**MySQL에서 커넥션 상태 조회**

```typescript
const processlist = await em.query<{ Command: string; Time: number }[]>(
  `SHOW PROCESSLIST`
);

const longRunning = processlist.filter((p) => p.Time > 30);
console.log("Running for 30+ seconds:", longRunning.length);
```

### 내장 Leak Detector (`leakDetectionThresholdMs`)

모든 드라이버는 커넥션 풀에 **`ConnectionLeakDetector`** 를 연결해요. 체크아웃된 커넥션이 `pool.leakDetectionThresholdMs`보다 오래 점유되면 ORM이 경고를 남겨서 어느 호출 경로가 반환을 잊었는지 추적할 수 있어요. DB별로 설정하세요:

```typescript
await em.register({
  // ...
  pool: {
    max: 20,
    acquireTimeoutMs: 5000,
    idleTimeoutMs: 10000,
    leakDetectionThresholdMs: 30000, // 기본값 — 30초 초과 시 경고
  },
});
```

**로그에 남는 내용:**

```
[ConnectionLeakDetector] Potential connection leak detected: connection held
for 31250ms (threshold: 30000ms). Consider releasing it.
```

Detector는 백그라운드 타이머(`thresholdMs / 2`, 최소 5초)에서 추적 커넥션을 스캔하고, 스캔마다 임계값 초과 커넥션당 1건의 경고를 발행해요. 타이머는 `unref()` 처리되어 있어서 프로세스 종료를 막지 않아요.

**튜닝 가이드:**

| 시나리오 | 권장 임계값 |
|---|---|
| 일반 OLTP 워크로드 (<1초 쿼리) | `10000` (10초) — 누수를 빠르게 포착 |
| 리포팅 쿼리 혼합 | `30000` (30초, 기본값) |
| 백그라운드 잡 / 대용량 배치 임포트 | `120000` (2분) 이상 |
| **비활성화** (단기 스크립트 등) | `0` |

Detector는 **관찰 전용** 이에요 — 누수된 커넥션을 강제로 반환하지 않아요. 트랜잭션이 COMMIT 중일 수 있기 때문이죠. `queryTimeout`(아래)과 함께 쓰면, DB 수준 취소가 결국 멈춘 statement를 닫고 그 결과 커넥션도 해제돼요.

### Slow Query를 통한 커넥션 누수 감지

트랜잭션을 열고 닫지 않으면 커넥션이 풀에 반환되지 않아서 풀이 고갈돼요. `queryTimeout`으로 장시간 실행되는 쿼리를 자동 종료할 수 있어요.

```typescript
await em.register({
  // ...
  queryTimeout: 30000, // Auto-terminate queries exceeding 30 seconds
  logging: {
    slowQueryMs: 5000,  // Warning log for queries taking 5+ seconds
    nPlusOne: true,
  },
  pool: {
    max: 20,
    acquireTimeoutMs: 5000, // Error if connection not acquired within 5 seconds -> early pool exhaustion detection
  },
});
```

### 커넥션 누수 트러블슈팅 가이드

**증상:** `acquireTimeoutMs` 초과 에러가 자주 발생

**원인 1: 풀 크기가 너무 작음**
```typescript
// Solution: Increase pool.max
pool: { max: 30 }
```

**원인 2: 닫히지 않은 트랜잭션**
```typescript
// Problem: Using transactions without try -> connection not returned on error
// Using Stingerloom's @Transactional decorator handles this automatically.
import { Transactional } from "@stingerloom/orm";

@Transactional()
async createOrder(data: CreateOrderDto) {
  await this.orderRepo.save(data);     // Auto ROLLBACK + connection return on error
  await this.inventoryRepo.save(data);
}
```

**원인 3: Query timeout 미설정**
```typescript
// Solution: Set global timeout
queryTimeout: 30000
```

---

## 5. Graceful Shutdown 설정

### `propagateShutdown()` 사용법

`propagateShutdown()`은 `EntityManager`의 내부 상태를 안전하게 정리해요.

```typescript
em.propagateShutdown(); // This method performs:
// - Remove event listeners (removeAllListeners)
// - Unsubscribe EntitySubscribers
// - Reset dirty entities cache
// - Clean up QueryTracker
// - Clean up ReplicationRouter
```

DB 커넥션 풀 종료는 `DatabaseClient`를 통해 처리돼요.

### NestJS `onApplicationShutdown` 연동 예제

Graceful Shutdown은 예제 프로젝트(`examples/nestjs-cats/`)의 ORM 서비스에 이미 구현되어 있어요.

```typescript
// stingerloom-orm.service.ts
import {
  Injectable,
  OnModuleInit,
  OnApplicationShutdown,
} from "@nestjs/common";
import { EntityManager } from "@stingerloom/orm";

@Injectable()
export class StingerloomOrmService
  implements OnModuleInit, OnApplicationShutdown
{
  constructor(private readonly entityManager: EntityManager) {}

  async onModuleInit(): Promise<void> {
    await this.entityManager.register({ /* settings */ });
  }

  async onApplicationShutdown(): Promise<void> {
    // 1. Clean up EntityManager internal state
    await this.entityManager.propagateShutdown();
    // 2. DB connection pool shutdown is handled automatically by DatabaseClient
    console.log("ORM connection released");
  }
}
```

### SIGTERM/SIGINT 처리 (NestJS 없이)

```typescript
// main.ts (plain Node.js)
import "reflect-metadata";
import { EntityManager } from "@stingerloom/orm";

const em = new EntityManager();

async function main() {
  await em.register({ /* settings */ });
  console.log("Server started");

  // Register Graceful Shutdown handler
  const shutdown = async (signal: string) => {
    console.log(`${signal} received — shutting down...`);
    await em.propagateShutdown();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM")); // Kubernetes, Docker shutdown signal
  process.on("SIGINT", () => shutdown("SIGINT"));   // Ctrl+C
}

main().catch(console.error);
```

### NestJS enableShutdownHooks 설정

NestJS에서 OS 시그널 수신 시 `onApplicationShutdown`이 호출되려면 이 설정이 필요해요.

```typescript
// main.ts (NestJS)
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Enable NestJS to handle OS signals like SIGTERM, SIGINT
  app.enableShutdownHooks();

  await app.listen(3000);
}

bootstrap();
```

> **Note:** `enableShutdownHooks()`를 호출하지 않으면 Kubernetes Pod 종료 시 `onApplicationShutdown`이 호출되지 않아요.

---

## 6. 대규모 Multi-Tenancy 운영

### 수백 개 테넌트의 메모리 영향

레이어드 메타데이터 시스템은 AsyncLocalStorage 기반이라서, 테넌트 수가 많아도 메모리는 주로 메타데이터 레이어에서 소비돼요.

| 요소 | 메모리 영향 | 비고 |
|------|------------|------|
| Layered metadata | 테넌트당 수 KB | 엔티티 수에 비례 |
| Connection pool | **공유** (단일 풀) | 테넌트 수와 무관 |
| AsyncLocalStorage | 요청당 컨텍스트 생성 | 요청 완료 시 자동 정리 |

테넌트 레이어는 `MetadataContext.run()`으로 생성되고, 콜백 완료 시 자동 정리돼요. 테넌트가 1,000개라도 동시 커넥션 풀은 하나를 공유해요.

### Connection Pool 공유 전략

PostgreSQL 스키마 기반 멀티테넌시에서는 모든 테넌트가 하나의 커넥션 풀을 공유해요. 트랜잭션마다 `SET LOCAL search_path`로 스키마를 전환하기 때문에 추가 커넥션이 필요 없어요.

```typescript
// PostgreSQL multi-tenancy: Handle all tenants with a single pool.max
await em.register({
  type: "postgres",
  // ...
  pool: {
    // Calculate based on tenant count * expected concurrent requests
    // e.g., 100 tenants * 0.2 concurrent requests = 20 connections
    max: 20,
    min: 5,
    acquireTimeoutMs: 5000,
    idleTimeoutMs: 60000,
  },
});
```

### 테넌트 프로비저닝 자동화

`PostgresTenantMigrationRunner`가 새 테넌트 스키마를 자동 생성해요. 내부적으로 provisioning lock을 사용해서 중복 프로비저닝을 방지해요.

```typescript
// tenant-provisioning.service.ts
import { Injectable, OnModuleInit } from "@nestjs/common";
import { EntityManager, PostgresTenantMigrationRunner } from "@stingerloom/orm";

@Injectable()
export class TenantProvisioningService implements OnModuleInit {
  private runner!: PostgresTenantMigrationRunner;

  constructor(private readonly em: EntityManager) {}

  async onModuleInit() {
    const driver = this.em.getDriver()!;
    this.runner = new PostgresTenantMigrationRunner(driver, {
      sourceSchema: "public", // Replicate table structure from the public schema
    });

    // Synchronize all existing tenant schemas on app startup
    const result = await this.runner.syncTenantSchemas([
      "acme_corp",
      "globex",
      "umbrella",
    ]);

    console.log(`Newly created: ${result.created.join(", ")}`);
    console.log(`Already exist: ${result.skipped.join(", ")}`);
  }

  // Called from the new tenant registration API
  async provisionTenant(tenantId: string): Promise<void> {
    await this.runner.ensureSchema(tenantId);
    // Even with concurrent calls for the same tenantId, provisioning occurs only once (lock guarantee)
  }

  // Check if a specific tenant is provisioned
  isTenantProvisioned(tenantId: string): boolean {
    return this.runner.isProvisioned(tenantId);
  }
}
```

### HTTP 요청별 테넌트 컨텍스트 설정

```typescript
// tenant.middleware.ts
import { Injectable, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { MetadataContext } from "@stingerloom/orm";

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(
    private readonly provisioningService: TenantProvisioningService,
  ) {}

  use(req: Request, res: Response, next: NextFunction) {
    const tenantId = req.headers["x-tenant-id"] as string;

    if (!tenantId) {
      // Requests without tenant header use public context
      return next();
    }

    // Wrap the entire request in a tenant context
    // Thanks to AsyncLocalStorage, the same context is maintained across all async calls within the request
    MetadataContext.run(tenantId, () => {
      next();
    });
  }
}
```

### 대량 테넌트 초기화 시 고려사항

테넌트가 수백 개일 때 앱 시작 시 전부 프로비저닝하면 시작 시간이 느려질 수 있어요.

```typescript
// Recommended: Provision in batches
async function provisionAllTenants(
  runner: PostgresTenantMigrationRunner,
  tenantIds: string[],
  batchSize = 20,
) {
  for (let i = 0; i < tenantIds.length; i += batchSize) {
    const batch = tenantIds.slice(i, i + batchSize);
    await runner.syncTenantSchemas(batch);
    console.log(`Provisioning complete: ${i + batch.length}/${tenantIds.length}`);
  }
}
```

> **Note:** `ensureSchema()`는 내부 lock을 사용해서, 같은 tenantId로 동시 호출해도 프로비저닝은 한 번만 일어나요. 새 테넌트 등록 API에서 안전하게 사용할 수 있어요.

---

## 전체 프로덕션 설정 예제

NestJS 프로덕션 환경에서 권장하는 전체 설정 예제예요.

```typescript
// app.module.ts
import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { User, Post, Comment } from "./entities";

@Module({
  imports: [
    StingerloomOrmModule.forRoot({
      type: "postgres",
      host: process.env.DB_HOST!,
      port: parseInt(process.env.DB_PORT ?? "5432"),
      username: process.env.DB_USER!,
      password: process.env.DB_PASSWORD!,
      database: process.env.DB_NAME!,
      entities: [User, Post, Comment],
      synchronize: false, // Must be false in production
      queryTimeout: 30000, // 30-second global timeout
      pool: {
        max: 20,
        min: 5,
        acquireTimeoutMs: 5000,
        idleTimeoutMs: 60000,
      },
      retry: {
        maxAttempts: 5,
        backoffMs: 500,
      },
      logging: {
        queries: false,
        slowQueryMs: 1000,
        nPlusOne: true,
      },
      replication: {
        master: {
          host: process.env.DB_MASTER_HOST!,
          port: 5432,
          username: process.env.DB_USER!,
          password: process.env.DB_PASSWORD!,
          database: process.env.DB_NAME!,
        },
        slaves: [
          {
            host: process.env.DB_REPLICA_HOST!,
            port: 5432,
            username: process.env.DB_READONLY_USER!,
            password: process.env.DB_READONLY_PASSWORD!,
            database: process.env.DB_NAME!,
          },
        ],
      },
    }),
  ],
})
export class AppModule {}
```

```typescript
// main.ts
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Enable Graceful Shutdown (required)
  app.enableShutdownHooks();

  await app.listen(process.env.PORT ?? 3000);
}

bootstrap();
```

---

## Next Steps

- [Migrations](./migrations.md) -- Migration 파일 작성과 실행
- [Multi-Tenancy](./multi-tenancy.md) -- 레이어드 메타데이터 시스템 상세
- [Configuration Guide](./configuration.md) -- 전체 설정 옵션 레퍼런스
- [Advanced Features](./advanced.md) -- N+1 감지, EntitySubscriber, EXPLAIN 쿼리
