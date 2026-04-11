# 엔티티

**엔티티**(Entity)는 데이터베이스 테이블을 나타내는 TypeScript 클래스예요. 각 엔티티 클래스는 하나의 테이블에 대응하고, 클래스의 프로퍼티가 테이블의 컬럼이 돼요.

코드를 작성하기 전에, 엔티티가 어떤 문제를 해결하는지 먼저 이해해 볼게요.

ORM 없이는 테이블을 생성하기 위해 직접 SQL을 작성하고, JavaScript 객체와 SQL 행 사이를 수동으로 변환해야 해요. 컬럼을 하나 추가할 때마다 CREATE TABLE, INSERT, SELECT, 타입 정의를 모두 수정해야 하죠. 엔티티는 이런 중복을 제거해요: TypeScript로 데이터 구조를 한 번만 정의하면, ORM이 자동으로 SQL을 생성해 줘요.

이 문서는 가장 간단한 엔티티부터 시작해서 실제 애플리케이션에서 필요한 기능들을 점진적으로 소개해요.

## 첫 번째 엔티티 만들기

데이터베이스에 사용자 정보를 저장한다고 가정해 볼게요. 가장 간단한 엔티티는 이렇게 생겼어요.

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

이 코드만으로 Stingerloom은 `id`(자동 증가 기본 키)와 `name`(VARCHAR(255)) 컬럼을 가진 `user` 테이블을 생성해요.

다음은 Stingerloom이 이 엔티티에 대해 생성하는 정확한 DDL(Data Definition Language)이에요.

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

차이점을 주목해 주세요: PostgreSQL은 식별자 주위에 큰따옴표(`"`)를 사용하고 자동 증가에 `SERIAL` 키워드를 써요. MySQL은 백틱과 `AUTO_INCREMENT`를 사용하고요. Stingerloom이 이런 차이를 처리해 주기 때문에, 엔티티를 한 번만 작성하면 두 데이터베이스 모두에서 동작해요.

세 가지 데코레이터가 각각 무엇을 하는지 살펴볼게요.

**`@Entity()`** 는 이 클래스가 ORM 엔티티임을 선언해요. 클래스 이름 `User`는 자동으로 snake_case로 변환되어 테이블 이름 `user`가 돼요. 테이블 이름을 직접 지정하려면 옵션을 전달하면 돼요.

```typescript
// user.entity.ts
@Entity({ name: "app_users" })
export class User {
  /* table name: app_users */
}
```

**`@PrimaryGeneratedColumn()`** 은 자동 증가 기본 키를 정의해요. SQL 수준에서 이건 이렇게 변환돼요:

- **PostgreSQL:** `SERIAL PRIMARY KEY` (시퀀스를 생성하고 기본값으로 설정하는 축약형)
- **MySQL:** `INT NOT NULL AUTO_INCREMENT PRIMARY KEY`

INSERT 시 값을 제공하지 않아도 데이터베이스가 자동으로 1, 2, 3... 순서대로 채워 넣어요.

```sql
-- 다음과 같이 작성하면:
INSERT INTO "user" ("name") VALUES ('Alice');
-- DB가 자동으로 id = 1을 채워 넣음

-- 다음과 같이 작성하면:
INSERT INTO "user" ("name") VALUES ('Bob');
-- DB가 자동으로 id = 2를 채워 넣음
```

**`@Column()`** 은 일반 컬럼을 정의해요. TypeScript 타입을 읽어 적절한 DB 타입을 자동으로 추론해요 -- `string`은 `VARCHAR(255)`가 되고, `number`는 `INT`가 돼요. 이 추론은 TypeScript의 `emitDecoratorMetadata` 컴파일러 옵션이 제공하는 `design:type` 메타데이터를 기반으로 해요.

> **힌트** `!:` 구문(확정 할당 단언)은 TypeScript에 "이 프로퍼티는 ORM이 관리하므로 초기화하지 않아도 된다"고 알려줘요.

## 다양한 컬럼 타입 사용

실제로는 문자열과 숫자만으로는 부족해요. `@Column()`의 `type` 옵션을 사용해서 원하는 컬럼 타입을 지정할 수 있어요.

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

`type`을 생략하면 TypeScript 타입에서 자동으로 추론돼요. 하지만 같은 `string`이라도 짧은 이름(`varchar`)과 긴 본문(`text`)은 다르니까, 용도에 따라 명시하는 게 좋아요. `VARCHAR(255)` 컬럼은 255자의 엄격한 상한이 있는 반면, `TEXT`는 메가바이트 단위의 콘텐츠를 저장할 수 있어요.

