# EntityManager -- CRUD Basics

**EntityManager** is the central gateway to all database operations in Stingerloom ORM. Every create, read, update, and delete flows through it.

```typescript
import { EntityManager } from "@stingerloom/orm";

const em = new EntityManager();
```

This page covers the essential CRUD lifecycle. For querying features (pagination, aggregates, streaming), see [Querying & Pagination](./entity-manager-querying.md). For batch writes, upserts, and transactions, see [Writes & Transactions](./entity-manager-writes.md).

---

## Connecting -- register()

### Why register() exists

Before any query can run, three things must happen: (1) the ORM needs a live connection to the database, (2) it needs to know what your entity classes look like (which columns, types, and relations exist), and (3) it needs to make sure the database tables actually match those classes. The `register()` method does all three in one call.

Think of it like plugging in an appliance. You cannot toast bread until you plug the toaster into the wall, tell it what kind of bread you have, and verify the heating elements match.

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

### What happens inside register()

`register()` performs three steps internally:

**Step 1 -- Connect.** It creates a connection pool to the database. A pool is a set of reusable connections (like having 10 phone lines instead of 1) so that multiple queries can run concurrently without waiting for each other. The pool size is configurable via the `pool` option.

**Step 2 -- Scan metadata.** It reads the decorators you placed on your entity classes (`@Entity`, `@Column`, `@ManyToOne`, etc.) and builds an internal metadata map. This map tells the ORM: "The `User` class corresponds to the `user` table, it has columns `id`, `name`, `email`, and `id` is the auto-increment primary key." This scanning step is what makes the decorator-based approach work -- you define your schema in TypeScript, and the ORM learns it at startup.

**Step 3 -- Synchronize schema.** If `synchronize` is enabled, the ORM compares the metadata map against the actual database tables and generates DDL to close the gap:

```sql
-- PostgreSQL: if the "user" table doesn't exist yet
CREATE TABLE IF NOT EXISTS "user" (
  "id" SERIAL NOT NULL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL,
  "email" VARCHAR(255) NOT NULL
);

-- MySQL equivalent
CREATE TABLE IF NOT EXISTS `user` (
  `id` INT NOT NULL PRIMARY KEY AUTO_INCREMENT,
  `name` VARCHAR(255) NOT NULL,
  `email` VARCHAR(255) NOT NULL
);
```

If a table exists but is missing a column that your entity defines, the ORM adds it:

```sql
-- PostgreSQL
ALTER TABLE "user" ADD "avatar" VARCHAR(255) NULL;

-- MySQL
ALTER TABLE `user` ADD `avatar` VARCHAR(255) NULL;
```

### synchronize modes

| Value | Behavior |
|-------|----------|
| `true` | Full sync -- creates tables, adds **and drops** columns to match entities. |
| `"safe"` | Safe mode -- creates tables and adds columns, but **never drops** columns or tables. |
| `"dry-run"` | Preview -- logs DDL statements that *would* execute, without applying them. |
| `false` (default) | No synchronization. Manage schema with [migrations](./migrations.md). |

::: warning
Use `synchronize: true` only in development. It can drop columns in production. Use [migrations](./migrations.md) for production schema management.
:::

### synchronize options object

The bare forms above couple three independent concerns: resilience, destructive-change safety, and DDL visibility. Pass an object instead to opt into them individually:

```ts
synchronize: {
  mode: "safe",                  // base mode (true | "safe" | "dry-run")
  continueOnError: false,         // abort registerEntities() on first DDL failure
  failOnDestructiveChange: true,  // throw before DROP COLUMN / narrowing ALTER
  logDDL: true,                   // log every emitted DDL statement
}
```

| Flag | Default | Effect when set |
|------|---------|----------------|
| `mode` | required | Base mode — same semantics as the bare form. |
| `continueOnError` | `true` | When `false`, a failing DDL statement throws `OrmError(SCHEMA_SYNC_FAILED)` and aborts boot instead of being downgraded to a warning. |
| `failOnDestructiveChange` | `false` | When `true`, DROP COLUMN, DROP TABLE, and narrowing ALTER (e.g. `varchar(255) → int`, `varchar(255) → varchar(64)`) throw `OrmError(SCHEMA_SYNC_DESTRUCTIVE_CHANGE)` before executing. |
| `logDDL` | `false` | When `true`, every emitted DDL statement is logged at info level (CREATE TABLE, ALTER, RENAME, DROP, FULLTEXT INDEX, etc.). |

The bare forms (`true`, `"safe"`, `"dry-run"`, `false`) keep working unchanged — they normalize to the same defaults above. A typical production profile is:

