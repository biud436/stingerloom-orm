# Query Builder — QueryDSL 표현식

## 왜 필요할까

쿼리 빌더를 쓰다 보면 묘한 불균형이 눈에 들어옵니다. 컬럼 이름은 자동완성이 되는데, 연산자는 여전히 손으로 치는 문자열이라는 점이에요.

```typescript
qb.where("age", ">=", 18);
```

`"age"`는 `keyof User`에서 자동완성을 받습니다. 오타를 내면 컴파일 에러가 나죠. 그런데 `">="`은요? `"LIKE"`를 `"LKIE"`로 잘못 쳐도 에디터는 "그냥 문자열"이라며 아무 말도 하지 않습니다. 쿼리를 실행하기 전까지는 버그를 알 수 없습니다.

이 불편에 한 가지가 더 겹칩니다. 같은 표현식을 여러 곳에 반복해서 적어야 하는 상황이요.

```typescript
qb.addSelect(sql`COUNT(*)`, "total")
  .having(sql`COUNT(*) >= ${5}`)
  .addOrderBy(sql`COUNT(*)`, "DESC");
```

같은 `COUNT(*)`를 세 번 썼습니다. 기준이 바뀌어 `COUNT(DISTINCT user_id)`가 되어야 한다면 세 군데를 모두 고쳐야 해요. 한 군데라도 빠뜨리면 조용히 틀린 결과가 나옵니다.

두 불편은 뿌리가 같습니다. **SQL 표현식이 "값"이 아니라 "문자열"로 다뤄지기 때문**이에요. 값이라면 변수에 담아 재사용하고 타입 검사도 받을 수 있겠죠. 문자열은 그냥 문자열일 뿐입니다.

## 아이디어 — 표현식을 객체로

해결의 실마리는 단순합니다. **SQL 표현식을 일급 객체로 만든다.** 컬럼은 객체, 비교는 그 객체의 메서드, 결과도 또 다른 객체.

자바스크립트에서 이걸 가장 깔끔하게 구현하는 도구가 `Proxy`입니다. `qAlias()`가 돌려주는 값이 바로 프록시예요.

```typescript
import { qAlias } from "@stingerloom/orm";

const u = qAlias(User, "u");
qb.where(u.age.gte(18));
```

`u.age`를 읽을 때 실제로 어떤 값을 찾아오는 일은 없습니다. 프록시의 `get` 트랩이 접근을 가로채서 "u 별칭의 age 컬럼을 가리키는 표현식" 객체를 즉석에서 만들어요. 거기에 `.gte(18)`을 붙이면 "u.age가 18 이상이라는 조건" 객체가 됩니다. 이렇게 만들어진 조건 객체가 쿼리 빌더 안에 쌓였다가, 실행 직전에 한꺼번에 SQL로 변환됩니다.

```
u         .age              .gte(18)
│          │                 │
프록시     ColumnExpression  ColumnCondition
           ("u.age")         (u.age >= 18)
                             → SQL 컴파일 시점에
                             → "u"."age" >= $1
                             → 값 18은 파라미터 바인딩
```

네이밍 규약 번역도 이 단계에서 같이 처리됩니다. `snake_case`를 쓰고 있다면 `u.firstName`은 알아서 `"u"."first_name"`이 됩니다. 프록시가 컬럼 메타데이터를 참조하니까요.

JSON 컬럼도 같은 원리로 동작합니다. 그쪽은 경로가 중첩되는 만큼 약간의 확장이 들어가는데, 자세한 건 [JSON 컬럼 탐색](./query-builder-json.md)에서 따로 다룹니다.

## 무엇이 달라지나

단순히 문자열이 메서드로 바뀐 것만은 아닙니다. 표현식이 객체가 되니 **변수에 담을 수 있습니다.** 앞서 `COUNT(*)`를 세 번 적던 쿼리는 이렇게 바뀝니다.

```typescript
const p = qAlias(Post, "p");
const count = p.id.count();

await em.createQueryBuilder(Post, "p")
  .select(["category"])
  .addSelect(count.as("total"))
  .groupBy(["p.category"])
  .having(count.gte(5))
  .addOrderBy(count.desc())
  .getRawMany();
```

`count`를 한 번 만들어 SELECT·HAVING·ORDER BY 세 자리에 그대로 꽂습니다. 집계 기준이 바뀌면 `p.id.countDistinct()`로 한 줄만 고치면 돼요. 표현식 재사용은 리포트성 쿼리에서 특히 힘을 발휘합니다.

## `alias()`와 `qAlias()`의 관계

둘 다 타입이 있는 컬럼 참조를 만들어 주는데, 깊이가 다릅니다.

```typescript
import { alias, qAlias } from "@stingerloom/orm";

const u1 = alias(User, "u");
u1.col("firstName");          // "u.firstName" — 컬럼 이름만 자동완성

const u2 = qAlias(User, "u");
u2.firstName.eq("Alice");      // 컬럼 이름 + 연산자 자동완성
u2.col("firstName");           // qAlias도 .col() 지원
```

한 쿼리 안에서 두 스타일을 섞어 써도 아무 문제 없습니다. 가벼운 참조만 필요할 땐 `alias()`, 조건식까지 만들 땐 `qAlias()` — 이렇게 선택하면 됩니다.

### 동적 컬럼 접근 — `.field()` / `.jsonField()`

`qAlias()`의 정적 접근자는 컬럼 이름이 리터럴이어야 합니다. UI에서 선택된 정렬 키나 필터 필드처럼 컬럼 이름이 사용자 입력에서 온다면, 동적 접근자를 쓰세요.

```typescript
import { qAlias } from "@stingerloom/orm";

const ALLOWED_SORT = new Set(["id", "createdAt", "priority"]);

function buildIssueQuery(sortField: string) {
  if (!ALLOWED_SORT.has(sortField)) throw new Error("invalid sort");

  const i = qAlias(Issue, "i");
  return em
    .createQueryBuilder(Issue, "i")
    .where(i.status.eq("open"))
    .orderBy(i.field(sortField).desc());
}
```

- `field(name)` — 엔티티의 어떤 컬럼이든 `ColumnExpression`을 돌려줍니다. **서버 측 allowlist 검증을 마친 뒤에만** 호출하세요. 접근자 자체는 이름을 검사하지 않습니다.
- `jsonField(name)` — `@Column({ type: "json" | "jsonb" })` 컬럼용 `JsonPathExpression`을 돌려줍니다. JSON으로 등록되지 않은 컬럼이면 일반 컬럼 프록시로 폴백합니다.

