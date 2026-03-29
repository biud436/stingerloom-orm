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

## How It Differs from em.query()

You might ask: "I can already use `em.query(sql)` to get raw results. Why do I need a plugin?"

`em.query()` runs a single SQL statement and returns all results at once. It works, but it has two limitations:

1. **No batching.** If your query returns 500,000 rows, all 500,000 objects exist in memory at the same time. There is no built-in way to process them incrementally.

2. **You write SQL by hand.** You construct the SQL string yourself, manage parameter binding, and handle table/column names manually. There is no integration with entity metadata, NamingStrategy, or the ORM's WHERE resolver.

The Raw Pipeline bridges these gaps. It reads entity metadata to generate correct SQL (including NamingStrategy column mappings), uses the same WHERE resolver as `em.find()` (so filter syntax is identical), and streams results in configurable batches so memory usage stays bounded.

```
em.find()     → Full entity transformation. Type-safe. Slow at scale.
em.query()    → No transformation. Raw SQL. No batching.
em.pipe()     → No transformation. Entity-aware SQL. Batched streaming.
```

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

This adds a `pipe()` method to your EntityManager. If you call `em.pipe()` without installing the plugin first, the ORM throws a clear error telling you what to do.

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

### WHERE Clause — Same Syntax as em.find()

The pipeline's `where` option uses the exact same resolver as `em.find()`. Every filter operator works identically:

```typescript
// Simple equality
em.pipe(User, { where: { role: "admin" } })

// Comparison operators
em.pipe(User, { where: { age: { gte: 18, lt: 65 } } })

// String operators
em.pipe(User, { where: { name: { contains: "alice" } } })
em.pipe(User, { where: { email: { startsWith: "admin" } } })
em.pipe(User, { where: { bio: { ilike: "%engineer%" } } })  // PostgreSQL only

// Logical combinators
em.pipe(User, {
  where: {
    OR: [
      { status: "active" },
      { role: "admin" },
    ],
  },
})

// NOT
em.pipe(User, {
  where: {
    NOT: { status: "banned" },
  },
})

// IN / NOT IN
em.pipe(User, { where: { id: { in: [1, 2, 3] } } })

// NULL checks
em.pipe(User, { where: { deletedAt: { isNull: true } } })

// BETWEEN
em.pipe(Order, { where: { total: { between: [100, 500] } } })

// Full-text search (MySQL: MATCH AGAINST, PostgreSQL: to_tsvector)
em.pipe(Post, { where: { content: { search: "typescript orm" } } })
```

This is important. In the initial version, the pipeline had its own WHERE builder that was missing many operators (`contains`, `startsWith`, `ilike`, `NOT`, `AND`, `search`). Now it delegates to the core `WhereResolver`, so there is zero divergence from `em.find()` behavior.

### NamingStrategy Support

If you use a `NamingStrategy` (like `SnakeNamingStrategy`), the pipeline maps property names to database column names automatically:

```typescript
// Entity with SnakeNamingStrategy:
//   firstName (property) → first_name (column)
//   lastName  (property) → last_name  (column)

em.pipe(User, {
  where: { firstName: "Alice" },      // → WHERE "first_name" = 'Alice'
  select: ["firstName", "lastName"],   // → SELECT "first_name", "last_name"
  orderBy: { firstName: "ASC" },       // → ORDER BY "first_name" ASC
})
```

## Pagination Strategies

The pipeline supports two pagination strategies. The right choice depends on how much data you are traversing.

### LIMIT/OFFSET (Default)

The default strategy appends `LIMIT N OFFSET M` to each batch query:

```
Batch 1:  SELECT * FROM "user" WHERE ... LIMIT 5000 OFFSET 0
Batch 2:  SELECT * FROM "user" WHERE ... LIMIT 5000 OFFSET 5000
Batch 3:  SELECT * FROM "user" WHERE ... LIMIT 5000 OFFSET 10000
...
```

This works well for small-to-medium datasets (up to ~100K rows). However, as the offset grows, the database must scan and discard all the skipped rows before returning the ones you need. At offset 1,000,000, the database scans 1,000,000 rows just to throw them away.

### Keyset Pagination

Keyset pagination solves this. Instead of telling the database "skip N rows", it says "give me rows after the last value I saw". The database can use an index to jump directly to the right position.

```
Batch 1:  SELECT * FROM "user" WHERE ... ORDER BY "id" ASC LIMIT 5000
Batch 2:  SELECT * FROM "user" WHERE ... AND "id" > 5000 ORDER BY "id" ASC LIMIT 5000
Batch 3:  SELECT * FROM "user" WHERE ... AND "id" > 10000 ORDER BY "id" ASC LIMIT 5000
...
```

