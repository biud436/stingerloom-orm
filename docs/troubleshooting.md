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

A related warning, `Unknown design:type "Object"`, means the property's TypeScript type erases to `Object` at runtime (union or optional types like `string | null`) — specify an explicit column type there too.

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

### WHERE clause with falsy values

`0`, `false`, and `""` are valid values. They work correctly in where clauses:

```typescript
await em.find(User, { where: { age: 0 } });        // finds users with age = 0
await em.find(User, { where: { active: false } });  // finds inactive users
```

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
