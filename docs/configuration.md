# 설정 가이드 (Configuration)

`EntityManager.register()`에 전달하는 `DatabaseClientOptions` 객체를 통해 DB 연결, 풀링, 재시도, 타임아웃, Read Replica, 멀티 DB 등을 설정합니다.

---

## DatabaseClientOptions 전체 옵션

```typescript
interface DatabaseClientOptions {
  type: "mysql" | "mariadb" | "postgres" | "sqlite" | "mssql";
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  entities: AnyEntity[];
  synchronize?: boolean;
  schema?: string;            // PostgreSQL 전용 (기본값: "public")
  charset?: string;           // MySQL 전용
  datesStrings?: boolean;     // MySQL 전용
  queryTimeout?: number;      // 전역 쿼리 타임아웃 (ms)
  pool?: PoolOptions;         // 연결 풀 설정
  retry?: RetryOptions;       // 연결 재시도 설정
  logging?: boolean | LoggingOptions; // 쿼리 로깅 설정
  replication?: ReplicationConfig;    // Read Replica 설정
}
```

---

## 기본 연결

### MySQL / MariaDB

```typescript
import { EntityManager } from "stingerloom-orm";
import { User } from "./user.entity";

const em = new EntityManager();
await em.register({
  type: "mysql",        // 또는 "mariadb"
  host: "localhost",
  port: 3306,
  username: "root",
  password: "password",
  database: "mydb",
  entities: [User],
  synchronize: true,
  charset: "utf8mb4",
});
```

### PostgreSQL

```typescript
await em.register({
  type: "postgres",
  host: "localhost",
  port: 5432,
  username: "postgres",
  password: "password",
  database: "mydb",
  schema: "public",    // 기본값: "public"
  entities: [User],
  synchronize: true,
});
```

### SQLite

```typescript
await em.register({
  type: "sqlite",
  host: "",
  port: 0,
  username: "",
  password: "",
  database: "./mydb.sqlite",  // 파일 경로
  entities: [User],
  synchronize: true,
});
```

### MSSQL

```typescript
await em.register({
  type: "mssql",
  host: "localhost",
  port: 1433,
  username: "sa",
  password: "password",
  database: "mydb",
  entities: [User],
  synchronize: true,
});
```

---

## 연결 풀링 (PoolOptions)

```typescript
interface PoolOptions {
  max?: number;              // 최대 연결 수 (기본값: 10)
  min?: number;              // 최소 유휴 연결 수 (기본값: 0, PostgreSQL만)
  acquireTimeoutMs?: number; // 연결 획득 대기 시간 (기본값: 30000ms)
  idleTimeoutMs?: number;    // 유휴 연결 종료 시간 (기본값: 10000ms, PostgreSQL만)
}
```

```typescript
await em.register({
  type: "postgres",
  // ...
  pool: {
    max: 20,
    min: 5,
    acquireTimeoutMs: 5000,
    idleTimeoutMs: 30000,
  },
});
```

**DB별 지원 현황**

| 옵션 | MySQL | PostgreSQL | SQLite | MSSQL |
|------|-------|-----------|--------|-------|
| `max` | connectionLimit | max | 무시 | max |
| `min` | 미지원 | min | 무시 | min |
| `acquireTimeoutMs` | 미지원 | connectionTimeoutMillis | 무시 | connectionTimeout |
| `idleTimeoutMs` | 미지원 | idleTimeoutMillis | 무시 | 미지원 |

SQLite는 파일 기반 단일 연결이므로 풀 설정이 무시됩니다.

---

## 연결 재시도 (RetryOptions)

지수 백오프 방식으로 DB 연결 실패 시 자동 재시도합니다.

```typescript
interface RetryOptions {
  maxAttempts: number;  // 최대 재시도 횟수 (기본값: 3)
  backoffMs: number;    // 기본 지연 시간 (기본값: 1000ms)
}
```

실제 지연 시간: `backoffMs * 2^(시도횟수-1)`

| 시도 | backoffMs=1000 | backoffMs=500 |
|------|---------------|---------------|
| 1차 | 1000ms | 500ms |
| 2차 | 2000ms | 1000ms |
| 3차 | 4000ms | 2000ms |
| 4차 | 8000ms | 4000ms |
| 5차 | 16000ms | 8000ms |

```typescript
await em.register({
  type: "mysql",
  // ...
  retry: {
    maxAttempts: 5,
    backoffMs: 500,
  },
});
```

---

## 쿼리 로깅 (LoggingOptions)

```typescript
interface LoggingOptions {
  queries?: boolean;     // 쿼리 SQL 로깅 활성화
  slowQueryMs?: number;  // 이 값(ms) 초과 시 슬로우 쿼리 경고
  nPlusOne?: boolean;    // N+1 패턴 감지 경고
}
```

