# Query Builder — Execution & Results

Once the shape of the query is settled, this page covers everything
that affects how it runs and what it returns: ordering, pagination,
pessimistic locking, index hints, soft-delete handling, runtime result
validation, the execution-method tiers (`getMany` / `getPartialMany` /
`getRawMany`), and compilation of repeated queries.

## ORDER BY and Pagination

Sorting and pagination work just like you'd expect.

```typescript
// Type-safe ORDER BY — column names auto-complete
qb.orderBy({ createdAt: "DESC", name: "ASC" });

// LIMIT and OFFSET
qb.limit(10).offset(20);

// Or use the skip/take aliases (same effect)
qb.skip(20).take(10);
```

Need both the data and the total count? `getManyAndCount()` runs both queries in parallel and returns `[T[], number]`.

```typescript
const [users, total] = await em
  .createQueryBuilder(User, "u")
  .where("isActive", true)
  .orderBy({ createdAt: "DESC" })
  .skip(20)
  .take(10)
  .getManyAndCount();

console.log(users.length); // up to 10
console.log(total);        // e.g. 235
```

> For cursor-based pagination, streaming, and the full pagination
> strategy guide, see [Pagination & Streaming](./pagination.md).

## Pessimistic Locking

In high-concurrency scenarios, you sometimes need to lock rows while reading them to prevent other transactions from modifying them.

```typescript
const user = await em
  .createQueryBuilder(User, "u")
  .where("id", 1)
  .forUpdate()
  .getOne();
// SELECT ... FROM "user" AS "u" WHERE "u"."id" = $1 FOR UPDATE
```

`forUpdate()` adds `FOR UPDATE` — an exclusive lock. No other transaction can read or modify this row until yours commits. `forShare()` adds a shared lock instead — others can read but not write.

| Method | SQL | Effect |
|--------|-----|--------|
| `forUpdate()` | `FOR UPDATE` | Exclusive lock — blocks reads and writes |
| `forShare()` | `FOR SHARE` / `LOCK IN SHARE MODE` | Shared lock — blocks writes only |

### NOWAIT and SKIP LOCKED

In high-concurrency scenarios, waiting for a lock can become a bottleneck. Two advanced locking options let you control what happens when rows are already locked:

**NOWAIT** — fails immediately with an error instead of waiting for the lock to be released.

```typescript
const user = await em
  .createQueryBuilder(User, "u")
  .where("id", 1)
  .forUpdateNowait()
  .getOne();
// SELECT ... FOR UPDATE NOWAIT
// Throws immediately if the row is locked by another transaction
```

**SKIP LOCKED** — silently skips rows that are already locked. This is especially useful for job queue patterns where multiple workers pull from the same table.

```typescript
// Worker picks up the next unlocked job
const job = await em
  .createQueryBuilder(Job, "j")
  .where("status", "pending")
  .orderBy({ createdAt: "ASC" })
  .limit(1)
  .forUpdateSkipLocked()
  .getOne();
// SELECT ... ORDER BY ... LIMIT 1 FOR UPDATE SKIP LOCKED
// Returns null if all pending jobs are locked by other workers
```

All four combinations are available:

| Method | SQL |
|--------|-----|
| `forUpdateNowait()` | `FOR UPDATE NOWAIT` |
| `forUpdateSkipLocked()` | `FOR UPDATE SKIP LOCKED` |
| `forShareNowait()` | `FOR SHARE NOWAIT` |
| `forShareSkipLocked()` | `FOR SHARE SKIP LOCKED` |

::: warning
NOWAIT and SKIP LOCKED require MySQL 8.0+ or PostgreSQL 9.5+.

SQLite does not support row-level locking — its concurrency model is database-level (`BEGIN EXCLUSIVE`). The query builder appends `FOR UPDATE` to the SQL regardless of dialect, so calling these methods against SQLite produces a syntax error at execution time. Gate the call on the dialect (`em.getDriver().isSqlite()` / `isMySqlFamily()`) when you need portable code.
:::

