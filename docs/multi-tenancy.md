# Multi-Tenancy

## The Problem

Imagine you're building a SaaS product — a project management tool used by hundreds of companies. Company A has 50 employees, Company B has 200. They both use the same application, running on the same server, backed by the same database.

But Company A must **never** see Company B's data. Not in API responses, not in database queries, not even by accident through a bug. This is **multi-tenancy**: one application, many isolated customers (tenants).

There are four common approaches:

1. **Separate databases** — one DB per tenant. Strongest isolation, highest operational cost.
2. **Shared database, separate schemas** — one DB, but each tenant gets its own namespace (schema). Good balance of isolation and efficiency.
3. **Shared everything** — one DB, one schema, a `tenant_id` column on every table. Cheapest but risky — a missing WHERE clause leaks data.
4. **Database-per-tenant with a routing layer** — same shape as #1, but the ORM transparently routes each request to the right pool based on `MetadataContext`.

Stingerloom ORM supports all four:

- **#2 (schema-based)** via the `search_path` and `schema_qualified` strategies (PostgreSQL only) on top of a **layered metadata system**.
- **#3 (column-based)** via the `tenant_column` strategy (every dialect).
- **#1 / #4 (database-based)** via the `database` strategy and `MultiTenantEntityManager` (every dialect).

---

## How It Works — The OverlayFS Analogy

If you've used Docker, you know that containers share a base image but each gets its own writable layer. Your changes go to the top layer; the base stays untouched. When you read a file, Docker checks the top layer first, then falls back to the base.

Stingerloom's metadata system works the same way:

```
┌──────────────────────────────────────────────┐
│  Tenant Layer  (read / write)                │  ← Per-tenant overrides
│  e.g., "acme_corp" has a custom table name   │    (Copy-on-Write)
├──────────────────────────────────────────────┤
│  Public Layer  (read-only)                   │  ← Base schema definitions
│  @Entity, @Column decorators register here   │    (shared by all tenants)
└──────────────────────────────────────────────┘
```

**Reading metadata:** check the tenant layer first. If not found, fall back to the public layer.

**Writing metadata:** always writes to the tenant layer. The public layer is never modified at runtime. This is Copy-on-Write — the same principle as Docker's OverlayFS.

The key insight is that **you don't need to think about this**. You set "which tenant this request belongs to," and the ORM routes all queries to the correct schema automatically.

---

## Setting the Tenant Context

Every HTTP request in a SaaS app belongs to a specific tenant. The ORM needs to know which one. You tell it using `MetadataContext.run()`:

```typescript
import { MetadataContext } from "@stingerloom/orm";

await MetadataContext.run("acme_corp", async () => {
  // Everything inside this callback runs in the "acme_corp" context.
  // All ORM queries automatically target acme_corp's schema.
  const users = await em.find(User);
  // → SELECT * FROM "acme_corp"."user"
});

// Outside the callback, we're back to "public" automatically.
const users = await em.find(User);
// → SELECT * FROM "user"  (public schema)
```

### How does this work under the hood?

`MetadataContext.run()` uses Node.js's `AsyncLocalStorage` — a built-in mechanism that propagates context through the entire async call chain without passing it as a parameter. Think of it as a "thread-local variable" for async JavaScript.

```
HTTP Request arrives with header "X-Tenant-Id: acme_corp"
    │
    ▼
MetadataContext.run("acme_corp", async () => {
    │
    ├─► Controller.getUsers()
    │       │
    │       ├─► UserService.findAll()
    │       │       │
    │       │       └─► em.find(User)
    │       │               │
    │       │               └─► MetadataContext.getCurrentTenant()
    │       │                   returns "acme_corp" ← AsyncLocalStorage
    │       │                   │
    │       │                   └─► SQL: SELECT * FROM "acme_corp"."user"
    │       │
    │       └─► return users
    │
    └─► Response sent
});
// Context automatically reverts to "public"
```

No matter how deep the call stack goes — controller → service → repository → EntityManager — the tenant context is always available via `AsyncLocalStorage`. You never need to pass `tenantId` as a function parameter.

### Checking the current context

```typescript
const tenant = MetadataContext.getCurrentTenant();
// "acme_corp" inside run(), "public" outside

const isActive = MetadataContext.isActive();
// true inside run(), false outside
```

### Concurrency safety

Each HTTP request gets its own `AsyncLocalStorage` context. Even if two requests arrive at the exact same millisecond — one from "acme_corp" and one from "globex" — they see different tenant IDs. There's no shared global variable that can be overwritten.

```
Request A (acme_corp)  ──────────────────────────►  sees "acme_corp" throughout
Request B (globex)     ──────────────────────────►  sees "globex" throughout
                       ↑ concurrent, but isolated
```

---

## Automatic Setup with NestJS Middleware

In a real application, you don't call `MetadataContext.run()` manually for every request. Instead, you use middleware to extract the tenant from the HTTP request and wrap the entire request lifecycle in a tenant context.

