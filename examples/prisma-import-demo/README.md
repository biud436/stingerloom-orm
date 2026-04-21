# Prisma Import Demo (E-commerce)

NestJS E-commerce API demonstrating the **Prisma schema → Stingerloom ORM entity** import workflow.

## How it works

1. Define your data model in `prisma/schema.prisma` (standard Prisma format)
2. Run `pnpm generate` to convert the Prisma schema into Stingerloom ORM entity classes
3. Generated entities appear in `src/generated/` with full decorator support
4. Use them in NestJS modules with `StingerloomOrmModule.forFeature([...])` as usual

## Quick start

```bash
# 1. Build the ORM (from repo root)
cd ../..
pnpm build

# 2. Install dependencies
cd examples/prisma-import-demo
pnpm install

# 3. (Re)generate entities from Prisma schema
pnpm generate

# 4. Start the server (requires MySQL with ecommerce_db)
pnpm start
```

## Prerequisites

`@mrleebo/prisma-ast` is an **optional peer dependency** of `@stingerloom/orm`. It is only needed for the `generate` command (Prisma schema parsing). This example includes it in `dependencies` so `pnpm generate` works out of the box.

If you're setting up prisma-import in your own project:

```bash
pnpm add @mrleebo/prisma-ast
```

## Generate command

```bash
pnpm generate
# Runs: node ../../dist/integration/prisma-import/cli.js \
#   --schema ./prisma/schema.prisma \
#   --output ./src/generated \
#   --force
```

This reads `prisma/schema.prisma` and outputs:

| File | Description |
|------|-------------|
| `category.enum.ts` | Category enum (ELECTRONICS, CLOTHING, ...) |
| `order_status.enum.ts` | OrderStatus enum (PENDING, CONFIRMED, ...) |
| `customer.entity.ts` | Customer entity with @OneToMany orders |
| `product.entity.ts` | Product entity with enum category, nullable description |
| `order.entity.ts` | Order entity with @ManyToOne customer, @OneToMany items |
| `order_item.entity.ts` | OrderItem entity with @@unique composite index |
| `index.ts` | Barrel re-export |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Health check |
| POST | `/customers` | Create a customer |
| GET | `/customers` | List all customers |
| GET | `/customers/:id` | Get customer (with orders) |
| DELETE | `/customers/:id` | Delete a customer |
| POST | `/products` | Create a product |
| GET | `/products` | List all products |
| GET | `/products/:id` | Get a product |
| DELETE | `/products/:id` | Delete a product |
| POST | `/orders` | Create an order with items |
| GET | `/orders` | List all orders |
| GET | `/orders/:id` | Get order (with customer & items) |
| DELETE | `/orders/:id` | Delete an order |

Swagger UI: `http://localhost:3000/api-docs`

## E2E Tests

```bash
INTEGRATION_TEST=true pnpm test:e2e
```

Requires a running MySQL database with `ecommerce_db`.
