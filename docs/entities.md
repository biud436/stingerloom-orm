# Entities

An **Entity** is a TypeScript class that represents a database table. Each entity class corresponds to one table, and the class properties become the table's columns.

But before we write code, let's understand the problem an entity solves.

Without an ORM, you write raw SQL to create tables, then manually convert between JavaScript objects and SQL rows. Every time you add a column, you update the CREATE TABLE, the INSERT, the SELECT, and the type definitions. An entity eliminates this duplication: you describe your data structure once in TypeScript, and the ORM generates the SQL for you.

This document starts with the simplest entity and gradually introduces features needed in real-world applications.

## Creating Your First Entity

Suppose you want to store user information in a database. The simplest entity looks like this.

```typescript
// user.entity.ts
import { Entity, PrimaryGeneratedColumn, Column } from "@stingerloom/orm";

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;
}
```

With just this code, Stingerloom creates a `user` table with an `id` (auto-increment primary key) and a `name` (VARCHAR(255)) column.

Here is the exact DDL (Data Definition Language) that Stingerloom generates for this entity.

**PostgreSQL:**

```sql
CREATE TABLE "user" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL
);
```

**MySQL:**

```sql
CREATE TABLE `user` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255) NOT NULL,
  PRIMARY KEY (`id`)
);
```

Notice the differences: PostgreSQL uses double quotes (`"`) around identifiers and the `SERIAL` keyword for auto-increment. MySQL uses backticks and `AUTO_INCREMENT`. Stingerloom handles these differences for you -- you write the entity once and it works on both databases.

Let's look at what each of the three decorators does.

**`@Entity()`** declares that this class is an ORM entity. The class name `User` is automatically converted to snake_case to become the table name `user`. If you want to specify the table name explicitly, pass an option.

```typescript
// user.entity.ts
@Entity({ name: "app_users" })
export class User { /* table name: app_users */ }
```

**`@PrimaryGeneratedColumn()`** defines an auto-increment primary key. At the SQL level, this translates to:
- **PostgreSQL:** `SERIAL PRIMARY KEY` (which is shorthand for creating a sequence and setting it as the default)
- **MySQL:** `INT NOT NULL AUTO_INCREMENT PRIMARY KEY`

The database automatically fills in 1, 2, 3... in sequence even if you don't provide a value during INSERT.

```sql
-- You write:
INSERT INTO "user" ("name") VALUES ('Alice');
-- The DB fills in id = 1 automatically

-- You write:
INSERT INTO "user" ("name") VALUES ('Bob');
-- The DB fills in id = 2 automatically
```

**`@Column()`** defines a regular column. It reads the TypeScript type and automatically infers the appropriate DB type -- `string` becomes `VARCHAR(255)`, `number` becomes `INT`. This inference is based on the `design:type` metadata that TypeScript's `emitDecoratorMetadata` compiler option provides.

> **Hint** The `!:` syntax (definite assignment assertion) tells TypeScript "this property is managed by the ORM, so it's okay not to initialize it."

## Using Various Column Types

In practice, you need more than just strings and numbers. You can specify the desired column type using the `type` option in `@Column()`.

```typescript
// product.entity.ts
@Entity()
export class Product {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;                    // VARCHAR(255) auto-inferred

  @Column({ type: "text" })
  description!: string;             // TEXT (long strings)

  @Column({ type: "float" })
  price!: number;                   // FLOAT

  @Column({ type: "boolean" })
  isAvailable!: boolean;            // TINYINT(1) / BOOLEAN

  @Column({ type: "datetime" })
  releaseDate!: Date;               // DATETIME / TIMESTAMP
}
```

**PostgreSQL DDL:**

```sql
CREATE TABLE "product" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL,
  "description" TEXT NOT NULL,
  "price" REAL NOT NULL,
  "isAvailable" BOOLEAN NOT NULL,
  "releaseDate" TIMESTAMP NOT NULL
);
```

**MySQL DDL:**

```sql
CREATE TABLE `product` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255) NOT NULL,
  `description` TEXT NOT NULL,
  `price` FLOAT NOT NULL,
  `isAvailable` TINYINT(1) NOT NULL,
  `releaseDate` DATETIME NOT NULL,
  PRIMARY KEY (`id`)
);
```

If `type` is omitted, it is automatically inferred from the TypeScript type. However, even for the same `string`, a short name (`varchar`) and a long body (`text`) are different, so it's best to specify based on the intended use. A `VARCHAR(255)` column has a hard upper limit of 255 characters, while `TEXT` can store megabytes of content.

> **Hint** Stingerloom's column types are database-independent. For example, `"boolean"` is automatically converted to `TINYINT(1)` in MySQL and `BOOLEAN` in PostgreSQL. See the [ColumnType Reference](#columntype-reference) at the bottom of this document for the full mapping table.

## Setting Column Options

`@Column()` accepts options to control the column's detailed behavior.

### Specifying Length

Specifies the maximum length of a string column. If omitted, the default length for `varchar` is 255.

```typescript
@Column({ type: "varchar", length: 100 })
sku!: string;
```

This generates `VARCHAR(100)` in the DDL. If a user tries to insert a string longer than 100 characters, the database itself will reject the insert with an error.

### Allowing NULL

By default, all columns are `NOT NULL`. This means the database will reject any INSERT or UPDATE that tries to set the column to NULL. This is a safety feature -- it prevents accidentally storing missing data.

For columns that may not have a value, set `nullable: true`.

```typescript
@Column({ nullable: true })
bio!: string | null;
```

This generates `VARCHAR(255)` (without the `NOT NULL` constraint) in the DDL. Adding `| null` to the TypeScript type as well allows natural null checking in your code.

### Column Name Alias

Use the `name` option when you want the property name and the actual DB column name to differ. This is common when you want camelCase in TypeScript but snake_case in the database.

```typescript
@Column({ name: "unit_price", type: "float" })
price!: number;
// TypeScript: product.price / DB column: unit_price
```

In the DDL, the column will be named `unit_price`. When Stingerloom builds a SELECT query, it maps the `unit_price` column back to the `price` property on your TypeScript object.

### Default Value

Use the `default` option to set a column's default value. Literal values (string, number, boolean) are used as-is. To use a raw SQL expression (such as a function), wrap it in parentheses.

```typescript
@Column({ default: "active" })
status!: string;

@Column({ default: 0 })
retryCount!: number;

@Column({ default: true })
isVisible!: boolean;

@Column({ default: "(CURRENT_TIMESTAMP)" })
createdAt!: Date;
```

Here is the DDL these produce.

**PostgreSQL:**

```sql
"status" VARCHAR(255) NOT NULL DEFAULT 'active',
"retryCount" INTEGER NOT NULL DEFAULT 0,
"isVisible" BOOLEAN NOT NULL DEFAULT TRUE,
"createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
```

**MySQL:**

