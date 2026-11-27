# 쿼리 빌더: QueryDSL 표현식

## 필요한 이유

쿼리 빌더에는 어색한 불균형이 하나 있습니다. 컬럼 이름은 자동완성되지만 연산자는 여전히 손으로 입력하는 문자열입니다.

```typescript
qb.where("age", ">=", 18);
```

`"age"`는 `keyof User`로 검사됩니다. 그래서 오타를 내면 컴파일 에러가 납니다. 하지만 `">="`는 검사되지 않습니다. `"LIKE"`를 `"LKIE"`로 잘못 입력해도 TypeScript는 평범한 문자열로 보고 아무 경고도 하지 않습니다. 쿼리를 실행하기 전까지는 버그를 알 수 없습니다.

불편한 점이 하나 더 있습니다. 같은 표현식을 여러 절에 되풀이해서 적어야 합니다.

```typescript
qb.addSelect(sql`COUNT(*)`, "total")
  .having(sql`COUNT(*) >= ${5}`)
  .addOrderBy(sql`COUNT(*)`, "DESC");
```

같은 `COUNT(*)`를 세 번 썼습니다. 기준을 `COUNT(DISTINCT user_id)`로 바꾸려면 세 곳을 모두 고쳐야 합니다. 한 곳이라도 빠뜨리면 경고 없이 틀린 결과가 나옵니다.

두 문제는 원인이 같습니다. SQL 표현식을 값이 아니라 문자열로 다루기 때문입니다. 값이라면 변수에 담아 재사용하고 타입 검사도 받을 수 있습니다. 문자열은 그저 문자열일 뿐입니다.

## 아이디어: 객체로 다루는 표현식

해결 방법은 단순합니다. SQL 표현식을 일급 객체로 만듭니다. 컬럼은 객체이고 비교는 그 객체의 메서드입니다. 비교한 결과도 또 다른 객체입니다.

JavaScript에서 이 구조를 가장 깔끔하게 구현하는 도구는 `Proxy`입니다. `qAlias()`가 반환하는 값이 바로 프록시입니다.

```typescript
import { qAlias } from "@stingerloom/orm";

const u = qAlias(User, "u");
qb.where(u.age.gte(18));
```

`u.age`를 읽어도 실제로 값을 조회하지는 않습니다. 프록시의 `get` 트랩이 접근을 가로챕니다. 그리고 "u 별칭의 age 컬럼"을 가리키는 표현식 객체를 그 자리에서 만듭니다. 여기에 `.gte(18)`을 붙이면 "u.age가 18 이상"이라는 조건 객체가 됩니다. 조건 객체는 쿼리 빌더 안에 쌓입니다. 그리고 쿼리를 실행할 때 한꺼번에 SQL로 변환됩니다.

```
u         .age              .gte(18)
│          │                 │
프록시     ColumnExpression  ColumnCondition
           ("u.age")         (u.age >= 18)
                             → SQL 컴파일 시점에
                             → "u"."age" >= $1
                             → 값 18은 파라미터 바인딩
```

네이밍 전략 변환도 이 단계에서 함께 처리합니다. 프록시가 컬럼 메타데이터를 참조하기 때문입니다. 그래서 `snake_case`를 쓰면 `u.firstName`은 `"u"."first_name"`이 됩니다.

JSON 컬럼도 같은 원리로 동작합니다. 다만 경로가 중첩되므로 기능이 조금 더 있습니다. 자세한 내용은 [JSON 컬럼 탐색](./query-builder-json.md)에 있습니다.

## 달라지는 점

달라지는 점은 연산자 문자열이 메서드로 바뀐 것만이 아닙니다. 표현식이 객체가 되었으므로 변수에 담을 수 있습니다. 앞에서 `COUNT(*)`를 세 번 적던 쿼리는 다음과 같이 바뀝니다.

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

`count`를 한 번 만들고 SELECT, HAVING, ORDER BY에 그대로 씁니다. 집계 기준이 바뀌면 `p.id.countDistinct()`로 한 줄만 고치면 됩니다. 표현식 재사용은 리포트 쿼리에서 특히 쓸모가 큽니다.

## `alias()`와 `qAlias()`의 관계

둘 다 타입이 있는 컬럼 참조를 만듭니다. 다만 지원하는 범위가 다릅니다.

```typescript
import { alias, qAlias } from "@stingerloom/orm";

const u1 = alias(User, "u");
u1.col("firstName");          // "u.firstName" (컬럼 이름만 자동완성)

const u2 = qAlias(User, "u");
u2.firstName.eq("Alice");      // 컬럼 이름 + 연산자 자동완성
u2.col("firstName");           // qAlias도 .col() 지원
```

한 쿼리 안에서 두 방식을 섞어 써도 됩니다. 타입이 있는 참조만 필요하면 `alias()`를 씁니다. 조건식까지 만들려면 `qAlias()`를 씁니다.

### 동적 컬럼 접근: `.field()` / `.jsonField()`

`qAlias()`의 정적 접근자에는 리터럴 속성 이름이 필요합니다. 컬럼 이름이 사용자 입력에서 오면 동적 접근자를 씁니다. UI에서 고른 정렬 키나 필터 필드가 그런 경우입니다.

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

- `field(name)`: 엔티티의 어느 컬럼이든 `ColumnExpression`으로 반환합니다. 서버 측 allowlist 검증을 마친 뒤에만 호출해야 합니다. 접근자는 이름을 검사하지 않습니다.
- `jsonField(name)`: `@Column({ type: "json" | "jsonb" })` 컬럼의 `JsonPathExpression`을 반환합니다. JSON으로 등록하지 않은 컬럼이면 일반 컬럼 프록시를 대신 반환합니다.

`field()`와 `jsonField()`는 속성 이름에 걸리는 TypeScript의 keyof 좁히기를 우회합니다. 그래서 안전성은 호출하는 쪽에서 지켜야 합니다.

---

`qAlias()`가 반환하는 컬럼 참조는 어느 기능에서나 같은 규칙을 따릅니다. 컬럼 참조는 별칭 레지스트리에서 해석되므로 네이밍 전략 변환이 항상 적용됩니다. 그리고 LIKE 이스케이프 문자를 포함한 사용자 값은 전부 파라미터로 바인딩합니다.

## 다른 컬럼·표현식과 비교하기

비교 메서드는 리터럴이 아닌 값도 받습니다. 오른쪽 피연산자가 또 다른 `ColumnExpression`이거나 그것에서 파생한 `ScalarExpression`이면 파라미터로 바인딩하지 않습니다. 대신 컬럼 참조로 SQL에 직접 씁니다. 한 행의 두 컬럼을 비교하는 조건은 다음과 같이 씁니다.

```typescript
const o = qAlias(Order, "o");

qb.where(o.price.gt(o.cost));
// WHERE "o"."price" > "o"."cost"

qb.where(o.startDate.lt(o.endDate));
// WHERE "o"."start_date" < "o"."end_date"

qb.where(o.price.between(o.floorPrice, o.ceilingPrice));
// WHERE "o"."price" BETWEEN "o"."floor_price" AND "o"."ceiling_price"
```

반대 방향도 같습니다. 파생 스칼라를 컬럼과 비교할 수도 있습니다. 그래서 산술 연산과 컬럼 참조를 자유롭게 섞어 쓸 수 있습니다.

```typescript
qb.where(o.price.mul(2).gt(o.cost));
// WHERE ("o"."price" * $1) > "o"."cost"   -- $1 = 2

qb.where(o.price.coalesce(0).gte(o.minimum));
// WHERE COALESCE("o"."price", $1) >= "o"."minimum"
```

`IN` 목록에는 컬럼과 리터럴을 섞어도 됩니다. 이때 바인딩하는 값은 리터럴뿐입니다.

```typescript
qb.where(o.status.in([o.previousStatus, "draft"]));
// WHERE "o"."status" IN ("o"."previous_status", $1)   -- $1 = "draft"
```

평범한 JavaScript 값은 그대로 파라미터로 바인딩합니다. `o.price.gt(50)`은 여전히 `> $1`을 생성합니다. SQL에 직접 쓰는 값은 컬럼, 스칼라, 집계 같은 표현식 피연산자뿐입니다. 표현식 피연산자는 별칭 레지스트리에서 해석됩니다. 그래서 네이밍 전략 변환이 그대로 적용되고 인젝션 위험도 없습니다.

## 정렬: `.asc()` / `.desc()` / `.nullsFirst()` / `.nullsLast()`

