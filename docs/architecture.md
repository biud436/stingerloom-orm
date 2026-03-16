# Architecture

This document explains the internal architecture of Stingerloom ORM — how modules are organized, how data flows through the system, and why things are structured the way they are.

## High-Level Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Your Application                                           │
│  em.find(User, { where: { id: 1 }, relations: ["posts"] }) │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  EntityManager (src/core/)                                   │
│  Orchestrates queries, transactions, result transformation   │
│                                                              │
│  ┌──────────────┐ ┌──────────────┐ ┌───────────────────┐    │
│  │ RelationLoader│ │ CascadeHandler│ │ AggregateHandler │    │
│  └──────────────┘ └──────────────┘ └───────────────────┘    │
│  ┌──────────────┐ ┌──────────────┐ ┌───────────────────┐    │
│  │ExplainHandler│ │SchemaRegistrar│ │ RelationResolver  │    │
│  └──────────────┘ └──────────────┘ └───────────────────┘    │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────┐  ┌───────────────┐  ┌─────────────────────┐
│ Metadata Layer  │  │ Driver Layer  │  │ Transaction Layer   │
│ (src/metadata/) │  │ (src/dialects/)│  │ (SessionManager)    │
│                 │  │               │  │                     │
│ Layered Store   │  │ ISqlDriver    │  │ BEGIN → query →     │
│ MetadataContext │  │ ┌───────────┐ │  │ COMMIT / ROLLBACK   │
│ (AsyncLocal     │  │ │ MySQL     │ │  │                     │
│  Storage)       │  │ │ Postgres  │ │  │ Connection Pool     │
│                 │  │ │ SQLite    │ │  │ Replication Router  │
└─────────────────┘  │ └───────────┘ │  └─────────────────────┘
                     └───────┬───────┘
                             ▼
                     ┌───────────────┐
                     │   Database    │
                     └───────────────┘
```

## Module Dependency Hierarchy

Dependencies flow **downward only**. Lower layers never depend on upper layers.

```
Layer 7  │  integration/     NestJS module, Prisma import
         │                   Depends on: core/
─────────┤
Layer 6  │  core/            EntityManager, handlers, query builders
         │                   Depends on: dialects/, scanner/, metadata/, decorators/
─────────┤
Layer 5  │  DatabaseClient   Connection singleton, manages IConnector instances
         │                   Depends on: dialects/
─────────┤
Layer 4  │  scanner/         EntityScanner, ColumnScanner, relation scanners
         │                   Depends on: metadata/, decorators/
─────────┤
Layer 3  │  decorators/      @Entity, @Column, @ManyToOne, etc.
         │  metadata/        LayeredMetadataStore, MetadataContext
         │                   Depends on: utils/, types/
─────────┤
Layer 2  │  dialects/        ISqlDriver, TransactionSessionManager
         │                   Depends on: types/, errors/
─────────┤
Layer 1  │  types/           Shared types (QueryResult, EntityResult, ColumnType)
         │  errors/          OrmError, OrmErrorCode
         │  utils/           Logger, ReflectManager
```

Circular dependencies are prevented by the `EntityManagerInternals` interface — extracted handler classes (RelationLoader, CascadeHandler, etc.) depend on this interface, not on EntityManager directly.

## Core: EntityManager and Handlers

EntityManager is the main entry point for all database operations. Instead of being a monolithic class, its responsibilities are split into specialized handlers:

```
EntityManager
 ├── RelationMetadataResolver  — Reads entity/relation metadata from scanner layers
 ├── SchemaRegistrar           — DDL generation and schema sync on startup
 ├── RelationLoader            — OneToMany, ManyToMany, OneToOne batch loading
 ├── CascadeHandler            — Cascade save/delete across relations
 ├── AggregateQueryHandler     — COUNT, SUM, AVG, MIN, MAX
 ├── ExplainQueryHandler       — EXPLAIN query + result parsing
 ├── ReplicationManager        — Read replica routing
 └── TenantQueryStrategy       — Table name qualification per tenant
```

All handlers receive an `EntityManagerInternals` adapter instead of the EntityManager itself. This keeps the dependency graph clean and makes each handler independently testable.

### Query Execution Pipeline

```
em.find(User, { where: { id: 1 } })
   │
   ▼
1. Resolve metadata
   RelationMetadataResolver.resolveEntityMetadata(User)
   → { name: "User", columns: [...], relations: [...] }
   │
   ▼
2. Build SQL
   RawQueryBuilder.select([...]).from(wrapTable("User")).where([...])
   → SELECT "id", "name" FROM "User" WHERE "id" = $1
   │                          ▲
   │               TenantQueryStrategy may prefix:
   │               "tenant_a"."User" (schema_qualified)
   ▼
3. Execute
   executeReadOnly(session => session.query(sql))
   │
   ├── Existing @Transactional session? → reuse it
   ├── Needs transaction? (tenant/timeout) → executeInTransaction
   └── Otherwise → lightweight path (connect → query → close)
   │
   ▼
