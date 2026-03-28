# 관계 (Relations)

**관계(Relation)**란 두 엔티티 간의 연결을 의미합니다. "블로그 글에는 작성자가 있다"거나 "한 주인이 여러 마리의 고양이를 가진다"와 같은 실세계의 관계를 데이터베이스에 반영합니다.

데코레이터에 대해 알아보기 전에, 관계가 어떤 문제를 해결하는지 먼저 이해해봅시다.

관계가 없다면, 고양이 테이블에 주인의 ID를 단순 정수로 저장한 뒤, 고양이를 조회할 때 주인의 데이터를 가져오기 위해 직접 JOIN 쿼리를 작성해야 합니다. 또한 외래 키 제약 조건, null 검사, 데이터 무결성도 직접 처리해야 합니다. 관계는 이 모든 것을 자동화합니다: 연결을 한 번 선언하면 ORM이 올바른 JOIN, FK 제약 조건, DDL을 자동으로 생성합니다.

Stingerloom ORM은 네 가지 유형의 관계를 지원합니다.

| 관계 | 예시 | 데코레이터 |
|------|------|-----------|
| Many-to-One (N:1) | Cat -> Owner | `@ManyToOne` |
| One-to-Many (1:N) | Owner -> Cats | `@OneToMany` |
| One-to-One (1:1) | User -> Profile | `@OneToOne` |
| Many-to-Many (N:M) | Post <-> Tag | `@ManyToMany` |

가장 흔한 Many-to-One 관계부터 시작하여 하나씩 살펴보겠습니다.

## @ManyToOne -- "이 고양이의 주인은 누구인가?"

### 이 관계가 존재하는 이유

고양이와 주인의 관계를 생각해봅시다. 한 주인이 여러 마리의 고양이를 가질 수 있지만, 각 고양이에게는 주인이 한 명뿐입니다. 모든 데이터를 하나의 테이블에 저장하면, 고양이마다 주인의 정보가 중복됩니다:

| cat_name | owner_name | owner_email |
|----------|-----------|-------------|
| Whiskers | John | john@mail.com |
| Cheddar | John | john@mail.com |
| Luna | Jane | jane@mail.com |

이는 낭비이며 위험합니다 -- John이 이메일을 변경하면 여러 행을 수정해야 하고, 하나라도 놓치면 데이터가 불일치 상태가 됩니다. 해결책은 **정규화(normalization)**입니다: 주인을 하나의 테이블에, 고양이를 다른 테이블에 저장한 뒤, **외래 키(FK)**로 연결합니다.

외래 키는 한 테이블의 컬럼이 다른 테이블의 기본 키를 참조하는 것입니다. "이 값은 항상 다른 테이블의 유효한 행을 가리킨다"는 약속입니다.

### 동작 방식

먼저 두 엔티티를 생성합니다.

```typescript
// owner.entity.ts
import { Entity, PrimaryGeneratedColumn, Column } from "@stingerloom/orm";

@Entity()
export class Owner {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;
}
```

```typescript
// cat.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, ManyToOne } from "@stingerloom/orm";
import { Owner } from "./owner.entity";

@Entity()
export class Cat {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @ManyToOne(() => Owner, (owner) => owner.cats, {
    joinColumn: "owner_id",
  })
  owner!: Owner;
}
```

### 생성되는 DDL

다음은 두 엔티티에 대해 Stingerloom이 생성하는 정확한 SQL입니다.

**PostgreSQL:**

```sql
CREATE TABLE "owner" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL
);

CREATE TABLE "cat" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL,
  "owner_id" INTEGER
);

ALTER TABLE "cat"
  ADD CONSTRAINT "fk_cat_owner_id_a1b2c3d4"
  FOREIGN KEY ("owner_id") REFERENCES "owner" ("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
```

**MySQL:**

```sql
CREATE TABLE `owner` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255) NOT NULL,
  PRIMARY KEY (`id`)
);

CREATE TABLE `cat` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255) NOT NULL,
  `owner_id` INT,
  PRIMARY KEY (`id`)
);

ALTER TABLE `cat`
  ADD CONSTRAINT `fk_cat_owner_id_a1b2c3d4`
  FOREIGN KEY (`owner_id`) REFERENCES `owner` (`id`)
  ON DELETE NO ACTION ON UPDATE NO ACTION;
```

세 가지 사항을 주목하세요:

1. `owner_id` 컬럼은 `cat` 테이블에 생성됩니다 ("다(many)" 쪽이 항상 FK를 보유합니다)
2. `ALTER TABLE ... ADD CONSTRAINT FOREIGN KEY`는 모든 `owner_id` 값이 기존 `owner.id`에 대응하는지 보장합니다
3. FK 제약 조건 이름에는 고유성을 위한 해시 접미사(예: `a1b2c3d4`)가 포함됩니다

### JOIN이 포함된 SELECT 생성

고양이를 주인과 함께 조회하면, Stingerloom은 LEFT JOIN 쿼리를 생성합니다:

```typescript
const cat = await em.findOne(Cat, {
  where: { id: 1 },
  relations: ["owner"],
});
```

**생성되는 SQL (PostgreSQL):**

```sql
SELECT
  "cat"."id"       AS "cat_id",
  "cat"."name"     AS "cat_name",
  "cat"."owner_id" AS "cat_owner_id",
  "owner"."id"     AS "owner_id",
  "owner"."name"   AS "owner_name"
FROM "cat"
LEFT JOIN "owner" ON "cat"."owner_id" = "owner"."id"
WHERE "cat"."id" = 1;
```

`LEFT JOIN`은 "주인이 없는 고양이(owner_id가 NULL)라도 반환하라"는 뜻입니다. `INNER JOIN`을 사용하면, 주인이 없는 고양이는 결과에서 제외됩니다.

### 데코레이터 인자 이해하기

`@ManyToOne`의 세 가지 인자를 살펴봅시다:

- `() => Owner` -- 대상 엔티티 (import 시점의 순환 참조를 방지하기 위해 함수로 감쌈)
- `(owner) => owner.cats` -- 역방향 프로퍼티 (양방향 관계에 사용; 단방향이면 생략 가능)
- `{ joinColumn: "owner_id" }` -- 외래 키 컬럼명

> **힌트** `joinColumn`은 생략할 수 있습니다. 아래의 **@Column 기반 FK 자동 감지**를 참고하세요.

### @Column 기반 FK 자동 감지

매번 `joinColumn`을 지정하는 것은 번거롭고, `@Column`의 DB 컬럼명과 불일치할 위험이 있습니다. Stingerloom은 같은 엔티티에 `{propertyName}Id` 패턴의 `@Column`이 선언되어 있으면, 해당 `@Column`의 **실제 DB 이름**을 FK 컬럼으로 자동 사용합니다.

```typescript
@Entity()
export class Cat {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  // DB 컬럼명이 "owner_fk"인 FK 컬럼
  @Column({ name: "owner_fk", type: "int" })
  ownerId!: number;

  // ownerId의 DB 이름인 "owner_fk"가 joinColumn 없이 자동 적용됩니다
  @ManyToOne(() => Owner, (owner) => owner.cats)
  owner!: Owner;
}
```

해석 우선순위는 다음과 같습니다.

1. `@ManyToOne`의 `joinColumn` 옵션이 지정된 경우 -> 그대로 사용
2. 같은 엔티티에 `{propertyName}Id`인 `@Column`이 선언된 경우 -> 해당 `@Column`의 DB 컬럼명 사용
3. 둘 다 없는 경우 -> `{propertyName}Id` 규칙으로 폴백

`@Column`을 선언하면 엔티티에서 FK 값을 직접 읽고 쓸 수 있다는 장점도 있습니다.

```typescript
const cat = new Cat();
cat.ownerId = 3;          // FK 값을 직접 설정 (Owner를 로드할 필요 없음)
await em.save(Cat, cat);

console.log(cat.ownerId); // FK 값을 직접 읽기
```

생성되는 SQL:

```sql
INSERT INTO "cat" ("name", "owner_fk") VALUES ('Whiskers', 3);
```

### PK가 아닌 컬럼 참조 (references)

기본적으로 FK는 대상 엔티티의 PK를 참조합니다. PK가 아닌 컬럼을 참조하려면 `references` 옵션을 사용합니다.

```typescript
@ManyToOne(() => Owner, (owner) => owner.cats, {
  joinColumn: "owner_uuid_fk",
  references: "uuid",  // Owner.id 대신 Owner.uuid 컬럼을 참조
})
owner!: Owner;
```

생성되는 SQL:

```sql
ALTER TABLE "cat"
  ADD CONSTRAINT "fk_cat_owner_uuid_fk_e5f6g7h8"
  FOREIGN KEY ("owner_uuid_fk") REFERENCES "owner" ("uuid");
```

