# 관계 설정 (Relations)

**관계(Relation)**는 두 엔티티 사이의 연결을 의미합니다. "블로그 글은 작성자가 있다", "주인은 여러 마리의 고양이를 키운다"처럼 현실 세계의 관계를 데이터베이스에 반영하는 것이죠.

Stingerloom ORM은 네 가지 관계를 지원합니다.

| 관계 | 예시 | 데코레이터 |
|------|------|-----------|
| 다대일 (N:1) | 고양이 → 주인 | `@ManyToOne` |
| 일대다 (1:N) | 주인 → 고양이들 | `@OneToMany` |
| 일대일 (1:1) | 사용자 → 프로필 | `@OneToOne` |
| 다대다 (N:M) | 글 ↔ 태그 | `@ManyToMany` |

가장 흔한 다대일 관계부터 하나씩 따라해보겠습니다.

## @ManyToOne — "이 고양이의 주인은 누구?"

고양이와 주인 관계를 생각해봅시다. 한 주인이 여러 고양이를 키울 수 있지만, 고양이 한 마리의 주인은 한 명입니다. 이것이 **다대일(N:1)** 관계입니다.

먼저 두 엔티티를 만듭니다.

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

`@ManyToOne`이 하는 일은 명확합니다. cat 테이블에 `owner_id` 외래키 컬럼을 만들고, 이 컬럼이 owner 테이블의 PK를 참조하도록 합니다.

세 개의 인자를 살펴보면:

- `() => Owner` — 연결 대상 엔티티 (순환 참조 방지를 위해 함수로 감쌉니다)
- `(owner) => owner.cats` — 반대편 프로퍼티 (양방향일 때 사용, 단방향이면 생략 가능)
- `{ joinColumn: "owner_id" }` — 외래키 컬럼명

> **Hint** `joinColumn`을 생략해도 됩니다. 아래의 **@Column 기반 FK 자동 감지**를 참고하세요.

### @Column 기반 FK 자동 감지

`joinColumn`을 매번 지정하는 것은 번거롭고, `@Column`의 DB 컬럼명과 불일치할 위험이 있습니다. Stingerloom은 같은 엔티티에 `{프로퍼티명}Id` 패턴의 `@Column`이 선언되어 있으면, 해당 컬럼의 **실제 DB 이름**을 FK 컬럼으로 자동 사용합니다.

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

  // joinColumn 없이도 ownerId의 DB 이름 "owner_fk"가 자동 적용
  @ManyToOne(() => Owner, (owner) => owner.cats)
  owner!: Owner;
}
```

해석 우선순위는 다음과 같습니다.

1. `@ManyToOne`의 `joinColumn` 옵션이 명시된 경우 → 그대로 사용
2. 같은 엔티티에 `@Column`으로 선언된 `{프로퍼티명}Id`가 있으면 → 해당 `@Column`의 DB 컬럼명 사용
3. 둘 다 없으면 → `{프로퍼티명}Id` 컨벤션 fallback

`@Column`을 선언하면 FK 값을 엔티티에서 직접 읽고 쓸 수 있는 장점도 있습니다.

```typescript
const cat = new Cat();
cat.ownerId = 3;          // FK 값을 직접 설정
await em.save(Cat, cat);