정렬 방향을 메서드로 씁니다.

```typescript
const u = qAlias(User, "u");

await em.createQueryBuilder(User, "u")
  .orderBy(u.createdAt.desc().nullsLast())   // 최신 먼저, null은 뒤로
  .addOrderBy(u.name.asc())                  // 같은 시각이면 이름순
  .getMany();
```

`orderBy()`는 정렬 기준을 새로 설정합니다. `addOrderBy()`는 기존 정렬 기준 뒤에 하나를 더 붙입니다. 기존의 `orderBy({ name: "ASC" })` 형식도 그대로 동작합니다.

`.nullsLast()`와 `.nullsFirst()`는 null 값의 정렬 위치를 지정합니다. 드라이버마다 처리 방식이 조금 다릅니다.

- PostgreSQL과 SQLite는 `ORDER BY col DESC NULLS LAST` 구문을 그대로 지원합니다.
- MySQL에는 해당 키워드가 없습니다. 대신 0 또는 1이 되는 `col IS NULL` 값으로 먼저 정렬하면 같은 효과가 납니다. 이 변환은 Stingerloom이 자동으로 처리합니다.

그래서 어느 드라이버에서든 코드는 `u.createdAt.desc().nullsLast()` 그대로입니다.

## 집계: `.count()` / `.sum()` / `.avg()` / `.min()` / `.max()`

컬럼 뒤에 집계 함수를 바로 붙입니다.

```typescript
const u = qAlias(User, "u");
const total = u.id.count();   // COUNT(u.id)를 나타내는 표현식 (아직 SQL이 아님)

await em.createQueryBuilder(User, "u")
  .select(["departmentId"])
  .addSelect(total.as("total"))           // SELECT에 넣을 때는 .as()로 이름을 지정
  .groupBy(["u.departmentId"])
  .having(total.gt(10))                   // HAVING에도 같은 표현식을 재사용
  .getRawMany();
```

`const total = u.id.count()`로 만든 표현식 하나를 SELECT에 넣고 HAVING 조건에도 그대로 씁니다. 그래서 같은 COUNT를 두 번 적지 않습니다. 집계 표현식에도 조건과 똑같이 `.eq`, `.gt`, `.lt`, `.between` 같은 비교 메서드가 있습니다. 오른쪽 피연산자로는 또 다른 집계나 그룹 컬럼도 넘길 수 있습니다. 예를 들어 `o.revenue.sum().gt(o.cost.sum())`은 바인딩 없이 `HAVING SUM("o"."revenue") > SUM("o"."cost")`를 생성합니다.

SELECT에 넣을 때는 `.as("total")`로 이름을 붙이기를 권장합니다. 생략하면 `agg_count_id` 같은 이름이 자동으로 붙습니다. 그러면 `getRawMany()` 결과의 키 이름이 헷갈리기 쉽습니다.

중복을 빼고 세려면 `.countDistinct()`를 씁니다. 그러면 `COUNT(DISTINCT u.role)`을 생성합니다.

## 조건부 집계: `.filter(...)` / `countIf` / `sumIf`

`.filter(condition)`은 조건에 맞는 행만 집계합니다. 그래서 범위가 다른 여러 집계를 `GROUP BY` 한 번으로 묶을 수 있습니다. 상태별로 쿼리를 따로 실행하지 않아도 됩니다.

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

`countIf(cond)`는 `.count().filter(cond)`의 단축형입니다. `sumIf(cond)`는 `.sum().filter(cond)`의 단축형입니다. 조건에는 어떤 `ConditionLike`든 쓸 수 있습니다. 컬럼 비교, `.and()`와 `.or()` 합성, JSON 경로 조건이 모두 해당합니다. 그래서 WHERE에서 쓰던 DSL을 그대로 재사용합니다.

`FILTER` 절은 다이얼렉트에 맞게 자동으로 변환됩니다.

- **PostgreSQL / SQLite**: 표준 SQL인 `COUNT("u"."id") FILTER (WHERE "u"."status" = $1)`을 그대로 생성합니다.
- **MySQL**: `FILTER` 절이 없습니다. 그래서 같은 뜻의 조건부 집계 `COUNT(CASE WHEN \`u\`.\`status\` = ? THEN \`u\`.\`id\` END)`로 변환합니다. `COUNT(*)`는 `CASE` 안에서 리터럴 `1`로 바꿉니다. `*`는 `CASE`의 결과로 쓸 수 없기 때문입니다.

어느 형태든 NULL을 다루는 방식은 같습니다. 일치하는 행이 없으면 `COUNT`는 `0`을 반환합니다. `SUM`, `AVG`, `MIN`, `MAX`는 `NULL`을 반환합니다. 필터를 건 집계는 `having()`에서도 동작합니다(`u.id.countIf(...).gt(10)`).

## SELECT 별칭: `.as("name")`

`.as("name")`은 일반 컬럼, JSON 경로, 집계 어디에든 붙일 수 있습니다. 결과는 `AliasedExpression`입니다. 이 값은 SELECT에서만 씁니다. `where()`나 `having()`에 넘기면 타입 검사에서 막힙니다.

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

JSON 경로 별칭은 다이얼렉트의 텍스트 추출 연산자로 컴파일됩니다. PostgreSQL은 `#>>`, MySQL은 `JSON_UNQUOTE(JSON_EXTRACT(...))`, SQLite는 `json_extract()`를 씁니다. 경로 문자열은 바인딩 파라미터로 넘깁니다. 그래서 직렬화 과정에서도 경로가 안전하게 보존됩니다.

`addSelect(u.age.as("years"))`로 기존 SELECT 목록 뒤에 덧붙여도 됩니다. 한 번의 `select([...])`에 별칭 컬럼과 집계를 섞어 넣어도 됩니다.

## `CASE WHEN …`: 조건 분기 표현식

::: tip `Expressions`는 이름이 긴 편
이 절부터 여러 곳에서 쓰는 `Expressions` 네임스페이스는 import할 때 별칭을 붙여 씁니다.

```typescript
import { Expressions as exp } from "@stingerloom/orm";
```

공개 API에는 `exp`라는 이름이 따로 없습니다. 그래서 별칭으로 쓰기에 알맞습니다. 문서에 `Expressions.xxx`로 적은 것은 모두 `exp.xxx`로 호출해도 됩니다.
:::

SQL의 CASE에는 두 종류가 있습니다. Stingerloom은 종류마다 전용 빌더를 제공합니다.

**Searched CASE**: `caseBuilder()`로 만듭니다. 조건을 차례로 이어 쓰는 방식입니다. 각 분기는 조건과 결과값의 쌍입니다. 마지막에 `otherwise(...)`로 기본값을 붙이고 `.end()`로 마무리합니다.

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

**Simple CASE**: `cases(subject)`로 만듭니다. 값을 하나씩 맞춰 보는 switch 문 방식입니다.

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

`.end()`는 `ScalarExpression`을 반환합니다. 그래서 캐스팅, 별칭, 비교, coalesce 같은 연산을 모두 그대로 이어 붙일 수 있습니다.

빌더를 잘못 쓰면 바로 에러를 던집니다. 다음 경우가 해당합니다.

- `.otherwise()` 뒤에 `.when()`을 더 붙인 경우
- `.otherwise()`를 두 번 호출한 경우
- WHEN 없이 `.end()`를 호출한 경우

잘못된 SQL이 실행 단계까지 가지 않게 막으려는 것입니다.

### 실전: CASE를 변수처럼 재사용

CASE 표현식도 한 번 만들어 두면 여러 곳에 쓸 수 있습니다. 여기에 `coalesce`로 NULL 대체값까지 붙이면 DB 서버에서 계산하는 파생 필드가 됩니다.

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

같은 CASE를 두 번 적지 않아도 됩니다. 등급 기준이 바뀌어도 한 곳만 고치면 됩니다.

### 자주 쓰는 CASE 모양용 단축 헬퍼

자주 나오는 CASE 모양 세 가지는 전용 단축 함수로 줄여 쓸 수 있습니다. 출력 SQL은 빌더와 같습니다. 분기 모양이 제각각이면 기존 빌더가 낫습니다. 단축 함수는 아래 표의 모양과 정확히 맞을 때만 쓰세요.

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

객체 키는 `WHEN` 값으로 바인딩됩니다. 키는 문자열로 강제 변환됩니다. 그래서 enum, status, role 같은 문자열 컬럼에 가장 잘 맞습니다. `default`를 생략하면 `ELSE`를 생성하지 않습니다. `ELSE NULL`을 명시하려면 `null`을 넘깁니다.

