# EntityManager — Writes & Transactions

This page covers **batch write operations**, **upserts**, **transactions**, and **raw SQL execution**.

For basic single-entity CRUD, see [CRUD Basics](./entity-manager.md). For read-oriented features, see [Querying & Pagination](./entity-manager-querying.md).

---

## Batch Insert — insertMany()

Inserts multiple rows with a **single `INSERT INTO ... VALUES (...), (...), (...)`** statement. This is the fastest way to insert many rows.

```typescript
await em.insertMany(User, [
  { name: "Alice", email: "alice@example.com" },
  { name: "Bob", email: "bob@example.com" },
  { name: "Charlie", email: "charlie@example.com" },
]);
```

Key characteristics:
- Executes as a **single SQL statement** — far more efficient than calling `save()` in a loop.
- `@CreateTimestamp` and `@UpdateTimestamp` columns are automatically injected.
- Lifecycle hooks (`@BeforeInsert`) fire for each item.
- Returns `void` — if you need the generated PKs, use `saveMany()` instead.

---

## Batch Save — saveMany()

Like `save()`, but for multiple entities. Each item is individually inspected for its PK to decide INSERT vs UPDATE.

```typescript
const users = await em.saveMany(User, [
  { name: "New User", email: "new@example.com" },           // No PK → INSERT
  { id: 2, name: "Updated User", email: "upd@example.com" }, // Has PK → UPDATE
]);
// Returns the saved entities with generated PKs
```

Unlike `insertMany()`, `saveMany()` processes each item separately (one query per item), so it's slower for pure inserts. Use it when you have a mix of new and existing entities.

---

## Batch Delete — deleteMany()

Deletes multiple rows by primary key in a single `DELETE ... WHERE id IN (...)` statement.

```typescript
const result = await em.deleteMany(User, [1, 2, 3]);
console.log(result.affected); // 3
```

::: tip
If you need to delete by a condition rather than by PKs, use `delete()` with a WHERE clause:
```typescript
await em.delete(User, { isActive: false });
```
:::

---

## Bulk Update — updateMany()

Updates all rows matching a WHERE condition with the given data, in a single `UPDATE ... SET ... WHERE ...` statement.

```typescript
const result = await em.updateMany(User,
  { isActive: false },            // SET — the data to apply
  { where: { lastLoginAt: null } }, // WHERE — the condition to match
);
console.log(result.affected); // number of updated rows
```

A more realistic example — deactivating users who haven't logged in for 90 days:

```typescript
import sql from "sql-template-tag";

const result = await em.updateMany(User,
  { isActive: false, deactivatedAt: new Date() },
  { where: { isActive: true } },
);
console.log(`Deactivated ${result.affected} users`);
```

Key characteristics:
- `@UpdateTimestamp` columns are automatically injected into the SET clause.
- An **empty WHERE condition throws** `DeleteWithoutConditionsError` (safety guard).
- Unlike `save()`, this does **not** fire entity lifecycle hooks or events — it's a raw bulk operation.

::: danger
The parameter order is `(Entity, setData, { where })` — not `(Entity, where, setData)`. The data you want to **set** comes first.
:::

---

## Upsert — Insert or Update

`upsert()` checks for conflicts on the primary key or specified unique columns. If the row exists, it updates; otherwise, it inserts.

### By primary key

```typescript
await em.upsert(User, {
  id: 1,
  name: "Alice",
  email: "alice@example.com",
});
// If id=1 exists → UPDATE name and email
// If id=1 doesn't exist → INSERT new row
```

### By unique column

Pass an array of column names as the third argument to specify the conflict target:

```typescript
await em.upsert(User, {
  email: "alice@example.com",
  name: "Alice",
  lastLoginAt: new Date(),
}, ["email"]);
// If a row with this email exists → UPDATE name and lastLoginAt
// If no row with this email → INSERT
```

### How it works under the hood

| Dialect | SQL Generated |
|---------|--------------|
| MySQL | `INSERT INTO ... ON DUPLICATE KEY UPDATE ...` |
| PostgreSQL | `INSERT INTO ... ON CONFLICT (...) DO UPDATE SET ...` |

::: info
The conflict columns (third argument) must have a unique constraint or be the primary key. Otherwise, the database will reject the query.
:::

---

## Transactions

Every individual EntityManager operation (`save`, `find`, `delete`, etc.) is automatically wrapped in its own transaction. But when you need **multiple operations to succeed or fail as a unit**, use explicit transactions.

### Callback API — transaction()

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

  // Deduct inventory
  await txEm.updateMany(Product,
    { stock: sql`${raw('"stock"')} - 2` },
    { where: { id: 10 } },
  );

  return order;
  // COMMIT on success
});
// If any operation throws → ROLLBACK automatically
```

### Deadlock retry

In high-concurrency scenarios (e.g., multiple users purchasing the same product), deadlocks can occur. The `transaction()` method supports automatic retry:

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

When a deadlock is detected, the entire callback is re-executed from scratch. **The callback must be idempotent** — it should not have side effects outside the database (e.g., sending emails) that cannot be safely repeated.

### Decorator-based transactions

For NestJS services, you can use the `@Transactional()` decorator instead of the callback API. See [Transactions](./transactions.md) for details on decorator usage, isolation levels, and savepoints.

---

## Raw SQL — query()

When you need queries the ORM API doesn't cover (window functions, CTEs, complex joins), execute SQL directly.

### With sql-template-tag (recommended)

```typescript
import sql from "sql-template-tag";

const users = await em.query<{ id: number; name: string }>(
  sql`SELECT * FROM "user" WHERE "age" > ${18} AND "city" = ${"Seoul"}`
);
```

`sql-template-tag` automatically separates the query text from the parameter values, preventing SQL injection while keeping the code readable.

### With string + parameter array

```typescript
const posts = await em.query<{ id: number; title: string }>(
  "SELECT id, title FROM post WHERE author_id = $1",
  [42]
);
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

For a full guide on CTEs, UNION, window functions, and subqueries, see [Raw SQL & CTE](./raw-sql.md).

---

## Next Steps

- **[CRUD Basics](./entity-manager.md)** — save, find, delete, soft delete
- **[Querying & Pagination](./entity-manager-querying.md)** — SELECT, pagination, streaming, aggregates
- **[Advanced](./entity-manager-advanced.md)** — Events, subscribers, multi-tenancy, plugins, FindOption reference
