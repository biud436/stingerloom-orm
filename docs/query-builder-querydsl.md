# Query Builder — QueryDSL Expressions

## Why this exists

Using the query builder, you'll run into a curious asymmetry. Column names autocomplete — operators don't.

```typescript
qb.where("age", ">=", 18);
```

`"age"` is checked against `keyof User`, so a typo fails at compile time. But `">="`? Misspell `"LIKE"` as `"LKIE"` and TypeScript has nothing to say — it's "just a string." You'll find out at runtime, if you're lucky.

There's a second annoyance. The same expression often has to appear in several clauses:

```typescript
qb.addSelect(sql`COUNT(*)`, "total")
  .having(sql`COUNT(*) >= ${5}`)
  .addOrderBy(sql`COUNT(*)`, "DESC");
```

Three copies of `COUNT(*)`. Switch to `COUNT(DISTINCT user_id)` and you edit all three. Miss one and you have a silent bug.

Both of these share a root cause: **SQL expressions are treated as strings rather than values.** If they were values you could assign them to variables, compose them, and have them type-checked. Strings are just strings.

## The idea — expressions as objects

The fix is simple to state. **Make SQL expressions first-class objects.** A column is an object. A comparison is a method on it. The result is another object.

In TypeScript the cleanest way to build this is with `Proxy`, and that's exactly what `qAlias()` returns.

```typescript
import { qAlias } from "@stingerloom/orm";

const u = qAlias(User, "u");
qb.where(u.age.gte(18));
```

Reading `u.age` doesn't fetch anything. The proxy's `get` trap intercepts the access and produces an expression object that says "column `age` of alias `u`". Calling `.gte(18)` wraps it in a condition object ("that column is ≥ 18"). These objects accumulate inside the query builder and only turn into SQL at execution time.

```
u         .age              .gte(18)
│          │                 │
Proxy      ColumnExpression  ColumnCondition
           ("u.age")         (u.age >= 18)
                             → compiled to:
                             → "u"."age" >= $1
                             → the literal 18 is a bound parameter
```

Naming-strategy translation rides along. Under `snake_case`, `u.firstName` becomes `"u"."first_name"` — the proxy looks up column metadata to know.

JSON columns work the same way, just with a longer path. Those are covered in [JSON Navigation](./query-builder-json.md).

## What changes

Swapping operator strings for methods isn't the only gain. Because expressions are now objects, **you can store them in variables.** The earlier `COUNT(*)` example becomes:

```typescript
const p = qAlias(Post, "p");
const count = p.id.count();

await em.createQueryBuilder(Post, "p")
  .select(["category"])
  .addSelect(count.as("total"))
  .groupBy(["p.category"])
  .having(count.gte(5))
  .addOrderBy(count.desc())
  .getRawMany();
```

One `count` definition, reused in SELECT, HAVING, and ORDER BY. Change the aggregate to `p.id.countDistinct()` and you edit one line. Expression reuse pays off especially in reporting queries, where the same sum, average, or count often needs to appear in several places at once.

## `alias()` vs. `qAlias()`

Both produce typed column references, just at different depths.

```typescript
import { alias, qAlias } from "@stingerloom/orm";

const u1 = alias(User, "u");
u1.col("firstName");          // "u.firstName" — autocompletes the property name

const u2 = qAlias(User, "u");
u2.firstName.eq("Alice");     // autocompletes property and operator
u2.col("firstName");          // qAlias also supports .col()
```

You can mix the two styles inside the same chain. Reach for `alias()` when you only need a typed reference; reach for `qAlias()` when you also want to compose conditions.

### Dynamic column access — `.field()` / `.jsonField()`

`qAlias()`'s static accessors require literal property names. When the column comes from user input (a sort key, a filter field selected in the UI), use the dynamic accessors instead:

```typescript
import { qAlias } from "@stingerloom/orm";

const ALLOWED_SORT = new Set(["id", "createdAt", "priority"]);

function buildIssueQuery(sortField: string) {
  if (!ALLOWED_SORT.has(sortField)) throw new Error("invalid sort");

  const i = qAlias(Issue, "i");
  return em
    .createQueryBuilder(Issue, "i")
    .where(i.status.eq("open"))
    .orderBy(i.field(sortField).desc());
}
```

