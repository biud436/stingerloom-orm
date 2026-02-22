# 관계 데코레이터 (Relations)

두 엔티티 간의 관계를 선언합니다. ORM이 자동으로 외래키를 생성하고 JOIN 쿼리를 처리합니다.

---

## @ManyToOne

다대일(N:1) 관계의 소유측(FK를 보유한 쪽)에 선언합니다.

**시그니처**

```typescript
function ManyToOne<T extends EntityLike>(
  getMappingEntity: () => T,
  getMappingProperty: (entity: InstanceType<T>) => void,
  option?: ManyToOneOption,
): PropertyDecorator

interface ManyToOneOption {
  joinColumn?: string;  // FK 컬럼명 (생략 시 프로퍼티명 사용)
  eager?: boolean;      // true: 자동 LEFT JOIN
  lazy?: boolean;       // true: Proxy 기반 지연 로딩 (eager와 함께 사용 불가)
  cascade?: CascadeOption; // "insert" | "update" | "delete" | true | []
  transform?: (raw: unknown) => any;
}
```

**예제**

```typescript
import { Entity, Column, PrimaryGeneratedColumn, ManyToOne } from "stingerloom-orm";
import { Owner } from "./owner.entity";

@Entity()
export class Cat {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  // eager: true → find() 시 LEFT JOIN으로 owner를 자동 로드
  @ManyToOne(() => Owner, (owner) => owner.cats, {
    joinColumn: "owner_id",
    eager: true,
  })
  owner!: Owner;
}
```

`synchronize: true`이면 `owner_id` FK 컬럼과 외래키 제약이 자동 생성됩니다.

---

## @OneToMany

일대다(1:N) 관계의 역방향(비소유) 엔티티에 선언합니다. `mappedBy`는 소유측(`@ManyToOne` 측)의 프로퍼티명을 가리킵니다.

**시그니처**

```typescript
function OneToMany<T>(
  getRelatedEntity: () => ClazzType<T>,
  option: OneToManyOption,
): PropertyDecorator

interface OneToManyOption {
  mappedBy: string;        // ManyToOne 측 프로퍼티명
  cascade?: CascadeOption; // "insert" | "update" | "delete" | true | []
}
```

**예제**

```typescript
import { Entity, Column, PrimaryGeneratedColumn, OneToMany } from "stingerloom-orm";
import { Cat } from "./cat.entity";

@Entity()
export class Owner {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  // mappedBy: Cat 엔티티의 "owner" 프로퍼티가 소유자(FK 보유 측)
  @OneToMany(() => Cat, { mappedBy: "owner" })
  cats!: Cat[];
}
```

---

## @ManyToOne + @OneToMany 양방향 예제

```typescript
// owner.entity.ts
import { Entity, Column, PrimaryGeneratedColumn, OneToMany } from "stingerloom-orm";
import { Cat } from "./cat.entity";

@Entity()
export class Owner {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @OneToMany(() => Cat, { mappedBy: "owner", cascade: ["insert"] })
  cats!: Cat[];
}

// cat.entity.ts
import { Entity, Column, PrimaryGeneratedColumn, ManyToOne } from "stingerloom-orm";
import { Owner } from "./owner.entity";

@Entity()
export class Cat {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @ManyToOne(() => Owner, (owner) => owner.cats, {
    joinColumn: "owner_id",
    eager: true,
  })
  owner!: Owner;
}
```

**relations 옵션으로 명시적 로딩**

```typescript
// OneToMany 측에서 cats를 명시적으로 로드
const owner = await em.findOne(Owner, {
  where: { id: 1 },
  relations: ["cats"],
});
console.log(owner.cats); // Cat[]
```

---

## @OneToOne

일대일(1:1) 관계를 정의합니다. FK를 보유한 소유측에는 `joinColumn`을, 역방향에는 `inverseSide`를 설정합니다.

**시그니처**

```typescript
function OneToOne<T>(
  getRelatedEntity: () => ClazzType<T>,
  option?: OneToOneOption,
): PropertyDecorator

interface OneToOneOption {
  joinColumn?: string;   // FK 컬럼명 (소유측에서 설정)
  inverseSide?: string;  // 역방향 프로퍼티명
  eager?: boolean;       // true: 자동 LEFT JOIN (소유측만 가능)
  cascade?: CascadeOption;
}
```

**단방향 예제 (소유측만 선언)**

```typescript
// user.entity.ts
import { Entity, Column, PrimaryGeneratedColumn, OneToOne } from "stingerloom-orm";
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

// profile.entity.ts
import { Entity, Column, PrimaryGeneratedColumn } from "stingerloom-orm";

@Entity()
export class Profile {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  bio!: string;
}
```

**양방향 예제**

