# Stingerloom ORM Examples

This directory contains example projects demonstrating how to use Stingerloom ORM with different frameworks and use cases. They are listed roughly from simplest to most advanced.

## Available Examples

| Example | Database | Highlights |
|---------|----------|-----------|
| [nestjs-todo-sqlite](./nestjs-todo-sqlite) | SQLite | No DB server — runs in-process |
| [nestjs-todo](./nestjs-todo) | MySQL | Minimal CRUD baseline |
| [nestjs-cats](./nestjs-cats) | MySQL | Full module wiring + EntitySubscriber + cursor pagination |
| [nestjs-blog](./nestjs-blog) | MySQL | Relations (M2M), upsert, soft delete, schema diff, EXPLAIN |
| [nestjs-linear-clone](./nestjs-linear-clone) | PostgreSQL | Issue tracker — production-grade SQL (CTEs, window functions, complex queries) |
| [nestjs-multitenant](./nestjs-multitenant) | PostgreSQL | Schema-per-tenant + AsyncLocalStorage middleware |
| [prisma-import-demo](./prisma-import-demo) | MySQL | Prisma schema → Stingerloom entity codegen |

## Conventions

All examples follow the same setup and script conventions:

- **pnpm workspace.** Every example depends on the ORM via `workspace:*`, so
  use pnpm (not npm/yarn) and build the ORM first: `pnpm build` at the
  repository root, then `pnpm install` inside the example.
- **Scripts.** Every example provides `build`, `start`, `start:dev`, `test`,
  and `test:e2e`. The examples ship e2e suites only, so `pnpm test` is an
  alias of `pnpm test:e2e`.
- **Jest e2e config location.** Most examples keep it at `test/jest-e2e.json`;
  `nestjs-blog`, `nestjs-linear-clone`, and `nestjs-multitenant` keep it at
  the package root as `jest-e2e.json`. The `test` / `test:e2e` scripts always
  point at the right file, so just run them.
