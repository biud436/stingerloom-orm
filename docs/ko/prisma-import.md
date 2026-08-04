# Prisma Import

Prisma에서 Stingerloom ORM으로 마이그레이션하는 경우, **Prisma Import** 도구가 `schema.prisma` 파일을 자동으로 데코레이터 기반 엔티티 `.ts` 파일로 변환해 줍니다. 지루한 수동 변환 작업을 없애 줍니다.

## 설치

이 도구는 피어 의존성으로 `@mrleebo/prisma-ast`가 필요합니다:

::: code-group

```bash [npm]
npm install -D @mrleebo/prisma-ast
```

```bash [pnpm]
pnpm add -D @mrleebo/prisma-ast
```

```bash [yarn]
yarn add -D @mrleebo/prisma-ast
```

:::

## CLI 사용법

```bash
npx stingerloom-prisma-import --schema ./prisma/schema.prisma --output ./src/entities/
```

### 옵션

| 옵션 | 별칭 | 설명 |
|------|------|------|
| `--schema` | `-s` | Prisma 스키마 파일 경로 (필수) |
| `--output` | `-o` | 생성된 파일을 둘 출력 디렉터리 (필수) |
| `--force` | `-f` | 기존 파일을 덮어쓰기 |
| `--provider` | `-p` | 데이터베이스 프로바이더 강제 지정 (`postgresql`, `mysql`, `sqlite`) |

### 예제

`./prisma/schema.prisma`에 Prisma 스키마가 있다고 할 때:

```bash
npx stingerloom-prisma-import -s ./prisma/schema.prisma -o ./src/entities/ --force
```

출력:

```
Generated files:
  + src/entities/role.enum.ts
  + src/entities/user.entity.ts
  + src/entities/post.entity.ts
  + src/entities/tag.entity.ts
  + src/entities/index.ts

Done! 5 file(s) written, 0 skipped.
```

## 프로그램 방식 사용

라이브러리로도 사용할 수 있습니다:

```typescript
import { PrismaImporter } from "@stingerloom/orm/prisma-import";

const importer = new PrismaImporter();

// 디스크에 파일 작성
const result = await importer.import({
  schemaPath: "./prisma/schema.prisma",
  outputDir: "./src/entities/",
  force: true,
});

console.log(`Generated ${result.written.length} files`);
console.log("Warnings:", result.warnings);
```

테스트나 디스크 I/O 없이 코드만 생성할 때:

```typescript
import { PrismaImporter } from "@stingerloom/orm/prisma-import";

const importer = new PrismaImporter();
const files: Map<string, string> = importer.generate(schemaSource);

for (const [filename, content] of files) {
  console.log(filename, content);
}
```

## 변환 예제

### 입력: `schema.prisma`

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

### 출력: `role.enum.ts`

```typescript
export enum Role {
  ADMIN = "ADMIN",
  USER = "USER",
  MODERATOR = "MODERATOR",
}
```

### 출력: `user.entity.ts`

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

### 출력: `post.entity.ts`

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

### 출력: `tag.entity.ts`

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

## 타입 매핑

### 기본 타입

| Prisma 타입 | `@db.*` 힌트 | Stingerloom `ColumnType` |
|-------------|--------------|--------------------------|
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
| Enum 이름 | — | `enum` |

### 특수 매핑

| Prisma 패턴 | Stingerloom 데코레이터 |
|------------|----------------------|
| `@id @default(autoincrement())` | `@PrimaryGeneratedColumn()` |
| `@id @default(uuid())` | `@PrimaryGeneratedColumn("uuid")` (UUIDv4, Prisma와 동일한 의미) |
| `@id @default(cuid())` | `@PrimaryColumn({ type: "varchar", length: 36 })` + NOTE 주석 — cuid는 ORM 생성 전략이 없으므로 INSERT 전에 애플리케이션 코드에서 id를 직접 할당해야 합니다 |
| `@default(now())` | `@CreateTimestamp()` |
| `@updatedAt` | `@UpdateTimestamp()` |
| `@default(value)` | `@Column({ default: value })` |
| `@@id([a, b])` | 각 필드에 `@PrimaryColumn()` |

## 관계 매핑

| Prisma 패턴 | Stingerloom |
|------------|-------------|
| `author User @relation(fields:[authorId])` | `@ManyToOne(() => User, ...)` |
| `posts Post[]` (위의 역방향) | `@OneToMany(() => Post, { mappedBy: "author" })` |
| `profile Profile?` + `@unique` FK | `@OneToOne(() => Profile, ...)` |
| `tags Tag[]` + `posts Post[]` (암시적 M:N) | `joinTable` / `mappedBy`를 사용한 `@ManyToMany` |

### 암시적 다대다

관계 양쪽이 모두 명시적인 `fields`/`references` 없이 리스트 타입이면 Prisma는 이를 암시적 다대다로 처리합니다. 임포터는 다음을 생성합니다:

- **소유 측면** (알파벳순 첫 모델): `joinTable`을 가진 `@ManyToMany`
- **역방향**: `mappedBy`를 가진 `@ManyToMany`
- **조인 테이블명**: 알파벳 순으로 snake_case의 `{model_a}_{model_b}`

### 캐스케이드

Prisma의 `onDelete: Cascade`는 생성된 데코레이터 옵션의 `cascade: ["delete"]`로 매핑됩니다.

## 엣지 케이스

| Prisma 기능 | 처리 방식 |
|------------|---------|
| `@@map("table_name")` | `@Entity({ name: "table_name" })` |
| `@map("col_name")` | `@Column({ name: "col_name" })` |
| `@@unique([a, b])` | `@UniqueIndex(["a", "b"])` |
| `@@id([a, b])` | 각 필드에 `@PrimaryColumn()` |
| `@id`의 `@default(uuid())` | `@PrimaryGeneratedColumn("uuid")` |
| `@default(cuid())` / 비-id 컬럼의 함수 기본값 | 일반 컬럼 유지 + NOTE 주석 (조용히 탈락시키지 않음) — 값은 애플리케이션 코드에서 생성합니다 |
| `Unsupported("...")` | 경고와 함께 건너뜀 |
| 자기 참조 관계 | 같은 클래스 참조 (예: `() => Category`) |
| 명명된 관계 `@relation("name")` | 짝짓기에만 사용, 출력에는 표시되지 않음 |

## 생성 파일 구조

```
src/entities/
├── role.enum.ts          # enum Role { ... }
├── user.entity.ts        # export class User { ... }
├── post.entity.ts        # export class Post { ... }
├── tag.entity.ts         # export class Tag { ... }
└── index.ts              # 배럴 재내보내기
```

- 엔티티 파일: `{snake_case_model}.entity.ts`
- 열거형 파일: `{snake_case_enum}.enum.ts`
- 배럴: 생성된 모든 파일에 대해 `export *`를 가진 `index.ts`

## 임포트 후

생성된 엔티티는 Stingerloom ORM과 함께 즉시 사용할 준비가 됩니다. 출력을 검토하고 필요한 부분을 조정하세요:

1. **관계 검증** — 복잡하거나 모호한 관계는 수동 조정이 필요할 수 있습니다
2. **생명주기 훅 추가** — 필요하다면 `@BeforeInsert`, `@BeforeUpdate`
3. **유효성 검사 추가** — 비즈니스 규칙을 위한 `@Validation` 데코레이터
4. **엔티티 등록** — `DatabaseClient`나 `StingerloomOrmModule.forRoot()`에 전달

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
