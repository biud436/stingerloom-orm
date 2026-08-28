# Tutorial: Building an IoT Smart Thermometer Backend

## What We're Building

Imagine a smart building. Thousands of tiny thermometers are embedded in walls, ceilings, and air ducts — like nerve endings in a body. Every 30 seconds, each one whispers a temperature reading to a central server. A mobile app shows real-time dashboards. Alerts fire when a server room overheats. Nightly cron jobs crunch the numbers into daily reports.

Now imagine ten different buildings, each owned by a different company, all running on your single backend. Company A must never see Company B's data. This is **multi-tenancy**.

In this tutorial, we'll build that backend from scratch using NestJS and Stingerloom ORM. Here is the architecture:

```
┌───────────────┐     ┌───────────────┐
│  Android App  │     │   iOS App     │
└──────┬────────┘     └──────┬────────┘
       │   HTTPS + JWT       │
       └──────────┬──────────┘
                  ▼
       ┌─────────────────────┐
       │   NestJS API Server │
       │  ┌───────────────┐  │
       │  │  Keycloak JWT │  │ ← Authentication
       │  │  Guard        │  │
       │  ├───────────────┤  │
       │  │  Tenant       │  │ ← Multi-tenancy context
       │  │  Middleware    │  │
       │  ├───────────────┤  │
       │  │  Stingerloom  │  │ ← Entity definitions, CRUD,
       │  │  ORM          │  │   aggregation, streaming
       │  └───────────────┘  │
       └──┬─────┬────────┬───┘
          │     │        │
          ▼     ▼        ▼
      ┌──────┐ ┌─────┐ ┌───────┐
      │Postgres│ │Redis│ │BullMQ │
      │(data) │ │(cache)│ │(cron) │
      └──────┘ └─────┘ └───────┘
```

### What is the ORM's job — and what is NOT?

Before we write a single line of code, let's draw a clear boundary. An ORM is a translator between your TypeScript objects and your database. It is not a cache, not a job queue, and not an authentication system.

| Concern | Handled by | NOT handled by |
|---------|-----------|----------------|
| Entity definitions & schema | **Stingerloom ORM** | — |
| Multi-tenant schema routing | **Stingerloom ORM** (MetadataContext) | — |
| CRUD operations | **Stingerloom ORM** (EntityManager) | — |
| Aggregation queries | **Stingerloom ORM** (avg/min/max/count) | — |
| Batch processing large datasets | **Stingerloom ORM** (stream()) | — |
| JWT authentication | NestJS + Passport | ORM |
| Response caching | Redis (ioredis) | ORM |
| Background jobs / cron | BullMQ (@nestjs/bullmq) | ORM |
| Push notifications | FCM / APNs | ORM |

Throughout this tutorial, we will call out every boundary crossing with a `::: tip` or `::: warning` box so you always know which tool is doing what.

---

## Step 0: Infrastructure with Docker Compose

Before writing any code, we need three services running locally: PostgreSQL for data, Redis for caching, and Keycloak for JWT authentication.

Create a `docker-compose.yml` in your project root:

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: smart_thermo
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    ports:
      - "5432:5432"
    volumes:
      - pg_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  keycloak:
    image: quay.io/keycloak/keycloak:24.0
    command: start-dev
    environment:
      KEYCLOAK_ADMIN: admin
      KEYCLOAK_ADMIN_PASSWORD: admin
      KC_DB: postgres
      KC_DB_URL: jdbc:postgresql://postgres:5432/smart_thermo
      KC_DB_USERNAME: postgres
      KC_DB_PASSWORD: postgres
    ports:
      - "8080:8080"
    depends_on:
      - postgres

volumes:
  pg_data:
```

```bash
docker compose up -d
```

Once all three containers are healthy, configure Keycloak:

1. Open `http://localhost:8080` and log in with `admin` / `admin`
2. Create a realm named `smart-thermo`
3. Create a client named `smart-thermo-api` (Access Type: confidential)
4. In the client's **Mappers** tab, add a mapper:
   - Name: `tenantId`
   - Mapper Type: User Attribute
   - User Attribute: `tenantId`
   - Token Claim Name: `tenantId`
   - Claim JSON Type: `String`
   - Add to ID token: ON, Add to access token: ON
5. Create a test user and set their `tenantId` attribute to `building_a`

This embeds the tenant identifier directly into the JWT. When the mobile app authenticates, the token it receives already knows which building it belongs to.

---

## Step 1: Project Setup

### Scaffold the NestJS project

```bash
nest new smart-thermo-api
cd smart-thermo-api
```

### Install dependencies

::: code-group
```bash [pnpm]
pnpm add @stingerloom/orm pg reflect-metadata
pnpm add @nestjs/passport passport passport-jwt jwks-rsa
pnpm add @nestjs/bullmq bullmq
pnpm add @nestjs-modules/ioredis ioredis
pnpm add -D @types/passport-jwt
```
```bash [npm]
npm install @stingerloom/orm pg reflect-metadata
npm install @nestjs/passport passport passport-jwt jwks-rsa
npm install @nestjs/bullmq bullmq
npm install @nestjs-modules/ioredis ioredis
npm install -D @types/passport-jwt
```
:::

### Enable decorators

Make sure your `tsconfig.json` has these two flags:

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

### Configure the ORM

```typescript
// src/app.module.ts
import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { RedisModule } from "@nestjs-modules/ioredis";
import { Device } from "./entities/device.entity";
import { User } from "./entities/user.entity";
import { TemperatureReading } from "./entities/temperature-reading.entity";
import { AlertRule } from "./entities/alert-rule.entity";
import { Alert } from "./entities/alert.entity";
import { DailyStats } from "./entities/daily-stats.entity";

@Module({
  imports: [
    StingerloomOrmModule.forRoot({
      type: "postgres",
      host: process.env.DB_HOST || "localhost",
      port: parseInt(process.env.DB_PORT || "5432"),
      username: process.env.DB_USER || "postgres",
      password: process.env.DB_PASSWORD || "postgres",
      database: process.env.DB_NAME || "smart_thermo",
      entities: [User, Device, TemperatureReading, AlertRule, Alert, DailyStats],
      synchronize: true,
      logging: true,
    }),
    RedisModule.forRoot({
      type: "single",
      url: process.env.REDIS_URL || "redis://localhost:6379",
    }),
    // ... other modules added later
  ],
})
export class AppModule {}
```

`RedisModule.forRoot()` registers a global Redis connection that can be injected anywhere with `@InjectRedis()`. No more `new Redis()` scattered throughout your services.

::: warning
`synchronize: true` is convenient during development — the ORM creates and alters tables to match your entities. **Never use it in production.** Use [Migrations](./migrations.md) instead.
:::

---

## Step 2: Designing the Entities

Good entity design starts with understanding the domain. A smart thermometer system has these core concepts:

- **Users** own devices (the person who installed the thermometer)
- **Devices** are the physical thermometers, each with a serial number and location
- **Temperature Readings** are the time-series data points — one every 30 seconds per device
- **Alert Rules** define thresholds ("notify me if temperature exceeds 35°C")
- **Alerts** are the fired notifications when a rule is violated
- **Daily Stats** are pre-computed daily summaries (average, min, max) for fast dashboard rendering

```
┌──────────┐       ┌──────────┐       ┌─────────────────────┐
│   User   │1    * │  Device  │1    * │ TemperatureReading   │
│──────────│───────│──────────│───────│─────────────────────│
│ id       │       │ id       │       │ id                  │
│ name     │       │ serial   │       │ temperatureCelsius  │
│ email    │       │ name     │       │ humidity            │
│ keycloak │       │ location │       │ batteryLevel        │
│ deletedAt│       │ isActive │       │ recordedAt          │
└──────────┘       └──────┬───┘       └─────────────────────┘
                          │
                   ┌──────┴───────────────────┐
                   │1                        1│
                   ▼ *                        ▼ *
           ┌─────────────┐            ┌─────────────┐
           │  AlertRule   │            │  DailyStats  │
           │─────────────│            │─────────────│
           │ condition    │            │ date         │
           │ threshold    │            │ avgTemp      │
           │ isEnabled    │            │ minTemp      │
           └──────┬──────┘            │ maxTemp      │
                  │1                  │ readingCount │
                  ▼ *                 └─────────────┘
           ┌─────────────┐
           │   Alert      │
           │─────────────│
           │ temperature  │
           │ acknowledged │
           │ firedAt      │
           └─────────────┘
```

### User

```typescript
// src/entities/user.entity.ts
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  OneToMany,
  CreateTimestamp,
  DeletedAt,
} from "@stingerloom/orm";
import { Device } from "./device.entity";

@Entity({ name: "users" })
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 100 })
  name!: string;

  @Column({ type: "varchar", length: 255 })
  email!: string;

  @Column({ type: "uuid" })
  keycloakSubjectId!: string;

  @OneToMany(() => Device, { mappedBy: "user" })
  devices!: Device[];

  @CreateTimestamp()
  createdAt!: Date;

  @DeletedAt()
  deletedAt!: Date | null;
}
```

