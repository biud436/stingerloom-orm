# Database Introspection

## Why Introspection Exists

You join a new team. The project has a PostgreSQL database with 47 tables, hundreds of columns, foreign keys linking everything together. The previous developer did not use an ORM -- all the SQL is hand-written. Your job is to migrate the project to Stingerloom ORM.

Without introspection, you would open pgAdmin, look at each table definition, and manually write 47 entity files. For each column, you would check the type, nullability, and length. For each foreign key, you would figure out the relation and add a `@ManyToOne` decorator. This would take hours, and you would almost certainly make mistakes.

With introspection, you point the generator at your database and it produces all 47 entity files automatically. Foreign keys become `@ManyToOne` relations. Column types are mapped to the correct ORM types. You review the output, tweak what needs tweaking, and you are done.

Introspection is the reverse of schema synchronization. Where `synchronize: true` reads your entities and creates tables, introspection reads your tables and creates entities.

---

## How It Works

The introspection system has three components, each with a clear responsibility:

```
┌─────────────────────────┐
│  IntrospectionGenerator │   Orchestrator — queries the database,
│                         │   coordinates the other two components
└───────────┬─────────────┘
            │
     ┌──────┴──────┐
     │             │
     v             v
┌──────────┐  ┌──────────────────┐
│TypeMapper│  │EntityCodeBuilder │
│          │  │                  │
│ DB type  │  │ Takes columns,   │
│ → ORM    │  │ PKs, FKs and    │
│ ColumnType│  │ produces .ts    │
└──────────┘  └──────────────────┘
```

Here is the step-by-step flow:

**Step 1: Discover tables.** The generator queries the database catalog to find all user tables. For PostgreSQL, it queries `pg_tables`. For MySQL, it queries `information_schema.TABLES`.

**Step 2: Get column metadata.** For each table, it queries `information_schema.columns` to get every column's name, data type, nullability, and length.

**Step 3: Get primary keys.** For each table, it queries the database catalog to identify which columns form the primary key.

**Step 4: Get foreign keys.** For each table, it queries `information_schema.table_constraints` and related tables to discover foreign key relationships -- which column references which table.

**Step 5: Map types.** The `IntrospectionTypeMapper` converts database-native type names (like `CHARACTER VARYING` or `BIGINT`) to ORM `ColumnType` values (like `"varchar"` or `"bigint"`).

**Step 6: Generate code.** The `EntityCodeBuilder` takes all the metadata and produces a complete TypeScript entity file with proper imports, decorators, and type annotations.

---

## Generating Entities from an Existing Database

### Programmatic Usage

```typescript
import { IntrospectionGenerator } from "@stingerloom/orm";

// You need a query function — typically from your driver
const generator = new IntrospectionGenerator(
  (q) => driver.query(q),  // query function
  "postgres",               // dialect: "postgres" or "mysql"
  {
    schema: "public",       // PostgreSQL schema (default: "public")
  },
);

const entities = await generator.generate();

// Write each entity to a file
import * as fs from "fs";

for (const entity of entities) {
  const path = `./src/entities/${entity.fileName}`;
  fs.writeFileSync(path, entity.code);
  console.log(`Generated: ${path} (${entity.className})`);
}
```

Let us trace what happens for a database with two tables: `users` and `posts` (where `posts` has a foreign key to `users`).

1. `generator.generate()` calls `discoverTables()`, which returns `["posts", "users"]`.
2. For `posts`, it calls `getColumns()`, `getPrimaryKeys()`, and `getForeignKeys()`.
3. `getColumns()` returns columns like `id` (integer), `title` (varchar), `body` (text), `author_id` (integer).
4. `getPrimaryKeys()` returns `["id"]`.
5. `getForeignKeys()` returns `[{ column_name: "author_id", referenced_table: "users", referenced_column: "id" }]`.
6. The `EntityCodeBuilder` takes all of this and produces:

```typescript
// Generated file: post.entity.ts
import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from "@stingerloom/orm";

@Entity()
export class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  title!: string;

  @Column({ type: "text", nullable: true })
  body!: string;

  @ManyToOne(() => User, { joinColumn: "author_id" })
  author!: User;
}
```

Notice several things:

- The `author_id` column is not generated as a `@Column`. Instead, the foreign key is detected and it becomes a `@ManyToOne` relation with the `joinColumn` option pointing to the original FK column.
- The table name `posts` (plural) becomes the class name `Post` (singular, PascalCase). The generator handles common plural forms: `users` becomes `User`, `categories` becomes `Category`, `addresses` stays `Address`.
- Snake_case column names become camelCase property names: `author_id` becomes the relation property `author`.
- The file name uses kebab-case: `Post` becomes `post.entity.ts`, `UserProfile` becomes `user-profile.entity.ts`.

### The GeneratedEntity Object

Each generated entity is returned as an object:

| Property | Type | Description |
|----------|------|-------------|
| `tableName` | `string` | Original database table name (e.g., `"posts"`) |
| `className` | `string` | Generated PascalCase class name (e.g., `"Post"`) |
| `code` | `string` | Complete TypeScript source code |
| `fileName` | `string` | Suggested file name (e.g., `"post.entity.ts"`) |

---

## Type Mapping

The `IntrospectionTypeMapper` converts database-native types to ORM `ColumnType` values. Here are the key mappings for each dialect.

### PostgreSQL

| Database Type | ORM ColumnType | TypeScript Type |
|---------------|----------------|-----------------|
| INTEGER, INT, SERIAL | `"int"` | `number` |
| BIGINT, BIGSERIAL | `"bigint"` | `number` |
| REAL, FLOAT4 | `"float"` | `number` |
| DOUBLE PRECISION, FLOAT8, NUMERIC, DECIMAL | `"double"` | `number` |
| BOOLEAN, BOOL | `"boolean"` | `boolean` |
| CHARACTER VARYING, VARCHAR | `"varchar"` | `string` |
| TEXT | `"text"` | `string` |
| CHAR, CHARACTER, BPCHAR | `"char"` | `string` |
| TIMESTAMP, TIMESTAMP WITHOUT TIME ZONE | `"timestamp"` | `Date` |
| TIMESTAMPTZ, TIMESTAMP WITH TIME ZONE | `"timestamptz"` | `Date` |
| DATE | `"date"` | `Date` |
| JSON | `"json"` | `any` |
| JSONB | `"jsonb"` | `any` |
| BYTEA | `"blob"` | `Buffer` |
| ARRAY | `"array"` | `any` |
| USER-DEFINED | `"enum"` | `string` |

### MySQL

| Database Type | ORM ColumnType | TypeScript Type |
|---------------|----------------|-----------------|
| INT, INTEGER, MEDIUMINT, SMALLINT | `"int"` | `number` |
| TINYINT | `"boolean"` | `boolean` |
| BIGINT | `"bigint"` | `number` |
| FLOAT | `"float"` | `number` |
| DOUBLE, DECIMAL, NUMERIC | `"double"` | `number` |
| VARCHAR | `"varchar"` | `string` |
| CHAR | `"char"` | `string` |
| TEXT, MEDIUMTEXT, TINYTEXT | `"text"` | `string` |
| LONGTEXT | `"longtext"` | `string` |
| DATETIME | `"datetime"` | `Date` |
| TIMESTAMP | `"timestamp"` | `Date` |
| DATE | `"date"` | `Date` |
| JSON | `"json"` | `any` |
| BLOB, MEDIUMBLOB, LONGBLOB, TINYBLOB | `"blob"` | `Buffer` |
| ENUM | `"enum"` | `string` |

If the generator encounters a type it does not recognize, it falls back to `"varchar"` (mapped to `string` in TypeScript). This is a safe default -- you can always refine the type manually afterward.

---

## Foreign Key Detection

When the introspection generator discovers a foreign key, it does two things:

1. **Skips the FK column** from the regular `@Column` output. Instead of generating `@Column({ type: "int" }) authorId!: number`, it removes the column entirely.
2. **Generates a `@ManyToOne` relation** that points to the referenced table, with the original FK column name as the `joinColumn`.

For example, given this database schema:

```sql
CREATE TABLE "users" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(100) NOT NULL
);

CREATE TABLE "posts" (
  "id" SERIAL PRIMARY KEY,
  "title" VARCHAR(255) NOT NULL,
  "author_id" INT REFERENCES "users"("id")
);
```

The generator produces an entity for `posts` where `author_id` becomes:

```typescript
@ManyToOne(() => User, { joinColumn: "author_id" })
author!: User;
```