```sql
`status` VARCHAR(255) NOT NULL DEFAULT 'active',
`retryCount` INT NOT NULL DEFAULT 0,
`isVisible` TINYINT(1) NOT NULL DEFAULT 1,
`createdAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
```

When the value is wrapped in parentheses like `"(CURRENT_TIMESTAMP)"`, Stingerloom emits it as a raw SQL `DEFAULT` expression in the DDL instead of a quoted string literal. Without the parentheses, `"CURRENT_TIMESTAMP"` would be treated as the literal string `'CURRENT_TIMESTAMP'`, not the SQL function.

### JSON Column

Use the JSON type to store structured data in a single column. This is useful for flexible, schema-less data like user preferences or configuration.

```typescript
@Column({ type: "json", nullable: true })
settings!: Record<string, unknown> | null;
```

**PostgreSQL:** `"settings" JSON` (or use `"jsonb"` for indexed, binary-stored JSON)
**MySQL:** `` `settings` JSON ``

The difference between `json` and `jsonb` matters in PostgreSQL: `jsonb` is stored in a decomposed binary format, which is slower to input but significantly faster to query. If you need to query inside the JSON (e.g., `WHERE settings->>'theme' = 'dark'`), prefer `jsonb`.

#### Automatic stringify / parse

Stingerloom installs a default round-trip on `type: "json" | "jsonb"` columns when no explicit `transformer` is provided:

- **Write**: a non-string value is `JSON.stringify`ed before reaching the driver. Strings pass through unchanged so legacy code that already serializes manually does not double-encode. `null` and `undefined` are preserved.
- **Read**: a string returned by the driver (mysql2, better-sqlite3) is `JSON.parse`d. Already-parsed values (PostgreSQL `jsonb`) pass through. A malformed legacy row logs a single warning and yields the raw string instead of throwing.

This means you can assign plain JS values directly:

```typescript
issue.customFields = { priority: "high", labels: ["bug"] };
await em.save(Issue, issue);

const loaded = await em.findOne(Issue, { where: { id } });
loaded.customFields.priority; // "high" — already an object, dialect-agnostic
```

Supplying any explicit `transformer` overrides the default for that side; partial transformers (only `to` or only `from`) compose with the default for the missing direction.

> **Migration note** — if you previously did `JSON.stringify(value) as any` before assigning to a JSON column, it still works (strings pass through). Drop the manual stringify when you're ready; both paths produce the same persisted value.

### Value Transform

You can apply a transform function when mapping values read from the DB to TypeScript objects. This is useful when booleans are stored as numbers, like MySQL's `TINYINT(1)`.

```typescript
@Column({ transform: (raw) => raw === 1 })
isActive!: boolean;
```

When Stingerloom reads a row from the database, it passes the raw `isActive` value through this function. So the raw number `1` becomes `true`, and `0` becomes `false`.

### Column Transformers

The `transform` option shown above only works in one direction -- when reading from the database. But in practice, you often need to transform values in **both** directions. Think of it like a translator who converts between two languages: you need translation going in and coming out.

Consider email addresses. You want every email stored in lowercase to avoid duplicates (`Alice@Example.com` and `alice@example.com` should match). Without a transformer, you must remember to call `.toLowerCase()` before every INSERT and every UPDATE. Forget once, and you have inconsistent data. A column transformer solves this by declaring the transformation once, on the column definition itself.

```typescript
@Column({
  type: "varchar",
  transformer: {
    to: (value: string) => value.toLowerCase(),   // before INSERT/UPDATE
    from: (value: string) => value.toUpperCase(),  // after SELECT
  },
})
email: string;
```

The `to` function runs automatically before every INSERT and UPDATE. The `from` function runs automatically after every SELECT, transforming the raw database value back into your application's preferred format.

Here is what happens at the SQL level:

```typescript
await em.save(User, { email: "Alice@Example.COM" });
// The transformer.to runs first: "Alice@Example.COM" → "alice@example.com"
// Generated SQL:
// INSERT INTO "user" ("email") VALUES ('alice@example.com')

const user = await em.findOne(User, { where: { id: 1 } });
// DB returns: { email: "alice@example.com" }
// The transformer.from runs: "alice@example.com" → "ALICE@EXAMPLE.COM"
// user.email === "ALICE@EXAMPLE.COM"
```

Another common use case is encryption. You can encrypt sensitive data before it reaches the database and decrypt it when reading:

```typescript
@Column({
  type: "text",
  transformer: {
    to: (value: string) => encrypt(value),   // plaintext → ciphertext
    from: (value: string) => decrypt(value), // ciphertext → plaintext
  },
})
ssn: string;
```

The database stores the encrypted ciphertext. Your application code works with the plaintext. The transformation is invisible to the rest of your codebase.

**Backward compatibility with `transform`:** The legacy read-only `transform` option still works. If you set both `transform` and `transformer` on the same column, `transformer.from` takes precedence for the read direction. The `transform` option is deprecated -- use `transformer` for all new code.

```typescript
// Legacy (read-only, deprecated):
@Column({ transform: (raw) => raw === 1 })

// Modern (bidirectional, recommended):
@Column({
  transformer: {
    to: (value: boolean) => value ? 1 : 0,
    from: (raw: number) => raw === 1,
  },
})
```

### PostgreSQL ENUM

You can use custom ENUM types in PostgreSQL. An ENUM restricts a column to a fixed set of allowed values, enforced by the database itself.

```typescript
@Column({
  type: "enum",
  enumValues: ["draft", "published", "archived"],
  enumName: "post_status",
})
status!: string;
```

This generates two SQL statements in PostgreSQL:

```sql
-- First, create the custom type
CREATE TYPE "post_status" AS ENUM ('draft', 'published', 'archived');

-- Then use it in the column definition
"status" "post_status" NOT NULL
```

> **Hint** If `enumName` is omitted, it is automatically generated in the format `{tableName}_{columnName}_enum`.

## Manual Primary Key (@PrimaryColumn)

Sometimes you need a primary key where you specify the value directly rather than using auto-increment. For example, a key-value structured configuration table where the key is a meaningful string.

```typescript
// config.entity.ts
import { Entity, PrimaryColumn, Column } from "@stingerloom/orm";

@Entity()
export class Config {
  @PrimaryColumn({ type: "varchar", length: 64 })
  key!: string;

  @Column({ type: "text" })
  value!: string;
}
```

**PostgreSQL DDL:**

```sql
CREATE TABLE "config" (
  "key" VARCHAR(64) NOT NULL,
  "value" TEXT NOT NULL,
  PRIMARY KEY ("key")
);
```

`@PrimaryColumn()` does not apply AUTO_INCREMENT/SERIAL, so you must provide the key value directly when calling `save()`.

```typescript
await em.save(Config, { key: "site.title", value: "My Blog" });
// INSERT INTO "config" ("key", "value") VALUES ('site.title', 'My Blog')
```

## Improving Query Performance with Indexes

### Why Indexes Exist

Imagine a library with 10 million books, but no catalog system. To find a book by author, you would need to walk through every shelf and check every book. That is what the database does without an index -- it scans every row in the table (called a "full table scan").

An **index** is like the library's catalog card system. It maintains a sorted data structure (usually a **B-tree**, a balanced tree optimized for disk reads) that lets the database jump directly to the matching rows. A query that takes 5 seconds on a million-row table with a full scan might take 5 milliseconds with an index.

The tradeoff: indexes consume disk space and slightly slow down INSERT/UPDATE operations (because the index must be updated too). Add indexes to columns that appear frequently in WHERE, JOIN, or ORDER BY clauses, but do not index every column.

### Single-Column Index

Adding an **Index** to frequently searched columns significantly improves query speed. Consider the case of searching for users by email.

```typescript
// user.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, Index } from "@stingerloom/orm";

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index()
  @Column()
  email!: string;
}
```

Adding `@Index()` generates the following DDL after the table is created:

```sql
-- PostgreSQL
CREATE INDEX "INDEX_user_email" ON "user" ("email");

