# 설정 가이드

## 기본 연결

Stingerloom이 동작하려면 먼저 데이터베이스에 연결해야 합니다. 연결 설정에는 데이터베이스 위치, 인증 정보, 관리할 엔티티를 지정합니다.

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

#### `schema` 옵션

PostgreSQL에는 데이터베이스와 테이블 사이에 단계가 하나 더 있습니다. **스키마**는 네임스페이스입니다. 모든 데이터베이스는 `public`이라는 스키마 하나를 갖고 시작합니다. `schema` 옵션은 이 연결이 작업할 스키마를 지정합니다. 기본값은 `"public"`입니다. 이 옵션은 다음 세 가지를 결정합니다.

- **이름 해석.** 풀은 새 연결을 내주기 전에 `SET search_path TO "<schema>"`를 실행합니다. 그래서 생성된 SQL에서 스키마를 붙이지 않은 테이블 이름은 이 스키마에서 찾습니다. 이 SQL 문이 실패하면 풀은 그 연결을 버립니다. 그리고 연결을 요청한 작업이 그 에러로 실패합니다.
- **DDL 대상.** `synchronize`는 이 스키마에 테이블을 만들고 변경합니다. ENUM 타입도 이 스키마에 프로비저닝합니다. `migrate:generate`도 이 스키마를 인트로스펙션합니다. 스키마가 없으면 자동으로 만듭니다.
- **멀티테넌시 기준점.** 스키마 기반 테넌트 전략(`search_path`, `schema_qualified`)은 테넌트 컨텍스트 안에서 다른 스키마로 전환합니다. 그리고 컨텍스트 밖에서는 이 스키마로 돌아옵니다. [멀티테넌시](./multi-tenancy.md)를 참고하세요.

```typescript
await em.register({
  type: "postgres",
  // ...
  schema: "app",   // 테이블이 "public"이 아니라 "app"에 놓입니다
});
```

