# EntityManager -- 쓰기 & 트랜잭션

이 문서에서는 **배치 쓰기 연산**, **upsert**, **트랜잭션**, **Raw SQL 실행**을 다뤄요.

단일 엔티티 CRUD는 [CRUD 기본](./entity-manager.md)을, 조회 관련 기능은 [쿼리 & 페이지네이션](./entity-manager-querying.md)을 참고하세요.

---

## 배치 삽입 -- insertMany()

### insertMany()가 필요한 이유

유저 1,000명을 생성해야 한다고 생각해 보세요. `save()`를 루프로 호출하면 `INSERT` 문 1,000개, 네트워크 왕복 1,000번, 커밋 1,000번이 발생해요. 엄청 느려요.

`insertMany()`는 모든 행을 **하나의** `INSERT INTO ... VALUES (...), (...), (...)` 문으로 묶어서 보내요. 왕복 1번, 파싱 1번, 커밋 1번이에요. 실제 벤치마크에서 개별 삽입 대비 보통 10~50배 빨라요.

```typescript
await em.insertMany(User, [
  { name: "Alice", email: "alice@example.com" },
  { name: "Bob", email: "bob@example.com" },
  { name: "Charlie", email: "charlie@example.com" },
]);
```

ORM이 생성하는 SQL은 이래요:

```sql
-- PostgreSQL
INSERT INTO "user" ("name", "email")
VALUES ($1, $2), ($3, $4), ($5, $6)
-- Parameters: ['Alice', 'alice@example.com', 'Bob', 'bob@example.com', 'Charlie', 'charlie@example.com']

-- MySQL
INSERT INTO `user` (`name`, `email`)
VALUES (?, ?), (?, ?), (?, ?)
-- Parameters: ['Alice', 'alice@example.com', 'Bob', 'bob@example.com', 'Charlie', 'charlie@example.com']
```

주요 특징:
- **단일 SQL 문**으로 실행돼요 -- `save()` 루프보다 훨씬 효율적이에요.
- `@CreateTimestamp`, `@UpdateTimestamp` 컬럼이 자동으로 주입돼요.
- `@Version` 컬럼은 각 행마다 `1`로 초기화돼요.
- `{ affected: number }`를 반환해요 -- 삽입된 행을 돌려받아야 한다면 `insertManyAndReturn()`(PostgreSQL / SQLite) 또는 `saveMany()`(전 다이얼렉트)를 사용하세요.

---

## 배치 삽입 후 반환 -- insertManyAndReturn()

### insertManyAndReturn()가 필요한 이유

`insertMany()`는 빠르지만 `{ affected: number }`만 반환해요. 삽입된 행의 생성된 PK, 타임스탬프, DB 기본값이 채워진 엔티티 인스턴스가 필요하면서도 멀티 행 INSERT의 단일 문 효율을 그대로 유지하고 싶을 때 `insertManyAndReturn()`을 사용하세요.

내부적으로 ORM은 `INSERT INTO ... VALUES (...), (...), (...) RETURNING *` 문 하나를 실행하고, 결과 행을 ResultTransformer를 통해 역매핑해요. 컬럼 별칭과 NamingStrategy 매핑이 결과에 적용돼요.

```typescript
const users = await em.insertManyAndReturn(User, [
  { name: "Alice", email: "alice@example.com" },
  { name: "Bob", email: "bob@example.com" },
]);
// users[0].id => 1  (DB가 생성한 PK)
// users[1].id => 2
```

ORM이 생성하는 SQL은 이래요:

```sql
-- PostgreSQL
INSERT INTO "user" ("name", "email")
VALUES ($1, $2), ($3, $4)
RETURNING *
-- Parameters: ['Alice', 'alice@example.com', 'Bob', 'bob@example.com']

-- SQLite 3.35+
INSERT INTO "user" ("name", "email")
VALUES (?, ?), (?, ?)
RETURNING *
-- Parameters: ['Alice', 'alice@example.com', 'Bob', 'bob@example.com']
```

주요 특징:
- **단일 SQL 문**으로 실행돼요 -- `insertMany()`와 동일한 효율이에요.
- 결과 엔티티 인스턴스를 **입력 순서대로** 반환해요.
- `@CreateTimestamp`, `@UpdateTimestamp`, `@Version` 컬럼이 INSERT 전에 자동으로 주입돼요.
- `items`가 비어 있으면 DB를 전혀 건드리지 않고 즉시 `[]`를 반환해요.

**다이얼렉트 지원.** `insertManyAndReturn()`은 `INSERT ... RETURNING`이 필요해요. PostgreSQL과 SQLite 3.35+ 이상에서 사용할 수 있어요. MySQL에서 호출하면 `OrmError` (`UNSUPPORTED_DATABASE`)가 발생해요. MySQL에서는 `saveMany()`를 사용하세요.