-- MySQL
CREATE INDEX `INDEX_user_email` ON `user` (`email`);
```

Now, when the ORM executes:

```sql
SELECT * FROM "user" WHERE "email" = 'alice@example.com';
```

Instead of scanning every row, the database traverses the B-tree index to find the matching row in O(log n) time.

### Composite Index (@Index on class)

`@Index()` can also be used as a **class-level** decorator to create a composite (multi-column) non-unique index. This is useful for queries that filter on multiple columns simultaneously.

```typescript
// order.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, Index } from "@stingerloom/orm";

@Index(["tenantId", "status"])
@Entity()
export class Order {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "int" })
  tenantId!: number;

  @Column({ type: "varchar", length: 50 })
  status!: string;
}
```

This generates:

```sql
-- PostgreSQL
CREATE INDEX "idx_order_tenantId_status" ON "order" ("tenantId", "status");
```

A composite index works like a phone book sorted by last name, then first name. The database can use it for:
- `WHERE tenantId = 5` (uses the leftmost column)
- `WHERE tenantId = 5 AND status = 'pending'` (uses both columns -- most efficient)

But it cannot efficiently use it for `WHERE status = 'pending'` alone (skipping the leftmost column is like trying to find everyone named "John" in a phone book sorted by last name first).

You can also specify a custom index name.

```typescript
@Index(["tenantId", "status"], "idx_custom_name")
```

> **Hint** Property-level `@Index()` creates a single-column index. Class-level `@Index(columns)` creates a composite index. Both can be used on the same entity.

### Composite Unique Index (@UniqueIndex)

Sometimes the **combination** of multiple columns must be unique. For example, when a slug only needs to be unique within the same category.

```typescript
// post.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, UniqueIndex } from "@stingerloom/orm";

@UniqueIndex(["categoryId", "slug"])
@Entity()
export class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  categoryId!: number;

  @Column()
  slug!: string;
}
```

This generates:

```sql
-- PostgreSQL
CREATE UNIQUE INDEX "UQ_post_categoryId_slug" ON "post" ("categoryId", "slug");
```

With this unique index, the following data is allowed:

| categoryId | slug |
|------------|------|
| 1 | hello-world |
| 2 | hello-world |

But this would be rejected by the database:

| categoryId | slug |
|------------|------|
| 1 | hello-world |
| 1 | hello-world |

You can also specify the index name directly.

```typescript
@UniqueIndex(["categoryId", "slug"], { name: "uq_post_category_slug" })
```

> **Hint** `@UniqueIndex` and `@Index(columns)` are both **class-level** decorators. Property-level `@Index()` (no arguments) is placed on individual properties.

### Advanced Index Options

A basic B-tree index on a column is the most common case, but real-world databases need more specialized indexes. Think of it like tools in a workshop: a hammer works for most nails, but sometimes you need a screwdriver, a wrench, or a saw. Similarly, different query patterns call for different index strategies.

**Partial indexes** save disk space and improve performance by indexing only a subset of rows. If 90% of your users are active and you almost never query inactive users, why index all of them?

**Expression indexes** let you index a computed value. Without one, `WHERE LOWER(email) = 'alice@example.com'` cannot use a regular index on the `email` column because the index stores the original mixed-case values.

**GIN indexes** enable fast searches inside JSONB data and full-text search. **BRIN indexes** are extremely compact indexes for time-series data where values naturally correlate with physical row order.

The `@Index` class-level decorator accepts an `AdvancedIndexOptions` object as its second argument to configure all of these.

#### Partial Index

A partial index includes only rows that match a `WHERE` condition. This is useful for tables with soft delete, where you almost always query non-deleted rows.

```typescript
@Entity()
@Index(["email"], { where: "deleted_at IS NULL" })
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  email!: string;

  @DeletedAt()
  deletedAt!: Date | null;
}
```

**PostgreSQL DDL:**

```sql
CREATE INDEX "idx_user_email" ON "user" ("email") WHERE deleted_at IS NULL;
```

This index is smaller than a full index because it excludes soft-deleted rows. Queries with `WHERE email = '...' AND deleted_at IS NULL` use this index directly.

> **Note:** Partial indexes are supported on PostgreSQL and SQLite. MySQL does not support the `WHERE` clause on indexes.

#### Expression Index

An expression index indexes the result of an expression rather than a raw column value. This is essential for case-insensitive email lookups.

```typescript
@Entity()
@Index([], { expression: "LOWER(email)" })
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  email!: string;
}
```

**PostgreSQL DDL:**

```sql
CREATE INDEX "idx_user_lower_email" ON "user" ((LOWER(email)));
```

Now the query `WHERE LOWER(email) = 'alice@example.com'` uses this index instead of doing a full table scan. Notice that the column array is empty (`[]`) because the expression replaces the column list.

#### Index Type (USING)

By default, databases create B-tree indexes, which are optimal for equality and range queries. But other index types exist for specialized use cases.

```typescript
@Entity()
@Index(["metadata"], { using: "gin" })
export class Product {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "jsonb" })
  metadata!: Record<string, unknown>;
}
```

**PostgreSQL DDL:**

```sql
CREATE INDEX "idx_product_metadata" ON "product" USING gin ("metadata");
```

This GIN (Generalized Inverted Index) enables fast `@>` containment queries on JSONB data:

```sql
-- Find products where metadata contains {"color": "red"}
SELECT * FROM "product" WHERE "metadata" @> '{"color": "red"}';
-- Uses the GIN index instead of scanning every row
```

Available index types:

| Type | Best For | PostgreSQL | MySQL |
|------|----------|-----------|-------|
| `btree` | Equality, range, sorting (default) | Yes | Yes |
| `hash` | Equality only (no range) | Yes | Yes |
| `gin` | JSONB, arrays, full-text search | Yes | No |
| `gist` | Geometric, full-text, range types | Yes | No |
| `brin` | Large time-series tables | Yes | No |

> **Note:** MySQL only supports `btree` and `hash`. If you specify `gin`, `gist`, or `brin` and run against MySQL, the index creation will fail.

#### Covering Index (INCLUDE)

A covering index stores additional columns alongside the indexed columns so that the database can answer a query entirely from the index, without reading the main table. This is called an "index-only scan."

```typescript
@Entity()
@Index(["email"], { include: ["name"] })
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  email!: string;

  @Column()
  name!: string;
}
```

**PostgreSQL DDL:**

```sql
CREATE INDEX "idx_user_email" ON "user" ("email") INCLUDE ("name");
```

Now a query like `SELECT name FROM "user" WHERE email = 'alice@example.com'` can be served entirely from the index without touching the heap (main table storage). The `INCLUDE` columns are stored in the index leaf pages but are not part of the search key.

> **Note:** Covering indexes with `INCLUDE` are supported on PostgreSQL 11+. MySQL does not support the `INCLUDE` clause.

#### Combining Options

Advanced index options can be combined. For example, a partial covering index:

```typescript
@Index(["email"], {
  where: "deleted_at IS NULL",
  include: ["name"],
  name: "idx_active_user_email",
})
```

**PostgreSQL DDL:**

```sql
CREATE INDEX "idx_active_user_email" ON "user" ("email") INCLUDE ("name") WHERE deleted_at IS NULL;
```

This creates a compact, high-performance index that covers only active users and includes the name column for index-only scans.

## JSON Path Indexes (@JsonIndex)

### Why @JsonIndex Exists

A `jsonb` column without an index requires a sequential scan for every query — even `WHERE data @> '{"tags":["typescript"]}'` on a million-row table. PostgreSQL supports **expression indexes** over JSON paths (`CREATE INDEX ... USING GIN ((data->'tags') jsonb_path_ops)`), but writing them by hand ties your migration SQL to a specific path and opclass that drifts from the entity.

`@JsonIndex` declares the index on the property so the schema generator emits the correct DDL, and QueryDSL path operations (`u.profile.tags.contains(...)`) line up with a path your DB can actually use.

### How It Works

```typescript
import { Entity, PrimaryGeneratedColumn, Column, JsonIndex } from "@stingerloom/orm";

