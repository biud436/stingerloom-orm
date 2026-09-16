# Troubleshooting

Common issues and how to fix them.

## Connection Errors

### "Database not connected"

```
OrmError [ORM_NOT_CONNECTED]: Database connection has not been established.
```

**Cause:** You called a query method before `em.register()` finished.

```typescript
// Wrong -- register is async
const em = new EntityManager();
em.register({ ... }); // forgot await
const users = await em.find(User); // throws

// Correct
await em.register({ ... });
const users = await em.find(User);
```

### "Connection refused" or "ECONNREFUSED"

The database server is not running or the host/port is wrong.

```bash
# Check if the database is running
# PostgreSQL
pg_isready -h localhost -p 5432

# MySQL
mysqladmin ping -h localhost -P 3306

# SQLite -- no server needed, check file path
ls ./mydb.sqlite
```

### Invalid configuration errors

Since v0.9.x, `register()` validates options before connecting. If you see `ORM_INVALID_CONFIG`:

```
OrmError [ORM_INVALID_CONFIG]: Invalid database configuration:
  - 'port' must be an integer between 1 and 65535, got "3306".
```

Check that `port` is a number (not a string from `.env`) and all required fields are present.

```typescript
// Wrong
{ port: process.env.DB_PORT } // string "3306"

// Correct
{ port: parseInt(process.env.DB_PORT || "5432", 10) }
```

## Entity & Decorator Errors

### "Entity metadata not found"

```
OrmError [ORM_ENTITY_METADATA_NOT_FOUND]: Entity metadata for "User" does not exist.
```

**Causes:**
1. Missing `@Entity()` decorator on the class
2. Entity class not listed in `entities` array
3. Missing `import "reflect-metadata"` at the top of your entry file
4. Something other than the entity class was passed as the first argument — the message says what (see the table below)

```typescript
// 1. Add @Entity()
@Entity()
class User {
  @PrimaryGeneratedColumn()
  id!: number;
}

// 2. Include in entities array
await em.register({
  entities: [User], // <-- don't forget this
  ...
});

// 3. Import reflect-metadata (once, at the top of your app)
import "reflect-metadata";
```

Every EntityManager method takes the entity **class** first (`em.find(User, …)`). When the first argument is something else, the error names what it received instead of reporting `"undefined"`:

| First line of the message | What happened | Fix |
|---|---|---|
| `find() received an instance of User where the entity class was expected.` | `em.find(new User())`, or `em.save(user)` without the class | Pass the class first: `em.save(User, user)` |
| `Entity metadata for "Plain" does not exist. find() received the class Plain, which is not decorated with @Entity() …` | The class carries no metadata — no `@Entity()`, or its module was never imported so the decorator never ran | Decorate it (or use `defineEntity()`), and import the module before connecting |
| `find() received undefined where an entity class was expected.` | The import resolved to `undefined` — a circular import, or a missing `export` | Break the cycle (import the entity module first) or fix the export |
| `find() received the string "user" where an entity class was expected.` | A table or entity name was passed | Entities are referenced by class, not by name — import the class and pass it |
| `find() received an anonymous function which is not a class.` | A thunk (`() => User`) or an uncalled factory was passed | Pass the class the thunk returns; call the factory (`defineEntity(...)`) and pass its result |
| `Entity "Log" is not registered on connection "primary": its metadata exists, but …` | The class is fine but missing from this connection's `entities` array | Add it to that connection, or use the EntityManager that registered it |

Each message ends with the entity classes registered on the connection (`Registered on connection "primary": User, Post.`) and, when a name is close to one of them, a `Did you mean "User"?` hint. The error class and code are the same in every case (`EntityMetadataNotFoundError`, `ORM_ENTITY_METADATA_NOT_FOUND`), and `getRepository()` / `createQueryBuilder()` reject at the call rather than on the first query.

### Columns silently become "text" / "No design:type metadata" warnings

```
WARN [Column] No design:type metadata for User.name — falling back to "text". ...
```

