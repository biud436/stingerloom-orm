# 엔티티 & 컬럼 (데코레이터)

**엔티티**(Entity)는 데이터베이스 테이블을 나타내는 TypeScript 클래스입니다. 엔티티 클래스 하나는 테이블 하나에 대응합니다. 클래스의 속성은 테이블의 컬럼이 됩니다.

::: tip 코드 우선 스타일을 선호할 때
데코레이터(`@Entity`, `@Column`, …) 없이 스키마에서 엔티티 타입을 추론하고 싶다면 `defineEntity` 빌더를 설명하는 [엔티티 정의하기](./define-entity.md)를 참고하세요. 데코레이터 API와 `defineEntity`는 같은 메타데이터를 생성하므로 두 스타일을 자유롭게 섞어 써도 됩니다.
:::

코드를 작성하기 전에 엔티티가 어떤 문제를 해결하는지 먼저 살펴봅니다.

ORM이 없으면 테이블을 생성하는 SQL을 직접 작성해야 합니다. JavaScript 객체와 SQL 행 사이의 변환도 직접 해야 합니다. 컬럼을 하나 추가할 때마다 CREATE TABLE, INSERT, SELECT, 타입 정의를 모두 수정해야 합니다. 엔티티는 이런 중복을 없앱니다. TypeScript로 데이터 구조를 한 번만 정의하면 ORM이 SQL을 자동으로 생성합니다.

## 첫 번째 엔티티 만들기

데이터베이스에 사용자 정보를 저장한다고 가정해 보겠습니다. 가장 간단한 엔티티는 아래와 같습니다.

```typescript
// user.entity.ts
import { Entity, PrimaryGeneratedColumn, Column } from "@stingerloom/orm";

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;
}
```

이 코드만으로 Stingerloom은 `id`(자동 증가 기본 키)와 `name`(VARCHAR(255)) 컬럼을 가진 `user` 테이블을 생성합니다.

아래는 Stingerloom이 이 엔티티로 생성하는 실제 DDL(Data Definition Language)입니다.

**PostgreSQL:**

```sql
CREATE TABLE "user" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL
);
```

**MySQL:**

```sql
CREATE TABLE `user` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255) NOT NULL,
  PRIMARY KEY (`id`)
);
```

두 DDL의 차이를 보세요. PostgreSQL은 식별자를 큰따옴표(`"`)로 감싸고 자동 증가에 `SERIAL` 키워드를 씁니다. MySQL은 백틱과 `AUTO_INCREMENT`를 씁니다. Stingerloom이 이런 차이를 처리하므로 엔티티를 한 번만 작성하면 두 데이터베이스에서 모두 동작합니다.

세 데코레이터의 역할을 하나씩 살펴보겠습니다.

**`@Entity()`** 는 이 클래스가 ORM 엔티티임을 선언합니다. 클래스 이름 `User`는 snake_case로 자동 변환되어 테이블 이름 `user`가 됩니다. 테이블 이름을 직접 지정하려면 `name` 옵션을 넘깁니다.

```typescript
// user.entity.ts
@Entity({ name: "app_users" })
export class User {
  /* table name: app_users */
}
```

