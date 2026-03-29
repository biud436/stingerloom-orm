# Raw Pipeline

## The Problem: Why Entity Transformation Costs You

When you call `em.find(User)`, a lot happens behind the scenes. The ORM sends a SQL query, receives rows from the database driver, and then transforms each row into a typed entity instance. This transformation involves remapping column names, applying column transformers, deserializing objects, and loading relations.

For 100 rows, this is invisible. For 100,000 rows, it becomes the bottleneck.

Here is the data flow for a normal `em.find()` call:

```
Database wire protocol
    → pg/mysql2/sqlite parses into JS objects        (driver layer)
    → ResultTransformer remaps column names           (ORM layer)
    → deserializeEntity() creates class instances     (ORM layer)
    → applyColumnTransforms() runs transformers       (ORM layer)
    → RelationLoader resolves eager/lazy relations    (ORM layer)
    → You get typed entity instances                  (your code)
```

Every step after the driver layer is overhead. If you are sending data to a gRPC service, exporting to CSV, or feeding an ETL pipeline, you do not need entity instances. You need the raw data, as fast as possible, with as little memory as possible.

Think of it like ordering a meal at a restaurant. Normally, the kitchen (ORM) prepares a beautifully plated dish (entity instance) from raw ingredients (database rows). But if you are a food supplier who just needs the ingredients to send to another kitchen, all that plating is wasted effort. You want the ingredients straight from the pantry.

That is what the Raw Pipeline plugin does. It gives you direct access to the pantry.

## Installation

The Raw Pipeline is a plugin. You install it the same way as any other plugin:

```typescript
import { rawPipelinePlugin } from "@stingerloom/orm";

em.extend(rawPipelinePlugin());
```

Or via the `plugins` array in `register()`:

```typescript
await em.register({
  type: "postgres",
  // ... connection options
  entities: [User, Post],
  plugins: [rawPipelinePlugin()],
});
```

This adds a `pipe()` method to your EntityManager.

## Basic Usage

### Streaming Raw Rows

`pipe()` creates a pipeline. Call `raw()` to get an async generator that yields batches of plain objects -- no entity transformation, no class instantiation.

```typescript
const pipeline = em.pipe(User, {
  where: { active: true },
  batchSize: 5000,
});

for await (const batch of pipeline.raw()) {
  // batch is Record<string, unknown>[]
  // These are plain objects straight from the database driver
  console.log(batch.length); // up to 5000 rows per batch
}
```

Each batch is an array of plain JavaScript objects with column names as keys. The pipeline handles pagination internally -- it issues `SELECT ... LIMIT 5000 OFFSET 0`, then `LIMIT 5000 OFFSET 5000`, and so on until no more rows are returned.

### Why Batching Matters

If you have 1 million rows and load them all at once, Node.js needs to hold all 1 million objects in memory simultaneously. With batching, only one batch (e.g., 5,000 rows) lives in memory at a time. As you process and release each batch, the garbage collector reclaims the memory.

```typescript
// Bad: all rows in memory at once
const allRows = await em.find(User); // 1M rows → out of memory

// Good: 5,000 rows at a time
for await (const batch of em.pipe(User, { batchSize: 5000 }).raw()) {
  await sendToExternalService(batch);
  // batch is released after this iteration
}
```

## Transformation Chains

### map()

Chain `.map()` to transform each row before it is yielded. This is useful for selecting only the fields you need, renaming keys, or converting types.

```typescript
const pipeline = em.pipe(User, { batchSize: 5000 });

for await (const batch of pipeline.map(row => ({
  userId: row.id,
  displayName: row.name,
  email: row.email,
})).raw()) {
  // batch is { userId, displayName, email }[]
  sendToGrpc(batch);
}
```

You can chain multiple `.map()` calls:

```typescript
const csvLines = await em.pipe(User)
  .map(row => ({ id: row.id, name: row.name }))
  .map(row => `${row.id},${row.name}`)
  .collect();
// csvLines is string[]
```

### filter()

Chain `.filter()` after `.map()` to drop rows that do not match a predicate:

```typescript
const activeAdults = await em.pipe(User)
  .map(row => ({
    id: row.id as number,
    age: row.age as number,
    active: row.active as boolean,
  }))
  .filter(row => row.active && row.age >= 18)
  .collect();
```

### collect()

`collect()` is a convenience method that gathers all batches into a single array. Use it when the full dataset fits in memory and you want a simple array result.

```typescript
const allRows = await em.pipe(User, { where: { active: true } }).collect();
// allRows is Record<string, unknown>[]
```

::: warning
`collect()` loads everything into memory. For large datasets, iterate with `for await` instead.
:::

## Binary Mode

`binary()` goes one level deeper. Instead of the normal driver parsing (which converts wire data into JavaScript objects), it requests raw buffers or array-format results directly from the database driver.

```typescript
for await (const batch of em.pipe(User, { batchSize: 5000 }).binary()) {
  // pg: each row value is a Buffer (binary wire format)
  // mysql2: each row value is a Buffer (typeCast disabled)
  // sqlite: same as raw() (SQLite has no binary wire format)
}
```

You can also request array mode, which returns rows as arrays instead of keyed objects:

```typescript
for await (const batch of em.pipe(User).binary({ arrayMode: true })) {
  // Each row is [value1, value2, value3, ...] instead of { col1: value1, ... }
  // No object key allocation = less memory, less GC pressure
}
```

### What Each Driver Does

| Option | PostgreSQL (pg) | MySQL (mysql2) | SQLite (better-sqlite3) |
|--------|----------------|----------------|------------------------|
| `binary: true` | Sets `binary: true` on query config. Column values arrive as `Buffer` objects in PostgreSQL's native binary format. | Sets `typeCast: false`. All columns returned as raw `Buffer` without type conversion. | No effect. BLOB columns are already `Buffer`. |
| `arrayMode: true` | Sets `rowMode: 'array'`. Rows are `any[]` in column order. | Sets `rowsAsArray: true`. | Uses `stmt.raw().all()`. |

### When to Use Binary Mode

Binary mode is most useful when you are:
- Forwarding data to another system that accepts binary (protobuf, MessagePack)
- Minimizing memory allocation (array mode avoids object key strings)
- Processing BLOB columns without double-parsing

If you just need plain objects without entity transformation, `raw()` is sufficient and easier to work with.

## count()

Get the total number of rows matching the pipeline's entity table:

```typescript
const pipeline = em.pipe(User);
const total = await pipeline.count();
console.log(`Total users: ${total}`);
```

## Performance Benchmark

We measured four approaches for reading data from a SQLite in-memory database with 6 columns per row. Each method was run 5 times and the median is reported.

### 1,000 rows

| Method | Time | Memory | Throughput |
|--------|------|--------|------------|
| `em.find()` | 6.8ms | 9.28 MB | 146,701 rows/s |
| `em.query()` | 0.7ms | 0.69 MB | 1,432,837 rows/s |
| `pipe().raw()` | 0.9ms | 0.74 MB | 1,137,442 rows/s |
| `pipe().binary()` | 0.4ms | 0.28 MB | 2,225,521 rows/s |

### 10,000 rows

| Method | Time | Memory | Throughput |
|--------|------|--------|------------|
| `em.find()` | 42.0ms | 20.19 MB | 238,334 rows/s |
| `em.query()` | 4.8ms | 6.74 MB | 2,097,096 rows/s |
| `pipe().raw()` | 5.6ms | 7.18 MB | 1,800,315 rows/s |
| `pipe().binary()` | 5.5ms | 2.79 MB | 1,833,573 rows/s |

### 100,000 rows

| Method | Time | Memory | Throughput |
|--------|------|--------|------------|
| `em.find()` | 388.9ms | 84.81 MB | 257,120 rows/s |
| `em.query()` | 121.8ms | 67.15 MB | 821,264 rows/s |
| `pipe().raw()` | 111.1ms | 64.48 MB | 900,467 rows/s |
| **`pipe().binary()`** | **88.0ms** | **27.14 MB** | **1,136,339 rows/s** |

### What the Numbers Tell Us

At 100,000 rows:

- **`pipe().binary()` is 4.4x faster than `em.find()`** and uses 68% less memory.
- **`pipe().raw()` is 3.5x faster than `em.find()`** and uses 24% less memory.
- `em.query()` is already fast (it skips entity transformation), but `pipe()` adds batched streaming so memory stays bounded regardless of total row count.

The gap widens with more rows. At 1,000 rows, the overhead is negligible -- use `em.find()` and enjoy type safety. At 100,000+ rows, the Raw Pipeline pays for itself.

### How to Reproduce

```bash
NODE_OPTIONS="--expose-gc" npx ts-node __tests__/bench/raw-pipeline-bench.ts
```

## Real-World Patterns

### ETL Export to CSV

```typescript
import { createWriteStream } from "fs";

const out = createWriteStream("users.csv");
out.write("id,name,email,age\n");

for await (const batch of em.pipe(User, { batchSize: 10000 }).raw()) {
  for (const row of batch) {
    out.write(`${row.id},${row.name},${row.email},${row.age}\n`);
  }
}

out.end();
```

### Feeding a gRPC Stream

```typescript
for await (const batch of em.pipe(Order, {
  where: { status: "pending" },
  batchSize: 1000,
}).map(row => ({
  orderId: String(row.id),
  amount: Number(row.amount),
  currency: String(row.currency),
})).raw()) {
  for (const item of batch) {
    grpcStream.write(OrderProto.encode(item).finish());
  }
}
```

### Memory-Bounded Aggregation

```typescript
let total = 0;
let count = 0;

for await (const batch of em.pipe(SensorReading, { batchSize: 50000 }).raw()) {
  for (const row of batch) {
    total += Number(row.value);
    count++;
  }
}

console.log(`Average: ${total / count}`);
```

## API Reference

### `rawPipelinePlugin()`

Factory function that creates the plugin. Install it with `em.extend()`.

```typescript
import { rawPipelinePlugin } from "@stingerloom/orm";

em.extend(rawPipelinePlugin());
```

### `em.pipe(entity, options?)`

| Parameter | Type | Description |
|-----------|------|-------------|
| `entity` | `ClazzType<T>` | The entity class (used for table name resolution) |
| `options.where` | `WhereClause<T>` | Filter conditions (same syntax as `em.find()`) |
| `options.orderBy` | `OrderByOption<T>` | Sort order |
| `options.select` | `string[]` | Specific columns to select (default: `*`) |
| `options.batchSize` | `number` | Rows per batch (default: 1000, minimum: 1) |

Returns a `RawPipeline<T>`.

### `RawPipeline<T>`

| Method | Returns | Description |
|--------|---------|-------------|
| `raw()` | `AsyncGenerator<Record<string, unknown>[]>` | Yields batches of plain objects |
| `binary(opts?)` | `AsyncGenerator<any[]>` | Yields batches using driver-level options |
| `map(fn)` | `MappedPipeline<U>` | Chain a row transformation |
| `filter(fn)` | `MappedPipeline<Record<string, unknown>>` | Filter rows by predicate |
| `collect()` | `Promise<Record<string, unknown>[]>` | Gather all batches into one array |
| `count()` | `Promise<number>` | Count total rows for the entity table |

### `MappedPipeline<U>`

| Method | Returns | Description |
|--------|---------|-------------|
| `raw()` | `AsyncGenerator<U[]>` | Yields transformed batches |
| `map(fn)` | `MappedPipeline<V>` | Chain another transformation |
| `filter(fn)` | `FilteredMappedPipeline<U>` | Filter transformed rows |
| `collect()` | `Promise<U[]>` | Gather all batches into one array |

### `DriverQueryOptions`

| Option | Type | Description |
|--------|------|-------------|
| `binary` | `boolean` | Request binary-format results from the driver |
| `arrayMode` | `boolean` | Return rows as arrays instead of objects |

## Next Steps

- [Plugins](./plugins.md) -- How the plugin system works
- [Raw SQL & CTE](./raw-sql.md) -- When you need full SQL control
- [Pagination & Streaming](./pagination.md) -- Entity-level streaming with `em.stream()`
