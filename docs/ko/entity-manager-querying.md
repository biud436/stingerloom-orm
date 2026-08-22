# EntityManager -- 조회 & 페이지네이션

이 장은 EntityManager로 **데이터를 읽는** 쪽을 다룹니다. 컬럼 고르기, 정렬, 필터, 페이지네이션 전략, 집계, 쿼리 분석까지.

기본 CRUD는 [CRUD 기초](./entity-manager.md), 쓰기와 트랜잭션은 [쓰기 & 트랜잭션](./entity-manager-writes.md)에 나뉘어 있어요.

---

## 쿼리가 어떻게 돌아가는지부터

각 기능을 뜯어보기 전에, `em.find()` 한 줄을 호출했을 때 내부에서 어떤 일이 벌어지는지 먼저 그려 두면 이해가 빨라져요.

ORM이 존재하는 이유는 딱 하나입니다. **개발자는 객체로 생각하고, DB는 테이블로 생각한다**는 이 간극을 메우기 위해서예요. `em.find(User, { where: { name: "Alice" } })`를 쓰면, ORM이 이 객체 기반 요청을 SQL로 바꾸고, DB로 보낸 뒤, 결과 행을 다시 TypeScript 객체로 되돌려 줍니다.

전체 라이프사이클은 이렇게 돼요:

```
Your code                    ORM internals                    Database
─────────                    ─────────────                    ────────
em.find(User, {        →     Build SQL string           →     SELECT "id", "name", "email"
  where: { name: "Alice" }   using sql-template-tag           FROM "user"
})                           (all values parameterized)       WHERE "name" = $1
                                                              ── parameters: ['Alice']

                       ←     Deserialize rows            ←    Returns rows:
User[] objects               into User class instances         [{ id: 1, name: 'Alice', ... }]
```

두 가지를 눈여겨볼 만합니다.

1. **값이 SQL 문자열에 직접 이어붙지 않습니다.** `"Alice"`는 파라미터 플레이스홀더(PostgreSQL은 `$1`, MySQL은 `?`)로 들어가요. DB 단에서 "코드"와 "데이터"를 분리해서 처리하기 때문에, 이 구조 자체가 SQL 인젝션을 막아 줍니다.

2. **테이블·컬럼명은 드라이버마다 다른 방식으로 감쌉니다.** PostgreSQL은 큰따옴표(`"user"`), MySQL은 백틱(`` `user` ``). ORM이 현재 드라이버에 맞춰 알아서 처리하니 호출하는 쪽에서는 신경 쓸 필요가 없어요.

아래에서 소개하는 모든 기능은 결국 "어떤 SQL을 만들어 낼지"를 제어하는 수단입니다. 예제마다 실제로 나가는 SQL을 함께 보여 드릴게요.

---

## SELECT 특정 컬럼

기본값으로 `find()`와 `findOne()`은 모든 컬럼을 가져옵니다 — `SELECT *`와 같아요. 편하지만, 몇 개만 필요할 땐 낭비입니다. `User`에 컬럼이 20개인데 API가 `id`와 `name`만 돌려준다면, 매 행마다 쓸모없는 컬럼 18개가 네트워크를 타고 넘어오는 셈이죠.

`select` 옵션으로 가져올 컬럼을 정확히 지정할 수 있어요.

### 배열 방식

```typescript
const users = await em.find(User, {
  select: ["id", "name", "email"],
});
```

생성되는 SQL (PostgreSQL):
```sql
SELECT "id", "name", "email" FROM "user"
```

생성되는 SQL (MySQL):
```sql
SELECT `id`, `name`, `email` FROM `user`
```

### 객체 방식

```typescript
const users = await em.find(User, {
  select: { id: true, name: true, email: true },
});
```

생성되는 SQL은 완전히 동일해요. 컬럼이 많을 때 객체 방식이 더 읽기 편하다고 느끼는 분도 있어요. 원하는 방식을 쓰면 돼요 -- 쿼리는 같으니까요.

### 선택하지 않은 컬럼은 어떻게 되나요?

반환된 객체는 여전히 `User` TypeScript 타입을 가지지만, 선택하지 않은 프로퍼티는 런타임에서 `undefined`가 돼요. 즉, `user.password`에 접근해도 TypeScript이 경고하지 않아요 -- 그냥 `undefined`를 반환할 뿐이에요. 부분 선택에 대한 컴파일 타임 안전성이 필요하면, 반환 타입을 선택한 컬럼으로만 좁혀주는 [SelectQueryBuilder](./query-builder.md)를 사용해 주세요.

---

## 정렬 -- orderBy

`orderBy`가 없으면 DB는 **결과 순서를 보장하지 않습니다**. 대부분의 DB가 삽입 순서대로 돌려주는 것처럼 보여서 안정적이라고 착각하기 쉬운데, 테이블 재구축이나 병렬 쿼리 한 번이면 순서가 훅 바뀔 수 있어요. 순서가 중요하다면 반드시 `orderBy`를 지정하세요.

### 단일 컬럼

```typescript
const users = await em.find(User, {
  orderBy: { createdAt: "DESC" },
});
```

```sql
SELECT * FROM "user"
ORDER BY "createdAt" DESC
```

`DESC`는 최신 순(내림차순), `ASC`는 오래된 순(오름차순)이에요.

### 복수 컬럼

```typescript
const users = await em.find(User, {
  orderBy: { role: "ASC", name: "ASC" },
});
```

```sql
SELECT * FROM "user"
ORDER BY "role" ASC, "name" ASC
```

데이터베이스는 **첫 번째 키를 먼저** 정렬하고, 같은 값이 있으면 두 번째 키로 정렬해요. 그래서 `"admin"` 사용자끼리 묶이고, 그 안에서 이름 알파벳순으로 정렬돼요.

### 왜 컬럼명이 아니라 엔티티 프로퍼티명을 사용하나요?

실제 데이터베이스 컬럼이 `created_at`이어도 `orderBy: { createdAt: "DESC" }`로 작성해요. ORM이 엔티티 정의의 `@Column({ name: "created_at" })` 메타데이터를 사용해서 프로퍼티명을 컬럼명으로 자동 매핑해 줘요. 이렇게 하면 애플리케이션 코드가 데이터베이스 스키마와 분리돼요.

---

## DISTINCT

쿼리 결과에 중복 행이 있고 고유한 값만 필요할 때 사용해요. `DISTINCT`는 결과를 반환하기 전에 중복을 제거해요.

```typescript
const uniqueCities = await em.find(User, {
  select: ["city"],
  distinct: true,
});
```

```sql
SELECT DISTINCT "city" FROM "user"
```

`user` 테이블에 1000개 행이 있지만 도시가 15개뿐이라면, 1000개 대신 15개 행만 반환돼요.

### 다중 컬럼 DISTINCT

`DISTINCT`는 단일 컬럼이 아니라 **전체 행**에 적용돼요. 여러 컬럼을 선택하면, *모든* 선택된 컬럼이 일치할 때만 중복으로 처리돼요:

```typescript
const combos = await em.find(Product, {
  select: ["category", "status"],
  distinct: true,
});
```

```sql
SELECT DISTINCT "category", "status" FROM "product"
```

이건 고유한 `(category, status)` 조합을 반환해요. `("electronics", "active")`와 `("electronics", "archived")`는 `status`가 다르기 때문에 둘 다 포함돼요.

컬럼 수준의 중복 제거(예: PostgreSQL의 `DISTINCT ON`)가 필요하면 [Query Builder](./query-builder.md)를 사용해 주세요.

---

## WHERE 필터

이 페이지에서 가장 중요한 섹션이에요. 작성하는 거의 모든 쿼리에 `where` 절이 포함되고, Stingerloom은 raw SQL 없이도 다양한 조건을 표현할 수 있는 풍부한 연산자를 제공해요.

### 기본 개념

`where` 객체는 규칙의 집합이에요: "**이 컬럼**이 **이 값**인 행을 원해요." 가장 단순한 형태는 동등 비교예요:

```typescript
const users = await em.find(User, {
  where: { name: "Alice" },
});
```

```sql
SELECT * FROM "user"
WHERE "name" = $1
-- parameters: ['Alice']
```

여러 필드를 추가하면 `AND`로 결합돼요 -- **모든** 조건이 참이어야 해요:

```typescript
const users = await em.find(User, {
  where: { name: "Alice", status: "active" },
});
```

```sql
SELECT * FROM "user"
WHERE "name" = $1 AND "status" = $2
-- parameters: ['Alice', 'active']
```

이게 기본이에요. 아래의 모든 내용은 이 위에 쌓여가요.

### 단축형: findBy / findOneBy

`where`만 필요하고 `select`·`orderBy`·`relations`·페이지네이션이 없을 땐, `{ where: ... }` 래핑은 군더더기예요. `findBy`와 `findOneBy`는 필터를 바로 받아요 -- `delete`·`update`와 동일한 필터 우선 모양이에요:

```typescript
// 아래 둘은 동일해요
const a = await em.find(User, { where: { status: "active" } });
const b = await em.findBy(User, { status: "active" });

// 단건
const user = await em.findOneBy(User, { id: 1 });
```

내부적으로 `find` / `findOne`에 위임하므로 where 객체는 동일한 연산자를 그대로 받고(배열은 `OR`), 필터 외의 것이 필요해지는 순간 전체 `find` / `findOne` 형태로 가면 돼요.

### 비교 연산자

동등 비교만으로는 부족할 때가 있어요. "18세보다 나이 많은 사용자 찾기"에는 `>` 비교가 필요해요. 일반 값 대신 **연산자 객체**를 전달하면 돼요:

```typescript
const users = await em.find(User, {
  where: {
    age: { gt: 18 },
  },
});
```

```sql
SELECT * FROM "user"
WHERE "age" > $1
-- parameters: [18]
```

전체 비교 연산자 목록이에요:

| 연산자 | SQL | 예시 | 생성되는 WHERE |
|--------|-----|------|----------------|
| `eq` | `=` | `{ age: { eq: 25 } }` | `"age" = 25` |
| `ne` | `!=` | `{ status: { ne: "deleted" } }` | `"status" != 'deleted'` |
| `gt` | `>` | `{ age: { gt: 18 } }` | `"age" > 18` |
| `gte` | `>=` | `{ score: { gte: 60 } }` | `"score" >= 60` |
| `lt` | `<` | `{ age: { lt: 65 } }` | `"age" < 65` |
| `lte` | `<=` | `{ age: { lte: 100 } }` | `"age" <= 100` |

참고: `{ age: 25 }` (일반 값)와 `{ age: { eq: 25 } }`는 같은 SQL을 생성해요. 다른 연산자와 일관성을 유지하고 싶을 때 `eq`를 명시적으로 사용하면 돼요.

### 하나의 필드에 여러 연산자 결합

같은 필드에 여러 연산자를 사용할 수 있어요. AND로 결합돼요:

```typescript
const users = await em.find(User, {
  where: {
    age: { gt: 18, lte: 65 },
  },
});
```

```sql
SELECT * FROM "user"
WHERE "age" > $1 AND "age" <= $2
-- parameters: [18, 65]
```

범위 쿼리예요: "나이가 18 초과 **이면서** 65 이하." 각 연산자가 자체 조건을 생성하고 AND로 연결돼요.

### 집합 연산자 -- in, notIn, between

값 목록이나 범위를 검사해야 할 때 사용해요.

**IN -- "이 중 하나인가요?"**

```typescript
const users = await em.find(User, {
  where: {
    role: { in: ["admin", "editor"] },
  },
});
```

```sql
SELECT * FROM "user"
WHERE "role" IN ($1, $2)
-- parameters: ['admin', 'editor']
```

`role = 'admin' OR role = 'editor'`와 동일하지만, 더 간결하고 데이터베이스가 최적화하기도 쉬워요.

**NOT IN -- "이 중 아무것도 아닌가요?"**

```typescript
const users = await em.find(User, {
  where: {
    status: { notIn: ["banned", "deleted"] },
  },
});
```

```sql
SELECT * FROM "user"
WHERE "status" NOT IN ($1, $2)
-- parameters: ['banned', 'deleted']
```

**BETWEEN -- "이 범위 안에 있나요?"**

```typescript
const users = await em.find(User, {
  where: {
    score: { between: [60, 100] },
  },
});
```

```sql
SELECT * FROM "user"
WHERE "score" BETWEEN $1 AND $2
-- parameters: [60, 100]
```

`BETWEEN`은 양쪽 끝을 포함해요: 60과 100 모두 매칭돼요. `score >= 60 AND score <= 100`과 동일해요.

### 축약형: 배열을 일반 값으로 전달

`IN`의 편리한 축약형이 있어요. `{ in: [...] }`로 감싸지 않고 배열을 값으로 직접 전달하면 ORM이 IN 절로 처리해요:

```typescript
const users = await em.find(User, {
  where: { id: [1, 2, 3] },
});
```

```sql
SELECT * FROM "user"
WHERE "id" IN ($1, $2, $3)
-- parameters: [1, 2, 3]
```

연산자 객체가 추가되기 전부터 있던 하위 호환 문법이에요.

### 문자열 연산자 -- 텍스트 내 검색

SQL의 `LIKE` 연산자로 문자열 내 패턴을 매칭할 수 있어요. `%` 와일드카드는 "임의의 문자열", `_`는 "임의의 단일 문자"를 의미해요. Stingerloom은 두 가지 수준의 추상화를 제공해요:

**저수준: `like`와 `notLike`**

와일드카드를 포함한 전체 패턴을 직접 작성해요:

```typescript
const users = await em.find(User, {
  where: {
    name: { like: "%alice%" },
  },
});
```

```sql
SELECT * FROM "user"
WHERE "name" LIKE $1
-- parameters: ['%alice%']
```