@Entity()
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  // GIN index on a sub-path for @> / ? queries
  @Column({ type: "jsonb" })
  @JsonIndex({ path: "tags", using: "gin", opclass: "jsonb_path_ops" })
  profile!: { tags: string[]; contact: { email: string } };
}
```

**PostgreSQL DDL:**

```sql
CREATE INDEX "idx_user_profile_tags_gin"
  ON "user" USING gin ((profile -> 'tags') jsonb_path_ops);
```

### Option Reference

| Option | Type | Default | Description |
|---|---|---|---|
| `path` | `string?` | *(whole column)* | Dot-bracket path inside the column: `"tags"`, `"contact.email"`, `"tags[0]"`. Omit to index the whole column. |
| `using` | `"gin" \| "btree"` | `"gin"` | `gin` for containment (`@>`) / key-existence (`?`); `btree` for leaf scalar paths (equality / range). |
| `opclass` | `"jsonb_ops" \| "jsonb_path_ops"` | `"jsonb_ops"` | `jsonb_path_ops` is smaller & faster when the index only serves `@>`. Ignored for `btree`. |
| `where` | `string?` | — | Partial-index `WHERE` clause (raw SQL). The caller is responsible for identifier wrapping and parameter safety. |
| `name` | `string?` | *auto* | Override the index name. Auto-generated via `NamingStrategy.jsonIndexName()`. |

### Patterns

**Whole-column GIN** — covers every `@>` / `?` / `?&` query under the column, at the cost of a larger index:

```typescript
@Column({ type: "jsonb" })
@JsonIndex({ using: "gin" })
profile!: UserProfile;
```

**Leaf btree on a text path** — for equality/range on a single scalar leaf:

```typescript
@Column({ type: "jsonb" })
@JsonIndex({ path: "contact.email", using: "btree" })
profile!: UserProfile;
```

Emits `CREATE INDEX ... ON "user" (((profile #>> '{contact,email}')))`.

**Partial index** — skip rows that will never match:

```typescript
@Column({ type: "jsonb" })
@JsonIndex({
  path: "tags",
  using: "gin",
  opclass: "jsonb_path_ops",
  where: `"deleted_at" IS NULL`,
})
profile!: UserProfile;
```

### Dialect Behavior

| Driver | Behavior |
|---|---|
| **PostgreSQL** | Emits `CREATE INDEX ... USING gin ((col -> 'path') [jsonb_path_ops])` for GIN; `((col #>> '{path}'))` for btree. |
| **MySQL** | **No DDL is emitted.** MySQL 8 supports functional JSON indexes only via virtual generated columns — a structural schema change beyond an index declaration. A warning is logged at DDL generation. Create the generated column + index manually if you need one. |
| **SQLite** | **No DDL is emitted.** SQLite has no GIN equivalent. |

### Pairing with QueryDSL

QueryDSL's JSON operators compile to the same path expression your index was built on, so the planner can use it:

```typescript
const users = await qb
  .qWhere((u) => u.profile.tags.contains("typescript"))
  .getMany();
// PostgreSQL: WHERE profile -> 'tags' @> '"typescript"'::jsonb
// Uses: idx_user_profile_tags_gin
```

See [Query Builder — JSON Path Operators](/query-builder-json) for the full operator catalog.

## Optimistic Locking (@Version)

### Why Optimistic Locking Exists

Imagine two customer service agents opening the same order at 10:00 AM. Agent A changes the status to "shipped" at 10:01. Agent B, still looking at the old data, changes the status to "refunded" at 10:02. Agent B's update silently overwrites Agent A's change. This is the **lost update problem**.

One solution is **pessimistic locking** -- lock the row so nobody else can touch it. But this is slow and can cause deadlocks. A better approach for most applications is **optimistic locking**: assume conflicts are rare, but detect them when they happen.

### How It Works

Using the `@Version()` decorator adds a version counter to your entity.

```typescript
// order.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, Version } from "@stingerloom/orm";

@Entity()
export class Order {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  status!: string;

  @Version()
  version!: number;
}
```

**DDL generated:**

```sql
-- PostgreSQL
CREATE TABLE "order" (
  "id" SERIAL PRIMARY KEY,
  "status" VARCHAR(255) NOT NULL,
  "version" INTEGER NOT NULL
);
```

Here is exactly what happens at the SQL level.

**On INSERT**, the ORM automatically sets `version = 1`:

```sql
INSERT INTO "order" ("status", "version") VALUES ('pending', 1);
```

**On UPDATE**, the ORM adds `WHERE version = N` and increments the version:

```sql
-- Agent A reads the order: { id: 1, status: 'pending', version: 1 }
-- Agent A updates it:
UPDATE "order"
SET "status" = 'shipped', "version" = "version" + 1
WHERE "id" = 1 AND "version" = 1;
-- This succeeds (1 row affected). version is now 2.

-- Agent B also read version 1, tries to update:
UPDATE "order"
SET "status" = 'refunded', "version" = "version" + 1
WHERE "id" = 1 AND "version" = 1;
-- This fails (0 rows affected) because version is now 2.
-- Stingerloom throws OptimisticLockError.
```

When the UPDATE affects 0 rows, it means someone else modified the data first. Stingerloom detects this and throws an `OptimisticLockError`, preventing the silent data loss.

> **Hint** Optimistic locking is suitable when conflicts are rare but data integrity is important (e.g., order status changes, inventory management). For high-contention scenarios where conflicts happen on nearly every request, consider pessimistic locking with `SELECT ... FOR UPDATE` instead.

## Soft Delete (@DeletedAt)

### Why Soft Delete Exists

Hard delete (`DELETE FROM ...`) permanently removes data. Once deleted, it is gone forever (unless you have backups). In many real-world applications, you want to:

1. Let users "undo" a deletion (like a trash can in a file system)
2. Keep audit trails for compliance
3. Preserve data for analytics while hiding it from the application

Soft delete solves this by never actually deleting the row. Instead, it marks the row with a timestamp indicating when it was "deleted."

### How It Works

```typescript
// post.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, DeletedAt } from "@stingerloom/orm";

@Entity()
export class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @DeletedAt()
  deletedAt!: Date | null;
}
```

**DDL generated:**

```sql
-- PostgreSQL
CREATE TABLE "post" (
  "id" SERIAL PRIMARY KEY,
  "title" VARCHAR(255) NOT NULL,
  "deletedAt" TIMESTAMP          -- nullable (NULL means "not deleted")
);
```

Adding the `@DeletedAt()` decorator changes three things at the SQL level.

**First**, calling `em.softDelete(Post, { id: 1 })` executes an UPDATE, not a DELETE:

```sql
-- Instead of: DELETE FROM "post" WHERE "id" = 1
-- Stingerloom runs:
UPDATE "post" SET "deletedAt" = NOW() WHERE "id" = 1;
```

**Second**, `em.find(Post)` automatically adds a `WHERE` filter to exclude soft-deleted rows:

```sql
-- Your code:
await em.find(Post);

-- Generated SQL:
SELECT * FROM "post" WHERE "deletedAt" IS NULL;
```

Every query automatically ignores soft-deleted rows. You do not need to remember to add this condition yourself.

**Third**, to include deleted data in the query, use the `{ withDeleted: true }` option:

```sql
-- Your code:
await em.find(Post, { withDeleted: true });

-- Generated SQL (no filter):
SELECT * FROM "post";
```

And to restore a soft-deleted row:

```sql
-- Your code:
await em.restore(Post, { id: 1 });

-- Generated SQL:
UPDATE "post" SET "deletedAt" = NULL WHERE "id" = 1;
```

Here is the complete lifecycle in code:

```typescript
await em.softDelete(Post, { id: 1 });                      // soft delete
const posts = await em.find(Post);                         // excludes deleted
const all = await em.find(Post, { withDeleted: true });    // includes deleted
await em.restore(Post, { id: 1 });                         // restore
```

## Automatic Timestamps (@CreateTimestamp / @UpdateTimestamp)

### Why Automatic Timestamps Exist

Almost every table in a production application needs to answer two questions: "When was this row created?" and "When was it last modified?" These timestamps are essential for debugging ("when did this data change?"), sorting ("show newest first"), and auditing.

You could set these manually every time you call `save()`, but that is error-prone -- forget once and you have bad data. The `@CreateTimestamp` and `@UpdateTimestamp` decorators handle this automatically.

### How It Works

```typescript
// article.entity.ts
import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateTimestamp, UpdateTimestamp,
} from "@stingerloom/orm";

@Entity()
export class Article {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @CreateTimestamp()
  createdAt!: Date;

  @UpdateTimestamp()
  updatedAt!: Date;
}
```

**DDL generated:**

```sql
-- PostgreSQL
CREATE TABLE "article" (
  "id" SERIAL PRIMARY KEY,
  "title" VARCHAR(255) NOT NULL,
  "createdAt" TIMESTAMP NOT NULL,
  "updatedAt" TIMESTAMP NOT NULL
);

-- MySQL
CREATE TABLE `article` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `title` VARCHAR(255) NOT NULL,
  `createdAt` DATETIME NOT NULL,
  `updatedAt` DATETIME NOT NULL,
  PRIMARY KEY (`id`)
);
```

Here is exactly when the ORM sets each value.

**On INSERT**, both `createdAt` and `updatedAt` are set to the current time:

```sql
-- Your code:
await em.save(Article, { title: "Hello World" });

-- Generated SQL (PostgreSQL):
INSERT INTO "article" ("title", "createdAt", "updatedAt")
VALUES ('Hello World', '2026-03-22 10:30:00', '2026-03-22 10:30:00');
```

The ORM generates the timestamp in application code (`new Date()`), not with a SQL function like `NOW()`. This means both columns get exactly the same value, down to the millisecond.

**On UPDATE**, only `updatedAt` is refreshed. `createdAt` is left untouched:

```sql
-- Your code:
await em.save(Article, { id: 1, title: "Hello World (updated)" });

-- Generated SQL (PostgreSQL):
UPDATE "article"
SET "title" = 'Hello World (updated)', "updatedAt" = '2026-03-22 11:45:00'
WHERE "id" = 1;
-- Notice: createdAt is NOT in the SET clause
```

Both decorators create a `DATETIME` (MySQL) / `TIMESTAMP` (PostgreSQL) NOT NULL column. If you need timezone-aware timestamps in PostgreSQL, use `@Column({ type: "timestamptz" })` with lifecycle hooks instead.

> **Hint** If a value is explicitly provided for a `@CreateTimestamp` or `@UpdateTimestamp` column in the `save()` call, the provided value is used instead of the auto-generated one. This is useful for data migration scenarios where you want to preserve original timestamps.

### Computed Columns (@ComputedColumn)

Some column values are always derived from other columns. A person's full name is always `first_name + ' ' + last_name`. An order line's total is always `price * quantity`. You could calculate these in your application code, but then every query, every service, and every report must repeat the same formula. Forget once, and the value is wrong. It is like having a spreadsheet where instead of using a formula, you manually type the total in every cell -- eventually someone makes a mistake.

A **computed column** (also called a "generated column") moves this formula into the database itself. The database guarantees the value is always correct, just like a spreadsheet formula that recalculates automatically.

```typescript
// order-line.entity.ts
import {
  Entity, PrimaryGeneratedColumn, Column, ComputedColumn,
} from "@stingerloom/orm";

@Entity()
export class OrderLine {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "float" })
  price!: number;

  @Column({ type: "int" })
  quantity!: number;

  @ComputedColumn({
    expression: "price * quantity",
    stored: true,
    type: "float",
  })
  total!: number;
}
```

**PostgreSQL DDL:**

```sql
CREATE TABLE "orderLine" (
  "id" SERIAL PRIMARY KEY,
  "price" REAL NOT NULL,
  "quantity" INTEGER NOT NULL,
  "total" REAL GENERATED ALWAYS AS (price * quantity) STORED
);
```

**MySQL DDL:**

```sql
CREATE TABLE `orderLine` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `price` FLOAT NOT NULL,
  `quantity` INT NOT NULL,
  `total` FLOAT GENERATED ALWAYS AS (price * quantity) STORED,
  PRIMARY KEY (`id`)
);
```

The `GENERATED ALWAYS AS (expression)` clause tells the database to compute this value automatically. You never set it yourself -- in fact, the database will reject any INSERT or UPDATE that tries to write to a generated column.

Stingerloom automatically excludes computed columns from INSERT and UPDATE statements. When you call `em.save()`, the ORM knows not to include `total` in the SQL:

```typescript
await em.save(OrderLine, { price: 29.99, quantity: 3 });
// Generated SQL (PostgreSQL):
// INSERT INTO "orderLine" ("price", "quantity") VALUES (29.99, 3)
// Note: "total" is NOT in the INSERT -- the DB computes it as 89.97
```

Here is another common example -- concatenating first and last names:

```typescript
@Entity()
export class Person {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  firstName!: string;

  @Column()
  lastName!: string;

  @ComputedColumn({
    expression: "first_name || ' ' || last_name",
    stored: true,
    type: "varchar",
    length: 511,
  })
  fullName!: string;
}
```

**PostgreSQL DDL:**

```sql
"fullName" VARCHAR(511) GENERATED ALWAYS AS (first_name || ' ' || last_name) STORED
```

#### STORED vs VIRTUAL

The `stored` option controls how the database handles the computed value:

| Mode | `stored` | Behavior | Disk Space | Indexable |
|------|----------|----------|-----------|-----------|
| **STORED** | `true` | Computed on INSERT/UPDATE, saved to disk | Uses space | Yes |
| **VIRTUAL** | `false` (default) | Computed on every SELECT read | No extra space | Limited |

**STORED** columns are computed once when the row is written and persisted on disk like a regular column. They can be indexed, which makes them suitable for columns you search or sort by (like `fullName`).

**VIRTUAL** columns are computed every time the row is read. They use no extra disk space but add CPU overhead on every SELECT. Use virtual columns for values you display but never search by.

```typescript
// VIRTUAL -- computed on every read, no disk usage
@ComputedColumn({
  expression: "price * quantity",
  stored: false,  // this is the default
})
total!: number;

// STORED -- computed once on write, persisted, indexable
@ComputedColumn({
  expression: "price * quantity",
  stored: true,
})
total!: number;
```

> **Hint** Computed columns are supported on PostgreSQL 12+, MySQL 5.7+, and SQLite. The `@ComputedColumn` decorator accepts optional `type`, `length`, and `nullable` options. If `type` is omitted, the database infers the type from the expression.

## Lifecycle Hooks

### Why Lifecycle Hooks Exist

Sometimes you need custom logic to run at specific moments during an entity's lifecycle -- before it is inserted, after it is updated, before it is deleted. For example, you might want to generate a URL slug from the title before saving, or send a notification after an entity is created.

Lifecycle hooks let you define this logic directly on the entity class, so it runs automatically every time the entity goes through that lifecycle event.

### How It Works

```typescript
// article.entity.ts
import {
  Entity, PrimaryGeneratedColumn, Column,
  BeforeInsert, BeforeUpdate,
} from "@stingerloom/orm";

@Entity()
export class Article {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @Column({ type: "varchar", length: 255, nullable: true })
  slug!: string | null;

  @BeforeInsert()
  generateSlug() {
    if (!this.slug) {
      this.slug = this.title.toLowerCase().replace(/\s+/g, "-");
    }
  }
}
```

Methods decorated with `@BeforeInsert()` are automatically called just before the INSERT SQL is executed. In the example above, when you call `em.save(Article, { title: "Hello World" })`, the ORM first calls `generateSlug()` which sets `this.slug = "hello-world"`, and then the INSERT includes the slug:

```sql
INSERT INTO "article" ("title", "slug") VALUES ('Hello World', 'hello-world');
```

There are 6 available lifecycle hooks in total.

| Decorator | Execution Timing | When to Use |
|-----------|-----------------|-------------|
| `@BeforeInsert()` | Just before INSERT SQL executes | Default values, slug generation, data normalization |
| `@AfterInsert()` | After INSERT completes | Logging, sending notifications, cache invalidation |
| `@BeforeUpdate()` | Just before UPDATE SQL executes | Updating computed fields, validation |
| `@AfterUpdate()` | After UPDATE completes | Recording change history, triggering webhooks |
| `@BeforeDelete()` | Just before DELETE SQL executes | Cleanup before deletion, permission checks |
| `@AfterDelete()` | After DELETE completes | Cleaning up related resources, logging |

The execution order for a `save()` call that inserts a new entity is:

1. `@BeforeInsert()` hooks run (you can mutate the entity here)
2. `INSERT INTO ...` SQL executes
3. `@AfterInsert()` hooks run (the entity now has its auto-generated ID)

> **Hint** In "After" hooks, the DB operation has already completed, so modifying data will not be reflected in the DB. Use them for side effects like logging or external notifications.

## Validation

### Why Validation Exists

The database has some built-in constraints (NOT NULL, VARCHAR length, UNIQUE), but they produce cryptic error messages and only catch problems after a network round-trip. Application-level validation catches mistakes early, before the SQL query is even built, and returns clear error messages.

### How It Works

Use validation decorators when you want to automatically verify that data is correct when `save()` is called. If validation fails, a `ValidationError` is thrown to prevent invalid data from entering the DB.

```typescript
// member.entity.ts
import {
  Entity, PrimaryGeneratedColumn, Column,
  NotNull, MinLength, MaxLength, Min, Max,
} from "@stingerloom/orm";

@Entity()
export class Member {
  @PrimaryGeneratedColumn()
  id!: number;

  @NotNull()
  @MinLength(2)
  @MaxLength(50)
  @Column()
  name!: string;

  @Min(0)
  @Max(150)
  @Column()
  age!: number;
}
```

Each decorator's role is self-explanatory.

- **`@NotNull()`** -- Error if `null` or `undefined`
- **`@MinLength(n)` / `@MaxLength(n)`** -- String length validation
- **`@Min(n)` / `@Max(n)`** -- Numeric range validation

Calling `save()` with invalid data will throw an error before the DB query is executed. No SQL is sent to the database at all.

```typescript
await em.save(Member, { name: "A", age: -1 });
// ValidationError: name must be at least 2 characters long
// (no INSERT was attempted)
```

This is different from a database constraint error. A `NOT NULL` constraint violation returns a database-specific error after the query is sent. A `@NotNull()` validation error is caught in your application code before any network call.

## Complete Real-World Example

Here is a blog user entity that combines all the features covered so far.

```typescript
// user.entity.ts
import {
  Entity, PrimaryGeneratedColumn, Column, Index, Version,
  DeletedAt, CreateTimestamp, UpdateTimestamp, AfterInsert,
  NotNull, MinLength, MaxLength,
} from "@stingerloom/orm";

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @NotNull()
  @MinLength(2)
  @MaxLength(50)
  @Column()
  name!: string;

  @NotNull()
  @Index()
  @Column({ type: "varchar", length: 255 })
  email!: string;

  @Column({ type: "varchar", length: 20, nullable: true })
  phone!: string | null;

  @Column({ type: "boolean" })
  isActive!: boolean;

  @Column({ type: "json", nullable: true })
  profile!: Record<string, unknown> | null;

  @Version()
  version!: number;

  @DeletedAt()
  deletedAt!: Date | null;

  @CreateTimestamp()
  createdAt!: Date;

  @UpdateTimestamp()
  updatedAt!: Date;

  @AfterInsert()
  log() {
    console.log(`User #${this.id} created`);
  }
}
```

**PostgreSQL DDL:**

```sql
CREATE TABLE "user" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL,
  "email" VARCHAR(255) NOT NULL,
  "phone" VARCHAR(20),
  "isActive" BOOLEAN NOT NULL,
  "profile" JSON,
  "version" INTEGER NOT NULL,
  "deletedAt" TIMESTAMP,
  "createdAt" TIMESTAMP NOT NULL,
  "updatedAt" TIMESTAMP NOT NULL
);

