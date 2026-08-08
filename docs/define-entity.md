# Defining Entities

Stingerloom's recommended way to define an entity is the **code-first builder API**: `defineEntity` together with the `t` field builders. You write one declaration, and the entity's TypeScript type is **inferred from the schema** — no hand-written class, no parallel interface, no `experimentalDecorators`, no `emitDecoratorMetadata`, no build-time codegen.

```typescript
import { defineEntity, t, InferEntity } from "@stingerloom/orm";

export const User = defineEntity("users", {
  id:        t.int().primary().generated(),
  email:     t.varchar(255).unique(),
  name:      t.varchar(255).nullable(),
  role:      t.enum(["admin", "user"]).default("user"),
  createdAt: t.datetime().createTimestamp(),
});

export type User = InferEntity<typeof User>;
// { id: number; email: string; name: string | null;
//   role: "admin" | "user"; createdAt: Date }
```

`User` is a real runtime class — use it everywhere the ORM expects an entity (`em.getRepository(User)`, `em.findOne(User, …)`, relation targets). `InferEntity<typeof User>` recovers the row type, so the same name doubles as a type.

::: tip Prefer decorators?
The decorator API (`@Entity`, `@Column`, …) is fully supported and produces identical metadata — see [Entities & Columns (Decorators)](./entities.md). The two styles interoperate freely in the same project. This page is the recommended default for new code, and it covers the **same ground** as the decorator guide: every feature you can express with a decorator has a builder here.
:::

## Why code-first

Without an ORM, you describe a table three or four times: the `CREATE TABLE`, the `INSERT`, the `SELECT`, and the TypeScript type. Add a column and you edit all of them. Decorator ORMs collapse that to one class, but they lean on the `emitDecoratorMetadata` compiler flag to read your property types — a flag that esbuild, SWC, Vite's default transformer, and the TypeScript 5 *standard* decorators do not emit. When the metadata is missing, a `@Column()` silently loses its type.

`defineEntity` removes that dependency entirely:

- **One source of truth.** The column builder fixes both the database type *and* the TypeScript type. `t.int()` is a `number`; you cannot accidentally annotate it as a `string`. With a hand-written class plus a separate schema, those two can silently drift.
- **Type inference, no codegen.** `InferEntity` reads the builders directly. There is no generate step and no watch process — the type updates the instant you edit the schema.
- **No decorator toolchain.** Works under strict mode and ESM with esbuild, swc, Vite, or Bun without `experimentalDecorators` / `emitDecoratorMetadata`. Nothing to misconfigure.

Internally, `defineEntity` converts the builders into the exact same metadata the decorators register, then hands it to the `EntitySchema` bridge. The rest of the ORM — EntityManager, SchemaGenerator, QueryBuilder, WriteBuffer — cannot tell the difference between a builder entity, a decorated entity, and a hand-written `EntitySchema`.

## Creating Your First Entity

Suppose you want to store users. The simplest entity is two columns:

```typescript
// user.entity.ts
import { defineEntity, t, InferEntity } from "@stingerloom/orm";

export const User = defineEntity("users", {
  id:   t.int().primary().generated(),
  name: t.varchar(255),
});

export type User = InferEntity<typeof User>; // { id: number; name: string }
```

The first argument (`"users"`) is the table name. With just this, Stingerloom creates a `users` table with an auto-increment primary key and a `VARCHAR(255)` `name` column. Here is the exact DDL it generates.

**PostgreSQL:**

```sql
CREATE TABLE "users" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL
);
```

**MySQL:**

```sql
CREATE TABLE `users` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255) NOT NULL,
  PRIMARY KEY (`id`)
);
```

PostgreSQL uses double quotes and `SERIAL`; MySQL uses backticks and `AUTO_INCREMENT`. You write the entity once and it works on both — and on SQLite, where the key becomes `INTEGER PRIMARY KEY AUTOINCREMENT`.

Three pieces are doing the work:

