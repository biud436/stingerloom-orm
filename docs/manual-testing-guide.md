# 추가 테스트 시나리오 가이드

유닛 테스트 1,400개 + 통합 테스트 + e2e 59개를 모두 통과했지만, 실제 사용에서 ManyToOne FK save 버그가 발견되었습니다. 이 문서는 기존 자동화 테스트가 커버하지 못한 맹점을 정리하고, 향후 통합 테스트로 자동화할 시나리오 목록을 제공합니다.

## 기존 테스트의 맹점

### 1. 유닛 테스트가 구현을 검증하지, 사용자 계약을 검증하지 않는다

mock 기반 유닛 테스트는 SQL 생성 여부만 확인합니다. 실제 DB round-trip(save → findOne)은 통합 테스트에서만 검증 가능합니다.

```typescript
// 유닛 테스트가 검증하는 것: "SQL에 owner_id가 포함되었는가?"
expect(executedSql).toContain("owner_id");

// 통합 테스트에서 검증해야 하는 것: "DB에서 다시 읽었을 때 owner가 붙어있는가?"
const cat = await repo.findOne({ where: { id: 1 }, relations: ["owner"] });
expect(cat.owner.id).toBe(7);
```

### 2. 테스트가 "내부자" 패턴만 사용한다

기존 테스트는 `parentFk: parent.id`처럼 FK 컬럼에 직접 값을 넣습니다. 하지만 문서를 읽은 사용자는 `cat.owner = ownerEntity`처럼 **관계 객체를 할당**하는 패턴을 사용합니다. 이 패턴이 테스트에 없었기 때문에 버그에 빠졌습니다.

### 3. 반환 타입 불일치

`BaseRepository.save()`의 반환 타입은 `EntityResult<T>` (`T | T[] | undefined`)입니다. 사용자가 문서대로 단일 객체를 기대하고 바로 프로퍼티에 접근하면 타입 에러가 발생합니다.

```typescript
const result = await repo.save(cat);
const saved = Array.isArray(result) ? result[0] : result; // 방어 코드 필요
```

---

## Junior 시나리오 — 기본 CRUD와 관계 설정

> 문서를 읽고 가장 직관적인 방식으로 코드를 작성했을 때 동작해야 하는 시나리오.

### J-1. 엔티티 생성 후 즉시 조회

```typescript
const owner = await ownerRepo.save({ name: "Alice" });
const found = await ownerRepo.findOne({ where: { id: owner.id } });
```

| #   | 체크 항목                         | 통과 | 비고                |
| --- | --------------------------------- | ---- | ------------------- |
| 1   | `owner`에 `id`가 포함되어 있는가? |      | AUTO_INCREMENT 반환 |
| 2   | `found`가 `null`이 아닌가?        |      |                     |
| 3   | `found.name === "Alice"`인가?     |      |                     |

### J-2. ManyToOne 관계 — 객체 할당 후 save

문서에서 `@ManyToOne`을 보고 가장 먼저 시도할 패턴:

```typescript
const owner = await ownerRepo.save({ name: "Alice" });
const cat = { name: "Nabi", owner: owner }; // ← 관계 객체 직접 할당
const saved = await catRepo.save(cat);
```

| #   | 체크 항목                                                                          | 통과 | 비고              |
| --- | ---------------------------------------------------------------------------------- | ---- | ----------------- |
| 1   | `saved`에 에러 없이 반환되는가?                                                    |      |                   |
| 2   | DB에서 cat의 `owner_id`가 `owner.id`와 일치하는가?                                 |      | FK 컬럼 직접 확인 |
| 3   | `findOne({ where: { id: saved.id } })`로 조회 시 `cat.owner.name === "Alice"`인가? |      | eager 로딩        |

### J-3. ManyToOne 관계 — FK 컬럼 직접 지정

`@Column()`으로 FK 필드를 직접 선언한 경우:

```typescript
const owner = await ownerRepo.save({ name: "Alice" });
const cat = await catRepo.save({ name: "Nabi", ownerFk: owner.id });
```

| #   | 체크 항목                          | 통과 | 비고         |
| --- | ---------------------------------- | ---- | ------------ |
| 1   | INSERT SQL에 FK 컬럼이 포함되는가? |      |              |
| 2   | 조회 시 owner 관계가 로드되는가?   |      | eager인 경우 |

