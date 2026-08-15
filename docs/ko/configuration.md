# 설정 가이드

이 가이드에서는 Stingerloom의 모든 설정 옵션을 "일단 동작하게"부터 프로덕션 수준까지 단계별로 설명해요. 각 섹션에서는 사용법을 보여주기 전에 해당 옵션이 **왜** 존재하는지 먼저 알려드려요.

## 기본 연결

본격적인 작업 전에, Stingerloom은 데이터베이스와 통신해야 해요. 데이터베이스 위치, 인증 방법, 관리할 엔티티를 알려주면 돼요.

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

SQLite는 단일 파일에 모든 걸 저장해요. 연결할 서버가 없어서 host/port/username/password가 비어 있어요. 그래서 테스트, 프로토타이핑, 임베디드 애플리케이션에 딱 맞아요.

---

## synchronize 옵션

### 이 옵션이 존재하는 이유

엔티티에 새 `@Column()`을 추가하거나 새 엔티티 클래스를 만들면, 데이터베이스는 이걸 자동으로 알지 못해요. 누군가 `ALTER TABLE`이나 `CREATE TABLE`을 실행해줘야 해요. `synchronize` 옵션은 개발 중에 이 과정을 자동화해서, 엔티티를 바꿀 때마다 DDL을 직접 작성하지 않아도 되게 해줘요.

### 네 가지 모드

| 값 | 동작 | 사용 시점 |
|-----|------|---------|
| `false` | **동기화 안 함** (기본값) -- 스키마를 수정하지 않아요 | 프로덕션. 마이그레이션으로 스키마를 제어해요. |
| `true` | **전체 동기화** -- 엔티티에 맞게 테이블/컬럼을 생성, 변경, 삭제해요 | 개발 전용. 엔티티에서 컬럼을 제거하면 DB 컬럼과 데이터가 함께 삭제돼요. |
| `"safe"` | **안전 동기화** -- 새 테이블/컬럼만 추가하고 변경·삭제·이름 변경은 안 해요 | 스테이징. 새로운 건 나타나고, 기존 건 그대로예요. 데이터 손실 없어요. |
| `"dry-run"` | **드라이 런** -- 실행될 DDL을 로그로만 출력하고 실행은 안 해요 | 배포 전 검토. 어떤 SQL이 실행될지 미리 확인할 수 있어요. |

```typescript
await em.register({
  // ...
  synchronize: "safe",
});
```

### 실제 위험 시나리오

**프로덕션에서 전체 동기화(`true`) -- 악몽 시나리오:**
월요일에 엔티티에 `nickname` 컬럼이 있어요. 화요일에 `displayName`으로 이름을 바꾸기로 해요. 전체 동기화는 `nickname`이 엔티티에 없어진 걸 감지하고 `ALTER TABLE user DROP COLUMN nickname`을 실행해요. 모든 사용자 닉네임이 사라져요. 그다음 `displayName`을 새 빈 컬럼으로 만들어요. 이름 변경이 아니라 삭제 후 생성이에요.

**안전 동기화(`"safe"`) -- 안전망:**
같은 시나리오인데 안전 동기화를 써요. ORM이 새 `displayName` 컬럼을 만들지만 `nickname`은 그대로 둬요. 데이터 손실이 없어요. 나중에 수동으로 데이터를 옮기고, 준비되면 이전 컬럼을 삭제하면 돼요.

안전 모드는 적용하지 않고 넘긴 변경을 로그로 알려줍니다. 손대지 않은 스키마가 동기화된 스키마처럼 보이는 일은 없어요.

```
WARN [SchemaRegistrar] [sync] safe mode skipped 2 schema change(s): 1 ALTER COLUMN, 1 DROP COLUMN (user.email, user.nickname). Apply them with synchronize.mode: true or a migration; set synchronize.logDDL: true to log each skipped statement.
```

`logDDL: true`를 함께 주면 넘긴 DDL 문 자체도 전부 출력됩니다.

