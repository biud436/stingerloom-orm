# Logging & Diagnostics

This guide covers every diagnostic tool Stingerloom provides for understanding what your ORM is doing, finding performance problems, and fixing them.

---

## Query Logging

### Why query logging matters

An ORM writes SQL so you do not have to. That is great until something goes wrong -- a query returns wrong data, a page loads slowly, or a transaction deadlocks. At that point, you need to see the exact SQL being sent to the database. Query logging makes the invisible visible.

### Basic logging

```typescript
await em.register({
  // ...
  logging: true,
});
```

### What the output looks like

With logging enabled, every SQL statement appears in your console:

```
[Query] SELECT "id", "name", "email" FROM "user" WHERE "is_active" = $1 [true]  (4ms)
[Query] SELECT "id", "title", "body", "author_id" FROM "post" WHERE "author_id" = $1 [42]  (7ms)
[Query] INSERT INTO "post" ("title", "body", "author_id") VALUES ($1, $2, $3) RETURNING "id" ["Hello World", "My first post", 42]  (12ms)
[Query] UPDATE "user" SET "last_login" = $1 WHERE "id" = $2 ["2026-03-22T10:00:00.000Z", 42]  (3ms)
[Query] DELETE FROM "post" WHERE "id" = $1 [17]  (2ms)
```

Each line contains three pieces of information:

1. **The SQL statement** with parameter placeholders (`$1`, `$2`). These are not string-interpolated -- they are parameterized queries, which prevents SQL injection.
2. **The parameter values** in square brackets, in order.
3. **The execution time** in milliseconds.

### Detailed logging

For finer control, pass an object with individual flags:

```typescript
await em.register({
  // ...
  logging: {
    queries: true,       // Print every SQL statement (same as logging: true)
    slowQueryMs: 500,    // Warn on queries exceeding 500ms
    nPlusOne: true,      // Enable N+1 query pattern detection
  },
});
```

### Programmatic access

You can also retrieve the query log as structured data:

```typescript
const log = em.getQueryLog();
// [
//   { entityName: "User", sql: "SELECT ...", durationMs: 4, timestamp: 1711234567890 },
//   { entityName: "Post", sql: "SELECT ...", durationMs: 7, timestamp: 1711234567920 },
// ]
```

This is useful for writing performance tests (assert that a particular operation runs fewer than N queries), building custom dashboards, or feeding metrics into a monitoring system.

---

## N+1 Detection

### Why N+1 detection matters -- a concrete example

The N+1 problem is the single most common performance issue in applications that use an ORM. Let us make it concrete.

Suppose you have a blog with 100 posts, and each post belongs to an author. You want to display all posts with their author names.

**The naive approach (N+1 problem):**

```typescript
const posts = await em.find(Post, {}); // 1 query: SELECT * FROM post

for (const post of posts) {
  console.log(post.author.name);
  // Each access triggers: SELECT * FROM user WHERE id = ?
  // That is 100 more queries, one per post.
}
```

Total: **101 queries**. If each query takes 10ms (including network round-trip), that is 1,010 milliseconds -- over a second -- just to display a page of blog posts.

**The fix (eager loading with JOIN):**

```typescript
const posts = await em.find(Post, {
  relations: ["author"],
});
// 1 query: SELECT post.*, user.* FROM post LEFT JOIN user ON post.author_id = user.id
```

Total: **1 query**. Same data, approximately 10ms. That is a 100x improvement.

The N+1 problem is insidious because it does not feel wrong when you write the code. It works fine in development with 5 posts. It only becomes a problem in production with real data volumes. Stingerloom's N+1 detector catches it automatically.

### Configuration

```typescript
await em.register({
  type: "postgres",
  // ...
  logging: {
    nPlusOne: true,
  },
});
```

### How the detector works

Stingerloom's `QueryTracker` monitors every query that passes through the EntityManager. It maintains a sliding time window (default: 100ms) and counts how many queries target the same entity. When that count exceeds a threshold (default: 10 queries for the same entity within 100ms), it fires a warning:

```
[QueryTracker] [N+1 WARNING] Entity "User" queried 15+ times in 100ms. Consider using eager loading or relations option.
```

The warning fires once per entity per EntityManager lifetime, so your logs do not get flooded with repeated warnings.

### How to fix N+1 when you see a warning

**Option 1: Use the `relations` option in your find call:**

```typescript
// Before (N+1)
const posts = await em.find(Post, {});

// After (single JOIN query)
const posts = await em.find(Post, {
  relations: ["author"],
});
```

