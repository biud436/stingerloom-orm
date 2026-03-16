# Multi-Tenancy

When building SaaS services, you may need to completely isolate data per customer (tenant). Data from Company A's user list should never be mixed with Company B's data.

Stingerloom ORM supports multi-tenancy through a **layered metadata system**. It works on the same principle as Docker's OverlayFS.

## How It Works

```
┌──────────────────────────────────┐
│  Tenant Layer (read/write)       │  <- Per-tenant modifications
│  e.g. overrides for "acme_corp"  │
├──────────────────────────────────┤
│  Public Layer (read-only)        │  <- Base schema (all entities)
│  @Entity, @Column base defs     │
└──────────────────────────────────┘
```

**Read:** Checks the tenant layer first, and falls back to the Public layer if not found.

**Write:** Records only to the current tenant layer (Copy-on-Write). The Public layer is never modified.

The core concept is simple: set "which tenant this request belongs to," and the ORM handles the rest.

## Basic Usage

Use `MetadataContext.run()` to execute code within a specific tenant context.

```typescript
import { MetadataContext } from "@stingerloom/orm";

// Execute within tenant_1 context
await MetadataContext.run("tenant_1", async () => {
  const users = await em.find(User);
  // -> Looks up tenant_1 layer -> public layer in order
});

// Outside the callback, automatically reverts to "public"
```

`MetadataContext.run()` uses `AsyncLocalStorage`, so the same tenant context is maintained across all async functions called within the callback.

```typescript
// Check current tenant
const tenant = MetadataContext.getCurrentTenant(); // "tenant_1" or "public"
const isActive = MetadataContext.isActive();       // true / false
```

## Automatic Setup with NestJS Middleware

In real services, you set the tenant automatically per HTTP request. Using middleware, tenant isolation is applied to all controllers and services without additional code.

```typescript
// tenant.middleware.ts
import { Injectable, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { MetadataContext } from "@stingerloom/orm";

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const tenantId = req.headers["x-tenant-id"] as string ?? "public";

    // Wrap the entire request in a tenant context
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

Now just add the `X-Tenant-Id` header when calling the API.

```bash
# Query users for acme_corp tenant
curl -H "X-Tenant-Id: acme_corp" http://localhost:3000/users

# Query posts for globex tenant
curl -H "X-Tenant-Id: globex" http://localhost:3000/posts

# Without the header -> "public" context
curl http://localhost:3000/users
```

## PostgreSQL Schema-Based Isolation

In PostgreSQL, you can use schemas to physically and completely isolate tenant data. `TenantMigrationRunner` automatically creates per-tenant schemas.

### Tenant Schema Provisioning

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
  synchronize: true,
});

const driver = em.getDriver()!;
const runner = new PostgresTenantMigrationRunner(driver, {
  sourceSchema: "public", // Replicate table structure from this schema
});
```

### Creating a Single Tenant

```typescript
await runner.ensureSchema("acme_corp");
// -> CREATE SCHEMA "acme_corp"
// -> Replicate each table with CREATE TABLE ... (LIKE "public"."users" INCLUDING ALL)
```

### Batch Creating Multiple Tenants

```typescript
const result = await runner.syncTenantSchemas([
  "acme_corp", "globex", "initech", "umbrella"
]);

console.log(result.created);  // ["initech", "umbrella"] — Newly created
console.log(result.skipped);  // ["acme_corp", "globex"] — Already exist
```

### Discovering Existing Schemas

```typescript
const schemas = await runner.discoverSchemas();
// ["public", "acme_corp", "globex"]

runner.isProvisioned("acme_corp");   // true
runner.getProvisionedSchemas();       // ["acme_corp", "globex", ...]
```

### Auto-Provisioning in NestJS

You can create a service that automatically creates all tenant schemas when the app starts.

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

    // Provision tenants on app startup
    await this.runner.syncTenantSchemas([
      "acme_corp",
      "globex",
    ]);
  }

  async provisionTenant(tenantId: string) {
    await this.runner.ensureSchema(tenantId);
  }
}
```

> **Hint** Schema-based multi-tenancy is currently only supported on PostgreSQL. MySQL and SQLite return an `UnsupportedError`.

## Tenant Query Strategy

When using schema-based isolation, Stingerloom needs to route queries to the correct tenant schema. Two strategies are available, configured via the `tenantStrategy` option.

### `"search_path"` (Default)

Sets `search_path` inside a transaction before each tenant read. This is the safest approach but requires 5 round-trips per read query (connect, BEGIN, SET LOCAL, query, COMMIT).

```typescript
await em.register({
  type: "postgres",
  // ...
  tenantStrategy: "search_path", // default — can be omitted
});
```

### `"schema_qualified"`

Prefixes table names with the tenant schema directly (e.g. `"acme_corp"."users"`). This eliminates the need for a transaction on tenant reads, reducing each read to a single round-trip.

```typescript
await em.register({
  type: "postgres",
  // ...
  tenantStrategy: "schema_qualified",
});
```

With this strategy, a query like `em.find(User)` inside `MetadataContext.run("acme_corp", ...)` generates:

```sql
SELECT "id", "name" FROM "acme_corp"."users"
-- instead of: BEGIN; SET LOCAL search_path = "acme_corp"; SELECT ...; COMMIT;
```

### Comparison

| Scenario | `search_path` | `schema_qualified` |
|----------|:-------------:|:------------------:|
| Tenant read (round-trips) | 5 | **1** |
| Non-tenant read | 1 | 1 |
| Write operations | Transaction (unchanged) | Transaction (unchanged) |
| PG + query timeout | Transaction | Transaction |
| MySQL / SQLite | No effect | No effect |

> **When to choose `schema_qualified`:** If your application is read-heavy with many tenant-scoped queries, `schema_qualified` can significantly reduce latency by avoiding unnecessary transactions. Both strategies produce identical results — the difference is purely in performance.

### Programmatic Access

The strategy classes are exported for advanced use cases such as custom middleware or testing.

```typescript
import {
  TenantQueryStrategy,
  SearchPathStrategy,
  SchemaQualifiedStrategy,
} from "@stingerloom/orm";
```

## Direct Use of Layered Metadata

In most cases, `MetadataContext.run()` is sufficient, but when you need to directly override metadata per tenant, use `LayeredMetadataStore`.

```typescript
import { LayeredMetadataStore } from "@stingerloom/orm";

const store = new LayeredMetadataStore();

// Add a tenant layer
store.addLayer("enterprise", false);

// Override metadata for a specific tenant
store.setContext("enterprise");
store.set("User", {
  tableName: "enterprise_users", // Use a different table for this tenant only
});
```

## Important Notes

**Do not use global state** — Access metadata through layers instead of global singletons.

**The Public layer is read-only** — Metadata registered via decorators like `@Entity` and `@Column` is stored in the Public layer. Per-tenant modifications can only be made in separate layers.

**Context scope** — Outside `MetadataContext.run()` blocks, the context automatically reverts to `"public"`.

## Example Project

A complete NestJS multi-tenancy example is available in `examples/nestjs-multitenant/`.

```bash
cd examples/nestjs-multitenant
pnpm install
pnpm start
```

## Next Steps

- [Configuration Guide](./configuration.md) — Operational settings like pooling, Read Replica, etc.
- [Migrations](./migrations.md) — Production schema management
- [Advanced Features](./advanced.md) — Event system, N+1 detection, performance optimization
