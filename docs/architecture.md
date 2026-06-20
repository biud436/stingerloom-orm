# Architecture

This document walks through how Stingerloom ORM is structured internally. If you've used `em.find()` or `em.save()` and wondered what's happening behind the scenes, start here. Reading the [Getting Started](./getting-started.md) guide first is recommended.

## Following a Query Through the System

The best way to understand the architecture is to trace a real query. Suppose you write:

```typescript
const users = await em.find(User, { where: { isActive: true }, relations: ["posts"] });
```

What happens inside the ORM?

### Step 1: Look Up the Entity Definition

When your application started, `@Entity()` and `@Column()` decorators on the `User` class registered metadata -- table name, column list, relation definitions -- into a metadata store. Now the ORM needs to read that metadata back.

`RelationMetadataResolver` is the module responsible for this lookup. It answers questions like "what table does `User` map to?" and "what are the ManyToOne relations?".

### Step 2: Build the SQL

The query builder takes the metadata and your `FindOption` and assembles a parameterized SQL query. Stingerloom has two query builders:

- **`RawQueryBuilder`** -- Low-level, free-form SQL builder. Used internally by `find()`, `save()`, and other EntityManager methods.
- **`SelectQueryBuilder`** -- Type-safe, entity-aware builder created via `em.createQueryBuilder(User, "u")`. Provides `keyof T` auto-completion for column names.

For a simple `find()` call, the ORM uses `RawQueryBuilder` internally to produce:

```sql
SELECT "id", "name", "email" FROM "user" WHERE "isActive" = $1
```

Two important things happen here:

- **Values** like `true` are never placed in the SQL string directly. They become `$1`, `$2` parameters -- this prevents SQL injection.
- **Table and column names** are escaped by the database driver. MySQL wraps them in `` `backticks` ``, PostgreSQL uses `"double quotes"`.

If the application is running in a multi-tenant context, `TenantQueryStrategy` may change the table name. With `schema_qualified` strategy, `"user"` becomes `"acme_corp"."user"`. With the default `search_path` strategy, the table name stays plain and the ORM sets `search_path` in a transaction instead.

### Step 3: Decide How to Execute

Not all queries need a full transaction. The EntityManager makes a decision:

| Situation | What happens |
|-----------|-------------|
| Already inside `@Transactional` | Reuse the existing session |
| PostgreSQL tenant + `search_path` strategy | Wrap in a transaction (needed for `SET LOCAL search_path`) |
| Query has a timeout (PostgreSQL) | Wrap in a transaction (needed for `SET LOCAL statement_timeout`) |
| Everything else (most reads) | Lightweight path -- connect, query, close. No `BEGIN`/`COMMIT` |

This means a simple `em.find(User)` with no tenant context skips the transaction entirely, saving multiple network round-trips.

### Step 4: Transform the Result

The database returns raw rows like `{ id: 1, name: "Alice", isActive: true }`. The ORM needs to turn these into proper `User` instances.

`ResultTransformer` handles this: it deserializes rows into typed objects, populates eager relations from JOIN results, and wraps lazy relations in proxy objects that load data on first access.

### Step 5: Return

You get back a `User[]` array with fully typed entities, relations populated, and proxies in place for lazy loading.

> **Hint** Write operations (`save`, `delete`, `upsert`) always go through a transaction -- there is no lightweight path for writes.

## Why the Code is Split Into Modules

An ORM does many things: connecting to databases, building SQL, managing transactions, loading relations, generating DDL, handling multi-tenancy. If all of this lived in one file, it would be unreadable and impossible to test.

Stingerloom splits these concerns into directories under `src/`, with a strict rule: **dependencies only flow downward**. A lower layer never imports from a higher layer.

| Layer | Directory | What it does |
|-------|-----------|--------------|
| Integration | `integration/` | Connects the ORM to frameworks (NestJS) and tools (Prisma import) |
| Core | `core/` | EntityManager and its handlers -- the main logic |
| Connection | `DatabaseClient.ts` | Holds database connections, shared across the application |
| Scanner | `scanner/` | Reads `@Entity` / `@Column` decorators and builds the metadata registry |
| Decorators | `decorators/` | The decorator functions themselves (`@Entity`, `@Column`, `@ManyToOne`, etc.) |
| Metadata | `metadata/` | The layered metadata store that powers multi-tenancy |
| Dialects | `dialects/` | Database-specific code -- one subfolder per database |
| Foundation | `types/`, `errors/`, `utils/` | Shared types, error classes, and the logger |

