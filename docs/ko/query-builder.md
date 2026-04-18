# Query Builder

`find()`와 `findOne()`으로 대부분의 쿼리는 충분해요 — 조건 필터링, relation 로딩, 페이지네이션까지. 하지만 가끔은 그걸로 부족할 때가 있어요. 직접적인 relation이 없는 두 테이블을 조인한다거나, 카테고리별 행 수를 그룹핑하거나, 서로 다른 테이블의 결과를 UNION으로 합쳐야 할 때요. 이런 상황에서 **query builder**가 필요해요.

Stingerloom은 두 가지 query builder를 제공하고, 선택 기준은 간단해요.

| Builder | 언제 쓰나요 | 생성 방법 |
|---------|-------------|-----------|
| **SelectQueryBuilder** | 엔티티를 쿼리하면서 컬럼명 자동완성이 필요할 때 | `em.createQueryBuilder(User, "u")` |
| **RawQueryBuilder** | Raw SQL 제어가 필요할 때 — UNION, CTE, window function | `em.createQueryBuilder()` (인자 없이) |

대부분은 `SelectQueryBuilder`를 쓰게 돼요. 여기서부터 시작할게요.

---

## SelectQueryBuilder — Type-Safe 쿼리

### Query Builder가 왜 필요할까요?

본론에 들어가기 전에, `find()`로 다 하면 안 되는 걸까요?

`find()`가 표현할 수 없는 것들이 있기 때문이에요. `find()`는 `WHERE field = value`를 지원하지만, `WHERE age >= 18`이나, 관계없는 테이블에 대한 `JOIN`, `GROUP BY category HAVING COUNT(*) > 5` 같은 건 못 해요. 이럴 때 query builder가 필요해요.

Stingerloom의 query builder는 안전성 수준이 다른 세 가지 실행 메서드를 제공해요.

**`getMany()`** — 항상 **클래스 인스턴스**를 반환해요. `instanceof`가 동작하고, 클래스 메서드를 쓸 수 있고, 결과를 `em.save()`에 전달할 수 있어요. `select()` 사용 시, non-nullable 컬럼이 모두 포함됐는지 검증해요.

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .where("isActive", true)
  .getMany();

users[0] instanceof User; // ✓ true — real class instance
await em.save(User, users[0]); // ✓ works correctly
```

**`getPartialMany()`** — `Pick<T, K>` 타입 narrowing이 적용된 **typed plain object**를 반환해요. 선택하지 않은 컬럼에 접근하면 컴파일 에러가 나요. required 컬럼 검증은 하지 않아요.

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name"])
  .getPartialMany();

users[0].id;    // ✓ number — exists in Pick<User, "id" | "name">
users[0].name;  // ✓ string — exists
users[0].email; // ✗ Compile error! Property 'email' does not exist
```

**`getRawMany()`** — **untyped plain object** (`Record<string, unknown>`)를 반환해요. `addSelect(sql`COUNT(*)`, "cnt")` 같은 computed column이 있는 쿼리에 사용해요.

`where()`와 `orderBy()`는 항상 엔티티의 모든 컬럼을 받을 수 있어요 — SELECT하지 않은 컬럼으로도 필터링이나 정렬이 가능하니까요. 타입 시스템은 **projection**(반환 결과)과 **entity**(쿼리 대상)를 별도로 추적해요.

### 첫 번째 Query Builder 쿼리

활성 사용자를 등록일 기준으로 정렬하되, `id`, `name`, `email` 컬럼만 가져오고 싶다고 해볼게요. `find()`로는 이렇게 써요:

```typescript
const users = await em.find(User, {
  select: ["id", "name", "email"],
  where: { isActive: true },
  orderBy: { createdAt: "DESC" },
  take: 10,
});
```

Query builder로는 같은 쿼리가 이렇게 돼요:

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name", "email"])
  .where("isActive", true)
  .orderBy({ createdAt: "DESC" })
  .limit(10)
  .getPartialMany();
```

여기까지는 큰 차이가 없어요. Query builder의 진가는 `find()`로 표현할 수 없는 것들 — `>=` 같은 연산자, 관계없는 테이블과의 JOIN, GROUP BY + aggregate, pessimistic locking — 이 필요할 때 드러나요.

`createQueryBuilder(User, "u")`의 `"u"`는 **table alias**예요. 생성된 SQL에서 컬럼을 한정하는 짧은 이름이에요: `"u"."id"`, `"u"."name"` 같은 식이죠. JOIN을 다룰 때 alias가 왜 중요한지 알게 될 거예요.

> **Hint** Repository에서도 query builder를 생성할 수 있어요: `userRepo.createQueryBuilder("u")`. 둘 다 같은 방식으로 동작해요.

### WHERE — 행 필터링

`where()` 메서드는 조건의 복잡도에 따라 세 가지 스타일을 지원해요.

**Equals** — 가장 간단한 형태예요. 컬럼명과 값을 넘기면 돼요.

```typescript
qb.where("status", "active");
// WHERE "u"."status" = $1
```

**Operator** — `>=`, `<`, `LIKE` 등이 필요할 때요. 두 번째 인자로 연산자를 넘겨요. 연산자는 type-check 되므로 `"LKIE"` 같은 오타는 컴파일 에러가 돼요.

```typescript
qb.where("age", ">=", 18);
// WHERE "u"."age" >= $1

// Allowed operators:
// =, !=, <>, <, >, <=, >=, LIKE, NOT LIKE, ILIKE, IN, NOT IN,
// IS NULL, IS NOT NULL, BETWEEN
```

**Raw SQL** — ORM으로 표현할 수 없는 것들에 사용해요. `sql` template literal을 직접 넘기면 돼요.

```typescript
import sql from "sql-template-tag";

qb.where(sql`"u"."score" > ${90}`);
```

세 가지 스타일 모두 type-safe해요 — 컬럼명(`"age"`, `"status"`)이 `keyof User`에서 자동완성돼요. 오타는 컴파일 에러가 돼요.

### 조건 결합 — AND, OR

여러 조건은 `andWhere()`와 `orWhere()`로 체이닝해요.

```typescript
const qb = em.createQueryBuilder(User, "u");

const users = await qb
  .where("isActive", true)
  .andWhere("age", ">=", 18)
  .getMany();
// WHERE "u"."is_active" = $1 AND "u"."age" >= $2
```

`orWhere()`는 기존 조건을 괄호로 감싸고 OR 분기를 추가해요.

```typescript
qb.where("isActive", true)
  .andWhere("age", ">=", 18)
  .orWhere("role", "admin");
// WHERE ("u"."is_active" = $1 AND "u"."age" >= $2) OR "u"."role" = $3
```

즉: (active이면서 18세 이상)이거나, 나이와 상관없이 admin인 경우예요.

### 자주 쓰는 WHERE 헬퍼

흔한 패턴에 raw SQL을 쓰는 대신, 내장 헬퍼를 사용해요.

```typescript
// IN — match any value in the list
qb.whereIn("status", ["active", "pending"]);

// NOT IN — exclude these values
qb.whereNotIn("id", [1, 2, 3]);

// NULL checks
qb.whereNull("deletedAt");
qb.whereNotNull("email");

// BETWEEN — range check
qb.whereBetween("age", 18, 65);