둘 다 컬럼 이름에 대한 TypeScript의 keyof 좁힘을 우회하므로, 안전성을 지키는 책임은 호출 측에 있습니다.

---

여기서부터는 `qAlias()`가 돌려주는 컬럼 참조로 할 수 있는 것들을 하나씩 정리합니다. 모든 예제는 동일한 두 가지 약속을 지킵니다. 컬럼 참조는 별칭 레지스트리를 통해 해석되고, 사용자 값은 전부 파라미터 바인딩으로 들어갑니다.

## 정렬 — `.asc()` / `.desc()` / `.nullsFirst()` / `.nullsLast()`

정렬 방향을 메서드로 씁니다.

```typescript
const u = qAlias(User, "u");

await em.createQueryBuilder(User, "u")
  .orderBy(u.createdAt.desc().nullsLast())   // 최신 먼저, null은 뒤로
  .addOrderBy(u.name.asc())                  // 같은 시각이면 이름순
  .getMany();
```

`orderBy()`는 정렬 기준을 새로 설정하고, `addOrderBy()`는 그 뒤에 하나 더 붙입니다. 기존에 쓰던 `orderBy({ name: "ASC" })` 형식도 그대로 동작해요.

`.nullsLast()`와 `.nullsFirst()`는 null 값을 어디로 몰지 정합니다. 드라이버마다 사정이 조금 다른데, 정리하면 이렇습니다.

- PostgreSQL과 SQLite는 `ORDER BY col DESC NULLS LAST` 구문을 그대로 지원합니다.
- MySQL은 그런 키워드가 없어요. 대신 `col IS NULL` 값(0 또는 1)으로 한 번 더 정렬하면 같은 효과가 납니다. 이 변환은 Stingerloom이 알아서 처리합니다.

그래서 코드는 어느 드라이버에서든 `u.createdAt.desc().nullsLast()` 그대로입니다.

## 집계 — `.count()` / `.sum()` / `.avg()` / `.min()` / `.max()`

컬럼 뒤에 집계 함수를 바로 붙입니다.

```typescript
const u = qAlias(User, "u");
const total = u.id.count();   // COUNT(u.id) — 아직 SQL이 아닌 "표현식"

await em.createQueryBuilder(User, "u")
  .select(["departmentId"])
  .addSelect(total.as("total"))           // SELECT에 넣을 땐 .as()로 이름 지정
  .groupBy(["u.departmentId"])
  .having(total.gt(10))                   // HAVING에도 같은 표현식 재사용
  .getRawMany();
```

핵심은 `const total = u.id.count()`로 만든 표현식을 **SELECT에도 넣고 HAVING 조건으로도 그대로 쓴다**는 점입니다. 같은 COUNT를 두 번 적지 않아도 돼요. 비교 메서드는 조건을 쓸 때와 똑같이 `.eq`, `.gt`, `.lt`, `.between` 전부 달려 있습니다.

SELECT에 넣을 때 `.as("total")`을 권장합니다. 생략하면 `agg_count_id` 같은 이름이 자동으로 붙는데, `getRawMany()`로 꺼낼 때 키 이름이 헷갈리기 쉬워요.

중복을 빼고 세고 싶으면 `.countDistinct()`를 씁니다. `COUNT(DISTINCT u.role)`로 나갑니다.

## 조건부 집계 — `.filter(...)` / `countIf` / `sumIf`

`.filter(condition)`은 집계를 조건에 맞는 행으로만 한정합니다. 범위가 다른 여러 집계를 쿼리 하나의 `GROUP BY` 한 번으로 묶을 수 있어, 상태별로 따로 조회할 필요가 없습니다.

```typescript
const u = qAlias(User, "u");

await em.createQueryBuilder(User, "u")
  .select([
    u.id.count().as("total"),
    u.id.count().filter(u.status.eq("active")).as("active"),
    u.id.countIf(u.status.eq("churned")).as("churned"),  // 단축형
    u.amount.sumIf(u.type.eq("refund")).as("refunds"),    // 단축형
  ])
  .getRawMany();
```

`countIf(cond)` / `sumIf(cond)`는 각각 `.count().filter(cond)` / `.sum().filter(cond)`의 단축형입니다. 조건에는 컬럼 비교, `.and()` / `.or()` 합성, JSON 경로 조건 등 모든 `ConditionLike`를 그대로 쓸 수 있어, WHERE에서 쓰던 DSL을 재사용합니다.

이 절은 드라이버별로 자동 변환됩니다.

- **PostgreSQL / SQLite**: 표준 SQL인 `COUNT("u"."id") FILTER (WHERE "u"."status" = $1)`을 그대로 냅니다.
- **MySQL**: `FILTER` 절이 없으므로 동등한 조건부 집계 `COUNT(CASE WHEN \`u\`.\`status\` = ? THEN \`u\`.\`id\` END)`로 변환합니다. `COUNT(*)`는 `CASE` 안에서 리터럴 `1`로 치환됩니다(`*`는 `CASE` 결과로 쓸 수 없음).

두 형태 모두 NULL 의미가 같습니다. 일치하는 행이 없으면 `COUNT`는 `0`, `SUM` / `AVG` / `MIN` / `MAX`는 `NULL`을 돌려줍니다. 필터가 걸린 집계는 `having()`에서도 동작합니다(`u.id.countIf(...).gt(10)`).

## SELECT 별칭 — `.as("name")`

일반 컬럼, JSON 경로, 집계 어디에든 `.as("name")`을 붙일 수 있습니다. 결과는 `AliasedExpression`이고, SELECT 자리에서만 의미가 있어요. `where()`나 `having()`에는 넘길 수 없도록 타입으로 막혀 있습니다.

```typescript
const u = qAlias(User, "u");

await em.createQueryBuilder(User, "u")
  .select([
    u.name.as("display_name"),                 // 컬럼 별칭
    u.metadata.profile.email.as("contact"),    // JSON 경로 + 별칭
    u.id.count().as("total"),                  // 집계 + 별칭
  ])
  .groupBy(["u.name", "u.metadata"])
  .getRawMany();
```

JSON 경로 별칭은 드라이버별 텍스트 추출 연산자(`#>>`, `JSON_UNQUOTE(JSON_EXTRACT(...))`, `json_extract()`)로 각각 컴파일되고, 경로 문자열은 바인딩 파라미터로 붙어 직렬화 과정에서도 안전하게 보존됩니다.

