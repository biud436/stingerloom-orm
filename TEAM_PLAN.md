# Stingerloom ORM — 팀 계획 및 로드맵

> 이 파일은 팀 구성, 작업 현황, 미래 계획을 추적합니다.
> 팀을 다시 소집할 때 이 문서를 참고하세요.

---

## 팀 구성 (v2 — 2026-02-27 개편)

에이전트 정의 파일: `.claude/agents/*.md`

| 역할 | 에이전트 파일 | 모델 | 주 담당 영역 |
|------|-------------|------|-------------|
| **team-lead** (Claude 직접) | — | opus | 태스크 분배, 코드 리뷰, 충돌 해결, 직접 구현 |
| **dialect-engineer** | `dialect-engineer.md` | opus | DB 드라이버, SQL Injection 감사, ISqlDriver 준수 |
| **test-engineer** | `test-engineer.md` | opus | 유닛/통합 테스트, 회귀 테스트, 커버리지 |
| **arch-reviewer** | `arch-reviewer.md` | opus | 아키텍처 감사, 메타데이터 격리, 동시성 안전 |
| **docs-expert** | `docs-expert.md` | **sonnet** | 프로덕션 품질 문서, API 레퍼런스, 가이드 |
| **example-tester** | `example-tester.md` | opus | 예제 3개 타입 체크, 빌드, e2e 테스트 |

### 팀원 특이사항

- **test-engineer**: 이전에 태스크 완료 보고 반복 루프 경향 있음. 루프 감지 시 → shutdown 후 재spawn.
- **dialect-engineer**: 취소된 태스크를 미리 완료하는 타이밍 이슈. 결과물 검토 후 유지/revert 판단.
- **docs-expert**: Sonnet 4.6 모델 사용 (비용 효율). 승인 없이 자동 진행.
- **모든 팀원**: `pnpm test` 통과 확인 후 팀장에게 SendMessage로 보고.

---

## 안정성 검증 결과 (2026-02-27)

### 라운드 1 — 5개 에이전트 병렬 투입

| 태스크 | 에이전트 | 결과 |
|--------|----------|------|
| ORM 전체 테스트 실행 | test-engineer | ✅ 1,402 passed, 0 failures |
| 예제 3개 타입 체크 | example-tester | ✅ 3/3 zero errors |
| 아키텍처 감사 | arch-reviewer | 🔧 MEDIUM 2건, LOW 5건 발견 |
| 문서 업그레이드 | docs-expert | ✅ 4 updated + 2 new docs (+1,218 lines) |
| SQL Injection 감사 | dialect-engineer | 🔧 CRITICAL 3건, HIGH 3건 발견 → 전부 수정 |

### 라운드 2 — 리서치 에이전트 3개

| 태스크 | 결과 |
|--------|------|
| Export 완전성 검증 | ✅ 모든 주요 API 정상 export |
| setContext() 동시성 분석 | 🔧 CRITICAL → resolveContext() 도입 |
| 문서-소스 일치 검증 | ✅ 100% 일치 |

### 수정된 버그 (커밋 4건)

| 심각도 | 내용 | 커밋 |
|--------|------|------|
| CRITICAL | LayeredMetadataStore AsyncLocalStorage 동시성 안전 | e6586e8 |
| HIGH | SQL Injection 취약점 6건 (MySqlDriver 5, SchemaDiff 1) | 225908b |
| MEDIUM | getAllInContext() 테넌트 간 데이터 유출 | 180969d |
| — | 문서 프로덕션 품질 업그레이드 | af14f6d |

---

## 완료된 작업 이력

### 초기 구현 (2026-02-22 ~ 2026-02-23)

| # | 기능 | 커밋 | 테스트 수 |
|---|------|------|-----------|
| 1 | Delete 연산 | 2fb0e0f | - |
| 2 | SQLite 드라이버 | 96c401c | 363 |
| 3 | @OneToMany 관계 | a45bd40 | - |
| 4 | 쿼리 빌더 DSL | 620ba1f | - |
| 5 | Eager 로딩 (LEFT JOIN) | 8a11723 | 370 |
| 6 | 연결 풀링 (PoolOptions) | 53ffd2d | 415 |
| 7 | 마이그레이션 시스템 | ab13a64 | 415 |
| 8 | @ManyToMany 관계 | 674504f | 427 |
| 9 | 마이그레이션 CLI | 27dd54b | 496 |
| 10 | Cascade + Lazy 로딩 | e38fd17 | 501 |
| 11 | Soft Delete (@DeletedAt) | eadfff0 | - |
| 12 | Batch 연산 | eadfff0 | 529 |
| 13 | 유효성 검사 데코레이터 | 625c6d3 | 560 |
| 14 | Entity 생명주기 훅 | 28d92bc | 572 |
| 15 | Aggregate 쿼리 | 0db6cad | 630 |
| 16 | @Transactional | f40c48c | 630 |
| 17 | Query Builder WHERE 개선 | 8fbe376 | 630 |
| 18 | nestjs-cats 업데이트 | f17c4e6 | 630 |
| 19 | Schema Generation | 1393498 | - |
| 20 | @OneToOne 관계 | 27cc25b | - |
| 21~24 | 이벤트 시스템, Select 컬럼, Raw Query, 복합 PK | — | 774 |
| 25~30 | MSSQL, QueryCache, EntitySubscriber, eager 버그 수정 | — | 906 |
| 31~37 | 통합 테스트, N+1 감지, 문서화, 타임아웃, 커서 페이지네이션 | — | 1163 |
| 38~44 | Read Replica, 커버리지 강화, 멀티테넌시 테스트 | — | **1250** |

