# Write Buffer — Advanced

This page covers advanced WriteBuffer features: lazy loading, pessimistic locking, batch operations, flush events, change tracking policies, flush modes, persistent collections, and nested units of work. Make sure you've read [Write Buffer — Basics](./write-buffer.md) first.

## Lazy Loading

Relation properties on buffer-managed entities are automatically initialized as lazy proxies. When you access an unloaded relation, it triggers a database query and registers the loaded entities in the buffer's identity map.

```typescript
const buf = em.buffer();
const post = await buf.findOne(Post, { where: { id: 1 } });

// post.author is not loaded yet — accessing it returns a Promise
const author = await post.author;
// author is now tracked in the buffer

// Second access returns the cached value (not a Promise)
console.log(post.author.name); // "Alice"
```

This works for all four relation types:

| Relation | Lazy behavior |
|----------|---------------|
| `@ManyToOne` | Returns Promise resolving to the parent entity |
| `@OneToMany` | Returns Promise resolving to child array |
| `@OneToOne` | Returns Promise resolving to the related entity |
| `@ManyToMany` | Queries pivot table, then batches `IN (...)` query for related entities |

You can override a lazy property by assigning directly — the proxy is replaced with your value:

```typescript
post.comments = [myComment]; // no DB query, proxy is gone
```

### Important: Promise behavior on first access

Due to JavaScript language constraints, property getters are synchronous. A lazy proxy's first access returns a **Promise**, not the entity itself. You must `await` it:

```typescript
// WRONG — post.author is a Promise on first access
console.log(post.author.name); // undefined!

// CORRECT — await the first access
const author = await post.author;
console.log(author.name); // "Alice"
```

After the first `await`, the proxy replaces itself with the resolved value. Subsequent accesses are synchronous:

```typescript
const author = await post.author;  // DB query, resolves Promise
console.log(post.author.name);     // "Alice" — no Promise, no query
```

**Three patterns to avoid the Promise pitfall:**

1. **Eager load via `relations`** — no proxy, no Promise:
   ```typescript
   const post = await buf.findOne(Post, {
     where: { id: 1 },
     relations: ["author"],
   });
   console.log(post.author.name); // works immediately
   ```

2. **Always `await` the first access:**
   ```typescript
   const author = await post.author;
   ```

3. **Access after prior resolution** — if any code path already awaited the relation, subsequent synchronous access is safe.

## Pessimistic Locking

To prevent concurrent modifications, you can request a database lock when loading entities. The lock clause (`FOR UPDATE` / `FOR SHARE`) is included in the SELECT query itself, so the row is locked at read time — not deferred to flush.

```typescript
import { LockMode } from "@stingerloom/orm";

const buf = em.buffer();

// SELECT ... FOR UPDATE — lock is acquired NOW
const user = await buf.findOne(User, {
  where: { id: 1 },
  lock: LockMode.PESSIMISTIC_WRITE,
});

user.balance -= 100;
await buf.flush(); // UPDATE within transaction, then COMMIT releases lock
```

The `lock` option also works with `em.findOne()` and `em.find()` directly (without the buffer).

| Mode | SQL | Use case |
|------|-----|----------|
| `PESSIMISTIC_WRITE` | `FOR UPDATE` | Exclusive lock — prevents other transactions from reading or writing |
| `PESSIMISTIC_READ` | `FOR SHARE` (PostgreSQL) / `LOCK IN SHARE MODE` (MySQL) | Shared lock — other transactions can read but not write |

## Bulk DML

For batch operations that don't need per-entity tracking:

```typescript
const buf = em.buffer();

// UPDATE users SET active = false WHERE lastLogin < '2025-01-01'
buf.updateMany(User, {
  where: { lastLogin: Conditions.lt("2025-01-01") },
  set: { active: false },
});

// DELETE FROM sessions WHERE expiredAt < NOW()
buf.deleteMany(Session, { expired: true });

await buf.flush();
```

These execute as raw SQL statements during flush, after all tracked entity operations. Tracked entities matching the criteria are synced in-memory (bulk updates) or evicted from the identity map (bulk deletes).

### Batch INSERT

When `batchInsert: true` is enabled, multiple entities of the same type are inserted in a single multi-row INSERT statement:

```typescript
const buf = em.buffer({ batchInsert: true });

buf.persist(user1);
buf.persist(user2);
buf.persist(user3);

await buf.flush();
// INSERT INTO users (name, email) VALUES ('Alice', ...), ('Bob', ...), ('Charlie', ...)
// instead of 3 separate INSERT statements
```

PostgreSQL uses `RETURNING` to map generated PKs back. MySQL infers PKs from `LAST_INSERT_ID()`.

### Batch UPDATE

When `batchUpdate: true` is enabled, multiple dirty entities of the same type are updated in a single statement using `CASE WHEN` expressions:

```typescript
const buf = em.buffer({ batchUpdate: true });

// Load and modify multiple users
const users = await buf.find(User, {});
users[0].name = "Alice";
users[1].name = "Bob";
users[2].name = "Charlie";

await buf.flush();
// UPDATE users SET name = CASE
//   WHEN id = 1 THEN 'Alice'
//   WHEN id = 2 THEN 'Bob'
//   WHEN id = 3 THEN 'Charlie'
// END WHERE id IN (1, 2, 3)
```

## Flush Events

Register per-entity lifecycle callbacks that fire during flush:

```typescript
const buf = em.buffer();

buf.onFlushEvent("preUpdate", (event) => {
  console.log(`About to update ${event.entity.name}`, event.data);
});

buf.onFlushEvent("postInsert", (event) => {
  console.log(`Inserted ${event.entity.name}`, event.instance);
});
```

| Event | Fires | Payload |
|-------|-------|---------|
| `preInsert` | Before each INSERT | `{ entity, instance, data }` |
| `postInsert` | After each INSERT | `{ entity, instance, data }` |
| `preUpdate` | Before each UPDATE | `{ entity, instance, data }` |
| `postUpdate` | After each UPDATE | `{ entity, instance, data }` |
| `preDelete` | Before each DELETE | `{ entity, criteria }` |
| `postDelete` | After each DELETE | `{ entity, criteria }` |

Use cases: audit logging, cache invalidation, sending notifications after data changes.

## Read-only Entities

Mark an entity as read-only to skip dirty checking on flush. Useful for reference data that should never be modified:

```typescript
const buf = em.buffer();
const config = await buf.findOne(AppConfig, { where: { key: "site-name" } });
buf.markReadOnly(config);

config.value = "oops"; // mutation won't be flushed
await buf.flush(); // no UPDATE for config
```

```typescript
buf.isReadOnly(config); // true
```

## Change Tracking Policy

By default, the buffer compares every tracked entity's current state against its snapshot on flush (`DEFERRED_IMPLICIT`). For large numbers of tracked entities, you can switch to `DEFERRED_EXPLICIT` — only entities explicitly marked dirty are checked.

```typescript
import { ChangeTrackingPolicy, bufferPlugin } from "@stingerloom/orm";

em.extend(bufferPlugin({
  changeTracking: ChangeTrackingPolicy.DEFERRED_EXPLICIT,
}));

const buf = em.buffer();
const user = await buf.findOne(User, { where: { id: 1 } });
user.name = "updated";

await buf.flush(); // no-op — user was not marked dirty

buf.markDirty(user);
await buf.flush(); // NOW the UPDATE executes
```

### When to use each policy

| Policy | Dirty check cost | Best for |
|--------|-----------------|----------|
| `DEFERRED_IMPLICIT` | O(tracked entities) per flush | Most applications (< 1000 tracked entities) |
| `DEFERRED_EXPLICIT` | O(marked entities) per flush | High-volume read-heavy workloads where few entities change |

## Flush Modes

Controls when the buffer auto-flushes before queries:

| Mode | Behavior |
|------|----------|
| `FlushMode.MANUAL` | Never auto-flush (default). You call `flush()` explicitly. |
| `FlushMode.AUTO` | Auto-flush before `findOne()` / `find()` if there is pending work. |
| `FlushMode.COMMIT` | Same as MANUAL — only flush on explicit call. |
| `FlushMode.ALWAYS` | Always flush before any query, even if no pending work is detected. |

