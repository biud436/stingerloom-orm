# EntityManager -- 고급 기능

이 페이지에서는 EntityManager의 고급 기능을 다뤄요: 이벤트 리스너, 엔티티 구독자, 멀티테넌시, 플러그인, 쿼리 진단, 리포지토리 패턴, 그리고 안전한 종료까지.

기본 CRUD는 [CRUD 기초](./entity-manager.md)를, 쿼리는 [쿼리 & 페이지네이션](./entity-manager-querying.md)을, 배치 쓰기와 트랜잭션은 [쓰기 & 트랜잭션](./entity-manager-writes.md)을 참고해 주세요.

---

## Event Listeners

### 왜 이벤트가 필요한가요?

`save()`, `delete()`, `softDelete()` 같은 호출은 데이터베이스의 데이터를 변경해요. 이런 변경에 반응해야 할 때가 있는데, CRUD 로직 안이 아니라 분리된 별도 코드에서 처리하고 싶은 경우가 많아요. 대표적인 예시:

- **감사 로깅**: 누가 무엇을 언제 변경했는지 기록해요.
- **캐시 무효화**: 데이터가 바뀌면 Redis 캐시를 비워요.
- **분석**: 새 사용자가 생성될 때마다 트래킹 이벤트를 보내요.
- **알림**: 주문이 완료되면 웹훅이나 이메일을 발송해요.

이런 로직을 서비스 코드에 직접 넣을 수도 있지만, 그러면 사용자를 생성하는 모든 서비스가 로깅, 캐시 무효화, 분석 전송을 각각 기억해야 돼요. 이벤트를 쓰면 한 곳에 한 번만 작성하고, 데이터 변경이 어디서 발생하든 자동으로 실행돼요.

### 이벤트 vs. 라이프사이클 훅, 언제 뭘 쓸까요?

- **라이프사이클 훅** (`@BeforeInsert`, `@AfterUpdate` 등)은 **엔티티 클래스 자체**에 정의돼요. 엔티티와 강하게 결합되어 있고, save/delete 파이프라인의 일부로 실행돼요. "INSERT 전에 비밀번호 해싱" 같은 엔티티 내부 로직에 사용하세요.

- **이벤트 리스너**는 **EntityManager**에 정의돼요. 엔티티와 분리되어 있고 모든 엔티티 타입을 한꺼번에 관찰할 수 있어요. "모든 DB 쓰기를 감사 테이블에 기록" 같은 횡단 관심사에 사용하세요.

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

리스너가 받는 객체에는 다음이 포함돼요:
- `entity` -- 엔티티 클래스 (생성자 함수)
- `data` -- INSERT/UPDATE/DELETE 되는 엔티티 데이터

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
이벤트 리스너는 **모든 엔티티**에 대해 발생해요. 특정 엔티티 클래스에만 적용되는 리스너가 필요하면, 아래의 Entity Subscribers를 사용하세요.
:::

---

## Entity Subscribers

### 이벤트가 있는데 왜 구독자가 필요한가요?

이벤트 리스너는 모든 엔티티 타입에 대해 발생해요. `afterInsert` 리스너를 등록하면 User, Post, Order 등 모든 엔티티 생성 시 실행돼요. 어떤 엔티티가 트리거했는지 리스너 코드에서 직접 확인해야 하죠.

구독자는 **특정 엔티티 클래스**에 바인딩돼요. `UserSubscriber`는 `User` 이벤트에만 반응하고, `Post`나 `Order`에는 절대 반응하지 않아요.

건물 전체를 감시하는 보안 카메라(이벤트)와 금고만 감시하는 카메라(구독자)의 차이라고 생각하면 돼요.

### 구독자 vs. 글로벌 이벤트, 언제 뭘 쓸까요?

| 사용 사례 | 권장 방식 |
|----------|----------|
| 모든 DB 쓰기를 감사 테이블에 기록 | 글로벌 이벤트 리스너 |
| 데이터 변경 시 모든 캐시 무효화 | 글로벌 이벤트 리스너 |
| User 생성 시 환영 이메일 발송 | Entity subscriber (UserSubscriber) |
| Post 변경 시 검색 인덱스 업데이트 | Entity subscriber (PostSubscriber) |
| OrderItem 변경 시 주문 합계 재계산 | Entity subscriber (OrderItemSubscriber) |

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
    console.log("User deleted:", event.entity);
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

