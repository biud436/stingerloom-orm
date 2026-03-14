# Production Operations Guide

This document provides configuration, strategies, and troubleshooting guidance for safely operating Stingerloom ORM in production service environments. Make sure to review this when transitioning from development to production.

---

## 1. Recommended Production Settings

### Connection Pool Size

Connection pool size should be determined based on the DB server's `max_connections` and the number of application instances.

**PostgreSQL Recommended Settings**

```typescript
await em.register({
  type: "postgres",
  host: process.env.DB_HOST,
  port: 5432,
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  entities: [User, Post],
  synchronize: false, // Must be false in production
  pool: {
    max: 20,               // Max connections: (DB max_connections / app instances) * 0.8
    min: 5,                // Maintain at least 5 connections even when idle
    acquireTimeoutMs: 5000, // Connection acquire wait time (shorter than default 30000ms)
    idleTimeoutMs: 60000,  // Return connections unused for 60 seconds
  },
});
```

**MySQL/MariaDB Recommended Settings**

```typescript
await em.register({
  type: "mysql",
  host: process.env.DB_HOST,
  port: 3306,
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset: "utf8mb4",
  entities: [User, Post],
  synchronize: false,
  pool: {
    max: 20, // Applied as connectionLimit in MySQL
  },
});
```

> **Note:** MySQL does not support `min`, `acquireTimeoutMs`, or `idleTimeoutMs`. PostgreSQL allows more fine-grained pool control.

**Pool Size Calculation Formula**

```
Recommended pool.max = floor(DB max_connections / app instances) * 0.8
```

Example: PostgreSQL `max_connections = 200`, 4 app instances
-> `pool.max = floor(200 / 4) * 0.8 = 40`

---

### Query Timeout

Prevents connection leaks caused by queries running indefinitely.

```typescript
await em.register({
  // ...
  queryTimeout: 30000, // Global: QueryTimeoutError after 30 seconds
});
```

You can apply different timeouts to specific queries.

```typescript
// Separate timeout for heavy analytical queries
const result = await em.find(Order, {
  where: { status: "completed" },
  timeout: 60000, // 60 seconds for this query only
});

// Real-time queries requiring fast responses
const user = await em.findOne(User, {
  where: { id: userId },
  timeout: 3000, // Fail after 3 seconds
});
```

Internal implementation by DB driver:

| DB | Internal SQL |
|----|-------------|
| MySQL | `SET max_execution_time = N` |
| PostgreSQL | `SET LOCAL statement_timeout = N` |

---

### Retry Options

Automatically recovers from DB server restarts and temporary network disconnections.

```typescript
await em.register({
  // ...
  retry: {
    maxAttempts: 5,  // Maximum 5 retry attempts
    backoffMs: 500,  // Base delay: 500ms (exponential backoff applied)
  },
});
```

Exponential backoff wait times:

| Attempt | Wait Time |
|---------|-----------|
| 1st | 500ms |
| 2nd | 1000ms |
| 3rd | 2000ms |
| 4th | 4000ms |
| 5th | 8000ms |

---

### Logging Level

In production, enable only slow query and N+1 detection, and disable full SQL logging.

```typescript
await em.register({
  // ...
  logging: {
    queries: false,      // Disable full SQL logging (performance impact)
    slowQueryMs: 1000,   // Warn only on queries taking longer than 1 second
    nPlusOne: true,      // Enable N+1 pattern detection
  },
});
```

Query slow queries directly from code:

```typescript
// Use in performance analysis endpoints, etc.
const slowQueries = em.getQueryLog().filter(
  (entry) => entry.durationMs > 1000,
);
```

---

## 2. Transitioning from synchronize to Migrations

### Why `synchronize: true` is Dangerous in Production

`synchronize: true` automatically synchronizes entity definitions with the actual DB schema on app startup. While convenient in development, it poses the following risks in production.

| Risk | Description |
|------|-------------|
| **Data loss** | Renaming a column DROPs the old column and ADDs a new one. Data is lost. |
| **Unexpected DDL** | Schema changes are applied immediately to the production DB after deploying entity modifications. |
| **No rollback** | Automatic changes have no record, making it difficult to revert to a previous state when problems occur. |
| **Downtime** | Adding an index to a large table can cause a full table lock. |

