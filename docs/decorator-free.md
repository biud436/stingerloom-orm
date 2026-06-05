# Decorator-Free Stingerloom

Every feature in Stingerloom can be used **without decorators**. This page is the complete map: for each decorator, it shows the decorator-free alternative and a runnable example. If you ever find a feature that is *only* reachable through a decorator, it is a bug — file an issue.

## Why This Matters

TypeScript decorators rely on the `emitDecoratorMetadata` compiler option. Some toolchains (esbuild, SWC, the TypeScript 5 *standard* decorators, Vite's default transformer) do not emit that metadata, so a decorator-based entity silently loses its column types. Beyond tooling, many teams prefer to keep domain classes free of framework annotations — the "plain class" philosophy.

Stingerloom solves both with two APIs that register the **exact same metadata** the decorators do:

| Concern | Decorator | Decorator-free alternative |
| --- | --- | --- |
| Entity / column / relation / index / hook / inheritance definition | `@Entity`, `@Column`, `@ManyToOne`, … | [`EntitySchema`](#entityschema-entity-definition) |
| Wrapping a unit of work in a transaction | `@Transactional` | [`em.transaction()`](#transactions-without-transactional) |
| NestJS dependency injection | `@InjectRepository`, `@InjectEntityManager` | [Plain providers / `em.getRepository()`](#nestjs-injection-without-decorators) |

Decorator-based and `EntitySchema`-based entities produce identical metadata, so you can **mix both** in the same project and the rest of the ORM (EntityManager, SchemaGenerator, QueryBuilder, WriteBuffer) cannot tell the difference.

## Full Mapping Table

### Entity-definition decorators → `EntitySchema`

| Decorator | Scope | `EntitySchema` equivalent |
| --- | --- | --- |
| `@Entity({ name })` | class | `{ target, tableName }` |
| `@Column(opts)` | property | `columns: { x: opts }` |
| `@Column({ transformer })` | property | `columns: { x: { transformer } }` |
| `@PrimaryColumn()` | property | `columns: { x: { primary: true } }` |
| `@PrimaryGeneratedColumn()` | property | `columns: { x: { primary: true, autoIncrement: true } }` |
| `@PrimaryGeneratedColumn("uuid"\|"uuid-v7")` | property | `columns: { x: { primary: true, type: "uuid", generationStrategy } }` |
| `@ManyToOne()` | property | `relations: { x: { kind: "manyToOne" } }` |
| `@OneToMany()` | property | `relations: { x: { kind: "oneToMany" } }` |
| `@OneToOne()` | property | `relations: { x: { kind: "oneToOne" } }` |
| `@ManyToMany()` | property | `relations: { x: { kind: "manyToMany" } }` |
| `@RelationColumn(opts)` | property | `relations: { x: { relationColumn: opts } }` |
| `@Index()` | property | `columns: { x: { index: true } }` |
| `@Index([cols], opts)` | class | `indexes: [{ columns, name, options }]` |
| `@UniqueIndex([cols])` | class | `uniqueIndexes: [{ columns, name }]` |
| `@FullTextIndex([cols], opts)` | class | `fullTextIndexes: [{ columns, name, language }]` |
| `@JsonIndex(opts)` | property | `columns: { x: { jsonIndex: opts } }` |
| `@ComputedColumn(opts)` | property | `computedColumns: { x: opts }` |
| `@Version()` | property | `columns: { x: { version: true } }` |
| `@CreateTimestamp()` | property | `columns: { x: { createTimestamp: true } }` |
| `@UpdateTimestamp()` | property | `columns: { x: { updateTimestamp: true } }` |
| `@DeletedAt()` | property | `columns: { x: { deletedAt: true } }` |
| `@BeforeInsert()` … `@AfterDelete()` | method | `hooks: { beforeInsert: "methodName" }` |
| `@NotNull()`, `@MinLength()`, … | property | `columns: { x: { validation: [...] } }` |
| `@Inheritance(strategy)` | class | `inheritance: { strategy }` |
| `@DiscriminatorColumn(opts)` | class | `discriminatorColumn: opts` |
| `@DiscriminatorValue(v)` | class | `discriminatorValue: v` |
| `@TenantColumn(opts)` | property | `columns: { x: { tenant: true, … } }` |
| `@NonTenantEntity()` | class | `nonTenant: true` |

### Behavioral decorators → programmatic APIs

| Decorator | Scope | Decorator-free equivalent |
| --- | --- | --- |
| `@Transactional(opts)` | method | `em.transaction(cb, { isolationLevel, propagation, connectionName })` |
| `@InjectRepository(Entity)` | constructor param | `em.getRepository(Entity)` |
| `@InjectEntityManager()` | constructor param | inject the `EntityManager` provider directly |

## EntitySchema: Entity Definition

The basics (columns, relations, unique indexes, hooks, validation, inheritance) are covered in [Entities & Columns → Defining Entities Without Decorators](./entities.md#defining-entities-without-decorators-entityschema). The sections below cover the features that used to require a dedicated decorator.

### Computed columns (`@ComputedColumn`)

Database-level generated columns go in `computedColumns`, **not** `columns` — they are excluded from INSERT/UPDATE and rendered as `GENERATED ALWAYS AS (...)`. Both the literal-string and the dialect-portable builder form are supported.

```typescript
import { EntitySchema } from "@stingerloom/orm";

class User {
  id!: number;
  firstName!: string;
  lastName!: string;
  fullName!: string;       // computed
  cycleTimeHours!: number; // computed
}

new EntitySchema<User>({
  target: User,
  columns: {
    id:        { type: "int", primary: true, autoIncrement: true },
    firstName: { type: "varchar", name: "first_name" },
    lastName:  { type: "varchar", name: "last_name" },
  },
  computedColumns: {
    // Literal SQL — must be valid for the target dialect.
    fullName: {
      expression: "first_name || ' ' || last_name",
      stored: true,
      type: "varchar",
    },
    // Dialect-portable builder — renders correct DDL on every driver.
    cycleTimeHours: {
      expression: (e) =>
        e.dateDiff(e.col("completed_at"), e.col("created_at"), "hour"),
      type: "int",
    },
  },
});
```

### Full-text indexes (`@FullTextIndex`)

```typescript
new EntitySchema<Post>({
  target: Post,
  columns: {
    id:      { type: "int", primary: true, autoIncrement: true },
    title:   { type: "varchar" },
    content: { type: "text" },
  },
  fullTextIndexes: [
    { columns: ["title", "content"], name: "ft_post", language: "english" },
  ],
});
```

PostgreSQL emits a GIN `to_tsvector` index, MySQL a `FULLTEXT` index; SQLite is a no-op.

### JSON path indexes (`@JsonIndex`)

Declared per column, alongside the JSON/JSONB column it indexes.

```typescript
new EntitySchema<User>({
  target: User,
  columns: {
    id: { type: "int", primary: true, autoIncrement: true },
    profile: {
      type: "jsonb",
      jsonIndex: { path: "tags", using: "gin", opclass: "jsonb_path_ops" },
    },
  },
});
```

The `path` is parsed into segments exactly as the decorator does (`"contact.email"` → `["contact", "email"]`). See [JSON Path Indexes](./entities.md#json-path-indexes-jsonindex) for the full option reference.

### Foreign-key columns (`@RelationColumn`)

Attach explicit FK column metadata (name, type, nullability, referenced column) to a `manyToOne` / `oneToOne` relation:

```typescript
new EntitySchema<Post>({
  target: Post,
  columns: { id: { type: "int", primary: true, autoIncrement: true } },
  relations: {
    author: {
      kind: "manyToOne",
      target: () => User,
      relationColumn: {
        name: "author_id",
        type: "bigint",
        nullable: false,
        referencedColumn: "id",
      },
    },
  },
});
```

### Bidirectional transformers (`@Column({ transformer })`)

```typescript
new EntitySchema<User>({
  target: User,
  columns: {
    id: { type: "int", primary: true, autoIncrement: true },
    email: {
      type: "varchar",
      transformer: {
        to:   (value: string) => value.toLowerCase(), // entity → DB (write)
        from: (raw: string) => raw.trim(),            // DB → entity (read)
      },
    },
  },
});
```

### UUID primary keys (`@PrimaryGeneratedColumn("uuid-v7")`)

```typescript
new EntitySchema<Token>({
  target: Token,
  columns: {
    id: { type: "uuid", primary: true, generationStrategy: "uuid-v7" },
  },
});
```

`generationStrategy` accepts `"increment"` (default), `"uuid"` (UUIDv4), or `"uuid-v7"` (time-sortable).

### Advanced composite indexes (`@Index([cols], options)`)

Pass an `options` object to carry partial / expression / `USING` / `INCLUDE` settings:

```typescript
new EntitySchema<Order>({
  target: Order,
  columns: {
    id:     { type: "int", primary: true, autoIncrement: true },
    email:  { type: "varchar" },
    active: { type: "boolean" },
  },
  indexes: [
    {
      columns: ["email"],
      options: {
        name: "idx_active_email",
        where: "active = true",   // partial index (PostgreSQL/SQLite)
        using: "btree",
        include: ["id"],          // covering index (PostgreSQL)
      },
    },
  ],
});
```

### Tenant column (`@TenantColumn` / `@NonTenantEntity`)

When the global `tenantStrategy` is `"tenant_column"`, mark the discriminator column with `tenant: true` so you can read it off entity instances, and opt global tables out with `nonTenant: true`.

```typescript
// Per-tenant entity — tenant column is readable as log.tenantId
new EntitySchema<AuditLog>({
  target: AuditLog,
  columns: {
    id:       { type: "int", primary: true, autoIncrement: true },
    action:   { type: "varchar" },
    tenantId: { type: "varchar", name: "tenant_id", length: 64, tenant: true },
  },
});

// Inherently global entity — no tenant column, no WHERE injection
new EntitySchema<Tenant>({
  target: Tenant,
  nonTenant: true,
  columns: {
    id:   { type: "varchar", primary: true },
    name: { type: "varchar" },
  },
});
```

See [Multi-Tenancy](./multi-tenancy.md) for the full strategy reference.

## Transactions Without `@Transactional`

`em.transaction(callback, options)` is the decorator-free counterpart to `@Transactional`. It accepts the **same** `isolationLevel`, `propagation`, and `connectionName` options the decorator does, plus optional deadlock retry that the decorator does not offer.

```typescript
import { EntityManager, TransactionPropagation } from "@stingerloom/orm";

// @Transactional("SERIALIZABLE")
await em.transaction(async (txEm) => {
  /* ... */
}, { isolationLevel: "SERIALIZABLE" });

// @Transactional({ propagation: TransactionPropagation.REQUIRES_NEW })
await em.transaction(async (txEm) => {
  /* always a fresh, independent transaction */
}, { propagation: TransactionPropagation.REQUIRES_NEW });

// @Transactional({ propagation: TransactionPropagation.NESTED })
await em.transaction(async (txEm) => {
  /* runs on a SAVEPOINT inside the active transaction */
}, { propagation: TransactionPropagation.NESTED });

// @Transactional({ connectionName: "reporting" })
await em.transaction(async (txEm) => {
  /* ... */
}, { connectionName: "reporting" });

// Deadlock retry — only available on the callback API
await em.transaction(async (txEm) => {
  /* ... */
}, { retryOnDeadlock: true, maxRetries: 3 });
```

`TransactionOptions` reference:

| Option | Type | Default | Equivalent decorator form |
| --- | --- | --- | --- |
| `isolationLevel` | `"READ UNCOMMITTED" \| "READ COMMITTED" \| "REPEATABLE READ" \| "SERIALIZABLE"` | driver default | `@Transactional("SERIALIZABLE")` |
| `propagation` | `TransactionPropagation` | `REQUIRED` | `@Transactional({ propagation })` |
| `connectionName` | `string` | default connection | `@Transactional({ connectionName })` |
| `retryOnDeadlock` | `boolean` | `false` | — (callback only) |
| `maxRetries` | `number` | `3` | — (callback only) |
| `retryDelayMs` | `number` | `100` | — (callback only) |

See [Transactions](./transactions.md) for the conceptual guide to isolation levels, propagation, and savepoints.

## NestJS Injection Without Decorators

`@InjectRepository` and `@InjectEntityManager` are NestJS DI conveniences, not entity metadata. If you would rather not annotate constructor parameters, resolve the `EntityManager` provider and ask it for repositories:

```typescript
import { Injectable } from "@nestjs/common";
import { EntityManager } from "@stingerloom/orm";

@Injectable()
export class UserService {
  // EntityManager is a normal Nest provider — inject it positionally.
  constructor(private readonly em: EntityManager) {}

  private get users() {
    return this.em.getRepository(User);
  }

  findAll() {
    return this.users.find();
  }
}
```

`em.getRepository(Entity)` returns the same `BaseRepository` instance `@InjectRepository(Entity)` would have injected.

## Verifying You Are Truly Decorator-Free

If your goal is to drop `emitDecoratorMetadata` entirely, define **all** entities with `EntitySchema` and run them through your real toolchain (esbuild/SWC). `EntitySchema` sets `design:type` metadata itself, so no compiler-emitted metadata is required. A quick smoke test:

```typescript
await em.register({ entities: [User, AuditLog, /* ... */], synchronize: "dry-run" });
```

`synchronize: "dry-run"` logs the DDL it *would* run without touching the database — a fast way to confirm every column, index, and relation resolved correctly.