- `field(name)` returns a `ColumnExpression` for any column on the entity. Use after **server-side allowlist validation** — the accessor itself does not check the name.
- `jsonField(name)` returns a `JsonPathExpression` for `@Column({ type: "json" | "jsonb" })` columns; falls back to a plain column proxy if the column isn't registered as JSON.

Both bypass TypeScript's keyof-narrowing for the property name, so the safety guarantee is yours to maintain.

---

The rest of this page walks through what you can do with those column references. Two guarantees hold throughout: column references resolve through the alias registry (so naming-strategy translation always applies), and every user-supplied value — including LIKE escape characters — is a bound parameter.

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

## Conditional aggregates — `.filter(...)` / `countIf` / `sumIf`

`.filter(condition)` restricts an aggregate to the rows matching a
predicate, so several differently-scoped aggregates share one `GROUP BY`
pass instead of separate queries:

```typescript
const u = qAlias(User, "u");

await em.createQueryBuilder(User, "u")
  .select([
    u.id.count().as("total"),
    u.id.count().filter(u.status.eq("active")).as("active"),
    u.id.countIf(u.status.eq("churned")).as("churned"),  // shorthand
    u.amount.sumIf(u.type.eq("refund")).as("refunds"),    // shorthand
  ])
  .getRawMany();
```

`countIf(cond)` and `sumIf(cond)` are shorthands for
`.count().filter(cond)` and `.sum().filter(cond)`. The predicate is any
`ConditionLike` — a column comparison, a `.and()` / `.or()` composition,
or a JSON-path condition — so the full WHERE-side DSL is reusable here.

The clause is dialect-portable:

- **PostgreSQL / SQLite** emit the SQL-standard
  `COUNT("u"."id") FILTER (WHERE "u"."status" = $1)`.
- **MySQL** has no `FILTER` clause, so it is rewritten to the equivalent
  conditional aggregate `COUNT(CASE WHEN \`u\`.\`status\` = ? THEN \`u\`.\`id\` END)`.
  `COUNT(*)` substitutes a literal `1` inside the `CASE` (a bare `*` is not
  a valid `CASE` result).

Both forms agree on NULL semantics: `COUNT` returns `0` and
`SUM` / `AVG` / `MIN` / `MAX` return `NULL` when no row matches. A filtered
aggregate also works in `having()` (`u.id.countIf(...).gt(10)`).

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
import { coalesce, nullif, qAlias } from "@stingerloom/orm";

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
and `Expressions.nullif` — for callers who prefer the static entry point.

::: tip `Expressions` is a lot to type
Most examples from here on alias the namespace on import:

```typescript
import { Expressions as exp } from "@stingerloom/orm";
```

`exp` has no other meaning in the public API, so the name stays free for
this purpose. Everything documented as `Expressions.xxx` is also
available as `exp.xxx`.
:::

## Current date/time — `currentDate()` / `currentTime()` / `currentTimestamp()`

Three small standard-SQL helpers that insert the server's clock into
any expression position. They are scalar expressions, so they compose
with everything already shown (`.as()`, `.eq()`, nested inside
`coalesce`, etc.) and emit the same literal on every dialect.

```typescript
import { Expressions as exp, qAlias } from "@stingerloom/orm";

const s = qAlias(Session, "s");

qb.where(s.expiresAt.gte(exp.currentTimestamp()));
// WHERE "s"."expires_at" >= CURRENT_TIMESTAMP

qb.select([exp.currentDate().as("today")]);
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
qb.where(exp.exists(em.createQueryBuilder(Post, "p")
  .select(["id"])
  .where(sql`"p"."author_id" = "u"."id"`)));
// WHERE EXISTS (SELECT "id" FROM "post" AS "p"
//                WHERE "p"."author_id" = "u"."id")
```

`ExistsCondition.not()` toggles the `EXISTS` / `NOT EXISTS` flag
rather than wrapping in a redundant `NOT (…)`, keeping output SQL
clean.

## Row-value tuples — `Expressions.tuple(...).in(...)` / `.notIn(...)` / `.eq(...)`