구독자는 이벤트 리스너와 동일한 라이프사이클 메서드를 지원해요: `beforeInsert`, `afterInsert`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`. 필요한 것만 구현하면 돼요.

이벤트 패턴에 대한 자세한 가이드는 [Events & Subscribers](./events.md)를 참고해 주세요.

---

## 멀티테넌시 -- withTenant()

### 왜 멀티테넌시가 필요한가요?

멀티테넌시는 하나의 애플리케이션에서 여러 고객(테넌트)을 서비스하면서, 각 테넌트의 데이터를 서로 격리하는 거예요. 아파트 건물을 생각해 보세요: 건물 인프라는 공유하지만, 각 세대는 잠긴 자기만의 공간이에요.

ORM 수준의 솔루션이 없으면 모든 쿼리에 수동으로 테넌트 스키마를 붙이고, search path를 관리하고, 쿼리가 테넌트 경계를 넘지 않는지 확인해야 돼요. `withTenant()`가 이 모든 걸 자동으로 처리해 줘요.

### 동작 방식

`withTenant()`는 특정 테넌트 컨텍스트에서 콜백을 실행해요. 콜백 안의 모든 EntityManager 동작이 자동으로 해당 테넌트의 스키마/데이터로 범위가 지정돼요.

```typescript
const result = await em.withTenant("tenant_acme", async (tenantEm) => {
  // 여기 안의 모든 쿼리는 "tenant_acme" 스키마를 대상으로 해요
  const users = await tenantEm.find(User);
  return users;
});
```

내부적으로 `withTenant()`는 `MetadataContext.run()`과 `AsyncLocalStorage`를 사용해서 테넌트 컨텍스트를 격리해요. 동시 요청 핸들러에서도 안전하게 사용할 수 있어요 -- 같은 Node.js 프로세스에서 실행되더라도 각 HTTP 요청이 자체 격리된 컨텍스트를 가져요.

### SQL 차이: 두 가지 전략

`register()`의 `tenantStrategy` 설정에 따라 동작이 달라져요:

#### 전략 1: search_path (기본값)

`search_path` 전략은 쿼리 실행 전에 트랜잭션 안에서 PostgreSQL search path를 설정해요:

```sql
-- 테넌트 읽기당 5 라운드트립:
BEGIN
SET LOCAL search_path = 'tenant_acme'
SELECT "id", "name", "email" FROM "user" WHERE "isActive" = $1
COMMIT
-- (+ 연결 획득/반환)
```

`SET LOCAL`은 search path를 현재 트랜잭션에만 적용해요. 트랜잭션이 끝나면 원래대로 돌아가요. 안전하지만 단순 읽기에도 트랜잭션 래핑이 필요해요.

| 전략 | 동작 | 트레이드오프 |
|-----|------|------------|
| `"search_path"` (기본값) | 트랜잭션 안에서 `SET LOCAL search_path = 'tenant_acme'` | 모든 경우에 안전하지만, 읽기당 5 라운드트립 |

#### 전략 2: schema_qualified

`schema_qualified` 전략은 SQL에서 테이블명에 직접 스키마를 붙여서, 트랜잭션이 필요 없어요:

```sql
-- 1 라운드트립:
SELECT "id", "name", "email" FROM "tenant_acme"."user" WHERE "isActive" = $1
```

| 전략 | 동작 | 트레이드오프 |
|-----|------|------------|
| `"schema_qualified"` | 쿼리에 `"tenant_acme"."users"` 형식 사용 | 라운드트립 1회, 하지만 모든 쿼리가 스키마를 인식해야 함 |

활성화 방법:

```typescript
await em.register({
  type: "postgres",
  // ...
  tenantStrategy: "schema_qualified",
});
```

`schema_qualified` 전략이 더 빠르지만(1 vs 5 라운드트립), `search_path`가 기본값인 이유는 모든 PostgreSQL 기능(함수, 트리거, 확장 등)과 문제 없이 동작하기 때문이에요.

멀티테넌시 설정 전체 가이드(테넌트 프로비저닝, 스키마 마이그레이션)는 [Multi-Tenancy](./multi-tenancy.md)를 참고해 주세요.

---

## 플러그인 시스템 -- extend()

### 왜 플러그인이 필요한가요?

ORM이 성장하면 팀마다 다른 기능을 원해요: 쓰기 버퍼링, 감사 추적, soft-delete 오버라이드, 커스텀 캐싱 등. 이걸 전부 코어에 넣으면 EntityManager가 거대해지고, 쓰지 않는 기능의 비용까지 모든 사용자가 부담하게 돼요.

플러그인은 필요한 기능만 선택적으로 추가할 수 있게 해줘요. 코어는 가볍게 유지되고, 필요한 것만 더하면 돼요.

### 플러그인 설치

`extend()`로 플러그인을 설치해요:

```typescript
import { bufferPlugin } from "@stingerloom/orm";

