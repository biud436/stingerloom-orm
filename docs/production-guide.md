# 프로덕션 운영 가이드 (Production Operations Guide)

이 문서는 Stingerloom ORM을 실제 서비스 환경에서 안전하게 운영하기 위한 설정, 전략, 트러블슈팅 가이드를 제공합니다. 개발 환경에서 프로덕션으로 전환할 때 반드시 확인하세요.

---

## 1. 프로덕션 권장 설정값

### 커넥션 풀(Connection Pool) 크기

커넥션 풀 크기는 DB 서버의 `max_connections`와 애플리케이션 인스턴스 수를 고려해서 결정합니다.

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
  synchronize: false, // 프로덕션에서는 반드시 false
  pool: {
    max: 20,               // 최대 커넥션 수: (DB max_connections / 앱 인스턴스 수) × 0.8
    min: 5,                // 유휴 상태에서도 최소 5개 커넥션 유지
    acquireTimeoutMs: 5000, // 커넥션 획득 대기 시간 (기본 30000ms보다 짧게)
    idleTimeoutMs: 60000,  // 60초간 사용하지 않은 커넥션 반환
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
    max: 20, // MySQL은 connectionLimit으로 적용됨
  },
});
```

> **참고:** MySQL은 `min`, `acquireTimeoutMs`, `idleTimeoutMs`를 지원하지 않습니다. PostgreSQL을 사용하면 더 세밀한 풀 제어가 가능합니다.

**풀 크기 계산 공식**

```
권장 pool.max = floor(DB max_connections / 앱 인스턴스 수) × 0.8
```

예시: PostgreSQL `max_connections = 200`, 앱 인스턴스 4개
→ `pool.max = floor(200 / 4) × 0.8 = 40`

---

### 쿼리 타임아웃(Query Timeout)

무한정 실행되는 쿼리로 인한 커넥션 누수를 방지합니다.

```typescript
await em.register({
  // ...
  queryTimeout: 30000, // 전역: 30초 초과 시 QueryTimeoutError 발생
});
```

특정 쿼리만 다른 타임아웃을 적용할 수 있습니다.

```typescript
// 분석용 무거운 쿼리는 별도 타임아웃
const result = await em.find(Order, {
  where: { status: "completed" },
  timeout: 60000, // 이 쿼리만 60초
});

// 빠른 응답이 필요한 실시간 조회
const user = await em.findOne(User, {
  where: { id: userId },
  timeout: 3000, // 3초 초과 시 실패
});
```

DB 드라이버별 내부 구현:

| DB | 내부 SQL |
|----|---------|
| MySQL | `SET max_execution_time = N` |
| PostgreSQL | `SET LOCAL statement_timeout = N` |

---

### 재시도 설정(RetryOptions)

DB 서버 재시작, 일시적 네트워크 단절 상황에서 자동 복구합니다.

```typescript
await em.register({
  // ...
  retry: {
    maxAttempts: 5,  // 최대 5회 재시도
    backoffMs: 500,  // 기본 지연: 500ms (지수 백오프 적용)
  },
});
```

지수 백오프(Exponential Backoff) 대기 시간:

| 시도 | 대기 시간 |
|------|----------|
| 1차  | 500ms    |
| 2차  | 1000ms   |
| 3차  | 2000ms   |
| 4차  | 4000ms   |
| 5차  | 8000ms   |

---

### 로깅 레벨(Logging Level)

프로덕션에서는 슬로우 쿼리와 N+1 감지만 활성화하고, 전체 SQL 로깅은 끕니다.

```typescript
await em.register({
  // ...
  logging: {
    queries: false,      // SQL 전체 로깅 비활성화 (성능 영향)
    slowQueryMs: 1000,   // 1초 이상 걸리는 쿼리만 경고
    nPlusOne: true,      // N+1 패턴 감지 활성화
  },
});
```

슬로우 쿼리를 코드에서 직접 조회:

```typescript
// 성능 분석 엔드포인트 등에서 활용
const slowQueries = em.getQueryLog().filter(
  (entry) => entry.durationMs > 1000,
);
```

---

## 2. synchronize에서 마이그레이션으로 전환

### 왜 프로덕션에서 `synchronize: true`가 위험한가

`synchronize: true`는 앱 시작 시 엔티티 정의와 실제 DB 스키마를 자동으로 일치시킵니다. 개발 환경에서는 편리하지만, 프로덕션에서는 다음과 같은 위험이 있습니다.

| 위험 | 설명 |
|------|------|
| **데이터 손실** | 컬럼명을 변경하면 기존 컬럼을 DROP하고 새 컬럼을 ADD합니다. 데이터가 사라집니다. |
| **예기치 않은 DDL** | 엔티티 수정 후 배포 시 운영 DB에 즉시 스키마 변경이 적용됩니다. |
| **롤백 불가** | 자동 변경은 기록이 없어서 문제 발생 시 이전 상태로 되돌리기 어렵습니다. |
| **다운타임** | 대형 테이블에 인덱스 추가 시 테이블 전체 잠금이 발생할 수 있습니다. |

### 단계별 전환 절차

**1단계: 현재 스키마와 엔티티 차이 확인**

```typescript
import { SchemaDiff } from "@stingerloom/orm";