CREATE INDEX "INDEX_user_email" ON "user" ("email");
```

Here is the SQL that Stingerloom generates for common operations on this entity.

**INSERT (new user):**

```sql
INSERT INTO "user" ("name", "email", "phone", "isActive", "profile", "version", "createdAt", "updatedAt")
VALUES ('Alice', 'alice@example.com', NULL, TRUE, NULL, 1, '2026-03-22 10:00:00', '2026-03-22 10:00:00')
RETURNING *;
-- Note: version is auto-set to 1, both timestamps are auto-set
-- After INSERT, the @AfterInsert hook runs: console.log("User #1 created")
```

**UPDATE (change name):**

```sql
UPDATE "user"
SET "name" = 'Alice Smith', "updatedAt" = '2026-03-22 11:00:00', "version" = "version" + 1
WHERE "id" = 1 AND "version" = 1;
-- Note: createdAt is NOT updated, version increments, updatedAt refreshes
```

**Soft delete:**

```sql
UPDATE "user" SET "deletedAt" = NOW() WHERE "id" = 1;
```

**Find (auto-excludes soft-deleted):**

```sql
SELECT * FROM "user" WHERE "deletedAt" IS NULL;
```

This single entity includes auto-increment PK, validation, index, JSON column, optimistic locking, Soft Delete, automatic timestamps, and logging.

## ColumnType Reference

### TypeScript Type Auto-Inference

When `type` is omitted in `@Column()`, it is automatically inferred from the TypeScript type.

| TypeScript Type | ColumnType | Default Length | nullable |
|----------------|-----------|---------------|----------|
| `String` | varchar | 255 | false |
| `Number` | int | 11 | false |
| `Boolean` | boolean | 1 | false |
| `Date` | datetime | 0 | false |
| `Buffer` | blob | 0 | true |
| Other | text | 0 | true |

### DB Mapping by ColumnType

This table shows how each abstract `ColumnType` is translated to a concrete database type by each driver's `castType()` method.

| ColumnType | MySQL/MariaDB | PostgreSQL | SQLite |
|-----------|--------------|-----------|--------|
| `varchar` | VARCHAR(n) | VARCHAR(n) | TEXT |
| `int` / `number` | INT | INTEGER | INTEGER |
| `float` | FLOAT | REAL | REAL |
| `double` | DOUBLE | DOUBLE PRECISION | REAL |
| `bigint` | BIGINT | BIGINT | INTEGER |
| `boolean` | TINYINT(1) | BOOLEAN | INTEGER |
| `datetime` | DATETIME | TIMESTAMP | TEXT |
| `timestamp` | TIMESTAMP | TIMESTAMP | TEXT |
| `timestamptz` | DATETIME | TIMESTAMPTZ | TEXT |
| `date` | DATE | DATE | TEXT |
| `text` | TEXT | TEXT | TEXT |
| `longtext` | LONGTEXT | TEXT | TEXT |
| `blob` | BLOB | BYTEA | BLOB |
| `json` | JSON | JSON | TEXT |
| `jsonb` | JSON | JSONB | TEXT |
| `enum` | ENUM | (custom ENUM) | TEXT |

### @Column Full Options

| Option | Type | Description |
|--------|------|-------------|
| `name` | `string` | DB column name (defaults to property name) |
| `type` | `ColumnType` | Column type (auto-inferred if omitted) |
| `length` | `number` | Column length |
| `nullable` | `boolean` | Allow NULL (default: false) |
| `primary` | `boolean` | Whether it is a primary key |
| `autoIncrement` | `boolean` | Whether to apply AUTO_INCREMENT |
| `default` | `unknown` | Column default value (literal or raw SQL in parentheses) |
| `transform` | `(raw) => any` | **(deprecated)** Read-only value transform function |
| `transformer` | `{ to, from }` | Bidirectional value transformer (write and read) |
| `precision` | `number` | Decimal precision |
| `scale` | `number` | Decimal scale |
| `enumValues` | `string[]` | PostgreSQL ENUM value list |
| `enumName` | `string` | PostgreSQL ENUM type name |

## Defining Entities Without Decorators (EntitySchema)

### Why EntitySchema Exists

TypeScript decorators rely on the `emitDecoratorMetadata` compiler option, which some build tools (esbuild, SWC) do not support. Even with full decorator support, some teams prefer to keep their domain classes free of ORM-specific annotations, following the "plain class" philosophy. `EntitySchema` addresses both concerns by separating the schema definition from the class itself.

`EntitySchema` registers the same metadata as the decorator-based approach, so the rest of the ORM (EntityManager, SchemaGenerator, etc.) works identically. Both approaches can coexist in the same project.

### Basic Usage

```typescript
import { EntitySchema } from "@stingerloom/orm";

