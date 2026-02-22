# 트랜잭션 관리 (Transactions)

Stingerloom ORM은 모든 CRUD 연산을 자동으로 트랜잭션으로 래핑합니다. 추가로 `@Transactional()` 데코레이터와 `TransactionSessionManager`를 통해 수동 트랜잭션 관리도 지원합니다.

---

## @Transactional()

메서드를 데이터베이스 트랜잭션으로 래핑하는 데코레이터입니다. `AsyncLocalStorage`를 사용하여 중첩 호출 시 동일한 트랜잭션 세션을 재사용합니다.

**시그니처**

```typescript
function Transactional(isolationLevel?: TRANSACTION_ISOLATION_LEVEL): MethodDecorator

type TRANSACTION_ISOLATION_LEVEL =
  | "READ UNCOMMITTED"
  | "READ COMMITTED"
  | "REPEATABLE READ"
  | "SERIALIZABLE";
```

**동작 방식**

1. `TransactionSessionManager` 생성 및 DB 연결
2. `START TRANSACTION` (MySQL) 또는 `BEGIN` (PostgreSQL) 실행
3. 메서드 실행
4. 성공 시 `COMMIT`, 오류 시 `ROLLBACK` 및 예외 재발생
5. 중첩된 `@Transactional` 메서드는 이미 활성화된 세션을 재사용 (새 트랜잭션 시작 안 함)

**기본 예제**

```typescript
import { Transactional } from "stingerloom-orm";

class OrderService {
  @Transactional()
  async createOrder(data: CreateOrderDto): Promise<Order> {
    // 이 블록 전체가 하나의 트랜잭션
    const order = await em.save(Order, {
      userId: data.userId,
      status: "pending",
    });

    await em.insertMany(OrderItem, data.items.map(item => ({
      orderId: order.id,
      productId: item.productId,
      quantity: item.quantity,
    })));

    await em.save(Payment, {
      orderId: order.id,
      amount: data.totalAmount,
    });

    return order;
    // 오류가 없으면 자동 COMMIT
    // 오류 발생 시 자동 ROLLBACK
  }
}
```

---

## 격리 수준 (Isolation Level)

`@Transactional()`에 격리 수준을 인자로 전달할 수 있습니다.

| 격리 수준 | 설명 | Dirty Read | Non-repeatable Read | Phantom Read |
|---------|------|-----------|---------------------|-------------|
| `READ UNCOMMITTED` | 가장 낮은 격리 수준 | 가능 | 가능 | 가능 |
| `READ COMMITTED` | 커밋된 데이터만 읽음 (기본값) | 방지 | 가능 | 가능 |
| `REPEATABLE READ` | 동일 쿼리 결과 보장 | 방지 | 방지 | 가능 |
| `SERIALIZABLE` | 가장 높은 격리 수준 | 방지 | 방지 | 방지 |

```typescript
import { Transactional } from "stingerloom-orm";

class BankService {
  // 반복 가능한 읽기
  @Transactional("REPEATABLE READ")
  async transfer(fromId: number, toId: number, amount: number): Promise<void> {
    const from = await em.findOne(Account, { where: { id: fromId } });
    const to = await em.findOne(Account, { where: { id: toId } });

    if (!from || from.balance < amount) {
      throw new Error("잔액 부족");
    }

    await em.save(Account, { ...from, balance: from.balance - amount });
    await em.save(Account, { ...to, balance: to.balance + amount });
  }

  // 직렬화 격리 — 최고 수준의 안전성
  @Transactional("SERIALIZABLE")
  async criticalUpdate(): Promise<void> {
    // ...
  }
}
```

---

## 중첩 트랜잭션

`@Transactional` 데코레이터가 붙은 메서드가 다른 `@Transactional` 메서드를 호출하면, 이미 활성화된 트랜잭션 세션을 재사용합니다. 별도의 트랜잭션이 시작되지 않습니다.

```typescript
class UserService {
  @Transactional()
  async createUserWithProfile(data: CreateUserDto): Promise<User> {
    const user = await em.save(User, { name: data.name, email: data.email });
    // 아래 메서드도 같은 트랜잭션 내에서 실행됨
    await this.createProfile(user.id, data.profileData);
    return user;
  }

  @Transactional()
  async createProfile(userId: number, profileData: any): Promise<Profile> {
    // 이미 활성화된 트랜잭션 재사용 (새 트랜잭션 시작 안 함)
    return em.save(Profile, { userId, ...profileData });
  }
}
```

---

## TransactionSessionManager 직접 사용

`@Transactional()` 없이 수동으로 트랜잭션을 관리할 수 있습니다.

```typescript
import { TransactionSessionManager } from "stingerloom-orm";

const session = new TransactionSessionManager();

try {
  await session.connect();
  await session.startTransaction("READ COMMITTED");

  // MySQL/MariaDB: autocommit 비활성화 필요
  await session.query("SET autocommit = 0");

  // 쿼리 실행
  await session.query(sql`INSERT INTO \`users\` (\`name\`) VALUES (${"홍길동"})`);
  await session.query(sql`UPDATE \`profiles\` SET \`is_complete\` = ${true} WHERE \`user_id\` = ${1}`);

  await session.commit();
} catch (error) {
  await session.rollback();
  throw error;
} finally {
  await session.close();
}
```

---

## Savepoint

트랜잭션 내에서 부분 롤백을 지원하는 Savepoint를 사용할 수 있습니다.

```typescript
import { TransactionSessionManager } from "stingerloom-orm";

const session = new TransactionSessionManager();

try {
  await session.connect();
  await session.startTransaction();

  // 작업 1: 사용자 생성
  await session.query(sql`INSERT INTO \`users\` (\`name\`) VALUES (${"홍길동"})`);

  // Savepoint 생성
  await session.query("SAVEPOINT sp1");

  try {
    // 작업 2: 위험한 작업
    await session.query(sql`UPDATE \`accounts\` SET \`balance\` = ${-100} WHERE \`id\` = ${1}`);
  } catch (innerError) {
    // 작업 2만 롤백 (작업 1은 유지)
    await session.query("ROLLBACK TO SAVEPOINT sp1");
    console.log("작업 2 롤백, 작업 1 유지");
  }

  // Savepoint 해제
  await session.query("RELEASE SAVEPOINT sp1");

  await session.commit();
} catch (error) {
  await session.rollback();
  throw error;
} finally {
  await session.close();
}
```

---

## NestJS에서 @Transactional 사용

NestJS 서비스에서 `@Transactional()` 데코레이터를 사용합니다.

```typescript
import { Injectable } from "@nestjs/common";
import { Transactional, BaseRepository } from "stingerloom-orm";
import { InjectRepository } from "../stingerloom-orm/inject-repository.decorator";
import { Cat } from "./cat.entity";

@Injectable()
export class CatsService {
  constructor(
    @InjectRepository(Cat) private readonly catRepo: BaseRepository<Cat>,
  ) {}

  // 트랜잭션 범위 내에서 고양이 생성
  @Transactional()
  async create(dto: CreateCatDto): Promise<Cat> {
    const cat = new Cat();
    cat.name = dto.name;
    cat.age = dto.age;
    cat.breed = dto.breed;

    return this.catRepo.save(cat) as Promise<Cat>;
  }

  // 격리 수준 지정
  @Transactional("REPEATABLE READ")
  async updateAge(id: number, age: number): Promise<Cat> {
    const cat = await this.catRepo.findOne({ where: { id } as any });
    cat.age = age;
    return this.catRepo.save(cat) as Promise<Cat>;
  }
}
```
