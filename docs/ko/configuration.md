# 설정 가이드

이 가이드에서는 Stingerloom이 제공하는 모든 설정 옵션을 "일단 동작하게"부터 시작해서 프로덕션 수준의 구성까지 단계별로 설명합니다. 각 섹션에서는 사용 방법을 보여주기 전에 해당 옵션이 **왜** 존재하는지 설명합니다.

## 기본 연결

흥미로운 일이 일어나기 전에, Stingerloom은 데이터베이스와 통신해야 합니다. 데이터베이스의 위치, 인증 방법, 관리할 엔티티를 알려줍니다.

### PostgreSQL

```typescript
import { EntityManager } from "@stingerloom/orm";
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
  type: "mysql",        // MariaDB는 "mariadb" 사용
  host: "localhost",
  port: 3306,
  username: "root",
  password: "password",
  database: "mydb",
  entities: [User],
  synchronize: true,
  charset: "utf8mb4",   // 이모지 같은 4바이트 문자를 저장하려면 utf8mb4 필수
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

SQLite는 단일 파일에 모든 것을 저장합니다. 연결할 서버가 없으므로 host/port/username/password가 비어 있습니다. 이 점이 테스트, 프로토타이핑, 임베디드 애플리케이션에 완벽한 이유입니다.

---

## synchronize 옵션

### 이 옵션이 존재하는 이유

엔티티에 새 `@Column()`을 추가하거나 완전히 새로운 엔티티 클래스를 생성하면, 데이터베이스는 마법처럼 이를 알지 못합니다. 누군가 또는 무언가가 `ALTER TABLE`이나 `CREATE TABLE` 문을 실행해야 합니다. `synchronize` 옵션은 엔티티를 변경할 때마다 DDL을 직접 작성하지 않아도 되도록 개발 중에 이 프로세스를 자동화합니다.

### 네 가지 모드

| 값 | 동작 | 사용 시점 |
|-----|------|---------|
| `false` | **동기화 안 함** (기본값) -- 스키마를 수정하지 않음 | 프로덕션. 마이그레이션으로 스키마를 제어합니다. |
| `true` | **전체 동기화** -- 엔티티에 맞게 테이블/컬럼을 생성, 변경, 삭제 | 개발 전용. 엔티티에서 컬럼을 제거하면 데이터베이스 컬럼과 모든 데이터가 삭제됩니다. |
| `"safe"` | **안전 동기화** -- 새 테이블 생성과 새 컬럼 추가만 하고 삭제하지 않음 | 스테이징. 새로운 것은 나타나고, 기존 것은 그대로 유지됩니다. 데이터 손실 없음. |
| `"dry-run"` | **드라이 런** -- 실행될 DDL을 로그로 출력하되 실행하지 않음 | 배포 전 검토. 스키마를 변경할 정확한 SQL을 확인할 수 있습니다. |

```typescript
await em.register({
  // ...
  synchronize: "safe",
});
```

### 실제 위험 시나리오

**프로덕션에서 전체 동기화(`true`) -- 악몽 시나리오:**
월요일에 엔티티에 `nickname` 컬럼이 있습니다. 화요일에 `displayName`으로 이름을 변경하기로 합니다. 전체 동기화는 `nickname`이 엔티티에 더 이상 없음을 감지하고 `ALTER TABLE user DROP COLUMN nickname`을 실행합니다. 모든 사용자 닉네임이 사라집니다. 그런 다음 `displayName`을 새 빈 컬럼으로 생성합니다. 이름 변경이 아니라 삭제 후 생성입니다.

**안전 동기화(`"safe"`) -- 안전망:**
같은 시나리오지만 안전 동기화를 사용합니다. ORM이 새 `displayName` 컬럼을 생성하지만 `nickname`은 그대로 둡니다. 데이터 손실이 없습니다. 수동으로 데이터를 마이그레이션하고 준비가 되면 이전 컬럼을 삭제할 수 있습니다.

**드라이 런(`"dry-run"`) -- 미리보기:**
같은 시나리오입니다. ORM이 DDL을 콘솔에 출력합니다 -- `ALTER TABLE user ADD COLUMN display_name varchar(255)` -- 하지만 실행하지 않습니다. 출력을 검토하고, 마이그레이션 파일을 조정하고, 직접 적용합니다.

> **경고:** `synchronize: true`는 개발 환경에서만 사용하세요. 프로덕션에서는 [마이그레이션](./migrations.md)을 사용하세요.

---

## 커넥션 풀링

### 커넥션 풀링이 중요한 이유

새 데이터베이스 연결을 여는 것은 비용이 큽니다. 각 연결은 TCP 핸드셰이크, 인증, SSL 협상을 포함합니다. 대부분의 시스템에서 이는 30-80밀리초가 걸립니다. 작아 보일 수 있지만, 초당 200개의 요청을 처리하는 API 서버를 생각해 보세요. 모든 요청이 자체 연결을 열고 닫으면, 연결 오버헤드에만 초당 6-16초를 소비합니다. 이는 물리적으로 불가능합니다.

공항의 택시 승강장이라고 생각하면 됩니다. 승객이 도착할 때마다 새 택시를 부르는(어딘가에 주차된 곳에서 오기를 기다리는) 대신, 차량 대기열을 승강장에 대기시킵니다. 승객이 도착하면 사용 가능한 택시를 탑니다. 완료되면 택시가 다음 승객을 위해 승강장으로 돌아옵니다. 이것이 커넥션 풀입니다.

### 설정

```typescript
await em.register({
  type: "postgres",
  // ...
  pool: {
    max: 20,                // 풀의 최대 연결 수 (기본값: 10)
    min: 5,                 // 유지되는 최소 유휴 연결 수 (기본값: 0)
    acquireTimeoutMs: 5000, // 빈 연결을 기다리는 시간 (기본값: 30000ms)
    idleTimeoutMs: 30000,   // 유휴 연결이 살아있는 시간 (기본값: 10000ms)
  },
});
```

**각 설정의 의미:**

- **`max: 20`** -- 최대 20개의 동시 연결. 20개가 모두 사용 중이고 21번째 요청이 오면, 대기합니다 (`acquireTimeoutMs`까지). 너무 높으면 데이터베이스 메모리를 낭비하고, 너무 낮으면 대기열이 발생합니다.
- **`min: 5`** -- 아무도 사용하지 않아도 항상 5개의 연결을 열어 둡니다. 조용한 기간 후 트래픽이 증가할 때 콜드 스타트 패널티를 방지합니다.
- **`acquireTimeoutMs: 5000`** -- 5초 이내에 연결을 사용할 수 없으면 에러를 발생시킵니다. 풀이 포화될 때 요청이 무한정 대기하는 것을 방지합니다.
- **`idleTimeoutMs: 30000`** -- 연결이 30초 동안 유휴 상태이고 풀에 `min`보다 많은 연결이 있으면 닫습니다. 트래픽이 적을 때 리소스를 해제합니다.

### 데이터베이스 지원

| 옵션 | MySQL | PostgreSQL | SQLite |
|------|-------|-----------|--------|
| `max` | 예 | 예 | 무시됨 |
| `min` | -- | 예 | 무시됨 |
| `acquireTimeoutMs` | -- | 예 | 무시됨 |
| `idleTimeoutMs` | -- | 예 | 무시됨 |

> **참고:** SQLite는 단일 연결의 파일 기반이므로 풀 설정이 무시됩니다. 읽기와 쓰기가 디스크의 파일로 직접 전달되므로 TCP 오버헤드가 없습니다.

---

## 연결 재시도

### 연결 재시도가 중요한 이유

현대적인 배포에서 애플리케이션과 데이터베이스는 종종 동시에 시작됩니다. Docker Compose, Kubernetes 또는 다른 컨테이너 오케스트레이션 시스템에서 애플리케이션이 연결을 시도하는 시점에 데이터베이스가 연결을 수락하고 있을 것이라는 보장이 없습니다. 재시도 로직 없이는 애플리케이션이 "ECONNREFUSED"로 시작 시 크래시되고 수동으로 재시작해야 합니다.

연결 재시도는 매번 조금 더 긴 시간을 기다리면서 다시 시도하여 이를 해결합니다.

### 설정

```typescript
await em.register({
  type: "mysql",
  // ...
  retry: {
    maxAttempts: 5,   // 최대 5번 시도 (기본값: 3)
    backoffMs: 500,   // 500ms부터 대기 시작 (기본값: 1000ms)
  },
});
```

### 지수 백오프 공식

재시도 간 대기 시간은 일정하지 않습니다. 매번 두 배로 증가합니다:

```
delay = backoffMs * 2^(attempt - 1)
```

`backoffMs: 500`일 때 실제 타임라인은 다음과 같습니다:

| 시도 | 공식 | 다음 시도까지 대기 |
|------|------|----------------|
| 1차 | 500 * 2^0 | 500ms |
| 2차 | 500 * 2^1 | 1,000ms |
| 3차 | 500 * 2^2 | 2,000ms |
| 4차 | 500 * 2^3 | 4,000ms |
| 5차 | (마지막 시도) | -- |

포기 전 최대 총 대기 시간은 500 + 1000 + 2000 + 4000 = **7.5초**입니다. 일반적으로 데이터베이스 컨테이너 초기화가 완료되기에 충분합니다.

고정 지연 대신 지수 백오프를 사용하는 이유는? 데이터베이스가 짧은 네트워크 장애로 다운되었다면 첫 번째 재시도(500ms)가 빠르게 잡습니다. 더 느린 시작(PostgreSQL이 크래시에서 복구하는 경우 등)이라면, 이후 시도가 서버에 연결 요청을 쏟아붓지 않으면서 충분한 여유를 줍니다.

---

## 쿼리 로깅

### 쿼리 로깅이 중요한 이유

ORM은 여러분을 위해 SQL을 생성합니다 -- 그것이 핵심입니다. 하지만 무언가 잘못되었을 때 -- 쿼리가 예상치 못한 결과를 반환하거나 페이지 로딩이 느릴 때 -- 데이터베이스로 전송되는 실제 SQL을 봐야 합니다. 쿼리 로깅은 보이지 않는 것을 보이게 합니다.

### 기본 로깅

```typescript
await em.register({
  // ...
  logging: true,
});
```

### 출력 모습

`logging: true`가 활성화되면, 모든 SQL 문이 파라미터와 함께 콘솔에 표시됩니다:

```
[Query] SELECT "id", "name", "email", "age" FROM "user" WHERE "is_active" = $1 [true]  (12ms)
[Query] INSERT INTO "user" ("name", "email", "age") VALUES ($1, $2, $3) RETURNING "id" ["Alice", "alice@example.com", 28]  (8ms)
[Query] UPDATE "user" SET "name" = $1 WHERE "id" = $2 ["Bob", 42]  (5ms)
```

각 줄은 다음을 보여줍니다: SQL 문, 대괄호 안의 바운드 파라미터 값, 밀리초 단위의 실행 시간. 파라미터는 SQL과 별도로 표시됩니다 (`$1`, `$2` 플레이스홀더 사용). 이는 실제로 데이터베이스에 전송되는 방식과 동일합니다 -- SQL 인젝션으로부터 안전한 파라미터화된 쿼리로 전송됩니다.

### 상세 로깅

더 세밀한 제어를 위해 객체를 전달합니다:

```typescript
await em.register({
  // ...
  logging: {
    queries: true,       // 모든 SQL 문 출력 (logging: true와 동일)
    slowQueryMs: 500,    // 500ms 초과 쿼리에 경고
    nPlusOne: true,      // N+1 쿼리 패턴 감지 활성화
  },
});
```

N+1 감지와 슬로우 쿼리 경고에 대한 자세한 내용은 [로깅 & 진단](./logging.md) 가이드를 참고하세요.

### 프로그래밍 방식 접근

콘솔 출력뿐만 아니라 데이터로도 쿼리 로그를 가져올 수 있습니다:

```typescript
const log = em.getQueryLog();
// [
//   { entityName: "User", sql: "SELECT ...", durationMs: 12, timestamp: 1711234567890 },
//   { entityName: "Cat",  sql: "SELECT ...", durationMs: 8,  timestamp: 1711234567920 },
// ]
```

커스텀 대시보드 구축, 성능 테스트 작성, 또는 테스트 스위트에서 특정 작업이 특정 수의 쿼리를 사용하는지 확인하는 데 유용합니다.

---

## 쿼리 타임아웃

### 쿼리 타임아웃이 중요한 이유

누군가 WHERE 절을 빠뜨려서 5천만 행 테이블 전체를 스캔하는 쿼리를 상상해 보세요. 타임아웃 없이는 그 쿼리가 몇 분 동안 실행되며, 그 동안 풀의 연결을 하나 점유합니다. 다른 요청들은 연결을 기다리며 대기합니다. API가 응답하지 않게 됩니다. 하나의 나쁜 쿼리가 전체 애플리케이션을 다운시킨 것입니다.

쿼리 타임아웃은 서킷 브레이커입니다. 쿼리가 지정된 시간 내에 완료되지 않으면 데이터베이스가 이를 종료하고 Stingerloom이 `QueryTimeoutError`를 발생시킵니다. 연결이 해제되고 애플리케이션은 건강하게 유지됩니다.

### 전역 설정

```typescript
await em.register({
  // ...
  queryTimeout: 5000, // 모든 쿼리에 5초 타임아웃
});
```

### 쿼리별 오버라이드

때때로 특정 쿼리가 합법적으로 더 오래 걸릴 수 있습니다 (예: 배치 임포트, 복잡한 리포트). 개별 쿼리에 대해 전역 타임아웃을 오버라이드할 수 있습니다:

```typescript
const users = await em.find(User, {
  where: { isActive: true },
  timeout: 2000, // 이 특정 쿼리에 2초 타임아웃
});
```

### 데이터베이스 수준에서 일어나는 일

Stingerloom은 JavaScript `setTimeout`으로 쿼리를 종료하지 않습니다 -- 이는 클라이언트 측에서만 대기를 취소하고 쿼리는 서버에서 계속 실행되어 데이터베이스 리소스를 낭비합니다. 대신 데이터베이스 자체의 타임아웃 메커니즘을 사용합니다:

| 데이터베이스 | 쿼리 전에 전송되는 SQL |
|------------|---------------------|
| MySQL | `SET max_execution_time = 5000` |
| PostgreSQL | `SET LOCAL statement_timeout = '5000ms'` |
| SQLite | 드라이버 수준 타임아웃 (SQL 기반 아님) |

MySQL의 경우, `max_execution_time`은 밀리초 단위의 문 단위 힌트입니다. PostgreSQL의 경우, `SET LOCAL`은 현재 트랜잭션으로 타임아웃 범위를 제한하여 다른 연결이나 후속 쿼리에 영향을 주지 않습니다.

타임아웃이 발동되면 데이터베이스가 쿼리를 중단하고 에러를 반환합니다. Stingerloom은 그 에러를 잡아서 원본 SQL과 타임아웃 값을 포함한 `QueryTimeoutError`를 발생시켜 쉽게 디버깅할 수 있게 합니다.

---

## Read Replica (읽기/쓰기 분리)

### Read Replica가 중요한 이유

대부분의 애플리케이션에서 읽기가 쓰기보다 훨씬 많습니다. 일반적인 웹 앱은 80-90%의 SELECT 쿼리와 10-20%의 INSERT/UPDATE/DELETE만 보냅니다. 이 모든 것을 처리하는 단일 데이터베이스 서버는 트래픽이 증가하면 병목이 됩니다.

해결책은 기본(마스터) 서버와 동기화를 유지하는 데이터베이스 복사본(레플리카 또는 슬레이브)을 만드는 것입니다. 애플리케이션은 모든 쓰기를 마스터로 보내고 읽기를 레플리카에 분산시킵니다. 코드를 변경하지 않고도 레플리카를 추가할 수 있으므로 읽기 용량을 수평적으로 확장할 수 있습니다.

도서관이라고 생각하면 됩니다. 저자가 편집할 수 있는 원본 원고(마스터)가 하나 있습니다. 독자를 위해서는 복사본(레플리카)을 만들어 건물 곳곳의 열람실에 배치합니다. 독자가 더 많아지면? 열람실을 더 엽니다. 원본 원고는 쓰기 용도로만 접근합니다.

### 설정

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

### 라우팅 방식

Stingerloom이 자동으로 사용할 서버를 결정합니다:

- **쓰기** (`save`, `delete`, `update`, `insertMany`, `deleteMany`, `upsert`)는 항상 마스터로 전달됩니다.
- **읽기** (`find`, `findOne`, `findWithCursor`, `count`, `explain`)는 라운드 로빈 방식으로 슬레이브에 분산됩니다 (replica1, 그다음 replica2, 다시 replica1, ...).
- **페일오버:** 모든 슬레이브가 실패하면 읽기가 자동으로 마스터로 폴백됩니다. 읽기 확장 이점 없이도 애플리케이션은 계속 작동합니다.

### 복제 지연 이해

함정이 하나 있습니다. 마스터에 데이터를 쓰면 해당 변경이 레플리카로 전파되기까지 짧은 시간(보통 10-100밀리초, 부하가 높을 때는 더 긴 시간)이 걸립니다. 이 지연을 **복제 지연**이라고 합니다.

다음 시퀀스를 생각해 보세요:

```typescript
// 1단계: 마스터에 쓰기
await em.save(User, { id: 1, name: "업데이트된 이름" });