The `@DeletedAt()` decorator enables **soft delete**. When you call `em.delete(User, { id: 1 })`, the ORM does not actually remove the row. Instead, it sets `deletedAt` to the current timestamp. All subsequent `find()` queries automatically exclude soft-deleted rows — unless you pass `withDeleted: true`. This is essential for GDPR compliance: you can "delete" a user's visible presence while preserving audit trails.

```sql
-- What the ORM generates for this entity (PostgreSQL)
CREATE TABLE "users" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(100) NOT NULL,
  "email" VARCHAR(255) NOT NULL,
  "keycloakSubjectId" UUID NOT NULL,
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "deletedAt" TIMESTAMP
);
```

### Device

```typescript
// src/entities/device.entity.ts
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  OneToMany,
  RelationColumn,
  Index,
  CreateTimestamp,
  UpdateTimestamp,
  BeforeInsert,
} from "@stingerloom/orm";
import { User } from "./user.entity";
import { TemperatureReading } from "./temperature-reading.entity";

@Entity({ name: "devices" })
export class Device {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index()
  @Column({ type: "varchar", length: 64 })
  serialNumber!: string;

  @Column({ type: "varchar", length: 100 })
  name!: string;

  @Column({ type: "varchar", length: 200, nullable: true })
  location!: string | null;

  @Column({ type: "boolean" })
  isActive!: boolean;

  @ManyToOne(() => User, (user) => user.devices)
  @RelationColumn({ name: "user_id" })
  user!: User;

  @OneToMany(() => TemperatureReading, { mappedBy: "device" })
  readings!: TemperatureReading[];

  @CreateTimestamp()
  createdAt!: Date;

  @UpdateTimestamp()
  updatedAt!: Date;

  @BeforeInsert()
  setDefaults() {
    if (this.isActive === undefined) this.isActive = true;
    if (!this.name) this.name = `Sensor-${this.serialNumber}`;
  }
}
```

The `@BeforeInsert()` hook runs before the INSERT SQL is sent to the database. Here we use it to set sensible defaults — a newly registered thermometer should be active, and if no name is given, we generate one from the serial number.

```sql
-- What the ORM generates for this entity (PostgreSQL)
CREATE TABLE "devices" (
  "id" SERIAL PRIMARY KEY,
  "serialNumber" VARCHAR(64) NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "location" VARCHAR(200),
  "isActive" BOOLEAN NOT NULL,
  "user_id" INTEGER NOT NULL REFERENCES "users"("id"),
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "updatedAt" TIMESTAMP DEFAULT NOW()
);
CREATE INDEX "idx_devices_serialNumber" ON "devices" ("serialNumber");
```

### TemperatureReading

This is the **high-volume entity** — the one that will have millions of rows. Its design decisions directly impact query performance.

```typescript
// src/entities/temperature-reading.entity.ts
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  RelationColumn,
  Index,
  CreateTimestamp,
  BeforeInsert,
} from "@stingerloom/orm";
import { Device } from "./device.entity";

@Entity({ name: "temperature_readings" })
export class TemperatureReading {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Device, (d) => d.readings)
  @RelationColumn({ name: "device_id" })
  device!: Device;

  @Index()
  @Column({ type: "float" })
  temperatureCelsius!: number;

  @Column({ type: "float", nullable: true })
  humidity!: number | null;

  @Column({ type: "float", nullable: true })
  batteryLevel!: number | null;

  @Index()
  @Column({ type: "timestamp" })
  recordedAt!: Date;

  @CreateTimestamp()
  createdAt!: Date;

  @BeforeInsert()
  validateTemperature() {
    if (this.temperatureCelsius < -273.15) {
      throw new Error("Temperature cannot be below absolute zero (-273.15°C)");
    }
    if (this.temperatureCelsius > 1000) {
      throw new Error("Temperature exceeds sensor range (1000°C)");
    }
  }
}
```

```sql
-- What the ORM generates for this entity (PostgreSQL)
CREATE TABLE "temperature_readings" (
  "id" SERIAL PRIMARY KEY,
  "device_id" INTEGER NOT NULL REFERENCES "devices"("id"),
  "temperatureCelsius" FLOAT NOT NULL,
  "humidity" FLOAT,
  "batteryLevel" FLOAT,
  "recordedAt" TIMESTAMP NOT NULL,
  "createdAt" TIMESTAMP DEFAULT NOW()
);
CREATE INDEX "idx_temperature_readings_temperatureCelsius" ON "temperature_readings" ("temperatureCelsius");
CREATE INDEX "idx_temperature_readings_recordedAt" ON "temperature_readings" ("recordedAt");
```

Notice the `@Index()` on `recordedAt` and `temperatureCelsius`. Without indexes, a query like "find the highest temperature in the last 7 days" would scan every row in the table. With the index, the database can jump directly to the relevant date range.

The `@BeforeInsert()` hook acts as a data quality gate. A sensor that reports -500°C is clearly malfunctioning. We reject the data before it even reaches the database.

### AlertRule

```typescript
// src/entities/alert-rule.entity.ts
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  RelationColumn,
  CreateTimestamp,
} from "@stingerloom/orm";
import { Device } from "./device.entity";

@Entity({ name: "alert_rules" })
export class AlertRule {
  @PrimaryGeneratedColumn()
  id!: number;

  // Unidirectional relation: Device has no inverse property for alert
  // rules, so the required second argument is () => undefined.
  @ManyToOne(() => Device, () => undefined)
  @RelationColumn({ name: "device_id" })
  device!: Device;

  @Column({ type: "varchar", length: 20 })
  condition!: string; // "above" | "below"

  @Column({ type: "float" })
  thresholdCelsius!: number;

  @Column({ type: "boolean" })
  isEnabled!: boolean;

  @CreateTimestamp()
  createdAt!: Date;
}
```

```sql
-- What the ORM generates for this entity (PostgreSQL)
CREATE TABLE "alert_rules" (
  "id" SERIAL PRIMARY KEY,
  "device_id" INTEGER NOT NULL REFERENCES "devices"("id"),
  "condition" VARCHAR(20) NOT NULL,
  "thresholdCelsius" FLOAT NOT NULL,
  "isEnabled" BOOLEAN NOT NULL,
  "createdAt" TIMESTAMP DEFAULT NOW()
);
```

### Alert

```typescript
// src/entities/alert.entity.ts
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  RelationColumn,
  CreateTimestamp,
} from "@stingerloom/orm";
import { AlertRule } from "./alert-rule.entity";
import { TemperatureReading } from "./temperature-reading.entity";

@Entity({ name: "alerts" })
export class Alert {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => AlertRule, () => undefined)
  @RelationColumn({ name: "alert_rule_id" })
  rule!: AlertRule;

  @ManyToOne(() => TemperatureReading, () => undefined)
  @RelationColumn({ name: "reading_id" })
  reading!: TemperatureReading;

  @Column({ type: "float" })
  temperatureCelsius!: number;

  @Column({ type: "boolean" })
  acknowledged!: boolean;

  @CreateTimestamp()
  firedAt!: Date;
}
```

```sql
-- What the ORM generates for this entity (PostgreSQL)
CREATE TABLE "alerts" (
  "id" SERIAL PRIMARY KEY,
  "alert_rule_id" INTEGER NOT NULL REFERENCES "alert_rules"("id"),
  "reading_id" INTEGER NOT NULL REFERENCES "temperature_readings"("id"),
  "temperatureCelsius" FLOAT NOT NULL,
  "acknowledged" BOOLEAN NOT NULL,
  "firedAt" TIMESTAMP DEFAULT NOW()
);
```

### DailyStats

Think of this entity as a **monthly bank statement**. Instead of listing every individual transaction, the bank gives you a summary: total deposits, total withdrawals, ending balance. We do the same with temperature data: instead of querying millions of raw readings every time someone opens the dashboard, we pre-compute daily summaries.

```typescript
// src/entities/daily-stats.entity.ts
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  RelationColumn,
  Index,
  UpdateTimestamp,
} from "@stingerloom/orm";
import { Device } from "./device.entity";

@Entity({ name: "daily_stats" })
export class DailyStats {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Device, () => undefined)
  @RelationColumn({ name: "device_id" })
  device!: Device;

  @Index()
  @Column({ type: "date" })
  date!: string;

  @Column({ type: "float" })
  avgTemperature!: number;

  @Column({ type: "float" })
  minTemperature!: number;

  @Column({ type: "float" })
  maxTemperature!: number;

  @Column({ type: "int" })
  readingCount!: number;

  @UpdateTimestamp()
  updatedAt!: Date;
}
```

The `@UpdateTimestamp()` decorator is critical here. When the nightly cron job re-aggregates today's data, the ORM automatically updates this field. If you see `updatedAt` is stale, you know the cron job hasn't run.