```ts
synchronize: {
  mode: "safe",
  continueOnError: false,
  failOnDestructiveChange: true,
}
```

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

## Saving -- save()

### Why save() is a "smart upsert"

Most applications have two common write patterns: creating a new record and updating an existing one. Instead of making you call two different methods (like `insert()` and `update()`), `save()` figures out which one to use by looking at the primary key:

- **No PK value present** -- This must be a new record. Run `INSERT`.
- **PK value present** -- This record already exists. Run `UPDATE`.

This is the decision tree inside the ORM:

```
save(User, data)
  |
  +-- data.id is undefined or null?
  |     YES --> INSERT (new row)
  |     NO  --> UPDATE (existing row)
```

### INSERT example

```typescript
const user = await em.save(User, {
  name: "Alice",
  email: "alice@example.com",
});
console.log(user.id); // 1 -- auto-generated primary key
```

The ORM builds and executes this SQL:

```sql
-- PostgreSQL
INSERT INTO "user" ("name", "email")
VALUES ($1, $2)
RETURNING *
-- Parameters: ['Alice', 'alice@example.com']

-- MySQL
INSERT INTO `user` (`name`, `email`)
VALUES (?, ?)
-- Parameters: ['Alice', 'alice@example.com']
-- Then: SELECT * FROM `user` WHERE `id` = LAST_INSERT_ID()
```

Notice the difference: PostgreSQL supports `RETURNING *`, which gives back the full row (including the generated `id`) in a single round-trip. MySQL does not, so the ORM runs a follow-up `SELECT` to fetch the newly created row.

### UPDATE example

```typescript
const updated = await em.save(User, {
  id: 1,
  name: "Alice Kim",
  email: "alice@example.com",
});
console.log(updated.name); // "Alice Kim"
```

Generated SQL:

```sql
-- PostgreSQL
UPDATE "user"
SET "name" = $1, "email" = $2
WHERE "id" = $3
RETURNING *
-- Parameters: ['Alice Kim', 'alice@example.com', 1]

-- MySQL
UPDATE `user`
SET `name` = ?, `email` = ?
WHERE `id` = ?
-- Parameters: ['Alice Kim', 'alice@example.com', 1]
-- Then: SELECT * FROM `user` WHERE `id` = 1
```

### What happens during save()

1. **Validation** -- If the entity has `@Validation` decorators, they run before the query.
2. **Lifecycle hooks** -- `@BeforeInsert` / `@BeforeUpdate` callbacks fire.
3. **Timestamp injection** -- `@CreateTimestamp` is set on INSERT; `@UpdateTimestamp` is set on INSERT and UPDATE.
4. **Optimistic locking** -- If the entity has a `@Version` column, the ORM checks the version matches and increments it. A mismatch throws `OptimisticLockError`.
5. **Cascade** -- Related entities marked with `cascade: true` are saved recursively.
6. **Event emission** -- `afterInsert` / `afterUpdate` events fire.

### Partial updates

`save()` only touches the columns you provide. Omitted columns are left unchanged:

```typescript
// Only updates the name -- email and other columns are untouched
await em.save(User, { id: 1, name: "Bob" });
```

```sql
-- PostgreSQL
UPDATE "user" SET "name" = $1 WHERE "id" = $2 RETURNING *
-- Parameters: ['Bob', 1]

-- MySQL
UPDATE `user` SET `name` = ? WHERE `id` = ?
-- Parameters: ['Bob', 1]
```

---

## Querying -- find() and findOne()

### Why two methods?

`find()` returns a list. `findOne()` returns exactly one record or `null`. Having both saves you from writing `.filter(...)` or `[0]` boilerplate. More importantly, `findOne()` adds `LIMIT 1` to the SQL, telling the database it can stop scanning as soon as it finds one match -- this is a significant performance optimization on large tables.

### List query -- find()

`find()` always returns `T[]`. An empty table returns `[]`, never `null` or `undefined`.

```typescript
// Fetch all users
const users = await em.find(User);
```

```sql
-- PostgreSQL
SELECT "id", "name", "email" FROM "user"

-- MySQL
SELECT `id`, `name`, `email` FROM `user`
```

#### WHERE condition

```typescript
const activeUsers = await em.find(User, {
  where: { isActive: true },
});
```

```sql
-- PostgreSQL
SELECT "id", "name", "email", "isActive" FROM "user"
WHERE "isActive" = $1
-- Parameters: [true]

-- MySQL
SELECT `id`, `name`, `email`, `isActive` FROM `user`
WHERE `isActive` = ?
-- Parameters: [true]
```