// 2단계: 레플리카에서 읽기 (10ms 후)
const user = await em.findOne(User, { where: { id: 1 } });
// user.name이 아직 "이전 이름"일 수 있음 -- 레플리카가 아직 따라잡지 못했을 수 있음!
```

쓰기 직후 최신 데이터를 읽어야 할 때는 `useMaster` 옵션을 사용하여 읽기를 마스터로 강제합니다:

```typescript
await em.save(User, { id: 1, name: "업데이트된 이름" });

const user = await em.findOne(User, {
  where: { id: 1 },
  useMaster: true, // 레플리카를 우회하고 마스터에서 직접 읽기
});
// user.name이 "업데이트된 이름"임을 보장
```

`useMaster`는 아껴서 사용하세요. 모든 읽기가 `useMaster`를 사용하면 레플리카의 이점을 없앤 것입니다.

---

## 멀티 DB 연결

때때로 애플리케이션이 하나 이상의 데이터베이스와 통신해야 합니다. 예를 들어, 메인 MySQL 데이터베이스에는 사용자와 게시물이 저장되고, 별도의 PostgreSQL 데이터베이스에는 분석 이벤트가 저장됩니다. Stingerloom은 named connection으로 이를 지원합니다.

```typescript
// 기본 DB (MySQL)
const primaryEm = new EntityManager();
await primaryEm.register({
  type: "mysql",
  // ...
  entities: [User],
  synchronize: true,
}, "primary");