```
INFO [SchemaRegistrar] [skipped: safe mode] ALTER TABLE `user` MODIFY COLUMN `email` VARCHAR(64) NOT NULL
INFO [SchemaRegistrar] [skipped: safe mode] ALTER TABLE user DROP COLUMN nickname
```

특히 주의할 건 컬럼을 넓히는 변경이에요. 엔티티에서 `varchar(50)`을 `varchar(255)`로 바꿔도 안전 모드는 DB를 50 그대로 두기 때문에, 불일치가 나중에 INSERT 시점의 truncation 에러로 드러납니다. 이 경고가 "이제 마이그레이션을 돌려야 한다"는 신호예요.

**드라이 런(`"dry-run"`) -- 미리보기:**
같은 시나리오예요. ORM이 DDL을 콘솔에 출력해요 -- `ALTER TABLE user ADD COLUMN display_name varchar(255)` -- 하지만 실행은 안 해요. 출력을 검토하고, 마이그레이션 파일을 조정하고, 직접 적용하면 돼요.

> **경고:** `synchronize: true`는 개발 환경에서만 사용하세요. 프로덕션에서는 [마이그레이션](./migrations.md)을 사용하세요.

### 옵션 객체 폼

위의 네 가지 단일 값은 *복원력*, *파괴적 변경 안전성*, *DDL 가시성*이라는 세 가지 별개의 관심사를 하나의 enum에 묶어 둔 형태예요. 객체로 넘기면 각각을 따로 제어할 수 있어요.

```typescript
await em.register({
  // ...
  synchronize: {
    mode: "safe",                  // 기본 모드 (true | "safe" | "dry-run")
    continueOnError: false,         // 첫 DDL 실패에서 registerEntities() 중단
    failOnDestructiveChange: true,  // DROP COLUMN / 좁히는 ALTER 직전에 throw
    logDDL: true,                   // 발생하는 모든 DDL을 info 레벨로 로그 출력
  },
});
```

| 플래그 | 기본값 | 동작 |
|--------|--------|------|
| `mode` | 필수 | 기본 모드 — 단일 값 폼과 동일한 의미예요. |
| `continueOnError` | `true` | `false`이면 DDL 실패가 warn으로 격하되지 않고 `OrmError(SCHEMA_SYNC_FAILED)`로 throw 돼요. 반쯤 마이그레이션된 스키마를 로그로만 찾기보다는 부팅을 명시적으로 실패시키고 싶을 때 사용하세요. |
| `failOnDestructiveChange` | `false` | `true`이면 DROP COLUMN과 좁히는 ALTER(예: `varchar(255) → int`, `varchar(255) → varchar(64)`)가 실행 전에 `OrmError(SCHEMA_SYNC_DESTRUCTIVE_CHANGE)`로 throw 돼요. 프로덕션 안전망으로 유용해요. (synchronize는 어떤 모드에서도 테이블을 삭제하지 않으므로 막을 대상이 없어요.) |
| `logDDL` | `false` | `true`이면 발생하는 모든 DDL(CREATE TABLE, ALTER, RENAME, DROP, FULLTEXT INDEX 등)을 info 레벨로 로그 출력해요. `"safe"`에서는 모드가 건너뛴 문장도 `[skipped: safe mode]` 접두어를 붙여 함께 출력해요. `"dry-run"`과 함께 쓰면 가시성이 확보돼요. |

단일 값 폼(`true`, `"safe"`, `"dry-run"`, `false`)도 그대로 동작하며, 동일한 기본값으로 정규화되므로 마이그레이션이 필요 없어요.

---

## 커넥션 풀링

### 커넥션 풀링이 중요한 이유

새 데이터베이스 연결을 여는 건 비용이 커요. 각 연결마다 TCP 핸드셰이크, 인증, SSL 협상이 필요해요. 대부분의 시스템에서 30-80밀리초 정도 걸려요. 작아 보일 수 있지만, 초당 200개 요청을 처리하는 API 서버를 생각해 보세요. 모든 요청이 연결을 열고 닫으면, 연결 오버헤드에만 초당 6-16초를 쓰게 돼요. 물리적으로 불가능하죠.

