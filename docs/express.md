# Using with Express

Stingerloom ORM is framework-agnostic. The `EntityManager` you use in the NestJS integration is the same class you use anywhere else — the NestJS module is only a thin dependency-injection wrapper around it. This guide shows the patterns that replace each piece of that wrapper in a plain [Express](https://expressjs.com/) application. The same patterns apply to Fastify, Koa, Hono, or any other Node.js server.

Both module systems are supported: a CommonJS project (`require`) and an ESM project (`"type": "module"` with `import`) work with the same code.

The guide is ordered so you can stop when you have enough:

- **[Getting running](#setup)** — install, entity style, bootstrap, CRUD routes, repositories.
- **[Making it correct](#error-handling)** — error handling, shutdown, health checks.
- **[Querying](#reading-data)** — filters, pagination, the query builder, raw SQL, streaming.
- **[Writes and transactions](#transactions)** — transactions, locking, batch writes, soft delete.
- **[Production concerns](#connection-pooling)** — pooling, logging, replicas, multiple databases, migrations.
- **[Advanced patterns](#multi-tenancy-middleware)** — multi-tenancy, subscribers, the write buffer, plugins, testing.

## Setup

```bash
npm install @stingerloom/orm reflect-metadata express
npm install better-sqlite3   # or pg / mysql2
```

TypeScript configuration (`experimentalDecorators`, `emitDecoratorMetadata`, `strict`) is covered in [Getting Started](./getting-started.md#step-2-typescript-configuration). Whether you need those two decorator flags at all depends on the next section.

## Choose an entity style that matches your build tool

This is the most common stumbling block outside NestJS, so it comes first.

The decorator style (`@Entity`, `@Column`) infers column types from TypeScript's `design:type` metadata, which only exists when the code is compiled with `emitDecoratorMetadata` — that is, by `tsc` or `ts-node`. The tools most Express projects use for development — **tsx, esbuild, swc, and Vite — do not emit decorator metadata**. Under those tools an un-typed `@Column()` cannot see the property type and falls back to `"text"`, with a warning like:

```
WARN [Column] No design:type metadata for User.name — falling back to "text". ...
```

You have three reliable options:

1. **Use the code-first builder (recommended).** `defineEntity` carries its column types itself and needs no decorator metadata, no `experimentalDecorators`, and no specific compiler:

   ```typescript
   // entities/user.ts
   import { defineEntity, t, InferEntity } from "@stingerloom/orm";

   export const User = defineEntity("users", {
     id:      t.int().primary().generated(),
     email:   t.varchar(255).unique(),
     name:    t.varchar(255),
     balance: t.int().default(0),
   });
   export type User = InferEntity<typeof User>;
   ```

2. **Keep decorators, but give every column an explicit type.** `@Column({ type: "int" })` needs no inference, so it behaves identically under every build tool.

3. **Keep decorators and compile with `tsc` / run with `ts-node`**, which emit the metadata the inference needs.

See [Defining Entities](./define-entity.md) and [Troubleshooting](./troubleshooting.md#columns-silently-become-text-no-design-type-metadata-warnings) for details. The rest of this guide uses the code-first style, but every pattern works identically with decorator entities.

---

## Bootstrap

Create one `EntityManager` for the whole process, register it **before** the server starts accepting traffic, and share it across modules:

```typescript
// db.ts
import "reflect-metadata"; // first import of the process
import { EntityManager } from "@stingerloom/orm";
import { User } from "./entities/user";
import { Post } from "./entities/post";

export const em = new EntityManager();

export async function initDb(): Promise<void> {
  await em.register({
    type: "sqlite",
    database: "app.db",
    entities: [User, Post],
    synchronize: true, // development only — use migrations in production
  });
}
```

```typescript
// main.ts
import express from "express";
import { em, initDb } from "./db";
import { User } from "./entities/user";

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

#### What register() does under the hood

The order matters, because a failure at any step should stop the process before it starts listening:

1. **Validates the options** and throws `OrmError` with code `INVALID_CONFIG` listing every problem it found — a non-numeric port, a missing password, `pool.min` above `pool.max`.
2. **Opens the connection** (with retry, if you configured `retry`).
3. **Applies the naming strategy** to entity metadata.
4. **Registers entities and runs schema synchronization** — this is where `synchronize` emits DDL.
5. **Installs plugins** listed in `options.plugins`, in array order.

Because step 4 can emit DDL, `register()` is the single most expensive call in your boot sequence, and the one you want to fail loudly. Keep it inside the `main().catch()` above rather than firing it off unawaited.

::: warning One EntityManager per database
`register()` without a connection name registers the `"default"` connection on a process-wide registry. If a second `EntityManager` registers under the same name, it replaces that connection — the first manager would silently start querying the second database. The ORM logs a warning when this happens:

```
WARN [DatabaseClient] Connection 'default' is already registered and will be replaced. ...
```

Share one `EntityManager` instance across your modules. If you genuinely need several databases in one process, give each one a distinct name — see [Multiple databases](#multiple-databases).
:::

## Project structure

Nothing in the ORM requires a particular layout, but the shape that survives growth separates three things: **where the connection lives**, **where the business rules live**, and **where HTTP lives**.

```
src/
  db.ts             # the EntityManager instance + initDb()
  config.ts         # environment -> DatabaseClientOptions
  entities/         # entity definitions
  services/         # business logic; imports `em`, knows nothing about HTTP
  routes/           # Express routers; parse/validate input, call services, shape responses
  main.ts           # wires it together and listens
```

The single rule worth enforcing: **services import `em` directly from `db.ts`, and routes never touch `em`.** This gives you the same testability that constructor injection gives NestJS — you can call a service from a script, a queue worker, or a test without constructing an HTTP request — without the ceremony of a DI container.

```typescript
// services/user-service.ts
import { em } from "../db";
import { User } from "../entities/user";

export async function registerUser(input: { email: string; name: string }) {
  return em.save(User, input);
}
```

```typescript
// routes/users.ts
import { Router } from "express";
import { registerUser } from "../services/user-service";

export const usersRouter = Router();

usersRouter.post("/", async (req, res) => {
  const user = await registerUser({ email: req.body.email, name: req.body.name });
  res.status(201).json(user);
});
```

## Configuration from the environment

The ORM does not read `process.env` and has no `DATABASE_URL` parsing — you build the options object yourself. What it does give you is `validateDatabaseClientOptions()`, which fails fast at boot with a readable message instead of letting a `NaN` port surface as a socket error minutes later:

```typescript
// config.ts
import { validateDatabaseClientOptions, type DatabaseClientOptions } from "@stingerloom/orm";
import { User } from "./entities/user";
import { Post } from "./entities/post";

export function loadDbOptions(): DatabaseClientOptions {
  const options: DatabaseClientOptions = {
    type: "postgres",
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USER ?? "postgres",
    password: process.env.DB_PASSWORD ?? "",
    database: process.env.DB_NAME ?? "app",
    entities: [User, Post],
    synchronize: process.env.NODE_ENV !== "production",
    logging: { slowQueryMs: 200, nPlusOne: true },
    pool: { max: 10 },
  };

  validateDatabaseClientOptions(options); // throws OrmError(INVALID_CONFIG) listing every problem
  return options;
}
```

`entities` accepts glob strings as well as classes (`entities: ["./dist/entities/*.js"]`), which requires the optional `fast-glob` peer dependency. Explicit imports are usually better in an Express app: they are checked by the compiler and survive bundling, whereas a glob silently resolves to nothing if your output directory moves.

::: warning synchronize in production
`synchronize: true` under `NODE_ENV=production` logs a data-loss warning but **does not block the DDL**. Gate it on the environment as shown above, and move to [migrations](#migrations-in-an-express-workflow) before your first deploy. The full rationale is in the [Production Guide](./production-guide.md#why-synchronize-true-is-dangerous-in-production).
:::

## Repositories

`@InjectRepository(User)` is NestJS DI sugar. The direct equivalent:

```typescript
const userRepository = em.getRepository(User);

const users = await userRepository.find({ where: { name: "alice" } });
```

A repository is a thin view over the `EntityManager` bound to one entity — it exposes the same read and write surface with the entity argument removed (`find`, `findOne`, `findOneOrFail`, `findWithPage`, `save`, `softDelete`, `createQueryBuilder`, and so on). Constructing one is cheap, so fetch it where needed or export it from `db.ts` alongside `em`:

```typescript
// db.ts
export const users = () => em.getRepository(User);
```

Note the function: calling `em.getRepository(User)` at module top level would run before `initDb()`, which is fine for the repository object itself but makes the ordering easy to get wrong as the file grows.

---

## Error handling

The ORM throws typed errors that extend `OrmError`, which carries two fields:

```typescript
class OrmError extends Error {
  readonly code: OrmErrorCode;        // stable string code, e.g. "ORM_ENTITY_NOT_FOUND"
  readonly suggestion: string | null; // developer-facing fix hint
}
```

Match on the class or on `err.code` — both are stable. **Never serialize `suggestion` to a client**: it is guidance for whoever wrote the code ("Add `@PrimaryGeneratedColumn()` to…"), not for the caller. Log it instead.

Express 5 forwards rejected async handlers to the error middleware automatically; on Express 4 you need an async wrapper such as `express-async-errors`.

```typescript
// middleware/error-handler.ts
import {
  OrmError,
  EntityNotFoundError,
  OptimisticLockError,
  ValidationError,
  DatabaseNotConnectedError,
} from "@stingerloom/orm";
import type { NextFunction, Request, Response } from "express";

// Constraint violations arrive as RAW DRIVER ERRORS — see the note below.
const isUniqueViolation = (e: any) =>
  e?.code === "23505" ||                    // PostgreSQL
  e?.errno === 1062 ||                      // MySQL / MariaDB
  e?.code === "SQLITE_CONSTRAINT_UNIQUE";   // better-sqlite3

const isForeignKeyViolation = (e: any) =>
  e?.code === "23503" ||
  e?.errno === 1452 ||
  e?.code === "SQLITE_CONSTRAINT_FOREIGNKEY";

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof EntityNotFoundError) {
    return res.status(404).json({ error: "not found" });
  }
  if (err instanceof ValidationError) {
    // ValidationError carries field / constraint / actual / expected
    return res.status(400).json({ error: err.message, field: err.field });
  }
  if (err instanceof OptimisticLockError) {
    return res.status(409).json({ error: "the record changed, please retry" });
  }
  if (isUniqueViolation(err)) {
    return res.status(409).json({ error: "already exists" });
  }
  if (isForeignKeyViolation(err)) {
    return res.status(409).json({ error: "referenced record is missing or still in use" });
  }
  if (err instanceof DatabaseNotConnectedError) {
    return res.status(503).json({ error: "database unavailable" });
  }
  if (err instanceof OrmError) {
    // Programmer/config errors: InvalidQueryError, EntityMetadataNotFoundError, ...
    console.error(`[orm] ${err.code}: ${err.message}`, err.suggestion ?? "");
    return res.status(500).json({ error: "internal error" });
  }

  console.error(err);
  return res.status(500).json({ error: "internal error" });
}
```

Register it last, after all routers: `app.use(errorHandler)`.

::: warning Constraint violations are not normalized
The ORM does **not** translate driver constraint errors into its own error classes. A duplicate key reaches your handler as a raw `mysql2` / `pg` / `better-sqlite3` error, which is why the middleware above sniffs driver codes. Two related traps: `OrmErrorCode.UNIQUE_VIOLATION` and `FK_VIOLATION` exist in the enum but nothing ever produces them, and the exported `QueryTimeoutError` / `TransactionError` classes are likewise never thrown — a query timeout surfaces as the driver's own timeout error. Do not write `catch (e) { if (e instanceof QueryTimeoutError) ... }` and expect it to fire.
:::

Two errors sit outside the `OrmError` hierarchy entirely — `DatabaseConnectionFailedError` and `NotSupportedDatabaseTypeError` extend a separate `Exception` base with a `status` field. The final `console.error(err)` fallback above catches them.

Without an error middleware, Express's default handler returns an HTML page that includes the stack trace — fine in development, not something to ship.

## Graceful shutdown

NestJS calls the ORM's shutdown hook via `app.enableShutdownHooks()`. In Express, wire the signal handlers yourself:

```typescript
const server = app.listen(3000);

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);

  // 1. Stop accepting new connections; wait for in-flight requests to finish.
  await new Promise<void>((resolve) => server.close(() => resolve()));

  // 2. Run plugin shutdown hooks and close the connection pool.
  await em.propagateShutdown({ closeConnections: true });

  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
```

#### What propagateShutdown() does under the hood

In order: waits for in-flight queries (see the caveat below), runs plugin shutdown hooks in reverse install order, clears event listeners and subscribers, tears down the query tracker, stops replica health checks, and — only when you pass `closeConnections: true` — closes the connection pool.

::: warning Two defaults that bite
**`closeConnections` defaults to `false`.** Without it the underlying `mysql2` / `pg` pool is never closed, its sockets keep the event loop alive, and your process hangs instead of exiting. In an Express signal handler you almost always want `{ closeConnections: true }`.

**`gracefulTimeoutMs` is silently ignored unless query tracking is on.** The wait is implemented by the `QueryTracker`, which only exists when `logging` is an object containing `nPlusOne` or `slowQueryMs`. With `logging: true` or no `logging` at all, `propagateShutdown({ gracefulTimeoutMs: 5000 })` returns immediately. Closing the HTTP server first — as above — is the reliable way to drain in-flight work regardless.
:::

The return value is `true` when everything drained cleanly and `false` when the graceful wait timed out; log it if you care about the distinction.

## Health checks and readiness

Kubernetes-style probes want two different answers: *is the process alive* (liveness) and *can it serve traffic* (readiness). Only the second should touch the database.

```typescript
import { DatabaseClient } from "@stingerloom/orm";

const client = DatabaseClient.getInstance();

// Liveness: no I/O. If the event loop is running, we are alive.
app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

// Readiness: one round trip to the database.
app.get("/readyz", async (_req, res) => {
  try {
    if (!client.hasConnection("default")) {
      return res.status(503).json({ db: "not registered" });
    }
    await client.getConnection("default").runTestSql();
    res.json({ db: "up" });
  } catch {
    res.status(503).json({ db: "down" });
  }
});
```

`runTestSql()` issues a single `SELECT 1 + 1` through the pool's own query path — no transaction, no explicit connection checkout. The `hasConnection()` guard matters: `runTestSql()` resolves successfully when no pool exists at all, so without the guard a process that never connected would report itself healthy.

::: tip Do not use em.query("SELECT 1") as a probe
`em.query()` routes through the full transaction machinery — checkout, `BEGIN`, your statement, `COMMIT`, release — roughly four round trips where `runTestSql()` needs one. It is correct, just needlessly expensive to run every few seconds. (`runTestSql()` is declared as returning `void` on the connector interface while every driver implements it as `async`; awaiting it is correct.)
:::

---

## Reading data

`find` and `findOne` take a `FindOption` object. The pieces you will use in almost every route:

```typescript
const posts = await em.find(Post, {
  where: { published: true, authorId: 7 },
  select: ["id", "title", "createdAt"],
  relations: ["author"],
  orderBy: { createdAt: "DESC" },
  skip: 20,
  take: 10,
});
```

Filters are **nested objects**, not helper functions — there is no `Like()` or `In()` to import:

```typescript
await em.find(Post, {
  where: {
    title:     { contains: "orm" },      // LIKE %orm% with % and _ escaped
    views:     { gte: 100, lt: 10_000 },
    status:    { in: ["published", "featured"] },
    deletedAt: { isNull: true },
  },
});

// OR across whole groups
await em.find(Post, {
  where: [{ status: "featured" }, { views: { gte: 10_000 } }],
});

// or explicitly
await em.find(Post, {
  where: { OR: [{ status: "featured" }, { views: { gte: 10_000 } }] },
});
```

The operator set is `eq` / `ne` / `in` / `notIn` / `not` / `isNull` on any field; `gt` / `gte` / `lt` / `lte` / `between` on numbers, dates and bigints; and `like` / `notLike` / `ilike` / `contains` / `startsWith` / `endsWith` / `search` on strings. A bare array is shorthand for `in`, and `null` means `IS NULL`.

Other methods you will reach for: `findOneOrFail` (throws `EntityNotFoundError`, which your middleware already maps to 404), `findByPK`, `findAndCount`, `exists`, `count` / `sum` / `avg` / `min` / `max`, and `pluck` for a single column. The full reference is [Querying with EntityManager](./entity-manager-querying.md).

::: tip skip/take over the limit tuple
`FindOption` also has `limit`, which accepts either a plain number (`LIMIT n`) or a `[offset, count]` **tuple**. The tuple form is the low-level shape the builder uses internally; `skip` and `take` are clearer at a call site and are what the pagination helpers use. Do not mix them — if a tuple is present it wins, and `skip` is ignored.
:::

## Pagination

Two shapes, and the choice is about the data, not preference.

**Offset pagination** — numbered pages, jump to page 7, show a total count. Correct for admin tables and anything where the user expects page numbers:

```typescript
app.get("/posts", async (req, res) => {
  const result = await em.findWithPage(Post, {
    page: Number(req.query.page ?? 1),
    pageSize: 20,
    where: { published: true },
    orderBy: { createdAt: "DESC" },
    relations: ["author"],
  });
  // { data, total, page, pageSize, totalPages, hasNextPage, hasPreviousPage }
  res.json(result);
});
```

**Cursor pagination** — infinite scroll and feeds. It stays fast at any depth (no `OFFSET 100000` scan) and does not skip or duplicate rows when new records are inserted while the user pages:

```typescript
app.get("/feed", async (req, res) => {
  const result = await em.findWithCursor(Post, {
    take: 20,
    cursor: req.query.cursor as string | undefined,
    orderBy: "createdAt",
    direction: "DESC",
    where: { published: true },
  });
  // { data, hasNextPage, nextCursor, count }
  res.json({ items: result.data, nextCursor: result.nextCursor });
});
```

The cursor is an opaque Base64 string — hand `nextCursor` back to the client and accept it unchanged on the next request. Two constraints: sort on a **non-null** column (NULL ordering differs across PostgreSQL, MySQL and SQLite), and prefer a column that is unique or paired with the primary key, or rows sharing a timestamp can straddle a page boundary.

Deeper comparison, including streaming as a third option, is in [Pagination](./pagination.md).

## The query builder

`find()` covers filtering and relation loading. Reach for the query builder when you need joins the relation graph does not express, aggregates, subqueries, or conditional query assembly:

```typescript
const qb = em
  .createQueryBuilder(Post, "p")
  .leftJoinRelationAndSelect("author", "a")   // resolves the ON clause from relation metadata
  .where({ status: "published" })
  .andWhere({ createdAt: { gte: since } })
  .orderBy({ createdAt: "DESC" })
  .take(20);

const posts = await qb.getMany();
```

Conditional assembly — the reason a builder beats a growing pile of `if`s around `find()`:

```typescript
app.get("/search", async (req, res) => {
  const { q, authorId, minViews } = req.query;

  const posts = await em
    .createQueryBuilder(Post, "p")
    .where({ status: "published" })
    .when(!!q, (b) => b.andWhere({ title: { contains: String(q) } }))
    .when(!!authorId, (b) => b.andWhere({ authorId: Number(authorId) }))
    .when(!!minViews, (b) => b.andWhere({ views: { gte: Number(minViews) } }))
    .paginate({ page: Number(req.query.page ?? 1), pageSize: 20 });

  res.json(posts);
});
```

::: warning .where() does not take a SQL string with named parameters
If you are coming from TypeORM, `.where("p.title = :title", { title })` is muscle memory — and it does not work here. A string argument is read as a **column reference**, not as SQL, so passing a SQL fragment throws `InvalidQueryError` at build time (it used to silently produce broken SQL). The accepted forms are:

```typescript
.where({ title: "hello" })                      // filter object (most common)
.where("p.title", "hello")                      // column, value
.where("p.views", ">=", 100)                    // column, operator, value
.where(sql`LOWER(p.title) = ${term}`)           // raw fragment, parameter-bound
.where(qAlias(Post, "p").title.eq("hello"))     // typed QueryDSL
```
:::

The typed DSL is worth knowing for cross-alias conditions, because it catches column typos at compile time:

```typescript
import { qAlias } from "@stingerloom/orm";

const p = qAlias(Post, "p");
const a = qAlias(User, "a");

const rows = await em
  .createQueryBuilder(Post, "p")
  .leftJoin(User, "a", (j) => j.on(p.col("authorId"), "=", a.col("id")))
  .where(a.name.eq("alice"))
  .andWhere(p.views.gte(100))
  .getMany();
```

Choose your execution method by what you want back:

| Method | Returns | Use for |
|---|---|---|
| `getMany()` / `getOne()` | entity instances | normal reads; rejects partial selects that drop non-nullable columns |
| `getPartialMany()` | plain objects | projections — list views that select a few columns |
| `getRawMany()` | untyped rows | aggregates and hand-written expressions |
| `paginate()` / `getCursor()` | page / cursor result | paginated endpoints |
| `getCount()` / `getSum()` / `exists()` | scalar | counters and existence checks |

See [Query Builder](./query-builder.md) and [Query Builder — Execution](./query-builder-execution.md).

## Raw SQL

When SQL is the clearest expression of the problem, the tagged template keeps you parameterized and portable. Interpolating an **entity class** resolves to its table identifier — including the tenant schema qualifier and any naming strategy — while every other value is bound as a parameter:

```typescript
const rows = await em.query<{ authorId: number; total: number }>`
  SELECT author_id AS "authorId", COUNT(*) AS total
  FROM ${Post}
  WHERE created_at >= ${since}
  GROUP BY author_id
  ORDER BY total DESC
  LIMIT ${limit}
`;
```

The string form takes **driver-native placeholders**, which differ by dialect — `$1, $2` on PostgreSQL, `?` on MySQL and SQLite. Nothing rewrites them, so a query written this way is tied to one database:

```typescript
const rows = await em.query<Post>("SELECT * FROM posts WHERE author_id = $1", [authorId]);
```

::: warning Raw SQL bypasses tenant scoping
In a multi-tenant app, `em.query()` does not inject the tenant predicate — the ORM logs a warning when it detects this. Under the PostgreSQL schema strategies the isolation still holds (it is enforced by `search_path` at the connection level), but under the tenant-column strategy raw SQL will read across tenants. Add the filter yourself or use the query builder there.
:::

## Streaming large result sets

Never load an export endpoint's whole result set into memory. `em.stream()` yields entities one at a time, fetching in batches under the hood, and pairs naturally with a newline-delimited JSON response:

```typescript
app.get("/export/users", async (req, res) => {
  res.setHeader("Content-Type", "application/x-ndjson");

  for await (const user of em.stream(User, { orderBy: { id: "ASC" } }, 500)) {
    // Respect backpressure — without this a fast DB will outrun a slow client.
    if (!res.write(JSON.stringify(user) + "\n")) {
      await new Promise((resolve) => res.once("drain", resolve));
    }
  }

  res.end();
});
```

`streamBatch()` yields arrays instead, which is what you want when the consumer is itself batch-shaped (a bulk API, a CSV writer, a queue publisher).

Both stream by `LIMIT`/`OFFSET` rather than a database cursor, so they work on every dialect — and so **a stable `orderBy` is required**. Without one, rows can be skipped or repeated between batches.

---

## Transactions

The callback form is the default. Everything inside shares one transaction; a thrown error rolls the whole thing back:

```typescript
await em.transaction(async (txEm) => {
  const from = await txEm.findOneOrFail(Account, { where: { id: fromId } });
  if (from.balance < amount) throw new Error("insufficient funds");

  await txEm.update(Account, { id: fromId }, { balance: from.balance - amount });
  await txEm.increment(Account, { id: toId }, "balance", amount);
});
```

Options cover isolation, propagation, and deadlock retry:

```typescript
await em.transaction(
  async (txEm) => { /* ... */ },
  {
    isolationLevel: "SERIALIZABLE",   // "READ UNCOMMITTED" | "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE"
    retryOnDeadlock: true,
    maxRetries: 3,                    // only consulted when retryOnDeadlock is true
    retryDelayMs: 100,
  },
);
```

Retries re-run the **entire callback**, so it must be idempotent — no incrementing an in-memory counter, no sending an email halfway through.

### @Transactional() without a DI container

`@Transactional()` is not a NestJS feature. It tracks the active transaction in `AsyncLocalStorage` and **never touches `this`** — no injected `em`, no base class, no container. That makes it work on an ordinary Express service class:

```typescript
import { Transactional } from "@stingerloom/orm";
import { em } from "../db";

export class TransferService {
  @Transactional()
  async transfer(fromId: number, toId: number, amount: number) {
    // Every em call in here joins the same transaction — including calls in
    // functions this method invokes, however deep.
    const from = await em.findOneOrFail(Account, { where: { id: fromId } });
    if (from.balance < amount) throw new Error("insufficient funds");

    await em.update(Account, { id: fromId }, { balance: from.balance - amount });
    await em.increment(Account, { id: toId }, "balance", amount);
  }
}
```

The decorator accepts `isolationLevel`, `propagation`, and `connectionName` — and nothing else. Deadlock retry exists only on `em.transaction()`; if you need it, use the callback form.

::: warning @Transactional() always opens the default connection
The decorator resolves its connection from the global registry, not from the `em` you happen to call inside it. If your manager is bound to a named connection, pass it explicitly — `@Transactional({ connectionName: "analytics" })` — or use `em.transaction(cb, { connectionName })`, which inherits the manager's connection automatically.

Also note that `propagation: NESTED` degrades to a plain transaction when there is no enclosing one: the savepoint has nothing to nest inside.
:::

### Should a whole request be one transaction?

A tempting middleware wraps every request in `em.transaction()` so handlers never think about it. Resist it for general use. It holds a pooled connection for the entire request — including time spent on template rendering, external HTTP calls, and slow clients — which is the fastest way to exhaust a pool under load. Open transactions around the **write** that needs atomicity, not around the request.

The exception is a request that genuinely is one unit of work end to end (a checkout, an import). Wrap that route, not the app.

Isolation levels, savepoints, and propagation semantics are covered in [Transactions](./transactions.md#setting-isolation-levels).

## Concurrency: optimistic and pessimistic locking

**Optimistic** locking suits HTTP well, because the classic failure — two browser tabs editing the same record — is exactly what it detects. Add a version column, and a stale update throws instead of silently overwriting:

```typescript
export const Post = defineEntity("posts", {
  id:      t.int().primary().generated(),
  title:   t.varchar(200),
  version: t.int().version(),
});
```

```typescript
app.patch("/posts/:id", async (req, res, next) => {
  try {
    const post = await em.findOneOrFail(Post, { where: { id: Number(req.params.id) } });
    post.title = req.body.title;
    post.version = req.body.version; // the version the client last read
    res.json(await em.save(Post, post));
  } catch (e) {
    next(e); // OptimisticLockError -> 409 in your error middleware
  }
});
```

Returning `409` with the current record lets the client show a real conflict UI instead of losing the user's edit.

**Pessimistic** locking is for short, contended write paths — inventory decrements, ledger balances, job queues. It only has an effect inside a transaction:

```typescript
import { LockMode } from "@stingerloom/orm";

await em.transaction(async (txEm) => {
  const item = await txEm.findOne(Inventory, {
    where: { sku },
    lock: LockMode.PESSIMISTIC_WRITE,   // SELECT ... FOR UPDATE
  });
  if (!item || item.stock < 1) throw new Error("out of stock");
  await txEm.update(Inventory, { sku }, { stock: item.stock - 1 });
});
```

`PESSIMISTIC_WRITE_SKIP_LOCKED` turns a table into a work queue — each worker grabs rows nobody else holds. It needs MySQL 8.0+ or PostgreSQL 9.5+; **SQLite throws** for any `NOWAIT` or `SKIP_LOCKED` mode, and ignores plain `FOR UPDATE`. Keep that in mind if SQLite is your local development database and PostgreSQL is production.

## Batch writes

Row-at-a-time `save()` in a loop is the most common performance mistake in a bulk endpoint. The batch methods issue one statement:

```typescript
await em.insertMany(Post, rows);          // one multi-row INSERT, returns { affected }
const saved = await em.saveMany(Post, rows);          // hydrated instances back
const created = await em.insertManyAndReturn(Post, rows); // INSERT ... RETURNING

await em.batchUpsert(Post, rows, ["slug"]);           // INSERT ... ON CONFLICT/DUPLICATE KEY
await em.updateMany(Post, { archived: true }, { where: { authorId: 7 } });
```

`insertManyAndReturn` needs `INSERT ... RETURNING` — PostgreSQL, SQLite 3.35+, MariaDB 10.5+. **MySQL throws** before building any SQL; use `saveMany` there.

For genuinely large imports, combine batching with a transaction and chunking so one failure does not leave half a file loaded:

```typescript
await em.transaction(async (txEm) => {
  for (let i = 0; i < rows.length; i += 500) {
    await txEm.insertMany(Post, rows.slice(i, i + 500));
  }
});
```

## Soft delete

Add a `@DeletedAt` column (or `t.datetime().deletedAt()` in the code-first style) and use `softDelete` / `restore`:

```typescript
await em.softDelete(Post, { id });   // sets deleted_at
await em.restore(Post, { id });      // clears it
```

Every read then filters out trashed rows by default. `withDeleted: true` includes them; `onlyDeleted: true` returns just the trash (a "recycle bin" view) and takes precedence over `withDeleted`:

```typescript
await em.find(Post, { where: { authorId: 7 } });                      // live rows
await em.find(Post, { where: { authorId: 7 }, withDeleted: true });   // live + trashed
await em.find(Post, { where: { authorId: 7 }, onlyDeleted: true });   // trashed only
```

Two behaviors worth internalizing before you ship a delete endpoint:

- **`em.delete()` is still a hard `DELETE`**, even on an entity with a `@DeletedAt` column. Soft delete is opt-in per call, not a global mode. Route your HTTP `DELETE` to `softDelete()` deliberately.
- **Aggregates take the flags positionally**, not in an options object: `em.count(Post, where, withDeleted, onlyDeleted)`.

Bulk `updateMany` skips trashed rows by default so a mass update cannot quietly resurrect deleted data; pass `withDeleted: true` to include them.

---

## Connection pooling

```typescript
pool: {
  max: 10,                  // default 10
  min: 0,                   // PostgreSQL only
  acquireTimeoutMs: 30_000, // PostgreSQL only
  idleTimeoutMs: 10_000,    // PostgreSQL only
  validateOnBorrow: false,  // ping before handing out a connection
}
```

Sizing guidance lives in the [Production Guide](./production-guide.md#connection-pool-size). Three dialect-specific facts that decide how your Express app behaves under load:

- **SQLite ignores `pool` entirely.** There is one connection. Concurrent transactions are not possible — the practical consequence is that helpers running a count and a data query in parallel must run them sequentially, which is what the built-in pagination helpers do.
- **MySQL only receives `max`.** `acquireTimeoutMs` is not forwarded, and the ORM does not set `queueLimit`, so when the pool is saturated `mysql2` **queues callers indefinitely**. Requests pile up rather than failing fast; a slow query storm turns into unbounded latency. Defend with a per-query `timeout` and a request timeout at the HTTP layer.
- **PostgreSQL honors all four.** A saturated pool rejects after `acquireTimeoutMs`, and the rejection propagates as the raw `pg` error — not an `OrmError`.

`validateOnBorrow: true` pings each connection before use and retries once on failure, which lets an app survive a database restart without a rolling restart of its own. It costs one extra round trip per checkout.

::: warning leakDetectionThresholdMs is currently a no-op
The `pool.leakDetectionThresholdMs` option is declared and the `ConnectionLeakDetector` class is exported, but nothing in the ORM wires them together — setting it has no effect today. To find leaks, use slow-query logging and pool metrics from your database instead.
:::

## Logging, slow queries, and N+1 detection

```typescript
logging: {
  queries: true,        // log every generated SQL statement (development)
  slowQueryMs: 200,     // warn when a query exceeds this
  nPlusOne: true,       // warn on repeated same-entity queries
  maxLogEntries: 1000,  // ring buffer size
}
```

Output looks like:

```
[SLOW QUERY] 342ms: SELECT ... FROM "posts" WHERE ...
[N+1 WARNING] Entity "Post" queried 12+ times in 100ms. Consider using eager loading or relations option.
```

`logging: true` on its own enables SQL logging **only** — no tracker, and therefore no slow-query or N+1 warnings (and no `gracefulTimeoutMs` support at shutdown). Use the object form in any environment where you want those signals.

For production you usually want these as structured events rather than console lines. The tracker is an emitter:

```typescript
const tracker = em.getQueryTracker();

tracker?.on("slowQuery", (entry) => {
  logger.warn({ sql: entry.sql, ms: entry.durationMs, entity: entry.entityName }, "slow query");
});

tracker?.on("nPlusOne", (entityName, samples) => {
  logger.warn({ entity: entityName, count: samples.length }, "n+1 detected");
});
```

The N+1 heuristic is fixed at 10 queries against the same entity within 100 ms, and it warns once per entity for the lifetime of the tracker — it points you at the problem, it is not a metric to graph.

The usual fix is to load the relation up front rather than per row:

```typescript
// N+1: one query for posts, then one per post
const posts = await em.find(Post, {});
for (const p of posts) p.author = await em.findOne(User, { where: { id: p.authorId } });

// One query with a join
const posts = await em.find(Post, { relations: ["author"] });
```

## Read replicas

```typescript
replication: {
  master: { host: "db-primary", port: 5432, username: "app", password, database: "app" },
  slaves: [
    { host: "db-replica-1", port: 5432, username: "app", password, database: "app" },
    { host: "db-replica-2", port: 5432, username: "app", password, database: "app" },
  ],
  strategy: "round-robin",   // or "random"
}
```

Reads are routed to replicas; writes and anything inside a transaction always go to the primary. When a read must observe a write you just made — the read-after-write of a `POST` handler returning the created row — force the primary per query:

```typescript
await em.findOne(User, { where: { id }, useMaster: true });
```

`useMaster` is also available on `findWithPage` and `findWithCursor` options.

::: warning Replica reads open a fresh connection per query
The replica path constructs a new connector and connects per read session rather than drawing from a cached pool, so each replica-routed query pays connect and disconnect cost. It is a real feature with a real trade-off — measure before routing a hot endpoint through it. Replication is also wired to the `"default"` connection only, so it does not compose with named connections.
:::

## Multiple databases

There is no `getRepository(Entity, connectionName)` overload — the connection is a property of the manager. One `EntityManager` per database:

```typescript
// db.ts
export const em = new EntityManager();          // primary
export const analyticsEm = new EntityManager(); // reporting warehouse

export async function initDb() {
  await em.register(primaryOptions);                          // "default"
  await analyticsEm.register(analyticsOptions, "analytics");  // named
}
```

`analyticsEm.getRepository(Event)` inherits the `"analytics"` connection. To run a one-off transaction against another connection without a second manager, pass the name:

```typescript
await em.transaction(async (txEm) => { /* ... */ }, { connectionName: "analytics" });
```

`em.attach(name, overrides?)` binds a manager to an already-registered pool without opening a new one; it forces `synchronize: false`, which makes it the right tool for a read-only reporting manager over an existing connection.

## Migrations in an Express workflow

Once real data exists, replace `synchronize` with migrations. The CLI reads a config file from your project root — `stingerloom.config.ts`, `.js`, `.mjs`, or `.cjs` (or `ormconfig.*`):

```typescript
// stingerloom.config.ts
import { CreateUsersTable } from "./migrations/001-create-users";
import { AddPostsTable } from "./migrations/002-add-posts";
import { User } from "./src/entities/user";
import { Post } from "./src/entities/post";

export default {
  connection: {
    type: "postgres",
    host: process.env.DB_HOST ?? "localhost",
    port: 5432,
    username: "app",
    password: process.env.DB_PASSWORD ?? "",
    database: "app",
    entities: [User, Post],   // required for migrate:generate
  },
  migrations: [CreateUsersTable, AddPostsTable],
};
```

```bash
npx stingerloom migrate:status
npx stingerloom migrate:run
npx stingerloom migrate:generate --name add_posts
npx stingerloom migrate:rollback
```

`migrations` must be an **array of imported migration classes** — glob patterns are not supported, and a non-array value fails with an explicit config error. A flat `DatabaseClientOptions` object (no `connection` wrapper) is also accepted.

::: tip Run migrations as a deploy step, not at boot
`MigrationRunner.runAll()` is safe to call from application code — it takes a database advisory lock, so several instances starting at once cannot double-apply. But it drives the process-wide `DatabaseClient` singleton and closes it when finished, which will tear the connection out from under a live app manager. Run migrations in a separate command (a Kubernetes init container, a release phase, `npm run migrate` in CI) and let the app assume the schema is current.
:::

The transition plan from `synchronize` to migrations, and zero-downtime patterns for risky column changes, are in the [Production Guide](./production-guide.md#_2-transitioning-from-synchronize-to-migrations).

## Seeding

Seeders are ordinary classes run by `SeederRunner`, tracked in a `__seeds` table so re-running is idempotent. There is no CLI command — invoke them from a script:

```typescript
// scripts/seed.ts
import { EntityManager, Seeder, SeederRunner, type SeederContext } from "@stingerloom/orm";
import { loadDbOptions } from "../src/config";
import { User } from "../src/entities/user";

class AdminSeeder extends Seeder {
  async run({ em }: SeederContext) {
    await em.save(User, { email: "admin@example.com", name: "admin" });
  }
  async revert({ em }: SeederContext) {
    await em.delete(User, { email: "admin@example.com" });
  }
}

const em = new EntityManager();
await em.register(loadDbOptions());

const runner = new SeederRunner([new AdminSeeder()], em, { query: (sql) => em.query(sql) });
console.log(await runner.runAll());
await em.propagateShutdown({ closeConnections: true });
```

---

## Multi-tenancy middleware

The [multi-tenancy](./multi-tenancy.md) context is plain `AsyncLocalStorage`, so the Express middleware is small. What differs is the isolation strategy underneath, and each has a rule you must not skip.

**Schema-based (PostgreSQL).** The tenant id becomes a schema name in generated SQL, so it must be validated as an identifier before it reaches the ORM:

```typescript
import { MetadataContext } from "@stingerloom/orm";

const SCHEMA_RE = /^[A-Za-z_][A-Za-z0-9_$-]*$/;

app.use((req, res, next) => {
  const tenantId = req.headers["x-tenant-id"] as string | undefined;
  if (!tenantId || !SCHEMA_RE.test(tenantId)) {
    return res.status(400).json({ error: "invalid tenant" });
  }
  // Do not await: next() must run inside the AsyncLocalStorage scope.
  MetadataContext.run(tenantId, () => next());
});
```

**Tenant-column (any dialect).** No identifier constraint, but isolation is enforced by ORM-generated `WHERE` clauses — so raw SQL escapes it:

```typescript
await em.register({
  // ...
  tenantStrategy: "tenant_column",
  tenantColumnName: "tenant_id",
  tenantColumnType: "uuid",
});
```

```typescript
app.use((req, res, next) => {
  const tenantId = req.headers["x-tenant-id"] as string | undefined;
  if (!tenantId) return res.status(400).json({ error: "missing tenant" });

  MetadataContext.run(tenantId, () => {
    em.assertTenantContext(); // once per request — it warns on every call
    next();
  });
});
```

Every handler and every ORM call in the request then runs in that tenant's context, and concurrent requests for different tenants stay isolated. For a deliberately cross-tenant admin route, escape the scope explicitly:

```typescript
app.get("/admin/report", requireAdmin, (req, res, next) => {
  Promise.resolve(
    MetadataContext.runUnscoped(async () => {
      res.json(await em.find(Invoice, {}));
    }),
  ).catch(next);
});
```

Three things to know before you go to production with this:

- `"public"` is the sentinel for "no tenant" and receives **no** filter. A tenant literally named `public` would see everything.
- Tenant provisioning (`PostgresTenantMigrationRunner`) is **PostgreSQL-only**; the MySQL and SQLite runners throw.
- Per-request context setup at scale, including connection-pool sharing across hundreds of tenants, is covered in the [Production Guide](./production-guide.md#per-http-request-tenant-context-setup).

## Lifecycle hooks and subscribers

For cross-cutting write concerns — audit logs, cache invalidation, outbox rows — a subscriber keeps the logic out of every service. Register it on the plain `EntityManager`; no DI container is involved:

```typescript
import type { EntitySubscriber, UpdateEvent } from "@stingerloom/orm";

class UserAuditSubscriber implements EntitySubscriber<User> {
  listenTo() {
    return User;
  }

  async beforeUpdate(event: UpdateEvent<User>) {
    // databaseEntity is the pre-update snapshot from the database
    if (!event.databaseEntity) return;
    if (event.databaseEntity.email !== event.entity.email) {
      await event.manager.save(AuditLog, {
        entity: "User",
        field: "email",
        before: event.databaseEntity.email,
        after: event.entity.email,
      });
    }
  }
}

em.addSubscriber(new UserAuditSubscriber());
```

Subscribers can hook `afterLoad`, insert/update/delete before and after, soft-delete and restore, and transaction boundaries. Two limits worth knowing: `databaseEntity` is populated only by `em.save()` (raw builder updates leave it `null`), and bulk `updateMany` does not fire subscriber update events.

For logic that belongs to the entity itself, the `@BeforeInsert` / `@AfterInsert` / `@BeforeUpdate` / `@AfterUpdate` / `@BeforeDelete` / `@AfterDelete` method decorators are simpler. The code-first equivalent is the `hooks` option on `defineEntity` — note that hooks fire on **instances**, so persist with `new Post({ ... })` rather than an object literal.

See [Events](./events.md).

## The write buffer (unit of work)

The ORM executes writes immediately by default — `save()` issues SQL. The opt-in buffer plugin adds an identity map and dirty tracking, so you can load, mutate plain objects, and flush once:

```typescript
import { bufferPlugin } from "@stingerloom/orm";

em.extend(bufferPlugin());
```

```typescript
app.post("/orders/:id/recalculate", async (req, res) => {
  await em.transaction(async () => {
    const buf = em.buffer();

    const order = await buf.findOne(Order, { where: { id: Number(req.params.id) } });
    const lines = await buf.find(OrderLine, { where: { orderId: order!.id } });

    order!.total = lines.reduce((sum, l) => sum + l.price * l.quantity, 0);

    const result = await buf.flush(); // { updates, inserts, deletes }
    res.json(result);
  });
});
```

Create the buffer **per request**, never as a module-level singleton — it is a change-tracking scope, and sharing one across concurrent requests would mix their entities.

::: warning Nested buffers need an enclosing transaction
`buf.beginNested()` wraps its flush in a `SAVEPOINT`. That savepoint is only meaningful inside an ambient `em.transaction()`; flushing a nested buffer outside one opens and commits its own transaction, so a later rollback cannot undo it. The ORM logs a warning when it happens. Wrap the whole workflow in `em.transaction()` as above.
:::

Full semantics — flush modes, cascade behavior, collection tracking — are in [Write Buffer](./write-buffer.md).

## Plugins

A plugin sees every query, which makes it the right place for metrics and tracing that would otherwise be scattered across services:

```typescript
import type { StingerloomPlugin } from "@stingerloom/orm";

const metricsPlugin: StingerloomPlugin = {
  name: "metrics",
  install() {
    // one-time setup; may return an API object that em.extend() mixes in
  },
  afterQuery(query, _result, durationMs) {
    queryDuration.observe({ operation: query.operation ?? "unknown" }, durationMs);
  },
  beforeTransaction() {
    transactionsStarted.inc();
  },
  afterTransaction(committed) {
    (committed ? transactionsCommitted : transactionsRolledBack).inc();
  },
  async shutdown() {
    await metricsRegistry.flush();
  },
};

em.extend(metricsPlugin);
```

`shutdown()` hooks run in reverse installation order during `propagateShutdown()`, so a plugin can flush buffered telemetry before the process exits. See [Plugins](./plugins.md).

## Testing

`@stingerloom/orm/testing` gives you an in-memory SQLite manager, which is fast enough to build fresh per test file and needs no running database:

```typescript
// tests/users.test.ts
import request from "supertest";
import { createTestEntityManager } from "@stingerloom/orm/testing";
import { User } from "../src/entities/user";

let em: Awaited<ReturnType<typeof createTestEntityManager>>;

beforeAll(async () => {
  em = await createTestEntityManager({ entities: [User] });
});

afterAll(async () => {
  await em.propagateShutdown({ closeConnections: true });
});

it("creates a user", async () => {
  const res = await request(app).post("/users").send({ email: "a@b.c", name: "alice" });
  expect(res.status).toBe(201);
  expect(await em.count(User)).toBe(1);
});
```

The helper defaults to `type: "sqlite"`, `database: ":memory:"`, `synchronize: true`, and `connectionName: "test"` — the distinct connection name is what keeps it from colliding with an application manager registered as `"default"` in the same process.

Remember that SQLite differs from your production database in ways tests can hide: no `SKIP LOCKED`, no concurrent transactions, and looser type affinity. Keep a smaller integration suite against the real engine for anything that depends on those.

---

## Notes on dev tooling

- **tsx / nodemon restarts** are safe: metadata and connections are rebuilt on every process start.
- **better-sqlite3 is a native module.** If `new Database()` crashes the process right after an upgrade, the installed prebuilt binary does not match your Node.js version — reinstall it (`npm rebuild better-sqlite3`) or pin a major version known to support your Node release.
- The migration CLI (`npx stingerloom`) and the Prisma importer run as CommonJS tools; they work regardless of your app's module system.
- **`reflect-metadata` must be imported once, before any entity module.** Putting it at the top of `db.ts` and importing `db.ts` first from `main.ts` is the reliable ordering; a bundler that hoists imports can otherwise load an entity before the polyfill exists.

## Production checklist

| Item | Setting |
|---|---|
| Schema changes | `synchronize: false`; migrations run as a separate deploy step |
| Pool size | `pool.max` sized to your database's connection limit divided by instance count |
| Query timeout | `queryTimeout` set, plus an HTTP-layer timeout — essential on MySQL, whose pool queue is unbounded |
| Slow queries | `logging: { slowQueryMs: 200 }` wired to your logger via `getQueryTracker()` |
| Shutdown | `SIGTERM` handler: `server.close()` then `propagateShutdown({ closeConnections: true })` |
| Probes | `/healthz` with no I/O; `/readyz` calling `runTestSql()` behind a `hasConnection()` guard |
| Errors | Error middleware mapping `OrmError` subclasses and raw driver constraint codes to status codes |
| Secrets | `suggestion` and stack traces logged, never serialized to clients |

## Next Steps

- [Configuration](./configuration.md) — every connection option in detail
- [Transactions](./transactions.md) — isolation levels, savepoints, propagation
- [Querying with EntityManager](./entity-manager-querying.md) — the complete read surface
- [Production Operations Guide](./production-guide.md) — pool monitoring, zero-downtime migrations, tenancy at scale
- [Troubleshooting](./troubleshooting.md) — the errors you are most likely to hit first
