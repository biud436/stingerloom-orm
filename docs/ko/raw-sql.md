# Raw SQL & CTE

## Raw SQL이 필요한 이유

ORM의 `find()`, `save()`, `SelectQueryBuilder`로 대부분의 쿼리를 처리할 수 있어요. 하지만 SQL은 풍부한 언어이고, 엔티티 기반 API로는 표현할 수 없는 것들이 있어요:

- 관계가 없는 **서로 다른 테이블의 결과를 합치기** (UNION)
- 조직도나 카테고리 트리 같은 **계층 데이터 탐색** (recursive CTE)
- 행 간 **순위 계산이나 누적 합계** (window functions)
- 여러 엔티티를 복잡하게 아우르는 **크로스 데이터베이스 분석**

이런 경우에 `RawQueryBuilder`를 사용하면 SQL의 모든 기능을 쓸 수 있으면서도 파라미터 바인딩(SQL injection 방지)과 조합 가능한 빌더 API(문자열 연결 대신 프로그래밍적으로 쿼리 구성)를 제공받을 수 있어요.

트레이드오프는 명확해요. 타입 안전한 `keyof T` 자동완성은 잃지만, SQL의 모든 표현력을 얻게 돼요. 테이블명과 컬럼명은 수동으로 따옴표 처리해야 해요 (PostgreSQL은 `"double quotes"`, MySQL은 `` `backticks` ``). 다만 `em.createQueryBuilder()`로 빌더를 생성하면 ORM이 DB 타입을 자동 감지해요.

## 탈출구(escape hatch) 선택하기

Raw SQL 표면은 의도적으로 계층화되어 있어요. 쿼리가 까다로워질수록 한 칸씩 위로 올라가되, 쿼리가 요구하는 만큼만 올라가는 게 원칙이에요. 각 단계는 약간의 구조(타입 안전성, 자동 매핑)를 표현력과 맞바꿔요.

| 단계 | 사용 시점 | 도구 |
|------|----------|------|
| 1. **가장 구조화** | 표준 CRUD, 필터링, 선언된 관계 기반 조인 | `SelectQueryBuilder` (`em.createQueryBuilder(Entity, alias)`) |
| 2. 분석/구조화 SQL | Window function, percentile, aggregate, CASE, JSON 경로 -- 엔티티 컬럼 기반 타입 인지 유지 | Expressions DSL (`Expressions.*` -- [QueryDSL](./query-builder-querydsl.md) 참고) |
| 3. DSL이 표현 못하지만 엔티티 인지는 유지 | CTE, `WITH RECURSIVE`, 벤더 특화 연산자, 엔티티 컬럼을 참조하는 멀티 빌더 조합 | `sql` 템플릿 + `em.ref()` / `em.aliasRef()` + `RawQueryBuilder` |
| 4. **완전 raw** | 일회성 벤더 SQL, DSL이 표현 못하는 동적 식별자, 시스템 카탈로그, `EXPLAIN ANALYZE`, 엔티티 모델이 없는 모든 것 | `em.query(sql, params)` |

원칙: **1단계에서 시작해서 위 단계가 정말로 표현 못 할 때만 올라간다.** 곧바로 `em.query()`로 내려가면 파라미터 바인딩 편의, NamingStrategy 역매핑, dialect quoting을 잃고 모두 손으로 다시 짜야 해요.

### 도구별 레퍼런스