"alice", "Alice in Wonderland", "malice" 등 "alice"가 포함된 모든 것에 매칭돼요. 양쪽의 `%`는 "앞뒤에 아무거나 올 수 있다"는 뜻이에요.

```typescript
const users = await em.find(User, {
  where: {
    bio: { notLike: "%spam%" },
  },
});
```

```sql
SELECT * FROM "user"
WHERE "bio" NOT LIKE $1
-- parameters: ['%spam%']
```

**고수준: `contains`, `startsWith`, `endsWith`**

더 안전하고 편리해요 -- ORM이 `%` 와일드카드를 자동으로 추가하고, **검색어 안의 `%`나 `_`도 이스케이프해 줘요**:

```typescript
const users = await em.find(User, {
  where: {
    email: { contains: "gmail" },
    username: { startsWith: "admin" },
    domain: { endsWith: ".com" },
  },
});
```

```sql
SELECT * FROM "user"
WHERE "email" LIKE $1 AND "username" LIKE $2 AND "domain" LIKE $3
-- parameters: ['%gmail%', 'admin%', '%.com']
```

이스케이프가 왜 중요할까요? 사용자가 "50%"를 검색한다고 해봐요. raw `like`로는 `{ like: "%50%%" }`가 모호해요 -- 세 번째 `%`가 와일드카드인지 리터럴인지 불분명하거든요. `contains`를 쓰면 `{ contains: "50%" }`만 작성하면 ORM이 `%50\%%`로 이스케이프해서 리터럴 "50%"에 매칭해요.

**대소문자 무시 검색 (PostgreSQL 전용): `ilike`**

```typescript
const users = await em.find(User, {
  where: {
    name: { ilike: "%alice%" },
  },
});
```

```sql
SELECT * FROM "user"
WHERE "name" ILIKE $1
-- parameters: ['%alice%']
```

`ILIKE`는 대소문자를 무시하는 PostgreSQL 확장이에요 -- "Alice", "ALICE", "alice" 모두 매칭돼요. MySQL의 `LIKE`는 기본적으로 대소문자를 구분하지 않기 때문에(collation에 따라) `ilike`는 PostgreSQL에서만 필요해요.

### NULL 연산자

SQL에서 `NULL`은 특별해요 -- 값이 아니라 **값의 부재**예요. `=`로 비교할 수 없어요. `WHERE deleted_at = NULL`은 SQL에서 **결과가 0건**이에요. `IS NULL`을 사용해야 해요.

Stingerloom은 이걸 자동으로 처리해 줘요. NULL을 확인하는 두 가지 방법이 있어요:

```typescript
// 축약형 -- null을 직접 전달
const users = await em.find(User, {
  where: { deletedAt: null },
});

// 명시적 -- isNull 연산자 사용
const users = await em.find(User, {
  where: { deletedAt: { isNull: true } },
});
```

둘 다 생성하는 SQL:
```sql
SELECT * FROM "user"
WHERE "deletedAt" IS NULL
```

컬럼이 **null이 아닌** 행을 찾으려면:

```typescript
const users = await em.find(User, {
  where: { bio: { isNull: false } },
});
```

```sql
SELECT * FROM "user"
WHERE "bio" IS NOT NULL
```

### NOT 연산자

`not`은 단일 조건을 부정해요. 일반 값과 중첩 연산자 객체 모두에서 동작해요:

```typescript
const users = await em.find(User, {
  where: {
    role: { not: "admin" },    // simple negation
  },
});
```

```sql
SELECT * FROM "user"
WHERE "role" != $1
-- parameters: ['admin']
```

```typescript
const users = await em.find(User, {
  where: {
    bio: { not: null },        // IS NOT NULL
  },
});
```

```sql
SELECT * FROM "user"
WHERE "bio" IS NOT NULL
```

```typescript
const users = await em.find(User, {
  where: {
    age: { not: { gt: 65 } },  // negate a nested filter
  },
});
```

```sql
SELECT * FROM "user"
WHERE NOT ("age" > $1)
-- parameters: [65]
```

### 논리 결합자 -- OR, AND, NOT

기본적으로 `where` 객체의 모든 필드는 AND로 결합돼요. 하지만 OR 로직이 필요할 때가 있어요: "관리자이거나 점수가 90 이상인 사용자 찾기."

**OR**

```typescript
const users = await em.find(User, {
  where: {
    OR: [
      { role: "admin" },
      { score: { gte: 90 } },
    ],
  },
});
```

```sql
SELECT * FROM "user"
WHERE ("role" = $1) OR ("score" >= $2)
-- parameters: ['admin', 90]
```

`OR` 배열의 각 요소는 완전한 where 객체예요. 각 객체 내에서는 AND로 결합되고, 객체 간에는 OR로 결합돼요.

**AND (명시적)**

여러 필드가 이미 AND로 결합되기 때문에 명시적 `AND`가 필요한 경우는 드물어요. 같은 필드에 서로 다른 복잡한 조건을 AND로 결합할 때 유용해요:

```typescript
const users = await em.find(User, {
  where: {
    status: "active",
    AND: [
      { age: { gte: 18 } },
      { age: { lte: 65 } },
    ],
  },
});
```

```sql
SELECT * FROM "user"
WHERE "status" = $1 AND ("age" >= $2) AND ("age" <= $3)
-- parameters: ['active', 18, 65]
```

**NOT (최상위 부정)**

`NOT`은 조건 그룹 전체를 부정해요:

```typescript
const users = await em.find(User, {
  where: {
    status: "active",
    NOT: { role: "banned" },
  },
});
```

```sql
SELECT * FROM "user"
WHERE "status" = $1 AND NOT ("role" = $2)
-- parameters: ['active', 'banned']
```

**세 가지 모두 결합:**

```typescript
const users = await em.find(User, {
  where: {
    status: "active",
    NOT: { role: "banned" },
    OR: [
      { age: { gte: 18 } },
      { isVerified: true },
    ],
  },
});
```

```sql
SELECT * FROM "user"
WHERE "status" = $1 AND NOT ("role" = $2) AND (("age" >= $3) OR ("isVerified" = $4))
-- parameters: ['active', 'banned', 18, true]
```

### 배열 WHERE -- OR 축약형

OR를 표현하는 방법이 하나 더 있어요: 단일 객체 대신 where 객체의 **배열**을 전달하는 거예요:

```typescript
const users = await em.find(User, {
  where: [
    { name: "Alice", status: "active" },
    { age: { gt: 30 }, role: "admin" },
  ],
});
```

```sql
SELECT * FROM "user"
WHERE ("name" = $1 AND "status" = $2) OR ("age" > $3 AND "role" = $4)
-- parameters: ['Alice', 'active', 30, 'admin']
```

각 배열 요소는 AND 그룹이에요. 그룹 간에는 OR로 결합돼요. "그룹 1 **또는** 그룹 2에 매칭"으로 생각하면 돼요.

`OR` 키를 사용하는 것과 기능적으로 동일하지만, 단순한 경우에는 배열 문법이 더 읽기 편할 수 있어요.

### 타입 안전성

