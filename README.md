<h1 align="center">Stingerloom ORM</h1>
<p align="center">A decorator-driven TypeScript ORM with layered multi-tenancy, built for PostgreSQL, MySQL, and SQLite.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@stingerloom/orm"><img src="https://img.shields.io/npm/v/@stingerloom/orm" alt="npm version" /></a>
  <a href="https://github.com/biud436/stingerloom-orm/actions"><img src="https://img.shields.io/badge/tests-1%2C500%2B%20passed-brightgreen" alt="tests" /></a>
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

- **Decorator-first** — Define entities, relations, hooks, and validation with TypeScript decorators. Column types are inferred automatically.
- **Multi-tenancy built in** — Layered metadata system (inspired by Docker OverlayFS) with `AsyncLocalStorage`-based context isolation. Zero cross-tenant leakage by design.
- **Three databases, one API** — MySQL, PostgreSQL, and SQLite share the same EntityManager interface. Switch drivers without rewriting queries.
- **Schema Diff migrations** — Compare live database state against entity metadata and auto-generate migration code.
- **NestJS-ready** — First-party module with `@InjectRepository`, `@InjectEntityManager`, and multi-DB named connections.

## Quick Start

```bash
npm install @stingerloom/orm reflect-metadata
npm install pg        # or mysql2, better-sqlite3
```

```typescript
import { EntityManager, Entity, PrimaryGeneratedColumn, Column } from "@stingerloom/orm";

@Entity()
class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;
}

const em = new EntityManager();
await em.register({ type: "postgres", entities: [Post], synchronize: true, /* ... */ });

const post = await em.save(Post, { title: "Hello World" });
const found = await em.findOne(Post, { where: { id: post.id } });
```

> See the [Getting Started guide](https://biud436.github.io/stingerloom-orm/getting-started) for full setup instructions.

## Features

| Category | Highlights |
|----------|------------|
| **Modeling** | `@Entity`, `@Column`, `@ManyToOne`, `@OneToMany`, `@ManyToMany`, `@OneToOne`, eager/lazy loading |
| **Querying** | `find`, `findOne`, `findWithCursor`, `findAndCount`, Query Builder with JOIN/GROUP BY/HAVING |
| **Mutations** | `save`, `update`, `delete`, `softDelete`, `restore`, `upsert`, batch operations |
| **Transactions** | `@Transactional` decorator, manual BEGIN/COMMIT/ROLLBACK, savepoints, isolation levels |
| **Multi-tenancy** | Layered metadata (OverlayFS model), `MetadataContext.run()`, PostgreSQL schema isolation, `TenantMigrationRunner` |
| **Migrations** | `SchemaDiff` auto-detection, `MigrationGenerator`, CLI runner |
| **Observability** | N+1 detection, slow query warnings, `EXPLAIN` analysis, `EntitySubscriber` events |
| **Validation** | `@NotNull`, `@MinLength`, `@MaxLength`, `@Min`, `@Max` |
| **Infrastructure** | Connection pooling, read replicas, retry with backoff, per-query timeout, graceful shutdown |
| **NestJS** | `StinglerloomOrmModule.forRoot/forFeature`, `@InjectRepository`, `@InjectEntityManager`, multi-DB connections |

## Database Support

|                  | MySQL | PostgreSQL | SQLite |
| ---------------- | :---: | :--------: | :----: |
| CRUD             | ✓     | ✓          | ✓      |
| Transactions     | ✓     | ✓          | ✓      |
| Schema Sync      | ✓     | ✓          | ✓      |
| Migrations       | ✓     | ✓          | ✓      |
| ENUM             | ✓     | ✓ (native) | —      |
| Schema Isolation | —     | ✓          | —      |
| Read Replica     | ✓     | ✓          | —      |

## Examples

Four NestJS example projects are included in [`examples/`](./examples):

| Project | Description |
|---------|-------------|
| [nestjs-cats](./examples/nestjs-cats) | CRUD, relations, soft delete, cursor pagination, EntitySubscriber |
| [nestjs-blog](./examples/nestjs-blog) | ManyToMany, upsert, 59 e2e tests |
| [nestjs-todo](./examples/nestjs-todo) | Minimal CRUD with npm package verification |
| [nestjs-multitenant](./examples/nestjs-multitenant) | PostgreSQL schema-based tenant isolation |

## Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.

## License

[MIT](./LICENSE)
