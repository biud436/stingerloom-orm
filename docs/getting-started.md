# Getting Started

This guide walks you through installing Stingerloom ORM, defining your first entity, and performing create/read/update/delete operations step by step. It should take about 5 minutes.

## Prerequisites

- Node.js 20 or higher (latest LTS recommended)
- TypeScript project
- MySQL, PostgreSQL, or SQLite database

## Step 1: Installation

Install the core package and `reflect-metadata`, then add the driver for your database.

```bash
pnpm add @stingerloom/orm reflect-metadata
```

| Database | Driver package | Command |
|----------|---------------|---------|
| PostgreSQL | `pg` | `pnpm add pg` |
| MySQL / MariaDB | `mysql2` | `pnpm add mysql2` |
| SQLite | `better-sqlite3` | `pnpm add better-sqlite3` |

For example, a PostgreSQL project needs:

```bash
pnpm add @stingerloom/orm reflect-metadata pg
```

> **Hint** If you use npm or yarn, replace `pnpm add` with `npm install` or `yarn add`.

### CJS and ESM

Stingerloom ORM ships as a **dual CJS/ESM package**. Both `require()` and `import` work out of the box — no extra configuration needed.

```typescript
// ESM (recommended)
import { EntityManager } from "@stingerloom/orm";

// CommonJS
const { EntityManager } = require("@stingerloom/orm");
```

Subpath exports are also dual:

```typescript
import { StinglerloomOrmModule } from "@stingerloom/orm/nestjs";
import { PrismaImporter } from "@stingerloom/orm/prisma-import";
```

## Step 2: TypeScript Configuration

Enable decorator-related options in your `tsconfig.json`.

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

`experimentalDecorators` and `emitDecoratorMetadata` are required for decorators like `@Entity()` and `@Column()` to work. Disabling `strictPropertyInitialization` prevents initialization errors on entity properties without `!:`.

## Step 3: Define an Entity

An **Entity** is a TypeScript class that represents a database table. Let's create a simple user entity.

```typescript
// user.entity.ts
import { Entity, PrimaryGeneratedColumn, Column } from "@stingerloom/orm";

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Column()
  email!: string;
}
```

`@Entity()` declares that this class corresponds to a DB table, `@PrimaryGeneratedColumn()` defines an auto-increment primary key, and `@Column()` defines a regular column. This code alone will create a `user` table.

> **Hint** To learn more about entities, refer to the [Entities](./entities.md) documentation.

## Step 4: Connect to the Database

Now connect to the DB using `EntityManager` and register your entities. Make sure to import `reflect-metadata` at the very top of your application entry point.

```typescript
// main.ts
import "reflect-metadata";
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

When `synchronize: true` is set, tables are automatically created based on entity definitions. No need to worry if the `user` table doesn't exist yet.

> **Warning** Use `synchronize: true` only in development. In production, manage your schema with [migrations](./migrations.md).

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

`em.save()` performs an INSERT when there is no PK, and an UPDATE when there is. It returns an object that includes the auto-generated `id`.

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

`find()` returns an array, and `findOne()` returns a single object or `null`.

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

When `save()` includes a PK (`id`), the corresponding row is updated.

### Delete

```typescript
// main.ts
const result = await em.delete(User, { id: 1 });
console.log("Rows deleted:", result.affected); // 1
```

Congratulations! You've completed your first CRUD.

## Using Other Databases

The example above uses PostgreSQL, but you can use other databases by simply changing the `type` option.

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
// SQLite example — host, port, username, password are empty
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

### Installation

```bash
pnpm add @stingerloom/orm reflect-metadata
```

`@nestjs/common` and `@nestjs/core` are listed as optional peer dependencies — they are already present in any NestJS project.

### Root Module Registration

Use `StinglerloomOrmModule.forRoot()` to initialize the database connection, and `StinglerloomOrmModule.forFeature()` to register entity repositories.

```typescript
// app.module.ts
import { Module } from "@nestjs/common";
import { StinglerloomOrmModule } from "@stingerloom/orm/nestjs";
import { User } from "./user.entity";
import { UsersModule } from "./users/users.module";

@Module({
  imports: [
    StinglerloomOrmModule.forRoot({
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
import { StinglerloomOrmModule } from "@stingerloom/orm/nestjs";
import { User } from "./user.entity";
import { UsersService } from "./users.service";

@Module({
  imports: [StinglerloomOrmModule.forFeature([User])],
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
import { StinglerloomOrmModule } from "@stingerloom/orm/nestjs";
import { User } from "./user.entity";
import { Event } from "./event.entity";

@Module({
  imports: [
    // Default connection (MySQL)
    StinglerloomOrmModule.forRoot({
      type: "mysql",
      host: "localhost",
      port: 3306,
      username: "root",
      password: "password",
      database: "main",
      entities: [User],
    }),
    // Named connection (PostgreSQL)
    StinglerloomOrmModule.forRoot({
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
  imports: [StinglerloomOrmModule.forFeature([Event], "analytics")],
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

> **Hint** Complete NestJS examples are included in the `examples/nestjs-cats/`, `examples/nestjs-blog/`, and `examples/nestjs-multitenant/` directories.

## Next Steps

You've learned the basic setup and CRUD. Now try defining richer entities.

- [Entities](./entities.md) — Column types, indexes, Soft Delete, lifecycle hooks
- [Relations](./relations.md) — Define relationships between tables with `@ManyToOne`, `@OneToMany`
- [EntityManager](./entity-manager.md) — Find options, aggregation, pagination
- [NestJS Integration](./nestjs.md) — forRoot/forFeature, @InjectRepository, multi-DB
- [Configuration](./configuration.md) — Pooling, timeouts, Read Replica, and other operational settings
