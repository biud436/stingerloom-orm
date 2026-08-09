# Database Introspection

## Why Introspection Exists

You join a new team. The project has a database with 47 tables, hundreds of columns, foreign keys linking everything together. The previous developer did not use an ORM — all the SQL is hand-written. Your job is to migrate the project to Stingerloom ORM.

Without introspection, you would open pgAdmin or DBeaver, look at each table definition, and manually write 47 entity files. For each column, you would check the type, nullability, length, and default. For each foreign key, you would figure out the relation and add a `@ManyToOne` decorator. This would take hours, and you would almost certainly make mistakes.

With introspection, you point the generator at your database and it produces all 47 entity files automatically. Foreign keys become `@ManyToOne` + `@RelationColumn`. Unique constraints become `@UniqueIndex`. `created_at` / `updated_at` / `deleted_at` columns are recognized and emitted as `@CreateTimestamp` / `@UpdateTimestamp` / `@DeletedAt`. Snake_case column names are preserved via explicit `name:` options so the generated entity is **round-trip stable** — applying it back to a fresh database creates the exact same schema.

Introspection is the reverse of schema synchronization. Where `synchronize: true` reads your entities and creates tables, introspection reads your tables and creates entities.

---

## How It Works

The introspection system has three core components plus a runtime helper:

```
┌─────────────────────────┐
│  IntrospectionGenerator │   Orchestrator — queries the database
│                         │   catalogs and coordinates the others
└───────────┬─────────────┘
            │
     ┌──────┴──────┐
     │             │
     v             v
┌──────────┐  ┌──────────────────┐
│TypeMapper│  │EntityCodeBuilder │
│          │  │                  │
│ DB type  │  │ Takes columns,   │
│ → ORM    │  │ PKs, FKs,        │
│ ColumnType│  │ indexes → .ts   │
└──────────┘  └──────────────────┘
            │
            v
   ┌──────────────────┐
   │  runIntrospect() │   Convenience wrapper that connects via
   │  + stingerloom   │   DatabaseClient, writes files to disk,
   │   introspect CLI │   and exposes a CLI command
   └──────────────────┘
```

Step-by-step flow:

1. **Discover tables.** PostgreSQL uses `pg_tables`, MySQL uses `information_schema.TABLES`, SQLite uses `sqlite_master`.
2. **Get column metadata.** Per table — name, type, length, precision/scale, nullability, default, plus dialect-specific extras (MySQL `COLUMN_TYPE` for TINYINT(1) detection, PG `is_identity` for `GENERATED AS IDENTITY` columns).
3. **Get primary keys.** Detects composite PKs and the rowid-alias `INTEGER PRIMARY KEY` pattern on SQLite.
4. **Get foreign keys.** Sorted by the FK column's ordinal position so the output is deterministic across runs.
5. **Get indexes.** Non-PK indexes only; FK-implied single-column indexes are filtered out since most engines create them automatically.
6. **Resolve enum labels.** PostgreSQL `pg_type` + `pg_enum`; MySQL `COLUMN_TYPE` parsed for the `ENUM('a','b',…)` value list.
7. **Map types.** `IntrospectionTypeMapper` converts DB-native types to ORM `ColumnType` values.
8. **Generate code.** `EntityCodeBuilder` assembles imports, decorators, and properties; emits class-level `@Index`/`@UniqueIndex` for multi-column or unique indexes, property-level `@Index()` for single-column non-unique ones, and timestamp decorators when column-name heuristics match.

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
```

| Flag | Description |
|------|-------------|
| `--output <dir>` | Where to write generated entities. Default: `./entities` |
| `--schema <name>` | PostgreSQL schema. Default: `public` |
| `--include <list>` | Comma-separated whitelist of tables to generate |
| `--exclude <list>` | Comma-separated blacklist of tables to skip |
| `--import-path <p>` | Import path for ORM decorators. Default: `@stingerloom/orm` |
| `--dry-run` | Report what would be generated without writing files |
| `--config <path>` | Explicit config file path (default: auto-detect) |

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

For advanced cases like driving the generator with a custom query function:

```typescript
import { IntrospectionGenerator } from "@stingerloom/orm";

