# EntityManager -- Advanced

This page covers the advanced features of EntityManager: event listeners, entity subscribers, multi-tenancy, plugins, query diagnostics, the repository pattern, and graceful shutdown.

For basic CRUD, see [CRUD Basics](./entity-manager.md). For querying, see [Querying & Pagination](./entity-manager-querying.md). For batch writes and transactions, see [Writes & Transactions](./entity-manager-writes.md).

---

## Event Listeners

### Why events?

Every `save()`, `delete()`, or `softDelete()` call changes data in your database. Sometimes you need to react to those changes -- not inside the CRUD logic itself, but in a separate, decoupled piece of code. Common examples:

- **Audit logging**: Record who changed what, and when.
- **Cache invalidation**: Clear a Redis cache when the underlying data changes.
- **Analytics**: Send a tracking event whenever a new user is created.
- **Notifications**: Trigger a webhook or email after an order is placed.

You could put this logic directly in your service code, but then every service that creates a user would need to remember to log, invalidate cache, and send analytics. Events let you write that logic once, in one place, and it fires automatically no matter where the data change originates.

### When to use events vs. lifecycle hooks

The distinction matters:

- **Lifecycle hooks** (`@BeforeInsert`, `@AfterUpdate`, etc.) are defined on the **entity class itself**. They are tightly coupled to the entity and run as part of the save/delete pipeline. Use them for entity-internal concerns like "hash the password before insert" or "normalize the email to lowercase."

- **Event listeners** are defined on the **EntityManager**. They are decoupled from the entity and can observe all entity types at once. Use them for cross-cutting concerns like "log every database write to an audit table."

### Available events

| Event | Fires When |
|-------|------------|
| `beforeInsert` | Before a new row is inserted |
| `afterInsert` | After a new row is inserted |
| `beforeUpdate` | Before an existing row is updated |
| `afterUpdate` | After an existing row is updated |
| `beforeDelete` | Before a row is deleted |
| `afterDelete` | After a row is deleted |

### Registering a listener

```typescript
em.on("afterInsert", ({ entity, data }) => {
  console.log(`${entity.name} created:`, data);
});

em.on("beforeUpdate", ({ entity, data }) => {
  console.log(`About to update ${entity.name}:`, data);
});
```

The listener receives an object with:
- `entity` -- the entity class (constructor function)
- `data` -- the entity data being inserted/updated/deleted

### Removing listeners

```typescript
// Remove a specific listener
const listener = ({ entity, data }) => { /* ... */ };
em.on("afterInsert", listener);
em.off("afterInsert", listener);

// Remove ALL listeners across ALL events
em.removeAllListeners();
```

::: tip
Event listeners fire for **all entities**. If you need listeners scoped to a specific entity class, use Entity Subscribers instead (see below).
:::

---

## Entity Subscribers

### Why subscribers when events already exist?

Event listeners fire for every entity type. If you register an `afterInsert` listener, it fires when a User is created, when a Post is created, when an Order is created -- for everything. Your listener code must then check which entity triggered it.

Subscribers solve this by binding to a **specific entity class**. A `UserSubscriber` only fires for `User` events, never for `Post` or `Order`. This is cleaner, safer, and easier to reason about.

Think of it as the difference between a security camera that watches the entire building (events) versus one that watches only the vault (subscribers).

### When to use subscribers vs. global events

| Use case | Recommended approach |
|----------|---------------------|
| Log every database write to an audit table | Global event listener |
| Invalidate all caches on any data change | Global event listener |
| Send a welcome email when a User is created | Entity subscriber (UserSubscriber) |
| Update a search index when a Post changes | Entity subscriber (PostSubscriber) |
| Recalculate order total when OrderItem changes | Entity subscriber (OrderItemSubscriber) |

### Creating a subscriber

