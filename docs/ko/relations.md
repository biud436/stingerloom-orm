# 관계 (Relations)

**관계**(relation)는 두 엔티티 사이의 연결입니다. 관계는 "블로그 글에는 작성자가 있다"나 "한 주인이 고양이를 여러 마리 키운다" 같은 실제 세계의 관계를 데이터베이스에 반영합니다.

관계가 없으면 고양이 테이블에 주인의 ID를 평범한 정수로 저장해야 합니다. 그리고 고양이를 조회하면서 주인 데이터도 필요하면 JOIN 쿼리를 직접 작성해야 합니다. 외래 키 제약 조건, null 검사, 데이터 무결성도 직접 처리해야 합니다. 관계는 이 일을 모두 자동화합니다. 연결을 한 번 선언하면 ORM이 알맞은 JOIN, 외래 키 제약 조건, DDL을 생성합니다.

Stingerloom ORM은 네 가지 유형의 관계를 지원합니다.

| 관계 | 예시 | 데코레이터 |
|------|------|-----------|
| Many-to-One (N:1) | Cat -> Owner | `@ManyToOne` |
| One-to-Many (1:N) | Owner -> Cats | `@OneToMany` |
| One-to-One (1:1) | User -> Profile | `@OneToOne` |
| Many-to-Many (N:M) | Post <-> Tag | `@ManyToMany` |

가장 흔한 관계는 Many-to-One입니다.

## @ManyToOne: 고양이의 주인

### 이 관계가 필요한 이유

고양이와 주인의 관계를 생각해 봅시다. 한 주인은 고양이를 여러 마리 키울 수 있습니다. 하지만 고양이마다 주인은 한 명뿐입니다. 모든 데이터를 테이블 하나에 저장하면 고양이마다 주인 정보가 중복됩니다.

| cat_name | owner_name | owner_email |
|----------|-----------|-------------|
| Whiskers | John | john@mail.com |
| Cheddar | John | john@mail.com |
| Luna | Jane | jane@mail.com |

이 방식은 낭비이고 위험합니다. John이 이메일을 바꾸면 여러 행을 갱신해야 합니다. 하나라도 놓치면 데이터가 서로 어긋납니다. 해결책은 **정규화**(normalization)입니다. 주인은 한 테이블에, 고양이는 다른 테이블에 저장하고 **외래 키**(foreign key)로 연결합니다.

외래 키는 다른 테이블의 기본 키를 참조하는 컬럼입니다. 외래 키는 "이 값은 항상 다른 테이블의 유효한 행을 가리킨다"는 약속입니다.

### 동작 방식

먼저 엔티티 두 개를 정의합니다.

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
import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, RelationColumn } from "@stingerloom/orm";
import { Owner } from "./owner.entity";

@Entity()
export class Cat {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @ManyToOne(() => Owner, (owner) => owner.cats)
  @RelationColumn({ name: "owner_id" })
  owner!: Owner;
}
```

### 생성되는 DDL

위 엔티티로 Stingerloom이 실제로 생성하는 SQL은 다음과 같습니다.

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

세 가지를 눈여겨보세요.

1. `owner_id` 컬럼은 `cat` 테이블에 생성됩니다. "다(many)" 쪽이 항상 외래 키를 가집니다.
2. `ALTER TABLE ... ADD CONSTRAINT FOREIGN KEY`는 모든 `owner_id` 값이 실제로 있는 `owner.id`에 대응하도록 보장합니다.
3. 외래 키 제약 조건 이름에는 이름이 겹치지 않도록 `a1b2c3d4` 같은 해시 접미사가 붙습니다.

### JOIN이 포함된 SELECT 생성

고양이를 주인과 함께 조회하면 Stingerloom은 LEFT JOIN 쿼리를 생성합니다.

```typescript
const cat = await em.findOne(Cat, {
  where: { id: 1 },
  relations: ["owner"],
});
```

**생성되는 SQL (PostgreSQL):**

```sql
SELECT
  "cat"."id",
  "cat"."name",
  "cat"."owner_id",
  "owner"."id"   AS "owner__id",
  "owner"."name" AS "owner__name"
FROM "cat"
LEFT JOIN "owner" AS "owner" ON "cat"."owner_id" = "owner"."id"
WHERE "cat"."id" = 1;
```

`LEFT JOIN`은 주인이 없는 고양이도 반환한다는 뜻입니다. 주인이 없는 고양이는 owner_id가 NULL입니다. `INNER JOIN`을 쓰면 주인이 없는 고양이는 결과에서 빠집니다.

### 데코레이터 인자 이해하기

`@ManyToOne`의 인자는 다음과 같습니다.

- `() => Owner`: 대상 엔티티입니다. import 시점의 순환 참조를 막으려고 함수로 감쌉니다.
- `(owner) => owner.cats`: 역방향 속성입니다. 이 인자는 필수입니다. 대상에 역방향 속성이 없는 단방향 관계라면 `() => undefined`를 넘기세요.
- 세 번째 인자는 선택입니다. 여기에 `eager`, `cascade`, `onDelete` 같은 옵션을 넘깁니다. 옵션은 아래에서 설명합니다.

외래 키 컬럼은 같은 속성에 붙인 `@RelationColumn({ name: "owner_id" })`으로 선언합니다. `@RelationColumn`을 아예 생략해도 됩니다. 자세한 내용은 아래의 [@Column 기반 외래 키 자동 감지](#column-기반-외래-키-자동-감지)를 참고하세요.

### @Column 기반 외래 키 자동 감지

관계마다 외래 키 컬럼 이름을 지정하는 일은 번거롭습니다. `@Column`에 적은 DB 컬럼 이름과 어긋날 위험도 있습니다. 그래서 Stingerloom은 같은 엔티티에 `{propertyName}Id` 패턴의 `@Column`이 있으면 그 `@Column`의 실제 DB 이름을 외래 키 컬럼으로 자동 사용합니다.

```typescript
@Entity()
export class Cat {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  // DB 컬럼 이름이 "owner_fk"인 외래 키 컬럼
  @Column({ name: "owner_fk", type: "int" })
  ownerId!: number;

  // ownerId의 DB 이름인 "owner_fk"를 별도 선언 없이 자동 적용
  @ManyToOne(() => Owner, (owner) => owner.cats)
  owner!: Owner;
}
```

외래 키 컬럼은 다음 순서로 결정합니다.

1. 속성에 `@RelationColumn`이 붙어 있으면 그 `name`을 사용합니다. `name`을 생략하면 `{propertyName}Id`로 추론합니다.
2. `@ManyToOne`에 `joinColumn` 옵션이 있으면 그 값을 그대로 사용합니다. 이 옵션은 레거시이고 데코레이터 API에서는 deprecated입니다. 자세한 내용은 아래에 있습니다.
3. 같은 엔티티에 `{propertyName}Id`라는 `@Column`이 있으면 그 `@Column`의 DB 컬럼 이름을 사용합니다.
4. 위 어느 것도 없으면 외래 키 컬럼을 결정하지 못합니다. `@ManyToOne`은 항상 소유 측(owning side)입니다. 그래서 이 경우 INSERT와 UPDATE에서 외래 키를 저장하지 않고 관계도 로드하지 못합니다. 이때 ORM은 경고 로그를 출력합니다. `@RelationColumn({ name: "..." })`이나 `{propertyName}Id` `@Column`을 추가해 해결하세요.

`@Column`을 선언하면 장점이 하나 더 있습니다. 엔티티에서 외래 키 값을 직접 읽고 쓸 수 있습니다.

```typescript
const cat = new Cat();
cat.ownerId = 3;          // 외래 키 값을 직접 설정(Owner를 로드할 필요 없음)
await em.save(Cat, cat);

console.log(cat.ownerId); // 외래 키 값을 직접 읽기
```

생성되는 SQL은 다음과 같습니다.

```sql
INSERT INTO "cat" ("name", "owner_fk") VALUES ('Whiskers', 3);
```

### @RelationColumn 데코레이터

`@RelationColumn`은 `@ManyToOne`이나 `@OneToOne` 속성에 외래 키 컬럼을 선언적으로 정의하는 데코레이터입니다. 따로 `@Column`을 선언하지 않아도 DDL에 외래 키 컬럼을 자동으로 생성합니다.

```typescript
import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, RelationColumn } from "@stingerloom/orm";

