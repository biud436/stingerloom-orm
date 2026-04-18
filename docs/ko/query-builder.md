# Query Builder

`find()`와 `findOne()`으로 대부분의 쿼리는 충분해요 — 조건 필터링,
relation 로딩, 페이지네이션까지. 하지만 가끔은 그걸로 부족할 때가 있어요.
직접적인 relation이 없는 두 테이블을 조인한다거나, 카테고리별 행 수를
그룹핑하거나, 서로 다른 테이블의 결과를 UNION으로 합쳐야 할 때요. 이런
상황에서 **query builder**가 필요해요.

Stingerloom은 두 가지 query builder를 제공하고, 선택 기준은 간단해요.

| Builder | 언제 쓰나요 | 생성 방법 |
|---------|-------------|-----------|
| **SelectQueryBuilder** | 엔티티를 쿼리하면서 컬럼명 자동완성이 필요할 때 | `em.createQueryBuilder(User, "u")` |
| **RawQueryBuilder** | Raw SQL 제어가 필요할 때 — UNION, CTE, window function | `em.createQueryBuilder()` (인자 없이) |

대부분은 `SelectQueryBuilder`를 쓰게 돼요. 여기서부터 시작할게요.

이 페이지는 기본만 다뤄요 — 빌더 생성, `WHERE`로 필터링, 조건 결합.
깊이 들어가야 하는 주제는 각각 독립된 페이지로 분리되어 있어요.

| 주제 | 페이지 |
|------|--------|
| JOIN — entity-aware / relation 기반 / 멀티 테이블 | [JOIN](./query-builder-joins.md) |
| `qAlias()` — 타입 안전 표현식, 집계, CASE, 날짜 컴포넌트, 윈도우 함수 | [QueryDSL 표현식](./query-builder-querydsl.md) |
| JSON / JSONB 컬럼 탐색 | [JSON 컬럼 탐색](./query-builder-json.md) |
| `GROUP BY`, `HAVING`, 서브쿼리, `DISTINCT`, CTE | [집계 & 서브쿼리](./query-builder-aggregations.md) |
| 페이지네이션, 잠금, 인덱스 힌트, `validate()`, 실행 단계, `prepare()` | [실행 & 결과](./query-builder-execution.md) |
| `when()`, `pipe()`, `whereHas()`, `withCount()`, scope | [편의 패턴](./query-builder-patterns.md) |
| UNION, 재귀 CTE, 윈도우 함수 — `RawQueryBuilder` | [Raw SQL & CTE](./raw-sql.md) |

---

## SelectQueryBuilder — Type-Safe 쿼리

### Query Builder가 왜 필요할까요?

본론에 들어가기 전에, `find()`로 다 하면 안 되는 걸까요?

`find()`가 표현할 수 없는 것들이 있기 때문이에요. `find()`는 `WHERE field = value`를 지원하지만, `WHERE age >= 18`이나, 관계없는 테이블에 대한 `JOIN`, `GROUP BY category HAVING COUNT(*) > 5` 같은 건 못 해요. 이럴 때 query builder가 필요해요.

Stingerloom의 query builder는 안전성 수준이 다른 세 가지 실행 메서드를 제공해요.

**`getMany()`** — 항상 **클래스 인스턴스**를 반환해요. `instanceof`가 동작하고, 클래스 메서드를 쓸 수 있고, 결과를 `em.save()`에 전달할 수 있어요. `select()` 사용 시, non-nullable 컬럼이 모두 포함됐는지 검증해요.

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .where("isActive", true)
  .getMany();

users[0] instanceof User; // ✓ true — real class instance
await em.save(User, users[0]); // ✓ works correctly
```

**`getPartialMany()`** — `Pick<T, K>` 타입 narrowing이 적용된 **typed plain object**를 반환해요. 선택하지 않은 컬럼에 접근하면 컴파일 에러가 나요. required 컬럼 검증은 하지 않아요.

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name"])
  .getPartialMany();

users[0].id;    // ✓ number — exists in Pick<User, "id" | "name">
users[0].name;  // ✓ string — exists
users[0].email; // ✗ Compile error! Property 'email' does not exist
```