```typescript
// tenant.middleware.ts
import { Injectable, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { MetadataContext } from "@stingerloom/orm";

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    // Extract tenant from request header (you could also use subdomain, JWT claim, etc.)
    const tenantId = req.headers["x-tenant-id"] as string ?? "public";

    // Wrap the ENTIRE request in a tenant context
    MetadataContext.run(tenantId, () => {
      next();
    });
  }
}
```

```typescript
// app.module.ts
@Module({ /* ... */ })
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantMiddleware).forRoutes("*");
  }
}
```

Now every controller and service in your NestJS app automatically runs in the correct tenant context. No changes needed to your business logic:

```bash
# Query users for acme_corp
curl -H "X-Tenant-Id: acme_corp" http://localhost:3000/users
# → SELECT * FROM "acme_corp"."user"

# Query posts for globex
curl -H "X-Tenant-Id: globex" http://localhost:3000/posts
# → SELECT * FROM "globex"."post"

# Without the header → "public" schema
curl http://localhost:3000/users
# → SELECT * FROM "user"
```

### Where should the tenant ID come from?

The `X-Tenant-Id` header is the simplest approach, but in production you might use:

| Source | Example | When to use |
|--------|---------|-------------|
| HTTP header | `X-Tenant-Id: acme_corp` | Internal APIs, microservices |
| Subdomain | `acme.yourapp.com` | Customer-facing apps |
| JWT claim | `{ tenantId: "acme_corp" }` | Token-based auth |
| URL path | `/tenants/acme_corp/users` | REST APIs with explicit scoping |

The middleware pattern is the same regardless — extract the tenant ID and pass it to `MetadataContext.run()`.

---

## PostgreSQL Schema-Based Isolation

So far we've talked about routing queries. But where does the tenant data actually live? With PostgreSQL schemas, each tenant gets its own namespace containing copies of all tables.

Think of a PostgreSQL schema like a folder in a filesystem:

```
Database "mydb"
├── public/           ← default schema (base tables)
│   ├── user
│   ├── post
│   └── comment
├── acme_corp/        ← tenant schema (same tables, different data)
│   ├── user
│   ├── post
│   └── comment
└── globex/           ← another tenant schema
    ├── user
    ├── post
    └── comment
```

Each schema has its own `user` table, with its own rows. `acme_corp.user` and `globex.user` are completely separate — different data, different indexes, different sequences.

### Creating Tenant Schemas with TenantMigrationRunner

`PostgresTenantMigrationRunner` automates tenant schema creation. It clones the table structure from the public schema to a new tenant schema.

```typescript
import { PostgresTenantMigrationRunner, EntityManager } from "@stingerloom/orm";

const em = new EntityManager();
await em.register({
  type: "postgres",
  host: "localhost",
  port: 5432,
  username: "postgres",
  password: "password",
  database: "mydb",
  entities: [User, Post],
  synchronize: true,  // creates tables in "public" schema
});

const driver = em.getDriver()!;
const runner = new PostgresTenantMigrationRunner(driver, {
  sourceSchema: "public",  // copy table structure from here
});
```

### Creating a single tenant

```typescript
await runner.ensureSchema("acme_corp");
```

This executes the following SQL:

```sql
-- 1. Create the schema
CREATE SCHEMA IF NOT EXISTS "acme_corp";

-- 2. Clone each table's structure from public (including indexes, constraints, defaults)
CREATE TABLE IF NOT EXISTS "acme_corp"."user"
  (LIKE "public"."user" INCLUDING ALL);

CREATE TABLE IF NOT EXISTS "acme_corp"."post"
  (LIKE "public"."post" INCLUDING ALL);
```

`INCLUDING ALL` copies columns, indexes, constraints, defaults, and sequences — everything except the data. The tenant starts with an empty copy of every table.

`ensureSchema()` is idempotent — calling it twice for the same tenant does nothing the second time. It also uses advisory locks internally to prevent race conditions when multiple processes try to create the same schema simultaneously.

### Batch provisioning multiple tenants

```typescript
const result = await runner.syncTenantSchemas([
  "acme_corp", "globex", "initech", "umbrella"
]);

console.log(result.created);  // ["initech", "umbrella"] — newly created
console.log(result.skipped);  // ["acme_corp", "globex"] — already existed
```

### Discovering existing schemas

```typescript
const schemas = await runner.discoverSchemas();
// ["public", "acme_corp", "globex"]
// (excludes pg_catalog, information_schema, and other system schemas)

runner.isProvisioned("acme_corp");    // true
runner.getProvisionedSchemas();       // ["acme_corp", "globex", ...]
```

### Auto-provisioning in NestJS

You can create a service that provisions all known tenants on application startup:

```typescript
// tenant-provisioning.service.ts
import { Injectable, OnModuleInit } from "@nestjs/common";
import { EntityManager, PostgresTenantMigrationRunner } from "@stingerloom/orm";

@Injectable()
export class TenantProvisioningService implements OnModuleInit {
  private runner: PostgresTenantMigrationRunner;

  constructor(private readonly em: EntityManager) {}

  async onModuleInit() {
    const driver = this.em.getDriver()!;
    this.runner = new PostgresTenantMigrationRunner(driver);

    // Create schemas for all known tenants on startup
    await this.runner.syncTenantSchemas([
      "acme_corp",
      "globex",
    ]);
  }

  // Call this when a new customer signs up
  async provisionTenant(tenantId: string) {
    await this.runner.ensureSchema(tenantId);
  }
}
```

::: info
Schema-based multi-tenancy is currently only supported on PostgreSQL. MySQL doesn't have a schema concept separate from databases, and SQLite doesn't support schemas at all. Using `TenantMigrationRunner` with MySQL or SQLite returns `UnsupportedError`.
:::

---

## Tenant Query Strategy

When a query runs inside a tenant context, the ORM needs to route it to the correct place — schema, column predicate, or physical database. There are four strategies and the choice affects performance, isolation, and operational cost.

### At a glance

| Aspect | `search_path` | `schema_qualified` | `tenant_column` | `database` |
|---|---|---|---|---|
| Dialect support | PostgreSQL only | PostgreSQL only | All (MySQL/PG/SQLite) | All |
| Isolation level | schema | schema | row (predicate) | **physical DB** |
| Round-trips per read | ~5 (BEGIN/SET LOCAL/...) | 1 | 1 | 1 |
| Connection pools | 1 shared | 1 shared | 1 shared | **N (one per tenant)** |
| New tenant cost | `CREATE SCHEMA` | `CREATE SCHEMA` | free | **`CREATE DATABASE`** |
| Cross-tenant joins | OK (same DB) | OK (same DB) | OK (filter by `tenant_id`) | impossible (different DB) |
| Tenants supported | ~100–1k | ~100–1k | 1k+ | ~50 (pool budget) |
| Geo / compliance separation | No | No | No | Yes |
| Per-tenant backup/restore | DB-level | DB-level | DB-level | **trivial** |
| Operational complexity | low | low | lowest | **highest** |

### What is a "round-trip"?

A round-trip is one request-response cycle between your application and the PostgreSQL server. Each costs at least one network latency. If your database is 10ms away, 5 round-trips = 50ms of overhead before you even get your data.

### Strategy 1: `"search_path"` (Default)

PostgreSQL has a session variable called `search_path` that controls which schema unqualified table names resolve to. This strategy sets `search_path` inside a transaction before each tenant query.

```typescript
await em.register({
  type: "postgres",
  // ...
  tenantStrategy: "search_path",  // default — can be omitted
});
```

When you run `em.find(User)` inside a `MetadataContext.run("acme_corp", ...)` block, here's what happens at the network level:

```
App                                    PostgreSQL
 │                                          │
 ├─── 1. BEGIN ──────────────────────────► │
 │◄── OK ───────────────────────────────── │
 │                                          │
 ├─── 2. SET LOCAL search_path            │
 │       TO "acme_corp" ─────────────────► │
 │◄── OK ───────────────────────────────── │
 │                                          │
 ├─── 3. SELECT * FROM "user" ───────────► │  ← unqualified "user" resolves
 │◄── rows ─────────────────────────────── │    to "acme_corp"."user"
 │                                          │
 ├─── 4. COMMIT ─────────────────────────► │
 │◄── OK ───────────────────────────────── │
```

That's 4 round-trips for a single tenant read (connect + BEGIN + SET LOCAL + SELECT + COMMIT). The `SET LOCAL` ensures the search_path change is scoped to this transaction only — it doesn't leak to other connections.

**Pros:** Well-established PostgreSQL pattern. All existing tools (pg_dump, monitoring) work naturally.

**Cons:** Every tenant read requires a transaction wrapper, adding latency.

#### Tenant marker must be a valid PG identifier

Because `search_path` is the default strategy, the value you pass to `MetadataContext.run(<value>)` is used directly as a PostgreSQL schema name in `SET LOCAL search_path TO "<value>"`. That means the marker must be a valid PG identifier — letters, digits, underscores, hyphens, or `$`, starting with a letter or underscore.

If you pass a value that fails the identifier check (e.g. a bare numeric workspace id like `"12345"`), the connector **skips** the `SET LOCAL` and logs one warning per unique invalid marker, rather than aborting every transaction:

```
WARN [PostgresConnector] MetadataContext tenant "12345" is not a valid
PostgreSQL identifier — skipping SET LOCAL search_path. If you intended
schema-based isolation, set tenantStrategy:"schema_qualified" or use a
schema-name tenant marker. If you use MetadataContext only for app-side
context, set tenantStrategy:"tenant_column" to silence this warning.
```

You have three ways to address it:

