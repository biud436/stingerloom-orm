# Query Builder — JOINs

Joining tables is where the query builder really shines compared to `find()`.
`find()` can eagerly load relations, but only along paths you declared with
`@ManyToOne` / `@OneToMany` / `@OneToOne`. The query builder goes further — it
joins on any entity (or even a raw table name), lets you reference columns
across the join with full TypeScript autocomplete, and understands your
relation metadata so you can skip the ON clause entirely when one exists.

Three levels of JOIN support are available, from raw strings to fully
automatic.

> **See also** — the column reference helpers (`alias()`, `qAlias()`) used
> throughout this page are documented in depth on the
> [QueryDSL Expressions](./query-builder-querydsl.md) page. The essentials
> are recapped below.

## Typed Column References with `alias()`

When you join tables, you reference columns from multiple entities —
`"p.authorId"`, `"u.firstName"`, etc. These are plain strings with no
autocomplete. The `alias()` function fixes this:

```typescript
import { alias } from "@stingerloom/orm";

const p = alias(Post, "p");
const u = alias(User, "u");

p.col("authorId");   // returns "p.authorId" — with autocomplete ✓
u.col("firstName");  // returns "u.firstName" — with autocomplete ✓
u.col("typo");       // ✗ compile error — "typo" is not keyof User
```

`alias()` creates a typed reference. The `.col()` method constrains its
argument to `keyof T` (so TypeScript auto-completes property names), and
returns the `"alias.property"` string that the query builder understands. At
runtime, this string is resolved to the actual DB column name via the alias
registry.

You can use `alias()` references everywhere — `where()`, `selectRaw()`,
`addOrderBy()`, `whereIn()`, `JoinOnBuilder.on()`, etc.

## QueryDSL-Style Expressions with `qAlias()`

For an even more expressive API, `qAlias()` lets you access entity properties
directly and chain condition methods on them. No code generation step — it
works through a runtime `Proxy`.

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

Every entity property becomes a `ColumnExpression` with condition methods.
The full operator reference lives on the
[QueryDSL Expressions](./query-builder-querydsl.md) page. The short version:

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

`.eq()` and `.neq()` normalize their operand so the generated SQL is always
sound: a `null` becomes `IS NULL` / `IS NOT NULL` (never `= NULL`, which always
yields UNKNOWN), and an array becomes `IN (...)` / `NOT IN (...)`. So
`u.deletedAt.neq(null)` emits `IS NOT NULL` and `u.role.neq(["a", "b"])` emits
`NOT IN (?, ?)`. The same rewrite applies to the explicit
`where(col, "!=", null)` / `where(col, "=", null)` operator form.

Each method returns a `ColumnCondition` that the query builder resolves
through its alias registry — SnakeNamingStrategy is fully supported.

`qAlias()` also supports `.col()` from `alias()`, so you can mix styles:

```typescript
const u = qAlias(User, "u");
qb.where(u.firstName.eq("Alice"))     // QueryDSL style
  .addOrderBy(u.col("lastName"), "ASC") // alias() style — both work
```

## Entity-Aware Joins (Recommended)

The best way to join tables is by passing the **entity class** directly. The
ORM automatically resolves the table name and lets you reference columns
using camelCase property names.

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

### Null and IN conditions — `onNull()`, `onNotNull()`, `onIn()`

Three more `JoinOnBuilder` methods let you narrow the JOIN without leaving the builder:

| Method | SQL fragment | Notes |
|--------|-------------|-------|
| `onNull(ref)` | `ref IS NULL` | Useful for anti-joins or filtering only unmatched rows |
| `onNotNull(ref)` | `ref IS NOT NULL` | Require a non-null value on the joined side |
| `onIn(ref, values)` | `ref IN (?, ?, ...)` | Values are parameter-bound, never concatenated; an empty array emits `1 = 0` (matches nothing) |

All three chain with AND semantics alongside `on()` / `andOn()` / `onVal()`. The `ref` argument follows the same `"alias.property"` string resolution as `on()`, so NamingStrategy and `@Column({ name })` mappings apply.

```typescript
// Only join active, verified users
const posts = await em
  .createQueryBuilder(Post, "p")
  .leftJoin(User, "u", (j) =>
    j.on("p.authorId", "=", "u.id")
     .onNotNull("u.verifiedAt")   // u.verified_at IS NOT NULL
     .onIn("u.role", ["admin", "editor"]),  // u.role IN (?, ?)
  )
  .getMany();

// Left join to find posts with no matching soft-deleted author
const orphaned = await em
  .createQueryBuilder(Post, "p")
  .leftJoin(User, "u", (j) =>
    j.on("p.authorId", "=", "u.id")
     .onNull("u.deletedAt"),   // u.deleted_at IS NULL
  )
  .getMany();
```

### Range-Containment ON — `onBetween()`

For range-containment self-joins (nested sets, interval trees), `onBetween(ref, lowRef, highRef)` compares a column against two other **column references**, and `onValBetween(ref, low, high)` takes literal bounds that are bound as parameters:

```typescript
// SELECT ... FROM category node JOIN category parent
//   ON node.lft BETWEEN parent.lft AND parent.rgt
const tree = await em
  .createQueryBuilder(Category, "node")
  .innerJoin(Category, "parent", (j) =>
    j.onBetween("node.lft", "parent.lft", "parent.rgt"),
  )
  .getRawMany();

// Literal bounds — parameter-bound
qb.innerJoin(Category, "sub", (j) => j.onValBetween("sub.lft", 1, 42));
```

`andOnBetween()` chains an additional range condition with AND semantics. All three resolve their references through the alias registry, so NamingStrategy and `@Column({ name })` mappings apply.

## Relation-Based Joins (Automatic ON)

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

## JoinAndSelect — Join + Auto SELECT

When you want to include all columns from the joined entity in the result, use the `*AndSelect` variants. This is equivalent to doing a join + manually selecting every column — but in one call, and entity reads hydrate the joined columns into the relation property:

```typescript
const posts = await em
  .createQueryBuilder(Post, "p")
  .leftJoinRelationAndSelect("author", "u")
  .where("p.status", "published")
  .getMany();
// [Post { id: 1, title: "...", author: User { id: 7, name: "Alice" } }, ...]
```

All `*AndSelect` variants:

| Method | Description |
|--------|-------------|
| `leftJoinAndSelect(Entity, alias, onBuilder)` | LEFT JOIN + auto SELECT all joined columns |
| `innerJoinAndSelect(Entity, alias, onBuilder)` | INNER JOIN + auto SELECT all joined columns |
| `leftJoinRelationAndSelect(property, alias)` | Relation LEFT JOIN + auto SELECT |
| `innerJoinRelationAndSelect(property, alias)` | Relation INNER JOIN + auto SELECT |

### How columns are selected

Every joined column is selected with an `alias_column` AS-alias (`` `u`.`id` AS `u_id` ``), and the root `alias.*` is expanded into explicit `alias_column`-aliased columns (`p_id`, `p_title`, …) at the same time. Because every column carries a unique prefix, a joined column can never clobber a same-named root column — both tables having an `id` is no longer a problem.

### getMany() / getOne() — relation hydration

Entity reads hydrate the prefixed columns back into the relation property:

- `@ManyToOne` / `@OneToOne` — the joined row becomes a **nested object**; a LEFT JOIN miss becomes `null`.
- `@OneToMany` — root rows are **deduped and grouped by primary key**, and the joined rows collect into an array; a miss yields an empty array `[]`.

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .leftJoinRelationAndSelect("posts", "p")
  .getMany();
// [User { id: 1, posts: [Post {...}, Post {...}] }, User { id: 2, posts: [] }]
// — one User per group of joined rows, not one per row
```

### getRawMany() — prefixed keys

Raw reads expose the prefixes directly: the joined columns arrive as `u_id`, `u_username`, …, and the root columns as `p_id`, `p_title`, … when the root `*` was expanded.

```typescript
const rows = await em
  .createQueryBuilder(Post, "p")
  .leftJoinAndSelect(User, "u", (j) => j.on("p.authorId", "=", "u.id"))
  .getRawMany();
// [{ p_id: 1, p_title: "...", u_id: 7, u_name: "Alice", ... }]
```

::: warning Behavioral change
If you previously combined `getRawMany()` with `*AndSelect`, update your key access — joined (and expanded root) columns are now prefixed instead of flat. The flat form silently dropped same-named columns; the prefixed form keeps every value.
:::

### Entity-based joins and relation matching

`leftJoinAndSelect(Entity, alias, on)` automatically matches the joined entity to a relation property on the root when one exists, so hydration works exactly as above even without `*RelationAndSelect`. If no relation matches, the columns are still alias-prefixed (no clobbering), but nothing is nested — read them via `getRawMany()`.

## String-Based Joins (Raw)

For cases where you don't have entity metadata (joining a view, a subquery, or a raw table), you can still pass a string table name.

```typescript
qb.leftJoin("audit_log", "al", sql`"p"."id" = "al"."post_id"`);
```

This is the original API and remains fully supported.

## Multi-Table Joins

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

## Cross-Entity Column Resolution

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

## Join Types Summary

| Method | SQL | When to use |
|--------|-----|-------------|
| `leftJoin()` | `LEFT JOIN` | Include rows even if the joined table has no match |
| `innerJoin()` | `INNER JOIN` | Only rows that have a match in both tables |
| `rightJoin()` | `RIGHT JOIN` | Include all rows from the joined table |
| `leftJoinRelation()` | `LEFT JOIN` | Auto ON from `@ManyToOne` / `@OneToMany` metadata |
| `innerJoinRelation()` | `INNER JOIN` | Auto ON from relation metadata |

## Next Steps

- [QueryDSL Expressions](./query-builder-querydsl.md) — full `qAlias()` operator surface
- [Aggregations & Subqueries](./query-builder-aggregations.md) — GROUP BY, HAVING, subquery patterns on joined entities
- [Query Builder Overview](./query-builder.md) — basics and overall map
