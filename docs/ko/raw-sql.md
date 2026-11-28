# Raw SQL & CTE

## Raw SQL이 필요한 이유

ORM의 `find()`, `save()`, `SelectQueryBuilder`로 대부분의 쿼리를 처리합니다. 하지만 SQL은 표현력이 풍부한 언어입니다. 그래서 엔티티 기반 API로는 표현하지 못하는 쿼리도 있습니다.

- 관계가 없는 서로 다른 테이블의 결과 합치기 (UNION)
- 조직도나 카테고리 트리 같은 계층 데이터 탐색 (recursive CTE)
- 행 사이의 순위 계산이나 누적 합계 (윈도 함수)
- 여러 엔티티에 복잡하게 걸치는 크로스 데이터베이스 분석

이런 경우에는 `RawQueryBuilder`를 사용하세요. SQL의 모든 기능을 쓰면서도 파라미터 바인딩과 조합 가능한 빌더 API의 도움을 그대로 받습니다. 파라미터 바인딩은 SQL 인젝션을 막습니다. 빌더 API를 쓰면 문자열을 이어 붙이지 않고 코드로 쿼리를 구성합니다.

트레이드오프는 분명합니다. 타입 안전한 `keyof T` 자동 완성은 잃습니다. 대신 SQL의 표현력을 모두 얻습니다. 테이블 이름과 컬럼 이름은 직접 따옴표로 감싸야 합니다(PostgreSQL은 `"double quotes"`, MySQL은 `` `backticks` ``). 다만 `em.createQueryBuilder()`로 빌더를 생성하면 ORM이 데이터베이스 종류를 자동으로 감지합니다.

## 탈출구(escape hatch) 선택하기

raw SQL을 쓰는 방법은 일부러 여러 단계로 나뉘어 있습니다. 쿼리가 까다로워질수록 한 단계씩 올라갑니다. 다만 쿼리가 요구하는 만큼만 올라가는 것이 원칙입니다. 단계가 올라갈 때마다 타입 안전성이나 자동 매핑 같은 구조를 조금 내주고 표현력을 조금 더 얻습니다.

| 단계 | 사용 시점 | 도구 |
|------|----------|------|
| 1. 가장 구조화됨 | 표준 CRUD, 필터링, 선언된 관계 기반 조인 | `SelectQueryBuilder` (`em.createQueryBuilder(Entity, alias)`) |
| 2. 분석용 구조화 SQL | 윈도 함수, percentile, 집계, CASE, JSON 경로. 엔티티 컬럼으로 타입 정보를 유지 | Expressions DSL (`Expressions.*`, [QueryDSL](./query-builder-querydsl.md) 참고) |
| 3. DSL로 표현하지 못하지만 엔티티 정보는 유지 | CTE, `WITH RECURSIVE`, 벤더 전용 연산자, 엔티티 컬럼을 참조하는 여러 빌더의 조합 | `sql` 템플릿 + `em.ref()` / `em.aliasRef()` + `RawQueryBuilder` |
| 4. 완전한 raw | 일회성 벤더 SQL, DSL로 표현하지 못하는 동적 식별자, 시스템 카탈로그, `EXPLAIN ANALYZE`, 엔티티 모델이 없는 모든 것 | `em.query(sql, params)` |

원칙은 이렇습니다. 1단계에서 시작하고 앞 단계로 정말 표현할 수 없을 때만 다음 단계로 올라갑니다. 곧바로 `em.query()`로 내려가면 파라미터 바인딩의 편의, NamingStrategy 역매핑, 다이얼렉트별 따옴표 처리를 모두 잃습니다. 그러면 이 기능을 모두 직접 다시 만들어야 합니다.

### 도구별 레퍼런스