```typescript
qb.select([
  exp.mapValues(u.status, { active: 1, pending: 0 }, -1).as("w"),
]);
// SELECT CASE "u"."status" WHEN ? THEN ?
//                           WHEN ? THEN ?
//                           ELSE ? END AS "w"
```

#### `Expressions.buckets(subject, thresholds, default?, { op })`

각 `[threshold, result]` 튜플은 `WHEN subject <op> threshold THEN result` 분기 하나가 됩니다. 분기 순서는 입력 순서를 그대로 따릅니다. 기본 연산자는 내림차순 임계값에 쓰는 `">="`입니다. 오름차순 코호트에는 `"<"`나 `"<="`를 씁니다. 엄격한 내림차순에는 `">"`를 씁니다.

```typescript
// 내림차순 >= 사다리 (기본)
exp.buckets(u.score, [
  [90, "gold"],
  [70, "silver"],
], "bronze");

// 오름차순 < 사다리 (age → cohort)
exp.buckets(u.age, [
  [18, "child"],
  [65, "adult"],
], "senior", { op: "<" });
```

`iff`, `mapValues`, `buckets`는 모두 `ScalarExpression`을 반환합니다. 그래서 Tier 2/3의 모든 연산에 그대로 이어집니다. `.as()`, 캐스팅, 비교, `coalesce(...)`, `Expressions.and(...)`, `.or(...)`가 그 예입니다. mapping이나 thresholds가 비어 있으면 즉시 에러를 던집니다.

## null 처리: `coalesce()` / `nullif()`

`coalesce(a, b, c, …)`는 인자를 왼쪽부터 보고 처음 나오는 null이 아닌 값을 반환합니다. `nullif(a, b)`는 `a`가 `b`와 같으면 NULL을 반환하고 다르면 `a`를 반환합니다. 빈 문자열이나 `-1` 같은 센티넬 값을 진짜 NULL로 바꿀 때 씁니다. `coalesce`와 `nullif`는 표준 SQL이므로 어느 드라이버에서나 같은 SQL을 생성합니다.

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

인자에는 컬럼, JSON 경로 추출, 집계, 중첩된 `coalesce`, 평범한 값을 섞어 써도 됩니다. 평범한 값은 자동으로 바인딩되므로 안전합니다. 결과는 `ScalarExpression`입니다. 그래서 `.eq()`, `.gt()`, `.as()`를 바로 이어 쓸 수 있습니다.

정적 헬퍼인 `Expressions.coalesce`와 `Expressions.nullif`도 있습니다. 코드 스타일에 맞는 쪽을 고르면 됩니다.

## 행 단위 최대 / 최소: `greatest()` / `least()`

`greatest(a, b, …)`는 한 행 안에서 인자 중 가장 큰 값을 반환합니다. 여러 행을 집계하는 `MAX()`와는 다른 함수입니다. `least(...)`는 반대로 가장 작은 값을 반환합니다. 받는 인자는 `coalesce()`와 같습니다. 컬럼 참조, 스칼라 표현식, 집계, JSON 경로, 평범한 값을 받습니다.

```typescript
import { greatest, least, qAlias } from "@stingerloom/orm";

const o = qAlias(Order, "o");

qb.select([least(o.listPrice, o.promoPrice).as("charged")]);
// SELECT LEAST("o"."listPrice", "o"."promoPrice") AS "charged"

qb.where(greatest(o.listPrice, o.promoPrice).gt(500));
// WHERE GREATEST("o"."listPrice", "o"."promoPrice") > $1
```

SQLite에서는 같은 함수를 `MAX(a, b)`와 `MIN(a, b)`로 씁니다. SQLite는 인자가 둘 이상인 `MAX`와 `MIN`을 집계가 아니라 스칼라 함수로 해석합니다. 그래서 드라이버마다 다른 SQL을 생성합니다.

| 드라이버 | `greatest` | `least` | NULL 인자 |
|---------|-----------|---------|----------|
| PostgreSQL | `GREATEST(…)` | `LEAST(…)` | 무시 |
| MySQL / MariaDB | `GREATEST(…)` | `LEAST(…)` | 결과가 `NULL` |
| SQLite | `MAX(…)` | `MIN(…)` | 결과가 `NULL` |

::: warning NULL 처리는 이식되지 않습니다
PostgreSQL은 NULL 인자를 건너뛰고 NULL이 아닌 값 중 최댓값을 반환합니다. 반면 MySQL과 SQLite는 인자 중 하나라도 NULL이면 `NULL`을 반환합니다. ORM은 이 차이를 보정하지 않습니다. nullable 인자를 `coalesce()`로 감싸 두면 의도가 드러나고 어느 드라이버에서나 같게 동작합니다.

```typescript
greatest(coalesce(o.promoPrice, 0), o.floorPrice)
```
:::

`coalesce()`처럼 진입점이 세 가지 있습니다. 자유 함수, 컬럼에 이어 붙이는 체인, 정적 네임스페이스입니다.

```typescript
greatest(o.listPrice, o.promoPrice)      // 자유 함수
o.listPrice.greatest(o.promoPrice)       // 컬럼에서 체인
Expressions.greatest(o.listPrice, o.promoPrice)
```

자유 함수와 `Expressions.greatest`에는 인자가 두 개 이상 필요합니다. 체인 형태에서는 수신 객체가 첫 인자입니다. 그래서 나머지 인자가 하나 이상 필요합니다. 인자가 모자라면 드라이버마다 뜻이 달라지는 SQL을 만드는 대신 에러를 던집니다.

## upsert가 제안한 행: `qExcluded()`

`INSERT … ON CONFLICT` 안에는 행이 두 개 있습니다. 이미 저장된 행과 SQL 문이 제안한 행입니다. `qExcluded(Entity)`는 제안한 행을 가리키는 타입 있는 참조입니다. 평범한 `qAlias` 프록시이므로 이 문서의 모든 표현식과 그대로 조합할 수 있습니다.

```typescript
import { greatest, qAlias, qExcluded } from "@stingerloom/orm";

const m  = qAlias(SyncMarker, "m");
const ex = qExcluded(SyncMarker);

await em.createInsertBuilder(SyncMarker)
  .values(rows)
  .onConflict(["mac", "bucketStart"])
  .doUpdate({
    records:  m.records.add(ex.records),
    lastTime: greatest(m.lastTime, ex.lastTime),
  })
  .execute();
```

`doUpdate()`의 콜백 형태는 저장된 행과 제안한 행의 참조를 모두 넘깁니다. 그래서 `qExcluded()`를 직접 호출할 일은 표현식을 콜백 바깥에서 만들 때뿐입니다.

```typescript
.doUpdate((t, ex) => ({ records: t.records.add(ex.records) }))
```

이 참조는 다이얼렉트마다 다르게 렌더링됩니다.