```typescript
import { EntitySubscriber, InsertEvent, UpdateEvent, DeleteEvent } from "@stingerloom/orm";

class UserSubscriber implements EntitySubscriber<User> {
  listenTo() {
    return User;
  }

  afterInsert(event: InsertEvent<User>) {
    console.log("New user created:", event.entity);
  }

  beforeUpdate(event: UpdateEvent<User>) {
    console.log("About to update user:", event.entity);
  }

  afterDelete(event: DeleteEvent<User>) {
    console.log("User deleted:", event.entity);
  }
}
```

### Registering and removing subscribers

```typescript
const subscriber = new UserSubscriber();

// Register
em.addSubscriber(subscriber);

// Remove
em.removeSubscriber(subscriber);
```

Subscribers support the same lifecycle methods as event listeners: `beforeInsert`, `afterInsert`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`. Each is optional -- implement only the ones you need.

For a comprehensive guide on event patterns (audit logging, cache invalidation), see [Events & Subscribers](./events.md).

---

## Multi-Tenancy -- withTenant()

### Why multi-tenancy?

Multi-tenancy means serving multiple customers (tenants) from the same application, with each tenant's data isolated from the others. Think of an apartment building: everyone shares the same building infrastructure, but each tenant has their own locked apartment.

Without an ORM-level solution, you would need to manually prefix every query with the tenant schema, manage search paths, and ensure no query accidentally crosses tenant boundaries. `withTenant()` handles all of this automatically.

### How it works

`withTenant()` executes a callback in the context of a specific tenant. All EntityManager operations inside the callback are automatically scoped to that tenant's schema/data.

```typescript
const result = await em.withTenant("tenant_acme", async (tenantEm) => {
  // All queries inside here target the "tenant_acme" schema
  const users = await tenantEm.find(User);
  return users;
});
```

Under the hood, `withTenant()` uses `MetadataContext.run()` with `AsyncLocalStorage` to isolate the tenant context. This means it is safe to use in concurrent request handlers -- each HTTP request gets its own isolated context, even though they all run in the same Node.js process.

### The SQL difference: two strategies

The behavior depends on your `tenantStrategy` setting in `register()`:

#### Strategy 1: search_path (default)

With `search_path`, the ORM sets the PostgreSQL search path inside a transaction before running any queries:

```sql
-- 5 round-trips per tenant read:
BEGIN
SET LOCAL search_path = 'tenant_acme'
SELECT "id", "name", "email" FROM "user" WHERE "isActive" = $1
COMMIT
-- (+ connection acquire/release)
```

`SET LOCAL` scopes the search path to the current transaction only. Once the transaction ends, the search path reverts. This is safe but requires a transaction wrapper even for simple reads.

| Strategy | Behavior | Tradeoff |
|----------|----------|----------|
| `"search_path"` (default) | `SET LOCAL search_path = 'tenant_acme'` inside a transaction | Safe for all cases, but requires 5 round-trips per read |

#### Strategy 2: schema_qualified

With `schema_qualified`, the ORM prefixes table names directly in the SQL, eliminating the need for a transaction:

```sql
-- 1 round-trip:
SELECT "id", "name", "email" FROM "tenant_acme"."user" WHERE "isActive" = $1
```

| Strategy | Behavior | Tradeoff |
|----------|----------|----------|
| `"schema_qualified"` | Uses `"tenant_acme"."users"` in the query | Single round-trip, but all queries must be schema-aware |

To enable it:

```typescript
await em.register({
  type: "postgres",
  // ...
  tenantStrategy: "schema_qualified",
});
```

The `schema_qualified` strategy is faster (1 round-trip vs 5), but `search_path` is the default because it works with every PostgreSQL feature without surprises (e.g., functions, triggers, and extensions all respect the search path).

For the full multi-tenancy setup guide (tenant provisioning, schema migration), see [Multi-Tenancy](./multi-tenancy.md).

---

## Plugin System -- extend()

### Why plugins?

As an ORM grows, every team wants different features: write buffering, audit trails, soft-delete overrides, custom caching. Putting all of these into the core would make EntityManager massive and force every user to pay the cost (in bundle size and complexity) for features they may never use.

Plugins solve this by letting you opt into additional capabilities. The core stays lean. You add what you need.

### Installing a plugin

Install a plugin with `extend()`:

```typescript
import { bufferPlugin } from "@stingerloom/orm";

