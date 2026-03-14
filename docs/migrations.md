# Migrations

While `synchronize: true` is convenient during development, it is dangerous in production. Automatically changing tables with existing data based solely on entity definitions can result in data loss.

**Migrations** are a way to write schema changes as code and version-control them. You can track "when and what changed," and roll back if something goes wrong.

## Creating a Migration File

A migration extends the `Migration` class and implements `up()` and `down()` methods.

- **`up()`** — Apply the change (e.g., create table, add column)
- **`down()`** — Revert the change (e.g., drop table, drop column)

```typescript
// migrations/001_CreateUsersTable.ts
import { Migration, MigrationContext } from "@stingerloom/orm";

export class CreateUsersTable extends Migration {
  async up(context: MigrationContext) {
    await context.query(`
      CREATE TABLE IF NOT EXISTS "users" (
        "id" SERIAL PRIMARY KEY,
        "name" VARCHAR(100) NOT NULL,
        "email" VARCHAR(255) NOT NULL UNIQUE,
        "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  async down(context: MigrationContext) {
    await context.query(`DROP TABLE IF EXISTS "users"`);
  }
}
```

`MigrationContext` provides two things.

| Property | Description |
|----------|-------------|
| `context.query(sql)` | Executes arbitrary SQL |
| `context.driver` | Access to the DB driver (DDL helpers, etc.) |

## Creating More Migrations

### Adding a Column

```typescript
// migrations/002_AddPhoneToUsers.ts
export class AddPhoneToUsers extends Migration {
  async up(context: MigrationContext) {
    await context.query(
      `ALTER TABLE "users" ADD COLUMN "phone" VARCHAR(20) NULL`
    );
  }

  async down(context: MigrationContext) {
    await context.query(
      `ALTER TABLE "users" DROP COLUMN "phone"`
    );
  }
}
```

### Adding an Index

```typescript
// migrations/003_AddEmailIndex.ts
export class AddEmailIndex extends Migration {
  async up(context: MigrationContext) {
    await context.query(
      `CREATE INDEX "idx_users_email" ON "users" ("email")`
    );
  }

  async down(context: MigrationContext) {
    await context.query(
      `DROP INDEX "idx_users_email"`
    );
  }
}
```

### Seeding Initial Data

```typescript
// migrations/004_SeedRoles.ts
export class SeedRoles extends Migration {
  async up(context: MigrationContext) {
    await context.query(`
      INSERT INTO "roles" ("name", "description") VALUES
      ('admin', 'Administrator'),
      ('user', 'Regular user'),
      ('guest', 'Guest')
    `);
  }

  async down(context: MigrationContext) {
    await context.query(
      `DELETE FROM "roles" WHERE "name" IN ('admin', 'user', 'guest')`
    );
  }
}
```

## Running Migrations

### Using MigrationCli (Recommended)

`MigrationCli` handles DB connection and migration execution all at once.

```typescript
// src/migrate.ts
import { MigrationCli } from "@stingerloom/orm";
import { CreateUsersTable } from "./migrations/001_CreateUsersTable";
import { AddPhoneToUsers } from "./migrations/002_AddPhoneToUsers";
import { AddEmailIndex } from "./migrations/003_AddEmailIndex";

const migrations = [
  new CreateUsersTable(),
  new AddPhoneToUsers(),
  new AddEmailIndex(),
];

const cli = new MigrationCli(migrations, {
  type: "postgres",
  host: "localhost",
  port: 5432,
  username: "postgres",
  password: "password",
  database: "mydb",
  entities: [],
});

async function main() {
  await cli.connect();

  const command = process.argv[2]; // "migrate:run" | "migrate:rollback" | "migrate:status"
  try {
    const result = await cli.execute(command as any);
    console.log(result);
  } finally {
    await cli.close();
  }
}

main().catch(console.error);
```

Registering scripts in package.json is convenient.

```json
{
  "scripts": {
    "migrate:run": "ts-node ./src/migrate.ts migrate:run",
    "migrate:rollback": "ts-node ./src/migrate.ts migrate:rollback",
    "migrate:status": "ts-node ./src/migrate.ts migrate:status",
    "migrate:generate": "ts-node ./src/migrate.ts migrate:generate"
  }
}
```

Now run from the terminal.

```bash
# Apply all pending migrations
pnpm migrate:run

