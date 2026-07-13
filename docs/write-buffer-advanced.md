# Write Buffer — Advanced

This page covers advanced WriteBuffer features. Make sure you've read [Write Buffer — Basics](./write-buffer.md) first — you should understand Identity Map, dirty checking, entity states, and `flush()` before continuing.

---

## Lazy Loading

### The N+1 Problem and Why Lazy Loading Exists

Consider a blog with posts and authors. If you load 10 posts, you probably need each post's author too. There are two approaches:

**Eager loading** — load everything upfront:
```typescript
const posts = await buf.find(Post, { relations: ["author"] });
```
```sql
SELECT * FROM "post"
LEFT JOIN "user" ON "user"."id" = "post"."authorId"
-- 1 query, all data at once
```

**Lazy loading** — load on demand:
```typescript
const posts = await buf.find(Post);
// authors are NOT loaded yet — just the post columns

for (const post of posts) {
  const author = await post.author;  // DB query fires HERE
}
```
```sql
SELECT * FROM "post"
-- then, for each post:
SELECT * FROM "user" WHERE "id" = $1   -- post 1's author
SELECT * FROM "user" WHERE "id" = $2   -- post 2's author
-- ... 10 separate queries (the "N+1" problem)
```

Lazy loading sounds wasteful — 11 queries instead of 1. So why does it exist?

Because sometimes you **don't** access the relation. If you only need the post title for a list view, eager-loading 10 full author objects (with their avatars, bios, settings...) wastes bandwidth and memory. Lazy loading means: **load it only if you actually touch it.**

The WriteBuffer automatically initializes relation properties as lazy proxies. When you access an unloaded relation, it triggers a database query and registers the loaded entities in the buffer's Identity Map.

### How lazy proxies behave

```typescript
const buf = em.buffer();
const post = await buf.findOne(Post, { where: { id: 1 } });

// post.author is a lazy proxy — NOT the actual author object yet
const author = await post.author;
// → SELECT * FROM "user" WHERE "id" = $1  (the FK value)
// author is now tracked in the buffer's Identity Map

// After the first await, the proxy replaces itself with the actual value.
// Subsequent access is synchronous — no query, no Promise:
console.log(post.author.name);  // "Alice" — works directly
```

This works for all four relation types:

| Relation | What the lazy proxy returns |
|----------|---------------------------|
| `@ManyToOne` | Promise → single parent entity |
| `@OneToMany` | Promise → array of child entities |
| `@OneToOne` | Promise → single related entity |
| `@ManyToMany` | Promise → array of related entities (queries pivot table first) |

### The Promise trap — first access only

Due to JavaScript language constraints, a property getter is synchronous. A lazy proxy can't magically return an entity synchronously from a database query. So the first access returns a **Promise**:

```typescript
// ✗ WRONG — post.author is a Promise on first access
console.log(post.author.name);  // undefined!

// ✓ CORRECT — await the first access
const author = await post.author;
console.log(author.name);  // "Alice"
```

After the first `await`, the proxy replaces itself with the resolved value. All subsequent accesses are synchronous.

### Three patterns to avoid the Promise trap

**1. Eager load via `relations`** — no proxy, no Promise at all:
```typescript
const post = await buf.findOne(Post, {
  where: { id: 1 },
  relations: ["author"],
});
```
```sql
SELECT * FROM "post"
LEFT JOIN "user" ON "user"."id" = "post"."authorId"
WHERE "post"."id" = $1
```
```typescript
console.log(post.author.name);  // "Alice" — works immediately, no await
```

**2. Always `await` the first access:**
```typescript
const author = await post.author;
// From here, post.author is safe to use synchronously
```

**3. Override the proxy by assigning directly:**
```typescript
post.comments = [myComment];  // proxy is replaced with your array
// No DB query, no Promise
```

---

## Pessimistic Locking

### When dirty checking isn't enough

Dirty checking detects changes between your load and your flush. But what about changes made by **other transactions** between your load and your flush?

```
Transaction A: read balance = 100
Transaction B: read balance = 100
Transaction A: balance -= 50, flush → UPDATE SET balance = 50
Transaction B: balance -= 30, flush → UPDATE SET balance = 70
                                       ↑ WRONG — should be 20!
```

Transaction B didn't know about A's change. The final balance is 70 instead of 20. This is the **lost update** problem.