class User {
  id!: number;
  name!: string;
  email!: string;
}

const UserSchema = new EntitySchema<User>({
  target: User,
  tableName: "users",
  columns: {
    id:    { type: "int", primary: true, autoIncrement: true },
    name:  { type: "varchar" },
    email: { type: "varchar", nullable: true, index: true },
  },
});
```

This produces the exact same DDL as the decorator-based version:

```sql
-- PostgreSQL
CREATE TABLE "users" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL,
  "email" VARCHAR(255)
);
CREATE INDEX "INDEX_users_email" ON "users" ("email");
```

The `target` class is a plain TypeScript class -- no decorators needed. The `tableName` is optional; if omitted, it is derived from the class name in snake_case (same as `@Entity()`).

### Column Options

`ColumnSchemaDef` supports the same options as `@Column()`, plus flags for special decorators:

```typescript
columns: {
  id:        { type: "int", primary: true, autoIncrement: true },
  name:      { type: "varchar", length: 100 },
  email:     { type: "varchar", nullable: true, index: true },
  status:    { type: "enum", enumValues: ["active", "inactive"], enumName: "user_status" },
  bio:       { type: "text", nullable: true, default: null },
  version:   { type: "int", version: true },
  createdAt: { type: "datetime", createTimestamp: true },
  updatedAt: { type: "datetime", updateTimestamp: true },
  deletedAt: { type: "datetime", nullable: true, deletedAt: true },
}
```

The `version`, `createTimestamp`, `updateTimestamp`, and `deletedAt` flags replace the corresponding `@Version()`, `@CreateTimestamp()`, `@UpdateTimestamp()`, and `@DeletedAt()` decorators. The generated DDL and runtime behavior are identical.

### Relations

Relations are defined using the `relations` option with a `kind` discriminator:

```typescript
class Post {
  id!: number;
  title!: string;
  author!: User;
  comments!: Comment[];
  tags!: Tag[];
}

