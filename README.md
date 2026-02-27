# Stingerloom ORM

TypeScript 데코레이터 기반의 경량 ORM입니다. 엔티티 클래스를 정의하면 테이블 생성부터 CRUD, 관계 매핑, 트랜잭션까지 자동으로 처리됩니다.

```typescript
@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Column()
  email!: string;
}

const em = new EntityManager();
await em.register({ type: "postgres", /* ... */ entities: [User], synchronize: true });

const user = await em.save(User, { name: "홍길동", email: "hong@example.com" });
const users = await em.find(User, { where: { name: "홍길동" } });
```

## Features

- **4개 DB 지원** — PostgreSQL, MySQL/MariaDB, SQLite, MSSQL
- **데코레이터 기반** — `@Entity`, `@Column`, `@ManyToOne`, `@OneToMany`, `@ManyToMany`, `@OneToOne`
- **TypeScript First** — 제네릭 타입, `FindOption<T>`, `DeepPartial<T>`
- **관계 매핑** — Eager/Lazy 로딩, Cascade, 양방향 관계
- **트랜잭션** — `@Transactional()` 데코레이터, 격리 수준, Savepoint
- **마이그레이션** — MigrationRunner, CLI, Schema Diff 자동 생성
- **멀티테넌시** — 레이어드 메타데이터, PostgreSQL 스키마 격리
- **쿼리 빌더** — JOIN, GROUP BY, 서브쿼리, WHERE IN/BETWEEN
- **고급 기능** — EntitySubscriber, N+1 감지, 커서 페이지네이션, Upsert, Read Replica, 쿼리 타임아웃
- **NestJS 통합** — `@InjectRepository()`, `@InjectEntityManager()`, `StinglerloomOrmModule`

## 문서

**[docs/ 폴더](./docs/README.md)**에 한국어 문서가 준비되어 있습니다.

| 순서 | 문서 | 배우는 것 |
|------|------|----------|
| 1 | [시작하기](./docs/getting-started.md) | 설치, 첫 엔티티, 첫 CRUD |
| 2 | [엔티티 정의](./docs/entities.md) | 컬럼, 인덱스, Soft Delete, 생명주기 훅 |
| 3 | [관계 설정](./docs/relations.md) | ManyToOne, OneToMany, ManyToMany |
| 4 | [EntityManager](./docs/entity-manager.md) | find, save, delete, 집계, 페이지네이션 |

더 깊은 내용:

| 문서 | 언제 필요한가요? |
|------|----------------|
| [쿼리 빌더](./docs/query-builder.md) | JOIN, GROUP BY, 서브쿼리 등 복잡한 SQL |
| [트랜잭션](./docs/transactions.md) | 여러 작업을 하나의 단위로 묶어야 할 때 |
| [마이그레이션](./docs/migrations.md) | 프로덕션 스키마 변경 관리 |
| [설정 가이드](./docs/configuration.md) | 풀링, 타임아웃, Read Replica |
| [고급 기능](./docs/advanced.md) | 이벤트 구독, N+1 감지, 성능 최적화 |
| [멀티테넌시](./docs/multi-tenancy.md) | 테넌트별 데이터 격리 |
| [API 레퍼런스](./docs/api-reference.md) | 메서드 시그니처 빠르게 확인 |

## Quick Start

```bash
pnpm add stingerloom-orm reflect-metadata
```

```typescript
import "reflect-metadata";
import { EntityManager } from "stingerloom-orm";

const em = new EntityManager();
await em.register({
  type: "postgres",
  host: "localhost",
  port: 5432,
  username: "postgres",
  password: "password",
  database: "mydb",
  entities: [User],
  synchronize: true,
});

// Create
const user = await em.save(User, { name: "홍길동", email: "hong@example.com" });

// Read
const found = await em.findOne(User, { where: { id: 1 } });

// Update
await em.save(User, { id: 1, name: "수정됨" });

// Delete
await em.delete(User, { id: 1 });
```

> 자세한 내용은 [시작하기 문서](./docs/getting-started.md)를 참고하세요.

## Examples

| 예제 | 설명 |
|------|------|
| [nestjs-cats](./examples/nestjs-cats/) | NestJS 기본 CRUD, EntitySubscriber, 커서 페이지네이션 |
| [nestjs-blog](./examples/nestjs-blog/) | ManyToMany, Soft Delete, Upsert, 59개 e2e 테스트 |
| [nestjs-multitenant](./examples/nestjs-multitenant/) | PostgreSQL 스키마 기반 멀티테넌시 |

## Supported Databases

| DB | Status |
|----|--------|
| PostgreSQL | Full support (schema isolation, ENUM, RETURNING) |
| MySQL / MariaDB | Full support |
| SQLite | Supported (file-based, no pooling) |
| MSSQL | Supported |

## Development

```bash
pnpm install
pnpm build        # dist/ 생성
pnpm test         # 1,405 tests
```

## License

MIT
