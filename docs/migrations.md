# Migrations

## Why Migrations Exist

During development, you might use `synchronize: true` to let the ORM automatically create and alter tables based on your entity definitions. This is convenient. It is also dangerous.

Here is why. Imagine you have a `users` table with 50,000 rows. You rename a column from `phone` to `mobile` in your entity class. With `synchronize: true`, the ORM sees that `phone` no longer exists and `mobile` is new. It does the simplest thing: DROP the `phone` column and ADD a `mobile` column. Every phone number in your database is gone.

**Migrations** solve this problem by letting you write schema changes as explicit, versioned code. Instead of the ORM guessing what changed, you tell it exactly what to do:

```sql
-- What synchronize: true would do (DANGEROUS):
ALTER TABLE "users" DROP COLUMN "phone";
ALTER TABLE "users" ADD COLUMN "mobile" VARCHAR(20);
-- All phone data is lost!

-- What a migration does (SAFE):
ALTER TABLE "users" RENAME COLUMN "phone" TO "mobile";
-- Data preserved. Column renamed.
```

Migrations give you three things that `synchronize: true` cannot:

1. **Safety** -- You control exactly what SQL runs against your database
2. **History** -- Every schema change is version-controlled, just like your code
3. **Rollback** -- If something goes wrong, you can undo the change

---

## Creating a Migration File

A migration is a class with two methods:

- **`up()`** -- Apply the change (move forward)
- **`down()`** -- Undo the change (move backward)

Think of it like an elevator: `up()` takes you to the next floor, `down()` brings you back.

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

The `MigrationContext` object gives you two things:

| Property | Description |
|----------|-------------|
| `context.query(sql)` | Execute any SQL statement |
| `context.driver` | Access to the database driver (for DDL helpers, identifier escaping, etc.) |

---

## More Migration Examples

### Adding a Column

You shipped the users table last week. Now the product team wants a phone number field. You do not modify the original migration -- you create a new one.

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

The generated SQL on `up()`:

```sql
ALTER TABLE "users" ADD COLUMN "phone" VARCHAR(20) NULL;
```

The generated SQL on `down()` (rollback):

```sql
ALTER TABLE "users" DROP COLUMN "phone";
```

### Adding an Index

Queries filtering by email are slow. You add an index:

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

The `up()` SQL:

```sql
CREATE INDEX "idx_users_email" ON "users" ("email");
```

### Seeding Initial Data

Migrations are not limited to schema changes. You can also insert seed data:

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

---

## How Migration Tracking Works

When you run migrations for the first time, Stingerloom automatically creates a special table called `__migrations`. This table is the ORM's memory -- it records which migrations have already been applied.

For PostgreSQL / SQLite, the table looks like this:

```sql
CREATE TABLE IF NOT EXISTS "__migrations" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL UNIQUE,
  "executed_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

For MySQL:

```sql
CREATE TABLE IF NOT EXISTS `__migrations` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL UNIQUE,
  `executed_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

Every time a migration runs successfully, a row is inserted:

```sql
INSERT INTO "__migrations" ("name") VALUES ('CreateUsersTable');
```

When you run migrations again, the runner queries this table first:

```sql
SELECT "name" FROM "__migrations" ORDER BY "id" ASC;
-- Returns: ['CreateUsersTable', 'AddPhoneToUsers']
```

It then compares this list against your registered migrations and only runs the ones that are not in the table yet. This is how migrations are **idempotent** -- running `migrate:run` twice does not apply the same migration twice.

When you rollback, the corresponding row is deleted:

```sql
DELETE FROM "__migrations" WHERE "name" = 'AddPhoneToUsers';
```

---

## Running Migrations

There are two ways to run migrations: the built-in **CLI** (simplest) and the **programmatic API** (for custom setups).

### Using the Built-in CLI (Recommended)

Stingerloom ships with a CLI executable that reads your config file and runs migrations directly from the terminal.

```bash
# Run all pending migrations
npx stingerloom migrate:run

# Roll back the last migration
npx stingerloom migrate:rollback

# Show executed and pending migrations
npx stingerloom migrate:status

# Auto-generate a migration from schema diff (see below)
npx stingerloom migrate:generate
```

#### Config File

The CLI auto-detects a config file in the project root. It searches for these filenames in order:

1. `stingerloom.config.ts`
2. `stingerloom.config.js`
3. `stingerloom.config.mjs` / `stingerloom.config.cjs`
4. `ormconfig.ts`
5. `ormconfig.js`
6. `ormconfig.mjs` / `ormconfig.cjs`

```typescript
// stingerloom.config.ts
import { User } from "./src/entities/user.entity";
import { Post } from "./src/entities/post.entity";
import { CreateUsersTable } from "./migrations/001_CreateUsersTable";
import { AddPhoneToUsers } from "./migrations/002_AddPhoneToUsers";