### J-4. save() 반환값 사용

```typescript
const result = await catRepo.save({ name: "Nabi" });
console.log(result.name); // 타입 에러? 런타임 에러?
```

| #   | 체크 항목                                                   | 통과 | 비고                    |
| --- | ----------------------------------------------------------- | ---- | ----------------------- |
| 1   | `result`가 단일 객체인가, 배열인가?                         |      | `EntityResult<T>` union |
| 2   | `Array.isArray(result)` 없이 바로 프로퍼티 접근이 가능한가? |      | TS 컴파일 에러 여부     |
| 3   | `findOne()`은 항상 단일 객체 또는 `null`을 반환하는가?      |      | `T \| null` 타입        |

### J-5. 존재하지 않는 ID 조회

```typescript
const cat = await catRepo.findOne({ where: { id: 999999 } });
```

| #   | 체크 항목                         | 통과 | 비고      |
| --- | --------------------------------- | ---- | --------- |
| 1   | `cat`이 `null`인가? (에러 아닌지) |      |           |
| 2   | undefined가 아닌 null인가?        |      | 문서 계약 |

### J-6. 빈 테이블에서 find()

```typescript
const cats = await catRepo.find({});
```

| #   | 체크 항목                          | 통과 | 비고              |
| --- | ---------------------------------- | ---- | ----------------- |
| 1   | 에러 없이 반환되는가?              |      |                   |
| 2   | 빈 배열 `[]`인가, `undefined`인가? |      | `EntityResult<T>` |

---

## Middle 시나리오 — 관계 변경, 삭제, 트랜잭션

> 프로덕션에서 흔히 발생하는 관계 수정, 삭제, 트랜잭션 패턴.

### M-1. ManyToOne 관계 변경 (부모 재할당)

```typescript
const owner1 = await ownerRepo.save({ name: "Alice" });
const owner2 = await ownerRepo.save({ name: "Bob" });
const cat = await catRepo.save({ name: "Nabi", owner: owner1 });

// 주인 변경
cat.owner = owner2;
await catRepo.save(cat);
```

| #   | 체크 항목                                             | 통과 | 비고                  |
| --- | ----------------------------------------------------- | ---- | --------------------- |
| 1   | DB에서 cat의 `owner_id`가 `owner2.id`로 변경되었는가? |      |                       |
| 2   | 이전 주인(`owner1`)의 cats 목록에서 제거되었는가?     |      | `relations: ["cats"]` |
| 3   | 새 주인(`owner2`)의 cats 목록에 추가되었는가?         |      |                       |

### M-2. ManyToOne 관계 해제 (null 할당)

```typescript
cat.owner = null;
await catRepo.save(cat);
```

| #   | 체크 항목                             | 통과 | 비고            |
| --- | ------------------------------------- | ---- | --------------- |
| 1   | DB에서 cat의 `owner_id`가 `NULL`인가? |      |                 |
| 2   | 조회 시 `cat.owner`가 `null`인가?     |      | eager 로딩 결과 |
| 3   | 이전 주인의 cats 목록에서 사라졌는가? |      |                 |

### M-3. OneToMany + Cascade Insert

```typescript
const owner = await ownerRepo.save({
  name: "Alice",
  cats: [{ name: "Nabi" }, { name: "Cheese" }],
});
```

| #   | 체크 항목                                          | 통과 | 비고    |
| --- | -------------------------------------------------- | ---- | ------- |
| 1   | owner가 정상 저장되었는가?                         |      |         |
| 2   | cats 2마리가 모두 생성되었는가?                    |      |         |
| 3   | 각 cat의 `owner_id`가 owner.id와 일치하는가?       |      | FK 확인 |
| 4   | `relations: ["cats"]`로 조회 시 cats가 로드되는가? |      |         |

### M-4. 삭제 — 관계가 있는 엔티티 삭제

```typescript
// 자식이 있는 부모를 삭제하면?
await ownerRepo.delete({ id: owner.id });
```