### 참조 무결성 액션 (onDelete / onUpdate)

기본적으로 외래 키는 `ON DELETE NO ACTION ON UPDATE NO ACTION`을 사용합니다. 이는 고양이를 가진 주인을 삭제하거나, 주인의 PK를 변경하려는 시도를 데이터베이스가 거부한다는 뜻입니다. `onDelete`와 `onUpdate` 옵션으로 이 동작을 변경할 수 있습니다.

```typescript
@ManyToOne(() => Owner, (owner) => owner.cats, {
  joinColumn: "owner_id",
  onDelete: "CASCADE",     // 주인 삭제 시 고양이도 삭제
  onUpdate: "CASCADE",     // 주인 PK 변경 시 FK도 갱신
})
owner!: Owner;
```

생성되는 SQL:

```sql
ALTER TABLE "cat"
  ADD CONSTRAINT "fk_cat_owner_id_a1b2c3d4"
  FOREIGN KEY ("owner_id") REFERENCES "owner" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
```

`CASCADE`를 사용하면, 주인 #3을 삭제할 때 데이터베이스가 `owner_id = 3`인 모든 고양이를 자동으로 삭제합니다. 이 옵션이 없으면 삭제 시 외래 키 위반 오류가 발생합니다.

사용 가능한 액션:

| 액션 | 동작 |
|------|------|
| `'NO ACTION'` | 자식 행이 존재하면 거부 (기본값) |
| `'RESTRICT'` | NO ACTION과 동일 (즉시 검사) |
| `'CASCADE'` | 자식을 자동으로 삭제/갱신 |
| `'SET NULL'` | FK를 NULL로 설정 (컬럼이 nullable이어야 함) |
| `'SET DEFAULT'` | FK를 기본값으로 설정 |

이 옵션들은 `@ManyToOne`과 `@OneToOne` 모두에서 동작합니다.

### FK 제약 조건 건너뛰기 (createForeignKeyConstraints)

일부 경우(예: 크로스 데이터베이스 참조, 성능이 중요한 테이블)에는 논리적 관계는 유지하면서 FK 제약 조건 생성을 건너뛰고 싶을 수 있습니다.

```typescript
@ManyToOne(() => ExternalEntity, (e) => e.items, {
  joinColumn: "external_id",
  createForeignKeyConstraints: false,  // DDL에 FK 제약 조건 없음
})
external!: ExternalEntity;
```

컬럼은 여전히 생성되지만, `ALTER TABLE ... ADD CONSTRAINT FOREIGN KEY`는 생성되지 않습니다. ORM은 여전히 관계를 이해하고 JOIN을 올바르게 생성합니다 -- 단지 데이터베이스에 연결을 강제하도록 요청하지 않을 뿐입니다. 이 옵션은 `@OneToOne`에서도 동작합니다.

## @OneToMany -- "이 주인의 고양이들은?"

### 역방향(Inverse) 측인 이유

주인 쪽에서 고양이 목록을 가져오고 싶다면 `@OneToMany`를 추가합니다. 이는 `@ManyToOne`의 역방향입니다.

중요한 점을 이해해야 합니다: **`@OneToMany`는 데이터베이스에 어떤 컬럼도 생성하지 않습니다.** 외래 키 컬럼(`owner_id`)은 `@ManyToOne`에 의해 `cat` 테이블에 존재합니다. `@OneToMany` 데코레이터는 단순히 ORM에게 "누군가 주인의 고양이를 요청하면, FK를 사용하여 `cat` 테이블을 조회하라"고 알려줍니다.

이렇게 생각해보세요: 현실 세계에서 각 고양이는 주인의 이름이 적힌 목걸이(FK)를 착용합니다. 주인은 고양이 ID 목록을 가지고 다니지 않습니다. 주인의 고양이를 찾으려면 모든 목걸이를 확인합니다.

### 동작 방식

```typescript
// owner.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, OneToMany } from "@stingerloom/orm";
import { Cat } from "./cat.entity";

@Entity()
export class Owner {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @OneToMany(() => Cat, { mappedBy: "owner" })
  cats!: Cat[];
}
```

`mappedBy: "owner"`는 "Cat 엔티티의 `owner` 프로퍼티가 외래 키를 보유한다"는 뜻입니다. 이를 통해 ORM은 JOIN에 어떤 컬럼을 사용할지 알게 됩니다.

**Owner 테이블의 DDL은 변경되지 않습니다.** 추가 컬럼이 생기지 않습니다:

```sql
-- PostgreSQL
CREATE TABLE "owner" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL
);
-- 이것이 전부입니다. "cats" 컬럼은 존재하지 않습니다.
```

> **힌트** `mappedBy`는 대상 엔티티의 프로퍼티 이름에 대해 **IntelliSense 자동 완성**을 지원합니다. IDE에서 `mappedBy: ""`를 입력하면 Cat 엔티티의 프로퍼티 목록이 표시됩니다. `@ManyToMany`의 `mappedBy`와 `@OneToOne`의 `inverseSide`도 동일하게 적용됩니다.

### 생성되는 SELECT

이제 주인의 고양이들을 조회할 수 있습니다.

```typescript
const owner = await em.findOne(Owner, {
  where: { id: 1 },
  relations: ["cats"],
});

console.log(owner.cats); // [{ id: 1, name: "Whiskers" }, { id: 2, name: "Cheddar" }]
```

**생성되는 SQL (PostgreSQL):**

```sql
-- 1단계: 주인을 로드
SELECT * FROM "owner" WHERE "id" = 1;

-- 2단계: FK를 사용하여 관련 고양이를 로드
SELECT * FROM "cat" WHERE "owner_id" = 1;
```

ORM은 두 개의 별도 쿼리를 실행합니다: 하나는 주인, 하나는 고양이. 그런 다음 이를 `cats` 배열이 포함된 하나의 객체로 조합합니다.

> **힌트** `relations`를 지정하지 않으면 `cats`가 로드되지 않습니다. 필요할 때만 명시적으로 로드하여 불필요한 쿼리를 방지하세요.

## 즉시 로딩과 지연 로딩

### 로딩 전략이 중요한 이유

50마리의 고양이를 나열하는 페이지를 생각해봅시다. 각 고양이에 주인이 있고, 순회하면서 주인을 하나씩 로드한다면:

```sql
SELECT * FROM "cat";                          -- 1개 쿼리: 50마리 고양이 조회
SELECT * FROM "owner" WHERE "id" = 1;         -- 쿼리 #2
SELECT * FROM "owner" WHERE "id" = 2;         -- 쿼리 #3
...
SELECT * FROM "owner" WHERE "id" = 50;        -- 쿼리 #51
```

총 51개의 쿼리입니다. 이를 **N+1 문제**라고 합니다: N마리의 고양이를 가져오는 1개 쿼리 + 각 주인을 가져오는 N개 쿼리. 빠른 데이터베이스에서는 50ms가 걸리겠지만, 네트워크가 분리된 데이터베이스에서는 5초가 걸릴 수도 있습니다.

해결책은 관련 데이터를 더 적은 쿼리로 로드하는 것입니다. 미리 한꺼번에(eager) 또는 필요할 때(lazy) 로드할 수 있습니다.

매번 `relations: ["owner"]`를 작성하는 것이 번거롭다면, 두 가지 자동 로딩 방법이 있습니다.

### 즉시 로딩(Eager Loading) -- 항상 함께 조회 (1개 쿼리, JOIN 포함)

`eager: true`를 설정하면 `find()` 또는 `findOne()` 호출 시 자동으로 LEFT JOIN이 실행됩니다.

```typescript
// cat.entity.ts
@ManyToOne(() => Owner, (owner) => owner.cats, {
  joinColumn: "owner_id",
  eager: true,  // find() 시 owner가 자동으로 로드됩니다
})
owner!: Owner;
```

```typescript
const cat = await em.findOne(Cat, { where: { id: 1 } });
console.log(cat.owner.name); // "John" — relations 옵션 없이 로드됨
```

**생성되는 SQL (PostgreSQL):**

```sql
SELECT
  "cat"."id"       AS "cat_id",
  "cat"."name"     AS "cat_name",
  "cat"."owner_id" AS "cat_owner_id",
  "owner"."id"     AS "owner_id",
  "owner"."name"   AS "owner_name"
FROM "cat"
LEFT JOIN "owner" ON "cat"."owner_id" = "owner"."id"
WHERE "cat"."id" = 1;
```

모든 데이터를 한 번의 라운드트립으로 반환하는 단일 쿼리입니다. LEFT JOIN은 "주인이 없는 고양이도 포함하라"는 뜻입니다. 관련 데이터가 항상 필요할 때 유용합니다.

### 지연 로딩(Lazy Loading) -- 접근 시 조회 (별도 쿼리)

