# Query Builder — QueryDSL 표현식

이 페이지는 `qAlias()` 표현식 서피스 — 엔티티 프로퍼티 접근을 타입드 SQL
표현식으로 바꾸는 QueryDSL 스타일 API — 를 정리해요. JPA QueryDSL의
`QUser` 클래스를 써본 분이라면 멘탈 모델은 똑같아요. 다른 점은 코드
제너레이션이 필요 없다는 것 — 전체가 TypeScript `Proxy`예요.

## `qAlias()`가 나온 배경

이 서피스가 생기기 전에도 query builder는 컬럼을 지목하는 방법이 두 가지
있었어요.

```typescript
qb.where("firstName", "Alice")                        // 문자열 기반
qb.where(alias(User, "u").col("firstName"), "Alice")  // alias() — 컬럼명 자동완성
```

둘 다 연산자는 여전히 `"="`, `"LIKE"`처럼 문자열로 직접 써야 해요.
JPA를 써본 분이라면 다음 단계가 익숙할 거예요. `QUser` 같은 클래스를
코드 제너레이션으로 만들어 `qUser.firstName.eq("Alice")`라고 쓰는
패턴 — JPA QueryDSL이 정확히 그런 방식인데, 빌드 타임 코드 생성기가
필요해요.

**`qAlias()`는 코드 제너레이션 없이 같은 DX를 주는 TypeScript 구현이에요.**
엔티티의 모든 프로퍼티가 `ColumnExpression`인 척 위장하는 `Proxy`를
돌려줘요.

```typescript
const u = qAlias(User, "u");
qb.where(u.firstName.eq("Alice"));
//         │         └── ColumnExpression의 연산자 메서드
//         └── 프록시의 get trap이 "u.firstName"을 만들어 냄
```

런타임에 `u.firstName`이라는 실제 객체는 없어요. `get` trap이 호출될
때마다 `ColumnExpression("u.firstName")`을 즉석에서 만들고, `.eq("Alice")`가
이를 지연된 `ColumnCondition`으로 감싼 뒤, query builder가 빌드 시점에
`"u.firstName"`을 `"u"."first_name"`으로 해석해요 (`SnakeNamingStrategy`
포함).

JSON 컬럼에도 같은 원리의 프록시가 붙어요 — 자세한 내용은
[JSON 컬럼 탐색](./query-builder-json.md) 페이지를 보세요.

## `alias()` vs. `qAlias()`

둘 다 타입드 컬럼 참조를 만들어요. 연산자까지 자동완성하고 싶으면
`qAlias()`, 컬럼명만 자동완성하면 충분하면 `alias()`를 쓰면 돼요.

```typescript
import { alias, qAlias } from "@stingerloom/orm";

const u1 = alias(User, "u");
u1.col("firstName");          // "u.firstName" — 프로퍼티 자동완성만

const u2 = qAlias(User, "u");
u2.firstName.eq("Alice");     // 프로퍼티 + 연산자 자동완성
u2.col("firstName");          // qAlias도 .col() 지원
```

같은 쿼리 체인 안에서 두 스타일을 섞어 써도 전혀 문제없어요.

## 이 서피스로 할 수 있는 네 가지

`qAlias()`가 돌려주는 컬럼 참조는 최종적으로 네 가지 표현식으로 합성돼요.

- **정렬** — `.asc()` / `.desc()`, null 위치도 메서드로 지정
- **집계** — `.count()`, `.sum()`, `.avg()`, `.min()`, `.max()` — 같은
  표현식을 SELECT와 HAVING 양쪽에서 재사용
- **조건 묶기** — 어떤 조건이든 `.and()` / `.or()` / `.not()`, 그리고
  `Expressions` 네임스페이스의 정적 헬퍼
- **문자열 매칭** — `.startsWith()` / `.endsWith()` / `.contains()`가
  LIKE 특수문자를 자동 이스케이프, `*IgnoreCase` 변형 포함

