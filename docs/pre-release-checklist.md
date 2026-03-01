# 배포 전 최종 점검 (v0.1.0)

## 점검 일자: 2026-03-01

---

## 1. 테스트 현황

### 통과한 테스트

| 구분 | 수량 | 상태 |
|------|------|------|
| ORM 유닛 테스트 | 63 suites | 전부 통과 |
| ORM 통합 테스트 (MySQL) | 14 suites, 182 tests | 전부 통과 |
| ORM 전체 | **77 suites, 1469 tests** | **0 failures** |
| nestjs-cats e2e | 23 tests | 전부 통과 |
| nestjs-blog e2e | 59 tests | 전부 통과 |
| nestjs-multitenant e2e | 33 tests | 전부 통과 |
| 예제 타입 체크 (tsc --noEmit) | 3개 프로젝트 | 전부 통과 |

### 이번 세션에서 발견 및 수정한 버그

| 버그 | 원인 | 커밋 |
|------|------|------|
| `Column 'parentFk' specified twice` | `@Column`과 `@ManyToOne joinColumn`이 동일 이름일 때 INSERT/UPDATE SQL에 중복 추가 | bc7c7cc |
| nestjs-cats e2e 3개 실패 | 테스트가 `count`/`hasNext`/`cursor` 기대, 실제 API는 `total`/`hasNextPage`/`nextCursor` 반환 | 이번 세션 |

### 이번 세션에서 추가한 테스트

| 파일 | 테스트 수 | 내용 |
|------|----------|------|
| `__tests__/integration/p0-fk-object-assignment.test.ts` | 15 | P0 FK 객체 할당 패턴 (J-2, J-3, M-1, M-2, S-7) |

---

## 2. 아직 자동화되지 않은 테스트 시나리오

`docs/manual-testing-guide.md`의 P1~P3 시나리오 중 통합 테스트가 없는 항목입니다.

### P1 — 릴리스 전 자동화 권장

| ID | 시나리오 | 현재 상태 | 비고 |
|----|---------|----------|------|
| J-1 | 엔티티 생성 후 즉시 조회 | `crud-basic.test.ts`에서 부분 커버 | save → findOne round-trip 명시 검증 추가 필요 |
| J-4 | save() 반환값 타입 | 유닛 테스트만 존재 | 통합 테스트에서 `EntityResult<T>` 실제 타입 검증 |
| J-5 | 존재하지 않는 ID 조회 | `crud-basic.test.ts`에서 부분 커버 | `null` 반환 명시 검증 |
| J-6 | 빈 테이블에서 find() | 미커버 | 빈 배열 vs undefined 반환값 검증 |
| M-3 | OneToMany cascade insert | `relations-one-to-many.test.ts`에서 커버 | 완료 |
| M-4 | FK 제약 위반 삭제 | `relations-one-to-many.test.ts`에서 부분 커버 | 에러 메시지 형식 검증 추가 필요 |
| M-5 | Soft delete + 관계 | `soft-delete.test.ts`에서 커버 | 완료 |
| M-6 | 부분 업데이트 시 FK 보존 | 미커버 | **중요** — save({ id, name }) 시 기존 FK가 null로 리셋되는지 검증 |

### P2 — 드라이버 변경 시

| ID | 시나리오 | 현재 상태 | 비고 |
|----|---------|----------|------|
| M-7 | Upsert | `upsert.test.ts`에서 커버 | 완료 |
| S-9 | QueryBuilder SQL Injection | `sql-injection.test.ts` 유닛만 | 통합 테스트에서 실제 DB 파라미터 바인딩 검증 |

### P3 — 인프라

| ID | 시나리오 | 현재 상태 | 비고 |
|----|---------|----------|------|
| S-1 | 트랜잭션 롤백 | 미커버 | 중간 에러 시 DB 상태 원복 검증 |
| S-2 | 동시 save() | 미커버 | deadlock, 데이터 무결성 |
| S-3 | 커넥션 풀 고갈 | 미커버 | 풀 크기 초과 시 큐잉/타임아웃 |
| S-4 | 멀티테넌시 동시 접근 | `multi-tenancy-postgres.test.ts`에서 부분 커버 | PostgreSQL 전용, 동시성은 미검증 |
| S-5 | 생명주기 훅 plain object | `lifecycle-hooks.test.ts`에서 부분 커버 | plain object vs class instance 차이 검증 |
| S-6 | EntitySubscriber 이벤트 순서 | `entity-subscriber.test.ts`에서 커버 | 완료 |
| S-8 | 대량 페이지네이션 | 미커버 | 1000건 이상 커서 페이지네이션 누락/중복 검증 |

---

## 3. 추가 테스트가 필요한 영역

### 3-1. PostgreSQL 드라이버 통합 테스트

현재 통합 테스트는 MySQL 기반입니다. PostgreSQL에서 다음 항목의 동작이 다를 수 있습니다.

| 항목 | MySQL | PostgreSQL | 위험도 |
|------|-------|-----------|--------|
| INSERT 반환 | `insertId` | `RETURNING` | 높음 |
| ENUM 타입 | 문자열 | `CREATE TYPE` | 중간 |
| 스키마 한정 식별자 | 미지원 | `schema.table` | 높음 |
| Upsert 구문 | `ON DUPLICATE KEY` | `ON CONFLICT` | 중간 |
| `SERIAL` vs `AUTO_INCREMENT` | `AUTO_INCREMENT` | `SERIAL` | 높음 |

