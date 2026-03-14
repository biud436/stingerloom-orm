# EntityManager

**EntityManager** is the core entry point of Stingerloom ORM. All operations for creating, reading, updating, and deleting data are performed through EntityManager.

```typescript
import { EntityManager } from "@stingerloom/orm";

const em = new EntityManager();
```

This document explains the most commonly used features in order of development usage.

## Connecting to the DB — register()

To use EntityManager, you must first connect to a database.

```typescript
// main.ts
import "reflect-metadata";
import { EntityManager } from "@stingerloom/orm";
import { User } from "./user.entity";

const em = new EntityManager();

await em.register({
  type: "postgres",
  host: "localhost",
  port: 5432,
  username: "postgres",
  password: "password",
  database: "mydb",
  entities: [User],
  synchronize: true,
});
```

`register()` does three things: connects to the DB, scans entity metadata, and auto-creates tables if `synchronize: true`.

> **Warning** Use `synchronize: true` only in development. In production, manage your schema with [migrations](./migrations.md).

For more details on connection options, see the [Configuration Guide](./configuration.md).

## Saving — save()

Use `save()` to save data. It automatically performs an INSERT when there is no PK, and an UPDATE when there is.

```typescript
// INSERT — No PK (id), so a new row is inserted
const user = await em.save(User, {
  name: "John Doe",
  email: "john@example.com",
});
console.log(user.id); // 1 — Auto-generated PK

// UPDATE — PK (id) present, so existing row is modified
const updated = await em.save(User, {
  id: 1,
  name: "John Doe (edited)",
  email: "john@example.com",
});
```

`save()` returns the saved entity object, so you can immediately use the auto-generated `id` even after INSERT.

## Querying — find(), findOne()

### List Query

```typescript
// Fetch all
const users = await em.find(User);

// WHERE condition
const activeUsers = await em.find(User, {
  where: { isActive: true },
});

// ORDER BY + LIMIT
const recent = await em.find(Post, {
  orderBy: { createdAt: "DESC" },
  take: 10,
});
```

### Single Record Query

```typescript
const user = await em.findOne(User, { where: { id: 1 } });

if (user === null) {
  throw new Error("User not found");
}
```

`findOne()` returns `null` when no result is found. Always perform a null check.

### SELECT Specific Columns Only

Fetching only the columns you need makes queries lighter.

```typescript
// Array style
const names = await em.find(User, {
  select: ["id", "name"],
});

// Object style
const names2 = await em.find(User, {
  select: { id: true, name: true },
});
```

### Loading Related Entities

```typescript
const owner = await em.findOne(Owner, {
  where: { id: 1 },
  relations: ["cats"],
});
console.log(owner.cats); // Cat[]
```

### Including Soft Deleted Data

```typescript
const allPosts = await em.find(Post, {
  withDeleted: true, // Include rows where deleted_at is not NULL
});
```

## Deleting — delete(), softDelete()

### Permanent Delete

```typescript
const result = await em.delete(User, { id: 1 });
console.log(result.affected); // 1
```

Deleting with empty conditions throws a `DeleteWithoutConditionsError`. This prevents accidentally deleting all data.

### Soft Delete

Used with entities that have a `@DeletedAt` column. Instead of actually deleting, it marks the record with `deleted_at = NOW()`.

```typescript
// soft delete
await em.softDelete(Post, { id: 1 });

// Automatically excluded from find() afterwards
const posts = await em.find(Post); // Only queries where deleted_at IS NULL

// Restore
await em.restore(Post, { id: 1 });
```

## Batch Operations — insertMany(), saveMany(), deleteMany()

Use these when you need to process multiple records at once.

```typescript
// Insert multiple records with a single INSERT query (fastest)
await em.insertMany(User, [
  { name: "John Doe", email: "john@example.com" },
  { name: "Jane Smith", email: "jane@example.com" },
  { name: "Bob Wilson", email: "bob@example.com" },
]);

// Determines INSERT/UPDATE for each record (based on PK presence)
const users = await em.saveMany(User, [
  { name: "New User", email: "new@example.com" },       // INSERT
  { id: 2, name: "Updated", email: "updated@example.com" }, // UPDATE
]);

// Delete multiple at once by PK array
await em.deleteMany(User, [1, 2, 3]);
```

> **Hint** For bulk INSERTs, `insertMany()` is the most efficient. It executes as a single `INSERT INTO ... VALUES (...), (...)` query.

## Upsert — Update if Exists, Insert if Not

`upsert()` checks for conflicts based on PK or unique columns. If the record already exists, it performs an UPDATE; otherwise, an INSERT.

```typescript
// Upsert by PK
await em.upsert(User, {
  id: 1,
  name: "John Doe",
  email: "john@example.com",
});

// Upsert by unique column
await em.upsert(User, {
  email: "john@example.com",
  name: "John Doe",
}, ["email"]); // UPDATE if email exists, INSERT otherwise
```

Internally, MySQL uses `INSERT ... ON DUPLICATE KEY UPDATE`, and PostgreSQL uses `INSERT ... ON CONFLICT DO UPDATE`.

## Aggregate Functions — count(), sum(), avg(), min(), max()

Use these when you need statistical data.

```typescript
const total = await em.count(User);
const active = await em.count(User, { isActive: true });

const avgAge = await em.avg(User, "age");
const youngest = await em.min(User, "age");
const oldest = await em.max(User, "age");
const totalAge = await em.sum(User, "age");
```

