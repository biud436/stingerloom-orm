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
데코레이터 API(`@Entity`, `@Column`, …)도 완전히 지원되고 동일한 메타데이터를 생성해요 — [엔티티 & 컬럼 (데코레이터)](./entities.md)를 참고하세요. 두 스타일은 같은 프로젝트에서 자유롭게 함께 쓸 수 있어요. 이 페이지는 새 코드에 권장하는 기본 방식이고, 데코레이터 가이드와 **같은 범위**를 다뤄요: 데코레이터로 표현할 수 있는 모든 기능에 대응하는 빌더가 여기 있어요.
:::

## 왜 코드 우선인가

ORM 없이는 테이블을 서너 번 기술해야 해요: `CREATE TABLE`, `INSERT`, `SELECT`, 그리고 TypeScript 타입. 컬럼을 하나 추가하면 그 모두를 수정하죠. 데코레이터 ORM은 이걸 클래스 하나로 줄이지만, 프로퍼티 타입을 읽기 위해 `emitDecoratorMetadata` 컴파일러 플래그에 의존해요 — esbuild, SWC, Vite의 기본 트랜스포머, TypeScript 5의 *표준* 데코레이터가 내보내지 않는 플래그죠. 메타데이터가 없으면 `@Column()`은 조용히 타입을 잃어요.

`defineEntity`는 그 의존성을 완전히 없애요:

- **단일 진실 공급원(single source of truth).** 컬럼 빌더가 데이터베이스 타입*과* TypeScript 타입을 동시에 고정해요. `t.int()`는 `number`이고, 실수로 `string`으로 표기할 수 없어요. 손으로 쓴 클래스와 별도 스키마를 쓰면 이 둘이 조용히 어긋날 수 있죠.
- **타입 추론, 코드 생성 없음.** `InferEntity`가 빌더를 직접 읽어요. 생성 단계도, 감시(watch) 프로세스도 없고, 스키마를 편집하는 즉시 타입이 갱신돼요.
- **데코레이터 툴체인 불필요.** strict 모드와 ESM에서 esbuild, swc, Vite, Bun과 함께 `experimentalDecorators` / `emitDecoratorMetadata` 없이 동작해요. 잘못 설정할 게 없어요.

내부적으로 `defineEntity`는 빌더를 데코레이터가 등록하는 것과 정확히 같은 메타데이터로 변환한 뒤, `EntitySchema` 브리지에 넘겨요. 그래서 나머지 ORM — EntityManager, SchemaGenerator, QueryBuilder, WriteBuffer — 은 빌더 엔티티와 데코레이터 엔티티, 손으로 쓴 `EntitySchema`를 구분하지 못해요.

## 첫 번째 엔티티 만들기

사용자를 저장한다고 가정해 볼게요. 가장 간단한 엔티티는 두 컬럼이에요:

```typescript
// user.entity.ts
import { defineEntity, t, InferEntity } from "@stingerloom/orm";

export const User = defineEntity("users", {
  id:   t.int().primary().generated(),
  name: t.varchar(255),
});

export type User = InferEntity<typeof User>; // { id: number; name: string }
```

첫 번째 인자(`"users"`)는 테이블 이름이에요. 이것만으로 Stingerloom은 자동 증가 기본 키와 `VARCHAR(255)` `name` 컬럼을 가진 `users` 테이블을 생성해요. 다음은 그 정확한 DDL이에요.

**PostgreSQL:**

```sql
CREATE TABLE "users" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL
);
```

**MySQL:**

```sql
CREATE TABLE `users` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255) NOT NULL,
  PRIMARY KEY (`id`)
);
```

PostgreSQL은 큰따옴표와 `SERIAL`을, MySQL은 백틱과 `AUTO_INCREMENT`를 써요. 엔티티를 한 번만 작성하면 둘 다에서 — 그리고 키가 `INTEGER PRIMARY KEY AUTOINCREMENT`가 되는 SQLite에서도 — 동작해요.

세 부분이 일을 하고 있어요:

- **`defineEntity("users", { … })`** 는 엔티티와 테이블 이름을 선언해요. (테이블 이름이 첫 번째 인자와 달라야 하면 세 번째 옵션 인자의 `tableName`으로 전달하세요 — [고급 엔티티 옵션](#고급-엔티티-옵션)을 참고하세요.)
- **`t.int().primary().generated()`** 는 자동 증가 기본 키예요. `.primary()`는 PK로 표시하고, `.generated()`는 INSERT 시 데이터베이스가 1, 2, 3…을 채우게 해요. SQL 수준에서는 `SERIAL PRIMARY KEY`(PostgreSQL) 또는 `INT AUTO_INCREMENT PRIMARY KEY`(MySQL)예요.
- **`t.varchar(255)`** 는 일반 `VARCHAR(255)` 컬럼이에요. 빌더가 TypeScript 타입을 `string`으로 고정하므로 직접 표기할 필요가 없어요.

```sql
-- 작성:
await em.save(User, { name: "Alice" });
-- 생성된 SQL (DB가 id = 1을 자동으로 채워요):
INSERT INTO "users" ("name") VALUES ('Alice');
```

## `t` 빌더

모든 필드는 `t` 네임스페이스의 호출이에요. 컬럼 빌더는 추론된 타입을 지니고, 체이닝된 수정자가 이를 다듬어요(`.nullable()`은 타입을 `T | null`로 넓혀요).

### 컬럼 타입

| 빌더 | TypeScript 타입 | 추상 컬럼 타입 |
| --- | --- | --- |
| `t.int()` / `t.integer()` | `number` | `int` |
| `t.bigint()` | `number` | `bigint` |
| `t.float()` / `t.double()` | `number` | `float` / `double` |
| `t.number()` | `number` | `number` |
| `t.decimal(precision?, scale?)` | `number` | `number` |
| `t.varchar(length?)` | `string` | `varchar` |
| `t.char(length?)` | `string` | `char` |
| `t.text()` / `t.longtext()` | `string` | `text` / `longtext` |
| `t.uuid()` | `string` | `uuid` |
| `t.boolean()` | `boolean` | `boolean` |
| `t.datetime()` / `t.timestamp()` / `t.timestamptz()` / `t.date()` | `Date` | 해당 시간 타입 |
| `t.blob()` | `Buffer` | `blob` |
| `t.json<T>()` / `t.jsonb<T>()` | `T` (기본 `unknown`) | `json` / `jsonb` |
| `t.array<T>()` | `T[]` | `array` |
| `t.enum(["a", "b"])` | `"a" \| "b"` | `enum` |

여러 타입을 섞은 현실적인 예와 그것이 추론하는 타입:

```typescript
export const Product = defineEntity("products", {
  id:          t.int().primary().generated(),
  name:        t.varchar(255),       // VARCHAR(255), 필수
  description: t.text(),             // TEXT (255자가 아니라 메가바이트)
  price:       t.float(),           // FLOAT / REAL
  isAvailable: t.boolean(),         // TINYINT(1) / BOOLEAN
  releaseDate: t.datetime(),        // DATETIME / TIMESTAMP
  payload:     t.jsonb<{ kind: string; data: unknown }>(),
  tags:        t.array<string>(),
  level:       t.enum(["info", "warn", "error"]).default("info"),
});
// InferEntity<typeof Product> →
//   { id: number; name: string; description: string; price: number;
//     isAvailable: boolean; releaseDate: Date;
//     payload: { kind: string; data: unknown }; tags: string[];
//     level: "info" | "warn" | "error" }
```

`VARCHAR(255)`는 255자에서 잘리고, `TEXT`는 메가바이트를 저장해요. 의도에 맞는 빌더를 고르세요 — TypeScript에서는 둘 다 `string`이지만 매우 다른 컬럼이에요. 전체 드라이버별 매핑은 [ColumnType 참조](#columntype-참조)를 확인하세요.

## 컬럼 수정자

수정자는 어떤 순서로든 체이닝할 수 있고, 각 호출은 새 빌더를 반환해요. nullable을 바꾸는 수정자는 추론된 타입도 함께 다듬어요.

| 수정자 | 효과 |
| --- | --- |
| `.primary()` | 기본 키(의 일부)로 표시해요. |
| `.generated(strategy?)` | DB 생성 키: `"increment"`(기본), `"uuid"`, `"uuid-v7"`. `.primary()`와 함께 쓰세요. |
| `.nullable()` | `NULL`을 허용하고, 추론 타입을 `T \| null`로 넓혀요. |
| `.unique(name?)` | 단일 컬럼 고유 인덱스. |
| `.index()` | 단일 컬럼 인덱스. |
| `.default(value)` | 컬럼 기본값. |
| `.name(dbName)` | 데이터베이스 컬럼 이름 재정의(기본: 프로퍼티 키). |
| `.length(n)` / `.precision(n)` / `.scale(n)` | 크기 / 숫자 정밀도. |
| `.transformer({ to, from })` | 양방향 값 트랜스포머. |
| `.createTimestamp()` / `.updateTimestamp()` | 자동 설정 타임스탬프. |
| `.deletedAt()` | 소프트 삭제 마커(nullable 함의). |
| `.version()` | 낙관적 잠금 버전 컬럼. |
| `.validate([...])` | 인라인 검증 제약. |
| `.enumName(name)` | PostgreSQL `ENUM` 타입 이름 지정. |
| `.jsonIndex(opts)` | JSON/JSONB 표현식 인덱스. |
| `.tenant()` | 테넌트 식별자 컬럼. |

### 길이

`t.varchar(100)`은 길이를 인라인으로 설정하고, `.length(100)`은 사후에 같은 일을 해요. 둘 다 `VARCHAR(100)`을 렌더링하고, 데이터베이스는 길이를 초과한 INSERT를 거부해요.

```typescript
sku: t.varchar(100),           // VARCHAR(100)
sku2: t.varchar().length(100), // 동일
```

### NULL 허용

모든 컬럼은 기본적으로 `NOT NULL`이에요. `.nullable()`은 그 제약을 없애고 **동시에** 추론 타입을 `T | null`로 넓혀서, 타입과 스키마가 함께 가도록 해요:

```typescript
bio: t.varchar(255).nullable(), // VARCHAR(255), NOT NULL 없음 → bio: string | null
```

### 컬럼 이름 별칭

프로퍼티 이름과 DB 컬럼이 달라야 할 때 `.name()`을 쓰세요 — 흔한 경우는 TypeScript는 camelCase, 데이터베이스는 snake_case죠:

```typescript
price: t.float().name("unit_price"),
// 엔티티 프로퍼티: product.price / DB 컬럼: unit_price
```

DDL에서는 컬럼 이름이 `unit_price`가 되고, SELECT 시 Stingerloom이 `unit_price`를 `price`로 다시 매핑해요. (프로젝트 전반의 규칙을 원하면 [`SnakeNamingStrategy`](./configuration.md)를 등록하고 컬럼별 `.name()` 호출을 빼면 돼요.)

### 기본값

`.default(value)`는 컬럼 기본값을 설정해요. 리터럴 문자열·숫자·불리언은 그대로 쓰이고, 원시 SQL 표현식(함수 호출)을 내보내려면 괄호로 감싸세요.

```typescript
status:     t.varchar(255).default("active"),
retryCount: t.int().default(0),
isVisible:  t.boolean().default(true),
createdAt:  t.datetime().default("(CURRENT_TIMESTAMP)"),
```

**PostgreSQL:**

```sql
"status" VARCHAR(255) NOT NULL DEFAULT 'active',
"retryCount" INTEGER NOT NULL DEFAULT 0,
"isVisible" BOOLEAN NOT NULL DEFAULT TRUE,
"createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
```

괄호가 없으면 `"CURRENT_TIMESTAMP"`는 SQL 함수가 아니라 리터럴 문자열 `'CURRENT_TIMESTAMP'`로 내보내져요.

### JSON 컬럼

`t.json<T>()`와 `t.jsonb<T>()`는 구조화된 데이터를 한 컬럼에 저장하고, 타입 인자가 추론된 행 타입으로 그대로 흘러가요:

```typescript
settings: t.json<{ theme: string }>().nullable(),
// settings: { theme: string } | null
```

PostgreSQL에서 `jsonb`는 분해된 바이너리 형식으로 저장돼요 — 쓰기는 느리지만 쿼리는 훨씬 빠르고, `WHERE settings->>'theme' = 'dark'`처럼 인덱싱할 수 있는 유일한 형식이죠. 문서 내부를 쿼리한다면 언제나 `jsonb`를 택하세요.

Stingerloom은 `json`/`jsonb` 컬럼에 기본 왕복 변환을 설치해요: 쓰기 시 문자열이 아닌 값은 드라이버에 닿기 전에 `JSON.stringify`되고, 읽기 시 드라이버가 반환한 문자열은 `JSON.parse`돼요. 그래서 평범한 JS 값을 직접 할당하면 돼요:

```typescript
await em.save(Issue, { customFields: { priority: "high", labels: ["bug"] } });
const issue = await em.findOne(Issue, { where: { id } });
issue!.customFields.priority; // "high" — 이미 객체, 방언 독립적
```

명시적인 [`.transformer()`](#트랜스포머)를 주면 해당 방향의 기본 변환을 덮어써요.

### PostgreSQL ENUM

`t.enum([...])`은 리터럴 유니온 타입을 고정**하고** 허용 값을 데이터베이스로 전달해요. 생성되는 PostgreSQL 타입의 이름은 `.enumName()`으로 지정해요:

```typescript
status: t.enum(["draft", "published", "archived"]).enumName("post_status"),
// status: "draft" | "published" | "archived"
```

PostgreSQL DDL:

```sql
CREATE TYPE "post_status" AS ENUM ('draft', 'published', 'archived');
-- ...
"status" "post_status" NOT NULL
```

`.enumName()`을 생략하면 이름은 `{tableName}_{columnName}_enum`이 돼요. MySQL에서는 컬럼이 네이티브 `ENUM(...)`이 되고, SQLite에서는 `TEXT`로 저장돼요.

## 기본 키

### 생성 키

`.primary().generated(strategy)`는 데이터베이스 생성 키를 만들어요. 전략이 방식을 정해요:

```typescript
id: t.int().primary().generated(),              // 자동 증가 (기본 "increment")
id: t.uuid().primary().generated("uuid"),       // 랜덤 UUIDv4
id: t.uuid().primary().generated("uuid-v7"),    // 시간 정렬 가능한 UUIDv7
```

`"increment"`는 `SERIAL`(PostgreSQL) / `AUTO_INCREMENT`(MySQL)에 대응해요. `"uuid"`와 `"uuid-v7"`은 INSERT 전 애플리케이션 코드에서 값을 생성하고 — `"uuid-v7"`은 시간순이라 랜덤 UUID보다 기본 키 인덱스에 훨씬 유리해요.

### 수동 기본 키

`.generated()`를 빼면 직접 값을 공급하는 키가 돼요 — `@PrimaryColumn()`의 빌더 대응이죠. config 테이블 같은 자연 키에 유용해요:

```typescript
export const Config = defineEntity("config", {
  key:   t.varchar(64).primary(),
  value: t.text(),
});

await em.save(Config, { key: "site.title", value: "My Blog" });
// INSERT INTO "config" ("key", "value") VALUES ('site.title', 'My Blog')
```

### 복합 기본 키

둘 이상의 컬럼을 `.primary()`로 표시하면 복합 키가 돼요:

```typescript
export const Enrollment = defineEntity("enrollments", {
  studentId: t.int().primary().name("student_id"),
  courseId:  t.int().primary().name("course_id"),
  grade:     t.varchar(2).nullable(),
});
```

```sql
CREATE TABLE "enrollments" (
  "student_id" INTEGER NOT NULL,
  "course_id" INTEGER NOT NULL,
  "grade" VARCHAR(2),
  PRIMARY KEY ("student_id", "course_id")
);
```

## 트랜스포머

트랜스포머는 값을 **양방향**으로 번역해요: `to`는 모든 INSERT/UPDATE 전에, `from`은 모든 SELECT 후에 실행돼요. 대표적인 용도는 이메일을 소문자로 정규화해서 `Alice@Example.com`과 `alice@example.com`이 둘 다 존재하지 않게 하는 거예요:

```typescript
export const Account = defineEntity("accounts", {
  id:    t.int().primary().generated(),
  email: t.varchar(255).unique().transformer({
    to:   (value: string) => value.toLowerCase(), // 엔티티 → DB (쓰기)
    from: (value: string) => value,               // DB → 엔티티 (읽기)
  }),
});

await em.save(Account, { email: "Alice@Example.COM" });
// INSERT INTO "accounts" ("email") VALUES ('alice@example.com')
```

암호화도 같은 모양이에요 — `to`에서 암호화, `from`에서 복호화 — 그래서 데이터베이스에는 항상 암호문만 저장되고 코드는 평문으로 작업해요:

```typescript
ssn: t.text().transformer({
  to:   (value: string) => encrypt(value),
  from: (value: string) => decrypt(value),
}),
```

## 인덱스

### 단일 컬럼 인덱스

`.index()`는 비고유 인덱스를, `.unique()`는 고유 인덱스를 추가해요. 둘 다 해당 컬럼의 `WHERE`/`JOIN`/`ORDER BY`에서 전체 테이블 스캔을 O(log n) B-tree 조회로 바꿔요:

```typescript
export const User = defineEntity("users", {
  id:    t.int().primary().generated(),
  email: t.varchar(255).index(),   // CREATE INDEX ... ON "users" ("email")
  slug:  t.varchar(255).unique(),  // 단일 컬럼 UNIQUE 인덱스
});
```

```sql
CREATE INDEX "INDEX_users_email" ON "users" ("email");
```

`.unique()` 제약은 엔티티의 고유 인덱스 목록으로 올려지므로, 옵션 객체에 선언하는 복합 고유 인덱스와 함께 구성돼요.

### 복합 및 고유 인덱스

다중 컬럼 인덱스는 세 번째 옵션 인자에 들어가요. `indexes`는 비고유, `uniqueIndexes`는 조합에 대한 고유성을 강제해요:

```typescript
export const Order = defineEntity(
  "orders",
  {
    id:       t.int().primary().generated(),
    tenantId: t.int().name("tenant_id"),
    status:   t.varchar(50),
    slug:     t.varchar(120),
  },
  {
    indexes:       [{ columns: ["tenant_id", "status"] }],
    uniqueIndexes: [{ columns: ["tenant_id", "slug"], name: "uq_order_slug" }],
  },
);
```

```sql
CREATE INDEX "idx_orders_tenant_id_status" ON "orders" ("tenant_id", "status");
CREATE UNIQUE INDEX "uq_order_slug" ON "orders" ("tenant_id", "slug");
```

복합 인덱스는 성(姓)으로 먼저 정렬한 뒤 이름으로 정렬한 전화번호부처럼 왼쪽부터 동작해요: `WHERE tenant_id = 5`와 `WHERE tenant_id = 5 AND status = 'pending'`에는 쓰이지만, `WHERE status = 'pending'` 단독에는 쓰이지 않아요.

### 고급 인덱스 옵션

각 `indexes` 항목은 `options` 객체를 받는데, 데코레이터의 `@Index([cols], options)`가 받는 것과 같은 `AdvancedIndexOptions`예요 — 부분(partial), 표현식, `USING`, 커버링(`INCLUDE`) 인덱스죠:

```typescript
export const User = defineEntity(
  "users",
  {
    id:        t.int().primary().generated(),
    email:     t.varchar(255),
    name:      t.varchar(255),
    metadata:  t.jsonb(),
    deletedAt: t.datetime().deletedAt(),
  },
  {
    indexes: [
      // 부분 커버링 인덱스 (WHERE는 PostgreSQL / SQLite, INCLUDE는 PG)
      {
        columns: ["email"],
        options: {
          name: "idx_active_user_email",
          where: "deleted_at IS NULL", // 부분 — 소프트 삭제 행 제외
          include: ["name"],           // 커버링 — index-only 스캔
        },
      },
      // 표현식 인덱스 — 컬럼 목록은 비우고 표현식이 대체
      { columns: [], options: { name: "idx_lower_email", expression: "LOWER(email)" } },
      // JSONB 포함(containment) 쿼리용 GIN 인덱스
      { columns: ["metadata"], options: { using: "gin" } },
    ],
  },
);
```

```sql
CREATE INDEX "idx_active_user_email" ON "users" ("email") INCLUDE ("name") WHERE deleted_at IS NULL;
CREATE INDEX "idx_lower_email" ON "users" ((LOWER(email)));
CREATE INDEX "idx_users_metadata" ON "users" USING gin ("metadata");
```

| `using` 값 | 적합한 용도 | PostgreSQL | MySQL |
| --- | --- | --- | --- |
| `btree` | 동등·범위·정렬 (기본) | Yes | Yes |
| `hash` | 동등만 | Yes | Yes |
| `gin` | JSONB, 배열, 전문 검색 | Yes | No |
| `gist` | 기하, 범위 타입 | Yes | No |
| `brin` | 대용량 시계열 테이블 | Yes | No |

부분(`where`), 커버링(`include`), 비-btree `using`은 PostgreSQL 기능이에요(부분 인덱스는 SQLite에서도 동작). MySQL은 이를 무시하거나 거부해요. 옵션 객체는 동일하니 개념 설명은 데코레이터 가이드의 [고급 인덱스 옵션](./entities.md#고급-인덱스-옵션)을 참고하세요.

### 전문 인덱스

전문(full-text) 인덱스는 `fullTextIndexes`에 들어가요:

```typescript
export const Post = defineEntity(
  "posts",
  {
    id:      t.int().primary().generated(),
    title:   t.varchar(200),
    content: t.text(),
  },
  {
    fullTextIndexes: [
      { columns: ["title", "content"], name: "ft_post", language: "english" },
    ],
  },
);
```

PostgreSQL은 GIN `to_tsvector` 인덱스를, MySQL은 `FULLTEXT` 인덱스를 내보내요. SQLite는 no-op이에요.

### JSON 경로 인덱스

`.jsonIndex()`는 `jsonb` 컬럼 내부 경로에 대한 표현식 인덱스를 선언해요 — `@JsonIndex`의 빌더 형식이죠:

```typescript
profile: t.jsonb<{ tags: string[] }>().jsonIndex({
  path: "tags",
  using: "gin",
  opclass: "jsonb_path_ops",
}),
```

PostgreSQL DDL:

```sql
CREATE INDEX "idx_users_profile_tags_gin"
  ON "users" USING gin ((profile -> 'tags') jsonb_path_ops);
```

`path`는 점-대괄호 표기예요(`"contact.email"`, `"tags[0]"`). 생략하면 컬럼 전체를 인덱싱해요. `using: "btree"`는 동등/범위에 쓰는 단일 스칼라 리프에 적합해요. MySQL과 SQLite는 DDL을 내보내지 않아요(경고가 로깅됨). 전체 옵션은 [JSON 경로 인덱스](./entities.md#json-경로-인덱스-jsonindex)를, 이 인덱스와 맞물리는 연산자는 [쿼리 빌더 — JSON](./query-builder-json.md)을 참고하세요.

## 낙관적 잠금

`.version()`은 *손실된 업데이트(lost update)* 문제 — 두 작성자가 같은 행을 읽고 서로를 덮어쓰는 — 를 감지하는 버전 카운터를 추가해요. INSERT 시 버전이 1로 설정되고, UPDATE 시 Stingerloom이 `WHERE version = N`을 추가하고 값을 증가시켜요. 그 사이 행이 바뀌었으면 UPDATE는 0개 행에 매치되고, 데이터를 조용히 잃는 대신 `OptimisticLockError`가 던져져요.

```typescript
export const Order = defineEntity("orders", {
  id:      t.int().primary().generated(),
  status:  t.varchar(255),
  version: t.int().version(),
});
```

```sql
-- 작성자 A (버전 1 읽음) 성공, 버전은 2가 됨:
UPDATE "orders" SET "status" = 'shipped', "version" = "version" + 1
WHERE "id" = 1 AND "version" = 1;          -- 1개 행 영향

-- 작성자 B (역시 버전 1 읽음) 이제 실패:
UPDATE "orders" SET "status" = 'refunded', "version" = "version" + 1
WHERE "id" = 1 AND "version" = 1;          -- 0개 행 → OptimisticLockError
```

충돌이 드물지만 정확성이 중요한 곳(주문 상태, 재고)에 쓰세요. 경합이 심한 행에는 비관적 잠금(`SELECT … FOR UPDATE`)을 택하세요.

## 소프트 삭제

`.deletedAt()`은 삭제를 행 제거가 아니라 타임스탬프 표시로 바꿔요. `.nullable()`을 함의하므로(`NULL` 마커는 "삭제되지 않음"을 뜻함) 추론 타입은 `Date | null`이에요:

```typescript
export const Post = defineEntity("posts", {
  id:        t.int().primary().generated(),
  title:     t.varchar(255),
  deletedAt: t.datetime().deletedAt(), // deletedAt: Date | null
});
```

이 마커는 세 가지 동작을 바꿔요:

```typescript
await em.softDelete(Post, { id: 1 });
// UPDATE "posts" SET "deletedAt" = NOW() WHERE "id" = 1;   (DELETE 아님)

await em.find(Post);
// SELECT * FROM "posts" WHERE "deletedAt" IS NULL;          (자동 제외)

await em.find(Post, { withDeleted: true });
// SELECT * FROM "posts";                                    (삭제된 행 포함)

await em.restore(Post, { id: 1 });
// UPDATE "posts" SET "deletedAt" = NULL WHERE "id" = 1;     (복원)
```

## 자동 타임스탬프

`.createTimestamp()`와 `.updateTimestamp()`는 감사 타임스탬프를 대신 채워줘요. INSERT 시 둘 다 설정되고, UPDATE 시 갱신 타임스탬프만 새로 채워져요:

```typescript
export const Article = defineEntity("articles", {
  id:        t.int().primary().generated(),
  title:     t.varchar(255),
  createdAt: t.datetime().createTimestamp(),
  updatedAt: t.datetime().updateTimestamp(),
});
```

```sql
-- INSERT — 둘 다 같은 순간으로 설정 (앱 코드의 new Date()로 생성):
INSERT INTO "articles" ("title", "createdAt", "updatedAt")
VALUES ('Hello', '2026-06-30 10:30:00', '2026-06-30 10:30:00');

-- UPDATE — SET 절에는 updatedAt만:
UPDATE "articles" SET "title" = 'Hello v2', "updatedAt" = '2026-06-30 11:45:00'
WHERE "id" = 1;
```

`save()`에서 타임스탬프 컬럼에 명시적인 값을 주면 자동 생성 값 대신 그 값이 쓰여요 — 데이터 마이그레이션에 유용하죠. PostgreSQL에서 시간대 인식 컬럼이 필요하면 `t.timestamptz()`를 쓰세요.

## 계산 컬럼

`t.computed()`는 데이터베이스 수준의 생성 컬럼을 선언해요 — `@ComputedColumn`의 빌더 형식이죠. 값은 다른 컬럼으로부터 데이터베이스가 계산하고, **모든 INSERT와 UPDATE에서 제외돼요**(쓰려고 하면 오류). `GENERATED ALWAYS AS (expression)`으로 렌더링돼요:

```typescript
export const OrderLine = defineEntity("order_lines", {
  id:       t.int().primary().generated(),
  price:    t.float(),
  quantity: t.int(),
  total:    t.computed<number>("price * quantity", { stored: true, type: "float" }),
});
```

PostgreSQL DDL:

```sql
CREATE TABLE "order_lines" (
  "id" SERIAL PRIMARY KEY,
  "price" REAL NOT NULL,
  "quantity" INTEGER NOT NULL,
  "total" REAL GENERATED ALWAYS AS (price * quantity) STORED
);
```

```typescript
await em.save(OrderLine, { price: 29.99, quantity: 3 });
// INSERT INTO "order_lines" ("price", "quantity") VALUES (29.99, 3)
// "total"은 생략 — DB가 89.97로 계산
```

옵션은 `@ComputedColumn`을 그대로 따라요: `stored`, `type`, `length`, `nullable`.

| `stored` | 모드 | 동작 | 디스크 | 인덱스 가능 |
| --- | --- | --- | --- | --- |
| `true` | STORED | 쓰기 시 계산, 영속화 | 공간 사용 | 가능 |
| `false` (기본) | VIRTUAL | 읽기마다 계산 | 없음 | 제한적 |

### 다이얼렉트 독립 표현식

리터럴 문자열 표현식은 DDL에 그대로 박히므로, 대상 데이터베이스에 이미 유효한 SQL이어야 해요. `price * quantity` 같은 이식 가능한 산술에는 괜찮지만, 날짜 연산은 엔진마다 크게 갈려요. 대신 **빌더 함수**를 넘기면 Stingerloom이 연결당 한 번 방언에 맞는 SQL로 컴파일해요:

```typescript
export const Issue = defineEntity("issues", {
  id:          t.int().primary().generated(),
  createdAt:   t.datetime().nullable().name("created_at"),
  completedAt: t.datetime().nullable().name("completed_at"),
  cycleTimeHours: t.computed<number>(
    (e) => e.dateDiff(e.col("completed_at"), e.col("created_at"), "hour"),
    { type: "int", nullable: true },
  ),
});
```

```sql
-- MySQL
`cycleTimeHours` INT GENERATED ALWAYS AS (TIMESTAMPDIFF(HOUR, `created_at`, `completed_at`)) VIRTUAL
-- PostgreSQL
"cycleTimeHours" INTEGER GENERATED ALWAYS AS (EXTRACT(EPOCH FROM ("completed_at" - "created_at")) / 3600) VIRTUAL
```

컨텍스트 `e`는 전체 Expressions DSL(`e.iff`, `e.caseBuilder`, `e.coalesce`, `e.dateDiff`, `e.col(name)`)을 노출해요. 전체 DSL은 데코레이터 가이드의 [다이얼렉트 독립 표현식](./entities.md#다이얼렉트-독립-표현식-빌더-형식)을 참고하세요.

::: tip 계산 컬럼이 데이터베이스에 닿는 방식
`GENERATED ALWAYS AS` DDL은 스키마 **제너레이터** — 마이그레이션 CLI(`stingerloom migrate:generate`)가 쓰는 경로 — 가 내보내요. 런타임 `synchronize`의 테이블 생성 경로는 저장 컬럼만 렌더링해요. 이건 데코레이터 `@ComputedColumn`과 정확히 같아요: 계산 컬럼을 추가(또는 변경)하려면 마이그레이션을 생성하세요. 테이블이 어떻게 생성됐든 Stingerloom은 항상 그 컬럼을 쓰기에서 제외해요.
:::

## 검증

`.validate([...])`는 SQL이 빌드되기 **전에** 검사되는 애플리케이션 수준 제약을 붙여요 — `@NotNull`, `@MinLength`, `@Min` 등의 빌더 형식이죠. 실패하면 `ValidationError`가 던져지고 쿼리는 전송되지 않아요:

```typescript
export const Member = defineEntity("members", {
  id:   t.int().primary().generated(),
  name: t.varchar(50).validate([
    { constraint: "notNull" },
    { constraint: "minLength", value: 2 },
    { constraint: "maxLength", value: 50 },
  ]),
  age:  t.int().validate([
    { constraint: "min", value: 0 },
    { constraint: "max", value: 150 },
  ]),
});

await em.save(Member, { name: "A", age: -1 });
// ValidationError: name must be at least 2 characters long  (INSERT 시도 없음)
```

각 항목은 `{ constraint, value?, message? }`예요. 사용 가능한 제약은 `notNull`, `minLength`, `maxLength`, `min`, `max`이고, 커스텀 `message`로 기본 메시지를 덮어쓸 수 있어요. 데이터베이스 `NOT NULL` 위반(왕복 후 난해한 메시지로 드러남)과 달리, 검증은 명확한 메시지와 함께 프로세스 안에서 잡혀요.

## 생명주기 훅

훅은 엔티티 생명주기의 특정 순간에 커스텀 로직을 실행해요 — 삽입 전 슬러그 생성, 삽입 후 알림 전송, 삭제 전 정리 등이죠. 세 번째 옵션 인자에 선언하고, 각 이벤트는 함수(또는 클래스에 이미 있는 메서드의 이름)에 매핑돼요:

```typescript
export const Article = defineEntity(
  "articles",
  {
    id:    t.int().primary().generated(),
    title: t.varchar(200),
    slug:  t.varchar(200).nullable(),
  },
  {
    hooks: {
      beforeInsert(article) {
        article.slug ??= article.title.toLowerCase().replace(/\s+/g, "-");
      },
      afterInsert(article) {
        console.log(`Article #${article.id} created`);
      },
    },
  },
);
```

훅은 엔티티를 `this`로도, 첫 번째 인자로도 받아요. 그래서 `beforeInsert(a) { a.slug = … }`와 `beforeInsert() { this.slug = … }`는 동등해요.

::: warning 훅은 인스턴스에서 실행돼요 — `new Entity(...)`를 쓰세요
훅은 엔티티 프로토타입의 메서드라서, 저장하는 객체가 **그 프로토타입을 지닐 때만** 실행돼요. minted 클래스 생성자는 바로 이를 위해 부분 초기화 객체를 받아요: `new Article({ … })`는 타입이 잡힌, 훅을 가진 인스턴스를 줘요.

```typescript
// 훅 실행됨 — 저장 객체가 Article 인스턴스.
const saved = await em.save(Article, new Article({ title: "Hello World" }));
saved.slug; // "hello-world"

// 훅 실행 안 됨 — 평범한 객체 리터럴에는 프로토타입 메서드가 없음.
await em.save(Article, { title: "Hello World" });
```

이건 데코레이터 엔티티와 같은 요구사항이에요(`@BeforeInsert`도 인스턴스가 필요). `new Article({...})`는 `Object.assign(new Article(), {...})`의 데코레이터 없는, 타입이 검사되는 대응이죠.
:::

이벤트는 여섯 개이고, 해당 SQL 주변에서 실행돼요:

| 이벤트 | 시점 | 대표 용도 |
| --- | --- | --- |
| `beforeInsert` | INSERT 직전 | 기본값, 슬러그 생성, 정규화 |
| `afterInsert` | INSERT 후 (엔티티에 ID가 생김) | 로깅, 알림, 캐시 무효화 |
| `beforeUpdate` | UPDATE 직전 | 필드 재계산, 검증 |
| `afterUpdate` | UPDATE 후 | 변경 이력, 웹훅 |
| `beforeDelete` | DELETE 직전 | 정리, 권한 확인 |
| `afterDelete` | DELETE 후 | 관련 리소스 해제, 로깅 |

새 엔티티의 순서는: `beforeInsert` 훅 → `INSERT` → `afterInsert` 훅이에요. `before*` 훅에서의 변경은 SQL에 반영되고, `after*` 훅은 행이 쓰인 뒤 실행되므로 부수 효과에 쓰세요.

## 관계

관계 빌더는 지연 `() => TargetEntity`를 받아요(두 엔티티가 서로 참조할 수 있도록 지연). `manyToOne` / `oneToOne`은 관련 행 타입을, `oneToMany` / `manyToMany`는 배열을 추론해요. 관계 필드는 추론 타입에서 **선택적(optional)** 이에요 — `relations: [...]`로 요청할 때만 채워져요.

| 빌더 | 시그니처 | 추론 필드 |
| --- | --- | --- |
| `t.manyToOne` | `(() => Target, options?)` | `Target?` |
| `t.oneToMany` | `(() => Target, mappedBy, options?)` | `Target[]?` |
| `t.oneToOne` | `(() => Target, options?)` | `Target?` |
| `t.manyToMany` | `(() => Target, options?)` | `Target[]?` |

```typescript
export const Author = defineEntity("authors", {
  id:    t.int().primary().generated(),
  name:  t.varchar(120),
  posts: t.oneToMany(() => Post, "author"),
});

export const Post = defineEntity("posts", {
  id:       t.int().primary().generated(),
  title:    t.varchar(200),
  authorId: t.int().nullable().name("author_id"), // 물리적 FK 컬럼
  author:   t.manyToOne(() => Author, { joinColumn: "author_id" }),
  tags:     t.manyToMany(() => Tag, {
    joinTable: { name: "post_tags", joinColumn: "post_id", inverseJoinColumn: "tag_id" },
  }),
});

export const Tag = defineEntity("tags", {
  id:   t.int().primary().generated(),
  name: t.varchar(60).unique(),
});

export type Author = InferEntity<typeof Author>; // posts?: Post[]
export type Post = InferEntity<typeof Post>;     // author?: Author; tags?: Tag[]
```

::: warning 외래 키 컬럼을 선언하세요
`manyToOne` / 소유측 `oneToOne`은 외래 키 컬럼을 실제 컬럼(`authorId: t.int().name("author_id")`)으로 선언해야 스키마 동기화 시 생성돼요 — 데코레이터 API가 `@ManyToOne`에 FK용 `@Column`/`@RelationColumn`을 짝지우는 것과 똑같죠. 그러면 관계의 `joinColumn`이 그 컬럼을 가리켜요. 또는 관계 옵션에 `relationColumn: { … }`을 넘겨 FK 메타데이터를 인라인으로 선언할 수도 있어요.
:::

### 관계 옵션

`manyToOne`과 `oneToOne`은 데코레이터와 같은 로딩 및 참조 동작 옵션을 받아요:

```typescript
author: t.manyToOne(() => Author, {
  joinColumn: "author_id",
  references: "id",            // FK가 가리키는 대상 컬럼 (기본값: 대상의 PK)
  eager: true,                 // 항상 LEFT JOIN 하고 채움
  lazy: false,                 // true = 프로퍼티 첫 접근 시 Proxy 기반 지연 로딩
  cascade: ["insert", "update"],
  onDelete: "CASCADE",         // FK ON DELETE 동작
  onUpdate: "RESTRICT",
  createForeignKeyConstraints: true, // false = 관계는 유지하되 FK DDL은 생략
  relationColumn: {            // 명시적 FK 컬럼 메타데이터 (@RelationColumn 식)
    name: "author_id",
    type: "bigint",
    nullable: false,
    referencedColumn: "id",
  },
}),
```

몇 가지는 짚고 넘어갈게요:

- `references`는 FK가 대상의 기본 키가 아닌 다른 컬럼(예: `uuid` 컬럼)을 가리키게 해요 — 같은 이름의 데코레이터 옵션과 동일해요.
- `lazy: true`는 eager JOIN 대신 Proxy 기반 지연 로딩으로 바꿔요: 프로퍼티에 처음 접근하는 순간 쿼리가 실행되죠. `eager`와 `lazy`는 동시에 쓸 수 없고, 둘 다 설정하면 `eager`가 우선해요.
- `createForeignKeyConstraints: false`는 논리적 관계(로딩, 캐스케이드)는 유지하되 생성되는 DDL에서 FK 제약만 생략해요 — 크로스 데이터베이스 참조나 제약 검사가 부담스러운 쓰기 집약 테이블에 유용해요.
- `oneToOne`은 추가로 `inverseSide` — 되돌아 가리키는 대상 엔티티의 프로퍼티 이름 — 를 받아서 관계를 양방향으로 탐색할 수 있게 해요. `@OneToOne`의 `inverseSide`와 같아요.

`oneToMany`는 역방향 프로퍼티 이름을 필수 두 번째 인자(위의 `"author"` — `Post`의 `manyToOne` 필드)로 받고, 선택적 `{ cascade }`도 받아요. `manyToMany`는 `{ joinTable, mappedBy, cascade }`를 받고요. 조인 테이블은 소유측에 선언하면 조인 테이블 DDL이 자동 생성돼요. 로딩 전략과 캐스케이드의 개념 설명은 [관계](./relations.md)를 참고하세요.

## 상속

상속은 *is-a* 관계(`CreditCardPayment`는 **a** `Payment`)를 모델링하므로, 실제 TypeScript 클래스 계층 — `class Child extends Parent` — 이 필요해요. `defineEntity`는 호출마다 독립된 클래스 하나를 minting하므로, 계층은 더 낮은 수준의 [`EntitySchema`](./decorator-free.md#entityschema-엔티티-정의) 형식을 쓰는 유일한 지점이에요. 이 형식은 `extends`로 직접 작성한 클래스에 스키마를 붙여요:

```typescript
import { EntitySchema } from "@stingerloom/orm";

class Payment {
  id!: number;
  amount!: number;
}
class CreditCardPayment extends Payment {
  cardNumber!: string;
}

new EntitySchema<Payment>({
  target: Payment,
  inheritance: { strategy: "SINGLE_TABLE" },
  discriminatorColumn: { name: "payment_type" },
  columns: {
    id:     { type: "int", primary: true, autoIncrement: true },
    amount: { type: "int" },
  },
});

new EntitySchema<CreditCardPayment>({
  target: CreditCardPayment,
  discriminatorValue: "credit_card",
  columns: { cardNumber: { type: "varchar", nullable: true } },
});
```

세 가지 전략(단일 테이블, 타입별 테이블, 구체 클래스별 테이블)을 모두 이렇게 데코레이터 없이 지원해요. 전체 전략은 [상속 매핑](./inheritance-mapping.md)을 참고하세요. 빌더 엔티티와 이 `EntitySchema` 계층은 공존하고 서로 관계를 맺을 수 있어요.

## 엔티티 등록과 사용

빌더 엔티티를 데코레이터 클래스와 똑같이 `EntityManager`에 넘기세요:

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
withAuthor!.author?.name; // "Ada" — 완전히 타입이 잡힘
```

::: tip `reflect-metadata`
ORM 코어는 런타임에 `reflect-metadata`를 쓰므로, 진입점에 `import "reflect-metadata"`를 유지하세요. 코드 우선 엔티티에 *필요 없는* 것은 `experimentalDecorators`와 `emitDecoratorMetadata` 컴파일러 옵션이에요.
:::

## 고급 엔티티 옵션

선택적 세 번째 인자는 덜 흔한 엔티티 수준 설정을 담아요. 안에 있는 모든 것은 개별적으로도 접근 가능하지만, 드물게 쓰는 옵션을 묶으면 컬럼 맵이 깔끔해져요:

```typescript
export const Member = defineEntity(
  "members",
  {
    id:    t.int().primary().generated(),
    orgId: t.int().name("org_id"),
    email: t.varchar(255),
  },
  {
    tableName: "org_members",          // 테이블 이름 재정의
    indexes: [{ columns: ["org_id"] }],
    uniqueIndexes: [{ columns: ["org_id", "email"], name: "uq_member_email" }],
    fullTextIndexes: [{ columns: ["email"] }],
    hooks: { beforeInsert(m) { m.email = m.email.toLowerCase(); } },
    nonTenant: true,                   // tenant_column 전략에서 제외
  },
);
```

| 옵션 | 용도 | 데코레이터 대응 |
| --- | --- | --- |
| `tableName` | 테이블 이름 (첫 인자 재정의) | `@Entity({ name })` |
| `indexes` | 복합 / 고급 인덱스 | `@Index([cols], options)` |
| `uniqueIndexes` | 복합 고유 인덱스 | `@UniqueIndex([cols])` |
| `fullTextIndexes` | 전문 인덱스 | `@FullTextIndex([cols])` |
| `hooks` | 생명주기 훅 | `@BeforeInsert` … `@AfterDelete` |
| `nonTenant` | tenant_column 전략에서 제외 | `@NonTenantEntity()` |

### 테넌트 컬럼

전역 `tenantStrategy`가 `"tenant_column"`일 때, 식별자 컬럼을 `.tenant()`로 표시하면 인스턴스에서 읽을 수 있고 쿼리 스코프에 쓰여요. 본질적으로 전역인 테이블은 `nonTenant: true`로 제외하세요:

```typescript
// 테넌트별 엔티티 — 테넌트 컬럼을 log.tenantId로 읽을 수 있음
export const AuditLog = defineEntity("audit_logs", {
  id:       t.int().primary().generated(),
  action:   t.varchar(255),
  tenantId: t.varchar(64).name("tenant_id").tenant(),
});

// 본질적으로 전역인 엔티티 — 테넌트 스코프 없음
export const Tenant = defineEntity(
  "tenants",
  { id: t.varchar(64).primary(), name: t.varchar(255) },
  { nonTenant: true },
);
```

전체 전략은 [멀티테넌시](./multi-tenancy.md)를 참고하세요.

## 실전 종합 예제

위 기능 대부분을 결합한 블로그 사용자 엔티티:

```typescript
import { defineEntity, t, InferEntity } from "@stingerloom/orm";

export const User = defineEntity(
  "users",
  {
    id:        t.int().primary().generated(),
    name:      t.varchar(50).validate([
      { constraint: "notNull" },
      { constraint: "minLength", value: 2 },
      { constraint: "maxLength", value: 50 },
    ]),
    email:     t.varchar(255).index(),
    phone:     t.varchar(20).nullable(),
    isActive:  t.boolean().default(true),
    profile:   t.json<{ bio?: string }>().nullable(),
    version:   t.int().version(),
    deletedAt: t.datetime().deletedAt(),
    createdAt: t.datetime().createTimestamp(),
    updatedAt: t.datetime().updateTimestamp(),
  },
  {
    hooks: {
      afterInsert(user) {
        console.log(`User #${user.id} created`);
      },
    },
  },
);

