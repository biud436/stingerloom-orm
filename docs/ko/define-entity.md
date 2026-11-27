# 엔티티 정의하기

Stingerloom에서 엔티티를 정의하는 권장 방식은 **코드 우선(code-first) 빌더 API**입니다. `defineEntity`와 `t` 필드 빌더를 함께 씁니다. 선언을 한 번만 작성하면 엔티티의 TypeScript 타입은 스키마에서 추론됩니다. 손으로 쓴 클래스, 별도의 인터페이스, `experimentalDecorators`, `emitDecoratorMetadata`, 빌드 타임 코드 생성이 모두 필요 없습니다. TypeScript 5.4 이상이 필요합니다. 빌더 타입이 `NoInfer`를 쓰기 때문입니다.

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

`User`는 실제 런타임 클래스입니다. 그래서 ORM이 엔티티를 받는 모든 곳에 그대로 씁니다. `em.getRepository(User)`, `em.findOne(User, …)`, 관계 대상이 그 예입니다. `InferEntity<typeof User>`는 행 타입을 복원합니다. 그래서 같은 이름이 타입 역할도 합니다.

::: tip 데코레이터를 선호할 때
데코레이터 API(`@Entity`, `@Column`, …)도 완전히 지원하며 같은 메타데이터를 생성합니다. 자세한 내용은 [엔티티 & 컬럼 (데코레이터)](./entities.md)를 참고하세요. 두 방식은 같은 프로젝트에서 자유롭게 섞어 쓸 수 있습니다. 새 코드에는 빌더 방식을 권장합니다. 데코레이터로 표현할 수 있는 모든 기능에는 대응하는 빌더가 있습니다.
:::

## 코드 우선 방식을 쓰는 이유

ORM 없이는 테이블 하나를 서너 번 기술해야 합니다. `CREATE TABLE`, `INSERT`, `SELECT`, TypeScript 타입에 각각 적습니다. 컬럼을 하나 추가하면 그 모두를 고쳐야 합니다. 데코레이터 ORM은 이것을 클래스 하나로 줄입니다. 하지만 속성 타입을 읽으려고 `emitDecoratorMetadata` 컴파일러 플래그에 의존합니다. esbuild, SWC, Vite의 기본 트랜스포머, TypeScript 5의 표준 데코레이터는 이 플래그의 메타데이터를 내보내지 않습니다. 메타데이터가 없으면 `@Column()`은 경고 없이 타입 정보를 잃습니다.

`defineEntity`는 이 의존성을 완전히 없앱니다.

- **단일 진실 공급원(single source of truth).** 컬럼 빌더가 데이터베이스 타입과 TypeScript 타입을 함께 고정합니다. `t.int()`는 `number`이므로 실수로 `string`으로 표기하지 못합니다. 손으로 쓴 클래스와 별도 스키마를 함께 쓰면 클래스와 스키마가 모르는 사이에 어긋날 수 있습니다.
- **타입 추론, 코드 생성 없음.** `InferEntity`가 빌더를 직접 읽습니다. 생성 단계도 감시(watch) 프로세스도 없습니다. 스키마를 고치면 즉시 타입이 갱신됩니다.
- **데코레이터 툴체인 불필요.** strict 모드와 ESM에서 esbuild, swc, Vite, Bun으로 빌드해도 동작합니다. `experimentalDecorators`와 `emitDecoratorMetadata`가 필요 없습니다. 그래서 잘못 설정할 것이 없습니다.

`defineEntity`는 내부에서 빌더를 메타데이터로 변환합니다. 이 메타데이터는 데코레이터가 등록하는 것과 정확히 같습니다. 그리고 메타데이터를 `EntitySchema` 브리지에 넘깁니다. 그래서 EntityManager, SchemaGenerator, QueryBuilder, WriteBuffer 같은 ORM의 나머지 부분은 빌더 엔티티, 데코레이터 엔티티, 손으로 쓴 `EntitySchema`를 구분하지 못합니다.

## 첫 번째 엔티티 만들기

사용자를 저장한다고 가정해 보겠습니다. 가장 간단한 엔티티에는 컬럼이 두 개 있습니다.

```typescript
// user.entity.ts
import { defineEntity, t, InferEntity } from "@stingerloom/orm";

export const User = defineEntity("users", {
  id:   t.int().primary().generated(),
  name: t.varchar(255),
});

export type User = InferEntity<typeof User>; // { id: number; name: string }
```

첫 번째 인자 `"users"`는 테이블 이름입니다. 이것만으로 Stingerloom은 `users` 테이블을 생성합니다. 이 테이블에는 자동 증가 기본 키와 `VARCHAR(255)` 타입의 `name` 컬럼이 있습니다. 생성하는 DDL은 다음과 같습니다.

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

PostgreSQL은 큰따옴표와 `SERIAL`을 씁니다. MySQL은 백틱과 `AUTO_INCREMENT`를 씁니다. 엔티티를 한 번만 작성하면 두 데이터베이스에서 모두 동작합니다. SQLite에서도 동작하며 이때 키는 `INTEGER PRIMARY KEY AUTOINCREMENT`가 됩니다.

이 엔티티는 세 부분으로 이뤄집니다.

