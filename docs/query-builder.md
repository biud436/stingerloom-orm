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

### Navigating JSON Columns

#### Why This Section Exists

> **A note on the example.** Many ORM tutorials use a generic `metadata`
> column for JSON. That name is a code smell — _"metadata"_ literally means
> _"data about data"_, and using it for JSON hides what the column actually
> holds. In this section we use a concrete column, `profile`, on a `User`
> entity: real business data with an explicit shape. Everything here works
> for any `json` / `jsonb` column regardless of name.

Imagine a `users` table where each row has a `profile` JSON column
describing the user's contact info, tags, and role:

```json
{
  "contact": { "email": "alice@example.com", "phone": "+82-10-0000-0000" },
  "personal": { "age": 30, "city": "Seoul" },
  "tags":     ["red", "blue", "green"],
  "role":     "admin"
}
```

You want to answer: _"Give me every user whose contact email ends in
`@corp.com`, whose age is at least 18, and whose tags array is non-empty."_

In raw SQL, the answer looks different on every database:

```sql
-- PostgreSQL
SELECT * FROM users
WHERE profile #>> '{contact,email}' LIKE '%@corp.com'
  AND (profile #>> '{personal,age}')::int >= 18
  AND jsonb_array_length(profile -> 'tags') > 0;

-- MySQL
SELECT * FROM users
WHERE JSON_UNQUOTE(JSON_EXTRACT(profile, '$.contact.email')) LIKE '%@corp.com'
  AND JSON_EXTRACT(profile, '$.personal.age') >= 18
  AND JSON_LENGTH(profile, '$.tags') > 0;

-- SQLite
SELECT * FROM users
WHERE json_extract(profile, '$.contact.email') LIKE '%@corp.com'
  AND json_extract(profile, '$.personal.age') >= 18
  AND json_array_length(profile, '$.tags') > 0;
```

Three things hurt here:

1. **Every dialect has different function names and path syntax.** Move the
   query from PostgreSQL to MySQL and every JSON line breaks.
2. **Paths are strings.** A typo in `'{contact,emial}'` compiles fine and
   silently returns zero rows.
3. **Paths concatenated from user input are an injection vector.** If the
   path is built as `` `'{${key}}'` ``, a hostile key ends the query early.

TypeScript already knows the shape of `profile`, because you declared it:

```typescript
@Column({ type: "jsonb", nullable: true })
profile!: {
  contact?:  { email: string; phone?: string };
  personal?: { age: number; city?: string };
  tags?:     string[];
  role?:     string;
};
```

So the question becomes: _why can't we just write
`u.profile.contact.email` and let the ORM translate it to the right SQL?_
That is exactly what this section is about.

#### The Road to `qAlias()`

Before JSON, the query builder already had two ways of referring to a column:

```typescript
qb.where("firstName", "Alice")                        // stringly-typed
qb.where(alias(User, "u").col("firstName"), "Alice")  // alias() — autocomplete on column name
```

Both still require you to spell the operator yourself (`"="`, `"LIKE"`, …).
JPA users will recognise the next step: code-generate a `QUser` class with
typed fields, and write `qUser.firstName.eq("Alice")`. JPA's QueryDSL does
exactly that — but it needs a build-time code generator.

**`qAlias()` is the TypeScript equivalent without the codegen.** It returns a
`Proxy` that pretends to have every entity property as a `ColumnExpression`:

```typescript
const u = qAlias(User, "u");
qb.where(u.firstName.eq("Alice"));
//         │         └── operator method on ColumnExpression
//         └── proxy-intercepted property access → "u.firstName"
```

At runtime there is no `u.firstName` object — the proxy's `get` trap creates
a `ColumnExpression("u.firstName")` on the fly, `.eq("Alice")` wraps it into
a deferred `ColumnCondition`, and the query builder resolves `"u.firstName"`
to `"u"."first_name"` at build time (respecting `SnakeNamingStrategy`).

#### Why JSON Is a Natural Extension

Once you have a proxy that turns property access into SQL expressions, a
JSON column is almost free. When you write `u.profile`, the proxy sees that
`profile` was declared with `@Column({ type: "json" | "jsonb" })` and hands
back a different kind of proxy — a `JsonPathExpression` that **keeps
extending the path** instead of terminating at one level:

```
u            .profile       .contact      .email      .eq("alice@example.com")
│             │              │             │           │
ColumnExpr    JsonPath(      JsonPath(     JsonPath(   JsonPathCondition
proxy         ref="u.prof",  path=         path=       compile via
              path=[])       ["contact"])  ["contact", DialectExpression
                                            "email"])
```

Only the last call — the operator — freezes the path and produces a
`JsonPathCondition`. The query builder then asks the current driver's
`DialectExpression` to render the correct SQL: `#>>` for PostgreSQL,
`JSON_EXTRACT` for MySQL, `json_extract` for SQLite.

#### Basic Usage

```typescript
import { qAlias } from "@stingerloom/orm";

@Entity()
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  firstName!: string;

  @Column({ type: "jsonb", nullable: true })
  profile!: {
    contact?:  { email: string; phone?: string };
    personal?: { age: number; city?: string };
    tags?:     string[];
    role?:     string;
  };
}

const u = qAlias(User, "u");

const users = await em
  .createQueryBuilder(User, "u")
  .where(u.profile.contact.email.eq("alice@example.com"))
  .getMany();
```

Behind the scenes:

```sql
-- PostgreSQL
SELECT ... FROM "users" AS "u"
WHERE "u"."profile" #>> ARRAY[$1, $2]::text[] = $3
-- params: "contact", "email", "alice@example.com"

-- MySQL
SELECT ... FROM `users` AS `u`
WHERE JSON_UNQUOTE(JSON_EXTRACT(`u`.`profile`, ?)) = ?
-- params: "$.contact.email", "alice@example.com"

-- SQLite
SELECT ... FROM "users" AS "u"
WHERE json_extract("u"."profile", ?) = ?
-- params: "$.contact.email", "alice@example.com"
```

Every path segment and every value is a **bound parameter** — there is no
string concatenation, so paths are safe even when they come from user input.

#### Operator Reference (with Compiled SQL)

The following examples all assume `const u = qAlias(User, "u")` and show the
PostgreSQL output; MySQL and SQLite produce the equivalent functions.

##### Comparison — `.eq` / `.neq` / `.gt` / `.gte` / `.lt` / `.lte`

```typescript
u.profile.personal.age.gte(18);
```
```sql
"u"."profile" #>> ARRAY['personal','age']::text[] >= $1
```

##### Pattern match — `.like` / `.notLike`

```typescript
u.profile.contact.email.like("%@corp.com");
```
```sql
"u"."profile" #>> ARRAY['contact','email']::text[] LIKE $1
```

##### Set membership — `.in` / `.notIn`

```typescript
u.profile.role.in(["admin", "editor"]);
```
```sql
"u"."profile" #>> ARRAY['role']::text[] IN ($1, $2)
```

An empty list short-circuits to `1 = 0` (nothing matches) — `.notIn([])`
short-circuits to `1 = 1` — so the query stays valid SQL.

##### NULL — `.isNull` / `.isNotNull`