const diff = await SchemaDiff.compare(em, [User, Post, Comment]);

console.log("추가될 테이블:", diff.addedTables);
console.log("삭제될 테이블:", diff.droppedTables);
console.log("수정될 테이블:", diff.modifiedTables);
```

**2단계: 마이그레이션 자동 생성**

```typescript
import { SchemaDiff, SchemaDiffMigrationGenerator } from "@stingerloom/orm";

const diff = await SchemaDiff.compare(em, [User, Post]);
const generator = new SchemaDiffMigrationGenerator();
const migrations = generator.generate(diff);

console.log(`${migrations.length}개 마이그레이션 생성됨`);
```

**3단계: 마이그레이션 CLI 설정**

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

**4단계: `synchronize` 비활성화**

```typescript
// 변경 전
await em.register({ synchronize: true, ... });

// 변경 후
await em.register({ synchronize: false, ... }); // 또는 옵션 제거 (기본값 false)
```

**5단계: 배포 파이프라인에 마이그레이션 단계 추가**

```bash
# 배포 스크립트 예시
pnpm build
pnpm migrate:run    # 배포 전 마이그레이션 실행
pm2 restart app     # 앱 재시작
```

---

## 3. 무중단 마이그레이션 전략

### 호환 가능한 마이그레이션(Safe Migrations) — 즉시 적용 가능

| 작업 | 안전 여부 | 이유 |
|------|----------|------|
| `ADD COLUMN NULL` | 안전 | 기존 행에 NULL 삽입, 서비스 영향 없음 |
| `ADD COLUMN DEFAULT` | 안전 | 기본값으로 자동 채워짐 |
| `CREATE INDEX CONCURRENTLY` | 안전 | 잠금 없이 인덱스 생성 (PostgreSQL) |
| `CREATE TABLE` | 안전 | 기존 테이블에 영향 없음 |
| `ADD FOREIGN KEY NOT VALID` | 안전 | 기존 데이터 검증 생략 |

```typescript
// 안전한 마이그레이션 예시: NULL 허용 컬럼 추가
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

### 위험한 마이그레이션(Risky Migrations) — 단계적 적용 필요

| 작업 | 위험 원인 | 대응 전략 |
|------|----------|----------|
| `DROP COLUMN` | 앱 코드가 컬럼을 참조하면 에러 | 코드에서 컬럼 참조 제거 후 DROP |
| `RENAME COLUMN` | 기존 코드가 옛 이름으로 쿼리 | 새 컬럼 추가 → 데이터 복사 → 코드 변경 → 옛 컬럼 삭제 |
| `ADD COLUMN NOT NULL` | 기존 행에 값 없어 오류 | DEFAULT 추가 또는 NULL 허용 후 데이터 채우기 |
| `CREATE INDEX` | 테이블 전체 잠금 | PostgreSQL: `CONCURRENTLY` 옵션 사용 |
| `ALTER COLUMN TYPE` | 타입 변환 실패 가능 | 새 컬럼 추가 → 변환 → 스왑 |

**컬럼 이름 변경 — 단계별 무중단 방법**