const em = new EntityManager();
await em.register({ /* ... */ });

// Install plugin -- new methods are mixed into `em`
em.extend(bufferPlugin());
```

You can also install plugins declaratively in `register()`:

```typescript
await em.register({
  type: "postgres",
  // ...
  plugins: [bufferPlugin()],
});
```

### Plugin introspection

```typescript
// Check if a plugin is installed
em.hasPlugin("buffer"); // true

// Get a plugin's API object
const api = em.getPluginApi<BufferApi>("buffer");
```

### Idempotency and dependencies

- Installing the same plugin twice is a **no-op** (safe to call multiple times).
- Plugins can declare dependencies. If a dependency is not installed, `extend()` throws `OrmError` with code `PLUGIN_DEPENDENCY_MISSING`.
- Plugin method names must not conflict with existing EntityManager members -- conflicts throw `OrmError` with code `PLUGIN_CONFLICT`.

For the full plugin authoring guide and built-in plugins, see [Plugin System](./plugins.md).

---

## Query Builder -- createQueryBuilder()

EntityManager provides two flavors of query builder for complex queries that go beyond `find()`.

### SelectQueryBuilder (type-safe)

Created by passing an entity class and alias. Provides type-safe column references and narrowed return types.

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name", "email"])     // Return type narrows to Pick<User, "id" | "name" | "email">
  .where("isActive", true)
  .andWhere("age", ">=", 18)
  .orderBy({ createdAt: "DESC" })
  .limit(10)
  .getMany();
```

### RawQueryBuilder (free-form)

Created with no arguments. Provides full SQL control with no type constraints.

```typescript
import sql from "sql-template-tag";

const qb = em.createQueryBuilder();
const query = qb
  .select(["*"])
  .from('"users"')
  .where([sql`"is_active" = ${true}`])
  .build();

const result = await em.query(query);
```

For the full guide (JOIN, UNION, CTE, window functions, subqueries, validation), see [Query Builder](./query-builder.md).

---

## Repository Pattern -- getRepository()

If you prefer to encapsulate CRUD per entity rather than passing the entity class to every method, use repositories.

```typescript
const userRepo = em.getRepository(User);

const users = await userRepo.find();
const user = await userRepo.findOne({ where: { id: 1 } });
await userRepo.save({ name: "Alice" });
await userRepo.delete({ id: 1 });
```

A repository wraps the same EntityManager methods but is pre-bound to a specific entity class.

### NestJS injection

In NestJS, inject repositories into services with `@InjectRepository()`:

```typescript
import { Injectable } from "@nestjs/common";
import { InjectRepository, BaseRepository } from "@stingerloom/orm/nestjs";
import { User } from "./user.entity";

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly userRepo: BaseRepository<User>,
  ) {}

  findAll() {
    return this.userRepo.find();
  }
}
```

For multi-database environments, pass the connection name as the second argument:

```typescript
@InjectRepository(Event, "analytics")
private readonly eventRepo: BaseRepository<Event>,
```

You can also inject the EntityManager directly:

```typescript
import { InjectEntityManager } from "@stingerloom/orm/nestjs";

@Injectable()
export class StatsService {
  constructor(
    @InjectEntityManager() private readonly em: EntityManager,
    // Named connection: @InjectEntityManager("analytics")
  ) {}
}
```

For the full NestJS integration guide, see [NestJS Module Setup](./nestjs.md).

---

## Driver Access -- getDriver()

Access the underlying SQL driver for low-level operations:

```typescript
const driver = em.getDriver();

if (driver) {
  // Direct access to driver-specific features
  const tables = await driver.getTables();
  console.log(tables);
}
```

The driver implements the `ISqlDriver` interface. Common use cases include schema introspection and direct DDL operations. Returns `undefined` if `register()` has not been called yet.

---

## Query Diagnostics