The decorator style infers column types from TypeScript's `design:type` metadata, which only `tsc` and `ts-node` emit (`emitDecoratorMetadata`). **tsx, esbuild, swc, and Vite do not emit it** — under those tools every un-typed `@Column()` falls back to `"text"`, which breaks numeric and date columns on real databases.

Fixes (any one of these):

1. Define entities with the code-first builder — `defineEntity` needs no decorator metadata at all
2. Give every `@Column` an explicit type: `@Column({ type: "int" })`
3. Build with `tsc` / run with `ts-node` so the metadata exists

A related warning, `Unknown design:type "Object"`, does **not** mean "this property holds an object". `Object` is what tsc emits when it cannot name a single runtime constructor: under `strictNullChecks` every union erases to it (`string | null`, `Date | null`, `number | undefined`), and transpile-only builds (`isolatedModules`, swc, esbuild) emit it for enums and type aliases imported from another module. The column falls back to `"text"`, so a nullable `VARCHAR` quietly becomes `TEXT` and a nullable `int` stops being numeric. Fix it by naming the type: `@Column({ type: "varchar", length: 255, nullable: true })` for a nullable string, and `@Column({ type: "json" })` when the property really does hold an object.

Array properties are not part of this: `@Column() tags!: string[]` infers a `json` column with no warning, because tsc emits `Array` only for array and tuple types. An array property whose `transformer` has a `to()` keeps `"text"` -- that write transformer decides the stored shape -- and says so in its own warning. A read-only `transformer.from` (or the deprecated `transform`) does not: it has no write side, so the column stays `json`.

See [Using with Express](./express.md) for the full non-NestJS setup.

### "Primary key not found"

```
OrmError [ORM_PRIMARY_KEY_NOT_FOUND]: Primary key for entity "User" was not found.
```

Every entity needs at least one primary key column:

```typescript
@Entity()
class User {
  @PrimaryGeneratedColumn() // auto-increment
  id!: number;

  // OR for UUID
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  // OR for manual PK
  @PrimaryColumn()
  code!: string;
}
```

### Columns not saved to database

If a property exists on your class but isn't saved, you probably forgot `@Column()`:

```typescript
@Entity()
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column() // <-- required for every persisted field
  name!: string;

  bio: string; // NOT saved -- no @Column()
}
```

A key the entity does not declare is reported when it reaches a write:
`save()` and the other insert-style methods log
`[WriteInput] Unknown key "bio" in the data passed to save() for entity "User"`
once per entity and key (with a `Did you mean` suggestion when one is close).
Set `unknownWriteKeys: "throw"` on the connection to reject such writes
instead -- see the `"Unknown column"` entry below and *Unknown Keys in Write
Payloads* in the writes guide.

## Query Errors

### N+1 query problem

If you see repeated queries like:

```
SELECT * FROM "post" WHERE "author_id" = 1
SELECT * FROM "post" WHERE "author_id" = 2
SELECT * FROM "post" WHERE "author_id" = 3
```

Enable N+1 detection and use eager loading:

```typescript
// Enable detection
await em.register({
  logging: { nPlusOne: true },
  ...
});

// Fix: load relations upfront
const users = await em.find(User, {
  relations: ["posts"],
});
```

### "Unknown column" in where / orderBy / select / groupBy / criteria / data

```
InvalidQueryError: Unknown column "userNam" in "where" for entity "User". Did you mean "userName"?
```

The key doesn't match any column of that entity. Reads (`find`, `findOne`,
`count`, `sum`, …) and bulk writes (`update`, `delete`) both check this before
building SQL; the error's `suggestion` lists every accepted name. The quoted
clause names the argument: `"criteria"` for `delete` / `softDelete` /
`restore`, `"where"` for reads and `updateMany`, `"data"` for the SET payload
of `updateMany` and for the payload of `save` / `saveMany` / `insertMany` /
`insertManyAndReturn` / `upsert` / `insertIgnore` / `batchUpsert` under
`unknownWriteKeys: "throw"` (the default `"warn"` logs the same key once
instead of throwing). `AND` / `OR` / `NOT` are walked into, never reported as
columns; a combinator in `updateMany`'s `data` fails with its own message
(`Logical combinator "OR" is not allowed in the update data`) -- it belongs
in `where`.