Stingerloom의 where 필터는 컴파일 타임에 타입 체크돼요. TypeScript 컴파일러가 각 엔티티 필드의 타입을 알고 있어서 유효한 연산자만 허용해요:

```typescript
// ✓ OK — age는 number, gt는 number를 받음
where: { age: { gt: 18 } }

// ✗ 컴파일 에러 — age는 number, "contains"는 string 전용
where: { age: { contains: "18" } }

// ✗ 컴파일 에러 — gt는 number를 기대하는데 string을 전달
where: { age: { gt: "eighteen" } }

// ✓ OK — name은 string, startsWith 사용 가능
where: { name: { startsWith: "A" } }

// ✗ 컴파일 에러 — "xyz"는 User의 유효한 프로퍼티가 아님
where: { xyz: "anything" }
```

런타임이 아닌 컴파일 타임에 많은 버그를 잡을 수 있어요. TypeScript를 지원하는 IDE를 사용하면, 필드명과 사용 가능한 연산자에 대한 자동완성도 제공돼요.

### 하위 호환성

기존 코드가 이전 `where` 문법을 사용하고 있어도 변경 없이 그대로 동작해요:

```typescript
// 동등 비교 -- 변경 없음
em.find(User, { where: { name: "Alice" } })

// 배열 → IN -- 변경 없음
em.find(User, { where: { id: [1, 2, 3] } })

// Raw Sql 객체 -- 변경 없음
em.find(User, { where: { age: Conditions.gt("`age`", 18) } })
```

연산자 객체 문법은 순수하게 추가된 것이에요 -- 브레이킹 체인지 없어요.

---

## 전문 검색 (Full-Text Search)

### LIKE의 문제점

블로그 검색 기능을 만든다고 해봐요. 첫 번째 생각은 `LIKE '%typescript%'`로 "typescript"가 포함된 게시물을 찾는 거예요. 동작하긴 하지만 근본적인 성능 문제가 있어요: 앞에 와일드카드가 있는 `LIKE '%...'`는 **인덱스를 사용할 수 없어요**. 데이터베이스가 모든 행을 스캔하고, 모든 텍스트 컬럼의 모든 문자를 읽고, 패턴이 매칭되는지 확인해야 해요. 100,000개의 게시물이 있는 테이블에서는 매 검색 쿼리마다 100,000개 행을 읽어야 한다는 뜻이에요.

전문 검색은 **언어를 이해하는 특수한 인덱스**를 만들어서 이 문제를 해결해요. 교과서 뒤의 색인처럼 생각하면 돼요 -- "TypeScript"를 찾으려고 모든 페이지를 읽는 대신, 색인에서 찾아서 바로 해당 페이지로 가는 거예요. 데이터베이스도 같은 방식이에요: 텍스트를 검색 가능한 토큰으로 전처리하고(어간 추출, 불용어, 랭킹 처리) 즉각적인 조회가 가능한 인덱스 구조에 저장해요.

- **PostgreSQL**은 `tsvector`(인덱싱된 문서)와 `tsquery`(검색 쿼리)를 **GIN 인덱스**와 함께 사용해요.
- **MySQL**은 `FULLTEXT` 인덱스와 `MATCH ... AGAINST`를 사용해요.

### Step 1: 엔티티에 인덱스 선언

`@FullTextIndex` 데코레이터로 전문 검색에 인덱싱할 컬럼을 ORM에 알려줘요. `@Entity()` 앞에 엔티티 클래스에 배치해요:

```typescript
import { Entity, Column, PrimaryGeneratedColumn } from "@stingerloom/orm";
import { FullTextIndex } from "@stingerloom/orm";

@FullTextIndex(["title", "content"], { language: "english" })
@Entity()
class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 200 })
  title!: string;

  @Column({ type: "text" })
  content!: string;
}
```

데코레이터는 두 개의 인자를 받아요:

| 파라미터 | 타입 | 설명 |
|----------|------|------|
| `columns` | `string[]` | 전문 검색 인덱스에 포함할 컬럼명 |
| `options.language` | `string` | PostgreSQL 텍스트 검색 설정 (기본값: `"english"`) |
| `options.name` | `string` | 커스텀 인덱스명 (기본값: `fts_{table}_{columns}`) |

`syncSchema`나 `migrate:generate` 실행 시 다이얼렉트별 DDL이 생성돼요.

**PostgreSQL** -- `tsvector` 표현식에 대한 GIN 인덱스를 생성해요:

```sql
CREATE INDEX IF NOT EXISTS "fts_post_title_content"
  ON "post" USING gin (to_tsvector('english', "title" || ' ' || "content"))
```

**MySQL** -- FULLTEXT 인덱스를 생성해요:

```sql
CREATE FULLTEXT INDEX `fts_post_title_content` ON `post` (`title`, `content`)
```

**SQLite** -- 전문 검색 인덱스는 지원되지 않아요. 데코레이터는 조용히 무시돼요.

### Step 2: `search` 연산자로 쿼리

인덱스가 생성되면, `where` 절에서 `search` 연산자를 사용해요. `contains`나 `startsWith`와 같은 문자열 전용 필터예요:

```typescript
const results = await em.find(Post, {
  where: {
    title: { search: "typescript orm" },
  },
});
```

ORM은 데이터베이스 드라이버에 따라 다른 SQL을 생성해요.

**PostgreSQL:**

```sql
SELECT * FROM "post"
WHERE to_tsvector('english', "title") @@ plainto_tsquery('english', $1)
-- parameters: ['typescript orm']
```

`@@` 연산자는 문서 벡터가 쿼리에 매칭되는지 확인해요. `plainto_tsquery`는 검색 문자열을 개별 용어로 분리하고 AND로 결합해요 -- `"typescript orm"`은 "typescript"와 "orm" 모두를 포함하는 게시물에 매칭돼요(순서 무관, 어간 추출 적용).

**MySQL:**

```sql
SELECT * FROM `post`
WHERE MATCH(`title`) AGAINST(? IN BOOLEAN MODE)
-- parameters: ['typescript orm']
```

`BOOLEAN MODE`에서는 `+required -excluded "exact phrase"` 같은 연산자를 사용할 수 있어요. 기본적으로 용어는 선택적이고 관련성 순으로 랭킹돼요.

### 다른 필터와 검색 결합

`search`는 그냥 또 하나의 where 연산자예요. 다른 필터와 자유롭게 결합할 수 있어요:

```typescript
const results = await em.find(Post, {
  where: {
    title: { search: "typescript" },
    isPublished: true,
  },
  orderBy: { createdAt: "DESC" },
  take: 20,
});
```

```sql
-- PostgreSQL
SELECT * FROM "post"
WHERE to_tsvector('english', "title") @@ plainto_tsquery('english', $1)
  AND "isPublished" = $2
ORDER BY "createdAt" DESC
LIMIT 20
-- parameters: ['typescript', true]
```

### 다중 컬럼 인덱스

