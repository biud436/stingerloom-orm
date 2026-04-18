# Changelog

All notable changes to this project are documented in this file.

Releases: https://github.com/biud436/stingerloom-orm/releases

---

## [0.19.0] — 2026-04-18

### Highlights

Three QueryDSL tiers, rolled into one release — `qAlias()` coverage vs. Java QueryDSL 5.x grows from ~10–15% to ~55–65%, with deliberate departures from Java idioms wherever TypeScript / Node already has a better answer.

- **Tier 1 (PR #256) — ordering, aggregates, logical composition, string convenience.** Four groups of helpers on `ColumnExpression` — `.asc/.desc/.nullsFirst/.nullsLast`, `.count/.countDistinct/.sum/.avg/.min/.max`, `.and/.or/.not` composition, and LIKE-escape-safe `.startsWith / .endsWith / .contains` (+ `*IgnoreCase` siblings). A shared `ConditionLike` contract unifies column, JSON-path, aggregate, and logical conditions — they mix freely in `where()`, `andWhere()`, `having()`, etc. Every user value (including the LIKE escape character) stays a bound parameter.
- **Tier 2 (PR #257) — scalar expressions, CAST, date parts, subqueries, CASE.** New `ScalarExpression` foundation drives null handling (`coalesce`, `nullif`), type casts (`.stringValue / .intValue / .longValue / .floatValue / .booleanValue`), date-component extraction (`.year / .month / .day / .hour / .minute / .second / .dayOfWeek / .dayOfMonth / .dayOfYear / .week`), subquery comparisons (`.in(subQb)`, `.eq(subQb)`, `Expressions.exists / notExists`), current-time literals (`currentDate / currentTime / currentTimestamp`), and two fluent `CASE WHEN … THEN …` builders (searched `caseBuilder()` + simple `cases(subject)`). `.as("alias")` is promoted to every projectable expression; `RawQueryBuilder.selectFragments()` preserves parameter bindings in SELECT so JSON-path aliases survive execution.
- **Tier 3 (PR #258) — TS/Node-native re-plan.** Explicitly drops Java-style `Projections.constructor`, `stringTemplate`, and `useLiterals` — TS generics + `.as()` + `getRawMany<T>()` + `sql-template-tag` already cover those idiomatically. Adds what a TypeScript developer expects: JS-idiomatic `String.prototype` / `Math.*` / arithmetic-operator-style helpers (`.toLowerCase / .substring(s, e?) / .indexOf / .replace / .add / .sub / .mul / .div / .mod / .neg / .abs / .floor / .ceil / .round / .sqrt`), date arithmetic (`.addYears/Months/Days/Hours/Minutes/Seconds`, `Expressions.dateDiff`, `Expressions.random`), window functions (`aggregate.over().partitionBy().orderBy().rowsBetween()`), and three TS-native escape hatches: `Expressions.raw<T>(sql`…`)`, `.bigintValue()`, and `qb.selectSchema(zodSchema)` with `z.infer`-driven `TResult` narrowing.

### Added

#### Tier 1 — base expression surface

- **`OrderExpression`** — returned by `ColumnExpression.asc()/.desc()` and `AggregateExpression.asc()/.desc()`; chain `.nullsFirst()` / `.nullsLast()` to control NULL ordering
- **`AggregateExpression` / `AggregateCondition`** — aggregates render inside SELECT (via `.as("alias")` — explicit alias recommended; falls back to a predictable `agg_<func>_<col>` shape) and double as HAVING / WHERE conditions through `.eq / .neq / .gt / .gte / .lt / .lte / .between`
- **`LogicalCondition` + `Expressions` namespace** — AND / OR / NOT composition over any `ConditionLike`. Contiguous AND / OR chains flatten in the emitted SQL
- **`ConditionLike` interface** — shared contract unifying `ColumnCondition`, `JsonPathCondition`, `AggregateCondition`, and `LogicalCondition`; `resolve()` threads the alias registry and dialect strategy through uniformly
- **`DialectExpression.caseInsensitiveLike(column, pattern)`** — collation-independent case-insensitive LIKE; `ILIKE ... ESCAPE '\'` on PostgreSQL, `LOWER(col) LIKE LOWER(pattern) ESCAPE '\'` on MySQL / SQLite
- **`escapeLikeValue(value)`** — helper that escapes `%`, `_`, and `\` so user-supplied text never silently acts as a LIKE wildcard
- **String convenience methods on `ColumnExpression`** — `.startsWith / .endsWith / .contains` (auto-escape metacharacters, emit `LIKE … ESCAPE '\'`), `.equalsIgnoreCase` (`LOWER() = LOWER()` on every dialect), `.likeIgnoreCase`, `.startsWithIgnoreCase`, `.endsWithIgnoreCase`, `.containsIgnoreCase`

#### Tier 2 — scalar expressions, CAST, date parts, subqueries, CASE

- **`AliasedExpression` + `.as()`** — promoted to `ColumnExpression`, `JsonPathExpression`, and `AggregateExpression`. SELECT-only (not a `ConditionLike`)
- **`ScalarExpression` / `ScalarCondition`** — deferred scalar SQL with SELECT + comparison dual role; plugs into AND/OR/NOT; the foundation for Tier 2/3 expressions (`coalesce`, CAST, date components, window, CASE, …)
- **`coalesce(a, b, …)` / `nullif(a, b)`** — free functions and `col.coalesce(...fallbacks)` shorthand; `Expressions.coalesce` / `Expressions.nullif` for the static surface
- **CAST helpers** — `.stringValue / .intValue / .longValue / .floatValue / .booleanValue` on column and scalar; dialect type names via `DialectExpression.castTypeName(kind)` (MySQL `CHAR / SIGNED / DECIMAL / UNSIGNED`, PostgreSQL `TEXT / INTEGER / BIGINT / REAL / BOOLEAN`, SQLite `TEXT / INTEGER / REAL / INTEGER`)
- **Date component extraction** — `.year / .month / .day / .hour / .minute / .second / .dayOfWeek / .dayOfMonth / .dayOfYear / .week` via `DialectExpression.dateComponent(value, component)`. `EXTRACT(...)` on PostgreSQL, `YEAR(...)/MONTH(...)/…` on MySQL, `strftime('%Y/%m/...', ...)` on SQLite — always wrapped in `CAST(... AS INTEGER)` where necessary
- **Current-time literals** — `Expressions.currentDate() / .currentTime() / .currentTimestamp()` return `ScalarExpression`; inline in SQL rather than binding as parameters
- **Subquery operators** — `ColumnExpression.in(subQb)`, `.notIn(subQb)`, scalar `.eq/.neq/.gt/.gte/.lt/.lte(subQb)`; `Expressions.exists(subQb)` / `Expressions.notExists(subQb)` return a negation-toggling `ExistsCondition`
- **`CaseBuilder` + `CaseValueBuilder`** — fluent searched (`caseBuilder().when(cond).then(val)…`) and simple (`cases(subject).when(val, result)…`) CASE forms with terminal `.end()` / `.as(alias)`; early misuse guards for `.when()` after `.otherwise()`, duplicate `.otherwise()`, and empty `.end()`
- **`RawQueryBuilder.selectFragments(fragments, distinct)`** — parameter-preserving SELECT segment used by `AliasedExpression` to carry JSON path bindings through execution

#### Tier 3 — TS/Node-native helpers

- **JS-idiomatic string / numeric / math methods** on column and scalar: `.toLowerCase / .toUpperCase / .trim / .length / .substring(start, end?) / .concat(...args) / .indexOf(needle) / .replace(from, to)`, `.add / .sub / .mul / .div / .mod / .neg`, `.abs / .floor / .ceil / .round(digits?) / .sqrt`. `substring` uses JS 0-based / end-exclusive semantics; `length` uses `CHAR_LENGTH` (multibyte safe); `indexOf` shifts dialect-specific `STRPOS` / `LOCATE` / `INSTR` down by one so `-1` / 0-based results match `String.prototype.indexOf`
- **Date arithmetic** — `.addYears/Months/Days/Hours/Minutes/Seconds(n)` on column and scalar; `Expressions.dateDiff(a, b, unit)` returns integer difference (`TIMESTAMPDIFF` on MySQL, calendar-aware `age()` for year/month on PostgreSQL, `julianday()` on SQLite with 365.25 / 30.4375 approximations for year/month); `Expressions.random()` — `RAND()` / `RANDOM()`
- **`AggregateExpression.over()` + `WindowBuilder`** — fluent `PARTITION BY / ORDER BY / ROWS BETWEEN / RANGE BETWEEN` chain; `.as("alias")` and `.toScalar()` terminals
- **`Expressions.raw<T>(fragment)`** — typed raw `Sql`-fragment escape hatch that threads through the full Tier 2/3 composition surface (`.as`, `.eq`, `coalesce`, cast, …); parameter bindings inside the template survive end-to-end
- **`.bigintValue()`** — CAST sibling of `.longValue()` with a name signaling JS `bigint` intent; emits `BIGINT` / `SIGNED` / `INTEGER` per dialect. `CastKind` gains a `"bigint"` variant
- **`qb.selectSchema(schema)`** — attaches a Zod / Valibot / Effect-compatible schema as the row validator AND narrows `TResult` to `z.infer<typeof schema>` at the type level; pairs with the existing `.validate(schema)` for callers who prefer two explicit calls

### Changed

- `SelectQueryBuilder.select()` / `.addSelect()` accept `AggregateExpression`, `AliasedExpression`, or mixed arrays; aggregate-only / aliased-only `select()` resets the column list
- `SelectQueryBuilder.orderBy()` / `.addOrderBy()` accept `OrderExpression`; `orderByClauses` carries an optional `nulls` position. PostgreSQL and SQLite emit `NULLS FIRST` / `NULLS LAST` natively; MySQL emulates it with a `col IS NULL` ordering prefix
- `SelectQueryBuilder.where() / .andWhere() / .orWhere() / .having()` and `WhereGroupBuilder.where()` dispatch through `isConditionLike`, so any new condition type composes without further overloads
- `ColumnCondition.resolve()` now unwraps a `ScalarExpression` or subquery-like `SelectQueryBuilder` operand inline — so `u.expiresAt.gte(currentTimestamp())` and `u.id.in(subQb)` emit the expression / `(SELECT ...)` directly instead of binding the object as a parameter
- `ColumnCondition` and `JsonPathCondition` now implement `ConditionLike`; legacy `resolve(resolveColumn)` signatures gain an optional dialect parameter (fully backward compatible)

### DialectExpression additions

- Tier 1: `caseInsensitiveLike(column, pattern)`
- Tier 2: `castTypeName(kind)`, `dateComponent(value, component)`
- Tier 3: `stringIndexOf(haystack, needle)`, `dateAdd(value, n, unit)`, `dateDiff(a, b, unit)`, `random()`; `CastKind` extended with `"bigint"`

### Documentation

- `docs/query-builder.md` (EN) and `docs/ko/query-builder.md` (KO) gain thirteen new sections and matching summary-table rows — covering sorting, aggregates, logical composition, string convenience (Tier 1); SELECT aliasing, null handling, current time, CAST, date components, subquery comparisons, CASE (Tier 2); JS-idiomatic string / numeric / math, date arithmetic, window functions, raw / bigint / schema escape hatches (Tier 3). Dialect mapping tables included for CAST, date components, date arithmetic, and date-component engines (`DAYOFWEEK` encoding differences documented explicitly).

### Tests

- **Tier 1** — 100 new unit cases (`qdsl-tier1-*`) plus per-dialect integration suites: 21 SQLite, 17 MySQL, 17 PostgreSQL
- **Tier 2** — 112 new unit cases across seven files (`qdsl-tier2-aliased-expression`, `qdsl-tier2-nullish`, `qdsl-tier2-temporal`, `qdsl-tier2-cast`, `qdsl-tier2-date-component`, `qdsl-tier2-subquery`, `qdsl-tier2-case-builder`); regression clean on MySQL + PostgreSQL + SQLite via existing dual-driver suites
- **Tier 3** — 71 new unit cases across three files (`qdsl-tier3-string-numeric-math`, `qdsl-tier3-date-window-random`, `qdsl-tier3-ts-native`)
- **Full run** — 5,041 passed / 21 skipped / **0 failures** across 236 suites (unit + SQLite + MySQL + PostgreSQL), ~36s

**Full Changelog**: https://github.com/biud436/stingerloom-orm/compare/v0.16.1...v0.19.0

---

## [0.16.1] — 2026-04-12

### Highlights

- **Compiled query plans** — `SelectQueryBuilder.prepare()`, `RawQueryBuilder.prepare(em)`, and the EF.CompileQuery-style `em.compile()` memoize the SQL template once so repeated executions only substitute placeholder values. Built on top of the existing `toSql` / `build` path, so drivers stay untouched.
- **JSON path QueryDSL via `qAlias()`** — Writing `u.profile.contact.email.eq("…")` compiles to the right dialect-specific SQL (`#>>` on PostgreSQL, `JSON_EXTRACT` on MySQL, `json_extract` on SQLite). Covers comparisons, `LIKE`, `IN`, `IS NULL`, `contains`, `hasKey`, `arrayLength()`, `typeOf()`, and a `.path("a.b[0]")` escape hatch for dynamic or array paths. Every path segment, key, and value is parameter-bound — SQL-injection safe.

### Added

- **`SelectQueryBuilder.prepare<Params>()`** — Returns a `CompiledQuery<Result, Params>` with `execute(params)` / `executeOne(params)` that skip re-assembling SQL on each call
- **`SelectQueryBuilder.preparePartial()`** — Compiled variant for `getPartialMany()` projections
- **`RawQueryBuilder.prepare(em)`** — Compile hand-built SQL fragments once, parameterize via `sql-template-tag` placeholders
- **`em.compile<Result, Params>((em, $) => qb)`** — EF Core-style wrapper: supply a builder factory that consumes a `$.param` proxy; returns a reusable `CompiledQuery`
- **`JsonPathExpression`** — Proxy returned by `qAlias()` when a property is a `@Column({ type: "json" \| "jsonb" })`. Deep property access accumulates the JSON path; the final operator freezes the path into a `JsonPathCondition`
- **`JsonScalarExpression`** — Scalar result of `.arrayLength()` / `.typeOf()`; exposes `.eq`, `.gt`, etc. to compare JSON function results to values
- **`DialectExpression.jsonExtract` / `jsonContains` / `jsonHasKey` / `jsonArrayLength` / `jsonTypeOf`** — New strategy methods on the dialect expression interface, implemented for PostgreSQL (`#>>`, `#>`, `@>`, `?`, `jsonb_array_length`, `jsonb_typeof`), MySQL (`JSON_EXTRACT`, `JSON_CONTAINS`, `JSON_CONTAINS_PATH`, `JSON_LENGTH`, `JSON_TYPE`), and SQLite (`json_extract`, `json_array_length`, `json_type`)
- **`parseJsonPath("a.b[0].c")`** — Parser for the `.path()` escape hatch; handles identifiers, array indices, and quoted segments with punctuation

### Changed

- `qAlias<T>(Entity, alias)` now inspects `@Column` metadata at proxy creation; JSON-typed properties return `JsonPathExpression`, everything else still returns `ColumnExpression` (fully backward compatible)
- `SelectQueryBuilder.where()` / `.andWhere()` / `.orWhere()` gain a `JsonPathCondition` overload

### Documentation

- New **Navigating JSON Columns** section in `query-builder.md` (EN + KO) — problem-first, then `qAlias()` background, then TypeScript ↔ compiled SQL examples per operator, plus a dialect cheat sheet and a note on why `metadata` is a poor example column name
- New **Compiled Query Plans** section in `entity-manager-advanced.md` (EN + KO) — motivation, comparison with WriteBuffer / batch / streaming, and examples across all four entry points

### Tests

- 50 new unit cases covering path parsing, JSON column detection in `qAlias`, per-driver SQL snapshots, `JsonPathCondition.resolve()`, and SQL-injection regression
- 10 new SQLite in-memory integration cases exercising `eq` / `in` / `isNull` / `.path()` / `hasKey` / `arrayLength` / `typeOf` / scalar `contains` / combined JSON-plus-column filters end-to-end
- Compiled query plan tests (unit + SQLite integration) from the earlier compiled-queries commit
- No regressions: 3,590 unit + 296 SQLite integration pass

**Full Changelog**: https://github.com/biud436/stingerloom-orm/compare/v0.16.0...v0.16.1

---

## [0.16.0] — 2026-04-12

### Highlights

- **SSL/TLS for database connections (#240)** — New `ssl` option on `ServerDatabaseClientOptions` is forwarded to `mysql2` and `pg`, unlocking encrypted connections to managed cloud databases.
- **MariaDB-aware driver (#242)** — Four MariaDB-only capability flags let the MySQL driver exploit features that diverged from MySQL 8+. Single/batch/TPT inserts now go through `INSERT ... RETURNING` on MariaDB 10.5+, skipping the post-insert `SELECT` round-trip.
- **Native `UUID` column type on MariaDB 10.7+ (#242)** — 16-byte storage with correct ordering, gated behind `supportsNativeUuidType`. MySQL and older MariaDB keep the `CHAR(36)` fallback.
- **Minimum Node.js 22** — `engines.node` bumped; tooling now targets LTS.

### Added

- **`ssl` connection option** — `{ ssl: true }` or a full options object; propagates to `mysql2` / `pg` native SSL configuration (#240)
- **`supportsReturning()` / `supportsInsertReturning()` / `supportsNativeUuidType` / `supportsReturningOnUpdate`** — Capability flags on the MySQL driver for MariaDB-specific optimizations (#242)
- **`INSERT ... RETURNING` on MariaDB 10.5+** — Applied to single inserts, batch inserts, and TPT child inserts; removes an extra `SELECT` for just-inserted rows (#242)
- **Native `UUID` DDL type on MariaDB 10.7+** — Replaces `CHAR(36)` for `@Column({ type: "uuid" })` when the driver detects MariaDB 10.7+ at connect time (#242)

### Changed

- `UPDATE` path intentionally keeps the stricter `supportsReturning()` check — MariaDB does not support `UPDATE ... RETURNING`
- `ALL_MYSQL` defaults stay conservative (MariaDB-only flags off) so DDL produced without version detection remains MySQL-safe
- `engines.node` minimum bumped to `>=22`

### Fixed

- Prisma-import test: use a temp file instead of `node -e '...'` to avoid shell quoting failures on Windows
- Normalize backslashes in glob patterns before handing them to `fast-glob` — fixes entity discovery on Windows
- Add `__tests__/tsconfig.json` so IDE-side Jest type resolution works out of the box
- `.gitignore` tightened to exclude local analysis scratch files

**Full Changelog**: https://github.com/biud436/stingerloom-orm/compare/v0.15.0...v0.16.0

---

## [0.15.0] — 2026-04-11

### Highlights

- **Inheritance Mapping (STI / TPT / TPC)** — Full support for three classic ORM inheritance strategies: Single Table Inheritance, Table Per Type, and Table Per Class. Includes `@Inheritance`, `@DiscriminatorColumn`, `@DiscriminatorValue` decorators, polymorphic `find()` / `findOne()`, SelectQueryBuilder integration, EntitySchema support, and WriteBuffer flush with discriminator columns.
- **LRU Identity Map eviction** — `maxIdentityMapSize` option bounds memory growth with LRU eviction that never evicts dirty, NEW, or REMOVED entities (#237).
- **WriteBuffer enhancements** — Granular cascade options (`{ persist, merge, remove }`), `@Version` flush support, automatic `@CreateTimestamp` / `@UpdateTimestamp` handling during flush, and pre-flush validation (#239).

### Added

- **`@Inheritance(strategy)`** — Declare STI, TPT, or TPC strategy on root entity
- **`@DiscriminatorColumn(options)`** — Configure discriminator column name, type, and length (STI/TPT)
- **`@DiscriminatorValue(value)`** — Map entity class to discriminator value
- **`InheritanceResolver`** — Stateless service for resolving hierarchy metadata (`getStrategy`, `getRoot`, `getConcreteEntities`, `buildDiscriminatorMap`, `getOwnColumns`, `getAllHierarchyColumns`)
- **STI** — Single shared table with discriminator column; polymorphic `find()` auto-filters by dtype; child classes inherit parent columns
- **TPT** — Separate table per type with automatic JOIN queries; `find()` joins parent+child tables; child tables contain only own columns + FK to parent PK
- **TPC** — Independent table per concrete class; polymorphic `find()` generates `UNION ALL` across all concrete tables with NULL-padding for missing columns
- **SelectQueryBuilder inheritance support** — `withInheritance()` enables polymorphic queries; auto-JOIN (TPT), auto-WHERE discriminator (STI), UNION ALL (TPC)
- **EntitySchema inheritance** — `inheritance`, `discriminatorColumn`, `discriminatorValue`, `parent` options for decorator-free inheritance definitions
- **EntityRef in `createQueryBuilder` / joins** — Pass `EntityRef` directly to `createQueryBuilder()` and join methods (#238)
- **`maxIdentityMapSize`** — LRU eviction for bounded Identity Map; `size().identityMap` reports current size (#237)
- **Granular cascade options** — `cascade: { persist: true, merge: false, remove: true }` alongside boolean shorthand
- **`validateBeforeFlush`** — Run `@Validation` decorators before flush; throws on invalid entities
- **`@Version` flush support** — Optimistic locking version auto-increment during WriteBuffer flush
- **`@CreateTimestamp` / `@UpdateTimestamp` flush support** — Automatic timestamp assignment during WriteBuffer persist/merge

### Changed

- `BufferPluginOptions.cascade` accepts `boolean | CascadeOptions` (granular control)
- `manyToManySync` defaults to `cascade.persist` when granular cascade is used

### Tests

- 162 unit test suites, **3,493 tests passed**, 19 skipped, 0 failures
- 9 new integration test files: STI/TPT/TPC for MySQL+PostgreSQL and SQLite (including relations, QueryBuilder, WriteBuffer inheritance tests)
- 3 new unit test suites: STI, TPT, TPC inheritance

### Documentation

- Inheritance Mapping overview page (EN + KO)
- Deep-dive pages for STI, TPT, TPC strategies (EN + KO, 6 pages total)
- WriteBuffer docs updated with LRU eviction and granular cascade options
- API reference updated with inheritance decorators

**Full Changelog**: https://github.com/biud436/stingerloom-orm/compare/v0.14.0...v0.15.0

---

## [0.14.0] — 2026-04-09

### Highlights

- **First-level cache for WriteBuffer** — `findOne()` with PK-only WHERE skips the DB entirely when the entity is already in the Identity Map. ~480x faster for repeated lookups (benchmark included).
- **14 new SelectQueryBuilder methods** — `when()`, `pipe()`, `whereHas()`, `whereInSubquery()`, `addSelectSubquery()`, `applyScope()`, and more for expressive query building.
- **Tenant schema provisioning table filter** — Control which tables are provisioned per tenant with `tableFilter` option (#234).
- **Custom column type in timestamp decorators** — `@CreateTimestamp({ type: "timestamptz" })` and `@UpdateTimestamp({ type: "timestamptz" })` (#235, #236).

### Added

- **`WriteBuffer.findOne()` first-level cache** — PK lookup returns cached identity map instance, 0 DB round-trips
- **`assertTenantContext()`** — Warns when tenant context is missing in multi-tenant operations
- **`when()`** — Conditional query clause builder
- **`pipe()`** — Functional query transformation chain
- **`andWhereGroup()` / `orWhereGroup()`** — Grouped WHERE with `WhereGroupBuilder`
- **`whereHas()` / `whereNotHas()`** — Relation existence filters
- **`withCount()`** — Inline relation count subquery
- **`loadRelation()`** — Post-query relation loading
- **`whereInSubquery()` / `whereNotInSubquery()`** — Subquery-driven IN filters
- **`whereExistsSubquery()` / `whereNotExistsSubquery()`** — Correlated EXISTS
- **`addSelectSubquery()`** — Subquery as SELECT column
- **`applyScope()`** — Reusable query scopes
- Tenant provisioning `tableFilter` option (#234)
- `@CreateTimestamp` / `@UpdateTimestamp` custom `type` parameter (#235, #236)

### Performance

- `exists()` uses `SELECT 1 LIMIT 1` instead of `COUNT(*)` for early termination
- `findInternal()` deduplicates `buildPropertyToColumnMap` calls (3→1)
- `WriteBuffer.flush()` fast-checks `hasQueuedWork()` before expensive diff
- `toSql()` no longer mutates `whereClauses` (safe for `getManyAndCount`)
- `clone()` / `stream()` added to SelectQueryBuilder

### Fixed

- Allow hyphens in PostgreSQL identifier validation
- Fix `BaseRepository.createQueryBuilder` delegation bug

### Benchmarks

- Identity map first-level cache benchmark (`__tests__/bench/identity-cache-bench.ts`)

### Tests

- 159 unit test suites, **3,403 tests passed**, 0 failures
- 13 SQLite integration suites, 196 tests passed
- 5 example projects e2e: 139 tests passed

---

## [0.13.0] — 2026-04-06

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
