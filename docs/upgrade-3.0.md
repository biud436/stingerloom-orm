# Upgrading to 3.0

3.0 continues where 2.0 left off: more states that used to fail silently now fail loudly, and reads are typed by what they load. A `select` narrows the result type, and a relation can pick its own columns. Most applications upgrade by changing the version number and fixing what the compiler and the test suite point at. This page lists everything that can break, and what to do about it.

```bash
pnpm add @stingerloom/orm@3
```

## Start here

Run the type checker and your test suite, with logging enabled, before deploying. The breaking changes either show up as a compile error (result types, option types) or turn a silent state into an exception or a warning, so one pass over both surfaces them:

```bash
npx tsc --noEmit
```

```typescript
await em.register({ /* ... */, logging: true });
```

## Things that stop compiling

### A read's result type follows its `select`

`find()` returned `T[]` whatever `select` said, so a column you left out was typed as present and read as `undefined`. With a `select`, each entity is now typed with the selected properties, the relations the read loads, the counts `withCount` writes and the entity's methods:

```typescript
const users = await em.find(User, { select: ["id", "name"] });
//    ^? Pick<User, "id" | "name" | "greet">[]
```

The same goes for `findOne()`, `findOneOrFail()`, `findAndCount()`, `findWithPage()`, `stream()` and `streamBatch()`, on `EntityManager`, repositories and `MultiTenantEntityManager`, and for a `select` in a relation's entry (`relations: { author: { select: ["name"] } }`).

Code that annotated such a read as the full entity no longer compiles:

```typescript
const users: User[] = await em.find(User, { select: ["id"] });  // error in 3.0
```

Drop the annotation, or select the columns the code reads. Reads without a `select`, and options typed as a plain `FindOption<User>`, keep returning `User` — generic code that forwards options is unaffected. Columns the read adds on its own (the primary key a collection relation is matched by) are on the object but not in the narrowed type; cast if you read them.

### The object form of `select` takes only `true` / `false`

`ISelectOption` had a third form, `{ author: { ... } }`, that type-checked as a way to choose a relation's columns and was ignored at runtime. It is gone, and a non-boolean value throws `InvalidQueryError`. Pick a relation's columns in its entry instead:

```typescript
em.find(Post, { relations: { author: { select: ["id", "name"] } } });
```

### `em.pipe()` takes only its own options

`RawPipelineOptions` extended `FindOption`, so `take`, `limit`, `relations`, `withDeleted` and the rest type-checked and were ignored: `em.pipe(User, { take: 10 })` read the whole table. It now declares what a pipeline does: `where`, `orderBy`, `select` (an array of property names), `batchSize` and `keyset`. A `find()` option on a pipeline is a compile error, and the same keys built at runtime throw `InvalidQueryError` with the reason. Stop iterating to read fewer rows.

### A `defineEntity` column with `.transformer()` is typed as the transformer's value

The field kept the column's own type, so a transformer that read a value object still typed it as `string`. It now takes the type `from` returns and `to` accepts. Code that cast around the old type may need the cast removed.

## Things that now throw

Each of these was previously a silent wrong answer, or a failure far from its cause.

