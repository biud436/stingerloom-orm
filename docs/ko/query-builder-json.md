# 쿼리 빌더: JSON 컬럼 탐색

> 참고: ORM 튜토리얼은 JSON 컬럼 예제로 `metadata`를 쓰는 경우가 많습니다. 하지만 이 이름은 코드 스멜에 가깝습니다. "metadata"는 문자 그대로 "데이터를 설명하는 데이터"라는 뜻이어서 컬럼에 실제로 무엇이 들어 있는지 감춥니다. 아래 예제는 `User` 엔티티의 `profile` JSON 컬럼을 씁니다. 이 컬럼에는 구체적인 비즈니스 데이터가 들어 있고 형태도 명시되어 있습니다. 아래 설명은 컬럼 이름과 상관없이 모든 `json` / `jsonb` 컬럼에 그대로 적용됩니다.

`users` 테이블의 각 행에 아래와 같은 `profile` JSON 컬럼이 있다고 해 봅시다. 연락처, 개인정보, 태그, 역할이 담긴 실무 데이터입니다.

```json
{
  "contact":  { "email": "alice@example.com", "phone": "+82-10-0000-0000" },
  "personal": { "age": 30, "city": "Seoul" },
  "tags":     ["red", "blue", "green"],
  "role":     "admin"
}
```

목표는 "contact.email이 `@corp.com`으로 끝나고 나이가 18 이상이며 tags 배열이 비어 있지 않은 사용자"를 쿼리 하나로 조회하는 것입니다.

raw SQL로 쓰면 데이터베이스마다 문법이 전혀 다릅니다.

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

여기에는 세 가지 문제가 있습니다.

1. **드라이버마다 함수 이름과 경로 문법이 다릅니다.** 쿼리를 PostgreSQL에서 MySQL로 옮기면 JSON을 다루는 줄이 전부 깨집니다.
2. **경로가 문자열입니다.** `'{contact,emial}'` 같은 오타가 있어도 컴파일은 성공합니다. 그리고 쿼리는 아무 경고 없이 0건을 반환합니다.
3. **사용자 입력으로 경로를 조립하면 인젝션 벡터가 됩니다.** `` `'{${key}}'` `` 같은 포맷은 악의적인 키 하나로 쿼리를 무너뜨릴 수 있습니다.

그런데 `profile`의 형태는 이미 TypeScript 타입으로 선언되어 있습니다.

```typescript
@Column({ type: "jsonb", nullable: true })
profile!: {
  contact?:  { email: string; phone?: string };
  personal?: { age: number; city?: string };
  tags?:     string[];
  role?:     string;
};
```

그러면 질문이 이렇게 바뀝니다. `u.profile.contact.email`이라고만 쓰면 ORM이 올바른 SQL로 바꿔 줄 수는 없을까요? QueryDSL의 JSON 탐색이 바로 그 기능입니다.

> 참고: JSON 탐색은 [QueryDSL 표현식](./query-builder-querydsl.md)에서 설명하는 `qAlias()` 프록시를 기반으로 합니다. 그 페이지를 아직 읽지 않았다면 요점만 알아 두세요. `qAlias(User, "u")`는 `u.firstName`을 타입 있는 `ColumnExpression`으로 바꾸는 프록시를 반환합니다. JSON 탐색은 같은 프록시를 확장한 기능입니다.

## JSON이 자연스러운 확장인 이유

속성 접근을 SQL 표현식으로 바꾸는 프록시가 있으면 JSON 컬럼 지원은 거의 저절로 따라옵니다. `u.profile`에 접근하면 프록시는 `profile`이 `@Column({ type: "json" | "jsonb" })`로 선언되었는지 확인합니다. 그렇다면 다른 종류의 프록시인 `JsonPathExpression`을 대신 반환합니다. `JsonPathExpression`은 한 단계에서 끝나지 않고 경로를 계속 확장합니다.

```
u            .profile       .contact      .email      .eq("alice@example.com")
│             │              │             │           │
ColumnExpr    JsonPath(      JsonPath(     JsonPath(   JsonPathCondition
프록시         ref="u.prof",  path=         path=       DialectExpression
              path=[])       ["contact"])  ["contact", 으로 SQL을
                                            "email"])   컴파일
```

마지막에 `.eq(...)` 같은 연산자를 호출해야 비로소 경로가 고정되고 `JsonPathCondition`이 만들어집니다. 그다음 쿼리 빌더는 현재 드라이버의 `DialectExpression`에 SQL 렌더링을 맡깁니다. PostgreSQL에서는 `#>>`, MySQL에서는 `JSON_EXTRACT`, SQLite에서는 `json_extract`가 쓰입니다.