// LIKE — pattern matching
qb.whereLike("name", "%alice%");
```

각 헬퍼는 기존 WHERE 절에 AND 조건을 추가해요. `where()`와 `andWhere()`와 자유롭게 섞어 쓸 수 있어요.

모든 WHERE 메서드는 `"alias.property"` 형식의 cross-entity 참조도 지원해요 — JOIN 섹션의 [Cross-Entity 컬럼 해석](#cross-entity-컬럼-해석)을 참고하세요.

### JSON 컬럼 탐색

#### 이 섹션이 필요한 이유

> **예제 이름에 대한 한마디.** 많은 ORM 튜토리얼이 JSON 컬럼 예제로 `metadata`를 씁니다. 사실 이 이름은 코드 스멜이에요 — _"metadata"_ 는 문자 그대로 _"데이터에 대한 데이터"_ 라는 뜻이라, 실제로 뭐가 들어가는지 감추는 이름이 되어 버려요. 이 섹션에선 `User` 엔티티의 `profile` JSON 컬럼으로 예제를 듭니다. 구체적인 비즈니스 데이터, 명시적인 스키마예요. 여기서 설명하는 모든 동작은 이름과 관계없이 어떤 `json`·`jsonb` 컬럼에도 적용됩니다.

`users` 테이블의 각 행이 아래와 같은 `profile` JSON 컬럼을 가진다고 해볼게요. 연락처·개인정보·태그·역할을 담는 실제 데이터 컬럼이에요.

```json
{
  "contact":  { "email": "alice@example.com", "phone": "+82-10-0000-0000" },
  "personal": { "age": 30, "city": "Seoul" },
  "tags":     ["red", "blue", "green"],
  "role":     "admin"
}
```

목표는 이거예요. _"contact.email이 `@corp.com`으로 끝나고, 나이가 18 이상이며, tags 배열이 비어 있지 않은 사용자를 찾아라."_

Raw SQL로 쓰면 DB마다 문법이 전부 달라요.

```sql
-- PostgreSQL
SELECT * FROM users
WHERE profile #>> '{contact,email}' LIKE '%@corp.com'
  AND (profile #>> '{personal,age}')::int >= 18
  AND jsonb_array_length(profile -> 'tags') > 0;

-- MySQL
SELECT * FROM users
WHERE JSON_UNQUOTE(JSON_EXTRACT(profile, '$.contact.email')) LIKE '%@corp.com'
  AND JSON_EXTRACT(profile, '$.personal.age') >= 18
  AND JSON_LENGTH(profile, '$.tags') > 0;

-- SQLite
SELECT * FROM users
WHERE json_extract(profile, '$.contact.email') LIKE '%@corp.com'
  AND json_extract(profile, '$.personal.age') >= 18
  AND json_array_length(profile, '$.tags') > 0;
```

여기엔 통증이 세 군데 있어요.

1. **다이얼렉트마다 함수 이름과 경로 문법이 달라요.** PostgreSQL → MySQL로 옮기는 순간 JSON 라인이 전부 깨져요.
2. **경로가 문자열이에요.** `'{contact,emial}'` 같은 오타가 있어도 컴파일은 성공하고, 쿼리는 조용히 0건을 돌려줘요.
3. **사용자 입력으로 경로를 조립하면 인젝션 벡터가 돼요.** `` `'{${key}}'` `` 같은 포맷은 악의적 키 하나로 쿼리를 끝낼 수 있어요.

하지만 TypeScript는 이미 `profile`의 모양을 알고 있어요. 여러분이 그렇게 선언했기 때문이에요.

```typescript
@Column({ type: "jsonb", nullable: true })
profile!: {
  contact?:  { email: string; phone?: string };
  personal?: { age: number; city?: string };
  tags?:     string[];
  role?:     string;
};
```

그래서 질문이 이렇게 바뀝니다. _"`u.profile.contact.email`이라고만 쓰면 ORM이 알아서 올바른 SQL로 바꿔줄 수는 없을까?"_ 이 섹션이 답하려는 질문이에요.

#### `qAlias()`가 나온 배경

JSON을 다루기 전에도 query builder는 컬럼을 지목하는 방법이 두 가지 있었어요.

```typescript
qb.where("firstName", "Alice")                        // 문자열 기반
qb.where(alias(User, "u").col("firstName"), "Alice")  // alias() — 컬럼명 자동완성
```

둘 다 연산자는 여전히 `"="`, `"LIKE"`처럼 문자열로 직접 써야 해요. JPA를 써본 분이라면 다음 단계가 익숙할 거예요. `QUser` 같은 클래스를 코드 제너레이션으로 만들어 `qUser.firstName.eq("Alice")`라고 쓰는 패턴 — JPA QueryDSL이 정확히 그런 방식인데, 빌드 타임 코드 생성기가 필요해요.

**`qAlias()`는 코드 제너레이션 없이 같은 DX를 주는 TypeScript 구현이에요.** 엔티티의 모든 프로퍼티가 `ColumnExpression`인 척 위장하는 `Proxy`를 돌려줘요.

```typescript
const u = qAlias(User, "u");
qb.where(u.firstName.eq("Alice"));
//         │         └── ColumnExpression의 연산자 메서드
//         └── 프록시의 get trap이 "u.firstName"을 만들어 냄
```

런타임에 `u.firstName`이라는 실제 객체는 없어요. `get` trap이 호출될 때마다 `ColumnExpression("u.firstName")`을 즉석에서 만들고, `.eq("Alice")`가 이를 지연된 `ColumnCondition`으로 감싼 뒤, query builder가 빌드 시점에 `"u.firstName"`을 `"u"."first_name"`으로 해석해요 (`SnakeNamingStrategy` 포함).

#### JSON은 왜 자연스러운 확장인가

프록시가 프로퍼티 접근을 SQL 표현으로 바꾸는 구조라면, JSON 컬럼 지원은 거의 공짜예요. `u.profile`에 접근할 때, 프록시는 `profile`이 `@Column({ type: "json" | "jsonb" })`로 선언된 것을 확인하고 조금 다른 프록시 — **경로를 끝내지 않고 계속 확장하는** `JsonPathExpression` — 을 대신 돌려줍니다.

```
u            .profile       .contact      .email      .eq("alice@example.com")
│             │              │             │           │
ColumnExpr    JsonPath(      JsonPath(     JsonPath(   JsonPathCondition
프록시         ref="u.prof",  path=         path=       DialectExpression
              path=[])       ["contact"])  ["contact", 통해 SQL로 컴파일
                                            "email"])
```

마지막 연산자 호출만이 경로를 고정하고 `JsonPathCondition`을 만들어요. 이후 query builder가 현재 드라이버의 `DialectExpression`에 위임해 올바른 SQL을 렌더링합니다 — PostgreSQL이면 `#>>`, MySQL이면 `JSON_EXTRACT`, SQLite면 `json_extract`.

#### 기본 사용법

```typescript
import { qAlias } from "@stingerloom/orm";

@Entity()
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  firstName!: string;

  @Column({ type: "jsonb", nullable: true })
  profile!: {
    contact?:  { email: string; phone?: string };
    personal?: { age: number; city?: string };
    tags?:     string[];
    role?:     string;
  };
}

const u = qAlias(User, "u");

const users = await em
  .createQueryBuilder(User, "u")
  .where(u.profile.contact.email.eq("alice@example.com"))
  .getMany();
```

내부 컴파일 결과:

```sql
-- PostgreSQL
SELECT ... FROM "users" AS "u"
WHERE "u"."profile" #>> ARRAY[$1, $2]::text[] = $3
-- params: "contact", "email", "alice@example.com"

-- MySQL
SELECT ... FROM `users` AS `u`
WHERE JSON_UNQUOTE(JSON_EXTRACT(`u`.`profile`, ?)) = ?
-- params: "$.contact.email", "alice@example.com"

-- SQLite
SELECT ... FROM "users" AS "u"
WHERE json_extract("u"."profile", ?) = ?
-- params: "$.contact.email", "alice@example.com"
```

경로 세그먼트도, 비교 값도 모두 **바인딩 파라미터**예요. 문자열 연결이 전혀 없으므로 경로가 사용자 입력이라도 안전해요.

#### 연산자 레퍼런스 (컴파일된 SQL과 함께)

아래 예제는 모두 `const u = qAlias(User, "u")`를 전제하고 PostgreSQL 출력 기준으로 보여드려요. MySQL과 SQLite는 동등한 함수 호출로 바뀝니다.

##### 비교 — `.eq` / `.neq` / `.gt` / `.gte` / `.lt` / `.lte`

```typescript
u.profile.personal.age.gte(18);
```
```sql
"u"."profile" #>> ARRAY['personal','age']::text[] >= $1
```

##### 패턴 — `.like` / `.notLike`

```typescript
u.profile.contact.email.like("%@corp.com");
```
```sql
"u"."profile" #>> ARRAY['contact','email']::text[] LIKE $1
```

##### 집합 — `.in` / `.notIn`

```typescript
u.profile.role.in(["admin", "editor"]);
```
```sql
"u"."profile" #>> ARRAY['role']::text[] IN ($1, $2)
```

빈 배열은 `1 = 0`(모두 제외)으로 축약되고, `.notIn([])`은 `1 = 1`(모두 포함)로 바뀌어요. 쿼리가 무효화되지 않도록 걸어둔 안전 장치예요.

##### NULL — `.isNull` / `.isNotNull`

```typescript
u.profile.contact.email.isNull();
```
```sql
"u"."profile" #>> ARRAY['contact','email']::text[] IS NULL
```

존재하지 않는 경로는 추출 시 NULL이 되므로, `.isNull()`이 _"경로가 없거나 값이 null"_ 을 표현하는 올바른 방법이에요.

##### 구조 — `.contains(value)`

```typescript
u.profile.contains({ role: "admin" });
```
```sql
"u"."profile" @> $1::jsonb      -- param: '{"role":"admin"}'
```

MySQL에선 `JSON_CONTAINS(col, '{"role":"admin"}', '$.path')`로 나가요. SQLite는 네이티브 containment 연산자가 없어서 **스칼라** 값만 받아요(경로 동등 비교로 변환). 객체·배열을 넘기면 `OrmError`를 던져요. 복잡한 containment가 필요하면 잎 경로에서 `.eq()`로 분해하거나 raw SQL을 쓰세요.

##### 구조 — `.hasKey(key)`

```typescript
u.profile.contact.hasKey("email");
```
```sql
("u"."profile" #> ARRAY['contact']::text[]) ? $1        -- PostgreSQL
JSON_CONTAINS_PATH(`u`.`profile`, 'one', ?)             -- MySQL
json_extract("u"."profile", ?) IS NOT NULL             -- SQLite
```

##### 스칼라 — `.arrayLength()` / `.typeOf()`

둘 다 `JsonScalarExpression`을 돌려줘요 — "JSON 함수 호출 결과를 비교 대상으로 그대로 갖고 있는 것"으로 생각하면 돼요.

```typescript
u.profile.tags.arrayLength().gt(3);
u.profile.tags.typeOf().eq("array");
```
```sql
jsonb_array_length("u"."profile" #> ARRAY['tags']::text[]) > $1
jsonb_typeof     ("u"."profile" #> ARRAY['tags']::text[]) = $1
```

#### 동적 경로 — `.path(string)`

프록시 접근은 코드에 박혀 있는 정적 경로에 강해요. 프록시가 잘 못 표현하는 두 가지는요.

- **배열 인덱스** — 배열 타입이 느슨하면 TypeScript가 `u.profile.tags[0]`을 곧바로 허용하지 않을 때가 있어요.
- **점·공백·구두점이 들어간 키** — `u.profile["weird key"]`는 프록시 방식으로 안전하게 태울 수 없어요.

이럴 때 `.path()`를 써요.

```typescript
u.profile.path("tags[0]").eq("admin");
u.profile.path(`items["weird key"][2].value`).isNotNull();
```
```sql
-- PostgreSQL
"u"."profile" #>> ARRAY['tags','0']::text[] = $1
"u"."profile" #>> ARRAY['items','weird key','2','value']::text[] IS NOT NULL
```

`.path()`는 프록시 접근과 합성돼요. 정적으로 갈 수 있는 데까지 프로퍼티로 내려간 다음, 동적 꼬리만 `.path()`로 붙이면 됩니다.

```typescript
u.profile.personal.path("history[1].city").eq("Busan");
// 결과 path = ['personal', 'history', 1, 'city']
```

#### 드라이버 치트시트

| 연산             | PostgreSQL                              | MySQL                                           | SQLite                                                 |
|------------------|-----------------------------------------|-------------------------------------------------|--------------------------------------------------------|
| Extract (text)   | `col #>> '{a,b}'`                       | `JSON_UNQUOTE(JSON_EXTRACT(col, '$.a.b'))`      | `json_extract(col, '$.a.b')`                           |
| Extract (JSON)   | `col #> '{a,b}'`                        | `JSON_EXTRACT(col, '$.a.b')`                    | `json_extract(col, '$.a.b')` (SQLite는 항상 스칼라)    |
| Contains         | `col @> val::jsonb`                     | `JSON_CONTAINS(col, val, '$.path')`             | 스칼라만 지원 — 객체 값은 `OrmError` throw             |
| Has key          | `(col #> path) ? 'k'`                   | `JSON_CONTAINS_PATH(col, 'one', '$.path.k')`    | `json_extract(col, '$.path.k') IS NOT NULL`            |
| Array length     | `jsonb_array_length(col #> path)`       | `JSON_LENGTH(col, '$.path')`                    | `json_array_length(col, '$.path')`                     |
| Type of          | `jsonb_typeof(col #> path)`             | `JSON_TYPE(JSON_EXTRACT(col, '$.path'))`        | `json_type(col, '$.path')`                             |

#### 안전 장치와 한계

- **SQL 인젝션.** 모든 경로 세그먼트·키·값이 바인딩 파라미터예요. `.path("'; DROP TABLE users--")` 같은 악성 입력도 prepared statement에서 문자열 리터럴로 들어갈 뿐, 실행되는 SQL이 되지 않아요.
- **없는 경로.** 세 다이얼렉트 모두 없는 경로를 추출하면 `NULL`이 나와요. _"없는 것"_ 과 _"있는데 null"_ 을 구분해야 하면 `.isNull()` / `.isNotNull()` 또는 `.hasKey(...)`를 쓰세요.
- **SQLite 주의.** `json1` 확장이 필요해요(`better-sqlite3`에 기본 포함). `json_extract`가 SQLite의 스칼라 타입으로 값을 돌려주므로 `.gt(18)` 같은 숫자 비교는 캐스트 없이 바로 동작해요. 객체 containment는 지원하지 않아요.
- **`any`로 타입 지워짐.** JSON 컬럼을 `any`로 두거나 타입 선언을 생략해도 프록시는 런타임에 정상 동작해요. 다만 TypeScript 단에서의 프로퍼티 자동완성을 잃어요.

JSON 필터를 쓰려고 `` em.query(sql`... ->> ${path}`) ``에 손이 가는 순간이 온다면, 먼저 QueryDSL 경로를 떠올리세요 — 더 안전하고, 지원되는 모든 드라이버에서 이식성이 있어요.

#### `qAlias()`로 쓸 수 있는 네 가지가 더 늘었어요

여기까지 보면 `qAlias()`는 WHERE 절에 조건을 놓을 때만 빛나요. 그런데 실제 쿼리를 짜다 보면 다음 같은 상황이 금방 나와요.

- 삭제되지 않은 행 먼저, 삭제된(=`deletedAt`이 null이 아닌) 행은 뒤로 빼서 보고 싶다
- 부서별로 인원수를 세고, 10명 넘는 부서만 남기고 싶다
- 나이 18세 이상 **이면서** 상태가 active인 사용자 + 역할이 admin인 사용자를 한 번에 꺼내고 싶다
- 사용자가 `"50%"`라고 검색창에 쳤을 때 "50 다음에 아무 글자" 같은 와일드카드가 아니라 **진짜 `"50%"` 문자열**이 들어간 행만 매칭되게 하고 싶다

예전엔 이걸 하려면 문자열 ORDER BY, `andWhereGroup`, 직접 짠 LIKE 패턴을 섞어 써야 했어요. 이제 `qAlias()`가 돌려주는 `u.xxx` 위에서 메서드 하나로 풀 수 있어요.

차례로 볼게요.

##### 정렬 — `.asc()` / `.desc()` / `.nullsFirst()` / `.nullsLast()`

정렬 방향을 메서드로 써요.

```typescript
const u = qAlias(User, "u");

await em.createQueryBuilder(User, "u")
  .orderBy(u.createdAt.desc().nullsLast())   // 최신 먼저, null은 맨 뒤
  .addOrderBy(u.name.asc())                  // 같은 시각이면 이름순
  .getMany();
```

`orderBy(...)`는 정렬을 새로 세팅하고, `addOrderBy(...)`는 뒤에 하나 더 붙여요. 기존에 쓰던 `orderBy({ name: "ASC" })` 같은 객체 형식도 그대로 동작해요.

`.nullsLast()` / `.nullsFirst()`는 null 값을 어디로 몰지 정해요. 여기서 드라이버마다 사정이 다른데, 한 줄로 정리하면:

- PostgreSQL과 SQLite는 `ORDER BY col DESC NULLS LAST` 구문을 그대로 지원해요.
- MySQL은 그런 키워드가 없어요. 대신 `col IS NULL` 값(0 또는 1)으로 한 번 더 정렬하면 같은 효과가 나오는데, Stingerloom이 이 변환을 알아서 해줘요.

그래서 코드는 어느 드라이버에서든 똑같이 `u.createdAt.desc().nullsLast()`로 쓰면 돼요.

##### 집계 — `.count()` / `.sum()` / `.avg()` / `.min()` / `.max()`

컬럼 뒤에 집계 함수를 바로 붙일 수 있어요.

```typescript
const u = qAlias(User, "u");
const total = u.id.count();   // COUNT(u.id) — 아직 SQL로 안 나감, 일단 "표현식"

await em.createQueryBuilder(User, "u")
  .select(["departmentId"])
  .addSelect(total.as("total"))           // SELECT에 넣을 때는 .as()로 이름 지정
  .groupBy(["u.departmentId"])
  .having(total.gt(10))                   // HAVING에도 같은 표현식 재사용
  .getRawMany();
```

포인트는 `const total = u.id.count()`로 만든 표현식을 **SELECT에도 넣고 HAVING 조건으로도 그대로 쓴다**는 거예요. 같은 COUNT를 두 번 적지 않아도 돼요. 비교 메서드는 평소 조건 쓰듯 `.eq`, `.gt`, `.lt`, `.between` 전부 달려 있어요.

SELECT에 넣을 때 `.as("total")`을 권장해요. 생략하면 `agg_count_id` 같은 이름이 자동으로 붙는데, 결과를 `getRawMany()`로 꺼낼 때 키 이름이 헷갈리기 쉬워요.

중복을 빼고 세고 싶으면 `.countDistinct()`를 쓰세요. `COUNT(DISTINCT u.role)`이 나와요.

##### SELECT 별칭 — `.as("name")`

일반 컬럼, JSON 경로, 집계 어느 것에든 `.as("name")`을 붙일 수 있어요. 결과는 `AliasedExpression`이고 SELECT 자리에서만 의미가 있어요. `where()`나 `having()`에는 넘길 수 없도록 타입으로 막혀 있어요.

```typescript
const u = qAlias(User, "u");

await em.createQueryBuilder(User, "u")
  .select([
    u.name.as("display_name"),                 // 그냥 컬럼 별칭
    u.metadata.profile.email.as("contact"),    // JSON 추출 + 별칭
    u.id.count().as("total"),                  // 집계 + 별칭
  ])
  .groupBy(["u.name", "u.metadata"])
  .getRawMany();
```

JSON 경로 별칭은 드라이버의 텍스트 추출 연산자(`#>>` / `JSON_UNQUOTE(JSON_EXTRACT(...))` / `json_extract()`)로 컴파일되고, 경로 문자열은 바인딩 파라미터로 붙어서 `getRawMany()` 직렬화 과정에서도 안전하게 보존돼요.

`addSelect(u.age.as("years"))`로 기존 SELECT 목록 뒤에 덧붙일 수도 있고, 한 번의 `select([...])`에 별칭 컬럼과 집계를 섞어 넣어도 돼요.

##### null 처리 — `coalesce()` / `nullif()`

`coalesce(a, b, c, …)`는 왼쪽에서 오른쪽으로 처음 non-null인 값을 반환해요. `nullif(a, b)`는 `a`가 `b`와 같으면 `NULL`, 아니면 `a`를 돌려주죠. 빈 문자열이나 `-1` 같은 센티넬 값을 진짜 NULL로 바꾸고 싶을 때 쓰세요. 둘 다 표준 SQL이어서 드라이버 구분 없이 그대로 써요.

```typescript
import { coalesce, nullif, Expressions, qAlias } from "@stingerloom/orm";

const u = qAlias(User, "u");

// 닉네임 → 이름 → 기본값 순으로 fallback
qb.select([
  u.nickname.coalesce(u.name, "anonymous").as("display_name"),
]);
// SELECT COALESCE("u"."nickname", "u"."name", ?) AS "display_name"

// 빈 이메일은 NULL로
qb.select([nullif(u.email, "").as("email_or_null")]);

// WHERE / HAVING에서도 그대로 사용
qb.where(coalesce(u.score, 0).gte(50));
// WHERE COALESCE("u"."score", ?) >= ?
```

인자 자리에는 컬럼, JSON 경로 추출(`u.metadata.profile.tier`), 집계(`u.id.count()`), 중첩된 다른 `coalesce`, 원시 값 무엇이든 섞어 쓸 수 있어요. 값은 자동으로 바인딩돼서 안전하고요. 결과는 `ScalarExpression`이어서 `.eq()` / `.gt()` / `.as()`를 바로 이어 붙일 수 있어요.

정적 헬퍼로는 `Expressions.coalesce` / `Expressions.nullif`를 제공해요. Java QueryDSL의 `Expressions.*` 스타일을 선호하면 이쪽을 쓰면 돼요.

##### 현재 시각 — `currentDate()` / `currentTime()` / `currentTimestamp()`

DB 서버의 시계를 어느 자리에든 넣을 수 있는 세 개의 표준 SQL 헬퍼예요. 결과는 `ScalarExpression`이라 `.as()` / `.eq()` / `coalesce`에 중첩 등 지금까지 본 합성이 전부 그대로 돼요. 드라이버 차이 없이 동일한 리터럴(`CURRENT_DATE` / `CURRENT_TIME` / `CURRENT_TIMESTAMP`)로 나가요.

```typescript
import { Expressions, qAlias } from "@stingerloom/orm";

const s = qAlias(Session, "s");

qb.where(s.expiresAt.gte(Expressions.currentTimestamp()));
// WHERE "s"."expires_at" >= CURRENT_TIMESTAMP

qb.select([Expressions.currentDate().as("today")]);
// SELECT CURRENT_DATE AS "today"
```

`ColumnExpression`의 비교 메서드는 인자가 `ScalarExpression`이면 자동으로 풀어서 인라인으로 넣어요. 그래서 `u.createdAt.lte(currentTimestamp())`처럼 써도 파라미터 바인딩이 아니라 `CURRENT_TIMESTAMP`가 그대로 SQL에 박혀요.

##### 타입 변환 — `.stringValue()` / `.intValue()` / `.longValue()` / `.floatValue()` / `.booleanValue()`

컬럼이나 스칼라 표현식을 다른 SQL 타입으로 CAST해요. 드라이버별로 받는 타입명이 다르기 때문에(MySQL은 `INTEGER` 대신 `SIGNED`, SQLite는 `BOOLEAN` 대신 `INTEGER`) 메서드 이름만 기억하면 나머지는 자동으로 처리돼요.

```typescript
const i = qAlias(Item, "i");

qb.select([i.quantity.stringValue().as("qty_str")]);
// PG/SQLite:  CAST("i"."quantity" AS TEXT) AS "qty_str"
// MySQL:      CAST(`i`.`quantity` AS CHAR)  AS `qty_str`

qb.where(i.sku.intValue().gt(1000));
// PG/SQLite:  CAST("i"."sku" AS INTEGER) > ?
// MySQL:      CAST(`i`.`sku` AS SIGNED)  > ?
```

CAST 헬퍼는 `ColumnExpression`과 `ScalarExpression` 양쪽에 다 달려 있어요. `coalesce(u.price, 0).floatValue()`처럼 이미 파생된 스칼라에도 이어 붙일 수 있고, 결과도 `ScalarExpression`이라 `.as()` / `.eq()` / 중첩된 `coalesce`에 그대로 쓸 수 있어요.

| Kind     | MySQL      | PostgreSQL | SQLite    |
|----------|------------|------------|-----------|
| string   | `CHAR`     | `TEXT`     | `TEXT`    |
| int      | `SIGNED`   | `INTEGER`  | `INTEGER` |
| long     | `SIGNED`   | `BIGINT`   | `INTEGER` |
| float    | `DECIMAL`  | `REAL`     | `REAL`    |
| boolean  | `UNSIGNED` | `BOOLEAN`  | `INTEGER` |

##### 날짜 / 시각 컴포넌트 — `.year()` / `.month()` / `.day()` / `.hour()` / …

날짜나 타임스탬프 컬럼에서 일부 성분만 뽑아낼 수 있어요. 10개 메서드가 있어요: `year`, `month`, `day`(= `dayOfMonth`), `hour`, `minute`, `second`, `dayOfWeek`, `dayOfMonth`, `dayOfYear`, `week`. 결과는 `ScalarExpression`이라 SELECT / WHERE / HAVING에 모두 쓸 수 있고, `.as()` / cast / coalesce와 바로 이어 붙일 수 있어요.

```typescript
const e = qAlias(Event, "e");

qb.select([e.startsAt.year().as("yr"), e.id.count().as("total")])
  .groupBy(["e.startsAt"])
  .having(e.startsAt.year().gte(2026));
// PG:     CAST(EXTRACT(YEAR FROM "e"."starts_at") AS INTEGER) = ?
// MySQL:  YEAR(`e`.`starts_at`) = ?
// SQLite: CAST(strftime(?, "e"."starts_at") AS INTEGER) = ?   -- '%Y'
```

드라이버별 SQL 생성:

| 헬퍼 | MySQL | PostgreSQL | SQLite |
|------|-------|------------|--------|
| `year()` | `YEAR(col)` | `EXTRACT(YEAR FROM col)` | `strftime('%Y', col)` |
| `month()` | `MONTH(col)` | `EXTRACT(MONTH FROM col)` | `strftime('%m', col)` |
| `day()` / `dayOfMonth()` | `DAYOFMONTH(col)` | `EXTRACT(DAY FROM col)` | `strftime('%d', col)` |
| `hour()` | `HOUR(col)` | `EXTRACT(HOUR FROM col)` | `strftime('%H', col)` |
| `minute()` | `MINUTE(col)` | `EXTRACT(MINUTE FROM col)` | `strftime('%M', col)` |
| `second()` | `SECOND(col)` | `EXTRACT(SECOND FROM col)` | `strftime('%S', col)` |
| `dayOfWeek()` | `DAYOFWEEK(col)` | `EXTRACT(DOW FROM col)` | `strftime('%w', col)` |
| `dayOfYear()` | `DAYOFYEAR(col)` | `EXTRACT(DOY FROM col)` | `strftime('%j', col)` |
| `week()` | `WEEK(col)` | `EXTRACT(WEEK FROM col)` | `strftime('%W', col)` |

`dayOfWeek`와 `week`는 드라이버마다 인코딩이 살짝 달라요 — MySQL의 `DAYOFWEEK`은 1=일…7=토, PostgreSQL의 `DOW`는 0=일…6=토, SQLite의 `%w`는 PG와 같아요. 리포트 이식성이 중요하면 애플리케이션 계층에서 정규화하거나, 드라이버별 raw SQL을 쓰는 편이 안전해요.

##### 서브쿼리 비교 — `.in(subquery)` / `.eq(subquery)` / `exists` / `notExists`

`ColumnExpression.in()` / `.notIn()`은 값 배열뿐 아니라 `SelectQueryBuilder`도 받아요. 서브쿼리를 넘기면 `col IN (SELECT …)` 형태로 내려가고, 안쪽 파라미터 바인딩까지 그대로 보존돼요. `.eq` / `.neq` / `.gt` / `.gte` / `.lt` / `.lte`도 마찬가지로 (단일 값 반환) 서브쿼리를 받아 `col <op> (SELECT …)` 로 만들어요.

```typescript
const u = qAlias(User, "u");
const p = qAlias(Post, "p");

const activeAuthors = em
  .createQueryBuilder(Post, "p")
  .select(["authorId"])
  .where(p.status.eq("published"));

qb.where(u.id.in(activeAuthors));
// WHERE "u"."id" IN (SELECT "p"."authorId" FROM "post" AS "p"
//                     WHERE "p"."status" = ?)

// 스칼라 서브쿼리 — 집계와 비교
const avgViews = em
  .createQueryBuilder(Post, "p2")
  .selectRaw(["AVG(p2.views)"]);

qb.where(p.views.gt(avgViews));
// WHERE "p"."views" > (SELECT AVG(p2.views) FROM …)
```

`Expressions.exists(subQb)` / `Expressions.notExists(subQb)`는 상관 서브쿼리 조건을 만들어요.

```typescript
qb.where(Expressions.exists(em.createQueryBuilder(Post, "p")
  .select(["id"])
  .where(sql`"p"."author_id" = "u"."id"`)));
// WHERE EXISTS (SELECT "id" FROM "post" AS "p"
//                WHERE "p"."author_id" = "u"."id")
```

`ExistsCondition.not()`은 `NOT (…)`으로 감싸지 않고 내부의 `EXISTS` ↔ `NOT EXISTS` 플래그만 뒤집어요. SQL이 깔끔하게 나와요.

##### `CASE WHEN …` — `Expressions.caseBuilder()` / `Expressions.cases(...)`

SQL이 지원하는 두 종류의 CASE를 각각 전용 빌더로 제공해요.

**Searched CASE** — `caseBuilder()`. 조건 체인 형태로 쓰면 돼요. 각 분기는 `ConditionLike` + 결과값 쌍이고, 마지막에 `otherwise(default)`를 선택적으로 달고 `.end()`로 마무리해요.

```typescript
const u = qAlias(User, "u");

const tier = Expressions.caseBuilder()
  .when(u.score.gte(90)).then("gold")
  .when(u.score.gte(70)).then("silver")
  .otherwise("bronze")
  .end();

qb.select([tier.as("tier")]);
// SELECT CASE WHEN "u"."score" >= ? THEN ?
//             WHEN "u"."score" >= ? THEN ?
//             ELSE ? END AS "tier"
```

**Simple CASE** — `cases(subject)`. 값 매칭 스위치 스타일이에요.

```typescript
const weight = Expressions.cases(u.status)
  .when("active",  1)
  .when("pending", 0)
  .otherwise(-1)
  .end();

qb.select([weight.as("w")]);
// SELECT CASE "u"."status" WHEN ? THEN ?
//                           WHEN ? THEN ?
//                           ELSE ? END AS "w"
```

`end()`은 `ScalarExpression`을 돌려주니까 지금까지 본 모든 연산(cast / alias / 비교 / coalesce 등)에 그대로 이어 붙일 수 있어요.

오용 방어도 들어가 있어요. `.otherwise()` 뒤의 `.when()`, 중복 `.otherwise()`, WHEN 없이 `.end()` — 이 세 경우는 명확한 에러 메시지로 막히니까, 잘못된 SQL이 쿼리 실행까지 가지 않아요.

##### 조건 묶기 — `.and()` / `.or()` / `.not()`

조건 두 개를 AND로 묶거나, OR로 풀거나, 부정할 수 있어요.

```typescript
const u = qAlias(User, "u");

// (age >= 18) AND (status = 'active')
qb.where(u.age.gte(18).and(u.status.eq("active")));

// role이 admin이거나 owner
qb.where(u.role.eq("admin").or(u.role.eq("owner")));

// isNull을 부정 — isNotNull과 같은 뜻
qb.where(u.deletedAt.isNull().not());
```

체인 순서는 읽는 그대로예요. `a.and(b).or(c)`는 `(a AND b) OR c`로 묶여요.

그룹을 명시적으로 조정하고 싶으면 `Expressions` 헬퍼를 쓰세요.

```typescript
import { Expressions } from "@stingerloom/orm";

// (active이면서 admin) 이거나, 아니면 그냥 owner
qb.where(
  Expressions.or(
    Expressions.and(u.status.eq("active"), u.role.eq("admin")),
    u.role.eq("owner"),
  ),
);
```

이 `.and()` / `.or()`는 조건이면 무엇이든 받아요. 컬럼 비교든(`u.age.gte(18)`), 집계 비교든(`u.id.count().gt(10)`), 앞서 본 JSON 경로 조건이든(`u.profile.tags.contains("admin")`) 섞어서 묶을 수 있어요.

```typescript
qb.where(
  Expressions.and(
    u.status.eq("active"),
    u.profile.tags.contains("admin"),   // JSON 경로 조건도 같이 들어감
  ),
);
```

작은 편의 하나. 연속 AND나 연속 OR은 출력 SQL에서 괄호가 한 번만 쳐져요. `a.and(b).and(c).and(d)`라고 써도 `(a AND b AND c AND d)` 하나로 평평해져요.

##### 문자열 매칭 — `.startsWith` / `.endsWith` / `.contains`

이건 LIKE 패턴을 대신 만들어 주는 메서드예요. "왜 필요한가"부터 보는 게 빠른데, 이런 코드를 생각해 보세요.

```typescript
// 검색창 입력값을 그대로 LIKE에 넣는다면?
qb.where("name", "LIKE", `${userInput}%`);
```

여기서 `userInput`이 `"50%"`라면 쿼리는 `name LIKE '50%%'`가 돼요. 그러면 `"50abc"`, `"50 off"`, `"500"` 전부 매칭돼요. 사용자는 **진짜 "50%"라는 글자**를 찾고 싶었는데 말이죠.

`.startsWith()` / `.endsWith()` / `.contains()`는 이런 함정을 막아요.

```typescript
qb.where(u.name.startsWith("50%"));
// 내부적으로 "50\%" 라는 이스케이프된 패턴을 만들어서
// name LIKE '50\%%' ESCAPE '\'  로 나감
// → "50%로 시작하는" 이름만 매칭 (50%로 찾는 사람들 안전)
```

`%`, `_`, `\` 같은 LIKE의 특수문자를 사용자가 입력해도 전부 리터럴로 처리돼요.

일반적인 경우도 물론 잘 써먹을 수 있어요.

```typescript
qb.where(u.name.startsWith("Al"));    // "Al"로 시작
qb.where(u.name.endsWith("son"));     // "son"으로 끝
qb.where(u.name.contains("lic"));     // 중간에 "lic" 포함
```

##### 대소문자 무시 — `*IgnoreCase`

같은 세트에 `IgnoreCase` 버전이 있어요. 문자열 매칭이지만 대소문자를 구분하지 않아요.

```typescript
qb.where(u.username.equalsIgnoreCase("alice"));   // 정확히 일치, 대소문자만 무시
qb.where(u.email.containsIgnoreCase("@gmail"));   // 포함, 대소문자 무시
qb.where(u.email.startsWithIgnoreCase("admin@"));
qb.where(u.email.endsWithIgnoreCase(".com"));
qb.where(u.name.likeIgnoreCase("%Al%"));          // 와일드카드를 직접 쓰고 싶을 때
```

여기도 드라이버별로 내부 동작이 달라요 — PostgreSQL은 `ILIKE`를 가지고 있어서 그걸 바로 쓰고, MySQL과 SQLite는 `LOWER()`를 양쪽에 씌워요. 컬럼 콜레이션이 대소문자 구분이든 아니든 결과가 똑같이 나오도록 맞춰 줘요. 코드는 드라이버에 상관없이 한 줄로 끝나요.

##### 한눈에 보기

| 하고 싶은 일              | 메서드                                                                         |
|---------------------------|-------------------------------------------------------------------------------|
| 정렬 방향 지정            | `.asc()`, `.desc()`                                                           |
| null 위치 지정            | 위 두 개에 이어서 `.nullsFirst()` / `.nullsLast()`                            |
| 값 집계                   | `.count()`, `.countDistinct()`, `.sum()`, `.avg()`, `.min()`, `.max()`        |
| 집계 결과로 필터          | 집계 뒤에 `.gt(10)`, `.eq(0)`, `.between(1, 100)` 등 평소대로                 |
| SELECT 별칭               | `.as("name")` — 컬럼 / JSON 경로 / 집계 어디에든 붙여서 `AliasedExpression` 반환 |
| null fallback             | `coalesce(...)`, `col.coalesce(...)`, `nullif(a, b)` — 첫 non-null 값 / 일치 시 NULL 변환 |
| 현재 날짜 / 시각          | `currentDate()`, `currentTime()`, `currentTimestamp()` — `Expressions`에도 있음                 |
| 타입 변환                 | `.stringValue()`, `.intValue()`, `.longValue()`, `.floatValue()`, `.booleanValue()`             |
| 날짜 컴포넌트             | `.year()`, `.month()`, `.day()`, `.hour()`, `.minute()`, `.second()`, `.dayOfWeek()`, `.dayOfYear()`, `.week()` |
| 서브쿼리 비교             | `.in(subQb)`, `.notIn(subQb)`, `.eq/.neq/.gt/.gte/.lt/.lte(subQb)`, `Expressions.exists`, `Expressions.notExists` |
| CASE 표현식               | `Expressions.caseBuilder().when(...).then(...).otherwise(...).end()`; `Expressions.cases(subject)...end()`     |
| 조건 묶기                 | `.and(other)`, `.or(other)`, `.not()`                                         |
| 그룹을 직접 짜고 싶을 때  | `Expressions.and(...)`, `Expressions.or(...)`, `Expressions.not(cond)`        |
| 안전한 prefix / suffix / 포함 | `.startsWith`, `.endsWith`, `.contains` (LIKE 특수문자 자동 이스케이프)   |
| 대소문자 무시 매칭        | 위 이름 뒤에 `IgnoreCase`, 그리고 `.equalsIgnoreCase`, `.likeIgnoreCase`      |

### JOIN — 테이블 결합

여기서 query builder의 진가가 나타나요. Stingerloom은 세 단계의 JOIN을 지원해요.

#### `alias()` — 타입 안전한 컬럼 참조

조인을 설명하기 전에, 크로스 엔티티 쿼리를 type-safe하게 만드는 헬퍼를 소개할게요.

테이블을 조인하면 여러 엔티티의 컬럼을 참조하게 돼요 — `"p.authorId"`, `"u.firstName"` 등. 이런 문자열에는 자동 완성이 안 돼요. `alias()` 함수가 이걸 해결해요:

```typescript
import { alias } from "@stingerloom/orm";

const p = alias(Post, "p");
const u = alias(User, "u");

p.col("authorId");   // "p.authorId" 반환 — 자동 완성 ✓
u.col("firstName");  // "u.firstName" 반환 — 자동 완성 ✓
u.col("typo");       // ✗ 컴파일 에러 — "typo"는 User의 키가 아님
```

`alias()`는 타입이 지정된 참조를 만들어요. `.col()` 메서드의 인자가 `keyof T`로 제한되므로 TypeScript가 프로퍼티명을 자동 완성해요. 런타임에는 `"alias.property"` 문자열을 반환하고, query builder의 alias 레지스트리가 실제 DB 컬럼명으로 변환해요.

`alias()` 참조는 어디서든 쓸 수 있어요 — `where()`, `selectRaw()`, `addOrderBy()`, `whereIn()`, `JoinOnBuilder.on()` 등.

#### `qAlias()` — QueryDSL 스타일 표현식

더 직관적인 API를 원한다면, `qAlias()`로 엔티티 프로퍼티에 직접 접근하고 조건 메서드를 체이닝할 수 있어요 — JPA QueryDSL의 `QUser` 클래스와 비슷하지만, 코드 생성이 필요 없어요.

```typescript
import { qAlias } from "@stingerloom/orm";

const u = qAlias(User, "u");
const p = qAlias(Post, "p");

const posts = await em
  .createQueryBuilder(Post, "p")
  .leftJoin(User, "u", (j) => j.on(p.col("authorId"), "=", u.col("id")))
  .where(u.firstName.eq("Alice"))           // u.firstName 자동 완성 ✓
  .where(u.age.gte(18))                     // .gte() → >= 연산자
  .where(p.status.in(["active", "draft"]))  // .in() → IN (...)
  .where(u.deletedAt.isNull())              // .isNull() → IS NULL
  .getRawMany();
```

모든 엔티티 프로퍼티가 이 메서드들을 가진 `ColumnExpression`이 돼요:

| Method | SQL | 예시 |
|--------|-----|------|
| `.eq(value)` | `= ?` | `u.name.eq("Alice")` |
| `.neq(value)` | `!= ?` | `u.role.neq("guest")` |
| `.gt(value)` | `> ?` | `u.age.gt(18)` |
| `.gte(value)` | `>= ?` | `u.age.gte(18)` |
| `.lt(value)` | `< ?` | `u.age.lt(65)` |
| `.lte(value)` | `<= ?` | `u.age.lte(65)` |
| `.like(pattern)` | `LIKE ?` | `u.name.like("%John%")` |
| `.notLike(pattern)` | `NOT LIKE ?` | `u.name.notLike("%bot%")` |
| `.in(values)` | `IN (?, ?, ...)` | `u.id.in([1, 2, 3])` |
| `.notIn(values)` | `NOT IN (...)` | `u.id.notIn([999])` |
| `.isNull()` | `IS NULL` | `u.deletedAt.isNull()` |
| `.isNotNull()` | `IS NOT NULL` | `u.email.isNotNull()` |
| `.between(min, max)` | `BETWEEN ? AND ?` | `u.age.between(18, 65)` |

각 메서드는 `ColumnCondition`을 반환하고, query builder가 alias 레지스트리를 통해 해석해요 — SnakeNamingStrategy도 완벽하게 지원해요.

`qAlias()`는 `alias()`의 `.col()`도 지원하므로, 스타일을 섞어 쓸 수 있어요:

```typescript
const u = qAlias(User, "u");
qb.where(u.firstName.eq("Alice"))     // QueryDSL 스타일
  .addOrderBy(u.col("lastName"), "ASC") // alias() 스타일 — 둘 다 동작
```

#### Entity-Aware Join (추천)

테이블 조인의 가장 좋은 방법은 **엔티티 클래스**를 직접 전달하는 거예요. ORM이 테이블명을 자동으로 해석하고, `alias()`로 camelCase 프로퍼티명을 자동 완성할 수 있어요.

```typescript
const p = alias(Post, "p");
const u = alias(User, "u");

const posts = await em
  .createQueryBuilder(Post, "p")
  .leftJoin(User, "u", (join) =>
    join.on(p.col("authorId"), "=", u.col("id"))
  )
  .selectRaw([p.col("title"), u.col("name")])
  .where(u.col("age"), ">=", 18)
  .orderBy({ createdAt: "DESC" })
  .limit(20)
  .getRawMany();
```

- `leftJoin(User, "u", ...)` — 첫 번째 인자가 **엔티티 클래스**예요. ORM이 실제 테이블명(`user`)을 자동 해석하고, `"u"` alias를 내부 레지스트리에 등록해요.
- `join.on(p.col("authorId"), "=", u.col("id"))` — ON 조건에서 **타입이 지정된 프로퍼티 참조**를 사용해요. `SnakeNamingStrategy` 사용 시 `authorId` → `author_id`로 자동 변환돼요.
- `selectRaw([p.col("title"), u.col("name")])` — 자동 완성이 되는 크로스 엔티티 컬럼 선택이에요.
- `where(u.col("age"), ">=", 18)` — WHERE 조건에서도 조인된 엔티티의 컬럼을 자동 완성으로 참조할 수 있어요.

::: tip
자동 완성 없이 문자열로 직접 작성할 수도 있어요 — `where("u.age", ">=", 18)`. 런타임에서 두 형태는 동일해요.
:::

`JoinOnBuilder` 콜백은 여러 조건과 리터럴 값을 지원해요:

```typescript
qb.leftJoin(User, "u", (join) =>
  join
    .on(p.col("authorId"), "=", u.col("id"))       // 컬럼 = 컬럼
    .andOn(u.col("status"), "=", p.col("status"))   // 추가 조건
    .onVal(u.col("isActive"), "=", true)             // 컬럼 = 리터럴 값
);
```

#### Relation 기반 Join (ON 자동 생성)

`@ManyToOne` / `@OneToMany` / `@OneToOne` 데코레이터가 있으면 ON 조건을 생략할 수 있어요. ORM이 relation 메타데이터에서 자동으로 생성해요.

```typescript
// Post에 @ManyToOne(() => User) author: User; 가 있다면

const posts = await em
  .createQueryBuilder(Post, "p")
  .leftJoinRelation("author", "u")     // 자동: ON p.author_id = u.id
  .where("u.name", "LIKE", "%John%")
  .getMany();
```

양방향 모두 동작해요:

```typescript
// User에 @OneToMany(() => Post, { mappedBy: "author" }) posts: Post[]; 가 있다면

const users = await em
  .createQueryBuilder(User, "u")
  .leftJoinRelation("posts", "p")      // 자동: ON u.id = p.author_id
  .where("p.status", "published")
  .getMany();
```

`innerJoinRelation()`도 사용할 수 있어요.

#### JoinAndSelect — Join + 자동 SELECT

조인된 엔티티의 모든 컬럼을 결과에 포함하고 싶을 때 `*AndSelect` 변형을 사용하세요. 조인 + 모든 컬럼 수동 선택을 한 번에 해줘요.

```typescript
// 수동: join + selectRaw
qb.leftJoin(User, "u", (j) => j.on("p.authorId", "=", "u.id"))
  .selectRaw(["p.id", "p.title", "u.id", "u.name", "u.email"]);

// 자동: joinAndSelect
const results = await em
  .createQueryBuilder(Post, "p")
  .leftJoinAndSelect(User, "u", (j) => j.on("p.authorId", "=", "u.id"))
  .where("p.status", "published")
  .getRawMany();
```

모든 `*AndSelect` 변형:

| Method | 설명 |
|--------|------|
| `leftJoinAndSelect(Entity, alias, onBuilder)` | LEFT JOIN + 조인된 컬럼 자동 SELECT |
| `innerJoinAndSelect(Entity, alias, onBuilder)` | INNER JOIN + 조인된 컬럼 자동 SELECT |
| `leftJoinRelationAndSelect(property, alias)` | Relation LEFT JOIN + 자동 SELECT |
| `innerJoinRelationAndSelect(property, alias)` | Relation INNER JOIN + 자동 SELECT |

Relation 기반 예제:

```typescript
const results = await em
  .createQueryBuilder(Post, "p")
  .leftJoinRelationAndSelect("author", "u")
  .getRawMany();
```

#### String 기반 Join (Raw)

엔티티 메타데이터가 없는 경우(view, 서브쿼리, raw 테이블 조인)에는 여전히 문자열 테이블명을 전달할 수 있어요.

```typescript
qb.leftJoin("audit_log", "al", sql`"p"."id" = "al"."post_id"`);
```

#### 멀티 테이블 Join

여러 조인을 체이닝해서 엔티티 그래프를 탐색할 수 있어요:

```typescript
const p = qAlias(Post, "p");
const u = qAlias(User, "u");
const c = qAlias(Comment, "c");

const results = await em
  .createQueryBuilder(Post, "p")
  .leftJoin(User, "u", (j) => j.on(p.col("authorId"), "=", u.col("id")))
  .leftJoin(Comment, "c", (j) => j.on(c.col("postId"), "=", p.col("id")))
  .selectRaw([p.col("title"), u.col("name"), c.col("content")])
  .where(u.age.gte(18))                   // QueryDSL 스타일
  .where(c.content.isNotNull())            // QueryDSL 스타일
  .addOrderBy(u.col("name"), "ASC")
  .limit(50)
  .getRawMany();
```

#### Cross-Entity 컬럼 해석

엔티티 조인(entity-aware 또는 relation 기반) 후, 어디서든 컬럼을 참조할 수 있어요.

**`qAlias()` 사용 (QueryDSL 스타일):**

```typescript
const u = qAlias(User, "u");
const p = qAlias(Post, "p");

// WHERE — QueryDSL 표현식 (프로퍼티 + 연산자 자동 완성)
qb.where(u.name.eq("Alice"));                     // equals
qb.where(u.age.gte(18));                           // >=
qb.where(u.id.in([1, 2, 3]));                     // IN
qb.where(u.deletedAt.isNull());                   // IS NULL
qb.where(u.email.isNotNull());                    // IS NOT NULL
qb.where(u.age.between(18, 65));                  // BETWEEN
qb.where(u.name.like("%alice%"));                 // LIKE

// SELECT — .col()로 컬럼 참조
qb.selectRaw([p.col("title"), u.col("name")]);
qb.addSelect(u.col("email"), "authorEmail");

// ORDER BY / GROUP BY
qb.addOrderBy(u.col("name"), "ASC");
qb.groupBy([u.col("id"), p.col("category")]);
```

**`alias()` 사용 (.col() 스타일):**

```typescript
const u = alias(User, "u");
qb.where(u.col("name"), "Alice");
qb.where(u.col("age"), ">=", 18);
```

모든 참조는 alias 레지스트리를 통해 해석돼요 — `u.col("firstName")` 또는 `u.firstName.eq(...)` 모두 `SnakeNamingStrategy` 사용 시 `"u"."first_name"`으로 변환돼요.

#### Join 타입 요약

| Method | SQL | 언제 쓰나요 |
|--------|-----|-------------|
| `leftJoin()` | `LEFT JOIN` | 조인 테이블에 매칭이 없어도 행을 포함할 때 |
| `innerJoin()` | `INNER JOIN` | 양쪽 테이블 모두 매칭되는 행만 필요할 때 |
| `rightJoin()` | `RIGHT JOIN` | 조인 테이블의 모든 행을 포함할 때 |
| `leftJoinRelation()` | `LEFT JOIN` | `@ManyToOne` / `@OneToMany` 메타데이터로 ON 자동 생성 |
| `innerJoinRelation()` | `INNER JOIN` | relation 메타데이터로 ON 자동 생성 |

### ORDER BY와 페이지네이션

정렬과 페이지네이션은 예상하는 대로 동작해요.

```typescript
// Type-safe ORDER BY — column names auto-complete
qb.orderBy({ createdAt: "DESC", name: "ASC" });

// LIMIT and OFFSET
qb.limit(10).offset(20);

// Or use the skip/take aliases (same effect)
qb.skip(20).take(10);
```

데이터와 전체 개수가 둘 다 필요하다면? `getManyAndCount()`가 두 쿼리를 병렬로 실행하고 `[T[], number]`를 반환해요.

```typescript
const [users, total] = await em
  .createQueryBuilder(User, "u")
  .where("isActive", true)
  .orderBy({ createdAt: "DESC" })
  .skip(20)
  .take(10)
  .getManyAndCount();

console.log(users.length); // up to 10
console.log(total);        // e.g. 235
```

### GROUP BY와 집계

카테고리별 게시글 수를 세고 싶다고 해볼게요. GROUP BY가 필요해요.

```typescript
import sql from "sql-template-tag";

const stats = await em
  .createQueryBuilder(Post, "p")
  .select(["category"])
  .addSelect(sql`COUNT(*)`, "postCount")
  .groupBy(["category"])
  .having(sql`COUNT(*) >= ${5}`)
  .getRawMany();
// [{ category: "tech", postCount: 42 }, { category: "life", postCount: 17 }, ...]
```

`groupBy()`는 컬럼명 배열을 받아요 (type-safe). `having()`은 집계 후 그룹을 필터링해요 — 여기서는 5개 이상의 게시글이 있는 카테고리만 남겨요.

#### SELECT에서 집계 함수 사용하기

`addSelect()`에 `sql` 템플릿 리터럴을 전달하면 집계 컬럼을 추가할 수 있어요. alias가 결과 객체의 키가 돼요.

```typescript
import sql from "sql-template-tag";

const stats = await em
  .createQueryBuilder(Order, "o")
  .addSelect(sql`AVG("o"."price")`, "avgPrice")
  .addSelect(sql`SUM("o"."price")`, "totalRevenue")
  .addSelect(sql`MIN("o"."price")`, "cheapest")
  .addSelect(sql`MAX("o"."price")`, "mostExpensive")
  .addSelect(sql`COUNT(*)`, "orderCount")
  .getRawMany();
// [{ avgPrice: 42.5, totalRevenue: 850, cheapest: 10, mostExpensive: 99, orderCount: 20 }]
```

그룹화된 엔티티 컬럼과 집계 컬럼을 함께 쓸 수도 있어요:

```typescript
const salesByCategory = await em
  .createQueryBuilder(Product, "p")
  .select(["category"])
  .addSelect(sql`AVG("p"."price")`, "avgPrice")
  .addSelect(sql`COUNT(*)`, "productCount")
  .groupBy(["category"])
  .having(sql`AVG("p"."price") > ${50}`)
  .orderBy({ category: "ASC" })
  .getRawMany();
// [{ category: "electronics", avgPrice: 299.99, productCount: 15 }, ...]
```

엔티티 인식 조인과 함께 사용하면 관련 테이블을 넘나드는 집계도 가능해요:

```typescript
const p = qAlias(Post, "p");
const u = qAlias(User, "u");

const authorStats = await em
  .createQueryBuilder(Post, "p")
  .leftJoin(User, "u", (join) => join.on(p.col("authorId"), "=", u.col("id")))
  .selectRaw([u.col("name")])
  .addSelect(sql`COUNT(*)`, "postCount")
  .addSelect(sql`AVG("p"."likeCount")`, "avgLikes")
  .groupBy([u.col("name")])
  .having(sql`COUNT(*) >= ${3}`)
  .addOrderBy("postCount", "DESC")
  .getRawMany();
// [{ name: "Alice", postCount: 12, avgLikes: 45.3 }, ...]
```

### 서브쿼리

Query builder는 WHERE, SELECT, FROM 절에서 서브쿼리를 지원해요. `find()`로는 서브쿼리를 표현할 수 없지만, query builder에서는 간단해요.

#### WHERE IN 서브쿼리

`Conditions.inSubquery()`를 사용하거나 다른 query builder에서 빌드한 `Sql` 객체를 전달해요:

```typescript
import sql from "sql-template-tag";
import { Conditions } from "@stingerloom/orm";

// 한국 작성자의 게시글 찾기
const subquery = em
  .createQueryBuilder(User, "u")
  .select(["id"])
  .where("country", "KR")
  .toSql();

const posts = await em
  .createQueryBuilder(Post, "p")
  .where(Conditions.inSubquery(`"p"."authorId"`, sql`(${subquery})`))
  .getMany();
```

#### WHERE EXISTS / NOT EXISTS

상관 서브쿼리에는 `Conditions.exists()` 또는 `Conditions.notExists()`를 사용해요:

```typescript
// 발행된 게시글이 하나 이상 있는 작성자 찾기
const authors = await em
  .createQueryBuilder(User, "a")
  .where(Conditions.exists(sql`(SELECT 1 FROM "post" "p" WHERE "p"."author_id" = "a"."id" AND "p"."status" = ${"published"})`))
  .getMany();
```

#### SELECT 절 스칼라 서브쿼리

`addSelect()`로 계산 컬럼으로서 스칼라 서브쿼리를 추가할 수 있어요:

```typescript
const authors = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name"])
  .addSelect(
    sql`(SELECT COUNT(*) FROM "post" "p" WHERE "p"."author_id" = "u"."id")`,
    "postCount",
  )
  .getRawMany();
// [{ id: 1, name: "Alice", postCount: 5 }, { id: 2, name: "Bob", postCount: 0 }]
```

#### FROM 서브쿼리 (파생 테이블)

`asSubquery()`로 SelectQueryBuilder를 파생 테이블로 변환하고, RawQueryBuilder로 쿼리해요:

```typescript
// 1단계: 내부 쿼리 빌드
const inner = em
  .createQueryBuilder(Post, "p")
  .select(["authorId"])
  .addSelect(sql`COUNT(*)`, "cnt")
  .groupBy(["authorId"]);

// 2단계: 파생 테이블로 사용
const qb = em.createQueryBuilder();
const results = await em.query(
  qb
    .select(['"sub"."authorId"', '"sub"."cnt"'])
    .from(inner.asSubquery("sub").sql)
    .where([sql`"sub"."cnt" >= ${3}`])
    .build()
);
// 게시글 3개 이상인 작성자
```

#### CTE (Common Table Expressions)

복잡한 다단계 쿼리에는 RawQueryBuilder의 CTE를 사용해요:

```typescript
const qb = em.createQueryBuilder();

const results = await em.query(
  qb
    .with("active_authors", (sub) =>
      sub
        .select(['DISTINCT "authorId"'])
        .from('"post"')
        .where([sql`"status" = ${"published"}`])
    )
    .select(['"u"."id"', '"u"."name"'])
    .from('"user" "u"')
    .where([sql`"u"."id" IN (SELECT "authorId" FROM "active_authors")`])
    .build()
);
```

재귀 CTE(댓글 스레드나 조직도 같은 계층 데이터)는 [Raw SQL & CTE](./raw-sql.md) 가이드를 참고하세요.

### DISTINCT

중복 없는 행만 원할 때 DISTINCT를 활성화해요.

```typescript
const uniqueCities = await em
  .createQueryBuilder(User, "u")
  .select(["city"])
  .setDistinct()
  .getPartialMany();
// SELECT DISTINCT "u"."city" FROM "user" AS "u"
```

결과 집합에서 중복 행을 제거해요. 컬럼 일부만 선택할 때 같은 값을 공유하는 행이 많으면 유용해요.

### Pessimistic Locking

동시성이 높은 상황에서는 다른 트랜잭션이 수정하지 못하도록 읽기 시 행을 잠가야 할 때가 있어요.

```typescript
const user = await em
  .createQueryBuilder(User, "u")
  .where("id", 1)
  .forUpdate()
  .getOne();
// SELECT ... FROM "user" AS "u" WHERE "u"."id" = $1 FOR UPDATE
```

`forUpdate()`는 `FOR UPDATE` — exclusive lock을 추가해요. 트랜잭션이 커밋될 때까지 다른 트랜잭션이 이 행을 읽거나 수정할 수 없어요. `forShare()`는 shared lock을 추가해요 — 다른 트랜잭션이 읽을 순 있지만 쓸 수는 없어요.

| Method | SQL | 효과 |
|--------|-----|------|
| `forUpdate()` | `FOR UPDATE` | Exclusive lock — 읽기/쓰기 모두 차단 |
| `forShare()` | `FOR SHARE` / `LOCK IN SHARE MODE` | Shared lock — 쓰기만 차단 |

#### NOWAIT과 SKIP LOCKED

동시성이 높은 시나리오에서 락을 기다리는 건 병목이 될 수 있어요. 두 가지 고급 잠금 옵션으로 행이 이미 잠겨 있을 때의 동작을 제어할 수 있어요.

**NOWAIT** — 락이 해제되길 기다리는 대신 즉시 에러를 던져요.

```typescript
const user = await em
  .createQueryBuilder(User, "u")
  .where("id", 1)
  .forUpdateNowait()
  .getOne();
// SELECT ... FOR UPDATE NOWAIT
// 다른 트랜잭션이 행을 잠그고 있으면 즉시 에러 발생
```

**SKIP LOCKED** — 이미 잠긴 행을 조용히 건너뛰어요. 여러 워커가 같은 테이블에서 작업을 가져가는 잡 큐 패턴에 특히 유용해요.

```typescript
// 워커가 다음 잠기지 않은 작업을 가져감
const job = await em
  .createQueryBuilder(Job, "j")
  .where("status", "pending")
  .orderBy({ createdAt: "ASC" })
  .limit(1)
  .forUpdateSkipLocked()
  .getOne();
// SELECT ... ORDER BY ... LIMIT 1 FOR UPDATE SKIP LOCKED
// 모든 대기 작업이 다른 워커에 의해 잠겨 있으면 null 반환
```

네 가지 조합을 모두 사용할 수 있어요:

| Method | SQL |
|--------|-----|
| `forUpdateNowait()` | `FOR UPDATE NOWAIT` |
| `forUpdateSkipLocked()` | `FOR UPDATE SKIP LOCKED` |
| `forShareNowait()` | `FOR SHARE NOWAIT` |
| `forShareSkipLocked()` | `FOR SHARE SKIP LOCKED` |

::: warning
NOWAIT과 SKIP LOCKED는 MySQL 8.0+ 또는 PostgreSQL 9.5+가 필요해요. SQLite는 비관적 잠금을 지원하지 않고 `UNSUPPORTED_DATABASE` 에러를 던져요.
:::

### Index Hints

MySQL에서는 쿼리 플래너가 사용할 인덱스를 제안할 수 있어요. 플래너가 최적이 아닌 인덱스를 선택할 때 유용해요.

```typescript
const orders = await em
  .createQueryBuilder(Order, "o")
  .where("status", "pending")
  .useIndex("idx_order_status")
  .getMany();
// MySQL: SELECT ... FROM `order` USE INDEX (`idx_order_status`) WHERE ...
```

세 가지 MySQL 인덱스 힌트 타입을 사용할 수 있어요:

| Method | SQL | 효과 |
|--------|-----|------|
| `useIndex(name)` | `USE INDEX (name)` | 플래너에 인덱스 제안 |
| `forceIndex(name)` | `FORCE INDEX (name)` | 플래너가 이 인덱스를 강제로 사용하도록 |
| `ignoreIndex(name)` | `IGNORE INDEX (name)` | 플래너가 이 인덱스를 건너뛰도록 |

PostgreSQL에서는 `hint()` 메서드로 [pg_hint_plan](https://pg-hint-plan.readthedocs.io/) 스타일 힌트를 추가할 수 있어요:

```typescript
const orders = await em
  .createQueryBuilder(Order, "o")
  .where("status", "pending")
  .hint("IndexScan(o idx_order_status)")
  .getMany();
// PostgreSQL: /*+ IndexScan(o idx_order_status) */ SELECT ...
```

### Soft Delete 처리

엔티티에 `@DeletedAt` 컬럼이 있으면, query builder가 자동으로 soft-deleted 행을 제외해요. 포함하려면:

```typescript
qb.withDeleted();
```

### 결과 검증 — validate()

컴파일 타임 타입 narrowing이 많은 실수를 잡아주지만, 데이터베이스가 실제로 반환하는 값까지는 확인할 수 없어요. 문자열을 기대한 컬럼에 `null`이 올 수도 있고, 드라이버 동작 때문에 숫자가 문자열로 올 수도 있거든요. 런타임 안전성을 위해 **validator**를 붙여서 모든 행을 애플리케이션 코드에 도달하기 전에 체크할 수 있어요.

가장 간단한 형태는 일반 함수예요:

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name"])
  .validate((row) => {
    if (!row.name) throw new Error("name must not be empty");
    return row;
  })
  .getPartialMany();
```

각 행이 validator를 통과해요. 함수가 throw하면 전체 호출이 해당 에러로 reject돼요. 성공하면 결과에 포함돼요. 기본값은 validator 없음 — 오버헤드 제로예요. Validator는 `getPartialMany()`와 `getMany()` 모두에서 동작해요.

Validator 함수로 데이터 **변환**도 할 수 있어요. 반환한 값이 실제 결과가 돼요:

```typescript
.validate((row) => ({
  ...row,
  name: row.name.trim().toLowerCase(),
}))
```

#### Zod로 Schema Validation 하기

검증 함수를 직접 작성하는 건 번거로워요. [zod](https://zod.dev)를 쓴다면 스키마를 직접 넘길 수 있어요 — query builder는 `.parse()` 메서드가 있는 객체를 인식해요.

```typescript
import { z } from "zod";

const UserRow = z.object({
  id: z.number(),
  name: z.string().min(1),
});

const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name"])
  .validate(UserRow)
  .getPartialMany();
```

행이 zod 스키마를 통과하지 못하면, 어떤 필드가 왜 실패했는지 상세한 `ZodError`가 throw돼요. 문자열을 기대한 곳에 NULL이 오거나, 숫자를 기대한 곳에 문자열이 오는 등의 데이터 문제를 가장 빠른 시점에 잡아줘요.

Zod의 `.transform()`도 사용 가능해요. 검증과 데이터 변환을 한 번에 할 수 있어요:

```typescript
const NormalizedUser = z.object({
  id: z.number(),
  name: z.string().transform((s) => s.toUpperCase()),
  email: z.string().email(),
});

const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name", "email"])
  .validate(NormalizedUser)
  .getPartialMany();
// [{ id: 1, name: "ALICE", email: "alice@example.com" }, ...]
```

`.strict()`는 예상치 못한 추가 필드가 있는 행을 거부해요 — schema drift를 감지하는 데 유용해요:

```typescript
const StrictUser = z.object({ id: z.number(), name: z.string() }).strict();

// Throws if the DB returns columns beyond id and name
.validate(StrictUser)
```

`.parse(data)` 메서드를 제공하는 라이브러리라면 뭐든 호환돼요 — zod뿐만 아니라 io-ts, superstruct 등도 가능해요.

#### 배열 단위 검증 — validateArray()

개별 행이 아닌 결과 집합 전체를 검증해야 할 때도 있어요. 최대 결과 수를 제한하거나, 배열이 비어있지 않은지 확인하는 경우예요.

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name"])
  .validateArray((rows) => {
    if (rows.length === 0) throw new Error("expected at least one user");
    if (rows.length > 1000) throw new Error("result set too large");
    return rows;
  })
  .getPartialMany();
```

Zod 배열 스키마도 사용할 수 있어요:

```typescript
const UsersArray = z
  .array(z.object({ id: z.number(), name: z.string() }))
  .min(1)
  .max(100);

const users = await qb
  .select(["id", "name"])
  .validateArray(UsersArray)
  .getPartialMany();
```

#### 행 검증과 배열 검증 결합하기

같은 쿼리에 `validate()`와 `validateArray()`를 함께 쓸 수 있어요. 행 단위 검증이 먼저 실행되고, 그다음 배열 단위 검증이 실행돼요:

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name"])
  .validate(z.object({             // 1. Each row: validate + transform
    id: z.number(),
    name: z.string().transform((s) => s.trim()),
  }))
  .validateArray((rows) => {       // 2. Whole array: check constraints
    if (rows.length > 100) throw new Error("too many results");
    return rows;
  })
  .getPartialMany();
```

#### 언제 검증을 사용할까요

검증은 행마다 함수 호출이 추가되므로 공짜가 아니에요. 효과가 있는 상황은 이래요:

| 상황 | 검증? | 이유 |
|------|-------|------|
| 내부 서비스, 신뢰할 수 있는 스키마 | No | 속도가 더 중요해요 |
| 사용자 데이터를 반환하는 API 엔드포인트 | Yes | null/타입 불일치를 클라이언트에 도달하기 전에 잡아요 |
| 느슨한 소스 데이터를 다루는 ETL 파이프라인 | Yes | 잘못된 데이터 전파를 방지해요 |
| 역직렬화 버그 디버깅 | Yes (일시적으로) | 정확히 어떤 행/필드가 문제인지 특정해요 |

기본값 — validator 없음, 오버헤드 제로 — 이 대부분의 내부 쿼리에 맞는 선택이에요. 데이터가 신뢰 경계를 넘는 곳에서 검증을 추가하세요.

### 쿼리 실행하기

쿼리를 만들었으니 실행해야겠죠. Query builder는 안전성과 타이핑 보장 수준이 다른 세 단계의 실행 메서드를 제공해요.

**Safe — required 컬럼 검증이 있는 클래스 인스턴스:**

| Method | Returns | 설명 |
|--------|---------|------|
| `getMany()` | `T[]` | 클래스 인스턴스. `select()` 사용 시 required 컬럼 검증 |
| `getOne()` | `T \| null` | 단일 클래스 인스턴스 또는 null (자동으로 LIMIT 1 추가) |
| `getOneOrFail()` | `T` | 단일 클래스 인스턴스 (결과 없으면 `EntityNotFoundError` 발생) |
| `getManyAndCount()` | `[T[], number]` | 클래스 인스턴스 + 총 개수를 병렬 실행 |

항상 행을 엔티티 클래스 인스턴스로 역직렬화해요. `instanceof`가 동작하고, 클래스 메서드를 쓸 수 있고, `em.save()`에 전달할 수 있어요. `select()`로 특정 컬럼을 지정하면, non-nullable 컬럼이 포함되어야 해요 — 아니면 `OrmError`가 throw돼요.

**Partial — typed plain object (Pick):**

| Method | Returns | 설명 |
|--------|---------|------|
| `getPartialMany()` | `TResult[]` | `Pick<T, K>` narrowing된 plain object |
| `getPartialOne()` | `TResult \| null` | 단일 plain object 또는 null |
| `getPartialManyAndCount()` | `[TResult[], number]` | Plain object + 총 개수 |

역직렬화 없음, required 컬럼 검증 없음. `select(["id", "name"])` 사용 시 반환 타입이 `Pick<T, "id" | "name">[]`로 좁혀져요 — 선택하지 않은 컬럼에 접근하면 컴파일 에러예요. `em.save()`에 전달하지 마세요.

**Raw — untyped plain object:**

| Method | Returns | 설명 |
|--------|---------|------|
| `getRawMany()` | `Record<string, unknown>[]` | Untyped plain object |
| `getRawOne()` | `Record<string, unknown> \| null` | 단일 untyped object 또는 null |

결과에 엔티티에 없는 computed column이 포함될 때 사용해요 (예: `addSelect(sql`COUNT(*)`, "cnt")`). 타입 정보 없음, 역직렬화 없음.

**Utility (변경 없음):**

| Method | Returns | 설명 |
|--------|---------|------|
| `getCount()` | `number` | 같은 WHERE/JOIN으로 COUNT(*) |
| `exists()` | `boolean` | 매칭되는 행이 있는지 여부 |

**어떤 걸 써야 할까요?** 기본적으로 `getMany()`를 쓰세요. 컴파일 타임 narrowing이 필요한 read-only DTO에는 `getPartialMany()`를 쓰세요. `addSelect`나 computed column이 있는 쿼리에는 `getRawMany()`를 쓰세요.

디버깅할 때는 `getSql()`이 실행 없이 raw SQL과 파라미터를 반환해요.

```typescript
const { text, values } = qb.getSql();
console.log(text);   // SELECT "u"."id", ... WHERE "u"."is_active" = ?
console.log(values);  // [true]
```

> **Hint** `getSql()` 출력의 `?` placeholder는 가독성을 위한 거예요. 실제 쿼리는 드라이버에 맞는 파라미터를 사용해요 (PostgreSQL은 `$1`, `$2`, MySQL은 `?`).

### 실전 예제 — 필터 검색 + 페이지네이션

지금까지 배운 것을 합쳐볼게요. 선택적 필터를 받아서 총 개수와 함께 페이지네이션된 결과를 반환하는 검색 엔드포인트예요.

```typescript
import { qAlias } from "@stingerloom/orm";

async function searchPosts(filters: {
  authorName?: string;
  category?: string;
  minLikes?: number;
  page: number;
  pageSize: number;
}) {
  const p = qAlias(Post, "p");
  const u = qAlias(User, "u");

  const qb = em
    .createQueryBuilder(Post, "p")
    .select(["id", "title", "createdAt"])
    .leftJoin(User, "u", (join) =>
      join.on(p.col("authorId"), "=", u.col("id"))
    );

  // 각 필터는 선택적 — 값이 있을 때만 조건 추가
  if (filters.authorName) {
    qb.where(u.name.like(`%${filters.authorName}%`));
  }
  if (filters.category) {
    qb.andWhere(p.category.eq(filters.category));
  }
  if (filters.minLikes) {
    qb.andWhere(p.likeCount.gte(filters.minLikes));
  }

  const [posts, total] = await qb
    .orderBy({ createdAt: "DESC" })
    .skip(filters.page * filters.pageSize)
    .take(filters.pageSize)
    .getPartialManyAndCount();

  return { posts, total, page: filters.page, pageSize: filters.pageSize };
}
```

`qAlias()`를 사용하면 query builder가 자연어처럼 읽혀요 — `u.name.like(...)`, `p.category.eq(...)`. TypeScript가 프로퍼티명과 조건 메서드 모두 자동 완성하므로 오타가 컴파일 에러가 돼요.

하지만 `when()`을 쓰면 `if` 블록이 아예 사라져요:

```typescript
const [posts, total] = await em
  .createQueryBuilder(Post, "p")
  .select(["id", "title", "createdAt"])
  .leftJoin(User, "u", (join) =>
    join.on(p.col("authorId"), "=", u.col("id"))
  )
  .when(!!filters.authorName, (qb) =>
    qb.where(u.name.like(`%${filters.authorName}%`))
  )
  .when(!!filters.category, (qb) =>
    qb.where(p.category.eq(filters.category))
  )
  .when(!!filters.minLikes, (qb) =>
    qb.where(p.likeCount.gte(filters.minLikes))
  )
  .orderBy({ createdAt: "DESC" })
  .skip(filters.page * filters.pageSize)
  .take(filters.pageSize)
  .getPartialManyAndCount();
```

이 섹션에서는 Stingerloom query builder의 생산성 기능들을 다뤄요.

---

## 조건부 빌딩 — when()

Query builder에서 가장 흔한 보일러플레이트는 선택적 필터를 위한 `if/else` 블록이에요. `when()`이 이걸 없애줘요:

```typescript
when(condition, fn)         // condition이 truthy면 fn 호출
when(condition, fn, elseFn) // truthy면 fn, falsy면 elseFn 호출
```

condition은 boolean이나 lazy 함수 `() => boolean` 모두 가능해요:

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .when(!!searchName, (qb) =>
    qb.where("name", "LIKE", `%${searchName}%`)
  )
  .when(onlyActive, (qb) => qb.where("status", "active"))
  .when(sortByAge,
    (qb) => qb.orderBy({ age: "ASC" }),
    (qb) => qb.orderBy({ createdAt: "DESC" }),  // else
  )
  .getMany();
```

`when()`은 항상 `this`를 반환하므로 어떤 분기가 실행되든 체이닝이 이어져요.

---

## 그룹 조건 — andWhereGroup() / orWhereGroup()

`WHERE status = 'active' OR (role = 'admin' AND verified = true)` 같은 괄호 그룹이 필요할 때가 있어요. 그룹 없이는 연산자 우선순위가 틀어져요. `andWhereGroup()`과 `orWhereGroup()`이 이걸 해결해요:

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .where("status", "active")
  .orWhereGroup((g) =>
    g.where("role", "admin").where("verified", true)
  )
  .getMany();
// WHERE "status" = 'active' OR ("role" = 'admin' AND "verified" = true)
```

```typescript
// AND 그룹: 그룹 안의 모든 조건이 AND로 결합돼요
qb.where("active", true)
  .andWhereGroup((g) =>
    g.where("age", ">=", 18)
     .where("role", "user")
  );
// WHERE "active" = true AND ("age" >= 18 AND "role" = 'user')
```

그룹 빌더는 메인 빌더와 같은 WHERE 헬퍼를 지원해요: `whereIn()`, `whereNull()`, `whereNotNull()`, `whereBetween()`, `whereLike()`.

---

## 재사용 가능한 변환 — pipe()

`pipe()`로 재사용 가능한 쿼리 로직을 독립 함수로 추출하고 합성할 수 있어요:

```typescript
// 재사용 가능한 변환 정의
function withPagination<T>(page: number, size: number) {
  return (qb: SelectQueryBuilder<T>) =>
    qb.offset((page - 1) * size).limit(size);
}

function withActiveFilter<T>(qb: SelectQueryBuilder<T>) {
  return qb.where("deletedAt", "IS NULL", null);
}

// 합성해서 사용
const users = await repo
  .createQueryBuilder("u")
  .pipe(withActiveFilter)
  .pipe(withPagination(2, 20))
  .getMany();
```

서비스 코드를 DRY하게 유지하는 데 강력한 패턴이에요. 프로젝트의 공통 쿼리 패턴을 한 번 정의하고, 어디서든 `pipe()`로 사용하세요.

---

## Relation 기반 쿼리

### whereHas() / whereNotHas() — Relation 존재 필터

`whereHas()`는 엔티티의 relation 메타데이터로부터 `EXISTS` 서브쿼리를 자동 생성해요. 수동 SQL 불필요:

```typescript
// 댓글이 있는 게시글만
const posts = await em
  .createQueryBuilder(Post, "p")
  .whereHas("comments")
  .getMany();
// WHERE EXISTS (SELECT 1 FROM comment WHERE comment.post_id = p.id)
```

콜백으로 관련 엔티티에 조건을 추가할 수 있어요:

```typescript
// 최근 댓글이 있는 게시글
const posts = await em
  .createQueryBuilder(Post, "p")
  .whereHas("comments", (sub) =>
    sub.where("createdAt", ">=", sevenDaysAgo)
  )
  .getMany();
```

`whereNotHas()`는 `NOT EXISTS`를 생성해요:

```typescript
// 댓글이 없는 게시글
const drafts = await em
  .createQueryBuilder(Post, "p")
  .whereNotHas("comments")
  .getMany();
```

`@ManyToOne`, `@OneToMany`, `@OneToOne` relation 모두 지원해요. 상관 조건은 데코레이터 메타데이터에서 자동으로 해석돼요.

### withCount() — Relation 카운트 컬럼

SELECT절에 relation 카운트를 스칼라 서브쿼리로 추가해요:

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .withCount("posts")                // 기본 alias: "posts_count"
  .withCount("posts", "activeCount", (sub) =>
    sub.where("status", "published") // published만 카운트
  )
  .orderBy({ posts_count: "DESC" } as any)
  .getRawMany();
// SELECT "u".*, (SELECT COUNT(*) FROM post ...) AS "posts_count", ...
```

### loadRelation() — 간편한 Relation 로딩

`leftJoinRelationAndSelect()`의 간결한 단축어예요:

```typescript
// 대신:
qb.leftJoinRelationAndSelect("author", "author")
  .leftJoinRelationAndSelect("comments", "comments");

// 이렇게:
qb.loadRelation("author").loadRelation("comments");
```

---

## Subquery 통합

### whereInSubquery() / whereNotInSubquery()

`SelectQueryBuilder`를 `WHERE IN` 서브쿼리로 사용해요:

```typescript
const activeUserIds = em
  .createQueryBuilder(User, "u2")
  .select(["id"])
  .where("status", "active");

const posts = await em
  .createQueryBuilder(Post, "p")
  .whereInSubquery("authorId", activeUserIds)
  .getMany();
// WHERE "p"."author_id" IN (SELECT "u2"."id" FROM "user" AS "u2" WHERE ...)
```

### whereExistsSubquery() / whereNotExistsSubquery()

`SelectQueryBuilder`를 `EXISTS` 서브쿼리로 사용해요:

```typescript
const correlated = em
  .createQueryBuilder(Order, "o")
  .select(["id"])
  .where(sql`"o"."user_id" = "u"."id"`)
  .where("total", ">=", 100);

const bigSpenders = await em
  .createQueryBuilder(User, "u")
  .whereExistsSubquery(correlated)
  .getMany();
```

### addSelectSubquery() — SELECT절 스칼라 서브쿼리

상관 서브쿼리를 계산 컬럼으로 추가해요:

```typescript
const latestComment = em
  .createQueryBuilder(Comment, "c")
  .select(["content"])
  .where(sql`"c"."post_id" = "p"."id"`)
  .orderBy({ createdAt: "DESC" })
  .limit(1);

const posts = await em
  .createQueryBuilder(Post, "p")
  .addSelectSubquery(latestComment, "latestComment")
  .getRawMany();
// SELECT "p".*, (SELECT ... LIMIT 1) AS "latestComment" FROM ...
```

---

## Scopes — 재사용 가능한 쿼리 조각

엔티티에 static 프로퍼티로 named scope를 정의해요:

```typescript
@Entity()
class User {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ type: "varchar" }) name!: string;
  @Column({ type: "varchar" }) status!: string;

  static scopes = {
    active: (qb: SelectQueryBuilder<User>) =>
      qb.where("status", "active"),
    recent: (qb: SelectQueryBuilder<User>) =>
      qb.orderBy({ createdAt: "DESC" }).limit(10),
    verified: (qb: SelectQueryBuilder<User>) =>
      qb.where("emailVerified", true),
  };
}
```

`applyScope()`로 적용해요:

```typescript
const users = await repo
  .createQueryBuilder("u")
  .applyScope("active")
  .applyScope("recent")
  .getMany();