console.log(cat.ownerId); // FK 값을 직접 읽기
```

### PK가 아닌 컬럼 참조 (references)

기본적으로 FK는 대상 엔티티의 PK를 참조합니다. PK 외의 컬럼을 참조하려면 `references` 옵션을 사용합니다.

```typescript
@ManyToOne(() => Owner, (owner) => owner.cats, {
  joinColumn: "owner_uuid_fk",
  references: "uuid",  // Owner.uuid 컬럼을 참조
})
owner!: Owner;
```

## @OneToMany — "이 주인의 고양이들은?"

주인 쪽에서 고양이 목록을 가져오고 싶다면 `@OneToMany`를 추가합니다. 이것은 `@ManyToOne`의 반대 방향입니다.

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

`mappedBy: "owner"`는 "Cat 엔티티의 `owner` 프로퍼티가 외래키를 가지고 있다"는 뜻입니다. `@OneToMany` 자체는 DB에 컬럼을 만들지 않습니다. 단지 조회할 때 관련 데이터를 가져올 수 있게 해주는 역할입니다.

> **Hint** `mappedBy`는 대상 엔티티의 프로퍼티 이름에 대한 **IntelliSense 자동완성**을 지원합니다. IDE에서 `mappedBy: ""`를 입력하면 Cat 엔티티의 프로퍼티 목록이 표시됩니다. `@ManyToMany`의 `mappedBy`, `@OneToOne`의 `inverseSide`도 동일합니다.

이제 주인의 고양이들을 가져올 수 있습니다.

```typescript
const owner = await em.findOne(Owner, {
  where: { id: 1 },
  relations: ["cats"],
});

console.log(owner.cats); // [{ id: 1, name: "나비" }, { id: 2, name: "치즈" }]
```

> **Hint** `relations`를 지정하지 않으면 `cats`는 로드되지 않습니다. 필요할 때만 명시적으로 로드하세요.

## Eager 로딩과 Lazy 로딩

매번 `relations: ["owner"]`를 쓰기 번거롭다면 두 가지 자동 로딩 방식이 있습니다.

### Eager 로딩 — 항상 함께 가져오기

`eager: true`로 설정하면 `find()`나 `findOne()` 호출 시 자동으로 LEFT JOIN이 실행됩니다.

```typescript
// cat.entity.ts
@ManyToOne(() => Owner, (owner) => owner.cats, {
  joinColumn: "owner_id",
  eager: true,  // find() 시 owner가 자동으로 로드됨
})
owner!: Owner;
```

```typescript
const cat = await em.findOne(Cat, { where: { id: 1 } });
console.log(cat.owner.name); // "홍길동" — relations 없이도 로드됨
```

관계 데이터가 항상 필요한 경우에 유용합니다.

### Lazy 로딩 — 접근할 때 가져오기

`lazy: true`로 설정하면 Proxy 기반 지연 로딩을 사용합니다. 프로퍼티에 실제로 접근하는 순간에 DB 쿼리가 실행됩니다.

```typescript
// cat.entity.ts
@ManyToOne(() => Owner, (owner) => owner.cats, {
  joinColumn: "owner_id",
  lazy: true,  // 접근 시점에 쿼리 실행
})
owner!: Owner;
```

```typescript
const cat = await em.findOne(Cat, { where: { id: 1 } });
const owner = await cat.owner; // 이 시점에 SELECT 쿼리 실행
console.log(owner.name);
```

> **Warning** `eager`와 `lazy`를 동시에 사용할 수 없습니다. 둘 다 설정하면 `eager`가 우선됩니다.

## @OneToOne — "사용자의 프로필"

사용자 한 명에 프로필 하나. 이것이 **일대일(1:1)** 관계입니다.

### 단방향 (소유측만)

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

user 테이블에 `profile_id` 컬럼이 생성됩니다. `eager: true`이므로 User를 조회하면 Profile도 함께 로드됩니다.

> **Hint** `@OneToOne`도 `@ManyToOne`과 동일하게 `@Column` 기반 FK 자동 감지를 지원합니다. `@Column({ name: "profile_fk" }) profileId: number`를 선언하면 `joinColumn`을 생략할 수 있습니다.

### 양방향

Profile에서도 User를 참조하고 싶다면 `inverseSide`를 사용합니다.

```typescript
// user.entity.ts — 소유측 (FK를 가진 쪽)
@OneToOne(() => Profile, { joinColumn: "profile_id", inverseSide: "user" })
profile!: Profile;