Accepted keys on reads and in `updateMany` are the property name, the DB
column name, `@ManyToOne` / `@OneToOne` FK shadow properties, `@ComputedColumn`
names, and — in a single-table inheritance hierarchy — the discriminator and
the columns of the sibling classes that share the table. Insert-style write
payloads additionally accept relation properties but **not** DB column names:
the INSERT reads property keys only, so `save(Team, { team_name })` is
reported with `Did you mean "teamName"?`.

```typescript
// If your entity has:
@Column({ name: "user_name" })
name!: string;

await em.find(User, { where: { name: "Alice" } });      // property name (recommended)
await em.find(User, { where: { user_name: "Alice" } }); // DB column name, also accepted
await em.find(User, { where: { userName: "Alice" } });  // neither — throws
```

A relation property is not a column: filter by its FK instead
(`where: { authorId: 1 }`), or use `SelectQueryBuilder.whereHas()` for a
condition on the related row.

### "... column but received an array / an object"

```
InvalidQueryError: Post.tags is a "text" column but save() received an array, which cannot be bound as one value:
better-sqlite3 would spread it over 2 values and shift every value after it.
```

No driver binds a JS array or a plain object as a single parameter, and each one goes wrong differently: better-sqlite3 spreads an array over the positional placeholders and reads a plain object as a named-parameter bag that fills none, mysql2 expands an array into a value list and renders an object as `'[object Object]'`, and `pg` sends an array literal or JSON text. When the counts happen to line up, the row is written with every value one column to the left and nothing reports it, so the ORM checks the value instead, right before it is bound. The message names the entity property, the column type it was declared as, the operation that produced the value, and what the driver in use would have done.

The same check runs on `save`, `saveMany`, `insertMany`, `insertManyAndReturn`, `upsert`, `insertIgnore`, `batchUpsert`, `createInsertBuilder()`, `update`, `updateMany` and `createUpdateBuilder().set()`. It looks at the value **after** the column's write transforms, so a `transformer.to` that returns a string keeps working, and a `json` column that serializes itself never reaches it.

Fixes:

1. Declare the column as `json` — `@Column({ type: "json" }) tags!: string[]`. An array property with no `type` infers `json` on its own; the error means something else was declared.
2. On PostgreSQL, `@Column({ type: "array" })` for a native array column.
3. Give the column a `transformer` whose `to()` returns a string or a number, for a stored shape of your own (`["a", "b"]` -> `"a,b"`).
4. For a foreign key, pass the key value rather than the related object: `updateMany(Post, { authorId: 7 }, …)`.

Raw queries go straight to the driver and are not column-aware, so they keep whatever the driver supports — with one SQLite exception. `em.query("SELECT ?, ?", [[1, 2]])` on SQLite now throws `SQLite cannot bind an array as one parameter`, because better-sqlite3 would have spread that array across both placeholders. Named-parameter bags (`em.query("SELECT :a", [{ a: 1 }])`) are untouched, and MySQL's `IN (?)` / `VALUES ?` idioms keep working on MySQL.

### WHERE clause with falsy values

`0`, `false`, and `""` are valid values. They work correctly in where clauses:

```typescript
await em.find(User, { where: { age: 0 } });        // finds users with age = 0
await em.find(User, { where: { active: false } });  // finds inactive users
```

`undefined` is the one exception, and it is not a falsy value in this sense — it means "this key is not set", so the field is dropped from the query. `null` is a value and becomes `IS NULL`.

```typescript
await em.find(User, { where: { age: undefined } });  // no filter: every user
await em.find(User, { where: { age: null } });       // WHERE "age" IS NULL
```

### "Every value in the where ... is undefined"

```
InvalidQueryError: Every value in the "where" passed to findOne() for entity
"User" is undefined (id) — the query would read an arbitrary row.
```

