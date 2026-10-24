# Typed Raw Rows

`defineRow()` describes the rows a raw SQL query returns, using the same `t` builders as `defineEntity()`. Pass the result to `em.query()` and you get those rows back typed and converted. The table doesn't need to be mapped, and nothing is registered with the ORM.

```typescript
import { defineRow, t } from "@stingerloom/orm";

const CachedLocation = defineRow({
  id:       t.int(),
  x:        t.double(),
  y:        t.double(),
  cachedAt: t.datetime().name("cached_at"),
});

const [loc] = await em.query(CachedLocation)`
  SELECT * FROM cached_location AS a WHERE a.id = ${16}
`;
// loc: { id: number; x: number; y: number; cachedAt: Date }
```

## Why Row Shapes?

### Not every table belongs to the ORM

Take a game server as an example. Inventory items live in an `items` table. The ORM maps that table, creates and migrates it, and loads it together with its relations. This is the job entity mapping exists for.

Now suppose another developer has added a `cached_location` table to the same database. It is a coordinate cache that their own service fills. Your code only needs to read one row from it, and maybe only in a code path that rarely runs:

```sql
SELECT * FROM cached_location AS a WHERE a.id = 16
```

The query itself is trivial. Getting a correctly typed row out of it was not. Before row shapes, the ORM offered three ways to do this, and each one made you pay for something this read did not need.

### Option 1: `em.query<T>()` gives you a type nobody checks

```typescript
interface CachedLocation {
  id: number;
  isHot: boolean;
  cachedAt: Date;
  meta: { zone: string };
}

const [loc] = await em.query<CachedLocation>`
  SELECT * FROM cached_location WHERE id = ${16}
`;
```

Here `T` is only a type assertion. The ORM returns whatever the driver produced, and the three drivers produce different things:

| Column | PostgreSQL (`pg`) | MySQL / MariaDB (`mysql2`) | SQLite (`better-sqlite3`) |
|---|---|---|---|
| `DATETIME` / `TIMESTAMP` | `Date` | `Date` | `"2026-10-24 09:30:00"` |
| `BOOLEAN` / `TINYINT(1)` | `true` | `1` | `1` |
| `JSON` | parsed value | parsed (MySQL), `'{"zone":"z1"}'` (MariaDB) | `'{"zone":"z1"}'` |
| `BIGINT` | `"42"` | `42` | `42` |
| `NUMERIC` / `DECIMAL` | `"19.90"` | `"19.90"` | `19.9` |
| `COUNT(*)` | `"2"` | `2` | `2` |

The compiler is satisfied, but the program is not. `loc.cachedAt.getTime()` throws a `TypeError`, but only on SQLite. `loc.isHot === true` is `false` on MySQL. `row.total + 1` evaluates to `"21"` on PostgreSQL. Each bug shows up far from the query and on one database only, often in a test suite that runs against a different driver from production.

### Option 2: mapping the table as an entity is correct, but the table isn't yours

If you define `cached_location` with `@Entity` or `defineEntity()`, every conversion comes out right. You also take on three costs:

- **You register before you use.** Decorators and `defineEntity()` write entity metadata when the module is evaluated, and the class has to be listed in `entities`. That work happens at boot whether or not the code that reads the table ever runs.
- **The ORM takes ownership of the schema.** With `synchronize` on, the ORM treats the table as its own. It creates the table when it's missing, and under `synchronize: true` it alters columns to match the entity and drops the columns the entity does not declare. If you map only the three columns you read from someone else's table, the other columns get deleted.
- **You build a model for a single query.** An entity is also a contract for writes: a primary key, hooks, validation, tenant scoping, relations. For one read, all of that is ceremony.

### Option 3: `getRawMany({ coerce })` converts values, but needs an entity and two declarations

```typescript
// qb: a SelectQueryBuilder started from an entity
const rows = await qb.getRawMany<{ day: Date; total: number }>({
  coerce: { day: "date", total: "number" },
});
```

`coerce` does convert values at runtime. But it lives on the query builder, which starts from an entity. And the row type and the coerce map are two separate declarations that you keep in sync by hand: if you change one, the compiler won't tell you about the other.

### What a one-off read needs

1. **Honest types.** The static type matches the runtime value on every driver.
2. **Runtime conversion.** You declare it once and the ORM applies it.
3. **No registration.** No metadata, no `entities` entry, no DDL.
4. **Pay as you go.** A read that never runs costs nothing.

None of the three options delivers all four. Row shapes do.

### Design principles

