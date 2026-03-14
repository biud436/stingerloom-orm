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

## Operational Features

Read Replica, Connection Pooling, Connection Retry, Query Timeout, and Shutdown Handling are covered in the [Configuration Guide](./configuration.md). For production-level tuning, see the [Production Guide](./production-guide.md).

## Next Steps

- [Configuration Guide](./configuration.md) — All options at a glance
- [Multi-Tenancy](./multi-tenancy.md) — Per-tenant data isolation
- [API Reference](./api-reference.md) — Quick method signature lookup