Querying multiple aggregates simultaneously improves performance.

```typescript
const [total, avgAge, minAge, maxAge] = await Promise.all([
  em.count(User),
  em.avg(User, "age"),
  em.min(User, "age"),
  em.max(User, "age"),
]);
```

## Pagination

### Offset-Based

Traditional LIMIT/OFFSET pagination. Suitable for small datasets.

```typescript
// Method 1: take + limit
const page2 = await em.find(Post, {
  orderBy: { createdAt: "DESC" },
  limit: [10, 10], // OFFSET 10, LIMIT 10
});

// Method 2: findAndCount — also returns total count
const [posts, total] = await em.findAndCount(Post, {
  orderBy: { createdAt: "DESC" },
  take: 10,
  limit: [0, 10],
});

console.log(posts.length); // 10
console.log(total);        // Total number of posts (e.g., 235)
```

### Cursor-Based

For large datasets, cursor-based pagination provides consistent performance.

```typescript
// First page
const page1 = await em.findWithCursor(Post, {
  take: 20,
  orderBy: "id",
  direction: "ASC",
});

console.log(page1.data);        // Post[] (up to 20 records)
console.log(page1.hasNextPage); // true
console.log(page1.nextCursor);  // "eyJ2IjoyMH0=" (Base64)

// Second page — pass the previous cursor
const page2 = await em.findWithCursor(Post, {
  take: 20,
  cursor: page1.nextCursor!,
  orderBy: "id",
  direction: "ASC",
});
```

> **Hint** Cursor-based pagination is suited for "next page"/"previous page" navigation. If you need to jump to a specific page, use offset-based pagination.

## Raw SQL Execution — query()

When you need complex queries that the ORM doesn't provide, you can execute SQL directly.

```typescript
import sql from "sql-template-tag";

// Using sql-template-tag (recommended — prevents SQL Injection)
const users = await em.query<{ id: number; name: string }>(
  sql`SELECT * FROM "user" WHERE "id" = ${1}`
);

// String + parameter array
const posts = await em.query<{ id: number; title: string }>(
  "SELECT id, title FROM post WHERE author_id = ?",
  [42]
);
```

> **Warning** When using Raw SQL, always use parameter binding. Concatenating values into strings poses SQL Injection risks.

## EXPLAIN — Query Analysis

Useful for verifying whether a query is properly using indexes.

```typescript
const result = await em.explain(User, {
  where: { email: "john@example.com" },
});

console.log(result.type); // "ref" — using an index
console.log(result.key);  // "idx_user_email"
console.log(result.rows); // 1 — estimated number of rows examined
```

> **Hint** `explain()` is supported in MySQL and PostgreSQL. In SQLite, an `InvalidQueryError` is thrown.

## Event Listeners

You can register logic that runs automatically when data is created/updated/deleted.

```typescript
// Register listener
em.on("afterInsert", ({ entity, data }) => {
  console.log(`${entity.name} created:`, data);
});

// Remove listener
em.off("afterInsert", listener);

// Remove all listeners
em.removeAllListeners();
```

Available events: `beforeInsert`, `afterInsert`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`

If you need subscribers that react only to specific entities, see [EntitySubscriber](./advanced.md).

## Repository Pattern

If you want to encapsulate CRUD per entity, use `getRepository()`.

```typescript
const userRepo = em.getRepository(User);

const users = await userRepo.find();
const user = await userRepo.findOne({ where: { id: 1 } as any });
await userRepo.save({ name: "John Doe" });
```

In NestJS, you can inject repositories into services using `@InjectRepository()`. Multi-DB 환경에서는 두 번째 인수로 connectionName을 지정할 수 있습니다.

```typescript
// users.service.ts
@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly userRepo: BaseRepository<User>,
    // Named connection: @InjectRepository(Event, "analytics")
  ) {}

  async findAll() {
    return this.userRepo.find();
  }
}
```

EntityManager도 `@InjectEntityManager(connectionName?)`로 직접 주입할 수 있습니다.

## Shutdown — propagateShutdown()

Cleans up EntityManager's internal resources when shutting down the application.

```typescript
await em.propagateShutdown();
```

In NestJS, call this in the `OnModuleDestroy` hook.

## FindOption Full Options

List of options that can be passed to `find()`, `findOne()`, `explain()`, etc.

| Option | Type | Description |
|--------|------|-------------|
| `where` | `Partial<T>` | WHERE conditions |
| `select` | `(keyof T)[]` or `Record<keyof T, boolean>` | SELECT columns |
| `orderBy` | `Record<keyof T, "ASC" \| "DESC">` | ORDER BY |
| `limit` | `number` or `[offset, count]` | LIMIT |
| `take` | `number` | Number of rows to fetch |
| `relations` | `(keyof T)[]` | Relation properties to load |
| `withDeleted` | `boolean` | Whether to include soft-deleted records |
| `groupBy` | `(keyof T)[]` | GROUP BY |
| `having` | `Sql[]` | HAVING clause |
| `timeout` | `number` | Query timeout (ms) |
| `useMaster` | `boolean` | Force master in Read Replica environments |

## Next Steps

- [Query Builder](./query-builder.md) — When you need complex SQL like JOIN, GROUP BY, subqueries
- [Transactions](./transactions.md) — When you need to group multiple operations into a single unit
- [Configuration Guide](./configuration.md) — Pooling, timeouts, Read Replica, and other operational settings