@Entity()
export class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @ManyToOne(() => User, (user) => user.posts)
  @RelationColumn({ name: "author_id" })
  author!: User;
}
```

이 선언은 `@Column({ type: "int", name: "author_id", nullable: true }) authorId!: number`를 직접 선언하고 `@ManyToOne`에 `joinColumn: "author_id"`를 설정한 것과 같습니다.

자동 추론: `name`을 생략하면 기본값 `{propertyName}Id`를 쓰고 경고 로그를 출력합니다.

```typescript
@ManyToOne(() => User, (user) => user.posts)
@RelationColumn()        // "authorId"로 추론하고 경고 로그 출력
author!: User;
```

**옵션:**

| 옵션 | 타입 | 기본값 | 설명 |
|------|------|--------|------|
| `name` | `string` | `{propertyName}Id` | DB의 외래 키 컬럼 이름 |
| `type` | `ColumnType` | 대상 기본 키 타입 | 외래 키 컬럼 타입(예: `"int"`, `"bigint"`, `"uuid"`) |
| `nullable` | `boolean` | `true` | 외래 키 컬럼의 NULL 허용 여부 |
| `referencedColumn` | `string` | 대상 기본 키 | 대상 엔티티에서 참조할 컬럼 |

@Column과 병행 사용: `post.authorId = 5`처럼 외래 키 값에 직접 접근해야 하면 `@Column`과 `@RelationColumn`을 같은 이름으로 선언합니다. DDL에는 컬럼이 중복으로 생기지 않습니다.

```typescript
@Column({ type: "int", name: "author_id" })
authorId!: number;          // 외래 키에 직접 접근: post.authorId = 5

@ManyToOne(() => User, (user) => user.posts)
@RelationColumn({ name: "author_id" })
author!: User;
```

### 레거시: joinColumn 옵션

`@RelationColumn`이 생기기 전에는 외래 키 컬럼 이름을 데코레이터 옵션으로 넘겼습니다.

```typescript
// 레거시 형태: 동작은 하지만 deprecation 경고를 출력합니다
@ManyToOne(() => Owner, (owner) => owner.cats, { joinColumn: "owner_id" })
owner!: Owner;
```

이 형태는 지금도 동작합니다. 위 결정 순서의 두 번째 단계가 이 형태입니다. 하지만 데코레이터 API(`@ManyToOne`, `@OneToOne`)에서는 deprecated이고 시작할 때 경고 로그를 출력합니다. 이름을 `@RelationColumn`으로 옮겨 마이그레이션하세요.

```typescript
@ManyToOne(() => Owner, (owner) => owner.cats)
@RelationColumn({ name: "owner_id" })
owner!: Owner;
```

> 참고: 이 deprecation은 데코레이터 API에만 해당합니다. 코드 우선 API의 `joinColumn` 키는 별개의 계약이고 계속 지원하며 deprecated가 아닙니다. `defineEntity()`의 `t.manyToOne(() => Owner, { joinColumn: "owner_id" })`와 `EntitySchema`의 `relations` 블록이 여기에 해당합니다.

### 커스텀 외래 키 속성 이름 (fkProperty)

Stingerloom의 `qAlias()`를 비롯해 속성 이름을 컬럼 이름으로 바꾸는 리졸버(resolver)는 한 가지 컨벤션을 따릅니다. 관계 `workspace`와 짝을 이루는 외래 키 속성의 이름이 `workspaceId`라는 컨벤션입니다. 다른 ORM에서 코드를 옮겨 올 때처럼 외래 키 속성 이름을 따로 정해야 하면 관계 데코레이터에 `fkProperty`를 넘기세요. 그러면 리졸버가 그 속성을 실제 조인 컬럼에 매핑합니다.

```typescript
@Entity()
export class Member {
  @PrimaryGeneratedColumn()
  id!: number;

  // 커스텀 외래 키 속성 이름: {relProp}Id 컨벤션을 따르지 않음
  @ManyToOne(() => Workspace, (w) => w.members, { fkProperty: "wsId" })
  @RelationColumn({ name: "workspace_id" })
  workspace!: Workspace;

  wsId?: number; // 데코레이터 없는 일반 속성: @Column 불필요
}

// 이제 qAlias(Member).wsId.eq(...)는 "workspace_id"로 해석됩니다
const m = qAlias(Member, "m");
qb.where(m.wsId.eq(42));
```

`fkProperty`가 없으면 `qAlias(Member).wsId.eq(42)`는 SQL에서 `m.wsId`로 렌더링됩니다. 그러면 데이터베이스는 없는 컬럼이라며 쿼리를 거부합니다. 컨벤션 이름(`workspaceId`)은 영향을 받지 않고 명시적 오버라이드와 함께 계속 동작합니다.

`@OneToOne`에도 `fkProperty` 옵션이 있습니다. 컨벤션 이름(`{relProp}Id`)과 명시적 `fkProperty`가 함께 있으면 둘 다 같은 조인 컬럼에 매핑됩니다.

### 기본 키가 아닌 컬럼 참조 (references)

외래 키는 기본적으로 대상 엔티티의 기본 키를 참조합니다. 기본 키가 아닌 컬럼을 참조하려면 `@RelationColumn`의 `referencedColumn` 옵션을 씁니다.

```typescript
@ManyToOne(() => Owner, (owner) => owner.cats)
@RelationColumn({
  name: "owner_uuid_fk",
  type: "uuid",
  referencedColumn: "uuid",  // Owner.id 대신 Owner.uuid 컬럼을 참조
})
owner!: Owner;
```

`@ManyToOne`의 `references` 옵션도 같은 뜻입니다. 코드 우선 API인 `defineEntity()`와 `EntitySchema`는 계속 이 형태를 씁니다. 둘 다 지정하면 `referencedColumn`이 우선합니다.

`referencedColumn`과 `references`에는 컬럼 이름을 써도 되고 속성 이름을 써도 됩니다. 예를 들어 네이밍 전략이 `isoCode` 속성을 `iso_code` 컬럼으로 저장하면 두 이름 중 어느 것을 써도 됩니다. 둘 다 아닌 이름은 `register()`가 `SCHEMA_ERROR`로 거부합니다.

이렇게 선언하면 조인 컬럼은 제약 조건뿐 아니라 모든 경로에서 참조 컬럼의 값을 담습니다.

- `save()`에 `Owner` 인스턴스를 넘기면 `owner.uuid`를 기록합니다. 인스턴스 대신 값을 넘기면 그 값을 `uuid`로 봅니다.
- `relations: ["owner"]`와 지연 로딩은 `uuid`로 주인을 찾습니다.
- 역방향 측 `@OneToMany`(`owner.cats`, `withCount`, cascade)도 같은 컬럼으로 고양이를 찾습니다.

참조 대상 컬럼은 고유해야 합니다. 데이터베이스가 제약 조건에 고유성을 요구하기 때문입니다. 또 to-one 관계는 한 행으로 정해져야 하기 때문입니다. `@OneToMany` 쪽을 cascade로 저장할 때는 저장하는 부모 객체에 참조 컬럼 값이 들어 있어야 합니다.

> 복합 기본 키: 복합 기본 키는 둘 이상의 속성에 `@PrimaryColumn()`을 붙인 키입니다. 그런데 외래 키 컬럼은 컬럼 하나만 참조합니다. 그래서 대상 엔티티에 복합 기본 키가 있고 `synchronize`가 스키마를 만드는 경우에는 아래 규칙을 따라야 합니다.
>
> - `@ManyToOne`과 소유 측 `@OneToOne`은 `referencedColumn`으로 대상의 고유 컬럼을 지정하거나 `createForeignKeyConstraints: false`를 설정해야 합니다.
> - `@ManyToMany`는 그 엔티티를 어느 쪽에도 쓰지 못합니다.
>
> 이런 관계가 있으면 `register()`가 `SCHEMA_ERROR`로 거부합니다. 에러에는 관계 이름과 키 컬럼 이름이 담깁니다. `migrate:generate`도 마이그레이션 파일을 쓰기 전에 같은 방식으로 거부합니다.

생성되는 SQL은 다음과 같습니다.

```sql
ALTER TABLE "cat"
  ADD CONSTRAINT "fk_cat_owner_uuid_fk_e5f6g7h8"
  FOREIGN KEY ("owner_uuid_fk") REFERENCES "owner" ("uuid");
