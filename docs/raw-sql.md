# Raw SQL & CTE

## Why Raw SQL?

The ORM's `find()`, `save()`, and `SelectQueryBuilder` cover the vast majority of queries. But SQL is a rich language, and some things cannot be expressed through an entity-based API:

- **Combining results from different tables** that have no relation (UNION)
- **Traversing hierarchical data** like org charts or category trees (recursive CTE)
- **Computing rankings or running totals** across rows (window functions)
- **Cross-database analytics** that span multiple entities in complex ways

For these cases, `RawQueryBuilder` gives you the full power of SQL while still providing parameter binding (to prevent SQL injection) and a composable builder API (so you can construct queries programmatically rather than concatenating strings).

The trade-off is clear: you lose the type-safe `keyof T` auto-completion, but you gain the full expressive power of SQL. Table and column names must be quoted manually (`"double quotes"` for PostgreSQL, `` `backticks` `` for MySQL), though the ORM auto-detects the database type when you create the builder via `em.createQueryBuilder()`.

## Getting Started

Create a RawQueryBuilder with `em.createQueryBuilder()` (no arguments), chain methods, and call `build()` to get the SQL. Then execute it with `em.query()`.

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

The `where()` method in RawQueryBuilder takes an **array** of conditions (joined with AND). Values are always parameter-bound via `sql-template-tag` -- never concatenated into the SQL string.

## WHERE, JOIN, and Subqueries

RawQueryBuilder has the same WHERE helpers as SelectQueryBuilder -- `andWhere()`, `orWhere()`, `whereIn()`, `whereNull()`, `whereBetween()`, etc. The difference is that column names are raw strings, not type-safe.

JOINs work the same way:

```typescript
import sql, { raw } from "sql-template-tag";

const query = em.createQueryBuilder()
  .select(['"p".*', '"u"."name" AS "authorName"'])
  .from('"posts"', "p")
  .leftJoin('"users"', "u", sql`${raw('"p"')}."author_id" = ${raw('"u"')}."id"`)
  .where([sql`${raw('"p"')}."is_published" = ${true}`])
  .limit(20)
  .build();

const posts = await em.query(query);
```

For subqueries, the builder provides `asInQuery()`, `asExists()`, and `as()` to embed one query inside another.

```typescript
// IN subquery -- find users who have at least one order
const orderUsers = em.createQueryBuilder()
  .select(['"user_id"'])
  .from('"orders"')
  .where([sql`"status" = ${"completed"}`])
  .asInQuery();

const query = em.createQueryBuilder()
  .select(["*"])
  .from('"users"')
  .where([])
  .appendSql(sql`AND "id" IN ${orderUsers}`)
  .build();
```

## Set Operations -- UNION, INTERSECT, EXCEPT

Sometimes you need to combine results from completely different queries. For example, merging employees and contractors into a single list.

```typescript
const query = em.createQueryBuilder()
  .select(['"id"', '"name"', '"email"'])
  .from('"employees"')
  .where([sql`"department" = ${"engineering"}`])
  .union()
  .select(['"id"', '"name"', '"email"'])
  .from('"contractors"')
  .where([sql`"department" = ${"engineering"}`])
  .build();

const allEngineers = await em.query(query);
```

After calling `union()`, you start a new SELECT that becomes the second half of the UNION. The result contains rows from both queries with duplicates removed.

Four set operations are available:

| Method | SQL | What it does |
|--------|-----|-------------|
| `union()` | `UNION` | Combine two result sets, remove duplicates |
| `unionAll()` | `UNION ALL` | Combine two result sets, keep duplicates (faster) |
| `intersect()` | `INTERSECT` | Only rows that appear in both result sets |
| `except()` | `EXCEPT` | Rows in the first set that don't appear in the second |

A practical example: finding email addresses that exist in the users table but not in the unsubscribed table.

```typescript
const query = em.createQueryBuilder()
  .select(['"email"']).from('"users"')
  .except()
  .select(['"email"']).from('"unsubscribed"')
  .build();

const subscribedEmails = await em.query(query);
```

## Common Table Expressions (CTE)

### Why CTEs?

Think of a CTE like naming a subquery and storing it in a variable. In regular programming, you would never write a 50-line expression inline -- you would break it into named variables. CTEs do the same thing for SQL.

Without a CTE, you end up nesting subqueries inside subqueries, which becomes unreadable fast. With a CTE, you define each step as a named block, then compose them together. The database executes them in order, and each step can reference the ones before it.

It is exactly like writing:

```
// Pseudocode
const activeUsers = SELECT id, name FROM users WHERE is_active = true;
const result = SELECT * FROM activeUsers;
```

Except in SQL, you write it as:

```sql
WITH active_users AS (
  SELECT "id", "name" FROM "users" WHERE "is_active" = true
)
SELECT * FROM active_users
```

### How

```typescript
const query = em.createQueryBuilder()
  .with("active_users", (sub) =>
    sub.select(['"id"', '"name"']).from('"users"').where([sql`"is_active" = ${true}`])
  )
  .select(["*"])
  .from(sql`active_users`)
  .build();

const users = await em.query(query);
```

The `with()` method takes a name and either a `Sql` object or a callback that receives a fresh `RawQueryBuilder`. The CTE result can then be referenced in the main query's FROM clause like a regular table.

### Recursive CTE

Some data is naturally hierarchical -- org charts, category trees, threaded comments. A **recursive CTE** lets you traverse these hierarchies in a single query, instead of making one query per level.