PostgreSQL에서는 `schema` 옵션으로 테이블이 속할 스키마를 엔티티에 고정합니다. 스키마를 고정한 테이블은 연결 옵션의 `schema`나 활성 테넌트 컨텍스트와 상관없이 항상 `"schema"."table"`로 참조됩니다. 테넌트마다 스키마를 두는 구성에서 테이블 하나를 모든 테넌트가 공유하게 하려면 이 방법을 씁니다. [공유 테이블](./multi-tenancy.md#공유-테이블-엔티티를-스키마에-고정하기)을 참고하세요.

```typescript
@Entity({ schema: "public" })
export class Plan {
  /* 항상 "public"."plan" */
}
```

**`@PrimaryGeneratedColumn()`** 은 자동 증가 기본 키를 정의합니다. SQL로는 아래처럼 변환됩니다.

- **PostgreSQL:** `SERIAL PRIMARY KEY` (시퀀스를 생성하고 기본값으로 설정하는 축약형)
- **MySQL:** `INT NOT NULL AUTO_INCREMENT PRIMARY KEY`

INSERT할 때 값을 넘기지 않아도 데이터베이스가 1, 2, 3... 순서로 값을 자동으로 채웁니다.

```sql
-- 다음과 같이 작성하면:
INSERT INTO "user" ("name") VALUES ('Alice');
-- DB가 자동으로 id = 1을 채워 넣음

-- 다음과 같이 작성하면:
INSERT INTO "user" ("name") VALUES ('Bob');
-- DB가 자동으로 id = 2를 채워 넣음
```

**`@Column()`** 은 일반 컬럼을 정의합니다. 속성의 TypeScript 타입을 보고 알맞은 데이터베이스 타입을 자동으로 추론합니다. 예를 들어 `string`은 `VARCHAR(255)`가 되고 `number`는 `INT`가 됩니다. 이 추론에는 TypeScript의 `emitDecoratorMetadata` 컴파일러 옵션이 만드는 `design:type` 메타데이터를 씁니다.

> 힌트: `!:`는 확정 할당 단언(definite assignment assertion) 구문입니다. 이 구문은 TypeScript에 "이 속성은 ORM이 관리하므로 초기화하지 않아도 된다"고 알립니다.

## 다양한 컬럼 타입 사용

실제 애플리케이션에는 문자열과 숫자 말고도 여러 타입이 필요합니다. 원하는 컬럼 타입은 `@Column()`의 `type` 옵션으로 지정합니다.

```typescript
// product.entity.ts
@Entity()
export class Product {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string; // VARCHAR(255) auto-inferred

  @Column({ type: "text" })
  description!: string; // TEXT (long strings)

  @Column({ type: "float" })
  price!: number; // FLOAT

  @Column({ type: "boolean" })
  isAvailable!: boolean; // TINYINT(1) / BOOLEAN

  @Column({ type: "datetime" })
  releaseDate!: Date; // DATETIME / TIMESTAMP
}
```

**PostgreSQL DDL:**

```sql
CREATE TABLE "product" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL,
  "description" TEXT NOT NULL,
  "price" REAL NOT NULL,
  "isAvailable" BOOLEAN NOT NULL,
  "releaseDate" TIMESTAMP NOT NULL
);
```

**MySQL DDL:**

```sql
CREATE TABLE `product` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255) NOT NULL,
  `description` TEXT NOT NULL,
  `price` FLOAT NOT NULL,
  `isAvailable` TINYINT(1) NOT NULL,
  `releaseDate` DATETIME NOT NULL,
  PRIMARY KEY (`id`)
);
```

`type`을 생략하면 TypeScript 타입에서 자동으로 추론됩니다. 하지만 같은 `string`이라도 짧은 이름에는 `varchar`가 맞고 긴 본문에는 `text`가 맞습니다. 그래서 용도에 따라 타입을 명시하는 편이 좋습니다. `VARCHAR(255)` 컬럼에는 255자라는 엄격한 상한이 있습니다. 반면 `TEXT` 컬럼에는 메가바이트 단위의 콘텐츠도 저장됩니다.

> 힌트: Stingerloom의 컬럼 타입은 특정 데이터베이스에 묶이지 않습니다. 예를 들어 `"boolean"`은 MySQL에서 `TINYINT(1)`로 변환되고 PostgreSQL에서 `BOOLEAN`으로 변환됩니다. 전체 매핑 표는 이 문서 아래쪽의 [ColumnType 참조](#columntype-참조)에 있습니다.

## 컬럼 옵션 설정

`@Column()`은 컬럼의 세부 동작을 제어하는 옵션을 받습니다.

### 길이 지정

문자열 컬럼의 최대 길이를 지정합니다. 생략하면 `varchar`의 기본 길이는 255입니다.

```typescript
@Column({ type: "varchar", length: 100 })
sku!: string;
```

이 설정은 DDL에서 `VARCHAR(100)`을 생성합니다. 100자보다 긴 문자열을 삽입하면 데이터베이스가 에러를 내고 삽입을 거부합니다.

### NULL 허용

기본적으로 모든 컬럼은 `NOT NULL`입니다. 데이터베이스는 컬럼을 NULL로 설정하는 INSERT와 UPDATE를 모두 거부합니다. 이 제약은 실수로 데이터가 빠진 채 저장되는 일을 막는 안전장치입니다.

값이 없을 수도 있는 컬럼이라면 `nullable: true`를 설정하세요.

```typescript
@Column({ type: "varchar", length: 255, nullable: true })
bio!: string | null;
```

이 설정은 DDL에서 `NOT NULL` 제약 조건이 없는 `VARCHAR(255)`를 생성합니다. TypeScript 타입에도 `| null`을 추가하면 코드에서 null 검사를 자연스럽게 하게 됩니다.

속성 타입이 유니온이라면 `type`을 반드시 직접 적어 주세요. `strictNullChecks`가 켜져 있으면 tsc는 `string | null`을 데코레이터 메타데이터에 `Object`로 기록합니다. ORM은 이 값을 `Date | null`이나 `Record<string, unknown>`과 구분하지 못합니다. 그래서 `@Column({ nullable: true }) bio!: string | null`은 `VARCHAR(255)`가 아니라 `text`로 추론되고 `Unknown design:type "Object"` 경고가 출력됩니다. 자세한 내용은 [문제 해결 가이드](./troubleshooting.md)에서 컬럼이 뜻하지 않게 `text`가 되는 항목을 참고하세요.

### 컬럼 이름 별칭

속성 이름과 실제 데이터베이스 컬럼 이름을 다르게 하려면 `name` 옵션을 씁니다. TypeScript에서는 camelCase를 쓰고 데이터베이스에서는 snake_case를 쓸 때 흔히 사용합니다.

```typescript
@Column({ name: "unit_price", type: "float" })
price!: number;
// TypeScript: product.price / DB column: unit_price
```

DDL에서 컬럼 이름은 `unit_price`가 됩니다. Stingerloom은 SELECT 쿼리를 만들 때 `unit_price` 컬럼을 TypeScript 객체의 `price` 속성에 매핑합니다.

### 기본값

컬럼의 기본값은 `default` 옵션으로 설정합니다. 문자열, 숫자, 불리언 같은 리터럴 값은 그대로 사용됩니다. 함수 같은 SQL 표현식을 쓰려면 괄호로 감쌉니다.

```typescript
@Column({ default: "active" })
status!: string;

@Column({ default: 0 })
retryCount!: number;

@Column({ default: true })
isVisible!: boolean;

@Column({ default: "(CURRENT_TIMESTAMP)" })
createdAt!: Date;
```

이 컬럼들이 생성하는 DDL은 아래와 같습니다.

**PostgreSQL:**

```sql
"status" VARCHAR(255) NOT NULL DEFAULT 'active',
"retryCount" INTEGER NOT NULL DEFAULT 0,
"isVisible" BOOLEAN NOT NULL DEFAULT TRUE,
"createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
```

**MySQL:**

```sql
`status` VARCHAR(255) NOT NULL DEFAULT 'active',
`retryCount` INT NOT NULL DEFAULT 0,
`isVisible` TINYINT(1) NOT NULL DEFAULT 1,
`createdAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
```

`"(CURRENT_TIMESTAMP)"`처럼 값을 괄호로 감싸면 Stingerloom은 그 값을 따옴표로 감싼 문자열 리터럴이 아니라 raw SQL `DEFAULT` 표현식으로 DDL에 출력합니다. 괄호가 없으면 `"CURRENT_TIMESTAMP"`는 SQL 함수가 아니라 리터럴 문자열 `'CURRENT_TIMESTAMP'`로 처리됩니다.

### JSON 컬럼

컬럼 하나에 구조화된 데이터를 저장하려면 JSON 타입을 쓰세요. 사용자 환경설정이나 설정처럼 형태가 자유롭고 스키마가 없는 데이터에 유용합니다.

```typescript
@Column({ type: "json", nullable: true })
settings!: Record<string, unknown> | null;
```

**PostgreSQL:** `"settings" JSON` (인덱싱되는 바이너리 JSON을 쓰려면 `"jsonb"` 사용)
**MySQL:** `` `settings` JSON ``

PostgreSQL에서는 `json`과 `jsonb`의 차이가 중요합니다. `jsonb`는 분해된 바이너리 형식으로 저장되므로 입력은 느리지만 쿼리는 훨씬 빠릅니다. `WHERE settings->>'theme' = 'dark'`처럼 JSON 내부를 쿼리해야 한다면 `jsonb`를 쓰세요.

#### 자동 stringify / parse

`type: "json" | "jsonb"` 컬럼에 명시적인 `transformer`가 없으면 Stingerloom이 양방향 기본 변환을 자동으로 설치합니다.

- **쓰기**: 문자열이 아닌 값은 드라이버에 전달되기 전에 `JSON.stringify`로 직렬화됩니다. 문자열은 그대로 통과합니다. 그래서 직접 stringify하던 레거시 코드의 값이 이중으로 인코딩되지 않습니다. `null`과 `undefined`는 그대로 보존됩니다.
- **읽기**: mysql2와 better-sqlite3처럼 드라이버가 문자열을 반환하면 `JSON.parse`로 복원합니다. PostgreSQL `jsonb`처럼 이미 객체로 반환되는 값은 그대로 통과합니다. 깨진 레거시 행은 경고를 한 번 남기고 원본 문자열을 반환합니다. 그래서 `find()`가 실패하지 않습니다.

이 기본 변환 덕분에 일반 JS 값을 그대로 대입하면 됩니다.

```typescript
issue.customFields = { priority: "high", labels: ["bug"] };
await em.save(Issue, issue);

const loaded = await em.findOne(Issue, { where: { id } });
loaded.customFields.priority; // "high": 드라이버와 상관없이 이미 객체입니다
```

명시적인 `transformer`는 해당 방향의 기본 변환을 덮어씁니다. `to`나 `from` 하나만 지정하면 지정하지 않은 방향에는 기본 변환이 그대로 적용됩니다.

> 마이그레이션 메모: `JSON.stringify(value) as any`처럼 직접 직렬화하던 기존 코드는 그대로 동작합니다. 문자열은 그대로 통과하기 때문입니다. 준비가 되면 직접 stringify하는 코드를 제거해도 같은 값이 저장됩니다.

### 값 변환

`transform` 옵션을 쓰면 데이터베이스에서 읽은 값을 TypeScript 객체로 매핑할 때 변환 함수를 적용합니다. MySQL의 `TINYINT(1)`처럼 불리언이 숫자로 저장되는 경우에 유용합니다.

```typescript
@Column({ transform: (raw) => raw === 1 })
isActive!: boolean;
```

Stingerloom은 데이터베이스에서 행을 읽을 때 원시 `isActive` 값을 이 함수에 통과시킵니다. 원시 숫자 `1`은 `true`가 되고 `0`은 `false`가 됩니다.

### 컬럼 트랜스포머

위의 `transform` 옵션은 데이터베이스에서 읽을 때 한 방향으로만 동작합니다. 하지만 실제로는 저장할 때와 읽을 때 모두 값을 변환해야 하는 경우가 많습니다.

이메일 주소를 예로 들어 보겠습니다. `Alice@Example.com`과 `alice@example.com`은 같은 주소로 다뤄야 합니다. 그래서 중복을 막으려고 모든 이메일을 소문자로 저장하려 합니다. 트랜스포머가 없으면 모든 INSERT와 UPDATE 전에 `.toLowerCase()`를 호출해야 합니다. 한 번이라도 빠뜨리면 데이터의 일관성이 깨집니다. 컬럼 트랜스포머는 변환을 컬럼 정의에 한 번만 선언해서 이 문제를 해결합니다.

```typescript
@Column({
  type: "varchar",
  transformer: {
    to: (value: string) => value.toLowerCase(),   // before INSERT/UPDATE
    from: (value: string) => value.toUpperCase(),  // after SELECT
  },
})
email: string;
```

`to` 함수는 INSERT와 UPDATE 전에 항상 자동으로 실행됩니다. `from` 함수는 SELECT 뒤에 항상 자동으로 실행되고 원시 데이터베이스 값을 애플리케이션에서 쓰는 형식으로 다시 변환합니다.

SQL에서는 아래처럼 동작합니다.

```typescript
await em.save(User, { email: "Alice@Example.COM" });
// The transformer.to runs first: "Alice@Example.COM" → "alice@example.com"
// Generated SQL:
// INSERT INTO "user" ("email") VALUES ('alice@example.com')

const user = await em.findOne(User, { where: { id: 1 } });
// DB returns: { email: "alice@example.com" }
// The transformer.from runs: "alice@example.com" → "ALICE@EXAMPLE.COM"
// user.email === "ALICE@EXAMPLE.COM"
```

암호화도 흔한 사용 사례입니다. 민감한 데이터를 데이터베이스에 저장하기 전에 암호화하고 읽을 때 복호화합니다.

```typescript
@Column({
  type: "text",
  transformer: {
    to: (value: string) => encrypt(value),   // plaintext → ciphertext
    from: (value: string) => decrypt(value), // ciphertext → plaintext
  },
})
ssn: string;
```

데이터베이스에는 암호문이 저장됩니다. 애플리케이션 코드는 평문을 다룹니다. 나머지 코드는 이 변환을 의식하지 않아도 됩니다.

필터와 집계는 하이드레이트된 속성과 같은 표현을 씁니다. 그래서 저장된 값이 아니라 코드가 가진 값으로 비교하고 합산하면 됩니다. 경로별로 트랜스포머가 적용되는 방식은 아래 표와 같습니다.

| 경로 | 동작 |
|------|------|
| `save` / `insertMany` / `upsert` 계열 / `updateMany` data | `to` |
| 하이드레이트 (`find`, `findOne`, `pluck`, 쿼리 빌더 `getMany`) | `from` |
| where: 동등 비교, `eq` / `ne` / `not`, `gt` / `gte` / `lt` / `lte`, `in` / `notIn`, 배열 축약형, `between` | 원소마다 `to` |
| where: `like` / `notLike` / `ilike` / `contains` / `startsWith` / `endsWith` / `search` | 적용하지 않습니다. 패턴은 저장 표현으로 작성하세요 |
| where: `null`, `isNull`, raw `sql` 조각, QueryDSL(`qAlias`) 조건 | 적용하지 않습니다 |
| `sum` / `avg` / `min` / `max` (EntityManager와 쿼리 빌더) | 결과에 `from` |
| `count` / `exists` | 행 개수라서 변환하지 않습니다 |
| 커서 인코딩, `orderBy` | 저장된 값 |
| `increment` / `decrement` | 저장된 값을 그대로 계산하는 raw 연산 |

where 규칙은 `find`, `findOne`, `count`, `exists`, 집계, `findWithCursor`, `updateMany` / `delete` / `softDelete` / `restore`의 조건에 적용됩니다. 쿼리 빌더의 `where(column, value)`, `where(column, operator, value)`, `whereIn`, where 객체 형태에도 적용됩니다. 범위 연산자는 `to`가 값의 순서를 보존한다고 가정합니다. `sum` / `avg`는 `from`이 센트를 원 단위로 바꾸는 것 같은 선형 변환이라고 가정합니다. `min` / `max`는 순서만 보존되면 됩니다. `from`이 유한한 숫자를 반환하지 않는 집계는 저장된 값을 그대로 반환합니다. 내장 JSON 직렬화는 바인드 형식이므로 이 규칙과 관계가 없습니다.

읽기 전용인 레거시 `transform` 옵션은 하위 호환을 위해 지금도 동작합니다. 같은 컬럼에 `transform`과 `transformer`를 모두 설정하면 읽기 방향에서는 `transformer.from`이 우선합니다. `transform` 옵션은 deprecated입니다. 새 코드에서는 항상 `transformer`를 쓰세요.

```typescript
// Legacy (read-only, deprecated):
@Column({ transform: (raw) => raw === 1 })

// Modern (bidirectional, recommended):
@Column({
  transformer: {
    to: (value: boolean) => value ? 1 : 0,
    from: (raw: number) => raw === 1,
  },
})
```

### PostgreSQL ENUM

PostgreSQL에서는 커스텀 ENUM 타입을 지원합니다. ENUM은 컬럼 값을 고정된 허용 값 집합으로 제한합니다. 이 제한은 데이터베이스가 직접 강제합니다.

```typescript
@Column({
  type: "enum",
  enumValues: ["draft", "published", "archived"],
  enumName: "post_status",
})
status!: string;
```

이 설정은 PostgreSQL에서 SQL 문 두 개를 생성합니다.

```sql
-- First, create the custom type
CREATE TYPE "post_status" AS ENUM ('draft', 'published', 'archived');

-- Then use it in the column definition
"status" "post_status" NOT NULL
```

> 힌트: `enumName`을 생략하면 타입 이름이 `{tableName}_{columnName}_enum` 형식으로 자동 생성됩니다.

`synchronize`는 이 타입을 참조하는 테이블보다 타입을 먼저 생성합니다. 나중에 `enumValues`에 추가한 값은 `ALTER TYPE ... ADD VALUE`로 반영합니다. 반대로 제거한 값은 데이터베이스에 그대로 남습니다. PostgreSQL은 enum 값을 그 자리에서 삭제하지 못하기 때문입니다. 그래서 ORM은 제거를 실행하지 않고 경고로 알립니다. 모드별 동작은 [설정](./configuration.md#postgresql-enum-타입)을 참고하세요.

## 수동 기본 키 (@PrimaryColumn)

기본 키 값을 자동 증가 대신 직접 지정해야 하는 경우가 있습니다. 키 자체가 의미 있는 문자열인 키-값 설정 테이블이 그 예입니다.

```typescript
// config.entity.ts
import { Entity, PrimaryColumn, Column } from "@stingerloom/orm";

@Entity()
export class Config {
  @PrimaryColumn({ type: "varchar", length: 64 })
  key!: string;

  @Column({ type: "text" })
  value!: string;
}
```

**PostgreSQL DDL:**

```sql
CREATE TABLE "config" (
  "key" VARCHAR(64) NOT NULL,
  "value" TEXT NOT NULL,
  PRIMARY KEY ("key")
);
```

`@PrimaryColumn()`은 AUTO_INCREMENT나 SERIAL을 적용하지 않습니다. 그래서 `save()`를 호출할 때 키 값을 직접 넘겨야 합니다.

```typescript
await em.save(Config, { key: "site.title", value: "My Blog" });
// INSERT INTO "config" ("key", "value") VALUES ('site.title', 'My Blog')
```

같은 키로 다시 `save()`하면 그 행을 UPDATE합니다. 키를 직접 정하는 엔티티는 `save()`가 행이 있는지 먼저 확인한 뒤 INSERT와 UPDATE 중 하나를 고릅니다.

## 인덱스로 쿼리 성능 개선

### 인덱스가 필요한 이유

책이 1,000만 권 있는데 목록이 없는 도서관을 떠올려 보세요. 저자로 책을 찾으려면 모든 서가를 돌며 모든 책을 확인해야 합니다. 인덱스가 없는 데이터베이스도 이렇게 동작합니다. 테이블의 모든 행을 스캔합니다. 이를 풀 테이블 스캔(full table scan)이라고 합니다.

**인덱스**는 도서관의 카드 목록과 같습니다. 인덱스는 정렬된 데이터 구조를 유지합니다. 그래서 데이터베이스는 조건에 맞는 행으로 바로 이동합니다. 이 구조로는 보통 **B-tree**를 씁니다. B-tree는 디스크 읽기에 최적화된 균형 트리입니다. 행이 100만 개인 테이블에서 풀 스캔으로 5초 걸리던 쿼리가 인덱스를 쓰면 5밀리초로 줄어들 수 있습니다.

대신 비용이 있습니다. 인덱스는 디스크 공간을 차지합니다. 그리고 INSERT와 UPDATE 때 인덱스도 갱신해야 하므로 쓰기가 약간 느려집니다. 그래서 WHERE, JOIN, ORDER BY 절에 자주 나오는 컬럼에만 인덱스를 추가하세요. 모든 컬럼에 인덱스를 만들지는 마세요.

> 이미 있는 테이블에서 `synchronize`는 새로 추가한 인덱스를 생성합니다. 하지만 기존 인덱스를 삭제하거나 다시 정의하지는 않습니다. 엔티티에서 인덱스를 빼거나 인덱스의 컬럼을 바꿨다면 옛 인덱스는 마이그레이션으로 삭제하세요. 남아 있는 고유 인덱스는 계속 행을 거부합니다. `migrate:generate`는 기존 테이블의 인덱스 DDL을 전혀 작성하지 않습니다. [Schema Diff가 비교하지 않는 것](./migrations.md#schema-diff가-비교하지-않는-항목)을 참고하세요.

### 단일 컬럼 인덱스

자주 검색하는 컬럼에 인덱스를 추가하면 쿼리가 크게 빨라집니다. 이메일로 사용자를 검색하는 경우를 예로 들어 보겠습니다.

```typescript
// user.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
} from "@stingerloom/orm";

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index()
  @Column()
  email!: string;
}
```

`@Index()`를 추가하면 테이블을 생성한 뒤 아래 DDL도 생성됩니다.

```sql
-- PostgreSQL
CREATE INDEX "INDEX_user_email" ON "user" ("email");

