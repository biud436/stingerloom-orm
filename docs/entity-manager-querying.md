# EntityManager — Querying & Pagination

This page covers everything related to **reading data** through EntityManager: column selection, ordering, filtering, pagination strategies, aggregation, and query analysis.

For basic CRUD, see [CRUD Basics](./entity-manager.md). For writes and transactions, see [Writes & Transactions](./entity-manager-writes.md).

---

## SELECT Specific Columns

By default, `find()` and `findOne()` fetch all columns (`SELECT *`). Use `select` to fetch only what you need — this reduces network transfer and memory usage.

### Array style

```typescript
const users = await em.find(User, {
  select: ["id", "name", "email"],
});
// SELECT "id", "name", "email" FROM "user"
```

### Object style

```typescript
const users = await em.find(User, {
  select: { id: true, name: true, email: true },
});
// Same SQL as above
```

Both styles produce the same query. Use whichever reads better in your codebase.

::: tip
When using `select`, the returned entities still have the full TypeScript type, but unselected properties will be `undefined` at runtime. If you need compile-time safety for projections, use the [SelectQueryBuilder](./query-builder.md) which narrows the return type.
:::

---

## Ordering — orderBy

Control the sort order of results with `orderBy`:

```typescript
// Single column
const users = await em.find(User, {
  orderBy: { createdAt: "DESC" },
});

// Multiple columns — sorted by role ASC first, then name ASC
const users = await em.find(User, {
  orderBy: { role: "ASC", name: "ASC" },
});
```

`orderBy` keys correspond to entity property names. The ORM escapes them into the correct column identifiers for each dialect.

---

## DISTINCT

Add `distinct: true` to generate `SELECT DISTINCT`, removing duplicate rows:

```typescript
const uniqueCities = await em.find(User, {
  select: ["city"],
  distinct: true,
});
// SELECT DISTINCT "city" FROM "user"
```

`distinct` applies to the **entire row**. If you select multiple columns, rows are only deduplicated when *all* selected columns match:

```typescript
const combos = await em.find(Product, {
  select: ["category", "status"],
  distinct: true,
});
// Unique (category, status) pairs
```

For column-level deduplication (e.g., PostgreSQL `DISTINCT ON`), use the [Query Builder](./query-builder.md).

---

## Including Soft-Deleted Records

Entities with a `@DeletedAt` column are automatically excluded from queries. Set `withDeleted: true` to include them:

```typescript
// Only non-deleted posts (default)
const posts = await em.find(Post);

// All posts, including soft-deleted ones
const allPosts = await em.find(Post, {
  withDeleted: true,
});
```

This works with `find()`, `findOne()`, `findAndCount()`, `findWithCursor()`, `findWithPage()`, and `stream()`.

---

## Pessimistic Locking — lock

When you need to prevent concurrent modifications within a transaction, use pessimistic locks:

```typescript
import { LockMode } from "@stingerloom/orm";

await em.transaction(async (txEm) => {
  // Locks the row — other transactions wait until this one commits
  const account = await txEm.findOne(Account, {
    where: { id: 1 },
    lock: LockMode.PESSIMISTIC_WRITE,
  });

  account.balance -= 100;
  await txEm.save(Account, account);
});
```

| Mode | SQL Generated | Use Case |
|------|--------------|----------|
| `PESSIMISTIC_WRITE` | `SELECT ... FOR UPDATE` | Exclusive lock — read and modify |
| `PESSIMISTIC_READ` | `SELECT ... FOR SHARE` (PG) / `LOCK IN SHARE MODE` (MySQL) | Shared lock — prevent writes but allow reads |

::: warning
Pessimistic locks only work inside a transaction. Using `lock` outside a transaction has no effect because the lock is released when the auto-transaction commits.
:::

---

## GROUP BY and HAVING

For grouped aggregation queries, use `groupBy` and `having`:

```typescript
import sql from "sql-template-tag";

const results = await em.find(Order, {
  select: ["status"],
  groupBy: ["status"],
  having: [sql`COUNT(*) > ${10}`],
});
```

