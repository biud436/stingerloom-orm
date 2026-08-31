# Events & Subscribers

## 이벤트가 필요한 이유

`User` 엔티티가 있다고 가정해볼게요. 사용자가 생성될 때 이런 작업이 필요해요:
1. 환영 이메일 발송
2. 감사 로그 기록
3. 캐시 무효화

이 로직을 사용자 생성 서비스에 전부 넣을 수도 있지만, 그러면 사용자 생성 코드가 이메일, 감사 로그, 캐시를 모두 알아야 해요. 사이드 이펙트가 추가될 때마다 같은 서비스를 수정해야 하고, 코드가 점점 엉키게 돼요.

이벤트는 **발생한 일**(사용자 생성)과 **그에 대한 반응**(이메일, 로그, 캐시)을 **분리**해줘요. 생성자는 이벤트를 발행하고, 리스너들은 독립적으로 반응해요. 서로의 존재를 알 필요가 없어요.

Stingerloom은 세 가지 수준의 이벤트 처리를 제공해요:

1. **Lifecycle hooks** (`@BeforeInsert`, `@AfterUpdate`, ...) -- 엔티티 클래스에 직접 붙이는 데코레이터
2. **Global event listeners** (`em.on()`) -- 모든 엔티티에 대해 실행되는 콜백
3. **Entity subscribers** (`EntitySubscriber`) -- 특정 엔티티의 이벤트 로직을 캡슐화하는 클래스

---

## Lifecycle Hooks -- 엔티티 자체의 이벤트

엔티티 라이프사이클 이벤트에 반응하는 가장 간단한 방법이에요. 엔티티 클래스에 데코레이터를 붙이면 되고, 별도 등록이 필요 없어요 -- ORM이 메타데이터를 통해 자동으로 인식해요.

```typescript
import { Entity, Column, BeforeInsert, AfterUpdate } from "@stingerloom/orm";

@Entity()
export class Post {
  @Column()
  title!: string;

  @Column()
  slug!: string;

  @BeforeInsert()
  generateSlug() {
    this.slug = this.title.toLowerCase().replace(/\s+/g, "-");
  }

  @AfterUpdate()
  logUpdate() {
    console.log(`Post "${this.title}" was updated`);
  }
}
```

각 hook이 실행되는 타이밍을 SQL 기준으로 보면 이래요:

```
  Your code:  em.save(Post, { title: "Hello World" })
      |
      v
  @BeforeInsert fires  -->  generateSlug() runs
      |                     this.slug is now "hello-world"
      v
  SQL executes:  INSERT INTO "posts" ("title", "slug") VALUES ('Hello World', 'hello-world');
      |
      v
  @AfterInsert fires   -->  (if you had one, it would run here)
```

핵심은 이거예요: **before hook은 데이터를 변경할 수 있어요** (SQL 실행 전이니까요). 반면 **after hook은 사이드 이펙트 전용**이에요 (SQL이 이미 실행된 후거든요).

### 사용 가능한 Hooks

| Decorator | 실행 시점 | 데이터 변경 가능? | 활용 예시 |
|-----------|----------|-----------------|----------|
| `@BeforeInsert()` | `INSERT` SQL 전 | Yes | slug 생성, 기본값 설정, 유효성 검사 |
| `@AfterInsert()` | `INSERT` SQL 후 | No (이미 저장됨) | 알림 발송, 생성 로그 |
| `@BeforeUpdate()` | `UPDATE` SQL 전 | Yes | 파생 필드 재계산, 유효성 검사 |
| `@AfterUpdate()` | `UPDATE` SQL 후 | No (이미 저장됨) | 변경 로그, webhook 트리거 |
| `@BeforeDelete()` | `DELETE` SQL 전 | No | 권한 확인, 제약 조건 체크 |
| `@AfterDelete()` | `DELETE` SQL 후 | No (이미 삭제됨) | 관련 리소스 정리 |

### Hooks vs. 다른 방식

Hook은 **엔티티 고유의 로직**에 가장 적합해요 -- 어떤 서비스에서 저장하든 항상 실행되어야 하는 것들이요. 예를 들어 title에서 slug를 생성하는 건 Post가 어떻게 만들어지든 항상 필요하잖아요.

