# API Reference

A quick-reference for method signatures and types. For usage and examples, see the topic-specific documentation.

- [Entity Definition](./entities.md) | [Relations](./relations.md) | [EntityManager](./entity-manager.md)
- [Query Builder](./query-builder.md) | [Transactions](./transactions.md) | [Migrations](./migrations.md)
- [Advanced Features](./advanced.md) | [Multi-Tenancy](./multi-tenancy.md) | [Configuration](./configuration.md)

## EntityManager

```typescript
import { EntityManager } from "@stingerloom/orm";
const em = new EntityManager();
```

### Connection

| Method | Signature | Description |
|--------|-----------|-------------|
| `register` | `(options: DatabaseClientOptions, connectionName?: string): Promise<void>` | Connect to DB + register entities |
| `getConnectionName` | `(): string` | Connection name (default: `"default"`) |
| `getDriver` | `(): ISqlDriver \| undefined` | SQL driver |
| `propagateShutdown` | `(): Promise<void>` | Clean up internal resources |

### CRUD

| Method | Signature | Description |
|--------|-----------|-------------|
| `find` | `<T>(entity, option?): Promise<T[]>` | List query |
| `findBy` | `<T>(entity, where): Promise<T[]>` | Filter-first list query (sugar over `find({ where })`) |
| `findOne` | `<T>(entity, option): Promise<T \| null>` | Single record query |
| `findOneBy` | `<T>(entity, where): Promise<T \| null>` | Filter-first single query (sugar over `findOne({ where })`) |
| `findOneOrFail` | `<T>(entity, option): Promise<T>` | Single record query (throws `EntityNotFoundError`) |
| `findOneByOrFail` | `<T>(entity, where): Promise<T>` | Filter-first single query (throws `EntityNotFoundError`); mirrors `findOneBy` + `findOneOrFail` |
| `exists` | `<T>(entity, where?, withDeleted?, onlyDeleted?): Promise<boolean>` | Check if any matching record exists |
| `findByPK` | `<T>(entity, id: unknown): Promise<T \| null>` | Find by primary key value |
| `findByPKs` | `<T>(entity, ids: unknown[]): Promise<T[]>` | Find by multiple primary key values |
| `findByPKsMap` | `<T>(entity, ids: unknown[]): Promise<Map<string \| number \| bigint, T>>` | Batch load returning a `Map` keyed by PK for O(1) lookup; composite PKs use `"col1=v1,col2=v2"` string keys |
| `pluck` | `<T, K extends keyof T & string>(entity, column: K, where?): Promise<T[K][]>` | Flat array of one column's values for matching rows; reuses `find()` so tenant scope / soft-delete / naming strategy apply |
| `findAndCount` | `<T>(entity, option?): Promise<[T[], number]>` | List + total count |
| `findWithCursor` | `<T>(entity, option?): Promise<CursorPaginationResult<T>>` | Cursor pagination |
| `save` | `<T>(entity, item): Promise<InstanceType<ClazzType<T>>>` | INSERT or UPDATE |
| `delete` | `<T>(entity, criteria): Promise<DeleteResult>` | Permanent delete |
| `softDelete` | `<T>(entity, criteria): Promise<DeleteResult>` | Soft Delete |
| `restore` | `<T>(entity, criteria): Promise<DeleteResult>` | Restore Soft Delete |
| `upsert` | `<T>(entity, data, conflictColumns?): Promise<{ affected: number }>` | INSERT ... ON CONFLICT; MySQL returns 1 (insert) or 2 (update) |
| `batchUpsert` | `<T>(entity, items[], conflictColumns?): Promise<{ affected: number }>` | Multi-row upsert; same MySQL caveat applies |
| `update` | `<T>(entity, where, data): Promise<{ affected: number }>` | Filter-first UPDATE (sugar over `updateMany`, mirrors `delete`) |
| `updateMany` | `<T>(entity, data: UpdateData<T>, options): Promise<{ affected: number }>` | Bulk UPDATE (supports SQL expressions) |
| `increment` | `<T>(entity, where, column: keyof T & string, by?: number): Promise<{ affected: number }>` | Atomically add `by` (default `1`) to a numeric column via `SET col = col + ?`; inherits `update()` safeguards |
| `decrement` | `<T>(entity, where, column: keyof T & string, by?: number): Promise<{ affected: number }>` | Atomically subtract `by` (default `1`) from a numeric column; counterpart of `increment` |

### Construction (no persistence)

These helpers build or prepare entity instances without a hidden unit of work — hand the result to `save()` to persist.

| Method | Signature | Description |
|--------|-----------|-------------|
| `create` | `<T>(entity, data?): InstanceType<ClazzType<T>>` | Build a hydrated instance from a plain object without persisting; real class instance (methods / getters / transformers apply). Pass an array to build many |
| `merge` | `<T>(target, ...sources): T` | Merge partial patches into an existing instance and return it; nested objects merge recursively, arrays / `Date` / `Buffer` replace, `undefined` is skipped. In-memory only |
| `preload` | `<T>(entity, partial): Promise<InstanceType<ClazzType<T>> \| undefined>` | Load the row by the PK(s) in `partial`, merge the rest onto it, and return it — ready for a read-modify-write `save()`. `undefined` when no complete PK or no matching row (mirrors TypeORM) |

### Batch

| Method | Signature | Description |
|--------|-----------|-------------|
| `insertMany` | `<T>(entity, items[]): Promise<{ affected: number }>` | Multi-row INSERT |
| `insertManyAndReturn` | `<T>(entity, items[]): Promise<InstanceType<ClazzType<T>>[]>` | Multi-row `INSERT … RETURNING *` — returns hydrated instances in input order; PostgreSQL and SQLite 3.35+ only; throws `OrmError (UNSUPPORTED_DATABASE)` on MySQL |
| `insertIgnore` | `<T>(entity, rows[]): Promise<void>` | Idempotent INSERT — `INSERT IGNORE` (MySQL) / `INSERT … ON CONFLICT DO NOTHING` (PostgreSQL / SQLite) |
| `saveMany` | `<T>(entity, items[]): Promise<InstanceType<ClazzType<T>>[]>` | Multi-row INSERT/UPDATE |
| `deleteMany` | `<T>(entity, ids[]): Promise<DeleteResult>` | Multi-row delete |

### Relation Batch Writes

Dialect-portable `@ManyToMany` join-table writes covering both owning and `mappedBy` sides. Mirrored on `BaseRepository.relation(name)` as `.add(child)` / `.remove(child)`.

| Method | Signature | Description |
|--------|-----------|-------------|
| `attachRelation` | `<T, U>(parent: T, relation: keyof T & string, child: U): Promise<void>` | Insert a row into the join table (idempotent via `insertIgnore`) |
| `detachRelation` | `<T, U>(parent: T, relation: keyof T & string, child: U): Promise<void>` | Remove a row from the join table |

### Aggregation

| Method | Signature | Description |
|--------|-----------|-------------|
| `count` | `<T>(entity, where?, withDeleted?, onlyDeleted?): Promise<number>` | Count |
| `sum` | `<T>(entity, field, where?, withDeleted?, onlyDeleted?): Promise<number>` | Sum |
| `avg` | `<T>(entity, field, where?, withDeleted?, onlyDeleted?): Promise<number>` | Average |
| `min` | `<T>(entity, field, where?, withDeleted?, onlyDeleted?): Promise<number>` | Minimum |
| `max` | `<T>(entity, field, where?, withDeleted?, onlyDeleted?): Promise<number>` | Maximum |

