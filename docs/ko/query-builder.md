# Query Builder

`find()`와 `findOne()`만으로 풀리는 쿼리가 생각보다 많습니다. 조건으로 거르고, 관계를 함께 읽고, 페이지를 끊어 가져오는 일상적인 작업은 여기서 거의 끝나요.

그런데 종종 벽에 부딪힙니다. 직접 관계가 없는 두 테이블을 이어야 할 때, 카테고리별로 행 수를 세고 "5개 이상인 것만" 같은 조건을 걸어야 할 때, 서로 다른 테이블의 결과를 UNION으로 합쳐야 할 때. 이럴 때 쓰는 게 **쿼리 빌더**입니다.

Stingerloom은 쿼리 빌더를 두 가지 제공합니다. 선택 기준은 단순해요.

| 빌더 | 언제 쓰나 | 만드는 법 |
|------|----------|-----------|
| **SelectQueryBuilder** | 엔티티를 대상으로 쿼리하면서 컬럼명 자동완성이 필요할 때 | `em.createQueryBuilder(User, "u")` |
| **RawQueryBuilder** | SQL 자체를 직접 제어해야 할 때 — UNION, CTE, 윈도우 함수 | `em.createQueryBuilder()` (인자 없이) |

대부분 `SelectQueryBuilder`를 씁니다. 이 문서도 여기서 출발합니다.

이 페이지는 기본기만 다룹니다 — 빌더 만들기, `WHERE`로 필터 걸기, 조건 엮기. 깊이 들어가야 하는 주제는 각각 독립된 페이지로 분리되어 있어요.