공항 택시 승강장을 떠올려 보세요. 승객이 올 때마다 새 택시를 부르는 대신, 택시들을 승강장에 대기시켜 둬요. 승객이 오면 바로 탈 수 있고, 완료되면 택시가 다음 승객을 위해 돌아와요. 이게 커넥션 풀이에요.

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

**각 설정이 뭘 하는지:**

- **`max: 20`** -- 최대 20개의 동시 연결이에요. 20개가 모두 사용 중인데 21번째 요청이 오면 대기해요 (`acquireTimeoutMs`까지). 너무 높으면 DB 메모리를 낭비하고, 너무 낮으면 대기열이 생겨요.
- **`min: 5`** -- 아무도 안 써도 항상 5개의 연결을 열어 둬요. 조용한 기간 후 트래픽이 몰릴 때 콜드 스타트 패널티를 방지해요.
- **`acquireTimeoutMs: 5000`** -- 5초 안에 연결을 못 잡으면 에러를 던져요. 풀이 가득 찼을 때 요청이 무한정 대기하는 걸 막아줘요.
- **`idleTimeoutMs: 30000`** -- 연결이 30초간 안 쓰이고 풀에 `min`보다 많은 연결이 있으면 닫아요. 트래픽이 적을 때 리소스를 해제해요.

### 데이터베이스 지원

| 옵션 | MySQL | PostgreSQL | SQLite |
|------|-------|-----------|--------|
| `max` | 예 | 예 | 무시됨 |
| `min` | -- | 예 | 무시됨 |
| `acquireTimeoutMs` | -- | 예 | 무시됨 |
| `idleTimeoutMs` | -- | 예 | 무시됨 |

> **참고:** SQLite는 단일 연결 파일 기반이라 풀 설정이 무시돼요. 읽기/쓰기가 디스크 파일로 직접 가서 TCP 오버헤드가 없어요.

---

## 연결 재시도

### 연결 재시도가 중요한 이유

요즘 배포 환경에서는 앱과 DB가 동시에 뜨는 경우가 많아요. Docker Compose, Kubernetes 같은 컨테이너 오케스트레이션에서 앱이 연결을 시도할 때 DB가 준비됐다는 보장이 없어요. 재시도 로직 없으면 앱이 "ECONNREFUSED"로 시작 시 크래시되고, 수동으로 재시작해야 해요.

연결 재시도는 매번 조금 더 오래 기다리면서 다시 시도해서 이 문제를 해결해요.

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

재시도 간 대기 시간은 일정하지 않아요. 매번 두 배로 늘어나요:

```
delay = backoffMs * 2^(attempt - 1)
```

`backoffMs: 500`일 때 실제 타임라인은 이래요:

| 시도 | 공식 | 다음 시도까지 대기 |
|------|------|----------------|
| 1차 | 500 * 2^0 | 500ms |
| 2차 | 500 * 2^1 | 1,000ms |
| 3차 | 500 * 2^2 | 2,000ms |
| 4차 | 500 * 2^3 | 4,000ms |
| 5차 | (마지막 시도) | -- |

포기 전 최대 총 대기 시간은 500 + 1000 + 2000 + 4000 = **7.5초**예요. 보통 DB 컨테이너 초기화가 끝나기에 충분해요.

고정 지연 대신 지수 백오프를 쓰는 이유가 있어요. DB가 짧은 네트워크 장애로 내려갔다면 첫 번째 재시도(500ms)가 빠르게 잡아요. 더 느린 시작(PostgreSQL이 크래시에서 복구하는 경우 등)이라면, 이후 시도가 서버에 연결 요청을 쏟아붓지 않으면서 충분한 여유를 줘요.

---

## 쿼리 로깅

### 쿼리 로깅이 중요한 이유