```typescript
await em.register({
  type: "mysql",
  // ...
  logging: {
    queries: true,
    slowQueryMs: 500,
    nPlusOne: true,
  },
});

// 쿼리 로그 조회
const log = em.getQueryLog();
```

단순히 `logging: true`로 설정하면 기본 쿼리 로깅만 활성화됩니다.

---

## 쿼리 타임아웃

### 연결 레벨 (전체 쿼리에 적용)

```typescript
await em.register({
  type: "mysql",
  // ...
  queryTimeout: 5000,  // 모든 쿼리에 5초 타임아웃
});
```

### 쿼리 단위 (연결 레벨보다 우선)

```typescript
const users = await em.find(User, {
  where: { isActive: true },
  timeout: 2000,  // 이 쿼리에만 2초 타임아웃
});
```

**DB별 내부 구현**

| DB | 구현 방식 |
|----|----------|
| MySQL | `SET max_execution_time = N` |
| PostgreSQL | `SET LOCAL statement_timeout = N` |
| SQLite | 드라이버 레벨 타임아웃 |
| MSSQL | `SET QUERY_GOVERNOR_COST_LIMIT N` |

타임아웃 초과 시 `QueryTimeoutError`가 throw됩니다.

---

## Read Replica (읽기/쓰기 분리)

`replication` 옵션으로 master/slave 구조의 읽기/쓰기 분리를 설정합니다.

- **쓰기** (`save`, `delete`, `upsert` 등): 항상 master
- **읽기** (`find`, `findOne`, `count` 등): slave 라운드 로빈
- **장애 시**: slave 전체 장애 시 master로 자동 fallback

```typescript
interface ReplicationConfig {
  master: ReplicationNodeConfig;
  slaves: ReplicationNodeConfig[];
}

interface ReplicationNodeConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
}
```

```typescript
await em.register({
  type: "mysql",
  host: "master.example.com",
  port: 3306,
  username: "root",
  password: "password",
  database: "mydb",
  entities: [User, Post],
  synchronize: true,
  replication: {
    master: {
      host: "master.example.com",
      port: 3306,
      username: "root",
      password: "password",
      database: "mydb",
    },
    slaves: [
      {
        host: "replica1.example.com",
        port: 3306,
        username: "readonly",
        password: "password",
        database: "mydb",
      },
      {
        host: "replica2.example.com",
        port: 3306,
        username: "readonly",
        password: "password",
        database: "mydb",
      },
    ],
  },
});
```

### useMaster 옵션

쓰기 직후 최신 데이터를 읽어야 하는 경우 `useMaster` 옵션으로 master에서 직접 읽을 수 있습니다.

```typescript
// 업데이트 직후 최신 데이터 조회
await em.save(User, { id: 1, name: "updated" });
const user = await em.findOne(User, {
  where: { id: 1 },
  useMaster: true,  // replica lag 무시, master에서 직접 읽기
});
```

---

## 멀티 DB 연결 (Named Connections)

복수의 데이터베이스를 독립적으로 운용할 수 있습니다. `register()`의 두 번째 인자로 연결 이름을 지정합니다.

```typescript
import { EntityManager } from "stingerloom-orm";
import { User } from "./user.entity";
import { Log } from "./log.entity";

// Primary DB (MySQL)
const primaryEm = new EntityManager();
await primaryEm.register(
  {
    type: "mysql",
    host: "localhost",
    port: 3306,
    username: "root",
    password: "password",
    database: "primary_db",
    entities: [User],
    synchronize: true,
  },
  "primary",
);

// Analytics DB (PostgreSQL)
const analyticsEm = new EntityManager();
await analyticsEm.register(
  {
    type: "postgres",
    host: "analytics.example.com",
    port: 5432,
    username: "analytics",
    password: "password",
    database: "analytics_db",
    entities: [Log],
    synchronize: true,
  },
  "analytics",
);

// 각 EntityManager는 독립적으로 동작
const users = await primaryEm.find(User);
const logs = await analyticsEm.find(Log);

console.log(primaryEm.getConnectionName());   // "primary"
console.log(analyticsEm.getConnectionName()); // "analytics"
```

각 `EntityManager` 인스턴스는 완전히 독립적인 드라이버, 데이터소스, 이벤트 시스템을 가집니다.

---

## synchronize 옵션

`synchronize: true`로 설정하면 `register()` 시 엔티티 메타데이터를 기반으로 테이블이 없을 경우 자동 생성합니다.

```typescript
await em.register({
  type: "postgres",
  // ...
  entities: [User, Post],
  synchronize: true,  // User, Post 테이블이 없으면 자동 CREATE TABLE
});
```

> **주의:** 프로덕션 환경에서는 `synchronize: false`로 설정하고 [마이그레이션 시스템](./migrations.md)을 사용하는 것을 권장합니다. `synchronize: true`는 개발/테스트 환경에서만 사용하세요.
