# EntityManager -- Writes & Transactions

This page covers **batch write operations**, **upserts**, **transactions**, and **raw SQL execution**.

For basic single-entity CRUD, see [CRUD Basics](./entity-manager.md). For read-oriented features, see [Querying & Pagination](./entity-manager-querying.md).

---

## Batch Insert -- insertMany()

### Why insertMany() exists

Imagine you need to create 1,000 users. You could call `save()` in a loop, but that means 1,000 separate `INSERT` statements, 1,000 network round-trips, and 1,000 transaction commits. That is painfully slow.

`insertMany()` solves this by packing all rows into a **single** `INSERT INTO ... VALUES (...), (...), (...)` statement. One round-trip, one parse, one commit. On real-world benchmarks, this is typically 10-50x faster than individual inserts.

```typescript
await em.insertMany(User, [
  { name: "Alice", email: "alice@example.com" },
  { name: "Bob", email: "bob@example.com" },
  { name: "Charlie", email: "charlie@example.com" },
]);
```

The ORM generates a single SQL statement:

```sql
-- PostgreSQL
INSERT INTO "user" ("name", "email")
VALUES ($1, $2), ($3, $4), ($5, $6)
-- Parameters: ['Alice', 'alice@example.com', 'Bob', 'bob@example.com', 'Charlie', 'charlie@example.com']

-- MySQL
INSERT INTO `user` (`name`, `email`)
VALUES (?, ?), (?, ?), (?, ?)
-- Parameters: ['Alice', 'alice@example.com', 'Bob', 'bob@example.com', 'Charlie', 'charlie@example.com']
```

Key characteristics:
- Executes as a **single SQL statement** -- far more efficient than calling `save()` in a loop.
- `@CreateTimestamp` and `@UpdateTimestamp` columns are automatically injected.
- `@Version` columns are initialized to `1` for each row.
- Returns `{ affected: number }` -- if you need the generated PKs, use `saveMany()` instead.

---

## Batch Save -- saveMany()

### Why saveMany() when insertMany() exists?

`insertMany()` is fast but limited: it only inserts new rows. `saveMany()` is flexible: it inspects each item's primary key and decides INSERT vs UPDATE individually. Use it when you have a mix of new and existing entities.

```typescript
const users = await em.saveMany(User, [
  { name: "New User", email: "new@example.com" },           // No PK -> INSERT
  { id: 2, name: "Updated User", email: "upd@example.com" }, // Has PK -> UPDATE
]);
// Returns the saved entities with generated PKs
```

Under the hood, `saveMany()` wraps all operations in a single transaction and processes each item one by one. For the example above, the SQL timeline looks like:

```sql
-- Step 1: BEGIN transaction
BEGIN

-- Step 2: First item has no PK -> INSERT
-- PostgreSQL
INSERT INTO "user" ("name", "email") VALUES ($1, $2) RETURNING *
-- Parameters: ['New User', 'new@example.com']

-- Step 3: Second item has PK -> UPDATE
-- PostgreSQL
UPDATE "user" SET "name" = $1, "email" = $2 WHERE "id" = $3 RETURNING *
-- Parameters: ['Updated User', 'upd@example.com', 2]

-- Step 4: COMMIT
COMMIT
```

The tradeoff is clear: `saveMany()` sends one query per item (slower for pure inserts), but it handles mixed create/update scenarios that `insertMany()` cannot.

---

## undefined vs null on INSERT -- Letting DB Defaults Apply

### Why the distinction matters

`save()` and `saveMany()` treat `undefined` as "**not provided**" (the same semantics as TypeORM and knex): a column whose entity value is `undefined` is **omitted from the INSERT column list**, so the database-side `DEFAULT` clause -- including `@Column({ default })` -- applies. An explicit `null` is different: the column is included and writes `NULL`.

```typescript
@Entity()
class Article {
  @PrimaryGeneratedColumn() id!: number;
  @Column() title!: string;
  @Column({ default: "draft" }) status!: string;
  @Column({ nullable: true }) summary?: string;
}

const a = await em.save(Article, { title: "Hello" });
// INSERT INTO "article" ("title") VALUES ($1)
// -> "status" omitted, DB DEFAULT 'draft' applies
a.status; // "draft"

await em.save(Article, { title: "Hello", summary: null });
// INSERT INTO "article" ("title", "summary") VALUES ($1, $2)
// -> "summary" is included and explicitly writes NULL
```

Auto-populated columns are the exception: `@CreateTimestamp`, `@UpdateTimestamp`, `@Version`, and client-side UUID generation strategies are still included and injected even when their entity value is `undefined`.

