# 트랜잭션 (Transactions)

주문을 생성할 때 주문 정보, 주문 항목, 결제 정보를 모두 저장해야 합니다. 이 중 하나라도 실패하면 나머지도 취소되어야 합니다. 이것이 **트랜잭션**입니다 — 여러 작업을 하나의 단위로 묶어서 전부 성공하거나 전부 실패하게 만드는 것입니다.

Stingerloom ORM에서 트랜잭션을 사용하는 가장 쉬운 방법은 `@Transactional()` 데코레이터입니다.

## @Transactional()

메서드 위에 `@Transactional()`을 붙이면 그 메서드 전체가 하나의 트랜잭션으로 실행됩니다.

```typescript
import { Transactional } from "@stingerloom/orm";

class OrderService {
  @Transactional()
  async createOrder(data: CreateOrderDto): Promise<Order> {
    // 1. 주문 생성
    const order = await em.save(Order, {
      userId: data.userId,
      status: "pending",
    });

    // 2. 주문 항목 삽입
    await em.insertMany(OrderItem, data.items.map(item => ({
      orderId: order.id,
      productId: item.productId,
      quantity: item.quantity,
    })));

    // 3. 결제 정보 저장
    await em.save(Payment, {
      orderId: order.id,
      amount: data.totalAmount,
    });

    return order;
    // 모두 성공하면 → COMMIT
    // 하나라도 실패하면 → ROLLBACK (1, 2, 3 모두 취소)
  }
}
```

이것이 전부입니다. 에러가 발생하면 자동으로 ROLLBACK되고, 정상 완료되면 자동으로 COMMIT됩니다.

## 격리 수준 설정

동시에 여러 사용자가 같은 데이터를 읽고 쓸 때, 어느 수준까지 격리할지 지정할 수 있습니다.

```typescript
@Transactional("REPEATABLE READ")
async transfer(fromId: number, toId: number, amount: number) {
  const from = await em.findOne(Account, { where: { id: fromId } });
  const to = await em.findOne(Account, { where: { id: toId } });

  if (!from || from.balance < amount) {
    throw new Error("잔액 부족");
  }

  await em.save(Account, { ...from, balance: from.balance - amount });
  await em.save(Account, { ...to, balance: to.balance + amount });
}
```

격리 수준은 높을수록 안전하지만 성능이 낮아집니다. 대부분의 경우 기본값(`READ COMMITTED`)이면 충분합니다.

| 격리 수준 | 안전성 | 성능 | 언제 사용? |
|---------|-------|------|-----------|
| `READ UNCOMMITTED` | 낮음 | 높음 | 거의 사용하지 않음 |
| `READ COMMITTED` | 보통 | 보통 | 기본값, 대부분의 경우 |
| `REPEATABLE READ` | 높음 | 낮음 | 계좌 이체처럼 일관된 읽기가 필요할 때 |
| `SERIALIZABLE` | 최고 | 최저 | 재고 차감처럼 절대 충돌이 없어야 할 때 |

## 중첩 트랜잭션

`@Transactional` 메서드가 다른 `@Transactional` 메서드를 호출하면, 새 트랜잭션을 시작하지 않고 기존 트랜잭션을 재사용합니다.

```typescript
class UserService {
  @Transactional()
  async createUserWithProfile(data: CreateUserDto) {
    const user = await em.save(User, { name: data.name, email: data.email });
    await this.createProfile(user.id, data.profileData); // 같은 트랜잭션
    return user;
  }

  @Transactional()
  async createProfile(userId: number, profileData: any) {
    // 위에서 호출되면 → 기존 트랜잭션 재사용
    // 단독으로 호출되면 → 새 트랜잭션 시작
    return em.save(Profile, { userId, ...profileData });
  }
}
```

## 수동 트랜잭션 관리

데코레이터 대신 `TransactionSessionManager`를 직접 사용할 수도 있습니다. 트랜잭션 경계를 세밀하게 제어해야 할 때 유용합니다.

```typescript
import { TransactionSessionManager } from "@stingerloom/orm";
import sql from "sql-template-tag";

const session = new TransactionSessionManager();

try {
  await session.connect();
  await session.startTransaction("READ COMMITTED");

  await session.query(sql`INSERT INTO "users" ("name") VALUES (${"홍길동"})`);
  await session.query(sql`UPDATE "profiles" SET "is_complete" = ${true} WHERE "user_id" = ${1}`);

  await session.commit();
} catch (error) {
  await session.rollback();
  throw error;
} finally {
  await session.close();
}
```

## Savepoint — 부분 롤백

트랜잭션 전체를 롤백하지 않고, 특정 지점까지만 되돌리고 싶을 때 Savepoint를 사용합니다.

```typescript
const session = new TransactionSessionManager();

try {
  await session.connect();
  await session.startTransaction();

  // 작업 1: 사용자 생성
  await session.query(sql`INSERT INTO "users" ("name") VALUES (${"홍길동"})`);

  // 여기까지의 상태를 저장
  await session.query("SAVEPOINT sp1");

  try {
    // 작업 2: 위험한 작업
    await session.query(sql`UPDATE "accounts" SET "balance" = ${-100} WHERE "id" = ${1}`);
  } catch {
    // 작업 2만 롤백 (작업 1은 유지됨)
    await session.query("ROLLBACK TO SAVEPOINT sp1");
  }

  await session.query("RELEASE SAVEPOINT sp1");
  await session.commit();
} catch (error) {
  await session.rollback();
  throw error;
} finally {
  await session.close();
}
```

## NestJS에서 사용하기

NestJS 서비스에서도 동일하게 `@Transactional()`을 사용합니다.

```typescript
// cats.service.ts
import { Injectable } from "@nestjs/common";
import { Transactional, BaseRepository } from "@stingerloom/orm";
import { InjectRepository } from "../stingerloom-orm/inject-repository.decorator";
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

## 다음 단계

- [마이그레이션](./migrations.md) — 프로덕션에서 스키마를 안전하게 변경하기
- [설정 가이드](./configuration.md) — 풀링, 타임아웃, Read Replica 설정
- [EntityManager](./entity-manager.md) — CRUD API 전체 보기