`lazy: true`를 설정하면 Proxy 기반의 지연 로딩을 사용합니다. 프로퍼티에 실제로 접근하는 시점에 DB 쿼리가 실행됩니다.

```typescript
// cat.entity.ts
@ManyToOne(() => Owner, (owner) => owner.cats, {
  joinColumn: "owner_id",
  lazy: true,  // 접근 시 쿼리 실행
})
owner!: Owner;
```

```typescript
const cat = await em.findOne(Cat, { where: { id: 1 } });
// 이 시점에서는 고양이 행만 로드됩니다. JOIN도 추가 쿼리도 없습니다.

const owner = await cat.owner; // 지금 SELECT가 실행됩니다
console.log(owner.name);
```

**생성되는 SQL (PostgreSQL):**

```sql
-- findOne(Cat) 시:
SELECT * FROM "cat" WHERE "id" = 1;

-- cat.owner 접근 시 (Proxy에 의해 트리거):
SELECT * FROM "owner" WHERE "id" = 3;
```

지연 로딩은 관계가 거의 접근되지 않을 때 유용합니다. 50마리의 고양이를 나열하면서 첫 번째 고양이의 주인만 표시한다면, 49개의 불필요한 쿼리를 피할 수 있습니다.

### N+1 트레이드오프

| 전략 | 50마리 고양이 + 주인에 대한 쿼리 수 | 적합한 경우 |
|------|--------------------------------------|-------------|
| 로딩 없음 | 1 (주인 없음) | 관계가 필요 없을 때 |
| `relations: ["owner"]` | 2 (고양이 + 주인) | 쿼리별 명시적 제어가 필요할 때 |
| `eager: true` | 1 (JOIN) | 관계가 항상 필요할 때 |
| `lazy: true` | 1 ~ 51 (접근에 따라 다름) | 관계가 거의 필요 없을 때 |

> **주의** `eager`와 `lazy`는 동시에 사용할 수 없습니다. 둘 다 설정된 경우 `eager`가 우선합니다.

> **힌트** Stingerloom에는 런타임에 N+1 패턴을 감지하고 경고를 로그에 남기는 **QueryTracker**가 포함되어 있습니다. 활성화 방법은 [EntityManager](./entity-manager.md) 문서를 참고하세요.

## @OneToOne -- "사용자의 프로필"

### One-to-One이 존재하는 이유

사용자 한 명, 프로필 하나. 모든 프로필 필드를 User 테이블에 직접 넣을 수도 있지만, 분리해야 하는 이유가 있습니다:

1. 프로필이 크다 (bio, 아바타 URL, 소셜 링크) 그리고 거의 로드되지 않는다
2. 접근 패턴이 다르다: 사용자 테이블은 매 요청마다 읽히지만, 프로필은 프로필 페이지에서만 읽힌다
3. 관심사의 분리: 사용자 인증 데이터 vs. 표시 데이터

One-to-One 관계는 한쪽("소유자" 측)에 FK를 생성하여 최대 하나의 관련 레코드를 보장합니다.

### 단방향 (소유자 측만)

```typescript
// profile.entity.ts
@Entity()
export class Profile {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "text" })
  bio!: string;
}
```

```typescript
// user.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, OneToOne } from "@stingerloom/orm";
import { Profile } from "./profile.entity";

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @OneToOne(() => Profile, { joinColumn: "profile_id", eager: true })
  profile!: Profile;
}
```

### 생성되는 DDL

**PostgreSQL:**

```sql
CREATE TABLE "profile" (
  "id" SERIAL PRIMARY KEY,
  "bio" TEXT NOT NULL
);

CREATE TABLE "user" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL,
  "profile_id" INTEGER
);

ALTER TABLE "user"
  ADD CONSTRAINT "fk_user_profile_id_c3d4e5f6"
  FOREIGN KEY ("profile_id") REFERENCES "profile" ("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
```

`profile_id` 컬럼이 user 테이블에 생성됩니다. `eager: true`이므로 User를 조회할 때 Profile이 함께 로드됩니다.

**즉시 로딩에 의해 생성되는 SQL (PostgreSQL):**

```sql
SELECT
  "user"."id"         AS "user_id",
  "user"."name"       AS "user_name",
  "user"."profile_id" AS "user_profile_id",
  "profile"."id"      AS "profile_id",
  "profile"."bio"     AS "profile_bio"
FROM "user"
LEFT JOIN "profile" ON "user"."profile_id" = "profile"."id"
WHERE "user"."id" = 1;
```

