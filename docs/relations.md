# Relations

A **Relation** is a connection between two entities. It reflects real-world relationships in the database, such as "a blog post has an author" or "an owner has multiple cats."

But before diving into decorators, let's understand the problem relations solve.

Without relations, you would store an owner's ID as a plain integer in the cat table, then manually write JOIN queries to fetch the owner's data when loading a cat. You would also need to handle foreign key constraints, null checks, and data integrity yourself. Relations automate all of this: you declare the connection once, and the ORM generates the correct JOINs, FK constraints, and DDL for you.

Stingerloom ORM supports four types of relations.

| Relation | Example | Decorator |
|----------|---------|-----------|
| Many-to-One (N:1) | Cat -> Owner | `@ManyToOne` |
| One-to-Many (1:N) | Owner -> Cats | `@OneToMany` |
| One-to-One (1:1) | User -> Profile | `@OneToOne` |
| Many-to-Many (N:M) | Post <-> Tag | `@ManyToMany` |

Let's start with the most common Many-to-One relation and work through each one.

## @ManyToOne -- "Who is this cat's owner?"

### Why This Relation Exists

Think about the relationship between cats and owners. One owner can have multiple cats, but each cat has only one owner. If you store all data in a single table, you would duplicate the owner's information for every cat:

| cat_name | owner_name | owner_email |
|----------|-----------|-------------|
| Whiskers | John | john@mail.com |
| Cheddar | John | john@mail.com |
| Luna | Jane | jane@mail.com |

This is wasteful and dangerous -- if John changes his email, you need to update multiple rows, and if you miss one, your data is inconsistent. The solution is **normalization**: store owners in one table and cats in another, then link them with a **foreign key** (FK).

A foreign key is a column in one table that references the primary key of another table. It is a promise: "this value always points to a valid row in the other table."

### How It Works

First, create the two entities.

```typescript
// owner.entity.ts
import { Entity, PrimaryGeneratedColumn, Column } from "@stingerloom/orm";

@Entity()
export class Owner {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;
}
```

```typescript
// cat.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, ManyToOne } from "@stingerloom/orm";
import { Owner } from "./owner.entity";

@Entity()
export class Cat {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @ManyToOne(() => Owner, (owner) => owner.cats, {
    joinColumn: "owner_id",
  })
  owner!: Owner;
}
```

### The Generated DDL

Here is the exact SQL that Stingerloom generates for these two entities.

**PostgreSQL:**

```sql
CREATE TABLE "owner" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL
);

CREATE TABLE "cat" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL,
  "owner_id" INTEGER
);

ALTER TABLE "cat"
  ADD CONSTRAINT "fk_cat_owner_id_a1b2c3d4"
  FOREIGN KEY ("owner_id") REFERENCES "owner" ("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
```

**MySQL:**

```sql
CREATE TABLE `owner` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255) NOT NULL,
  PRIMARY KEY (`id`)
);

CREATE TABLE `cat` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255) NOT NULL,
  `owner_id` INT,
  PRIMARY KEY (`id`)
);

ALTER TABLE `cat`
  ADD CONSTRAINT `fk_cat_owner_id_a1b2c3d4`
  FOREIGN KEY (`owner_id`) REFERENCES `owner` (`id`)
  ON DELETE NO ACTION ON UPDATE NO ACTION;
```

Notice three things:

1. The `owner_id` column is created on the `cat` table (the "many" side always holds the FK)
2. The `ALTER TABLE ... ADD CONSTRAINT FOREIGN KEY` ensures every `owner_id` value corresponds to an existing `owner.id`
3. The FK constraint name includes a hash suffix (like `a1b2c3d4`) for uniqueness

### The Generated SELECT with JOIN

When you load a cat with its owner, Stingerloom generates a LEFT JOIN query:

```typescript
const cat = await em.findOne(Cat, {
  where: { id: 1 },
  relations: ["owner"],
});
```

**Generated SQL (PostgreSQL):**

```sql
SELECT
  "cat"."id"       AS "cat_id",
  "cat"."name"     AS "cat_name",
  "cat"."owner_id" AS "cat_owner_id",
  "owner"."id"     AS "owner_id",
  "owner"."name"   AS "owner_name"
FROM "cat"
LEFT JOIN "owner" ON "cat"."owner_id" = "owner"."id"
WHERE "cat"."id" = 1;
```

