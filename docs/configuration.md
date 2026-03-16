# Configuration Guide

Configure DB connections, pooling, timeouts, Read Replicas, and more through options passed to `EntityManager.register()`. This document starts with the most common settings and progresses to production-level configurations.

## Basic Connection

### PostgreSQL

```typescript
import { EntityManager } from "@stingerloom/orm";
import { User } from "./user.entity";

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
```

### MySQL / MariaDB

```typescript
await em.register({
  type: "mysql",        // Use "mariadb" for MariaDB
  host: "localhost",
  port: 3306,
  username: "root",
  password: "password",
  database: "mydb",
  entities: [User],
  synchronize: true,
  charset: "utf8mb4",   // utf8mb4 is required to store emojis
});
```

### SQLite

```typescript
await em.register({
  type: "sqlite",
  host: "",
  port: 0,
  username: "",
  password: "",
  database: "./mydb.sqlite",  // File path
  entities: [User],
  synchronize: true,
});
```

## synchronize Option

The `synchronize` option controls how Stingerloom keeps the DB schema in sync with entity definitions.

| Value | Behavior |
|-------|----------|
| `true` | **Full sync** — creates, alters, and drops tables/columns to match entities. Existing data may be lost. |
| `"safe"` | **Safe sync** — creates new tables and adds new columns, but never drops anything. Safe for staging environments. |
| `"dry-run"` | **Dry run** — logs the DDL statements that would be executed without actually running them. Useful for reviewing changes before applying. |
| `false` | **No sync** (default) — schema is not modified at all. |

```typescript
await em.register({
  // ...
  synchronize: "safe",    // Add new tables/columns, never drop
});
```

> **Warning** Only use `synchronize: true` in development environments. In production, there is a risk of data loss, so you should use [migrations](./migrations.md) instead. Consider `"safe"` mode for staging or `"dry-run"` to preview changes.

## Connection Pooling

Efficiently reuses DB connections when there are many concurrent requests.

```typescript
await em.register({
  type: "postgres",
  // ...
  pool: {
    max: 20,                // Maximum connections (default: 10)
    min: 5,                 // Minimum idle connections (default: 0)
    acquireTimeoutMs: 5000, // Connection acquire wait time (default: 30000ms)
    idleTimeoutMs: 30000,   // Idle connection timeout (default: 10000ms)
  },
});
```

Supported options vary by database.

| Option | MySQL | PostgreSQL | SQLite |
|--------|-------|-----------|--------|
| `max` | O | O | Ignored |
| `min` | - | O | Ignored |
| `acquireTimeoutMs` | - | O | Ignored |
| `idleTimeoutMs` | - | O | Ignored |

> **Hint** SQLite is file-based with a single connection, so pool settings are ignored.

## Connection Retry

Automatically retries when the DB is not yet started or the connection is temporarily lost. Wait times increase with exponential backoff.

```typescript
await em.register({
  type: "mysql",
  // ...
  retry: {
    maxAttempts: 5,   // Maximum retry attempts (default: 3)
    backoffMs: 500,   // Base delay time (default: 1000ms)
  },
});
```

With the above configuration, the actual wait times are as follows.

| Attempt | Wait Time |
|---------|-----------|
| 1st | 500ms |
| 2nd | 1000ms |
| 3rd | 2000ms |
| 4th | 4000ms |
| 5th | 8000ms |

## Query Logging

### Basic Logging

```typescript
await em.register({
  // ...
  logging: true, // Print executed SQL to console
});
```

### Detailed Logging

```typescript
await em.register({
  // ...
  logging: {
    queries: true,       // Print every executed SQL statement to console
    slowQueryMs: 500,    // Warn on queries exceeding 500ms
    nPlusOne: true,      // Enable N+1 pattern detection
  },
});
```

The `queries` option is the most commonly used. When set to `true`, every SQL statement executed by the ORM is printed to the console along with its parameters. This is invaluable for debugging during development but should be disabled in production to avoid performance overhead and log noise.

You can also query the log programmatically.

```typescript
const log = em.getQueryLog();
```

## Query Timeout

### Global Setting

```typescript
await em.register({
  // ...
  queryTimeout: 5000, // 5-second timeout for all queries
});
```

### Per-Query Setting

Takes precedence over the global setting.

```typescript
const users = await em.find(User, {
  where: { isActive: true },
  timeout: 2000, // 2-second timeout for this query only
});
```