export default {
  connection: {
    type: "postgres",
    host: "localhost",
    port: 5432,
    username: "postgres",
    password: "password",
    database: "mydb",
    entities: [User, Post],
  },
  migrations: [
    new CreateUsersTable(),
    new AddPhoneToUsers(),
  ],
};
```

You can override the config path and set options with CLI flags:

```bash
npx stingerloom migrate:run --config ./config/prod.config.ts
npx stingerloom migrate:generate --output ./src/migrations --name AddEmailIndex
```

| Flag | Description |
|------|-------------|
| `--config <path>` | Path to config file (default: auto-detect) |
| `--output <dir>` | Output directory for generated migrations (default: `./migrations`) |
| `--name <suffix>` | Migration name suffix for generated file |
| `--help` | Show help message |

> The CLI supports TypeScript config files natively via `ts-node` or `tsx`. If neither is installed, use `.js` config files.

### Concurrent Safety with Advisory Locks

When multiple servers start at the same time (common in Kubernetes deployments), they might try to run migrations simultaneously. This could cause duplicate table creation errors or worse.

Stingerloom prevents this with **advisory locks**. Before running any migration, the runner acquires a database-level lock:

```
Server A: acquireAdvisoryLock("stingerloom_migration_lock") -> acquired!
Server B: acquireAdvisoryLock("stingerloom_migration_lock") -> waiting...
Server A: runs migrations, releases lock
Server B: acquireAdvisoryLock("stingerloom_migration_lock") -> acquired!
Server B: checks __migrations table, finds nothing pending, exits
```

If the lock cannot be acquired within the timeout (default: 10 seconds), the runner throws an `AdvisoryLockError`.

### Using MigrationCli (Programmatic)

For more control, create a custom migration script. This is useful when your config comes from environment variables or you need custom logic before/after migrations.

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
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USER ?? "postgres",
  password: process.env.DB_PASS ?? "password",
  database: process.env.DB_NAME ?? "mydb",
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

Register scripts in package.json for convenience:

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

---

## Checking Migration Results

Each migration returns a result object that tells you whether it succeeded or failed:

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

If a migration fails, the runner stops immediately -- it does not attempt to run subsequent migrations, because they likely depend on the one that failed.

---

## File Naming Convention

Migrations are executed in the order they are registered in the array. Use sequence numbers in filenames to make the order obvious:

```
migrations/
├── 001_CreateUsersTable.ts
├── 002_CreatePostsTable.ts
├── 003_AddPhoneToUsers.ts
├── 004_AddEmailIndex.ts
└── 005_SeedRoles.ts
```

---

## Schema Diff -- Automatic Migration Generation

Writing migration files by hand is fine for simple changes, but tedious for complex ones. Schema Diff automates this by comparing your entity definitions against the actual database schema and generating the necessary migration code.

### How Schema Diff Works, Step by Step

Here is what happens inside `SchemaDiff.diff()`:

**Step 1: Read your entity definitions.** The diff engine uses `reflect-metadata` to extract every `@Entity` class and its `@Column` definitions -- table names, column names, types, lengths, and nullability.

**Step 2: Query the real database.** It runs an `information_schema` query to discover what tables and columns actually exist:

```sql
-- PostgreSQL
SELECT column_name, data_type, is_nullable, character_maximum_length
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'users';

-- MySQL
SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users';
```

**Step 3: Compare.** For each entity, it checks:
- Does the table exist in the database? If not, it goes into `addTables`.
- For each column in the entity, does it exist in the database? If not, it goes into `addColumns`.
- For each column in the database, does it exist in the entity? If not, it goes into `dropColumns`.
- If both exist, do the types and lengths match? If not, it goes into `alterColumns`.

**Step 4: Detect renames.** Before finalizing, the engine looks for possible column renames (explained below).

**Step 5: Generate migration code.** The `SchemaDiffMigrationGenerator` takes the diff result and produces a migration class with the appropriate `up()` and `down()` methods.

### Using the CLI

The simplest way to generate a migration:

```bash
npx stingerloom migrate:generate
```

This will:
1. Connect to the database using your config.
2. Run `SchemaDiff.diff()` against all registered entities.
3. If differences are found, generate a timestamped migration file.
4. If the schema is already in sync, print "No schema changes" and exit.

### Using the Programmatic API

```typescript
import { SchemaDiff, SchemaDiffMigrationGenerator } from "@stingerloom/orm";

