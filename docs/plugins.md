# Plugins

## Why Plugins Exist

An ORM touches many concerns: CRUD operations, schema synchronization, event systems, unit-of-work patterns, audit logging, soft deletes, and more. If all of these lived in the core, every application would pay the cost of features it does not use -- larger bundle sizes, more memory, more surface area for bugs.

Plugins solve this by keeping the core small and focused on what every application needs (reading and writing data), while optional features live in separate modules that you install only when you need them.

Think of plugins like browser extensions. Your browser ships with the essentials: rendering pages, managing tabs, handling bookmarks. But ad blocking, password management, and developer tools are extensions. You install only what you need, and removing one does not break the others.

## How Plugins Work -- The Lifecycle

A plugin goes through a clear lifecycle:

```
1. INSTALL      em.extend(myPlugin)
                  |
                  v
2. RECEIVE      plugin.install(ctx) is called
   CONTEXT        -- ctx gives controlled access to EntityManager internals
                  |
                  v
3. ADD          install() returns an API object
   METHODS        -- those methods are mixed into the EntityManager instance
                  |
                  v
4. (active)     Your code calls em.myNewMethod()
                  -- the plugin is fully operational
                  |
                  v
5. SHUTDOWN     em.propagateShutdown() calls plugin.shutdown()
                  -- clean up timers, connections, caches
```

Let us walk through each step.

### Step 1: Install

You call `em.extend()` with a plugin object. Stingerloom checks if this plugin is already installed (by name). If it is, the call is a no-op -- idempotent by design, so you can safely call `extend()` multiple times without side effects.

```typescript
import { EntityManager } from "@stingerloom/orm";

const em = new EntityManager();
em.extend(myPlugin());
```

You can also pass plugins via the `plugins` array in `register()`, which installs them automatically after the database connection is established:

```typescript
await em.register({
  type: "postgres",
  host: "localhost",
  port: 5432,
  username: "postgres",
  password: "password",
  database: "mydb",
  entities: [User, Post, Comment],
  synchronize: true,
  plugins: [myPlugin()],
});
```

### Step 2: Receive Context

When `install()` is called, it receives a `PluginContext` object. This is a curated API surface -- not the raw EntityManager internals, but a controlled set of capabilities that plugins are intended to use. This keeps plugins stable even when EntityManager internals change.

### Step 3: Add Methods

The `install()` function can return an object. Every method on that object gets mixed into the EntityManager instance. After installation, you call those methods directly on `em` as if they were built-in.

### Step 4: Active Operation

The plugin is now part of the EntityManager. Event listeners fire, methods are callable, and everything works as if the feature were native.

### Step 5: Shutdown

When `em.propagateShutdown()` is called (for example, when your NestJS application shuts down), plugins receive a `shutdown()` call in reverse installation order. The last plugin installed is the first to shut down. This is the place to clear intervals, close sockets, or flush buffers.

---

## Writing a Custom Plugin

A plugin is an object that implements the `StingerloomPlugin` interface: a `name`, an `install()` function, and an optional `shutdown()` function.

### Full example: Timestamp Logger

This plugin records a timestamped log entry every time an entity is inserted or deleted.

```typescript
import { StingerloomPlugin, PluginContext } from "@stingerloom/orm";

const timestampLogger: StingerloomPlugin<{ getLog(): string[] }> = {
  name: "timestamp-logger",

  install(ctx: PluginContext) {
    const log: string[] = [];

    ctx.events.on("afterInsert", ({ entity }) => {
      log.push(`[${new Date().toISOString()}] INSERT ${entity.name}`);
    });

    ctx.events.on("afterDelete", ({ entity }) => {
      log.push(`[${new Date().toISOString()}] DELETE ${entity.name}`);
    });

    return {
      getLog: () => [...log],
    };
  },

  shutdown() {
    // Nothing to clean up in this simple example,
    // but this is where you would clear timers or close connections.
  },
};

em.extend(timestampLogger);
em.getLog(); // typed as string[]
```

### Step-by-step trace of what happens