const em = new EntityManager();
await em.register({ /* ... */ });

// 플러그인 설치 -- 새 메서드가 `em`에 믹스인돼요
em.extend(bufferPlugin());
```

`register()`에서 선언적으로 설치할 수도 있어요:

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

// 플러그인 API 객체 가져오기
const api = em.getPluginApi<BufferApi>("buffer");
```

### 멱등성과 의존성

- 같은 플러그인을 두 번 설치해도 **무시돼요** (안전하게 여러 번 호출 가능).
- 플러그인은 의존성을 선언할 수 있어요. 의존성이 설치되지 않았으면 `extend()`가 `OrmError`를 던져요 (코드: `PLUGIN_DEPENDENCY_MISSING`).
- 플러그인 메서드 이름이 기존 EntityManager 멤버와 충돌하면 `OrmError`를 던져요 (코드: `PLUGIN_CONFLICT`).

플러그인 작성 가이드와 내장 플러그인 목록은 [Plugin System](./plugins.md)을 참고해 주세요.

---

## Query Builder -- createQueryBuilder()

EntityManager는 `find()`를 넘어서는 복잡한 쿼리를 위해 두 가지 쿼리 빌더를 제공해요.

### SelectQueryBuilder (타입 안전)

엔티티 클래스와 별칭을 전달해서 생성해요. 타입 안전한 컬럼 참조와 좁혀진 반환 타입을 제공해요.

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

인자 없이 생성해요. 타입 제약 없이 완전한 SQL 제어가 가능해요.

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

전체 가이드(JOIN, UNION, CTE, window functions, subqueries, validation)는 [Query Builder](./query-builder.md)를 참고해 주세요.

---

## Repository 패턴 -- getRepository()

매번 엔티티 클래스를 메서드에 전달하는 대신, 엔티티별로 CRUD를 캡슐화하고 싶다면 리포지토리를 사용하세요.

```typescript
const userRepo = em.getRepository(User);

const users = await userRepo.find();
const user = await userRepo.findOne({ where: { id: 1 } });
await userRepo.save({ name: "Alice" });
await userRepo.delete({ id: 1 });
```

리포지토리는 동일한 EntityManager 메서드를 래핑하되, 특정 엔티티 클래스에 미리 바인딩되어 있어요.

### NestJS 주입

NestJS에서는 `@InjectRepository()`로 서비스에 리포지토리를 주입해요:

```typescript
import { Injectable } from "@nestjs/common";
import { InjectRepository, BaseRepository } from "@stingerloom/orm/nestjs";
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

멀티 DB 환경에서는 두 번째 인자로 연결 이름을 전달해요:

```typescript
@InjectRepository(Event, "analytics")
private readonly eventRepo: BaseRepository<Event>,
```

EntityManager를 직접 주입할 수도 있어요:

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

NestJS 통합 가이드 전체는 [NestJS Module Setup](./nestjs.md)을 참고해 주세요.

---

## 드라이버 접근 -- getDriver()

저수준 작업을 위해 내부 SQL 드라이버에 접근할 수 있어요:

```typescript
const driver = em.getDriver();