```typescript
u.profile.contact.email.isNull();
```
```sql
"u"."profile" #>> ARRAY['contact','email']::text[] IS NULL
```

A missing key yields `NULL` at extract time, so `.isNull()` is the correct
way to say _"the path doesn't exist or is set to null"_.

##### Structural — `.contains(value)`

```typescript
u.profile.contains({ role: "admin" });
```
```sql
"u"."profile" @> $1::jsonb      -- param: '{"role":"admin"}'
```

MySQL emits `JSON_CONTAINS(col, '{"role":"admin"}', '$.path')`. SQLite has
no native containment operator — it accepts **scalar** `.contains(value)`
(emitted as equality at the path), and throws `OrmError` for object or
array values. Use `.eq()` on a concrete leaf path, or raw SQL, if you need
complex containment on SQLite.

##### Structural — `.hasKey(key)`

```typescript
u.profile.contact.hasKey("email");
```
```sql
("u"."profile" #> ARRAY['contact']::text[]) ? $1        -- PostgreSQL
JSON_CONTAINS_PATH(`u`.`profile`, 'one', ?)             -- MySQL
json_extract("u"."profile", ?) IS NOT NULL              -- SQLite
```

##### Scalar — `.arrayLength()` / `.typeOf()`

Both return a `JsonScalarExpression` — think of it as "the result of a JSON
function, ready to be compared":

```typescript
u.profile.tags.arrayLength().gt(3);
u.profile.tags.typeOf().eq("array");
```
```sql
jsonb_array_length("u"."profile" #> ARRAY['tags']::text[]) > $1
jsonb_typeof     ("u"."profile" #> ARRAY['tags']::text[]) = $1
```

#### Dynamic Paths — `.path(string)`

Proxy access is great for static, code-known paths. Two things the proxy
cannot express:

- **Array indices** when the array type isn't tight enough for TypeScript
  to let you write `u.profile.tags[0]` directly.
- **Keys with dots, spaces, or other punctuation** — `u.profile["weird key"]`
  isn't portable through the proxy machinery.

For both, use `.path()`:

```typescript
u.profile.path("tags[0]").eq("admin");
u.profile.path(`items["weird key"][2].value`).isNotNull();
```
```sql
-- PostgreSQL
"u"."profile" #>> ARRAY['tags','0']::text[] = $1
"u"."profile" #>> ARRAY['items','weird key','2','value']::text[] IS NOT NULL
```

`.path()` composes with proxy access — so you can navigate statically as
far as you like, then switch to `.path()` for the dynamic tail:

```typescript
u.profile.personal.path("history[1].city").eq("Busan");
// resulting path = ['personal', 'history', 1, 'city']
```

#### Dialect Cheat Sheet

| Operation      | PostgreSQL                              | MySQL                                           | SQLite                                                 |
|----------------|-----------------------------------------|-------------------------------------------------|--------------------------------------------------------|
| Extract (text) | `col #>> '{a,b}'`                       | `JSON_UNQUOTE(JSON_EXTRACT(col, '$.a.b'))`      | `json_extract(col, '$.a.b')`                           |
| Extract (JSON) | `col #> '{a,b}'`                        | `JSON_EXTRACT(col, '$.a.b')`                    | `json_extract(col, '$.a.b')` (scalar-typed in SQLite)  |
| Contains       | `col @> val::jsonb`                     | `JSON_CONTAINS(col, val, '$.path')`             | Scalar only — object values throw `OrmError`           |
| Has key        | `(col #> path) ? 'k'`                   | `JSON_CONTAINS_PATH(col, 'one', '$.path.k')`    | `json_extract(col, '$.path.k') IS NOT NULL`            |
| Array length   | `jsonb_array_length(col #> path)`       | `JSON_LENGTH(col, '$.path')`                    | `json_array_length(col, '$.path')`                     |
| Type of        | `jsonb_typeof(col #> path)`             | `JSON_TYPE(JSON_EXTRACT(col, '$.path'))`        | `json_type(col, '$.path')`                             |

#### Safety and Limits

- **SQL injection.** Every path segment, every key, every value is a bound
  parameter. A malicious `.path("'; DROP TABLE users--")` ends up as a
  string literal in the prepared statement, never as executable SQL.
- **Missing paths.** In all three dialects, extracting a missing path
  returns `NULL`. Use `.isNull()` / `.isNotNull()` or `.hasKey(...)` to
  distinguish _"not present"_ from _"present but set to null"_.
- **SQLite caveats.** Requires the `json1` extension (bundled with
  `better-sqlite3`). `json_extract` returns SQLite-typed scalars, so
  numeric comparisons like `.gt(18)` work directly without casts. Object
  containment is not supported.
- **Type erasure on `any`.** If your JSON column is typed as `any` or not
  typed at all, the proxy still works at runtime — you just lose
  property-level autocomplete at the TypeScript level.

Use this pattern whenever you catch yourself reaching for
`` em.query(sql`... ->> ${path}`) `` for a JSON filter — the QueryDSL path
is both safer and portable across every driver the ORM supports.

#### Sorting, Counting, Combining, and Matching

The examples so far parked `qAlias()` inside WHERE, but column references
show up in three other places: ORDER BY, SELECT, and HAVING. Real queries
also run into the kind of small trap where a user types `"50%"` into a
search box and silently turns the `%` into a LIKE wildcard. Four groups of
helpers on `ColumnExpression` fill those gaps:

- sorting — `.asc()` / `.desc()` with a say on where NULL rows land
- aggregates — `.count()`, `.sum()`, `.avg()`, `.min()`, `.max()` that slot
  into SELECT and HAVING using the same expression
- combining — `.and()` / `.or()` / `.not()` on any condition, plus an
  `Expressions` namespace for explicit grouping
- matching — `.startsWith()` / `.endsWith()` / `.contains()` that escape LIKE
  metacharacters before wrapping in wildcards, and `*IgnoreCase` siblings

Everything here keeps the guarantees you've already seen: column
references resolve through the alias registry (so `u.firstName` still
becomes `"u"."first_name"` under `SnakeNamingStrategy`) and every
user-supplied value — including the LIKE escape character — is a bound
parameter.

##### Ordering — `.asc()` / `.desc()` / `.nullsFirst()` / `.nullsLast()`

```typescript
const u = qAlias(User, "u");

await em.createQueryBuilder(User, "u")
  .orderBy(u.createdAt.desc().nullsLast())
  .addOrderBy(u.name.asc())
  .getMany();
```

Emits native `NULLS FIRST` / `NULLS LAST` on PostgreSQL and SQLite. MySQL
has no equivalent keyword, so Stingerloom emulates it by prefixing the
sort with `col IS NULL` ordering — you get the same result without
having to remember the workaround.

`orderBy(expr)` replaces the existing ORDER BY list; `addOrderBy(expr)`
appends. Both also still accept the legacy `{ column: "ASC" | "DESC" }`
map and the `(column, direction)` overload.

##### Aggregates — SELECT and HAVING in one expression

```typescript
const u = qAlias(User, "u");
const total = u.id.count();            // AggregateExpression

await em.createQueryBuilder(User, "u")
  .select(["departmentId"])
  .addSelect(total.as("total"))
  .groupBy(["u.departmentId"])
  .having(total.gt(10))                // AggregateCondition
  .addOrderBy(u.departmentId.asc())
  .getRawMany();
```