`@FullTextIndex(["title", "content"])`로 여러 컬럼을 지정하면, 생성된 인덱스가 두 컬럼을 모두 커버해요. PostgreSQL에서는 `to_tsvector` 표현식에서 컬럼이 공백 구분자로 연결되기 때문에, 검색이 title과 content를 동시에 매칭해요.

하지만 `where`의 `search` 연산자는 쿼리 수준에서 **단일 컬럼**에 적용돼요. 결합된 인덱스를 통해 검색하려면 `Conditions.fullTextSearch` 헬퍼를 직접 사용해요:

```typescript
import { Conditions } from "@stingerloom/orm";

const results = await em.find(Post, {
  where: {
    title: Conditions.fullTextSearch(
      '"title" || \' \' || "content"',
      "typescript orm",
      "postgres",
      "english",
    ),
  },
});
```

---

## Soft Delete된 레코드 포함하기

엔티티에 `@DeletedAt` 컬럼이 있으면, ORM이 모든 쿼리에 `WHERE "deletedAt" IS NULL` 필터를 **자동으로** 추가해요. 즉, "삭제된" 레코드는 기본적으로 보이지 않아요 -- 데이터베이스에는 여전히 존재하지만, 애플리케이션에서는 없는 것처럼 동작해요.

```typescript
// 삭제되지 않은 게시물만 (ORM이 필터를 자동 추가)
const posts = await em.find(Post);
```

```sql
SELECT * FROM "post"
WHERE "deletedAt" IS NULL
```

Soft delete된 레코드도 포함하려면 -- 예를 들어 관리자 패널이나 "휴지통" 화면에서 -- `withDeleted: true`를 설정해요:

```typescript
const allPosts = await em.find(Post, {
  withDeleted: true,
});
```

```sql
SELECT * FROM "post"
-- deletedAt 필터 없음
```

Soft delete된 레코드**만** 반환하려면 — 복구 화면이나 감사(audit) 뷰처럼 삭제된 행만 나열해야 하는 경우 — `onlyDeleted: true`를 씁니다:

```typescript
const trashedPosts = await em.find(Post, {
  onlyDeleted: true,
});
```

```sql
SELECT * FROM "post"
WHERE "deletedAt" IS NOT NULL
```

`onlyDeleted`는 `withDeleted`보다 우선합니다. 둘을 동시에 설정하면 `onlyDeleted`가 이깁니다. 또한 `where` 조건과 AND로 결합하므로 다른 필터와 함께 쓸 수 있어요:

```typescript
// 특정 작성자의 삭제된 게시물만
const trashedByAlice = await em.find(Post, {
  where: { authorId: 42 },
  onlyDeleted: true,
});
```

`@DeletedAt` 컬럼이 없는 엔티티에서는 `onlyDeleted`가 조용히 무시됩니다 — `withDeleted`와 동일한 동작이에요.

`find()`, `findOne()`, `findBy()`, `findOneBy()`, `findOneOrFail()`, `findAndCount()`(개수 포함), `findWithCursor()`, `findWithPage()`, `stream()`, 그리고 집계 함수 `count()`, `sum()`, `avg()`, `min()`, `max()`, `exists()` 모두에서 동작합니다.

---

## 비관적 잠금 (Pessimistic Locking) -- lock

### 문제 상황

두 사용자가 동시에 재고가 1개 남은 상품을 구매하려고 한다고 해봐요. 둘 다 `stock = 1`을 읽고, 둘 다 1을 빼고, 둘 다 `stock = 0`을 저장해요. 쇼핑몰이 하나의 상품을 두 명에게 팔아 버린 거예요.

이건 **경쟁 조건(race condition)**이고, 데이터베이스 수준의 해결책이 **비관적 잠금**이에요: 행을 읽을 때 데이터베이스에 "이 행을 잠가 -- 내가 끝날 때까지 다른 누구도 읽거나 쓸 수 없어"라고 말하는 거예요.

### 사용법

```typescript
import { LockMode } from "@stingerloom/orm";

await em.transaction(async (txEm) => {
  const account = await txEm.findOne(Account, {
    where: { id: 1 },
    lock: LockMode.PESSIMISTIC_WRITE,
  });

  // This row is now locked — other transactions wait here
  account.balance -= 100;
  await txEm.save(Account, account);
  // Lock released when transaction commits
});
```

```sql
BEGIN;
SELECT * FROM "account" WHERE "id" = $1 FOR UPDATE;
-- parameters: [1]

-- ... other transactions trying to read this row will WAIT here ...

UPDATE "account" SET "balance" = $1 WHERE "id" = $2;
COMMIT;
-- Lock released
```

### 잠금 모드

| 모드 | 추가되는 SQL | 동작 |
|------|-------------|------|
| `PESSIMISTIC_WRITE` | `FOR UPDATE` | **배타적 잠금.** 커밋할 때까지 다른 트랜잭션이 이 행을 읽거나 쓸 수 없어요. 행을 수정할 계획일 때 사용해요. |
| `PESSIMISTIC_READ` | `FOR SHARE` (PostgreSQL) / `LOCK IN SHARE MODE` (MySQL) | **공유 잠금.** 다른 트랜잭션은 읽을 수 있지만 쓸 수 없어요. 다른 읽기를 차단하지 않으면서 일관된 읽기가 필요할 때 사용해요. |

::: warning
비관적 잠금은 **트랜잭션 안에서만 동작해요**. 트랜잭션 밖에서는 각 쿼리가 자체 auto-commit 미니 트랜잭션에서 실행되기 때문에, 잠금이 획득되자마자 즉시 해제돼요 -- 사실상 아무 효과가 없어요.
:::

---

## GROUP BY와 HAVING

GROUP BY는 같은 값을 가진 행을 하나의 행으로 축소해요. "상태별 주문 수는?" 또는 "카테고리별 총 매출은?" 같은 집계 쿼리의 기반이에요.

```typescript
import sql from "sql-template-tag";

const results = await em.find(Order, {
  select: ["status"],
  groupBy: ["status"],
  having: [sql`COUNT(*) > ${10}`],
});
```

```sql
SELECT "status" FROM "order"
GROUP BY "status"
HAVING COUNT(*) > $1
-- parameters: [10]
```

단계별로 설명하면:

1. **GROUP BY "status"** -- 모든 행을 `status` 값으로 그룹화해요. 고유 상태가 3개("pending", "shipped", "delivered")면 3개 그룹이 돼요.
2. **SELECT "status"** -- 각 그룹에서 status 값을 반환해요.
3. **HAVING COUNT(\*) > 10** -- 10개 이상의 행이 있는 그룹만 유지해요. WHERE는 그룹화 *전에* 필터링하지만, HAVING은 그룹화 *후에* 필터링해요.

`having`은 `Sql` 객체(`sql-template-tag`에서)의 배열을 받아요. 여러 조건은 `AND`로 연결돼요. 템플릿 태그를 사용하면 값이 파라미터화되기 때문에 SQL injection 위험이 없어요.

::: tip WHERE vs HAVING
- **WHERE**는 그룹화 *전에* 개별 행을 필터링해요
- **HAVING**은 그룹화 *후에* 그룹을 필터링해요