| 도구 | 목적 | 식별자 escape | 값 바인딩 | 비고 |
|------|------|---------------|----------|------|
| `em.ref(Entity)` | 별칭 없는 테이블 참조 (`"issue"`), `${ref.id}` -> `"id"` | O (다이얼렉트 따옴표) | 해당 없음 | `@Column` 이름 변경, 외래 키 속성, snake_case를 자동으로 해석합니다. 멀티테넌트 테이블 한정도 자동으로 적용합니다. |
| `em.ref(Entity, alias)` | FROM과 JOIN용 테이블과 별칭 (`"issue" AS i`), `${ref.id}` -> `i."id"` | O (다이얼렉트 따옴표) | 해당 없음 | 같은 엔티티에 다른 별칭을 주면 self-join을 구성할 수 있습니다. |
| `em.aliasRef(name)` | CTE와 파생 테이블용 별칭 전용 컬럼 (`${ref.depth}` -> `t."depth"`) | O (다이얼렉트 따옴표) | 해당 없음 | 엔티티가 없고 CTE 본문에만 있는 컬럼에 사용합니다. |
| `em.refs(...specs)` | `ref()`와 `aliasRef()`를 한 줄로 묶어 타입 있는 튜플로 반환. self-join이나 여러 CTE 블록의 보일러플레이트를 없앰 | `ref`와 `aliasRef`를 따름 | 해당 없음 | spec 형태: `Entity`, `[Entity, alias] as const`, `"alias"` |
| `sql\`…\`` (`sql-template-tag`) | SQL 조각 조합, 값 자동 파라미터화 | 해당 없음 | O. 모든 `${value}`가 플레이스홀더 | 편의를 위해 `@stingerloom/orm`에서 다시 export합니다. |
| `raw(str)` (`sql-template-tag`) | 문자열을 SQL에 그대로 끼워 넣음 (따옴표 처리와 바인딩 없음) | X | X | 사용자 입력을 `raw()`로 보간하지 마세요. 이미 신뢰하는 식별자 문자열에만 사용합니다. |
| `em.query\`…\`` (tagged form) | 짧은 raw 쿼리용 단축 형태. `${Entity}`는 `em.ref(Entity)`로 자동 해석하고 그 밖의 `${value}`는 바인딩 | `${Entity}`만 O. 템플릿 안의 컬럼 이름은 평문 | O. 엔티티가 아닌 모든 `${value}`가 플레이스홀더 | 명시적인 `ref()` 보일러플레이트를 없앱니다. 컬럼 이름의 오타는 컴파일할 때 잡히지 않습니다. 컬럼 안전성이 필요하면 한 단계 내려가 `em.ref(Entity).column`을 쓰세요. |
| `em.query(sqlOrText, params?)` | 미리 만든 `Sql` 조각이나 raw 문자열을 위치 파라미터와 함께 실행 | 해당 없음 | `Sql` 객체나 `(text, params)` 튜플이면 O | 드라이버의 raw 행을 반환합니다. NamingStrategy 역매핑이나 하이드레이트는 없습니다. |
| `em.query(shape)\`…\`` / `em.query(shape, sqlOrText, params?)` | `defineRow()` shape로 결과 행을 읽음 | 태그드 형태, 일반 형태와 같음 | 태그드 형태, 일반 형태와 같음 | 행에 shape의 타입이 붙습니다. 선언한 컬럼은 타입대로 변환됩니다(SQLite의 `Date`, JSON 파싱, boolean, 숫자 문자열 → 숫자). 엔티티 매핑이나 등록은 필요하지 않습니다. [Raw 쿼리 결과에 타입 붙이기](./row-shapes.md) 참고. |

#### 안전 계약(safety contract)

- `em.ref()`와 `em.aliasRef()`는 모든 식별자를 활성 드라이버의 `wrap()`으로 감쌉니다. 그래서 이 헬퍼로는 따옴표 없는 SQL이 실수로 만들어지지 않습니다.
- `sql\`…\``는 모든 `${value}`를 파라미터로 바인딩합니다. 사용자 문자열을 여기에 보간해도 안전합니다.
- `raw(str)`는 문자열을 그대로 끼워 넣습니다. SQL을 직접 쓰는 것과 같다고 보세요. 문자열이 사용자 입력이라면 `raw()`에 넘기기 전에 직접 허용 목록(allowlist)으로 검증하세요(예: `column ∈ knownColumns`).
- `em.query(text, params)`는 `params`를 바인딩합니다. 하지만 `text`는 escape하지 않습니다. 같은 원칙이 적용됩니다. text에는 값만 넣고 식별자는 절대 보간하지 마세요.

### 단계별로 올라가는 예제

게시글과 사용자가 있는 블로그를 예로 듭니다. 활성 사용자 목록에서 시작해 역할별로 게시된 글 수가 많은 상위 3명의 순위까지 한 단계씩 올라갑니다.

#### 1단계: `SelectQueryBuilder`

