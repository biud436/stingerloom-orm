# NestJS Integration

Stingerloom provides first-class NestJS support through a dedicated module with dependency injection, lifecycle management, and multi-database connections.

## Installation

The NestJS integration is available as a subpath export — no extra package needed.

```typescript
import { StinglerloomOrmModule } from "@stingerloom/orm/nestjs";
```

## Quick Start

### 1. Register the Module

Use `forRoot()` in your root `AppModule` to establish the database connection:

```typescript
// app.module.ts
import { Module } from "@nestjs/common";
import { StinglerloomOrmModule } from "@stingerloom/orm/nestjs";
import { CatsModule } from "./cats/cats.module";
import { Cat } from "./entities/cat.entity";

@Module({
  imports: [
    StinglerloomOrmModule.forRoot({
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

### 2. Register Entities per Feature Module

Use `forFeature()` to make entity repositories available for injection in feature modules:

```typescript
// cats.module.ts
import { Module } from "@nestjs/common";
import { StinglerloomOrmModule } from "@stingerloom/orm/nestjs";
import { Cat } from "../entities/cat.entity";
import { CatsService } from "./cats.service";
import { CatsController } from "./cats.controller";

@Module({
  imports: [StinglerloomOrmModule.forFeature([Cat])],
  providers: [CatsService],
  controllers: [CatsController],
})
export class CatsModule {}
```

### 3. Inject into Services

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

## Decorators

### @InjectRepository(Entity, connectionName?)

Injects a `BaseRepository<T>` for the specified entity. The entity must be registered via `forFeature()`.

```typescript
@InjectRepository(Cat)
private readonly catRepo: BaseRepository<Cat>;
```

`BaseRepository` provides: `find`, `findOne`, `findWithCursor`, `findAndCount`, `save`, `delete`, `softDelete`, `restore`, `insertMany`, `deleteMany`, `count`, `sum`, `avg`, `min`, `max`, `explain`, `upsert`, `stream`, `createQueryBuilder`, and more.

### @InjectEntityManager(connectionName?)

Injects the `EntityManager` directly. Use this when you need operations beyond what the repository offers — raw queries, transactions, subscribers, or buffer operations.

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

## Lifecycle Management

The `StinglerloomOrmService` manages the EntityManager lifecycle automatically:

- **OnModuleInit** — Initializes the EntityManager and establishes the database connection
- **OnApplicationShutdown** — Calls `propagateShutdown()` to cleanly close connections, clear listeners, and release resources

To use NestJS shutdown hooks, enable them in `main.ts`:

```typescript
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks(); // Required for graceful shutdown
  await app.listen(3000);
}
bootstrap();
```

## Multi-Database Connections

For applications that connect to multiple databases, pass a `connectionName` to `forRoot()` and `forFeature()`.

### Setup

```typescript
// app.module.ts
@Module({
  imports: [
    // Default connection (MySQL)
    StinglerloomOrmModule.forRoot({
      type: "mysql",
      host: "localhost",
      database: "main_db",
      entities: [User, Post],
      // ...
    }),

    // Named connection (PostgreSQL)
    StinglerloomOrmModule.forRoot(
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
    StinglerloomOrmModule.forFeature([Event, Metric], "analytics"),
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

Omitting the connection name always uses the `"default"` connection.

## Registering Event Subscribers

Register `EntitySubscriber` instances during module initialization:

```typescript
import { Injectable, OnModuleInit, Inject } from "@nestjs/common";
import { StinglerloomOrmService } from "@stingerloom/orm/nestjs";

@Injectable()
export class CatsSubscriberService implements OnModuleInit {
  constructor(
    @Inject(StinglerloomOrmService)
    private readonly ormService: StinglerloomOrmService,
  ) {}

  onModuleInit() {
    const em = this.ormService.getEntityManager();
    em.addSubscriber(new CatAuditSubscriber());
  }
}
```

## StinglerloomOrmService

The service is available for injection and provides direct access to the EntityManager:

```typescript
@Inject(StinglerloomOrmService)
private readonly ormService: StinglerloomOrmService;

// Access EntityManager
const em = ormService.getEntityManager();

// Get any repository
const repo = ormService.getRepository(User);
```

## Exported API

Everything is imported from `@stingerloom/orm/nestjs`:

| Export | Description |
|--------|-------------|
| `StinglerloomOrmModule` | Main module with `forRoot()` and `forFeature()` |
| `StinglerloomOrmService` | Service with EntityManager lifecycle |
| `InjectRepository` | Decorator for repository injection |
| `InjectEntityManager` | Decorator for EntityManager injection |
| `getEntityManagerToken(name?)` | Token helper for manual DI |
| `getOrmServiceToken(name?)` | Token helper for service injection |
| `makeInjectRepositoryToken(entity, name?)` | Token helper for repository providers |

## Next Steps

- [EntityManager](./entity-manager.md) — Full CRUD API reference
- [Events & Subscribers](./events.md) — EntitySubscriber pattern in detail
- [Configuration](./configuration.md) — Connection pooling, read replicas, and more
- [Multi-Tenancy](./multi-tenancy.md) — Per-tenant schema isolation with NestJS
