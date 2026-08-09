# Database Seeding

## Why Seeding Exists

Migrations give your database its structure -- tables, columns, indexes, foreign keys. But structure alone is not enough. When a new developer clones your project and runs migrations, they get an empty database. No admin user to log in with. No default roles. No sample data to test against. They have to set everything up by hand before they can even start working.

Think of it like moving into a new apartment. Migrations are the construction crew -- they build the walls, install the plumbing, wire the electricity. But when you walk in, every room is empty. Seeding is the furniture delivery. It fills those rooms with the things you need to actually live there: a bed, a desk, a kitchen table.

Seeding solves several real problems:

- **Development setup.** A new developer runs one command and gets a working database with test users, sample posts, and default categories.
- **Test fixtures.** Your test suite needs predictable data to run against. Seeders provide it.
- **Demo environments.** Your sales team needs a demo database that looks realistic. Seeders populate it.
- **Multi-tenant initial data.** When you provision a new tenant, you need default roles, settings, and templates.

Stingerloom provides a dedicated seeding system that is separate from migrations. This separation matters because migrations are about schema (the shape of your data), while seeders are about content (the data itself). Mixing the two makes it harder to reason about each one independently.

---

## Creating a Seeder

A seeder is a class that extends the abstract `Seeder` base class. It has one required method: `run()`. This method receives a `SeederContext` with an `EntityManager`, so you can use the full ORM API to insert data.

```typescript
import { Seeder, SeederContext } from "@stingerloom/orm";
import { User } from "./entities/user.entity";

class AdminUserSeeder extends Seeder {
  async run(ctx: SeederContext): Promise<void> {
    await ctx.em.save(User, {
      name: "Admin",
      email: "admin@example.com",
      role: "admin",
    });
  }
}
```

Let us trace what happens here:

1. The `SeederRunner` creates a `SeederContext` containing the `EntityManager`.
2. It calls `seeder.run(ctx)`.
3. Inside `run()`, you use `ctx.em.save()` to insert an admin user -- exactly the same API you use everywhere else in the ORM.
4. The seeder finishes. The runner records that `AdminUserSeeder` has been executed.

The seeder's `name` property defaults to the class name (`"AdminUserSeeder"`). This name is used for tracking, so each seeder class should have a unique name.

### The SeederContext

The context is intentionally simple:

| Property | Type | Description |
|----------|------|-------------|
| `em` | `EntityManager` | The EntityManager instance, connected to the database |

You have access to the full EntityManager API: `save()`, `find()`, `delete()`, `query()`, and everything else. This means your seeders can use relations, transactions, and any other ORM feature.

---

## Running Seeders

The `SeederRunner` manages the execution of your seeders. It works similarly to the `MigrationRunner` -- it tracks which seeders have been executed and only runs pending ones.

### Basic Setup

```typescript
import { EntityManager, SeederRunner, Seeder, SeederContext } from "@stingerloom/orm";

// Define your seeders
class RoleSeeder extends Seeder {
  async run(ctx: SeederContext): Promise<void> {
    for (const name of ["admin", "editor", "viewer"]) {
      await ctx.em.save(Role, { name });
    }
  }
}

class DefaultUserSeeder extends Seeder {
  async run(ctx: SeederContext): Promise<void> {
    await ctx.em.save(User, {
      name: "Admin",
      email: "admin@example.com",
      role: "admin",
    });
  }
}

// Create the runner
const seeders = [new RoleSeeder(), new DefaultUserSeeder()];
const runner = new SeederRunner(seeders, em, { query: (sql) => driver.query(sql) });

// Ensure the tracking table exists
await runner.ensureSeedTable();

// Run all pending seeders
const results = await runner.runAll();

for (const result of results) {
  if (result.success) {
    console.log(`[OK] ${result.name}`);
  } else {
    console.error(`[FAIL] ${result.name}: ${result.error}`);
  }
}
```

### How Tracking Works

When you call `ensureSeedTable()`, the runner creates a `__seeds` table in your database. This is the seeder equivalent of the `__migrations` table -- it records which seeders have been executed so they are not run again.

For PostgreSQL:

```sql
CREATE TABLE IF NOT EXISTS "__seeds" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL UNIQUE,
  "executed_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

For SQLite (`SERIAL` is not an auto-increment type there, so the id column
uses the rowid alias form instead):

```sql
CREATE TABLE IF NOT EXISTS "__seeds" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "name" VARCHAR(255) NOT NULL UNIQUE,
  "executed_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

For MySQL:

```sql
CREATE TABLE IF NOT EXISTS `__seeds` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL UNIQUE,
  `executed_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