```

### 참조 무결성 액션 (onDelete / onUpdate)

외래 키는 기본적으로 `ON DELETE NO ACTION ON UPDATE NO ACTION`을 씁니다. 그래서 고양이가 있는 주인을 삭제하거나 주인의 기본 키를 바꾸려 하면 데이터베이스가 거부합니다. 이 동작은 `onDelete`와 `onUpdate` 옵션으로 바꿉니다.

```typescript
@ManyToOne(() => Owner, (owner) => owner.cats, {
  onDelete: "CASCADE",     // 주인 삭제 시 고양이도 삭제
  onUpdate: "CASCADE",     // 주인 기본 키 변경 시 외래 키도 갱신
})
@RelationColumn({ name: "owner_id" })
owner!: Owner;
```

생성되는 SQL은 다음과 같습니다.

```sql
ALTER TABLE "cat"
  ADD CONSTRAINT "fk_cat_owner_id_a1b2c3d4"
  FOREIGN KEY ("owner_id") REFERENCES "owner" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
```

`CASCADE`를 쓰면 주인 #3을 삭제할 때 데이터베이스가 `owner_id = 3`인 고양이를 모두 자동으로 삭제합니다. 이 옵션이 없으면 삭제는 외래 키 위반 에러로 실패합니다.

지원하는 액션은 다음과 같습니다.

| 액션 | 동작 |
|------|------|
| `'NO ACTION'` | 자식 행이 있으면 거부(기본값) |
| `'RESTRICT'` | NO ACTION과 같음(즉시 검사) |
| `'CASCADE'` | 자식을 자동으로 삭제하거나 갱신 |
| `'SET NULL'` | 외래 키를 NULL로 설정(컬럼이 nullable이어야 함) |
| `'SET DEFAULT'` | 외래 키를 기본값으로 설정 |

이 옵션은 `@ManyToOne`과 `@OneToOne` 모두에서 동작합니다. 목록에 없는 값을 쓰면 `synchronize`가 시작할 때 DDL을 실행하기 전에 에러를 던집니다. 액션 값은 SQL 문에 그대로 들어가기 때문입니다.

액션은 제약 조건의 일부입니다. 그래서 제약 조건을 생성할 때 적용됩니다. `migrate:generate`가 만드는 CREATE TABLE, 그리고 `synchronize`가 테이블을 만들거나 관계를 추가할 때가 그렇습니다. 제약 조건이 이미 있는 관계에서 `onDelete`나 `onUpdate`를 바꿔도 데이터베이스에는 아무 변화가 없습니다. 자세한 내용은 [Schema Diff가 비교하지 않는 것](./migrations.md#schema-diff가-비교하지-않는-항목)을 참고하세요. 이때는 마이그레이션에서 제약 조건을 다시 생성하세요.

```sql
-- PostgreSQL (MySQL: DROP FOREIGN KEY `fk_cat_owner_id_a1b2c3d4`)
ALTER TABLE "cat" DROP CONSTRAINT "fk_cat_owner_id_a1b2c3d4";
ALTER TABLE "cat" ADD CONSTRAINT "fk_cat_owner_id_a1b2c3d4"
  FOREIGN KEY ("owner_id") REFERENCES "owner" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

> 3.0 이전에는 PostgreSQL과 MySQL / MariaDB의 `synchronize`가 관계 선언과 관계없이 모든 관계 제약 조건을 `ON DELETE NO ACTION ON UPDATE NO ACTION`으로 만들었습니다. SQLite와 `migrate:generate`는 여기에 해당하지 않습니다. 그렇게 만든 제약 조건은 업그레이드한 뒤에도 그대로 남습니다. `information_schema.referential_constraints`로 확인하고 위처럼 다시 만드세요.

### 외래 키 제약 조건 건너뛰기 (createForeignKeyConstraints)

크로스 데이터베이스 참조나 성능이 중요한 테이블처럼 논리적 관계는 유지하면서 외래 키 제약 조건 생성만 건너뛰고 싶은 경우가 있습니다.

```typescript
@ManyToOne(() => ExternalEntity, (e) => e.items, {
  createForeignKeyConstraints: false,  // DDL에 외래 키 제약 조건 없음
})
@RelationColumn({ name: "external_id" })
external!: ExternalEntity;
```

컬럼은 여전히 생성합니다. 하지만 `ALTER TABLE ... ADD CONSTRAINT FOREIGN KEY`는 생성하지 않습니다. ORM은 관계 정보를 그대로 쓰므로 JOIN도 올바르게 생성합니다. 다만 데이터베이스에 두 테이블의 연결을 강제하라고 요청하지 않을 뿐입니다. 이 옵션은 `@OneToOne`에서도 동작합니다.

### SQLite와 외래 키 제약 조건

SQLite는 `ALTER TABLE ... ADD FOREIGN KEY`를 지원하지 않습니다. 그래서 SQLite에서는 스키마 동기화가 외래 키 제약 조건을 `CREATE TABLE` 문에 직접 넣습니다. `@ManyToMany` 조인 테이블과 TPT 상속에서 자식 테이블이 루트 테이블을 가리키는 외래 키도 마찬가지입니다. 이 방식에는 두 가지 결과가 따릅니다.

- 외래 키 제약 조건은 테이블을 생성할 때만 함께 만들어집니다. 테이블이 이미 있는 엔티티에 관계를 추가하면 조인 컬럼은 생기지만 데이터베이스 수준의 제약 조건은 생기지 않습니다. 제약 조건을 강제해야 하면 테이블을 다시 생성하거나 마이그레이션을 쓰세요.
- SQLite는 연결에서 `PRAGMA foreign_keys = ON`을 실행해야만 외래 키 제약 조건을 강제합니다. 제약 조건 선언은 이 설정과 관계없이 DDL에 들어갑니다.

### ESM에서의 상호 참조 (`Relation<T>`)

데코레이터로 정의한 두 엔티티가 서로를 참조하면 순환 import가 생깁니다. `User`를 가리키는 `Post.author`와 다시 `Post`를 가리키는 `User.posts`가 그 예입니다. 데코레이터의 `() => User` thunk는 이 순환을 문제없이 처리합니다. 하지만 `emitDecoratorMetadata`는 단일 값 관계 속성마다 클래스를 *즉시* 참조하는 `design:type` 메타데이터도 함께 내보냅니다. CommonJS에서는 순환 require가 그 자리에 `undefined`를 넣고 넘어갑니다. 반면 ESM에서는 모듈 바인딩이 live 바인딩입니다. 그래서 평가가 끝나지 않은 모듈의 바인딩을 읽는 순간 에러가 납니다.

```
ReferenceError: Cannot access 'User' before initialization
```

해결책은 `@stingerloom/orm`에서 export하는 `Relation<T>` 래퍼 타입입니다.

```typescript
import { Entity, ManyToOne, type Relation } from "@stingerloom/orm";
import { User } from "./user.entity.js";

@Entity()
export class Post {
  @ManyToOne(() => User, (user) => user.posts)
  author!: Relation<User>;
}
```

타입 검사기에게 `Relation<User>`는 그냥 `User`입니다. 하지만 바깥 참조는 런타임 값이 없는 타입 별칭으로 해석됩니다. 그래서 `design:type`은 엔티티 클래스 대신 `Object`로 직렬화됩니다. 즉시 참조가 사라지므로 크래시도 나지 않습니다. ORM은 관계 속성의 `design:type`을 읽지 않으므로 잃는 것도 없습니다. 관계 대상은 thunk에서만 읽습니다.

래퍼는 단일 값 관계(`@ManyToOne`, `@OneToOne`)에만 필요합니다. 컬렉션 속성(`Post[]`)은 원래 `Array`로 직렬화됩니다. 인트로스펙션 생성기는 `Relation<T>`를 자동으로 붙여 출력합니다. CJS 전용 프로젝트는 래퍼 없이도 동작하지만 래퍼가 있어도 해가 없습니다. 엔티티가 서로를 참조하고 코드가 ESM으로 실행될 가능성이 있으면 항상 래퍼를 쓰세요.

## @OneToMany: 주인의 고양이들

### 역방향(Inverse) 측인 이유

주인 쪽에서 고양이 목록을 조회하려면 `@OneToMany`를 추가합니다. `@OneToMany`는 `@ManyToOne`의 역방향입니다.