활성 사용자를 이름 순으로 정렬해서 조회합니다. 모든 부분이 `keyof T`로 타입 안전하고 SQL은 한 줄도 쓰지 않습니다.

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .where({ isActive: true })
  .orderBy({ name: "ASC" })
  .limit(50)
  .getMany();
```

#### 2단계: Expressions DSL

같은 목록을 `role`로 묶고 행마다 게시된 글 수를 붙입니다. 엔티티 정보는 여전히 유지됩니다. 조인한 관계와 집계 모두 엔티티 컬럼으로 표현됩니다.

```typescript
import { qAlias } from "@stingerloom/orm";

const u = qAlias(User, "u");
const p = qAlias(Post, "p");
const postCount = p.id.count();

const rows = await em
  .createQueryBuilder(User, "u")
  .leftJoin(Post, "p", (join) =>
    join.on(p.col("authorId"), "=", u.col("id")).onVal(p.col("isPublished"), "=", true),
  )
  .select(["role"])
  .addSelect(postCount.as("postCount"))
  .where(u.isActive.eq(true))
  .groupBy(["u.role"])
  .getRawMany<{ role: string; postCount: number }>();
```

`p.id.count()` 같은 집계는 다이얼렉트에 맞는 SQL을 렌더링하면서도 엔티티 속성 경로를 유지합니다. `p.id`는 `@Column`과 NamingStrategy로 자동 해석됩니다. 그래서 `"p"."id"`를 직접 쓸 필요가 없습니다.

#### 3단계: `sql` 템플릿 + `em.ref()`

역할별 상위 3명은 파생 테이블 위의 윈도 함수 없이는 DSL로 깔끔하게 표현하기 어렵습니다. 역할 안에서 사용자의 순위를 매기는 CTE를 만들고 rank <= 3으로 걸러야 합니다. 그런데 이 CTE도 실제 엔티티 컬럼(`User.id`, `User.role`)을 참조합니다. 그래서 `em.ref()`와 `em.aliasRef()`를 써서 이름을 바꿔도 깨지지 않게 합니다.

```typescript
import sql from "sql-template-tag";

const U = em.ref(User, "u");
const P = em.ref(Post, "p");
const r = em.aliasRef("r");                      // CTE 별칭. `postCount`와 `rank`는 CTE 안에만 존재

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

TypeScript에서 `User.role`의 이름을 바꾸면 CTE 본문과 바깥 쿼리 양쪽에 그대로 반영됩니다. `"role"`과 `` `role` `` 중 어느 따옴표를 쓸지도 다이얼렉트에 따라 자동으로 선택됩니다.

#### 4단계: `em.query()` (완전 raw)

위 쿼리의 `EXPLAIN ANALYZE`나 다이얼렉트마다 다른 통계 뷰를 동적으로 가리키는 작업에는 대응하는 DSL 모델이 없습니다. 이때는 `em.query()`로 내려가 SQL을 직접 씁니다. 값은 여전히 파라미터로 바인딩됩니다. 하지만 식별자는 직접 작성합니다.

```typescript
import sql from "sql-template-tag";

const plan = await em.query(sql`
  EXPLAIN ANALYZE
  SELECT count(*) FROM "posts" WHERE "is_published" = ${true}
`);
```

이 단계에서 테이블 이름이나 컬럼 이름이 사용자 입력에서 온다면 반드시 허용 목록으로 검증한 뒤 보간하세요. 이 단계에서는 자동 escape가 없습니다.

## 시작하기

인자 없이 `em.createQueryBuilder()`를 호출하면 RawQueryBuilder가 생성됩니다. 메서드를 체이닝한 뒤 `build()`를 호출해 SQL을 얻습니다. 그다음 `em.query()`로 실행합니다.

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

RawQueryBuilder의 `where()` 메서드는 조건의 배열을 받아 AND로 결합합니다. 값은 항상 `sql-template-tag`로 파라미터 바인딩됩니다. SQL 문자열에 값을 직접 이어 붙이는 일은 없습니다.

## 타입 참조 (Typed References)

