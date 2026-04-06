# Query Builder

`find()` and `findOne()` can handle most everyday queries — filtering by conditions, loading relations, pagination. But sometimes you need something more. Suppose you want to join two tables that don't have a direct relation, group rows by category and count them, or combine results from two different tables with UNION. These are the situations where the **query builder** comes in.

Stingerloom provides two query builders, and the choice is simple.

| Builder | When to use | How to create |
|---------|-------------|---------------|
| **SelectQueryBuilder** | You're querying an entity and want auto-complete on column names | `em.createQueryBuilder(User, "u")` |
| **RawQueryBuilder** | You need raw SQL control — UNION, CTE, window functions | `em.createQueryBuilder()` (no arguments) |

Most of the time, you'll use `SelectQueryBuilder`. Let's start there.

---

## SelectQueryBuilder — Type-Safe Queries

### Why a Query Builder at All?

Before diving in, it's worth asking: why not just use `find()` for everything?

The answer comes down to what `find()` can't express. `find()` gives you `WHERE field = value`, but it can't do `WHERE age >= 18`, or `JOIN` to unrelated tables, or `GROUP BY category HAVING COUNT(*) > 5`. For these, you need a query builder.

Stingerloom's query builder provides three execution methods with different safety guarantees:

**`getMany()`** — always returns **class instances**. `instanceof` works, class methods are available, results can be passed to `em.save()`. When `select()` is used, validates that all non-nullable columns are included.

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .where("isActive", true)
  .getMany();

users[0] instanceof User; // ✓ true — real class instance
await em.save(User, users[0]); // ✓ works correctly
```

**`getPartialMany()`** — returns **typed plain objects** with `Pick<T, K>` narrowing. Accessing unselected columns is a compile-time error. No required-column validation.

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name"])
  .getPartialMany();

users[0].id;    // ✓ number — exists in Pick<User, "id" | "name">
users[0].name;  // ✓ string — exists
users[0].email; // ✗ Compile error! Property 'email' does not exist
```

**`getRawMany()`** — returns **untyped plain objects** (`Record<string, unknown>`). Use for queries with computed columns like `addSelect(sql`COUNT(*)`, "cnt")`.

`where()` and `orderBy()` always accept any column from the full entity — because you can filter and sort by columns you don't SELECT. The type system tracks the **projection** (what you get back) separately from the **entity** (what you can query on).

### Your First Query Builder Query

Imagine you want to find active users sorted by registration date, but only their `id`, `name`, and `email` columns. With `find()`, you'd write:

```typescript
const users = await em.find(User, {
  select: ["id", "name", "email"],
  where: { isActive: true },
  orderBy: { createdAt: "DESC" },
  take: 10,
});
```

With the query builder, the same query looks like this:

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name", "email"])
  .where("isActive", true)
  .orderBy({ createdAt: "DESC" })
  .limit(10)
  .getPartialMany();
```

So far, there's no real advantage. The power of the query builder becomes clear when you need things that `find()` can't express — operators like `>=`, JOINs to unrelated tables, GROUP BY with aggregates, or pessimistic locking.

The `"u"` in `createQueryBuilder(User, "u")` is a **table alias**. It's the short name used to qualify columns in the generated SQL: `"u"."id"`, `"u"."name"`, etc. You'll see why aliases matter when we get to JOINs.

> **Hint** You can also create a query builder from a repository: `userRepo.createQueryBuilder("u")`. Both work the same way.

### WHERE — Filtering Rows

The `where()` method supports three styles, depending on the complexity of your condition.

**Equals** — the simplest form. Pass a column name and a value.

```typescript
qb.where("status", "active");
// WHERE "u"."status" = $1
```

**Operator** — when you need `>=`, `<`, `LIKE`, etc. Pass the operator as the second argument. The operator is type-checked — only valid SQL operators are accepted, so typos like `"LKIE"` become compile-time errors.

```typescript
qb.where("age", ">=", 18);
// WHERE "u"."age" >= $1

// Allowed operators:
// =, !=, <>, <, >, <=, >=, LIKE, NOT LIKE, ILIKE, IN, NOT IN,
// IS NULL, IS NOT NULL, BETWEEN
```

**Raw SQL** — for anything the ORM can't express. Pass a `sql` template literal directly.

```typescript
import sql from "sql-template-tag";

qb.where(sql`"u"."score" > ${90}`);
```

All three styles are type-safe — the column name (`"age"`, `"status"`) auto-completes from `keyof User`. A typo becomes a compile error.

### Combining Conditions — AND, OR

Chain multiple conditions with `andWhere()` and `orWhere()`.

```typescript
const qb = em.createQueryBuilder(User, "u");