Why does this layering matter? If you're fixing a MySQL-specific bug, you only need to look at `src/dialects/mysql/`. If you're adding a new decorator, you work in `src/decorators/` and `src/scanner/`. The layers keep changes localized.

## EntityManager is Not a Monolith

When EntityManager was first written, it handled everything -- queries, relations, cascades, aggregation, schema sync. As features grew, it became too large to reason about.

The solution was to extract each responsibility into a **handler class**:

| Handler | Why it exists |
|---------|---------------|
| `RelationMetadataResolver` | Decouples metadata reading from query execution |
| `SchemaRegistrar` | Keeps DDL generation separate from runtime queries |
| `RelationLoader` | Encapsulates batch loading logic that prevents N+1 queries |
| `CascadeHandler` | Isolates the recursive cascade save/delete logic |
| `AggregateQueryHandler` | COUNT/SUM/AVG/MIN/MAX have their own SQL patterns |
| `ExplainQueryHandler` | Each database returns EXPLAIN in a different format |
| `ReplicationManager` | Read replica routing is independent of query logic |
| `TenantQueryStrategy` | Multi-tenant table qualification is a separate concern |

All handlers depend on an `EntityManagerInternals` interface, not on the EntityManager class directly. This prevents circular imports and makes it easy to test each handler in isolation -- you can mock the interface without setting up a full EntityManager.

```typescript
// EntityManager wires the handlers at construction time
private readonly relationLoader = new RelationLoader(this.resolver, this._ctx);
private readonly aggregateHandler = new AggregateQueryHandler(this.resolver, this._ctx);
```

## One Interface, Three Databases

MySQL, PostgreSQL, and SQLite all behave differently. Rather than sprinkling `if (mysql) ... else if (postgres) ...` throughout the codebase, Stingerloom defines a single `ISqlDriver` interface that each database implements.

| Aspect | MySQL | PostgreSQL | SQLite |
|--------|-------|------------|--------|
| Identifier wrapping | `` `backticks` `` | `"double quotes"` | `"double quotes"` |
| Primary key generation | AUTO_INCREMENT | SERIAL / RETURNING | INTEGER PRIMARY KEY |
| Upsert syntax | ON DUPLICATE KEY UPDATE | ON CONFLICT DO UPDATE | ON CONFLICT DO UPDATE |
| Query timeout | SET SESSION max_execution_time | SET LOCAL statement_timeout | Driver-level |
| Schema support | -- | `"schema"."table"` | -- |

When you change `type: "mysql"` to `type: "postgres"` in your configuration, the EntityManager instantiates a different driver. Your application code stays the same.

> **Hint** To add support for a new database, implement `ISqlDriver` in a new subfolder under `src/dialects/`. The interface covers DDL operations, type mapping, upsert syntax, identifier escaping, and EXPLAIN output.

### How SQL Injection is Prevented

Every query goes through two safety rules:

1. **User-provided values** are parameter-bound. They appear as `$1`, `$2` in the query, never as inline strings.
2. **Table and column names** are escaped by the driver's `wrapIdentifier()` method.

Here is a concrete example of what the code looks like internally. When the ORM builds an INSERT query, it uses `sql-template-tag` to construct a parameterized query:

```typescript
// Internal code (simplified from EntityManager.saveInternal)
const insertSql = sql`
  INSERT INTO ${raw(this.wrapTable("user"))}
  (${join(columns, ", ")})
  VALUES (${join(values, ", ")})
`;
```

This produces:

```
SQL:        INSERT INTO "user" ("name", "email") VALUES ($1, $2)
Parameters: ["John Doe", "john@example.com"]
```

