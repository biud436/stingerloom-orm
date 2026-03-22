# Multi-Tenancy

## The Problem

Imagine you're building a SaaS product — a project management tool used by hundreds of companies. Company A has 50 employees, Company B has 200. They both use the same application, running on the same server, backed by the same database.

But Company A must **never** see Company B's data. Not in API responses, not in database queries, not even by accident through a bug. This is **multi-tenancy**: one application, many isolated customers (tenants).

There are three common approaches:

1. **Separate databases** — one DB per tenant. Simple but expensive to operate.
2. **Shared database, separate schemas** — one DB, but each tenant gets its own namespace (schema). Good balance of isolation and efficiency.
3. **Shared everything** — one DB, one schema, a `tenant_id` column on every table. Cheapest but risky — a missing WHERE clause leaks data.

Stingerloom ORM supports approach **#2** (schema-based isolation on PostgreSQL) through a **layered metadata system**, and provides the context machinery for approach **#3** as well.

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

When a query runs inside a tenant context, the ORM needs to route it to the correct schema. There are two strategies for this, and the choice affects performance.

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
} from "@stingerloom/orm";
```

---

## Direct Use of Layered Metadata

In most applications, `MetadataContext.run()` combined with schema-based isolation is all you need. But the layered metadata system is a lower-level primitive that you can use directly for advanced scenarios — like giving one tenant a different table name or column configuration.

```typescript
import { LayeredMetadataStore } from "@stingerloom/orm";

const store = new LayeredMetadataStore();

// Create a tenant layer
store.addLayer("enterprise", false);  // false = writable

// Override metadata for this specific tenant
store.setContext("enterprise");
store.set("User", {
  tableName: "enterprise_users",  // this tenant uses a different table name
});
```

When the ORM looks up the table name for `User`:
- In the "enterprise" context → finds `"enterprise_users"` in the tenant layer
- In any other context → falls back to the public layer → `"user"` (the default)

### Isolation guarantee

`getAllInContext("acme_corp")` merges only the **public layer** and the **acme_corp layer**. It never includes data from other tenant layers. This prevents cross-tenant metadata leakage even if multiple tenants are active simultaneously.

```
getAllInContext("acme_corp")
  → public layer ∪ acme_corp layer ✓
  → globex layer is excluded ✗
  → initech layer is excluded ✗
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