### Step-by-Step Transition Procedure

**Step 1: Check differences between current schema and entities**

```typescript
import { SchemaDiff } from "@stingerloom/orm";

const diff = await SchemaDiff.compare(em, [User, Post, Comment]);

console.log("Tables to add:", diff.addedTables);
console.log("Tables to drop:", diff.droppedTables);
console.log("Tables to modify:", diff.modifiedTables);
```

**Step 2: Auto-generate migrations**

```typescript
import { SchemaDiff, SchemaDiffMigrationGenerator } from "@stingerloom/orm";

const diff = await SchemaDiff.compare(em, [User, Post]);
const generator = new SchemaDiffMigrationGenerator();
const migrations = generator.generate(diff);

console.log(`${migrations.length} migrations generated`);
```

**Step 3: Set up migration CLI**

```typescript
// src/migrate.ts
import { MigrationCli } from "@stingerloom/orm";
import { CreateUsersTable } from "./migrations/001_CreateUsersTable";
import { AddPhoneToUsers } from "./migrations/002_AddPhoneToUsers";

const cli = new MigrationCli(
  [new CreateUsersTable(), new AddPhoneToUsers()],
  {
    type: "postgres",
    host: process.env.DB_HOST!,
    port: 5432,
    username: process.env.DB_USER!,
    password: process.env.DB_PASSWORD!,
    database: process.env.DB_NAME!,
    entities: [],
  },
);

async function main() {
  await cli.connect();
  try {
    const result = await cli.execute(process.argv[2] as any);
    console.log(result);
  } finally {
    await cli.close();
  }
}

main().catch(console.error);
```

```json
// package.json
{
  "scripts": {
    "migrate:run": "ts-node ./src/migrate.ts migrate:run",
    "migrate:rollback": "ts-node ./src/migrate.ts migrate:rollback",
    "migrate:status": "ts-node ./src/migrate.ts migrate:status"
  }
}
```

**Step 4: Disable `synchronize`**

```typescript
// Before
await em.register({ synchronize: true, ... });

// After
await em.register({ synchronize: false, ... }); // or remove the option (default is false)
```

**Step 5: Add migration step to the deployment pipeline**

```bash
# Deployment script example
pnpm build
pnpm migrate:run    # Run migrations before deployment
pm2 restart app     # Restart the app
```

---

## 3. Zero-Downtime Migration Strategies

### Safe Migrations — Can Be Applied Immediately

| Operation | Safe? | Reason |
|-----------|-------|--------|
| `ADD COLUMN NULL` | Safe | Inserts NULL into existing rows, no service impact |
| `ADD COLUMN DEFAULT` | Safe | Automatically filled with default value |
| `CREATE INDEX CONCURRENTLY` | Safe | Creates index without locks (PostgreSQL) |
| `CREATE TABLE` | Safe | No impact on existing tables |
| `ADD FOREIGN KEY NOT VALID` | Safe | Skips existing data validation |

```typescript
// Safe migration example: Adding a nullable column
export class AddOptionalBioToUsers extends Migration {
  async up(context: MigrationContext) {
    await context.query(
      `ALTER TABLE "users" ADD COLUMN "bio" TEXT NULL`
    );
  }

  async down(context: MigrationContext) {
    await context.query(
      `ALTER TABLE "users" DROP COLUMN "bio"`
    );
  }
}
```

### Risky Migrations — Require Staged Application

| Operation | Risk Cause | Mitigation Strategy |
|-----------|-----------|---------------------|
| `DROP COLUMN` | Error if app code references the column | Remove column references from code, then DROP |
| `RENAME COLUMN` | Existing code queries with old name | Add new column -> copy data -> change code -> delete old column |
| `ADD COLUMN NOT NULL` | Error on existing rows without values | Add DEFAULT or allow NULL then backfill data |
| `CREATE INDEX` | Full table lock | PostgreSQL: Use `CONCURRENTLY` option |
| `ALTER COLUMN TYPE` | Type conversion may fail | Add new column -> convert -> swap |

**Column Rename — Step-by-Step Zero-Downtime Method**