Pessimistic locking prevents this by locking the row at read time. Other transactions must wait until the lock is released:

```typescript
import { LockMode } from "@stingerloom/orm";

const buf = em.buffer();

const user = await buf.findOne(User, {
  where: { id: 1 },
  lock: LockMode.PESSIMISTIC_WRITE,
});
```

```sql
SELECT * FROM "user" WHERE "id" = $1 FOR UPDATE
-- The row is now LOCKED — other transactions wait here
```

```typescript
user.balance -= 100;
await buf.flush();
```

```sql
UPDATE "user" SET "balance" = $1 WHERE "id" = $2
COMMIT
-- Lock released — other transactions can proceed
```

| Mode | SQL appended | Behavior |
|------|-------------|----------|
| `PESSIMISTIC_WRITE` | `FOR UPDATE` | **Exclusive lock** — no other transaction can read or write this row |
| `PESSIMISTIC_READ` | `FOR SHARE` (PostgreSQL) / `LOCK IN SHARE MODE` (MySQL) | **Shared lock** — other transactions can read but not write |

The `lock` option also works with `em.findOne()` and `em.find()` directly (without the buffer).

---

## Bulk DML

### updateMany / deleteMany — When you don't need per-entity tracking

Sometimes you need to update or delete many rows at once based on a condition, without loading each entity individually. Loading 10,000 users just to set `active = false` would be absurdly slow:

```typescript
const buf = em.buffer();

buf.updateMany(User, {
  where: { lastLogin: { lt: "2025-01-01" } },
  set: { active: false },
});

buf.deleteMany(Session, { expired: true });

await buf.flush();
```

```sql
BEGIN;

-- Bulk UPDATE (after all tracked entity operations)
UPDATE "user" SET "active" = $1
WHERE "lastLogin" < $2
-- parameters: [false, '2025-01-01']

-- Bulk DELETE
DELETE FROM "session" WHERE "expired" = $1
-- parameters: [true]

COMMIT;
```

These execute as raw SQL statements during flush, **after** all tracked entity operations. If any tracked entities match the criteria, the buffer syncs them in memory:
- Bulk updates: matching tracked entities get the SET values applied in memory
- Bulk deletes: matching tracked entities are evicted from the Identity Map

### Batch INSERT — Multiple rows in one statement

By default, persisting 3 users generates 3 separate INSERT statements. With `batchInsert: true`, they're combined into one multi-row INSERT:

```typescript
const buf = em.buffer({ batchInsert: true });

buf.persist(user1);
buf.persist(user2);
buf.persist(user3);

await buf.flush();
```

**Without `batchInsert`** (3 round-trips):
```sql
INSERT INTO "user" ("name", "email") VALUES ($1, $2) RETURNING "id";
INSERT INTO "user" ("name", "email") VALUES ($3, $4) RETURNING "id";
INSERT INTO "user" ("name", "email") VALUES ($5, $6) RETURNING "id";
```

**With `batchInsert: true`** (1 round-trip):
```sql
-- PostgreSQL (RETURNING maps generated PKs back to each instance)
INSERT INTO "user" ("name", "email")
VALUES ($1, $2), ($3, $4), ($5, $6)
RETURNING "id"

-- MySQL (LAST_INSERT_ID() returns first ID, then increment for each row)
INSERT INTO `user` (`name`, `email`)
VALUES (?, ?), (?, ?), (?, ?)
```

After the multi-row INSERT, the buffer writes the generated PKs back to each original instance in order.

### Batch UPDATE — Multiple rows in one statement

With `batchUpdate: true`, multiple dirty entities of the same type are updated in a single statement using `CASE WHEN`:

```typescript
const buf = em.buffer({ batchUpdate: true });

const users = await buf.find(User, {});
users[0].name = "Alice";
users[1].name = "Bob";
users[2].name = "Charlie";

await buf.flush();
```

**Without `batchUpdate`** (3 round-trips):
```sql
UPDATE "user" SET "name" = $1 WHERE "id" = $2;
UPDATE "user" SET "name" = $3 WHERE "id" = $4;
UPDATE "user" SET "name" = $5 WHERE "id" = $6;
```

**With `batchUpdate: true`** (1 round-trip):
```sql
UPDATE "user" SET
  "name" = CASE
    WHEN "id" = $1 THEN $2
    WHEN "id" = $3 THEN $4
    WHEN "id" = $5 THEN $6
    ELSE "name"
  END
WHERE "id" IN ($7, $8, $9)
```