여기 나오는 모든 건 지금까지 본 보장을 그대로 지켜요 — 컬럼 참조는
alias 레지스트리를 통해 해석되고 (`u.firstName`은 `SnakeNamingStrategy`
기준으로 `"u"."first_name"`으로 바뀌어요), 사용자 값은 LIKE 이스케이프
문자까지 포함해서 전부 바인딩 파라미터로 들어가요.

## 정렬 — `.asc()` / `.desc()` / `.nullsFirst()` / `.nullsLast()`

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

## 집계 — `.count()` / `.sum()` / `.avg()` / `.min()` / `.max()`

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

## SELECT 별칭 — `.as("name")`

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

## null 처리 — `coalesce()` / `nullif()`

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

## 현재 시각 — `currentDate()` / `currentTime()` / `currentTimestamp()`

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

## 타입 변환 — `.stringValue()` / `.intValue()` / `.longValue()` / `.floatValue()` / `.booleanValue()`

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

| Kind     | MySQL      | PostgreSQL | SQLite    | 호출 메서드                |
|----------|------------|------------|-----------|---------------------------|
| string   | `CHAR`     | `TEXT`     | `TEXT`    | `.stringValue()`           |
| int      | `SIGNED`   | `INTEGER`  | `INTEGER` | `.intValue()`              |
| long     | `SIGNED`   | `BIGINT`   | `INTEGER` | `.longValue()`             |
| bigint   | `SIGNED`   | `BIGINT`   | `INTEGER` | `.bigintValue()` (별칭)    |
| float    | `DECIMAL`  | `REAL`     | `REAL`    | `.floatValue()`            |
| boolean  | `UNSIGNED` | `BOOLEAN`  | `INTEGER` | `.booleanValue()`          |

`.bigintValue()`는 `.longValue()`와 동일한 SQL을 내지만 "JS `bigint`를 기대한다"는 의도를 읽는 사람에게 전달해요. 드라이버가 결과를 문자열로 돌려주는 경우가 있어서 JS 쪽에서 `BigInt(row.col)`로 감싸는 게 안전해요.

## 날짜 / 시각 컴포넌트 — `.year()` / `.month()` / `.day()` / `.hour()` / …

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

드라이버별 SQL 생성 (PostgreSQL과 SQLite는 결과를 **정수**로 쓰기 위해 `CAST(... AS INTEGER)`로 자동 감싸요 — 다운스트림 비교가 정수 산술로 유지돼요):

| 헬퍼 | MySQL | PostgreSQL | SQLite |
|------|-------|------------|--------|
| `year()` | `YEAR(col)` | `CAST(EXTRACT(YEAR FROM col) AS INTEGER)` | `CAST(strftime('%Y', col) AS INTEGER)` |
| `month()` | `MONTH(col)` | `CAST(EXTRACT(MONTH FROM col) AS INTEGER)` | `CAST(strftime('%m', col) AS INTEGER)` |
| `day()` / `dayOfMonth()` | `DAYOFMONTH(col)` | `CAST(EXTRACT(DAY FROM col) AS INTEGER)` | `CAST(strftime('%d', col) AS INTEGER)` |
| `hour()` | `HOUR(col)` | `CAST(EXTRACT(HOUR FROM col) AS INTEGER)` | `CAST(strftime('%H', col) AS INTEGER)` |
| `minute()` | `MINUTE(col)` | `CAST(EXTRACT(MINUTE FROM col) AS INTEGER)` | `CAST(strftime('%M', col) AS INTEGER)` |
| `second()` | `SECOND(col)` | `CAST(EXTRACT(SECOND FROM col) AS INTEGER)` | `CAST(strftime('%S', col) AS INTEGER)` |
| `dayOfWeek()` | `DAYOFWEEK(col)` | `CAST(EXTRACT(DOW FROM col) AS INTEGER)` | `CAST(strftime('%w', col) AS INTEGER)` |
| `dayOfYear()` | `DAYOFYEAR(col)` | `CAST(EXTRACT(DOY FROM col) AS INTEGER)` | `CAST(strftime('%j', col) AS INTEGER)` |
| `week()` | `WEEK(col)` | `CAST(EXTRACT(WEEK FROM col) AS INTEGER)` | `CAST(strftime('%W', col) AS INTEGER)` |