A `QueryTimeoutError` is thrown when the timeout is exceeded.

| DB | Internal Implementation |
|----|------------------------|
| MySQL | `SET max_execution_time = N` |
| PostgreSQL | `SET LOCAL statement_timeout = N` |
| SQLite | Driver-level timeout |

## Read Replica (Read/Write Splitting)

Automatically routes writes to master and reads to slave.

```typescript
await em.register({
  type: "mysql",
  host: "master.example.com",
  port: 3306,
  username: "root",
  password: "password",
  database: "mydb",
  entities: [User, Post],
  synchronize: true,
  replication: {
    master: {
      host: "master.example.com",
      port: 3306,
      username: "root",
      password: "password",
      database: "mydb",
    },
    slaves: [
      {
        host: "replica1.example.com",
        port: 3306,
        username: "readonly",
        password: "password",
        database: "mydb",
      },
      {
        host: "replica2.example.com",
        port: 3306,
        username: "readonly",
        password: "password",
        database: "mydb",
      },
    ],
  },
});
```

When there are multiple slaves, they are distributed using round-robin. If all slaves fail, it automatically falls back to master.

When you need the latest data immediately after a write, use the `useMaster` option.

```typescript
await em.save(User, { id: 1, name: "Updated" });

const user = await em.findOne(User, {
  where: { id: 1 },
  useMaster: true, // Ignore replica lag
});
```

## Multi-DB Connections

You can operate different databases independently. Specify the connection name as the second argument to `register()`.

```typescript
// Primary DB (MySQL)
const primaryEm = new EntityManager();
await primaryEm.register({
  type: "mysql",
  // ...
  entities: [User],
  synchronize: true,
}, "primary");

// Analytics DB (PostgreSQL)
const analyticsEm = new EntityManager();
await analyticsEm.register({
  type: "postgres",
  // ...
  entities: [Log],
  synchronize: true,
}, "analytics");

// Use each independently
const users = await primaryEm.find(User);
const logs = await analyticsEm.find(Log);

console.log(primaryEm.getConnectionName());   // "primary"
console.log(analyticsEm.getConnectionName()); // "analytics"
```

### Multi-DB in NestJS

The NestJS integration module also supports named connections. Pass a connectionName as the second argument to `forRoot()` and `forFeature()`.

```typescript
// app.module.ts
@Module({
  imports: [
    StinglerloomOrmModule.forRoot(mysqlOptions),                  // "default"
    StinglerloomOrmModule.forRoot(postgresOptions, "analytics"),  // named
    UsersModule,
    AnalyticsModule,
  ],
})
export class AppModule {}

// analytics.module.ts
@Module({
  imports: [StinglerloomOrmModule.forFeature([Event], "analytics")],
})
export class AnalyticsModule {}

// analytics.service.ts
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

When connectionName is omitted, the `"default"` connection is used, maintaining full backward compatibility.

Token helper functions are also available:
- `getEntityManagerToken(connectionName?)` — Returns the EntityManager DI token
- `getOrmServiceToken(connectionName?)` — Returns the OrmService DI token
- `makeInjectRepositoryToken(entity, connectionName?)` — Returns the Repository DI token

## Full Options Reference

```typescript
interface DatabaseClientOptions {
  type: "mysql" | "mariadb" | "postgres" | "sqlite";
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  entities: AnyEntity[];
  synchronize?: boolean | "safe" | "dry-run";  // Schema sync mode (default: false)
  schema?: string;               // PostgreSQL schema (default: "public")
  charset?: string;              // MySQL charset
  datesStrings?: boolean;        // Return MySQL dates as strings
  queryTimeout?: number;         // Global query timeout (ms)
  pool?: PoolOptions;            // Connection pool settings
  retry?: RetryOptions;          // Connection retry settings
  logging?: boolean | LoggingOptions;  // Query logging
  replication?: ReplicationConfig;     // Read Replica settings
  namingStrategy?: NamingStrategy;     // Custom FK/index naming strategy
  tenantStrategy?: "search_path" | "schema_qualified"; // PG tenant query strategy (default: "search_path")
}
```

## Next Steps

- [Advanced Features](./advanced.md) — N+1 detection, event system, performance optimization
- [Multi-Tenancy](./multi-tenancy.md) — Per-tenant data isolation
- [API Reference](./api-reference.md) — Full method signatures
