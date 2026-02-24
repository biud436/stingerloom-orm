# 엔티티 정의 (Entities)

엔티티는 데이터베이스의 테이블과 매핑되는 클래스입니다. 데코레이터를 조합하여 컬럼, PK, 인덱스, 생명주기 훅, 유효성 검사 등을 선언적으로 정의합니다.

---

## @Entity

클래스를 ORM 엔티티로 등록합니다. 클래스명이 snake_case로 변환되어 테이블명으로 사용됩니다.

**시그니처**

```typescript
function Entity(options?: EntityOption): ClassDecorator

interface EntityOption {
  name?: string; // 테이블명 명시 (생략 시 클래스명 → snake_case 자동 변환)
}
```

**예제**

```typescript
import { Entity } from "stingerloom-orm";

// 테이블명: "user" (User → user)
@Entity()
export class User {}

// 테이블명 명시
@Entity({ name: "app_users" })
export class User {}
```

---

## @Column

일반 컬럼을 정의합니다. TypeScript의 `design:type` 메타데이터로부터 타입을 자동 추론합니다.

**시그니처**

```typescript
function Column(option?: ColumnOption): PropertyDecorator

interface ColumnOption {
  name?: string;           // 컬럼명 (생략 시 프로퍼티명 사용)
  type?: ColumnType;       // 컬럼 타입 (생략 시 design:type으로 자동 추론)
  length?: number;         // 컬럼 길이
  nullable?: boolean;      // NULL 허용 여부 (기본값: false)
  primary?: boolean;       // PK 여부
  autoIncrement?: boolean; // AUTO_INCREMENT 여부
  transform?: (raw: unknown) => any; // 값 변환 함수
  precision?: number;      // 소수점 정밀도
  scale?: number;          // 소수점 스케일
  enumValues?: string[];   // PostgreSQL ENUM 값 목록
  enumName?: string;       // PostgreSQL ENUM 타입 이름
}
```

**ColumnType 목록**

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

**TypeScript 타입 자동 추론**

| TypeScript 타입 | ColumnType | 기본 길이 | nullable |
|----------------|-----------|----------|----------|
| `String` | varchar | 255 | false |
| `Number` | int | 11 | false |
| `Boolean` | boolean | 1 | false |
| `Date` | datetime | 0 | false |
| `Buffer` | blob | 0 | true |
| 기타 | text | 0 | true |

**예제**

```typescript
import { Entity, Column, PrimaryGeneratedColumn } from "stingerloom-orm";

@Entity()
export class Product {
  @PrimaryGeneratedColumn()
  id!: number;

  // 기본: VARCHAR(255), NOT NULL
  @Column()
  name!: string;

  // 명시적 타입 및 길이
  @Column({ type: "varchar", length: 100 })
  sku!: string;

  // nullable 컬럼
  @Column({ nullable: true })
  description!: string | null;

  // 컬럼명 별칭
  @Column({ name: "unit_price", type: "float" })
  price!: number;

  // JSON 컬럼
  @Column({ type: "json", nullable: true })
  metadata!: Record<string, unknown> | null;

  // 값 변환
  @Column({ transform: (raw) => raw === 1 })
  isActive!: boolean;

  // PostgreSQL ENUM
  @Column({ type: "enum", enumValues: ["draft", "published", "archived"] })
  status!: string;
}
```

---

## @PrimaryGeneratedColumn

자동 증가(AUTO_INCREMENT) 기본키를 정의합니다.

**시그니처**

```typescript
function PrimaryGeneratedColumn(option?: ColumnOption): PropertyDecorator
```

내부적으로 `@Column({ primary: true, autoIncrement: true, type: "int", length: 11, nullable: false })`와 동일합니다.

**예제**

```typescript
import { Entity, PrimaryGeneratedColumn } from "stingerloom-orm";

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;
}
```

---

## @PrimaryColumn

수동으로 값을 지정하는 기본키 컬럼을 정의합니다.

**시그니처**

```typescript
function PrimaryColumn(option?: ColumnOption): PropertyDecorator
```

**예제**

```typescript
import { Entity, PrimaryColumn, Column } from "stingerloom-orm";

@Entity()
export class Config {
  @PrimaryColumn({ type: "varchar", length: 64 })
  key!: string;

  @Column()
  value!: string;
}
```

---

## @Index

컬럼에 데이터베이스 인덱스를 생성합니다.

**시그니처**

```typescript
function Index(): PropertyDecorator
```

**예제**

```typescript
import { Entity, Column, PrimaryGeneratedColumn, Index } from "stingerloom-orm";

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index()
  @Column()
  email!: string;
}
```

인덱스명은 `INDEX_{테이블명}_{컬럼명}` 형식으로 자동 생성됩니다.

---

## @UniqueIndex

복합 유니크 인덱스를 클래스 레벨에 선언합니다. 여러 컬럼의 조합이 유일해야 하는 경우에 사용합니다.

**시그니처**

```typescript
function UniqueIndex(columns: string[], options?: { name?: string }): ClassDecorator
```

**예제**

