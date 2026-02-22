# Stingerloom ORM — 팀 계획 및 로드맵

> 이 파일은 팀 구성, 작업 현황, 미래 계획을 추적합니다.
> 팀을 다시 소집할 때 이 문서를 참고하세요.

---

## 팀 구성

| 역할 | 주 담당 영역 |
|------|-------------|
| **team-lead** (Claude 직접) | 태스크 분배, 코드 리뷰, 충돌 해결, 직접 구현 |
| **arch-reviewer** | 아키텍처 설계, 데코레이터 시스템, DDL 생성 |
| **dialect-engineer** | DB 드라이버, 쿼리 최적화, 배치 연산 |
| **test-engineer** | 테스트 작성, 관계 데코레이터, 유효성 검사 |

### 팀원 특이사항

- **test-engineer**: 이전 태스크 완료 보고를 반복하는 루프에 빠지는 경향이 있음.
  루프 감지 시 → shutdown_request 후 새 인스턴스 spawn으로 해결.
- **모든 팀원**: `pnpm test` 통과 + `git push` 후 팀장에게 SendMessage로 보고.

---

## 완료된 작업 이력

| # | 기능 | 커밋 | 테스트 수 |
|---|------|------|-----------|
| 1 | Delete 연산 | 2fb0e0f | - |
| 2 | SQLite 드라이버 | 96c401c | 363 |
| 3 | @OneToMany 관계 | a45bd40, fa31498 | - |
| 4 | 쿼리 빌더 DSL (JOIN/offset) | 620ba1f | - |
| 5 | Eager 로딩 (LEFT JOIN) | 8a11723 | 370 |
| 6 | 연결 풀링 (PoolOptions) | 53ffd2d | 415 |
| 7 | 마이그레이션 시스템 | ab13a64, f05f657 | 415 |
| 8 | @ManyToMany 관계 | 674504f | 427 |
| 9 | 마이그레이션 CLI | 27dd54b | 496 |
| 10 | Cascade 옵션 + Lazy 로딩 | e38fd17, 36496bb | 501 |
| 11 | Soft Delete (@DeletedAt) | eadfff0 | - |
| 12 | 배치 연산 (saveMany/insertMany/deleteMany) | eadfff0 | 529 |
| 13 | 유효성 검사 데코레이터 | 625c6d3 | 560 |
| 14 | Entity 생명주기 훅 (@BeforeInsert 등) | 28d92bc | 572 |
| 15 | Aggregate 쿼리 (count/sum/avg/min/max) | 0db6cad | 630 |
| 16 | @Transactional 데코레이터 | f40c48c | 630 |
| 17 | Query Builder WHERE 개선 (andWhere/orWhere/whereIn 등) | 8fbe376 | 630 |
| 18 | examples/nestjs-cats 전면 업데이트 | - | 630 |

---

## 진행 중 (이번 세션 마지막 상태)

| # | 기능 | 담당 | 상태 |
|---|------|------|------|
| 22 | 배치 연산 고도화 (insertMany/saveMany/deleteMany) | dialect-engineer | 진행 중 |
| 23 | @OneToOne 관계 데코레이터 | test-engineer | 진행 중 |
| 26 | Schema Generation (syncSchema/createTable DDL) | arch-reviewer | 진행 중 |

> **다음 소집 시**: 위 3개 태스크 완료 여부 먼저 확인 후 백로그 배정.

---

## 계획된 작업 (백로그)

우선순위 순서로 정렬:

### 높음 (핵심 ORM 기능)

| 기능 | 설명 | 예상 담당 |
|------|------|----------|
| **이벤트 시스템** | EntityManager 이벤트 emitter (insert/update/delete 시 이벤트 발행) | arch-reviewer |
| **Select 특정 컬럼** | `find(Entity, { select: ["id", "name"] })` | arch-reviewer |
| **Raw Query 결과 타입** | `EntityManager.query<T>(sql)` 제네릭 타입 강화 | dialect-engineer |

### 중간 (개발 경험 향상)