> **힌트** Stingerloom의 컬럼 타입은 데이터베이스에 독립적이에요. 예를 들어, `"boolean"`은 MySQL에서 `TINYINT(1)`로, PostgreSQL에서 `BOOLEAN`으로 자동 변환돼요. 전체 매핑 표는 이 문서 하단의 [ColumnType 참조](#columntype-참조)를 확인해 주세요.

## 컬럼 옵션 설정

`@Column()`은 컬럼의 세부 동작을 제어하는 옵션을 받아요.

### 길이 지정

문자열 컬럼의 최대 길이를 지정해요. 생략하면 `varchar`의 기본 길이는 255예요.

```typescript
@Column({ type: "varchar", length: 100 })
sku!: string;
```

이건 DDL에서 `VARCHAR(100)`을 생성해요. 사용자가 100자보다 긴 문자열을 삽입하려고 하면, 데이터베이스가 오류와 함께 삽입을 거부해요.

### NULL 허용

기본적으로 모든 컬럼은 `NOT NULL`이에요. 데이터베이스가 컬럼을 NULL로 설정하려는 모든 INSERT 또는 UPDATE를 거부한다는 뜻이에요. 이건 안전 기능으로, 실수로 누락된 데이터가 저장되는 걸 방지해요.

값이 없을 수 있는 컬럼이라면, `nullable: true`를 설정해 주세요.

```typescript
@Column({ nullable: true })
bio!: string | null;
```

이건 DDL에서 `VARCHAR(255)` (`NOT NULL` 제약 조건 없이)를 생성해요. TypeScript 타입에도 `| null`을 추가하면 코드에서 자연스럽게 null 검사를 할 수 있어요.

### 컬럼 이름 별칭

프로퍼티 이름과 실제 DB 컬럼 이름을 다르게 하고 싶을 때 `name` 옵션을 사용해요. TypeScript에서는 camelCase를, 데이터베이스에서는 snake_case를 쓰고 싶을 때 흔히 쓰이죠.

```typescript
@Column({ name: "unit_price", type: "float" })
price!: number;
// TypeScript: product.price / DB column: unit_price
```

DDL에서 컬럼은 `unit_price`라는 이름이 돼요. Stingerloom이 SELECT 쿼리를 빌드할 때, `unit_price` 컬럼을 TypeScript 객체의 `price` 프로퍼티에 매핑해요.

### 기본값

`default` 옵션을 사용해서 컬럼의 기본값을 설정해요. 리터럴 값(문자열, 숫자, 불리언)은 그대로 사용돼요. SQL 표현식(함수 등)을 쓰려면 괄호로 감싸면 돼요.

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

이것들이 생성하는 DDL은 이래요.

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

`"(CURRENT_TIMESTAMP)"`처럼 값이 괄호로 감싸져 있으면, Stingerloom은 따옴표로 감싼 문자열 리터럴 대신 DDL에서 원시 SQL `DEFAULT` 표현식으로 출력해요. 괄호가 없으면 `"CURRENT_TIMESTAMP"`는 SQL 함수가 아닌 리터럴 문자열 `'CURRENT_TIMESTAMP'`로 처리돼요.

### JSON 컬럼

단일 컬럼에 구조화된 데이터를 저장하려면 JSON 타입을 사용하세요. 사용자 환경설정이나 설정처럼 유연하고 스키마가 없는 데이터에 유용해요.

```typescript
@Column({ type: "json", nullable: true })
settings!: Record<string, unknown> | null;
```

**PostgreSQL:** `"settings" JSON` (인덱싱된 바이너리 저장 JSON을 쓰려면 `"jsonb"` 사용)
**MySQL:** `` `settings` JSON ``

`json`과 `jsonb`의 차이는 PostgreSQL에서 중요해요: `jsonb`는 분해된 바이너리 형식으로 저장되어 입력은 느리지만 쿼리는 훨씬 빨라요. JSON 내부를 쿼리해야 하는 경우(예: `WHERE settings->>'theme' = 'dark'`), `jsonb`를 사용하세요.

### 값 변환

DB에서 읽은 값을 TypeScript 객체로 매핑할 때 변환 함수를 적용할 수 있어요. MySQL의 `TINYINT(1)`처럼 불리언이 숫자로 저장되는 경우에 유용해요.

```typescript
@Column({ transform: (raw) => raw === 1 })
isActive!: boolean;
```

Stingerloom이 데이터베이스에서 행을 읽을 때, 원시 `isActive` 값을 이 함수에 통과시켜요. 원시 숫자 `1`은 `true`가 되고, `0`은 `false`가 돼요.

### 컬럼 트랜스포머

위에서 보여준 `transform` 옵션은 한 방향으로만 동작해요 -- 데이터베이스에서 읽을 때만요. 하지만 실제로는 **양방향** 으로 값을 변환해야 하는 경우가 많아요. 두 언어 사이를 오가는 통역사처럼, 들어갈 때와 나올 때 모두 변환이 필요하죠.

이메일 주소를 생각해 볼게요. 중복을 방지하기 위해 모든 이메일을 소문자로 저장하고 싶어요(`Alice@Example.com`과 `alice@example.com`이 같아야 하니까요). 트랜스포머 없이는 모든 INSERT와 UPDATE 전에 `.toLowerCase()`를 호출하는 걸 기억해야 해요. 한 번이라도 잊으면 일관성 없는 데이터가 돼요. 컬럼 트랜스포머는 변환을 컬럼 정의 자체에 한 번만 선언해서 이 문제를 해결해요.

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

`to` 함수는 모든 INSERT와 UPDATE 전에 자동으로 실행돼요. `from` 함수는 모든 SELECT 후에 자동으로 실행되어, 원시 데이터베이스 값을 애플리케이션이 선호하는 형식으로 다시 변환해 줘요.

다음은 SQL 수준에서 일어나는 일이에요:

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

또 다른 일반적인 사용 사례는 암호화예요. 민감한 데이터를 데이터베이스에 도달하기 전에 암호화하고, 읽을 때 복호화할 수 있어요:

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

데이터베이스에는 암호화된 암호문이 저장돼요. 애플리케이션 코드는 평문으로 작업하고요. 변환은 나머지 코드베이스에 대해 투명하게 이루어져요.

**`transform`과의 하위 호환성:** 레거시 읽기 전용 `transform` 옵션은 여전히 동작해요. 같은 컬럼에 `transform`과 `transformer`를 모두 설정하면, 읽기 방향에서는 `transformer.from`이 우선해요. `transform` 옵션은 폐기(deprecated)되었으니, 모든 새 코드에서는 `transformer`를 사용하세요.

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

PostgreSQL에서 커스텀 ENUM 타입을 사용할 수 있어요. ENUM은 컬럼을 데이터베이스 자체에서 강제하는 고정된 허용 값 집합으로 제한해요.

```typescript
@Column({
  type: "enum",
  enumValues: ["draft", "published", "archived"],
  enumName: "post_status",
})
status!: string;
```

이건 PostgreSQL에서 두 개의 SQL 문을 생성해요:

```sql
-- First, create the custom type
CREATE TYPE "post_status" AS ENUM ('draft', 'published', 'archived');

-- Then use it in the column definition
"status" "post_status" NOT NULL
```

> **힌트** `enumName`을 생략하면 `{tableName}_{columnName}_enum` 형식으로 자동 생성돼요.

## 수동 기본 키 (@PrimaryColumn)

자동 증가 대신 값을 직접 지정해야 하는 기본 키가 필요한 경우가 있어요. 예를 들어, 키가 의미 있는 문자열인 키-값 구조의 설정 테이블 같은 경우죠.

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

`@PrimaryColumn()`은 AUTO_INCREMENT/SERIAL을 적용하지 않으므로, `save()` 호출 시 키 값을 직접 제공해야 해요.

```typescript
await em.save(Config, { key: "site.title", value: "My Blog" });
// INSERT INTO "config" ("key", "value") VALUES ('site.title', 'My Blog')
```

## 인덱스로 쿼리 성능 개선

### 인덱스가 존재하는 이유

1,000만 권의 책이 있는 도서관을 상상해 보세요. 하지만 목록 시스템이 없어요. 저자별로 책을 찾으려면 모든 서가를 걸어다니며 모든 책을 확인해야 해요. 인덱스가 없는 데이터베이스가 하는 일이 바로 이거예요 -- 테이블의 모든 행을 스캔하죠("풀 테이블 스캔"이라고 해요).

**인덱스** 는 도서관의 카드 목록 시스템과 같아요. 정렬된 데이터 구조(보통 **B-tree** , 디스크 읽기에 최적화된 균형 트리)를 유지해서 데이터베이스가 일치하는 행으로 직접 점프할 수 있게 해 줘요. 풀 스캔으로 100만 행 테이블에서 5초 걸리던 쿼리가 인덱스를 사용하면 5밀리초면 돼요.

트레이드오프: 인덱스는 디스크 공간을 소비하고 INSERT/UPDATE 작업을 약간 느리게 해요(인덱스도 업데이트해야 하니까요). WHERE, JOIN, 또는 ORDER BY 절에 자주 등장하는 컬럼에 인덱스를 추가하되, 모든 컬럼에 인덱스를 만들지는 마세요.

### 단일 컬럼 인덱스

자주 검색되는 컬럼에 **인덱스** 를 추가하면 쿼리 속도가 크게 향상돼요. 이메일로 사용자를 검색하는 경우를 생각해 볼게요.

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

`@Index()`를 추가하면 테이블 생성 후 다음 DDL이 생성돼요:

```sql
-- PostgreSQL
CREATE INDEX "INDEX_user_email" ON "user" ("email");

-- MySQL
CREATE INDEX `INDEX_user_email` ON `user` (`email`);
```

이제 ORM이 다음을 실행할 때:

```sql
SELECT * FROM "user" WHERE "email" = 'alice@example.com';
```

모든 행을 스캔하는 대신, 데이터베이스가 B-tree 인덱스를 탐색해서 O(log n) 시간에 일치하는 행을 찾아요.

### 복합 인덱스 (클래스 수준 @Index)

`@Index()`는 **클래스 수준** 데코레이터로도 사용해서 복합(다중 컬럼) 비고유 인덱스를 만들 수 있어요. 여러 컬럼으로 동시에 필터링하는 쿼리에 유용하죠.

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

이건 다음을 생성해요:

```sql
-- PostgreSQL
CREATE INDEX "idx_order_tenantId_status" ON "order" ("tenantId", "status");
```

복합 인덱스는 성(姓)으로 먼저 정렬하고 이름으로 다음에 정렬한 전화번호부와 같아요. 데이터베이스는 이걸 다음에 사용할 수 있어요:

- `WHERE tenantId = 5` (가장 왼쪽 컬럼 사용)
- `WHERE tenantId = 5 AND status = 'pending'` (두 컬럼 모두 사용 -- 가장 효율적)

하지만 `WHERE status = 'pending'` 단독으로는 효율적으로 사용할 수 없어요(가장 왼쪽 컬럼을 건너뛰는 건 성으로 먼저 정렬된 전화번호부에서 "John"이라는 이름을 가진 모든 사람을 찾는 것과 같아요).

커스텀 인덱스 이름을 지정할 수도 있어요.

```typescript
@Index(["tenantId", "status"], "idx_custom_name")
```

> **힌트** 프로퍼티 수준 `@Index()`는 단일 컬럼 인덱스를 생성해요. 클래스 수준 `@Index(columns)`는 복합 인덱스를 생성하고요. 둘 다 같은 엔티티에 사용할 수 있어요.

### 복합 고유 인덱스 (@UniqueIndex)

때로는 여러 컬럼의 **조합** 이 고유해야 해요. 예를 들어, 슬러그가 같은 카테고리 내에서만 고유하면 되는 경우죠.

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

이건 다음을 생성해요:

```sql
-- PostgreSQL
CREATE UNIQUE INDEX "UQ_post_categoryId_slug" ON "post" ("categoryId", "slug");
```

이 고유 인덱스가 있으면 다음 데이터는 허용돼요:

| categoryId | slug        |
| ---------- | ----------- |
| 1          | hello-world |
| 2          | hello-world |

하지만 다음은 데이터베이스가 거부해요:

| categoryId | slug        |
| ---------- | ----------- |
| 1          | hello-world |
| 1          | hello-world |

인덱스 이름을 직접 지정할 수도 있어요.

```typescript
@UniqueIndex(["categoryId", "slug"], { name: "uq_post_category_slug" })
```

> **힌트** `@UniqueIndex`와 `@Index(columns)`는 둘 다 **클래스 수준** 데코레이터예요. 프로퍼티 수준 `@Index()`(인수 없음)는 개별 프로퍼티에 배치해요.

### 고급 인덱스 옵션

컬럼에 대한 기본 B-tree 인덱스가 가장 일반적이지만, 실제 데이터베이스에는 더 전문화된 인덱스가 필요해요. 작업장의 도구와 비슷해요: 망치가 대부분의 못에 적합하지만, 때로는 드라이버, 렌치, 또는 톱이 필요하죠. 마찬가지로, 서로 다른 쿼리 패턴에는 서로 다른 인덱스 전략이 필요해요.

**부분 인덱스** 는 행의 하위 집합만 인덱싱해서 디스크 공간을 절약하고 성능을 향상시켜요. 사용자의 90%가 활성 상태이고 비활성 사용자는 거의 쿼리하지 않는다면, 모든 사용자를 인덱싱할 이유가 있을까요?

**표현식 인덱스** 는 계산된 값을 인덱싱할 수 있게 해 줘요. 이게 없으면 `WHERE LOWER(email) = 'alice@example.com'`은 `email` 컬럼의 일반 인덱스를 사용할 수 없어요. 인덱스가 원래의 대소문자 혼합 값을 저장하기 때문이에요.

**GIN 인덱스** 는 JSONB 데이터 내부의 빠른 검색과 전문 검색을 가능하게 해요. **BRIN 인덱스**는 값이 물리적 행 순서와 자연스럽게 상관관계가 있는 시계열 데이터를 위한 매우 컴팩트한 인덱스예요.

`@Index` 클래스 수준 데코레이터는 이 모든 걸 설정하기 위해 두 번째 인수로 `AdvancedIndexOptions` 객체를 받아요.

#### 부분 인덱스

부분 인덱스는 `WHERE` 조건에 일치하는 행만 포함해요. 소프트 삭제가 있는 테이블에서 삭제되지 않은 행을 거의 항상 쿼리할 때 유용하죠.

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

이 인덱스는 소프트 삭제된 행을 제외하므로 전체 인덱스보다 작아요. `WHERE email = '...' AND deleted_at IS NULL` 조건의 쿼리가 이 인덱스를 직접 사용해요.

> **참고:** 부분 인덱스는 PostgreSQL과 SQLite에서 지원돼요. MySQL은 인덱스에 `WHERE` 절을 지원하지 않아요.

#### 표현식 인덱스

표현식 인덱스는 원시 컬럼 값이 아닌 표현식의 결과를 인덱싱해요. 대소문자를 구분하지 않는 이메일 조회에 필수적이에요.

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

이제 `WHERE LOWER(email) = 'alice@example.com'` 쿼리가 풀 테이블 스캔 대신 이 인덱스를 사용해요. 표현식이 컬럼 목록을 대체하므로 컬럼 배열이 비어 있어요(`[]`).

#### 인덱스 타입 (USING)

기본적으로 데이터베이스는 동등 및 범위 쿼리에 최적인 B-tree 인덱스를 생성해요. 하지만 특수한 사용 사례를 위한 다른 인덱스 타입도 있어요.

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

이 GIN(Generalized Inverted Index)은 JSONB 데이터에 대한 빠른 `@>` 포함 쿼리를 가능하게 해요:

```sql
-- Find products where metadata contains {"color": "red"}
SELECT * FROM "product" WHERE "metadata" @> '{"color": "red"}';
-- Uses the GIN index instead of scanning every row
```

사용 가능한 인덱스 타입:

| 타입    | 적합한 용도                  | PostgreSQL | MySQL  |
| ------- | ---------------------------- | ---------- | ------ |
| `btree` | 동등, 범위, 정렬 (기본값)    | 지원       | 지원   |
| `hash`  | 동등만 (범위 불가)           | 지원       | 지원   |
| `gin`   | JSONB, 배열, 전문 검색       | 지원       | 미지원 |
| `gist`  | 기하학, 전문 검색, 범위 타입 | 지원       | 미지원 |
| `brin`  | 대규모 시계열 테이블         | 지원       | 미지원 |

> **참고:** MySQL은 `btree`와 `hash`만 지원해요. `gin`, `gist`, 또는 `brin`을 지정하고 MySQL에서 실행하면 인덱스 생성이 실패해요.

#### 커버링 인덱스 (INCLUDE)

커버링 인덱스는 인덱싱된 컬럼과 함께 추가 컬럼을 저장해서, 데이터베이스가 메인 테이블을 읽지 않고 인덱스만으로 쿼리에 응답할 수 있게 해 줘요. 이걸 "인덱스 전용 스캔"이라고 해요.

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

이제 `SELECT name FROM "user" WHERE email = 'alice@example.com'` 같은 쿼리를 힙(메인 테이블 저장소)에 접근하지 않고 인덱스만으로 처리할 수 있어요. `INCLUDE` 컬럼은 인덱스 리프 페이지에 저장되지만 검색 키의 일부는 아니에요.

> **참고:** `INCLUDE`가 포함된 커버링 인덱스는 PostgreSQL 11+에서 지원돼요. MySQL은 `INCLUDE` 절을 지원하지 않아요.

#### 옵션 결합

고급 인덱스 옵션은 결합할 수 있어요. 예를 들어, 부분 커버링 인덱스:

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

이건 활성 사용자만 커버하고 인덱스 전용 스캔을 위해 name 컬럼을 포함하는 컴팩트하고 고성능인 인덱스를 생성해요.

## 낙관적 잠금 (@Version)

### 낙관적 잠금이 존재하는 이유

두 명의 고객 서비스 상담원이 오전 10:00에 같은 주문을 연다고 상상해 보세요. 상담원 A가 10:01에 상태를 "배송됨"으로 변경해요. 상담원 B는 여전히 이전 데이터를 보고 있고, 10:02에 상태를 "환불됨"으로 변경해요. 상담원 B의 업데이트가 상담원 A의 변경을 조용히 덮어써요. 이게 **갱신 분실 문제(lost update problem)** 예요.

한 가지 해결책은 **비관적 잠금** -- 행을 잠가서 아무도 건드리지 못하게 하는 거예요. 하지만 이건 느리고 데드락을 유발할 수 있어요. 대부분의 애플리케이션에 더 나은 접근법은 **낙관적 잠금** 이에요: 충돌이 드물다고 가정하되, 발생했을 때 감지하는 방식이죠.

### 동작 방식

`@Version()` 데코레이터를 사용하면 엔티티에 버전 카운터가 추가돼요.

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

다음은 SQL 수준에서 정확히 일어나는 일이에요.

**INSERT 시**, ORM이 자동으로 `version = 1`을 설정해요:

```sql
INSERT INTO "order" ("status", "version") VALUES ('pending', 1);
```

**UPDATE 시** , ORM이 `WHERE version = N`을 추가하고 버전을 증가시켜요:

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

UPDATE가 0행에 영향을 미치면, 다른 누군가가 먼저 데이터를 수정했다는 뜻이에요. Stingerloom이 이걸 감지하고 `OptimisticLockError`를 발생시켜서, 조용한 데이터 손실을 방지해요.

> **힌트** 낙관적 잠금은 충돌이 드물지만 데이터 무결성이 중요한 경우에 적합해요(예: 주문 상태 변경, 재고 관리). 거의 모든 요청에서 충돌이 발생하는 높은 경합 시나리오에서는 `SELECT ... FOR UPDATE`를 사용한 비관적 잠금을 고려해 보세요.

## 소프트 삭제 (@DeletedAt)

### 소프트 삭제가 존재하는 이유

하드 삭제(`DELETE FROM ...`)는 데이터를 영구적으로 제거해요. 삭제되면 (백업이 없는 한) 영원히 사라지죠. 많은 실제 애플리케이션에서는 다음과 같은 요구사항이 있어요:

1. 사용자가 삭제를 "되돌릴" 수 있게 하기 (파일 시스템의 휴지통처럼)
2. 규정 준수를 위한 감사 추적 유지
3. 애플리케이션에서는 숨기면서 분석을 위해 데이터 보존

소프트 삭제는 실제로 행을 삭제하지 않고, "삭제된" 시점을 나타내는 타임스탬프로 행을 표시해서 이 문제를 해결해요.

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

`@DeletedAt()` 데코레이터를 추가하면 SQL 수준에서 세 가지가 변경돼요.

**첫째** , `em.softDelete(Post, { id: 1 })` 호출은 DELETE가 아닌 UPDATE를 실행해요:

```sql
-- Instead of: DELETE FROM "post" WHERE "id" = 1
-- Stingerloom runs:
UPDATE "post" SET "deletedAt" = NOW() WHERE "id" = 1;
```

**둘째** , `em.find(Post)`는 소프트 삭제된 행을 제외하기 위해 자동으로 `WHERE` 필터를 추가해요:

```sql
-- Your code:
await em.find(Post);

-- Generated SQL:
SELECT * FROM "post" WHERE "deletedAt" IS NULL;
```

모든 쿼리가 자동으로 소프트 삭제된 행을 무시해요. 이 조건을 직접 추가할 필요가 없어요.

**셋째** , 삭제된 데이터를 쿼리에 포함하려면 `{ withDeleted: true }` 옵션을 사용하세요:

```sql
-- Your code:
await em.find(Post, { withDeleted: true });

-- Generated SQL (no filter):
SELECT * FROM "post";
```

소프트 삭제된 행을 복원하려면:

```sql
-- Your code:
await em.restore(Post, { id: 1 });

-- Generated SQL:
UPDATE "post" SET "deletedAt" = NULL WHERE "id" = 1;
```

코드로 보는 전체 라이프사이클이에요:

```typescript
await em.softDelete(Post, { id: 1 }); // soft delete
const posts = await em.find(Post); // excludes deleted
const all = await em.find(Post, { withDeleted: true }); // includes deleted
await em.restore(Post, { id: 1 }); // restore
```

## 자동 타임스탬프 (@CreateTimestamp / @UpdateTimestamp)

### 자동 타임스탬프가 존재하는 이유

프로덕션 애플리케이션의 거의 모든 테이블은 두 가지 질문에 답해야 해요: "이 행이 언제 생성되었는가?"와 "마지막으로 수정된 것은 언제인가?" 이 타임스탬프는 디버깅("이 데이터가 언제 변경되었지?"), 정렬("최신순으로 보여줘"), 감사에 필수적이에요.

`save()`를 호출할 때마다 수동으로 설정할 수도 있지만, 오류가 발생하기 쉬워요 -- 한 번이라도 잊으면 잘못된 데이터가 돼요. `@CreateTimestamp`과 `@UpdateTimestamp` 데코레이터가 이걸 자동으로 처리해 줘요.

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

ORM이 각 값을 설정하는 정확한 시점이에요.

**INSERT 시** , `createdAt`과 `updatedAt` 모두 현재 시간으로 설정돼요:

```sql
-- Your code:
await em.save(Article, { title: "Hello World" });

-- Generated SQL (PostgreSQL):
INSERT INTO "article" ("title", "createdAt", "updatedAt")
VALUES ('Hello World', '2026-03-22 10:30:00', '2026-03-22 10:30:00');
```

ORM은 `NOW()` 같은 SQL 함수가 아닌 애플리케이션 코드(`new Date()`)에서 타임스탬프를 생성해요. 이렇게 하면 두 컬럼이 밀리초 단위까지 정확히 같은 값을 가져요.

**UPDATE 시** , `updatedAt`만 갱신돼요. `createdAt`은 변경되지 않아요:

```sql
-- Your code:
await em.save(Article, { id: 1, title: "Hello World (updated)" });

-- Generated SQL (PostgreSQL):
UPDATE "article"
SET "title" = 'Hello World (updated)', "updatedAt" = '2026-03-22 11:45:00'
WHERE "id" = 1;
-- Notice: createdAt is NOT in the SET clause
```

두 데코레이터 모두 `DATETIME` (MySQL) / `TIMESTAMP` (PostgreSQL) NOT NULL 컬럼을 생성해요. PostgreSQL에서 타임존 인식 타임스탬프가 필요하면 라이프사이클 훅과 함께 `@Column({ type: "timestamptz" })`를 사용하세요.

> **힌트** `save()` 호출 시 `@CreateTimestamp` 또는 `@UpdateTimestamp` 컬럼에 대해 값을 명시적으로 제공하면, 자동 생성된 값 대신 제공된 값이 사용돼요. 원본 타임스탬프를 보존하고 싶은 데이터 마이그레이션 시나리오에 유용해요.

### 계산 컬럼 (@ComputedColumn)

일부 컬럼 값은 항상 다른 컬럼에서 파생돼요. 사람의 전체 이름은 항상 `first_name + ' ' + last_name`이에요. 주문 라인의 합계는 항상 `price * quantity`이고요. 이걸 애플리케이션 코드에서 계산할 수도 있지만, 그러면 모든 쿼리, 모든 서비스, 모든 보고서에서 같은 공식을 반복해야 해요. 한 번이라도 잊으면 값이 잘못되죠. 수식을 사용하는 대신 모든 셀에 합계를 수동으로 입력하는 스프레드시트와 같아요 -- 결국 누군가 실수를 하게 돼요.

**계산 컬럼**(생성 컬럼이라고도 해요)은 이 공식을 데이터베이스 자체로 이동시켜요. 스프레드시트 수식이 자동으로 재계산되는 것처럼, 데이터베이스가 값이 항상 정확하도록 보장해요.

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

`GENERATED ALWAYS AS (expression)` 절은 데이터베이스에 이 값을 자동으로 계산하도록 지시해요. 직접 설정할 필요가 없고, 실제로 데이터베이스는 생성 컬럼에 값을 쓰려는 모든 INSERT나 UPDATE를 거부해요.

Stingerloom은 자동으로 계산 컬럼을 INSERT와 UPDATE 문에서 제외해요. `em.save()`를 호출할 때, ORM은 `total`을 SQL에 포함하지 않아야 한다는 걸 알고 있어요:

```typescript
await em.save(OrderLine, { price: 29.99, quantity: 3 });
// Generated SQL (PostgreSQL):
// INSERT INTO "orderLine" ("price", "quantity") VALUES (29.99, 3)
// Note: "total" is NOT in the INSERT -- the DB computes it as 89.97
```

또 다른 일반적인 예시 -- 이름과 성을 연결하기:

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

`stored` 옵션은 데이터베이스가 계산된 값을 처리하는 방식을 제어해요:

| 모드        | `stored`         | 동작                                    | 디스크 공간    | 인덱싱 가능 |
| ----------- | ---------------- | --------------------------------------- | -------------- | ----------- |
| **STORED**  | `true`           | INSERT/UPDATE 시 계산하여 디스크에 저장 | 공간 사용      | 가능        |
| **VIRTUAL** | `false` (기본값) | 매 SELECT 읽기마다 계산                 | 추가 공간 없음 | 제한적      |

**STORED** 컬럼은 행이 기록될 때 한 번 계산되고 일반 컬럼처럼 디스크에 유지돼요. 인덱싱이 가능하므로, 검색하거나 정렬하는 컬럼(`fullName` 같은)에 적합해요.

**VIRTUAL** 컬럼은 행을 읽을 때마다 계산돼요. 추가 디스크 공간을 사용하지 않지만 매 SELECT마다 CPU 오버헤드가 추가돼요. 표시하지만 검색하지는 않는 값에 가상 컬럼을 사용하세요.

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

> **힌트** 계산 컬럼은 PostgreSQL 12+, MySQL 5.7+, SQLite에서 지원돼요. `@ComputedColumn` 데코레이터는 선택적으로 `type`, `length`, `nullable` 옵션을 받아요. `type`을 생략하면 데이터베이스가 표현식에서 타입을 추론해요.

## 라이프사이클 훅

### 라이프사이클 훅이 존재하는 이유

때로는 엔티티 라이프사이클의 특정 순간에 커스텀 로직을 실행해야 해요 -- 삽입 전, 업데이트 후, 삭제 전 등. 예를 들어, 저장 전에 제목에서 URL 슬러그를 생성하거나, 엔티티 생성 후 알림을 보내고 싶을 수 있죠.

라이프사이클 훅을 사용하면 이 로직을 엔티티 클래스에 직접 정의할 수 있어서, 해당 라이프사이클 이벤트가 발생할 때마다 자동으로 실행돼요.

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

`@BeforeInsert()`로 데코레이트된 메서드는 INSERT SQL이 실행되기 직전에 자동으로 호출돼요. 위 예시에서 `em.save(Article, { title: "Hello World" })`를 호출하면, ORM이 먼저 `generateSlug()`를 호출해서 `this.slug = "hello-world"`를 설정하고, INSERT에 슬러그가 포함돼요:

```sql
INSERT INTO "article" ("title", "slug") VALUES ('Hello World', 'hello-world');
```

총 6개의 라이프사이클 훅을 사용할 수 있어요.

| 데코레이터        | 실행 시점            | 사용 시기                               |
| ----------------- | -------------------- | --------------------------------------- |
| `@BeforeInsert()` | INSERT SQL 실행 직전 | 기본값 설정, 슬러그 생성, 데이터 정규화 |
| `@AfterInsert()`  | INSERT 완료 후       | 로깅, 알림 전송, 캐시 무효화            |
| `@BeforeUpdate()` | UPDATE SQL 실행 직전 | 계산 필드 업데이트, 유효성 검사         |
| `@AfterUpdate()`  | UPDATE 완료 후       | 변경 이력 기록, 웹훅 트리거             |
| `@BeforeDelete()` | DELETE SQL 실행 직전 | 삭제 전 정리, 권한 확인                 |
| `@AfterDelete()`  | DELETE 완료 후       | 관련 리소스 정리, 로깅                  |

새 엔티티를 삽입하는 `save()` 호출의 실행 순서는 이래요:

1. `@BeforeInsert()` 훅 실행 (여기서 엔티티를 변경할 수 있어요)
2. `INSERT INTO ...` SQL 실행
3. `@AfterInsert()` 훅 실행 (엔티티에 자동 생성된 ID가 있어요)

> **힌트** "After" 훅에서는 DB 작업이 이미 완료되었으므로, 데이터를 수정해도 DB에 반영되지 않아요. 로깅이나 외부 알림 같은 부수 효과에 사용하세요.

## 유효성 검사

### 유효성 검사가 존재하는 이유

데이터베이스에는 일부 내장 제약 조건(NOT NULL, VARCHAR 길이, UNIQUE)이 있지만, 암호화 같은 에러 메시지를 생성하고 네트워크 왕복 후에야 문제를 발견해요. 애플리케이션 수준 유효성 검사는 SQL 쿼리가 빌드되기 전에 미리 실수를 포착하고, 명확한 오류 메시지를 반환해요.

### 동작 방식

`save()`가 호출될 때 자동으로 데이터가 올바른지 확인하려면 유효성 검사 데코레이터를 사용하세요. 유효성 검사에 실패하면 `ValidationError`가 발생해서 잘못된 데이터가 DB에 들어가는 걸 방지해요.

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

각 데코레이터의 역할은 자명해요.

- **`@NotNull()`** -- `null` 또는 `undefined`이면 오류
- **`@MinLength(n)` / `@MaxLength(n)`** -- 문자열 길이 유효성 검사
- **`@Min(n)` / `@Max(n)`** -- 숫자 범위 유효성 검사

잘못된 데이터로 `save()`를 호출하면 DB 쿼리가 실행되기 전에 오류가 발생해요. SQL이 데이터베이스에 전혀 전송되지 않아요.

```typescript
await em.save(Member, { name: "A", age: -1 });
// ValidationError: name must be at least 2 characters long
// (no INSERT was attempted)
```

이건 데이터베이스 제약 조건 오류와 달라요. `NOT NULL` 제약 조건 위반은 쿼리가 전송된 후에 데이터베이스 특정 오류를 반환해요. `@NotNull()` 유효성 검사 오류는 네트워크 호출 전에 애플리케이션 코드에서 포착돼요.

## 완전한 실제 예시

지금까지 다룬 모든 기능을 결합한 블로그 사용자 엔티티예요.

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

Stingerloom이 이 엔티티의 일반적인 작업에 대해 생성하는 SQL이에요.

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

이 단일 엔티티에 자동 증가 PK, 유효성 검사, 인덱스, JSON 컬럼, 낙관적 잠금, 소프트 삭제, 자동 타임스탬프, 로깅이 포함되어 있어요.

## ColumnType 참조

### TypeScript 타입 자동 추론

`@Column()`에서 `type`을 생략하면 TypeScript 타입에서 자동으로 추론돼요.

| TypeScript 타입 | ColumnType | 기본 길이 | nullable |
| --------------- | ---------- | --------- | -------- |
| `String`        | varchar    | 255       | false    |
| `Number`        | int        | 11        | false    |
| `Boolean`       | boolean    | 1         | false    |
| `Date`          | datetime   | 0         | false    |
| `Buffer`        | blob       | 0         | true     |
| 기타            | text       | 0         | true     |

### ColumnType별 DB 매핑

이 표는 각 추상 `ColumnType`이 각 드라이버의 `castType()` 메서드에 의해 구체적인 데이터베이스 타입으로 어떻게 변환되는지 보여줘요.

| ColumnType       | MySQL/MariaDB | PostgreSQL       | SQLite  |
| ---------------- | ------------- | ---------------- | ------- |
| `varchar`        | VARCHAR(n)    | VARCHAR(n)       | TEXT    |
| `int` / `number` | INT           | INTEGER          | INTEGER |
| `float`          | FLOAT         | REAL             | REAL    |
| `double`         | DOUBLE        | DOUBLE PRECISION | REAL    |
| `bigint`         | BIGINT        | BIGINT           | INTEGER |
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

### @Column 전체 옵션

| 옵션            | 타입           | 설명                                           |
| --------------- | -------------- | ---------------------------------------------- |
| `name`          | `string`       | DB 컬럼 이름 (기본값: 프로퍼티 이름)           |
| `type`          | `ColumnType`   | 컬럼 타입 (생략 시 자동 추론)                  |
| `length`        | `number`       | 컬럼 길이                                      |
| `nullable`      | `boolean`      | NULL 허용 (기본값: false)                      |
| `primary`       | `boolean`      | 기본 키 여부                                   |
| `autoIncrement` | `boolean`      | AUTO_INCREMENT 적용 여부                       |
| `default`       | `unknown`      | 컬럼 기본값 (리터럴 또는 괄호로 감싼 원시 SQL) |
| `transform`     | `(raw) => any` | **(폐기됨)** 읽기 전용 값 변환 함수            |
| `transformer`   | `{ to, from }` | 양방향 값 트랜스포머 (쓰기와 읽기)             |
| `precision`     | `number`       | 소수 정밀도                                    |
| `scale`         | `number`       | 소수 스케일                                    |
| `enumValues`    | `string[]`     | PostgreSQL ENUM 값 목록                        |
| `enumName`      | `string`       | PostgreSQL ENUM 타입 이름                      |

## 데코레이터 없이 엔티티 정의하기 (EntitySchema)

### EntitySchema가 존재하는 이유

TypeScript 데코레이터는 `emitDecoratorMetadata` 컴파일러 옵션에 의존하는데, 일부 빌드 도구(esbuild, SWC)는 이걸 지원하지 않아요. 완전한 데코레이터 지원이 있더라도, 일부 팀은 "순수 클래스" 철학에 따라 도메인 클래스에 ORM 관련 어노테이션을 넣지 않는 걸 선호해요. `EntitySchema`는 스키마 정의를 클래스 자체에서 분리해서 두 가지 우려 사항을 모두 해결해요.

`EntitySchema`는 데코레이터 기반 접근 방식과 동일한 메타데이터를 등록하므로, 나머지 ORM(EntityManager, SchemaGenerator 등)은 동일하게 동작해요. 두 접근 방식은 같은 프로젝트에서 공존할 수 있어요.

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

이건 데코레이터 기반 버전과 정확히 같은 DDL을 생성해요:

```sql
-- PostgreSQL
CREATE TABLE "users" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL,
  "email" VARCHAR(255)
);
CREATE INDEX "INDEX_users_email" ON "users" ("email");
```

`target` 클래스는 순수 TypeScript 클래스예요 -- 데코레이터가 필요 없어요. `tableName`은 선택 사항이고, 생략하면 `@Entity()`와 동일하게 클래스 이름에서 snake_case로 파생돼요.

### 컬럼 옵션

`ColumnSchemaDef`는 `@Column()`과 동일한 옵션을 지원하며, 특수 데코레이터를 위한 플래그도 있어요:

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

`version`, `createTimestamp`, `updateTimestamp`, `deletedAt` 플래그는 각각 `@Version()`, `@CreateTimestamp()`, `@UpdateTimestamp()`, `@DeletedAt()` 데코레이터를 대체해요. 생성되는 DDL과 런타임 동작은 동일해요.

### 관계

관계는 `kind` 구분자가 있는 `relations` 옵션으로 정의해요:

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

네 가지 관계 종류가 모두 지원돼요:

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

### 라이프사이클 훅

대상 클래스의 메서드 이름을 지정해요:

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

### 유효성 검사

컬럼 정의에서 `validation` 배열을 통한 인라인 유효성 검사:

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

EntitySchema는 `inheritance`, `discriminatorColumn`, `discriminatorValue` 옵션으로 세 가지 상속 전략(STI, TPT, TPC)을 모두 지원해요. `@Inheritance()`, `@DiscriminatorColumn()`, `@DiscriminatorValue()` 데코레이터를 대체해요.

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

// 루트 엔티티: 전략 + discriminator 컬럼 정의
new EntitySchema<Payment>({
  target: Payment,
  inheritance: { strategy: "SINGLE_TABLE" },
  discriminatorColumn: { name: "payment_type", type: "varchar", length: 50 },
  columns: {
    id:     { type: "int", primary: true, autoIncrement: true },
    amount: { type: "int" },
  },
});

// 자식 엔티티: 고유 컬럼 + discriminator 값만 정의
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

자식 엔티티는 프로토타입 체인을 통해 부모 컬럼을 자동으로 상속받아요. STI에서는 모든 자식이 루트의 테이블 이름을 공유해요. TPT(`"JOINED"`)와 TPC(`"TABLE_PER_CLASS"`)에서는 각 자식이 자체 테이블을 가져요.

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

`discriminatorColumn` 옵션은 루트 엔티티에서 선택 사항이에요 -- 생략하면 기본적으로 `"dtype"`이라는 이름의 `VARCHAR(31)` 컬럼이 만들어져요. `discriminatorValue` 옵션은 자식 엔티티에서 선택 사항이에요 -- 생략하면 클래스 이름이 사용돼요.

EntityManager, QueryBuilder, WriteBuffer, InheritanceResolver 등 모든 ORM 기능은 데코레이터로 정의하든 EntitySchema로 정의하든 동일하게 동작해요.

::: tip
세 가지 전략의 자세한 비교와 생성되는 SQL 예시는 [상속 매핑](./inheritance-mapping.md) 가이드를 참고하세요.
:::

### 데코레이터와 EntitySchema 엔티티 혼용

두 접근 방식은 동일한 메타데이터를 생성하므로 자유롭게 혼용할 수 있어요:

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

엔티티를 정의했으니, 이제 엔티티 간의 관계를 설정할 차례예요.

- [관계](./relations.md) -- `@ManyToOne`, `@OneToMany` 등으로 테이블 간 관계 정의
- [EntityManager](./entity-manager.md) -- 정의한 엔티티로 CRUD 수행
- [트랜잭션](./transactions.md) -- 여러 작업을 하나의 단위로 묶기
- [마이그레이션](./migrations.md) -- 스키마 변경을 안전하게 관리
