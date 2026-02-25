# NestJS Blog API — Stingerloom ORM Example

NestJS 기반 블로그 REST API 예제입니다. Stingerloom ORM의 주요 기능을 시연합니다.

## 기능

- **CRUD** — Users, Posts, Tags, Categories
- **관계** — ManyToOne (Post→User, Post→Category), OneToMany, ManyToMany (Post↔Tag)
- **Soft Delete / Restore** — `@DeletedAt` 데코레이터
- **Optimistic Locking** — `@Version` 데코레이터
- **Upsert** — slug/name 기준 INSERT ON CONFLICT UPDATE
- **페이지네이션** — offset 기반 (`findAndCount`) + 커서 기반 (`findWithCursor`)
- **쿼리 캐싱** — TTL 기반 (`cache: 5000`)
- **EXPLAIN** — 쿼리 실행 계획 조회
- **Schema Diff** — 엔티티 vs DB 스키마 비교 + Migration 생성
- **GROUP BY / HAVING** — RawQueryBuilder를 활용한 집계 쿼리
- **트랜잭션** — `@Transactional()` 데코레이터

## 사전 요구사항

- Node.js 18+
- pnpm
- MySQL (기본) 또는 PostgreSQL

## 설치 및 실행

```bash
# 1. ORM 빌드 (루트 디렉토리에서)
cd /path/to/stingerloom-orm
pnpm build

# 2. 의존성 설치
cd examples/nestjs-blog
pnpm install

# 3. 환경변수 설정 (.env 파일 수정)
#    DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME

# 4. 서버 실행
pnpm start        # 또는 pnpm start:dev (watch 모드)
```

서버가 시작되면 `http://localhost:3000` 에서 API에 접근할 수 있습니다.

## API 엔드포인트

### Users (`/users`)
| Method | Path | 설명 |
|--------|------|------|
| POST | `/users` | 사용자 생성 |
| GET | `/users` | 전체 조회 |
| GET | `/users/:id` | 단건 조회 |
| PATCH | `/users/:id` | 수정 |
| DELETE | `/users/:id` | 삭제 |
| GET | `/users/count` | 총 수 |
| GET | `/users/paginated?page=1&limit=10` | 페이지네이션 |

### Posts (`/posts`)
| Method | Path | 설명 |
|--------|------|------|
| POST | `/posts` | 포스트 생성 |
| GET | `/posts` | 전체 조회 (캐시 5초) |
| GET | `/posts/all` | 전체 조회 (soft-deleted 포함) |
| GET | `/posts/:id` | 단건 조회 |
| PATCH | `/posts/:id` | 수정 |
| DELETE | `/posts/:id` | 하드 삭제 |
| PATCH | `/posts/:id/soft-delete` | 소프트 삭제 |
| PATCH | `/posts/:id/restore` | 복원 |
| POST | `/posts/upsert` | Upsert (slug 기준) |
| GET | `/posts/paginated?page=1&limit=10` | 오프셋 페이지네이션 |
| GET | `/posts/cursor?take=10&cursor=xxx` | 커서 페이지네이션 |
| GET | `/posts/:id/explain` | EXPLAIN 쿼리 |
| GET | `/posts/:id/tags` | 포스트의 태그 목록 |
| POST | `/posts/:id/tags` | 포스트에 태그 추가 (`{ tagId }`) |
| DELETE | `/posts/:id/tags/:tagId` | 포스트에서 태그 제거 |

### Tags (`/tags`)
| Method | Path | 설명 |
|--------|------|------|
| POST | `/tags` | 태그 생성 |
| GET | `/tags` | 전체 조회 |
| GET | `/tags/:id` | 단건 조회 |
| DELETE | `/tags/:id` | 삭제 |
| GET | `/tags/count` | 총 수 |
| POST | `/tags/upsert` | Upsert (name 기준) |
| GET | `/tags/paginated?page=1&limit=10` | 페이지네이션 |

### Categories (`/categories`)
| Method | Path | 설명 |
|--------|------|------|
| POST | `/categories` | 카테고리 생성 |
| GET | `/categories` | 전체 조회 |
| GET | `/categories/:id` | 단건 조회 |
| PATCH | `/categories/:id` | 수정 |
| DELETE | `/categories/:id` | 삭제 |
| GET | `/categories/count` | 총 수 |
| GET | `/categories/stats` | 카테고리별 포스트 수 (GROUP BY + HAVING) |

## 테스트

### E2E 통합 테스트 실행

실제 MySQL 데이터베이스 연결이 필요합니다. `INTEGRATION_TEST=true` 환경변수를 설정해야 합니다.

```bash
# ORM 빌드 (아직 안 했다면)
cd /path/to/stingerloom-orm
pnpm build

# 테스트 실행
cd examples/nestjs-blog
INTEGRATION_TEST=true pnpm test
```

`INTEGRATION_TEST` 환경변수가 없으면 모든 테스트가 skip됩니다.

### 테스트 커버리지 (59개 테스트)

| 영역 | 테스트 수 | 내용 |
|------|----------|------|
| App Root | 2 | 헬스체크, Schema Diff |
| Users CRUD | 8 | 생성, 조회, 수정, 삭제, count, 페이지네이션, 404 |
| Categories CRUD | 7 | 생성, 조회, 수정, 삭제, count, 404 |
| Tags CRUD | 8 | 생성, 조회, 삭제, count, 페이지네이션, upsert, 404 |
| Posts CRUD | 8 | 생성, 조회, 수정, 삭제, 페이지네이션, 커서, 404 |
| Soft Delete | 5 | soft-delete, 목록 필터링, withDeleted, restore |
| Upsert | 1 | slug 기준 upsert (중복 실행) |
| ManyToMany Tags | 5 | 태그 추가, 목록 조회, 태그 제거 |
| Stats / Explain / Schema | 4 | GROUP BY+HAVING, EXPLAIN, Schema Diff, Migration |
| Cleanup | 11 | 생성된 데이터 정리 (하드 삭제) |

### 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `DB_HOST` | `localhost` | 데이터베이스 호스트 |
| `DB_PORT` | `3306` | 데이터베이스 포트 |
| `DB_USER` | `root` | 데이터베이스 사용자 |
| `DB_PASSWORD` | `password` | 데이터베이스 비밀번호 |
| `DB_NAME` | `blog_db` | 데이터베이스 이름 |
| `PORT` | `3000` | 애플리케이션 포트 |
| `INTEGRATION_TEST` | — | `true`로 설정 시 e2e 테스트 활성화 |