If every column ends up omitted, the ORM emits the dialect's all-defaults INSERT form:

```sql
-- MySQL / MariaDB
INSERT INTO `t` () VALUES ()

-- PostgreSQL / SQLite
INSERT INTO "t" DEFAULT VALUES
```

For `saveMany()` batch inserts, all rows share one column set in the multi-row `VALUES` list. A column is omitted only when **no item in the batch** provides it; in mixed batches (some items provide the column, some don't), the column stays in the list and missing rows bind `NULL`.

---

## RETURNING Rows Map Back to Property Names

On RETURNING-capable drivers (PostgreSQL, MariaDB 10.5+), the entity returned by `save()` is built from the `RETURNING *` row. That row is now routed through the ResultTransformer, so DB column names are mapped back to **entity property keys** -- covering `@Column({ name })` and NamingStrategy mappings like `SnakeNamingStrategy` -- and column transformer `from` functions are applied on the way out.

```typescript
@Entity()
class Category {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ name: "LFT_NO" }) left!: number;
}

const saved = await em.save(Category, { left: 1 });
saved.left;             // 1 -- property key, as declared on the class
(saved as any).LFT_NO;  // undefined -- raw DB key no longer leaks through
```

Previously the returned object exposed raw DB keys (e.g. `LFT_NO` instead of `left`). The mapping applies to INSERT RETURNING, UPDATE RETURNING, and `saveMany()` batch RETURNING alike.

---

## Batch Delete -- deleteMany()

### Why deleteMany() over multiple delete() calls?

For the same reason `insertMany()` is faster than looping `save()`: one SQL statement is better than many. `deleteMany()` takes an array of primary key values and generates a single `DELETE ... WHERE id IN (...)` statement.

```typescript
const result = await em.deleteMany(User, [1, 2, 3]);
console.log(result.affected); // 3
```

```sql
-- PostgreSQL
DELETE FROM "user" WHERE "id" IN ($1, $2, $3)
-- Parameters: [1, 2, 3]

-- MySQL
DELETE FROM `user` WHERE `id` IN (?, ?, ?)
-- Parameters: [1, 2, 3]
```

::: tip
If you need to delete by a condition rather than by PKs, use `delete()` with a WHERE clause:
```typescript
await em.delete(User, { isActive: false });
```
:::

### Operator criteria in delete() / softDelete() / restore()

The criteria object is not limited to equality. `delete()`, `softDelete()`, and `restore()` accept the same find-style operator objects as `where` in reads -- `{ between: [a, b] }`, `{ gt }`, `{ gte }`, `{ lt }`, `{ lte }`, `{ in }`, `{ like }`, and the rest -- plus `null` for `IS NULL`. They are resolved by the same WhereResolver as the read paths (`updateMany()` already supported this).

```typescript
// Delete an entire nested-set subtree in one statement
await em.delete(Category, { lft: { between: [node.lft, node.rgt] } });

// Soft-delete stale drafts
await em.softDelete(Post, { status: "draft", updatedAt: { lt: cutoff } });

// null -> IS NULL
await em.delete(Session, { userId: null });
```

Empty criteria still throw `DeleteWithoutConditionsError` -- the table-wide guard is unchanged.

---

## Targeted Update -- update()

### Why update() exists

`updateMany()` is powerful but verbose for the common case: change the rows matching a filter. It nests the filter under an options object (`{ where: ... }`), which reads differently from `delete(entity, criteria)` where the filter is just the second argument. `update()` is the filter-first sugar that closes that gap:

```typescript
// update(entity, where, data) -- the filter is the 2nd arg, just like delete()
await em.update(User, { id: 1 }, { name: "Alice" });

// raw SQL expressions work too (forwarded straight to the SET clause)
await em.update(Post, { id: 1 }, { viewCount: sql`view_count + 1` });
```

It delegates to `updateMany()`, so it inherits every safeguard: the empty-`WHERE` guard (a table-wide update is rejected), tenant scoping, `@UpdateTimestamp` auto-injection, NamingStrategy column mapping, and `Sql` expression support. The return shape is identical -- `{ affected }`.

Reach for `updateMany()` directly only when you need an ordered/capped update (`orderBy` + `limit`). For everything else, `update()` is the shorter, more consistent call. It is available on repositories as well: `repo.update(where, data)`.

---

## Bulk Update -- updateMany()

### Why updateMany() exists

Sometimes you need to update thousands of rows with the same change -- deactivating all expired accounts, bumping a price for a category, or resetting a flag. Doing this with `save()` would mean fetching each row, modifying it, and saving it back. `updateMany()` does it in one shot with a single `UPDATE ... SET ... WHERE ...`.

```typescript
const result = await em.updateMany(User,
  { isActive: false },            // SET -- the data to apply
  { where: { lastLoginAt: null } }, // WHERE -- the condition to match
);
console.log(result.affected); // number of updated rows
```

```sql
-- PostgreSQL
UPDATE "user"
SET "isActive" = $1
WHERE "lastLoginAt" IS NULL
-- Parameters: [false]

-- MySQL
UPDATE `user`
SET `isActive` = ?
WHERE `lastLoginAt` IS NULL
-- Parameters: [false]
```

A more realistic example -- deactivating users who haven't logged in recently:

```typescript
const result = await em.updateMany(User,
  { isActive: false, deactivatedAt: new Date() },
  { where: { isActive: true } },
);
console.log(`Deactivated ${result.affected} users`);
```

```sql
-- PostgreSQL
UPDATE "user"
SET "isActive" = $1, "deactivatedAt" = $2, "updatedAt" = $3
WHERE "isActive" = $4
-- Parameters: [false, '2026-03-22 12:00:00', '2026-03-22 12:00:00', true]
```

Notice the `"updatedAt"` column in the SET clause -- the ORM automatically injects `@UpdateTimestamp` columns, even in bulk updates.

### SQL expressions in updateMany

Sometimes you need computed updates -- incrementing a counter, appending to a string, or using database functions. `updateMany` accepts raw SQL expressions via `sql-template-tag` as column values:

```typescript
import sql from "sql-template-tag";

// Increment view count
await em.updateMany(Post,
  { viewCount: sql`"viewCount" + 1` },
  { where: { id: 1 } },
);
```

```sql
-- PostgreSQL
UPDATE "post"
SET "viewCount" = "viewCount" + 1
WHERE "id" = $1
-- Parameters: [1]
```

You can mix literal values and SQL expressions in the same update:

```typescript
await em.updateMany(Product,
  {
    price: sql`"price" * 1.1`,         // 10% price increase
    lastUpdatedBy: "admin",             // Literal value
  },
  { where: { category: "electronics" } },
);
```

Key characteristics:
- `@UpdateTimestamp` columns are automatically injected into the SET clause.
- An **empty WHERE condition throws** `DeleteWithoutConditionsError` (safety guard).
- Unlike `save()`, this does **not** fire entity lifecycle hooks or events -- it is a raw bulk operation.

::: danger
The parameter order is `(Entity, setData, { where })` -- not `(Entity, where, setData)`. The data you want to **set** comes first.
:::

---

## Upsert -- Insert or Update

### Why upsert?

Consider a "login tracking" feature: every time a user logs in, you want to either create a new record or update the existing one. Without upsert, you would need to:

1. `findOne()` -- Check if the record exists
2. If yes: `save()` with the PK to UPDATE
3. If no: `save()` without PK to INSERT

That is three round-trips and a race condition (two requests could both see "not found" and both try to INSERT, causing a duplicate key error). Upsert solves both problems with a single atomic statement.

### By primary key

```typescript
await em.upsert(User, {
  id: 1,
  name: "Alice",
  email: "alice@example.com",
});
// If id=1 exists -> UPDATE name and email
// If id=1 doesn't exist -> INSERT new row
```

```sql
-- PostgreSQL
INSERT INTO "user" ("id", "name", "email")
VALUES ($1, $2, $3)
ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name", "email" = EXCLUDED."email"
-- Parameters: [1, 'Alice', 'alice@example.com']

-- MySQL
INSERT INTO `user` (`id`, `name`, `email`)
VALUES (?, ?, ?)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`), `email` = VALUES(`email`)
-- Parameters: [1, 'Alice', 'alice@example.com']
```

The key phrase is `ON CONFLICT ... DO UPDATE` (PostgreSQL) or `ON DUPLICATE KEY UPDATE` (MySQL). Both mean: "try to insert, but if there is a conflict on the specified column(s), update the existing row instead."

### By unique column

Pass an array of column names as the third argument to specify the conflict target:

```typescript
await em.upsert(User, {
  email: "alice@example.com",
  name: "Alice",
  lastLoginAt: new Date(),
}, ["email"]);
// If a row with this email exists -> UPDATE name and lastLoginAt
// If no row with this email -> INSERT
```

```sql
-- PostgreSQL
INSERT INTO "user" ("email", "name", "lastLoginAt")
VALUES ($1, $2, $3)
ON CONFLICT ("email") DO UPDATE SET "name" = EXCLUDED."name", "lastLoginAt" = EXCLUDED."lastLoginAt"
-- Parameters: ['alice@example.com', 'Alice', '2026-03-22 12:00:00']

