# Transactions

## 트랜잭션이 존재하는 이유

계좌 A에서 계좌 B로 $500을 이체한다고 상상해 보세요. 이 작업에는 두 가지 연산이 필요합니다:

1. 계좌 A에서 $500 차감
2. 계좌 B에 $500 추가

이제 1단계가 완료된 후 2단계가 실행되기 전에 서버가 다운되었다고 상상해 보세요. 계좌 A에서는 $500이 빠져나갔지만, 계좌 B에는 입금되지 않았습니다. 돈이 사라진 것입니다. 이것은 가상의 시나리오가 아닙니다 -- 트랜잭션을 사용하지 않는 애플리케이션에서 가장 흔하게 발생하는 데이터 손상 유형입니다.

**트랜잭션**은 데이터베이스의 약속입니다: 그룹 내의 모든 연산이 함께 성공하거나, 아무것도 적용되지 않습니다. 중간 상태는 존재하지 않습니다. 데이터베이스 이론에서는 이 속성을 **원자성(atomicity)**이라고 부릅니다 -- 연산들이 원자처럼 분할 불가능하다는 의미입니다.

SQL 수준에서 트랜잭션은 다음과 같이 동작합니다:

```sql
BEGIN;                                                  -- 1. Start the transaction
UPDATE "accounts" SET "balance" = "balance" - 500 WHERE "id" = 1;  -- 2. Deduct from A
UPDATE "accounts" SET "balance" = "balance" + 500 WHERE "id" = 2;  -- 3. Add to B
COMMIT;                                                 -- 4. Make both changes permanent
```

`BEGIN`과 `COMMIT` 사이에 문제가 발생하면, 데이터베이스는 `COMMIT` 대신 `ROLLBACK`을 실행합니다 -- `BEGIN` 이후의 모든 변경 사항을 마치 아무 일도 없었던 것처럼 되돌립니다:

```sql
BEGIN;
UPDATE "accounts" SET "balance" = "balance" - 500 WHERE "id" = 1;  -- Deducted...
UPDATE "accounts" SET "balance" = "balance" + 500 WHERE "id" = 2;  -- ERROR!
ROLLBACK;                                               -- Undo everything. Both accounts unchanged.
```

Stingerloom ORM은 모든 쓰기 작업을 자동으로 트랜잭션으로 감쌉니다. 아래 섹션에서는 이 동작을 제어하는 방법을 설명합니다.

---

## @Transactional() -- 데코레이터 방식

메서드 위에 `@Transactional()`을 추가하면 Stingerloom에게 "이 메서드 내부의 모든 것을 하나의 트랜잭션으로 감싸라"고 지시하는 것입니다. BEGIN이나 COMMIT을 직접 작성할 필요가 없습니다 -- 데코레이터가 처리합니다.

```typescript
import { Transactional } from "@stingerloom/orm";

class OrderService {
  @Transactional()
  async createOrder(data: CreateOrderDto): Promise<Order> {
    // 1. Create order
    const order = await em.save(Order, {
      userId: data.userId,
      status: "pending",
    });

    // 2. Insert order items
    await em.insertMany(OrderItem, data.items.map(item => ({
      orderId: order.id,
      productId: item.productId,
      quantity: item.quantity,
    })));

    // 3. Save payment information
    await em.save(Payment, {
      orderId: order.id,
      amount: data.totalAmount,
    });

    return order;
  }
}
```

내부적으로 데코레이터가 생성하는 SQL 타임라인은 다음과 같습니다:

```sql
-- @Transactional() starts here
BEGIN;

-- em.save(Order, {...})
INSERT INTO "orders" ("user_id", "status") VALUES (7, 'pending') RETURNING "id";

-- em.insertMany(OrderItem, [...])
INSERT INTO "order_items" ("order_id", "product_id", "quantity") VALUES (1, 42, 2), (1, 88, 1);

-- em.save(Payment, {...})
INSERT INTO "payments" ("order_id", "amount") VALUES (1, 15000);

COMMIT;
-- If any INSERT above threw an error, ROLLBACK would run instead of COMMIT.
-- All three inserts would be erased. The database returns to its state before BEGIN.
```

