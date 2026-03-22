# EntityManager — CRUD Basics

**EntityManager** is the central gateway to all database operations in Stingerloom ORM. Every create, read, update, and delete flows through it.

```typescript
import { EntityManager } from "@stingerloom/orm";

const em = new EntityManager();
```

This page covers the essential CRUD lifecycle. For querying features (pagination, aggregates, streaming), see [Querying & Pagination](./entity-manager-querying.md). For batch writes, upserts, and transactions, see [Writes & Transactions](./entity-manager-writes.md).

---

## Connecting — register()

Before any operation, you must connect to a database and register your entities.

```typescript
import "reflect-metadata";
import { EntityManager } from "@stingerloom/orm";
import { User } from "./user.entity";
import { Post } from "./post.entity";

const em = new EntityManager();

await em.register({
  type: "postgres",          // "mysql" | "postgres" | "sqlite"
  host: "localhost",
  port: 5432,
  username: "postgres",
  password: "password",
  database: "mydb",
  entities: [User, Post],
  synchronize: true,
});
```

`register()` performs three steps internally:

1. **Connects** to the database (creating a connection pool).
2. **Scans** entity metadata from decorators (`@Entity`, `@Column`, etc.).
3. **Synchronizes** the schema if `synchronize` is enabled — creates missing tables, adds new columns.

### synchronize modes

| Value | Behavior |
|-------|----------|
| `true` | Full sync — creates tables, adds **and drops** columns to match entities. |
| `"safe"` | Safe mode — creates tables and adds columns, but **never drops** columns or tables. |
| `"dry-run"` | Preview — logs DDL statements that *would* execute, without applying them. |
| `false` (default) | No synchronization. Manage schema with [migrations](./migrations.md). |

::: warning
Use `synchronize: true` only in development. It can drop columns in production. Use [migrations](./migrations.md) for production schema management.
:::

### Named connections (multi-DB)

You can run multiple databases simultaneously by passing a connection name as the second argument:

```typescript
const em = new EntityManager();

// Primary database
await em.register({ type: "postgres", /* ... */ entities: [User] }, "default");

// Analytics database
const analyticsEm = new EntityManager();
await analyticsEm.register({ type: "mysql", /* ... */ entities: [Event] }, "analytics");
```

For the full list of connection options (pooling, retry, replication, query timeout), see the [Configuration Guide](./configuration.md).

---

## Saving — save()

`save()` is an **intelligent upsert at the entity level**. It inspects the primary key to decide whether to INSERT or UPDATE:

- **No PK present** → `INSERT` a new row and return the entity with the generated PK.
- **PK present** → `UPDATE` the existing row.

```typescript
// INSERT — no id, so a new row is created
const user = await em.save(User, {
  name: "Alice",
  email: "alice@example.com",
});
console.log(user.id); // 1 — auto-generated primary key

// UPDATE — id is present, so the existing row is modified
const updated = await em.save(User, {
  id: 1,
  name: "Alice Kim",
  email: "alice@example.com",
});
console.log(updated.name); // "Alice Kim"
```

### What happens during save()

1. **Validation** — If the entity has `@Validation` decorators, they run before the query.
2. **Lifecycle hooks** — `@BeforeInsert` / `@BeforeUpdate` callbacks fire.
3. **Timestamp injection** — `@CreateTimestamp` is set on INSERT; `@UpdateTimestamp` is set on INSERT and UPDATE.
4. **Optimistic locking** — If the entity has a `@Version` column, the ORM checks the version matches and increments it. A mismatch throws `OptimisticLockError`.
5. **Cascade** — Related entities marked with `cascade: true` are saved recursively.
6. **Event emission** — `afterInsert` / `afterUpdate` events fire.

### Partial updates

`save()` only touches the columns you provide. Omitted columns are left unchanged:

```typescript
// Only updates the name — email and other columns are untouched
await em.save(User, { id: 1, name: "Bob" });
```

---

## Querying — find() and findOne()

### List query — find()

`find()` always returns `T[]`. An empty table returns `[]`, never `null` or `undefined`.

