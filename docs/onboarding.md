# Contributor Onboarding Guide

> **Purpose of this document:** To help you understand the **internal architecture** of Stingerloom ORM and enable you to modify code or add new features. If you are looking for API usage, please read [Getting Started](./getting-started.md) first.

> **Target audience:** Developers newly joining the project or external contributors

---

## 1. Local Development Environment Setup

### Required Tools

| Tool | Minimum Version | Notes |
|------|----------------|-------|
| Node.js | >=16 | See the `engines` field in `package.json` |
| pnpm | >=8 | Project package manager |
| TypeScript | >=5.6 | Included in `devDependencies` |
| Docker | Latest stable | For integration test MySQL/PostgreSQL |

### Clone and Build

```bash
git clone https://github.com/biud436/stingerloom-orm.git
cd stingerloom-orm
pnpm install
pnpm build          # Generate dist/ — required before running examples
```

`pnpm build` runs `rimraf dist && tsc`. Since the ORM is not yet published on npm, `examples/` projects reference the local build output (`dist/`).

### Database Setup with Docker

Integration tests require MySQL and PostgreSQL.

```bash
# MySQL
docker run -d --name stingerloom-mysql \
  -e MYSQL_ROOT_PASSWORD=test \
  -e MYSQL_DATABASE=test \
  -p 3306:3306 \
  mysql:8

# PostgreSQL
docker run -d --name stingerloom-postgres \
  -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=test \
  -p 5432:5432 \
  postgres:16
```

### Running Tests

```bash
# Unit tests (no DB connection required)
pnpm test

# Run a specific test file only
pnpm test -- --testPathPattern="schema-diff"

# Integration tests (MySQL/PostgreSQL must be running)
INTEGRATION_TEST=true pnpm test -- --testPathPattern="integration"
```

Unit tests consist of 131 files with 2,978+ cases. Integration tests are automatically skipped without the `INTEGRATION_TEST=true` environment variable.

### Running Examples

```bash
pnpm build                              # Must build first
cd examples/nestjs-cats && pnpm install && pnpm start
# or
cd examples/nestjs-blog && pnpm install && pnpm start
```

---

## 2. Architecture Overview

### Directory Structure

```
src/
├── core/               <- Core logic (EntityManager, Repository, QueryBuilder, etc.)
├── decorators/         <- Decorator definitions (@Entity, @Column, etc.)
├── dialects/           <- Per-DB driver implementations (MySQL, PostgreSQL, SQLite)
├── metadata/           <- Layered metadata system (multi-tenancy)
├── scanner/            <- Decorator metadata collectors (EntityScanner, ColumnScanner, etc.)
├── migration/          <- Migration system
├── types/              <- Common type definitions
├── utils/              <- Helpers (Logger, ReflectManager)
└── errors/             <- Error class hierarchy
```

**Why is it structured this way?**

- `core/` and `dialects/` are separated to isolate DB-independent logic from DB-specific code.
- `scanner/` and `decorators/` are separated to distinguish the concerns of "metadata collection" and "metadata definition."
- `metadata/` is an independent module so the multi-tenancy layer system does not affect other code.

### Data Flow

The complete flow from entity class definition to DB storage.

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Decorator Registration (at app load)              │
│                                                                     │
│  @Column()    ->  ColumnScanner.set()   ─┐                          │
│  @ManyToOne() ->  ManyToOneScanner.set() ├-> MetadataLayerRegistry  │
│  @Entity()    ->  EntityScanner.set()   ─┘   (written to public     │
│                                               layer)                │
└─────────────────────────────────────────────────────────────────────┘
                            │
                            v
┌─────────────────────────────────────────────────────────────────────┐
│                 EntityManager.register() call                       │
│                                                                     │
│  DatabaseClient.connect()  ->  Connector created  ->  Driver created│
│       (singleton)              (MySQL/PG/...)        (ISqlDriver     │
│                                                       impl)         │
│                                                                     │
│  registerEntities()                                                 │
│    Pass 1: createTable() — generate table DDL                       │
│    Pass 2: registerForeignKeys/Index — add FK/indexes               │
│    Pass 3: ManyToMany join table creation                           │
└─────────────────────────────────────────────────────────────────────┘
                            │
                            v