이것이 전부입니다. 메서드가 정상적으로 반환되면 트랜잭션이 커밋됩니다. 메서드가 에러를 던지면 트랜잭션이 자동으로 롤백됩니다.

---

## em.transaction() -- 콜백 방식

클래스 메서드에 데코레이터를 적용하지 않고 빠르게 독립적인 트랜잭션을 사용하고 싶을 때는 콜백 API를 사용하세요. 콜백은 트랜잭션이 적용된 EntityManager를 전달받습니다. 콜백이 성공하면 트랜잭션이 커밋되고, 예외가 발생하면 롤백됩니다.

```typescript
import { EntityManager } from "@stingerloom/orm";

const result = await em.transaction(async (txEm) => {
  const order = await txEm.save(Order, {
    userId: data.userId,
    status: "pending",
  });

  await txEm.insertMany(OrderItem, data.items.map(item => ({
    orderId: order.id,
    productId: item.productId,
    quantity: item.quantity,
  })));

  await txEm.save(Payment, {
    orderId: order.id,
    amount: data.totalAmount,
  });

  return order;
});
```

생성되는 SQL은 위의 데코레이터 예제와 동일합니다. 차이점은 순전히 코드 스타일의 문제입니다:

- 클래스 메서드에 어노테이션을 달고 싶을 때는 `@Transactional()`을 사용하세요.
- 인라인/함수형 사용, 스크립트, 또는 일회성 작업에는 `em.transaction()`을 사용하세요.

두 방식은 상호 교환 가능합니다.

---

## 격리 수준 설정

### 격리 수준이 존재하는 이유

여러 사용자가 동시에 같은 데이터를 읽고 쓸 때, 예상치 못한 일이 발생할 수 있습니다. 격리 수준은 데이터베이스가 얼마나 많은 "이상 현상"을 허용할지를 제어합니다. 안전성을 높이면 속도가 느려지고, 속도를 높이면 안전성이 낮아지는 다이얼이라고 생각하면 됩니다.

네 가지 표준 격리 수준은 점점 더 미묘한 문제를 방지합니다. 각각을 구체적인 시나리오와 함께 설명합니다.

### READ UNCOMMITTED -- 무법 지대

**허용되는 것:** 한 트랜잭션이 다른 트랜잭션이 작성했지만 아직 커밋하지 않은 데이터를 읽을 수 있습니다 ("더티 리드").

**시나리오 -- 더티 리드:**
```
Time   Transaction A                        Transaction B
----   ---------------------------          ---------------------------
  1    BEGIN;
  2    UPDATE "accounts" SET "balance" = 0
       WHERE "id" = 1;                      -- (balance was 1000)
  3                                          BEGIN;
  4                                          SELECT "balance" FROM "accounts"
                                             WHERE "id" = 1;
                                             -- Reads 0 (uncommitted!)
  5    ROLLBACK;                             -- A decided to undo the change
  6                                          -- B already acted on the value 0,
                                             -- but the real balance is still 1000.
```

트랜잭션 B는 실제로 존재한 적이 없는 데이터를 읽었습니다. 실무에서 이 수준을 사용하는 경우는 거의 없습니다.

### READ COMMITTED -- 기본값

**방지하는 것:** 더티 리드. 커밋된 데이터만 읽을 수 있습니다.

**허용되는 것:** 비반복 읽기(Non-repeatable read) -- 한 트랜잭션 내에서 같은 행을 두 번 읽을 때, 다른 트랜잭션이 두 읽기 사이에 변경 사항을 커밋했다면 다른 값이 반환될 수 있습니다.