Enable it with `keyset: true`:

```typescript
for await (const batch of em.pipe(User, {
  orderBy: { id: "ASC" },
  keyset: true,
  batchSize: 5000,
}).raw()) {
  process(batch);
}
```

The pipeline automatically tracks the last value from each batch and injects it as a WHERE condition for the next query. You do not need to manage the cursor yourself.

::: tip When to use keyset
Use `keyset: true` when:
- The total dataset is large (100K+ rows)
- You have an index on the `orderBy` column
- You are iterating through the entire table or a large subset

Use the default (LIMIT/OFFSET) when:
- The total dataset is small
- You need random-access page jumps (keyset can only go forward)
- You are ordering by multiple columns (keyset currently supports one column)
:::

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

You can chain multiple `.map()` calls. Each transformation is fused into a single function internally, so there is no intermediate array allocation:

```typescript
const csvLines = await em.pipe(User)
  .map(row => ({ id: row.id, name: row.name }))
  .map(row => `${row.id},${row.name}`)
  .collect();
// csvLines is string[]
```

### filter()

Chain `.filter()` to drop rows that do not match a predicate. This filter runs in JavaScript after the rows are fetched -- it does not modify the SQL query.

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

::: tip filter() vs where
Prefer `where` for filtering when possible -- it runs in the database and reduces the amount of data transferred. Use `.filter()` only for conditions that cannot be expressed in SQL, such as complex JavaScript logic or cross-field calculations.

```typescript
// Good: filter in the database
em.pipe(User, { where: { active: true, age: { gte: 18 } } })

// Use filter() for complex JS logic that SQL can't express
em.pipe(User).filter(row => someComplexJsFunction(row))
```
:::

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

### What Binary Mode Does

When you call `em.find()` or even `pipe().raw()`, the database driver (pg, mysql2, better-sqlite3) parses the wire protocol response into JavaScript objects. Column values are automatically converted: integers become `number`, strings become `string`, timestamps become `Date`, and so on.

`binary()` tells the driver to skip some or all of this parsing. The result depends on which options you pass:

**`binary: true`** — requests raw byte buffers instead of parsed values:

```typescript
for await (const batch of em.pipe(User, { batchSize: 5000 }).binary()) {
  // Default: { binary: true }
  // pg:     row.name is Buffer<75 73 65 72 5f 30> instead of "user_0"
  // mysql2: row.name is Buffer<75 73 65 72 5f 30> instead of "user_0"
  // sqlite: no effect (no binary wire format)
}
```

**`arrayMode: true`** — returns rows as positional arrays instead of keyed objects:

```typescript
for await (const batch of em.pipe(User).binary({ arrayMode: true })) {
  // row is [1, "user_0", 25, true] instead of { id: 1, name: "user_0", age: 25, active: true }
  // No object key strings allocated = less memory, less GC pressure
}
```

**Combined** — both options together for minimum overhead:

```typescript
for await (const batch of em.pipe(User).binary({ binary: true, arrayMode: true })) {
  // row is [Buffer, Buffer, Buffer, Buffer]
  // Absolute minimum allocation — useful for forwarding to another binary protocol
}
```

### What Each Driver Does

The `binary()` method calls `queryWithOptions()` on the underlying driver, which translates the options into driver-native configuration:

| Option | PostgreSQL (pg) | MySQL (mysql2) | SQLite (better-sqlite3) |
|--------|----------------|----------------|------------------------|
| `binary: true` | Sets `binary: true` on `QueryConfig`. PostgreSQL's wire protocol natively supports binary format — the server sends column values as their binary representation instead of text. `varchar` columns arrive as `Buffer`, `int4` may still be parsed as `number` (pg handles some binary types natively). | Sets `typeCast: false` on the query options. mysql2 skips all type conversion — every column value is returned as a raw `Buffer`, regardless of type. | No effect. SQLite is an embedded database with no wire protocol. BLOB columns are already returned as `Buffer`. |
| `arrayMode: true` | Sets `rowMode: 'array'` on `QueryConfig`. pg returns rows as `any[]` in column order instead of `{ column: value }` objects. | Sets `rowsAsArray: true`. mysql2 returns rows as `any[]` in column order. | Calls `stmt.raw(true)` before `.all()`. better-sqlite3 returns rows as arrays in column order. |