A `LEFT JOIN` means "return the cat even if it has no owner (owner_id is NULL)." If you used an `INNER JOIN` instead, cats without owners would be excluded from results.

### Understanding the Decorator Arguments

Looking at the three arguments of `@ManyToOne`:

- `() => Owner` -- The target entity (wrapped in a function to prevent circular references at import time)
- `(owner) => owner.cats` -- The inverse property (used for bidirectional relations; can be omitted for unidirectional)
- `{ joinColumn: "owner_id" }` -- The foreign key column name

> **Hint** You can omit `joinColumn`. See **@Column-based FK Auto-Detection** below.

### @Column-based FK Auto-Detection

Specifying `joinColumn` every time is tedious and risks mismatch with `@Column`'s DB column name. Stingerloom automatically uses the **actual DB name** of the `@Column` as the FK column when a `@Column` with the `{propertyName}Id` pattern is declared on the same entity.

```typescript
@Entity()
export class Cat {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  // FK column with DB column name "owner_fk"
  @Column({ name: "owner_fk", type: "int" })
  ownerId!: number;

  // "owner_fk" from ownerId's DB name is auto-applied without joinColumn
  @ManyToOne(() => Owner, (owner) => owner.cats)
  owner!: Owner;
}
```

The resolution priority is as follows.

1. If `@RelationColumn` is attached to the property -> use its `name` (or infer `{propertyName}Id` if omitted)
2. If `@ManyToOne`'s `joinColumn` option is specified -> use as-is
3. If a `@Column` with `{propertyName}Id` is declared on the same entity -> use that `@Column`'s DB column name
4. If none of the above -> fallback to `{propertyName}Id` convention

Declaring a `@Column` also has the advantage of being able to directly read and write FK values on the entity.

```typescript
const cat = new Cat();
cat.ownerId = 3;          // Set FK value directly (no need to load the Owner)
await em.save(Cat, cat);

console.log(cat.ownerId); // Read FK value directly
```

This generates:

```sql
INSERT INTO "cat" ("name", "owner_fk") VALUES ('Whiskers', 3);
```

### @RelationColumn Decorator

`@RelationColumn` provides a declarative way to define FK columns on `@ManyToOne` and `@OneToOne` properties. It generates the FK column in DDL automatically, without requiring a separate `@Column` declaration.

```typescript
import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, RelationColumn } from "@stingerloom/orm";

@Entity()
export class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @ManyToOne(() => User, (user) => user.posts)
  @RelationColumn({ name: "author_id" })
  author!: User;
}
```

This is equivalent to manually declaring `@Column({ type: "int", name: "author_id", nullable: true }) authorId!: number` plus setting `joinColumn: "author_id"` on `@ManyToOne`.

**Auto-inference:** If you omit `name`, it defaults to `{propertyName}Id` and logs a warning.

```typescript
@ManyToOne(() => User, (user) => user.posts)
@RelationColumn()        // inferred as "authorId", warn logged
author!: User;
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | `{propertyName}Id` | FK column name in the database |
| `type` | `ColumnType` | target PK type | FK column type (e.g., `"int"`, `"bigint"`, `"uuid"`) |
| `nullable` | `boolean` | `true` | Whether the FK column allows NULL |
| `referencedColumn` | `string` | target PK | The column to reference in the target entity |

**Coexisting with @Column:** If you also need direct FK access (e.g., `post.authorId = 5`), declare both `@Column` and `@RelationColumn` with the same name. The DDL will not create a duplicate column.

```typescript
@Column({ type: "int", name: "author_id" })
authorId!: number;          // Direct FK access: post.authorId = 5

@ManyToOne(() => User, (user) => user.posts)
@RelationColumn({ name: "author_id" })
author!: User;
```

### Referencing Non-PK Columns (references)

By default, FKs reference the target entity's PK. To reference a column other than the PK, use the `references` option.

```typescript
@ManyToOne(() => Owner, (owner) => owner.cats, {
  joinColumn: "owner_uuid_fk",
  references: "uuid",  // References Owner.uuid column instead of Owner.id
})
owner!: Owner;
```

This generates:

```sql
ALTER TABLE "cat"
  ADD CONSTRAINT "fk_cat_owner_uuid_fk_e5f6g7h8"
  FOREIGN KEY ("owner_uuid_fk") REFERENCES "owner" ("uuid");
