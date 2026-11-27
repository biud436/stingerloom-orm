# 프로덕션 운영 가이드

프로덕션 서비스에서 Stingerloom ORM을 안전하게 운영하려면 개발 환경과 다른 설정과 운영 전략이 필요합니다. 개발 환경에서 프로덕션으로 옮기기 전에 아래 항목을 꼭 확인하세요.

---

## 1. 권장 프로덕션 설정

### 연결 풀 크기

연결 풀 크기는 DB 서버의 `max_connections`와 애플리케이션 인스턴스 수를 기준으로 정합니다.

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

> 참고: MySQL은 `min`, `acquireTimeoutMs`, `idleTimeoutMs`를 지원하지 않습니다. PostgreSQL에서는 풀을 더 세밀하게 제어할 수 있습니다.

**풀 크기 계산 공식**

```
Recommended pool.max = floor(DB max_connections / app instances) * 0.8
```

예시: PostgreSQL `max_connections = 200`, 앱 인스턴스 4개
-> `pool.max = floor(200 / 4) * 0.8 = 40`

---

### 쿼리 타임아웃

쿼리 타임아웃은 쿼리가 끝없이 실행되어 연결이 누수되는 일을 막습니다.

```typescript
await em.register({
  // ...
  queryTimeout: 30000, // Global: QueryTimeoutError after 30 seconds
});
```

특정 쿼리에만 다른 타임아웃을 적용할 수도 있습니다.

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

드라이버별 내부 구현은 다음과 같습니다.

| DB | Internal SQL |
|----|-------------|
| MySQL | `SET max_execution_time = N` |
| PostgreSQL | `SET LOCAL statement_timeout = N` |

---

### 재시도 옵션

`retry`는 `register()`가 여는 연결을 다시 시도합니다. 그래서 데이터베이스가 아직 시작 중이거나 네트워크가 잠깐 끊겨도 애플리케이션을 시작할 수 있습니다.

```typescript
await em.register({
  // ...
  retry: {
    maxAttempts: 5,  // Maximum 5 retry attempts
    backoffMs: 500,  // Base delay: 500ms (exponential backoff applied)
  },
});
```

대기는 실패한 시도 뒤에 들어갑니다. 그래서 다섯 번 시도하면 네 번 기다립니다.

| 실패한 시도 | 대기 시간 |
|-------------|-----------|
| 1회 | 500ms |
| 2회 | 1000ms |
| 3회 | 2000ms |
| 4회 | 4000ms |

마지막 시도까지 실패하면 `register()`가 `ORM_CONNECTION_FAILED`를 던집니다.

### 시작 이후 끊긴 연결

`retry`의 역할은 `register()`가 끝나면 끝납니다. 그 뒤에 서버가 연결을 닫으면 풀이 알아서 그 연결을 교체합니다. 서버 재시작, 페일오버, 방화벽이 끊은 유휴 연결이 이런 경우입니다. 그동안 애플리케이션은 계속 실행됩니다. 남은 일은 이런 일이 일어나는지 지켜보는 것뿐입니다. 이벤트를 메트릭으로 보내세요.

```typescript
await em.register({
  // ...
  onConnectionError: (error) => {
    // error.code === "ORM_CONNECTION_LOST"이고 error.cause는 드라이버 에러입니다
    metrics.increment("db.connection_lost");
  },
});
```

