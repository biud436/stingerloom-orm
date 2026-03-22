# Migration CLI

Stingerloom provides a CLI tool for managing database migrations — running pending migrations, rolling back, checking status, and auto-generating migration files from schema diffs.

## Installation

The CLI is included in the `@stingerloom/orm` package and registered as the `stingerloom` binary.

```bash
npx stingerloom <command> [options]
```

## Commands

### migrate:run

Execute all pending migrations in order.

```bash
npx stingerloom migrate:run
```

Migrations are executed within an advisory lock to prevent concurrent runs. Each successfully applied migration is recorded in the `__migrations` tracking table.

### migrate:rollback

Revert the last applied migration.

```bash
npx stingerloom migrate:rollback
```

Calls the `down()` method of the most recently executed migration and removes its record from the tracking table.

### migrate:status

Show which migrations have been executed and which are still pending.

```bash
npx stingerloom migrate:status
```

Output:

```
Executed:
  ✓ 1711234567890_CreateUsersTable
  ✓ 1711234567891_AddPhoneToUsers

Pending:
  ○ 1711234567892_CreatePostsTable
```

### migrate:generate

Auto-generate a migration file by comparing your entity definitions against the current database schema.

```bash
npx stingerloom migrate:generate --output ./migrations --name add_posts
```

This runs `SchemaDiff` to detect changes (new tables, added/dropped/altered columns, renamed columns) and produces a timestamped migration file with both `up()` and `down()` methods.

## CLI Options

| Flag | Description | Default |
|------|-------------|---------|
| `--config <path>` | Path to config file | Auto-detected |
| `--output <dir>` | Output directory for generated migrations | `./migrations` |
| `--name <suffix>` | Name suffix for generated migration file | `auto_migration` |
| `--help`, `-h` | Show help | — |

## Configuration File

The CLI auto-detects configuration files in this order:

1. `stingerloom.config.ts`
2. `stingerloom.config.js`
3. `ormconfig.ts`
4. `ormconfig.js`

Or specify explicitly with `--config`.

### Config File Structure

```typescript
// stingerloom.config.ts
import { CreateUsersTable } from "./migrations/CreateUsersTable";
import { AddPhoneToUsers } from "./migrations/AddPhoneToUsers";
import { User } from "./entities/User";
import { Post } from "./entities/Post";

export default {
  connection: {
    type: "postgres",           // "postgres" | "mysql" | "sqlite"
    host: "localhost",
    port: 5432,
    username: "postgres",
    password: "password",
    database: "mydb",
    entities: [User, Post],     // Required for migrate:generate
  },
  migrations: [
    new CreateUsersTable(),
    new AddPhoneToUsers(),
  ],
};
```

> **Note** TypeScript config files require `ts-node` or `tsx` to be installed. The CLI tries `ts-node/register` first, then falls back to `tsx/cjs`.

## Writing Migrations

Each migration is a class that extends `Migration` and implements `up()` and `down()`:

```typescript
import { Migration, MigrationContext } from "@stingerloom/orm";

export class CreateUsersTable extends Migration {
  async up({ query, driver }: MigrationContext) {
    await query(`
      CREATE TABLE ${driver.escapeIdentifier("users")} (
        ${driver.escapeIdentifier("id")} SERIAL PRIMARY KEY,
        ${driver.escapeIdentifier("name")} VARCHAR(255) NOT NULL,
        ${driver.escapeIdentifier("email")} VARCHAR(255) NOT NULL UNIQUE,
        ${driver.escapeIdentifier("created_at")} TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  async down({ query, driver }: MigrationContext) {
    await query(`DROP TABLE IF EXISTS ${driver.escapeIdentifier("users")}`);
  }
}
```

The `MigrationContext` provides:

| Property | Type | Description |
|----------|------|-------------|
| `driver` | `ISqlDriver` | Database driver with `escapeIdentifier()` and DDL helpers |
| `query` | `(sql: string) => Promise<any>` | Execute arbitrary SQL |

## Migration Tracking

The CLI automatically creates a `__migrations` table to track which migrations have been applied:

```sql
CREATE TABLE "__migrations" (
  "id"          SERIAL PRIMARY KEY,
  "name"        VARCHAR(255) NOT NULL UNIQUE,
  "executed_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## Concurrency Safety

Migrations use database advisory locks to prevent concurrent execution:

- **PostgreSQL:** `pg_advisory_lock()` / `pg_advisory_unlock()`
- **MySQL:** `GET_LOCK()` / `RELEASE_LOCK()`

If another migration process is already running, the CLI waits up to 10 seconds before throwing an `AdvisoryLockError`.

## Programmatic API — MigrationCli

For custom tooling or CI/CD pipelines, use `MigrationCli` directly:

```typescript
import { MigrationCli } from "@stingerloom/orm";
import { CreateUsersTable } from "./migrations/CreateUsersTable";

const cli = new MigrationCli(
  [new CreateUsersTable()],
  {
    type: "postgres",
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USER ?? "postgres",
    password: process.env.DB_PASS ?? "password",
    database: process.env.DB_NAME ?? "mydb",
    entities: [],
  },
);

await cli.connect();

// Run pending migrations
const results = await cli.migrateRun();
console.log(results); // [{ name: "CreateUsersTable", direction: "up", success: true }]

// Check status
const status = await cli.migrateStatus();
console.log(status.executed); // ["CreateUsersTable"]
console.log(status.pending);  // []

// Rollback
await cli.migrateRollback();

// Auto-generate from schema diff
cli.setGenerateOptions({ outputDir: "./migrations", name: "add_posts" });
const { filePath, sql } = await cli.migrateGenerate();
console.log(`Generated: ${filePath}`);

await cli.close();
```

### MigrationCli Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `connect()` | `Promise<void>` | Establish DB connection |
| `close()` | `Promise<void>` | Close DB connection |
| `execute(command)` | `Promise<...>` | Execute a command by name |
| `migrateRun()` | `Promise<MigrationResult[]>` | Execute pending migrations |
| `migrateRollback()` | `Promise<MigrationResult[]>` | Rollback last migration |
| `migrateStatus()` | `Promise<{executed, pending}>` | Get migration status |
| `migrateGenerate()` | `Promise<{filePath, sql}>` | Auto-generate migration |
| `setGenerateOptions(opts)` | `this` | Set output dir and name |

## Schema Diff Auto-Generation

The `migrate:generate` command compares your entity definitions against the live database and detects:

- **New tables** — entities not yet in the database
- **Dropped tables** — tables with no matching entity (opt-in via `detectDroppedTables`)
- **Added columns** — new `@Column()` decorators
- **Dropped columns** — columns removed from entities
- **Altered columns** — type, length, nullable, or precision changes
- **Renamed columns** — intelligently matched by type and table (generates `RENAME COLUMN` instead of drop + add)

```bash
npx stingerloom migrate:generate --output ./migrations
```

The generated file contains both `up()` (apply changes) and `down()` (revert changes) methods with proper DDL statements.

## Next Steps

- [Migrations](./migrations.md) — Migration concepts and transition from `synchronize`
- [Production Guide](./production-guide.md) — Zero-downtime migration strategies
- [Configuration](./configuration.md) — Database connection options