```

### Referential Actions (onDelete / onUpdate)

By default, foreign keys use `ON DELETE NO ACTION ON UPDATE NO ACTION`. This means the database will reject any attempt to delete an owner who still has cats, or to change an owner's PK. You can change this behavior using `onDelete` and `onUpdate` options.

```typescript
@ManyToOne(() => Owner, (owner) => owner.cats, {
  joinColumn: "owner_id",
  onDelete: "CASCADE",     // Delete cats when owner is deleted
  onUpdate: "CASCADE",     // Update FK when owner PK changes
})
owner!: Owner;
```

This generates:

```sql
ALTER TABLE "cat"
  ADD CONSTRAINT "fk_cat_owner_id_a1b2c3d4"
  FOREIGN KEY ("owner_id") REFERENCES "owner" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
```

With `CASCADE`, if you delete owner #3, the database automatically deletes all cats where `owner_id = 3`. Without it, the delete would fail with a foreign key violation error.

Available actions:

| Action | Behavior |
|--------|----------|
| `'NO ACTION'` | Reject if child rows exist (default) |
| `'RESTRICT'` | Same as NO ACTION (checked immediately) |
| `'CASCADE'` | Delete/update children automatically |
| `'SET NULL'` | Set FK to NULL (column must be nullable) |
| `'SET DEFAULT'` | Set FK to its default value |

These options work on both `@ManyToOne` and `@OneToOne`.

### Skipping FK Constraints (createForeignKeyConstraints)

In some cases (e.g., cross-database references, performance-critical tables), you may want to skip FK constraint creation while keeping the logical relation.

```typescript
@ManyToOne(() => ExternalEntity, (e) => e.items, {
  joinColumn: "external_id",
  createForeignKeyConstraints: false,  // No FK constraint in DDL
})
external!: ExternalEntity;
```

The column is still created, but no `ALTER TABLE ... ADD CONSTRAINT FOREIGN KEY` is generated. The ORM still understands the relation and generates JOINs correctly -- it just does not ask the database to enforce the link. This option also works on `@OneToOne`.

## @OneToMany -- "What are this owner's cats?"

### Why This Is the Inverse Side

If you want to fetch a list of cats from the owner side, add `@OneToMany`. This is the inverse direction of `@ManyToOne`.

A critical thing to understand: **`@OneToMany` does NOT create any column in the database.** The foreign key column (`owner_id`) lives on the `cat` table, created by `@ManyToOne`. The `@OneToMany` decorator simply tells the ORM "when someone asks for an owner's cats, look up the `cat` table using the FK."

Think of it this way: in the real world, each cat wears a collar with its owner's name (that is the FK). The owner does not carry a list of cat IDs. To find an owner's cats, you look at all the collars.

### How It Works

```typescript
// owner.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, OneToMany } from "@stingerloom/orm";
import { Cat } from "./cat.entity";

@Entity()
export class Owner {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @OneToMany(() => Cat, { mappedBy: "owner" })
  cats!: Cat[];
}
```

`mappedBy: "owner"` means "the `owner` property on the Cat entity holds the foreign key." This tells the ORM which column to use in the JOIN.

**The Owner table DDL does NOT change.** No extra column is added:

```sql
-- PostgreSQL
CREATE TABLE "owner" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL
);
-- That's it. No "cats" column exists.
```

> **Hint** `mappedBy` supports **IntelliSense auto-completion** for the target entity's property names. When you type `mappedBy: ""` in your IDE, Cat entity's property list will be displayed. The same applies to `@ManyToMany`'s `mappedBy` and `@OneToOne`'s `inverseSide`.

### The Generated SELECT

Now you can fetch an owner's cats.

```typescript
const owner = await em.findOne(Owner, {
  where: { id: 1 },
  relations: ["cats"],
});

console.log(owner.cats); // [{ id: 1, name: "Whiskers" }, { id: 2, name: "Cheddar" }]
```

**Generated SQL (PostgreSQL):**

```sql
-- Step 1: Load the owner
SELECT * FROM "owner" WHERE "id" = 1;

