# Advanced Features

This document covers advanced features useful in production environments. Each section explains *why* the feature exists before showing *how* to use it. Read selectively after familiarizing yourself with basic CRUD and relationships.

## EntitySubscriber -- Per-Entity Event Subscription

### Why

The global `em.on()` listener receives events for every entity in your application. But in practice, you rarely want the same logic for all entities. When a `User` is created, you want to send a welcome email. When an `Order` is created, you want to notify the warehouse. These are different behaviors for different entities.

`EntitySubscriber` lets you write event handlers that are scoped to a single entity class. The ORM checks each event's entity type and only dispatches to the matching subscriber. This keeps your event logic organized and predictable.

### How

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
    return User; // Only receive events for this entity
  }

  async afterInsert(event: InsertEvent<User>) {
    console.log("User created:", event.entity);
  }

  async afterUpdate(event: UpdateEvent<User>) {
    console.log("User updated:", event.entity);
  }

  async afterDelete(event: DeleteEvent<User>) {
    console.log("User deleted, criteria:", event.criteria);
  }
}
```

```typescript
// Register
em.addSubscriber(new UserAuditSubscriber());

// Unregister
em.removeSubscriber(subscriber);
```

Here is the list of events supported by EntitySubscriber.

| Method | Timing |
|--------|--------|
| `afterLoad(entity)` | After loading entity from DB |
| `beforeInsert(event)` / `afterInsert(event)` | Before/after INSERT |
| `beforeUpdate(event)` / `afterUpdate(event)` | Before/after UPDATE |
| `beforeDelete(event)` / `afterDelete(event)` | Before/after DELETE |
| `beforeTransactionStart()` / `afterTransactionStart()` | Before/after transaction start |
| `beforeTransactionCommit()` / `afterTransactionCommit()` | Before/after COMMIT |
| `beforeTransactionRollback()` / `afterTransactionRollback()` | Before/after ROLLBACK |

## N+1 Detection and Slow Query Warnings

### Why

The N+1 problem is one of the most common performance killers in applications that use ORMs. It happens silently -- your code looks clean, your tests pass, but your database is drowning in queries.

Here is the scenario. You fetch a list of 10 users. For each user, you access their posts. If the ORM loads posts lazily (one query per user), you end up with:

```sql
-- The "1" query: fetch all users
SELECT "id", "name" FROM "user"

-- The "N" queries: one per user
SELECT "id", "title", "userId" FROM "post" WHERE "userId" = $1  -- user 1
SELECT "id", "title", "userId" FROM "post" WHERE "userId" = $2  -- user 2
SELECT "id", "title", "userId" FROM "post" WHERE "userId" = $3  -- user 3
-- ...7 more queries...
```

That is 11 queries for what should be 1. With 100 users, it becomes 101 queries. The fix is to use a JOIN that loads everything in a single query:

```sql
-- One query with JOIN: fetch users and their posts together
SELECT "user"."id", "user"."name", "post"."id" AS "posts_id", "post"."title" AS "posts_title"
FROM "user"
LEFT JOIN "post" ON "user"."id" = "post"."userId"
```

Stingerloom automatically detects the N+1 pattern by tracking queries per entity and warns you when it sees repeated queries for the same table within a short time window.

### How

```typescript
await em.register({
  type: "postgres",
  // ...
  logging: {
    slowQueryMs: 500,  // Warn on queries taking longer than 500ms
    nPlusOne: true,    // Enable N+1 pattern detection
  },
});
```

After configuration, you can inspect the query log.

```typescript
const log = em.getQueryLog();
// [
//   { entity: "User", sql: "SELECT ...", durationMs: 12 },
//   { entity: "Cat", sql: "SELECT ...", durationMs: 8 },
//   ...
// ]
```

> **Hint** When N+1 is detected, switch to JOIN-based loading using `eager: true` on the relation decorator, or pass the `relations` option: `em.find(User, { relations: ["posts"] })`.

## Cursor-Based Pagination

### Why

Offset pagination (`LIMIT 10 OFFSET 10000`) has a fundamental problem: to skip 10,000 rows, the database must read and discard all 10,000 of them first. The deeper you paginate, the slower it gets.

Here is the SQL comparison. Offset-based pagination at page 500:

```sql
-- Offset: the DB reads 10,000 rows, throws away 9,990, returns 10
SELECT * FROM "post" ORDER BY "id" ASC LIMIT 10 OFFSET 9990
```

Cursor-based pagination at the same position:

```sql
-- Cursor: the DB jumps directly to id > 9990, reads only 10 rows
SELECT * FROM "post" WHERE "id" > $1 ORDER BY "id" ASC LIMIT 11
-- Parameters: [9990]
```

The cursor approach uses a `WHERE` clause to jump directly to the right position in the index. Whether you are on page 1 or page 5,000, the performance is the same. The extra row (`LIMIT 11` when `take` is 10) is used to determine whether there is a next page without needing a separate COUNT query.

### How

```typescript
// First page
const page1 = await em.findWithCursor(Post, {
  take: 20,
  orderBy: "id",
  direction: "ASC",
  where: { isPublished: true },
});