const generator = new IntrospectionGenerator(
  (q) => driver.query(q),         // Accepts strings or `sql` template tags
  "postgres",                      // "postgres" | "mysql" | "sqlite"
  { schema: "public", excludeTables: ["__migrations"] },
);

const entities = await generator.generate();
// or fetch individual pieces:
const tables = await generator.discoverTables();
const columns = await generator.getColumns("users");
const fks = await generator.getForeignKeys("posts");
const indexes = await generator.getIndexes("users");
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
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  profile_id INT,
  CONSTRAINT fk_user_profile FOREIGN KEY (profile_id) REFERENCES profile(id),
  UNIQUE KEY uq_user_username (username)
);
```

Introspection produces:

```typescript
import {
  Column,
  CreateTimestamp,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  RelationColumn,
  UniqueIndex,
  UpdateTimestamp,
} from "@stingerloom/orm";
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
  isValid!: boolean;

  @CreateTimestamp({ name: "created_at" })
  createdAt!: Date;

  @UpdateTimestamp({ name: "updated_at" })
  updatedAt!: Date;

  @ManyToOne(() => Profile, (entity: any) => entity.profile)
  @RelationColumn({ name: "profile_id" })
  profile!: Profile;
}
```

Things to notice:

- **`name:` options preserve the DB column name** (`access_key`, `is_valid`) so the generated entity round-trips under the default identity NamingStrategy. Without this, applying the entity would create an `accessKey` column instead of `access_key`.
- **TINYINT(1) is recognized as `boolean`**; wider TINYINT widths (`TINYINT(4)`, `TINYINT UNSIGNED`) map to `int`.
- **`created_at` / `updated_at` are emitted as timestamp decorators** with the column name passed through.
- **The FK column `profile_id` is not a `@Column`** — it's expressed via `@ManyToOne` + `@RelationColumn({ name })`. The deprecated `joinColumn` option is not used.
- **The unique index is hoisted to a class-level `@UniqueIndex`** with the original index name preserved.

---

## Round-Trip Stability

The introspection output is deterministic. Given a stable database schema, running introspect twice produces bit-identical files. Applying the output as a schema and re-introspecting also produces bit-identical files. The mechanisms that make this work:

| Mechanism | Why |
|-----------|-----|
| Explicit `name:` on `@Column`, `@PrimaryColumn`, `@PrimaryGeneratedColumn`, `@CreateTimestamp`, `@UpdateTimestamp`, `@DeletedAt` whenever DB col name ≠ property name | Prevents identity NamingStrategy from creating camelCase columns on re-apply |
| FK relations sorted by their column's ordinal position | INFORMATION_SCHEMA's natural order isn't stable across engines |
| `columnNameToPropertyName` preserves camelCase columns | Without this, `updatedAt` column would become `updatedat` property |
| Class-level `@Index`/`@UniqueIndex` reference **property keys**, not DB column names | The ORM remaps property → column via metadata; raw DB names would mismatch |
| MariaDB's `COLUMN_DEFAULT = 'NULL'` quirk is filtered | Otherwise nullable columns get a noisy `default: "(NULL)"` |
| Self-referential FKs don't emit a self-import | Would conflict with the local class declaration |
| Composite-PK FK columns emit both `@PrimaryColumn` and the relation | Closure tables need a real PK |

This guarantees that you can introspect a legacy database, commit the entities, and have CI/CD reapply them to a staging database with identical results.

---

## Type Mapping

### PostgreSQL

| Database Type | ORM `ColumnType` | TypeScript |
|---------------|------------------|------------|
| `INTEGER`, `INT4`, `SMALLINT`, `SERIAL` | `int` | `number` |
| `BIGINT`, `INT8`, `BIGSERIAL` | `bigint` | `number` |
| `REAL`, `FLOAT4` | `float` | `number` |
| `DOUBLE PRECISION`, `FLOAT8`, `NUMERIC`, `DECIMAL` | `double` | `number` (precision/scale preserved) |
| `BOOLEAN`, `BOOL` | `boolean` | `boolean` |
| `CHARACTER VARYING`, `VARCHAR` | `varchar` | `string` (length preserved) |
| `TEXT` | `text` | `string` |
| `CHAR`, `CHARACTER`, `BPCHAR` | `char` | `string` (length preserved) |
| `TIMESTAMP`, `TIMESTAMP WITHOUT TIME ZONE` | `timestamp` | `Date` |
| `TIMESTAMPTZ`, `TIMESTAMP WITH TIME ZONE` | `timestamptz` | `Date` |
| `DATE` | `date` | `Date` |
| `JSON` | `json` | `any` |
| `JSONB` | `jsonb` | `any` |
| `BYTEA` | `blob` | `Buffer` |
| `ARRAY` | `array` | `any` |
| `USER-DEFINED` (with `udt_name` resolving to `pg_type.typtype = 'e'`) | `enum` (labels embedded) | `string` |

`GENERATED { ALWAYS \| BY DEFAULT } AS IDENTITY` columns (PG 10+) are recognized via `information_schema.columns.is_identity = 'YES'` and emitted as `@PrimaryGeneratedColumn`.

### MySQL / MariaDB

| Database Type | ORM `ColumnType` | TypeScript |
|---------------|------------------|------------|
| `INT`, `INTEGER`, `MEDIUMINT`, `SMALLINT` | `int` | `number` |
| `TINYINT(1)` | `boolean` | `boolean` |
| `TINYINT(N)` where `N > 1`, or `TINYINT UNSIGNED` | `int` | `number` |
| `BIGINT` | `bigint` | `number` |
| `FLOAT` | `float` | `number` |
| `DOUBLE`, `DECIMAL`, `NUMERIC` | `double` | `number` (precision/scale preserved) |
| `VARCHAR` | `varchar` | `string` (length preserved) |
| `CHAR` | `char` | `string` (length preserved) |
| `TEXT`, `MEDIUMTEXT`, `TINYTEXT` | `text` | `string` |
| `LONGTEXT` | `longtext` | `string` |
| `DATETIME`, `TIMESTAMP`, `DATE` | `datetime` / `timestamp` / `date` | `Date` |
| `JSON` | `json` | `any` |
| `BLOB`, `MEDIUMBLOB`, `LONGBLOB`, `TINYBLOB` | `blob` | `Buffer` |
| `ENUM('a','b',…)` | `enum` (values parsed from `COLUMN_TYPE`) | `string` |

The introspector reads `INFORMATION_SCHEMA.COLUMNS.COLUMN_TYPE` (the full declared type with width) to differentiate TINYINT(1) from wider widths. When `COLUMN_TYPE` is unavailable, TINYINT falls back to `boolean` for backwards compatibility.

### SQLite

| Declared Type | ORM `ColumnType` | TypeScript |
|---------------|------------------|------------|
| `INTEGER`, `INT`, `INT2`, `INT4`, `MEDIUMINT`, `SMALLINT`, `TINYINT` | `int` | `number` |
| `INT8`, `BIGINT`, `UNSIGNED BIG INT` | `bigint` | `number` |
| `REAL`, `FLOAT` | `float` | `number` |
| `DOUBLE`, `DOUBLE PRECISION`, `NUMERIC`, `DECIMAL` | `double` | `number` (precision/scale parsed) |
| `BOOLEAN`, `BOOL` | `boolean` | `boolean` |
| `TEXT` | `text` | `string` |
| `CLOB` | `longtext` | `string` |
| `CHARACTER`, `CHAR`, `NATIVE CHARACTER` | `char` | `string` (length parsed) |
| `VARCHAR`, `VARYING CHARACTER`, `NVARCHAR` | `varchar` | `string` (length parsed) |
| `DATETIME`, `TIMESTAMP`, `DATE` | `datetime` / `timestamp` / `date` | `Date` |
| `JSON` | `json` | `any` |
| `BLOB` | `blob` | `Buffer` |

SQLite uses `PRAGMA table_info()`, `PRAGMA foreign_key_list()`, `PRAGMA index_list()`, and `PRAGMA index_info()` to extract schema. Single-column `INTEGER PRIMARY KEY` is recognized as a rowid alias and emitted as `@PrimaryGeneratedColumn`.

Unknown types fall back to `varchar` (mapped to `string`).

---

## Foreign Key Detection

When the generator discovers a foreign key, it:

1. **Skips** the FK column from `@Column` output (replaced by the relation).
2. **Emits** a `@ManyToOne` + `@RelationColumn` pair pointing to the referenced table.
3. **Sorts** FK relations by the FK column's position in the table so the output is deterministic.

```typescript
@ManyToOne(() => User, (entity: any) => entity.author)
@RelationColumn({ name: "author_id" })
author!: Relation<User>;
```

The property name is derived from the FK column by:

- Stripping `_id` suffix: `author_id` → `author`
- Stripping `id_` prefix: `id_ancestor` → `ancestor`
- Otherwise camelCasing the column name: `parentRef` → `parentRef`

If that derived name collides with another column (e.g., a `user` text column when an FK column is `user_id`), the generator falls back to the full camelCased FK column name (`userId`).

### Self-Referential FKs

When a FK points back to the same table, the generator emits the relation but **does not import the class**:

```typescript
@Entity({ name: "department" })
export class Department {
  @PrimaryGeneratedColumn()
  deptSq!: number;