```sql
-- What the ORM generates for this entity (PostgreSQL)
CREATE TABLE "daily_stats" (
  "id" SERIAL PRIMARY KEY,
  "device_id" INTEGER NOT NULL REFERENCES "devices"("id"),
  "date" DATE NOT NULL,
  "avgTemperature" FLOAT NOT NULL,
  "minTemperature" FLOAT NOT NULL,
  "maxTemperature" FLOAT NOT NULL,
  "readingCount" INTEGER NOT NULL,
  "updatedAt" TIMESTAMP DEFAULT NOW()
);
CREATE INDEX "idx_daily_stats_date" ON "daily_stats" ("date");
```

### Design Decisions Explained

#### Why `@Index()` on `recordedAt` and `temperatureCelsius`?

PostgreSQL stores indexes as B-tree structures by default. A B-tree on `recordedAt` allows the database to satisfy range queries (`BETWEEN`, `>=`, `<`) and `ORDER BY` without scanning the entire table. Instead of reading every row to find "readings from the last 7 days," the database walks the tree to the starting point and reads sequentially from there.

Without the index, a table with 10 million rows requires a sequential scan — the database reads every single row and checks the WHERE condition. This takes seconds. With a B-tree index, the same query completes in milliseconds because the database skips directly to the relevant range.

The index on `temperatureCelsius` serves the same purpose for threshold queries ("find all readings above 35 degrees"). In Step 6, we will use `explain()` to verify that these indexes are actually being used by the query planner.

#### Why `@BeforeInsert()` instead of database CHECK constraints?

Both approaches validate data, but they operate at different layers:

- **ORM hooks** (`@BeforeInsert()`) run in your application code, before the SQL reaches the database. They can produce descriptive error messages ("Temperature cannot be below absolute zero"), run complex business logic (cross-field validation, external API calls), and integrate with your application's error handling pipeline.

- **Database CHECK constraints** (`CHECK (temperature_celsius >= -273.15)`) run inside PostgreSQL. They are the last line of defense — they catch invalid data even if it bypasses your ORM (raw SQL scripts, database migrations, other applications writing to the same database).

The ideal approach is to use both: hooks for user-facing validation with clear error messages, and CHECK constraints as a safety net for data integrity. In this tutorial we focus on hooks because they are the ORM feature being demonstrated, but in production, add CHECK constraints to your migration files.

#### Why `@DeletedAt()` (soft delete) for Users but not for Readings?

Users have audit and compliance requirements. Under regulations like GDPR, you may need to "delete" a user's visible presence while preserving records that prove you handled their data correctly. Soft delete achieves this — the user disappears from all queries, but the row remains for auditors.

Temperature readings are raw sensor data. They do not represent people. If you need to delete them, you typically purge in bulk by date range (`DELETE FROM temperature_readings WHERE recordedAt < '2025-01-01'`), not individually. Adding a `deletedAt` column to a table with tens of millions of rows wastes significant storage and forces every query to include an extra `WHERE deletedAt IS NULL` filter — an unnecessary cost on your highest-volume table.

#### Why separate `DailyStats` instead of materialized views?

PostgreSQL materialized views (`CREATE MATERIALIZED VIEW`) can serve a similar purpose, but they have practical limitations:

1. **Portability.** Not all PostgreSQL hosting providers support materialized views with all features (concurrent refresh, indexes). A regular table works identically across all providers and all databases the ORM supports.
2. **Version control.** The `DailyStats` entity is defined in code and tracked by migrations. Changes to its schema go through pull requests and code review, just like any other entity.
3. **Observability.** The `@UpdateTimestamp()` decorator gives you a built-in "last refreshed" indicator. If `updatedAt` is 3 days old, you know immediately that your aggregation cron job is broken.
4. **Granular control.** You can update a single device's stats without refreshing the entire view. Materialized view refresh is all-or-nothing.

---

## Step 3: Multi-Tenancy — One App, Many Buildings

### The analogy

Imagine an apartment building with individual mailboxes. Every resident shares the same hallway and elevator, but each mailbox is private — your key only opens your box.

Multi-tenancy works the same way. All tenants share the same NestJS server and PostgreSQL instance, but each tenant's data lives in its own **PostgreSQL schema**. Tenant "building_a" has `building_a.devices`, `building_a.temperature_readings`, etc. Tenant "building_b" has its own set of identical tables. The ORM automatically routes queries to the correct schema.

```
PostgreSQL Instance
├── public              ← shared (template tables)
├── building_a          ← Tenant A's isolated data
│   ├── users
│   ├── devices
│   ├── temperature_readings
│   └── ...
├── building_b          ← Tenant B's isolated data
│   ├── users
│   ├── devices
│   ├── temperature_readings
│   └── ...
```

### Tenant Middleware

In the existing [Multi-Tenancy](./multi-tenancy.md) guide, we extract the tenant from an HTTP header. In a real production system, the tenant identity should come from a **trusted source** — the JWT. A user cannot forge their tenant by changing a header if it's embedded in a signed token.

```typescript
// src/tenant/tenant.middleware.ts
import { Injectable, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { MetadataContext } from "@stingerloom/orm";

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    // In production: extract tenantId from the verified JWT (see Step 4).
    // During development without Keycloak: fall back to header.
    const tenantId =
      (req as any).user?.tenantId ||
      (req.headers["x-tenant-id"] as string) ||
      "public";

    MetadataContext.run(tenantId, () => {
      next();
    });
  }
}
```

The key line is `MetadataContext.run(tenantId, () => { next() })`. This wraps the **entire HTTP request lifecycle** in a tenant context using Node.js `AsyncLocalStorage`. Every ORM call downstream — in controllers, services, repositories — automatically targets the correct schema.

```
HTTP Request (JWT: { tenantId: "building_a" })
    │
    ▼
TenantMiddleware
    │  MetadataContext.run("building_a", () => next())
    ▼
Controller → Service → Repository → EntityManager
    │
    ▼
SQL: SELECT * FROM "building_a"."devices" WHERE ...
```

### How AsyncLocalStorage Guarantees Isolation

Node.js runs on a single thread, but it handles many concurrent HTTP requests through its event loop. Without careful context management, two simultaneous requests could interfere with each other's tenant identity. `AsyncLocalStorage` solves this by giving each asynchronous execution chain its own isolated storage — even when their operations interleave on the same thread.

Here is a concrete timeline showing two concurrent requests:

```
Timeline (single Node.js thread):
──────────────────────────────────────────────
t1: Request A arrives (tenant: building_a)
    -> MetadataContext.run("building_a", ...)
t2: Request B arrives (tenant: building_b)
    -> MetadataContext.run("building_b", ...)
t3: Request A's DB query executes
    -> AsyncLocalStorage resolves -> "building_a"
    -> SQL: SELECT * FROM "building_a"."devices"
t4: Request B's DB query executes
    -> AsyncLocalStorage resolves -> "building_b"
    -> SQL: SELECT * FROM "building_b"."devices"
──────────────────────────────────────────────
```

At time t3, even though Request B has already started and set its own context at t2, Request A still correctly resolves to `building_a`. Each `MetadataContext.run()` call creates an independent execution context that follows the async call chain — through `await`, Promises, and callbacks — without leaking into other concurrent contexts.

Without `AsyncLocalStorage`, a naive global variable approach (e.g., `global.currentTenant = tenantId`) would race: Request B would overwrite the tenant to `building_b` before Request A's database query executes, causing Request A to query the wrong schema. This is a classic concurrency bug that `AsyncLocalStorage` eliminates by design.

### What Happens Without Tenant Context?

If code runs outside `MetadataContext.run()` — for example, in a startup script or a module initializer — the ORM falls back to the `public` schema. This is by design: the public schema holds the template tables that `ensureSchema()` clones from.

```typescript
// Outside any MetadataContext — targets "public" schema
const users = await em.find(User, {});
// SQL: SELECT * FROM "public"."users"

// Inside tenant context — targets tenant schema
MetadataContext.run("building_a", async () => {
  const users = await em.find(User, {});
  // SQL: SELECT * FROM "building_a"."users"
});
```

::: warning
Never store tenant-specific data in the public schema. It exists only as a structural template for `ensureSchema()` to clone from. If you accidentally write data to the public schema, it will not be visible to any tenant, and it will not be cleaned up by tenant-scoped delete operations.
:::

### Tenant Schema Service

The first time a new tenant makes a request, their schema doesn't exist yet. The `TenantSchemaService` automatically creates it:

```typescript
// src/tenant/tenant-schema.service.ts
import { Injectable, Inject } from "@nestjs/common";
import {
  EntityManager,
  PostgresTenantMigrationRunner,
  PostgresDriver,
} from "@stingerloom/orm";

@Injectable()
export class TenantSchemaService {
  private runner: PostgresTenantMigrationRunner | null = null;

  constructor(
    @Inject(EntityManager)
    private readonly em: EntityManager,
  ) {}

  async ensureSchema(tenantId: string): Promise<void> {
    if (!this.runner) {
      const driver = this.em.getDriver() as PostgresDriver;
      this.runner = new PostgresTenantMigrationRunner(driver);
    }
    return this.runner.ensureSchema(tenantId);
  }
}
```