```typescript
// Step 1: 새 컬럼 추가 (앱 v1에서 양쪽 컬럼 모두 쓰기)
export class Step1_AddNewColumn extends Migration {
  async up(ctx: MigrationContext) {
    await ctx.query(
      `ALTER TABLE "users" ADD COLUMN "display_name" VARCHAR(100) NULL`
    );
    // 기존 데이터 복사
    await ctx.query(
      `UPDATE "users" SET "display_name" = "name" WHERE "display_name" IS NULL`
    );
  }
}

// Step 2: 앱 v2 배포 (new column만 읽기/쓰기)

// Step 3: 기존 컬럼 삭제
export class Step3_DropOldColumn extends Migration {
  async up(ctx: MigrationContext) {
    await ctx.query(
      `ALTER TABLE "users" DROP COLUMN "name"`
    );
  }
}
```

### 블루-그린 배포(Blue-Green Deployment) 시 마이그레이션 순서

블루-그린 배포에서는 구버전(Blue)과 신버전(Green)이 동시에 같은 DB를 바라봅니다.

```
순서:
1. 하위 호환 마이그레이션 실행 (구버전에서도 동작)
2. Green 배포 및 트래픽 전환
3. 정리 마이그레이션 실행 (더 이상 구버전 없음)
```

```bash
# 1. 하위 호환 마이그레이션 (Blue, Green 모두 동작)
pnpm migrate:run   # ADD COLUMN NULL, ADD INDEX 등만 포함

# 2. Green 배포
kubectl apply -f deployment-green.yaml

# 3. 트래픽 전환 후 정리
pnpm migrate:run   # DROP old columns, RENAME 등 최종 정리
```

---

## 4. 커넥션 풀 모니터링

### 풀 상태 확인

PostgreSQL에서 실행 중인 커넥션 현황을 직접 조회할 수 있습니다.

```typescript
// 커넥션 현황 조회 (PostgreSQL)
const stats = await em.query<{ state: string; count: string }[]>(`
  SELECT state, count(*)::text as count
  FROM pg_stat_activity
  WHERE datname = current_database()
  GROUP BY state
`);

console.log("커넥션 상태:", stats);
// [
//   { state: "active", count: "5" },
//   { state: "idle", count: "15" },
//   { state: "idle in transaction", count: "2" }
// ]
```

`idle in transaction` 수가 많으면 트랜잭션이 커밋/롤백 없이 장시간 열려 있다는 신호입니다.

**MySQL에서 커넥션 현황 조회**

```typescript
const processlist = await em.query<{ Command: string; Time: number }[]>(
  `SHOW PROCESSLIST`
);

const longRunning = processlist.filter((p) => p.Time > 30);
console.log("30초 이상 실행 중:", longRunning.length);
```

### 슬로우 쿼리로 커넥션 누수 탐지

트랜잭션을 열고 닫지 않으면 커넥션이 반환되지 않아 풀이 고갈됩니다. `queryTimeout`으로 장시간 실행 쿼리를 자동 종료하세요.

```typescript
await em.register({
  // ...
  queryTimeout: 30000, // 30초 초과 쿼리 자동 종료
  logging: {
    slowQueryMs: 5000,  // 5초 이상이면 경고 로그 출력
    nPlusOne: true,
  },
  pool: {
    max: 20,
    acquireTimeoutMs: 5000, // 5초 안에 커넥션 못 얻으면 에러 → 풀 고갈 조기 발견
  },
});
```

### 커넥션 누수 트러블슈팅 가이드

**증상:** `acquireTimeoutMs` 초과 오류가 빈번하게 발생함

**원인 1: 풀 크기 부족**
```typescript
// 해결: pool.max 증가
pool: { max: 30 }
```

**원인 2: 미닫힌 트랜잭션**
```typescript
// 문제: try 없이 트랜잭션 사용 → 에러 발생 시 커넥션 반환 안 됨
// Stingerloom의 @Transactional 데코레이터를 쓰면 자동 관리됩니다.
import { Transactional } from "@stingerloom/orm";

@Transactional()
async createOrder(data: CreateOrderDto) {
  await this.orderRepo.save(data);     // 에러 발생 시 자동 ROLLBACK + 커넥션 반환
  await this.inventoryRepo.save(data);
}
```

**원인 3: 쿼리 타임아웃 미설정**
```typescript
// 해결: 전역 타임아웃 설정
queryTimeout: 30000
```