```typescript
// MySQL에서는 OrmError (UNSUPPORTED_DATABASE) 발생
// await em.insertManyAndReturn(User, [{ name: "Alice" }]); // MySQL에서 사용 금지

// MySQL에서는 saveMany() 사용:
const users = await em.saveMany(User, [{ name: "Alice" }]);
```

### 배치 INSERT 방법 선택 가이드

| 메서드 | 지원 다이얼렉트 | SQL 문 수 | 반환값 |
|--------|----------------|-----------|--------|
| `insertMany()` | 전체 | 1 | `{ affected: number }` |
| `insertManyAndReturn()` | PostgreSQL, SQLite 3.35+ | 1 | 엔티티 인스턴스 배열 |
| `saveMany()` | 전체 | N (행당 1개) | 엔티티 인스턴스 배열 |

행을 돌려받을 필요가 없고 MySQL도 지원해야 한다면 `insertMany()`를 쓰세요. 행을 돌려받아야 하고 PostgreSQL 또는 SQLite를 대상으로 한다면 `insertManyAndReturn()`을 쓰세요. MySQL에서 행을 돌려받아야 하거나, 새 엔티티와 기존 엔티티가 섞인 배치(행마다 INSERT vs UPDATE)를 처리해야 한다면 `saveMany()`를 쓰세요.

---

## 배치 저장 -- saveMany()

### insertMany()가 있는데 왜 saveMany()가 필요할까요?

`insertMany()`는 빠르지만 새 행만 삽입할 수 있어요. `saveMany()`는 각 항목의 PK를 확인해서 INSERT와 UPDATE를 알아서 구분해요. 새 엔티티와 기존 엔티티가 섞여 있을 때 사용하세요.

```typescript
const users = await em.saveMany(User, [
  { name: "New User", email: "new@example.com" },           // No PK -> INSERT
  { id: 2, name: "Updated User", email: "upd@example.com" }, // Has PK -> UPDATE
]);
// Returns the saved entities with generated PKs
```

내부적으로 `saveMany()`는 모든 연산을 단일 트랜잭션으로 감싸고 각 항목을 하나씩 처리해요. 위 예시의 SQL 타임라인은 이래요:

```sql
-- Step 1: BEGIN transaction
BEGIN

-- Step 2: First item has no PK -> INSERT
-- PostgreSQL
INSERT INTO "user" ("name", "email") VALUES ($1, $2) RETURNING *
-- Parameters: ['New User', 'new@example.com']

-- Step 3: Second item has PK -> UPDATE
-- PostgreSQL
UPDATE "user" SET "name" = $1, "email" = $2 WHERE "id" = $3 RETURNING *
-- Parameters: ['Updated User', 'upd@example.com', 2]

-- Step 4: COMMIT
COMMIT
```

트레이드오프는 명확해요: `saveMany()`는 항목당 쿼리 하나를 보내서 순수 삽입에서는 느리지만, `insertMany()`가 처리할 수 없는 생성/수정 혼합 시나리오를 다룰 수 있어요.

---

## INSERT에서 undefined vs null -- DB 기본값 살리기

### 왜 구분이 중요할까요?

`save()`와 `saveMany()`는 `undefined`를 "**값을 안 줬다**"로 해석해요 (TypeORM/knex와 같은 의미론이에요). 엔티티 값이 `undefined`인 컬럼은 **INSERT 컬럼 목록에서 빠지고**, 그 자리는 DB 쪽 `DEFAULT` 절 -- `@Column({ default })` 포함 -- 이 채워요. 명시적인 `null`은 달라요: 컬럼이 포함되고 `NULL`이 기록돼요.

```typescript
@Entity()
class Article {
  @PrimaryGeneratedColumn() id!: number;
  @Column() title!: string;
  @Column({ default: "draft" }) status!: string;
  @Column({ nullable: true }) summary?: string;
}

const a = await em.save(Article, { title: "Hello" });
// INSERT INTO "article" ("title") VALUES ($1)
// -> "status"는 생략되고 DB DEFAULT 'draft'가 적용됨
a.status; // "draft"

await em.save(Article, { title: "Hello", summary: null });
// INSERT INTO "article" ("title", "summary") VALUES ($1, $2)
// -> "summary"는 포함되고 명시적으로 NULL을 기록
```

자동 주입 컬럼은 예외예요. `@CreateTimestamp`, `@UpdateTimestamp`, `@Version`, 클라이언트 측 UUID 생성 전략은 값이 `undefined`라도 여전히 포함되고 자동으로 채워져요.

모든 컬럼이 생략되면 ORM은 다이얼렉트별 "전부 기본값" INSERT 폼을 내보내요:

```sql
-- MySQL / MariaDB
INSERT INTO `t` () VALUES ()

-- PostgreSQL / SQLite
INSERT INTO "t" DEFAULT VALUES
```

