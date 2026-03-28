# Raw SQL & CTE

## Raw SQL이 필요한 이유

ORM의 `find()`, `save()`, `SelectQueryBuilder`로 대부분의 쿼리를 처리할 수 있어요. 하지만 SQL은 풍부한 언어이고, 엔티티 기반 API로는 표현할 수 없는 것들이 있어요:

- 관계가 없는 **서로 다른 테이블의 결과를 합치기** (UNION)
- 조직도나 카테고리 트리 같은 **계층 데이터 탐색** (recursive CTE)
- 행 간 **순위 계산이나 누적 합계** (window functions)
- 여러 엔티티를 복잡하게 아우르는 **크로스 데이터베이스 분석**

이런 경우에 `RawQueryBuilder`를 사용하면 SQL의 모든 기능을 쓸 수 있으면서도 파라미터 바인딩(SQL injection 방지)과 조합 가능한 빌더 API(문자열 연결 대신 프로그래밍적으로 쿼리 구성)를 제공받을 수 있어요.

트레이드오프는 명확해요. 타입 안전한 `keyof T` 자동완성은 잃지만, SQL의 모든 표현력을 얻게 돼요. 테이블명과 컬럼명은 수동으로 따옴표 처리해야 해요 (PostgreSQL은 `"double quotes"`, MySQL은 `` `backticks` ``). 다만 `em.createQueryBuilder()`로 빌더를 생성하면 ORM이 DB 타입을 자동 감지해요.

## 시작하기

`em.createQueryBuilder()` (인자 없이)로 RawQueryBuilder를 생성하고, 메서드를 체이닝한 후 `build()`를 호출해서 SQL을 얻어요. 그다음 `em.query()`로 실행하면 돼요.

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

RawQueryBuilder의 `where()` 메서드는 조건의 **배열**을 받아서 AND로 결합해요. 값은 항상 `sql-template-tag`를 통해 파라미터 바인딩되며, 절대 SQL 문자열에 직접 연결되지 않아요.

## WHERE, JOIN, Subquery

RawQueryBuilder는 SelectQueryBuilder와 동일한 WHERE 헬퍼를 제공해요 -- `andWhere()`, `orWhere()`, `whereIn()`, `whereNull()`, `whereBetween()` 등. 차이점은 컬럼명이 타입 안전하지 않은 raw 문자열이라는 거예요.

JOIN도 같은 방식으로 동작해요:

```typescript
import sql, { raw } from "sql-template-tag";

const query = em.createQueryBuilder()
  .select(['"p".*', '"u"."name" AS "authorName"'])
  .from('"posts"', "p")
  .leftJoin('"users"', "u", sql`${raw('"p"')}."author_id" = ${raw('"u"')}."id"`)
  .where([sql`${raw('"p"')}."is_published" = ${true}`])
  .limit(20)
  .build();

const posts = await em.query(query);
```

서브쿼리의 경우, 빌더가 `asInQuery()`, `asExists()`, `as()`를 제공해서 하나의 쿼리를 다른 쿼리 안에 포함시킬 수 있어요.

```typescript
// IN subquery -- find users who have at least one order
const orderUsers = em.createQueryBuilder()
  .select(['"user_id"'])
  .from('"orders"')
  .where([sql`"status" = ${"completed"}`])
  .asInQuery();

const query = em.createQueryBuilder()
  .select(["*"])
  .from('"users"')
  .where([])
  .appendSql(sql`AND "id" IN ${orderUsers}`)
  .build();
```

## Set Operations -- UNION, INTERSECT, EXCEPT

완전히 다른 쿼리의 결과를 합쳐야 할 때가 있어요. 예를 들어 직원과 계약직을 하나의 목록으로 합치는 경우예요.

```typescript
const query = em.createQueryBuilder()
  .select(['"id"', '"name"', '"email"'])
  .from('"employees"')
  .where([sql`"department" = ${"engineering"}`])
  .union()
  .select(['"id"', '"name"', '"email"'])
  .from('"contractors"')
  .where([sql`"department" = ${"engineering"}`])
  .build();

const allEngineers = await em.query(query);
```

`union()`을 호출하면 UNION의 두 번째 부분이 될 새로운 SELECT가 시작돼요. 결과에는 양쪽 쿼리의 행이 포함되고 중복은 제거돼요.

네 가지 set operation을 사용할 수 있어요:

| Method | SQL | 설명 |
|--------|-----|------|
| `union()` | `UNION` | 두 결과 집합을 합치고 중복 제거 |
| `unionAll()` | `UNION ALL` | 두 결과 집합을 합치고 중복 유지 (더 빠름) |
| `intersect()` | `INTERSECT` | 양쪽 결과 집합에 모두 있는 행만 반환 |
| `except()` | `EXCEPT` | 첫 번째 집합에만 있고 두 번째에는 없는 행 반환 |

