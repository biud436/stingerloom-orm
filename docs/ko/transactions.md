# Transactions

## 트랜잭션이 존재하는 이유

계좌 A에서 계좌 B로 $500을 이체한다고 상상해 보세요. 이 작업에는 두 가지 연산이 필요해요:

1. 계좌 A에서 $500 차감
2. 계좌 B에 $500 추가

1단계가 끝난 뒤, 2단계 실행 전에 서버가 다운됐다고 해볼게요. 계좌 A에서는 $500이 빠져나갔는데, 계좌 B에는 입금이 안 됐어요. 돈이 사라진 거예요. 이건 가상 시나리오가 아니에요 -- 트랜잭션을 안 쓰는 애플리케이션에서 가장 흔한 데이터 손상 유형이에요.

**트랜잭션**은 데이터베이스의 약속이에요: 그룹 내 모든 연산이 함께 성공하거나, 아무것도 적용되지 않아요. 중간 상태는 없어요. 데이터베이스 이론에서는 이걸 **원자성**(atomicity)이라고 불러요 -- 연산들이 원자처럼 분할 불가능하다는 뜻이에요.

SQL 수준에서 트랜잭션은 이렇게 동작해요:

```sql
BEGIN;                                                  -- 1. Start the transaction
UPDATE "accounts" SET "balance" = "balance" - 500 WHERE "id" = 1;  -- 2. Deduct from A
UPDATE "accounts" SET "balance" = "balance" + 500 WHERE "id" = 2;  -- 3. Add to B
COMMIT;                                                 -- 4. Make both changes permanent
```

`BEGIN`과 `COMMIT` 사이에 문제가 생기면, 데이터베이스는 `COMMIT` 대신 `ROLLBACK`을 실행해요 -- `BEGIN` 이후의 모든 변경 사항을 마치 아무 일도 없었던 것처럼 되돌려요:

```sql
BEGIN;
UPDATE "accounts" SET "balance" = "balance" - 500 WHERE "id" = 1;  -- Deducted...
UPDATE "accounts" SET "balance" = "balance" + 500 WHERE "id" = 2;  -- ERROR!
ROLLBACK;                                               -- Undo everything. Both accounts unchanged.
```

Stingerloom ORM은 모든 쓰기 작업을 자동으로 트랜잭션으로 감싸요. 아래 섹션에서 이 동작을 제어하는 방법을 알아볼게요.

---

## @Transactional() -- 데코레이터 방식

메서드 위에 `@Transactional()`을 붙이면 "이 메서드 안의 모든 걸 하나의 트랜잭션으로 감싸줘"라고 Stingerloom에게 알려주는 거예요. BEGIN이나 COMMIT을 직접 쓸 필요 없어요 -- 데코레이터가 알아서 처리해요.

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

내부적으로 데코레이터가 생성하는 SQL 타임라인이에요:

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

이게 전부예요. 메서드가 정상 반환되면 커밋되고, 에러를 던지면 자동으로 롤백돼요.

---

## em.transaction() -- 콜백 방식

클래스 메서드에 데코레이터를 안 붙이고 빠르게 트랜잭션을 쓰고 싶을 때 콜백 API를 쓰면 돼요. 콜백에 트랜잭션이 적용된 EntityManager가 전달돼요. 콜백이 성공하면 커밋되고, 예외가 나면 롤백돼요.

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

생성되는 SQL은 위의 데코레이터 예제와 동일해요. 차이는 순전히 코드 스타일 문제예요:

- 클래스 메서드에 어노테이션을 달고 싶으면 `@Transactional()`을 쓰세요.
- 인라인/함수형 사용, 스크립트, 일회성 작업에는 `em.transaction()`을 쓰세요.

두 방식은 서로 교환 가능해요.

---

## 격리 수준 설정

### 격리 수준이 존재하는 이유

여러 사용자가 동시에 같은 데이터를 읽고 쓸 때, 예상 밖의 일이 생길 수 있어요. 격리 수준은 데이터베이스가 얼마나 많은 "이상 현상"을 허용할지 정하는 거예요. 안전성을 높이면 느려지고, 속도를 높이면 안전성이 낮아지는 다이얼이라고 생각하면 돼요.

네 가지 표준 격리 수준은 점점 더 미묘한 문제를 방지해요. 하나씩 시나리오와 함께 설명할게요.

### READ UNCOMMITTED -- 무법 지대

**허용되는 것:** 한 트랜잭션이 다른 트랜잭션이 아직 커밋하지 않은 데이터를 읽을 수 있어요 ("더티 리드").

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

트랜잭션 B는 실제로 존재한 적 없는 데이터를 읽은 거예요. 실무에서 이 수준을 쓰는 경우는 거의 없어요.

### READ COMMITTED -- 기본값

**방지하는 것:** 더티 리드. 커밋된 데이터만 읽을 수 있어요.

**허용되는 것:** 비반복 읽기(Non-repeatable read) -- 같은 행을 두 번 읽을 때, 그 사이에 다른 트랜잭션이 변경을 커밋했다면 다른 값이 나올 수 있어요.

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

트랜잭션 A가 같은 행을 두 번 읽었는데 값이 달라요. 대부분의 앱에서는 문제가 안 되고, 그래서 READ COMMITTED가 기본값이에요.

### REPEATABLE READ -- 일관된 스냅샷

**방지하는 것:** 더티 리드와 비반복 읽기. 한번 읽은 행은 트랜잭션이 끝날 때까지 같은 값을 유지해요.

**허용되는 것:** 팬텀 리드(Phantom read) -- 쿼리 조건에 맞는 새 행이 읽기 사이에 나타날 수 있어요.

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