-- MySQL
CREATE INDEX `INDEX_user_email` ON `user` (`email`);
```

이제 ORM이 아래 쿼리를 실행하는 경우를 보겠습니다.

```sql
SELECT * FROM "user" WHERE "email" = 'alice@example.com';
```

데이터베이스는 모든 행을 스캔하지 않고 B-tree 인덱스를 탐색해서 O(log n) 시간에 조건에 맞는 행을 찾습니다.

### 복합 인덱스 (클래스 수준 @Index)

`@Index()`를 클래스 수준 데코레이터로 쓰면 여러 컬럼으로 구성된 비고유 복합 인덱스를 만듭니다. 여러 컬럼으로 동시에 필터링하는 쿼리에 유용합니다.

```typescript
// order.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
} from "@stingerloom/orm";

@Index(["tenantId", "status"])
@Entity()
export class Order {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "int" })
  tenantId!: number;

  @Column({ type: "varchar", length: 50 })
  status!: string;
}
```

이 설정은 아래 DDL을 생성합니다.

```sql
-- PostgreSQL
CREATE INDEX "idx_order_tenantId_status" ON "order" ("tenantId", "status");
```

복합 인덱스는 성으로 먼저 정렬하고 같은 성 안에서 이름으로 정렬한 전화번호부와 같습니다. 데이터베이스는 이 인덱스를 아래 쿼리에 씁니다.

- `WHERE tenantId = 5` (가장 왼쪽 컬럼 사용)
- `WHERE tenantId = 5 AND status = 'pending'` (두 컬럼을 모두 사용하므로 가장 효율적)

하지만 `WHERE status = 'pending'`만으로는 이 인덱스를 효율적으로 쓰지 못합니다. 가장 왼쪽 컬럼을 건너뛰는 것은 성으로 먼저 정렬된 전화번호부에서 이름이 "John"인 사람을 모두 찾는 것과 같기 때문입니다.

인덱스 이름을 직접 지정하려면 두 번째 인자로 넘깁니다.

```typescript
@Index(["tenantId", "status"], "idx_custom_name")
```

> 힌트: 속성 수준 `@Index()`는 단일 컬럼 인덱스를 생성합니다. 클래스 수준 `@Index(columns)`는 복합 인덱스를 생성합니다. 한 엔티티에 두 방식을 함께 써도 됩니다.

### 복합 고유 인덱스 (@UniqueIndex)

여러 컬럼의 조합이 고유해야 할 때가 있습니다. 슬러그가 같은 카테고리 안에서만 고유하면 되는 경우가 그 예입니다.

```typescript
// post.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  UniqueIndex,
} from "@stingerloom/orm";

@UniqueIndex(["categoryId", "slug"])
@Entity()
export class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  categoryId!: number;

  @Column()
  slug!: string;
}
```

이 설정은 아래 DDL을 생성합니다.

```sql
-- PostgreSQL
CREATE UNIQUE INDEX "UQ_post_categoryId_slug" ON "post" ("categoryId", "slug");
```

이 고유 인덱스가 있으면 아래 데이터는 허용됩니다.

| categoryId | slug        |
| ---------- | ----------- |
| 1          | hello-world |
| 2          | hello-world |

하지만 아래 데이터는 데이터베이스가 거부합니다.

| categoryId | slug        |
| ---------- | ----------- |
| 1          | hello-world |
| 1          | hello-world |

인덱스 이름을 직접 지정하려면 두 번째 인자로 넘깁니다.

```typescript
@UniqueIndex(["categoryId", "slug"], "uq_post_category_slug")
```

> 힌트: `@UniqueIndex`와 `@Index(columns)`는 둘 다 클래스 수준 데코레이터입니다. 인자 없는 속성 수준 `@Index()`는 개별 속성에 붙입니다.

### 고급 인덱스 옵션

컬럼에 거는 기본 B-tree 인덱스가 가장 흔합니다. 하지만 실제 데이터베이스에는 더 특화된 인덱스도 필요합니다. 쿼리 패턴이 다르면 알맞은 인덱스 전략도 다릅니다.

**부분 인덱스**는 일부 행만 인덱싱해서 디스크 공간을 아끼고 성능을 높입니다. 사용자의 90%가 활성 상태이고 비활성 사용자는 거의 조회하지 않는다면 모든 사용자를 인덱싱할 필요가 없습니다.

**표현식 인덱스**는 계산한 값을 인덱싱합니다. 표현식 인덱스가 없으면 `WHERE LOWER(email) = 'alice@example.com'`은 `email` 컬럼의 일반 인덱스를 쓰지 못합니다. 일반 인덱스에는 대소문자가 섞인 원래 값이 저장되기 때문입니다.

**GIN 인덱스**는 JSONB 데이터 내부 검색과 전문 검색을 빠르게 합니다. **BRIN 인덱스**는 매우 작은 인덱스입니다. 값의 순서가 행의 물리적 순서와 자연스럽게 맞는 시계열 데이터에 씁니다.

이 인덱스들은 모두 클래스 수준 `@Index` 데코레이터의 두 번째 인자인 `AdvancedIndexOptions` 객체로 설정합니다.

#### 부분 인덱스

부분 인덱스에는 `WHERE` 조건에 맞는 행만 들어갑니다. 소프트 삭제를 쓰는 테이블에서 거의 항상 삭제되지 않은 행만 조회할 때 유용합니다.

```typescript
@Entity()
@Index(["email"], { where: "deleted_at IS NULL" })
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  email!: string;

  @DeletedAt()
  deletedAt!: Date | null;
}
```

**PostgreSQL DDL:**

```sql
CREATE INDEX "idx_user_email" ON "user" ("email") WHERE deleted_at IS NULL;
```

이 인덱스는 소프트 삭제된 행을 제외하므로 전체 인덱스보다 작습니다. `WHERE email = '...' AND deleted_at IS NULL` 조건의 쿼리가 이 인덱스를 바로 씁니다.

> 참고: 부분 인덱스는 PostgreSQL과 SQLite에서 지원됩니다. MySQL은 인덱스의 `WHERE` 절을 지원하지 않습니다.

#### 표현식 인덱스

표현식 인덱스는 원시 컬럼 값이 아니라 표현식의 결과를 인덱싱합니다. 대소문자를 구분하지 않는 이메일 조회에는 꼭 필요합니다.

```typescript
@Entity()
@Index([], { expression: "LOWER(email)" })
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  email!: string;
}
```

**PostgreSQL DDL:**

```sql
CREATE INDEX "idx_user_lower_email" ON "user" ((LOWER(email)));
```

이제 `WHERE LOWER(email) = 'alice@example.com'` 쿼리는 풀 테이블 스캔 대신 이 인덱스를 씁니다. 표현식이 컬럼 목록을 대신하므로 컬럼 배열은 빈 배열 `[]`입니다.

#### 인덱스 타입 (USING)

데이터베이스는 기본으로 B-tree 인덱스를 생성합니다. B-tree는 동등 비교와 범위 쿼리에 가장 알맞습니다. 하지만 특수한 용도에 맞는 다른 인덱스 타입도 있습니다.

```typescript
@Entity()
@Index(["metadata"], { using: "gin" })
export class Product {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "jsonb" })
  metadata!: Record<string, unknown>;
}
```

**PostgreSQL DDL:**

```sql
CREATE INDEX "idx_product_metadata" ON "product" USING gin ("metadata");
```

이 GIN(Generalized Inverted Index) 인덱스는 JSONB 데이터의 `@>` 포함 쿼리를 빠르게 합니다.

```sql
-- Find products where metadata contains {"color": "red"}
SELECT * FROM "product" WHERE "metadata" @> '{"color": "red"}';
-- Uses the GIN index instead of scanning every row
```

사용 가능한 인덱스 타입은 아래와 같습니다.

| 타입    | 적합한 용도                  | PostgreSQL | MySQL  |
| ------- | ---------------------------- | ---------- | ------ |
| `btree` | 동등, 범위, 정렬 (기본값)    | 지원       | 지원   |
| `hash`  | 동등만 (범위 불가)           | 지원       | 지원   |
| `gin`   | JSONB, 배열, 전문 검색       | 지원       | 미지원 |
| `gist`  | 기하학, 전문 검색, 범위 타입 | 지원       | 미지원 |
| `brin`  | 대규모 시계열 테이블         | 지원       | 미지원 |

> 참고: MySQL은 `btree`와 `hash`만 지원합니다. `gin`, `gist`, `brin`을 지정한 채 MySQL에서 실행하면 인덱스 생성이 실패합니다.

#### 커버링 인덱스 (INCLUDE)

커버링 인덱스는 인덱싱한 컬럼과 함께 추가 컬럼을 저장합니다. 그래서 데이터베이스가 메인 테이블을 읽지 않고 인덱스만으로 쿼리를 처리합니다. 이를 인덱스 전용 스캔(index-only scan)이라고 합니다.

```typescript
@Entity()
@Index(["email"], { include: ["name"] })
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  email!: string;

  @Column()
  name!: string;
}
```

**PostgreSQL DDL:**

```sql
CREATE INDEX "idx_user_email" ON "user" ("email") INCLUDE ("name");
```

이제 `SELECT name FROM "user" WHERE email = 'alice@example.com'` 같은 쿼리는 힙에 접근하지 않고 인덱스만으로 처리됩니다. 힙은 메인 테이블의 데이터를 저장하는 영역입니다. `INCLUDE` 컬럼은 인덱스 리프 페이지에 저장되지만 검색 키에는 포함되지 않습니다.

> 참고: `INCLUDE`를 쓰는 커버링 인덱스는 PostgreSQL 11 이상에서 지원됩니다. MySQL은 `INCLUDE` 절을 지원하지 않습니다.

#### 옵션 결합

고급 인덱스 옵션은 함께 써도 됩니다. 아래는 부분 커버링 인덱스의 예입니다.

```typescript
@Index(["email"], {
  where: "deleted_at IS NULL",
  include: ["name"],
  name: "idx_active_user_email",
})
```

**PostgreSQL DDL:**

```sql
CREATE INDEX "idx_active_user_email" ON "user" ("email") INCLUDE ("name") WHERE deleted_at IS NULL;
```

이 설정은 작고 빠른 인덱스를 생성합니다. 이 인덱스에는 활성 사용자만 들어갑니다. 그리고 인덱스 전용 스캔을 위해 name 컬럼도 함께 저장합니다.

## JSON 경로 인덱스 (@JsonIndex)

### @JsonIndex가 필요한 이유

인덱스가 없는 `jsonb` 컬럼은 모든 쿼리에서 순차 스캔을 합니다. 행이 100만 개인 테이블에서 `WHERE data @> '{"tags":["typescript"]}'`를 실행해도 마찬가지입니다. PostgreSQL은 `CREATE INDEX ... USING GIN ((data->'tags') jsonb_path_ops)`처럼 JSON 경로에 거는 표현식 인덱스를 지원합니다. 하지만 이 인덱스를 직접 작성하면 마이그레이션 SQL이 특정 경로와 opclass에 묶입니다. 그러면 엔티티가 바뀌어도 마이그레이션 SQL은 그대로 남아 엔티티와 어긋납니다.

`@JsonIndex`는 이 인덱스를 속성에 선언합니다. 그러면 스키마 생성기가 올바른 DDL을 생성합니다. 그리고 `u.profile.tags.contains(...)` 같은 QueryDSL 경로 연산이 데이터베이스가 실제로 쓰는 인덱스 경로와 일치합니다.

### 동작 방식

```typescript
import { Entity, PrimaryGeneratedColumn, Column, JsonIndex } from "@stingerloom/orm";

@Entity()
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  // @> / ? 쿼리를 위한 서브패스 GIN 인덱스
  @Column({ type: "jsonb" })
  @JsonIndex({ path: "tags", using: "gin", opclass: "jsonb_path_ops" })
  profile!: { tags: string[]; contact: { email: string } };
}
```

**PostgreSQL DDL:**

```sql
CREATE INDEX "idx_user_profile_tags_gin"
  ON "user" USING gin ((profile -> 'tags') jsonb_path_ops);