`'"users"."id"'` 같은 따옴표 문자열을 직접 적으면 코드가 금방 지저분해집니다. 그리고 컬럼 이름을 바꾸면 이 문자열은 아무 경고 없이 깨집니다. 아래 두 헬퍼는 엔티티 클래스나 별칭 이름에서 `sql` 태그와 호환되는 프록시를 반환합니다. 이 프록시가 다이얼렉트에 맞는 SQL 조각을 자동으로 만듭니다. 그래서 같은 코드가 PostgreSQL, MySQL, SQLite에서 그대로 동작합니다.

### `em.ref(Entity, alias?)`: 엔티티 바인딩

```typescript
import sql from "sql-template-tag";

const U = em.ref(User, "u");

const rows = await em.query(sql`
  SELECT ${U.id}, ${U.email}
  FROM ${U}
  WHERE ${U.isActive} = ${true}
`);
// PostgreSQL: SELECT u."id", u."email" FROM "user" AS u WHERE u."is_active" = ?
// MySQL:      SELECT u.`id`, u.`email` FROM `user` AS u WHERE u.`is_active` = ?
```

| 보간 | 별칭 `"u"` 있음 | 별칭 없음 |
|------|-----------------|-----------|
| `${ref}` | `"user" AS u` (FROM과 JOIN에 바로 사용) | `"user"` |
| `${ref.id}` | `u."id"` | `"id"` |
| `${ref.as("createdAt")}` | `u."created_at" AS "createdAt"` | `"created_at" AS "createdAt"` |

속성 이름은 다음 순서로 해석됩니다.

1. `@Column` 메타데이터입니다. 그래서 컬럼 이름을 바꿔도 SQL이 따라갑니다.
2. 관계의 외래 키 속성입니다. 예를 들어 `parent!: Issue` 관계의 `parentId`는 `@Column` 없이도 외래 키 컬럼으로 해석됩니다.
3. 둘 다 아니면 `camelToSnakeCase`로 넘어갑니다.

테넌트에 맞는 테이블 한정도 자동으로 적용됩니다.

별칭이 다른 ref는 self-join에 그대로 조합할 수 있습니다.

```typescript
const E = em.ref(Employee, "e");
const M = em.ref(Employee, "m");

sql`
  SELECT ${E.name}, ${M.as("name", "managerName")}
  FROM ${E}
  INNER JOIN ${M} ON ${E.managerId} = ${M.id}
`;
```

### `em.aliasRef(name)`: 별칭 전용

엔티티에 묶을 수 없는 CTE, 파생 테이블, 그 밖의 SQL 구조에는 이 헬퍼를 씁니다.

```typescript
const t = em.aliasRef("t");
sql`SELECT ${t.minDepth} FROM cte ${t}`;
// PostgreSQL: SELECT t."min_depth" FROM cte t
// MySQL:      SELECT t.`min_depth` FROM cte t
```

- `${ref}` -> 따옴표 없는 별칭 이름(`t`). `INNER JOIN cte t`에 그대로 들어갑니다.
- `${ref.col}` -> `alias."col"`. `camelToSnakeCase`와 다이얼렉트 따옴표를 적용합니다.

엔티티 테이블에는 `em.ref()`를 쓰세요. CTE 본문 안에만 있는 컬럼(`depth`, `path` 등)을 쓰거나 엔티티가 없는 CTE나 파생 테이블에 조인할 때는 `em.aliasRef()`를 쓰세요.

### `em.refs(...specs)`: 일괄 변형

쿼리 하나에 ref가 서너 개 필요할 때 매번 한 줄씩 선언하면 코드가 반복됩니다. 재귀 CTE에서 엔티티를 자기 자신과 self-join하면서 CTE 별칭도 참조하는 경우가 전형적입니다. `em.refs(...)`는 `ref()`나 `aliasRef()`와 같은 형태의 인자를 받아 타입 있는 튜플을 반환합니다.

```typescript
const [I, Ic, p] = em.refs(Issue, [Issue, "c"] as const, "p");

// 다음과 같음:
//   const I  = em.ref(Issue);
//   const Ic = em.ref(Issue, "c");
//   const p  = em.aliasRef("p");
```

spec 형태는 다음과 같습니다.

- `Entity` -> `em.ref(Entity)` (`SqlRef<Entity>`)
- `[Entity, "alias"] as const` -> `em.ref(Entity, "alias")` (`SqlRef<Entity>`)
- `"alias"` -> `em.aliasRef("alias")` (`AliasRef`)

