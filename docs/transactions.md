# Transactions

## Why Transactions Exist

Imagine you are transferring $500 from Account A to Account B. This requires two operations:

1. Subtract $500 from Account A
2. Add $500 to Account B

Now imagine the server crashes after step 1 but before step 2. Account A lost $500, but Account B never received it. The money vanished. This is not a hypothetical -- it is the most common category of data corruption in applications that skip transactions.

A **transaction** is a promise from the database: either ALL operations in the group succeed together, or NONE of them take effect. There is no in-between state. The database literature calls this property **atomicity** -- the operations are indivisible, like an atom.

Here is what a transaction looks like at the SQL level:

```sql
BEGIN;                                                  -- 1. Start the transaction
UPDATE "accounts" SET "balance" = "balance" - 500 WHERE "id" = 1;  -- 2. Deduct from A
UPDATE "accounts" SET "balance" = "balance" + 500 WHERE "id" = 2;  -- 3. Add to B
COMMIT;                                                 -- 4. Make both changes permanent
```

If anything goes wrong between `BEGIN` and `COMMIT`, the database executes `ROLLBACK` instead -- which erases every change made since `BEGIN`, as if none of them ever happened:

```sql
BEGIN;
UPDATE "accounts" SET "balance" = "balance" - 500 WHERE "id" = 1;  -- Deducted...
UPDATE "accounts" SET "balance" = "balance" + 500 WHERE "id" = 2;  -- ERROR!
ROLLBACK;                                               -- Undo everything. Both accounts unchanged.
```

Stingerloom ORM wraps every write operation in a transaction automatically. The sections below show you how to control that behavior.

---

## @Transactional() -- The Decorator Approach

Adding `@Transactional()` above a method tells Stingerloom: "Wrap everything inside this method in a single transaction." You do not write BEGIN or COMMIT yourself -- the decorator handles it.

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

Behind the scenes, the decorator generates this SQL timeline:

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

That is all there is to it. If the method returns normally, the transaction commits. If the method throws an error, the transaction rolls back automatically.

---

## em.transaction() -- The Callback Approach

For cases where you want a quick, self-contained transaction without decorating a class method, use the callback API. The callback receives a transactional EntityManager. If the callback succeeds, the transaction commits. If it throws, the transaction rolls back.

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

The generated SQL is identical to the decorator example above. The difference is purely a matter of code style:

- Use `@Transactional()` when you want to annotate a class method.
- Use `em.transaction()` for inline/functional usage, scripts, or one-off operations.

They are interchangeable. The second argument accepts the **same** `isolationLevel`, `propagation`, and `connectionName` options the decorator does (plus optional deadlock retry), so nothing requires the decorator:

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

