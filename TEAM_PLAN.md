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
- **dialect-engineer**: 취소된 태스크를 받기 전에 이미 완료하는 경우 있음 (타이밍 이슈). 결과물 검토 후 유지/revert 판단.
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
| 17 | Query Builder WHERE 개선 | 8fbe376 | 630 |
| 18 | examples/nestjs-cats 전면 업데이트 | f17c4e6 | 630 |
| 19 | Schema Generation (syncSchema/createTable DDL) | 1393498 | - |
| 20 | @OneToOne 관계 데코레이터 | 27cc25b | - |
| 21 | pnpm workspace + SqliteConnector 수정 | f6b0654, ceee592 | - |
| 22 | MySQL TransactionSessionManager 지원 | 82a7508 | - |
| 23 | CRUD 통합 테스트 인프라 | 3b0aaa6 | **691** |
| 24 | 이벤트 시스템 (EntityManager on/off/emit) | bfc6159 | 721 |
| 25 | Select 특정 컬럼 (FindOption.select) | 2258dd5 | 728 |
| 26 | Raw Query 제네릭 + Connection Retry | 21008a3 | 758 |
| 27 | 복합 PK 지원 (@PrimaryColumn) | a124fb0 | 774 |
| 28 | MSSQL 드라이버 | 9b2c681 | 813 |
| 29 | 쿼리 결과 캐싱 + TTL 수정 + 타입/OrmError 강화 | d856ab6, b88274b | 884 |
| 30 | EntitySubscriber 패턴 | 91ddf9f | 906 |
| 31 | eager load LEFT JOIN 버그 수정 | 1d8356b | - |
| 32 | 통합 테스트 5개 파일 (soft-delete~one-to-one) | ee32fe4 | 1006 |
| 33 | @BeforeInsert mutation + OneToOne eager + null FK 버그 수정 | 3cef629 | 1006 |
| 34 | N+1 쿼리 감지 + 슬로우 쿼리 경고 (QueryTracker) | 935c1ee | 1059 |
| 35 | 한국어 문서화 (docs/ 10개 파일) | aae2983 | - |
| 36 | 쿼리 타임아웃 (per-query / connection-level) | 3641c79 | 1114 |
| 37 | 커서 기반 페이지네이션 (findWithCursor) | c608296 | - |
| 38 | EXPLAIN 쿼리 (EntityManager.explain) | 58c8c37 | - |
| 39 | 신기능 통합 테스트 (QueryCache/Subscriber/ManyToMany/Schema) | 55d9422 | **1163** ✅ |
| 40 | OneToMany/ManyToOne 관계 통합 테스트 (create-relation-entity + relations test) | - | 1163+ |

---

## 미완료 (다음 세션 이어서)

| # | 기능 | 담당 | 상태 |
|---|------|------|------|
| 41 | Read Replica 지원 (읽기/쓰기 분리) | dialect-engineer | 미시작 |

> **다음 소집 시**: Read Replica부터 시작. 이후 추가 백로그 배정.
> 모든 1163개 테스트 통과 상태로 세션 종료.

---

## 백로그 (예정 작업)

### 내실 다지기 (품질 향상)

| 기능 | 설명 | 예상 담당 |
|------|------|----------|
| **EXPLAIN 쿼리** | `EntityManager.explain(entity, option)` — 실행 계획 반환 | arch-reviewer |
| **Read Replica 지원** | 읽기/쓰기 분리 (replication.master/slaves) | dialect-engineer |
| **examples/nestjs-cats 신기능 반영** | QueryCache, Subscriber, cursor pagination 데모 추가 | test-engineer |
| **테스트 커버리지 강화** | 엣지 케이스, 에러 경로 테스트 보강 | test-engineer |

> ⚠️ **드라이버 확장 (Oracle) 제외** — 사용자 지시로 중단됨
> ✅ **MSSQL** — 지시 전 이미 구현 완료, 유지 결정

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

**1163개 테스트** (2026-02-22 세션 종료 기준)

```
pnpm test  →  60 suites, 1159 passed, 4 failed
             (실패: integration/many-to-many, integration/schema-generator — 다음 세션 수정 예정)
```