```

Scope는 다른 모든 빌더 메서드와 합성돼요 — `where()`, `when()`, `pipe()`, `whereHas()` 등. 본질적으로 query builder를 받는 함수일 뿐이에요.

존재하지 않는 scope 이름으로 `applyScope()`를 호출하면 사용 가능한 scope 목록과 함께 `OrmError`가 발생해요.

---

## 같은 쿼리를 미리 만들어 두기 — `prepare()`

같은 모양의 쿼리가 값만 바뀌며 반복된다면, SQL을 한 번만 만들어 두고 계속 재사용할 수 있어요:

```typescript
import { p } from "@stingerloom/orm";
import sql from "sql-template-tag";

const findById = em
  .createQueryBuilder(User, "u")
  .where(sql`u.id = ${p("id")}`)
  .prepare<{ id: number }>();

await findById.executeOne({ id: 42 });
await findById.executeOne({ id: 77 });   // SQL을 다시 만들지 않아요
```

선택한 컬럼만 받고 싶을 때 쓰는 `preparePartial()`도 있고, `RawQueryBuilder`에도 똑같은 `.prepare(em)`이 있어요. 언제 효과가 있고 언제 없는지, `WriteBuffer`나 배치 쓰기와는 어떻게 다른지 등 자세한 배경은 [쿼리 미리 만들어두기](./entity-manager-advanced.md#쿼리-미리-만들어두기-em-compile-qb-prepare)에서 다루고 있어요.

---

## RawQueryBuilder — 완전한 SQL 제어

UNION, CTE, window function, subquery 같은 고급 SQL 기능은 [Raw SQL & CTE](./raw-sql.md) 가이드를 참고하세요.

간단한 미리보기예요:

```typescript
import sql from "sql-template-tag";

