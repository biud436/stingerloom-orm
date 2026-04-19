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

`where()`는 조건 복잡도에 맞춰 세 가지 스타일을 받습니다.

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

세 스타일 모두 타입이 안전합니다. 컬럼명(`"age"`, `"status"`)이 `keyof User`에서 자동완성되고, 오타는 컴파일 에러로 잡힙니다.

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

`WHERE status = 'active' OR (role = 'admin' AND verified = true)`처럼 **괄호 그룹**이 필요하면 [`andWhereGroup()` / `orWhereGroup()`](./query-builder-patterns.md#그룹-조건-andwheregroup-orwheregroup)을 쓰세요.

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

모든 WHERE 메서드는 `"alias.property"` 형식의 크로스 엔티티 참조도 받습니다 — 자세한 건 [JOIN 페이지의 크로스 엔티티 컬럼 해석](./query-builder-joins.md#cross-entity-컬럼-해석)을 참고하세요.

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