// 분석 DB (PostgreSQL)
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

### NestJS에서 멀티 DB

NestJS 통합 모듈은 named connection을 기본 지원합니다. `forRoot()`와 `forFeature()`의 두 번째 인자로 connection name을 전달합니다:

```typescript
// app.module.ts
@Module({
  imports: [
    StinglerloomOrmModule.forRoot(mysqlOptions),                  // "default"
    StinglerloomOrmModule.forRoot(postgresOptions, "analytics"),  // named
    UsersModule,
    AnalyticsModule,
  ],
})
export class AppModule {}

// analytics.module.ts
@Module({
  imports: [StinglerloomOrmModule.forFeature([Event], "analytics")],
})
export class AnalyticsModule {}

// analytics.service.ts
@Injectable()
export class AnalyticsService {
  constructor(
    @InjectRepository(Event, "analytics")
    private readonly eventRepo: BaseRepository<Event>,
    @InjectEntityManager("analytics")
    private readonly em: EntityManager,
  ) {}
}
```

connection name을 생략하면 `"default"`가 사용됩니다. 멀티 DB를 사용하지 않는 기존 코드는 변경 없이 완전히 하위 호환됩니다.

토큰 헬퍼 함수도 고급 DI 시나리오에 사용할 수 있습니다:

- `getEntityManagerToken(connectionName?)` -- EntityManager DI 토큰 반환
- `getOrmServiceToken(connectionName?)` -- OrmService DI 토큰 반환
- `makeInjectRepositoryToken(entity, connectionName?)` -- Repository DI 토큰 반환