```

### 옵션 레퍼런스

| 옵션 | 타입 | 기본값 | 설명 |
|---|---|---|---|
| `path` | `string?` | *(전체 컬럼)* | 컬럼 안의 dot-bracket 경로입니다. `"tags"`, `"contact.email"`, `"tags[0]"`처럼 씁니다. 생략하면 컬럼 전체에 인덱스를 겁니다. |
| `using` | `"gin" \| "btree"` | `"gin"` | `gin`은 포함(`@>`) 검사와 키 존재(`?`) 검사에 씁니다. `btree`는 리프 스칼라 경로의 동등 비교와 범위 비교에 씁니다. |
| `opclass` | `"jsonb_ops" \| "jsonb_path_ops"` | `"jsonb_ops"` | 인덱스를 `@>`에만 쓴다면 `jsonb_path_ops`가 더 작고 빠릅니다. `btree`에서는 무시됩니다. |
| `where` | `string?` | 없음 | 부분 인덱스의 `WHERE` 절이며 raw SQL로 씁니다. 식별자 래핑과 파라미터 안전성은 호출자가 책임집니다. |
| `name` | `string?` | *자동* | 인덱스 이름을 직접 지정합니다. 생략하면 `NamingStrategy.jsonIndexName()`으로 자동 생성됩니다. |

### 패턴

**전체 컬럼 GIN**: 그 컬럼의 모든 `@>` / `?` / `?&` 쿼리를 커버합니다. 대신 인덱스가 더 큽니다.

```typescript
@Column({ type: "jsonb" })
@JsonIndex({ using: "gin" })
profile!: UserProfile;
```

**텍스트 경로에 리프 btree**: 스칼라 리프 하나의 동등 비교와 범위 쿼리에 씁니다.

```typescript
@Column({ type: "jsonb" })
@JsonIndex({ path: "contact.email", using: "btree" })
profile!: UserProfile;
```

이 설정은 `CREATE INDEX ... ON "user" (((profile #>> '{contact,email}')))`를 생성합니다.

**부분 인덱스**: 조건에 맞을 일이 없는 행은 인덱스에서 뺍니다.

```typescript
@Column({ type: "jsonb" })
@JsonIndex({
  path: "tags",
  using: "gin",
  opclass: "jsonb_path_ops",
  where: `"deleted_at" IS NULL`,
})
profile!: UserProfile;
```

### 다이얼렉트 동작

| 드라이버 | 동작 |
|---|---|
| PostgreSQL | GIN에는 `CREATE INDEX ... USING gin ((col -> 'path') [jsonb_path_ops])`를 생성하고 btree에는 `((col #>> '{path}'))`를 생성합니다. |
| MySQL | DDL을 생성하지 않습니다. MySQL 8은 가상 생성 컬럼으로만 JSON 함수형 인덱스를 지원합니다. 이는 인덱스 선언을 넘어서는 구조적 스키마 변경입니다. DDL을 생성할 때 경고가 남습니다. 필요하다면 생성 컬럼과 인덱스를 직접 작성하세요. |
| SQLite | DDL을 생성하지 않습니다. SQLite에는 GIN에 해당하는 인덱스가 없습니다. |

### QueryDSL과 함께 쓰기

QueryDSL의 JSON 연산자는 인덱스를 만든 경로 표현식과 같은 SQL로 컴파일됩니다. 그래서 플래너가 그 인덱스를 쓸 수 있습니다.

```typescript
const u = qAlias(User, "u");

const users = await em
  .createQueryBuilder(User, "u")
  .where(u.profile.tags.contains("typescript"))
  .getMany();
// PostgreSQL: WHERE profile -> 'tags' @> '"typescript"'::jsonb
// 사용 인덱스: idx_user_profile_tags_gin
```

전체 연산자 목록은 [Query Builder: JSON 경로 연산자](/ko/query-builder-json)를 참고하세요.

## 낙관적 잠금 (@Version)

### 낙관적 잠금이 필요한 이유

고객 상담원 두 명이 오전 10:00에 같은 주문을 연다고 가정해 보겠습니다. 상담원 A는 10:01에 상태를 "배송됨"으로 변경합니다. 상담원 B는 여전히 이전 데이터를 보고 있다가 10:02에 상태를 "환불됨"으로 변경합니다. 상담원 B의 갱신이 경고 없이 상담원 A의 변경을 덮어씁니다. 이를 **갱신 손실 문제**(lost update problem)라고 합니다.

한 가지 해결책은 **비관적 잠금**입니다. 비관적 잠금은 행을 잠가서 다른 누구도 수정하지 못하게 합니다. 하지만 느리고 데드락을 일으킬 수 있습니다. 대부분의 애플리케이션에는 **낙관적 잠금**이 더 알맞습니다. 낙관적 잠금은 충돌이 드물다고 가정하고 충돌이 일어나면 감지합니다.

### 동작 방식

`@Version()` 데코레이터를 쓰면 엔티티에 버전 카운터가 추가됩니다.

```typescript
// order.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Version,
} from "@stingerloom/orm";

@Entity()
export class Order {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  status!: string;

  @Version()
  version!: number;
}
```

**생성되는 DDL:**

```sql
-- PostgreSQL
CREATE TABLE "order" (
  "id" SERIAL PRIMARY KEY,
  "status" VARCHAR(255) NOT NULL,
  "version" INTEGER NOT NULL
);
```

SQL에서는 아래처럼 동작합니다.

INSERT할 때 ORM은 `version = 1`을 자동으로 설정합니다.

```sql
INSERT INTO "order" ("status", "version") VALUES ('pending', 1);
```

UPDATE할 때 ORM은 `WHERE version = N`을 추가하고 버전을 1 올립니다.

```sql
-- Agent A reads the order: { id: 1, status: 'pending', version: 1 }
-- Agent A updates it:
UPDATE "order"
SET "status" = 'shipped', "version" = "version" + 1
WHERE "id" = 1 AND "version" = 1;
-- This succeeds (1 row affected). version is now 2.

-- Agent B also read version 1, tries to update:
UPDATE "order"
SET "status" = 'refunded', "version" = "version" + 1
WHERE "id" = 1 AND "version" = 1;
-- This fails (0 rows affected) because version is now 2.
-- Stingerloom throws OptimisticLockError.
```

UPDATE가 영향을 준 행이 0개라면 다른 누군가가 먼저 데이터를 수정했다는 뜻입니다. Stingerloom은 이를 감지하고 `OptimisticLockError`를 던집니다. 그래서 모르는 사이에 변경 내용이 사라지는 일을 막습니다.

`upsert()`와 `batchUpsert()`도 충돌한 행을 갱신할 때 버전을 `version = 저장된 버전 + 1`로 올립니다. 다만 버전을 검사하지는 않습니다. upsert는 마지막에 쓴 값이 이기는 연산이므로 `OptimisticLockError`를 던지지 않습니다. 페이로드에 넣은 `version`은 새 행을 삽입할 때만 쓰입니다. 자세한 내용은 [충돌 시 관리 컬럼](./entity-manager-writes.md#충돌-시-관리-컬럼)을 참고하세요.

> 힌트: 낙관적 잠금은 주문 상태 변경이나 재고 관리처럼 충돌은 드물지만 데이터 무결성이 중요한 경우에 알맞습니다. 거의 모든 요청에서 충돌이 일어나는 경합이 심한 상황이라면 `SELECT ... FOR UPDATE`를 쓰는 비관적 잠금을 고려해 보세요.

## 소프트 삭제 (@DeletedAt)

### 소프트 삭제가 필요한 이유

하드 삭제(`DELETE FROM ...`)는 데이터를 영구히 제거합니다. 백업이 없다면 삭제한 데이터는 되살리지 못합니다. 하지만 실제 애플리케이션에는 아래와 같은 요구사항이 많습니다.

1. 파일 시스템의 휴지통처럼 사용자가 삭제를 되돌리는 기능
2. 규정 준수를 위한 감사 추적 유지
3. 애플리케이션에서는 숨기되 분석용으로 데이터 보존

소프트 삭제는 행을 실제로 삭제하지 않습니다. 대신 삭제한 시점의 타임스탬프를 행에 기록해서 이 요구사항을 해결합니다.

### 동작 방식

```typescript
// post.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  DeletedAt,
} from "@stingerloom/orm";

@Entity()
export class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @DeletedAt()
  deletedAt!: Date | null;
}
```

**생성되는 DDL:**

```sql
-- PostgreSQL
CREATE TABLE "post" (
  "id" SERIAL PRIMARY KEY,
  "title" VARCHAR(255) NOT NULL,
  "deletedAt" TIMESTAMP          -- nullable (NULL means "not deleted")
);
```

`@DeletedAt()` 데코레이터를 추가하면 SQL에서 세 가지가 바뀝니다.

첫째, `em.softDelete(Post, { id: 1 })`를 호출하면 DELETE가 아니라 UPDATE를 실행합니다.

```sql
-- Instead of: DELETE FROM "post" WHERE "id" = 1
-- Stingerloom runs:
UPDATE "post" SET "deletedAt" = NOW() WHERE "id" = 1;
```

둘째, `em.find(Post)`는 소프트 삭제된 행을 제외하는 `WHERE` 필터를 자동으로 추가합니다.

```sql
-- Your code:
await em.find(Post);

-- Generated SQL:
SELECT * FROM "post" WHERE "deletedAt" IS NULL;
```

모든 쿼리가 소프트 삭제된 행을 자동으로 제외합니다. 이 조건을 직접 추가할 필요가 없습니다.

셋째, 삭제된 데이터도 조회하려면 `{ withDeleted: true }` 옵션을 쓰세요.

```sql
-- Your code:
await em.find(Post, { withDeleted: true });

-- Generated SQL (no filter):
SELECT * FROM "post";
```

소프트 삭제된 행은 `restore()`로 복원합니다.

```sql
-- Your code:
await em.restore(Post, { id: 1 });

-- Generated SQL:
UPDATE "post" SET "deletedAt" = NULL WHERE "id" = 1;
```

전체 흐름을 코드로 보면 아래와 같습니다.

```typescript
await em.softDelete(Post, { id: 1 }); // soft delete
const posts = await em.find(Post); // excludes deleted
const all = await em.find(Post, { withDeleted: true }); // includes deleted
await em.restore(Post, { id: 1 }); // restore
```

`upsert()` / `batchUpsert()`는 충돌한 행이 소프트 삭제된 상태라면 복원합니다. 페이로드에 `deletedAt`이 없으면 충돌 분기가 `deletedAt = NULL`을 씁니다. 삭제된 행과 충돌하는지는 고유 인덱스에 달려 있습니다. 자세한 내용은 [충돌 시 관리 컬럼](./entity-manager-writes.md#충돌-시-관리-컬럼)을 참고하세요.

## 자동 타임스탬프 (@CreateTimestamp / @UpdateTimestamp)

### 자동 타임스탬프가 필요한 이유

프로덕션 애플리케이션의 거의 모든 테이블은 "이 행은 언제 생성되었는가?"와 "마지막으로 수정된 때는 언제인가?"라는 두 질문에 답해야 합니다. 이 타임스탬프는 데이터가 언제 바뀌었는지 확인하는 디버깅, 최신순 정렬, 감사에 꼭 필요합니다.

`save()`를 호출할 때마다 직접 설정해도 되지만 실수하기 쉽습니다. 한 번이라도 빠뜨리면 데이터가 잘못됩니다. `@CreateTimestamp`와 `@UpdateTimestamp` 데코레이터는 이 값을 자동으로 채웁니다.

### 동작 방식

```typescript
// article.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateTimestamp,
  UpdateTimestamp,
} from "@stingerloom/orm";

@Entity()
export class Article {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @CreateTimestamp()
  createdAt!: Date;

  @UpdateTimestamp()
  updatedAt!: Date;
}
```

**생성되는 DDL:**

```sql
-- PostgreSQL
CREATE TABLE "article" (
  "id" SERIAL PRIMARY KEY,
  "title" VARCHAR(255) NOT NULL,
  "createdAt" TIMESTAMP NOT NULL,
  "updatedAt" TIMESTAMP NOT NULL
);

-- MySQL
CREATE TABLE `article` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `title` VARCHAR(255) NOT NULL,
  `createdAt` DATETIME NOT NULL,
  `updatedAt` DATETIME NOT NULL,
  PRIMARY KEY (`id`)
);
```

ORM이 각 값을 설정하는 시점은 아래와 같습니다.

INSERT할 때는 `createdAt`과 `updatedAt`이 모두 현재 시각으로 설정됩니다.

```sql
-- Your code:
await em.save(Article, { title: "Hello World" });

-- Generated SQL (PostgreSQL):
INSERT INTO "article" ("title", "createdAt", "updatedAt")
VALUES ('Hello World', '2026-03-22 10:30:00', '2026-03-22 10:30:00');
```

ORM은 `NOW()` 같은 SQL 함수가 아니라 애플리케이션 코드의 `new Date()`로 타임스탬프를 만듭니다. 그래서 생성 일시(createdAt)와 수정 일시(updatedAt)가 밀리초 단위까지 같은 값을 가집니다.

UPDATE할 때는 `updatedAt`만 갱신됩니다. `createdAt`은 바뀌지 않습니다.

```sql
-- Your code:
await em.save(Article, { id: 1, title: "Hello World (updated)" });

-- Generated SQL (PostgreSQL):
UPDATE "article"
SET "title" = 'Hello World (updated)', "updatedAt" = '2026-03-22 11:45:00'
WHERE "id" = 1;
-- Notice: createdAt is NOT in the SET clause
```

`@CreateTimestamp`와 `@UpdateTimestamp`는 기본으로 NOT NULL 컬럼을 만듭니다. 컬럼 타입은 MySQL에서 `DATETIME`이고 PostgreSQL에서 `TIMESTAMP`입니다. 타임존 정보를 담는 타임스탬프가 필요하면 `@CreateTimestamp({ type: "timestamptz" })` / `@UpdateTimestamp({ type: "timestamptz" })`처럼 타입을 넘기세요. 어느 쓰기 경로에서든 값은 똑같이 채워집니다.

> 힌트: `save()`를 호출할 때 `@CreateTimestamp`나 `@UpdateTimestamp` 컬럼에 값을 직접 넘기면 자동 생성 값 대신 넘긴 값이 쓰입니다. 원래 타임스탬프를 보존해야 하는 데이터 마이그레이션에 유용합니다. `upsert()` / `batchUpsert()`는 직접 넘긴 `@CreateTimestamp` 값을 새 행을 삽입할 때만 쓰고 `@UpdateTimestamp` 값은 삽입과 충돌 갱신에 모두 씁니다.

### 계산 컬럼 (@ComputedColumn)

어떤 컬럼 값은 항상 다른 컬럼에서 파생됩니다. 사람의 전체 이름은 항상 `first_name + ' ' + last_name`입니다. 주문 항목의 합계는 항상 `price * quantity`입니다. 이 값을 애플리케이션 코드에서 계산해도 됩니다. 하지만 그러면 모든 쿼리, 서비스, 보고서에서 같은 공식을 반복해야 합니다. 한 번이라도 빠뜨리면 값이 잘못됩니다. 이는 수식 대신 모든 셀에 합계를 직접 입력하는 스프레드시트와 같습니다. 결국 누군가는 실수합니다.

**계산 컬럼**은 이 공식을 데이터베이스로 옮깁니다. 생성 컬럼(generated column)이라고도 부릅니다. 스프레드시트 수식이 자동으로 다시 계산되듯이 데이터베이스가 값을 항상 정확하게 유지합니다.

```typescript
// order-line.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ComputedColumn,
} from "@stingerloom/orm";

@Entity()
export class OrderLine {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "float" })
  price!: number;

  @Column({ type: "int" })
  quantity!: number;

  @ComputedColumn({
    expression: "price * quantity",
    stored: true,
    type: "float",
  })
  total!: number;
}
```

**PostgreSQL DDL:**

```sql
CREATE TABLE "orderLine" (
  "id" SERIAL PRIMARY KEY,
  "price" REAL NOT NULL,
  "quantity" INTEGER NOT NULL,
  "total" REAL GENERATED ALWAYS AS (price * quantity) STORED
);
```

**MySQL DDL:**

```sql
CREATE TABLE `orderLine` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `price` FLOAT NOT NULL,
  `quantity` INT NOT NULL,
  `total` FLOAT GENERATED ALWAYS AS (price * quantity) STORED,
  PRIMARY KEY (`id`)
);
```

`GENERATED ALWAYS AS (expression)` 절은 데이터베이스가 이 값을 자동으로 계산하게 합니다. 값을 직접 설정할 필요가 없습니다. 실제로 데이터베이스는 생성 컬럼에 값을 쓰는 INSERT와 UPDATE를 모두 거부합니다.

Stingerloom은 계산 컬럼을 INSERT와 UPDATE 문에서 자동으로 제외합니다. 그래서 `em.save()`를 호출해도 SQL에 `total`이 들어가지 않습니다.

```typescript
await em.save(OrderLine, { price: 29.99, quantity: 3 });
// Generated SQL (PostgreSQL):
// INSERT INTO "orderLine" ("price", "quantity") VALUES (29.99, 3)
// Note: "total" is NOT in the INSERT -- the DB computes it as 89.97
```

이름과 성을 이어 붙이는 것도 흔한 예입니다.

```typescript
@Entity()
export class Person {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  firstName!: string;

  @Column()
  lastName!: string;

  @ComputedColumn({
    expression: "first_name || ' ' || last_name",
    stored: true,
    type: "varchar",
    length: 511,
  })
  fullName!: string;
}
```

**PostgreSQL DDL:**

```sql
"fullName" VARCHAR(511) GENERATED ALWAYS AS (first_name || ' ' || last_name) STORED
```

#### STORED vs VIRTUAL

`stored` 옵션은 데이터베이스가 계산한 값을 다루는 방식을 제어합니다.

| 모드        | `stored`         | 동작                                    | 디스크 공간    | 인덱싱 가능 |
| ----------- | ---------------- | --------------------------------------- | -------------- | ----------- |
| STORED      | `true`           | INSERT/UPDATE 시 계산하여 디스크에 저장 | 공간 사용      | 가능        |
| VIRTUAL     | `false` (기본값) | 매 SELECT 읽기마다 계산                 | 추가 공간 없음 | 제한적      |

**STORED** 컬럼은 행을 기록할 때 한 번 계산되고 일반 컬럼처럼 디스크에 저장됩니다. 인덱스를 걸 수 있으므로 `fullName`처럼 검색하거나 정렬하는 컬럼에 알맞습니다.

**VIRTUAL** 컬럼은 행을 읽을 때마다 계산됩니다. 디스크 공간을 더 쓰지 않지만 SELECT할 때마다 CPU 오버헤드가 생깁니다. 화면에 보여 주기만 하고 검색하지는 않는 값에 VIRTUAL 컬럼을 쓰세요.

```typescript
// VIRTUAL -- computed on every read, no disk usage
@ComputedColumn({
  expression: "price * quantity",
  stored: false,  // this is the default
})
total!: number;

// STORED -- computed once on write, persisted, indexable
@ComputedColumn({
  expression: "price * quantity",
  stored: true,
})
total!: number;
```

> 힌트: 계산 컬럼은 PostgreSQL 12 이상, MySQL 5.7 이상, SQLite 3.31 이상에서 지원됩니다. `@ComputedColumn` 데코레이터는 `type`, `length`, `nullable` 옵션을 선택적으로 받습니다. `type`을 생략하면 컬럼은 `TEXT`로 생성됩니다.

> 주의: PostgreSQL은 STORED 생성 컬럼만 지원합니다. 그래서 PostgreSQL에서는 컬럼이 항상 STORED로 생성됩니다. `stored: false`를 명시하면 경고 로그를 남기고 STORED로 바꿉니다.

#### 스키마 동기화 동작

계산 컬럼은 두 스키마 워크플로에 모두 적용됩니다.

- **`synchronize: true` (그리고 `"safe"`)**: 새 테이블에서는 CREATE TABLE 문에 생성 컬럼이 들어갑니다. 기존 테이블에는 `ALTER TABLE ... ADD COLUMN`으로 추가됩니다. ADD 동작이므로 `"safe"` 모드에서도 적용됩니다. `"dry-run"`은 DDL을 로그로만 출력합니다.
- **`migrate:generate`**: 같은 정의가 마이그레이션 파일에 출력됩니다. `down()`에는 대응하는 `DROP COLUMN`이 생성됩니다.

두 경로 모두 같은 빌더로 정의를 렌더링하므로 결과가 서로 어긋나지 않습니다. 이미 있는 생성 컬럼은 synchronize가 비교하지도 삭제하지도 않습니다. 표현식 변경은 자동으로 감지되지 않습니다. 그래서 `expression`을 바꿨다면 컬럼을 삭제했다가 다시 추가하는 마이그레이션을 직접 작성하세요.

다이얼렉트에 따른 주의점도 있습니다. 일부 엔진은 이미 있는 테이블에 ALTER로 STORED 생성 컬럼을 추가하는 것을 거부합니다. 구버전 SQLite가 대표적입니다. 이때 ORM은 DDL 에러를 무시하지 않고 일반 synchronize 에러 처리(`continueOnError`)로 보고합니다. SQLite에서 운영 중인 테이블에 컬럼을 추가할 예정이라면 `stored: false`를 권장합니다.

#### 상속 계층

생성 컬럼은 자기 행만 읽습니다. 그래서 계산 컬럼은 표현식이 읽는 컬럼이 있는 테이블에 생성됩니다.

| 전략 | 루트의 계산 컬럼 | 자식의 계산 컬럼 |
|------|-----------------|-----------------|
| `SINGLE_TABLE` | 공유 테이블 | 공유 테이블 |
| `JOINED` | 루트 테이블 | 자식 테이블 |
| `TABLE_PER_CLASS` | 모든 구체 테이블 | 자식 테이블 |

그래서 `JOINED`에서 자식의 표현식은 자식이 선언한 컬럼만 읽을 수 있습니다. 상속받은 컬럼은 루트 테이블에 있기 때문입니다. 어떤 읽기에서든 값은 그 컬럼을 선언한 클래스에만 담깁니다. 다형 `find(Item)`은 각 `Book`에 `doubled`를 채웁니다. 반면 형제 클래스인 `Pen`의 인스턴스에는 이 속성을 두지 않습니다.

#### 다이얼렉트 독립 표현식 (빌더 형식)

문자열 `expression`은 DDL에 그대로 들어갑니다. 그래서 대상 데이터베이스에서 바로 실행되는 SQL이어야 합니다. `price * quantity` 같은 이식 가능한 산술 연산은 문제가 없습니다. 하지만 날짜 연산은 엔진마다 크게 다릅니다. MySQL은 "두 타임스탬프 사이의 시간"을 `TIMESTAMPDIFF(HOUR, a, b)`로 씁니다. 반면 PostgreSQL에서는 `EXTRACT(EPOCH FROM (b - a)) / 3600`이 필요합니다. 한쪽을 하드코딩하면 엔티티가 특정 데이터베이스에 묶입니다. `process.env.DB_TYPE`로 분기하면 엔티티가 런타임 설정에 묶입니다. 게다가 한 프로세스가 두 데이터베이스에 동시에 연결하는 순간 동작하지 않습니다.

대신 빌더 함수를 넘기세요. 빌더 함수는 표현식 컨텍스트 `e`를 받아 이식 가능한 표현식을 반환합니다. 그러면 Stingerloom이 연결마다 한 번씩 다이얼렉트에 맞는 SQL로 컴파일합니다.

```typescript
@Entity()
export class Issue {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "datetime", nullable: true })
  createdAt!: Date;

  @Column({ type: "datetime", nullable: true })
  completedAt!: Date | null;

  // 정의 하나로 MySQL, PostgreSQL, SQLite에서 각각 올바른 DDL을 생성합니다
  @ComputedColumn({
    expression: (e) =>
      e.dateDiff(e.col("completed_at"), e.col("created_at"), "hour"),
    type: "int",
    nullable: true,
  })
  cycleTimeHours?: number;
}
```

**MySQL DDL:**

```sql
`cycleTimeHours` INT GENERATED ALWAYS AS (TIMESTAMPDIFF(HOUR, `created_at`, `completed_at`)) VIRTUAL
```

**PostgreSQL DDL:**

```sql
"cycleTimeHours" INTEGER GENERATED ALWAYS AS (EXTRACT(EPOCH FROM ("completed_at" - "created_at")) / 3600) STORED
```

컨텍스트 `e`는 `e.iff`, `e.caseBuilder`, `e.coalesce`, `e.dateDiff`를 비롯한 Expressions DSL 전체를 제공합니다. 같은 테이블의 다른 컬럼을 데이터베이스 컬럼 이름으로 참조하는 `e.col(name)`도 제공합니다. 분기 로직을 `e.iff`로 감싸면 이식 가능한 `CASE`가 됩니다.

```typescript
@ComputedColumn({
  expression: (e) =>
    e.iff(
      e.col("deleted_at").isNull().and(e.col("completed_at").isNotNull()),
      e.dateDiff(e.col("completed_at"), e.col("created_at"), "hour"),
      null,
    ),
  type: "int",
  nullable: true,
})
cycleTimeHours?: number;
```

생성 컬럼 표현식에는 바인드 파라미터를 쓰지 못합니다. 그래서 빌더 안의 모든 상수는 SQL 리터럴로 인라인됩니다. 위의 `null`, 숫자 임계값, 문자열 라벨이 모두 해당합니다. 문자열 형식도 그대로 동작합니다. 다만 다이얼렉트마다 다른 SQL이 필요한 표현식이라면 빌더를 쓰세요.

## 생명주기 훅

### 생명주기 훅이 필요한 이유

엔티티 생명주기의 특정 순간에 커스텀 로직을 실행해야 할 때가 있습니다. 삽입 전, 갱신 후, 삭제 전 같은 순간입니다. 예를 들어 저장하기 전에 제목으로 URL 슬러그를 만들거나 엔티티를 생성한 뒤 알림을 보내는 경우입니다.

생명주기 훅을 쓰면 이 로직을 엔티티 클래스에 직접 정의합니다. 정의한 로직은 해당 생명주기 이벤트가 일어날 때마다 자동으로 실행됩니다.

### 동작 방식

```typescript
// article.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  BeforeInsert,
  BeforeUpdate,
} from "@stingerloom/orm";

@Entity()
export class Article {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @Column({ type: "varchar", length: 255, nullable: true })
  slug!: string | null;

  @BeforeInsert()
  generateSlug() {
    if (!this.slug) {
      this.slug = this.title.toLowerCase().replace(/\s+/g, "-");
    }
  }
}
```

`@BeforeInsert()`를 붙인 메서드는 INSERT SQL을 실행하기 직전에 자동으로 호출됩니다. 위 예시에서 `em.save(Article, { title: "Hello World" })`를 호출하면 ORM은 먼저 `generateSlug()`를 호출합니다. 이 메서드가 `this.slug = "hello-world"`를 설정하므로 INSERT에 슬러그가 포함됩니다.

```sql
INSERT INTO "article" ("title", "slug") VALUES ('Hello World', 'hello-world');
```

생명주기 훅은 모두 6개입니다.

| 데코레이터        | 실행 시점            | 사용 시기                               |
| ----------------- | -------------------- | --------------------------------------- |
| `@BeforeInsert()` | INSERT SQL 실행 직전 | 기본값 설정, 슬러그 생성, 데이터 정규화 |
| `@AfterInsert()`  | INSERT 완료 후       | 로깅, 알림 전송, 캐시 무효화            |
| `@BeforeUpdate()` | UPDATE SQL 실행 직전 | 계산 필드 갱신, 검증                    |
| `@AfterUpdate()`  | UPDATE 완료 후       | 변경 이력 기록, 웹훅 트리거             |
| `@BeforeDelete()` | DELETE SQL 실행 직전 | 삭제 전 정리, 권한 확인                 |
| `@AfterDelete()`  | DELETE 완료 후       | 관련 리소스 정리, 로깅                  |

새 엔티티를 삽입하는 `save()` 호출은 아래 순서로 실행됩니다.

1. `@BeforeInsert()` 훅 실행 (이 단계에서는 엔티티를 수정해도 됩니다)
2. `INSERT INTO ...` SQL 실행
3. `@AfterInsert()` 훅 실행 (이 단계의 엔티티에는 자동 생성된 ID가 있습니다)

> 힌트: "After" 훅이 실행될 때는 데이터베이스 작업이 이미 끝났습니다. 그래서 이 훅에서 데이터를 수정해도 데이터베이스에 반영되지 않습니다. 로깅이나 외부 알림 같은 부수 효과에 쓰세요.

## 검증

### 검증이 필요한 이유

데이터베이스에도 NOT NULL, VARCHAR 길이, UNIQUE 같은 내장 제약 조건이 있습니다. 하지만 이 제약은 알아보기 어려운 에러 메시지를 내고 네트워크 라운드 트립을 거친 뒤에야 문제를 알립니다. 애플리케이션 수준의 검증은 SQL 쿼리를 만들기 전에 실수를 잡아내고 명확한 에러 메시지를 반환합니다.

### 동작 방식

`save()`를 호출할 때 데이터가 올바른지 자동으로 확인하려면 검증 데코레이터를 쓰세요. 검증에 실패하면 ORM이 `ValidationError`를 던집니다. 그래서 잘못된 데이터가 데이터베이스에 저장되지 않습니다.

```typescript
// member.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  NotNull,
  MinLength,
  MaxLength,
  Min,
  Max,
} from "@stingerloom/orm";

@Entity()
export class Member {
  @PrimaryGeneratedColumn()
  id!: number;

  @NotNull()
  @MinLength(2)
  @MaxLength(50)
  @Column()
  name!: string;

  @Min(0)
  @Max(150)
  @Column()
  age!: number;
}
```

각 데코레이터의 역할은 이름 그대로입니다.

- **`@NotNull()`**: 값이 `null`이나 `undefined`이면 에러
- **`@MinLength(n)` / `@MaxLength(n)`**: 문자열 길이 검증
- **`@Min(n)` / `@Max(n)`**: 숫자 범위 검증

잘못된 데이터로 `save()`를 호출하면 쿼리를 실행하기 전에 에러가 납니다. SQL은 데이터베이스에 전혀 전송되지 않습니다.

```typescript
await em.save(Member, { name: "A", age: -1 });
// ValidationError: name must be at least 2 characters long
// (no INSERT was attempted)
```

이 에러는 데이터베이스 제약 조건 에러와 다릅니다. `NOT NULL` 제약 조건을 위반하면 쿼리를 전송한 뒤에야 데이터베이스마다 다른 에러가 반환됩니다. `@NotNull()` 검증 에러는 네트워크 호출 전에 애플리케이션 코드에서 잡힙니다.

## 실전 종합 예제

아래는 지금까지 살펴본 기능을 모두 모은 블로그 사용자 엔티티입니다.

```typescript
// user.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  Version,
  DeletedAt,
  CreateTimestamp,
  UpdateTimestamp,
  AfterInsert,
  NotNull,
  MinLength,
  MaxLength,
} from "@stingerloom/orm";

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @NotNull()
  @MinLength(2)
  @MaxLength(50)
  @Column()
  name!: string;

  @NotNull()
  @Index()
  @Column({ type: "varchar", length: 255 })
  email!: string;

  @Column({ type: "varchar", length: 20, nullable: true })
  phone!: string | null;

  @Column({ type: "boolean" })
  isActive!: boolean;

  @Column({ type: "json", nullable: true })
  profile!: Record<string, unknown> | null;

  @Version()
  version!: number;

  @DeletedAt()
  deletedAt!: Date | null;

  @CreateTimestamp()
  createdAt!: Date;

  @UpdateTimestamp()
  updatedAt!: Date;

  @AfterInsert()
  log() {
    console.log(`User #${this.id} created`);
  }
}
```

**PostgreSQL DDL:**

```sql
CREATE TABLE "user" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL,
  "email" VARCHAR(255) NOT NULL,
  "phone" VARCHAR(20),
  "isActive" BOOLEAN NOT NULL,
  "profile" JSON,
  "version" INTEGER NOT NULL,
  "deletedAt" TIMESTAMP,
  "createdAt" TIMESTAMP NOT NULL,
  "updatedAt" TIMESTAMP NOT NULL
);

CREATE INDEX "INDEX_user_email" ON "user" ("email");
```

아래는 이 엔티티의 일반적인 작업에서 Stingerloom이 생성하는 SQL입니다.

**INSERT (새 사용자):**

```sql
INSERT INTO "user" ("name", "email", "phone", "isActive", "profile", "version", "createdAt", "updatedAt")
VALUES ('Alice', 'alice@example.com', NULL, TRUE, NULL, 1, '2026-03-22 10:00:00', '2026-03-22 10:00:00')
RETURNING *;
-- Note: version is auto-set to 1, both timestamps are auto-set
-- After INSERT, the @AfterInsert hook runs: console.log("User #1 created")
```

**UPDATE (이름 변경):**

```sql
UPDATE "user"
SET "name" = 'Alice Smith', "updatedAt" = '2026-03-22 11:00:00', "version" = "version" + 1
WHERE "id" = 1 AND "version" = 1;
-- Note: createdAt is NOT updated, version increments, updatedAt refreshes
```

**소프트 삭제:**

```sql
UPDATE "user" SET "deletedAt" = NOW() WHERE "id" = 1;
```

**조회 (소프트 삭제된 항목 자동 제외):**

```sql
SELECT * FROM "user" WHERE "deletedAt" IS NULL;
```

이 엔티티 하나에 자동 증가 기본 키, 검증, 인덱스, JSON 컬럼, 낙관적 잠금, 소프트 삭제, 자동 타임스탬프, 로깅이 모두 들어 있습니다.

## ColumnType 참조

### TypeScript 타입 자동 추론

`@Column()`에서 `type`을 생략하면 TypeScript 타입에서 자동으로 추론됩니다.

| TypeScript 타입 | ColumnType | 기본 길이 | nullable |
| --------------- | ---------- | --------- | -------- |
| `String`        | varchar    | 255       | false    |
| `Number`        | int        | 11        | false    |
| `Boolean`       | boolean    | 1         | false    |
| `Date`          | datetime   | 0         | false    |
| `Buffer`        | blob       | 0         | true     |
| `BigInt`        | bigint (`bigintMode: "bigint"`) | 0 | false |
| `Array` (`string[]`, `Tag[]`, 튜플) | json | 0 | true |
| `Object`        | text       | 0         | true     |
| 기타            | text       | 0         | true     |

배열 속성은 JSON으로 저장합니다. `@Column() tags!: string[]`는 `json` 컬럼이 됩니다. 이 컬럼은 MySQL과 PostgreSQL에서 `JSON`으로 생성되고 SQLite에서 `TEXT`로 생성됩니다. 값은 실제 배열 그대로 저장되고 조회됩니다. tsc는 배열과 튜플 타입에만 `Array`를 내보냅니다. 그래서 배열이 아닌 타입이 `json`으로 추론되는 일은 없습니다.

예외는 `transformer`에 `to()`가 있는 배열 속성뿐입니다. 이때는 `["a", "b"]` -> `"a,b"`처럼 쓰기 트랜스포머가 저장 형태를 결정합니다. 그래서 컬럼은 `text`로 남고 데코레이터가 `type`을 명시하라는 경고를 남깁니다. 반면 읽기 전용 변환은 저장 형태를 결정하지 않습니다. `transformer.from`만 있거나 deprecated인 `transform`을 쓴 경우가 여기에 해당합니다. 이 경우에는 다른 배열 속성과 똑같이 `json` 컬럼이 됩니다. 쓸 때는 ORM이 배열을 직렬화하고 읽을 때는 `from`이 그 JSON 텍스트를 받습니다. 예전 저장 형태가 필요하다면 `@Column({ type: "text" })`를 명시하세요.

`Object`는 정반대입니다. `Object`는 "이 값이 객체다"가 아니라 "tsc가 타입을 알려 주지 못했다"는 뜻입니다. `strictNullChecks`가 켜져 있으면 `string | null`, `Date | null`, `number | undefined` 같은 유니온이 모두 `Object`로 지워집니다. 트랜스파일 전용 빌드에서는 다른 모듈에서 import한 enum도 `Object`가 됩니다. 그래서 이 경우에는 `text` 폴백과 경고가 그대로 유지됩니다. 이럴 때는 `type`을 직접 적어 주세요. 객체 값이라면 `@Column({ type: "json" })`을 쓰고 nullable 스칼라라면 `@Column({ type: "varchar" })` / `"int"` / `"datetime"`을 쓰면 됩니다.

::: warning 업그레이드 시 DDL 드리프트
MySQL이나 PostgreSQL에서 이미 운영 중인 `@Column() tags!: string[]`는 데이터베이스에 `TEXT` 컬럼으로 있습니다. 하지만 이제는 `json`과 비교되어 diff가 잡힙니다. `synchronize: true`는 `ALTER ... TYPE JSON`을 시도합니다. PostgreSQL은 `USING` 절 없이는 이 변경을 거부합니다. MySQL은 JSON이 아닌 텍스트 행이 하나라도 있으면 실패합니다. 현재 컬럼을 유지하려면 `@Column({ type: "text" })`를 붙이세요. 아니면 데이터와 컬럼 타입을 계획해서 함께 마이그레이션하세요. SQLite는 두 타입 모두 `TEXT`이므로 영향이 없습니다.

인덱스도 컬럼을 따라갑니다. 타입을 지정하지 않은 배열 속성에 붙인 `@Index()`나 `@UniqueIndex(["tags"])`는 이제 `json` 컬럼을 대상으로 합니다. 그런데 PostgreSQL에는 `json`용 기본 btree 연산자 클래스가 없습니다. 그래서 `CREATE INDEX ... ON "post" ("tags")`가 `data type json has no default operator class for access method "btree"` 에러로 실패합니다. 업그레이드한 데이터베이스뿐 아니라 새로 만든 데이터베이스에서도 마찬가지입니다. 기본값인 `continueOnError: true`에서는 synchronize가 경고로 보고하고 인덱스를 생성하지 않습니다. `continueOnError: false`에서는 부팅이 멈춥니다. 인덱스를 건 배열 속성에는 `@Column({ type: "text" })`를 명시하거나 표현식 인덱스를 쓰세요.
:::

### ColumnType별 DB 매핑

아래 표는 각 드라이버의 `castType()` 메서드가 추상 `ColumnType`을 어떤 데이터베이스 타입으로 변환하는지 보여 줍니다.

| ColumnType       | MySQL/MariaDB | PostgreSQL       | SQLite  |
| ---------------- | ------------- | ---------------- | ------- |
| `varchar`        | VARCHAR(n)    | VARCHAR(n)       | TEXT    |
| `int` / `number` | INT           | INTEGER          | INTEGER |
| `float`          | FLOAT         | REAL             | REAL    |
| `double`         | DOUBLE        | DOUBLE PRECISION | REAL    |
| `decimal`        | DECIMAL(p, s) | NUMERIC(p, s)    | NUMERIC(p, s) (NUMERIC affinity) |
| `bigint`         | BIGINT        | BIGINT           | BIGINT (INTEGER affinity) |
| `boolean`        | TINYINT(1)    | BOOLEAN          | INTEGER |
| `datetime`       | DATETIME      | TIMESTAMP        | TEXT    |
| `timestamp`      | TIMESTAMP     | TIMESTAMP        | TEXT    |
| `timestamptz`    | DATETIME      | TIMESTAMPTZ      | TEXT    |
| `date`           | DATE          | DATE             | TEXT    |
| `text`           | TEXT          | TEXT             | TEXT    |
| `longtext`       | LONGTEXT      | TEXT             | TEXT    |
| `blob`           | BLOB          | BYTEA            | BLOB    |
| `json`           | JSON          | JSON             | TEXT    |
| `jsonb`          | JSON          | JSONB            | TEXT    |
| `enum`           | ENUM          | (custom ENUM)    | TEXT    |
| `array`          | JSON          | `element[]` (기본 `TEXT[]`) | TEXT |

PostgreSQL에서 `type: "array"`는 네이티브 배열 컬럼을 생성합니다. 요소 타입은 `arrayElementType`으로 지정하며 기본값은 `"text"`입니다.

```typescript
@Column({ type: "array", nullable: true })
tags!: string[] | null; // TEXT[]

@Column({ type: "array", arrayElementType: "int", nullable: true })
scores!: number[] | null; // INTEGER[]
```

일반 JS 배열은 `pg` 드라이버의 네이티브 배열 직렬화로 그대로 저장되고 조회됩니다. MySQL은 `array` 컬럼을 JSON으로 저장하고 SQLite는 TEXT로 저장합니다. 이때 `arrayElementType`은 무시됩니다. 이 두 드라이버에서는 ORM이 쓸 때 `JSON.stringify`로 직렬화하고 읽을 때 다시 파싱합니다. 그래서 `["x", "y"]`는 MySQL과 SQLite에서도 `find()` 결과로 `["x", "y"]`가 나옵니다.

MySQL이나 SQLite에 이전 버전이 기록한 행이 남아 있다면 그 값은 JSON이 아니라 `x` 같은 요소 문자열 하나입니다. 그런 행을 읽으면 해당 컬럼에 `Failed to JSON.parse` 경고가 한 번 남고 원본 문자열이 그대로 반환됩니다. `UPDATE`로 행을 한 번 변환하거나 `transformer`로 기존 형태를 유지하세요.

참고로 스키마 diff는 PostgreSQL 배열 컬럼을 모두 단순히 `ARRAY`로 읽습니다. 그래서 요소 타입 변경을 감지하지 못합니다. 엔티티 생성은 `integer[]` → `arrayElementType: "int"`처럼 요소 타입까지 읽습니다.

### double 컬럼과 decimal 컬럼

`double`은 JS `number`와 같은 8바이트 이진 부동소수입니다. 어느 데이터베이스에서나 유효 숫자를 15자리 정도 담고 `number`로 읽힙니다. 측정값, 비율, 좌표에 씁니다. `decimal`은 스케일이 고정된 정확한 숫자입니다. `precision`은 전체 자릿수이고 `scale`은 그중 소수점 아래 자릿수이며 기본값은 `(10, 2)`입니다. 금액처럼 반올림 오차가 쌓이면 안 되는 값에 씁니다.

| | `double` | `decimal` |
|---|---|---|
| MySQL / MariaDB | `DOUBLE` | `DECIMAL(p, s)` |
| PostgreSQL | `DOUBLE PRECISION` | `NUMERIC(p, s)` |
| SQLite | `REAL` | `NUMERIC(p, s)` |
| 저장되는 값 | 가장 가까운 이진 부동소수 | `scale` 자리로 반올림 (MySQL / PostgreSQL) |

`precision`과 `scale`은 `decimal`에만 적용됩니다. `double`에 선언하면 `register()`(그리고 `migrate:generate`)에서 `INVALID_CONFIG`로 실패합니다.

PostgreSQL과 mysql2는 `decimal`을 문자열로 반환하고 SQLite는 number로 반환합니다. 엔티티 속성에 담을 타입은 `decimalMode`로 결정합니다. 어느 드라이버에서나 같은 타입이 나옵니다.

| `decimalMode` | 속성 타입 | JS number가 정확히 담지 못하는 값 |
|---------------|---------------|-----------------------------------|
| `"number"` (기본값) | `number` | 반올림하지 않고 `DECIMAL_PRECISION_LOSS` 코드의 `OrmError`를 던짐 |
| `"string"` | `string` (10진수 문자열) | 정확함 |

```typescript
@Entity()
export class Invoice {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "double" })
  exchangeRate!: number; // 1234.56789

  @Column({ type: "decimal", precision: 12, scale: 2 })
  total!: number; // 19.9: 데이터베이스는 "19.90"을 반환합니다

  @Column({ type: "decimal", precision: 19, scale: 4, decimalMode: "string" })
  ledgerAmount!: string; // "123456789012345.6789"
}
```

JS number는 유효 숫자를 15자리 정도 담습니다. 그래서 `"number"` 모드로도 `DECIMAL(10, 2)` 값은 손실 없이 읽힙니다. 더 넓은 컬럼에서 그 범위를 넘는 값을 읽으려면 `decimalMode: "string"`이 필요합니다. 예를 들어 `DECIMAL(19, 4)`는 19자리를 담습니다. 쓰기는 어느 모드에서든 number와 숫자 문자열을 모두 받습니다.

SQLite에는 정확한 십진수 저장 방식이 없습니다. `decimal` 컬럼은 NUMERIC affinity를 가지므로 값이 숫자로 정렬되고 비교됩니다. 하지만 값은 정수나 8바이트 부동소수로 저장되고 스케일도 강제되지 않습니다. `"string"` 모드에서는 SQLite가 반환한 값을 컬럼 스케일까지 0으로 채워 PostgreSQL·MySQL과 같은 모양으로 맞춥니다. 예를 들어 `19.9`는 `"19.90"`으로 읽힙니다.

::: warning 업그레이드 시 DDL 드리프트
이번 릴리스 전까지 `double`은 MySQL에서 `DECIMAL(10, 2)`를 만들었고 PostgreSQL에서 `NUMERIC(10, 2)`를 만들었습니다. 이제 `double`로 선언된 기존 컬럼은 `DOUBLE` / `DOUBLE PRECISION`과 비교됩니다. 그리고 `synchronize: true`는 컬럼을 변환합니다. 이 변환은 좁히는 변경으로 보고되므로 `failOnDestructiveChange: true`이면 거부됩니다. 정확한 컬럼을 유지하려면 `@Column({ type: "decimal", precision: 10, scale: 2 })`처럼 지금의 정밀도와 스케일로 `decimal`을 선언하세요. 그러면 스키마는 그대로입니다. `precision` / `scale`을 선언한 `double`은 원래 `DECIMAL`이었습니다. 이런 컬럼은 이제 `decimal`로 선언하기 전까지 `register()`에서 실패합니다. SQLite는 영향이 없습니다. `double`은 예전에도 지금도 `REAL`입니다.
:::

### bigint 컬럼과 `bigintMode`

JS `number`는 2^53(`Number.MAX_SAFE_INTEGER`, 약 9.007e15)까지만 정수를 정확히 담습니다. 반면 데이터베이스 `BIGINT`는 2^63까지 담습니다. 드라이버는 bigint 값을 손실 없이 반환합니다. `pg`는 문자열로 반환합니다. `mysql2` / `better-sqlite3`는 값이 범위 안이면 number로 반환하고 범위를 넘으면 10진수 문자열로 반환합니다. 엔티티 속성에 담을 타입은 `bigintMode`로 결정합니다. 어느 드라이버에서나 같은 타입이 나옵니다.

| `bigintMode` | 속성 타입 | ±2^53 초과 시 |
|--------------|---------------|---------------|
| `"number"` (기본값) | `number` | 반올림하지 않고 `BIGINT_PRECISION_LOSS` 코드의 `OrmError`를 던짐 |
| `"string"` | `string` (10진수 문자열) | 무손실, JSON 직렬화 안전 |
| `"bigint"` | `bigint` (네이티브 `BigInt`) | 무손실. `JSON.stringify`에는 replacer가 필요 |

```typescript
@Entity()
export class Account {
  @PrimaryGeneratedColumn({ type: "bigint" })
  id!: number; // 기본 모드: 다른 자동 증가 키와 같은 number