1. **Use a schema-name marker.** Wrap the numeric id with a prefix you also use as the schema name: `MetadataContext.run(\`tenant_${workspaceId}\`, ...)`.
2. **Switch to `schema_qualified`.** Same isolation model, no `SET LOCAL` round-trip, same identifier rule on the marker.
3. **Switch to `tenant_column` (or `database`).** If you are opening `MetadataContext.run()` purely as an app-side context marker — to make the active workspace visible to subscribers, audit logs, or row-level guards — and isolation is enforced at the column level, declare that explicitly. The connector then never touches `search_path`.

### Strategy 2: `"schema_qualified"`

Instead of changing the search_path, this strategy prefixes table names directly with the schema name:

```typescript
await em.register({
  type: "postgres",
  // ...
  tenantStrategy: "schema_qualified",
});
```

Now `em.find(User)` inside `MetadataContext.run("acme_corp", ...)` generates:

```
App                                    PostgreSQL
 │                                          │
 ├─── SELECT * FROM "acme_corp"."user" ──► │
 │◄── rows ─────────────────────────────── │
```

Just 1 round-trip (plus the connection). No transaction needed for a simple read.

```sql
-- With schema_qualified strategy, tenant context = "acme_corp":
SELECT * FROM "acme_corp"."user"

-- With schema_qualified strategy, tenant context = "public" (or no context):
SELECT * FROM "user"
```

**Pros:** Faster. No unnecessary transaction overhead for reads.

**Cons:** None in practice — the SQL is slightly different but both strategies produce identical results.

### Performance comparison

| Scenario | `search_path` | `schema_qualified` |
|----------|:-------------:|:------------------:|
| Tenant read (round-trips) | 4-5 | **1-2** |
| Non-tenant read | 1-2 | 1-2 |
| Write operations | Transaction (same) | Transaction (same) |
| Result correctness | Identical | Identical |

**When to choose `schema_qualified`:** If your app is read-heavy with many tenant-scoped queries — which most SaaS apps are. With 10ms network latency, a single tenant read goes from ~40ms overhead (search_path) to ~10ms (schema_qualified).