| 도구 | 목적 | 식별자 escape | 값 바인딩 | 비고 |
|------|------|---------------|----------|------|
| `em.ref(Entity)` | bare 테이블 참조 (`"issue"`); `${ref.id}` -> `"id"` | O (dialect 따옴표) | 해당 없음 | `@Column` 리네임, FK backing 프로퍼티, snake_case 자동 해석. 멀티테넌트 테이블 wrapping 자동 적용. |
| `em.ref(Entity, alias)` | FROM/JOIN용 테이블+alias (`"issue" AS i`); `${ref.id}` -> `i."id"` | O (dialect 따옴표) | 해당 없음 | 동일 엔티티에 다른 alias를 줘서 self-join 구성 가능. |
| `em.aliasRef(name)` | CTE / derived table용 alias 전용 컬럼 (`${ref.depth}` -> `t."depth"`) | O (dialect 따옴표) | 해당 없음 | CTE 본문에만 존재하는 컬럼(엔티티가 없는 경우) 사용. |
| `sql\`…\`` (`sql-template-tag`) | SQL 조각 조합, 값 자동 파라미터화 | -- | **O** -- 모든 `${value}`가 placeholder | `@stingerloom/orm`에서 편의상 re-export. |
| `raw(str)` (`sql-template-tag`) | 문자열을 SQL에 그대로 splice (quoting/binding 없음) | **X** | **X** | **사용자 입력을 `raw()`로 보간하지 마세요.** 이미 신뢰하는 식별자 문자열에만 사용. |
| `em.query(sqlOrText, params?)` | 활성 커넥션에서 쿼리 실행 | -- | `Sql` 객체 또는 `(text, params)` 튜플일 때 O | 드라이버의 raw 행 반환; NamingStrategy 역매핑이나 hydration 없음. |

#### 안전 계약(safety contract)

- `em.ref()`와 `em.aliasRef()`는 모든 식별자를 활성 드라이버의 `wrap()`을 거치게 해요 -- 실수로 따옴표 없는 SQL이 나갈 수 없어요.
- `sql\`…\``는 모든 `${value}`를 파라미터로 바인딩해요. 사용자 문자열을 여기 보간하는 건 **안전**해요.
- `raw(str)`는 문자열을 그대로 splice해요. **SQL을 손으로 쓰는 것과 동일**하다고 봐야 해요. 문자열이 사용자 입력이라면, `raw()`에 넘기기 전에 직접 allowlist 검증(예: `column ∈ knownColumns`)을 거치게 하세요.
- `em.query(text, params)`는 `params`를 바인딩하지만 `text`는 escape하지 않아요. 같은 원칙: text에는 **값이 아닌 식별자**를 절대 보간하지 마세요.

### 단계 올라가는 예제

실전 시나리오: 게시글-사용자 블로그에서 "활성 사용자 목록"부터 "역할별로 발행된 게시글 수 기준 상위 3명 랭킹"까지 점진적으로 올라가요.

#### 1단계 -- `SelectQueryBuilder`

활성 사용자를 이름 순으로 정렬해서 가져와요. 모두 `keyof T`로 타입 안전, SQL 한 줄도 안 써요.

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .where({ isActive: true })
  .orderBy("u.name", "ASC")
  .limit(50)
  .getMany();
```

#### 2단계 -- Expressions DSL

같은 목록을 `role`로 그룹화하고, 행마다 발행된 게시글 수를 붙여요. 엔티티 인지는 여전히 유지 -- 조인된 관계와 집계 모두 엔티티 컬럼으로 표현돼요.

```typescript
import { Expressions as E } from "@stingerloom/orm";

const rows = await em
  .createQueryBuilder(User, "u")
  .leftJoin("u.posts", "p", { isPublished: true })
  .selectFragments([
    "u.role",
    E.count("p.id").as("postCount"),
  ])
  .where({ isActive: true })
  .groupBy("u.role")
  .getRawMany<{ role: string; postCount: number }>();
```

`Expressions.count`는 dialect별 SQL을 렌더링하면서 엔티티 프로퍼티 경로를 유지해요 -- `p.id`는 `@Column` / NamingStrategy를 통해 자동으로 해석돼서 `"p"."id"`를 직접 쓸 필요가 없어요.

#### 3단계 -- `sql` 템플릿 + `em.ref()`

"역할별 상위 3명"은 derived table 위의 window function 없이 DSL로 깔끔하게 표현하기 어려워요. 역할 내에서 사용자를 랭킹하는 CTE를 만들고, rank <= 3으로 필터링해야 해요 -- 그런데 CTE는 여전히 실제 엔티티 컬럼(`User.id`, `User.role`)을 참조하므로 `em.ref()`/`em.aliasRef()`를 써서 rename-safe하게 유지해요.

```typescript
import sql from "sql-template-tag";