1. You call `em.extend(timestampLogger)`.
2. Stingerloom checks: is a plugin named `"timestamp-logger"` already installed? No. Proceed.
3. Stingerloom calls `timestampLogger.install(ctx)`, passing in a PluginContext.
4. Inside `install()`, the plugin creates an empty `log` array in closure scope. This array is private to the plugin -- no one else can access it directly.
5. The plugin subscribes to two events on `ctx.events`: `"afterInsert"` and `"afterDelete"`. Every time the EntityManager finishes inserting or deleting an entity, these callbacks fire and push a string into the `log` array.
6. `install()` returns `{ getLog: () => [...log] }`. The spread operator `[...log]` creates a copy, so callers cannot mutate the internal array.
7. Stingerloom takes that return value and mixes it into `em`. Now `em.getLog()` is a callable method, and TypeScript knows it returns `string[]`.
8. Later, when you call `em.save(User, { name: "Alice" })`, the EntityManager fires an `"afterInsert"` event. The plugin's callback runs and appends `"[2026-03-22T10:00:00.000Z] INSERT User"` to the log.
9. You call `em.getLog()` and get back `["[2026-03-22T10:00:00.000Z] INSERT User"]`.
10. When the application shuts down and `em.propagateShutdown()` is called, Stingerloom calls `timestampLogger.shutdown()`.

---

## PluginContext Reference

The `install()` function receives a `PluginContext` with controlled access to EntityManager internals. Here is every property and method, with an explanation of when you would use each one.

| Property / Method | Description | When would you use this? |
|-------------------|-------------|--------------------------|
| `ctx.em` | The EntityManager instance | When your plugin needs to call `find()`, `save()`, `delete()`, or any other EntityManager method. Always use `ctx.em` instead of raw SQL so that hooks and events fire correctly. |
| `ctx.driver` | Current SQL driver (`undefined` before `register()`) | When you need to execute raw SQL or check database-specific capabilities. Undefined if the plugin is installed before `register()` is called. |
| `ctx.events` | Entity event emitter (`on`, `off`, `emit`) | When your plugin reacts to entity lifecycle events: `beforeInsert`, `afterInsert`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`. This is the most common plugin pattern. |
| `ctx.connectionName` | Connection name (default: `"default"`) | When your plugin behaves differently per connection in a multi-database setup. For example, an audit plugin might only log changes on the `"primary"` connection. |
| `ctx.addSubscriber(sub)` | Register an EntitySubscriber | When your plugin provides an EntitySubscriber (a class-based alternative to event callbacks with `listenTo()` filtering). |
| `ctx.removeSubscriber(sub)` | Remove an EntitySubscriber | When your plugin needs to dynamically unsubscribe during runtime. |
| `ctx.getEntities()` | All registered entity classes | When your plugin needs to introspect the schema -- for example, generating documentation or validating entity definitions. |
| `ctx.getPlugin(name)` | Access another plugin's API | When your plugin depends on another plugin and needs to call its methods. See "Plugin Dependencies" below. |
| `ctx.isMySqlFamily()` | Check if driver is MySQL/MariaDB | When your plugin generates SQL and needs to use backtick quoting vs double-quote quoting. |
| `ctx.isPostgres()` | Check if driver is PostgreSQL | When your plugin uses PostgreSQL-specific features like schemas, JSONB operators, or RETURNING clauses. |
| `ctx.isSqlite()` | Check if driver is SQLite | When your plugin needs to skip features SQLite does not support (e.g., ALTER COLUMN, EXPLAIN). |
| `ctx.wrap(identifier)` | Quote an identifier with the driver's quoting style | When your plugin builds SQL strings and needs to safely quote column or table names. MySQL uses backticks, PostgreSQL and SQLite use double quotes. |
| `ctx.wrapTable(tableName)` | Quote a table name (with schema prefix) | Same as `wrap()` but handles schema-qualified names (e.g., `"public"."user"` in PostgreSQL). |
| `ctx.executeInTransaction(fn)` | Run a callback in a transaction | When your plugin needs to execute multiple SQL statements atomically. The transaction is committed on success, rolled back on error. |
| `ctx.executeReadOnly(fn)` | Run a callback in a read-only transaction | When your plugin only reads data and you want to signal that to the database for optimization (and use replicas in a read-replica setup). |

---

## Plugin Dependencies

A plugin can declare that it requires other plugins to be installed first. If a dependency is missing, `extend()` throws immediately with a clear error message.

```typescript
const derivedPlugin: StingerloomPlugin = {
  name: "derived",
  dependencies: ["base-plugin"],

  install(ctx) {
    const baseApi = ctx.getPlugin<{ getData(): any[] }>("base-plugin");
    // use baseApi...
  },
};

// This throws -- "base-plugin" is not installed
em.extend(derivedPlugin);