`addSelect(u.age.as("years"))`로 기존 SELECT 목록 뒤에 덧붙여도 되고, 한 번의 `select([...])`에 별칭 컬럼과 집계를 섞어 넣어도 됩니다.

## `CASE WHEN …` — 조건 분기 표현식

::: tip `Expressions`는 이름이 긴 편
이번 섹션부터 여러 곳에서 쓰이는 `Expressions` 네임스페이스는 import 시 별칭을 걸어서 씁니다.

```typescript
import { Expressions as exp } from "@stingerloom/orm";
```

`exp`는 공개 API에서 다른 의미로 쓰이지 않아 자리가 비어 있습니다. 문서에 `Expressions.xxx`로 표기된 것은 모두 `exp.xxx`로도 호출 가능합니다.
:::

SQL에는 두 종류의 CASE가 있습니다. 각각 전용 빌더를 제공해요.

**Searched CASE** — `caseBuilder()`. 조건을 이어가는 방식입니다. 각 분기는 조건과 결과값 쌍이고, 마지막에 기본값을 `otherwise(...)`로 달고 `.end()`로 마무리합니다.

```typescript
const u = qAlias(User, "u");

const tier = exp.caseBuilder()
  .when(u.score.gte(90)).then("gold")
  .when(u.score.gte(70)).then("silver")
  .otherwise("bronze")
  .end();

qb.select([tier.as("tier")]);
// SELECT CASE WHEN "u"."score" >= ? THEN ?
//             WHEN "u"."score" >= ? THEN ?
//             ELSE ? END AS "tier"
```

**Simple CASE** — `cases(subject)`. 값 매칭 스위치 스타일입니다.

```typescript
const weight = exp.cases(u.status)
  .when("active",  1)
  .when("pending", 0)
  .otherwise(-1)
  .end();

qb.select([weight.as("w")]);
// SELECT CASE "u"."status" WHEN ? THEN ?
//                           WHEN ? THEN ?
//                           ELSE ? END AS "w"
```

`.end()`가 돌려주는 건 `ScalarExpression`이라, 지금까지 본 모든 연산(캐스팅, 별칭, 비교, coalesce 등)을 그대로 이어 붙일 수 있어요.

오용 방어도 해둡니다. `.otherwise()` 뒤에 `.when()`을 더 붙이거나, `.otherwise()`를 두 번 호출하거나, WHEN 없이 `.end()`를 부르는 세 경우에는 명확한 에러가 납니다. 잘못된 SQL이 실행까지 흘러가지 않도록 막아두는 장치예요.

### 실전 — CASE를 변수처럼 재사용

CASE 표현식도 한 번 만들어 두면 여기저기 꽂을 수 있습니다. `coalesce`로 NULL fallback까지 얹으면 **서버에서 계산되는 파생 필드** 하나가 생기는 셈이죠.

```typescript
const u = qAlias(User, "u");

const tier = exp.caseBuilder()
  .when(u.score.gte(90)).then("gold")
  .when(u.score.gte(70)).then("silver")
  .otherwise("bronze")
  .end();

const golds = await em.createQueryBuilder(User, "u")
  .select(["id", "name"])
  .addSelect(exp.coalesce(tier, u.status, "unknown").as("tier"))
  .where(exp.and(
    tier.eq("gold"),
    u.role.eq("member"),
  ))
  .getRawMany();
```

같은 CASE를 두 번 적지 않아도 되고, 등급 기준이 바뀌어도 한 군데만 고치면 됩니다.

### 자주 쓰는 CASE 모양용 단축 헬퍼

자주 나오는 세 가지 CASE 모양은 전용 단축 함수로 줄여 쓸 수 있습니다. 분기가 제각각이면 기존 빌더가 낫고, 아래 표의 모양이 정확히 맞는 경우에만 단축 함수를 쓰세요. 출력 SQL은 빌더와 동일합니다.

| 모양 | 단축 | 언제 쓰나 |
|------|------|-----------|
| 두 갈래 조건 선택 | `Expressions.iff(cond, a, b)` | 조건 하나로 값 두 개 중 고를 때 (소프트 삭제 플래그, 기능 토글, Y/N 출력 등) |
| 정적 값 매핑 | `Expressions.mapValues(subject, { k: v }, default?)` | 컬럼 값이 상수에 1:1로 대응할 때 |
| 임계값 사다리 | `Expressions.buckets(subject, [[t, label], …], default?, { op? })` | 같은 연산자·오름/내림 정렬된 임계값으로 한 숫자 컬럼을 버킷팅할 때 |

#### `Expressions.iff(condition, whenTrue, whenFalse)`

```typescript
const u = qAlias(User, "u");

qb.select([
  exp.iff(u.deletedAt.isNull(), "active", "deleted").as("state"),
]);
// SELECT CASE WHEN "u"."deleted_at" IS NULL THEN ? ELSE ? END AS "state"
```

#### `Expressions.mapValues(subject, mapping, default?)`

객체 키는 `WHEN` 값으로 파라미터 바인딩됩니다. 키는 문자열로 강제 변환되므로 enum·status·role 같은 문자열 컬럼에 가장 잘 맞습니다. `default`를 생략하면 `ELSE`가 빠지고, 명시적으로 `ELSE NULL`을 쓰려면 `null`을 넘기세요.

```typescript
qb.select([
  exp.mapValues(u.status, { active: 1, pending: 0 }, -1).as("w"),
]);
// SELECT CASE "u"."status" WHEN ? THEN ?
//                           WHEN ? THEN ?
//                           ELSE ? END AS "w"
```

#### `Expressions.buckets(subject, thresholds, default?, { op })`

각 `[threshold, result]` 튜플은 `WHEN subject <op> threshold THEN result` 한 분기로 펼쳐지고, 입력 순서가 그대로 보존됩니다. 기본 연산자는 `">="`(내림차순 임계값). 오름차순 코호트는 `"<"`·`"<="`, 엄격 내림은 `">"`로 바꿔 주세요.

```typescript
// 내림차순 >= 사다리 (기본)
exp.buckets(u.score, [
  [90, "gold"],
  [70, "silver"],
], "bronze");

// 오름차순 < 사다리 — age → cohort
exp.buckets(u.age, [
  [18, "child"],
  [65, "adult"],
], "senior", { op: "<" });
```

세 함수 모두 `ScalarExpression`을 돌려주므로, `.as()` · 캐스팅 · 비교 · `coalesce(...)` · `Expressions.and(...)`·`.or(...)` 등 Tier 2/3 전 연산에 그대로 연결됩니다. mapping이나 thresholds가 비어 있으면 즉시 예외가 발생합니다.