4. Transform results
   ResultTransformer.toEntities(User, queryResult)
   → Deserialize rows → inject lazy proxies → load eager relations
   │
   ▼
5. Return T[]
```

### Read-Only vs Transactional Paths

```
                    ┌─ find, findOne, count, explain, ...
                    │
 Is there an        │  YES
 existing session?──┼──────► Reuse session (no new connection)
 (@Transactional)   │
                    │  NO
                    ▼
              ┌─────────────┐
              │ PostgreSQL + │  YES   ┌──────────────────────────┐
              │ tenant +     ├───────►│ executeInTransaction     │
              │ search_path? │        │ BEGIN → SET LOCAL → query│
              └──────┬──────┘        │ → COMMIT                 │
                     │ NO             └──────────────────────────┘
                     ▼
              ┌─────────────┐
              │ timeout      │  YES   ┌──────────────────────────┐
              │ (PG)?        ├───────►│ executeInTransaction     │
              └──────┬──────┘        │ (SET LOCAL statement_    │
                     │ NO             │  timeout needs txn)      │
                     ▼                └──────────────────────────┘
              ┌──────────────────────────┐
              │ Lightweight read-only    │
              │ connect → query → close  │
              │ (no BEGIN/COMMIT)        │
              └──────────────────────────┘
```

Write operations (`save`, `delete`, `update`, `upsert`) always go through `executeInTransaction`.

## Metadata: Layered System

Inspired by Docker's OverlayFS. Each tenant gets its own metadata layer stacked on top of a shared public layer.

```
Read path (resolveAll):

  ┌───────────────────────────────────┐
  │ Tenant Layer "acme_corp"          │  ← Checked first (Copy-on-Write)
  │ Overrides: custom column options  │
  └────────────────┬──────────────────┘
                   │ fallback
  ┌────────────────▼──────────────────┐
  │ Public Layer (read-only)          │  ← Base schema from @Entity decorators
  │ All entity definitions            │
  └───────────────────────────────────┘

Write path:
  Always writes to the current tenant layer.
  Public layer is never modified at runtime.
```

### Concurrency Safety

`MetadataContext` uses Node.js `AsyncLocalStorage` to maintain tenant context per async call chain:

```typescript
// Each HTTP request gets its own isolated context
MetadataContext.run("acme_corp", async () => {
  // All async operations here see tenant = "acme_corp"
  await em.find(User);  // → queries acme_corp schema
  await em.save(Post, { title: "Hello" });  // → writes to acme_corp schema
});

// Concurrent request — completely isolated
MetadataContext.run("globex", async () => {
  await em.find(User);  // → queries globex schema
});
```

No shared mutable state. No race conditions. Each request carries its own tenant identity through the entire async call stack.

## Dialects: Driver Abstraction

All three databases implement the same `ISqlDriver` interface. The EntityManager never writes database-specific SQL — it delegates to the driver.

```
ISqlDriver
 │
 ├── MySqlDriver
 │   ├── Identifier wrapping: `backticks`
 │   ├── PK generation: AUTO_INCREMENT
 │   ├── Upsert: ON DUPLICATE KEY UPDATE
 │   └── Timeout: SET SESSION max_execution_time
 │
 ├── PostgresDriver
 │   ├── Identifier wrapping: "double quotes"
 │   ├── PK generation: SERIAL / RETURNING
 │   ├── Upsert: ON CONFLICT DO UPDATE
 │   ├── Timeout: SET LOCAL statement_timeout
 │   └── Schema support: "schema"."table"
 │
 └── SqliteDriver
     ├── Identifier wrapping: "double quotes"
     ├── PK generation: INTEGER PRIMARY KEY
     ├── Upsert: ON CONFLICT DO UPDATE
     └── Single-file database (no pooling)
```

### SQL Injection Prevention

Two rules enforced throughout the codebase:

1. **User values** → Always parameter-bound via `sql-template-tag`
2. **Identifiers** (table names, column names) → Always escaped via `driver.wrapIdentifier()` / `escapeIdentifier()`

```typescript
// Parameter binding (values)
sql`SELECT * FROM ${raw(this.wrapTable(tableName))} WHERE ${raw(this.wrap("id"))} = ${userId}`
//                  ↑ escaped identifier                ↑ escaped identifier        ↑ bound parameter
```

## Transactions

```
TransactionSessionManager
 │
 ├── connect()           → Acquire connection from pool
 ├── startTransaction()  → BEGIN (+ SET LOCAL search_path for PG tenants)
 ├── query(sql)          → Execute parameterized SQL
 ├── commit()            → COMMIT
 ├── rollback()          → ROLLBACK (on error)
 ├── savepoint(name)     → SAVEPOINT (nested transactions)
 └── close()             → Release connection back to pool
