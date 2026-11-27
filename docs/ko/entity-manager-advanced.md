# EntityManager -- 고급 기능

EntityManager의 고급 기능에는 이벤트 리스너, 엔티티 구독자, 멀티테넌시, 플러그인, 쿼리 진단, 리포지토리 패턴, 안전한 종료가 있습니다.

기본 CRUD는 [CRUD 기초](./entity-manager.md)를 참고하세요. 쿼리는 [쿼리 & 페이지네이션](./entity-manager-querying.md)에 있습니다. 배치 쓰기와 트랜잭션은 [쓰기 & 트랜잭션](./entity-manager-writes.md)에 있습니다.

---

## Event Listeners

### 왜 이벤트가 필요한가요?

`save()`, `delete()`, `softDelete()`를 호출하면 데이터베이스의 데이터가 바뀝니다. 이런 변경에 반응해야 할 때가 있습니다. 이때는 CRUD 로직 안이 아니라 분리된 별도 코드에서 처리하는 편이 낫습니다. 대표적인 예는 다음과 같습니다.

- **감사 로깅**: 누가 무엇을 언제 변경했는지 기록합니다.
- **캐시 무효화**: 데이터가 바뀌면 Redis 캐시를 비웁니다.
- **분석**: 새 사용자가 생성될 때마다 트래킹 이벤트를 보냅니다.
- **알림**: 주문이 완료되면 웹훅이나 이메일을 발송합니다.

이런 로직을 서비스 코드에 직접 넣어도 됩니다. 하지만 그러면 사용자를 생성하는 모든 서비스가 로깅, 캐시 무효화, 분석 전송을 각자 챙겨야 합니다. 이벤트를 쓰면 이 로직을 한곳에 한 번만 작성합니다. 그리고 데이터 변경이 어디서 일어나든 로직이 자동으로 실행됩니다.

### 이벤트 vs. 라이프사이클 훅, 언제 뭘 쓸까요?

- **생명주기 훅**(`@BeforeInsert`, `@AfterUpdate` 등)은 엔티티 클래스 자체에 정의합니다. 엔티티와 강하게 결합되어 있고 save/delete 파이프라인의 일부로 실행됩니다. "INSERT 전에 비밀번호 해싱"이나 "이메일을 소문자로 정규화" 같은 엔티티 내부 로직에 쓰세요.

- **이벤트 리스너**는 EntityManager에 정의합니다. 엔티티와 분리되어 있고 모든 엔티티 타입을 한꺼번에 관찰할 수 있습니다. "모든 데이터베이스 쓰기를 감사 테이블에 기록" 같은 횡단 관심사에 쓰세요.

### 사용 가능한 이벤트

| 이벤트 | 발생 시점 |
|-------|----------|
| `beforeInsert` | 새 행이 INSERT 되기 전 |
| `afterInsert` | 새 행이 INSERT 된 후 |
| `beforeUpdate` | 기존 행이 UPDATE 되기 전 |
| `afterUpdate` | 기존 행이 UPDATE 된 후 |
| `beforeDelete` | 행이 DELETE 되기 전 |
| `afterDelete` | 행이 DELETE 된 후 |

### 리스너 등록

```typescript
em.on("afterInsert", ({ entity, data }) => {
  console.log(`${entity.name} created:`, data);
});

em.on("beforeUpdate", ({ entity, data }) => {
  console.log(`About to update ${entity.name}:`, data);
});
```

리스너가 받는 객체에는 다음이 들어 있습니다.
- `entity`: 엔티티 클래스(생성자 함수)
- `data`: INSERT/UPDATE/DELETE 되는 엔티티 데이터

### 리스너 제거

```typescript
// 특정 리스너 제거
const listener = ({ entity, data }) => { /* ... */ };
em.on("afterInsert", listener);
em.off("afterInsert", listener);

// 모든 이벤트의 모든 리스너 제거
em.removeAllListeners();
```

::: tip
이벤트 리스너는 모든 엔티티에서 발생합니다. 특정 엔티티 클래스에만 적용되는 리스너가 필요하면 아래의 엔티티 구독자(Entity Subscribers)를 쓰세요.
:::

---

## Entity Subscribers

### 이벤트가 있는데 왜 구독자가 필요한가요?

이벤트 리스너는 모든 엔티티 타입에서 발생합니다. `afterInsert` 리스너를 등록하면 User, Post, Order를 비롯한 모든 엔티티를 생성할 때 실행됩니다. 그래서 어떤 엔티티가 이벤트를 일으켰는지 리스너 코드에서 직접 확인해야 합니다.

구독자는 특정 엔티티 클래스에 바인딩됩니다. `UserSubscriber`는 `User` 이벤트에만 반응합니다. `Post`나 `Order`에는 절대 반응하지 않습니다.

이벤트는 건물 전체를 감시하는 보안 카메라와 같습니다. 구독자는 금고만 감시하는 카메라와 같습니다.

### 구독자 vs. 글로벌 이벤트, 언제 뭘 쓸까요?

| 사용 사례 | 권장 방식 |
|----------|----------|
| 모든 데이터베이스 쓰기를 감사 테이블에 기록 | 글로벌 이벤트 리스너 |
| 데이터 변경 시 모든 캐시 무효화 | 글로벌 이벤트 리스너 |
| User 생성 시 환영 이메일 발송 | 엔티티 구독자 (UserSubscriber) |
| Post 변경 시 검색 인덱스 갱신 | 엔티티 구독자 (PostSubscriber) |
| OrderItem 변경 시 주문 합계 재계산 | 엔티티 구독자 (OrderItemSubscriber) |

### 구독자 생성