**시나리오 -- 비반복 읽기:**
```
Time   Transaction A                        Transaction B
----   ---------------------------          ---------------------------
  1    BEGIN;
  2    SELECT "balance" FROM "accounts"
       WHERE "id" = 1;
       -- Reads 1000
  3                                          BEGIN;
  4                                          UPDATE "accounts"
                                             SET "balance" = 500
                                             WHERE "id" = 1;
  5                                          COMMIT;
  6    SELECT "balance" FROM "accounts"
       WHERE "id" = 1;
       -- Reads 500 (different!)
  7    COMMIT;
```

트랜잭션 A가 같은 행을 두 번 읽었는데 서로 다른 값을 얻었습니다. 대부분의 애플리케이션에서는 이것이 문제가 되지 않으며, 이것이 READ COMMITTED가 기본값인 이유입니다.

### REPEATABLE READ -- 일관된 스냅샷

**방지하는 것:** 더티 리드와 비반복 읽기. 한번 읽은 행은 트랜잭션이 끝날 때까지 동일한 값을 유지합니다.

**허용되는 것:** 팬텀 리드(Phantom read) -- 쿼리 조건에 맞는 새로운 행이 읽기 사이에 나타날 수 있습니다.

**시나리오 -- 팬텀 리드:**
```
Time   Transaction A                        Transaction B
----   ---------------------------          ---------------------------
  1    BEGIN;  (REPEATABLE READ)
  2    SELECT COUNT(*) FROM "orders"
       WHERE "status" = 'pending';
       -- Returns 5
  3                                          BEGIN;
  4                                          INSERT INTO "orders"
                                             ("status") VALUES ('pending');
  5                                          COMMIT;
  6    SELECT COUNT(*) FROM "orders"
       WHERE "status" = 'pending';
       -- Returns 6! A new "phantom" row appeared.
  7    COMMIT;
```

은행 이체나 재무 보고서처럼 하나의 트랜잭션 내에서 일관된 읽기가 필요할 때 이 수준을 사용하세요.

### SERIALIZABLE -- 최대 안전성

**방지하는 것:** 위의 모든 것, 팬텀 리드 포함. 데이터베이스는 트랜잭션들이 마치 순서대로 하나씩 실행된 것처럼 동작합니다.

**트레이드오프:** 데이터베이스가 충돌을 감지하면 직렬화 오류로 트랜잭션을 거부할 수 있으며, 이 경우 재시도해야 합니다.

처리량보다 절대적인 정확성이 중요한 경우에 사용하세요. 예를 들어 재고 차감이나 좌석 예약 등이 해당됩니다.

### 요약 표

| 격리 수준 | 더티 리드 | 비반복 읽기 | 팬텀 리드 | 성능 |
|----------------|-----------|-------------------|-------------|-------------|
| `READ UNCOMMITTED` | 가능 | 가능 | 가능 | 가장 빠름 |
| `READ COMMITTED` | 방지 | 가능 | 가능 | 양호 (기본값) |
| `REPEATABLE READ` | 방지 | 방지 | 가능 | 느림 |
| `SERIALIZABLE` | 방지 | 방지 | 방지 | 가장 느림 |

### Stingerloom에서 격리 수준 사용하기

`@Transactional()`에 문자열 인자로 격리 수준을 전달합니다:

```typescript
@Transactional("REPEATABLE READ")
async transfer(fromId: number, toId: number, amount: number) {
  const from = await em.findOne(Account, { where: { id: fromId } });
  const to = await em.findOne(Account, { where: { id: toId } });

  if (!from || from.balance < amount) {
    throw new Error("Insufficient balance");
  }

  await em.save(Account, { ...from, balance: from.balance - amount });
  await em.save(Account, { ...to, balance: to.balance + amount });
}
```

생성되는 SQL:

```sql
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
BEGIN;

SELECT * FROM "accounts" WHERE "id" = 1;    -- from
SELECT * FROM "accounts" WHERE "id" = 2;    -- to

UPDATE "accounts" SET "balance" = 500  WHERE "id" = 1;   -- deduct
UPDATE "accounts" SET "balance" = 1500 WHERE "id" = 2;   -- credit

COMMIT;
```

---

## 데드락 재시도