- **`defineEntity("users", { … })`** declares the entity and its table name. (Pass a different name through the third options argument with `tableName` if the table should differ from the first argument — see [Advanced options](#advanced-entity-options).)
- **`t.int().primary().generated()`** is the auto-increment primary key. `.primary()` marks it as the PK; `.generated()` makes the database fill in 1, 2, 3… on INSERT. At the SQL level this is `SERIAL PRIMARY KEY` (PostgreSQL) or `INT AUTO_INCREMENT PRIMARY KEY` (MySQL).
- **`t.varchar(255)`** is a regular `VARCHAR(255)` column. The builder fixes the TypeScript type to `string`, so you never annotate it yourself.

```sql
-- You write:
await em.save(User, { name: "Alice" });
-- Generated SQL (the DB fills in id = 1 automatically):
INSERT INTO "users" ("name") VALUES ('Alice');
```

## The `t` builder

Every field is a call on the `t` namespace. Column builders carry their inferred type; chained modifiers refine it (`.nullable()` widens the type to `T | null`).

### Column types

| Builder | TypeScript type | Abstract column type |
| --- | --- | --- |
| `t.int()` / `t.integer()` | `number` | `int` |
| `t.bigint()` | `number` | `bigint` |
| `t.float()` / `t.double()` | `number` | `float` / `double` |
| `t.number()` | `number` | `number` |
| `t.decimal(precision?, scale?)` | `number` | `number` |
| `t.varchar(length?)` | `string` | `varchar` |
| `t.char(length?)` | `string` | `char` |
| `t.text()` / `t.longtext()` | `string` | `text` / `longtext` |
| `t.uuid()` | `string` | `uuid` |
| `t.boolean()` | `boolean` | `boolean` |
| `t.datetime()` / `t.timestamp()` / `t.timestamptz()` / `t.date()` | `Date` | matching temporal type |
| `t.blob()` | `Buffer` | `blob` |
| `t.json<T>()` / `t.jsonb<T>()` | `T` (default `unknown`) | `json` / `jsonb` |
| `t.array<T>()` | `T[]` | `array` |
| `t.enum(["a", "b"])` | `"a" \| "b"` | `enum` |

A realistic mix of types and the type it infers:

```typescript
export const Product = defineEntity("products", {
  id:          t.int().primary().generated(),
  name:        t.varchar(255),       // VARCHAR(255), required
  description: t.text(),             // TEXT (megabytes, not 255 chars)
  price:       t.float(),           // FLOAT / REAL
  isAvailable: t.boolean(),         // TINYINT(1) / BOOLEAN
  releaseDate: t.datetime(),        // DATETIME / TIMESTAMP
  payload:     t.jsonb<{ kind: string; data: unknown }>(),
  tags:        t.array<string>(),
  level:       t.enum(["info", "warn", "error"]).default("info"),
});
// InferEntity<typeof Product> →
//   { id: number; name: string; description: string; price: number;
//     isAvailable: boolean; releaseDate: Date;
//     payload: { kind: string; data: unknown }; tags: string[];
//     level: "info" | "warn" | "error" }
```

`VARCHAR(255)` caps at 255 characters; `TEXT` stores megabytes. Pick the builder that matches the intent — even though both are `string` in TypeScript, they are very different columns. See the [ColumnType reference](#columntype-reference) for the full per-driver mapping.

## Column modifiers

Chain modifiers in any order; each returns a new builder, and modifiers that change nullability also refine the inferred type.

| Modifier | Effect |
| --- | --- |
| `.primary()` | Marks (part of) the primary key. |
| `.generated(strategy?)` | DB-generated key: `"increment"` (default), `"uuid"`, `"uuid-v7"`. Pair with `.primary()`. |
| `.nullable()` | Allows `NULL`; widens the inferred type to `T \| null`. |
| `.unique(name?)` | Single-column unique index. |
| `.index()` | Single-column index. |
| `.default(value)` | Column default. |
| `.name(dbName)` | Overrides the database column name (default: the property key). |
| `.length(n)` / `.precision(n)` / `.scale(n)` | Size / numeric precision. |
| `.transformer({ to, from })` | Bidirectional value transformer. |
| `.createTimestamp()` / `.updateTimestamp()` | Auto-set timestamps. |
| `.deletedAt()` | Soft-delete marker (implies nullable). |
| `.version()` | Optimistic-locking version column. |
| `.validate([...])` | Inline validation constraints. |
| `.enumName(name)` | Names the PostgreSQL `ENUM` type. |
| `.jsonIndex(opts)` | JSON/JSONB expression index. |
| `.tenant()` | Tenant discriminator column. |

### Length

`t.varchar(100)` sets the length inline; `.length(100)` does the same after the fact. Both render `VARCHAR(100)`, and the database rejects an over-length insert.

```typescript
sku: t.varchar(100),           // VARCHAR(100)
sku2: t.varchar().length(100), // identical
```

### Nullable

Every column is `NOT NULL` by default. `.nullable()` drops the constraint **and** widens the inferred type to `T | null`, so the type and the schema stay in lockstep:

```typescript
bio: t.varchar(255).nullable(), // VARCHAR(255), no NOT NULL → bio: string | null
```

### Column name alias

Use `.name()` when the property name and the DB column should differ — the common case is camelCase in TypeScript, snake_case in the database:

```typescript
price: t.float().name("unit_price"),
// entity property: product.price / DB column: unit_price
```

The DDL names the column `unit_price`; on SELECT, Stingerloom maps `unit_price` back to `price`. (Prefer a project-wide convention? Register a [`SnakeNamingStrategy`](./configuration.md) and drop the per-column `.name()` calls.)

### Default value

`.default(value)` sets the column default. Literal strings, numbers, and booleans are used as-is; to emit a raw SQL expression (a function call), wrap it in parentheses.

```typescript
status:     t.varchar(255).default("active"),
retryCount: t.int().default(0),
isVisible:  t.boolean().default(true),
createdAt:  t.datetime().default("(CURRENT_TIMESTAMP)"),
```

**PostgreSQL:**

```sql
"status" VARCHAR(255) NOT NULL DEFAULT 'active',
"retryCount" INTEGER NOT NULL DEFAULT 0,
"isVisible" BOOLEAN NOT NULL DEFAULT TRUE,
"createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
```

Without the parentheses, `"CURRENT_TIMESTAMP"` would be emitted as the literal string `'CURRENT_TIMESTAMP'`, not the SQL function.

### JSON columns

`t.json<T>()` and `t.jsonb<T>()` store structured data in one column, and the type parameter flows straight through to the inferred row type:

```typescript
settings: t.json<{ theme: string }>().nullable(),
// settings: { theme: string } | null
```

In PostgreSQL, `jsonb` is stored in a decomposed binary format — slower to write, far faster to query, and the only form you can index for `WHERE settings->>'theme' = 'dark'`. Prefer `jsonb` whenever you query inside the document.

Stingerloom installs a default round-trip on `json`/`jsonb` columns: on write, a non-string value is `JSON.stringify`d before it reaches the driver; on read, a string returned by the driver is `JSON.parse`d. So you assign plain JS values directly:

```typescript
await em.save(Issue, { customFields: { priority: "high", labels: ["bug"] } });
const issue = await em.findOne(Issue, { where: { id } });
issue!.customFields.priority; // "high" — already an object, dialect-agnostic
```

Supplying an explicit [`.transformer()`](#transformers) overrides the default for that direction.

### PostgreSQL ENUM

`t.enum([...])` both fixes the literal union type **and** carries the allowed values to the database. Name the generated PostgreSQL type with `.enumName()`:

```typescript
status: t.enum(["draft", "published", "archived"]).enumName("post_status"),
// status: "draft" | "published" | "archived"
```

PostgreSQL DDL:

```sql
CREATE TYPE "post_status" AS ENUM ('draft', 'published', 'archived');
-- ...
"status" "post_status" NOT NULL
```

If `.enumName()` is omitted, the name defaults to `{tableName}_{columnName}_enum`. On MySQL the column becomes a native `ENUM(...)`; on SQLite it is stored as `TEXT`.

## Primary keys

### Generated keys

`.primary().generated(strategy)` produces a database-generated key. The strategy controls how:

```typescript
id: t.int().primary().generated(),              // auto-increment (default "increment")
id: t.uuid().primary().generated("uuid"),       // random UUIDv4
id: t.uuid().primary().generated("uuid-v7"),    // time-sortable UUIDv7
```

`"increment"` maps to `SERIAL` (PostgreSQL) / `AUTO_INCREMENT` (MySQL). `"uuid"` and `"uuid-v7"` generate the value in application code before INSERT — `"uuid-v7"` is time-ordered, so it indexes far better than random UUIDs for primary keys.

### Manual primary key

Drop `.generated()` and you have a key you supply yourself — the builder equivalent of `@PrimaryColumn()`. Useful for natural keys like a config table:

```typescript
export const Config = defineEntity("config", {
  key:   t.varchar(64).primary(),
  value: t.text(),
});

await em.save(Config, { key: "site.title", value: "My Blog" });
// INSERT INTO "config" ("key", "value") VALUES ('site.title', 'My Blog')
```

### Composite primary key

Mark more than one column `.primary()` for a composite key:

```typescript
export const Enrollment = defineEntity("enrollments", {
  studentId: t.int().primary().name("student_id"),
  courseId:  t.int().primary().name("course_id"),
  grade:     t.varchar(2).nullable(),
});
```

```sql
CREATE TABLE "enrollments" (
  "student_id" INTEGER NOT NULL,
  "course_id" INTEGER NOT NULL,
  "grade" VARCHAR(2),
  PRIMARY KEY ("student_id", "course_id")
);
```

## Transformers

A transformer translates a value in **both** directions: `to` runs before every INSERT/UPDATE, `from` runs after every SELECT. The classic use is normalizing email to lowercase so `Alice@Example.com` and `alice@example.com` never both exist:

```typescript
export const Account = defineEntity("accounts", {
  id:    t.int().primary().generated(),
  email: t.varchar(255).unique().transformer({
    to:   (value: string) => value.toLowerCase(), // entity → DB (write)
    from: (value: string) => value,               // DB → entity (read)
  }),
});

await em.save(Account, { email: "Alice@Example.COM" });
// INSERT INTO "accounts" ("email") VALUES ('alice@example.com')
```

Encryption is the same shape — encrypt in `to`, decrypt in `from` — so the database only ever stores ciphertext while your code works with plaintext:

```typescript
ssn: t.text().transformer({
  to:   (value: string) => encrypt(value),
  from: (value: string) => decrypt(value),
}),
```

## Indexes

### Single-column index

`.index()` adds a non-unique index, and `.unique()` a unique one. Both turn a full table scan into an O(log n) B-tree lookup for `WHERE`/`JOIN`/`ORDER BY` on that column:

```typescript
export const User = defineEntity("users", {
  id:    t.int().primary().generated(),
  email: t.varchar(255).index(),   // CREATE INDEX ... ON "users" ("email")
  slug:  t.varchar(255).unique(),  // single-column UNIQUE index
});
```

```sql
CREATE INDEX "INDEX_users_email" ON "users" ("email");
```

A `.unique()` constraint is lifted into the entity's unique-index list, so it composes with any composite unique indexes you declare in the options object.

### Composite and unique indexes

Multi-column indexes live in the third options argument. `indexes` are non-unique, `uniqueIndexes` enforce uniqueness across the combination:

```typescript
export const Order = defineEntity(
  "orders",
  {
    id:       t.int().primary().generated(),
    tenantId: t.int().name("tenant_id"),
    status:   t.varchar(50),
    slug:     t.varchar(120),
  },
  {
    indexes:       [{ columns: ["tenant_id", "status"] }],
    uniqueIndexes: [{ columns: ["tenant_id", "slug"], name: "uq_order_slug" }],
  },
);
```

```sql
CREATE INDEX "idx_orders_tenant_id_status" ON "orders" ("tenant_id", "status");
CREATE UNIQUE INDEX "uq_order_slug" ON "orders" ("tenant_id", "slug");
```

A composite index works left-to-right, like a phone book sorted by last name then first name: it serves `WHERE tenant_id = 5` and `WHERE tenant_id = 5 AND status = 'pending'`, but not `WHERE status = 'pending'` alone.

### Advanced index options

Each `indexes` entry takes an `options` object carrying the same `AdvancedIndexOptions` the decorator's `@Index([cols], options)` accepts — partial, expression, `USING`, and covering (`INCLUDE`) indexes:

```typescript
export const User = defineEntity(
  "users",
  {
    id:        t.int().primary().generated(),
    email:     t.varchar(255),
    name:      t.varchar(255),
    metadata:  t.jsonb(),
    deletedAt: t.datetime().deletedAt(),
  },
  {
    indexes: [
      // Partial covering index (PostgreSQL / SQLite for WHERE; PG for INCLUDE)
      {
        columns: ["email"],
        options: {
          name: "idx_active_user_email",
          where: "deleted_at IS NULL", // partial — skips soft-deleted rows
          include: ["name"],           // covering — index-only scans
        },
      },
      // Expression index — column list empty, expression replaces it
      { columns: [], options: { name: "idx_lower_email", expression: "LOWER(email)" } },
      // GIN index for JSONB containment queries
      { columns: ["metadata"], options: { using: "gin" } },
    ],
  },
);
```

```sql
CREATE INDEX "idx_active_user_email" ON "users" ("email") INCLUDE ("name") WHERE deleted_at IS NULL;
CREATE INDEX "idx_lower_email" ON "users" ((LOWER(email)));
CREATE INDEX "idx_users_metadata" ON "users" USING gin ("metadata");
```

| `using` value | Best for | PostgreSQL | MySQL |
| --- | --- | --- | --- |
| `btree` | Equality, range, sorting (default) | Yes | Yes |
| `hash` | Equality only | Yes | Yes |
| `gin` | JSONB, arrays, full-text | Yes | No |
| `gist` | Geometric, range types | Yes | No |
| `brin` | Large time-series tables | Yes | No |

Partial (`where`), covering (`include`), and non-btree `using` are PostgreSQL features (partial indexes also work on SQLite); MySQL ignores or rejects them. See the decorator guide's [Advanced Index Options](./entities.md#advanced-index-options) for the full conceptual treatment — the option object is identical.

### Full-text indexes

Full-text indexes go in `fullTextIndexes`:

```typescript
export const Post = defineEntity(
  "posts",
  {
    id:      t.int().primary().generated(),
    title:   t.varchar(200),
    content: t.text(),
  },
  {
    fullTextIndexes: [
      { columns: ["title", "content"], name: "ft_post", language: "english" },
    ],
  },
);
```

PostgreSQL emits a GIN `to_tsvector` index, MySQL a `FULLTEXT` index; SQLite is a no-op.

### JSON path indexes

`.jsonIndex()` declares an expression index over a path inside a `jsonb` column — the builder form of `@JsonIndex`:

```typescript
profile: t.jsonb<{ tags: string[] }>().jsonIndex({
  path: "tags",
  using: "gin",
  opclass: "jsonb_path_ops",
}),
```

PostgreSQL DDL:

```sql
CREATE INDEX "idx_users_profile_tags_gin"
  ON "users" USING gin ((profile -> 'tags') jsonb_path_ops);
```

`path` is dot-bracket (`"contact.email"`, `"tags[0]"`); omit it to index the whole column. `using: "btree"` suits a single scalar leaf for equality/range. MySQL and SQLite emit no DDL (a warning is logged). See [JSON Path Indexes](./entities.md#json-path-indexes-jsonindex) for the full option reference, and [Query Builder — JSON](./query-builder-json.md) for operators that line up with these indexes.

## Optimistic locking

`.version()` adds a version counter that detects the *lost update* problem — two writers reading the same row and clobbering each other. On INSERT the version is set to 1; on UPDATE, Stingerloom adds `WHERE version = N` and increments it. If the row was changed in between, the UPDATE matches 0 rows and an `OptimisticLockError` is thrown instead of silently losing data.

```typescript
export const Order = defineEntity("orders", {
  id:      t.int().primary().generated(),
  status:  t.varchar(255),
  version: t.int().version(),
});
```

```sql
-- Writer A (read version 1) succeeds, version becomes 2:
UPDATE "orders" SET "status" = 'shipped', "version" = "version" + 1
WHERE "id" = 1 AND "version" = 1;          -- 1 row affected

-- Writer B (also read version 1) now fails:
UPDATE "orders" SET "status" = 'refunded', "version" = "version" + 1
WHERE "id" = 1 AND "version" = 1;          -- 0 rows → OptimisticLockError
```

Use it where conflicts are rare but correctness matters (order status, inventory). For high-contention rows, prefer pessimistic locking (`SELECT … FOR UPDATE`).

## Soft delete

`.deletedAt()` turns deletes into a timestamp stamp rather than a row removal. It implies `.nullable()` (a `NULL` marker means "not deleted"), so the inferred type is `Date | null`:

```typescript
export const Post = defineEntity("posts", {
  id:        t.int().primary().generated(),
  title:     t.varchar(255),
  deletedAt: t.datetime().deletedAt(), // deletedAt: Date | null
});
```

The marker changes three behaviors:

```typescript
await em.softDelete(Post, { id: 1 });
// UPDATE "posts" SET "deletedAt" = NOW() WHERE "id" = 1;   (not DELETE)

await em.find(Post);
// SELECT * FROM "posts" WHERE "deletedAt" IS NULL;          (auto-excludes)

await em.find(Post, { withDeleted: true });
// SELECT * FROM "posts";                                    (includes deleted)

await em.restore(Post, { id: 1 });
// UPDATE "posts" SET "deletedAt" = NULL WHERE "id" = 1;     (un-delete)
```

## Automatic timestamps

`.createTimestamp()` and `.updateTimestamp()` fill in audit timestamps for you. On INSERT both are set; on UPDATE only the update timestamp is refreshed:

```typescript
export const Article = defineEntity("articles", {
  id:        t.int().primary().generated(),
  title:     t.varchar(255),
  createdAt: t.datetime().createTimestamp(),
  updatedAt: t.datetime().updateTimestamp(),
});
```

```sql
-- INSERT — both set to the same instant (generated as new Date() in app code):
INSERT INTO "articles" ("title", "createdAt", "updatedAt")
VALUES ('Hello', '2026-06-30 10:30:00', '2026-06-30 10:30:00');

-- UPDATE — only updatedAt is in the SET clause:
UPDATE "articles" SET "title" = 'Hello v2', "updatedAt" = '2026-06-30 11:45:00'
WHERE "id" = 1;
```

If you pass an explicit value for a timestamp column in `save()`, that value is used instead of the auto-generated one — handy for data migration. For timezone-aware columns in PostgreSQL, use `t.timestamptz()`.

## Computed columns

`t.computed()` declares a database-level generated column — the builder form of `@ComputedColumn`. The value is computed by the database from other columns and is **excluded from every INSERT and UPDATE** (writing to it would error). It renders as `GENERATED ALWAYS AS (expression)`:

```typescript
export const OrderLine = defineEntity("order_lines", {
  id:       t.int().primary().generated(),
  price:    t.float(),
  quantity: t.int(),
  total:    t.computed<number>("price * quantity", { stored: true, type: "float" }),
});
```

PostgreSQL DDL:

```sql
CREATE TABLE "order_lines" (
  "id" SERIAL PRIMARY KEY,
  "price" REAL NOT NULL,
  "quantity" INTEGER NOT NULL,
  "total" REAL GENERATED ALWAYS AS (price * quantity) STORED
);
```

```typescript
await em.save(OrderLine, { price: 29.99, quantity: 3 });
// INSERT INTO "order_lines" ("price", "quantity") VALUES (29.99, 3)
// "total" is omitted — the DB computes it as 89.97
```

The options mirror `@ComputedColumn`: `stored`, `type`, `length`, and `nullable`.

| `stored` | Mode | Behavior | Disk | Indexable |
| --- | --- | --- | --- | --- |
| `true` | STORED | Computed on write, persisted | Uses space | Yes |
| `false` (default) | VIRTUAL | Computed on every read | None | Limited |

### Dialect-portable expressions

A literal string expression is embedded into the DDL verbatim, so it must already be valid for the target database. That is fine for portable arithmetic like `price * quantity`, but date math diverges sharply between engines. Pass a **builder function** instead and Stingerloom compiles it to dialect-correct SQL once per connection:

```typescript
export const Issue = defineEntity("issues", {
  id:          t.int().primary().generated(),
  createdAt:   t.datetime().nullable().name("created_at"),
  completedAt: t.datetime().nullable().name("completed_at"),
  cycleTimeHours: t.computed<number>(
    (e) => e.dateDiff(e.col("completed_at"), e.col("created_at"), "hour"),
    { type: "int", nullable: true },
  ),
});
```

```sql
-- MySQL
`cycleTimeHours` INT GENERATED ALWAYS AS (TIMESTAMPDIFF(HOUR, `created_at`, `completed_at`)) VIRTUAL
-- PostgreSQL
"cycleTimeHours" INTEGER GENERATED ALWAYS AS (EXTRACT(EPOCH FROM ("completed_at" - "created_at")) / 3600) VIRTUAL
```

The context `e` exposes the full Expressions DSL (`e.iff`, `e.caseBuilder`, `e.coalesce`, `e.dateDiff`, `e.col(name)`). See the decorator guide's [dialect-portable expressions](./entities.md#dialect-portable-expressions-builder-form) for the full DSL.

::: tip How computed columns reach the database
`GENERATED ALWAYS AS` DDL is emitted by the schema **generator** — the same path the migration CLI uses (`stingerloom migrate:generate`). The runtime `synchronize` create-table path renders stored columns only. This matches the decorator `@ComputedColumn` exactly: generate a migration to add (or change) a computed column. Stingerloom always excludes the column from writes regardless of how the table was created.
:::

## Validation

`.validate([...])` attaches application-level constraints checked **before** the SQL is built — the builder form of `@NotNull`, `@MinLength`, `@Min`, and friends. A failure throws `ValidationError` and no query is sent:

```typescript
export const Member = defineEntity("members", {
  id:   t.int().primary().generated(),
  name: t.varchar(50).validate([
    { constraint: "notNull" },
    { constraint: "minLength", value: 2 },
    { constraint: "maxLength", value: 50 },
  ]),
  age:  t.int().validate([
    { constraint: "min", value: 0 },
    { constraint: "max", value: 150 },
  ]),
});

await em.save(Member, { name: "A", age: -1 });
// ValidationError: name must be at least 2 characters long  (no INSERT attempted)
```

Each entry is `{ constraint, value?, message? }`. Available constraints are `notNull`, `minLength`, `maxLength`, `min`, and `max` (pass a custom `message` to override the default). Unlike a database `NOT NULL` violation (which surfaces after a round trip with a cryptic message), validation is caught in your process with a clear message.

## Lifecycle hooks

Hooks run custom logic at a moment in an entity's lifecycle — generate a slug before insert, send a notification after, clean up before delete. Declare them in the third options argument; each event maps to a function (or the name of a method already on the class):

```typescript
export const Article = defineEntity(
  "articles",
  {
    id:    t.int().primary().generated(),
    title: t.varchar(200),
    slug:  t.varchar(200).nullable(),
  },
  {
    hooks: {
      beforeInsert(article) {
        article.slug ??= article.title.toLowerCase().replace(/\s+/g, "-");
      },
      afterInsert(article) {
        console.log(`Article #${article.id} created`);
      },
    },
  },
);
```

The hook receives the entity both as `this` and as its first argument, so `beforeInsert(a) { a.slug = … }` and `beforeInsert() { this.slug = … }` are equivalent.

::: warning Hooks fire on instances — use `new Entity(...)`
A hook is a method on the entity prototype, so it only runs when the object you save **carries that prototype**. The minted class constructor accepts a partial initializer for exactly this reason: `new Article({ … })` gives you a typed, hook-capable instance.

```typescript
// ✓ Hook runs — the saved object is an Article instance.
const saved = await em.save(Article, new Article({ title: "Hello World" }));
saved.slug; // "hello-world"

// ✗ Hook does NOT run — a plain object literal has no prototype method.
await em.save(Article, { title: "Hello World" });
```

This is the same requirement decorator entities have (`@BeforeInsert` also needs an instance); `new Article({...})` is the decorator-free, type-checked equivalent of `Object.assign(new Article(), {...})`.
:::

There are six events, and they fire around the corresponding SQL:

| Event | Timing | Typical use |
| --- | --- | --- |
| `beforeInsert` | Just before INSERT | Defaults, slug generation, normalization |
| `afterInsert` | After INSERT (entity now has its ID) | Logging, notifications, cache invalidation |
| `beforeUpdate` | Just before UPDATE | Recomputing fields, validation |
| `afterUpdate` | After UPDATE | Change history, webhooks |
| `beforeDelete` | Just before DELETE | Cleanup, permission checks |
| `afterDelete` | After DELETE | Releasing related resources, logging |

For a new entity, the order is: `beforeInsert` hooks → `INSERT` → `afterInsert` hooks. Mutations in `before*` hooks are reflected in the SQL; `after*` hooks run once the row is written, so use them for side effects.

## Relations

Relation builders take a lazy `() => TargetEntity` (lazy so two entities can reference each other at runtime). `manyToOne` / `oneToOne` infer the related row type; `oneToMany` / `manyToMany` infer an array. Relation fields are **optional** in the inferred type — they are populated only when you request them with `relations: [...]`.

When two entities reference **each other**, the type side needs a small extra step — see [Mutual references](#mutual-references) below.

| Builder | Signature | Inferred field |
| --- | --- | --- |
| `t.manyToOne` | `(() => Target, options?)` | `Target?` |
| `t.oneToMany` | `(() => Target, mappedBy, options?)` | `Target[]?` |
| `t.oneToOne` | `(() => Target, options?)` | `Target?` |
| `t.manyToMany` | `(() => Target, options?)` | `Target[]?` |

```typescript
import { defineEntity, t, InferEntity, AnyEntityClass } from "@stingerloom/orm";

export const Author = defineEntity("authors", {
  id:    t.int().primary().generated(),
  name:  t.varchar(120),
  // Author ↔ Post is a cycle: explicit row type + annotated thunk on this side.
  posts: t.oneToMany<Post>((): AnyEntityClass => Post, "author"),
});

export const Post = defineEntity("posts", {
  id:       t.int().primary().generated(),
  title:    t.varchar(200),
  authorId: t.int().nullable().name("author_id"), // the physical FK column
  author:   t.manyToOne(() => Author, { joinColumn: "author_id" }),
  tags:     t.manyToMany(() => Tag, {
    joinTable: { name: "post_tags", joinColumn: "post_id", inverseJoinColumn: "tag_id" },
  }),
});

export const Tag = defineEntity("tags", {
  id:   t.int().primary().generated(),
  name: t.varchar(60).unique(),
});

// The mutually referencing pair uses interface merging (resolved lazily):
export interface Author extends InferEntity<typeof Author> {} // posts?: Post[]
export interface Post extends InferEntity<typeof Post> {}     // author?: Author; tags?: Tag[]
// Tag is only referenced one way, so a plain type alias works:
export type Tag = InferEntity<typeof Tag>;
```

::: warning Declare the foreign-key column
A `manyToOne` / owning `oneToOne` needs its foreign-key column declared as a real column (`authorId: t.int().name("author_id")`) so it is created during schema sync — exactly as the decorator API pairs `@ManyToOne` with a `@Column`/`@RelationColumn` for the FK. The relation's `joinColumn` then points at that column. Alternatively, pass `relationColumn: { … }` in the relation options to declare the FK metadata inline.
:::

### Mutual references

Two `defineEntity` consts whose types are inferred from each other cannot both be inferred — TypeScript reports:

```
error TS7022: 'Author' implicitly has type 'any' because it does not have a
type annotation and is referenced directly or indirectly in its own initializer.
```

This is an inherent limitation of `const` type inference (class declarations don't hit it because class member types resolve lazily). The supported pattern breaks the cycle with three pieces, applied to **one side** of the cycle:

```typescript
export const Author = defineEntity("authors", {
  id:    t.int().primary().generated(),
  //               ① explicit row type   ② annotated thunk
  posts: t.oneToMany<Post>((): AnyEntityClass => Post, "author"),
});
export const Post = defineEntity("posts", {
  id:     t.int().primary().generated(),
  author: t.manyToOne(() => Author, { joinColumn: "author_id" }), // unchanged
});
// ③ interface merging instead of `type X = InferEntity<typeof X>`
export interface Author extends InferEntity<typeof Author> {}
export interface Post extends InferEntity<typeof Post> {}
```

Each piece is load-bearing:

1. **`t.oneToMany<Post>(…)`** supplies the related row type explicitly, so `Author`'s type no longer needs to infer it from `Post`'s initializer. Every relation builder accepts this leading type argument (`t.manyToOne<Author>(…)`, `t.manyToMany<Course>(…)`, `t.oneToOne<Profile>(…)`).
2. **`(): AnyEntityClass => Post`** annotates the thunk's return type. Without it, the compiler must infer the thunk's return type from its body — which walks right back into the cycle, no matter what the builder's signature says. `AnyEntityClass` is exported from `@stingerloom/orm`.
3. **`interface Author extends InferEntity<typeof Author> {}`** declares the row type by interface merging. Interfaces resolve their members lazily; a `type` alias is resolved eagerly at its use site and re-enters the cycle.

Notes:

- One treated edge per cycle is enough — in an `A → B → C → A` triangle, applying the pattern to a single relation fixes all three entities.
- In the explicit-shape form, `mappedBy` is checked as a plain `string` (probing the target's keys would re-enter the cycle), so you lose autocomplete on that one argument.
- Both pieces ① and ② must appear together: the annotation alone leaves the field typed `any[]`, and the type argument alone still fails with TS7022.
- Runtime behavior is identical in every form — the thunk is only called after all entities exist, so this is purely a type-level concern.

### Relation options

`manyToOne` and `oneToOne` accept the loading and referential-action options the decorators do:

```typescript
author: t.manyToOne(() => Author, {
  joinColumn: "author_id",
  references: "id",            // target column the FK points at (default: the target's PK)
  eager: true,                 // always LEFT JOIN and hydrate
  lazy: false,                 // true = Proxy-based loading on first property access
  cascade: ["insert", "update"],
  onDelete: "CASCADE",         // FK ON DELETE action
  onUpdate: "RESTRICT",
  createForeignKeyConstraints: true, // false = keep the relation, skip the FK DDL
  relationColumn: {            // explicit FK column metadata (a la @RelationColumn)
    name: "author_id",
    type: "bigint",
    nullable: false,
    referencedColumn: "id",
  },
}),
```

A few of these deserve a note:

- `references` points the FK at a column other than the target's primary key (e.g. a `uuid` column) — same as the decorator option of the same name.
- `lazy: true` replaces the eager JOIN with Proxy-based deferred loading: the query runs the moment the property is first accessed. `eager` and `lazy` are mutually exclusive; if both are set, `eager` wins.
- `createForeignKeyConstraints: false` keeps the logical relation (loading, cascades) but omits the FK constraint from generated DDL — useful for cross-database references or write-heavy tables where constraint checks are too expensive.
- `oneToOne` additionally accepts `inverseSide` — the property name on the target entity that points back — to make the relation navigable from both sides, mirroring `@OneToOne`'s `inverseSide`.

`oneToMany` takes the inverse-side property name as its required second argument (`"author"` above — the `manyToOne` field on `Post`) plus an optional `{ cascade }`. `manyToMany` takes `{ joinTable, mappedBy, cascade }`; declare the join table on the owning side, and the join-table DDL is generated for you. See [Relations](./relations.md) for the conceptual guide to loading strategies and cascades.

## Inheritance

Inheritance models an *is-a* relationship (a `CreditCardPayment` **is a** `Payment`), so it needs a real TypeScript class hierarchy — `class Child extends Parent`. Because `defineEntity` mints one standalone class per call, hierarchies are the one place to reach for the lower-level [`EntitySchema`](./decorator-free.md#entityschema-entity-definition) form, which attaches schema to classes you write with `extends`:

```typescript
import { EntitySchema } from "@stingerloom/orm";

class Payment {
  id!: number;
  amount!: number;
}
class CreditCardPayment extends Payment {
  cardNumber!: string;
}

new EntitySchema<Payment>({
  target: Payment,
  inheritance: { strategy: "SINGLE_TABLE" },
  discriminatorColumn: { name: "payment_type" },
  columns: {
    id:     { type: "int", primary: true, autoIncrement: true },
    amount: { type: "int" },
  },
});

new EntitySchema<CreditCardPayment>({
  target: CreditCardPayment,
  discriminatorValue: "credit_card",
  columns: { cardNumber: { type: "varchar", nullable: true } },
});
```

All three strategies (single-table, table-per-type, table-per-concrete-class) are supported decorator-free this way. See [Inheritance Mapping](./inheritance-mapping.md) for the full strategy reference. Builder entities and these `EntitySchema` hierarchies coexist and can relate to one another.

## Registering and using the entity

Pass the builder entity to your `EntityManager` exactly like a decorated class:

```typescript
import "reflect-metadata";
import { EntityManager } from "@stingerloom/orm";
import { Author, Post } from "./entities";

const em = new EntityManager();
await em.register({
  type: "postgres",
  host: "localhost",
  entities: [Author, Post],
  synchronize: true,
});

const author = await em.save(Author, { name: "Ada" });
const post = await em.save(Post, { title: "Hello", authorId: author.id });

const withAuthor = await em.findOne(Post, {
  where: { id: post.id },
  relations: ["author"],
});
withAuthor!.author?.name; // "Ada" — fully typed
```

::: tip `reflect-metadata`
The ORM core uses `reflect-metadata` at runtime, so keep `import "reflect-metadata"` at your entry point. What you *don't* need for code-first entities are the `experimentalDecorators` and `emitDecoratorMetadata` compiler options.
:::

## Advanced entity options

The optional third argument carries the less-common, entity-level settings. Everything in it is also reachable individually, but grouping rarely-used options keeps the column map clean:

```typescript
export const Member = defineEntity(
  "members",
  {
    id:    t.int().primary().generated(),
    orgId: t.int().name("org_id"),
    email: t.varchar(255),
  },
  {
    tableName: "org_members",          // override the table name
    indexes: [{ columns: ["org_id"] }],
    uniqueIndexes: [{ columns: ["org_id", "email"], name: "uq_member_email" }],
    fullTextIndexes: [{ columns: ["email"] }],
    hooks: { beforeInsert(m) { m.email = m.email.toLowerCase(); } },
    nonTenant: true,                   // opt out of the tenant_column strategy
  },
);
```

| Option | Purpose | Decorator equivalent |
| --- | --- | --- |
| `tableName` | Table name (overrides the first argument) | `@Entity({ name })` |
| `indexes` | Composite / advanced indexes | `@Index([cols], options)` |
| `uniqueIndexes` | Composite unique indexes | `@UniqueIndex([cols])` |
| `fullTextIndexes` | Full-text indexes | `@FullTextIndex([cols])` |
| `hooks` | Lifecycle hooks | `@BeforeInsert` … `@AfterDelete` |
| `nonTenant` | Exclude from the tenant_column strategy | `@NonTenantEntity()` |

### Tenant column

When the global `tenantStrategy` is `"tenant_column"`, mark the discriminator column with `.tenant()` so it is readable on instances and used to scope queries, and opt inherently global tables out with `nonTenant: true`:

```typescript
// Per-tenant entity — tenant column readable as log.tenantId
export const AuditLog = defineEntity("audit_logs", {
  id:       t.int().primary().generated(),
  action:   t.varchar(255),
  tenantId: t.varchar(64).name("tenant_id").tenant(),
});

// Inherently global entity — no tenant scoping
export const Tenant = defineEntity(
  "tenants",
  { id: t.varchar(64).primary(), name: t.varchar(255) },
  { nonTenant: true },
);
```

See [Multi-Tenancy](./multi-tenancy.md) for the full strategy reference.

## Complete real-world example

A blog user entity combining most of the features above:

```typescript
import { defineEntity, t, InferEntity } from "@stingerloom/orm";

export const User = defineEntity(
  "users",
  {
    id:        t.int().primary().generated(),
    name:      t.varchar(50).validate([
      { constraint: "notNull" },
      { constraint: "minLength", value: 2 },
      { constraint: "maxLength", value: 50 },
    ]),
    email:     t.varchar(255).index(),
    phone:     t.varchar(20).nullable(),
    isActive:  t.boolean().default(true),
    profile:   t.json<{ bio?: string }>().nullable(),
    version:   t.int().version(),
    deletedAt: t.datetime().deletedAt(),
    createdAt: t.datetime().createTimestamp(),
    updatedAt: t.datetime().updateTimestamp(),
  },
  {
    hooks: {
      afterInsert(user) {
        console.log(`User #${user.id} created`);
      },
    },
  },
);

export type User = InferEntity<typeof User>;
```

**PostgreSQL DDL:**

```sql
CREATE TABLE "users" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(50) NOT NULL,
  "email" VARCHAR(255) NOT NULL,
  "phone" VARCHAR(20),
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "profile" JSON,
  "version" INTEGER NOT NULL,
  "deletedAt" TIMESTAMP,
  "createdAt" TIMESTAMP NOT NULL,
  "updatedAt" TIMESTAMP NOT NULL
);
CREATE INDEX "INDEX_users_email" ON "users" ("email");
```

```typescript
// INSERT — version auto-set to 1, timestamps auto-set, afterInsert logs:
const u = await em.save(User, new User({ name: "Alice", email: "alice@example.com" }));