Suppose you have an `employees` table where each employee has a `manager_id` pointing to their manager. To get the entire org tree starting from the CEO:

```typescript
const query = em.createQueryBuilder()
  .withRecursive("org_tree", sql`
    SELECT "id", "name", "manager_id", 1 AS depth
    FROM "employees"
    WHERE "manager_id" IS NULL

    UNION ALL

    SELECT "e"."id", "e"."name", "e"."manager_id", "ot"."depth" + 1
    FROM "employees" "e"
    INNER JOIN "org_tree" "ot" ON "e"."manager_id" = "ot"."id"
  `)
  .select(["*"])
  .from(sql`org_tree`)
  .orderBy([{ column: '"depth"', direction: "ASC" }])
  .build();

const orgChart = await em.query(query);
// [{ id: 1, name: "CEO", depth: 1 }, { id: 2, name: "VP Eng", depth: 2 }, ...]
```

The recursive CTE has two parts joined by `UNION ALL`:
1. **Base case** -- the starting rows (employees with no manager = the CEO)
2. **Recursive step** -- join the CTE result back to the original table to find children

The database executes the recursive step repeatedly until no new rows are produced. Each iteration goes one level deeper in the tree.

## Window Functions

### Why Window Functions?

Suppose you want to rank employees by salary within each department. With GROUP BY, you would collapse all employees in a department into a single row -- losing individual employee data. Window functions let you **keep every row** while adding computed values alongside them.

Think of it like this: GROUP BY is a blender (everything merges into one result per group). A window function is a calculator that sits next to each row, looks at related rows through a "window," and writes down its answer without changing anything.

### How

The classic example is ranking. Suppose you want to rank employees by salary within each department.

```typescript
const query = em.createQueryBuilder()
  .selectWithWindow([
    '"name"',
    '"department"',
    '"salary"',
    {
      expr: "ROW_NUMBER()",
      over: { partitionBy: '"department"', orderBy: '"salary" DESC' },
      alias: "rank",
    },
  ])
  .from('"employees"')
  .build();

const ranked = await em.query(query);
// [
//   { name: "Alice", department: "eng", salary: 150000, rank: 1 },
//   { name: "Bob",   department: "eng", salary: 130000, rank: 2 },
//   { name: "Carol", department: "sales", salary: 140000, rank: 1 },
//   ...
// ]
```

Each element in the `selectWithWindow()` array is either a plain column string or an object describing a window function:

- `expr` -- The function to apply (`ROW_NUMBER()`, `RANK()`, `SUM(salary)`, etc.)
- `over.partitionBy` -- Which column to group by (like GROUP BY, but without collapsing rows)
- `over.orderBy` -- How to sort within each group
- `alias` -- The name for the computed column

Here are the most commonly used window functions:

| Function | What it does | Example |
|----------|-------------|---------|
| `ROW_NUMBER()` | Sequential number within partition | Paginating within groups |
| `RANK()` | Rank with gaps on ties (1, 2, 2, 4) | Leaderboards |
| `DENSE_RANK()` | Rank without gaps (1, 2, 2, 3) | Top-N per category |
| `SUM(col)` | Running total across the partition | Cumulative revenue |
| `AVG(col)` | Running average | Moving averages |
| `LAG(col)` | Previous row's value | Day-over-day comparison |
| `LEAD(col)` | Next row's value | Forecasting |

A practical example -- computing cumulative revenue by month:

```typescript
const query = em.createQueryBuilder()
  .selectWithWindow([
    '"month"',
    '"revenue"',
    {
      expr: "SUM(revenue)",
      over: { orderBy: '"month" ASC' },
      alias: "cumulative_revenue",
    },
  ])
  .from('"monthly_sales"')
  .build();
```

When `partitionBy` is omitted, the window spans the entire result set -- the running total accumulates across all rows, not per group.

## DISTINCT -- Removing Duplicates

RawQueryBuilder also supports DISTINCT variants.

```typescript
// SELECT DISTINCT
qb.selectDistinct(['"city"', '"country"']).from('"users"');

// DISTINCT ON (PostgreSQL only) -- keep only the first row per group
qb.selectDistinctOn(['"department"'], ['"id"', '"name"', '"salary"'])
  .from('"employees"');
// SELECT DISTINCT ON ("department") "id", "name", "salary" FROM "employees"
```

`DISTINCT ON` is a PostgreSQL extension that returns one row per distinct value in the specified column(s). It's like GROUP BY but lets you pick which row to keep (determined by ORDER BY).

## Choosing Between the Two Builders

| Question | SelectQueryBuilder | RawQueryBuilder |
|----------|-------------------|----------------|
| Are you querying a registered entity? | Yes | Not required |
| Do you want `keyof T` auto-complete? | Yes | No |
| Do you need UNION / INTERSECT / EXCEPT? | No | Yes |
| Do you need CTE (WITH / WITH RECURSIVE)? | No | Yes |
| Do you need window functions? | No | Yes |
| Returns class instances? | `getMany()` yes / `getPartialMany()` no | No -- raw objects via `em.query()` |

In practice, start with `SelectQueryBuilder` for everyday queries. If you hit a wall -- you need UNION, recursive hierarchy traversal, or window analytics -- switch to `RawQueryBuilder` for that specific query.

## Next Steps

- [Query Builder](./query-builder.md) -- Type-safe SelectQueryBuilder with `keyof T` auto-complete
- [EntityManager](./entity-manager.md) -- Basic CRUD with find(), save(), etc.
- [API Reference](./api-reference.md) -- Quick reference for all method signatures
