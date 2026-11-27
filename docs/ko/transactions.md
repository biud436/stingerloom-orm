# Transactions

## 트랜잭션이 존재하는 이유

계좌 A에서 계좌 B로 $500을 이체한다고 해 봅시다. 이 작업에는 연산 두 개가 필요합니다.

1. 계좌 A에서 $500 차감
2. 계좌 B에 $500 추가

1단계가 끝나고 2단계를 실행하기 전에 서버가 다운됐다고 가정합니다. 계좌 A에서는 $500이 빠져나갔지만 계좌 B에는 입금되지 않았습니다. 돈이 사라진 것입니다. 이는 가상의 시나리오가 아닙니다. 트랜잭션을 쓰지 않는 애플리케이션에서 가장 흔한 데이터 손상 유형입니다.

**트랜잭션**은 데이터베이스가 하는 약속입니다. 묶인 연산은 모두 함께 성공하거나 하나도 적용되지 않습니다. 중간 상태는 없습니다. 데이터베이스 이론에서는 이 성질을 **원자성**(atomicity)이라고 부릅니다. 연산들이 원자처럼 나눌 수 없다는 뜻입니다.

SQL 수준에서 트랜잭션은 다음과 같이 동작합니다.

```sql
BEGIN;                                                  -- 1. Start the transaction
UPDATE "accounts" SET "balance" = "balance" - 500 WHERE "id" = 1;  -- 2. Deduct from A
UPDATE "accounts" SET "balance" = "balance" + 500 WHERE "id" = 2;  -- 3. Add to B
COMMIT;                                                 -- 4. Make both changes permanent
```

`BEGIN`과 `COMMIT` 사이에 문제가 생기면 데이터베이스는 `COMMIT` 대신 `ROLLBACK`을 실행합니다. 그러면 `BEGIN` 이후의 모든 변경 사항이 아무 일도 없었던 것처럼 되돌려집니다.

```sql
BEGIN;
UPDATE "accounts" SET "balance" = "balance" - 500 WHERE "id" = 1;  -- Deducted...
UPDATE "accounts" SET "balance" = "balance" + 500 WHERE "id" = 2;  -- ERROR!
ROLLBACK;                                               -- Undo everything. Both accounts unchanged.
```

Stingerloom ORM은 모든 쓰기 작업을 자동으로 트랜잭션으로 감쌉니다. 이 동작은 아래 방법으로 제어합니다.

---

## @Transactional() -- 데코레이터 방식

메서드 위에 `@Transactional()`을 붙이면 그 메서드 안의 모든 작업이 트랜잭션 하나로 감싸집니다. BEGIN이나 COMMIT을 직접 쓸 필요가 없습니다. 데코레이터가 이를 처리합니다.

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

데코레이터가 내부에서 생성하는 SQL을 순서대로 보면 다음과 같습니다.

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

이것이 전부입니다. 메서드가 정상적으로 반환하면 커밋(commit)되고 에러를 던지면 자동으로 롤백(rollback)됩니다.

---

## em.transaction() -- 콜백 방식

클래스 메서드에 데코레이터를 붙이지 않고 트랜잭션을 바로 쓰려면 콜백 API를 쓰세요. 콜백에는 트랜잭션이 적용된 EntityManager가 전달됩니다. 콜백이 성공하면 커밋되고 에러가 나면 롤백됩니다.

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

생성되는 SQL은 위의 데코레이터 예제와 같습니다. 차이는 코드 스타일뿐입니다.

- 클래스 메서드에 데코레이터를 달고 싶으면 `@Transactional()`을 쓰세요.
- 인라인이나 함수형으로 쓰는 코드, 스크립트, 일회성 작업에는 `em.transaction()`을 쓰세요.

두 방식은 서로 바꿔 쓸 수 있습니다. `em.transaction()`의 두 번째 인자는 데코레이터가 받는 `isolationLevel`, `propagation`, `connectionName` 옵션을 똑같이 받습니다. 여기에 선택적인 데드락 재시도 옵션도 더 받습니다. 그래서 데코레이터가 꼭 필요한 경우는 없습니다.