```

The `@Transactional` decorator stores the session in `AsyncLocalStorage`. Any EntityManager call within that scope reuses the same session — no extra connections, no nested transactions unless explicitly requested.

## Schema Synchronization

On startup, `SchemaRegistrar.registerEntities()` compares entity metadata against the live database:

```
@Entity + @Column metadata
         │
         ▼
  SchemaRegistrar
         │
         ├── synchronize: true      → CREATE/ALTER/DROP to match
         ├── synchronize: "safe"    → CREATE/ADD only, never DROP
         ├── synchronize: "dry-run" → Log DDL without executing
         └── synchronize: false     → Skip entirely
         │
         ▼
  SchemaGenerator → ISqlDriver DDL methods
         │
         ▼
  Database schema updated
```

For production, use `SchemaDiff` + `MigrationGenerator` to produce migration files instead of auto-sync.

## Multi-Tenancy: Full Picture

```
HTTP Request (X-Tenant-Id: acme_corp)
         │
         ▼
  TenantMiddleware
  MetadataContext.run("acme_corp", () => next())
         │
         ▼
  TenantSchemaService.ensureSchema("acme_corp")   ← DDL path
  PostgresTenantMigrationRunner                       (driver-level,
    → CREATE SCHEMA IF NOT EXISTS "acme_corp"          independent of
    → CREATE TABLE "acme_corp"."users"                 query strategy)
      (LIKE "public"."users" INCLUDING ALL)
         │
         ▼
  Controller → Service → EntityManager.find(User)  ← DML path
         │
         ▼
  TenantQueryStrategy decides table name:
    search_path:      → "users"            (SET LOCAL search_path in txn)
    schema_qualified: → "acme_corp"."users" (no txn needed)
         │
         ▼
  Query executes against correct tenant data
```

Key insight: **DDL provisioning and DML routing are completely independent**. `TenantMigrationRunner` always uses driver-level raw SQL. `TenantQueryStrategy` only affects how EntityManager constructs DML queries. Changing the strategy requires zero changes to schema provisioning code.

## Integration: NestJS

```
StinglerloomOrmModule.forRoot(options)
 │
 ├── StingerloomOrmCoreModule (global)
 │   ├── Provides: EntityManager (singleton per connection)
 │   └── Lifecycle: OnModuleInit → register(), OnModuleDestroy → propagateShutdown()
 │
 └── StinglerloomOrmModule.forFeature([User, Post])
     └── Provides: BaseRepository<User>, BaseRepository<Post>
         Injected via: @InjectRepository(User)

Multi-DB:
  forRoot(mysqlOpts)                    → "default" connection
  forRoot(pgOpts, "analytics")          → "analytics" connection
  forFeature([Event], "analytics")      → Repository bound to "analytics"
  @InjectEntityManager("analytics")     → Inject specific EM
```

## Directory Map

```
src/
├── core/                  # EntityManager + handlers + query builders
│   ├── EntityManager.ts         Main CRUD entry point
│   ├── EntityManagerInternals.ts  Interface for handler dependency injection
│   ├── RelationMetadataResolver.ts  Metadata lookup
│   ├── SchemaRegistrar.ts         DDL sync on startup
│   ├── RelationLoader.ts          Batch relation loading (prevents N+1)
│   ├── CascadeHandler.ts          Cascade save/delete
│   ├── AggregateQueryHandler.ts   COUNT/SUM/AVG/MIN/MAX
│   ├── ExplainQueryHandler.ts     EXPLAIN parsing
│   ├── TenantQueryStrategy.ts     Schema-qualified vs search_path
│   ├── DatabaseClientOptions.ts   Connection configuration types
│   ├── BaseRawQueryBuilder.ts     SQL template builder
│   ├── SchemaGenerator.ts         DDL generation
│   ├── SchemaDiff.ts              Live DB ↔ metadata comparison
│   └── ...
├── decorators/            # @Entity, @Column, @ManyToOne, lifecycle hooks
├── dialects/              # ISqlDriver + MySQL/Postgres/SQLite implementations
│   ├── SqlDriver.ts              ISqlDriver interface
│   ├── TransactionSessionManager.ts  Connection + transaction lifecycle
│   ├── ReplicationRouter.ts      Read replica routing
│   ├── mysql/                    MySQL driver, connector, data source
│   ├── postgres/                 PostgreSQL driver + TenantMigrationRunner
│   └── sqlite/                   SQLite driver
├── metadata/              # Layered metadata (multi-tenancy core)
│   ├── LayeredMetadataStore.ts   OverlayFS-style layer merging
│   ├── MetadataContext.ts        AsyncLocalStorage tenant scoping
│   └── MetadataLayer.ts          Individual layer storage
├── scanner/               # Decorator metadata extraction
├── migration/             # MigrationRunner + CLI
├── schema/                # Decorator-free EntitySchema API
├── integration/           # NestJS module, Prisma importer
├── types/                 # Shared types
├── errors/                # OrmError hierarchy
├── utils/                 # Logger, ReflectManager
├── DatabaseClient.ts      # Connection singleton
└── index.ts               # Public API exports
```