## null 처리 — `coalesce()` / `nullif()`

`coalesce(a, b, c, …)`는 왼쪽에서 오른쪽으로 처음 null이 아닌 값을 돌려줍니다. `nullif(a, b)`는 `a`가 `b`와 같으면 NULL, 다르면 `a`를 돌려주죠. 빈 문자열이나 `-1` 같은 센티넬 값을 진짜 NULL로 바꿔야 할 때 씁니다. 둘 다 표준 SQL이라 드라이버 구분 없이 동일합니다.

```typescript
import { coalesce, nullif, qAlias } from "@stingerloom/orm";

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

인자 자리에는 컬럼, JSON 경로 추출, 집계, 중첩된 `coalesce`, 원시 값 어느 것이든 섞어 써도 됩니다. 값은 자동으로 바인딩돼 안전하고요. 결과가 `ScalarExpression`이라 `.eq()`, `.gt()`, `.as()`도 바로 이어집니다.

정적 헬퍼로 `Expressions.coalesce` / `Expressions.nullif`도 있습니다. 호출 스타일이 더 맞는 쪽을 고르세요.

## 현재 시각 — `currentDate()` / `currentTime()` / `currentTimestamp()`

DB 서버의 시계를 어느 자리에든 꽂을 수 있는 표준 SQL 헬퍼 세 가지입니다. 결과는 `ScalarExpression`이라 `.as()`, `.eq()`, `coalesce` 중첩 등 지금까지 본 합성이 전부 그대로 됩니다. 세 드라이버 모두 동일한 리터럴(`CURRENT_DATE` / `CURRENT_TIME` / `CURRENT_TIMESTAMP`)로 나갑니다.

```typescript
import { Expressions as exp, qAlias } from "@stingerloom/orm";

const s = qAlias(Session, "s");

qb.where(s.expiresAt.gte(exp.currentTimestamp()));
// WHERE "s"."expires_at" >= CURRENT_TIMESTAMP

qb.select([exp.currentDate().as("today")]);
// SELECT CURRENT_DATE AS "today"
```

비교 메서드에 스칼라 표현식을 넘기면 파라미터 바인딩이 아니라 SQL 안에 직접 삽입됩니다. 그래서 `u.createdAt.lte(currentTimestamp())`처럼 써도 바인딩이 아니라 `CURRENT_TIMESTAMP` 그대로 쿼리에 박혀요.

## 타입 변환 — `.stringValue()` / `.intValue()` / `.longValue()` / `.floatValue()` / `.booleanValue()`

컬럼이나 스칼라 표현식을 다른 SQL 타입으로 CAST합니다. 드라이버마다 받는 타입 이름이 달라요(MySQL은 `INTEGER` 대신 `SIGNED`, SQLite는 `BOOLEAN` 대신 `INTEGER` 같은 식) — 메서드 이름만 기억하면 됩니다. 나머지는 내부에서 변환돼요.

```typescript
const i = qAlias(Item, "i");

qb.select([i.quantity.stringValue().as("qty_str")]);
// PG/SQLite:  CAST("i"."quantity" AS TEXT) AS "qty_str"
// MySQL:      CAST(`i`.`quantity` AS CHAR)  AS `qty_str`

qb.where(i.sku.intValue().gt(1000));
// PG/SQLite:  CAST("i"."sku" AS INTEGER) > ?
// MySQL:      CAST(`i`.`sku` AS SIGNED)  > ?
```

CAST 헬퍼는 `ColumnExpression`과 `ScalarExpression` 양쪽에 다 달려 있습니다. `coalesce(u.price, 0).floatValue()`처럼 이미 파생된 스칼라에도 이어 붙일 수 있고, 결과도 `ScalarExpression`이라 `.as()`, `.eq()`, 중첩된 `coalesce`에 그대로 들어갑니다.

| 종류     | MySQL      | PostgreSQL | SQLite    | 메서드                    |
|----------|------------|------------|-----------|---------------------------|
| string   | `CHAR`     | `TEXT`     | `TEXT`    | `.stringValue()`          |
| int      | `SIGNED`   | `INTEGER`  | `INTEGER` | `.intValue()`             |
| long     | `SIGNED`   | `BIGINT`   | `INTEGER` | `.longValue()`            |
| bigint   | `SIGNED`   | `BIGINT`   | `INTEGER` | `.bigintValue()` (별칭)   |
| float    | `DECIMAL`  | `REAL`     | `REAL`    | `.floatValue()`           |
| boolean  | `UNSIGNED` | `BOOLEAN`  | `INTEGER` | `.booleanValue()`         |

`.bigintValue()`는 `.longValue()`와 완전히 같은 SQL을 냅니다. 이름만 달라요. "JS의 `bigint`를 기대한다"는 의도를 읽는 사람에게 전달하고 싶을 때 씁니다. 드라이버가 결과를 문자열로 돌려주는 경우가 있어서, JS 쪽에서 `BigInt(row.col)`로 감싸주면 안전합니다.

## 날짜 · 시각 컴포넌트 — `.year()` / `.month()` / `.day()` / `.hour()` / …

날짜나 타임스탬프 컬럼에서 연·월·일·시 같은 일부 성분만 뽑아낼 수 있습니다. 열 개의 메서드가 있어요: `year`, `month`, `day`(= `dayOfMonth`), `hour`, `minute`, `second`, `dayOfWeek`, `dayOfMonth`, `dayOfYear`, `week`. 결과는 `ScalarExpression`이라 SELECT·WHERE·HAVING 어디든 쓰고, `.as()` / 캐스팅 / coalesce로 이어 붙입니다.

```typescript
const e = qAlias(Event, "e");

qb.select([e.startsAt.year().as("yr"), e.id.count().as("total")])
  .groupBy(["e.startsAt"])
  .having(e.startsAt.year().gte(2026));