```typescript
import { EntitySubscriber, InsertEvent, UpdateEvent, DeleteEvent } from "@stingerloom/orm";

class UserSubscriber implements EntitySubscriber<User> {
  listenTo() {
    return User;
  }

  afterInsert(event: InsertEvent<User>) {
    console.log("New user created:", event.entity);
  }

  beforeUpdate(event: UpdateEvent<User>) {
    console.log("About to update user:", event.entity);
  }

  afterDelete(event: DeleteEvent<User>) {
    console.log("Users deleted where:", event.criteria);
  }
}
```

### 구독자 등록 및 제거

```typescript
const subscriber = new UserSubscriber();

// 등록
em.addSubscriber(subscriber);

// 제거
em.removeSubscriber(subscriber);
```

구독자는 이벤트 리스너와 같은 생명주기 메서드를 지원합니다. `beforeInsert`, `afterInsert`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`가 있습니다. 모두 선택 사항이므로 필요한 것만 구현하면 됩니다.

이벤트 패턴의 자세한 가이드는 [Events & Subscribers](./events.md)를 참고하세요.

---

## 멀티테넌시 -- withTenant()

### 왜 멀티테넌시가 필요한가요?

멀티테넌시는 애플리케이션 하나로 여러 고객(테넌트)에게 서비스하면서 각 테넌트의 데이터를 서로 격리하는 방식입니다. 아파트 건물을 떠올려 보세요. 건물의 기반 시설은 모두 함께 쓰지만 각 세대는 잠긴 자기만의 공간입니다.

ORM 수준의 해법이 없으면 모든 쿼리에 테넌트 스키마를 직접 붙여야 합니다. search path도 관리해야 합니다. 쿼리가 실수로 테넌트 경계를 넘지 않는지도 확인해야 합니다. `withTenant()`는 이 일을 모두 자동으로 처리합니다.

### 동작 방식

`withTenant()`는 특정 테넌트의 컨텍스트에서 콜백을 실행합니다. 콜백 안의 모든 EntityManager 작업은 자동으로 그 테넌트의 스키마와 데이터로 범위가 정해집니다.

```typescript
const result = await em.withTenant("tenant_acme", async (tenantEm) => {
  // 여기 안의 모든 쿼리는 "tenant_acme" 스키마를 대상으로 합니다
  const users = await tenantEm.find(User);
  return users;
});
```

내부에서 `withTenant()`는 `MetadataContext.run()`과 `AsyncLocalStorage`로 테넌트 컨텍스트를 격리합니다. 그래서 동시에 실행되는 요청 핸들러에서도 안전합니다. 모든 HTTP 요청이 같은 Node.js 프로세스에서 실행되더라도 요청마다 격리된 컨텍스트를 갖습니다.

### SQL 차이: 두 가지 전략

동작은 `register()`의 `tenantStrategy` 설정에 따라 달라집니다.

#### 전략 1: search_path (기본값)

`search_path` 전략에서는 ORM이 쿼리를 실행하기 전에 트랜잭션 안에서 PostgreSQL search path를 설정합니다.

```sql
-- 테넌트 읽기마다 라운드 트립 5번:
BEGIN
SET LOCAL search_path = 'tenant_acme'
SELECT "id", "name", "email" FROM "user" WHERE "isActive" = $1
COMMIT
-- (+ 연결 획득/반환)
```

`SET LOCAL`은 search path를 현재 트랜잭션에만 적용합니다. 트랜잭션이 끝나면 search path는 원래대로 돌아갑니다. 안전하지만 단순한 읽기도 트랜잭션으로 감싸야 합니다.

| 전략 | 동작 | 트레이드오프 |
|-----|------|------------|
| `"search_path"` (기본값) | 트랜잭션 안에서 `SET LOCAL search_path = 'tenant_acme'` | 모든 경우에 안전함. 하지만 읽기마다 라운드 트립 5번 |

#### 전략 2: schema_qualified

`schema_qualified` 전략에서는 ORM이 SQL의 테이블 이름에 스키마를 직접 붙입니다. 그래서 트랜잭션이 필요 없습니다.

```sql
-- 라운드 트립 1번:
SELECT "id", "name", "email" FROM "tenant_acme"."user" WHERE "isActive" = $1
```

| 전략 | 동작 | 트레이드오프 |
|-----|------|------------|
| `"schema_qualified"` | 쿼리에 `"tenant_acme"."users"` 형식 사용 | 라운드 트립 1번. 하지만 모든 쿼리가 스키마를 인식해야 함 |

다음과 같이 켭니다.

```typescript
await em.register({
  type: "postgres",
  // ...
  tenantStrategy: "schema_qualified",
});
```

`schema_qualified` 전략이 더 빠릅니다(라운드 트립 1번 대 5번). 그래도 `search_path`가 기본값인 이유는 모든 PostgreSQL 기능과 문제없이 동작하기 때문입니다. 함수, 트리거, 확장이 모두 search path를 따릅니다.

테넌트 프로비저닝과 스키마 마이그레이션을 포함한 멀티테넌시 설정 가이드는 [Multi-Tenancy](./multi-tenancy.md)를 참고하세요.

---

## 플러그인 시스템 -- extend()

### 왜 플러그인이 필요한가요?

ORM이 커질수록 팀마다 원하는 기능이 다릅니다. 쓰기 버퍼링, 감사 추적, 소프트 삭제 오버라이드, 커스텀 캐싱이 그 예입니다. 이 기능을 전부 코어에 넣으면 EntityManager가 거대해집니다. 그리고 모든 사용자가 쓰지도 않는 기능 때문에 번들 크기와 복잡도라는 비용을 떠안게 됩니다.

플러그인을 쓰면 필요한 기능만 골라서 추가합니다. 코어는 가볍게 유지되고 필요한 것만 더하면 됩니다.

### 플러그인 설치

플러그인은 `extend()`로 설치합니다.

```typescript
import { bufferPlugin } from "@stingerloom/orm";