`dayOfWeek`와 `week`는 드라이버마다 인코딩이 살짝 달라요 — MySQL의 `DAYOFWEEK`은 1=일…7=토, PostgreSQL의 `DOW`는 0=일…6=토, SQLite의 `%w`는 PG와 같아요. 리포트 이식성이 중요하면 애플리케이션 계층에서 정규화하거나, 드라이버별 raw SQL을 쓰는 편이 안전해요.

## 서브쿼리 비교 — `.in(subquery)` / `.eq(subquery)` / `exists` / `notExists`

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

## `CASE WHEN …` — `Expressions.caseBuilder()` / `Expressions.cases(...)`

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

### 실전 — CASE를 "변수처럼" 재사용

CASE 표현식을 한 번 만들어 두면 SELECT와 WHERE 양쪽에서 재사용할 수 있어요. `coalesce`로 NULL fallback까지 얹으면, **서버에서 계산되는 파생 필드**가 되는 거예요.

```typescript
const u = qAlias(User, "u");

const tier = Expressions.caseBuilder()
  .when(u.score.gte(90)).then("gold")
  .when(u.score.gte(70)).then("silver")
  .otherwise("bronze")
  .end();

// SELECT + WHERE 에서 같은 표현식 재사용
const golds = await em.createQueryBuilder(User, "u")
  .select(["id", "name"])
  .addSelect(Expressions.coalesce(tier, u.status, "unknown").as("tier"))
  .where(Expressions.and(
    tier.eq("gold"),
    u.role.eq("member"),
  ))
  .getRawMany();
```

같은 CASE를 두 번 적지 않아도 되고, 등급 기준이 바뀌어도 한 군데만 고치면 돼요.

## 문자열 / 숫자 / 수학 — JS와 같은 이름

Tier 3의 문자열·숫자·수학 헬퍼는 TypeScript 개발자 손에 이미 익은 이름(`String.prototype`, 산술 연산자, `Math.*`)을 그대로 노출해요. 결과는 전부 `ScalarExpression`이니까 `.as()` / cast / coalesce / 비교 / 논리 결합 등 Tier 2에서 본 모든 기능과 바로 이어져요.

```typescript
const p = qAlias(Product, "p");

qb.select([
  p.name.toLowerCase().as("name_lc"),            // LOWER("p"."name")
  p.name.substring(0, 10).as("preview"),         // SUBSTR("p"."name", 1, 10)
  p.name.concat(" — ", p.sku).as("label"),       // CONCAT("p"."name", ' — ', "p"."sku")
  p.price.mul(0.9).round(2).as("discounted"),    // ROUND(("p"."price" * 0.9), 2)
  p.stock.abs().as("stock_abs"),                 // ABS("p"."stock")
])
.where(p.name.length().gt(20));                   // CHAR_LENGTH("p"."name") > 20
```

메서드 한눈에:

| 분류 | 메서드 |
|------|--------|
| 문자열 | `.toLowerCase()`, `.toUpperCase()`, `.trim()`, `.length()`, `.substring(start, end?)`, `.concat(...args)`, `.indexOf(needle)`, `.replace(from, to)` |
| 산술 | `.add(x)`, `.sub(x)`, `.mul(x)`, `.div(x)`, `.mod(x)`, `.neg()` |
| 수학 | `.abs()`, `.floor()`, `.ceil()`, `.round(digits?)`, `.sqrt()` |

알아두면 편한 동작 요약:

- **`substring`** — JS와 똑같이 0-based, end exclusive. 내부에서 `SUBSTR(col, start + 1, end - start)`로 변환돼요.
- **`length`** — `CHAR_LENGTH`라서 멀티바이트 안전. 바이트 수가 아니라 문자 수예요.
- **`indexOf`** — 못 찾으면 `-1`, 찾으면 0-based 위치. 드라이버별(`STRPOS` / `LOCATE` / `INSTR`) 1-based 결과에서 1을 빼 JS와 일치하게 맞춰요.
- **`mod`** — SQL `%` 연산자. 양수 피연산자는 JS와 결과가 같지만, 음수는 엔진마다 달라요 (PostgreSQL은 피제수 부호 유지, MySQL/SQLite는 JS와 같음).

