# NestJS Integration

## Why NestJS Integration Exists

NestJS uses dependency injection (DI) to wire services together. When you write `constructor(private readonly userService: UserService)`, NestJS looks up `UserService` in its DI container and provides an instance. This works beautifully for your own classes, but an ORM's EntityManager and repositories are not NestJS services by default. The framework does not know how to create them, when to initialize the database connection, or when to shut it down.

The Stingerloom NestJS integration module solves three problems:

1. **Lifecycle management** -- It creates the EntityManager, establishes the database connection when NestJS starts, and cleanly closes it when NestJS shuts down.
2. **Repository injection** -- It registers each entity's repository as a NestJS provider so you can inject it with a decorator, just like any other service.
3. **Multi-database support** -- When your application connects to multiple databases, it ensures each repository is wired to the correct EntityManager using scoped DI tokens.

## Installation

The NestJS integration is available as a subpath export -- no extra package needed.

```typescript
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
```

---

## Quick Start

### Step 1: Register the Module with forRoot()

Call `forRoot()` in your root `AppModule`. This is where the database connection is established.

```typescript
// app.module.ts
import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { CatsModule } from "./cats/cats.module";
import { Cat } from "./entities/cat.entity";

@Module({
  imports: [
    StingerloomOrmModule.forRoot({
      type: "mysql",
      host: "localhost",
      port: 3306,
      username: "root",
      password: "password",
      database: "mydb",
      entities: [Cat],
      synchronize: true, // Development only
    }),
    CatsModule,
  ],
})
export class AppModule {}
```

#### What forRoot() does under the hood

When NestJS processes `StingerloomOrmModule.forRoot(options)`, four things happen:

1. **Creates an EntityManager** -- A new `EntityManager` instance is created.
2. **Calls `em.register(options)`** -- This connects to the database, scans entities, and optionally synchronizes the schema. This happens inside a NestJS factory provider, so it runs during module initialization.
3. **Registers the EntityManager as a global provider** -- The `EntityManager` instance is placed into NestJS's DI container under a specific token. Because the module is marked `global: true`, this provider is available to every module in your application without re-importing.
4. **Creates a StingerloomOrmService** -- This service wraps the EntityManager and implements NestJS lifecycle hooks: `OnModuleInit` for setup and `OnApplicationShutdown` for calling `propagateShutdown()` to close connections and clean up resources.

The key insight: `forRoot()` should be called **once** per database connection, in your root module.

### Step 2: Register Entities per Feature Module with forFeature()

```typescript
// cats.module.ts
import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { Cat } from "../entities/cat.entity";
import { CatsService } from "./cats.service";
import { CatsController } from "./cats.controller";

@Module({
  imports: [StingerloomOrmModule.forFeature([Cat])],
  providers: [CatsService],
  controllers: [CatsController],
})
export class CatsModule {}
```

#### What forFeature() does under the hood

When NestJS processes `StingerloomOrmModule.forFeature([Cat])`, it creates a provider for each entity:

1. **Generates a unique DI token** for `Cat` -- a Symbol like `Symbol("INJECT_REPOSITORIES_TOKEN_Cat")`. This token is cached in a WeakMap keyed by the entity class, so calling `forFeature([Cat])` in multiple modules always produces the same token.
2. **Creates a factory provider** that receives the EntityManager (from `forRoot()`) and calls `em.getRepository(Cat)` to get a `BaseRepository<Cat>`.
3. **Exports the provider** so it is available for injection in the module's services and controllers.

The result: when NestJS encounters `@InjectRepository(Cat)` in a constructor, it knows exactly which token to look up and which `BaseRepository<Cat>` instance to inject.

Misconfigurations fail fast at module initialization with actionable errors instead of Nest's generic `can't resolve dependencies (?)`: a typo'd `connectionName` in `forFeature()` throws an `OrmError` listing the connections `forRoot()`/`forRootAsync()` actually registered (with a closest-match suggestion), an entity missing from that connection's `entities` array throws `EntityMetadataNotFoundError` naming the connection, and injecting a repository without importing the matching `forFeature()` produces a token whose Symbol description itself names the `forFeature([...])` call to add.

### Step 3: Inject into Services

```typescript
// cats.service.ts
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { BaseRepository } from "@stingerloom/orm";
import { Cat } from "../entities/cat.entity";