const PostSchema = new EntitySchema<Post>({
  target: Post,
  columns: {
    id:    { type: "int", primary: true, autoIncrement: true },
    title: { type: "varchar" },
  },
  relations: {
    author: {
      kind: "manyToOne",
      target: () => User,
      joinColumn: "author_id",
      eager: true,
    },
    comments: {
      kind: "oneToMany",
      target: () => Comment,
      mappedBy: "post",
    },
    tags: {
      kind: "manyToMany",
      target: () => Tag,
      joinTable: {
        name: "post_tags",
        joinColumn: "post_id",
        inverseJoinColumn: "tag_id",
      },
    },
  },
});
```

All four relation kinds are supported:

| `kind` | Equivalent Decorator | Required Options |
|--------|---------------------|-----------------|
| `"manyToOne"` | `@ManyToOne()` | `target`, optionally `joinColumn`, `eager`, `lazy`, `cascade` |
| `"oneToMany"` | `@OneToMany()` | `target`, `mappedBy` |
| `"oneToOne"` | `@OneToOne()` | `target`, optionally `joinColumn`, `inverseSide`, `eager`, `cascade` |
| `"manyToMany"` | `@ManyToMany()` | `target`, optionally `joinTable` (owning) or `mappedBy` (inverse) |

### Unique Indexes

```typescript
const UserSchema = new EntitySchema<User>({
  target: User,
  columns: { /* ... */ },
  uniqueIndexes: [
    { columns: ["email", "tenantId"], name: "uq_user_email_tenant" },
  ],
});
```

### Lifecycle Hooks

Point to method names on the target class:

```typescript
class Article {
  id!: number;
  title!: string;

