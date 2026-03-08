# Getting Started

This guide walks you through installing Stingerloom ORM, defining your first entity, and performing create/read/update/delete operations step by step. It should take about 5 minutes.

## Prerequisites

- Node.js 18 or higher
- TypeScript project
- MySQL, PostgreSQL, or SQLite database

## Step 1: Installation

```bash
pnpm add @stingerloom/orm reflect-metadata
```

> **Hint** If you use npm or yarn, replace with `npm install` or `yarn add`.

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

In a NestJS project, register with `StinglerloomOrmModule` in the root module and inject repositories into services using `@InjectRepository()`.

### Module Registration

```typescript
// app.module.ts
import { Module } from "@nestjs/common";
import { StinglerloomOrmModule } from "./stingerloom-orm/stingerloom-orm.module";
import { User } from "./user.entity";

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
  ],
})
export class AppModule {}
```

### Usage in Services

```typescript
// users.service.ts
import { Injectable } from "@nestjs/common";
import { BaseRepository, InjectRepository } from "@stingerloom/orm";
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

> **Hint** Complete NestJS examples are included in the `examples/nestjs-cats/`, `examples/nestjs-blog/`, and `examples/nestjs-multitenant/` directories.

## Next Steps

You've learned the basic setup and CRUD. Now try defining richer entities.

- [Entities](./entities.md) — Column types, indexes, Soft Delete, lifecycle hooks
- [Relations](./relations.md) — Define relationships between tables with `@ManyToOne`, `@OneToMany`
- [EntityManager](./entity-manager.md) — Find options, aggregation, pagination
- [Configuration Guide](./configuration.md) — Pooling, timeouts, Read Replica, and other operational settings