`saveMany()` 배치 삽입에서는 멀티 행 `VALUES`가 컬럼 목록 하나를 공유해요. 그래서 컬럼은 **배치의 어떤 항목도 값을 주지 않았을 때만** 생략돼요. 일부 항목만 값을 준 혼합 배치에서는 컬럼이 목록에 남고, 값이 없는 행에는 `NULL`이 바인딩돼요.

---

## RETURNING 결과는 프로퍼티 이름으로 돌아와요

RETURNING을 지원하는 드라이버(PostgreSQL, MariaDB 10.5+)에서 `save()`의 반환 엔티티는 `RETURNING *` 행으로 만들어져요. 이제 이 행이 ResultTransformer를 거치면서 DB 컬럼명이 **엔티티 프로퍼티 키**로 역매핑돼요 -- `@Column({ name })`과 `SnakeNamingStrategy` 같은 NamingStrategy 매핑을 모두 포함해서요. 컬럼 트랜스포머의 `from`도 함께 적용돼요.

```typescript
@Entity()
class Category {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ name: "LFT_NO" }) left!: number;
}

const saved = await em.save(Category, { left: 1 });
saved.left;             // 1 -- 클래스에 선언한 프로퍼티 키 그대로
(saved as any).LFT_NO;  // undefined -- raw DB 키가 더 이상 새어 나오지 않음
```

이전에는 반환 객체가 raw DB 키(예: `left` 대신 `LFT_NO`)를 그대로 노출했어요. 이 매핑은 INSERT RETURNING, UPDATE RETURNING, `saveMany()` 배치 RETURNING에 모두 적용돼요.

---

## 배치 삭제 -- deleteMany()

### 왜 delete()를 여러 번 호출하는 대신 deleteMany()를 쓸까요?

`insertMany()`가 `save()` 루프보다 빠른 것과 같은 이유예요. SQL 문 하나가 여러 개보다 나아요. `deleteMany()`는 PK 값 배열을 받아서 단일 `DELETE ... WHERE id IN (...)` 문을 생성해요.

```typescript
const result = await em.deleteMany(User, [1, 2, 3]);
console.log(result.affected); // 3
```

```sql
-- PostgreSQL
DELETE FROM "user" WHERE "id" IN ($1, $2, $3)
-- Parameters: [1, 2, 3]

-- MySQL
DELETE FROM `user` WHERE `id` IN (?, ?, ?)
-- Parameters: [1, 2, 3]
```

::: tip
PK가 아닌 조건으로 삭제하려면 WHERE 절과 함께 `delete()`를 사용하세요:
```typescript
await em.delete(User, { isActive: false });
```
:::

### delete() / softDelete() / restore()의 연산자 조건

criteria 객체는 동등 비교에 묶여 있지 않아요. `delete()`, `softDelete()`, `restore()`는 조회의 `where`와 똑같은 find 스타일 연산자 객체 -- `{ between: [a, b] }`, `{ gt }`, `{ gte }`, `{ lt }`, `{ lte }`, `{ in }`, `{ like }` 등 -- 를 받고, `null`은 `IS NULL`로 해석돼요. 조회 경로와 동일한 WhereResolver가 처리해요 (`updateMany()`는 원래부터 지원했어요).

```typescript
// 중첩 집합(nested set) 서브트리 전체를 문장 하나로 삭제
await em.delete(Category, { lft: { between: [node.lft, node.rgt] } });

// 오래된 초안 소프트 삭제
await em.softDelete(Post, { status: "draft", updatedAt: { lt: cutoff } });

// null -> IS NULL
await em.delete(Session, { userId: null });
```

빈 criteria는 여전히 `DeleteWithoutConditionsError`를 던져요 -- 테이블 전체 삭제를 막는 가드는 그대로예요.

---

## 조건부 수정 -- update()

### update()가 필요한 이유

`updateMany()`는 강력하지만, "필터에 맞는 행을 바꾼다"는 가장 흔한 경우엔 장황해요. 필터를 옵션 객체(`{ where: ... }`) 안에 넣어야 해서, 필터가 그냥 두 번째 인자인 `delete(entity, criteria)`와 모양이 달라요. `update()`는 그 간극을 메우는 **필터 우선** 단축형이에요:

```typescript
// update(entity, where, data) -- 필터가 delete()처럼 두 번째 인자
await em.update(User, { id: 1 }, { name: "Alice" });

// raw SQL 표현식도 그대로 SET 절로 전달돼요
await em.update(Post, { id: 1 }, { viewCount: sql`view_count + 1` });
```

내부적으로 `updateMany()`에 위임하므로 모든 안전장치를 그대로 상속해요: 빈 `WHERE` 가드(테이블 전체 수정 거부), 테넌트 스코핑, `@UpdateTimestamp` 자동 주입, NamingStrategy 컬럼 매핑, `Sql` 표현식 지원까지요. 반환값도 동일하게 `{ affected }`예요.