// This works -- install the dependency first
em.extend(basePlugin());
em.extend(derivedPlugin);
```

This is useful when you build a family of plugins that layer on each other. For example, a "soft-delete-audit" plugin might depend on both a "soft-delete" plugin and an "audit" plugin.

---

## Method Name Conflicts

If a plugin tries to add a method that already exists on EntityManager (like `find` or `save`), `extend()` throws a `PLUGIN_CONFLICT` error. This is a safety mechanism -- overwriting core methods would break the ORM in unpredictable ways.

Choose unique, descriptive names for your plugin's API methods. Prefixing with your plugin name is a good convention: `auditGetLog()` instead of `getLog()`, for example.

---

## API Reference

### StingerloomPlugin\<TApi\>

```typescript
interface StingerloomPlugin<TApi = {}> {
  /** Unique plugin name (used for dependency resolution and dedup) */
  readonly name: string;

  /** Names of plugins that must be installed before this one */
  readonly dependencies?: readonly string[];

  /**
   * Called once when the plugin is installed via em.extend(plugin).
   * May return an API object whose methods will be mixed into the EntityManager.
   */
  install(context: PluginContext): TApi | void;

  /**
   * Called during propagateShutdown() in reverse installation order.
   * Used to clean up plugin resources (timers, connections, caches).
   */
  shutdown?(): Promise<void> | void;
}
```

### EntityManager Plugin Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `extend` | `<TApi>(plugin): this & TApi` | Install a plugin and mix its API into the EntityManager |
| `hasPlugin` | `(name: string): boolean` | Check if a plugin is installed by name |
| `getPluginApi` | `<T>(name: string): T \| undefined` | Get a plugin's API object by name |

---

## Query Hooks -- beforeQuery / afterQuery

Plugins can intercept every SQL query executed by the EntityManager. This enables cross-cutting concerns like query logging, performance monitoring, or query transformation.

### beforeQuery

Called before every SQL query. Can inspect or transform the query before execution.

```typescript
const queryLogger: StingerloomPlugin = {
  name: "query-logger",

  beforeQuery(query) {
    console.log(`[SQL] ${query.operation}: ${query.sql}`);
    // Optionally return a modified QueryInfo to transform the query
  },

  afterQuery(query, result, durationMs) {
    if (durationMs > 1000) {
      console.warn(`[SLOW] ${query.sql} took ${durationMs}ms`);
    }
  },

  install(ctx) {
    // No methods to mix in -- hooks are detected automatically
  },
};
```

### QueryInfo shape

```typescript
interface QueryInfo {
  sql: string;         // The SQL query text
  params?: any[];      // Parameterized values
  operation?: string;  // "select" | "insert" | "update" | "delete" | "raw"
}
```

### How hooks fire

1. **beforeQuery** fires before the SQL is sent to the database. If it returns a `QueryInfo` object, the returned values replace the original query. If it returns `void`, the original query proceeds unchanged.
2. The query executes against the database.
3. **afterQuery** fires with the original query info, the raw driver result, and the execution time in milliseconds.

Hooks fire for **all** registered plugins in installation order. Each plugin's `beforeQuery` runs before the next, so a chain of plugins can compose transformations.

---

## Built-in Plugins

Stingerloom ships with two built-in plugins:

| Plugin | Import | Description |
|--------|--------|-------------|
| **Buffer (UoW)** | `bufferPlugin()` | Unit of Work -- tracks entity changes in memory and flushes them as a single atomic transaction. Identity Map, dirty checking, cascade, pessimistic locking, and more. |
| **Raw Pipeline** | `rawPipelinePlugin()` | Bypasses entity transformation for large-data scenarios. Streams raw rows or binary buffers directly from the database driver with batched pagination and transformation chaining. 4.4x faster than `em.find()` at 100K rows. |

See the dedicated guides:
- **[WriteBuffer (Unit of Work)](./write-buffer.md)**
- **[Raw Pipeline](./raw-pipeline.md)**

## Next Steps

- [WriteBuffer (Unit of Work)](./write-buffer.md) -- The built-in UoW plugin
- [Raw Pipeline](./raw-pipeline.md) -- Large-data streaming without entity overhead
- [EntityManager](./entity-manager.md) -- CRUD, pagination, and events
- [Transactions](./transactions.md) -- Manual and decorator-based transactions
- [API Reference](./api-reference.md) -- Full method signatures