꼭 알아 둘 점이 있습니다. `@OneToMany`는 데이터베이스에 컬럼을 하나도 생성하지 않습니다. 외래 키 컬럼(`owner_id`)은 `@ManyToOne`이 만든 컬럼이고 `cat` 테이블에 있습니다. `@OneToMany` 데코레이터는 주인의 고양이를 요청받으면 외래 키로 `cat` 테이블을 조회하라고 ORM에 알려 줄 뿐입니다.

현실에 빗대면 이렇습니다. 고양이마다 주인 이름이 적힌 목걸이를 차고 있습니다. 이 목걸이가 외래 키입니다. 주인은 고양이 ID 목록을 들고 다니지 않습니다. 주인의 고양이를 찾으려면 모든 고양이의 목걸이를 확인합니다.

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

`mappedBy: "owner"`는 Cat 엔티티의 `owner` 속성이 외래 키를 가진다는 뜻입니다. ORM은 이 값을 보고 JOIN에 쓸 컬럼을 정합니다.

Owner 테이블의 DDL은 바뀌지 않습니다. 추가되는 컬럼이 없습니다.

```sql
-- PostgreSQL
CREATE TABLE "owner" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL
);
-- 이것이 전부입니다. "cats" 컬럼은 없습니다.
```

> 힌트: `mappedBy`에 대상 엔티티의 속성 이름을 입력할 때 IntelliSense 자동 완성이 동작합니다. IDE에서 `mappedBy: ""`를 입력하면 Cat 엔티티의 속성 목록이 표시됩니다. `@ManyToMany`의 `mappedBy`와 `@OneToOne`의 `inverseSide`도 마찬가지입니다.