### Streaming

| Method | Signature | Description |
|--------|-----------|-------------|
| `stream` | `<T>(entity, option?, batchSize?): AsyncGenerator<T>` | Async generator (one entity at a time) |
| `streamBatch` | `<T>(entity, option?, batchSize?): AsyncGenerator<T[]>` | Async generator (yields arrays of entities) |

```typescript
// One at a time
for await (const user of em.stream(User, { where: { isActive: true } }, 1000)) {
  await process(user);
}

// In batches
for await (const batch of em.streamBatch(User, {}, 500)) {
  await bulkInsert(batch); // batch is User[]
}
```

### Transaction

| Method | Signature | Description |
|--------|-----------|-------------|
| `transaction` | `<T>(callback: (em: EntityManager) => Promise<T>, options?: TransactionOptions): Promise<T>` | Execute callback in a transaction (with optional deadlock retry) |

### Raw Query / Analysis

| Method | Signature | Description |
|--------|-----------|-------------|
| `query` | `<T>(sql: string \| Sql, params?: unknown[]): Promise<T[]>` | Execute arbitrary SQL |
| `explain` | `<T>(entity, option?): Promise<ExplainResult>` | EXPLAIN analysis |

### Query Builder

| Method | Signature | Description |
|--------|-----------|-------------|
| `createQueryBuilder` | `(): BaseRawQueryBuilder` | Create a RawQueryBuilder (free-form SQL) |
| `createQueryBuilder` | `<T>(entity, alias): SelectQueryBuilder<T>` | Create a type-safe SelectQueryBuilder |
| `ref` | `<T>(entity: Class<T>, alias?: string): SqlRef<T>` | Typed `sql`-tag proxy for an entity (`${ref}` -> `"table" AS alias`, `${ref.col}` -> alias-qualified column). [Usage ->](./raw-sql.md#typed-references) |
| `aliasRef` | `(alias: string): AliasRef` | Alias-only sibling of `ref()` for CTE / derived-table column refs. `${ref}` -> bare alias, `${ref.col}` -> `alias."col"` with `camelToSnakeCase`. |
| `createUpdateBuilder` | `<T>(entity, alias?): UpdateQueryBuilder<T>` | Fluent `UPDATE … SET … WHERE … ORDER BY … LIMIT` over the `qAlias` predicate DSL. [Usage ->](./query-builder.md#updatequerybuilder-—-type-safe-update-order-by-limit) |
| `createInsertBuilder` | `<T>(entity, alias?): InsertQueryBuilder<T>` | Fluent `INSERT … ON CONFLICT` whose conflict action can read the stored row (`qExcluded`, `greatest`). [Usage ->](./entity-manager-writes.md#expression-based-upsert-createinsertbuilder) |

### Plugin System

| Method | Signature | Description |
|--------|-----------|-------------|
| `extend` | `<TApi>(plugin: StingerloomPlugin<TApi>): this & TApi` | Install a plugin |
| `hasPlugin` | `(name: string): boolean` | Check if installed |
| `getPluginApi` | `<T>(name: string): T \| undefined` | Get plugin API by name |

### Events

| Method | Signature | Description |
|--------|-----------|-------------|
| `on` | `(event: EntityEventType, listener): void` | Register listener |
| `off` | `(event: EntityEventType, listener): void` | Remove listener |
| `removeAllListeners` | `(): void` | Remove all listeners |
| `addSubscriber` | `(subscriber: EntitySubscriber<any>): void` | Register subscriber |
| `removeSubscriber` | `(subscriber: EntitySubscriber<any>): void` | Remove subscriber |
| `getQueryLog` | `(): ReadonlyArray<QueryLogEntry>` | Query log |
| `getEntityMetadata` | `<T>(entity): EntityMetadataView \| null` | Full entity metadata |
| `getColumnMetadata` | `<T>(entity): ColumnMetadataView[]` | Column metadata |
| `getRelationMetadata` | `<T>(entity): RelationMetadataView[]` | Relation metadata |

## BaseRepository

Per-entity CRUD wrapper. [Usage ->](./advanced.md)

```typescript
const userRepo = em.getRepository(User);
// or
const userRepo = BaseRepository.of(User, em);
```

`find`, `findBy`, `findOne`, `findOneBy`, `findOneOrFail`, `findOneByOrFail`, `findWithCursor`, `findAndCount`, `pluck`, `create`, `merge`, `preload`, `save`, `delete`, `remove`, `softDelete`, `restore`, `insertMany`, `insertManyAndReturn`, `insertIgnore`, `saveMany`, `deleteMany`, `batchUpsert`, `count`, `sum`, `avg`, `min`, `max`, `explain`, `upsert`, `persist`, `stream`, `streamBatch`, `createQueryBuilder`, `createUpdateBuilder`, `createInsertBuilder`, `update`, `updateMany`, `increment`, `decrement` — uses the same API as EntityManager without specifying the entity.

**Repository-only helpers:**

| Method | Signature | Description |
|--------|-----------|-------------|
| `relation` | `(name: keyof T & string)` returns `{ add(child), remove(child) }` | Sugar over `attachRelation` / `detachRelation` for `@ManyToMany` join-table writes |

Protected fields available for subclasses: `entity` (the entity class) and `em` (the EntityManager instance).

## Decorators

### Entity

| Decorator | Description |
|-----------|-------------|
| `@Entity(options?)` | Register a class as an ORM entity. `{ name: "table_name" }` |
| `@Column(option?)` | Regular column |
| `@PrimaryGeneratedColumn(option?)` | Auto-increment PK |
| `@PrimaryColumn(option?)` | Manual PK |
| `@Index()` | Single-column index (property level) |
| `@Index(columns, name?)` | Composite non-unique index (class level) |
| `@UniqueIndex(columns, name?)` | Composite unique index (class level) |
| `@Version()` | Optimistic locking version column |
| `@DeletedAt()` | Soft Delete timestamp |
| `@CreateTimestamp()` | Auto-set on INSERT (datetime NOT NULL) |
| `@UpdateTimestamp()` | Auto-set on INSERT and UPDATE (datetime NOT NULL) |

### Relations

| Decorator | Description |
|-----------|-------------|
| `@ManyToOne(getEntity, getProperty?, option?)` | Many-to-one (FK owner side) |
| `@OneToMany(getEntity, option)` | One-to-many (inverse side) |
| `@OneToOne(getEntity, option?)` | One-to-one |
| `@ManyToMany(getEntity, option?)` | Many-to-many |
| `@RelationColumn(option?)` | FK column declaration for @ManyToOne/@OneToOne |

### Lifecycle Hooks

| Decorator | Timing |
|-----------|--------|
| `@BeforeInsert` | Just before INSERT |
| `@AfterInsert` | After INSERT |
| `@BeforeUpdate` | Just before UPDATE |
| `@AfterUpdate` | After UPDATE |
| `@BeforeDelete` | Just before DELETE |
| `@AfterDelete` | After DELETE |

### Validation

| Decorator | Description |
|-----------|-------------|
| `@NotNull()` | Disallow null/undefined |
| `@MinLength(n)` | Minimum string length |
| `@MaxLength(n)` | Maximum string length |
| `@Min(n)` | Minimum numeric value |
| `@Max(n)` | Maximum numeric value |

### Transaction / DI

| Decorator | Description |
|-----------|-------------|
| `@Transactional(isolationLevel?)` | Wrap method in a transaction |
| `@InjectRepository(Entity, connectionName?)` | Inject `BaseRepository<T>` in NestJS (default connection if omitted) |
| `@InjectEntityManager(connectionName?)` | Inject `EntityManager` in NestJS (default connection if omitted) |

## Type Reference

### FindOption\<T\>

```typescript
interface FindOption<T> {
  select?: (keyof T)[] | Partial<Record<keyof T, boolean>>;
  where?: WhereClause<T> | WhereClause<T>[];  // single or array (OR between groups)
  limit?: number | [number, number];
  skip?: number;
  take?: number;
  orderBy?: Partial<Record<keyof T, "ASC" | "DESC">>;
  groupBy?: (keyof T)[];
  having?: Sql[];
  relations?: (keyof T)[];
  withDeleted?: boolean;
  onlyDeleted?: boolean;         // Return ONLY soft-deleted rows (precedence over withDeleted)
  distinct?: boolean;            // SELECT DISTINCT
  timeout?: number;
  useMaster?: boolean;
  lock?: LockMode;
  cache?: boolean | number | { ttl?: number; tag?: string };  // opt-in query result cache
}

enum LockMode {
  PESSIMISTIC_WRITE = "PESSIMISTIC_WRITE",
  PESSIMISTIC_READ = "PESSIMISTIC_READ",
  PESSIMISTIC_WRITE_NOWAIT = "PESSIMISTIC_WRITE_NOWAIT",
  PESSIMISTIC_READ_NOWAIT = "PESSIMISTIC_READ_NOWAIT",
  PESSIMISTIC_WRITE_SKIP_LOCKED = "PESSIMISTIC_WRITE_SKIP_LOCKED",
  PESSIMISTIC_READ_SKIP_LOCKED = "PESSIMISTIC_READ_SKIP_LOCKED",
}
```

### WhereClause\<T\>

Each field accepts a plain value (equality), a filter object, a `Sql` object, or `null`:

```typescript
type WhereClause<T> = {
  [K in keyof T]?: T[K] | FieldFilter<T[K]> | Sql | null;
} & {
  OR?: WhereClause<T>[];
  AND?: WhereClause<T>[];
  NOT?: WhereClause<T>;
};
```

### Filter Operators

Operators are determined by the field type — `string` fields get extra operators like `contains` and `startsWith`.

```typescript
// All types: BaseFilter<T>
{ eq, ne, in, notIn, not, isNull }

// number, Date, bigint: ComparableFilter<T> (extends BaseFilter)
{ gt, gte, lt, lte, between }

// string: StringFilter (extends ComparableFilter)
{ like, notLike, ilike, contains, startsWith, endsWith }
```

See [Querying — WHERE Filters](./entity-manager-querying.md#where-filters) for usage examples.

### WhereOperator (SelectQueryBuilder)

Type-safe operator union for the 3-arg `where()` method:

```typescript
type WhereOperator =
  | "=" | "!=" | "<>" | "<" | ">" | "<=" | ">="
  | "LIKE" | "NOT LIKE" | "ILIKE"
  | "IN" | "NOT IN"
  | "IS NULL" | "IS NOT NULL" | "BETWEEN";
```

### TransactionOptions

```typescript
interface TransactionOptions {
  retryOnDeadlock?: boolean;  // Enable deadlock retry (default: false)
  maxRetries?: number;        // Maximum retries (default: 3)
  retryDelayMs?: number;      // Delay between retries in ms (default: 100)

  // Parity with @Transactional (decorator-free) — see ./decorator-free.md
  isolationLevel?: TRANSACTION_ISOLATION_LEVEL;  // @Transactional("SERIALIZABLE")
  propagation?: TransactionPropagation;          // REQUIRED | REQUIRES_NEW | NESTED
  connectionName?: string;                       // multi-DB target connection
}
```

### SelectQueryBuilder\<T, TResult\>

[Usage ->](./query-builder.md) ·
[Patterns ->](./query-builder-patterns.md) ·
[QueryDSL ->](./query-builder-querydsl.md) ·
[Execution ->](./query-builder-execution.md)

```typescript
// Created via em.createQueryBuilder(Entity, "alias")
class SelectQueryBuilder<T, TResult = T> {
  // ── SELECT ─────────────────────────────────────────────
  select(columns: (keyof T & string)[] | "*"): this;
  addSelect(expr: Sql | string, alias?: string): this;
  setDistinct(value?: boolean): this;
  withCount(relation: string, alias?: string,
            fn?: (sub: SelectQueryBuilder<any>) => void): this;

  // ── WHERE ──────────────────────────────────────────────
  where(condition: Sql): this;
  where(clause: WhereClause<T> | WhereClause<T>[]): this; // find()-style filter object
  where(column: keyof T & string, value: any): this;
  where(column: keyof T & string, operator: string, value: any): this;
  andWhere(...): this;  // same overloads as where(), incl. WhereClause
  orWhere(...): this;   // same overloads as where(), incl. WhereClause
  whereIn(column: keyof T & string, values: any[]): this;
  whereNotIn(column: keyof T & string, values: any[]): this;
  whereNull(column: keyof T & string): this;
  whereNotNull(column: keyof T & string): this;
  whereBetween(column: keyof T & string, min: any, max: any): this;
  whereLike(column: keyof T & string, pattern: string): this;

  // Relation-aware EXISTS/NOT EXISTS sub-queries.
  whereHas(relation: string,
           fn?: (sub: SelectQueryBuilder<any>) => void): this;
  whereNotHas(relation: string,
              fn?: (sub: SelectQueryBuilder<any>) => void): this;

  // IN (subquery) helpers — accepts a built SelectQueryBuilder.
  whereInSubquery(column: keyof T & string,
                  sub: SelectQueryBuilder<any>): this;
  whereNotInSubquery(column: keyof T & string,
                     sub: SelectQueryBuilder<any>): this;

  // ── JOIN / GROUP / ORDER ───────────────────────────────
  leftJoin(table: string, alias: string, condition: Sql | string): this;
  innerJoin(table: string, alias: string, condition: Sql | string): this;
  rightJoin(table: string, alias: string, condition: Sql | string): this;
  orderBy(spec: { [K in keyof T & string]?: "ASC" | "DESC" }): this;
  addOrderBy(column: keyof T & string, direction: "ASC" | "DESC"): this;
  groupBy(columns: (keyof T & string)[]): this;
  having(condition: Sql): this;
  limit(count: number): this;
  offset(count: number): this;
  skip(count: number): this;
  take(count: number): this;

  // ── LOCKS / HINTS ──────────────────────────────────────
  forUpdate(): this;
  forUpdateNowait(): this;
  forUpdateSkipLocked(): this;
  forShare(): this;
  forShareNowait(): this;
  forShareSkipLocked(): this;
  useIndex(indexName: string): this;           // MySQL
  forceIndex(indexName: string): this;         // MySQL
  ignoreIndex(indexName: string): this;        // MySQL
  hint(hintText: string): this;                // PostgreSQL (pg_hint_plan)
  withDeleted(): this;
  appendSql(fragment: Sql): this;

  // ── COMPOSITION ────────────────────────────────────────
  // Conditional branch — only applies `fn` when condition is truthy.
  when(condition: boolean | (() => boolean),
       fn: (qb: this) => void,
       elseFn?: (qb: this) => void): this;
  // Apply a reusable transform — fn returns the (possibly mutated) qb.
  pipe(fn: (qb: this) => this): this;
  // Apply a named scope declared as `static scopes` on the entity class.
  applyScope(name: string): this;

  // ── VALIDATION ─────────────────────────────────────────
  validate(validator: RowValidator<TResult>): this;
  validateArray(validator: ArrayValidator<TResult>): this;

  // ── COMPILATION & SUB-USE ──────────────────────────────
  toSql(): Sql;
  getSql(): { text: string; values: any[] };
  asSubquery(alias: string): Sql;

  // Pre-compile with named placeholders — re-executable without rebuilding.
  prepare<P extends Record<string, unknown> = Record<string, unknown>>():
    CompiledQuery<TResult, P>;
  preparePartial<P extends Record<string, unknown> = Record<string, unknown>>():
    CompiledQuery<TResult, P>;

  // ── EXECUTION: class instances ─────────────────────────
  getMany(): Promise<TResult[]>;
  getOne(): Promise<TResult | null>;
  getOneOrFail(): Promise<TResult>;           // Throws EntityNotFoundError
  getCount(): Promise<number>;
  getManyAndCount(): Promise<[TResult[], number]>;
  paginate(opts?: { page?: number; pageSize?: number }):
    Promise<PagePaginationResult<TResult>>;
  getCursor(option?: CursorPaginationOption<T>):
    Promise<CursorPaginationResult<TResult>>;  // Keyset pagination; side-effect-free clone
  getMap<K extends ColumnOf<T>>(keyColumn: K): Promise<Map<T[K], TResult>>;  // Index getMany() results by keyColumn; last row wins on duplicate keys
  pluck<K extends ColumnOf<T>>(column: K): Promise<Array<T[K]>>;             // Flat array of one column's values; delegates to getMany()
  exists(): Promise<boolean>;
  getExists(): Promise<boolean>;              // Alias of exists()
  getSum(column: ColumnOf<T>): Promise<number>;   // SUM — 0 on empty/NULL
  getAvg(column: ColumnOf<T>): Promise<number>;   // AVG — 0 on empty/NULL
  getMin(column: ColumnOf<T>): Promise<number>;   // MIN — 0 on empty/NULL
  getMax(column: ColumnOf<T>): Promise<number>;   // MAX — 0 on empty/NULL
  explain(): Promise<ExplainResult>;          // Query plan (MySQL / PostgreSQL only)

  // ── EXECUTION: typed plain objects (no deserialization) ─
  getPartialMany(): Promise<TResult[]>;
  getPartialOne(): Promise<TResult | null>;
  getPartialManyAndCount(): Promise<[TResult[], number]>;
  paginatePartial(opts?: { page?: number; pageSize?: number }):
    Promise<PagePaginationResult<TResult>>;

  // ── EXECUTION: untyped or coerced plain objects ────────
  // `T` declares the row shape. Optional `coerce` map normalizes
  // driver-native string values (mysql2 BIGINT/DECIMAL, pg NUMERIC,
  // date columns) to numbers / Dates without hand-written wrappers.
  getRawMany<T = Record<string, unknown>>(options?: RawResultOptions<T>): Promise<T[]>;
  getRawOne<T = Record<string, unknown>>(options?: RawResultOptions<T>): Promise<T | null>;
}

// RawResultOptions<T> — per-key coercion map.
//   coerce: { [K in keyof T]?: "number" | "bigint" | "boolean" | "date" | (raw: unknown) => T[K] }
```

**Module helper — `qAlias`**

`qAlias()` is exported alongside `SelectQueryBuilder`. It returns a typed
proxy used by [QueryDSL expressions](./query-builder-querydsl.md) so column
references survive renames at compile time:

```typescript
import { qAlias } from "@stingerloom/orm";

function qAlias<T>(entity: Class<T>, name: string): QEntity<T>;

const u = qAlias(User, "u");
qb.where(u.email, "alice@example.com");
```

`qAlias()` also exposes runtime-dynamic accessors `i.field(name)` and `i.jsonField(name)` for columns selected by string at call time (saved-filter compilers, dynamic column DSLs), and `fkProperty` on `@ManyToOne` / `@OneToOne` lets the resolver map non-conventional FK backing properties without a duplicate `@Column`.

### Expressions (QueryDSL helpers)

The `Expressions` namespace (commonly aliased `as exp`) groups dialect-portable scalar / aggregate / analytical helpers used inside `select()`, `where()`, `groupBy()`, `orderBy()`, and `having()`. Each helper returns a composable `ScalarExpression` / `AggregateExpression` / `WindowBuilder` carrying its parameter bindings end-to-end.

Full surface — see [QueryDSL guide](./query-builder-querydsl.md). Quick map:

| Family | Members |
|--------|---------|
| Null handling | `coalesce(a, b, …)`, `nullif(a, b)` |
| Row-wise min / max | `greatest(a, b, …)`, `least(a, b, …)` — also `col.greatest(…)` / `col.least(…)`. `GREATEST`/`LEAST` on PostgreSQL and MySQL, scalar `MAX`/`MIN` on SQLite; NULL handling is engine-specific |
| Casts | `.stringValue / intValue / longValue / bigintValue / floatValue / booleanValue` (column or scalar) |
| Date / time | `currentDate / currentTime / currentTimestamp`, `dateTrunc(value, unit)`, `dateDiff(a, b, unit)`, `.addYears/Months/Days/Hours/Minutes/Seconds(n)`, `.year / month / day / hour / minute / second / dayOfWeek / dayOfMonth / dayOfYear / week` |
| Aggregates | `count(arg)`, `sum / avg / min / max / aggregate(scalarExpr)` (also chainable from `ColumnExpression`) |
| Ordered-set aggregates *(PostgreSQL-native; MySQL / SQLite throw `UNSUPPORTED_OPERATION`)* | `percentileCont(p, orderBy)`, `percentileDisc(p, orderBy)`, `mode(orderBy)` |
| Window functions | `rowNumber / rank / denseRank / ntile(n) / percentRank / cumeDist`, positional `lag / lead(expr, offset?, default?) / firstValue / lastValue / nthValue(expr, n)`. All return a `WindowBuilder` accepting `.partitionBy(...)` / `.orderBy(...)` / `.rowsBetween(...)` / `.rangeBetween(...)` before `.as(alias)`. |
| CASE | `caseBuilder()`, `cases(subject)`, plus shortcuts `iff(cond, a, b)`, `mapValues(subject, {…}, default?)`, `buckets(subject, [[t, r], …], default?)` |
| Subqueries | `exists(subQb)`, `notExists(subQb)`, column `.in(subQb) / .notIn(subQb) / .eq(subQb)` … |
| Logical | `and(...)`, `or(...)`, `not(cond)` over `ConditionLike` (column / JSON-path / aggregate / scalar) |
| Strings | `.toLowerCase / toUpperCase / trim / length / substring(s, e?) / concat(...args) / indexOf(needle) / replace(from, to)`, LIKE-safe `.startsWith / endsWith / contains` (`*IgnoreCase` siblings) |
| Arithmetic / math | `.add / sub / mul / div / mod / neg / abs / floor / ceil / round(digits?) / sqrt`, `random()` |
| Full-text | `Conditions.fullTextSearch(columns, term, { language?, mode? })` — MySQL `MATCH … AGAINST`, PostgreSQL `to_tsvector @@ to_tsquery` |
| Escape hatches | ``Expressions.raw<T>(sql`…`)``, `qb.selectSchema(zodSchema)` (Zod / Valibot / Effect — narrows `TResult`) |

### RawQueryBuilder — Set Operations, CTE, Window Functions

[Usage ->](./query-builder.md)

```typescript
class RawQueryBuilder {
  // ... (basic SELECT/FROM/WHERE/JOIN/ORDER BY/LIMIT methods)

  // Set Operations
  union(): this;
  unionAll(): this;
  intersect(): this;
  except(): this;

  // DISTINCT
  selectDistinct(columns: string[]): this;
  selectDistinctOn(distinctColumns: string[], selectColumns: string[] | "*"): this;

  // Common Table Expressions
  with(name: string, subquery: Sql | ((qb: RawQueryBuilder) => RawQueryBuilder)): this;
  withRecursive(name: string, subquery: Sql | ((qb: RawQueryBuilder) => RawQueryBuilder)): this;

  // Window Functions
  selectWithWindow(columns: Array<string | WindowColumn>): this;
}

interface WindowColumn {
  expr: string;                         // e.g. "ROW_NUMBER()", "SUM(salary)"
  over: { partitionBy?: string; orderBy?: string };
  alias: string;
}
```

### RowValidator / ArrayValidator

[Usage ->](./query-builder-execution.md#result-validation-—-validate)

```typescript
// Row-level: validates each row individually
type RowValidator<TResult> =
  | ((row: TResult) => TResult)         // Plain function
  | { parse(data: unknown): TResult };  // Zod-style (.parse() method)

// Array-level: validates the entire result array
type ArrayValidator<TResult> =
  | ((rows: TResult[]) => TResult[])
  | { parse(data: unknown): TResult[] };
```

### CursorPaginationOption\<T\> / CursorPaginationResult\<T\>

```typescript
interface CursorPaginationOption<T> {
  take?: number;               // Page size (default: 20)
  cursor?: string;             // Base64 cursor
  orderBy?: keyof T & string;  // Sort column (default: PK)
  direction?: "ASC" | "DESC";  // Sort direction (default: "ASC")
  where?: Partial<T>;          // WHERE conditions
}

interface CursorPaginationResult<T> {
  data: T[];
  hasNextPage: boolean;
  nextCursor: string | null;
  count: number;
}
```

### ExplainResult

```typescript
interface ExplainResult {
  raw: Record<string, unknown>[];
  rows: number | null;
  type: string | null;           // ALL, ref, Seq Scan, etc.
  possibleKeys: string[] | null;
  key: string | null;
  cost: number | null;
}
```

### DeleteResult

```typescript
interface DeleteResult {
  affected: number;
}
```

### ColumnOption

```typescript
interface ColumnOption {
  name?: string;           // Column name (defaults to property name)
  type?: ColumnType;       // Column type (auto-inferred if omitted)
  length?: number;
  nullable?: boolean;      // Default: false
  primary?: boolean;
  autoIncrement?: boolean;
  default?: unknown;       // Column default value (string, number, boolean, or raw SQL in parentheses)
  transform?: (raw: unknown) => any;
  precision?: number;
  scale?: number;
  enumValues?: string[];   // PostgreSQL ENUM
  enumName?: string;       // PostgreSQL ENUM type name
}
```

### ColumnType

```typescript
type KnownColumnType =
  | "varchar" | "char" | "int" | "number" | "float" | "double" | "bigint"
  | "boolean" | "datetime" | "timestamp" | "timestamptz" | "date"
  | "text" | "longtext" | "blob" | "uuid"
  | "json" | "jsonb" | "enum" | "array";

// Custom types registered via ColumnTypeRegistry are also accepted as string.
type ColumnType = KnownColumnType | (string & {});
```

The 20 built-in `KnownColumnType` values are autocomplete-friendly. Beyond
those, any string registered with [`ColumnTypeRegistry`](#columntyperegistry)
(e.g. `"geometry"`, `"vector"`) is accepted, and the dialect-specific DDL is
resolved from the registered definition.

### Relation Options

```typescript
interface ManyToOneOption {
  joinColumn?: string;        // Deprecated on decorators — prefer @RelationColumn({ name }); still the contract for defineEntity/EntitySchema
  references?: string;        // Target reference column (defaults to PK)
  eager?: boolean;
  lazy?: boolean;
  cascade?: CascadeOption;
  onDelete?: ReferentialAction;  // 'CASCADE' | 'SET NULL' | 'SET DEFAULT' | 'RESTRICT' | 'NO ACTION'
  onUpdate?: ReferentialAction;  // default: 'NO ACTION'
  createForeignKeyConstraints?: boolean;  // false to skip FK constraint in DDL
  transform?: (raw: unknown) => any;
}

interface OneToManyOption<T> {
  mappedBy: Extract<keyof T, string> | (string & {});  // IntelliSense supported
  cascade?: CascadeOption;
}

interface OneToOneOption<T> {
  joinColumn?: string;        // Deprecated on decorators — prefer @RelationColumn({ name }); still the contract for defineEntity/EntitySchema
  inverseSide?: Extract<keyof T, string> | (string & {});  // IntelliSense supported
  eager?: boolean;
  cascade?: CascadeOption;
  onDelete?: ReferentialAction;  // 'CASCADE' | 'SET NULL' | 'SET DEFAULT' | 'RESTRICT' | 'NO ACTION'
  onUpdate?: ReferentialAction;  // default: 'NO ACTION'
  createForeignKeyConstraints?: boolean;  // false to skip FK constraint in DDL
}

interface ManyToManyOption<T> {
  joinTable?: { name: string; joinColumn: string; inverseJoinColumn: string };
  mappedBy?: Extract<keyof T, string> | (string & {});     // IntelliSense supported
}

type CascadeOption = boolean | ("insert" | "update" | "delete" | "remove")[];

interface RelationColumnOption {
  name?: string;              // FK column name (inferred as {propertyName}Id if omitted)
  type?: ColumnType;          // FK column type (inferred from target PK if omitted)
  nullable?: boolean;         // default: true
  referencedColumn?: string;  // Target reference column (defaults to PK)
}
```

> `mappedBy` and `inverseSide` provide auto-completion for the target entity's property names. Arbitrary strings are also allowed.

### Configuration Options

```typescript
interface DatabaseClientOptions {
  type: "mysql" | "mariadb" | "postgres" | "sqlite";
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  entities: AnyEntity[];
  synchronize?: boolean | "safe" | "dry-run" | SynchronizeOptions; // object form: { mode, continueOnError, failOnDestructiveChange, logDDL }
  schema?: string;
  charset?: string;
  datesStrings?: boolean;
  queryTimeout?: number;
  pool?: PoolOptions;
  retry?: RetryOptions;
  logging?: boolean | LoggingOptions;
  replication?: ReplicationConfig;
  plugins?: StingerloomPlugin[];  // Auto-install plugins on register()
}

interface PoolOptions {
  max?: number;              // Default: 10
  min?: number;              // Default: 0
  acquireTimeoutMs?: number; // Default: 30000
  idleTimeoutMs?: number;    // Default: 10000
}

interface RetryOptions {
  maxAttempts: number;  // Default: 3
  backoffMs: number;    // Default: 1000
}

interface LoggingOptions {
  queries?: boolean;
  slowQueryMs?: number;
  nPlusOne?: boolean;
}

interface ReplicationConfig {
  master: ReplicationNodeConfig;
  slaves: ReplicationNodeConfig[];
  healthCheck?: HealthCheckConfig;
}

interface HealthCheckConfig {
  enabled: boolean;
  intervalMs?: number;          // Default: 5000
  query?: string;               // Default: "SELECT 1"
  failureThreshold?: number;    // Default: 3
  recoveryThreshold?: number;   // Default: 2
}

interface ReplicationNodeConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
}
```

### EntitySubscriber\<T\>

```typescript
interface EntitySubscriber<T = any> {
  listenTo(): new (...args: any[]) => T;
  afterLoad?(entity: T): void | Promise<void>;
  beforeInsert?(event: InsertEvent<T>): void | Promise<void>;
  afterInsert?(event: InsertEvent<T>): void | Promise<void>;
  beforeUpdate?(event: UpdateEvent<T>): void | Promise<void>;
  afterUpdate?(event: UpdateEvent<T>): void | Promise<void>;
  beforeDelete?(event: DeleteEvent<T>): void | Promise<void>;
  afterDelete?(event: DeleteEvent<T>): void | Promise<void>;
  beforeTransactionStart?(): void | Promise<void>;
  afterTransactionStart?(): void | Promise<void>;
  beforeTransactionCommit?(): void | Promise<void>;
  afterTransactionCommit?(): void | Promise<void>;
  beforeTransactionRollback?(): void | Promise<void>;
  afterTransactionRollback?(): void | Promise<void>;
}

interface InsertEvent<T> { entity: Partial<T>; manager: EntityManager; }
interface UpdateEvent<T> { entity: Partial<T>; manager: EntityManager; }
interface DeleteEvent<T> { entityClass: new (...args: any[]) => T; criteria: any; manager: EntityManager; }
```

### EntityEventType

```typescript
type EntityEventType =
  | "beforeInsert" | "afterInsert"
  | "beforeUpdate" | "afterUpdate"
  | "beforeDelete" | "afterDelete";
```

### StingerloomPlugin\<TApi\>

[Usage ->](./plugins.md)

```typescript
interface StingerloomPlugin<TApi = {}> {
  readonly name: string;
  readonly dependencies?: readonly string[];
  install(context: PluginContext): TApi | void;
  shutdown?(): Promise<void> | void;
  beforeQuery?(query: QueryInfo): QueryInfo | void;
  afterQuery?(query: QueryInfo, result: any, durationMs: number): void;
}

interface QueryInfo {
  sql: string;
  params?: any[];
  operation?: string;  // "select" | "insert" | "update" | "delete" | "raw"
}
```

### ITenantMigrationRunner

[Usage ->](./multi-tenancy.md)

```typescript
interface ITenantMigrationRunner {
  discoverSchemas(): Promise<string[]>;
  ensureSchema(tenantId: string): Promise<void>;
  syncTenantSchemas(tenantIds: string[]): Promise<TenantSyncResult>;
  isProvisioned(tenantId: string): boolean;
  getProvisionedSchemas(): string[];
  reset(): void;
}

interface TenantSyncResult { created: string[]; skipped: string[]; }
```

Implementations: `PostgresTenantMigrationRunner`, `MySqlTenantMigrationRunner`, `SqliteTenantMigrationRunner`

### Migration

[Usage ->](./migrations.md)

```typescript
abstract class Migration {
  get name(): string;
  abstract up(context: MigrationContext): Promise<void>;
  abstract down(context: MigrationContext): Promise<void>;
}

interface MigrationContext {
  driver: ISqlDriver;
  query: (sql: string) => Promise<any>;
}
```

### SchemaDiffResult

```typescript
interface SchemaDiffResult {
  addedTables: string[];
  droppedTables: string[];
  modifiedTables: ModifiedTable[];
  renamedColumns?: RenamedColumn[];       // Heuristic-detected column renames
  addTableEntityMap?: Record<string, ClazzType<any>>;
}

interface ModifiedTable {
  tableName: string;
  addedColumns: ColumnChange[];
  droppedColumns: ColumnChange[];
}

interface ColumnChange {
  columnName: string;
  columnType?: string;
  nullable?: boolean;
}

interface RenamedColumn {
  tableName: string;
  oldColumnName: string;
  newColumnName: string;
}
```

### MigrationHooks

```typescript
interface MigrationHooks {
  beforeAll?(context: MigrationContext): Promise<void> | void;
  afterAll?(context: MigrationContext, results: MigrationResult[]): Promise<void> | void;
  beforeEach?(migration: Migration, context: MigrationContext): Promise<void> | void;
  afterEach?(migration: Migration, context: MigrationContext, durationMs: number): Promise<void> | void;
  onError?(migration: Migration, error: Error, context: MigrationContext): Promise<void> | void;
}

interface MigrationRunnerOptions {
  lockId?: string;
  lockTimeoutMs?: number;
  tableName?: string;              // Default: "__migrations"
  hooks?: MigrationHooks;
}
```

### MigrationCli

```typescript
class MigrationCli {
  constructor(migrations: Migration[], options: DatabaseClientOptions);
  connect(): Promise<void>;
  close(): Promise<void>;
  execute(command: MigrationCommand): Promise<any>;
}

type MigrationCommand = "migrate:run" | "migrate:rollback" | "migrate:status" | "migrate:generate";
```

CLI executable: `npx stingerloom migrate:run|rollback|status|generate`

Related classes: `MigrationRunner`, `MigrationCli`, `SchemaDiff`, `SchemaDiffMigrationGenerator`

### EntityMetadataView

```typescript
interface EntityMetadataView {
  tableName: string;
  columns: ColumnMetadataView[];
  relations: RelationMetadataView[];
  indexes: any[];
  deletedAtColumn?: string;
  createTimestampColumn?: string;
  updateTimestampColumn?: string;
  versionColumn?: string;
}

interface ColumnMetadataView {
  propertyKey: string;
  columnName: string;
  type: string;
  nullable: boolean;
  primary: boolean;
  unique: boolean;
  default?: any;
  length?: number;
}

interface RelationMetadataView {
  type: "ManyToOne" | "OneToMany" | "ManyToMany" | "OneToOne";
  propertyKey: string;
  target: ClazzType<any>;
  joinColumn: string | null;
  eager: boolean;
}
```

### DriverRegistry

```typescript
class DriverRegistry {
  static register(dbType: string, factory: DriverFactory): void;
  static unregister(dbType: string): void;
  static has(dbType: string): boolean;
  static get(dbType: string): DriverFactory | undefined;
  static getRegisteredTypes(): string[];
}

interface DriverFactory {
  createDriver(connector: any, dbType: string, schema?: string): ISqlDriver;
  createDataSource(connector: any): IDataSource;
}
```

### ColumnTypeRegistry

```typescript
class ColumnTypeRegistry {
  static getInstance(): ColumnTypeRegistry;
  register(name: string, definition: CustomColumnTypeDefinition): void;
  unregister(name: string): void;
  has(name: string): boolean;
  resolve(name: string, dialect: DialectName): string | undefined;
  getTransformer(name: string): ColumnTransformer | undefined;
  getRegisteredNames(): string[];
}

interface CustomColumnTypeDefinition {
  mysql?: string;
  postgres?: string;
  sqlite?: string;
  transformer?: ColumnTransformer;
}
```

### Test Utilities

```typescript
// @stingerloom/orm/testing
function createTestEntityManager(options: TestEntityManagerOptions): Promise<EntityManager>;
function createMockRepository<T>(entity: ClazzType<T>, overrides?: MockMethods<T>): BaseRepository<T>;
class InMemoryDriver implements Partial<ISqlDriver>;
```

## Tooling

### Seeder / SeederRunner

[Usage ->](./seeding.md)

Re-exported from `src/seeding/`. Pair an abstract `Seeder` subclass with
`SeederRunner` to populate the database with reproducible fixtures or
production-ready defaults. Execution is tracked in a `__seeds` table so each
seeder runs at most once per environment.

```typescript
interface SeederContext {
  em: EntityManager;
}

abstract class Seeder {
  readonly name: string;                       // defaults to constructor.name
  abstract run(ctx: SeederContext): Promise<void>;
  revert?(ctx: SeederContext): Promise<void>;  // optional, called by revertLast()
}

interface SeederResult {
  name: string;
  direction: "run" | "revert";
  success: boolean;
  error?: string;
}

interface SeederRunnerOptions {
  trackExecution?: boolean;  // default: true
  tableName?: string;        // default: "__seeds"
}

interface SeederQueryRunner {
  query: (sql: string) => Promise<any>;
}

class SeederRunner {
  constructor(
    seeders: Seeder[],
    em: EntityManager,
    queryRunner: SeederQueryRunner,
    options?: SeederRunnerOptions,
  );
  ensureSeedTable(): Promise<void>;
  runAll(): Promise<SeederResult[]>;
  runOne(seeder: Seeder): Promise<SeederResult>;
  revertLast(): Promise<SeederResult | null>;
  status(): Promise<{ executed: string[]; pending: string[] }>;
  getExecutedSeeds(): Promise<string[]>;
}
```

### IntrospectionGenerator

[Usage ->](./introspection.md)

Re-exported from `src/introspection/`. Reads `INFORMATION_SCHEMA` (PostgreSQL
catalog or SQLite `PRAGMA`s) and produces decorator-based entity source code
for the discovered tables. Output is round-trip stable: applying the
generated entities back to a fresh schema and re-introspecting reproduces
the same files.

```typescript
type IntrospectionDialect = "mysql" | "postgres" | "sqlite";

interface GeneratedEntity {
  tableName: string;
  className: string;
  code: string;
  fileName: string;
}

interface IntrospectionGeneratorOptions {
  schema?: string;                                  // default: "public" (PostgreSQL)
  excludeTables?: string[];
  includeTables?: string[];                         // if set, only these are emitted
  codeBuilderOptions?: EntityCodeBuilderOptions;    // e.g. { importPath: "../orm" }
}

interface IntrospectionQueryFn {
  (sql: string | import("sql-template-tag").Sql): Promise<any>;
}

class IntrospectionGenerator {
  constructor(
    queryFn: IntrospectionQueryFn,
    dialect: IntrospectionDialect,
    options?: IntrospectionGeneratorOptions,
  );
  generate(): Promise<GeneratedEntity[]>;
  discoverTables(): Promise<string[]>;
  getColumns(table: string): Promise<DbColumn[]>;
  getPrimaryKeys(table: string): Promise<string[]>;
  getForeignKeys(table: string): Promise<DbForeignKey[]>;
  getIndexes(table: string): Promise<DbIndex[]>;
}

// Convenience wrapper — connects via DatabaseClient, writes files to disk.
// Also drives the `npx stingerloom introspect` CLI command.
interface IntrospectionCliOptions {
  outputDir?: string;             // default: "./entities"
  schema?: string;
  includeTables?: string[];
  excludeTables?: string[];
  codeBuilderOptions?: EntityCodeBuilderOptions;
  dryRun?: boolean;
}

interface IntrospectionCliResult {
  writtenFiles: string[];
  entities: GeneratedEntity[];
}

function runIntrospect(
  dbOptions: DatabaseClientOptions,
  cliOptions?: IntrospectionCliOptions,
): Promise<IntrospectionCliResult>;

// Lower-level helpers (also re-exported)
class EntityCodeBuilder {
  constructor(options?: EntityCodeBuilderOptions);
  build(tableName: string, columns: DbColumn[],
        pks: string[], fks: DbForeignKey[],
        dialect: IntrospectionDialect,
        indexes?: DbIndex[]): string;
  tableNameToClassName(tableName: string): string;
  classNameToFileName(className: string): string;
}

class IntrospectionTypeMapper {
  // `columnTypeFull` lets MySQL distinguish TINYINT(1)→boolean from
  // wider widths→int. Optional for backwards compatibility.
  toColumnType(
    dbType: string,
    dialect: IntrospectionDialect,
    columnTypeFull?: string,
  ): ColumnType;
  toTsType(columnType: ColumnType): string;
  parseSqliteWidth(declaredType: string): number | null;
  parseSqlitePrecisionScale(declaredType: string): { precision: number; scale: number } | null;
}
```

### PrismaImporter

[Usage ->](./prisma-import.md)

Re-exported from `src/integration/prisma-import/`. Converts a `schema.prisma`
file into decorator-based entity files. Also available as the
`stingerloom-prisma-import` CLI binary. Requires `@mrleebo/prisma-ast` as a
peer dependency.

```typescript
interface PrismaImportOptions {
  schemaPath: string;
  outputDir: string;
  force?: boolean;                                  // overwrite existing files
  provider?: "postgresql" | "mysql" | "sqlite";     // override detected provider
}

interface PrismaImportResult {
  written: string[];
  skipped: string[];
  warnings: string[];
  files: Map<string, string>;                       // filename → source
}

class PrismaImporter {
  // Parse + write to disk.
  import(options: PrismaImportOptions): Promise<PrismaImportResult>;
  // Parse + return generated source as a Map (no disk I/O).
  generate(source: string, provider?: string): Map<string, string>;
}
```

The module also re-exports the lower-level building blocks (`PrismaParser`,
`PrismaSchemaAnalyzer`, `RelationResolver`, `TypeMapper`, `FileWriter`) for
custom pipelines.

## Errors

All ORM errors extend `OrmError`, which includes an optional `suggestion` field with an actionable fix hint. This helps you diagnose problems without consulting documentation:

```typescript
try {
  await em.find(UnregisteredEntity);
} catch (e) {
  if (e instanceof OrmError) {
    console.error(e.message);      // "Entity metadata not found for UnregisteredEntity"
    console.error(e.suggestion);   // "Did you register the entity in the entities array?"
    console.error(e.code);         // "ORM_ENTITY_METADATA_NOT_FOUND"
  }
}
```

`ValidationError` additionally carries `actual` and `expected` fields for quick diagnosis:

```typescript
try {
  await em.save(User, { name: "A" }); // @MinLength(2) fails
} catch (e) {
  if (e instanceof ValidationError) {
    console.error(e.message);    // "name must be at least 2 characters long"
    console.error(e.actual);     // "A"
    console.error(e.expected);   // "minLength: 2"
  }
}
```

| Error | Description |
|-------|-------------|
| `OrmError` | Base ORM error (includes `code`, `message`, and optional `suggestion`) |
| `ValidationError` | Validation failure (includes `actual` and `expected` fields) |
| `InvalidQueryError` | Invalid query (includes optional `suggestion` for fix hints) |
| `EntityNotFoundError` | Entity not found |
| `EntityMetadataNotFoundError` | Metadata not found |
| `PrimaryKeyNotFoundError` | PK not found |
| `DeleteWithoutConditionsError` | Delete without conditions |
| `QueryTimeoutError` | Query timeout |
| `TransactionError` | Transaction error |
| `DatabaseNotConnectedError` | DB not connected |
| `DatabaseConnectionFailedError` | DB connection failed |
| `NotSupportedDatabaseTypeError` | Unsupported DB type |

### OrmErrorCode

```typescript
enum OrmErrorCode {
  CONNECTION_FAILED = "ORM_CONNECTION_FAILED",
  NOT_CONNECTED = "ORM_NOT_CONNECTED",
  UNSUPPORTED_DATABASE = "ORM_UNSUPPORTED_DATABASE",
  ENTITY_NOT_FOUND = "ORM_ENTITY_NOT_FOUND",
  ENTITY_METADATA_NOT_FOUND = "ORM_ENTITY_METADATA_NOT_FOUND",
  PRIMARY_KEY_NOT_FOUND = "ORM_PRIMARY_KEY_NOT_FOUND",
  INVALID_QUERY = "ORM_INVALID_QUERY",
  DELETE_WITHOUT_CONDITIONS = "ORM_DELETE_WITHOUT_CONDITIONS",
  QUERY_TIMEOUT = "ORM_QUERY_TIMEOUT",
  TRANSACTION_FAILED = "ORM_TRANSACTION_FAILED",
  TRANSACTION_ROLLBACK_FAILED = "ORM_TRANSACTION_ROLLBACK_FAILED",
  VALIDATION_FAILED = "ORM_VALIDATION_FAILED",
  UNIQUE_VIOLATION = "ORM_UNIQUE_VIOLATION",
  FK_VIOLATION = "ORM_FK_VIOLATION",
  PLUGIN_DEPENDENCY_MISSING = "ORM_PLUGIN_DEPENDENCY_MISSING",
  PLUGIN_CONFLICT = "ORM_PLUGIN_CONFLICT",
  BUFFER_NOT_INSTALLED = "ORM_BUFFER_NOT_INSTALLED",
}
```

## EntitySchema (Decorator-Free Entity Definition)

[Usage ->](./entities.md#defining-entities-without-decorators-entityschema) · [Full decorator → alternative map ->](./decorator-free.md)

```typescript
import { EntitySchema, EntitySchemaOptions, ColumnSchemaDef } from "@stingerloom/orm";

const schema = new EntitySchema<T>(options: EntitySchemaOptions<T>);
```

### EntitySchemaOptions\<T\>

```typescript
interface EntitySchemaOptions<T> {
  target: ClazzType<T>;                                    // Entity class
  tableName?: string;                                      // Table name (defaults to snake_case of class name)
  columns: { [K in keyof T]?: ColumnSchemaDef };           // Column definitions
  computedColumns?: { [K in keyof T]?: ComputedColumnOption };  // @ComputedColumn equivalents
  relations?: { [K in keyof T]?: RelationSchemaDef };      // Relation definitions
  uniqueIndexes?: { columns: string[]; name?: string }[];  // Composite unique indexes
  indexes?: { columns: string[]; name?: string; options?: AdvancedIndexOptions }[];  // Composite non-unique indexes
  fullTextIndexes?: { columns: string[]; name?: string; language?: string }[];  // @FullTextIndex equivalents
  nonTenant?: boolean;                                     // @NonTenantEntity equivalent
  hooks?: Partial<Record<HookEvent, Extract<keyof T, string>>>;  // Lifecycle hooks

  // Inheritance mapping (replaces @Inheritance, @DiscriminatorColumn, @DiscriminatorValue)
  inheritance?: InheritanceSchemaDef;                      // Root entity: strategy declaration
  discriminatorColumn?: DiscriminatorColumnSchemaDef;      // Root entity: discriminator column config
  discriminatorValue?: string;                             // Child entity: discriminator value
}

interface InheritanceSchemaDef {
  strategy: "SINGLE_TABLE" | "JOINED" | "TABLE_PER_CLASS";
}

interface DiscriminatorColumnSchemaDef {
  name?: string;           // Default: "dtype"
  type?: KnownColumnType;  // Default: "varchar"
  length?: number;         // Default: 31
}
```

### ColumnSchemaDef

```typescript
interface ColumnSchemaDef {
  type: ColumnType;
  primary?: boolean;
  autoIncrement?: boolean;
  length?: number;
  nullable?: boolean;
  default?: string | number | boolean | null;
  precision?: number;
  scale?: number;
  enumValues?: string[];
  enumName?: string;
  name?: string;
  transform?: (raw: unknown) => any;          // @deprecated — use transformer
  transformer?: ColumnTransformer;            // @Column({ transformer }) — bidirectional
  generationStrategy?: "increment" | "uuid" | "uuid-v7";  // @PrimaryGeneratedColumn(strategy)
  jsonIndex?: JsonIndexOptions;               // @JsonIndex() on this column
  tenant?: boolean;                           // @TenantColumn() — marks the tenant discriminator

  // Special column flags
  index?: boolean;              // Equivalent to @Index()
  createTimestamp?: boolean;     // Equivalent to @CreateTimestamp()
  updateTimestamp?: boolean;     // Equivalent to @UpdateTimestamp()
  deletedAt?: boolean;           // Equivalent to @DeletedAt()
  version?: boolean;             // Equivalent to @Version()

  // Inline validation
  validation?: ValidationDef[];
}

interface ValidationDef {
  constraint: "notNull" | "minLength" | "maxLength" | "min" | "max";
  value?: number;
  message?: string;
}
```

### RelationSchemaDef

```typescript
type RelationSchemaDef =
  | { kind: "manyToOne"; target: () => ClazzType; joinColumn?: string; references?: string; eager?: boolean; cascade?: CascadeOption; lazy?: boolean; relationColumn?: RelationColumnOption }
  | { kind: "oneToMany"; target: () => ClazzType; mappedBy: string; cascade?: CascadeOption }
  | { kind: "oneToOne"; target: () => ClazzType; joinColumn?: string; inverseSide?: string; eager?: boolean; cascade?: CascadeOption; relationColumn?: RelationColumnOption }
  | { kind: "manyToMany"; target: () => ClazzType; joinTable?: JoinTableOption; mappedBy?: string };
```

> `relationColumn` carries explicit FK column metadata (`name`, `type`, `nullable`, `referencedColumn`) — the `@RelationColumn()` equivalent. See the [Decorator-Free Guide](./decorator-free.md#foreign-key-columns-relationcolumn).

## Utilities

| Export | Description |
|--------|-------------|
| `ClazzType<T>` | `new (...args: any[]) => T` |
| `EntityResult<T>` | **Deprecated** — was `T \| T[]`, replaced by `T[]` for `find()` and `T` for `save()` |
| `DeepPartial<T>` | Deep partial type |
| `Relation<T>` | Identity wrapper for single-valued relation properties — erases `design:type` to `Object` so mutually-referencing entities load under ESM (see [Relations](./relations.md)) |
| `WhereClause<T>` | Typed WHERE conditions — column equality plus operators (`gt`, `in`, `like`, …) and `AND` / `OR` / `NOT` |
| `RawQueryBuilderFactory` | Query builder factory |
| `MetadataLayerRegistry` | Decorator-time canonical layered-metadata registry (singleton) |
| `MetadataContext` | AsyncLocalStorage-based tenant context |
| `Logger` | Internal logging utility |