`ensureSchema()` does two things: checks if the schema exists, and if not, creates it by cloning the public schema's table structure. Think of it as printing a fresh set of empty tables for the new tenant.

### Updated Middleware with Schema Provisioning

```typescript
// src/tenant/tenant.middleware.ts (updated)
import { Injectable, Inject, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { MetadataContext } from "@stingerloom/orm";
import { TenantSchemaService } from "./tenant-schema.service";

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(private readonly tenantSchema: TenantSchemaService) {}

  use(req: Request, _res: Response, next: NextFunction) {
    const tenantId =
      (req as any).user?.tenantId ||
      (req.headers["x-tenant-id"] as string) ||
      "public";

    MetadataContext.run(tenantId, async () => {
      try {
        await this.tenantSchema.ensureSchema(tenantId);
        next();
      } catch (err) {
        next(err);
      }
    });
  }
}
```

### Register the Middleware

```typescript
// src/tenant/tenant.module.ts
import { Module, NestModule, MiddlewareConsumer } from "@nestjs/common";
import { TenantMiddleware } from "./tenant.middleware";
import { TenantSchemaService } from "./tenant-schema.service";

@Module({
  providers: [TenantSchemaService],
  exports: [TenantSchemaService],
})
export class TenantModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantMiddleware).forRoutes("*");
  }
}
```

Add `TenantModule` to your `AppModule` imports:

```typescript
// src/app.module.ts (updated imports)
@Module({
  imports: [
    TenantModule,
    StingerloomOrmModule.forRoot({ /* ... same as Step 1 ... */ }),
    // ...
  ],
})
export class AppModule {}
```

Now every request is automatically scoped to the correct tenant. Your service code stays clean — no `withTenant()` wrappers, no `tenantId` parameters everywhere.

---

## Step 4: Authentication with Keycloak JWT

::: tip ORM Boundary
This entire step has **nothing to do with the ORM**. Authentication is a transport concern — it determines *who* is making the request. The ORM only cares about *which data* to query. We include this step because the JWT carries the `tenantId` claim that feeds into our TenantMiddleware.
:::

### JWT Strategy

```typescript
// src/auth/jwt.strategy.ts
import { Injectable } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { Strategy, ExtractJwt } from "passport-jwt";
import { passportJwtSecret } from "jwks-rsa";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      // Keycloak publishes its public keys at this well-known endpoint.
      // jwks-rsa fetches and caches them automatically.
      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksUri:
          "http://localhost:8080/realms/smart-thermo/protocol/openid-connect/certs",
      }),
      issuer: "http://localhost:8080/realms/smart-thermo",
      algorithms: ["RS256"],
    });
  }

  validate(payload: any) {
    // This returned object becomes `req.user`
    return {
      sub: payload.sub,
      email: payload.email,
      tenantId: payload.tenantId, // Our custom claim from Keycloak mapper
    };
  }
}
```

### Auth Guard

```typescript
// src/auth/jwt-auth.guard.ts
import { Injectable } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";

@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {}
```

### Auth Module

```typescript
// src/auth/auth.module.ts
import { Module } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";
import { JwtStrategy } from "./jwt.strategy";

@Module({
  imports: [PassportModule.register({ defaultStrategy: "jwt" })],
  providers: [JwtStrategy],
  exports: [PassportModule],
})
export class AuthModule {}
```

Add `AuthModule` to your `AppModule` imports. Then apply the guard to protected routes:

```typescript
@Controller("devices")
@UseGuards(JwtAuthGuard) // Every route in this controller requires a valid JWT
export class DevicesController {
  // ...
}
```

Notice we haven't touched the ORM at all. The JWT guard verifies the token. The TenantMiddleware (from Step 3) reads `req.user.tenantId` and sets the ORM context. These two systems communicate through `req.user` — a standard NestJS pattern.

---

## Step 5: Ingesting Temperature Readings

Now we get to the core of the application: receiving temperature data from devices. This is where the ORM does its heaviest lifting.

### Module Setup

```typescript
// src/readings/readings.module.ts
import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { TemperatureReading } from "../entities/temperature-reading.entity";
import { AlertRule } from "../entities/alert-rule.entity";
import { Alert } from "../entities/alert.entity";
import { ReadingsService } from "./readings.service";
import { ReadingsController } from "./readings.controller";

@Module({
  imports: [
    StingerloomOrmModule.forFeature([TemperatureReading, AlertRule, Alert]),
  ],
  controllers: [ReadingsController],
  providers: [ReadingsService],
})
export class ReadingsModule {}
```

### Single Reading — save()

When a single thermometer sends one reading, we use `save()`:

```typescript
// src/readings/readings.service.ts
import { Injectable } from "@nestjs/common";
import { InjectRepository, BaseRepository } from "@stingerloom/orm/nestjs";
import { TemperatureReading } from "../entities/temperature-reading.entity";

@Injectable()
export class ReadingsService {
  constructor(
    @InjectRepository(TemperatureReading)
    private readonly readingRepo: BaseRepository<TemperatureReading>,
  ) {}

  async ingestOne(deviceId: number, data: {
    temperatureCelsius: number;
    humidity?: number;
    batteryLevel?: number;
    recordedAt: Date;
  }): Promise<TemperatureReading> {
    const reading = new TemperatureReading();
    reading.device = { id: deviceId } as any;
    reading.temperatureCelsius = data.temperatureCelsius;
    reading.humidity = data.humidity ?? null;
    reading.batteryLevel = data.batteryLevel ?? null;
    reading.recordedAt = data.recordedAt;

    return this.readingRepo.save(reading);
  }
}
```

```sql
-- The ORM generates (PostgreSQL, tenant "building_a"):
INSERT INTO "building_a"."temperature_readings"
  ("device_id", "temperatureCelsius", "humidity", "batteryLevel", "recordedAt", "createdAt")
VALUES ($1, $2, $3, $4, $5, NOW())
RETURNING *
-- Parameters: [1, 23.5, 45.2, 0.87, '2026-03-28 10:30:00']
```

Before this SQL executes, the `@BeforeInsert()` hook runs. If the temperature is below absolute zero, the hook throws an error — the INSERT never reaches the database.

### Batch Ingestion — insertMany()

A device might buffer readings and send them in bulk — say, 100 readings at once. Calling `save()` in a loop would mean 100 separate INSERT statements. `insertMany()` packs them into a single statement:

```typescript
async ingestBatch(deviceId: number, readings: Array<{
  temperatureCelsius: number;
  humidity?: number;
  batteryLevel?: number;
  recordedAt: Date;
}>): Promise<{ affected: number }> {
  return this.readingRepo.insertMany(
    readings.map((r) => ({
      device: { id: deviceId },
      temperatureCelsius: r.temperatureCelsius,
      humidity: r.humidity ?? null,
      batteryLevel: r.batteryLevel ?? null,
      recordedAt: r.recordedAt,
    })),
  );
}
```

```sql
-- One statement for 100 readings:
INSERT INTO "building_a"."temperature_readings"
  ("device_id", "temperatureCelsius", "humidity", "batteryLevel", "recordedAt", "createdAt")
VALUES ($1, $2, $3, $4, $5, NOW()),
       ($6, $7, $8, $9, $10, NOW()),
       ...
       ($496, $497, $498, $499, $500, NOW())
```

One round-trip instead of 100. On real-world benchmarks, this is 10–50x faster.

::: warning insertMany() does not fire lifecycle hooks
`@BeforeInsert()` and `@AfterInsert()` hooks only fire for `save()` and `saveMany()`. If you need validation on every batch item, either validate in application code before calling `insertMany()`, or use `saveMany()` (slower but triggers hooks).
:::

### Alert Checking with EntitySubscriber

When a new reading comes in, we want to check if it violates any alert rules for that device. We could put this logic inside `ReadingsService.ingestOne()`, but that would couple the ingestion service to the alerting system. Instead, we use an **EntitySubscriber** — a separate class that reacts to events on a specific entity.

```typescript
// src/readings/temperature-alert.subscriber.ts
import {
  EntitySubscriber,
  InsertEvent,
  EntityManager,
} from "@stingerloom/orm";
import { TemperatureReading } from "../entities/temperature-reading.entity";
import { AlertRule } from "../entities/alert-rule.entity";
import { Alert } from "../entities/alert.entity";

export class TemperatureAlertSubscriber
  implements EntitySubscriber<TemperatureReading>
{
  constructor(private readonly em: EntityManager) {}

  listenTo() {
    return TemperatureReading;
  }

  async afterInsert(event: InsertEvent<TemperatureReading>) {
    const reading = event.entity;
    if (!reading.device) return;

    // Find enabled rules for this device
    const rules = await this.em.find(AlertRule, {
      where: {
        device: { id: reading.device.id ?? (reading.device as any) },
        isEnabled: true,
      },
    });

    for (const rule of rules) {
      const violated =
        (rule.condition === "above" &&
          reading.temperatureCelsius > rule.thresholdCelsius) ||
        (rule.condition === "below" &&
          reading.temperatureCelsius < rule.thresholdCelsius);

      if (violated) {
        const alert = new Alert();
        alert.rule = rule;
        alert.reading = reading;
        alert.temperatureCelsius = reading.temperatureCelsius;
        alert.acknowledged = false;
        await this.em.save(Alert, alert);
      }
    }
  }
}
```

