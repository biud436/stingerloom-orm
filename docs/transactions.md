# Transactions

When creating an order, you need to save the order information, order items, and payment information all together. If any one of them fails, the rest should also be canceled. This is a **transaction** — grouping multiple operations into a single unit so that they either all succeed or all fail.

The easiest way to use transactions in Stingerloom ORM is with the `@Transactional()` decorator.

## @Transactional()

Adding `@Transactional()` above a method makes the entire method execute as a single transaction.

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
    // If all succeed -> COMMIT
    // If any fails -> ROLLBACK (1, 2, 3 all canceled)
  }
}
```

That's all there is to it. If an error occurs, it automatically ROLLBACKs, and on normal completion, it automatically COMMITs.

## em.transaction() — Callback API

For cases where you want a quick, self-contained transaction without a decorator, use the `em.transaction()` callback API. The callback receives a transactional EntityManager; if the callback returns successfully, the transaction is committed. If it throws, the transaction is automatically rolled back.

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
  // COMMIT on success, ROLLBACK on error
});
```

This approach is ideal for service methods, scripts, and anywhere you need a one-off transaction without creating a class method with `@Transactional()`.

> **Hint** `@Transactional()` and `em.transaction()` are interchangeable. Use `@Transactional()` when you want to annotate a class method, and `em.transaction()` for inline/functional usage.

## Deadlock Retry

A **deadlock** occurs when two transactions each hold a lock that the other needs. The database detects this and kills one of the transactions with an error. In high-concurrency environments, deadlocks are not bugs — they are a normal part of database operation.

Instead of failing immediately, you can tell Stingerloom to automatically retry the transaction when a deadlock is detected.

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

When `retryOnDeadlock` is enabled, the ORM catches deadlock errors and re-executes the entire callback from scratch. This means your callback must be **idempotent** — it should produce the same result regardless of how many times it runs.

The deadlock detection works across all three databases:

| Database | Detection |
|----------|-----------|
| MySQL | `errno 1213` (ER_LOCK_DEADLOCK) |
| PostgreSQL | Error code `40P01` (deadlock_detected) |
| SQLite | `SQLITE_BUSY` or "database is locked" message |

### TransactionOptions

```typescript
interface TransactionOptions {
  retryOnDeadlock?: boolean;  // Enable deadlock retry (default: false)
  maxRetries?: number;        // Maximum retries (default: 3)
  retryDelayMs?: number;      // Delay between retries in ms (default: 100)
}
```

The delay between retries helps prevent the same two transactions from immediately deadlocking again. After `maxRetries` attempts, the last error is thrown normally.

> **Hint** Deadlock retry is only available with the `em.transaction()` callback API. The `@Transactional()` decorator does not support it — use `em.transaction()` for operations where deadlocks are likely (e.g., inventory deduction, counter increments).

## Setting Isolation Levels

When multiple users read and write the same data simultaneously, you can specify how much isolation to enforce.

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

Higher isolation levels are safer but lower in performance. In most cases, the default (`READ COMMITTED`) is sufficient.

| Isolation Level | Safety | Performance | When to Use |
|----------------|--------|-------------|-------------|
| `READ UNCOMMITTED` | Low | High | Rarely used |
| `READ COMMITTED` | Moderate | Moderate | Default, most cases |
| `REPEATABLE READ` | High | Low | When consistent reads are needed, like bank transfers |
| `SERIALIZABLE` | Highest | Lowest | When conflicts must absolutely be prevented, like inventory deduction |

## Nested Transactions

When a `@Transactional` method calls another `@Transactional` method, it reuses the existing transaction instead of starting a new one.

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
    // When called from above -> reuses existing transaction
    // When called independently -> starts a new transaction
    return em.save(Profile, { userId, ...profileData });
  }
}
```

## Manual Transaction Management

Instead of decorators, you can use `TransactionSessionManager` directly. This is useful when you need fine-grained control over transaction boundaries.

```typescript
import { TransactionSessionManager } from "@stingerloom/orm";
import sql from "sql-template-tag";

const session = new TransactionSessionManager();

try {
  await session.connect();
  await session.startTransaction("READ COMMITTED");

  await session.query(sql`INSERT INTO "users" ("name") VALUES (${"John Doe"})`);
  await session.query(sql`UPDATE "profiles" SET "is_complete" = ${true} WHERE "user_id" = ${1}`);

  await session.commit();
} catch (error) {
  await session.rollback();
  throw error;
} finally {
  await session.close();
}
```

## Savepoint — Partial Rollback

When you want to roll back to a specific point without rolling back the entire transaction, use Savepoints.

```typescript
const session = new TransactionSessionManager();

try {
  await session.connect();
  await session.startTransaction();

  // Task 1: Create user
  await session.query(sql`INSERT INTO "users" ("name") VALUES (${"John Doe"})`);

  // Save the state up to this point
  await session.query("SAVEPOINT sp1");

  try {
    // Task 2: Risky operation
    await session.query(sql`UPDATE "accounts" SET "balance" = ${-100} WHERE "id" = ${1}`);
  } catch {
    // Roll back only task 2 (task 1 is preserved)
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

## Using with NestJS

In NestJS services, use `@Transactional()` the same way.

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

## Next Steps

- [Migrations](./migrations.md) — Safely change schema in production
- [Configuration Guide](./configuration.md) — Pooling, timeouts, Read Replica settings
- [EntityManager](./entity-manager.md) — Full CRUD API reference
