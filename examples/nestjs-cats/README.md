# NestJS Cats — Stingerloom ORM Example

A complete NestJS CRUD reference with the broadest feature surface across
all the examples. If `nestjs-todo` is "the smallest possible NestJS app",
this is "all the wiring you'll see in real projects, in one place".

## Features

- **Entities** — `Cat`, `Owner` with `@ManyToOne(Cat → Owner, eager)` and `@OneToMany`
- **EntitySubscriber** — `cat.subscriber.ts` demonstrates the lifecycle pattern
- **`bufferPlugin()`** — Identity Map, dirty checking, mixed flush, dry-run preview
- **Soft delete + restore** via `@DeletedAt`
- **Cursor pagination** (`findWithCursor`)
- **Aggregate queries** (`count` / `avg` / `min` / `max` / `sum`)
- **Bulk insert / delete** (`insertMany` / `deleteMany`)
- **Swagger** docs at `/api`

## Prerequisites

- Node.js 18+
- pnpm
- MySQL 8+

## Quick Start

```bash
# 1. Build the ORM (only needed when running from the monorepo)
cd /path/to/stingerloom-orm
pnpm build

# 2. Install + start
cd examples/nestjs-cats
pnpm install
pnpm start         # or pnpm start:dev for watch mode
```

The API is now live at `http://localhost:3000`. Swagger UI: `http://localhost:3000/api`.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_HOST` | `localhost` | MySQL host |
| `DB_PORT` | `3306` | MySQL port |
| `DB_USER` | `root` | MySQL user |
| `DB_PASSWORD` | `password` | MySQL password |
| `DB_NAME` | `cats_db` | Database name (must exist) |

Create the database before starting the app:

```sql
CREATE DATABASE IF NOT EXISTS cats_db;
```

## Endpoints

### Cats (`/cats`)

| Method | Path | Notes |
|--------|------|-------|
| POST | `/cats` | Create — `@Transactional`, `@BeforeInsert` |
| POST | `/cats/bulk` | Batch insert (`insertMany`) |
| GET | `/cats` | List (excludes soft-deleted) |
| GET | `/cats/all` | List incl. soft-deleted (`withDeleted`) |
| GET | `/cats/cursor` | Cursor pagination (`take`, `cursor`) |
| GET | `/cats/stats` | Aggregate query (count/avg/min/max/sum) |
| GET | `/cats/:id` | Find one — owner eager-loaded |
| PATCH | `/cats/:id` | Update — `@Transactional`, `@BeforeUpdate` |
| PATCH | `/cats/:id/soft-delete` | Soft delete |
| PATCH | `/cats/:id/restore` | Restore from soft delete |
| DELETE | `/cats/:id` | Hard delete |
| DELETE | `/cats/clear` | Truncate cats table |
| DELETE | `/cats/bulk` | Batch delete by ID array |
| PATCH | `/cats/buffer/rename` | Buffer plugin: dirty-check rename |
| POST | `/cats/buffer/mixed-flush` | Buffer plugin: create+update+delete in one tx |
| POST | `/cats/buffer/birthday` | Buffer plugin: increment all ages by breed |
| POST | `/cats/buffer/preview-breed-rename` | Buffer plugin: dry-run preview |
| GET | `/cats/buffer/identity-map/:id` | Buffer plugin: identity-map verification |
| GET | `/cats/buffer/entity-state/:id` | Buffer plugin: entity state transitions |

### Owners (`/owners`)

| Method | Path | Notes |
|--------|------|-------|
| POST | `/owners` | Create — `@Transactional`, `@BeforeInsert` |
| GET | `/owners` | List (`@OneToMany` cats relation) |
| GET | `/owners/count` | Aggregate count |
| GET | `/owners/:id` | Find one |
| DELETE | `/owners/:id` | Delete |

## Tests

E2E tests live under `test/`. They hit a real MySQL instance, so set the
`INTEGRATION_TEST=true` flag explicitly:

```bash
# Build the ORM if you haven't already
cd /path/to/stingerloom-orm
pnpm build

cd examples/nestjs-cats
INTEGRATION_TEST=true pnpm test:e2e
```

Without the flag, the suite is skipped to keep CI green on machines that
don't have MySQL.

## Going further

- For the smallest possible variant, see [examples/nestjs-todo](../nestjs-todo).
- For relations / soft-delete / upsert / schema-diff in one app, see
  [examples/nestjs-blog](../nestjs-blog).
- For multi-tenancy with PostgreSQL schema isolation, see
  [examples/nestjs-multitenant](../nestjs-multitenant).