> **힌트** `@OneToOne`도 `@ManyToOne`과 동일하게 `@Column` 기반 FK 자동 감지를 지원합니다. `@Column({ name: "profile_fk" }) profileId: number`를 선언하면 `joinColumn`을 생략할 수 있습니다.

### 양방향

Profile에서 User도 참조하고 싶다면 `inverseSide`를 사용합니다.

```typescript
// user.entity.ts — 소유자 측 (FK가 있는 쪽)
@OneToOne(() => Profile, { joinColumn: "profile_id", inverseSide: "user" })
profile!: Profile;

// profile.entity.ts — 역방향 측
@OneToOne(() => User, { inverseSide: "profile" })
user!: User;
```

`@OneToMany`와 마찬가지로, 역방향 측은 추가 컬럼을 생성하지 않습니다. `profile_id` FK는 `user` 테이블에만 존재합니다.

```typescript
// 역방향에서 쿼리
const profile = await em.findOne(Profile, {
  where: { id: 1 },
  relations: ["user"],
});
console.log(profile.user.name); // "John"
```

**생성되는 SQL (PostgreSQL):**

```sql
SELECT
  "profile"."id"  AS "profile_id",
  "profile"."bio" AS "profile_bio",
  "user"."id"     AS "user_id",
  "user"."name"   AS "user_name"
FROM "profile"
LEFT JOIN "user" ON "user"."profile_id" = "profile"."id"
WHERE "profile"."id" = 1;
```

JOIN 방향이 반대가 된 것에 주목하세요: ORM이 `profile_id`가 일치하는 user 행을 찾아 profile에서 user로 조인합니다.

## @ManyToMany -- "글에 태그 달기"

### Many-to-Many에 조인 테이블이 필요한 이유

블로그 글에는 태그가 있고, 하나의 태그는 여러 글에 사용될 수 있습니다. 이것이 **Many-to-Many (N:M)** 관계입니다.

단일 FK 컬럼으로는 이를 표현할 수 없습니다. post 테이블에 `tag_id`를 추가하면 각 글에 태그가 하나만 가능합니다. tag 테이블에 `post_id`를 추가하면 각 태그가 하나의 글에만 붙을 수 있습니다. 둘 다 안 됩니다.

해결책은 **조인 테이블**(연결 테이블 또는 브릿지 테이블이라고도 함)입니다: 각 쪽을 가리키는 두 개의 FK 컬럼을 가진 세 번째 테이블입니다.

```
post (id, title)
  |
  +--- post_tags (post_id, tag_id) --- 조인 테이블
  |
tag (id, name)
```

`post_tags`의 각 행은 하나의 연결을 나타냅니다: "글 #1에 태그 #2가 있다."

### 동작 방식

```typescript
// post.entity.ts — 소유자 측
import { Entity, PrimaryGeneratedColumn, Column, ManyToMany } from "@stingerloom/orm";
import { Tag } from "./tag.entity";

@Entity()
export class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @ManyToMany(() => Tag, {
    joinTable: {
      name: "post_tags",           // 조인 테이블 이름
      joinColumn: "post_id",       // 현재 엔티티의 FK
      inverseJoinColumn: "tag_id", // 대상 엔티티의 FK
    },
  })
  tags!: Tag[];
}
```

```typescript
// tag.entity.ts — 역방향 측
import { Entity, PrimaryGeneratedColumn, Column, ManyToMany } from "@stingerloom/orm";
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

### 생성되는 DDL

`synchronize: true`를 사용하면 `post_tags` 조인 테이블이 자동으로 생성됩니다. 다음은 정확한 DDL입니다.

**PostgreSQL:**

```sql
CREATE TABLE "post" (
  "id" SERIAL PRIMARY KEY,
  "title" VARCHAR(255) NOT NULL
);

CREATE TABLE "tag" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL
);

-- 조인 테이블 (자동 생성)
CREATE TABLE "post_tags" (
  "post_id" INTEGER NOT NULL,
  "tag_id" INTEGER NOT NULL,
  PRIMARY KEY ("post_id", "tag_id")
);

ALTER TABLE "post_tags"
  ADD CONSTRAINT "fk_post_tags_post_id"
  FOREIGN KEY ("post_id") REFERENCES "post" ("id");

ALTER TABLE "post_tags"
  ADD CONSTRAINT "fk_post_tags_tag_id"
  FOREIGN KEY ("tag_id") REFERENCES "tag" ("id");