연결 하나가 끊길 때마다 콜백이 한 번 호출됩니다. 호출이 한꺼번에 몰리면 데이터베이스가 재시작됐거나 페일오버된 것입니다. 호출이 꾸준히 조금씩 들어온다면 대개 애플리케이션과 데이터베이스 사이의 무언가가 유휴 연결을 닫고 있는 것입니다. PostgreSQL이라면 `pool.idleTimeoutMs`를 그 타임아웃보다 짧게 잡으세요. `onConnectionError` 옵션을 지정하지 않으면 이벤트마다 경고 로그가 남습니다. 자세한 내용은 [시작 이후 끊긴 연결](./configuration.md#시작-이후-끊긴-연결)을 참고하세요.

---

### 로깅 레벨

프로덕션에서는 느린 쿼리 경고와 N+1 감지만 켜고 전체 SQL 로깅은 꺼 두세요.

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

코드에서 느린 쿼리를 직접 조회할 수도 있습니다.

```typescript
// Use in performance analysis endpoints, etc.
const slowQueries = em.getQueryLog().filter(
  (entry) => entry.durationMs > 1000,
);
```

---

## 2. synchronize에서 마이그레이션으로 전환하기

### `synchronize: true`가 프로덕션에서 위험한 이유

`synchronize: true`는 앱이 시작될 때 엔티티 정의에 맞춰 실제 DB 스키마를 자동으로 동기화합니다. 개발 중에는 편리합니다. 하지만 프로덕션에서는 다음과 같은 위험이 있습니다.

| 위험 요소 | 설명 |
|-----------|------|
| **데이터 유실** | 엔티티에 `@Column({ renamedFrom })`이 없고 두 이름이 같은 컬럼으로 보이지 않으면 컬럼 이름을 바꿀 때 기존 컬럼을 DROP하고 새 컬럼을 ADD합니다. 그 과정에서 데이터가 사라집니다. |
| **의도치 않은 DDL** | 엔티티를 수정해서 배포하면 프로덕션 DB에 스키마 변경이 바로 적용됩니다. |
| **롤백 불가** | 자동 변경은 기록이 남지 않습니다. 그래서 문제가 생겼을 때 이전 상태로 되돌리기 어렵습니다. |
| **다운타임** | 큰 테이블에 인덱스를 추가하면 테이블 전체에 잠금이 걸릴 수 있습니다. |

### 단계별 전환 절차

**Step 1: 현재 스키마와 엔티티의 차이 확인**

```typescript
import { SchemaDiff } from "@stingerloom/orm";

// EntityManager를 쿼리 러너로 씁니다. query(sql)이 있는 객체면 무엇이든 됩니다.
const diff = await new SchemaDiff().diff([User, Post, Comment], em, "postgres");

console.log("Tables to add:", diff.addTables);
console.log("Columns to add:", diff.addColumns);
console.log("Columns to change:", diff.alterColumns);
console.log("Columns to drop:", diff.dropColumns);
```

**Step 2: 마이그레이션 자동 생성**

```typescript
import { SchemaDiff, SchemaDiffMigrationGenerator } from "@stingerloom/orm";

const diff = await new SchemaDiff().diff([User, Post], em, "postgres");
const generator = new SchemaDiffMigrationGenerator();
const content = generator.generate(diff, "postgres");
const file = await generator.save(content, "./migrations");

console.log(`Migration written to ${file}`);
```

**Step 3: 마이그레이션 CLI 설정**

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

**Step 5: 배포 파이프라인에 마이그레이션 단계 추가**

```bash
# Deployment script example
pnpm build
pnpm migrate:run    # Run migrations before deployment
pm2 restart app     # Restart the app
```

---

## 3. 무중단 마이그레이션 전략

### 안전한 마이그레이션: 즉시 적용 가능

| 작업 | 안전? | 이유 |
|------|-------|------|
| `ADD COLUMN NULL` | 안전 | 기존 행에 NULL이 들어가며 서비스 영향 없음 |
| `ADD COLUMN DEFAULT` | 안전 | 기본값으로 자동으로 채워짐 |
| `CREATE INDEX CONCURRENTLY` | 안전 | 잠금 없이 인덱스 생성 (PostgreSQL) |
| `CREATE TABLE` | 안전 | 기존 테이블에 영향 없음 |
| `ADD FOREIGN KEY NOT VALID` | 안전 | 기존 데이터 검증을 건너뜀 |

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

### 위험한 마이그레이션: 단계별 적용 필요

| 작업 | 위험 원인 | 대응 전략 |
|------|-----------|-----------|
| `DROP COLUMN` | 앱 코드가 해당 컬럼을 참조하면 에러 | 코드에서 컬럼 참조 제거 후 DROP |
| `RENAME COLUMN` | 기존 코드가 이전 이름으로 쿼리 | 새 컬럼 추가 -> 데이터 복사 -> 코드 변경 -> 이전 컬럼 삭제 |
| `ADD COLUMN NOT NULL` | 기존 행에 값이 없으면 에러 | DEFAULT 추가 또는 NULL 허용 후 데이터 채우기 |
| `CREATE INDEX` | 테이블 전체 잠금 | PostgreSQL: `CONCURRENTLY` 옵션 사용 |
| `ALTER COLUMN TYPE` | 타입 변환 실패 가능 | 새 컬럼 추가 -> 변환 -> 교체 |

**컬럼 이름 변경: Zero-Downtime 단계별 방법**

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

### Blue-Green 배포 마이그레이션 순서

Blue-Green 배포에서는 이전 버전(Blue)과 새 버전(Green)이 같은 DB에 동시에 접근합니다.

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

## 4. 연결 풀 모니터링

### 풀 상태 확인

PostgreSQL에서는 현재 연결 상태를 직접 조회할 수 있습니다.

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

`idle in transaction`이 많으면 트랜잭션이 커밋이나 롤백 없이 오래 열려 있다는 뜻입니다.

**MySQL에서 연결 상태 조회**

```typescript
const processlist = await em.query<{ Command: string; Time: number }[]>(
  `SHOW PROCESSLIST`
);

const longRunning = processlist.filter((p) => p.Time > 30);
console.log("Running for 30+ seconds:", longRunning.length);
```

### 연결 누수 감지 (`ConnectionLeakDetector`)

::: warning `pool.leakDetectionThresholdMs`는 현재 동작하지 않습니다
`PoolOptions`에 이 옵션이 선언되어 있고 `ConnectionLeakDetector` 클래스도 export되어 있습니다. 하지만 둘을 연결하는 코드가 없습니다. `leakDetectionThresholdMs`를 읽는 드라이버가 하나도 없으므로 지금은 값을 지정해도 효과가 없습니다.

원인은 연결 경로가 서로 다르다는 데 있습니다. Detector는 `connector.acquireConnection()`이 반환하는 `IConnection` 래퍼를 추적합니다. 반면 ORM의 실제 트랜잭션 경로는 `IDataSource.createConnection()`으로 래퍼가 없는 드라이버 연결을 꺼내 씁니다. 그리고 `close()`, `commit()`, `rollback()` 등 여러 지점에서 그 연결을 해제합니다. 둘을 연결하려면 모든 드라이버의 연결 생명주기를 바꿔야 합니다. 이때 해제 경로를 하나라도 빠뜨리면 Detector는 없는 누수를 계속 보고합니다. 그래서 절반만 연결하지 않고 작업을 미뤄 두었습니다.

그때까지는 위의 "풀 상태 확인"에 나온 DB 수준 쿼리로 누수를 찾으세요. 아래에 나오는 느린 쿼리 로깅과 `queryTimeout`도 함께 쓰세요.
:::

클래스 자체는 정상적으로 동작하고 export되어 있습니다. 그래서 연결을 직접 획득하는 코드라면 다음처럼 쓸 수 있습니다.

```typescript
import { ConnectionLeakDetector, DatabaseClient } from "@stingerloom/orm";

const detector = new ConnectionLeakDetector(30_000); // 30초를 넘기면 경고합니다
const connector = DatabaseClient.getInstance().getConnection();

const conn = detector.track(await connector.acquireConnection());
try {
  // ... conn.getUnderlying()으로 작업 ...
} finally {
  detector.untrack(conn);
  await conn.release();
}
```

**로그에 남는 내용:**

```
[ConnectionLeakDetector] Potential connection leak detected: connection held
for 31250ms (threshold: 30000ms). Consider releasing it.
```

Detector는 백그라운드 타이머로 주기적으로 스캔합니다. 주기는 `checkIntervalMs`입니다. 지정하지 않으면 `thresholdMs / 2`가 되고 최솟값은 5초입니다. 스캔할 때마다 임계값을 넘긴 연결 하나당 경고를 한 건씩 남깁니다. 타이머에는 `unref()`가 적용되어 있어서 프로세스 종료를 막지 않습니다. 임계값을 `0`으로 지정하면 감지가 아예 꺼집니다. `shutdown()`을 호출하면 타이머가 멈추고 추적 목록도 비워집니다.

Detector는 관찰만 합니다. 트랜잭션이 COMMIT 중일 수 있으므로 누수된 연결을 강제로 반환하지 않습니다. 아래에 나오는 `queryTimeout`과 함께 쓰세요. 그러면 멈춘 SQL 문을 데이터베이스가 결국 취소하고 그 결과 연결도 해제됩니다.

**임계값 고르기:**

| 시나리오 | 권장 임계값 |
|---|---|
| 일반 OLTP 워크로드 (<1초 쿼리) | `10000` (10초): 누수를 빠르게 포착 |
| 리포팅 쿼리가 섞인 워크로드 | `30000` (30초) |
| 백그라운드 잡 / 대용량 배치 임포트 | `120000` (2분) 이상 |
| 비활성화 (단기 스크립트 등) | `0` |

### 느린 쿼리로 연결 누수 감지

트랜잭션을 열고 닫지 않으면 연결이 풀에 반환되지 않습니다. 그래서 풀이 고갈됩니다. `queryTimeout`으로 오래 실행되는 쿼리를 자동으로 종료하세요.

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

### 연결 누수 트러블슈팅 가이드

증상: `acquireTimeoutMs` 초과 에러가 자주 발생합니다.

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

**원인 3: 쿼리 타임아웃 미설정**
```typescript
// Solution: Set global timeout
queryTimeout: 30000
```

---

## 5. Graceful Shutdown 설정

### `propagateShutdown()` 사용법

`propagateShutdown()`은 `EntityManager`의 내부 상태를 안전하게 정리합니다.

```typescript
em.propagateShutdown(); // This method performs:
// - Remove event listeners (removeAllListeners)
// - Unsubscribe EntitySubscribers
// - Reset dirty entities cache
// - Clean up QueryTracker
// - Clean up ReplicationRouter
```

DB 연결 풀은 `DatabaseClient`에서 종료합니다.

### NestJS `onApplicationShutdown` 연동 예제

Graceful Shutdown은 예제 프로젝트 `examples/nestjs-cats/`의 ORM 서비스에 이미 구현되어 있습니다.

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

NestJS가 OS 시그널을 받았을 때 `onApplicationShutdown`을 호출하게 하려면 이 설정이 필요합니다.

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

> 참고: `enableShutdownHooks()`를 호출하지 않으면 Kubernetes Pod가 종료될 때 `onApplicationShutdown`이 호출되지 않습니다.

---

## 6. 대규모 멀티테넌시 운영

### 수백 개 테넌트의 메모리 영향

레이어드 메타데이터 시스템은 AsyncLocalStorage를 기반으로 합니다. 그래서 테넌트가 많아도 메모리는 주로 메타데이터 레이어가 차지합니다.

| 요소 | 메모리 영향 | 비고 |
|------|------------|------|
| 레이어드 메타데이터 | 테넌트당 수 KB | 엔티티 수에 비례 |
| 연결 풀 | 공유 (단일 풀) | 테넌트 수와 무관 |
| AsyncLocalStorage | 요청마다 컨텍스트만 생성 | 요청 완료 시 자동 정리 |

테넌트 레이어는 `MetadataContext.run()`으로 생성됩니다. 그리고 콜백이 끝나면 자동으로 정리됩니다. 테넌트가 1,000개라도 모든 테넌트가 연결 풀 하나를 함께 씁니다.

### 연결 풀 공유 전략

PostgreSQL 스키마 기반 멀티테넌시에서는 모든 테넌트가 연결 풀 하나를 공유합니다. 트랜잭션마다 `SET LOCAL search_path`로 스키마를 전환하므로 연결을 더 만들 필요가 없습니다.

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

`PostgresTenantMigrationRunner`는 새 테넌트 스키마를 자동으로 생성합니다. 그리고 내부에서 프로비저닝 잠금을 사용해 같은 테넌트를 중복으로 프로비저닝하지 않게 막습니다.

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

테넌트가 수백 개일 때 앱 시작 시점에 전부 프로비저닝하면 시작이 느려질 수 있습니다.

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

> 참고: `ensureSchema()`는 내부 잠금을 사용합니다. 그래서 같은 tenantId로 동시에 호출해도 프로비저닝은 한 번만 일어납니다. 새 테넌트 등록 API에서도 안전하게 쓸 수 있습니다.

---

## 전체 프로덕션 설정 예제

NestJS 프로덕션 환경에서 권장하는 전체 설정 예제입니다.

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
      onConnectionError: (error) => {
        metrics.increment("db.connection_lost");
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

## 다음 단계

- [Migrations](./migrations.md): 마이그레이션 파일 작성과 실행
- [Multi-Tenancy](./multi-tenancy.md): 레이어드 메타데이터 시스템 상세
- [Configuration Guide](./configuration.md): 전체 설정 옵션 레퍼런스
- [Advanced Features](./advanced.md): N+1 감지, EntitySubscriber, EXPLAIN 쿼리
