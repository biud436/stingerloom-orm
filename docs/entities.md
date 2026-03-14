# Entities

An **Entity** is a TypeScript class that represents a database table. Each entity class corresponds to one table, and the class properties become the table's columns.

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

Let's look at what each of the three decorators does.

**`@Entity()`** declares that this class is an ORM entity. The class name `User` is automatically converted to snake_case to become the table name `user`. If you want to specify the table name explicitly, pass an option.

```typescript
// user.entity.ts
@Entity({ name: "app_users" })
export class User { /* table name: app_users */ }
```

**`@PrimaryGeneratedColumn()`** defines an auto-increment (AUTO_INCREMENT) primary key. The DB automatically fills in 1, 2, 3... in sequence even if you don't provide a value during INSERT.

**`@Column()`** defines a regular column. It reads the TypeScript type and automatically infers the appropriate DB type — `string` becomes `VARCHAR(255)`, `number` becomes `INT`.

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

If `type` is omitted, it is automatically inferred from the TypeScript type. However, even for the same `string`, a short name (`varchar`) and a long body (`text`) are different, so it's best to specify based on the intended use.

> **Hint** Stingerloom's column types are database-independent. For example, `"boolean"` is automatically converted to `TINYINT(1)` in MySQL and `BOOLEAN` in PostgreSQL. See the [ColumnType Reference](#columntype-reference) at the bottom of this document for the full mapping table.

## Setting Column Options

`@Column()` accepts options to control the column's detailed behavior.

### Specifying Length

Specifies the maximum length of a string column. If omitted, the default length for `varchar` is 255.

```typescript
@Column({ type: "varchar", length: 100 })
sku!: string;
```

### Allowing NULL

By default, all columns are NOT NULL. For columns that may not have a value, set `nullable: true`.

```typescript
@Column({ nullable: true })
bio!: string | null;
```

Adding `| null` to the TypeScript type as well allows natural null checking in your code.

### Column Name Alias

Use the `name` option when you want the property name and the actual DB column name to differ.

```typescript
@Column({ name: "unit_price", type: "float" })
price!: number;
// TypeScript: product.price / DB: unit_price
```

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

When the value is wrapped in parentheses like `"(CURRENT_TIMESTAMP)"`, Stingerloom emits it as a raw SQL `DEFAULT` expression in the DDL instead of a quoted string literal.

### JSON Column

Use the JSON type to store structured data in a single column.

```typescript
@Column({ type: "json", nullable: true })
settings!: Record<string, unknown> | null;
```

### Value Transform

You can apply a transform function when mapping values read from the DB to TypeScript objects. This is useful when booleans are stored as numbers, like MySQL's `TINYINT(1)`.

```typescript
@Column({ transform: (raw) => raw === 1 })
isActive!: boolean;
```

### PostgreSQL ENUM

You can use custom ENUM types in PostgreSQL.

```typescript
@Column({
  type: "enum",
  enumValues: ["draft", "published", "archived"],
  enumName: "post_status",
})
status!: string;
```

> **Hint** If `enumName` is omitted, it is automatically generated in the format `{tableName}_{columnName}_enum`.

## Manual Primary Key (@PrimaryColumn)

Sometimes you need a primary key where you specify the value directly rather than using auto-increment. For example, a key-value structured configuration table.

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

`@PrimaryColumn()` does not apply AUTO_INCREMENT, so you must provide the key value directly when calling `save()`.

## Improving Query Performance with Indexes

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

Adding `@Index()` automatically creates an index in the format `INDEX_user_email`. Be sure to add it if you frequently use `email` in WHERE conditions.

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

This creates a UNIQUE INDEX on the `(categoryId, slug)` combination. You can also specify the index name directly.

```typescript
@UniqueIndex(["categoryId", "slug"], { name: "uq_post_category_slug" })
```

> **Hint** `@UniqueIndex` is a **class-level** decorator. Remember that `@Index()` is placed on properties, while `@UniqueIndex()` is placed on classes.

## Optimistic Locking (@Version)