### 기능 완성 (2026-02-23)

| # | 기능 | 커밋 | 테스트 수 |
|---|------|------|-----------|
| 45 | findAndCount() | a1ea2ab | 1260 |
| 46 | Upsert (4개 드라이버) | 7145dff | 1276 |
| 47 | GROUP BY / HAVING | 271de44 | 1288 |
| 48 | @UniqueIndex | 79d03d1 | 1301 |
| 49 | Schema Diff Migration | — | 1348 |
| 50 | ManyToMany DDL 자동 생성 | — | 1348 |
| 51 | nestjs-blog 예제 | 6c8aa51 | 1348 |

### 안정화 + 통합 (2026-02-24 ~ 2026-02-26)

| # | 기능 | 커밋 |
|---|------|------|
| 52 | FK 해시 네이밍 | 32e3f2d |
| 53 | findOne T\|null | bc2d42e |
| 54 | @InjectRepository | bc2d42e |
| 55 | 멀티 DB 지원 | b7e43a7 |
| 56 | nestjs-multitenant 예제 | 5b79f1d |
| 57 | nestjs-blog e2e 테스트 (59개) | 1cee02e |
| 58 | MySQL connection pool 버그 수정 | 1cee02e |
| 59 | QueryCache 제거 (Issue #10) | 90d417a |
| 60 | TenantMigrationRunner | 90d417a |
| 61 | WHERE falsy 값 버그 수정 | 5806f11 |
| 62 | propagateShutdown() | 5806f11 |

### 안정성 감사 (2026-02-27)

| # | 기능 | 커밋 |
|---|------|------|
| 63 | getAllInContext() 테넌트 격리 버그 수정 | 180969d |
| 64 | 문서 프로덕션 품질 업그레이드 (12개 파일) | af14f6d |
| 65 | SQL Injection 취약점 6건 수정 | 225908b |
| 66 | AsyncLocalStorage 동시성 안전 (resolveContext) | e6586e8 |

---

## 현재 테스트 현황

**1,405개 테스트** (2026-02-27 기준)

```
Test Suites: 2 skipped, 72 passed, 72 of 74 total
Tests:       26 skipped, 1405 passed, 1431 total
0 failures
```

---

## 아키텍처 원칙 (팀원 준수 사항)

1. **메타데이터 격리**: 전역 싱글톤 금지 → `LayeredMetadataStore` 경유
2. **동시성 안전**: `setContext()` deprecated → `MetadataContext.run()` 사용
3. **SQL Injection 방지**: 식별자 = `escapeIdentifier()`, 값 = `sql-template-tag`
4. **드라이버 추상화**: 새 드라이버는 `ISqlDriver` 인터페이스 완전 구현
5. **TypeScript strict**: `any` 자제, 가능하면 제네릭 활용
6. **테스트 우선**: 새 기능은 반드시 유닛 테스트 포함, 버그 수정은 회귀 테스트 추가

---

## 팀 재소집 방법

```
에이전트 정의: .claude/agents/ (5개 에이전트)
모델: docs-expert만 sonnet, 나머지 opus

각 에이전트에게 전달할 초기 컨텍스트:
- 프로젝트 경로: /Users/u/stingerloom-orm
- 패키지 매니저: pnpm
- 테스트 명령: pnpm test (또는 npx jest --testPathPattern="...")
- 커밋 후 push 필수
- 완료 후 SendMessage로 팀장에게 보고
- CLAUDE.md, TEAM_PLAN.md 참고

TeamCreate → TaskCreate → Task(spawn agents) → TaskUpdate
```

---

## Hooks 인프라

`.claude/hooks/record-status.sh` — 마일스톤 자동 기록

| 트리거 | 이벤트 |
|--------|--------|
| `git commit` 후 | git-commit |
| `git push` 후 | git-push |
| `pnpm test` 후 | test-run |
| 세션 종료 시 | session-stop |

기록 위치: `.claude/work-log.md`

---

## 백로그 (향후 개선 가능 항목)

| 기능 | 설명 | 우선순위 |
|------|------|---------|
| Oracle 드라이버 | 새 DB 드라이버 (사용자 지시로 이전 중단됨) | LOW |
| MetadataLayer.clone() 깊은 복사 | structuredClone 실패 시 얕은 복사 fallback 개선 | LOW |
| Conditions.raw() 문서 경고 | SQL Injection 위험 명시 | LOW |
| npm 배포 | package.json 설정 + CI/CD 파이프라인 | 미정 |