튜플 형태에는 `as const`가 필요합니다. 그래야 TypeScript가 별칭을 리터럴 문자열 타입으로 좁히고 구조 분해에 알맞은 요소 타입을 전파합니다.

### `em.query\`…\``: 짧은 raw 쿼리용 태그드 템플릿

일회성 raw 쿼리에서는 ref를 명시적으로 만드는 일이 번거로운 보일러플레이트입니다. 이런 경우를 위해 `em.query`는 태그드 템플릿도 받습니다.

```typescript
const rows = await em.query<{ count: string }>`
  SELECT COUNT(*) AS count FROM ${Issue} WHERE status = ${"open"}
`;
```

템플릿 안의 값은 다음과 같이 처리됩니다.

- `@Entity()`가 붙은 클래스인 `${Entity}`는 `em.ref(Entity)`로 해석됩니다. 테이블 이름을 따옴표로 감싸고 snake_case를 적용합니다. 테넌트 한정도 자동으로 붙입니다.
- `${ref}`, `${ref.col}`, 중첩된 `sql\`…\`` 조각은 그대로 통과합니다.
- 그 밖의 모든 `${value}`는 prepared statement 파라미터로 바인딩됩니다.

트레이드오프: 템플릿 안의 컬럼 이름은 평문입니다(위 예제의 `status`). 여기서 오타가 나면 컴파일할 때가 아니라 런타임에 SQL 에러로 드러납니다. 이것이 중요하다면 한 단계 내려가 `em.ref(Entity).column`을 쓰세요. 이 형태에서는 속성 이름을 엔티티 속성과 대조해 검증합니다.

```typescript
const r = em.ref(Issue);
const rows = await em.query<{ count: string }>`
  SELECT COUNT(*) AS count FROM ${r} WHERE ${r.status} = ${"open"}
`;
```

태그드 형태는 의도적으로 4단계를 위한 단축 형태입니다. WHERE, JOIN, CTE를 조합해 조립해야 하는 3단계의 `RawQueryBuilder`를 대체하지 않습니다. NamingStrategy 역매핑과 결과 하이드레이트도 여전히 적용되지 않습니다. 드라이버의 raw 행을 그대로 받습니다.

위 예제에서 `{ count: string }`으로 적은 데는 이유가 있습니다. PostgreSQL은 `COUNT(*)`를 문자열로 반환하기 때문입니다. 엔티티를 매핑하지 않고 타입과 변환을 함께 받으려면 타입 인자 대신 [row shape](./row-shapes.md)를 넘기세요.

```typescript
const Count = defineRow({ count: t.int() });
const [{ count }] = await em.query(Count)`
  SELECT COUNT(*) AS count FROM ${Issue} WHERE status = ${"open"}
`;
// 어느 드라이버에서든 count는 number
```

## WHERE, JOIN, 서브쿼리

RawQueryBuilder는 SelectQueryBuilder와 같은 WHERE 헬퍼를 제공합니다. `andWhere()`, `orWhere()`, `whereIn()`, `whereNull()`, `whereBetween()` 등이 있습니다. 차이는 컬럼 이름이 타입 안전하지 않은 raw 문자열이라는 점입니다.

JOIN도 같은 방식으로 동작합니다.

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

서브쿼리에는 빌더의 `asInQuery()`, `asExists()`, `as()`를 씁니다. 이 메서드로 쿼리 하나를 다른 쿼리 안에 넣습니다.

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

## 집합 연산: UNION, INTERSECT, EXCEPT

완전히 다른 쿼리의 결과를 합쳐야 할 때가 있습니다. 예를 들어 직원과 계약직을 목록 하나로 합치는 경우입니다.

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

`union()`을 호출하면 UNION의 두 번째 부분이 될 새 SELECT가 시작됩니다. 결과에는 양쪽 쿼리의 행이 들어가고 중복은 제거됩니다.

집합 연산(set operation)은 네 가지를 지원합니다.

| Method | SQL | 설명 |
|--------|-----|------|
| `union()` | `UNION` | 두 결과 집합을 합치고 중복 제거 |
| `unionAll()` | `UNION ALL` | 두 결과 집합을 합치고 중복 유지 (더 빠름) |
| `intersect()` | `INTERSECT` | 양쪽 결과 집합에 모두 있는 행만 반환 |
| `except()` | `EXCEPT` | 첫 번째 집합에만 있고 두 번째에는 없는 행 반환 |