if (driver) {
  // 드라이버별 기능에 직접 접근
  const tables = await driver.getTables();
  console.log(tables);
}
```

드라이버는 `ISqlDriver` 인터페이스를 구현해요. 주로 스키마 조회나 직접 DDL 작업에 사용돼요. `register()`가 아직 호출되지 않았으면 `undefined`를 반환해요.

---

## 쿼리 진단

### 왜 쿼리 진단이 필요한가요?

애플리케이션이 느려지면, 원인은 거의 항상 데이터베이스 계층에 있어요. 하지만 어떤 쿼리가 느린 걸까요? 같은 쿼리를 수백 번 실행하는 N+1 문제는 없을까요? 어떤 SQL이 실행되는지 보이지 않으면 눈 감고 디버깅하는 거예요.

쿼리 진단이 이런 가시성을 제공해요. 모든 쿼리를 로깅하고, N+1 패턴을 자동 감지하고, 쿼리가 시간 임계값을 초과하면 경고를 받을 수 있어요.

### getQueryLog()

쿼리 트래커의 로그를 반환해요 -- 엔티티 이름, SQL 텍스트, 소요 시간이 포함된 최근 쿼리 배열이에요.

```typescript
const log = em.getQueryLog();
for (const entry of log) {
  console.log(`[${entry.entityName}] ${entry.sql} (${entry.durationMs}ms)`);
}
```

활용 사례:
- **디버깅**: "방금 API 호출에서 실제로 어떤 SQL이 실행됐을까?"
- **성능 모니터링**: "어떤 쿼리가 가장 오래 걸릴까?"
- **테스트 검증**: "이 서비스 호출이 예상한 쿼리 수를 실행했을까?"

::: info
쿼리 로깅은 `register()`의 `logging` 옵션이 필요해요. 이 옵션 없이는 `getQueryLog()`가 빈 배열을 반환해요.
:::

```typescript
await em.register({
  // ...
  logging: {
    queries: true,       // SQL을 콘솔에 로깅
    slowQueryMs: 500,    // 500ms 초과 쿼리에 대해 경고
    nPlusOne: true,      // N+1 쿼리 패턴 감지
  },
});
```

### getQueryTracker()

`QueryTracker` 인스턴스를 반환해요 (추적이 비활성화되어 있으면 `null`). 테스트나 진단에서 쿼리 통계에 프로그래밍 방식으로 접근할 때 유용해요.

```typescript
const tracker = em.getQueryTracker();
if (tracker) {
  console.log("Active queries:", tracker.activeQueryCount);
}
```

전체 로깅 및 진단 가이드는 [Logging & Diagnostics](./logging.md)를 참고해 주세요.

---

## 종료 -- propagateShutdown()

### 왜 명시적 종료가 필요한가요?

Node.js 프로세스는 개별 요청보다 오래 유지되는 리소스를 보유할 수 있어요: 커넥션 풀, 이벤트 리스너, 구독자 참조, 플러그인 상태, 쿼리 트래커 버퍼 등. 정리 없이 프로세스를 그냥 멈추면 다음과 같은 문제가 생길 수 있어요:

- **커넥션 풀 누수**: 데이터베이스가 버려진 연결을 `max_connections` 한도에 포함시켜요.
- **미완료 트랜잭션**: 진행 중인 쿼리가 잠금을 유지하거나 트랜잭션을 열어둘 수 있어요.
- **메모리 누수**: EntityManager를 종료하지 않고 재생성하면(핫 리로드 개발에서 흔함) 리스너와 구독자가 누적돼요.

`propagateShutdown()`은 이런 리소스를 올바른 순서로 정리해요.

### 기본 사용법

```typescript
await em.propagateShutdown();
```

### 옵션

```typescript
const allCompleted = await em.propagateShutdown({
  gracefulTimeoutMs: 5000,  // 활성 쿼리가 끝날 때까지 최대 5초 대기
  closeConnections: true,   // DB 커넥션 풀도 닫기
});

