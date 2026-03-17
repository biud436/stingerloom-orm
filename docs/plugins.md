# Plugins

Stingerloom ORM has a plugin system that lets you add optional features to EntityManager without bloating the core. Plugins are installed with `em.extend()` — similar to how `dayjs.extend()` works.

The ORM ships with the **Mutation Plugin** as the first built-in plugin. You can also write your own.

## Installing a Plugin

Call `em.extend()` with a plugin object. The plugin's methods are mixed into the EntityManager instance.

```typescript
import { EntityManager, mutationPlugin } from "@stingerloom/orm";

const em = new EntityManager();
em.extend(mutationPlugin());

// Now em.mutate() is available
const mut = em.mutate();
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
  plugins: [mutationPlugin()],
});

// em.mutate() is ready
```

Installing the same plugin twice is a no-op — `extend()` is idempotent.

## Mutation Plugin

The Mutation Plugin adds entity change tracking and batch flush to EntityManager. Instead of calling `save()`, `updateMany()`, and `delete()` one at a time, you accumulate changes and flush them all in a single transaction.

### Basic Usage

```typescript
import { mutationPlugin } from "@stingerloom/orm";

em.extend(mutationPlugin());

const mut = em.mutate();

// 1. Load an entity — mut.findOne() auto-tracks it
const user = await mut.findOne(User, { where: { id: 1 } });

// 2. Modify it — just change properties
user.name = "Updated Name";
user.email = "new@example.com";

// 3. Queue new inserts and deletes
mut.save(Comment, { body: "Great post!", postId: 42 });
mut.delete(Tag, { id: 5 });

// 4. Flush — all operations execute atomically
const result = await mut.flush();
// BEGIN → UPDATE user → INSERT comment → DELETE tag → COMMIT

console.log(result);
// { updates: 1, inserts: 1, deletes: 1 }
```

`mut.findOne()` and `mut.find()` work exactly like their EntityManager counterparts, but automatically track the loaded entities. No manual `track()` calls needed.

`flush()` wraps everything in `em.transaction()`. If any operation fails, the entire batch is rolled back and your mutation state is preserved for retry.

> **Hint** You can still use `mut.track(entity)` directly if you already have an entity instance from elsewhere (e.g., loaded via `em.find()` or passed from another layer).

### Dirty Checking

When an entity is tracked (via `mut.findOne()`, `mut.find()`, or `mut.track()`), the plugin takes a snapshot of its column values. When you call `dirty()` or `flush()`, it compares the current values against the snapshot to detect changes.

```typescript
const user = await mut.findOne(User, { where: { id: 1 } });

mut.dirty(); // [] — nothing changed yet

user.name = "Alice";
mut.dirty(); // [user] — name changed

user.name = "Original Name"; // revert
mut.dirty(); // [] — back to snapshot
```

The comparison uses deep equality for objects and arrays, and `.getTime()` for Date fields. PK columns are excluded from dirty checking — they identify the row, not a mutation.

### Preview Before Flush

`preview()` returns the operations that would execute on `flush()`, without touching the database.

```typescript
const preview = mut.preview();
// [
//   { action: "update", entity: "User", where: { id: 1 }, data: { name: "Alice" } },
//   { action: "insert", entity: "Comment", data: { body: "Great post!", postId: 42 } },
//   { action: "delete", entity: "Tag", criteria: { id: 5 } },
// ]
```

The order is always **updates → inserts → deletes**.

### Accumulate → Flush → Accumulate → Flush

By default, `flush()` re-snapshots tracked entities after a successful commit. This lets you keep accumulating changes and flushing again.

```typescript
const user = await mut.findOne(User, { where: { id: 1 } });

// First batch
user.name = "Step 1";
await mut.flush(); // UPDATE committed

// Second batch — snapshot was refreshed
user.name = "Step 2";
user.email = "step2@example.com";
await mut.flush(); // Another UPDATE committed
```

To clear all tracked state after flush instead, pass `retainAfterFlush: false`.

```typescript
em.extend(mutationPlugin({ retainAfterFlush: false }));
```

### Managing Tracked State

```typescript
// Check what's tracked
mut.tracked();   // [user1, user2, ...]

// Remove a specific entity from tracking
mut.untrack(user1);

// Clear everything — tracked entities, queued inserts, queued deletes
mut.clear();

// Check counts
mut.size();
// { tracked: 2, inserts: 1, deletes: 0 }
```

### Error Handling

If the plugin is not installed, `em.mutate()` throws an error with a clear message.

```typescript
const em = new EntityManager();
em.mutate(); // throws: "mutate() requires the mutation plugin to be installed"
```

If `flush()` fails (e.g., a constraint violation), the mutation state is preserved so you can fix the issue and retry.

```typescript
try {
  await mut.flush();
} catch (error) {
  // Mutation state is intact — fix the issue and retry
  console.log(mut.dirty());  // still has dirty entities
  console.log(mut.size());   // queued inserts/deletes still present
  await mut.flush();          // retry
}
```

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
  dependencies: ["mutation"], // requires mutation plugin

  install(ctx) {
    const mutationApi = ctx.getPlugin<{ mutate(): Mutation }>("mutation");
    // use mutationApi...
  },
};

// This throws — "mutation" is not installed
em.extend(derivedPlugin);

// This works
em.extend(mutationPlugin());
em.extend(derivedPlugin);
```

### Method Name Conflicts

If a plugin tries to add a method that already exists on EntityManager (like `find` or `save`), `extend()` throws a `PLUGIN_CONFLICT` error. Choose a unique name for your plugin's API methods.

## API Reference

### mutationPlugin()

```typescript
function mutationPlugin(options?: MutationPluginOptions):
  StingerloomPlugin<{ mutate(): Mutation }>;

interface MutationPluginOptions {
  retainAfterFlush?: boolean; // default: true
}
```

### Mutation

| Method | Signature | Description |
|--------|-----------|-------------|
| `findOne` | `<T>(entity, option): Promise<T \| null>` | Load one entity + auto-track |
| `find` | `<T>(entity, option?): Promise<T[]>` | Load entities + auto-track all |
| `track` | `(instance: any): this` | Manually track an existing entity |
| `save` | `(entity, data): this` | Queue an INSERT |
| `delete` | `(entity, criteria): this` | Queue a DELETE |
| `tracked` | `(): any[]` | All tracked instances |
| `dirty` | `(): any[]` | Tracked instances with changes |
| `untrack` | `(instance): this` | Remove from tracking |
| `clear` | `(): this` | Reset all state |
| `size` | `(): { tracked, inserts, deletes }` | Count of pending operations |
| `preview` | `(): MutationPreviewEntry[]` | Preview flush operations |
| `flush` | `(): Promise<MutationFlushResult>` | Execute all pending operations atomically |

### MutationFlushResult

```typescript
interface MutationFlushResult {
  updates: number;
  inserts: number;
  deletes: number;
}
```

### MutationPreviewEntry

```typescript
type MutationPreviewEntry =
  | { action: "update"; entity: string; where: Record<string, any>; data: Record<string, any> }
  | { action: "insert"; entity: string; data: Record<string, any> }
  | { action: "delete"; entity: string; criteria: Record<string, any> };
```

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

## Next Steps

- [EntityManager](./entity-manager.md) — CRUD, pagination, and events
- [Transactions](./transactions.md) — Manual and decorator-based transactions
- [API Reference](./api-reference.md) — Full method signatures