만약 **엔티티에 대한 반응** (이메일 발송, 캐시 갱신)이라면, subscriber나 global listener를 사용하는 게 맞아요. 엔티티가 이메일 서비스를 알 필요는 없으니까요.

---

## Global Event Listeners -- 모든 엔티티에 반응하기

Global listener는 시스템의 **모든 엔티티**에 대해 실행돼요. EntityManager의 `em.on()`으로 등록해요.

```typescript
// Log every insert across all entities
em.on("afterInsert", ({ entity, data }) => {
  console.log(`[AUDIT] ${entity.name} created:`, data);
});

// Log every delete across all entities
em.on("afterDelete", ({ entity, data }) => {
  console.log(`[AUDIT] ${entity.name} deleted:`, data);
});
```

Global listener의 SQL 타임라인이에요:

```
  Your code:  em.save(User, { name: "Alice" })
      |
      v
  "beforeInsert" listeners fire  (all registered listeners, sequentially)
      |
      v
  SQL executes:  INSERT INTO "users" ("name") VALUES ('Alice') RETURNING "id";
      |
      v
  "afterInsert" listeners fire   (all registered listeners, sequentially)
```

### 리스너 관리

```typescript
// Register a listener (returns nothing)
em.on("afterInsert", listener);

// Remove a specific listener
em.off("afterInsert", listener);

// Remove ALL listeners for ALL events
em.removeAllListeners();
```

### 사용 가능한 이벤트

| Event | 실행 시점 |
|-------|----------|
| `beforeInsert` | INSERT 전 |
| `afterInsert` | INSERT 후 |
| `beforeUpdate` | UPDATE 전 (행 단위 `save()`와 일괄 `updateMany()`) |
| `afterUpdate` | UPDATE 후 (행 단위 `save()`와 일괄 `updateMany()`) |
| `beforeDelete` | DELETE 전 |
| `afterDelete` | DELETE 후 |
| `beforeSoftDelete` | `softDelete()` 전 |
| `afterSoftDelete` | `softDelete()` 후 |
| `beforeRestore` | `restore()` 전 |
| `afterRestore` | `restore()` 후 |

soft-delete·restore 이벤트는 delete 이벤트와 똑같은 criteria 기반 페이로드(`{ entity, data }`, 여기서 `data`는 WHERE criteria)를 넘겨줍니다. `updateMany()`는 이 global 채널로 엔티티 클래스와 SET 페이로드를 담아 `beforeUpdate` / `afterUpdate`를 발화해요.

### 언제 Global Listener를 쓸까?

모든 엔티티에 적용되는 **횡단 관심사(cross-cutting concerns)**에 이상적이에요:

- **감사 로깅** -- 모든 테이블의 모든 변경 기록
- **메트릭** -- 초당 insert/update/delete 횟수 집계
- **디버깅** -- 개발 중 모든 DB 작업 로깅

특정 엔티티에만 반응해야 한다면 (예: User 변경 시 캐시 무효화), EntitySubscriber를 대신 사용하세요.

---

## EntitySubscriber -- 엔티티별 이벤트 클래스

`EntitySubscriber`는 가장 강력한 방식이에요. 특정 엔티티의 모든 이벤트 로직을 하나의 전용 클래스에 캡슐화할 수 있어요. Global listener와 달리, 관심 있는 엔티티의 이벤트만 받아요.

### 전체 예제: Audit Trail

User 엔티티의 모든 변경을 기록하는 subscriber예요:

```typescript
// user-audit.subscriber.ts
import {
  EntitySubscriber,
  InsertEvent,
  UpdateEvent,
  DeleteEvent,
} from "@stingerloom/orm";
import { User } from "./user.entity";

class UserAuditSubscriber implements EntitySubscriber<User> {
  listenTo() {
    return User; // Only receive events for User -- not Post, not Comment, only User
  }

  async beforeInsert(event: InsertEvent<User>) {
    // Runs BEFORE the INSERT SQL.
    // You can mutate event.entity here to change what gets inserted.
    console.log("About to create user:", event.entity);
  }

  async afterInsert(event: InsertEvent<User>) {
    // Runs AFTER the INSERT SQL.
    // The user is already in the database. Use this for side effects.
    console.log("User created:", event.entity);
    await this.writeAuditLog("INSERT", event.entity);
  }

  async afterUpdate(event: UpdateEvent<User>) {
    console.log("User updated:", event.entity);
    await this.writeAuditLog("UPDATE", event.entity);
  }

  async afterDelete(event: DeleteEvent<User>) {
    console.log("User deleted, criteria:", event.criteria);
    await this.writeAuditLog("DELETE", { criteria: event.criteria });
  }

  private async writeAuditLog(action: string, data: any) {
    // Write to an audit_logs table, send to an external service, etc.
  }
}
```

