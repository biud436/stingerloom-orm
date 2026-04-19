# Query Builder — JSON 컬럼 탐색

> **예제 이름에 관한 메모.** ORM 튜토리얼이 JSON 컬럼 예제로 `metadata`를 쓰는 경우가 많습니다. 사실 이 이름은 코드 스멜에 가까워요. "metadata"는 문자 그대로 "데이터에 대한 데이터"라서, 실제로 무엇이 들어가는지 감추는 이름이 되거든요. 이 페이지에서는 `User` 엔티티의 `profile` JSON 컬럼으로 예제를 들어갑니다. 구체적인 비즈니스 데이터에, 스키마도 명시적이에요. 설명하는 동작 자체는 컬럼 이름과 무관하게 어떤 `json` / `jsonb` 컬럼에도 그대로 적용됩니다.

`users` 테이블의 각 행에 아래와 같은 `profile` JSON 컬럼이 있다고 해 봅시다. 연락처, 개인정보, 태그, 역할이 담긴 실무 데이터예요.

```json
{
  "contact":  { "email": "alice@example.com", "phone": "+82-10-0000-0000" },
  "personal": { "age": 30, "city": "Seoul" },
  "tags":     ["red", "blue", "green"],
  "role":     "admin"
}
```

목표는 이것입니다. _"contact.email이 `@corp.com`으로 끝나고, 나이가 18 이상이며, tags 배열이 비어 있지 않은 사용자"_ 를 한 쿼리로 뽑자.

Raw SQL로 쓰면 DB마다 문법이 전혀 다릅니다.

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

여기에는 통증이 세 군데 있습니다.

1. **드라이버마다 함수 이름과 경로 문법이 다릅니다.** PostgreSQL에서 MySQL로 옮기는 순간 JSON 줄이 전부 깨져요.
2. **경로가 문자열입니다.** `'{contact,emial}'` 같은 오타가 있어도 컴파일은 성공하고, 쿼리는 조용히 0건을 돌려줍니다.
3. **사용자 입력으로 경로를 조립하면 인젝션 벡터가 됩니다.** `` `'{${key}}'` `` 같은 포맷은 악의적인 키 하나로 쿼리를 무너뜨릴 수 있습니다.

그런데 타입스크립트는 이미 `profile`의 모양을 알고 있어요. 여러분이 그렇게 선언했으니까요.

```typescript
@Column({ type: "jsonb", nullable: true })
profile!: {
  contact?:  { email: string; phone?: string };
  personal?: { age: number; city?: string };
  tags?:     string[];
  role?:     string;
};
```

질문이 이렇게 바뀝니다. _"`u.profile.contact.email`이라고만 쓰면 ORM이 알아서 올바른 SQL로 바꿔 주면 안 될까?"_ 이 페이지가 답하려는 질문이에요.

> **먼저 알아둘 것** — JSON 탐색은 [QueryDSL 표현식](./query-builder-querydsl.md)의 `qAlias()` 프록시 위에 얹힙니다. 아직 그 페이지를 보지 않았다면 한 줄 요약은 이렇습니다 — `qAlias(User, "u")`는 `u.firstName`을 타입이 찍힌 `ColumnExpression`으로 바꿔주는 프록시를 돌려줍니다. JSON은 그 프록시의 자연스러운 확장이에요.

## JSON이 자연스러운 확장인 이유

프록시가 프로퍼티 접근을 SQL 표현식으로 바꾸는 구조라면, JSON 컬럼 지원은 거의 공짜로 얻어집니다. `u.profile`에 접근할 때 프록시는 `profile`이 `@Column({ type: "json" | "jsonb" })`로 선언되어 있는 것을 알아챕니다. 그러고는 조금 다른 프록시 — **경로를 끝내지 않고 계속 확장하는** `JsonPathExpression` — 을 대신 돌려줘요.

```
u            .profile       .contact      .email      .eq("alice@example.com")
│             │              │             │           │
ColumnExpr    JsonPath(      JsonPath(     JsonPath(   JsonPathCondition
프록시         ref="u.prof",  path=         path=       DialectExpression
              path=[])       ["contact"])  ["contact", 을 통해 SQL로
                                            "email"])   컴파일
```

