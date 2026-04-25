# Write Buffer — Basics

## The Problem with Immediate Saves

With plain `em.save()`, every call immediately hits the database:

```typescript
user.name = "Alice";
await em.save(User, user);     // → UPDATE users SET name='Alice' WHERE id=1
user.email = "alice@new.com";
await em.save(User, user);     // → UPDATE users SET email='alice@new.com' WHERE id=1
```

That's two separate UPDATE queries, two network round-trips, and two transactions — for what could have been a single UPDATE. Now imagine you're processing an order: create a user, create an order, create 5 order items, update inventory for 5 products. That's 12 separate queries.

The **Unit of Work** pattern solves this. Instead of immediately executing each change, you collect all changes in memory, then apply them all at once in a single transaction. Stingerloom's `WriteBuffer` is an opt-in implementation of this pattern.

## Setup

The WriteBuffer is an opt-in plugin. Add it to your EntityManager:

```typescript
import { bufferPlugin } from "@stingerloom/orm";

await em.register({
  // ... connection options
  plugins: [bufferPlugin()],
});

// Create a buffer (your in-memory workspace)
const buf = em.buffer();
```

You can also pass options per-buffer to override the defaults:

```typescript
const buf = em.buffer({ cascade: true, batchInsert: true });
```

For long-lived buffers (e.g., background workers), you can limit the Identity Map size to prevent unbounded memory growth:

```typescript
const buf = em.buffer({ maxIdentityMapSize: 1000 });
// When the map exceeds 1000 entries, the least-recently-used
// clean entities are automatically evicted.
// Dirty, NEW, and REMOVED entities are never evicted.
```

From this point on, all reads and writes go through `buf` instead of `em` directly.

---

## Core Concepts

### Identity Map — "Same row, same object"

Here's a subtle bug that can happen without an Identity Map:

```typescript
// Without Identity Map
const user1 = await em.findOne(User, { where: { id: 1 } });  // { id: 1, name: "Alice" }
const user2 = await em.findOne(User, { where: { id: 1 } });  // { id: 1, name: "Alice" }

user1.name = "Bob";
console.log(user2.name); // Still "Alice" — user2 is a DIFFERENT object!
await em.save(User, user2); // Oops — saves "Alice", overwriting the "Bob" change
```

`user1` and `user2` represent the same database row, but they're different JavaScript objects. Modifying one doesn't affect the other, leading to lost updates.

The Identity Map prevents this. Every entity loaded through the buffer is tracked by its primary key. Loading the same row twice returns **the exact same object reference**:

```typescript
const buf = em.buffer();

const a = await buf.findOne(User, { where: { id: 1 } });
const b = await buf.findOne(User, { where: { id: 1 } });

console.log(a === b); // true — same JavaScript object
```

This also works across `find()` and `findOne()`. If `find()` returns 10 users and one of them (id=1) was already loaded via `findOne()`, the existing tracked instance is reused — not replaced.

Internally, the Identity Map uses a key like `"User:id=1"`. For composite primary keys, it becomes `"Order:userId=1,productId=5"`. If you attempt to `track()` a different object with the same PK, the buffer throws an error to prevent conflicting state:

```
Identity conflict: another instance of "User" with PK (User:id=1) is already tracked
```

#### Memory management

By default, the Identity Map grows without limit — every `findOne()`, `find()`, and `getReference()` call adds entries. For short-lived request-scoped buffers this is fine. For long-lived buffers, set `maxIdentityMapSize` to enable LRU eviction:

```typescript
const buf = em.buffer({ maxIdentityMapSize: 500 });

// After 500+ entries, the least-recently-used clean entities are evicted.
// "Clean" means: snapshot matches current state, not NEW, not REMOVED.
// Dirty entities are NEVER evicted — your pending changes are safe.
```

Evicted entities transition to `EntityState.DETACHED`. You can monitor the current size via `buf.size().identityMap`.

### Dirty Checking — "Only update what changed"

When you load an entity through the buffer, it takes a **snapshot** — a deep clone of all column values at that moment. On `flush()`, it compares the current state against the snapshot and generates an UPDATE that only includes columns that actually changed:

```typescript
const buf = em.buffer();
const user = await buf.findOne(User, { where: { id: 1 } });
// Snapshot taken: { id: 1, name: "Alice", email: "alice@ex.com", age: 25 }

user.name = "Bob";
// Current state:  { id: 1, name: "Bob",   email: "alice@ex.com", age: 25 }
// Diff:           { name: "Bob" }  ← only this column changed

await buf.flush();
```