const qb = em.createQueryBuilder();

const query = qb
  .select(['"id"', '"name"', '"email"'])
  .from('"users"')
  .where([sql`"is_active" = ${true}`])
  .orderBy([{ column: '"created_at"', direction: "DESC" }])
  .limit(10)
  .build();

const users = await em.query(query);
```

RawQueryBuilder는 UNION / INTERSECT / EXCEPT, Common Table Expression (CTE), recursive CTE, window function (ROW_NUMBER, RANK, LAG 등), DISTINCT ON을 지원해요. 자세한 내용은 [전체 가이드](./raw-sql.md)를 참고하세요.

---

## 올바른 실행 메서드 선택하기

Query builder는 세 단계의 실행 메서드를 제공해요. 결과에서 무엇이 필요한지에 따라 선택하세요.

```typescript
const qb = em.createQueryBuilder(User, "u")
  .select(["id", "name"])
  .where("isActive", true);

// 1. Safe — class instances, validates required columns
const entities = await qb.getMany();         // T[] — instanceof User === true
await em.save(User, entities[0]);             // ✓ works

// 2. Partial — typed plain objects, no validation
const dtos = await qb.getPartialMany();       // Pick<User, "id" | "name">[]
dtos[0].email;                                // ✗ compile error
dtos[0] instanceof User;                      // false

