# Prisma Import

If you are migrating from Prisma to Stingerloom ORM, the **Prisma Import** tool can automatically convert your `schema.prisma` file into decorator-based entity `.ts` files. This eliminates the tedious manual conversion work.

## Installation

The tool requires `@mrleebo/prisma-ast` as a peer dependency:

```bash
pnpm add -D @mrleebo/prisma-ast
```

## CLI Usage

```bash
npx stingerloom-prisma-import --schema ./prisma/schema.prisma --output ./src/entities/
```

### Options

| Option | Alias | Description |
|--------|-------|-------------|
| `--schema` | `-s` | Path to Prisma schema file (required) |
| `--output` | `-o` | Output directory for generated files (required) |
| `--force` | `-f` | Overwrite existing files |
| `--provider` | `-p` | Override database provider (`postgresql`, `mysql`, `sqlite`) |

### Example

Given a Prisma schema at `./prisma/schema.prisma`:

```bash
npx stingerloom-prisma-import -s ./prisma/schema.prisma -o ./src/entities/ --force
```

Output:

```
Generated files:
  + src/entities/role.enum.ts
  + src/entities/user.entity.ts
  + src/entities/post.entity.ts
  + src/entities/tag.entity.ts
  + src/entities/index.ts

Done! 5 file(s) written, 0 skipped.
```

## Programmatic Usage

You can also use the importer as a library:

```typescript
import { PrismaImporter } from "@stingerloom/orm/prisma-import";

const importer = new PrismaImporter();

// Write files to disk
const result = await importer.import({
  schemaPath: "./prisma/schema.prisma",
  outputDir: "./src/entities/",
  force: true,
});

console.log(`Generated ${result.written.length} files`);
console.log("Warnings:", result.warnings);
```

For testing or code generation without disk I/O:

```typescript
import { PrismaImporter } from "@stingerloom/orm/prisma-import";

const importer = new PrismaImporter();
const files: Map<string, string> = importer.generate(schemaSource);

for (const [filename, content] of files) {
  console.log(filename, content);
}
```

## Conversion Example

### Input: `schema.prisma`

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Role {
  ADMIN
  USER
  MODERATOR
}

model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  name      String?
  role      Role     @default(USER)
  posts     Post[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model Post {
  id        Int      @id @default(autoincrement())
  title     String
  content   String?  @db.Text
  published Boolean  @default(false)
  authorId  Int
  author    User     @relation(fields: [authorId], references: [id])
  tags      Tag[]
  createdAt DateTime @default(now())
}

model Tag {
  id    Int    @id @default(autoincrement())
  name  String @unique
  posts Post[]
}
```

### Output: `role.enum.ts`

```typescript
export enum Role {
  ADMIN = "ADMIN",
  USER = "USER",
  MODERATOR = "MODERATOR",
}
```

### Output: `user.entity.ts`

```typescript
import { Column, CreateTimestamp, Entity, OneToMany, PrimaryGeneratedColumn, UpdateTimestamp } from "@stingerloom/orm";
import { Post } from "./post.entity";
import { Role } from "./role.enum";

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  email!: string;

  @Column({ nullable: true })
  name!: string | null;

  @Column({ type: "enum", enumName: "Role", enumValues: ["ADMIN", "USER", "MODERATOR"], default: "USER" })
  role!: string;

  @CreateTimestamp()
  createdAt!: Date;

  @UpdateTimestamp()
  updatedAt!: Date;

  @OneToMany(() => Post, { mappedBy: "author" })
  posts!: Post[];
}
```

### Output: `post.entity.ts`

```typescript
import { Column, CreateTimestamp, Entity, ManyToMany, ManyToOne, PrimaryGeneratedColumn } from "@stingerloom/orm";
import { Tag } from "./tag.entity";
import { User } from "./user.entity";

@Entity()
export class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @Column({ type: "text", nullable: true })
  content!: string | null;

  @Column({ default: false })
  published!: boolean;

  @CreateTimestamp()
  createdAt!: Date;

  @ManyToOne(() => User, (e) => e.posts, { joinColumn: "authorId" })
  author!: User;

  @ManyToMany(() => Tag, {
    joinTable: {
      name: "post_tag",
      joinColumn: "post_id",
      inverseJoinColumn: "tag_id",
    },
  })
  tags!: Tag[];
}
```

### Output: `tag.entity.ts`

```typescript
import { Column, Entity, ManyToMany, PrimaryGeneratedColumn } from "@stingerloom/orm";
import { Post } from "./post.entity";