ORM은 SQL을 대신 만들어줘요 -- 그게 핵심이에요. 하지만 뭔가 잘못됐을 때 -- 쿼리가 이상한 결과를 돌려주거나 페이지가 느릴 때 -- DB로 보내지는 실제 SQL을 봐야 해요. 쿼리 로깅은 안 보이던 걸 보이게 해줘요.

### 기본 로깅

```typescript
await em.register({
  // ...
  logging: true,
});
```

### 출력 모습

`logging: true`를 켜면, 모든 SQL 문이 파라미터와 함께 콘솔에 나와요:

```
[Query] SELECT "id", "name", "email", "age" FROM "user" WHERE "is_active" = $1 [true]  (12ms)
[Query] INSERT INTO "user" ("name", "email", "age") VALUES ($1, $2, $3) RETURNING "id" ["Alice", "alice@example.com", 28]  (8ms)
[Query] UPDATE "user" SET "name" = $1 WHERE "id" = $2 ["Bob", 42]  (5ms)
```

각 줄에는 SQL 문, 대괄호 안의 바인딩된 파라미터 값, 밀리초 단위 실행 시간이 나와요. 파라미터는 SQL과 분리돼서 표시돼요 (`$1`, `$2` 플레이스홀더 사용). 이건 실제로 DB에 전송되는 방식과 같아요 -- SQL 인젝션으로부터 안전한 파라미터화된 쿼리예요.

### 상세 로깅

더 세밀하게 제어하고 싶으면 객체를 전달하면 돼요:

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

콘솔 출력 말고 데이터로도 쿼리 로그를 가져올 수 있어요:

```typescript
const log = em.getQueryLog();
// [
//   { entityName: "User", sql: "SELECT ...", durationMs: 12, timestamp: 1711234567890 },
//   { entityName: "Cat",  sql: "SELECT ...", durationMs: 8,  timestamp: 1711234567920 },
// ]
```

커스텀 대시보드를 만들거나, 성능 테스트를 작성하거나, 특정 작업이 예상한 수만큼의 쿼리를 쓰는지 테스트에서 확인할 때 유용해요.

---

## 쿼리 타임아웃

### 쿼리 타임아웃이 중요한 이유

누군가 WHERE 절을 빠뜨려서 5천만 행 테이블 전체를 스캔하는 쿼리를 떠올려 보세요. 타임아웃 없으면 그 쿼리가 몇 분간 돌면서 풀의 연결 하나를 계속 점유해요. 다른 요청들은 연결을 기다리며 쌓여요. API가 멈춰요. 하나의 나쁜 쿼리가 앱 전체를 먹통으로 만든 거예요.

쿼리 타임아웃은 서킷 브레이커예요. 쿼리가 정해진 시간 안에 안 끝나면 DB가 쿼리를 종료하고, Stingerloom이 `QueryTimeoutError`를 던져요. 연결이 해제되고 앱은 건강하게 유지돼요.

### 전역 설정

```typescript
await em.register({
  // ...
  queryTimeout: 5000, // 모든 쿼리에 5초 타임아웃
});
```

### 쿼리별 오버라이드

특정 쿼리가 정당하게 오래 걸릴 수도 있어요 (배치 임포트, 복잡한 리포트 등). 개별 쿼리에서 전역 타임아웃을 오버라이드할 수 있어요:

```typescript
const users = await em.find(User, {
  where: { isActive: true },
  timeout: 2000, // 이 쿼리만 2초 타임아웃
});
```

### 데이터베이스 수준에서 일어나는 일

Stingerloom은 JavaScript `setTimeout`으로 쿼리를 끊지 않아요 -- 그러면 클라이언트 쪽에서만 대기를 취소하고 쿼리는 서버에서 계속 돌아서 DB 리소스를 낭비해요. 대신 DB 자체의 타임아웃 메커니즘을 사용해요:

| 데이터베이스 | 쿼리 전에 전송되는 SQL |
|------------|---------------------|
| MySQL | `SET max_execution_time = 5000` |
| PostgreSQL | `SET LOCAL statement_timeout = '5000ms'` |
| SQLite | 드라이버 수준 타임아웃 (SQL 기반 아님) |