### Subscriber의 SQL 타임라인

```
  Your code:  em.save(User, { name: "Alice", email: "alice@example.com" })
      |
      v
  UserAuditSubscriber.beforeInsert() fires
      |  (event.entity = { name: "Alice", email: "alice@example.com" })
      |  (you can mutate event.entity here)
      v
  SQL executes:  INSERT INTO "users" ("name", "email")
                 VALUES ('Alice', 'alice@example.com')
                 RETURNING "id";
      |
      v
  UserAuditSubscriber.afterInsert() fires
      |  (event.entity = { id: 1, name: "Alice", email: "alice@example.com" })
      |  (side effects only -- the row is already committed)
      v
  Return to your code
```

### 등록

```typescript
// Register the subscriber
em.addSubscriber(new UserAuditSubscriber());

// Unregister later if needed
em.removeSubscriber(subscriber);
```

### 전체 Subscriber 이벤트 목록

EntitySubscriber는 global listener보다 더 많은 이벤트를 지원해요. 트랜잭션 라이프사이클 이벤트도 포함돼요:

| Method | 실행 시점 | 활용 예시 |
|--------|----------|----------|
| `afterLoad(entity)` | DB에서 엔티티를 로드한 후 | 필드 복호화, 파생 값 계산 |
| `beforeInsert(event)` | INSERT 전 | 유효성 검사, 데이터 보강/변환 |
| `afterInsert(event)` | INSERT 후 | 감사 로그, 환영 이메일 발송 |
| `beforeUpdate(event)` | UPDATE 전 | 변경 유효성 검사, 필드 diff 추적 |
| `afterUpdate(event)` | UPDATE 후 | 캐시 무효화, 구독자 알림 |
| `beforeDelete(event)` | DELETE 전 | 권한 확인, 보호된 삭제 방지 |
| `afterDelete(event)` | DELETE 후 | 파일 정리, 검색 인덱스 제거 |
| `beforeSoftDelete(event)` | `softDelete()` 전 | soft-delete 가드, 상태 스냅샷 |
| `afterSoftDelete(event)` | `softDelete()` 후 | 아카이빙 전파, 알림 |
| `beforeRestore(event)` | `restore()` 전 | 복원 가드 |
| `afterRestore(event)` | `restore()` 후 | 재인덱싱, 캐시 재준비 |
| `beforeTransactionStart()` | BEGIN 전 | 진단, 로깅 |
| `afterTransactionStart()` | BEGIN 후 | 진단, 로깅 |
| `beforeTransactionCommit()` | COMMIT 전 | 최종 유효성 검사, 사이드 이펙트 일괄 처리 |
| `afterTransactionCommit()` | COMMIT 후 | 도메인 이벤트를 메시지 큐에 발행 |
| `beforeTransactionRollback()` | ROLLBACK 전 | 로깅 |
| `afterTransactionRollback()` | ROLLBACK 후 | 정리, 알림 |

모든 메서드는 선택 사항이에요 -- 필요한 것만 구현하면 돼요. `beforeSoftDelete` / `afterSoftDelete` / `beforeRestore` / `afterRestore`는 `beforeDelete` / `afterDelete`와 같은 criteria 기반 `DeleteEvent`(`{ entityClass, criteria, manager }`)를 받아요. 단일 행이 아니라 일괄 `WHERE`를 대상으로 실행되기 때문입니다.

### afterLoad 보장

`afterLoad`는 **엔티티를 반환하는 모든 조회 경로**에서 발화돼요 -- 믿고 설계해도 되는 보장이에요:

| 조회 경로 | `afterLoad` 발화? |
|-----------|------------------|
| `find()` / `findOne()` | 예 |
| 커서 페이지네이션 (`findWithCursor()`) | 예 |
| 쿼리 빌더 `getMany()` / `getOne()` / `getManyAndCount()` / `paginate()` | 예 (엔티티 결과만) |
| `getRawMany()` / `getPartialMany()` | 아니요 -- raw/partial 조회는 절대 발화하지 않아요 |