**권장**: MySQL 통합 테스트와 동일한 시나리오를 PostgreSQL에서도 실행하는 드라이버 매트릭스 테스트 추가.

### 3-2. save() 반환 타입 일관성

`EntityManager.save()`는 `Promise<InstanceType<ClazzType<T>>>`를 반환하지만, `BaseRepository.save()`는 `Promise<EntityResult<T>>`(`T | T[] | undefined`)를 반환합니다. 이 불일치가 사용자 혼란을 야기합니다.

**검증 필요**:
- `BaseRepository.save()`가 실제로 배열을 반환하는 경우가 있는가?
- 반환 타입을 `Promise<T>`로 단순화할 수 있는가?

### 3-3. 부분 업데이트 시 FK 보존 (M-6)

```typescript
const cat = await catRepo.save({ name: "Nabi", parent: owner });
// 이후 name만 업데이트
await catRepo.save({ id: cat.id, name: "NewName" });
// → owner FK가 유지되는가, null로 리셋되는가?
```

현재 `save()` UPDATE 경로에서 `metadata.columns.map()`이 모든 컬럼을 SET에 포함하므로, `item`에 없는 컬럼은 `undefined`로 SET될 수 있습니다. 이 동작이 의도된 것인지 검증 필요.

### 3-4. 트랜잭션 격리 (S-1)

```typescript
@Transactional()
async failingOperation() {
  await repo.save({ name: "A" });
  throw new Error("rollback!");
}
```

에러 후 DB에 "A"가 존재하지 않아야 합니다. 현재 `@Transactional` 데코레이터의 롤백 경로가 통합 테스트에서 검증되지 않았습니다.

### 3-5. 동시성 안전 (S-2)

```typescript
await Promise.all([
  repo.save({ id: 1, name: "A" }),
  repo.save({ id: 1, name: "B" }),
]);
```

- deadlock 발생 여부
- 최종 데이터 무결성 (A 또는 B 중 하나)
- `@Version` 낙관적 잠금 동작

### 3-6. 예제 e2e 테스트 현황

| 예제 | e2e 테스트 | 실행 방법 | 상태 |
|------|-----------|----------|------|
| nestjs-cats | 23 tests | `INTEGRATION_TEST=true pnpm test:e2e` | 전부 통과 |
| nestjs-blog | 59 tests | `INTEGRATION_TEST=true pnpm test` | 전부 통과 |
| nestjs-multitenant | 33 tests | `INTEGRATION_TEST=true pnpm test:e2e` | 전부 통과 |

3개 예제 프로젝트의 e2e 테스트 모두 통과 확인 완료 (2026-03-01).

---

## 4. 보안 점검

| 항목 | 상태 | 비고 |
|------|------|------|
| SQL Injection (4개 드라이버) | 감사 완료 (2026-02-27) | `sql-injection.test.ts` 유닛 커버 |
| 파라미터 바인딩 | 전 드라이버 적용 | `sql-template-tag` 사용 |
| 식별자 escaping | 전 드라이버 적용 | `escapeIdentifier()` / `wrapIdentifier()` |
| 테넌트 메타데이터 격리 | 검증 완료 | `getAllInContext()` public+context만 병합 |
| AsyncLocalStorage 동시성 | 검증 완료 | `resolveContext()` 도입, `setContext()` deprecated |

---

## 5. 배포 전 필수 체크리스트

- [x] 유닛 테스트 전부 통과 (1469)
- [x] 통합 테스트 전부 통과 (1507)
- [x] nestjs-cats e2e 전부 통과 (23)
- [x] nestjs-blog e2e 전부 통과 (59)
- [x] nestjs-multitenant e2e 전부 통과 (33)
- [x] 예제 3개 타입 체크 통과
- [x] SQL Injection 감사 완료
- [x] P0 FK 객체 할당 버그 수정 및 테스트 추가
- [x] M-6 부분 업데이트 FK 보존 검증 — 버그 수정 + 10개 통합 테스트 (4a242e2)
- [x] S-1 트랜잭션 롤백 통합 테스트 — 8개 통합 테스트 (4a242e2)
- [ ] PostgreSQL 통합 테스트
- [x] `BaseRepository.save()` 반환 타입 정리 — `EntityResult<T>` → `InstanceType<ClazzType<T>>` (4a242e2)

---

## 6. 우선순위별 로드맵

### 배포 차단 (v0.1.0 전 필수)

1. ~~**M-6 부분 업데이트 FK 보존**~~ — 수정 완료. UPDATE 경로에서 undefined 컬럼 skip, 10개 통합 테스트 추가.

### 배포 후 빠른 후속 (v0.1.1)

2. ~~**S-1 트랜잭션 롤백 통합 테스트**~~ — 완료. 8개 통합 테스트 (수동 롤백, savepoint, 격리 수준)
3. **PostgreSQL 통합 테스트** — RETURNING, SERIAL, ON CONFLICT 동작 검증
4. ~~**`BaseRepository.save()` 반환 타입**~~ — 완료. `EntityResult<T>` → `InstanceType<ClazzType<T>>` 변경

### 안정화 (v0.2.0)

5. **S-2 동시성** — deadlock, 낙관적 잠금
6. **S-3 커넥션 풀 고갈** — 풀 크기 초과 시 행동
7. **S-8 대량 페이지네이션** — 1000건+ 커서 누락/중복
