# Using with Express

Stingerloom ORM is framework-agnostic. The `EntityManager` you use in the NestJS integration is the same class you use anywhere else — the NestJS module is only a thin dependency-injection wrapper around it. This guide shows the patterns that replace each piece of that wrapper in a plain [Express](https://expressjs.com/) application. The same patterns apply to Fastify, Koa, Hono, or any other Node.js server.

Both module systems are supported: a CommonJS project (`require`) and an ESM project (`"type": "module"` with `import`) work with the same code.

## Setup

```bash
npm install @stingerloom/orm reflect-metadata express
npm install better-sqlite3   # or pg / mysql2
```

## Choose an entity style that matches your build tool

This is the most common stumbling block outside NestJS, so it comes first.

The decorator style (`@Entity`, `@Column`) infers column types from TypeScript's `design:type` metadata, which only exists when the code is compiled with `emitDecoratorMetadata` — that is, by `tsc` or `ts-node`. The tools most Express projects use for development — **tsx, esbuild, swc, and Vite — do not emit decorator metadata**. Under those tools an un-typed `@Column()` cannot see the property type and falls back to `"text"`, with a warning like:

```
WARN [Column] No design:type metadata for User.name — falling back to "text". ...
```

You have three reliable options:

1. **Use the code-first builder (recommended).** `defineEntity` carries its column types itself and needs no decorator metadata, no `experimentalDecorators`, and no specific compiler:

   ```typescript
   import { defineEntity, t, InferEntity } from "@stingerloom/orm";

   export const User = defineEntity("users", {
     id:      t.int().primary().generated(),
     name:    t.varchar(255),
     balance: t.int().default(0),
   });
   export type User = InferEntity<typeof User>;
   ```

2. **Keep decorators, but give every column an explicit type.** `@Column({ type: "int" })` needs no inference, so it behaves identically under every build tool.

3. **Keep decorators and compile with `tsc` / run with `ts-node`**, which emit the metadata the inference needs.

See [Defining Entities](./define-entity.md) and [Troubleshooting](./troubleshooting.md) for details.

## Bootstrap

Create one `EntityManager` for the whole process, register it **before** the server starts accepting traffic, and share it across modules:

```typescript
// db.ts
import "reflect-metadata"; // first import of the process
import { EntityManager } from "@stingerloom/orm";

export const em = new EntityManager();

export async function initDb(): Promise<void> {
  await em.register({
    type: "sqlite",
    database: "app.db",
    entities: [User],
    synchronize: true, // development only — use migrations in production
  });
}
```

```typescript
// main.ts
import express from "express";
import { em, initDb } from "./db";
import { User } from "./user.entity";

async function main() {
  await initDb(); // requests arriving before this would fail with DatabaseNotConnectedError

  const app = express();
  app.use(express.json());

  app.post("/users", async (req, res) => {
    res.json(await em.save(User, req.body));
  });

  app.get("/users/:id", async (req, res) => {
    const user = await em.findOne(User, { where: { id: Number(req.params.id) } });
    if (!user) return res.status(404).json({ error: "not found" });
    res.json(user);
  });

  app.listen(3000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

::: warning One EntityManager per database
`register()` without a connection name registers the `"default"` connection on a process-wide registry. If a second `EntityManager` registers under the same name, it replaces that connection — the first manager would silently start querying the second database. The ORM logs a warning when this happens:

```
WARN [DatabaseClient] Connection 'default' is already registered and will be replaced. ...
```

Share one `EntityManager` instance across your modules. If you genuinely need several databases in one process, give each one a distinct name: `em2.register(options, "analytics")`.
:::

## Repositories

`@InjectRepository(User)` is NestJS DI sugar. The direct equivalent:

```typescript
const userRepository = em.getRepository(User);

const users = await userRepository.find({ where: { name: "alice" } });
```

Repositories are cheap views over the `EntityManager` — fetch them where needed or export them from `db.ts` alongside `em`.

## Transactions

`@Transactional()` does not depend on NestJS. It tracks the active transaction with `AsyncLocalStorage`, so it works on any class whose methods you call — including plain service classes in an Express app:

```typescript
import { Transactional } from "@stingerloom/orm";

class TransferService {
  @Transactional()
  async transfer(fromId: number, toId: number, amount: number) {
    // every em call in here joins the same transaction;
    // a thrown error rolls the whole thing back
  }
}
```

If you prefer no decorators at all, `em.transaction()` gives the same guarantees as a function:

```typescript
await em.transaction(async (txEm) => {
  // every txEm call here shares one transaction
});
```

## Error handling

The ORM throws typed errors (`OrmError` subclasses). Express 5 forwards rejected async handlers to the error middleware automatically; on Express 4 you need an async wrapper such as `express-async-errors`. A minimal mapping middleware:

```typescript
import { OrmError, OrmErrorCode, EntityNotFoundError } from "@stingerloom/orm";
import { NextFunction, Request, Response } from "express";

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof EntityNotFoundError) {
    return res.status(404).json({ error: err.message });
  }
  if (err instanceof OrmError) {
    // err.code is an OrmErrorCode; err.suggestion often says how to fix it
    return res.status(500).json({ error: err.message, code: err.code });
  }
  return res.status(500).json({ error: "internal error" });
});
```

Without such a middleware, Express's default handler returns an HTML page that includes the stack trace — fine in development, not something to ship.

## Graceful shutdown

NestJS calls the ORM's shutdown hook via `app.enableShutdownHooks()`. In Express, wire the signal handlers yourself and call `propagateShutdown()` — it runs plugin shutdown hooks and closes every connection:

```typescript
const server = app.listen(3000);

async function shutdown() {
  server.close();
  await em.propagateShutdown({ closeConnections: true });
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
```

## Multi-tenancy middleware

The [multi-tenancy](./multi-tenancy.md) context is plain `AsyncLocalStorage`, so the Express version of the tenant middleware is just:

```typescript
import { MetadataContext } from "@stingerloom/orm";

app.use((req, _res, next) => {
  const tenantId = (req.headers["x-tenant-id"] as string) ?? "public";
  MetadataContext.run(tenantId, () => {
    next();
  });
});
```

Every handler and every ORM call in the request then runs in that tenant's context, and concurrent requests for different tenants stay isolated.

## Notes on dev tooling

- **tsx / nodemon restarts** are safe: metadata and connections are rebuilt on every process start.
- **better-sqlite3 is a native module.** If `new Database()` crashes the process right after an upgrade, the installed prebuilt binary does not match your Node.js version — reinstall it (`npm rebuild better-sqlite3`) or pin a major version known to support your Node release.
- The migration CLI (`npx stingerloom`) and the Prisma importer run as CommonJS tools; they work regardless of your app's module system.