The property name is derived from the FK column name by removing the `_id` suffix: `author_id` becomes `author`. If the FK column does not end with `_id`, the full column name is used as the property name.

---

## Options

The `IntrospectionGeneratorOptions` let you control which tables are generated and how the code is produced.

### schema

PostgreSQL only. Specifies which schema to introspect. Defaults to `"public"`.

```typescript
const generator = new IntrospectionGenerator(queryFn, "postgres", {
  schema: "tenant_42",
});
```

### includeTables

If set, only these tables are generated. All other tables are ignored.

```typescript
const generator = new IntrospectionGenerator(queryFn, "postgres", {
  includeTables: ["users", "posts", "comments"],
});
// Only generates entities for these 3 tables, even if the database has 47 tables
```

### excludeTables

Tables to skip during generation. Useful for excluding system tables or tables you want to manage manually.

```typescript
const generator = new IntrospectionGenerator(queryFn, "postgres", {
  excludeTables: ["__migrations", "__seeds", "spatial_ref_sys"],
});
```

If both `includeTables` and `excludeTables` are set, `includeTables` is checked first (only included tables are considered), then `excludeTables` removes any that match.

### codeBuilderOptions

Options passed to the `EntityCodeBuilder`:

```typescript
const generator = new IntrospectionGenerator(queryFn, "postgres", {
  codeBuilderOptions: {
    importPath: "../orm",  // Custom import path (default: "@stingerloom/orm")
  },
});
```

This changes the import statement in generated files:

```typescript
// Default
import { Column, Entity, PrimaryGeneratedColumn } from "@stingerloom/orm";

// With custom importPath
import { Column, Entity, PrimaryGeneratedColumn } from "../orm";
```

---

## API Reference

### IntrospectionGenerator

| Method | Signature | Description |
|--------|-----------|-------------|
| `constructor` | `(queryFn, dialect, options?)` | Create a generator with a query function, dialect (`"postgres"` or `"mysql"`), and optional options |
| `generate()` | `(): Promise<GeneratedEntity[]>` | Generate entity files for all matching tables |
| `discoverTables()` | `(): Promise<string[]>` | Return all table names in the target schema |
| `getColumns(table)` | `(table: string): Promise<DbColumn[]>` | Get column metadata for a specific table |
| `getPrimaryKeys(table)` | `(table: string): Promise<string[]>` | Get primary key column names for a specific table |
| `getForeignKeys(table)` | `(table: string): Promise<DbForeignKey[]>` | Get foreign key relationships for a specific table |

### IntrospectionTypeMapper

| Method | Signature | Description |
|--------|-----------|-------------|
| `toColumnType(dbType, dialect)` | `(dbType: string, dialect): ColumnType` | Map a database type string to an ORM ColumnType |
| `toTsType(columnType)` | `(columnType: ColumnType): string` | Map an ORM ColumnType to a TypeScript type string |

### EntityCodeBuilder

| Method | Signature | Description |
|--------|-----------|-------------|
| `constructor` | `(options?: EntityCodeBuilderOptions)` | Create a builder with optional import path |
| `build(tableName, columns, pks, fks, dialect)` | `(...): string` | Generate TypeScript entity source code |
| `tableNameToClassName(tableName)` | `(tableName: string): string` | Convert snake_case table name to PascalCase class name |

### DbColumn

| Property | Type | Description |
|----------|------|-------------|
| `column_name` | `string` | Column name |
| `data_type` | `string` | Database-native type name |
| `is_nullable` | `string` | `"YES"` or `"NO"` |
| `character_maximum_length` | `number \| null` | Max length for string types |
| `numeric_precision` | `number \| null` | Precision for numeric types |
| `numeric_scale` | `number \| null` | Scale for numeric types |
| `column_default` | `string \| null` | Default value expression |

### DbForeignKey

| Property | Type | Description |
|----------|------|-------------|
| `column_name` | `string` | FK column name in the current table |
| `referenced_table` | `string` | Referenced table name |
| `referenced_column` | `string` | Referenced column name |
| `constraint_name` | `string \| undefined` | FK constraint name |

---

## Next Steps

- [Database Seeding](./seeding.md) -- Populate tables with initial data after generation
- [Migrations](./migrations.md) -- Version-controlled schema changes
- [Entities & Columns](./entities.md) -- Customize the generated entity files
- [Relations](./relations.md) -- Add OneToMany, ManyToMany, and other relations