`register()`는 테이블을 생성하기 전에 이 이름을 검사합니다. 그래서 잘못된 이름은 처음 로드할 때 `no such column` 에러로 드러나지 않고 등록 단계에서 잡힙니다. 예를 들어 `mappedBy`가 `"ownr"`처럼 대상의 어떤 `@ManyToOne`과도 맞지 않으면 `Did you mean "owner"?` 메시지와 함께 실패합니다. `@OneToOne`의 `inverseSide`, 양쪽 모두 조인 테이블이 없는 `@ManyToMany`, `entities`에 빠진 관계 대상도 같은 검사에서 걸러집니다. 자세한 내용은 [Invalid relation mapping](./troubleshooting.md#register-시점의-invalid-relation-mapping)을 참고하세요.

### 생성되는 SELECT

이제 주인의 고양이 목록을 조회합니다.

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

-- 2단계: 외래 키로 관련 고양이를 로드
SELECT * FROM "cat" WHERE "owner_id" = 1;
```

ORM은 주인을 조회하는 쿼리와 고양이를 조회하는 쿼리를 따로 실행합니다. 그런 다음 두 결과를 `cats` 배열이 들어 있는 객체 하나로 합칩니다.

> 힌트: `relations`를 지정하지 않으면 `cats`를 로드하지 않습니다. 쓰지 않는 쿼리를 실행하지 않도록 필요할 때만 명시적으로 로드하세요.

## 즉시 로딩과 지연 로딩

### 로딩 전략이 중요한 이유

고양이 50마리를 나열하는 페이지를 생각해 봅시다. 고양이마다 주인이 있고 목록을 순회하면서 주인을 하나씩 로드하면 다음 쿼리가 실행됩니다.

```sql
SELECT * FROM "cat";                          -- 쿼리 1개: 고양이 50마리 조회
SELECT * FROM "owner" WHERE "id" = 1;         -- 쿼리 #2
SELECT * FROM "owner" WHERE "id" = 2;         -- 쿼리 #3
...
SELECT * FROM "owner" WHERE "id" = 50;        -- 쿼리 #51
```

쿼리는 모두 51개입니다. 이것을 **N+1 문제**라고 합니다. 고양이 N마리를 조회하는 쿼리 1개에 주인을 하나씩 조회하는 쿼리 N개가 더해집니다. 빠른 데이터베이스에서는 50ms 정도 걸립니다. 하지만 네트워크로 떨어져 있는 데이터베이스라면 5초가 걸릴 수도 있습니다.

해결책은 관련 데이터를 더 적은 쿼리로 로드하는 것입니다. 미리 한꺼번에 로드하는 방식이 즉시 로딩(eager loading)이고 필요할 때 로드하는 방식이 지연 로딩(lazy loading)입니다.

매번 `relations: ["owner"]`를 쓰기 번거롭다면 자동으로 로드하는 방법이 두 가지 있습니다.

### 즉시 로딩(Eager Loading): 항상 함께 조회 (1개 쿼리, JOIN 포함)

`eager: true`를 설정하면 `find()`나 `findOne()`을 호출할 때 LEFT JOIN을 자동으로 실행합니다.

```typescript
// cat.entity.ts
@ManyToOne(() => Owner, (owner) => owner.cats, {
  eager: true,  // find() 시 owner를 자동으로 로드합니다
})
@RelationColumn({ name: "owner_id" })
owner!: Owner;
```

```typescript
const cat = await em.findOne(Cat, { where: { id: 1 } });
console.log(cat.owner.name); // "John": relations 옵션 없이 로드됨
```

`findWithCursor()`도 같은 `eager` 관계를 붙입니다. 다만 키셋 쿼리 자체는 JOIN하지 않습니다. 대신 페이지마다 관계 하나당 배치 쿼리 하나로 로드합니다. 즉시 로딩은 어느 경로에서든 한 단계만 읽습니다. 루트 엔티티의 `eager` 관계는 붙습니다. 하지만 `relations`로 따라 들어간 엔티티의 `eager` 관계까지 풀지는 않습니다. 고양이의 주인이 키우는 고양이 목록이 그 예입니다. 이런 관계가 필요하면 [중첩 관계](#중첩-관계)로 이름을 지정하세요. 소프트 삭제된 대상은 `withDeleted`를 넘기지 않으면 `null`로 하이드레이트됩니다.

**생성되는 SQL (PostgreSQL):**

```sql
SELECT
  "cat"."id",
  "cat"."name",
  "cat"."owner_id",
  "owner"."id"   AS "owner__id",
  "owner"."name" AS "owner__name"
FROM "cat"
LEFT JOIN "owner" AS "owner" ON "cat"."owner_id" = "owner"."id"
WHERE "cat"."id" = 1;
```

쿼리 하나가 한 번의 라운드 트립(round trip)으로 모든 데이터를 반환합니다. LEFT JOIN은 주인이 없는 고양이도 결과에 포함한다는 뜻입니다. 관련 데이터가 항상 필요할 때 유용합니다.

### 지연 로딩(Lazy Loading): 접근 시 조회 (별도 쿼리)

`lazy: true`를 설정하면 Proxy 기반의 지연 로딩을 씁니다. 속성에 실제로 접근하는 시점에 데이터베이스 쿼리를 실행합니다.

```typescript
// cat.entity.ts
@ManyToOne(() => Owner, (owner) => owner.cats, {
  lazy: true,  // 접근 시 쿼리 실행
})
@RelationColumn({ name: "owner_id" })
owner!: Owner;
```

```typescript
const cat = await em.findOne(Cat, { where: { id: 1 } });
// 이 시점에는 고양이 행만 로드됩니다. JOIN도 추가 쿼리도 없습니다.

const owner = await cat.owner; // 이때 SELECT를 실행합니다
console.log(owner.name);
```

**생성되는 SQL (PostgreSQL):**

```sql
-- findOne(Cat) 시:
SELECT * FROM "cat" WHERE "id" = 1;

-- cat.owner 접근 시(Proxy가 실행):
SELECT * FROM "owner" WHERE "id" = 3;
```

지연 로딩은 관계에 거의 접근하지 않을 때 유용합니다. 고양이 50마리를 나열하면서 첫 번째 고양이의 주인만 표시한다면 불필요한 쿼리 49개를 피합니다.

`lazy` 관계라도 `relations`에 이름을 넣으면 다른 관계처럼 조회와 함께 로드됩니다. 이때 `cat.owner`에는 주인 엔티티 자체가 들어 있습니다. `await cat.owner`도 그대로 동작합니다. 그리고 그 [중첩 관계](#중첩-관계)를 함께 지정하면 같이 로드됩니다.

> 힌트: 로드되지 않은 `lazy` 속성은 non-enumerable입니다. 그래서 `JSON.stringify(cat)`, 스프레드, `Object.keys`는 쿼리를 실행하지 않고 이 속성을 건너뜁니다. 속성을 로드하거나 직접 할당하면 평범한 enumerable 값이 되어 정상적으로 직렬화됩니다. 직렬화 결과에는 항상 실제로 로드된 값만 들어갑니다. 지연 로딩이 실패하면 `await`한 호출자는 거부된 Promise를 받습니다. 하지만 await 없이 버려진 동기 접근이 unhandled rejection으로 프로세스를 죽이지는 않습니다.

### N+1 트레이드오프

| 전략 | 고양이 50마리와 주인을 조회하는 쿼리 수 | 적합한 경우 |
|------|--------------------------------------|-------------|
| 로딩 없음 | 1 (주인 없음) | 관계가 필요 없을 때 |
| `relations: ["owner"]` | 2 (고양이 + 주인) | 쿼리별 명시적 제어가 필요할 때 |
| `eager: true` | 1 (JOIN) | 관계가 항상 필요할 때 |
| `lazy: true` | 1 ~ 51 (접근에 따라 다름) | 관계가 거의 필요 없을 때 |

> 주의: `eager`와 `lazy`는 동시에 쓸 수 없습니다. 둘 다 설정하면 `eager`가 우선합니다.

> 힌트: Stingerloom에는 런타임에 N+1 패턴을 감지해 경고 로그를 남기는 QueryTracker가 있습니다. 켜는 방법은 [EntityManager](./entity-manager.md) 문서를 참고하세요.

## @OneToOne: 사용자의 프로필

### One-to-One이 필요한 이유

사용자 한 명에게 프로필은 하나입니다. 프로필 필드를 모두 User 테이블에 직접 넣어도 됩니다. 하지만 프로필을 따로 분리하는 이유가 있습니다.

1. 프로필에는 bio, 아바타 URL, 소셜 링크처럼 큰 데이터가 들어가지만 거의 로드되지 않습니다.
2. 접근 패턴이 다릅니다. 사용자 테이블은 요청마다 읽지만 프로필은 프로필 페이지에서만 읽습니다.
3. 관심사를 분리합니다. 사용자 인증 데이터와 화면에 표시할 데이터를 나눕니다.

One-to-One 관계는 한쪽에 외래 키를 생성해 관련 행이 최대 하나임을 보장합니다. 외래 키가 있는 쪽이 소유 측입니다.

### 단방향 (소유 측만)

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
import { Entity, PrimaryGeneratedColumn, Column, OneToOne, RelationColumn } from "@stingerloom/orm";
import { Profile } from "./profile.entity";

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @OneToOne(() => Profile, { eager: true })
  @RelationColumn({ name: "profile_id" })
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

`profile_id` 컬럼은 user 테이블에 생성됩니다. `eager: true`이므로 User를 조회할 때 Profile도 함께 로드됩니다.

**즉시 로딩으로 생성되는 SQL (PostgreSQL):**

```sql
SELECT
  "user"."id",
  "user"."name",
  "user"."profile_id",
  "profile"."id"  AS "profile__id",
  "profile"."bio" AS "profile__bio"
FROM "user"
LEFT JOIN "profile" AS "profile" ON "user"."profile_id" = "profile"."id"
WHERE "user"."id" = 1;
```

> 힌트: `@OneToOne`도 `@ManyToOne`과 같은 순서로 외래 키 컬럼을 결정합니다. `@RelationColumn`이 먼저이고 그다음이 레거시 `joinColumn` 옵션입니다. 마지막은 `{propertyName}Id` 패턴의 `@Column`입니다. `@Column({ name: "profile_fk" }) profileId: number`가 그 예입니다.

### 소유 측 저장

소유 측의 키는 `@ManyToOne`과 같은 방식으로 기록됩니다. 관련 인스턴스를 넘겨도 되고 키 값을 그대로 넘겨도 됩니다. `${property}Id` 섀도 속성을 넘겨도 됩니다.

```typescript
const profile = await em.save(Profile, { bio: "Hello" });

const user = await em.save(User, { name: "Alice", profile }); // profile_id = profile.id
await em.save(User, { id: user.id, profile: otherProfile });  // 다시 지정
await em.save(User, { id: user.id, profile: null });          // 키 비우기
```

`save()`, `saveMany()`, `insertMany()`, `insertManyAndReturn()`, upsert 계열은 모두 이 키를 기록합니다. 페이로드에 관계가 없으면 저장된 키를 그대로 둡니다. 관련 인스턴스에는 기본 키가 이미 있어야 합니다. 역방향 측(아래의 `Profile.user`)에는 컬럼이 없으므로 관계는 소유 측에 지정하세요. 3.0 이전에는 어떤 쓰기 메서드도 소유 측의 키를 저장하지 않아 컬럼이 `NULL`로 남았습니다. 섀도 속성을 넘긴 `updateMany()`만 예외였습니다.

### 양방향

Profile에서도 User를 참조하려면 `inverseSide`를 씁니다.

```typescript
// user.entity.ts: 소유 측(외래 키가 있는 쪽)
@OneToOne(() => Profile, { inverseSide: "user" })
@RelationColumn({ name: "profile_id" })
profile!: Profile;

// profile.entity.ts: 역방향 측
@OneToOne(() => User, { inverseSide: "profile" })
user!: User;
```

`@OneToMany`와 마찬가지로 역방향 측은 컬럼을 추가로 생성하지 않습니다. 외래 키 `profile_id`는 `user` 테이블에만 있습니다.

```typescript
// 역방향 측에서 조회
const profile = await em.findOne(Profile, {
  where: { id: 1 },
  relations: ["user"],
});
console.log(profile.user.name); // "John"
```

**생성되는 SQL (PostgreSQL):**

```sql
SELECT "id", "bio" FROM "profile" WHERE "id" = $1 LIMIT $2;

SELECT "id", "name", "profile_id" AS "__stg_o2o_fk"
FROM "user"
WHERE "profile_id" IN ($1);
```

역방향 측에는 JOIN할 키가 없습니다. 그래서 `profile_id`가 일치하는 user 행을 찾는 두 번째 쿼리로 로드합니다. 이 쿼리는 프로필마다 실행하지 않고 조회한 프로필 전체를 대상으로 한 번만 실행합니다.

## @ManyToMany: 글에 태그 달기

### Many-to-Many에 조인 테이블이 필요한 이유

블로그 글에는 태그가 여러 개 붙습니다. 그리고 태그 하나가 여러 글에 붙기도 합니다. 이런 관계가 **Many-to-Many (N:M)** 관계입니다.

외래 키 컬럼 하나로는 이 관계를 표현하지 못합니다. post 테이블에 `tag_id`를 추가하면 글 하나에 태그를 하나만 붙일 수 있습니다. tag 테이블에 `post_id`를 추가하면 태그 하나를 글 하나에만 붙일 수 있습니다. 어느 쪽도 맞지 않습니다.

해결책은 **조인 테이블**(join table)입니다. 조인 테이블은 양쪽 테이블을 하나씩 가리키는 외래 키 컬럼 두 개를 가진 세 번째 테이블입니다. junction table이나 bridge table이라고도 부릅니다.

```
post (id, title)
  |
  +--- post_tags (post_id, tag_id) --- 조인 테이블
  |
tag (id, name)
```

`post_tags`의 행 하나는 글과 태그의 연결 하나를 나타냅니다. "글 #1에 태그 #2가 있다"가 그 예입니다.

### 동작 방식

```typescript
// post.entity.ts: 소유 측
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
      joinColumn: "post_id",       // 현재 엔티티를 가리키는 외래 키
      inverseJoinColumn: "tag_id", // 대상 엔티티를 가리키는 외래 키
    },
  })
  tags!: Tag[];
}
```

```typescript
// tag.entity.ts: 역방향 측
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

`synchronize: true`를 쓰면 `post_tags` 조인 테이블을 자동으로 생성합니다. 생성되는 DDL은 다음과 같습니다.

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

조인 테이블에는 복합 기본 키(`post_id`, `tag_id`)가 있습니다. 그래서 같은 글과 태그 쌍이 두 번 들어가지 않습니다.

스키마에는 이름마다 테이블이 하나만 생깁니다. 그래서 조인 테이블 이름 하나는 관계 하나에만 속합니다. `synchronize`가 스키마를 만들 때 두 번째 `@ManyToMany`가 같은 `joinTable.name`을 다른 컬럼이나 다른 테이블로 선언하면 `register()`가 거부합니다. `migrate:generate`도 마이그레이션 파일을 쓰기 전에 거부합니다. 관계 하나의 양쪽이 컬럼을 서로 뒤집어 각자 조인 테이블을 선언하는 것은 허용합니다. 하지만 보통은 한쪽에 `joinTable`을 두고 반대쪽에 `mappedBy`를 둡니다.

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