Register the subscriber when the module initializes:

```typescript
// src/readings/readings.module.ts (updated)
import { Module, OnModuleInit, Inject } from "@nestjs/common";
import { EntityManager } from "@stingerloom/orm";
import { TemperatureAlertSubscriber } from "./temperature-alert.subscriber";
// ... other imports

@Module({ /* same as before */ })
export class ReadingsModule implements OnModuleInit {
  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
  ) {}

  onModuleInit() {
    this.em.addSubscriber(new TemperatureAlertSubscriber(this.em));
  }
}
```

Now the flow is fully decoupled:

```
save(TemperatureReading)
    │
    ├─► @BeforeInsert: validate temperature range
    │
    ├─► SQL: INSERT INTO "temperature_readings" ...
    │
    └─► afterInsert (TemperatureAlertSubscriber):
            │
            ├─► SELECT * FROM "alert_rules" WHERE device_id = ... AND is_enabled = true
            │
            └─► IF violated → INSERT INTO "alerts" ...
```

### REST Controller

```typescript
// src/readings/readings.controller.ts
import { Controller, Post, Body, Param, ParseIntPipe, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ReadingsService } from "./readings.service";

@Controller("devices/:deviceId/readings")
@UseGuards(JwtAuthGuard)
export class ReadingsController {
  constructor(private readonly readingsService: ReadingsService) {}

  @Post()
  ingestOne(
    @Param("deviceId", ParseIntPipe) deviceId: number,
    @Body() body: { temperatureCelsius: number; humidity?: number; batteryLevel?: number; recordedAt: string },
  ) {
    return this.readingsService.ingestOne(deviceId, {
      ...body,
      recordedAt: new Date(body.recordedAt),
    });
  }

  @Post("batch")
  ingestBatch(
    @Param("deviceId", ParseIntPipe) deviceId: number,
    @Body() body: Array<{ temperatureCelsius: number; humidity?: number; batteryLevel?: number; recordedAt: string }>,
  ) {
    return this.readingsService.ingestBatch(
      deviceId,
      body.map((r) => ({ ...r, recordedAt: new Date(r.recordedAt) })),
    );
  }
}
```

---

## Step 6: Querying Data for the Mobile App

A mobile app needs several types of queries. Let's implement each one and see the SQL the ORM generates.

All the methods below live in their respective services, which inject repositories through `@InjectRepository`:

```typescript
// src/devices/devices.service.ts
import { Injectable } from "@nestjs/common";
import { InjectRepository, BaseRepository } from "@stingerloom/orm/nestjs";
import { Device } from "../entities/device.entity";
import { TemperatureReading } from "../entities/temperature-reading.entity";

@Injectable()
export class DevicesService {
  constructor(
    @InjectRepository(Device)
    private readonly deviceRepo: BaseRepository<Device>,
    @InjectRepository(TemperatureReading)
    private readonly readingRepo: BaseRepository<TemperatureReading>,
  ) {}

  // methods below...
}
```

::: tip @InjectRepository vs @Inject(EntityManager)
Use `@InjectRepository` for standard CRUD, pagination, aggregation, and upserts — it covers 90% of use cases. Reserve `@Inject(EntityManager)` for infrastructure-level operations: raw SQL (`em.query()`), streaming (`em.stream()`), subscriber registration (`em.addSubscriber()`), and driver access (`em.getDriver()`).
:::

### Latest Reading Per Device

When you open the app, the first thing you see is the current temperature for each of your devices.

```typescript
async getLatestReading(deviceId: number): Promise<TemperatureReading | null> {
  return this.readingRepo.findOne({
    where: { device: { id: deviceId } },
    orderBy: { recordedAt: "DESC" },
  });
}
```

```sql
SELECT * FROM "building_a"."temperature_readings"
WHERE "device_id" = $1
ORDER BY "recordedAt" DESC
LIMIT 1
-- Parameters: [1]
```

### Reading History — Infinite Scroll with Cursor Pagination

When the user taps a device to see its history, the app shows a scrollable list. As they scroll down, more readings load. This is **infinite scroll** — and the best pagination strategy for it is cursor-based.

Why not offset pagination? Imagine the device has 1 million readings. Requesting page 500 with `OFFSET 500000` forces PostgreSQL to scan and skip 500,000 rows. Cursor pagination says: "give me readings **older than this specific timestamp**." The database uses the index to jump directly there — equally fast whether you're on page 1 or page 10,000.

```typescript
async getReadingHistory(deviceId: number, cursor?: string) {
  return this.readingRepo.findWithCursor({
    where: { device: { id: deviceId } },
    take: 50,
    orderBy: "recordedAt",
    direction: "DESC",
    cursor,
  });
}
```

```sql
-- First page (no cursor):
SELECT * FROM "building_a"."temperature_readings"
WHERE "device_id" = $1
ORDER BY "recordedAt" DESC
LIMIT 51
-- Parameters: [1]

-- Subsequent pages (with cursor):
SELECT * FROM "building_a"."temperature_readings"
WHERE "device_id" = $1 AND "recordedAt" < $2
ORDER BY "recordedAt" DESC
LIMIT 51
-- Parameters: [1, '2026-03-28 10:00:00']
```

The ORM fetches 51 rows (50 + 1 extra) to detect whether a next page exists. If 51 rows come back, `hasNextPage` is `true` and the extra row is discarded.

The response shape is perfect for mobile clients:

```json
{
  "data": [ /* 50 TemperatureReading objects */ ],
  "hasNextPage": true,
  "nextCursor": "eyJ2IjoiMjAyNi0wMy0yOFQxMDowMDowMC4wMDBaIn0=",
  "count": 50
}
```

The client stores `nextCursor` and passes it back when the user scrolls to the bottom.

### Device List with Total Count

The "My Devices" screen shows a paginated list with a total count ("Showing 1–10 of 47 devices").

```typescript
async getDevices(page: number, pageSize: number) {
  return this.deviceRepo.findAndCount({
    where: { isActive: true },
    relations: ["user"],
    take: pageSize,
    skip: (page - 1) * pageSize,
    orderBy: { name: "ASC" },
  });
}
```

```sql
-- Two queries run in a single transaction:
SELECT * FROM "building_a"."devices"
WHERE "isActive" = $1
ORDER BY "name" ASC
LIMIT $2 OFFSET $3;

SELECT COUNT(*) AS "result" FROM "building_a"."devices"
WHERE "isActive" = $1;
-- Parameters: [true, 10, 0]
```

`findAndCount()` returns `[Device[], number]` — the data and the total count in one call.

### Date Range Filter

"Show me all readings from March 1–7 where temperature was above 30°C":

```typescript
async filterReadings(deviceId: number, from: Date, to: Date, minTemp: number) {
  return this.readingRepo.find({
    where: {
      device: { id: deviceId },
      recordedAt: { between: [from, to] },
      temperatureCelsius: { gte: minTemp },
    },
    orderBy: { recordedAt: "ASC" },
  });
}
```

```sql
SELECT * FROM "building_a"."temperature_readings"
WHERE "device_id" = $1
  AND "recordedAt" BETWEEN $2 AND $3
  AND "temperatureCelsius" >= $4
ORDER BY "recordedAt" ASC
-- Parameters: [1, '2026-03-01', '2026-03-07', 30]
```

The `between` and `gte` operators translate directly to SQL `BETWEEN` and `>=`. No string concatenation, no SQL injection risk — every value goes through parameter binding.

### Diagnosing Slow Queries with EXPLAIN

When a query runs slower than expected, `explain()` shows you the database's execution plan — which indexes it uses, how many rows it scans, and where bottlenecks are.

```typescript
async diagnoseSlowQuery(deviceId: number) {
  const plan = await this.readingRepo.explain({
    where: {
      device: { id: deviceId },
      recordedAt: { gte: new Date('2026-01-01') },
    },
    orderBy: { recordedAt: "DESC" },
  });

  console.log(plan);
  // ExplainResult:
  // {
  //   plan: "Index Scan using idx_temperature_readings_recordedAt on temperature_readings",
  //   cost: { startup: 0.43, total: 12.56 },
  //   rows: 2880,
  //   width: 64,
  //   rawPlan: [ ... ]
  // }
}
```

The key thing to look for: **"Seq Scan"** means a full table scan — the database is reading every row in the table to find matches. On a table with millions of rows, this is slow. **"Index Scan"** or **"Index Only Scan"** means the database is efficiently using a B-tree index to jump directly to the relevant rows.