MySQL의 `max_execution_time`은 밀리초 단위 문 힌트예요. PostgreSQL의 `SET LOCAL`은 현재 트랜잭션으로 타임아웃 범위를 제한해서 다른 연결이나 이후 쿼리에 영향을 주지 않아요.

타임아웃이 발동되면 DB가 쿼리를 중단하고 에러를 돌려줘요. Stingerloom은 그 에러를 잡아서 원본 SQL과 타임아웃 값을 포함한 `QueryTimeoutError`를 던지기 때문에 디버깅이 쉬워요.

---

## Read Replica (읽기/쓰기 분리)

### Read Replica가 중요한 이유

대부분의 앱에서 읽기가 쓰기보다 훨씬 많아요. 일반적인 웹 앱은 80-90%가 SELECT이고 INSERT/UPDATE/DELETE는 10-20%밖에 안 돼요. 이걸 한 대의 DB 서버가 다 처리하면 트래픽이 늘 때 병목이 돼요.

해결책은 프라이머리(마스터) 서버와 동기화되는 DB 복사본(레플리카)을 만드는 거예요. 앱은 쓰기를 마스터로 보내고, 읽기는 레플리카에 분산시켜요. 코드 변경 없이 레플리카를 추가하는 것만으로 읽기 용량을 수평 확장할 수 있어요.

도서관으로 비유하면, 저자가 편집할 수 있는 원본 원고(마스터)가 하나 있어요. 독자를 위해 복사본(레플리카)을 만들어 곳곳의 열람실에 배치해요. 독자가 더 늘어나면? 열람실을 더 열면 돼요. 원본 원고는 쓰기 용도로만 접근해요.

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

Stingerloom이 자동으로 어떤 서버를 쓸지 결정해요:

- **쓰기** (`save`, `delete`, `update`, `insertMany`, `deleteMany`, `upsert`)는 항상 마스터로 가요.
- **읽기** (`find`, `findOne`, `findWithCursor`, `count`, `explain`)는 라운드 로빈으로 슬레이브에 분산돼요 (replica1, 그다음 replica2, 다시 replica1, ...).
- **페일오버:** 모든 슬레이브가 죽으면 읽기가 자동으로 마스터로 폴백돼요. 읽기 확장 이점은 없지만 앱은 계속 동작해요.

### 복제 지연 이해

함정이 하나 있어요. 마스터에 데이터를 쓰면 변경 사항이 레플리카로 전파되기까지 짧은 시간(보통 10-100ms, 부하가 높으면 더)이 걸려요. 이 지연을 **복제 지연**이라고 해요.

이런 상황을 생각해 보세요:

```typescript
// 1단계: 마스터에 쓰기
await em.save(User, { id: 1, name: "업데이트된 이름" });

// 2단계: 레플리카에서 읽기 (10ms 후)
const user = await em.findOne(User, { where: { id: 1 } });
// user.name이 아직 "이전 이름"일 수 있음 -- 레플리카가 아직 따라잡지 못했을 수 있음!
```

쓰기 직후 최신 데이터를 읽어야 할 때는 `useMaster` 옵션으로 읽기를 마스터로 강제하면 돼요:

```typescript
await em.save(User, { id: 1, name: "업데이트된 이름" });

const user = await em.findOne(User, {
  where: { id: 1 },
  useMaster: true, // 레플리카를 우회하고 마스터에서 직접 읽기
});
// user.name이 "업데이트된 이름"임을 보장
```

`useMaster`는 아껴서 쓰세요. 모든 읽기에 `useMaster`를 붙이면 레플리카를 둔 의미가 없어져요.

### 레플리카 헬스 체크

프로덕션에서 레플리카는 다운되거나 지연될 수 있어요. Stingerloom의 `ReplicationRouter`는 비정상 레플리카를 자동으로 로테이션에서 제외하고, 복구되면 다시 추가하는 자동 헬스 모니터링을 지원해요.

