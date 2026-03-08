# Advanced Features

This document covers advanced features useful in production environments. Read selectively after familiarizing yourself with basic CRUD and relationships.

## EntitySubscriber — Per-Entity Event Subscription

`em.on()` receives events for all entities, but `EntitySubscriber` lets you receive events for specific entities only.

For example, to log an audit trail whenever a User is created, updated, or deleted:

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

The **N+1 problem** is a pattern where, after querying a list, each item's relationships are fetched with individual queries. With 10 items, this results in 1 + 10 = 11 queries. Stingerloom automatically detects this pattern and issues warnings.

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

> **Hint** When N+1 is detected, switch to JOIN-based loading using `eager: true` or the `relations` option.

## Cursor-Based Pagination

The offset approach (`LIMIT 10 OFFSET 10000`) gets slower as the dataset grows. Cursor-based pagination remembers the position of the last item, ensuring consistent performance.

```typescript
// First page
const page1 = await em.findWithCursor(Post, {
  take: 20,
  orderBy: "id",
  direction: "ASC",
  where: { isPublished: true },
});

// Second page — pass nextCursor
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

## Validation

When `save()` is called, constraints defined via decorators are automatically validated. If validation fails, a `ValidationError` is thrown.

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

## BaseRepository — Repository Pattern

`BaseRepository` is a wrapper that binds EntityManager methods to a specific entity.

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

BaseRepository supports nearly all EntityManager methods: `find`, `findOne`, `findWithCursor`, `findAndCount`, `save`, `delete`, `softDelete`, `restore`, `insertMany`, `saveMany`, `deleteMany`, `count`, `sum`, `avg`, `min`, `max`, `explain`, `upsert`.

## Read Replica — Read/Write Splitting

The `replication` option automatically routes writes to master and reads to slave.

```typescript
await em.register({
  type: "mysql",
  host: "master.example.com",
  port: 3306,
  username: "root",
  password: "password",
  database: "mydb",
  entities: [User, Post],
  synchronize: true,
  replication: {
    master: {
      host: "master.example.com",
      port: 3306,
      username: "root",
      password: "password",
      database: "mydb",
    },
    slaves: [
      {
        host: "replica1.example.com",
        port: 3306,
        username: "readonly",
        password: "password",
        database: "mydb",
      },
      {
        host: "replica2.example.com",
        port: 3306,
        username: "readonly",
        password: "password",
        database: "mydb",
      },
    ],
  },
});
```

- **Write queries** (`save`, `delete`, `upsert`, etc.) -> always go to master
- **Read queries** (`find`, `findOne`, `count`, etc.) -> round-robin across slaves
- **Slave failure** -> automatic fallback to master

When you need to read the latest data immediately after a write, use the `useMaster` option.

```typescript
await em.save(User, { id: 1, name: "Updated" });

// Read directly from master without replica lag
const user = await em.findOne(User, {
  where: { id: 1 },
  useMaster: true,
});
```

## Connection Pooling

```typescript
await em.register({
  type: "postgres",
  // ...
  pool: {
    max: 20,              // Maximum number of connections
    min: 5,               // Minimum idle connections (PostgreSQL only)
    acquireTimeoutMs: 5000, // Connection acquire wait time
    idleTimeoutMs: 30000,  // Idle connection timeout (PostgreSQL only)
  },
});
```

> **Hint** SQLite is file-based with a single connection, so pool settings are ignored.

## Connection Retry

Automatically retries with exponential backoff on DB connection failure.

```typescript
await em.register({
  type: "mysql",
  // ...
  retry: {
    maxAttempts: 5,   // Maximum retry attempts
    backoffMs: 500,   // Base delay: 500ms -> 1s -> 2s -> 4s -> 8s
  },
});
```

## Query Timeout

```typescript
// 5-second timeout for all queries
await em.register({
  type: "mysql",
  // ...
  queryTimeout: 5000,
});

// 2-second timeout for a specific query only (overrides global setting)
const users = await em.find(User, {
  where: { isActive: true },
  timeout: 2000,
});
```

A `QueryTimeoutError` is thrown when the timeout is exceeded.

## Shutdown Handling — propagateShutdown()

Cleans up EntityManager's internal resources when the application shuts down. This resets event listeners, subscribers, query tracker, and replication router.

```typescript
await em.propagateShutdown();
```

In NestJS, call it from the `OnModuleDestroy` hook.

```typescript
@Injectable()
export class AppService implements OnModuleDestroy {
  constructor(private readonly em: EntityManager) {}

  async onModuleDestroy() {
    await this.em.propagateShutdown();
  }
}
```

## Next Steps

- [Configuration Guide](./configuration.md) — All options at a glance
- [Multi-Tenancy](./multi-tenancy.md) — Per-tenant data isolation
- [API Reference](./api-reference.md) — Quick method signature lookup
