# Relations

A **Relation** is a connection between two entities. It reflects real-world relationships in the database, such as "a blog post has an author" or "an owner has multiple cats."

Stingerloom ORM supports four types of relations.

| Relation | Example | Decorator |
|----------|---------|-----------|
| Many-to-One (N:1) | Cat -> Owner | `@ManyToOne` |
| One-to-Many (1:N) | Owner -> Cats | `@OneToMany` |
| One-to-One (1:1) | User -> Profile | `@OneToOne` |
| Many-to-Many (N:M) | Post <-> Tag | `@ManyToMany` |

Let's start with the most common Many-to-One relation and work through each one.

## @ManyToOne — "Who is this cat's owner?"

Think about the relationship between cats and owners. One owner can have multiple cats, but each cat has only one owner. This is a **Many-to-One (N:1)** relation.

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

What `@ManyToOne` does is clear: it creates an `owner_id` foreign key column in the cat table that references the PK of the owner table.

Looking at the three arguments:

- `() => Owner` — The target entity (wrapped in a function to prevent circular references)
- `(owner) => owner.cats` — The inverse property (used for bidirectional relations; can be omitted for unidirectional)
- `{ joinColumn: "owner_id" }` — The foreign key column name

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

1. If `@ManyToOne`'s `joinColumn` option is specified -> use as-is
2. If a `@Column` with `{propertyName}Id` is declared on the same entity -> use that `@Column`'s DB column name
3. If neither exists -> fallback to `{propertyName}Id` convention

Declaring a `@Column` also has the advantage of being able to directly read and write FK values on the entity.

```typescript
const cat = new Cat();
cat.ownerId = 3;          // Set FK value directly
await em.save(Cat, cat);

console.log(cat.ownerId); // Read FK value directly
```

### Referencing Non-PK Columns (references)

By default, FKs reference the target entity's PK. To reference a column other than the PK, use the `references` option.

```typescript
@ManyToOne(() => Owner, (owner) => owner.cats, {
  joinColumn: "owner_uuid_fk",
  references: "uuid",  // References Owner.uuid column
})
owner!: Owner;
```

## @OneToMany — "What are this owner's cats?"

If you want to fetch a list of cats from the owner side, add `@OneToMany`. This is the inverse direction of `@ManyToOne`.

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

`mappedBy: "owner"` means "the `owner` property on the Cat entity holds the foreign key." `@OneToMany` itself does not create a column in the DB. It simply enables fetching related data during queries.

> **Hint** `mappedBy` supports **IntelliSense auto-completion** for the target entity's property names. When you type `mappedBy: ""` in your IDE, Cat entity's property list will be displayed. The same applies to `@ManyToMany`'s `mappedBy` and `@OneToOne`'s `inverseSide`.

Now you can fetch an owner's cats.

```typescript
const owner = await em.findOne(Owner, {
  where: { id: 1 },
  relations: ["cats"],
});

console.log(owner.cats); // [{ id: 1, name: "Whiskers" }, { id: 2, name: "Cheddar" }]
```

> **Hint** Without specifying `relations`, `cats` will not be loaded. Explicitly load only when needed.

## Eager Loading and Lazy Loading

If writing `relations: ["owner"]` every time is tedious, there are two automatic loading methods.

### Eager Loading — Always Fetch Together

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
console.log(cat.owner.name); // "John" — loaded without relations
```

Useful when related data is always needed.

### Lazy Loading — Fetch on Access

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
const owner = await cat.owner; // SELECT query executes at this point
console.log(owner.name);
```

> **Warning** `eager` and `lazy` cannot be used simultaneously. If both are set, `eager` takes priority.

## @OneToOne — "A user's profile"

One user, one profile. This is a **One-to-One (1:1)** relation.

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

A `profile_id` column is created in the user table. Since `eager: true`, the Profile is loaded together when querying User.

> **Hint** `@OneToOne` also supports `@Column`-based FK auto-detection just like `@ManyToOne`. If you declare `@Column({ name: "profile_fk" }) profileId: number`, you can omit `joinColumn`.

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

```typescript
// Query from the inverse side
const profile = await em.findOne(Profile, {
  where: { id: 1 },
  relations: ["user"],
});
console.log(profile.user.name); // "John"
```

## @ManyToMany — "Tagging Posts"

Blog posts can have tags, and a single tag can be used on multiple posts. This is a **Many-to-Many (N:M)** relation.

Many-to-Many relations require a **join table**. Stingerloom creates it automatically.

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

With `synchronize: true`, the `post_tags` join table is automatically created with foreign keys referencing both tables' PKs.

```typescript
// Fetch post with tags
const post = await em.findOne(Post, {
  where: { id: 1 },
  relations: ["tags"],
});
console.log(post.tags); // [{ id: 1, name: "TypeScript" }, { id: 2, name: "ORM" }]
```

> **Hint** To add/remove data in the join table, execute SQL directly with `em.query()`. See the [EntityManager](./entity-manager.md) documentation for details.

## Cascade — Save/Delete with Parent

**Cascade** allows child entities to be automatically processed when saving or deleting the parent entity.

```typescript
// owner.entity.ts
@OneToMany(() => Cat, { mappedBy: "owner", cascade: ["insert"] })
cats!: Cat[];
```

With this setting, when saving an Owner, new Cats in the cats array are automatically INSERTed.

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

> **Warning** `cascade: ["delete"]` is a powerful feature. Deleting a parent will delete all children, so be careful of unintended data loss.

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

## Next Steps

Now that you've set up relationships between entities, it's time to learn various ways to manipulate data.

- [EntityManager](./entity-manager.md) — find, save, delete, aggregation, pagination
- [Query Builder](./query-builder.md) — When you need complex SQL like JOIN, GROUP BY
- [Transactions](./transactions.md) — When you need to group multiple operations into one