---

## 5. Graceful Shutdown 설정

### `propagateShutdown()` 사용법

`propagateShutdown()`은 `EntityManager`의 내부 상태를 안전하게 정리합니다.

```typescript
em.propagateShutdown(); // 이 메서드가 수행하는 작업:
// - 이벤트 리스너 제거 (removeAllListeners)
// - EntitySubscriber 구독 해제
// - dirty entities 캐시 초기화
// - QueryTracker 정리
// - ReplicationRouter 정리
```

DB 커넥션 풀 종료는 `DatabaseClient`를 통해 이루어집니다.

### NestJS `onApplicationShutdown` 연동 예제

예제 프로젝트(`examples/nestjs-cats/`)의 ORM 서비스에서 Graceful Shutdown이 이미 구현되어 있습니다.

```typescript
// stingerloom-orm.service.ts
import {
  Injectable,
  OnModuleInit,
  OnApplicationShutdown,
} from "@nestjs/common";
import { EntityManager } from "@stingerloom/orm";

@Injectable()
export class StinglerloomOrmService
  implements OnModuleInit, OnApplicationShutdown
{
  constructor(private readonly entityManager: EntityManager) {}

  async onModuleInit(): Promise<void> {
    await this.entityManager.register({ /* 설정 */ });
  }

  async onApplicationShutdown(): Promise<void> {
    // 1. EntityManager 내부 상태 정리
    await this.entityManager.propagateShutdown();
    // 2. DB 커넥션 풀 종료는 DatabaseClient가 자동 처리
    console.log("ORM 연결 해제 완료");
  }
}
```

### SIGTERM/SIGINT 핸들링 (NestJS 없는 환경)

```typescript
// main.ts (순수 Node.js)
import "reflect-metadata";
import { EntityManager } from "@stingerloom/orm";

const em = new EntityManager();

async function main() {
  await em.register({ /* 설정 */ });
  console.log("서버 시작됨");

  // Graceful Shutdown 핸들러 등록
  const shutdown = async (signal: string) => {
    console.log(`${signal} 수신 — 종료 중...`);
    await em.propagateShutdown();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM")); // Kubernetes, Docker 종료 신호
  process.on("SIGINT", () => shutdown("SIGINT"));   // Ctrl+C
}

main().catch(console.error);
```

### NestJS enableShutdownHooks 설정

NestJS에서 OS 신호를 받아 `onApplicationShutdown`이 호출되려면 반드시 활성화해야 합니다.

```typescript
// main.ts (NestJS)
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // SIGTERM, SIGINT 등 OS 신호를 NestJS가 처리하도록 설정
  app.enableShutdownHooks();

  await app.listen(3000);
}

bootstrap();
```

> **주의:** `enableShutdownHooks()`를 호출하지 않으면 Kubernetes Pod가 종료될 때 `onApplicationShutdown`이 호출되지 않습니다.

---

## 6. 대규모 멀티테넌시(Multi-Tenancy) 운영

### 수백 테넌트 시 메모리 영향

레이어드 메타데이터 시스템은 AsyncLocalStorage 기반이므로, 테넌트 수가 많아도 메모리는 주로 메타데이터 레이어에서 소비됩니다.

| 요소 | 메모리 영향 | 비고 |
|------|-----------|------|
| 레이어드 메타데이터 | 테넌트당 수 KB | 엔티티 수에 비례 |
| 커넥션 풀 | **공유** (단일 풀) | 테넌트 수와 무관 |
| AsyncLocalStorage | 요청당 컨텍스트만 생성 | 요청 완료 시 자동 정리 |

테넌트 레이어는 `MetadataContext.run()`으로 생성되고, 콜백이 완료되면 자동으로 정리됩니다. 테넌트 1,000개라도 동시 접속 커넥션 풀은 하나를 공유합니다.

### 커넥션 풀 공유 전략

PostgreSQL 스키마 기반 멀티테넌시에서 모든 테넌트는 하나의 커넥션 풀을 공유합니다. `SET LOCAL search_path`로 트랜잭션 단위로 스키마를 전환하므로 추가 커넥션이 필요하지 않습니다.