const em = new EntityManager();
await em.register({ /* ... */ });

// 플러그인 설치: 새 메서드가 `em`에 믹스인됩니다
em.extend(bufferPlugin());
```

`register()`에서 선언적으로 설치해도 됩니다.

```typescript
await em.register({
  type: "postgres",
  // ...
  plugins: [bufferPlugin()],
});
```

### 플러그인 조회

```typescript
// 플러그인 설치 여부 확인
em.hasPlugin("buffer"); // true

// 플러그인 API 객체 조회
const api = em.getPluginApi<BufferApi>("buffer");
```

### 멱등성과 의존성

- 같은 플러그인을 두 번 설치하면 두 번째 설치는 무시됩니다. 그래서 여러 번 호출해도 안전합니다.
- 플러그인은 의존성을 선언할 수 있습니다. 의존하는 플러그인이 설치되지 않았으면 `extend()`가 `OrmError`를 던집니다(코드: `PLUGIN_DEPENDENCY_MISSING`).
- 플러그인 메서드 이름이 기존 EntityManager 멤버와 충돌하면 `extend()`가 `OrmError`를 던집니다(코드: `PLUGIN_CONFLICT`).

플러그인 작성 가이드와 내장 플러그인 목록은 [Plugin System](./plugins.md)을 참고하세요.

---

## Query Builder -- createQueryBuilder()

EntityManager는 `find()`로 표현하기 어려운 복잡한 쿼리에 쓰는 쿼리 빌더 두 가지를 제공합니다.

### SelectQueryBuilder (타입 안전)

엔티티 클래스와 별칭을 넘겨서 생성합니다. 컬럼을 타입 안전하게 참조할 수 있고 반환 타입도 좁혀집니다.

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name", "email"])     // Return type narrows to Pick<User, "id" | "name" | "email">
  .where("isActive", true)
  .andWhere("age", ">=", 18)
  .orderBy({ createdAt: "DESC" })
  .limit(10)
  .getMany();
```

### RawQueryBuilder (자유 형식)

인자 없이 생성합니다. 타입 제약 없이 SQL을 완전히 제어할 수 있습니다.

```typescript
import sql from "sql-template-tag";

const qb = em.createQueryBuilder();
const query = qb
  .select(["*"])
  .from('"users"')
  .where([sql`"is_active" = ${true}`])
  .build();

const result = await em.query(query);
```

JOIN, UNION, CTE, 윈도 함수, 서브쿼리, 검증을 다루는 전체 가이드는 [Query Builder](./query-builder.md)를 참고하세요.

---

## Repository 패턴 -- getRepository()

메서드마다 엔티티 클래스를 넘기지 않고 엔티티별로 CRUD를 캡슐화하려면 리포지토리를 쓰세요.

```typescript
const userRepo = em.getRepository(User);

const users = await userRepo.find();
const user = await userRepo.findOne({ where: { id: 1 } });
await userRepo.save({ name: "Alice" });
await userRepo.delete({ id: 1 });
```

리포지토리는 같은 EntityManager 메서드를 감쌉니다. 다만 특정 엔티티 클래스에 미리 바인딩되어 있습니다.

### NestJS 주입

NestJS에서는 `@InjectRepository()`로 서비스에 리포지토리를 주입합니다.

```typescript
import { Injectable } from "@nestjs/common";
import { BaseRepository } from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { User } from "./user.entity";

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly userRepo: BaseRepository<User>,
  ) {}

  findAll() {
    return this.userRepo.find();
  }
}
```

데이터베이스가 여러 개인 환경에서는 두 번째 인자로 연결 이름을 넘깁니다.

```typescript
@InjectRepository(Event, "analytics")
private readonly eventRepo: BaseRepository<Event>,
```

EntityManager를 직접 주입해도 됩니다.

```typescript
import { InjectEntityManager } from "@stingerloom/orm/nestjs";

@Injectable()
export class StatsService {
  constructor(
    @InjectEntityManager() private readonly em: EntityManager,
    // Named connection: @InjectEntityManager("analytics")
  ) {}
}
```

NestJS 통합의 전체 가이드는 [NestJS Module Setup](./nestjs.md)을 참고하세요.

---

## 드라이버 접근 -- getDriver()

저수준 작업이 필요하면 내부 SQL 드라이버에 접근합니다.

```typescript
const driver = em.getDriver();

if (driver) {
  // 드라이버별 기능에 직접 접근
  const tables = await driver.getTables();
  console.log(tables);
}
```

드라이버는 `ISqlDriver` 인터페이스를 구현합니다. 주로 스키마 조회나 직접 DDL 작업에 씁니다. `register()`를 아직 호출하지 않았으면 `getDriver()`는 `undefined`를 반환합니다.

---

## 쿼리 진단

### 왜 쿼리 진단이 필요한가요?

애플리케이션이 느려지면 원인은 거의 항상 데이터베이스 계층에 있습니다. 하지만 어떤 쿼리가 느릴까요? 같은 쿼리를 실수로 수백 번 실행하는 N+1 문제는 없을까요? 어떤 SQL이 실행되는지 보이지 않으면 눈을 감고 디버깅하는 셈입니다.

쿼리 진단은 이 부분을 보여 줍니다. 쿼리 진단을 쓰면 모든 쿼리를 로그로 남기고 N+1 패턴을 자동으로 감지할 수 있습니다. 쿼리가 시간 임계값을 넘으면 경고도 받을 수 있습니다.

### getQueryLog()

쿼리 트래커의 로그를 반환합니다. 로그는 최근 쿼리의 배열이고 각 항목에는 엔티티 이름, SQL 텍스트, 소요 시간이 들어 있습니다.