- **Database access.** Examples other than `nestjs-todo-sqlite` need a
  reachable MySQL or PostgreSQL server (connection via env vars — see each
  example's README). Suites that hit a real server are additionally gated
  behind `INTEGRATION_TEST=true` where noted.

---

### [nestjs-todo-sqlite](./nestjs-todo-sqlite)

The fastest way to try Stingerloom ORM. SQLite runs in-process via
`better-sqlite3`, so there is no database server to install.

- **Single entity** with `@DeletedAt` soft-delete
- **`type: 'sqlite'`** wiring with `DB_PATH` env var (defaults to `todo.db`)
- E2E suite passes without `INTEGRATION_TEST=true`

**Quick Start**:

```bash
cd nestjs-todo-sqlite
pnpm install
pnpm start         # API at http://localhost:3000
```

---

### [nestjs-todo](./nestjs-todo)

Minimal MySQL CRUD example — useful as the smallest possible reference for
the NestJS module wiring.

- **`bufferPlugin()` Unit-of-Work** demonstrating Identity Map / dirty checking
- Single `Todo` entity, fewest moving parts
- Same domain as `nestjs-todo-sqlite` for easy diffing

**Quick Start**:

```bash
cd nestjs-todo
pnpm install
pnpm start:dev
```

---

### [nestjs-cats](./nestjs-cats)

The flagship "first example" — full NestJS module wiring with a slightly
richer surface than `nestjs-todo`.

- **DatabaseModule.forRoot()** pattern following the original Stingerloom framework
- Entity definitions with decorators (`@Entity`, `@Column`, `@PrimaryGeneratedColumn`)
- **EntitySubscriber** lifecycle pattern
- **Cursor pagination** via `findWithCursor`
- Repository pattern, NestJS lifecycle hooks (`OnModuleInit`, `OnModuleDestroy`),
  env var configuration with `@nestjs/config`

**Tech Stack**: NestJS, TypeScript, MySQL, Stingerloom ORM

**Quick Start**:

```bash
cd nestjs-cats
pnpm install
pnpm build
pnpm start:dev
```

---

### [NestJS Blog API](./nestjs-blog)

Advanced blog API demonstrating features not covered in nestjs-cats:

- **`@ManyToMany`** — Post ↔ Tag many-to-many relation (auto-generated join table)
- **`findAndCount()`** — Pagination with total count (`GET /posts/paginated`)
- **`upsert()`** — INSERT ON CONFLICT by slug/name (`POST /posts/upsert`, `POST /tags/upsert`)
- **`explain()`** — Query execution plan (`GET /posts/:id/explain`)
- **`SchemaDiff`** — Entity vs DB schema comparison (`GET /posts/schema-diff`)
- **`SchemaDiffMigrationGenerator`** — Auto-generate migration files (`POST /posts/schema-diff/generate`)
- **`findWithCursor()`** — Cursor-based pagination (`GET /posts/cursor`)
- **`@UniqueIndex`** — Composite unique indexes on User.email, User.username, Post.slug, Tag.name
- **`@DeletedAt`** — Soft Delete with restore endpoint
- **4 entities**: User, Post, Tag, Category (OneToMany, ManyToOne, ManyToMany relations)

**Endpoints**:
| Method | Path | Description |
|--------|------|-------------|
| GET | /posts/paginated?page=1&limit=10 | findAndCount pagination |
| GET | /posts/cursor?take=10&cursor=xxx | Cursor pagination |
| POST | /posts/upsert | Upsert by slug |
| GET | /posts/:id/explain | Query execution plan |
| GET | /posts/schema-diff | Schema diff |
| POST | /posts/schema-diff/generate | Generate migration file |
| POST | /tags/upsert | Upsert tag by name |
| GET | /tags/paginated | Tag pagination |
| GET | /users/paginated | User pagination |

**Tech Stack**: NestJS, TypeScript, MySQL, Stingerloom ORM

**Quick Start**:

```bash
cd nestjs-blog
pnpm install
pnpm build
pnpm start:dev
```

---

### [nestjs-multitenant](./nestjs-multitenant)

PostgreSQL schema-per-tenant multi-tenancy. The `TenantMiddleware` reads
`x-tenant-id` from the request header and wraps the handler in
`MetadataContext.run(tenantId, ...)`, so service code never has to thread
the tenant through manually.

- **Layered Metadata System** with AsyncLocalStorage isolation
- **`TenantMigrationRunner`** auto-provisions a new tenant schema by cloning
  `public` (`LIKE ... INCLUDING ALL`)
- **`@Tenant()` decorator** for controllers that need the current tenant ID
- 33 e2e tests across two tenants (`tenant_a`, `tenant_b`)

**Tech Stack**: NestJS, TypeScript, PostgreSQL, Stingerloom ORM

**Quick Start** (requires PostgreSQL with a `multitenant_db` database):

```bash
cd nestjs-multitenant
pnpm install
pnpm start:dev
# curl -H "x-tenant-id: tenant_a" http://localhost:3000/users
```

---

### [prisma-import-demo](./prisma-import-demo)

Showcases the `stingerloom-prisma-import` workflow: write your data model
in Prisma syntax, run a single command, and use the generated decorator
entities exactly like hand-written ones.

- **`prisma/schema.prisma` → `src/generated/*.entity.ts`** via `pnpm generate`
- **E-commerce domain**: Customer / Product / Order / OrderItem with enums
  and a composite `@@unique`
- Demonstrates how to wire the generated entities into
  `StingerloomOrmModule.forFeature([...])`

**Tech Stack**: NestJS, TypeScript, MySQL, Prisma schema, Stingerloom ORM

**Quick Start**:

```bash
cd prisma-import-demo
pnpm install
pnpm generate      # parse schema.prisma → src/generated/
pnpm start         # requires MySQL with ecommerce_db
```