# Roll back the last migration
pnpm migrate:rollback

# Check current status
pnpm migrate:status

# Auto-generate a migration from entity/schema diff (see below)
pnpm migrate:generate
```

Stingerloom automatically creates a `__migrations` table to track which migrations have been executed.

## Checking Migration Results

You can verify the success/failure status of each migration.

```typescript
const results = await cli.migrateRun();

for (const result of results) {
  if (result.success) {
    console.log(`[OK] ${result.name}`);
  } else {
    console.error(`[FAIL] ${result.name}: ${result.error}`);
  }
}
```

## File Naming Convention

Migrations are executed in the order they are registered in the array. Add sequence numbers to filenames to clearly express the order.

```
migrations/
├── 001_CreateUsersTable.ts
├── 002_CreatePostsTable.ts
├── 003_AddPhoneToUsers.ts
├── 004_AddEmailIndex.ts
└── 005_SeedRoles.ts
```

## Schema Diff — Automatic Migration Generation

Instead of writing migration files manually, you can automatically generate them by comparing entity definitions with the actual DB schema.

### Using the CLI — migrate:generate

The simplest way to generate a migration is through the `migrate:generate` CLI command. It compares the current entity definitions against the live database schema and produces a migration file for any differences.

```bash
pnpm migrate:generate
```

This will:
1. Connect to the database using the configured options.
2. Run `SchemaDiff.compare()` against all registered entities.
3. If differences are found, generate a timestamped migration class with the appropriate `up()` and `down()` methods.
4. Print the generated migration to the console (or write it to the migrations directory if configured).

If the schema is already in sync, it prints "No schema changes" and exits.

### Step 1: Compare Differences (Programmatic API)

```typescript
import { SchemaDiff } from "@stingerloom/orm";

const diff = await SchemaDiff.compare(em, [User, Post, Comment]);

console.log(diff.addedTables);    // ["comment"] — Newly added tables
console.log(diff.droppedTables);  // [] — Dropped tables
console.log(diff.modifiedTables); // [{ tableName: "user", addedColumns: [...] }]
```

### Step 2: Generate and Execute Migration

```typescript
import { SchemaDiff, SchemaDiffMigrationGenerator } from "@stingerloom/orm";

// Compare differences
const diff = await SchemaDiff.compare(em, [User, Post]);

// Exit if no changes
if (diff.addedTables.length === 0 &&
    diff.droppedTables.length === 0 &&
    diff.modifiedTables.length === 0) {
  console.log("No schema changes");
  return;
}

// Auto-generate migrations
const generator = new SchemaDiffMigrationGenerator();
const migrations = generator.generate(diff);

console.log(`${migrations.length} migrations generated`);
```

For example, if you added a `phone` column to the User entity, the following migration is automatically generated.

```typescript
// Auto-generated migration
class SchemaDiff_1708000000000 extends Migration {
  async up(context: MigrationContext) {
    await context.query(
      `ALTER TABLE "users" ADD COLUMN "phone" VARCHAR(20) NULL`
    );
  }
  async down(context: MigrationContext) {
    await context.query(
      `ALTER TABLE "users" DROP COLUMN "phone"`
    );
  }
}
```

> **Hint** Schema Diff detects additions and deletions of tables and columns. Column type changes are not supported, so write those as manual migrations.

## MigrationRunner API

| Method | Description |
|--------|-------------|
| `run(migrations?)` | Execute pending migrations in order |
| `rollback(n?)` | Roll back the last n migrations (default: 1) |
| `status()` | Returns `{ executed: string[], pending: string[] }` |
| `runAll()` | Execute all pending migrations |
| `runUp(migration)` | Apply a single migration |
| `runDown(migration)` | Revert a single migration |
| `revertLast()` | Revert the last migration |
| `getPendingMigrations()` | Return the list of pending migrations |
| `getExecutedMigrations()` | Return the list of executed migrations |

## Next Steps

- [Configuration Guide](./configuration.md) — Pooling, timeouts, Read Replica settings
- [Multi-Tenancy](./multi-tenancy.md) — Automatic schema provisioning per tenant
- [EntityManager](./entity-manager.md) — Full CRUD API reference