```typescript
// Step 1: Add new column (app v1 writes to both columns)
export class Step1_AddNewColumn extends Migration {
  async up(ctx: MigrationContext) {
    await ctx.query(
      `ALTER TABLE "users" ADD COLUMN "display_name" VARCHAR(100) NULL`
    );
    // Copy existing data
    await ctx.query(
      `UPDATE "users" SET "display_name" = "name" WHERE "display_name" IS NULL`
    );
  }
}

// Step 2: Deploy app v2 (reads/writes only new column)

// Step 3: Drop old column
export class Step3_DropOldColumn extends Migration {
  async up(ctx: MigrationContext) {
    await ctx.query(
      `ALTER TABLE "users" DROP COLUMN "name"`
    );
  }
}
```

### Blue-Green Deployment Migration Order

In blue-green deployments, the old version (Blue) and new version (Green) simultaneously access the same DB.

```
Order:
1. Run backward-compatible migrations (works on the old version)
2. Deploy Green and switch traffic
3. Run cleanup migrations (old version no longer exists)
```

```bash
# 1. Backward-compatible migrations (works for both Blue and Green)
pnpm migrate:run   # Only includes ADD COLUMN NULL, ADD INDEX, etc.

# 2. Deploy Green
kubectl apply -f deployment-green.yaml

# 3. Cleanup after traffic switch
pnpm migrate:run   # Final cleanup: DROP old columns, RENAME, etc.
```

---

## 4. Connection Pool Monitoring

### Checking Pool Status

You can directly query the current connection status in PostgreSQL.

```typescript
// Query connection status (PostgreSQL)
const stats = await em.query<{ state: string; count: string }[]>(`
  SELECT state, count(*)::text as count
  FROM pg_stat_activity
  WHERE datname = current_database()
  GROUP BY state
`);

console.log("Connection status:", stats);
// [
//   { state: "active", count: "5" },
//   { state: "idle", count: "15" },
//   { state: "idle in transaction", count: "2" }
// ]
```

A high count of `idle in transaction` indicates that transactions are being held open for a long time without commit/rollback.

**Querying connection status in MySQL**

```typescript
const processlist = await em.query<{ Command: string; Time: number }[]>(
  `SHOW PROCESSLIST`
);

const longRunning = processlist.filter((p) => p.Time > 30);
console.log("Running for 30+ seconds:", longRunning.length);
```

### Detecting Connection Leaks via Slow Queries

If a transaction is opened but never closed, the connection is not returned to the pool, causing pool exhaustion. Use `queryTimeout` to automatically terminate long-running queries.

```typescript
await em.register({
  // ...
  queryTimeout: 30000, // Auto-terminate queries exceeding 30 seconds
  logging: {
    slowQueryMs: 5000,  // Warning log for queries taking 5+ seconds
    nPlusOne: true,
  },
  pool: {
    max: 20,
    acquireTimeoutMs: 5000, // Error if connection not acquired within 5 seconds -> early pool exhaustion detection
  },
});
```

### Connection Leak Troubleshooting Guide

**Symptom:** `acquireTimeoutMs` exceeded errors occurring frequently

**Cause 1: Pool size too small**
```typescript
// Solution: Increase pool.max
pool: { max: 30 }
```

**Cause 2: Unclosed transactions**
```typescript
// Problem: Using transactions without try -> connection not returned on error
// Using Stingerloom's @Transactional decorator handles this automatically.
import { Transactional } from "@stingerloom/orm";

@Transactional()
async createOrder(data: CreateOrderDto) {
  await this.orderRepo.save(data);     // Auto ROLLBACK + connection return on error
  await this.inventoryRepo.save(data);
}
```

**Cause 3: No query timeout configured**
```typescript
// Solution: Set global timeout
queryTimeout: 30000
```

---

## 5. Graceful Shutdown Setup

### Using `propagateShutdown()`

`propagateShutdown()` safely cleans up `EntityManager`'s internal state.

```typescript
em.propagateShutdown(); // This method performs:
// - Remove event listeners (removeAllListeners)
// - Unsubscribe EntitySubscribers
// - Reset dirty entities cache
// - Clean up QueryTracker
// - Clean up ReplicationRouter
```

DB connection pool shutdown is handled through `DatabaseClient`.

### NestJS `onApplicationShutdown` Integration Example