```

**MySQL:**

```sql
CREATE TABLE `post` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `title` VARCHAR(255) NOT NULL,
  PRIMARY KEY (`id`)
);

CREATE TABLE `tag` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255) NOT NULL,
  PRIMARY KEY (`id`)
);

CREATE TABLE `post_tags` (
  `post_id` INT NOT NULL,
  `tag_id` INT NOT NULL,
  PRIMARY KEY (`post_id`, `tag_id`)
);

ALTER TABLE `post_tags`
  ADD CONSTRAINT `fk_post_tags_post_id`
  FOREIGN KEY (`post_id`) REFERENCES `post` (`id`);

ALTER TABLE `post_tags`
  ADD CONSTRAINT `fk_post_tags_tag_id`
  FOREIGN KEY (`tag_id`) REFERENCES `tag` (`id`);
```

조인 테이블에 **복합 기본 키**(`post_id`, `tag_id`)가 있어서 동일한 post-tag 쌍이 중복될 수 없다는 점에 주목하세요.

### 생성되는 SELECT

```typescript
// 글을 태그와 함께 조회
const post = await em.findOne(Post, {
  where: { id: 1 },
  relations: ["tags"],
});
console.log(post.tags); // [{ id: 1, name: "TypeScript" }, { id: 2, name: "ORM" }]
```

**생성되는 SQL (PostgreSQL):**

```sql
-- 1단계: 글을 로드
SELECT * FROM "post" WHERE "id" = 1;

-- 2단계: 조인 테이블을 통해 태그를 로드
SELECT "tag".*
FROM "tag"
INNER JOIN "post_tags" ON "post_tags"."tag_id" = "tag"."id"
WHERE "post_tags"."post_id" = 1;
```

조인 테이블을 쿼리하여 글 #1에 속하는 태그 ID를 찾은 다음, 해당 태그들을 로드합니다.

### 조인 테이블 데이터 관리

조인 테이블의 항목을 추가하거나 제거하려면 `em.query()`로 SQL을 직접 실행합니다. 조인 테이블은 엔티티가 아니라 순수한 관계 브릿지입니다.

```typescript
// 글에 태그 추가
await em.query("INSERT INTO post_tags (post_id, tag_id) VALUES ($1, $2)", [1, 3]);

// 글에서 태그 제거
await em.query("DELETE FROM post_tags WHERE post_id = $1 AND tag_id = $2", [1, 3]);
```

> **힌트** `em.query()`에 대한 자세한 내용은 [EntityManager](./entity-manager.md) 문서를 참고하세요.

## Cascade -- 부모와 함께 저장/삭제

### Cascade가 존재하는 이유

Cascade가 없으면, 부모 엔티티와 자식을 저장할 때 여러 번의 명시적 호출이 필요합니다:

```typescript
// Cascade 없음: 각 자식을 개별적으로 저장해야 함
const owner = await em.save(Owner, { name: "John" });
await em.save(Cat, { name: "Whiskers", ownerId: owner.id });
await em.save(Cat, { name: "Cheddar", ownerId: owner.id });
await em.save(Cat, { name: "Luna", ownerId: owner.id });
```

이는 번거롭고 오류가 발생하기 쉽습니다 -- 자식을 저장하는 것을 잊을 수 있고, 부모 저장은 성공했지만 자식 저장이 실패할 수 있습니다 (데이터가 불일치 상태로 남게 됩니다).

Cascade를 사용하면, 부모를 저장할 때 ORM이 자동으로 자식을 저장합니다:

```typescript
// Cascade 사용: 자식이 자동으로 저장됨
const owner = await em.save(Owner, {
  name: "John",
  cats: [
    { name: "Whiskers" },
    { name: "Cheddar" },
    { name: "Luna" },
  ],
});
```

### 동작 방식

**Cascade**를 사용하면 부모 엔티티를 저장하거나 삭제할 때 자식 엔티티가 자동으로 처리됩니다.

```typescript
// owner.entity.ts
@OneToMany(() => Cat, { mappedBy: "owner", cascade: ["insert"] })
cats!: Cat[];
```

이 설정을 사용하면, Owner를 저장할 때 cats 배열의 새로운 Cat들이 자동으로 INSERT됩니다.

**생성되는 SQL (PostgreSQL):**

```sql
-- 1. 주인을 삽입
INSERT INTO "owner" ("name") VALUES ('John') RETURNING *;
-- 반환: { id: 1, name: 'John' }