구독자가 `afterLoad`에서 필드를 복호화하거나 파생 값을 계산한다면, 엔티티가 어떤 경로로 로드됐든 훅이 실행된다고 믿어도 돼요. 서비스를 `find()`에서 쿼리 빌더로 바꿔도 훅이 슬그머니 빠지는 일은 없어요. 반대로 raw/partial 프로젝션은 손대지 않는 것도 보장돼요.

### 활용 예시

**캐시 무효화:**
```typescript
class ProductCacheSubscriber implements EntitySubscriber<Product> {
  listenTo() { return Product; }

  async afterUpdate(event: UpdateEvent<Product>) {
    await redis.del(`product:${event.entity.id}`);
  }

  async afterDelete(event: DeleteEvent<Product>) {
    await redis.del(`product:${event.criteria.id}`);
  }
}
```

**알림 발송:**
```typescript
class OrderNotificationSubscriber implements EntitySubscriber<Order> {
  listenTo() { return Order; }

  async afterInsert(event: InsertEvent<Order>) {
    await emailService.send({
      to: event.entity.customerEmail,
      subject: "Order confirmed",
      body: `Your order #${event.entity.id} has been placed.`,
    });
  }
}
```

**도메인 이벤트 발행 (commit 후에만):**
```typescript
class PaymentEventSubscriber implements EntitySubscriber<Payment> {
  listenTo() { return Payment; }

  async afterTransactionCommit() {
    // Only publish to the message queue AFTER the transaction is committed.
    // If you published in afterInsert and the transaction rolled back,
    // consumers would process an event for data that does not exist.
    await messageQueue.publish("payment.completed", { ... });
  }
}
```

---

## NestJS Integration

NestJS에서는 `OnModuleInit` 라이프사이클 훅을 사용해서 모듈 초기화 시점에 subscriber를 등록해요:

```typescript
import { Injectable, OnModuleInit } from "@nestjs/common";
import { InjectEntityManager } from "@stingerloom/orm/nestjs";
import { EntityManager } from "@stingerloom/orm";

@Injectable()
export class AppService implements OnModuleInit {
  constructor(
    @InjectEntityManager()
    private readonly em: EntityManager,
  ) {}

  onModuleInit() {
    // Register all subscribers when the module starts
    this.em.addSubscriber(new UserAuditSubscriber());
    this.em.addSubscriber(new ProductCacheSubscriber());
    this.em.addSubscriber(new OrderNotificationSubscriber());
  }
}
```

---

## 어떤 방식을 선택할까?

판단 기준이에요:

**"이 로직이 누가 저장하든 항상 실행되어야 하나요?"**
- Yes -- 엔티티 클래스에 **lifecycle hook** (`@BeforeInsert` 등)을 사용하세요.
- 예시: slug 생성, 기본 상태값 설정.

**"이 로직이 시스템의 모든 엔티티에 적용되어야 하나요?"**
- Yes -- **global listener** (`em.on()`)를 사용하세요.
- 예시: 모든 변경 감사 로깅, 메트릭용 연산 횟수 집계.

**"이 로직이 특정 엔티티 하나에만 적용되고, 외부 시스템과 연동되나요?"**
- Yes -- **EntitySubscriber**를 사용하세요.
- 예시: User 생성 시 이메일 발송, Product 변경 시 캐시 무효화.

요약 표:

| 필요한 기능 | 사용할 방식 |
|------------|-----------|
| 저장 전 엔티티 데이터 변경 | `@BeforeInsert()` / `@BeforeUpdate()` hooks |
| 모든 엔티티에 전역 반응 (로깅, 메트릭) | `em.on()` |
| 특정 엔티티에 반응 (감사, 캐시, 알림) | `EntitySubscriber` |
| 트랜잭션 라이프사이클에 반응 (commit, rollback) | `EntitySubscriber` |

---

## Next Steps

- [Entities](./entities.md) -- 엔티티 정의, 컬럼, 유효성 검사 데코레이터
- [Transactions](./transactions.md) -- 트랜잭션 관리와 격리 수준
- [API Reference](./api-reference.md) -- EntitySubscriber 타입 시그니처