-- Step 2: Load the related cats using the FK
SELECT * FROM "cat" WHERE "owner_id" = 1;
```

The ORM runs two separate queries: one for the owner, one for the cats. It then stitches them together into a single object with a `cats` array.

> **Hint** Without specifying `relations`, `cats` will not be loaded. Explicitly load only when needed, so you do not pay for queries you do not use.

## Eager Loading and Lazy Loading

### Why Loading Strategies Matter

Consider a page that lists 50 cats. If each cat has an owner, and you load owners one-by-one as you iterate:

```sql
SELECT * FROM "cat";                          -- 1 query: get 50 cats
SELECT * FROM "owner" WHERE "id" = 1;         -- query #2
SELECT * FROM "owner" WHERE "id" = 2;         -- query #3
...
SELECT * FROM "owner" WHERE "id" = 50;        -- query #51
```

That is 51 queries total. This is called the **N+1 problem**: 1 query to get N cats, then N queries to get each owner. On a fast database it might take 50ms, but on a network-separated database it could take 5 seconds.

The solution is to load the related data in fewer queries, either upfront (eager) or on-demand (lazy).

If writing `relations: ["owner"]` every time is tedious, there are two automatic loading methods.

### Eager Loading -- Always Fetch Together (1 query with JOIN)

Setting `eager: true` automatically executes a LEFT JOIN when `find()` or `findOne()` is called.

```typescript
// cat.entity.ts
@ManyToOne(() => Owner, (owner) => owner.cats, {
  joinColumn: "owner_id",
  eager: true,  // owner is automatically loaded on find()
})
owner!: Owner;
```

```typescript
const cat = await em.findOne(Cat, { where: { id: 1 } });
console.log(cat.owner.name); // "John" — loaded without relations option
```

**Generated SQL (PostgreSQL):**

```sql
SELECT
  "cat"."id"       AS "cat_id",
  "cat"."name"     AS "cat_name",
  "cat"."owner_id" AS "cat_owner_id",
  "owner"."id"     AS "owner_id",
  "owner"."name"   AS "owner_name"
FROM "cat"
LEFT JOIN "owner" ON "cat"."owner_id" = "owner"."id"
WHERE "cat"."id" = 1;
```

This is a single query that returns all the data in one round-trip. The LEFT JOIN means "include the cat even if it has no owner." Useful when related data is always needed.

### Lazy Loading -- Fetch on Access (separate query)

Setting `lazy: true` uses Proxy-based deferred loading. A DB query is executed at the moment the property is actually accessed.

```typescript
// cat.entity.ts
@ManyToOne(() => Owner, (owner) => owner.cats, {
  joinColumn: "owner_id",
  lazy: true,  // Query executes on access
})
owner!: Owner;
```

```typescript
const cat = await em.findOne(Cat, { where: { id: 1 } });
// At this point, only the cat row is loaded. No JOIN, no extra query.

const owner = await cat.owner; // SELECT executes NOW
console.log(owner.name);
```

**Generated SQL (PostgreSQL):**

```sql
-- On findOne(Cat):
SELECT * FROM "cat" WHERE "id" = 1;

-- On accessing cat.owner (triggered by the Proxy):
SELECT * FROM "owner" WHERE "id" = 3;
```

Lazy loading is useful when the relation is rarely accessed. If you list 50 cats and only display the owner for the first one, you avoid 49 unnecessary queries.

### The N+1 Trade-off

| Strategy | Queries for 50 cats with owners | Best for |
|----------|-------------------------------|----------|
| No loading | 1 (no owners) | When you don't need the relation |
| `relations: ["owner"]` | 2 (cats + owners) | Explicit per-query control |
| `eager: true` | 1 (JOIN) | When the relation is always needed |
| `lazy: true` | 1 to 51 (depends on access) | When the relation is rarely needed |

> **Warning** `eager` and `lazy` cannot be used simultaneously. If both are set, `eager` takes priority.

> **Hint** Stingerloom includes a **QueryTracker** that detects N+1 patterns at runtime and logs a warning. See the [EntityManager](./entity-manager.md) documentation for details on enabling it.

## @OneToOne -- "A user's profile"

### Why One-to-One Exists

One user, one profile. You could put all profile fields directly on the User table, but there are reasons to separate them:

1. The profile is large (bio, avatar URL, social links) and rarely loaded
2. Different access patterns: the user table is read on every request, the profile only on the profile page
3. Separation of concerns: user authentication data vs. display data

A One-to-One relation creates a FK on one side (the "owner" side) that guarantees at most one related record.

### Unidirectional (Owner Side Only)

```typescript
// profile.entity.ts
@Entity()
export class Profile {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "text" })
  bio!: string;
}
```

```typescript
// user.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, OneToOne } from "@stingerloom/orm";
import { Profile } from "./profile.entity";

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @OneToOne(() => Profile, { joinColumn: "profile_id", eager: true })
  profile!: Profile;
}
```

### The Generated DDL

**PostgreSQL:**

```sql
CREATE TABLE "profile" (
  "id" SERIAL PRIMARY KEY,
  "bio" TEXT NOT NULL
);