const users = await qb
  .where("isActive", true)
  .andWhere("age", ">=", 18)
  .getMany();
// WHERE "u"."is_active" = $1 AND "u"."age" >= $2
```

`orWhere()` wraps the existing conditions in parentheses and adds an OR branch.

```typescript
qb.where("isActive", true)
  .andWhere("age", ">=", 18)
  .orWhere("role", "admin");
// WHERE ("u"."is_active" = $1 AND "u"."age" >= $2) OR "u"."role" = $3
```

This means: either (active AND 18+), or admin regardless of age.

### Common WHERE Helpers

Instead of writing raw SQL for common patterns, use the built-in helpers.

```typescript
// IN — match any value in the list
qb.whereIn("status", ["active", "pending"]);

// NOT IN — exclude these values
qb.whereNotIn("id", [1, 2, 3]);

// NULL checks
qb.whereNull("deletedAt");
qb.whereNotNull("email");

// BETWEEN — range check
qb.whereBetween("age", 18, 65);

// LIKE — pattern matching
qb.whereLike("name", "%alice%");
```

Each helper appends an AND condition to the existing WHERE clause. You can mix them freely with `where()` and `andWhere()`.

All WHERE methods also accept cross-entity references using `"alias.property"` notation — see [Cross-Entity Column Resolution](#cross-entity-column-resolution) in the JOIN section.

### JOIN — Combining Tables

This is where the query builder really shines. Stingerloom provides three levels of JOIN support, from fully automatic to raw SQL.

#### Entity-Aware Joins (Recommended)

The best way to join tables is by passing the **entity class** directly. The ORM automatically resolves the table name and lets you reference columns using camelCase property names.

```typescript
const posts = await em
  .createQueryBuilder(Post, "p")
  .leftJoin(User, "u", (join) =>
    join.on("p.authorId", "=", "u.id")
  )
  .selectRaw(["p.title", "u.name"])
  .where("u.age", ">=", 18)
  .orderBy({ createdAt: "DESC" })
  .limit(20)
  .getRawMany();
```

What's happening here:

- `leftJoin(User, "u", ...)` — the first argument is the **entity class**, not a table name string. The ORM resolves the actual table name (`user`) and registers the `"u"` alias in its internal registry.
- `join.on("p.authorId", "=", "u.id")` — the ON condition uses **camelCase property names** with alias prefix. If you're using `SnakeNamingStrategy`, `authorId` is automatically translated to `author_id` in the generated SQL.
- `selectRaw(["p.title", "u.name"])` — cross-entity column selection using `"alias.property"` notation.
- `where("u.age", ">=", 18)` — WHERE conditions can also reference joined entity columns.

The `JoinOnBuilder` callback supports multiple conditions and literal values:

```typescript
qb.leftJoin(User, "u", (join) =>
  join
    .on("p.authorId", "=", "u.id")       // column = column
    .andOn("u.status", "=", "p.status")   // additional condition
    .onVal("u.isActive", "=", true)       // column = literal value
);
```

#### Relation-Based Joins (Automatic ON)

If your entities have `@ManyToOne` / `@OneToMany` / `@OneToOne` decorators, you can skip the ON condition entirely. The ORM derives it from the relation metadata.

```typescript
// Post has: @ManyToOne(() => User) author: User;

const posts = await em
  .createQueryBuilder(Post, "p")
  .leftJoinRelation("author", "u")     // auto: ON p.author_id = u.id
  .where("u.name", "LIKE", "%John%")
  .getMany();
```

`leftJoinRelation(propertyName, alias)` reads the `@ManyToOne` metadata on `Post.author`, finds the FK column and the referenced PK, and builds the ON clause automatically.

This works in both directions:

```typescript
// User has: @OneToMany(() => Post, { mappedBy: "author" }) posts: Post[];

const users = await em
  .createQueryBuilder(User, "u")
  .leftJoinRelation("posts", "p")      // auto: ON u.id = p.author_id
  .where("p.status", "published")
  .getMany();
