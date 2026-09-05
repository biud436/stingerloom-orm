# Pagination & Streaming

Stingerloom provides three strategies for working with large datasets: offset-based pagination, cursor-based pagination, and streaming. Each exists for a specific reason, and choosing the right one depends on what you are building.

## The Deep Page Problem -- Why Three Strategies?

Before diving into the API, it helps to understand the fundamental problem.

When a user requests "page 500" of a dataset, offset-based pagination generates this SQL:

```sql
SELECT * FROM "post" ORDER BY "id" ASC LIMIT 10 OFFSET 4990
```

This looks simple, but the database must do something expensive: it reads 5,000 rows, throws away the first 4,990, and returns the last 10. The deeper you paginate, the more rows the database reads and discards. At page 10,000, it is scanning 100,000 rows to return 10.

Cursor-based pagination eliminates this problem entirely by using a WHERE clause:

```sql
SELECT * FROM "post" WHERE "id" > 4990 ORDER BY "id" ASC LIMIT 11
```

The database uses the index on `id` to jump directly to the right position. Whether you are on page 1 or page 10,000, performance is the same.

But what if you need to process every row in the table -- not for an API response, but for a batch job like sending emails? Neither pagination strategy is appropriate for that. You need streaming, which fetches rows in batches and yields them one at a time.

Here is the summary:

| Strategy | Best for | Trade-off |
|----------|----------|-----------|
| Offset (`skip`/`take`) | Small datasets, "Page X of Y" UIs | Slow at high offsets |
| Cursor (`findWithCursor`) | Large datasets, infinite scroll | No random page access |
| Streaming (`stream()`) | Batch processing millions of rows | Not for API responses |

## Offset-Based Pagination

Traditional LIMIT/OFFSET pagination. Suitable for small-to-medium datasets where users need to jump to specific pages.

```typescript
// Method 1: skip + take (recommended)
const page2 = await em.find(Post, {
  orderBy: { createdAt: "DESC" },
  skip: 10,
  take: 10,
});

// Method 2: limit tuple [offset, count]
const page2Alt = await em.find(Post, {
  orderBy: { createdAt: "DESC" },
  limit: [10, 10], // OFFSET 10, LIMIT 10
});
```

The generated SQL for both methods is identical:

```sql
SELECT "id", "title", "content", "createdAt"
FROM "post"
ORDER BY "createdAt" DESC
LIMIT 10 OFFSET 10
```

### findAndCount -- Total Count in One Call

When building paginated UIs, you often need both the data and the total count. `findAndCount()` returns both in a single call, running the data query and a COUNT query within the same connection.

```typescript
const [posts, total] = await em.findAndCount(Post, {
  orderBy: { createdAt: "DESC" },
  skip: 0,
  take: 10,
});

console.log(posts.length); // 10
console.log(total);        // Total number of posts (e.g., 235)
```

The ORM executes two queries internally:

```sql
-- Data query
SELECT "id", "title", "content", "createdAt"
FROM "post"
ORDER BY "createdAt" DESC
LIMIT 10 OFFSET 0

-- Count query
SELECT COUNT(*) FROM "post"
```

### paginate() -- Page Data Plus Metadata

`findAndCount()` returns a bare `[rows, total]` tuple. When you want the count
*and* the derived page metadata (`totalPages`, `hasNextPage`, …), the query
builder's `paginate()` returns the whole envelope from a 1-based `page` /
`pageSize`. This is the natural fit when the query is assembled through the
builder (joins, `qAlias` conditions, subqueries) rather than a plain `FindOption`.

```typescript
const result = await em
  .createQueryBuilder(Post, "p")
  .where("p.isPublished", true)
  .orderBy({ createdAt: "DESC" })
  .paginate({ page: 2, pageSize: 10 });

result.data;            // Post[] for page 2
result.total;           // 235
result.page;            // 2
result.pageSize;        // 10
result.totalPages;      // 24
result.hasNextPage;     // true
result.hasPreviousPage; // true
```

