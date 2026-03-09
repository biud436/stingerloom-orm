<h1 align="center">Stingerloom ORM</h1>
<p align="center">Decorator-driven TypeScript ORM with multi-tenancy support.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@stingerloom/orm"><img src="https://img.shields.io/npm/v/@stingerloom/orm" alt="npm" /></a>
  <img src="https://img.shields.io/badge/tests-1%2C405%20passed-brightgreen" alt="Tests" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License" />
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
</p>

---

Stingerloom ORM is a decorator-driven TypeScript ORM designed for type-safe database access with first-class multi-tenancy support.

## Install

```bash
npm install @stingerloom/orm reflect-metadata
```

Install only the driver you need:

```bash
npm install mysql2         # MySQL / MariaDB
npm install pg             # PostgreSQL
npm install better-sqlite3 # SQLite
```

## Defining Entities

Entities are defined with decorators. Column types are automatically inferred from TypeScript types — `string` maps to `VARCHAR`, `number` to `INT`, `boolean` to `TINYINT`/`BOOLEAN`.

```typescript
@Entity()
class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @Column({ type: "text" })
  content!: string;

  @DeletedAt()
  deletedAt!: Date | null;

  @ManyToOne(() => User, { joinColumn: "author_id", eager: true })
  author!: User;

  @BeforeInsert()
  setDefaults() {
    this.createdAt = new Date();
  }
}
```

## CRUD with EntityManager

```typescript
const em = new EntityManager();
await em.register({ type: "mysql", entities: [Post, User], synchronize: true });

// Create
const post = await em.save(Post, { title: "Hello", content: "World" });

// Read — eager relations are loaded automatically
const found = await em.findOne(Post, { where: { id: 1 } });

// Update
found.title = "Updated";
await em.save(Post, found);

// Soft Delete — find queries automatically exclude soft-deleted rows
await em.softDelete(Post, { id: 1 });
```

## Relationships

Four relationship types with eager, lazy, and explicit loading strategies:

```typescript
@ManyToOne(() => User, { eager: true })       // N:1, auto-loads on find
@OneToMany(() => Comment, c => c.post)         // 1:N, inverse side
@OneToOne(() => Profile, { joinColumn: "profile_id" })
@ManyToMany(() => Tag, { joinTable: "post_tags" })  // auto-generated join table DDL
```

## Query Builder

For complex queries beyond the `find` API:

```typescript
const qb = RawQueryBuilderFactory.create()
  .select(["p.id", "p.title", "COUNT(c.id) AS comment_count"])
  .from("post", "p")
  .leftJoin("comment", "c", sql`c.post_id = p.id`)
  .where([sql`p.deleted_at IS NULL`])
  .groupBy(["p.id"])
  .having([sql`COUNT(c.id) > ${5}`])
  .orderBy([{ column: "comment_count", direction: "DESC" }])
  .limit(10)
  .build();
```

## Multi-Tenancy

Layered metadata system inspired by Docker OverlayFS. Each tenant gets an isolated metadata layer with Copy-on-Write semantics, powered by `AsyncLocalStorage` for safe concurrent access:

```typescript
// Requests are isolated per tenant — no cross-tenant data leakage
app.use((req, res, next) => {
  MetadataContext.run(req.headers["x-tenant-id"], () => next());
});
```

PostgreSQL schema-based isolation with automatic provisioning:

```typescript
const runner = new PostgresTenantMigrationRunner(driver);
await runner.ensureSchema("tenant_42"); // CREATE SCHEMA IF NOT EXISTS
await runner.syncTenantSchemas(["t1", "t2"]); // batch provisioning
```

## Transactions

Method-level with `@Transactional()` or manual with savepoint support:

```typescript
@Transactional("SERIALIZABLE")
async transfer(from: number, to: number, amount: number) {
  // automatic BEGIN, COMMIT on success, ROLLBACK on error
}
```

## Migrations

Schema Diff compares entity metadata against the live database and auto-generates migration code:

```typescript
const diff = await SchemaDiff.compare(em, [User, Post]);
const migration = new SchemaDiffMigrationGenerator().generate(diff, "mysql");
```

## Additional Features

- **Cursor Pagination** — `findWithCursor()` for consistent performance on large datasets
- **Upsert** — `INSERT ON CONFLICT` / `ON DUPLICATE KEY UPDATE` with native driver syntax
- **N+1 Detection** — QueryTracker warns on repeated single-row queries and slow queries
- **Aggregation** — `count`, `sum`, `avg`, `min`, `max` with optional WHERE
- **Lifecycle Hooks** — `@BeforeInsert`, `@AfterInsert`, `@BeforeUpdate`, `@AfterUpdate`, `@BeforeDelete`, `@AfterDelete`
- **EntitySubscriber** — event-driven observation pattern per entity class
- **Validation** — `@NotNull`, `@MinLength`, `@MaxLength`, `@Min`, `@Max`
- **Connection Pooling** — configurable pool size, acquire/idle timeouts
- **Retry & Timeout** — exponential backoff on connection failure, per-query timeout
- **EXPLAIN** — query execution plan analysis
- **NestJS Integration** — `@InjectRepository`, `@InjectEntityManager`, module system

## Databases

|                  | MySQL | PostgreSQL | SQLite |
| ---------------- | ----- | ---------- | ------ |
| CRUD             | ✓     | ✓          | ✓      |
| Transactions     | ✓     | ✓          | ✓      |
| Schema Sync      | ✓     | ✓          | ✓      |
| Migrations       | ✓     | ✓          | ✓      |
| ENUM             | ✓     | ✓ (native) | —      |
| Schema Isolation | —     | ✓          | —      |
| Read Replica     | ✓     | ✓          | —      |

## Test Status

- **1,348** unit tests passed, 0 failures
- **4** example projects type-checked (nestjs-cats, nestjs-blog, nestjs-multitenant, nestjs-todo)
- **6** SQL injection vectors patched and audited across all drivers

## Documentation

Full documentation available at [docs/](https://github.com/biud436/stingerloom-orm/tree/main/docs).