이렇게 생각하면 돼요: WHERE는 어떤 행이 그룹화 머신에 들어갈지 결정하고, HAVING은 어떤 그룹이 나올지 결정해요.
:::

---

## 페이지네이션

테이블에 수백만 행이 있으면 한 번에 다 반환할 수 없어요. 페이지네이션으로 데이터를 페이지 단위로 가져올 수 있어요. Stingerloom은 각각 다른 트레이드오프를 가진 네 가지 전략을 제공해요.

### 1. skip + take (오프셋 기반)

가장 단순한 방식이에요. `skip`은 "처음 N개 행을 무시", `take`는 "최대 N개 행을 반환"이에요.

```typescript
const page2 = await em.find(Post, {
  orderBy: { createdAt: "DESC" },
  skip: 10,
  take: 10,
});
```

PostgreSQL:
```sql
SELECT * FROM "post"
ORDER BY "createdAt" DESC
LIMIT 10 OFFSET 10
```

MySQL:
```sql
SELECT * FROM `post`
ORDER BY `createdAt` DESC
LIMIT 10, 10
```

1페이지는 `skip: 0, take: 10`, 2페이지는 `skip: 10, take: 10`이에요. 공식은 `skip = (pageNumber - 1) * pageSize`예요.

`limit` 튜플 `[offset, count]`로도 같은 결과를 얻을 수 있어요:

```typescript
const page2 = await em.find(Post, {
  orderBy: { createdAt: "DESC" },
  limit: [10, 10],  // [offset, count]
});
```

::: warning 깊은 페이지 문제
오프셋 기반 페이지네이션은 페이지가 깊어질수록 느려져요. `OFFSET 1000000`은 데이터베이스가 1,000,000개 행을 읽고 버린 후에야 원하는 10개를 반환한다는 뜻이에요. 대규모 테이블에서 깊은 페이지가 필요하면 커서 기반 페이지네이션을 고려해 주세요.
:::

### 2. findAndCount()

데이터와 전체 개수가 둘 다 필요한 경우가 많아요 -- 예를 들어 UI에 "235개 중 11-20 표시" 같은 것을 보여줄 때요.

```typescript
const [posts, total] = await em.findAndCount(Post, {
  orderBy: { createdAt: "DESC" },
  skip: 0,
  take: 10,
});

console.log(posts.length); // 10 (current page)
console.log(total);        // 235 (total matching rows)
```

내부적으로 같은 트랜잭션 안에서 **두 개의 쿼리**를 실행해요:

```sql
-- Query 1: fetch the page
SELECT * FROM "post"
ORDER BY "createdAt" DESC
LIMIT 10 OFFSET 0

-- Query 2: count all matching rows (no LIMIT/OFFSET)
SELECT COUNT(*) AS "result" FROM "post"
```

두 쿼리를 같은 트랜잭션에서 실행하기 때문에 count가 데이터와 일관성을 유지해요 -- 두 쿼리 사이에 행이 추가되거나 삭제될 수 없어요.

### 3. findWithPage()

`findAndCount()`는 원시 숫자를 줘요. `findWithPage()`는 전체 페이지네이션 메타데이터를 계산해 줘요 -- 총 페이지 수, hasNext, hasPrevious 등 -- REST API 응답에 바로 전달할 수 있어요.

```typescript
const result = await em.findWithPage(Post, {
  page: 2,
  pageSize: 20,
  orderBy: { createdAt: "DESC" },
  where: { isPublished: true },
  relations: ["author"],
});
```

내부적으로 `page`와 `pageSize`를 `skip`과 `take`로 변환한 뒤 `findAndCount()`를 호출해요:

```sql
-- page=2, pageSize=20 → offset = (2-1) * 20 = 20

SELECT * FROM "post"
WHERE "isPublished" = $1
ORDER BY "createdAt" DESC
LIMIT 20 OFFSET 20

SELECT COUNT(*) AS "result" FROM "post"
WHERE "isPublished" = $1
```

결과 객체에 필요한 모든 것이 들어 있어요:

```typescript
result.data            // Post[] — entities for the current page
result.total           // 235 — total matching rows
result.page            // 2 — current page number (1-based)
result.pageSize        // 20 — items per page
result.totalPages      // 12 — Math.ceil(235 / 20)
result.hasNextPage     // true — page 3 exists
result.hasPreviousPage // true — page 1 exists
```

**반환 타입: `PagePaginationResult<T>`**

| 필드 | 타입 | 설명 |
|------|------|------|
| `data` | `T[]` | 현재 페이지의 엔티티 |
| `total` | `number` | 매칭하는 전체 엔티티 수 |
| `page` | `number` | 현재 페이지 번호 (1부터 시작) |
| `pageSize` | `number` | 페이지당 항목 수 |
| `totalPages` | `number` | `Math.ceil(total / pageSize)` |
| `hasNextPage` | `boolean` | 다음 페이지 존재 여부 |
| `hasPreviousPage` | `boolean` | 이전 페이지 존재 여부 |

`findWithPage()`는 `find()`와 동일한 옵션을 모두 지원해요 (`where`, `select`, `relations`, `withDeleted`, `orderBy`, `groupBy`, `having`, `timeout`, `useMaster`).

`groupBy`를 사용하면 데이터의 각 행이 그룹이므로, `total`(`findWithPage()`와 `findAndCount()` 모두)은 원본 행 수가 아니라 `having`을 통과한 그룹 수를 셉니다.

### 4. findWithCursor() (커서 기반)

오프셋 페이지네이션의 근본적인 결함은 페이지가 깊어질수록 쿼리가 느려진다는 거예요. `OFFSET 1000000`은 데이터베이스가 백만 행을 스캔하고 건너뛰게 해요.

커서 기반 페이지네이션은 "**이 특정 행 다음부터** 줘"라고 하는 방식으로 해결해요. 매번 처음부터 세는 대신, 마지막으로 읽은 지점부터 시작해요 -- 책에 꽂은 책갈피처럼요.

```typescript
// First page — no cursor yet
const page1 = await em.findWithCursor(Post, {
  take: 20,
  orderBy: "id",
  direction: "ASC",
});
```

```sql
SELECT * FROM "post"
ORDER BY "id" ASC
LIMIT 21
-- fetches 21 rows (20 + 1 extra to detect if more exist)
```

ORM이 한 행을 더 가져와서 다음 페이지가 있는지 확인해요. 21행이 돌아오면 더 있고, 20행 이하면 끝이에요.

```typescript
console.log(page1.data);        // Post[] (up to 20 items)
console.log(page1.hasNextPage); // true
console.log(page1.nextCursor);  // "eyJ2IjoyMH0=" — opaque Base64 token
console.log(page1.count);       // 20
```

```typescript
// Next page — pass the cursor from the previous response
const page2 = await em.findWithCursor(Post, {
  take: 20,
  cursor: page1.nextCursor!,
  orderBy: "id",
  direction: "ASC",
});
```