```typescript
import { TransactionPropagation } from "@stingerloom/orm";

await em.transaction(async (txEm) => {
  /* ... */
}, {
  isolationLevel: "SERIALIZABLE",                      // @Transactional("SERIALIZABLE")
  propagation: TransactionPropagation.REQUIRES_NEW,    // @Transactional({ propagation })
  connectionName: "reporting",                         // @Transactional({ connectionName })
});
```

전체 옵션 레퍼런스는 [데코레이터 없이 사용하기](./decorator-free.md#transactional-없이-트랜잭션)를 참고하세요.

---

## 격리 수준 설정

### 격리 수준이 존재하는 이유

여러 사용자가 같은 데이터를 동시에 읽고 쓰면 예상 밖의 일이 생길 수 있습니다. 격리 수준은 데이터베이스가 이상 현상을 어디까지 허용할지 정하는 설정입니다. 안전성을 높이면 느려지고 속도를 높이면 안전성이 낮아지는 다이얼과 같습니다.

표준 격리 수준 네 가지는 수준이 높아질수록 더 미묘한 문제까지 막습니다.

### READ UNCOMMITTED -- 무법 지대

허용되는 것: 한 트랜잭션이 다른 트랜잭션이 아직 커밋하지 않은 데이터를 읽을 수 있습니다. 이를 더티 리드(dirty read)라고 합니다.

**더티 리드 시나리오:**
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

트랜잭션 B는 실제로 존재한 적 없는 데이터를 읽었습니다. 실무에서 이 수준을 쓰는 경우는 거의 없습니다.

### READ COMMITTED -- 기본값

방지하는 것: 더티 리드입니다. 이 수준에서는 커밋된 데이터만 읽습니다.

허용되는 것: 비반복 읽기(non-repeatable read)가 생길 수 있습니다. 같은 행을 두 번 읽는 사이에 다른 트랜잭션이 변경을 커밋했다면 다른 값이 나옵니다.

**비반복 읽기 시나리오:**
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

트랜잭션 A가 같은 행을 두 번 읽었는데 값이 다릅니다. 대부분의 애플리케이션에서는 이것이 문제가 되지 않습니다. 그래서 READ COMMITTED가 기본값입니다.

### REPEATABLE READ -- 일관된 스냅샷

방지하는 것: 더티 리드와 비반복 읽기입니다. 한 번 읽은 행은 트랜잭션이 끝날 때까지 같은 값을 유지합니다.

허용되는 것: 팬텀 리드(phantom read)가 생길 수 있습니다. 두 번 읽는 사이에 쿼리 조건에 맞는 새 행이 나타날 수 있습니다.

**팬텀 리드 시나리오:**
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

은행 이체나 재무 보고서처럼 트랜잭션 안에서 일관된 읽기가 필요할 때 이 수준을 쓰세요.

### SERIALIZABLE -- 최대 안전성

방지하는 것: 팬텀 리드를 포함한 위의 모든 문제입니다. 데이터베이스는 트랜잭션들을 순서대로 하나씩 실행한 것처럼 동작합니다.

트레이드오프: 충돌이 감지되면 직렬화 에러로 트랜잭션이 거부될 수 있습니다. 이때는 재시도해야 합니다.

처리량보다 정확성이 절대적으로 중요할 때 쓰세요. 재고 차감이나 좌석 예약이 그 예입니다.

### 요약 표

| 격리 수준 | 더티 리드 | 비반복 읽기 | 팬텀 리드 | 성능 |
|----------------|-----------|-------------------|-------------|-------------|
| `READ UNCOMMITTED` | 가능 | 가능 | 가능 | 가장 빠름 |
| `READ COMMITTED` | 방지 | 가능 | 가능 | 양호 (기본값) |
| `REPEATABLE READ` | 방지 | 방지 | 가능 | 느림 |
| `SERIALIZABLE` | 방지 | 방지 | 방지 | 가장 느림 |

### Stingerloom에서 격리 수준 사용하기

`@Transactional()`에 격리 수준을 문자열 인자로 넘기면 됩니다.

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
BEGIN;
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;

SELECT * FROM "accounts" WHERE "id" = 1;    -- from
SELECT * FROM "accounts" WHERE "id" = 2;    -- to

UPDATE "accounts" SET "balance" = 500  WHERE "id" = 1;   -- deduct
UPDATE "accounts" SET "balance" = 1500 WHERE "id" = 2;   -- credit

COMMIT;
```

MySQL/MariaDB에서는 `SET TRANSACTION`이 다음 트랜잭션에 적용되는 SQL 문입니다. 그래서 `START TRANSACTION`보다 먼저 실행됩니다.

격리 수준을 지정하면 서버나 세션의 기본값과 관계없이 항상 그 수준으로 실행됩니다. 지정하지 않으면 데이터베이스마다 다음과 같이 동작합니다.

- MySQL/MariaDB는 READ COMMITTED로 실행됩니다. InnoDB의 기본값은 REPEATABLE READ이므로 ORM이 직접 설정합니다.
- PostgreSQL은 추가 SQL 문 없이 서버의 `default_transaction_isolation`을 따릅니다. 데이터베이스 설정을 따로 바꾸지 않았다면 이 값도 READ COMMITTED입니다.

---

## 데드락 재시도

### 데드락이 발생하는 이유

**데드락**은 두 트랜잭션이 상대방에게 필요한 잠금을 각각 쥐고 있어서 어느 쪽도 진행하지 못하는 상태입니다. 데이터베이스는 이 순환 대기를 감지하고 트랜잭션 하나를 종료합니다.

데드락은 다음과 같이 발생합니다.

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

동시성이 높은 환경에서 데드락은 버그가 아닙니다. 데이터베이스를 운영하면 정상적으로 겪는 일입니다. 올바른 대응은 재시도입니다.

### 자동 재시도

데드락이 나면 바로 실패하지 않고 자동으로 재시도하도록 설정할 수 있습니다.

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

데드락이 감지되면 ORM은 다음과 같이 처리합니다.

1. 데드락 에러를 잡습니다.
2. `retryDelayMs`만큼 기다립니다. 같은 두 트랜잭션이 곧바로 다시 충돌하지 않게 하려는 것입니다.
3. 콜백 전체를 처음부터 다시 실행합니다.
4. `maxRetries` 횟수까지 모두 실패하면 마지막 에러를 던집니다.

콜백은 **멱등**(idempotent)이어야 합니다. 몇 번을 실행하든 같은 결과를 내야 한다는 뜻입니다. 콜백 바깥에서 캡처한 값에 의존하지 마세요. 시도할 때마다 처음에 데이터를 새로 조회해야 합니다. `save()`에 넘긴 객체는 다시 넘겨도 됩니다. 롤백된 시도가 객체에 써 넣은 키와 기본값은 ORM이 다시 걷어 내기 때문입니다([롤백 뒤의 객체](#롤백-뒤의-객체) 참고).

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

  // @Transactional과 같은 옵션 (데코레이터 없는 형태)
  isolationLevel?: TRANSACTION_ISOLATION_LEVEL;  // 예: "SERIALIZABLE"
  propagation?: TransactionPropagation | "REQUIRED" | "REQUIRES_NEW" | "NESTED";
  connectionName?: string;                       // 멀티 DB 대상 연결
}
```

> 데드락 재시도는 `em.transaction()`에서만 쓸 수 있습니다. `@Transactional()` 데코레이터는 이 옵션을 지원하지 않습니다. 재고 차감이나 카운터 증가처럼 데드락이 나기 쉬운 작업에는 `em.transaction()`을 쓰세요. 격리 수준, 전파, 연결 같은 나머지 `@Transactional` 옵션은 모두 `em.transaction()`에서도 쓸 수 있습니다. 그래서 데코레이터가 꼭 필요한 경우는 없습니다.

`propagation`에는 `TransactionPropagation` 멤버나 그 문자열 값(`"REQUIRES_NEW"`)을 넣을 수 있습니다. 아래와 같은 옵션 값을 넘기면 ORM은 트랜잭션을 시작하기 전에 `INVALID_CONFIG`를 던집니다. 이때 메시지에는 가장 가까운 유효한 값도 나옵니다(`Did you mean "REQUIRES_NEW"?`).

- 알 수 없는 `propagation`이나 `isolationLevel`
- 음수 `maxRetries`
- 숫자가 아닌 `retryDelayMs`

`@Transactional()`은 클래스가 정의될 때 옵션을 검사합니다. 이 검사가 없다면 전파 옵션의 오타는 `REQUIRED`로 실행되고 SQLite는 어떤 격리 수준이든 경고 없이 받아들입니다.

---

## 중첩 트랜잭션

### 중첩이 중요한 이유

`@Transactional()` 메서드가 다른 `@Transactional()` 메서드를 호출할 때 보통 원하는 것은 별도의 트랜잭션 두 개가 아닙니다. 트랜잭션 하나를 공유하는 것입니다. 바깥 메서드가 롤백되면 안쪽 메서드의 작업도 함께 롤백돼야 합니다.

이것이 기본 동작이며 `REQUIRED` 전파라고 부릅니다. 트랜잭션이 이미 있으면 합류하고 없으면 새로 만듭니다.

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

`createUserWithProfile()`을 호출하면 SQL은 다음 순서로 실행됩니다.

```sql
BEGIN;                                                              -- outer @Transactional starts

INSERT INTO "users" ("name", "email") VALUES ('John', 'j@x.com') RETURNING "id";

-- createProfile() is called, but no new BEGIN -- it joins the existing transaction

INSERT INTO "profiles" ("user_id", "bio") VALUES (1, 'Hello world');

COMMIT;                                                             -- outer @Transactional commits both
```

`BEGIN`도 하나이고 `COMMIT`도 하나입니다. 두 INSERT 모두 같은 트랜잭션 안에 있습니다.

### 전파 전략

Stingerloom은 세 가지 전파 모드를 지원합니다.

| 전파 방식 | 동작 |
|-------------|----------|
| `REQUIRED` (기본값) | 기존 트랜잭션이 있으면 합류하고 없으면 새로 생성 |
| `REQUIRES_NEW` | 항상 독립된 새 트랜잭션 생성. 새 DB 연결을 사용하며 [SQLite](#transactions-on-sqlite)에서는 트랜잭션 안에서 거부 |
| `NESTED` | 기존 트랜잭션 안에 세이브포인트 생성. 실패하면 그 세이브포인트까지만 롤백 |

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

### 여러 커넥션에 걸친 트랜잭션 {#transactions-on-more-than-one-connection}

트랜잭션은 연결 하나에 속합니다. 그리고 그 연결의 작업만 트랜잭션에 합류합니다. `"default"` 연결을 여는 `@Transactional()` 안에서 `"analytics"`에 묶인 EntityManager는 그 트랜잭션에서 SQL 문을 실행하지 않습니다. SQL 문은 모두 `"analytics"`에서 실행되고 쓰기는 하나하나 자기 트랜잭션으로 커밋됩니다. 그래서 바깥 트랜잭션이 나중에 롤백되어도 이 쓰기는 남습니다. 이 작업도 원자적이어야 한다면 그 연결의 트랜잭션으로 감싸세요.

```typescript
@Transactional()                                     // "default"
async placeOrder(order: Order) {
  await this.em.save(Order, order);                  // joins the default transaction
  await this.analyticsEm.transaction(async () => {   // a transaction on "analytics"
    await this.analyticsEm.save(OrderEvent, { orderId: order.id });
    await this.em.save(OrderLog, { orderId: order.id }); // still the default transaction
  });
}
```

두 트랜잭션은 따로 커밋됩니다. 데이터베이스를 가로지르는 2단계 커밋은 없습니다. 다른 연결의 트랜잭션 안에서 연 트랜잭션은 바깥 트랜잭션을 가리지 않습니다. 그래서 analytics 콜백 안의 `this.em`도 여전히 default 트랜잭션에 합류합니다. 전파도 같은 규칙을 따릅니다. `REQUIRED`와 `NESTED`는 자기 연결의 트랜잭션만 찾습니다. 그래서 default 트랜잭션 안의 `@Transactional({ connectionName: "analytics" })`는 `"analytics"`에 새 트랜잭션을 엽니다.

매니저의 작업을 다른 연결에서 실행하는 방법은 `em.transaction(cb, { connectionName })` 하나뿐입니다. 콜백 안에서는 그 매니저의 SQL 문이 지정한 연결의 트랜잭션에 합류합니다. 이전 버전은 모든 매니저의 SQL 문을 그때 활성인 트랜잭션에서 실행했습니다. 그래서 다른 연결의 매니저가 엉뚱한 데이터베이스를 읽고 썼습니다.

### SQLite의 트랜잭션 {#transactions-on-sqlite}

SQLite에서 ORM이 쓰는 연결은 하나뿐입니다. 그리고 그 위에 열린 트랜잭션은 연결에서 실행되는 모든 SQL 문을 가져갑니다. 그래서 SQLite의 트랜잭션은 차례를 지킵니다. 다른 트랜잭션이 열려 있는 동안 시작한 트랜잭션은 앞의 트랜잭션이 커밋하거나 롤백할 때까지 기다립니다. 열린 트랜잭션 바깥의 읽기와 쓰기도 똑같이 기다립니다. 그래서 아직 커밋되지 않은 행을 보는 일이 없습니다. 트랜잭션 안의 작업은 바로 실행됩니다. 콜백과 콜백이 기다리는 작업이 여기에 해당합니다.

```typescript
// Both commit, one after the other.
await Promise.all([
  em.transaction(async (tx) => { await tx.save(Order, first); }),
  em.transaction(async (tx) => { await tx.save(Order, second); }),
]);
```

연결이 하나뿐이라서 생기는 일이 두 가지 있습니다.

- 트랜잭션 안의 `REQUIRES_NEW`는 자기 연결을 따로 얻을 수 없습니다. 그래서 ORM은 트랜잭션을 시작하기 전에 `OrmError`를 던집니다. 에러 코드는 `UNSUPPORTED_OPERATION`입니다. 바깥 트랜잭션은 영향 없이 이어집니다. 열린 트랜잭션에 합류하려면 `REQUIRED`를 쓰고 세이브포인트가 필요하면 `NESTED`를 쓰세요.
- 기다리는 작업은 `pool.acquireTimeoutMs`가 지나면 `CONNECTION_FAILED`로 실패합니다(기본 30초, `0`이면 제한 없이 대기). 트랜잭션이 바깥에서 실행 중인 작업을 기다리는 경우를 생각해 봅시다. 다른 요청이 만든 promise가 그 예입니다. 이때 그 작업이 기다리는 연결은 트랜잭션이 쥐고 있습니다. 그래서 양쪽 모두 타임아웃까지 기다립니다. 그런 작업은 콜백 안에서 하거나 트랜잭션이 끝난 뒤에 하세요.

이전 버전은 이럴 때 연결에 BEGIN을 한 번 더 보냈습니다. 그래서 다음 문제가 생겼습니다.

- 두 번째 트랜잭션이 실패하면 그 ROLLBACK이 첫 번째 트랜잭션의 작업까지 되돌렸습니다.
- 열린 트랜잭션 옆의 읽기가 나중에 롤백될 행을 반환할 수 있었습니다.
- `REQUIRES_NEW`가 바깥 트랜잭션을 롤백했습니다.

직접 다루는 `TransactionSessionManager`는 지금도 차례를 지키지 않고 연결을 함께 씁니다([아래](#수동-트랜잭션-관리) 참고).

---

## Savepoint -- 부분 롤백

### Savepoint가 존재하는 이유

트랜잭션 안에서 위험한 작업을 시도하다가 실패하면 그 작업만 되돌리고 나머지는 유지하고 싶을 때가 있습니다. 세이브포인트(savepoint)가 없으면 실패는 곧 전체 롤백입니다. 세이브포인트를 쓰면 특정 체크포인트까지만 되돌릴 수 있습니다.

비디오 게임의 세이브와 같습니다. 보스전 전에 저장하고 지면 그 지점에서 다시 불러옵니다. 게임을 처음부터 다시 시작하지 않습니다.

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

## 롤백 뒤의 객체

`save()`는 데이터베이스가 만든 값을 넘겨받은 객체에 다시 써 넣습니다. 기본 키와 cascade가 관련 객체에 설정하는 외래 키가 여기에 해당합니다. `saveMany()`, `insertMany()`, `insertManyAndReturn()`은 각 항목에 `@CreateTimestamp`와 `@UpdateTimestamp` 값, `@Version` 초깃값도 써 넣습니다. 트랜잭션이 롤백되면 그 행은 사라집니다. 그래서 ORM은 객체에 써 넣었던 값도 함께 걷어 냅니다.

```typescript
const draft = { title: "Hello" };

await em
  .transaction(async (txEm) => {
    await txEm.save(Post, draft); // 여기서 draft.id가 설정됨
    throw new Error("payment failed");
  })
  .catch(() => {});

draft;                      // { title: "Hello" }: id 없음
await em.save(Post, draft); // 다시 INSERT
```

이 처리가 없으면 롤백 뒤에도 `draft.id`에 키가 남습니다. 그러면 `draft`를 다시 저장할 때 존재하지 않는 행을 대상으로 UPDATE가 실행됩니다(`EntityNotFoundError`).

- **어떤 롤백인가.** 쓰기가 실행된 트랜잭션의 롤백입니다. 직접 연 `em.transaction()`이나 `@Transactional()`이 해당합니다. 트랜잭션 밖에서 `save()`를 호출했다면 `save()`가 스스로 연 트랜잭션이 해당합니다. cascade 쓰기나 훅이 에러를 던지면 그 트랜잭션이 롤백됩니다. `NESTED` 세이브포인트가 롤백되면 그 세이브포인트 이후에 쓴 객체만 되돌립니다.
- **무엇을 되돌리나.** 쓰기가 그 객체에서 바꾼 속성입니다. `beforeInsert` 훅이 설정한 값도 포함됩니다. 호출 뒤에 직접 바꾼 속성은 바꾼 값을 그대로 유지합니다. cascade로 저장된 관련 객체도 같은 방식으로 되돌립니다.
- **건드리지 않는 것.** `save()`가 반환하는 엔티티는 별개의 객체입니다. 커밋되면 모든 객체가 쓰기가 남긴 값을 그대로 유지합니다. `createInsertBuilder()`는 SQL 문 단위 API이므로 넘긴 행을 되돌리지 않습니다.

---

## 수동 트랜잭션 관리

트랜잭션 경계를 완전히 제어하려면 `TransactionSessionManager`를 직접 쓰세요. 트랜잭션 로직 사이에 데이터베이스 밖의 작업을 끼워 넣어야 할 때 유용합니다. 연결의 수명 주기를 명시적으로 제어하고 싶을 때도 유용합니다.

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
BEGIN;
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;

INSERT INTO "users" ("name") VALUES ('John Doe');
UPDATE "profiles" SET "is_complete" = true WHERE "user_id" = 1;

COMMIT;   -- or ROLLBACK if an error was caught
```

---

## NestJS와 함께 사용하기

NestJS 서비스에서도 `@Transactional()`은 똑같이 동작합니다. 리포지토리를 주입하고 메서드에 데코레이터를 붙이면 됩니다.

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

`create()`가 생성하는 SQL:

```sql
BEGIN;
INSERT INTO "cats" ("name", "age", "breed") VALUES ('Milo', 3, 'Persian') RETURNING "id";
COMMIT;
```

`updateAge()`가 생성하는 SQL:

```sql
BEGIN;
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SELECT * FROM "cats" WHERE "id" = 1;
UPDATE "cats" SET "age" = 4 WHERE "id" = 1;
COMMIT;
```

---

## 다음 단계

- [Migrations](./migrations.md): 프로덕션에서 안전하게 스키마 변경하기
- [Configuration Guide](./configuration.md): 연결 풀, 타임아웃, 읽기 레플리카 설정
- [EntityManager](./entity-manager.md): 전체 CRUD API 레퍼런스
