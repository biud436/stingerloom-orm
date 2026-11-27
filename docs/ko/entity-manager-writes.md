# EntityManager -- 쓰기 & 트랜잭션

EntityManager로 여러 행을 한 번에 쓰는 배치 연산, upsert, 트랜잭션, Raw SQL 실행의 사용법입니다.

엔티티 하나를 다루는 CRUD는 [CRUD 기본](./entity-manager.md)에 있습니다. 조회 기능은 [쿼리 & 페이지네이션](./entity-manager-querying.md)에 있습니다.

---

## 배치 삽입 -- insertMany()

### insertMany()가 필요한 이유

사용자 1,000명을 생성해야 한다고 생각해 보세요. `save()`를 루프에서 호출하면 `INSERT` 문을 1,000개 실행합니다. 네트워크 왕복과 커밋(commit)도 1,000번씩 일어납니다. 그래서 매우 느립니다.

`insertMany()`는 모든 행을 `INSERT INTO ... VALUES (...), (...), (...)` SQL 문 하나로 묶어서 보냅니다. 왕복과 파싱과 커밋은 한 번씩만 일어납니다. 실제 벤치마크에서는 행을 하나씩 삽입할 때보다 보통 10~50배 빠릅니다.

```typescript
await em.insertMany(User, [
  { name: "Alice", email: "alice@example.com" },
  { name: "Bob", email: "bob@example.com" },
  { name: "Charlie", email: "charlie@example.com" },
]);
```

ORM이 생성하는 SQL은 다음과 같습니다.

```sql
-- PostgreSQL
INSERT INTO "user" ("name", "email")
VALUES ($1, $2), ($3, $4), ($5, $6)
-- Parameters: ['Alice', 'alice@example.com', 'Bob', 'bob@example.com', 'Charlie', 'charlie@example.com']

-- MySQL
INSERT INTO `user` (`name`, `email`)
VALUES (?, ?), (?, ?), (?, ?)
-- Parameters: ['Alice', 'alice@example.com', 'Bob', 'bob@example.com', 'Charlie', 'charlie@example.com']
```