  @Column({ type: "bigint", bigintMode: "string" })
  balanceCents!: string; // "9007199254740993"

  @Column({ type: "bigint", bigintMode: "bigint" })
  snowflakeId!: bigint; // 9007199254740993n

  @Column()
  version!: bigint; // 속성 타입이 `bigint`면 type: "bigint" + bigintMode: "bigint"로 추론
}
```

이 모드는 `find*`, `findWithCursor`, `stream`, RETURNING 행 같은 읽기에 적용됩니다. `saveMany()` / `insertManyAndReturn()`가 배치에서 유도하는 기본 키에도 적용됩니다. 쓰기는 어느 모드에서든 number, 숫자 문자열, `BigInt`를 모두 받습니다. 모든 드라이버가 `BigInt` 파라미터를 네이티브로 바인딩하므로 `where: { snowflakeId: 9007199254740993n }`도 캐스팅 없이 동작합니다. `` sql`... WHERE snowflake_id = ${id}` ``나 `join([...])`처럼 `sql` 조각에 넣는 `BigInt` 값도 마찬가지입니다.

집계는 `number` 반환 타입을 유지합니다. `sum()` / `min()` / `max()`와 `SelectQueryBuilder`의 대응 메서드는 ±2^53을 넘는 정수 결과를 반올림하지 않고 `BIGINT_PRECISION_LOSS`를 던집니다. 그런 값은 `getRawOne()`에 `coerce: { total: "bigint" }`를 넘겨 읽으세요. 커서 페이지네이션은 `BigInt` 정렬 값과 키 값을 인코딩합니다. `logging: true`는 `BigInt` 파라미터를 숫자 문자열로 출력합니다.

SQLite에서는 bigint 컬럼을 `BIGINT`로 선언합니다. 커넥터가 어떤 SQL 문에 무손실 정수 읽기가 필요한지 구분하기 위해서입니다. INTEGER affinity와 저장 방식은 이전과 같습니다. `INTEGER`로 선언된 기존 테이블도 그대로 동작하고 타입 변경으로 보고되지 않습니다. 하지만 ±2^53을 넘는 값은 컬럼을 `BIGINT`로 다시 만들기 전까지 반올림된 채로 남습니다. 자동 증가 기본 키는 `INTEGER PRIMARY KEY`를 유지합니다. SQLite에서 rowid의 별칭이 되는 표기는 이것뿐이기 때문입니다.

### @Column 전체 옵션

| 옵션            | 타입           | 설명                                           |
| --------------- | -------------- | ---------------------------------------------- |
| `name`          | `string`       | DB 컬럼 이름 (기본값: 속성 이름)           |
| `type`          | `ColumnType`   | 컬럼 타입 (생략 시 자동 추론)                  |
| `length`        | `number`       | 컬럼 길이                                      |
| `nullable`      | `boolean`      | NULL 허용 (기본값: false)                      |
| `primary`       | `boolean`      | 기본 키 여부                                   |
| `autoIncrement` | `boolean`      | AUTO_INCREMENT 적용 여부                       |
| `default`       | `unknown`      | 컬럼 기본값 (리터럴 또는 괄호로 감싼 raw SQL) |
| `transform`     | `(raw) => any` | (deprecated) 읽기 전용 값 변환 함수            |
| `transformer`   | `{ to, from }` | 양방향 값 트랜스포머 (쓰기와 읽기)             |
| `precision`     | `number`       | `type: "decimal"` 컬럼의 전체 자릿수 (기본값 10) |
| `scale`         | `number`       | `type: "decimal"` 컬럼의 소수점 아래 자릿수 (기본값 2) |
| `enumValues`    | `string[]`     | PostgreSQL ENUM 값 목록                        |
| `enumName`      | `string`       | PostgreSQL ENUM 타입 이름                      |
| `renamedFrom`   | `string`       | 이 컬럼이 예전에 쓰던 DB 컬럼 이름. synchronize가 drop + add 대신 이름을 바꿉니다 ([설명](./migrations.md#컬럼-이름-변경-감지)) |
| `arrayElementType` | `ColumnType` | `type: "array"` 컬럼의 요소 타입 (PostgreSQL 전용, 기본값 `"text"`) |
| `bigintMode`    | `"number" \| "string" \| "bigint"` | `type: "bigint"` 컬럼의 엔티티 측 타입 (기본값 `"number"`, ±2^53 초과 시 에러) |
| `decimalMode`   | `"number" \| "string"` | `type: "decimal"` 컬럼의 엔티티 측 타입 (기본값 `"number"`, JS number가 정확히 담지 못하는 값이면 에러) |

## 데코레이터 없이 엔티티 정의하기 (EntitySchema)

### EntitySchema가 필요한 이유

TypeScript 데코레이터는 `emitDecoratorMetadata` 컴파일러 옵션에 의존합니다. 그런데 esbuild나 SWC 같은 일부 빌드 도구는 이 옵션을 지원하지 않습니다. 데코레이터를 완전히 지원하는 환경이라도 "순수 클래스" 원칙에 따라 도메인 클래스에 ORM 어노테이션을 넣지 않으려는 팀도 있습니다. `EntitySchema`는 스키마 정의를 클래스에서 분리해서 두 문제를 모두 해결합니다.

`EntitySchema`는 데코레이터 방식과 같은 메타데이터를 등록합니다. 그래서 EntityManager, SchemaGenerator 같은 나머지 ORM 기능은 똑같이 동작합니다. 두 방식을 한 프로젝트에서 함께 써도 됩니다.

::: tip 모든 데코레이터에는 데코레이터 없는 형태가 있습니다
데코레이터와 `EntitySchema` / 프로그래밍 방식의 전체 대응표는 [데코레이터 없이 사용하기](./decorator-free.md)에 있습니다. 그 대응표에는 계산 컬럼, 전문 인덱스와 JSON 인덱스, 외래 키 컬럼, 양방향 트랜스포머, UUID 전략, 고급 복합 인덱스, 테넌트 컬럼, 트랜잭션까지 들어 있습니다.
:::

### 기본 사용법

```typescript
import { EntitySchema } from "@stingerloom/orm";