When a seeder runs successfully, a row is inserted:

```sql
INSERT INTO "__seeds" ("name") VALUES ('RoleSeeder');
```

The next time you call `runAll()`, the runner checks this table and skips `RoleSeeder` because it has already been executed. Only `DefaultUserSeeder` (if pending) would run.

### Checking Status

You can inspect which seeders have been executed and which are still pending:

```typescript
const status = await runner.status();

console.log("Executed:", status.executed);
// ["RoleSeeder"]

console.log("Pending:", status.pending);
// ["DefaultUserSeeder"]
```

### Running a Single Seeder

If you need to run one specific seeder (perhaps during development), use `runOne()`:

```typescript
const result = await runner.runOne(new DefaultUserSeeder());
console.log(result.success); // true
```

Note that `runOne()` still records the execution in the tracking table, so the seeder will not be run again by `runAll()`.

### Disabling Tracking

Sometimes you want seeders to run every time -- for example, when populating a test database that is dropped and recreated for each test run. Set `trackExecution: false`:

```typescript
const runner = new SeederRunner(seeders, em, queryRunner, {
  trackExecution: false,
});

// This will run ALL seeders every time, regardless of previous executions
await runner.runAll();
```

### Custom Table Name

If `__seeds` conflicts with something in your schema, you can change it:

```typescript
const runner = new SeederRunner(seeders, em, queryRunner, {
  tableName: "_seed_history",
});
```

---

## Reversible Seeders

Seeders can optionally implement a `revert()` method. This lets you undo seeded data -- useful when you need to reset a development database or clean up after a demo.

```typescript
class RoleSeeder extends Seeder {
  private readonly roles = ["admin", "editor", "viewer"];

  async run(ctx: SeederContext): Promise<void> {
    for (const name of this.roles) {
      await ctx.em.save(Role, { name });
    }
  }

  async revert(ctx: SeederContext): Promise<void> {
    for (const name of this.roles) {
      await ctx.em.delete(Role, { name });
    }
  }
}
```

To revert the most recently executed seeder:

```typescript
const result = await runner.revertLast();

if (result === null) {
  console.log("Nothing to revert.");
} else if (result.success) {
  console.log(`Reverted: ${result.name}`);
} else {
  console.error(`Revert failed: ${result.error}`);
}
```

When a seeder is reverted, its row is removed from the `__seeds` table. This means the next call to `runAll()` will execute it again.

If a seeder does not implement `revert()`, calling `revertLast()` when that seeder is the most recent will return a failure result with an explanatory error message. It will not skip to the next seeder -- you need to handle this case explicitly.

---

## API Reference

### Seeder (abstract class)

| Property / Method | Description |
|-------------------|-------------|
| `name` | Seeder name (defaults to class name). Used for tracking. |
| `run(ctx)` | **Required.** Insert seed data. Receives a `SeederContext` with the EntityManager. |
| `revert(ctx)` | **Optional.** Remove seed data. Called by `revertLast()`. |

### SeederContext

| Property | Type | Description |
|----------|------|-------------|
| `em` | `EntityManager` | The connected EntityManager instance |

### SeederRunner

| Method | Signature | Description |
|--------|-----------|-------------|
| `ensureSeedTable()` | `(): Promise<void>` | Create the tracking table if it does not exist |
| `runAll()` | `(): Promise<SeederResult[]>` | Run all pending seeders in order. Stops on first failure. |
| `runOne(seeder)` | `(seeder: Seeder): Promise<SeederResult>` | Run a single seeder |
| `revertLast()` | `(): Promise<SeederResult \| null>` | Revert the most recently executed seeder. Returns null if none executed. |
| `status()` | `(): Promise<{ executed: string[]; pending: string[] }>` | Show executed and pending seeders |
| `getExecutedSeeds()` | `(): Promise<string[]>` | Return names of executed seeders |

### SeederRunnerOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `trackExecution` | `boolean` | `true` | Whether to track execution in the `__seeds` table |
| `tableName` | `string` | `"__seeds"` | Name of the seed tracking table |

### SeederResult

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Seeder name |
| `direction` | `"run" \| "revert"` | Whether this was a run or revert operation |
| `success` | `boolean` | Whether the operation succeeded |
| `error` | `string \| undefined` | Error message if the operation failed |

---

## Next Steps

- [Migrations](./migrations.md) -- Version-controlled schema changes
- [EntityManager](./entity-manager.md) -- The full CRUD API used inside seeders
- [Configuration](./configuration.md) -- Database connection setup