See the [Decorator-Free Guide](./decorator-free.md#transactions-without-transactional) for the complete option reference.

---

## Setting Isolation Levels

### Why Isolation Levels Exist

When multiple users read and write the same data at the same time, strange things can happen. Isolation levels control how much "strangeness" the database allows. Think of it as a dial: turn it up for more safety, turn it down for more speed.

The four standard isolation levels protect against increasingly subtle problems. Here is each one, explained with concrete scenarios.

### READ UNCOMMITTED -- The Wild West

**What it allows:** One transaction can read data that another transaction has written but not yet committed (a "dirty read").

**Scenario -- The Dirty Read:**
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

Transaction B saw data that never actually existed. In practice, you almost never use this level.

### READ COMMITTED -- The Default

**What it prevents:** Dirty reads. You only see data that has been committed.

**What it allows:** Non-repeatable reads -- if you read the same row twice within one transaction, you might get different values because another transaction committed a change between your two reads.

**Scenario -- The Non-Repeatable Read:**
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

Transaction A read the same row twice and got two different answers. This is fine for most applications, which is why READ COMMITTED is the default.

### REPEATABLE READ -- Consistent Snapshots

**What it prevents:** Dirty reads AND non-repeatable reads. Once you read a row, it stays the same for the rest of your transaction.

**What it allows:** Phantom reads -- new rows that match your query criteria can appear between reads.

**Scenario -- The Phantom Read:**
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

Use this level when you need consistent reads within a single transaction, such as bank transfers or financial reports.

### SERIALIZABLE -- Maximum Safety

**What it prevents:** Everything above, including phantom reads. The database behaves as if transactions ran one at a time, in sequence.

**Trade-off:** The database may reject a transaction with a serialization error if it detects a conflict, and you must retry it.

Use this level when absolute correctness matters more than throughput, such as inventory deduction or seat booking.

### Summary Table

| Isolation Level | Dirty Read | Non-Repeatable Read | Phantom Read | Performance |
|----------------|-----------|-------------------|-------------|-------------|
| `READ UNCOMMITTED` | Possible | Possible | Possible | Fastest |
| `READ COMMITTED` | Prevented | Possible | Possible | Good (default) |
| `REPEATABLE READ` | Prevented | Prevented | Possible | Slower |
| `SERIALIZABLE` | Prevented | Prevented | Prevented | Slowest |

### Using Isolation Levels in Stingerloom

Pass the level as a string argument to `@Transactional()`:

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

The generated SQL:

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

## Deadlock Retry

### Why Deadlocks Happen

A **deadlock** is when two transactions each hold a lock that the other needs, so neither can proceed. The database detects this circular wait and kills one of them.

Here is exactly how it happens:

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

In high-concurrency environments, deadlocks are not bugs -- they are a normal part of database operation. The correct response is to retry.

### Automatic Retry

Instead of failing immediately on a deadlock, you can tell Stingerloom to retry the transaction automatically:

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

When a deadlock is detected, the ORM:
1. Catches the deadlock error
2. Waits for `retryDelayMs` milliseconds (the delay helps prevent the same two transactions from immediately colliding again)
3. Re-executes the entire callback from scratch
4. After `maxRetries` failed attempts, throws the last error normally

Your callback must be **idempotent** -- it should produce the same result regardless of how many times it runs. This means reading fresh data at the start of each attempt, not relying on values captured outside the callback.

### Deadlock Detection Across Databases

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

  // Decorator-free parity with @Transactional
  isolationLevel?: TRANSACTION_ISOLATION_LEVEL;  // e.g. "SERIALIZABLE"
  propagation?: TransactionPropagation;          // REQUIRED | REQUIRES_NEW | NESTED
  connectionName?: string;                       // multi-DB target connection
}
```

> Deadlock retry is only available with `em.transaction()`. The `@Transactional()` decorator does not support it -- use `em.transaction()` for operations where deadlocks are likely (e.g., inventory deduction, counter increments). Every *other* `@Transactional` option (isolation level, propagation, connection) is available on `em.transaction()` too, so the decorator is never required.

---

## Nested Transactions

### Why Nesting Matters

When a `@Transactional()` method calls another `@Transactional()` method, you do not want two separate transactions -- you want them to share one. If the outer method rolls back, the inner method's work should roll back too.

This is the default behavior (called `REQUIRED` propagation). If a transaction already exists, the inner method joins it. If no transaction exists, a new one is created.

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

The SQL timeline when `createUserWithProfile()` is called:

```sql
BEGIN;                                                              -- outer @Transactional starts

INSERT INTO "users" ("name", "email") VALUES ('John', 'j@x.com') RETURNING "id";

-- createProfile() is called, but no new BEGIN -- it joins the existing transaction

INSERT INTO "profiles" ("user_id", "bio") VALUES (1, 'Hello world');

COMMIT;                                                             -- outer @Transactional commits both
```

There is only one `BEGIN` and one `COMMIT`. Both inserts live in the same transaction.

### Propagation Strategies

Stingerloom supports three propagation modes:

| Propagation | Behavior |
|-------------|----------|
| `REQUIRED` (default) | Join the existing transaction if one exists; otherwise create a new one |
| `REQUIRES_NEW` | Always create a new, independent transaction (new database connection) |
| `NESTED` | Create a savepoint within the existing transaction; rollback only the savepoint on failure |

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

## Savepoint -- Partial Rollback

### Why Savepoints Exist

Sometimes you want to attempt a risky operation inside a transaction, and if it fails, undo just that operation while keeping everything else. Without savepoints, a failure means rolling back the entire transaction. With savepoints, you can roll back to a specific checkpoint.

Think of it like "save game" in a video game. You save before a boss fight. If you die, you reload from that save point -- you do not restart the entire game.

### How It Works at the SQL Level

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

### Using Savepoints in Code

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

## Manual Transaction Management

For full control over transaction boundaries, use `TransactionSessionManager` directly. This is useful when you need to interleave transaction logic with non-database operations, or when you want explicit control over the connection lifecycle.

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

The generated SQL:

```sql
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
BEGIN;

INSERT INTO "users" ("name") VALUES ('John Doe');
UPDATE "profiles" SET "is_complete" = true WHERE "user_id" = 1;

COMMIT;   -- or ROLLBACK if an error was caught
```

---

## Using with NestJS

In NestJS services, `@Transactional()` works exactly the same way. Inject your repository and decorate the method:

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

The `create()` method generates:

```sql
BEGIN;
INSERT INTO "cats" ("name", "age", "breed") VALUES ('Milo', 3, 'Persian') RETURNING "id";
COMMIT;
```

The `updateAge()` method generates:

```sql
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
BEGIN;
SELECT * FROM "cats" WHERE "id" = 1;
UPDATE "cats" SET "age" = 4 WHERE "id" = 1;
COMMIT;
```

---

## Next Steps

- [Migrations](./migrations.md) -- Safely change schema in production
- [Configuration Guide](./configuration.md) -- Pooling, timeouts, Read Replica settings
- [EntityManager](./entity-manager.md) -- Full CRUD API reference