### Why query diagnostics?

When your application slows down, the cause is almost always in the database layer. But which queries are slow? Are you accidentally running the same query hundreds of times (the N+1 problem)? Without visibility into what SQL is being executed, you are debugging blind.

Query diagnostics give you that visibility. You can log every query, detect N+1 patterns automatically, and get warnings when a query exceeds a time threshold.

### getQueryLog()

Returns the query tracker's log -- an array of recent queries with entity name, SQL text, and duration.

```typescript
const log = em.getQueryLog();
for (const entry of log) {
  console.log(`[${entry.entityName}] ${entry.sql} (${entry.durationMs}ms)`);
}
```

This is useful for:
- **Debugging**: "What SQL did my last API call actually execute?"
- **Performance monitoring**: "Which queries are taking the longest?"
- **Test assertions**: "Did this service call execute the expected number of queries?"

::: info
Query logging requires the `logging` option in `register()`. Without it, `getQueryLog()` returns an empty array.
:::

```typescript
await em.register({
  // ...
  logging: {
    queries: true,       // Log SQL to console
    slowQueryMs: 500,    // Warn on queries slower than 500ms
    nPlusOne: true,      // Detect N+1 query patterns
  },
});
```

### getQueryTracker()

Returns the `QueryTracker` instance (or `null` if tracking is disabled). Useful for programmatic access to query statistics in tests or diagnostics.

```typescript
const tracker = em.getQueryTracker();
if (tracker) {
  console.log("Active queries:", tracker.activeQueryCount);
}
```

For the full logging and diagnostics guide, see [Logging & Diagnostics](./logging.md).

---

## Shutdown -- propagateShutdown()

### Why explicit shutdown?

Node.js processes can hold resources that outlive individual requests: connection pools, event listeners, subscriber references, plugin state, and query tracker buffers. If you just stop the process without cleaning up, you risk:

- **Connection pool leaks**: The database sees abandoned connections that count against its `max_connections` limit.
- **Unfinished transactions**: In-flight queries may leave locks held or transactions open.
- **Memory leaks in long-running processes**: If the EntityManager is recreated without shutting down the old one (common in hot-reload development), listeners and subscribers accumulate.

`propagateShutdown()` cleans up all of these resources in the correct order.

### Basic usage

```typescript
await em.propagateShutdown();
```

### Options

```typescript
const allCompleted = await em.propagateShutdown({
  gracefulTimeoutMs: 5000,  // Wait up to 5s for active queries to finish
  closeConnections: true,   // Also close the database connection pool
});

if (!allCompleted) {
  console.warn("Some queries were still running when shutdown was forced");
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `gracefulTimeoutMs` | `number` | `0` | Max time (ms) to wait for in-flight queries. `0` = don't wait. |
| `closeConnections` | `boolean` | `false` | Whether to close the underlying connection pool. |

**Return value**: `boolean` -- `true` if all active queries completed within the timeout, `false` if the shutdown was forced.

### Shutdown sequence

Here is what happens internally, in order:

1. **Wait for active queries** (if `gracefulTimeoutMs > 0`) -- The ORM checks if any queries are currently executing. If so, it waits up to the specified timeout for them to finish.
2. **Shutdown plugins** in reverse installation order (LIFO) -- If you installed plugins A, then B, then C, they shut down in order C, B, A. This respects dependencies (a plugin that depends on another shuts down before its dependency).
3. **Clear** event listeners, subscribers, and dirty entity tracking -- Removes all registered `on()` listeners and subscriber instances to prevent memory leaks.
4. **Reset** the query tracker -- Clears accumulated query logs and statistics.
5. **Shutdown** the replication router -- Stops health checks for read replicas.
6. **Close connection pool** (if `closeConnections: true`) -- Terminates all database connections in the pool.

### Real-world NestJS scenario

In a NestJS application, the typical pattern is to call `propagateShutdown()` in the `OnModuleDestroy` lifecycle hook. This ensures that when NestJS shuts down (due to a SIGTERM signal from Kubernetes, a deployment, or a test teardown), the ORM releases all resources:

```typescript
import { OnModuleDestroy, Injectable } from "@nestjs/common";
import { InjectEntityManager } from "@stingerloom/orm/nestjs";
import { EntityManager } from "@stingerloom/orm";

