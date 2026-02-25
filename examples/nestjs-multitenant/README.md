# NestJS Multi-Tenant API — Stingerloom ORM Example

NestJS 기반 멀티테넌시 REST API 예제입니다. Stingerloom ORM의 **레이어드 메타데이터 시스템**과 **AsyncLocalStorage** 기반 자동 테넌트 컨텍스트를 시연합니다.

## 기능

- **자동 테넌트 컨텍스트** — `TenantMiddleware`가 `x-tenant-id` 헤더를 읽어 AsyncLocalStorage 컨텍스트를 자동 설정
- **TenantModule.forRoot()** — 미들웨어 적용 경로, 헤더명, 기본 테넌트 설정 가능
- **TenantContext** — Injectable 서비스로 현재 테넌트 정보 조회
- **@Tenant() 데코레이터** — 컨트롤러 파라미터에서 현재 테넌트 ID 추출
- **서비스 자동화** — `em.withTenant()` 수동 호출 없이 미들웨어가 컨텍스트 처리
- **CRUD** — Users, Posts (테넌트별 격리)
- **관계** — ManyToOne (Post→User, eager loading)

## 아키텍처

```
HTTP Request (x-tenant-id: tenant_a)
       ↓
  TenantMiddleware
       ↓  MetadataContext.run("tenant_a", () => next())
       ↓
  AsyncLocalStorage 컨텍스트 활성화
       ↓
  Controller (tenantId 파라미터 불필요)
       ↓
  Service (em.withTenant() 래핑 불필요)
       ↓
  EntityManager → MetadataLayerRegistry
       ↓  MetadataContext.getCurrentTenant() → "tenant_a"
       ↓
  테넌트 레이어 기반 메타데이터 조회
```

### TenantModule 설정

```typescript
// 특정 컨트롤러에만 적용
TenantModule.forRoot({
  headerName: "x-tenant-id",     // 기본값
  defaultTenant: "public",       // 기본값
  routes: [UsersController, PostsController],
})

// 모든 라우트에 적용
TenantModule.forRoot()

// 커스텀 헤더명
TenantModule.forRoot({ headerName: "x-org-id" })
```

### 서비스 코드 비교

**Before (수동)**
```typescript
async create(tenantId: string, dto: CreateUserDto) {
  return this.em.withTenant(tenantId, async (em) => {
    const user = new User();
    user.username = dto.username;
    const result = await em.save(User, user);
    return Array.isArray(result) ? result[0] : result;
  });
}
```

**After (자동)**
```typescript
async create(dto: CreateUserDto) {
  const user = new User();
  user.username = dto.username;
  const result = await this.em.save(User, user);
  return Array.isArray(result) ? result[0] : result;
}
```

## 사전 요구사항

- Node.js 18+
- pnpm
- PostgreSQL

## 설치 및 실행

```bash
# 1. ORM 빌드 (루트 디렉토리에서)
cd /path/to/stingerloom-orm
pnpm build

# 2. 의존성 설치
cd examples/nestjs-multitenant
pnpm install

# 3. 환경변수 설정 (.env 파일 수정)
#    DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME

# 4. 서버 실행
pnpm start        # 또는 pnpm start:dev (watch 모드)
```

서버가 시작되면 `http://localhost:3000` 에서 API에 접근할 수 있습니다.

## API 엔드포인트

### Tenant (`/tenant`)
| Method | Path | 설명 |
|--------|------|------|
| GET | `/tenant/current` | 현재 테넌트 정보 조회 (`{ tenant, isActive }`) |

### Users (`/users`)
| Method | Path | 설명 |
|--------|------|------|
| POST | `/users` | 사용자 생성 |
| GET | `/users` | 전체 조회 |
| GET | `/users/:id` | 단건 조회 |
| PATCH | `/users/:id` | 수정 |
| DELETE | `/users/:id` | 삭제 |

### Posts (`/posts`)
| Method | Path | 설명 |
|--------|------|------|
| POST | `/posts` | 포스트 생성 |
| GET | `/posts` | 전체 조회 |
| GET | `/posts/:id` | 단건 조회 |
| PATCH | `/posts/:id` | 수정 |
| DELETE | `/posts/:id` | 삭제 |

### 사용 예시

```bash
# tenant_a에 사용자 생성
curl -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: tenant_a" \
  -d '{"username": "alice", "email": "alice@example.com"}'

# tenant_b에 사용자 생성
curl -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: tenant_b" \
  -d '{"username": "bob", "email": "bob@example.com"}'

# tenant_a의 사용자만 조회
curl -H "x-tenant-id: tenant_a" http://localhost:3000/users

# 현재 테넌트 확인
curl -H "x-tenant-id: tenant_a" http://localhost:3000/tenant/current
# → { "tenant": "tenant_a", "isActive": true }

# 헤더 없이 요청 (public 테넌트)
curl http://localhost:3000/tenant/current
# → { "tenant": "public", "isActive": true }
```

## 테스트

### E2E 통합 테스트 실행

실제 PostgreSQL 데이터베이스 연결이 필요합니다. `INTEGRATION_TEST=true` 환경변수를 설정해야 합니다.

```bash
# ORM 빌드 (아직 안 했다면)
cd /path/to/stingerloom-orm
pnpm build

# 테스트 실행
cd examples/nestjs-multitenant
INTEGRATION_TEST=true pnpm test:e2e
```

`INTEGRATION_TEST` 환경변수가 없으면 모든 테스트가 skip됩니다.

### 테스트 커버리지 (26개 테스트)

| 영역 | 테스트 수 | 내용 |
|------|----------|------|
| Tenant Context | 3 | public/tenant_a/tenant_b 컨텍스트 검증 |
| Tenant A Users | 3 | 생성, 목록 조회, 단건 조회 |
| Tenant B Users | 2 | 생성, 목록 조회 |
| Public Tenant Users | 2 | 생성, 목록 조회 |
| Cross-Tenant Isolation | 3 | 테넌트 간 데이터 격리 검증 |
| Tenant A Posts | 4 | 생성, 목록 조회, 단건 조회, 수정 |
| User Update | 1 | tenant_a 사용자 수정 |
| Middleware Auto Context | 2 | withTenant() 없이 동작 확인, 기본 테넌트 |
| Error Handling | 2 | 404 응답 (Users, Posts) |
| Cleanup | 4 | 테스트 데이터 정리 |

### 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `DB_HOST` | `localhost` | 데이터베이스 호스트 |
| `DB_PORT` | `5432` | 데이터베이스 포트 |
| `DB_USER` | `postgres` | 데이터베이스 사용자 |
| `DB_PASSWORD` | `postgres` | 데이터베이스 비밀번호 |
| `DB_NAME` | `multi_tenancy_db` | 데이터베이스 이름 |
| `PORT` | `3000` | 애플리케이션 포트 |
| `INTEGRATION_TEST` | — | `true`로 설정 시 e2e 테스트 활성화 |
