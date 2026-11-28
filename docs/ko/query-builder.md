# 쿼리 빌더

`find()`와 `findOne()`만으로 해결되는 쿼리가 생각보다 많습니다. 조건으로 거르기, 관계 함께 로드하기, 페이지네이션 같은 일상적인 작업은 대부분 이 두 메서드로 충분합니다.

그런데 이 메서드로는 부족할 때가 있습니다.

- 직접 관계가 없는 두 테이블을 이어야 할 때
- 카테고리별로 행 수를 세고 "5개 이상인 것만" 같은 조건을 걸어야 할 때
- 서로 다른 테이블의 결과를 UNION으로 합쳐야 할 때

이럴 때 쓰는 것이 **쿼리 빌더**입니다.

Stingerloom은 쿼리 빌더를 두 가지 제공합니다. 선택 기준은 단순합니다.

| 빌더 | 언제 쓰나 | 만드는 법 |
|------|----------|-----------|
| **SelectQueryBuilder** | 엔티티를 대상으로 쿼리하면서 컬럼 이름 자동 완성이 필요할 때 | `em.createQueryBuilder(User, "u")` |
| **RawQueryBuilder** | SQL을 직접 제어해야 할 때: UNION, CTE, 윈도 함수 | `em.createQueryBuilder()` (인자 없이) |

대부분은 `SelectQueryBuilder`를 씁니다.

빌더 만들기, `WHERE`로 거르기, 조건 엮기 같은 기본기는 이 페이지에 있습니다. 더 깊은 주제는 주제마다 별도 페이지에 있습니다.