```typescript
// user.entity.ts — 소유측
@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @OneToOne(() => Profile, { joinColumn: "profile_id", inverseSide: "user" })
  profile!: Profile;
}

// profile.entity.ts — 역방향
@Entity()
export class Profile {
  @PrimaryGeneratedColumn()
  id!: number;

  @OneToOne(() => User, { inverseSide: "profile" })
  user!: User;
}

// 역방향에서 relations로 로드
const profile = await em.findOne(Profile, {
  where: { id: 1 },
  relations: ["user"],
});
```

---

## @ManyToMany

다대다(N:M) 관계를 정의합니다. 중간 조인 테이블을 통해 연결됩니다. 소유측에는 `joinTable`을, 역방향에는 `mappedBy`를 설정합니다.

**시그니처**

```typescript
function ManyToMany<T>(
  getRelatedEntity: () => ClazzType<T>,
  option?: ManyToManyOption,
): PropertyDecorator

interface ManyToManyOption {
  joinTable?: JoinTableOption; // 소유측에서 설정
  mappedBy?: string;           // 역방향에서 설정
}

interface JoinTableOption {
  name: string;              // 중간 테이블명
  joinColumn: string;        // 현재 엔티티 FK
  inverseJoinColumn: string; // 대상 엔티티 FK
}
```

**예제**

```typescript
// post.entity.ts — 소유측
import { Entity, Column, PrimaryGeneratedColumn, ManyToMany } from "stingerloom-orm";
import { Tag } from "./tag.entity";

@Entity()
export class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @ManyToMany(() => Tag, {
    joinTable: {
      name: "post_tags",
      joinColumn: "post_id",
      inverseJoinColumn: "tag_id",
    },
  })
  tags!: Tag[];
}

// tag.entity.ts — 역방향
import { Entity, Column, PrimaryGeneratedColumn, ManyToMany } from "stingerloom-orm";
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

**relations 옵션으로 로드**

```typescript
const post = await em.findOne(Post, {
  where: { id: 1 },
  relations: ["tags"],
});
console.log(post.tags); // Tag[]
```

---

## Eager 로딩

`eager: true` 옵션을 설정하면 `find()` / `findOne()` 호출 시 자동으로 LEFT JOIN을 수행하여 관계 엔티티를 함께 로드합니다.

- `@ManyToOne`과 `@OneToOne`(소유측)에서 지원됩니다.
- 별도의 `relations` 옵션 없이 자동 로드됩니다.

```typescript
@ManyToOne(() => Owner, (owner) => owner.cats, {
  joinColumn: "owner_id",
  eager: true, // find() 시 LEFT JOIN으로 owner 자동 로드
})
owner!: Owner;
```

---

## Lazy 로딩

`lazy: true` 옵션을 설정하면 Proxy 기반 지연 로딩을 사용합니다. 프로퍼티에 처음 접근할 때 별도 DB 쿼리가 실행됩니다.

- `@ManyToOne`에서 지원됩니다.
- `eager`와 동시에 사용할 수 없습니다. `eager`가 우선됩니다.

```typescript
@ManyToOne(() => Owner, (owner) => owner.cats, {
  joinColumn: "owner_id",
  lazy: true, // 첫 접근 시 별도 쿼리로 로드
})
owner!: Owner;

// 사용
const cat = await em.findOne(Cat, { where: { id: 1 } });
const owner = await cat.owner; // 이 시점에 DB 쿼리 실행
```

---

## Cascade

부모 엔티티 저장/삭제 시 자식 엔티티를 자동으로 처리합니다.

**CascadeType**

| 값 | 설명 |
|----|------|
| `"insert"` | 부모 저장 시 자식 엔티티도 INSERT |
| `"update"` | 부모 수정 시 자식 엔티티도 UPDATE |
| `"delete"` | 부모 삭제 시 자식 엔티티도 DELETE |
| `"remove"` | `"delete"`의 별칭 |
| `true` | 모든 cascade 적용 |

```typescript
// 부모 삭제 시 자식도 자동 삭제
@OneToMany(() => Post, { mappedBy: "author", cascade: ["delete"] })
posts!: Post[];

// ManyToOne에서 부모 엔티티 중첩 저장
@ManyToOne(() => Owner, (owner) => owner.cats, {
  joinColumn: "owner_id",
  cascade: ["insert"], // owner가 없으면 자동 INSERT
})
owner!: Owner;

// 모든 cascade 허용
@OneToMany(() => Comment, { mappedBy: "post", cascade: true })
comments!: Comment[];
```

---

## relations 옵션으로 명시적 로딩

`find()` / `findOne()` 호출 시 `relations` 배열에 로드할 프로퍼티명을 지정합니다.

```typescript
// OneToMany 로드
const owner = await em.findOne(Owner, {
  where: { id: 1 },
  relations: ["cats"],
});

// ManyToMany 로드
const post = await em.findOne(Post, {
  where: { id: 1 },
  relations: ["tags"],
});

// 여러 관계 동시 로드
const user = await em.findOne(User, {
  where: { id: 1 },
  relations: ["profile", "posts"],
});
```