The `CASE WHEN` expression maps each PK to its new value. The `ELSE "name"` clause ensures unmatched rows keep their original value (a safety net — the `WHERE IN` clause already limits the update).

---

## Flush Events

Register callbacks that fire during flush, per operation type. This is useful for audit logging, cache invalidation, or sending notifications after data changes:

```typescript
const buf = em.buffer();

buf.onFlushEvent("preUpdate", (event) => {
  console.log(`About to update ${event.entity.name}`, event.data);
  // event.data contains only the CHANGED columns
});

buf.onFlushEvent("postInsert", (event) => {
  console.log(`Inserted ${event.entity.name}`, event.instance);
  // event.instance is the entity with its generated PK
});
```

| Event | When it fires | Payload |
|-------|--------------|---------|
| `preInsert` | Before each INSERT | `{ entity, instance, data }` |
| `postInsert` | After each INSERT | `{ entity, instance, data }` |
| `preUpdate` | Before each UPDATE | `{ entity, instance, data }` — `data` = changed columns only |
| `postUpdate` | After each UPDATE | `{ entity, instance, data }` |
| `preDelete` | Before each DELETE | `{ entity, criteria }` — `criteria` = WHERE conditions |
| `postDelete` | After each DELETE | `{ entity, criteria }` |

Events fire on the batch paths too: with `batchInsert` / `batchUpdate` enabled, each entity in a multi-row INSERT or CASE WHEN UPDATE still gets its own `preInsert`/`postInsert` or `preUpdate`/`postUpdate` pair. `preInsert`/`preUpdate` fire before the batch statement is built, so listener mutations are persisted — the same contract as the per-row path.

### Example: Audit logging

```typescript
buf.onFlushEvent("postUpdate", (event) => {
  auditLog.record({
    table: event.entity.name,
    action: "UPDATE",
    changes: event.data,     // { name: "Bob" } — only what changed
    timestamp: new Date(),
  });
});
```

---

## Read-only Entities

Mark an entity as read-only to skip dirty checking on flush. Even if you accidentally modify its properties, the changes are never persisted:

```typescript
const buf = em.buffer();
const config = await buf.findOne(AppConfig, { where: { key: "site-name" } });
buf.markReadOnly(config);

config.value = "oops";   // mutation happens in memory...
await buf.flush();        // ...but NO UPDATE is generated

buf.isReadOnly(config);  // true
```

Use this for reference data (lookup tables, configurations) that should never be modified through the buffer. It also provides a small performance benefit — the buffer skips the snapshot comparison for read-only entities.

---

## Change Tracking Policy

### The cost of dirty checking

On every `flush()`, the buffer compares every tracked entity's current state against its snapshot. With 10 tracked entities, this is instant. With 10,000, it starts to matter — that's 10,000 deep equality comparisons.

### DEFERRED_IMPLICIT (default) — Check everything

Every tracked entity is checked for changes on flush. This is correct for all cases and the default:

```typescript
const buf = em.buffer();
// changeTracking defaults to DEFERRED_IMPLICIT
const user = await buf.findOne(User, { where: { id: 1 } });
user.name = "updated";
await buf.flush();  // automatically detects the change
```

### DEFERRED_EXPLICIT — Only check what you tell it to

With explicit tracking, the buffer only checks entities you've explicitly marked as dirty:

```typescript
import { ChangeTrackingPolicy, bufferPlugin } from "@stingerloom/orm";

em.extend(bufferPlugin({
  changeTracking: ChangeTrackingPolicy.DEFERRED_EXPLICIT,
}));

const buf = em.buffer();
const user = await buf.findOne(User, { where: { id: 1 } });
user.name = "updated";

await buf.flush();  // NO UPDATE — user was not marked dirty

buf.markDirty(user);
await buf.flush();  // NOW the UPDATE executes
```

```sql
-- Only on the second flush:
UPDATE "user" SET "name" = $1 WHERE "id" = $2
-- parameters: ['updated', 1]
```

### When to use each

| Policy | Dirty check cost per flush | Best for |
|--------|---------------------------|----------|
| `DEFERRED_IMPLICIT` | O(all tracked entities) | Most applications (< 1,000 tracked entities) |
| `DEFERRED_EXPLICIT` | O(marked entities only) | Read-heavy workloads with many tracked entities but few changes |