**Option 2: Set `eager: true` on the relation decorator:**

```typescript
@ManyToOne(() => User, { joinColumn: "author_id", eager: true })
author!: User;
```

With `eager: true`, the author is always loaded with a LEFT JOIN whenever you query posts -- no need to specify `relations` every time. Use this when you almost always need the related data.

---

## Slow Query Warnings

### Why slow query detection matters

A slow query might not be obvious. Your API endpoint returns in 800ms and nobody complains... until traffic increases and that 800ms query, running 50 times per second, saturates your database. Slow query warnings give you advance notice before problems become incidents.

### Configuration

```typescript
await em.register({
  // ...
  logging: {
    slowQueryMs: 500, // Warn on queries taking longer than 500ms
  },
});
```

### What the warning looks like

When a query exceeds the threshold:

```
[QueryTracker] [SLOW QUERY] 847ms: SELECT "id", "title", "body", "created_at" FROM "post" WHERE "body" LIKE '%search term%' ORDER BY "created_at" DESC
```

### What to do when you see a slow query warning

Slow queries almost always fall into one of these categories:

**1. Missing index.** The query scans every row in the table instead of using an index. Add an `@Index()` decorator to the column being filtered or sorted.

```typescript
@Column({ type: "varchar", length: 255 })
@Index()
email!: string;
```

**2. Full table scan on a large table.** You are selecting from a table with millions of rows without a WHERE clause, or your WHERE clause does not match any index.

**3. LIKE with a leading wildcard.** `WHERE body LIKE '%search%'` cannot use an index because the wildcard is at the beginning. Consider full-text search instead.

**4. Missing JOIN index.** A JOIN without an index on the foreign key column forces the database to scan the entire joined table for every row.

The next section shows how to use EXPLAIN to diagnose exactly what the database is doing.

---

## EXPLAIN -- Query Plan Analysis

### Why EXPLAIN matters

When a query is slow, EXPLAIN tells you *why*. It shows you the database's execution plan: which tables it scans, which indexes it uses (or ignores), and how many rows it expects to examine. Without EXPLAIN, you are guessing. With it, you know exactly where the bottleneck is.

### Basic usage

```typescript
const result = await em.explain(User, {
  where: { email: "john@example.com" },
});

console.log(result.type);  // Access type (e.g., "ref" = using an index)
console.log(result.key);   // Which index (e.g., "idx_user_email")
console.log(result.rows);  // Estimated rows examined (e.g., 1)
console.log(result.cost);  // Estimated cost
```

### ExplainResult fields

| Field | Description |
|-------|-------------|
| `type` | Access type -- how the database reads the table (see below) |
| `key` | The index actually used by the optimizer (null if no index) |
| `rows` | Estimated number of rows the database will examine |
| `cost` | Estimated cost (MySQL: filtered percentage, PostgreSQL: total_cost) |
| `possibleKeys` | List of indexes the optimizer considered |
| `raw` | The complete raw output from the database, as an array of objects |

### How to read MySQL EXPLAIN output

When you call `explain()` on a MySQL database, Stingerloom runs `EXPLAIN SELECT ...` and returns the result. The `type` field is the most important:

| type value | Meaning | Performance |
|------------|---------|-------------|
| `const` | The query matches at most one row (primary key or unique index lookup) | Best possible |
| `eq_ref` | One row is read from this table for each row from the previous table (JOIN on primary key) | Excellent |
| `ref` | All rows with matching index values are read | Good |
| `range` | Only rows in a given range are read, using an index | Good |
| `index` | Full index scan (reads every entry in the index) | Okay |
| `ALL` | Full table scan (reads every row in the table) | Worst -- add an index |

**Example: A well-indexed query on MySQL**

```typescript
const result = await em.explain(User, {
  where: { email: "john@example.com" },
});
// result.type = "ref"
// result.key  = "idx_user_email"
// result.rows = 1
```

This tells you: MySQL uses the `idx_user_email` index, does a lookup (not a scan), and expects to examine just 1 row. This is fast.

**Example: A full table scan on MySQL**

```typescript
const result = await em.explain(User, {
  where: { bio: "likes cats" },  // no index on bio
});
// result.type = "ALL"
// result.key  = null
// result.rows = 50000
```

This tells you: MySQL has to read all 50,000 rows in the table because there is no index on the `bio` column. Add an index or reconsider the query.

