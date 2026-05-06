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

Your `tsconfig.json` must enable decorator metadata:

```jsonc
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

```typescript
import "reflect-metadata";
import {
  EntityManager, Entity, PrimaryGeneratedColumn, Column, qAlias,
} from "@stingerloom/orm";

@Entity()
class Post {
  @PrimaryGeneratedColumn() id!: number;
  @Column() title!: string;
  @Column({ type: "int" }) views!: number;
  @Column({ type: "datetime" }) publishedAt!: Date;
}

const em = new EntityManager();
await em.register({
  type: "postgres",
  host: "localhost",
  port: 5432,
  username: "postgres",
  password: "postgres",
  database: "app",
  entities: [Post],
  synchronize: true, // disable in production
});

// CRUD
const post = await em.save(Post, { title: "Hello World", views: 0, publishedAt: new Date() });
const found = await em.findOne(Post, { where: { id: post.id } });

// Typed QueryDSL — IDE autocomplete on every column
const p = qAlias(Post, "p");

const trending = await em.createQueryBuilder(Post, "p")
  .select([
    p.title.as("title"),
    p.views.as("views"),
    p.publishedAt.year().as("yr"),
  ])
  .where(p.title.containsIgnoreCase("typescript"))
  .andWhere(p.views.gt(100))
  .orderBy(p.views.desc())
  .getRawMany();
```

> See the [Getting Started guide](https://biud436.github.io/stingerloom-orm/getting-started) for full setup instructions.

## Features

| Category | Highlights |
|----------|------------|
| **Modeling** | `@Entity`, `@Column`, `@ManyToOne`, `@OneToMany`, `@ManyToMany`, `@OneToOne`, eager/lazy loading, inheritance mapping (STI / TPT / TPC), UUID columns with UUIDv7 |
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

Example projects are included in [`examples/`](./examples):

| Project | Description |
|---------|-------------|
| [nestjs-cats](./examples/nestjs-cats) | CRUD, relations, soft delete, cursor pagination, `EntitySubscriber` |
| [nestjs-blog](./examples/nestjs-blog) | ManyToMany, upsert, 59 e2e tests (Users / Posts / Tags / Categories) |
| [nestjs-todo](./examples/nestjs-todo) | Minimal CRUD — uses the published npm package |
| [nestjs-todo-sqlite](./examples/nestjs-todo-sqlite) | Minimal CRUD on SQLite via `better-sqlite3` |
| [nestjs-multitenant](./examples/nestjs-multitenant) | PostgreSQL schema-based tenant isolation with `TenantMigrationRunner` |
| [prisma-import-demo](./examples/prisma-import-demo) | Generate Stingerloom entities from an existing Prisma schema |

## Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.

## License

[MIT](./LICENSE)