@Injectable()
export class CatsService {
  constructor(
    @InjectRepository(Cat)
    private readonly catRepo: BaseRepository<Cat>,
  ) {}

  async findAll() {
    return this.catRepo.find();
  }

  async findOne(id: number) {
    return this.catRepo.findOne({ where: { id } as any });
  }

  async create(data: Partial<Cat>) {
    return this.catRepo.save(data);
  }

  async remove(id: number) {
    return this.catRepo.delete({ id });
  }
}
```

---

## Decorators

### @InjectRepository(Entity, connectionName?)

Injects a `BaseRepository<T>` for the specified entity.

```typescript
@InjectRepository(Cat)
private readonly catRepo: BaseRepository<Cat>;
```

#### Why you need this decorator

In NestJS, constructor injection works by matching parameter types to DI tokens. But `BaseRepository<Cat>` and `BaseRepository<Dog>` have the same runtime type -- TypeScript generics are erased at runtime. NestJS has no way to distinguish them.

`@InjectRepository(Cat)` solves this by attaching a unique DI token (a Symbol) to the constructor parameter. The token is derived from the entity class itself, so `@InjectRepository(Cat)` and `@InjectRepository(Dog)` produce different tokens, and NestJS injects the correct repository for each.

Under the hood, `@InjectRepository(Cat)` is equivalent to `@Inject(Symbol("INJECT_REPOSITORIES_TOKEN_Cat"))`. The decorator exists so you do not have to manage tokens manually.

`BaseRepository` provides: `find`, `findOne`, `findWithCursor`, `findAndCount`, `save`, `delete`, `softDelete`, `restore`, `insertMany`, `insertManyAndReturn`, `deleteMany`, `count`, `sum`, `avg`, `min`, `max`, `explain`, `upsert`, `stream`, `createQueryBuilder`, and more.

### @InjectEntityManager(connectionName?)

Injects the `EntityManager` directly. Use this when you need operations beyond what the repository offers -- raw queries, transactions, subscribers, or buffer operations.

```typescript
import { InjectEntityManager } from "@stingerloom/orm/nestjs";
import { EntityManager } from "@stingerloom/orm";

@Injectable()
export class CatsService {
  constructor(
    @InjectEntityManager()
    private readonly em: EntityManager,
  ) {}

  async complexQuery() {
    return this.em.query<{ count: number }>(
      "SELECT COUNT(*) as count FROM cat WHERE age > ?",
      [5],
    );
  }