| #   | 체크 항목                                   | 통과 | 비고              |
| --- | ------------------------------------------- | ---- | ----------------- |
| 1   | FK 제약 위반 에러가 발생하는가?             |      | cascade 없는 경우 |
| 2   | 에러 메시지가 이해 가능한가?                |      | OrmError 포맷     |
| 3   | 자식을 먼저 삭제 후 부모 삭제가 성공하는가? |      |                   |

### M-5. Soft Delete + 관계

```typescript
await catRepo.softDelete({ id: cat.id });

const found = await catRepo.findOne({ where: { id: cat.id } });
const foundWithDeleted = await catRepo.findOne({
  where: { id: cat.id },
  withDeleted: true,
});
```

| #   | 체크 항목                                  | 통과 | 비고                |
| --- | ------------------------------------------ | ---- | ------------------- |
| 1   | `found`가 `null`인가?                      |      | soft deleted        |
| 2   | `foundWithDeleted`가 존재하는가?           |      | `withDeleted: true` |
| 3   | `foundWithDeleted.deletedAt`이 날짜값인가? |      | `@DeletedAt`        |
| 4   | restore 후 정상 조회 되는가?               |      |                     |

### M-6. Update — 부분 업데이트

```typescript
const cat = await catRepo.findOne({ where: { id: 1 } });
await catRepo.save({ id: cat.id, name: "NewName" });
// 다른 필드(owner 등)가 유지되는가?
```

| #   | 체크 항목                                 | 통과 | 비고                          |
| --- | ----------------------------------------- | ---- | ----------------------------- |
| 1   | `name`만 변경되고 다른 필드가 보존되는가? |      | partial update                |
| 2   | `owner` 관계가 유지되는가?                |      | FK가 null로 초기화되지 않는지 |

### M-7. Upsert

```typescript
await catRepo.upsert({ name: "Nabi", age: 3 }, { conflictColumns: ["name"] });
```

| #   | 체크 항목                              | 통과 | 비고        |
| --- | -------------------------------------- | ---- | ----------- |
| 1   | 최초 실행 시 INSERT 되는가?            |      |             |
| 2   | 동일 name으로 재실행 시 UPDATE 되는가? |      | ON CONFLICT |
| 3   | 충돌 시 age 값이 갱신되는가?           |      |             |

### M-8. Batch 연산

```typescript
const cats = await catRepo.insertMany([
  { name: "A" },
  { name: "B" },
  { name: "C" },
]);
```

| #   | 체크 항목                                      | 통과 | 비고          |
| --- | ---------------------------------------------- | ---- | ------------- |
| 1   | 3건 모두 삽입되었는가?                         |      | `affected: 3` |
| 2   | `deleteMany([id1, id2])`로 일괄 삭제 가능한가? |      |               |
| 3   | 중간에 하나가 실패하면 전체 롤백되는가?        |      | 트랜잭션      |

---

## Senior 시나리오 — 동시성, 인프라, 엣지 케이스

> 동시성, 커넥션 풀, 멀티테넌시 등 프로덕션 환경에서 발생하는 시나리오.

### S-1. 트랜잭션 중간 에러 시 롤백

```typescript
@Transactional()
async transferOwnership(catId: number, newOwnerId: number) {
  const cat = await catRepo.findOne({ where: { id: catId } });
  cat.owner = newOwner;
  await catRepo.save(cat);

  throw new Error("의도적 에러"); // ← 이 이후 롤백되는가?
}
```

| #   | 체크 항목                                          | 통과 | 비고         |
| --- | -------------------------------------------------- | ---- | ------------ |
| 1   | 에러 발생 후 cat의 owner가 원래 값으로 유지되는가? |      | DB 직접 확인 |
| 2   | 트랜잭션 밖에서 조회했을 때 변경사항이 없는가?     |      | ROLLBACK     |

### S-2. 동시 save() 호출

```typescript
// 같은 엔티티에 대해 동시에 업데이트
await Promise.all([
  catRepo.save({ id: 1, name: "A" }),
  catRepo.save({ id: 1, name: "B" }),
]);
```

| #   | 체크 항목                                              | 통과 | 비고                |
| --- | ------------------------------------------------------ | ---- | ------------------- |
| 1   | 에러 없이 완료되는가?                                  |      | deadlock 여부       |
| 2   | 최종 값이 "A" 또는 "B" 중 하나인가? (데이터 손상 없음) |      |                     |
| 3   | @Version 사용 시 낙관적 잠금이 동작하는가?             |      | OptimisticLockError |

