# Write Buffer — Basics

With plain `em.save()`, every call immediately hits the database. This is fine for simple cases, but when you need to collect multiple changes and apply them as a single atomic operation, you want a **Unit of Work**.

The `bufferPlugin()` adds a `buffer()` method to EntityManager. It returns a `WriteBuffer` — an in-memory workspace that tracks entity changes and flushes them to the database in one transaction.

## Setup

```typescript
import { bufferPlugin } from "@stingerloom/orm";

await em.register({
  // ... connection options
  plugins: [bufferPlugin()],
});

const buf = em.buffer();
```

You can also pass options per-buffer:

```typescript
const buf = em.buffer({ cascade: true, batchInsert: true });
```

## Core Concepts

### Identity Map

Every entity loaded through the buffer is tracked by its primary key. Loading the same row twice returns the **same object reference** — no duplicates, no conflicting updates.

```typescript
const buf = em.buffer();

const a = await buf.findOne(User, { where: { id: 1 } });
const b = await buf.findOne(User, { where: { id: 1 } });

console.log(a === b); // true — same reference
```

This also works across `find()` and `findOne()`. If you load user #1 via `findOne()` and later call `find()` which includes user #1 in the results, the existing tracked instance is reused.

Internally, the Identity Map uses a key format like `"User:id=1"`. If you attempt to `track()` a different instance with the same PK, an error is thrown — preventing conflicting snapshots.

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

The diff uses deep equality — `Date` objects are compared by timestamp, nested objects by value, and `null` vs `undefined` are distinguished.

### Entity States

Every entity instance has a lifecycle state:

| State | Meaning | Transition to |
|-------|---------|---------------|
| `NEW` | Queued for INSERT via `persist()`, not yet flushed | `MANAGED` (after flush) |
| `MANAGED` | Tracked — either loaded from DB or successfully flushed | `DETACHED`, `REMOVED` |
| `DETACHED` | Removed from the buffer via `detach()` or `untrack()` | `MANAGED` (via merge/track) |
| `REMOVED` | Marked for DELETE via `remove()` | `DETACHED` (after flush) |

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

If you later call `findOne(User, { where: { id: 5 } })`, it returns the same reference — the Identity Map guarantees this.

### track

Manually register an existing entity instance for dirty checking:

```typescript
const user = await em.findOne(User, { where: { id: 1 } }); // loaded outside buffer
buf.track(user); // now tracked with snapshot
user.name = "updated";
await buf.flush(); // UPDATE
```

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

If the instance is still in the persist queue (not yet flushed), `remove()` cancels the INSERT instead of scheduling a DELETE.

### delete — Criteria-based DELETE

```typescript
buf.delete(User, { id: 1 });
await buf.flush();
```

## Flush

`flush()` executes all pending operations in a single transaction. The execution order is:

1. **UPDATEs** — dirty tracked entities (topological order: parents first)
2. **INSERTs** — persisted instances, then queued saves (topological order: parents first)
3. **Collection diffs** — O2M orphan removal, M2M pivot sync
4. **Cascade DELETEs** — recursively collected children
5. **DELETEs** — queued removes (reverse topological order: children first)
6. **Bulk UPDATEs** — `updateMany()` operations
7. **Bulk DELETEs** — `deleteMany()` operations

If any operation fails, the entire transaction is rolled back. The queues are preserved so you can fix the issue and retry.

```typescript
const result = await buf.flush();
// { updates: 2, inserts: 1, deletes: 0 }
```

### Topological Ordering

The buffer analyzes `@ManyToOne` and `@OneToOne` metadata to build a dependency graph. This ensures:
- **INSERTs** execute parents before children (so FK references exist)
- **DELETEs** execute children before parents (so FK constraints aren't violated)

Cycles are detected and handled gracefully with a fallback to original order.

### preview

Before flushing, you can inspect what operations will run:

```typescript
const preview = buf.preview();
// [
//   { action: "update", entity: "User", where: { id: 1 }, data: { name: "Bob" } },
//   { action: "insert", entity: "Post", data: { title: "Hello" } },
// ]
```

This does not touch the database — useful for debugging or confirmation UIs.

### size

Check how much work is queued:

```typescript
const s = buf.size();
// { tracked: 5, inserts: 1, deletes: 0, persists: 2, bulkUpdates: 0, bulkDeletes: 0 }
```

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

The buffer recursively collects all cascade targets (grandchildren too) before executing deletes in reverse topological order.

### Supported cascade operations by relation type

| Relation | Insert | Update | Delete | Orphan Removal |
|----------|--------|--------|--------|----------------|
| `@OneToMany` | New children | Dirty children | Recursive | If enabled |
| `@OneToOne` | Owning side | Owning side | If joinColumn | — |
| `@ManyToMany` | New children + pivot | — | — | Pivot rows |

### Cascade merge / detach / refresh

These operations also propagate through the relation graph when cascade is enabled.

```typescript
buf.merge(detachedPost);   // merges post + its tracked children
buf.detach(post);          // detaches post + its tracked children
await buf.refresh(post);   // reloads post + its tracked children from DB
```

## State Management

### untrack / detach

```typescript
buf.untrack(user);   // remove from tracking (no cascade)
buf.detach(user);    // remove from tracking (cascades to related entities)
```

### merge

Merge a detached instance back into the buffer. If a tracked instance with the same PK exists, field values are copied to it. Otherwise the instance is tracked fresh.

```typescript
const detachedUser = { id: 1, name: "Updated" };
buf.merge(detachedUser); // copies name to tracked User#1
```

### refresh

Reload an entity from the database and update all fields in-place:

```typescript
await buf.refresh(user); // re-queries DB, updates fields, re-snapshots
```

### clear

Remove all tracked entities, identity map, and queued operations:

```typescript
buf.clear();
```

## Next Steps

- [Write Buffer — Advanced](./write-buffer-advanced.md) — Lazy loading, locking, batch DML, flush modes, nested UoW
- [Plugin System](./plugins.md) — Writing custom plugins
- [Transactions](./transactions.md) — Manual and decorator-based transactions
- [API Reference](./api-reference.md) — Full method signatures
