# EntityManager — Querying & Pagination

This page covers everything related to **reading data** through EntityManager: column selection, ordering, filtering, pagination strategies, aggregation, and query analysis.

For basic CRUD, see [CRUD Basics](./entity-manager.md). For writes and transactions, see [Writes & Transactions](./entity-manager-writes.md).

---

## How Queries Work in Stingerloom

Before diving into each feature, it helps to understand what happens when you call `em.find()`.

An ORM exists to solve one problem: **you think in objects, but the database thinks in tables.** Every time you write `em.find(User, { where: { name: "Alice" } })`, the ORM translates your object-oriented request into raw SQL, sends it to the database, and converts the rows back into TypeScript objects.

Here's the full lifecycle:

```
Your code                    ORM internals                    Database
─────────                    ─────────────                    ────────
em.find(User, {        →     Build SQL string           →     SELECT "id", "name", "email"
  where: { name: "Alice" }   using sql-template-tag           FROM "user"
})                           (all values parameterized)       WHERE "name" = $1
                                                              ── parameters: ['Alice']

                       ←     Deserialize rows            ←    Returns rows:
User[] objects               into User class instances         [{ id: 1, name: 'Alice', ... }]
```

Two things to notice:

1. **Values are never concatenated into SQL.** The string `"Alice"` becomes a parameter placeholder (`$1` on PostgreSQL, `?` on MySQL). This is how the ORM prevents SQL injection — the database itself separates "code" from "data".

2. **Identifiers (table/column names) are escaped per dialect.** PostgreSQL uses double quotes (`"user"`), MySQL uses backticks (`` `user` ``). You never need to think about this — the ORM handles it automatically based on your database driver.

Every feature described below is just a different way to control what SQL gets generated. We'll show you the exact SQL for every example so there are no surprises.

---

## SELECT Specific Columns

By default, `find()` and `findOne()` fetch every column — the equivalent of `SELECT *`. This is convenient but wasteful when you only need a few fields. Imagine a `User` table with 20 columns, but your API only returns `id` and `name`. You'd be moving 18 unnecessary columns across the network for every row.

The `select` option tells the ORM exactly which columns to fetch.

### Array style

```typescript
const users = await em.find(User, {
  select: ["id", "name", "email"],
});
```

Generated SQL (PostgreSQL):
```sql
SELECT "id", "name", "email" FROM "user"
```

Generated SQL (MySQL):
```sql
SELECT `id`, `name`, `email` FROM `user`
```

### Object style

```typescript
const users = await em.find(User, {
  select: { id: true, name: true, email: true },
});
```

This produces the exact same SQL. Some people find the object style more readable when selecting many columns. Use whichever you prefer — the query is identical.

### What about unselected columns?

The returned objects still have the full `User` TypeScript type, but unselected properties will be `undefined` at runtime. This means TypeScript won't warn you if you access `user.password` — it just silently returns `undefined`. If you need compile-time safety for partial selections, use the [SelectQueryBuilder](./query-builder.md) which narrows the return type to only the columns you selected.

---

## Ordering — orderBy

Without `orderBy`, the database returns rows in **no guaranteed order**. Most databases happen to return rows in insertion order, which tricks people into thinking it's reliable — until one day, after a table rebuild or a parallel query, the order changes. Always specify `orderBy` when order matters.

### Single column

```typescript
const users = await em.find(User, {
  orderBy: { createdAt: "DESC" },
});
```

```sql
SELECT * FROM "user"
ORDER BY "createdAt" DESC
```

`DESC` means newest first (descending). `ASC` means oldest first (ascending).

### Multiple columns

```typescript
const users = await em.find(User, {
  orderBy: { role: "ASC", name: "ASC" },
});
```

```sql
SELECT * FROM "user"
ORDER BY "role" ASC, "name" ASC
```

The database sorts by the **first key first**, then breaks ties with the second. So all `"admin"` users are grouped together, and within that group, they're sorted alphabetically by name.

### Why entity property names, not column names?

You write `orderBy: { createdAt: "DESC" }` even if the actual database column is named `created_at`. The ORM maps property names to column names automatically, using the same `@Column({ name: "created_at" })` metadata from your entity definition. This keeps your application code decoupled from the database schema.

---

## DISTINCT

Sometimes a query returns duplicate rows and you want only unique ones. `DISTINCT` tells the database to deduplicate before returning results.

```typescript
const uniqueCities = await em.find(User, {
  select: ["city"],
  distinct: true,
});
```

```sql
SELECT DISTINCT "city" FROM "user"
```

If your `user` table has 1000 rows but only 15 different cities, this returns 15 rows instead of 1000.

### Multi-column DISTINCT

`DISTINCT` applies to the **entire row**, not a single column. When you select multiple columns, rows are deduplicated only when *all* selected columns match:

```typescript
const combos = await em.find(Product, {
  select: ["category", "status"],
  distinct: true,
});
```

```sql
SELECT DISTINCT "category", "status" FROM "product"
```

This returns unique `(category, status)` pairs. So `("electronics", "active")` and `("electronics", "archived")` are both included — they differ in `status`, so they're considered distinct.

