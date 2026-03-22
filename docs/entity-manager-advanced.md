# EntityManager — Advanced

This page covers the advanced features of EntityManager: event listeners, entity subscribers, multi-tenancy, plugins, query diagnostics, the repository pattern, and graceful shutdown.

For basic CRUD, see [CRUD Basics](./entity-manager.md). For querying, see [Querying & Pagination](./entity-manager-querying.md). For batch writes and transactions, see [Writes & Transactions](./entity-manager-writes.md).

---

## Event Listeners

EntityManager emits events when data is created, updated, or deleted. Register listeners with `on()` and remove them with `off()`.

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
- `entity` — the entity class (constructor function)
- `data` — the entity data being inserted/updated/deleted

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

While event listeners are global (they fire for every entity), **subscribers** let you react to lifecycle events for a **specific entity class**.

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

Subscribers support the same lifecycle methods as event listeners: `beforeInsert`, `afterInsert`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`. Each is optional — implement only the ones you need.

For a comprehensive guide on event patterns (audit logging, cache invalidation), see [Events & Subscribers](./events.md).

---

## Multi-Tenancy — withTenant()

`withTenant()` executes a callback in the context of a specific tenant. All EntityManager operations inside the callback are automatically scoped to that tenant's schema/data.

```typescript
const result = await em.withTenant("tenant_acme", async (tenantEm) => {
  // All queries inside here target the "tenant_acme" schema
  const users = await tenantEm.find(User);
  return users;
});
```

Under the hood, `withTenant()` uses `MetadataContext.run()` with `AsyncLocalStorage` to isolate the tenant context. This means it's safe to use in concurrent request handlers — each request gets its own context.

### How tenant queries work

The behavior depends on your `tenantStrategy` setting in `register()`:

| Strategy | Behavior | Tradeoff |
|----------|----------|----------|
| `"search_path"` (default) | `SET LOCAL search_path = 'tenant_acme'` inside a transaction | Safe for all cases, but requires 5 round-trips per read |
| `"schema_qualified"` | Uses `"tenant_acme"."users"` in the query | Single round-trip, but all queries must be schema-aware |

```typescript
await em.register({
  type: "postgres",
  // ...
  tenantStrategy: "schema_qualified",
});
```

For the full multi-tenancy setup guide (tenant provisioning, schema migration), see [Multi-Tenancy](./multi-tenancy.md).

---

## Plugin System — extend()

Plugins add new capabilities to EntityManager at runtime. Install a plugin with `extend()`:

```typescript
import { bufferPlugin } from "@stingerloom/orm";

const em = new EntityManager();
await em.register({ /* ... */ });

// Install plugin — new methods are mixed into `em`
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
- Plugin method names must not conflict with existing EntityManager members — conflicts throw `OrmError` with code `PLUGIN_CONFLICT`.

For the full plugin authoring guide and built-in plugins, see [Plugin System](./plugins.md).

---

## Query Builder — createQueryBuilder()

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

## Repository Pattern — getRepository()

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

## Driver Access — getDriver()

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

### getQueryLog()

Returns the query tracker's log — an array of recent queries with entity name, SQL text, and duration.

```typescript
const log = em.getQueryLog();
for (const entry of log) {
  console.log(`[${entry.entityName}] ${entry.sql} (${entry.durationMs}ms)`);
}
```

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

## Shutdown — propagateShutdown()

Cleans up all EntityManager resources: event listeners, subscribers, plugins, query tracker, and optionally the connection pool.

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

**Return value**: `boolean` — `true` if all active queries completed within the timeout, `false` if the shutdown was forced.

### Shutdown sequence

1. **Wait for active queries** (if `gracefulTimeoutMs > 0`)
2. **Shutdown plugins** in reverse installation order (LIFO)
3. **Clear** event listeners, subscribers, and dirty entity tracking
4. **Reset** the query tracker
5. **Shutdown** the replication router
6. **Close connection pool** (if `closeConnections: true`)

### NestJS integration

In NestJS, call `propagateShutdown()` in the `OnModuleDestroy` lifecycle hook:

```typescript
import { OnModuleDestroy } from "@nestjs/common";

@Injectable()
export class AppService implements OnModuleDestroy {
  constructor(
    @InjectEntityManager() private readonly em: EntityManager,
  ) {}

  async onModuleDestroy() {
    await em.propagateShutdown({ closeConnections: true });
  }
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
| `lock` | `LockMode` | Pessimistic lock: `PESSIMISTIC_WRITE` (FOR UPDATE) or `PESSIMISTIC_READ` (FOR SHARE). |

---

## Next Steps

- **[CRUD Basics](./entity-manager.md)** — save, find, delete, soft delete
- **[Querying & Pagination](./entity-manager-querying.md)** — SELECT, pagination, streaming, aggregates
- **[Writes & Transactions](./entity-manager-writes.md)** — Batch operations, upsert, transactions, raw SQL
- **[Query Builder](./query-builder.md)** — Type-safe fluent queries
- **[Events & Subscribers](./events.md)** — Entity lifecycle events and audit patterns
- **[Plugin System](./plugins.md)** — Writing and using plugins
- **[Multi-Tenancy](./multi-tenancy.md)** — Tenant provisioning and schema isolation
- **[Configuration](./configuration.md)** — Pooling, timeouts, replication, logging