const U = em.ref(User, "u");
const P = em.ref(Post, "p");
const r = em.aliasRef("r");                      // CTE alias; `postCount` / `rank`는 CTE 내부에만 존재

const query = em.createQueryBuilder()
  .with("ranked", sql`
    SELECT
      ${U.id},
      ${U.role},
      ${U.name},
      COUNT(${P.id}) AS post_count,
      ROW_NUMBER() OVER (
        PARTITION BY ${U.role}
        ORDER BY COUNT(${P.id}) DESC
      ) AS rank
    FROM ${U}
    LEFT JOIN ${P} ON ${P.authorId} = ${U.id} AND ${P.isPublished} = ${true}
    WHERE ${U.isActive} = ${true}
    GROUP BY ${U.id}, ${U.role}, ${U.name}
  `)
  .select([`${r.role}`, `${r.name}`, `${r.postCount}`])
  .from(sql`ranked ${r}`)
  .where([sql`${r.rank} <= ${3}`])
  .orderBy([{ column: `${r.role}`, direction: "ASC" }, { column: `${r.rank}`, direction: "ASC" }])
  .build();

const top3PerRole = await em.query<{ role: string; name: string; postCount: number }>(query);
```

TypeScript에서 `User.role`을 리네임하면 CTE 본문과 outer 쿼리 양쪽에 그대로 반영돼요. dialect 따옴표 -- `"role"` vs `` `role` `` -- 도 자동 선택돼요.

#### 4단계 -- `em.query()` (완전 raw)

위 쿼리에 대한 `EXPLAIN ANALYZE`나 dialect별로 다른 통계 뷰를 동적으로 가리키는 작업은 DSL에 모델이 없어요. `em.query()`로 떨어져서 SQL을 손으로 써요 -- 값은 여전히 파라미터 바인딩되지만 식별자는 손으로 작성해요.

```typescript
import sql from "sql-template-tag";

const plan = await em.query(sql`
  EXPLAIN ANALYZE
  SELECT count(*) FROM "posts" WHERE "is_published" = ${true}
`);
```

이 단계에서 테이블/컬럼 이름이 사용자 입력에서 온다면, **반드시 allowlist로 검증한 뒤** 보간하세요 -- 이 계층에서는 자동 escape가 없어요.

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

## 타입 참조 (Typed References)

`'"users"."id"'` 같은 따옴표 문자열을 직접 손으로 적는 건 금방 지저분해지고, 컬럼 이름을 한 번 바꾸면 문자열이 조용히 깨져요. 두 헬퍼는 엔티티 클래스(또는 alias 이름)로부터 `sql` 태그와 호환되는 프록시를 반환해서, dialect에 맞는 SQL 조각을 자동으로 만들어 줘요. 같은 코드가 PostgreSQL, MySQL, SQLite에서 그대로 동작해요.

### `em.ref(Entity, alias?)` -- 엔티티 바인딩

```typescript
import sql from "sql-template-tag";

const U = em.ref(User, "u");

const query = em.createQueryBuilder()
  .selectFragments([U.id, U.email])
  .from(U)
  .where([sql`${U.isActive} = ${true}`])
  .build();
