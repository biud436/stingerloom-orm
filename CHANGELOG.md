# Changelog

All notable changes to this project are documented in this file.

Releases: https://github.com/biud436/stingerloom-orm/releases

---

## [0.5.0] — 2026-03-16

### Highlights

- **TenantQueryStrategy** — Configurable multi-tenant query routing for PostgreSQL. Choose `search_path` (default, safe, 5 round-trips) or `schema_qualified` (1 round-trip, prefixes table names with tenant schema).
- **Read-only query optimization** — `find`, `findOne`, `findWithCursor`, `count`, `sum`, `avg`, `min`, `max`, `explain` skip `BEGIN`/`COMMIT` when no transaction is needed — up to 80% fewer round-trips (#78, #86).

### Added

- **EntitySchema** — Decorator-free entity definitions via plain objects (#75)
- **Prisma Import** — Generate Stingerloom entities from existing Prisma schemas
- **`findWithPage()`** — Offset-based pagination API
- **Glob pattern entities** — Register entities with glob patterns like `__dirname + '/**/*.entity.ts'` (#76)
- **`validateOnBorrow`** — Connection health check (ping/SELECT 1) before pool checkout (#73)
- **Composite `@Index`** — Multi-column indexes with `@Index({ columns: ['a', 'b'] })` (#83)
- **`onDelete` / `onUpdate`** — FK referential actions on `@ManyToOne` (#84)
- **`createForeignKeyConstraints`** — Option to disable FK constraint generation (#85)
- **Plugin system** — `em.extend()` (dayjs-style), `StingerloomPlugin` interface, `PluginContext`, dependency/conflict validation, LIFO shutdown
- **Buffer plugin** (experimental) — entity change tracking, Identity Map, dirty checking, batch flush
- **GitHub Actions CI** + multi-tenant stress tests (#81, #82)

### Performance

- O(1) scanner target index + `resolveAll()` cache (#77, #80)
- Pluggable QueryBuilder strategy — swappable SQL generation backends (#72)

### Fixed

- 3 query builder bugs (#65, #67, #71)
- MySQL ENUM DDL and datetime format
- pnpm version conflict in CI workflow

**Full Changelog**: https://github.com/biud436/stingerloom-orm/compare/v0.4.0...v0.5.0

---

## [0.4.0] — 2026-03-14

### Breaking Changes

- `find()` now returns `T[]` instead of `EntityResult<T>` (#54)
- `DatabaseNotConnectedError` now extends `OrmError` (was `Exception`)

### Added

- **skip/take pagination** alongside existing `limit` tuple (#55)
- **SQL query logging** via `logging: true` or `logging: { queries: true }` (#56)
- **`@Column({ default })`** for DB-level DEFAULT values in DDL (#57)
- **`updateMany()`** for conditional bulk UPDATE with affected count (#60)
- **Type-safe `relations`** via `RelationKeys<T>` type (#59)
- **`em.transaction()` callback API** with auto-commit/rollback (#64)
- **Schema sync safety**: `synchronize: 'safe'` (no drops) and `'dry-run'` (preview only) (#62)
- **`migrate:generate` CLI** command for auto-creating migration files (#63)
- **NestJS multi-DB `connectionName`** — `forRoot`/`forFeature`/`InjectRepository`/`InjectEntityManager` (#26)

### Improved

- **Actionable error suggestions** — `OrmError.suggestion` field on all error classes (#61)
- New error codes: `UNIQUE_VIOLATION`, `FK_VIOLATION`
- Deprecated `EntityResult<T>`, `FindCondition<T>`, `FindOperator<T>` (unused at runtime) (#58)
- `NamingStrategy` interface extraction + `SchemaDiff` precision (#27, #39)

### Fixed

- Scope DDL entity registration by connection in multi-DB environments
- SQLite SchemaDiff, N+1 batch, cascade memory, entity metadata (#32, #49, #50, #51)
- Critical/high/medium bugs (#43-#53)

**Full Changelog**: https://github.com/biud436/stingerloom-orm/compare/v0.3.0...v0.4.0

---

## [0.3.0] — 2026-03-12

### Highlights

- **EntityManager refactoring** — Extract 7 handler classes for separation of concerns (#40)
- **Optimistic Locking** — `@Version` decorator support (#29)
- **VitePress docs site** — GitHub Pages deployment (#41)
- **`WhereClause<T>` type safety** — Remove `Record<string, any>` for stricter typing (#37)

### Fixed

- Reuse DB connections within public EntityManager methods (#30)
- Preserve original error info in `DatabaseConnectionFailedError` (#33)
- SQL injection safeguards in `Conditions.raw()` and `aggregate()` (#35)
- Isolate `FOREIGN_KEY_CHECKS` to single connection in `MySqlDriver.clear()` (#36)
- Filter metadata by target class in `@Entity` decorator (#38)
- Validate savepoint names to prevent SQL injection (#28)
- Non-numeric PK warning in cursor pagination per dialect

### Performance

- O(1) circular buffer in `QueryTracker` (#34)

**Full Changelog**: https://github.com/biud436/stingerloom-orm/compare/v0.2.1...v0.3.0

---

## [0.2.1] — 2026-03-09

### Added

- **`@CreateTimestamp()` decorator** — auto-set current time on INSERT
- **`@UpdateTimestamp()` decorator** — auto-set current time on INSERT and UPDATE
- **`timestamptz` column type** — PostgreSQL `TIMESTAMPTZ` (MySQL: `DATETIME`, SQLite: `TEXT` fallback)

### Docs

- `@CreateTimestamp`/`@UpdateTimestamp` section in entities guide
- Full docs and example READMEs translated to English

**Full Changelog**: https://github.com/biud436/stingerloom-orm/compare/v0.2.0...v0.2.1

---

## [0.2.0] — 2026-03-08

### Added

- **NestJS integration module** (`@stingerloom/orm/nestjs`)
  - `StinglerloomOrmModule` — `forRoot()` / `forFeature()`
  - `InjectRepository` — NestJS repository injection decorator
  - `typesVersions` for `moduleResolution: "node"` compatibility
  - Removed 16 duplicate files across 4 examples (-729 lines)

**Full Changelog**: https://github.com/biud436/stingerloom-orm/compare/v0.1.2...v0.2.0

---

## [0.1.2] — 2026-03-07

### Added

- **nestjs-todo example**

**Full Changelog**: https://github.com/biud436/stingerloom-orm/compare/v0.1.1...v0.1.2

---

## [0.1.1] — 2026-03-07

### Added

- **MCP server** — MySQL/PostgreSQL direct access
- **IConnection interface** + per-dialect connections + connection leak detector
- **Advisory lock** + nested transaction savepoint propagation
- `{propertyName}Id` FK auto-convention for `save()` / `insertMany()`

### Fixed

- `WhereClause<T>` type unification, 28 `as any` removed, `skip→limit` bug
- Partial update FK preservation + `save()` return type
- ManyToOne FK column deduplication on INSERT/UPDATE

### Security

- SQL Injection 6 vulnerabilities fixed (MySqlDriver 5, SchemaDiff 1)
- `getAllInContext()` tenant data leak prevention
- `AsyncLocalStorage` concurrency safety (`resolveContext()`)

**Full Changelog**: https://github.com/biud436/stingerloom-orm/compare/v0.1.0...v0.1.1

---

## [0.1.0] — 2026-03-07 (initial npm release)

Full feature set from 2026-02-22 to 2026-03-07 development.

### Core

- **CRUD** — `find`, `findOne`, `findAndCount`, `save`, `delete`, `softDelete`, `restore`, `upsert`
- **Batch** — `insertMany`, `saveMany`, `deleteMany`
- **Aggregation** — `count`, `sum`, `avg`, `min`, `max`
- **Raw Query** — `query<T>(sql, params?)`
- **BaseRepository** — per-entity CRUD wrapper

### Relations

- `@ManyToOne`, `@OneToMany`, `@OneToOne`, `@ManyToMany`
- Eager / Lazy loading, Cascade, ManyToMany join table DDL auto-generation

### Schema & Migrations

- `SchemaGenerator` — syncSchema/createTable DDL
- `SchemaDiff` + `SchemaDiffMigrationGenerator`
- `MigrationRunner` + `MigrationCli`

### Decorators

- `@Entity`, `@Column`, `@PrimaryGeneratedColumn`, `@PrimaryColumn`
- `@Index`, `@UniqueIndex`, `@Version`, `@DeletedAt`
- Lifecycle hooks: `@BeforeInsert`, `@AfterInsert`, `@BeforeUpdate`, `@AfterUpdate`, `@BeforeDelete`, `@AfterDelete`
- Validation: `@NotNull`, `@MinLength`, `@MaxLength`, `@Min`, `@Max`
- `@Transactional` (AsyncLocalStorage-based)

### Drivers

- **MySQL/MariaDB** — connection pooling, Read Replica
- **PostgreSQL** — schema-qualified identifiers, ENUM type
- **SQLite**

### Multi-Tenancy

- Layered metadata (Docker OverlayFS model)
- `MetadataContext.run()` — AsyncLocalStorage-based context switching
- `TenantMigrationRunner` — PostgreSQL schema-based auto-provisioning

### Advanced

- Cursor-based pagination, EXPLAIN query analysis, N+1 detection
- Event system + `EntitySubscriber` pattern
- Connection pooling, retry (exponential backoff), query timeout
- Read Replica, multi-DB (named connections)
- `propagateShutdown()`, SQL Injection prevention
