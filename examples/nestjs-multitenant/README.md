# NestJS Multi-Tenant API — Stingerloom ORM Example

A multi-tenant REST API built with NestJS demonstrating Stingerloom ORM's **Layered Metadata System** and **AsyncLocalStorage**-based automatic tenant context.

## Features

- **Automatic Tenant Context** — `TenantMiddleware` reads the `x-tenant-id` header and sets the AsyncLocalStorage context automatically
- **TenantModule.forRoot()** — Configure middleware routes, header name, and default tenant
- **TenantContext** — Injectable service to query current tenant information
- **@Tenant() Decorator** — Extract current tenant ID from controller parameters
- **Service Automation** — Middleware handles context; no manual `em.withTenant()` calls needed
- **CRUD** — Users, Posts (isolated per tenant)
- **Relations** — ManyToOne (Post→User, eager loading)

## Architecture

```
HTTP Request (x-tenant-id: tenant_a)
       ↓
  TenantMiddleware
       ↓  MetadataContext.run("tenant_a", () => next())
       ↓
  AsyncLocalStorage context activated
       ↓
  Controller (no tenantId parameter needed)
       ↓
  Service (no em.withTenant() wrapper needed)
       ↓
  EntityManager → MetadataLayerRegistry
       ↓  MetadataContext.getCurrentTenant() → "tenant_a"
       ↓
  Tenant layer-based metadata lookup
```

### TenantModule Configuration

```typescript
// Apply to specific controllers only
TenantModule.forRoot({
  headerName: "x-tenant-id",     // default
  defaultTenant: "public",       // default
  routes: [UsersController, PostsController],
})

// Apply to all routes
TenantModule.forRoot()

// Custom header name
TenantModule.forRoot({ headerName: "x-org-id" })
```

### Service Code Comparison

**Before (manual)**
```typescript
async create(tenantId: string, dto: CreateUserDto) {
  return this.em.withTenant(tenantId, async (em) => {
    const user = new User();
    user.username = dto.username;
    const result = await em.save(User, user);
    return Array.isArray(result) ? result[0] : result;
  });
}
```

**After (automatic)**
```typescript
async create(dto: CreateUserDto) {
  const user = new User();
  user.username = dto.username;
  const result = await this.em.save(User, user);
  return Array.isArray(result) ? result[0] : result;
}
```

## Prerequisites

- Node.js 18+
- pnpm
- PostgreSQL

## Installation & Running

```bash
# 1. Build ORM (from root directory)
cd /path/to/stingerloom-orm
pnpm build

# 2. Install dependencies
cd examples/nestjs-multitenant
pnpm install

# 3. Configure environment variables (edit .env file)
#    DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME

# 4. Start server
pnpm start        # or pnpm start:dev (watch mode)
```

Once started, the API is accessible at `http://localhost:3000`.

## API Endpoints

### Tenant (`/tenant`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/tenant/current` | Get current tenant info (`{ tenant, isActive }`) |

### Users (`/users`)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/users` | Create user |
| GET | `/users` | List all |
| GET | `/users/:id` | Get by ID |
| PATCH | `/users/:id` | Update |
| DELETE | `/users/:id` | Delete |

### Posts (`/posts`)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/posts` | Create post |
| GET | `/posts` | List all |
| GET | `/posts/:id` | Get by ID |
| PATCH | `/posts/:id` | Update |
| DELETE | `/posts/:id` | Delete |

### Usage Examples

```bash
# Create user in tenant_a
curl -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: tenant_a" \
  -d '{"username": "alice", "email": "alice@example.com"}'

# Create user in tenant_b
curl -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: tenant_b" \
  -d '{"username": "bob", "email": "bob@example.com"}'

# List only tenant_a users
curl -H "x-tenant-id: tenant_a" http://localhost:3000/users

# Check current tenant
curl -H "x-tenant-id: tenant_a" http://localhost:3000/tenant/current
# → { "tenant": "tenant_a", "isActive": true }

# Request without header (public tenant)
curl http://localhost:3000/tenant/current
# → { "tenant": "public", "isActive": true }
```

## Testing

### Running E2E Integration Tests

Requires a real PostgreSQL database connection. Set the `INTEGRATION_TEST=true` environment variable.

```bash
# Build ORM (if not already done)
cd /path/to/stingerloom-orm
pnpm build

# Run tests
cd examples/nestjs-multitenant
INTEGRATION_TEST=true pnpm test:e2e
```

All tests are skipped if `INTEGRATION_TEST` is not set.

### Test Coverage (26 tests)

| Area | Tests | Description |
|------|-------|-------------|
| Tenant Context | 3 | public/tenant_a/tenant_b context validation |
| Tenant A Users | 3 | Create, list, get by ID |
| Tenant B Users | 2 | Create, list |
| Public Tenant Users | 2 | Create, list |
| Cross-Tenant Isolation | 3 | Data isolation between tenants |
| Tenant A Posts | 4 | Create, list, get by ID, update |
| User Update | 1 | Update tenant_a user |
| Middleware Auto Context | 2 | Works without withTenant(), default tenant |
| Error Handling | 2 | 404 responses (Users, Posts) |
| Cleanup | 4 | Test data cleanup |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_HOST` | `localhost` | Database host |
| `DB_PORT` | `5432` | Database port |
| `DB_USER` | `postgres` | Database user |
| `DB_PASSWORD` | `postgres` | Database password |
| `DB_NAME` | `multi_tenancy_db` | Database name |
| `PORT` | `3000` | Application port |
| `INTEGRATION_TEST` | — | Set to `true` to enable e2e tests |