  @ManyToOne(() => Department, (entity: any) => entity.upperDeptSq)
  @RelationColumn({ name: "UPPER_DEPT_SQ" })
  upperDeptSq!: Department;
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
  @RelationColumn({ name: "id_ancestor" })
  ancestor!: PostComment;

  @ManyToOne(() => PostComment, (entity: any) => entity.descendant)
  @RelationColumn({ name: "id_descendant" })
  descendant!: PostComment;
}
```

---

## Index Detection

The generator queries non-PK indexes from `INFORMATION_SCHEMA.STATISTICS` (MySQL), `pg_index` + `pg_attribute` (PostgreSQL), or `PRAGMA index_list` + `PRAGMA index_info` (SQLite) and classifies them:

| Index Kind | Emitted As |
|------------|------------|
| Single-column non-unique | Property-level `@Index()` on the matching column |
| Single-column UNIQUE | Class-level `@UniqueIndex([col], name)` |
| Multi-column non-unique | Class-level `@Index([col1, col2], name)` |
| Multi-column UNIQUE | Class-level `@UniqueIndex([col1, col2], name)` |

Indexes that exactly cover the primary key are dropped (already handled by `@PrimaryColumn` / `@PrimaryGeneratedColumn`). Single-column indexes that map to a foreign key column are also dropped since most engines create those implicitly.

Class-level decorators reference **property keys**, not DB column names. The ORM resolves them back to column names via entity metadata.

---

## Timestamp Decorator Heuristics

Columns matching the standard timestamp names — combined with type and nullability — are emitted as timestamp decorators instead of plain `@Column`:

| Property name | Column type | Nullable | Decorator |
|---------------|-------------|----------|-----------|
| `createdAt` | datetime/timestamp/timestamptz/date | No | `@CreateTimestamp({ name?, type? })` |
| `updatedAt` | datetime/timestamp/timestamptz/date | No | `@UpdateTimestamp({ name?, type? })` |
| `deletedAt` | datetime/timestamp/timestamptz/date | Yes | `@DeletedAt({ name?, type? })` |

The decorator emits `name:` whenever the DB column name differs from the property name, and `type:` whenever the type isn't the default `datetime`. Columns that don't match the heuristic (e.g., `upload_date`, `published_at`) keep their raw `@Column` form with the original default expression preserved.

---

## Default Value Preservation

`column_default` values are normalized and emitted as `@Column({ default: … })`:

| Raw default (DB) | Emitted |
|------------------|---------|
| `'active'` (string literal) | `default: "active"` |
| `'active'::character varying` (PG cast) | `default: "active"` (cast stripped) |
| `0`, `42`, `-1` (numeric) | `default: 0` (when column is numeric type) |
| `true`, `false`, `'t'`, `'f'`, `0`, `1` (boolean column) | `default: true` / `default: false` |
| `CURRENT_TIMESTAMP`, `now()`, `uuid_generate_v4()` | `default: "(CURRENT_TIMESTAMP)"` (raw expression wrapped) |
| `nextval('seq'::regclass)` or `auto_increment` | omitted (PK auto-gen handles it) |
| MariaDB bare `NULL` (no explicit default) | omitted |

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

---

## API Reference

### `IntrospectionGenerator`

| Method | Signature | Description |
|--------|-----------|-------------|
| `constructor` | `(queryFn, dialect, options?)` | Create with a query function, dialect (`"postgres"` / `"mysql"` / `"sqlite"`), and optional options |
| `generate()` | `(): Promise<GeneratedEntity[]>` | Generate entity files for all matching tables |
| `discoverTables()` | `(): Promise<string[]>` | All user tables in the target schema |
| `getColumns(table)` | `(table: string): Promise<DbColumn[]>` | Column metadata for a specific table |
| `getPrimaryKeys(table)` | `(table: string): Promise<string[]>` | Primary key column names |
| `getForeignKeys(table)` | `(table: string): Promise<DbForeignKey[]>` | Foreign key relationships |
| `getIndexes(table)` | `(table: string): Promise<DbIndex[]>` | Non-PK indexes (unique and non-unique) |

### `runIntrospect(dbOptions, cliOptions?)`

Connects via `DatabaseClient`, runs the generator, writes files to disk (unless `dryRun`). Returns `{ writtenFiles, entities }`.

### `IntrospectionTypeMapper`

| Method | Signature | Description |
|--------|-----------|-------------|
| `toColumnType(dbType, dialect, columnTypeFull?)` | `(...): ColumnType` | Map a DB type. Pass MySQL `COLUMN_TYPE` as the optional third arg to narrow TINYINT |
| `toTsType(columnType)` | `(columnType: ColumnType): string` | ORM `ColumnType` → TypeScript type string |
| `parseSqliteWidth(declaredType)` | `(declaredType: string): number \| null` | Extract `N` from `VARCHAR(N)` etc. |
| `parseSqlitePrecisionScale(declaredType)` | `(declaredType: string): { precision, scale } \| null` | Extract `(P, S)` from `DECIMAL(P, S)` |

### `EntityCodeBuilder`

| Method | Signature | Description |
|--------|-----------|-------------|
| `constructor` | `(options?: EntityCodeBuilderOptions)` | Builder with optional import path |
| `build(table, columns, pks, fks, dialect, indexes?)` | `(...): string` | TypeScript entity source code |
| `tableNameToClassName(table)` | `(string): string` | snake_case table → PascalCase class |
| `classNameToFileName(className)` | `(string): string` | PascalCase class → kebab-case file name |

### `DbColumn`

| Property | Type | Description |
|----------|------|-------------|
| `column_name` | `string` | Column name |
| `data_type` | `string` | DB-native type name |
| `is_nullable` | `string` | `"YES"` or `"NO"` |
| `character_maximum_length` | `number \| null` | Max length for char/varchar |
| `numeric_precision` | `number \| null` | Precision for decimal/numeric |
| `numeric_scale` | `number \| null` | Scale for decimal/numeric |
| `column_default` | `string \| null` | Default expression from DB |
| `column_type` | `string \| null` | MySQL `COLUMN_TYPE` with width (e.g., `tinyint(1)`) |
| `is_identity` | `string \| null` | PG `"YES"` for `GENERATED AS IDENTITY` |
| `enum_values` | `string[] \| null` | Enum labels (PG `pg_enum` or MySQL parsed) |
| `extra` | `string \| null` | MySQL `EXTRA` (e.g., `auto_increment`) |

### `DbForeignKey`

| Property | Type | Description |
|----------|------|-------------|
| `column_name` | `string` | FK column in the current table |
| `referenced_table` | `string` | Target table |
| `referenced_column` | `string` | Target column |
| `constraint_name` | `string \| undefined` | FK constraint name |

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
- **Cascade rules (`onDelete`, `onUpdate`).** Not extracted from `REFERENTIAL_CONSTRAINTS`. Add manually if needed.
- **Friendly property aliases.** A column like `CTGR_GRP_SQ` is camelCased to `ctgrGrpSq`. If you want a friendlier name like `groupId`, rename the property and keep the `name:` option pointing at `CTGR_GRP_SQ`.

The inverse-side accessor in `@ManyToOne(() => Entity, (entity: any) => entity.foo)` is a placeholder using `any` so the code compiles even without the inverse property. Once you add `@OneToMany` collections, rename the placeholder to match.

---

## Next Steps

- [Database Seeding](./seeding.md) — Populate tables with initial data after generation
- [Migrations](./migrations.md) — Version-controlled schema changes
- [Entities & Columns](./entities.md) — Customize the generated entity files
- [Relations](./relations.md) — Add OneToMany, ManyToMany, and other relations