- **`defineEntity("users", { … })`**: 엔티티와 테이블 이름을 선언합니다. 테이블 이름을 첫 번째 인자와 다르게 하려면 세 번째 인자인 옵션 객체의 `tableName`으로 넘깁니다. [고급 엔티티 옵션](#고급-엔티티-옵션)을 참고하세요.
- **`t.int().primary().generated()`**: 자동 증가 기본 키입니다. `.primary()`는 컬럼을 기본 키로 표시합니다. `.generated()`는 INSERT할 때 데이터베이스가 1, 2, 3…을 채우게 합니다. SQL로는 PostgreSQL에서 `SERIAL PRIMARY KEY`, MySQL에서 `INT AUTO_INCREMENT PRIMARY KEY`입니다.
- **`t.varchar(255)`**: 일반 `VARCHAR(255)` 컬럼입니다. 빌더가 TypeScript 타입을 `string`으로 고정하므로 타입을 직접 표기하지 않아도 됩니다.

```sql
-- 작성한 코드:
await em.save(User, { name: "Alice" });
-- 생성된 SQL (DB가 id = 1을 자동으로 채웁니다):
INSERT INTO "users" ("name") VALUES ('Alice');
```

## `t` 빌더

모든 필드는 `t` 네임스페이스의 함수를 호출해 만듭니다. 컬럼 빌더에는 추론된 타입이 있습니다. 체인으로 붙인 수정자가 이 타입을 다듬습니다. 예를 들어 `.nullable()`은 타입을 `T | null`로 넓힙니다.

모든 필드 값은 반드시 호출한 빌더여야 합니다. `defineEntity`가 인식하지 못하는 값이 있으면 필드 이름을 담은 `ORM_SCHEMA_ERROR`를 던집니다. 그 컬럼이 빠진 테이블을 경고 없이 만드는 일은 없습니다. 흔한 예는 괄호를 빠뜨려 호출하지 않은 `email: t.varchar` 같은 팩토리입니다. import 순환 때문에 `undefined`가 된 빌더도 해당합니다.

### 컬럼 타입

| 빌더 | TypeScript 타입 | 추상 컬럼 타입 |
| --- | --- | --- |
| `t.int()` / `t.integer()` | `number` | `int` |
| `t.bigint()` | `number` | `bigint` |
| `t.bigint({ mode: "string" })` / `t.bigint({ mode: "bigint" })` | `string` / `bigint` | `bigint` (±2^53 초과도 무손실) |
| `t.float()` / `t.double()` | `number` | `float` / `double` |
| `t.number()` | `number` | `number` |
| `t.decimal(precision?, scale?)` | `number` | `decimal` (정확한 숫자, 기본값 `(10, 2)`) |
| `t.decimal(precision, scale, { mode: "string" })` | `string` | `decimal` (정확한 숫자 문자열로 읽음) |
| `t.varchar(length?)` | `string` | `varchar` |
| `t.char(length?)` | `string` | `char` |
| `t.text()` / `t.longtext()` | `string` | `text` / `longtext` |
| `t.uuid()` | `string` | `uuid` |
| `t.boolean()` | `boolean` | `boolean` |
| `t.datetime()` / `t.timestamp()` / `t.timestamptz()` / `t.date()` | `Date` | 해당 시간 타입 |
| `t.blob()` | `Buffer` | `blob` |
| `t.json<T>()` / `t.jsonb<T>()` | `T` (기본 `unknown`) | `json` / `jsonb` |
| `t.array<T>(elementType?)` | `T[]` | `array` (PostgreSQL `element[]`, 기본 `TEXT[]`) |
| `t.enum(["a", "b"])` | `"a" \| "b"` | `enum` |

`t.bigint()`의 기본값은 `bigintMode: "number"`입니다. 이때 속성은 일반 `number`입니다. 저장된 값이 ±2^53을 넘으면 읽을 때 반올림하지 않고 `BIGINT_PRECISION_LOSS`를 던집니다. 손실 없이 표현하려면 `{ mode: "string" }`이나 `{ mode: "bigint" }`를 넘깁니다. 추론 타입도 모드를 따라갑니다. 드라이버별 동작은 [bigint 컬럼과 bigintMode](./entities.md#bigint-컬럼과-bigintmode)를 참고하세요.

`t.decimal()`은 금액처럼 반올림 오차가 쌓이면 안 되는 값에 쓰는 정확한 타입입니다. `t.double()`은 측정값에 쓰는 이진 부동소수점 타입입니다. `t.decimal()`의 기본값은 `decimalMode: "number"`입니다. 저장된 값을 JS number로 정확히 담지 못하면 읽을 때 반올림하지 않고 `DECIMAL_PRECISION_LOSS`를 던집니다. 정확한 자릿수로 읽으려면 세 번째 인자로 `{ mode: "string" }`을 넘깁니다. 추론 타입도 모드를 따라갑니다. [double 컬럼과 decimal 컬럼](./entities.md#double-컬럼과-decimal-컬럼)을 참고하세요.

여러 타입을 섞은 실제 예와 추론되는 타입은 다음과 같습니다.

```typescript
export const Product = defineEntity("products", {
  id:          t.int().primary().generated(),
  name:        t.varchar(255),       // VARCHAR(255), 필수
  description: t.text(),             // TEXT (255자가 아니라 메가바이트)
  price:       t.decimal(10, 2),    // DECIMAL(10, 2) / NUMERIC(10, 2), 정확한 숫자
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

`VARCHAR(255)`는 255자에서 잘립니다. 반면 `TEXT`는 메가바이트 단위로 저장합니다. TypeScript에서는 둘 다 `string`이지만 성격이 매우 다른 컬럼입니다. 그러므로 의도에 맞는 빌더를 고르세요. 드라이버별 전체 매핑은 [ColumnType 참조](#columntype-참조)에 있습니다.

## 컬럼 수정자

수정자는 어떤 순서로든 체인으로 붙일 수 있습니다. 각 호출은 새 빌더를 반환합니다. NULL 허용 여부를 바꾸는 수정자는 추론된 타입도 함께 바꿉니다.

| 수정자 | 효과 |
| --- | --- |
| `.primary()` | 기본 키 또는 그 일부로 표시합니다. |
| `.generated(strategy?)` | DB 생성 키: `"increment"`(기본), `"uuid"`, `"uuid-v7"`. `.primary()`와 함께 쓰세요. |
| `.nullable()` | `NULL`을 허용하고 추론 타입을 `T \| null`로 넓힙니다. |
| `.unique(name?)` | 단일 컬럼 고유 인덱스. |
| `.index()` | 단일 컬럼 인덱스. |
| `.default(value)` | 컬럼 기본값. |
| `.name(dbName)` | 데이터베이스 컬럼 이름 재정의 (기본값: 속성 키). |
| `.length(n)` / `.precision(n)` / `.scale(n)` | 크기 / 숫자 정밀도. |
| `.transformer({ to, from })` | 양방향 값 트랜스포머. 필드 타입은 트랜스포머의 엔티티 쪽 타입을 따릅니다([트랜스포머](#트랜스포머)). |
| `.createTimestamp()` / `.updateTimestamp()` | 자동 설정 타임스탬프. |
| `.deletedAt()` | 소프트 삭제 마커 (자동으로 nullable). |
| `.version()` | 낙관적 잠금 버전 컬럼. |
| `.validate([...])` | 인라인 검증 제약. |
| `.enumName(name)` | PostgreSQL `ENUM` 타입 이름 지정. |
| `.renamedFrom(old)` | 이 컬럼이 예전에 쓰던 컬럼 이름 지정. synchronize가 drop + add 대신 이름을 바꿉니다. |
| `.jsonIndex(opts)` | JSON/JSONB 표현식 인덱스. |
| `.tenant()` | 테넌트 식별자 컬럼. |

### 길이

`t.varchar(100)`은 길이를 인자로 바로 설정합니다. `.length(100)`은 나중에 같은 일을 합니다. 둘 다 `VARCHAR(100)`을 렌더링합니다. 데이터베이스는 길이를 넘는 INSERT를 거부합니다.

```typescript
sku: t.varchar(100),           // VARCHAR(100)
sku2: t.varchar().length(100), // 동일
```

### NULL 허용

모든 컬럼은 기본적으로 `NOT NULL`입니다. `.nullable()`은 이 제약을 없애고 동시에 추론 타입을 `T | null`로 넓힙니다. 그래서 타입과 스키마가 항상 일치합니다.

```typescript
bio: t.varchar(255).nullable(), // VARCHAR(255), NOT NULL 없음 → bio: string | null
```

### 컬럼 이름 별칭

속성 이름과 DB 컬럼 이름이 달라야 하면 `.name()`을 씁니다. 흔한 예는 TypeScript에서 camelCase를 쓰고 데이터베이스에서 snake_case를 쓰는 경우입니다.

```typescript
price: t.float().name("unit_price"),
// 엔티티 속성: product.price / DB 컬럼: unit_price
```

DDL에서는 컬럼 이름이 `unit_price`가 됩니다. SELECT할 때는 Stingerloom이 `unit_price`를 `price`로 다시 매핑합니다. 프로젝트 전체에 같은 규칙을 적용하려면 [`SnakeNamingStrategy`](./configuration.md)를 등록합니다. 그러면 컬럼마다 `.name()`을 호출하지 않아도 됩니다.

### 기본값

`.default(value)`는 컬럼 기본값을 설정합니다. 문자열, 숫자, 불리언 리터럴은 그대로 씁니다. 함수 호출 같은 raw SQL 표현식을 내보내려면 괄호로 감쌉니다.

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

괄호가 없으면 `"CURRENT_TIMESTAMP"`를 SQL 함수가 아니라 리터럴 문자열 `'CURRENT_TIMESTAMP'`로 내보냅니다.

### JSON 컬럼

`t.json<T>()`와 `t.jsonb<T>()`는 구조화된 데이터를 한 컬럼에 저장합니다. 타입 인자는 추론된 행 타입에 그대로 반영됩니다.

```typescript
settings: t.json<{ theme: string }>().nullable(),
// settings: { theme: string } | null
```

PostgreSQL에서 `jsonb`는 분해한 바이너리 형식으로 저장됩니다. 쓰기는 느리지만 쿼리는 훨씬 빠릅니다. 그리고 `WHERE settings->>'theme' = 'dark'` 같은 조건에 쓸 인덱스는 `jsonb`에만 만들 수 있습니다. JSON 문서 안을 쿼리한다면 언제나 `jsonb`를 고르세요.

Stingerloom은 `json`/`jsonb` 컬럼에 기본 왕복 변환을 적용합니다. 쓸 때는 문자열이 아닌 값을 드라이버에 넘기기 전에 `JSON.stringify`합니다. 읽을 때는 드라이버가 반환한 문자열을 `JSON.parse`합니다. 그래서 평범한 JS 값을 그대로 할당하면 됩니다.

```typescript
await em.save(Issue, { customFields: { priority: "high", labels: ["bug"] } });
const issue = await em.findOne(Issue, { where: { id } });
issue!.customFields.priority; // "high" (이미 객체이며 다이얼렉트와 무관)
```

[`.transformer()`](#트랜스포머)를 명시하면 해당 방향의 기본 변환을 덮어씁니다.

### PostgreSQL ENUM

`t.enum([...])`은 리터럴 유니온 타입을 고정하고 허용 값을 데이터베이스에 전달합니다. 생성하는 PostgreSQL 타입의 이름은 `.enumName()`으로 지정합니다.

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

`.enumName()`을 생략하면 이름은 `{tableName}_{columnName}_enum`이 됩니다. MySQL에서는 컬럼이 네이티브 `ENUM(...)`이 됩니다. SQLite에서는 `TEXT`로 저장합니다.

PostgreSQL에서 `synchronize`는 이 타입을 참조하는 테이블보다 타입을 먼저 만듭니다. 나중에 추가한 값도 반영합니다. 반면 제거한 값은 삭제하지 않고 경고만 남깁니다. 자세한 내용은 [설정](./configuration.md#postgresql-enum-타입)을 참고하세요.

## 기본 키

### 생성 키

`.primary().generated(strategy)`는 데이터베이스 생성 키를 만듭니다. 생성 방식은 `strategy` 인자로 지정합니다.

```typescript
id: t.int().primary().generated(),              // 자동 증가 (기본 "increment")
id: t.uuid().primary().generated("uuid"),       // 랜덤 UUIDv4
id: t.uuid().primary().generated("uuid-v7"),    // 시간 정렬 가능한 UUIDv7
```

`"increment"`는 PostgreSQL의 `SERIAL`, MySQL의 `AUTO_INCREMENT`에 대응합니다. `"uuid"`와 `"uuid-v7"`은 INSERT 전에 애플리케이션 코드에서 값을 생성합니다. `"uuid-v7"`은 시간순으로 정렬되므로 랜덤 UUID보다 기본 키 인덱스에 훨씬 유리합니다.

### 수동 기본 키

`.generated()`를 빼면 값을 직접 지정하는 키가 됩니다. `@PrimaryColumn()`에 대응하는 빌더입니다. config 테이블 같은 자연 키에 유용합니다.

```typescript
export const Config = defineEntity("config", {
  key:   t.varchar(64).primary(),
  value: t.text(),
});

await em.save(Config, { key: "site.title", value: "My Blog" });
// INSERT INTO "config" ("key", "value") VALUES ('site.title', 'My Blog')
```

### 복합 기본 키

컬럼 둘 이상을 `.primary()`로 표시하면 복합 기본 키가 됩니다.

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

트랜스포머는 값을 양방향으로 변환합니다. `to`는 모든 INSERT와 UPDATE 전에 실행됩니다. `from`은 모든 SELECT 뒤에 실행됩니다. 대표적인 용도는 이메일을 소문자로 정규화하는 것입니다. 그러면 `Alice@Example.com`과 `alice@example.com`이 함께 저장되지 않습니다.

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

암호화도 같은 모양입니다. `to`에서 암호화하고 `from`에서 복호화합니다. 그래서 데이터베이스에는 항상 암호문만 저장되고 코드에서는 평문을 다룹니다.

```typescript
ssn: t.text().transformer({
  to:   (value: string) => encrypt(value),
  from: (value: string) => decrypt(value),
}),
```

### 필드 타입 바꾸기

필드 타입은 트랜스포머의 엔티티 쪽 타입을 따릅니다. 엔티티 쪽 타입은 `from`이 반환하고 `to`가 받는 타입입니다. 그래서 컬럼에 저장된 값보다 풍부한 값을 코드에서 다룰 수 있습니다. 다음은 `Date` 대신 `Dayjs`를 쓰는 예시입니다.

```typescript
import dayjs, { Dayjs } from "dayjs";

export const Meeting = defineEntity("meetings", {
  id:       t.int().primary().generated(),
  startsAt: t.datetime().transformer({
    to:   (value: Dayjs) => value.toDate(),
    from: (raw: Date | string) => dayjs(raw), // SQLite는 시간 컬럼을 텍스트로 읽음
  }),
  endsAt: t.datetime().nullable().transformer({
    to:   (value: Dayjs | null) => (value ? value.toDate() : null),
    from: (raw: Date | string) => dayjs(raw),
  }),
});
export type Meeting = InferEntity<typeof Meeting>;
// { id: number; startsAt: Dayjs; endsAt: Dayjs | null }

await em.save(Meeting, { startsAt: dayjs("2026-11-02T09:00:00Z"), endsAt: null });
const meeting = await em.findOne(Meeting, { where: { id: 1 } });
meeting?.startsAt.add(1, "hour"); // 캐스팅 없이 Dayjs
```

`where` 피연산자도 같은 타입을 받고 `to`를 거칩니다. 그래서 `where: { startsAt: dayjs(...) }`는 저장된 값과 비교됩니다.

`.nullable()`은 `.transformer()` 앞에 붙이든 뒤에 붙이든 컬럼을 nullable로 유지합니다. NULL은 `from`을 거치지 않고 `null`로 읽힙니다. 하지만 속성이 `null`이면 `to`는 `null`을 인자로 받아 호출됩니다. 그러므로 `to`의 매개변수가 `null`을 받도록 선언하세요. 위의 소문자 변환처럼 타입을 바꾸지 않는 트랜스포머는 컬럼 타입을 그대로 유지합니다. 이때는 타입 주석을 달지 않아도 매개변수 타입을 컬럼에서 추론합니다.

트랜스포머 하나를 여러 컬럼에서 함께 쓰려면 `ColumnTransformer<TEntity, TDb>`로 타입을 지정합니다.

```typescript
import { ColumnTransformer } from "@stingerloom/orm";

const dayjsColumn: ColumnTransformer<Dayjs, Date | string> = {
  to:   (value) => value.toDate(),
  from: (raw) => dayjs(raw),
};
```

## 인덱스

### 단일 컬럼 인덱스

`.index()`는 고유하지 않은 인덱스를 추가합니다. `.unique()`는 고유 인덱스를 추가합니다. 어느 쪽이든 해당 컬럼의 `WHERE`, `JOIN`, `ORDER BY`에서 전체 테이블 스캔을 O(log n) B-tree 조회로 바꿉니다.

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

`.unique()` 제약은 엔티티의 고유 인덱스 목록에 올라갑니다. 그래서 옵션 객체에 선언하는 복합 고유 인덱스와 함께 동작합니다.

### 복합 및 고유 인덱스

여러 컬럼에 거는 인덱스는 세 번째 인자인 옵션 객체에 선언합니다. `indexes`는 고유하지 않은 인덱스입니다. `uniqueIndexes`는 컬럼 조합의 고유성을 강제합니다.

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

복합 인덱스는 왼쪽 컬럼부터 동작합니다. 성으로 먼저 정렬하고 이름으로 다시 정렬한 전화번호부와 같습니다. 그래서 `WHERE tenant_id = 5`와 `WHERE tenant_id = 5 AND status = 'pending'`에는 인덱스를 씁니다. 하지만 `WHERE status = 'pending'`만 있으면 인덱스를 쓰지 않습니다.

### 고급 인덱스 옵션

각 `indexes` 항목은 `options` 객체를 받습니다. 이 객체는 데코레이터의 `@Index([cols], options)`가 받는 것과 같은 `AdvancedIndexOptions`입니다. 이 객체로 부분(partial) 인덱스, 표현식 인덱스, `USING`, 커버링(`INCLUDE`) 인덱스를 지정합니다.

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
          where: "deleted_at IS NULL", // 부분 인덱스: 소프트 삭제 행 제외
          include: ["name"],           // 커버링 인덱스: index-only 스캔
        },
      },
      // 표현식 인덱스: 컬럼 목록은 비우고 표현식으로 대체
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

부분 인덱스(`where`), 커버링 인덱스(`include`), btree가 아닌 `using`은 PostgreSQL 기능입니다. 부분 인덱스는 SQLite에서도 동작합니다. MySQL은 이 옵션을 무시하거나 거부합니다. 옵션 객체는 데코레이터와 같으므로 개념 설명은 데코레이터 가이드의 [고급 인덱스 옵션](./entities.md#고급-인덱스-옵션)을 참고하세요.

### 전문 인덱스

전문(full-text) 인덱스는 `fullTextIndexes`에 선언합니다.

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

PostgreSQL은 GIN `to_tsvector` 인덱스를 내보냅니다. MySQL은 `FULLTEXT` 인덱스를 내보냅니다. SQLite에서는 아무 동작도 하지 않습니다.

### JSON 경로 인덱스

`.jsonIndex()`는 `jsonb` 컬럼 안의 경로에 거는 표현식 인덱스를 선언합니다. `@JsonIndex`에 대응하는 빌더입니다.

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

`path`는 점과 대괄호로 표기합니다. `"contact.email"`, `"tags[0]"`이 그 예입니다. 생략하면 컬럼 전체에 인덱스를 겁니다. `using: "btree"`는 동등 비교나 범위 비교에 쓰는 스칼라 값 하나에 적합합니다. MySQL과 SQLite는 DDL을 내보내지 않고 경고를 로그로 남깁니다. 전체 옵션은 [JSON 경로 인덱스](./entities.md#json-경로-인덱스-jsonindex)를 참고하세요. 이 인덱스를 쓰는 연산자는 [JSON 컬럼 탐색](./query-builder-json.md)에 있습니다.

## 낙관적 잠금

`.version()`은 버전 카운터를 추가합니다. 이 카운터로 갱신 손실(lost update) 문제를 감지합니다. 갱신 손실은 두 작성자가 같은 행을 읽고 서로의 변경을 덮어쓰는 문제입니다. INSERT할 때 버전은 1로 설정됩니다. UPDATE할 때 Stingerloom은 `WHERE version = N`을 추가하고 버전을 1 올립니다. 그 사이에 행이 바뀌었으면 UPDATE에 매치되는 행이 0개입니다. 그러면 Stingerloom은 데이터를 모르는 사이에 잃는 대신 `OptimisticLockError`를 던집니다.

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

충돌은 드물지만 정확성이 중요한 곳에 쓰세요. 주문 상태나 재고가 그 예입니다. 경합이 심한 행에는 비관적 잠금(`SELECT … FOR UPDATE`)이 낫습니다.

## 소프트 삭제

`.deletedAt()`은 삭제할 때 행을 제거하지 않고 타임스탬프를 기록하게 합니다. `.nullable()`이 자동으로 적용되므로 추론 타입은 `Date | null`입니다. `NULL`은 삭제되지 않은 행을 뜻합니다.

```typescript
export const Post = defineEntity("posts", {
  id:        t.int().primary().generated(),
  title:     t.varchar(255),
  deletedAt: t.datetime().deletedAt(), // deletedAt: Date | null
});
```

이 마커는 세 가지 동작을 바꿉니다.

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

`.createTimestamp()`와 `.updateTimestamp()`는 감사용 타임스탬프를 자동으로 채웁니다. INSERT할 때는 생성 일시와 수정 일시를 모두 설정합니다. UPDATE할 때는 수정 일시만 새로 채웁니다.

```typescript
export const Article = defineEntity("articles", {
  id:        t.int().primary().generated(),
  title:     t.varchar(255),
  createdAt: t.datetime().createTimestamp(),
  updatedAt: t.datetime().updateTimestamp(),
});
```

```sql
-- INSERT: createdAt과 updatedAt을 같은 시각으로 설정 (앱 코드의 new Date()로 생성):
INSERT INTO "articles" ("title", "createdAt", "updatedAt")
VALUES ('Hello', '2026-06-30 10:30:00', '2026-06-30 10:30:00');

-- UPDATE: SET 절에는 updatedAt만 들어감:
UPDATE "articles" SET "title" = 'Hello v2', "updatedAt" = '2026-06-30 11:45:00'
WHERE "id" = 1;
```

`save()`에서 타임스탬프 컬럼에 값을 명시하면 자동 생성 값 대신 그 값을 씁니다. 데이터 마이그레이션에 유용합니다. PostgreSQL에서 시간대를 반영하는 컬럼이 필요하면 `t.timestamptz()`를 쓰세요.

## 계산 컬럼

`t.computed()`는 데이터베이스 수준의 생성 컬럼을 선언합니다. `@ComputedColumn`에 대응하는 빌더입니다. 값은 데이터베이스가 다른 컬럼으로 계산합니다. 그래서 ORM은 이 컬럼을 모든 INSERT와 UPDATE에서 제외합니다. 값을 쓰려고 하면 에러가 납니다. DDL은 `GENERATED ALWAYS AS (expression)`으로 렌더링됩니다.

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
// "total"은 생략하고 DB가 89.97로 계산
```

옵션은 `@ComputedColumn`과 같습니다. `stored`, `type`, `length`, `nullable`이 있습니다.

| `stored` | 모드 | 동작 | 디스크 | 인덱스 가능 |
| --- | --- | --- | --- | --- |
| `true` | STORED | 쓰기 시 계산, 영속화 | 공간 사용 | 가능 |
| `false` (기본) | VIRTUAL | 읽기마다 계산 | 없음 | 제한적 |

### 다이얼렉트 독립 표현식

리터럴 문자열 표현식은 DDL에 그대로 들어갑니다. 그래서 대상 데이터베이스에서 유효한 SQL이어야 합니다. `price * quantity` 같은 이식 가능한 산술은 괜찮습니다. 하지만 날짜 연산은 엔진마다 크게 다릅니다. 이때는 빌더 함수를 넘깁니다. 그러면 Stingerloom이 연결마다 한 번 다이얼렉트에 맞는 SQL로 컴파일합니다.

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
"cycleTimeHours" INTEGER GENERATED ALWAYS AS (EXTRACT(EPOCH FROM ("completed_at" - "created_at")) / 3600) STORED
```

컨텍스트 `e`는 Expressions DSL 전체(`e.iff`, `e.caseBuilder`, `e.coalesce`, `e.dateDiff`, `e.col(name)`)를 제공합니다. 전체 DSL은 데코레이터 가이드의 [다이얼렉트 독립 표현식](./entities.md#다이얼렉트-독립-표현식-빌더-형식)을 참고하세요.

::: tip 계산 컬럼이 데이터베이스에 반영되는 방식
두 스키마 워크플로 모두 계산 컬럼을 생성합니다. 런타임 `synchronize`는 CREATE TABLE에 `GENERATED ALWAYS AS` 정의를 넣습니다. 기존 테이블에는 ALTER TABLE ADD COLUMN으로 추가합니다. `stingerloom migrate:generate`는 같은 정의를 마이그레이션 파일에 출력합니다. 두 경로 모두 같은 빌더로 렌더링합니다. 다만 기존 컬럼의 `expression`을 바꾸려면 여전히 마이그레이션을 직접 작성해야 합니다. 컬럼을 삭제하고 다시 추가하는 마이그레이션입니다. 표현식 변경은 자동으로 감지되지 않습니다. 테이블을 어떻게 생성했든 Stingerloom은 항상 이 컬럼을 쓰기에서 제외합니다.
:::

## 검증

`.validate([...])`는 애플리케이션 수준의 제약을 붙입니다. ORM은 SQL을 만들기 전에 이 제약을 검사합니다. `@NotNull`, `@MinLength`, `@Min` 같은 데코레이터에 대응하는 빌더입니다. 검증에 실패하면 `ValidationError`를 던지고 쿼리를 보내지 않습니다.

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

각 항목은 `{ constraint, value?, message? }` 형태입니다. 제약에는 `notNull`, `minLength`, `maxLength`, `min`, `max`가 있습니다. `message`를 지정하면 기본 메시지를 덮어씁니다. 데이터베이스의 `NOT NULL` 위반은 DB에 다녀온 뒤에야 알기 어려운 메시지로 드러납니다. 반면 검증은 프로세스 안에서 명확한 메시지와 함께 실패를 잡습니다.

## 생명주기 훅

훅은 엔티티 생명주기의 특정 시점에 커스텀 로직을 실행합니다. 삽입 전 슬러그 생성, 삽입 후 알림 전송, 삭제 전 정리가 그 예입니다. 훅은 세 번째 인자인 옵션 객체에 선언합니다. 각 이벤트에는 함수를 연결합니다. 클래스에 이미 있는 메서드의 이름을 연결해도 됩니다.

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

훅은 엔티티를 `this`로도 받고 첫 번째 인자로도 받습니다. 그래서 `beforeInsert(a) { a.slug = … }`와 `beforeInsert() { this.slug = … }`는 같습니다.

::: warning 훅은 `new Entity(...)`로 만든 인스턴스에서 실행됩니다
훅은 엔티티 프로토타입의 메서드입니다. 그래서 저장하는 객체에 그 프로토타입이 있을 때만 실행됩니다. `defineEntity`가 만든 클래스의 생성자는 이를 위해 일부 필드만 채운 객체를 받습니다. `new Article({ … })`는 타입이 지정되고 훅이 있는 인스턴스를 만듭니다.

```typescript
// 훅이 실행됩니다. 저장하는 객체가 Article 인스턴스입니다.
const saved = await em.save(Article, new Article({ title: "Hello World" }));
saved.slug; // "hello-world"

// 훅이 실행되지 않습니다. 평범한 객체 리터럴에는 프로토타입 메서드가 없습니다.
await em.save(Article, { title: "Hello World" });
```

데코레이터 엔티티에도 같은 요구 사항이 있습니다. `@BeforeInsert`도 인스턴스가 필요합니다. `new Article({...})`는 `Object.assign(new Article(), {...})`과 같은 일을 합니다. 다만 데코레이터 없이 쓰고 타입 검사도 받습니다.
:::

이벤트는 여섯 개입니다. 각 이벤트는 해당 SQL의 앞이나 뒤에서 실행됩니다.

| 이벤트 | 시점 | 대표 용도 |
| --- | --- | --- |
| `beforeInsert` | INSERT 직전 | 기본값, 슬러그 생성, 정규화 |
| `afterInsert` | INSERT 후 (엔티티에 ID가 생김) | 로깅, 알림, 캐시 무효화 |
| `beforeUpdate` | UPDATE 직전 | 필드 재계산, 검증 |
| `afterUpdate` | UPDATE 후 | 변경 이력, 웹훅 |
| `beforeDelete` | DELETE 직전 | 정리, 권한 확인 |
| `afterDelete` | DELETE 후 | 관련 리소스 해제, 로깅 |

새 엔티티는 `beforeInsert` 훅, `INSERT`, `afterInsert` 훅 순서로 처리합니다. `before*` 훅에서 바꾼 값은 SQL에 반영됩니다. `after*` 훅은 행을 쓴 뒤에 실행됩니다. 그러므로 `after*` 훅은 부수 효과에 쓰세요.

## 관계

관계 빌더는 지연 함수 `() => TargetEntity`를 받습니다. 런타임에 두 엔티티가 서로 참조할 수 있게 평가를 미루는 것입니다. `manyToOne`과 `oneToOne`은 관련 행 타입을 추론합니다. `oneToMany`와 `manyToMany`는 배열 타입을 추론합니다. 관계 필드는 추론 타입에서 선택적(optional)입니다. `relations: [...]`로 요청할 때만 값을 채우기 때문입니다.

두 엔티티가 서로를 참조하면 타입 쪽에 작은 단계가 하나 더 필요합니다. 아래 [상호 참조](#상호-참조)를 참고하세요.

| 빌더 | 시그니처 | 추론 필드 |
| --- | --- | --- |
| `t.manyToOne` | `(() => Target, options?)` | `Target?` |
| `t.oneToMany` | `(() => Target, mappedBy, options?)` | `Target[]?` |
| `t.oneToOne` | `(() => Target, options?)` | `Target?` |
| `t.manyToMany` | `(() => Target, options?)` | `Target[]?` |

```typescript
import { defineEntity, t, InferEntity, AnyEntityClass } from "@stingerloom/orm";

export const Author = defineEntity("authors", {
  id:    t.int().primary().generated(),
  name:  t.varchar(120),
  // Author ↔ Post는 순환 참조: 이쪽에 명시적 행 타입 + 주석 붙은 thunk를 사용
  posts: t.oneToMany<Post>((): AnyEntityClass => Post, "author"),
});

export const Post = defineEntity("posts", {
  id:       t.int().primary().generated(),
  title:    t.varchar(200),
  authorId: t.int().nullable().name("author_id"), // 물리적 외래 키 컬럼
  author:   t.manyToOne(() => Author, { joinColumn: "author_id" }),
  tags:     t.manyToMany(() => Tag, {
    joinTable: { name: "post_tags", joinColumn: "post_id", inverseJoinColumn: "tag_id" },
  }),
});

export const Tag = defineEntity("tags", {
  id:   t.int().primary().generated(),
  name: t.varchar(60).unique(),
});

// 서로 참조하는 쌍은 인터페이스 병합으로 선언합니다 (지연 해석).
export interface Author extends InferEntity<typeof Author> {} // posts?: Post[]
export interface Post extends InferEntity<typeof Post> {}     // author?: Author; tags?: Tag[]
// Tag는 한 방향으로만 참조되므로 일반 타입 별칭이면 충분합니다.
export type Tag = InferEntity<typeof Tag>;
```

::: warning 외래 키 컬럼은 실제 컬럼으로 선언합니다
`manyToOne`과 소유 측 `oneToOne`의 외래 키 컬럼은 실제 컬럼으로 선언해야 합니다. 그래야 스키마 동기화 때 생성됩니다. `authorId: t.int().name("author_id")`가 그 예입니다. 데코레이터 API에서 `@ManyToOne`에 외래 키용 `@Column`이나 `@RelationColumn`을 짝짓는 것과 같습니다. 그러면 관계의 `joinColumn`이 그 컬럼을 가리킵니다. 관계 옵션에 `relationColumn: { … }`을 넘겨 외래 키 메타데이터를 인라인으로 선언해도 됩니다.
:::

### 상호 참조

두 `defineEntity` 상수가 서로의 타입에 의존하면 TypeScript는 어느 쪽도 추론하지 못합니다. 그리고 다음 에러를 보고합니다.

```
error TS7022: 'Author' implicitly has type 'any' because it does not have a
type annotation and is referenced directly or indirectly in its own initializer.
```

이것은 `const` 타입 추론의 본질적인 한계입니다. 클래스 선언은 멤버 타입을 늦게 해석하므로 이 문제가 없습니다. 지원하는 패턴은 순환의 한쪽에 다음 세 가지를 적용해 고리를 끊는 것입니다.

```typescript
export const Author = defineEntity("authors", {
  id:    t.int().primary().generated(),
  //               ① 명시적 행 타입      ② 주석 붙은 thunk
  posts: t.oneToMany<Post>((): AnyEntityClass => Post, "author"),
});
export const Post = defineEntity("posts", {
  id:     t.int().primary().generated(),
  author: t.manyToOne(() => Author, { joinColumn: "author_id" }), // 그대로
});
// ③ `type X = InferEntity<typeof X>` 대신 인터페이스 병합
export interface Author extends InferEntity<typeof Author> {}
export interface Post extends InferEntity<typeof Post> {}
```

세 가지는 모두 꼭 필요합니다.

1. **`t.oneToMany<Post>(…)`**: 관련 행 타입을 명시적으로 넘깁니다. 그래서 `Author` 타입이 이 타입을 `Post`의 초기화 식에서 추론하지 않아도 됩니다. 모든 관계 빌더가 이 타입 인자를 받습니다. `t.manyToOne<Author>(…)`, `t.manyToMany<Course>(…)`, `t.oneToOne<Profile>(…)`이 그 예입니다.
2. **`(): AnyEntityClass => Post`**: thunk의 반환 타입 주석입니다. 주석이 없으면 컴파일러가 thunk 본문에서 반환 타입을 추론해야 합니다. 그러면 빌더 시그니처와 상관없이 다시 순환에 빠집니다. `AnyEntityClass`는 `@stingerloom/orm`에서 가져옵니다.
3. **`interface Author extends InferEntity<typeof Author> {}`**: 행 타입을 인터페이스 병합으로 선언합니다. 인터페이스는 멤버를 늦게 해석합니다. 반면 `type` 별칭은 쓰는 곳에서 즉시 해석되므로 다시 순환에 빠집니다.

참고할 점이 몇 가지 있습니다.

- 순환마다 간선 하나만 처리하면 충분합니다. `A → B → C → A` 삼각형이면 관계 하나에만 패턴을 적용해도 세 엔티티가 모두 풀립니다.
- 명시적 타입 인자를 쓰면 `mappedBy`를 일반 `string`으로 검사합니다. 대상의 키를 조회하면 다시 순환에 빠지기 때문입니다. 그래서 이 인자는 자동완성되지 않습니다.
- ①과 ②는 반드시 함께 써야 합니다. 주석만 있으면 필드가 `any[]`로 남습니다. 타입 인자만 있으면 여전히 TS7022가 납니다.
- 런타임 동작은 어느 형태든 같습니다. thunk는 모든 엔티티를 정의한 뒤에 호출되므로 순전히 타입 수준의 문제입니다.

### 관계 옵션

`manyToOne`과 `oneToOne`은 데코레이터와 같은 로딩 옵션과 참조 동작 옵션을 받습니다.

```typescript
author: t.manyToOne(() => Author, {
  joinColumn: "author_id",
  references: "id",            // 외래 키가 가리키는 대상 컬럼 (기본값: 대상의 기본 키)
  eager: true,                 // 항상 LEFT JOIN 하고 채움
  lazy: false,                 // true = 속성에 처음 접근할 때 Proxy 기반으로 지연 로딩
  cascade: ["insert", "update"],
  onDelete: "CASCADE",         // 외래 키 ON DELETE 동작
  onUpdate: "RESTRICT",
  createForeignKeyConstraints: true, // false = 관계는 유지하고 외래 키 DDL만 생략
  relationColumn: {            // 명시적 외래 키 컬럼 메타데이터 (@RelationColumn 방식)
    name: "author_id",
    type: "bigint",
    nullable: false,
    referencedColumn: "id",
  },
}),
```

몇 가지 옵션에는 설명이 더 필요합니다.

- `references`: 외래 키가 대상의 기본 키가 아닌 다른 컬럼을 가리키게 합니다. `uuid` 컬럼이 그 예입니다. 같은 이름의 데코레이터 옵션과 같습니다.
- `lazy: true`: 즉시 로딩의 JOIN 대신 Proxy 기반 지연 로딩을 씁니다. 속성에 처음 접근하는 순간 쿼리를 실행합니다. `eager`와 `lazy`는 함께 쓰지 못합니다. 둘 다 설정하면 `eager`가 우선합니다.
- `createForeignKeyConstraints: false`: 로딩과 캐스케이드 같은 논리적 관계는 유지합니다. 그리고 생성하는 DDL에서 외래 키 제약만 생략합니다. 다른 데이터베이스를 참조하는 경우나 제약 검사가 부담스러운 쓰기 집약 테이블에 유용합니다.
- `inverseSide`: `oneToOne`만 받는 옵션입니다. 대상 엔티티에서 이쪽을 되돌아 가리키는 속성의 이름입니다. 이 옵션을 주면 관계를 양방향으로 탐색할 수 있습니다. `@OneToOne`의 `inverseSide`와 같습니다.

`oneToMany`는 역방향 속성 이름을 필수 두 번째 인자로 받습니다. 위 예제에서는 `Post`의 `manyToOne` 필드인 `"author"`가 이 인자입니다. 선택 옵션으로 `{ cascade }`도 받습니다. `manyToMany`는 `{ joinTable, mappedBy, cascade }`를 받습니다. 조인 테이블을 소유 측에 선언하면 조인 테이블 DDL을 자동으로 생성합니다. 로딩 전략과 캐스케이드의 개념은 [관계](./relations.md)를 참고하세요.

## 상속

상속은 is-a 관계를 모델링합니다. `CreditCardPayment`는 `Payment`의 한 종류입니다. 그래서 `class Child extends Parent` 같은 실제 TypeScript 클래스 계층이 필요합니다. `defineEntity`는 호출할 때마다 독립된 클래스를 하나씩 만듭니다. 그래서 클래스 계층에는 더 낮은 수준의 [`EntitySchema`](./decorator-free.md#entityschema-엔티티-정의) 형식을 씁니다. 이 형식이 필요한 곳은 클래스 계층뿐입니다. `EntitySchema`는 `extends`로 직접 작성한 클래스에 스키마를 붙입니다.

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

이 방식으로 단일 테이블, 타입별 테이블, 구체 클래스별 테이블 전략을 모두 데코레이터 없이 지원합니다. 전략의 자세한 내용은 [상속 매핑](./inheritance-mapping.md)을 참고하세요. 빌더 엔티티와 이 `EntitySchema` 계층은 함께 쓰고 서로 관계를 맺어도 됩니다.

## 엔티티 등록과 사용

빌더 엔티티는 데코레이터 클래스와 똑같이 `EntityManager`에 넘깁니다.

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
withAuthor!.author?.name; // "Ada" (타입이 완전히 지정됨)
```

::: tip `reflect-metadata`
ORM 코어는 런타임에 `reflect-metadata`를 씁니다. 그러므로 진입점의 `import "reflect-metadata"`는 그대로 두세요. 코드 우선 엔티티에 필요 없는 것은 `experimentalDecorators`와 `emitDecoratorMetadata` 컴파일러 옵션입니다.
:::

## 고급 엔티티 옵션

선택 인자인 세 번째 인자에는 자주 쓰지 않는 엔티티 수준 설정을 담습니다. 안에 있는 설정은 모두 따로 지정할 방법도 있습니다. 하지만 드물게 쓰는 옵션을 한곳에 묶으면 컬럼 맵이 깔끔해집니다.

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
    schema: "public",                  // PostgreSQL 스키마에 고정 (테넌트 간 공유)
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
| `schema` | 테이블을 고정할 PostgreSQL 스키마 ([공유 테이블](./multi-tenancy.md#공유-테이블-엔티티를-스키마에-고정하기)) | `@Entity({ schema })` |
| `indexes` | 복합 / 고급 인덱스 | `@Index([cols], options)` |
| `uniqueIndexes` | 복합 고유 인덱스 | `@UniqueIndex([cols])` |
| `fullTextIndexes` | 전문 인덱스 | `@FullTextIndex([cols])` |
| `hooks` | 생명주기 훅 | `@BeforeInsert` … `@AfterDelete` |
| `nonTenant` | tenant_column 전략에서 제외 | `@NonTenantEntity()` |

### 테넌트 컬럼

전역 `tenantStrategy`가 `"tenant_column"`이면 테넌트 구분 컬럼을 `.tenant()`로 표시합니다. 그러면 인스턴스에서 이 컬럼을 읽을 수 있고 쿼리 범위를 정하는 데에도 씁니다. 본래 전역인 테이블은 `nonTenant: true`로 제외하세요.

```typescript
// 테넌트별 엔티티: 테넌트 컬럼을 log.tenantId로 읽음
export const AuditLog = defineEntity("audit_logs", {
  id:       t.int().primary().generated(),
  action:   t.varchar(255),
  tenantId: t.varchar(64).name("tenant_id").tenant(),
});

// 본래 전역인 엔티티: 테넌트 범위 없음
export const Tenant = defineEntity(
  "tenants",
  { id: t.varchar(64).primary(), name: t.varchar(255) },
  { nonTenant: true },
);
```

전체 전략은 [멀티테넌시](./multi-tenancy.md)를 참고하세요.

## 실전 종합 예제

다음은 위 기능 대부분을 결합한 블로그 사용자 엔티티입니다.

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
// INSERT: version은 자동으로 1, 타임스탬프 자동 설정, afterInsert 로깅
const u = await em.save(User, new User({ name: "Alice", email: "alice@example.com" }));

// UPDATE: version 증가, updatedAt만 갱신
await em.save(User, { id: u.id, name: "Alice Smith", version: u.version });

// 소프트 삭제 + 삭제 행을 자동 제외하는 쿼리:
await em.softDelete(User, { id: u.id });
await em.find(User);                       // WHERE "deletedAt" IS NULL
await em.find(User, { withDeleted: true }); // 필터 없음
```

## 데코레이터와 섞어 쓰기

코드 우선 엔티티와 데코레이터 엔티티는 같은 메타데이터 파이프라인을 공유합니다. 그래서 함께 쓰고 서로 관계를 맺어도 됩니다.

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

빌더 API는 점진적으로 도입하세요. 새 엔티티는 코드 우선으로 작성하고 기존 데코레이터 엔티티는 그대로 두면 됩니다.

## ColumnType 참조

### 빌더 → TypeScript 타입

| 빌더 | 추론 TS 타입 |
| --- | --- |
| `t.int()`, `t.integer()`, `t.bigint()`, `t.float()`, `t.double()`, `t.number()`, `t.decimal()` | `number` |
| `t.bigint({ mode: "string" })`, `t.decimal(p, s, { mode: "string" })` | `string` |
| `t.bigint({ mode: "bigint" })` | `bigint` |
| `t.varchar()`, `t.char()`, `t.text()`, `t.longtext()`, `t.uuid()` | `string` |
| `t.boolean()` | `boolean` |
| `t.datetime()`, `t.timestamp()`, `t.timestamptz()`, `t.date()` | `Date` |
| `t.blob()` | `Buffer` |
| `t.json<T>()`, `t.jsonb<T>()` | `T` (기본 `unknown`) |
| `t.array<T>(elementType?)` | `T[]` |
| `t.enum([...])` | 리터럴 유니온 |
| 모든 컬럼의 `.nullable()` | `T \| null`로 넓힘 |

### 추상 타입 → 데이터베이스 타입

드라이버는 각 추상 `ColumnType`을 구체적인 데이터베이스 타입으로 변환합니다.

| ColumnType | MySQL/MariaDB | PostgreSQL | SQLite |
| --- | --- | --- | --- |
| `varchar` | VARCHAR(n) | VARCHAR(n) | TEXT |
| `int` / `number` | INT | INTEGER | INTEGER |
| `float` | FLOAT | REAL | REAL |
| `double` | DOUBLE | DOUBLE PRECISION | REAL |
| `decimal` | DECIMAL(p, s) | NUMERIC(p, s) | NUMERIC(p, s) (NUMERIC affinity) |
| `bigint` | BIGINT | BIGINT | BIGINT (INTEGER affinity) |
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
| `array` | JSON | `element[]` (기본 `TEXT[]`, 예: `t.array<number>("int")` → INTEGER[]) | TEXT |

## 트러블슈팅

**관계 필드가 항상 `undefined`입니다.** 관계는 선택적이며 기본적으로 로드되지 않습니다. 쿼리에서 `relations: ["author"]`로 요청하세요. 요청하지 않으면 필드를 로드하지 않습니다.

**외래 키 컬럼이 테이블에 없습니다.** `manyToOne`과 소유 측 `oneToOne`은 외래 키 컬럼을 스스로 만들지 않습니다. 외래 키를 실제 컬럼으로 선언하고 `joinColumn`이 그 컬럼을 가리키게 하세요. `authorId: t.int().name("author_id")`가 그 예입니다. 관계 옵션에 `relationColumn`을 넘겨도 됩니다.

**생명주기 훅이 실행되지 않습니다.** 훅은 인스턴스에서 실행됩니다. 평범한 객체 리터럴이 아니라 `new MyEntity({ … })`를 저장하세요. 자세한 내용은 [생명주기 훅](#생명주기-훅)을 참고하세요.

**계산 컬럼이 생성된 테이블에 없습니다.** ORM 버전을 확인하세요. 현재 버전에서는 런타임 `synchronize`가 생성 컬럼을 만듭니다. 2.0 이하에서는 마이그레이션 CLI(`migrate:generate`)에서만 DDL을 만들었습니다. 그리고 PostgreSQL은 생성 컬럼을 STORED로만 만듭니다. 구버전 SQLite는 기존 테이블에 `ALTER TABLE ADD COLUMN ... STORED`를 실행하면 거부합니다. 이 에러는 `continueOnError` 처리 방식에 따라 보고됩니다.

**정말 데코레이터 없이 동작하나요?** 모든 엔티티를 `defineEntity`나 `EntitySchema`로 정의하고 dry-run 동기화를 실행하세요. dry-run은 데이터베이스를 건드리지 않고 실행할 DDL만 로그로 남깁니다. 그래서 컴파일러가 내보낸 메타데이터 없이 모든 컬럼, 인덱스, 관계를 해석했는지 확인할 수 있습니다.

```typescript
await em.register({ entities: [User, Post, /* … */], synchronize: "dry-run" });
```

데코레이터에서 빌더와 `EntitySchema`로 옮기는 전체 매핑은 [데코레이터 없이 사용하기](./decorator-free.md)를 참고하세요. 이 페이지에는 트랜잭션과 데코레이터 없는 NestJS 주입도 있습니다.