```typescript
// PostgreSQL 멀티테넌시: 하나의 pool.max로 모든 테넌트 처리
await em.register({
  type: "postgres",
  // ...
  pool: {
    // 테넌트 수 × 예상 동시 요청 수 기반으로 산정
    // 예: 100 테넌트 × 동시 요청 0.2 = 20개 커넥션
    max: 20,
    min: 5,
    acquireTimeoutMs: 5000,
    idleTimeoutMs: 60000,
  },
});
```

### 테넌트 프로비저닝(Provisioning) 자동화

`PostgresTenantMigrationRunner`로 새 테넌트 스키마를 자동 생성합니다. 내부적으로 중복 프로비저닝 방지 잠금(Provisioning Lock)을 사용합니다.

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
      sourceSchema: "public", // public 스키마 테이블 구조를 복제
    });

    // 앱 시작 시 모든 기존 테넌트 스키마 동기화
    const result = await this.runner.syncTenantSchemas([
      "acme_corp",
      "globex",
      "umbrella",
    ]);

    console.log(`새로 생성: ${result.created.join(", ")}`);
    console.log(`이미 존재: ${result.skipped.join(", ")}`);
  }

  // 신규 테넌트 등록 API에서 호출
  async provisionTenant(tenantId: string): Promise<void> {
    await this.runner.ensureSchema(tenantId);
    // 동시에 같은 tenantId로 호출되어도 한 번만 프로비저닝됨 (잠금 보장)
  }

  // 특정 테넌트 프로비저닝 여부 확인
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
      // 테넌트 헤더 없는 요청은 public 컨텍스트
      return next();
    }

    // 테넌트 컨텍스트로 요청 전체를 래핑
    // AsyncLocalStorage 덕분에 요청 내 모든 비동기 호출에서 동일한 컨텍스트 유지
    MetadataContext.run(tenantId, () => {
      next();
    });
  }
}
```

### 대규모 테넌트 초기화 시 주의사항

테넌트가 수백 개일 때 앱 시작 시 모두 프로비저닝하면 시작이 느려질 수 있습니다.

```typescript
// 권장: 배치로 나눠서 프로비저닝
async function provisionAllTenants(
  runner: PostgresTenantMigrationRunner,
  tenantIds: string[],
  batchSize = 20,
) {
  for (let i = 0; i < tenantIds.length; i += batchSize) {
    const batch = tenantIds.slice(i, i + batchSize);
    await runner.syncTenantSchemas(batch);
    console.log(`프로비저닝 완료: ${i + batch.length}/${tenantIds.length}`);
  }
}
```

> **참고:** `ensureSchema()`는 동일 tenantId로 동시 호출 시 내부 잠금으로 중복 프로비저닝을 방지합니다. 신규 테넌트 등록 API에서 안전하게 사용할 수 있습니다.

---

## 전체 프로덕션 설정 예시

아래는 NestJS 프로덕션 환경에 권장되는 전체 설정 예시입니다.

```typescript
// app.module.ts
import { Module } from "@nestjs/common";
import { StinglerloomOrmModule } from "./stingerloom-orm/stingerloom-orm.module";
import { User, Post, Comment } from "./entities";

@Module({
  imports: [
    StinglerloomOrmModule.forRoot({
      type: "postgres",
      host: process.env.DB_HOST!,
      port: parseInt(process.env.DB_PORT ?? "5432"),
      username: process.env.DB_USER!,
      password: process.env.DB_PASSWORD!,
      database: process.env.DB_NAME!,
      entities: [User, Post, Comment],
      synchronize: false, // 프로덕션에서 반드시 false
      queryTimeout: 30000, // 30초 전역 타임아웃
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

  // Graceful Shutdown 활성화 (필수)
  app.enableShutdownHooks();

  await app.listen(process.env.PORT ?? 3000);
}

bootstrap();
```

---

## 다음 단계

- [마이그레이션](./migrations.md) — 마이그레이션 파일 작성 및 실행
- [멀티테넌시](./multi-tenancy.md) — 레이어드 메타데이터 시스템 상세
- [설정 가이드](./configuration.md) — 전체 설정 옵션 레퍼런스
- [고급 기능](./advanced.md) — N+1 감지, EntitySubscriber, EXPLAIN 쿼리
