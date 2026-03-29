# Configuration Guide

This guide walks through every configuration option Stingerloom offers, starting from "just make it work" and building toward production-grade setups. Each section explains **why** the option exists before showing how to use it.

## Basic Connection

Before anything interesting happens, Stingerloom needs to talk to a database. You tell it where the database lives, how to authenticate, and which entities to manage.

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
  charset: "utf8mb4",   // utf8mb4 is required to store 4-byte characters like emojis
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

SQLite stores everything in a single file. There is no server to connect to, which is why host/port/username/password are empty. This makes it perfect for testing, prototyping, and embedded applications.

---

## synchronize Option

### Why does this exist?

When you add a new `@Column()` to an entity or create a brand new entity class, the database does not magically know about it. Someone or something needs to run `ALTER TABLE` or `CREATE TABLE` statements. The `synchronize` option automates this process during development so you do not have to write DDL by hand every time you change an entity.

### The four modes

| Value | Behavior | When to use |
|-------|----------|-------------|
| `false` | **No sync** (default) -- schema is never modified | Production. You control the schema through migrations. |
| `true` | **Full sync** -- creates, alters, and drops tables/columns to match entities | Development only. If you remove a column from an entity, the database column and all its data are dropped. |
| `"safe"` | **Safe sync** -- creates new tables and adds new columns, but never drops anything | Staging. New things appear, old things are left alone. No data loss. |
| `"dry-run"` | **Dry run** -- logs the DDL that would be executed, without running it | Pre-deployment review. You see exactly what SQL would change your schema. |

```typescript
await em.register({
  // ...
  synchronize: "safe",
});
```

### Real-world danger scenarios

**Full sync (`true`) in production -- the nightmare scenario:**
On Monday, your entity has a `nickname` column. On Tuesday, you decide to rename it to `displayName`. Full sync sees that `nickname` no longer exists in the entity, so it runs `ALTER TABLE user DROP COLUMN nickname`. All user nicknames are gone. Then it creates `displayName` as a new empty column. This is not a rename -- it is a delete and a create.

**Safe sync (`"safe"`) -- the safety net:**
Same scenario, but with safe sync. The ORM creates a new `displayName` column but leaves `nickname` alone. No data is lost. You can migrate the data manually and drop the old column when you are ready.

**Dry run (`"dry-run"`) -- the preview:**
Same scenario again. The ORM prints the DDL to your console -- `ALTER TABLE user ADD COLUMN display_name varchar(255)` -- but does not execute it. You review the output, maybe adjust your migration file, and apply it yourself.

> **Warning:** Only use `synchronize: true` in development environments. In production, use [migrations](./migrations.md) instead.

---

## Connection Pooling

### Why connection pooling matters

Opening a new database connection is expensive. Each connection involves a TCP handshake, authentication, and SSL negotiation. On most systems, this takes 30-80 milliseconds. That may sound small, but consider an API server handling 200 requests per second. If every request opens and closes its own connection, you spend 6-16 seconds per second just on connection overhead. That is physically impossible.

Think of it like a taxi stand at an airport. Instead of calling a new taxi every time a passenger arrives (waiting for it to drive from wherever it was parked), you keep a fleet of taxis waiting at the curb. When a passenger arrives, they grab an available taxi. When they are done, the taxi returns to the stand for the next passenger. That is a connection pool.

### Configuration

```typescript
await em.register({
  type: "postgres",
  // ...
  pool: {
    max: 20,                // Maximum connections in the pool (default: 10)
    min: 5,                 // Minimum idle connections kept warm (default: 0)
    acquireTimeoutMs: 5000, // How long to wait for a free connection (default: 30000ms)
    idleTimeoutMs: 30000,   // How long an idle connection stays alive (default: 10000ms)
  },
});
```

**What each setting means:**

- **`max: 20`** -- At most 20 simultaneous connections. If all 20 are busy and request #21 arrives, it waits in line (up to `acquireTimeoutMs`). Setting this too high wastes database memory; too low causes queuing.
- **`min: 5`** -- Always keep at least 5 connections open, even if nobody is using them. This avoids the cold-start penalty when traffic picks up after a quiet period.
- **`acquireTimeoutMs: 5000`** -- If no connection becomes available within 5 seconds, throw an error. This prevents requests from hanging indefinitely when the pool is saturated.
- **`idleTimeoutMs: 30000`** -- If a connection has been sitting idle for 30 seconds and the pool has more than `min` connections, close it. This frees resources during low traffic.

### Database support

| Option | MySQL | PostgreSQL | SQLite |
|--------|-------|-----------|--------|
| `max` | Yes | Yes | Ignored |
| `min` | -- | Yes | Ignored |
| `acquireTimeoutMs` | -- | Yes | Ignored |
| `idleTimeoutMs` | -- | Yes | Ignored |

> **Note:** SQLite is file-based with a single connection, so pool settings are ignored. There is no TCP overhead because reads and writes go directly to a file on disk.

---

## Connection Retry

### Why connection retry matters

