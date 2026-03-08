# Stingerloom ORM

**Stingerloom ORM** is a lightweight ORM that uses TypeScript decorators to work with databases. Define entity classes and it automatically handles table creation, CRUD, relation mapping, and transactions.

```typescript
// user.entity.ts
import { Entity, PrimaryGeneratedColumn, Column } from "@stingerloom/orm";

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Column()
  email!: string;
}
```

```typescript
// main.ts
const em = new EntityManager();
await em.register({ type: "postgres", /* ... */ entities: [User], synchronize: true });

// Create
const user = await em.save(User, { name: "John Doe", email: "john@example.com" });

// Read
const users = await em.find(User, { where: { name: "John Doe" } });
```

That's all there is to Stingerloom ORM. Define your classes, connect, and use.

## Contributor/Developer?

If you want to contribute to the project or understand the internal architecture, please read the **[Contributor Onboarding Guide](./onboarding.md)**. It covers local environment setup, architecture overview, code flow, and how to add new features.

## Where to Start?

If your goal is to use the ORM, start with the **Getting Started** guide. You can complete your first CRUD in 5 minutes.

| Order | Document | What You'll Learn |
|-------|----------|-------------------|
| 1 | [Getting Started](./getting-started.md) | Installation, first entity, first CRUD |
| 2 | [Entities](./entities.md) | Columns, indexes, lifecycle hooks, validation |
| 3 | [Relations](./relations.md) | ManyToOne, OneToMany, ManyToMany |
| 4 | [EntityManager](./entity-manager.md) | find, save, delete, aggregation, pagination |

## Going Deeper

Once you've learned the basics, pick the topics you need.

| Document | When Do You Need It? |
|----------|---------------------|
| [Query Builder](./query-builder.md) | When you need complex SQL like JOIN, GROUP BY, subqueries |
| [Transactions](./transactions.md) | When you need to group multiple operations into a single unit |
| [Migrations](./migrations.md) | When you need to safely change schema in production |
| [Configuration Guide](./configuration.md) | When configuring pooling, timeouts, Read Replica, etc. |
| [Advanced Features](./advanced.md) | When you need performance optimization, event subscription, N+1 detection |
| [Multi-Tenancy](./multi-tenancy.md) | When isolating multiple customer data in a single app |
| [API Reference](./api-reference.md) | When you need to quickly check method signatures |

## Supported Databases

| DB | Status |
|----|--------|
| PostgreSQL | Full support (schema isolation, ENUM, RETURNING) |
| MySQL / MariaDB | Full support |
| SQLite | Supported (file-based, no pooling) |

## Installation

```bash
pnpm add @stingerloom/orm reflect-metadata
```

> **Hint** `reflect-metadata` is required for decorator metadata. Add `import "reflect-metadata"` at the very top of your application entry point.