```sql
SELECT * FROM "post"
WHERE "id" > $1
ORDER BY "id" ASC
LIMIT 21
-- parameters: [20]  (the decoded cursor value)
```

커서는 마지막 행의 정렬 컬럼 값을 인코딩해요. 이걸 다시 전달하면, ORM이 `WHERE "id" > 20` 조건(ASC일 때)이나 `WHERE "id" < 20`(DESC일 때)을 추가해요. 이건 **인덱스 탐색(index seek)**이라서 O(log n)이에요 -- 1페이지든 10,000페이지든 동일하게 빨라요.

**반환 타입: `CursorPaginationResult<T>`**

| 필드 | 타입 | 설명 |
|------|------|------|
| `data` | `T[]` | 현재 페이지의 엔티티 |
| `hasNextPage` | `boolean` | 더 많은 데이터 존재 여부 |
| `nextCursor` | `string \| null` | 다음 페이지를 위한 불투명 토큰 |
| `count` | `number` | 현재 페이지의 엔티티 수 |

::: tip 어떤 걸 써야 할까요?
| 필요한 것 | 최선의 선택 |
|-----------|-------------|
| UI에 페이지 번호 (1, 2, 3...) | `findWithPage()` 또는 `findAndCount()` |
| "더 보기" / 무한 스크롤 | `findWithCursor()` |
| 전체 카운트 없이 단순 오프셋 | `skip` + `take` |
| 수천 페이지 / 깊은 페이지네이션 | `findWithCursor()` |
:::

---

## 스트리밍 -- stream()

위의 모든 메서드는 결과를 한 번에 메모리로 로드해요. 20개의 게시물 페이지에는 괜찮지만, **백만 행 테이블의 모든 행**을 처리해야 하면 어떨까요 -- CSV 내보내기, 데이터 마이그레이션, 전체 사용자에게 이메일 발송 같은 경우요.

백만 행을 한 번에 로드하면 수 기가바이트의 메모리를 소모하고 프로세스가 죽을 수 있어요. `stream()`은 작은 배치로 행을 가져와서 각 배치를 처리하고, 다음 배치를 가져오기 전에 버리는 방식으로 해결해요.

```typescript
for await (const user of em.stream(User, { where: { isActive: true } })) {
  await sendEmail(user.email);
}
```

간단한 `for await` 문법이지만, 모든 사용자를 메모리에 로드하지 않아요. 내부에서 일어나는 일이에요:

```sql
-- Batch 1 (rows 0–999)
SELECT * FROM "user" WHERE "isActive" = $1 LIMIT 1000 OFFSET 0

-- Batch 2 (rows 1000–1999)
SELECT * FROM "user" WHERE "isActive" = $1 LIMIT 1000 OFFSET 1000

-- Batch 3 (rows 2000–2999)
SELECT * FROM "user" WHERE "isActive" = $1 LIMIT 1000 OFFSET 2000

-- ... continues until a batch returns fewer than 1000 rows
```

각 배치가 1000개 행(기본값)을 로드하고, `for await` 루프를 통해 하나씩 yield한 뒤, 다음 배치를 가져와요. 어느 시점에서든 하나의 배치(최대 1000개 객체)만 메모리에 있어요.

### 배치 크기 설정

세 번째 파라미터로 내부 쿼리당 가져올 행 수를 제어해요:

```typescript
// Fetch in batches of 500
for await (const post of em.stream(Post, { orderBy: { id: "ASC" } }, 500)) {
  await indexPost(post);
}
```

작은 배치는 메모리를 적게 쓰지만 데이터베이스 왕복이 많아져요. 큰 배치는 더 효율적이지만 메모리를 더 써요. 대부분의 경우 1000이 적당해요.

### 지원하는 옵션

`stream()`은 모든 `FindOption` 프로퍼티를 지원해요 -- `where`, `orderBy`, `relations`, `select`, `withDeleted` 등:

```typescript
for await (const post of em.stream(Post, {
  select: ["id", "title"],
  relations: ["author"],
  where: { isPublished: true },
  orderBy: { createdAt: "DESC" },
}, 2000)) {
  console.log(`${post.title} by ${post.author.name}`);
}
```

직접 지정한 `limit`, `take`, `skip`은 스트림이 커버하는 전체 **윈도**를 정의합니다. 배칭은 그 윈도 안에서 이루어지며, 우선순위 규칙은 `find()`와 같습니다:

```typescript
// 101~600번째 행만 스트리밍 (배치 크기 100)
for await (const post of em.stream(Post, {
  orderBy: { id: "ASC" },
  skip: 100,
  take: 500,
}, 100)) {
  await reindex(post);
}
```

### 진행 상황 추적

`count()`와 결합해서 진행률을 보여줄 수 있어요:

```typescript
const total = await em.count(User, { isActive: true });
console.log(`Processing ${total} users...`);

let processed = 0;
for await (const user of em.stream(User, { where: { isActive: true } })) {
  await process(user);
  processed++;
  if (processed % 1000 === 0) {
    console.log(`${processed}/${total}`);
  }
}
```

### stream() vs find() 언제 쓸까요?

| 시나리오 | 사용할 것 | 이유 |
|----------|-----------|------|
| 결과 페이지를 반환하는 API 엔드포인트 | `find()` + 페이지네이션 | 작은 결과셋, 직렬화를 위해 메모리에 있어야 함 |
| 모든 행 처리 (ETL, 내보내기, 일괄 이메일) | `stream()` | 메모리 고갈 방지 |
| 대규모 데이터셋 집계 | `stream()` 또는 raw SQL | 앱 수준 집계는 stream, 최적 성능은 DB 수준 raw SQL |

::: tip
변경이 많은 대규모 테이블에서 일관된 결과를 얻으려면, `REPEATABLE READ` 격리 수준의 트랜잭션으로 stream을 감싸세요. 이게 없으면 배치 사이에 행이 추가되거나 삭제되어 행을 건너뛰거나 중복 처리할 수 있어요.

```typescript
await em.transaction(async (txEm) => {
  for await (const user of txEm.stream(User)) {
    await processUser(user);
  }
}, { isolationLevel: "REPEATABLE READ" });
```
:::

---

## 집계 함수

개별 행이 아니라 요약 수치가 필요할 때가 있습니다. "사용자가 몇 명이지?", "평균 주문 금액은?", "최고 점수는?" — 이런 걸 답하는 게 **집계 함수**예요. 행을 전부 가져와 JavaScript에서 계산하는 것보다 DB에서 처리하는 편이 훨씬 효율적이기도 하고요.

### count()

```typescript
const total = await em.count(User);
const admins = await em.count(User, { role: "admin" });
```

```sql
-- count all users
SELECT COUNT(*) AS "result" FROM "user"

-- count admins only
SELECT COUNT(*) AS "result" FROM "user"
WHERE "role" = $1
-- parameters: ['admin']
```

두 번째 파라미터는 선택적 WHERE 조건 객체예요 -- `find()`의 `where`와 같은 문법이에요.

### sum(), avg(), min(), max()