class User {
  id!: number;
  name!: string;
  email!: string;
}

const UserSchema = new EntitySchema<User>({
  target: User,
  tableName: "users",
  columns: {
    id: { type: "int", primary: true, autoIncrement: true },
    name: { type: "varchar" },
    email: { type: "varchar", nullable: true, index: true },
  },
});
```

이 정의는 데코레이터 버전과 똑같은 DDL을 생성합니다.

```sql
-- PostgreSQL
CREATE TABLE "users" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL,
  "email" VARCHAR(255)
);
CREATE INDEX "INDEX_users_email" ON "users" ("email");
```

`target` 클래스는 데코레이터가 없는 순수 TypeScript 클래스입니다. `tableName`은 선택 사항입니다. 생략하면 `@Entity()`와 똑같이 클래스 이름을 snake_case로 바꾼 이름을 씁니다.

### 컬럼 옵션

`ColumnSchemaDef`는 `@Column()`과 같은 옵션을 지원합니다. 특수 데코레이터를 대신하는 플래그도 있습니다.

```typescript
columns: {
  id:        { type: "int", primary: true, autoIncrement: true },
  name:      { type: "varchar", length: 100 },
  email:     { type: "varchar", nullable: true, index: true },
  status:    { type: "enum", enumValues: ["active", "inactive"], enumName: "user_status" },
  bio:       { type: "text", nullable: true, default: null },
  version:   { type: "int", version: true },
  createdAt: { type: "datetime", createTimestamp: true },
  updatedAt: { type: "datetime", updateTimestamp: true },
  deletedAt: { type: "datetime", nullable: true, deletedAt: true },
}
```

`version`, `createTimestamp`, `updateTimestamp`, `deletedAt` 플래그는 각각 `@Version()`, `@CreateTimestamp()`, `@UpdateTimestamp()`, `@DeletedAt()` 데코레이터를 대신합니다. 생성되는 DDL과 런타임 동작은 같습니다.

### 관계

관계는 `relations` 옵션으로 정의하고 `kind` 값으로 종류를 구분합니다.

```typescript
class Post {
  id!: number;
  title!: string;
  author!: User;
  comments!: Comment[];
  tags!: Tag[];
}

