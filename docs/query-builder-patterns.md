# Query Builder — Patterns & Productivity

This page covers the helpers that make Stingerloom's query builder stand
out — conditional building, grouped conditions, composable transforms,
relation-aware queries, subquery integration, and reusable scopes.

## Conditional Building — `when()`

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

## Grouped Conditions — `andWhereGroup()` / `orWhereGroup()`

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

## Composable Transforms — `pipe()`

`pipe()` lets you extract reusable query logic into standalone functions and compose them:

```typescript
// Define reusable transforms
function withPagination<T>(page: number, size: number) {
  return (qb: SelectQueryBuilder<T>) =>
    qb.offset((page - 1) * size).limit(size);
}

function withActiveFilter<T>(qb: SelectQueryBuilder<T>) {
  return qb.where("deletedAt", null);
}

// Compose them
const users = await repo
  .createQueryBuilder("u")
  .pipe(withActiveFilter)
  .pipe(withPagination(2, 20))
  .getMany();
```

This pattern is powerful for keeping services DRY. Define your project's common query patterns once, then `pipe()` them everywhere.

## Relation-Aware Queries

### `whereHas()` / `whereNotHas()` — Filter by Relation Existence

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

### `withCount()` — Relation Count as Column

Add a relation count as a scalar subquery in SELECT:

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .withCount("posts")                // default alias: "posts_count"
  .withCount("posts", "activeCount", (sub) =>
    sub.where("status", "published") // only count published posts
  )
  .appendSql(sql`ORDER BY "posts_count" DESC`)
  .getRawMany();
// SELECT "u".*, (SELECT COUNT(*) FROM post ...) AS "posts_count", ...
```

The count alias is added to the SELECT list, not the entity — so `orderBy({ posts_count: "DESC" })` would qualify it as `"u"."posts_count"` (a column that doesn't exist) and the database would reject the query. Reach for `appendSql(sql\`ORDER BY "alias" ...\`)` instead.

### `loadRelation()` — Quick Relation Loading

A concise shorthand for `leftJoinRelationAndSelect()`:

```typescript
// Instead of:
qb.leftJoinRelationAndSelect("author", "author")
  .leftJoinRelationAndSelect("comments", "comments");

// Write:
qb.loadRelation("author").loadRelation("comments");
```

## Subquery Integration

### `whereInSubquery()` / `whereNotInSubquery()`

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

### `whereExistsSubquery()` / `whereNotExistsSubquery()`

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

### `addSelectSubquery()` — Scalar Subquery in SELECT

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

### Correlated Subqueries — the `(outer) => subQb` Factory

`addSelectSubquery()`, `whereExistsSubquery()`, and `whereNotExistsSubquery()` also accept a **factory** `(outer) => subQb`. The `outer("alias.prop")` resolver returns the escaped identifier of an outer-query column as a `Sql` fragment, so the subquery can reference the outer row through the typed surface — NamingStrategy and `@Column({ name })` mappings keep working inside the correlation, instead of hand-writing dialect-specific identifiers in a `sql` string:

```typescript
import { qAlias } from "@stingerloom/orm";

const a = qAlias(Category, "a");

// Per-node descendant post count over a nested-set tree
const nodes = await em
  .createQueryBuilder(Category, "node")
  .addSelectSubquery(
    (outer) =>
      em.createQueryBuilder(Post, "p")
        .selectRaw(["COUNT(*)"])
        .innerJoin(Category, "a", (j) => j.on("p.categoryId", "=", "a.id"))
        // `a.lft` resolves through the subquery's OWN alias registry (its
        // `a` join), so its NamingStrategy / @Column({ name }) mapping
        // applies. `node.lft` / `node.rgt` come from the OUTER row via
        // `outer()`. Both sides stay typed — no hand-written identifiers.
        .where(a.lft.between(outer("node.lft"), outer("node.rgt"))),
    "postCount",
  )
  .getRawMany();
// → (SELECT COUNT(*) FROM "post" AS "p" INNER JOIN "category" AS "a"
//      ON "p"."category_id" = "a"."CTGR_SQ"
//    WHERE "a"."LFT_NO" BETWEEN "node"."LFT_NO" AND "node"."RGT_NO") AS "postCount"
```

`outer()` returns a `Sql` fragment, so it slots into `.between()` (and any
condition value) directly — no `sql` template needed. Reserve `outer()` for
**outer-row** columns; resolve the subquery's own aliases through that
subquery's `qAlias`, so each side maps through the correct registry.

### Nested-Set Tree — Depth and Breadcrumbs Without Raw SQL

The same `onBetween()` self-join, combined with aggregate arithmetic in the
SELECT list, expresses the classic nested-set "depth = ancestor count − 1"
query through the typed builder:

```typescript
const node = qAlias(Category, "node");

// depth of every node: COUNT(ancestors) - 1, grouped by the node
const tree = await em
  .createQueryBuilder(Category, "node")
  .select([
    node.id.as("id"),
    node.name.as("name"),
    node.name.count().sub(1).as("depth"), // COUNT("node"."CTGR_NM") - 1
  ])
  .innerJoin(Category, "parent", (j) =>
    j.onBetween("node.left", "parent.left", "parent.right"),
  )
  .groupBy(["node.left"])
  .addOrderBy("node.left", "ASC")
  .getRawMany();
```

A breadcrumb path is the inverse — select the **ancestor** (`parent`) names.
Projections referencing a joined alias resolve at build time, so the
`select([parent.name.as(...)])` may appear before the `innerJoin` that
registers `parent`:

```typescript
const parent = qAlias(Category, "parent");

const crumbs = await em
  .createQueryBuilder(Category, "node")
  .select([parent.name.as("name")])
  .innerJoin(Category, "parent", (j) =>
    j.onBetween("node.left", "parent.left", "parent.right"),
  )
  .where(node.name.eq("A1"))
  .addOrderBy("parent.left", "ASC")
  .getRawMany();
// crumbs.map((r) => r.name).join(" > ") → "Root > A > A1"
```

The same factory works for `EXISTS`:

```typescript
const usersWithBigOrders = await em
  .createQueryBuilder(User, "u")
  .whereExistsSubquery((outer) =>
    em.createQueryBuilder(Order, "o")
      .select(["id"])
      .where(sql`"o"."user_id" = ${outer("u.id")}`)
      .where("total", ">=", 100),
  )
  .getMany();
```

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

## Cloning a Base Query — `clone()`

When several variants share a base query, build it once and `clone()` per branch:

```typescript
const base = em
  .createQueryBuilder(Order, "o")
  .where("isArchived", false)
  .leftJoinAndSelect("customer", "c");

const recent = await base.clone().where("createdAt", ">=", thirtyDaysAgo).getMany();
const flagged = await base.clone().where("flagged", true).getMany();
```

`clone()` is a **shallow copy** — arrays (`whereClauses`, `joinClauses`, ...) are duplicated, but the alias registry and the property/column maps are shared by reference. Mutating column metadata on the clone is not safe; chaining additional `where`/`join`/`select` calls is.

## Next Steps

- [Execution & Results](./query-builder-execution.md) — pagination,
  locking, validation, `prepare()`
- [QueryDSL Expressions](./query-builder-querydsl.md) — typed condition
  and projection surface
- [Query Builder Overview](./query-builder.md) — basics and overall map
