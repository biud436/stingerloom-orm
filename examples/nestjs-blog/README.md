# NestJS Blog API — Stingerloom ORM Example

A blog REST API built with NestJS demonstrating key Stingerloom ORM features.

## Features

- **CRUD** — Users, Posts, Tags, Categories
- **Relations** — ManyToOne (Post→User, Post→Category), OneToMany, ManyToMany (Post↔Tag)
- **Soft Delete / Restore** — `@DeletedAt` decorator
- **Upsert** — INSERT ON CONFLICT UPDATE by slug/name
- **Pagination** — Offset-based (`findAndCount`) + Cursor-based (`findWithCursor`)
- **EXPLAIN** — Query execution plan inspection
- **Schema Diff** — Entity vs DB schema comparison + Migration generation
- **GROUP BY / HAVING** — Aggregate queries via RawQueryBuilder
- **Transactions** — `@Transactional()` decorator

## Prerequisites

- Node.js 18+
- pnpm
- MySQL (default) or PostgreSQL

## Installation & Running

```bash
# 1. Build ORM (from root directory)
cd /path/to/stingerloom-orm
pnpm build

# 2. Install dependencies
cd examples/nestjs-blog
pnpm install

# 3. Configure environment variables (edit .env file)
#    DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME

# 4. Start server
pnpm start        # or pnpm start:dev (watch mode)
```

Once started, the API is accessible at `http://localhost:3000`.

## API Endpoints

### Users (`/users`)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/users` | Create user |
| GET | `/users` | List all |
| GET | `/users/:id` | Get by ID |
| PATCH | `/users/:id` | Update |
| DELETE | `/users/:id` | Delete |
| GET | `/users/count` | Total count |
| GET | `/users/paginated?page=1&limit=10` | Pagination |

### Posts (`/posts`)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/posts` | Create post |
| GET | `/posts` | List all (cached 5s) |
| GET | `/posts/all` | List all (including soft-deleted) |
| GET | `/posts/:id` | Get by ID |
| PATCH | `/posts/:id` | Update |
| DELETE | `/posts/:id` | Hard delete |
| PATCH | `/posts/:id/soft-delete` | Soft delete |
| PATCH | `/posts/:id/restore` | Restore |
| POST | `/posts/upsert` | Upsert (by slug) |
| GET | `/posts/paginated?page=1&limit=10` | Offset pagination |
| GET | `/posts/cursor?take=10&cursor=xxx` | Cursor pagination |
| GET | `/posts/:id/explain` | EXPLAIN query |
| GET | `/posts/:id/tags` | List post tags |
| POST | `/posts/:id/tags` | Add tag to post (`{ tagId }`) |
| DELETE | `/posts/:id/tags/:tagId` | Remove tag from post |

### Tags (`/tags`)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/tags` | Create tag |
| GET | `/tags` | List all |
| GET | `/tags/:id` | Get by ID |
| DELETE | `/tags/:id` | Delete |
| GET | `/tags/count` | Total count |
| POST | `/tags/upsert` | Upsert (by name) |
| GET | `/tags/paginated?page=1&limit=10` | Pagination |

### Categories (`/categories`)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/categories` | Create category |
| GET | `/categories` | List all |
| GET | `/categories/:id` | Get by ID |
| PATCH | `/categories/:id` | Update |
| DELETE | `/categories/:id` | Delete |
| GET | `/categories/count` | Total count |
| GET | `/categories/stats` | Posts per category (GROUP BY + HAVING) |

## Testing

### Running E2E Integration Tests

Requires a real MySQL database connection. Set the `INTEGRATION_TEST=true` environment variable.

```bash
# Build ORM (if not already done)
cd /path/to/stingerloom-orm
pnpm build

# Run tests
cd examples/nestjs-blog
INTEGRATION_TEST=true pnpm test
```

All tests are skipped if `INTEGRATION_TEST` is not set.

### Test Coverage (59 tests)

| Area | Tests | Description |
|------|-------|-------------|
| App Root | 2 | Health check, Schema Diff |
| Users CRUD | 8 | Create, list, update, delete, count, pagination, 404 |
| Categories CRUD | 7 | Create, list, update, delete, count, 404 |
| Tags CRUD | 8 | Create, list, delete, count, pagination, upsert, 404 |
| Posts CRUD | 8 | Create, list, update, delete, pagination, cursor, 404 |
| Soft Delete | 5 | Soft-delete, list filtering, withDeleted, restore |
| Upsert | 1 | Upsert by slug (duplicate run) |
| ManyToMany Tags | 5 | Add tag, list tags, remove tag |
| Stats / Explain / Schema | 4 | GROUP BY+HAVING, EXPLAIN, Schema Diff, Migration |
| Cleanup | 11 | Clean up created data (hard delete) |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_HOST` | `localhost` | Database host |
| `DB_PORT` | `3306` | Database port |
| `DB_USER` | `root` | Database user |
| `DB_PASSWORD` | `password` | Database password |
| `DB_NAME` | `blog_db` | Database name |
| `PORT` | `3000` | Application port |
| `INTEGRATION_TEST` | — | Set to `true` to enable e2e tests |