정렬·개수 제한 수정(`orderBy` + `limit`)이 필요할 때만 `updateMany()`를 직접 쓰면 돼요. 그 외에는 `update()`가 더 짧고 일관된 호출이에요. 리포지토리에서도 `repo.update(where, data)`로 쓸 수 있어요.

---

## 일괄 수정 -- updateMany()

### updateMany()가 필요한 이유

동일한 변경을 수천 행에 적용해야 할 때가 있어요 -- 만료된 계정 비활성화, 카테고리 가격 일괄 인상, 플래그 초기화 같은 경우요. `save()`로 하면 각 행을 조회하고, 수정하고, 다시 저장해야 해요. `updateMany()`는 단일 `UPDATE ... SET ... WHERE ...`로 한 번에 처리해요.

```typescript
const result = await em.updateMany(User,
  { isActive: false },            // SET -- 적용할 데이터
  { where: { lastLoginAt: null } }, // WHERE -- 매칭 조건
);
console.log(result.affected); // number of updated rows
```

```sql
-- PostgreSQL
UPDATE "user"
SET "isActive" = $1
WHERE "lastLoginAt" IS NULL
-- Parameters: [false]

-- MySQL
UPDATE `user`
SET `isActive` = ?
WHERE `lastLoginAt` IS NULL
-- Parameters: [false]
```

좀 더 현실적인 예시 -- 최근 로그인하지 않은 유저 비활성화:

```typescript
const result = await em.updateMany(User,
  { isActive: false, deactivatedAt: new Date() },
  { where: { isActive: true } },
);
console.log(`Deactivated ${result.affected} users`);
```

```sql
-- PostgreSQL
UPDATE "user"
SET "isActive" = $1, "deactivatedAt" = $2, "updatedAt" = $3
WHERE "isActive" = $4
-- Parameters: [false, '2026-03-22 12:00:00', '2026-03-22 12:00:00', true]
```

SET 절에 `"updatedAt"` 컬럼이 자동으로 포함된 게 보이죠 -- ORM이 일괄 수정에서도 `@UpdateTimestamp` 컬럼을 자동 주입해요.

### soft-delete된 행은 기본적으로 제외됩니다

엔티티에 `@DeletedAt` 컬럼이 있으면 `updateMany()`는 (그리고 여기에 위임하는 `update()` / `increment()` / `decrement()`도) **살아 있는** 행만 건드립니다. `find()`와 똑같이 `WHERE`에 `"deletedAt" IS NULL`을 덧붙이므로, 일괄 수정이 논리적으로 삭제된 행의 데이터를 몰래 되살리는 일이 없어요.

trash된 행까지 포함하려면 `withDeleted: true`를 넘깁니다.

```typescript
// 기본: trash된 행은 그대로 둡니다
await em.updateMany(User, { plan: "free" }, { where: { plan: "pro" } });

// 명시적 opt-in: soft-delete된 행도 수정합니다
await em.updateMany(
  User,
  { plan: "free" },
  { where: { plan: "pro" }, withDeleted: true },
);
```

```sql
-- 기본 -- PostgreSQL
UPDATE "user" SET "plan" = $1 WHERE "plan" = $2 AND "deletedAt" IS NULL

-- withDeleted: true -- soft-delete 술어가 빠집니다
UPDATE "user" SET "plan" = $1 WHERE "plan" = $2
```

단일 테이블 상속(STI) 자식 클래스라면 `updateMany()`가 discriminator 술어까지 덧붙이므로, `updateMany(CreditCardPayment, …)`가 같은 테이블을 공유하는 형제 타입을 건드리지 않아요 -- `find()`·`delete()`가 따르는 규칙 그대로입니다.

### updateMany에서 SQL 표현식 사용

가끔 계산된 업데이트가 필요할 때가 있어요 -- 카운터 증가, 문자열 추가, 데이터베이스 함수 사용 등. `updateMany`는 `sql-template-tag`를 통해 raw SQL 표현식을 컬럼 값으로 받을 수 있어요:

```typescript
import sql from "sql-template-tag";

// 조회수 증가
await em.updateMany(Post,
  { viewCount: sql`"viewCount" + 1` },
  { where: { id: 1 } },
);
```

```sql
-- PostgreSQL
UPDATE "post"
SET "viewCount" = "viewCount" + 1
WHERE "id" = $1
-- Parameters: [1]
```

리터럴 값과 SQL 표현식을 같은 업데이트에서 혼합할 수도 있어요:

```typescript
await em.updateMany(Product,
  {
    price: sql`"price" * 1.1`,         // 10% 가격 인상
    lastUpdatedBy: "admin",             // 리터럴 값
  },
  { where: { category: "electronics" } },
);
```