## Index Hints

For MySQL, you can suggest which index the query planner should use. This is useful when the planner picks a suboptimal index.

```typescript
const orders = await em
  .createQueryBuilder(Order, "o")
  .where("status", "pending")
  .useIndex("idx_order_status")
  .getMany();
// MySQL: SELECT ... FROM `order` USE INDEX (`idx_order_status`) WHERE ...
```

Three MySQL index hint types are available:

| Method | SQL | Effect |
|--------|-----|--------|
| `useIndex(name)` | `USE INDEX (name)` | Suggest an index to the planner |
| `forceIndex(name)` | `FORCE INDEX (name)` | Force the planner to use this index |
| `ignoreIndex(name)` | `IGNORE INDEX (name)` | Tell the planner to skip this index |

On non-MySQL drivers these calls are accepted but **silently dropped** from the emitted SQL — there is no warning. Wrap them in a dialect check (`em.getDriver().isMySqlFamily()`) if you ship to multiple dialects from the same code path.

For PostgreSQL, use the `hint()` method to add [pg_hint_plan](https://pg-hint-plan.readthedocs.io/) style hints:

```typescript
const orders = await em
  .createQueryBuilder(Order, "o")
  .where("status", "pending")
  .hint("IndexScan(o idx_order_status)")
  .getMany();
// PostgreSQL: /*+ IndexScan(o idx_order_status) */ SELECT ...
```

## Soft Delete Handling

If your entity has a `@DeletedAt` column, the query builder automatically excludes soft-deleted rows. To include them:

```typescript
qb.withDeleted();
```

## Tenant Scope Opt-Out

Under the `tenant_column` multi-tenancy strategy, every query built against a tenant-scoped entity is filtered by `tenant_id = <currentTenant>` automatically. The opt-out is per-query:

```typescript
const allTenantUsers = await em
  .createQueryBuilder(User, "u")
  .withoutTenantScope()
  .getMany();
// SELECT ... FROM "user" "u"  (no tenant predicate)
```

This is the right escape hatch for admin dashboards, background reconciliation jobs, and data migrations that genuinely need cross-tenant visibility. No-op when the strategy is not `tenant_column` or the entity is `@NonTenantEntity()`. For a context-wide opt-out, use `MetadataContext.runUnscoped()` instead.

## Escape Hatches

When the typed surface doesn't reach where you need to go, two methods drop you down to raw SQL without leaving the builder:

```typescript
qb
  .where("status", "active")
  .appendSql(sql`ORDER BY "posts_count" DESC NULLS LAST`)
  .getRawMany();
```

- `appendSql(fragment)` splices a `Sql` fragment at the end of the assembled query. Useful for clauses the typed surface doesn't have (e.g. ordering by a `SELECT`-list alias, custom `WINDOW` definitions).
- `asSubquery(alias)` returns the builder as a `Sql` that can be passed to `RawQueryBuilder.from()` or `Conditions.exists()` — parameter bindings are preserved.

## `getCount()` / `exists()` — Selection State is Ignored

These methods rebuild the SELECT from scratch (`SELECT COUNT(*) ...` and `SELECT 1 ... LIMIT 1`). They reuse your `WHERE`, `JOIN`, `GROUP BY`, and `HAVING` clauses, but anything added via `addSelect()`, `withCount()`, or `addSelectSubquery()` is silently discarded:

```typescript
const total = await em
  .createQueryBuilder(User, "u")
  .where("isActive", true)
  .addSelect(sql`COUNT(*)`, "extra")  // discarded by getCount()
  .getCount();
// SELECT COUNT(*) AS "count" FROM "user" "u" WHERE "isActive" = true
```

This is the intended behavior — but if you're chaining `.getCount()` onto a builder used elsewhere with `addSelect`, don't expect the projection to participate in the count.

## Result Validation — validate()

Compile-time type narrowing catches many mistakes, but it can't verify what the database actually returns. A column might contain `null` when you expected a string, or a number might arrive as a string due to driver behavior. For runtime safety, you can attach a **validator** that checks every row before it reaches your application code.

The simplest form is a plain function:

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name"])
  .validate((row) => {
    if (!row.name) throw new Error("name must not be empty");
    return row;
  })
  .getPartialMany();
```

Each row passes through the validator. If the function throws, the entire call rejects with that error. If it returns successfully, the row is included in the results. By default, no validator is attached — zero overhead. Validators work with both `getPartialMany()` and `getMany()`.

The validator function can also **transform** data. Whatever it returns becomes the actual result:

```typescript
.validate((row) => ({
  ...row,
  name: row.name.trim().toLowerCase(),
}))
```

### Using Zod for Schema Validation

Writing validation functions by hand gets tedious. If you use [zod](https://zod.dev), you can pass a schema directly — the query builder recognizes any object with a `.parse()` method.

```typescript
import { z } from "zod";

const UserRow = z.object({
  id: z.number(),
  name: z.string().min(1),
});

const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name"])
  .validate(UserRow)
  .getPartialMany();
```

If any row fails the zod schema, the call throws a `ZodError` with details about which field failed and why. This catches data issues — NULL where you expected a string, a string where you expected a number — at the earliest possible point.

Zod's `.transform()` works too. This lets you validate and reshape data in one step:

```typescript
const NormalizedUser = z.object({
  id: z.number(),
  name: z.string().transform((s) => s.toUpperCase()),
  email: z.string().email(),
});

const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name", "email"])
  .validate(NormalizedUser)
  .getPartialMany();
// [{ id: 1, name: "ALICE", email: "alice@example.com" }, ...]
```

And `.strict()` rejects rows with unexpected extra fields — useful for catching schema drift:

```typescript
const StrictUser = z.object({ id: z.number(), name: z.string() }).strict();

// Throws if the DB returns columns beyond id and name
.validate(StrictUser)
```

Any library that provides a `.parse(data)` method works — not just zod. io-ts, superstruct, and similar libraries are all compatible.

### Array-Level Validation — validateArray()

Sometimes you need to validate the result set as a whole, not individual rows. For example, enforcing a maximum number of results or checking that the array is non-empty.

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name"])
  .validateArray((rows) => {
    if (rows.length === 0) throw new Error("expected at least one user");
    if (rows.length > 1000) throw new Error("result set too large");
    return rows;
  })
  .getPartialMany();
```

Zod array schemas work here too:

```typescript
const UsersArray = z
  .array(z.object({ id: z.number(), name: z.string() }))
  .min(1)
  .max(100);

const users = await qb
  .select(["id", "name"])
  .validateArray(UsersArray)
  .getPartialMany();
```

### Combining Row and Array Validation

You can use both `validate()` and `validateArray()` on the same query. Row-level validation runs first, then array-level:

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name"])
  .validate(z.object({             // 1. Each row: validate + transform
    id: z.number(),
    name: z.string().transform((s) => s.trim()),
  }))
  .validateArray((rows) => {       // 2. Whole array: check constraints
    if (rows.length > 100) throw new Error("too many results");
    return rows;
  })
  .getPartialMany();
```

### When to Use Validation

Validation adds a per-row function call, so it's not free. Here's when it pays for itself:

| Scenario | Validate? | Why |
|----------|-----------|-----|
| Internal service, trusted schema | No | Speed is more important |
| API endpoint returning user data | Yes | Catch nulls/type mismatches before they reach the client |
| ETL pipeline with loose source data | Yes | Prevent bad data from propagating |
| Debugging a deserialization bug | Yes (temporarily) | Pinpoint exactly which row/field is wrong |

The default — no validator, zero overhead — is the right choice for most internal queries. Add validation at the boundaries where data crosses trust zones.

## Executing the Query

You've built the query — now you need to run it. The query builder provides three tiers of execution methods, each with different safety and typing guarantees.

**Safe — class instances with required-column validation:**

| Method | Returns | Description |
|--------|---------|-------------|
| `getMany()` | `T[]` | Class instances. Validates required columns when `select()` is used |
| `getOne()` | `T \| null` | Single class instance or null (auto-adds LIMIT 1) |
| `getOneOrFail()` | `T` | Single class instance (throws `EntityNotFoundError` if not found) |
| `getManyAndCount()` | `[T[], number]` | Class instances + total count in parallel |

These always deserialize rows into entity class instances. `instanceof` works, class methods are available, results can be passed to `em.save()`. When `select()` is used with specific columns, non-nullable columns must be included — otherwise an `OrmError` is thrown.

**Partial — typed plain objects (Pick):**

| Method | Returns | Description |
|--------|---------|-------------|
| `getPartialMany()` | `TResult[]` | Plain objects with `Pick<T, K>` narrowing |
| `getPartialOne()` | `TResult \| null` | Single plain object or null |
| `getPartialManyAndCount()` | `[TResult[], number]` | Plain objects + total count |

No deserialization, no required-column validation. When `select(["id", "name"])` is used, the return type narrows to `Pick<T, "id" | "name">[]` — accessing unselected columns is a compile error. Do not pass results to `em.save()`.

**Raw — untyped plain objects:**

| Method | Returns | Description |
|--------|---------|-------------|
| `getRawMany()` | `Record<string, unknown>[]` | Untyped plain objects |
| `getRawOne()` | `Record<string, unknown> \| null` | Single untyped object or null |

Use when the result includes computed columns not in the entity (e.g. `addSelect(sql`COUNT(*)`, "cnt")`). No type information, no deserialization.

**Utility (unchanged):**

| Method | Returns | Description |
|--------|---------|-------------|
| `getCount()` | `number` | COUNT(*) with the same WHERE/JOIN |
| `exists()` | `boolean` | Whether any rows match |

**Which to use?** Default to `getMany()`. Use `getPartialMany()` for read-only DTOs where you want compile-time narrowing. Use `getRawMany()` for queries with `addSelect` or computed columns.

For debugging, `getSql()` returns the raw SQL and parameters without executing anything.

```typescript
const { text, values } = qb.getSql();
console.log(text);   // SELECT "u"."id", ... WHERE "u"."is_active" = ?
console.log(values);  // [true]
```

> **Hint** The `?` placeholders in `getSql()` output are for readability. The actual query uses driver-appropriate parameters (`$1`, `$2` for PostgreSQL, `?` for MySQL).

### Required Column Validation

`getMany()` validates that all non-nullable columns are included when `select()` is used. This prevents creating invalid class instances where required fields are `undefined`.

```typescript
@Entity()
class User {
  @PrimaryGeneratedColumn()         // autoIncrement — can omit
  id!: number;

  @Column({ type: "varchar" })      // non-nullable — REQUIRED
  name!: string;

  @Column({ nullable: true })       // nullable — can omit
  bio!: string | null;

  @Column({ default: "active" })    // has default — can omit
  status!: string;
}

// ✓ OK — "name" (the only required column) is included
await qb.select(["name"]).getMany();

// ✗ Throws OrmError MISSING_REQUIRED_COLUMNS — "name" is missing
await qb.select(["bio"]).getMany();

// ✓ Use getPartialMany() to skip validation
await qb.select(["bio"]).getPartialMany();  // OK — plain object
```

A column is considered **required** if all of these are true:
- `nullable` is not `true`
- No `default` value specified
- Not `autoIncrement` (e.g. `@PrimaryGeneratedColumn`)

### When to use each method

| Scenario | Method | Why |
|----------|--------|-----|
| Data you'll pass to `em.save()` | `getMany()` | Class instances with full lifecycle support |
| EntitySubscriber / lifecycle hooks | `getMany()` | Only class instances are matched by `listenTo()` |
| Read-only API response | `getPartialMany()` | Typed DTO, compile-time safety, lightweight |
| Aggregates / computed columns | `getRawMany()` | `addSelect(sql`COUNT(*)`, "cnt")` can't be typed as `Pick` |
| Quick existence check | `exists()` | Boolean — no data fetched |

Note that `em.find()` also supports a `select` option, but it does **not** narrow the return type — `find()` always returns `T[]` regardless. If type safety on projections matters, use the query builder's `getPartialMany()` method instead.

## Compiling Repeated Queries — `prepare()`

If the exact same builder shape runs many times with only the values changing, you can freeze the SQL once and reuse it:

```typescript
import { p } from "@stingerloom/orm";
import sql from "sql-template-tag";

const findById = em
  .createQueryBuilder(User, "u")
  .where(sql`u.id = ${p("id")}`)
  .prepare<{ id: number }>();

await findById.executeOne({ id: 42 });
await findById.executeOne({ id: 77 });   // SQL is not rebuilt
```

`preparePartial()` is the partial-projection counterpart, and `RawQueryBuilder` exposes the same `.prepare(em)` entry point. For the full rationale — when it helps, when it doesn't, and how it compares to `WriteBuffer` and batch writes — see [Compiled Query Plans](./entity-manager-advanced.md#compiled-query-plans-em-compile-qb-prepare).

## Practical Example — Filtered Search with Pagination

Here's a realistic example that brings everything together. A search endpoint that accepts optional filters and returns paginated results with a total count.

```typescript
import { qAlias } from "@stingerloom/orm";

async function searchPosts(filters: {
  authorName?: string;
  category?: string;
  minLikes?: number;
  page: number;
  pageSize: number;
}) {
  const p = qAlias(Post, "p");
  const u = qAlias(User, "u");

  const qb = em
    .createQueryBuilder(Post, "p")
    .select(["id", "title", "createdAt"])
    .leftJoin(User, "u", (join) =>
      join.on(p.col("authorId"), "=", u.col("id"))
    );

  // Each filter is optional — add conditions only when present
  if (filters.authorName) {
    qb.where(u.name.like(`%${filters.authorName}%`));
  }
  if (filters.category) {
    qb.andWhere(p.category.eq(filters.category));
  }
  if (filters.minLikes) {
    qb.andWhere(p.likeCount.gte(filters.minLikes));
  }

  const [posts, total] = await qb
    .orderBy({ createdAt: "DESC" })
    .skip(filters.page * filters.pageSize)
    .take(filters.pageSize)
    .getPartialManyAndCount();

  return { posts, total, page: filters.page, pageSize: filters.pageSize };
}
```

Notice how `qAlias()` makes the query builder read like natural language — `u.name.like(...)`, `p.category.eq(...)`. TypeScript auto-completes both the property name and the condition method, so typos become compile errors.

But we can do even better. With `when()`, the `if` blocks disappear entirely:

```typescript
const [posts, total] = await em
  .createQueryBuilder(Post, "p")
  .select(["id", "title", "createdAt"])
  .leftJoin(User, "u", (join) =>
    join.on(p.col("authorId"), "=", u.col("id"))
  )
  .when(!!filters.authorName, (qb) =>
    qb.where(u.name.like(`%${filters.authorName}%`))
  )
  .when(!!filters.category, (qb) =>
    qb.where(p.category.eq(filters.category))
  )
  .when(!!filters.minLikes, (qb) =>
    qb.where(p.likeCount.gte(filters.minLikes))
  )
  .orderBy({ createdAt: "DESC" })
  .skip(filters.page * filters.pageSize)
  .take(filters.pageSize)
  .getPartialManyAndCount();
```

See [Patterns & Productivity](./query-builder-patterns.md) for `when()`,
`pipe()`, scopes, and other productivity helpers.

## Next Steps

- [Patterns & Productivity](./query-builder-patterns.md) — `when`, `pipe`,
  scopes, `whereHas`, `withCount`
- [QueryDSL Expressions](./query-builder-querydsl.md) — typed condition
  and projection surface
- [Pagination & Streaming](./pagination.md) — cursor pagination, streaming
- [Query Builder Overview](./query-builder.md) — basics and overall map