const PostSchema = new EntitySchema<Post>({
  target: Post,
  columns: {
    id: { type: "int", primary: true, autoIncrement: true },
    title: { type: "varchar" },
  },
  relations: {
    author: {
      kind: "manyToOne",
      target: () => User,
      joinColumn: "author_id",
      eager: true,
    },
    comments: {
      kind: "oneToMany",
      target: () => Comment,
      mappedBy: "post",
    },
    tags: {
      kind: "manyToMany",
      target: () => Tag,
      joinTable: {
        name: "post_tags",
        joinColumn: "post_id",
        inverseJoinColumn: "tag_id",
      },
    },
  },
});
```

네 가지 관계 종류를 모두 지원합니다.

| `kind`         | 동등한 데코레이터 | 필수 옵션                                                            |
| -------------- | ----------------- | -------------------------------------------------------------------- |
| `"manyToOne"`  | `@ManyToOne()`    | `target`, 선택적으로 `joinColumn`, `eager`, `lazy`, `cascade`        |
| `"oneToMany"`  | `@OneToMany()`    | `target`, `mappedBy`                                                 |
| `"oneToOne"`   | `@OneToOne()`     | `target`, 선택적으로 `joinColumn`, `inverseSide`, `eager`, `cascade` |
| `"manyToMany"` | `@ManyToMany()`   | `target`, 선택적으로 `joinTable` (소유측) 또는 `mappedBy` (역측)     |

### 고유 인덱스

```typescript
const UserSchema = new EntitySchema<User>({
  target: User,
  columns: {
    /* ... */
  },
  uniqueIndexes: [
    { columns: ["email", "tenantId"], name: "uq_user_email_tenant" },
  ],
});
```

### 생명주기 훅

훅에는 대상 클래스의 메서드 이름을 지정합니다.

```typescript
class Article {
  id!: number;
  title!: string;

