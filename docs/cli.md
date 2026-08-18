# Migration CLI

## Why Migrations Exist

During development, `synchronize: true` is convenient -- you change an entity, restart your app, and the ORM updates the database to match. But in production, this is dangerous. Imagine deploying a change that renames a column: `synchronize` would drop the old column (and all its data) and create a new empty one.

Migrations solve this by making database changes **explicit and reviewable**. Instead of the ORM silently altering your schema, you get a file that says exactly what will change. You review it, test it, and only then apply it to production. If something goes wrong, you can roll back.

Think of it like version control for your database schema. Every migration is a commit that moves your schema forward (or backward).

## The Migration Workflow -- A Story

Here is what a typical migration workflow looks like, from start to finish.

**1. You change an entity.** You add a `phone` column to your `User` class:

```typescript
@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Column()
  email!: string;

  @Column({ nullable: true })  // <-- new column
  phone!: string;
}
```

**2. You generate a migration.** The CLI compares your entity definitions against the live database and produces a migration file:

```bash
npx stingerloom migrate:generate --name add_phone_to_users
```

This creates a file like `migrations/1711234567892_add_phone_to_users.ts` with the exact DDL needed:

```typescript
import { Migration, MigrationContext } from "@stingerloom/orm";

export class AddPhoneToUsers1711234567892 extends Migration {
  async up({ query, driver }: MigrationContext) {
    await query(
      `ALTER TABLE ${driver.escapeIdentifier("user")} ADD COLUMN ${driver.escapeIdentifier("phone")} VARCHAR(255)`
    );
  }

  async down({ query, driver }: MigrationContext) {
    await query(
      `ALTER TABLE ${driver.escapeIdentifier("user")} DROP COLUMN ${driver.escapeIdentifier("phone")}`
    );
  }
}
```

**3. You review the migration.** Open the file, read the SQL, make sure it does what you expect. This is your safety net.

**4. You apply the migration.**

```bash
npx stingerloom migrate:run
```

The CLI executes the `up()` method and records the migration in a tracking table so it won't run again.

**5. If something goes wrong, you roll back.**

```bash
npx stingerloom migrate:rollback
```

This calls the `down()` method, which reverses the change.

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

Migrations are executed within an advisory lock to prevent concurrent runs (more on this below). Each successfully applied migration is recorded in the `__migrations` tracking table.

### migrate:rollback

Revert the last applied migration.

```bash
npx stingerloom migrate:rollback
```

Calls the `down()` method of the most recently executed migration and removes its record from the tracking table. Only one migration is rolled back at a time -- run the command multiple times to roll back further.

### migrate:status

Show which migrations have been executed and which are still pending.

```bash
npx stingerloom migrate:status
```

Here is what the output looks like:

```
Migration Status
================

Executed:
  [2026-03-01 14:23:01]  CreateUsersTable
  [2026-03-05 09:15:32]  AddPhoneToUsers

Pending:
  CreatePostsTable
  AddCategoryToPosts

Summary: 2 executed, 2 pending
```

The "Executed" list shows migrations that have already been applied, with the timestamp of when they ran. The "Pending" list shows migrations that exist in your code but have not been applied to this database yet. Running `migrate:run` will execute them in order.

### migrate:generate

Auto-generate a migration file by comparing your entity definitions against the current database schema.

```bash
npx stingerloom migrate:generate --output ./migrations --name add_posts
```

This runs `SchemaDiff` to detect changes and produces a timestamped migration file with both `up()` and `down()` methods.

## CLI Options

| Flag | Description | Default |
|------|-------------|---------|
| `--config <path>` | Path to config file | Auto-detected |
| `--output <dir>` | Output directory for generated migrations | `./migrations` |
| `--name <suffix>` | Name suffix for generated migration file | `auto_migration` |
| `--version` | Print the installed `@stingerloom/orm` version | -- |
| `--help`, `-h` | Show help | -- |

`--flag=value` is accepted as an alias for `--flag value`. An unrecognised flag is an error, not a silent no-op: `stingerloom introspect --dry-runn` stops with `Unknown option: "--dry-runn"` instead of writing entity files with the typo ignored.

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | The command succeeded |
| `1` | The command failed |