A single-row read (`findOne`, `findOneBy`, `findOneOrFail`, `findOneByOrFail`) or `exists()` received a `where` that names fields but defines none. Every condition was dropped, so the query would have run without a filter and returned the first row the database happened to hand back. The usual cause is an optional value that never got validated:

```typescript
const id = req.query.id as string | undefined;   // "?id=" missing -> undefined
await em.findOne(User, { where: { id } });
```

Fix it at the source — validate or narrow the value — rather than by removing the field:

```typescript
if (id === undefined) throw new BadRequestException("id is required");
await em.findOne(User, { where: { id } });
```

If you really do want "any row", say so: `findOne(User, {})` or `findOne(User, { where: {} })` read without a filter and are accepted. Note that this check only fires when *every* named field is undefined; a where that mixes defined and undefined fields still drops the undefined ones, which is why an authorization lookup should validate its inputs. See [undefined values](./entity-manager-querying.md#undefined-values).

The primary-key lookups reject a missing key before they build a `where`, so they report it in their own words:

```
InvalidQueryError: findByPK() received undefined as the primary key of "User".
InvalidQueryError: findByPK() received no value for primary key column "userId" of "Member".
InvalidQueryError: findByPKs() received undefined at index 1 as a primary key of "User".
```

The cause and the fix are the same — validate the value before the call. For a composite key, pass every key property; either the property name or the column name works, and `null` is a value there and matches `IS NULL`.

### "Operator ... received undefined" / "The OR branch ... resolves to no condition"

```
InvalidQueryError: Operator "gt" on "score" received undefined.
InvalidQueryError: The OR branch OR[0] resolves to no condition, so the OR
would match every row.
```

An operator operand is an explicit comparison, so an `undefined` there used to become `= NULL` (matching nothing), a raw `TypeError` (`in`, `between`, `contains`), or — for `isNull: undefined` — an inverted `IS NOT NULL` that matched every non-null row. Build the operator conditionally instead:

```typescript
await em.find(Post, {
  where: { score: { ...(min !== undefined && { gte: min }) } },
});
```

The second message means an `OR` branch, or an element of the array form, ended up with no condition — an empty object, or a branch whose values are all undefined. An empty branch is TRUE, so OR-ing it would return every row. Drop the branch, or give it at least one defined value.

## Relation Errors

### Relation data not loading

Relations are lazy by default. You must request them explicitly:

```typescript
// This does NOT load posts
const user = await em.findOne(User, { where: { id: 1 } });
console.log(user.posts); // undefined

// This loads posts
const user = await em.findOne(User, {
  where: { id: 1 },
  relations: ["posts"],
});
console.log(user.posts); // Post[]
```

Or mark the relation as eager:

```typescript
@OneToMany(() => Post, (post) => post.author, { eager: true })
posts!: Post[];
```

### Relation comes back `[]` (or `null`) under `select`

```typescript
const users = await em.find(User, { select: ["name"], relations: ["posts"] });
// users[0].posts → [] on every user, even though each of them has posts
```

OneToMany, ManyToMany and inverse-side OneToOne relations are not JOINed: a second query matches related rows to each parent by the parent's primary key. Earlier releases sent the caller's `select` as written, so a `select` that left the key out hydrated parents without it, every loader skipped its query, and each parent got `[]` (or `null` for a OneToOne) with no error.

The primary key is now fetched for you and stays on the returned objects, so the query above loads the posts. On an earlier release, name the key yourself:

```typescript
const users = await em.find(User, { select: ["id", "name"], relations: ["posts"] });
```

See [select with relations](./entity-manager-querying.md#select-with-relations).

### "Cannot load ..." with distinct or groupBy

```
InvalidQueryError: Cannot load "posts" for entity "User" in a "distinct" read whose "select"
omits primary key column "id". "posts" is matched to each row by that key, and adding the key
to the SELECT list would change which rows DISTINCT removes.
```

A read that collapses rows cannot carry the primary key described above: under `distinct: true` adding the key would change which rows survive, and a `groupBy` that doesn't list every key column leaves each group without a single parent to match related rows to — the grouped row carries the key of one arbitrary member, so that member's rows would be attached to the whole group. Such a query is rejected instead of returning different rows without saying so. Either:

- add the primary key to `select` (for `distinct`) or to `groupBy`,
- drop `distinct` / `groupBy` from this query, or
- load the relation with a separate `find()`.

The `groupBy` rejection looks at the grouping only. Naming the key in `select` does not lift it, because a grouped row still stands for several parents:

```typescript
// Rejected — "name" groups several users under one arbitrary id
await em.find(User, { select: ["id", "name"], groupBy: ["name"], relations: ["posts"] });
```

### "Unknown relation ... in relations"

```
InvalidQueryError: Unknown relation "autor" in "relations" for entity "Post".
Available relations: [author (ManyToOne), tags (ManyToMany)]. Did you mean "author"?
```

The name must match a relation property declared with `@ManyToOne`,
`@OneToMany`, `@ManyToMany` or `@OneToOne` on that entity — the same name the
loaders match on (the property name, not the FK column).

Nested paths are reported separately because they were never supported:

```typescript
// Not supported — throws
await em.find(Post, { relations: ["author.profile"] });

// Load the root relation, then fetch the nested one
const posts = await em.find(Post, { relations: ["author"] });
const profiles = await em.find(Profile, {
  where: { authorId: In(posts.map((p) => p.author.id)) },
});
```

A relation whose target thunk yields nothing is reported too
(`... target thunk returned no entity class`) — that is almost always a
circular import between entity modules. Keep the target behind the decorator's
`() => Entity` thunk and type single-valued properties as `Relation<Target>`.

### Circular relation errors

When two entities reference each other, use lazy function references:

```typescript
// Use () => Entity to avoid circular import issues
@ManyToOne(() => Author)
author!: Author;

@OneToMany(() => Post, (post) => post.author)
posts!: Post[];
```

## SQLite-Specific Issues

### Features not supported in SQLite

SQLite does not support:
- `ALTER COLUMN` (type changes, rename)
- `DROP COLUMN` (before SQLite 3.35.0)
- `ENUM` types (use `varchar` instead)
- Schema namespaces
- Multiple concurrent write transactions

Use `synchronize: "safe"` to avoid destructive operations:

```typescript
await em.register({
  type: "sqlite",
  database: "./mydb.sqlite",
  synchronize: "safe", // only creates tables and adds columns
  entities: [User],
});
```

## Migration Errors

### "Migration table already exists"

This is normal. The ORM creates `__migrations` table to track applied migrations. If you see an error about it already existing, it's likely a race condition from multiple processes. Run migrations from a single process.

### Generated migration has TODOs

If `migrate:generate` produces incomplete SQL with TODO comments, it means the schema diff couldn't determine the exact DDL. Edit the generated file manually before running.

```bash
# Generate
npx stingerloom migrate:generate -n AddUserEmail

# Review and edit the generated file, then run
npx stingerloom migrate:run
```

## Synchronize Modes

| Mode | Creates tables | Adds columns | Alters columns | Drops columns |
|------|:-:|:-:|:-:|:-:|
| `true` | Yes | Yes | Yes | Yes |
| `"safe"` | Yes | Yes | No | No |
| `"dry-run"` | Log only | Log only | Log only | Log only |
| `false` | No | No | No | No |

**Recommendation:** Use `synchronize: true` only in development. Use migrations in production.

## Debugging Tips

### Enable SQL logging

```typescript
await em.register({
  logging: {
    queries: true,       // log all SQL queries
    slowQueryMs: 1000,   // warn for queries over 1s
    nPlusOne: true,      // detect N+1 patterns
  },
  ...
});
```

### Use EXPLAIN to analyze queries

```typescript
const plan = await em.explain(User, {
  where: { status: "active" },
  relations: ["posts"],
});
console.log(plan);
```

### Check entity metadata

```typescript
import { ENTITY_TOKEN } from "@stingerloom/orm";

const meta = Reflect.getMetadata(ENTITY_TOKEN, User);
console.log(meta); // { name, columns, relations, ... }
```
