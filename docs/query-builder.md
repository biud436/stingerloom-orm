# Query Builder

`find()` and `findOne()` can handle most everyday queries — filtering by
conditions, loading relations, pagination. But sometimes you need something
more. Suppose you want to join two tables that don't have a direct relation,
group rows by category and count them, or combine results from two different
tables with UNION. These are the situations where the **query builder** comes
in.

Stingerloom provides two query builders, and the choice is simple.

| Builder | When to use | How to create |
|---------|-------------|---------------|
| **SelectQueryBuilder** | You're querying an entity and want auto-complete on column names | `em.createQueryBuilder(User, "u")` |
| **RawQueryBuilder** | You need raw SQL control — UNION, CTE, window functions | `em.createQueryBuilder()` (no arguments) |

Most of the time, you'll use `SelectQueryBuilder`. Let's start there.

This page covers the basics — creating a builder, filtering with `WHERE`, and
combining conditions. Each deeper topic has its own page:

| Topic | Page |
|-------|------|
| JOINs — entity-aware, relation-based, multi-table | [JOINs](./query-builder-joins.md) |
| `qAlias()` — type-safe expressions, aggregates, CASE, date components, window functions | [QueryDSL Expressions](./query-builder-querydsl.md) |
| JSON / JSONB column navigation with the proxy | [JSON Navigation](./query-builder-json.md) |
| `GROUP BY`, `HAVING`, subqueries, `DISTINCT`, CTE | [Aggregations & Subqueries](./query-builder-aggregations.md) |
| Pagination, locking, index hints, `validate()`, execution tiers, `prepare()` | [Execution & Results](./query-builder-execution.md) |
| `when()`, `pipe()`, `whereHas()`, `withCount()`, scopes | [Patterns & Productivity](./query-builder-patterns.md) |
| UNION, recursive CTE, window functions — `RawQueryBuilder` | [Raw SQL & CTE](./raw-sql.md) |

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

For the full tier reference (required-column validation, when to use
each method), see
[Execution & Results → Executing the Query](./query-builder-execution.md#executing-the-query).

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

For parenthesized groups (e.g. `WHERE status = 'active' OR (role = 'admin' AND verified = true)`),
see [`andWhereGroup()` / `orWhereGroup()`](./query-builder-patterns.md#grouped-conditions-andwheregroup-orwheregroup).

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

All WHERE methods also accept cross-entity references using `"alias.property"` notation — see
[Cross-Entity Column Resolution](./query-builder-joins.md#cross-entity-column-resolution) on
the JOINs page.

---

## What to Read Next

- **[JOINs](./query-builder-joins.md)** — join other entities with typed
  column references, automatic ON from relation metadata, `*AndSelect`
  variants
- **[QueryDSL Expressions](./query-builder-querydsl.md)** — `qAlias()`,
  aggregates, CASE, casts, date components, window functions, composable
  conditions
- **[JSON Navigation](./query-builder-json.md)** — proxy-based access to
  `json` / `jsonb` columns across all three dialects
- **[Aggregations & Subqueries](./query-builder-aggregations.md)** — GROUP
  BY, HAVING, correlated subqueries, DISTINCT
- **[Execution & Results](./query-builder-execution.md)** — ORDER BY,
  pagination, pessimistic locking, index hints, `validate()`, `getMany()` /
  `getPartialMany()` / `getRawMany()`, `prepare()`
- **[Patterns & Productivity](./query-builder-patterns.md)** — `when()`,
  `pipe()`, `whereHas()`, `withCount()`, scopes
- **[Raw SQL & CTE](./raw-sql.md)** — the `RawQueryBuilder` for UNION,
  recursive CTE, window functions, DISTINCT ON

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