// PG:     CAST(EXTRACT(YEAR FROM "e"."starts_at") AS INTEGER) = ?
// MySQL:  YEAR(`e`.`starts_at`) = ?
// SQLite: CAST(strftime(?, "e"."starts_at") AS INTEGER) = ?   -- '%Y'
```

드라이버별 SQL 생성표입니다. PostgreSQL과 SQLite는 결과를 정수로 쓰기 위해 `CAST(... AS INTEGER)`로 감쌉니다. 이후 비교 연산이 정수 산술로 유지되도록 하는 장치예요.

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

한 가지 주의할 점. `dayOfWeek`과 `week`은 드라이버마다 인코딩이 살짝 달라요. MySQL의 `DAYOFWEEK`은 1=일요일, 7=토요일, PostgreSQL의 `DOW`는 0=일요일, 6=토요일, SQLite의 `%w`는 PostgreSQL과 같습니다. 리포트의 이식성이 중요하면 애플리케이션 계층에서 한 번 정규화하거나, 드라이버별 raw SQL을 쓰는 게 안전합니다.

## 서브쿼리 비교 — `.in(subquery)` / `.eq(subquery)` / `exists` / `notExists`

`ColumnExpression.in()`과 `.notIn()`은 값 배열뿐 아니라 `SelectQueryBuilder`도 받습니다. 서브쿼리를 넘기면 `col IN (SELECT …)` 형태로 내려가고, 안쪽 파라미터 바인딩도 그대로 보존돼요. `.eq`, `.neq`, `.gt`, `.gte`, `.lt`, `.lte`도 같은 방식으로 단일 값 반환 서브쿼리를 받아 `col <op> (SELECT …)`를 만듭니다.

```typescript
const u = qAlias(User, "u");
const p = qAlias(Post, "p");

const activeAuthors = em
  .createQueryBuilder(Post, "p")
  .select(["authorId"])
  .where(p.status.eq("published"));

qb.where(u.id.in(activeAuthors));
// WHERE "u"."id" IN (SELECT "p"."authorId" FROM "post" AS "p"
//                    WHERE "p"."status" = ?)

// 스칼라 서브쿼리 — 집계 결과와 비교
const avgViews = em
  .createQueryBuilder(Post, "p2")
  .selectRaw(["AVG(p2.views)"]);

qb.where(p.views.gt(avgViews));
// WHERE "p"."views" > (SELECT AVG(p2.views) FROM …)
```

`Expressions.exists(subQb)` / `Expressions.notExists(subQb)`는 상관 서브쿼리 조건을 만듭니다.

```typescript
qb.where(exp.exists(em.createQueryBuilder(Post, "p")
  .select(["id"])
  .where(sql`"p"."author_id" = "u"."id"`)));
// WHERE EXISTS (SELECT "id" FROM "post" AS "p"
//               WHERE "p"."author_id" = "u"."id")
```

`ExistsCondition.not()`은 전체를 `NOT (…)`으로 감싸지 않고 내부의 `EXISTS` ↔ `NOT EXISTS` 플래그만 뒤집습니다. SQL이 깔끔하게 나와요.

## 문자열 / 숫자 / 수학 — JS와 같은 이름

문자열·숫자·수학 헬퍼는 자바스크립트 개발자 손에 이미 익은 이름(`String.prototype`, 산술 연산자, `Math.*`)을 그대로 노출합니다. 결과는 전부 `ScalarExpression`이라 `.as()` / 캐스팅 / coalesce / 비교 / 논리 결합에 바로 이어집니다.

```typescript
const p = qAlias(Product, "p");

qb.select([
  p.name.toLowerCase().as("name_lc"),            // LOWER("p"."name")
  p.name.substring(0, 10).as("preview"),         // SUBSTR("p"."name", 1, 10)
  p.name.concat(" — ", p.sku).as("label"),       // CONCAT("p"."name", ' — ', "p"."sku")
  p.price.mul(0.9).round(2).as("discounted"),    // ROUND(("p"."price" * 0.9), 2)
  p.stock.abs().as("stock_abs"),                 // ABS("p"."stock")
])
.where(p.name.length().gt(20));                  // CHAR_LENGTH("p"."name") > 20
```

메서드를 한눈에 정리하면 이렇습니다.

| 분류   | 메서드 |
|--------|--------|
| 문자열 | `.toLowerCase()`, `.toUpperCase()`, `.trim()`, `.length()`, `.substring(start, end?)`, `.concat(...args)`, `.indexOf(needle)`, `.replace(from, to)` |
| 산술   | `.add(x)`, `.sub(x)`, `.mul(x)`, `.div(x)`, `.mod(x)`, `.neg()` |
| 수학   | `.abs()`, `.floor()`, `.ceil()`, `.round(digits?)`, `.sqrt()` |

알아두면 좋은 동작 몇 가지.

- **`substring`** — JS와 똑같이 0부터 시작, 끝 인덱스는 제외. 내부에서 `SUBSTR(col, start + 1, end - start)`로 변환됩니다.
- **`length`** — `CHAR_LENGTH`라서 멀티바이트 안전. 바이트 수가 아니라 문자 수예요.
- **`indexOf`** — 못 찾으면 `-1`, 찾으면 0부터 세는 위치. 드라이버별 함수(`STRPOS`, `LOCATE`, `INSTR`)의 1-based 결과에서 1을 빼 JS와 일치시킵니다.
- **`mod`** — SQL의 `%` 연산자. 양수 피연산자는 JS와 결과가 같지만 음수는 엔진마다 달라요 (PostgreSQL은 피제수 부호 유지, MySQL/SQLite는 JS와 같음).

인자 자리에는 원시 값(파라미터 바인딩)이든 다른 컬럼·스칼라 표현식이든 넘길 수 있어 `p.price.add(p.discount)`처럼 컬럼끼리도, `p.name.concat(" (", p.sku, ")")` 같은 혼합도 자연스럽게 됩니다.

## 날짜 산술 — `.addDays()` / `.addMonths()` / …, `dateDiff`, `random`

달력 단위별 `add*` 여섯 개(`addYears/Months/Days/Hours/Minutes/Seconds`), 두 날짜의 정수 차이를 돌려주는 `Expressions.dateDiff(a, b, unit)`, 엔진별 RNG를 감싸는 `Expressions.random()`을 한 자리에서 다룹니다. 리포트성 쿼리에서 raw SQL로 내려갈 일이 줄어들어요.

```typescript
const e = qAlias(Event, "e");