`having` accepts an array of `Sql` objects (from `sql-template-tag`), which are joined with `AND`. This keeps your HAVING conditions parameterized and safe from SQL injection.

---

## Pagination

Stingerloom ORM offers four pagination strategies, each suited to different scenarios.

### 1. skip + take (Offset-Based)

The simplest approach. Good for small-to-medium datasets and UI pages with page numbers.

```typescript
const page2 = await em.find(Post, {
  orderBy: { createdAt: "DESC" },
  skip: 10,   // offset
  take: 10,   // limit
});
```

Alternatively, use the `limit` tuple `[offset, count]`:

```typescript
const page2 = await em.find(Post, {
  orderBy: { createdAt: "DESC" },
  limit: [10, 10],  // OFFSET 10, LIMIT 10
});
```

### 2. findAndCount()

Returns both the data and the **total count** in a single call — useful for rendering "Page 2 of 24" in a UI.

```typescript
const [posts, total] = await em.findAndCount(Post, {
  orderBy: { createdAt: "DESC" },
  skip: 0,
  take: 10,
});

console.log(posts.length); // 10 (current page)
console.log(total);        // 235 (total matching rows)
```

Internally, `findAndCount()` runs the data query and a `COUNT(*)` query in the same transaction, ensuring consistency.

### 3. findWithPage()

A higher-level API that returns a fully computed pagination result object. Ideal for REST APIs.

```typescript
const result = await em.findWithPage(Post, {
  page: 2,           // 1-based page number (default: 1)
  pageSize: 20,      // items per page (default: 20)
  orderBy: { createdAt: "DESC" },
  where: { isPublished: true },
  relations: ["author"],
});

console.log(result.data);            // Post[] (current page)
console.log(result.total);           // 235 (total matching rows)
console.log(result.page);            // 2
console.log(result.pageSize);        // 20
console.log(result.totalPages);      // 12
console.log(result.hasNextPage);     // true
console.log(result.hasPreviousPage); // true
```

**Return type: `PagePaginationResult<T>`**

| Field | Type | Description |
|-------|------|-------------|
| `data` | `T[]` | Entities for the current page |
| `total` | `number` | Total number of matching entities |
| `page` | `number` | Current page number (1-based) |
| `pageSize` | `number` | Items per page |
| `totalPages` | `number` | `Math.ceil(total / pageSize)` |
| `hasNextPage` | `boolean` | Whether a next page exists |
| `hasPreviousPage` | `boolean` | Whether a previous page exists |

`findWithPage()` accepts all the same options as `find()` (`where`, `select`, `relations`, `withDeleted`, `orderBy`, `groupBy`, `having`, `timeout`, `useMaster`).

### 4. findWithCursor() (Cursor-Based)

For large datasets or infinite scroll, cursor-based pagination provides **consistent performance** regardless of how deep into the dataset you go (no `OFFSET` degradation).

```typescript
// First page
const page1 = await em.findWithCursor(Post, {
  take: 20,
  orderBy: "id",
  direction: "ASC",
});

console.log(page1.data);        // Post[] (up to 20)
console.log(page1.hasNextPage); // true
console.log(page1.nextCursor);  // "eyJ2IjoyMH0=" (opaque Base64 token)
console.log(page1.count);       // 20

// Next page — pass the previous cursor
const page2 = await em.findWithCursor(Post, {
  take: 20,
  cursor: page1.nextCursor!,
  orderBy: "id",
  direction: "ASC",
});
```

**Return type: `CursorPaginationResult<T>`**

| Field | Type | Description |
|-------|------|-------------|
| `data` | `T[]` | Entities for the current page |
| `hasNextPage` | `boolean` | Whether more data exists |
| `nextCursor` | `string \| null` | Opaque token to pass for the next page |
| `count` | `number` | Number of entities in this page |