은행 이체나 재무 보고서처럼 트랜잭션 내에서 일관된 읽기가 필요할 때 이 수준을 쓰세요.

### SERIALIZABLE -- 최대 안전성

**방지하는 것:** 위의 모든 것(팬텀 리드 포함). 데이터베이스가 트랜잭션들을 마치 순서대로 하나씩 실행한 것처럼 동작해요.

**트레이드오프:** 충돌이 감지되면 직렬화 오류로 트랜잭션이 거부될 수 있고, 재시도해야 해요.

처리량보다 절대적인 정확성이 중요할 때 쓰세요. 재고 차감이나 좌석 예약 같은 경우가 해당돼요.

### 요약 표

| 격리 수준 | 더티 리드 | 비반복 읽기 | 팬텀 리드 | 성능 |
|----------------|-----------|-------------------|-------------|-------------|
| `READ UNCOMMITTED` | 가능 | 가능 | 가능 | 가장 빠름 |
| `READ COMMITTED` | 방지 | 가능 | 가능 | 양호 (기본값) |
| `REPEATABLE READ` | 방지 | 방지 | 가능 | 느림 |
| `SERIALIZABLE` | 방지 | 방지 | 방지 | 가장 느림 |

### Stingerloom에서 격리 수준 사용하기

`@Transactional()`에 문자열 인자로 격리 수준을 전달하면 돼요:

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

**데드락**은 두 트랜잭션이 각각 상대방이 필요한 잠금을 갖고 있어서, 어느 쪽도 진행할 수 없는 상태예요. 데이터베이스가 이 순환 대기를 감지하고 하나를 종료해요.

데드락이 어떻게 발생하는지 볼게요:

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

높은 동시성 환경에서 데드락은 버그가 아니에요 -- DB 운영의 정상적인 부분이에요. 올바른 대응은 재시도예요.

### 자동 재시도

데드락이 나면 바로 실패하는 대신, Stingerloom에게 자동으로 재시도하라고 지시할 수 있어요:

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

데드락이 감지되면 ORM이 이렇게 해요:
1. 데드락 에러를 포착해요
2. `retryDelayMs`만큼 대기해요 (같은 두 트랜잭션이 바로 다시 충돌하는 걸 방지해요)
3. 전체 콜백을 처음부터 다시 실행해요
4. `maxRetries` 횟수까지 실패하면 마지막 에러를 throw해요

콜백은 **멱등성**(idempotent)을 가져야 해요 -- 몇 번을 실행하든 같은 결과를 내야 해요. 콜백 외부에서 캡처한 값에 의존하지 말고, 매 시도 시작할 때 새로 데이터를 읽어야 해요.

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

> 데드락 재시도는 `em.transaction()`에서만 쓸 수 있어요. `@Transactional()` 데코레이터는 지원하지 않아요 -- 데드락이 발생할 가능성이 높은 작업(재고 차감, 카운터 증가 등)에는 `em.transaction()`을 쓰세요.

---

## 중첩 트랜잭션

### 중첩이 중요한 이유

`@Transactional()` 메서드가 다른 `@Transactional()` 메서드를 호출할 때, 별도 트랜잭션 두 개를 원하는 게 아니에요 -- 하나를 공유하고 싶은 거예요. 바깥 메서드가 롤백되면 안쪽 메서드의 작업도 함께 롤백돼야 해요.

이게 기본 동작이고 `REQUIRED` 전파라고 불러요. 트랜잭션이 이미 있으면 합류하고, 없으면 새로 만들어요.

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

`createUserWithProfile()` 호출 시 SQL 타임라인이에요:

```sql
BEGIN;                                                              -- outer @Transactional starts

INSERT INTO "users" ("name", "email") VALUES ('John', 'j@x.com') RETURNING "id";

-- createProfile() is called, but no new BEGIN -- it joins the existing transaction

INSERT INTO "profiles" ("user_id", "bio") VALUES (1, 'Hello world');

COMMIT;                                                             -- outer @Transactional commits both
```

`BEGIN`도 하나, `COMMIT`도 하나뿐이에요. 두 INSERT 모두 같은 트랜잭션 안에 있어요.

### 전파 전략

Stingerloom은 세 가지 전파 모드를 지원합니다.

| 전파 방식 | 동작 |
|-------------|----------|
| `REQUIRED` (기본값) | 기존 트랜잭션이 있으면 합류, 없으면 새로 생성 |
| `REQUIRES_NEW` | 항상 새 독립 트랜잭션 생성 (새 DB 연결) |
| `NESTED` | 기존 트랜잭션 내에 savepoint 생성, 실패 시 해당 savepoint만 롤백 |

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

트랜잭션 안에서 위험한 작업을 시도하고, 실패하면 그것만 되돌리고 나머지는 유지하고 싶을 때가 있어요. Savepoint가 없으면 실패 = 전체 롤백이에요. Savepoint를 쓰면 특정 체크포인트로만 되돌릴 수 있어요.

비디오 게임의 "세이브"와 같다고 생각하면 돼요. 보스전 전에 저장하고, 죽으면 그 지점에서 다시 불러와요 -- 게임을 처음부터 다시 시작하지 않아요.

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

트랜잭션 경계를 완전히 제어하려면 `TransactionSessionManager`를 직접 쓰면 돼요. 트랜잭션 로직과 비DB 작업을 교차해야 하거나, 연결 수명 주기를 명시적으로 제어하고 싶을 때 유용해요.

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

NestJS 서비스에서 `@Transactional()`은 똑같이 동작해요. 리포지토리를 주입하고 메서드에 데코레이터를 붙이면 돼요:

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