```typescript
const log = em.getQueryLog();
for (const entry of log) {
  console.log(`[${entry.entityName}] ${entry.sql} (${entry.durationMs}ms)`);
}
```

다음과 같은 경우에 유용합니다.
- **디버깅**: "방금 API 호출에서 실제로 어떤 SQL이 실행됐을까?"
- **성능 모니터링**: "어떤 쿼리가 가장 오래 걸릴까?"
- **테스트 검증**: "이 서비스 호출이 예상한 쿼리 수를 실행했을까?"

::: info
쿼리 로깅을 쓰려면 `register()`에 `logging` 옵션이 있어야 합니다. 이 옵션이 없으면 `getQueryLog()`는 빈 배열을 반환합니다.
:::

```typescript
await em.register({
  // ...
  logging: {
    queries: true,       // SQL을 콘솔에 로깅
    slowQueryMs: 500,    // 500ms를 넘는 쿼리에 경고
    nPlusOne: true,      // N+1 쿼리 패턴 감지
  },
});
```

### getQueryTracker()

`QueryTracker` 인스턴스를 반환합니다. 추적이 꺼져 있으면 `null`을 반환합니다. 테스트나 진단 코드에서 쿼리 통계를 프로그래밍 방식으로 읽을 때 유용합니다.

```typescript
const tracker = em.getQueryTracker();
if (tracker) {
  console.log("Active queries:", tracker.activeQueryCount);
}
```

로깅과 진단의 전체 가이드는 [Logging & Diagnostics](./logging.md)를 참고하세요.

---

## 종료 -- propagateShutdown()

### 왜 명시적 종료가 필요한가요?

Node.js 프로세스는 개별 요청보다 오래 남는 리소스를 들고 있을 수 있습니다. 연결 풀, 이벤트 리스너, 구독자 참조, 플러그인 상태, 쿼리 트래커 버퍼가 그 예입니다. 정리하지 않고 프로세스를 그냥 멈추면 다음 문제가 생길 수 있습니다.

- **연결 풀 누수**: 데이터베이스는 버려진 연결도 `max_connections` 한도에 셉니다.
- **미완료 트랜잭션**: 진행 중인 쿼리가 잠금을 쥔 채로 남거나 트랜잭션을 열어 둔 채로 남을 수 있습니다.
- **메모리 누수**: 이전 EntityManager를 종료하지 않고 새로 생성하면 리스너와 구독자가 쌓입니다. 핫 리로드로 개발할 때 흔한 일입니다.

`propagateShutdown()`은 이런 리소스를 올바른 순서로 정리합니다.

### 기본 사용법

```typescript
await em.propagateShutdown();
```

### 옵션

```typescript
const allCompleted = await em.propagateShutdown({
  gracefulTimeoutMs: 5000,  // 활성 쿼리가 끝날 때까지 최대 5초 대기
  closeConnections: true,   // 데이터베이스 연결 풀도 닫기
});

if (!allCompleted) {
  console.warn("Some queries were still running when shutdown was forced");
}
```

| 옵션 | 타입 | 기본값 | 설명 |
|-----|------|-------|-----|
| `gracefulTimeoutMs` | `number` | `0` | 진행 중인 쿼리 대기 최대 시간 (ms). `0` = 대기하지 않음. |
| `closeConnections` | `boolean` | `false` | 연결 풀을 닫을지 여부. |

반환값은 `boolean`입니다. 모든 활성 쿼리가 타임아웃 안에 끝나면 `true`를 반환하고 종료를 강제했으면 `false`를 반환합니다.

### 종료 순서

내부에서는 다음 순서로 진행됩니다.

1. **활성 쿼리 대기**(`gracefulTimeoutMs > 0`일 때): 실행 중인 쿼리가 있으면 지정한 타임아웃까지 기다립니다.
2. **플러그인 종료**(설치 역순, LIFO): A, B, C 순서로 설치했다면 C, B, A 순서로 종료됩니다. 그래서 의존성이 지켜집니다. 다른 플러그인에 의존하는 플러그인은 의존 대상보다 먼저 종료됩니다.
3. **이벤트 리스너, 구독자, dirty entity 추적 정리**: 등록된 모든 `on()` 리스너와 구독자 인스턴스를 제거해서 메모리 누수를 막습니다.
4. **쿼리 트래커 초기화**: 쌓인 쿼리 로그와 통계를 비웁니다.
5. **복제 라우터 종료**: 읽기 레플리카의 헬스 체크를 멈추고 레플리카 연결 풀을 닫습니다.
6. **연결 풀 종료**(`closeConnections: true`일 때): 풀의 모든 데이터베이스 연결을 닫습니다.

### 실전 NestJS 시나리오

NestJS 애플리케이션에서는 보통 `OnModuleDestroy` 생명주기 훅에서 `propagateShutdown()`을 호출합니다. 그러면 NestJS가 종료될 때 ORM이 모든 리소스를 해제합니다. 종료 원인이 Kubernetes의 SIGTERM이든 배포나 테스트 정리든 마찬가지입니다.

```typescript
import { OnModuleDestroy, Injectable } from "@nestjs/common";
import { InjectEntityManager } from "@stingerloom/orm/nestjs";
import { EntityManager } from "@stingerloom/orm";

@Injectable()
export class AppService implements OnModuleDestroy {
  constructor(
    @InjectEntityManager() private readonly em: EntityManager,
  ) {}

  async onModuleDestroy() {
    // 쿼리가 끝날 때까지 최대 10초 기다린 뒤 모두 닫기
    const clean = await em.propagateShutdown({
      gracefulTimeoutMs: 10_000,
      closeConnections: true,
    });

    if (!clean) {
      console.warn("ORM shutdown was forced -- some queries may not have completed");
    }
  }
}
```