`ColumnExpression` exposes `.count()`, `.countDistinct()`, `.sum()`,
`.avg()`, `.min()`, `.max()`. Each returns an `AggregateExpression`
that plays two roles:

1. **In SELECT.** `.as("alias")` names the output column. If you skip it,
   Stingerloom falls back to a predictable `agg_<func>_<col>` shape
   (e.g. `agg_count_id`) so `getRawMany()` keys don't surprise you — but
   explicit aliases are worth the few extra characters.
2. **In HAVING / WHERE.** Calling `.eq`, `.neq`, `.gt`, `.gte`, `.lt`,
   `.lte`, or `.between` on the aggregate produces an
   `AggregateCondition`, which can be passed to `having()`, `where()`,
   or `andWhere()`.

Aggregates also participate in ORDER BY via `.asc()` / `.desc()`, mirroring
the ColumnExpression surface.

##### SELECT aliases — `.as("name")` on any projectable expression

`.as("alias")` works on every expression that can appear in SELECT —
plain columns, JSON path extractions, and aggregates. The result is an
`AliasedExpression` destined for `select()` or `addSelect()`; it is not
a condition, so it will not compile when handed to `where()` or
`having()`.

```typescript
const u = qAlias(User, "u");

await em.createQueryBuilder(User, "u")
  .select([
    u.name.as("display_name"),
    u.metadata.profile.email.as("contact"),
    u.id.count().as("total"),
  ])
  .groupBy(["u.name", "u.metadata"])
  .getRawMany();
// SELECT "u"."name" AS "display_name",
//        ("u"."metadata" #>> $1) AS "contact",
//        COUNT("u"."id") AS "total"
// …
```

JSON path aliases compile to the dialect's preferred text-extraction
operator (`#>>` on PostgreSQL, `JSON_UNQUOTE(JSON_EXTRACT(...))` on
MySQL, `json_extract()` on SQLite) with the path supplied as a bound
parameter — so it survives `getRawMany()` serialization and is free of
injection risk.

`addSelect(u.age.as("years"))` appends to an existing projection; mixing
aliased columns with aggregates in the same `select([...])` call is also
supported.

##### Null handling — `coalesce()` / `nullif()`

`coalesce(a, b, c, …)` returns the first non-null argument. `nullif(a,
b)` returns `NULL` when `a === b`, otherwise `a` — useful for turning a
sentinel value (empty string, `-1`, etc.) into a real `NULL`. Both are
standard SQL, so they compile identically on every dialect.

```typescript
import { coalesce, nullif, Expressions, qAlias } from "@stingerloom/orm";

const u = qAlias(User, "u");

// Display name with graceful fallback — column → column → literal
qb.select([
  u.nickname.coalesce(u.name, "anonymous").as("display_name"),
]);
// SELECT COALESCE("u"."nickname", "u"."name", $1) AS "display_name"

// Turn an empty email into NULL
qb.select([nullif(u.email, "").as("email_or_null")]);
// SELECT NULLIF("u"."email", $1) AS "email_or_null"

// Both also work in WHERE / HAVING
qb.where(coalesce(u.score, 0).gte(50));
// WHERE COALESCE("u"."score", $1) >= $2
```

Arguments accept any expression the query builder understands: column
references, JSON path extractions (`u.metadata.profile.tier`),
aggregates (`u.id.count()`), other scalar expressions (nested
`coalesce`), and plain values — bound as parameters. The result is a
`ScalarExpression`, which exposes the same `.eq()` / `.gt()` / `.as()`
surface you've already seen, so every derived expression composes.

Static helpers live on the `Expressions` namespace — `Expressions.coalesce`
and `Expressions.nullif` — mirroring Java QueryDSL for callers who
prefer the static entry point.

##### Current date/time — `currentDate()` / `currentTime()` / `currentTimestamp()`

Three small standard-SQL helpers that insert the server's clock into
any expression position. They are scalar expressions, so they compose
with everything already shown (`.as()`, `.eq()`, nested inside
`coalesce`, etc.) and emit the same literal on every dialect.

```typescript
import { Expressions, qAlias } from "@stingerloom/orm";

const s = qAlias(Session, "s");

qb.where(s.expiresAt.gte(Expressions.currentTimestamp()));
// WHERE "s"."expires_at" >= CURRENT_TIMESTAMP

qb.select([Expressions.currentDate().as("today")]);
// SELECT CURRENT_DATE AS "today"
```

`ColumnExpression` comparison methods now transparently unwrap a
`ScalarExpression` operand — so `u.createdAt.lte(currentTimestamp())`
emits an inline `CURRENT_TIMESTAMP` rather than binding the expression
as a parameter.

##### Type casts — `.stringValue()` / `.intValue()` / `.longValue()` / `.floatValue()` / `.booleanValue()`