@Injectable()
export class AppService implements OnModuleDestroy {
  constructor(
    @InjectEntityManager() private readonly em: EntityManager,
  ) {}

  async onModuleDestroy() {
    // Wait up to 10 seconds for queries to finish, then close everything
    const clean = await em.propagateShutdown({
      gracefulTimeoutMs: 10_000,
      closeConnections: true,
    });

    if (!clean) {
      console.warn("ORM shutdown was forced -- some queries may not have completed");
    }
  }
}
```

In a Kubernetes environment, the timeline looks like this:

```
1. Kubernetes sends SIGTERM to the pod
2. NestJS receives SIGTERM, starts shutting down modules
3. onModuleDestroy() fires
4. propagateShutdown() starts:
   - Waits up to 10s for 3 active queries to finish (they complete in 2s)
   - Shuts down buffer plugin
   - Clears 5 event listeners and 2 subscribers
   - Resets the query tracker
   - Closes the connection pool (releases 10 connections)
5. Returns true (all queries completed)
6. NestJS finishes shutdown
7. Process exits cleanly
```

---

## Batch Streaming -- streamBatch()

`stream()` yields entities one at a time. But sometimes you need to process data in batches -- for example, bulk-inserting into another system in groups of 500. `streamBatch()` yields arrays of entities instead of individual items.

```typescript
for await (const batch of em.streamBatch(User, { where: { isActive: true } }, 500)) {
  // batch is User[] with up to 500 items
  await bulkIndex(batch);
  console.log(`Indexed ${batch.length} users`);
}
```

Each iteration yields a full batch (up to `batchSize` entities). The last batch may be smaller. Internally uses LIMIT/OFFSET pagination, same as `stream()`.

```typescript
// Repository equivalent
const userRepo = em.getRepository(User);
for await (const batch of userRepo.streamBatch({ where: { role: "admin" } }, 1000)) {
  await sendBulkEmail(batch);
}
```

The `streamBatch()` method accepts the same `FindOption` as `find()` -- `where`, `orderBy`, `relations`, `select`, etc.

---

## Compiled Query Plans -- `em.compile()` / `qb.prepare()`

### Why compile a query at all?

Every call to `em.find()`, `em.save()`, or a query builder terminal method walks the same pipeline before a single byte leaves the process:

1. Resolve the entity's metadata layer (relations, columns, inheritance map).
2. Apply the naming strategy to translate property names into column identifiers.
3. Escape identifiers through the dialect driver.
4. Interpolate `sql`-tagged fragments, flatten nested `Sql` objects, and glue the final template.
5. Hand the finished `Sql` to the driver.

For a single call this is negligible. But if the same shape of query runs tens of thousands of times -- a hot path in a worker, a per-row lookup inside a large batch job, a metric-collection loop -- steps 1-4 quietly become a measurable share of total CPU. The network roundtrip is not the bottleneck; the roundtrip *inside your Node.js process* is.

A compiled query freezes the template after one pass through that pipeline. Later executions only substitute placeholder values and dispatch the already-built `Sql`.

::: info Prepared statements vs. compiled queries
Stingerloom's compiled queries are **ORM-layer** memoization: the SQL text and its value slots are cached in JavaScript. The driver still sends the query to the database as usual; there is no server-side `PREPARE`. Native prepared statements are a separate optimization and are planned as a follow-up.
:::

### When compilation pays off (and when it doesn't)

Before reaching for `compile()`, check whether you can sidestep the database call entirely. Stingerloom already offers cheaper options for several common patterns:

| Situation | Reach for |
|-----------|-----------|
| Same row read repeatedly inside one unit of work | [WriteBuffer](./write-buffer.md) identity map -- skips the DB entirely on PK hits |
| Many inserts/updates flushed as one batch | [`batchInsert()` / `batchUpsert()`](./entity-manager-writes.md) -- one roundtrip, one template |
| Looping over a large result | [`stream()` / `streamBatch()`](#batch-streaming-streambatch) -- a single cursor-shaped query |
| Aggregating rows in SQL | [RawQueryBuilder](./raw-sql.md) with GROUP BY / window functions -- shift work into the DB |

Compiled queries pay off when **the SQL call is unavoidable and the template is stable but the parameters change**. Typical fits:

- Per-request entity lookup inside an authenticated middleware (`WHERE id = ?` fired on every request).
- Tight validation loops over user input (`WHERE email = ?` for each row in an import).
- Scheduled jobs that hammer the same query across many tenants or time windows.
- Any code path where `em.find()` or a query builder shows up near the top of a CPU profile.

They do **not** help queries whose shape changes from call to call (dynamic WHERE clauses that add and remove conditions, for example); for those, let the builder run normally.

### SelectQueryBuilder.prepare()

The easiest entry point. Mark runtime values with `p("name")`, then call `.prepare()` to freeze the current builder state.

```typescript
import { p } from "@stingerloom/orm";
import sql from "sql-template-tag";