Kubernetes 환경에서는 다음 순서로 진행됩니다.

```
1. Kubernetes가 pod에 SIGTERM 전송
2. NestJS가 SIGTERM을 받고 모듈 종료 시작
3. onModuleDestroy() 실행
4. propagateShutdown() 시작:
   - 3개 활성 쿼리가 끝날 때까지 최대 10초 대기 (2초 만에 완료)
   - buffer 플러그인 종료
   - 5개 이벤트 리스너와 2개 구독자 정리
   - 쿼리 트래커 초기화
   - 연결 풀 종료 (연결 10개 해제)
5. true 반환 (모든 쿼리 완료)
6. NestJS 종료 완료
7. 프로세스 정상 종료
```

---

## 배치 스트리밍 -- streamBatch()

`stream()`은 엔티티를 하나씩 yield합니다. 하지만 데이터를 배치 단위로 처리해야 할 때도 있습니다. 다른 시스템에 500개씩 벌크로 삽입하는 경우가 그 예입니다. `streamBatch()`는 개별 항목이 아니라 엔티티 배열을 yield합니다.

```typescript
for await (const batch of em.streamBatch(User, { where: { isActive: true } }, 500)) {
  // batch는 최대 500개짜리 User[]
  await bulkIndex(batch);
  console.log(`Indexed ${batch.length} users`);
}
```

반복마다 배치 하나를 yield합니다(최대 `batchSize`개의 엔티티). 마지막 배치는 더 작을 수 있습니다. 내부에서는 `stream()`과 같이 LIMIT/OFFSET 페이지네이션을 씁니다.

```typescript
// 리포지토리에서도 같은 방식으로 사용
const userRepo = em.getRepository(User);
for await (const batch of userRepo.streamBatch({ where: { role: "admin" } }, 1000)) {
  await sendBulkEmail(batch);
}
```

`streamBatch()`는 `find()`와 같은 `FindOption`을 받습니다. `where`, `orderBy`, `relations`, `select` 등을 넘길 수 있습니다.

---

## 쿼리 미리 만들어두기 -- `em.compile()` / `qb.prepare()`

### 왜 쿼리를 미리 만들어 둬야 할까요?

`em.find()`, `em.save()`, 쿼리 빌더의 실행 메서드는 모두 데이터베이스에 쿼리를 보내기 전에 항상 같은 단계를 거칩니다.

1. 엔티티의 메타데이터를 찾습니다(관계, 컬럼, 상속 정보 등).
2. 네이밍 전략에 따라 속성 이름을 컬럼 이름으로 바꿉니다.
3. 드라이버에 맞춰 식별자를 이스케이프(escape)합니다.
4. `sql` 태그로 만든 SQL 조각을 끼워 넣고 중첩된 `Sql` 객체를 펼칩니다. 그리고 최종 SQL 문자열을 만듭니다.
5. 완성된 SQL을 드라이버에 넘깁니다.

한 번만 호출한다면 이 비용은 신경 쓰지 않아도 됩니다. 그런데 같은 모양의 쿼리가 수만 번 반복되면 이야기가 달라집니다. 반복이 많은 작업에서는 1~4번 과정이 드러나지 않게 CPU 시간을 꽤 차지합니다. 백그라운드 워커의 반복문, 대량 배치 작업 안에서 한 행씩 조회하는 코드, 주기적인 지표 수집 루프가 그 예입니다. 이때 병목은 네트워크 라운드 트립이 아닙니다. Node.js 프로세스 안에서 SQL을 만드는 일이 병목입니다.

미리 만들어 둔 쿼리는 이 과정을 한 번만 거치고 결과를 그대로 보관합니다. 이후 실행에서는 값 자리만 채우고 이미 만들어 둔 `Sql`을 그대로 드라이버로 보냅니다.

::: info Prepared Statement와는 달라요
Stingerloom의 컴파일 쿼리는 ORM 계층에서 결과를 기억해 두는 방식입니다. SQL 문자열과 값이 들어갈 자리를 JavaScript 쪽에 저장해 둘 뿐입니다. 드라이버는 평소처럼 매번 쿼리를 데이터베이스로 보냅니다. 데이터베이스 서버에서 `PREPARE`를 걸어 두는 기능이 아닙니다. 네이티브 prepared statement는 별도의 최적화이고 이후에 추가할 예정입니다.
:::

### 언제 효과가 있고, 언제 없을까요?

`compile()`을 쓰기 전에 데이터베이스 호출 자체를 피할 수 있는지부터 살펴보세요. Stingerloom에는 흔한 패턴에 쓸 더 저렴한 방법이 이미 있습니다.