### 데드락이 발생하는 이유

**데드락**은 두 트랜잭션이 각각 상대방이 필요로 하는 잠금을 보유하고 있어, 어느 쪽도 진행할 수 없는 상태입니다. 데이터베이스는 이 순환 대기를 감지하고 그 중 하나를 종료합니다.

데드락이 정확히 어떻게 발생하는지 보겠습니다:

```
Time   Transaction A                        Transaction B
----   ---------------------------          ---------------------------
  1    BEGIN;                                BEGIN;
  2    UPDATE "products" SET "stock" = 9     UPDATE "orders" SET "status" = 'done'
       WHERE "id" = 1;                      WHERE "id" = 99;
       -- A now holds lock on products.1    -- B now holds lock on orders.99

  3    UPDATE "orders" SET "status" = 'new'  UPDATE "products" SET "stock" = 8
       WHERE "id" = 99;                     WHERE "id" = 1;
       -- A waits for orders.99 lock...     -- B waits for products.1 lock...
       -- (B holds it)                      -- (A holds it)

       DEADLOCK! Neither can proceed.
       Database kills one transaction with an error.
```

높은 동시성 환경에서 데드락은 버그가 아닙니다 -- 데이터베이스 운영의 정상적인 부분입니다. 올바른 대응은 재시도입니다.

### 자동 재시도

데드락 발생 시 즉시 실패하는 대신, Stingerloom에게 트랜잭션을 자동으로 재시도하도록 지시할 수 있습니다:

```typescript
const order = await em.transaction(async (txEm) => {
  const inventory = await txEm.findOne(Inventory, {
    where: { productId: 42 },
  });

  if (inventory.stock < 1) throw new Error("Out of stock");

  inventory.stock -= 1;
  await txEm.save(Inventory, inventory);
  return txEm.save(Order, { productId: 42, userId: data.userId });
}, {
  retryOnDeadlock: true,  // Enable automatic retry
  maxRetries: 3,          // Maximum retry attempts (default: 3)
  retryDelayMs: 100,      // Delay between retries in ms (default: 100)
});
```

데드락이 감지되면 ORM은 다음을 수행합니다:
1. 데드락 에러를 포착
2. `retryDelayMs` 밀리초 동안 대기 (지연은 같은 두 트랜잭션이 즉시 다시 충돌하는 것을 방지하는 데 도움이 됩니다)
3. 전체 콜백을 처음부터 다시 실행
4. `maxRetries` 횟수만큼 실패하면 마지막 에러를 정상적으로 throw

콜백은 **멱등성(idempotent)**을 가져야 합니다 -- 몇 번을 실행하든 동일한 결과를 생성해야 합니다. 이는 콜백 외부에서 캡처한 값에 의존하지 않고, 각 시도의 시작 시점에 새로운 데이터를 읽어야 함을 의미합니다.

### 데이터베이스별 데드락 감지

| 데이터베이스 | 감지 방식 |
|----------|-----------|
| MySQL | `errno 1213` (ER_LOCK_DEADLOCK) |
| PostgreSQL | Error code `40P01` (deadlock_detected) |
| SQLite | `SQLITE_BUSY` 또는 "database is locked" 메시지 |

### TransactionOptions

```typescript
interface TransactionOptions {
  retryOnDeadlock?: boolean;  // Enable deadlock retry (default: false)
  maxRetries?: number;        // Maximum retries (default: 3)
  retryDelayMs?: number;      // Delay between retries in ms (default: 100)
}
```

> 데드락 재시도는 `em.transaction()`에서만 사용할 수 있습니다. `@Transactional()` 데코레이터는 이를 지원하지 않습니다 -- 데드락이 발생할 가능성이 높은 작업(예: 재고 차감, 카운터 증가)에는 `em.transaction()`을 사용하세요.

---

## 중첩 트랜잭션

### 중첩이 중요한 이유