export type User = InferEntity<typeof User>;
```

**PostgreSQL DDL:**

```sql
CREATE TABLE "users" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(50) NOT NULL,
  "email" VARCHAR(255) NOT NULL,
  "phone" VARCHAR(20),
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "profile" JSON,
  "version" INTEGER NOT NULL,
  "deletedAt" TIMESTAMP,
  "createdAt" TIMESTAMP NOT NULL,
  "updatedAt" TIMESTAMP NOT NULL
);
CREATE INDEX "INDEX_users_email" ON "users" ("email");
```

```typescript
// INSERT — version 자동 1, 타임스탬프 자동 설정, afterInsert 로깅:
const u = await em.save(User, new User({ name: "Alice", email: "alice@example.com" }));

// UPDATE — version 증가, updatedAt만 갱신:
await em.save(User, { id: u.id, name: "Alice Smith", version: u.version });

// 소프트 삭제 + 삭제 행을 자동 제외하는 쿼리:
await em.softDelete(User, { id: u.id });
await em.find(User);                       // WHERE "deletedAt" IS NULL
await em.find(User, { withDeleted: true }); // 필터 없음
```

## 데코레이터와 섞어 쓰기

코드 우선과 데코레이터 엔티티는 같은 메타데이터 파이프라인을 공유하므로, 공존하고 서로 관계를 맺을 수 있어요:

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

빌더 API를 점진적으로 도입하세요 — 새 엔티티는 코드 우선으로, 기존 데코레이터 엔티티는 그대로 두면 돼요.

## ColumnType 참조

### 빌더 → TypeScript 타입

| 빌더 | 추론 TS 타입 |
| --- | --- |
| `t.int()`, `t.integer()`, `t.bigint()`, `t.float()`, `t.double()`, `t.number()`, `t.decimal()` | `number` |
| `t.varchar()`, `t.char()`, `t.text()`, `t.longtext()`, `t.uuid()` | `string` |
| `t.boolean()` | `boolean` |
| `t.datetime()`, `t.timestamp()`, `t.timestamptz()`, `t.date()` | `Date` |
| `t.blob()` | `Buffer` |
| `t.json<T>()`, `t.jsonb<T>()` | `T` (기본 `unknown`) |
| `t.array<T>()` | `T[]` |
| `t.enum([...])` | 리터럴 유니온 |
| 모든 컬럼의 `.nullable()` | `T \| null`로 넓힘 |

### 추상 타입 → 데이터베이스 타입

각 추상 `ColumnType`은 드라이버가 구체적인 데이터베이스 타입으로 변환해요:

| ColumnType | MySQL/MariaDB | PostgreSQL | SQLite |
| --- | --- | --- | --- |
| `varchar` | VARCHAR(n) | VARCHAR(n) | TEXT |
| `int` / `number` | INT | INTEGER | INTEGER |
| `float` | FLOAT | REAL | REAL |
| `double` | DOUBLE | DOUBLE PRECISION | REAL |
| `bigint` | BIGINT | BIGINT | INTEGER |
| `boolean` | TINYINT(1) | BOOLEAN | INTEGER |
| `datetime` | DATETIME | TIMESTAMP | TEXT |
| `timestamp` | TIMESTAMP | TIMESTAMP | TEXT |
| `timestamptz` | DATETIME | TIMESTAMPTZ | TEXT |
| `date` | DATE | DATE | TEXT |
| `text` | TEXT | TEXT | TEXT |
| `longtext` | LONGTEXT | TEXT | TEXT |
| `blob` | BLOB | BYTEA | BLOB |
| `json` | JSON | JSON | TEXT |
| `jsonb` | JSON | JSONB | TEXT |
| `uuid` | CHAR(36) *(MariaDB 10.7+는 UUID)* | UUID | VARCHAR(36) |
| `enum` | ENUM | (커스텀 ENUM) | TEXT |

## 트러블슈팅

**관계 필드가 항상 `undefined`예요.** 관계는 선택적이고 지연 로딩이에요 — 쿼리에서 `relations: ["author"]`로 요청하세요. 없으면 필드는 로드되지 않아요.

**FK 컬럼이 테이블에 없어요.** `manyToOne`/소유측 `oneToOne`은 자체 FK 컬럼을 만들지 않아요. 실제 컬럼(`authorId: t.int().name("author_id")`)으로 선언하고 `joinColumn`을 가리키게 하거나, 관계 옵션에 `relationColumn`을 넘기세요.

**생명주기 훅이 실행되지 않아요.** 훅은 인스턴스에서 실행돼요. 평범한 객체 리터럴이 아니라 `new MyEntity({ … })`를 저장하세요 — [생명주기 훅](#생명주기-훅)을 참고하세요.

**계산 컬럼이 생성된 테이블에 없어요.** `GENERATED ALWAYS AS` DDL은 런타임 `synchronize`가 아니라 스키마 제너레이터(마이그레이션 CLI)에서 나와요 — 마이그레이션을 생성하세요. 데코레이터 `@ComputedColumn`과 동일해요.

**정말 데코레이터 없이 동작하나요?** 모든 엔티티를 `defineEntity`(또는 `EntitySchema`)로 정의하고 dry 동기화를 실행하세요 — 데이터베이스를 건드리지 않고 실행*하려는* DDL을 로깅하므로, 컴파일러가 내보낸 메타데이터 없이 모든 컬럼·인덱스·관계가 해석됐는지 확인할 수 있어요:

```typescript
await em.register({ entities: [User, Post, /* … */], synchronize: "dry-run" });
```

데코레이터 → 빌더/`EntitySchema` 전체 매핑 — 트랜잭션과 데코레이터 없는 NestJS 주입 포함 — 은 [데코레이터 없이 사용하기](./decorator-free.md)를 참고하세요.
