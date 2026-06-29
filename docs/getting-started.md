# Getting Started

This guide walks you through installing Stingerloom ORM, defining your first entity, and performing create/read/update/delete operations step by step. It should take about 5 minutes.

## What Is an ORM?

When you write a web application, your data lives in two very different worlds. In your TypeScript code, data lives in **objects** -- classes with properties and methods. In your database, data lives in **tables** -- rows and columns of raw values.

An ORM (Object-Relational Mapper) is the translation layer between these two worlds. Instead of writing SQL strings by hand, you define a TypeScript class, and the ORM figures out how to create the table, insert rows, query data, and give you back typed objects.

Think of it like a universal translator. You speak TypeScript, your database speaks SQL, and the ORM translates every conversation between them.

Without an ORM:

```typescript
// You write raw SQL strings, get back untyped rows
const result = await pool.query('SELECT * FROM "user" WHERE "id" = $1', [1]);
const user = result.rows[0]; // { id: 1, name: "Alice" } -- no type safety
```

With an ORM:

```typescript
// You work with typed objects, the ORM writes the SQL
const user = await em.findOne(User, { where: { id: 1 } });
// user is User | null -- full type safety, auto-completed properties
```

The ORM handles the translation in both directions: your class definition becomes a `CREATE TABLE` statement, your `save()` call becomes an `INSERT`, and your `find()` call becomes a `SELECT`. You will see the exact SQL for each of these operations in this guide.

## Prerequisites

- Node.js 22 or higher (latest LTS recommended)
- TypeScript project
- MySQL, PostgreSQL, or SQLite database

## Step 1: Installation

Install the core package and `reflect-metadata`, then add the driver for your database.

::: code-group

```bash [npm]
npm install @stingerloom/orm reflect-metadata
```

```bash [pnpm]
pnpm add @stingerloom/orm reflect-metadata
```

```bash [yarn]
yarn add @stingerloom/orm reflect-metadata
```

:::

Then install the driver for your database:

::: code-group

```bash [PostgreSQL]
npm install pg            # or pnpm add pg / yarn add pg
```

```bash [MySQL / MariaDB]
npm install mysql2        # or pnpm add mysql2 / yarn add mysql2
```

```bash [SQLite]
npm install better-sqlite3  # or pnpm add better-sqlite3 / yarn add better-sqlite3
```

:::

For example, a PostgreSQL project needs:

::: code-group

```bash [npm]
npm install @stingerloom/orm reflect-metadata pg
```

```bash [pnpm]
pnpm add @stingerloom/orm reflect-metadata pg
```

```bash [yarn]
yarn add @stingerloom/orm reflect-metadata pg
```

:::

### Why reflect-metadata?

When you write `@Column()` on a class property, TypeScript records some information about that property (its type, its name) at compile time. But by default, that information is erased when the code is compiled to JavaScript.

`reflect-metadata` is a polyfill that makes this metadata available at **runtime**. The ORM needs it to answer questions like "what type is the `email` property?" so it can map `string` to `VARCHAR` and `number` to `INTEGER` automatically. Without it, decorators like `@Entity()` and `@Column()` would have no way to know what your class looks like.

You only need to import it once, at the very top of your application entry point. After that, every decorator in the ORM can read the type information it needs.

### CJS and ESM

Stingerloom ORM ships as a **dual CJS/ESM package**. Both `require()` and `import` work out of the box -- no extra configuration needed.

```typescript
// ESM (recommended)
import { EntityManager } from "@stingerloom/orm";

// CommonJS
const { EntityManager } = require("@stingerloom/orm");
```

Subpath exports are also dual:

```typescript
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { PrismaImporter } from "@stingerloom/orm/prisma-import";
import { EntityManager } from "@stingerloom/orm/core";       // core only
import { PostgresDriver } from "@stingerloom/orm/postgres";   // single dialect
```

::: tip Optional: class-transformer
By default, the ORM uses a lightweight `PlainObjectDeserializer` (zero dependencies). If you install `class-transformer`, it will be auto-detected and used as the deserializer -- no configuration needed.

```bash
npm install class-transformer   # optional, for advanced deserialization
```
:::

## Step 2: TypeScript Configuration

If you define entities with the **code-first builder** (`defineEntity`, shown in Step 3), no special compiler options are required — skip ahead.

The **decorator** style (`@Entity`, `@Column`) needs the following in your `tsconfig.json`:

```json
// tsconfig.json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "strictPropertyInitialization": false
  }
}
```

Here is what each option does:

- `experimentalDecorators` -- Enables the `@Entity()`, `@Column()` syntax. Without this, TypeScript treats `@` as a syntax error.
- `emitDecoratorMetadata` -- Tells the compiler to emit type information that `reflect-metadata` can read at runtime. This is how the ORM knows that `name: string` should become a `VARCHAR` column.
- `strictPropertyInitialization` -- Normally, TypeScript complains if a class property is not assigned in the constructor. Entity properties are populated by the ORM, not the constructor, so we disable this check to avoid needing `!:` on every property.

> The code-first builder needs none of these — it carries the column types itself and uses no decorators. You still import `reflect-metadata` once at your entry point (the ORM core uses it at runtime).

## Step 3: Define an Entity

An **Entity** represents a database table; each row is one record. The recommended way to define one is the **code-first builder API** — `defineEntity` with the `t` field builders. You write a single declaration and the entity's TypeScript type is inferred from it.

```typescript
// user.entity.ts
import { defineEntity, t, InferEntity } from "@stingerloom/orm";

export const User = defineEntity("users", {
  id:    t.int().primary().generated(),
  name:  t.varchar(255),
  email: t.varchar(255),
});

export type User = InferEntity<typeof User>;
// { id: number; name: string; email: string }
```

What each part does:

- `defineEntity("users", { … })` -- Defines a table named `users`. The returned `User` is a real class you use everywhere the ORM expects an entity (`em.findOne(User, …)`).
- `t.int().primary().generated()` -- A primary key whose value the database auto-generates (auto-increment for MySQL, `SERIAL` for PostgreSQL).
- `t.varchar(255)` -- A `VARCHAR(255)` column. The builder fixes both the SQL type and the inferred TypeScript type (`string`), so the two can never drift.
- `InferEntity<typeof User>` -- Recovers the row type from the schema. No separate interface, no codegen.