### Verified with Real Databases

These behaviors were verified with 27 integration tests running against real PostgreSQL and MySQL instances:

**PostgreSQL (pg 8.18.0):**

```typescript
// binary: true → varchar columns arrive as Buffer
const batch = await collectFirst(em.pipe(User).binary({ binary: true }));
const row = batch[0];
// row.name is Buffer — decode it:
Buffer.isBuffer(row.name); // true (for varchar columns)
row.name.toString("utf-8"); // "user_0"

// arrayMode: true → positional arrays
const batch2 = await collectFirst(em.pipe(User).binary({ arrayMode: true }));
Array.isArray(batch2[0]); // true
batch2[0].length; // 4 (id, name, age, active)

// combined: binary + array → Buffer arrays
const batch3 = await collectFirst(em.pipe(User).binary({ binary: true, arrayMode: true }));
Array.isArray(batch3[0]); // true
// Each element is a value (some may be Buffer, some parsed)
```

**MySQL (mysql2 3.16.3):**

```typescript
// binary: true → typeCast disabled, all values as Buffer
const batch = await collectFirst(em.pipe(User).binary({ binary: true }));
const row = batch[0];
Buffer.isBuffer(row.name); // true
row.name.toString("utf-8"); // "user_0"

// arrayMode: true → positional arrays
const batch2 = await collectFirst(em.pipe(User).binary({ arrayMode: true }));
Array.isArray(batch2[0]); // true
batch2[0].length >= 4; // true

// Data integrity preserved through Buffer round-trip
const nameBuffer = row.name as Buffer;
nameBuffer.toString("utf-8") === "user_0"; // true ✓
```

### When to Use Each Option

| Option | Use Case | Benefit |
|--------|----------|---------|
| `{ binary: true }` | Forwarding to protobuf / MessagePack / Avro encoder | Skip JS type parsing. Encoder reads Buffers directly. |
| `{ arrayMode: true }` | High-throughput ETL where you know column order | ~20% less memory (no object key strings). Faster iteration. |
| `{ binary: true, arrayMode: true }` | Maximum throughput pipeline — data goes straight to another binary system | Minimum possible allocation per row. |
| `{}` or `raw()` | Need human-readable data, column names matter | Easy to work with. Use for most cases. |

### Keyset Pagination with Binary Mode

Keyset pagination works with `binary()` in non-array modes. When `arrayMode: true` is combined with `keyset: true`, the pipeline automatically falls back to LIMIT/OFFSET — because keyset requires extracting the cursor value by column name, which is not possible when rows are positional arrays.

```typescript
// This works — keyset + binary (non-array)
for await (const batch of em.pipe(User, {
  orderBy: { id: "ASC" },
  keyset: true,
  batchSize: 5000,
}).binary({ binary: true })) {
  // Keyset pagination with binary Buffers
}

// This also works — but falls back to LIMIT/OFFSET internally
for await (const batch of em.pipe(User, {
  orderBy: { id: "ASC" },
  keyset: true,
  batchSize: 5000,
}).binary({ arrayMode: true })) {
  // arrayMode + keyset → automatic fallback to LIMIT/OFFSET
}
```

### Binary Mode Benchmark — Real Databases

We ran the same benchmark against real PostgreSQL and MySQL databases over a local network. These results are very different from the SQLite in-memory benchmark, and understanding why is important for choosing the right approach.

**PostgreSQL (pg 8.18.0, remote server):**

| Method | 1K rows | 10K rows | 100K rows | Memory (100K) |
|--------|---------|----------|-----------|---------------|
| `em.find()` | 19.0ms | 155.1ms | **1.54s** | 44.28 MB |
| `pipe().raw()` | 24.2ms | 257.8ms | 3.04s | **27.87 MB** |
| `pipe().binary()` | 22.2ms | 204.5ms | 2.79s | 27.36 MB |
| `pipe().arrayMode()` | 19.7ms | 268.2ms | 2.77s | **27.40 MB** |

**MySQL (mysql2 3.16.3, remote MariaDB):**

| Method | 1K rows | 10K rows | 100K rows | Memory (100K) |
|--------|---------|----------|-----------|---------------|
| `em.find()` | 17.9ms | 146.4ms | **1.32s** | 41.84 MB |
| `pipe().raw()` | 22.9ms | 262.6ms | 5.99s | **29.97 MB** |
| `pipe().binary()` | 23.5ms | 288.6ms | 5.76s | **36.41 MB** |
| `pipe().arrayMode()` | 21.0ms | 299.0ms | 5.58s | **31.37 MB** |