**`getRawMany()`** — **untyped plain object** (`Record<string, unknown>`)를 반환해요. `addSelect(sql`COUNT(*)`, "cnt")` 같은 computed column이 있는 쿼리에 사용해요.

`where()`와 `orderBy()`는 항상 엔티티의 모든 컬럼을 받을 수 있어요 — SELECT하지 않은 컬럼으로도 필터링이나 정렬이 가능하니까요. 타입 시스템은 **projection**(반환 결과)과 **entity**(쿼리 대상)를 별도로 추적해요.

실행 단계별 보장, 언제 어떤 메서드를 써야 하는지 전체 가이드는
[실행 & 결과 → 쿼리 실행하기](./query-builder-execution.md#쿼리-실행하기)에
있어요.

### 첫 번째 Query Builder 쿼리

활성 사용자를 등록일 기준으로 정렬하되, `id`, `name`, `email` 컬럼만 가져오고 싶다고 해볼게요. `find()`로는 이렇게 써요:

```typescript
const users = await em.find(User, {
  select: ["id", "name", "email"],
  where: { isActive: true },
  orderBy: { createdAt: "DESC" },
  take: 10,
});
```

Query builder로는 같은 쿼리가 이렇게 돼요:

```typescript
const users = await em
  .createQueryBuilder(User, "u")
  .select(["id", "name", "email"])
  .where("isActive", true)
  .orderBy({ createdAt: "DESC" })
  .limit(10)
  .getPartialMany();
```

여기까지는 큰 차이가 없어요. Query builder의 진가는 `find()`로 표현할 수 없는 것들 — `>=` 같은 연산자, 관계없는 테이블과의 JOIN, GROUP BY + aggregate, pessimistic locking — 이 필요할 때 드러나요.

`createQueryBuilder(User, "u")`의 `"u"`는 **table alias**예요. 생성된 SQL에서 컬럼을 한정하는 짧은 이름이에요: `"u"."id"`, `"u"."name"` 같은 식이죠. JOIN을 다룰 때 alias가 왜 중요한지 알게 될 거예요.

> **Hint** Repository에서도 query builder를 생성할 수 있어요: `userRepo.createQueryBuilder("u")`. 둘 다 같은 방식으로 동작해요.

### WHERE — 행 필터링

`where()` 메서드는 조건의 복잡도에 따라 세 가지 스타일을 지원해요.

**Equals** — 가장 간단한 형태예요. 컬럼명과 값을 넘기면 돼요.

```typescript
qb.where("status", "active");
// WHERE "u"."status" = $1
```

**Operator** — `>=`, `<`, `LIKE` 등이 필요할 때요. 두 번째 인자로 연산자를 넘겨요. 연산자는 type-check 되므로 `"LKIE"` 같은 오타는 컴파일 에러가 돼요.

```typescript
qb.where("age", ">=", 18);
// WHERE "u"."age" >= $1

// Allowed operators:
// =, !=, <>, <, >, <=, >=, LIKE, NOT LIKE, ILIKE, IN, NOT IN,
// IS NULL, IS NOT NULL, BETWEEN
```

**Raw SQL** — ORM으로 표현할 수 없는 것들에 사용해요. `sql` template literal을 직접 넘기면 돼요.

```typescript
import sql from "sql-template-tag";

qb.where(sql`"u"."score" > ${90}`);
```

세 가지 스타일 모두 type-safe해요 — 컬럼명(`"age"`, `"status"`)이 `keyof User`에서 자동완성돼요. 오타는 컴파일 에러가 돼요.

### 조건 결합 — AND, OR

여러 조건은 `andWhere()`와 `orWhere()`로 체이닝해요.

```typescript
const qb = em.createQueryBuilder(User, "u");

const users = await qb
  .where("isActive", true)
  .andWhere("age", ">=", 18)
  .getMany();
// WHERE "u"."is_active" = $1 AND "u"."age" >= $2
```

`orWhere()`는 기존 조건을 괄호로 감싸고 OR 분기를 추가해요.

```typescript
qb.where("isActive", true)
  .andWhere("age", ">=", 18)
  .orWhere("role", "admin");
// WHERE ("u"."is_active" = $1 AND "u"."age" >= $2) OR "u"."role" = $3
```

즉: (active이면서 18세 이상)이거나, 나이와 상관없이 admin인 경우예요.

`WHERE status = 'active' OR (role = 'admin' AND verified = true)` 같은
괄호 그룹이 필요하면 [`andWhereGroup()` / `orWhereGroup()`](./query-builder-patterns.md#그룹-조건-andwheregroup-orwheregroup)을
쓰세요.

### 자주 쓰는 WHERE 헬퍼

흔한 패턴에 raw SQL을 쓰는 대신, 내장 헬퍼를 사용해요.

```typescript
// IN — match any value in the list
qb.whereIn("status", ["active", "pending"]);

// NOT IN — exclude these values
qb.whereNotIn("id", [1, 2, 3]);

// NULL checks
qb.whereNull("deletedAt");
qb.whereNotNull("email");

// BETWEEN — range check
qb.whereBetween("age", 18, 65);

// LIKE — pattern matching
qb.whereLike("name", "%alice%");
```

각 헬퍼는 기존 WHERE 절에 AND 조건을 추가해요. `where()`와 `andWhere()`와 자유롭게 섞어 쓸 수 있어요.

모든 WHERE 메서드는 `"alias.property"` 형식의 cross-entity 참조도 지원해요 —
[JOIN 페이지의 Cross-Entity 컬럼 해석](./query-builder-joins.md#cross-entity-컬럼-해석)을
참고하세요.

---

## 학습 경로

아래 순서가 문서 세트의 자연스러운 독법이에요. 처음 읽는다면 위에서 아래로, 참고용으로 돌아올 때는 필요한 항목만 펼쳐 보세요.

1. **[JOIN](./query-builder-joins.md)** — 타입드 컬럼 참조로 다른 엔티티 조인, relation 메타데이터로 ON 자동 생성, `*AndSelect` 변형
2. **[QueryDSL 표현식](./query-builder-querydsl.md)** — 레퍼런스. `qAlias()` 집계 / CASE / CAST / 날짜 컴포넌트 / 윈도우 함수 / 조건 묶기 / 문자열 매칭 전체. 항상 옆에 펴두는 책
3. **[JSON 컬럼 탐색](./query-builder-json.md)** — 세 다이얼렉트 공통 프록시 기반 `json` / `jsonb` 탐색
4. **[집계 & 서브쿼리](./query-builder-aggregations.md)** — GROUP BY, HAVING, 상관 서브쿼리, DISTINCT, 윈도우 집계로의 교두보
5. **[실행 & 결과](./query-builder-execution.md)** — ORDER BY, 페이지네이션, 비관적 잠금, 인덱스 힌트, `validate()`, `getMany()` / `getPartialMany()` / `getRawMany()`, `prepare()`
6. **[편의 패턴](./query-builder-patterns.md)** — `when()`, `pipe()`, `whereHas()`, `withCount()`, scope — 서비스 레이어에서 실제로 쓰게 되는 합성 도구

한계 너머로 가야 하면 — UNION / 재귀 CTE / 복잡한 윈도우 / `DISTINCT ON` — **[Raw SQL & CTE](./raw-sql.md)** 로 `RawQueryBuilder`를 꺼내세요. 일상 쿼리는 `SelectQueryBuilder`로, 특수 쿼리만 `RawQueryBuilder`로 갈아타는 게 이 ORM의 기본 전략이에요.

## 더 가볼 곳

- [Pagination & Streaming](./pagination.md) — Offset, cursor, streaming 전략
- [EntityManager](./entity-manager.md) — `find()`, `save()` 등 기본 CRUD
- [API Reference](./api-reference.md) — 모든 메서드 시그니처 빠른 참조