```typescript
await em.register({
  type: "postgres",
  // ...
  replication: {
    master: { /* ... */ },
    slaves: [ /* ... */ ],
    healthCheck: {
      enabled: true,
      intervalMs: 5000,          // 5초마다 체크 (기본값)
      query: "SELECT 1",         // 헬스 체크 SQL (기본값)
      failureThreshold: 3,       // 연속 3회 실패 후 제외 (기본값)
      recoveryThreshold: 2,      // 연속 2회 성공 후 복구 (기본값)
    },
  },
});
```

| 옵션 | 타입 | 기본값 | 설명 |
|-----|------|-------|------|
| `enabled` | `boolean` | `false` | 자동 헬스 체크 활성화 |
| `intervalMs` | `number` | `5000` | 체크 간격 (ms) |
| `query` | `string` | `"SELECT 1"` | 레플리카가 살아있는지 확인하는 SQL 쿼리 |
| `failureThreshold` | `number` | `3` | 레플리카를 다운으로 표시하기 전 연속 실패 횟수 |
| `recoveryThreshold` | `number` | `2` | 복구된 레플리카를 다시 사용하기 전 연속 성공 횟수 |

레플리카가 `failureThreshold`만큼 연속으로 헬스 체크에 실패하면 라운드 로빈 로테이션에서 제외돼요. 읽기는 자동으로 남은 정상 레플리카 또는 마스터로 폴백해요. 실패한 레플리카가 `recoveryThreshold`만큼 연속으로 체크를 통과하면 다시 추가돼요.

헬스 체크는 `propagateShutdown()` 중에 자동으로 중지돼요.

---

## 멀티 DB 연결

앱이 둘 이상의 DB와 통신해야 할 때가 있어요. 예를 들어, 메인 MySQL에는 사용자와 게시물이 있고, 별도 PostgreSQL에는 분석 이벤트가 있을 수 있어요. Stingerloom은 named connection으로 이걸 지원해요.

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

NestJS 통합 모듈은 named connection을 기본 지원해요. `forRoot()`와 `forFeature()`의 두 번째 인자로 connection name을 전달하면 돼요:

```typescript
// app.module.ts
@Module({
  imports: [
    StingerloomOrmModule.forRoot(mysqlOptions),                  // "default"
    StingerloomOrmModule.forRoot(postgresOptions, "analytics"),  // named
    UsersModule,
    AnalyticsModule,
  ],
})
export class AppModule {}

// analytics.module.ts
@Module({
  imports: [StingerloomOrmModule.forFeature([Event], "analytics")],
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

connection name을 생략하면 `"default"`가 사용돼요. 멀티 DB를 안 쓰는 기존 코드는 변경 없이 완전히 하위 호환돼요.

토큰 헬퍼 함수도 고급 DI 시나리오에 쓸 수 있어요:

- `getEntityManagerToken(connectionName?)` -- EntityManager DI 토큰 반환
- `getOrmServiceToken(connectionName?)` -- OrmService DI 토큰 반환
- `makeInjectRepositoryToken(entity, connectionName?)` -- Repository DI 토큰 반환

---

## Naming Strategy

`namingStrategy` 옵션은 TypeScript 클래스/프로퍼티명으로부터 DB 식별자(테이블명, 컬럼명, FK/인덱스명)를 파생하는 방식을 제어해요. 전략을 지정하지 않으면 ORM은 `DefaultNamingStrategy`를 사용해요 — 컬럼명은 원본 그대로 유지하고, FK 이름은 SHA1 해시로 파생해요.

### 내장: `SnakeNamingStrategy`

`camelCase` 프로퍼티명을 `snake_case` DB 컬럼으로 변환해요 — 대부분의 PostgreSQL/MySQL 코드베이스 관례예요.

```typescript
import { SnakeNamingStrategy } from "@stingerloom/orm";