마지막 연산자 호출(`.eq(...)`)이 와야 비로소 경로가 고정되고 `JsonPathCondition`이 만들어집니다. 이후 쿼리 빌더가 현재 드라이버의 `DialectExpression`에 위임해 적절한 SQL을 렌더링해요 — PostgreSQL이면 `#>>`, MySQL이면 `JSON_EXTRACT`, SQLite면 `json_extract`.

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

컴파일 결과:

```sql
-- PostgreSQL (jsonb) — 중첩 경로는 `-> 'key'` 체인 + 마지막만 `->>` 로 텍스트화
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

경로 세그먼트도 비교 값도 **전부 바인딩 파라미터**로 들어갑니다. (PostgreSQL에서 배열 인덱스 같은 정수 리터럴만 예외적으로 `Math.trunc`를 거친 뒤 인라인되지만, JS 정수 범위 안쪽이라 안전해요.) 문자열 연결이 없으니 경로가 사용자 입력이라도 안전합니다.

> **왜 `#>>/ARRAY[...]`가 아닌 `->/->>` 체인인가?** PostgreSQL `jsonb`에서는 `-> 'key'` 체인 형태가 `CREATE INDEX … USING gin ((profile -> 'tags'))` 같은 **표현식 GIN 인덱스**와 맞물려 돌아갑니다. `#>>/ARRAY[...]` 경로는 인덱스에 잘 맞지 않아요. 단일 세그먼트(`role` 한 개)일 때도 같은 이유로 `profile ->> 'role'` 식으로 나갑니다. jsonb가 아닌 일반 `json` 컬럼만 legacy `#>> ARRAY[...]` 폴백으로 처리해요.

## 연산자 레퍼런스 (컴파일된 SQL과 함께)

아래 예제는 모두 `const u = qAlias(User, "u")`를 전제하고, PostgreSQL 출력 기준으로 보여 드립니다. MySQL과 SQLite에서는 동등한 함수 호출로 바뀌어요.

### 비교 — `.eq` / `.neq` (`.ne` 별칭) / `.gt` / `.gte` / `.lt` / `.lte`

```typescript
u.profile.personal.age.gte(18);
```
```sql
-- PostgreSQL (jsonb): "u"."profile" -> 'personal' ->> 'age' >= $1
-- MySQL:              JSON_UNQUOTE(JSON_EXTRACT(`u`.`profile`, '$.personal.age')) >= ?
-- SQLite:             json_extract("u"."profile", '$.personal.age') >= ?
```

`.ne()`는 `.neq()`와 같은 뜻의 별칭입니다. 읽기 좋은 쪽을 쓰세요.

### 패턴 — `.like` / `.notLike`

```typescript
u.profile.contact.email.like("%@corp.com");
```
```sql
-- PostgreSQL (jsonb): "u"."profile" -> 'contact' ->> 'email' LIKE $1
```

### 집합 — `.in` / `.notIn`

```typescript
u.profile.role.in(["admin", "editor"]);
```
```sql
-- PostgreSQL (jsonb): "u"."profile" ->> 'role' IN ($1, $2)
```

빈 배열을 넘기면 `1 = 0`(모두 제외)으로 축약되고, `.notIn([])`은 `1 = 1`(모두 포함)이 됩니다. 쿼리가 무효화되지 않도록 걸어둔 안전 장치예요.

### NULL — `.isNull` / `.isNotNull`

```typescript
u.profile.contact.email.isNull();
```
```sql
-- PostgreSQL (jsonb): "u"."profile" -> 'contact' ->> 'email' IS NULL
```

존재하지 않는 경로는 추출 시 NULL이 됩니다. 따라서 `.isNull()`이 "경로가 없거나 값이 null"을 표현하는 올바른 방법이에요.

### 구조 — `.contains(value)`

```typescript
u.profile.contains({ role: "admin" });     // 객체 containment
u.profile.role.contains("admin");           // 스칼라 containment (잎 경로)
```
```sql
-- PostgreSQL jsonb 객체:   "u"."profile" @> $1::jsonb       -- param: '{"role":"admin"}'
-- PostgreSQL jsonb 스칼라: "u"."profile" -> 'role' @> to_jsonb($1::text)
-- MySQL:                   JSON_CONTAINS(`u`.`profile`, ?, '$.path')
```