```typescript
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  UniqueIndex,
} from "stingerloom-orm";

// email + tenantId 조합이 유일해야 함
@UniqueIndex(["email", "tenantId"])
@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  email!: string;

  @Column()
  tenantId!: string;
}

// 인덱스 이름 명시
@UniqueIndex(["categoryId", "slug"], { name: "uq_post_category_slug" })
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

`synchronize: true` 설정 시 `UNIQUE INDEX` DDL이 자동으로 생성됩니다.

---

## @Version

낙관적 잠금(Optimistic Locking)을 위한 버전 컬럼을 설정합니다. 동시 수정 시 충돌 감지에 사용합니다.

**시그니처**

```typescript
function Version(): PropertyDecorator
```

**예제**

```typescript
import { Entity, Column, PrimaryGeneratedColumn, Version } from "stingerloom-orm";

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

---

## @DeletedAt

Soft Delete를 위한 삭제 시각 컬럼을 설정합니다. 이 데코레이터가 붙은 엔티티는 `delete()` 대신 `softDelete()`를 사용하면 행을 실제로 삭제하지 않고 `deleted_at` 타임스탬프를 기록합니다.

`find()` / `findOne()`은 자동으로 `WHERE deleted_at IS NULL` 조건을 추가합니다.

**시그니처**

```typescript
function DeletedAt(): PropertyDecorator
```

내부적으로 `@Column({ type: "datetime", nullable: true })`와 동일합니다.

**예제**

```typescript
import { Entity, Column, PrimaryGeneratedColumn, DeletedAt } from "stingerloom-orm";

@Entity()
export class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @DeletedAt()
  deletedAt!: Date | null;
}

// 사용
await em.softDelete(Post, { id: 1 });   // deleted_at = NOW()
await em.restore(Post, { id: 1 });      // deleted_at = NULL
await em.find(Post);                    // WHERE deleted_at IS NULL (자동)
await em.find(Post, { withDeleted: true }); // soft-deleted 포함
```

---

## 생명주기 훅 (Lifecycle Hooks)

엔티티 저장/수정/삭제 전후에 자동으로 호출되는 메서드를 선언합니다.

| 데코레이터 | 실행 시점 |
|-----------|---------|
| `@BeforeInsert` | INSERT 직전 (PK 없는 신규 저장 시) |
| `@AfterInsert` | INSERT 완료 후 |
| `@BeforeUpdate` | UPDATE 직전 (PK 있는 기존 저장 시) |
| `@AfterUpdate` | UPDATE 완료 후 |
| `@BeforeDelete` | DELETE 직전 |
| `@AfterDelete` | DELETE 완료 후 |

**시그니처**

```typescript
function BeforeInsert(): MethodDecorator
function AfterInsert(): MethodDecorator
function BeforeUpdate(): MethodDecorator
function AfterUpdate(): MethodDecorator
function BeforeDelete(): MethodDecorator
function AfterDelete(): MethodDecorator
```

**예제**

```typescript
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  BeforeInsert,
  AfterInsert,
  BeforeUpdate,
  AfterUpdate,
  BeforeDelete,
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
  setCreatedAt() {
    this.createdAt = new Date();
    this.updatedAt = new Date();
  }

  @BeforeUpdate()
  setUpdatedAt() {
    this.updatedAt = new Date();
  }

  @AfterInsert()
  logInsert() {
    console.log(`Article #${this.id} inserted`);
  }

  @AfterUpdate()
  logUpdate() {
    console.log(`Article #${this.id} updated`);
  }

  @BeforeDelete()
  onBeforeDelete() {
    console.log(`Article #${this.id} is about to be deleted`);
  }
}
```

---

## 유효성 검사 데코레이터

`save()` 호출 시 자동으로 실행되는 필드 단위 유효성 검사를 선언합니다. 검사 실패 시 `ValidationError`가 throw됩니다.

### @NotNull

해당 필드가 `null` 또는 `undefined`이면 오류를 발생시킵니다.

```typescript
function NotNull(): PropertyDecorator
```

### @MinLength(min: number)

문자열 필드의 최소 길이를 검사합니다.

```typescript
function MinLength(min: number): PropertyDecorator
```

### @MaxLength(max: number)

문자열 필드의 최대 길이를 검사합니다.

```typescript
function MaxLength(max: number): PropertyDecorator
```

### @Min(min: number)

숫자 필드의 최솟값을 검사합니다.

```typescript
function Min(min: number): PropertyDecorator
```

### @Max(max: number)

숫자 필드의 최댓값을 검사합니다.

```typescript
function Max(max: number): PropertyDecorator
```

**예제**

```typescript
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  NotNull,
  MinLength,
  MaxLength,
  Min,
  Max,
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

  @NotNull()
  @MinLength(5)
  @MaxLength(100)
  @Column()
  email!: string;

  @Min(0)
  @Max(150)
  @Column()
  age!: number;
}

// 유효하지 않은 데이터 저장 시 ValidationError 발생
await em.save(Member, { name: "A", email: "x", age: -1 });
// Error: name must be at least 2 characters long
```

---

## 완전한 엔티티 예제

```typescript
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  Version,
  DeletedAt,
  BeforeInsert,
  BeforeUpdate,
  AfterInsert,
  NotNull,
  MinLength,
  MaxLength,
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
  @Column({ unique: true })
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
    this.version = 1;
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