await em.register({
  type: "postgres",
  // ...
  namingStrategy: new SnakeNamingStrategy(),
});
```

이 전략을 쓰면:

| TypeScript | 데이터베이스 |
|---|---|
| `class UserProfile` | `user_profile` |
| `firstName: string` | `first_name` |
| `@ManyToOne(() => Author) author!: Author` | FK 컬럼 `author_id` |

변환은 엔티티 등록 **및** 결과 역직렬화(DB 컬럼 → 엔티티 프로퍼티) 시점에 적용되므로, 코드에서 `snake_case`를 다룰 일이 없어요.

### 커스텀 전략 구현

기존 스키마가 어느 관례에도 맞지 않거나, 조직 고유의 FK/인덱스 접두사가 필요할 때 `NamingStrategy` 인터페이스를 구현하세요. 인터페이스는 ORM이 생성하는 모든 식별자를 커버해요:

```typescript
import { NamingStrategy } from "@stingerloom/orm";

class UppercaseNamingStrategy implements NamingStrategy {
  tableName(className: string): string {
    // Users → USERS
    return className.toUpperCase() + "S";
  }

  columnName(propertyName: string): string {
    // firstName → FIRST_NAME
    return propertyName.replace(/([A-Z])/g, "_$1").toUpperCase();
  }

  joinColumnName(propertyName: string, referencedColumnName: string): string {
    // author + id → AUTHOR_ID
    return `${propertyName.toUpperCase()}_${referencedColumnName.toUpperCase()}`;
  }

  foreignKeyName(table: string, column: string, referencedTable: string): string {
    return `FK_${table}_${column}_${referencedTable}`.slice(0, 63);
  }

  uniqueIndexName(table: string, columns: string[]): string {
    return `UQ_${table}_${columns.join("_")}`;
  }

  indexName(table: string, column: string): string {
    return `IX_${table}_${column}`;
  }

  compositeIndexName(table: string, columns: string[]): string {
    return `IX_${table}_${columns.join("_")}`;
  }

  jsonIndexName(
    table: string,
    column: string,
    pathSegments: ReadonlyArray<string | number>,
    using: "gin" | "btree",
  ): string {
    const path = pathSegments.length ? `_${pathSegments.join("_")}` : "";
    return `IX_JSON_${table}_${column}${path}_${using}`;
  }
}

await em.register({
  // ...
  namingStrategy: new UppercaseNamingStrategy(),
});
```

### 메서드 레퍼런스

| 메서드 | 호출되는 곳 | 목적 |
|---|---|---|
| `tableName(className)` | 엔티티 등록 | 명시적 `name` 없는 `@Entity()`의 기본 테이블명. |
| `columnName(propertyName)` | 컬럼 등록 | 명시적 `name` 없는 `@Column()`의 기본 DB 컬럼명. |
| `joinColumnName(propertyName, refPk)` | `@ManyToOne`/`@OneToOne` | 명시적 `joinColumn` 옵션 없을 때의 FK 컬럼명. |
| `foreignKeyName(table, column, refTable)` | DDL 생성 | `CONSTRAINT ... FOREIGN KEY` 절의 이름. PostgreSQL 제약 때문에 63자 이내 유지. |
| `uniqueIndexName(table, columns)` | `@UniqueIndex` | 복합 고유 인덱스 이름. |
| `indexName(table, column)` | 프로퍼티 수준 `@Index` | 단일 컬럼 인덱스 이름. |
| `compositeIndexName(table, columns)` | 클래스 수준 `@Index` | 다중 컬럼 인덱스 이름. |
| `jsonIndexName(table, column, path, using)` | `@JsonIndex` | JSON 경로 표현식 인덱스 이름(PostgreSQL). |

### `DefaultNamingStrategy` 상속

한두 메서드만 재정의하고 싶을 때는 내장 전략을 상속하세요:

```typescript
import { DefaultNamingStrategy } from "@stingerloom/orm";