모든 인자는 원시값(파라미터 바인딩) 또는 다른 컬럼/스칼라 표현식을 받으니, `p.price.add(p.discount)` 처럼 컬럼끼리도, `p.name.concat(" (", p.sku, ")")` 같은 혼합도 자연스럽게 돼요.

## 날짜 산술 — `.addDays()` / `.addMonths()` / …, `dateDiff`, `random`

달력 단위별 `add*` 6개(`addYears/Months/Days/Hours/Minutes/Seconds`), 두 날짜의 정수 차이를 돌려주는 `Expressions.dateDiff(a, b, unit)`, 엔진별 RNG를 감싸는 `Expressions.random()`을 한 번에 다룰 수 있어요. 리포트성 쿼리에서 raw SQL로 내려가는 일이 줄어들어요.

```typescript
const e = qAlias(Event, "e");

qb.select([
  e.startsAt.addDays(7).as("next_week"),
  e.startsAt.addMonths(-1).as("prev_month"),
  Expressions.dateDiff(e.endsAt, e.startsAt, "day").as("span_days"),
  Expressions.random().as("r"),
]);
```

드라이버별 생성:

| 연산 | MySQL | PostgreSQL | SQLite |
|------|-------|------------|--------|
| `addDays(7)` | `DATE_ADD(col, INTERVAL 7 DAY)` | `(col + (7 * INTERVAL '1 day'))` | `datetime(col, '+7 days')` |
| `dateDiff(a, b, "day")` | `TIMESTAMPDIFF(DAY, b, a)` | `CAST(EXTRACT(EPOCH FROM (a - b)) / 86400 AS INTEGER)` | `CAST((julianday(a) - julianday(b)) * 1 AS INTEGER)` |
| `dateDiff(a, b, "year")` | `TIMESTAMPDIFF(YEAR, b, a)` | 달력 기반 `age()` | `julianday() / 365.25` (근사) |
| `random()` | `RAND()` | `RANDOM()` | `RANDOM()` |

SQLite의 year/month 차이는 365.25 / 30.4375로 근사해요. 정확한 달력 차가 필요하면 MySQL `TIMESTAMPDIFF` 또는 PostgreSQL `age()` 쪽을 쓰세요.

## 윈도우 함수 — `aggregate.over()` + `WindowBuilder`

집계(`count`, `sum`, `avg`, `min`, `max`, `countDistinct`)에는 `.over()`가 달려 있어요. 체인으로 PARTITION BY / ORDER BY / `rowsBetween` 또는 `rangeBetween` 프레임을 지정하고, `.as(alias)`로 마무리해요.

```typescript
const e = qAlias(Event, "e");

qb.select([
  e.score.sum().over()
    .partitionBy(e.teamId)
    .orderBy(e.createdAt.desc())
    .rowsBetween("UNBOUNDED PRECEDING", "CURRENT ROW")
    .as("running_total"),
]);
// SUM("e"."score") OVER (PARTITION BY "e"."teamId"
//                        ORDER BY "e"."createdAt" DESC
//                        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
// AS "running_total"
```

`partitionBy(...)` / `orderBy(...)`는 **가변 인자**라서 복합 파티션 키나 다중 정렬 기준을 한 번에 넘길 수 있어요 — `partitionBy(e.teamId, e.region)`.

마무리는 둘 중 하나예요:
- `.as("alias")` — `AliasedExpression`으로 끝내서 SELECT에 바로 사용.
- `.toScalar()` — `ScalarExpression`으로 끝내서 다른 표현식 안에 중첩 (아래 리더보드 예제의 두 번째 쿼리 참고).