  async transferWithTransaction(fromId: number, toId: number) {
    return this.em.transaction(async (txEm) => {
      // ... transactional operations
    });
  }
}
```

---

## Lifecycle Management

The `StingerloomOrmService` manages the EntityManager lifecycle automatically through NestJS hooks:

- **OnModuleInit** -- Registers the EntityManager in an internal registry and logs initialization.
- **OnApplicationShutdown** -- Shuts the ORM down with `closeConnections: true`: the connection pool this module registered is closed, event listeners are removed, entity subscribers are cleared, the QueryTracker is stopped, and plugins are shut down in reverse installation order.

Only the pool registered under this module's `connectionName` is closed, so in a multi-database application each `forRoot()` releases its own connection and leaves the others alone. With `tenantStrategy: "database"`, the shutdown runs through the `MultiTenantEntityManager`: every tenant pool the router provisioned is closed along with the admin pool, since the tenant managers are reachable from nowhere else. The service logs `Stingerloom ORM disconnected (connection "...")` only after the close succeeds; a failed shutdown is logged as an error and propagated to `app.close()`.

> The core `em.propagateShutdown()` API defaults to `closeConnections: false` -- a library consumer may tear down an EntityManager and keep using the pool. The NestJS integration passes `true`, because the module owns the pool it registered and the application is on its way out.

`app.close()` -- what `@nestjs/testing` and most integration tests call -- runs the hook by itself. For signal-driven shutdown (SIGTERM from Kubernetes, Ctrl-C in development), enable the hooks in `main.ts`:

```typescript
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks(); // Required for SIGTERM/SIGINT to reach onApplicationShutdown()
  await app.listen(3000);
}
bootstrap();
```

Without `enableShutdownHooks()`, a signal kills the process without running `onApplicationShutdown()`, so nothing closes the pool -- the database only notices when the abandoned connections time out.

---

## Multi-Database Connections

### Why multi-database?

Your application might store users and business data in MySQL, analytics events in PostgreSQL, and audit logs in a separate database for compliance. Each database needs its own EntityManager, its own connection, and its own set of repositories.

The challenge in a DI framework: when a service asks for `BaseRepository<Event>`, how does NestJS know which database to get it from? The answer is **token scoping** -- each connection gets its own set of DI tokens.

### How token scoping works

When you call `forRoot(options, "analytics")`, Stingerloom creates the EntityManager under the token `"STINGERLOOM_ENTITY_MANAGER_analytics"` instead of the default `EntityManager` class token. When you call `forFeature([Event], "analytics")`, the repository for `Event` is created under `Symbol("INJECT_REPOSITORIES_TOKEN_Event_analytics")` instead of `Symbol("INJECT_REPOSITORIES_TOKEN_Event")`.

This means `@InjectRepository(Event)` (no connection name) and `@InjectRepository(Event, "analytics")` resolve to completely different providers, even though they are for the same entity class.

### Setup

```typescript
// app.module.ts
@Module({
  imports: [
    // Default connection (MySQL)
    StingerloomOrmModule.forRoot({
      type: "mysql",
      host: "localhost",
      database: "main_db",
      entities: [User, Post],
      // ...
    }),

    // Named connection (PostgreSQL)
    StingerloomOrmModule.forRoot(
      {
        type: "postgres",
        host: "analytics-db.example.com",
        database: "analytics",
        entities: [Event, Metric],
        // ...
      },
      "analytics",  // connection name
    ),

    UsersModule,
    AnalyticsModule,
  ],
})
export class AppModule {}
```

### Feature Modules

```typescript
// analytics.module.ts
@Module({
  imports: [
    StingerloomOrmModule.forFeature([Event, Metric], "analytics"),
  ],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
```

### Injecting Named Connections

Pass the connection name as the second argument to any decorator:

```typescript
// analytics.service.ts
@Injectable()
export class AnalyticsService {
  constructor(
    @InjectRepository(Event, "analytics")
    private readonly eventRepo: BaseRepository<Event>,

    @InjectEntityManager("analytics")
    private readonly analyticsEm: EntityManager,
  ) {}
}
```

Omitting the connection name always uses the `"default"` connection. This means existing single-database applications continue to work without any code changes.

---

## Registering Event Subscribers

Register `EntitySubscriber` instances during module initialization:

```typescript
import { Injectable, OnModuleInit, Inject } from "@nestjs/common";
import { StingerloomOrmService } from "@stingerloom/orm/nestjs";

@Injectable()
export class CatsSubscriberService implements OnModuleInit {
  constructor(
    @Inject(StingerloomOrmService)
    private readonly ormService: StingerloomOrmService,
  ) {}

  onModuleInit() {
    const em = this.ormService.getEntityManager();
    em.addSubscriber(new CatAuditSubscriber());
  }
}
```

---

## StingerloomOrmService

The service is available for injection and provides direct access to the EntityManager:

```typescript
@Inject(StingerloomOrmService)
private readonly ormService: StingerloomOrmService;

// Access EntityManager
const em = ormService.getEntityManager();

// Get any repository
const repo = ormService.getRepository(User);
```

---

## Exported API

Everything is imported from `@stingerloom/orm/nestjs`:

| Export | Description |
|--------|-------------|
| `StingerloomOrmModule` | Main module with `forRoot()` and `forFeature()` |
| `StingerloomOrmService` | Service with EntityManager lifecycle management |
| `InjectRepository` | Decorator for repository injection |
| `InjectEntityManager` | Decorator for EntityManager injection |
| `getEntityManagerToken(name?)` | Token helper for manual DI |
| `getOrmServiceToken(name?)` | Token helper for service injection |
| `makeInjectRepositoryToken(entity, name?)` | Token helper for repository providers |

## Next Steps

- [EntityManager](./entity-manager.md) -- Full CRUD API reference
- [Events & Subscribers](./events.md) -- EntitySubscriber pattern in detail
- [Configuration](./configuration.md) -- Connection pooling, read replicas, and more
- [Multi-Tenancy](./multi-tenancy.md) -- Per-tenant schema isolation with NestJS
