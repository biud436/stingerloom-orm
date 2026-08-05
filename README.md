<h1 align="center">Stingerloom ORM</h1>
<p align="center">A decorator-driven TypeScript ORM with a typed expression DSL and layered multi-tenancy, built for PostgreSQL, MySQL, and SQLite.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@stingerloom/orm"><img src="https://img.shields.io/npm/v/@stingerloom/orm" alt="npm version" /></a>
  <a href="https://github.com/biud436/stingerloom-orm/actions/workflows/ci.yml"><img src="https://github.com/biud436/stingerloom-orm/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
  <a href="https://github.com/biud436/stingerloom-orm/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license" /></a>
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" alt="TypeScript strict" />
</p>

<p align="center">
  <a href="https://biud436.github.io/stingerloom-orm/"><b>Documentation</b></a> ·
  <a href="https://biud436.github.io/stingerloom-orm/getting-started"><b>Getting Started</b></a> ·
  <a href="https://biud436.github.io/stingerloom-orm/api-reference"><b>API Reference</b></a> ·
  <a href="https://github.com/biud436/stingerloom-orm/tree/main/examples"><b>Examples</b></a>
</p>

---

## Why Stingerloom?

- **Multi-tenancy built in** — Layered metadata system (inspired by Docker OverlayFS) with `AsyncLocalStorage`-based context isolation. Zero cross-tenant leakage by design.
- **Typed QueryDSL via Proxy, no codegen** — `qAlias(Entity, "u")` gives you IDE autocomplete on every column. Chain `.eq / .gt / .like / .in`, aggregates (`.count() / .sum() / .avg()`), CAST, date components, window functions, CASE/WHEN (plus `iff` / `mapValues` / `buckets` shortcuts), subqueries, and JSON-path navigation — all returning type-safe expressions that compose freely across `where() / having() / select()`. Import the namespace as `{ Expressions as exp }` to keep call sites short.
- **Unit of Work plugin** — Identity Map, dirty checking, cascade, batch flush, lazy proxies, and pessimistic locking via `em.extend(bufferPlugin())`. Single-level cache skips round-trips for repeated PK lookups.
- **Three databases, one API** — MySQL (incl. MariaDB-specific optimizations), PostgreSQL, and SQLite share the same EntityManager interface. Switch drivers without rewriting queries.
- **Schema Diff migrations** — Compare live database state against entity metadata and auto-generate migration code. Supports `true / "safe" / "dry-run"` synchronize modes.
- **NestJS-ready** — First-party module with `@InjectRepository`, `@InjectEntityManager`, and multi-DB named connections.

## Quick Start

```bash
npm install @stingerloom/orm reflect-metadata
npm install pg        # or mysql2, better-sqlite3
```

