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

### Option validation

`register()` validates the options before connecting. Missing or malformed required fields throw an `INVALID_CONFIG` error listing every problem at once, and — in multi-connection setups — naming the connection that failed. Unknown top-level keys are not silently ignored: a typo like `synchronise` logs a warning with the closest valid key (`Did you mean 'synchronize'?`), which matters when the options come from a ConfigService and TypeScript cannot catch the typo.

---

## synchronize Option

### Why does this exist?

When you add a new `@Column()` to an entity or create a brand new entity class, the database does not magically know about it. Someone or something needs to run `ALTER TABLE` or `CREATE TABLE` statements. The `synchronize` option automates this process during development so you do not have to write DDL by hand every time you change an entity.

### The four modes

| Value | Behavior | When to use |
|-------|----------|-------------|
| `false` | **No sync** (default) -- schema is never modified | Production. You control the schema through migrations. |
| `true` | **Full sync** -- creates, alters, and drops tables/columns to match entities | Development only. If you remove a column from an entity, the database column and all its data are dropped. |
| `"safe"` | **Safe sync** -- creates new tables and adds new columns; never alters, drops, or renames | Staging. New things appear, old things are left alone. No data loss. |
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

Safe mode reports what it declined to do, so an untouched schema never masquerades as a synchronized one:

```
WARN [SchemaRegistrar] [sync] safe mode skipped 2 schema change(s): 1 ALTER COLUMN, 1 DROP COLUMN (user.email, user.nickname). Apply them with synchronize.mode: true or a migration; set synchronize.logDDL: true to log each skipped statement.
```

With `logDDL: true`, each skipped statement is also logged in full:

```
INFO [SchemaRegistrar] [skipped: safe mode] ALTER TABLE `user` MODIFY COLUMN `email` VARCHAR(64) NOT NULL
INFO [SchemaRegistrar] [skipped: safe mode] ALTER TABLE user DROP COLUMN nickname
```

The case worth watching is a widened column: change `varchar(50)` to `varchar(255)` in the entity and safe mode leaves the database at 50, so the mismatch only surfaces later as a truncation error on INSERT. The warning is what tells you to run the migration.

**Dry run (`"dry-run"`) -- the preview:**
Same scenario again. The ORM prints the DDL to your console -- `ALTER TABLE user ADD COLUMN display_name varchar(255)` -- but does not execute it. You review the output, maybe adjust your migration file, and apply it yourself.

> **Warning:** Only use `synchronize: true` in development environments. In production, use [migrations](./migrations.md) instead.

### Options object form

The four bare values above couple three independent concerns: *resilience*, *destructive-change safety*, and *DDL visibility*. Pass an object to control them individually:

```typescript
await em.register({
  // ...
  synchronize: {
    mode: "safe",                  // base mode (true | "safe" | "dry-run")
    continueOnError: false,         // abort registerEntities() on first DDL failure
    failOnDestructiveChange: true,  // throw before DROP COLUMN / narrowing ALTER
    logDDL: true,                   // log every emitted DDL statement
  },
});
```

| Flag | Default | What it does |
|------|---------|--------------|
| `mode` | required | Base mode — same as the bare-form values. |
| `continueOnError` | `true` | When `false`, the first DDL failure throws `OrmError(SCHEMA_SYNC_FAILED)` instead of degrading to a warning. Use this when you'd rather see boot fail loudly than discover a half-migrated schema in the logs. |
| `failOnDestructiveChange` | `false` | When `true`, DROP COLUMN and narrowing ALTER (e.g. `varchar(255) → int`, `varchar(255) → varchar(64)`) throw `OrmError(SCHEMA_SYNC_DESTRUCTIVE_CHANGE)` before executing — useful as a production tripwire. (Tables are never dropped by synchronize, so there is nothing to guard there.) |
| `logDDL` | `false` | When `true`, every emitted DDL is logged at info level (CREATE TABLE, ALTER, RENAME, DROP, FULLTEXT INDEX, etc.). Under `"safe"` it also logs the statements the mode skipped, prefixed with `[skipped: safe mode]`. Pairs well with `"dry-run"` for full visibility. |