주요 특징은 다음과 같습니다.
- SQL 문 하나로 실행합니다. 그래서 `save()` 루프보다 훨씬 효율적입니다.
- `@CreateTimestamp`와 `@UpdateTimestamp` 컬럼은 행에 값이 없으면 현재 시각으로 채웁니다. 이 규칙은 컬럼의 `type`과 상관없이 적용됩니다(`timestamptz` 포함). 그 밖의 날짜·시간 컬럼은 건드리지 않습니다.
- `@Version` 컬럼은 행마다 `1`로 초기화합니다. 클라이언트에서 생성하는 키는 값이 없는 행마다 새로 생성합니다(`@PrimaryGeneratedColumn("uuid")`, `"uuid-v7"`). 이렇게 생성한 값은 넘긴 객체에도 기록합니다.
- 어느 행도 값을 주지 않은 컬럼은 SQL 문에서 빠집니다. 그래서 DB의 `DEFAULT`가 적용됩니다. `saveMany()`와 같은 규칙입니다([INSERT에서 undefined vs null](#insert에서-undefined-vs-null-db-기본값-살리기) 참고).
- `{ affected: number }`를 반환합니다. 삽입한 행이 필요하면 `insertManyAndReturn()`이나 `saveMany()`를 사용하세요. `insertManyAndReturn()`은 PostgreSQL, SQLite, MariaDB에서 동작하고 `saveMany()`는 모든 다이얼렉트에서 동작합니다.

---

## 배치 삽입 후 반환 -- insertManyAndReturn()

### insertManyAndReturn()가 필요한 이유

`insertMany()`는 빠릅니다. 하지만 `{ affected: number }`만 반환합니다. 생성된 기본 키, 타임스탬프, DB 기본값이 채워진 엔티티 인스턴스가 필요할 때가 있습니다. 이때 다중 행 INSERT를 SQL 문 하나로 실행하는 효율도 유지하려면 `insertManyAndReturn()`을 사용하세요.

ORM은 내부에서 `INSERT INTO ... VALUES (...), (...), (...) RETURNING *` SQL 문 하나를 실행합니다. 그리고 ResultTransformer로 결과 행을 역매핑합니다. 그래서 컬럼 별칭과 NamingStrategy 매핑이 결과에 적용됩니다.

```typescript
const users = await em.insertManyAndReturn(User, [
  { name: "Alice", email: "alice@example.com" },
  { name: "Bob", email: "bob@example.com" },
]);
// users[0].id => 1  (DB가 생성한 기본 키)
// users[1].id => 2
```

ORM이 생성하는 SQL은 다음과 같습니다.

```sql
-- PostgreSQL
INSERT INTO "user" ("name", "email")
VALUES ($1, $2), ($3, $4)
RETURNING *
-- Parameters: ['Alice', 'alice@example.com', 'Bob', 'bob@example.com']

-- SQLite 3.35+
INSERT INTO "user" ("name", "email")
VALUES (?, ?), (?, ?)
RETURNING *
-- Parameters: ['Alice', 'alice@example.com', 'Bob', 'bob@example.com']
```

주요 특징은 다음과 같습니다.
- SQL 문 하나로 실행합니다. 효율은 `insertMany()`와 같습니다.
- 결과 엔티티 인스턴스를 입력 순서대로 반환합니다.
- `@CreateTimestamp`, `@UpdateTimestamp`, `@Version`과 클라이언트에서 생성하는 UUID 키는 INSERT 전에 채웁니다. 어느 행도 값을 주지 않은 컬럼은 DB의 `DEFAULT`에 맡깁니다. `insertMany()`와 같은 규칙입니다.
- `items`가 비어 있으면 DB를 건드리지 않고 바로 `[]`를 반환합니다.

다이얼렉트 지원: `insertManyAndReturn()`은 `INSERT ... RETURNING`이 필요합니다. 그래서 PostgreSQL, SQLite 3.35 이상, MariaDB 10.5 이상에서 동작합니다. MySQL에서 호출하면 `OrmError`(`UNSUPPORTED_DATABASE`)를 던집니다. MySQL에서는 `saveMany()`를 사용하세요.

```typescript
// MySQL에서는 OrmError(UNSUPPORTED_DATABASE)를 던집니다
// await em.insertManyAndReturn(User, [{ name: "Alice" }]); // MySQL에서는 쓰지 않습니다

// MySQL에서는 saveMany()를 사용합니다
const users = await em.saveMany(User, [{ name: "Alice" }]);
```

### 배치 INSERT 방법 선택 가이드

| 메서드 | 지원 다이얼렉트 | SQL 문 수 | 반환값 |
|--------|----------------|-----------|--------|
| `insertMany()` | 전체 | 1 | `{ affected: number }` |
| `insertManyAndReturn()` | PostgreSQL, SQLite 3.35+, MariaDB 10.5+ | 1 | 엔티티 인스턴스 배열 |
| `saveMany()` | 전체 | N (행당 1개) | 엔티티 인스턴스 배열 |

삽입한 행이 필요 없고 MySQL도 지원해야 하면 `insertMany()`를 쓰세요. 삽입한 행이 필요하고 대상이 PostgreSQL, SQLite, MariaDB 가운데 하나이면 `insertManyAndReturn()`을 씁니다. MySQL에서 삽입한 행이 필요하면 `saveMany()`를 씁니다. 새 엔티티와 기존 엔티티가 섞인 배치도 `saveMany()`로 처리합니다. 이때는 행마다 INSERT와 UPDATE 가운데 하나를 실행합니다.

---

## 배치 저장 -- saveMany()

### insertMany()가 있는데 왜 saveMany()가 필요할까요?

`insertMany()`는 빠릅니다. 하지만 새 행만 삽입합니다. `saveMany()`는 항목마다 기본 키를 확인해서 INSERT와 UPDATE 가운데 하나를 고릅니다. 새 엔티티와 기존 엔티티가 섞여 있을 때 사용하세요.

```typescript
const users = await em.saveMany(User, [
  { name: "New User", email: "new@example.com" },           // No PK -> INSERT
  { id: 2, name: "Updated User", email: "upd@example.com" }, // Has PK -> UPDATE
]);
// Returns the saved entities with generated PKs
```

`saveMany()`는 내부에서 모든 연산을 트랜잭션 하나로 감쌉니다. 그리고 항목을 하나씩 처리합니다. 위 예시에서 실행하는 SQL을 순서대로 보면 다음과 같습니다.

```sql
-- Step 1: BEGIN transaction
BEGIN

-- Step 2: First item has no PK -> INSERT
-- PostgreSQL
INSERT INTO "user" ("name", "email") VALUES ($1, $2) RETURNING *
-- Parameters: ['New User', 'new@example.com']

-- Step 3: Second item has PK -> UPDATE
-- PostgreSQL
UPDATE "user" SET "name" = $1, "email" = $2 WHERE "id" = $3 RETURNING *
-- Parameters: ['Updated User', 'upd@example.com', 2]

-- Step 4: COMMIT
COMMIT
```

장단점은 분명합니다. `saveMany()`는 항목마다 쿼리를 하나씩 보내므로 삽입만 할 때는 느립니다. 대신 생성과 수정이 섞인 배치를 처리합니다. 이런 배치는 `insertMany()`로 처리하지 못합니다.

---

## INSERT에서 undefined vs null -- DB 기본값 살리기

### 왜 구분이 중요할까요?

`save()`와 `saveMany()`는 `undefined`를 "값을 주지 않았다"는 뜻으로 해석합니다. TypeORM, knex와 같은 의미입니다. 엔티티 값이 `undefined`인 컬럼은 INSERT 컬럼 목록에서 빠집니다. 그 컬럼은 DB의 `DEFAULT` 절이 채웁니다. `@Column({ default })`로 선언한 기본값도 여기에 해당합니다. 반면 `null`을 명시하면 컬럼이 목록에 들어가고 `NULL`을 기록합니다.

```typescript
@Entity()
class Article {
  @PrimaryGeneratedColumn() id!: number;
  @Column() title!: string;
  @Column({ default: "draft" }) status!: string;
  @Column({ nullable: true }) summary?: string;
}

const a = await em.save(Article, { title: "Hello" });
// INSERT INTO "article" ("title") VALUES ($1)
// -> "status"가 빠지고 DB DEFAULT 'draft'가 적용됩니다
a.status; // "draft"

await em.save(Article, { title: "Hello", summary: null });
// INSERT INTO "article" ("title", "summary") VALUES ($1, $2)
// -> "summary"가 포함되고 NULL을 명시적으로 기록합니다
```

ORM이 값을 채우는 컬럼은 예외입니다. `@CreateTimestamp`, `@UpdateTimestamp`, `@Version`, 클라이언트 측 UUID 생성 전략의 컬럼은 값이 `undefined`여도 목록에 들어갑니다. 그리고 ORM이 값을 자동으로 채웁니다.

모든 컬럼이 빠지면 ORM은 다이얼렉트마다 다른 "모든 컬럼에 기본값" INSERT 형식을 생성합니다.

```sql
-- MySQL / MariaDB
INSERT INTO `t` () VALUES ()

-- PostgreSQL / SQLite
INSERT INTO "t" DEFAULT VALUES
```

`saveMany()`의 배치 삽입에서는 다중 행 `VALUES`가 컬럼 목록 하나를 공유합니다. 그래서 배치의 어떤 항목도 값을 주지 않은 컬럼만 목록에서 빠집니다. 일부 항목만 값을 준 배치에서는 컬럼이 목록에 남습니다. 그리고 그 컬럼을 비워 둔 행에는 컬럼의 기본값이 들어갑니다. 한 행씩 저장했을 때와 결과가 같습니다. PostgreSQL과 MySQL은 `DEFAULT`를 씁니다. SQLite는 `VALUES` 안에 `DEFAULT`를 쓰지 못하므로 선언된 `default` 값을 씁니다(선언이 없으면 NULL). 값을 `null`로 명시하면 그대로 NULL을 저장합니다.

`insertMany()`, `insertManyAndReturn()`, `createInsertBuilder()`도 같은 배치 규칙을 따릅니다. `upsert()`와 `insertIgnore()`는 단일 행 규칙을 따릅니다. `batchUpsert()`는 행이 명시한 컬럼 집합마다 SQL 문을 하나씩 보냅니다. 그래서 컬럼을 비워 둔 행은 `upsert()`와 똑같이 처리합니다. 삽입할 때는 그 컬럼에 기본값이 들어가고 충돌할 때는 저장된 값이 그대로 남습니다. `insertMany()`의 어느 행도 컬럼 값을 하나도 주지 않았다면 전체 컬럼 목록을 그대로 둡니다. 그리고 모든 행에 기본값을 씁니다. 3.0 이전의 `insertMany()`, `insertManyAndReturn()`, `createInsertBuilder()`는 선언된 컬럼을 전부 나열했습니다. 그리고 빠진 값에는 `NULL`을 바인딩했습니다. 그래서 이 경로에서는 `DEFAULT`가 적용되지 않았습니다.

---

## 쓰기 페이로드의 미지 키

### 어떤 키가 "아는 키"인가요?

`save()`, `saveMany()`, `insertMany()`, `insertManyAndReturn()`, `upsert()`, `insertIgnore()`, `batchUpsert()`는 값을 속성 키로 읽습니다. 페이로드에 담을 수 있는 키는 다음과 같습니다.

- `@Column` 속성 이름입니다. DB 컬럼 이름 `first_name`이 아니라 속성 이름 `firstName`을 씁니다.
- 모든 종류의 관계 속성입니다(`team`, `posts`, `tags`). 캐스케이드 입력과 조회로 얻은 인스턴스가 여기에 해당합니다.
- `@ManyToOne`과 `@OneToOne`의 외래 키 섀도 속성과 조인 컬럼입니다. 섀도 속성은 `teamId`나 직접 선언한 `fkProperty`입니다.
- `@ComputedColumn` 속성입니다. DB에 쓰지는 않지만 조회로 얻은 모든 인스턴스에 들어 있습니다.
- 단일 테이블 상속에서는 구분 컬럼(discriminator column)과 형제 클래스의 컬럼도 해당합니다.

그 밖의 키는 DB에 쓰지 않습니다. 오타, 컬럼이 되지 못한 DTO 필드, 속성 이름 대신 적은 DB 컬럼 이름이 그 예입니다. 3.0 이전에는 이런 키를 경고 없이 버렸습니다. 같은 키를 `updateMany()`나 조회에 넘기면 그전부터 `Did you mean` 제안과 함께 거부했는데도 그랬습니다.

### `unknownWriteKeys` 정책

미지 키를 만났을 때의 동작은 연결 옵션 `unknownWriteKeys`로 고릅니다.

| 정책 | 동작 |
|---|---|
| `"warn"` (기본값) | 쓰기를 실행합니다. 미지 키는 EntityManager가 살아 있는 동안 엔티티와 키 조합마다 한 번 로그에 남깁니다. 로그에는 호출한 메서드와 가장 가까운 허용 키가 나옵니다. 키는 호출자의 데이터에서 오므로 엔티티마다 서로 다른 키를 50개까지만 보고합니다(50번째 줄에 그렇게 적습니다). 100자를 넘는 키는 잘라서 남깁니다. |
| `"throw"` | SQL을 생성하기 전에 `InvalidQueryError`로 쓰기를 거부합니다. 조회 `where`에 오타가 있을 때 던지는 것과 같은 에러입니다. 경고를 모두 해결한 뒤에 쓰는 것을 권장합니다. |
| `"ignore"` | 예전처럼 미지 키를 경고 없이 버립니다. |

```typescript
await DatabaseClient.getInstance().connect({
  type: "postgres",
  // ...
  unknownWriteKeys: "throw",
});

await em.save(User, { firstNam: "kim" } as any);
// InvalidQueryError: Unknown column "firstNam" in "data" for entity "User". Did you mean "firstName"?
```

기본 정책에서는 같은 호출이 성공합니다. 그리고 다음 로그를 남깁니다.

```
[WriteInput] Unknown key "firstNam" in the data passed to save() for entity "User" — it matches no column, relation or FK property and was not written. Did you mean "firstName"? Set unknownWriteKeys: "throw" to reject such writes, or "ignore" to silence this warning.
```

DB 컬럼 이름도 보고합니다. INSERT는 그 키를 읽지 않기 때문입니다. `save(Team, { team_name: "x" })`는 `Did you mean "teamName"?`과 함께 경고합니다. 반면 조회의 `where: { team_name }`은 컬럼으로 해석합니다. 쓰기에는 속성 이름을 쓰세요.

원래 DB에 쓰지 않는 값은 보고하지 않습니다. `undefined` 필드와 함수 값 멤버가 그렇습니다(위 절 참고). 함수 값 멤버는 엔티티 인스턴스의 메서드를 말합니다. 검사는 훅, 캐스케이드, 테넌트 컬럼 주입보다 먼저 실행합니다. 그래서 넘긴 페이로드를 그대로 검사합니다.

관계 키에 담긴 행을 쓰기가 저장하지 않을 때도 이 정책을 적용합니다. 저장하는 캐스케이드가 없는 관계에 기본 키 값이 없는 객체를 넣은 경우가 그렇습니다. 캐스케이드를 실행하지 않는 `insertMany()`, `upsert()`, `insertIgnore()`, `batchUpsert()`에 그런 객체를 넘긴 경우도 마찬가지입니다.

```
[WriteInput] Relation "posts" in the data passed to save() for entity "User" holds a new row (no primary key value), but the @OneToMany has no cascade ["insert"], so the row is not written. Add cascade: ["insert"] to the relation, or save the row on its own first. ...
```

키가 있는 관계 객체는 기존 행을 가리키므로 보고하지 않습니다. 그래서 관계를 함께 로드한 엔티티를 다시 저장해도 경고하지 않습니다.

`update()`와 `updateMany()`는 기존 계약을 유지합니다. 그래서 정책과 상관없이 `data`나 `where`에 미지 키가 있으면 에러를 던집니다. `create()`, `merge()`, `preload()`는 DB에 저장하지 않으므로 모든 키를 인스턴스에 그대로 둡니다. 그 키는 뒤이어 실행하는 쓰기가 보고합니다.

---

## RETURNING 결과는 프로퍼티 이름으로 돌아와요

RETURNING을 지원하는 드라이버에서는 `save()`가 반환하는 엔티티를 `RETURNING *` 행으로 만듭니다(PostgreSQL, MariaDB 10.5+). 이 행은 ResultTransformer를 거치므로 DB 컬럼 이름이 엔티티 속성 키로 역매핑됩니다. `@Column({ name })`과 `SnakeNamingStrategy` 같은 NamingStrategy 매핑도 모두 적용됩니다. 컬럼 트랜스포머의 `from`도 함께 적용됩니다.

```typescript
@Entity()
class Category {
  @PrimaryGeneratedColumn() id!: number;
  @Column({ name: "LFT_NO" }) left!: number;
}

const saved = await em.save(Category, { left: 1 });
saved.left;             // 1 (클래스에 선언한 속성 키)
(saved as any).LFT_NO;  // undefined (raw DB 키는 더 이상 노출되지 않습니다)
```

이전에는 반환 객체에 raw DB 키가 그대로 노출됐습니다. 예를 들어 `left` 대신 `LFT_NO`가 있었습니다. 이 매핑은 INSERT RETURNING, UPDATE RETURNING, `saveMany()`의 배치 RETURNING에 모두 적용됩니다.

---

## 배치 삭제 -- deleteMany()

### 왜 delete()를 여러 번 호출하는 대신 deleteMany()를 쓸까요?

`insertMany()`가 `save()` 루프보다 빠른 것과 같은 이유입니다. SQL 문 하나가 여러 개보다 낫습니다. `deleteMany()`는 기본 키 값 배열을 받아서 `DELETE ... WHERE id IN (...)` SQL 문 하나를 생성합니다.

```typescript
const result = await em.deleteMany(User, [1, 2, 3]);
console.log(result.affected); // 3
```

```sql
-- PostgreSQL
DELETE FROM "user" WHERE "id" IN ($1, $2, $3)
-- Parameters: [1, 2, 3]

-- MySQL
DELETE FROM `user` WHERE `id` IN (?, ?, ?)
-- Parameters: [1, 2, 3]
```

### 복합 기본 키

기본 키 컬럼이 둘 이상인 엔티티에는 행마다 모든 키 컬럼을 담은 객체를 하나씩 넘깁니다.

```typescript
await em.deleteMany(OrderLine, [
  { orderId: 1, lineNo: 2 },
  { orderId: 2, lineNo: 1 },
]);
```

```sql
-- PostgreSQL
DELETE FROM "order_line"
WHERE (("order_id" = $1 AND "line_no" = $2) OR ("order_id" = $3 AND "line_no" = $4))
-- Parameters: [1, 2, 2, 1]
```

키 컬럼은 속성 이름과 컬럼 이름 가운데 어느 쪽으로 적어도 됩니다. 키가 아닌 속성은 무시하므로 조회한 엔티티를 그대로 넘겨도 됩니다. 스칼라 id를 넘기면 `InvalidQueryError`를 던집니다. 스칼라 id는 키의 일부만 가리킵니다. 그래서 그대로 삭제하면 그 값을 공유하는 행이 전부 삭제됩니다. 키 컬럼이 하나라도 빠진 객체도 같은 이유로 거부합니다.

::: tip
기본 키가 아닌 조건으로 삭제하려면 WHERE 조건과 함께 `delete()`를 사용하세요.
```typescript
await em.delete(User, { isActive: false });
```
:::

### delete() / softDelete() / restore()의 연산자 조건

criteria 객체는 동등 비교 말고 다른 조건도 받습니다. `delete()`, `softDelete()`, `restore()`는 조회의 `where`와 똑같은 find 스타일 연산자 객체를 받습니다. `{ between: [a, b] }`, `{ gt }`, `{ gte }`, `{ lt }`, `{ lte }`, `{ in }`, `{ like }` 등이 그 예입니다. `null`은 `IS NULL`로 해석합니다. 조건은 조회 경로와 같은 WhereResolver가 처리합니다. `updateMany()`는 원래부터 이 형식을 지원했습니다.

```typescript
// 중첩 집합(nested set) 서브트리 전체를 SQL 문 하나로 삭제합니다
await em.delete(Category, { lft: { between: [node.lft, node.rgt] } });

// 오래된 초안을 소프트 삭제합니다
await em.softDelete(Post, { status: "draft", updatedAt: { lt: cutoff } });

// null -> IS NULL
await em.delete(Session, { userId: null });
```

빈 criteria는 여전히 `DeleteWithoutConditionsError`를 던집니다. 테이블 전체 삭제를 막는 가드는 바뀌지 않았습니다.

### 벌크 criteria의 논리 결합자 -- AND / OR / NOT

`delete()`, `softDelete()`, `restore()`의 criteria와 `updateMany()`, `update()`의 `where`는 조회의 `where`와 똑같이 `AND`, `OR`, `NOT` 키를 받습니다. 중첩 깊이에는 제한이 없습니다. 쓰기 전에 실행하는 식별자 검사도 조회 경로와 같은 방식으로 결합자 안쪽까지 순회합니다. 그래서 `OR` 분기 안의 오타도 SQL을 실행하기 전에 같은 `Did you mean` 제안과 함께 잡아냅니다.

```typescript
// 보관됐거나 오래된 글을 SQL 문 하나로 삭제합니다
await em.delete(Post, {
  OR: [{ status: "archived" }, { updatedAt: { lt: cutoff } }],
});

// 담당자가 있는 열린 티켓만 닫습니다
await em.updateMany(Ticket, { status: "closed" }, {
  where: {
    AND: [{ status: "open" }, { NOT: { assigneeId: null } }],
  },
});

// 일반 컬럼 옆에 놓인 결합자는 find()와 마찬가지로 AND로 묶입니다
await em.softDelete(Draft, { authorId: 7, OR: [{ title: null }, { body: "" }] });
```

criteria가 조건을 하나도 만들지 못하면 빈 criteria와 똑같이 취급합니다. 그래서 테이블 전체에 적용되는 SQL 문을 실행하지 않고 `DeleteWithoutConditionsError`를 던집니다. `{ OR: [] }`, `{ AND: [] }`, `{ status: undefined }`처럼 값이 전부 `undefined`인 criteria, 안쪽이 조건을 하나도 남기지 못하는 `NOT`이 여기에 해당합니다. `updateMany()`도 같은 규칙을 따릅니다. SET 페이로드까지 비어 있는 경우도 마찬가지입니다. 예전에는 이 조합에서 criteria를 문제 삼지 않고 `{ affected: 0 }`을 반환했습니다.

`OR` 분기가 조건을 하나도 만들지 못하면 다른 에러를 던집니다. 배열 형태의 원소도 마찬가지입니다. 이 경우에는 필터가 사라지는 것이 아니라 SQL 문의 범위가 넓어지기 때문입니다. 빈 분기는 TRUE이므로 그대로 두면 `{ OR: [{ id: undefined }, { id: 2 }] }`가 모든 행에 매칭됩니다. 그래서 문제가 된 분기를 지목하는 `InvalidQueryError`를 던집니다. `AND` 안에서는 빈 분기가 항등원이므로 건너뜁니다. 나머지 조건은 그대로 적용합니다. where나 criteria 객체에서 `undefined`를 다루는 전체 규칙은 [undefined 값](./entity-manager-querying.md#undefined-값)에 있습니다.

criteria 검사는 이제 쓰기의 다른 모든 작업보다 먼저 실행합니다. 조건이 하나도 남지 않는 criteria로 `delete()`를 호출해도 `beforeDelete` 이벤트가 발생하지 않습니다. one-to-many 캐스케이드가 부모를 조회해서 자식을 먼저 삭제하는 일도 없습니다. 예전에는 트랜잭션이 그 행을 롤백(rollback)하기는 했습니다. 하지만 리스너는 이미 실행된 뒤였습니다. `softDelete()`와 `restore()`도 같은 방식으로 `beforeSoftDelete`와 `beforeRestore` 이벤트보다 먼저 막습니다.

---

## 조건부 수정 -- update()

### update()가 필요한 이유

`updateMany()`는 강력합니다. 하지만 필터에 맞는 행을 갱신하는 가장 흔한 경우에는 장황합니다. 필터를 옵션 객체 안에 넣어야 하기 때문입니다(`{ where: ... }`). 그래서 필터가 두 번째 인자인 `delete(entity, criteria)`와 호출 모양이 다릅니다. `update()`는 이 차이를 없애는 필터 우선 단축형입니다.

```typescript
// update(entity, where, data): 필터가 delete()처럼 두 번째 인자입니다
await em.update(User, { id: 1 }, { name: "Alice" });

// raw SQL 표현식도 그대로 SET 절에 전달합니다
await em.update(Post, { id: 1 }, { viewCount: sql`view_count + 1` });
```

`update()`는 내부에서 `updateMany()`에 위임합니다. 그래서 모든 안전장치를 그대로 물려받습니다. 빈 `WHERE` 가드, 테넌트 스코핑, `@UpdateTimestamp` 자동 주입, NamingStrategy 컬럼 매핑, `Sql` 표현식 지원이 여기에 해당합니다. 빈 `WHERE` 가드는 테이블 전체를 갱신하는 호출을 거부합니다. 반환값도 같은 `{ affected }`입니다.

정렬하고 개수를 제한해서 갱신해야 할 때만 `updateMany()`를 직접 쓰세요(`orderBy` + `limit`). 그 밖에는 `update()`가 더 짧고 일관된 호출입니다. 리포지토리에서도 `repo.update(where, data)`로 호출합니다.

---

## 일괄 수정 -- updateMany()

### updateMany()가 필요한 이유

같은 변경을 수천 행에 적용해야 할 때가 있습니다. 만료된 계정 비활성화, 카테고리 가격 일괄 인상, 플래그 초기화가 그 예입니다. `save()`로 처리하면 행마다 조회와 수정과 저장을 반복해야 합니다. `updateMany()`는 `UPDATE ... SET ... WHERE ...` SQL 문 하나로 한 번에 처리합니다.

```typescript
const result = await em.updateMany(User,
  { isActive: false },            // SET: 적용할 데이터
  { where: { lastLoginAt: null } }, // WHERE: 매칭 조건
);
console.log(result.affected); // number of updated rows
```

```sql
-- PostgreSQL
UPDATE "user"
SET "isActive" = $1
WHERE "lastLoginAt" IS NULL
-- Parameters: [false]

-- MySQL
UPDATE `user`
SET `isActive` = ?
WHERE `lastLoginAt` IS NULL
-- Parameters: [false]
```

`where`는 조회의 `where`가 받는 것을 전부 받습니다. `AND`, `OR`, `NOT`도 받습니다(위의 *벌크 criteria의 논리 결합자* 참고). 반면 `data` 인자는 SET 절이므로 컬럼과 값의 대응만 담습니다. 여기에 결합자 키를 넣으면 컬럼으로 해석하지 않고 `Logical combinator "OR" is not allowed in the update data` 에러로 거부합니다. 이때는 그 키를 `where`로 옮기세요.

좀 더 현실적인 예시입니다. 최근 로그인하지 않은 사용자를 비활성화합니다.

```typescript
const result = await em.updateMany(User,
  { isActive: false, deactivatedAt: new Date() },
  { where: { isActive: true } },
);
console.log(`Deactivated ${result.affected} users`);
```

```sql
-- PostgreSQL
UPDATE "user"
SET "isActive" = $1, "deactivatedAt" = $2, "updatedAt" = $3
WHERE "isActive" = $4
-- Parameters: [false, '2026-03-22 12:00:00', '2026-03-22 12:00:00', true]
```

SET 절에 `"updatedAt"` 컬럼이 자동으로 들어갔습니다. ORM은 일괄 수정에서도 `@UpdateTimestamp` 컬럼을 자동으로 주입합니다.

### soft-delete된 행은 기본적으로 제외됩니다

엔티티에 `@DeletedAt` 컬럼이 있으면 `updateMany()`는 소프트 삭제되지 않은 행만 갱신합니다. `updateMany()`에 위임하는 `update()`, `increment()`, `decrement()`도 같습니다. 어느 메서드든 `find()`와 똑같이 `WHERE`에 `"deletedAt" IS NULL`을 덧붙입니다. 그래서 일괄 수정은 소프트 삭제된 행의 데이터를 바꾸지 않습니다.

소프트 삭제된 행까지 포함하려면 `withDeleted: true`를 넘깁니다.

```typescript
// 기본: 소프트 삭제된 행은 그대로 둡니다
await em.updateMany(User, { plan: "free" }, { where: { plan: "pro" } });

// withDeleted를 명시하면 소프트 삭제된 행도 갱신합니다
await em.updateMany(
  User,
  { plan: "free" },
  { where: { plan: "pro" }, withDeleted: true },
);
```

```sql
-- 기본 (PostgreSQL)
UPDATE "user" SET "plan" = $1 WHERE "plan" = $2 AND "deletedAt" IS NULL

-- withDeleted: true이면 소프트 삭제 조건이 빠집니다
UPDATE "user" SET "plan" = $1 WHERE "plan" = $2
```

단일 테이블 상속(STI) 자식 클래스에서는 `updateMany()`가 구분 컬럼 조건도 덧붙입니다. 그래서 `updateMany(CreditCardPayment, …)`는 같은 테이블을 공유하는 형제 타입을 건드리지 않습니다. `find()`와 `delete()`가 따르는 규칙과 같습니다.

### updateMany에서 SQL 표현식 사용

계산한 값으로 갱신해야 할 때가 있습니다. 카운터 증가, 문자열 덧붙이기, 데이터베이스 함수 사용이 그 예입니다. `updateMany`는 `sql-template-tag`로 만든 raw SQL 표현식을 컬럼 값으로 받습니다.

```typescript
import sql from "sql-template-tag";

// 조회수 증가
await em.updateMany(Post,
  { viewCount: sql`"viewCount" + 1` },
  { where: { id: 1 } },
);
```

```sql
-- PostgreSQL
UPDATE "post"
SET "viewCount" = "viewCount" + 1
WHERE "id" = $1
-- Parameters: [1]
```

리터럴 값과 SQL 표현식을 한 번의 갱신에 함께 써도 됩니다.

```typescript
await em.updateMany(Product,
  {
    price: sql`"price" * 1.1`,         // 10% 가격 인상
    lastUpdatedBy: "admin",             // 리터럴 값
  },
  { where: { category: "electronics" } },
);
```

주요 특징은 다음과 같습니다.
- `@UpdateTimestamp` 컬럼을 SET 절에 자동으로 주입합니다.
- WHERE 조건이 비어 있으면 안전장치로 `DeleteWithoutConditionsError`를 던집니다.
- `save()`와 달리 엔티티 생명주기 훅과 이벤트가 발생하지 않습니다. raw 일괄 연산이기 때문입니다.

::: danger
파라미터 순서는 `(Entity, setData, { where })`입니다. `(Entity, where, setData)`가 아닙니다. 설정할 데이터가 먼저 옵니다.
:::

---

## 원자적 증감 -- increment() / decrement()

### 왜 필요할까요?

카운터는 `update()`나 `updateMany()`에 raw SQL 표현식을 넘겨서 증가시켜도 됩니다.

```typescript
import sql from "sql-template-tag";
await em.update(Post, { id: 1 }, { viewCount: sql`view_count + 1` });
```

이 방법도 동작합니다. 하지만 `sql-template-tag`를 임포트해야 합니다. 실제 DB 컬럼 이름도 알아야 하고 올바른 SQL 조각도 직접 써야 합니다. `increment()`는 이 작업을 안전하게 줄인 단축형입니다. 엔티티 속성 이름을 올바르게 이스케이프한 컬럼으로 변환합니다. `by`는 문자열로 연결하지 않고 파라미터로 바인딩합니다. 그리고 `update()`에 위임하므로 모든 안전장치를 그대로 물려받습니다.

### 사용법

```typescript
// viewCount에 1을 더합니다(by의 기본값은 1)
await em.increment(Post, { id: 1 }, "viewCount");

// balance에 50을 더합니다
await em.increment(Wallet, { userId: 7 }, "balance", 50);

// stock에서 1을 뺍니다
await em.decrement(Product, { id: 9 }, "stock");

// balance에서 100을 뺍니다
await em.decrement(Wallet, { userId: 7 }, "balance", 100);
```

호출마다 `UPDATE` 문을 하나씩 실행합니다.

```sql
-- PostgreSQL (viewCount += 1)
UPDATE "post"
SET "viewCount" = "viewCount" + $1, "updatedAt" = $2, "version" = "version" + 1
WHERE "id" = $3
-- Parameters: [1, '2026-06-13 10:00:00', 1]

-- MySQL (stock -= 1)
UPDATE `product`
SET `stock` = `stock` - ?, `updatedAt` = ?
WHERE `id` = ?
-- Parameters: [1, '2026-06-13 10:00:00', 9]
```

### 시그니처

```typescript
// EntityManager
em.increment<T>(entity: Class<T>, where: WhereClause<T>, column: keyof T & string, by?: number): Promise<{ affected: number }>
em.decrement<T>(entity: Class<T>, where: WhereClause<T>, column: keyof T & string, by?: number): Promise<{ affected: number }>

// BaseRepository (엔티티가 이미 바인딩되어 있어 첫 인자가 없습니다)
repo.increment(where: WhereClause<T>, column: keyof T & string, by?: number): Promise<{ affected: number }>
repo.decrement(where: WhereClause<T>, column: keyof T & string, by?: number): Promise<{ affected: number }>
```

### 동작 방식

- **원자적**: 증감값을 데이터베이스에서 `SET col = col + ?` 형태로 적용합니다. 그래서 두 호출이 동시에 실행돼도 합산 결과가 올바릅니다. 읽기-수정-쓰기 사이의 경쟁 상태(race condition)가 생기지 않습니다.
- **`update()`에 위임**: 빈 `WHERE` 가드, 테넌트 스코핑, NamingStrategy 컬럼 매핑, `@UpdateTimestamp` 자동 주입을 모두 물려받습니다. 빈 `WHERE` 가드는 `where`가 비어 있거나 가리키는 컬럼이 하나도 없으면 `DeleteWithoutConditionsError`를 던집니다. 엔티티에 `@Version` 낙관적 잠금 컬럼이 있으면 같은 SQL 문에서 함께 증가시킵니다.
- **`by` 기본값은 `1`**: `0`을 넘기거나 `NaN`, `Infinity` 같은 유한하지 않은 숫자를 넘기면 `InvalidQueryError`를 던집니다.
- **`{ affected }` 반환**: 데이터베이스 드라이버가 보고한 갱신 행 수입니다.

### 리포지토리 단축형

```typescript
const postRepo = em.getRepository(Post);

// em.increment(Post, { id: 1 }, "viewCount")와 같습니다
await postRepo.increment({ id: 1 }, "viewCount");

const productRepo = em.getRepository(Product);
// em.decrement(Product, { id: 9 }, "stock")와 같습니다
await productRepo.decrement({ id: 9 }, "stock");
```

---

## Upsert -- 삽입 또는 수정

### 왜 upsert가 필요할까요?

"로그인 추적" 기능을 생각해 보세요. 사용자가 로그인할 때마다 행을 새로 삽입하거나 기존 행을 갱신하려고 합니다. upsert가 없으면 다음 순서로 처리해야 합니다.

1. `findOne()`으로 행이 있는지 확인합니다.
2. 행이 있으면 기본 키를 넣어 `save()`로 UPDATE합니다.
3. 행이 없으면 기본 키 없이 `save()`로 INSERT합니다.

이 방식은 왕복이 세 번 필요합니다. 경쟁 상태도 생깁니다. 두 요청이 동시에 행이 없다고 확인하고 둘 다 INSERT를 시도하면 중복 키 에러가 납니다. upsert는 원자적인 SQL 문 하나로 두 문제를 모두 해결합니다.

### PK 기준

```typescript
await em.upsert(User, {
  id: 1,
  name: "Alice",
  email: "alice@example.com",
});
// If id=1 exists -> UPDATE name and email
// If id=1 doesn't exist -> INSERT new row
```

```sql
-- PostgreSQL
INSERT INTO "user" ("id", "name", "email")
VALUES ($1, $2, $3)
ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name", "email" = EXCLUDED."email"
-- Parameters: [1, 'Alice', 'alice@example.com']

-- MySQL
INSERT INTO `user` (`id`, `name`, `email`)
VALUES (?, ?, ?)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`), `email` = VALUES(`email`)
-- Parameters: [1, 'Alice', 'alice@example.com']
```

핵심은 PostgreSQL의 `ON CONFLICT ... DO UPDATE`와 MySQL의 `ON DUPLICATE KEY UPDATE`입니다. 둘 다 "삽입을 시도하고 지정한 컬럼에서 충돌하면 기존 행을 대신 갱신하라"는 뜻입니다.

### 유니크 컬럼 기준

세 번째 인자로 충돌 대상을 지정합니다. 각 컬럼은 페이로드처럼 속성 키로 적어도 되고 DB 컬럼 이름으로 적어도 됩니다.

```typescript
await em.upsert(User, {
  email: "alice@example.com",
  name: "Alice",
  lastLoginAt: new Date(),
}, ["email"]);
// If a row with this email exists -> UPDATE name and lastLoginAt
// If no row with this email -> INSERT
```

```sql
-- PostgreSQL
INSERT INTO "user" ("email", "name", "lastLoginAt")
VALUES ($1, $2, $3)
ON CONFLICT ("email") DO UPDATE SET "name" = EXCLUDED."name", "lastLoginAt" = EXCLUDED."lastLoginAt"
-- Parameters: ['alice@example.com', 'Alice', '2026-03-22 12:00:00']

-- MySQL
INSERT INTO `user` (`email`, `name`, `lastLoginAt`)
VALUES (?, ?, ?)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`), `lastLoginAt` = VALUES(`lastLoginAt`)
-- Parameters: ['alice@example.com', 'Alice', '2026-03-22 12:00:00']
```

### 충돌 감지 방식

충돌 컬럼은 데이터베이스가 확인할 고유 제약 조건을 가리킵니다. `["email"]`을 지정하면 데이터베이스는 삽입하려는 값과 `email`이 같은 기존 행을 찾습니다. 그런 행이 있으면 그 행을 갱신하고 없으면 새 행을 삽입합니다.

::: info
세 번째 인자로 넘기는 충돌 컬럼은 기본 키이거나 고유 제약 조건이 걸려 있어야 합니다. 그렇지 않으면 데이터베이스가 쿼리를 거부합니다. PostgreSQL에서는 `there is no unique or exclusion constraint matching the ON CONFLICT specification` 에러가 납니다.
:::

엔티티의 속성 키도 컬럼도 아닌 이름은 쿼리를 보내기 전에 `InvalidQueryError`(`ORM_INVALID_QUERY`)로 거부합니다. 에러 메시지에는 가장 가까운 컬럼이 나옵니다. 예전에는 적은 이름이 그대로 데이터베이스까지 전달됐습니다. 그래서 `SnakeNamingStrategy`에서 속성 이름 `userEmail`을 쓰면 드라이버의 알 수 없는 컬럼 에러로 실패했습니다. MySQL은 SQL 문에 충돌 대상을 적지 않으므로 오타가 있어도 그냥 넘어갔습니다.

### MySQL 8.0.19+: 행 별칭으로 읽는 제안 행

이 페이지의 MySQL SQL 예시는 MariaDB와 8.0.19 이전 MySQL이 받는 형태입니다. 충돌 분기는 제안된 값을 `VALUES(col)`로 읽습니다. MySQL 8.0.20에서 이 함수가 deprecated가 됐고 대신 행 별칭을 권장합니다. 그래서 MySQL 8.0.19 이상에서는 같은 upsert가 별칭을 선언하고 그 별칭으로 값을 읽습니다.

```sql
-- MySQL 8.0.19+
INSERT INTO `user` (`id`, `name`, `email`)
VALUES (?, ?, ?) AS `new` (`__id`, `__name`, `__email`)
ON DUPLICATE KEY UPDATE `name` = `new`.`__name`, `email` = `new`.`__email`
```

어느 형태를 쓸지는 연결할 때 조회한 서버 버전에 따라 결정됩니다. `upsert()`, `batchUpsert()`, `createInsertBuilder()`는 함께 같은 형태로 바뀝니다. MariaDB는 행 별칭을 지원하지 않으므로 `VALUES()`를 그대로 씁니다. 버전 숫자만으로는 두 서버를 구분하지 못합니다. 그래서 `versionOverride`를 함께 쓴다면 `type: "mariadb"`로 선언하세요. 버전을 조회하지 못한 서버도 `VALUES()`를 씁니다. 이 형태는 모든 MySQL과 MariaDB 서버에서 실행되지만 별칭은 그렇지 않기 때문입니다.

별칭이 컬럼 이름을 `__name`처럼 바꾸는 것은 의도한 동작입니다. 별칭에 테이블과 같은 컬럼 이름을 쓰면 UPDATE 절에서 한정자 없는 컬럼 이름이 모두 모호해집니다(MySQL 에러 1052). 그리고 그 자리의 한정자 없는 이름은 원래부터 저장된 행을 뜻했습니다. 그래서 `` sql`hits + 1` `` 같은 raw 조각도 전과 똑같이 저장된 `hits`를 읽습니다. 별칭에는 INSERT가 나열한 컬럼만 들어 있습니다. 이 때문에 `createInsertBuilder()` SQL 문이 나열하지 않은 컬럼을 제안 행에서 읽으면 ORM은 그 컬럼을 `DEFAULT`로 목록에 추가합니다. 그 결과 `VALUES(col)`과 마찬가지로 컬럼 기본값을 읽습니다.

### 배치 Upsert -- batchUpsert()

수백, 수천 행을 한 번에 upsert해야 할 때는 `batchUpsert()`가 `upsert()`를 루프에서 호출하는 것보다 훨씬 빠릅니다. `batchUpsert()`는 행을 다중 행 `INSERT ... ON CONFLICT` 문으로 묶어서 보냅니다. SQL 문은 행이 명시한 컬럼 집합마다 하나씩이고 대개는 하나뿐입니다. 명시한 컬럼이 다른 행은 같은 트랜잭션 안의 다른 SQL 문으로 보냅니다. 그래서 컬럼을 비워 둔 행이 충돌해도 저장된 값을 NULL로 덮어쓰지 않습니다.

```typescript
await em.batchUpsert(User, [
  { email: "alice@example.com", name: "Alice", loginCount: 1 },
  { email: "bob@example.com", name: "Bob", loginCount: 1 },
  { email: "charlie@example.com", name: "Charlie", loginCount: 1 },
], ["email"]);
```

```sql
-- PostgreSQL
INSERT INTO "user" ("email", "name", "loginCount")
VALUES ($1, $2, $3), ($4, $5, $6), ($7, $8, $9)
ON CONFLICT ("email") DO UPDATE SET "name" = EXCLUDED."name", "loginCount" = EXCLUDED."loginCount"

-- MySQL
INSERT INTO `user` (`email`, `name`, `loginCount`)
VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`), `loginCount` = VALUES(`loginCount`)
```

선택 인자인 세 번째 인자로 충돌 컬럼을 지정합니다. 지정 방식은 `upsert()`와 같습니다. 생략하면 기본 키를 씁니다.

### 충돌 시 관리 컬럼

`upsert()`, `insertIgnore()`, `batchUpsert()`는 ORM이 관리하는 컬럼을 페이로드의 복사본에 채웁니다. 넘긴 객체는 테넌트 컬럼을 포함해 바뀌지 않습니다. 그래서 생성된 키, 버전, 타임스탬프가 필요하면 행을 다시 조회하세요. 충돌 분기에서 기본 키와 관리 컬럼은 페이로드의 값을 쓰지 않습니다.

| 컬럼 | 새 행 삽입 | 충돌한 행 |
|------|-----------|-----------|
| 기본 키 | 넘긴 값. `"uuid"`, `"uuid-v7"` 키는 생성하고 auto-increment 키는 DB가 부여 | 쓰지 않음. 저장된 키가 유지됨 |
| 그 밖의 `"uuid"` / `"uuid-v7"` 컬럼 | 넘긴 값, 없으면 생성 | 페이로드에 값이 있을 때만 씀 |
| `@Version` | 넘긴 값, 없으면 `1` | 저장된 값 + 1 (저장된 `NULL`은 0으로 셈) |
| `@CreateTimestamp` | 넘긴 값, 없으면 현재 시각 | 쓰지 않음 |
| `@UpdateTimestamp` | 넘긴 값, 없으면 현재 시각 | 삽입 행의 값. 직접 넘기지 않았다면 현재 시각. 키와 `updatedAt`만 넘겨도 갱신됨 |
| `@DeletedAt` | 넘긴 값, 없으면 `NULL` | 페이로드에 없으면 `NULL`. 소프트 삭제된 행이 복구됨 |
| 테넌트 컬럼(`tenant_column`) | 현재 테넌트 | 쓰지 않음 |

`@Version`, `@UpdateTimestamp`, `@DeletedAt`이 있는 `Order`에서는 다음과 같습니다.

```typescript
await em.upsert(Order, { slug: "a-1", amount: 42 }, ["slug"]);
```

```sql
-- PostgreSQL (SQLite는 소문자 `excluded`만 다르고 같습니다)
INSERT INTO "order" ("slug", "amount", "version", "createdAt", "updatedAt")
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT ("slug") DO UPDATE SET "amount" = EXCLUDED."amount",
  "updatedAt" = EXCLUDED."updatedAt",
  "version" = COALESCE("order"."version", 0) + 1,
  "deletedAt" = NULL

-- MySQL / MariaDB
INSERT INTO `order` (`slug`, `amount`, `version`, `createdAt`, `updatedAt`)
VALUES (?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE `amount` = VALUES(`amount`),
  `updatedAt` = VALUES(`updatedAt`),
  `version` = COALESCE(`order`.`version`, 0) + 1,
  `deletedAt` = NULL
```

알아 둘 점은 다음과 같습니다.

- **버전은 올리기만 하고 검사하지 않습니다.** upsert는 마지막에 쓴 값이 이기는 연산이므로 `OptimisticLockError`를 던지지 않습니다. 대신 upsert 이전 버전을 가진 `save()`가 나중에 거부되도록 보장합니다. 키만 넘긴 upsert가 소프트 삭제된 행을 복구하기만 할 때는 `restore()`처럼 버전을 유지합니다. `upsert()`나 `batchUpsert()` 페이로드에 넣은 `@Version` 값은 새 행을 삽입할 때만 씁니다. 충돌하면 그 값을 무시하고 엔티티 클래스마다 한 번 경고를 남깁니다. 오래된 쓰기를 거부해야 한다면 `save()`를 쓰세요.
- **관리 컬럼만으로는 갱신이 일어나지 않습니다.** 충돌 대상 말고는 갱신할 사용자 컬럼이 없으면 SQL 문이 아무것도 바꾸지 않는 형태로 바뀝니다. PostgreSQL과 SQLite에서는 `DO NOTHING`이 됩니다. MySQL과 MariaDB에서는 `ON DUPLICATE KEY UPDATE <col> = <col>`이 됩니다. 없는 행은 삽입합니다. 소프트 삭제되지 않은 충돌 행은 버전과 타임스탬프까지 그대로 남습니다. 예외는 소프트 삭제된 충돌 행뿐입니다. 이 행은 여전히 복구합니다(`DO UPDATE SET "deletedAt" = NULL WHERE "order"."deletedAt" IS NOT NULL`). 3.0 이전에는 이런 호출이 SQL을 보내지 않고 `{ affected: 0 }`을 반환했습니다. 그래서 없는 행도 삽입하지 않았습니다.
- **소프트 삭제와 고유 키.** 일반 고유 인덱스에서는 소프트 삭제된 행도 충돌합니다. 그리고 upsert가 넘긴 값으로 그 행을 복구합니다. 소프트 삭제된 행을 건너뛰는 `updateMany()`와는 다릅니다. 새 행을 삽입하려면 부분 고유 인덱스를 만드세요(`WHERE "deletedAt" IS NULL`, PostgreSQL·SQLite). 그리고 `createInsertBuilder().onConflict(cols, { where })`로 그 인덱스를 지정하세요. `upsert()`로는 부분 인덱스를 지정하지 못합니다.
- **INSERT는 항상 시도됩니다.** DB는 충돌을 찾기 전에 NOT NULL부터 검사합니다. 그래서 행이 이미 있어도 기본값 없는 NOT NULL 컬럼은 전부 페이로드에 있어야 합니다. 컬럼도 관계도 하나 없는 페이로드는 SQL을 보내지 않고 `{ affected: 0 }`을 반환합니다.
- **관계는 외래 키로 기록됩니다.** `@ManyToOne`과 `@OneToOne` 소유자 측은 `save()`, `insertMany()`와 마찬가지로 관계 대상 인스턴스, 키 값 그대로, `${property}Id` 섀도 속성 가운데 어느 형태로 넘겨도 됩니다. 키는 INSERT에 들어갑니다. 충돌 대상에 속하지 않는 키는 다른 컬럼처럼 충돌할 때도 갱신합니다. 페이로드에 없는 관계는 저장된 키를 그대로 둡니다. 외래 키 쌍에 걸린 고유 인덱스는 섀도 속성이나 조인 컬럼으로 지정합니다. `em.upsert(Like, { user, post, weight: 3 }, ["userId", "postId"])`나 `["user_id", "post_id"]`처럼 적습니다. 캐스케이드는 없으므로 관계 대상 인스턴스에는 기본 키가 이미 있어야 합니다. 3.0 이전에는 키를 버리고 `NULL`을 저장했습니다. 그래서 충돌 대상이 외래 키이면 호출할 때마다 행이 하나씩 더 쌓였습니다.
- **JOINED 자식은 거부됩니다.** `upsert()`, `insertIgnore()`, `batchUpsert()`, `insertMany()`, `insertManyAndReturn()`, `createInsertBuilder()`는 테이블 하나에만 씁니다. 반면 테이블별 상속(TPT)의 자식은 두 테이블에 걸쳐 있습니다. 그래서 이런 자식에는 `UNSUPPORTED_OPERATION`을 던집니다. 대신 `save()`를 쓰세요. `saveMany()`는 이런 자식을 `save()`로 처리합니다.
- **`insertIgnore()`**: 삽입하는 행에는 같은 값을 채웁니다. 그리고 충돌한 행은 소프트 삭제 여부와 상관없이 절대 쓰지 않습니다.
- **`createInsertBuilder()`**: 삽입하는 행은 같은 방식으로 채웁니다. 하지만 `doUpdate()`는 나열한 컬럼만 대입합니다. 버전 증가, 타임스탬프 갱신, `@DeletedAt` 초기화는 추가하지 않습니다.

### 반환값 — `{ affected: number }`

`upsert()`와 `batchUpsert()` 모두 `Promise<{ affected: number }>`를 반환합니다.

```typescript
const result = await em.upsert(User, { id: 1, name: "Alice" });
console.log(result.affected); // MySQL: INSERT면 1, UPDATE면 2 / PostgreSQL·SQLite: 1
```

`affected` 값은 드라이버가 보고한 값을 정규화하지 않고 그대로 반환합니다.

| 드라이버 | INSERT | UPDATE | 변경 없음 | 충돌 행 건너뜀 |
|---------|--------|--------|---------|-------------|
| MySQL | 1 | 2 | 1 | 1 |
| PostgreSQL | 1 | 1 | 1 | 0 |
| SQLite | 1 | 1 | 1 | 0 |

MySQL은 `ON DUPLICATE KEY UPDATE`의 `affectedRows`를 씁니다. INSERT는 1로 세고 UPDATE는 2로 셉니다. 값이 그대로인 기존 행은 MySQL 매뉴얼에 적힌 0이 아니라 1로 셉니다. `mysql2`가 `CLIENT_FOUND_ROWS`로 접속하기 때문입니다. 이 플래그를 쓰면 변경된 행이 아니라 매칭된 행을 셉니다. `@Version`이 있는 엔티티에는 '변경 없음'이 없습니다. 충돌 분기가 버전을 올리므로 넘긴 값이 저장된 행과 전부 같아도 MySQL은 2를 보고합니다. PostgreSQL과 SQLite는 쓴 행마다 1을 반환하고 건너뛴 충돌 행은 0을 반환합니다. 충돌 행을 건너뛰는 경우는 갱신할 사용자 컬럼이 남지 않았을 때와 `tenant_column` 전략에서 다른 테넌트가 그 행을 소유할 때입니다. 앞의 경우는 [충돌 시 관리 컬럼](#충돌-시-관리-컬럼)에 설명이 있습니다.

`batchUpsert()`는 `items` 배열이 비어 있으면 `{ affected: 0 }`을 반환합니다.

리포지토리에서는 같은 기능을 `userRepo.batchUpsert(items, conflictColumns)`로 호출합니다.

### `tenantStrategy: "tenant_column"`일 때

충돌 분기는 현재 테넌트가 소유한 행만 갱신합니다. PostgreSQL과 SQLite에서는 이 조건을 `DO UPDATE ... WHERE`로 붙입니다.

```sql
INSERT INTO "user" ("email", "name", "tenant_id") VALUES ($1, $2, $3)
ON CONFLICT ("email") DO UPDATE SET "name" = EXCLUDED."name"
WHERE "user"."tenant_id" = $4
```

MySQL과 MariaDB의 `ON DUPLICATE KEY UPDATE`에는 `WHERE`가 없습니다. 그래서 대입마다 가드를 붙입니다.

```sql
INSERT INTO `user` (`email`, `name`, `tenant_id`) VALUES (?, ?, ?)
ON DUPLICATE KEY UPDATE `name` = IF(`user`.`tenant_id` = ?, VALUES(`name`), `user`.`name`)
```

알아 두면 좋은 결과는 다음과 같습니다.

- 테넌트 컬럼 자체는 갱신 목록에 들어가지 않습니다. 그래서 충돌한 행의 소유자가 바뀌지 않습니다.
- 다른 테넌트 소유라서 건너뛴 행은 PostgreSQL과 SQLite에서 affected에 들어가지 않습니다. 그리고 ORM이 엔티티 클래스마다 한 번 경고를 남깁니다. MySQL과 MariaDB는 같은 경우를 1로 보고합니다. `mysql2`가 `CLIENT_FOUND_ROWS`로 접속하므로 매칭만 돼도 세기 때문입니다. 이 숫자는 INSERT가 보고하는 숫자와 같습니다. 그래서 확실히 알아야 하면 행을 다시 조회해 보세요.
- 갱신할 사용자 컬럼이 테넌트 컬럼밖에 남지 않으면 갱신할 것이 없는 다른 upsert와 똑같이 SQL 문이 바뀝니다. PostgreSQL과 SQLite에서는 `DO NOTHING`이 됩니다. MySQL과 MariaDB에서는 아무것도 바꾸지 않는 `ON DUPLICATE KEY UPDATE`가 됩니다. INSERT는 그대로 실행하고 충돌한 행은 건드리지 않습니다.
- 관리 컬럼 대입에도 같은 가드가 붙습니다. MySQL과 MariaDB의 버전 증가는 `` `version` = IF(`user`.`tenant_id` = ?, COALESCE(`user`.`version`, 0) + 1, `user`.`version`) ``입니다. 그래서 다른 테넌트의 행은 버전이 올라가지 않고 복구되지도 않습니다.

`insertIgnore()`에는 가드가 필요 없습니다. 기존 행을 쓰는 일이 없기 때문입니다. 충돌한 키를 다른 테넌트가 소유하고 있으면 이번 INSERT를 버립니다.

---

## 표현식 기반 Upsert — createInsertBuilder()

### upsert()의 한계

충돌했을 때 `upsert()`와 `batchUpsert()`가 넘긴 컬럼으로 하는 일은 하나뿐입니다. 저장된 값을 제안한 값으로 덮어씁니다. SQL로는 `col = EXCLUDED.col`입니다. "마지막에 쓴 값이 이긴다"는 규칙이면 이것으로 충분합니다. 저장된 행을 읽어 계산하는 것은 ORM이 직접 관리하는 `@Version` 증가뿐입니다([충돌 시 관리 컬럼](#충돌-시-관리-컬럼) 참고). 이런 계산을 사용자 컬럼에는 쓰지 못합니다.

문제는 새 값이 저장된 값에 따라 달라질 때입니다.

```
records   = 저장된 records + 제안한 records          -- 누적
last_time = MAX(저장된 last_time, 제안한 last_time)   -- 최댓값 유지
```

먼저 떠오르는 우회 방법은 `find()`로 조회하고 TypeScript에서 계산한 뒤 `save()`로 다시 저장하는 것입니다. 하지만 여기에는 경쟁 상태가 있습니다. 두 요청이 동시에 `records = 10`을 조회하고 둘 다 `12`를 쓰면 증가분 하나가 사라집니다. 이 방법을 올바르게 만들려면 `SELECT … FOR UPDATE`로 행 잠금을 잡아야 합니다. 반면 SQL 문 하나로 처리하면 잠금이 필요 없습니다. 데이터베이스가 행을 잡은 채로 식을 평가하기 때문입니다.

`createInsertBuilder()`는 바로 그 SQL 문을 만듭니다.

### 카운터 누적

```typescript
import { greatest, sql } from "@stingerloom/orm";

await em.createInsertBuilder(SyncMarker)
  .values(buckets)
  .onConflict(["mac", "bucketStart"])
  .doUpdate((t, ex) => ({
    records:  t.records.add(ex.records),
    lastTime: greatest(t.lastTime, ex.lastTime),
    syncedAt: sql`NOW()`,
  }))
  .execute();
```

`doUpdate()`의 콜백은 참조를 두 개 받습니다.

- `t`: 이미 저장되어 있는 행입니다. 테이블 이름으로 한정해서 렌더링합니다(`"sync_markers"."records"`). PostgreSQL에서는 이 한정이 필수입니다. `DO UPDATE SET`과 그 `WHERE` 안에서는 대상 테이블과 `EXCLUDED`가 모두 스코프에 있기 때문입니다. 그래서 PostgreSQL은 한정하지 않은 컬럼 이름을 모호하다는 이유로 거부합니다. MySQL과 SQLite도 같은 표기를 받습니다.
- `ex`: 이 INSERT가 제안한 행입니다. PostgreSQL에서는 `EXCLUDED."col"`, SQLite에서는 `excluded."col"`로 렌더링합니다. MySQL 8.0.19+에서는 `` `new`.`__col` ``로, MariaDB와 이전 MySQL에서는 `` VALUES(`col`) ``로 렌더링합니다. MySQL 8.0.19+의 형태는 [행 별칭](#mysql-8-0-19-행-별칭으로-읽는-제안-행)에서 설명합니다.

`t`와 `ex`는 평범한 `qAlias` 참조입니다. 그래서 `.add()`, `.mul()`, `coalesce()`, `greatest()`, `CASE`, JSON 경로 같은 표현식을 모두 그대로 조합해서 씁니다.

```sql
-- PostgreSQL
INSERT INTO "sync_markers" ("mac", "bucket_start", "records", "last_time", "synced_at")
VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)
ON CONFLICT ("mac", "bucket_start") DO UPDATE
   SET "records"   = ("sync_markers"."records" + EXCLUDED."records"),
       "last_time" = GREATEST("sync_markers"."last_time", EXCLUDED."last_time"),
       "synced_at" = NOW()
```

### VALUES 리스트 만들기

`values()`는 행 하나나 행 배열을 받습니다. 여러 번 호출하면 행이 누적됩니다. 그래서 루프에서 행을 모을 때 편합니다.

```typescript
const builder = em.createInsertBuilder(SyncMarker);
for (const batch of batches) builder.values(batch.rows);
```

셀에 raw `sql` 조각을 넣어도 됩니다. 이 조각은 바인딩하지 않고 쓴 그대로 튜플에 들어갑니다. 그래서 데이터베이스가 평가합니다. `NOW()`나 시퀀스 호출이 그 예입니다.

```typescript
builder.values({ mac, bucketStart, records, syncedAt: sql`NOW()` });
// VALUES ($1, $2, $3, NOW())
```

일반 값에는 평소처럼 컬럼의 write 트랜스포머를 적용합니다. 반면 조각의 내용은 호출자가 책임집니다.

### 쿼리 결과로 삽입하기 — INSERT ... SELECT

`values(columns, query)`는 행 목록 대신 `SelectQueryBuilder`의 결과 행을 씁니다. 행이 애플리케이션을 거치지 않습니다. 그래서 주문을 일별 합계로 묶어 삽입하는 작업이 SQL 문 하나로 끝납니다. 충돌 절을 붙이면 다시 실행했을 때 이미 저장된 합계에 값을 더합니다.

```typescript
import { qAlias } from "@stingerloom/orm";

const o = qAlias(Order, "o");

await em.createInsertBuilder(DailyTotal)
  .values(
    ["day", "customerId", "total"],
    em.createQueryBuilder(Order, "o")
      .select([o.day.as("day"), o.customerId.as("customerId"), o.amount.sum().as("total")])
      .where(o.status.eq("paid"))
      .groupBy(["o.day", "o.customerId"]),
  )
  .onConflict(["day", "customerId"])
  .doUpdate((t, ex) => ({ total: t.total.add(ex.total) }))
  .execute();
```

```sql
-- PostgreSQL
INSERT INTO "daily_totals" ("day", "customer_id", "total")
SELECT "o"."day" AS "day", "o"."customer_id" AS "customerId", SUM("o"."amount") AS "total"
  FROM "orders" AS "o" WHERE "o"."status" = $1 GROUP BY "o"."day", "o"."customer_id"
ON CONFLICT ("day", "customer_id") DO UPDATE SET "total" = ("daily_totals"."total" + EXCLUDED."total")
```

SQL과 마찬가지로 쿼리가 선택한 값은 `columns`에 위치 순서대로 들어갑니다. 그래서 쿼리는 컬럼을 그 순서대로 명시해서 선택해야 합니다. 기본값인 `SELECT *`를 그대로 둔 쿼리는 거부합니다. `*`는 테이블의 물리적 컬럼 순서를 따르기 때문입니다. 이 순서는 엔티티 정의와 무관합니다. `columns`에는 엔티티 속성을 적습니다. 선언된 컬럼과 외래 키를 가진 관계가 여기에 해당합니다. 관계를 적으면 그 조인 컬럼에 값을 씁니다.

쿼리는 만든 그대로 실행합니다. 그래서 어떤 행을 복사할지는 쿼리 자체의 스코프에 따라 결정됩니다. 소프트 삭제 필터가 그대로 적용되고 `tenant_column` 전략에서는 테넌트 조건도 적용됩니다. INSERT 쪽은 `insertMany()` 규칙을 따릅니다.

- 테넌트 컬럼, SINGLE_TABLE의 구분 컬럼, `columns`에서 빠진 `@CreateTimestamp`, `@UpdateTimestamp`, `@Version` 컬럼은 ORM이 채웁니다. 그 값은 쿼리의 SELECT 목록 끝에 덧붙입니다. 테넌트 컬럼이나 구분 컬럼을 `columns`에 넣으면 에러를 던집니다. 쿼리가 그 컬럼에 아무 값이나 선택할 수 있기 때문입니다.
- ORM이 행마다 생성하는 키는 이 경로에서 생성할 대상 행이 없습니다(`@PrimaryGeneratedColumn("uuid")`, `"uuid-v7"`). 그래서 쿼리에서 직접 선택하고 `columns`에도 넣어야 합니다. 그러지 않으면 `UNSUPPORTED_OPERATION`을 던집니다. 다만 PostgreSQL의 `uuid` 키는 컬럼 `DEFAULT`가 생성하므로 예외입니다.
- 선택한 값은 데이터베이스 밖으로 나오지 않으므로 write 트랜스포머를 적용하지 않습니다.

충돌 절은 VALUES 목록일 때와 같습니다. 다만 제한이 하나 있습니다. VALUES 목록에서는 쓰지 않은 컬럼을 제안 행에서 읽으면 컬럼 기본값을 반환합니다. 하지만 INSERT ... SELECT에서 그런 읽기는 거의 확실히 실수입니다. 그래서 그런 컬럼을 `ex`에서 읽는 `doUpdate()`는 에러를 던집니다.

다이얼렉트마다 쿼리를 감싸는 형태가 다릅니다. 빌더는 다이얼렉트에 맞는 형태를 자동으로 고릅니다.

- **SQLite**는 충돌 절이 뒤따르면 쿼리를 `SELECT * FROM (…) WHERE true`로 감쌉니다. 감싸지 않으면 SQLite가 `ON CONFLICT`의 `ON`을 조인 조건으로 해석하기 때문입니다.
- **MySQL 8.0.19+**: SELECT 형태에는 행 별칭이 없습니다. 그래서 `doUpdate()`는 같은 이름의 파생 테이블 `SELECT * FROM (…) AS new (__day, …)`에서 제안 행을 읽습니다. 그 결과 deprecated된 `VALUES()`를 쓰지 않습니다. MariaDB와 이전 MySQL은 `VALUES()`를 씁니다.
- **PostgreSQL**은 ORM이 덧붙인 값을 `DISTINCT` SELECT 목록 바깥으로 옮깁니다. 목록 안에 두면 PostgreSQL이 그 값의 타입을 text로 판단합니다. 그러면 timestamp 컬럼이 그 값을 거부합니다.

`executeAndReturn()`은 INSERT가 `RETURNING`을 지원하는 곳에서 쓴 행을 반환합니다. PostgreSQL, SQLite, 충돌 절이 없을 때의 MariaDB 10.5+가 여기에 해당합니다. 나머지 경우에는 `UNSUPPORTED_OPERATION`을 던집니다. MySQL에서는 쓴 행을 키로 다시 조회합니다. 하지만 쿼리로 쓴 행에는 ORM이 다시 조회할 키 값이 없습니다.

윈도 함수, 집합 연산, CTE처럼 `SelectQueryBuilder`로 표현하지 못하는 소스는 raw SQL 문 `em.query(sql\`INSERT INTO … ${rawQb.build()}\`)`으로 씁니다. 이 경우 ORM은 아무것도 채우지 않습니다. 그래서 테넌트 스코프도 직접 작성해야 합니다.

### doUpdate()의 세 가지 형태

```typescript
// 1. 나열한 컬럼을 제안한 값으로 덮어씁니다. upsert()와 같은 형태입니다.
//    다만 @Version / @UpdateTimestamp / @DeletedAt 처리는 없습니다.
.doUpdate(["name", "email"])

// 2. 리터럴 값과 raw SQL
.doUpdate({ status: "seen", seenAt: sql`NOW()` })

// 3. 저장된 행과 제안한 행에 걸친 표현식
.doUpdate((t, ex) => ({ hits: t.hits.add(ex.hits) }))
```

2번 형태의 리터럴 값에는 `insertMany()`의 값과 똑같이 컬럼의 write 트랜스포머를 적용합니다.

### 충돌 무시 — doNothing()

```typescript
await em.createInsertBuilder(AuditLog)
  .values(entries)
  .onConflict(["requestId"])
  .doNothing()
  .execute();
```

MySQL에서는 `INSERT IGNORE`가 됩니다. `INSERT IGNORE`는 중복 키뿐 아니라 그 SQL 문의 모든 에러를 경고로 낮춥니다. 이 점에 주의하세요. `insertIgnore()`가 이미 감수하는 것과 같은 단점입니다.

### 갱신 대상 좁히기 — doUpdateWhere()

제안한 측정값이 실제로 더 최신일 때만 행을 갱신하려는 경우가 있습니다. 이때는 조건에서 저장된 행과 제안한 행을 직접 비교합니다. `doUpdate()`와 똑같이 한정하지 않은 참조는 저장된 행을 읽고 `qExcluded` 참조는 제안한 행을 읽습니다.

```typescript
import { qAlias, qExcluded } from "@stingerloom/orm";

const m  = qAlias(Reading, "m");
const ex = qExcluded(Reading);

await em.createInsertBuilder(Reading)
  .values(rows)
  .onConflict(["sensorId"])
  .doUpdate((t, x) => ({ value: x.value, takenAt: x.takenAt }))
  .doUpdateWhere(m.takenAt.lt(ex.takenAt))
  .execute();
```

```sql
-- PostgreSQL
… DO UPDATE SET "value" = EXCLUDED."value", "taken_at" = EXCLUDED."taken_at"
  WHERE "readings"."taken_at" < EXCLUDED."taken_at"
```

조건을 통과하지 못한 행은 그대로 남습니다. 그래서 오래된 배치를 다시 실행해도 데이터가 과거 값으로 돌아가지 않습니다. 읽기-수정-쓰기 왕복 없이도 쓰기가 멱등이 됩니다.

`doUpdateWhere()`는 PostgreSQL과 SQLite 전용입니다. `ON DUPLICATE KEY UPDATE`에는 `WHERE`가 없습니다. 그래서 MySQL에서는 이 조건을 무시하지 않고 에러를 던집니다. MySQL에서 같은 의도를 표현하려면 `iff()`로 조건을 각 대입 값 안에 넣으세요. `iff()`는 `CASE` 식으로 렌더링되므로 세 다이얼렉트에서 모두 동작합니다.

```typescript
import { iff } from "@stingerloom/orm";

.doUpdate((t, x) => ({
  value:   iff(x.takenAt.gt(t.takenAt), x.value, t.value),
  takenAt: iff(x.takenAt.gt(t.takenAt), x.takenAt, t.takenAt),
}))
// "value" = CASE WHEN EXCLUDED."taken_at" > "taken_at" THEN EXCLUDED."value" ELSE "value" END, …
```

가드가 거짓이면 모든 컬럼이 저장된 값을 유지하므로 결과는 같습니다. 대신 조건을 컬럼마다 반복해야 합니다.

### 부분 유니크 인덱스와 제약 이름

```typescript
// ON CONFLICT ("email") WHERE "deleted_at" IS NULL DO UPDATE …
.onConflict(["email"], { where: u.deletedAt.isNull() })

// ON CONFLICT ON CONSTRAINT "user_email_key" DO UPDATE …   (PostgreSQL 전용)
.onConflictConstraint("user_email_key")
```

`{ where }`는 충돌을 판정할 인덱스를 좁힙니다. 고유 인덱스 자체가 부분 인덱스일 때 필요합니다. `doUpdateWhere()`는 충돌한 행 가운데 갱신할 행을 좁힙니다. 둘은 서로 다른 절이므로 함께 써도 됩니다.

### 쓴 행 돌려받기 — executeAndReturn()

`execute()`는 영향받은 행 수만 반환합니다. `executeAndReturn()`은 같은 SQL 문을 실행합니다. 그리고 그 SQL 문이 쓴 행을 엔티티 인스턴스로 반환합니다. 반환한 행에는 생성된 키, DB 기본값, 충돌 절이 계산한 값이 모두 들어 있습니다.

```typescript
const [marker] = await em.createInsertBuilder(SyncMarker)
  .values({ mac, bucketStart, records: 3, lastTime })
  .onConflict(["mac", "bucketStart"])
  .doUpdate((t, ex) => ({ records: t.records.add(ex.records) }))
  .executeAndReturn();

marker.records; // 이번 쓰기 이후 저장된 누적값
```

누적값을 `find()`로 따로 조회하면 그사이 실행된 다른 쓰기의 결과까지 섞일 수 있습니다. 반면 반환한 행은 이 SQL 문이 쓴 바로 그 행입니다.

반환하는 행은 다음과 같습니다.

- 삽입한 행과 충돌 절이 갱신한 행 전부입니다. SQL 문이 건너뛴 행은 들어 있지 않습니다. `doNothing()`으로 건너뛴 행, `doUpdateWhere()` 조건을 통과하지 못한 행, `tenant_column` 전략에서 다른 테넌트의 행이 그렇습니다.
- 엔티티를 조회할 때와 같은 방식으로 만듭니다. 컬럼 이름을 속성으로 매핑하고 읽기 트랜스포머를 적용합니다. 관계는 로드하지 않습니다.

PostgreSQL과 SQLite에서는 `RETURNING *`을 쓰므로 여러 행을 쓰는 SQL 문도 모든 행을 반환합니다. MySQL에는 `RETURNING`이 없습니다. 그래서 `executeAndReturn()`은 호출마다 한 행만 쓰고 같은 트랜잭션에서 그 행을 다시 조회합니다.

- auto-increment 기본 키는 `LAST_INSERT_ID()`로 받습니다. 갱신 경로에서는 충돌 절에 `id = LAST_INSERT_ID(id)`를 함께 넣습니다. 이 대입은 키 값을 바꾸지 않습니다.
- 그 밖의 행은 `onConflict()` 컬럼이나 기본 키로 다시 조회합니다. `onConflict()` 컬럼은 갱신한 행을 조회할 때 씁니다. 그래서 행에 그 값이 들어 있어야 하고 그 컬럼이 고유 키를 이뤄야 합니다.

두 행 이상을 넘기면 쿼리를 보내기 전에 `UNSUPPORTED_OPERATION`을 던집니다. MariaDB 10.5+는 충돌 절이 없는 INSERT라면 `RETURNING`으로 행을 반환합니다. 충돌 절이 있으면 MySQL과 같은 경로로 처리합니다. `ON DUPLICATE KEY UPDATE`나 `INSERT IGNORE`로 처리한 행에서 MariaDB의 `RETURNING`이 무엇을 보고하는지 명세가 없기 때문입니다. [INSERT ... SELECT](#쿼리-결과로-삽입하기-—-insert-select)는 다시 조회할 행이 없으므로 이 경로에서 에러를 던집니다.

### SQL 확인

`build()`는 `Sql` 조각을 반환합니다. `toSql()`은 SQL 텍스트와 바인딩 값을 반환합니다. 어느 쪽도 쿼리를 실행하지 않습니다.

```typescript
const { text, values } = em.createInsertBuilder(SyncMarker)
  .values(rows)
  .onConflict(["mac", "bucketStart"])
  .doUpdate((t, ex) => ({ records: t.records.add(ex.records) }))
  .toSql();
```

테넌트 스코프는 실행할 때 적용하므로 `build()` 결과에는 나타나지 않습니다. 테넌트 컬럼 채우기가 그렇습니다. `tenant_column` 전략에서 `doUpdate()`가 다른 테넌트의 행을 건드리지 못하게 막는 가드도 마찬가지입니다. 이 가드는 직접 지정한 `doUpdateWhere()` 조건과 AND로 결합합니다.

### 동작 참고

- **`createUpdateBuilder()`와 마찬가지로 SQL 문 단위 API입니다.** `beforeInsert`, `afterInsert` 이벤트와 엔티티 훅은 발생하지 않습니다. 테넌트 컬럼, `@CreateTimestamp`, `@UpdateTimestamp`, `@Version` 기본값, 생성 UUID 키, 컬럼 트랜스포머는 삽입하는 행에 `insertMany()`와 똑같이 적용합니다. 충돌 절은 직접 나열한 컬럼만 대입합니다.
- **SQL 문 하나 안의 중복 키는 자동으로 합치지 않습니다.** PostgreSQL은 같은 충돌 대상을 두 번 건드리는 `VALUES` 목록을 거부합니다(`ON CONFLICT DO UPDATE command cannot affect row a second time`). SQLite는 행을 차례로 적용하므로 누적이 겹칩니다. SQL 문을 만들기 전에 호출하는 쪽에서 중복을 합치세요.
- **`affected`는 드라이버가 보고한 값 그대로**입니다. `upsert()`와 같은 MySQL 1 대 2 주의 사항이 적용됩니다.
- 리포지토리에서는 `markerRepo.createInsertBuilder()`로 씁니다.

### 드라이버 지원

| 기능 | PostgreSQL | MySQL / MariaDB | SQLite |
|------|-----------|-----------------|--------|
| `doUpdate()` 표현식 | 지원 | 지원 | 지원 |
| `excluded` 참조 | `EXCLUDED.col` | `new.__col`(MySQL 8.0.19+), `VALUES(col)`(MariaDB, 이전 MySQL) | `excluded.col` |
| `onConflict([...])` 컬럼 | 지원 | 받되 생성하지 않음 | 지원 |
| `onConflict(..., { where })` | 지원 | 에러를 던짐 | 지원 |
| `onConflictConstraint()` | 지원 | 에러를 던짐 | 에러를 던짐 |
| `doNothing()` | `DO NOTHING` | `INSERT IGNORE` | `DO NOTHING` |
| `doUpdateWhere()` | 지원 | 에러를 던짐 | 지원 |
| `executeAndReturn()` | `RETURNING *` | 호출당 한 행을 쓰고 키로 다시 조회 (MariaDB 10.5+의 충돌 절 없는 INSERT는 `RETURNING *`). INSERT ... SELECT는 에러를 던짐 | `RETURNING *` |
| `values(columns, query)` | 쿼리 그대로 | 쿼리 그대로. MySQL 8.0.19+의 `doUpdate()`는 파생 테이블 `AS new (…)` | 충돌 절 앞에서 `SELECT * FROM (…) WHERE true` |

MySQL은 모든 고유 키를 한꺼번에 충돌 대상으로 삼습니다. 그래서 지정할 충돌 대상 자체가 없습니다. 그래도 `.onConflict([...])`를 붙여 두는 편이 좋아요. 같은 호출을 PostgreSQL로 그대로 옮기기 쉽기 때문입니다. 컬럼 검사는 모든 다이얼렉트에서 똑같이 실행합니다. `.onConflict()`는 속성 키나 DB 컬럼 이름을 받습니다. 속성 키에는 `customerId` 같은 외래 키 섀도 속성도 포함됩니다. 엔티티에 없는 이름을 넘기면 `InvalidQueryError`를 던집니다.

---

## 트랜잭션

### 왜 트랜잭션이 필요할까요?

EntityManager의 개별 연산은 각각 자동으로 트랜잭션에 감싸서 실행합니다. `save`, `find`, `delete` 등이 그렇습니다. 그렇다면 두 연산이 반드시 함께 성공하거나 함께 실패해야 할 때는 어떻게 할까요?

이커머스 결제를 생각해 보세요. 주문을 생성하고 재고를 차감합니다. 주문 생성은 성공했는데 재고 차감이 실패할 수도 있습니다. 그러면 주문은 생겼는데 상품은 여전히 "구매 가능"으로 남습니다. 데이터가 서로 맞지 않게 됩니다. 트랜잭션은 연산을 원자적 단위로 묶어서 이 문제를 해결합니다. 모든 변경이 커밋되거나 모든 변경이 롤백됩니다.

### 콜백 API -- transaction()

트랜잭션을 쓰는 가장 간단한 방법입니다. 콜백은 `this` EntityManager를 받습니다. 그리고 콜백 안의 모든 연산이 같은 트랜잭션을 공유합니다.

```typescript
const order = await em.transaction(async (txEm) => {
  const order = await txEm.save(Order, {
    userId: 1,
    status: "pending",
  });

  await txEm.insertMany(OrderItem, [
    { orderId: order.id, productId: 10, quantity: 2 },
    { orderId: order.id, productId: 20, quantity: 1 },
  ]);

  return order;
  // COMMIT on success
});
// If any operation throws -> ROLLBACK automatically
```

이 트랜잭션에서 실행하는 SQL을 순서대로 보면 다음과 같습니다.

```sql
-- 1. Open a connection and start the transaction
BEGIN

-- 2. Insert the order
INSERT INTO "order" ("userId", "status") VALUES ($1, $2) RETURNING *
-- Parameters: [1, 'pending']

-- 3. Insert order items (single multi-row statement)
INSERT INTO "order_item" ("orderId", "productId", "quantity")
VALUES ($1, $2, $3), ($4, $5, $6)
-- Parameters: [1, 10, 2, 1, 20, 1]

-- 4a. If everything succeeded:
COMMIT

-- 4b. If any query threw an error:
ROLLBACK
```

`BEGIN`과 `COMMIT`, `ROLLBACK`은 자동으로 처리합니다. 직접 작성하지 않아도 됩니다.

### 에러 발생 시 동작

콜백 안의 연산이 에러를 던지면 ORM은 다음 순서로 처리합니다.

1. 에러를 잡습니다.
2. `ROLLBACK`을 실행해서 트랜잭션 안의 모든 변경을 되돌립니다.
3. 원래 에러를 다시 던집니다. 그래서 애플리케이션 코드에서 그 에러를 잡아 처리하면 됩니다.

그래서 데이터베이스가 절반만 반영된 상태로 남지 않습니다. 모든 변경이 적용되거나 아무것도 적용되지 않습니다.

### 데드락 재시도

동시성이 높은 상황에서는 데드락(deadlock)이 생길 수 있습니다. 여러 사용자가 같은 상품을 구매하는 경우가 그 예입니다. 데드락은 두 트랜잭션이 서로 상대의 잠금 해제를 기다리느라 둘 다 진행하지 못하는 상태입니다. 데이터베이스는 데드락을 감지하면 트랜잭션 하나를 종료합니다.

`transaction()` 메서드는 자동 재시도를 지원합니다.

```typescript
await em.transaction(async (txEm) => {
  const stock = await txEm.findOne(Inventory, {
    where: { productId: 42 },
    lock: LockMode.PESSIMISTIC_WRITE,
  });

  if (stock.quantity < 1) {
    throw new Error("Out of stock");
  }

  stock.quantity -= 1;
  await txEm.save(Inventory, stock);
}, {
  retryOnDeadlock: true,  // Enable deadlock retry
  maxRetries: 3,          // Maximum attempts (default: 3)
  retryDelayMs: 100,      // Delay between retries in ms (default: 100)
});
```

ORM은 다이얼렉트마다 다음 에러를 데드락으로 감지합니다.
- **MySQL**: `errno 1213` (ER_LOCK_DEADLOCK)
- **PostgreSQL**: `code 40P01` (deadlock_detected)
- **SQLite**: `SQLITE_BUSY` / "database is locked"

데드락을 감지하면 콜백 전체를 처음부터 다시 실행합니다. 그래서 콜백은 멱등(idempotent)해야 합니다. 안전하게 반복하지 못하는 데이터베이스 바깥의 부수 효과가 없어야 합니다. 이메일 발송이 그 예입니다.

### 데코레이터 기반 트랜잭션

NestJS 서비스에서는 콜백 API 대신 `@Transactional()` 데코레이터를 써도 됩니다. 데코레이터 사용법, 격리 수준, 세이브포인트는 [트랜잭션](./transactions.md)에 자세히 있습니다.

---

## Raw SQL -- query()

### 왜 Raw SQL이 필요할까요?

EntityManager API는 데이터베이스 작업의 90%를 처리합니다. 하지만 API가 제공하지 않는 기능이 필요할 때가 있습니다. 윈도 함수, CTE(Common Table Expressions), DB 전용 문법, raw SQL로 쓰는 편이 더 읽기 쉬운 복잡한 조인이 그 예입니다.

`query()`는 이럴 때 쓰는 탈출구입니다. 어떤 SQL이든 실행하면서도 ORM의 연결 관리, 트랜잭션 처리, 파라미터 바인딩을 그대로 씁니다.

### sql-template-tag 사용 (권장)

```typescript
import sql from "sql-template-tag";

const users = await em.query<{ id: number; name: string }>(
  sql`SELECT * FROM "user" WHERE "age" > ${18} AND "city" = ${"Seoul"}`
);
```

문자열 보간처럼 보이지만 그렇지 않습니다. `sql-template-tag`의 `sql` 템플릿 태그가 쿼리 텍스트와 파라미터 값을 자동으로 분리합니다. 실제로 데이터베이스에 보내는 내용은 다음과 같습니다.

```sql
-- Query text (sent to database)
SELECT * FROM "user" WHERE "age" > $1 AND "city" = $2
-- Parameters (sent separately): [18, 'Seoul']
```

데이터베이스는 쿼리 구조와 값을 따로 받습니다. 그래서 `'; DROP TABLE user; --` 같은 악의적인 값도 리터럴 문자열로 처리하고 SQL 코드로 실행하지 않습니다. 이 방식을 **파라미터화된 쿼리**(parameterized query)라고 합니다. 파라미터화된 쿼리는 SQL 인젝션을 막는 주요 수단입니다.

### 문자열 + 파라미터 배열 사용

```typescript
const posts = await em.query<{ id: number; title: string }>(
  "SELECT id, title FROM post WHERE author_id = $1",
  [42]
);
```

```sql
-- Query text
SELECT id, title FROM post WHERE author_id = $1
-- Parameters: [42]
```

::: warning
Raw SQL 문자열을 쓸 때는 반드시 파라미터 바인딩을 사용하세요(`$1`, `?` 등). 사용자 입력을 문자열에 직접 연결하면 안 됩니다.
:::

### 반환 타입

`query<T>()`는 `T[]`를 반환합니다. 결과 행의 타입은 제네릭 파라미터 `T`로 지정합니다.

```typescript
interface MonthlyStats {
  month: string;
  total_orders: number;
  revenue: number;
}

const stats = await em.query<MonthlyStats>(sql`
  SELECT
    TO_CHAR("created_at", 'YYYY-MM') AS month,
    COUNT(*) AS total_orders,
    SUM("amount") AS revenue
  FROM "order"
  WHERE "created_at" >= ${startDate}
  GROUP BY TO_CHAR("created_at", 'YYYY-MM')
  ORDER BY month DESC
`);
```

```sql
-- PostgreSQL
SELECT
  TO_CHAR("created_at", 'YYYY-MM') AS month,
  COUNT(*) AS total_orders,
  SUM("amount") AS revenue
FROM "order"
WHERE "created_at" >= $1
GROUP BY TO_CHAR("created_at", 'YYYY-MM')
ORDER BY month DESC
-- Parameters: [startDate]
```

`T[]` 반환 타입은 런타임에 검증하지 않습니다. 작성한 타입 어노테이션을 그대로 믿습니다. 그래서 SQL이 인터페이스와 맞지 않는 컬럼을 반환해도 TypeScript는 컴파일할 때 잡아내지 못합니다. 제네릭 파라미터는 런타임 보장이 아니라 팀을 위한 문서로 생각하세요.

CTE, UNION, 윈도 함수, 서브쿼리의 전체 사용법은 [Raw SQL & CTE](./raw-sql.md)에 있습니다.

---

## 다음 단계

- [CRUD 기본](./entity-manager.md): save, find, delete, 소프트 삭제
- [쿼리 & 페이지네이션](./entity-manager-querying.md): SELECT, 페이지네이션, 스트리밍, 집계
- [고급 기능](./entity-manager-advanced.md): 이벤트, 구독자, 멀티테넌시, 플러그인, FindOption 레퍼런스