const findUserById = em
  .createQueryBuilder(User, "u")
  .where(sql`u.id = ${p("id")}`)
  .prepare<{ id: number }>();

await findUserById.executeOne({ id: 42 });
await findUserById.executeOne({ id: 77 });   // SQL is not rebuilt
await findUserById.executeOne({ id: 81 });
```

`prepare()` returns a `CompiledQuery<T, P>`. The builder itself stays mutable, but the compiled object is insulated from it -- further `.where()` or `.limit()` calls on the builder do not affect a compiled query captured earlier.

```typescript
const compiled = qb.prepare();
const frozenSql = compiled.sql;

qb.where("u.id", 99);
qb.limit(5);

compiled.sql === frozenSql;   // true -- compilation already snapshotted the query
```

Because rows still flow through the deserializer, `execute()` returns class instances. `instanceof User` works, lifecycle hooks and subscribers see the real entity type, and results can be passed straight back into `em.save()`.

If you only want a typed projection without class materialization, use `preparePartial()`:

```typescript
const listEmails = em
  .createQueryBuilder(User, "u")
  .select(["id", "email"])
  .where(sql`u.isActive = ${p("active")}`)
  .preparePartial<{ active: boolean }>();

const rows = await listEmails.execute({ active: true });
// rows: Pick<User, "id" | "email">[] -- plain objects
```

### RawQueryBuilder.prepare()

`RawQueryBuilder` covers UNION, CTE, window functions, and anything else `SelectQueryBuilder` can't model directly. It supports the same compilation flow, but because it produces raw rows you pass the `EntityManager` explicitly as the executor.

```typescript
const topSpenders = em
  .createQueryBuilder()
  .select(["user_id", "SUM(amount) AS total"])
  .from("orders")
  .where([sql`created_at >= ${p("since")}`])
  .groupBy(["user_id"])
  .having([sql`SUM(amount) >= ${p("threshold")}`])
  .prepare<{ user_id: number; total: number }, { since: Date; threshold: number }>(em);

const lastMonth = await topSpenders.execute({
  since: new Date("2026-03-01"),
  threshold: 500,
});

const lastWeek = await topSpenders.execute({
  since: new Date("2026-04-05"),
  threshold: 200,
});
```

Rows are returned as plain objects -- there is no class deserialization on this path, mirroring `em.query()`.

### `em.compile()` -- EF.CompileQuery-style wrapper

Entity Framework users will recognize `em.compile()`. Instead of creating placeholders by name with `p("id")`, you declare the parameter shape on the compile call and receive a proxy whose property accesses generate placeholders:

```typescript
const findByEmail = em.compile<User, { email: string }>((em, $) =>
  em.createQueryBuilder(User, "u").where(sql`u.email = ${$.email}`),
);

