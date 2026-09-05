# Query Builder — Aggregations & Subqueries

GROUP BY, HAVING, subqueries, and DISTINCT are where `find()` runs out of
expressiveness. This page covers the full set, with examples that stay
compatible across MySQL, PostgreSQL, and SQLite.

## GROUP BY and Aggregation

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

> **Note** — for a typed aggregate surface (`u.id.count()`,
> `.sum()`, `.avg()`, `.min()`, `.max()`) that plugs into both SELECT and
> HAVING without `sql` templates, see the
> [QueryDSL Aggregates](./query-builder-querydsl.md#aggregates-—-select-and-having-in-one-expression)
> section.

### Counting Groups

`getCount()` on a grouped builder returns the **number of groups** left after `HAVING`, not the size of any one group — `paginate()` and `getManyAndCount()` rely on this so their `total` matches the grouped rows. Per-group sizes come from projecting the aggregate as above and reading `getRawMany()`. Details: [getCount() with GROUP BY](./query-builder-execution.md#getcount-with-group-by-counts-groups).

### Aggregate Functions in SELECT

Use `addSelect()` with `sql` template literals to add aggregate columns. The column alias becomes the key in the result object.

```typescript
import sql from "sql-template-tag";

const stats = await em
  .createQueryBuilder(Order, "o")
  .addSelect(sql`AVG("o"."price")`, "avgPrice")
  .addSelect(sql`SUM("o"."price")`, "totalRevenue")
  .addSelect(sql`MIN("o"."price")`, "cheapest")
  .addSelect(sql`MAX("o"."price")`, "mostExpensive")
  .addSelect(sql`COUNT(*)`, "orderCount")
  .getRawMany();
// [{ avgPrice: 42.5, totalRevenue: 850, cheapest: 10, mostExpensive: 99, orderCount: 20 }]
```

You can combine aggregate columns with grouped entity columns:

```typescript
const salesByCategory = await em
  .createQueryBuilder(Product, "p")
  .select(["category"])
  .addSelect(sql`AVG("p"."price")`, "avgPrice")
  .addSelect(sql`COUNT(*)`, "productCount")
  .groupBy(["category"])
  .having(sql`AVG("p"."price") > ${50}`)
  .orderBy({ category: "ASC" })
  .getRawMany();
// [{ category: "electronics", avgPrice: 299.99, productCount: 15 }, ...]
```

With entity-aware joins, you can aggregate across related tables:

```typescript
const p = qAlias(Post, "p");
const u = qAlias(User, "u");

const authorStats = await em
  .createQueryBuilder(Post, "p")
  .leftJoin(User, "u", (join) => join.on(p.col("authorId"), "=", u.col("id")))
  .selectRaw([u.col("name")])
  .addSelect(sql`COUNT(*)`, "postCount")
  .addSelect(sql`AVG("p"."likeCount")`, "avgLikes")
  .groupBy([u.col("name")])
  .having(sql`COUNT(*) >= ${3}`)
  .appendSql(sql`ORDER BY "postCount" DESC`)
  .getRawMany();
// [{ name: "Alice", postCount: 12, avgLikes: 45.3 }, ...]
```

`addOrderBy("postCount", "DESC")` would qualify the key as `"p"."postCount"` (the FROM alias), which is not a real column on `Post`. To order by a `SELECT`-list alias, drop down to `appendSql(sql\`ORDER BY "alias" ...\`)` — the alias survives because no qualification is applied.

### Expression-Builder addSelect()

`addSelect()` also accepts a callback. The callback receives the same dialect-portable `e` context as `@ComputedColumn({ expression })` — `e.col("alias.prop")`, `e.iff(...)`, `e.count()` / `e.sum()` / `e.avg()` / `e.min()` / `e.max()`, plus the full `ScalarExpression` arithmetic chain (`add` / `sub` / `mul` / `div` / `floor` / …). No raw SQL, and the rendered output is correct on every dialect:

```typescript
// COUNT(node.name) - 1 AS depth — nested-set depth without raw SQL
qb.addSelect((e) => e.count("node.name").sub(1), "depth");

// (c.rgt - (c.lft + 1)) / 2 AS children
qb.addSelect(
  (e) => e.col("c.rgt").sub(e.col("c.lft").add(1)).div(2).floor(),
  "children",
);
```

A scalar result **requires** the alias argument — `addSelect((e) => ..., "alias")` — and throws `INVALID_QUERY` without one. Aggregates can take the alias argument or finish with `.as("alias")`.

This composes because `AggregateExpression` supports arithmetic directly: `.toScalar()` bridges an aggregate into a `ScalarExpression`, and `.add()` / `.sub()` / `.mul()` / `.div()` are shorthands for `.toScalar().add(...)` and friends. The same surface is available on `qAlias()` aggregates, so `p.id.count().sub(1)` works too.

## Subqueries

The query builder supports subqueries in WHERE, SELECT, and FROM clauses. While `find()` can't express subqueries at all, the query builder makes them straightforward.

### WHERE IN Subquery

The typed shortcut is `whereInSubquery(column, subBuilder)` — see [Patterns & Productivity](./query-builder-patterns.md#whereinsubquery-wherenotinsubquery) for a worked example. Reach for `Conditions.inSubquery()` only when the subquery isn't expressible as a `SelectQueryBuilder` (e.g. you already have a `Sql` fragment from a raw source):

```typescript
import sql from "sql-template-tag";
import { Conditions } from "@stingerloom/orm";

// Find posts by authors from Korea
const subquery = em
  .createQueryBuilder(User, "u")
  .select(["id"])
  .where("country", "KR")
  .toSql();

const posts = await em
  .createQueryBuilder(Post, "p")
  .where(Conditions.inSubquery(`"p"."authorId"`, sql`(${subquery})`))
  .getMany();
```

### WHERE EXISTS / NOT EXISTS

Use `Conditions.exists()` or `Conditions.notExists()` for correlated subqueries:

```typescript
// Find authors who have at least one published post
const authors = await em
  .createQueryBuilder(User, "a")
  .where(Conditions.exists(sql`
    SELECT 1 FROM "post" "p"
    WHERE "p"."author_id" = "a"."id"
      AND "p"."status" = ${"published"}
  `))
  .getMany();
```

Prefer [`whereHas()`](./query-builder-patterns.md#wherehas-wherenothas-—-filter-by-relation-existence) over hand-built `EXISTS` when the correlation maps to a relation — it derives the join condition from decorator metadata.

### Scalar Subquery in SELECT

Use `addSelect()` to add a scalar subquery as a computed column:

```typescript
const authors = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name"])
  .addSelect(
    sql`(SELECT COUNT(*) FROM "post" "p" WHERE "p"."author_id" = "u"."id")`,
    "postCount",
  )
  .getRawMany();
// [{ id: 1, name: "Alice", postCount: 5 }, { id: 2, name: "Bob", postCount: 0 }]
```

### FROM Subquery (Derived Table)

Use `asSubquery()` to turn a SelectQueryBuilder into a derived table, then query it with a RawQueryBuilder:

```typescript
// Step 1: Build the inner query
const inner = em
  .createQueryBuilder(Post, "p")
  .select(["authorId"])
  .addSelect(sql`COUNT(*)`, "cnt")
  .groupBy(["authorId"]);

// Step 2: Use it as a derived table
const qb = em.createQueryBuilder();
const results = await em.query(
  qb
    .select(['"sub"."authorId"', '"sub"."cnt"'])
    .from(inner.asSubquery("sub"))
    .where([sql`"sub"."cnt" >= ${3}`])
    .build()
);
// Authors with 3+ posts
```

### CTE (Common Table Expressions)

For complex multi-step queries, use CTE via the RawQueryBuilder:

```typescript
const qb = em.createQueryBuilder();

const results = await em.query(
  qb
    .with("active_authors", (sub) =>
      sub
        .select(['DISTINCT "authorId"'])
        .from('"post"')
        .where([sql`"status" = ${"published"}`])
    )
    .select(['"u"."id"', '"u"."name"'])
    .from('"user" "u"')
    .where([sql`"u"."id" IN (SELECT "authorId" FROM "active_authors")`])
    .build()
);
```

For recursive CTEs (hierarchical data like comment threads or org charts), see the [Raw SQL & CTE](./raw-sql.md) guide.

### Higher-level helpers on `SelectQueryBuilder`

When the subquery is itself a `SelectQueryBuilder`, prefer the typed
helpers — they keep parameter bindings threaded through and give you
full autocomplete on the inner query:

- `whereInSubquery(column, subQb)` / `whereNotInSubquery(...)`
- `whereExistsSubquery(subQb)` / `whereNotExistsSubquery(...)`
- `addSelectSubquery(subQb, alias)`

See [Patterns & Productivity](./query-builder-patterns.md#subquery-integration)
for the full set.

## Scalar Aggregate Terminals

When you need a single aggregate value over a query's WHERE / JOIN constraints, the terminal methods `getSum()`, `getAvg()`, `getMin()`, and `getMax()` spare you from writing a raw `addSelect(sql`SUM(...)`, "s").getRawOne()` block. They reuse the builder's FROM / JOIN / WHERE / soft-delete / tenant scope and ignore any LIMIT / OFFSET / ORDER BY already set.

```typescript
const qb = em
  .createQueryBuilder(Order, "o")
  .leftJoin(User, "u", (j) => j.on("o.userId", "=", "u.id"))
  .where("u.country", "KR")
  .where("o.status", "completed");

const total   = await qb.getSum("amount");   // SUM(o.amount)
const average = await qb.getAvg("amount");   // AVG(o.amount)
const lowest  = await qb.getMin("amount");   // MIN(o.amount)
const highest = await qb.getMax("amount");   // MAX(o.amount)
```

All four return `Promise<number>`. When no rows match — or the column is `NULL` for every matching row — the result coerces to `0`, mirroring `EntityManager.sum()` / `avg()` / `min()` / `max()`.

The `column` argument is constrained to `ColumnOf<T>` (a camelCase property name on the root entity), so typos are caught at compile time.

| Method | SQL | Returns |
|--------|-----|---------|
| `getSum(column)` | `SELECT SUM(col) FROM ...` | `Promise<number>` — 0 on empty |
| `getAvg(column)` | `SELECT AVG(col) FROM ...` | `Promise<number>` — 0 on empty |
| `getMin(column)` | `SELECT MIN(col) FROM ...` | `Promise<number>` — 0 on empty |
| `getMax(column)` | `SELECT MAX(col) FROM ...` | `Promise<number>` — 0 on empty |

These work well alongside `getCount()` when you need multiple aggregate scalars from the same scope without an extra GROUP BY.

## DISTINCT

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

For `DISTINCT ON` (PostgreSQL-specific), see the
[Raw SQL & CTE](./raw-sql.md) guide.

## Next Steps

- [QueryDSL Expressions](./query-builder-querydsl.md) — typed aggregates,
  window functions, CASE, date components
- [Patterns & Productivity](./query-builder-patterns.md) — `whereHas`,
  `withCount`, scopes
- [Raw SQL & CTE](./raw-sql.md) — UNION, recursive CTE, window functions
- [Query Builder Overview](./query-builder.md) — basics and overall map
