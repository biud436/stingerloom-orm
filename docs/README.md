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

If you want to contribute to the project or understand the internal architecture, please read the **[Contributor Onboarding Guide](https://biud436.github.io/stingerloom-orm/onboarding.html)**. It covers local environment setup, architecture overview, code flow, and how to add new features.

## Where to Start?

If your goal is to use the ORM, start with the **Getting Started** guide. You can complete your first CRUD in 5 minutes.

| Order | Document | What You'll Learn |
|-------|----------|-------------------|
| 1 | [Getting Started](https://biud436.github.io/stingerloom-orm/getting-started.html) | Installation, first entity, first CRUD |
| 2 | [Entities](https://biud436.github.io/stingerloom-orm/entities.html) | Columns, indexes, lifecycle hooks, validation |
| 3 | [Relations](https://biud436.github.io/stingerloom-orm/relations.html) | ManyToOne, OneToMany, ManyToMany |
| 4 | [EntityManager](https://biud436.github.io/stingerloom-orm/entity-manager.html) | find, save, delete, aggregation, pagination |

## Going Deeper

Once you've learned the basics, pick the topics you need.

| Document | When Do You Need It? |
|----------|---------------------|
| [Query Builder](https://biud436.github.io/stingerloom-orm/query-builder.html) | Type-safe queries, JOIN, GROUP BY, UNION, CTE, window functions |
| [Transactions](https://biud436.github.io/stingerloom-orm/transactions.html) | Grouping operations, isolation levels, deadlock retry |
| [Migrations](https://biud436.github.io/stingerloom-orm/migrations.html) | Safely change schema in production, CLI (`npx stingerloom`) |
| [Configuration Guide](https://biud436.github.io/stingerloom-orm/configuration.html) | Pooling, timeouts, Read Replica, CJS/ESM |
| [Advanced Features](https://biud436.github.io/stingerloom-orm/advanced.html) | Streaming, event subscription, N+1 detection, query builder |
| [Plugins](https://biud436.github.io/stingerloom-orm/plugins.html) | Plugin system and WriteBuffer (Unit of Work) |
| [WriteBuffer](https://biud436.github.io/stingerloom-orm/write-buffer.html) | Identity Map, dirty checking, cascade, pessimistic locking |
| [Multi-Tenancy](https://biud436.github.io/stingerloom-orm/multi-tenancy.html) | Isolating multiple customer data in a single app |
| [API Reference](https://biud436.github.io/stingerloom-orm/api-reference.html) | Quick method signature lookup |

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
