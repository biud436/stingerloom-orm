# Database Introspection

## Why Introspection Exists

You join a new team. The project has a database with 47 tables, hundreds of columns, foreign keys linking everything together. The previous developer did not use an ORM — all the SQL is hand-written. Your job is to migrate the project to Stingerloom ORM.

Without introspection, you would open pgAdmin or DBeaver, look at each table definition, and manually write 47 entity files. For each column, you would check the type, nullability, length, and default. For each foreign key, you would figure out the relation and add a `@ManyToOne` decorator. This would take hours, and you would almost certainly make mistakes.

With introspection, you point the generator at your database and it produces all 47 entity files automatically — in either of the ORM's two entity notations (decorators or the decorator-free `defineEntity` builder; see [Choosing the Output Style](#choosing-the-output-style)). Foreign keys become `@ManyToOne` + `@RelationColumn`, with their `ON DELETE` / `ON UPDATE` actions. Unique constraints become `@UniqueIndex`. `created_at` / `updated_at` / `deleted_at` columns are recognized and emitted as `@CreateTimestamp` / `@UpdateTimestamp` / `@DeletedAt`. Snake_case column names are preserved via explicit `name:` options so the generated entity is **round-trip stable** — applying it back to a fresh database creates the same schema.

Where an entity *cannot* say what the table says — a type with no ORM counterpart, a composite foreign key, a partial index — the generated file tells you so in a `// NOTE:` comment on the spot, instead of quietly producing something different.

Introspection is the reverse of schema synchronization. Where `synchronize: true` reads your entities and creates tables, introspection reads your tables and creates entities.

---

## How It Works

Every database describes itself differently. PostgreSQL spells a type `character varying(80)` and a default `'active'::character varying`; MySQL prints the same default as a bare `active`, MariaDB as `'active'`; SQLite keeps whatever the `CREATE TABLE` said. Code that turns these descriptions straight into TypeScript has to know every spelling at every step — and a spelling one step forgets becomes a subtly wrong entity.

So introspection runs like a small compiler, with a dialect-neutral **schema IR** in the middle:

```
                      read                        lower                        emit
 PostgreSQL catalog ─┐                ┌──────────────────────────┐
 MySQL catalog  ─────┼──▶  Schema IR ─┤ names, relations, indexes ├─▶ EntityModel ─┬─▶ @Entity classes
 SQLite catalog ─────┘   (by meaning) │ ORM type per column       │               └─▶ defineEntity(...)
                                      └────────────┬─────────────┘
                                                   │ verify
                               the ORM's own DDL for that type, parsed back
                               by the same dialect reader, compared with the IR
```

1. **Read.** A catalog reader per dialect turns the database's description of each table into the IR: columns with a *canonical type* (by meaning — MySQL `TIMESTAMP` and PostgreSQL `timestamptz` are both an instant, MySQL `DATETIME` and PostgreSQL `timestamp` both a wall-clock time), parsed defaults, identity, primary key, foreign keys (composite ones kept whole, with their referential actions) and indexes (with anything they have beyond plain columns). Every dialect quirk is resolved here and nowhere else.
2. **Lower.** Each table becomes an `EntityModel`: class and property names that are valid, non-colliding identifiers; a relation per single-column foreign key; indexes; timestamp markers. The ORM column type is **not** looked up in a hand-kept reverse table. Candidate ORM types are rendered through the dialect's real column definition builder — the code `synchronize` creates tables with — and the rendered DDL is parsed back by the same reader. The first candidate that recreates the column's type is chosen, and whatever it cannot recreate is recorded.
3. **Emit.** The model is spelled out as decorated classes or `defineEntity` builders. Both emitters print every option the model sets, so the two notations always declare the same schema.

Because the mapping is checked against the DDL the ORM actually produces, it cannot drift from it: if the ORM changes how it declares a type, the choice and its notes follow.

---

## Three Ways to Use It

### 1. CLI — `npx stingerloom introspect`

The simplest path. The CLI reuses your `stingerloom.config.ts` (or `ormconfig.ts`) database options:

```bash
# Generate entities into ./entities/ using the auto-detected config
npx stingerloom introspect

# Specify output directory, schema, and exclusions
npx stingerloom introspect \
  --output ./src/entities \
  --schema reporting \
  --exclude __migrations,sessions

# Whitelist a subset of tables
npx stingerloom introspect --include users,posts,comments

# Preview without writing files
npx stingerloom introspect --dry-run

# Emit decorator-free `defineEntity` entities instead of decorated classes
npx stingerloom introspect --style code-first
```

| Flag | Description |
|------|-------------|
| `--output <dir>` | Where to write generated entities. Default: `./entities` |
| `--schema <name>` | PostgreSQL schema. Default: `public` |
| `--include <list>` | Comma-separated whitelist of tables to generate |
| `--exclude <list>` | Comma-separated blacklist of tables to skip |
| `--import-path <p>` | Import path for the ORM package. Default: `@stingerloom/orm` |
| `--style <style>` | Entity notation to emit: `decorator` (default) or `code-first` |
| `--dry-run` | Report what would be generated without writing files |
| `--config <path>` | Explicit config file path (default: auto-detect) |