```typescript
// Fetch all users
const users = await em.find(User);

// WHERE condition
const activeUsers = await em.find(User, {
  where: { isActive: true },
});

// ORDER BY + LIMIT
const recent = await em.find(Post, {
  orderBy: { createdAt: "DESC" },
  take: 10,
});

// Multiple WHERE conditions (AND)
const filtered = await em.find(User, {
  where: { isActive: true, role: "admin" },
  orderBy: { name: "ASC" },
});
```

Every key in `where` becomes an `AND` condition. For more complex queries (OR, subqueries, raw conditions), use the [Query Builder](./query-builder.md).

### Single record — findOne()

`findOne()` returns `T | null`. Always check for `null` before using the result.

```typescript
const user = await em.findOne(User, { where: { id: 1 } });

if (user === null) {
  throw new Error("User not found");
}

console.log(user.name);
```

::: tip
`findOne()` internally adds `LIMIT 1` to the query, so it is efficient even on large tables.
:::

### Loading relations

Pass `relations` to eagerly load associated entities via LEFT JOIN:

```typescript
const post = await em.findOne(Post, {
  where: { id: 1 },
  relations: ["author", "tags"],
});

console.log(post.author.name);  // User entity
console.log(post.tags);         // Tag[]
```

For a deeper look at select, distinct, locking, pagination, and aggregates, see [Querying & Pagination](./entity-manager-querying.md).

---

## Deleting — delete()

Permanently removes rows from the database.

```typescript
const result = await em.delete(User, { id: 1 });
console.log(result.affected); // 1
```

You can delete by any column, not just the primary key:

```typescript
// Delete all inactive users
const result = await em.delete(User, { isActive: false });
console.log(result.affected); // number of deleted rows
```

::: danger
Calling `delete()` with an empty condition object throws `DeleteWithoutConditionsError`. This is a safety mechanism to prevent accidentally deleting all rows.
:::

```typescript
// This throws DeleteWithoutConditionsError
await em.delete(User, {});
```

---

## Soft Delete — softDelete() and restore()

Soft delete doesn't remove the row. Instead, it sets a timestamp on the `@DeletedAt` column. Soft-deleted rows are automatically excluded from `find()` and `findOne()`.

### Entity setup

Your entity must have a `@DeletedAt` column:

```typescript
import { Entity, PrimaryGeneratedColumn, Column, DeletedAt } from "@stingerloom/orm";

@Entity()
class Post {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "varchar" })
  title: string;

  @DeletedAt()
  deletedAt: Date | null;
}
```

### Soft deleting

```typescript
await em.softDelete(Post, { id: 1 });
// The row now has deletedAt = '2026-03-22 12:00:00'
```

After soft deletion, the row becomes invisible to normal queries:

```typescript
const posts = await em.find(Post);
// Post with id=1 is NOT included

const allPosts = await em.find(Post, { withDeleted: true });
// Post with id=1 IS included
```

### Restoring

`restore()` sets `deletedAt` back to `NULL`, making the row visible again:

```typescript
await em.restore(Post, { id: 1 });

const post = await em.findOne(Post, { where: { id: 1 } });
// post is now found
```

---

## Clearing a Table — clear()

`clear()` deletes **all rows** from a table. Use with caution.

```typescript
await em.clear(User);
// All rows in the "user" table are deleted
```

Unlike `delete()`, this does not require a WHERE condition — it intentionally removes everything. Useful for test teardown or resetting seed data.

::: warning
`clear()` is a permanent, irreversible operation. There is no soft-delete equivalent.
:::

---

## Next Steps

- **[Querying & Pagination](./entity-manager-querying.md)** — SELECT columns, ordering, DISTINCT, locking, pagination, streaming, aggregates, EXPLAIN
- **[Writes & Transactions](./entity-manager-writes.md)** — Batch operations, upsert, transactions, raw SQL
- **[Advanced](./entity-manager-advanced.md)** — Events, subscribers, multi-tenancy, plugins, shutdown, FindOption reference