실용 예제로 users 테이블에는 있지만 unsubscribed 테이블에는 없는 이메일 주소를 찾습니다.

```typescript
const query = em.createQueryBuilder()
  .select(['"email"']).from('"users"')
  .except()
  .select(['"email"']).from('"unsubscribed"')
  .build();

const subscribedEmails = await em.query(query);
```

## CTE (공통 테이블 표현식)

### CTE가 필요한 이유

CTE는 서브쿼리에 이름을 붙여 변수처럼 저장하는 것과 같습니다. 일반 프로그래밍에서는 50줄짜리 표현식을 인라인으로 쓰지 않고 이름 있는 변수로 나눕니다. CTE는 SQL에서 이 역할을 합니다.

CTE가 없으면 서브쿼리 안에 서브쿼리를 중첩하게 되고 쿼리가 금방 읽기 어려워집니다. CTE를 쓰면 각 단계를 이름 있는 블록으로 정의한 다음 조합할 수 있습니다. 데이터베이스는 블록을 순서대로 실행합니다. 그리고 각 단계에서 이전 단계를 참조할 수 있습니다.

개념은 다음과 같습니다.

```
// Pseudocode
const activeUsers = SELECT id, name FROM users WHERE is_active = true;
const result = SELECT * FROM activeUsers;
```

SQL로 쓰면 다음과 같습니다.

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

`with()` 메서드는 이름과 함께 `Sql` 객체나 콜백을 받습니다. 콜백에는 새 `RawQueryBuilder`가 전달됩니다. CTE 결과는 메인 쿼리의 FROM 절에서 일반 테이블처럼 참조할 수 있습니다.

### 재귀 CTE

조직도, 카테고리 트리, 스레드 댓글처럼 본래 계층 구조인 데이터가 있습니다. **Recursive CTE**를 사용하면 단계마다 쿼리를 보내지 않고 쿼리 하나로 계층 구조를 탐색할 수 있습니다.

`Employee` 엔티티에서 각 직원이 매니저를 가리키는 `managerId`를 가진다고 가정합니다. CEO부터 시작하는 전체 조직 트리를 조회하려면 CTE 본문을 다음과 같이 조립합니다. 엔티티 컬럼은 `em.ref()`로 참조합니다. CTE 안에만 있는 합성 컬럼 `depth`는 `em.aliasRef()`로 참조합니다.