```

`innerJoinRelation()` is also available.

#### String-Based Joins (Raw)

For cases where you don't have entity metadata (joining a view, a subquery, or a raw table), you can still pass a string table name.

```typescript
qb.leftJoin("audit_log", "al", sql`"p"."id" = "al"."post_id"`);
```

This is the original API and remains fully supported.

#### Multi-Table Joins

Chain multiple joins to traverse a graph of entities:

```typescript
const results = await em
  .createQueryBuilder(Post, "p")
  .leftJoin(User, "u", (j) => j.on("p.authorId", "=", "u.id"))
  .leftJoin(Comment, "c", (j) => j.on("c.postId", "=", "p.id"))
  .selectRaw(["p.title", "u.name", "c.content"])
  .where("u.age", ">=", 18)
  .whereNotNull("c.content")
  .addOrderBy("u.name", "ASC")
  .limit(50)
  .getRawMany();
```

#### Cross-Entity Column Resolution

Once an entity is joined (via entity-aware or relation-based join), you can reference its columns anywhere using `"alias.property"` notation:

```typescript
// WHERE — all styles
qb.where("u.name", "Alice");                  // equals
qb.where("u.age", ">=", 18);                  // operator
qb.whereIn("u.id", [1, 2, 3]);               // IN
qb.whereNull("u.deletedAt");                  // IS NULL
qb.whereNotNull("u.email");                   // IS NOT NULL
qb.whereBetween("u.age", 18, 65);            // BETWEEN
qb.whereLike("u.name", "%alice%");            // LIKE

// SELECT — cross-entity projection
qb.selectRaw(["p.title", "u.name"]);          // pick columns from any joined entity
qb.addSelect("u.email", "authorEmail");        // add aliased column

// ORDER BY / GROUP BY
qb.addOrderBy("u.name", "ASC");
qb.groupBy(["u.id", "p.category"]);
```

All references are resolved through the alias registry — `"u.firstName"` becomes `"u"."first_name"` when using `SnakeNamingStrategy`.

#### Join Types Summary

| Method | SQL | When to use |
|--------|-----|-------------|
| `leftJoin()` | `LEFT JOIN` | Include rows even if the joined table has no match |
| `innerJoin()` | `INNER JOIN` | Only rows that have a match in both tables |
| `rightJoin()` | `RIGHT JOIN` | Include all rows from the joined table |
| `leftJoinRelation()` | `LEFT JOIN` | Auto ON from `@ManyToOne` / `@OneToMany` metadata |
| `innerJoinRelation()` | `INNER JOIN` | Auto ON from relation metadata |

### ORDER BY and Pagination

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

### GROUP BY and Aggregation

Suppose you want to count how many posts each category has. This requires GROUP BY.

```typescript
import sql from "sql-template-tag";

const stats = await em
  .createQueryBuilder(Post, "p")
  .select(["category"])
  .addSelect(sql`COUNT(*)`, "postCount")
  .groupBy(["category"])
  .having(sql`COUNT(*) >= ${5}`)
  .getRawMany();
// [{ category: "tech", postCount: 42 }, { category: "life", postCount: 17 }, ...]
```

`groupBy()` takes an array of column names (type-safe). `having()` filters groups after aggregation — here, only categories with 5 or more posts.

### DISTINCT

When you want unique rows only, enable DISTINCT.

```typescript
const uniqueCities = await em
  .createQueryBuilder(User, "u")
  .select(["city"])
  .setDistinct()
  .getPartialMany();
// SELECT DISTINCT "u"."city" FROM "user" AS "u"
```

This removes duplicate rows from the result set. Useful when selecting a subset of columns where many rows may share the same values.

### Pessimistic Locking

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

#### NOWAIT and SKIP LOCKED

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
NOWAIT and SKIP LOCKED require MySQL 8.0+ or PostgreSQL 9.5+. SQLite does not support pessimistic locking and throws `UNSUPPORTED_DATABASE`.
:::

### Index Hints

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

For PostgreSQL, use the `hint()` method to add [pg_hint_plan](https://pg-hint-plan.readthedocs.io/) style hints:

```typescript
const orders = await em
  .createQueryBuilder(Order, "o")
  .where("status", "pending")
  .hint("IndexScan(o idx_order_status)")
  .getMany();
