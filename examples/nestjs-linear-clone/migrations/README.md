# Migrations

Production schema changes for nestjs-linear-clone live here. There is one frozen
baseline migration (`*-baseline-schema.ts`) plus any subsequent diff migrations
generated as the schema evolves.

## First boot (clean DB)

The baseline is checked in and ready to apply — no DB connection is required to
generate it. Just point `.env` at a fresh database and run:

```bash
cp .env.example .env  # adjust DB_HOST/DB_USER/DB_PASSWORD/DB_NAME
ORM_SYNC=false pnpm migrate:run
```

That creates every table, index, and FK from the baseline migration. The app
will boot against migrations-only afterward (`ORM_SYNC=false`).

## Regenerating the baseline

If you fork this example and want a clean baseline against your own entity set:

```bash
pnpm migrate:baseline
# rewrites migrations/<timestamp>-baseline-schema.ts using SchemaGenerator —
# no DB needed; both MySQL and Postgres DDL are baked into one file.
```

Then update `stingerloom.config.ts` to import the new file and replace the
`migrations` array entry. **This is a destructive operation** — only do it
before any non-baseline migrations have shipped.

## Iterative changes (after the baseline)

```bash
# 1. Edit entities under src/modules/<feature>/*.entity.ts
# 2. Generate a diff migration
ORM_SYNC=false pnpm migrate:generate -- --name add-issue-watcher

# 3. Inspect ./migrations/<timestamp>-add-issue-watcher.ts
#    Adjust if the generator missed something (e.g. data-preserving
#    transformations, custom indexes, hash-FK constraint names).

# 4. Wire it into stingerloom.config.ts (add to migrations: [...] in order)
# 5. Apply
pnpm migrate:run
# Roll back the latest with
pnpm migrate:rollback
# Inspect what's pending vs applied
pnpm migrate:status
```

## ORM_SYNC modes

| Value | Behavior | When to use |
|-------|----------|-------------|
| `true` | CREATE, ADD, ALTER, DROP all run on boot to match entities | Local DB you don't mind getting reshaped on every reload |
| `safe` | CREATE missing tables only — never ALTER or DROP | Default for dev; pairs with migrations for the change track |
| `dry-run` | Logs the DDL it *would* run without executing | Preview pending changes |
| `false` | Stingerloom never touches DDL — migrations own everything | Production. `npm run migrate:run` brings the schema up. |

Production is forced to `false` by `envValidationSchema`.

## What the generator does and does not capture

`pnpm migrate:generate` calls `SchemaDiff` against the live DB schema and
hands the result to `SchemaDiffMigrationGenerator`. It captures:

- table CREATE / DROP
- column ADD / DROP / ALTER (including type, length, nullable, default)
- index CREATE / DROP, including @UniqueIndex composite + @FullTextIndex
- FK constraint name hashes (so the round-trip stays stable)
- ManyToMany join-table DDL
- enum value additions (PostgreSQL)

It does *not* capture:

- data backfills — wrap manual SQL in the migration's `up()` / `down()`
- column renames the diff cannot infer from name alone (the "did the user
  rename `title → name` or drop `title` and add `name`?" ambiguity).
  Provide a hint via the `addColumnRenames` API on the generator output if
  needed, or split into two migrations.
- unsynced data shapes (e.g. a JSON column whose contents must be
  re-serialized) — handle in app code or a follow-up data migration.