Graceful Shutdown is already implemented in the ORM service of the example project (`examples/nestjs-cats/`).

```typescript
// stingerloom-orm.service.ts
import {
  Injectable,
  OnModuleInit,
  OnApplicationShutdown,
} from "@nestjs/common";
import { EntityManager } from "@stingerloom/orm";

@Injectable()
export class StinglerloomOrmService
  implements OnModuleInit, OnApplicationShutdown
{
  constructor(private readonly entityManager: EntityManager) {}

  async onModuleInit(): Promise<void> {
    await this.entityManager.register({ /* settings */ });
  }

  async onApplicationShutdown(): Promise<void> {
    // 1. Clean up EntityManager internal state
    await this.entityManager.propagateShutdown();
    // 2. DB connection pool shutdown is handled automatically by DatabaseClient
    console.log("ORM connection released");
  }
}
```

### SIGTERM/SIGINT Handling (without NestJS)

```typescript
// main.ts (plain Node.js)
import "reflect-metadata";
import { EntityManager } from "@stingerloom/orm";

const em = new EntityManager();

async function main() {
  await em.register({ /* settings */ });
  console.log("Server started");

  // Register Graceful Shutdown handler
  const shutdown = async (signal: string) => {
    console.log(`${signal} received — shutting down...`);
    await em.propagateShutdown();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM")); // Kubernetes, Docker shutdown signal
  process.on("SIGINT", () => shutdown("SIGINT"));   // Ctrl+C
}

main().catch(console.error);
```

### NestJS enableShutdownHooks Configuration

For `onApplicationShutdown` to be called when OS signals are received in NestJS, this must be enabled.

```typescript
// main.ts (NestJS)
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Enable NestJS to handle OS signals like SIGTERM, SIGINT
  app.enableShutdownHooks();

  await app.listen(3000);
}

bootstrap();
```

> **Note:** If `enableShutdownHooks()` is not called, `onApplicationShutdown` will not be invoked when a Kubernetes Pod is terminated.

---

## 6. Large-Scale Multi-Tenancy Operations

### Memory Impact with Hundreds of Tenants

The layered metadata system is AsyncLocalStorage-based, so even with many tenants, memory is primarily consumed by metadata layers.

| Factor | Memory Impact | Notes |
|--------|--------------|-------|
| Layered metadata | A few KB per tenant | Proportional to entity count |
| Connection pool | **Shared** (single pool) | Independent of tenant count |
| AsyncLocalStorage | Only creates context per request | Auto-cleaned on request completion |

Tenant layers are created via `MetadataContext.run()` and automatically cleaned up when the callback completes. Even with 1,000 tenants, the concurrent connection pool is shared as one.

### Connection Pool Sharing Strategy

In PostgreSQL schema-based multi-tenancy, all tenants share a single connection pool. `SET LOCAL search_path` switches schemas per transaction, so no additional connections are needed.

```typescript
// PostgreSQL multi-tenancy: Handle all tenants with a single pool.max
await em.register({
  type: "postgres",
  // ...
  pool: {
    // Calculate based on tenant count * expected concurrent requests
    // e.g., 100 tenants * 0.2 concurrent requests = 20 connections
    max: 20,
    min: 5,
    acquireTimeoutMs: 5000,
    idleTimeoutMs: 60000,
  },
});
```

### Tenant Provisioning Automation

`PostgresTenantMigrationRunner` automatically creates new tenant schemas. It internally uses a provisioning lock to prevent duplicate provisioning.

```typescript
// tenant-provisioning.service.ts
import { Injectable, OnModuleInit } from "@nestjs/common";
import { EntityManager, PostgresTenantMigrationRunner } from "@stingerloom/orm";

@Injectable()
export class TenantProvisioningService implements OnModuleInit {
  private runner!: PostgresTenantMigrationRunner;

  constructor(private readonly em: EntityManager) {}

  async onModuleInit() {
    const driver = this.em.getDriver()!;
    this.runner = new PostgresTenantMigrationRunner(driver, {
      sourceSchema: "public", // Replicate table structure from the public schema
    });

    // Synchronize all existing tenant schemas on app startup
    const result = await this.runner.syncTenantSchemas([
      "acme_corp",
      "globex",
      "umbrella",
    ]);

    console.log(`Newly created: ${result.created.join(", ")}`);
    console.log(`Already exist: ${result.skipped.join(", ")}`);
  }

  // Called from the new tenant registration API
  async provisionTenant(tenantId: string): Promise<void> {
    await this.runner.ensureSchema(tenantId);
    // Even with concurrent calls for the same tenantId, provisioning occurs only once (lock guarantee)
  }

  // Check if a specific tenant is provisioned
  isTenantProvisioned(tenantId: string): boolean {
    return this.runner.isProvisioned(tenantId);
  }
}
```