`Expressions.tuple(c1, c2, …)` builds a SQL row value `(c1, c2, …)` so
several columns are compared at once — the natural fit for composite-PK
lookups. Instead of unrolling `(a = ? AND b = ?) OR (a = ? AND b = ?)`,
write a single `(a, b) IN ((?, ?), (?, ?))`:

```typescript
const m = qAlias(Membership, "m");

qb.where(
  Expressions.tuple(m.tenantId, m.userId).in([
    [1, "alice"],
    [1, "bob"],
    [2, "carol"],
  ]),
);
// WHERE ("m"."tenantId", "m"."userId") IN ((?, ?), (?, ?), (?, ?))

qb.where(Expressions.tuple(m.tenantId, m.userId).eq([1, "alice"]));
// WHERE ("m"."tenantId", "m"."userId") = (?, ?)
```

`.notIn(rows)` negates the membership. Every value row must match the
column count — a mismatch throws `OrmError(INVALID_QUERY)`. An empty
`.in([])` degenerates to a match-nothing `1 = 0` and `.notIn([])` to an
exclude-nothing `1 = 1`, mirroring the scalar `IN` guard. Row-value
comparison is native on PostgreSQL, MySQL, and SQLite (≥ 3.15), so the
emitted SQL is identical across dialects bar identifier quoting. Columns
accept `qAlias()` expressions or `"alias.prop"` strings, and the resulting
`TupleCondition` composes through `Expressions.and` / `.or` / `.not`.

## `CASE WHEN … THEN …` — `Expressions.caseBuilder()` / `Expressions.cases(...)`

Two fluent builders cover the two forms SQL supports:

**Searched CASE** — `caseBuilder()` reads like a guard chain. Each
branch is a `ConditionLike` paired with a result value; end with an
optional `otherwise(default)` and call `.end()` to finalize.

```typescript
const u = qAlias(User, "u");

const tier = exp.caseBuilder()
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
const weight = exp.cases(u.status)
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

### Shortcuts for common `CASE` shapes

Three shapes show up often enough that the general builder feels
disproportionately heavy. The shortcuts below each expand to the same
SQL the builder would produce — they exist only so the callsite reads
like the intent instead of like scaffolding.

Use the full builder whenever the branches differ in structure. Use a
shortcut when its shape matches exactly.

| Shape | Shortcut | When to use |
|-------|----------|-------------|
| Two-branch ternary | `Expressions.iff(cond, a, b)` | One condition picks between two results (soft-delete flags, feature gates, Y/N output). |
| Static value mapping | `Expressions.mapValues(subject, { k: v }, default?)` | A column's discrete values map one-to-one to constants. |
| Threshold ladder | `Expressions.buckets(subject, [[t, label], …], default?, { op? })` | One numeric column bucketed by the same operator and ordered thresholds. |

#### `Expressions.iff(condition, whenTrue, whenFalse)`

```typescript
const u = qAlias(User, "u");

qb.select([
  exp.iff(u.deletedAt.isNull(), "active", "deleted").as("state"),
]);
// SELECT CASE WHEN "u"."deleted_at" IS NULL THEN $1 ELSE $2 END AS "state"
```

#### `Expressions.mapValues(subject, mapping, default?)`

Object keys become `WHEN` values, bound as parameters. Keys are
string-coerced, so this fits enum / status / role columns best. Omit
`default` to skip the `ELSE` branch; pass `null` if you want an explicit
`ELSE NULL`.

```typescript
qb.select([
  exp.mapValues(u.status, { active: 1, pending: 0 }, -1).as("w"),
]);
// SELECT CASE "u"."status" WHEN $1 THEN $2
//                           WHEN $3 THEN $4
//                           ELSE $5 END AS "w"
```

#### `Expressions.buckets(subject, thresholds, default?, { op })`

Each `[threshold, result]` tuple becomes one `WHEN subject <op>
threshold THEN result` branch, in the order given. Default operator is
`">="` (descending thresholds). Switch to `"<"` / `"<="` for ascending
cohorts and to `">"` for strict descending ladders.

```typescript
// Descending >= ladder (default)
exp.buckets(u.score, [
  [90, "gold"],
  [70, "silver"],
], "bronze");