-- 2단계: 조인 테이블로 태그를 로드
SELECT "tag".*
FROM "tag"
INNER JOIN "post_tags" ON "post_tags"."tag_id" = "tag"."id"
WHERE "post_tags"."post_id" = 1;
```

조인 테이블을 조회해 글 #1에 속한 태그 ID를 찾습니다. 그런 다음 그 태그를 로드합니다.

### 조인 테이블 데이터 관리

조인 테이블에 항목을 추가하거나 제거하려면 `em.query()`로 SQL을 직접 실행합니다. 조인 테이블은 엔티티가 아니라 관계를 잇기만 하는 테이블입니다.

```typescript
// 글에 태그 추가
await em.query("INSERT INTO post_tags (post_id, tag_id) VALUES ($1, $2)", [1, 3]);

// 글에서 태그 제거
await em.query("DELETE FROM post_tags WHERE post_id = $1 AND tag_id = $2", [1, 3]);
```

> 힌트: `em.query()`의 자세한 내용은 [EntityManager](./entity-manager.md) 문서를 참고하세요.

## Cascade: 부모와 함께 저장/삭제

### Cascade가 필요한 이유

cascade가 없으면 부모 엔티티와 자식을 저장할 때 메서드를 여러 번 명시적으로 호출해야 합니다.

```typescript
// Cascade 없음: 각 자식을 개별적으로 저장해야 함
const owner = await em.save(Owner, { name: "John" });
await em.save(Cat, { name: "Whiskers", ownerId: owner.id });
await em.save(Cat, { name: "Cheddar", ownerId: owner.id });
await em.save(Cat, { name: "Luna", ownerId: owner.id });
```

이 방식은 번거롭고 실수하기 쉽습니다. 자식 저장을 잊을 수도 있습니다. 부모 저장은 성공했는데 자식 저장이 실패할 수도 있습니다. 그러면 데이터가 서로 어긋난 상태로 남습니다.

cascade를 쓰면 부모를 저장할 때 ORM이 자식을 자동으로 저장합니다.

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

**cascade**는 부모 엔티티를 저장하거나 삭제할 때 자식 엔티티도 자동으로 처리하는 기능입니다.

```typescript
// owner.entity.ts
@OneToMany(() => Cat, { mappedBy: "owner", cascade: ["insert"] })
cats!: Cat[];
```

이렇게 설정하면 Owner를 저장할 때 cats 배열의 새 Cat을 자동으로 INSERT합니다.

저장하는 cascade(`"insert"`나 `"update"`)가 없으면 `cats`에 든 새 Cat은 저장하지 않습니다. 새 Cat은 기본 키 값이 없는 객체입니다. 이때 save는 [`unknownWriteKeys`](./entity-manager-writes.md#unknownwritekeys-정책) 정책에 따라 이 Cat을 보고합니다. Owner와 함께 조회했다가 다시 저장하는 경우처럼 키가 있는 Cat은 건드리지 않습니다.

**생성되는 SQL (PostgreSQL):**

```sql
-- 1. 주인을 삽입
INSERT INTO "owner" ("name") VALUES ('John') RETURNING *;
-- 반환: { id: 1, name: 'John' }

-- 2. 주인의 외래 키를 넣어 고양이마다 자동 삽입
INSERT INTO "cat" ("name", "owner_id") VALUES ('Whiskers', 1) RETURNING *;
INSERT INTO "cat" ("name", "owner_id") VALUES ('Cheddar', 1) RETURNING *;
INSERT INTO "cat" ("name", "owner_id") VALUES ('Luna', 1) RETURNING *;
```

cascade 옵션은 다음 중에서 고릅니다.

| 옵션 | 동작 |
|------|------|
| `"insert"` | 부모 저장 시 자식을 INSERT |
| `"update"` | 부모 갱신 시 자식을 UPDATE |
| `"delete"` | 부모 제거 시 자식도 제거(연쇄되는 메서드는 아래 참고) |
| `true` | 위 세 가지 모두 적용 |

`"remove"`는 `"delete"`의 별칭입니다. remove cascade는 부모의 모든 제거 메서드를 따라갑니다.

- `delete()`와 `deleteMany()`는 자식을 먼저 하드 삭제합니다.
- `softDelete()`는 자식을 소프트 삭제합니다.
- `restore()`는 부모와 함께 소프트 삭제된 자식을 복원합니다.

`softDelete()`와 `restore()`는 자식 엔티티에도 `@DeletedAt`이 있을 때만 자식에 닿습니다. `@DeletedAt`이 없는 자식은 연쇄할 대상이 없으므로 그대로 둡니다. 이런 자식은 `delete()`와 `deleteMany()`로만 제거됩니다. 연쇄된 SQL 문은 각각 자식 자신의 메서드로 실행됩니다. 그래서 자식의 이벤트가 발생하고 그 아래로도 계속 연쇄됩니다.

옵션은 배열로 조합합니다.

```typescript
// insert와 delete만 cascade
@OneToMany(() => Cat, { mappedBy: "owner", cascade: ["insert", "delete"] })
cats!: Cat[];

// 모든 cascade 적용
@OneToMany(() => Comment, { mappedBy: "post", cascade: true })
comments!: Comment[];
```

### @OneToOne의 cascade

`cascade`는 `@OneToOne`의 양쪽 모두에서 같은 옵션으로 동작합니다. 어느 행을 먼저 쓸지는 조인 컬럼의 위치에 따라 달라집니다.

```typescript
@Entity()
class User {
  // 소유 측: 조인 컬럼(profile_id)이 user에 있음
  @OneToOne(() => Profile, { cascade: true })
  @RelationColumn({ name: "profile_id" })
  profile!: Relation<Profile> | null;

  // 역방향 측: 조인 컬럼(owner_id)이 avatar에 있음
  @OneToOne(() => Avatar, { inverseSide: "owner", cascade: true })
  avatar!: Relation<Avatar> | null;
}

