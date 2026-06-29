# Defining Entities

Stingerloom's recommended way to define an entity is the **code-first builder API**: `defineEntity` together with the `t` field builders. You write one declaration, and the entity's TypeScript type is **inferred from the schema** — no hand-written class, no parallel interface, no `experimentalDecorators`, no `emitDecoratorMetadata`, no build-time codegen.

```typescript
import { defineEntity, t, InferEntity } from "@stingerloom/orm";

export const User = defineEntity("users", {
  id:        t.int().primary().generated(),
  email:     t.varchar(255).unique(),
  name:      t.varchar(255).nullable(),
  role:      t.enum(["admin", "user"]).default("user"),
  createdAt: t.datetime().createTimestamp(),
});

export type User = InferEntity<typeof User>;
// { id: number; email: string; name: string | null;
//   role: "admin" | "user"; createdAt: Date }
```

`User` is a real runtime class — use it everywhere the ORM expects an entity (`em.getRepository(User)`, `em.findOne(User, …)`, relation targets). `InferEntity<typeof User>` recovers the row type, so the same name doubles as a type.

::: tip Prefer decorators?
The decorator API (`@Entity`, `@Column`, …) is fully supported and produces identical metadata — see [Entities & Columns (Decorators)](./entities.md). The two styles interoperate freely in the same project. This page is the recommended default for new code.
:::

## Why code-first

- **One source of truth.** The column builder fixes both the database type *and* the TypeScript type. `t.int()` is a `number`; you cannot accidentally annotate it as a `string`. With a hand-written class plus a separate schema, those two can silently drift.
- **Type inference, no codegen.** `InferEntity` reads the builders directly. There is no generate step and no watch process — the type updates the instant you edit the schema.
- **No decorator toolchain.** Works under strict mode and ESM with esbuild, swc, Vite, or Bun without `experimentalDecorators` / `emitDecoratorMetadata`. Nothing to misconfigure.

## The `t` builder

Every field is a call on the `t` namespace. Column builders carry their inferred type; chained modifiers refine it (`.nullable()` widens the type to `T | null`).

### Column types

| Builder | TypeScript type | Abstract column type |
| --- | --- | --- |
| `t.int()` / `t.integer()` | `number` | `int` |
| `t.bigint()` | `number` | `bigint` |
| `t.float()` / `t.double()` | `number` | `float` / `double` |
| `t.decimal(precision?, scale?)` | `number` | `number` |
| `t.varchar(length?)` | `string` | `varchar` |
| `t.char(length?)` | `string` | `char` |
| `t.text()` / `t.longtext()` | `string` | `text` / `longtext` |
| `t.uuid()` | `string` | `uuid` |
| `t.boolean()` | `boolean` | `boolean` |
| `t.datetime()` / `t.timestamp()` / `t.timestamptz()` / `t.date()` | `Date` | matching temporal type |
| `t.blob()` | `Buffer` | `blob` |
| `t.json<T>()` / `t.jsonb<T>()` | `T` (default `unknown`) | `json` / `jsonb` |
| `t.array<T>()` | `T[]` | `array` |
| `t.enum(["a", "b"])` | `"a" \| "b"` | `enum` |

```typescript
const Event = defineEntity("events", {
  id:       t.int().primary().generated(),
  payload:  t.jsonb<{ kind: string; data: unknown }>(),
  tags:     t.array<string>(),
  level:    t.enum(["info", "warn", "error"]).default("info"),
});
// InferEntity → payload: { kind: string; data: unknown }; tags: string[]; level: "info" | "warn" | "error"
```

### Modifiers

Chain modifiers in any order; each returns a new builder.

| Modifier | Effect |
| --- | --- |
| `.primary()` | Marks (part of) the primary key. |
| `.generated(strategy?)` | DB-generated key: `"increment"` (default), `"uuid"`, `"uuid-v7"`. Pair with `.primary()`. |
| `.nullable()` | Allows `NULL`; widens the inferred type to `T \| null`. |
| `.unique(name?)` | Single-column unique index. |
| `.index()` | Single-column index. |
| `.default(value)` | Column default. |
| `.name(dbName)` | Overrides the database column name (default: the property key). |
| `.length(n)` / `.precision(n)` / `.scale(n)` | Size / numeric precision. |
| `.transformer({ to, from })` | Bidirectional value transformer. |
| `.createTimestamp()` / `.updateTimestamp()` | Auto-set timestamps. |
| `.deletedAt()` | Soft-delete marker (implies nullable). |
| `.version()` | Optimistic-locking version column. |
| `.validate([...])` | Inline validation constraints. |
| `.enumName(name)` | Names the PostgreSQL `ENUM` type. |
| `.jsonIndex(opts)` | JSON/JSONB expression index. |
| `.tenant()` | Tenant discriminator column. |