The `raw()` wrapper is used only for pre-escaped identifiers (table and column names that have already been through `wrapIdentifier()`). User values like `"John Doe"` go through `sql-template-tag`'s template literal, which automatically extracts them into the parameter array. There is no code path that concatenates user input into a SQL string.

This two-rule system ensures that even if an attacker passes `'; DROP TABLE users; --` as a name value, it ends up as a harmless parameter value, never as executable SQL.

## Multi-Tenancy: Layers Like Docker

In a SaaS application, you need to keep each customer's data completely separate. Stingerloom solves this with a **layered metadata system** -- the same concept Docker uses for filesystem layers (OverlayFS).

There is a **Public layer** at the bottom that holds the base schema -- all your `@Entity` and `@Column` definitions. It is read-only at runtime.

On top of it, each tenant gets its own **Tenant layer**. When the ORM reads metadata, it checks the tenant layer first. If nothing is found, it falls back to the Public layer. Writes always go to the tenant layer (Copy-on-Write).

### Why AsyncLocalStorage?

In a web server, many requests run concurrently in the same Node.js process. If you stored the current tenant in a global variable, Request A (tenant "acme") and Request B (tenant "globex") would overwrite each other.

`AsyncLocalStorage` solves this by giving each async execution chain its own isolated storage. When a request enters your middleware and you call `MetadataContext.run("acme", callback)`, every function called from that callback -- no matter how deeply nested, no matter how many `await` points it crosses -- sees "acme" as the current tenant. A concurrent request running `MetadataContext.run("globex", callback)` sees "globex" in its own isolated context. The two never interfere.

This is the same mechanism that logging libraries use for request IDs and tracing libraries use for span correlation. It is built into Node.js and has zero performance overhead compared to a global variable.

```typescript
// Request A: queries acme_corp's data
MetadataContext.run("acme_corp", async () => {
  await em.find(User);
  // ORM reads metadata from acme_corp's tenant layer
  // Falls back to public layer for anything not overridden
});

// Request B (concurrent): queries globex's data, completely isolated
MetadataContext.run("globex", async () => {
  await em.find(User);
  // Completely separate execution context -- no shared state with Request A
});
```

For PostgreSQL, the ORM can physically isolate tenants using separate schemas. `TenantMigrationRunner` creates these schemas automatically by cloning the public schema's table structure. See [Multi-Tenancy](./multi-tenancy.md) for the full guide, including the two query strategies.

## Transactions: When and Why

Every `save()`, `delete()`, and `upsert()` runs inside a transaction. The lifecycle is straightforward:

1. Get a connection from the pool.
2. `BEGIN`.
3. Execute one or more queries.
4. `COMMIT` on success, `ROLLBACK` on error.
5. Return the connection to the pool.

The `@Transactional` decorator stores the active session in `AsyncLocalStorage`. If you call `em.save()` twice inside a `@Transactional` method, both operations share the same transaction -- one `BEGIN`, one `COMMIT`.

```typescript
@Transactional()
async transferFunds(fromId: number, toId: number, amount: number) {
  await this.em.save(Account, { id: fromId, balance: from.balance - amount });
  await this.em.save(Account, { id: toId, balance: to.balance + amount });
  // Both saves share one transaction
  // COMMIT on return, ROLLBACK if an exception is thrown
}
```

Read-only queries (`find`, `findOne`, `count`, `explain`) skip transactions when possible. No `BEGIN`, no `COMMIT` -- just connect, query, close. This optimization reduces read latency significantly.

