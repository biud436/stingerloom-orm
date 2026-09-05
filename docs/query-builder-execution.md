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

Need both the data and the total count? `getManyAndCount()` runs the data query and then the count query (sequentially, so SQLite's single connection is safe) and returns `[T[], number]`.

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

### `paginate()` — page data plus metadata

`getManyAndCount()` hands back a bare `[rows, total]` tuple, leaving every
endpoint to compute `totalPages` / `hasNextPage` by hand. `paginate()` is the
query-builder counterpart to [`em.findWithPage()`](./pagination.md): pass a
1-based `page` and a `pageSize` and it returns the page together with the full
pagination envelope.

```typescript
const result = await em
  .createQueryBuilder(Post, "p")
  .leftJoin(User, "u", (j) => j.on("p.authorId", "=", "u.id"))
  .where("p.status", "published")
  .orderBy({ createdAt: "DESC" })
  .paginate({ page: 2, pageSize: 10 });

result.data;           // Post[] for page 2 (class instances)
result.total;          // total matching rows — ignores LIMIT/OFFSET
result.page;           // 2
result.pageSize;       // 10
result.totalPages;     // Math.ceil(total / pageSize)
result.hasNextPage;    // page < totalPages
result.hasPreviousPage;// page > 1
```

`page`/`pageSize` are normalized exactly like `findWithPage()` — non-positive or
fractional values are coerced (defaults: `page` 1, `pageSize` 20). Any
`limit`/`offset`/`skip`/`take` previously set on the builder is overridden by the
page window, and the source builder is **not** mutated — a clone carries the
LIMIT/OFFSET, so the same instance can be paged again or reused.

For projected list views, use `paginatePartial()` — it mirrors `paginate()` but
returns plain `Pick<T, K>` objects via `getPartialMany()`, so a partial
`select()` that omits required columns is allowed (whereas `paginate()`, built on
`getMany()`, would reject it):

```typescript
const page = await em
  .createQueryBuilder(Post, "p")
  .select(["id", "title"])
  .orderBy({ id: "DESC" })
  .paginatePartial({ page: 1, pageSize: 20 });

page.data; // Pick<Post, "id" | "title">[] — plain objects, not entities
```

> For cursor-based pagination, streaming, and the full pagination
> strategy guide, see [Pagination & Streaming](./pagination.md).

### `getCursor()` — cursor (keyset) pagination on the builder

`getCursor()` is the query-builder counterpart to [`em.findWithCursor()`](./pagination.md#cursor-based-pagination). It applies keyset pagination to the query already assembled on the builder -- WHERE clauses, JOINs, soft-delete filtering, and tenant scoping all carry through -- and returns a `CursorPaginationResult`.

```typescript
interface CursorPaginationOption<T> {
  take?:      number;               // Page size (default: 20)
  cursor?:    string;               // Opaque cursor from the previous page (omit for first page)
  orderBy?:   keyof T & string;     // Sort column — entity property name (default: entity PK)
  direction?: "ASC" | "DESC";       // Sort direction (default: "ASC")
}

interface CursorPaginationResult<T> {
  data:        T[];
  hasNextPage: boolean;
  nextCursor:  string | null;  // Base64-encoded; null when hasNextPage is false
  count:       number;         // Items on the current page (not the total)
}
```

**Basic example — first and subsequent pages:**

```typescript
// First page
const first = await em
  .createQueryBuilder(Post, "p")
  .where("p.status", "published")
  .getCursor({ take: 20, orderBy: "id", direction: "ASC" });

first.data;        // Post[] — up to 20 rows
first.hasNextPage; // true when a 21st row was found
first.nextCursor;  // opaque Base64 string to pass on the next call
first.count;       // items returned on this page (at most 20)

// Next page — pass the cursor back, same builder otherwise
if (first.hasNextPage) {
  const second = await em
    .createQueryBuilder(Post, "p")
    .where("p.status", "published")
    .getCursor({ take: 20, cursor: first.nextCursor! });
}
```

**Loop until all pages are consumed:**

```typescript
let cursor: string | undefined;

do {
  const page = await em
    .createQueryBuilder(Post, "p")
    .where("p.status", "published")
    .orderBy({ createdAt: "DESC" })
    .getCursor({ take: 50, cursor, orderBy: "id" });

  await process(page.data);
  cursor = page.nextCursor ?? undefined;
} while (page.hasNextPage);
```

**Key behaviors:**

- **Side-effect-free** -- `getCursor()` operates on an internal clone of the builder. The original instance is not mutated and can be reused or paged again.
- **Keyset predicate ANDed in** -- the cursor value is appended as `AND <col> > ?` (ASC) or `AND <col> < ?` (DESC) via the same `andWhere()` path as the rest of the builder's clauses. NULL rows not yet visited are included.
- **Single sort column** -- `orderBy` must be one entity property name. Any `orderBy()` already on the builder acts as a secondary tiebreaker.
- **NULL-safe** -- keyset conditions use `OR col IS NULL` for the first unvisited page when the sort column is nullable, matching `findWithCursor()` behavior.
- **Invalid cursor throws** -- a non-null cursor string that cannot be decoded throws `InvalidQueryError`. Always use the `nextCursor` value returned by a previous `getCursor()` call unchanged.
- **`orderBy` defaults to the entity PK** -- when omitted, `getCursor()` resolves the entity's primary key column automatically, matching `findWithCursor()`.

> Prefer `getCursor()` over `paginate()` for large tables or real-time feeds where offset-based pagination slows down at depth. Use `paginate()` when the user needs random page access or a total count.

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

### `getCount()` with GROUP BY counts groups

A grouped query returns one row per group, so `getCount()` returns the **number of groups** that survive `HAVING` — the same rule `findAndCount()` / `findWithPage()` apply to `FindOption.groupBy`. That keeps the `total` of `getManyAndCount()`, `getPartialManyAndCount()`, `paginate()` and `paginatePartial()` consistent with the grouped rows they accompany.

```typescript
const groups = await em
  .createQueryBuilder(Order, "o")
  .groupBy(["status"])
  .having(sql`COUNT(*) >= ${2}`)
  .getCount();
// SELECT COUNT(*) AS "count"
// FROM (SELECT 1 FROM "order" AS "o" GROUP BY "o"."status" HAVING COUNT(*) >= $1) AS "grouped_src"
```

If you need the size of each group rather than how many groups there are, project the aggregate explicitly and read the rows:

```typescript
const o = qAlias(Order, "o");
const sizes = await em
  .createQueryBuilder(Order, "o")
  .select(["status"])
  .addSelect(o.id.count().as("cnt"))
  .groupBy(["status"])
  .getRawMany();
// [{ status: "paid", cnt: 5 }, { status: "pending", cnt: 1 }, ...]
```

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
| `getManyAndCount()` | `[T[], number]` | Class instances + total count (two sequential queries) |
| `paginate(opts?)` | `PagePaginationResult<T>` | One offset page (class instances) + pagination metadata |
| `getMap(keyColumn)` | `Map<T[K], TResult>` | Run `getMany()` and index results into a `Map` keyed by `keyColumn`; last row wins on duplicate keys |
| `pluck(column)` | `T[K][]` | Run `getMany()` and return a flat array of one column's values; row order preserved |

Both `getMap()` and `pluck()` are thin terminals over `getMany()` — they run exactly one query, respecting every WHERE / JOIN / ORDER BY / LIMIT / soft-delete / tenant-scope clause already on the builder.

```typescript
// getMap — O(1) lookup by a column
const byId = await em
  .createQueryBuilder(User, "u")
  .where("isActive", true)
  .getMap("id");

byId.get(5);        // the active User with id 5, or undefined
byId.has(99);       // false if no active user has id 99

// pluck — flat array of one column's values
const emails = await em
  .createQueryBuilder(User, "u")
  .where("isActive", true)
  .orderBy({ createdAt: "ASC" })
  .pluck("email");
// -> ["alice@example.com", "bob@example.com", ...]
```

These always deserialize rows into entity class instances. `instanceof` works, class methods are available, results can be passed to `em.save()`. When `select()` is used with specific columns, non-nullable columns must be included — otherwise an `OrmError` is thrown.

**Partial — typed plain objects (Pick):**

| Method | Returns | Description |
|--------|---------|-------------|
| `getPartialMany()` | `TResult[]` | Plain objects with `Pick<T, K>` narrowing |
| `getPartialOne()` | `TResult \| null` | Single plain object or null |
| `getPartialManyAndCount()` | `[TResult[], number]` | Plain objects + total count |
| `paginatePartial(opts?)` | `PagePaginationResult<TResult>` | One offset page (plain objects) + pagination metadata |

No deserialization, no required-column validation. When `select(["id", "name"])` is used, the return type narrows to `Pick<T, "id" | "name">[]` — accessing unselected columns is a compile error. Do not pass results to `em.save()`.

**Raw — plain objects with optional value coercion:**

| Method | Returns | Description |
|--------|---------|-------------|
| `getRawMany<T>(options?)` | `T[]` | Plain objects (`Record<string, unknown>` when no type parameter) |
| `getRawOne<T>(options?)` | `T \| null` | Single plain object or null |

Use when the result includes computed columns not in the entity (e.g. `addSelect(sql`COUNT(*)`, "cnt")`). No deserialization.

#### Value coercion — `coerce`

Drivers surface raw results in dialect-dependent shapes: `mysql2` returns `BIGINT` / `DECIMAL` (and `SUM` / `AVG` aggregates) as strings, `pg` returns `NUMERIC` / `bigint` as strings, and dates arrive as `Date` or string depending on driver options. The `coerce` option declares the intended primitive per column so the ORM normalizes the value — no hand-written `Number(row.x)` blocks at the call site.

```typescript
const rows = await qb
  .select([day.as("day"), completed.as("completedCount"), est.as("estimate")])
  .getRawMany<{ day: Date; completedCount: number; estimate: number }>({
    coerce: { day: "date", completedCount: "number", estimate: "number" },
  });
// rows[0].completedCount is a real number, rows[0].day is a real Date
```

Supported type tags: `"number"`, `"bigint"`, `"string"`, `"date"`, `"json"`, `"boolean"`. `null` / `undefined` pass through untouched, and columns not listed in `coerce` keep the driver's native value. `getRawOne()` accepts the same option.

**Utility — aggregates and inspection:**

| Method | Returns | Description |
|--------|---------|-------------|
| `getCount()` | `number` | `COUNT(*)` with the same WHERE/JOIN; ignores LIMIT/OFFSET |
| `exists()` | `boolean` | Whether any rows match (uses `SELECT 1 ... LIMIT 1`) |
| `getExists()` | `boolean` | Alias of `exists()` — consistent with the other `get*` terminals |
| `getSum(column)` | `number` | `SUM(column)` over the same scope; 0 on empty |
| `getAvg(column)` | `number` | `AVG(column)` over the same scope; 0 on empty |
| `getMin(column)` | `number` | `MIN(column)` over the same scope; 0 on empty |
| `getMax(column)` | `number` | `MAX(column)` over the same scope; 0 on empty |
| `explain()` | `ExplainResult` | Query plan for the built SELECT (MySQL / PostgreSQL only) |

All aggregate terminals (`getSum`, `getAvg`, `getMin`, `getMax`, `getCount`) rebuild the SELECT clause from scratch, so `addSelect()` projections are ignored — only the WHERE / JOIN / soft-delete / tenant scope carry over. `getCount()` additionally honors GROUP BY / HAVING and then returns the number of groups (see [above](#getcount-with-group-by-counts-groups)); the scalar aggregates ignore GROUP BY / HAVING because they return a single value.

`explain()` mirrors `EntityManager.explain()` — it prefixes the built SQL with the driver's `EXPLAIN` syntax and returns the same `ExplainResult` shape (`rows`, `type`, `possibleKeys`, `key`, `cost`). Throws `InvalidQueryError` when called against SQLite, which does not support `EXPLAIN`.

```typescript
// Existence check — get* style
const hasExpired = await em
  .createQueryBuilder(Session, "s")
  .where("expiresAt", { lt: new Date() })
  .getExists();  // same as .exists()

// Query plan
const plan = await em
  .createQueryBuilder(Order, "o")
  .where("status", "pending")
  .explain();
console.log(plan.rows);      // estimated rows
console.log(plan.key);       // index chosen
```

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