If you see a Seq Scan where you expected an Index Scan, check:
1. Does the column have an `@Index()` decorator?
2. Did you run `synchronize` or a migration to actually create the index?
3. Is the table small enough that PostgreSQL decided a sequential scan is faster? (The query planner is smart — on tables with fewer than ~1,000 rows, a sequential scan can be faster than an index lookup.)

### Detecting N+1 Queries with QueryTracker

N+1 is the most common ORM performance problem. It happens when you load a list of entities, then loop through them and trigger a separate query for each related entity.

```typescript
// BAD: N+1 — one query for devices, then one query per device for readings
const devices = await this.deviceRepo.find({ where: { isActive: true } });
for (const device of devices) {
  // This triggers a separate SELECT for each device!
  const latest = await this.readingRepo.findOne({
    where: { device: { id: device.id } },
    orderBy: { recordedAt: "DESC" },
  });
}
// With 100 devices -> 101 queries (1 for devices + 100 for readings)
```

Stingerloom ORM's `QueryTracker` detects this pattern automatically:

```typescript
// Enable query tracking (usually in development or staging)
em.enableQueryTracker({ warnThreshold: 5, slowQueryMs: 500 });
```

When the tracker detects more than 5 similar queries in a short window, it logs a warning:

```
[QueryTracker] N+1 detected: 100 queries to "temperature_readings" in 1.2s
```

**The fix**: use `relations` to eager-load, or restructure as a single query:

```typescript
// GOOD: single query with join
const devices = await this.deviceRepo.find({
  where: { isActive: true },
  relations: ["readings"],
});
```

With `relations: ["readings"]`, the ORM generates a single `LEFT JOIN` query that fetches all devices and their readings in one round-trip. For 100 devices, this is 1 query instead of 101.

---

## Step 7: Aggregation — Daily Statistics

### The problem with real-time aggregation

Imagine the mobile app has a dashboard that shows "Average temperature this week" and "Highest reading in the last 24 hours." You could compute these from raw readings every time:

```typescript
const [avg, max] = await Promise.all([
  this.readingRepo.avg("temperatureCelsius", {
    device: { id: deviceId },
    recordedAt: { gte: sevenDaysAgo },
  }),
  this.readingRepo.max("temperatureCelsius", {
    device: { id: deviceId },
    recordedAt: { gte: oneDayAgo },
  }),
]);
```

```sql
SELECT AVG("temperatureCelsius") AS "result"
FROM "building_a"."temperature_readings"
WHERE "device_id" = $1 AND "recordedAt" >= $2;

SELECT MAX("temperatureCelsius") AS "result"
FROM "building_a"."temperature_readings"
WHERE "device_id" = $1 AND "recordedAt" >= $2;
```

This works fine with 10,000 readings. But with 10 million? Each query scans a massive range. And if 100 users open their dashboards at the same time, your database is running 200 aggregate scans concurrently.

### Pre-aggregation: the monthly bank statement approach

Instead of scanning raw data on every request, we pre-compute daily summaries. Like a bank that generates monthly statements from individual transactions, we generate a `DailyStats` row for each device for each day.

```typescript
// src/stats/stats.service.ts
import { Injectable, Inject } from "@nestjs/common";
import { InjectRepository, BaseRepository } from "@stingerloom/orm/nestjs";
import { EntityManager } from "@stingerloom/orm";
import { DailyStats } from "../entities/daily-stats.entity";
import { TemperatureReading } from "../entities/temperature-reading.entity";
import sql from "sql-template-tag";

@Injectable()
export class StatsService {
  constructor(
    @InjectRepository(TemperatureReading)
    private readonly readingRepo: BaseRepository<TemperatureReading>,
    @InjectRepository(DailyStats)
    private readonly statsRepo: BaseRepository<DailyStats>,
    @Inject(EntityManager) private readonly em: EntityManager, // for raw SQL only
  ) {}

  async aggregateDay(deviceId: number, date: string): Promise<void> {
    // Use repository aggregates to compute the summary
    const where = {
      device: { id: deviceId },
      recordedAt: {
        between: [new Date(`${date}T00:00:00`), new Date(`${date}T23:59:59`)],
      },
    };

    const [avg, min, max, count] = await Promise.all([
      this.readingRepo.avg("temperatureCelsius", where),
      this.readingRepo.min("temperatureCelsius", where),
      this.readingRepo.max("temperatureCelsius", where),
      this.readingRepo.count(where),
    ]);

    if (count === 0) return; // No readings for this day

    // Upsert: create if new, update if already aggregated
    await this.statsRepo.upsert({
      device: { id: deviceId },
      date,
      avgTemperature: avg,
      minTemperature: min,
      maxTemperature: max,
      readingCount: count,
    });
  }
}
```

```sql
-- Four aggregate queries run concurrently:
SELECT AVG("temperatureCelsius") AS "result" FROM "building_a"."temperature_readings"
  WHERE "device_id" = $1 AND "recordedAt" BETWEEN $2 AND $3;
SELECT MIN("temperatureCelsius") AS "result" FROM "building_a"."temperature_readings"
  WHERE "device_id" = $1 AND "recordedAt" BETWEEN $2 AND $3;
SELECT MAX("temperatureCelsius") AS "result" FROM "building_a"."temperature_readings"
  WHERE "device_id" = $1 AND "recordedAt" BETWEEN $2 AND $3;
SELECT COUNT(*) AS "result" FROM "building_a"."temperature_readings"
  WHERE "device_id" = $1 AND "recordedAt" BETWEEN $2 AND $3;

-- Then an atomic upsert:
INSERT INTO "building_a"."daily_stats"
  ("device_id", "date", "avgTemperature", "minTemperature", "maxTemperature", "readingCount")
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT ("id") DO UPDATE SET
  "avgTemperature" = EXCLUDED."avgTemperature",
  "minTemperature" = EXCLUDED."minTemperature",
  "maxTemperature" = EXCLUDED."maxTemperature",
  "readingCount" = EXCLUDED."readingCount"
```

The `upsert()` is key — if the cron job runs twice for the same day, it overwrites instead of creating duplicates. Idempotent by design.

### Raw SQL for Complex Aggregation

Sometimes the ORM's built-in aggregates aren't enough. For example, "give me hourly average temperatures for the last 24 hours" requires `GROUP BY` with `date_trunc()` — something not expressible through the ORM's finder API.

This is where `em.query()` shines:

```typescript
async getHourlyBreakdown(deviceId: number): Promise<Array<{
  hour: string;
  avgTemp: number;
  readingCount: number;
}>> {
  return this.em.query<{ hour: string; avgTemp: number; readingCount: number }>(
    sql`
      SELECT
        date_trunc('hour', "recordedAt") AS "hour",
        AVG("temperatureCelsius")::float AS "avgTemp",
        COUNT(*)::int AS "readingCount"
      FROM "temperature_readings"
      WHERE "device_id" = ${deviceId}
        AND "recordedAt" >= NOW() - INTERVAL '24 hours'
      GROUP BY date_trunc('hour', "recordedAt")
      ORDER BY "hour" ASC
    `,
  );
}
```

::: tip When to use ORM aggregates vs. raw SQL

| Need | Use | Why |
|------|-----|-----|
| Single aggregate (count, avg, max) | `repo.count()`, `repo.avg()`, `repo.max()` | Simpler, type-safe, dialect-portable |
| GROUP BY, window functions, CTEs | `em.query()` with `sql-template-tag` | ORM finders don't support GROUP BY with expressions |
| Application-side aggregation | `em.stream()` + loop | When DB can't express the logic (ML scoring, custom algorithms) |

In all three cases, the ORM handles connection management, parameter binding, and tenant context. The difference is just how much SQL you write yourself.
:::

### Dashboard Endpoint

Now the mobile app can query pre-computed stats instead of raw readings:

```typescript
async getWeeklySummary(deviceId: number) {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const dateStr = sevenDaysAgo.toISOString().split("T")[0];

  return this.statsRepo.find({
    where: {
      device: { id: deviceId },
      date: { gte: dateStr },
    },
    orderBy: { date: "ASC" },
  });
}
```

```sql
SELECT * FROM "building_a"."daily_stats"
WHERE "device_id" = $1 AND "date" >= $2
ORDER BY "date" ASC
-- Parameters: [1, '2026-03-21']
```

This query scans at most 7 rows. No matter how many raw readings exist.

---

## Step 8: Streaming for Batch Processing

### The problem

Every night at 2 AM, you need to aggregate yesterday's readings for every device. Some tenants have 10,000 devices. Each device has ~2,880 readings per day (one every 30 seconds). That's 28.8 million rows to process.

Loading 28.8 million rows into memory would crash your Node.js process. `em.stream()` solves this by fetching rows in small batches:

```typescript
// src/stats/aggregation.processor.ts
import { Inject, Injectable } from "@nestjs/common";
import { InjectRepository, BaseRepository } from "@stingerloom/orm/nestjs";
import { EntityManager } from "@stingerloom/orm";
import { Device } from "../entities/device.entity";
import { StatsService } from "./stats.service";

@Injectable()
export class AggregationProcessor {
  constructor(
    @InjectRepository(Device)
    private readonly deviceRepo: BaseRepository<Device>,
    @Inject(EntityManager) private readonly em: EntityManager, // stream() requires EntityManager
    private readonly statsService: StatsService,
  ) {}

  async aggregateYesterday(): Promise<void> {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().split("T")[0];

    const totalDevices = await this.deviceRepo.count({ isActive: true });
    console.log(`Aggregating ${dateStr} for ${totalDevices} devices...`);

    let processed = 0;

    // stream() is an EntityManager-level operation — it handles
    // memory-efficient batched iteration over millions of rows.
    for await (const device of this.em.stream(
      Device,
      { where: { isActive: true } },
      500, // process 500 devices per batch
    )) {
      await this.statsService.aggregateDay(device.id, dateStr);

      processed++;
      if (processed % 100 === 0) {
        console.log(`Progress: ${processed}/${totalDevices}`);
      }
    }

    console.log(`Done. Aggregated ${processed} devices.`);
  }
}
```

```sql
-- The ORM fetches devices in batches of 500:
-- Batch 1:
SELECT * FROM "building_a"."devices" WHERE "isActive" = $1 LIMIT 500 OFFSET 0
-- Batch 2:
SELECT * FROM "building_a"."devices" WHERE "isActive" = $1 LIMIT 500 OFFSET 500
-- Batch 3:
SELECT * FROM "building_a"."devices" WHERE "isActive" = $1 LIMIT 500 OFFSET 1000
-- ...continues until a batch returns fewer than 500 rows
```

At any point, only 500 device objects exist in memory. Each one is processed, then garbage collected when the next batch arrives.

### Triggering with BullMQ

::: tip ORM Boundary
BullMQ is a job queue library — it has nothing to do with the ORM. We use it to **trigger** the aggregation at 2 AM. The actual data processing is done by `em.stream()` and `em.avg()`/`em.min()`/`em.max()`.
:::

```typescript
// src/stats/aggregation.queue.ts
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { MetadataContext } from "@stingerloom/orm";
import { AggregationProcessor } from "./aggregation.processor";

@Processor("aggregation")
export class AggregationWorker extends WorkerHost {
  constructor(private readonly processor: AggregationProcessor) {
    super();
  }

  async process(job: Job<{ tenantId: string }>): Promise<void> {
    const { tenantId } = job.data;

    // BullMQ runs outside the HTTP request lifecycle,
    // so there's no TenantMiddleware. We set the context manually.
    await MetadataContext.run(tenantId, async () => {
      await this.processor.aggregateYesterday();
    });
  }
}
```

```typescript
// src/stats/stats.module.ts (registration)
import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { StatsService } from "./stats.service";
import { AggregationProcessor } from "./aggregation.processor";
import { AggregationWorker } from "./aggregation.queue";

@Module({
  imports: [
    BullModule.registerQueue({ name: "aggregation" }),
  ],
  providers: [StatsService, AggregationProcessor, AggregationWorker],
  exports: [StatsService],
})
export class StatsModule {}
```

Notice the `MetadataContext.run(tenantId, ...)` call inside the worker. This is important: BullMQ jobs run outside the HTTP request lifecycle, so there's no TenantMiddleware to set the context. You must do it explicitly. The ORM's AsyncLocalStorage context works the same way regardless of whether it's triggered by an HTTP request or a background job.

---

## Step 9: Caching with Redis

::: warning ORM Boundary
Redis caching is **NOT** an ORM concern. The ORM's responsibility ends at PostgreSQL. We use the ORM's EntitySubscriber pattern to **bridge** the two systems — invalidating the cache when the underlying data changes.
:::

### The pattern: Redis first, ORM fallback

```
Mobile App requests GET /devices/1/stats/weekly
    │
    ├─► Check Redis: GET "stats:building_a:device:1:weekly"
    │     │
    │     ├─► Cache HIT → return immediately (no database query)
    │     │
    │     └─► Cache MISS ↓
    │
    ├─► Query ORM: em.find(DailyStats, { ... })
    │
    ├─► Store in Redis: SET "stats:building_a:device:1:weekly" (TTL: 1 hour)
    │
    └─► Return to client
```

```typescript
// src/stats/cached-stats.service.ts
import { Injectable } from "@nestjs/common";
import { InjectRedis } from "@nestjs-modules/ioredis";
import { InjectRepository, BaseRepository } from "@stingerloom/orm/nestjs";
import { MetadataContext } from "@stingerloom/orm";
import { DailyStats } from "../entities/daily-stats.entity";
import Redis from "ioredis";

@Injectable()
export class CachedStatsService {
  constructor(
    @InjectRepository(DailyStats)
    private readonly statsRepo: BaseRepository<DailyStats>,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async getWeeklySummary(deviceId: number): Promise<DailyStats[]> {
    const tenant = MetadataContext.getCurrentTenant();
    const cacheKey = `stats:${tenant}:device:${deviceId}:weekly`;

    // 1. Check cache
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    // 2. Cache miss — query the ORM via repository
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const stats = await this.statsRepo.find({
      where: {
        device: { id: deviceId },
        date: { gte: sevenDaysAgo.toISOString().split("T")[0] },
      },
      orderBy: { date: "ASC" },
    });

    // 3. Store in cache (TTL: 1 hour)
    await this.redis.set(cacheKey, JSON.stringify(stats), "EX", 3600);

    return stats;
  }
}
```

Notice: no `new Redis()` anywhere. The `@InjectRedis()` decorator pulls the connection from the `RedisModule` we registered in Step 1. This means all Redis connections are managed by NestJS's lifecycle — proper cleanup on shutdown, shared configuration, and testability through DI.

### Cache Invalidation with EntitySubscriber

When new daily stats are computed (by the nightly aggregation cron), the cached data is stale. We use an `EntitySubscriber` to automatically invalidate the relevant cache keys:

```typescript
// src/stats/daily-stats-cache.subscriber.ts
import { EntitySubscriber, InsertEvent, UpdateEvent, MetadataContext } from "@stingerloom/orm";
import { DailyStats } from "../entities/daily-stats.entity";
import Redis from "ioredis";

export class DailyStatsCacheSubscriber implements EntitySubscriber<DailyStats> {
  constructor(private readonly redis: Redis) {}

  listenTo() {
    return DailyStats;
  }

  async afterInsert(event: InsertEvent<DailyStats>) {
    await this.invalidate(event.entity);
  }

  async afterUpdate(event: UpdateEvent<DailyStats>) {
    await this.invalidate(event.entity);
  }

  private async invalidate(stats: DailyStats) {
    const tenant = MetadataContext.getCurrentTenant();
    const deviceId = (stats.device as any)?.id ?? (stats as any).device_id;
    if (deviceId) {
      await this.redis.del(`stats:${tenant}:device:${deviceId}:weekly`);
    }
  }
}
```

The subscriber receives the Redis instance through its constructor. We pass the DI-managed Redis when registering the subscriber:

```typescript
// src/stats/stats.module.ts (subscriber registration)
@Module({ /* ... */ })
export class StatsModule implements OnModuleInit {
  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  onModuleInit() {
    this.em.addSubscriber(new DailyStatsCacheSubscriber(this.redis));
  }
}
```

The beauty of this pattern: the aggregation service (`StatsService`) doesn't know about Redis. The cache service doesn't know about aggregation schedules. The subscriber bridges them — when the ORM writes a `DailyStats` row, the subscriber reacts by deleting the stale cache. The systems are fully decoupled.

---

## Step 10: Alert Processing with Transactions

### The scenario

When a temperature reading violates an alert rule, we need to:
1. Create an `Alert` record
2. (Optionally) mark the reading as "alerted" to avoid duplicate alerts

These two operations must succeed or fail together. If the alert is created but the reading update fails, we get phantom alerts. If the reading is updated but the alert creation fails, we silently lose alerts. This is exactly what transactions are for.

### Using @Transactional()

```typescript
// src/alerts/alerts.service.ts
import { Injectable } from "@nestjs/common";
import { InjectRepository, BaseRepository } from "@stingerloom/orm/nestjs";
import { Transactional } from "@stingerloom/orm";
import { Alert } from "../entities/alert.entity";
import { AlertRule } from "../entities/alert-rule.entity";
import { TemperatureReading } from "../entities/temperature-reading.entity";

@Injectable()
export class AlertsService {
  constructor(
    @InjectRepository(Alert)
    private readonly alertRepo: BaseRepository<Alert>,
  ) {}

  @Transactional()
  async fireAlert(
    rule: AlertRule,
    reading: TemperatureReading,
  ): Promise<Alert> {
    // Both operations share the same transaction.
    // If either fails, both are rolled back.

    const alert = new Alert();
    alert.rule = rule;
    alert.reading = reading;
    alert.temperatureCelsius = reading.temperatureCelsius;
    alert.acknowledged = false;

    return this.alertRepo.save(alert);
  }
}
```