@Entity()
export class Tag {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @ManyToMany(() => Post, { mappedBy: "tags" })
  posts!: Post[];
}
```

## Type Mapping

### Basic Types

| Prisma Type | `@db.*` Hint | Stingerloom `ColumnType` |
|-------------|-------------|--------------------------|
| `String` | — | `varchar` (length: 255) |
| `String` | `@db.Text` | `text` |
| `String` | `@db.VarChar(n)` | `varchar` (length: n) |
| `String` | `@db.Char(n)` | `char` (length: n) |
| `Boolean` | — | `boolean` |
| `Int` | — | `int` |
| `BigInt` | — | `bigint` |
| `Float` | — | `float` |
| `Decimal` | — | `double` |
| `Decimal` | `@db.Decimal(p,s)` | `double` (precision/scale) |
| `DateTime` | — | `datetime` |
| `DateTime` | `@db.Timestamptz` | `timestamptz` |
| `Json` | — (PostgreSQL) | `jsonb` |
| `Json` | — (MySQL) | `json` |
| `Bytes` | — | `blob` |
| Enum name | — | `enum` |

### Special Mappings

| Prisma Pattern | Stingerloom Decorator |
|---------------|----------------------|
| `@id @default(autoincrement())` | `@PrimaryGeneratedColumn()` |
| `@id @default(uuid())` | `@PrimaryColumn({ type: "varchar", length: 36 })` |
| `@default(now())` | `@CreateTimestamp()` |
| `@updatedAt` | `@UpdateTimestamp()` |
| `@default(value)` | `@Column({ default: value })` |
| `@@id([a, b])` | `@PrimaryColumn()` on each field |

## Relation Mapping

| Prisma Pattern | Stingerloom |
|---------------|-------------|
| `author User @relation(fields:[authorId])` | `@ManyToOne(() => User, ...)` |
| `posts Post[]` (inverse of above) | `@OneToMany(() => Post, { mappedBy: "author" })` |
| `profile Profile?` + `@unique` FK | `@OneToOne(() => Profile, ...)` |
| `tags Tag[]` + `posts Post[]` (implicit M:N) | `@ManyToMany` with `joinTable` / `mappedBy` |

### Implicit Many-to-Many

When both sides of a relation are list types without explicit `fields`/`references`, Prisma treats this as an implicit many-to-many. The importer generates:

- **Owning side** (alphabetically first model): `@ManyToMany` with `joinTable`
- **Inverse side**: `@ManyToMany` with `mappedBy`
- **Join table name**: `{model_a}_{model_b}` in snake_case, alphabetical order

### Cascade

`onDelete: Cascade` in Prisma maps to `cascade: ["delete"]` in the generated decorator options.

## Edge Cases

| Prisma Feature | Handling |
|---------------|---------|
| `@@map("table_name")` | `@Entity({ name: "table_name" })` |
| `@map("col_name")` | `@Column({ name: "col_name" })` |
| `@@unique([a, b])` | `@UniqueIndex(["a", "b"])` |
| `@@id([a, b])` | `@PrimaryColumn()` on each field |
| `@default(uuid())` | `@PrimaryColumn` + TODO comment for app-level generation |
| `Unsupported("...")` | Skipped with warning |
| Self-referencing relation | Same class reference (e.g., `() => Category`) |
| Named relation `@relation("name")` | Used for pair matching, not emitted in output |

## Generated File Structure

```
src/entities/
├── role.enum.ts          # enum Role { ... }
├── user.entity.ts        # export class User { ... }
├── post.entity.ts        # export class Post { ... }
├── tag.entity.ts         # export class Tag { ... }
└── index.ts              # barrel re-exports
```

- Entity files: `{snake_case_model}.entity.ts`
- Enum files: `{snake_case_enum}.enum.ts`
- Barrel: `index.ts` with `export *` for all generated files

## After Import

The generated entities are ready to use with Stingerloom ORM. Review the output and make any adjustments:

1. **Verify relations** — Complex or ambiguous relations may need manual tweaking
2. **Add lifecycle hooks** — `@BeforeInsert`, `@BeforeUpdate` if needed
3. **Add validation** — `@Validation` decorators for business rules
4. **Register entities** — Pass them to `DatabaseClient` or `StinglerloomOrmModule.forRoot()`

```typescript
import { DatabaseClient } from "@stingerloom/orm";
import { User, Post, Tag } from "./entities";

const client = new DatabaseClient({
  type: "postgresql",
  host: "localhost",
  port: 5432,
  database: "mydb",
  username: "user",
  password: "pass",
  entities: [User, Post, Tag],
  synchronize: true,
});
```