엔티티 하나만 다른 스키마에 두려면 `@Entity({ schema })`를 씁니다. ORM은 그 테이블을 이 옵션이나 활성 테넌트와 상관없이 항상 `"schema"."table"`로 참조합니다. 테넌트마다 스키마를 나누는 구성에서 테이블 하나를 모든 테넌트가 공유하게 하려면 이 방법을 씁니다. [공유 테이블](./multi-tenancy.md#공유-테이블-엔티티를-스키마에-고정하기)을 참고하세요. MySQL과 SQLite에는 스키마 계층이 없으므로 이 옵션을 무시합니다.

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

SQLite는 모든 데이터를 파일 하나에 저장합니다. 연결할 서버가 없으므로 host, port, username, password는 비워 둡니다. 그래서 테스트, 프로토타이핑, 임베디드 애플리케이션에 잘 맞습니다.

### 옵션 검증

`register()`는 연결하기 전에 옵션을 검증합니다. 문제가 있으면 모든 문제를 나열한 `INVALID_CONFIG` 에러 하나를 던집니다. 여러 연결을 쓰는 구성에서는 실패한 연결의 이름도 함께 알려 줍니다.

- **필수 필드.** `type`, `database`, `entities`가 필요합니다. MySQL, MariaDB, PostgreSQL에는 `host`, `port`, `username`, `password`도 필요합니다.
- **값.** 지정한 옵션은 모두 허용된 값이어야 합니다. 값 목록이 정해진 옵션은 목록 밖의 값을 거부하고 가장 가까운 값을 알려 줍니다. 해당 옵션은 `synchronize`와 그 `mode`, `tenantStrategy`, `tenantOnMissingContext`, `publicTenantBehavior`, `tenantColumnType`, `unknownWriteKeys`, `replication.strategy`입니다. 예를 들어 `tenantStrategy: "tenant-column"`은 테넌트 격리 없이 부팅되는 대신 `Did you mean "tenant_column"?`과 함께 실패합니다. `pool.max`, `connectionLimit`, `retry.maxAttempts` 같은 개수는 양의 정수여야 합니다. `queryTimeout`, `pool.idleTimeoutMs` 같은 시간은 0 이상의 유한한 수여야 합니다. 그래서 `NaN`이나 `"10"`은 거부합니다. `namingStrategy`, `plugins`의 각 원소, `cache.store`는 해당 인터페이스의 메서드를 갖춰야 합니다. 그래서 `namingStrategy: "snake"`는 엔티티를 설정하다가 `TypeError`를 던지지 않고 이 단계에서 실패합니다.
- **중첩 객체.** `pool`, `retry`, `cache`, `logging`, `synchronize`, `replication`은 선언하지 않은 키를 거부하고 가장 가까운 키를 알려 줍니다. `pool: { maxx: 10 }`은 `Did you mean 'max'?`와 함께 실패합니다. `ssl`은 데이터베이스 드라이버에 그대로 넘기므로 ORM이 나열하지 않은 키도 유지합니다.
- **알 수 없는 최상위 키.** 실패하지 않고 가장 가까운 유효 키를 제안하는 경고를 남깁니다. `synchronise`라고 쓰면 `Did you mean 'synchronize'?` 경고가 나옵니다. ConfigService에서 옵션을 넘겨받아 TypeScript가 오타를 잡지 못할 때 특히 유용합니다. 설정 객체 하나에 다른 소비자의 필드가 함께 들어 있을 수 있습니다. 그래서 에러가 아니라 경고로 둡니다.

---

## synchronize 옵션

### 이 옵션이 필요한 이유

엔티티에 새 `@Column()`을 추가하거나 새 엔티티 클래스를 만들어도 데이터베이스는 이 변경을 자동으로 알지 못합니다. 누군가 `ALTER TABLE`이나 `CREATE TABLE`을 실행해야 합니다. `synchronize` 옵션은 개발 중에 이 과정을 자동화합니다. 그래서 엔티티를 바꿀 때마다 DDL을 직접 작성하지 않아도 됩니다.

### 네 가지 모드

| 값 | 동작 | 사용 시점 |
|-----|------|---------|
| `false` | **동기화 안 함** (기본값): 스키마를 수정하지 않습니다 | 프로덕션. 마이그레이션으로 스키마를 관리합니다. |
| `true` | **전체 동기화**: 엔티티에 맞게 테이블을 생성하고 컬럼을 추가, 변경, 삭제합니다 | 개발 전용. 엔티티에서 컬럼을 제거하면 DB 컬럼과 데이터도 함께 삭제됩니다. |
| `"safe"` | **안전 동기화**: 새 테이블과 컬럼만 추가하고 변경, 삭제, 이름 변경은 하지 않습니다 | 스테이징. 새 테이블과 컬럼은 생기고 기존 것은 그대로 남습니다. 데이터 손실이 없습니다. |
| `"dry-run"` | **드라이 런**: 실행할 DDL을 로그로만 출력하고 실행하지 않습니다 | 배포 전 검토. 어떤 SQL이 실행될지 미리 확인합니다. |

```typescript
await em.register({
  // ...
  synchronize: "safe",
});
```

### 실제 위험 시나리오

프로덕션에서 전체 동기화(`true`)를 쓰면 최악의 상황이 생깁니다.
월요일에 엔티티에는 `nickname` 컬럼이 있습니다. 화요일에 이 컬럼의 이름을 `bio`로 바꾸기로 합니다. 전체 동기화는 엔티티에서 `nickname`이 없어진 것을 감지하고 `ALTER TABLE user DROP COLUMN nickname`을 실행합니다. 모든 사용자의 닉네임이 사라집니다. 그다음 `bio`를 빈 새 컬럼으로 만듭니다. 이름 변경이 아니라 삭제 후 생성입니다.

전체 동기화도 이름 변경이 확실하면 RENAME을 실행합니다. 엔티티가 `@Column({ renamedFrom: "nickname" })`을 선언한 경우가 그렇습니다. 두 이름이 누가 봐도 같은 컬럼인 경우도 그렇습니다. `nickname`과 `nickName`이 그 예입니다. 그보다 확실하지 않은 쌍은 보고만 하고 위처럼 drop + add로 처리합니다. 추측으로 이름을 바꾸면 삭제된 컬럼의 데이터가 새 이름으로 되살아나기 때문입니다. [컬럼 이름 변경 감지](./migrations.md#컬럼-이름-변경-감지)를 참고하세요.

안전 동기화(`"safe"`)는 안전망 역할을 합니다.
같은 상황에서 안전 동기화를 쓰면 ORM은 새 `bio` 컬럼을 만들고 `nickname`은 그대로 둡니다. 데이터 손실이 없습니다. 나중에 데이터를 직접 옮기고 준비가 되면 이전 컬럼을 삭제하면 됩니다.

안전 모드는 적용하지 않고 건너뛴 변경을 로그로 알려 줍니다. 그래서 손대지 않은 스키마가 동기화된 스키마처럼 보이지 않습니다.

```
WARN [SchemaRegistrar] [sync] safe mode skipped 2 schema change(s): 1 ALTER COLUMN, 1 DROP COLUMN (user.email, user.nickname). Apply them with synchronize.mode: true or a migration; set synchronize.logDDL: true to log each skipped statement.
```

`logDDL: true`를 함께 주면 건너뛴 DDL 문도 모두 출력합니다.

```
INFO [SchemaRegistrar] [skipped: safe mode] ALTER TABLE `user` MODIFY COLUMN `email` VARCHAR(64) NOT NULL
INFO [SchemaRegistrar] [skipped: safe mode] ALTER TABLE user DROP COLUMN nickname
```

특히 컬럼을 넓히는 변경에 주의해야 합니다. 엔티티에서 `varchar(50)`을 `varchar(255)`로 바꿔도 안전 모드는 DB의 길이를 50으로 그대로 둡니다. 그래서 이 불일치는 나중에 INSERT할 때 truncation 에러로 드러납니다. 이 경고가 보이면 마이그레이션을 실행해야 합니다.

드라이 런(`"dry-run"`)은 미리 보기입니다.
같은 상황에서 ORM은 `ALTER TABLE user ADD COLUMN display_name varchar(255)` 같은 DDL을 콘솔에 출력합니다. 하지만 실행하지는 않습니다. 출력을 검토하고 마이그레이션 파일을 조정한 뒤 직접 적용하면 됩니다.

> 경고: `synchronize: true`는 개발 환경에서만 쓰세요. 프로덕션에서는 [마이그레이션](./migrations.md)을 쓰세요.

### 옵션 객체 폼

위의 단일 값 네 가지는 복원력, 파괴적 변경 안전성, DDL 가시성이라는 서로 다른 관심사를 enum 하나에 묶은 형태입니다. 객체로 넘기면 각 관심사를 따로 제어합니다.

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
| `mode` | 필수 | 기본 모드. 단일 값 폼과 뜻이 같습니다. |
| `continueOnError` | `true` | `false`이면 DDL이 처음 실패할 때 warn으로 낮추지 않고 `OrmError(SCHEMA_SYNC_FAILED)`를 던집니다. 반쯤 마이그레이션된 스키마를 로그로 찾기보다 부팅을 명시적으로 실패시키고 싶을 때 쓰세요. 값과 상관없이 부팅이 실패하는 경우도 있습니다. 엔티티와 비교하려고 기존 테이블을 읽다가 실패하거나 내장 타입도 아니고 `ColumnTypeRegistry`에 등록되지도 않은 컬럼 타입을 만난 경우입니다. 이런 경우는 DDL 문이 실패한 것이 아니기 때문입니다. |
| `failOnDestructiveChange` | `false` | `true`이면 DROP COLUMN, 좁히는 ALTER, RENAME COLUMN을 실행하기 전에 `OrmError(SCHEMA_SYNC_DESTRUCTIVE_CHANGE)`를 던집니다. 좁히는 ALTER의 예는 `varchar(255) → int`, `varchar(255) → varchar(64)`, 값을 제거하는 MySQL `ENUM` 변경입니다. 프로덕션 안전망으로 유용합니다. synchronize는 어떤 모드에서도 테이블을 삭제하지 않으므로 테이블 삭제는 막을 대상이 아닙니다. |
| `logDDL` | `false` | `true`이면 실행하는 모든 DDL을 info 레벨로 로그에 출력합니다. CREATE TABLE, ALTER, RENAME, DROP, FULLTEXT INDEX가 모두 해당합니다. `"safe"`에서는 건너뛴 SQL 문도 `[skipped: safe mode]` 접두어를 붙여 함께 출력합니다. `"dry-run"`과 함께 쓰면 실행할 DDL을 모두 확인합니다. |

단일 값 폼(`true`, `"safe"`, `"dry-run"`, `false`)도 그대로 동작합니다. 같은 기본값으로 정규화하므로 기존 설정을 고치지 않아도 됩니다.

### PostgreSQL ENUM 타입

PostgreSQL에서 enum 컬럼은 값 목록을 직접 갖지 않고 이름 있는 타입을 참조합니다. 타입이 없으면 그 타입을 쓰는 테이블도 만들지 못합니다. 그래서 synchronize는 테이블을 건드리기 전에 enum 타입부터 준비합니다.

- enum 컬럼이 참조하지만 DB에 없는 타입은 생성합니다(`CREATE TYPE "post_status" AS ENUM (...)`).
- 엔티티에는 있지만 타입에는 없는 값은 추가합니다(`ALTER TYPE ... ADD VALUE`). 이때 값을 끝에 덧붙이지 않고 선언된 위치에 삽입합니다. 그래서 이 컬럼으로 `ORDER BY`한 결과가 계속 `enumValues` 순서와 일치합니다.
- DB에는 있지만 엔티티가 더 이상 선언하지 않는 값은 경고만 하고 제거하지 않습니다. PostgreSQL은 enum 값을 제자리에서 삭제하지 못합니다. 값을 없애려면 타입과 그 타입을 쓰는 모든 컬럼을 다시 만들어야 합니다. 그러므로 검토를 거친 마이그레이션으로 처리합니다.

타입 생성과 값 추가는 비파괴적이므로 `"safe"`에서도 실행합니다. safe 모드가 실행하는 CREATE TABLE과 ADD COLUMN에 이 타입이 필요합니다. 그래서 여기서 막으면 오히려 그 작업이 깨집니다. `"dry-run"`은 실행하지 않고 SQL 문을 로그로 남깁니다.

```
INFO [SchemaRegistrar] [dry-run] Would CREATE TYPE post_status_enum AS ENUM ('draft', 'published')
INFO [SchemaRegistrar] [dry-run] Would ALTER TYPE post_status_enum ADD VALUE IF NOT EXISTS 'archived' BEFORE 'published'
```

MySQL과 SQLite에는 이 과정이 없습니다. MySQL은 컬럼 자체의 `ENUM(...)` 타입에 값을 담고 SQLite는 `TEXT`로 저장하기 때문입니다. MySQL과 MariaDB에서 diff는 값 목록이 바뀌면 컬럼이 바뀐 것으로 봅니다. 전체 동기화(`true`)는 `MODIFY COLUMN`으로 이 변경을 적용합니다. `"safe"`는 다른 ALTER처럼 이 변경을 건너뜁니다. 값을 제거하는 변경은 `failOnDestructiveChange`에서 좁히는 ALTER로 취급합니다. 자세한 내용은 [ENUM 값 동기화](./migrations.md#enum-값-동기화-postgresql)에 있습니다.

### synchronize가 적용하지 않는 변경

synchronize는 이미 있는 테이블의 컬럼을 비교합니다. 그리고 엔티티에 새로 생긴 인덱스와 외래 키를 만듭니다. 하지만 다음 항목은 비교하지 않으므로 수정해도 적용되지 않습니다. 컬럼 `default`, `onDelete`와 `onUpdate`, 제거하거나 다시 정의한 인덱스, `@ComputedColumn` 표현식입니다. 이미 있던 테이블이 있으면 부팅할 때마다 엔티티가 쓰는 항목을 한 줄로 알려 줍니다.

```
INFO [SchemaRegistrar] [sync] synchronize does not apply these to existing tables: changed column defaults, removed or redefined indexes. Write a migration for them (see docs/migrations.md#what-the-schema-diff-does-not-compare).
```

항목별로 `migrate:generate`가 하는 일까지 담은 전체 표는 [Schema Diff가 비교하지 않는 것](./migrations.md#schema-diff가-비교하지-않는-항목)에 있습니다.

---

## 연결 풀링

### 연결 풀링이 중요한 이유

새 데이터베이스 연결을 여는 비용은 큽니다. 연결마다 TCP 핸드셰이크, 인증, SSL 협상이 필요합니다. 대부분의 시스템에서 30~80밀리초가 걸립니다. 작아 보이지만 초당 요청 200개를 처리하는 API 서버를 생각해 보세요. 모든 요청이 연결을 열고 닫으면 연결 오버헤드에만 초당 6~16초를 씁니다. 물리적으로 불가능한 일입니다.

공항 택시 승강장을 떠올리면 이해하기 쉽습니다. 승객이 올 때마다 새 택시를 부르지 않고 택시를 승강장에 대기시켜 둡니다. 승객은 오자마자 택시를 탑니다. 운행을 마친 택시는 다음 승객을 위해 승강장으로 돌아옵니다. 이것이 연결 풀입니다.

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

각 설정의 역할은 다음과 같습니다.

- **`max: 20`**: 동시 연결을 최대 20개까지 엽니다. 20개가 모두 사용 중일 때 21번째 요청이 오면 `acquireTimeoutMs`까지 대기합니다. 값이 너무 높으면 DB 메모리를 낭비합니다. 반대로 너무 낮으면 대기열이 생깁니다.
- **`min: 5`**: 아무도 쓰지 않아도 연결 5개를 항상 열어 둡니다. 그래서 한동안 트래픽이 없다가 몰릴 때 생기는 콜드 스타트 부담을 없앱니다.
- **`acquireTimeoutMs: 5000`**: 5초 안에 연결을 얻지 못하면 에러를 던집니다. 그래서 풀이 가득 찼을 때 요청이 끝없이 대기하지 않습니다.
- **`idleTimeoutMs: 30000`**: 연결을 30초 동안 쓰지 않았고 풀의 연결이 `min`보다 많으면 그 연결을 닫습니다. 그래서 트래픽이 적을 때 리소스를 해제합니다.

### 데이터베이스 지원

| 옵션 | MySQL | PostgreSQL | SQLite |
|------|-------|-----------|--------|
| `max` | 예 | 예 | 무시됨 |
| `min` | 미지원 | 예 | 무시됨 |
| `acquireTimeoutMs` | 미지원 | 예 | 예 |
| `idleTimeoutMs` | 미지원 | 예 | 무시됨 |

> 참고: SQLite는 연결 하나를 쓰는 파일 기반 데이터베이스입니다. 그래서 `acquireTimeoutMs`를 뺀 풀 설정은 무시합니다. `acquireTimeoutMs`는 다른 트랜잭션이 연결을 쥐고 있는 동안 SQL 문이나 트랜잭션이 기다리는 시간입니다([SQLite의 트랜잭션](./transactions.md#transactions-on-sqlite) 참고). 읽기와 쓰기가 디스크의 파일로 바로 가므로 TCP 오버헤드가 없습니다.

---

## 연결 재시도

### 연결 재시도가 중요한 이유

요즘 배포 환경에서는 앱과 DB가 동시에 시작하는 경우가 많습니다. Docker Compose나 Kubernetes 같은 컨테이너 오케스트레이션에서는 앱이 연결을 시도할 때 DB가 준비됐다는 보장이 없습니다. 재시도 로직이 없으면 앱은 시작할 때 "ECONNREFUSED"로 크래시합니다. 그러면 직접 재시작해야 합니다.

연결 재시도는 이 문제를 해결합니다. 시도할 때마다 조금 더 오래 기다린 뒤 다시 연결합니다.

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

`maxAttempts`와 `backoffMs`는 모두 선택 사항입니다. 생략한 필드는 기본값을 씁니다. 그래서 `retry: {}`는 1000ms부터 시작해 세 번 시도합니다.

### 실패한 시도로 치는 경우

시도할 때마다 서버에 연결을 하나 엽니다. 서버가 내려가 있으면 그 시도는 실패합니다. 서버가 로그인을 거부하거나 데이터베이스가 없을 때도 실패합니다. 마지막 시도까지 실패하면 `register()`는 코드가 `ORM_CONNECTION_FAILED`인 `OrmError`를 던집니다. 이 에러의 `cause`에는 드라이버의 원본 에러가 들어 있습니다. 그래서 실패 원인을 구분할 수 있습니다.

```typescript
try {
  await em.register(options);
} catch (e) {
  if (e instanceof OrmError && e.code === OrmErrorCode.CONNECTION_FAILED) {
    const driverCode = (e.cause as { code?: string } | undefined)?.code;
    // "ECONNREFUSED"   서버가 연결을 받지 않음 (모든 데이터베이스)
    // "28P01"          비밀번호 틀림 (PostgreSQL), "ER_ACCESS_DENIED_ERROR" (MySQL)
    // "3D000"          없는 데이터베이스 (PostgreSQL), "ER_BAD_DB_ERROR" (MySQL)
  }
}
```

`retry`가 없으면 첫 실패에서 같은 방식으로 에러를 던집니다. 이전 버전의 `register()`는 직접 연결을 열지 않았습니다. 그래서 서버가 내려가 있어도 성공했고 `retry`는 한 번도 재시도하지 않았습니다. 대신 실패는 첫 쿼리에서 드러났습니다.

### 지수 백오프 공식

재시도 사이의 대기 시간은 일정하지 않습니다. 매번 두 배로 늘어납니다.

```
delay = backoffMs * 2^(attempt - 1)
```

`backoffMs: 500`일 때 실제 타임라인은 다음과 같습니다.

| 시도 | 공식 | 다음 시도까지 대기 |
|------|------|----------------|
| 1차 | 500 * 2^0 | 500ms |
| 2차 | 500 * 2^1 | 1,000ms |
| 3차 | 500 * 2^2 | 2,000ms |
| 4차 | 500 * 2^3 | 4,000ms |
| 5차 | (마지막 시도) | 없음 |

포기하기 전까지 최대 총 대기 시간은 500 + 1000 + 2000 + 4000 = 7.5초입니다. 보통 DB 컨테이너가 초기화를 마치기에 충분합니다.

고정 지연 대신 지수 백오프를 쓰는 이유가 있습니다. DB가 짧은 네트워크 장애로 내려갔다면 500ms 뒤의 첫 재시도에서 빠르게 연결합니다. PostgreSQL이 크래시에서 복구하는 경우처럼 시작이 더 느리면 이후 시도가 충분한 여유를 줍니다. 그러면서도 서버에 연결 요청을 쏟아붓지 않습니다.

---

## 시작 이후 끊긴 연결

`retry`는 `register()`에만 적용됩니다. 연결은 그 뒤에 아무 쿼리도 실행하지 않는 동안에도 끊길 수 있습니다. 다음과 같은 경우입니다.

- 데이터베이스가 재시작한 경우
- 페일오버로 프라이머리가 바뀐 경우
- 관리자가 세션을 종료한 경우
- 방화벽이 유휴 연결을 끊은 경우

그 연결을 기다리는 호출이 없으므로 에러를 던질 곳도 없습니다. 이런 에러는 `onConnectionError`가 받습니다.

```typescript
await em.register({
  type: "postgres",
  // ...
  onConnectionError: (error) => {
    metrics.increment("db.connection_lost");
    logger.warn(error.message, { cause: error.cause });
  },
});
```

에러는 코드가 `ORM_CONNECTION_LOST`인 `OrmError`입니다. `cause`에는 드라이버 에러가 들어 있습니다. 끊긴 연결마다 한 번만 알립니다. 옵션을 주지 않으면 ORM이 에러를 경고 로그로 남깁니다.

콜백에서 복구할 것은 없습니다. 풀은 이미 그 연결을 버렸습니다. 그리고 다음 쿼리를 실행할 때 새 연결을 엽니다. 그 연결을 쓰던 트랜잭션은 다음 SQL 문에서 실패합니다. 같은 연결의 레플리카 풀도 같은 콜백으로 알립니다. 이름 있는 연결이나 테넌트별 데이터베이스 같은 다른 연결은 각자의 옵션에 `onConnectionError`를 따로 지정합니다.

이 콜백으로 오지 않는 에러도 있습니다. SQL 문의 에러는 그 SQL 문을 실행한 쪽으로 던집니다. `register()`나 쿼리가 연결을 열지 못하면 `ORM_CONNECTION_FAILED`를 던집니다.

PostgreSQL, MySQL, MariaDB에서 동작합니다. SQLite에는 끊길 네트워크 연결이 없습니다.

## 쿼리 로깅

### 쿼리 로깅이 중요한 이유

SQL을 대신 만드는 것이 ORM의 핵심입니다. 하지만 문제가 생기면 DB로 보내는 실제 SQL을 봐야 합니다. 쿼리가 이상한 결과를 반환하거나 페이지가 느린 경우가 그렇습니다. 쿼리 로깅은 보이지 않던 SQL을 보여 줍니다.

### 기본 로깅

```typescript
await em.register({
  // ...
  logging: true,
});
```

### 출력 모습

`logging: true`를 켜면 모든 SQL 문을 파라미터와 함께 콘솔에 출력합니다.

```
[Query] SELECT "id", "name", "email", "age" FROM "user" WHERE "is_active" = $1 [true]  (12ms)
[Query] INSERT INTO "user" ("name", "email", "age") VALUES ($1, $2, $3) RETURNING "id" ["Alice", "alice@example.com", 28]  (8ms)
[Query] UPDATE "user" SET "name" = $1 WHERE "id" = $2 ["Bob", 42]  (5ms)
```

각 줄에는 SQL 문, 대괄호 안의 바인딩된 파라미터 값, 밀리초 단위의 실행 시간이 나옵니다. 파라미터는 SQL과 따로 표시하고 SQL에는 `$1`, `$2` 같은 플레이스홀더가 들어갑니다. 실제로 DB에도 이렇게 나눠서 보냅니다. SQL 인젝션에 안전한 파라미터화된 쿼리입니다.

### 상세 로깅

더 세밀하게 제어하려면 객체를 넘깁니다.

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

N+1 감지와 느린 쿼리 경고의 자세한 내용은 [로깅 & 진단](./logging.md) 가이드를 참고하세요.

### 프로그래밍 방식 접근

쿼리 로그는 콘솔 출력뿐 아니라 데이터로도 받을 수 있습니다.

```typescript
const log = em.getQueryLog();
// [
//   { entityName: "User", sql: "SELECT ...", durationMs: 12, timestamp: 1711234567890 },
//   { entityName: "Cat",  sql: "SELECT ...", durationMs: 8,  timestamp: 1711234567920 },
// ]
```

커스텀 대시보드를 만들 때 유용합니다. 성능 테스트를 작성할 때나 특정 작업이 예상한 수만큼 쿼리를 실행하는지 테스트에서 확인할 때도 유용합니다.

---

## 쿼리 타임아웃

### 쿼리 타임아웃이 중요한 이유

누군가 WHERE 절을 빠뜨려서 행이 5천만 개인 테이블 전체를 스캔하는 쿼리를 생각해 보세요. 타임아웃이 없으면 그 쿼리는 몇 분 동안 실행되며 풀의 연결 하나를 계속 점유합니다. 다른 요청은 연결을 기다리며 쌓입니다. 결국 API가 멈춥니다. 잘못된 쿼리 하나가 앱 전체를 멈추게 한 것입니다.

쿼리 타임아웃은 서킷 브레이커 역할을 합니다. 쿼리가 정해진 시간 안에 끝나지 않으면 DB가 쿼리를 종료합니다. 그리고 Stingerloom이 `QueryTimeoutError`를 던집니다. 연결을 해제하므로 앱은 정상 상태를 유지합니다.

### 전역 설정

```typescript
await em.register({
  // ...
  queryTimeout: 5000, // 모든 읽기 쿼리에 5초 타임아웃
});
```

이 타임아웃은 읽기 경로에 적용됩니다. `find()`와 그 변형, 페이지네이션, 집계, `stream()`이 해당합니다. `save`, `updateMany`, `delete`, raw 쿼리 같은 쓰기에는 적용되지 않습니다.

### 쿼리별 오버라이드

배치 임포트나 복잡한 리포트처럼 오래 걸리는 것이 당연한 쿼리도 있습니다. 이런 쿼리에서는 개별 쿼리의 `timeout` 옵션으로 전역 타임아웃을 덮어씁니다.

```typescript
const users = await em.find(User, {
  where: { isActive: true },
  timeout: 2000, // 이 쿼리만 2초 타임아웃
});
```

### 데이터베이스 수준의 동작

Stingerloom은 JavaScript `setTimeout`으로 쿼리를 끊지 않습니다. 그렇게 하면 클라이언트 쪽 대기만 취소됩니다. 쿼리는 서버에서 계속 실행되며 DB 리소스를 낭비합니다. 대신 DB 자체의 타임아웃 메커니즘을 씁니다.

| 데이터베이스 | 쿼리 전에 전송되는 SQL |
|------------|---------------------|
| MySQL | `SET SESSION max_execution_time = 5000` |
| MariaDB | `SET SESSION max_statement_time = 5` |
| PostgreSQL | `SET LOCAL statement_timeout = '5000ms'` |
| SQLite | `PRAGMA busy_timeout` (잠금 대기만 제한하며 SQL 문 실행 시간은 제한하지 않음) |

MySQL의 `max_execution_time`은 밀리초 단위이고 SELECT 문에 적용됩니다. MariaDB에는 이 변수가 없고 초 단위의 `max_statement_time`이 같은 역할을 합니다. Stingerloom은 서버 버전 문자열을 보고 알맞은 변수를 고릅니다. 그래서 `type: "mysql"`로 MariaDB 서버에 연결해도 동작합니다. `SET SESSION`의 값은 풀의 연결에 쿼리보다 오래 남습니다. 그래서 쿼리별 오버라이드는 실행 후 연결 수준 기본값으로 되돌립니다. PostgreSQL의 `SET LOCAL`은 읽기를 실행하는 트랜잭션 안에서만 유효하므로 다른 쿼리로 새지 않습니다.

타임아웃이 걸리면 DB가 쿼리를 중단합니다. 그리고 Stingerloom은 타임아웃 값을 담은 `QueryTimeoutError`를 던집니다. 드라이버의 원본 에러는 `cause`에 있습니다.

---

## 읽기 레플리카 (읽기/쓰기 분리)

### 읽기 레플리카가 중요한 이유

대부분의 앱에서는 읽기가 쓰기보다 훨씬 많습니다. 일반적인 웹 앱은 쿼리의 80~90%가 SELECT입니다. INSERT, UPDATE, DELETE는 10~20%뿐입니다. 이 모든 쿼리를 DB 서버 한 대가 처리하면 트래픽이 늘 때 병목이 됩니다.

해결책은 프라이머리(마스터) 서버와 동기화되는 DB 복사본을 만드는 것입니다. 이 복사본이 레플리카(replica)입니다. 앱은 쓰기를 마스터로 보내고 읽기는 레플리카에 분산합니다. 그래서 코드를 바꾸지 않고 레플리카를 추가하기만 해도 읽기 용량을 수평으로 확장할 수 있습니다.

도서관에 비유하면 저자가 편집하는 원본 원고가 마스터입니다. 독자를 위해 만든 복사본을 곳곳의 열람실에 둡니다. 이 복사본이 레플리카입니다. 독자가 늘어나면 열람실을 더 열면 됩니다. 원본 원고는 쓰기에만 씁니다.

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

읽기 레플리카는 PostgreSQL, MySQL, MariaDB에서 동작합니다. SQLite에 `replication`을 넘기면 `register()`가 거부합니다.

### 라우팅 방식

Stingerloom은 어떤 서버를 쓸지 자동으로 결정합니다.

- **쓰기** (`save`, `delete`, `update`, `insertMany`, `deleteMany`, `upsert`)는 항상 마스터로 보냅니다.
- **읽기** (`find`, `findOne`, `findWithCursor`, `count`, `explain`)는 라운드 로빈으로 슬레이브에 분산합니다. replica1, replica2, 다시 replica1 순서로 보냅니다.
- **연결:** 노드마다 연결 풀이 하나씩 생깁니다. 풀 크기는 메인 풀과 같은 `pool` 옵션을 따릅니다. 노드로 가는 첫 읽기가 풀을 엽니다. 이후 읽기는 그 풀을 함께 씁니다. 풀은 `propagateShutdown()`이 닫습니다. 노드는 메인 연결 옵션을 그대로 받습니다. 다만 호스트, 포트, 계정, 데이터베이스는 노드 자신의 값을 씁니다. 노드에 `ssl`을 지정했다면 그것도 노드의 값을 씁니다.
- **페일오버:** 슬레이브는 [헬스 체크](#replica-health-checks)에 실패했을 때만 로테이션에서 빠집니다. 그러므로 프로덕션에서는 헬스 체크를 켜 두세요. 정상 슬레이브가 하나도 남지 않으면 읽기를 마스터로 보냅니다. 읽기 확장의 이점은 없지만 앱은 계속 동작합니다. 헬스 체크를 켜지 않으면 다운된 슬레이브로 보낸 읽기는 그대로 실패합니다.

### 복제 지연 이해

주의할 점이 하나 있습니다. 마스터에 데이터를 쓰면 변경 사항이 레플리카로 전파되기까지 짧은 시간이 걸립니다. 보통 10~100ms이고 부하가 높으면 더 걸립니다. 이 지연을 **복제 지연**이라고 합니다.

다음 상황을 생각해 보세요.

```typescript
// 1단계: 마스터에 쓰기
await em.save(User, { id: 1, name: "업데이트된 이름" });

// 2단계: 레플리카에서 읽기 (10ms 후)
const user = await em.findOne(User, { where: { id: 1 } });
// 레플리카가 아직 따라잡지 못했으면 user.name은 아직 "이전 이름"일 수 있음
```

쓰기 직후에 최신 데이터를 읽어야 하면 `useMaster` 옵션으로 읽기를 마스터로 보냅니다.

```typescript
await em.save(User, { id: 1, name: "업데이트된 이름" });

const user = await em.findOne(User, {
  where: { id: 1 },
  useMaster: true, // 레플리카를 우회하고 마스터에서 직접 읽기
});
// user.name이 "업데이트된 이름"임을 보장
```

`useMaster`는 아껴서 쓰세요. 모든 읽기에 `useMaster`를 붙이면 레플리카를 둔 의미가 없어집니다.

### 레플리카 헬스 체크 {#replica-health-checks}

프로덕션에서는 레플리카가 다운되거나 지연될 수 있습니다. Stingerloom의 `ReplicationRouter`는 자동 헬스 모니터링을 지원합니다. 비정상 레플리카를 로테이션에서 자동으로 제외하고 복구되면 다시 추가합니다.

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

레플리카가 `failureThreshold`만큼 연속으로 헬스 체크에 실패하면 그 레플리카를 라운드 로빈 로테이션에서 제외합니다. 그러면 읽기는 남은 정상 레플리카나 마스터로 자동으로 넘어갑니다. 실패한 레플리카가 `recoveryThreshold`만큼 연속으로 체크를 통과하면 다시 추가합니다.

체크는 노드 풀에서 꺼낸 연결로 `query`를 실행합니다. 느린 노드를 기다리는 체크가 끝나기 전에는 다음 체크를 시작하지 않습니다. 그래서 임계값은 연속된 체크 횟수를 셉니다. 헬스 체크는 `propagateShutdown()`이 중지합니다.

---

## 멀티 DB 연결

앱이 DB 둘 이상과 통신해야 할 때가 있습니다. 예를 들어 메인 MySQL에는 사용자와 게시물을 두고 별도의 PostgreSQL에는 분석 이벤트를 둡니다. Stingerloom은 이름 있는 연결(named connection)로 이런 구성을 지원합니다.

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

각 연결은 자기 `entities` 배열에 나열된 엔티티만 다룹니다. 다른 연결의 엔티티를 쓰면 즉시 `EntityMetadataNotFoundError`를 던집니다. `primaryEm.find(Log)`가 그 예입니다. 이 에러에는 연결 이름과 해결 방법이 들어 있습니다. 쿼리를 데이터베이스에 보내기 전에 던지므로 나중에 날것 그대로인 `no such table` 에러로 실패하지 않습니다. 스키마 동기화는 범위 밖의 엔티티를 건너뜁니다. 그러므로 그 테이블은 애초에 이 연결에 없습니다. `entities`가 빈 배열이면 이전처럼 모든 엔티티를 다룹니다.

범위를 정한 연결에서도 다음 두 가지는 계속 허용합니다.

- 등록된 클래스의 상속 관계. 등록된 부모의 STI/TPT 자식이나 등록된 자식의 부모를 조회합니다. 이 조회는 이 연결이 소유한 테이블을 대상으로 하는 다형 조회입니다.
- 캐스케이드 순회. `attach()`로 붙인 일부 범위 밖의 관계 대상에 도달해도 정상입니다.

NestJS 통합 모듈은 이름 있는 연결을 기본으로 지원합니다. `forRoot()`와 `forFeature()`의 두 번째 인자로 연결 이름을 넘기면 됩니다.

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

연결 이름을 생략하면 `"default"`를 씁니다. 그래서 여러 DB를 쓰지 않는 기존 코드는 고치지 않아도 그대로 동작합니다.

고급 DI 시나리오를 위한 토큰 헬퍼 함수도 있습니다.

- `getEntityManagerToken(connectionName?)`: EntityManager DI 토큰을 반환합니다.
- `getOrmServiceToken(connectionName?)`: OrmService DI 토큰을 반환합니다.
- `makeInjectRepositoryToken(entity, connectionName?)`: Repository DI 토큰을 반환합니다.

---

## 네이밍 전략

`namingStrategy` 옵션은 TypeScript 클래스 이름과 속성 이름에서 DB 식별자를 만드는 방식을 제어합니다. DB 식별자는 테이블 이름, 컬럼 이름, 외래 키 이름, 인덱스 이름입니다. 전략을 지정하지 않으면 ORM은 `DefaultNamingStrategy`를 씁니다. 이 전략은 컬럼 이름을 원래 그대로 두고 외래 키 이름은 SHA1 해시로 만듭니다.

### 내장: `SnakeNamingStrategy`

`camelCase` 속성 이름을 `snake_case` DB 컬럼 이름으로 변환합니다. 대부분의 PostgreSQL과 MySQL 코드베이스가 따르는 관례입니다.

```typescript
import { SnakeNamingStrategy } from "@stingerloom/orm";

await em.register({
  type: "postgres",
  // ...
  namingStrategy: new SnakeNamingStrategy(),
});
```

이 전략을 쓰면 다음과 같이 변환합니다.

| TypeScript | 데이터베이스 |
|---|---|
| `class UserProfile` | `user_profile` |
| `firstName: string` | `first_name` |
| `@ManyToOne(() => Author) author!: Author` | 외래 키 컬럼 `author_id` |

변환은 엔티티를 등록할 때 적용합니다. 그리고 결과를 역직렬화해 DB 컬럼을 엔티티 속성으로 바꿀 때도 적용합니다. 그래서 코드에서 `snake_case`를 다룰 일이 없습니다.

### 커스텀 전략 구현

기존 스키마가 어느 관례에도 맞지 않으면 `NamingStrategy` 인터페이스를 구현하세요. 조직 고유의 외래 키나 인덱스 접두사가 필요할 때도 마찬가지입니다. 이 인터페이스는 ORM이 생성하는 모든 식별자를 다룹니다.

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
| `joinColumnName(propertyName, refPk)` | `@ManyToOne`/`@OneToOne` | 외래 키 컬럼 이름을 명시하지 않았을 때의 기본값 (`@RelationColumn`의 `name`과 레거시 `joinColumn` 옵션이 모두 없는 경우). |
| `foreignKeyName(table, column, refTable)` | DDL 생성 | `CONSTRAINT ... FOREIGN KEY` 절의 이름. PostgreSQL 제약 때문에 63자 이내 유지. |
| `uniqueIndexName(table, columns)` | `@UniqueIndex` | 복합 고유 인덱스 이름. |
| `indexName(table, column)` | 속성 수준 `@Index` | 단일 컬럼 인덱스 이름. |
| `compositeIndexName(table, columns)` | 클래스 수준 `@Index` | 다중 컬럼 인덱스 이름. |
| `jsonIndexName(table, column, path, using)` | `@JsonIndex` | JSON 경로 표현식 인덱스 이름(PostgreSQL). |

### `DefaultNamingStrategy` 상속

메서드 한두 개만 재정의하려면 내장 전략을 상속하세요.

```typescript
import { DefaultNamingStrategy } from "@stingerloom/orm";

class PrefixedFKStrategy extends DefaultNamingStrategy {
  foreignKeyName(table: string, column: string, refTable: string): string {
    return `fk_${table}__${refTable}__${column}`.slice(0, 63);
  }
}
```

재정의한 메서드만 바뀝니다. 나머지 식별자는 계속 기본 관례를 따릅니다.

### 주의사항

- 네이밍 전략은 엔티티를 등록할 때 적용합니다. 이미 운영 중인 테이블의 전략을 바꾸려면 코드 변경만으로는 안 되고 마이그레이션이 필요합니다.
- 식별자 길이에 주의해야 합니다. PostgreSQL은 식별자를 63바이트에서 자릅니다. `DefaultNamingStrategy`에는 이 제한을 지키는 해시 대체 경로가 있습니다. 커스텀 전략에서 이 경로를 똑같이 구현하지 않으면 마이그레이션이 의도치 않게 제약 이름을 바꿀 수 있습니다.
- 전략은 제약을 삭제하는 SQL을 제어하지 않습니다. 전략은 이름만 생성합니다. 그래서 테이블이 있는 상태에서 전략을 바꾸면 기존 제약은 마이그레이션 전까지 원래 이름을 유지합니다.

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
  unknownWriteKeys?: "warn" | "throw" | "ignore"; // save/insert/upsert 페이로드의 미지 키와 쓰이지 않는 관계 행: 한 번 로그 / 거절 / 그냥 버림 (기본값: "warn")
  pool?: PoolOptions;            // 연결 풀 설정
  retry?: RetryOptions;          // 연결 재시도 설정
  logging?: boolean | LoggingOptions;  // 쿼리 로깅
  replication?: ReplicationConfig;     // 읽기 레플리카 설정
  namingStrategy?: NamingStrategy;     // 커스텀 외래 키/인덱스 네이밍 전략
  tenantStrategy?: "search_path" | "schema_qualified" | "tenant_column" | "database"; // 테넌트 격리 전략 (기본값: "search_path")
  tenantColumnName?: string;           // tenant_column 전략: 테넌트 구분 컬럼 이름 (기본값: "tenant_id")
  tenantColumnType?: "varchar" | "uuid" | "int" | "bigint"; // tenant_column 전략: 컬럼 타입 (기본값: "varchar")
  tenantColumnLength?: number;         // tenant_column 전략: varchar 길이 (기본값: 64)
  tenantOnMissingContext?: "throw" | "warn" | "allow"; // tenant_column 전략: 테넌트 컨텍스트 부재 시 read/update/delete 정책 (기본값: "warn")
  plugins?: StingerloomPlugin[];       // register() 시 자동 설치할 플러그인
}
```

## CJS/ESM 듀얼 빌드

Stingerloom은 CJS/ESM 듀얼 패키지로 배포됩니다. 별도 설정 없이 두 모듈 시스템에서 모두 동작합니다.

```typescript
// ESM (최신, 권장)
import { EntityManager } from "@stingerloom/orm";

// CommonJS (레거시)
const { EntityManager } = require("@stingerloom/orm");
```

서브패스 export도 두 모듈 시스템을 모두 지원합니다.

| 서브패스 | 설명 |
|---------|------|
| `@stingerloom/orm` | 코어 ORM (EntityManager, 데코레이터 등) |
| `@stingerloom/orm/nestjs` | NestJS 통합 모듈 |

`package.json`의 `exports` 필드가 각 서브패스를 알맞은 `import`(ESM)나 `require`(CJS) 진입점에 매핑합니다. 별도 설정은 필요 없습니다.

## 다음 단계

- [고급 기능](./advanced.md): 스트리밍, 이벤트 시스템, 쿼리 빌더, N+1 감지
- [멀티테넌시](./multi-tenancy.md): 테넌트별 데이터 격리
- [API 레퍼런스](./api-reference.md): 전체 메서드 시그니처
