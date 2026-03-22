# Logging & Diagnostics

Stingerloom provides built-in tools for debugging queries, detecting performance problems, and analyzing query plans.

## Query Logging

### Basic Logging

Enable SQL logging to see every query the ORM executes:

```typescript
await em.register({
  // ...
  logging: true, // Print executed SQL to console
});
```

### Detailed Logging

For finer control, pass an object with individual options:

```typescript
await em.register({
  // ...
  logging: {
    queries: true,       // Print every executed SQL statement to console
    slowQueryMs: 500,    // Warn on queries exceeding 500ms
    nPlusOne: true,      // Enable N+1 pattern detection
  },
});
```

The `queries` option is the most commonly used. When set to `true`, every SQL statement executed by the ORM is printed to the console along with its parameters. This is invaluable for debugging during development but should be disabled in production to avoid performance overhead and log noise.

### Programmatic Access

You can also query the log programmatically:

```typescript
const log = em.getQueryLog();
// [
//   { entity: "User", sql: "SELECT ...", durationMs: 12 },
//   { entity: "Cat", sql: "SELECT ...", durationMs: 8 },
//   ...
// ]
```

## N+1 Detection

The **N+1 problem** is a common performance pitfall where querying a list and then accessing each item's relationship generates 1 + N queries. For example, loading 100 posts and their authors produces 101 queries instead of 2.

Stingerloom automatically detects this pattern and logs warnings when enabled.

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

### How to Fix N+1

When a warning is triggered, switch to JOIN-based loading:

```typescript
// BAD — N+1: loads each author separately
const posts = await em.find(Post, {});
for (const post of posts) {
  console.log(post.author.name); // Triggers a query per post
}

// GOOD — eager loading: single JOIN query
const posts = await em.find(Post, {
  relations: ["author"],
});
```

Alternatively, use `eager: true` on the relation decorator to always load it:

```typescript
@ManyToOne(() => User, { joinColumn: "author_id", eager: true })
author!: User;
```

## Slow Query Warnings

Configure a threshold to automatically warn about queries that exceed a duration:

```typescript
await em.register({
  // ...
  logging: {
    slowQueryMs: 500, // Warn on queries taking longer than 500ms
  },
});
```

When a query exceeds the threshold, the ORM logs the SQL statement, its duration, and the entity involved. Use this information to identify missing indexes or inefficient queries.

## Query Timeout

### Global Setting

Set a timeout for all queries:

```typescript
await em.register({
  // ...
  queryTimeout: 5000, // 5-second timeout for all queries
});
```

### Per-Query Setting

Override the global timeout for individual queries:

```typescript
const users = await em.find(User, {
  where: { isActive: true },
  timeout: 2000, // 2-second timeout for this query only
});
```

A `QueryTimeoutError` is thrown when the timeout is exceeded.

| DB | Internal Implementation |
|----|------------------------|
| MySQL | `SET max_execution_time = N` |
| PostgreSQL | `SET LOCAL statement_timeout = N` |
| SQLite | Driver-level timeout |

## EXPLAIN — Query Plan Analysis

Use `explain()` to check whether a query is using indexes effectively:

```typescript
const result = await em.explain(User, {
  where: { email: "john@example.com" },
});

console.log(result.type); // "ref" — using an index
console.log(result.key);  // "idx_user_email"
console.log(result.rows); // 1 — estimated number of rows examined
```

This is useful for verifying that new indexes are being picked up, or diagnosing why a query is slow.

> **Note** `explain()` is supported in MySQL and PostgreSQL. In SQLite, an `InvalidQueryError` is thrown.

### ExplainResult Fields

| Field | Description |
|-------|-------------|
| `type` | Access type (`ALL`, `index`, `ref`, `const`, etc.) |
| `key` | Index used (if any) |
| `rows` | Estimated rows examined |
| `extra` | Additional information from the query planner |

## Production Recommendations

| Setting | Development | Production |
|---------|-------------|------------|
| `logging.queries` | `true` | `false` |
| `logging.slowQueryMs` | `100` | `500`–`1000` |
| `logging.nPlusOne` | `true` | `true` |
| `queryTimeout` | — | `5000`–`10000` |

In production, disable verbose query logging but keep slow query warnings and N+1 detection enabled. These have minimal overhead and catch real problems.

## Next Steps

- [Configuration](./configuration.md) — All connection and runtime options
- [Events & Subscribers](./events.md) — React to entity lifecycle events
- [Production Guide](./production-guide.md) — Connection pool monitoring, graceful shutdown