-- MySQL
INSERT INTO `user` (`email`, `name`, `lastLoginAt`)
VALUES (?, ?, ?)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`), `lastLoginAt` = VALUES(`lastLoginAt`)
-- Parameters: ['alice@example.com', 'Alice', '2026-03-22 12:00:00']
```

### How conflict detection works

The "conflict columns" tell the database which uniqueness constraint to check. If you specify `["email"]`, the database looks for an existing row where `email` matches the value you are inserting. If it finds one, it updates that row. If it does not, it inserts a new row.

::: info
The conflict columns (third argument) must have a unique constraint or be the primary key. Otherwise, the database will reject the query. In PostgreSQL, you will get: `there is no unique or exclusion constraint matching the ON CONFLICT specification`.
:::

### Batch Upsert -- batchUpsert()

When you need to upsert hundreds or thousands of rows at once, `batchUpsert()` is significantly faster than calling `upsert()` in a loop. It packs all rows into a single multi-row `INSERT ... ON CONFLICT` statement.

```typescript
await em.batchUpsert(User, [
  { email: "alice@example.com", name: "Alice", loginCount: 1 },
  { email: "bob@example.com", name: "Bob", loginCount: 1 },
  { email: "charlie@example.com", name: "Charlie", loginCount: 1 },
], ["email"]);
```