// Step 1: Compare entity definitions with the live database
const schemaDiff = new SchemaDiff();
const diff = await schemaDiff.diff(
  [User, Post, Comment],   // your entity classes
  queryRunner,              // something with a .query() method
  "postgres",               // dialect: "postgres" | "mysql" | "sqlite"
);

console.log(diff.addTables);      // ["comment"]
console.log(diff.dropTables);     // []
console.log(diff.addColumns);     // [{ tableName: "users", columnName: "phone", ... }]
console.log(diff.renamedColumns); // [{ tableName: "users", oldColumnName: "phone", newColumnName: "mobile", ... }]

// Step 2: Generate migration code from the diff
if (diff.addTables.length === 0 &&
    diff.dropTables.length === 0 &&
    diff.addColumns.length === 0 &&
    diff.dropColumns.length === 0 &&
    diff.alterColumns.length === 0 &&
    (diff.renamedColumns?.length ?? 0) === 0) {
  console.log("No schema changes");
  return;
}

const generator = new SchemaDiffMigrationGenerator();
const content = generator.generate(diff, "postgres");
await generator.save(content, "./migrations");
```

::: warning SQLite column changes
SQLite cannot `ALTER` a column's type or nullability. When the diff contains such a change and the dialect is `"sqlite"`, both `generate()` and `dryRun()` throw `ORM_UNSUPPORTED_OPERATION` listing the affected columns instead of emitting a migration that silently skips them. Write a manual migration that recreates the table: create a new table with the desired schema, copy the data over, drop the old table, then rename the new one.
:::

### Example: Adding a Column

You add a `phone` column to the User entity:

```typescript
@Entity()
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 100 })
  name!: string;

  @Column({ type: "varchar", length: 20 })  // NEW
  phone!: string;
}
```

Running `migrate:generate` detects that `phone` exists in the entity but not in the database, and produces:

```typescript
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

### Column Rename Detection

This is one of the cleverest parts of Schema Diff. When you rename a column, the naive approach sees a "drop" and an "add" -- because the old name disappeared and a new name appeared. But the diff engine uses a **heuristic** to detect renames and avoid data loss.

Here is how the heuristic works:

1. For each table, gather all columns that would be **dropped** (exist in DB but not in entity) and all columns that would be **added** (exist in entity but not in DB).
2. For each dropped column, check if there is an added column with a **compatible type** in the same table.
3. If a 1:1 match is found (one dropped column matches one added column by type), treat it as a **rename** instead of a drop + add.

For example, if you rename `phone` to `mobile`:

```typescript
// Before
@Column({ type: "varchar", length: 20 })
phone!: string;

// After
@Column({ type: "varchar", length: 20 })
mobile!: string;
```

The diff engine sees:
- Dropped: `phone` (type: VARCHAR)
- Added: `mobile` (type: VARCHAR)
- Same table, compatible types, 1:1 match -- this is a rename.

The generated migration uses `RENAME COLUMN` instead of `DROP` + `ADD`:

```typescript
class SchemaDiff_1708000000000 extends Migration {
  async up(context: MigrationContext) {
    await context.query(
      `ALTER TABLE "users" RENAME COLUMN "phone" TO "mobile"`
    );
  }
  async down(context: MigrationContext) {
    await context.query(
      `ALTER TABLE "users" RENAME COLUMN "mobile" TO "phone"`
    );
  }
}
```

The rename detection works because compatible types narrow down the candidates. If you renamed `phone` (VARCHAR) and simultaneously added `age` (INT), the engine would not confuse them -- VARCHAR and INT are not compatible types.

> Schema Diff detects additions, deletions, and renames of tables and columns. Column type changes (e.g., changing VARCHAR to TEXT) are detected as `alterColumns` in the diff result, but write those as manual migrations for safety.

### ENUM Value Synchronization (PostgreSQL)

Most schema changes -- adding a column, renaming a table -- happen at the **table level**. But PostgreSQL has an unusual feature: ENUM types are **separate database objects** that live outside any table. When you define a column with `@Column({ type: "enum", enumValues: ["admin", "user"] })`, PostgreSQL creates a named type (like `users_role_enum`) and the column references that type.

Here's the problem. Suppose you add a new role:

```typescript
@Column({
  type: "enum",
  enumValues: ["admin", "user", "moderator"],  // "moderator" is new
})
role!: string;
```

A regular `ALTER TABLE` can't detect this change. The column type is still `users_role_enum` -- it hasn't changed. What changed is the **enum type definition itself**, which is a different database object. Without auto-sync, you'd have to manually write:

```sql
ALTER TYPE "users_role_enum" ADD VALUE IF NOT EXISTS 'moderator';
```

SchemaDiff now handles this automatically for PostgreSQL.

> **Hint** `synchronize` applies the same two operations at boot without going through a migration file -- it creates missing enum types and appends missing values. See [Configuration](./configuration.md#postgresql-enum-types).

**How it works.** During the diff step, after comparing tables and columns, SchemaDiff runs an additional check for PostgreSQL enum types:

1. For each `@Column({ type: "enum" })` in your entities, it reads the current enum values from `pg_enum` and `pg_type` in the database.
2. It compares the values in your entity definition against the values in the database.
3. New values go into `addValues`. Removed values go into `removeValues`.

The result is stored in the `enumChanges` array of the diff:

```typescript
interface EnumChange {
  enumName: string;        // e.g. "users_role_enum"
  addValues: string[];     // values to add
  removeValues: string[];  // values that were removed
  isNew: boolean;          // true if the entire enum type needs to be created
}
```

**Generated migration -- adding a value:**

When you add `"moderator"` to your enum, the migration generator produces:

```typescript
class AutoMigration_1708000000000 extends Migration {
  async up({ query }: MigrationContext): Promise<void> {
    await query(`ALTER TYPE "users_role_enum" ADD VALUE IF NOT EXISTS 'moderator'`);
  }

  async down({ query }: MigrationContext): Promise<void> {
    // WARNING: Cannot reverse ALTER TYPE ADD VALUE for "users_role_enum".
    // Recreate the type manually if needed.
  }
}
```

The `IF NOT EXISTS` clause makes this safe to run multiple times -- if the value already exists, PostgreSQL silently skips it.

**Generated migration -- removing a value:**

PostgreSQL has a fundamental limitation: you **cannot remove a value from an existing enum type**. The only way is to drop and recreate the entire type, which requires updating every column that references it. The migration generator acknowledges this with a warning comment instead of generating unsafe DDL:

```sql
-- WARNING: Cannot remove enum values from "users_role_enum": guest.
-- Recreate the type manually if needed.
```

This is intentionally cautious. Dropping and recreating an enum type is a multi-step operation that can fail if any row contains the removed value. It's safer as a manual migration where you control the process.

**What about MySQL?**

MySQL handles enums differently -- the enum values are part of the column definition itself (`role ENUM('admin','user','moderator')`). When you change enum values in MySQL, SchemaDiff detects it as a regular column type modification in `alterColumns`. The generated migration uses `MODIFY COLUMN` to update the full column definition. No special enum handling is needed.

---

## Migration Hooks

The MigrationRunner supports lifecycle hooks for monitoring, logging, and error handling during migration runs.

### Available hooks

```typescript
interface MigrationHooks {
  beforeAll?(context: MigrationContext): Promise<void> | void;
  afterAll?(context: MigrationContext, results: MigrationResult[]): Promise<void> | void;
  beforeEach?(migration: Migration, context: MigrationContext): Promise<void> | void;
  afterEach?(migration: Migration, context: MigrationContext, durationMs: number): Promise<void> | void;
  onError?(migration: Migration, error: Error, context: MigrationContext): Promise<void> | void;
}
```

| Hook | Fires When | Parameters |
|------|------------|------------|
| `beforeAll` | Before the first migration runs | MigrationContext |
| `afterAll` | After all migrations complete | MigrationContext, results array |
| `beforeEach` | Before each individual migration | Migration, MigrationContext |
| `afterEach` | After each successful migration | Migration, MigrationContext, duration in ms |
| `onError` | When a migration fails | Migration, error, MigrationContext |

### Example: Slack notification on failure

```typescript
import { MigrationRunner } from "@stingerloom/orm";

const runner = new MigrationRunner(driver, migrations, {
  hooks: {
    beforeAll(ctx) {
      console.log("Starting migrations...");
    },
    afterEach(migration, ctx, durationMs) {
      console.log(`Completed ${migration.constructor.name} in ${durationMs}ms`);
    },
    onError(migration, error, ctx) {
      notifySlack(`Migration failed: ${migration.constructor.name} -- ${error.message}`);
    },
    afterAll(ctx, results) {
      console.log(`All done. ${results.length} migrations applied.`);
    },
  },
});

await runner.runAll();
```

All hooks can be async (return a Promise) or synchronous.

---

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

---

## Next Steps

- [Configuration](./configuration.md) -- Pooling, timeouts, Read Replica settings
- [Multi-Tenancy](./multi-tenancy.md) -- Automatic schema provisioning per tenant
- [Events & Subscribers](./events.md) -- Lifecycle hooks and entity event system