if (!allCompleted) {
  console.warn("Some queries were still running when shutdown was forced");
}
```

| 옵션 | 타입 | 기본값 | 설명 |
|-----|------|-------|-----|
| `gracefulTimeoutMs` | `number` | `0` | 진행 중인 쿼리 대기 최대 시간 (ms). `0` = 대기하지 않음. |
| `closeConnections` | `boolean` | `false` | 커넥션 풀을 닫을지 여부. |

**반환값**: `boolean` -- 모든 활성 쿼리가 타임아웃 내에 완료되면 `true`, 강제 종료되면 `false`.

### 종료 순서

내부적으로 다음 순서로 진행돼요:

1. **활성 쿼리 대기** (`gracefulTimeoutMs > 0`일 때) -- 현재 실행 중인 쿼리가 있으면 지정된 타임아웃까지 대기해요.
2. **플러그인 종료** (설치 역순, LIFO) -- A, B, C 순서로 설치했다면 C, B, A 순서로 종료돼요. 의존성을 존중해요.
3. **이벤트 리스너, 구독자, dirty entity 추적 정리** -- 등록된 모든 `on()` 리스너와 구독자 인스턴스를 제거해서 메모리 누수를 방지해요.
4. **쿼리 트래커 초기화** -- 누적된 쿼리 로그와 통계를 지워요.
5. **Replication router 종료** -- Read replica 헬스 체크를 중지해요.
6. **커넥션 풀 종료** (`closeConnections: true`일 때) -- 풀의 모든 DB 연결을 종료해요.

### 실전 NestJS 시나리오

NestJS 애플리케이션에서는 보통 `OnModuleDestroy` 라이프사이클 훅에서 `propagateShutdown()`을 호출해요. NestJS가 종료될 때(Kubernetes의 SIGTERM, 배포, 테스트 정리 등) ORM이 모든 리소스를 해제하도록 보장해요:

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
    // 쿼리가 끝날 때까지 최대 10초 대기 후 모든 것을 닫아요
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

Kubernetes 환경에서의 타임라인:

```
1. Kubernetes가 pod에 SIGTERM 전송
2. NestJS가 SIGTERM을 받고 모듈 종료 시작
3. onModuleDestroy() 실행
4. propagateShutdown() 시작:
   - 3개 활성 쿼리가 끝날 때까지 최대 10초 대기 (2초 만에 완료)
   - buffer 플러그인 종료
   - 5개 이벤트 리스너와 2개 구독자 정리
   - 쿼리 트래커 초기화
   - 커넥션 풀 종료 (10개 연결 해제)
5. true 반환 (모든 쿼리 완료)
6. NestJS 종료 완료
7. 프로세스 정상 종료
```

---

## FindOption 참조

`find()`, `findOne()`, `findAndCount()`, `findWithCursor()`, `stream()`, `explain()`에서 사용할 수 있는 전체 옵션 목록이에요.

| 옵션 | 타입 | 설명 |
|-----|------|-----|
| `where` | `WhereClause<T>` | WHERE 조건. 각 키-값 쌍이 AND 조건이 돼요. |
| `select` | `(keyof T)[]` 또는 `Record<keyof T, boolean>` | 선택할 컬럼. 생략하면 `SELECT *`. |
| `orderBy` | `Record<keyof T, "ASC" \| "DESC">` | 정렬 순서. 키가 여러 개면 다중 컬럼 정렬. |
| `limit` | `number` 또는 `[offset, count]` | 직접 LIMIT 지정. 페이지네이션에는 `skip`/`take` 권장. |
| `skip` | `number` | 페이지네이션 오프셋. `take`와 함께 사용. |
| `take` | `number` | 최대 반환 행 수. `skip`과 함께 사용. |
| `relations` | `(keyof T \| string)[]` | LEFT JOIN으로 eager-load할 관계. 중첩 경로 지원 (예: `"author.profile"`). |
| `withDeleted` | `boolean` | soft-delete된 엔티티(`@DeletedAt`) 포함 여부. 기본값: `false`. |
| `groupBy` | `(keyof T)[]` | GROUP BY 컬럼. |
| `having` | `Sql[]` | HAVING 조건 (sql-template-tag). AND로 결합. |
| `timeout` | `number` | 쿼리별 타임아웃 (ms). 연결 수준 `queryTimeout`을 오버라이드. |
| `distinct` | `boolean` | `SELECT DISTINCT` 생성. 기본값: `false`. |
| `useMaster` | `boolean` | Replication 환경에서 마스터 노드에서 강제 읽기. 기본값: `false`. |
| `lock` | `LockMode` | 비관적 잠금: `PESSIMISTIC_WRITE` (FOR UPDATE) 또는 `PESSIMISTIC_READ` (FOR SHARE). |

---

## 다음 단계

- **[CRUD 기초](./entity-manager.md)** -- save, find, delete, soft delete
- **[쿼리 & 페이지네이션](./entity-manager-querying.md)** -- SELECT, 페이지네이션, 스트리밍, 집계
- **[쓰기 & 트랜잭션](./entity-manager-writes.md)** -- 배치 작업, upsert, 트랜잭션, raw SQL
- **[Query Builder](./query-builder.md)** -- 타입 안전한 fluent 쿼리
- **[Events & Subscribers](./events.md)** -- 엔티티 라이프사이클 이벤트와 감사 패턴
- **[Plugin System](./plugins.md)** -- 플러그인 작성과 사용
- **[Multi-Tenancy](./multi-tenancy.md)** -- 테넌트 프로비저닝과 스키마 격리
- **[Configuration](./configuration.md)** -- 풀링, 타임아웃, 복제, 로깅