```sql
-- PostgreSQL
INSERT INTO "user" ("email", "name", "loginCount")
VALUES ($1, $2, $3), ($4, $5, $6), ($7, $8, $9)
ON CONFLICT ("email") DO UPDATE SET "name" = EXCLUDED."name", "loginCount" = EXCLUDED."loginCount"

-- MySQL
INSERT INTO `user` (`email`, `name`, `loginCount`)
VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`), `loginCount` = VALUES(`loginCount`)
```

The optional third argument specifies the conflict columns. If omitted, the primary key is used.

The repository equivalent is `userRepo.batchUpsert(items, conflictColumns)`.

---

## Transactions

### Why transactions?

Every individual EntityManager operation (`save`, `find`, `delete`, etc.) is automatically wrapped in its own transaction. But what happens when you need two operations that **must** succeed or fail together?

Consider an e-commerce checkout: you create an order and deduct inventory. If the order creation succeeds but the inventory deduction fails, you have an order for items that are still "available" -- a data inconsistency. Transactions solve this by grouping operations into an atomic unit: either everything commits, or everything rolls back.

### Callback API -- transaction()

The simplest way to use transactions. The callback receives `this` EntityManager, and all operations within share the same transaction.

```typescript
const order = await em.transaction(async (txEm) => {
  const order = await txEm.save(Order, {
    userId: 1,
    status: "pending",
  });

  await txEm.insertMany(OrderItem, [
    { orderId: order.id, productId: 10, quantity: 2 },
    { orderId: order.id, productId: 20, quantity: 1 },
  ]);

  return order;
  // COMMIT on success
});
// If any operation throws -> ROLLBACK automatically
```

Here is the exact SQL timeline for this transaction:

```sql
-- 1. Open a connection and start the transaction
BEGIN

-- 2. Insert the order
INSERT INTO "order" ("userId", "status") VALUES ($1, $2) RETURNING *
-- Parameters: [1, 'pending']

-- 3. Insert order items (single multi-row statement)
INSERT INTO "order_item" ("orderId", "productId", "quantity")
VALUES ($1, $2, $3), ($4, $5, $6)
-- Parameters: [1, 10, 2, 1, 20, 1]

-- 4a. If everything succeeded:
COMMIT