## 기본 사용법

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

컴파일 결과는 다음과 같습니다.

```sql
-- PostgreSQL (jsonb): 중첩 경로는 `-> 'key'` 체인으로 잇고 마지막 단계만 `->>`로 텍스트화
SELECT ... FROM "users" AS "u"
WHERE "u"."profile" -> $1 ->> $2 = $3
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

경로 세그먼트와 비교 값은 모두 바인딩 파라미터로 들어갑니다. 예외는 PostgreSQL의 배열 인덱스 같은 정수 리터럴입니다. 정수 리터럴은 `Math.trunc`를 거친 뒤 SQL에 직접 들어갑니다. 하지만 JS 정수 범위 안의 값이므로 안전합니다. 문자열을 이어 붙이지 않으므로 경로가 사용자 입력이어도 안전합니다.

> `#>>/ARRAY[...]` 대신 `->/->>` 체인을 쓰는 데는 이유가 있습니다. PostgreSQL `jsonb`에서는 `-> 'key'` 체인 형태가 `CREATE INDEX … USING gin ((profile -> 'tags'))` 같은 표현식 GIN 인덱스와 맞물려 동작합니다. 반면 `#>>/ARRAY[...]` 경로는 인덱스와 잘 맞지 않습니다. 같은 이유로 `role`처럼 세그먼트가 하나일 때도 `profile ->> 'role'` 형태로 렌더링합니다. jsonb가 아닌 일반 `json` 컬럼에서만 legacy `#>> ARRAY[...]` 형식으로 넘어갑니다.

## 연산자 레퍼런스 (컴파일된 SQL과 함께)

아래 예제는 모두 `const u = qAlias(User, "u")`를 전제로 하고 PostgreSQL 출력을 기준으로 합니다. MySQL과 SQLite에서는 같은 뜻의 함수 호출로 바뀝니다.

### 비교: `.eq` / `.neq` (`.ne` 별칭) / `.gt` / `.gte` / `.lt` / `.lte`

```typescript
u.profile.personal.age.gte(18);
```
```sql
-- PostgreSQL (jsonb): "u"."profile" -> 'personal' ->> 'age' >= $1
-- MySQL:              JSON_UNQUOTE(JSON_EXTRACT(`u`.`profile`, '$.personal.age')) >= ?
-- SQLite:             json_extract("u"."profile", '$.personal.age') >= ?
```

`.ne()`는 `.neq()`와 같은 뜻의 별칭입니다. 읽기 좋은 쪽을 쓰세요.

### 패턴: `.like` / `.notLike`

```typescript
u.profile.contact.email.like("%@corp.com");
```
```sql
-- PostgreSQL (jsonb): "u"."profile" -> 'contact' ->> 'email' LIKE $1
```

### 집합: `.in` / `.notIn`

```typescript
u.profile.role.in(["admin", "editor"]);
```
```sql
-- PostgreSQL (jsonb): "u"."profile" ->> 'role' IN ($1, $2)
```

빈 배열을 넘기면 `1 = 0`으로 축약되어 어떤 행도 매칭되지 않습니다. `.notIn([])`은 `1 = 1`이 되어 모든 행이 매칭됩니다. 쿼리가 올바른 SQL로 유지되도록 둔 안전장치입니다.

### NULL: `.isNull` / `.isNotNull`

```typescript
u.profile.contact.email.isNull();
```
```sql
-- PostgreSQL (jsonb): "u"."profile" -> 'contact' ->> 'email' IS NULL
```

존재하지 않는 경로를 추출하면 NULL이 됩니다. 그래서 "경로가 없거나 값이 null"인 경우는 `.isNull()`로 표현하는 것이 맞습니다.

### 구조: `.contains(value)`

```typescript
u.profile.contains({ role: "admin" });     // 객체 containment
u.profile.role.contains("admin");           // 스칼라 containment (잎 경로)
```
```sql
-- PostgreSQL jsonb 객체:   "u"."profile" @> $1::jsonb       -- param: '{"role":"admin"}'
-- PostgreSQL jsonb 스칼라: "u"."profile" -> 'role' @> to_jsonb($1::text)
-- MySQL:                   JSON_CONTAINS(`u`.`profile`, ?, '$.path')
```

PostgreSQL에서는 스칼라 값을 넘기면 `to_jsonb($1::text/::numeric/::bool)`로 감쌉니다. node-pg가 파라미터 타입을 추론하도록 돕기 위해서입니다. MySQL에서는 `JSON_CONTAINS`로 렌더링됩니다. SQLite에는 네이티브 containment 연산자가 없습니다. 그래서 SQLite는 스칼라 값만 받고 내부에서 경로 동등 비교로 변환합니다. 객체나 배열을 넘기면 `OrmError`를 던집니다. SQLite에서 이런 비교가 필요하면 잎 경로에서 `.eq()`로 나눠 쓰거나 raw SQL을 쓰세요.

