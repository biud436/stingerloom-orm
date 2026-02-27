# 엔티티 정의 (Entities)

**엔티티(Entity)**는 데이터베이스 테이블을 TypeScript 클래스로 표현한 것입니다. 하나의 엔티티 클래스가 하나의 테이블에 대응되며, 클래스의 프로퍼티가 테이블의 컬럼이 됩니다.

이 문서에서는 가장 간단한 엔티티부터 시작하여, 실무에서 필요한 기능을 하나씩 추가해가며 엔티티 정의 방법을 안내합니다.

## 첫 번째 엔티티 만들기

데이터베이스에 사용자 정보를 저장한다고 가정해보겠습니다. 가장 간단한 엔티티는 이렇게 생겼습니다.

```typescript
// user.entity.ts
import { Entity, PrimaryGeneratedColumn, Column } from "stingerloom-orm";

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;
}
```

이 코드만으로 Stingerloom은 `user` 테이블을 생성하고, `id`(자동 증가 기본키)와 `name`(VARCHAR(255)) 컬럼을 만들어줍니다.

세 가지 데코레이터가 각각 하는 일을 살펴보겠습니다.

**`@Entity()`** 는 이 클래스가 ORM 엔티티임을 선언합니다. 클래스명 `User`는 자동으로 snake_case로 변환되어 테이블명 `user`가 됩니다. 테이블명을 직접 지정하고 싶다면 옵션을 전달합니다.

```typescript
// user.entity.ts
@Entity({ name: "app_users" })
export class User { /* 테이블명: app_users */ }
```

**`@PrimaryGeneratedColumn()`** 은 자동 증가(AUTO_INCREMENT) 기본키를 정의합니다. INSERT할 때 값을 넣지 않아도 DB가 자동으로 1, 2, 3... 순서대로 채워줍니다.

**`@Column()`** 은 일반 컬럼을 정의합니다. TypeScript 타입을 읽어서 적절한 DB 타입을 자동 추론합니다 — `string`이면 `VARCHAR(255)`, `number`이면 `INT`가 됩니다.

> **Hint** `!:` 문법(definite assignment assertion)은 TypeScript에게 "이 프로퍼티는 ORM이 관리하므로 초기화하지 않아도 괜찮다"고 알려주는 것입니다.

## 다양한 컬럼 타입 사용하기

실무에서는 문자열과 숫자 외에도 다양한 타입이 필요합니다. `@Column()`의 `type` 옵션으로 원하는 컬럼 타입을 명시할 수 있습니다.

```typescript
// product.entity.ts
@Entity()
export class Product {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;                    // VARCHAR(255) 자동 추론

  @Column({ type: "text" })
  description!: string;             // TEXT (긴 문자열)

  @Column({ type: "float" })
  price!: number;                   // FLOAT

  @Column({ type: "boolean" })
  isAvailable!: boolean;            // TINYINT(1) / BOOLEAN

  @Column({ type: "datetime" })
  releaseDate!: Date;               // DATETIME / TIMESTAMP
}
```

`type`을 생략하면 TypeScript 타입에서 자동 추론됩니다. 하지만 같은 `string`이라도 짧은 이름(`varchar`)과 긴 본문(`text`)은 다르기 때문에, 용도에 맞게 명시하는 것이 좋습니다.