// UPDATE — version increments, only updatedAt refreshes:
await em.save(User, { id: u.id, name: "Alice Smith", version: u.version });

// Soft delete + queries that auto-exclude deleted rows:
await em.softDelete(User, { id: u.id });
await em.find(User);                       // WHERE "deletedAt" IS NULL
await em.find(User, { withDeleted: true }); // no filter
```

## Mixing with decorators

Code-first and decorator entities share the same metadata pipeline, so they coexist and can relate to each other:

```typescript
@Entity()
class LegacyUser {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
}

export const Comment = defineEntity("comments", {
  id:     t.int().primary().generated(),
  body:   t.text(),
  userId: t.int().name("user_id"),
  user:   t.manyToOne(() => LegacyUser, { joinColumn: "user_id" }),
});
```

Adopt the builder API incrementally — new entities code-first, existing decorated entities untouched.

## ColumnType reference

### Builder → TypeScript type

| Builder | Inferred TS type |
| --- | --- |
| `t.int()`, `t.integer()`, `t.bigint()`, `t.float()`, `t.double()`, `t.number()`, `t.decimal()` | `number` |
| `t.varchar()`, `t.char()`, `t.text()`, `t.longtext()`, `t.uuid()` | `string` |
| `t.boolean()` | `boolean` |
| `t.datetime()`, `t.timestamp()`, `t.timestamptz()`, `t.date()` | `Date` |
| `t.blob()` | `Buffer` |
| `t.json<T>()`, `t.jsonb<T>()` | `T` (default `unknown`) |
| `t.array<T>()` | `T[]` |
| `t.enum([...])` | the literal union |
| `.nullable()` on any column | widens to `T \| null` |

### Abstract type → database type

Each abstract `ColumnType` is translated to a concrete database type by the driver:

| ColumnType | MySQL/MariaDB | PostgreSQL | SQLite |
| --- | --- | --- | --- |
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
| `uuid` | CHAR(36) *(UUID on MariaDB 10.7+)* | UUID | VARCHAR(36) |
| `enum` | ENUM | (custom ENUM) | TEXT |

## Troubleshooting

**My relation field is always `undefined`.** Relations are optional and lazy — request them with `relations: ["author"]` on the query. Without it, the field is not loaded.

**The FK column is missing from the table.** A `manyToOne`/owning `oneToOne` does not create its own FK column; declare it as a real column (`authorId: t.int().name("author_id")`) and point `joinColumn` at it, or pass `relationColumn` in the relation options.

**My lifecycle hook never runs.** Hooks fire on instances. Save `new MyEntity({ … })`, not a plain object literal — see [Lifecycle hooks](#lifecycle-hooks).

**A computed column isn't in the created table.** `GENERATED ALWAYS AS` DDL comes from the schema generator (the migration CLI), not the runtime `synchronize` path — generate a migration. This matches the decorator `@ComputedColumn`.

**Am I really decorator-free?** Define every entity with `defineEntity` (or `EntitySchema`) and run a dry sync — it logs the DDL it *would* run without touching the database, confirming every column, index, and relation resolved without any compiler-emitted metadata:

```typescript
await em.register({ entities: [User, Post, /* … */], synchronize: "dry-run" });
```

For the complete decorator → builder/`EntitySchema` mapping — including transactions and NestJS injection without decorators — see the [Decorator-Free Reference](./decorator-free.md).