| 기능 | 설명 | 예상 담당 |
|------|------|----------|
| **Connection Retry** | 연결 실패 시 지수 백오프 재시도 | dialect-engineer |
| **복합 PK 지원** | `@PrimaryGeneratedColumn()` 다중 컬럼 | arch-reviewer |
| **쿼리 결과 캐싱** | `find()` 결과 TTL 기반 인메모리 캐시 | arch-reviewer |

### 낮음 (고급 기능)

| 기능 | 설명 | 예상 담당 |
|------|------|----------|
| **Oracle 드라이버** | `ISqlDriver` 기반 Oracle DB 지원 | dialect-engineer |
| **MSSQL 드라이버** | Microsoft SQL Server 지원 | dialect-engineer |
| **Subscriber/Observer** | `EntitySubscriber` 인터페이스 (afterLoad, afterTransactionStart 등) | arch-reviewer |

---

## examples/nestjs-cats 데모 현황

`examples/nestjs-cats`는 지금까지 구현된 모든 핵심 기능을 시연합니다.

### 엔티티 구조

```
Owner (주인)           Cat (고양이)
─────────────          ──────────────────────────
@PrimaryGeneratedColumn  @PrimaryGeneratedColumn
@Column name             @Column name / age / breed
@Column email            @Column createdAt / updatedAt
@Column createdAt        @Version (낙관적 잠금)
@OneToMany cats          @DeletedAt (Soft Delete)
@BeforeInsert            @ManyToOne owner (eager)
                         @BeforeInsert / @BeforeUpdate / @AfterInsert
```

### API 엔드포인트 매핑

| Method | Path | 데모하는 기능 |
|--------|------|--------------|
| POST | /cats | @Transactional, @BeforeInsert 훅 |
| POST | /cats/bulk | insertMany (배치 INSERT) |
| GET | /cats | Soft Delete 자동 필터 (deleted_at IS NULL) |
| GET | /cats/all | withDeleted 옵션 |
| GET | /cats/stats | count/avg/min/max/sum 집계 |
| GET | /cats/:id | @ManyToOne eager 로딩 (owner 포함) |
| PATCH | /cats/:id | @Transactional, @BeforeUpdate 훅 |
| DELETE | /cats/:id | 영구 삭제 |
| PATCH | /cats/:id/soft-delete | Soft Delete |
| PATCH | /cats/:id/restore | Soft Delete 복원 |
| DELETE | /cats/bulk | deleteMany (배치 삭제) |
| POST | /owners | @Transactional, @BeforeInsert 훅 |
| GET | /owners | @OneToMany 관계 데모 |
| GET | /owners/count | count 집계 |
| DELETE | /owners/:id | 영구 삭제 |

---

## 아키텍처 원칙 (팀원 준수 사항)

1. **메타데이터 격리**: 전역 싱글톤 금지 → `LayeredMetadataStore` 경유
2. **SQL Injection 방지**: 식별자 = `escapeIdentifier()`, 값 = `sql-template-tag`
3. **드라이버 추상화**: 새 드라이버는 `ISqlDriver` 인터페이스 완전 구현
4. **TypeScript strict**: `any` 자제, 가능하면 제네릭 활용
5. **테스트 우선**: 새 기능은 반드시 mock 기반 유닛 테스트 포함

---

## 팀 재소집 방법

```
팀 구성:
- arch-reviewer: general-purpose 에이전트
- dialect-engineer: general-purpose 에이전트
- test-engineer: general-purpose 에이전트

각 에이전트에게 전달할 초기 컨텍스트:
- 프로젝트 경로: /Users/u/stingerloom-orm
- 패키지 매니저: pnpm
- 테스트 명령: pnpm test
- 커밋 후 push 필수
- 완료 후 SendMessage로 팀장에게 보고
- CLAUDE.md, CHANGELOG.md, TEAM_PLAN.md 참고

진행 중 태스크 확인: TEAM_PLAN.md "진행 중" 섹션 참조
```

---

## 현재 테스트 현황

**630개 테스트 통과** (2026-02-22 기준)

```
pnpm test  →  33 suites, 630 passed
```