PostgreSQL은 스칼라 값을 넘기면 `to_jsonb($1::text/::numeric/::bool)`로 감쌉니다 — node-pg의 파라미터 타입 추론을 돕기 위한 래핑이에요. MySQL은 `JSON_CONTAINS`로 나가고, **SQLite는 네이티브 containment 연산자가 없어 스칼라만 받습니다 (내부적으로 경로 동등 비교로 변환).** 객체나 배열을 넘기면 `OrmError`를 던지니, SQLite 지원이 필요한 경우에는 잎 경로에서 `.eq()`로 분해하거나 raw SQL을 쓰세요.

```typescript
// SQLite 호환: 객체 containment 대신 경로 동등 비교로
u.profile.role.eq("admin");
```

### 구조 — `.hasKey(key)`

```typescript
u.profile.contact.hasKey("email");
```
```sql
-- PostgreSQL: jsonb_exists("u"."profile" -> 'contact', $1)
-- MySQL:      JSON_CONTAINS_PATH(`u`.`profile`, 'one', ?)
-- SQLite:     json_extract("u"."profile", ?) IS NOT NULL
```

> PostgreSQL에서 왜 `?` 연산자를 피할까요? `?`는 `sql-template-tag`의 바인딩 플레이스홀더와 글자가 겹치기 때문입니다. 같은 뜻의 `jsonb_exists(...)` 함수를 대신 씁니다.

### 스칼라 — `.arrayLength()` / `.typeOf()`

둘 다 `JsonScalarExpression`을 돌려줍니다. "JSON 함수 호출 결과를 비교 대상으로 그대로 들고 있는 것"이라고 생각하면 됩니다. 결과가 숫자이거나 문자열이라, `.eq/.neq/.gt/.gte/.lt/.lte` 비교를 바로 얹을 수 있어요.

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

## 실전 — 프로필 기반 세그먼트 필터

관리자 화면에서 "서울 거주, 22–35세, admin이나 editor, 태그에 `blue` 포함, 연락처 전화번호가 있는 사용자"를 한 쿼리로 뽑는다고 해 봅시다. 여러 JSON 연산이 한자리에 모이는 모습이 보여요.

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

같은 코드가 세 드라이버에서 모두 동작합니다. 경로 세그먼트와 비교 값은 빠짐없이 바인딩 파라미터로 들어가요. "`profile.tags`가 비어 있는 휴면 사용자"처럼 스칼라 함수 결과와 비교하는 변형도 그대로 얹힙니다.

```typescript
const dormant = await em.createQueryBuilder(User, "u")
  .where(u.profile.tags.arrayLength().eq(0))
  .getMany();
```

표현식이 길어진다 싶으면 `.when()` / `.pipe()` 같은 합성 헬퍼([편의 패턴](./query-builder-patterns.md))와 섞어 쓰면 됩니다. JSON 경로 조건도 다른 `ConditionLike`와 동일하게 취급되어 `Expressions.and(...)`, `Expressions.or(...)`에 그대로 들어가요.

## 동적 경로 — `.path(string)`

프록시 접근은 코드에 박힌 정적 경로에 강합니다. 대신 프록시가 잘 표현하지 못하는 두 가지가 있어요.

- **배열 인덱스** — 배열 타입이 느슨하면 TypeScript가 `u.profile.tags[0]`을 곧바로 허용하지 않을 때가 있습니다.
- **점·공백·구두점이 들어간 키** — `u.profile["weird key"]`는 프록시 방식으로는 안전하게 태우기 어렵습니다.

이럴 때 `.path()`를 씁니다. 문법은 JS의 프로퍼티 접근자와 같아요 — 점 구분(`tags.admin`), 대괄호 인덱스(`tags[0]`), 따옴표 키(`items["weird key"]`) 전부 지원합니다.

```typescript
u.profile.path("tags[0]").eq("admin");
u.profile.path(`items["weird key"][2].value`).isNotNull();
```
```sql
-- PostgreSQL (jsonb, 배열 인덱스는 정수로 정규화)
"u"."profile" -> 'tags' ->> 0 = $1
"u"."profile" -> 'items' -> 'weird key' -> 2 ->> 'value' IS NOT NULL
```