Exit code 1 covers every failure the CLI can observe, including the one that is *not* an exception: a migration whose `up()` threw is recorded as a failed result and reported as `Migration failed: <name> (up) — <error>`, and the process exits 1. This is what makes the usual CI chain safe:

```bash
npx stingerloom migrate:run && ./deploy.sh   # deploy only runs if every migration applied
```

Also exit 1: a config file that cannot be found, loaded, or parsed; a config whose `type` is missing or unsupported; an unknown command, an unknown option, or a missing option value. Errors are printed as a message and, where one applies, a suggestion -- not as a stack trace. `migrate:run` with nothing pending is a success (exit 0), as is `migrate:rollback` with nothing to roll back.

The database connection is closed before the process exits on every path, including failures.

## Configuration File

The CLI auto-detects configuration files in this order:

1. `stingerloom.config.ts`
2. `stingerloom.config.js`
3. `stingerloom.config.mjs` / `stingerloom.config.cjs`
4. `ormconfig.ts`
5. `ormconfig.js`
6. `ormconfig.mjs` / `ormconfig.cjs`

Or specify explicitly with `--config`. ES module configs work on every supported Node version — in a `"type": "module"` project, a plain `.js` config with `export default {...}` is loaded via dynamic `import()` when `require()` cannot handle it.

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

The `entities` array is only needed for `migrate:generate` -- that is how the CLI knows what your schema *should* look like. It accepts glob pattern strings as well as classes (`entities: ["./src/**/*.entity.ts"]`), resolved from the directory the CLI runs in. The `migrations` array lists the migration classes in the order they should be executed.

A flat `DatabaseClientOptions` object (no `connection` wrapper) is also accepted: `export default { type: "sqlite", database: "./app.sqlite", migrations: [] }`.

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

Why use `driver.escapeIdentifier()` instead of hardcoding quotes? Because the quoting style varies by database: PostgreSQL and SQLite use `"double quotes"`, MySQL uses `` `backticks` ``. Using `escapeIdentifier()` makes your migration portable across databases, and also ensures that reserved words (like `user` or `order`) are properly escaped -- the quote character itself is doubled if the name contains one. It quotes the bare name; PostgreSQL schemas are not prepended.

## Migration Tracking

The CLI automatically creates a `__migrations` table to track which migrations have been applied:

```sql
CREATE TABLE "__migrations" (
  "id"          SERIAL PRIMARY KEY,
  "name"        VARCHAR(255) NOT NULL UNIQUE,
  "executed_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

This table is the source of truth. When you run `migrate:run`, the CLI reads this table to determine which migrations have already been applied and skips them. When you run `migrate:rollback`, it finds the last entry and reverses it.

## Concurrency Safety -- Advisory Locks

### Why Concurrent Migrations Are Dangerous

Imagine two servers in a cluster, both deploying at the same time, both trying to run migrations. Server A starts creating the `posts` table. Server B, not knowing this, also tries to create the `posts` table. The result: a database error, a half-applied migration, and a very bad day.

Even worse, if two processes run different migrations simultaneously, they might execute out of order, leaving your schema in an inconsistent state.

### How Advisory Locks Prevent This

Before running any migration, the CLI acquires a **database advisory lock** -- a cooperative lock that lives in the database itself (not on a file or in memory). Any other process trying to acquire the same lock will wait until the first process releases it.

- **PostgreSQL:** `pg_advisory_lock(key)` / `pg_advisory_unlock(key)`
- **MySQL:** `GET_LOCK(name, timeout)` / `RELEASE_LOCK(name)`

The lock uses a fixed key, so all migration processes across all servers coordinate through the database. If another migration process is already running, the CLI waits up to 10 seconds before throwing an `AdvisoryLockError`.

This means you can safely deploy to multiple servers simultaneously -- only one will run migrations, and the others will wait.

## Programmatic API -- MigrationCli

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

## Schema Diff Auto-Generation -- A Traced Example

The `migrate:generate` command is the most powerful part of the migration system. Let's trace through exactly what happens when you run it.

### The Scenario

You have an existing `user` table in your database with columns `id`, `name`, and `email`. You then make three changes to your entities:

1. Add a `phone` column to `User`
2. Change `email` from `VARCHAR(255)` to `VARCHAR(500)`
3. Create a new `Post` entity

### What SchemaDiff Does

When you run `npx stingerloom migrate:generate --name schema_update`, the CLI:

**Step 1: Read entity metadata.** It scans your `entities` array and reads all `@Entity()` and `@Column()` decorators to build a picture of what the schema *should* look like.

**Step 2: Read the live database.** It queries `information_schema.tables` and `information_schema.columns` to build a picture of what the schema *currently* looks like.

**Step 3: Compare the two.** `SchemaDiff` walks through every entity and every column, checking for differences:

| Check | What it detects |
|-------|----------------|
| Entity exists in code but not in DB | **New table** -- needs `CREATE TABLE` |
| Table exists in DB but not in code | *Not detected* -- `migrate:generate` never proposes `DROP TABLE` |
| Column exists in entity but not in table | **Added column** -- needs `ALTER TABLE ADD COLUMN` |
| Column exists in table but not in entity | **Dropped column** -- needs `ALTER TABLE DROP COLUMN` |
| Column type/length/nullable differs | **Altered column** -- needs `ALTER TABLE ALTER COLUMN` |
| One column was removed and another added with the same type | **Renamed column** -- needs `ALTER TABLE RENAME COLUMN` |

**Step 4: Generate the migration file.** For our example, the generated file would look like:

```typescript
import { Migration, MigrationContext } from "@stingerloom/orm";