class PrefixedFKStrategy extends DefaultNamingStrategy {
  foreignKeyName(table: string, column: string, refTable: string): string {
    return `fk_${table}__${refTable}__${column}`.slice(0, 63);
  }
}
```

재정의한 메서드만 바뀌고, 나머지 식별자는 기본 관례를 계속 따라요.

### 주의사항

- **Naming strategy는 등록 시점에 적용돼요.** 이미 운영 중인 테이블의 전략을 바꾸려면 코드 변경이 아니라 마이그레이션이 필요해요.
- **식별자 길이가 중요해요.** PostgreSQL은 식별자를 63바이트에서 자름. `DefaultNamingStrategy`는 이를 지키기 위한 해시 폴백 경로가 있어요 — 커스텀 전략에서도 이를 복제하지 않으면 마이그레이션이 제약을 조용히 리네임할 수 있어요.
- **전략은 제약 drop SQL을 제어하지 않아요.** 이름만 생성할 뿐이라, 테이블이 존재하는 상태에서 전략을 바꾸면 기존 제약은 마이그레이션 전까지 원래 이름을 유지해요.

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
  synchronize?: boolean | "safe" | "dry-run" | SynchronizeOptions;  // 모드, 또는 객체 { mode, continueOnError, failOnDestructiveChange, logDDL } (기본값: false)
  schema?: string;               // PostgreSQL 스키마 (기본값: "public")
  charset?: string;              // MySQL 문자셋
  datesStrings?: boolean;        // MySQL 날짜를 문자열로 반환
  queryTimeout?: number;         // 전역 쿼리 타임아웃 (ms)
  pool?: PoolOptions;            // 커넥션 풀 설정
  retry?: RetryOptions;          // 연결 재시도 설정
  logging?: boolean | LoggingOptions;  // 쿼리 로깅
  replication?: ReplicationConfig;     // Read Replica 설정
  namingStrategy?: NamingStrategy;     // 커스텀 FK/인덱스 네이밍 전략
  tenantStrategy?: "search_path" | "schema_qualified" | "tenant_column" | "database"; // 테넌트 격리 전략 (기본값: "search_path")
  tenantColumnName?: string;           // tenant_column 전략: 판별 컬럼 이름 (기본값: "tenant_id")
  tenantColumnType?: "varchar" | "uuid" | "int" | "bigint"; // tenant_column 전략: 컬럼 타입 (기본값: "varchar")
  tenantColumnLength?: number;         // tenant_column 전략: varchar 길이 (기본값: 64)
  tenantOnMissingContext?: "throw" | "warn" | "allow"; // tenant_column 전략: 테넌트 컨텍스트 부재 시 read/update/delete 정책 (기본값: "warn")
  plugins?: StingerloomPlugin[];       // register() 시 자동 설치할 플러그인
}
```

## CJS/ESM 듀얼 빌드

Stingerloom은 CJS/ESM 듀얼 패키지로 배포돼요. 별도 설정 없이 두 모듈 시스템 모두 자동으로 동작해요:

```typescript
// ESM (최신, 권장)
import { EntityManager } from "@stingerloom/orm";

// CommonJS (레거시)
const { EntityManager } = require("@stingerloom/orm");
```

서브패스 export도 듀얼이에요:

| 서브패스 | 설명 |
|---------|------|
| `@stingerloom/orm` | 코어 ORM (EntityManager, 데코레이터 등) |
| `@stingerloom/orm/nestjs` | NestJS 통합 모듈 |
| `@stingerloom/orm/prisma-import` | Prisma 스키마 임포터 |

`package.json`의 `exports` 필드가 각 서브패스를 적절한 `import` (ESM) 또는 `require` (CJS) 진입점에 매핑해요. 별도 설정은 필요 없어요.

## 다음 단계

- [고급 기능](./advanced.md) -- 스트리밍, 이벤트 시스템, 쿼리 빌더, N+1 감지
- [멀티테넌시](./multi-tenancy.md) -- 테넌트별 데이터 격리
- [API 레퍼런스](./api-reference.md) -- 전체 메서드 시그니처