-- 4b. If any query threw an error:
ROLLBACK
```

The `BEGIN` and `COMMIT`/`ROLLBACK` are handled automatically. You never write them yourself.

### What happens on error

If any operation inside the callback throws an exception, the ORM:

1. Catches the exception
2. Executes `ROLLBACK` to undo all changes made within the transaction
3. Re-throws the original exception so your application code can handle it

This means the database is never left in a half-finished state. Either all changes are applied, or none are.

### Deadlock retry

In high-concurrency scenarios (e.g., multiple users purchasing the same product), deadlocks can occur. A deadlock happens when two transactions are each waiting for the other to release a lock -- neither can proceed. The database detects this and kills one of them.

The `transaction()` method supports automatic retry:

```typescript
await em.transaction(async (txEm) => {
  const stock = await txEm.findOne(Inventory, {
    where: { productId: 42 },
    lock: LockMode.PESSIMISTIC_WRITE,
  });

  if (stock.quantity < 1) {
    throw new Error("Out of stock");
  }

  stock.quantity -= 1;
  await txEm.save(Inventory, stock);
}, {
  retryOnDeadlock: true,  // Enable deadlock retry
  maxRetries: 3,          // Maximum attempts (default: 3)
  retryDelayMs: 100,      // Delay between retries in ms (default: 100)
});
```

The ORM detects deadlock errors per dialect:
- **MySQL**: `errno 1213` (ER_LOCK_DEADLOCK)
- **PostgreSQL**: `code 40P01` (deadlock_detected)
- **SQLite**: `SQLITE_BUSY` / "database is locked"

When a deadlock is detected, the entire callback is re-executed from scratch. **The callback must be idempotent** -- it should not have side effects outside the database (e.g., sending emails) that cannot be safely repeated.

### Decorator-based transactions

For NestJS services, you can use the `@Transactional()` decorator instead of the callback API. See [Transactions](./transactions.md) for details on decorator usage, isolation levels, and savepoints.

---

## Raw SQL -- query()

### Why raw SQL?

The EntityManager API covers 90% of database interactions. But sometimes you need features it does not expose: window functions, CTEs (Common Table Expressions), database-specific syntax, or complex joins that are more readable as raw SQL.

`query()` gives you an escape hatch to execute any SQL while still benefiting from the ORM's connection management, transaction handling, and parameter binding.

### With sql-template-tag (recommended)

```typescript
import sql from "sql-template-tag";

const users = await em.query<{ id: number; name: string }>(
  sql`SELECT * FROM "user" WHERE "age" > ${18} AND "city" = ${"Seoul"}`
);
```

This looks like string interpolation, but it is not. The `sql` template tag from `sql-template-tag` separates the query text from the parameter values automatically. Here is what actually gets sent to the database:

```sql
-- Query text (sent to database)
SELECT * FROM "user" WHERE "age" > $1 AND "city" = $2
-- Parameters (sent separately): [18, 'Seoul']
```

The database receives the query structure and the values as separate pieces. This means a malicious value like `'; DROP TABLE user; --` is treated as a literal string, never as SQL code. This is called **parameterized queries**, and it is the primary defense against SQL injection.

### With string + parameter array

```typescript
const posts = await em.query<{ id: number; title: string }>(
  "SELECT id, title FROM post WHERE author_id = $1",
  [42]
);
```

```sql
-- Query text
SELECT id, title FROM post WHERE author_id = $1
-- Parameters: [42]
```

::: warning
When using raw SQL strings, **always use parameter binding** (`$1`, `?`, etc.). Never concatenate user input directly into the string.
:::

### Return type

`query<T>()` returns `T[]`. The generic parameter `T` lets you type the result rows:

```typescript
interface MonthlyStats {
  month: string;
  total_orders: number;
  revenue: number;
}

const stats = await em.query<MonthlyStats>(sql`
  SELECT
    TO_CHAR("created_at", 'YYYY-MM') AS month,
    COUNT(*) AS total_orders,
    SUM("amount") AS revenue
  FROM "order"
  WHERE "created_at" >= ${startDate}
  GROUP BY TO_CHAR("created_at", 'YYYY-MM')
  ORDER BY month DESC
`);
```

```sql
-- PostgreSQL
SELECT
  TO_CHAR("created_at", 'YYYY-MM') AS month,
  COUNT(*) AS total_orders,
  SUM("amount") AS revenue
FROM "order"
WHERE "created_at" >= $1
GROUP BY TO_CHAR("created_at", 'YYYY-MM')
ORDER BY month DESC
-- Parameters: [startDate]
```

The `T[]` return type does not validate at runtime -- it trusts your type annotation. If the SQL returns columns that do not match your interface, TypeScript will not catch it at compile time. Treat the generic parameter as documentation for your team, not a runtime guarantee.

For a full guide on CTEs, UNION, window functions, and subqueries, see [Raw SQL & CTE](./raw-sql.md).

---

## Next Steps

- **[CRUD Basics](./entity-manager.md)** -- save, find, delete, soft delete
- **[Querying & Pagination](./entity-manager-querying.md)** -- SELECT, pagination, streaming, aggregates
- **[Advanced](./entity-manager-advanced.md)** -- Events, subscribers, multi-tenancy, plugins, FindOption reference