실용 예제: users 테이블에는 있지만 unsubscribed 테이블에는 없는 이메일 주소 찾기.

```typescript
const query = em.createQueryBuilder()
  .select(['"email"']).from('"users"')
  .except()
  .select(['"email"']).from('"unsubscribed"')
  .build();

const subscribedEmails = await em.query(query);
```

## Common Table Expressions (CTE)

### CTE가 필요한 이유

CTE는 서브쿼리에 이름을 붙여 변수처럼 저장하는 거라고 생각하면 돼요. 일반 프로그래밍에서 50줄짜리 표현식을 인라인으로 쓰지 않고 이름 있는 변수로 분리하는 것과 같은 원리예요. CTE가 SQL에서 똑같은 역할을 해요.

CTE 없이는 서브쿼리 안에 서브쿼리를 중첩하게 되면서 금방 읽기 어려워져요. CTE를 쓰면 각 단계를 이름 있는 블록으로 정의한 다음 조합할 수 있어요. DB가 순서대로 실행하고, 각 단계에서 이전 단계를 참조할 수 있어요.

이런 느낌이에요:

```
// Pseudocode
const activeUsers = SELECT id, name FROM users WHERE is_active = true;
const result = SELECT * FROM activeUsers;
```

SQL로 쓰면 이렇게 돼요:

```sql
WITH active_users AS (
  SELECT "id", "name" FROM "users" WHERE "is_active" = true
)
SELECT * FROM active_users
```

### 사용법

```typescript
const query = em.createQueryBuilder()
  .with("active_users", (sub) =>
    sub.select(['"id"', '"name"']).from('"users"').where([sql`"is_active" = ${true}`])
  )
  .select(["*"])
  .from(sql`active_users`)
  .build();

const users = await em.query(query);
```

`with()` 메서드는 이름과 `Sql` 객체 또는 새 `RawQueryBuilder`를 받는 콜백을 인자로 받아요. CTE 결과는 메인 쿼리의 FROM 절에서 일반 테이블처럼 참조할 수 있어요.

### Recursive CTE

조직도, 카테고리 트리, 스레드 댓글처럼 본질적으로 계층적인 데이터가 있어요. **Recursive CTE**를 사용하면 레벨마다 쿼리를 보내는 대신 하나의 쿼리로 계층 구조를 탐색할 수 있어요.

`employees` 테이블에서 각 직원이 매니저를 가리키는 `manager_id`를 가진다고 가정해 볼게요. CEO부터 시작하는 전체 조직 트리를 가져오려면:

```typescript
const query = em.createQueryBuilder()
  .withRecursive("org_tree", sql`
    SELECT "id", "name", "manager_id", 1 AS depth
    FROM "employees"
    WHERE "manager_id" IS NULL

    UNION ALL

    SELECT "e"."id", "e"."name", "e"."manager_id", "ot"."depth" + 1
    FROM "employees" "e"
    INNER JOIN "org_tree" "ot" ON "e"."manager_id" = "ot"."id"
  `)
  .select(["*"])
  .from(sql`org_tree`)
  .orderBy([{ column: '"depth"', direction: "ASC" }])
  .build();

const orgChart = await em.query(query);
// [{ id: 1, name: "CEO", depth: 1 }, { id: 2, name: "VP Eng", depth: 2 }, ...]
```

Recursive CTE는 `UNION ALL`로 결합된 두 부분으로 구성돼요:
1. **Base case** -- 시작 행 (매니저가 없는 직원 = CEO)
2. **Recursive step** -- CTE 결과를 원래 테이블에 다시 조인해서 하위 항목을 찾기

DB가 새로운 행이 더 이상 생성되지 않을 때까지 recursive step을 반복 실행해요. 각 반복마다 트리에서 한 단계 더 깊이 들어가요.

## Window Functions

### Window Functions가 필요한 이유

부서별로 직원의 급여 순위를 매기고 싶다고 가정해 볼게요. GROUP BY를 쓰면 한 부서의 모든 직원이 하나의 행으로 합쳐지면서 개별 직원 데이터를 잃게 돼요. Window function은 **모든 행을 유지**하면서 계산된 값을 옆에 추가할 수 있어요.

이렇게 생각하면 돼요: GROUP BY는 블렌더(모든 게 그룹당 하나의 결과로 합쳐짐)예요. Window function은 각 행 옆에 앉아서 "창문"을 통해 관련 행을 보고, 아무것도 변경하지 않고 답을 적어두는 계산기예요.