### S-3. 커넥션 풀 고갈

```typescript
// 풀 크기(기본 10)보다 많은 동시 요청
const promises = Array.from({ length: 20 }, (_, i) =>
  catRepo.save({ name: `Cat_${i}` }),
);
await Promise.all(promises);
```

| #   | 체크 항목                                   | 통과 | 비고                |
| --- | ------------------------------------------- | ---- | ------------------- |
| 1   | 모든 요청이 완료되는가? (큐잉)              |      | timeout 여부        |
| 2   | 타임아웃 에러가 발생하면 메시지가 명확한가? |      |                     |
| 3   | 풀이 정상으로 복구되는가?                   |      | 이후 요청 성공 여부 |

### S-4. 멀티테넌시 동시 접근

```typescript
await Promise.all([
  MetadataContext.run("tenant_a", async () => {
    await catRepo.save({ name: "Tenant A Cat" });
  }),
  MetadataContext.run("tenant_b", async () => {
    await catRepo.save({ name: "Tenant B Cat" });
  }),
]);
```

| #   | 체크 항목                                                | 통과 | 비고           |
| --- | -------------------------------------------------------- | ---- | -------------- |
| 1   | 각 테넌트의 데이터가 해당 스키마에만 저장되는가?         |      | 교차 오염 확인 |
| 2   | 다른 테넌트의 데이터가 조회되지 않는가?                  |      | 격리           |
| 3   | 동시 실행 시 AsyncLocalStorage 컨텍스트가 섞이지 않는가? |      |                |

### S-5. 생명주기 훅 — 순수 객체 리터럴

```typescript
// @BeforeInsert가 Entity 클래스 인스턴스가 아닌 plain object에서 동작하는가?
const cat = { name: "Nabi" }; // ← new Cat()이 아님
await catRepo.save(cat);
```

| #   | 체크 항목                                        | 통과 | 비고                 |
| --- | ------------------------------------------------ | ---- | -------------------- |
| 1   | `@BeforeInsert` 훅이 실행되는가?                 |      | prototype chain 필요 |
| 2   | 훅이 실행되지 않으면 문서에 명시되어 있는가?     |      |                      |
| 3   | `new Cat()` 인스턴스를 전달하면 훅이 실행되는가? |      | 대조군               |

### S-6. EntitySubscriber 이벤트 순서

```typescript
em.addSubscriber({
  beforeInsert(event) {
    console.log("1. beforeInsert");
  },
  afterInsert(event) {
    console.log("2. afterInsert");
  },
});
await catRepo.save({ name: "Nabi" });
```

| #   | 체크 항목                                         | 통과 | 비고     |
| --- | ------------------------------------------------- | ---- | -------- |
| 1   | `beforeInsert` → `afterInsert` 순서인가?          |      |          |
| 2   | `event.entity`에 저장된 데이터가 포함되어 있는가? |      |          |
| 3   | `beforeInsert`에서 값을 수정하면 DB에 반영되는가? |      | mutation |

### S-7. FK 값이 falsy (0)인 경우

```typescript
// PK가 0인 부모를 참조하는 경우 (AUTO_INCREMENT가 아닌 수동 PK)
const owner = await ownerRepo.save({ id: 0, name: "Zero" });
cat.owner = owner;
await catRepo.save(cat);
```

| #   | 체크 항목                              | 통과 | 비고         |
| --- | -------------------------------------- | ---- | ------------ |
| 1   | FK가 `0`으로 저장되는가? (null이 아님) |      | `0 !== null` |
| 2   | 조회 시 owner가 정상 로드되는가?       |      |              |

### S-8. 대량 데이터 페이지네이션

```typescript
// 1000건 삽입 후 커서 페이지네이션
for (let i = 0; i < 1000; i++) {
  await catRepo.save({ name: `Cat_${i}` });
}

let cursor = undefined;
let total = 0;
do {
  const page = await catRepo.findWithCursor({
    take: 50,
    cursor,
    orderBy: "id",
    direction: "ASC",
  });
  total += page.data.length;
  cursor = page.nextCursor;
} while (cursor);
```