### Why pipe() Is Slower Than em.find() on Remote Databases

This is counterintuitive. `pipe()` skips entity transformation, so it should be faster. But on remote databases, it is 2-5x *slower* than `em.find()`. Here is why.

The bottleneck is not transformation — it is **query count**:

```
em.find()       →  1 query   (SELECT * FROM "users")
pipe(bs=1000)   →  101 queries  (SELECT ... LIMIT 1000) × 100 + 1 empty check
```

Each query is a full network round-trip: the client sends the SQL over TCP, the server parses and executes it, and sends the result back. On a local network with ~1ms latency, 101 round-trips cost ~100ms just in network overhead — before any data is transferred.

With SQLite (in-process, no network), there is zero round-trip cost, so `pipe()` wins on pure CPU savings from skipping entity transformation. On remote databases, the network cost of 100 extra queries far exceeds the CPU savings.

This is a fundamental trade-off inherent to batched streaming:

| | em.find() | pipe() |
|---|---|---|
| Queries | 1 | N (100K rows / batchSize) |
| Network round-trips | 1 | N |
| Peak memory | All rows at once | 1 batch |
| Entity transformation | Yes (CPU cost) | No (CPU saved) |

### The Real Value of pipe() on Remote Databases: Memory Control

The numbers above collected all pipe() results into a single array (`collect()`) — which defeats the purpose of batching. In real usage, you process and discard each batch:

```typescript
// This uses ~27 MB regardless of total row count
for await (const batch of em.pipe(User, { batchSize: 5000 }).raw()) {
  await sendToExternalService(batch);
  // batch is GC'd after this iteration
}

// This uses ~44 MB for 100K rows, ~440 MB for 1M rows
const all = await em.find(User);
```

At 100K rows, `em.find()` loads 44 MB at once. At 1M rows, that becomes ~440 MB. At 10M rows, you run out of memory. `pipe()` stays at ~27 MB no matter how many rows exist. That is the point.

::: tip When to use pipe() vs em.find() on remote databases
- **< 50K rows, fits in memory:** Use `em.find()`. Faster due to single query.
- **> 50K rows, or memory-constrained:** Use `pipe()`. Slower wall-clock time, but bounded memory.
- **Need to forward to another system (gRPC, CSV, etc.):** Use `pipe()`. You are streaming to an external sink anyway — the per-batch overhead is amortized.
- **Need raw Buffers:** Use `pipe().binary()`. This is the only way to get driver-level binary data.

For maximum throughput when streaming large datasets, increase `batchSize` to reduce the number of round-trips (e.g., `batchSize: 10000` or `batchSize: 50000`).
:::

### Integration Test Results

The binary mode was verified with 27 integration tests against real PostgreSQL and MySQL:

```
MySQL: 13 tests passed
  ✓ raw baseline (plain objects, WHERE, count)
  ✓ arrayMode (arrays, total count, data values)
  ✓ binary (Buffers, all rows, data integrity round-trip)
  ✓ keyset pagination (raw mode, binary non-array)
  ✓ map() chain, performance comparison

PostgreSQL: 14 tests passed
  ✓ raw baseline (plain objects, WHERE, count)
  ✓ arrayMode (arrays, total count, data values)
  ✓ binary (binary wire format, all rows, Buffer round-trip)
  ✓ binary + arrayMode combined
  ✓ keyset pagination (raw mode, binary non-array)
  ✓ map() chain, performance comparison
```

### Reproducing the Benchmarks

```bash
# PostgreSQL only
INTEGRATION_TEST=true INTEGRATION_TEST_MYSQL=false \
  NODE_OPTIONS="--expose-gc" npx ts-node --project __tests__/bench/tsconfig.json \
  __tests__/bench/raw-pipeline-binary-bench.ts

# MySQL only
INTEGRATION_TEST=true INTEGRATION_TEST_POSTGRES=false \
  NODE_OPTIONS="--expose-gc" npx ts-node --project __tests__/bench/tsconfig.json \
  __tests__/bench/raw-pipeline-binary-bench.ts
```

## count()

Get the total number of rows matching the pipeline's WHERE clause:

```typescript
const pipeline = em.pipe(User, { where: { active: true } });
const total = await pipeline.count();
console.log(`Active users: ${total}`);
```

The `count()` method applies the same WHERE conditions as `raw()`. If you create a pipeline with `where: { active: true }`, then `count()` returns only the count of active users, not all users.

