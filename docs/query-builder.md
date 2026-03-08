# Query Builder

While `find()` and `findOne()` can handle most queries, sometimes you need complex SQL like JOINs, GROUP BY, or subqueries. That's when you use **RawQueryBuilder**.

## When to Use the Query Builder?

| Scenario | Recommendation |
|----------|---------------|
| Simple CRUD, WHERE conditions | Use `em.find()`, `em.save()` |
| JOIN, GROUP BY, subqueries | Use the query builder |
| DB-specific functions, complex aggregation | Use the query builder or `em.query()` |

## Basic Usage

Create a query builder with `RawQueryBuilderFactory.create()`, chain methods, and finalize with `build()`.

```typescript
import { RawQueryBuilderFactory } from "@stingerloom/orm";
import sql from "sql-template-tag";

const qb = RawQueryBuilderFactory.create();

const query = qb
  .select(["id", "name", "email"])
  .from('"users"')
  .where([sql`"is_active" = ${true}`])
  .orderBy([{ column: '"created_at"', direction: "DESC" }])
  .limit(10)
  .build();

// Execute with EntityManager
const users = await em.query(query);
```

> **Hint** Table and column names must be quoted appropriately for your DB. PostgreSQL uses double quotes (`"`), MySQL uses backticks (`` ` ``).

## SELECT

```typescript
// Specific columns
qb.select(['"id"', '"name"', '"email"']);

// All columns
qb.select("*");

// Aliases
qb.select(['"u"."id"', '"u"."name" AS "userName"']);
```

## FROM

```typescript
// Basic
qb.from('"users"');

// With alias
qb.from('"users"', "u");
```

## WHERE Conditions

`where()` uses `sql-template-tag` template literals to safely bind values.

```typescript
import sql from "sql-template-tag";

// Basic WHERE (multiple conditions are joined with AND)
qb.where([
  sql`"is_active" = ${true}`,
  sql`"age" >= ${18}`,
]);
// WHERE "is_active" = $1 AND "age" >= $2

// Empty array results in WHERE 1=1 (allows adding conditions later)
qb.where([]);

// Adding AND / OR
qb.where([sql`"type" = ${"admin"}`])
  .andWhere(sql`"age" < ${60}`)
  .orWhere(sql`"type" = ${"superadmin"}`);
```

### IN / NOT IN

```typescript
qb.where([])
  .whereIn('"status"', ["active", "pending"]);
// WHERE 1=1 AND "status" IN ($1, $2)

qb.where([])
  .whereNotIn('"id"', [1, 2, 3]);
```

### NULL Check

```typescript
qb.where([])
  .whereNull('"deleted_at"');
// WHERE 1=1 AND "deleted_at" IS NULL

qb.where([])
  .whereNotNull('"email"');
```

### BETWEEN

```typescript
qb.where([])
  .whereBetween('"age"', 18, 65);
// WHERE 1=1 AND "age" BETWEEN $1 AND $2
```

## JOIN

Used for joining tables.

```typescript
import sql, { raw } from "sql-template-tag";

// LEFT JOIN
qb.select(['"p".*', '"u"."name" AS "authorName"'])
  .from('"posts"', "p")
  .leftJoin(
    '"users"',
    "u",
    sql`${raw('"p"')}."author_id" = ${raw('"u"')}."id"`
  );

// INNER JOIN
qb.select(['"o".*'])
  .from('"orders"', "o")
  .innerJoin(
    '"order_items"',
    "oi",
    sql`${raw('"o"')}."id" = ${raw('"oi"')}."order_id"`
  );

// RIGHT JOIN works the same way
qb.rightJoin('"employees"', "e", sql`...`);
```

## ORDER BY, LIMIT, OFFSET

```typescript
// ORDER BY
qb.orderBy([
  { column: '"created_at"', direction: "DESC" },
  { column: '"id"', direction: "ASC" },
]);

// LIMIT
qb.limit(10);

// [offset, count] format
qb.setDatabaseType("mysql").limit([20, 10]);
// MySQL: LIMIT 20, 10

qb.setDatabaseType("postgresql").limit([20, 10]);
// PostgreSQL: LIMIT 10 OFFSET 20

// LIMIT + OFFSET
qb.limit(10).offset(20);
```

## GROUP BY, HAVING

Used for aggregate queries.

```typescript
qb.select(['"category"', "COUNT(*) AS cnt"])
  .from('"posts"')
  .where([sql`"is_active" = ${true}`])
  .groupBy(['"category"'])
  .having([sql`COUNT(*) >= ${5}`]);
// SELECT "category", COUNT(*) AS cnt
// FROM "posts"
// WHERE "is_active" = $1
// GROUP BY "category"
// HAVING COUNT(*) >= $2
```

## Subqueries

### IN Subquery

```typescript
const subQuery = RawQueryBuilderFactory.create()
  .select(['"user_id"'])
  .from('"premium_subscriptions"')
  .where([sql`"is_active" = ${true}`])
  .asInQuery();

qb.select(["*"])
  .from('"users"')
  .where([])
  .appendSql(sql`AND "id" IN ${subQuery}`);
// SELECT * FROM "users" WHERE 1=1 AND "id" IN (SELECT "user_id" FROM ...)
```

### EXISTS Subquery

```typescript
const exists = RawQueryBuilderFactory.create()
  .select(['"1"'])
  .from('"orders"')
  .where([sql`"user_id" = "u"."id"`])
  .asExists();

qb.select(["*"])
  .from('"users"', "u")
  .where([exists]);
// SELECT * FROM "users" AS u WHERE EXISTS (SELECT "1" FROM "orders" WHERE ...)
```

### FROM Subquery

```typescript
const subQuery = RawQueryBuilderFactory.create()
  .select(['"post_id"', "COUNT(*) AS cnt"])
  .from('"comments"')
  .groupBy(['"post_id"'])
  .as("comment_counts");

qb.select(['"p"."id"', '"p"."title"', '"cc"."cnt"'])
  .from('"posts"', "p")
  .leftJoin(subQuery, "cc", sql`"p"."id" = "cc"."post_id"`);
```

## Practical Examples

### Order Statistics by User

```typescript
const query = RawQueryBuilderFactory.create()
  .select([
    '"u"."id"',
    '"u"."name"',
    'COUNT("o"."id") AS "orderCount"',
    'SUM("o"."total") AS "totalAmount"',
  ])
  .from('"users"', "u")
  .leftJoin(
    '"orders"', "o",
    sql`${raw('"u"')}."id" = ${raw('"o"')}."user_id"`
  )
  .where([sql`${raw('"u"')}."is_active" = ${true}`])
  .groupBy(['"u"."id"', '"u"."name"'])
  .having([sql`COUNT("o"."id") >= ${1}`])
  .orderBy([{ column: '"totalAmount"', direction: "DESC" }])
  .limit(20)
  .build();

const stats = await em.query(query);
```

### Date Range + Status Filter + Pagination

```typescript
const startDate = new Date("2024-01-01");
const endDate = new Date("2024-12-31");

const query = RawQueryBuilderFactory.create()
  .select(["*"])
  .from('"orders"')
  .where([sql`"created_at" BETWEEN ${startDate} AND ${endDate}`])
  .whereIn('"status"', ["pending", "processing"])
  .whereNotNull('"customer_id"')
  .orderBy([{ column: '"created_at"', direction: "DESC" }])
  .limit(10)
  .offset(20)
  .build();

const orders = await em.query(query);
```

## Next Steps

- [Transactions](./transactions.md) — Grouping multiple queries into a single unit of work
- [EntityManager](./entity-manager.md) — Back to basic CRUD with find(), save(), etc.
- [API Reference](./api-reference.md) — Quick reference for all method signatures