await em.save(User, { name: "alice", profile: { bio: "hi" }, avatar: { url: "a.png" } });
```

| | 소유 측 (`profile`) | 역방향 측 (`avatar`) |
|---|---|---|
| `save()` / `saveMany()` | 대상을 먼저 저장하고 그 키를 user의 조인 컬럼에 넣습니다. | user를 저장한 뒤에 user의 키를 대상의 조인 컬럼에 넣어 저장합니다. |
| `delete()` / `deleteMany()` | 대상을 참조하는 user 행을 삭제한 뒤에 대상을 삭제합니다. | OneToMany 자식처럼 user보다 먼저 삭제합니다. |
| `softDelete()` / `restore()` | 대상에 `@DeletedAt`이 있으면 user를 따라갑니다. | 같습니다. |

`restore()`는 OneToMany 자식과 마찬가지로 소프트 삭제되어 있던 user의 대상만 복원합니다. `delete()`는 소프트 삭제된 user도 삭제하고 그 user의 cascade 대상도 함께 삭제합니다. OneToOne 양쪽과 OneToMany 자식 모두 같습니다.

저장 중인 행을 다시 가리키는 객체 그래프에서도 양쪽에 cascade를 걸어도 안전합니다. `profile.user`에 user 자신을 넣거나 `user.posts`의 각 post가 `user`를 들고 있는 경우가 그 예입니다. cascade 상위에서 이미 저장 중인 행은 다시 저장하지 않습니다. 관련 행은 그 행의 키를 받아 갑니다. 그래서 모든 행은 한 번씩만 쓰입니다.

### Cascade가 없을 때

외래 키 제약 조건이 걸려 있으면 `cascade: ["delete"]` 없이 자식이 있는 부모를 삭제하는 쿼리는 실패합니다.

```sql
DELETE FROM "owner" WHERE "id" = 1;
-- ERROR: update or delete on table "owner" violates foreign key constraint
-- "fk_cat_owner_id_a1b2c3d4" on table "cat"
-- Detail: Key (id)=(1) is still referenced from table "cat".
```

자식을 먼저 삭제한 다음 부모를 삭제해야 합니다.

```sql
DELETE FROM "cat" WHERE "owner_id" = 1;    -- 먼저 자식 삭제
DELETE FROM "owner" WHERE "id" = 1;        -- 그다음 부모 삭제
```

`cascade: ["delete"]`를 쓰면 ORM이 이 순서를 자동으로 지킵니다.

> 주의: `cascade: ["delete"]`는 강력한 기능입니다. 부모를 삭제하면 자식이 모두 삭제되므로 의도하지 않은 데이터 손실에 주의하세요. 이 기능은 Stingerloom이 순서를 처리하는 ORM 수준의 cascade입니다. 외래 키 제약 조건에 거는 데이터베이스 수준의 `ON DELETE CASCADE`와는 다릅니다. 결과는 비슷하지만 ORM cascade는 생명주기 훅과 이벤트 구독자도 실행합니다.

## 관계 로딩 요약

관련 데이터를 조회하는 방법은 세 가지입니다.

| 방법 | 설정 위치 | 동작 | 사용 시기 |
|------|----------|------|----------|
| `relations` 옵션 | `find()` 호출 시 | 지정한 관계만 로드(JOIN 또는 별도 쿼리, 아래 참고) | 필요할 때만 관계를 로드하고 싶을 때 |
| `eager: true` | 데코레이터 옵션 | 항상 자동 JOIN | 관계가 거의 항상 필요할 때 |
| `lazy: true` | 데코레이터 옵션 | 속성 접근 시 쿼리 | 관계가 거의 사용되지 않을 때 |

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

ManyToOne 관계와 OneToOne의 소유 측은 LEFT JOIN으로 로드합니다. 쿼리는 하나입니다. OneToMany, ManyToMany, OneToOne의 역방향 측은 별도 쿼리로 로드합니다. JOIN을 쓰면 부모 행이 자식 수만큼 중복되기 때문입니다. 이 쿼리는 부모의 기본 키로 관련 행을 짝짓습니다. 그래서 `select`에서 기본 키를 빼도 기본 키를 함께 조회합니다. 자세한 내용은 [select와 relations 함께 쓰기](./entity-manager-querying.md#select와-relations-함께-쓰기)를 참고하세요.

관계를 따라 읽은 엔티티는 그 엔티티를 직접 `find()`했을 때와 같은 속성으로 하이드레이트됩니다. JOIN으로 읽었든 별도 쿼리로 읽었든 외래 키 섀도 속성(`authorId`)과 `@ComputedColumn` 값까지 그대로 들어 있습니다.

조회가 로드하지 않은 관계는 엔티티에 아예 들어가지 않습니다. 직접 조회한 엔티티든 관계를 따라 읽은 엔티티든 같습니다. `null`은 관계를 로드했는데 관련 행이 없을 때만 씁니다. 그래서 관계를 일부만 로드한 엔티티를 그대로 다시 저장해도 나머지 관계의 외래 키는 비워지지 않습니다.

### 중첩 관계

관련 엔티티의 관계까지 로드하려면 점으로 이은 경로를 씁니다. 각 관계 아래에 같은 옵션을 다시 넣는 객체 형식을 써도 됩니다.

```typescript
// 글마다 댓글을, 댓글마다 작성자와 작성자의 팀을 함께 로드
const posts = await em.find(Post, {
  relations: ["comments.author.team", "tags"],
});

