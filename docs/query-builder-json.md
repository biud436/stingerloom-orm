# Query Builder — JSON Navigation

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

> **Prerequisite** — JSON navigation is built on top of the `qAlias()`
> proxy described in [QueryDSL Expressions](./query-builder-querydsl.md).
> If you haven't read that page yet, the short version is: `qAlias(User, "u")`
> returns a proxy that turns `u.firstName` into a typed `ColumnExpression`.
> JSON extends the same proxy.

## Why JSON Is a Natural Extension

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

## Basic Usage

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

## Operator Reference (with Compiled SQL)

The following examples all assume `const u = qAlias(User, "u")` and show the
PostgreSQL output; MySQL and SQLite produce the equivalent functions.

### Comparison — `.eq` / `.neq` / `.gt` / `.gte` / `.lt` / `.lte`

```typescript
u.profile.personal.age.gte(18);
```
```sql
"u"."profile" #>> ARRAY['personal','age']::text[] >= $1
```

### Pattern match — `.like` / `.notLike`

```typescript
u.profile.contact.email.like("%@corp.com");
```
```sql
"u"."profile" #>> ARRAY['contact','email']::text[] LIKE $1
```

### Set membership — `.in` / `.notIn`

```typescript
u.profile.role.in(["admin", "editor"]);
```
```sql
"u"."profile" #>> ARRAY['role']::text[] IN ($1, $2)
```

An empty list short-circuits to `1 = 0` (nothing matches) — `.notIn([])`
short-circuits to `1 = 1` — so the query stays valid SQL.

### NULL — `.isNull` / `.isNotNull`

```typescript
u.profile.contact.email.isNull();
```
```sql
"u"."profile" #>> ARRAY['contact','email']::text[] IS NULL
```

A missing key yields `NULL` at extract time, so `.isNull()` is the correct
way to say _"the path doesn't exist or is set to null"_.

### Structural — `.contains(value)`

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

### Structural — `.hasKey(key)`

```typescript
u.profile.contact.hasKey("email");
```
```sql
("u"."profile" #> ARRAY['contact']::text[]) ? $1        -- PostgreSQL
JSON_CONTAINS_PATH(`u`.`profile`, 'one', ?)             -- MySQL
json_extract("u"."profile", ?) IS NOT NULL              -- SQLite
```

### Scalar — `.arrayLength()` / `.typeOf()`

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

## Dynamic Paths — `.path(string)`

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

## Dialect Cheat Sheet

| Operation      | PostgreSQL                              | MySQL                                           | SQLite                                                 |
|----------------|-----------------------------------------|-------------------------------------------------|--------------------------------------------------------|
| Extract (text) | `col #>> '{a,b}'`                       | `JSON_UNQUOTE(JSON_EXTRACT(col, '$.a.b'))`      | `json_extract(col, '$.a.b')`                           |
| Extract (JSON) | `col #> '{a,b}'`                        | `JSON_EXTRACT(col, '$.a.b')`                    | `json_extract(col, '$.a.b')` (scalar-typed in SQLite)  |
| Contains       | `col @> val::jsonb`                     | `JSON_CONTAINS(col, val, '$.path')`             | Scalar only — object values throw `OrmError`           |
| Has key        | `(col #> path) ? 'k'`                   | `JSON_CONTAINS_PATH(col, 'one', '$.path.k')`    | `json_extract(col, '$.path.k') IS NOT NULL`            |
| Array length   | `jsonb_array_length(col #> path)`       | `JSON_LENGTH(col, '$.path')`                    | `json_array_length(col, '$.path')`                     |
| Type of        | `jsonb_typeof(col #> path)`             | `JSON_TYPE(JSON_EXTRACT(col, '$.path'))`        | `json_type(col, '$.path')`                             |

## Safety and Limits

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

## Next Steps

- [QueryDSL Expressions](./query-builder-querydsl.md) — the rest of the
  `qAlias()` surface: aggregates, CASE, casts, date components, window
  functions, etc.
- [Query Builder Overview](./query-builder.md) — basics and overall map