qb.select([
  e.startsAt.addDays(7).as("next_week"),
  e.startsAt.addMonths(-1).as("prev_month"),
  exp.dateDiff(e.endsAt, e.startsAt, "day").as("span_days"),
  exp.random().as("r"),
]);
```

드라이버별 생성 SQL:

| 연산 | MySQL | PostgreSQL | SQLite |
|------|-------|------------|--------|
| `addDays(7)` | `DATE_ADD(col, INTERVAL 7 DAY)` | `(col + (7 * INTERVAL '1 day'))` | `datetime(col, '+7 days')` |
| `dateDiff(a, b, "day")` | `TIMESTAMPDIFF(DAY, b, a)` | `CAST(EXTRACT(EPOCH FROM (a - b)) / 86400 AS INTEGER)` | `CAST((julianday(a) - julianday(b)) * 1 AS INTEGER)` |
| `dateDiff(a, b, "year")` | `TIMESTAMPDIFF(YEAR, b, a)` | 달력 기반 `age()` | `julianday() / 365.25` (근사) |
| `random()` | `RAND()` | `RANDOM()` | `RANDOM()` |

SQLite의 연·월 단위 차이는 365.25 / 30.4375로 근사합니다. 정확한 달력 차가 필요하면 MySQL의 `TIMESTAMPDIFF`나 PostgreSQL의 `age()`를 쓰세요.

## 윈도우 함수 — `aggregate.over()` + `WindowBuilder`

집계(`count`, `sum`, `avg`, `min`, `max`, `countDistinct`)에는 `.over()`가 달려 있습니다. 체인으로 PARTITION BY / ORDER BY / 프레임(`rowsBetween` 또는 `rangeBetween`)을 지정하고 `.as(alias)`로 마무리합니다.

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

`partitionBy(...)`와 `orderBy(...)`는 가변 인자라 복합 파티션 키나 다중 정렬 기준을 한 번에 넘길 수 있어요 — `partitionBy(e.teamId, e.region)`.

마무리는 두 가지 중 하나입니다.

- `.as("alias")` — `AliasedExpression`으로 끝내 SELECT에 바로 사용.
- `.toScalar()` — `ScalarExpression`으로 끝내 다른 표현식 안에 중첩 (아래 실전 예제의 두 번째 쿼리 참고).

프레임 문자열(`"UNBOUNDED PRECEDING"`, `"CURRENT ROW"`, `"5 PRECEDING"` 등)은 그대로 SQL에 삽입됩니다. **사용자 입력을 이 자리에 넘기지 마세요.** 누적 집계라면 `rowsBetween("UNBOUNDED PRECEDING", "CURRENT ROW")`이 가장 일반적이고, 시간 범위 기반 집계라면 `rangeBetween(...)`을 씁니다.

### 실전 — 팀별 리더보드

팀 단위 시계열 이벤트에서 자주 필요한 리포트 두 가지가 있습니다. 하나는 누적 점수, 다른 하나는 "같은 팀 평균보다 높은 이벤트"예요. 후자는 `.toScalar()`로 윈도우 결과를 서브쿼리처럼 `WHERE`에 꽂는 패턴입니다.

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

## TypeScript 친화 이스케이프 해치 — `Expressions.raw<T>()` / `.bigintValue()` / `qb.selectSchema(...)`

타입드 빌더가 아직 커버하지 못하는 영역을 위한 세 가지 장치입니다.

**`Expressions.raw<T>(fragment)`** — 어떤 `sql-template-tag` 조각이든 `ScalarExpression`으로 감쌉니다. 이후 `.as`, `.eq`, `coalesce` 같은 합성에 그대로 이어져요. 제네릭 `T`는 다운스트림 체인의 타입 힌트용이지 런타임 검증용은 아닙니다.

```typescript
import sql from "sql-template-tag";
import { Expressions as exp, qAlias } from "@stingerloom/orm";

const u = qAlias(User, "u");

const epoch = exp.raw<number>(
  sql`EXTRACT(epoch FROM ${u.col("createdAt")})`,
);

qb.select([epoch.as("epoch_s")])
  .where(epoch.gt(1700000000));
```

템플릿 안의 파라미터 바인딩은 끝까지 보존됩니다. 드라이버 고유 함수나 전문 검색 연산자처럼 타입드 빌더가 커버하지 못하는 구석의 이스케이프 해치로 쓰세요.

**`.bigintValue()`** — `.longValue()`의 이름만 다른 형제입니다. JS의 `bigint`를 다룬다는 의도를 읽는 이에게 명시적으로 전달할 때 씁니다. SQL은 드라이버별로 `BIGINT` / `SIGNED` / `INTEGER`로 나갑니다. 드라이버가 결과를 문자열로 내주는 경우가 있어 JS 쪽에서 `BigInt(row.col)`로 감싸주면 됩니다.

**`qb.selectSchema(schema)`** — Zod, Valibot, Effect처럼 `.parse(data)`를 가진 스키마를 행 검증기로 붙이면서, 동시에 `TResult` 타입을 `z.infer<schema>`로 좁혀줍니다.

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

SELECT 리스트는 호출자가 `.select([...])`나 `.as("alias")`로 원하는 대로 투영하고, `selectSchema`는 런타임 검증과 타입 추론만 얹어줍니다. 두 단계로 분리해서 쓰고 싶으면 `.select(...).validate(schema)`로도 같은 효과를 낼 수 있지만, 그땐 타입 narrowing은 일어나지 않습니다.

## 조건 묶기 — `.and()` / `.or()` / `.not()`

두 조건을 AND로 묶거나 OR로 풀거나 부정할 수 있습니다.

```typescript
const u = qAlias(User, "u");

// (age >= 18) AND (status = 'active')
qb.where(u.age.gte(18).and(u.status.eq("active")));

// role이 admin이거나 owner
qb.where(u.role.eq("admin").or(u.role.eq("owner")));

// isNull을 부정 → isNotNull과 같음
qb.where(u.deletedAt.isNull().not());
```

체인 순서는 읽는 그대로입니다. `a.and(b).or(c)`는 `(a AND b) OR c`로 묶여요.

그룹을 더 명시적으로 짜고 싶으면 `Expressions` 헬퍼를 쓰세요.

```typescript
import { Expressions as exp } from "@stingerloom/orm";