// 같은 조회를 객체 형식으로
const same = await em.find(Post, {
  relations: {
    comments: { relations: { author: { relations: ["team"] } } },
    tags: true,
  },
});
```

두 형식은 어느 단계에서든 섞어 써도 됩니다. `["comments", "comments.author"]`처럼 여러 항목에 같은 관계가 나와도 한 번만 로드합니다. `false`를 주면 그 관계는 빠집니다. 그래서 조건에 따라 객체를 조립할 때 편합니다.

단계별 로드 방식은 다음과 같습니다. 최상위 단계는 위에서 설명한 그대로입니다. to-one 관계는 메인 쿼리에 JOIN하고 컬렉션은 별도 쿼리로 읽습니다. 그 아래 단계는 행을 하이드레이트한 뒤 단계마다 관계 하나당 배치 `IN (...)` 쿼리 하나로 로드합니다. 부모가 몇 개든 쿼리 수는 같습니다.

```sql
-- 글 50개에 relations: ["comments.author"]
SELECT ... FROM "post";                                          -- 1. 글
SELECT ... FROM "comment" WHERE "post_id" IN (1, 2, ..., 50);    -- 2. 그 글들의 댓글
SELECT ... FROM "user" WHERE "id" IN (7, 9, 12);                 -- 3. 댓글 작성자(중복 제거)
```

댓글이 하나도 없는 경우처럼 로드할 것이 없는 단계가 있으면 그 아래 단계의 쿼리도 실행하지 않습니다.

중첩 단계도 최상위와 같은 규칙을 따릅니다. 소프트 삭제된 엔티티는 `withDeleted`를 넘기지 않으면 빠집니다. `tenant_column` 전략에서는 관련 엔티티마다 자기 테넌트 조건으로 범위를 좁힙니다. `find()`, `findOne()`, `findAndCount()`, `findWithPage()`, `findWithCursor()`, `stream()`, `explain()`은 모두 중첩 형식을 받습니다. 캐시된 조회는 중첩 단계가 읽는 테이블에 쓰기가 일어나도 무효화됩니다.

모든 이름은 그 이름이 적용되는 엔티티를 기준으로 검사합니다. 오타가 난 단계가 있으면 그 단계까지 온 경로와 함께 에러를 보고합니다.

```
InvalidQueryError: Unknown relation "autor" in "relations" for entity "Comment" (requested as "comments.autor").
Available relations: [post (ManyToOne), author (ManyToOne)]. Did you mean "author"?
```

> 참고: `eager: true`는 조회 대상 엔티티에만 적용됩니다. 중첩 단계에서 만나는 엔티티는 직접 이름을 지정한 관계만 로드합니다. 그래서 트리가 깊어져도 쿼리가 저절로 불어나지 않습니다.

### 관계 필터링, 정렬, 개수 제한

객체 형식에서 컬렉션 관계(`@OneToMany`, `@ManyToMany`)는 조회 자체와 같은 `where`와 `orderBy`를 받습니다. 그리고 `take`와 `skip`은 부모마다 따로 셉니다.

```typescript
// 글마다 승인된 댓글 중 점수가 높은 3개를, 댓글마다 작성자와 함께
const posts = await em.find(Post, {
  relations: {
    comments: {
      where: { approved: true },
      orderBy: { score: "DESC" },
      take: 3,
      relations: { author: true },
    },
  },
});
```

| 옵션 | 적용 대상 | 동작 |
|------|----------|------|
| `where` | 컬렉션 | 조건에 맞는 관련 행만 로드합니다. `OR` 배열을 포함해 조회 `where`의 연산자가 모두 동작합니다. 부모가 아니라 관계를 거르므로 승인된 댓글이 없는 글도 `comments: []`로 결과에 남습니다. |
| `orderBy` | 컬렉션 | 부모별 관련 행의 순서를 정합니다. |
| `take` / `skip` | 컬렉션 | 부모별 관련 행을 `orderBy` 순서로 잘라냅니다. `orderBy`가 없으면 관련 엔티티의 기본 키 순서를 씁니다. `take: 0`이면 쿼리 없이 빈 컬렉션을 넣습니다. |
| `withDeleted` | 모든 관계 | 이 관계에 한해 조회의 `withDeleted`를 덮어씁니다. `true`면 소프트 삭제된 행을 포함하고 `false`면 숨깁니다. 그 아래 중첩된 관계는 자기 설정을 따르고 자기 설정이 없으면 조회의 설정을 따릅니다. |

부모별 페이지네이션도 부모마다 쿼리를 보내지 않고 SQL 문 하나로 처리합니다. 배치 조회에서 윈도 함수로 부모별 순위를 매긴 뒤 요청한 범위만 남깁니다.

```sql
-- 글 50개에 comments: { orderBy: { score: "DESC" }, take: 3 }
SELECT * FROM (
  SELECT ..., "post_id" AS "__stg_o2m_fk",
         ROW_NUMBER() OVER (PARTITION BY "post_id" ORDER BY "score" DESC, "id" ASC) AS "__stg_rn"
  FROM "comment" WHERE "post_id" IN (1, 2, ..., 50) AND "deleted_at" IS NULL
) AS "__stg_paged"
WHERE "__stg_paged"."__stg_rn" > 0 AND "__stg_paged"."__stg_rn" <= 3
ORDER BY "__stg_paged"."__stg_o2m_fk", "__stg_paged"."__stg_rn";
```

윈도 함수는 MySQL 8.0+, MariaDB 10.2+, SQLite 3.25+에서 동작합니다. 지원하는 PostgreSQL 버전에는 모두 윈도 함수가 있습니다. 더 오래된 서버에서는 `take`와 `skip`이 모든 행을 읽는 대신 `UNSUPPORTED_OPERATION` 코드의 `OrmError`를 던집니다. 이 검사는 연결 시점에 감지한 서버 버전을 기준으로 합니다. 그래서 버전 감지에 실패하면 ORM은 지원한다고 가정하고 쿼리를 보냅니다. 이때 오래된 서버는 자체 문법 에러를 반환합니다. `where`와 `orderBy`는 어디서나 동작합니다.

페이지네이션은 부모별 행에 `orderBy` 순서로 순위를 매기고 그다음 관련 엔티티 기본 키의 모든 컬럼 순서로 매깁니다. 그래서 복합 키에서도 페이지가 안정적입니다. 배치 조회의 SQL 문 하나가 바인딩하는 부모 키는 SQLite에서 최대 900개이고 그 밖의 데이터베이스에서는 10,000개입니다. 그보다 큰 집합은 나눠 읽은 뒤 합칩니다. 그래서 컬렉션 아래에 컬렉션을 중첩해도 드라이버의 바인드 파라미터 한도를 넘지 않습니다.

옵션은 쿼리를 실행하기 전에 검사합니다. 관련 엔티티의 컬럼이 아닌 `where`나 `orderBy` 키는 `InvalidQueryError`를 던집니다. 단일 값 관계(`@ManyToOne`, `@OneToOne`)에 `where`, `orderBy`, `take`, `skip`을 주면 거부합니다. 그런 조건은 조회 자체에 거세요.

### 관계의 컬럼 고르기

관계 항목에 `select`를 적으면 관련 엔티티에서 그 컬럼만 읽습니다. 쓰는 법은 조회의 `select`와 같아서 배열 형식과 객체 형식을 모두 받습니다. 단일 값 관계를 포함해 관계 종류와 깊이에 상관없이 동작합니다.

```typescript
const posts = await em.find(Post, {
  relations: {
    author: { select: ["name"] },
    comments: { select: { body: true, score: true }, orderBy: { score: "DESC" }, take: 3 },
  },
});
// posts[0].author   → User { id: 7, name: "Alice" }
// posts[0].comments → [Comment { id: 31, body: "...", score: 12 }, ...]
```

```sql
SELECT "post"."id", "post"."title", ..., "author"."id" AS "author_id", "author"."name" AS "author_name"
FROM "post" LEFT JOIN "user" AS "author" ON "post"."author_id" = "author"."id";
SELECT "id", "body", "score_points", "post_id" AS "__stg_o2m_fk" FROM "comment" WHERE ...;
```

다만 아래 컬럼은 조회에 꼭 필요하므로 `select`에 없어도 읽습니다.

- 관련 엔티티의 기본 키: 이 키로 JOIN된 행과 없는 행을 구분합니다. 그 아래 중첩된 관계도 이 키로 짝짓습니다.
- 그 아래에서 로드하는 to-one 관계의 조인 컬럼: `author: { select: ["name"], relations: { team: true } }`는 작성자의 `team_id`도 읽습니다.
- 상속 계층의 구분 컬럼(discriminator column): 각 행을 알맞은 서브클래스로 만들 때 필요합니다.

이렇게 따로 읽은 컬럼도 반환된 객체에 들어 있습니다. 조회의 `select`에 `relations`가 붙어 기본 키를 함께 읽을 때와 같습니다. 관련 엔티티가 상속 계층의 루트라면 사정이 다릅니다. `TABLE_PER_CLASS` 루트는 UNION으로 읽으므로 컬럼을 전부 읽습니다. `JOINED` 루트는 서브클래스마다 그 서브클래스의 컬럼을 읽습니다. 그 엔티티를 직접 `find()`할 때와 같은 동작입니다.

`select`에는 관련 엔티티의 컬럼을 적습니다. 컬럼이 아닌 이름을 적거나 아무것도 적지 않으면 쿼리를 실행하기 전에 `InvalidQueryError`를 던집니다. 관련 엔티티의 관계까지 로드하려면 `relations` 아래에 중첩하고 거기에 따로 `select`를 적으면 됩니다.

결과 타입도 여기에 맞춰집니다. 깊이와 상관없이 관계의 타입에는 고른 속성과 관련 엔티티의 메서드만 남습니다. 선언에 있던 `null`은 그대로 유지됩니다. 지연 로딩 관계(`Promise` 타입)는 선언된 타입을 그대로 유지합니다.

```typescript
posts[0].author?.name;   // string
posts[0].author?.email;  // 컴파일 에러: 선택하지 않은 컬럼
```

### 관련 행 개수 세기 (withCount)

글마다 댓글 수를 보려고 댓글을 전부 로드할 필요는 없습니다. `withCount`는 컬렉션 관계(`@OneToMany`, `@ManyToMany`)가 가진 행의 개수를 조회 결과의 엔티티마다 써 넣습니다. 키는 개수를 담을 속성이고 값은 관계 이름입니다. 이 속성은 엔티티가 컬럼과 별도로 선언한 `number` 속성입니다. 일부 행만 세려면 `{ relation, where, withDeleted }`를 넘깁니다.

```typescript
@Entity()
export class Post {
  // ...컬럼과 관계...
  @OneToMany(() => Comment, { mappedBy: "post" })
  comments!: Comment[];

  commentCount?: number;   // 컬럼이 아닙니다. withCount가 값을 써 넣습니다
  approvedCount?: number;
}

const posts = await em.find(Post, {
  withCount: {
    commentCount: "comments",
    approvedCount: { relation: "comments", where: { approved: true } },
  },
});
posts[0].commentCount;   // 12: 댓글이 없는 글은 0
```

개수 하나는 글이 몇 개든 배치 SQL 문 하나로 셉니다.

```sql
SELECT "post_id" AS "__stg_count_key", COUNT(*) AS "__stg_count"
FROM "comment"
WHERE "post_id" IN (1, 2, ..., 50) AND "approved" = true AND "deleted_at" IS NULL
GROUP BY "post_id";
```

세는 행은 그 관계를 로드했을 때 붙을 행과 같습니다.

- 개수의 `where`를 따릅니다. `{ likes: { some: {} } }` 같은 관계 필터도 포함합니다.
- 개수나 조회의 `withDeleted`가 포함하라고 하지 않으면 소프트 삭제된 행은 빠집니다.
- `tenant_column`에서는 관련 엔티티의 테넌트 범위를 적용합니다.
- `SINGLE_TABLE` 자식에서는 그 서브타입의 행만 셉니다.

`ManyToMany`는 조인 테이블을 거쳐 셉니다.

`find()`, `findOne()`, `findAndCount()`, `findWithPage()`, `findWithCursor()`, `stream()`이 `withCount`를 받습니다. `relations` 안에 두면 관련 엔티티에 개수를 씁니다. 깊이와 상관없이 동작하고 단일 값 관계에서도 동작합니다.

```typescript
const users = await em.find(User, {
  withCount: { postCount: "posts" },
  relations: {
    posts: { withCount: { commentCount: "comments" } },
  },
});
users[0].posts[0].commentCount;
```

옵션은 쿼리를 실행하기 전에 검사합니다. 다음 경우에는 `InvalidQueryError`를 던집니다.

- 컬렉션이 아닌 관계
- 엔티티가 이미 컬럼이나 관계로 쓰는 속성
- 세는 엔티티의 컬럼이 아닌 `where` 키
- 기본 키가 여러 컬럼인 엔티티

개수는 기본 키로 엔티티와 짝짓습니다. 그래서 `select`에서 기본 키를 빼면 `relations`와 마찬가지로 기본 키를 추가합니다.

## 다음 단계

엔티티 사이의 관계를 설정했으면 이제 데이터를 다루는 여러 방법을 익힐 차례입니다.

- [EntityManager](./entity-manager.md): find, save, delete, 집계, 페이지네이션
- [쿼리 빌더](./query-builder.md): JOIN, GROUP BY 같은 복잡한 SQL이 필요할 때
- [트랜잭션](./transactions.md): 여러 작업을 하나로 묶어야 할 때