Conflicts can occur when multiple users modify the same data simultaneously. Using the `@Version()` decorator, `WHERE version = currentVersion` is automatically added during UPDATE, and simultaneously `version = currentVersion + 1` is set. If another user modified the data first, the version will differ and the UPDATE will fail.

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

> **Hint** Optimistic locking is suitable when conflicts are rare but data integrity is important (e.g., order status changes, inventory management).

## Soft Delete (@DeletedAt)

Sometimes you want to mark data as "deleted" without actually removing it, like putting a post in the trash.

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

Adding the `@DeletedAt()` decorator changes three things.

First, calling `em.softDelete(Post, { id: 1 })` records the current time in `deleted_at` instead of deleting the row.

Second, `em.find(Post)` automatically adds `WHERE deleted_at IS NULL` to exclude deleted data.

Third, to include deleted data in the query, use the `{ withDeleted: true }` option.

```typescript
await em.softDelete(Post, { id: 1 });                      // soft delete
const posts = await em.find(Post);                         // excludes deleted
const all = await em.find(Post, { withDeleted: true });    // includes deleted
await em.restore(Post, { id: 1 });                         // restore
```

## Automatic Timestamps (@CreateTimestamp / @UpdateTimestamp)

Most entities need `createdAt` and `updatedAt` columns. Instead of manually setting these with lifecycle hooks, use the built-in timestamp decorators.

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

**`@CreateTimestamp()`** automatically sets the current time on INSERT. The value is never changed on subsequent UPDATEs.

**`@UpdateTimestamp()`** automatically sets the current time on both INSERT and UPDATE.

Both decorators create a `DATETIME` (MySQL) / `TIMESTAMP` (PostgreSQL) NOT NULL column. If you need timezone-aware timestamps in PostgreSQL, use `@Column({ type: "timestamptz" })` with lifecycle hooks instead.

> **Hint** If a value is explicitly provided for a `@CreateTimestamp` or `@UpdateTimestamp` column in the `save()` call, the provided value is used instead of the auto-generated one.

## Lifecycle Hooks

You can define **code that runs automatically** when an entity is saved, updated, or deleted. This is useful for custom logic beyond what `@CreateTimestamp`/`@UpdateTimestamp` provide.

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

Methods decorated with `@BeforeInsert()` are automatically called just before INSERT, and `@BeforeUpdate()` just before UPDATE.

There are 6 available lifecycle hooks in total.

| Decorator | Execution Timing | When to Use |
|-----------|-----------------|-------------|
| `@BeforeInsert()` | Just before INSERT | Default values, timestamps |
| `@AfterInsert()` | After INSERT completes | Logging, sending notifications |
| `@BeforeUpdate()` | Just before UPDATE | Updating updatedAt |
| `@AfterUpdate()` | After UPDATE completes | Recording change history |
| `@BeforeDelete()` | Just before DELETE | Cleanup before deletion |
| `@AfterDelete()` | After DELETE completes | Cleaning up related resources, logging |

> **Hint** In "After" hooks, the DB operation has already completed, so modifying data will not be reflected in the DB. Use them for side effects like logging or external notifications.

## Validation

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

- **`@NotNull()`** — Error if `null` or `undefined`
- **`@MinLength(n)` / `@MaxLength(n)`** — String length validation
- **`@Min(n)` / `@Max(n)`** — Numeric range validation

Calling `save()` with invalid data will throw an error before the DB query is executed.

```typescript
await em.save(Member, { name: "A", age: -1 });
// ValidationError: name must be at least 2 characters long
```

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
| `transform` | `(raw) => any` | Value transform function when reading from DB |
| `precision` | `number` | Decimal precision |
| `scale` | `number` | Decimal scale |
| `enumValues` | `string[]` | PostgreSQL ENUM value list |
| `enumName` | `string` | PostgreSQL ENUM type name |

## Next Steps

Now that you've defined entities, it's time to set up relationships between them.

- [Relations](./relations.md) — Define relationships between tables with `@ManyToOne`, `@OneToMany`, etc.
- [EntityManager](./entity-manager.md) — Perform CRUD with your defined entities
- [Transactions](./transactions.md) — Group multiple operations into a single unit
- [Migrations](./migrations.md) — Safely manage schema changes
