# Upgrading to 2.0

2.0 is mostly a honesty release: states that used to fail silently now fail loudly, and one column encoding that was wrong got fixed. Most applications upgrade by changing the version number. This page lists everything that can break, and what to do about it.

```bash
pnpm add @stingerloom/orm@2
```

## Start here

Run your test suite with logging enabled before deploying. Almost every breaking change in 2.0 turns a silent state into an exception or a warning, so a test run surfaces them in one pass:

```typescript
await em.register({ /* ... */, logging: true });
```

## Things that stop compiling

### The root barrel exports a curated API

`@stingerloom/orm` used to re-export whole modules, so 673 symbols were importable from the package root — engine internals (`SchemaRegistrar`, `CascadeHandler`, `EntityManagerInternals`), expression plumbing (`buildAbs`, `renderSubquery`), internal type guards. The barrel now names its exports.

If an import stops resolving, it was one of those internals. There is no supported replacement path for engine internals; open an issue describing what you needed it for. Public entry points are unchanged: `@stingerloom/orm`, `@stingerloom/orm/nestjs`, `@stingerloom/orm/prisma-import`, and the dialect subpaths.

### Custom drivers must implement `escapeIdentifier()`

`ISqlDriver` now declares `escapeIdentifier(name: string): string`. Every documented migration example already called it — the method existed on no driver, so those examples could not compile and failed at runtime. The three bundled drivers implement it; a custom `ISqlDriver` needs to add it:

```typescript
escapeIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
```

### `ColumnMetadata.name` and `EntityScannerMetadata.name` are required

Both fields were optional in the type but set on every creation path. Code that constructed these metadata objects by hand — custom scanners, schema tooling — must now provide `name`.

## Things that now throw

Each of these was previously a silent wrong answer.

| What you write | 1.x | 2.0 |
| --- | --- | --- |
| An entity that is not in the connection's `entities` | Died on the first SQL statement with a driver error | `EntityMetadataNotFoundError` at the API entry point |
| `where: { emial: "…" }` (a typo) | Passed the raw key to the driver: dialect-specific "no such column" | `InvalidQueryError` naming the column and suggesting the closest match |
| `relations: ["autor"]` (a typo) | Query succeeded, relation property stayed `undefined` | `InvalidQueryError` listing the resolvable relations |
| `save()` on an entity whose PK matches no row | Reported success, fired `afterUpdate` | `EntityNotFoundError` |
| `qb.where("status = 'open'")` (raw SQL string) | Treated the fragment as a column name | `InvalidQueryError` |
| `migrate:generate` for an unrepresentable diff | Wrote a migration whose `up()` was a TODO comment | Throws, so no dead migration reaches the repository |

Two of these deserve a closer look.

**Column identifiers.** The validator accepts property names, DB column names, `@RelationColumn` FK shadows, `@ComputedColumn` names, and single-table-inheritance sibling columns. It rejects a physical column the entity does not map — that used to work by accident. If you filter on an unmapped column, either declare it with `@Column`, or drop to `createQueryBuilder()` / `em.query()`.

**`save()` on a missing row.** If your code uses `save()` to mean "insert or update", make the intent explicit with `upsert()`. If it legitimately expects a possibly-missing row, check first with `exists()`.

## Things that return different results

### `take: 0` and `limit: 0` mean zero rows

They used to fall through a falsy check and return the whole table. `qb.take(0)` always meant `LIMIT 0`; the two agree now. If you were passing a computed page size that can be `0` and relying on "0 means unlimited", clamp it yourself.

### `stream()` and `streamBatch()` honor your window

The internal batching used to overwrite the caller's `limit` / `take` / `skip`, and a `take` larger than the batch size re-yielded rows (a `take: 150` over batches of 100 emitted 300 rows, 50 of them duplicates). Your window is now the stream's window. Code that passed `take` and silently got everything will now get what it asked for.

### Temporal columns are written as instants