> **Hint** Stingerloom의 컬럼 타입은 DB에 독립적입니다. 예를 들어 `"boolean"`은 MySQL에서 `TINYINT(1)`, PostgreSQL에서 `BOOLEAN`으로 자동 변환됩니다. 전체 매핑표는 이 문서 하단의 [ColumnType 레퍼런스](#columntype-레퍼런스)를 참고하세요.

## 컬럼 옵션 설정하기

`@Column()`에는 컬럼의 세부 동작을 제어하는 옵션을 전달할 수 있습니다.

### 길이 지정

문자열 컬럼의 최대 길이를 지정합니다. 생략하면 `varchar`의 기본 길이는 255입니다.

```typescript
@Column({ type: "varchar", length: 100 })
sku!: string;
```

### NULL 허용

기본적으로 모든 컬럼은 NOT NULL입니다. 값이 없을 수 있는 컬럼은 `nullable: true`로 설정합니다.

```typescript
@Column({ nullable: true })
bio!: string | null;
```

TypeScript 타입도 `| null`을 추가해두면 코드에서 null 체크를 자연스럽게 할 수 있습니다.

### 컬럼명 별칭

프로퍼티명과 실제 DB 컬럼명을 다르게 하고 싶을 때 `name` 옵션을 사용합니다.

```typescript
@Column({ name: "unit_price", type: "float" })
price!: number;
// TypeScript: product.price / DB: unit_price
```

### JSON 컬럼

구조화된 데이터를 하나의 컬럼에 저장할 때 JSON 타입을 사용합니다.

```typescript
@Column({ type: "json", nullable: true })
settings!: Record<string, unknown> | null;
```

### 값 변환 (transform)

DB에서 읽어온 값을 TypeScript 객체로 매핑할 때 변환 함수를 적용할 수 있습니다. MySQL의 `TINYINT(1)`처럼 boolean이 숫자로 저장되는 경우에 유용합니다.

```typescript
@Column({ transform: (raw) => raw === 1 })
isActive!: boolean;
```

### PostgreSQL ENUM

PostgreSQL에서 사용자 정의 ENUM 타입을 사용할 수 있습니다.

```typescript
@Column({
  type: "enum",
  enumValues: ["draft", "published", "archived"],
  enumName: "post_status",
})
status!: string;
```

> **Hint** `enumName`을 생략하면 `{테이블명}_{컬럼명}_enum` 형식으로 자동 생성됩니다.

## 수동 기본키 (@PrimaryColumn)

자동 증가가 아니라 직접 값을 지정하는 기본키가 필요할 때가 있습니다. 예를 들어 설정 테이블처럼 키-값 구조인 경우입니다.

```typescript
// config.entity.ts
import { Entity, PrimaryColumn, Column } from "stingerloom-orm";

@Entity()
export class Config {
  @PrimaryColumn({ type: "varchar", length: 64 })
  key!: string;

  @Column({ type: "text" })
  value!: string;
}
```

`@PrimaryColumn()`은 AUTO_INCREMENT가 적용되지 않으므로, `save()` 할 때 반드시 키 값을 직접 넣어야 합니다.

## 인덱스로 조회 성능 높이기

자주 검색하는 컬럼에는 **인덱스(Index)**를 추가하면 조회 속도가 크게 향상됩니다. 이메일로 사용자를 검색하는 경우를 생각해보겠습니다.

```typescript
// user.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, Index } from "stingerloom-orm";

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index()
  @Column()
  email!: string;
}
```

`@Index()`를 붙이면 `INDEX_user_email` 형식의 인덱스가 자동 생성됩니다. WHERE 조건에 `email`을 자주 사용한다면 꼭 추가하세요.

### 복합 유니크 인덱스 (@UniqueIndex)

여러 컬럼의 **조합**이 고유해야 하는 경우가 있습니다. 예를 들어, 같은 카테고리 안에서 slug가 유일하면 되는 경우입니다.

```typescript
// post.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, UniqueIndex } from "stingerloom-orm";

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

이렇게 하면 `(categoryId, slug)` 조합에 대한 UNIQUE INDEX가 생성됩니다. 인덱스 이름을 직접 지정할 수도 있습니다.

```typescript
@UniqueIndex(["categoryId", "slug"], { name: "uq_post_category_slug" })
```

> **Hint** `@UniqueIndex`는 **클래스 레벨** 데코레이터입니다. `@Index()`는 프로퍼티에, `@UniqueIndex()`는 클래스에 붙인다는 점을 기억하세요.

## 낙관적 잠금 (@Version)

여러 사용자가 동시에 같은 데이터를 수정하면 충돌이 발생할 수 있습니다. `@Version()` 데코레이터를 사용하면 UPDATE 시 `WHERE version = 현재버전`이 자동으로 추가되고, 동시에 `version = 현재버전 + 1`로 갱신됩니다. 다른 사용자가 먼저 수정했다면 버전이 달라져서 UPDATE가 실패합니다.

```typescript
// order.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, Version } from "stingerloom-orm";

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

> **Hint** 낙관적 잠금은 충돌이 드물지만 데이터 무결성이 중요한 경우(주문 상태 변경, 재고 관리 등)에 적합합니다.

## Soft Delete (@DeletedAt)

데이터를 실제로 삭제하지 않고, "삭제됨" 표시만 남기고 싶을 때가 있습니다. 게시글을 휴지통에 넣는 것처럼요.

```typescript
// post.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, DeletedAt } from "stingerloom-orm";

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

`@DeletedAt()` 데코레이터를 추가하면 세 가지가 달라집니다.

첫째, `em.softDelete(Post, { id: 1 })`을 호출하면 행을 삭제하는 대신 `deleted_at`에 현재 시각을 기록합니다.

둘째, `em.find(Post)`는 자동으로 `WHERE deleted_at IS NULL`을 추가하여 삭제된 데이터를 제외합니다.

셋째, 삭제된 데이터를 포함하여 조회하려면 `{ withDeleted: true }` 옵션을 사용합니다.

```typescript
await em.softDelete(Post, { id: 1 });                      // soft delete
const posts = await em.find(Post);                         // 삭제된 것 제외
const all = await em.find(Post, { withDeleted: true });    // 삭제된 것 포함
await em.restore(Post, { id: 1 });                         // 복원
```

## 생명주기 훅 (Lifecycle Hooks)

엔티티가 저장되거나 수정, 삭제될 때 **자동으로 실행되는 코드**를 정의할 수 있습니다. 가장 흔한 사용 사례는 `createdAt`과 `updatedAt`을 자동으로 설정하는 것입니다.

```typescript
// article.entity.ts
import {
  Entity, PrimaryGeneratedColumn, Column,
  BeforeInsert, BeforeUpdate,
} from "stingerloom-orm";

@Entity()
export class Article {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @Column({ type: "datetime", nullable: true })
  createdAt!: Date;

  @Column({ type: "datetime", nullable: true })
  updatedAt!: Date;

  @BeforeInsert()
  setTimestamps() {
    const now = new Date();
    this.createdAt = now;
    this.updatedAt = now;
  }

  @BeforeUpdate()
  updateTimestamp() {
    this.updatedAt = new Date();
  }
}
```

`@BeforeInsert()`가 붙은 메서드는 INSERT 직전에, `@BeforeUpdate()`는 UPDATE 직전에 자동 호출됩니다.

사용 가능한 생명주기 훅은 총 6가지입니다.

| 데코레이터 | 실행 시점 | 언제 쓰나요? |
|-----------|---------|------------|
| `@BeforeInsert()` | INSERT 직전 | 기본값 설정, 타임스탬프 |
| `@AfterInsert()` | INSERT 완료 후 | 로깅, 알림 발송 |
| `@BeforeUpdate()` | UPDATE 직전 | updatedAt 갱신 |
| `@AfterUpdate()` | UPDATE 완료 후 | 변경 이력 기록 |
| `@BeforeDelete()` | DELETE 직전 | 삭제 전 정리 작업 |
| `@AfterDelete()` | DELETE 완료 후 | 연관 리소스 정리, 로깅 |

> **Hint** "After" 훅에서는 이미 DB 작업이 완료된 상태이므로, 데이터를 변경해도 DB에 반영되지 않습니다. 로깅이나 외부 알림 같은 부수 효과에 사용하세요.

## 유효성 검사 (Validation)

`save()` 호출 시 데이터가 올바른지 자동으로 검증하고 싶을 때 유효성 검사 데코레이터를 사용합니다. 검사에 실패하면 `ValidationError`가 발생하여 잘못된 데이터가 DB에 들어가는 것을 방지합니다.

```typescript
// member.entity.ts
import {
  Entity, PrimaryGeneratedColumn, Column,
  NotNull, MinLength, MaxLength, Min, Max,
} from "stingerloom-orm";

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

- **`@NotNull()`** — `null`이나 `undefined`이면 오류
- **`@MinLength(n)` / `@MaxLength(n)`** — 문자열 길이 검증
- **`@Min(n)` / `@Max(n)`** — 숫자 범위 검증

유효하지 않은 데이터로 `save()`를 호출하면 DB 쿼리 실행 전에 오류가 발생합니다.

```typescript
await em.save(Member, { name: "A", age: -1 });
// ValidationError: name must be at least 2 characters long
```

## 완전한 실무 예제

지금까지 배운 모든 기능을 조합한 블로그 사용자 엔티티입니다.

```typescript
// user.entity.ts
import {
  Entity, PrimaryGeneratedColumn, Column, Index, Version,
  DeletedAt, BeforeInsert, BeforeUpdate, AfterInsert,
  NotNull, MinLength, MaxLength,
} from "stingerloom-orm";

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

  @Column({ type: "datetime", nullable: true })
  createdAt!: Date;

  @Column({ type: "datetime", nullable: true })
  updatedAt!: Date;

  @BeforeInsert()
  init() {
    const now = new Date();
    this.createdAt = now;
    this.updatedAt = now;
    this.isActive = true;
  }

  @BeforeUpdate()
  touch() {
    this.updatedAt = new Date();
  }

  @AfterInsert()
  log() {
    console.log(`User #${this.id} created`);
  }
}
```

이 하나의 엔티티에 자동 증가 PK, 유효성 검사, 인덱스, JSON 컬럼, 낙관적 잠금, Soft Delete, 자동 타임스탬프, 로깅이 모두 포함되어 있습니다.

## ColumnType 레퍼런스

### TypeScript 타입 자동 추론

`@Column()`에서 `type`을 생략하면 TypeScript 타입에서 자동 추론됩니다.

| TypeScript 타입 | ColumnType | 기본 길이 | nullable |
|----------------|-----------|----------|----------|
| `String` | varchar | 255 | false |
| `Number` | int | 11 | false |
| `Boolean` | boolean | 1 | false |
| `Date` | datetime | 0 | false |
| `Buffer` | blob | 0 | true |
| 기타 | text | 0 | true |

### ColumnType별 DB 매핑

| ColumnType | MySQL/MariaDB | PostgreSQL | SQLite |
|-----------|--------------|-----------|--------|
| `varchar` | VARCHAR(n) | VARCHAR(n) | TEXT |
| `int` / `number` | INT | INTEGER | INTEGER |
| `float` | FLOAT | REAL | REAL |
| `double` | DOUBLE | DOUBLE PRECISION | REAL |
| `bigint` | BIGINT | BIGINT | INTEGER |
| `boolean` | TINYINT(1) | BOOLEAN | INTEGER |
| `datetime` | DATETIME | TIMESTAMP | TEXT |
| `timestamp` | TIMESTAMP | TIMESTAMP | TEXT |
| `date` | DATE | DATE | TEXT |
| `text` | TEXT | TEXT | TEXT |
| `longtext` | LONGTEXT | TEXT | TEXT |
| `blob` | BLOB | BYTEA | BLOB |
| `json` | JSON | JSON | TEXT |
| `jsonb` | JSON | JSONB | TEXT |
| `enum` | ENUM | (사용자 정의 ENUM) | TEXT |

### @Column 전체 옵션

| 옵션 | 타입 | 설명 |
|------|------|------|
| `name` | `string` | DB 컬럼명 (생략 시 프로퍼티명) |
| `type` | `ColumnType` | 컬럼 타입 (생략 시 자동 추론) |
| `length` | `number` | 컬럼 길이 |
| `nullable` | `boolean` | NULL 허용 (기본값: false) |
| `primary` | `boolean` | 기본키 여부 |
| `autoIncrement` | `boolean` | AUTO_INCREMENT 여부 |
| `transform` | `(raw) => any` | DB 읽기 시 값 변환 함수 |
| `precision` | `number` | 소수점 정밀도 |
| `scale` | `number` | 소수점 스케일 |
| `enumValues` | `string[]` | PostgreSQL ENUM 값 목록 |
| `enumName` | `string` | PostgreSQL ENUM 타입 이름 |

## 다음 단계

엔티티를 정의했다면, 이제 엔티티 간의 관계를 설정할 차례입니다.

- [관계 설정하기](./relations.md) — `@ManyToOne`, `@OneToMany` 등으로 테이블 간 관계 정의
- [EntityManager 사용하기](./entity-manager.md) — 정의한 엔티티로 CRUD 수행하기
- [트랜잭션](./transactions.md) — 여러 작업을 하나의 단위로 묶기
- [마이그레이션](./migrations.md) — 스키마 변경을 안전하게 관리하기
