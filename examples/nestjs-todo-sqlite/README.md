# NestJS Todo (SQLite) — Stingerloom ORM Example

A minimal NestJS Todo API showcasing Stingerloom ORM running on SQLite via
`better-sqlite3`. Because the database is a single file, this example needs
no external server — clone, install, run.

## Why this example?

- **No DB server.** SQLite runs in-process — perfect for first-time setup,
  CI smoke tests, or learning the ORM without provisioning anything.
- **Soft delete on a tiny surface.** The `Todo` entity uses `@DeletedAt` so
  you can see how `delete()` produces a 404 on subsequent reads without
  having to wire up a full blog domain.
- **Same NestJS module wiring as the other examples.** Drop `type: 'sqlite'`
  in front of any `nestjs-todo` config and you have a runnable app.

## Prerequisites

- Node.js 18+
- pnpm

> The peer dep `better-sqlite3` is installed automatically via this example's
> `package.json`. The root ORM build is **not** required when consuming the
> published `@stingerloom/orm` package; it **is** required when developing
> against the workspace (which is how this example is wired by default).

## Quick Start

```bash
# 1. Build the ORM (only needed when running from the monorepo)
cd /path/to/stingerloom-orm
pnpm build

# 2. Install + start
cd examples/nestjs-todo-sqlite
pnpm install
pnpm start         # or pnpm start:dev for watch mode
```

The API is now live at `http://localhost:3000`. A SQLite file (`todo.db` by
default) is created next to the process working directory.

## Endpoints

`Todo` schema: `id` (auto), `title`, `description?`, `completed` (default
`false`), `createdAt`, `updatedAt`, `deletedAt` (soft-delete sentinel).

| Method | Path | Description |
|--------|------|-------------|
| POST | `/todos` | Create a todo (`{ title, description? }`) |
| GET | `/todos` | List todos (excludes soft-deleted) |
| GET | `/todos/:id` | Get one — 404 if absent or soft-deleted |
| PATCH | `/todos/:id` | Update fields (e.g. `{ completed: true }`) |
| DELETE | `/todos/:id` | **Soft** delete — subsequent `GET` returns 404 |

## Configuration

The app reads a single env var:

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_PATH` | `todo.db` | Path to the SQLite file (relative or absolute) |

In-memory mode is also supported by setting `DB_PATH=:memory:`. Each process
restart will start with an empty database.

## Tests

E2E tests are in `test/app.e2e-spec.ts` and exercise the full create →
update → soft-delete → 404 flow. Because SQLite runs in-process, no
`INTEGRATION_TEST` flag is required:

```bash
pnpm test:e2e
```

## How it wires up

```ts
// src/app.module.ts
StingerloomOrmModule.forRoot({
  type: 'sqlite',
  database: process.env.DB_PATH || 'todo.db',
  entities: [Todo],
  synchronize: true,
  logging: true,
});
```

`synchronize: true` recreates the schema from `Todo` on every boot — fine
for an example, but switch to `'safe'` (or migrations) before running
against a database you care about.

## Going further

- For multi-DB support, see [examples/nestjs-multitenant](../nestjs-multitenant).
- For a richer NestJS surface (relations, M2M, upsert, cursor pagination),
  see [examples/nestjs-blog](../nestjs-blog).
- For the same Todo domain on MySQL, see [examples/nestjs-todo](../nestjs-todo).