```typescript
const pipeline = em.pipe(Order, {
  where: {
    status: "pending",
    total: { gte: 100 },
  },
});

const pendingCount = await pipeline.count();
console.log(`${pendingCount} pending orders over $100`);

for await (const batch of pipeline.raw()) {
  // process the same rows that were counted
}
```

## Performance Benchmark

We measured four approaches for reading data from a SQLite in-memory database with 6 columns per row. Each method was run 5 times and the median is reported.

### 1,000 rows

| Method | Time | Memory | Throughput |
|--------|------|--------|------------|
| `em.find()` | 6.5ms | 8.79 MB | 153,579 rows/s |
| `em.query()` | 0.6ms | 0.69 MB | 1,626,016 rows/s |
| `pipe().raw()` | 1.0ms | 0.74 MB | 988,631 rows/s |
| `pipe().binary()` | 0.5ms | 0.28 MB | 2,095,338 rows/s |

### 10,000 rows

| Method | Time | Memory | Throughput |
|--------|------|--------|------------|
| `em.find()` | 36.6ms | 18.80 MB | 272,947 rows/s |
| `em.query()` | 3.8ms | 6.74 MB | 2,610,114 rows/s |
| `pipe().raw()` | 5.6ms | 7.19 MB | 1,794,299 rows/s |
| `pipe().binary()` | 3.6ms | 2.88 MB | 2,772,644 rows/s |

### 100,000 rows

| Method | Time | Memory | Throughput |
|--------|------|--------|------------|
| `em.find()` | 319.5ms | 83.12 MB | 313,015 rows/s |
| `em.query()` | 110.2ms | 67.15 MB | 907,842 rows/s |
| `pipe().raw()` | 102.6ms | 64.55 MB | 974,222 rows/s |
| **`pipe().binary()`** | **76.7ms** | **27.25 MB** | **1,303,337 rows/s** |

### What the Numbers Tell Us

At 100,000 rows:

- **`pipe().binary()` is 4.2x faster than `em.find()`** and uses 67% less memory.
- **`pipe().raw()` is 3.1x faster than `em.find()`** and uses 22% less memory.
- `em.query()` is similar in speed to `pipe().raw()`, but `pipe()` adds batched streaming so memory stays bounded regardless of total row count.

The gap widens with more rows. At 1,000 rows, the overhead is negligible -- use `em.find()` and enjoy type safety. At 100,000+ rows, the Raw Pipeline pays for itself.

### How to Reproduce

```bash
NODE_OPTIONS="--expose-gc" npx ts-node --project __tests__/bench/tsconfig.json __tests__/bench/raw-pipeline-bench.ts
```

## Choosing the Right Method

| Scenario | Method | Why |
|----------|--------|-----|
| Normal CRUD, < 10K rows | `em.find()` | Full type safety, relation loading, transformers. Overhead is negligible. |
| Reports, aggregation, < 100K rows | `em.query()` or `pipe().raw()` | Skip entity overhead. `pipe()` if you want batching. |
| Large exports (CSV, JSON lines) | `pipe().raw()` + `keyset: true` | Bounded memory. Keyset pagination keeps speed constant. |
| gRPC / protobuf forwarding | `pipe().binary()` | Minimum allocation. Array mode avoids object key strings. |
| ETL to data warehouse | `pipe().raw()` + `.map()` | Transform chain reshapes data without intermediate arrays. |
| Counting filtered rows | `pipe().count()` | Uses the same WHERE as the pipeline. |

## Real-World Patterns

### ETL Export to CSV

```typescript
import { createWriteStream } from "fs";

const out = createWriteStream("users.csv");
out.write("id,name,email,age\n");

for await (const batch of em.pipe(User, {
  orderBy: { id: "ASC" },
  keyset: true,
  batchSize: 10000,
}).raw()) {
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
  orderBy: { id: "ASC" },
  keyset: true,
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

for await (const batch of em.pipe(SensorReading, {
  where: { timestamp: { gte: new Date("2026-01-01") } },
  batchSize: 50000,
}).raw()) {
  for (const row of batch) {
    total += Number(row.value);
    count++;
  }
}

console.log(`Average: ${total / count}`);
```

### Filtered Count Before Processing

```typescript
const pipeline = em.pipe(Invoice, {
  where: { status: "unpaid", dueDate: { lt: new Date() } },
  orderBy: { dueDate: "ASC" },
  keyset: true,
  batchSize: 5000,
});

const overdue = await pipeline.count();
console.log(`Processing ${overdue} overdue invoices...`);

let processed = 0;
for await (const batch of pipeline.raw()) {
  await sendReminders(batch);
  processed += batch.length;
  console.log(`${processed}/${overdue}`);
}
```