### Per-HTTP-Request Tenant Context Setup

```typescript
// tenant.middleware.ts
import { Injectable, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { MetadataContext } from "@stingerloom/orm";

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(
    private readonly provisioningService: TenantProvisioningService,
  ) {}

  use(req: Request, res: Response, next: NextFunction) {
    const tenantId = req.headers["x-tenant-id"] as string;

    if (!tenantId) {
      // Requests without tenant header use public context
      return next();
    }

    // Wrap the entire request in a tenant context
    // Thanks to AsyncLocalStorage, the same context is maintained across all async calls within the request
    MetadataContext.run(tenantId, () => {
      next();
    });
  }
}
```

### Considerations When Initializing Large Numbers of Tenants

When there are hundreds of tenants, provisioning all of them at app startup can slow down the start time.

```typescript
// Recommended: Provision in batches
async function provisionAllTenants(
  runner: PostgresTenantMigrationRunner,
  tenantIds: string[],
  batchSize = 20,
) {
  for (let i = 0; i < tenantIds.length; i += batchSize) {
    const batch = tenantIds.slice(i, i + batchSize);
    await runner.syncTenantSchemas(batch);
    console.log(`Provisioning complete: ${i + batch.length}/${tenantIds.length}`);
  }
}
```

> **Note:** `ensureSchema()` uses an internal lock to prevent duplicate provisioning when called concurrently with the same tenantId. It can be safely used in new tenant registration APIs.

---

## Full Production Configuration Example

Below is a complete configuration example recommended for NestJS production environments.

```typescript
// app.module.ts
import { Module } from "@nestjs/common";
import { StinglerloomOrmModule } from "@stingerloom/orm/nestjs";
import { User, Post, Comment } from "./entities";

@Module({
  imports: [
    StinglerloomOrmModule.forRoot({
      type: "postgres",
      host: process.env.DB_HOST!,
      port: parseInt(process.env.DB_PORT ?? "5432"),
      username: process.env.DB_USER!,
      password: process.env.DB_PASSWORD!,
      database: process.env.DB_NAME!,
      entities: [User, Post, Comment],
      synchronize: false, // Must be false in production
      queryTimeout: 30000, // 30-second global timeout
      pool: {
        max: 20,
        min: 5,
        acquireTimeoutMs: 5000,
        idleTimeoutMs: 60000,
      },
      retry: {
        maxAttempts: 5,
        backoffMs: 500,
      },
      logging: {
        queries: false,
        slowQueryMs: 1000,
        nPlusOne: true,
      },
      replication: {
        master: {
          host: process.env.DB_MASTER_HOST!,
          port: 5432,
          username: process.env.DB_USER!,
          password: process.env.DB_PASSWORD!,
          database: process.env.DB_NAME!,
        },
        slaves: [
          {
            host: process.env.DB_REPLICA_HOST!,
            port: 5432,
            username: process.env.DB_READONLY_USER!,
            password: process.env.DB_READONLY_PASSWORD!,
            database: process.env.DB_NAME!,
          },
        ],
      },
    }),
  ],
})
export class AppModule {}
```

```typescript
// main.ts
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Enable Graceful Shutdown (required)
  app.enableShutdownHooks();

  await app.listen(process.env.PORT ?? 3000);
}

bootstrap();
```

---

## Next Steps

- [Migrations](./migrations.md) — Writing and running migration files
- [Multi-Tenancy](./multi-tenancy.md) — Layered metadata system details
- [Configuration Guide](./configuration.md) — Full configuration options reference
- [Advanced Features](./advanced.md) — N+1 detection, EntitySubscriber, EXPLAIN queries