```typescript
export const Account = defineEntity("accounts", {
  id:        t.uuid().primary().generated("uuid-v7"),
  email:     t.varchar(255).unique().transformer({
    to:   (v: string) => v.toLowerCase(),
    from: (v: string) => v,
  }),
  balance:   t.decimal(12, 2).default(0),
  createdAt: t.datetime().createTimestamp(),
  updatedAt: t.datetime().updateTimestamp(),
  deletedAt: t.datetime().deletedAt(),
  version:   t.int().version(),
});
```

## Relations

Relation builders take a lazy `() => TargetEntity` (lazy to allow circular references). `manyToOne` / `oneToOne` infer the related row type; `oneToMany` / `manyToMany` infer an array. Relation fields are **optional** in the inferred type — they are populated only when you request them with `relations: [...]`.

```typescript
export const Author = defineEntity("authors", {
  id:    t.int().primary().generated(),
  name:  t.varchar(120),
  posts: t.oneToMany(() => Post, "author"),
});

export const Post = defineEntity("posts", {
  id:       t.int().primary().generated(),
  title:    t.varchar(200),
  authorId: t.int().nullable().name("author_id"), // the physical FK column
  author:   t.manyToOne(() => Author, { joinColumn: "author_id" }),
  tags:     t.manyToMany(() => Tag, {
    joinTable: { name: "post_tags", joinColumn: "post_id", inverseJoinColumn: "tag_id" },
  }),
});

export type Author = InferEntity<typeof Author>; // posts?: Post[]
export type Post = InferEntity<typeof Post>;     // author?: Author; tags?: Tag[]
```

::: warning Declare the foreign-key column
A `manyToOne` / owning `oneToOne` needs its foreign-key column declared as a real column (e.g. `authorId: t.int().name("author_id")`) so it is created during schema sync — exactly as the decorator API pairs `@ManyToOne` with a `@Column`/`@RelationColumn` for the FK. The relation's `joinColumn` then points at that column. (Alternatively pass `relationColumn: { … }` in the relation options.)
:::

| Builder | Signature | Inferred field |
| --- | --- | --- |
| `t.manyToOne` | `(() => Target, options?)` | `Target?` |
| `t.oneToMany` | `(() => Target, mappedBy, options?)` | `Target[]?` |
| `t.oneToOne` | `(() => Target, options?)` | `Target?` |
| `t.manyToMany` | `(() => Target, options?)` | `Target[]?` |

## Computed columns

`t.computed` declares a database-generated column (excluded from `INSERT`/`UPDATE`):

```typescript
export const Person = defineEntity("people", {
  id:        t.int().primary().generated(),
  firstName: t.varchar(80).name("first_name"),
  lastName:  t.varchar(80).name("last_name"),
  fullName:  t.computed("first_name || ' ' || last_name", { stored: false, type: "varchar" }),
});
```

## Registering and using the entity

Pass the entity class to your `EntityManager` exactly like a decorated class:

```typescript
import "reflect-metadata";
import { EntityManager } from "@stingerloom/orm";
import { Author, Post } from "./entities";

const em = new EntityManager();
await em.register({
  type: "postgres",
  host: "localhost",
  entities: [Author, Post],
  synchronize: true,
});

const author = await em.save(Author, { name: "Ada" });
const post = await em.save(Post, { title: "Hello", authorId: author.id });

const withAuthor = await em.findOne(Post, {
  where: { id: post.id },
  relations: ["author"],
});
// withAuthor.author?.name === "Ada"  — fully typed
```

::: tip `reflect-metadata`
The ORM core still uses `reflect-metadata` at runtime, so keep `import "reflect-metadata"` at your entry point. What you *don't* need for code-first entities are the `experimentalDecorators` and `emitDecoratorMetadata` compiler options.
:::

## Advanced options

`defineEntity` takes an optional third argument for the less-common, entity-level settings:

```typescript
export const Member = defineEntity(
  "members",
  {
    id:    t.int().primary().generated(),
    orgId: t.int().name("org_id"),
    email: t.varchar(255),
  },
  {
    tableName: "org_members",          // override the table name
    uniqueIndexes: [{ columns: ["org_id", "email"], name: "uq_member_email" }],
    indexes: [{ columns: ["org_id"] }],
    nonTenant: true,                   // opt out of the tenant_column strategy
  },
);
```

For the full decorator → builder mapping (including full-text indexes, tenant columns, and lifecycle hooks), see the [Decorator-Free Reference](./decorator-free.md).

## Mixing with decorators

Code-first and decorator entities share the same metadata pipeline, so they coexist and can even relate to each other:

```typescript
@Entity()
class LegacyUser {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;
}

export const Comment = defineEntity("comments", {
  id:     t.int().primary().generated(),
  body:   t.text(),
  userId: t.int().name("user_id"),
  user:   t.manyToOne(() => LegacyUser, { joinColumn: "user_id" }),
});
```

Adopt the builder API incrementally — new entities code-first, existing decorated entities untouched.