### How to read PostgreSQL EXPLAIN output

PostgreSQL's EXPLAIN output uses different terminology. The `type` field from Stingerloom maps to PostgreSQL's node types:

| type value | Meaning | Performance |
|------------|---------|-------------|
| `Index Scan` | Reads the index, then fetches matching rows from the table | Good |
| `Index Only Scan` | Reads only the index (all needed columns are in the index) | Best |
| `Bitmap Index Scan` | Builds a bitmap of matching rows, then reads them in bulk | Good for medium selectivity |
| `Seq Scan` | Sequential scan -- reads every row in the table | Worst -- add an index |

**Example: An indexed query on PostgreSQL**

```typescript
const result = await em.explain(User, {
  where: { email: "john@example.com" },
});
// result.type = "Index Scan"
// result.key  = "idx_user_email"
// result.rows = 1
// result.cost = 8.29
```

**Example: A sequential scan on PostgreSQL**

```typescript
const result = await em.explain(User, {
  where: { bio: "likes cats" },
});
// result.type = "Seq Scan"
// result.key  = null
// result.rows = 50000
// result.cost = 1234.00
```

The `cost` value in PostgreSQL is an abstract unit representing estimated I/O and CPU work. Lower is better. The absolute number does not matter -- what matters is comparing cost before and after adding an index.

> **Note:** `explain()` is supported in MySQL and PostgreSQL. In SQLite, an `InvalidQueryError` is thrown.

---

## Query Timeout

### Why query timeout matters

A query without a timeout is a ticking time bomb. If someone writes a query that accidentally scans 50 million rows, or a transaction holds a lock while waiting for user input, that query occupies a database connection indefinitely. With a connection pool of 10, just 10 such queries bring your entire application to a standstill.

A query timeout is a circuit breaker. It says: "If this query does not finish in N milliseconds, kill it and free the connection."

### Global setting

```typescript
await em.register({
  // ...
  queryTimeout: 5000, // 5-second timeout for all read queries
});
```

### Per-query override

Some queries legitimately take longer (batch imports, complex reports). Override the global timeout for those:

```typescript
const users = await em.find(User, {
  where: { isActive: true },
  timeout: 2000, // 2-second timeout for this query only
});
```

When the timeout fires, a `QueryTimeoutError` is thrown with the original SQL and the timeout value.

### What happens at the database level

Stingerloom uses the database's native timeout mechanism, not a JavaScript timer. This is important: a JavaScript `setTimeout` would only cancel the client-side wait while the query keeps running on the server, wasting database resources.

| DB | SQL sent before the query | Effect |
|----|--------------------------|--------|
| MySQL | `SET max_execution_time = 5000` | The MySQL server aborts the query after 5000ms |
| PostgreSQL | `SET LOCAL statement_timeout = '5000ms'` | PostgreSQL aborts the query; `SET LOCAL` scopes it to the current transaction |
| SQLite | Driver-level timeout | The SQLite driver enforces the timeout |

---

## Production Recommendations

| Setting | Development | Production | Why the difference |
|---------|-------------|------------|-------------------|
| `logging.queries` | `true` | `false` | Full query logging adds I/O overhead on every query. In production, your monitoring system should handle this, not stdout. |
| `logging.slowQueryMs` | `100` | `500`-`1000` | In development, catch everything over 100ms to build good habits. In production, 500ms-1s filters out noise and only flags genuinely problematic queries. |
| `logging.nPlusOne` | `true` | `true` | N+1 detection has minimal overhead (it counts queries in a time window, no I/O) and catches real problems that may only surface at production data volumes. Always keep this on. |
| `queryTimeout` | -- | `5000`-`10000` | In development, you want queries to complete so you can debug them. In production, a runaway query must be killed before it blocks the connection pool. 5-10 seconds is generous enough for legitimate queries and short enough to prevent cascading failures. |

### Summary of the production mindset

In development, you want maximum visibility: log every query, warn on anything over 100ms, let queries run to completion so you can debug them.

In production, you want minimum noise and maximum protection: silence routine query logs (your APM tool handles this), only flag queries that are genuinely slow, kill anything that runs too long, and always detect N+1 patterns because they are the most common cause of "it was fine in staging but slow in production."

---

## Next Steps

- [Configuration](./configuration.md) -- All connection and runtime options
- [Events & Subscribers](./events.md) -- React to entity lifecycle events
- [Production Guide](./production-guide.md) -- Connection pool monitoring, graceful shutdown