::: tip Prefer decorators?
If you like the class-and-decorator style (or you're on NestJS), the same entity is also expressible with `@Entity` / `@Column`, which produce identical metadata:

```typescript
import { Entity, PrimaryGeneratedColumn, Column } from "@stingerloom/orm";

@Entity()
export class User {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
  @Column() email!: string;
}
```

The decorator path requires the `experimentalDecorators` and `emitDecoratorMetadata` compiler options from Step 2; the code-first builder above does not. Both styles interoperate in the same project — see [Defining Entities](./define-entity.md) and [Entities & Columns (Decorators)](./entities.md).
:::

When `synchronize: true` is set (next step), the ORM generates this DDL and executes it:

```sql
-- PostgreSQL
CREATE TABLE "users" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255),
  "email" VARCHAR(255)
);

-- MySQL
CREATE TABLE `users` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(255),
  `email` VARCHAR(255)
);
```

Notice the identifier wrapping difference: PostgreSQL uses `"double quotes"`, MySQL uses `` `backticks` ``. The ORM handles this automatically based on your `type` setting.

> **Hint** To learn more about defining entities, see [Defining Entities](./define-entity.md) (code-first) and [Entities & Columns](./entities.md) (decorators).

## Step 4: Connect to the Database

Now connect to the DB using `EntityManager` and register your entities. Make sure to import `reflect-metadata` at the very top of your application entry point -- before any other imports that use decorators.

```typescript
// main.ts
import "reflect-metadata";  // Must be the very first import
import { EntityManager } from "@stingerloom/orm";
import { User } from "./user.entity";

async function main() {
  const em = new EntityManager();

  await em.register({
    type: "postgres",
    host: "localhost",
    port: 5432,
    username: "postgres",
    password: "password",
    database: "mydb",
    entities: [User],
    synchronize: true,
  });

  console.log("DB connection successful!");
}

main().catch(console.error);
```

When `synchronize: true` is set, the ORM compares your entity definitions against the live database and creates or alters tables to match. If the `user` table does not exist yet, it executes the `CREATE TABLE` DDL shown above. If the table exists but is missing a column you added, it runs `ALTER TABLE` to add it.

> **Warning** Use `synchronize: true` only in development. In production, it can drop columns or tables that no longer match your entities. Use [migrations](./migrations.md) instead -- they give you full control over what changes reach your production database.

## Step 5: Try CRUD

Now that the DB is connected, let's create, read, update, and delete data. Continue writing inside the `main()` function.

### Create

```typescript
// main.ts (inside main function)
const user = await em.save(User, {
  name: "John Doe",
  email: "john@example.com",
});
console.log("Saved user:", user);
// { id: 1, name: "John Doe", email: "john@example.com" }
```

`em.save()` sees that no `id` is provided, so it performs an INSERT. Here is the actual SQL that gets executed:

```sql
-- PostgreSQL
INSERT INTO "user" ("name", "email") VALUES ($1, $2) RETURNING *
-- Parameters: ["John Doe", "john@example.com"]

-- MySQL
INSERT INTO `user` (`name`, `email`) VALUES (?, ?)
-- Parameters: ["John Doe", "john@example.com"]
-- Then: SELECT * FROM `user` WHERE `id` = LAST_INSERT_ID()
```

Notice that user-provided values are never placed directly in the SQL string. They appear as `$1`, `$2` (PostgreSQL) or `?` (MySQL) -- this is **parameter binding**, and it prevents SQL injection. PostgreSQL also supports `RETURNING *`, which returns the inserted row in a single round-trip. MySQL needs a second query to fetch the auto-generated `id`.

### Read

```typescript
// main.ts
// Fetch all
const users = await em.find(User);
console.log("All users:", users);

// Find one by condition
const found = await em.findOne(User, { where: { id: 1 } });
console.log("Single user:", found); // User | null
```

The generated SQL:

```sql
-- find() -- fetch all users
SELECT "id", "name", "email" FROM "user"

-- findOne() -- find by condition
SELECT "id", "name", "email" FROM "user" WHERE "id" = $1 LIMIT 1
-- Parameters: [1]
```

`find()` returns an array (empty if no rows match). `findOne()` returns a single typed object or `null`. The ORM automatically adds `LIMIT 1` for `findOne()` since you only need one row.

### Update

```typescript
// main.ts
const updated = await em.save(User, {
  id: 1,               // PK present, so UPDATE
  name: "John Doe (edited)",
  email: "john@example.com",
});
console.log("Updated user:", updated);
```

When `save()` receives an object with a primary key (`id: 1`), it performs an UPDATE instead of an INSERT:

```sql
-- PostgreSQL
UPDATE "user" SET "name" = $1, "email" = $2 WHERE "id" = $3
-- Parameters: ["John Doe (edited)", "john@example.com", 1]

-- MySQL
UPDATE `user` SET `name` = ?, `email` = ? WHERE `id` = ?
-- Parameters: ["John Doe (edited)", "john@example.com", 1]
```

### Delete

```typescript
// main.ts
const result = await em.delete(User, { id: 1 });
console.log("Rows deleted:", result.affected); // 1
```

The generated SQL:

```sql
DELETE FROM "user" WHERE "id" = $1
-- Parameters: [1]
```

Congratulations -- you have completed your first CRUD. Every operation was a single method call, and the ORM handled the SQL generation, parameter binding, and result deserialization behind the scenes.

## Using Other Databases

The example above uses PostgreSQL, but you can use other databases by simply changing the `type` option. The rest of your code stays identical.

| DB | `type` | `port` | Notes |
|----|--------|--------|-------|
| PostgreSQL | `"postgres"` | 5432 | Schema can be specified with the `schema` option |
| MySQL / MariaDB | `"mysql"` | 3306 | `charset: "utf8mb4"` recommended |
| SQLite | `"sqlite"` | 0 | Specify file path for `database` (e.g., `"./mydb.sqlite"`) |

```typescript
// MySQL example
await em.register({
  type: "mysql",
  host: "localhost",
  port: 3306,
  username: "root",
  password: "password",
  database: "mydb",
  entities: [User],
  synchronize: true,
  charset: "utf8mb4",
});
```

```typescript
// SQLite example -- host, port, username, password are empty
await em.register({
  type: "sqlite",
  host: "",
  port: 0,
  username: "",
  password: "",
  database: "./mydb.sqlite",
  entities: [User],
  synchronize: true,
});
```

## Using with NestJS

Stingerloom ORM provides a first-party NestJS integration module via the `@stingerloom/orm/nestjs` subpath export.

### Why a Separate Module?

NestJS uses **Dependency Injection (DI)** -- instead of creating objects yourself with `new`, you declare what you need, and NestJS provides it. The ORM module bridges these two worlds: it creates the `EntityManager` and repositories, then registers them in NestJS's DI container so your services can declare them as constructor parameters.

The flow works like this:

1. `forRoot()` creates an `EntityManager`, connects to the database, and registers it as a global NestJS provider.
2. `forFeature([User])` creates a `BaseRepository<User>` and registers it with a unique token derived from the `User` class.
3. `@InjectRepository(User)` in your service tells NestJS: "give me the repository registered for User."
4. NestJS resolves the dependency and passes the repository to your service's constructor.

### Installation

::: code-group

```bash [npm]
npm install @stingerloom/orm reflect-metadata
```

```bash [pnpm]
pnpm add @stingerloom/orm reflect-metadata
```

```bash [yarn]
yarn add @stingerloom/orm reflect-metadata
```

:::

`@nestjs/common` and `@nestjs/core` are listed as optional peer dependencies -- they are already present in any NestJS project.

### Root Module Registration

Use `StingerloomOrmModule.forRoot()` to initialize the database connection, and `StingerloomOrmModule.forFeature()` to register entity repositories.

```typescript
// app.module.ts
import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { User } from "./user.entity";
import { UsersModule } from "./users/users.module";

@Module({
  imports: [
    StingerloomOrmModule.forRoot({
      type: "postgres",
      host: "localhost",
      port: 5432,
      username: "postgres",
      password: "password",
      database: "mydb",
      entities: [User],
      synchronize: true,
    }),
    UsersModule,
  ],
})
export class AppModule {}
```

### Feature Module Registration

```typescript
// users/users.module.ts
import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { User } from "./user.entity";
import { UsersService } from "./users.service";

@Module({
  imports: [StingerloomOrmModule.forFeature([User])],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
```

### Usage in Services

Import `InjectRepository` from `@stingerloom/orm/nestjs` to inject typed repositories.

```typescript
// users/users.service.ts
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { BaseRepository } from "@stingerloom/orm";
import { User } from "./user.entity";

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly userRepo: BaseRepository<User>,
  ) {}

  async findAll(): Promise<User[]> {
    return (await this.userRepo.find()) as User[];
  }

  async findById(id: number): Promise<User | null> {
    return this.userRepo.findOne({ where: { id } as any });
  }

  async create(name: string, email: string): Promise<User> {
    return (await this.userRepo.save({ name, email })) as User;
  }
}
```

### Multi-DB (Named Connections)

Pass a `connectionName` to `forRoot()` and `forFeature()` to use multiple databases simultaneously.

```typescript
// app.module.ts
import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { User } from "./user.entity";
import { Event } from "./event.entity";

@Module({
  imports: [
    // Default connection (MySQL)
    StingerloomOrmModule.forRoot({
      type: "mysql",
      host: "localhost",
      port: 3306,
      username: "root",
      password: "password",
      database: "main",
      entities: [User],
    }),
    // Named connection (PostgreSQL)
    StingerloomOrmModule.forRoot({
      type: "postgres",
      host: "localhost",
      port: 5432,
      username: "postgres",
      password: "password",
      database: "analytics",
      entities: [Event],
    }, "analytics"),
    UsersModule,
    AnalyticsModule,
  ],
})
export class AppModule {}
```

Specify the connectionName in feature modules:

```typescript
// analytics/analytics.module.ts
@Module({
  imports: [StingerloomOrmModule.forFeature([Event], "analytics")],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
```

Pass the connectionName to `@InjectRepository` and `@InjectEntityManager` in services:

```typescript
// analytics/analytics.service.ts
import { Injectable } from "@nestjs/common";
import {
  InjectRepository,
  InjectEntityManager,
} from "@stingerloom/orm/nestjs";
import { BaseRepository, EntityManager } from "@stingerloom/orm";
import { Event } from "./event.entity";

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectRepository(Event, "analytics")
    private readonly eventRepo: BaseRepository<Event>,
    @InjectEntityManager("analytics")
    private readonly em: EntityManager,
  ) {}
}
```

> When connectionName is omitted, it defaults to `"default"`, so existing single-DB code works without any changes.

> **Hint** Complete NestJS examples are included under `examples/`: `nestjs-cats` (basic CRUD + EntitySubscriber), `nestjs-blog` (M2M, soft delete, upsert, 59 e2e tests), `nestjs-multitenant` (PostgreSQL schema-per-tenant), `nestjs-todo` (minimal CRUD), `nestjs-todo-sqlite` (SQLite), and `nestjs-linear-clone` (full reference app — recursive-CTE issue trees, workflow state machine, analytics, workspace-isolated multi-tenancy).

## Next Steps

You have learned the basic setup and CRUD. Now try defining richer entities.

- [Entities](./entities.md) -- Column types, indexes, Soft Delete, lifecycle hooks
- [Relations](./relations.md) -- Define relationships between tables with `@ManyToOne`, `@OneToMany`
- [EntityManager](./entity-manager.md) -- Find options, aggregation, pagination
- [NestJS Integration](./nestjs.md) -- forRoot/forFeature, @InjectRepository, multi-DB
- [Configuration](./configuration.md) -- Pooling, timeouts, Read Replica, and other operational settings