주요 특징:
- `@UpdateTimestamp` 컬럼이 SET 절에 자동 주입돼요.
- **빈 WHERE 조건은** `DeleteWithoutConditionsError`를 던져요 (안전 장치).
- `save()`와 달리 엔티티 라이프사이클 훅이나 이벤트가 발생하지 않아요 -- raw 일괄 연산이에요.

::: danger
파라미터 순서가 `(Entity, setData, { where })` 예요 -- `(Entity, where, setData)`가 아니에요. **설정할 데이터**가 먼저 와요.
:::

---

## 원자적 증감 -- increment() / decrement()

### 왜 필요할까요?

`update()`와 `updateMany()` 모두 raw SQL 표현식으로 카운터를 증가시킬 수 있어요:

```typescript
import sql from "sql-template-tag";
await em.update(Post, { id: 1 }, { viewCount: sql`view_count + 1` });
```

동작은 하지만 `sql-template-tag`를 임포트하고, 실제 DB 컬럼명을 알아야 하고, 올바른 SQL 표현식을 직접 써야 해요. `increment()`는 안전한 단축형이에요: 엔티티 속성명을 올바르게 이스케이프된 컬럼으로 변환하고, `by`를 파라미터로 바인딩하며(문자열 연결 없음), `update()`에 위임하므로 모든 안전장치를 그대로 가져와요.

### 사용법

```typescript
// viewCount에 1 더하기 (by 기본값 1)
await em.increment(Post, { id: 1 }, "viewCount");

// balance에 50 더하기
await em.increment(Wallet, { userId: 7 }, "balance", 50);

// stock에서 1 빼기
await em.decrement(Product, { id: 9 }, "stock");

// balance에서 100 빼기
await em.decrement(Wallet, { userId: 7 }, "balance", 100);
```

각 호출은 단일 `UPDATE` 문을 발행해요:

```sql
-- PostgreSQL (viewCount += 1)
UPDATE "post"
SET "viewCount" = "viewCount" + $1, "updatedAt" = $2, "version" = "version" + 1
WHERE "id" = $3
-- Parameters: [1, '2026-06-13 10:00:00', 1]

-- MySQL (stock -= 1)
UPDATE `product`
SET `stock` = `stock` - ?, `updatedAt` = ?
WHERE `id` = ?
-- Parameters: [1, '2026-06-13 10:00:00', 9]
```

### 시그니처

```typescript
// EntityManager
em.increment<T>(entity: Class<T>, where: WhereClause<T>, column: keyof T & string, by?: number): Promise<{ affected: number }>
em.decrement<T>(entity: Class<T>, where: WhereClause<T>, column: keyof T & string, by?: number): Promise<{ affected: number }>

// BaseRepository (엔티티가 이미 바인딩됨 -- 첫 인자 없음)
repo.increment(where: WhereClause<T>, column: keyof T & string, by?: number): Promise<{ affected: number }>
repo.decrement(where: WhereClause<T>, column: keyof T & string, by?: number): Promise<{ affected: number }>
```

### 동작 방식

- **원자적** -- 델타가 데이터베이스에서 `SET col = col + ?` 형태로 적용돼요. 두 개의 동시 호출도 올바른 합산 결과를 냅니다. 읽기-수정-쓰기 레이스 컨디션이 없어요.
- **`update()`에 위임** -- 빈 `WHERE` 가드(`where`가 비어 있으면 `DeleteWithoutConditionsError` 발생), 테넌트 스코핑, NamingStrategy 컬럼 매핑, `@UpdateTimestamp` 자동 주입을 모두 상속해요. 엔티티에 `@Version` 낙관적 잠금 컬럼이 있으면 같은 문에서 함께 증가시켜요.
- **`by` 기본값은 `1`** -- `0`, `NaN`, `Infinity` 또는 유한하지 않은 숫자를 전달하면 `InvalidQueryError`를 던져요.
- **`{ affected }` 반환** -- 데이터베이스 드라이버가 보고한 수정 행 수예요.

### 리포지토리 단축형

```typescript
const postRepo = em.getRepository(Post);

// em.increment(Post, { id: 1 }, "viewCount")와 동일
await postRepo.increment({ id: 1 }, "viewCount");

const productRepo = em.getRepository(Product);
// em.decrement(Product, { id: 9 }, "stock")와 동일
await productRepo.decrement({ id: 9 }, "stock");
```

---

## Upsert -- 삽입 또는 수정

### 왜 upsert가 필요할까요?

"로그인 추적" 기능을 생각해 보세요: 유저가 로그인할 때마다 레코드를 새로 만들거나 기존 레코드를 업데이트하고 싶어요. upsert 없이는 이렇게 해야 해요:

1. `findOne()` -- 레코드 존재 여부 확인
2. 있으면: PK와 함께 `save()`로 UPDATE
3. 없으면: PK 없이 `save()`로 INSERT