### Node.js Readable Stream Integration

The async generator returned by `raw()` is compatible with `Readable.from()`:

```typescript
import { Readable } from "stream";
import { pipeline as streamPipeline } from "stream/promises";
import { createGzip } from "zlib";
import { createWriteStream } from "fs";

const generator = em.pipe(User, {
  orderBy: { id: "ASC" },
  keyset: true,
  batchSize: 5000,
}).map(row => JSON.stringify(row) + "\n").raw();

// Flatten batches into individual lines
async function* flatten(source: AsyncGenerator<string[]>) {
  for await (const batch of source) {
    for (const line of batch) {
      yield line;
    }
  }
}

await streamPipeline(
  Readable.from(flatten(generator)),
  createGzip(),
  createWriteStream("users.jsonl.gz"),
);
```

## API Reference

### `rawPipelinePlugin()`

Factory function that creates the plugin. Install it with `em.extend()`.

```typescript
import { rawPipelinePlugin } from "@stingerloom/orm";

em.extend(rawPipelinePlugin());
```

### `em.pipe(entity, options?)`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `entity` | `ClazzType<T>` | *(required)* | The entity class (used for table name and column resolution) |
| `options.where` | `WhereClause<T>` | — | Filter conditions (same syntax as `em.find()`) |
| `options.orderBy` | `OrderByOption<T>` | — | Sort order (respects NamingStrategy) |
| `options.select` | `string[]` | `*` | Specific columns to select (respects NamingStrategy) |
| `options.batchSize` | `number` | `1000` | Rows per batch (minimum: 1) |
| `options.keyset` | `boolean` | `false` | Use keyset pagination instead of LIMIT/OFFSET. Requires `orderBy`. |

Returns a `RawPipeline<T>`.

### `RawPipeline<T>`

| Method | Returns | Description |
|--------|---------|-------------|
| `raw()` | `AsyncGenerator<Record<string, unknown>[]>` | Yields batches of plain objects |
| `binary(opts?)` | `AsyncGenerator<any[]>` | Yields batches using driver-level options |
| `map(fn)` | `MappedPipeline<U>` | Chain a row transformation |
| `filter(fn)` | `MappedPipeline<Record<string, unknown>>` | Filter rows by JS predicate |
| `collect()` | `Promise<Record<string, unknown>[]>` | Gather all batches into one array |
| `count()` | `Promise<number>` | Count rows matching the pipeline's WHERE clause |

### `MappedPipeline<U>`

| Method | Returns | Description |
|--------|---------|-------------|
| `raw()` | `AsyncGenerator<U[]>` | Yields transformed batches |
| `map(fn)` | `MappedPipeline<V>` | Chain another transformation |
| `filter(fn)` | `FilteredMappedPipeline<U>` | Filter transformed rows |
| `collect()` | `Promise<U[]>` | Gather all batches into one array |

### `DriverQueryOptions`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `binary` | `boolean` | `true` | Request binary-format results from the driver |
| `arrayMode` | `boolean` | `false` | Return rows as arrays instead of objects |

## Internals

### How the Pipeline Generates SQL

The pipeline does not reinvent SQL generation. It reuses two core ORM modules:

1. **`WhereResolver`** — The same module that `em.find()`, `em.update()`, and `em.softDelete()` use. This means every WHERE operator (including `contains`, `ilike`, `search`, `OR`, `AND`, `NOT`, `between`) works identically.

2. **Entity metadata** — Column names, property-to-column mappings (NamingStrategy), and table names are all read from `Reflect.getMetadata()` once per entity class and cached in a `WeakMap`.

### Why Not Just Use SelectQueryBuilder?

SelectQueryBuilder is designed for type-safe queries that return entity instances. It interleaves SQL generation with result transformation and relation loading. The Raw Pipeline needs SQL generation *without* transformation, which is a fundamentally different execution path.

By building SQL from entity metadata directly, the pipeline avoids the overhead of constructing a full QueryBuilder chain and can optimize specifically for the streaming use case (batch pagination, keyset cursors).

## Next Steps

- [Plugins](./plugins.md) — How the plugin system works
- [Raw SQL & CTE](./raw-sql.md) — When you need full SQL control
- [Pagination & Streaming](./pagination.md) — Entity-level streaming with `em.stream()`
- [API Reference](./api-reference.md) — Full method signatures