The bare forms (`true`, `"safe"`, `"dry-run"`, `false`) still work and normalize to the same defaults above — no migration is required.

### PostgreSQL ENUM types

On PostgreSQL an enum column is a reference to a named type, not a value list carried by the column, so a table cannot be created before the type exists. Synchronize provisions those types before it touches any table:

- A type named by an enum column but missing from the database is created (`CREATE TYPE "post_status" AS ENUM (...)`).
- A value the entity declares but the type does not have is appended (`ALTER TYPE ... ADD VALUE`), inserted at its declared position so `ORDER BY` on the column keeps matching the `enumValues` order.
- A value the database has but the entity no longer declares is **reported, never removed**. PostgreSQL cannot drop an enum value in place -- doing so means recreating the type and every column that uses it, which belongs in a migration you review.

Both operations are additive, so `"safe"` applies them: withholding them would break the CREATE TABLE and ADD COLUMN that safe mode does perform. `"dry-run"` logs the statements instead:

```
INFO [SchemaRegistrar] [dry-run] Would CREATE TYPE post_status_enum AS ENUM ('draft', 'published')
INFO [SchemaRegistrar] [dry-run] Would ALTER TYPE post_status_enum ADD VALUE IF NOT EXISTS 'archived' BEFORE 'published'
```