왕복 3번에 레이스 컨디션까지 있어요 (두 요청이 동시에 "없음"을 확인하고 둘 다 INSERT를 시도하면 중복 키 에러가 나요). upsert는 단일 원자적 문으로 두 문제를 모두 해결해요.

### PK 기준

```typescript
await em.upsert(User, {
  id: 1,
  name: "Alice",
  email: "alice@example.com",
});
// If id=1 exists -> UPDATE name and email
// If id=1 doesn't exist -> INSERT new row
```

```sql
-- PostgreSQL
INSERT INTO "user" ("id", "name", "email")
VALUES ($1, $2, $3)
ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name", "email" = EXCLUDED."email"
-- Parameters: [1, 'Alice', 'alice@example.com']

-- MySQL
INSERT INTO `user` (`id`, `name`, `email`)
VALUES (?, ?, ?)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`), `email` = VALUES(`email`)
-- Parameters: [1, 'Alice', 'alice@example.com']
```

핵심은 `ON CONFLICT ... DO UPDATE` (PostgreSQL) 또는 `ON DUPLICATE KEY UPDATE` (MySQL)예요. 둘 다 "삽입을 시도하되, 지정된 컬럼에서 충돌이 나면 기존 행을 대신 업데이트하라"는 뜻이에요.

### 유니크 컬럼 기준

세 번째 인자로 컬럼 이름 배열을 전달해서 충돌 대상을 지정할 수 있어요:

```typescript
await em.upsert(User, {
  email: "alice@example.com",
  name: "Alice",
  lastLoginAt: new Date(),
}, ["email"]);
// If a row with this email exists -> UPDATE name and lastLoginAt
// If no row with this email -> INSERT
```

```sql
-- PostgreSQL
INSERT INTO "user" ("email", "name", "lastLoginAt")
VALUES ($1, $2, $3)
ON CONFLICT ("email") DO UPDATE SET "name" = EXCLUDED."name", "lastLoginAt" = EXCLUDED."lastLoginAt"
-- Parameters: ['alice@example.com', 'Alice', '2026-03-22 12:00:00']

-- MySQL
INSERT INTO `user` (`email`, `name`, `lastLoginAt`)
VALUES (?, ?, ?)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`), `lastLoginAt` = VALUES(`lastLoginAt`)
-- Parameters: ['alice@example.com', 'Alice', '2026-03-22 12:00:00']
```

### 충돌 감지 방식

"충돌 컬럼"은 데이터베이스에게 어떤 유니크 제약 조건을 확인할지 알려줘요. `["email"]`을 지정하면, 삽입하려는 값과 `email`이 일치하는 기존 행을 찾아요. 있으면 해당 행을 업데이트하고, 없으면 새 행을 삽입해요.

::: info
충돌 컬럼(세 번째 인자)에는 유니크 제약 조건이 있거나 PK여야 해요. 그렇지 않으면 데이터베이스가 쿼리를 거부해요. PostgreSQL에서는 `there is no unique or exclusion constraint matching the ON CONFLICT specification` 에러가 발생해요.
:::

### 배치 Upsert -- batchUpsert()

수백 또는 수천 행을 한 번에 upsert해야 할 때 `batchUpsert()`가 `upsert()`를 루프로 호출하는 것보다 훨씬 빨라요. 모든 행을 하나의 다중 행 `INSERT ... ON CONFLICT` 문으로 묶어서 보내요.

```typescript
await em.batchUpsert(User, [
  { email: "alice@example.com", name: "Alice", loginCount: 1 },
  { email: "bob@example.com", name: "Bob", loginCount: 1 },
  { email: "charlie@example.com", name: "Charlie", loginCount: 1 },
], ["email"]);
```