In modern deployments, your application and database often start simultaneously. In Docker Compose, Kubernetes, or any container orchestration system, there is no guarantee that the database will be accepting connections by the time your application tries to connect. Without retry logic, your application crashes on startup with "ECONNREFUSED" and you have to restart it manually.

Connection retry solves this by trying again, waiting a little longer each time.

### Configuration

```typescript
await em.register({
  type: "mysql",
  // ...
  retry: {
    maxAttempts: 5,   // Try up to 5 times (default: 3)
    backoffMs: 500,   // Start waiting at 500ms (default: 1000ms)
  },
});
```

### The exponential backoff formula

The wait time between retries is not constant. It doubles each time:

```
delay = backoffMs * 2^(attempt - 1)
```

With `backoffMs: 500`, the actual timeline looks like this:

| Attempt | Formula | Wait before next attempt |
|---------|---------|--------------------------|
| 1st | 500 * 2^0 | 500ms |
| 2nd | 500 * 2^1 | 1,000ms |
| 3rd | 500 * 2^2 | 2,000ms |
| 4th | 500 * 2^3 | 4,000ms |
| 5th | (final attempt) | -- |

The total maximum wait time before giving up is 500 + 1000 + 2000 + 4000 = **7.5 seconds**. This is usually enough for a database container to finish initialization.

Why exponential backoff instead of a fixed delay? If the database is down for a brief network hiccup, the first retry (500ms) catches it quickly. If it is a slower startup (like PostgreSQL recovering from a crash), later attempts give it enough breathing room without hammering the server with connection requests.

---

## Query Logging

### Why query logging matters

An ORM generates SQL for you, which is the whole point. But when something goes wrong -- a query returns unexpected results, a page loads slowly -- you need to see the actual SQL being sent to the database. Query logging makes the invisible visible.

### Basic logging

```typescript
await em.register({
  // ...
  logging: true,
});
```

### What the output looks like

When `logging: true` is enabled, every SQL statement appears in your console with its parameters:

```
[Query] SELECT "id", "name", "email", "age" FROM "user" WHERE "is_active" = $1 [true]  (12ms)
[Query] INSERT INTO "user" ("name", "email", "age") VALUES ($1, $2, $3) RETURNING "id" ["Alice", "alice@example.com", 28]  (8ms)
[Query] UPDATE "user" SET "name" = $1 WHERE "id" = $2 ["Bob", 42]  (5ms)
```

Each line shows: the SQL statement, the bound parameter values in brackets, and the execution time in milliseconds. The parameters are shown separately from the SQL (using `$1`, `$2` placeholders) because that is how they are actually sent to the database -- as parameterized queries, safe from SQL injection.

### Detailed logging

For finer control, pass an object:

```typescript
await em.register({
  // ...
  logging: {
    queries: true,       // Print every SQL statement (same as logging: true)
    slowQueryMs: 500,    // Warn on queries exceeding 500ms
    nPlusOne: true,      // Enable N+1 query pattern detection
  },
});
```

See the [Logging & Diagnostics](./logging.md) guide for full details on N+1 detection and slow query warnings.

### Programmatic access

You can also retrieve the query log as data, not just console output:

```typescript
const log = em.getQueryLog();
// [
//   { entityName: "User", sql: "SELECT ...", durationMs: 12, timestamp: 1711234567890 },
//   { entityName: "Cat",  sql: "SELECT ...", durationMs: 8,  timestamp: 1711234567920 },
// ]
```

This is useful for building custom dashboards, writing performance tests, or asserting in your test suite that a particular operation uses a specific number of queries.

---

## Query Timeout

### Why query timeout matters

Imagine a query that accidentally scans an entire table of 50 million rows because someone forgot a WHERE clause. Without a timeout, that query runs for minutes, holding a connection from the pool the entire time. Other requests queue up waiting for a connection. Your API becomes unresponsive. One bad query just took down your entire application.

A query timeout is a circuit breaker. If a query does not finish within the specified time, the database kills it and Stingerloom throws a `QueryTimeoutError`. The connection is freed and your application stays healthy.

### Global setting

```typescript
await em.register({
  // ...
  queryTimeout: 5000, // 5-second timeout for ALL queries
});
```

### Per-query override

Sometimes a specific query legitimately takes longer (e.g., a batch import or a complex report). You can override the global timeout for individual queries:

```typescript
const users = await em.find(User, {
  where: { isActive: true },
  timeout: 2000, // 2-second timeout for this specific query
});
```

### What happens at the database level

Stingerloom does not use JavaScript `setTimeout` to kill queries -- that would only cancel the wait on the client side while the query keeps running on the server, wasting database resources. Instead, it uses the database's own timeout mechanism:

| Database | SQL sent before the query |
|----------|--------------------------|
| MySQL | `SET max_execution_time = 5000` |
| PostgreSQL | `SET LOCAL statement_timeout = '5000ms'` |
| SQLite | Driver-level timeout (not SQL-based) |

For MySQL, `max_execution_time` is a per-statement hint measured in milliseconds. For PostgreSQL, `SET LOCAL` scopes the timeout to the current transaction, so it does not affect other connections or subsequent queries.