CREATE TABLE "user" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL,
  "profile_id" INTEGER
);

ALTER TABLE "user"
  ADD CONSTRAINT "fk_user_profile_id_c3d4e5f6"
  FOREIGN KEY ("profile_id") REFERENCES "profile" ("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
```

A `profile_id` column is created in the user table. Since `eager: true`, the Profile is loaded together when querying User.

**Generated SQL for eager loading (PostgreSQL):**

```sql
SELECT
  "user"."id"         AS "user_id",
  "user"."name"       AS "user_name",
  "user"."profile_id" AS "user_profile_id",
  "profile"."id"      AS "profile_id",
  "profile"."bio"     AS "profile_bio"
FROM "user"
LEFT JOIN "profile" ON "user"."profile_id" = "profile"."id"
WHERE "user"."id" = 1;
```

> **Hint** `@OneToOne` also supports `@RelationColumn` and `@Column`-based FK auto-detection just like `@ManyToOne`. You can use `@RelationColumn({ name: "profile_id" })` or declare `@Column({ name: "profile_fk" }) profileId: number` to omit `joinColumn`.

### Bidirectional

If you also want to reference User from Profile, use `inverseSide`.

```typescript
// user.entity.ts — Owner side (the side with the FK)
@OneToOne(() => Profile, { joinColumn: "profile_id", inverseSide: "user" })
profile!: Profile;

// profile.entity.ts — Inverse side
@OneToOne(() => User, { inverseSide: "profile" })
user!: User;
```

Like `@OneToMany`, the inverse side does NOT create any additional column. The `profile_id` FK lives on the `user` table only.

```typescript
// Query from the inverse side
const profile = await em.findOne(Profile, {
  where: { id: 1 },
  relations: ["user"],
});
console.log(profile.user.name); // "John"
```

**Generated SQL (PostgreSQL):**

```sql
SELECT
  "profile"."id"  AS "profile_id",
  "profile"."bio" AS "profile_bio",
  "user"."id"     AS "user_id",
  "user"."name"   AS "user_name"
FROM "profile"
LEFT JOIN "user" ON "user"."profile_id" = "profile"."id"
WHERE "profile"."id" = 1;
```

Notice the JOIN direction is reversed: the ORM joins from profile to user by looking for a user row whose `profile_id` matches.

## @ManyToMany -- "Tagging Posts"

### Why Many-to-Many Requires a Join Table

Blog posts can have tags, and a single tag can be used on multiple posts. This is a **Many-to-Many (N:M)** relation.

You cannot represent this with a single FK column. If you add a `tag_id` to the post table, each post can only have one tag. If you add a `post_id` to the tag table, each tag can only be on one post. Neither works.

The solution is a **join table** (also called a "junction table" or "bridge table"): a third table with two FK columns, one pointing to each side.

```
post (id, title)
  |
  +--- post_tags (post_id, tag_id) --- join table
  |
tag (id, name)
```

Each row in `post_tags` represents one connection: "post #1 has tag #2."

### How It Works

```typescript
// post.entity.ts — Owner side
import { Entity, PrimaryGeneratedColumn, Column, ManyToMany } from "@stingerloom/orm";
import { Tag } from "./tag.entity";

@Entity()
export class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @ManyToMany(() => Tag, {
    joinTable: {
      name: "post_tags",           // Join table name
      joinColumn: "post_id",       // FK for the current entity
      inverseJoinColumn: "tag_id", // FK for the target entity
    },
  })
  tags!: Tag[];
}
```

```typescript
// tag.entity.ts — Inverse side
import { Entity, PrimaryGeneratedColumn, Column, ManyToMany } from "@stingerloom/orm";
import { Post } from "./post.entity";