```sql
UPDATE "user" SET "name" = $1 WHERE "id" = $2
-- parameters: ['Bob', 1]
-- NOTE: email and age are NOT in the SET clause — they didn't change
```

This is more efficient than `em.save()`, which would send all columns in the UPDATE regardless of whether they changed.

After a successful flush, the snapshot is refreshed with the current values. You can make more changes and flush again:

```typescript
user.email = "bob@new.com";
await buf.flush();
```

```sql
UPDATE "user" SET "email" = $1 WHERE "id" = $2
-- parameters: ['bob@new.com', 1]
-- name is NOT included — it was already "Bob" in the refreshed snapshot
```

The diff uses deep equality: `Date` objects are compared by timestamp, nested objects by value, and `null` vs `undefined` are distinguished.

### Entity States — The Lifecycle

Every entity instance tracked by the buffer has a lifecycle state:

| State | Meaning | How it gets here | Where it goes |
|-------|---------|------------------|---------------|
| `NEW` | Queued for INSERT, not yet in DB | `persist()` on an object without PK | → `MANAGED` after flush |
| `MANAGED` | Tracked and synced with DB | Loaded via `find()`/`findOne()`, or flushed | → `DETACHED` or `REMOVED` |
| `DETACHED` | No longer tracked by the buffer | `detach()` or `untrack()` | → `MANAGED` via `merge()`/`track()` |
| `REMOVED` | Marked for DELETE on next flush | `remove()` | → gone after flush |

Here's the full lifecycle in code:

```typescript
const buf = em.buffer();

// 1. NEW — queued for INSERT
const user = new User();
user.name = "Alice";
buf.persist(user);
buf.getState(user);  // EntityState.NEW

// 2. MANAGED — flushed to DB, now tracked
await buf.flush();
buf.getState(user);  // EntityState.MANAGED
console.log(user.id); // auto-generated PK is written back to the object

// 3. Make changes — still MANAGED, but "dirty"
user.name = "Bob";
await buf.flush();
// → UPDATE "user" SET "name" = 'Bob' WHERE "id" = 1

// 4. REMOVED — marked for deletion
buf.remove(user);
buf.getState(user);  // EntityState.REMOVED

// 5. Flushed — DELETE executed, entity is gone
await buf.flush();
// → DELETE FROM "user" WHERE "id" = 1
```

---

## Loading Entities

### findOne / find

These work exactly like `em.findOne()` and `em.find()`, but every returned entity is **automatically tracked** in the buffer — snapshot taken, Identity Map registered:

```typescript
const buf = em.buffer();

const user = await buf.findOne(User, { where: { id: 1 } });
const posts = await buf.find(Post, { where: { authorId: 1 } });

buf.tracked();  // [user, ...posts] — all automatically tracked
```

```sql
SELECT * FROM "user" WHERE "id" = $1
SELECT * FROM "post" WHERE "authorId" = $1
```

You can use all the same `FindOption` properties as regular `em.find()` — `where`, `select`, `orderBy`, `relations`, etc.

### getReference — FK without a query

Sometimes you just need a foreign key reference without loading the full entity. For example, you're creating a Post and need to set `authorId`, but you already know the user's ID:

```typescript
const buf = em.buffer();

// No database query — just creates { id: 5 } and registers in Identity Map
const author = buf.getReference(User, 5);

const post = new Post();
post.title = "Hello";
post.authorId = 5;
buf.persist(post);
await buf.flush();
```

```sql
INSERT INTO "post" ("title", "authorId") VALUES ($1, $2)
-- parameters: ['Hello', 5]
-- No SELECT for user — we just needed the ID
```

If you later call `buf.findOne(User, { where: { id: 5 } })`, it returns the same reference that `getReference()` created — the Identity Map guarantees this.

### track — Manually register an entity

If you loaded an entity through `em` (not `buf`) and want the buffer to track it:

```typescript
const user = await em.findOne(User, { where: { id: 1 } });  // loaded outside buffer
buf.track(user);  // now tracked — snapshot taken, Identity Map registered

user.name = "updated";
await buf.flush();
```

```sql
UPDATE "user" SET "name" = $1 WHERE "id" = $2
-- parameters: ['updated', 1]
```

---

## Writing Data

### persist — Instance-based INSERT

`persist()` queues a new entity instance for INSERT. The entity should not have a primary key yet (or have `undefined`/`null` PK). After flush, the database-generated PK is written back to the original object:

```typescript
const buf = em.buffer();

const user = new User();
user.name = "Alice";
user.email = "alice@example.com";
buf.persist(user);
// Nothing has hit the database yet — user is just queued

console.log(user.id);  // undefined — not inserted yet

await buf.flush();

console.log(user.id);  // 42 — auto-generated PK written back!
```

```sql
-- Inside the flush transaction:
INSERT INTO "user" ("name", "email") VALUES ($1, $2) RETURNING "id"
-- parameters: ['Alice', 'alice@example.com']
-- PostgreSQL: RETURNING gives us the generated id
-- MySQL: LAST_INSERT_ID() gives us the generated id
```

If the instance already has a PK, `persist()` assumes it's an existing entity and delegates to `track()` for dirty checking instead.

### save — Plain object INSERT

For quick inserts when you don't need an entity instance:

```typescript
buf.save(User, { name: "Bob", email: "bob@example.com" });
await buf.flush();
```

```sql
INSERT INTO "user" ("name", "email") VALUES ($1, $2)
-- parameters: ['Bob', 'bob@example.com']
```

### remove — Instance-based DELETE

Mark a tracked entity for deletion:

```typescript
const user = await buf.findOne(User, { where: { id: 1 } });
buf.remove(user);
await buf.flush();
```

```sql
DELETE FROM "user" WHERE "id" = $1
-- parameters: [1]
```

If the entity was `persist()`-ed but not yet flushed, `remove()` simply cancels the pending INSERT — no DELETE is needed since the row doesn't exist in the database yet.

### delete — Criteria-based DELETE

Delete by criteria without loading the entity first:

```typescript
buf.delete(User, { id: 1 });
await buf.flush();
```

```sql
DELETE FROM "user" WHERE "id" = $1
-- parameters: [1]
```

---

## Flush — The Moment of Truth

`flush()` is where everything happens. All the changes you've queued up — inserts, updates, deletes — are executed in a **single database transaction**:

```typescript
const result = await buf.flush();
console.log(result);
// { updates: 2, inserts: 1, deletes: 0 }
```

```sql
BEGIN;

-- 1. Updates (dirty tracked entities)
UPDATE "user" SET "name" = $1 WHERE "id" = $2;
UPDATE "user" SET "email" = $3 WHERE "id" = $4;

-- 2. Inserts
INSERT INTO "post" ("title", "authorId") VALUES ($5, $6) RETURNING "id";

-- 3. (Collection diffs, cascade deletes, bulk operations if any)

COMMIT;
```

### Execution order

The flush executes operations in a carefully ordered sequence:

1. **UPDATEs** — dirty tracked entities (parents before children)
2. **INSERTs** — persisted instances, then queued saves (parents before children)
3. **Collection diffs** — O2M orphan removal, M2M pivot table sync
4. **Cascade DELETEs** — recursively collected children
5. **DELETEs** — queued removes (children before parents)
6. **Bulk UPDATEs** — `updateMany()` operations
7. **Bulk DELETEs** — `deleteMany()` operations

### Why does order matter?

Consider inserting a Post that references a User via foreign key. If the Post is inserted before the User, the database rejects it — the FK target doesn't exist yet.

The buffer analyzes `@ManyToOne` and `@OneToOne` metadata to build a **dependency graph**, then uses topological sort to ensure:

- **INSERTs:** parents before children (so FK targets exist)
- **DELETEs:** children before parents (so FK constraints aren't violated)

Cycles in the dependency graph are detected and handled gracefully with a fallback to the original order.

### Atomicity — all or nothing

If any operation fails, the entire transaction is rolled back:

```typescript
try {
  await buf.flush();
} catch (error) {
  // ALL operations are rolled back — the database is unchanged
  // The buffer's queues are preserved, so you can fix the issue and retry
  await buf.flush();  // try again
}
```

### preview — Dry run

Before flushing, inspect what operations will execute without touching the database:

```typescript
const preview = buf.preview();
// [
//   { action: "update", entity: "User", where: { id: 1 }, data: { name: "Bob" } },
//   { action: "insert", entity: "Post", data: { title: "Hello" } },
// ]
```

### size — Queue status

Check how much work is pending:

```typescript
const s = buf.size();
// { tracked: 5, inserts: 1, deletes: 0, persists: 2, bulkUpdates: 0, bulkDeletes: 0, identityMap: 8 }
```

---

## Cascade

When `cascade: true` (the default), the buffer automatically propagates operations through entity relations. This means persisting a parent can automatically insert its children, and removing a parent can automatically delete its children.

### Cascade persist — "Insert the parent and its children together"

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
```

```sql
BEGIN;
-- Parent first (topological order)
INSERT INTO "post" ("title") VALUES ($1) RETURNING "id";
-- parameters: ['Hello']  → returns id = 42

-- Children second (FK automatically set to parent's generated PK)
INSERT INTO "comment" ("body", "postId") VALUES ($2, $3);
-- parameters: ['First!', 42]
INSERT INTO "comment" ("body", "postId") VALUES ($4, $5);
-- parameters: ['Nice post', 42]
COMMIT;
```

Notice that the children's `postId` is automatically set to `42` — the parent's generated PK. You don't need to set it manually.

### Cascade delete — "Delete the parent and its children together"

If `cascade: ["delete"]` is set, removing a parent also deletes its children:

```typescript
buf.remove(post);
await buf.flush();
```

```sql
BEGIN;
-- Children first (reverse topological order)
DELETE FROM "comment" WHERE "postId" = $1;
-- parameters: [42]

-- Parent last
DELETE FROM "post" WHERE "id" = $1;
-- parameters: [42]
COMMIT;
```

The buffer recursively collects all cascade targets (including grandchildren) before executing deletes in reverse topological order.

### Supported cascade operations by relation type

| Relation | Insert | Update | Delete | Orphan Removal |
|----------|--------|--------|--------|----------------|
| `@OneToMany` | New children auto-inserted | Dirty children auto-updated | Recursive delete | If enabled |
| `@OneToOne` | Owning side auto-inserted | Owning side auto-updated | If joinColumn set | — |
| `@ManyToMany` | New children + pivot rows | — | — | Pivot rows removed |

### Cascade merge / detach / refresh

These operations also propagate through the relation graph when cascade is enabled:

```typescript
buf.merge(detachedPost);   // merges post + its tracked children
buf.detach(post);          // detaches post + its tracked children
await buf.refresh(post);   // reloads post + its tracked children from DB
```

---

## State Management

### untrack / detach

Both remove an entity from the buffer, but with a key difference:

```typescript
buf.untrack(user);   // remove from tracking — NO cascade to related entities
buf.detach(user);    // remove from tracking — CASCADE to related entities
```

Use `untrack()` when you want to stop tracking one specific entity. Use `detach()` when you want to stop tracking an entity and everything connected to it.

### detachByPk / detachAll

Variants for when you don't hold the instance reference, or want to detach everything at once.

```typescript
// Detach by PK — handy when you only have an ID from an external request
buf.detachByPk(User, 7);
buf.detachByPk(OrderItem, { orderId: 1, productId: 42 }); // composite PK

// Detach every tracked entity in one call
buf.detachAll();
```

`detachByPk()` looks up the instance in the Identity Map and delegates to `detach()`. If nothing matches, it is a no-op.

`detachAll()` clears every tracked entity plus the pending `persist` queue, transitioning each instance to `DETACHED`. Class/criteria-based queues (`delete`, `bulkUpdate`, `bulkDelete`, `save`) are left untouched — call `clear()` to wipe queues as well.

### merge

Re-attach a detached entity. If a tracked instance with the same PK exists, the detached values are copied into the existing tracked instance:

```typescript
// user was detached earlier, then modified outside the buffer
const detachedUser = { id: 1, name: "Updated Name" };
buf.merge(detachedUser);
// If User#1 is already tracked, its name is updated to "Updated Name"
// If not, the detached instance is tracked fresh
```

### refresh

Reload an entity from the database, updating all fields in-place:

```typescript
await buf.refresh(user);
// Re-queries the DB for user's PK
// Updates all fields on the existing object
// Takes a new snapshot for dirty checking
```

```sql
SELECT * FROM "user" WHERE "id" = $1
-- parameters: [1]
```

This is useful when you suspect another process has modified the row and you want the latest data.

### clear

Nuclear option — remove all tracked entities, clear the Identity Map, and discard all queued operations:

```typescript
buf.clear();
// Identity Map: empty
// Tracked entities: none
// Queued inserts/deletes: none
```

---

## Next Steps

- [Write Buffer — Advanced](./write-buffer-advanced.md) — Lazy loading, locking, batch DML, flush modes, nested UoW
- [Plugin System](./plugins.md) — Writing custom plugins
- [Transactions](./transactions.md) — Manual and decorator-based transactions
- [API Reference](./api-reference.md) — Full method signatures
