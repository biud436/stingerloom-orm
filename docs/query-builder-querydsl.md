# Query Builder — QueryDSL Expressions

This page documents the `qAlias()` expression surface — the QueryDSL-style
API that turns entity property access into typed SQL expressions. If you've
used JPA QueryDSL's `QUser` classes, the mental model is identical. Unlike
JPA, Stingerloom does not need a code generator — the whole thing is a
TypeScript `Proxy`.

## The Road to `qAlias()`

Before this surface existed, the query builder had two ways of referring to
a column:

```typescript
qb.where("firstName", "Alice")                        // stringly-typed
qb.where(alias(User, "u").col("firstName"), "Alice")  // alias() — autocomplete on column name
```

Both still require you to spell the operator yourself (`"="`, `"LIKE"`, …).
JPA users will recognise the next step: code-generate a `QUser` class with
typed fields, and write `qUser.firstName.eq("Alice")`. JPA's QueryDSL does
exactly that — but it needs a build-time code generator.

**`qAlias()` is the TypeScript equivalent without the codegen.** It returns
a `Proxy` that pretends to have every entity property as a
`ColumnExpression`:

```typescript
const u = qAlias(User, "u");
qb.where(u.firstName.eq("Alice"));
//         │         └── operator method on ColumnExpression
//         └── proxy-intercepted property access → "u.firstName"
```

At runtime there is no `u.firstName` object — the proxy's `get` trap
creates a `ColumnExpression("u.firstName")` on the fly, `.eq("Alice")`
wraps it into a deferred `ColumnCondition`, and the query builder resolves
`"u.firstName"` to `"u"."first_name"` at build time (respecting
`SnakeNamingStrategy`).

JSON columns get a parallel proxy — see
[JSON Navigation](./query-builder-json.md) for the details.

## `alias()` vs. `qAlias()`

Both produce typed column references. Pick based on whether you also want
operator autocomplete:

```typescript
import { alias, qAlias } from "@stingerloom/orm";

const u1 = alias(User, "u");
u1.col("firstName");          // "u.firstName" — property autocomplete only

const u2 = qAlias(User, "u");
u2.firstName.eq("Alice");     // property + operator autocomplete
u2.col("firstName");          // also works — `.col()` is available on qAlias
```

You can freely mix styles inside the same query builder call chain.

## Method Overview

Column references from `qAlias()` ultimately compose into four kinds of
expression:

- **Sorting** — `.asc()` / `.desc()` with a say on where NULL rows land
- **Aggregates** — `.count()`, `.sum()`, `.avg()`, `.min()`, `.max()` that
  slot into SELECT and HAVING using the same expression
- **Combining** — `.and()` / `.or()` / `.not()` on any condition, plus an
  `Expressions` namespace for explicit grouping
- **Matching** — `.startsWith()` / `.endsWith()` / `.contains()` that
  escape LIKE metacharacters before wrapping in wildcards, and
  `*IgnoreCase` siblings

Everything here keeps the guarantees you've already seen: column
references resolve through the alias registry (so `u.firstName` still
becomes `"u"."first_name"` under `SnakeNamingStrategy`) and every
user-supplied value — including the LIKE escape character — is a bound
parameter.

## Ordering — `.asc()` / `.desc()` / `.nullsFirst()` / `.nullsLast()`

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

## Aggregates — SELECT and HAVING in one expression

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

## SELECT aliases — `.as("name")` on any projectable expression

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

## Null handling — `coalesce()` / `nullif()`

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

## Current date/time — `currentDate()` / `currentTime()` / `currentTimestamp()`

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

## Type casts — `.stringValue()` / `.intValue()` / `.longValue()` / `.floatValue()` / `.booleanValue()`

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

## Date / time components — `.year()` / `.month()` / `.day()` / `.hour()` / …

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

## Subquery comparisons — `.in(subquery)` / `.eq(subquery)` / `exists` / `notExists`

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

## `CASE WHEN … THEN …` — `Expressions.caseBuilder()` / `Expressions.cases(...)`

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

## String, numeric & math — JS-idiomatic helpers

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

## Date arithmetic — `.addDays()` / `.addMonths()` / …, `dateDiff`, `random`

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

## Window functions — `aggregate.over()` + `WindowBuilder`

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

## TS-native escape hatches — `Expressions.raw<T>()` / `.bigintValue()` / `qb.selectSchema(...)`

Three helpers specifically tuned to TypeScript ergonomics:

**`Expressions.raw<T>(fragment)`** — wrap any `sql-template-tag` `Sql`
fragment as a `ScalarExpression`, threading it through the Tier 2/3
composition surface. The generic `T` documents the intended return
type for downstream chains (`rawInt.gt(0)` reads as intended) but is
not runtime-enforced.

```typescript
import sql from "sql-template-tag";
import { Expressions, qAlias } from "@stingerloom/orm";

const u = qAlias(User, "u");

const epoch = Expressions.raw<number>(
  sql`EXTRACT(epoch FROM ${u.col("createdAt")})`,
);

qb.select([epoch.as("epoch_s")])
  .where(epoch.gt(1700000000));
```

The parameter bindings on the template are preserved end-to-end. Use
this for vendor-specific functions, full-text operators, or anything
the typed builder hasn't covered yet — without giving up chain
composition.

**`.bigintValue()`** — CAST helper sibling of `.longValue()`, with a
name that signals JS `bigint` intent. Emits `BIGINT` / `SIGNED` /
`INTEGER` per dialect; drivers may still deliver the value as a
string, so wrap the field with `BigInt(...)` when reading the row if
you want a native `bigint`.

**`qb.selectSchema(schema)`** — attaches a Zod / Valibot / Effect
(anything with `.parse(data)`) schema as the row validator AND
narrows `TResult` to `z.infer<typeof schema>` at the type level.

```typescript
import { z } from "zod";

const UserRow = z.object({ id: z.number(), name: z.string() });

const rows = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name"])
  .selectSchema(UserRow)
  .getMany();
//    ^? Array<{ id: number; name: string }>  — inferred from UserRow
```

The SELECT list is unchanged — callers still project the shape they
want via `.select([...])` or `.as("alias")` projections; `selectSchema`
purely wires runtime validation plus type inference. For callers
preferring two explicit calls, `.select(...).validate(schema)` is
equivalent minus the type narrowing.

## Logical composition — `.and()` / `.or()` / `.not()` + `Expressions`

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

## String convenience — `.startsWith` / `.endsWith` / `.contains` + `*IgnoreCase`

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

## Method Summary

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
| Raw SQL escape hatch  | `Expressions.raw<T>(sql`...`)` returns a `ScalarExpression` (composable with `.as`, `.eq`, `coalesce`, ...) |
| BigInt cast           | `.bigintValue()` on column / scalar — BIGINT / SIGNED / INTEGER target |
| Schema-inferred rows  | `qb.selectSchema(zodSchema)` — narrows `TResult` to `z.infer<schema>` and validates rows at runtime |
| Logical composition   | `ColumnCondition.and/.or/.not`, `Expressions.and`, `Expressions.or`, `Expressions.not`          |

## Next Steps

- [JSON Navigation](./query-builder-json.md) — the same proxy extended for
  `json` / `jsonb` columns
- [JOINs](./query-builder-joins.md) — cross-entity queries with typed
  column references
- [Aggregations & Subqueries](./query-builder-aggregations.md) — GROUP BY,
  HAVING, scalar and derived subqueries
- [Query Builder Overview](./query-builder.md) — basics and overall map
