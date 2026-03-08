# Stingerloom ORM Examples

This directory contains example projects demonstrating how to use Stingerloom ORM with different frameworks and use cases.

## Available Examples

### [NestJS Cats API](./nestjs-cats)

A complete CRUD API built with NestJS demonstrating:

- **DatabaseModule.forRoot()** pattern following the original Stingerloom framework
- Entity definitions with decorators (`@Entity`, `@Column`, `@PrimaryGeneratedColumn`)
- Repository pattern for database operations
- Metadata-based configuration storage
- NestJS lifecycle hooks integration (`OnModuleInit`, `OnModuleDestroy`)
- Environment variable configuration with `@nestjs/config`

**Tech Stack**: NestJS, TypeScript, MySQL, Stingerloom ORM

**Quick Start**:

```bash
cd nestjs-cats
npm install
npm run build
npm run start:dev
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
- **`@DeletedAt` + `@Version`** — Soft Delete + Optimistic Locking
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