When a transaction hits a deadlock (two transactions each waiting for the other's lock), the database kills one of them. With `retryOnDeadlock: true` in `TransactionOptions`, the ORM catches the deadlock error and re-executes the entire callback. See [Transactions](./transactions.md) for the full guide.

## Schema Sync and Migrations

When you call `em.register()`, the `SchemaRegistrar` compares your entity definitions against the live database and optionally updates the schema.

| `synchronize` value | What it does | When to use |
|---------------------|-------------|-------------|
| `true` | Creates, alters, and drops tables/columns to match entities | Development only |
| `"safe"` | Creates and adds, but never drops | Staging |
| `"dry-run"` | Logs DDL without executing | Reviewing changes |
| `false` (default) | Does nothing | Production |

> **Warning** `synchronize: true` can drop columns and tables. Never use it in production. Use [Migrations](./migrations.md) instead.

For production, `SchemaDiff` compares the live DB schema against your entity metadata and generates a migration file. You review the migration, then apply it explicitly. This gives you full control over what changes hit your production database.

## NestJS Integration

The NestJS module follows the familiar `forRoot` / `forFeature` pattern:

- **`forRoot(options)`** creates a global `EntityManager`. It connects on startup and shuts down gracefully when the application stops.
- **`forFeature([User, Post])`** registers repositories. Services inject them with `@InjectRepository(User)`.

For applications that talk to multiple databases, pass a `connectionName`:

```typescript
StingerloomOrmModule.forRoot(mysqlOptions)                // "default"
StingerloomOrmModule.forRoot(pgOptions, "analytics")      // named
StingerloomOrmModule.forFeature([Event], "analytics")     // binds to "analytics"

// In a service:
@InjectRepository(Event, "analytics") private readonly eventRepo: BaseRepository<Event>
@InjectEntityManager("analytics") private readonly em: EntityManager
```

> **Hint** When `connectionName` is omitted, it defaults to `"default"`. Existing single-DB code works without changes.

## Directory Map

```
src/
├── core/                  EntityManager, handlers, query builders
│   ├── EntityManager.ts           The main entry point for all CRUD
│   ├── EntityManagerInternals.ts  Interface that handlers depend on
│   ├── RelationMetadataResolver.ts  Entity/relation metadata lookup
│   ├── SchemaRegistrar.ts         Schema sync on startup
│   ├── RelationLoader.ts          Batch relation loading (N+1 prevention)
│   ├── CascadeHandler.ts          Cascade save/delete
│   ├── AggregateQueryHandler.ts   COUNT/SUM/AVG/MIN/MAX
│   ├── ExplainQueryHandler.ts     EXPLAIN query parsing
│   ├── TenantQueryStrategy.ts     search_path vs schema_qualified
│   ├── SelectQueryBuilder.ts      Type-safe, entity-aware query builder
│   ├── BaseRawQueryBuilder.ts     Low-level SQL query construction
│   ├── RawQueryBuilder.ts         Free-form SQL (UNION, CTE, window functions)
│   ├── SchemaGenerator.ts         DDL generation
│   └── SchemaDiff.ts              Live DB <-> entity metadata comparison
├── decorators/            @Entity, @Column, @ManyToOne, hooks, validation
├── dialects/              Database-specific implementations
│   ├── SqlDriver.ts               ISqlDriver interface (all drivers implement this)
│   ├── TransactionSessionManager.ts  Connection + transaction lifecycle
│   ├── ReplicationRouter.ts       Read replica routing
│   ├── mysql/                     MySQL driver
│   ├── postgres/                  PostgreSQL driver + TenantMigrationRunner
│   └── sqlite/                    SQLite driver
├── metadata/              Layered metadata primitives
│   ├── MetadataContext.ts         AsyncLocalStorage-based tenant scoping
│   └── MetadataLayer.ts           Individual layer storage
├── scanner/               Decorator pipeline; `MetadataLayerRegistry` lives here
│   └── MetadataScanner.ts         Decorator-time registry (canonical)
├── migration/             MigrationRunner + CLI (`npx stingerloom`)
├── schema/                Decorator-free EntitySchema API
├── integration/           NestJS module, Prisma importer
├── types/                 Shared types (QueryResult, EntityResult, ColumnType)
├── errors/                OrmError + 11 specific error codes
├── utils/                 Logger, ReflectManager
├── DatabaseClient.ts      Connection singleton
└── index.ts               Public API exports
```

## Next Steps

- [Getting Started](./getting-started.md) -- Install and run your first CRUD in 5 minutes
- [Entities](./entities.md) -- Define tables with decorators, step by step
- [Configuration](./configuration.md) -- Pooling, timeouts, Read Replica, and all connection options
- [Multi-Tenancy](./multi-tenancy.md) -- Layered metadata, schema isolation, and query strategies
- [API Reference](./api-reference.md) -- Full method signatures