```typescript
// SQLite 호환: 객체 containment 대신 경로 동등 비교로
u.profile.role.eq("admin");
```

### 구조: `.hasKey(key)`

```typescript
u.profile.contact.hasKey("email");
```
```sql
-- PostgreSQL: jsonb_exists("u"."profile" -> 'contact', $1)
-- MySQL:      JSON_CONTAINS_PATH(`u`.`profile`, 'one', ?)
-- SQLite:     json_extract("u"."profile", ?) IS NOT NULL
```

> PostgreSQL에서 왜 `?` 연산자를 피할까요? `?`는 `sql-template-tag`의 바인딩 플레이스홀더와 글자가 겹치기 때문입니다. 같은 뜻의 `jsonb_exists(...)` 함수를 대신 씁니다.

### 스칼라: `.arrayLength()` / `.typeOf()`

두 메서드는 모두 `JsonScalarExpression`을 반환합니다. JSON 함수 호출 결과를 비교할 수 있는 상태로 들고 있는 값이라고 생각하면 됩니다. 결과는 숫자나 문자열입니다. 그래서 `.eq/.neq/.gt/.gte/.lt/.lte` 비교를 바로 이어 붙일 수 있습니다.

```typescript
u.profile.tags.arrayLength().gt(3);
u.profile.tags.typeOf().eq("array");
```
```sql
-- PostgreSQL (jsonb):
jsonb_array_length("u"."profile" -> 'tags') > $1
jsonb_typeof     ("u"."profile" -> 'tags') = $1

-- MySQL:
JSON_LENGTH(`u`.`profile`, '$.tags') > ?
JSON_TYPE(JSON_EXTRACT(`u`.`profile`, '$.tags')) = ?
```

## 실전: 프로필 기반 세그먼트 필터

관리자 화면에서 "서울 거주, 22–35세, admin이나 editor, 태그에 `blue` 포함, 연락처 전화번호가 있는 사용자"를 쿼리 하나로 조회한다고 해 봅시다. 이 쿼리에는 여러 JSON 연산이 함께 쓰입니다.

```typescript
const u = qAlias(User, "u");

const segment = await em.createQueryBuilder(User, "u")
  .where(u.profile.personal.age.between(22, 35))
  .andWhere(u.profile.personal.city.eq("Seoul"))
  .andWhere(u.profile.role.in(["admin", "editor"]))
  .andWhere(u.profile.tags.contains("blue"))
  .andWhere(u.profile.contact.hasKey("phone"))
  .getMany();
```

같은 코드가 세 드라이버에서 모두 동작합니다. 경로 세그먼트와 비교 값은 빠짐없이 바인딩 파라미터로 들어갑니다. "`profile.tags`가 비어 있는 휴면 사용자"처럼 스칼라 함수 결과와 비교하는 쿼리도 같은 방식으로 씁니다.

```typescript
const dormant = await em.createQueryBuilder(User, "u")
  .where(u.profile.tags.arrayLength().eq(0))
  .getMany();
```

표현식이 길어지면 `.when()` / `.pipe()` 같은 합성 헬퍼와 함께 쓰세요. 합성 헬퍼는 [편의 패턴](./query-builder-patterns.md)에 있습니다. JSON 경로 조건도 다른 `ConditionLike`와 똑같이 취급됩니다. 그래서 `Expressions.and(...)`, `Expressions.or(...)`에 그대로 넣을 수 있습니다.

## 동적 경로: `.path(string)`

프록시 접근은 코드에 고정된 정적 경로에 잘 맞습니다. 하지만 프록시로 표현하기 어려운 경우가 두 가지 있습니다.

- **배열 인덱스**: 배열 타입이 충분히 구체적이지 않으면 TypeScript가 `u.profile.tags[0]`을 바로 허용하지 않을 때가 있습니다.
- **점·공백·구두점이 들어간 키**: `u.profile["weird key"]`는 프록시 방식으로 안전하게 처리하기 어렵습니다.

이럴 때는 `.path()`를 씁니다. 문법은 JS의 속성 접근자와 같습니다. 점 구분(`tags.admin`), 대괄호 인덱스(`tags[0]`), 따옴표 키(`items["weird key"]`)를 모두 지원합니다.