```typescript
import sql from "sql-template-tag";

const E = em.ref(Employee);            // base case: 별칭이 필요 없음
const Ec = em.ref(Employee, "e");      // recursive step: self-join용 별칭
const ot = em.aliasRef("ot");          // CTE 별칭. `depth`는 CTE 안에만 존재

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

다이얼렉트 따옴표는 자동으로 선택됩니다. PostgreSQL에서는 `"id"`, MySQL에서는 `` `id` ``가 됩니다. `${ot}`는 따옴표 없는 별칭 `ot`로 렌더링됩니다. 그래서 `INNER JOIN org_tree ot`는 지원하는 모든 데이터베이스에서 파싱됩니다. TypeScript에서 `Employee.managerId`의 이름을 바꾸면 SQL에도 그대로 반영됩니다.

Recursive CTE는 `UNION ALL`로 결합한 두 부분으로 구성됩니다.

1. **Base case**: 시작 행입니다(매니저가 없는 직원인 CEO).
2. **Recursive step**: CTE 결과를 원래 테이블에 다시 조인해서 하위 항목을 찾습니다.

데이터베이스는 새 행이 더 이상 생기지 않을 때까지 recursive step을 반복해서 실행합니다. 반복할 때마다 트리에서 한 단계 더 깊이 들어갑니다.

## 윈도 함수

### 윈도 함수가 필요한 이유

부서별로 직원의 급여 순위를 매기려 한다고 가정합니다. GROUP BY를 쓰면 한 부서의 모든 직원이 행 하나로 합쳐집니다. 그래서 개별 직원의 데이터가 사라집니다. 윈도 함수(window function)는 모든 행을 유지하면서 계산한 값을 옆에 추가합니다.

GROUP BY는 블렌더와 같습니다. 그룹마다 모든 것이 결과 하나로 합쳐집니다. 윈도 함수는 각 행 옆에 놓인 계산기와 같습니다. 이 계산기는 창(window)으로 관련 행을 보고 아무것도 바꾸지 않은 채 답을 적어 둡니다.

### 사용법

전형적인 예는 순위 매기기입니다. 아래는 부서별로 급여 순위를 매기는 예제입니다.

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

`selectWithWindow()` 배열의 각 요소는 평범한 컬럼 문자열이거나 윈도 함수를 설명하는 객체입니다.

- `expr`: 적용할 함수 (`ROW_NUMBER()`, `RANK()`, `SUM(salary)` 등)
- `over.partitionBy`: 그룹을 나눌 컬럼. GROUP BY와 비슷하지만 행을 합치지 않습니다.
- `over.orderBy`: 각 그룹 안의 정렬 순서
- `alias`: 계산된 컬럼의 이름

자주 쓰는 윈도 함수는 다음과 같습니다.

| Function | 설명 | 예시 |
|----------|------|------|
| `ROW_NUMBER()` | 파티션 내 순차 번호 | 그룹 내 페이지네이션 |
| `RANK()` | 동점 시 건너뛰는 순위 (1, 2, 2, 4) | 리더보드 |
| `DENSE_RANK()` | 동점 시 건너뛰지 않는 순위 (1, 2, 2, 3) | 카테고리별 Top-N |
| `SUM(col)` | 파티션 내 누적 합계 | 누적 매출 |
| `AVG(col)` | 이동 평균 | Moving average |
| `LAG(col)` | 이전 행의 값 | 전일 대비 비교 |
| `LEAD(col)` | 다음 행의 값 | 예측 |

실용 예제로 월별 누적 매출을 계산합니다.

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

`partitionBy`를 생략하면 윈도가 전체 결과 집합에 걸칩니다. 그래서 합계가 그룹별이 아니라 모든 행에 걸쳐 누적됩니다.

## DISTINCT: 중복 제거

RawQueryBuilder는 DISTINCT 변형도 지원합니다.

```typescript
// SELECT DISTINCT
qb.selectDistinct(['"city"', '"country"']).from('"users"');

// DISTINCT ON (PostgreSQL only) -- keep only the first row per group
qb.selectDistinctOn(['"department"'], ['"id"', '"name"', '"salary"'])
  .from('"employees"');
// SELECT DISTINCT ON ("department") "id", "name", "salary" FROM "employees"
```

`DISTINCT ON`은 PostgreSQL 전용 확장입니다. 지정한 컬럼의 고유한 값마다 행 하나만 반환합니다. GROUP BY와 비슷하지만 남길 행을 고를 수 있습니다. 남길 행은 ORDER BY로 결정합니다.

## 두 빌더 중 선택하기

위의 [탈출구(escape hatch) 선택하기](#탈출구-escape-hatch-선택하기) 단계 중 SelectQueryBuilder와 RawQueryBuilder 두 항목만 비교하면 다음과 같습니다.

| 질문 | SelectQueryBuilder | RawQueryBuilder |
|------|-------------------|----------------|
| 등록된 엔티티를 쿼리하나요? | Yes | 필수 아님 |
| `keyof T` 자동완성이 필요한가요? | Yes | No |
| UNION / INTERSECT / EXCEPT가 필요한가요? | No | Yes |
| CTE (WITH / WITH RECURSIVE)가 필요한가요? | No | Yes |
| 윈도 함수가 필요한가요? | No | Yes |
| 클래스 인스턴스를 반환하나요? | `getMany()` yes / `getPartialMany()` no | No. `em.query()`로 raw 객체 반환 |

실무에서는 일상적인 쿼리를 `SelectQueryBuilder`로 시작하세요. UNION, 재귀 계층 탐색, 윈도 분석이 필요해서 한계에 부딪히면 그 쿼리에만 `RawQueryBuilder`를 쓰면 됩니다.

## 다음 단계

- [Raw 쿼리 결과에 타입 붙이기](./row-shapes.md): `defineRow()`로 엔티티 없이 raw SQL 결과에 타입과 변환 적용
- [Query Builder](./query-builder.md): `keyof T` 자동 완성을 지원하는 타입 안전한 SelectQueryBuilder
- [EntityManager](./entity-manager.md): find(), save() 등을 쓰는 기본 CRUD
- [API Reference](./api-reference.md): 모든 메서드 시그니처의 빠른 참조