// PostgreSQL: SELECT u."id", u."email" FROM "user" AS u WHERE u."is_active" = ?
// MySQL:      SELECT u.`id`, u.`email` FROM `user` AS u WHERE u.`is_active` = ?
```

| 보간 | alias `"u"` 있음 | alias 없음 |
|------|-----------------|-----------|
| `${ref}` | `"user" AS u` (FROM/JOIN에 바로 사용) | `"user"` |
| `${ref.id}` | `u."id"` | `"id"` |
| `${ref.as("createdAt")}` | `u."created_at" AS "createdAt"` | `"created_at" AS "createdAt"` |

프로퍼티 이름은 먼저 `@Column` 메타데이터로 해석돼요 (이름을 바꿔도 SQL이 따라가요). 그다음 관계의 FK backing 프로퍼티 (`parent!: Issue` 관계의 `parentId`는 `@Column` 없이도 FK 컬럼으로 해석돼요), 마지막으로 `camelToSnakeCase` fallback이 적용돼요. 멀티테넌트 테이블 wrapping도 자동으로 적용돼요.

서로 다른 alias를 가진 ref들은 self-join에 그대로 조합할 수 있어요:

```typescript
const E = em.ref(Employee, "e");
const M = em.ref(Employee, "m");

sql`
  SELECT ${E.name}, ${M.as("name", "managerName")}
  FROM ${E}
  INNER JOIN ${M} ON ${E.managerId} = ${M.id}
`;
```

### `em.aliasRef(name)` -- alias 전용

엔티티에 묶을 수 없는 CTE, derived table, 그 외의 구문에는 이걸 써요:

```typescript
const t = em.aliasRef("t");
sql`SELECT ${t.minDepth} FROM cte ${t}`;
// PostgreSQL: SELECT t."min_depth" FROM cte t
// MySQL:      SELECT t.`min_depth` FROM cte t
```

- `${ref}` -> 따옴표 없는 bare alias 이름 (`t`) -- `INNER JOIN cte t`에 그대로 들어가요
- `${ref.col}` -> `alias."col"`, `camelToSnakeCase` 적용 + dialect 따옴표

엔티티 테이블에는 `em.ref()`를, CTE 본문 안에서만 존재하는 컬럼 (`depth`, `path` 등)이나 엔티티가 뒷받침하지 않는 CTE / derived table에 조인할 때는 `em.aliasRef()`를 써요.

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

`Employee` 엔티티에서 각 직원이 매니저를 가리키는 `managerId`를 가진다고 가정해 볼게요. CEO부터 시작하는 전체 조직 트리를 가져오려면, 엔티티 컬럼은 `em.ref()`로, CTE 안에서만 존재하는 합성 `depth` 컬럼은 `em.aliasRef()`로 CTE 본문을 조립해요:

```typescript
import sql from "sql-template-tag";

const E = em.ref(Employee);            // base case -- alias 불필요
const Ec = em.ref(Employee, "e");      // recursive step -- self-join용 alias
const ot = em.aliasRef("ot");          // CTE alias; `depth`는 CTE 안에만 존재

const query = em.createQueryBuilder()
  .withRecursive("org_tree", sql`
    SELECT ${E.id}, ${E.name}, ${E.managerId}, 1 AS depth
    FROM ${E}
    WHERE ${E.managerId} IS NULL

    UNION ALL

    SELECT ${Ec.id}, ${Ec.name}, ${Ec.managerId}, ${ot.depth} + 1
    FROM ${Ec}
    INNER JOIN org_tree ${ot} ON ${Ec.managerId} = ${ot.id}
  `)
  .select("*")
  .from("org_tree")
  .orderBy([{ column: "depth", direction: "ASC" }])
  .build();

const orgChart = await em.query(query);
// [{ id: 1, name: "CEO", depth: 1 }, { id: 2, name: "VP Eng", depth: 2 }, ...]
```

dialect 따옴표는 자동으로 골라져요. PostgreSQL은 `"id"`, MySQL은 `` `id` ``로 나가고, `${ot}`는 따옴표 없는 bare alias `ot`로 렌더링돼서 `INNER JOIN org_tree ot`가 모든 지원 DB에서 파싱돼요. TypeScript에서 `Employee.managerId`를 리네임하면 SQL에도 그대로 반영돼요.

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

위의 [탈출구(escape hatch) 선택하기](#탈출구-escape-hatch-선택하기) 사다리에서 SelectQueryBuilder ↔ RawQueryBuilder 두 항목만 떼어 좁힌 비교예요.

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