// Ascending < ladder — age → cohort
exp.buckets(u.age, [
  [18, "child"],
  [65, "adult"],
], "senior", { op: "<" });
```

Each shortcut returns a `ScalarExpression`, so the result slots into
every Tier 2/3 surface — `.as()`, casts, comparisons, `coalesce(...)`,
`Expressions.and(...)` / `.or(...)`. Empty mappings or thresholds throw
early.

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
  exp.dateDiff(e.endsAt, e.startsAt, "day").as("span_days"),
  exp.random().as("r"),
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
import { Expressions as exp, qAlias } from "@stingerloom/orm";

const u = qAlias(User, "u");

const epoch = exp.raw<number>(
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
import { Expressions as exp } from "@stingerloom/orm";

qb.where(
  exp.or(
    exp.and(u.age.gte(18), u.status.eq("active")),
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
  exp.and(
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

## Regular expressions — `.matches(pattern)`

`.matches()` builds a regex predicate. The argument is a raw pattern
string or a JS `RegExp`; the pattern is always **bound as a parameter**, so
there is no SQL-injection surface:

```typescript
const u = qAlias(User, "u");

qb.where(u.email.matches("^[^@]+@example\\.com$"));
// PostgreSQL:  "u"."email" ~ $1
// MySQL:       `u`.`email` REGEXP ?
// SQLite:      "u"."email" REGEXP ?      (served by the `regexp` UDF)