@Entity()
export class Tag {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @ManyToMany(() => Post, { mappedBy: "tags" })
  posts!: Post[];
}
```

### The Generated DDL

With `synchronize: true`, the `post_tags` join table is automatically created. Here is the exact DDL.

**PostgreSQL:**

```sql
CREATE TABLE "post" (
  "id" SERIAL PRIMARY KEY,
  "title" VARCHAR(255) NOT NULL
);

CREATE TABLE "tag" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL
);

-- Join table (auto-generated)
CREATE TABLE "post_tags" (
  "post_id" INTEGER NOT NULL,
  "tag_id" INTEGER NOT NULL,
  PRIMARY KEY ("post_id", "tag_id")
);

ALTER TABLE "post_tags"
  ADD CONSTRAINT "fk_post_tags_post_id"
  FOREIGN KEY ("post_id") REFERENCES "post" ("id");

ALTER TABLE "post_tags"
  ADD CONSTRAINT "fk_post_tags_tag_id"
  FOREIGN KEY ("tag_id") REFERENCES "tag" ("id");
```

**MySQL:**

```sql
CREATE TABLE `post` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `title` VARCHAR(255) NOT NULL,
  PRIMARY KEY (`id`)
);

CREATE TABLE `tag` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255) NOT NULL,
  PRIMARY KEY (`id`)
);

CREATE TABLE `post_tags` (
  `post_id` INT NOT NULL,
  `tag_id` INT NOT NULL,
  PRIMARY KEY (`post_id`, `tag_id`)
);

ALTER TABLE `post_tags`
  ADD CONSTRAINT `fk_post_tags_post_id`
  FOREIGN KEY (`post_id`) REFERENCES `post` (`id`);

ALTER TABLE `post_tags`
  ADD CONSTRAINT `fk_post_tags_tag_id`
  FOREIGN KEY (`tag_id`) REFERENCES `tag` (`id`);
```

Notice the join table has a **composite primary key** (`post_id`, `tag_id`), which ensures the same post-tag pair cannot exist twice.

### The Generated SELECT

```typescript
// Fetch post with tags
const post = await em.findOne(Post, {
  where: { id: 1 },
  relations: ["tags"],
});
console.log(post.tags); // [{ id: 1, name: "TypeScript" }, { id: 2, name: "ORM" }]
```

**Generated SQL (PostgreSQL):**

```sql
-- Step 1: Load the post
SELECT * FROM "post" WHERE "id" = 1;

-- Step 2: Load tags through the join table
SELECT "tag".*
FROM "tag"
INNER JOIN "post_tags" ON "post_tags"."tag_id" = "tag"."id"
WHERE "post_tags"."post_id" = 1;
```

The join table is queried to find which tag IDs belong to post #1, then those tags are loaded.

### Managing Join Table Data

To add or remove entries in the join table, execute SQL directly with `em.query()`. The join table is not an entity -- it is a pure relational bridge.

```typescript
// Add a tag to a post
await em.query("INSERT INTO post_tags (post_id, tag_id) VALUES ($1, $2)", [1, 3]);

// Remove a tag from a post
await em.query("DELETE FROM post_tags WHERE post_id = $1 AND tag_id = $2", [1, 3]);
```

> **Hint** See the [EntityManager](./entity-manager.md) documentation for details on `em.query()`.

## Cascade -- Save/Delete with Parent

### Why Cascade Exists

Without cascade, saving a parent entity and its children requires multiple explicit calls:

```typescript
// Without cascade: you must save each child individually
const owner = await em.save(Owner, { name: "John" });
await em.save(Cat, { name: "Whiskers", ownerId: owner.id });
await em.save(Cat, { name: "Cheddar", ownerId: owner.id });
await em.save(Cat, { name: "Luna", ownerId: owner.id });
```

This is tedious and error-prone -- you might forget to save a child, or the parent save might succeed while a child save fails (leaving your data in an inconsistent state).

With cascade, you save the parent and the ORM automatically saves the children:

```typescript
// With cascade: children are saved automatically
const owner = await em.save(Owner, {
  name: "John",
  cats: [
    { name: "Whiskers" },
    { name: "Cheddar" },
    { name: "Luna" },
  ],
});
```

### How It Works

**Cascade** allows child entities to be automatically processed when saving or deleting the parent entity.

```typescript
// owner.entity.ts
@OneToMany(() => Cat, { mappedBy: "owner", cascade: ["insert"] })
cats!: Cat[];
```

With this setting, when saving an Owner, new Cats in the cats array are automatically INSERTed.

**Generated SQL (PostgreSQL):**

```sql
-- 1. Insert the owner
INSERT INTO "owner" ("name") VALUES ('John') RETURNING *;
-- Returns: { id: 1, name: 'John' }