```typescript
u.profile.path("tags[0]").eq("admin");
u.profile.path(`items["weird key"][2].value`).isNotNull();
```
```sql
-- PostgreSQL (jsonb, 배열 인덱스는 정수로 정규화)
"u"."profile" -> 'tags' ->> 0 = $1
"u"."profile" -> 'items' -> 'weird key' -> 2 ->> 'value' IS NOT NULL
```

`.path()`는 프록시 접근과 함께 쓸 수 있습니다. 정적으로 갈 수 있는 데까지 속성으로 내려간 다음 동적인 나머지 경로만 `.path()`로 붙이면 됩니다.

```typescript
u.profile.personal.path("history[1].city").eq("Busan");
// 최종 경로 = ['personal', 'history', 1, 'city']
```

## 드라이버 치트시트

아래 표는 모두 `jsonb` 컬럼 기준입니다. jsonb가 아닌 일반 `json` 컬럼은 legacy `#>> ARRAY[...]` 형식으로 넘어갑니다. 하지만 GIN 인덱스를 걸 수 있는 `jsonb`를 쓰는 것을 권장합니다.

| 연산 | PostgreSQL (jsonb) | MySQL | SQLite |
|------|--------------------|-------|--------|
| Extract (text) | `col -> 'a' ->> 'b'` | `JSON_UNQUOTE(JSON_EXTRACT(col, '$.a.b'))` | `json_extract(col, '$.a.b')` |
| Extract (JSON) | `col -> 'a' -> 'b'` | `JSON_EXTRACT(col, '$.a.b')` | `json_extract(col, '$.a.b')` (SQLite는 항상 스칼라) |
| Contains (객체) | `col @> val::jsonb` | `JSON_CONTAINS(col, val, '$.path')` | 지원 안 함: 객체 값은 `OrmError` |
| Contains (스칼라) | `col -> path @> to_jsonb(val::type)` | `JSON_CONTAINS(col, val, '$.path')` | 경로 동등 비교로 변환 |
| Has key | `jsonb_exists(col -> path, 'k')` | `JSON_CONTAINS_PATH(col, 'one', '$.path.k')` | `json_extract(col, '$.path.k') IS NOT NULL` |
| Array length | `jsonb_array_length(col -> path)` | `JSON_LENGTH(col, '$.path')` | `json_array_length(col, '$.path')` |
| Type of | `jsonb_typeof(col -> path)` | `JSON_TYPE(JSON_EXTRACT(col, '$.path'))` | `json_type(col, '$.path')` |

## 안전 장치와 한계

- **SQL 인젝션.** 경로 세그먼트, 키, 값은 모두 바인딩 파라미터입니다. `.path("'; DROP TABLE users--")` 같은 악성 입력이 들어와도 prepared statement의 문자열 리터럴로 들어갈 뿐입니다. 실행 가능한 SQL이 되지는 않습니다.
- **없는 경로.** 세 다이얼렉트 모두 없는 경로를 추출하면 `NULL`을 반환합니다. "경로가 없는 경우"와 "경로는 있지만 값이 null인 경우"를 구분해야 한다면 `.isNull()` / `.isNotNull()`이나 `.hasKey(...)`를 쓰세요.
- **SQLite 주의.** `json1` 확장이 필요합니다. `better-sqlite3`에는 기본으로 포함되어 있습니다. `json_extract`는 SQLite의 스칼라 타입으로 값을 반환합니다. 그래서 `.gt(18)` 같은 숫자 비교는 캐스트 없이 바로 동작합니다. 객체 containment는 지원하지 않습니다.
- **`any`로 타입이 지워진 경우.** JSON 컬럼을 `any`로 두거나 타입 선언을 생략해도 프록시는 런타임에 정상 동작합니다. 다만 TypeScript에서 속성 단위 자동완성은 쓸 수 없습니다.

JSON 필터 때문에 `` em.query(sql`... ->> ${path}`) ``를 쓰고 싶어진다면 먼저 QueryDSL 경로를 떠올려 보세요. QueryDSL 경로가 더 안전합니다. 그리고 ORM이 지원하는 모든 드라이버에서 동작합니다.

## 다음 단계

- [QueryDSL 표현식](./query-builder-querydsl.md): 같은 프록시의 나머지 기능인 집계, CASE, CAST, 날짜 컴포넌트, 윈도 함수
- [집계 & 서브쿼리](./query-builder-aggregations.md): JSON 경로로 꺼낸 값을 GROUP BY 키나 `HAVING` 조건에 쓰기
- [편의 패턴](./query-builder-patterns.md): `when()`, `pipe()`, scope로 JSON 조건을 조합하고 재사용하기
- [Query Builder 개요](./query-builder.md): 기본 사용법과 전체 지도
