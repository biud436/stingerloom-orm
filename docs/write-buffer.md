# WriteBuffer (Unit of Work)

With plain `em.save()`, every call immediately hits the database. This is fine for simple cases, but when you need to collect multiple changes and apply them as a single atomic operation, you want a **Unit of Work**.

The `bufferPlugin()` adds a `buffer()` method to EntityManager. It returns a `WriteBuffer` — an in-memory workspace that tracks entity changes and flushes them to the database in one transaction.

```typescript
import { bufferPlugin } from "@stingerloom/orm";

await em.register({
  // ... connection options
  plugins: [bufferPlugin()],
});

const buf = em.buffer();
const user = await buf.findOne(User, { where: { id: 1 } });
user.name = "updated";
await buf.flush(); // single UPDATE in a transaction
```

## Core Concepts

### Identity Map

Every entity loaded through the buffer is tracked by its primary key. Loading the same row twice returns the same object reference — no duplicates, no conflicting updates.

```typescript
const buf = em.buffer();

const a = await buf.findOne(User, { where: { id: 1 } });
const b = await buf.findOne(User, { where: { id: 1 } });

console.log(a === b); // true — same reference
```

This also works across `find()` and `findOne()`. If you load user #1 via `findOne()` and later call `find()` which includes user #1 in the results, the existing tracked instance is reused.

### Dirty Checking

The buffer takes a snapshot when an entity is tracked. On `flush()`, it compares the current state against the snapshot and only updates columns that actually changed.

```typescript
const buf = em.buffer();
const user = await buf.findOne(User, { where: { id: 1 } });
// snapshot taken: { id: 1, name: "Alice", age: 25 }

user.name = "Bob";
// dirty: { name: "Bob" }

await buf.flush();
// UPDATE users SET name = 'Bob' WHERE id = 1
// (age is NOT included — it didn't change)
```

After a successful flush, the snapshot is refreshed. You can make more changes and flush again.

### Entity States

Every entity instance has a lifecycle state:

| State | Meaning |
|-------|---------|
| `NEW` | Queued for INSERT via `persist()`, not yet flushed |
| `MANAGED` | Tracked — either loaded from DB or successfully flushed |
| `DETACHED` | Removed from the buffer via `detach()` or `untrack()` |
| `REMOVED` | Marked for DELETE via `remove()` |

```typescript
const buf = em.buffer();

const user = new User();
user.name = "Alice";
buf.persist(user);
buf.getState(user); // EntityState.NEW

await buf.flush();
buf.getState(user); // EntityState.MANAGED
user.id; // auto-generated PK is written back

buf.remove(user);
buf.getState(user); // EntityState.REMOVED

await buf.flush(); // DELETE executed
```

## Loading Entities

### findOne / find

These work like `em.findOne()` and `em.find()`, but every returned entity is automatically tracked in the buffer.

```typescript
const buf = em.buffer();

const user = await buf.findOne(User, { where: { id: 1 } });
const posts = await buf.find(Post, { where: { authorId: 1 } });

buf.tracked(); // [user, ...posts]
```

### getReference

Creates an identity-mapped reference with only the PK set — no database query. Useful when you need a foreign key reference without loading the full entity.

```typescript
const buf = em.buffer();

// No DB query — just creates { id: 5 } in the identity map
const author = buf.getReference(User, 5);

const post = new Post();
post.title = "Hello";
post.authorId = (author as any).id; // 5
buf.persist(post);
await buf.flush();
```

If you later call `findOne(User, { where: { id: 5 } })`, it returns the same reference.

## Writing Data

### persist — Instance-based INSERT

Pass a new entity instance (no PK) to queue it for INSERT. After flush, the generated PK is written back to the original instance.

```typescript
const buf = em.buffer();

const user = new User();
user.name = "Alice";
user.email = "alice@example.com";
buf.persist(user);

await buf.flush();
console.log(user.id); // auto-generated PK
```

If the instance already has a PK, `persist()` delegates to `track()` for dirty checking instead.

### save — Plain object INSERT

For quick inserts without creating an instance:

```typescript
buf.save(User, { name: "Bob", email: "bob@example.com" });
await buf.flush();
```

### remove — Instance-based DELETE

```typescript
const user = await buf.findOne(User, { where: { id: 1 } });
buf.remove(user);
await buf.flush(); // DELETE FROM users WHERE id = 1
```

### delete — Criteria-based DELETE

```typescript
buf.delete(User, { id: 1 });
await buf.flush();
```

## Flush

`flush()` executes all pending operations in a single transaction. The execution order is:

1. UPDATEs (dirty tracked entities)
2. INSERTs (persisted instances, then queued saves)
3. Collection diffs (O2M orphan removal, M2M pivot sync)
4. Cascade DELETEs (children first)
5. DELETEs (reverse topological order)
6. Bulk UPDATEs (tracked entities are synced in-memory after execution)
7. Bulk DELETEs (matching tracked entities are evicted from identity map)

If any operation fails, the entire transaction is rolled back. The queues are preserved so you can fix the issue and retry.

```typescript
const result = await buf.flush();
// { updates: 2, inserts: 1, deletes: 0 }
```

### preview

Before flushing, you can inspect what operations will run:

```typescript
const preview = buf.preview();
// [
//   { action: "update", entity: "User", where: { id: 1 }, data: { name: "Bob" } },
//   { action: "insert", entity: "Post", data: { title: "Hello" } },
// ]
```

This does not touch the database.

## Cascade

When `cascade: true` (the default), the buffer automatically propagates operations through entity relations.

### Cascade persist

If a parent entity has `@OneToMany` children with `cascade: ["insert"]`, persisting the parent also inserts the children:

```typescript
const buf = em.buffer();

const post = new Post();
post.title = "Hello";
post.comments = [
  Object.assign(new Comment(), { body: "First!" }),
  Object.assign(new Comment(), { body: "Nice post" }),
];

buf.persist(post);
await buf.flush();
// INSERT post, then INSERT both comments with FK set automatically
```

### Cascade delete

If `cascade: ["delete"]` is set, removing a parent also deletes its children:

```typescript
buf.remove(post);
await buf.flush();
// DELETE comments WHERE postId = ?, then DELETE post WHERE id = ?
```

Cascade works through `@OneToMany`, `@OneToOne`, and `@ManyToMany` (owning side).

### Cascade merge / detach / refresh

These operations also propagate through the relation graph when cascade is enabled.

```typescript
buf.merge(detachedPost);   // merges post + its tracked children
buf.detach(post);          // detaches post + its tracked children
await buf.refresh(post);   // reloads post + its tracked children from DB
```

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

This works for all four relation types: `@ManyToOne`, `@OneToMany`, `@OneToOne`, and `@ManyToMany`.

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

These execute as raw SQL statements during flush, after all tracked entity operations.

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

| Event | Fires |
|-------|-------|
| `preInsert` | Before each INSERT |
| `postInsert` | After each INSERT |
| `preUpdate` | Before each UPDATE |
| `postUpdate` | After each UPDATE |
| `preDelete` | Before each DELETE |
| `postDelete` | After each DELETE |

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

By default, the buffer compares every tracked entity's current state against its snapshot on flush (DEFERRED_IMPLICIT). For large numbers of tracked entities, you can switch to DEFERRED_EXPLICIT — only entities explicitly marked dirty are checked.

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

## Next Steps

- [Plugins](./plugins.md) — Writing custom plugins
- [Transactions](./transactions.md) — Manual and decorator-based transactions
- [Relations](./relations.md) — ManyToOne, OneToMany, OneToOne, ManyToMany
- [API Reference](./api-reference.md) — Full method signatures