┌─────────────────────────────────────────────────────────────────────┐
│                      CRUD Execution (runtime)                       │
│                                                                     │
│  em.save(User, data)                                                │
│    -> Query metadata (MetadataLayerRegistry)                        │
│    -> Execute BeforeInsert hook                                     │
│    -> TransactionSessionManager.connect()                           │
│    -> START TRANSACTION / BEGIN                                      │
│    -> Build SQL (sql-template-tag parameter binding)                 │
│    -> Execute via Driver                                            │
│    -> Deserialize (Deserializer)                                    │
│    -> COMMIT (or ROLLBACK on error)                                 │
│    -> Execute AfterInsert hook                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Layered Metadata System

Works on the same concept as Docker's OverlayFS.

```
┌──────────────────────────────┐
│    Tenant Layer (upper)      │  <- Per-tenant modifications (Copy-on-Write)
│    e.g. "tenant_1", "tenant_2"│
├──────────────────────────────┤
│    Public Layer (lower)      │  <- Base schema (all entity metadata)
│    Read-only (after decorator │
│    registration)              │
└──────────────────────────────┘
```

**How it works:**

1. At app load, decorators like `@Entity` and `@Column` write metadata to the public layer.
2. In a multi-tenant environment, when `MetadataContext.run("tenant_1", callback)` is called, the tenant_1 layer is activated within that callback.
3. When querying metadata, the tenant layer is checked first, then falls back to the public layer (OverlayFS).
4. Writes always occur only on the tenant layer (Copy-on-Write).

**Key files:**

| File | Role |
|------|------|
| `src/metadata/MetadataContext.ts` | AsyncLocalStorage-based request-scoped context |
| `src/metadata/LayeredMetadataStore.ts` | Layer-based metadata store |
| `src/metadata/MetadataLayer.ts` | Individual layer (key-value Map) |
| `src/scanner/MetadataScanner.ts` | Scanner base class using MetadataLayerRegistry |

### Driver Abstraction

All DB drivers implement the `ISqlDriver` interface (`src/dialects/SqlDriver.ts`).