프레임 문자열(`"UNBOUNDED PRECEDING"`, `"CURRENT ROW"`, `"5 PRECEDING"` 등)은 그대로 SQL에 삽입돼요. **사용자 입력을 이 자리에 넘기지 마세요.** 누적 집계에는 `rowsBetween("UNBOUNDED PRECEDING", "CURRENT ROW")`를 쓰는 게 가장 일반적이고, 시간 범위 기반 집계에는 `rangeBetween(...)`을 쓰면 돼요.

### 실전 — 팀별 리더보드

팀 단위 시계열 이벤트에서 두 가지 리포트가 자주 필요해요 — 누적 점수와, "같은 팀 평균보다 높은 이벤트"예요. 후자는 `.toScalar()`로 윈도우 결과를 서브쿼리처럼 `WHERE`에 꽂는 패턴이에요.

```typescript
const e = qAlias(Event, "e");

// (1) 팀별 누적 점수 — SELECT 자리
const board = await em.createQueryBuilder(Event, "e")
  .select(["id", "teamId", "score"])
  .addSelect(
    e.score.sum().over()
      .partitionBy(e.teamId)
      .orderBy(e.createdAt.desc())
      .rowsBetween("UNBOUNDED PRECEDING", "CURRENT ROW")
      .as("running_total"),
  )
  .getRawMany();

// (2) 팀 평균보다 높은 이벤트만 — 윈도우를 WHERE에 중첩
const teamAvg = e.score.avg().over().partitionBy(e.teamId).toScalar();
const aboveAvg = await em.createQueryBuilder(Event, "e")
  .where(e.score.gt(teamAvg))
  .getMany();
// WHERE "e"."score" > AVG("e"."score") OVER (PARTITION BY "e"."teamId")
```

## TS 네이티브 이스케이프 해치 — `Expressions.raw<T>()` / `.bigintValue()` / `qb.selectSchema(...)`

TypeScript 생태계 맞춤 3종 세트예요.

**`Expressions.raw<T>(fragment)`** — 어떤 `sql-template-tag` `Sql` fragment이든 `ScalarExpression`으로 감싸요. Tier 2/3 합성 체인(`.as`, `.eq`, `coalesce` 등)에 그대로 연결돼요. 제네릭 `T`는 다운스트림 체인의 타입 힌트용이지 런타임 검증용은 아니에요.

```typescript
import sql from "sql-template-tag";
import { Expressions, qAlias } from "@stingerloom/orm";

const u = qAlias(User, "u");

const epoch = Expressions.raw<number>(
  sql`EXTRACT(epoch FROM ${u.col("createdAt")})`,
);

qb.select([epoch.as("epoch_s")])
  .where(epoch.gt(1700000000));
```

템플릿 내부의 파라미터 바인딩은 끝까지 그대로 보존돼요. 드라이버 고유 함수, 전문 검색 연산자 등 타입드 빌더가 아직 커버하지 않은 곳의 이스케이프 해치로 쓰세요.

**`.bigintValue()`** — `.longValue()`의 이름만 다른 형제. JS `bigint`를 다룬다는 의도를 명확히 표시해요. SQL은 `BIGINT` / `SIGNED` / `INTEGER`로 드라이버별 생성. 드라이버가 결과를 문자열로 내주는 경우가 있어서 JS 쪽에서 `BigInt(row.col)`로 감싸 주면 돼요.

**`qb.selectSchema(schema)`** — Zod / Valibot / Effect 등 `.parse(data)`를 가진 스키마를 row 검증기로 붙이면서, 동시에 `TResult` 타입을 `z.infer<schema>`로 좁혀줘요.

```typescript
import { z } from "zod";

const UserRow = z.object({ id: z.number(), name: z.string() });

const rows = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name"])
  .selectSchema(UserRow)
  .getMany();
//    ^? Array<{ id: number; name: string }>  — UserRow에서 추론
```

SELECT 리스트는 그대로예요 — 호출자가 `.select([...])`나 `.as("alias")`로 원하는 형태로 투영하고, `selectSchema`는 런타임 검증과 타입 추론만 걸어줘요. 두 번 호출 스타일을 선호하면 `.select(...).validate(schema)`로 같은 효과를 낼 수 있지만 타입 narrowing은 안 돼요.