`@Transactional()` 메서드가 다른 `@Transactional()` 메서드를 호출할 때, 두 개의 별도 트랜잭션을 원하는 것이 아닙니다 -- 하나의 트랜잭션을 공유하기를 원합니다. 외부 메서드가 롤백되면 내부 메서드의 작업도 함께 롤백되어야 합니다.

이것이 기본 동작이며 `REQUIRED` 전파라고 합니다. 트랜잭션이 이미 존재하면 내부 메서드가 합류하고, 트랜잭션이 없으면 새로 생성됩니다.

```typescript
class UserService {
  @Transactional()
  async createUserWithProfile(data: CreateUserDto) {
    const user = await em.save(User, { name: data.name, email: data.email });
    await this.createProfile(user.id, data.profileData); // Same transaction
    return user;
  }

  @Transactional()
  async createProfile(userId: number, profileData: any) {
    // When called from createUserWithProfile -> reuses existing transaction
    // When called independently -> starts a new transaction
    return em.save(Profile, { userId, ...profileData });
  }
}
```

`createUserWithProfile()`가 호출될 때의 SQL 타임라인:

```sql
BEGIN;                                                              -- outer @Transactional starts

INSERT INTO "users" ("name", "email") VALUES ('John', 'j@x.com') RETURNING "id";

-- createProfile() is called, but no new BEGIN -- it joins the existing transaction

INSERT INTO "profiles" ("user_id", "bio") VALUES (1, 'Hello world');

COMMIT;                                                             -- outer @Transactional commits both
```

`BEGIN`은 하나, `COMMIT`도 하나뿐입니다. 두 INSERT 모두 같은 트랜잭션 안에 있습니다.

### 전파 전략

Stingerloom은 Spring이나 Jakarta EE와 같은 프레임워크에서 볼 수 있는 세 가지 전파 모드를 지원합니다:

| 전파 방식 | 동작 |
|-------------|----------|
| `REQUIRED` (기본값) | 기존 트랜잭션이 있으면 합류하고, 없으면 새로 생성 |
| `REQUIRES_NEW` | 항상 새로운 독립 트랜잭션을 생성 (새 데이터베이스 연결) |
| `NESTED` | 기존 트랜잭션 내에 savepoint를 생성하고, 실패 시 해당 savepoint만 롤백 |

```typescript
import { Transactional, TransactionPropagation } from "@stingerloom/orm";

@Transactional({ propagation: TransactionPropagation.REQUIRES_NEW })
async sendNotification(userId: number) {
  // This runs in its own transaction, independent of the caller.
  // If this fails, the caller's transaction is NOT affected.
}

@Transactional({ propagation: TransactionPropagation.NESTED })
async optionalStep() {
  // This creates a savepoint. If it fails, only this step rolls back.
  // The parent transaction continues.
}
```

---

## Savepoint -- 부분 롤백

### Savepoint가 존재하는 이유

때로는 트랜잭션 내부에서 위험한 작업을 시도하고, 실패하면 그 작업만 되돌리고 나머지는 유지하고 싶을 수 있습니다. savepoint가 없으면 실패는 곧 전체 트랜잭션의 롤백을 의미합니다. savepoint를 사용하면 특정 체크포인트로만 롤백할 수 있습니다.

비디오 게임의 "게임 저장"과 같다고 생각하면 됩니다. 보스전 전에 저장합니다. 죽으면 그 저장 지점에서 다시 불러옵니다 -- 게임 전체를 처음부터 다시 시작하지 않습니다.

### SQL 수준에서의 동작 방식

```sql
BEGIN;

-- Task 1: Create user (this will be kept regardless)
INSERT INTO "users" ("name") VALUES ('John Doe');

SAVEPOINT sp1;                    -- Save the current state

-- Task 2: Risky operation
UPDATE "accounts" SET "balance" = -100 WHERE "id" = 1;
-- Oops, constraint violation!

ROLLBACK TO SAVEPOINT sp1;       -- Undo only Task 2. Task 1 is preserved.
RELEASE SAVEPOINT sp1;           -- Clean up the savepoint

COMMIT;                           -- Task 1 is committed. Task 2 never happened.
```