// profile.entity.ts — 역방향
@OneToOne(() => User, { inverseSide: "profile" })
user!: User;
```

```typescript
// 역방향에서 조회
const profile = await em.findOne(Profile, {
  where: { id: 1 },
  relations: ["user"],
});
console.log(profile.user.name); // "홍길동"
```

## @ManyToMany — "글에 태그 달기"

블로그 글에 태그를 달 수 있고, 하나의 태그는 여러 글에 사용될 수 있습니다. 이것이 **다대다(N:M)** 관계입니다.

다대다 관계에는 **중간 테이블(join table)**이 필요합니다. Stingerloom이 자동으로 생성해줍니다.

```typescript
// post.entity.ts — 소유측
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
      name: "post_tags",           // 중간 테이블명
      joinColumn: "post_id",       // 현재 엔티티의 FK
      inverseJoinColumn: "tag_id", // 대상 엔티티의 FK
    },
  })
  tags!: Tag[];
}
```

```typescript
// tag.entity.ts — 역방향
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

`synchronize: true`이면 `post_tags` 중간 테이블이 자동 생성되며, 두 테이블의 PK를 참조하는 외래키가 설정됩니다.

```typescript
// 태그와 함께 글 조회
const post = await em.findOne(Post, {
  where: { id: 1 },
  relations: ["tags"],
});
console.log(post.tags); // [{ id: 1, name: "TypeScript" }, { id: 2, name: "ORM" }]
```

> **Hint** 중간 테이블에 데이터를 추가/삭제하려면 `em.query()`로 직접 SQL을 실행합니다. 자세한 내용은 [EntityManager](./entity-manager.md) 문서를 참고하세요.

## Cascade — 부모와 함께 저장/삭제

**Cascade**를 사용하면 부모 엔티티를 저장하거나 삭제할 때 자식 엔티티도 자동으로 처리됩니다.

```typescript
// owner.entity.ts
@OneToMany(() => Cat, { mappedBy: "owner", cascade: ["insert"] })
cats!: Cat[];
```

이렇게 설정하면 Owner를 저장할 때 cats 배열에 새 Cat이 있으면 자동으로 INSERT됩니다.

Cascade 옵션은 다음 중에서 선택합니다.

| 옵션 | 동작 |
|------|------|
| `"insert"` | 부모 저장 시 자식도 INSERT |
| `"update"` | 부모 수정 시 자식도 UPDATE |
| `"delete"` | 부모 삭제 시 자식도 DELETE |
| `true` | 위 세 가지 모두 적용 |

배열로 조합할 수 있습니다.

```typescript
// 삽입과 삭제만 cascade
@OneToMany(() => Cat, { mappedBy: "owner", cascade: ["insert", "delete"] })
cats!: Cat[];

// 모든 cascade 적용
@OneToMany(() => Comment, { mappedBy: "post", cascade: true })
comments!: Comment[];
```

> **Warning** `cascade: ["delete"]`는 강력한 기능입니다. 부모를 삭제하면 모든 자식이 함께 삭제되므로, 의도치 않은 데이터 손실에 주의하세요.

## 관계 로딩 정리

관계 데이터를 가져오는 세 가지 방법을 정리합니다.

| 방법 | 설정 위치 | 동작 | 언제 사용? |
|------|----------|------|-----------|
| `relations` 옵션 | `find()` 호출 시 | 지정한 관계만 JOIN | 필요할 때만 관계를 로드하고 싶을 때 |
| `eager: true` | 데코레이터 옵션 | 항상 자동 JOIN | 관계가 거의 항상 필요할 때 |
| `lazy: true` | 데코레이터 옵션 | 프로퍼티 접근 시 쿼리 | 관계를 드물게 사용할 때 |

```typescript
// relations 옵션으로 여러 관계를 한 번에 로드
const user = await em.findOne(User, {
  where: { id: 1 },
  relations: ["profile", "posts"],
});
```

## 다음 단계

엔티티 간 관계를 설정했으니, 이제 데이터를 조작하는 다양한 방법을 알아볼 차례입니다.

- [EntityManager](./entity-manager.md) — find, save, delete, 집계, 페이지네이션
- [쿼리 빌더](./query-builder.md) — JOIN, GROUP BY 등 복잡한 SQL이 필요할 때
- [트랜잭션](./transactions.md) — 여러 작업을 하나로 묶어야 할 때