| What you write | 2.x | 3.0 |
| --- | --- | --- |
| `register({ synchronize: "yes" })`, a misspelled `tenantStrategy`, an unknown key in a nested options object | Accepted, fell back to a default | `OrmError(INVALID_CONFIG)` at `register()`, with the closest value |
| A relation whose target is not registered, or whose `mappedBy` / `inverseSide` names nothing | Failed on the first load, or loaded as `null` / missing | `OrmError(SCHEMA_ERROR)` at `register()` listing every such relation, before any table is created |
| An unknown column type, an entity glob file that does not load, a schema comparison that fails | Logged, and booted without the entity or the change | Boot stops with the cause |
| `propagation: "REQUIRES_NEW"` misspelled, an unknown `isolationLevel` | Ran with the default | `OrmError(INVALID_CONFIG)` |
| `versionOverride` that is not a version | Ignored | `OrmError(INVALID_CONFIG)` at `register()` |
| `createQueryBuilder(Entity)` without an alias | Built SQL with a missing alias | `InvalidQueryError` |
| Read options, `where` clauses and write criteria built at runtime with the wrong shape (`take: "10"`, `orderBy: "title"`, a typo'd option key) | A driver error, or the option ignored | `InvalidQueryError` naming every problem |
| `findOne(User, { where: { id } })` with `id` undefined, and the same in `findByPK()`, `exists()` and the other single-row reads | Read an arbitrary row | `InvalidQueryError` naming the undefined paths |
| `delete()`, `softDelete()`, `restore()` with criteria that resolve to nothing | Fired events and cascades before failing | Rejected before anything runs |
| An array or object bound to a column that cannot store it | Spread over the row's parameters, shifting later values | `InvalidQueryError` naming the property |
| A `bigint` value beyond ±2^53 read into a `number` property | Rounded | `OrmError` `BIGINT_PRECISION_LOSS` — set `bigintMode: "string"` or `"bigint"` |
| `deleteMany()` on a composite primary key with scalar ids | Deleted every row sharing the first key column | `InvalidQueryError`; pass key objects |
| `attachRelation()` to a row outside the current tenant under `tenant_column` | Linked it | `EntityNotFoundError` (`detachRelation()` returns `{ affected: 0 }`) |
| `createDialectExpression()` / `createColumnDefinitionBuilder()` with an unknown dialect name | `undefined`, then a `TypeError` far away | `OrmError(ORM_UNSUPPORTED_DATABASE)` |

A new connection-level policy reports writes that drop data, as a warning by default:

- **`unknownWriteKeys`** — a key in a `save()` / `insertMany()` / `upsert()` payload that names no column (`firstNam`) used to be left out of the statement. It is logged once per entity and key with the closest name. `"throw"` rejects the write, `"ignore"` keeps the old behavior.
- A related row that no write persists (`save(User, { posts: [{ title }] })` with no cascade on `posts`, or any related row passed to a bulk write) is reported under the same policy.

## Things that return different results

### `clear()` deletes with `DELETE`, in your transaction

PostgreSQL ran `TRUNCATE ... RESTART IDENTITY CASCADE`, which also emptied every referencing table; MySQL truncated with foreign key checks off. `clear()` now deletes exactly the rows the caller can see (the current tenant's, a single-table child's subtype, every table of an inheritance hierarchy), inside the caller's transaction, and writes no other table:

- Identity counters are no longer restarted. A test that expects ids to start at 1 after `clear()` needs to read the generated ids instead.
- Rows that are still referenced make `clear()` fail under the default `NO ACTION`. Clear the referencing table first, or declare `onDelete: "CASCADE"`.

### After-events fire only when the write matched a row

`delete()`, `deleteMany()`, `softDelete()`, `restore()`, `update()`, `updateMany()`, `increment()` and `decrement()` fired their after-event on every call, so `delete(User, { id: 9999 })` reported a deletion that never happened. The after-event now fires only when the statement reported at least one row, and carries the count as `affected`. Before-events still fire on every call.

### Schema synchronization no longer guesses renames

A dropped column whose type matched an added column was renamed on the first match, carrying old values into an unrelated column. A rename is now applied only when the entity declares `renamedFrom`, or when the names read as the same column (`user_name` → `userName`, `name` → `fullName`, a short typo). Anything else is applied as the drop and add the entity declares, with a warning naming the `renamedFrom` to add. If you relied on the old inference, add `renamedFrom` before synchronizing.

### An array property is a `json` column

`@Column() tags!: string[]` with no explicit `type` mapped to `text`. It is `json` now (nullable), so an existing `text` column no longer matches the entity on MySQL and PostgreSQL. Declare `type: "text"` to keep it, or migrate the data before synchronizing.

### `bigint` columns are read losslessly

The drivers now deliver integers beyond ±2^53 as decimal strings instead of rounding them, and `bigintMode` decides what the property holds: `"number"` (default, throws past ±2^53), `"string"` or `"bigint"`. A property declared as `bigint` infers `bigintMode: "bigint"`. On SQLite, bigint columns are declared `BIGINT` (same storage).

### Keyset pages follow the primary key

`getCursor()` on the query builder paged by the sort value alone and skipped rows sharing it. It now uses `findWithCursor()`'s keyset: pages are ordered by the sort property, then every primary key column, and NULL sort values come last ascending. An `orderBy()` on the builder no longer orders rows that share a sort value. A cursor from 2.x still pages its one transition page as before.

### MySQL 8.0.19+ upserts use a row alias

`upsert()`, `batchUpsert()` and `createInsertBuilder()` emit `INSERT … AS new (…) ON DUPLICATE KEY UPDATE` instead of the deprecated `VALUES(col)` when the server is MySQL 8.0.19 or later. MariaDB and older MySQL keep `VALUES()`. A custom driver can opt in through the new optional `ISqlDriver.supportsInsertRowAlias()`.

### A rolled-back write is taken back off your objects

After a ROLLBACK, the generated key, foreign keys and stamps a write put on the objects you passed are restored, so the same object can be saved again (a deadlock retry, for example). On COMMIT nothing changes.

### Smaller differences

- A requested isolation level is always sent, even when it matches the database's out-of-the-box default, so a server or session whose default was changed runs at the level you asked for.
- The query result cache invalidates a write when its transaction ends, not when the statement runs.
- A column added to an existing table gets its declared `default`, the same as in a new table.
- `upsert()`, `insertIgnore()` and `batchUpsert()` maintain `@Version`, `@CreateTimestamp`, `@UpdateTimestamp` and `@DeletedAt`, and scope by tenant under `tenant_column`.
- Reads of an inheritance hierarchy build each row as its subclass on every path (relations, the query builder, cursor pages, `em.pipe()`), and a `SINGLE_TABLE` instance holds only its own class's columns.
- `contains` / `startsWith` / `endsWith` escape `%`, `_` and `\` on SQLite too.
- `em.pipe()` reads the active tenant's rows, inside the current transaction.

The [changelog](https://github.com/biud436/stingerloom-orm/blob/main/CHANGELOG.md) has the full list, with the reason for each change.