`page`/`pageSize` are normalized the same way as `findWithPage()` (non-positive →
1, fractional → floored; defaults `page` 1 / `pageSize` 20), and `paginate()`
clones the builder so the source instance keeps no LIMIT/OFFSET and can be paged
again. For projected list views (`select(["id", "title"])`) use
`paginatePartial()`, which returns plain `Pick<T, K>` objects instead of entity
instances.

When the builder carries a `groupBy()`, every page row is a group, so `total`
counts the groups left after `HAVING` — the same rule `findWithPage()` applies to
`FindOption.groupBy`. See [getCount() with GROUP BY](./query-builder-execution.md#getcount-with-group-by-counts-groups).

The shape is identical to `em.findWithPage()`, so the two are interchangeable
depending on whether you start from a `FindOption` or a builder:

```typescript
// FindOption-based — same PagePaginationResult shape
const result = await em.findWithPage(Post, {
  where: { isPublished: true },
  orderBy: { createdAt: "DESC" },
  page: 2,
  pageSize: 10,
});
```

### When to Use Offset Pagination

- Users need to jump to page 5 or page 50 directly
- Total row count is small (under 100k)
- You need a "Page X of Y" UI

> **Warning** Performance degrades on large datasets because the database must scan and discard `OFFSET` rows before returning results. For a table with 1 million rows, requesting page 5,000 means the database reads 50,000 rows just to discard 49,990 of them.

## Cursor-Based Pagination

For large datasets, cursor-based pagination provides consistent performance regardless of how deep you paginate.

### How It Works

Instead of telling the database "skip N rows," cursor pagination tells it "start after this specific value." The value is encoded as a Base64 cursor string that the client passes back with each request.

Here is the SQL comparison side by side:

```sql
-- Offset at page 500 (skip = 4990): reads 5000 rows, discards 4990
SELECT "id", "title", "isPublished"
FROM "post"
WHERE "isPublished" = $1
ORDER BY "id" ASC
LIMIT 10 OFFSET 4990

-- Cursor at the same position: jumps directly to id > 4990
SELECT "id", "title", "isPublished"
FROM "post"
WHERE "isPublished" = $1 AND "id" > $2
ORDER BY "id" ASC
LIMIT 11
-- Parameters: [true, 4990]
```

The cursor approach requests `LIMIT 11` (one more than the page size of 10). If 11 rows come back, the ORM knows there is a next page and uses the last returned row's value as the next cursor. If 10 or fewer rows come back, this is the last page.

### How

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

// Second page -- pass the previous cursor
const page2 = await em.findWithCursor(Post, {
  take: 20,
  cursor: page1.nextCursor!,
  orderBy: "id",
  direction: "ASC",
});
```

The second page generates this SQL:

```sql
SELECT "id", "title", "content", "createdAt"
FROM "post"
WHERE "id" > $1
ORDER BY "id" ASC
LIMIT 21
-- Parameters: [20]  (the cursor value decoded from Base64)
```

### REST API Example

```typescript
// GET /posts?take=20&cursor=eyJ2IjoyMH0=
async function getPosts(req: Request, res: Response) {
  const result = await em.findWithCursor(Post, {
    take: parseInt(req.query.take as string) || 20,
    cursor: req.query.cursor as string | undefined,
    orderBy: "id",
    direction: "ASC",
    where: { isPublished: true },
  });

  res.json({
    items: result.data,
    nextCursor: result.nextCursor,
    hasNextPage: result.hasNextPage,
  });
}
```

### When to Use Cursor Pagination

- Infinite scroll or "Load more" UI
- Large datasets (100k+ rows)
- Real-time feeds where rows are constantly inserted
- Performance must remain consistent regardless of page depth

> **Hint** Cursor pagination requires an ordered, unique column (typically the primary key). It does not support jumping to arbitrary pages -- the client must paginate forward sequentially.

`findWithCursor()` applies the same filters as `find()`: soft-deleted rows are excluded unless you pass `withDeleted: true`, and paging a Single-Table-Inheritance child class returns only that subtype's rows (the discriminator predicate is added automatically).

## Streaming

When processing millions of rows, loading them all into memory at once is impractical. `stream()` returns an `AsyncGenerator` that fetches rows in configurable batches -- you process one entity at a time without holding the entire result set in memory.

### Why Not Just Use find() in a Loop?

You could write your own batching with `find()` and manual offset tracking. But `stream()` does this for you and gets the details right: it handles empty batches, detects the end of data, and yields entities one at a time so your processing code stays clean.

### The Batching SQL

Internally, `stream()` uses LIMIT/OFFSET to fetch one batch at a time. For a batch size of 500:

```sql
-- Batch 1: rows 0-499
SELECT "id", "name", "email" FROM "user" WHERE "isActive" = $1
ORDER BY "id" ASC LIMIT 500 OFFSET 0

-- Batch 2: rows 500-999
SELECT "id", "name", "email" FROM "user" WHERE "isActive" = $1
ORDER BY "id" ASC LIMIT 500 OFFSET 500

-- Batch 3: rows 1000-1499
SELECT "id", "name", "email" FROM "user" WHERE "isActive" = $1
ORDER BY "id" ASC LIMIT 500 OFFSET 1000

-- Continues until a batch returns fewer than 500 rows
```

Each batch is fetched, yielded one entity at a time through the AsyncGenerator, and then the batch is garbage-collected before the next one is fetched. Memory usage stays proportional to the batch size (500), not the total number of users (2 million).

```typescript
async *stream<T>(entity: Class<T>, options?: FindOption<T>, batchSize?: number): AsyncGenerator<T>
```

### Basic Usage

```typescript
for await (const user of em.stream(User, { where: { isActive: true } })) {
  await sendEmail(user.email);
}
```

The third parameter controls the batch size (default: 1000). When a batch returns fewer rows than the batch size, the generator knows it has reached the end and stops.

```typescript
// Fetch in batches of 500
for await (const post of em.stream(Post, { orderBy: { id: "ASC" } }, 500)) {
  await indexPost(post);
}
```

### Supported Options

`stream()` supports all `FindOption` properties -- `where`, `orderBy`, `relations`, `select`, `withDeleted`, etc.

```typescript
// Stream with relations and filtered columns
for await (const post of em.stream(Post, {
  select: ["id", "title"],
  relations: ["author"],
  where: { isPublished: true },
  orderBy: { createdAt: "DESC" },
}, 2000)) {
  console.log(`${post.title} by ${post.author.name}`);
}
```

### Counting Before Streaming

If you need the total count before processing, use `count()` first:

```typescript
const total = await em.count(User, { isActive: true });
console.log(`Processing ${total} users...`);

let processed = 0;
for await (const user of em.stream(User, { where: { isActive: true } })) {
  await process(user);
  processed++;
  if (processed % 1000 === 0) console.log(`${processed}/${total}`);
}
```

### When to Use stream() vs find()

| Scenario | Use |
|----------|-----|
| API endpoint returning a page of results | `find()` with pagination |
| Processing all rows in a table (ETL, export, batch emails) | `stream()` |
| Aggregating data from a large dataset | `stream()` or `em.query()` with DB-side aggregation |

> **Hint** For consistent results on large mutable tables, consider wrapping the stream in a transaction with `REPEATABLE READ` isolation to prevent phantom reads during iteration.

## Choosing a Strategy -- Quick Reference

| Question | Offset | Cursor | Stream |
|----------|--------|--------|--------|
| Can user jump to page N? | Yes | No | No |
| Performance at deep pages? | Degrades | Constant | N/A |
| Works with real-time inserts? | Skips/duplicates possible | Stable | Depends on isolation |
| Memory usage | Proportional to page size | Proportional to page size | Proportional to batch size |
| Use case | Admin dashboards | Infinite scroll | ETL / batch jobs |

## Next Steps

- [EntityManager](./entity-manager.md) -- Full CRUD reference
- [Query Builder](./query-builder.md) -- Complex queries with GROUP BY, JOIN, and aggregation
- [Production Guide](./production-guide.md) -- Tuning for high-traffic workloads
