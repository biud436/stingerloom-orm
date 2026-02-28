# Stingerloom ORM

A lightweight TypeScript ORM built on decorators. Define entity classes and get automatic table creation, CRUD, relation mapping, and transactions.

```typescript
@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Column()
  email!: string;
}

const em = new EntityManager();
await em.register({ type: "postgres", /* ... */ entities: [User], synchronize: true });

const user = await em.save(User, { name: "Alice", email: "alice@example.com" });
const users = await em.find(User, { where: { name: "Alice" } });
```

## Features

- **Decorator-based entities** — `@Entity`, `@Column`, `@ManyToOne`, `@OneToMany`, `@ManyToMany`, `@OneToOne`
- **Multi-database** — PostgreSQL, MySQL/MariaDB, SQLite, MSSQL
- **Relations** — Eager/Lazy loading, Cascade, bidirectional mapping
- **Transactions** — `@Transactional()` decorator with isolation levels and savepoints
- **Migrations** — MigrationRunner, CLI, and automatic Schema Diff generation
- **Multi-tenancy** — Layered metadata with PostgreSQL schema isolation

## Documentation

Full documentation is available in Korean at **[docs/](./docs/README.md)**.

| Order | Doc | What you'll learn |
|-------|-----|-------------------|
| 1 | [Getting Started](./docs/getting-started.md) | Installation, first entity, first CRUD |
| 2 | [Entities](./docs/entities.md) | Columns, indexes, Soft Delete, lifecycle hooks |
| 3 | [Relations](./docs/relations.md) | ManyToOne, OneToMany, ManyToMany |
| 4 | [EntityManager](./docs/entity-manager.md) | find, save, delete, aggregates, pagination |

Advanced topics:

| Doc | When you need it |
|-----|-----------------|
| [Query Builder](./docs/query-builder.md) | JOIN, GROUP BY, subqueries |
| [Transactions](./docs/transactions.md) | Grouping multiple operations atomically |
| [Migrations](./docs/migrations.md) | Managing production schema changes |
| [Configuration](./docs/configuration.md) | Pooling, timeouts, Read Replica |
| [Advanced](./docs/advanced.md) | Event subscribers, N+1 detection, cursor pagination |
| [Multi-tenancy](./docs/multi-tenancy.md) | Tenant data isolation |
| [API Reference](./docs/api-reference.md) | Method signatures at a glance |

## Quick Start

```bash
pnpm add @stingerloom/orm reflect-metadata

# Install the driver for your database:
pnpm add pg            # PostgreSQL
pnpm add mysql2        # MySQL / MariaDB
pnpm add better-sqlite3  # SQLite
pnpm add mssql         # MSSQL
```

```typescript
import "reflect-metadata";
import { EntityManager } from "@stingerloom/orm";

const em = new EntityManager();
await em.register({
  type: "postgres",
  host: "localhost",
  port: 5432,
  username: "postgres",
  password: "password",
  database: "mydb",
  entities: [User],
  synchronize: true,
});

// Create
const user = await em.save(User, { name: "Alice", email: "alice@example.com" });

// Read
const found = await em.findOne(User, { where: { id: 1 } });

// Update
await em.save(User, { id: 1, name: "Updated" });

// Delete
await em.delete(User, { id: 1 });
```

> See the [Getting Started](./docs/getting-started.md) guide for a full walkthrough.

## Examples

| Example | Description |
|---------|-------------|
| [nestjs-cats](./examples/nestjs-cats/) | Basic NestJS CRUD, EntitySubscriber, cursor pagination |
| [nestjs-blog](./examples/nestjs-blog/) | ManyToMany, Soft Delete, Upsert, 59 e2e tests |
| [nestjs-multitenant](./examples/nestjs-multitenant/) | PostgreSQL schema-based multi-tenancy |

## Supported Databases

| DB | Status |
|----|--------|
| PostgreSQL | Full support (schema isolation, ENUM, RETURNING) |
| MySQL / MariaDB | Full support |
| SQLite | Supported (file-based, no pooling) |
| MSSQL | Supported |

## Development

```bash
pnpm install
pnpm build
pnpm test         # 1,405 tests
```

## Publishing to npm

### Prerequisites

1. Create an npm account at [npmjs.com](https://www.npmjs.com/) if you don't have one.
2. Create the `@stingerloom` organization on npm (Settings > Organizations > Add Organization).
3. Log in to npm from your terminal:

```bash
npm login
```

### Publish

```bash
# 1. Run tests to make sure everything passes
pnpm test

# 2. Build (also runs automatically via prepublishOnly)
pnpm build

# 3. Preview what will be included in the package
npm pack --dry-run

# 4. Publish
npm publish --access public
```

> `publishConfig.access` is already set to `"public"` in package.json, so `--access public` is optional after the first publish.

### Version Bumps

```bash
# Patch release (0.1.0 → 0.1.1) — bug fixes
npm version patch

# Minor release (0.1.0 → 0.2.0) — new features, backward-compatible
npm version minor

# Major release (0.1.0 → 1.0.0) — breaking changes
npm version major

# Then publish
npm publish
```

### What Gets Published

Only the following files are included in the package (controlled by the `files` field in package.json):

| Path | Contents |
|------|----------|
| `dist/` | Compiled JS + type declarations |
| `LICENSE` | MIT license |
| `README.md` | This file |

Source code, tests, examples, docs, and config files are **excluded**.

## License

MIT