### 사용법

전형적인 예제는 순위 매기기예요. 부서별로 급여 순위를 매기는 경우를 볼게요.

```typescript
const query = em.createQueryBuilder()
  .selectWithWindow([
    '"name"',
    '"department"',
    '"salary"',
    {
      expr: "ROW_NUMBER()",
      over: { partitionBy: '"department"', orderBy: '"salary" DESC' },
      alias: "rank",
    },
  ])
  .from('"employees"')
  .build();

const ranked = await em.query(query);
// [
//   { name: "Alice", department: "eng", salary: 150000, rank: 1 },
//   { name: "Bob",   department: "eng", salary: 130000, rank: 2 },
//   { name: "Carol", department: "sales", salary: 140000, rank: 1 },
//   ...
// ]
```

`selectWithWindow()` 배열의 각 요소는 plain 컬럼 문자열이거나 window function을 설명하는 객체예요:

- `expr` -- 적용할 함수 (`ROW_NUMBER()`, `RANK()`, `SUM(salary)` 등)
- `over.partitionBy` -- 그룹을 나눌 컬럼 (GROUP BY와 비슷하지만 행을 합치지 않아요)
- `over.orderBy` -- 각 그룹 내 정렬 순서
- `alias` -- 계산된 컬럼의 이름

자주 사용되는 window function 목록이에요:

| Function | 설명 | 예시 |
|----------|------|------|
| `ROW_NUMBER()` | 파티션 내 순차 번호 | 그룹 내 페이지네이션 |
| `RANK()` | 동점 시 건너뛰는 순위 (1, 2, 2, 4) | 리더보드 |
| `DENSE_RANK()` | 동점 시 건너뛰지 않는 순위 (1, 2, 2, 3) | 카테고리별 Top-N |
| `SUM(col)` | 파티션 내 누적 합계 | 누적 매출 |
| `AVG(col)` | 이동 평균 | Moving average |
| `LAG(col)` | 이전 행의 값 | 전일 대비 비교 |
| `LEAD(col)` | 다음 행의 값 | 예측 |

실용 예제 -- 월별 누적 매출 계산:

```typescript
const query = em.createQueryBuilder()
  .selectWithWindow([
    '"month"',
    '"revenue"',
    {
      expr: "SUM(revenue)",
      over: { orderBy: '"month" ASC' },
      alias: "cumulative_revenue",
    },
  ])
  .from('"monthly_sales"')
  .build();
```

`partitionBy`를 생략하면 window가 전체 결과 집합에 걸쳐요. 누적 합계가 그룹별이 아니라 모든 행에 대해 누적돼요.

## DISTINCT -- 중복 제거

RawQueryBuilder는 DISTINCT 변형도 지원해요.

```typescript
// SELECT DISTINCT
qb.selectDistinct(['"city"', '"country"']).from('"users"');

// DISTINCT ON (PostgreSQL only) -- keep only the first row per group
qb.selectDistinctOn(['"department"'], ['"id"', '"name"', '"salary"'])
  .from('"employees"');
// SELECT DISTINCT ON ("department") "id", "name", "salary" FROM "employees"
```

`DISTINCT ON`은 PostgreSQL 전용 확장으로 지정된 컬럼의 고유 값마다 하나의 행만 반환해요. GROUP BY와 비슷하지만 어떤 행을 유지할지 선택할 수 있어요 (ORDER BY로 결정).

## 두 빌더 중 선택하기

| 질문 | SelectQueryBuilder | RawQueryBuilder |
|------|-------------------|----------------|
| 등록된 엔티티를 쿼리하나요? | Yes | 필수 아님 |
| `keyof T` 자동완성이 필요한가요? | Yes | No |
| UNION / INTERSECT / EXCEPT가 필요한가요? | No | Yes |
| CTE (WITH / WITH RECURSIVE)가 필요한가요? | No | Yes |
| Window function이 필요한가요? | No | Yes |
| 클래스 인스턴스를 반환하나요? | `getMany()` yes / `getPartialMany()` no | No -- `em.query()`로 raw 객체 반환 |

실전에서는 일상적인 쿼리에 `SelectQueryBuilder`부터 시작하세요. 한계에 부딪히면 -- UNION, 재귀 계층 탐색, window 분석이 필요하면 -- 해당 쿼리에만 `RawQueryBuilder`로 전환하면 돼요.

## Next Steps

- [Query Builder](./query-builder.md) -- Type-safe SelectQueryBuilder with `keyof T` auto-complete
- [EntityManager](./entity-manager.md) -- Basic CRUD with find(), save(), etc.
- [API Reference](./api-reference.md) -- Quick reference for all method signatures
