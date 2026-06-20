# Changelog

All notable changes to this project are documented in this file.

Releases: https://github.com/biud436/stingerloom-orm/releases

---

## [Unreleased]

Insert/save correctness fixes and query-builder expressiveness distilled from the blog-api-server TypeORM migration (#368-#372). One behavioral note: `*AndSelect` + `getRawMany()` now returns `alias_column`-prefixed keys (the SELECT list is fully aliased to prevent column clobbering).

### v1.0 release prep — public API cleanup, typed errors, doc accuracy (#382)

Major-version cleanup of the public surface ahead of v1.0. **Breaking:** deprecated exports that were silent no-ops or had direct replacements are removed. Load-bearing deprecated APIs (`joinColumn` option, `EntityResult<T>`, `connectionLimit`, `ISqlDriver.generateForeignKeyName()`) are intentionally kept for a later release. Verified: `tsc`/`pnpm build` clean, full unit suite + MySQL/PostgreSQL/SQLite integration green.

#### Removed (Breaking)

- **Layered-metadata facades** — `LayeredMetadataStore`, `LayeredMetadataScanner` (with `LayeredEntityScanner` / `LayeredColumnScanner` / `LayeredManyToOneScanner`), and `MultiTenantMetadataManager`. These were never wired into the decorator pipeline, so mutations through them were silent no-ops. Use `MetadataLayerRegistry.getInstance()` together with `MetadataContext.run(tenantId, callback)`.
- **Core `InjectRepository` / `InjectEntityManager`** (plus `getRepositoryToken`, `ENTITY_METADATA_TOKEN`, and the now-unused `ReflectManager.isEntityManager()`) — dead no-op decorators that shadowed the working ones by name. Import the canonical decorators from `@stingerloom/orm/nestjs`.
- **`ALL_CAPABILITIES`** — unused; use the dialect-specific `ALL_MYSQL` / `ALL_POSTGRES` / `ALL_SQLITE`.
- **`Conditions.raw()`** — use `Conditions.unsafeRaw()`, which names the SQL-injection risk explicitly.
- **Standalone `setDeserializer()` / `getDeserializer()`** — use `DeserializerRegistry.getInstance().setDeserializer()` / `.getDeserializer()`. `deserializeEntity()` is unchanged.

#### Changed (Breaking)

- **QueryDSL bare `raw` export renamed to `rawExpr`** to resolve a name collision: at the package root `raw` resolved to `sql-template-tag`'s `raw`, while `@stingerloom/orm/core`'s `raw` was the DSL helper, so the same identifier meant two different things depending on the entry point. The namespaced `Expressions.raw(...)` is unchanged.

#### Fixed

- **Typed errors on user-facing paths** — transaction isolation-level validation, NestJS service init (`getRepository`/`getEntityManager` before connect), `SeederRunner`, `getRawMany()` coercion, and `Conditions` operator validation now throw `OrmError` with an `OrmErrorCode` instead of a plain `Error`.
- **Replication health-check timer leak** — `ReplicationManager.shutdown()` now stops the health-check interval before dropping the router, and the interval is `.unref()`'d so it never keeps the Node process alive.
- **Library diagnostics routed through `Logger`** — the `@ComputedColumn` dual-dialect warning and `WriteBuffer` lifecycle logging no longer write to `console` directly, so a custom `Logger.setOutput()` sink captures them.

#### Documentation

- Removed the non-existent `FindCondition<T>` from the API reference, corrected the `synchronize` (object form) and `tenantStrategy` (four values) types, added the `nestjs-linear-clone` example, and wired `advanced.md` into the sidebar — English and Korean in sync.

### Added

- **PostgreSQL array operators — `ColumnExpression.arrayContains` / `arrayOverlaps` / `arrayContainedBy` (QueryDSL Tier 5)** - the array counterpart of the JSON-path DSL: `u.tags.arrayContains(["admin", "beta"])` → `tags @> $1`, `.arrayOverlaps(...)` → `&&`, `.arrayContainedBy(...)` → `<@`. The value array is bound as a single parameter (node-postgres serializes it; the engine infers the element type from the column, so no `ARRAY[...]` construction or empty-array cast). PostgreSQL-only — MySQL/SQLite throw `OrmError(UNSUPPORTED_DATABASE)`. `QEntity<T>` now maps primitive-element array properties (`string[]`, `number[]`, …) to `ColumnExpression` so the methods are typed; object arrays still map to the JSON-path expression. Composes through `.and()` / `.or()` / `.not()`.
- **Conditional aggregates — `aggregate.filter(condition)` / `countIf` / `sumIf` (QueryDSL Tier 5)** - restrict an aggregate to rows matching a `qAlias()` predicate so differently-scoped counters share one `GROUP BY` pass (`u.id.count().filter(u.status.eq("active"))`, `u.id.countIf(...)`, `u.amount.sumIf(...)`). PostgreSQL/SQLite emit the SQL-standard `FUNC(arg) FILTER (WHERE …)`; MySQL is rewritten to the equivalent `FUNC(CASE WHEN … THEN arg END)` (with `COUNT(*)` substituting `1` inside the CASE). The predicate is any `ConditionLike` and the filtered aggregate also composes in `having()`. The SELECT/`addSelect` routing now preserves the FILTER predicate's bound parameters (a filtered aggregate travels the parameterized path instead of the cheap stringified one).
- **Full-text search on qAlias — `ColumnExpression.matchAgainst(query, options?)` (QueryDSL Tier 5)** - the `qAlias()` counterpart of `find({ search })`. PostgreSQL composes `to_tsvector(language, col) @@ plainto_tsquery(language, query)` (`options.language`, default `english`), MySQL emits `MATCH(col) AGAINST(query IN BOOLEAN|NATURAL LANGUAGE MODE)` (`options.mode`, default `boolean`), and SQLite throws `OrmError(UNSUPPORTED_DATABASE)`. Reuses the existing `DialectExpression.fullTextSearch` machinery (query bound as a parameter) and composes through `.and()` / `.or()` / `.not()`.
- **Regex match — `ColumnExpression.matches(pattern)` (QueryDSL Tier 4)** - regular-expression predicate from a raw pattern string or a JS `RegExp` (`u.email.matches(/^admin@/i)`, `u.slug.matches("^[a-z0-9-]+$").not()`). PostgreSQL emits `col ~ pattern`, MySQL/SQLite `col REGEXP pattern`; SQLite is served by a `regexp` UDF the connector now registers on connect (better-sqlite3 reserves the operator but ships no engine). `RegExp` `i`/`m`/`s` flags ride along as an inline `(?ims)` option group on the **bound** pattern (no interpolation, no injection surface). `i` is portable; `m`/`s` carry engine-specific newline semantics, and MySQL `REGEXP` is case-insensitive by default on non-binary collations (documented).
- **Row-value tuples — `Expressions.tuple(c1, c2, …).in(rows)` / `.notIn(rows)` / `.eq(row)` (QueryDSL Tier 5)** - compare several columns at once with a SQL row value, the natural fit for composite-PK lookups (`Expressions.tuple(m.tenantId, m.userId).in([[1, "alice"], [2, "bob"]])` → `(tenant_id, user_id) IN ((?, ?), (?, ?))`). Native and identical across PostgreSQL/MySQL/SQLite (≥ 3.15) bar identifier quoting. An empty `.in([])` degenerates to `1 = 0` and `.notIn([])` to `1 = 1` (mirrors the scalar `IN` guard); an arity mismatch throws `OrmError(INVALID_QUERY)`. The `TupleCondition` composes through `Expressions.and` / `.or` / `.not`.
- **`JoinOnBuilder.onBetween()` / `andOnBetween()` / `onValBetween()` (#372)** - first-class range-containment ON conditions for nested-set / interval self-joins (`node.lft BETWEEN parent.lft AND parent.rgt`).
- **Expression-builder `addSelect()` (#372)** - `qb.addSelect((e) => e.count("node.name").sub(1), "depth")` reuses the dialect-portable `@ComputedColumn` expression context for ad-hoc SELECT arithmetic; `AggregateExpression` gains `.toScalar()` / `.add()` / `.sub()` / `.mul()` / `.div()`.
- **Correlated subquery factories (#372)** - `addSelectSubquery`, `whereExistsSubquery`, and `whereNotExistsSubquery` accept `(outer) => subQb`, where `outer("alias.prop")` resolves an outer-query column to its escaped identifier for typed correlation.
- **Operator-object criteria on writes (#372)** - `delete()` / `softDelete()` / `restore()` accept find-style filter objects (`{ between: [a, b] }`, `{ gt }`, `{ lte }`, ...) and `null` (IS NULL) via the same resolver as reads; `updateMany` already did.
- **QueryBuilder `afterLoad` parity (#371)** - `EntitySubscriber.afterLoad` now fires for `getMany()` / `getOne()` / `getManyAndCount()` / `paginate()` entity results, matching `find` / `findOne` / cursor pagination. Raw and partial reads stay raw.

### Fixed

- **`save()`/`saveMany()` wrote explicit NULL for unspecified columns (#368)** - columns whose value is `undefined` are omitted from the INSERT column list, so DB-side `DEFAULT` and `@Column({ default })` finally apply (TypeORM/knex semantics: `undefined` = not provided, `null` = explicit NULL). `@CreateTimestamp` / `@UpdateTimestamp` / `@Version` / client-side UUID injection is unchanged, and an all-omitted insert renders `() VALUES ()` (MySQL family) or `DEFAULT VALUES` (PostgreSQL/SQLite).
- **`save()` RETURNING rows exposed raw DB column keys (#369)** - INSERT/UPDATE/batch RETURNING rows are routed through `ResultTransformer`, so the returned entity carries property keys (`@Column({ name })`, NamingStrategy) and column transformer `from` values; save-back of a returned entity no longer NULLs out custom-named columns.
- **`*AndSelect` joined columns clobbered the root entity (#370)** - joined and root columns are SELECTed with `alias_column` aliases, and `getMany()` / `getOne()` hydrate the joined segment into the relation property: ManyToOne/OneToOne nest an object (or `null` on LEFT JOIN miss), OneToMany groups into a PK-deduped array. Previously duplicate column names let the joined entity overwrite root PKs/timestamps and the relation property stayed `undefined`.

Decorator-free entity definitions, filter-first read/write shorthands, and a more explicit `synchronize` policy, plus a batch of correctness fixes shaken out of the `nestjs-linear-clone` reference example (soft-delete/aggregate parity, subscriber idempotency, relation hydration). Backward compatible - the single-value `synchronize` form and every existing decorator API keep working.

### Highlights

- **Decorator-free entity schemas** - every decorator-only feature now has a programmatic `EntitySchema` equivalent (columns, relations, indexes, hooks, timestamps, computed columns), so entities can be defined without `experimentalDecorators` / `emitDecoratorMetadata`.
- **Filter-first EntityManager shorthands** - `em.findBy(Entity, where)` / `em.findOneBy(Entity, where)` reads and `em.update(Entity, where, data)` writes, so the common "match by criteria" path no longer needs a full options object or a loaded entity.
- **`synchronize` policy as an options object (#331)** - `synchronize: { mode, continueOnError, failOnDestructiveChange, logDDL }` separates three concerns that were fused into one value: boot resilience, destructive-change safety, and DDL visibility. The single-value form (`true | "safe" | "dry-run" | false`) normalizes to the same policy, so existing configs are unchanged.
- **Typed `getRawMany()` / `getRawOne()` coercion (#348)** - opt-in per-column coercion so raw rows land as numbers / booleans / dates instead of driver-native strings.
- **`@ComputedColumn` dialect-portable expression builder (#336)** - define a computed column once with the expression builder; it compiles to `TIMESTAMPDIFF` on MySQL, `EXTRACT(EPOCH …)` on PostgreSQL, etc., with no `process.env.DB_TYPE` read in the entity.
- **Introspection: SQLite + CLI, round-trip stability** - DB → entity generation gains SQLite support and a CLI path, with name-preserving timestamps and index round-trip stability.

### Added

#### Core APIs

- **`EntityManager.findBy(Entity, where)` / `findOneBy(Entity, where)`** - filter-first read shorthands over `find` / `findOne`.
- **`EntityManager.update(Entity, where, data)`** - filter-first update that matches by criteria instead of requiring a loaded entity.
- **`EntityManager.refs(...)` bulk helper + tagged `em.query\`\`` shorthand** - multi-entity `SqlRef` construction and a tagged-template form of `em.query` for raw-SQL call sites.
- **Typed coercion for `getRawMany()` / `getRawOne()` (#348)** - declare per-column target types so raw projections are coerced from driver strings.

#### Decorator-free schema definition

- **`EntitySchema`** - a programmatic alternative covering every decorator-only feature (`@Column`, relations, `@Index` / `@UniqueIndex` / `@FullTextIndex`, `@Version`, create/update timestamps, `@DeletedAt`, `@ComputedColumn`, lifecycle hooks).

#### Schema synchronize (#331)

- **`synchronize` options object** - `{ mode: true | "safe" | "dry-run", continueOnError, failOnDestructiveChange, logDDL }`, normalized by `normalizeSynchronizePolicy()`. New error codes `OrmErrorCode.SCHEMA_SYNC_FAILED` and `SCHEMA_SYNC_DESTRUCTIVE_CHANGE`.

#### Computed columns (#336)

- **`@ComputedColumn({ expression })`** accepts a dialect-portable expression builder (date diffs, conditionals, column refs) instead of a raw SQL string.

#### Errors

- **`unsupportedExpression()`** - uniform `OrmError(UNSUPPORTED_OPERATION)` shape across dialect throws, with consistent emulation guidance.

### Fixed

- **`withDeleted()` not propagated into relation loads** (#363) - eager and lazy relation loads now honor the root query's soft-delete scope, so a parent and its relations no longer disagree on whether trashed rows are visible.
- **`getReference()` stub leaked through `findOne`** (#365) - a first-level-cache hit on a `getReference()` PK-only stub now hydrates the full row on `findOne` instead of returning the bare-PK instance.
- **`addSubscriber` double-fired** (#366) - subscriber registration is idempotent, so re-initialization no longer produces duplicate notifications / audit rows.
- **`limit [offset, 0]` returned 1 row** (#364) - a zero count is honored as `LIMIT 0` instead of falling through to a single row.
- **Aggregates ignored `@DeletedAt`** (#351) - `count` / `sum` / `avg` / `min` / `max` / `exists` / `findAndCount` now exclude soft-deleted rows, so `findAndCount` returns a consistent `[rows, count]`.
- **NamingStrategy + dialect operators skipped in aggregate / `explain` WHERE** (#352) - those WHERE clauses now apply the configured `NamingStrategy` column mapping and dialect operators like the rest of the query surface.
- **`@RelationColumn` FK shadow props rejected in `updateMany` / `delete` criteria** (#353) - FK shadow accessors are accepted in update / delete WHERE.
- **MySQL introspection missed `AUTO_INCREMENT`** (#346) - `getColumns` includes `EXTRA`, so auto-increment PKs are generated as `@PrimaryGeneratedColumn`.
- **PostgreSQL `SET LOCAL search_path` on an invalid tenant marker** (#345) - skipped when the `MetadataContext` tenant is not a valid identifier, with a regression test.

### Documentation

- Raw-SQL escape-hatch decision ladder + per-tool reference; analytical-query cookbook recipes lifted from `nestjs-linear-clone`; query-builder source-vs-docs drift audit (6 broken examples fixed); introspection guide rewrite (SQLite, CLI, round-trip, indexes); onboarding / api-reference / getting-started refresh.

### Tests

- **Golden-SQL suites** - pin the exact rendered SQL per dialect for expression classes, `SelectQueryBuilder` full statements, `RawQueryBuilder` CTE / window / set-operations, and `castBuiltinType` / `wrapIdentifier`. Plus a dense `ResultTransformer` hydration regression suite and a JSON-column round-trip integration test.

### Reference example (`nestjs-linear-clone`)

- **Cross-tenant authorization hardening** - closed cross-tenant IDOR on comments / work-logs / bulk / issues / memberships (#335 and follow-ups), issue links + `@mention` notification leaks, and a final sweep over the remaining holes: webhook endpoint / signing-secret exposure, SSRF connection pinning, saved-filter / search / analytics / queue / attachment scoping, membership-invite privilege escalation, and self-only user mutations.
- **Webhook outbox hardening** - SSRF egress validation, deterministic dedupe key, and a lease-based `in_flight` reaper; idempotency claims made leaseable and status-correct.
- **Misc** - ActivityLog rows for soft-delete / restore (#334), `ProjectNumberingService` extraction to break a module cycle (#349), `findOne` split so internal callers skip the 5-relation eager load, and added Sprint / Label / Project e2e + comment FTS + trash / cascade coverage (#341).

**Full Changelog**: https://github.com/biud436/stingerloom-orm/compare/v0.22.0...v0.23.0

---

## [0.22.0] — 2026-05-14

Raw-SQL ergonomics overhaul plus a large analytical-expression expansion. Both batches were shaken out while building the `nestjs-linear-clone` reference example — every addition removes a place where the example previously had to hand-roll `wrap()` + `raw()`, drop to `em.query(...)`, or `as any` past a type gap. No breaking changes.

### Highlights

- **`em.ref()` / `em.aliasRef()` — typed entity proxies for `sql`` templates** — `em.ref(Issue)` interpolates as the tenant-aware wrapped table name and resolves property access to the bare wrapped column; `em.ref(Issue, "i")` adds alias-qualified columns for FROM / JOIN and self-joins; `em.aliasRef("cte")` covers CTE / derived-table columns that have no entity behind them. Replaces the hand-rolled `wrap()` + `raw()` boilerplate that every raw-SQL call site used to repeat (#326).
- **Window functions** — pure window-function factories `Expressions.rowNumber / rank / denseRank / ntile / percentRank / cumeDist` and positional `lag / lead / firstValue / lastValue / nthValue`, all composing `.partitionBy(...)` / `.orderBy(...)` / `.rowsBetween(...)` before `.as(alias)`.
- **Ordered-set aggregates** — `Expressions.percentileCont / percentileDisc / mode` render the SQL-standard `… WITHIN GROUP (ORDER BY …)` form. PostgreSQL-native; MySQL / SQLite throw `OrmError(UNSUPPORTED_OPERATION)` with emulation guidance.
- **`Expressions.dateTrunc(value, unit)`** — dialect-portable date truncation with ISO-Monday week parity across PostgreSQL `date_trunc`, MySQL per-unit forms, and SQLite `date()` / `strftime`.
- **Aggregates over arbitrary expressions** — `Expressions.avg / sum / min / max / count / aggregate(scalarExpr)` so an aggregate can wrap a derived scalar (e.g. `AVG(EXTRACT(epoch FROM (a - b)) / 3600)`) with bindings preserved.
- **Schema-sync resilience** — a single failing `ALTER` or index DDL during `synchronize()` no longer aborts app boot; it logs a warning and continues, matching the pattern `registerFullTextIndexes` already used.

### Added

#### Raw-SQL entity references (#326)

- **`EntityManager.ref(Entity)`** — `SqlRef<T>` Proxy for use inside `sql`` templates. `${ref}` → wrapped tenant-aware table name; `${ref.id}` → bare wrapped column; `${ref.as(prop, asName?)}` → `"col" AS "alias"`. Property lookup honors `@Column` metadata and FK backing properties from relations, falling back to `camelToSnakeCase` for unknowns. The Proxy targets a real `Sql` instance so `instanceof Sql` and `sql-template-tag` internals pass through.
- **`EntityManager.ref(Entity, alias)`** — optional second arg names the table alias: `${ref}` → `"table" AS alias` (FROM / JOIN-ready), `${ref.col}` → `alias."col"`, `${ref.as(p, n?)}` → `alias."col" AS "n"`. Multiple refs with different aliases compose for self-joins. No-alias behavior unchanged.
- **`EntityManager.aliasRef(name)`** — sibling helper for CTE / derived-table column refs with no entity behind them. `${ref}` → bare unquoted alias; `${ref.minDepth}` → `t."min_depth"`. For recursive-CTE-only columns, derived-table aliases, and generic `INNER JOIN cte_name w ON …` patterns.

#### Analytical expressions

- **Window functions** — `Expressions.rowNumber / rank / denseRank / ntile(n) / percentRank / cumeDist` and `lag / lead(expr, offset?, default?) / firstValue / lastValue / nthValue(expr, n)`, returning a `WindowBuilder` for `.partitionBy()` / `.orderBy()` / `.rowsBetween()` / `.rangeBetween()`.
- **Ordered-set aggregates** — `Expressions.percentileCont(p, orderBy)` / `percentileDisc(p, orderBy)` / `mode(orderBy)` via the new `OrderedSetAggregateExpression`.
- **`Expressions.dateTrunc(value, unit)`** — truncate a date / timestamp to the start of a calendar unit, dialect-portable.
- **Aggregate-over-expression** — `AggregateExpression` carries an optional `argRenderer`, so `Expressions.{avg,sum,min,max,count,aggregate}(scalarExpr)` route a derived argument through the parameterized SELECT path with bindings intact.
- **`ScalarExpression` / `AggregateExpression` `.asc()` / `.desc()`** now carry a dialect-aware renderer, so they emit the full function call inside both window `OVER (ORDER BY …)` and top-level `ORDER BY`.
- **`SelectQueryBuilder.groupBy([...])`** accepts `Sql` / `ScalarExpression` / `ColumnExpression` with bindings preserved; **`addOrderBy`** gains a `ScalarExpression` overload.

### Fixed

- **`Expressions.count("*")` rendered `COUNT(`i`.`*`)`** (#f39dc08) — the wildcard was routed through the `SelectQueryBuilder` column resolver, which qualified it with the entity alias and produced SQL MySQL rejects as `Unknown column 'i.*'`. `"*"` is now short-circuited in `renderAggregateArg` and emitted verbatim regardless of dialect or alias context.
- **`@ManyToOne` / `@OneToOne` `fkProperty` ignored on INSERT / UPDATE** (#6ad3b5a) — entities naming their FK shadow accessor non-conventionally (e.g. `sourceIssueId` for `source: Issue`) silently left the FK column `NULL` even after explicit assignment. Both write paths now honor `fkProperty` as a fallback, and `ResultTransformer`'s FK column → property remap consults it too so reads surface the FK on the right key. Also adds a built-in `boolean` column transformer so MySQL / SQLite `TINYINT` 0/1 normalizes to a real JS boolean.
- **`@RelationColumn` FK columns not hydrated on `findOne` / `findWithCursor`** (#e265fb1) — the SELECT projection listed only `@Column`-decorated columns, so a `@RelationColumn`-derived FK was never returned and the shadow accessor stayed `undefined` after read. Relation FK columns (ManyToOne + OneToOne owning side) are now appended to the projection. `ResultTransformer.extractBaseEntity` complemented the bug by skipping every underscored key as a join alias — under `SnakeNamingStrategy` that also dropped base columns like `created_at`; underscored keys with a known remap entry are now treated as base columns.
- **`SelectQueryBuilder.getMany()` bypassed `ResultTransformer`** (#fb8c6e2) — `qAlias`-driven queries returned entities with raw DB column names under `SnakeNamingStrategy` (`issue_counter` instead of `issueCounter`). `getMany()` now routes through `ResultTransformer.toEntities` like `EntityManager.find` does; the snake→camel remap also extends to `@RelationColumn`-managed FKs.
- **`SchemaRegistrar.synchronize()` aborted app boot on a single failing DDL** (#fb8c6e2) — `applySchemaDiff` / `registerIndex` / `registerUniqueIndexes` now wrap each statement in try/catch + warn, so schema drift surfaces as a warning instead of killing startup.
- **`WhereClause<T>` rejected bare-array IN-shorthand** (#1ab28d6) — the runtime already accepts `{ id: [1, 2, 3] }` as `WHERE id IN (1, 2, 3)` (used by `softDelete` / `restore`), but the type forced callers to cast `as any`. Pure type widening — no behavioral change.

### Documentation

- **`em.ref()` / `em.aliasRef()` raw-SQL guide** — documented in the raw-SQL docs (EN + KO).

### Tests

- **13 unit tests** for `em.ref()` alias mode and `em.aliasRef()` — alias rendering, alias-qualified columns, `.as()` projection, FK backing properties, self-join composition, MySQL backticks, recursive-CTE composition, `instanceof Sql`, and no-alias backward compatibility (#326).

### Reference example

- **`nestjs-linear-clone` phase-1 completion** — work logs, cycle-time percentiles, attachments, import / export. The analytics service was rewritten end-to-end on the ORM DSL (recursive-CTE issue tree, sprint burndown, assignee throughput, time-in-status via LAG/LEAD, weekly lead time, cycle-time percentiles), and the e2e suites are green.

**Full Changelog**: https://github.com/biud436/stingerloom-orm/compare/v0.21.0...v0.22.0

---

## [0.21.0] — 2026-05-06

DX-focused minor release. Most of these landed while building the `nestjs-linear-clone` reference example; each one removes a place where users previously had to drop to `em.query(...)`, `as any` casts, or hand-rolled column transformers because the ORM had a gap. No breaking changes.

### Highlights

- **Portable M2M / idempotent insert APIs** — `EntityManager.attachRelation` / `detachRelation` (mirrored on `BaseRepository.relation()`) and `insertIgnore` so `@ManyToMany` join-table writes and composite-PK upserts no longer need raw `INSERT IGNORE` / `ON CONFLICT DO NOTHING` per-dialect branching (#322).
- **qAlias dynamic accessors + custom FK property names** — `i.field(name)` / `i.jsonField(name)` for runtime-selected columns; new `fkProperty` option on `@ManyToOne` / `@OneToOne` lets the resolver map non-conventional FK backing properties (`wsId`, `authorRef`, etc.) without declaring a duplicate `@Column`.
- **JSON column round-trip default** — `@Column({ type: "json" | "jsonb" })` now installs a defensive `JSON.stringify` / `JSON.parse` transformer when none is supplied. Removes the boilerplate every project ended up writing to make mysql2 / better-sqlite3 / mariadb behave consistently on JSON columns.
- **`UPDATE … ORDER BY … LIMIT` via `updateMany` + `UpdateQueryBuilder`** (#303) — capped ordered updates for worker-claim queues and similar patterns. MySQL/MariaDB emit native syntax; PostgreSQL/SQLite rewrite to `UPDATE … WHERE pk IN (SELECT pk FROM … ORDER BY … LIMIT n)`. Composite-PK entities throw a typed error on the rewrite path.
- **`@FullTextIndex` synchronize support** — the decorator finally takes effect at runtime sync, not just under `migrate:generate`; multi-column + boolean/natural `mode` support added to `Conditions.fullTextSearch` / `DialectExpression.fullTextSearch`.
- **EntitySubscriber pre-image** — `UpdateEvent<T>` carries a `databaseEntity: T | null` snapshot read inside the same transaction, so audit subscribers can compute column-level diffs without a second `SELECT` (#305).
- **QueryTracker event emitter** — typed `on / off / once` API for `slowQuery` and `nPlusOne` events so structured loggers (pino, OpenTelemetry, Datadog) can subscribe without scraping the internal Logger (#306).

### Added

#### Core APIs

- **`EntityManager.attachRelation(parent, relation, child)` / `detachRelation(...)`** — dialect-portable `@ManyToMany` join-table writes covering both owning and `mappedBy` sides. Mirrored on `BaseRepository.relation(name).add(child)` / `.remove(child)` (#322).
- **`EntityManager.insertIgnore(Entity, rows)`** + `BaseRepository.insertIgnore` — emits `INSERT IGNORE` (MySQL) / `INSERT … ON CONFLICT DO NOTHING` (PostgreSQL / SQLite) for idempotent composite-PK inserts (#322).
- **`BaseRepository.createUpdateBuilder()`** — services that already inject the repository no longer need a second `EntityManager` injection just to issue capped updates (#303).
- **`EntityManager.updateMany(Entity, where, set, options)` + `UpdateQueryBuilder`** — `.where()` / `.orderBy()` / `.limit()` builder for capped ordered updates (#303).
- **`fkProperty` option on `@ManyToOne` / `@OneToOne`** — register a custom FK backing property name so `qAlias()` resolves it to the join column. Convention `{relProp}Id` mapping continues to work alongside.
- **qAlias dynamic-field accessors** — `i.field(name)` / `i.jsonField(name)` for runtime-selected columns, removing `as unknown as Record<string, any>` casts in saved-filter compilers and similar patterns (#322).
- **QueryTracker event emitter** — `tracker.on("slowQuery", entry => …)` / `tracker.on("nPlusOne", (entity, samples) => …)`. Listener exceptions are caught and warned so a bad subscriber cannot silence others or break tracking. `EntityManager.shutdown()` drops listeners alongside the existing reset (#306).
- **`UpdateEvent.databaseEntity`** — pre-read snapshot exposed to `beforeUpdate` subscribers; the SELECT is skipped when no subscriber for the entity declares interest (#305).
- **`fullTextSearch` multi-column + mode** — `Conditions.fullTextSearch([c1, c2], term, { language, mode })`. MySQL emits `MATCH(c1, c2) AGAINST(? IN BOOLEAN|NATURAL MODE)`; PostgreSQL composes `COALESCE(c1, '') || ' ' || COALESCE(c2, '')` inside `to_tsvector`. Single-column path stays bare so existing GIN expression indexes keep matching. Legacy positional `language` string remains accepted.
- **`@FullTextIndex` runtime DDL** — `SchemaRegistrar.synchronize()` now calls `registerFullTextIndexes()` in the Pass-2 index loop (MySQL `CREATE FULLTEXT INDEX`, PostgreSQL `CREATE INDEX … USING gin (to_tsvector(...))`); SQLite skipped. DDL strings flow through `SchemaGenerator.generateFullTextIndexDDL` so synchronize and migration paths stay in lockstep.

#### Default JSON column transformer

- `@Column({ type: "json" | "jsonb" })` installs a built-in round-trip transformer when none is supplied: writes `JSON.stringify` objects/arrays/primitives (passes `null` / `undefined` / pre-stringified strings); reads `JSON.parse` strings back. Explicit `transformer` continues to win.

### Fixed

- **Eager M2O / O2O joins to the same target collide on the same alias** (#2974f75) — two relations on one entity to the same target (e.g. `Issue.assignee` + `Issue.reporter` → `User`) used the table name as the JOIN alias and tripped MariaDB `ER_NONUNIQ_TABLE`. Aliases now derive from `rel.columnName` / `rel.propertyKey`.
- **`qAlias(Entity).workspaceId.eq(…)` rendered as the camelCase property name** (#721e500) — `buildPropertyToColumnMap()` only walked `@Column` metadata, so FK backing properties (the `{relProp}Id` sibling of `@ManyToOne` / `@OneToOne`) were absent and the database rejected the unknown column. New `RelationMetadataResolver.collectFkPropertyMappings(entity)` is folded into both `EntityManager.buildPropertyToColumnMap` and `SelectQueryBuilder.buildPropertyToColumnMapFromMetadata`. Explicit `@Column` mappings still win — the fold-in only fills missing entries.
- **`ResultTransformer` FK population on self-referencing relations / cycles** (#59c339e) — hardened to handle entities that reference themselves (e.g. `Issue.parent: Issue`) and graphs with cycles without infinite recursion.

### Documentation

- **`createUpdateBuilder` reference (en + ko)** — query-builder docs now cover the new repository entry point alongside `createQueryBuilder`.
- **`fkProperty` example** — `@ManyToOne` / `@OneToOne` docs include the custom FK backing property pattern in both languages.

### Tests

- **13 new unit/integration tests** across the qAlias / M2M / insert-ignore feature batch (#322).
- **`qalias-fk-resolution.test.ts`** — regression coverage for `qAlias` FK property resolution: M2O + `@RelationColumn`, O2O `joinColumn`, `@Column` non-shadowing of FK mapping, and direct `collectFkPropertyMappings` API behavior.

**Full Changelog**: https://github.com/biud436/stingerloom-orm/compare/v0.20.4...v0.21.0

---

## [0.20.4] — 2026-05-03

Single-fix follow-up to v0.20.3. The thenable-safe patch shipped for #294/#295 turned out to be insufficient: NestJS dispatches generic property probes (lifecycle-hook detection, `util.inspect`, the dependency-graph inspector) against every resolved provider value, and the misuse-sentinel Proxy's throwing `get` trap turned those benign probes into bootstrap crashes the moment the MTEM token was resolved — which `forRootAsync` does unconditionally because `emToken` injects it. Surfaced on Node 23 against `examples/nestjs-multitenant` after switching to `forRootAsync`.

### Fixed

- **`forRootAsync` MTEM sentinel no longer crashes module bootstrap (follow-up to #294/#295)** — `makeMtemMisuseSentinel` is now a plain object that mirrors `MultiTenantEntityManager`'s public methods rather than a `Proxy`. Unknown property reads flow through as `undefined` so framework probes pass cleanly; real MTEM method calls still throw the actionable misuse error pointing at `tenantStrategy: "database"`.

### Tests

- New regression case in `nestjs-multi-db.test.ts` covering well-known symbol probes (`Symbol.toPrimitive`, `Symbol.toStringTag`, `Symbol.iterator`, `Symbol.asyncIterator`, `Symbol.hasInstance`, Node 23's `Symbol.dispose` / `Symbol.asyncDispose`, `nodejs.util.inspect.custom`) and arbitrary string-keyed reads on the sentinel.

**Full Changelog**: https://github.com/biud436/stingerloom-orm/compare/v0.20.3...v0.20.4

---

## [0.20.3] — 2026-05-03

Stability and hardening release on top of v0.20.0. No new public APIs; the version number lands on `.3` because two earlier publish attempts (`0.20.1`, `0.20.2`) were superseded before reaching npm. Key items below.

### Highlights

- **Multi-tenant correctness fixes** — decorator-time metadata writes now route to the public layer (#280), scanner caches drop with their tenant layer (#279), and the shared `dirtyEntities` Set is no longer wiped by per-transaction cleanup on a NestJS singleton EM (#278). All three were silent regressions where one tenant or transaction could observe state belonging to another.
- **Connection lifecycle hardening** — Postgres commit/rollback wraps `client.query` in try/catch and destructively releases on rollback failure so pool clients are never leaked (#283); `EntityManager.attach()` now actually honors its `synchronize: false` override (#294, #295).
- **DDL injection / pool surface audited** — five high/medium dialect issues fixed in one pass: FK column type derivation (#284), SQLite write classifier (#287), FullText regconfig validation (#285), ENUM literal escaping under `NO_BACKSLASH_ESCAPES=OFF` (#286), and the Postgres pool leak above (#283).
- **Legacy context mutators deprecated** — `MetadataLayerRegistry.setContext`, `MetadataScanner.switchContext`, `LayeredMetadataScanner.switchContext`, `MultiTenantMetadataManager.switchTenant`, and `LayeredMetadataStore.setContext` now emit a one-shot warning per process and carry `@deprecated` JSDoc pointing at `MetadataContext.run(tenantId, callback)` (#282).
- **`.d.ts` files now ship JSDoc** — `removeComments: true` was stripping every public-API description from the published declarations; consumers had no IDE hover text. Fixed.

### Fixed

#### Metadata / multi-tenancy

- **Decorator-time writes leak into tenant layers (#280)** — `@Entity` / `@Column` / `@ManyToOne` / `@OneToMany` / `@OneToOne` / `@ManyToMany` all wrote through `MetadataScanner.set()`, which routed to whichever layer the active `MetadataContext.run()` pointed at. Class declarations evaluated inside a tenant context (introspection generator, runtime entity factories, dynamic Prisma imports, per-tenant test fixtures) silently landed on the tenant layer; other tenants then could not load the entity, and per-tenant schema diff diverged. New `MetadataLayerRegistry.getPublicLayer()` and `MetadataScanner.setOnPublic()` always target `"public"` and dirty every cached merged view; tenant Copy-on-Write callers continue to use `scanner.set()`.
- **Scanner caches outlive their tenant layer (#279)** — `MetadataLayerRegistry.removeLayer()` dropped the layer and its `resolveAllCache` entry, but per-instance caches inside every `MetadataScanner` (`lastResolvedMap` + `targetIndexMap`) kept the stale merged map alive. In a long-running multi-tenant workload this leaked entity-class references for every offboarded tenant, multiplied across each scanner singleton. Scanners now self-register with the registry; both `removeLayer()` and `TenantConnectionRouter.release()` invalidate the per-instance caches so references die with the layer.

#### EntityManager / NestJS

- **Shared `dirtyEntities` wiped by tx cleanup (#278)** — `executeInTransaction()`'s finally block was clearing the instance-wide `dirtyEntities` Set, destroying dirty-state belonging to other in-flight transactions and to non-tx writers on a shared (NestJS singleton) `EntityManager`. Tx-scoped state already lives in the per-session `txDirtyEntities` WeakMap, so the only correct cleanup is `txDirtyEntities.delete(session)`.
- **`attach()` synchronize gate (#294, #295)** — `effective.synchronize = false` was set on the local options object but `_ctx.getSynchronize()` always read from `client.getOptions(connectionName).synchronize`, so the override never reached `SchemaRegistrar.registerEntities()`'s DDL gate. An attached EM whose original registration had `synchronize: true` would still re-fire DDL. New per-EM `isAttached` flag forces `getSynchronize()` to return false for attached EMs.
- **`forRootAsync` MTEM sentinel proxy thenable-safe (#294, #295)** — the misuse-sentinel Proxy's `get` trap threw on every property access including `.then`. Because the MTEM `useFactory` is `async`, its `return makeMtemMisuseSentinel(...)` unwrapped through `Promise.resolve(value)`, which probes `.then` on the resolved value — that probe threw and crashed module bootstrap before anyone tried to inject MTEM. `then` / `catch` / `finally` now return undefined so the sentinel flows through the async factory and only throws on first real injection use.
- **NestJS module shutdown cleanup (#281)** — removes the module-scoped `globalRegistry` Map, which only had writers and no readers — it pinned every onboarded `EntityManager` for the life of the process. `StingerloomOrmService.captured` is now reset in `onApplicationShutdown` (under `finally`, so a failing `propagateShutdown` still clears it) so subsequent independent modules correctly re-trigger the "forRoot was not called" warning instead of silently inheriting the prior module's flag.

#### Dialects (PR ae67a31, batched fix for #283–#287)

- **Postgres pool leak on commit/rollback (#283)** — commit/rollback now wrap `client.query` in try/catch and destructively `release(true)` on rollback failure so pool clients are never leaked. `PostgresDataSource` clears the connection ref in `finally` so connector exceptions cannot leave a stale handle for `close()` to double-release.
- **FK column type hardcoded to INT (#284)** — `SchemaRegistrar.registerForeignKeys` now derives auto-added M2O / O2O FK column types from `resolvePkColumnType(entity)` instead of a hardcoded `INT`, fixing UUID / varchar / bigint parents.
- **SQLite write classifier confused by leading comments / CTEs (#287)** — `SqliteConnector.executeRaw` and `SqliteDriver.queryWithOptions` branch on better-sqlite3's `Statement.reader` instead of prefix-string parsing, so leading comments and CTE-prefixed writes route correctly.
- **FullText DDL injection vector (#285)** — `SchemaGenerator.generateFullTextIndexDDL` validates the `@FullTextIndex` `language` option against the `regconfig` identifier grammar and routes it through a new shared escape helper, blocking the `to_tsvector('lang', ...)` injection vector.
- **ENUM literal break-out under `NO_BACKSLASH_ESCAPES=OFF` (#286)** — ENUM literals in `SchemaRegistrar.buildColumnTypeExpr` and `MySqlColumnDefinitionBuilder.resolveEnumType` now escape backslashes and reject null bytes. `PostgresDriver.escapeEnumValue` is now an alias of the shared helper so all three call sites stay consistent.

### Changed

- **Legacy context mutators warn + `@deprecated` (#282)** — `MetadataLayerRegistry.setContext`, `MetadataScanner.switchContext`, `LayeredMetadataScanner.switchContext`, `MultiTenantMetadataManager.switchTenant`, and `LayeredMetadataStore.setContext` flip a process-global context field that AsyncLocalStorage-based `MetadataContext.run` is meant to supersede. New `legacyContextWarning` helper fires once per `method` per process, suppresses itself under Jest (`JEST_WORKER_ID`), and respects `STINGERLOOM_SUPPRESS_LEGACY_CONTEXT_WARN=1`. `@deprecated` JSDoc on all five entry points points callers at `MetadataContext.run(tenantId, callback)`.
- **Layered-metadata facade methods marked `@deprecated`** (#277) — surfaces the same migration path on the unused public facade methods.

### Build

- **`tsconfig.json`: `removeComments: false`** — preserves JSDoc in emitted `.d.ts`. Without this, package consumers got no IDE hover / IntelliSense for public classes and methods.
- **Examples toolchain alignment** (#293) — jest / ts-jest versions across `examples/*` unified; `pnpm-lock.yaml` refreshed.

### Documentation

- **API reference completeness** — list all 20 `ColumnType` values plus the `(string & {})` custom-type widening (#273); expand `SelectQueryBuilder` reference with `whereHas` / `whereNotHas`, `when` / `pipe`, `applyScope`, `whereInSubquery` / `whereNotInSubquery`, `prepare` / `preparePartial`, `withCount`, `getPartialMany` / `getPartialManyAndCount` / `getRawMany` / `getRawOne`, fix `getManyAndCount` return type to `Promise<[TResult[], number]>`, declare class as `SelectQueryBuilder<T, TResult = T>`, document the `qAlias()` helper (#274); new top-level "Tooling" section covering `Seeder` / `IntrospectionGenerator` / `PrismaImporter` (#275).
- **README quickstart** (#276) — copy-paste runnable end-to-end snippet plus a Korean mirror.
- **Korean translations** (#271, #272) — `seeding`, `introspection`, `prisma-import`, `troubleshooting`.
- **Examples documentation** — `nestjs-cats` README + remove orphan `dummy-cats.json` (#292); add the four missing example projects to the docs index (#291); align `nestjs-todo` package description (#290); drop unimplemented `@Version` claim from `nestjs-blog` READMEs (#289); replace boilerplate Nest CLI README in `nestjs-todo-sqlite` (#288).

### Tests

- **45 new unit tests across 4 files** for the dialect fix batch (postgres pool leak, FK column type, SQLite classifier, SQL literal escape).
- **Decorator public-layer routing** — new `decorator-public-layer-routing.test.ts` covers all six relation/column/entity decorators, cross-tenant fallback visibility, cache invalidation reach, and a guard that `scanner.set()` still respects the current context for explicit tenant overrides (#280).
- **`EntityManager.attach()`** — new `entity-manager-attach.test.ts` (5 cases) covers connector reuse, the `synchronize=true` override invalidation, the `NOT_CONNECTED` throw path, `namingStrategy` override application, and pool-sharing across multiple attached EMs (#294, #295).
- **NestJS multi-DB sentinel** — new describe block in `nestjs-multi-db.test.ts` (6 cases) exercises both `useFactory` functions: MTEM sentinel return, real MTEM construction, EM throw on sentinel/undefined under `database` strategy, EM ignoring sentinel under non-`database` strategy, symbol round-trip (#294, #295).
- **Multi-tenancy / transactions coverage gap closure** — 24 new tests across 5 files for `TenantConnectionRouter` eviction (#296), PostgreSQL identifier validator regex (#297), `forEachTenant` modes (#298), `transaction()` rollback-failure combined `OrmError` (#299), and concurrent tenant routing in `pickEm()` under 20 parallel `MetadataContext.run` envelopes (#300).
- **Cross-feature multi-tenancy coverage** — `tenant_column` + `tenant_database` interaction matrix (#270).
- **Deeply nested AsyncLocalStorage semantics** — 7 nested-context cases on `MetadataContext.run()` (3/4-level chains, unscoped mixing, throw recovery, concurrent chains, microtask/timer boundaries) plus a standalone `async-local-storage.test.ts` exercising raw `node:async_hooks` behavior (region isolation, cross-region resource sharing, closure leaks, `.then()` / timer frame inheritance, lost-update under shared state, `exit()` semantics).

**Full Changelog**: https://github.com/biud436/stingerloom-orm/compare/v0.20.0...v0.20.3

---

## [0.20.0] — 2026-04-26

### Highlights

- **Two new multi-tenancy strategies** — `tenant_column` (discriminator column, works on every dialect) and `database` (physical DB-per-tenant via `MultiTenantEntityManager`). Combined with the existing PostgreSQL `search_path` and `schema_qualified` strategies, the ORM now ships all four mainstream isolation models out of the box.
- **`MultiTenantEntityManager`** — new proxy that resolves `MetadataContext.getCurrentTenant()` on every call and delegates to a per-tenant `EntityManager`, each bound to its own pool through the existing named-connection mechanism. Static `tenantDatabaseMap` and lazy `tenantDatabaseResolver` (with in-flight dedupe) are both supported.
- **`WriteBuffer.detachByPk()` / `detachAll()`** — ergonomic detach for the two cases the existing `detach(instance)` couldn't cover: detaching when only a PK is in hand, and resetting all tracked state without wiping the queues.
- **TypeScript 6.0** — upgraded from `^5.6.2` to `^6.0.3`. `moduleResolution: "node"` deprecation silenced via the new `ignoreDeprecations: "6.0"` option.

### Added

#### Multi-tenancy — `tenant_column` strategy (PR #268)

Discriminator-column multi-tenancy that works uniformly across MySQL, PostgreSQL, and SQLite. With `tenantStrategy: "tenant_column"`, the ORM auto-adds a `tenant_id` column to every entity's DDL, populates it on INSERT from `MetadataContext`, and throws when the caller's context is missing or mismatched.

- **`@TenantColumn` / `@NonTenantEntity` decorators** — Hibernate `@TenantId`-style. `@NonTenantEntity` opts an entity (lookup tables, audit logs) out of the auto-injected predicate.
- **`MetadataContext.runUnscoped()`** — escape hatch for cross-tenant admin tasks. Runs the callback with no tenant in context; the predicate-injection path skips the WHERE-clause append and the IdentityMap skips the 1st-level cache so PK lookups can't return another tenant's row.
- **DDL auto-injection** — `SchemaRegistrar` adds the discriminator column and a `(tenant_id, ...)` composite index without entity changes.
- **Write-path scoping** — `save / saveMany / insertMany / upsert / batchUpsert` populate the tenant column from context and reject `TENANT_MISMATCH` writes.
- **Read/write predicate injection across every entry point** — `find / findOne / findWithCursor / count / exists / sum / avg / min / max`, `updateMany`, `softDelete`, `restore`, `deleteMany`, plus `SelectQueryBuilder` (`toSql / getCount / exists`, M2O / O2M / O2O subqueries) and batched `RelationLoader` queries for OneToMany / ManyToMany / inverse OneToOne.
- **Per-call opt-out** — `qb.withoutTenantScope()` chainable builder, `FindOption.withoutTenantScope`, `CursorPaginationOption.withoutTenantScope`.
- **Raw-query safety net** — `EntityManager.query()` emits a call-site-deduped warning when raw SQL runs under an active tenant context.
- **Buffer / Identity Map isolation** — `IdentityMapManager` keys are prefixed with the tenant (`"<tenant>|Class:pk=..."`) so PK lookups can't cross tenants.

#### Multi-tenancy — `tenant_strategy: "database"` (PR #269)

Physical database-per-tenant with full multi-pool routing.

- **`MultiTenantEntityManager`** — new proxy class. Full CRUD / transaction / query-builder / repository delegation, broadcast for events / subscribers / plugins, cross-tenant transaction guard via `AsyncLocalStorage`.
- **`TenantConnectionRouter`** — owns `Map<tenantId, EntityManager>`, idle-TTL eviction, pre-warm / release. Concurrent first-resolves of the same tenant share a single resolver call.
- **`DatabaseStrategy`** — no-op tenant strategy class; isolation is enforced at the pool layer for this mode.
- **`EntityManager.attach(connectionName, overrides?)`** — reuses an existing `DatabaseClient` connection without re-calling `client.connect()`. Used by `TenantConnectionRouter` in the resolver-returned-string branch to avoid pool leaks where `DatabaseClient.connect()` would overwrite the existing connector without closing it. Common post-connect setup extracted into `initializeFromConnection()` and shared with `connect()`.
- **NestJS integration** — `@InjectMultiTenantEntityManager()` decorator + auto-wired provider; `@InjectEntityManager()` continues to work and resolves to the admin / public EM under this strategy. `forRoot` / `forRootAsync` pass `connectionName` into `mtem.register` so Nest named connections stay isolated. Misuse paths fail fast: the MTEM provider returns a sentinel Proxy when `tenantStrategy != "database"`, and the EM provider throws when the strategy is `"database"` but MTEM is missing.
- **Per-MTEM admin-pool naming** — admin connection name is `"default"` (default MTEM) or `"<name>__admin"` (named), so multiple MTEMs coexist without stomping each other's `"default"` connector in `DatabaseClient`.
- **PostgresConnector dialect guard** — `SET LOCAL search_path` is now skipped for `tenantStrategy: "database"` and `"tenant_column"` (the tenant value is a column / DB, not a schema).

#### WriteBuffer

- **`WriteBuffer.detachByPk(class, pk)`** — looks up the Identity Map and delegates to `detach()`. Supports scalar and composite PKs, idempotent on miss.
- **`WriteBuffer.detachAll()`** — detaches every tracked entity and cancels the pending persist queue, transitioning each to `DETACHED`. Class- / criteria-level queues (`delete / bulkUpdate / bulkDelete / save`) are preserved; `clear()` remains the full-reset escape hatch.

### Changed

- **TypeScript devDep `^5.6.2` → `^6.0.3`** — `moduleResolution: "node"` is deprecated in TS 6.0 and slated for removal in TS 7.0. Both `tsconfig.json` and `__tests__/tsconfig.json` switch to the explicit `"node10"` form plus `ignoreDeprecations: "6.0"`. `jest.config.js` now points `ts-jest` at `__tests__/tsconfig.json` so the test config's `types: ["jest", "node"]` still resolves under TS 6's stricter `@types` auto-loading. Migrating to `"node16"` / `"nodenext"` / `"bundler"` (the long-term TS 7 options) is intentionally **not** part of this release — that path forces explicit `.js` extensions on every relative import in the dual CJS/ESM build.

### Documentation

- **`docs/multi-tenancy.md` + `docs/ko/multi-tenancy.md`** — rewritten with a 4-strategy comparison table (`search_path` / `schema_qualified` / `tenant_column` / `database`), full sections per strategy, decision-tree guidance, and `MTEM` / `EM` abbreviations expanded to `MultiTenantEntityManager` / `EntityManager` for readability. Korean tone pass smooths the prose; emoji markers dropped in favor of plain-text labels.
- **Five previously undocumented features documented** in both `docs/` (EN) and `docs/ko/` (KO) trees:
  - `entities.md` — `@JsonIndex` decorator: `path` / `using` / `opclass` / `where` options, dialect behavior, QueryDSL pairing.
  - `advanced.md` — Custom Deserializer strategy: `DeserializerRegistry` API, `DeserializeOptions` reference, swap scenarios.
  - `production-guide.md` — built-in `ConnectionLeakDetector`: `leakDetectionThresholdMs` tuning table, observational-only note.
  - `plugins.md` — `PluginContext.getEntityMetadata` / `registerPlaceholder`, `beforeTransaction` / `afterTransaction` hooks, hook error-handling semantics.
  - `configuration.md` — NamingStrategy guide: `SnakeNamingStrategy` usage, custom strategy template, method reference, identifier-length gotchas.
- **`docs/write-buffer.md` + `docs/ko/write-buffer.md`** — new untrack/detach section covering `detachByPk` and `detachAll`.

### Tests

- **`__tests__/integration/tenant-column.test.ts` + `sqlite/tenant-column.test.ts`** — 39 integration tests across SQLite + MySQL + PostgreSQL (13/dialect): DDL round-trip, CRUD isolation, cross-tenant PK scoping, `MISSING_TENANT_CONTEXT` / `TENANT_MISMATCH` INSERT errors, `@NonTenantEntity` passthrough, `runUnscoped()` escape, eager-load propagation, `em.query()` warning, AsyncLocalStorage concurrency.
- **`__tests__/unit/tenant-column-*.test.ts`** — 55 unit tests across decorator, strategy, DDL, INSERT, queries (16 cross-tenant isolation cases on each scoped path), QueryBuilder, RelationLoader, raw-query warning, and IdentityMap buffer isolation.
- **`__tests__/integration/tenant-database.test.ts` + `sqlite/tenant-database.test.ts`** — 32 integration tests across SQLite (12) + MySQL (10) + PostgreSQL (10). MTEM lifecycle, per-tenant EM caching, idle eviction, cross-tenant transaction guard.
- **`__tests__/unit/multi-tenant-entity-manager.test.ts` + `tenant-connection-router.test.ts` + `nestjs-multi-tenant-entity-manager.test.ts`** — 26 new unit tests covering MTEM proxy delegation, router internals, and Nest DI wiring.
- **`__tests__/integration/tenant-database-config-injection.test.ts`** — 2 SQLite-backed integration tests verifying `forRootAsync` with `inject: [FakeConfigService]` flows ConfigService values into the resolver closure, and that the resolver fires exactly once per tenant.
- **`__tests__/unit/buffer-plugin.test.ts`** — 17 new tests covering `detachByPk` / `detachAll` and `persist()` same-ID semantics (Identity conflict throw, distinct no-PK queueing, post-flush re-persist no-op, slot-free after `untrack` / `detachByPk`).

**Full Changelog**: https://github.com/biud436/stingerloom-orm/compare/v0.19.2...v0.20.0

---

## [0.19.2] — 2026-04-22

### Highlights

- **NestJS `StingerloomOrmModule.forRootAsync()`** — resolve `DatabaseClientOptions` from `ConfigService` or any DI provider. Supports `useFactory` (with `inject` + `imports`), `useClass`, and `useExisting`. Per-connection options token keeps multi-DB setups isolated.
- **QueryDSL CASE shortcuts** — three thin wrappers over `caseBuilder` / `cases` for the three most common CASE shapes: `iff`, `mapValues`, `buckets`.
- **NestJS typo fix (#261, #267)** — `StingerloomOrmModule` / `StingerloomOrmService` are now the canonical names. The misspelled `Stinglerloom*` identifiers have been removed across src, tests, 6 example projects, and the EN+KO docs.

### Added

#### NestJS

- **`StingerloomOrmModule.forRootAsync(asyncOptions)`** and **`StingerloomOrmCoreModule.forRootAsync(asyncOptions)`** — standard NestJS async module pattern with three wiring forms:
  - `useFactory(...args) => options` + `inject: [ConfigService, ...]` + `imports: [ConfigModule, ...]`
  - `useClass: MyOrmOptionsFactory` (factory class registered automatically)
  - `useExisting: MyOrmOptionsFactory` (reuses an externally-registered factory)
  - `connectionName` for named connections, matching `forRoot()`'s multi-DB semantics
- **`StingerloomOrmOptionsFactory` / `StingerloomOrmModuleAsyncOptions` interfaces** + **`getOrmOptionsToken(connectionName?)`** helper, exported from `@stingerloom/orm/nestjs`.

#### Query Builder

- **`SelectQueryBuilder.streamBatch()`** — AsyncGenerator yielding `TResult[]` windows, complementing the existing row-by-row `stream()`. Mirrors the `stream()` / `streamBatch()` pair already on `EntityManager` and `BaseRepository` so naming carries across all three API levels.
- **`Expressions.iff(cond, whenTrue, whenFalse)`** — two-branch ternary CASE. Picks between two results on a single boolean condition (soft-delete flags, feature gates, Y/N output).
- **`Expressions.mapValues(subject, mapping, default?)`** — static value mapping. Object keys become `WHEN` values bound as parameters; keys are string-coerced so enum / status / role columns fit cleanly. Omit `default` to skip `ELSE`; pass `null` for an explicit `ELSE NULL`.
- **`Expressions.buckets(subject, thresholds, default?, { op? })`** — threshold ladder. Each `[threshold, result]` tuple becomes one `WHEN subject <op> threshold THEN result` branch, in the order given. Default operator is `">="` (descending thresholds); switch to `"<"` / `"<="` for ascending cohorts and `">"` for strict descending ladders.

Each CASE shortcut is a thin wrapper over the existing `caseBuilder` / `cases` builders — SQL emission, parameter binding, and dialect behavior match exactly, and every shortcut returns a `ScalarExpression` so the result slots into `.as()`, casts, comparisons, `coalesce(...)`, and logical composition. Empty mappings or thresholds throw early. The existing `caseBuilder` / `cases` APIs are untouched — reach for a shortcut only when its shape matches exactly.

### Changed

- **NestJS: `Stinglerloom*` → `Stingerloom*` (#261)** — the misspelled `StinglerloomOrmModule` / `StinglerloomOrmService` class, token-helper references, and every call site have been renamed to match the package name. 43 files touched across src, tests, 6 example projects, and the EN+KO docs. The short-lived backwards-compat aliases added in PR #267 are removed. If you depended on the old spelling, import the canonical names instead.

### Fixed

- **#262 README Quick Start is actually runnable** — added the `tsconfig` decorator flags note, the `reflect-metadata` import, and the complete connection fields (`host` / `port` / `username` / `password` / `database`) so the snippet works as-is.
- **#263 nestjs-todo example pins `@stingerloom/orm` to `^0.19.1`** instead of `workspace:*`, so the example actually exercises the published npm package.
- **#264 dead `typedi` dependency removed** from 5 example `package.json` files (`nestjs-cats`, `nestjs-blog`, `nestjs-todo`, `nestjs-multitenant`, `prisma-import-demo`); the ORM no longer depends on `typedi`.
- **#265 `synchronize: true` under `NODE_ENV=production` now warns** — `SchemaRegistrar.registerEntities()` emits a visible warning. Silenceable via `STINGERLOOM_ALLOW_SYNC_IN_PROD=true`. Adds 5 regression tests.

### Documentation

- **`Expressions as exp` alias convention** — both `docs/query-builder-querydsl.md` (EN) and `docs/ko/query-builder-querydsl.md` (KO) now open the CASE section with a `::: tip` block introducing `import { Expressions as exp } from "@stingerloom/orm"`. All code examples downstream use `exp.xxx`; prose, headers, and the cheat-sheet tables keep the canonical `Expressions.*` names so lookup against the API stays one-to-one. The `Expressions` namespace JSDoc shows the `as exp` pattern in its primary example.
- **"Shortcuts for common CASE shapes" subsection** — new subsection in both locales, with a three-row shape / shortcut / when-to-use table, worked examples per shortcut, and a cheat-sheet row under "CASE shortcuts" / "CASE 단축" linking back to the full surface.
- **`docs/ko/query-builder-querydsl.md` `coalesce` / `nullif` example import cleanup** — the import line in the null-handling section no longer references `Expressions`, matching the EN counterpart and the code block's actual usage.

### Chore

- **Korean → English comment translation** — ~450+ inline, block, and JSDoc comments translated into idiomatic technical English across `src/` (errors, types, utils, scanner, decorators, migration, metadata, core, dialects, `DatabaseClient`) and `examples/` (`nestjs-cats`, `nestjs-blog`, `nestjs-multitenant`). Comment contexts only — error messages and other string literals were intentionally left untouched. No logic changes; `tsc --noEmit` clean.
- **README badge synced to live CI status** (#266) — replaces the stale hardcoded `5,041 passed` with a live GitHub Actions status badge; CLAUDE.md test count refreshed to `5,191 passed` (unit 3,992 + SQLite 331 + MySQL 411 + PostgreSQL 457).

### Tests

- **`__tests__/unit/qdsl-case-shortcuts.test.ts`** — 23 unit tests covering CASE-shortcut SQL emission, parameter binding, `ELSE` omission, key-order preservation, MySQL dialect rendering, column / scalar composition, and misuse errors (empty mapping, empty thresholds).
- **`__tests__/unit/nestjs-multi-db.test.ts`** — 10 new tests for `forRootAsync` wiring: `useFactory` (+ `inject`), `useClass`, `useExisting`, named connections via `connectionName`, async options resolution, and the no-form-provided error path.
- **`#265` regression suite** — 5 new tests covering the `synchronize: true` + `NODE_ENV=production` warning and the `STINGERLOOM_ALLOW_SYNC_IN_PROD` opt-out.

**Full Changelog**: https://github.com/biud436/stingerloom-orm/compare/v0.19.1...v0.19.2

---

## [0.19.1] — 2026-04-19

### Fixes

- **`@Column` type override drops inferred length** — When `@Column` explicitly sets a `type`, the previously inferred `length` no longer tags along. Prevents unexpected `VARCHAR(255)` annotations on columns whose type was migrated from one to another.
- **Composite PK renders as a single table-level `PRIMARY KEY`** — Previously emitted as multiple inline `PRIMARY KEY` column constraints, which MySQL / PostgreSQL / SQLite all reject. Now emitted as one `PRIMARY KEY (col1, col2)` at the table level, consistent across dialects.

### Documentation

- **Query Builder docs split into seven focused pages** — hub plus `joins` / `querydsl` / `json` / `aggregations` / `execution` / `patterns`. The monolithic page is gone; each page stands on its own.
- **Korean query-builder set (7 pages) rewritten** — replaced the literal translation of the English docs with natural Korean prose. QueryDSL page in particular is restructured mission-first: opens with the two pains of string-based queries (untyped operators, repeated expressions), introduces `qAlias()` as expressions-as-objects, and shows the variable-reuse payoff.
- **Reader-background assumptions removed** — phrases like "if you've used JPA" / "familiar from Hibernate" / "Java users will recognize" dropped from `inheritance-mapping.md`, `write-buffer.md`, `transactions.md`, `query-builder-joins.md`, and their Korean counterparts. The English QueryDSL opening no longer leans on a JPA `QUser` comparison.
- **B2B report example in `query-builder-joins.md` (KO)** — the three-way join + aggregate example now shows the generated SQL next to the TypeScript, including how `totalQty` renders in SELECT (aliased) vs HAVING / ORDER BY (re-expressed for portability).
- **README refreshed** for the 0.19.0 QueryDSL surface, UoW, and MariaDB additions.

### Tests

- **`sql-craft-patterns.test.ts`** — capability boundary audit covering the SQL patterns the builder supports end-to-end.

**Full Changelog**: https://github.com/biud436/stingerloom-orm/compare/v0.19.0...v0.19.1

---

## [0.19.0] — 2026-04-18

### Highlights

Three tiers of expression-surface expansion rolled into one release — `qAlias()` gains roughly three dozen new helpers across SELECT, WHERE, HAVING, ORDER BY, and GROUP BY, plus a shared `ScalarExpression` foundation and TypeScript-native escape hatches.

- **Tier 1 (PR #256) — ordering, aggregates, logical composition, string convenience.** Four groups of helpers on `ColumnExpression` — `.asc/.desc/.nullsFirst/.nullsLast`, `.count/.countDistinct/.sum/.avg/.min/.max`, `.and/.or/.not` composition, and LIKE-escape-safe `.startsWith / .endsWith / .contains` (+ `*IgnoreCase` siblings). A shared `ConditionLike` contract unifies column, JSON-path, aggregate, and logical conditions — they mix freely in `where()`, `andWhere()`, `having()`, etc. Every user value (including the LIKE escape character) stays a bound parameter.
- **Tier 2 (PR #257) — scalar expressions, CAST, date parts, subqueries, CASE.** New `ScalarExpression` foundation drives null handling (`coalesce`, `nullif`), type casts (`.stringValue / .intValue / .longValue / .floatValue / .booleanValue`), date-component extraction (`.year / .month / .day / .hour / .minute / .second / .dayOfWeek / .dayOfMonth / .dayOfYear / .week`), subquery comparisons (`.in(subQb)`, `.eq(subQb)`, `Expressions.exists / notExists`), current-time literals (`currentDate / currentTime / currentTimestamp`), and two fluent `CASE WHEN … THEN …` builders (searched `caseBuilder()` + simple `cases(subject)`). `.as("alias")` is promoted to every projectable expression; `RawQueryBuilder.selectFragments()` preserves parameter bindings in SELECT so JSON-path aliases survive execution.
- **Tier 3 (PR #258) — TypeScript-native helpers and escape hatches.** JS-idiomatic `String.prototype` / `Math.*` / arithmetic-operator-style helpers (`.toLowerCase / .substring(s, e?) / .indexOf / .replace / .add / .sub / .mul / .div / .mod / .neg / .abs / .floor / .ceil / .round / .sqrt`), date arithmetic (`.addYears/Months/Days/Hours/Minutes/Seconds`, `Expressions.dateDiff`, `Expressions.random`), window functions (`aggregate.over().partitionBy().orderBy().rowsBetween()`), and three TS-native escape hatches: ``Expressions.raw<T>(sql`…`)``, `.bigintValue()`, and `qb.selectSchema(zodSchema)` with `z.infer`-driven `TResult` narrowing. DTO constructor projections and template-expression wrappers are intentionally excluded — TS generics, `.as()` + `getRawMany<T>()`, and `sql-template-tag` template literals already cover those idiomatically.

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

### Intentional exclusions

Some ideas considered during design review were deliberately left out because TypeScript / Node idioms already cover them:

- **DTO constructor projections** — TS generics plus `.as("alias")` and `getRawMany<Dto>()` carry the shape; `class-transformer` handles conversion where needed.
- **Raw template-expression wrappers** — `sql-template-tag` (already a dependency) is the idiomatic tagged template; `Expressions.raw<T>(sql\`…\`)` gives the typed escape hatch.
- **`useLiterals` toggle** — values are always parameter-bound as a security policy; no inline-literal mode is exposed.

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
  - `StingerloomOrmModule` — `forRoot()` / `forFeature()`
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
