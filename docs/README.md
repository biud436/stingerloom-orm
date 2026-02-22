# Stingerloom ORM 문서

TypeScript 기반의 경량 ORM으로, MySQL, PostgreSQL, SQLite, MSSQL을 지원하며 Docker OverlayFS 방식의 레이어드 메타데이터 시스템을 통해 멀티테넌시를 구현합니다.

---

## 주요 기능

- **다중 DB 지원** — MySQL / MariaDB / PostgreSQL / SQLite / MSSQL
- **데코레이터 기반 엔티티 정의** — `@Entity`, `@Column`, `@PrimaryGeneratedColumn` 등
- **관계 매핑** — `@ManyToOne`, `@OneToMany`, `@OneToOne`, `@ManyToMany`
- **Eager / Lazy 로딩** — 자동 LEFT JOIN 또는 Proxy 기반 지연 로딩
- **Cascade** — insert / update / delete 자동 전파
- **Soft Delete** — `@DeletedAt`, `softDelete()`, `restore()`
- **트랜잭션** — `@Transactional()` 데코레이터, 격리 수준, Savepoint
- **마이그레이션** — `Migration` 추상 클래스, `MigrationRunner`, CLI
- **쿼리 빌더 DSL** — `RawQueryBuilder` (select / join / where / orderBy / limit 등)
- **집계 쿼리** — `count`, `sum`, `avg`, `min`, `max`
- **배치 연산** — `insertMany`, `saveMany`, `deleteMany`
- **쿼리 캐싱** — TTL 기반 인메모리 캐시
- **이벤트 시스템** — `on/off(event, handler)`, `EntitySubscriber`
- **N+1 감지** — `logging.nPlusOne` 옵션
- **커서 페이지네이션** — `findWithCursor`, Base64 커서
- **연결 풀링** — `PoolOptions` (max / min / acquireTimeoutMs / idleTimeoutMs)
- **멀티테넌시** — `LayeredMetadataStore`, `withTenant(tenantId, callback)`
- **유효성 검사** — `@NotNull`, `@MinLength`, `@MaxLength`, `@Min`, `@Max`

---

## 설치

```bash
# pnpm
pnpm add stingerloom-orm reflect-metadata

# npm
npm install stingerloom-orm reflect-metadata

# yarn
yarn add stingerloom-orm reflect-metadata
```

`reflect-metadata`를 앱 진입점 최상단에서 반드시 임포트해야 합니다.

```typescript
import "reflect-metadata";
```

---

## 문서 목차

| 파일 | 내용 |
|------|------|
| [getting-started.md](./getting-started.md) | 설치, tsconfig 설정, 최소 동작 예제 |
| [entities.md](./entities.md) | 엔티티 데코레이터 전체 (`@Entity`, `@Column`, 훅, 유효성 검사 등) |
| [relations.md](./relations.md) | 관계 데코레이터 (`@ManyToOne`, `@OneToMany`, `@OneToOne`, `@ManyToMany`) |
| [entity-manager.md](./entity-manager.md) | EntityManager API 전체 (`find`, `save`, `delete`, 집계 등) |
| [query-builder.md](./query-builder.md) | RawQueryBuilder DSL (where / join / orderBy / limit 등) |
| [transactions.md](./transactions.md) | 트랜잭션 관리 (`@Transactional`, 격리 수준, Savepoint) |
| [migrations.md](./migrations.md) | 마이그레이션 시스템 (Migration, MigrationRunner, CLI) |
| [advanced.md](./advanced.md) | 고급 기능 (캐싱, 이벤트, Subscriber, N+1 감지, 커서 페이지네이션 등) |
| [multi-tenancy.md](./multi-tenancy.md) | 멀티테넌시 (LayeredMetadataStore, withTenant) |

---

## 지원 데이터베이스

| DB | 식별자 래핑 | PK 생성 | 스키마 지원 |
|----|------------|---------|------------|
| MySQL | 백틱 (\`) | AUTO_INCREMENT | 미지원 |
| MariaDB | 백틱 (\`) | AUTO_INCREMENT | 미지원 |
| PostgreSQL | 큰따옴표 (") | SERIAL / RETURNING | 지원 |
| SQLite | 큰따옴표 (") | AUTOINCREMENT | 미지원 |
| MSSQL | 대괄호 ([]) | IDENTITY | 미지원 |