| 상황 | 먼저 살펴볼 방법 |
|------|-----------------|
| 같은 트랜잭션 안에서 같은 행을 여러 번 조회 | [WriteBuffer](./write-buffer.md): 기본 키 캐시에 있으면 데이터베이스에 가지 않음 |
| 많은 INSERT/UPDATE를 한꺼번에 처리 | [`batchInsert()` / `batchUpsert()`](./entity-manager-writes.md): 한 번의 호출로 묶음 |
| 큰 결과를 한 행씩 꺼내며 처리 | [`stream()` / `streamBatch()`](#배치-스트리밍-streambatch): 커서 형태의 쿼리 하나로 처리 |
| 집계 연산 | [RawQueryBuilder](./raw-sql.md)의 GROUP BY / 윈도 함수: 계산을 데이터베이스에 맡김 |

미리 만들어 둔 쿼리는 SQL 호출을 피할 수 없고 쿼리 모양은 그대로인데 값만 바뀔 때 효과를 냅니다. 잘 맞는 예는 다음과 같습니다.

- 인증 미들웨어에서 요청마다 실행하는 사용자 조회(`WHERE id = ?`)
- 사용자 입력을 한 줄씩 검증하는 반복문(`WHERE email = ?`)
- 여러 테넌트나 여러 시간 윈도를 돌면서 같은 쿼리를 계속 실행하는 스케줄러
- CPU 프로파일에서 `em.find()`나 쿼리 빌더가 상위에 나타나는 코드

반대로 호출할 때마다 쿼리 모양이 바뀌면 효과가 없습니다. 조건이 붙었다 빠졌다 하는 동적 WHERE가 그 예입니다. 이때는 빌더가 평소처럼 매번 쿼리를 만들게 두세요.

### SelectQueryBuilder.prepare()

가장 쉬운 시작점입니다. 실행할 때 들어올 값 자리를 `p("이름")`로 표시해 둡니다. 그리고 `.prepare()`로 빌더의 현재 상태를 고정합니다.

```typescript
import { p } from "@stingerloom/orm";
import sql from "sql-template-tag";

const findUserById = em
  .createQueryBuilder(User, "u")
  .where(sql`u.id = ${p("id")}`)
  .prepare<{ id: number }>();

await findUserById.executeOne({ id: 42 });
await findUserById.executeOne({ id: 77 });   // SQL을 다시 만들지 않음
await findUserById.executeOne({ id: 81 });
```

`prepare()`는 `CompiledQuery<T, P>`를 반환합니다. 빌더 자체는 계속 수정할 수 있습니다. 하지만 이미 만든 컴파일 쿼리는 빌더와 분리되어 있습니다. 그래서 이후에 빌더에 `.where()`나 `.limit()`을 추가해도 영향을 받지 않습니다.

```typescript
const compiled = qb.prepare();
const savedSql = compiled.sql;

qb.where("u.id", 99);
qb.limit(5);

compiled.sql === savedSql;   // true: 컴파일한 시점의 모양을 그대로 유지
```

결과 행은 평소처럼 엔티티 변환 과정을 거칩니다. 그래서 `execute()`는 클래스 인스턴스를 반환합니다. `instanceof User`도 잘 동작합니다. 생명주기 훅과 구독자도 실제 엔티티 타입을 봅니다. 결과를 그대로 `em.save()`에 다시 넘겨도 됩니다.

클래스로 변환하지 않고 선택한 컬럼만 타입에 맞춰 받으려면 `preparePartial()`을 쓰세요.

```typescript
const listEmails = em
  .createQueryBuilder(User, "u")
  .select(["id", "email"])
  .where(sql`u.isActive = ${p("active")}`)
  .preparePartial<{ active: boolean }>();

const rows = await listEmails.execute({ active: true });
// rows: Pick<User, "id" | "email">[] (일반 객체 배열)
```

### RawQueryBuilder.prepare()

`RawQueryBuilder`는 UNION, CTE, 윈도 함수처럼 `SelectQueryBuilder`로 직접 표현하기 어려운 SQL을 맡습니다. 이 빌더도 같은 방식으로 미리 만들어 둘 수 있습니다. 다만 결과를 raw 행으로 반환하는 경로이므로 실행에 쓸 `EntityManager`를 인자로 직접 넘겨야 합니다.

```typescript
const topSpenders = em
  .createQueryBuilder()
  .select(["user_id", "SUM(amount) AS total"])
  .from("orders")
  .where([sql`created_at >= ${p("since")}`])
  .groupBy(["user_id"])
  .having([sql`SUM(amount) >= ${p("threshold")}`])
  .prepare<{ user_id: number; total: number }, { since: Date; threshold: number }>(em);

const lastMonth = await topSpenders.execute({
  since: new Date("2026-03-01"),
  threshold: 500,
});

const lastWeek = await topSpenders.execute({
  since: new Date("2026-04-05"),
  threshold: 200,
});
```

행은 일반 객체로 반환됩니다. 이 경로에서는 엔티티 클래스로 변환하지 않습니다. `em.query()`와 똑같이 동작합니다.

### `em.compile()` -- 타입까지 친절한 방식

`p("id")`로 플레이스홀더 이름을 하나하나 적지 않는 방식도 있습니다. compile 호출에서 파라미터 타입을 먼저 선언합니다. 그러면 콜백은 프록시 `$`를 받고 이 프록시의 속성에 접근하면 플레이스홀더가 만들어집니다.

```typescript
const findByEmail = em.compile<User, { email: string }>((em, $) =>
  em.createQueryBuilder(User, "u").where(sql`u.email = ${$.email}`),
);

await findByEmail.executeOne({ email: "alice@example.com" });
await findByEmail.executeOne({ email: "bob@example.com" });
```

`.prepare()`를 직접 호출하는 방식보다 나은 점은 다음과 같습니다.

- 파라미터 타입 `P`를 compile 제네릭에 한 번만 선언하면 모든 `execute()` 호출에 그대로 적용됩니다. 그래서 키 이름을 잘못 적으면 컴파일 시점에 에러가 납니다.
- 플레이스홀더 이름은 `$.email`처럼 속성 접근에서 만들어집니다. 그래서 리팩터링으로 이름을 바꿔도 타입 체크에서 바로 잡힙니다.
- 콜백이 독립적이라서 다른 곳으로 옮기기 쉽습니다. 캐시에 담아 두거나 모듈 상단에 상수로 두어도 됩니다. 리포지토리 클래스에서 내보내도 됩니다.

콜백은 `.prepare()`를 제공하는 빌더를 반환해야 합니다. `SelectQueryBuilder`와 `RawQueryBuilder`가 모두 됩니다.

```typescript
const recentPostsByAuthor = em.compile<Post, { authorId: number }>((em, $) =>
  em
    .createQueryBuilder(Post, "p")
    .where(sql`p.authorId = ${$.authorId}`)
    .orderBy({ createdAt: "DESC" })
    .limit(10),
);
```

콜백이 컴파일할 수 없는 값을 반환하면 `em.compile()`이 그 자리에서 `OrmError`를 던집니다. 나중에 실행할 때 아무 표시 없이 실패하는 일은 없습니다.

### 실행 메서드

컴파일된 쿼리에는 실행 메서드가 세 가지 있습니다.

| 메서드 | 반환값 | 쓰는 경우 |
|--------|-------|-----------|
| `execute(params)` | `T[]` (엔티티 변환이 붙어 있으면 클래스 인스턴스 배열) | 여러 행이 필요할 때 |
| `executeOne(params)` | `T \| null` | 최대 한 행만 기대할 때. 필요하면 쿼리에 `LIMIT 1`을 직접 넣으세요 |
| `executeRaw(params)` | `unknown[]` | 엔티티 변환 없이 드라이버가 반환한 행을 그대로 받을 때 |

`params`를 생략할 수 있는 것은 플레이스홀더가 하나도 없는 쿼리뿐입니다. 플레이스홀더가 있는데 값을 빠뜨리면 ORM은 쿼리를 실행하기 전에 `MISSING_PLACEHOLDER` 코드의 `OrmError`를 던집니다.

```typescript
await findUserById.execute({});            // 에러: "id" 값이 필요함
await findUserById.execute({ id: 1 });     // 정상
```

실행하지 않고도 컴파일 결과를 확인할 수 있습니다.

```typescript
compiled.sql;              // "SELECT ... WHERE u.id = ?" (드라이버에 상관없는 공통 형태)
compiled.parameterNames;   // readonly ["id"]
```

### 권장 사용법

- **한 번 만들고 계속 재사용하세요.** 컴파일 쿼리는 모듈 상단의 상수나 서비스의 필드에 담아 두세요. 요청마다 다시 만들면 미리 만들어 둔 의미가 없습니다.
- **쿼리 모양을 고정하세요.** 선택적인 조건이나 선택적인 ORDER BY 때문에 쿼리 모양이 바뀐다면 한 쿼리에 분기를 억지로 넣지 마세요. 용도별로 컴파일 쿼리를 여러 개 만들어 두는 편이 더 깔끔합니다.
- **파라미터 타입의 도움을 받으려면 `em.compile()`을 쓰세요.** 반대로 주변 코드가 빌더를 동적으로 조립한다면 `qb.prepare()`가 더 잘 맞습니다.
- **적용 전후로 측정하세요.** 컴파일 자체는 가볍고 안전합니다. 하지만 효과는 SQL을 만드는 데 실제로 시간이 얼마나 쓰였는지에 따라 달라집니다. [`getQueryLog()`](#쿼리-진단)나 별도 프로파일러로 실제로 빨라졌는지 확인하세요.

---

## 엔티티 메타데이터 API

메타데이터 API는 런타임에 엔티티 스키마 정보를 읽기 전용으로 제공합니다. 어드민 패널을 만들거나 문서를 자동으로 생성할 때 유용합니다. 범용 CRUD 컴포넌트를 작성할 때도 유용합니다.

### getEntityMetadata()

엔티티 클래스의 전체 메타데이터를 반환합니다. 여기에는 테이블 이름, 컬럼, 관계, 인덱스, 특수 컬럼 정보가 들어 있습니다.

```typescript
const meta = em.getEntityMetadata(User);
if (meta) {
  console.log(meta.tableName);     // "user"
  console.log(meta.columns);       // ColumnMetadataView[]
  console.log(meta.relations);     // RelationMetadataView[]
  console.log(meta.indexes);       // 인덱스 정의
  console.log(meta.deletedAtColumn);     // "deletedAt" 또는 undefined
  console.log(meta.versionColumn);       // "version" 또는 undefined
}
```

### getColumnMetadata()

컬럼 메타데이터만 반환합니다. 전체 엔티티 메타데이터의 부분 집합입니다.

```typescript
const columns = em.getColumnMetadata(User);
for (const col of columns) {
  console.log(`${col.propertyKey} -> ${col.columnName} (${col.type})`);
  // "name" -> "name" (varchar)
  // "email" -> "email" (varchar)
}
```

각 컬럼 항목에는 다음 필드가 있습니다.

| 필드 | 타입 | 설명 |
|------|------|------|
| `propertyKey` | `string` | 엔티티 속성 이름 |
| `columnName` | `string` | 데이터베이스 컬럼 이름 |
| `type` | `string` | 컬럼 타입 (varchar, int 등) |
| `nullable` | `boolean` | nullable 여부 |
| `primary` | `boolean` | 기본 키 여부 |
| `unique` | `boolean` | 고유 제약 조건 여부 |
| `default` | `any` | 기본값 (설정된 경우) |
| `length` | `number` | 컬럼 길이 (해당되는 경우) |

### getRelationMetadata()

엔티티의 관계 메타데이터를 반환합니다.

```typescript
const relations = em.getRelationMetadata(Post);
for (const rel of relations) {
  console.log(`${rel.propertyKey}: ${rel.type} -> ${rel.target.name}`);
  // "author": ManyToOne -> User
  // "tags": ManyToMany -> Tag
}
```

---

## FindOption 참조

`find()`, `findOne()`, `findAndCount()`, `findWithCursor()`, `stream()`, `explain()`이 받는 옵션은 다음과 같습니다.

| 옵션 | 타입 | 설명 |
|-----|------|-----|
| `where` | `WhereClause<T>` | WHERE 조건. 각 키-값 쌍이 AND 조건이 됩니다. |
| `select` | `readonly (keyof T)[]` 또는 `{ [K in keyof T]?: boolean }` | 선택할 컬럼. 생략하면 `SELECT *`. 관계의 컬럼은 `relations`의 해당 항목에 적은 `select`로 고릅니다. |
| `orderBy` | `Record<keyof T, "ASC" \| "DESC">` | 정렬 순서. 키가 여러 개면 다중 컬럼 정렬. |
| `limit` | `number` 또는 `[offset, count]` | 직접 LIMIT 지정. 페이지네이션에는 `skip`/`take` 권장. |
| `skip` | `number` | 페이지네이션 오프셋. `take`와 함께 사용. |
| `take` | `number` | 최대 반환 행 수. `skip`과 함께 사용. |
| `relations` | `(keyof T \| string)[]` 또는 `RelationsObject<T>` | 로드할 관계 속성. 점으로 이은 경로(`"comments.author"`)나 객체 형식(`{ comments: { relations: { author: true } } }`)을 쓰면 관련 엔티티의 관계까지 로드합니다. [중첩 관계](./relations.md#중첩-관계) 참고. 객체 형식에서 컬렉션 관계는 `where`, `orderBy`, 부모별 `take` / `skip`도 받습니다. 그리고 모든 관계에 개별 `withDeleted`와 `select`를 줄 수 있습니다. [관계 필터링, 정렬, 개수 제한](./relations.md#관계-필터링-정렬-개수-제한), [관계의 컬럼 고르기](./relations.md#관계의-컬럼-고르기) 참고. 어떤 관계와도 맞지 않는 이름을 넘기면 유효한 관계 목록과 함께 `InvalidQueryError`를 던집니다. 중첩 단계에서는 경로도 함께 알려 줍니다. |
| `withCount` | `WithCountOption<T>` | 컬렉션 관계의 행 개수를 세어 엔티티마다 써 넣습니다. `{ commentCount: "comments" }`처럼 씁니다. 일부만 세려면 `{ approvedCount: { relation: "comments", where: { approved: true } } }`처럼 씁니다. 개수 하나마다 배치 SQL 문 하나를 실행합니다. 관련 행이 없으면 개수는 0입니다. [관련 행 개수 세기](./relations.md#관련-행-개수-세기-withcount) 참고. |
| `withDeleted` | `boolean` | 소프트 삭제된 엔티티(`@DeletedAt`) 포함 여부. 기본값: `false`. |
| `groupBy` | `(keyof T)[]` | GROUP BY 컬럼. |
| `having` | `Sql[]` | HAVING 조건 (sql-template-tag). AND로 결합. |
| `timeout` | `number` | 쿼리별 타임아웃 (ms). 연결 수준 `queryTimeout`을 오버라이드. |
| `distinct` | `boolean` | `SELECT DISTINCT` 생성. 기본값: `false`. |
| `useMaster` | `boolean` | 복제 환경에서 읽기를 마스터 노드로 강제. 기본값: `false`. |
| `lock` | `LockMode` | 비관적 잠금. 아래 LockMode 값 참고. |

### LockMode 값

| LockMode | SQL | 설명 |
|----------|-----|------|
| `PESSIMISTIC_WRITE` | `FOR UPDATE` | 배타 잠금(exclusive lock): 읽기/쓰기 모두 차단 |
| `PESSIMISTIC_READ` | `FOR SHARE` | 공유 잠금(shared lock): 쓰기만 차단 |
| `PESSIMISTIC_WRITE_NOWAIT` | `FOR UPDATE NOWAIT` | 행이 잠겨 있으면 즉시 실패 |
| `PESSIMISTIC_READ_NOWAIT` | `FOR SHARE NOWAIT` | 공유 잠금. 행이 잠겨 있으면 즉시 실패 |
| `PESSIMISTIC_WRITE_SKIP_LOCKED` | `FOR UPDATE SKIP LOCKED` | 다른 트랜잭션이 잠근 행을 건너뜀 |
| `PESSIMISTIC_READ_SKIP_LOCKED` | `FOR SHARE SKIP LOCKED` | 공유 잠금. 잠긴 행을 건너뜀 |

NOWAIT과 SKIP LOCKED는 MySQL 8.0 이상, MariaDB 10.6 이상, PostgreSQL 9.5 이상이 필요합니다. SQLite는 비관적 잠금을 지원하지 않습니다.

공유 잠금은 서버마다 표기가 다릅니다. `PESSIMISTIC_READ`는 MySQL과 MariaDB에서 `LOCK IN SHARE MODE`입니다. NOWAIT / SKIP LOCKED 변형은 MySQL 8에서 `FOR SHARE ...`가 됩니다. MariaDB에는 `FOR SHARE`가 없으므로 `LOCK IN SHARE MODE ...`가 됩니다. MariaDB인지는 `type: "mariadb"`나 서버 버전으로 판별합니다.

---

## 다음 단계

- [CRUD 기초](./entity-manager.md): save, find, delete, 소프트 삭제
- [쿼리 & 페이지네이션](./entity-manager-querying.md): SELECT, 페이지네이션, 스트리밍, 집계
- [쓰기 & 트랜잭션](./entity-manager-writes.md): 배치 작업, upsert, 트랜잭션, raw SQL
- [Query Builder](./query-builder.md): 타입 안전한 fluent 쿼리
- [Events & Subscribers](./events.md): 엔티티 생명주기 이벤트와 감사 패턴
- [Plugin System](./plugins.md): 플러그인 작성과 사용
- [Multi-Tenancy](./multi-tenancy.md): 테넌트 프로비저닝과 스키마 격리
- [Configuration](./configuration.md): 풀링, 타임아웃, 복제, 로깅