#### ORDER BY + LIMIT

```typescript
const recent = await em.find(Post, {
  orderBy: { createdAt: "DESC" },
  take: 10,
});
```

```sql
-- PostgreSQL
SELECT "id", "title", "createdAt" FROM "post"
ORDER BY "createdAt" DESC
LIMIT 10

-- MySQL
SELECT `id`, `title`, `createdAt` FROM `post`
ORDER BY `createdAt` DESC
LIMIT 10
```

#### Multiple WHERE conditions (AND)

Every key in `where` becomes an `AND` condition:

```typescript
const filtered = await em.find(User, {
  where: { isActive: true, role: "admin" },
  orderBy: { name: "ASC" },
});
```

```sql
-- PostgreSQL
SELECT "id", "name", "email", "isActive", "role" FROM "user"
WHERE "isActive" = $1 AND "role" = $2
ORDER BY "name" ASC
-- Parameters: [true, 'admin']

-- MySQL
SELECT `id`, `name`, `email`, `isActive`, `role` FROM `user`
WHERE `isActive` = ? AND `role` = ?
ORDER BY `name` ASC
-- Parameters: [true, 'admin']
```

For more complex queries (OR, subqueries, raw conditions), use the [Query Builder](./query-builder.md).

### Single record -- findOne()

`findOne()` returns `T | null`. Always check for `null` before using the result.

```typescript
const user = await em.findOne(User, { where: { id: 1 } });

if (user === null) {
  throw new Error("User not found");
}

console.log(user.name);
```

```sql
-- PostgreSQL
SELECT "id", "name", "email" FROM "user"
WHERE "id" = $1
LIMIT 1
-- Parameters: [1]

-- MySQL
SELECT `id`, `name`, `email` FROM `user`
WHERE `id` = ?
LIMIT 1
-- Parameters: [1]
```

The `LIMIT 1` is added automatically. On a table with 10 million rows, the database stops at the first match instead of scanning everything.

### Guaranteed result -- findOneOrFail()

When you know a record must exist and want to avoid manual `null` checks, use `findOneOrFail()`. It works exactly like `findOne()` but throws `EntityNotFoundError` if no row is found.

```typescript
// Throws EntityNotFoundError if user does not exist
const user = await em.findOneOrFail(User, { where: { id: 1 } });
console.log(user.name); // Safe -- guaranteed non-null
```

This is useful in service methods where a missing record means invalid input:

```typescript
async getUser(id: number): Promise<User> {
  return em.findOneOrFail(User, { where: { id } });
  // No need for: if (!user) throw new NotFoundException();
}
```

The thrown `EntityNotFoundError` includes the entity name for debugging. The repository equivalent is `userRepo.findOneOrFail({ where: { id } })`.

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

For `@ManyToOne` relations like `author`, the ORM generates a LEFT JOIN:

```sql
-- PostgreSQL
SELECT "post"."id", "post"."title", "post"."createdAt",
       "user"."id" AS "author_id", "user"."name" AS "author_name"
FROM "post"
LEFT JOIN "user" ON "post"."authorId" = "user"."id"
WHERE "post"."id" = $1
LIMIT 1
-- Parameters: [1]
```

For `@ManyToMany` relations like `tags`, the ORM runs a separate query using the join table:

```sql
SELECT "tag".* FROM "tag"
INNER JOIN "post_tags" ON "tag"."id" = "post_tags"."tagId"
WHERE "post_tags"."postId" = $1
-- Parameters: [1]
```

For a deeper look at select, distinct, locking, pagination, and aggregates, see [Querying & Pagination](./entity-manager-querying.md).

### Convenience methods -- findByPK(), findByPKs(), exists()

For common lookup patterns, these shortcuts avoid writing `{ where: { id: ... } }` by hand:

```typescript
// Find by primary key
const user = await em.findByPK(User, 1);        // User | null

// Find multiple by primary keys
const users = await em.findByPKs(User, [1, 2, 3]); // User[]

// Check if any matching record exists (takes WhereClause directly)
const hasAdmin = await em.exists(User, { role: "admin" }); // boolean
```

`exists()` is more efficient than `find()` + length check because it generates `SELECT 1 ... LIMIT 1` instead of fetching full rows.

---

## Deleting -- delete()

### Why delete() requires conditions

Permanently removing rows is dangerous. Accidentally deleting all rows in a production table is the kind of mistake that ends careers. That is why `delete()` **requires** a WHERE condition and throws an error if you pass an empty object.