| 주제 | 페이지 |
|------|--------|
| JOIN: 엔티티 인식 / 관계 기반 / 멀티 테이블 | [JOIN](./query-builder-joins.md) |
| `qAlias()`: 타입 안전 표현식, 집계, CASE, 날짜 컴포넌트, 윈도 함수 | [QueryDSL 표현식](./query-builder-querydsl.md) |
| JSON / JSONB 컬럼 탐색 | [JSON 컬럼 탐색](./query-builder-json.md) |
| `GROUP BY`, `HAVING`, 서브쿼리, `DISTINCT`, CTE | [집계 & 서브쿼리](./query-builder-aggregations.md) |
| 페이지네이션, 잠금, 인덱스 힌트, `validate()`, 실행, `prepare()` | [실행 & 결과](./query-builder-execution.md) |
| `when()`, `pipe()`, `whereHas()`, `withCount()`, scope | [편의 패턴](./query-builder-patterns.md) |
| `UPDATE … ORDER BY … LIMIT`: `createUpdateBuilder` | [UpdateQueryBuilder](#updatequerybuilder-타입-안전한-update-order-by-limit) |
| `INSERT … ON CONFLICT` 표현식: `createInsertBuilder` | [InsertQueryBuilder](#insertquerybuilder-표현식-기반-on-conflict) |
| UNION, 재귀 CTE, 윈도 함수: `RawQueryBuilder` | [Raw SQL & CTE](./raw-sql.md) |

---

## SelectQueryBuilder: 타입이 있는 쿼리

### 쿼리 빌더가 필요한 이유

본론에 앞서 짚어 볼 질문이 있습니다. 모든 쿼리를 `find()`로 처리하면 안 될까요?

`find()`로 표현할 수 없는 쿼리가 있기 때문입니다. `find()`는 `WHERE field = value`나 `{ age: { gte: 18 } }` 같은 연산자 조건을 만들 수 있습니다. 하지만 관계가 없는 테이블을 조인하거나 `GROUP BY` 그룹마다 `COUNT(*)` 같은 집계 값을 반환할 수는 없습니다. 이런 쿼리에는 쿼리 빌더가 필요합니다.

Stingerloom의 쿼리 빌더는 보장하는 안전성 수준이 서로 다른 실행 메서드를 세 가지 제공합니다.

**`getMany()`**: 항상 클래스 인스턴스를 반환합니다. 그래서 `instanceof`가 동작하고 엔티티에 정의한 메서드를 바로 쓸 수 있습니다. 결과를 `em.save()`에 그대로 넘길 수도 있습니다. `select()`로 일부 컬럼만 조회할 때는 not-null 컬럼이 모두 포함됐는지도 검증합니다.

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .where("isActive", true)
  .getMany();

users[0] instanceof User;        // ✓ true: 실제 클래스 인스턴스입니다
await em.save(User, users[0]);   // ✓ 기대한 대로 동작합니다
```

**`getPartialMany()`**: `Pick<T, K>`로 좁혀진 타입이 있는 plain object를 반환합니다. 선택하지 않은 컬럼에 접근하면 컴파일 에러가 납니다. 대신 not-null 컬럼 검증은 하지 않습니다.

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name"])
  .getPartialMany();

users[0].id;    // ✓ number: Pick<User, "id" | "name">에 포함
users[0].name;  // ✓ string: 포함
users[0].email; // ✗ 컴파일 에러: 'email' 속성 없음
```

**`getRawMany()`**: 타입이 없는 plain object(`Record<string, unknown>`)를 반환합니다. `addSelect(sql`COUNT(*)`, "cnt")`처럼 엔티티에 없는 계산 컬럼이 섞인 쿼리에 씁니다.

`where()`와 `orderBy()`는 항상 엔티티의 모든 컬럼을 받습니다. SELECT하지 않은 컬럼으로도 거르고 정렬할 수 있어야 하기 때문입니다. 타입 시스템은 반환하는 행의 모양(projection)과 쿼리 대상 엔티티(entity)를 따로 추적합니다.

메서드별 보장과 상황에 맞는 메서드 고르기는 [실행 & 결과 → 쿼리 실행하기](./query-builder-execution.md#쿼리-실행하기)를 참고하세요.

### 첫 쿼리 빌더 쿼리

활성 사용자를 등록일 내림차순으로 정렬해서 `id`, `name`, `email`만 조회한다고 해 보겠습니다. `find()`로는 다음과 같이 씁니다.

```typescript
const users = await em.find(User, {
  select: ["id", "name", "email"],
  where: { isActive: true },
  orderBy: { createdAt: "DESC" },
  take: 10,
});
```

쿼리 빌더로는 다음과 같습니다.

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name", "email"])
  .where("isActive", true)
  .orderBy({ createdAt: "DESC" })
  .limit(10)
  .getPartialMany();
```

여기까지는 크게 다르지 않습니다. 쿼리 빌더의 장점은 `find()`로 표현할 수 없는 기능이 필요할 때 드러납니다. 관계가 없는 테이블과의 JOIN, 그룹별 집계 값이 그 예입니다.

`createQueryBuilder(User, "u")`의 두 번째 인자 `"u"`는 **테이블 별칭**입니다. 생성된 SQL에서 컬럼 앞에 붙는 짧은 이름이며 `"u"."id"`, `"u"."name"`처럼 쓰입니다. 별칭이 왜 중요한지는 JOIN에서 드러납니다.

> 참고: `userRepo.createQueryBuilder("u")`처럼 리포지토리에서도 쿼리 빌더를 만들 수 있습니다. 동작은 같습니다.

### WHERE: 행 거르기

`where()`는 조건의 복잡도에 따라 네 가지 형태를 받습니다.

**Equals**: 가장 단순한 형태입니다. 컬럼과 값만 넘기면 됩니다.

```typescript
qb.where("status", "active");
// WHERE "u"."status" = $1
```

**Operator**: `>=`, `<`, `LIKE` 같은 연산자가 필요할 때 씁니다. 두 번째 인자로 연산자를 넘깁니다. 연산자도 타입 검사를 거치므로 `"LKIE"` 같은 오타는 컴파일 단계에서 잡힙니다.

```typescript
qb.where("age", ">=", 18);
// WHERE "u"."age" >= $1

// 허용되는 연산자:
// =, !=, <>, <, >, <=, >=, LIKE, NOT LIKE, ILIKE, IN, NOT IN,
// IS NULL, IS NOT NULL, BETWEEN
```

**Raw SQL**: ORM으로 표현할 수 없는 조건에 씁니다. `sql` 템플릿 리터럴을 그대로 넘깁니다.

```typescript
import sql from "sql-template-tag";

qb.where(sql`"u"."score" > ${90}`);
```

**필터 객체**: `em.find({ where })`에서 쓰던 Prisma 스타일 `WhereClause` 객체를 그대로 넘깁니다.
그래서 필터를 튜플로 다시 쓰지 않고 `find()`와 쿼리 빌더에서 함께 쓸 수 있습니다.
키는 AND로 묶입니다. 값으로는 리터럴, 연산자 객체(`{ gte, lt, in, contains, … }`), `null`(→ `IS NULL`), 배열(→ `IN`)을 쓸 수 있습니다.
`OR` / `AND` / `NOT` 조합자도 동작합니다. 그리고 조건 객체의 배열을 넘기면 각 조건이 OR로 묶입니다.

```typescript
qb.where({
  status: "active",
  age: { gte: 18, lt: 65 },
  role: { in: ["admin", "editor"] },
  name: { contains: "ali" },          // LIKE '%ali%' (와일드카드 이스케이프됨)
  OR: [{ role: "owner" }, { score: { gte: 90 } }],
});
// WHERE "u"."status" = $1 AND ("u"."age" >= $2 AND "u"."age" < $3)
//   AND "u"."role" IN ($4, $5) AND "u"."name" LIKE $6
//   AND ("u"."role" = $7 OR "u"."score" >= $8)

// 배열 형태 → 그룹들을 OR로 결합
qb.where([
  { status: "active", role: "admin" },
  { score: { gte: 90 } },
]);
// WHERE (("u"."status" = $1 AND "u"."role" = $2) OR "u"."score" >= $3)
```

`andWhere()` / `orWhere()`도 같은 필터 객체를 받습니다. 그리고 튜플 형태나 Raw SQL 형태와 자유롭게 섞어 쓸 수 있습니다.
컬럼 이름에는 빌더의 별칭이 붙고 `NamingStrategy`로 매핑됩니다. 이 동작은 `find()`와 같습니다.

컬럼 이름을 받는 형태는 모두 타입 안전합니다. `"age"`와 `"status"`는 `keyof User`에서 자동 완성됩니다.
필터 객체의 키도 엔티티를 기준으로 검사합니다. 그래서 오타는 컴파일 에러로 잡힙니다.

### 조건 엮기: AND와 OR

여러 조건은 `andWhere()`와 `orWhere()`로 잇습니다.

```typescript
const qb = em.createQueryBuilder(User, "u");

const users = await qb
  .where("isActive", true)
  .andWhere("age", ">=", 18)
  .getMany();
// WHERE "u"."is_active" = $1 AND "u"."age" >= $2
```

`orWhere()`는 기존 조건을 괄호로 묶고 OR 분기를 추가합니다.

```typescript
qb.where("isActive", true)
  .andWhere("age", ">=", 18)
  .orWhere("role", "admin");
// WHERE ("u"."is_active" = $1 AND "u"."age" >= $2) OR "u"."role" = $3
```

이 조건은 활성 상태이면서 18세 이상인 사용자이거나 나이와 관계없이 admin인 사용자를 뜻합니다.

`WHERE status = 'active' OR (role = 'admin' AND verified = true)`처럼 괄호 그룹이 필요하면 [`andWhereGroup()` / `orWhereGroup()`](./query-builder-patterns.md#그룹-조건-andwheregroup-orwheregroup)을 쓰세요.

### 자주 쓰는 WHERE 헬퍼

흔한 패턴에는 raw SQL 대신 내장 헬퍼를 쓰세요.

```typescript
// IN: 목록의 값 중 하나와 일치
qb.whereIn("status", ["active", "pending"]);

// NOT IN: 이 값들을 제외
qb.whereNotIn("id", [1, 2, 3]);

// NULL 검사
qb.whereNull("deletedAt");
qb.whereNotNull("email");

// BETWEEN: 범위
qb.whereBetween("age", 18, 65);

// LIKE: 패턴 매칭
qb.whereLike("name", "%alice%");
```

각 헬퍼는 기존 WHERE 절에 AND로 붙습니다. `where()` / `andWhere()`와 자유롭게 섞어 써도 됩니다.

모든 WHERE 메서드는 `"alias.property"` 형식의 크로스 엔티티 참조도 받습니다. 자세한 내용은 [JOIN 페이지의 크로스 엔티티 컬럼 해석](./query-builder-joins.md#크로스-엔티티-컬럼-해석)을 참고하세요.

---

## UpdateQueryBuilder: 타입 안전한 `UPDATE … ORDER BY … LIMIT`

`em.updateMany()`는 "WHERE에 맞는 모든 행을 갱신한다"는 일상적인 경우를 처리합니다. 하지만 그 이상이 필요한 패턴도 있습니다.

- 갱신할 행 수에 상한을 두고 싶을 때
- 상한을 적용하기 전에 행을 정해진 순서로 정렬하고 싶을 때
- SELECT에서 쓰던 `qAlias()` DSL로 조건을 표현하고 싶을 때

`createUpdateBuilder()`는 이런 경우에 씁니다.

대표적인 예가 워커 클레임 큐입니다. 여러 워커가 다음 대기 작업을 차지하려고 경쟁합니다. 이때 "조건에 맞는 행을 우선순위로 정렬한 뒤 최대 한 행만 갱신한다"는 원자적 작업이 필요합니다. MySQL/MariaDB에서는 `UPDATE … ORDER BY … LIMIT 1` SQL 문 하나로 끝납니다. 빌더가 없다면 `em.query(sql\`UPDATE …\`)`로 내려가야 하고 엔티티 메타데이터의 도움을 받지 못합니다.

### 빌더 만들기

만드는 형태는 두 가지이며 둘 다 `UpdateQueryBuilder<T>`를 반환합니다.

```typescript
import { qAlias } from "@stingerloom/orm";
import sql from "sql-template-tag";

// 형태 1: 엔티티 클래스 + 별칭(선택)
const builder = em.createUpdateBuilder(Issue, "i");

// 형태 2: qAlias() ref. WHERE / ORDER BY에서 같은 `i`를 그대로 재사용
const i = qAlias(Issue, "i");
const builder2 = em.createUpdateBuilder(i);
```

리포지토리 단축형도 있습니다. 모양은 같습니다. 그리고 이미 리포지토리를 주입받았다면 `EntityManager`를 따로 주입받을 필요가 없습니다.

```typescript
await issueRepo
  .createUpdateBuilder(i)
  .set({ claimedBy: workerId })
  .where(i.status.eq("TODO"))
  .orderBy(i.priority.asc())
  .limit(1)
  .execute();
```

### 워커 클레임 예제

```typescript
const i = qAlias(Issue, "i");

const { affected } = await em
  .createUpdateBuilder(i)
  .set({ claimedBy: workerId })
  .setRaw("claimedAt", sql`NOW()`)
  .where(i.projectId.eq(projectId))
  .andWhere(i.status.in(["BACKLOG", "TODO"]))
  .andWhere(i.assigneeId.isNull())
  .orderBy(i.priority.asc())
  .addOrderBy(i.number.asc())
  .limit(1)
  .execute();
// affected = 0 또는 1: InnoDB에서 원자적으로 실행
```

`set()`은 타입이 있는 객체(`UpdateData<T>`)를 받습니다. 각 값은 컬럼의 리터럴 값이거나 `Sql` 표현식입니다. `.set()`을 여러 번 호출하면 값이 누적되고 같은 컬럼에는 마지막 호출의 값이 적용됩니다. `setRaw()`는 컬럼 하나의 값만 raw SQL로 지정하고 싶을 때 쓰는 탈출구입니다. `NOW()`나 `view_count + 1` 같은 식에 유용합니다.

WHERE는 SELECT가 받는 모든 형태를 받습니다. `qAlias()` 표현식(`i.status.eq(...)`, `i.priority.lt(...)`), 조합 헬퍼(`exp.or(...)`, `exp.and(...)`), raw `sql\`...\`` 템플릿을 모두 쓸 수 있습니다. `where()`는 기존 조건을 초기화하고 `andWhere()` / `orWhere()`는 조건을 이어 붙입니다. `orderBy()` / `addOrderBy()`는 `qAlias()` 정렬 표현식(`i.priority.asc()`)이나 `(속성 키, "ASC" | "DESC")` 쌍을 받습니다.

### 다이얼렉트별 동작

`UPDATE … ORDER BY … LIMIT`은 데이터베이스마다 지원 여부가 다른 SQL입니다. 빌더가 차이를 가려 줍니다. 하지만 실제로 어떤 SQL이 실행되는지 알아 두면 좋습니다.

| 다이얼렉트 | 실제로 실행되는 SQL |
|------------|------------------|
| **MySQL / MariaDB** | 네이티브 `UPDATE t SET … WHERE … ORDER BY … LIMIT n` |
| **PostgreSQL / SQLite** | `UPDATE t SET … WHERE pk IN (SELECT pk FROM t WHERE … ORDER BY … LIMIT n)`로 재작성 |

`orderBy()`나 `limit()`을 설정하면 PostgreSQL/SQLite에서는 자동으로 재작성합니다. 다만 단일 컬럼 기본 키가 있어야 합니다. 복합 기본 키 엔티티는 이 경로에서 `UNSUPPORTED_OPERATION` 에러를 던집니다. MySQL이 아닌 환경에서 복합 기본 키 엔티티를 정렬하고 행 수를 제한해야 한다면 `RawQueryBuilder`로 서브쿼리를 직접 작성하세요. 네이티브 문법을 지원하는 MySQL/MariaDB를 쓰는 방법도 있습니다.

`orderBy()`도 `limit()`도 설정하지 않으면 모든 다이얼렉트에서 평범한 `UPDATE t SET … WHERE …`를 실행합니다. 이때 빌더는 `em.updateMany()`를 타입 있게 대신하는 방법이 됩니다.

### `updateMany`와 공유하는 동작

`execute()`는 EntityManager의 트랜잭션 래퍼 안에서 실행됩니다. 그래서 다음이 보장됩니다.

- **테넌트 범위**: 테넌트 범위 조건이 사용자의 WHERE와 AND로 묶입니다. 그래서 `UpdateQueryBuilder`로는 테넌트 경계를 넘을 수 없습니다.
- **`@UpdateTimestamp`**: 직접 설정하지 않았다면 값이 자동으로 들어갑니다.
- **`@Version` / 낙관적 잠금**: 적용되지 않습니다. 단일 엔티티 save가 아니라 벌크 DML이기 때문입니다. `em.updateMany()`와 마찬가지로 버전을 기록해야 하는 쓰기는 `em.save(entity)`로 하세요.

### `build()` / `toSql()`: 실행 없이 들여다보기

`build()`와 `toSql()`은 모두 파라미터화된 SQL을 반환합니다. 테스트, 로깅, 디버깅에 유용합니다. 테넌트 범위 조건은 여기서 적용되지 않고 execute 시점에 붙습니다. 그래서 결과 텍스트에는 테넌트 조건이 들어 있지 않습니다.

```typescript
const { text, values } = em
  .createUpdateBuilder(i)
  .set({ claimedBy: "w" })
  .where(i.projectId.eq(42))
  .orderBy(i.priority.desc())
  .limit(5)
  .toSql();
// text:  "UPDATE `issue` SET `claimedBy` = ? WHERE … ORDER BY `priority` DESC LIMIT 5"
// values: ["w", 42]
```

### WriteBuffer(Unit-of-Work)와의 관계

`UpdateQueryBuilder.execute()`는 벌크 DML이므로 바로 실행됩니다. 그리고 버퍼의 Identity Map과 변경 추적을 거치지 않습니다. `em.updateMany()`, `em.delete()`, `em.softDelete()`가 이미 이렇게 동작합니다. 이것은 의도된 설계입니다. 버퍼는 EntityManager를 직접 호출하는 코드를 가로채지 않습니다.

두 API를 섞어 쓸 때 알아 둘 점이 두 가지 있습니다.

- **빌더가 갱신하는 행을 버퍼가 이미 추적 중일 때**: 버퍼의 스냅샷이 오래된 값이 됩니다. `buf.refresh(instance)`로 DB에서 다시 조회하세요. 아니면 벌크 갱신 전에 미리 flush해서 메모리의 변경분이 덮어써지지 않게 하세요.
- **버퍼에서 벌크 갱신이 필요할 때**: `buf.updateMany()`를 쓰세요. 이 메서드는 UPDATE를 flush 시점까지 큐에 넣어 둡니다. 그리고 실행 후 WHERE에 맞는 추적 중인 인스턴스를 모두 자동으로 동기화합니다. 다만 `buf.updateMany()`는 단순한 `WHERE col = val` 형태만 받습니다. 버퍼 경로에서는 `ORDER BY` / `LIMIT`을 지원하지 않으므로 워커 클레임 패턴은 그대로 `em.createUpdateBuilder()`를 직접 호출합니다.

### 마주칠 수 있는 에러

- `INVALID_QUERY`: `.set()`을 호출하지 않고 `execute()`를 호출했거나 `.limit(n)`에 정수가 아닌 값이나 음수를 넘겼을 때.
- `DELETE_WITHOUT_CONDITIONS` (UPDATE도 같은 코드 사용): WHERE 없이 `execute()`를 호출했을 때. 테이블 전체를 갱신하는 것은 위험한 패턴이므로 막아 둡니다. 정말 필요하면 항상 참인 WHERE를 명시적으로 추가하세요.
- `UNSUPPORTED_OPERATION`: PostgreSQL / SQLite에서 복합 기본 키 엔티티에 `orderBy()` / `limit()`을 썼을 때.

---

## InsertQueryBuilder: 표현식 기반 `ON CONFLICT`

충돌이 나면 `em.upsert()`는 넘긴 컬럼을 제안한 값으로 덮어쓸 수만 있습니다(`col = EXCLUDED.col`). ORM이 직접 관리하는 `@Version` / `@UpdateTimestamp` / `@DeletedAt`만 예외입니다. 그래서 새 값을 저장된 값에서 계산해야 할 때는 이 형태로 표현할 수 없습니다. 카운터 누적, 최댓값 유지, 병합이 그런 경우입니다. 읽고 계산해서 다시 쓰는 라운드 트립은 동시성 아래에서 올바르게 동작하려면 행 잠금이 필요합니다.

`em.createInsertBuilder()`를 쓰면 QueryDSL 표현식 전체를 충돌 절에서 쓸 수 있습니다. 데이터베이스가 행을 잡고 있는 동안 계산하므로 별도의 잠금이 필요 없습니다.

```typescript
import { greatest, sql } from "@stingerloom/orm";

await em.createInsertBuilder(SyncMarker)
  .values(buckets)
  .onConflict(["mac", "bucketStart"])
  .doUpdate((t, ex) => ({
    records:  t.records.add(ex.records),          // 저장된 값 + 제안한 값
    lastTime: greatest(t.lastTime, ex.lastTime),  // 최댓값 유지
    syncedAt: sql`NOW()`,
  }))
  .execute();
```

`t`는 저장된 행을 가리키고 `ex`는 이 INSERT가 제안한 행을 가리킵니다. 둘 다 평범한 `qAlias` 프록시입니다. 그래서 [QueryDSL 표현식](./query-builder-querydsl.md) 페이지의 모든 표현식을 그대로 조합할 수 있습니다.

빌더는 다음 기능도 지원합니다.

- `doNothing()`
- `doUpdateWhere()` (PostgreSQL / SQLite)
- `onConflict(cols, { where })`로 지정하는 부분 고유 인덱스
- PostgreSQL의 `onConflictConstraint()`
- 저장한 행을 반환하는 `executeAndReturn()`
- `SelectQueryBuilder`가 조회한 행을 삽입하는 `values(columns, query)` (`INSERT ... SELECT`)

전체 레퍼런스와 다이얼렉트 지원표는 [EntityManager: 쓰기 & 트랜잭션](./entity-manager-writes.md#표현식-기반-upsert-createinsertbuilder)에 있습니다.

---

## 이어서 읽을 순서

쿼리 빌더 문서 일곱 개를 처음 읽는다면 아래 순서가 가장 자연스럽습니다. 참고용으로 다시 볼 때는 필요한 페이지만 펼쳐 보세요.

1. **[JOIN](./query-builder-joins.md)**: 타입이 있는 컬럼 참조로 다른 엔티티를 조인합니다. 관계 메타데이터로 ON 절을 자동 생성하고 `*AndSelect`로 결과까지 한 번에 조회합니다.
2. **[QueryDSL 표현식](./query-builder-querydsl.md)**: `qAlias()`의 집계, CASE, CAST, 날짜, 윈도 함수, 조건 묶기, 문자열 매칭을 모두 다루는 레퍼런스입니다. 옆에 두고 자주 열어 보게 됩니다.
3. **[JSON 컬럼 탐색](./query-builder-json.md)**: 같은 프록시를 `json` / `jsonb` 컬럼으로 넓힌 기능입니다. 세 드라이버 모두에서 같은 코드로 동작합니다.
4. **[집계 & 서브쿼리](./query-builder-aggregations.md)**: GROUP BY, HAVING, 상관 서브쿼리, DISTINCT를 다룹니다. 윈도 집계로 넘어가는 다리 역할도 합니다.
5. **[실행 & 결과](./query-builder-execution.md)**: ORDER BY, 페이지네이션, 비관적 잠금, 인덱스 힌트, `validate()`, `getMany()` / `getPartialMany()` / `getRawMany()`, `prepare()`.
6. **[편의 패턴](./query-builder-patterns.md)**: `when()`, `pipe()`, `whereHas()`, `withCount()`, scope. 서비스 레이어에서 실제로 자주 쓰게 되는 조합 도구입니다.

UNION, 재귀 CTE, 복잡한 윈도 함수, `DISTINCT ON`처럼 `SelectQueryBuilder`의 한계를 넘는 쿼리가 필요하면 [Raw SQL & CTE](./raw-sql.md)의 `RawQueryBuilder`를 쓰세요. 일상적인 쿼리는 `SelectQueryBuilder`로 작성하고 특수한 쿼리에만 `RawQueryBuilder`를 쓰는 것이 Stingerloom의 기본 전략입니다.

## 더 읽을거리

- [Pagination & Streaming](./pagination.md): 오프셋 / 커서 / 스트리밍 전략
- [EntityManager](./entity-manager.md): `find()`, `save()` 같은 일상 CRUD
- [API Reference](./api-reference.md): 메서드 시그니처 빠른 참조