Both strategies produce identical results. The difference is purely in performance. Unless you have a specific reason to use search_path (e.g., compatibility with tools that don't support schema-qualified names), **`schema_qualified` is the better default**.

### Programmatic access

The strategy classes are exported for advanced use cases like custom middleware or testing:

```typescript
import {
  TenantQueryStrategy,
  SearchPathStrategy,
  SchemaQualifiedStrategy,
  TenantColumnStrategy,
} from "@stingerloom/orm";
```

---

## Strategy 3: `tenant_column` (All Dialects)

Schema-based isolation needs PostgreSQL. If your app runs on MySQL or SQLite, or you expect to onboard thousands of tenants where one schema per tenant becomes a catalog and migration problem, there's a third option: keep every tenant's rows in the same tables and tell them apart with a discriminator column.

This is approach **#3** from the introduction — shared DB, shared schema, a `tenant_id` column on every tenant-scoped table. Traditionally it's dangerous, because one forgotten `WHERE tenant_id = ?` leaks another tenant's rows. Stingerloom makes it safe by injecting the predicate automatically on every read / update / delete and validating it on every insert, with an explicit escape hatch for the admin cases where cross-tenant access is intentional.

### When to choose it over `schema_qualified`

| Aspect | `schema_qualified` (Strategy 2) | `tenant_column` (Strategy 3) |
|---|---|---|
| Dialect support | PostgreSQL only | MySQL, PostgreSQL, SQLite |
| Onboarding a new tenant | `CREATE SCHEMA` + `CREATE TABLE (LIKE …)` for every table | Nothing — first INSERT populates `tenant_id` |
| Schema changes | Must apply to every tenant schema | Apply once; all tenants see it immediately |
| `pg_catalog` footprint | N tables × M tenants | N tables total |
| Typical tenant count | 10s to low hundreds | Thousands and up |
| Isolation boundary | PostgreSQL schema (enforced by DB) | ORM-enforced WHERE clauses |
| Raw SQL safety | `search_path` or qualified name already scopes | **You must include the predicate manually** |

`schema_qualified` gives harder isolation at the database level — a raw `SELECT * FROM user` in the wrong context queries the wrong schema, not another tenant's data. `tenant_column` trades that hard boundary for a single shared schema that scales to thousands of tenants without DDL churn per tenant.

### Enabling the strategy

```typescript
await em.register({
  type: "mysql",            // or "postgres" / "sqlite"
  // ...
  entities: [User, Post, Invoice],
  synchronize: true,
  tenantStrategy: "tenant_column",
  tenantColumnName: "tenant_id",   // optional — "tenant_id" is the default
  tenantColumnType: "varchar",     // optional — "varchar" | "uuid" | "int" | "bigint"
  tenantColumnLength: 64,          // optional — only used for varchar
  tenantOnMissingContext: "throw", // optional — "throw" | "warn" (default) | "allow"
});
```

### What happens automatically

With `tenantStrategy: "tenant_column"` the ORM applies four behaviors to every entity without any per-entity code:

1. **DDL injection.** `SchemaRegistrar` adds `tenant_id VARCHAR(64) NOT NULL` (or the configured type) to every table. You don't declare the column on your entity class.
2. **INSERT auto-fill + validation.** `save()` / `saveMany()` / `insertMany()` / `upsert()` / `batchUpsert()` populate `tenant_id` from `MetadataContext.getCurrentTenant()`. Inserting with no active tenant context throws `MISSING_TENANT_CONTEXT`; inserting with an explicit `tenant_id` that disagrees with the context throws `TENANT_MISMATCH`.
3. **WHERE injection on reads.** `find()`, `findOne()`, `findByPK()`, `findAndCount()`, `findWithCursor()`, `count()`, `exists()`, `sum()`, `avg()`, `min()`, `max()`, and `SelectQueryBuilder.getMany()` / `getCount()` / `exists()` all append `AND tenant_id = ?`. Eager joins and relation loaders inherit the same predicate.
4. **WHERE injection on writes.** `updateMany()`, `deleteMany()`, `delete()`, `softDelete()`, `restore()` also get `AND tenant_id = ?`, so a query running under tenant A can never touch tenant B's rows. What happens when **no** tenant context is active at all is governed by the `tenantOnMissingContext` policy (see below).

```typescript
@Entity()
class Post {
  @PrimaryGeneratedColumn() id!: number;
  @Column() title!: string;
}

// Table DDL becomes:
//   CREATE TABLE post (
//     id INTEGER PRIMARY KEY AUTO_INCREMENT,
//     title VARCHAR(255) NOT NULL,
//     tenant_id VARCHAR(64) NOT NULL          ← auto-injected
//   )

await MetadataContext.run("acme", async () => {
  await em.save(Post, { title: "Hello" });
  // → INSERT INTO post (title, tenant_id) VALUES ('Hello', 'acme')

  const posts = await em.find(Post);
  // → SELECT ... FROM post WHERE tenant_id = 'acme'

  await em.delete(Post, { id: 42 });
  // → DELETE FROM post WHERE id = 42 AND tenant_id = 'acme'
});
```

### Reading the tenant value with `@TenantColumn`

Declaring `@TenantColumn` is **optional**. The column is managed by the ORM whether you declare it or not. Declare it only when your application code needs to read the tenant id off an entity instance — audit logs, admin dashboards, cross-tenant exports:

```typescript
import { TenantColumn } from "@stingerloom/orm";

@Entity()
class AuditLog {
  @PrimaryGeneratedColumn() id!: number;
  @Column() action!: string;
  @TenantColumn() tenantId!: string;   // now log.tenantId is readable
}
```

If you assign a value to a `@TenantColumn` property on `save()`, it must match the current context — the ORM throws `TENANT_MISMATCH` otherwise. You can't forge a tenant by setting the property manually.

### Excluding an entity with `@NonTenantEntity`

Some tables are inherently global — the `Tenant` table itself, system configuration, shared lookup tables (countries, currencies, feature flags). Mark them with `@NonTenantEntity()` and the ORM leaves them alone: no DDL column, no WHERE injection, no INSERT validation.

```typescript
import { NonTenantEntity } from "@stingerloom/orm";

@Entity()
@NonTenantEntity()
class Tenant {
  @PrimaryColumn() id!: string;
  @Column() name!: string;
}

@Entity()
@NonTenantEntity()
class Country {
  @PrimaryColumn() code!: string;
  @Column() name!: string;
}
```

An eager join from a tenant-scoped entity into a `@NonTenantEntity` target is safe — the ORM skips the tenant predicate on the non-tenant side automatically.

### Escape hatch: `runUnscoped()`

Sometimes you legitimately need to query across every tenant — a billing report, a nightly background job, a data export. Wrap that code in `MetadataContext.runUnscoped()` and the WHERE injection is skipped:

```typescript
import { MetadataContext } from "@stingerloom/orm";

await MetadataContext.runUnscoped(async () => {
  const allPosts = await em.find(Post);
  // → SELECT ... FROM post           ← no tenant filter
});
```

`runUnscoped()` affects **reads only**. INSERTs still require a tenant context — `runUnscoped()` inside a surrounding `run("acme", …)` inserts into `acme`; outside any `run()` it throws `MISSING_TENANT_CONTEXT` because there's nothing to fill. This asymmetry is deliberate: admin reads are safe, admin writes without tenant attribution are not.

### Per-query opt-out

`runUnscoped()` is context-wide. If you only need to bypass the filter for one specific query, use the per-query opt-out:

```typescript
// FindOption
await em.find(Post, { withoutTenantScope: true });

// SelectQueryBuilder
await em.createQueryBuilder(Post, "p")
  .withoutTenantScope()
  .getMany();
```

Only reads accept the per-query flag. `updateMany` / `deleteMany` / `softDelete` / `restore` intentionally do not — an accidental cross-tenant write should require an explicit `runUnscoped()` block, not a flag that could be flipped on in a one-line refactor.

### Missing context: `tenantOnMissingContext`

The WHERE injection above needs an active `MetadataContext.run()` to know which tenant to bind. Code that runs outside any context — a queue worker, a cron job, a route that missed the tenant middleware — has no tenant, so the predicate cannot be built and the statement would target **every tenant's rows**. INSERT has always failed loud in that state (`MISSING_TENANT_CONTEXT`), but reads, updates and deletes historically ran unfiltered without a single log line.

The `tenantOnMissingContext` option controls what happens instead:

```typescript
await em.register({
  // ...
  tenantStrategy: "tenant_column",
  tenantOnMissingContext: "throw",
});
```

| Policy | Behavior with no active tenant context |
|--------|----------------------------------------|
| `"warn"` (default) | The statement executes unfiltered, and the ORM logs a warning once per entity class. Backward compatible with the previous silent behavior. |
| `"throw"` | The statement rejects with `MISSING_TENANT_CONTEXT` — the same error INSERT raises. Recommended for production. |
| `"allow"` | The statement executes unfiltered, silently. For applications that intentionally mix scoped and global access. |

The policy covers every path that receives the automatic predicate: `find*`, `count`/`exists` and the other aggregates, `SelectQueryBuilder`, relation loaders, `updateMany`, `deleteMany`, `softDelete`, `restore`. It does not change INSERT (which always throws without a context), and it never fires for the sanctioned escape hatches:

- `MetadataContext.runUnscoped()` — the explicit cross-tenant block
- `MetadataContext.run("public", ...)` — the explicit admin/bootstrap context
- the per-query `withoutTenantScope` flag
- `@NonTenantEntity()` entities

The default is `"warn"` for backward compatibility and will change to `"throw"` in the next major version. New projects should set `"throw"` from day one.

#### Background jobs without a context

A queue worker or cron job usually processes one tenant's data at a time. Resolve the tenant from the job payload and wrap the handler — the job then behaves exactly like a scoped request:

```typescript
worker.process(async (job) => {
  await MetadataContext.run(job.data.tenantId, async () => {
    await em.updateMany(Post, { published: true }, { where: { id: job.data.postId } });
  });
});
```

For genuinely cross-tenant maintenance (nightly exports, global backfills), state the intent with `runUnscoped()` — it passes under every policy, including `"throw"`:

```typescript
cron.schedule("0 3 * * *", () =>
  MetadataContext.runUnscoped(async () => {
    const allPosts = await em.find(Post); // intentionally unfiltered
  }),
);
```

### Raw SQL warnings

The ORM injects the tenant predicate on queries it builds. If you call `em.query("SELECT * FROM post")` directly, Stingerloom can't rewrite your SQL — you're responsible for the `WHERE` clause. Under an active tenant context, the first time each call-site invokes `em.query()` the ORM logs:

```
[multi-tenancy] em.query() called under tenant="acme" — raw SQL bypasses
tenant predicate injection. Add "AND tenant_id = ?" to the query, or wrap
the call in MetadataContext.runUnscoped() to acknowledge cross-tenant scope.
    at MyService.rawReport (src/my-service.ts:42:23)
```

The warning deduplicates by call-site, so a hot loop logs once, not thousands of times. Silence it either by including `AND tenant_id = ?` in your SQL explicitly, or by wrapping intentional cross-tenant reads in `runUnscoped()`.

### First-level cache isolation

Stingerloom's Identity Map (WriteBuffer) prefixes its cache keys with the current tenant under this strategy, so `em.findByPK(Post, 1)` in tenant "acme" never serves a cached row from tenant "globex". Inside `runUnscoped()` the identity cache is skipped entirely, because a bare PK is ambiguous when you're reading across tenants.

### Why Stingerloom does not support RLS

PostgreSQL Row-Level Security (`CREATE POLICY`) is sometimes proposed as a safer version of the `tenant_column` approach — the database enforces the predicate instead of the ORM. Stingerloom intentionally does not support RLS:

- **PostgreSQL only.** That defeats the main reason to pick `tenant_column` in the first place (dialect portability).
- **Planner pitfalls.** RLS predicates not marked `STABLE` / `LEAKPROOF` can bypass indexes and invalidate plan caches in ways that are hard to diagnose after the fact.
- **Scope creep.** `CREATE POLICY` is DDL the ORM would have to own end-to-end — policy generation, diffing, migration — doubling the surface area of the schema subsystem for a single-dialect feature.

If you need database-enforced row-level isolation on PostgreSQL, apply RLS policies alongside Stingerloom at the DBA layer — but don't expect the ORM to manage them.

---

## Strategy 4: `database` (All Dialects, Physical Isolation)

`tenantStrategy: "database"` gives every tenant its own physical database — its own pool, its own DDL, its own backup file. The ORM exposes this through `MultiTenantEntityManager`, a thin proxy that resolves `MetadataContext.getCurrentTenant()` on every call and delegates to the matching tenant `EntityManager`. Internally each tenant lives behind the same named-connection mechanism `DatabaseClient` already uses for multi-DB setups — the strategy is **not** a deep query-engine rewrite.

### When to choose it

Pick the database strategy when at least one of these is true:

- **Compliance** — GDPR data residency, HIPAA enterprise tier, KISA, etc. require physical separation.
- **Geographic distribution** — different tenants live on different DB hosts (e.g. APAC tenants on Seoul, EU tenants on Frankfurt).
- **Per-tenant backup/restore SLAs** — `pg_dump tenant_acme` should produce one tenant's data and nothing else.
- **A small number of high-value tenants** — typically ≤50 enterprise customers, not thousands of free-tier accounts.

For SaaS scenarios with thousands of cheap tenants, `tenant_column` is dramatically cheaper to operate. Use `database` only when the strict isolation pays for the extra pools, deployments, and migrations.

### Enabling the strategy

```typescript
import { MultiTenantEntityManager, MetadataContext } from "@stingerloom/orm";

const em = new MultiTenantEntityManager();

await em.register({
  type: "postgres",
  database: "app_admin",          // shared "admin" / "public" DB
  username: "postgres",
  password: "postgres",
  host: "localhost",
  port: 5432,
  entities: [User, Post],
  synchronize: true,
  tenantStrategy: "database",
  tenantDatabaseResolver: (tenantId) => ({
    type: "postgres",
    database: `app_${tenantId}`,  // one physical DB per tenant
    username: "postgres",
    password: "postgres",
    host: "localhost",
    port: 5432,
    entities: [User, Post],
    synchronize: true,
  }),
});

await MetadataContext.run("acme", () => em.find(User));   // → app_acme DB
await MetadataContext.run("globex", () => em.find(User)); // → app_globex DB
```

The same options work on MySQL and SQLite — only the per-tenant `type` / `host` need to change.

### Resolver vs. static map

There are two ways to tell the router which physical DB belongs to which tenant:

- **`tenantDatabaseResolver: (tenantId) => DatabaseClientOptions | string`** — called once per tenant on first use. Return a full options object to provision a brand-new pool, or a string naming a connection you already registered with `DatabaseClient.connect()`. Failures are not cached; a retry calls the resolver again.
- **`tenantDatabaseMap: Record<string, string>`** — a static dictionary checked before the resolver runs, useful when every tenant is known at deploy time.

Both are accepted simultaneously; the map wins if both have an entry for the same tenant.

### Eager provisioning

Lazy resolution is fine for development, but production traffic should not pay the cold-start cost on the first request:

```typescript
await em.register({
  // ...
  tenantStrategy: "database",
  tenantDatabaseResolver: (tenantId) => ({ /* ... */ }),
  eagerProvisionTenants: ["acme", "globex"],   // resolved at register() time
});
```

`eagerProvisionTenants` runs the resolver and `synchronize` for every listed tenant before `register()` returns. Pair it with a startup health check.

### Public-context behavior

When a query reaches the `MultiTenantEntityManager` **outside** any `MetadataContext.run()` block, the strategy needs a policy:

```typescript
publicTenantBehavior: "default"   // (default) route to the admin/public EntityManager
publicTenantBehavior: "throw"     // reject the call with MISSING_TENANT_CONTEXT
```

Use `"throw"` in HTTP services where every request *must* set a tenant — a missing context becomes a fast-failing bug instead of a silent admin-DB write.

### Cross-tenant transactions are forbidden

A SQL transaction is bound to a single connection, which is bound to a single physical database. Switching tenants mid-transaction therefore can't preserve atomicity:

```typescript
await MetadataContext.run("acme", async () => {
  await em.transaction(async () => {
    await em.save(User, { name: "alice" });

    await MetadataContext.run("globex", async () => {
      // ↑ throws OrmErrorCode.CROSS_TENANT_TRANSACTION
      await em.save(User, { name: "carol" });
    });
  });
});
```

If you genuinely need to write to two tenants atomically, you don't have a multi-tenant problem — you have a distributed-transaction problem. Use saga / outbox patterns at the application layer instead.

### Admin fan-out: `forEachTenant`

For dashboards, audits, and migrations you'll want to operate on every tenant:

```typescript
const counts = await em.forEachTenant(async (tenantEm, tenantId) => ({
  tenantId,
  total: await tenantEm.count(User),
}));
// → [{ tenantId: "acme", value: { tenantId: "acme", total: 142 } }, ...]
```

Three modes are supported:

- `"all"` (default) — `Promise.all`, fail-fast on the first rejection.
- `"settled"` — `Promise.allSettled`, returns per-tenant `{ value }` or `{ error }`.
- `"sequential"` — one tenant at a time. Useful when you don't want to overwhelm shared infrastructure.

`forEachTenant` only iterates tenants the router has already resolved. Lazy-only tenants need to be touched (or eagerly provisioned) first.

### NestJS integration

```typescript
import { Module, Injectable } from "@nestjs/common";
import {
  StingerloomOrmModule,
  InjectMultiTenantEntityManager,
  MultiTenantEntityManager,
} from "@stingerloom/orm/nestjs";

@Module({
  imports: [
    StingerloomOrmModule.forRoot({
      type: "postgres",
      database: "app_admin",
      // ...
      tenantStrategy: "database",
      tenantDatabaseResolver: (id) => ({ /* ... */ }),
    }),
  ],
})
class AppModule {}

@Injectable()
class UserService {
  constructor(
    @InjectMultiTenantEntityManager()
    private readonly em: MultiTenantEntityManager,
  ) {}

  async listUsers() {
    // Tenant context is populated by middleware → routed to the right DB.
    return this.em.find(User);
  }
}
```

`@InjectEntityManager()` continues to work — under `tenantStrategy: "database"` it resolves to the **admin / public** `EntityManager` held by the `MultiTenantEntityManager`, suitable for global tables.

### Connection pool budget

The flip side of physical isolation is connection pool *multiplication*. With 50 tenants × `pool.max: 10`, you're asking the database server for 500 connections — PostgreSQL's default `max_connections` is 100. Defensive defaults:

- Set `pool.max` per tenant to a low number (e.g. 5).
- Set `tenantConnectionTtlMs` to evict idle tenant pools and recycle them on demand.
- Monitor `DatabaseClient.getInstance().getRegisteredNames().length` so you notice when the population grows past expectations.

### Raw SQL is safe (no warning)

Because isolation is enforced at the connection level, `em.query("SELECT * FROM user")` only ever sees the current tenant's database. The `tenant_column` raw-SQL warning does not fire under this strategy — there's no `WHERE tenant_id = ?` to bypass.

---

## Direct Use of Layered Metadata

In most applications, `MetadataContext.run()` combined with schema-based isolation is all you need. But the layered metadata system is a lower-level primitive that you can use directly for advanced scenarios — like giving one tenant a different table name or column configuration.

The decorator-time registry is `MetadataLayerRegistry` (`src/scanner/MetadataScanner.ts`). It is a singleton: every `@Entity`/`@Column`/`@ManyToOne` decorator writes to the `"public"` layer of this registry, and every read goes through it. To override metadata for a specific tenant, add a layer to that singleton and switch contexts via `MetadataContext.run()`.

```typescript
import { MetadataLayerRegistry, MetadataContext } from "@stingerloom/orm";

const registry = MetadataLayerRegistry.getInstance();

// Create a tenant layer (writable)
registry.addLayer("enterprise", false);

// Override metadata for this specific tenant within a request scope
await MetadataContext.run("enterprise", async () => {
  registry.getCurrentLayer().set("entities/User", {
    tableName: "enterprise_users", // this tenant uses a different table name
  });
});
```

When the ORM looks up the table name for `User`:
- In the "enterprise" context → finds `"enterprise_users"` in the tenant layer
- In any other context → falls back to the public layer → `"user"` (the default)

### Isolation guarantee

`MetadataLayerRegistry.resolveAll()` merges only the **public layer** and the **currently active context** layer. It never includes data from other tenant layers. This prevents cross-tenant metadata leakage even if multiple tenants are active simultaneously.

```
resolveAll() under MetadataContext.run("acme_corp", ...)
  → public layer + acme_corp layer  (included)
  → globex layer                    (excluded)
  → initech layer                   (excluded)
```

---

## Important Design Rules

**No global state.** All tenant identification flows through `AsyncLocalStorage`, which is safe for concurrent requests. There's no global variable that one request could accidentally overwrite for another.

**The public layer is read-only.** Entity metadata registered via `@Entity` and `@Column` decorators lives in the public layer. You can't modify it at runtime — only tenant layers accept writes.

**Context auto-reverts.** Outside a `MetadataContext.run()` block, the context automatically returns to `"public"`. There's no risk of a tenant context leaking into the next request.

**`setContext()` is deprecated.** Early versions of the ORM used a `setContext()` method that set a global tenant state — dangerous for concurrent requests. Always use `MetadataContext.run()` instead, which scopes the context to a callback via `AsyncLocalStorage`.

---

## Example Project

A complete NestJS multi-tenancy example is available in `examples/nestjs-multitenant/`. It demonstrates middleware setup, schema provisioning, and tenant-isolated CRUD operations.

```bash
cd examples/nestjs-multitenant
pnpm install
pnpm start
```

---

## Next Steps

- [Configuration Guide](./configuration.md) — Operational settings like pooling, Read Replica, etc.
- [Migrations](./migrations.md) — Production schema management
- [Advanced Features](./advanced.md) — Event system, N+1 detection, performance optimization