qb.where(u.title.matches(/typescript/i));   // case-insensitive
qb.where(u.slug.matches(/^[a-z0-9-]+$/).not());
```

A `RegExp`'s `i` / `m` / `s` flags are carried as an inline `(?ims)` option
group prepended to the bound pattern — PostgreSQL ARE and MySQL/MariaDB ICU
honor it natively, and the SQLite `regexp` UDF parses it back into JS
`RegExp` flags. `g` / `u` / `y` are meaningless for a predicate and ignored.
Negate with `.not()`, and compose with `.and()` / `.or()`.

Engine notes:

- **`i` (case-insensitive) is portable; `m` / `s` carry engine-specific
  newline semantics** — pin behavior with a golden/integration test if you
  depend on multiline or dotAll.
- **MySQL `REGEXP` is case-insensitive by default** on non-binary
  collations, so an *un*-flagged `.matches("^a")` already matches `A...`
  there. Use a binary collation (or rely on the documented behavior) if you
  need case sensitivity on MySQL. PostgreSQL `~` and the SQLite UDF are
  case-sensitive unless the `i` flag is set.
- **SQLite** has no built-in regex engine; the connector registers a
  `regexp` UDF on connect that runs patterns through JS `RegExp`. A hostile
  pattern can cause ReDoS, so validate user-supplied patterns before use.

## Method Summary

| Category              | Methods                                                                                         |
|-----------------------|-------------------------------------------------------------------------------------------------|
| String (case-sens.)   | `.startsWith`, `.endsWith`, `.contains`                                                         |
| String (case-insens.) | `.equalsIgnoreCase`, `.likeIgnoreCase`, `.startsWithIgnoreCase`, `.endsWithIgnoreCase`, `.containsIgnoreCase` |
| Ordering              | `.asc()`, `.desc()`, `.nullsFirst()`, `.nullsLast()`                                            |
| Aggregates            | `.count()`, `.countDistinct()`, `.sum()`, `.avg()`, `.min()`, `.max()` — each with `.as(alias)` and `.eq/.neq/.gt/.gte/.lt/.lte/.between` |
| Conditional aggregates | `aggregate.filter(condition)`, `.countIf(condition)`, `.sumIf(condition)` — `FILTER (WHERE …)` (PG/SQLite) / `CASE` rewrite (MySQL) |
| SELECT alias          | `.as("name")` on columns, JSON path extracts, and aggregates — produces `AliasedExpression` |
| Null handling         | `coalesce(…)`, `nullif(a, b)`, `col.coalesce(…)`, `Expressions.coalesce`, `Expressions.nullif` |
| Current date / time   | `currentDate()`, `currentTime()`, `currentTimestamp()` — also on `Expressions`                 |
| Type casts            | `.stringValue()`, `.intValue()`, `.longValue()`, `.floatValue()`, `.booleanValue()` — dialect-specific type names |
| Date components       | `.year()`, `.month()`, `.day()`, `.hour()`, `.minute()`, `.second()`, `.dayOfWeek()`, `.dayOfMonth()`, `.dayOfYear()`, `.week()` |
| Subquery compare      | `.in(subQb)`, `.notIn(subQb)`, `.eq/.neq/.gt/.gte/.lt/.lte(subQb)`, `Expressions.exists`, `Expressions.notExists` |
| Row-value tuples      | `Expressions.tuple(c1, c2, …).in(rows)` / `.notIn(rows)` / `.eq(row)` — composite-PK comparison |
| Regular expressions   | `.matches(pattern)` — string or `RegExp` (`i`/`m`/`s` flags); `.not()` to negate. PG `~`, MySQL/SQLite `REGEXP` |
| CASE expressions      | `Expressions.caseBuilder().when(...).then(...).otherwise(...).end()`; `Expressions.cases(subject).when(val, result)...end()` |
| CASE shortcuts        | `Expressions.iff(cond, a, b)`; `Expressions.mapValues(subject, { k: v }, default?)`; `Expressions.buckets(subject, [[t, label], …], default?, { op? })` |
| String / numeric / math | `.toLowerCase()`, `.toUpperCase()`, `.trim()`, `.length()`, `.substring()`, `.concat()`, `.indexOf()`, `.replace()`, `.add/.sub/.mul/.div/.mod/.neg`, `.abs/.floor/.ceil/.round/.sqrt` |
| Date arithmetic       | `.addYears/Months/Days/Hours/Minutes/Seconds(n)`, `Expressions.dateDiff(a, b, unit)`, `Expressions.random()` |
| Window functions      | `aggregate.over().partitionBy(...).orderBy(...).rowsBetween(start, end).as("alias")` — `WindowBuilder` chain |
| Raw SQL escape hatch  | `Expressions.raw<T>(sql`...`)` returns a `ScalarExpression` (composable with `.as`, `.eq`, `coalesce`, ...) |
| BigInt cast           | `.bigintValue()` on column / scalar — BIGINT / SIGNED / INTEGER target |
| Schema-inferred rows  | `qb.selectSchema(zodSchema)` — narrows `TResult` to `z.infer<schema>` and validates rows at runtime |
| Logical composition   | `ColumnCondition.and/.or/.not`, `Expressions.and`, `Expressions.or`, `Expressions.not`          |

## Dialect support matrix

When an expression has no equivalent on the active dialect, the renderer throws an `OrmError(OrmErrorCode.UNSUPPORTED_OPERATION)` with a message that names the feature, the failing dialect, *why* it is unsupported, and a concrete *alternative* (an emulation sketch or escape-hatch pointer). Use this matrix to plan around dialect gaps before you hit the throw.

| Expression | PostgreSQL | MySQL | SQLite | Notes |
|------------|------------|-------|--------|-------|
| Aggregates (`count`, `sum`, `avg`, `min`, `max`, `countDistinct`) | Native | Native | Native | — |
| Conditional aggregates (`.filter()`, `countIf`, `sumIf`) | Native `FILTER (WHERE …)` | Rewritten to `FUNC(CASE WHEN … THEN … END)` | Native `FILTER (WHERE …)` (3.30+) | `COUNT(*)` becomes `COUNT(CASE WHEN … THEN 1 END)` on MySQL. NULL semantics match across dialects. |
| Row-value tuples (`Expressions.tuple().in/notIn/eq`) | Native | Native | Native (3.15+) | Identical SQL across dialects except identifier quoting. |
| Regex match (`.matches()`) | Native `~` (ARE) | Native `REGEXP` (ICU, **case-insensitive by default**) | `REGEXP` via connector-registered `regexp` UDF | Pattern is bound as a parameter. `i` flag portable; `m`/`s` engine-specific. MySQL needs a binary collation for case-sensitive matching. |
| `coalesce` / `nullif` | Native | Native | Native | — |
| Window functions (`ROW_NUMBER`, `RANK`, `DENSE_RANK`, `LAG`, `LEAD`, aggregate `OVER()`) | Native | Native (8.0+) | Native (3.25+) | — |
| `percentile_cont` / `percentile_disc` / `mode` ordered-set aggregates | Native (`WITHIN GROUP`) | **Unsupported** — throws `UNSUPPORTED_OPERATION` | **Unsupported** — throws `UNSUPPORTED_OPERATION` | MySQL: emulate with CTE + `ROW_NUMBER() OVER (ORDER BY x)` and pick `rn = CEIL(N * p)`. See [the cookbook recipe](./cookbook.md#cycle-time-percentile-report). |
| `dateTrunc` (year/quarter/month/week/day/hour/minute/second) | Native `DATE_TRUNC` | Per-unit equivalents (`DATE`, `DATE_FORMAT`, ISO-Monday `WEEKDAY` math) | `date(..., 'start of …')` / `strftime` | All three dialects produce ISO-Monday weeks. |
| `dateDiff(a, b, unit)` — year / month | Calendar-aware via `age()` | Calendar-aware via `TIMESTAMPDIFF(YEAR/MONTH, ...)` | Approximation: julianday / 365.25 (year), / 30.4375 (month) | SQLite values are approximate by ~0.07% over a typical decade. |
| `dateDiff(a, b, unit)` — day / hour / minute / second | Epoch seconds via `EXTRACT(EPOCH ...)` | `TIMESTAMPDIFF(...)` | `julianday()` * factor | Exact on all three. |
| `dateAdd(value, n, unit)` | `value + INTERVAL 'N unit'` | `DATE_ADD(value, INTERVAL N unit)` | `datetime(value, '+N unit')` modifier | — |
| `random()` | `random()` returns `[0, 1)` | `RAND()` returns `[0, 1)` | `RANDOM()` returns 64-bit signed integer | SQLite callers should normalize to `[0, 1)` if they need a fraction. |
| Full-text search (`Expressions.fullTextSearch`) | `to_tsvector / @@` (tsvector pipeline) | `MATCH() AGAINST(...)` (FULLTEXT index required) | **Unsupported via DSL** — throws `UNSUPPORTED_DATABASE` | SQLite: use FTS5 virtual tables with `em.query()`. |
| `jsonContains` — object/array value | Native `@>` containment | Native `JSON_CONTAINS` | **Unsupported for objects/arrays** — throws `UNSUPPORTED_DATABASE` | SQLite supports scalar equality at a path — use `metadata.profile.role.eq('admin')` or raw SQL. |
| `jsonExtract` / `jsonHasKey` / `jsonArrayLength` / `jsonTypeOf` | Native (`->`, `?`, `jsonb_array_length`, `jsonb_typeof`) | Native (`JSON_EXTRACT`, `JSON_CONTAINS_PATH`, `JSON_LENGTH`, `JSON_TYPE`) | Native (`json_extract`, `json_array_length`, `json_type`) | — |
| `ilike` (case-insensitive LIKE) | Native `ILIKE` | `LIKE` is case-insensitive by default on `*_ci` collations; `LOWER()` fallback for `*_bin` | `LIKE` is ASCII-insensitive; non-ASCII unicode requires the ICU extension | — |
| Numeric / string helpers (`.abs`, `.floor`, `.ceil`, `.round`, `.length`, `.substring`, `.trim`, …) | Native | Native | Native | — |

When you hit an `UNSUPPORTED_OPERATION`, the error's `suggestion` field carries the single-line emulation/alternative hint suitable for direct UI display. The full message also includes a `See: docs/...` pointer to the relevant section of the docs.

## Next Steps

- [JSON Navigation](./query-builder-json.md) — the same proxy extended for
  `json` / `jsonb` columns
- [JOINs](./query-builder-joins.md) — cross-entity queries with typed
  column references
- [Aggregations & Subqueries](./query-builder-aggregations.md) — GROUP BY,
  HAVING, scalar and derived subqueries
- [Analytical Query Cookbook](./cookbook.md) — recipes built around the
  expressions above (window functions, percentiles with MySQL emulation,
  recursive CTEs)
- [Query Builder Overview](./query-builder.md) — basics and overall map