// Second page -- pass nextCursor
const page2 = await em.findWithCursor(Post, {
  take: 20,
  cursor: page1.nextCursor!,
  orderBy: "id",
  direction: "ASC",
  where: { isPublished: true },
});

console.log(page2.data);        // Post[]
console.log(page2.hasNextPage); // true/false
console.log(page2.nextCursor);  // Cursor for the next page
```

Here is an example of using it in a REST API.

```typescript
// GET /posts?take=20&cursor=eyJ2IjoyMH0=
async function getPosts(req: Request, res: Response) {
  const result = await em.findWithCursor(Post, {
    take: parseInt(req.query.take as string) || 20,
    cursor: req.query.cursor as string | undefined,
    orderBy: "id",
    direction: "ASC",
  });

  res.json({
    items: result.data,
    nextCursor: result.nextCursor,
    hasNextPage: result.hasNextPage,
  });
}
```

See [Pagination & Streaming](./pagination.md) for a detailed comparison of offset vs cursor vs streaming strategies.

## Validation

### Why

Validation belongs at the entity level, not scattered across service methods. If `price` must be positive, that rule should live with the `Product` entity so it is enforced regardless of which code path saves the product.

When `save()` is called, constraints defined via decorators are automatically validated. If validation fails, a `ValidationError` is thrown before any SQL is executed -- no invalid data ever reaches the database.

### How

```typescript
import {
  Entity, Column, PrimaryGeneratedColumn,
  NotNull, MinLength, MaxLength, Min, Max,
} from "@stingerloom/orm";

@Entity()
export class Product {
  @PrimaryGeneratedColumn()
  id!: number;

  @NotNull()
  @MinLength(2)
  @MaxLength(100)
  @Column()
  name!: string;

  @Min(0)
  @Max(9999999)
  @Column({ type: "float" })
  price!: number;
}
```

```typescript
try {
  await em.save(Product, { name: "A", price: -1 });
} catch (e) {
  console.error(e.message); // "name must be at least 2 characters long"
}
```

| Decorator | Target | Description |
|-----------|--------|-------------|
| `@NotNull()` | All types | Disallow null/undefined |
| `@MinLength(n)` | string | Minimum length |
| `@MaxLength(n)` | string | Maximum length |
| `@Min(n)` | number | Minimum value |
| `@Max(n)` | number | Maximum value |

## BaseRepository -- Repository Pattern

### Why

When you repeatedly write `em.find(User, ...)`, `em.save(User, ...)`, `em.delete(User, ...)`, the `User` argument is always the same. A repository binds the EntityManager to a specific entity once, so you don't need to repeat the entity class on every call. It also provides a clear boundary -- each service works with its own repository rather than a god-object EntityManager.

### How

```typescript
const userRepo = em.getRepository(User);

// Use the same API as EntityManager without specifying the entity
const users = await userRepo.find();
const user = await userRepo.findOne({ where: { id: 1 } as any });
await userRepo.save({ name: "John Doe" });
await userRepo.delete({ id: 1 });
```

In NestJS, you can inject it into services using `@InjectRepository()`.

```typescript
@Injectable()
class UsersService {
  constructor(
    @InjectRepository(User) private readonly userRepo: BaseRepository<User>
  ) {}

  async findAll() {
    return this.userRepo.find();
  }
}
```

BaseRepository supports nearly all EntityManager methods: `find`, `findOne`, `findWithCursor`, `findAndCount`, `save`, `delete`, `softDelete`, `restore`, `insertMany`, `saveMany`, `deleteMany`, `count`, `sum`, `avg`, `min`, `max`, `explain`, `upsert`, `stream`, and `createQueryBuilder`.

```typescript
// Streaming via repository
for await (const user of userRepo.stream({ where: { isActive: true } })) {
  await process(user);
}

// Type-safe query builder via repository
const [users, total] = await userRepo
  .createQueryBuilder("u")
  .where("isActive", true)
  .orderBy({ createdAt: "DESC" })
  .skip(20)
  .take(10)
  .getManyAndCount();