When any generated file carries a `// NOTE:`, the CLI logs how many and in which files, so they are not missed in a large schema.

### 2. `runIntrospect()` — Programmatic helper

For scripts that want full control. `runIntrospect` connects via `DatabaseClient`, runs the generator, and writes files in one call:

```typescript
import { runIntrospect } from "@stingerloom/orm";

const result = await runIntrospect(
  {
    type: "mysql",
    host: "localhost",
    port: 3306,
    username: "root",
    password: process.env.DB_PASSWORD,
    database: "blog",
  },
  {
    outputDir: "./src/entities",
    excludeTables: ["__migrations", "session_db"],
    codeBuilderOptions: { importPath: "@stingerloom/orm" },
  },
);

console.log(`Wrote ${result.writtenFiles.length} entity files`);
for (const e of result.entities) {
  console.log(`  - ${e.fileName}  (${e.tableName} → ${e.className})`);
  for (const note of e.notes) console.log(`      NOTE ${note}`);
}
```

`IntrospectionCliOptions`:

| Option | Type | Default |
|--------|------|---------|
| `outputDir` | `string` | `./entities` |
| `schema` | `string` | `"public"` (PostgreSQL only) |
| `includeTables` | `string[]` | — |
| `excludeTables` | `string[]` | — |
| `codeBuilderOptions` | `EntityCodeBuilderOptions` | — |
| `dryRun` | `boolean` | `false` — when true, returns entities without writing |

### 3. `IntrospectionGenerator` — Low-level building blocks

For advanced cases like driving the generator with a custom query function, or reading the schema without generating code:

```typescript
import { IntrospectionGenerator } from "@stingerloom/orm/introspection";

const generator = new IntrospectionGenerator(
  (q) => driver.query(q),         // Accepts strings or `sql` template tags
  "postgres",                      // "postgres" | "mysql" | "sqlite"
  { schema: "public", excludeTables: ["__migrations"] },
);

const entities = await generator.generate();

// The schema IR on its own — a structural, dialect-neutral description:
const schema = await generator.readSchema();   // the selected tables
const users = await generator.readTable("users");
users.columns[0];
// { name: "id", type: { kind: "integer", bytes: 4, unsigned: false },
//   nullable: false, identity: true, nativeType: "integer", ... }
```

---

## What the Generated Code Looks Like

Given this MariaDB schema:

```sql
CREATE TABLE user (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(255) NOT NULL,
  access_key VARCHAR(191) NOT NULL,
  is_valid TINYINT(1) DEFAULT 1,
  login_count INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  profile_id INT,
  CONSTRAINT fk_user_profile FOREIGN KEY (profile_id) REFERENCES profile(id) ON DELETE SET NULL,
  UNIQUE KEY uq_user_username (username)
);
```

Introspection produces:

```typescript
import { Column, CreateTimestamp, Entity, ManyToOne, PrimaryGeneratedColumn, RelationColumn, UniqueIndex, UpdateTimestamp, type Relation } from "@stingerloom/orm";
import { Profile } from "./profile.entity.js";

@Entity({ name: "user" })
@UniqueIndex(["username"], "uq_user_username")
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  username!: string;

  @Column({ type: "varchar", name: "access_key", length: 191 })
  accessKey!: string;

  @Column({ type: "boolean", name: "is_valid", nullable: true, default: true })
  isValid!: boolean | null;

  // NOTE: The database declares "int(10) unsigned", but this entity creates "INT" — synchronizing it would change the column.
  @Column({ type: "int", name: "login_count", default: 0 })
  loginCount!: number;

  @CreateTimestamp({ name: "created_at" })
  createdAt!: Date;

  // NOTE: DEFAULT current_timestamp() is not declared: as an update timestamp the column is filled in by the ORM instead.
  // NOTE: ON UPDATE CURRENT_TIMESTAMP is not declared: as an update timestamp the column is set by the ORM on every save instead.
  @UpdateTimestamp({ name: "updated_at" })
  updatedAt!: Date;

  @ManyToOne(() => Profile, (entity: any) => entity.profile, { onDelete: "SET NULL" })
  @RelationColumn({ name: "profile_id", type: "int", nullable: true, referencedColumn: "id" })
  profile!: Relation<Profile>;
}
```

Things to notice:

- **`name:` options preserve the DB column name** (`access_key`, `is_valid`) so the generated entity round-trips under the default identity NamingStrategy. Without this, applying the entity would create an `accessKey` column instead of `access_key`.
- **TINYINT(1) is recognized as `boolean`**; other TINYINT widths are small integers.
- **`INT UNSIGNED` is flagged.** The ORM has no unsigned integer type, so the entity would create a signed `INT` — the note says exactly that, with both spellings.
- **`created_at` / `updated_at` are emitted as timestamp decorators**, and the database default and `ON UPDATE` those decorators take over from are named in notes rather than dropped silently.
- **The FK column `profile_id` is not a `@Column`** — it's expressed via `@ManyToOne` + `@RelationColumn`, which carries the FK column's own name, type and nullability, and the constraint's `ON DELETE SET NULL`.
- **The unique index is hoisted to a class-level `@UniqueIndex`** with the original index name preserved. The index InnoDB created for the foreign key by itself is not declared — the ORM's foreign key creates it again.

---

## Choosing the Output Style

This ORM has two equivalent ways to declare an entity, and introspection can emit either one. Both go through the same metadata bridge, so the generated schema is identical — only the notation differs.

```bash
npx stingerloom introspect --style decorator    # default
npx stingerloom introspect --style code-first
```

```typescript
await runIntrospect(dbOptions, {
  outputDir: "./src/entities",
  codeBuilderOptions: { style: "code-first" },
});
```

The same `posts` table in both styles:

```typescript
// --style decorator
import { Column, Entity, ManyToOne, PrimaryGeneratedColumn, RelationColumn, type Relation } from "@stingerloom/orm";
import { User } from "./user.entity.js";

@Entity({ name: "posts" })
export class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 200 })
  title!: string;

  @ManyToOne(() => User, (entity: any) => entity.author, { onDelete: "CASCADE" })
  @RelationColumn({ name: "author_id", type: "int", nullable: false, referencedColumn: "id" })
  author!: Relation<User>;
}
```

```typescript
// --style code-first
import { defineEntity, t, type InferEntity, type AnyEntityClass } from "@stingerloom/orm";
import { User } from "./user.entity.js";

export const Post = defineEntity(
  "posts",
  {
    id: t.int().primary().generated(),
    title: t.varchar(200),
    author: t.manyToOne<User>((): AnyEntityClass => User, {
      relationColumn: { name: "author_id", type: "int", nullable: false, referencedColumn: "id" },
      onDelete: "CASCADE",
    }),
  },
);

export interface Post extends InferEntity<typeof Post> {}
```

Pick `code-first` when you do not want `experimentalDecorators` / `emitDecoratorMetadata` in your build, or when you would rather have the row type inferred (`InferEntity`) than written out. Pick `decorator` when the rest of your codebase is decorator-based.

Two details in the code-first output are load-bearing:

- The relation target thunk is annotated (`(): AnyEntityClass => User`). Without the annotation, two entities that reference each other cannot both have their types inferred (TS7022).
- The row type is declared by interface merging (`export interface Post extends InferEntity<typeof Post> {}`), not a `type` alias — interfaces resolve their members lazily, which is what keeps a self-referencing table (a `parent_id` FK) from becoming a circular type. On that one form the shape parameter is also omitted: `t.manyToOne((): AnyEntityClass => Department, …)`.

One thing only the decorator style can say: a `NOT NULL` binary column. `t.blob()` columns are always created nullable, so the code-first output flags such a column with a note.

---

## Round-Trip Stability

The introspection output is deterministic. Given a stable database schema, running introspect twice produces bit-identical files. Applying the output as a schema and re-introspecting produces the same files again.

This is verified, not assumed:

- **Every ORM column type, on every dialect.** A unit test renders each column type the ORM can create through the dialect's column definition builder, reads the DDL back, and requires the type selection to land on a type that recreates it exactly.
- **Both emitters, against the ORM's metadata.** A unit test type checks and loads the generated files of both styles and compares every column's declared type, nullability, key, generation, default, relation column, referential action and index with what the model chose — so an option one notation spells wrong (or the ORM infers from `design:type`) cannot slip through.
- **Real databases.** Integration tests create a schema with plain DDL on SQLite, PostgreSQL, MySQL and MariaDB, generate entities in both styles, recreate the tables from them with `synchronize`, and require the recreated schema to read back identically — and the files generated from it to be byte-identical to the first ones.

The mechanisms this rests on:

| Mechanism | Why |
|-----------|-----|
| Explicit `name:` whenever the DB column name ≠ property name | Prevents identity NamingStrategy from creating camelCase columns on re-apply |
| Every type-relevant option is written out (`type`, `length`, `precision` / `scale`, `enumValues`, `enumName`, `arrayElementType`), on primary keys too | Decorator metadata depends on compiler settings (`string \| null` is `Object` under `strictNullChecks`); an inferred option would make the column depend on them |
| `nullable: false` is written for `any` / `Buffer` properties | `@Column` defaults those `design:type`s to nullable |
| FK relations sorted by their column's position | Catalog order isn't stable across engines |
| Class-level indexes name plain columns by property and join columns by DB column | Both resolve to the right column in every index declaration path |
| Defaults are parsed per dialect into values or expressions | MySQL prints a literal bare (`active`), MariaDB quoted (`'active'`), PostgreSQL with a cast (`'active'::character varying`); MySQL's `CURRENT_TIMESTAMP` / `now()` / `current_timestamp()` are one function |
| Expressions are stored without their outer parentheses | Catalogs disagree on keeping them; the ORM adds exactly one pair back |
| A primary key is never emitted as nullable | SQLite reports `notnull = 0` for an `INTEGER PRIMARY KEY` rowid alias |
| Class names avoid globals and imported names (`errors` → `ErrorEntity`), and two tables never share a class or file | `design:type` metadata refers to `Error`, `Date`, …; `user` and `users` would overwrite each other |