| Driver | Identifier Wrapping | Auto PK Generation | Schema Support | File Path |
|--------|--------------------|--------------------|---------------|-----------|
| MySQL | Backtick (`` ` ``) | `AUTO_INCREMENT` | Not supported | `src/dialects/mysql/MySqlDriver.ts` |
| PostgreSQL | Double quote (`"`) | `SERIAL` / `RETURNING` | Supported (`schema.table`) | `src/dialects/postgres/PostgresDriver.ts` |
| SQLite | Double quote (`"`) | `INTEGER PRIMARY KEY` | Not supported | `src/dialects/sqlite/SqliteDriver.ts` |

Connection layer hierarchy for each driver:

```
DatabaseClient (singleton)
  └-> Connector (IConnector implementation — manages actual DB connections)
       └-> Driver (ISqlDriver implementation — DDL/DML abstraction)
            └-> DataSource (IDataSource implementation — transaction/query execution)
```

---

## 3. Key Code Flows

### Connection Flow

```
EntityManager.register(options)
  -> EntityManager.connect(options)
      -> DatabaseClient.getInstance().connect(options)
          -> createConnector(type)   // MySqlConnector | PostgresConnector | ...
          -> connector.connect(options)
      -> Driver creation (MySqlDriver | PostgresDriver | ...)
      -> DataSource creation (for transaction management)
  -> EntityManager.registerEntities()
```

**Related files:**
- `src/core/EntityManager.ts:121` — `register()` method
- `src/core/EntityManager.ts:146` — `connect()` method
- `src/DatabaseClient.ts:48` — `connect()` method

### Entity Registration Flow

Decorators execute at class definition time (module load). The execution order is important.

```
1. @Column() executes (property decorator — in class body order)
   -> inferColumnDefaults() infers design:type
   -> ColumnScanner.set() temporarily stores metadata

2. @ManyToOne() executes (property decorator)
   -> ManyToOneScanner.set() temporarily stores relation metadata

3. @Entity() executes (class decorator — last)
   -> ColumnScanner.allMetadata() retrieves collected columns
   -> ManyToOneScanner.allMetadata() retrieves collected relations
   -> EntityScanner.set() snapshots entity metadata
   -> ColumnScanner.clear() resets temporary buffer
```

**Key point:** `@Column()` executes before `@Entity()`. `@Entity()` takes a snapshot of column metadata collected up to that point and clears the temporary buffer.

**Related files:**
- `src/decorators/Column.ts:153` — `Column()` decorator
- `src/decorators/Entity.ts:24` — `Entity()` decorator
- `src/scanner/MetadataScanner.ts:179` — Scanner base class

### CRUD Flow (save example)

```
em.save(User, { name: "John Doe", email: "john@example.com" })
  1. resolveEntityMetadata(User)
     -> EntityScanner.scan(User) or Reflect.getMetadata(ENTITY_TOKEN, User)
  2. EntityValidator.validate(entity)
     -> @Validation decorator checks
  3. Hook execution: BeforeInsert
  4. EntitySubscriber.beforeInsert() event
  5. TransactionSessionManager creation -> connect() -> startTransaction()
  6. SQL build: INSERT INTO "users" ("name", "email") VALUES ($1, $2)
     -> Parameter binding via sql-template-tag
  7. Execute query -> return result rows
  8. commit()
  9. Deserializer converts result -> User instance
  10. Hook execution: AfterInsert
  11. EntitySubscriber.afterInsert() event
```

**Related files:**
- `src/core/EntityManager.ts:2146` — `save()` method
- `src/dialects/TransactionSessionManager.ts` — Transaction management
- `src/core/EntityValidator.ts` — Validation

### Relation Loading

**Eager Loading (default):**

```
em.find(Post, { relations: ["author"] })
  -> Queries related entities at once with LEFT JOIN
  -> ResultTransformer converts flat rows to nested objects
```

**Lazy Loading:**

```
em.find(Post, { relations: [] })  // Relations configured as lazy
  -> Injects getter proxy via Object.defineProperty()
  -> Accessing post.author -> executes separate SELECT query
  -> Subsequent access returns cached value
```

**Related files:**
- `src/core/LazyLoader.ts` — `injectLazyProxy()`, `createLazyProxy()`

---

## 4. Adding New Features Guide

### Adding a New Decorator

Example: Assume we are adding a `@CreatedAt()` decorator.

**Step 1: Define Symbol token + write decorator function**

```typescript
// src/decorators/CreatedAt.ts
export const CREATED_AT_TOKEN = Symbol.for("STG_CREATED_AT");

export function CreatedAt(): PropertyDecorator {
  return (target, propertyKey) => {
    Reflect.defineMetadata(CREATED_AT_TOKEN, propertyKey, target.constructor);
  };
}
```

**Step 2: Export the decorator**

```typescript
// Add to src/decorators/index.ts
export * from "./CreatedAt";
```

**Step 3: Use the token in EntityManager**

In save/update methods, query `Reflect.getMetadata(CREATED_AT_TOKEN, entity)` to automatically set the date.

**Step 4: Write tests**

Create `__tests__/unit/created-at.test.ts` and verify the decorator behavior.

**Naming conventions:**
- Token symbols: `STG_` prefix (e.g., `Symbol.for("STG_CREATED_AT")`)
- Decorator files: PascalCase (e.g., `CreatedAt.ts`)
- Token constants: SCREAMING_SNAKE_CASE + `_TOKEN` suffix (e.g., `CREATED_AT_TOKEN`)

### Adding a New Driver

To support a new database (e.g., CockroachDB):

**Step 1: Create directory**

```
src/dialects/cockroach/
  ├── CockroachDriver.ts       <- ISqlDriver implementation
  ├── CockroachConnector.ts    <- IConnector implementation
  └── CockroachDataSource.ts   <- IDataSource implementation
```

**Step 2: Fully implement ISqlDriver**

Implement all methods defined in the `ISqlDriver` interface in `src/dialects/SqlDriver.ts`. Key methods:
- `createTable()` / `hasTable()` — DDL
- `addForeignKey()` / `addIndex()` — Constraints
- `castType()` — ColumnType -> DB native type conversion
- `buildUpsertSql()` — UPSERT syntax
- `setQueryTimeout()` — Query timeout

**Step 3: Add registration code**

Add branching in three places:
- `src/DatabaseClient.ts:72` — `createConnector()` method
- `src/core/EntityManager.ts:158` — switch in `connect()` method
- `src/dialects/TransactionSessionManager.ts:48` — if-else in `connect()` method

**Step 4: Tests**

Create `__tests__/unit/cockroach-driver.test.ts`.

### Adding a New Method to EntityManager

Procedure for adding a public API to EntityManager:

**Step 1:** Add method signature to the `src/core/BaseEntityManager.ts` interface

**Step 2:** Implement in `src/core/EntityManager.ts`

**Step 3:** Add wrapper method in `src/core/BaseRepository.ts` (for Repository pattern support)

**Step 4:** If needed, verify exports in `src/index.ts` -> `src/core/index.ts`

### Adding a New Error Class

**Step 1:** Add a new error code to `src/errors/OrmErrorCode.ts`

```typescript
export enum OrmErrorCode {
  // ... existing codes
  MY_NEW_ERROR = "ORM_MY_NEW_ERROR",
}
```

**Step 2:** Create an error class in the `src/errors/` directory

```typescript
// src/errors/MyNewError.ts
import { OrmError } from "./OrmError";
import { OrmErrorCode } from "./OrmErrorCode";

export class MyNewError extends OrmError {
  constructor() {
    super(OrmErrorCode.MY_NEW_ERROR, "Description message");
    this.name = "MyNewError";
  }
}
```

**Step 3:** Export from `src/errors/index.ts`

---

## 5. Coding Conventions

### SQL Injection Prevention

**Absolute rule:** Never insert user input directly into SQL strings.

```typescript
// Correct approach — use sql-template-tag
import sql from "sql-template-tag";
const query = sql`SELECT * FROM users WHERE id = ${userId}`;

// Wrong approach
const query = `SELECT * FROM users WHERE id = ${userId}`;
```

Identifiers like table names and column names must be wrapped with the driver's `escapeIdentifier()` or `wrapIdentifier()`.

```typescript
// MySQL: `users`, PostgreSQL: "users"
const tableName = driver.escapeIdentifier("users");
```

### Metadata Isolation

```typescript
// Correct approach — AsyncLocalStorage-based request scope
MetadataContext.run("tenant_1", async () => {
  await em.find(User);  // Executes in tenant_1 context
});

// Wrong approach — modifying instance state (not safe with concurrent requests)
store.setContext("tenant_1");  // deprecated!
```

### TypeScript strict Mode

`tsconfig.json` has `strict: true` set. Minimize use of `any` type, but when unavoidable due to framework metadata handling, use `eslint-disable` comments.

### Test Patterns

**Unit tests:**

```typescript
// Mock DB connections with jest.mock
jest.mock("../../src/DatabaseClient", () => ({
  DatabaseClient: {
    getInstance: jest.fn().mockReturnValue({
      getConnection: jest.fn(),
      type: "mysql",
      getOptions: jest.fn().mockReturnValue({ synchronize: false }),
    }),
  },
}));
```

**Integration tests:**

```typescript
import { createTestConnection, generateTableName, dropTestTable } from "./helpers";

describe("CRUD basic", () => {
  let em: EntityManager;
  const tableName = generateTableName("crud");

  beforeAll(async () => {
    em = await createTestConnection();
  });

  afterAll(async () => {
    await dropTestTable(em, tableName);
  });
});
```

Integration test files must include the following guard at the top:

```typescript
const SKIP = !process.env.INTEGRATION_TEST;
(SKIP ? describe.skip : describe)("Integration: ...", () => { ... });
```

### Naming Conventions

| Subject | Convention | Example |
|---------|-----------|---------|
| Entity class | PascalCase | `User`, `BlogPost` |
| Table name | snake_case (auto-converted) | `user`, `blog_post` |
| Decorator token | `STG_` prefix + SCREAMING_SNAKE | `Symbol.for("STG_ENTITY")` |
| Driver class | `{DB}Driver` | `MySqlDriver`, `PostgresDriver` |
| Connector class | `{DB}Connector` | `MySqlConnector` |
| DataSource class | `{DB}DataSource` | `MySqlDataSource` |
| Scanner class | `{Name}Scanner` | `ColumnScanner`, `EntityScanner` |
| Error class | `{Desc}Error` | `EntityNotFound`, `InvalidQueryError` |

### Commit Messages

```
feat: Add new feature
fix: Fix bug
docs: Documentation changes
test: Add/modify tests
refactor: Refactoring (no functional changes)
chore: Build, configuration changes
```

---

## 6. Common Mistakes and Troubleshooting

### Missing `reflect-metadata` Import

```
TypeError: Reflect.getMetadata is not a function
```

**Solution:** Add `import "reflect-metadata"` at the very top of your app entry point. Without this package, decorator metadata (`design:type`, etc.) cannot be read.

### Missing tsconfig.json Settings

```
Unable to resolve signature of class decorator...
```

**Solution:** The following two options must be present in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

### Running Examples Without Building

```
Cannot find module '@stingerloom/orm'
```

**Solution:** `examples/` references the local `dist/`. You must run `pnpm build` at the project root before running examples.

### MetadataLayerRegistry Contamination Between Tests

When different test files define the same entity, metadata can overlap since MetadataLayerRegistry is a global singleton.

**Solution:** Reset the registry before each test:

```typescript
beforeEach(() => {
  MetadataLayerRegistry.reset();
  MetadataContext.reset();
});
```

### Falsy Value Handling in WHERE Conditions

There was a bug where falsy values like `0`, `false`, and `""` were ignored in WHERE conditions (fixed).

**Note:** Use `if (value !== undefined && value !== null)` instead of `if (value)` when checking conditions.

```typescript
// Correct approach
if (value !== undefined && value !== null) {
  conditions.push(sql`${column} = ${value}`);
}

// Wrong approach — ignores 0, false, ""
if (value) {
  conditions.push(sql`${column} = ${value}`);
}
```

### MySQL Connection Pool Double Release

In the MySQL driver, if the connection reference is not set to `undefined` after `commit()` or `rollback()`, the same connection can be released twice.

**Related code:** `src/dialects/mysql/MySqlDataSource.ts` — Setting `this.connection = undefined` after commit/rollback is required.

---

## 7. Contribution Workflow

### Branch Strategy

```
main (default branch)
  └── feature/feature-name       <- New features
  └── fix/bug-description        <- Bug fixes
  └── docs/doc-topic             <- Documentation changes
```

Branch from main and create a PR after completing the work.

### PR Checklist

Before opening a PR, verify the following:

- [ ] `pnpm test` passes completely (0 failures)
- [ ] `pnpm build` succeeds (no TypeScript compilation errors)
- [ ] Unit tests added for new features
- [ ] User inputs in SQL queries are handled with parameter binding
- [ ] Identifiers (table names, column names) are wrapped with `escapeIdentifier()`
- [ ] Metadata access goes through the layer system (no global state usage)
- [ ] Related documentation (`docs/`) updated if API changed
- [ ] `examples/` updated if example projects are affected

### Example Project Type Check

If you changed the ORM API, verify that examples are not broken:

```bash
pnpm build
cd examples/nestjs-cats && pnpm install && npx tsc --noEmit
cd ../nestjs-blog && pnpm install && npx tsc --noEmit
cd ../nestjs-multitenant && pnpm install && npx tsc --noEmit
```

---

## 8. References

### Existing Documentation Cross-Reference

| Document | Content | When to reference |
|----------|---------|-------------------|
| [Getting Started](./getting-started.md) | Installation, first entity, first CRUD | When first learning ORM usage |
| [Entity Definition](./entities.md) | Columns, indexes, hooks, validation | When understanding decorator behavior |
| [Relations](./relations.md) | ManyToOne, OneToMany, ManyToMany | When modifying relation loading code |
| [EntityManager](./entity-manager.md) | find, save, delete, aggregation | When extending EntityManager API |
| [Query Builder](./query-builder.md) | JOIN, GROUP BY, subqueries | When modifying QueryBuilder code |
| [Transactions](./transactions.md) | Isolation levels, Savepoint | When modifying TransactionSessionManager |
| [Migrations](./migrations.md) | MigrationRunner, CLI | When modifying the migration system |
| [Configuration Guide](./configuration.md) | Pooling, timeout, Read Replica | When extending DatabaseClientOptions |
| [Advanced Features](./advanced.md) | N+1 detection, events, cursor pagination | When modifying QueryTracker, EventEmitter |
| [Multi-Tenancy](./multi-tenancy.md) | Layered metadata, schema isolation | When modifying multi-tenancy features |
| [API Reference](./api-reference.md) | Method signature list | When checking public API |
| [Manual Testing Guide](./manual-testing-guide.md) | Manual integration test execution | When setting up integration test environments |
| [Pre-Release Checklist](./pre-release-checklist.md) | Pre-release verification items | When preparing version releases |

### Key Source File Quick Reference

| File | One-Line Description |
|------|---------------------|
| `src/core/EntityManager.ts` | CRUD, relation loading, transactions — the center of the ORM |
| `src/dialects/SqlDriver.ts` | `ISqlDriver` interface definition |
| `src/metadata/MetadataContext.ts` | AsyncLocalStorage-based tenant context |
| `src/scanner/MetadataScanner.ts` | Scanner base class using MetadataLayerRegistry |
| `src/metadata/LayeredMetadataStore.ts` | Trie-based layered metadata store |
| `src/decorators/Entity.ts` | `@Entity()` decorator — entity metadata snapshot |
| `src/decorators/Column.ts` | `@Column()` decorator — column metadata + type inference |
| `src/DatabaseClient.ts` | DB connection singleton (named connections support) |
| `src/dialects/TransactionSessionManager.ts` | Transaction lifecycle management |
| `src/core/BaseRepository.ts` | Repository pattern base class |
| `src/errors/OrmError.ts` | Error base class (`OrmErrorCode` based) |
| `src/index.ts` | Package public API entry point |
