# Plugins

Stingerloom ORM has a plugin system that lets you add optional features to EntityManager without bloating the core. Plugins are installed with `em.extend()` — similar to how `dayjs.extend()` works.

## Installing a Plugin

Call `em.extend()` with a plugin object. The plugin's methods are mixed into the EntityManager instance.

```typescript
import { EntityManager } from "@stingerloom/orm";

const em = new EntityManager();
em.extend(myPlugin());
```

You can also pass plugins via the `plugins` option in `register()`.

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

Installing the same plugin twice is a no-op — `extend()` is idempotent.

## Writing a Custom Plugin

A plugin is an object with a `name` and an `install()` function. `install()` receives a `PluginContext` and optionally returns an API object whose methods are mixed into the EntityManager.

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

  // Optional: clean up resources on shutdown
  shutdown() {
    // called during em.propagateShutdown()
  },
};

em.extend(timestampLogger);
em.getLog(); // typed!
```

### PluginContext

The `install()` function receives a `PluginContext` with controlled access to EntityManager internals.

| Property / Method | Description |
|-------------------|-------------|
| `ctx.em` | The EntityManager instance |
| `ctx.driver` | Current SQL driver (`undefined` before `register()`) |
| `ctx.events` | Entity event emitter (`on`, `off`, `emit`) |
| `ctx.connectionName` | Connection name (default: `"default"`) |
| `ctx.addSubscriber(sub)` | Register an EntitySubscriber |
| `ctx.removeSubscriber(sub)` | Remove an EntitySubscriber |
| `ctx.getEntities()` | All registered entity classes |
| `ctx.getPlugin(name)` | Access another plugin's API |
| `ctx.isMySqlFamily()` | Check if driver is MySQL/MariaDB |
| `ctx.isPostgres()` | Check if driver is PostgreSQL |
| `ctx.isSqlite()` | Check if driver is SQLite |
| `ctx.wrap(identifier)` | Quote an identifier with the driver's style |
| `ctx.wrapTable(tableName)` | Quote a table name (with schema prefix) |
| `ctx.executeInTransaction(fn)` | Run a callback in a transaction |
| `ctx.executeReadOnly(fn)` | Run a callback in a read-only transaction |

### Plugin Dependencies

A plugin can declare dependencies on other plugins. If a dependency is not installed, `extend()` throws.

```typescript
const derivedPlugin: StingerloomPlugin = {
  name: "derived",
  dependencies: ["base-plugin"],

  install(ctx) {
    const baseApi = ctx.getPlugin<{ getData(): any[] }>("base-plugin");
    // use baseApi...
  },
};

// This throws — "base-plugin" is not installed
em.extend(derivedPlugin);

// This works
em.extend(basePlugin());
em.extend(derivedPlugin);
```

### Method Name Conflicts

If a plugin tries to add a method that already exists on EntityManager (like `find` or `save`), `extend()` throws a `PLUGIN_CONFLICT` error. Choose a unique name for your plugin's API methods.

## API Reference

### StingerloomPlugin\<TApi\>

```typescript
interface StingerloomPlugin<TApi = {}> {
  readonly name: string;
  readonly dependencies?: readonly string[];
  install(context: PluginContext): TApi | void;
  shutdown?(): Promise<void> | void;
}
```

### EntityManager Plugin Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `extend` | `<TApi>(plugin): this & TApi` | Install a plugin |
| `hasPlugin` | `(name: string): boolean` | Check if a plugin is installed |
| `getPluginApi` | `<T>(name: string): T \| undefined` | Get a plugin's API by name |

## Built-in Plugins

Stingerloom ships with one built-in plugin:

| Plugin | Import | Description |
|--------|--------|-------------|
| **Buffer (UoW)** | `bufferPlugin()` | Unit of Work — tracks entity changes in memory and flushes them as a single atomic transaction. Identity Map, dirty checking, cascade, pessimistic locking, and more. |

See the dedicated guide: **[WriteBuffer (Unit of Work)](./write-buffer.md)**

## Next Steps

- [WriteBuffer (Unit of Work)](./write-buffer.md) — The built-in UoW plugin
- [EntityManager](./entity-manager.md) — CRUD, pagination, and events
- [Transactions](./transactions.md) — Manual and decorator-based transactions
- [API Reference](./api-reference.md) — Full method signatures