// (active이면서 admin) 이거나, 그냥 owner
qb.where(
  exp.or(
    exp.and(u.status.eq("active"), u.role.eq("admin")),
    u.role.eq("owner"),
  ),
);
```

`.and()`와 `.or()`는 조건이면 무엇이든 받습니다. 컬럼 비교든(`u.age.gte(18)`), 집계 비교든(`u.id.count().gt(10)`), JSON 경로 조건이든(`u.profile.tags.contains("admin")`) 섞어서 묶을 수 있어요.

```typescript
qb.where(
  exp.and(
    u.status.eq("active"),
    u.profile.tags.contains("admin"),   // JSON 경로 조건도 같이 들어감
  ),
);
```

편의 하나 더. 연속된 AND나 연속된 OR은 출력 SQL에서 괄호가 한 번만 쳐집니다. `a.and(b).and(c).and(d)`라고 써도 `(a AND b AND c AND d)`로 평평해져요.

## 문자열 매칭 — `.startsWith` / `.endsWith` / `.contains`

이건 LIKE 패턴을 대신 만들어주는 메서드입니다. 왜 필요한지부터 보는 게 빠릅니다. 이런 코드를 생각해 보세요.

```typescript
// 검색창 입력값을 그대로 LIKE에 넣는다면?
qb.where("name", "LIKE", `${userInput}%`);
```

여기서 `userInput`이 `"50%"`라면 쿼리는 `name LIKE '50%%'`가 됩니다. 그러면 `"50abc"`, `"50 off"`, `"500"`이 전부 걸려요. 사용자는 **진짜 "50%"라는 글자**를 찾고 싶었는데 말이죠.

`.startsWith()`, `.endsWith()`, `.contains()`는 이 함정을 막아줍니다.

```typescript
qb.where(u.name.startsWith("50%"));
// 내부적으로 "50\%" 이스케이프된 패턴을 만들어
// name LIKE '50\%%' ESCAPE '\' 로 나감
// → "50%로 시작하는" 이름만 매칭 (진짜 50%를 찾는 사용자 보호)
```

`%`, `_`, `\` 같은 LIKE 특수문자를 사용자가 입력해도 전부 리터럴로 처리됩니다.

일반적인 검색에도 물론 잘 쓰입니다.

```typescript
qb.where(u.name.startsWith("Al"));    // "Al"로 시작
qb.where(u.name.endsWith("son"));     // "son"으로 끝
qb.where(u.name.contains("lic"));     // 중간에 "lic" 포함
```

## 대소문자 무시 — `*IgnoreCase`

같은 세트에 `IgnoreCase` 버전이 있습니다. 문자열 매칭을 하되 대소문자를 구분하지 않아요.

```typescript
qb.where(u.username.equalsIgnoreCase("alice"));   // 정확히 일치, 대소문자만 무시
qb.where(u.email.containsIgnoreCase("@gmail"));   // 포함, 대소문자 무시
qb.where(u.email.startsWithIgnoreCase("admin@"));
qb.where(u.email.endsWithIgnoreCase(".com"));
qb.where(u.name.likeIgnoreCase("%Al%"));          // 와일드카드를 직접 쓰고 싶을 때
```

내부 동작은 드라이버마다 조금 다릅니다.

- **`.likeIgnoreCase` 계열 (패턴 매칭)** — PostgreSQL은 `ILIKE`를 가지고 있어 그대로 쓰고, MySQL과 SQLite는 `LOWER()`를 양쪽에 씌웁니다.
- **`.equalsIgnoreCase`** — 세 드라이버 모두 `LOWER(col) = LOWER(?)`로 내려갑니다 (ILIKE는 와일드카드 없는 동등 비교에는 어울리지 않아요). 컬럼 콜레이션이 대소문자를 구분하든 말든 결과가 일정하게 나오도록 맞춥니다.

코드는 드라이버와 상관없이 한 줄이에요. 로그인 폼의 이메일 조회를 떠올려 보세요.

```typescript
// 사용자가 "Alice@Example.com"이든 "alice@example.com"이든 같은 결과
const user = await em.createQueryBuilder(User, "u")
  .where(u.email.equalsIgnoreCase(inputEmail))
  .getOne();