```sql
-- The ORM wraps both operations in a single transaction:
BEGIN;

INSERT INTO "building_a"."alerts"
  ("alert_rule_id", "reading_id", "temperatureCelsius", "acknowledged", "firedAt")
VALUES ($1, $2, $3, $4, NOW())
RETURNING *;

COMMIT;
-- If any step throws → ROLLBACK instead of COMMIT
```

### Alternative: em.transaction() Callback

If you prefer explicit control over the transaction boundary:

```typescript
async fireAlertExplicit(rule: AlertRule, reading: TemperatureReading): Promise<Alert> {
  return this.em.transaction(async (txEm) => {
    const alert = new Alert();
    alert.rule = rule;
    alert.reading = reading;
    alert.temperatureCelsius = reading.temperatureCelsius;
    alert.acknowledged = false;

    return txEm.save(Alert, alert);
    // COMMIT on successful return
    // ROLLBACK on throw
  });
}
```

Both approaches produce identical SQL. `@Transactional()` is cleaner for simple cases. `em.transaction()` gives you explicit control when you need to conditionally include operations.

### Querying Alerts for the Mobile App

```typescript
async getUnacknowledgedAlerts(deviceId: number) {
  return this.alertRepo.find({
    where: {
      rule: { device: { id: deviceId } },
      acknowledged: false,
    },
    relations: ["rule"],
    orderBy: { firedAt: "DESC" },
    take: 50,
  });
}
```

```sql
SELECT "alert".*, "rule".*
FROM "building_a"."alerts" "alert"
LEFT JOIN "building_a"."alert_rules" "rule" ON "alert"."alert_rule_id" = "rule"."id"
WHERE "rule"."device_id" = $1 AND "alert"."acknowledged" = $2
ORDER BY "alert"."firedAt" DESC
LIMIT 50
-- Parameters: [1, false]
```

---

## Step 11: Testing

### Unit Testing Services

Since repositories are injected via `@InjectRepository`, you can mock them in tests. This lets you test your business logic in isolation — without a running database, without Docker, and in milliseconds.

```typescript
// src/readings/readings.service.spec.ts
import { Test, TestingModule } from "@nestjs/testing";
import { ReadingsService } from "./readings.service";
import { getRepositoryToken } from "@stingerloom/orm/nestjs";
import { TemperatureReading } from "../entities/temperature-reading.entity";

describe("ReadingsService", () => {
  let service: ReadingsService;
  const mockRepo = {
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    insertMany: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReadingsService,
        {
          provide: getRepositoryToken(TemperatureReading),
          useValue: mockRepo,
        },
      ],
    }).compile();

    service = module.get(ReadingsService);
  });

  it("should save a single reading", async () => {
    const mockReading = { id: 1, temperatureCelsius: 23.5 };
    mockRepo.save.mockResolvedValue(mockReading);

    const result = await service.ingestOne(1, {
      temperatureCelsius: 23.5,
      recordedAt: new Date(),
    });

    expect(result).toEqual(mockReading);
    expect(mockRepo.save).toHaveBeenCalledTimes(1);
  });

  it("should reject temperatures below absolute zero", async () => {
    // The @BeforeInsert hook runs inside the ORM, so for unit tests
    // we test the entity method directly
    const reading = new TemperatureReading();
    reading.temperatureCelsius = -300;

    expect(() => reading.validateTemperature()).toThrow(
      "Temperature cannot be below absolute zero"
    );
  });
});
```

### Integration Testing with Real Database

For tests that need actual database behavior (transactions, constraints, tenant isolation), use the ORM's test utilities:

```typescript
// test/integration/multi-tenant.spec.ts
import { EntityManager, MetadataContext } from "@stingerloom/orm";
import { Device } from "../../src/entities/device.entity";

describe("Multi-Tenant Isolation", () => {
  let em: EntityManager;

  beforeAll(async () => {
    // Connect to a test database
    em = new EntityManager({
      type: "postgres",
      host: "localhost",
      port: 5432,
      database: "smart_thermo_test",
      username: "postgres",
      password: "postgres",
    });
  });

  afterAll(async () => {
    await em.propagateShutdown();
  });

  it("tenant A cannot see tenant B data", async () => {
    // Insert device in tenant A
    await MetadataContext.run("tenant_a", async () => {
      await em.save(Device, {
        serialNumber: "SENSOR-A-001",
        name: "Lobby Sensor",
        isActive: true,
      });
    });

    // Query from tenant B — should see nothing
    await MetadataContext.run("tenant_b", async () => {
      const devices = await em.find(Device, {});
      expect(devices).toHaveLength(0);
    });

    // Query from tenant A — should see the device
    await MetadataContext.run("tenant_a", async () => {
      const devices = await em.find(Device, {});
      expect(devices).toHaveLength(1);
      expect(devices[0].serialNumber).toBe("SENSOR-A-001");
    });
  });
});
```

::: tip
Always use a separate test database. The `synchronize: true` option creates tables automatically, but it also drops and recreates them — never point tests at your production database.
:::

---

## What We Built

Let's step back and look at the complete system:

| Component | What it does | ORM involved? |
|-----------|-------------|---------------|
| Docker Compose | PostgreSQL + Redis + Keycloak infrastructure | No |
| 6 Entities | Data model with relations, indexes, hooks | **Yes** — decorators |
| Tenant Middleware | Schema-per-tenant routing via JWT claims | **Yes** — MetadataContext |
| Keycloak JWT Auth | Token verification, user identity | No |
| Single + Batch Ingestion | save() and insertMany() for temperature data | **Yes** — EntityManager |
| Alert Subscriber | Decoupled alert checking on new readings | **Yes** — EntitySubscriber |
| Cursor Pagination | Infinite scroll for mobile reading history | **Yes** — findWithCursor() |
| Aggregation | Daily stats via avg/min/max/count + upsert | **Yes** — aggregate functions |
| Streaming | Process millions of rows without memory overflow | **Yes** — stream() |
| Redis Caching | Fast dashboard data with cache invalidation | Bridge via EntitySubscriber |
| Transactions | Atomic alert creation | **Yes** — @Transactional() |
| BullMQ Cron | Nightly aggregation trigger | No (triggers ORM code) |

The ORM handles everything between your TypeScript objects and PostgreSQL. Redis, BullMQ, and Keycloak are external systems that the ORM bridges through well-defined boundaries (EntitySubscriber for cache invalidation, MetadataContext.run() for background jobs).

### Production Checklist

Before deploying to production, verify these critical points:

| Item | Status | Notes |
|------|--------|-------|
| `synchronize: false` in production config | Required | Use migrations instead — synchronize can drop columns |
| Connection pooling configured | Required | Set `pool: { min: 2, max: 10 }` in ORM config |
| Query timeout set | Recommended | `timeout: 30000` (30s) prevents runaway queries |
| N+1 detection enabled in staging | Recommended | `em.enableQueryTracker({ warnThreshold: 5 })` |
| Redis connection error handling | Required | ioredis auto-reconnects, but log failures |
| Tenant schema migration strategy | Required | Run `TenantMigrationRunner.syncTenantSchemas()` on deploy |
| JWT public key rotation | Important | jwks-rsa caches keys — set `cache: true, rateLimit: true` |
| Database backup schedule | Required | pg_dump with `--schema` flag for per-tenant backups |
| Graceful shutdown | Required | Call `em.propagateShutdown()` in NestJS `onModuleDestroy()` |

### Graceful Shutdown

```typescript
// src/app.module.ts
import { Module, OnModuleDestroy, Inject } from "@nestjs/common";
import { EntityManager } from "@stingerloom/orm";

@Module({ /* ... */ })
export class AppModule implements OnModuleDestroy {
  constructor(@Inject(EntityManager) private readonly em: EntityManager) {}

  async onModuleDestroy() {
    await this.em.propagateShutdown();
    console.log("ORM connections closed gracefully.");
  }
}
```

`propagateShutdown()` closes all database connections, clears event listeners and subscribers, and releases query tracker resources. Without this, your process may hang on shutdown with dangling PostgreSQL connections. In containerized environments (Docker, Kubernetes), a dangling connection prevents the container from stopping cleanly, which can lead to forced kills and data loss during in-flight transactions.

## Next Steps

- [Entities & Columns](./entities.md) — Deep dive into all decorator options
- [Multi-Tenancy](./multi-tenancy.md) — Schema strategies, OverlayFS metadata, concurrency safety
- [Querying & Pagination](./entity-manager-querying.md) — All WHERE operators, streaming, aggregates
- [Writes & Transactions](./entity-manager-writes.md) — Batch operations, upsert, deadlock retry
- [Events & Subscribers](./events.md) — Lifecycle hooks, global listeners, subscriber patterns
- [Transactions](./transactions.md) — Isolation levels, savepoints, nested transactions
- [NestJS Integration](./nestjs.md) — Module setup, dependency injection, repository pattern