Batch writes (`insertMany`, `insertManyAndReturn`, `batchUpsert`) and the automatic `@CreateTimestamp` / `@UpdateTimestamp` columns used to be formatted as local wall-clock text without an offset or milliseconds, while single-row writes bound the `Date`. All paths bind the `Date` now.

What changes for you:

- Milliseconds survive batch writes (subject to column precision).
- On PostgreSQL `timestamptz`, batch writes store the same instant as `save()` — they diverged whenever the application process timezone differed from the server's `TimeZone`.
- On SQLite, the stored text is ISO-8601 UTC (`2026-03-01T12:34:56.789Z`) rather than `2026-03-01 21:34:56`.

Reading is unchanged: the ORM already decoded both encodings, so existing rows keep their meaning. If you compare the **raw stored text** (a hand-written SQL query, an export diff), that comparison needs updating. See [Dates & Timezones](./timezone.md).

### SQLite soft-delete stamps

`softDelete()` on SQLite wrote `datetime('now')` — UTC without a zone marker — and the reader decoded zone-less text as local time, so `deletedAt` came back shifted by the process offset. New stamps carry the `Z` marker.

Rows soft-deleted by 1.x keep the old encoding. If those timestamps matter beyond "is this row trashed" and you ran a non-UTC process, [Dates & Timezones](./timezone.md#soft-deletes) has a one-off correction statement.

## Things that get louder

### `OrmError` messages carry their suggestion

Errors that had an actionable `suggestion` now append it to `message` as a trailing `Suggestion: ...` line, so it reaches any logger that prints the message or the stack. Tests that assert on exact error strings need updating; `error.suggestion` is unchanged.

### Missing tenant context is reported

Under `tenantStrategy: "tenant_column"`, a read issued outside `MetadataContext.run()` silently matched every tenant's rows. It now warns once per entity class. Configure the policy explicitly:

```typescript
await em.register({
  // ...
  tenantStrategy: "tenant_column",
  tenantOnMissingContext: "throw", // "throw" | "warn" (default) | "allow"
});
```

`"throw"` is the recommended setting for new code and will become the default in the next major. Background workers that legitimately span tenants should use the explicit escape hatches (`runUnscoped()`, an explicit `run("public")`, `withoutTenantScope`, or `@NonTenantEntity`) rather than relying on the missing-context path.

### `timestamptz` on MySQL/MariaDB

Neither dialect has a zone-aware `DATETIME`, so `timestamptz` columns are created as `DATETIME` and the offset is not stored. The mapping is unchanged; it now logs one warning per process.

### Unknown connection options

`register()` warns about option keys it does not recognize and suggests the closest match, instead of ignoring them.

## Operational changes

### The migration CLI reports failure

`stingerloom migrate:run` and `migrate:rollback` exit **1** when a migration fails. They previously printed "0 succeeded, 1 failed" at info level and exited 0, so deployment chains like `migrate:run && start` continued onto a half-migrated schema.

Check your pipelines: a job that was silently green on failure will now stop. That is the point, but it can surface a migration that has been failing unnoticed.

The argument parser also rejects unknown flags, missing option values, and extra operands, instead of dropping them silently. `--dry-runn` used to be ignored, and `--ouput ./migrations migrate:run` used to run `./migrations` as the command.

### NestJS closes connection pools on shutdown

`StingerloomOrmService.onApplicationShutdown()` now closes the pools it opened, including every tenant pool under `tenantStrategy: "database"`. If your application kept using a connection after Nest's shutdown hooks ran, it will now fail — move that work before shutdown.

## Not breaking, but worth adopting

- **Query result cache** — opt in per read with `cache: true` or `cache: 30_000`. Writes through the same `EntityManager` invalidate the affected tables. See [Query Result Cache](./caching.md).
- **`defineEntity` mutual references** — two code-first entities can now reference each other without a `TS7022` circularity error. See [Code-first entities](./define-entity.md).
- **`pnpm test:temporal-tz` pattern** — if your own suite covers temporal behavior, run it under more than one `TZ`. In UTC, a zone-less write and a correct UTC write look identical.