```

## Streaming Large Datasets

### Why

Imagine you need to send a welcome email to all 2 million users in your database. If you run `em.find(User)`, the ORM loads all 2 million rows into memory at once. Your Node.js process runs out of memory and crashes.

`stream()` solves this by fetching rows in small batches (e.g., 500 at a time) and yielding them one at a time. Your memory usage stays constant regardless of the total number of rows.

### How It Works Internally

The ORM uses LIMIT/OFFSET batching under the hood. For a batch size of 500, the SQL looks like this:

```sql
-- Batch 1
SELECT "id", "name", "email" FROM "user" WHERE "isActive" = $1 LIMIT 500 OFFSET 0

-- Batch 2
SELECT "id", "name", "email" FROM "user" WHERE "isActive" = $1 LIMIT 500 OFFSET 500

-- Batch 3
SELECT "id", "name", "email" FROM "user" WHERE "isActive" = $1 LIMIT 500 OFFSET 1000

-- ...continues until a batch returns fewer than 500 rows
```

Each batch is fetched, yielded one entity at a time, and then discarded before the next batch is fetched. Memory usage stays proportional to the batch size, not the total row count.

### How

```typescript
// Process users one at a time (fetched in batches of 500 internally)
for await (const user of em.stream(User, { where: { isActive: true } }, 500)) {
  await sendWelcomeEmail(user.email);
}
```

Use `stream()` for ETL pipelines, data exports, batch notifications, or any task that touches a large fraction of your data. For API endpoints, prefer `find()` with pagination.

`stream()` supports all `FindOption` properties -- `where`, `orderBy`, `relations`, `select`, etc.

```typescript
// Stream posts with their authors, ordered by date
for await (const post of em.stream(Post, {
  relations: ["author"],
  orderBy: { createdAt: "DESC" },
}, 1000)) {
  await index(post);
}
```

> **Hint** `stream()` uses LIMIT/OFFSET batching internally. For consistent results on large mutable tables, wrap the stream in a transaction with `REPEATABLE READ` isolation.

See [Pagination & Streaming](./pagination.md) for more details and a comparison of all three data access strategies.

## Type-Safe Query Builder

### Why

`find()` covers 90% of queries, but sometimes you need complex JOINs, GROUP BY with aggregates, pessimistic locking, or DISTINCT. Writing raw SQL loses type safety. The `SelectQueryBuilder` gives you the full power of SQL with compile-time checking.

### How

```typescript
const [activeUsers, total] = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name", "email"])
  .where("isActive", true)
  .andWhere("age", ">=", 18)
  .orderBy({ createdAt: "DESC" })
  .skip(20)
  .take(10)
  .getManyAndCount();
```

All column references (`"id"`, `"name"`, `"isActive"`) are validated against `keyof T` -- your IDE auto-completes them, and typos become compile errors.

For more advanced SQL -- UNION, CTE, window functions -- use `RawQueryBuilder`. See the full [Query Builder](./query-builder.md) guide for both builders, and [Raw SQL & CTE](./raw-sql.md) for UNION, CTE, and window function examples.

## Deadlock Retry

### Why

A deadlock happens when two transactions are each waiting for a lock the other one holds. Neither can proceed, so the database picks one and kills it.

Here is a concrete scenario: Transaction A transfers money from Account 1 to Account 2 (locks Account 1 first, then tries to lock Account 2). Meanwhile, Transaction B transfers money from Account 2 to Account 1 (locks Account 2 first, then tries to lock Account 1). Both are stuck waiting for each other. The database detects this circular dependency and terminates one transaction with a deadlock error.

In high-concurrency systems, deadlocks are not bugs -- they are an expected fact of life. The standard solution is to retry the failed transaction.

### How

```typescript
await em.transaction(async (txEm) => {
  const account = await txEm.findOne(Account, { where: { id: fromId } });
  account.balance -= amount;
  await txEm.save(Account, account);
}, {
  retryOnDeadlock: true,
  maxRetries: 3,
  retryDelayMs: 100,
});
```

When a deadlock is caught, the transaction is rolled back and the callback re-executed from scratch. The callback must be **idempotent** -- it should produce the same result if run multiple times. See [Transactions](./transactions.md) for the full guide.

## Operational Features

Read Replica, Connection Pooling, Connection Retry, Query Timeout, and Shutdown Handling are covered in the [Configuration Guide](./configuration.md). For production-level tuning, see the [Production Guide](./production-guide.md).

## Next Steps

- [Query Builder](./query-builder.md) -- Type-safe SelectQueryBuilder
- [Raw SQL & CTE](./raw-sql.md) -- UNION, CTE, window functions
- [Events & Subscribers](./events.md) -- Detailed event system guide
- [Logging & Diagnostics](./logging.md) -- N+1 detection, slow queries, EXPLAIN
- [Plugins](./plugins.md) -- Plugin system and custom plugin authoring
- [Multi-Tenancy](./multi-tenancy.md) -- Per-tenant data isolation
- [API Reference](./api-reference.md) -- Quick method signature lookup