```typescript
const result = await em.delete(User, { id: 1 });
console.log(result.affected); // 1
```

```sql
-- PostgreSQL
DELETE FROM "user" WHERE "id" = $1
-- Parameters: [1]

-- MySQL
DELETE FROM `user` WHERE `id` = ?
-- Parameters: [1]
```

You can delete by any column, not just the primary key:

```typescript
// Delete all inactive users
const result = await em.delete(User, { isActive: false });
console.log(result.affected); // number of deleted rows
```

```sql
-- PostgreSQL
DELETE FROM "user" WHERE "isActive" = $1
-- Parameters: [false]

-- MySQL
DELETE FROM `user` WHERE `isActive` = ?
-- Parameters: [false]
```

::: danger
Calling `delete()` with an empty condition object throws `DeleteWithoutConditionsError`. This is a safety mechanism to prevent accidentally deleting all rows.
:::

```typescript
// This throws DeleteWithoutConditionsError
await em.delete(User, {});
```

---

## Soft Delete -- softDelete() and restore()

### Why soft delete?

Sometimes you want to "delete" data without actually removing it. Think of it like moving a file to the Recycle Bin instead of permanently erasing it. Common reasons:

- **Legal compliance**: Regulations may require you to keep records for a certain period.
- **Undo support**: Users might change their mind. Restoring is trivial with soft delete, impossible with hard delete.
- **Audit trails**: You want to know what existed even after it was "removed."

Soft delete does not remove the row. Instead, it sets a timestamp on the `@DeletedAt` column. Soft-deleted rows are automatically excluded from `find()` and `findOne()`.

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

Under the hood, this is an UPDATE, not a DELETE:

```sql
-- PostgreSQL
UPDATE "post" SET "deletedAt" = NOW() WHERE "id" = $1
-- Parameters: [1]

-- MySQL
UPDATE `post` SET `deletedAt` = NOW() WHERE `id` = ?
-- Parameters: [1]
```

After soft deletion, the row becomes invisible to normal queries because the ORM automatically appends a `WHERE "deletedAt" IS NULL` condition:

```typescript
const posts = await em.find(Post);
// Post with id=1 is NOT included
```

```sql
-- PostgreSQL
SELECT "id", "title", "deletedAt" FROM "post"
WHERE "deletedAt" IS NULL
```

To include soft-deleted rows, pass `withDeleted: true`:

```typescript
const allPosts = await em.find(Post, { withDeleted: true });
// Post with id=1 IS included
```

```sql
-- PostgreSQL (no deletedAt filter)
SELECT "id", "title", "deletedAt" FROM "post"
```

### Restoring

`restore()` sets `deletedAt` back to `NULL`, making the row visible again:

```typescript
await em.restore(Post, { id: 1 });

const post = await em.findOne(Post, { where: { id: 1 } });
// post is now found
```

```sql
-- PostgreSQL
UPDATE "post" SET "deletedAt" = NULL WHERE "id" = $1
-- Parameters: [1]

-- MySQL
UPDATE `post` SET `deletedAt` = NULL WHERE `id` = ?
-- Parameters: [1]
```

---

## Clearing a Table -- clear()

### Why clear() exists (and when to use it)

`clear()` deletes **all rows** from a table. Unlike `delete()`, it uses the database's `TRUNCATE` command (or equivalent), which is significantly faster because it does not generate individual row deletion logs.

Use it for test teardown or resetting seed data. Never use it in production unless you genuinely want to empty the table.

```typescript
await em.clear(User);
// All rows in the "user" table are deleted
```

```sql
-- PostgreSQL
TRUNCATE TABLE "user"

-- MySQL (with FK safety)
SET FOREIGN_KEY_CHECKS = 0;
TRUNCATE TABLE `user`;
SET FOREIGN_KEY_CHECKS = 1;
```

MySQL requires temporarily disabling foreign key checks because `TRUNCATE` cannot run on a table referenced by foreign keys. The ORM handles this automatically within a single connection to ensure isolation.

::: warning
`clear()` is a permanent, irreversible operation. There is no soft-delete equivalent.
:::

---

## Next Steps

- **[Querying & Pagination](./entity-manager-querying.md)** -- SELECT columns, ordering, DISTINCT, locking, pagination, streaming, aggregates, EXPLAIN
- **[Writes & Transactions](./entity-manager-writes.md)** -- Batch operations, upsert, transactions, raw SQL
- **[Advanced](./entity-manager-advanced.md)** -- Events, subscribers, multi-tenancy, plugins, shutdown, FindOption reference