  generateSlug() {
    // ...
  }
}

const ArticleSchema = new EntitySchema<Article>({
  target: Article,
  columns: {
    id:    { type: "int", primary: true, autoIncrement: true },
    title: { type: "varchar" },
  },
  hooks: {
    beforeInsert: "generateSlug",
  },
});
```

### Validation

Inline validation via the `validation` array in column definitions:

```typescript
columns: {
  name: {
    type: "varchar",
    validation: [
      { constraint: "notNull" },
      { constraint: "minLength", value: 2, message: "Name too short" },
    ],
  },
  age: {
    type: "int",
    validation: [
      { constraint: "min", value: 0 },
      { constraint: "max", value: 150 },
    ],
  },
}
```

### Inheritance Mapping

EntitySchema supports all three inheritance strategies (STI, TPT, TPC) using the `inheritance`, `discriminatorColumn`, and `discriminatorValue` options. These replace the `@Inheritance()`, `@DiscriminatorColumn()`, and `@DiscriminatorValue()` decorators.

**Single Table Inheritance (STI):**

```typescript
class Payment {
  id!: number;
  amount!: number;
}

class CreditCardPayment extends Payment {
  cardNumber!: string;
}

class BankTransferPayment extends Payment {
  bankCode!: string;
}

// Root entity: defines strategy + discriminator column
new EntitySchema<Payment>({
  target: Payment,
  inheritance: { strategy: "SINGLE_TABLE" },
  discriminatorColumn: { name: "payment_type", type: "varchar", length: 50 },
  columns: {
    id:     { type: "int", primary: true, autoIncrement: true },
    amount: { type: "int" },
  },
});

// Child entities: only define their own columns + discriminator value
new EntitySchema<CreditCardPayment>({
  target: CreditCardPayment,
  discriminatorValue: "credit_card",
  columns: {
    cardNumber: { type: "varchar", nullable: true },
  },
});

new EntitySchema<BankTransferPayment>({
  target: BankTransferPayment,
  discriminatorValue: "bank_transfer",
  columns: {
    bankCode: { type: "varchar", nullable: true },
  },
});
```

Child entities automatically inherit parent columns via the prototype chain. For STI, all children share the root's table name. For TPT (`"JOINED"`) and TPC (`"TABLE_PER_CLASS"`), each child gets its own table.

**Joined / Table Per Type (TPT):**

```typescript
new EntitySchema<Payment>({
  target: Payment,
  inheritance: { strategy: "JOINED" },
  discriminatorColumn: { name: "payment_type" },
  columns: {
    id:     { type: "int", primary: true, autoIncrement: true },
    amount: { type: "int" },
  },
});

new EntitySchema<CreditCardPayment>({
  target: CreditCardPayment,
  discriminatorValue: "credit_card",
  columns: {
    cardNumber: { type: "varchar" },  // NOT NULL is allowed in TPT
  },
});
```

**Table Per Class (TPC):**

```typescript
new EntitySchema<Payment>({
  target: Payment,
  inheritance: { strategy: "TABLE_PER_CLASS" },
  discriminatorColumn: { name: "payment_type" },
  columns: {
    id:     { type: "int", primary: true, autoIncrement: true },
    amount: { type: "int" },
  },
});

new EntitySchema<CreditCardPayment>({
  target: CreditCardPayment,
  discriminatorValue: "credit_card",
  columns: {
    cardNumber: { type: "varchar" },
  },
});
```

The `discriminatorColumn` option is optional on the root entity -- if omitted, a column named `"dtype"` with type `VARCHAR(31)` is created by default. The `discriminatorValue` option is optional on child entities -- if omitted, the class name is used.

All ORM features (EntityManager, QueryBuilder, WriteBuffer, InheritanceResolver) work identically whether entities are defined with decorators or EntitySchema.

::: tip
For a detailed comparison of all three strategies with generated SQL examples, see the [Inheritance Mapping](./inheritance-mapping.md) guide.
:::

### Mixing Decorator and EntitySchema Entities

Both approaches produce the same metadata, so you can freely mix them:

```typescript
// user.entity.ts — uses decorators
@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;
  // ...
}

// audit-log.schema.ts — uses EntitySchema
class AuditLog {
  id!: number;
  action!: string;
}

const AuditLogSchema = new EntitySchema<AuditLog>({
  target: AuditLog,
  columns: {
    id:     { type: "int", primary: true, autoIncrement: true },
    action: { type: "varchar" },
  },
});

// Both can be used with EntityManager
await em.register({ entities: [User, AuditLog], /* ... */ });
```

## Next Steps

Now that you've defined entities, it's time to set up relationships between them.

- [Relations](./relations.md) -- Define relationships between tables with `@ManyToOne`, `@OneToMany`, etc.
- [EntityManager](./entity-manager.md) -- Perform CRUD with your defined entities
- [Transactions](./transactions.md) -- Group multiple operations into a single unit
- [Migrations](./migrations.md) -- Safely manage schema changes