---

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
  synchronize?: boolean | "safe" | "dry-run";  // 스키마 동기화 모드 (기본값: false)
  schema?: string;               // PostgreSQL 스키마 (기본값: "public")
  charset?: string;              // MySQL 문자셋
  datesStrings?: boolean;        // MySQL 날짜를 문자열로 반환
  queryTimeout?: number;         // 전역 쿼리 타임아웃 (ms)
  pool?: PoolOptions;            // 커넥션 풀 설정
  retry?: RetryOptions;          // 연결 재시도 설정
  logging?: boolean | LoggingOptions;  // 쿼리 로깅
  replication?: ReplicationConfig;     // Read Replica 설정
  namingStrategy?: NamingStrategy;     // 커스텀 FK/인덱스 네이밍 전략
  tenantStrategy?: "search_path" | "schema_qualified"; // PG 테넌트 쿼리 전략 (기본값: "search_path")
  plugins?: StingerloomPlugin[];       // register() 시 자동 설치할 플러그인
}
```

## CJS/ESM 듀얼 빌드

Stingerloom은 CJS/ESM 듀얼 패키지로 배포됩니다. 별도 설정 없이 두 모듈 시스템 모두 자동으로 동작합니다:

```typescript
// ESM (최신, 권장)
import { EntityManager } from "@stingerloom/orm";

// CommonJS (레거시)
const { EntityManager } = require("@stingerloom/orm");
```

서브패스 export도 듀얼입니다:

| 서브패스 | 설명 |
|---------|------|
| `@stingerloom/orm` | 코어 ORM (EntityManager, 데코레이터 등) |
| `@stingerloom/orm/nestjs` | NestJS 통합 모듈 |
| `@stingerloom/orm/prisma-import` | Prisma 스키마 임포터 |

`package.json`의 `exports` 필드가 각 서브패스를 적절한 `import` (ESM) 또는 `require` (CJS) 진입점에 매핑합니다. 별도 설정이 필요 없습니다.

## 다음 단계

- [고급 기능](./advanced.md) -- 스트리밍, 이벤트 시스템, 쿼리 빌더, N+1 감지
- [멀티테넌시](./multi-tenancy.md) -- 테넌트별 데이터 격리
- [API 레퍼런스](./api-reference.md) -- 전체 메서드 시그니처