MySQL and SQLite need none of this -- MySQL carries the values in the column's own `ENUM(...)` type and SQLite stores the column as `TEXT`, so the regular CREATE/ALTER path already covers them.

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
  queryTimeout: 5000, // 5-second timeout for every read query
});
```

The timeout applies to the **read path** — `find()` and its variants, pagination, aggregates, and `stream()`. Writes (`save`, `updateMany`, `delete`, raw queries) are not bounded by it.

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
| MySQL | `SET SESSION max_execution_time = 5000` |
| MariaDB | `SET SESSION max_statement_time = 5` |
| PostgreSQL | `SET LOCAL statement_timeout = '5000ms'` |
| SQLite | `PRAGMA busy_timeout` (bounds lock waits, not statement runtime) |

MySQL's `max_execution_time` is milliseconds and applies to SELECT statements; MariaDB never implemented it — its equivalent is `max_statement_time` in seconds, and Stingerloom picks the right one from the server's version string, so `type: "mysql"` pointed at a MariaDB server works. Since `SET SESSION` outlives the query on a pooled connection, a per-query override is restored to the connection default afterwards. For PostgreSQL, `SET LOCAL` scopes the timeout to the transaction the read runs in, so it never leaks to other queries.

When the timeout fires, the database aborts the query and Stingerloom throws a `QueryTimeoutError` carrying the timeout value, with the driver's original error as `cause`.

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

### Replica health checks

In production, replicas can go down or fall behind. Stingerloom's `ReplicationRouter` supports automatic health monitoring that removes unhealthy replicas from the rotation and re-adds them when they recover.

```typescript
await em.register({
  type: "postgres",
  // ...
  replication: {
    master: { /* ... */ },
    slaves: [ /* ... */ ],
    healthCheck: {
      enabled: true,
      intervalMs: 5000,          // Check every 5 seconds (default)
      query: "SELECT 1",         // Health check SQL (default)
      failureThreshold: 3,       // Remove after 3 consecutive failures (default)
      recoveryThreshold: 2,      // Re-add after 2 consecutive successes (default)
    },
  },
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable automatic health checks |
| `intervalMs` | `number` | `5000` | Milliseconds between checks |
| `query` | `string` | `"SELECT 1"` | SQL query used to verify the replica is alive |
| `failureThreshold` | `number` | `3` | Consecutive failures before marking a replica as down |
| `recoveryThreshold` | `number` | `2` | Consecutive successes before marking a recovered replica as available |

When a replica fails the health check `failureThreshold` times in a row, it is removed from the round-robin rotation. Reads automatically fall back to remaining healthy replicas or the master. When the failed replica passes `recoveryThreshold` consecutive checks, it is added back.

Health checks are stopped automatically during `propagateShutdown()`.

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

Each connection serves only the entities listed in its own `entities` array. Using an entity on the wrong connection — say `primaryEm.find(Log)` — throws `EntityMetadataNotFoundError` naming the connection and the fix, instead of reaching the database and dying later with a raw `no such table` error (the schema sync correctly skips out-of-scope entities, so that table never existed on this connection). An empty `entities` array keeps the legacy unscoped behavior where the connection serves every known entity. Two things stay allowed on a scoped connection: inheritance relatives of a registered class (querying an STI/TPT child of a registered parent — or the parent of registered children — is a polymorphic query against tables the connection owns), and cascade traversal, which may legitimately reach a relation target outside an `attach()`ed subset scope.

### Multi-DB in NestJS

The NestJS integration module supports named connections natively. Pass a connection name as the second argument to `forRoot()` and `forFeature()`:

```typescript
// app.module.ts
@Module({
  imports: [
    StingerloomOrmModule.forRoot(mysqlOptions),                  // "default"
    StingerloomOrmModule.forRoot(postgresOptions, "analytics"),  // named
    UsersModule,
    AnalyticsModule,
  ],
})
export class AppModule {}

// analytics.module.ts
@Module({
  imports: [StingerloomOrmModule.forFeature([Event], "analytics")],
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

## Naming Strategy

The `namingStrategy` option controls how the ORM derives database identifiers (table names, column names, FK/index names) from your TypeScript class and property names. Without a strategy, the ORM uses `DefaultNamingStrategy`, which preserves column names verbatim and derives FK names via SHA1 hashing.

### Built-in: `SnakeNamingStrategy`

Converts `camelCase` property names into `snake_case` database columns — the convention in most PostgreSQL/MySQL codebases.

```typescript
import { SnakeNamingStrategy } from "@stingerloom/orm";

await em.register({
  type: "postgres",
  // ...
  namingStrategy: new SnakeNamingStrategy(),
});
```

With this strategy:

| TypeScript | Database |
|---|---|
| `class UserProfile` | `user_profile` |
| `firstName: string` | `first_name` |
| `@ManyToOne(() => Author) author!: Author` | FK column `author_id` |

The transformation is applied during entity registration **and** during result deserialization (DB column → entity property), so your code never touches `snake_case`.

### Implementing a Custom Strategy

Implement the `NamingStrategy` interface when you have a pre-existing schema that does not match either convention, or when you need organization-specific FK/index prefixes. The interface covers every identifier the ORM generates:

```typescript
import { NamingStrategy } from "@stingerloom/orm";

class UppercaseNamingStrategy implements NamingStrategy {
  tableName(className: string): string {
    // Users → USERS
    return className.toUpperCase() + "S";
  }

  columnName(propertyName: string): string {
    // firstName → FIRST_NAME
    return propertyName.replace(/([A-Z])/g, "_$1").toUpperCase();
  }

  joinColumnName(propertyName: string, referencedColumnName: string): string {
    // author + id → AUTHOR_ID
    return `${propertyName.toUpperCase()}_${referencedColumnName.toUpperCase()}`;
  }

  foreignKeyName(table: string, column: string, referencedTable: string): string {
    return `FK_${table}_${column}_${referencedTable}`.slice(0, 63);
  }

  uniqueIndexName(table: string, columns: string[]): string {
    return `UQ_${table}_${columns.join("_")}`;
  }

  indexName(table: string, column: string): string {
    return `IX_${table}_${column}`;
  }

  compositeIndexName(table: string, columns: string[]): string {
    return `IX_${table}_${columns.join("_")}`;
  }

  jsonIndexName(
    table: string,
    column: string,
    pathSegments: ReadonlyArray<string | number>,
    using: "gin" | "btree",
  ): string {
    const path = pathSegments.length ? `_${pathSegments.join("_")}` : "";
    return `IX_JSON_${table}_${column}${path}_${using}`;
  }
}

await em.register({
  // ...
  namingStrategy: new UppercaseNamingStrategy(),
});
```

### Method Reference

| Method | Called from | Purpose |
|---|---|---|
| `tableName(className)` | Entity registration | Default table name for `@Entity()` without an explicit `name`. |
| `columnName(propertyName)` | Column registration | Default DB column name for `@Column()` without an explicit `name`. |
| `joinColumnName(propertyName, refPk)` | `@ManyToOne`/`@OneToOne` | FK column name when no explicit `joinColumn` option is given. |
| `foreignKeyName(table, column, refTable)` | DDL generation | Name for the `CONSTRAINT ... FOREIGN KEY` clause. Keep ≤ 63 chars for PostgreSQL. |
| `uniqueIndexName(table, columns)` | `@UniqueIndex` | Name for unique composite indexes. |
| `indexName(table, column)` | `@Index` on property | Name for a single-column index. |
| `compositeIndexName(table, columns)` | `@Index` on class | Name for a multi-column index. |
| `jsonIndexName(table, column, path, using)` | `@JsonIndex` | Name for a JSON path expression index (PostgreSQL). |

### Subclassing `DefaultNamingStrategy`

Extend the built-in strategy when you only need to override one or two methods:

```typescript
import { DefaultNamingStrategy } from "@stingerloom/orm";

class PrefixedFKStrategy extends DefaultNamingStrategy {
  foreignKeyName(table: string, column: string, refTable: string): string {
    return `fk_${table}__${refTable}__${column}`.slice(0, 63);
  }
}
```

Only the overridden method changes; all other identifiers continue to use the default convention.

### Gotchas

- **Naming strategy is applied at registration time.** Changing the strategy on an already-live table requires a migration, not a code change.
- **Identifier length matters.** PostgreSQL truncates identifiers at 63 bytes. `DefaultNamingStrategy` has a hash-fallback path to stay within that limit — replicate it in your custom strategy or your migration will silently rename constraints.
- **The strategy does not control constraint-drop SQL.** It only produces names; if you change strategies after tables exist, old constraints keep their original names until you migrate them.

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
  synchronize?: boolean | "safe" | "dry-run" | SynchronizeOptions;  // mode, or object { mode, continueOnError, failOnDestructiveChange, logDDL } (default: false)
  schema?: string;               // PostgreSQL schema (default: "public")
  charset?: string;              // MySQL charset
  datesStrings?: boolean;        // Return MySQL dates as strings
  queryTimeout?: number;         // Global query timeout (ms)
  pool?: PoolOptions;            // Connection pool settings
  retry?: RetryOptions;          // Connection retry settings
  logging?: boolean | LoggingOptions;  // Query logging
  replication?: ReplicationConfig;     // Read Replica settings
  namingStrategy?: NamingStrategy;     // Custom FK/index naming strategy
  tenantStrategy?: "search_path" | "schema_qualified" | "tenant_column" | "database"; // tenant isolation strategy (default: "search_path")
  tenantColumnName?: string;           // tenant_column strategy: discriminator column name (default: "tenant_id")
  tenantColumnType?: "varchar" | "uuid" | "int" | "bigint"; // tenant_column strategy: column type (default: "varchar")
  tenantColumnLength?: number;         // tenant_column strategy: varchar length (default: 64)
  tenantOnMissingContext?: "throw" | "warn" | "allow"; // tenant_column strategy: read/update/delete policy when no tenant context is active (default: "warn")
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