-- 2. Automatically insert each cat with the owner's FK
INSERT INTO "cat" ("name", "owner_id") VALUES ('Whiskers', 1) RETURNING *;
INSERT INTO "cat" ("name", "owner_id") VALUES ('Cheddar', 1) RETURNING *;
INSERT INTO "cat" ("name", "owner_id") VALUES ('Luna', 1) RETURNING *;
```

Choose from the following cascade options.

| Option | Behavior |
|--------|----------|
| `"insert"` | INSERT children when saving parent |
| `"update"` | UPDATE children when modifying parent |
| `"delete"` | DELETE children when deleting parent |
| `true` | Apply all three above |

You can combine them in an array.

```typescript
// Cascade only insert and delete
@OneToMany(() => Cat, { mappedBy: "owner", cascade: ["insert", "delete"] })
cats!: Cat[];

// Apply all cascades
@OneToMany(() => Comment, { mappedBy: "post", cascade: true })
comments!: Comment[];
```

### What Happens Without Cascade

Without `cascade: ["delete"]`, deleting a parent with children will fail (assuming FK constraints are enforced):

```sql
DELETE FROM "owner" WHERE "id" = 1;
-- ERROR: update or delete on table "owner" violates foreign key constraint
-- "fk_cat_owner_id_a1b2c3d4" on table "cat"
-- Detail: Key (id)=(1) is still referenced from table "cat".
```

You would need to delete the children first, then the parent:

```sql
DELETE FROM "cat" WHERE "owner_id" = 1;    -- delete children first
DELETE FROM "owner" WHERE "id" = 1;        -- then delete parent
```

With `cascade: ["delete"]`, the ORM does this automatically in the correct order.

> **Warning** `cascade: ["delete"]` is a powerful feature. Deleting a parent will delete all children, so be careful of unintended data loss. This is an ORM-level cascade (Stingerloom handles the ordering), which is different from the database-level `ON DELETE CASCADE` in FK constraints. Both achieve similar results, but the ORM cascade also triggers lifecycle hooks and event subscribers.

## Relation Loading Summary

Here's a summary of the three ways to fetch related data.

| Method | Configuration Location | Behavior | When to Use |
|--------|----------------------|----------|-------------|
| `relations` option | At `find()` call time | JOIN only specified relations | When you want to load relations only when needed |
| `eager: true` | Decorator option | Always auto JOIN | When the relation is almost always needed |
| `lazy: true` | Decorator option | Query on property access | When the relation is rarely used |

```typescript
// Load multiple relations at once with the relations option
const user = await em.findOne(User, {
  where: { id: 1 },
  relations: ["profile", "posts"],
});
```

**Generated SQL (PostgreSQL):**

```sql
-- The eager relation (profile) is JOINed in the main query
SELECT
  "user".*,
  "profile".*
FROM "user"
LEFT JOIN "profile" ON "user"."profile_id" = "profile"."id"
WHERE "user"."id" = 1;

-- The OneToMany relation (posts) is loaded in a separate query
SELECT * FROM "post" WHERE "author_id" = 1;
```

ManyToOne and OneToOne relations are loaded via LEFT JOIN (single query). OneToMany relations are loaded in a separate query because a JOIN would multiply the parent rows.

## Next Steps

Now that you've set up relationships between entities, it's time to learn various ways to manipulate data.

- [EntityManager](./entity-manager.md) -- find, save, delete, aggregation, pagination
- [Query Builder](./query-builder.md) -- When you need complex SQL like JOIN, GROUP BY
- [Transactions](./transactions.md) -- When you need to group multiple operations into one