```sql
-- PostgreSQL
INSERT INTO "user" ("email", "name", "loginCount")
VALUES ($1, $2, $3), ($4, $5, $6), ($7, $8, $9)
ON CONFLICT ("email") DO UPDATE SET "name" = EXCLUDED."name", "loginCount" = EXCLUDED."loginCount"

-- MySQL
INSERT INTO `user` (`email`, `name`, `loginCount`)
VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`), `loginCount` = VALUES(`loginCount`)
```

세 번째 인자(옵션)로 충돌 컬럼을 지정해요. 생략하면 기본 키가 사용돼요.

### 반환값 — `{ affected: number }`

`upsert()`와 `batchUpsert()` 모두 `Promise<{ affected: number }>`를 반환합니다.

```typescript
const result = await em.upsert(User, { id: 1, name: "Alice" });
console.log(result.affected); // MySQL: INSERT면 1, UPDATE면 2 / PostgreSQL·SQLite: 1
```

`affected` 값은 **드라이버 원본 그대로** 반환됩니다 — 정규화 없음.

| 드라이버 | INSERT | UPDATE | 변경 없음 |
|---------|--------|--------|---------|
| MySQL | 1 | 2 | 0 |
| PostgreSQL | 1 | 1 | 1 |
| SQLite | 1 | 1 | 1 |

MySQL은 `ON DUPLICATE KEY UPDATE`의 `affectedRows`를 씁니다. 내부적으로 행을 삭제하고 재삽입하는 방식이라 update를 2로 세어요. PostgreSQL과 SQLite는 insert·update 모두 1을 반환합니다. 변경 여부만 알면 충분하다면 `result.affected > 0`으로 판단하면 돼요.

`batchUpsert()`는 `items` 배열이 비어 있으면 `{ affected: 0 }`을 반환합니다.

리포지토리에서는 `userRepo.batchUpsert(items, conflictColumns)`로 동일하게 사용할 수 있어요.

---

## 트랜잭션

### 왜 트랜잭션이 필요할까요?

EntityManager의 개별 연산(`save`, `find`, `delete` 등)은 자동으로 각각의 트랜잭션으로 감싸져요. 하지만 두 연산이 **반드시 함께** 성공하거나 실패해야 할 때는 어떻게 할까요?

이커머스 결제를 생각해 보세요: 주문을 생성하고 재고를 차감해요. 주문 생성은 성공했는데 재고 차감이 실패하면, "아직 구매 가능"한 상품에 대한 주문이 남게 돼요 -- 데이터 불일치예요. 트랜잭션은 연산을 원자적 단위로 묶어서 해결해요: 모두 커밋되거나, 모두 롤백돼요.

### 콜백 API -- transaction()

트랜잭션을 사용하는 가장 간단한 방법이에요. 콜백이 `this` EntityManager를 받고, 내부의 모든 연산이 같은 트랜잭션을 공유해요.

```typescript
const order = await em.transaction(async (txEm) => {
  const order = await txEm.save(Order, {
    userId: 1,
    status: "pending",
  });

  await txEm.insertMany(OrderItem, [
    { orderId: order.id, productId: 10, quantity: 2 },
    { orderId: order.id, productId: 20, quantity: 1 },
  ]);

  return order;
  // COMMIT on success
});
// If any operation throws -> ROLLBACK automatically
```

이 트랜잭션의 정확한 SQL 타임라인이에요:

```sql
-- 1. Open a connection and start the transaction
BEGIN

-- 2. Insert the order
INSERT INTO "order" ("userId", "status") VALUES ($1, $2) RETURNING *
-- Parameters: [1, 'pending']

-- 3. Insert order items (single multi-row statement)
INSERT INTO "order_item" ("orderId", "productId", "quantity")
VALUES ($1, $2, $3), ($4, $5, $6)
-- Parameters: [1, 10, 2, 1, 20, 1]

-- 4a. If everything succeeded:
COMMIT

-- 4b. If any query threw an error:
ROLLBACK
```

`BEGIN`과 `COMMIT`/`ROLLBACK`은 자동으로 처리돼요. 직접 작성할 필요 없어요.

### 에러 발생 시 동작

콜백 내부에서 예외가 발생하면, ORM이:

1. 예외를 잡아요
2. `ROLLBACK`을 실행해서 트랜잭션 내 모든 변경을 되돌려요
3. 원래 예외를 다시 던져서 애플리케이션 코드에서 처리할 수 있게 해요

데이터베이스가 절반만 완료된 상태로 남는 일은 없어요. 모든 변경이 적용되거나, 아무것도 적용되지 않아요.

### 데드락 재시도

동시성이 높은 시나리오(여러 유저가 같은 상품을 구매하는 경우 등)에서는 데드락이 발생할 수 있어요. 데드락은 두 트랜잭션이 서로 잠금 해제를 기다리면서 둘 다 진행하지 못하는 상태예요. 데이터베이스가 이를 감지하고 하나를 종료해요.

`transaction()` 메서드는 자동 재시도를 지원해요:

```typescript
await em.transaction(async (txEm) => {
  const stock = await txEm.findOne(Inventory, {
    where: { productId: 42 },
    lock: LockMode.PESSIMISTIC_WRITE,
  });

  if (stock.quantity < 1) {
    throw new Error("Out of stock");
  }

  stock.quantity -= 1;
  await txEm.save(Inventory, stock);
}, {
  retryOnDeadlock: true,  // Enable deadlock retry
  maxRetries: 3,          // Maximum attempts (default: 3)
  retryDelayMs: 100,      // Delay between retries in ms (default: 100)
});
```

ORM은 다이얼렉트별로 데드락 에러를 감지해요:
- **MySQL**: `errno 1213` (ER_LOCK_DEADLOCK)
- **PostgreSQL**: `code 40P01` (deadlock_detected)
- **SQLite**: `SQLITE_BUSY` / "database is locked"

데드락이 감지되면 콜백 전체가 처음부터 다시 실행돼요. **콜백은 멱등(idempotent)해야 해요** -- 안전하게 반복할 수 없는 데이터베이스 외부 부수 효과(이메일 발송 등)가 없어야 해요.

### 데코레이터 기반 트랜잭션

NestJS 서비스에서는 콜백 API 대신 `@Transactional()` 데코레이터를 사용할 수 있어요. 데코레이터 사용법, 격리 수준, savepoint에 대한 자세한 내용은 [트랜잭션](./transactions.md)을 참고하세요.

---

## Raw SQL -- query()

### 왜 Raw SQL이 필요할까요?

EntityManager API가 데이터베이스 상호작용의 90%를 커버해요. 하지만 가끔 API가 제공하지 않는 기능이 필요해요: 윈도우 함수, CTE(Common Table Expressions), DB 전용 구문, 또는 raw SQL로 작성하는 게 더 읽기 쉬운 복잡한 조인 같은 거요.

`query()`는 ORM의 커넥션 관리, 트랜잭션 처리, 파라미터 바인딩의 이점을 누리면서 어떤 SQL이든 실행할 수 있는 탈출구예요.

### sql-template-tag 사용 (권장)

```typescript
import sql from "sql-template-tag";

