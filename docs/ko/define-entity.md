# 엔티티 정의하기

Stingerloom이 엔티티를 정의하는 권장 방식은 **코드 우선(code-first) 빌더 API**예요: `defineEntity`와 `t` 필드 빌더를 함께 쓰는 방식이죠. 선언을 한 번만 작성하면, 엔티티의 TypeScript 타입은 **스키마에서 추론돼요** — 손으로 쓴 클래스도, 별도의 인터페이스도, `experimentalDecorators`도, `emitDecoratorMetadata`도, 빌드 타임 코드 생성도 필요 없어요.

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

`User`는 실제 런타임 클래스예요 — ORM이 엔티티를 기대하는 모든 곳(`em.getRepository(User)`, `em.findOne(User, …)`, 관계 타깃)에서 그대로 쓰면 돼요. `InferEntity<typeof User>`는 행(row) 타입을 복원하므로, 같은 이름이 타입 역할도 겸해요.

::: tip 데코레이터가 더 좋다면?
데코레이터 API(`@Entity`, `@Column`, …)도 완전히 지원되고 동일한 메타데이터를 생성해요 — [엔티티 & 컬럼 (데코레이터)](./entities.md)를 참고하세요. 두 스타일은 같은 프로젝트에서 자유롭게 함께 쓸 수 있어요. 이 페이지는 새 코드에 권장하는 기본 방식이에요.
:::

## 왜 코드 우선인가

- **단일 진실 공급원(single source of truth).** 컬럼 빌더가 데이터베이스 타입*과* TypeScript 타입을 동시에 고정해요. `t.int()`는 `number`이고, 실수로 `string`으로 표기할 수 없어요. 손으로 쓴 클래스와 별도 스키마를 쓰면 이 둘이 조용히 어긋날 수 있죠.
- **타입 추론, 코드 생성 없음.** `InferEntity`가 빌더를 직접 읽어요. 생성 단계도, 감시(watch) 프로세스도 없고, 스키마를 편집하는 즉시 타입이 갱신돼요.
- **데코레이터 툴체인 불필요.** `experimentalDecorators` / `emitDecoratorMetadata` 없이도 strict 모드와 ESM에서 esbuild, swc, Vite, Bun과 함께 동작해요. 잘못 설정할 게 없어요.

## `t` 빌더

모든 필드는 `t` 네임스페이스의 호출이에요. 컬럼 빌더는 추론된 타입을 들고 다니고, 체이닝된 수정자(modifier)가 그 타입을 다듬어요(`.nullable()`은 타입을 `T | null`로 넓혀요).

### 컬럼 타입

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

### 수정자(Modifier)

수정자는 어떤 순서로든 체이닝할 수 있고, 각각 새 빌더를 반환해요.

| Modifier | 효과 |
| --- | --- |
| `.primary()` | (복합) 기본 키의 일부로 표시해요. |
| `.generated(strategy?)` | DB 생성 키: `"increment"`(기본값), `"uuid"`, `"uuid-v7"`. `.primary()`와 함께 쓰세요. |
| `.nullable()` | `NULL`을 허용하고, 추론된 타입을 `T \| null`로 넓혀요. |
| `.unique(name?)` | 단일 컬럼 고유 인덱스. |
| `.index()` | 단일 컬럼 인덱스. |
| `.default(value)` | 컬럼 기본값. |
| `.name(dbName)` | 데이터베이스 컬럼 이름을 재정의해요(기본값: 프로퍼티 키). |
| `.length(n)` / `.precision(n)` / `.scale(n)` | 크기 / 숫자 정밀도. |
| `.transformer({ to, from })` | 양방향 값 트랜스포머. |
| `.createTimestamp()` / `.updateTimestamp()` | 자동 설정 타임스탬프. |
| `.deletedAt()` | 소프트 삭제 마커(nullable을 함의). |
| `.version()` | 낙관적 잠금 버전 컬럼. |
| `.validate([...])` | 인라인 검증 제약. |
| `.enumName(name)` | PostgreSQL `ENUM` 타입의 이름을 지정해요. |
| `.jsonIndex(opts)` | JSON/JSONB 표현식 인덱스. |
| `.tenant()` | 테넌트 구분 컬럼. |

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

## 관계

관계 빌더는 지연(lazy) `() => TargetEntity`를 받아요(순환 참조를 허용하기 위해 지연이에요). `manyToOne` / `oneToOne`은 관련 행 타입을 추론하고, `oneToMany` / `manyToMany`는 배열을 추론해요. 관계 필드는 추론된 타입에서 **선택적(optional)** 이에요 — `relations: [...]`로 요청할 때만 채워지거든요.

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

::: warning 외래 키 컬럼을 선언하세요
`manyToOne` / 소유 측 `oneToOne`은 외래 키 컬럼을 실제 컬럼으로 선언해야(예: `authorId: t.int().name("author_id")`) 스키마 동기화 때 생성돼요 — 데코레이터 API가 FK를 위해 `@ManyToOne`을 `@Column`/`@RelationColumn`과 짝지우는 것과 똑같아요. 그러면 관계의 `joinColumn`이 그 컬럼을 가리켜요. (또는 관계 옵션에 `relationColumn: { … }`를 전달해도 돼요.)
:::

| Builder | 시그니처 | 추론된 필드 |
| --- | --- | --- |
| `t.manyToOne` | `(() => Target, options?)` | `Target?` |
| `t.oneToMany` | `(() => Target, mappedBy, options?)` | `Target[]?` |
| `t.oneToOne` | `(() => Target, options?)` | `Target?` |
| `t.manyToMany` | `(() => Target, options?)` | `Target[]?` |

## 계산 컬럼

`t.computed`는 데이터베이스가 생성하는 컬럼을 선언해요(`INSERT`/`UPDATE`에서 제외돼요):

```typescript
export const Person = defineEntity("people", {
  id:        t.int().primary().generated(),
  firstName: t.varchar(80).name("first_name"),
  lastName:  t.varchar(80).name("last_name"),
  fullName:  t.computed("first_name || ' ' || last_name", { stored: false, type: "varchar" }),
});
```

## 엔티티 등록 및 사용

데코레이터 클래스와 똑같이 엔티티 클래스를 `EntityManager`에 전달하세요:

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
ORM 코어는 런타임에 여전히 `reflect-metadata`를 사용하므로, 진입점에 `import "reflect-metadata"`를 유지하세요. 코드 우선 엔티티에서 *필요 없는* 것은 `experimentalDecorators`와 `emitDecoratorMetadata` 컴파일러 옵션이에요.
:::

## 고급 옵션

`defineEntity`는 덜 흔한 엔티티 수준 설정을 위해 선택적 세 번째 인수를 받아요:

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

전체 데코레이터 → 빌더 매핑(전문 검색 인덱스, 테넌트 컬럼, 라이프사이클 훅 포함)은 [데코레이터 없이 사용하기](./decorator-free.md)를 참고하세요.

## 데코레이터와 섞어 쓰기

코드 우선 엔티티와 데코레이터 엔티티는 같은 메타데이터 파이프라인을 공유하므로, 공존할 수 있고 서로 관계를 맺을 수도 있어요:

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

빌더 API는 점진적으로 도입하세요 — 새 엔티티는 코드 우선으로, 기존 데코레이터 엔티티는 손대지 않고요.