  generateSlug() {
    // ...
  }
}

const ArticleSchema = new EntitySchema<Article>({
  target: Article,
  columns: {
    id: { type: "int", primary: true, autoIncrement: true },
    title: { type: "varchar" },
  },
  hooks: {
    beforeInsert: "generateSlug",
  },
});
```

### 검증

검증 규칙은 컬럼 정의의 `validation` 배열에 인라인으로 지정합니다.

```typescript
columns: {
  name: {
    type: "varchar",
    validation: [
      { constraint: "notNull" },
      { constraint: "minLength", value: 2, message: "Name too short" },
    ],
  },
  age: {
    type: "int",
    validation: [
      { constraint: "min", value: 0 },
      { constraint: "max", value: 150 },
    ],
  },
}
```

### 상속 매핑

EntitySchema는 `inheritance`, `discriminatorColumn`, `discriminatorValue` 옵션으로 세 가지 상속 전략(STI, TPT, TPC)을 모두 지원합니다. 이 옵션들은 `@Inheritance()`, `@DiscriminatorColumn()`, `@DiscriminatorValue()` 데코레이터를 대신합니다.

**Single Table Inheritance (STI):**

```typescript
class Payment {
  id!: number;
  amount!: number;
}

class CreditCardPayment extends Payment {
  cardNumber!: string;
}

class BankTransferPayment extends Payment {
  bankCode!: string;
}

// 루트 엔티티: 전략 + 구분 컬럼(discriminator column) 정의
new EntitySchema<Payment>({
  target: Payment,
  inheritance: { strategy: "SINGLE_TABLE" },
  discriminatorColumn: { name: "payment_type", type: "varchar", length: 50 },
  columns: {
    id:     { type: "int", primary: true, autoIncrement: true },
    amount: { type: "int" },
  },
});

// 자식 엔티티: 자체 컬럼 + 구분 값만 정의
new EntitySchema<CreditCardPayment>({
  target: CreditCardPayment,
  discriminatorValue: "credit_card",
  columns: {
    cardNumber: { type: "varchar", nullable: true },
  },
});

new EntitySchema<BankTransferPayment>({
  target: BankTransferPayment,
  discriminatorValue: "bank_transfer",
  columns: {
    bankCode: { type: "varchar", nullable: true },
  },
});
```

자식 엔티티는 프로토타입 체인으로 부모 컬럼을 자동으로 상속받습니다. STI에서는 모든 자식이 루트의 테이블 이름을 공유합니다. TPT(`"JOINED"`)와 TPC(`"TABLE_PER_CLASS"`)에서는 자식마다 자체 테이블을 가집니다.

**Joined / Table Per Type (TPT):**

```typescript
new EntitySchema<Payment>({
  target: Payment,
  inheritance: { strategy: "JOINED" },
  discriminatorColumn: { name: "payment_type" },
  columns: {
    id:     { type: "int", primary: true, autoIncrement: true },
    amount: { type: "int" },
  },
});

new EntitySchema<CreditCardPayment>({
  target: CreditCardPayment,
  discriminatorValue: "credit_card",
  columns: {
    cardNumber: { type: "varchar" },  // TPT에서는 NOT NULL 가능
  },
});
```

**Table Per Class (TPC):**

```typescript
new EntitySchema<Payment>({
  target: Payment,
  inheritance: { strategy: "TABLE_PER_CLASS" },
  discriminatorColumn: { name: "payment_type" },
  columns: {
    id:     { type: "int", primary: true, autoIncrement: true },
    amount: { type: "int" },
  },
});

new EntitySchema<CreditCardPayment>({
  target: CreditCardPayment,
  discriminatorValue: "credit_card",
  columns: {
    cardNumber: { type: "varchar" },
  },
});
```

루트 엔티티의 `discriminatorColumn` 옵션은 선택 사항입니다. 생략하면 `"dtype"`이라는 이름의 `VARCHAR(31)` 컬럼이 기본으로 생성됩니다. 자식 엔티티의 `discriminatorValue` 옵션도 선택 사항입니다. 생략하면 클래스 이름을 씁니다.

EntityManager, QueryBuilder, WriteBuffer, InheritanceResolver를 비롯한 모든 ORM 기능은 데코레이터로 정의하든 EntitySchema로 정의하든 똑같이 동작합니다.

::: tip
세 가지 전략의 자세한 비교와 생성되는 SQL 예시는 [상속 매핑](./inheritance-mapping.md) 가이드를 참고하세요.
:::

### 데코레이터와 EntitySchema 엔티티 혼용

두 방식은 같은 메타데이터를 생성하므로 자유롭게 섞어 써도 됩니다.

```typescript
// user.entity.ts — uses decorators
@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;
  // ...
}

// audit-log.schema.ts — uses EntitySchema
class AuditLog {
  id!: number;
  action!: string;
}

const AuditLogSchema = new EntitySchema<AuditLog>({
  target: AuditLog,
  columns: {
    id: { type: "int", primary: true, autoIncrement: true },
    action: { type: "varchar" },
  },
});

// Both can be used with EntityManager
await em.register({ entities: [User, AuditLog] /* ... */ });
```

## 다음 단계

엔티티를 정의했다면 이제 엔티티 사이의 관계를 설정할 차례입니다.

- [관계](./relations.md): `@ManyToOne`, `@OneToMany` 등으로 테이블 사이의 관계 정의
- [EntityManager](./entity-manager.md): 정의한 엔티티로 CRUD 수행
- [트랜잭션](./transactions.md): 여러 작업을 하나의 단위로 묶기
- [마이그레이션](./migrations.md): 스키마 변경을 안전하게 관리