Any package manager works for consuming the library (`npm` / `pnpm` / `yarn`).
The bundled [example projects](#examples) are a different story — they are pnpm
workspace packages, so run them with `pnpm` (see below).

`tsconfig.json` — decorator metadata must be on:

```jsonc
{ "compilerOptions": { "experimentalDecorators": true, "emitDecoratorMetadata": true } }
```

### 1. Define entities

Code-first with the `defineEntity` builder — the entity type is inferred from the schema (`InferEntity`), so you write neither a class nor a parallel interface, and you need no `experimentalDecorators` / `emitDecoratorMetadata` / codegen:

```typescript
import "reflect-metadata";
import { defineEntity, t, InferEntity } from "@stingerloom/orm";

export const Author = defineEntity("authors", {
  id:    t.int().primary().generated(),
  name:  t.varchar(255),
  posts: t.oneToMany(() => Post, "author"),
});

export const Post = defineEntity("posts", {
  id:          t.int().primary().generated(),
  title:       t.varchar(255),
  views:       t.int().default(0),
  publishedAt: t.datetime().name("published_at"),
  authorId:    t.int().nullable().name("author_id"),
  author:      t.manyToOne(() => Author, { joinColumn: "author_id" }),
});

export type Author = InferEntity<typeof Author>; // { id: number; name: string; posts?: Post[] }
export type Post = InferEntity<typeof Post>;      // { id; title; views; publishedAt; authorId: number | null; author? }
```

<details>
<summary>Prefer decorators? The identical model with <code>@Entity</code> / <code>@Column</code></summary>

```typescript
import "reflect-metadata";
import {
  Entity, PrimaryGeneratedColumn, Column,
  ManyToOne, OneToMany, RelationColumn,
} from "@stingerloom/orm";

@Entity()
class Author {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
  @OneToMany(() => Post, p => p.author) posts!: Post[];
}

@Entity()
class Post {
  @PrimaryGeneratedColumn() id!: number;
  @Column() title!: string;
  @Column({ type: "int" }) views!: number;
  @Column({ type: "datetime" }) publishedAt!: Date;

  @ManyToOne(() => Author, a => a.posts)
  @RelationColumn({ name: "author_id" })
  author!: Author;
  authorId?: number;
}
```

Both styles register identical metadata and interoperate in the same project.
</details>

### 2. Connect — same API across MySQL, PostgreSQL, and SQLite

```typescript
import { EntityManager, bufferPlugin } from "@stingerloom/orm";

const em = new EntityManager();
await em.register({
  type: "postgres",          // or "mysql" / "sqlite" — query code stays identical
  host: "localhost", port: 5432,
  username: "postgres", password: "postgres", database: "app",
  entities: [Author, Post],
  synchronize: true,         // disable in production; use migrations instead
});

em.extend(bufferPlugin());   // enable Identity Map + dirty checking
```

### 3. Typed QueryDSL with JOIN — IDE autocomplete, no codegen, no string columns

```typescript
import { qAlias } from "@stingerloom/orm";

const p = qAlias(Post, "p");
const a = qAlias(Author, "a");

const trending = await em.createQueryBuilder(p)
  .innerJoinRelation("author", "a")    // FK derived from relation metadata — no ON clause needed
  .select([
    p.title.as("title"),
    a.name.as("author"),
    p.views.as("views"),
    p.publishedAt.year().as("yr"),
  ])
  .where(p.title.containsIgnoreCase("typescript"))
  .andWhere(p.views.gt(100))
  .andWhere(a.name.startsWith("J"))
  .orderBy(p.views.desc())
  .getRawMany();
```

Every reference to `p.title`, `a.name`, `p.publishedAt.year()`, etc. is resolved against the entity at compile time — typo a column name and TypeScript fails the build. `innerJoinRelation` reads the FK from the relation metadata so you never write the join condition by hand.

### 4. Unit of Work — Identity Map + dirty checking

```typescript
const buf = em.buffer();

const p1 = await buf.findOne(Post, { where: { id: 1 } });
const p2 = await buf.findOne(Post, { where: { id: 1 } });
console.log(p1 === p2);   // true — second lookup hits the Identity Map, no extra SELECT

p1!.views = 500;
await buf.flush();        // BEGIN → single UPDATE with only the dirty column → COMMIT
```

### 5. Multi-tenancy — `AsyncLocalStorage`-scoped, zero leakage

```typescript
import { MetadataContext } from "@stingerloom/orm";

await MetadataContext.run("tenant_a", async () => {
  const posts = await em.find(Post);
  // every metadata lookup inside this frame resolves through tenant_a's
  // overlay layer first, then falls through to the public layer
});
```

A NestJS interceptor or Express middleware wraps the per-request handler in `MetadataContext.run(tenantId, …)` — concurrent requests for different tenants stay isolated by AsyncLocalStorage with no shared mutable state.

> See the [Getting Started guide](https://biud436.github.io/stingerloom-orm/getting-started) for full setup, and the [`nestjs-multitenant`](./examples/nestjs-multitenant) / [`nestjs-linear-clone`](./examples/nestjs-linear-clone) examples for production-shaped tenant wiring.

## Features

| Category | Highlights |
|----------|------------|
| **Modeling** | Code-first `defineEntity` + `t` builders with `InferEntity` type inference (or `@Entity`, `@Column`, `@ManyToOne`, `@OneToMany`, `@ManyToMany`, `@OneToOne`), eager/lazy loading, inheritance mapping (STI / TPT / TPC), UUID columns with UUIDv7 |
| **Querying** | `find`, `findOne`, `findWithCursor`, `findAndCount`, SelectQueryBuilder with JOIN / GROUP BY / HAVING; `qAlias()` typed expression chain — string / numeric / math helpers, CAST, date arithmetic + components, window functions, `CASE WHEN`, subquery operators, JSON-path navigation, raw SQL escape hatches |
| **Mutations** | `save`, `update`, `delete`, `softDelete`, `restore`, `upsert`, `batchUpsert`, `streamBatch`, batch operations |
| **Transactions** | `@Transactional` decorator, manual BEGIN / COMMIT / ROLLBACK, savepoints, isolation levels, deadlock retry, `NOWAIT` / `SKIP LOCKED` |
| **Unit of Work** | `em.extend(bufferPlugin())` — Identity Map, dirty checking, cascade, batch flush, lazy proxies, pessimistic locking, `@Version` optimistic locking |
| **Multi-tenancy** | Layered metadata (OverlayFS model), `MetadataContext.run()`, PostgreSQL schema isolation, `TenantMigrationRunner` |
| **Migrations** | `SchemaDiff` auto-detection (column rename heuristic), `MigrationGenerator`, CLI runner (`npx stingerloom migrate:run \| rollback \| status \| generate`) |
| **Observability** | N+1 detection, slow query warnings, `EXPLAIN` analysis, `EntitySubscriber` events, query listeners |
| **Validation** | `@NotNull`, `@MinLength`, `@MaxLength`, `@Min`, `@Max`, Zod / Valibot schemas via `qb.selectSchema(schema)` |
| **Schema definition** | Decorators or decorator-free `EntitySchema`; Prisma schema import |
| **Infrastructure** | Connection pooling, read replicas, retry with backoff, per-query timeout, graceful shutdown, SSL/TLS, AsyncIterable streaming (`stream()`), MariaDB native UUID + `INSERT … RETURNING` |
| **NestJS** | `StingerloomOrmModule.forRoot / forFeature`, `@InjectRepository`, `@InjectEntityManager`, multi-DB named connections |

## Database Support

|                             | MySQL / MariaDB | PostgreSQL       | SQLite |
| --------------------------- | :-------------: | :--------------: | :----: |
| CRUD                        | ✓               | ✓                | ✓      |
| Transactions                | ✓               | ✓                | ✓      |
| Schema Sync                 | ✓               | ✓                | ✓      |
| Migrations                  | ✓               | ✓                | ✓      |
| ENUM                        | ✓               | ✓ (native + sync)| —      |
| JSON path queries           | ✓               | ✓ (`jsonb`)      | ✓      |
| Full-text search            | ✓               | ✓                | —      |
| Window functions            | ✓               | ✓                | ✓      |
| Schema Isolation            | —               | ✓                | —      |
| Read Replica                | ✓               | ✓                | —      |
| `INSERT … RETURNING`        | MariaDB 10.5+   | ✓                | ✓      |
| Native UUID storage         | MariaDB 10.7+   | ✓                | — (TEXT)|
| SSL / TLS                   | ✓               | ✓                | —      |

## Examples

Example projects are included in [`examples/`](./examples). They depend on the
ORM via `workspace:*`, so use pnpm and build the ORM first:

```bash
pnpm build                  # from the repository root
cd examples/nestjs-todo     # or any other example
pnpm install
pnpm start
```

| Project | Description |
|---------|-------------|
| [vanilla-todo-sqlite](./examples/vanilla-todo-sqlite) | Code-first `defineEntity` in a plain script — no NestJS, no decorators, SQLite in-memory |
| [nestjs-cats](./examples/nestjs-cats) | CRUD, relations, soft delete, cursor pagination, `EntitySubscriber` |
| [nestjs-blog](./examples/nestjs-blog) | ManyToMany, upsert, 59 e2e tests (Users / Posts / Tags / Categories) |
| [nestjs-linear-clone](./examples/nestjs-linear-clone) | Linear/Jira-style issue tracker — production-grade SQL patterns (CTEs, window functions, complex queries) |
| [nestjs-todo](./examples/nestjs-todo) | Minimal CRUD — bare-minimum entity + repository setup |
| [nestjs-todo-sqlite](./examples/nestjs-todo-sqlite) | Minimal CRUD on SQLite via `better-sqlite3` |
| [nestjs-multitenant](./examples/nestjs-multitenant) | PostgreSQL schema-based tenant isolation with `TenantMigrationRunner` |
| [prisma-import-demo](./examples/prisma-import-demo) | Generate Stingerloom entities from an existing Prisma schema |

## Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.

## License

[MIT](./LICENSE)