- PostgreSQL: `EXCLUDED."col"`
- SQLite: `excluded."col"`
- MySQL 8.0.19 이상: `` `new`.`__col` ``. [행 별칭](./entity-manager-writes.md#mysql-8-0-19-행-별칭으로-읽는-제안-행)을 씁니다.
- MariaDB와 그 이전 MySQL: `` VALUES(`col`) ``

이 참조는 `createInsertBuilder()` 안에서만 씁니다. 빌더 전체는 [표현식 기반 Upsert](./entity-manager-writes.md#표현식-기반-upsert-createinsertbuilder)에 있습니다.

`qExcluded()`는 `doUpdateWhere()` 조건 안에서도 씁니다. 가드를 건 upsert는 이 방법으로 저장된 행과 제안한 행을 비교합니다.

```typescript
// 제안한 배치가 실제로 더 최신인 행만 전진시킵니다.
.doUpdateWhere(m.lastTime.lt(ex.lastTime))
// WHERE "sync_markers"."last_time" < EXCLUDED."last_time"
```

## 현재 시각: `currentDate()` / `currentTime()` / `currentTimestamp()`

`currentDate()`, `currentTime()`, `currentTimestamp()`는 DB 서버의 시계를 쿼리 어디에든 넣는 표준 SQL 헬퍼입니다. 결과는 `ScalarExpression`입니다. 그래서 `.as()`, `.eq()`, `coalesce` 중첩 같은 합성을 모두 그대로 쓸 수 있습니다. 세 드라이버 모두 같은 리터럴을 생성합니다. 리터럴은 `CURRENT_DATE`, `CURRENT_TIME`, `CURRENT_TIMESTAMP`입니다.

```typescript
import { Expressions as exp, qAlias } from "@stingerloom/orm";

const s = qAlias(Session, "s");

qb.where(s.expiresAt.gte(exp.currentTimestamp()));
// WHERE "s"."expires_at" >= CURRENT_TIMESTAMP

qb.select([exp.currentDate().as("today")]);
// SELECT CURRENT_DATE AS "today"
```

비교 메서드에 스칼라 표현식을 넘기면 바인딩하지 않고 SQL에 직접 씁니다. 그래서 `u.createdAt.lte(currentTimestamp())`는 `CURRENT_TIMESTAMP`를 쿼리에 그대로 씁니다. 컬럼 피연산자도 같은 규칙을 따릅니다([다른 컬럼·표현식과 비교하기](#다른-컬럼·표현식과-비교하기) 참고).

## 타입 변환: `.stringValue()` / `.intValue()` / `.longValue()` / `.floatValue()` / `.booleanValue()`

컬럼이나 스칼라 표현식을 다른 SQL 타입으로 CAST합니다. 드라이버마다 받는 타입 이름이 다릅니다. 예를 들어 MySQL은 `INTEGER` 대신 `SIGNED`를 쓰고 SQLite는 `BOOLEAN` 대신 `INTEGER`를 씁니다. 타입 이름은 내부에서 변환하므로 메서드 이름만 기억하면 됩니다.

```typescript
const i = qAlias(Item, "i");

qb.select([i.quantity.stringValue().as("qty_str")]);
// PG/SQLite:  CAST("i"."quantity" AS TEXT) AS "qty_str"
// MySQL:      CAST(`i`.`quantity` AS CHAR)  AS `qty_str`

qb.where(i.sku.intValue().gt(1000));
// PG/SQLite:  CAST("i"."sku" AS INTEGER) > ?
// MySQL:      CAST(`i`.`sku` AS SIGNED)  > ?
```

CAST 헬퍼는 `ColumnExpression`과 `ScalarExpression`에 모두 있습니다. 그래서 `coalesce(u.price, 0).floatValue()`처럼 이미 파생한 스칼라에도 이어 붙일 수 있습니다. 결과도 `ScalarExpression`이므로 `.as()`, `.eq()`, 중첩된 `coalesce`에 그대로 씁니다.

| 종류     | MySQL      | PostgreSQL | SQLite    | 메서드                    |
|----------|------------|------------|-----------|---------------------------|
| string   | `CHAR`     | `TEXT`     | `TEXT`    | `.stringValue()`          |
| int      | `SIGNED`   | `INTEGER`  | `INTEGER` | `.intValue()`             |
| long     | `SIGNED`   | `BIGINT`   | `INTEGER` | `.longValue()`            |
| bigint   | `SIGNED`   | `BIGINT`   | `INTEGER` | `.bigintValue()` (별칭)   |
| float    | `DECIMAL`  | `REAL`     | `REAL`    | `.floatValue()`           |
| boolean  | `UNSIGNED` | `BOOLEAN`  | `INTEGER` | `.booleanValue()`         |

`.bigintValue()`는 `.longValue()`와 완전히 같은 SQL을 생성합니다. 이름만 다릅니다. JS의 `bigint`를 기대한다는 의도를 코드를 읽는 사람에게 드러내고 싶을 때 씁니다. 드라이버가 결과를 문자열로 반환할 때가 있습니다. 그래서 JS 쪽에서 `BigInt(row.col)`로 감싸면 안전합니다.

## 날짜 · 시각 컴포넌트: `.year()` / `.month()` / `.day()` / `.hour()` / …

날짜나 타임스탬프 컬럼에서 연, 월, 일, 시 같은 성분만 뽑아냅니다. 메서드는 `year`, `month`, `day`(= `dayOfMonth`), `hour`, `minute`, `second`, `dayOfWeek`, `dayOfMonth`, `dayOfYear`, `week`의 열 개입니다. 결과는 `ScalarExpression`입니다. 그래서 SELECT, WHERE, HAVING 어디에든 쓰고 `.as()`, 캐스팅, coalesce로 이어 붙입니다.

```typescript
const e = qAlias(Event, "e");

qb.select([e.startsAt.year().as("yr"), e.id.count().as("total")])
  .groupBy(["e.startsAt"])
  .having(e.startsAt.year().gte(2026));
// PG:     CAST(EXTRACT(YEAR FROM "e"."starts_at") AS INTEGER) = ?
// MySQL:  YEAR(`e`.`starts_at`) = ?
// SQLite: CAST(strftime(?, "e"."starts_at") AS INTEGER) = ?   -- '%Y'
```

드라이버별로 생성하는 SQL은 다음과 같습니다. PostgreSQL과 SQLite에서는 결과를 `CAST(... AS INTEGER)`로 감쌉니다. 뒤에 오는 비교 연산을 정수 산술로 유지하려는 것입니다.

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

`dayOfWeek`와 `week`는 드라이버마다 값의 인코딩이 조금 다르므로 주의해야 합니다. MySQL의 `DAYOFWEEK`는 일요일이 1이고 토요일이 7입니다. PostgreSQL의 `DOW`는 일요일이 0이고 토요일이 6입니다. SQLite의 `%w`는 PostgreSQL과 같습니다. 리포트의 이식성이 중요하면 애플리케이션 계층에서 값을 한 번 정규화하거나 드라이버별 raw SQL을 쓰는 편이 안전합니다.

## 서브쿼리 비교: `.in(subquery)` / `.eq(subquery)` / `exists` / `notExists`

`ColumnExpression.in()`과 `.notIn()`은 값 배열뿐 아니라 `SelectQueryBuilder`도 받습니다. 서브쿼리를 넘기면 `col IN (SELECT …)` 형태를 생성합니다. 서브쿼리 안의 파라미터 바인딩도 그대로 보존됩니다. `.eq`, `.neq`, `.gt`, `.gte`, `.lt`, `.lte`도 값 하나를 반환하는 서브쿼리를 받습니다. 그리고 `col <op> (SELECT …)`를 만듭니다.

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

// 스칼라 서브쿼리: 집계 결과와 비교
const avgViews = em
  .createQueryBuilder(Post, "p2")
  .selectRaw(["AVG(p2.views)"]);

qb.where(p.views.gt(avgViews));
// WHERE "p"."views" > (SELECT AVG(p2.views) FROM …)
```

`Expressions.exists(subQb)`와 `Expressions.notExists(subQb)`는 상관 서브쿼리 조건을 만듭니다.

```typescript
qb.where(exp.exists(em.createQueryBuilder(Post, "p")
  .select(["id"])
  .where(sql`"p"."author_id" = "u"."id"`)));
// WHERE EXISTS (SELECT "id" FROM "post" AS "p"
//               WHERE "p"."author_id" = "u"."id")
```

`ExistsCondition.not()`은 전체를 `NOT (…)`으로 감싸지 않습니다. 대신 내부의 `EXISTS`와 `NOT EXISTS` 플래그만 뒤집습니다. 그래서 생성되는 SQL이 깔끔합니다.

## Row-value 튜플: `Expressions.tuple(...).in(...)` / `.notIn(...)` / `.eq(...)`

`Expressions.tuple(c1, c2, …)`는 SQL row value `(c1, c2, …)`를 만듭니다. 이 값으로 여러 컬럼을 한 번에 비교합니다. 복합 기본 키 조회에 잘 맞습니다. `(a = ? AND b = ?) OR (a = ? AND b = ?)`로 풀어 쓰지 않고 `(a, b) IN ((?, ?), (?, ?))` 하나로 씁니다.

```typescript
const m = qAlias(Membership, "m");

qb.where(
  Expressions.tuple(m.tenantId, m.userId).in([
    [1, "alice"],
    [1, "bob"],
    [2, "carol"],
  ]),
);
// WHERE ("m"."tenantId", "m"."userId") IN ((?, ?), (?, ?), (?, ?))

qb.where(Expressions.tuple(m.tenantId, m.userId).eq([1, "alice"]));
// WHERE ("m"."tenantId", "m"."userId") = (?, ?)
```

`.notIn(rows)`은 `.in(rows)`의 부정입니다. 값 행마다 원소 개수가 컬럼 개수와 같아야 합니다. 개수가 어긋나면 `OrmError(INVALID_QUERY)`를 던집니다. 빈 `.in([])`은 아무 행도 매칭하지 않는 `1 = 0`으로 축약됩니다. 빈 `.notIn([])`은 아무 행도 제외하지 않는 `1 = 1`로 축약됩니다. 스칼라 `IN` 가드와 같은 동작입니다.

PostgreSQL, MySQL, SQLite 3.15 이상은 모두 row value 비교를 자체적으로 지원합니다. 그래서 식별자 따옴표만 빼면 어느 다이얼렉트에서나 SQL이 같습니다. 컬럼에는 `qAlias()` 표현식이나 `"alias.prop"` 문자열을 씁니다. 결과인 `TupleCondition`은 `Expressions.and`, `.or`, `.not`으로 합성할 수 있습니다.

## 문자열 / 숫자 / 수학: JS와 같은 이름

문자열, 숫자, 수학 헬퍼는 JavaScript 개발자에게 이미 익숙한 이름을 그대로 씁니다. `String.prototype`의 메서드, 산술 연산자, `Math.*`의 이름입니다. 결과는 모두 `ScalarExpression`입니다. 그래서 `.as()`, 캐스팅, coalesce, 비교, 논리 결합에 바로 이어집니다.

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

메서드 목록은 다음과 같습니다.

| 분류   | 메서드 |
|--------|--------|
| 문자열 | `.toLowerCase()`, `.toUpperCase()`, `.trim()`, `.length()`, `.substring(start, end?)`, `.concat(...args)`, `.indexOf(needle)`, `.replace(from, to)` |
| 산술   | `.add(x)`, `.sub(x)`, `.mul(x)`, `.div(x)`, `.mod(x)`, `.neg()` |
| 수학   | `.abs()`, `.floor()`, `.ceil()`, `.round(digits?)`, `.sqrt()` |

알아 두면 좋은 동작이 몇 가지 있습니다.

- **`substring`**: JS처럼 0부터 셉니다. 끝 인덱스는 결과에 포함하지 않습니다. 내부에서 `SUBSTR(col, start + 1, end - start)`로 변환합니다.
- **`length`**: `CHAR_LENGTH`를 쓰므로 멀티바이트 문자에도 안전합니다. 바이트 수가 아니라 문자 수를 셉니다.
- **`indexOf`**: 찾으면 0부터 센 위치를 반환하고 못 찾으면 `-1`을 반환합니다. 드라이버별 함수인 `STRPOS`, `LOCATE`, `INSTR`는 1부터 셉니다. 그래서 그 결과에서 1을 빼 JS와 맞춥니다.
- **`mod`**: SQL의 `%` 연산자를 씁니다. 피연산자가 양수이면 결과가 JS와 같습니다. 하지만 음수이면 엔진마다 부호 규칙이 다릅니다. PostgreSQL은 피제수의 부호를 따르고 MySQL과 SQLite는 JS와 같습니다.

인자에는 평범한 값과 다른 컬럼이나 스칼라 표현식을 모두 넘길 수 있습니다. 평범한 값은 파라미터로 바인딩됩니다. `p.price.add(p.discount)`처럼 컬럼끼리 계산해도 되고 `p.name.concat(" (", p.sku, ")")`처럼 값과 컬럼을 섞어도 됩니다.

## 날짜 산술: `.addDays()` / `.addMonths()` / …, `dateDiff`, `random`

날짜 산술 헬퍼를 쓰면 리포트 쿼리에서 raw SQL을 쓸 일이 줄어듭니다. 헬퍼는 다음과 같습니다.

- 달력 단위별 `add*` 여섯 개: `addYears/Months/Days/Hours/Minutes/Seconds`
- 두 날짜의 정수 차이를 반환하는 `Expressions.dateDiff(a, b, unit)`
- 엔진별 난수 생성기(RNG)를 감싸는 `Expressions.random()`

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

SQLite에서 연 단위와 월 단위 차이는 각각 365.25와 30.4375로 나눠 근사합니다. 정확한 달력 차이가 필요하면 MySQL의 `TIMESTAMPDIFF`나 PostgreSQL의 `age()`를 쓰세요.

## 윈도 함수: `aggregate.over()` + `WindowBuilder`

집계(`count`, `sum`, `avg`, `min`, `max`, `countDistinct`)에는 `.over()`가 있습니다. 체인으로 PARTITION BY, ORDER BY, 프레임(`rowsBetween` 또는 `rangeBetween`)을 지정합니다. 그리고 `.as(alias)`로 마무리합니다.

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

`partitionBy(...)`와 `orderBy(...)`는 가변 인자를 받습니다. 그래서 복합 파티션 키나 여러 정렬 기준을 한 번에 넘길 수 있습니다. 예를 들어 `partitionBy(e.teamId, e.region)`처럼 씁니다.

체인은 다음 메서드 중 하나로 마무리합니다.

- `.as("alias")`: `AliasedExpression`을 반환합니다. SELECT에 바로 씁니다.
- `.toScalar()`: `ScalarExpression`을 반환합니다. 다른 표현식 안에 중첩할 때 씁니다. 아래 실전 예제의 두 번째 쿼리가 이 방식입니다.

`"UNBOUNDED PRECEDING"`, `"CURRENT ROW"`, `"5 PRECEDING"` 같은 프레임 문자열은 SQL에 그대로 들어갑니다. 그러므로 사용자 입력을 이 자리에 넘기지 마세요. 누적 집계에는 `rowsBetween("UNBOUNDED PRECEDING", "CURRENT ROW")`를 가장 흔히 씁니다. 시간 범위로 집계하려면 `rangeBetween(...)`을 씁니다.

### 실전: 팀별 리더보드

팀 단위 시계열 이벤트에서 자주 필요한 리포트가 두 가지 있습니다. 하나는 누적 점수입니다. 다른 하나는 같은 팀 평균보다 점수가 높은 이벤트입니다. 두 번째 리포트는 `.toScalar()`로 윈도 결과를 서브쿼리처럼 `WHERE`에 넣는 패턴입니다.

```typescript
const e = qAlias(Event, "e");

// (1) 팀별 누적 점수 (SELECT에 사용)
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

// (2) 팀 평균보다 높은 이벤트만 조회 (윈도를 WHERE에 중첩)
const teamAvg = e.score.avg().over().partitionBy(e.teamId).toScalar();
const aboveAvg = await em.createQueryBuilder(Event, "e")
  .where(e.score.gt(teamAvg))
  .getMany();
// WHERE "e"."score" > AVG("e"."score") OVER (PARTITION BY "e"."teamId")
```

## TypeScript 친화 탈출구: `Expressions.raw<T>()` / `.bigintValue()` / `qb.selectSchema(...)`

타입 있는 빌더가 아직 지원하지 않는 기능에는 다음 세 가지 장치를 씁니다.

**`Expressions.raw<T>(fragment)`**: 어떤 `sql-template-tag` 조각이든 `ScalarExpression`으로 감쌉니다. 그래서 `.as`, `.eq`, `coalesce` 같은 합성에 그대로 이어집니다. 제네릭 `T`는 뒤에 이어지는 체인의 타입 힌트일 뿐입니다. 런타임에 검증하지는 않습니다.

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

템플릿 안의 파라미터 바인딩은 끝까지 보존됩니다. 드라이버 고유 함수나 전문 검색 연산자처럼 타입 있는 빌더가 지원하지 않는 기능에 탈출구로 씁니다.

**`.bigintValue()`**: `.longValue()`와 이름만 다른 메서드입니다. JS의 `bigint`를 다룬다는 의도를 코드를 읽는 사람에게 드러낼 때 씁니다. 생성하는 SQL 타입은 드라이버에 따라 `BIGINT`, `SIGNED`, `INTEGER`입니다. 드라이버가 결과를 문자열로 반환할 때가 있습니다. 그래서 JS 쪽에서 `BigInt(row.col)`로 감싸면 됩니다.

**`qb.selectSchema(schema)`**: Zod, Valibot, Effect처럼 `.parse(data)`를 가진 스키마를 행 검증기로 붙입니다. 동시에 `TResult` 타입을 `z.infer<schema>`로 좁힙니다.

```typescript
import { z } from "zod";

const UserRow = z.object({ id: z.number(), name: z.string() });

const rows = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name"])
  .selectSchema(UserRow)
  .getMany();
//    ^? Array<{ id: number; name: string }>  (UserRow에서 추론)
```

SELECT 목록은 호출하는 쪽에서 `.select([...])`나 `.as("alias")`로 원하는 대로 지정합니다. `selectSchema`는 여기에 런타임 검증과 타입 추론만 더합니다. 두 단계로 나눠 쓰려면 `.select(...).validate(schema)`를 씁니다. 검증 효과는 같습니다. 하지만 이때는 결과 타입을 좁히지 않습니다.

## 조건 묶기: `.and()` / `.or()` / `.not()`

조건은 AND나 OR로 묶을 수 있고 부정할 수도 있습니다.

```typescript
const u = qAlias(User, "u");

// (age >= 18) AND (status = 'active')
qb.where(u.age.gte(18).and(u.status.eq("active")));

// role이 admin이거나 owner
qb.where(u.role.eq("admin").or(u.role.eq("owner")));

// isNull을 부정 → isNotNull과 같음
qb.where(u.deletedAt.isNull().not());
```

체인은 쓴 순서대로 묶입니다. `a.and(b).or(c)`는 `(a AND b) OR c`가 됩니다.

그룹을 더 명시적으로 만들려면 `Expressions` 헬퍼를 씁니다.

```typescript
import { Expressions as exp } from "@stingerloom/orm";

// (active이면서 admin) 또는 owner
qb.where(
  exp.or(
    exp.and(u.status.eq("active"), u.role.eq("admin")),
    u.role.eq("owner"),
  ),
);
```

`.and()`와 `.or()`는 어떤 조건이든 받습니다. 그래서 컬럼 비교, 집계 비교, JSON 경로 조건을 섞어서 묶을 수 있습니다. 예를 들어 `u.age.gte(18)`, `u.id.count().gt(10)`, `u.profile.tags.contains("admin")`을 함께 묶어도 됩니다.

```typescript
qb.where(
  exp.and(
    u.status.eq("active"),
    u.profile.tags.contains("admin"),   // JSON 경로 조건도 함께 묶음
  ),
);
```

AND나 OR을 연달아 쓰면 출력 SQL에서 괄호를 한 번만 칩니다. 그래서 `a.and(b).and(c).and(d)`는 `(a AND b AND c AND d)`로 평평하게 펼쳐집니다.

## 문자열 매칭: `.startsWith` / `.endsWith` / `.contains`

`.startsWith`, `.endsWith`, `.contains`는 LIKE 패턴을 대신 만드는 메서드입니다. 이 메서드가 왜 필요한지는 다음 코드에서 드러납니다.

```typescript
// 검색창 입력값을 그대로 LIKE에 넣는다면?
qb.where("name", "LIKE", `${userInput}%`);
```

`userInput`이 `"50%"`이면 쿼리는 `name LIKE '50%%'`가 됩니다. 그러면 `"50abc"`, `"50 off"`, `"500"`이 모두 매칭됩니다. 하지만 사용자가 찾으려던 것은 "50%"라는 글자 그대로입니다.

`.startsWith()`, `.endsWith()`, `.contains()`는 이 문제를 막습니다.

```typescript
qb.where(u.name.startsWith("50%"));
// 내부에서 "50\%"로 이스케이프한 패턴을 만듭니다.
// 생성하는 SQL은 name LIKE '50\%%' ESCAPE '\'입니다.
// 그래서 "50%"로 시작하는 이름만 매칭합니다.
```

사용자가 `%`, `_`, `\` 같은 LIKE 특수문자를 입력해도 모두 리터럴로 처리합니다.

평범한 검색에도 그대로 씁니다.

```typescript
qb.where(u.name.startsWith("Al"));    // "Al"로 시작
qb.where(u.name.endsWith("son"));     // "son"으로 끝남
qb.where(u.name.contains("lic"));     // 중간에 "lic" 포함
```

## 대소문자 무시: `*IgnoreCase`

문자열 매칭 메서드에는 `IgnoreCase` 버전이 있습니다. 이 버전은 문자열을 매칭할 때 대소문자를 구분하지 않습니다.

```typescript
qb.where(u.username.equalsIgnoreCase("alice"));   // 정확히 일치, 대소문자만 무시
qb.where(u.email.containsIgnoreCase("@gmail"));   // 포함, 대소문자 무시
qb.where(u.email.startsWithIgnoreCase("admin@"));
qb.where(u.email.endsWithIgnoreCase(".com"));
qb.where(u.name.likeIgnoreCase("%Al%"));          // 와일드카드를 직접 쓰고 싶을 때
```

내부 동작은 드라이버마다 조금 다릅니다.

- **`.likeIgnoreCase` 계열 (패턴 매칭)**: PostgreSQL에는 `ILIKE`가 있으므로 그대로 씁니다. MySQL과 SQLite는 양쪽에 `LOWER()`를 씌웁니다.
- **`.equalsIgnoreCase`**: 세 드라이버 모두 `LOWER(col) = LOWER(?)`를 생성합니다. 와일드카드 없는 동등 비교에는 ILIKE가 어울리지 않기 때문입니다. 이렇게 하면 컬럼 콜레이션이 대소문자를 구분하는지와 상관없이 결과가 같습니다.

코드는 드라이버와 상관없이 한 줄입니다. 로그인 폼의 이메일 조회를 예로 듭니다.

```typescript
// 사용자가 "Alice@Example.com"이든 "alice@example.com"이든 같은 결과
const user = await em.createQueryBuilder(User, "u")
  .where(u.email.equalsIgnoreCase(inputEmail))
  .getOne();
```

## 정규식: `.matches(pattern)`

`.matches()`는 정규식 조건을 만듭니다. 인자는 패턴 문자열이나 JS `RegExp`입니다. 패턴은 항상 파라미터로 바인딩되므로 SQL 인젝션이 들어올 곳이 없습니다.

```typescript
const u = qAlias(User, "u");

qb.where(u.email.matches("^[^@]+@example\\.com$"));
// PostgreSQL:  "u"."email" ~ $1
// MySQL:       `u`.`email` REGEXP ?
// SQLite:      "u"."email" REGEXP ?      (`regexp` UDF가 처리)

qb.where(u.title.matches(/typescript/i));   // 대소문자 무시
qb.where(u.slug.matches(/^[a-z0-9-]+$/).not());
```

`RegExp`의 `i`, `m`, `s` 플래그는 바인딩한 패턴 앞에 인라인 옵션 그룹 `(?ims)`로 붙습니다. PostgreSQL ARE와 MySQL/MariaDB ICU는 이 옵션 그룹을 직접 해석합니다. SQLite의 `regexp` UDF는 옵션 그룹을 다시 JS `RegExp` 플래그로 바꿉니다. `g`, `u`, `y` 플래그는 조건식에서 의미가 없으므로 무시됩니다. 조건은 `.not()`으로 부정하고 `.and()`와 `.or()`로 합성합니다.

엔진마다 주의할 점이 있습니다.

- `i` 플래그(대소문자 무시)는 어느 엔진에서나 같게 동작합니다. 하지만 `m`과 `s`는 엔진마다 개행을 다루는 방식이 다릅니다. multiline이나 dotAll에 의존한다면 골든 테스트나 통합 테스트로 동작을 고정하세요.
- MySQL `REGEXP`는 바이너리가 아닌 콜레이션에서 기본적으로 대소문자를 구분하지 않습니다. 그래서 플래그 없는 `.matches("^a")`도 MySQL에서는 `A...`에 매칭됩니다. MySQL에서 대소문자를 구분하려면 바이너리 콜레이션을 써야 합니다. PostgreSQL `~`와 SQLite UDF는 `i` 플래그가 없으면 대소문자를 구분합니다.
- SQLite에는 내장 정규식 엔진이 없습니다. 그래서 커넥터가 연결할 때 `regexp` UDF를 등록하고 JS `RegExp`로 실행합니다. 악의적인 패턴은 ReDoS를 일으킬 수 있습니다. 그러므로 사용자가 입력한 패턴은 검증한 뒤에 쓰세요.

## 전문 검색: `.matchAgainst(query, options?)`

`.matchAgainst()`는 `find({ search })`에 대응하는 `qAlias()` 메서드입니다. 컬럼 하나에 거는 전문 검색 조건을 만듭니다. query는 파라미터로 바인딩됩니다.

```typescript
const a = qAlias(Article, "a");

qb.where(a.body.matchAgainst("typescript orm"));
// PostgreSQL:  to_tsvector($1, "a"."body") @@ plainto_tsquery($2, $3)
// MySQL:       MATCH(`a`.`body`) AGAINST(? IN BOOLEAN MODE)
// SQLite:      OrmError(UNSUPPORTED_DATABASE) throw

qb.where(a.body.matchAgainst("orm", { mode: "natural" }));        // MySQL 모드
qb.where(a.body.matchAgainst("bonjour", { language: "french" })); // PG config
qb.where(a.body.matchAgainst("spam").not());
```

- **PostgreSQL**: `to_tsvector(language, col) @@ plainto_tsquery(language, query)`를 생성합니다. language는 `options.language`로 지정하며 기본값은 `"english"`입니다.
- **MySQL**: `MATCH(col) AGAINST(query IN BOOLEAN|NATURAL LANGUAGE MODE)`를 생성합니다. 모드는 `options.mode`로 지정하며 기본값은 `"boolean"`입니다. 컬럼에 `FULLTEXT` 인덱스가 있어야 합니다.
- **SQLite**: `OrmError(UNSUPPORTED_DATABASE)`를 던집니다. 대신 FTS5 가상 테이블과 `em.query()`를 쓰세요.

`options.language`는 PostgreSQL 전용이고 `options.mode`는 MySQL 전용입니다. 그래서 각 다이얼렉트는 다른 쪽 옵션을 무시합니다. 여러 컬럼을 매칭하려면 `Conditions.fullTextSearch([c1, c2], query, dialect, options)`를 씁니다. 결과 조건은 `.and()`, `.or()`, `.not()`으로 합성할 수 있습니다.

## 배열 연산자 (PostgreSQL): `.arrayContains` / `.arrayOverlaps` / `.arrayContainedBy`

PostgreSQL `array` 컬럼에 쓰는 연산자입니다. JSON 경로 DSL과 대칭을 이룹니다. 배열 포함 연산 세 가지를 제공합니다.

```typescript
const u = qAlias(User, "u");

qb.where(u.tags.arrayContains(["admin", "beta"]));     // tags @> $1   (전부 포함)
qb.where(u.tags.arrayOverlaps(["vip", "pro"]));        // tags && $1   (하나라도 겹침)
qb.where(u.tags.arrayContainedBy(allowedTags));        // tags <@ $1   (부분집합)
qb.where(u.tags.arrayContains(["admin"]).not());       // NOT (...)
```

값 배열은 파라미터 하나로 바인딩됩니다. node-postgres가 이 값을 PostgreSQL 배열 리터럴로 직렬화합니다. 그리고 엔진이 컬럼에서 원소 타입을 추론합니다. 그래서 `ARRAY[...]`를 구성하거나 빈 배열을 캐스트하지 않아도 됩니다. 결과인 `ColumnCondition`은 `.and()`, `.or()`, `.not()`으로 합성할 수 있습니다.

배열 연산자는 PostgreSQL 전용입니다. MySQL과 SQLite에는 네이티브 배열 컬럼 타입이 없으므로 `OrmError(UNSUPPORTED_DATABASE)`를 던집니다. 에러 메시지는 데이터를 JSON 배열이나 정션 테이블로 모델링하라고 안내합니다. JSON 배열은 JSON 경로 DSL로 다룹니다. 이 메서드는 엔티티 속성의 타입이 원시 타입 배열인 `qAlias()` 컬럼에만 있습니다. `string[]`, `number[]`가 그 예입니다. 객체 배열은 JSON 경로 표현식으로 매핑됩니다.

## 한눈에 보기

| 하고 싶은 일 | 메서드 |
|---|---|
| 정렬 방향 지정 | `.asc()`, `.desc()` |
| null 위치 지정 | 위에 이어서 `.nullsFirst()` / `.nullsLast()` |
| 값 집계 | `.count()`, `.countDistinct()`, `.sum()`, `.avg()`, `.min()`, `.max()` |
| 집계 결과로 필터 | 집계 뒤에 `.gt(10)`, `.eq(0)`, `.between(1, 100)` 등 평소대로 |
| 조건부 집계 | `aggregate.filter(condition)`, `.countIf(condition)`, `.sumIf(condition)`. PG/SQLite는 `FILTER (WHERE …)`, MySQL은 `CASE`로 변환 |
| SELECT 별칭 | `.as("name")`. 컬럼, JSON 경로, 집계 어디에든 붙이고 `AliasedExpression`을 반환 |
| null fallback | `coalesce(...)`, `col.coalesce(...)`: 처음 나오는 non-null 값. `nullif(a, b)`: 일치하면 NULL |
| 행 단위 최대 / 최소 | `greatest(a, b, …)`, `least(a, b, …)`, `col.greatest(…)`, `col.least(…)`, `Expressions.greatest`, `Expressions.least`. PG와 MySQL은 `GREATEST`/`LEAST`, SQLite는 `MAX`/`MIN` |
| upsert 제안 행 참조 | `qExcluded(Entity)`. `EXCLUDED.col` (PG), `excluded.col` (SQLite), `new.__col` (MySQL 8.0.19+), `VALUES(col)` (MariaDB, 이전 MySQL) |
| 현재 시각 | `currentDate()`, `currentTime()`, `currentTimestamp()`. `Expressions`에도 같은 헬퍼가 있음 |
| 타입 변환 | `.stringValue()`, `.intValue()`, `.longValue()`, `.floatValue()`, `.booleanValue()` |
| 날짜 컴포넌트 | `.year()`, `.month()`, `.day()`, `.hour()`, `.minute()`, `.second()`, `.dayOfWeek()`, `.dayOfYear()`, `.week()` |
| 서브쿼리 비교 | `.in(subQb)`, `.notIn(subQb)`, `.eq/.neq/.gt/.gte/.lt/.lte(subQb)`, `Expressions.exists`, `Expressions.notExists` |
| Row-value 튜플 | `Expressions.tuple(c1, c2, …).in(rows)` / `.notIn(rows)` / `.eq(row)`. 복합 기본 키 비교에 사용 |
| 정규식 매칭 | `.matches(pattern)`. 문자열 또는 `RegExp`(`i`/`m`/`s` 플래그)를 받고 `.not()`으로 부정. PG `~`, MySQL/SQLite `REGEXP` |
| 전문 검색 | `.matchAgainst(query, { language?, mode? })`. PG `to_tsvector @@ plainto_tsquery`, MySQL `MATCH … AGAINST`, SQLite는 에러를 던짐 |
| 배열 연산자 (PG) | `.arrayContains(vals)` `@>`, `.arrayOverlaps(vals)` `&&`, `.arrayContainedBy(vals)` `<@`. PostgreSQL 전용 |
| CASE 표현식 | `Expressions.caseBuilder().when(...).then(...).otherwise(...).end()`; `Expressions.cases(subject)...end()` |
| CASE 단축 | `Expressions.iff(cond, a, b)`; `Expressions.mapValues(subject, { k: v }, default?)`; `Expressions.buckets(subject, [[t, label], …], default?, { op? })` |
| 문자열 / 숫자 / 수학 | `.toLowerCase/.toUpperCase/.trim/.length/.substring/.concat/.indexOf/.replace`, `.add/.sub/.mul/.div/.mod/.neg`, `.abs/.floor/.ceil/.round/.sqrt` |
| 날짜 산술 | `.addYears/Months/Days/Hours/Minutes/Seconds(n)`, `Expressions.dateDiff(a, b, unit)`, `Expressions.random()` |
| 윈도 함수 | `aggregate.over().partitionBy(...).orderBy(...).rowsBetween(start, end).as("alias")`. `rangeBetween`도 같은 방식 |
| Raw SQL 이스케이프 | `` Expressions.raw<T>(sql`...`) `` → `ScalarExpression` (체인 합성 가능) |
| BigInt cast | `.bigintValue()` (BIGINT / SIGNED / INTEGER) |
| 스키마 기반 행 추론 | `qb.selectSchema(zodSchema)`. `TResult`를 `z.infer<schema>`로 좁히고 런타임에 검증 |
| 조건 묶기 | `.and(other)`, `.or(other)`, `.not()` |
| 그룹을 직접 짤 때 | `Expressions.and(...)`, `Expressions.or(...)`, `Expressions.not(cond)` |
| 안전한 prefix/suffix/포함 | `.startsWith`, `.endsWith`, `.contains` (LIKE 특수문자 자동 이스케이프) |
| 대소문자 무시 매칭 | 위 이름 뒤에 `IgnoreCase`, 그리고 `.equalsIgnoreCase`, `.likeIgnoreCase` |

## 다이얼렉트 지원 매트릭스

현재 다이얼렉트에 대응하는 형태가 없는 표현식이면 렌더러가 `OrmError(OrmErrorCode.UNSUPPORTED_OPERATION)`을 던집니다. 에러 메시지에는 다음 내용이 들어갑니다.

- 기능 이름
- 실패한 다이얼렉트
- 지원하지 않는 이유
- 구체적인 대안. 에뮬레이션 방법이나 탈출구를 안내합니다.

다이얼렉트마다 빠진 기능을 미리 알아 두려면 아래 매트릭스를 참고하세요.

| 표현식 | PostgreSQL | MySQL | SQLite | 비고 |
|--------|------------|-------|--------|------|
| 집계 (`count`, `sum`, `avg`, `min`, `max`, `countDistinct`) | 네이티브 | 네이티브 | 네이티브 | 없음 |
| 조건부 집계 (`.filter()`, `countIf`, `sumIf`) | 네이티브 `FILTER (WHERE …)` | `FUNC(CASE WHEN … THEN … END)`로 변환 | 네이티브 `FILTER (WHERE …)` (3.30+) | MySQL에서 `COUNT(*)`는 `COUNT(CASE WHEN … THEN 1 END)`가 됨. NULL을 다루는 방식은 다이얼렉트 간에 같음. |
| Row-value 튜플 (`Expressions.tuple().in/notIn/eq`) | 네이티브 | 네이티브 | 네이티브 (3.15+) | 식별자 따옴표 외에는 다이얼렉트 간 SQL이 같음. |
| 정규식 매칭 (`.matches()`) | 네이티브 `~` (ARE) | 네이티브 `REGEXP` (ICU, 기본 대소문자 무시) | 커넥터가 등록한 `regexp` UDF로 `REGEXP` 실행 | 패턴은 파라미터로 바인딩. `i` 플래그는 이식성 있음, `m`/`s`는 엔진별로 다름. MySQL에서 대소문자를 구분하려면 바이너리 콜레이션 필요. |
| 배열 연산자 (`.arrayContains` / `.arrayOverlaps` / `.arrayContainedBy`) | 네이티브 `@>` / `&&` / `<@` | 미지원: `UNSUPPORTED_DATABASE`를 던짐 | 미지원: `UNSUPPORTED_DATABASE`를 던짐 | MySQL/SQLite는 네이티브 배열 타입이 없음. JSON 배열(JSON 경로 DSL)이나 정션 테이블로 모델링. 값 배열은 파라미터 하나로 바인딩. |
| `coalesce` / `nullif` | 네이티브 | 네이티브 | 네이티브 | 없음 |
| `greatest` / `least` | 네이티브 `GREATEST` / `LEAST`. NULL 인자 무시 | 네이티브 `GREATEST` / `LEAST`. 인자 중 하나라도 NULL이면 결과 NULL | `MAX(a, b)` / `MIN(a, b)` 스칼라 형태. 인자 중 하나라도 NULL이면 결과 NULL | NULL 처리는 보정하지 않습니다. 이식성이 필요하면 nullable 인자를 `coalesce()`로 감싸세요. |
| upsert `excluded` 참조 (`qExcluded`) | `EXCLUDED."col"` | MySQL 8.0.19+는 행 별칭으로 `` `new`.`__col` ``, MariaDB와 이전 MySQL은 `` VALUES(`col`) `` | `excluded."col"` | `createInsertBuilder()` 안에서만 씁니다. |
| 윈도 함수 (`ROW_NUMBER`, `RANK`, `DENSE_RANK`, `LAG`, `LEAD`, aggregate `OVER()`) | 네이티브 | 네이티브 (8.0+) | 네이티브 (3.25+) | 없음 |
| `percentile_cont` / `percentile_disc` / `mode` ordered-set aggregate | 네이티브 (`WITHIN GROUP`) | 미지원: `UNSUPPORTED_OPERATION`을 던짐 | 미지원: `UNSUPPORTED_OPERATION`을 던짐 | MySQL: CTE와 `ROW_NUMBER() OVER (ORDER BY x)`로 에뮬레이션하고 `rn = CEIL(N * p)`인 행을 고름. [cookbook 레시피](./cookbook.md#cycle-time-percentile-report) 참고. |
| `dateTrunc` (year/quarter/month/week/day/hour/minute/second) | 네이티브 `DATE_TRUNC` | 단위별로 같은 뜻의 함수 (`DATE`, `DATE_FORMAT`, ISO 월요일 `WEEKDAY` 계산) | `date(..., 'start of …')` / `strftime` | 세 다이얼렉트 모두 ISO 월요일 기준 주를 만듦. |
| `dateDiff(a, b, unit)`: year / month | `age()`로 달력 기준 계산 | `TIMESTAMPDIFF(YEAR/MONTH, ...)`로 달력 기준 계산 | 근사: julianday / 365.25 (year), / 30.4375 (month) | SQLite는 10년 기준 약 0.07% 오차. |
| `dateDiff(a, b, unit)`: day / hour / minute / second | `EXTRACT(EPOCH ...)` 기반 epoch 초 | `TIMESTAMPDIFF(...)` | `julianday()` × factor | 세 다이얼렉트 모두 정확. |
| `dateAdd(value, n, unit)` | `value + INTERVAL 'N unit'` | `DATE_ADD(value, INTERVAL N unit)` | `datetime(value, '+N unit')` 수식자 | 없음 |
| `random()` | `random()` `[0, 1)` 반환 | `RAND()` `[0, 1)` 반환 | `RANDOM()` 64-bit signed integer 반환 | SQLite에서 `[0, 1)` 범위가 필요하면 직접 정규화. |
| Full-text search (`.matchAgainst()` / `Conditions.fullTextSearch`) | `to_tsvector / @@` (tsvector 파이프라인) | `MATCH() AGAINST(...)` (FULLTEXT 인덱스 필요) | DSL 미지원: `UNSUPPORTED_DATABASE`를 던짐 | SQLite는 FTS5 가상 테이블과 `em.query()`를 사용. |
| `jsonContains`: object/array 값 | 네이티브 `@>` containment | 네이티브 `JSON_CONTAINS` | object/array 미지원: `UNSUPPORTED_DATABASE`를 던짐 | SQLite는 경로의 스칼라 동등 비교만 지원. `metadata.profile.role.eq('admin')` 형태나 raw SQL 사용. |
| `jsonExtract` / `jsonHasKey` / `jsonArrayLength` / `jsonTypeOf` | 네이티브 (`->`, `?`, `jsonb_array_length`, `jsonb_typeof`) | 네이티브 (`JSON_EXTRACT`, `JSON_CONTAINS_PATH`, `JSON_LENGTH`, `JSON_TYPE`) | 네이티브 (`json_extract`, `json_array_length`, `json_type`) | 없음 |
| `ilike` (case-insensitive LIKE) | 네이티브 `ILIKE` | `*_ci` 콜레이션에서는 기본 `LIKE`가 대소문자 무시, `*_bin`은 `LOWER()`로 대체 | `LIKE`는 ASCII만 대소문자 무시, ASCII 밖의 유니코드는 ICU 확장 필요 | 없음 |
| 숫자 / 문자열 헬퍼 (`.abs`, `.floor`, `.ceil`, `.round`, `.length`, `.substring`, `.trim`, …) | 네이티브 | 네이티브 | 네이티브 | 없음 |

`UNSUPPORTED_OPERATION` 에러의 `suggestion` 필드에는 에뮬레이션 방법이나 대안을 알려 주는 한 줄 힌트가 있습니다. 그래서 UI에 그대로 표시하기 좋습니다. 전체 메시지에는 관련 문서 절을 가리키는 `See: docs/...` 포인터도 들어 있습니다.

## 다음 단계

- [JSON 컬럼 탐색](./query-builder-json.md): 같은 프록시를 `json` / `jsonb` 컬럼으로 확장한 기능
- [JOIN](./query-builder-joins.md): 타입 있는 컬럼 참조로 여러 엔티티를 오가는 쿼리
- [집계 & 서브쿼리](./query-builder-aggregations.md): GROUP BY / HAVING / 스칼라 · 파생 서브쿼리
- [Query Builder 개요](./query-builder.md): 기본 사용법과 전체 구성
- [분석 쿼리 Cookbook](./cookbook.md): 위 표현식으로 만든 실전 레시피 (윈도 함수, MySQL에서 에뮬레이션한 percentile, recursive CTE)