---

## Flush Modes

### When does the buffer auto-flush?

By default (`MANUAL`), the buffer never auto-flushes — you call `flush()` when you're ready. But this means if you `persist()` a new user and then `find()` all users, the new user won't appear in the results (it's still only in memory).

Flush modes control whether the buffer automatically flushes pending work before queries:

```typescript
import { FlushMode, bufferPlugin } from "@stingerloom/orm";

em.extend(bufferPlugin({ flushMode: FlushMode.AUTO }));
```

| Mode | Behavior | When to use |
|------|----------|-------------|
| `MANUAL` | Never auto-flush. You call `flush()` explicitly. | Full control, best performance. You decide when to hit the DB. |
| `AUTO` | Auto-flush before `find()`/`findOne()` if there is pending work. | Queries always reflect pending changes. Slight overhead per query. |
| `COMMIT` | Deprecated alias of `MANUAL` — behaves identically. | Do not use in new code. The buffer is not bound to a transaction lifecycle, so JPA-style "flush at commit" cannot be honored. |
| `ALWAYS` | Auto-flush before every query, even if no pending work is detected. | Debugging only — ensures DB and buffer are always in sync. |

### Example: AUTO mode

```typescript
const buf = em.buffer();  // flushMode: AUTO

buf.save(User, { name: "Alice" });
// Alice is queued but NOT in the database yet

const users = await buf.find(User, {});
// AUTO mode detects pending work → flush() → INSERT Alice → then SELECT
// Alice IS in the results
```

Without AUTO mode, you'd need to call `buf.flush()` before the `find()` to see Alice.

---

## PersistentCollection

When the buffer tracks an entity with a `@OneToMany` or `@ManyToMany` relation, it takes a snapshot of the collection (which items are in the array). On flush, it compares the current array to the snapshot and generates the appropriate INSERT/DELETE operations.

But there's a subtlety: the buffer only checks at flush time. If you push an item into the array, the buffer doesn't know about it until it diffs the collection. With `DEFERRED_EXPLICIT` change tracking, this could be missed entirely.

`wrapCollection()` solves this by wrapping the array in a Proxy that detects mutations in real-time:

```typescript
const buf = em.buffer();
const post = await buf.findOne(Post, {
  where: { id: 1 },
  relations: ["comments"],
});

buf.wrapCollection(post, "comments");

// Now mutations are detected immediately:
post.comments.push(new Comment({ body: "auto-detected!" }));
// The proxy fires onChange → marks the parent as dirty
```

The proxy intercepts all mutating array methods:
- `push`, `pop`, `shift`, `unshift`, `splice`
- `sort`, `reverse`, `fill`, `copyWithin`
- Index assignment: `arr[0] = newValue`
- Length changes: `arr.length = 0`

It's fully compatible with `Array.isArray()`, spread (`[...arr]`), and destructuring.

---

## Nested Unit of Work

### The problem: partial rollback

Sometimes you want to attempt an operation that might fail, without aborting the entire transaction:

```typescript
// Scenario: importing 100 products from a CSV
// Some products have invalid data — we want to skip them, not abort everything

const buf = em.buffer();

for (const row of csvRows) {
  // If this fails, we don't want to lose the 50 products we already processed
  buf.persist(toProduct(row));
}

await buf.flush();  // If ONE product fails, ALL 100 are rolled back!
```

### The solution: nested buffers with SAVEPOINT

A nested buffer wraps its operations in a `SAVEPOINT`, which is a "checkpoint" within a transaction. If the nested buffer fails, only its operations are rolled back — the parent buffer's work is preserved.

A savepoint only exists *inside* a transaction, so the whole workflow must run within `em.transaction()`. Every `flush()` — parent or nested — joins that ambient transaction instead of opening its own:

```typescript
await em.transaction(async () => {
  const buf = em.buffer();

  for (const row of csvRows) {
    const nested = buf.beginNested();
    try {
      nested.save(Product, toProduct(row));
      await nested.flush();
      // → SAVEPOINT sp_nested_xxx → INSERT → (success: keep)
    } catch {
      // → ROLLBACK TO SAVEPOINT sp_nested_xxx
      // Only THIS product's INSERT is undone
      console.log(`Skipped invalid row: ${row.name}`);
    }
  }

  // Parent buffer's operations are unaffected
  await buf.flush();
});
```

Here's the SQL timeline:

```sql
BEGIN;                                   -- em.transaction()

SAVEPOINT sp_nested_1709234567_a3f2;     -- nested buffer 1
INSERT INTO "product" ...;               -- success
-- savepoint kept

SAVEPOINT sp_nested_1709234568_b4c1;     -- nested buffer 2
INSERT INTO "product" ...;               -- ERROR! constraint violation
ROLLBACK TO SAVEPOINT sp_nested_1709234568_b4c1;  -- only this INSERT undone

SAVEPOINT sp_nested_1709234569_c5d0;     -- nested buffer 3
INSERT INTO "product" ...;               -- success
-- savepoint kept

COMMIT;                                  -- products 1 and 3 saved, product 2 skipped
```

If the enclosing `em.transaction()` itself fails after a nested flush succeeded, its rollback reclaims the nested work too — the savepoint is genuinely part of the outer transaction.

**Do not skip the `em.transaction()` wrapper.** Without it, every `flush()` opens and commits its own transaction. A nested buffer's SAVEPOINT then spans nothing beyond its own flush: the work commits immediately and independently, and rolling back the "parent" later cannot reclaim it. The buffer logs a warning when a nested `flush()` runs outside an enclosing transaction.

### When to use nested buffers

- **Partial rollback** — try an operation that might fail without aborting the whole transaction
- **Conditional inserts** — insert if a constraint isn't violated, skip otherwise
- **Multi-step workflows** — each step can independently succeed or fail

---

## Accumulate and Retry Pattern

With `retainAfterFlush: true` (the default), the buffer re-snapshots tracked entities after a successful flush. This enables an accumulate-flush-accumulate-flush cycle:

```typescript
const buf = em.buffer({ retainAfterFlush: true });
const user = await buf.findOne(User, { where: { id: 1 } });

// First batch of changes
user.name = "Alice";
await buf.flush();
```

```sql
UPDATE "user" SET "name" = $1 WHERE "id" = $2
-- parameters: ['Alice', 1]
-- snapshot refreshed: { id: 1, name: "Alice", email: "...", age: 25 }
```

```typescript
// Second batch — only NEW changes are flushed
user.age = 30;
await buf.flush();
```

```sql
UPDATE "user" SET "age" = $1 WHERE "id" = $2
-- parameters: [30, 1]
-- name is NOT included — it's already "Alice" in the refreshed snapshot
```

If a flush fails, the queues are preserved so you can fix the issue and retry:

```typescript
try {
  await buf.flush();
} catch {
  // Fix the issue...
  await buf.flush();  // retries with the same queued operations
}
```

---

## Configuration Reference

All options can be passed to `bufferPlugin()` (global defaults) or `em.buffer()` (per-instance overrides):

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `retainAfterFlush` | `boolean` | `true` | Re-snapshot tracked entities after flush, enabling accumulate-flush cycles |
| `cascade` | `boolean` | `true` | Propagate persist/remove/merge/detach through relation metadata |
| `orphanRemoval` | `boolean` | `false` | Auto-delete O2M children removed from collection arrays |
| `manyToManySync` | `boolean` | `true` | Auto-sync M2M pivot table rows on collection changes |
| `flushMode` | `FlushMode` | `MANUAL` | When to auto-flush before queries |
| `autoFlush` | `boolean` | `false` | Shorthand for `FlushMode.AUTO` |
| `changeTracking` | `ChangeTrackingPolicy` | `DEFERRED_IMPLICIT` | When to dirty-check entities |
| `batchInsert` | `boolean` | `false` | Combine multiple INSERTs of the same entity type into one multi-row statement |
| `batchUpdate` | `boolean` | `false` | Combine multiple UPDATEs of the same entity type into one CASE WHEN statement |
| `onFlush` | `(result) => void` | — | Callback after successful flush |
| `logging` | `boolean` | `false` | Verbose lifecycle logging for debugging |

---

## Next Steps

- [Write Buffer — Basics](./write-buffer.md) — Core concepts, Identity Map, dirty checking, flush
- [Plugin System](./plugins.md) — Writing custom plugins
- [Events & Subscribers](./events.md) — Entity lifecycle events
- [API Reference](./api-reference.md) — Full method signatures