```

## 한눈에 보기

| 하고 싶은 일 | 메서드 |
|---|---|
| 정렬 방향 지정 | `.asc()`, `.desc()` |
| null 위치 지정 | 위에 이어서 `.nullsFirst()` / `.nullsLast()` |
| 값 집계 | `.count()`, `.countDistinct()`, `.sum()`, `.avg()`, `.min()`, `.max()` |
| 집계 결과로 필터 | 집계 뒤에 `.gt(10)`, `.eq(0)`, `.between(1, 100)` 등 평소대로 |
| 조건부 집계 | `aggregate.filter(condition)`, `.countIf(condition)`, `.sumIf(condition)` — `FILTER (WHERE …)` (PG/SQLite) / `CASE` 변환 (MySQL) |
| SELECT 별칭 | `.as("name")` — 컬럼 / JSON 경로 / 집계 어디에든. `AliasedExpression` 반환 |
| null fallback | `coalesce(...)`, `col.coalesce(...)`, `nullif(a, b)` — 처음 non-null 값 / 일치 시 NULL |
| 현재 시각 | `currentDate()`, `currentTime()`, `currentTimestamp()` — `Expressions`에도 동일 |
| 타입 변환 | `.stringValue()`, `.intValue()`, `.longValue()`, `.floatValue()`, `.booleanValue()` |
| 날짜 컴포넌트 | `.year()`, `.month()`, `.day()`, `.hour()`, `.minute()`, `.second()`, `.dayOfWeek()`, `.dayOfYear()`, `.week()` |
| 서브쿼리 비교 | `.in(subQb)`, `.notIn(subQb)`, `.eq/.neq/.gt/.gte/.lt/.lte(subQb)`, `Expressions.exists`, `Expressions.notExists` |
| CASE 표현식 | `Expressions.caseBuilder().when(...).then(...).otherwise(...).end()`; `Expressions.cases(subject)...end()` |
| CASE 단축 | `Expressions.iff(cond, a, b)`; `Expressions.mapValues(subject, { k: v }, default?)`; `Expressions.buckets(subject, [[t, label], …], default?, { op? })` |
| 문자열 / 숫자 / 수학 | `.toLowerCase/.toUpperCase/.trim/.length/.substring/.concat/.indexOf/.replace`, `.add/.sub/.mul/.div/.mod/.neg`, `.abs/.floor/.ceil/.round/.sqrt` |
| 날짜 산술 | `.addYears/Months/Days/Hours/Minutes/Seconds(n)`, `Expressions.dateDiff(a, b, unit)`, `Expressions.random()` |
| 윈도우 함수 | `aggregate.over().partitionBy(...).orderBy(...).rowsBetween(start, end).as("alias")` — `rangeBetween`도 동일 |
| Raw SQL 이스케이프 | `` Expressions.raw<T>(sql`...`) `` → `ScalarExpression` (체인 합성 가능) |
| BigInt cast | `.bigintValue()` (BIGINT / SIGNED / INTEGER) |
| 스키마 기반 행 추론 | `qb.selectSchema(zodSchema)` — `TResult`를 `z.infer<schema>`로 좁히고 런타임 검증 |
| 조건 묶기 | `.and(other)`, `.or(other)`, `.not()` |
| 그룹을 직접 짤 때 | `Expressions.and(...)`, `Expressions.or(...)`, `Expressions.not(cond)` |
| 안전한 prefix/suffix/포함 | `.startsWith`, `.endsWith`, `.contains` (LIKE 특수문자 자동 이스케이프) |
| 대소문자 무시 매칭 | 위 이름 뒤에 `IgnoreCase`, 그리고 `.equalsIgnoreCase`, `.likeIgnoreCase` |

## Dialect 지원 매트릭스

표현식이 활성 dialect에서 대응되는 형태가 없으면 렌더러가 `OrmError(OrmErrorCode.UNSUPPORTED_OPERATION)`을 던져요. 메시지에는 기능 이름, 실패한 dialect, *왜* 미지원인지, 그리고 구체적인 *대안*(에뮬레이션 스케치나 escape hatch 안내)이 함께 들어가요. 던지기 전에 dialect 갭을 미리 파악하려면 아래 매트릭스를 참고하세요.

| 표현식 | PostgreSQL | MySQL | SQLite | 비고 |
|--------|------------|-------|--------|------|
| 집계 (`count`, `sum`, `avg`, `min`, `max`, `countDistinct`) | 네이티브 | 네이티브 | 네이티브 | — |
| 조건부 집계 (`.filter()`, `countIf`, `sumIf`) | 네이티브 `FILTER (WHERE …)` | `FUNC(CASE WHEN … THEN … END)`로 변환 | 네이티브 `FILTER (WHERE …)` (3.30+) | MySQL에서 `COUNT(*)`는 `COUNT(CASE WHEN … THEN 1 END)`. NULL 의미는 dialect 간 동일. |
| `coalesce` / `nullif` | 네이티브 | 네이티브 | 네이티브 | — |
| Window 함수 (`ROW_NUMBER`, `RANK`, `DENSE_RANK`, `LAG`, `LEAD`, aggregate `OVER()`) | 네이티브 | 네이티브 (8.0+) | 네이티브 (3.25+) | — |
| `percentile_cont` / `percentile_disc` / `mode` ordered-set aggregate | 네이티브 (`WITHIN GROUP`) | **미지원** — `UNSUPPORTED_OPERATION` throw | **미지원** — `UNSUPPORTED_OPERATION` throw | MySQL: CTE + `ROW_NUMBER() OVER (ORDER BY x)`로 에뮬, `rn = CEIL(N * p)` 행을 픽. [cookbook 레시피](./cookbook.md#cycle-time-percentile-report) 참고. |
| `dateTrunc` (year/quarter/month/week/day/hour/minute/second) | 네이티브 `DATE_TRUNC` | 단위별 등가 (`DATE`, `DATE_FORMAT`, ISO 월요일 `WEEKDAY` 계산) | `date(..., 'start of …')` / `strftime` | 세 dialect 모두 ISO 월요일 기준 주를 만들어요. |
| `dateDiff(a, b, unit)` — year / month | `age()` 기반 calendar-aware | `TIMESTAMPDIFF(YEAR/MONTH, ...)` calendar-aware | 근사: julianday / 365.25 (year), / 30.4375 (month) | SQLite는 10년 기준 약 ~0.07% 오차. |
| `dateDiff(a, b, unit)` — day / hour / minute / second | `EXTRACT(EPOCH ...)` 기반 epoch 초 | `TIMESTAMPDIFF(...)` | `julianday()` × factor | 세 dialect 모두 정확. |
| `dateAdd(value, n, unit)` | `value + INTERVAL 'N unit'` | `DATE_ADD(value, INTERVAL N unit)` | `datetime(value, '+N unit')` 수식자 | — |
| `random()` | `random()` `[0, 1)` 반환 | `RAND()` `[0, 1)` 반환 | `RANDOM()` 64-bit signed integer 반환 | SQLite 사용자는 `[0, 1)`이 필요하면 직접 normalize. |
| Full-text search (`Expressions.fullTextSearch`) | `to_tsvector / @@` (tsvector 파이프라인) | `MATCH() AGAINST(...)` (FULLTEXT 인덱스 필요) | **DSL 미지원** — `UNSUPPORTED_DATABASE` throw | SQLite는 FTS5 가상 테이블 + `em.query()`. |
| `jsonContains` — object/array 값 | 네이티브 `@>` containment | 네이티브 `JSON_CONTAINS` | **object/array 미지원** — `UNSUPPORTED_DATABASE` throw | SQLite는 path scalar equality 지원 — `metadata.profile.role.eq('admin')` 형태나 raw SQL 사용. |
| `jsonExtract` / `jsonHasKey` / `jsonArrayLength` / `jsonTypeOf` | 네이티브 (`->`, `?`, `jsonb_array_length`, `jsonb_typeof`) | 네이티브 (`JSON_EXTRACT`, `JSON_CONTAINS_PATH`, `JSON_LENGTH`, `JSON_TYPE`) | 네이티브 (`json_extract`, `json_array_length`, `json_type`) | — |
| `ilike` (case-insensitive LIKE) | 네이티브 `ILIKE` | `*_ci` collation에서는 기본 `LIKE`가 case-insensitive, `*_bin`은 `LOWER()` fallback | `LIKE`는 ASCII만 case-insensitive, non-ASCII 유니코드는 ICU 확장 필요 | — |
| 숫자 / 문자열 헬퍼 (`.abs`, `.floor`, `.ceil`, `.round`, `.length`, `.substring`, `.trim`, …) | 네이티브 | 네이티브 | 네이티브 | — |

`UNSUPPORTED_OPERATION`이 발생하면 에러의 `suggestion` 필드에 한 줄짜리 에뮬레이션/대안 힌트가 담겨 있어 UI에 그대로 표시하기 좋아요. 전체 메시지에는 관련 문서 섹션을 가리키는 `See: docs/...` 포인터도 포함돼요.

## 다음 단계

- [JSON 컬럼 탐색](./query-builder-json.md) — 같은 프록시를 `json` / `jsonb` 컬럼으로 확장한 모습
- [JOIN](./query-builder-joins.md) — 타입드 컬럼 참조로 여러 엔티티를 오가는 쿼리
- [집계 & 서브쿼리](./query-builder-aggregations.md) — GROUP BY / HAVING / 스칼라 · 파생 서브쿼리
- [Query Builder 개요](./query-builder.md) — 기본 사용법과 전체 지도
- [분석 쿼리 Cookbook](./cookbook.md) — 위 표현식들로 만든 실전 레시피 (window function, MySQL 에뮬레이션 percentile, recursive CTE)