const users = await em.query<{ id: number; name: string }>(
  sql`SELECT * FROM "user" WHERE "age" > ${18} AND "city" = ${"Seoul"}`
);
```

문자열 보간처럼 보이지만 아니에요. `sql-template-tag`의 `sql` 템플릿 태그가 쿼리 텍스트와 파라미터 값을 자동으로 분리해요. 실제로 데이터베이스에 전송되는 내용은 이래요:

```sql
-- Query text (sent to database)
SELECT * FROM "user" WHERE "age" > $1 AND "city" = $2
-- Parameters (sent separately): [18, 'Seoul']
```

데이터베이스가 쿼리 구조와 값을 별도로 받아요. `'; DROP TABLE user; --` 같은 악의적인 값도 리터럴 문자열로 처리되지, SQL 코드로 실행되지 않아요. 이걸 **파라미터화된 쿼리(parameterized queries)**라고 하고, SQL injection에 대한 주요 방어 수단이에요.

### 문자열 + 파라미터 배열 사용

```typescript
const posts = await em.query<{ id: number; title: string }>(
  "SELECT id, title FROM post WHERE author_id = $1",
  [42]
);
```

```sql
-- Query text
SELECT id, title FROM post WHERE author_id = $1
-- Parameters: [42]
```

::: warning
Raw SQL 문자열을 사용할 때는 **반드시 파라미터 바인딩**(`$1`, `?` 등)을 사용하세요. 유저 입력을 문자열에 직접 연결하면 안 돼요.
:::

### 반환 타입

`query<T>()`는 `T[]`를 반환해요. 제네릭 파라미터 `T`로 결과 행의 타입을 지정할 수 있어요:

```typescript
interface MonthlyStats {
  month: string;
  total_orders: number;
  revenue: number;
}

const stats = await em.query<MonthlyStats>(sql`
  SELECT
    TO_CHAR("created_at", 'YYYY-MM') AS month,
    COUNT(*) AS total_orders,
    SUM("amount") AS revenue
  FROM "order"
  WHERE "created_at" >= ${startDate}
  GROUP BY TO_CHAR("created_at", 'YYYY-MM')
  ORDER BY month DESC
`);
```

```sql
-- PostgreSQL
SELECT
  TO_CHAR("created_at", 'YYYY-MM') AS month,
  COUNT(*) AS total_orders,
  SUM("amount") AS revenue
FROM "order"
WHERE "created_at" >= $1
GROUP BY TO_CHAR("created_at", 'YYYY-MM')
ORDER BY month DESC
-- Parameters: [startDate]
```

`T[]` 반환 타입은 런타임에서 검증하지 않아요 -- 타입 어노테이션을 신뢰해요. SQL이 인터페이스와 일치하지 않는 컬럼을 반환해도 TypeScript가 컴파일 타임에 잡지 못해요. 제네릭 파라미터는 런타임 보장이 아닌, 팀을 위한 문서로 생각하세요.

CTE, UNION, 윈도우 함수, 서브쿼리에 대한 전체 가이드는 [Raw SQL & CTE](./raw-sql.md)를 참고하세요.

---

## 다음 단계

- **[CRUD 기본](./entity-manager.md)** -- save, find, delete, soft delete
- **[쿼리 & 페이지네이션](./entity-manager-querying.md)** -- SELECT, 페이지네이션, 스트리밍, 집계
- **[고급 기능](./entity-manager-advanced.md)** -- 이벤트, subscriber, 멀티테넌시, 플러그인, FindOption 레퍼런스