This guarantees that you can introspect a legacy database, commit the entities, and have CI/CD reapply them to a staging database with identical results.

### What the echo does not preserve

Some things genuinely cannot survive the trip. None of them is dropped silently: the generator writes a `// NOTE:` comment above the affected field (or the entity), and returns the same text in `GeneratedEntity.notes`.

| Case | What happens |
|------|--------------|
| A type the ORM cannot create (`smallint`, `int unsigned`, PostgreSQL `double precision`, `timestamp(3)`, `mediumtext`, `inet`, `interval`, …) | The closest ORM type is used and the note gives both spellings — what the database declares and what the entity would create. Types with no counterpart at all become `text`, which holds any value's text form. See [Type Mapping](#type-mapping) |
| SQLite declarations whose affinity the ORM changes (`DATETIME`, `DATE`, `JSON`, `DECIMAL`) | Flagged. The ORM declares `TEXT` / `REAL`, whose affinity stores some values differently (`'123'` stays text under TEXT but becomes an integer under the NUMERIC affinity of `DATETIME`). `BOOLEAN` → `INTEGER` keeps the affinity and is not flagged |
| A composite foreign key | Its columns stay plain columns; the note names the constraint to recreate in a migration |
| A foreign key to a table that is not generated (excluded, or in another schema) | Kept as a plain column instead of a relation that would import a class that does not exist |
| A foreign key that references a non-primary-key column | Flagged. Schema generation always builds the constraint against the target's primary key |
| A partial, expression, full-text, prefix-length, descending, `INCLUDE` or non-btree index | Not declared — recreating it without that part would build a different index (a broader unique one, even). The note gives its definition |
| A generated (computed) column | Emitted as a plain column and flagged |
| A default or `ON UPDATE` that a timestamp decorator replaces | Flagged; the ORM fills the column in instead |
| An identity column that is not a single integer primary key | Flagged |
| A table without a primary key | Flagged |
| Column order | A relation's join column is created after the table's other columns |
| Constraint and index names of foreign keys and single-column property indexes | Regenerated by the ORM's naming strategy |
| `@OneToMany`, `@OneToOne` | Not derivable from one-sided FK introspection — see [Known Limitations](#known-limitations) |

---

## Type Mapping

The tables below are what the type selection produces — rendered through each dialect's column definition builder, not written by hand. *Created as* is the DDL the generated entity declares; **exact** means it recreates the database type, **equivalent** that it differs only in spelling the database treats identically, and **flagged** that the file carries a note.

### PostgreSQL

| Database type | ORM `ColumnType` | Created as | |
|---------------|------------------|------------|---|
| `integer`, `serial` | `int` | `INTEGER` | exact |
| `bigint`, `bigserial` | `bigint` | `BIGINT` | exact |
| `smallint` | `int` | `INTEGER` | flagged |
| `real` | `float` | `REAL` | exact |
| `double precision` | `float` | `REAL` | flagged |
| `numeric(p,s)` | `double` + `precision` / `scale` | `NUMERIC(p, s)` | exact |
| `numeric` (unconstrained) | `double` | `NUMERIC(10, 2)` | flagged |
| `boolean` | `boolean` | `BOOLEAN` | exact |
| `character varying(n)` | `varchar` + `length` | `VARCHAR(n)` | exact |
| `character varying` (no limit) | `text` | `TEXT` | equivalent |
| `character(n)` | `char` + `length` | `CHAR(n)` | exact |
| `text` | `text` | `TEXT` | exact |
| `uuid` | `uuid` | `UUID` | exact |
| `bytea` | `blob` | `BYTEA` | exact |
| `json` / `jsonb` | `json` / `jsonb` | `JSON` / `JSONB` | exact |
| `date` | `date` | `DATE` | exact |
| `timestamp` | `datetime` | `TIMESTAMP` | exact |
| `timestamptz` | `timestamptz` | `TIMESTAMPTZ` | exact |
| `timestamp(3)` and other non-default precisions | `datetime` / `timestamptz` | `TIMESTAMP` / `TIMESTAMPTZ` | flagged |
| an enum type | `enum` + `enumValues` + `enumName` | the same named type | exact |
| `integer[]`, `character varying(20)[]`, … | `array` + `arrayElementType` (+ `length`) | `INTEGER[]`, `VARCHAR(20)[]` | exact |
| `time`, `interval`, `inet`, `money`, domains, … | `text` | `TEXT` | flagged |

Identity columns (`GENERATED … AS IDENTITY`) and `serial` columns are read as database-generated and emitted as `@PrimaryGeneratedColumn` — with `type: "bigint"` for a 64-bit key, which the ORM creates as `BIGSERIAL`.

### MySQL / MariaDB

| Database type | ORM `ColumnType` | Created as | |
|---------------|------------------|------------|---|
| `int` | `int` | `INT` | exact |
| `bigint` | `bigint` | `BIGINT` | exact |
| `tinyint(1)` | `boolean` | `TINYINT(1)` | exact |
| `tinyint`, `smallint`, `mediumint` | `int` | `INT` | flagged |
| `… unsigned` | `int` / `bigint` | `INT` / `BIGINT` | flagged |
| `float` | `float` | `FLOAT` | exact |
| `double` | `float` | `FLOAT` | flagged |
| `decimal(p,s)` | `double` + `precision` / `scale` | `DECIMAL(p, s)` | exact |
| `varchar(n)` / `char(n)` | `varchar` / `char` + `length` | `VARCHAR(n)` / `CHAR(n)` | exact |
| `text` / `longtext` | `text` / `longtext` | `TEXT` / `LONGTEXT` | exact |
| `tinytext` / `mediumtext` | `text` / `longtext` | `TEXT` / `LONGTEXT` | flagged |
| `blob` | `blob` | `BLOB` | exact |
| `tinyblob`, `mediumblob`, `longblob`, `binary(n)`, `varbinary(n)` | `blob` | `BLOB` | flagged |
| `json` (MariaDB: `longtext` with a `json_valid()` check) | `json` | `JSON` | exact |
| `uuid` (MariaDB 10.7+) | `uuid` | `UUID` on MariaDB 10.7+, else `CHAR(36)` | exact / flagged |
| `date` | `date` | `DATE` | exact |
| `datetime` | `datetime` | `DATETIME` | exact |
| `timestamp` | `timestamp` | `TIMESTAMP` | exact |
| `datetime(n)`, `timestamp(n)` | `datetime` / `timestamp` | `DATETIME` / `TIMESTAMP` | flagged |
| `enum('a','b',…)` | `enum` + `enumValues` | `ENUM('a','b',…)` | exact |
| `time`, `year`, `set(…)`, `bit(n)`, spatial types | `text` | `TEXT` | flagged |

The reader asks the server for its version, so MariaDB's quoted defaults, its `JSON` alias and its native `UUID` are read as MariaDB means them.

### SQLite

| Declared type | ORM `ColumnType` | Created as | |
|---------------|------------------|------------|---|
| `INTEGER`, `INT` | `int` | `INTEGER` | exact |
| `BIGINT` | `bigint` | `BIGINT` | exact |
| `TINYINT`, `SMALLINT`, `BOOLEAN` | `int` / `boolean` | `INTEGER` | equivalent |
| `REAL`, `DOUBLE`, `FLOAT` | `float` | `REAL` | exact |
| `VARCHAR(n)`, `TEXT(n)` | `varchar` + `length` | `TEXT(n)` | exact |
| `CHAR(n)` | `char` + `length` | `TEXT(n)` | equivalent |
| `TEXT`, `CLOB`, `VARCHAR` | `text` | `TEXT` | exact / equivalent |
| `BLOB` | `blob` | `BLOB` | exact |
| `DECIMAL`, `NUMERIC` | `double` | `REAL` | flagged |
| `DATETIME`, `TIMESTAMP`, `DATE` | `datetime` / `date` | `TEXT` | flagged |
| `JSON`, `UUID` | `json` / `uuid` | `TEXT` / `VARCHAR(36)` | flagged |
| no declared type, unknown names | by SQLite's affinity rules; `text` when none fits | | flagged |

A single-column `INTEGER PRIMARY KEY` (not `INT PRIMARY KEY`, and not in a `WITHOUT ROWID` table) is SQLite's rowid alias and is emitted as `@PrimaryGeneratedColumn`. A database this ORM created reads back exactly, so the loop is stable from the second generation on.

---

## Foreign Key Detection

When the generator discovers a single-column foreign key to a table it is also generating, it:

1. **Skips** the FK column from `@Column` output (replaced by the relation).
2. **Emits** a `@ManyToOne` + `@RelationColumn` pair pointing to the referenced table, with the constraint's `onDelete` / `onUpdate` when they are anything but `NO ACTION`.
3. **Sorts** relations by the FK column's position in the table so the output is deterministic.

```typescript
@ManyToOne(() => User, (entity: any) => entity.author, { onDelete: "CASCADE" })
@RelationColumn({ name: "author_id", type: "int", nullable: false, referencedColumn: "id" })
author!: Relation<User>;
```

`@RelationColumn` spells out the FK column's own `type` and `nullable` instead of leaving them to be inferred from the target's primary key — that inference defaults the column to NULL-able, which would quietly drop a `NOT NULL` from the source schema. The join column takes its length from the referenced primary key; when that would change the column (a `varchar` FK with a length of its own), the relation is flagged.

On MySQL, `RESTRICT` is read as `NO ACTION` — InnoDB checks both immediately, and MariaDB reports `RESTRICT` for a key declared with neither.

The property name is derived from the FK column by:

- Stripping `_id` suffix: `author_id` → `author`
- Stripping `id_` prefix: `id_ancestor` → `ancestor`
- Otherwise camelCasing the column name: `parentRef` → `parentRef`

If that derived name collides with another property (e.g., a `user` text column when an FK column is `user_id`), the generator falls back to the full camelCased FK column name (`userId`), then to a numeric suffix.

A foreign key that is composite, points into another schema, or references a table that is not being generated stays a plain column, with a note (see [What the echo does not preserve](#what-the-echo-does-not-preserve)).

### Self-Referential FKs

When a FK points back to the same table, the generator emits the relation but **does not import the class**:

```typescript
@Entity({ name: "department" })
export class Department {
  @PrimaryGeneratedColumn({ name: "DEPT_SQ" })
  deptSq!: number;

  @ManyToOne(() => Department, (entity: any) => entity.upperDeptSq)
  @RelationColumn({ name: "UPPER_DEPT_SQ", type: "int", nullable: true, referencedColumn: "DEPT_SQ" })
  upperDeptSq!: Relation<Department>;
}
```

### Composite-PK Closure Tables

When FK columns are also part of the primary key (typical for closure tables and join tables with composite PKs), the generator emits **both** a `@PrimaryColumn` declaration **and** the relation:

```typescript
@Entity({ name: "post_comment_closure" })
export class PostCommentClosure {
  @PrimaryColumn({ type: "int", name: "id_ancestor" })
  idAncestor!: number;

  @PrimaryColumn({ type: "int", name: "id_descendant" })
  idDescendant!: number;

  @ManyToOne(() => PostComment, (entity: any) => entity.ancestor)
  @RelationColumn({ name: "id_ancestor", type: "int", nullable: false, referencedColumn: "id" })
  ancestor!: Relation<PostComment>;

  @ManyToOne(() => PostComment, (entity: any) => entity.descendant)
  @RelationColumn({ name: "id_descendant", type: "int", nullable: false, referencedColumn: "id" })
  descendant!: Relation<PostComment>;
}
```

---

## Index Detection

The generator reads every non-PK index — `INFORMATION_SCHEMA.STATISTICS` (MySQL), `pg_index` (PostgreSQL), `PRAGMA index_list` + `PRAGMA index_xinfo` (SQLite) — and classifies it:

| Index Kind | Emitted As |
|------------|------------|
| Single-column non-unique on a plain column | Property-level `@Index()` |
| Single-column UNIQUE | Class-level `@UniqueIndex([col], name)` |
| Multi-column non-unique, or any index on a relation's join column | Class-level `@Index([col1, col2], name)` |
| Multi-column UNIQUE | Class-level `@UniqueIndex([col1, col2], name)` |
| Partial, expression, full-text, prefix, descending, `INCLUDE`, non-btree | Not declared; a note gives its definition |

Indexes that exactly cover the primary key are dropped (already handled by `@PrimaryColumn` / `@PrimaryGeneratedColumn`). On MySQL, a non-unique index that exactly covers a foreign key's columns is dropped too — InnoDB creates one for every foreign key by itself. PostgreSQL and SQLite do not, so there such an index is the schema's own and is kept.

Class-level decorators name a plain column by its **property key** and a relation's join column by its **DB column name**; the ORM resolves both to the column.

---

## Timestamp Decorator Heuristics

Columns matching the standard timestamp names — combined with type and nullability — are emitted as timestamp decorators instead of plain `@Column`:

| Property name | Column type | Nullable | Decorator |
|---------------|-------------|----------|-----------|
| `createdAt` | datetime/timestamp/timestamptz/date | No | `@CreateTimestamp({ name?, type? })` |
| `updatedAt` | datetime/timestamp/timestamptz/date | No | `@UpdateTimestamp({ name?, type? })` |
| `deletedAt` | datetime/timestamp/timestamptz/date | Yes | `@DeletedAt({ name?, type? })` |

The decorator emits `name:` whenever the DB column name differs from the property name, and `type:` whenever the type isn't the default `datetime`. These decorators have no `default` option: when the column has a database default (typically `CURRENT_TIMESTAMP`) or an `ON UPDATE`, the ORM fills the column in itself and the note says which database clause the entity no longer declares. Columns that don't match the heuristic (e.g., `upload_date`, `published_at`) keep their raw `@Column` form with the original default preserved.

---

## Default Value Preservation

Each dialect's reader parses the default into a value or an expression; the lowering writes it as `@Column({ default: … })`, where a string in parentheses is raw SQL and anything else is a value:

| Database default | Emitted |
|------------------|---------|
| `'active'` (SQLite, MariaDB), `active` (MySQL), `'active'::character varying` (PostgreSQL) | `default: "active"` |
| `0`, `-1`, `'-1'::integer` on a numeric column | `default: 0`, `default: -1` |
| `true` / `false`, and `0` / `1` on a boolean column | `default: true` / `default: false` |
| `CURRENT_TIMESTAMP`, `now()`, `gen_random_uuid()`, `(datetime('now'))` | `default: "(CURRENT_TIMESTAMP)"` — one pair of parentheses, however many the catalog kept |
| MySQL `_utf8mb4'[]'` (a literal default on TEXT / BLOB / JSON) | `default: "('[]')"` — MySQL accepts no other form on those types |
| an integer beyond `Number.MAX_SAFE_INTEGER` | a string, so no digit is lost |
| `nextval('seq'::regclass)`, `AUTO_INCREMENT` | omitted — `@PrimaryGeneratedColumn` owns it (flagged anywhere else) |
| `NULL` | omitted — the same as no default |
| a string literal that itself starts with `(` and ends with `)` | not declared, flagged — the ORM would read it as SQL |

---

## Options Reference

### `IntrospectionGeneratorOptions`

| Option | Type | Description |
|--------|------|-------------|
| `schema` | `string` | PostgreSQL schema. Default: `"public"` |
| `includeTables` | `string[]` | Whitelist of tables to generate |
| `excludeTables` | `string[]` | Blacklist of tables to skip |
| `codeBuilderOptions` | `EntityCodeBuilderOptions` | Forwarded to `EntityCodeBuilder` |

### `EntityCodeBuilderOptions`

| Option | Type | Default |
|--------|------|---------|
| `importPath` | `string` | `"@stingerloom/orm"` |
| `style` | `"decorator" \| "code-first"` | `"decorator"` |

---

## API Reference

### `IntrospectionGenerator`

| Method | Signature | Description |
|--------|-----------|-------------|
| `constructor` | `(queryFn, dialect, options?)` | Create with a query function, dialect (`"postgres"` / `"mysql"` / `"sqlite"`), and optional options |
| `generate()` | `(): Promise<GeneratedEntity[]>` | Generate entity files for all matching tables |
| `readSchema()` | `(): Promise<SchemaIR>` | The matching tables as the schema IR |
| `readTable(table)` | `(table: string): Promise<TableIR>` | One table as the schema IR |
| `discoverTables()` | `(): Promise<string[]>` | All user tables (no views), sorted by name |
| `getColumns(table)` | `(table: string): Promise<DbColumn[]>` | **Deprecated** — use `readTable()`. Column rows derived from the IR |
| `getPrimaryKeys(table)` | `(table: string): Promise<string[]>` | **Deprecated** — use `readTable()` (`primaryKey`) |
| `getForeignKeys(table)` | `(table: string): Promise<DbForeignKey[]>` | **Deprecated** — use `readTable()` (`foreignKeys`). One row per column; a composite key's rows share `constraint_name` |
| `getIndexes(table)` | `(table: string): Promise<DbIndex[]>` | **Deprecated** — use `readTable()` (`indexes`) |

`GeneratedEntity` is `{ tableName, className, fileName, code, notes }` — `notes` lists every `// NOTE:` the file carries, a field's prefixed with its property name.

### Schema IR

Exported from `@stingerloom/orm/introspection`:

| Type | Shape |
|------|-------|
| `SchemaIR` | `{ dialect, schema?, tables: TableIR[] }` |
| `TableIR` | `{ name, columns: ColumnIR[], primaryKey: string[], foreignKeys: ForeignKeyIR[], indexes: IndexIR[] }` |
| `ColumnIR` | `{ name, type: CanonicalType, nullable, default?: DefaultValue, identity, generatedExpression?, onUpdate?, nativeType, rawDefault? }` |
| `CanonicalType` | A discriminated union by `kind`: `integer` (`bytes`, `unsigned`), `boolean`, `decimal` (`precision`, `scale`), `float` (`bytes`), `string` (`fixed`, `length`), `text` (`size`), `binary`, `blob`, `uuid`, `json` (`binary`), `date`, `time`, `timestamp` (`zone: "local" \| "instant"`, `precision`), `enum` (`values`, `name`), `array` (`element`), `other` (`native`) |
| `DefaultValue` | `string` / `number` (kept as text) / `boolean` / `null` / `expression` (`sql`) / `sequence` |
| `ForeignKeyIR` | `{ name?, columns, referencedTable, referencedSchema?, referencedColumns, onDelete, onUpdate }` |
| `IndexIR` | `{ name, unique, columns, unsupported: string[] }` — `unsupported` describes what the index has beyond plain columns |

### `runIntrospect(dbOptions, cliOptions?)`

Connects via `DatabaseClient`, runs the generator, writes files to disk (unless `dryRun`). Returns `{ writtenFiles, entities }`.

### `IntrospectionTypeMapper`

The original type tables, kept for callers that used them directly. The generator no longer consults `toColumnType()` or `hasMapping()` (both deprecated) — see [Type Mapping](#type-mapping).

| Method | Signature | Description |
|--------|-----------|-------------|
| `toColumnType(dbType, dialect, columnTypeFull?)` | `(...): ColumnType` | **Deprecated.** Map a DB type through the legacy table |
| `hasMapping(dbType, dialect)` | `(...): boolean` | **Deprecated.** Whether the legacy table has the type |
| `toTsType(columnType)` | `(columnType: ColumnType): string` | ORM `ColumnType` → TypeScript type string |
| `parseSqliteWidth(declaredType)` | `(declaredType: string): number \| null` | Extract `N` from `VARCHAR(N)` etc. |
| `parseSqlitePrecisionScale(declaredType)` | `(declaredType: string): { precision, scale } \| null` | Extract `(P, S)` from `DECIMAL(P, S)` |

### `EntityCodeBuilder`

| Method | Signature | Description |
|--------|-----------|-------------|
| `constructor` | `(options?: EntityCodeBuilderOptions)` | Builder with optional import path and output style |
| `build(table, columns, pks, fks, dialect, indexes?, context?)` | `(...): string` | TypeScript entity source from `DbColumn` rows, through the same pipeline as the generator. `context.primaryKeysByTable` lets the builder flag a FK that points at a non-primary-key column |
| `emit(model)` | `(model: EntityModel): string` | Spell out an already-lowered model in this builder's style |
| `tableNameToClassName(table)` | `(string): string` | snake_case table → PascalCase class |
| `classNameToFileName(className)` | `(string): string` | PascalCase class → kebab-case file name |

### `DbColumn`

The row shape `EntityCodeBuilder.build()` accepts and the deprecated `getColumns()` returns. Each field is read the way the named dialect's catalog means it.

| Property | Type | Description |
|----------|------|-------------|
| `column_name` | `string` | Column name |
| `data_type` | `string` | DB-native type name |
| `is_nullable` | `string` | `"YES"` or `"NO"` |
| `character_maximum_length` | `number \| null` | Max length for char/varchar |
| `numeric_precision` | `number \| null` | Precision for decimal/numeric |
| `numeric_scale` | `number \| null` | Scale for decimal/numeric |
| `column_default` | `string \| null` | Default expression from DB |
| `column_type` | `string \| null` | Full declared type with width (MySQL `COLUMN_TYPE`, e.g. `tinyint(1)`) |
| `is_identity` | `string \| null` | PG `"YES"` for `GENERATED AS IDENTITY` |
| `enum_values` | `string[] \| null` | Enum labels (PG `pg_enum` or MySQL parsed) |
| `udt_name` | `string \| null` | PostgreSQL enum type name, or `_int4` for `integer[]` |
| `extra` | `string \| null` | MySQL `EXTRA` (e.g., `auto_increment`) |

### `DbForeignKey`

| Property | Type | Description |
|----------|------|-------------|
| `column_name` | `string` | FK column in the current table |
| `referenced_table` | `string` | Target table |
| `referenced_column` | `string` | Target column |
| `constraint_name` | `string \| undefined` | FK constraint name; rows sharing it form one composite key |

### `DbIndex`

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Index name (preserved in `@Index`/`@UniqueIndex` emit) |
| `column_names` | `string[]` | Columns in the index, in order |
| `is_unique` | `boolean` | Whether this is a UNIQUE index |

---

## Known Limitations

Introspection extracts what's explicit in the database schema. The following are not derivable from one-sided FK introspection and remain a manual step after generation:

- **`@OneToMany` inverse-side collections** (a `User` having `posts: Post[]`). The generator only sees the `posts.author_id` FK from the owning side; the inverse property has to be added by hand.
- **`@OneToOne` vs `@ManyToOne` distinction.** All FKs are emitted as `@ManyToOne`. If the FK column has a UNIQUE constraint on it, you may want to convert it manually.
- **Friendly property aliases.** A column like `CTGR_GRP_SQ` is camelCased to `ctgrGrpSq`. If you want a friendlier name like `groupId`, rename the property and keep the `name:` option pointing at `CTGR_GRP_SQ`.

Everything the entity cannot express about the table itself is listed in [What the echo does not preserve](#what-the-echo-does-not-preserve) and flagged in the generated file.

The inverse-side accessor in `@ManyToOne(() => Entity, (entity: any) => entity.foo)` is a placeholder using `any` so the code compiles even without the inverse property. Once you add `@OneToMany` collections, rename the placeholder to match.

---

## Next Steps

- [Database Seeding](./seeding.md) — Populate tables with initial data after generation
- [Migrations](./migrations.md) — Version-controlled schema changes
- [Entities & Columns](./entities.md) — Customize the generated entity files
- [Relations](./relations.md) — Add OneToMany, ManyToMany, and other relations