await findByEmail.executeOne({ email: "alice@example.com" });
await findByEmail.executeOne({ email: "bob@example.com" });
```

The advantages over calling `.prepare()` directly:

- The parameter object `P` is declared once on the compile generic and propagates into every `execute()` call -- typos on keys are compile-time errors.
- Placeholder names come from property accesses, so refactor-renames are caught at type-check time.
- The callback is self-contained and easy to move around -- hand it to a cache, store it on a module scope, or export it from a repository class.

The callback must return a builder that exposes `.prepare()` -- either a `SelectQueryBuilder` or a `RawQueryBuilder`. Both work:

```typescript
const recentPostsByAuthor = em.compile<Post, { authorId: number }>((em, $) =>
  em
    .createQueryBuilder(Post, "p")
    .where(sql`p.authorId = ${$.authorId}`)
    .orderBy({ createdAt: "DESC" })
    .limit(10),
);
```

If the callback returns something that cannot be compiled, an `OrmError` is thrown up front -- never silently at execution time.

### Execution methods

Once compiled, a query has three terminal methods:

| Method | Returns | Use when |
|--------|---------|----------|
| `execute(params)` | `T[]` (class instances, if a deserializer was attached) | You expect a list of results |
| `executeOne(params)` | `T \| null` | You expect at most one row (the query should already include `LIMIT 1` if needed) |
| `executeRaw(params)` | `unknown[]` | You want the driver rows as-is, skipping deserialization |

Omitting `params` is allowed only when the query defines no placeholders; otherwise a `MISSING_PLACEHOLDER` `OrmError` fires before the query runs.

```typescript
await findUserById.execute({});            // throws -- "id" is required
await findUserById.execute({ id: 1 });     // ok
```

You can inspect a compiled query without executing it:

```typescript
compiled.sql;              // "SELECT ... WHERE u.id = ?" (driver-agnostic form)
compiled.parameterNames;   // readonly ["id"]
```

### Good practices

- **Compile once, reuse forever.** Assign the compiled query to a module-scoped constant or a service field. Re-creating it per request defeats the purpose.
- **Keep the template stable.** If the WHERE clause changes shape (extra conditions, optional ORDER BY), build a handful of compiled variants rather than threading optional logic through a single one.
- **Prefer `em.compile()` when you want the typed parameter ergonomics.** `qb.prepare()` is the better fit when the builder is constructed dynamically by surrounding code.
- **Profile before and after.** Compilation is cheap and safe, but the benefit depends on how much of your runtime was actually spent building SQL. Use [`getQueryLog()`](#query-diagnostics) or an external profiler to confirm the change moved the needle.

---

## Entity Metadata API

The metadata API provides read-only access to entity schema information at runtime. This is useful for building admin panels, generating documentation, or creating generic CRUD components.

### getEntityMetadata()

Returns the full metadata for an entity class, including table name, columns, relations, indexes, and special columns.

```typescript
const meta = em.getEntityMetadata(User);
if (meta) {
  console.log(meta.tableName);     // "user"
  console.log(meta.columns);       // ColumnMetadataView[]
  console.log(meta.relations);     // RelationMetadataView[]
  console.log(meta.indexes);       // Index definitions
  console.log(meta.deletedAtColumn);     // "deletedAt" or undefined
  console.log(meta.versionColumn);       // "version" or undefined
}
```

### getColumnMetadata()

Returns column metadata only, which is a subset of the full entity metadata.

```typescript
const columns = em.getColumnMetadata(User);
for (const col of columns) {
  console.log(`${col.propertyKey} -> ${col.columnName} (${col.type})`);
  // "name" -> "name" (varchar)
  // "email" -> "email" (varchar)
}
```

Each column entry includes:

| Field | Type | Description |
|-------|------|-------------|
| `propertyKey` | `string` | Entity property name |
| `columnName` | `string` | Database column name |
| `type` | `string` | Column type (varchar, int, etc.) |
| `nullable` | `boolean` | Whether the column is nullable |
| `primary` | `boolean` | Whether it is a primary key |
| `unique` | `boolean` | Whether it has a unique constraint |
| `default` | `any` | Default value (if set) |
| `length` | `number` | Column length (if applicable) |

### getRelationMetadata()

Returns relation metadata for an entity.

```typescript
const relations = em.getRelationMetadata(Post);
for (const rel of relations) {
  console.log(`${rel.propertyKey}: ${rel.type} -> ${rel.target.name}`);
  // "author": ManyToOne -> User
  // "tags": ManyToMany -> Tag
}
```

---

## FindOption Reference

Complete list of options accepted by `find()`, `findOne()`, `findAndCount()`, `findWithCursor()`, `stream()`, and `explain()`.

| Option | Type | Description |
|--------|------|-------------|
| `where` | `WhereClause<T>` | WHERE conditions. Each key-value pair becomes an AND condition. |
| `select` | `(keyof T)[]` or `Record<keyof T, boolean>` | Columns to select. Omit for `SELECT *`. |
| `orderBy` | `Record<keyof T, "ASC" \| "DESC">` | Sort order. Multiple keys = multi-column sort. |
| `limit` | `number` or `[offset, count]` | Raw LIMIT. Prefer `skip`/`take` for pagination. |
| `skip` | `number` | Offset for pagination. Used with `take`. |
| `take` | `number` | Max rows to return. Used with `skip`. |
| `relations` | `(keyof T \| string)[]` | Relations to eager-load via LEFT JOIN. Supports nested paths (e.g., `"author.profile"`). |
| `withDeleted` | `boolean` | Include soft-deleted entities (`@DeletedAt`). Default: `false`. |
| `groupBy` | `(keyof T)[]` | GROUP BY columns. |
| `having` | `Sql[]` | HAVING conditions (sql-template-tag). Joined with AND. |
| `timeout` | `number` | Per-query timeout in ms. Overrides the connection-level `queryTimeout`. |
| `distinct` | `boolean` | Generate `SELECT DISTINCT`. Default: `false`. |
| `useMaster` | `boolean` | Force read from master node in a replication setup. Default: `false`. |
| `lock` | `LockMode` | Pessimistic lock. See values below. |

### LockMode Values

| LockMode | SQL | Description |
|----------|-----|-------------|
| `PESSIMISTIC_WRITE` | `FOR UPDATE` | Exclusive lock -- blocks reads and writes |
| `PESSIMISTIC_READ` | `FOR SHARE` | Shared lock -- blocks writes only |
| `PESSIMISTIC_WRITE_NOWAIT` | `FOR UPDATE NOWAIT` | Fails immediately if rows are locked |
| `PESSIMISTIC_READ_NOWAIT` | `FOR SHARE NOWAIT` | Shared lock, fails if rows are locked |
| `PESSIMISTIC_WRITE_SKIP_LOCKED` | `FOR UPDATE SKIP LOCKED` | Skips rows locked by other transactions |
| `PESSIMISTIC_READ_SKIP_LOCKED` | `FOR SHARE SKIP LOCKED` | Shared lock, skips locked rows |

NOWAIT and SKIP LOCKED require MySQL 8.0+ or PostgreSQL 9.5+. SQLite does not support pessimistic locking.

---

## Next Steps

- **[CRUD Basics](./entity-manager.md)** -- save, find, delete, soft delete
- **[Querying & Pagination](./entity-manager-querying.md)** -- SELECT, pagination, streaming, aggregates
- **[Writes & Transactions](./entity-manager-writes.md)** -- Batch operations, upsert, transactions, raw SQL
- **[Query Builder](./query-builder.md)** -- Type-safe fluent queries
- **[Events & Subscribers](./events.md)** -- Entity lifecycle events and audit patterns
- **[Plugin System](./plugins.md)** -- Writing and using plugins
- **[Multi-Tenancy](./multi-tenancy.md)** -- Tenant provisioning and schema isolation
- **[Configuration](./configuration.md)** -- Pooling, timeouts, replication, logging
