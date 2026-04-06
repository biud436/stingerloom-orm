# Changelog

All notable changes to this project are documented in this file.

Releases: https://github.com/biud436/stingerloom-orm/releases

---

## [0.14.0] — 2026-04-06

### Highlights

- **QueryDSL-style expressions (`qAlias`)** — Access entity properties directly and chain condition methods like `u.firstName.eq("Alice")`, `u.age.gte(18)`, `p.status.in(["active"])`. Powered by ES Proxy with full TypeScript autocomplete — no code generation required. A first in the Node.js ORM ecosystem.
- **Entity-aware joins** — Pass entity classes to `leftJoin(User, "u", ...)` instead of raw table names. The ORM resolves table names and column mappings automatically, including SnakeNamingStrategy support.
- **Relation-based auto-joins** — `leftJoinRelation("author", "u")` reads `@ManyToOne` / `@OneToMany` metadata and generates the ON condition automatically.
- **Cross-entity column resolution** — Use `"alias.property"` notation in `where()`, `selectRaw()`, `addOrderBy()`, `groupBy()`, and all WHERE helpers. The alias registry resolves property names to DB column names across all joined entities.

### Added

- **`qAlias(Entity, alias)`** — QueryDSL-style Proxy-based entity reference with 13 expression methods: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `notLike`, `in`, `notIn`, `isNull`, `isNotNull`, `between`
- **`alias(Entity, alias)`** — Lightweight typed entity reference with `.col()` method for autocomplete
- **`ColumnExpression`** / **`ColumnCondition`** classes — Deferred condition resolution through alias registry
- **`JoinOnBuilder`** class — Fluent ON condition builder with `.on()`, `.andOn()`, `.onVal()` methods
- **Entity-aware `leftJoin` / `innerJoin` / `rightJoin`** overloads accepting entity class + JoinOnBuilder callback
- **`leftJoinRelation` / `innerJoinRelation`** — Auto-derive ON from `@ManyToOne`, `@OneToMany`, `@OneToOne` metadata
- **`leftJoinAndSelect` / `innerJoinAndSelect`** — Join + auto-SELECT all joined entity columns
- **`leftJoinRelationAndSelect` / `innerJoinRelationAndSelect`** — Relation join + auto-SELECT
- **`selectRaw(columns)`** — Cross-entity SELECT using `"alias.property"` notation
- **Cross-entity `where` / `andWhere` / `orWhere`** — String overloads accepting `"alias.property"` references
- **Cross-entity `whereIn` / `whereNotIn` / `whereNull` / `whereNotNull` / `whereBetween` / `whereLike`** — All WHERE helpers support alias-prefixed column references
- **Cross-entity `addOrderBy` / `groupBy`** — String overloads for cross-entity sorting and grouping
- **`@RelationColumn` decorator** — Declarative FK column mapping, replaces deprecated `joinColumn` option (#215)
- **`exists()` / `findByPK()` / `findByPKs()`** — Convenience methods on EntityManager and BaseRepository (#218)
- **`batchUpsert` / `streamBatch`** — Batch upsert and async generator streaming (#221-#222)
- **`NOWAIT` / `SKIP LOCKED` locking** — `forUpdateNowait()`, `forUpdateSkipLocked()`, `forShareNowait()`, `forShareSkipLocked()` (#223)
- **Index hints** — `useIndex()`, `forceIndex()`, `ignoreIndex()` for MySQL, `hint()` for PostgreSQL (#224)
- **Replica health check** — `ReplicationManager.healthCheck()` (#225)
- **`DialectExpression` strategy** — Dialect-aware SQL expression generation (ILIKE translation, full-text search)
- **`ColumnTypeRegistry`** — Extensible column type transformer registry
- **Plugin hooks** — `onBeforeQuery` / `onAfterQuery` / `onSchemaSync` plugin lifecycle hooks (#227-#228)
- **Driver registry** — `DriverRegistry.register()` for custom driver plugins (#229)
- **Metadata API** — Public `MetadataExplorer` for runtime entity/column introspection (#230)
- **Migration hooks** — `onBeforeMigration` / `onAfterMigration` lifecycle (#231)
- **Test utilities** — `createTestEntityManager()` helper for plugin/extension testing (#232)
- **Protected repository** — `BaseRepository` fields made `protected` for extensibility (#233)
- **Version-aware DDL** — `DialectCapabilities` for conditional DDL based on database version
- **Runtime `DatabaseClientOptions` validation** — Fail-fast on invalid configuration (#217)

### Changed

- `SelectQueryBuilder` / `RawQueryBuilder` fields changed from `private` to `protected` for subclass extensibility (#226)
- `joinColumn` option in `@ManyToOne` / `@OneToOne` deprecated in favor of `@RelationColumn` (#215)
- `WhereOperator` extracted as named type for reuse
- Dialect-specific `MigrationRunner` subclasses extracted from monolithic runner

### Fixed

- SQLite `DatabaseClientOptions` no longer requires dummy `host`/`port`/`username`/`password` values (#216)
- Removed deprecated `FindCondition` / `FindOperator` exports (#219)
- Broken Unicode character in Korean query-builder docs

### Performance

- Eliminated per-transaction `SET autocommit` round-trip on MySQL/MariaDB (#209)
- Skipped redundant `SET TRANSACTION ISOLATION LEVEL` / `SET search_path` when unchanged (#212)
- Batch `saveMany()` reduces round-trips (#213-#214)

### Documentation

- Complete rewrite of query-builder JOIN section with entity-aware, relation-based, and cross-entity examples
- Added `qAlias()` QueryDSL guide with full method reference table
- Added aggregate functions (AVG/SUM/COUNT/MIN/MAX) and subquery examples (WHERE IN, EXISTS, FROM, CTE)
- Added `joinAndSelect` examples
- Added troubleshooting guide (#220)
- Added documentation for 15 new features (#218-#233)

### Tests

- 146 unit test suites, **3,289 tests passed**, 0 failures
- 13 SQLite integration suites, 196 tests passed
- 5 example projects e2e: 139 tests passed (cats 32, blog 59, todo 9, todo-sqlite 6, multitenant 33)

---

## [0.13.0] — 2026-04-06

Internal version bump (pre-release build).

---

## [0.12.0] — 2026-03-31

### Highlights

- **SQL expressions in `updateMany`** — Pass raw SQL via `sql` template tag in SET values for column arithmetic, DB functions, and complex update patterns. Enables blog-style patterns like `sql\`pos + 1\`` without a dedicated UpdateQueryBuilder.
- **`findOneOrFail` / `getOneOrFail`** — Fail-fast entity retrieval that throws `EntityNotFoundError` instead of returning null. Available on EntityManager, BaseRepository, and SelectQueryBuilder.

### Added

- **`UpdateData<T>` type** — `updateMany` SET clause now accepts `Sql` expressions alongside literal values (#210)
- **`EntityManager.findOneOrFail()`** — Returns entity or throws `EntityNotFoundError` (#211)
- **`BaseRepository.findOneOrFail()`** — Repository-level delegation (#211)
- **`SelectQueryBuilder.getOneOrFail()`** — QueryBuilder-level fail-fast retrieval (#211)
- **`sql`, `raw`, `join`, `empty`, `Sql` re-exports** — `sql-template-tag` utilities available directly from `@stingerloom/orm`

### Fixed

- Skip dialect-specific DDL tests when target DB is disabled in CI

### Benchmarks

- Write operation benchmark (save vs insertMany vs buffer vs raw)
- `pipe().raw()` and `pipe().collect()` benchmarks

### Tests

- 10 new unit tests (find-one-or-fail, update-many-sql-expression)
- MySQL/PostgreSQL driver DDL integration tests (+60 tests)
- SQLite integration tests for soft-delete, batch ops, timestamps, hooks, queries
- **Total: 3,009 unit tests passed, 0 failures (133 suites)**

**Full Changelog**: https://github.com/biud436/stingerloom-orm/compare/v0.11.0...v0.12.0

---

## [0.11.0] — 2026-03-29

### Highlights

- **RawPipeline Plugin** — Large-data transformation without entity overhead. Process millions of rows with `pipe()` and `pipe().raw()` using AsyncGenerator streaming, keyset pagination, and binary mode for MySQL/PostgreSQL.
- **Bundle Optimization** — 41% smaller tarball and 30% faster cold start through subpath exports and optional `class-transformer`.
- **ResultTransformer Metadata Caching** — Per-entity metadata caching for faster result transformation (#208).

### Added

- **`RawPipeline` plugin** — `em.extend(rawPipelinePlugin())` enables `pipe().from(Entity).where(...).each(fn)` and `pipe().raw()` for streaming large datasets without entity instantiation
- **Keyset pagination in RawPipeline** — Efficient cursor-based iteration via WhereResolver integration
- **Binary mode** — MySQL/PostgreSQL binary protocol for reduced serialization overhead; MySQL selective `typeCast` reduces memory by 49%
- **`ColumnDefinitionBuilder`** — Extracted column definition building into dedicated builder class

### Performance

- **Bundle size** — 41% smaller tarball, 30% faster cold start (subpath exports, optional `class-transformer`)
- **ResultTransformer** — Cache per-entity metadata to avoid repeated reflection lookups (#208)
- **RawPipeline transactions** — Eliminate per-batch transaction overhead in `pipe().raw()`
- **MySQL binary mode** — 49% memory reduction with selective `typeCast`

### Security

- **SQL injection hardening** — Additional parameter binding defenses in `RawQueryBuilder` and `SchemaDiffMigrationGenerator`

### Fixed

- VitePress Korean docs bold formatting not rendering (markdown-it bug workaround)
- `.gitignore` patterns updated

### Docs

- Raw Pipeline guide with benchmark results (EN + KO)
- Binary mode benchmarks for MySQL and PostgreSQL (per-driver comparison, stream-and-discard benchmark)
- Bundle optimization documentation (subpath exports, optional class-transformer)
- Expanded VitePress sidebar sections

### Tests

- Binary mode integration tests for MySQL and PostgreSQL
- 6 new unit test files (+172 tests) — RelationLoader, ExplainQueryHandler, TransactionSessionManager, LayeredMetadataStore, LayeredMetadataScanner, NestJS integration
- Statement coverage: 79.6% → 81.8%
- **Total: 3,846 passed, 21 skipped, 0 failures (171 suites)**

**Full Changelog**: https://github.com/biud436/stingerloom-orm/compare/v0.9.0...v0.11.0

---

## [0.9.0] — 2026-03-28

### Highlights

- **NamingStrategy** — Pluggable naming strategies with built-in `SnakeNamingStrategy`. Automatically maps camelCase entity properties to snake_case DB columns across all operations (SELECT, INSERT, UPDATE, DELETE, soft-delete, restore). ResultTransformer remaps column names back to entity properties.
- **Synchronize modes** — `synchronize: true | "safe" | "dry-run"` now fully functional. `true` performs CREATE + ADD + ALTER + DROP + RENAME; `"safe"` only creates/adds; `"dry-run"` logs DDL without executing. Closes #137.
- **UUID column type** — `@PrimaryGeneratedColumn("uuid")` with UUIDv7 support for time-ordered, sortable primary keys. Closes #189, #190.

### Added

- **`NamingStrategy` interface + `SnakeNamingStrategy`** — `tableName()`, `columnName()`, `joinColumnName()` hooks with full CRUD integration (#206)
- **Synchronize `true` / `"safe"` / `"dry-run"` modes** — SchemaDiff-driven ALTER/DROP/RENAME for existing tables (#137)
- **UUID column type with UUIDv7** — Time-ordered UUID generation without external dependencies (#189, #190)
- **Column transformers & computed columns** — `@Column({ transformer })` for value conversion on read/write
- **ENUM value synchronization** — PostgreSQL `ALTER TYPE ... ADD VALUE` for new enum entries
- **Advanced indexes** — Full-text search index support
- **Seeding system** — `Seeder` / `SeederRunner` for database seeding with atomicity and concurrency control
- **Introspection** — Generate entity classes from existing database schemas

### Fixed

- 14 issues: SQL injection, identifier escaping, validation, tenant isolation (901226e)
- 6 issues: MySQL rollback, cursor NULL handling, inheritance, enum diff, `@AfterLoad`, transaction events (#176–#182)
- `whereIn()` / `whereNotIn()` with empty array generates valid SQL instead of crashing (#184)
- 30+ issues across ORM core, query builder, metadata, drivers, and tooling (719f6f1)
- Migration/seeder atomicity and concurrency fixes
- MySQL ENUM requires explicit value definitions (#138)
- 6 bug fixes (#120–#125)
- Column type expression methods renamed for clarity

### Docs

- **Korean localization (VitePress)** — 5 phases complete: infrastructure, core pages, entity manager, advanced/integration, tutorials/reference (11 pages)
- IoT tutorial expanded with DDL, design decisions, testing, and production guide
- Full-text search, introspection, ENUM sync, and seeding system documentation

### Tests

- 6 SQLite integration test files (91 new tests) — #118, #119
- Multi-driver integration tests for MySQL/PostgreSQL
- Snake-naming-strategy integration test
- **Total: 2,669 passed, 19 skipped, 0 failures**

**Full Changelog**: https://github.com/biud436/stingerloom-orm/compare/v0.8.0...v0.9.0

---

## [0.7.0] — 2026-03-22

### Highlights

- **SelectQueryBuilder 3-tier execution** — `getMany()` (class instances with required-column validation), `getPartialMany()` (typed `Pick<T, K>` plain objects), `getRawMany()` (untyped). Compile-time projection narrowing and runtime safety in one API.
- **Docs site overhaul** — Sidebar restructured from 3 to 8 collapsible groups, 6 new pages, package manager tab controls, Write Buffer split into Basics/Advanced.

### Added

- **`getMany()` / `getPartialMany()` / `getRawMany()`** — 3-tier SelectQueryBuilder execution methods with `Pick<T, K>` type narrowing (#SelectQueryBuilder)
- **`validate()` / `validateArray()`** — Per-row and array-level result validation hooks (supports Zod, io-ts, or plain functions)
- **`getPartialManyAndCount()`** — Typed pagination with `Pick` narrowing + total count
- **`exists()`** — Boolean existence check without fetching data
- **Migration CLI executable** — `npx stingerloom migrate:run|rollback|status|generate` (#66)
- **Dual CJS/ESM build** — Both `require()` and `import` work out of the box (#68)
- **SchemaDiff column rename detection** — Heuristic matching generates `RENAME COLUMN` instead of drop+add (#74)
- **Actionable error messages** — `OrmError.suggestion` field with fix hints across all error classes (#70)
- **`stream()`** — AsyncGenerator-based streaming for large dataset processing (#112)
- **`distinct` in FindOption** — `SELECT DISTINCT` via `em.find(E, { distinct: true })` (#113)
- **Deadlock retry** — `em.transaction(fn, { retryOnDeadlock: true })` (#114)
- **RawQueryBuilder set operations** — `union()`, `unionAll()`, `intersect()`, `except()` (#110)
- **Common Table Expressions** — `with()`, `withRecursive()` for CTEs (#111)
- **Window functions** — `selectWithWindow()` with ROW_NUMBER, RANK, LAG, etc. (#113)
- **`selectDistinctOn()`** — PostgreSQL `DISTINCT ON` support

### Docs

- **6 new documentation pages**: Raw SQL & CTE, Pagination & Streaming, Migration CLI, Events & Subscribers, Logging & Diagnostics, NestJS Integration
- **Write Buffer split** into Basics (Identity Map, dirty checking, flush, cascade) and Advanced (lazy loading, locking, batch DML, flush modes, nested UoW)
- **Sidebar restructured** from 3 groups to 9 collapsible groups (Introduction, Essentials, Querying, Schema & Migrations, Advanced, Plugins, NestJS, Deployment, Reference)
- **Package manager tabs** — npm/pnpm/yarn code groups on installation commands
- **Plugins section** separated from Advanced with expanded Write Buffer coverage

### Performance

- **Read-only query optimization** — `findAndCount()` skips `BEGIN`/`COMMIT` wrapper
- **`RETURNING *`** — PostgreSQL `save()` uses RETURNING instead of re-fetching

### Fixed

- SelectQueryBuilder `getMany()` returns class instances when no projection is used
- SelectQueryBuilder JOIN double alias generation + `getSql()` placeholder format
- Nested `@OneToOne` eager loading and deep NULL detection (#116, #117)
- 6 bug fixes: FK constraint check, savepoint naming, entity metadata scope, query builder edge cases (#104–#109)
- 5 additional bug fixes (#99–#103)
- Tenant provisioning lock cleanup on failure (#98)
- `dirtyEntities` cleared after transaction completion (#97)
- Cascade save uses parent's transaction session

### CI

- GitHub Actions: PostgreSQL, MySQL, and SQLite integration test jobs
- Sequential integration test execution to prevent resource conflicts

**Full Changelog**: https://github.com/biud436/stingerloom-orm/compare/v0.6.2...v0.7.0

---

## [0.6.2] — 2026-03-20

### Fixed

- **SQLite driver compatibility** — boolean value sanitization, Date handling, result array wrapping, and soft delete for `better-sqlite3` (#95, #96)
- SQLite example project added

**Full Changelog**: https://github.com/biud436/stingerloom-orm/compare/v0.6.0...v0.6.2

---

## [0.6.0] — 2026-03-20

### Highlights

- **WriteBuffer (Unit of Work)** — Hibernate/Doctrine-grade UoW with Identity Map, dirty checking, cascade, batch flush, lazy loading, pessimistic locking, nested savepoints, and flush events.
- **Plugin system** — `em.extend(plugin)` API (dayjs-style) with dependency/conflict validation and LIFO shutdown.

### Added

- **Plugin system infrastructure** — `StingerloomPlugin` interface, `em.extend()`, `PluginContext`
- **Buffer plugin** — `bufferPlugin()` adds `em.buffer()` for Unit of Work pattern
  - Identity Map with PK-based conflict detection
  - Dirty checking with deep snapshot/diff
  - Entity states: NEW → MANAGED → DETACHED → REMOVED
  - `persist()`, `remove()`, `save()`, `delete()`, `track()`, `detach()`, `merge()`, `refresh()`
  - `flush()` — atomic transaction with topological ordering (Kahn's algorithm)
  - `preview()` / `computeChanges()` — dry-run inspection
  - Cascade insert/update/delete through @OneToMany, @OneToOne, @ManyToMany
  - Orphan removal for O2M collections
  - Lazy relation proxies (auto-injected on all 4 relation types)
  - `getReference()` — lightweight PK-only identity-mapped reference
  - Pessimistic locking (`LockMode.PESSIMISTIC_WRITE` / `PESSIMISTIC_READ`)
  - Batch INSERT (multi-row) and batch UPDATE (CASE WHEN)
  - Bulk DML: `updateMany()` / `deleteMany()`
  - Flush events: pre/post Insert/Update/Delete
  - Read-only entities (`markReadOnly`)
  - Change tracking policy: DEFERRED_IMPLICIT / DEFERRED_EXPLICIT
  - Flush modes: MANUAL / AUTO / COMMIT / ALWAYS
  - PersistentCollection — array mutation detection proxy
  - Nested UoW with SAVEPOINT support
  - 33 integration tests x 2 drivers (MySQL + PostgreSQL)

### Refactored

- WriteBuffer decomposed into 8 sub-modules: IdentityMapManager, CascadeProcessor, FlushExecutor, LazyRelationInjector, DependencyGraph, BufferStrategy, CollectionTracker, PersistentCollection

### Fixed

- 4 WriteBuffer defects: nested SAVEPOINT, bulk DML in-memory sync, pessimistic lock timing, lazy proxy first-access

### Docs

- Architecture overview with module hierarchy diagrams
- Tenant strategy round-trip latency explanation
- Plugins guide and WriteBuffer (UoW) guide

**Full Changelog**: https://github.com/biud436/stingerloom-orm/compare/v0.5.0...v0.6.0

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