| #   | 체크 항목                                          | 통과 | 비고           |
| --- | -------------------------------------------------- | ---- | -------------- |
| 1   | `total === 1000`인가?                              |      | 누락/중복 없음 |
| 2   | 페이지 경계에서 중복이 없는가?                     |      |                |
| 3   | 마지막 페이지의 `nextCursor`가 null/undefined인가? |      | 종료 조건      |

### S-9. QueryBuilder — 복잡한 조건

```typescript
const result = await em
  .createQueryBuilder(Cat)
  .where("age > :minAge", { minAge: 3 })
  .andWhere("name LIKE :pattern", { pattern: "%na%" })
  .orderBy("age", "DESC")
  .limit(10)
  .getMany();
```

| #   | 체크 항목                                                        | 통과 | 비고            |
| --- | ---------------------------------------------------------------- | ---- | --------------- |
| 1   | SQL Injection 시도 시 안전한가? `{ pattern: "'; DROP TABLE--" }` |      | 파라미터 바인딩 |
| 2   | 결과가 정렬 조건에 맞는가?                                       |      |                 |
| 3   | limit이 적용되는가?                                              |      |                 |

---

## 환경 설정

### 사전 조건

```bash
# 1. ORM 빌드
pnpm build

# 2. 예제 프로젝트로 이동
cd examples/nestjs-cats   # 또는 nestjs-blog

# 3. 의존성 설치
pnpm install

# 4. Docker로 DB 실행 (MySQL 예시)
docker run -d --name stingerloom-test \
  -e MYSQL_ROOT_PASSWORD=test \
  -e MYSQL_DATABASE=stingerloom \
  -p 3306:3306 mysql:8

# 5. 서버 시작
pnpm start
```

### 검증 방법

1. **HTTP 클라이언트** — REST API 엔드포인트로 테스트 (curl, Postman, httpie)
2. **DB 조회** — `mysql -u root -p` 또는 `psql`로 테이블 확인
3. **통합 테스트 추가** — 각 시나리오를 `__tests__/integration/` 또는 예제 e2e에 자동화

### DB 조회 예시

```sql
-- ManyToOne FK가 올바르게 저장되었는지 확인
SELECT c.id, c.name, c.owner_id, o.name as owner_name
FROM cat c
LEFT JOIN owner o ON c.owner_id = o.id;

-- Soft Delete 확인
SELECT id, name, deleted_at FROM cat WHERE id = 1;

-- 테넌트 격리 확인 (PostgreSQL)
SELECT schemaname, tablename FROM pg_tables
WHERE schemaname IN ('public', 'tenant_a', 'tenant_b');
```

---

## 결과 기록 템플릿

각 시나리오별 결과 기록 형식:

```
## 테스트 일자: YYYY-MM-DD
## 테스터:
## DB: MySQL 8 / PostgreSQL 15
## ORM 버전:

### Junior 시나리오
- [x] J-1: 엔티티 생성 후 즉시 조회 — 통과
- [ ] J-2: ManyToOne 객체 할당 — 실패 (FK가 NULL로 저장됨)
- [x] J-3: FK 컬럼 직접 지정 — 통과
  ...

### 발견된 이슈
| # | 시나리오 | 증상 | 심각도 | 이슈 링크 |
|---|---------|------|--------|----------|
| 1 | J-2 | owner 객체 할당 시 FK가 NULL | Critical | #12 |
```

---

## 자동화 우선순위

아래 시나리오는 통합 테스트로 자동화할 때 우선순위가 높은 항목입니다.

| 우선순위              | 시나리오                | 이유                                        |
| --------------------- | ----------------------- | ------------------------------------------- |
| P0 (즉시)             | J-2, J-3, M-1, M-2, S-7 | FK 처리 핵심 경로 — 이미 버그가 발생한 영역 |
| P1 (릴리스 전)        | J-1, J-4~J-6, M-3~M-6   | 기본 CRUD + 관계 round-trip                 |
| P2 (드라이버 변경 시) | M-7, S-9                | 드라이버별 SQL 차이                         |
| P3 (인프라)           | S-1~S-4, S-8            | 동시성, 커넥션 풀, 멀티테넌시               |