// PostgreSQL: /*+ IndexScan(o idx_order_status) */ SELECT ...
```

### Soft Delete Handling

If your entity has a `@DeletedAt` column, the query builder automatically excludes soft-deleted rows. To include them:

```typescript
qb.withDeleted();
```

### Result Validation — validate()

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

#### Using Zod for Schema Validation

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

#### Array-Level Validation — validateArray()

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

#### Combining Row and Array Validation

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

#### When to Use Validation

Validation adds a per-row function call, so it's not free. Here's when it pays for itself:

| Scenario | Validate? | Why |
|----------|-----------|-----|
| Internal service, trusted schema | No | Speed is more important |
| API endpoint returning user data | Yes | Catch nulls/type mismatches before they reach the client |
| ETL pipeline with loose source data | Yes | Prevent bad data from propagating |
| Debugging a deserialization bug | Yes (temporarily) | Pinpoint exactly which row/field is wrong |

The default — no validator, zero overhead — is the right choice for most internal queries. Add validation at the boundaries where data crosses trust zones.

### Executing the Query

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

### Practical Example — Filtered Search with Pagination

Here's a realistic example that brings everything together. A search endpoint that accepts optional filters and returns paginated results with a total count.

```typescript
async function searchPosts(filters: {
  authorName?: string;
  category?: string;
  minLikes?: number;
  page: number;
  pageSize: number;
}) {
  const qb = em
    .createQueryBuilder(Post, "p")
    .select(["id", "title", "createdAt"])
    .leftJoin(User, "u", (join) =>
      join.on("p.authorId", "=", "u.id")
    );

  // Each filter is optional — add conditions only when present
  if (filters.authorName) {
    qb.where("u.name", "LIKE", `%${filters.authorName}%`);
  }
  if (filters.category) {
    qb.andWhere("category", filters.category);
  }
  if (filters.minLikes) {
    qb.andWhere("likeCount", ">=", filters.minLikes);
  }

  const [posts, total] = await qb
    .orderBy({ createdAt: "DESC" })
    .skip(filters.page * filters.pageSize)
    .take(filters.pageSize)
    .getPartialManyAndCount();

  return { posts, total, page: filters.page, pageSize: filters.pageSize };
}
```

Notice how the query builder lets you **conditionally build** the query. With `find()`, you'd have to construct the `where` object manually. With the query builder, you just call methods as needed.

---

## RawQueryBuilder — Full SQL Control

For advanced SQL features — UNION, CTE, window functions, subqueries — see the dedicated [Raw SQL & CTE](./raw-sql.md) guide.

Here's a quick preview:

```typescript
import sql from "sql-template-tag";

const qb = em.createQueryBuilder();

const query = qb
  .select(['"id"', '"name"', '"email"'])
  .from('"users"')
  .where([sql`"is_active" = ${true}`])
  .orderBy([{ column: '"created_at"', direction: "DESC" }])
  .limit(10)
  .build();

const users = await em.query(query);
```

RawQueryBuilder supports UNION / INTERSECT / EXCEPT, Common Table Expressions (CTE), recursive CTEs, window functions (ROW_NUMBER, RANK, LAG, etc.), and DISTINCT ON. See the [full guide](./raw-sql.md) for details.

---

## Choosing the Right Execution Method

The query builder provides three tiers of execution methods. Choose based on what you need from the result.

```typescript
const qb = em.createQueryBuilder(User, "u")
  .select(["id", "name"])
  .where("isActive", true);

// 1. Safe — class instances, validates required columns
const entities = await qb.getMany();         // T[] — instanceof User === true
await em.save(User, entities[0]);             // ✓ works

// 2. Partial — typed plain objects, no validation
const dtos = await qb.getPartialMany();       // Pick<User, "id" | "name">[]
dtos[0].email;                                // ✗ compile error
dtos[0] instanceof User;                      // false

// 3. Raw — untyped plain objects
const raw = await qb.getRawMany();            // Record<string, unknown>[]
```

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

---

## Choosing Between the Two Builders

| Question | SelectQueryBuilder | RawQueryBuilder |
|----------|-------------------|----------------|
| Are you querying a registered entity? | Yes | Not required |
| Do you want `keyof T` auto-complete? | Yes | No |
| Do you need UNION / INTERSECT / EXCEPT? | No | Yes |
| Do you need CTE (WITH / WITH RECURSIVE)? | No | Yes |
| Do you need window functions? | No | Yes |
| Returns class instances? | `getMany()` yes / `getPartialMany()` no | No — raw objects via `em.query()` |

In practice, start with `SelectQueryBuilder` for everyday queries. If you hit a wall — you need UNION, recursive hierarchy traversal, or window analytics — switch to `RawQueryBuilder` for that specific query.

## Next Steps

- [Raw SQL & CTE](./raw-sql.md) — UNION, CTE, window functions, DISTINCT ON
- [Pagination & Streaming](./pagination.md) — Offset, cursor, and streaming strategies
- [EntityManager](./entity-manager.md) — Basic CRUD with find(), save(), etc.
- [API Reference](./api-reference.md) — Quick reference for all method signatures