### 코드에서 Savepoint 사용하기

```typescript
const session = new TransactionSessionManager();

try {
  await session.connect();
  await session.startTransaction();

  // Task 1: Create user
  await session.query(sql`INSERT INTO "users" ("name") VALUES (${"John Doe"})`);

  // Save the state up to this point
  await session.savepoint("sp1");

  try {
    // Task 2: Risky operation
    await session.query(sql`UPDATE "accounts" SET "balance" = ${-100} WHERE "id" = ${1}`);
  } catch {
    // Roll back only task 2 (task 1 is preserved)
    await session.rollbackTo("sp1");
  }

  await session.commit();
} catch (error) {
  await session.rollback();
  throw error;
} finally {
  await session.close();
}
```

---

## 수동 트랜잭션 관리

트랜잭션 경계를 완전히 제어하려면 `TransactionSessionManager`를 직접 사용하세요. 이는 트랜잭션 로직과 비데이터베이스 작업을 교차해야 하거나, 연결 수명 주기를 명시적으로 제어하고 싶을 때 유용합니다.

```typescript
import { TransactionSessionManager } from "@stingerloom/orm";
import sql from "sql-template-tag";

const session = new TransactionSessionManager();

try {
  await session.connect();                              // 1. Get a database connection
  await session.startTransaction("READ COMMITTED");     // 2. BEGIN

  await session.query(sql`INSERT INTO "users" ("name") VALUES (${"John Doe"})`);
  await session.query(sql`UPDATE "profiles" SET "is_complete" = ${true} WHERE "user_id" = ${1}`);

  await session.commit();                               // 3. COMMIT
} catch (error) {
  await session.rollback();                             // 3. ROLLBACK (on error)
  throw error;
} finally {
  await session.close();                                // 4. Release the connection
}
```

생성되는 SQL:

```sql
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
BEGIN;

INSERT INTO "users" ("name") VALUES ('John Doe');
UPDATE "profiles" SET "is_complete" = true WHERE "user_id" = 1;

COMMIT;   -- or ROLLBACK if an error was caught
```

---

## NestJS와 함께 사용하기

NestJS 서비스에서 `@Transactional()`은 동일하게 동작합니다. 리포지토리를 주입하고 메서드에 데코레이터를 적용하세요:

```typescript
// cats.service.ts
import { Injectable } from "@nestjs/common";
import { Transactional, BaseRepository } from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { Cat } from "./cat.entity";

@Injectable()
export class CatsService {
  constructor(
    @InjectRepository(Cat) private readonly catRepo: BaseRepository<Cat>,
  ) {}

  @Transactional()
  async create(dto: CreateCatDto): Promise<Cat> {
    const cat = new Cat();
    cat.name = dto.name;
    cat.age = dto.age;
    cat.breed = dto.breed;
    return this.catRepo.save(cat) as Promise<Cat>;
  }

  @Transactional("REPEATABLE READ")
  async updateAge(id: number, age: number): Promise<Cat> {
    const cat = await this.catRepo.findOne({ where: { id } as any });
    cat.age = age;
    return this.catRepo.save(cat) as Promise<Cat>;
  }
}
```

`create()` 메서드가 생성하는 SQL:

```sql
BEGIN;
INSERT INTO "cats" ("name", "age", "breed") VALUES ('Milo', 3, 'Persian') RETURNING "id";
COMMIT;
```

`updateAge()` 메서드가 생성하는 SQL:

```sql
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
BEGIN;
SELECT * FROM "cats" WHERE "id" = 1;
UPDATE "cats" SET "age" = 4 WHERE "id" = 1;
COMMIT;
```

---

## 다음 단계

- [Migrations](./migrations.md) -- 프로덕션에서 안전하게 스키마 변경하기
- [Configuration Guide](./configuration.md) -- 풀링, 타임아웃, Read Replica 설정
- [EntityManager](./entity-manager.md) -- 전체 CRUD API 레퍼런스