-- 2. 주인의 FK와 함께 각 고양이를 자동 삽입
INSERT INTO "cat" ("name", "owner_id") VALUES ('Whiskers', 1) RETURNING *;
INSERT INTO "cat" ("name", "owner_id") VALUES ('Cheddar', 1) RETURNING *;
INSERT INTO "cat" ("name", "owner_id") VALUES ('Luna', 1) RETURNING *;
```

다음 cascade 옵션 중에서 선택할 수 있습니다.

| 옵션 | 동작 |
|------|------|
| `"insert"` | 부모 저장 시 자식을 INSERT |
| `"update"` | 부모 수정 시 자식을 UPDATE |
| `"delete"` | 부모 삭제 시 자식을 DELETE |
| `true` | 위 세 가지 모두 적용 |

배열로 조합할 수 있습니다.

```typescript
// insert와 delete만 cascade
@OneToMany(() => Cat, { mappedBy: "owner", cascade: ["insert", "delete"] })
cats!: Cat[];

// 모든 cascade 적용
@OneToMany(() => Comment, { mappedBy: "post", cascade: true })
comments!: Comment[];
```

### Cascade 없이 발생하는 일

`cascade: ["delete"]` 없이 자식이 있는 부모를 삭제하면, FK 제약 조건이 적용되어 있는 경우 실패합니다:

```sql
DELETE FROM "owner" WHERE "id" = 1;
-- ERROR: update or delete on table "owner" violates foreign key constraint
-- "fk_cat_owner_id_a1b2c3d4" on table "cat"
-- Detail: Key (id)=(1) is still referenced from table "cat".
```

자식을 먼저 삭제한 다음 부모를 삭제해야 합니다:

```sql
DELETE FROM "cat" WHERE "owner_id" = 1;    -- 먼저 자식 삭제
DELETE FROM "owner" WHERE "id" = 1;        -- 그 다음 부모 삭제
```

`cascade: ["delete"]`를 사용하면 ORM이 올바른 순서로 자동으로 처리합니다.

> **주의** `cascade: ["delete"]`는 강력한 기능입니다. 부모를 삭제하면 모든 자식이 삭제되므로, 의도치 않은 데이터 손실에 주의하세요. 이는 ORM 수준의 cascade(Stingerloom이 순서를 처리)로, FK 제약 조건의 데이터베이스 수준 `ON DELETE CASCADE`와는 다릅니다. 둘 다 유사한 결과를 얻지만, ORM cascade는 생명주기 훅과 이벤트 구독자도 트리거합니다.

## 관계 로딩 요약

관련 데이터를 조회하는 세 가지 방법을 요약합니다.

| 방법 | 설정 위치 | 동작 | 사용 시기 |
|------|----------|------|----------|
| `relations` 옵션 | `find()` 호출 시 | 지정한 관계만 JOIN | 필요할 때만 관계를 로드하고 싶을 때 |
| `eager: true` | 데코레이터 옵션 | 항상 자동 JOIN | 관계가 거의 항상 필요할 때 |
| `lazy: true` | 데코레이터 옵션 | 프로퍼티 접근 시 쿼리 | 관계가 거의 사용되지 않을 때 |

```typescript
// relations 옵션으로 여러 관계를 한 번에 로드
const user = await em.findOne(User, {
  where: { id: 1 },
  relations: ["profile", "posts"],
});
```

**생성되는 SQL (PostgreSQL):**

```sql
-- eager 관계(profile)는 메인 쿼리에서 JOIN됩니다
SELECT
  "user".*,
  "profile".*
FROM "user"
LEFT JOIN "profile" ON "user"."profile_id" = "profile"."id"
WHERE "user"."id" = 1;

-- OneToMany 관계(posts)는 별도 쿼리로 로드됩니다
SELECT * FROM "post" WHERE "author_id" = 1;
```

ManyToOne과 OneToOne 관계는 LEFT JOIN으로 로드됩니다 (단일 쿼리). OneToMany 관계는 별도 쿼리로 로드되는데, JOIN을 사용하면 부모 행이 곱해지기 때문입니다.

## 다음 단계

엔티티 간의 관계를 설정했으니, 이제 데이터를 조작하는 다양한 방법을 배울 차례입니다.

- [EntityManager](./entity-manager.md) -- find, save, delete, 집계, 페이지네이션
- [Query Builder](./query-builder.md) -- JOIN, GROUP BY 같은 복잡한 SQL이 필요할 때
- [Transactions](./transactions.md) -- 여러 작업을 하나로 묶어야 할 때