::: tip When to use which?
- **Page numbers in UI** (1, 2, 3...) → `findWithPage()` or `findAndCount()`
- **"Load more" / infinite scroll** → `findWithCursor()`
- **Simple offset without total count** → `skip` + `take`
:::

---

## Streaming — stream()

When processing large datasets (exports, ETL, batch emails), loading millions of rows into memory is impractical. `stream()` returns an `AsyncGenerator` that fetches rows in configurable batches.

```typescript
for await (const user of em.stream(User, { where: { isActive: true } })) {
  await sendEmail(user.email);
}
```

### Batch size

The third parameter controls how many rows are fetched per internal query (default: 1000):

```typescript
// Fetch in batches of 500
for await (const post of em.stream(Post, { orderBy: { id: "ASC" } }, 500)) {
  await indexPost(post);
}
```

Internally, the ORM uses `LIMIT/OFFSET` to fetch one batch at a time. When a batch returns fewer rows than the batch size, the generator stops.

### Supported options

`stream()` supports all `FindOption` properties — `where`, `orderBy`, `relations`, `select`, `withDeleted`, etc.:

```typescript
for await (const post of em.stream(Post, {
  select: ["id", "title"],
  relations: ["author"],
  where: { isPublished: true },
  orderBy: { createdAt: "DESC" },
}, 2000)) {
  console.log(`${post.title} by ${post.author.name}`);
}
```

### Progress tracking

Combine with `count()` to show progress:

```typescript
const total = await em.count(User, { isActive: true });
console.log(`Processing ${total} users...`);

let processed = 0;
for await (const user of em.stream(User, { where: { isActive: true } })) {
  await process(user);
  processed++;
  if (processed % 1000 === 0) {
    console.log(`${processed}/${total}`);
  }
}
```

### When to use stream() vs find()

| Scenario | Recommended |
|----------|-------------|
| API endpoint returning a page of results | `find()` with pagination |
| Processing all rows (ETL, export, batch emails) | `stream()` |
| Aggregating from a large dataset | `stream()` or raw SQL with DB-side aggregation |

::: tip
For consistent results on large mutable tables, wrap the stream in a transaction with `REPEATABLE READ` isolation to prevent phantom reads during iteration.
:::

---

## Aggregate Functions

When you need statistical data without fetching individual rows.

### count()

```typescript
const total = await em.count(User);
const admins = await em.count(User, { role: "admin" });
```

The second parameter is an optional WHERE condition.

### sum(), avg(), min(), max()

```typescript
const totalRevenue = await em.sum(Order, "amount");
const avgAge = await em.avg(User, "age");
const youngest = await em.min(User, "age");
const oldest = await em.max(User, "age");
```

The second parameter is the column name to aggregate. All four accept an optional third parameter for WHERE conditions:

```typescript
const activeAvgAge = await em.avg(User, "age", { isActive: true });
```

### Running multiple aggregates

Use `Promise.all` to run them concurrently:

```typescript
const [total, avgAge, minAge, maxAge] = await Promise.all([
  em.count(User),
  em.avg(User, "age"),
  em.min(User, "age"),
  em.max(User, "age"),
]);
```

---

## EXPLAIN — Query Analysis

`explain()` returns the database's query execution plan. Useful for verifying index usage during development.

```typescript
const plan = await em.explain(User, {
  where: { email: "alice@example.com" },
});

console.log(plan.type); // "ref" — using an index
console.log(plan.key);  // "idx_user_email"
console.log(plan.rows); // 1 — estimated rows examined
```

`explain()` accepts the same `FindOption` as `find()`, so you can test the execution plan of any query you would actually run.

::: info
`explain()` is supported on MySQL and PostgreSQL. On SQLite, it throws `InvalidQueryError`.
:::

---

## Next Steps

- **[CRUD Basics](./entity-manager.md)** — save, find, delete, soft delete
- **[Writes & Transactions](./entity-manager-writes.md)** — Batch operations, upsert, transactions, raw SQL
- **[Advanced](./entity-manager-advanced.md)** — Events, subscribers, multi-tenancy, plugins, FindOption reference
