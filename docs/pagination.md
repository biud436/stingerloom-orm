# Pagination & Streaming

Stingerloom provides three strategies for working with large datasets: offset-based pagination, cursor-based pagination, and streaming.

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

### findAndCount — Total Count in One Call

When building paginated UIs, you often need both the data and the total count. `findAndCount()` returns both in a single call.

```typescript
const [posts, total] = await em.findAndCount(Post, {
  orderBy: { createdAt: "DESC" },
  skip: 0,
  take: 10,
});

console.log(posts.length); // 10
console.log(total);        // Total number of posts (e.g., 235)
```

### When to Use Offset Pagination

- Users need to jump to page 5 or page 50 directly
- Total row count is small (< 100k)
- You need a "Page X of Y" UI

> **Warning** Performance degrades on large datasets because the database must scan and discard `OFFSET` rows before returning results.

## Cursor-Based Pagination

For large datasets, cursor-based pagination provides consistent performance regardless of how deep you paginate.

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

> **Hint** Cursor pagination requires an ordered, unique column (typically the primary key). It does not support jumping to arbitrary pages.

## Streaming

When processing millions of rows, loading them all into memory at once is impractical. `stream()` returns an `AsyncGenerator` that fetches rows in configurable batches — you process one entity at a time without holding the entire result set in memory.

```typescript
async *stream<T>(entity: Class<T>, options?: FindOption<T>, batchSize?: number): AsyncGenerator<T>
```

### Basic Usage

```typescript
for await (const user of em.stream(User, { where: { isActive: true } })) {
  await sendEmail(user.email);
}
```

The third parameter controls the batch size (default: 1000). Internally, the ORM uses LIMIT/OFFSET to fetch one batch at a time. When a batch returns fewer rows than the batch size, the generator knows it has reached the end and stops.

```typescript
// Fetch in batches of 500
for await (const post of em.stream(Post, { orderBy: { id: "ASC" } }, 500)) {
  await indexPost(post);
}
```

### Supported Options

`stream()` supports all `FindOption` properties — `where`, `orderBy`, `relations`, `select`, `withDeleted`, etc.

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

## Choosing a Strategy

| Strategy | Best for | Trade-off |
|----------|----------|-----------|
| Offset (`skip`/`take`) | Small datasets, "Page X of Y" UIs | Slow at high offsets |
| Cursor (`findWithCursor`) | Large datasets, infinite scroll | No random page access |
| Streaming (`stream()`) | Batch processing millions of rows | Not for API responses |

## Next Steps

- [EntityManager](./entity-manager.md) — Full CRUD reference
- [Query Builder](./query-builder.md) — Complex queries with GROUP BY, JOIN, and aggregation
- [Production Guide](./production-guide.md) — Tuning for high-traffic workloads
