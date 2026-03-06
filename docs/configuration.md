# 설정 가이드 (Configuration)

`EntityManager.register()`에 전달하는 옵션으로 DB 연결, 풀링, 타임아웃, Read Replica 등을 설정합니다. 이 문서에서는 가장 흔한 설정부터 시작하여 운영 환경에 필요한 설정까지 안내합니다.

## 기본 연결

### PostgreSQL

```typescript
import { EntityManager } from "stingerloom-orm";
import { User } from "./user.entity";

const em = new EntityManager();
await em.register({
  type: "postgres",
  host: "localhost",
  port: 5432,
  username: "postgres",
  password: "password",
  database: "mydb",
  entities: [User],
  synchronize: true,
});
```

### MySQL / MariaDB

```typescript
await em.register({
  type: "mysql",        // MariaDB는 "mariadb"
  host: "localhost",
  port: 3306,
  username: "root",
  password: "password",
  database: "mydb",
  entities: [User],
  synchronize: true,
  charset: "utf8mb4",   // 이모지를 저장하려면 utf8mb4 필요
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

## synchronize 옵션

`synchronize: true`로 설정하면 엔티티 정의를 기반으로 테이블이 자동 생성됩니다.

> **Warning** `synchronize: true`는 개발 환경에서만 사용하세요. 프로덕션에서는 데이터 손실 위험이 있으므로 [마이그레이션](./migrations.md)을 사용해야 합니다.

## 연결 풀링

동시 요청이 많을 때 DB 연결을 효율적으로 재사용합니다.

```typescript
await em.register({
  type: "postgres",
  // ...
  pool: {
    max: 20,                // 최대 연결 수 (기본값: 10)
    min: 5,                 // 최소 유휴 연결 수 (기본값: 0)
    acquireTimeoutMs: 5000, // 연결 획득 대기 시간 (기본값: 30000ms)
    idleTimeoutMs: 30000,   // 유휴 연결 종료 시간 (기본값: 10000ms)
  },
});
```

DB에 따라 지원하는 옵션이 다릅니다.

| 옵션 | MySQL | PostgreSQL | SQLite |
|------|-------|-----------|--------|
| `max` | O | O | 무시 |
| `min` | - | O | 무시 |
| `acquireTimeoutMs` | - | O | 무시 |
| `idleTimeoutMs` | - | O | 무시 |

> **Hint** SQLite는 파일 기반 단일 연결이므로 풀 설정이 무시됩니다.

## 연결 재시도

DB가 아직 시작되지 않았거나 일시적으로 연결이 끊겼을 때 자동으로 재시도합니다. 지수 백오프 방식으로 대기 시간이 점점 늘어납니다.

```typescript
await em.register({
  type: "mysql",
  // ...
  retry: {
    maxAttempts: 5,   // 최대 재시도 횟수 (기본값: 3)
    backoffMs: 500,   // 기본 지연 시간 (기본값: 1000ms)
  },
});
```

위 설정에서 실제 대기 시간은 이렇게 됩니다.

| 시도 | 대기 시간 |
|------|----------|
| 1차 | 500ms |
| 2차 | 1000ms |
| 3차 | 2000ms |
| 4차 | 4000ms |
| 5차 | 8000ms |

## 쿼리 로깅

### 기본 로깅

```typescript
await em.register({
  // ...
  logging: true, // 실행되는 SQL을 콘솔에 출력
});
```

### 상세 로깅

```typescript
await em.register({
  // ...
  logging: {
    queries: true,       // SQL 출력
    slowQueryMs: 500,    // 500ms 초과 쿼리에 경고
    nPlusOne: true,      // N+1 패턴 감지
  },
});
```

로그를 코드에서 조회할 수도 있습니다.

```typescript
const log = em.getQueryLog();
```

## 쿼리 타임아웃

### 전역 설정

```typescript
await em.register({
  // ...
  queryTimeout: 5000, // 모든 쿼리에 5초 타임아웃
});
```

### 쿼리별 설정

전역 설정보다 우선 적용됩니다.

```typescript
const users = await em.find(User, {
  where: { isActive: true },
  timeout: 2000, // 이 쿼리에만 2초 타임아웃
});
```

타임아웃이 초과되면 `QueryTimeoutError`가 발생합니다.

| DB | 내부 구현 |
|----|----------|
| MySQL | `SET max_execution_time = N` |
| PostgreSQL | `SET LOCAL statement_timeout = N` |
| SQLite | 드라이버 레벨 타임아웃 |

## Read Replica (읽기/쓰기 분리)

쓰기는 master로, 읽기는 slave로 자동 라우팅합니다.

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

slave가 여러 개이면 라운드 로빈 방식으로 분산됩니다. slave 전체가 장애이면 master로 자동 fallback합니다.

쓰기 직후 최신 데이터가 필요하면 `useMaster` 옵션을 사용합니다.

```typescript
await em.save(User, { id: 1, name: "수정됨" });

const user = await em.findOne(User, {
  where: { id: 1 },
  useMaster: true, // replica lag 무시
});
```

## 멀티 DB 연결

서로 다른 DB를 독립적으로 운용할 수 있습니다. `register()`의 두 번째 인자로 연결 이름을 지정합니다.

```typescript
// Primary DB (MySQL)
const primaryEm = new EntityManager();
await primaryEm.register({
  type: "mysql",
  // ...
  entities: [User],
  synchronize: true,
}, "primary");

// Analytics DB (PostgreSQL)
const analyticsEm = new EntityManager();
await analyticsEm.register({
  type: "postgres",
  // ...
  entities: [Log],
  synchronize: true,
}, "analytics");

// 각각 독립적으로 사용
const users = await primaryEm.find(User);
const logs = await analyticsEm.find(Log);

console.log(primaryEm.getConnectionName());   // "primary"
console.log(analyticsEm.getConnectionName()); // "analytics"
```

## 전체 옵션 레퍼런스

```typescript
interface DatabaseClientOptions {
  type: "mysql" | "mariadb" | "postgres" | "sqlite";
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  entities: AnyEntity[];
  synchronize?: boolean;         // 테이블 자동 생성 (기본값: false)
  schema?: string;               // PostgreSQL 스키마 (기본값: "public")
  charset?: string;              // MySQL 문자셋
  datesStrings?: boolean;        // MySQL 날짜를 문자열로 반환
  queryTimeout?: number;         // 전역 쿼리 타임아웃 (ms)
  pool?: PoolOptions;            // 연결 풀 설정
  retry?: RetryOptions;          // 연결 재시도 설정
  logging?: boolean | LoggingOptions;  // 쿼리 로깅
  replication?: ReplicationConfig;     // Read Replica 설정
}
```

## 다음 단계

- [고급 기능](./advanced.md) — N+1 감지, 이벤트 시스템, 성능 최적화
- [멀티테넌시](./multi-tenancy.md) — 테넌트별 데이터 격리
- [API 레퍼런스](./api-reference.md) — 전체 메서드 시그니처