export class SchemaUpdate1711234567892 extends Migration {
  async up({ query, driver }: MigrationContext) {
    // New table: Post
    await query(`
      CREATE TABLE ${driver.escapeIdentifier("post")} (
        ${driver.escapeIdentifier("id")} SERIAL PRIMARY KEY,
        ${driver.escapeIdentifier("title")} VARCHAR(255),
        ${driver.escapeIdentifier("content")} TEXT,
        ${driver.escapeIdentifier("createdAt")} TIMESTAMP
      )
    `);

    // Added column: user.phone
    await query(
      `ALTER TABLE ${driver.escapeIdentifier("user")} ADD COLUMN ${driver.escapeIdentifier("phone")} VARCHAR(255)`
    );

    // Altered column: user.email VARCHAR(255) -> VARCHAR(500)
    await query(
      `ALTER TABLE ${driver.escapeIdentifier("user")} ALTER COLUMN ${driver.escapeIdentifier("email")} TYPE VARCHAR(500)`
    );
  }

  async down({ query, driver }: MigrationContext) {
    // Revert: user.email back to VARCHAR(255)
    await query(
      `ALTER TABLE ${driver.escapeIdentifier("user")} ALTER COLUMN ${driver.escapeIdentifier("email")} TYPE VARCHAR(255)`
    );

    // Revert: drop user.phone
    await query(
      `ALTER TABLE ${driver.escapeIdentifier("user")} DROP COLUMN ${driver.escapeIdentifier("phone")}`
    );

    // Revert: drop post table
    await query(`DROP TABLE IF EXISTS ${driver.escapeIdentifier("post")}`);
  }
}
```

The `down()` method reverses every change in the opposite order, so rolling back produces a clean undo.

### Rename Detection

SchemaDiff uses a heuristic to detect column renames. If you renamed `email` to `emailAddress` (same type, same table, one column removed and one added), it generates:

```sql
ALTER TABLE "user" RENAME COLUMN "email" TO "emailAddress"
```

instead of dropping `email` and adding `emailAddress` (which would lose all existing data).

### Full Detection Summary

The `migrate:generate` command compares your entity definitions against the live database and detects:

- **New tables** -- entities not yet in the database
- **Added columns** -- new `@Column()` decorators
- **Dropped columns** -- columns removed from entities
- **Altered columns** -- type, length, nullable, or precision changes
- **Renamed columns** -- intelligently matched by type and table (generates `RENAME COLUMN` instead of drop + add)

Table removal is not part of it. A database holds tables that no entity list knows about -- other services, other connections, migration bookkeeping -- so "no entity for this table" is not evidence that the table is obsolete. `migrate:generate` never proposes `DROP TABLE`, and `synchronize` never drops a table in any mode; write that migration by hand.

## Next Steps

- [Migrations](./migrations.md) -- Migration concepts and transition from `synchronize`
- [Production Guide](./production-guide.md) -- Zero-downtime migration strategies
- [Configuration](./configuration.md) -- Database connection options