```typescript
import { FlushMode, bufferPlugin } from "@stingerloom/orm";

em.extend(bufferPlugin({ flushMode: FlushMode.AUTO }));

const buf = em.buffer();
buf.save(User, { name: "Alice" });

// AUTO mode: flush happens before this query
const users = await buf.find(User, {});
// Alice is already in the database
```

### When to use each mode

| Mode | Use case |
|------|----------|
| `MANUAL` | Full control, best performance. You decide when to flush. |
| `AUTO` | Queries always see the latest pending changes. Slight overhead per query. |
| `ALWAYS` | Debugging — ensures DB state is always consistent with buffer. |

## PersistentCollection

Wrap a collection array with a mutation-detecting proxy. When items are pushed, spliced, or removed, the parent entity is automatically marked as dirty.

```typescript
const buf = em.buffer();
const post = await buf.findOne(Post, {
  where: { id: 1 },
  relations: ["comments"],
});

buf.wrapCollection(post, "comments");

post.comments.push(new Comment({ body: "auto-detected!" }));
// parent is now marked dirty — the collection change will be flushed
```

The proxy intercepts all mutating array methods: `push`, `pop`, `shift`, `unshift`, `splice`, `sort`, `reverse`, `fill`, `copyWithin`, and index assignment. It is fully compatible with `Array.isArray()` and spread/destructuring.

## Nested Unit of Work

For partial rollback within a larger operation, create a nested buffer that uses `SAVEPOINT`:

```typescript
const buf = em.buffer();

const nested = buf.beginNested();
try {
  nested.save(User, { name: "Risky" });
  await nested.flush(); // SAVEPOINT sp_xxx → INSERT → (no error = keep)
} catch {
  // ROLLBACK TO SAVEPOINT sp_xxx — only the nested work is undone
}

// The parent buffer's state is unaffected
await buf.flush();
```

### When to use nested buffers

- **Partial rollback** — try an operation that might fail without aborting the whole transaction
- **Conditional inserts** — insert if a constraint isn't violated, skip otherwise
- **Multi-step workflows** — each step can independently succeed or fail

Top-level buffers use `START TRANSACTION ... COMMIT/ROLLBACK`. Nested buffers use `SAVEPOINT` / `ROLLBACK TO SAVEPOINT`.

## Accumulate and Retry Pattern

With `retainAfterFlush: true` (the default), the buffer re-snapshots tracked entities after flush. This enables an accumulate-flush-accumulate-flush pattern:

```typescript
const buf = em.buffer({ retainAfterFlush: true });
const user = await buf.findOne(User, { where: { id: 1 } });

// First batch of changes
user.name = "Alice";
await buf.flush(); // UPDATE name → re-snapshot

// Second batch — only new changes are flushed
user.age = 30;
await buf.flush(); // UPDATE age only (name is already "Alice" in snapshot)
```

If a flush fails, the queues are preserved so you can fix the issue and retry without re-queuing.

## Configuration Reference

All options are passed to `bufferPlugin()`:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `retainAfterFlush` | `boolean` | `true` | Re-snapshot tracked entities after flush for subsequent changes |
| `cascade` | `boolean` | `true` | Enable cascade through relation metadata |
| `orphanRemoval` | `boolean` | `false` | Auto-delete children removed from O2M arrays |
| `manyToManySync` | `boolean` | `true` | Auto-sync M2M pivot table on collection changes |
| `flushMode` | `FlushMode` | `MANUAL` | When to auto-flush before queries |
| `autoFlush` | `boolean` | `false` | Shorthand for `FlushMode.AUTO` |
| `changeTracking` | `ChangeTrackingPolicy` | `DEFERRED_IMPLICIT` | When to dirty-check entities |
| `batchInsert` | `boolean` | `false` | Use multi-row INSERT for multiple entities of the same type |
| `batchUpdate` | `boolean` | `false` | Use CASE WHEN batch UPDATE for multiple dirty entities |
| `onFlush` | `(result) => void` | — | Callback after successful flush |
| `logging` | `boolean` | `false` | Verbose lifecycle logging |

## Next Steps

- [Write Buffer — Basics](./write-buffer.md) — Core concepts, Identity Map, dirty checking, flush
- [Plugin System](./plugins.md) — Writing custom plugins
- [Events & Subscribers](./events.md) — Entity lifecycle events
- [API Reference](./api-reference.md) — Full method signatures