| 주제 | 페이지 |
|------|--------|
| JOIN — 엔티티 인식 / 관계 기반 / 멀티 테이블 | [JOIN](./query-builder-joins.md) |
| `qAlias()` — 타입 안전 표현식, 집계, CASE, 날짜 컴포넌트, 윈도우 함수 | [QueryDSL 표현식](./query-builder-querydsl.md) |
| JSON / JSONB 컬럼 탐색 | [JSON 컬럼 탐색](./query-builder-json.md) |
| `GROUP BY`, `HAVING`, 서브쿼리, `DISTINCT`, CTE | [집계 & 서브쿼리](./query-builder-aggregations.md) |
| 페이지네이션, 잠금, 인덱스 힌트, `validate()`, 실행, `prepare()` | [실행 & 결과](./query-builder-execution.md) |
| `when()`, `pipe()`, `whereHas()`, `withCount()`, scope | [편의 패턴](./query-builder-patterns.md) |
| `UPDATE … ORDER BY … LIMIT` — `createUpdateBuilder` | [UpdateQueryBuilder](#updatequerybuilder-—-타입-안전한-update-order-by-limit) |
| `INSERT … ON CONFLICT` 표현식 — `createInsertBuilder` | [InsertQueryBuilder](#insertquerybuilder-—-표현식-기반-on-conflict) |
| UNION, 재귀 CTE, 윈도우 함수 — `RawQueryBuilder` | [Raw SQL & CTE](./raw-sql.md) |

---

## SelectQueryBuilder — 타입이 있는 쿼리

### 왜 쿼리 빌더가 필요한가

본론에 들어가기 전에 짚고 가죠. `find()`로 다 할 수 없을까요?

할 수 없는 것들이 있기 때문입니다. `find()`는 `WHERE field = value`는 되지만 `WHERE age >= 18` 같은 비교 연산자는 못 다룹니다. 관계 없는 테이블을 조인하거나, `GROUP BY category HAVING COUNT(*) > 5`처럼 집계 조건을 거는 쿼리도 표현 불가예요. 이런 구간을 메워 주는 게 쿼리 빌더입니다.

Stingerloom의 쿼리 빌더는 실행 메서드를 **안전성 수준별로 세 가지** 제공합니다.

**`getMany()`** — 언제나 **클래스 인스턴스**를 돌려줍니다. `instanceof`가 동작하고, 엔티티에 정의해 둔 메서드를 바로 쓸 수 있고, 결과를 `em.save()`에 그대로 넘길 수 있어요. `select()`로 일부 컬럼만 가져올 때는 not-null 컬럼이 전부 포함됐는지 검증까지 해 줍니다.

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .where("isActive", true)
  .getMany();

users[0] instanceof User;        // ✓ true — 진짜 클래스 인스턴스
await em.save(User, users[0]);   // ✓ 기대대로 동작
```

**`getPartialMany()`** — `Pick<T, K>`로 좁혀진 **타입드 plain object**를 돌려줍니다. 선택하지 않은 컬럼에 접근하면 컴파일 타임 에러가 나요. 대신 not-null 컬럼 검증은 하지 않습니다.

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name"])
  .getPartialMany();

users[0].id;    // ✓ number — Pick<User, "id" | "name">에 포함
users[0].name;  // ✓ string — 포함
users[0].email; // ✗ 컴파일 에러 — 'email' 프로퍼티 없음
```

**`getRawMany()`** — **타입 없는 plain object**(`Record<string, unknown>`)입니다. `addSelect(sql`COUNT(*)`, "cnt")`처럼 엔티티에 없는 계산 컬럼이 섞인 쿼리에 씁니다.

`where()`와 `orderBy()`는 항상 엔티티의 모든 컬럼을 받을 수 있어요. SELECT하지 않은 컬럼으로도 필터링과 정렬이 가능해야 하니까요. 타입 시스템이 **어떤 행을 돌려주는가(projection)** 와 **어떤 엔티티를 대상으로 쿼리하는가(entity)** 를 따로 추적하기 때문입니다.

실행 단계별 보장과 "언제 어떤 메서드를 쓸지"는 [실행 & 결과 → 쿼리 실행하기](./query-builder-execution.md#쿼리-실행하기)에 전부 정리되어 있습니다.

### 첫 쿼리 빌더 쿼리

활성 사용자를 등록일 내림차순으로 정렬해서 `id`, `name`, `email`만 가져오고 싶다고 해 보죠. `find()`로 쓴다면 이렇습니다.

```typescript
const users = await em.find(User, {
  select: ["id", "name", "email"],
  where: { isActive: true },
  orderBy: { createdAt: "DESC" },
  take: 10,
});
```

쿼리 빌더로는 이렇게 됩니다.

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name", "email"])
  .where("isActive", true)
  .orderBy({ createdAt: "DESC" })
  .limit(10)
  .getPartialMany();
```

여기까지는 크게 달라 보이지 않습니다. 쿼리 빌더의 진가는 `find()`로 표현할 수 없는 영역 — `>=` 같은 연산자, 관계 없는 테이블의 JOIN, GROUP BY + 집계, 비관적 잠금 — 이 필요해지는 순간부터 드러나요.

`createQueryBuilder(User, "u")`에서 두 번째 인자 `"u"`는 **테이블 별칭**입니다. 생성된 SQL에서 컬럼 앞에 붙는 짧은 이름이에요 — `"u"."id"`, `"u"."name"` 이런 식이죠. JOIN을 다룰 때 이 별칭이 왜 중요한지 자연스럽게 알게 됩니다.

> **참고** 리포지토리에서도 쿼리 빌더를 만들 수 있습니다 — `userRepo.createQueryBuilder("u")`. 동작은 동일해요.

### WHERE — 행 거르기

`where()`는 조건 복잡도에 맞춰 네 가지 스타일을 받습니다.

**Equals** — 가장 단순한 형태. 컬럼과 값만 넘기면 됩니다.

```typescript
qb.where("status", "active");
// WHERE "u"."status" = $1
```

**Operator** — `>=`, `<`, `LIKE` 같은 연산자가 필요할 때. 두 번째 인자로 연산자를 넘깁니다. 연산자도 타입 검사를 거치므로 `"LKIE"` 같은 오타는 컴파일 단계에서 걸려요.

```typescript
qb.where("age", ">=", 18);
// WHERE "u"."age" >= $1

// 허용되는 연산자:
// =, !=, <>, <, >, <=, >=, LIKE, NOT LIKE, ILIKE, IN, NOT IN,
// IS NULL, IS NOT NULL, BETWEEN
```

**Raw SQL** — ORM 레이어로 표현이 어려운 것들. `sql` 템플릿 리터럴을 그대로 넘깁니다.

```typescript
import sql from "sql-template-tag";

qb.where(sql`"u"."score" > ${90}`);
```

**필터 객체** — `em.find({ where })`에서 쓰던 Prisma 스타일 `WhereClause` 객체를 그대로
넘깁니다. `find()`와 쿼리 빌더 사이에서 필터를 튜플로 다시 쓰지 않고 재사용할 수 있어요.
키는 AND로 묶이고, 값은 리터럴·연산자 객체(`{ gte, lt, in, contains, … }`)·`null`(→ `IS NULL`)·
배열(→ `IN`)이 될 수 있습니다. `OR` / `AND` / `NOT` 조합자도 동작하며, 클래스 배열을 넘기면
그룹들이 OR로 묶입니다.

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

`andWhere()` / `orWhere()`도 같은 필터 객체를 받고, 튜플 / Raw SQL 형태와 자유롭게 섞입니다.
컬럼은 빌더의 alias로 한정되고 `NamingStrategy`로 매핑돼요 — `find()`와 동일합니다.

컬럼명 형태는 모두 타입이 안전합니다. `"age"` / `"status"`가 `keyof User`에서 자동완성되고,
필터 객체의 키도 엔티티 기준으로 검사되므로 오타는 컴파일 에러로 잡힙니다.

### 조건 엮기 — AND와 OR

여러 조건은 `andWhere()`와 `orWhere()`로 이어갑니다.

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

읽으면 이렇게 됩니다. (active면서 18세 이상)이거나, 또는 나이와 관계 없이 admin인 경우.

`WHERE status = 'active' OR (role = 'admin' AND verified = true)`처럼 **괄호 그룹**이 필요하면 [`andWhereGroup()` / `orWhereGroup()`](./query-builder-patterns.md#그룹-조건-—-andwheregroup-orwheregroup)을 쓰세요.

### 자주 쓰는 WHERE 헬퍼

흔한 패턴에는 raw SQL을 쓰지 말고 내장 헬퍼를 쓰는 게 낫습니다.

```typescript
// IN — 리스트 안의 값 중 하나라도 일치
qb.whereIn("status", ["active", "pending"]);

// NOT IN — 이 값들을 제외
qb.whereNotIn("id", [1, 2, 3]);

// NULL 검사
qb.whereNull("deletedAt");
qb.whereNotNull("email");

// BETWEEN — 범위
qb.whereBetween("age", 18, 65);

// LIKE — 패턴 매칭
qb.whereLike("name", "%alice%");
```

각 헬퍼는 기존 WHERE 절에 AND로 붙습니다. `where()` / `andWhere()`와 자유롭게 섞어 써도 돼요.

모든 WHERE 메서드는 `"alias.property"` 형식의 크로스 엔티티 참조도 받습니다 — 자세한 건 [JOIN 페이지의 크로스 엔티티 컬럼 해석](./query-builder-joins.md#크로스-엔티티-컬럼-해석)을 참고하세요.

---

## UpdateQueryBuilder — 타입 안전한 `UPDATE … ORDER BY … LIMIT`

`em.updateMany()`는 일상적인 케이스를 커버합니다. "WHERE에 걸리는 모든 행을 갱신해라"가 거의 그것이에요. 하지만 더 나아가야 하는 패턴이 있습니다 — 갱신할 행 수에 상한을 두고 싶거나, 상한이 적용되기 전에 결정적인 순서로 정렬하고 싶거나, SELECT 쪽에서 쓰던 `qAlias()` DSL로 술어를 표현하고 싶을 때. `createUpdateBuilder()`는 그런 자리에 있습니다.

대표적인 사례가 워커 클레임 큐예요. 여러 워커가 다음 대기 작업을 잡으려고 경쟁하는 상황에서, "조건에 맞는 행 중 우선순위로 정렬한 뒤 단 한 행만 갱신"이라는 원자 작업이 필요합니다. MySQL/MariaDB에서는 `UPDATE … ORDER BY … LIMIT 1` 한 줄로 끝나죠. 빌더가 없다면 `em.query(sql\`UPDATE …\`)`로 내려가 엔티티 인지 능력을 잃게 됩니다.

### 빌더 만들기

두 가지 형태가 있고, 둘 다 `UpdateQueryBuilder<T>`를 돌려줍니다.

```typescript
import { qAlias } from "@stingerloom/orm";
import sql from "sql-template-tag";

// 형태 1 — 엔티티 클래스 + 별칭(선택)
const builder = em.createUpdateBuilder(Issue, "i");

// 형태 2 — qAlias() ref. WHERE / ORDER BY에서 같은 `i`를 그대로 재사용
const i = qAlias(Issue, "i");
const builder2 = em.createUpdateBuilder(i);
```

리포지토리 단축형도 있습니다. 모양은 같고, 이미 리포지토리를 주입받았다면 `EntityManager`까지 따로 주입받을 필요가 없어요.

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
// affected = 0 또는 1 — InnoDB에서 원자적
```

`set()`은 타입드 객체(`UpdateData<T>`)를 받습니다. 각 값은 컬럼의 리터럴 값이거나 `Sql` 표현식이에요. `.set()`을 여러 번 부르면 누적되고, 같은 컬럼이면 마지막 호출이 이깁니다. `setRaw()`는 한 컬럼만 raw SQL로 우회하고 싶을 때 쓰는 비상구입니다 — `NOW()`, `view_count + 1` 같은 식.

WHERE는 SELECT 쪽이 받는 모든 형태를 받습니다 — `qAlias()` 표현식(`i.status.eq(...)`, `i.priority.lt(...)`), 합성 헬퍼(`exp.or(...)`, `exp.and(...)`), 그리고 raw `sql\`...\`` 템플릿. `where()`는 초기화하고, `andWhere()` / `orWhere()`는 이어붙입니다. `orderBy()` / `addOrderBy()`는 `qAlias()` 정렬 표현식(`i.priority.asc()`)이나 `(프로퍼티키, "ASC" | "DESC")` 페어를 받습니다.

### 다이얼렉트별 동작

`UPDATE … ORDER BY … LIMIT`은 표준 SQL이 아닙니다. 빌더가 차이를 가려 주지만, 실제로 무슨 SQL이 나가는지 알아 두면 좋아요.

| 다이얼렉트 | 실제로 나가는 SQL |
|------------|------------------|
| **MySQL / MariaDB** | 네이티브 `UPDATE t SET … WHERE … ORDER BY … LIMIT n` |
| **PostgreSQL / SQLite** | `UPDATE t SET … WHERE pk IN (SELECT pk FROM t WHERE … ORDER BY … LIMIT n)`로 재작성 |

`orderBy()` 또는 `limit()`이 설정되면 PostgreSQL/SQLite 재작성은 자동입니다. 단, 단일 컬럼 PK가 있어야 해요 — 복합 PK 엔티티는 이 경로에서 `UNSUPPORTED_OPERATION` 에러가 납니다. MySQL이 아닌 환경에서 복합 PK 엔티티를 정렬+제한해야 한다면 `RawQueryBuilder`로 직접 서브쿼리를 작성하거나, MySQL/MariaDB로 가야 합니다(네이티브 문법을 지원).

`orderBy()`도 `limit()`도 설정하지 않으면 모든 다이얼렉트가 평범한 `UPDATE t SET … WHERE …`를 그대로 내보냅니다. 빌더는 `em.updateMany()`의 타입드 대안이 되는 셈이에요.

### `updateMany`와 공유하는 동작

`execute()`는 EntityManager 트랜잭션 래퍼 안에서 돌아가므로 다음이 보장됩니다.

- **테넌트 스코핑**이 사용자의 WHERE와 교집합으로 묶입니다 — `UpdateQueryBuilder`로는 절대 테넌트 경계를 넘을 수 없어요.
- **`@UpdateTimestamp`** 가 명시적으로 set되지 않은 경우 자동으로 주입됩니다.
- **`@Version` / 낙관적 잠금**은 적용되지 *않습니다*. 이건 단일 엔티티 save가 아니라 벌크 DML이에요. `em.updateMany()`와 마찬가지로, 버전 스탬프가 필요한 쓰기는 `em.save(entity)` 경로에 둡니다.

### `build()` / `toSql()` — 실행 없이 들여다보기

둘 다 파라미터화된 SQL을 돌려줍니다 — 테스트, 로깅, 디버깅에 쓰기 좋아요. 테넌트 스코핑은 여기서 적용되지 *않습니다*(execute 시점에 붙음). 그래서 결과 텍스트에 테넌트 술어는 들어 있지 않습니다.

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

`UpdateQueryBuilder.execute()`는 벌크 DML이라 *즉시* 실행되며, 버퍼의 Identity Map과 dirty 추적을 우회합니다 — 이미 그렇게 동작하던 `em.updateMany()`, `em.delete()`, `em.softDelete()`와 정확히 같은 모델이에요. 의도된 설계입니다. 버퍼는 EM 직접 호출을 가로채지 않아요.

두 API를 섞어 쓸 때 실용적으로 알아둘 점 두 가지.

- **빌더가 갱신한 행을 이미 트래킹 중이라면** 버퍼의 스냅샷이 stale 상태가 됩니다. `buf.refresh(instance)`로 DB에서 다시 읽어 들이거나, 벌크 업데이트 전에 미리 flush해서 in-memory 변경분을 잃지 않도록 하세요.
- **버퍼 위에서 벌크 업데이트가 필요하면** `buf.updateMany()`를 쓰세요. flush 시점까지 UPDATE를 큐잉하고, 실행 후 WHERE에 매칭되는 모든 트래킹된 인스턴스를 자동으로 동기화합니다. 단, `buf.updateMany()`는 단순한 `WHERE col = val` 형태만 받아요 — `ORDER BY` / `LIMIT`은 버퍼 경로로는 지원되지 않으니, 워커 클레임 패턴은 그대로 `em.createUpdateBuilder()`로 직접 호출합니다.

### 마주칠 수 있는 에러

- `INVALID_QUERY` — `.set()` 호출 없이 `execute()`를 부른 경우, 또는 `.limit(n)`에 정수가 아니거나 음수가 들어간 경우.
- `DELETE_WITHOUT_CONDITIONS` (UPDATE도 같은 코드 사용) — WHERE 없이 `execute()`를 부른 경우. 테이블 전체를 갱신하는 건 위험한 패턴이라 막혀 있습니다. 정말 필요하면 항상 참인 WHERE를 명시적으로 추가하세요.
- `UNSUPPORTED_OPERATION` — PostgreSQL / SQLite에서 복합 PK 엔티티에 `orderBy()` / `limit()`을 쓴 경우.

---

## InsertQueryBuilder — 표현식 기반 `ON CONFLICT`

`em.upsert()`가 충돌 시 할 수 있는 건 제안한 값으로 덮어쓰는 것뿐입니다(`col = EXCLUDED.col`). 새 값이 *저장된 값으로부터* 계산되어야 할 때 — 카운터 누적, 최댓값 유지, 병합 — 이 형태로는 표현이 안 되고, 읽고 계산해서 되쓰는 왕복은 동시성 아래서 올바르려면 행 잠금이 필요합니다.

`em.createInsertBuilder()`는 QueryDSL 표현식 전체를 충돌 절에 넣어 줍니다. 데이터베이스가 행을 쥔 채로 계산하니 잠금이 필요 없어요.

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

`t`는 저장된 행을, `ex`는 이 INSERT가 제안한 행을 가리킵니다. 둘 다 평범한 `qAlias` 프록시라 [QueryDSL 표현식](./query-builder-querydsl.md) 장의 모든 것이 그대로 조합돼요.

`doNothing()`, `doUpdateWhere()`(PostgreSQL / SQLite), `onConflict(cols, { where })`로 지정하는 부분 유니크 인덱스, PostgreSQL의 `onConflictConstraint()`도 함께 지원합니다. 전체 레퍼런스와 드라이버 지원표는 [EntityManager — 쓰기](./entity-manager-writes.md#표현식-기반-upsert-—-createinsertbuilder)에 있습니다.

---

## 이어서 읽을 순서

문서 일곱 장을 처음 읽는다면 아래 흐름이 가장 자연스럽습니다. 참고용으로 다시 펴볼 때는 필요한 장만 넘겨 보세요.

1. **[JOIN](./query-builder-joins.md)** — 타입드 컬럼 참조로 다른 엔티티를 조인하고, 관계 메타데이터로 ON을 자동 생성하고, `*AndSelect`로 결과까지 한 번에.
2. **[QueryDSL 표현식](./query-builder-querydsl.md)** — 레퍼런스. `qAlias()` 집계 / CASE / CAST / 날짜 / 윈도우 / 조건 묶기 / 문자열 매칭 전체. 옆에 두고 자주 열어 보게 되는 장입니다.
3. **[JSON 컬럼 탐색](./query-builder-json.md)** — 같은 프록시가 `json` / `jsonb`로 확장된 모습. 세 드라이버 모두에서 같은 코드로 동작하도록.
4. **[집계 & 서브쿼리](./query-builder-aggregations.md)** — GROUP BY, HAVING, 상관 서브쿼리, DISTINCT, 윈도우 집계로 가는 다리.
5. **[실행 & 결과](./query-builder-execution.md)** — ORDER BY, 페이지네이션, 비관적 잠금, 인덱스 힌트, `validate()`, `getMany()` / `getPartialMany()` / `getRawMany()`, `prepare()`.
6. **[편의 패턴](./query-builder-patterns.md)** — `when()`, `pipe()`, `whereHas()`, `withCount()`, scope. 서비스 레이어에서 실제로 손에 익는 합성 도구들.

한계 너머의 쿼리 — UNION, 재귀 CTE, 복잡한 윈도우, `DISTINCT ON` — 가 필요하면 **[Raw SQL & CTE](./raw-sql.md)** 에서 `RawQueryBuilder`를 꺼내면 됩니다. 일상 쿼리는 `SelectQueryBuilder`로, 특수 쿼리만 `RawQueryBuilder`로 갈아타는 게 Stingerloom의 기본 전략입니다.

## 더 가볼 곳

- [Pagination & Streaming](./pagination.md) — 오프셋 / 커서 / 스트리밍 전략
- [EntityManager](./entity-manager.md) — `find()`, `save()` 같은 일상 CRUD
- [API Reference](./api-reference.md) — 메서드 시그니처 빠른 참조