- **A shape is a value, not a registration.** `defineRow()` returns a frozen object. It doesn't touch the metadata layers, schema synchronization or the `entities` list.
- **One declaration produces both the type and the conversion.** The same builders give you the TypeScript type (`InferRow`) and the runtime conversions, so the two can't drift apart.
- **The conversion rules are the same as for entities.** Row shapes and entity hydration share a single per-column read function in the ORM. A given column type reads the same way through `em.query(shape)` as through `find()`. The integration suite checks this on PostgreSQL, MySQL and SQLite.
- **Mismatches fail loudly.** If a declared column is missing from the result, or an integer is too large for a JS number, you get an error that names the column. You don't get `undefined` or a silently rounded number.
- **You can move up to an entity.** If the table later becomes yours, the same field map goes straight into `defineEntity()` (see [below](#to-entity)).

## Calling `em.query` with a shape

```typescript
// 1. Tagged template. Values are bound as parameters, and an entity class
//    becomes a table reference, exactly as in the tagged em.query form.
const rows = await em.query(CachedLocation)`
  SELECT l.* FROM cached_location AS l
  JOIN ${Item} AS i ON i.location_id = l.id
  WHERE i.owner_id = ${ownerId}
`;

// 2. Keep the runner and call it again.
const locations = em.query(CachedLocation);
const north = await locations`SELECT * FROM cached_location WHERE zone = ${"north"}`;

// 3. A SQL string with positional binds (in your driver's placeholder
//    syntax), or a pre-built Sql fragment such as RawQueryBuilder.build().
const byId = await em.query(
  CachedLocation,
  "SELECT * FROM cached_location WHERE id = $1",
  [16],
);
const built = await em.query(CachedLocation, sql`SELECT * FROM cached_location WHERE id = ${16}`);
```

The query runs exactly as `em.query()` would run it: inside the current transaction if there is one, otherwise in its own. The shape only changes what happens to the rows afterwards. You can recover the row type with `InferRow`:

```typescript
import type { InferRow } from "@stingerloom/orm";

type CachedLocation = InferRow<typeof CachedLocation>;
```

## How values are converted

| Builder | Row type | Conversion on read |
|---|---|---|
| `t.int()`, `t.integer()`, `t.float()`, `t.double()`, `t.number()`, `t.decimal(p, s)` | `number` | Numeric strings become numbers. This covers PostgreSQL `NUMERIC` and `COUNT(*)`, and mysql2 `DECIMAL` and `SUM()`. An integer outside ±2^53 throws `BIGINT_PRECISION_LOSS`. Text that isn't a number is passed through. |
| `t.bigint()` | `number` | Throws `BIGINT_PRECISION_LOSS` outside ±2^53 |
| `t.bigint({ mode: "string" })` | `string` | Lossless decimal string |
| `t.bigint({ mode: "bigint" })` | `bigint` | Lossless `BigInt` |
| `t.boolean()` | `boolean` | MySQL and SQLite `0` / `1` become `false` / `true` |
| `t.datetime()`, `t.timestamp()`, `t.timestamptz()`, `t.date()` | `Date` | SQLite text is parsed: a zone-less `YYYY-MM-DD HH:MM:SS` is local time, a trailing `Z` means UTC, and a bare `YYYY-MM-DD` is local midnight. `Date` values from pg and mysql2 pass through. Numbers pass through, because epoch units are ambiguous (use a transformer for those). |
| `t.json<T>()`, `t.jsonb<T>()` | `T` | String payloads (MariaDB, SQLite) are parsed, and already-parsed values pass through. A malformed payload logs one warning and comes back as the raw string. |
| `t.array<T>()` | `T[]` | MySQL and SQLite JSON text is parsed. pg arrays pass through. |
| `t.varchar()`, `t.char()`, `t.text()`, `t.longtext()`, `t.uuid()`, `t.enum([...])`, `t.blob()` | `string`, the literal union, or `Buffer` | The driver value, unchanged |
| any builder with `.transformer({ from })` | the builder's type | Your `from` function |
| `new ColumnBuilder<T>({ type: "point" })` for a type registered in `ColumnTypeRegistry` | `T` | The registered `transformer.from` |

SQL `NULL` always reads as `null`, and conversion functions never receive it. `.nullable()` widens the field type to `T | null`.

Apart from the numeric strings in the first row, these are exactly the conversions entity hydration applies. Numeric strings are the one rule `find()` does not apply: an entity column is read the way its driver returns it. A raw query, however, often returns these declared types from expressions such as `COUNT(*)`, `AVG()` or a `NUMERIC` column, which the drivers hand over as strings.

## Column names

By default, a field reads the result column with the same name as its key. Use `.name()` to read a differently named column:

```typescript
const Row = defineRow({
  cachedAt: t.datetime().name("cached_at"), // reads "cached_at" into cachedAt
});
```

The EntityManager's `NamingStrategy` is not applied. A shape describes what a query returns, not a table the ORM names. The columns may be aliases, expressions, or columns of a table with its own conventions, so an implicit rename would make the shape depend on the connection's configuration.

PostgreSQL folds unquoted identifiers to lower case, so `AVG(price) AS avgPrice` comes back as `avgprice`. Either quote the alias (`AS "avgPrice"`) or use `.name("avgprice")`. When this is the cause of a missing column, the error message says so.

## Undeclared and missing columns

Columns the query returns but the shape doesn't declare are copied through unchanged. They are not part of the inferred type. This means `SELECT *` on a wide table works with a shape that names only the columns you use.

If a declared column is missing from the result, `em.query` throws `OrmError` with code `QUERY_ERROR`. The error names the missing columns and lists the ones that did come back:

```
em.query(CachedLocation): the result has no column "cached_at" (field "cachedAt"). Result columns: id, x, y.
```

The check runs against the first row. An empty result simply returns `[]`. Use `defineRow(columns, { name: "CachedLocation" })` to set the label the errors use (the default is `row`).

## What a row shape does not do

- **Write.** `em.query` runs the SQL you write. There is no save or update for a shape.
- **Relations.** Rows are flat, so `defineRow()` rejects relation builders. Select the foreign-key column and declare its type instead. Computed-column builders are rejected too: write the expression in the SQL and declare the type of its result.
- **DDL and write modifiers.** `primary()`, `generated()`, `unique()`, `index()`, `default()`, `length()`, `createTimestamp()`, `version()`, `validate()`, `tenant()` and the like are accepted, so that a field map can be shared with `defineEntity()`. They have no effect on a shape.
- **Tenant scoping.** A shaped query is still raw SQL, like any `em.query`. Under `tenant_column` you write the tenant predicate yourself, and the usual raw-SQL tenant warning applies. On `MultiTenantEntityManager`, `query(shape)` runs on the active tenant's connection.
- **Entity lifecycle.** Shaped queries get no hooks, events, validation, result cache or identity map.

## Cost

- `defineRow()` builds and freezes one object. There is no metadata write, no boot step and no DDL. A shape that is never queried is just that object.
- The first `em.query(shape)` builds the per-column read plan and caches it for that shape. The cache is weak, so the plan is released together with the shape.
- Each row costs one pass over the declared columns, plus a copy of the undeclared ones.

## From a row shape to an entity {#to-entity}

Because shapes and entities use the same builders, you can share one field map between them:

```typescript
const locationFields = {
  id:       t.int(),
  x:        t.double(),
  y:        t.double(),
  cachedAt: t.datetime().name("cached_at"),
};

export const CachedLocationRow = defineRow(locationFields);

// Later, once the table is yours:
export const CachedLocation = defineEntity("cached_location", {
  ...locationFields,
  id: t.int().primary(),
});
```

The builders are the same and so are the read rules, so `find(CachedLocation)` returns the same values the shape did.

## `coerce` and row shapes

`getRawMany({ coerce })` remains the tool for the raw output of a query-builder query that starts from an entity. It now follows the entity rules in the two places where it used to differ:

- A `"date"` string is parsed like an entity temporal column. A bare `YYYY-MM-DD` is now local midnight. Previously it was UTC midnight, which is the previous calendar day anywhere west of UTC.
- `"number"` throws `BIGINT_PRECISION_LOSS` for an integer outside ±2^53 instead of rounding it. Coerce such columns with `"bigint"` or `"string"`.

## API

```typescript
function defineRow<Cols extends Record<string, ColumnBuilder<any>>>(
  columns: Cols,
  options?: { name?: string },
): RowShape<InferRowColumns<Cols>>;

type InferRow<S>;                                   // row type of a shape
function isRowShape(value: unknown): value is RowShape<unknown>;

// EntityManager, MultiTenantEntityManager (and BaseEntityManager typings)
em.query<Row>(shape: RowShape<Row>): (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Row[]>;
em.query<Row>(shape: RowShape<Row>, sql: string | Sql, params?: unknown[]): Promise<Row[]>;
```

## Next Steps

- [Raw SQL & CTE](./raw-sql.md): the tagged `em.query` form, `em.ref()` and `RawQueryBuilder`
- [Defining Entities](./define-entity.md): the `t` builders, and `defineEntity()` for tables the ORM owns
- [Dates & Timezones](./timezone.md): how temporal values are read and written