When the timeout fires, the database aborts the query and returns an error. Stingerloom catches that error and throws a `QueryTimeoutError` with the original SQL and the timeout value for easy debugging.

---

## Read Replica (Read/Write Splitting)

### Why read replicas matter

In most applications, reads vastly outnumber writes. A typical web app sends 80-90% SELECT queries and only 10-20% INSERT/UPDATE/DELETE. A single database server handling all of this becomes a bottleneck as traffic grows.

The solution is to create copies of your database (called replicas or slaves) that stay in sync with the primary (master) server. Your application sends all writes to the master and distributes reads across the replicas. Since you can add more replicas without changing your code, this lets you scale read capacity horizontally.

Think of it like a library. There is one original manuscript (the master) that authors can edit. But for readers, you create photocopies (replicas) and put them in reading rooms around the building. More readers? Open more reading rooms. The original manuscript is only accessed for writing.

### Configuration

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

### How routing works

Stingerloom automatically decides which server to use:

- **Writes** (`save`, `delete`, `update`, `insertMany`, `deleteMany`, `upsert`) always go to the master.
- **Reads** (`find`, `findOne`, `findWithCursor`, `count`, `explain`) are distributed across slaves using round-robin (replica1, then replica2, then replica1, and so on).
- **Failover:** If all slaves fail, reads automatically fall back to the master. Your application keeps working, just without the read scaling benefit.

### Understanding replication lag

There is a catch. When you write data to the master, it takes a small amount of time (typically 10-100 milliseconds, sometimes more under heavy load) for that change to propagate to the replicas. This delay is called **replication lag**.

Consider this sequence:

```typescript
// Step 1: Write to master
await em.save(User, { id: 1, name: "Updated Name" });

// Step 2: Read from replica (10ms later)
const user = await em.findOne(User, { where: { id: 1 } });
// user.name might still be "Old Name" because the replica has not caught up yet!
```

When you need to read the most recent data immediately after a write, use the `useMaster` option to force the read to go to the master:

```typescript
await em.save(User, { id: 1, name: "Updated Name" });

const user = await em.findOne(User, {
  where: { id: 1 },
  useMaster: true, // Bypass replicas, read directly from master
});
// user.name is guaranteed to be "Updated Name"
```

Use `useMaster` sparingly. If every read uses `useMaster`, you have eliminated the benefit of having replicas.

---

## Multi-DB Connections

Sometimes your application talks to more than one database. For example, your main MySQL database stores users and posts, while a separate PostgreSQL database stores analytics events. Stingerloom supports this with named connections.

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

The NestJS integration module supports named connections natively. Pass a connection name as the second argument to `forRoot()` and `forFeature()`:

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

When the connection name is omitted, `"default"` is used. This maintains full backward compatibility -- existing code that does not use multi-DB continues to work without changes.

Token helper functions are also available for advanced DI scenarios:

- `getEntityManagerToken(connectionName?)` -- Returns the EntityManager DI token
- `getOrmServiceToken(connectionName?)` -- Returns the OrmService DI token
- `makeInjectRepositoryToken(entity, connectionName?)` -- Returns the Repository DI token

---

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
  plugins?: StingerloomPlugin[];       // Auto-install plugins on register()
}
```

## CJS/ESM Dual Build

Stingerloom is published as a dual CJS/ESM package. Both module systems work automatically without extra configuration:

```typescript
// ESM (modern, recommended)
import { EntityManager } from "@stingerloom/orm";

// CommonJS (legacy)
const { EntityManager } = require("@stingerloom/orm");
```

Subpath exports are also dual:

| Subpath | Description |
|---------|-------------|
| `@stingerloom/orm` | Full ORM (EntityManager, decorators, dialects, etc.) |
| `@stingerloom/orm/core` | Core only (EntityManager, repositories, query builders) |
| `@stingerloom/orm/decorators` | Decorators only (@Entity, @Column, etc.) |
| `@stingerloom/orm/mysql` | MySQL dialect |
| `@stingerloom/orm/postgres` | PostgreSQL dialect |
| `@stingerloom/orm/sqlite` | SQLite dialect |
| `@stingerloom/orm/metadata` | Layered metadata (multi-tenancy) |
| `@stingerloom/orm/migration` | Migration system |
| `@stingerloom/orm/schema` | Decorator-free entity definitions |
| `@stingerloom/orm/errors` | Error classes |
| `@stingerloom/orm/plugin` | Plugin system |
| `@stingerloom/orm/nestjs` | NestJS integration module |
| `@stingerloom/orm/prisma-import` | Prisma schema importer |

The `exports` field in `package.json` maps each subpath to the appropriate `import` (ESM) or `require` (CJS) entry point. No configuration needed on your side. Granular subpath imports reduce bundle size when used with tree-shaking bundlers.

## Next Steps

- [Advanced Features](./advanced.md) -- Streaming, event system, query builder, N+1 detection
- [Multi-Tenancy](./multi-tenancy.md) -- Per-tenant data isolation
- [API Reference](./api-reference.md) -- Full method signatures