For column-level deduplication (e.g., PostgreSQL's `DISTINCT ON`), use the [Query Builder](./query-builder.md).

---

## WHERE Filters

This is the most important section of this page. Almost every query you write will have a `where` clause, and Stingerloom provides a rich set of operators to express conditions without writing raw SQL.

### The basic idea

A `where` object is a set of rules: "I want rows where **this column** has **this value**." The simplest form is exact equality:

```typescript
const users = await em.find(User, {
  where: { name: "Alice" },
});
```

```sql
SELECT * FROM "user"
WHERE "name" = $1
-- parameters: ['Alice']
```

When you add multiple fields, they're combined with `AND` — **all** conditions must be true:

```typescript
const users = await em.find(User, {
  where: { name: "Alice", status: "active" },
});
```

```sql
SELECT * FROM "user"
WHERE "name" = $1 AND "status" = $2
-- parameters: ['Alice', 'active']
```

This is the foundation. Everything else below builds on it.

### Shorthand: findBy / findOneBy

When all you need is a `where` — no `select`, `orderBy`, `relations`, or pagination — the `{ where: ... }` wrapper is pure ceremony. `findBy` and `findOneBy` take the filter directly, mirroring the filter-first shape of `delete` and `update`:

```typescript
// these two are equivalent
const a = await em.find(User, { where: { status: "active" } });
const b = await em.findBy(User, { status: "active" });

// single record
const user = await em.findOneBy(User, { id: 1 });
```

They delegate to `find` / `findOne`, so the where object accepts the exact same operators (and an array means `OR`). Reach for the full `find` / `findOne` form the moment you need anything beyond the filter.

### Comparison Operators

Equality isn't always enough. "Find users older than 18" needs a `>` comparison. Instead of passing a plain value, pass an **operator object**:

```typescript
const users = await em.find(User, {
  where: {
    age: { gt: 18 },
  },
});
```

```sql
SELECT * FROM "user"
WHERE "age" > $1
-- parameters: [18]
```

Here's the full set of comparison operators:

| Operator | SQL | Example | Generated WHERE |
|----------|-----|---------|----------------|
| `eq` | `=` | `{ age: { eq: 25 } }` | `"age" = 25` |
| `ne` | `!=` | `{ status: { ne: "deleted" } }` | `"status" != 'deleted'` |
| `gt` | `>` | `{ age: { gt: 18 } }` | `"age" > 18` |
| `gte` | `>=` | `{ score: { gte: 60 } }` | `"score" >= 60` |
| `lt` | `<` | `{ age: { lt: 65 } }` | `"age" < 65` |
| `lte` | `<=` | `{ age: { lte: 100 } }` | `"age" <= 100` |

Note: `{ age: 25 }` (plain value) and `{ age: { eq: 25 } }` produce the same SQL. Use `eq` explicitly when you want to be consistent with other operators.

### Combining multiple operators on one field

You can put multiple operators on the same field. They're AND-combined:

```typescript
const users = await em.find(User, {
  where: {
    age: { gt: 18, lte: 65 },
  },
});
```

```sql
SELECT * FROM "user"
WHERE "age" > $1 AND "age" <= $2
-- parameters: [18, 65]
```

This is a range query: "age is greater than 18 **and** at most 65." Each operator generates its own condition, and they're joined with AND.

### Set Operators — in, notIn, between

Sometimes you need to check against a list of values, or define a range.

**IN — "is the value one of these?"**

```typescript
const users = await em.find(User, {
  where: {
    role: { in: ["admin", "editor"] },
  },
});
```

```sql
SELECT * FROM "user"
WHERE "role" IN ($1, $2)
-- parameters: ['admin', 'editor']
```

This is equivalent to `role = 'admin' OR role = 'editor'`, but more concise and faster for the database to optimize.

**NOT IN — "is the value none of these?"**

```typescript
const users = await em.find(User, {
  where: {
    status: { notIn: ["banned", "deleted"] },
  },
});
```

```sql
SELECT * FROM "user"
WHERE "status" NOT IN ($1, $2)
-- parameters: ['banned', 'deleted']
```

**BETWEEN — "is the value within this range?"**

```typescript
const users = await em.find(User, {
  where: {
    score: { between: [60, 100] },
  },
});
```

```sql
SELECT * FROM "user"
WHERE "score" BETWEEN $1 AND $2
-- parameters: [60, 100]
```

`BETWEEN` is inclusive on both ends: 60 and 100 both match. It's equivalent to `score >= 60 AND score <= 100`.

### Shorthand: passing an array as a plain value

There's a convenient shorthand for `IN`. If you pass an array directly as the value (without wrapping it in `{ in: [...] }`), the ORM treats it as an IN clause:

```typescript
const users = await em.find(User, {
  where: { id: [1, 2, 3] },
});
```

```sql
SELECT * FROM "user"
WHERE "id" IN ($1, $2, $3)
-- parameters: [1, 2, 3]
```

This is backward-compatible syntax that existed before operator objects were added.

### String Operators — searching within text

SQL's `LIKE` operator lets you match patterns within strings. The `%` wildcard means "any sequence of characters" and `_` means "any single character." Stingerloom provides two levels of abstraction:

**Low-level: `like` and `notLike`**

You write the full pattern yourself, including wildcards:

```typescript
const users = await em.find(User, {
  where: {
    name: { like: "%alice%" },
  },
});
```

```sql
SELECT * FROM "user"
WHERE "name" LIKE $1
-- parameters: ['%alice%']
```

This matches "alice", "Alice in Wonderland", "malice" — anything containing "alice". The `%` on both sides means "anything can come before or after."

```typescript
const users = await em.find(User, {
  where: {
    bio: { notLike: "%spam%" },
  },
});
```

```sql
SELECT * FROM "user"
WHERE "bio" NOT LIKE $1
-- parameters: ['%spam%']
```

**High-level: `contains`, `startsWith`, `endsWith`**

These are safer and more convenient — the ORM adds the `%` wildcards for you **and escapes any `%` or `_` in your search term**:

```typescript
const users = await em.find(User, {
  where: {
    email: { contains: "gmail" },
    username: { startsWith: "admin" },
    domain: { endsWith: ".com" },
  },
});
```

```sql
SELECT * FROM "user"
WHERE "email" LIKE $1 AND "username" LIKE $2 AND "domain" LIKE $3
-- parameters: ['%gmail%', 'admin%', '%.com']
```

Why does the escaping matter? Suppose a user searches for "50%". With raw `like`, `{ like: "%50%%" }` would be ambiguous — is the third `%` a wildcard or the literal character? With `contains`, you just write `{ contains: "50%" }` and the ORM escapes it to `%50\%%`, matching the literal string "50%".

**Case-insensitive search (PostgreSQL only): `ilike`**

```typescript
const users = await em.find(User, {
  where: {
    name: { ilike: "%alice%" },
  },
});
```

```sql
SELECT * FROM "user"
WHERE "name" ILIKE $1
-- parameters: ['%alice%']
```

`ILIKE` is a PostgreSQL extension that matches regardless of case — "Alice", "ALICE", and "alice" all match. MySQL's `LIKE` is case-insensitive by default (depending on collation), so `ilike` is only needed on PostgreSQL.

### NULL Operators

In SQL, `NULL` is special — it's not a value, it's the **absence** of a value. You can't compare it with `=`. Writing `WHERE deleted_at = NULL` returns **zero rows** in SQL. You must use `IS NULL` instead.

Stingerloom handles this for you. There are two ways to check for NULL:

```typescript
// Shorthand — just pass null directly
const users = await em.find(User, {
  where: { deletedAt: null },
});

// Explicit — use the isNull operator
const users = await em.find(User, {
  where: { deletedAt: { isNull: true } },
});
```

Both generate:
```sql
SELECT * FROM "user"
WHERE "deletedAt" IS NULL
```

To find rows where a column **is not** null:

```typescript
const users = await em.find(User, {
  where: { bio: { isNull: false } },
});
```

```sql
SELECT * FROM "user"
WHERE "bio" IS NOT NULL
```

### NOT Operator

`not` negates a single condition. It works with plain values and with nested operator objects:

```typescript
const users = await em.find(User, {
  where: {
    role: { not: "admin" },    // simple negation
  },
});
```

```sql
SELECT * FROM "user"
WHERE "role" != $1
-- parameters: ['admin']
```

```typescript
const users = await em.find(User, {
  where: {
    bio: { not: null },        // IS NOT NULL
  },
});
```

```sql
SELECT * FROM "user"
WHERE "bio" IS NOT NULL
```

```typescript
const users = await em.find(User, {
  where: {
    age: { not: { gt: 65 } },  // negate a nested filter
  },
});
```

```sql
SELECT * FROM "user"
WHERE NOT ("age" > $1)
-- parameters: [65]
```

### Logical Combinators — OR, AND, NOT

By default, every field in a `where` object is AND-combined. But what if you need OR logic? "Find users who are admins **or** have a score above 90."

**OR**

```typescript
const users = await em.find(User, {
  where: {
    OR: [
      { role: "admin" },
      { score: { gte: 90 } },
    ],
  },
});
```

```sql
SELECT * FROM "user"
WHERE ("role" = $1) OR ("score" >= $2)
-- parameters: ['admin', 90]
```

Each element in the `OR` array is a complete where object. Within each object, conditions are AND-combined. Between objects, they're OR-combined.

**AND (explicit)**

You rarely need `AND` explicitly since multiple fields are already AND-combined. But it's useful when you want to AND-combine the same field with different complex conditions:

```typescript
const users = await em.find(User, {
  where: {
    status: "active",
    AND: [
      { age: { gte: 18 } },
      { age: { lte: 65 } },
    ],
  },
});
```

```sql
SELECT * FROM "user"
WHERE "status" = $1 AND ("age" >= $2) AND ("age" <= $3)
-- parameters: ['active', 18, 65]
```

**NOT (top-level negation)**

`NOT` negates an entire group of conditions:

```typescript
const users = await em.find(User, {
  where: {
    status: "active",
    NOT: { role: "banned" },
  },
});
```

```sql
SELECT * FROM "user"
WHERE "status" = $1 AND NOT ("role" = $2)
-- parameters: ['active', 'banned']
```

**Combining all three:**

```typescript
const users = await em.find(User, {
  where: {
    status: "active",
    NOT: { role: "banned" },
    OR: [
      { age: { gte: 18 } },
      { isVerified: true },
    ],
  },
});
```

```sql
SELECT * FROM "user"
WHERE "status" = $1 AND NOT ("role" = $2) AND (("age" >= $3) OR ("isVerified" = $4))
-- parameters: ['active', 'banned', 18, true]
```

### Array WHERE — OR shorthand

There's one more way to express OR: pass an **array** of where objects instead of a single object:

```typescript
const users = await em.find(User, {
  where: [
    { name: "Alice", status: "active" },
    { age: { gt: 30 }, role: "admin" },
  ],
});
```

```sql
SELECT * FROM "user"
WHERE ("name" = $1 AND "status" = $2) OR ("age" > $3 AND "role" = $4)
-- parameters: ['Alice', 'active', 30, 'admin']
```

Each array element is an AND group. The groups are OR-combined. Think of it as: "match group 1 **or** group 2."

This is functionally identical to using the `OR` key, but some people find the array syntax more readable for simple cases.

### Type Safety

Stingerloom's where filters are type-checked at compile time. The TypeScript compiler knows the type of each entity field and only allows operators that make sense:

```typescript
// ✓ OK — age is a number, gt accepts a number
where: { age: { gt: 18 } }

// ✗ Compile error — age is a number, "contains" is for strings only
where: { age: { contains: "18" } }

// ✗ Compile error — gt expects a number, not a string
where: { age: { gt: "eighteen" } }

// ✓ OK — name is a string, startsWith is available
where: { name: { startsWith: "A" } }

// ✗ Compile error — "xyz" is not a valid property of User
where: { xyz: "anything" }
```

This catches many bugs at compile time rather than at runtime. If you're using an IDE with TypeScript support, you'll get autocompletion for both field names and available operators.

### Backward Compatibility

If you have existing code that uses the old `where` syntax, it continues to work unchanged:

```typescript
// Plain equality — unchanged
em.find(User, { where: { name: "Alice" } })

// Array → IN — unchanged
em.find(User, { where: { id: [1, 2, 3] } })

// Raw Sql objects — unchanged
em.find(User, { where: { age: Conditions.gt("`age`", 18) } })
```

The operator object syntax is purely additive — no breaking changes.

---

## Full-Text Search

### The problem with LIKE

Suppose you're building a blog search feature. Your first instinct is to use `LIKE '%typescript%'` to find posts containing "typescript". This works, but it has a fundamental performance problem: `LIKE '%...'` with a leading wildcard **cannot use indexes**. The database must scan every single row, read every character of every text column, and check if the pattern matches. On a table with 100,000 posts, this means reading 100,000 rows for every search query.

Full-text search solves this by building a **specialized index** that understands language. Think of it like the index at the back of a textbook -- instead of reading every page to find "TypeScript", you look it up in the index and jump directly to the right pages. The database does the same thing: it pre-processes your text into searchable tokens (handling stemming, stop words, and ranking) and stores them in an index structure that allows near-instant lookups.

- **PostgreSQL** uses `tsvector` (the indexed document) and `tsquery` (your search) with **GIN indexes**.
- **MySQL** uses `FULLTEXT` indexes with `MATCH ... AGAINST`.

### Step 1: Declare the index on your entity

The `@FullTextIndex` decorator tells the ORM which columns to index for full-text search. Place it on the entity class, before `@Entity()`:

```typescript
import { Entity, Column, PrimaryGeneratedColumn } from "@stingerloom/orm";
import { FullTextIndex } from "@stingerloom/orm";

@FullTextIndex(["title", "content"], { language: "english" })
@Entity()
class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 200 })
  title!: string;

  @Column({ type: "text" })
  content!: string;
}
```

The decorator accepts two arguments:

| Parameter | Type | Description |
|-----------|------|-------------|
| `columns` | `string[]` | Column names to include in the full-text index |
| `options.language` | `string` | PostgreSQL text search configuration (default: `"english"`) |
| `options.name` | `string` | Custom index name (default: `fts_{table}_{columns}`) |

When `syncSchema` or `migrate:generate` runs, this generates dialect-specific DDL.

**PostgreSQL** -- creates a GIN index on a `tsvector` expression:

```sql
CREATE INDEX IF NOT EXISTS "fts_post_title_content"
  ON "post" USING gin (to_tsvector('english', "title" || ' ' || "content"))
```

**MySQL** -- creates a FULLTEXT index:

```sql
CREATE FULLTEXT INDEX `fts_post_title_content` ON `post` (`title`, `content`)
```

**SQLite** -- full-text indexes are not supported. The decorator is silently ignored.

### Step 2: Query with the `search` operator

Once the index exists, use the `search` operator in your `where` clause. This is a string-specific filter, just like `contains` or `startsWith`:

```typescript
const results = await em.find(Post, {
  where: {
    title: { search: "typescript orm" },
  },
});
```

The ORM generates different SQL depending on the database driver.

**PostgreSQL:**

```sql
SELECT * FROM "post"
WHERE to_tsvector('english', "title") @@ plainto_tsquery('english', $1)
-- parameters: ['typescript orm']
```

The `@@` operator checks whether the document vector matches the query. `plainto_tsquery` splits your search string into individual terms and combines them with AND -- so `"typescript orm"` matches posts that contain both "typescript" and "orm" (in any order, with stemming applied).

**MySQL:**

```sql
SELECT * FROM `post`
WHERE MATCH(`title`) AGAINST(? IN BOOLEAN MODE)
-- parameters: ['typescript orm']
```

`BOOLEAN MODE` allows operators like `+required -excluded "exact phrase"`. By default, terms are optional and results are ranked by relevance.

### Combining search with other filters

`search` is just another where operator. You can combine it with any other filter:

```typescript
const results = await em.find(Post, {
  where: {
    title: { search: "typescript" },
    isPublished: true,
  },
  orderBy: { createdAt: "DESC" },
  take: 20,
});
```

```sql
-- PostgreSQL
SELECT * FROM "post"
WHERE to_tsvector('english', "title") @@ plainto_tsquery('english', $1)
  AND "isPublished" = $2
ORDER BY "createdAt" DESC
LIMIT 20
-- parameters: ['typescript', true]
```

### Multi-column indexes

When you specify multiple columns in `@FullTextIndex(["title", "content"])`, the generated index covers both columns. On PostgreSQL, the columns are concatenated with a space separator in the `to_tsvector` expression, so a search matches across both title and content simultaneously.

However, the `search` operator in `where` applies to a **single column** at the query level. If you need to search across the combined index, use the `Conditions.fullTextSearch` helper directly:

```typescript
import { Conditions } from "@stingerloom/orm";

const results = await em.find(Post, {
  where: {
    title: Conditions.fullTextSearch(
      '"title" || \' \' || "content"',
      "typescript orm",
      "postgres",
      "english",
    ),
  },
});
```

---

## Including Soft-Deleted Records

If your entity has a `@DeletedAt` column, the ORM **automatically** adds a `WHERE "deletedAt" IS NULL` filter to every query. This means "deleted" records are invisible by default — they're still in the database, but your application pretends they don't exist.

```typescript
// Only non-deleted posts (the ORM adds the filter automatically)
const posts = await em.find(Post);
```

```sql
SELECT * FROM "post"
WHERE "deletedAt" IS NULL
```

To include soft-deleted records — for example, in an admin panel or a "trash" view — set `withDeleted: true`:

```typescript
const allPosts = await em.find(Post, {
  withDeleted: true,
});
```

```sql
SELECT * FROM "post"
-- no deletedAt filter added
```

This works with `find()`, `findOne()`, `findAndCount()`, `findWithCursor()`, `findWithPage()`, and `stream()`.

---

## Pessimistic Locking — lock

### The problem

Imagine two users simultaneously try to buy the last item in stock. Both read `stock = 1`, both subtract 1, both save `stock = 0`. The store just sold one item to two people.

This is a **race condition**, and the database-level solution is **pessimistic locking**: when you read a row, you tell the database "lock this row — nobody else can read or write it until I'm done."

### How to use it

```typescript
import { LockMode } from "@stingerloom/orm";

await em.transaction(async (txEm) => {
  const account = await txEm.findOne(Account, {
    where: { id: 1 },
    lock: LockMode.PESSIMISTIC_WRITE,
  });

  // This row is now locked — other transactions wait here
  account.balance -= 100;
  await txEm.save(Account, account);
  // Lock released when transaction commits
});
```

```sql
BEGIN;
SELECT * FROM "account" WHERE "id" = $1 FOR UPDATE;
-- parameters: [1]

-- ... other transactions trying to read this row will WAIT here ...

UPDATE "account" SET "balance" = $1 WHERE "id" = $2;
COMMIT;
-- Lock released
```

### Lock modes

| Mode | SQL appended | Behavior |
|------|-------------|----------|
| `PESSIMISTIC_WRITE` | `FOR UPDATE` | **Exclusive lock.** No other transaction can read or write this row until you commit. Use when you plan to modify the row. |
| `PESSIMISTIC_READ` | `FOR SHARE` (PostgreSQL) / `LOCK IN SHARE MODE` (MySQL) | **Shared lock.** Other transactions can read but cannot write. Use when you need a consistent read without blocking other readers. |

::: warning
Pessimistic locks **only work inside a transaction**. Outside a transaction, each query runs in its own auto-committed mini-transaction, so the lock is acquired and immediately released — effectively doing nothing.
:::

---

## GROUP BY and HAVING

GROUP BY collapses rows that share the same value into a single row. It's the foundation of aggregation queries like "how many orders per status?" or "total revenue per category."

```typescript
import sql from "sql-template-tag";

const results = await em.find(Order, {
  select: ["status"],
  groupBy: ["status"],
  having: [sql`COUNT(*) > ${10}`],
});
```

```sql
SELECT "status" FROM "order"
GROUP BY "status"
HAVING COUNT(*) > $1
-- parameters: [10]
```

What this does step by step:

1. **GROUP BY "status"** — takes all rows and groups them by their `status` value. If there are 3 unique statuses ("pending", "shipped", "delivered"), you get 3 groups.
2. **SELECT "status"** — from each group, return the status value.
3. **HAVING COUNT(\*) > 10** — only keep groups that have more than 10 rows. This filters *after* grouping (unlike WHERE, which filters *before* grouping).

`having` accepts an array of `Sql` objects (from `sql-template-tag`). Multiple conditions are joined with `AND`. Using the template tag ensures values are parameterized — no SQL injection risk.

::: tip WHERE vs HAVING
- **WHERE** filters individual rows *before* grouping
- **HAVING** filters groups *after* grouping

Think of it as: WHERE decides which rows enter the grouping machine, HAVING decides which groups come out.
:::

---

## Pagination

When your table has millions of rows, you can't return them all at once. Pagination lets you fetch data in pages. Stingerloom provides four strategies, each with different trade-offs.

### 1. skip + take (Offset-Based)

The simplest approach. `skip` says "ignore the first N rows" and `take` says "return at most N rows."

```typescript
const page2 = await em.find(Post, {
  orderBy: { createdAt: "DESC" },
  skip: 10,
  take: 10,
});
```

PostgreSQL:
```sql
SELECT * FROM "post"
ORDER BY "createdAt" DESC
LIMIT 10 OFFSET 10
```

MySQL:
```sql
SELECT * FROM `post`
ORDER BY `createdAt` DESC
LIMIT 10, 10
```

For page 1, `skip: 0, take: 10`. For page 2, `skip: 10, take: 10`. The formula is `skip = (pageNumber - 1) * pageSize`.

Alternatively, the `limit` tuple `[offset, count]` does the same thing:

```typescript
const page2 = await em.find(Post, {
  orderBy: { createdAt: "DESC" },
  limit: [10, 10],  // [offset, count]
});
```

::: warning The deep page problem
Offset-based pagination gets slower as you go deeper. `OFFSET 1000000` means the database has to read and discard 1,000,000 rows before returning your 10. For large tables with deep pages, consider cursor-based pagination instead.
:::

### 2. findAndCount()

Often you need both the data **and** the total count — for example, to display "Showing 11-20 of 235 posts" in a UI.

```typescript
const [posts, total] = await em.findAndCount(Post, {
  orderBy: { createdAt: "DESC" },
  skip: 0,
  take: 10,
});

console.log(posts.length); // 10 (current page)
console.log(total);        // 235 (total matching rows)
```

Internally, this runs **two queries** in the same transaction:

```sql
-- Query 1: fetch the page
SELECT * FROM "post"
ORDER BY "createdAt" DESC
LIMIT 10 OFFSET 0

-- Query 2: count all matching rows (no LIMIT/OFFSET)
SELECT COUNT(*) AS "result" FROM "post"
```

Running both in the same transaction ensures the count is consistent with the data — no rows can be inserted or deleted between the two queries.

### 3. findWithPage()

`findAndCount()` gives you raw numbers. `findWithPage()` computes the full pagination metadata for you — page count, hasNext, hasPrevious — so you can pass it directly to a REST API response.

```typescript
const result = await em.findWithPage(Post, {
  page: 2,
  pageSize: 20,
  orderBy: { createdAt: "DESC" },
  where: { isPublished: true },
  relations: ["author"],
});
```

Internally, this converts your `page` and `pageSize` into `skip` and `take`, then calls `findAndCount()`:

```sql
-- page=2, pageSize=20 → offset = (2-1) * 20 = 20

SELECT * FROM "post"
WHERE "isPublished" = $1
ORDER BY "createdAt" DESC
LIMIT 20 OFFSET 20

SELECT COUNT(*) AS "result" FROM "post"
WHERE "isPublished" = $1
```

The result object has everything you need:

```typescript
result.data            // Post[] — entities for the current page
result.total           // 235 — total matching rows
result.page            // 2 — current page number (1-based)
result.pageSize        // 20 — items per page
result.totalPages      // 12 — Math.ceil(235 / 20)
result.hasNextPage     // true — page 3 exists
result.hasPreviousPage // true — page 1 exists
```

**Return type: `PagePaginationResult<T>`**

| Field | Type | Description |
|-------|------|-------------|
| `data` | `T[]` | Entities for the current page |
| `total` | `number` | Total number of matching entities |
| `page` | `number` | Current page number (1-based) |
| `pageSize` | `number` | Items per page |
| `totalPages` | `number` | `Math.ceil(total / pageSize)` |
| `hasNextPage` | `boolean` | Whether a next page exists |
| `hasPreviousPage` | `boolean` | Whether a previous page exists |

`findWithPage()` accepts all the same options as `find()` (`where`, `select`, `relations`, `withDeleted`, `orderBy`, `groupBy`, `having`, `timeout`, `useMaster`).

### 4. findWithCursor() (Cursor-Based)

Offset pagination has a fundamental flaw: the deeper the page, the slower the query. `OFFSET 1000000` forces the database to scan and skip a million rows.

Cursor-based pagination solves this by saying: "give me rows **after this specific row**." Instead of counting from the beginning every time, you start from where you left off — like a bookmark in a book.

```typescript
// First page — no cursor yet
const page1 = await em.findWithCursor(Post, {
  take: 20,
  orderBy: "id",
  direction: "ASC",
});
```

```sql
SELECT * FROM "post"
ORDER BY "id" ASC
LIMIT 21
-- fetches 21 rows (20 + 1 extra to detect if more exist)
```

The ORM fetches one extra row to check if there's a next page. If 21 rows come back, there are more; if 20 or fewer, you've reached the end.

```typescript
console.log(page1.data);        // Post[] (up to 20 items)
console.log(page1.hasNextPage); // true
console.log(page1.nextCursor);  // "eyJ2IjoyMH0=" — opaque Base64 token
console.log(page1.count);       // 20
```

```typescript
// Next page — pass the cursor from the previous response
const page2 = await em.findWithCursor(Post, {
  take: 20,
  cursor: page1.nextCursor!,
  orderBy: "id",
  direction: "ASC",
});
```

```sql
SELECT * FROM "post"
WHERE "id" > $1
ORDER BY "id" ASC
LIMIT 21
-- parameters: [20]  (the decoded cursor value)
```

The cursor encodes the last row's sort column value. When you pass it back, the ORM adds a `WHERE "id" > 20` condition (for ASC) or `WHERE "id" < 20` (for DESC). This is an **index seek**, which is O(log n) — equally fast whether you're on page 1 or page 10,000.

**Return type: `CursorPaginationResult<T>`**

| Field | Type | Description |
|-------|------|-------------|
| `data` | `T[]` | Entities for the current page |
| `hasNextPage` | `boolean` | Whether more data exists |
| `nextCursor` | `string \| null` | Opaque token to pass for the next page |
| `count` | `number` | Number of entities in this page |

::: tip When to use which?
| Need | Best choice |
|------|-------------|
| Page numbers in UI (1, 2, 3...) | `findWithPage()` or `findAndCount()` |
| "Load more" / infinite scroll | `findWithCursor()` |
| Simple offset without total count | `skip` + `take` |
| Thousands of pages / deep pagination | `findWithCursor()` |
:::

---

## Streaming — stream()

All the methods above load results into memory at once. This is fine for a page of 20 posts, but what if you need to process **every row in a million-row table** — for a CSV export, a data migration, or sending emails to all users?

Loading a million rows at once would consume gigabytes of memory and likely crash your process. `stream()` solves this by fetching rows in small batches, processing each batch, then discarding it before fetching the next.

```typescript
for await (const user of em.stream(User, { where: { isActive: true } })) {
  await sendEmail(user.email);
}
```

Despite the simple `for await` syntax, this doesn't load all users into memory. Here's what happens behind the scenes:

```sql
-- Batch 1 (rows 0–999)
SELECT * FROM "user" WHERE "isActive" = $1 LIMIT 1000 OFFSET 0

-- Batch 2 (rows 1000–1999)
SELECT * FROM "user" WHERE "isActive" = $1 LIMIT 1000 OFFSET 1000

-- Batch 3 (rows 2000–2999)
SELECT * FROM "user" WHERE "isActive" = $1 LIMIT 1000 OFFSET 2000

-- ... continues until a batch returns fewer than 1000 rows
```

Each batch loads 1000 rows (the default), yields them one by one through the `for await` loop, then fetches the next batch. At any point, only one batch (up to 1000 objects) is in memory.

### Configuring batch size

The third parameter controls how many rows are fetched per internal query:

```typescript
// Fetch in batches of 500
for await (const post of em.stream(Post, { orderBy: { id: "ASC" } }, 500)) {
  await indexPost(post);
}
```

Smaller batches use less memory but make more database round-trips. Larger batches are more efficient but use more memory. 1000 is a good default for most cases.

### Supported options

`stream()` supports all `FindOption` properties — `where`, `orderBy`, `relations`, `select`, `withDeleted`, etc.:

```typescript
for await (const post of em.stream(Post, {
  select: ["id", "title"],
  relations: ["author"],
  where: { isPublished: true },
  orderBy: { createdAt: "DESC" },
}, 2000)) {
  console.log(`${post.title} by ${post.author.name}`);
}
```

### Progress tracking

Combine with `count()` to show progress:

```typescript
const total = await em.count(User, { isActive: true });
console.log(`Processing ${total} users...`);

let processed = 0;
for await (const user of em.stream(User, { where: { isActive: true } })) {
  await process(user);
  processed++;
  if (processed % 1000 === 0) {
    console.log(`${processed}/${total}`);
  }
}
```

### When to use stream() vs find()

| Scenario | Use | Why |
|----------|-----|-----|
| API endpoint returning a page of results | `find()` with pagination | Small result set, needs to be in memory for serialization |
| Processing every row (ETL, export, batch emails) | `stream()` | Prevents memory exhaustion |
| Aggregating from a large dataset | `stream()` or raw SQL | App-level aggregation with stream, or DB-level with raw SQL for best performance |

::: tip
For consistent results on large mutable tables, wrap the stream in a transaction with `REPEATABLE READ` isolation. Without this, rows could be inserted or deleted between batches, causing you to skip or double-process rows.

```typescript
await em.transaction(async (txEm) => {
  for await (const user of txEm.stream(User)) {
    await processUser(user);
  }
}, { isolationLevel: "REPEATABLE READ" });
```
:::

---

## Aggregate Functions

Sometimes you don't need individual rows — you need a summary: "how many users do we have?", "what's the average order value?", "what was the highest score?" These are **aggregate functions**, and the database computes them far more efficiently than fetching all rows and calculating in JavaScript.

### count()

```typescript
const total = await em.count(User);
const admins = await em.count(User, { role: "admin" });
```

```sql
-- count all users
SELECT COUNT(*) AS "result" FROM "user"

-- count admins only
SELECT COUNT(*) AS "result" FROM "user"
WHERE "role" = $1
-- parameters: ['admin']
```

The second parameter is an optional WHERE condition object — same syntax as `where` in `find()`.

### sum(), avg(), min(), max()

```typescript
const totalRevenue = await em.sum(Order, "amount");
const avgAge = await em.avg(User, "age");
const youngest = await em.min(User, "age");
const oldest = await em.max(User, "age");
```

```sql
SELECT SUM("amount") AS "result" FROM "order"
SELECT AVG("age") AS "result" FROM "user"
SELECT MIN("age") AS "result" FROM "user"
SELECT MAX("age") AS "result" FROM "user"
```

The second parameter is the column name to aggregate. All four accept an optional third parameter for WHERE conditions:

```typescript
const activeAvgAge = await em.avg(User, "age", { isActive: true });
```

```sql
SELECT AVG("age") AS "result" FROM "user"
WHERE "isActive" = $1
-- parameters: [true]
```

### Running multiple aggregates efficiently

Each aggregate function runs a separate query. If you need multiple aggregates, run them concurrently with `Promise.all` to avoid sequential round-trips:

```typescript
const [total, avgAge, minAge, maxAge] = await Promise.all([
  em.count(User),
  em.avg(User, "age"),
  em.min(User, "age"),
  em.max(User, "age"),
]);
```

This sends all four queries to the database at the same time instead of waiting for each one to finish before starting the next.

---

## EXPLAIN — Query Analysis

When a query is slow, you need to understand **why**. Is the database scanning the entire table? Is it using the right index? The `EXPLAIN` command asks the database to describe its execution plan without actually running the query.

```typescript
const plan = await em.explain(User, {
  where: { email: "alice@example.com" },
});

console.log(plan.type); // "ref" — using an index
console.log(plan.key);  // "idx_user_email"
console.log(plan.rows); // 1 — estimated rows examined
```

The ORM builds the exact same SQL it would for `find()`, then prepends `EXPLAIN`:

MySQL:
```sql
EXPLAIN SELECT * FROM `user`
WHERE `email` = ?
```

PostgreSQL:
```sql
EXPLAIN (FORMAT JSON) SELECT * FROM "user"
WHERE "email" = $1
```

### Reading the results

The exact fields depend on your database, but here's what to look for:

**MySQL:**
- `type: "ref"` or `"const"` = good (using an index)
- `type: "ALL"` = bad (full table scan)
- `key` = which index is being used
- `rows` = estimated number of rows the database will examine

**PostgreSQL:**
- Look for `Index Scan` or `Index Only Scan` = good
- `Seq Scan` = sequential scan (full table scan), might be slow on large tables
- `cost` = estimated relative cost

### When to use EXPLAIN

Use it during development to verify that:
- Your WHERE conditions hit an index (not a full table scan)
- JOINs are using appropriate indexes
- Adding a new index actually changed the query plan

`explain()` accepts the same `FindOption` as `find()`, so you can test the plan for any query you would actually run in production.

::: info
`explain()` is supported on MySQL and PostgreSQL. On SQLite, it throws `InvalidQueryError`.
:::

---

## Quick Reference — All FindOption Properties

Here's every option you can pass to `find()`, in one table:

| Option | Type | Description |
|--------|------|-------------|
| `where` | `WhereClause<T>` | Filter conditions (see WHERE Filters above) |
| `select` | `string[]` or `{ [key]: true }` | Columns to fetch (default: all) |
| `orderBy` | `{ [column]: "ASC" \| "DESC" }` | Sort order |
| `skip` | `number` | Rows to skip (offset) |
| `take` | `number` | Maximum rows to return (limit) |
| `limit` | `[offset, count]` | Alternative to skip/take |
| `relations` | `string[]` | Eager-load related entities via JOIN |
| `distinct` | `boolean` | SELECT DISTINCT |
| `groupBy` | `string[]` | GROUP BY columns |
| `having` | `Sql[]` | HAVING conditions (requires groupBy) |
| `withDeleted` | `boolean` | Include soft-deleted records |
| `lock` | `LockMode` | Pessimistic locking (requires transaction) |
| `timeout` | `number` | Query timeout in milliseconds |
| `useMaster` | `boolean` | Force read from master (when using read replicas) |

---

## Next Steps

- **[CRUD Basics](./entity-manager.md)** — save, find, delete, soft delete
- **[Writes & Transactions](./entity-manager-writes.md)** — Batch operations, upsert, transactions, raw SQL
- **[Advanced](./entity-manager-advanced.md)** — Events, subscribers, multi-tenancy, plugins, FindOption reference