// 3. Raw — untyped plain objects
const raw = await qb.getRawMany();            // Record<string, unknown>[]
```

### Required 컬럼 검증

`getMany()`는 `select()` 사용 시 non-nullable 컬럼이 모두 포함됐는지 검증해요. required 필드가 `undefined`인 잘못된 클래스 인스턴스 생성을 방지해요.

```typescript
@Entity()
class User {
  @PrimaryGeneratedColumn()         // autoIncrement — can omit
  id!: number;

  @Column({ type: "varchar" })      // non-nullable — REQUIRED
  name!: string;

  @Column({ nullable: true })       // nullable — can omit
  bio!: string | null;

  @Column({ default: "active" })    // has default — can omit
  status!: string;
}

// ✓ OK — "name" (the only required column) is included
await qb.select(["name"]).getMany();

// ✗ Throws OrmError MISSING_REQUIRED_COLUMNS — "name" is missing
await qb.select(["bio"]).getMany();

// ✓ Use getPartialMany() to skip validation
await qb.select(["bio"]).getPartialMany();  // OK — plain object
```

컬럼이 **required**로 간주되려면 다음이 모두 참이어야 해요:
- `nullable`이 `true`가 아님
- `default` 값이 지정되지 않음
- `autoIncrement`가 아님 (예: `@PrimaryGeneratedColumn`)

### 메서드별 사용 시나리오

| 상황 | Method | 이유 |
|------|--------|------|
| `em.save()`에 전달할 데이터 | `getMany()` | 전체 lifecycle을 지원하는 클래스 인스턴스 |
| EntitySubscriber / lifecycle hook | `getMany()` | 클래스 인스턴스만 `listenTo()`에 매칭돼요 |
| Read-only API 응답 | `getPartialMany()` | Typed DTO, 컴파일 타임 안전성, 경량 |
| Aggregate / computed column | `getRawMany()` | `addSelect(sql`COUNT(*)`, "cnt")`는 `Pick`으로 타이핑할 수 없어요 |
| 존재 여부 확인 | `exists()` | Boolean — 데이터를 가져오지 않아요 |

`em.find()`에도 `select` 옵션이 있지만, 반환 타입을 좁혀주지는 않아요 — `find()`는 항상 `T[]`를 반환해요. Projection의 타입 안전성이 중요하다면 query builder의 `getPartialMany()`를 사용하세요.

---

## 두 Builder 중 어떤 걸 선택할까요

| 질문 | SelectQueryBuilder | RawQueryBuilder |
|------|-------------------|----------------|
| 등록된 엔티티를 쿼리하나요? | Yes | 필수 아님 |
| `keyof T` 자동완성이 필요하나요? | Yes | No |
| UNION / INTERSECT / EXCEPT가 필요하나요? | No | Yes |
| CTE (WITH / WITH RECURSIVE)가 필요하나요? | No | Yes |
| Window function이 필요하나요? | No | Yes |
| 클래스 인스턴스를 반환하나요? | `getMany()` yes / `getPartialMany()` no | No — `em.query()`를 통한 raw object |

실무에서는 일상적인 쿼리에 `SelectQueryBuilder`로 시작하세요. 한계에 부딪히면 — UNION, 재귀 계층 탐색, window 분석이 필요하면 — 해당 쿼리만 `RawQueryBuilder`로 전환하세요.

## Next Steps

- [Raw SQL & CTE](./raw-sql.md) — UNION, CTE, window function, DISTINCT ON
- [Pagination & Streaming](./pagination.md) — Offset, cursor, streaming 전략
- [EntityManager](./entity-manager.md) — find(), save() 등 기본 CRUD
- [API Reference](./api-reference.md) — 모든 메서드 시그니처 빠른 참조