## 조건 묶기 — `.and()` / `.or()` / `.not()`

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

## 문자열 매칭 — `.startsWith` / `.endsWith` / `.contains`

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

## 대소문자 무시 — `*IgnoreCase`

같은 세트에 `IgnoreCase` 버전이 있어요. 문자열 매칭이지만 대소문자를 구분하지 않아요.

```typescript
qb.where(u.username.equalsIgnoreCase("alice"));   // 정확히 일치, 대소문자만 무시
qb.where(u.email.containsIgnoreCase("@gmail"));   // 포함, 대소문자 무시
qb.where(u.email.startsWithIgnoreCase("admin@"));
qb.where(u.email.endsWithIgnoreCase(".com"));
qb.where(u.name.likeIgnoreCase("%Al%"));          // 와일드카드를 직접 쓰고 싶을 때
```

여기도 드라이버별로 내부 동작이 달라요.

- **`.likeIgnoreCase` 계열 (패턴 매칭)** — PostgreSQL은 `ILIKE`를 가지고 있어서 그걸 바로 쓰고, MySQL과 SQLite는 `LOWER()`를 양쪽에 씌워요.
- **`.equalsIgnoreCase`** — 세 드라이버 모두 `LOWER(col) = LOWER(?)`로 내려가요 (ILIKE는 와일드카드가 없는 동등 비교에는 쓰이지 않아요). 컬럼 콜레이션이 대소문자 구분이든 아니든 결과가 똑같이 나오도록 맞춰 줘요.

코드는 드라이버에 상관없이 한 줄로 끝나요 — 로그인 폼의 이메일 조회를 생각해 보세요.

```typescript
// 사용자가 "Alice@Example.com"이든 "alice@example.com"이든 같은 결과
const user = await em.createQueryBuilder(User, "u")
  .where(u.email.equalsIgnoreCase(inputEmail))
  .getOne();
```

## 한눈에 보기

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
| 문자열 / 숫자 / 수학      | `.toLowerCase/.toUpperCase/.trim/.length/.substring/.concat/.indexOf/.replace`, `.add/.sub/.mul/.div/.mod/.neg`, `.abs/.floor/.ceil/.round/.sqrt` |
| 날짜 산술                 | `.addYears/Months/Days/Hours/Minutes/Seconds(n)`, `Expressions.dateDiff(a, b, unit)`, `Expressions.random()` |
| 윈도우 함수               | `aggregate.over().partitionBy(...).orderBy(...).rowsBetween(start, end).as("alias")` — `rangeBetween` 도 동일하게 지원 |
| Raw SQL 이스케이프 해치   | `Expressions.raw<T>(sql`...`)` → `ScalarExpression` (체인 합성 가능) |
| BigInt cast               | `.bigintValue()` (BIGINT / SIGNED / INTEGER) |
| 스키마 기반 행 추론       | `qb.selectSchema(zodSchema)` — `TResult`를 `z.infer<schema>`로 narrow + 런타임 검증 |
| 조건 묶기                 | `.and(other)`, `.or(other)`, `.not()`                                         |
| 그룹을 직접 짜고 싶을 때  | `Expressions.and(...)`, `Expressions.or(...)`, `Expressions.not(cond)`        |
| 안전한 prefix / suffix / 포함 | `.startsWith`, `.endsWith`, `.contains` (LIKE 특수문자 자동 이스케이프)   |
| 대소문자 무시 매칭        | 위 이름 뒤에 `IgnoreCase`, 그리고 `.equalsIgnoreCase`, `.likeIgnoreCase`      |

## 다음 단계

- [JSON 컬럼 탐색](./query-builder-json.md) — 같은 프록시가 `json` / `jsonb` 컬럼으로 확장된 모습
- [JOIN](./query-builder-joins.md) — 타입드 컬럼 참조로 크로스 엔티티 쿼리
- [집계 & 서브쿼리](./query-builder-aggregations.md) — GROUP BY / HAVING / 스칼라 / 파생 서브쿼리
- [Query Builder 개요](./query-builder.md) — 기본 사용법과 전체 지도