`.path()`는 프록시 접근과 합성됩니다. 정적으로 갈 수 있는 데까지 프로퍼티로 내려간 다음, 동적인 꼬리만 `.path()`로 붙이면 돼요.

```typescript
u.profile.personal.path("history[1].city").eq("Busan");
// 최종 경로 = ['personal', 'history', 1, 'city']
```

## 드라이버 치트시트

아래 예제는 모두 `jsonb` 컬럼 기준입니다. jsonb가 아닌 일반 `json` 컬럼은 legacy `#>> ARRAY[...]` 폴백으로 나가지만, GIN 인덱스 대상이 되는 `jsonb` 사용을 권장해요.

| 연산 | PostgreSQL (jsonb) | MySQL | SQLite |
|------|--------------------|-------|--------|
| Extract (text) | `col -> 'a' ->> 'b'` | `JSON_UNQUOTE(JSON_EXTRACT(col, '$.a.b'))` | `json_extract(col, '$.a.b')` |
| Extract (JSON) | `col -> 'a' -> 'b'` | `JSON_EXTRACT(col, '$.a.b')` | `json_extract(col, '$.a.b')` (SQLite는 항상 스칼라) |
| Contains (객체) | `col @> val::jsonb` | `JSON_CONTAINS(col, val, '$.path')` | 지원 안 함 — 객체 값은 `OrmError` |
| Contains (스칼라) | `col -> path @> to_jsonb(val::type)` | `JSON_CONTAINS(col, val, '$.path')` | 경로 동등 비교로 변환 |
| Has key | `jsonb_exists(col -> path, 'k')` | `JSON_CONTAINS_PATH(col, 'one', '$.path.k')` | `json_extract(col, '$.path.k') IS NOT NULL` |
| Array length | `jsonb_array_length(col -> path)` | `JSON_LENGTH(col, '$.path')` | `json_array_length(col, '$.path')` |
| Type of | `jsonb_typeof(col -> path)` | `JSON_TYPE(JSON_EXTRACT(col, '$.path'))` | `json_type(col, '$.path')` |

## 안전 장치와 한계

- **SQL 인젝션.** 경로 세그먼트, 키, 값 전부 바인딩 파라미터입니다. `.path("'; DROP TABLE users--")` 같은 악성 입력이 들어와도 prepared statement의 문자열 리터럴로 들어갈 뿐, 실행 가능한 SQL이 되지 않아요.
- **없는 경로.** 세 드라이버 모두 없는 경로를 추출하면 `NULL`을 돌려줍니다. "없는 것"과 "있는데 null"을 구분해야 한다면 `.isNull()` / `.isNotNull()` 또는 `.hasKey(...)`를 쓰세요.
- **SQLite 주의.** `json1` 확장이 필요합니다 (`better-sqlite3`에 기본 포함). `json_extract`가 SQLite의 스칼라 타입으로 값을 돌려주므로 `.gt(18)` 같은 숫자 비교는 캐스트 없이 바로 동작해요. 객체 containment는 지원하지 않아요.
- **`any`로 타입이 지워진 경우.** JSON 컬럼을 `any`로 두거나 타입 선언을 생략해도 프록시는 런타임에 정상 동작합니다. 단 타입스크립트 쪽에서의 자동완성을 잃어요.

JSON 필터를 쓰려고 `` em.query(sql`... ->> ${path}`) ``에 손이 가는 순간이 온다면, 먼저 QueryDSL 경로를 떠올려 보세요. 더 안전하고, 지원되는 모든 드라이버에서 이식성이 보장됩니다.

## 다음 단계

- [QueryDSL 표현식](./query-builder-querydsl.md) — 같은 프록시의 나머지 면: 집계, CASE, CAST, 날짜 컴포넌트, 윈도우 함수
- [집계 & 서브쿼리](./query-builder-aggregations.md) — JSON 경로로 뽑은 값을 GROUP BY 키로 쓰거나 `HAVING` 조건에 얹기
- [편의 패턴](./query-builder-patterns.md) — `when()`, `pipe()`, scope로 JSON 조건을 조합하고 재사용
- [Query Builder 개요](./query-builder.md) — 기본 사용법과 전체 지도