```typescript
const totalRevenue = await em.sum(Order, "amount");
const avgAge = await em.avg(User, "age");
const youngest = await em.min(User, "age");
const oldest = await em.max(User, "age");
```

```sql
SELECT SUM("amount") AS "result" FROM "order"
SELECT AVG("age") AS "result" FROM "user"
SELECT MIN("age") AS "result" FROM "user"
SELECT MAX("age") AS "result" FROM "user"
```

두 번째 파라미터는 집계할 컬럼명이에요. 네 함수 모두 선택적 세 번째 파라미터로 WHERE 조건을 받아요:

```typescript
const activeAvgAge = await em.avg(User, "age", { isActive: true });
```

```sql
SELECT AVG("age") AS "result" FROM "user"
WHERE "isActive" = $1
-- parameters: [true]
```

### 여러 집계를 효율적으로 실행

각 집계 함수는 별도 쿼리를 실행해요. 여러 집계가 필요하면 `Promise.all`로 동시에 실행해서 순차적 왕복을 피해요:

```typescript
const [total, avgAge, minAge, maxAge] = await Promise.all([
  em.count(User),
  em.avg(User, "age"),
  em.min(User, "age"),
  em.max(User, "age"),
]);
```

네 개 쿼리를 데이터베이스에 동시에 보내서 하나가 끝나기를 기다렸다가 다음을 시작하는 것보다 빨라요.

### Soft-delete 인식

`count()`, `sum()`, `avg()`, `min()`, `max()`, `exists()` 모든 집계 함수는 `FindOption`의 soft-delete 플래그와 동일한 두 개의 선택적 후행 파라미터를 받아요:

```typescript
// 삭제된 사용자만 카운트 (onlyDeleted가 withDeleted보다 우선)
const trashed = await em.count(User, undefined, false, true);

// 삭제된 주문의 매출 합계
const lostRevenue = await em.sum(Order, "amount", undefined, false, true);

// 특정 작성자의 삭제된 게시물이 존재하는지 확인
const hasTrashed = await em.exists(Post, { authorId: 42 }, false, true);
```

| 파라미터 | 타입 | 기본값 | 동작 |
|---------|------|--------|------|
| `withDeleted` | `boolean` | `false` | live 행과 soft-deleted 행을 모두 집계에 포함 |
| `onlyDeleted` | `boolean` | `false` | soft-deleted 행만 대상으로 제한(`@DeletedAt IS NOT NULL`); `withDeleted`보다 우선 |

`@DeletedAt` 컬럼이 없는 엔티티에서는 `onlyDeleted`가 조용히 무시돼요. `find()`와 같은 읽기 API에서의 동작은 [Soft Delete](#soft-delete-인식) 섹션을 참고하세요.

---

## EXPLAIN -- 쿼리 분석

쿼리가 느릴 때 **왜** 느린지 이해해야 해요. 데이터베이스가 전체 테이블을 스캔하고 있나요? 올바른 인덱스를 사용하고 있나요? `EXPLAIN` 명령은 데이터베이스에게 실제로 쿼리를 실행하지 않고 실행 계획을 설명하도록 요청해요.

```typescript
const plan = await em.explain(User, {
  where: { email: "alice@example.com" },
});

console.log(plan.type); // "ref" — using an index
console.log(plan.key);  // "idx_user_email"
console.log(plan.rows); // 1 — estimated rows examined
```

ORM은 `find()`와 완전히 동일한 SQL을 만들고 앞에 `EXPLAIN`을 붙여요:

MySQL:
```sql
EXPLAIN SELECT * FROM `user`
WHERE `email` = ?
```

PostgreSQL:
```sql
EXPLAIN (FORMAT JSON) SELECT * FROM "user"
WHERE "email" = $1
```

### 결과 읽는 방법

정확한 필드는 데이터베이스에 따라 다르지만, 주의해서 봐야 할 것들이에요:

**MySQL:**
- `type: "ref"` 또는 `"const"` = 좋음 (인덱스 사용 중)
- `type: "ALL"` = 나쁨 (전체 테이블 스캔)
- `key` = 사용 중인 인덱스
- `rows` = 데이터베이스가 검사할 예상 행 수

**PostgreSQL:**
- `Index Scan` 또는 `Index Only Scan` = 좋음
- `Seq Scan` = 순차 스캔 (전체 테이블 스캔), 대규모 테이블에서 느릴 수 있음
- `cost` = 예상 상대 비용

### EXPLAIN은 언제 사용하나요?

개발 중에 다음을 확인할 때 사용해요:
- WHERE 조건이 인덱스를 타는지 (전체 테이블 스캔이 아닌지)
- JOIN이 적절한 인덱스를 사용하는지
- 새 인덱스 추가가 실제로 쿼리 플랜을 바꿨는지

`explain()`은 `find()`와 같은 `FindOption`을 받으므로, 프로덕션에서 실행할 쿼리의 플랜을 그대로 테스트할 수 있어요.

::: info
`explain()`은 MySQL과 PostgreSQL에서 지원돼요. SQLite에서는 `InvalidQueryError`를 던져요.
:::

---

## 빠른 참조 -- FindOption 전체 프로퍼티

`find()`에 전달할 수 있는 모든 옵션을 한 테이블에 정리했어요:

| 옵션 | 타입 | 설명 |
|------|------|------|
| `where` | `WhereClause<T>` | 필터 조건 (위의 WHERE 필터 참고) |
| `select` | `string[]` 또는 `{ [key]: true }` | 가져올 컬럼 (기본값: 전부) |
| `orderBy` | `{ [column]: "ASC" \| "DESC" }` | 정렬 순서 |
| `skip` | `number` | 건너뛸 행 수 (오프셋) |
| `take` | `number` | 최대 반환 행 수 (리밋) |
| `limit` | `[offset, count]` | skip/take의 대안 |
| `relations` | `string[]` | JOIN으로 관련 엔티티 즉시 로드 |
| `distinct` | `boolean` | SELECT DISTINCT |
| `groupBy` | `string[]` | GROUP BY 컬럼 |
| `having` | `Sql[]` | HAVING 조건 (groupBy 필수) |
| `withDeleted` | `boolean` | Soft delete된 레코드 포함 (live + 삭제 행) |
| `onlyDeleted` | `boolean` | Soft delete된 레코드**만** 반환; `withDeleted`보다 우선; `@DeletedAt` 없으면 무시 |
| `lock` | `LockMode` | 비관적 잠금 (트랜잭션 필수) |
| `timeout` | `number` | 쿼리 타임아웃 (밀리초) |
| `useMaster` | `boolean` | Read replica 사용 시 마스터에서 읽기 강제 |

---

## 다음 단계

- **[CRUD 기초](./entity-manager.md)** -- save, find, delete, soft delete
- **[쓰기 & 트랜잭션](./entity-manager-writes.md)** -- 배치 연산, upsert, 트랜잭션, raw SQL
- **[고급](./entity-manager-advanced.md)** -- 이벤트, subscriber, 멀티테넌시, 플러그인, FindOption 참조