Cast any column or scalar expression to a portable SQL type. The type
name is resolved per dialect so you don't have to remember whether
MySQL accepts `INTEGER` (it doesn't) or `SIGNED`, or whether SQLite
has a `BOOLEAN` (it doesn't — it uses `INTEGER`).

```typescript
const i = qAlias(Item, "i");

qb.select([i.quantity.stringValue().as("qty_str")]);
// PG/SQLite:  CAST("i"."quantity" AS TEXT) AS "qty_str"
// MySQL:      CAST(`i`.`quantity` AS CHAR)  AS `qty_str`

qb.where(i.sku.intValue().gt(1000));
// PG/SQLite:  CAST("i"."sku" AS INTEGER) > $1
// MySQL:      CAST(`i`.`sku` AS SIGNED)  > ?
```

The cast helpers are on both `ColumnExpression` and `ScalarExpression`
— so you can chain them onto `coalesce(u.price, 0).floatValue()` or
any other derived scalar. The result is a `ScalarExpression` itself,
so it plugs into `.as()`, `.eq()`, `.gt()`, and nested `coalesce`
without anything special.

| Kind     | MySQL      | PostgreSQL | SQLite    |
|----------|------------|------------|-----------|
| string   | `CHAR`     | `TEXT`     | `TEXT`    |
| int      | `SIGNED`   | `INTEGER`  | `INTEGER` |
| long     | `SIGNED`   | `BIGINT`   | `INTEGER` |
| float    | `DECIMAL`  | `REAL`     | `REAL`    |
| boolean  | `UNSIGNED` | `BOOLEAN`  | `INTEGER` |

##### Date / time components — `.year()` / `.month()` / `.day()` / `.hour()` / …

Extract a component from a date or timestamp column. Ten helpers
cover the common shapes — year, month, day (alias of `dayOfMonth`),
hour, minute, second, `dayOfWeek`, `dayOfMonth`, `dayOfYear`, `week`.
Each returns a `ScalarExpression`, so they drop into SELECT, WHERE,
HAVING, chain into `.as()`, and compose with cast/coalesce.

```typescript
const e = qAlias(Event, "e");

// Count events per year
qb.select([e.startsAt.year().as("yr"), e.id.count().as("total")])
  .groupBy(["e.startsAt"])
  .having(e.startsAt.year().gte(2026));
// PG:     CAST(EXTRACT(YEAR FROM "e"."starts_at") AS INTEGER) = ?
// MySQL:  YEAR(`e`.`starts_at`) = ?
// SQLite: CAST(strftime(?, "e"."starts_at") AS INTEGER) = ?   -- '%Y'
```

Dialect-specific emission (the caller never sees the difference):

| Helper | MySQL | PostgreSQL | SQLite |
|--------|-------|------------|--------|
| `year()` | `YEAR(col)` | `EXTRACT(YEAR FROM col)` | `strftime('%Y', col)` |
| `month()` | `MONTH(col)` | `EXTRACT(MONTH FROM col)` | `strftime('%m', col)` |
| `day()` / `dayOfMonth()` | `DAYOFMONTH(col)` | `EXTRACT(DAY FROM col)` | `strftime('%d', col)` |
| `hour()` | `HOUR(col)` | `EXTRACT(HOUR FROM col)` | `strftime('%H', col)` |
| `minute()` | `MINUTE(col)` | `EXTRACT(MINUTE FROM col)` | `strftime('%M', col)` |
| `second()` | `SECOND(col)` | `EXTRACT(SECOND FROM col)` | `strftime('%S', col)` |
| `dayOfWeek()` | `DAYOFWEEK(col)` | `EXTRACT(DOW FROM col)` | `strftime('%w', col)` |
| `dayOfYear()` | `DAYOFYEAR(col)` | `EXTRACT(DOY FROM col)` | `strftime('%j', col)` |
| `week()` | `WEEK(col)` | `EXTRACT(WEEK FROM col)` | `strftime('%W', col)` |

`dayOfWeek` and `week` encodings differ slightly between engines —
MySQL uses `1=Sun…7=Sat` for `DAYOFWEEK`, PostgreSQL `0=Sun…6=Sat`
for `DOW`, and SQLite matches PostgreSQL via `%w`. If portability
within your reports matters, normalize in the application layer or
use dialect-specific raw SQL.

##### Subquery comparisons — `.in(subquery)` / `.eq(subquery)` / `exists` / `notExists`

`ColumnExpression.in()` / `.notIn()` accept either a value list
(existing behavior) or a `SelectQueryBuilder` — the latter embeds as
`col IN (SELECT ...)` with all inner bindings preserved. All scalar
comparison methods (`.eq` / `.neq` / `.gt` / `.gte` / `.lt` / `.lte`)
likewise accept a subquery and emit `col <op> (SELECT ...)` for
one-row-one-column scalar subqueries.

```typescript
const u = qAlias(User, "u");
const p = qAlias(Post, "p");

// Users whose id appears in the authorId column of published posts
const activeAuthors = em
  .createQueryBuilder(Post, "p")
  .select(["authorId"])
  .where(p.status.eq("published"));

qb.where(u.id.in(activeAuthors));
// WHERE "u"."id" IN (SELECT "p"."authorId" FROM "post" AS "p"
//                     WHERE "p"."status" = $1)

// Scalar subquery — compare against a single aggregate
const avgViews = em
  .createQueryBuilder(Post, "p2")
  .selectRaw(["AVG(p2.views)"]);

qb.where(p.views.gt(avgViews));
// WHERE "p"."views" > (SELECT AVG(p2.views) FROM …)
```

`Expressions.exists(subQb)` and `Expressions.notExists(subQb)` build
correlated-subquery conditions:

```typescript
qb.where(Expressions.exists(em.createQueryBuilder(Post, "p")
  .select(["id"])
  .where(sql`"p"."author_id" = "u"."id"`)));
// WHERE EXISTS (SELECT "id" FROM "post" AS "p"
//                WHERE "p"."author_id" = "u"."id")
```

`ExistsCondition.not()` toggles the `EXISTS` / `NOT EXISTS` flag
rather than wrapping in a redundant `NOT (…)`, keeping output SQL
clean.

##### `CASE WHEN … THEN …` — `Expressions.caseBuilder()` / `Expressions.cases(...)`

Two fluent builders cover the two forms SQL supports:

**Searched CASE** — `caseBuilder()` reads like a guard chain. Each
branch is a `ConditionLike` paired with a result value; end with an
optional `otherwise(default)` and call `.end()` to finalize.

```typescript
const u = qAlias(User, "u");

const tier = Expressions.caseBuilder()
  .when(u.score.gte(90)).then("gold")
  .when(u.score.gte(70)).then("silver")
  .otherwise("bronze")
  .end();

qb.select([tier.as("tier")]);
// SELECT CASE WHEN "u"."score" >= $1 THEN $2
//             WHEN "u"."score" >= $3 THEN $4
//             ELSE $5 END AS "tier"
```

**Simple CASE** — `cases(subject)` is the switch-style form, matching
the subject against each candidate value:

```typescript
const weight = Expressions.cases(u.status)
  .when("active",  1)
  .when("pending", 0)
  .otherwise(-1)
  .end();

qb.select([weight.as("w")]);
// SELECT CASE "u"."status" WHEN $1 THEN $2
//                           WHEN $3 THEN $4
//                           ELSE $5 END AS "w"
```

`end()` returns a `ScalarExpression`, so the result feeds every
downstream builder you've already seen — cast it (`.stringValue()`),
alias it (`.as("tier")`), compare it in a condition (`.eq("gold")`),
nest it in `coalesce(...)`, or pass it to another `CASE` branch as a
result.

Misuse-guard: `.when()` after `.otherwise()`, duplicate `.otherwise()`,
or `.end()` with no branches each throw an explanatory error early,
rather than producing malformed SQL.

##### String, numeric & math — JS-idiomatic helpers

Tier 3's string/numeric/math helpers borrow the names already in a
TypeScript developer's muscle memory — `String.prototype`, arithmetic
operators, and `Math.*`. Each returns a `ScalarExpression`, so they
flow into `.as()`, cast, coalesce, comparisons, and the rest of the
Tier 2 surface.

```typescript
const p = qAlias(Product, "p");

qb.select([
  p.name.toLowerCase().as("name_lc"),            // LOWER("p"."name")
  p.name.substring(0, 10).as("preview"),         // SUBSTR("p"."name", 1, 10)
  p.name.concat(" — ", p.sku).as("label"),       // CONCAT("p"."name", ' — ', "p"."sku")
  p.price.mul(0.9).round(2).as("discounted"),    // ROUND(("p"."price" * 0.9), 2)
  p.stock.abs().as("stock_abs"),                  // ABS("p"."stock")
])
.where(p.name.length().gt(20));                   // CHAR_LENGTH("p"."name") > 20
```

Method coverage:

| Category | Methods |
|----------|---------|
| String | `.toLowerCase()`, `.toUpperCase()`, `.trim()`, `.length()`, `.substring(start, end?)`, `.concat(...args)`, `.indexOf(needle)`, `.replace(from, to)` |
| Arithmetic | `.add(x)`, `.sub(x)`, `.mul(x)`, `.div(x)`, `.mod(x)`, `.neg()` |
| Math | `.abs()`, `.floor()`, `.ceil()`, `.round(digits?)`, `.sqrt()` |

Behavior notes worth knowing:

- **`substring`** matches JS semantics (0-based, end exclusive). The
  helper converts to SQL's 1-based `SUBSTR(col, start + 1, end - start)`.
- **`length`** uses `CHAR_LENGTH` (character count) rather than byte
  length — multibyte safe on every dialect.
- **`indexOf`** returns `-1` when the needle is missing and a 0-based
  position otherwise — dialect-specific (`STRPOS` / `LOCATE` / `INSTR`)
  shifted down by 1 so it matches `String.prototype.indexOf`.
- **`mod`** uses the SQL `%` operator; results match JS for positive
  operands. For negative values the sign semantics vary per engine
  (PostgreSQL keeps the dividend's sign, MySQL/SQLite match JS).

All operands accept either primitives (bound as parameters) or other
column/scalar expressions — so `p.price.add(p.discount)` or
`p.name.concat(" (", p.sku, ")")` compose naturally.

##### Date arithmetic — `.addDays()` / `.addMonths()` / …, `dateDiff`, `random`

`ColumnExpression` and `ScalarExpression` gain six add-* helpers for
the usual calendar units, `Expressions.dateDiff(a, b, unit)` returns
an integer difference, and `Expressions.random()` wraps the engine's
RNG. Together they cover reporting queries that don't want to resort
to raw SQL.

```typescript
const e = qAlias(Event, "e");

qb.select([
  e.startsAt.addDays(7).as("next_week"),
  e.startsAt.addMonths(-1).as("prev_month"),
  Expressions.dateDiff(e.endsAt, e.startsAt, "day").as("span_days"),
  Expressions.random().as("r"),
]);
```

Dialect mapping:

| Operation | MySQL | PostgreSQL | SQLite |
|-----------|-------|------------|--------|
| `addDays(7)` | `DATE_ADD(col, INTERVAL 7 DAY)` | `(col + (7 * INTERVAL '1 day'))` | `datetime(col, '+7 days')` |
| `dateDiff(a, b, "day")` | `TIMESTAMPDIFF(DAY, b, a)` | `CAST(EXTRACT(EPOCH FROM (a - b)) / 86400 AS INTEGER)` | `CAST((julianday(a) - julianday(b)) * 1 AS INTEGER)` |
| `dateDiff(a, b, "year")` | `TIMESTAMPDIFF(YEAR, b, a)` | calendar-aware `age()` | `julianday() / 365.25` (approx.) |
| `random()` | `RAND()` | `RANDOM()` | `RANDOM()` |

Year / month differences on SQLite are approximations (365.25 /
30.4375 days). Use `TIMESTAMPDIFF` or `age()` targets for exact
calendar math.

##### Window functions — `aggregate.over()` + `WindowBuilder`

Every aggregate (`count`, `sum`, `avg`, `min`, `max`, `countDistinct`)
exposes `.over()` that returns a chainable `WindowBuilder`.

```typescript
const e = qAlias(Event, "e");

qb.select([
  e.score.sum().over()
    .partitionBy(e.teamId)
    .orderBy(e.createdAt.desc())
    .rowsBetween("UNBOUNDED PRECEDING", "CURRENT ROW")
    .as("running_total"),
]);
// SUM("e"."score") OVER (PARTITION BY "e"."teamId"
//                        ORDER BY "e"."createdAt" DESC
//                        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
// AS "running_total"
```

Terminals:
- `.as("alias")` — finalize as an `AliasedExpression` for SELECT.
- `.toScalar()` — finalize as a `ScalarExpression` (for nesting,
  e.g. `qb.where(e.score.gt(avg.over().partitionBy(e.teamId).toScalar()))`).

Frame clauses accept raw SQL strings for `ROWS` / `RANGE` — callers
are responsible for ensuring they're safe (do not pass user input).
`rowsBetween("UNBOUNDED PRECEDING", "CURRENT ROW")` is the common
cumulative-aggregate frame.

##### Logical composition — `.and()` / `.or()` / `.not()` + `Expressions`

```typescript
const u = qAlias(User, "u");

// Method chain — left-to-right grouping: (age >= 18 AND status = 'active')
qb.where(u.age.gte(18).and(u.status.eq("active")));

// OR across role variants
qb.where(u.role.eq("admin").or(u.role.eq("owner")));

// Negation
qb.where(u.deletedAt.isNull().not());      // equivalent to u.deletedAt.isNotNull()

// Static helpers when you need explicit grouping
import { Expressions } from "@stingerloom/orm";

qb.where(
  Expressions.or(
    Expressions.and(u.age.gte(18), u.status.eq("active")),
    u.role.eq("admin"),
  ),
);
// WHERE (("u"."age" >= $1 AND "u"."status" = $2) OR "u"."role" = $3)
```

Every condition type — `ColumnCondition`, `JsonPathCondition`,
`AggregateCondition`, and nested `LogicalCondition` — implements a
common `ConditionLike` contract, so you can compose across them freely:

```typescript
qb.where(
  Expressions.and(
    u.status.eq("active"),
    u.profile.tags.contains("admin"),     // JsonPathCondition
  ),
);
```

Associativity follows JavaScript method-chain rules: `a.and(b).or(c)` is
`(a AND b) OR c`. For different grouping, wrap with
`Expressions.or(...)` / `Expressions.and(...)` explicitly.

Consecutive ANDs (and ORs) are flattened in the emitted SQL — you don't
get nested parens for every chain step.

##### String convenience — `.startsWith` / `.endsWith` / `.contains` + `*IgnoreCase`

Case-sensitive substring matching with automatic wildcard escaping:

```typescript
qb.where(u.name.startsWith("Al"));       // LIKE 'Al%' ESCAPE '\'
qb.where(u.name.endsWith("son"));        // LIKE '%son' ESCAPE '\'
qb.where(u.name.contains("lic"));        // LIKE '%lic%' ESCAPE '\'
```

These **escape `%`, `_`, and `\`** in the caller-supplied value before
wrapping it in wildcards. A literal `"50%"` stays literal — it does not
match `"501"`, `"502"`, `"50A"`, etc.:

```typescript
qb.where(u.name.startsWith("50%"));
// SQL:  "u"."name" LIKE $1 ESCAPE $2
// params: ["50\\%%", "\\"]     -- the user's % is escaped, only the
//                                 trailing % remains as wildcard
```

Case-insensitive variants:

```typescript
qb.where(u.username.equalsIgnoreCase("alice"));
// LOWER("u"."username") = LOWER($1)        — all dialects

qb.where(u.email.containsIgnoreCase("@gmail"));
// Postgres:      "u"."email" ILIKE $1 ESCAPE $2
// MySQL/SQLite:  LOWER("u"."email") LIKE LOWER($1) ESCAPE $2
```

`equalsIgnoreCase` uses `LOWER()` on both sides for a collation-
independent result on every dialect. The LIKE family uses `ILIKE`
natively on PostgreSQL and falls back to `LOWER(col) LIKE LOWER(pattern)`
elsewhere — so `utf8mb4_bin` collation on MySQL and the ASCII-only
default LIKE on SQLite both produce the right answer without the caller
having to know.

Method summary:

| Category              | Methods                                                                                         |
|-----------------------|-------------------------------------------------------------------------------------------------|
| String (case-sens.)   | `.startsWith`, `.endsWith`, `.contains`                                                         |
| String (case-insens.) | `.equalsIgnoreCase`, `.likeIgnoreCase`, `.startsWithIgnoreCase`, `.endsWithIgnoreCase`, `.containsIgnoreCase` |
| Ordering              | `.asc()`, `.desc()`, `.nullsFirst()`, `.nullsLast()`                                            |
| Aggregates            | `.count()`, `.countDistinct()`, `.sum()`, `.avg()`, `.min()`, `.max()` — each with `.as(alias)` and `.eq/.neq/.gt/.gte/.lt/.lte/.between` |
| SELECT alias          | `.as("name")` on columns, JSON path extracts, and aggregates — produces `AliasedExpression` |
| Null handling         | `coalesce(…)`, `nullif(a, b)`, `col.coalesce(…)`, `Expressions.coalesce`, `Expressions.nullif` |
| Current date / time   | `currentDate()`, `currentTime()`, `currentTimestamp()` — also on `Expressions`                 |
| Type casts            | `.stringValue()`, `.intValue()`, `.longValue()`, `.floatValue()`, `.booleanValue()` — dialect-specific type names |
| Date components       | `.year()`, `.month()`, `.day()`, `.hour()`, `.minute()`, `.second()`, `.dayOfWeek()`, `.dayOfMonth()`, `.dayOfYear()`, `.week()` |
| Subquery compare      | `.in(subQb)`, `.notIn(subQb)`, `.eq/.neq/.gt/.gte/.lt/.lte(subQb)`, `Expressions.exists`, `Expressions.notExists` |
| CASE expressions      | `Expressions.caseBuilder().when(...).then(...).otherwise(...).end()`; `Expressions.cases(subject).when(val, result)...end()` |
| String / numeric / math | `.toLowerCase()`, `.toUpperCase()`, `.trim()`, `.length()`, `.substring()`, `.concat()`, `.indexOf()`, `.replace()`, `.add/.sub/.mul/.div/.mod/.neg`, `.abs/.floor/.ceil/.round/.sqrt` |
| Date arithmetic       | `.addYears/Months/Days/Hours/Minutes/Seconds(n)`, `Expressions.dateDiff(a, b, unit)`, `Expressions.random()` |
| Window functions      | `aggregate.over().partitionBy(...).orderBy(...).rowsBetween(start, end).as("alias")` — `WindowBuilder` chain |
| Logical composition   | `ColumnCondition.and/.or/.not`, `Expressions.and`, `Expressions.or`, `Expressions.not`          |

### JOIN — Combining Tables

This is where the query builder really shines. Stingerloom provides three levels of JOIN support, from fully automatic to raw SQL.

#### Typed Column References with `alias()`

Before diving into joins, let's introduce a helper that makes cross-entity queries type-safe.

When you join tables, you reference columns from multiple entities — `"p.authorId"`, `"u.firstName"`, etc. These are plain strings with no autocomplete. The `alias()` function fixes this:

```typescript
import { alias } from "@stingerloom/orm";

const p = alias(Post, "p");
const u = alias(User, "u");

p.col("authorId");   // returns "p.authorId" — with autocomplete ✓
u.col("firstName");  // returns "u.firstName" — with autocomplete ✓
u.col("typo");       // ✗ compile error — "typo" is not keyof User
```

`alias()` creates a typed reference. The `.col()` method constrains its argument to `keyof T` (so TypeScript auto-completes property names), and returns the `"alias.property"` string that the query builder understands. At runtime, this string is resolved to the actual DB column name via the alias registry.

You can use `alias()` references everywhere — `where()`, `selectRaw()`, `addOrderBy()`, `whereIn()`, `JoinOnBuilder.on()`, etc.

#### QueryDSL-Style Expressions with `qAlias()`

For an even more expressive API, `qAlias()` lets you access entity properties directly and chain condition methods — similar to JPA QueryDSL's `QUser` classes, but without code generation.

```typescript
import { qAlias } from "@stingerloom/orm";

const u = qAlias(User, "u");
const p = qAlias(Post, "p");

const posts = await em
  .createQueryBuilder(Post, "p")
  .leftJoin(User, "u", (j) => j.on(p.col("authorId"), "=", u.col("id")))
  .where(u.firstName.eq("Alice"))           // u.firstName auto-completes ✓
  .where(u.age.gte(18))                     // .gte() → >= operator
  .where(p.status.in(["active", "draft"]))  // .in() → IN (...)
  .where(u.deletedAt.isNull())              // .isNull() → IS NULL
  .getRawMany();
```

Every entity property becomes a `ColumnExpression` with these methods:

| Method | SQL | Example |
|--------|-----|---------|
| `.eq(value)` | `= ?` | `u.name.eq("Alice")` |
| `.neq(value)` | `!= ?` | `u.role.neq("guest")` |
| `.gt(value)` | `> ?` | `u.age.gt(18)` |
| `.gte(value)` | `>= ?` | `u.age.gte(18)` |
| `.lt(value)` | `< ?` | `u.age.lt(65)` |
| `.lte(value)` | `<= ?` | `u.age.lte(65)` |
| `.like(pattern)` | `LIKE ?` | `u.name.like("%John%")` |
| `.notLike(pattern)` | `NOT LIKE ?` | `u.name.notLike("%bot%")` |
| `.in(values)` | `IN (?, ?, ...)` | `u.id.in([1, 2, 3])` |
| `.notIn(values)` | `NOT IN (...)` | `u.id.notIn([999])` |
| `.isNull()` | `IS NULL` | `u.deletedAt.isNull()` |
| `.isNotNull()` | `IS NOT NULL` | `u.email.isNotNull()` |
| `.between(min, max)` | `BETWEEN ? AND ?` | `u.age.between(18, 65)` |

Each method returns a `ColumnCondition` that the query builder resolves through its alias registry — SnakeNamingStrategy is fully supported.

`qAlias()` also supports `.col()` from `alias()`, so you can mix styles:

```typescript
const u = qAlias(User, "u");
qb.where(u.firstName.eq("Alice"))     // QueryDSL style
  .addOrderBy(u.col("lastName"), "ASC") // alias() style — both work
```

#### Entity-Aware Joins (Recommended)

The best way to join tables is by passing the **entity class** directly. The ORM automatically resolves the table name and lets you reference columns using camelCase property names.

```typescript
const p = alias(Post, "p");
const u = alias(User, "u");

const posts = await em
  .createQueryBuilder(Post, "p")
  .leftJoin(User, "u", (join) =>
    join.on(p.col("authorId"), "=", u.col("id"))
  )
  .selectRaw([p.col("title"), u.col("name")])
  .where(u.col("age"), ">=", 18)
  .orderBy({ createdAt: "DESC" })
  .limit(20)
  .getRawMany();
```

What's happening here:

- `leftJoin(User, "u", ...)` — the first argument is the **entity class**, not a table name string. The ORM resolves the actual table name (`user`) and registers the `"u"` alias in its internal registry.
- `join.on(p.col("authorId"), "=", u.col("id"))` — the ON condition uses **typed property references** with autocomplete. If you're using `SnakeNamingStrategy`, `authorId` is automatically translated to `author_id` in the generated SQL.
- `selectRaw([p.col("title"), u.col("name")])` — cross-entity column selection with autocomplete.
- `where(u.col("age"), ">=", 18)` — WHERE conditions can also reference joined entity columns.

With `qAlias()`, the same query uses QueryDSL-style expressions for WHERE conditions:

```typescript
const p = qAlias(Post, "p");
const u = qAlias(User, "u");

const posts = await em
  .createQueryBuilder(Post, "p")
  .leftJoin(User, "u", (join) =>
    join.on(p.col("authorId"), "=", u.col("id"))
  )
  .selectRaw([p.col("title"), u.col("name")])
  .where(u.age.gte(18))              // QueryDSL style — auto-complete on both property and method
  .orderBy({ createdAt: "DESC" })
  .limit(20)
  .getRawMany();
```

::: tip
Three styles are available — all equivalent at runtime:
- `where("u.age", ">=", 18)` — string literal, no autocomplete
- `where(u.col("age"), ">=", 18)` — `alias()` / `qAlias()` `.col()`, property autocomplete
- `where(u.age.gte(18))` — `qAlias()` QueryDSL, property + operator autocomplete
:::

The `JoinOnBuilder` callback supports multiple conditions and literal values:

```typescript
qb.leftJoin(User, "u", (join) =>
  join
    .on(p.col("authorId"), "=", u.col("id"))       // column = column
    .andOn(u.col("status"), "=", p.col("status"))   // additional condition
    .onVal(u.col("isActive"), "=", true)             // column = literal value
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

#### JoinAndSelect — Join + Auto SELECT

When you want to include all columns from the joined entity in the result, use the `*AndSelect` variants. This is equivalent to doing a join + manually selecting every column — but in one call.

```typescript
// Before: manual join + selectRaw
qb.leftJoin(User, "u", (j) => j.on("p.authorId", "=", "u.id"))
  .selectRaw(["p.id", "p.title", "u.id", "u.name", "u.email"]);

// After: joinAndSelect does it automatically
const results = await em
  .createQueryBuilder(Post, "p")
  .leftJoinAndSelect(User, "u", (j) => j.on("p.authorId", "=", "u.id"))
  .where("p.status", "published")
  .getRawMany();
// [{ id: 1, title: "...", id: 1, name: "Alice", email: "..." }, ...]
```

All `*AndSelect` variants:

| Method | Description |
|--------|-------------|
| `leftJoinAndSelect(Entity, alias, onBuilder)` | LEFT JOIN + auto SELECT all joined columns |
| `innerJoinAndSelect(Entity, alias, onBuilder)` | INNER JOIN + auto SELECT all joined columns |
| `leftJoinRelationAndSelect(property, alias)` | Relation LEFT JOIN + auto SELECT |
| `innerJoinRelationAndSelect(property, alias)` | Relation INNER JOIN + auto SELECT |

Relation-based example:

```typescript
const results = await em
  .createQueryBuilder(Post, "p")
  .leftJoinRelationAndSelect("author", "u")
  .getRawMany();
```

#### String-Based Joins (Raw)

For cases where you don't have entity metadata (joining a view, a subquery, or a raw table), you can still pass a string table name.

```typescript
qb.leftJoin("audit_log", "al", sql`"p"."id" = "al"."post_id"`);
```

This is the original API and remains fully supported.

#### Multi-Table Joins

Chain multiple joins to traverse a graph of entities:

```typescript
const p = qAlias(Post, "p");
const u = qAlias(User, "u");
const c = qAlias(Comment, "c");

const results = await em
  .createQueryBuilder(Post, "p")
  .leftJoin(User, "u", (j) => j.on(p.col("authorId"), "=", u.col("id")))
  .leftJoin(Comment, "c", (j) => j.on(c.col("postId"), "=", p.col("id")))
  .selectRaw([p.col("title"), u.col("name"), c.col("content")])
  .where(u.age.gte(18))                   // QueryDSL style
  .where(c.content.isNotNull())            // QueryDSL style
  .addOrderBy(u.col("name"), "ASC")
  .limit(50)
  .getRawMany();
```

#### Cross-Entity Column Resolution

Once an entity is joined (via entity-aware or relation-based join), you can reference its columns anywhere. Use `alias()` for autocomplete, or string literals for brevity — both work identically at runtime.

**Using `qAlias()` (QueryDSL style):**

```typescript
const u = qAlias(User, "u");
const p = qAlias(Post, "p");

// WHERE — QueryDSL expressions (property + operator autocomplete)
qb.where(u.name.eq("Alice"));                     // equals
qb.where(u.age.gte(18));                           // >=
qb.where(u.id.in([1, 2, 3]));                     // IN
qb.where(u.deletedAt.isNull());                   // IS NULL
qb.where(u.email.isNotNull());                    // IS NOT NULL
qb.where(u.age.between(18, 65));                  // BETWEEN
qb.where(u.name.like("%alice%"));                 // LIKE

// SELECT — .col() for column references
qb.selectRaw([p.col("title"), u.col("name")]);
qb.addSelect(u.col("email"), "authorEmail");

// ORDER BY / GROUP BY — .col() style
qb.addOrderBy(u.col("name"), "ASC");
qb.groupBy([u.col("id"), p.col("category")]);
```

**Using `alias()` (.col() style):**

```typescript
const u = alias(User, "u");
const p = alias(Post, "p");

qb.where(u.col("name"), "Alice");
qb.where(u.col("age"), ">=", 18);
qb.whereIn(u.col("id"), [1, 2, 3]);
```

All references are resolved through the alias registry — `u.col("firstName")` or `u.firstName.eq(...)` both become `"u"."first_name"` when using `SnakeNamingStrategy`.

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

#### Aggregate Functions in SELECT

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
  .addOrderBy("postCount", "DESC")
  .getRawMany();
// [{ name: "Alice", postCount: 12, avgLikes: 45.3 }, ...]
```

### Subqueries

The query builder supports subqueries in WHERE, SELECT, and FROM clauses. While `find()` can't express subqueries at all, the query builder makes them straightforward.

#### WHERE IN Subquery

Use `Conditions.inSubquery()` or pass a built `Sql` object from another query builder:

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

#### WHERE EXISTS / NOT EXISTS

Use `Conditions.exists()` or `Conditions.notExists()` for correlated subqueries:

```typescript
// Find authors who have at least one published post
const posts = await em
  .createQueryBuilder(Post, "p")
  .where("authorId", sql`"a"."id"`)
  .where("status", "published")
  .toSql();

const authors = await em
  .createQueryBuilder(User, "a")
  .where(Conditions.exists(sql`(SELECT 1 FROM "post" "p" WHERE "p"."author_id" = "a"."id" AND "p"."status" = ${"published"})`))
  .getMany();
```

#### Scalar Subquery in SELECT

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

#### FROM Subquery (Derived Table)

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
    .from(inner.asSubquery("sub").sql)
    .where([sql`"sub"."cnt" >= ${3}`])
    .build()
);
// Authors with 3+ posts
```

#### CTE (Common Table Expressions)

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

This section covers the productivity features that make Stingerloom's query builder stand out.

---

## Conditional Building — when()

The most common boilerplate in query builders is `if/else` blocks for optional filters. `when()` eliminates them:

```typescript
when(condition, fn)         // call fn only if condition is truthy
when(condition, fn, elseFn) // call fn if truthy, elseFn if falsy
```

The condition can be a boolean or a lazy function `() => boolean`:

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .when(!!searchName, (qb) =>
    qb.where("name", "LIKE", `%${searchName}%`)
  )
  .when(onlyActive, (qb) => qb.where("status", "active"))
  .when(sortByAge,
    (qb) => qb.orderBy({ age: "ASC" }),
    (qb) => qb.orderBy({ createdAt: "DESC" }),  // else branch
  )
  .getMany();
```

`when()` always returns `this`, so chaining continues regardless of which branch runs.

---

## Grouped Conditions — andWhereGroup() / orWhereGroup()

Sometimes you need parenthesized groups: `WHERE status = 'active' OR (role = 'admin' AND verified = true)`. Without grouping, the precedence would be wrong. `andWhereGroup()` and `orWhereGroup()` solve this:

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .where("status", "active")
  .orWhereGroup((g) =>
    g.where("role", "admin").where("verified", true)
  )
  .getMany();
// WHERE "status" = 'active' OR ("role" = 'admin' AND "verified" = true)
```

```typescript
// AND group: all conditions inside the group are AND-ed together
qb.where("active", true)
  .andWhereGroup((g) =>
    g.where("age", ">=", 18)
     .where("role", "user")
  );
// WHERE "active" = true AND ("age" >= 18 AND "role" = 'user')
```

The group builder supports the same WHERE helpers as the main builder: `whereIn()`, `whereNull()`, `whereNotNull()`, `whereBetween()`, `whereLike()`.

```typescript
qb.where("status", "active")
  .orWhereGroup((g) =>
    g.whereIn("role", ["admin", "moderator"])
     .whereBetween("age", 25, 55)
  );
```

---

## Composable Transforms — pipe()

`pipe()` lets you extract reusable query logic into standalone functions and compose them:

```typescript
// Define reusable transforms
function withPagination<T>(page: number, size: number) {
  return (qb: SelectQueryBuilder<T>) =>
    qb.offset((page - 1) * size).limit(size);
}

function withActiveFilter<T>(qb: SelectQueryBuilder<T>) {
  return qb.where("deletedAt", "IS NULL", null);
}

// Compose them
const users = await repo
  .createQueryBuilder("u")
  .pipe(withActiveFilter)
  .pipe(withPagination(2, 20))
  .getMany();
```

This pattern is powerful for keeping services DRY. Define your project's common query patterns once, then `pipe()` them everywhere.

---

## Relation-Aware Queries

### whereHas() / whereNotHas() — Filter by Relation Existence

`whereHas()` generates an `EXISTS` subquery from your entity's relation metadata. No manual SQL needed:

```typescript
// Posts that have at least one comment
const posts = await em
  .createQueryBuilder(Post, "p")
  .whereHas("comments")
  .getMany();
// WHERE EXISTS (SELECT 1 FROM comment WHERE comment.post_id = p.id)
```

Pass a callback to add conditions on the related entity:

```typescript
// Posts with recent comments
const posts = await em
  .createQueryBuilder(Post, "p")
  .whereHas("comments", (sub) =>
    sub.where("createdAt", ">=", sevenDaysAgo)
  )
  .getMany();
```

`whereNotHas()` generates `NOT EXISTS`:

```typescript
// Posts without any comments
const drafts = await em
  .createQueryBuilder(Post, "p")
  .whereNotHas("comments")
  .getMany();
```

Works with `@ManyToOne`, `@OneToMany`, and `@OneToOne` relations. The correlation condition is resolved automatically from your decorator metadata.

### withCount() — Relation Count as Column

Add a relation count as a scalar subquery in SELECT:

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .withCount("posts")                // default alias: "posts_count"
  .withCount("posts", "activeCount", (sub) =>
    sub.where("status", "published") // only count published posts
  )
  .orderBy({ posts_count: "DESC" } as any)
  .getRawMany();
// SELECT "u".*, (SELECT COUNT(*) FROM post ...) AS "posts_count", ...
```

### loadRelation() — Quick Relation Loading

A concise shorthand for `leftJoinRelationAndSelect()`:

```typescript
// Instead of:
qb.leftJoinRelationAndSelect("author", "author")
  .leftJoinRelationAndSelect("comments", "comments");

// Write:
qb.loadRelation("author").loadRelation("comments");
```

---

## Subquery Integration

### whereInSubquery() / whereNotInSubquery()

Use a `SelectQueryBuilder` as a subquery in `WHERE IN`:

```typescript
const activeUserIds = em
  .createQueryBuilder(User, "u2")
  .select(["id"])
  .where("status", "active");

const posts = await em
  .createQueryBuilder(Post, "p")
  .whereInSubquery("authorId", activeUserIds)
  .getMany();
// WHERE "p"."author_id" IN (SELECT "u2"."id" FROM "user" AS "u2" WHERE ...)
```

### whereExistsSubquery() / whereNotExistsSubquery()

Use a `SelectQueryBuilder` as an `EXISTS` subquery:

```typescript
const correlated = em
  .createQueryBuilder(Order, "o")
  .select(["id"])
  .where(sql`"o"."user_id" = "u"."id"`)
  .where("total", ">=", 100);

const bigSpenders = await em
  .createQueryBuilder(User, "u")
  .whereExistsSubquery(correlated)
  .getMany();
```

### addSelectSubquery() — Scalar Subquery in SELECT

Add a correlated subquery as a computed column:

```typescript
const latestComment = em
  .createQueryBuilder(Comment, "c")
  .select(["content"])
  .where(sql`"c"."post_id" = "p"."id"`)
  .orderBy({ createdAt: "DESC" })
  .limit(1);

const posts = await em
  .createQueryBuilder(Post, "p")
  .addSelectSubquery(latestComment, "latestComment")
  .getRawMany();
// SELECT "p".*, (SELECT ... LIMIT 1) AS "latestComment" FROM ...
```

---

## Scopes — Reusable Query Fragments

Define named scopes as a static property on your entity:

```typescript
@Entity()
class User {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar" }) name!: string;
  @Column({ type: "varchar" }) status!: string;

  static scopes = {
    active: (qb: SelectQueryBuilder<User>) =>
      qb.where("status", "active"),
    recent: (qb: SelectQueryBuilder<User>) =>
      qb.orderBy({ createdAt: "DESC" }).limit(10),
    verified: (qb: SelectQueryBuilder<User>) =>
      qb.where("emailVerified", true),
  };
}
```

Apply them with `applyScope()`:

```typescript
const users = await repo
  .createQueryBuilder("u")
  .applyScope("active")
  .applyScope("recent")
  .getMany();
```

Scopes compose with all other builder methods — `where()`, `when()`, `pipe()`, `whereHas()`, etc. They're just functions that receive the query builder.

Calling `applyScope()` with a non-existent name throws an `OrmError` listing the available scopes.

---

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
